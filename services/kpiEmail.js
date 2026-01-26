const { pool } = require('../db');
const { sendEmail } = require('./emailService');
const dashboardRoutes = require('../routes/dashboard');

/*
 * Servicio de notificación de resultados de KPIs por correo electrónico.
 * Proporciona funciones para enviar los resultados de un empleado
 * individualmente o a todo el equipo subordinado de un jefe.
 * También registra en la base de datos cuándo se enviaron los
 * correos para evitar reenvíos innecesarios.  Se basa en los
 * utilitarios de exportación existentes en routes/dashboard.js.
 */

/**
 * Obtiene la información básica de un empleado, incluyendo su correo.
 * @param {number} employeeId Identificador del empleado.
 * @returns {Promise<Object|null>} Objeto con email, nombre e incidencia_id.
 */
async function fetchEmployeeEmailInfo(employeeId) {
  const [rows] = await pool.execute(
    `SELECT id, incidencia_id, nombre, correo
     FROM empleados
     WHERE id = ?
     LIMIT 1`,
    [employeeId]
  );
  if (!rows.length) return null;
  return rows[0];
}

/**
 * Registra que ya se envió un correo de resultados para un empleado en un periodo.
 * Utiliza un INSERT con clave compuesta para evitar duplicados.
 * @param {number} employeeId
 * @param {number} year
 * @param {number} month
 */
async function markEmailSent(employeeId, year, month) {
  await pool.execute(
    `INSERT INTO kpi_emails_sent (empleado_id, anio, mes, enviado_el)
     VALUES (?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE enviado_el = NOW()`,
    [employeeId, year, month]
  );
}

/**
 * Comprueba si ya se envió correo a un empleado en un periodo determinado.
 * @param {number} employeeId
 * @param {number} year
 * @param {number} month
 * @returns {Promise<boolean>} true si ya se envió
 */
async function hasSentEmail(employeeId, year, month) {
  const [rows] = await pool.execute(
    `SELECT 1 FROM kpi_emails_sent WHERE empleado_id = ? AND anio = ? AND mes = ? LIMIT 1`,
    [employeeId, year, month]
  );
  return rows.length > 0;
}

/**
 * Envía los resultados de KPIs de un empleado (por periodo) a su propio correo.
 * Genera el archivo Excel en memoria y lo adjunta al correo.
 * @param {Object} param0
 * @param {number} param0.employeeId Id del empleado.
 * @param {number} param0.year Año del periodo a enviar.
 * @param {number} param0.month Mes del periodo a enviar (1-12).
 */
/**
 * Envía los resultados de KPIs de un empleado (por periodo) a su propio correo.
 * Si `force` es verdadero, se ignorará la comprobación de envío previo y
 * se reenviará aunque ya exista un registro en kpi_emails_sent.
 *
 * @param {Object} param0
 * @param {number} param0.employeeId Id del empleado.
 * @param {number} param0.year Año del periodo a enviar.
 * @param {number} param0.month Mes del periodo a enviar (1-12).
 * @param {boolean} [param0.force=false] Forzar el reenvío incluso si ya se envió.
 */
async function sendIndividualKpiResults({ employeeId, year, month, force = false }) {
  // Obtener info y correo
  const emp = await fetchEmployeeEmailInfo(employeeId);
  if (!emp || !emp.correo) {
    throw new Error('El empleado no tiene correo registrado');
  }
  // Comprobar si ya se envió en este periodo, a menos que sea forzado
  if (!force && await hasSentEmail(employeeId, year, month)) {
    return { skipped: true };
  }
  // Generar workbook para el empleado
  // Las funciones buildEmployeeWorkbook están anexadas al router
  const buildFn = dashboardRoutes.buildEmployeeWorkbook || dashboardRoutes.router?.buildEmployeeWorkbook;
  if (!buildFn) {
    throw new Error('No se pudo importar la función de generación de reporte');
  }
  const built = await buildFn({ employeeId, year, month, mode: 'period' });
  if (!built) {
    throw new Error('No se pudieron generar los KPIs del empleado');
  }
  const fileName = `KPIs_${emp.incidencia_id || employeeId}_${year}-${String(month).padStart(2, '0')}.xlsx`;
  const buffer = await built.wb.xlsx.writeBuffer();
  // Construir contenido del correo
  const subject = `Resultados de KPIs - ${built.emp.nombre} - ${month}/${year}`;
  const html = `<p>Estimado(a) ${built.emp.nombre},</p>
    <p>Adjunto encontrarás los resultados de tus KPIs correspondientes al periodo <strong>${month}/${year}</strong>.</p>
    <p>Por favor revisa el archivo y comunícate con tu jefe directo en caso de dudas.</p>
    <p>Este correo es generado automáticamente por el sistema KPI Manager CHC.</p>`;
  await sendEmail({
    to: emp.correo,
    subject,
    html,
    attachments: [
      {
        filename: fileName,
        content: buffer,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      }
    ]
  });
  // Marcar como enviado
  await markEmailSent(employeeId, year, month);
  return { skipped: false };
}

