const cron = require('node-cron');
const { sendIndividualKpiResults } = require('./kpiEmail');
const dashboardRoutes = require('../routes/dashboard');
const { pool } = require('../db');

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
      console.log(`[KPI Scheduler] Ejecutando envío automático (enabled) (límite ${limit} / reenvío ${resendSent ? 'habilitado' : 'deshabilitado'})...`);

      // Periodo objetivo: SIEMPRE el mes anterior (independiente del día)
      const d = new Date();
      let year = d.getFullYear();
      let month = d.getMonth(); // 0-index del mes anterior
      if (month === 0) { month = 12; year -= 1; }
      // d.getMonth() devuelve 0-11; mes anterior en 1-12 queda:
      // si getMonth()=0 (enero) => month=12 del año anterior
      // si getMonth()=5 (junio) => month=5 (mayo)

      // Registrar ejecución (progreso)
      let runId = null;
      try {
        const [ins] = await pool.execute(
          `INSERT INTO kpi_batch_runs (period_year, period_month, started_at, mode, total_targets, sent_count, skipped_count, error_count, is_running)
           VALUES (?, ?, NOW(), 'scheduler', 0, 0, 0, 0, 1)`,
          [year, month]
        );
        runId = ins.insertId;
      } catch (e) {
        // Si la tabla no existe, continuar sin tracking
      }
      // Seleccionar empleados con correo no enviados en el periodo, hasta el límite establecido
      const [unsentRows] = await pool.execute(
        `SELECT e.id FROM empleados e
         LEFT JOIN departamentos d ON e.departamento_id = d.id
         WHERE e.correo IS NOT NULL AND e.correo <> ''
           AND e.sucursal_id IS NULL
           AND (d.nombre IS NULL OR d.nombre <> 'BAJA')
           AND e.id NOT IN (
             SELECT empleado_id FROM kpi_emails_sent WHERE anio = ? AND mes = ?
           )
         ORDER BY e.id
         LIMIT ?`,
        [year, month, limit]
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
             AND e.sucursal_id IS NULL
             AND (d.nombre IS NULL OR d.nombre <> 'BAJA')
           ORDER BY e.id
           LIMIT ?`,
          [year, month, limit]
        );
        employeeIds = sentRows.map(r => r.id);
        force = true;
      }
      if (employeeIds.length === 0) {
        console.log(`[KPI Scheduler] No hay empleados pendientes ni reenviables para ${month}/${year}.`);
        return;
      }
      let sentCount = 0;
      let errCount = 0;
      // Actualizar total_targets al arrancar
      if (runId) {
        try {
          await pool.execute('UPDATE kpi_batch_runs SET total_targets = ? WHERE id = ?', [employeeIds.length, runId]);
        } catch (e) {}
      }
      for (const empId of employeeIds) {
        try {
          await sendIndividualKpiResults({ employeeId: empId, year, month, force });
          sentCount++;
          if (runId) {
            try {
              await pool.execute('UPDATE kpi_batch_runs SET sent_count = ? WHERE id = ?', [sentCount, runId]);
            } catch (e) {}
          }
        } catch (err) {
          console.error(`[KPI Scheduler] Error enviando a ${empId}:`, err.message);
          errCount++;
          if (runId) {
            try {
              await pool.execute('UPDATE kpi_batch_runs SET error_count = ? WHERE id = ?', [errCount, runId]);
            } catch (e) {}
          }
        }
      }
      if (runId) {
        try {
          await pool.execute(
            'UPDATE kpi_batch_runs SET finished_at = NOW(), is_running = 0, last_message = ? WHERE id = ?',
            [`Completado: enviados=${sentCount} errores=${errCount} (${force ? 'reenvío' : 'pendientes'})`, runId]
          );
        } catch (e) {}
      }
      console.log(`[KPI Scheduler] Envío automático diario completado (${force ? 'reenvío' : 'pendientes'}). Correos enviados: ${sentCount} (errores: ${errCount})`);
    } catch (err) {
      console.error('[KPI Scheduler] Error en ejecución:', err);
    }
  });
}

module.exports = { scheduleMonthlyEmails };