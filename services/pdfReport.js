const PDFDocument = require('pdfkit');

function monthLabel(month) {
  const months = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const m = Number(month);
  if (!Number.isFinite(m) || m < 1 || m > 12) return String(month);
  return months[m - 1];
}

function safeText(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

/**
 * Genera un PDF (buffer) a partir del workbook de Excel (sheet "KPIs").
 * Mantiene un diseño simple y consistente para que sea confiable en producción.
 *
 * @param {object} built Resultado de buildEmployeeWorkbook: { wb, emp }
 * @param {number} year
 * @param {number} month
 * @returns {Promise<Buffer>}
 */
async function buildEmployeePdfBufferFromWorkbook(built, year, month) {
  if (!built || !built.wb) throw new Error('Reporte inválido');
  const ws = built.wb.getWorksheet('KPIs');
  if (!ws) throw new Error('No se encontró la hoja KPIs');

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const chunks = [];
  doc.on('data', (d) => chunks.push(d));

  // --- Header ---
  doc.fontSize(16).text('Resultados de KPIs', { align: 'center' });
  doc.moveDown(0.4);

  const emp = built.emp || {};
  doc.fontSize(10);
  doc.text(`Empleado: ${safeText(emp.nombre)}`);
  doc.text(`No. Empleado: ${safeText(emp.incidencia_id || '')}`);
  doc.text(`Puesto: ${safeText(emp.puesto_nombre || '')}`);
  doc.text(`Departamento: ${safeText(emp.departamento_nombre || '')}`);
  doc.text(`Sucursal: ${safeText(emp.sucursal_nombre || '')}`);
  doc.text(`Periodo: ${monthLabel(month)} ${year}`);
  doc.moveDown(0.8);

  // --- Table layout ---
  const pageW = doc.page.width;
  const left = doc.page.margins.left;
  const right = pageW - doc.page.margins.right;
  const tableW = right - left;

  // Column widths (simple, readable)
  const col = {
    kpi: Math.floor(tableW * 0.42),
    obj: Math.floor(tableW * 0.16),
    res: Math.floor(tableW * 0.14),
    sem: Math.floor(tableW * 0.12),
    est: Math.floor(tableW * 0.16)
  };

  function drawHeaderRow(y) {
    doc.fontSize(9).font('Helvetica-Bold');
    doc.text('KPI', left, y, { width: col.kpi });
    doc.text('Objetivo', left + col.kpi, y, { width: col.obj });
    doc.text('Resultado', left + col.kpi + col.obj, y, { width: col.res });
    doc.text('Semáforo', left + col.kpi + col.obj + col.res, y, { width: col.sem });
    doc.text('Estado', left + col.kpi + col.obj + col.res + col.sem, y, { width: col.est });
    doc.font('Helvetica');
    doc.moveTo(left, y + 12).lineTo(right, y + 12).strokeColor('#999999').stroke();
    return y + 16;
  }

  function ensureSpace(nextHeight) {
    const bottom = doc.page.height - doc.page.margins.bottom;
    if (doc.y + nextHeight > bottom) {
      doc.addPage();
      doc.fontSize(9);
      drawHeaderRow(doc.y);
    }
  }

  // Mapear encabezados a índices
  const headerRow = ws.getRow(1);
  const headers = {};
  headerRow.eachCell((cell, colNumber) => {
    const key = String(cell.value || '').trim().toLowerCase();
    headers[key] = colNumber;
  });

  const idxKpi = headers['kpi'];
  const idxObj = headers['objetivo'];
  const idxRes = headers['resultado'];
  const idxSem = headers['semáforo'] || headers['semaforo'];
  const idxEst = headers['estado'];

  let y = drawHeaderRow(doc.y);
  doc.y = y;

  doc.fontSize(9);

  for (let r = 2; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r);
    const kpi = safeText(idxKpi ? row.getCell(idxKpi).value : '');
    const obj = safeText(idxObj ? row.getCell(idxObj).value : '');
    const res = safeText(idxRes ? row.getCell(idxRes).value : '');
    const sem = safeText(idxSem ? row.getCell(idxSem).value : '');
    const est = safeText(idxEst ? row.getCell(idxEst).value : '');

    if (!kpi && !obj && !res && !sem && !est) continue;

    // Calcular alto de fila según el texto más largo
    const hKpi = doc.heightOfString(kpi, { width: col.kpi });
    const hObj = doc.heightOfString(obj, { width: col.obj });
    const hRes = doc.heightOfString(res, { width: col.res });
    const hSem = doc.heightOfString(sem, { width: col.sem });
    const hEst = doc.heightOfString(est, { width: col.est });
    const rowH = Math.max(hKpi, hObj, hRes, hSem, hEst) + 6;

    ensureSpace(rowH + 6);

    const y0 = doc.y;
    doc.text(kpi, left, y0, { width: col.kpi });
    doc.text(obj, left + col.kpi, y0, { width: col.obj });
    doc.text(res, left + col.kpi + col.obj, y0, { width: col.res });
    doc.text(sem, left + col.kpi + col.obj + col.res, y0, { width: col.sem });
    doc.text(est, left + col.kpi + col.obj + col.res + col.sem, y0, { width: col.est });
    doc.y = y0 + rowH;

    // línea separadora
    doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor('#E0E0E0').stroke();
    doc.moveDown(0.1);
  }

  doc.moveDown(0.8);
  doc.fontSize(8).fillColor('#666666');
  doc.text('Documento generado por KPI Manager CHC.', { align: 'left' });

  doc.end();

  await new Promise((resolve) => doc.on('end', resolve));
  return Buffer.concat(chunks);
}

module.exports = {
  buildEmployeePdfBufferFromWorkbook,
  monthLabel
};
