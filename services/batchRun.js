const { pool } = require('../db');

// Cache de columnas detectadas para la tabla kpi_batch_runs.
let __batchRunsCols = null;

async function getBatchRunsColumnsSafe() {
  if (__batchRunsCols) return __batchRunsCols;
  try {
    const [cols] = await pool.execute('SHOW COLUMNS FROM kpi_batch_runs');
    __batchRunsCols = new Set((cols || []).map(c => String(c.Field || '').toLowerCase()));
    return __batchRunsCols;
  } catch (e) {
    // Tabla no existe o no tenemos permisos
    __batchRunsCols = null;
    return null;
  }
}

function hasCol(cols, name) {
  return !!cols && cols.has(String(name).toLowerCase());
}

function toInt(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

/**
 * Inserta una ejecución en kpi_batch_runs de forma compatible con
 * diferentes esquemas (sin alterar la base de datos).
 *
 * @returns {Promise<number|null>} id insertado o null si no se pudo registrar.
 */
async function insertBatchRun({ year, month, mode = 'manual', totalTargets = 0 }) {
  const cols = await getBatchRunsColumnsSafe();
  if (!cols) return null;

  // Columnas mínimas esperadas
  if (!hasCol(cols, 'period_year') || !hasCol(cols, 'period_month')) {
    return null;
  }

  const insertCols = ['period_year', 'period_month'];
  const valuesSql = ['?', '?'];
  const params = [toInt(year), toInt(month)];

  if (hasCol(cols, 'started_at')) {
    insertCols.push('started_at');
    valuesSql.push('NOW()');
  }
  if (hasCol(cols, 'finished_at')) {
    insertCols.push('finished_at');
    valuesSql.push('NULL');
  }
  if (hasCol(cols, 'mode')) {
    insertCols.push('mode');
    valuesSql.push('?');
    params.push(String(mode));
  }
  if (hasCol(cols, 'total_targets')) {
    insertCols.push('total_targets');
    valuesSql.push('?');
    params.push(toInt(totalTargets));
  }
  if (hasCol(cols, 'sent_count')) {
    insertCols.push('sent_count');
    valuesSql.push('?');
    params.push(0);
  }
  if (hasCol(cols, 'skipped_count')) {
    insertCols.push('skipped_count');
    valuesSql.push('?');
    params.push(0);
  }
  if (hasCol(cols, 'error_count')) {
    insertCols.push('error_count');
    valuesSql.push('?');
    params.push(0);
  }
  if (hasCol(cols, 'is_running')) {
    insertCols.push('is_running');
    valuesSql.push('?');
    params.push(1);
  }
  if (hasCol(cols, 'last_message')) {
    insertCols.push('last_message');
    valuesSql.push('?');
    params.push('En curso');
  }

  const sql = `INSERT INTO kpi_batch_runs (${insertCols.join(', ')}) VALUES (${valuesSql.join(', ')})`;
  try {
    const [ins] = await pool.execute(sql, params);
    return ins.insertId || null;
  } catch (e) {
    return null;
  }
}

/**
 * Actualiza una ejecución. Solo se actualizan columnas existentes.
 */
async function updateBatchRun(runId, fields = {}) {
  const cols = await getBatchRunsColumnsSafe();
  if (!cols) return;

  const sets = [];
  const params = [];

  function setIf(colName, sqlExpr, value) {
    if (!hasCol(cols, colName)) return;
    sets.push(`${colName} = ${sqlExpr}`);
    if (sqlExpr.includes('?')) params.push(value);
  }

  const id = toInt(runId);
  if (!id) return;

  if (fields.total_targets != null) setIf('total_targets', '?', toInt(fields.total_targets));
  if (fields.sent_count != null) setIf('sent_count', '?', toInt(fields.sent_count));
  if (fields.skipped_count != null) setIf('skipped_count', '?', toInt(fields.skipped_count));
  if (fields.error_count != null) setIf('error_count', '?', toInt(fields.error_count));
  if (fields.is_running != null) setIf('is_running', '?', fields.is_running ? 1 : 0);
  if (fields.last_message != null) setIf('last_message', '?', String(fields.last_message).slice(0, 255));
  if (fields.last_error != null) setIf('last_error', '?', String(fields.last_error).slice(0, 255));

  if (fields.finished_at === 'NOW') {
    setIf('finished_at', 'NOW()');
  } else if (fields.finished_at != null) {
    // Pasar Date o string
    setIf('finished_at', '?', fields.finished_at);
  }

  if (!sets.length) return;

  const sql = `UPDATE kpi_batch_runs SET ${sets.join(', ')} WHERE id = ?`;
  params.push(id);
  try {
    await pool.execute(sql, params);
  } catch (e) {
    // no-op
  }
}

/**
 * Obtiene ejecuciones recientes en formato estable (rellena columnas faltantes con defaults).
 */
async function fetchRecentRuns(limit = 10) {
  const cols = await getBatchRunsColumnsSafe();
  if (!cols) return [];

  const safeLimit = Math.max(1, Math.min(50, toInt(limit, 10)));

  const parts = [];
  // Campos base
  parts.push('id');
  parts.push(hasCol(cols, 'period_year') ? 'period_year' : '0 AS period_year');
  parts.push(hasCol(cols, 'period_month') ? 'period_month' : '0 AS period_month');
  parts.push(hasCol(cols, 'started_at') ? 'started_at' : 'NULL AS started_at');
  parts.push(hasCol(cols, 'finished_at') ? 'finished_at' : 'NULL AS finished_at');
  parts.push(hasCol(cols, 'mode') ? 'mode' : "'scheduler' AS mode");
  parts.push(hasCol(cols, 'total_targets') ? 'total_targets' : '0 AS total_targets');
  parts.push(hasCol(cols, 'sent_count') ? 'sent_count' : '0 AS sent_count');
  parts.push(hasCol(cols, 'skipped_count') ? 'skipped_count' : '0 AS skipped_count');
  parts.push(hasCol(cols, 'error_count') ? 'error_count' : '0 AS error_count');

  if (hasCol(cols, 'is_running')) {
    parts.push('is_running');
  } else if (hasCol(cols, 'finished_at')) {
    parts.push('CASE WHEN finished_at IS NULL THEN 1 ELSE 0 END AS is_running');
  } else {
    parts.push('0 AS is_running');
  }

  parts.push(hasCol(cols, 'last_message') ? 'last_message' : 'NULL AS last_message');
  parts.push(hasCol(cols, 'last_error') ? 'last_error' : 'NULL AS last_error');

  const sql = `SELECT ${parts.join(', ')} FROM kpi_batch_runs ORDER BY started_at DESC LIMIT ${safeLimit}`;
  try {
    const [rows] = await pool.execute(sql);
    return (rows || []).map(r => ({
      ...r,
      // Normalizar boolean
      is_running: (r.is_running === 1 || r.is_running === true),
      total_targets: toInt(r.total_targets),
      sent_count: toInt(r.sent_count),
      skipped_count: toInt(r.skipped_count),
      error_count: toInt(r.error_count)
    }));
  } catch (e) {
    return [];
  }
}

async function fetchLatestRun() {
  const runs = await fetchRecentRuns(1);
  return runs.length ? runs[0] : null;
}

/**
 * Retorna la ejecución en curso más reciente (si existe).
 */
async function findRunningRun() {
  const cols = await getBatchRunsColumnsSafe();
  if (!cols) return null;

  let sql;
  if (hasCol(cols, 'is_running')) {
    sql = 'SELECT id, period_year, period_month, started_at, finished_at, mode, total_targets, sent_count FROM kpi_batch_runs WHERE is_running = 1 ORDER BY started_at DESC LIMIT 1';
  } else if (hasCol(cols, 'finished_at')) {
    sql = 'SELECT id, period_year, period_month, started_at, finished_at, mode, total_targets, sent_count FROM kpi_batch_runs WHERE finished_at IS NULL ORDER BY started_at DESC LIMIT 1';
  } else {
    return null;
  }

  try {
    const [rows] = await pool.execute(sql);
    return rows.length ? rows[0] : null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  getBatchRunsColumnsSafe,
  insertBatchRun,
  updateBatchRun,
  fetchRecentRuns,
  fetchLatestRun,
  findRunningRun
};
