const { pool } = require('../db');
const { sendEmail } = require('./emailService');
const dashboardRoutes = require('../routes/dashboard');

// --- Compatibilidad ---
// Sin alterar el esquema de la base de datos (sin CREATE/ALTER),
// detectamos las columnas disponibles para registrar el envío de forma
// compatible con instalaciones anteriores.

// Cache de columnas detectadas para instalaciones existentes.
let __kpiEmailsSentCols = null;

async function getKpiEmailsSentColumnsSafe() {
  if (__kpiEmailsSentCols) return __kpiEmailsSentCols;
  try {
    const [cols] = await pool.execute('SHOW COLUMNS FROM kpi_emails_sent');
    __kpiEmailsSentCols = new Set((cols || []).map(c => String(c.Field || '').toLowerCase()));
    return __kpiEmailsSentCols;
  } catch (e) {
    // tabla no existe o no tenemos permisos
    __kpiEmailsSentCols = new Set();
    return __kpiEmailsSentCols;
  }
}

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
  // Detectar columnas existentes y escoger el INSERT compatible.
  const cols = await getKpiEmailsSentColumnsSafe();
  const hasBase = cols.has('empleado_id') && cols.has('anio') && cols.has('mes');
  if (!hasBase) {
    // Instalación incompatible (tabla diferente). No rompemos el flujo de envío.
    return;
  }

  // Preferir enviado_el si existe
  if (cols.has('enviado_el')) {
    try {
      await pool.execute(
        `INSERT INTO kpi_emails_sent (empleado_id, anio, mes, enviado_el)
         VALUES (?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE enviado_el = NOW()`,
        [employeeId, year, month]
      );
      return;
    } catch (err) {
      // Si aún así falla por campo/permiso, hacemos fallback abajo sin tirar el envío
      if (err && (err.code !== 'ER_BAD_FIELD_ERROR')) {
        // Para otros errores (por ejemplo, permisos), no bloqueamos el envío
        return;
      }
    }
  }

  // Fallback: tabla sin enviado_el (o no se pudo usar)
  try {
    await pool.execute(
      `INSERT INTO kpi_emails_sent (empleado_id, anio, mes)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE mes = VALUES(mes)`,
      [employeeId, year, month]
    );
  } catch (e) {
    // No bloqueamos el envío si el log no se pudo registrar.
    return;
  }
}

/**
 * Comprueba si ya se envió correo a un empleado en un periodo determinado.
 * @param {number} employeeId
 * @param {number} year
 * @param {number} month
 * @returns {Promise<boolean>} true si ya se envió
 */
