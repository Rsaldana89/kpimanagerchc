const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const isAuth = require('../middleware/isAuth');
const { requireRole } = require('../middleware/roles');
const { sendIndividualKpiResults } = require('../services/kpiEmail');
const dashboardRoutes = require('./dashboard');

/*
 * Ruta de administración para gestionar el envío masivo de KPIs.  Esta
 * página sólo está disponible para usuarios con rol "admin".  Permite
 * configurar los parámetros del programador automático (día, hora,
 * límite de envío, permitir reenvío) y realizar envíos manuales de
 * resultados de KPIs por periodo.  Desde aquí se pueden enviar
 * resultados a todos los empleados (excepto aquellos asociados a
 * sucursales) o filtrar por departamentos o incluso enviar
 * individualmente.  También se muestra un resumen del porcentaje de
 * empleados que han completado sus KPIs en el periodo seleccionado.
 */

// Obtiene la configuración actual del envío masivo.  Devuelve un
// objeto con los campos start_day, send_time, batch_limit y
// resend_flag.  Si no hay configuración en la base de datos, se
// construye a partir de las variables de entorno para mantener
// compatibilidad con versiones antiguas.
// Asegura que la tabla de configuración existe y contiene las columnas esperadas.
// Si la tabla no existe, la crea.  Si faltan columnas (por ejemplo, 'enabled' o
// 'resend_sent'), las agrega con valores por defecto.  Esto evita errores
// "Unknown column" al insertar o seleccionar.
async function ensureBatchConfigTable() {
  // Crear la tabla si no existe.  Usamos IF NOT EXISTS para que no rompa
  // instaladas previas.
  await pool.execute(`CREATE TABLE IF NOT EXISTS kpi_batch_config (
    id INT AUTO_INCREMENT PRIMARY KEY,
    enabled TINYINT(1) DEFAULT 0,
    start_day INT NOT NULL DEFAULT 11,
    send_time VARCHAR(5) NOT NULL DEFAULT '20:00',
    batch_limit INT NOT NULL DEFAULT 150,
    resend_sent TINYINT(1) NOT NULL DEFAULT 0
  )`);
  // Verificar columnas y agregarlas si faltan.  MySQL soporta IF NOT EXISTS
  // para ADD COLUMN a partir de v8; para compatibilidad usamos una consulta
  // simple y alteramos según sea necesario.
  const [cols] = await pool.execute(`SHOW COLUMNS FROM kpi_batch_config`);
  const colNames = cols.map(c => c.Field);
  const alters = [];
  if (!colNames.includes('enabled')) {
    alters.push('ADD COLUMN enabled TINYINT(1) DEFAULT 0');
  }
  if (!colNames.includes('resend_sent')) {
    // Si la columna antigua era resend_flag, migrarla al nuevo nombre.
    if (colNames.includes('resend_flag')) {
      alters.push('CHANGE COLUMN resend_flag resend_sent TINYINT(1)');
    } else {
      alters.push('ADD COLUMN resend_sent TINYINT(1) DEFAULT 0');
    }
  }
  if (alters.length) {
    const alterStmt = `ALTER TABLE kpi_batch_config ${alters.join(', ')}`;
    await pool.execute(alterStmt);
  }
}

async function getBatchConfig() {
  // Asegurarse de que la tabla/columnas están listas
  await ensureBatchConfigTable();
  const [rows] = await pool.execute(
    'SELECT * FROM kpi_batch_config ORDER BY id DESC LIMIT 1'
  );
  if (rows.length) {
    const cfg = rows[0];
    return {
      enabled: (cfg.enabled === 1 || cfg.enabled === true),
      start_day: cfg.start_day,
      send_time: cfg.send_time,
      batch_limit: cfg.batch_limit,
      resend_sent: (cfg.resend_sent === 1 || cfg.resend_sent === true)
    };
  }
  // Fallback: usar variables de entorno
  const limit = parseInt(process.env.EMAIL_BATCH_LIMIT || '150', 10);
  const day = parseInt(process.env.EMAIL_BATCH_START_DAY || '11', 10);
  const timeStr = process.env.EMAIL_BATCH_TIME || '20:00';
  const resend = String(process.env.EMAIL_BATCH_RESEND_SENT || '').toLowerCase() === 'true';
  const enabled = String(process.env.EMAIL_BATCH_ENABLED || '').toLowerCase() === 'true';
  return {
    enabled,
    start_day: day,
    send_time: timeStr,
    batch_limit: limit,
    resend_sent: resend
  };
}

