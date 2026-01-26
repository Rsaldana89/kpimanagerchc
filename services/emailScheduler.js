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
function scheduleMonthlyEmails() {
  const limit = parseInt(process.env.EMAIL_BATCH_LIMIT || '150', 10);
  const startDay = parseInt(process.env.EMAIL_BATCH_START_DAY || '11', 10);
  const resendFlag = String(process.env.EMAIL_BATCH_RESEND_SENT || '').toLowerCase() === 'true';
  const timeStr = process.env.EMAIL_BATCH_TIME || '20:00';
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
      // No ejecutar antes del día configurado
      if (now.getDate() < startDay) {
        return;
      }
      console.log(`[KPI Scheduler] Ejecutando envío automático de correos (límite ${limit} / reenvío ${resendFlag ? 'habilitado' : 'deshabilitado'})...`);
      // Calcular periodo para el que se enviarán los resultados.  Usar la misma regla de getDefaultPeriod
      const getDefault = dashboardRoutes.getDefaultPeriod || dashboardRoutes.router?.getDefaultPeriod;
      let period;
      if (getDefault) {
        period = getDefault();
      } else {
        // Respaldo: calcula periodo manualmente
        const d = new Date();
        let y = d.getFullYear();
        let m = d.getMonth() + 1;
        if (d.getDate() <= 10) {
          m -= 1;
          if (m < 1) { m = 12; y -= 1; }
        }
        period = { year: y, month: m };
      }
      const { year, month } = period;
      // Seleccionar empleados con correo no enviados en el periodo, hasta el límite establecido
      const [unsentRows] = await pool.execute(
        `SELECT e.id FROM empleados e
         WHERE e.correo IS NOT NULL AND e.correo <> ''
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
      if (employeeIds.length === 0 && resendFlag) {
        const [sentRows] = await pool.execute(
          `SELECT e.id FROM empleados e
           JOIN kpi_emails_sent s ON e.id = s.empleado_id
           WHERE s.anio = ? AND s.mes = ?
             AND e.correo IS NOT NULL AND e.correo <> ''
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
      for (const empId of employeeIds) {
        try {
          await sendIndividualKpiResults({ employeeId: empId, year, month, force });
          sentCount++;
        } catch (err) {
          console.error(`[KPI Scheduler] Error enviando a ${empId}:`, err.message);
        }
      }
      console.log(`[KPI Scheduler] Envío automático diario completado (${force ? 'reenvío' : 'pendientes'}). Correos enviados: ${sentCount}`);
    } catch (err) {
      console.error('[KPI Scheduler] Error en ejecución:', err);
    }
  });
}

module.exports = { scheduleMonthlyEmails };