const { pool } = require('../db');
const { sendEmail } = require('./emailService');
const dashboardRoutes = require('../routes/dashboard');
const path = require('path');

// Intentar cargar PDFKit para generación de reportes en PDF.  Si no está
// disponible (por ejemplo, porque no se instaló la dependencia), el
// valor PDFDocument quedará en null y el servicio enviará el reporte
// en formato Excel de forma predeterminada.
let PDFDocument;
try {
  // eslint-disable-next-line global-require
  PDFDocument = require('pdfkit');
} catch (e) {
  PDFDocument = null;
}

/**
 * Convierte el primer worksheet de un workbook de ExcelJS en un PDF
 * utilizando PDFKit.  Cada fila se representa como una línea de texto
 * separando las celdas con tabuladores.  El título se incluye al inicio
 * del documento.  En caso de que haya un error, la promesa será
 * rechazada.
 *
 * @param {Object} workbook Workbook generado por exceljs
 * @param {string} title Título que se muestra en el PDF
 * @returns {Promise<Buffer>} Buffer con el PDF generado
 */
async function workbookToPdfBuffer(workbook, title = '') {
  return new Promise((resolve, reject) => {
    try {
      // Crear documento con orientación horizontal (landscape) para que las columnas
      // tengan más espacio. Esto mejora la legibilidad del reporte al permitir
      // distribuir los datos a lo ancho de la página.
      const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
      doc.on('error', (err) => reject(err));

      // Usar una fuente Unicode embebida para evitar caracteres raros (acentos, ñ, etc.)
      // y problemas típicos de codificación (p.ej. espacios no separables \u00A0).
      try {
        const fontPath = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans.ttf');
        doc.font(fontPath);
      } catch (e) {
        // Si no se puede cargar la fuente, PDFKit usará una fuente default.
      }

      // Título
      if (title) {
        doc.fontSize(16).text(title, { align: 'center' });
        doc.moveDown();
      }

      // Obtener el primer worksheet
      let worksheet;
      if (Array.isArray(workbook.worksheets) && workbook.worksheets.length) {
        worksheet = workbook.worksheets[0];
      } else if (typeof workbook.getWorksheet === 'function') {
        worksheet = workbook.getWorksheet(1);
      }
      if (!worksheet) {
        throw new Error('No se pudo obtener la hoja de cálculo para el PDF');
      }

      // Configurar fuente y tamaño por defecto para filas
      doc.fontSize(9);

      // Sanitizador: quita caracteres de control, reemplaza NBSP por espacio normal,
      // colapsa espacios y elimina tabuladores y saltos que podrían romper el layout.
      const sanitize = (s) => String(s ?? '')
        .replace(/\u00A0/g, ' ') // NBSP por espacio normal
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ') // caracteres de control
        .replace(/[\t\r\n]+/g, ' ') // tabuladores y saltos
        .replace(/\s+/g, ' ') // colapsar múltiples espacios
        .trim();

      // Construir una matriz de filas con valores sanitizados.
      const rows = [];
      worksheet.eachRow((row) => {
        const rowValues = Array.isArray(row.values) ? row.values.slice(1) : [];
        const values = [];
        rowValues.forEach((v) => {
          let cellVal = '';
          if (v == null) {
            cellVal = '';
          } else if (typeof v === 'object') {
            if (v.richText && Array.isArray(v.richText)) {
              cellVal = v.richText.map((rt) => rt.text).join('');
            } else if (v.text != null) {
              cellVal = String(v.text);
            } else if (v.result != null) {
              cellVal = String(v.result);
            } else if (v.formula != null) {
              cellVal = String(v.formula);
            } else {
              cellVal = String(v);
            }
          } else if (v instanceof Date) {
            cellVal = v.toLocaleDateString('es-MX');
          } else {
            cellVal = String(v);
          }
          values.push(sanitize(cellVal));
        });
        // Guardar todas las filas, incluso vacías, para mantener la estructura de columnas.
        rows.push(values);
      });

      // Hacer una copia de las filas antes de eliminar columnas para poder extraer
      // información del empleado (id, nombre, puesto, departamento, sucursal).
      const originalRows = rows.map(r => r.slice());
      // Identificar índices de columnas en la fila de encabezado (normalizadas)
      const headerNorm = originalRows.length ? originalRows[0].map((h) => h.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')) : [];
      let empIdIdx = headerNorm.findIndex(h => h.includes('no') && h.includes('emple'));
      let nombreIdx = headerNorm.findIndex(h => h.includes('nombre'));
      let puestoIdx = headerNorm.findIndex(h => h.includes('puesto'));
      let deptoIdx = headerNorm.findIndex(h => h.includes('depart'));
      let sucursalIdx = headerNorm.findIndex(h => h.includes('sucur'));
      // Extraer datos del empleado a partir de la primera fila de datos (segunda fila, índice 1)
      const employeeInfo = { id: '', nombre: '', puesto: '', depto: '', sucursal: '' };
      if (originalRows.length > 1) {
        const firstData = originalRows[1];
        if (empIdIdx >= 0) employeeInfo.id = firstData[empIdIdx] || '';
        if (nombreIdx >= 0) employeeInfo.nombre = firstData[nombreIdx] || '';
        if (puestoIdx >= 0) employeeInfo.puesto = firstData[puestoIdx] || '';
        if (deptoIdx >= 0) employeeInfo.depto = firstData[deptoIdx] || '';
        if (sucursalIdx >= 0) employeeInfo.sucursal = firstData[sucursalIdx] || '';
      }
      // Extraer columnas de resumen (fortalezas, áreas de oportunidad, compromisos) y
      // la columna de comentarios para suprimirlas del cuerpo de la tabla.  Estas
      // columnas se presentan al final del PDF en una tabla separada.  También
      // detectamos columnas de "en revisión por" y "fecha de aprobación".
      const summary = { fortalezas: '', areasOport: '', compromisos: '' };
      // Identificar índices de columnas de fortalezas, áreas de oportunidad y compromisos
      const fortalezasIdx = headerNorm.findIndex(h => h.includes('fortalez'));
      const areasIdx = headerNorm.findIndex(h => (h.includes('area') && h.includes('oportun')) || h.includes('oportunidad'));
      const compromisosIdx = headerNorm.findIndex(h => h.includes('comprom'));
      // Identificar índice de comentarios
      const comentarioIdx = headerNorm.findIndex(h => h.includes('comentario'));

      // Extraer valores de resumen de la primera fila de datos (segunda fila de la hoja)
      if (originalRows.length > 1) {
        const firstDataRow = originalRows[1];
        if (fortalezasIdx >= 0) summary.fortalezas = sanitize(firstDataRow[fortalezasIdx] || '');
        if (areasIdx >= 0) summary.areasOport = sanitize(firstDataRow[areasIdx] || '');
        if (compromisosIdx >= 0) summary.compromisos = sanitize(firstDataRow[compromisosIdx] || '');
      }
      // Determinar índices de columnas que se eliminarán para el reporte
      const columnsToRemove = [];
      headerNorm.forEach((col, idx) => {
        const normalized = col.replace(/\s+/g, '');
        // Remover columnas informativas que no se mostrarán en la tabla (se mostrarán arriba)
        if (idx === empIdIdx || idx === nombreIdx || idx === puestoIdx || idx === deptoIdx || idx === sucursalIdx) {
          columnsToRemove.push(idx);
          return;
        }
        // Remover columnas de resumen para presentarlas aparte
        if (idx === fortalezasIdx || idx === areasIdx || idx === compromisosIdx) {
          columnsToRemove.push(idx);
          return;
        }
        // Remover columnas específicas solicitadas
        const patterns = [
          'unidad', 'puntajebase', 'peso', 'estado', 'aprobadapor',
          'fechaaprobacion', 'fechadeaprobacion',
          'motivorevision', 'motivorevisión',
          'revisionpor', 'enrevisionpor', 'enrevision'
        ];
        for (const pat of patterns) {
          if (normalized.includes(pat)) {
            columnsToRemove.push(idx);
            return;
          }
        }
        // Remover cualquier columna después de "comentario" para dejar solo
        // hasta comentarios.  Si comentario no existe, no aplica.
        if (comentarioIdx >= 0 && idx > comentarioIdx) {
          columnsToRemove.push(idx);
          return;
        }
      });
      // Filtrar columnas para cada fila
      if (columnsToRemove.length > 0) {
        for (let i = 0; i < rows.length; i++) {
          rows[i] = rows[i].filter((_, idx) => !columnsToRemove.includes(idx));
        }
      }
      // Imprimir la información del empleado antes de la tabla (una sola vez)
      if (employeeInfo.nombre || employeeInfo.id) {
        // Ajustar fuente para la sección de encabezado del empleado
        doc.fontSize(11);
        const line1 = [];
        if (employeeInfo.nombre) line1.push(employeeInfo.nombre);
        if (employeeInfo.id) line1.push(`ID: ${employeeInfo.id}`);
        if (line1.length) {
          doc.text(`Empleado: ${line1.join(' - ')}`, { align: 'left' });
        }
        const line2 = [];
        if (employeeInfo.puesto) line2.push(`Puesto: ${employeeInfo.puesto}`);
        if (employeeInfo.depto) line2.push(`Departamento: ${employeeInfo.depto}`);
        if (employeeInfo.sucursal) line2.push(`Sucursal: ${employeeInfo.sucursal}`);
        if (line2.length) {
          doc.text(line2.join('   '), { align: 'left' });
        }
        // Añadir un espacio en blanco después del encabezado del empleado
        doc.moveDown();
        // Restablecer tamaño de fuente para la tabla
        doc.fontSize(9);
      }

      // Determinar el número máximo de columnas observadas
      const colCount = rows.reduce((max, vals) => Math.max(max, vals.length), 0);

      // Asegurarse de que cada fila tenga el mismo número de columnas
      rows.forEach((vals) => {
        while (vals.length < colCount) {
          vals.push('');
        }
      });

      // Calcular ancho disponible para la tabla en la página
      const marginLeft = doc.page.margins.left;
      const marginRight = doc.page.margins.right;
      const availableWidth = doc.page.width - marginLeft - marginRight;

      // Estimar anchos de columna. Se asigna un ancho mínimo y se aumenta en función
      // del contenido observado hasta un máximo razonable. Luego se escala al
      // ancho disponible.
      const minColWidth = 40; // en puntos (~0.56 cm)
      const maxColWidth = 200;
      const colWidths = new Array(colCount).fill(minColWidth);

      // Usar las primeras 20 filas (o todas si hay menos) para estimar anchos
      const rowsToInspect = Math.min(rows.length, 20);
      for (let i = 0; i < rowsToInspect; i++) {
        const vals = rows[i];
        vals.forEach((val, idx) => {
          const widthNeeded = doc.widthOfString(val) + 10;
          if (widthNeeded > colWidths[idx]) {
            colWidths[idx] = Math.min(widthNeeded, maxColWidth);
          }
        });
      }

      // Calcular suma actual y escalar si excede el ancho disponible
      let totalWidth = colWidths.reduce((a, b) => a + b, 0);
      if (totalWidth > availableWidth) {
        const scale = availableWidth / totalWidth;
        for (let i = 0; i < colWidths.length; i++) {
          colWidths[i] = colWidths[i] * scale;
        }
        totalWidth = availableWidth;
      }
      // Si aún sobra espacio, distribuirlo proporcionalmente a los anchos
      if (totalWidth < availableWidth) {
        const extra = availableWidth - totalWidth;
        const perColExtra = extra / colCount;
        for (let i = 0; i < colCount; i++) {
          colWidths[i] += perColExtra;
        }
      }

      // Precalcular posiciones X para cada columna
      const xPositions = [];
      xPositions[0] = marginLeft;
      for (let i = 1; i < colCount; i++) {
        xPositions[i] = xPositions[i - 1] + colWidths[i - 1];
      }

      // Coordenada Y inicial
      let y = doc.y;
      const maxY = doc.page.height - doc.page.margins.bottom;
      const rowGap = 2; // espacio entre filas

      // Identificar índices de las columnas de 'resultado' y 'semáforo' (ignorando acentos)
      let resultadoIndex = -1;
      let semaforoIndex = -1;
      if (rows.length > 0) {
        const headerLower = rows[0].map((h) => {
          // Normalizar eliminando tildes y acentos, usando combinación de Unicode
          const norm = h.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          return norm;
        });
        resultadoIndex = headerLower.findIndex((h) => h.includes('resultado'));
        semaforoIndex = headerLower.findIndex((h) => h.includes('semaforo'));
      }
      // Definir colores para semáforo
      const colorMap = {
        verde: '#C6EFCE',    // verde claro
        amarillo: '#FFF2CC', // amarillo claro
        rojo: '#F8CBAD',     // rojo claro
        naranja: '#FCE4D6',
      };
      const headerBg = '#D9D9D9';
      const cellPaddingX = 3;
      const cellPaddingY = 2;

      // Recorrer cada fila con índice
      rows.forEach((vals, rowIndex) => {
        // Calcular la altura de la fila: mayor altura de sus celdas con el ancho asignado.
        let rowHeight = 0;
        vals.forEach((val, idx) => {
          const h = doc.heightOfString(val, { width: colWidths[idx] - 2 * cellPaddingX });
          if (h > rowHeight) rowHeight = h;
        });
        // Salto de página si no cabe la fila completa
        if (y + rowHeight + 2 * cellPaddingY > maxY) {
          doc.addPage();
          try {
            const fontPath = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans.ttf');
            doc.font(fontPath);
          } catch (e) {}
          doc.fontSize(9);
          y = doc.y;
        }
        // Determinar color base de semáforo para esta fila (para filas de datos)
        let rowColor = null;
        if (rowIndex > 0 && semaforoIndex >= 0) {
          const semVal = (vals[semaforoIndex] || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          if (semVal.includes('verde')) rowColor = colorMap.verde;
          else if (semVal.includes('amar')) rowColor = colorMap.amarillo;
          else if (semVal.includes('rojo')) rowColor = colorMap.rojo;
          else if (semVal.includes('nara')) rowColor = colorMap.naranja;
        }
        // Dibujar cada celda con fondo y borde
        vals.forEach((val, idx) => {
          // Escoger color de fondo
          let bgColor = '#FFFFFF';
          if (rowIndex === 0) {
            bgColor = headerBg;
          } else if (idx === resultadoIndex || idx === semaforoIndex) {
            bgColor = rowColor || '#FFFFFF';
          }
          // Dibujar fondo
          doc.save();
          doc.rect(xPositions[idx], y, colWidths[idx], rowHeight + 2 * cellPaddingY)
            .fill(bgColor);
          // Dibujar borde
          doc.lineWidth(0.5).strokeColor('#000000')
            .rect(xPositions[idx], y, colWidths[idx], rowHeight + 2 * cellPaddingY)
            .stroke();
          // Dibujar texto
          doc.fillColor('#000000');
          doc.text(val, xPositions[idx] + cellPaddingX, y + cellPaddingY, {
            width: colWidths[idx] - 2 * cellPaddingX,
            height: rowHeight,
            align: 'left',
          });
          doc.restore();
        });
        // Mover Y hacia abajo para la siguiente fila
        y += rowHeight + 2 * cellPaddingY + rowGap;
      });

      // ------------------------ TABLA DE RESUMEN ------------------------
      // Si existen fortalezas, áreas de oportunidad o compromisos, dibujar
      // una tabla de resumen al final.  Se omite si todas las celdas están vacías.
      const hasSummaryContent = (summary.fortalezas || summary.areasOport || summary.compromisos);
      if (hasSummaryContent) {
        // Crear cabeceras y valores
        const summaryHeaders = ['Fortalezas', 'Áreas de oportunidad', 'Compromisos'];
        const summaryValues = [summary.fortalezas, summary.areasOport, summary.compromisos];
        const summaryColCount = summaryHeaders.length;
        // Anchos para tabla de resumen: distribuir el ancho disponible equitativamente
        const summaryColWidths = new Array(summaryColCount).fill(availableWidth / summaryColCount);
        const summaryXPos = [];
        summaryXPos[0] = marginLeft;
        for (let i = 1; i < summaryColCount; i++) {
          summaryXPos[i] = summaryXPos[i - 1] + summaryColWidths[i - 1];
        }
        // Ajustar fuente
        doc.fontSize(9);
        // Recorrer dos filas: encabezado y valores
        const summaryRows = [summaryHeaders, summaryValues];
        summaryRows.forEach((vals, rowIndex) => {
          // Calcular altura de fila
          let rowHeight = 0;
          vals.forEach((val, idx) => {
            const h = doc.heightOfString(val || '', { width: summaryColWidths[idx] - 2 * cellPaddingX });
            if (h > rowHeight) rowHeight = h;
          });
          // Verificar salto de página
          if (y + rowHeight + 2 * cellPaddingY > maxY) {
            doc.addPage();
            try {
              const fontPath = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans.ttf');
              doc.font(fontPath);
            } catch (e) {}
            doc.fontSize(9);
            y = doc.y;
          }
          // Dibujar celdas
          vals.forEach((val, idx) => {
            const bgColor = rowIndex === 0 ? headerBg : '#FFFFFF';
            doc.save();
            doc.rect(summaryXPos[idx], y, summaryColWidths[idx], rowHeight + 2 * cellPaddingY)
              .fill(bgColor);
            doc.lineWidth(0.5).strokeColor('#000000')
              .rect(summaryXPos[idx], y, summaryColWidths[idx], rowHeight + 2 * cellPaddingY)
              .stroke();
            doc.fillColor('#000000');
            doc.text(val || '', summaryXPos[idx] + cellPaddingX, y + cellPaddingY, {
              width: summaryColWidths[idx] - 2 * cellPaddingX,
              height: rowHeight,
              align: 'left'
            });
            doc.restore();
          });
          // Incrementar Y
          y += rowHeight + 2 * cellPaddingY + rowGap;
        });
      }

      // ------------------------ FOOTER ------------------------
      // Agregar pie de página con fecha de generación y nombre del sistema.
      try {
        const now = new Date();
        const dateStr = new Intl.DateTimeFormat('es-MX', {
          timeZone: 'America/Mexico_City',
          year: 'numeric', month: 'long', day: 'numeric'
        }).format(now);
        const footerText = `Reporte generado por KPI MANAGER CHC - ${dateStr}`;
        // Calcular altura del footer
        const footerHeight = doc.heightOfString(footerText, { width: availableWidth });
        if (y + footerHeight + 5 > maxY) {
          doc.addPage();
          try {
            const fontPath = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans.ttf');
            doc.font(fontPath);
          } catch (e) {}
          doc.fontSize(9);
          y = doc.y;
        }
        // Dibujar texto centrado
        doc.fillColor('#000000');
        doc.text(footerText, marginLeft, y, {
          width: availableWidth,
          align: 'center'
        });
        y += footerHeight + rowGap;
      } catch (e) {
        // Si falla formateo de fecha, no bloqueamos la generación
      }

      // Finalizar documento
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

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
  if (String(format || '').toLowerCase() === 'pdf' && false /* LibreOffice conversion deshabilitado */) {
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
      const res = await module.exports.sendIndividualKpiResults({ employeeId: emp.id, year, month, force: includeSent });
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
      // Utilizar la función exportada (posiblemente reemplazada) para el envío individual
      const res = await module.exports.sendIndividualKpiResults({ employeeId: emp.id, year, month, force: includeSent });
      if (!res.skipped) enviados++;
      else skipped++;
    } catch (e) {
      console.error(`Error al enviar correo a empleado ${emp.id}:`, e.message);
    }
  }
  return { count: enviados, skipped, includedSent: includeSent };
}

/**
 * Implementación alternativa de envío de resultados de KPIs que utiliza PDFKit en lugar de
 * LibreOffice para generar archivos PDF.  Se ajusta a la misma firma que la
 * función original `sendIndividualKpiResults` pero omite por completo la
 * conversión mediante LibreOffice.  Si se solicita PDF y PDFKit no está
 * disponible, adjunta el archivo Excel.
 *
 * @param {Object} param0
 * @param {number} param0.employeeId Id del empleado.
 * @param {number} param0.year Año del periodo a enviar.
 * @param {number} param0.month Mes del periodo a enviar (1-12).
 * @param {boolean} [param0.force=false] Forzar el reenvío incluso si ya se envió.
 * @param {string} [param0.format='excel'] Formato deseado ('excel' o 'pdf').
 */
async function sendIndividualKpiResultsWithPdf({ employeeId, year, month, force = false, format = 'excel' }) {
  // Obtener información del empleado y su correo
  const emp = await fetchEmployeeEmailInfo(employeeId);
  if (!emp || !emp.correo) {
    throw new Error('El empleado no tiene correo registrado');
  }
  // Comprobar si ya se envió en este periodo, a menos que sea forzado
  if (!force && await hasSentEmail(employeeId, year, month)) {
    return { skipped: true };
  }
  // Generar workbook para el empleado
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
  // Generar el Excel en memoria
  const buffer = await built.wb.xlsx.writeBuffer();
  const desiredFormat = String(format || '').toLowerCase();
  if (desiredFormat === 'pdf' && PDFDocument) {
    // Intentar convertir a PDF usando PDFKit
    try {
      const pdfBuffer = await workbookToPdfBuffer(built.wb, baseName);
      attachmentFilename = baseName + '.pdf';
      attachmentContent = pdfBuffer;
      attachmentType = 'application/pdf';
    } catch (err) {
      // Fallback a Excel si la generación falla
      attachmentFilename = baseName + '.xlsx';
      attachmentContent = buffer;
      attachmentType = 'application/vnd.openxmlformats-officedocument-spreadsheetml.sheet';
    }
  } else {
    // Por defecto o si PDFKit no está disponible, adjuntar Excel
    attachmentFilename = baseName + '.xlsx';
    attachmentContent = buffer;
    attachmentType = 'application/vnd.openxmlformats-officedocument-spreadsheetml.sheet';
  }
  // Construir contenido del correo
  const subject = `Resultados de KPIs - ${built.emp.nombre} - ${month}/${year}`;
  const html = `<p>Estimado(a) ${built.emp.nombre},</p>
    <p>Adjunto encontrarás los resultados de tus KPIs correspondientes al periodo <strong>${month}/${year}</strong>.</p>
    <p>Por favor revisa el archivo y comunícate con tu jefe directo en caso de dudas.</p>
    <hr style="border:0;border-top:1px solid #e9ecef;margin:18px 0;" />
    <p style="font-size:12px;color:#6c757d;margin:0;">
      Este mensaje fue generado por la versión de prueba de KPI Manager CHC.
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

module.exports = {
  // Reemplazamos la función de envío individual por la versión con soporte PDFKit
  sendIndividualKpiResults: sendIndividualKpiResultsWithPdf,
  sendSubordinateKpiResults,
  sendDirectSubordinateKpiResults,
  hasSentEmail
};