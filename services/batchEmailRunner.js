const { sendIndividualKpiResults } = require('./kpiEmail');
const batchRun = require('./batchRun');

let __isRunning = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clampInt(v, min, max, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function uniqNumericIds(list) {
  const out = [];
  const seen = new Set();
  (Array.isArray(list) ? list : []).forEach(v => {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    const id = Math.trunc(n);
    if (id <= 0) return;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  });
  return out;
}

function resolvePace(pace) {
  const p = String(pace || 'standard').toLowerCase();
  if (p === 'burst' || p === 'all' || p === 'todos' || p === 'no_delay') {
    return { key: 'burst', label: 'Todos a la vez', concurrency: 8, delayMs: 0, jitterMs: 0 };
  }
  if (p === 'fast' || p === 'rapido' || p === 'rápido') {
    return { key: 'fast', label: 'Rápido', concurrency: 4, delayMs: 350, jitterMs: 150 };
  }
  // standard/safe
  return { key: 'standard', label: 'Estándar', concurrency: 2, delayMs: 900, jitterMs: 200 };
}

function isRunning() {
  return __isRunning;
}

function getSendDelayMs() {
  const env = process.env.EMAIL_BATCH_DELAY_MS ?? process.env.EMAIL_SEND_DELAY_MS;
  if (env == null) return 900;
  return clampInt(parseInt(String(env), 10), 0, 60000, 900);
}

function getSendConcurrency() {
  const env = process.env.EMAIL_BATCH_CONCURRENCY;
  if (env == null) return null;
  return clampInt(parseInt(String(env), 10), 1, 25, null);
}

/**
 * Ejecuta un lote de envíos con control de concurrencia y delay.
 * Si runId existe y la tabla soporta tracking, actualiza progreso.
 */
async function runEmailBatch({
  runId = null,
  year,
  month,
  employeeIds,
  force = false,
  pace = 'standard',
  concurrency: concurrencyOverride = null,
  delayMs: delayMsOverride = null,
  jitterMs: jitterMsOverride = null,
  onProgress = null
}) {
  const targets = uniqNumericIds(employeeIds);
  const total = targets.length;
  const paceCfg = resolvePace(pace);

  const concurrency = clampInt(
    concurrencyOverride ?? getSendConcurrency() ?? paceCfg.concurrency,
    1,
    25,
    paceCfg.concurrency
  );
  const delayMs = clampInt(
    delayMsOverride ?? paceCfg.delayMs,
    0,
    60000,
    paceCfg.delayMs
  );
  const jitterMs = clampInt(
    jitterMsOverride ?? paceCfg.jitterMs,
    0,
    60000,
    paceCfg.jitterMs
  );

  let sent = 0;
  let skipped = 0;
  let errors = 0;
  let lastError = null;

  // Inicializar tracking
  if (runId) {
    await batchRun.updateBatchRun(runId, {
      total_targets: total,
      sent_count: 0,
      skipped_count: 0,
      error_count: 0,
      is_running: 1,
      last_message: `En curso: 0/${total} (${paceCfg.label})`
    });
  }

  const queue = targets;

  async function reportProgress() {
    const processed = sent + skipped + errors;
    const msg = `En curso: ${processed}/${total} | Enviados: ${sent} | Omitidos: ${skipped} | Errores: ${errors} (${paceCfg.label})`;
    if (runId) {
      await batchRun.updateBatchRun(runId, {
        sent_count: sent,
        skipped_count: skipped,
        error_count: errors,
        last_message: msg,
        last_error: lastError || null
      });
    }
    if (typeof onProgress === 'function') {
      onProgress({ sent, skipped, errors, total, lastError, pace: paceCfg.key });
    }
  }

  // Para evitar demasiadas escrituras, hacemos update como máximo cada ~1s
  let lastDbUpdateAt = 0;
  async function throttledReport() {
    const now = Date.now();
    if (now - lastDbUpdateAt < 900) return;
    lastDbUpdateAt = now;
    await reportProgress();
  }

  async function worker() {
    while (queue.length) {
      const empId = queue.shift();
      if (!empId) continue;
      try {
        const r = await sendIndividualKpiResults({ employeeId: empId, year, month, force });
        if (r && r.skipped) skipped += 1;
        else sent += 1;
      } catch (e) {
        let msg = (e && e.message) ? String(e.message) : String(e);

        // Si el error es por correo faltante, lo tratamos como omitido
        // para que el conteo sea más claro (esto es común en altas/bajas).
        if (msg.toLowerCase().includes('no tiene correo')) {
          skipped += 1;
          msg = null;
        } else {
          errors += 1;
        }

        if (msg) lastError = msg;
      }

      await throttledReport();

      const wait = delayMs + (jitterMs ? Math.floor(Math.random() * jitterMs) : 0);
      if (wait > 0) await sleep(wait);
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  // Reporte final
  await reportProgress();

  if (runId) {
    const finalMsg = `Finalizado | Enviados: ${sent} | Omitidos: ${skipped} | Errores: ${errors} (${paceCfg.label})`;
    await batchRun.updateBatchRun(runId, {
      is_running: 0,
      finished_at: 'NOW',
      sent_count: sent,
      skipped_count: skipped,
      error_count: errors,
      last_message: finalMsg,
      last_error: lastError || null
    });
  }

  return { sent, skipped, errors, total, pace: paceCfg.key, concurrency, delayMs };
}

/**
 * Crea un registro de ejecución (si existe la tabla) y ejecuta el lote.
 * Por defecto corre en segundo plano.
 */
async function startBatch({
  year,
  month,
  mode = 'manual',
  employeeIds,
  force = false,
  pace = 'standard',
  delayMs = null,
  concurrency = null,
  message = null,
  background = true
}) {
  // Evitar envíos simultáneos (manual/scheduler)
  if (__isRunning) {
    const err = new Error('Ya existe un envío en curso');
    err.code = 'BATCH_ALREADY_RUNNING';
    throw err;
  }

  const runningDb = await batchRun.findRunningRun();
  if (runningDb) {
    const err = new Error('Ya existe un envío en curso (DB)');
    err.code = 'BATCH_ALREADY_RUNNING';
    throw err;
  }

  const ids = uniqNumericIds(employeeIds);

  // Registrar ejecución
  const runId = await batchRun.insertBatchRun({
    year,
    month,
    mode,
    totalTargets: ids.length
  });

  if (runId && message) {
    await batchRun.updateBatchRun(runId, { last_message: String(message).slice(0, 255) });
  }

  const task = async () => {
    __isRunning = true;
    try {
      return await runEmailBatch({
        runId,
        year,
        month,
        employeeIds: ids,
        force,
        pace,
        delayMs,
        concurrency
      });
    } finally {
      __isRunning = false;
    }
  };

  if (background) {
    setImmediate(task);
    return { runId, totalTargets: ids.length };
  }

  const summary = await task();
  return { runId, totalTargets: ids.length, summary };
}

module.exports = {
  // API de alto nivel
  startBatch,
  runEmailBatch,

  // Utilidades / compat
  resolvePace,
  isRunning,
  getSendDelayMs,
  getSendConcurrency
};
