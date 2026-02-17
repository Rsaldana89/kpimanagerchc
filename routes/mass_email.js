const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const isAuth = require('../middleware/isAuth');
const { requireRole } = require('../middleware/roles');
const { startBatch, cancelBatch, isRunning: isBatchRunning, getSendDelayMs } = require('../services/batchEmailRunner');

function getStuckMinutes() {
  const env = process.env.EMAIL_BATCH_STUCK_MINUTES;
  const n = Number(env);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(1440, Math.max(5, Math.trunc(n)));
}

// =========================================================
// Utilidades
// =========================================================

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  return Math.min(max, Math.max(min, i));
}

function defaultPrevMonth() {
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth(); // 0..11. Por diseño aquí equivale al "mes anterior" en 1..12 excepto Enero.
  if (month === 0) {
    month = 12;
    year -= 1;
  }
  return { year, month };
}

function parsePeriodFromQuery(q) {
  const def = defaultPrevMonth();
  const year = clampInt(q.anio, 2000, 2100, def.year);
  const month = clampInt(q.mes, 1, 12, def.month);
  return { year, month };
}

function normalizeRun(r) {
  if (!r) return null;
  const hasIsRunning = Object.prototype.hasOwnProperty.call(r, 'is_running');
  const isRunning = hasIsRunning ? (r.is_running === 1 || r.is_running === true) : !r.finished_at;
  return {
    ...r,
    is_running: isRunning ? 1 : 0
  };
}

// =========================================================
// Configuración
// =========================================================

async function getBatchConfig() {
  // Defaults desde env (compatibilidad)
  const cfg = {
    enabled: String(process.env.EMAIL_BATCH_ENABLED || '').toLowerCase() === 'true',
    start_day: clampInt(process.env.EMAIL_BATCH_START_DAY || 11, 1, 31, 11),
    send_time: process.env.EMAIL_BATCH_TIME || '20:00',
    batch_limit: clampInt(process.env.EMAIL_BATCH_LIMIT || 150, 1, 999, 150),
    resend_sent: String(process.env.EMAIL_BATCH_RESEND_SENT || '').toLowerCase() === 'true'
  };

  try {
    const [rows] = await pool.execute('SELECT * FROM kpi_batch_config ORDER BY id DESC LIMIT 1');
    if (rows && rows.length) {
      const r = rows[0];
      cfg.enabled = (r.enabled === 1 || r.enabled === true);
      cfg.start_day = clampInt(r.start_day ?? cfg.start_day, 1, 31, cfg.start_day);
      cfg.send_time = r.send_time || cfg.send_time;
      cfg.batch_limit = clampInt(r.batch_limit ?? cfg.batch_limit, 1, 999, cfg.batch_limit);
      cfg.resend_sent = (r.resend_sent === 1 || r.resend_sent === true);
    }
  } catch (e) {
    // Si la tabla no existe en ese entorno, usamos defaults.
  }

  if (!cfg.send_time || !/^\d{1,2}:\d{2}$/.test(cfg.send_time)) cfg.send_time = '20:00';
  return cfg;
}

async function saveBatchConfig({ enabled, start_day, send_time, batch_limit, resend_sent }) {
  const day = clampInt(start_day || 11, 1, 31, 11);
  const limit = clampInt(batch_limit || 150, 1, 999, 150);
  const time = (String(send_time || '').match(/^\d{1,2}:\d{2}$/)) ? String(send_time) : '20:00';
  const en = enabled ? 1 : 0;
  const resend = resend_sent ? 1 : 0;

  // Sin migraciones: asumimos que la tabla existe.
  await pool.execute(
    `INSERT INTO kpi_batch_config (id, enabled, start_day, send_time, batch_limit, resend_sent)
     VALUES (1, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       enabled = VALUES(enabled),
       start_day = VALUES(start_day),
       send_time = VALUES(send_time),
       batch_limit = VALUES(batch_limit),
       resend_sent = VALUES(resend_sent)`,
    [en, day, time, limit, resend]
  );

  return { enabled: !!en, start_day: day, send_time: time, batch_limit: limit, resend_sent: !!resend };
}

// =========================================================
// Data (estado de KPIs + estado de envío)
// =========================================================