async function hasSentEmail(employeeId, year, month) {
  try {
    const cols = await getKpiEmailsSentColumnsSafe();
    const hasBase = cols.has('empleado_id') && cols.has('anio') && cols.has('mes');
    if (!hasBase) return false;
    const [rows] = await pool.execute(
      `SELECT 1 FROM kpi_emails_sent WHERE empleado_id = ? AND anio = ? AND mes = ? LIMIT 1`,
      [employeeId, year, month]
    );
    return rows.length > 0;
  } catch (e) {
    // Si la tabla no existe o hay columnas distintas, asumimos no enviado
    return false;
  }
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
async function sendIndividualKpiResults({ employeeId, year, month, force = false, format = 'excel' }) {
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
  // Definir nombre base sin extensión
  const baseName = `KPIs_${emp.incidencia_id || employeeId}_${year}-${String(month).padStart(2, '0')}`;
  let attachmentFilename;
  let attachmentContent;
  let attachmentType;

  // Siempre generamos el archivo Excel en memoria
  const buffer = await built.wb.xlsx.writeBuffer();
  if (String(format || '').toLowerCase() === 'pdf') {
    // Convertir Excel a PDF utilizando LibreOffice/soffice.  En algunos entornos (p.ej. Windows)
    // el ejecutable se llama "soffice" o se encuentra en un directorio específico.  Si la
    // conversión falla intentamos múltiples comandos y, en último caso, hacemos
    // fallback a enviar el archivo Excel directamente.
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { exec } = require('child_process');
    // Crear directorio temporal
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kpi-'));
    const xlsxPath = path.join(tmpDir, baseName + '.xlsx');
    const pdfPath = path.join(tmpDir, baseName + '.pdf');
    // Guardar Excel temporalmente
    await fs.promises.writeFile(xlsxPath, Buffer.from(buffer));
    // Lista de comandos a probar dependiendo del sistema operativo
    const libreCmds = [];
    if (process.platform === 'win32') {
      // En Windows, LibreOffice suele instalar un ejecutable "soffice.exe".  Intentar distintas rutas.
      libreCmds.push('soffice');
      libreCmds.push('"C:\\Program Files\\LibreOffice\\program\\soffice.exe"');
      libreCmds.push('"C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe"');
    } else {
      // En Linux/Mac suele llamarse "libreoffice" o "soffice"
      libreCmds.push('libreoffice');
      libreCmds.push('soffice');
    }
    let converted = false;
    for (const cmd of libreCmds) {
      try {
        // Nota: se usa --headless para ejecución sin UI y --convert-to pdf
        await new Promise((resolve, reject) => {
          exec(`${cmd} --headless --convert-to pdf --outdir "${tmpDir}" "${xlsxPath}"`, (error) => {
            if (error) return reject(error);
            resolve();
          });
        });
        converted = true;
        break;
      } catch (convErr) {
        // Continúa con el siguiente comando
      }
    }
    let pdfBuffer;
    if (converted) {
      try {
        pdfBuffer = await fs.promises.readFile(pdfPath);
      } catch (readErr) {
        converted = false;
      }
    }
    // Limpiar archivos temporales
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch (e) {
      // Ignorar errores de limpieza
    }
    if (converted && pdfBuffer) {
      attachmentFilename = baseName + '.pdf';
      attachmentContent = pdfBuffer;
      attachmentType = 'application/pdf';
    } else {
      // No se pudo convertir: fallback a Excel adjunto
      attachmentFilename = baseName + '.xlsx';
      attachmentContent = buffer;
      attachmentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }
  } else {
    // Por defecto, adjuntar Excel
    attachmentFilename = baseName + '.xlsx';
    attachmentContent = buffer;
    attachmentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  // Construir contenido del correo
  const subject = `Resultados de KPIs - ${built.emp.nombre} - ${month}/${year}`;
  const html = `<p>Estimado(a) ${built.emp.nombre},</p>
    <p>Adjunto encontrarás los resultados de tus KPIs correspondientes al periodo <strong>${month}/${year}</strong>.</p>
    <p>Por favor revisa el archivo y comunícate con tu jefe directo en caso de dudas.</p>
    <hr style="border:0;border-top:1px solid #e9ecef;margin:18px 0;" />
    <p style="font-size:12px;color:#6c757d;margin:0;">
      Este mensaje fue generado por la version de prueba de KPI Manager CHC.
    </p>`;
  await sendEmail({
    to: emp.correo,
    subject,
    html,
    attachments: [
      {
        filename: attachmentFilename,
        content: attachmentContent,
        contentType: attachmentType
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
async function sendSubordinateKpiResults({ bossId, year, month, includeSent = false }) {
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
  let skipped = 0;
  for (const emp of emps) {
    try {
      const res = await sendIndividualKpiResults({ employeeId: emp.id, year, month, force: includeSent });
      if (!res.skipped) enviados++;
      else skipped++;
    } catch (e) {
      console.error(`Error al enviar correo a empleado ${emp.id}:`, e.message);
    }
  }
  return { count: enviados, skipped, includedSent: includeSent };
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
async function sendDirectSubordinateKpiResults({ bossId, year, month, includeSent = false }) {
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
  let skipped = 0;
  for (const emp of emps) {
    try {
      const res = await sendIndividualKpiResults({ employeeId: emp.id, year, month, force: includeSent });
      if (!res.skipped) enviados++;
      else skipped++;
    } catch (e) {
      console.error(`Error al enviar correo a empleado ${emp.id}:`, e.message);
    }
  }
  return { count: enviados, skipped, includedSent: includeSent };
}

module.exports = {
  sendIndividualKpiResults,
  sendSubordinateKpiResults,
  sendDirectSubordinateKpiResults,
  hasSentEmail
};