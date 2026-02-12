const cron = require('node-cron');
const { pool } = require('../db');
const { startBatch, isRunning: isBatchRunning, getSendDelayMs } = require('./batchEmailRunner');

/*
 * Programador de envío automático de KPIs.
 * Este módulo ejecuta una tarea programada el día 10 de cada mes
 * a las 20:00 (8pm) para enviar los resultados del mes anterior a
 * todos los empleados que tienen correo registrado y que aún no han
 * recibido su archivo. El cálculo del periodo usa la función
 * getDefaultPeriod del dashboard, que aplica la regla de "día 1-10
 * se considera mes anterior".
 */

/**
 * Configura una tarea programada para el envío automático de KPIs.
 * A partir de la versión 0.98 se permite definir un límite diario
 * de correos a enviar y un día de inicio para el envío en cada mes.
 * Las variables de entorno soportadas son:
 *  - EMAIL_BATCH_LIMIT: número máximo de correos por día (por defecto 150)
 *  - EMAIL_BATCH_START_DAY: día del mes a partir del cual inicia el envío (por defecto 11)
 *  - EMAIL_BATCH_TIME: hora en formato HH:MM para ejecutar el cron diario (por defecto 20:00)
 *  - EMAIL_BATCH_RESEND_SENT: si es "true", se permiten reenvíos a empleados que ya
 *    recibieron su correo en el periodo actual cuando no haya pendientes.
 */