async function fetchEmployeesStatus({ year, month }) {
  // 1) KPIs asignados por puesto
  const [kpiCountsRows] = await pool.execute(
    'SELECT puesto_id, COUNT(*) AS total FROM puesto_kpis GROUP BY puesto_id'
  );
  const kpiCountMap = new Map();
  (kpiCountsRows || []).forEach(r => kpiCountMap.set(Number(r.puesto_id), Number(r.total)));

  // 2) Empleados (incluye sucursales) + correo + departamento + sucursal
  let employees = [];
  try {
    const [empRows] = await pool.execute(
      `SELECT e.id, e.incidencia_id, e.nombre, e.correo,
              e.puesto_id, e.departamento_id, e.sucursal_id,
              d.nombre AS departamento_nombre,
              s.nombre AS sucursal_nombre
       FROM empleados e
       LEFT JOIN departamentos d ON e.departamento_id = d.id
       LEFT JOIN sucursales s ON e.sucursal_id = s.id
       WHERE (d.nombre IS NULL OR d.nombre <> 'BAJA')
       ORDER BY e.nombre`
    );
    employees = empRows || [];
  } catch (e) {
    // Si no existe la tabla sucursales, degradar sin esa unión.
    const [empRows] = await pool.execute(
      `SELECT e.id, e.incidencia_id, e.nombre, e.correo,
              e.puesto_id, e.departamento_id, e.sucursal_id,
              d.nombre AS departamento_nombre
       FROM empleados e
       LEFT JOIN departamentos d ON e.departamento_id = d.id
       WHERE (d.nombre IS NULL OR d.nombre <> 'BAJA')
       ORDER BY e.nombre`
    );
    employees = empRows || [];
  }

  if (!employees.length) {
    return {
      employees: [],
      departments: [],
      stats: {
        total_employees: 0,
        completed: 0,
        percent_completed: 0,
        with_email: 0,
        without_email: 0,
        email_sent: 0,
        email_pending: 0,
        percent_email_sent: 0
      }
    };
  }

  const empIds = employees.map(e => e.id);
  const empPlace = empIds.map(() => '?').join(',');

  // 3) Resultados KPI para periodo
  const [resRows] = await pool.execute(
    `SELECT empleado_id, kpi_id
     FROM kpi_resultados
     WHERE empleado_id IN (${empPlace}) AND anio = ? AND mes = ?`,
    [...empIds, year, month]
  );
  const resCountMap = new Map();
  (resRows || []).forEach(r => {
    const prev = resCountMap.get(r.empleado_id) || 0;
    resCountMap.set(r.empleado_id, prev + 1);
  });

  // 4) Correos enviados en periodo (preferimos traer la fecha si existe)
  const sentMap = new Map(); // empleado_id -> enviado_el (Date|string|true)
  try {
    const [sentRows] = await pool.execute(
      'SELECT empleado_id, enviado_el FROM kpi_emails_sent WHERE anio = ? AND mes = ?',
      [year, month]
    );
    (sentRows || []).forEach(r => sentMap.set(Number(r.empleado_id), r.enviado_el || true));
  } catch (e) {
    try {
      const [sentRows] = await pool.execute(
        'SELECT empleado_id FROM kpi_emails_sent WHERE anio = ? AND mes = ?',
        [year, month]
      );
      (sentRows || []).forEach(r => sentMap.set(Number(r.empleado_id), true));
    } catch (e2) {
      // si la tabla no existe, dejamos el mapa vacío
    }
  }

  // 5) Lista enriquecida
  const empList = employees.map(e => {
    const total = kpiCountMap.get(Number(e.puesto_id)) || 0;
    const filled = resCountMap.get(Number(e.id)) || 0;
    const completed = total > 0 ? (filled >= total) : false;
    const correo = (e.correo || '').trim();
    const hasEmail = !!correo;
    const sentInfo = sentMap.get(Number(e.id));
    const emailSent = hasEmail && sentMap.has(Number(e.id));

    return {
      id: e.id,
      incidencia_id: e.incidencia_id,
      nombre: e.nombre,
      correo,
      has_email: hasEmail,
      departamento_id: e.departamento_id,
      departamento_nombre: e.departamento_nombre || 'Sin departamento',
      sucursal_id: e.sucursal_id,
      sucursal_nombre: e.sucursal_nombre || '',
      total_kpis: total,
      filled_kpis: filled,
      completed,
      email_sent: emailSent,
      email_sent_at: (sentInfo && sentInfo !== true) ? sentInfo : null
    };
  });

  // 6) Resumen por departamento
  const depMap = new Map();
  for (const emp of empList) {
    const depId = emp.departamento_id || 0;
    if (!depMap.has(depId)) {
      depMap.set(depId, {
        id: depId,
        nombre: emp.departamento_nombre || 'Sin departamento',
        total: 0,
        completed: 0,
        with_email: 0,
        without_email: 0,
        email_sent: 0,
        email_pending: 0
      });
    }
    const d = depMap.get(depId);
    d.total += 1;
    if (emp.completed) d.completed += 1;
    if (emp.has_email) d.with_email += 1;
    else d.without_email += 1;
    if (emp.email_sent) d.email_sent += 1;
  }
  const departments = Array.from(depMap.values()).map(d => {
    d.email_pending = Math.max(0, d.with_email - d.email_sent);
    const percent = d.total ? Math.round((d.completed / d.total) * 100) : 0;
    const percentEmail = d.with_email ? Math.round((d.email_sent / d.with_email) * 100) : 0;
    return { ...d, percent, percent_email_sent: percentEmail };
  }).sort((a, b) => a.nombre.localeCompare(b.nombre));

  // 7) Stats globales
  const totalEmployees = empList.length;
  const completed = empList.filter(e => e.completed).length;
  const withEmail = empList.filter(e => e.has_email).length;
  const withoutEmail = totalEmployees - withEmail;
  const emailSent = empList.filter(e => e.email_sent).length;
  const emailPending = Math.max(0, withEmail - emailSent);

  const stats = {
    total_employees: totalEmployees,
    completed,
    percent_completed: totalEmployees ? Math.round((completed / totalEmployees) * 100) : 0,
    with_email: withEmail,
    without_email: withoutEmail,
    email_sent: emailSent,
    email_pending: emailPending,
    percent_email_sent: withEmail ? Math.round((emailSent / withEmail) * 100) : 0
  };

  return { employees: empList, departments, stats };
}

