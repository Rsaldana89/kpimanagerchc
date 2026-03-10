const cron = require('node-cron');
const { ensurePeriodSnapshot, getLastDayOfMonth } = require('./periodLocks');

function getSchedulerTimezone() {
  return process.env.PERIOD_SNAPSHOT_TIMEZONE || 'America/Mexico_City';
}

function getCurrentPeriodParts(now = new Date()) {
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

function getPreviousPeriod(now = new Date()) {
  let year = now.getFullYear();
  let month = now.getMonth();
  if (month < 1) {
    month = 12;
    year -= 1;
  }
  return { year, month };
}

async function snapshotCurrentMonthIfMonthEnd(now = new Date()) {
  const { year, month, day } = getCurrentPeriodParts(now);
  const lastDay = getLastDayOfMonth(year, month);
  if (day !== lastDay) return { ran: false, reason: 'not-month-end' };
  const result = await ensurePeriodSnapshot({ year, month, replaceExisting: false });
  return { ran: true, year, month, ...result };
}

async function ensurePreviousMonthSnapshot(now = new Date()) {
  const { year, month } = getPreviousPeriod(now);
  const result = await ensurePeriodSnapshot({ year, month, replaceExisting: false });
  return { ran: true, year, month, ...result };
}

function schedulePeriodSnapshots() {
  const timezone = getSchedulerTimezone();

  // 23:55 todos los días. Solo actúa si hoy es el último día natural del mes.
  cron.schedule('55 23 * * *', async () => {
    try {
      const result = await snapshotCurrentMonthIfMonthEnd();
      if (result.ran) {
        console.log(`[Period Snapshot] Snapshot de cierre natural ${result.year}-${String(result.month).padStart(2, '0')} listo. Filas: ${result.count || 0}${result.skipped ? ' (ya existía)' : ''}`);
      }
    } catch (err) {
      console.error('[Period Snapshot] Error generando snapshot de fin de mes:', err);
    }
  }, { timezone });

  // 00:10 del día 1 de cada mes. Sirve como respaldo si el proceso estaba abajo
  // justo al final del mes o si hubo reinicio. Solo crea el snapshot si aún no existe.
  cron.schedule('10 0 1 * *', async () => {
    try {
      const result = await ensurePreviousMonthSnapshot();
      console.log(`[Period Snapshot] Verificación de respaldo para ${result.year}-${String(result.month).padStart(2, '0')}. Filas: ${result.count || 0}${result.skipped ? ' (ya existía)' : ''}`);
    } catch (err) {
      console.error('[Period Snapshot] Error verificando snapshot de respaldo:', err);
    }
  }, { timezone });

  // Al arrancar: si hoy es día 1, hacemos la misma verificación de respaldo.
  // Si hoy es último día del mes, dejamos el snapshot al cron nocturno para respetar la foto al cierre natural.
  try {
    const now = new Date();
    if (now.getDate() === 1) {
      ensurePreviousMonthSnapshot(now)
        .then((result) => {
          console.log(`[Period Snapshot] Verificación inicial para ${result.year}-${String(result.month).padStart(2, '0')}. Filas: ${result.count || 0}${result.skipped ? ' (ya existía)' : ''}`);
        })
        .catch((err) => {
          console.error('[Period Snapshot] Error en verificación inicial:', err);
        });
    }
  } catch (err) {
    console.error('[Period Snapshot] Error preparando verificación inicial:', err);
  }
}

module.exports = {
  schedulePeriodSnapshots,
  snapshotCurrentMonthIfMonthEnd,
  ensurePreviousMonthSnapshot
};