// Guarda (inserta o actualiza) la configuración del envío masivo.
// Si no existe ningún registro, crea uno; de lo contrario actualiza
// el último.  Devuelve la configuración guardada.
async function saveBatchConfig({ enabled, start_day, send_time, batch_limit, resend_sent }) {
  // Asegurar que la tabla existe y está migrada
  await ensureBatchConfigTable();
  // Normalizar valores
  const day = Math.min(Math.max(parseInt(start_day || 11, 10), 1), 31);
  const limit = Math.max(parseInt(batch_limit || 150, 10), 1);
  const time = (String(send_time || '').match(/^\d{1,2}:\d{2}$/)) ? send_time : '20:00';
  const en = enabled ? 1 : 0;
  const resend = resend_sent ? 1 : 0;
  // Insertar o actualizar la fila con id=1.  Asegurarse de que las columnas existen.
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

// Calcula los KPIs completados por empleado para un periodo.  Un
// empleado se considera "completo" si ha capturado resultados para
// todos los KPIs asignados a su puesto en el año/mes dados.  Devuelve
// una lista de empleados con sus datos básicos, el nombre de su
// departamento y un indicador de completado.  Excluye los empleados
// con sucursal asignada (sucursal_id no nulo) y los empleados cuyo
// departamento sea BAJA.  También devuelve un resumen por
// departamento con recuentos de empleados y completados.
async function fetchEmployeesCompletion({ year, month }) {
  // Obtener todos los empleados sin sucursal y sin departamento BAJA
  const [employees] = await pool.execute(
    `SELECT e.id, e.incidencia_id, e.nombre,
            e.puesto_id, e.departamento_id,
            d.nombre AS departamento_nombre
     FROM empleados e
     LEFT JOIN departamentos d ON e.departamento_id = d.id
     WHERE e.sucursal_id IS NULL
       AND (d.nombre IS NULL OR d.nombre <> 'BAJA')
     ORDER BY e.nombre`
  );
  if (!employees.length) {
    return { employees: [], departments: [] };
  }
  const empIds = employees.map(e => e.id);
  const empPlace = empIds.map(() => '?').join(',');
  // Contar KPIs asignados por puesto
  const puestoIds = [...new Set(employees.map(e => e.puesto_id))];
  const puestoPlace = puestoIds.map(() => '?').join(',');
  const [kpiCounts] = await pool.execute(
    `SELECT pk.puesto_id, COUNT(pk.kpi_id) AS total
     FROM puesto_kpis pk
     WHERE pk.puesto_id IN (${puestoPlace})
     GROUP BY pk.puesto_id`,
    puestoIds
  );
  const kpiCountMap = new Map();
  kpiCounts.forEach(r => kpiCountMap.set(r.puesto_id, Number(r.total)));
  // Obtener resultados de KPI para el periodo
  const [resRows] = await pool.execute(
    `SELECT empleado_id, kpi_id
     FROM kpi_resultados
     WHERE empleado_id IN (${empPlace}) AND anio = ? AND mes = ?`,
    [...empIds, year, month]
  );
  // Contar resultados por empleado
  const resCountMap = new Map();
  resRows.forEach(r => {
    const cnt = resCountMap.get(r.empleado_id) || 0;
    resCountMap.set(r.empleado_id, cnt + 1);
  });
  // Construir lista de empleados con indicador completado
  const empList = employees.map(e => {
    const total = kpiCountMap.get(e.puesto_id) || 0;
    const filled = resCountMap.get(e.id) || 0;
    const completed = (total > 0) ? (filled >= total) : false;
    return {
      id: e.id,
      incidencia_id: e.incidencia_id,
      nombre: e.nombre,
      departamento_id: e.departamento_id,
      departamento_nombre: e.departamento_nombre,
      completed
    };
  });
  // Resumen por departamento
  const depMap = new Map();
  empList.forEach(emp => {
    const depId = emp.departamento_id || 0;
    const key = depId;
    let obj = depMap.get(key);
    if (!obj) {
      obj = {
        id: depId,
        nombre: emp.departamento_nombre || 'Sin departamento',
        total: 0,
        completed: 0
      };
      depMap.set(key, obj);
    }
    obj.total += 1;
    if (emp.completed) obj.completed += 1;
  });
  const departments = Array.from(depMap.values()).map(d => {
    const percent = d.total ? Math.round((d.completed / d.total) * 100) : 0;
    return { ...d, percent };
  }).sort((a, b) => a.nombre.localeCompare(b.nombre));
  return { employees: empList, departments };
}

// Página principal de envío masivo.  Muestra la configuración actual,
// permite modificarla y muestra el resumen y las acciones de envío.
router.get('/admin/mass-email', isAuth, requireRole(['admin']), async (req, res) => {
  try {
    // Periodo por defecto para envío masivo: SIEMPRE mes anterior
    const now = new Date();
    let defYear = now.getFullYear();
    let defMonth = now.getMonth(); // 0-index del mes anterior
    if (defMonth === 0) { defMonth = 12; defYear -= 1; }
    const def = { year: defYear, month: defMonth };
    let year = parseInt(req.query.anio, 10);
    let month = parseInt(req.query.mes, 10);
    if (!year || isNaN(year)) year = def.year;
    if (!month || isNaN(month) || month < 1 || month > 12) month = def.month;
    const config = await getBatchConfig();
    // Últimas ejecuciones para mostrar progreso
    let recentRuns = [];
    let currentRun = null;
    try {
      const [rr] = await pool.execute(
        `SELECT id, period_year, period_month, started_at, finished_at, mode,
                total_targets, sent_count, skipped_count, error_count, is_running, last_message
         FROM kpi_batch_runs
         ORDER BY started_at DESC
         LIMIT 10`
      );
      recentRuns = rr;
      currentRun = rr.find(r => r.is_running) || null;
    } catch (e) {
      // tabla aún no creada
    }
    const { employees, departments } = await fetchEmployeesCompletion({ year, month });
    const completedCount = employees.filter(e => e.completed).length;
    const completionPercent = employees.length ? Math.round((completedCount / employees.length) * 100) : 0;
    res.render('admin_mass_email', {
      title: 'Envío masivo',
      config,
      selectedYear: year,
      selectedMonth: month,
      defaultYear: def.year,
      defaultMonth: def.month,
      employees,
      departmentsSummary: departments,
      completedCount,
      completionPercent
      ,recentRuns
      ,currentRun
    });
  } catch (err) {
    console.error('Error en GET /admin/mass-email:', err);
    req.flash('error', 'No se pudo cargar la página de envío masivo');
    return res.redirect('/dashboard');
  }
});

// Guarda la configuración enviada desde el formulario.  Después de
// actualizar, redirige a la misma página con un mensaje de éxito.
router.post('/admin/mass-email/config', isAuth, requireRole(['admin']), async (req, res) => {
  try {
    const { start_day, send_time, batch_limit } = req.body;
    const enabled = !!req.body.enabled;
    const resend_sent = !!req.body.resend_sent;
    await saveBatchConfig({ enabled, start_day, send_time, batch_limit, resend_sent });
    req.flash('success', 'Configuración guardada');
    return res.redirect(`/admin/mass-email?anio=${encodeURIComponent(req.body.anio || '')}&mes=${encodeURIComponent(req.body.mes || '')}`);
  } catch (err) {
    console.error('Error al guardar configuración:', err);
    req.flash('error', 'No se pudo guardar la configuración');
    return res.redirect('/admin/mass-email');
  }
});

// Procesa el envío manual.  Se puede enviar a un conjunto de
// empleados específicos (employeeIds[]), a todos los empleados de
// determinados departamentos (departmentIds[]) o a todos los
// empleados (sendAll=1).  Los parámetros anio y mes son
// obligatorios.  La opción includeSent (checkbox) permite forzar el
// reenvío a empleados que ya recibieron el correo en el periodo.
router.post('/admin/mass-email/send', isAuth, requireRole(['admin']), async (req, res) => {
  try {
    let year = parseInt(req.body.anio, 10);
    let month = parseInt(req.body.mes, 10);
    if (!year || isNaN(year) || !month || isNaN(month)) {
      req.flash('error', 'Periodo inválido');
      return res.redirect('/admin/mass-email');
    }
    const force = !!req.body.includeSent;
    // Determinar lista de empleados a enviar
    let employeeIds = [];
    // Si se envió employeeIds[], usar esa lista
    if (Array.isArray(req.body['employeeIds[]']) || Array.isArray(req.body.employeeIds)) {
      const arr = req.body['employeeIds[]'] || req.body.employeeIds;
      employeeIds = Array.isArray(arr) ? arr.map(id => parseInt(id, 10)).filter(id => !isNaN(id)) : [];
    }
    // Si se envían departments, obtener empleados de esos departamentos
    let departmentIds = [];
    if (Array.isArray(req.body['departmentIds[]']) || Array.isArray(req.body.departmentIds)) {
      const arr = req.body['departmentIds[]'] || req.body.departmentIds;
      departmentIds = Array.isArray(arr) ? arr.map(id => parseInt(id, 10)).filter(id => !isNaN(id)) : [];
    }
    const sendAll = req.body.sendAll === '1' || req.body.sendAll === 'true' || req.body.sendAll === 1;
    // Si sendAll o departmentIds definidos, buscar empleados
    if (sendAll || departmentIds.length) {
      let query = `SELECT e.id
                   FROM empleados e
                   LEFT JOIN departamentos d ON e.departamento_id = d.id
                   WHERE e.sucursal_id IS NULL AND (d.nombre IS NULL OR d.nombre <> 'BAJA')`;
      const params = [];
      if (departmentIds.length) {
        const depPlace = departmentIds.map(() => '?').join(',');
        query += ` AND e.departamento_id IN (${depPlace})`;
        params.push(...departmentIds);
      }
      const [rows] = await pool.execute(query, params);
      const ids = rows.map(r => r.id);
      employeeIds = employeeIds.concat(ids);
    }
    // Eliminar duplicados
    employeeIds = Array.from(new Set(employeeIds)).filter(id => !isNaN(id));
    if (!employeeIds.length) {
      req.flash('error', 'No se seleccionaron empleados para enviar');
      return res.redirect(`/admin/mass-email?anio=${year}&mes=${month}`);
    }
    let successCount = 0;
    let skippedCount = 0;
    for (const empId of employeeIds) {
      try {
        const resObj = await sendIndividualKpiResults({ employeeId: empId, year, month, force });
        if (resObj.skipped) skippedCount++;
        else successCount++;
      } catch (err) {
        console.error(`Error enviando KPIs a empleado ${empId}:`, err.message);
      }
    }
    req.flash('success', `Envío realizado. Enviados: ${successCount}, omitidos: ${skippedCount}`);
    return res.redirect(`/admin/mass-email?anio=${year}&mes=${month}`);
  } catch (err) {
    console.error('Error en envío manual de correos:', err);
    req.flash('error', 'No se pudo realizar el envío');
    return res.redirect('/admin/mass-email');
  }
});

// Endpoint ligero para consultar el progreso (para refresco automático en la UI)
router.get('/admin/mass-email/progress', isAuth, requireRole(['admin']), async (req, res) => {
  try {
    const [rr] = await pool.execute(
      `SELECT id, period_year, period_month, started_at, finished_at, mode,
              total_targets, sent_count, skipped_count, error_count, is_running, last_message
       FROM kpi_batch_runs
       ORDER BY started_at DESC
       LIMIT 1`
    );
    const run = rr.length ? rr[0] : null;
    let pct = 0;
    if (run && run.total_targets) {
      pct = Math.round((Number(run.sent_count || 0) / Number(run.total_targets)) * 100);
    }
    return res.json({ run, percent: pct });
  } catch (e) {
    return res.json({ run: null, percent: 0 });
  }
});

module.exports = router;