// =========================================================
// Rutas
// =========================================================

router.get('/admin/mass-email', isAuth, requireRole(['admin']), async (req, res) => {
  try {
    const { year, month } = parsePeriodFromQuery(req.query);
    const config = await getBatchConfig();
    const delayMs = getSendDelayMs();

    // Progreso/Historial
    let recentRuns = [];
    let currentRun = null;
    try {
      const [rr] = await pool.execute(
        'SELECT * FROM kpi_batch_runs ORDER BY started_at DESC LIMIT 10'
      );
      recentRuns = (rr || []).map(normalizeRun);
      currentRun = recentRuns.find(r => r.is_running) || null;
    } catch (e) {
      // tabla no existe en ese entorno
    }

    const stuckThresholdMin = getStuckMinutes();
    let isStuck = false;
    let stuckForMin = 0;
    if (currentRun && currentRun.started_at) {
      const t = new Date(currentRun.started_at).getTime();
      if (Number.isFinite(t)) {
        stuckForMin = Math.max(0, Math.floor((Date.now() - t) / 60000));
        if (stuckForMin >= stuckThresholdMin) isStuck = true;
      }
    }
    // Si DB dice que hay uno corriendo pero este proceso NO lo está ejecutando,
    // lo tratamos como posible "trabado" para que el admin pueda cancelarlo.
    const isSendingNow = isBatchRunning();
    if (currentRun && !isSendingNow) isStuck = true;

    const { employees, departments, stats } = await fetchEmployeesStatus({ year, month });

    // Compatibilidad con la vista (nombres esperados)
    const selectedYear = year;
    const selectedMonth = month;
    const departmentsSummary = (departments || []).map(d => ({
      id: d.id,
      nombre: d.nombre,
      total: d.total,
      withEmail: d.with_email,
      withoutEmail: d.without_email,
      emailed: d.email_sent,
      pendingEmail: d.email_pending,
      percent: d.percent,
      emailPercent: d.percent_email_sent
    }));

    res.render('admin_mass_email', {
      title: 'Envío masivo de KPIs',
      user: req.session.user,
      config,
      year,
      month,
      selectedYear,
      selectedMonth,
      employees,
      departments,
      departmentsSummary,
      stats,
      recentRuns,
      currentRun,
      delayMs,
      isSendingNow,
      isStuck,
      stuckForMin,
      stuckThresholdMin,
      messages: req.flash('info'),
      errors: req.flash('error')
    });
  } catch (err) {
    console.error('[MassEmail] Error al cargar pantalla:', err);
    req.flash('error', 'No se pudo cargar la pantalla de envío masivo. Revisa los logs.');
    res.redirect('/admin');
  }
});

