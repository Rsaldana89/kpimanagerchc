const { pool } = require('../db');

async function getKpiCountMap() {
  const [rows] = await pool.execute(
    'SELECT puesto_id, COUNT(*) AS total FROM puesto_kpis GROUP BY puesto_id'
  );
  const m = new Map();
  (rows || []).forEach(r => m.set(Number(r.puesto_id), Number(r.total)));
  return m;
}

async function fetchLiveEmployeeBase() {
  try {
    const [rows] = await pool.execute(
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
    return rows || [];
  } catch (e) {
    const [rows] = await pool.execute(
      `SELECT e.id, e.incidencia_id, e.nombre, e.correo,
              e.puesto_id, e.departamento_id, e.sucursal_id,
              d.nombre AS departamento_nombre
       FROM empleados e
       LEFT JOIN departamentos d ON e.departamento_id = d.id
       WHERE (d.nombre IS NULL OR d.nombre <> 'BAJA')
       ORDER BY e.nombre`
    );
    return (rows || []).map(r => ({ ...r, sucursal_nombre: '' }));
  }
}

async function getSnapshotRows({ year, month }) {
  try {
    const [rows] = await pool.execute(
      `SELECT pe.empleado_id AS id,
              COALESCE(pe.incidencia_id, e.incidencia_id) AS incidencia_id,
              COALESCE(pe.nombre, e.nombre) AS nombre,
              COALESCE(pe.correo, e.correo) AS correo,
              pe.puesto_id,
              pe.departamento_id,
              pe.sucursal_id,
              pe.total_kpis,
              pe.created_at AS snapshot_created_at,
              COALESCE(pe.departamento_nombre, d.nombre, 'Sin departamento') AS departamento_nombre,
              COALESCE(pe.sucursal_nombre, s.nombre, '') AS sucursal_nombre
       FROM kpi_periodo_empleados pe
       LEFT JOIN empleados e ON e.id = pe.empleado_id
       LEFT JOIN departamentos d ON pe.departamento_id = d.id
       LEFT JOIN sucursales s ON pe.sucursal_id = s.id
       WHERE pe.anio = ? AND pe.mes = ?
       ORDER BY COALESCE(pe.nombre, e.nombre)`,
      [year, month]
    );
    return rows || [];
  } catch (e) {
    try {
      const [rows] = await pool.execute(
        `SELECT pe.empleado_id AS id,
                COALESCE(pe.incidencia_id, e.incidencia_id) AS incidencia_id,
                COALESCE(pe.nombre, e.nombre) AS nombre,
                COALESCE(pe.correo, e.correo) AS correo,
                pe.puesto_id,
                pe.departamento_id,
                pe.sucursal_id,
                pe.total_kpis,
                pe.created_at AS snapshot_created_at,
                COALESCE(pe.departamento_nombre, d.nombre, 'Sin departamento') AS departamento_nombre
         FROM kpi_periodo_empleados pe
         LEFT JOIN empleados e ON e.id = pe.empleado_id
         LEFT JOIN departamentos d ON pe.departamento_id = d.id
         WHERE pe.anio = ? AND pe.mes = ?
         ORDER BY COALESCE(pe.nombre, e.nombre)`,
        [year, month]
      );
      return (rows || []).map(r => ({ ...r, sucursal_nombre: '' }));
    } catch (e2) {
      return [];
    }
  }
}

async function getSnapshotMeta({ year, month }) {
  try {
    const [rows] = await pool.execute(
      `SELECT MIN(created_at) AS snapshot_at, COUNT(*) AS total
       FROM kpi_periodo_empleados
       WHERE anio = ? AND mes = ?`,
      [year, month]
    );
    const r = rows && rows[0] ? rows[0] : null;
    return {
      snapshot_at: r ? (r.snapshot_at || null) : null,
      total: r ? Number(r.total || 0) : 0,
      has_snapshot: !!(r && Number(r.total || 0) > 0)
    };
  } catch (e) {
    return { snapshot_at: null, total: 0, has_snapshot: false };
  }
}

async function getPeriodStatus({ year, month }) {
  let base = {
    year,
    month,
    has_record: false,
    is_closed: false,
    snapshot_at: null,
    closed_at: null,
    reopened_at: null,
    closed_by: null,
    reopened_by: null,
    has_snapshot: false,
    snapshot_count: 0
  };
  try {
    const [rows] = await pool.execute(
      `SELECT anio, mes, cerrado, snapshot_el, cerrado_por, cerrado_el, reabierto_por, reabierto_el
       FROM kpi_periodo_cierres
       WHERE anio = ? AND mes = ?
       LIMIT 1`,
      [year, month]
    );
    if (rows && rows[0]) {
      const r = rows[0];
      base = {
        ...base,
        has_record: true,
        is_closed: r.cerrado === 1 || r.cerrado === true,
        snapshot_at: r.snapshot_el || null,
        closed_at: r.cerrado_el || null,
        reopened_at: r.reabierto_el || null,
        closed_by: r.cerrado_por || null,
        reopened_by: r.reabierto_por || null
      };
    }
  } catch (e) {
    // ignore if table doesn't exist
  }
  const snap = await getSnapshotMeta({ year, month });
  return {
    ...base,
    snapshot_at: base.snapshot_at || snap.snapshot_at,
    has_snapshot: snap.has_snapshot,
    snapshot_count: snap.total
  };
}

function getLastDayOfMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function isAfterNaturalMonthEnd({ year, month, now = new Date() }) {
  const lastDay = getLastDayOfMonth(year, month);
  const monthEnd = new Date(year, month - 1, lastDay, 23, 59, 59, 999);
  return now.getTime() > monthEnd.getTime();
}

async function rebuildPeriodSnapshot({ year, month, replaceExisting = true }) {
  const employees = await fetchLiveEmployeeBase();
  const kpiCountMap = await getKpiCountMap();
  if (replaceExisting) {
    try {
      await pool.execute('DELETE FROM kpi_periodo_empleados WHERE anio = ? AND mes = ?', [year, month]);
    } catch (e) {
      // table may not exist yet; caller should ensure schema
    }
  }
  if (!employees.length) return { count: 0 };
  const values = employees.map(emp => [
    emp.id,
    year,
    month,
    emp.incidencia_id || null,
    emp.nombre || null,
    emp.correo || null,
    emp.puesto_id || null,
    emp.departamento_id || null,
    emp.departamento_nombre || null,
    emp.sucursal_id || null,
    emp.sucursal_nombre || null,
    kpiCountMap.get(Number(emp.puesto_id)) || 0
  ]);
  const placeholders = values.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
  const flat = values.flat();
  await pool.execute(
    `INSERT INTO kpi_periodo_empleados (empleado_id, anio, mes, incidencia_id, nombre, correo, puesto_id, departamento_id, departamento_nombre, sucursal_id, sucursal_nombre, total_kpis)
     VALUES ${placeholders}`,
    flat
  );
  return { count: values.length };
}

async function ensurePeriodSnapshot({ year, month, replaceExisting = false }) {
  const meta = await getSnapshotMeta({ year, month });
  if (meta.has_snapshot && !replaceExisting) {
    return { count: meta.total, skipped: true, snapshot_at: meta.snapshot_at };
  }
  return rebuildPeriodSnapshot({ year, month, replaceExisting: !!replaceExisting });
}

/**
 * Bloquea la base de personal del periodo regenerando el snapshot y
 * registrando la fecha en kpi_periodo_cierres.snapshot_el. A diferencia de
 * ensurePeriodSnapshot, este método siempre reemplaza el snapshot previo para
 * reflejar la plantilla vigente al momento de ejecución. No cambia el
 * estado de cierre del periodo (cerrado), sólo la marca de snapshot.
 *
 * @param {Object} param0
 * @param {number} param0.year - Año del periodo (4 dígitos)
 * @param {number} param0.month - Mes del periodo (1-12)
 * @returns {Promise<{count:number, snapshot_at: (Date|null)}>}
 */
async function lockSnapshot({ year, month }) {
  // Regenerar el snapshot de personal para el periodo (reemplaza existente)
  const rebuild = await rebuildPeriodSnapshot({ year, month, replaceExisting: true });
  // Registrar o actualizar la fecha de snapshot en la tabla de cierres
  try {
    await pool.execute(
      `INSERT INTO kpi_periodo_cierres (anio, mes, snapshot_el)
       VALUES (?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         snapshot_el = NOW()`,
      [year, month]
    );
  } catch (e) {
    // Si la tabla no existe o hay un error, lo ignoramos. El snapshot
    // generado seguirá siendo válido aunque no se registre la fecha.
  }
  // Devolver información del snapshot (conteo y fecha)
  const meta = await getSnapshotMeta({ year, month });
  return {
    count: rebuild.count || meta.total,
    snapshot_at: meta.snapshot_at || null
  };
}


async function reopenSnapshot({ year, month }) {
  try {
    await pool.execute('DELETE FROM kpi_periodo_empleados WHERE anio = ? AND mes = ?', [year, month]);
  } catch (e) {
    // ignore if snapshot table is unavailable
  }
  try {
    await pool.execute(
      `INSERT INTO kpi_periodo_cierres (anio, mes, snapshot_el)
       VALUES (?, ?, NULL)
       ON DUPLICATE KEY UPDATE snapshot_el = NULL`,
      [year, month]
    );
  } catch (e) {
    // ignore if closure table is unavailable
  }
}

async function closePeriod({ year, month, userId = null }) {
  const snapMeta = await getSnapshotMeta({ year, month });
  const snapshotAt = snapMeta.snapshot_at || null;
  await pool.execute(
    `INSERT INTO kpi_periodo_cierres (anio, mes, cerrado, snapshot_el, cerrado_por, cerrado_el, reabierto_por, reabierto_el)
     VALUES (?, ?, 1, ?, ?, NOW(), NULL, NULL)
     ON DUPLICATE KEY UPDATE
       cerrado = 1,
       snapshot_el = COALESCE(snapshot_el, VALUES(snapshot_el)),
       cerrado_por = VALUES(cerrado_por),
       cerrado_el = NOW(),
       reabierto_por = NULL,
       reabierto_el = NULL`,
    [year, month, snapshotAt, userId]
  );
  return { count: snapMeta.total, skipped: !snapMeta.has_snapshot, snapshot_at: snapshotAt };
}

async function reopenPeriod({ year, month, userId = null }) {
  await pool.execute(
    `INSERT INTO kpi_periodo_cierres (anio, mes, cerrado, reabierto_por, reabierto_el)
     VALUES (?, ?, 0, ?, NOW())
     ON DUPLICATE KEY UPDATE
       cerrado = 0,
       reabierto_por = VALUES(reabierto_por),
       reabierto_el = NOW()`,
    [year, month, userId]
  );
}

async function isPeriodManuallyClosed({ year, month }) {
  try {
    const [rows] = await pool.execute(
      'SELECT cerrado FROM kpi_periodo_cierres WHERE anio = ? AND mes = ? LIMIT 1',
      [year, month]
    );
    if (!rows || !rows[0]) return false;
    return rows[0].cerrado === 1 || rows[0].cerrado === true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  fetchLiveEmployeeBase,
  getSnapshotRows,
  getSnapshotMeta,
  getPeriodStatus,
  getLastDayOfMonth,
  isAfterNaturalMonthEnd,
  rebuildPeriodSnapshot,
  ensurePeriodSnapshot,
  // Nuevo: función para bloquear la base del personal de un periodo
  lockSnapshot,
  reopenSnapshot,
  closePeriod,
  reopenPeriod,
  isPeriodManuallyClosed
};