async function scheduleMonthlyEmails() {
  // Cargar configuración desde la base de datos si existe.  Si no hay
  // registros en kpi_batch_config se usarán los valores de entorno.
  let enabled = String(process.env.EMAIL_BATCH_ENABLED || '').toLowerCase() === 'true';
  let limit = parseInt(process.env.EMAIL_BATCH_LIMIT || '150', 10);
  let startDay = parseInt(process.env.EMAIL_BATCH_START_DAY || '11', 10);
  let resendSent = String(process.env.EMAIL_BATCH_RESEND_SENT || '').toLowerCase() === 'true';
  let timeStr = process.env.EMAIL_BATCH_TIME || '20:00';

  // Delay entre correos para evitar saturar el proveedor SMTP.
  // Se puede ajustar con EMAIL_SEND_DELAY_MS o EMAIL_BATCH_DELAY_MS.
  // (Por defecto: 1000ms)
  let delayMs = getSendDelayMs();

  function normalizeConfig() {
    // Límite: 1..999 (suficiente para cubrir a toda la empresa por ahora)
    limit = Math.min(Math.max(parseInt(limit || 150, 10), 1), 999);
    startDay = Math.min(Math.max(parseInt(startDay || 11, 10), 1), 31);
  }

  async function loadConfig() {
    try {
      const [rows] = await pool.execute('SELECT * FROM kpi_batch_config ORDER BY id DESC LIMIT 1');
      if (rows.length) {
        const cfg = rows[0];
        enabled = (cfg.enabled === 1 || cfg.enabled === true);
        limit = cfg.batch_limit || limit;
        startDay = cfg.start_day || startDay;
        resendSent = (cfg.resend_sent === 1 || cfg.resend_sent === true);
        timeStr = cfg.send_time || timeStr;
      }
    } catch (e) {
      // Silenciar errores de lectura; se usarán valores por defecto
    }

    normalizeConfig();

    // Re-leer delay por si cambiaron variables de entorno.
    delayMs = getSendDelayMs();
  }

  // Cargar config una vez al inicio
  await loadConfig();
  // Descomponer hora:minuto; si hay error usar 20:00
  let hour = 20;
  let minute = 0;
  if (timeStr && /^\d{1,2}:\d{2}$/.test(timeStr)) {
    const [h, m] = timeStr.split(':').map(v => parseInt(v, 10));
    if (!isNaN(h) && h >= 0 && h < 24) hour = h;
    if (!isNaN(m) && m >= 0 && m < 60) minute = m;
  }
  // Programar la tarea cada día a la hora/minuto configurada
  const cronExpr = `${minute} ${hour} * * *`;
  // Timezone del scheduler:
  // - Railway suele correr en UTC; esto permite que la "Hora de envío" coincida con la hora local.
  // - Por defecto usamos México (CDMX), pero se puede ajustar con EMAIL_SCHEDULER_TZ.
  const timezone = process.env.EMAIL_SCHEDULER_TZ || process.env.TZ || 'America/Mexico_City';

  cron.schedule(cronExpr, async () => {
    try {
      const now = new Date();
      // Recargar configuración en cada ejecución (para reflejar cambios desde la UI)
      await loadConfig();

      if (!enabled) {
        return;
      }
      // No ejecutar antes del día configurado
      if (now.getDate() < startDay) {
        return;
      }
      console.log(`[KPI Scheduler] Ejecutando envío automático (límite ${limit} / reenvío ${resendSent ? 'habilitado' : 'deshabilitado'} / delay ${delayMs}ms)...`);

      // Evitar ejecuciones simultáneas (manual vs scheduler).
      if (isBatchRunning()) {
        console.log('[KPI Scheduler] Ya existe un envío en curso. Se omite esta ejecución.');
        return;
      }

      // Periodo objetivo: SIEMPRE el mes anterior (independiente del día)
      const d = new Date();
      let year = d.getFullYear();
      let month = d.getMonth(); // 0-index del mes anterior
      if (month === 0) { month = 12; year -= 1; }
      // d.getMonth() devuelve 0-11; mes anterior en 1-12 queda:
      // si getMonth()=0 (enero) => month=12 del año anterior
      // si getMonth()=5 (junio) => month=5 (mayo)

      // Seleccionar empleados con correo no enviados en el periodo, hasta el límite establecido
      // IMPORTANTE:
      // En algunas instalaciones, MySQL puede fallar al usar placeholders en LIMIT.
      // Para evitar "Incorrect arguments to mysqld_stmt_execute", interpolamos un
      // LIMIT numérico ya normalizado (1..999) y mantenemos placeholders para el periodo.
      const [unsentRows] = await pool.execute(
        `SELECT e.id FROM empleados e
         LEFT JOIN departamentos d ON e.departamento_id = d.id
         WHERE e.correo IS NOT NULL AND e.correo <> ''
           AND (d.nombre IS NULL OR d.nombre <> 'BAJA')
           AND e.id NOT IN (
             SELECT empleado_id FROM kpi_emails_sent WHERE anio = ? AND mes = ?
           )
         ORDER BY e.id
         LIMIT ${Number(limit)}`,
        [year, month]
      );
      let employeeIds = unsentRows.map(r => r.id);
      let force = false;
      // Si no hay pendientes y el reenvío está habilitado, obtener destinatarios ya enviados
      if (employeeIds.length === 0 && resendSent) {
        const [sentRows] = await pool.execute(
          `SELECT e.id FROM empleados e
           JOIN kpi_emails_sent s ON e.id = s.empleado_id
           LEFT JOIN departamentos d ON e.departamento_id = d.id
           WHERE s.anio = ? AND s.mes = ?
             AND e.correo IS NOT NULL AND e.correo <> ''
             AND (d.nombre IS NULL OR d.nombre <> 'BAJA')
           ORDER BY e.id
           LIMIT ${Number(limit)}`,
          [year, month]
        );
        employeeIds = sentRows.map(r => r.id);
        force = true;
      }
      if (employeeIds.length === 0) {
        console.log(`[KPI Scheduler] No hay empleados pendientes ni reenviables para ${month}/${year}.`);
        return;
      }

      try {
        const kind = force ? 'reenvío' : 'pendientes';
        const { runId, totalTargets } = await startBatch({
          year,
          month,
          mode: 'scheduler',
          employeeIds,
          force,
          delayMs,
          message: `Scheduler ${kind} ${month}/${year} - targets=${employeeIds.length}`
        });
        console.log(`[KPI Scheduler] Envío iniciado (runId=${runId || 'N/A'}) - destinatarios: ${totalTargets}`);
      } catch (e) {
        if (e && e.code === 'BATCH_ALREADY_RUNNING') {
          console.log('[KPI Scheduler] Ya hay un envío en curso. Se omite esta ejecución.');
          return;
        }
        console.error('[KPI Scheduler] No se pudo iniciar el envío:', e);
      }
    } catch (err) {
      console.error('[KPI Scheduler] Error en ejecución:', err);
    }
  }, { timezone });
}

module.exports = { scheduleMonthlyEmails };