router.post('/admin/mass-email/config', isAuth, requireRole(['admin']), async (req, res) => {
  try {
    const enabled = req.body.enabled === '1' || req.body.enabled === 'on';
    const resend_sent = req.body.resend_sent === '1' || req.body.resend_sent === 'on';
    const start_day = req.body.start_day;
    const send_time = req.body.send_time;
    const batch_limit = req.body.batch_limit;

    await saveBatchConfig({ enabled, start_day, send_time, batch_limit, resend_sent });
    req.flash('info', 'Configuración guardada correctamente.');
  } catch (err) {
    console.error('[MassEmail] Error guardando configuración:', err);
    req.flash('error', 'No se pudo guardar la configuración.');
  }
  res.redirect('/admin/mass-email');
});

// Cancelar ejecución en curso (o estado trabado en DB)
router.post('/admin/mass-email/cancel', isAuth, requireRole(['admin']), async (req, res) => {
  try {
    const reason = req.body.reason || 'Cancelado por el administrador';
    await cancelBatch(reason);
    req.flash('info', 'Envío cancelado. Ya puedes iniciar uno nuevo.');
  } catch (err) {
    console.error('[MassEmail] Error al cancelar envío:', err);
    req.flash('error', 'No se pudo cancelar el envío. Revisa los logs.');
  }
  return res.redirect('/admin/mass-email');
});