/**
 * Envía los KPIs de todos los subordinados de un jefe o manager.  Utiliza la
 * relación jerárquica de puestos para determinar la lista de empleados.
 * @param {Object} param0
 * @param {number} param0.bossId Id del jefe (empleado que solicita el envío).
 * @param {number} param0.year Año del periodo.
 * @param {number} param0.month Mes del periodo.
 */
async function sendSubordinateKpiResults({ bossId, year, month }) {
  // Obtener el puesto del jefe
  const [bossRows] = await pool.execute(
    `SELECT puesto_id FROM empleados WHERE id = ? LIMIT 1`,
    [bossId]
  );
  if (!bossRows.length) {
    throw new Error('Jefe no encontrado');
  }
  const bossPuestoId = bossRows[0].puesto_id;
  // Cargar todas las relaciones de puestos
  const [puestos] = await pool.execute('SELECT id, responde_a_id FROM puestos');
  // Usar función del dashboard para construir la lista de puestos subordinados
  const buildSubs = dashboardRoutes.buildSubordinatePuestoIds || dashboardRoutes.router?.buildSubordinatePuestoIds;
  if (!buildSubs) {
    throw new Error('No se pudo importar la función de puestos subordinados');
  }
  const puestosSubordinados = buildSubs(bossPuestoId, puestos);
  if (!puestosSubordinados.length) {
    return { count: 0 };
  }
  // Buscar empleados que ocupan esos puestos
  const placeholders = puestosSubordinados.map(() => '?').join(',');
  const [emps] = await pool.execute(
    `SELECT id FROM empleados WHERE puesto_id IN (${placeholders})`,
    puestosSubordinados
  );
  let enviados = 0;
  for (const emp of emps) {
    try {
      const res = await sendIndividualKpiResults({ employeeId: emp.id, year, month });
      if (!res.skipped) enviados++;
    } catch (e) {
      console.error(`Error al enviar correo a empleado ${emp.id}:`, e.message);
    }
  }
  return { count: enviados };
}

/**
 * Envía los KPIs de los subordinados directos de un jefe.  A diferencia de
 * sendSubordinateKpiResults que envía a todo el árbol jerárquico, esta
 * función sólo envía a aquellos empleados cuyo puesto responde
 * directamente al puesto del jefe.  Si no existen subordinados
 * directos se devuelve count = 0 sin error.  Se comparten las
 * mismas reglas de marcaje de envío para evitar duplicados.
 *
 * @param {Object} param0
 * @param {number} param0.bossId Id del jefe (empleado que solicita el envío).
 * @param {number} param0.year Año del periodo a enviar.
 * @param {number} param0.month Mes del periodo a enviar (1-12).
 */
async function sendDirectSubordinateKpiResults({ bossId, year, month }) {
  // Obtener el puesto del jefe
  const [bossRows] = await pool.execute(
    `SELECT puesto_id FROM empleados WHERE id = ? LIMIT 1`,
    [bossId]
  );
  if (!bossRows.length) {
    throw new Error('Jefe no encontrado');
  }
  const bossPuestoId = bossRows[0].puesto_id;
  // Obtener puestos que dependen directamente del puesto del jefe
  const [directPuestos] = await pool.execute(
    `SELECT id FROM puestos WHERE responde_a_id = ?`,
    [bossPuestoId]
  );
  const puestosDirectos = directPuestos.map(r => r.id);
  if (!puestosDirectos.length) {
    return { count: 0 };
  }
  // Buscar empleados que ocupan esos puestos directos
  const placeholders = puestosDirectos.map(() => '?').join(',');
  const [emps] = await pool.execute(
    `SELECT id FROM empleados WHERE puesto_id IN (${placeholders})`,
    puestosDirectos
  );
  let enviados = 0;
  for (const emp of emps) {
    try {
      const res = await sendIndividualKpiResults({ employeeId: emp.id, year, month });
      if (!res.skipped) enviados++;
    } catch (e) {
      console.error(`Error al enviar correo a empleado ${emp.id}:`, e.message);
    }
  }
  return { count: enviados };
}

module.exports = {
  sendIndividualKpiResults,
  sendSubordinateKpiResults,
  sendDirectSubordinateKpiResults,
  hasSentEmail
};