router.post('/admin/mass-email/send', isAuth, requireRole(['admin']), async (req, res) => {
  try {
    const year = clampInt(req.body.year, 2000, 2100, defaultPrevMonth().year);
    const month = clampInt(req.body.month, 1, 12, defaultPrevMonth().month);

    const rawMode = String(req.body.sendMode || '').toLowerCase().trim();
    const fallbackMode = (req.body.includeSent ? 'all' : 'pending');
    const sendMode = (rawMode === 'pending' || rawMode === 'resend' || rawMode === 'all') ? rawMode : fallbackMode;
    const force = sendMode !== 'pending';
    const delayMs = getSendDelayMs();

    // Evitar iniciar otro lote si ya hay uno en curso.
    if (isBatchRunning()) {
      req.flash('error', 'Ya hay un envío en curso. Espera a que termine para iniciar otro.');
      return res.redirect(`/admin/mass-email?anio=${year}&mes=${month}`);
    }

    const departmentIds = Array.isArray(req.body.departmentIds)
      ? req.body.departmentIds.map(v => Number(v)).filter(n => Number.isFinite(n))
      : [];
    const employeeIdsFromForm = Array.isArray(req.body.employeeIds)
      ? req.body.employeeIds.map(v => Number(v)).filter(n => Number.isFinite(n))
      : [];

    const sendAll = (req.body.sendAll === '1' || req.body.sendAll === 'true');

    // -------------------------------------------------
    // Resolver destinatarios (SIEMPRE con correo válido)
    // -------------------------------------------------
    let employeeIds = [];

    // Helper para subquery de enviados
    const subquerySent = 'SELECT empleado_id FROM kpi_emails_sent WHERE anio = ? AND mes = ?';

    if (sendAll || departmentIds.length > 0) {
      const params = [];
      let query =
        `SELECT e.id
         FROM empleados e
         LEFT JOIN departamentos d ON e.departamento_id = d.id
         WHERE (d.nombre IS NULL OR d.nombre <> 'BAJA')
           AND e.correo IS NOT NULL AND e.correo <> ''`;

      if (departmentIds.length) {
        query += ` AND e.departamento_id IN (${departmentIds.map(() => '?').join(',')})`;
        params.push(...departmentIds);
      }

      if (sendMode === 'pending') {
        query += ` AND e.id NOT IN (${subquerySent})`;
        params.push(year, month);
      } else if (sendMode === 'resend') {
        query += ` AND e.id IN (${subquerySent})`;
        params.push(year, month);
      }

      query += ' ORDER BY e.id';

      const [rows] = await pool.execute(query, params);
      employeeIds = (rows || []).map(r => Number(r.id)).filter(n => Number.isFinite(n));
    } else if (employeeIdsFromForm.length) {
      // Validar correos
      const params = [...employeeIdsFromForm];
      let query =
        `SELECT e.id
         FROM empleados e
         LEFT JOIN departamentos d ON e.departamento_id = d.id
         WHERE e.id IN (${employeeIdsFromForm.map(() => '?').join(',')})
           AND (d.nombre IS NULL OR d.nombre <> 'BAJA')
           AND e.correo IS NOT NULL AND e.correo <> ''`;

      if (sendMode === 'pending') {
        query += ` AND e.id NOT IN (${subquerySent})`;
        params.push(year, month);
      } else if (sendMode === 'resend') {
        query += ` AND e.id IN (${subquerySent})`;
        params.push(year, month);
      }

      const [rows] = await pool.execute(query, params);
      employeeIds = (rows || []).map(r => Number(r.id)).filter(n => Number.isFinite(n));
    } else {
      req.flash('error', 'No se seleccionó ningún destinatario.');
      return res.redirect(`/admin/mass-email?anio=${year}&mes=${month}`);
    }

    // De-dup
    employeeIds = Array.from(new Set(employeeIds));

    if (!employeeIds.length) {
      const msg = (sendMode === 'pending')
        ? 'No hay correos pendientes para el periodo seleccionado (o los destinatarios no tienen correo).'
        : (sendMode === 'resend')
          ? 'No hay correos enviados previamente para reenviar en este periodo.'
          : 'No se encontraron destinatarios con correo válido.';
      req.flash('error', msg);
      return res.redirect(`/admin/mass-email?anio=${year}&mes=${month}`);
    }

    const kindLabel = (sendMode === 'pending')
      ? 'Pendientes'
      : (sendMode === 'resend')
        ? 'Reenvío'
        : 'Todos (incluye reenvíos)';

    const message = `Manual: ${kindLabel}. Delay=${Math.round(delayMs)}ms. Destinatarios=${employeeIds.length}.`;

    await startBatch({
      year,
      month,
      mode: 'manual',
      employeeIds,
      force,
      delayMs,
      message,
      // Enviar archivos en formato PDF para envíos masivos
      attachmentFormat: 'pdf'
    });

    req.flash('info', `Envío iniciado (${kindLabel}). Destinatarios: ${employeeIds.length}.`);
    return res.redirect(`/admin/mass-email?anio=${year}&mes=${month}`);
  } catch (err) {
    if (err && err.code === 'BATCH_ALREADY_RUNNING') {
      req.flash('error', 'Ya hay un envío en curso. Espera a que termine para iniciar otro.');
      return res.redirect('/admin/mass-email');
    }
    console.error('[MassEmail] Error iniciando envío:', err);
    req.flash('error', 'No se pudo iniciar el envío. Revisa los logs.');
    return res.redirect('/admin/mass-email');
  }
});

router.get('/admin/mass-email/progress', isAuth, requireRole(['admin']), async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM kpi_batch_runs ORDER BY started_at DESC LIMIT 1');
    const run = rows && rows.length ? normalizeRun(rows[0]) : null;

    const total = run && run.total_targets ? Number(run.total_targets) : 0;
    const sent = run && run.sent_count ? Number(run.sent_count) : 0;
    const skipped = run && run.skipped_count ? Number(run.skipped_count) : 0;
    const errors = run && run.error_count ? Number(run.error_count) : 0;
    const processed = sent + skipped + errors;
    const percent = total ? Math.round((processed / total) * 100) : 0;

    res.json({
      run,
      percent,
      processed,
      total
    });
  } catch (e) {
    res.json({ run: null, percent: 0, processed: 0, total: 0 });
  }
});

module.exports = router;
