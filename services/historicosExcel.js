const ExcelJS = require('exceljs');
const crypto = require('crypto');

const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const MAX_ROWS = 50000;
const EQUIPO_HEADERS = [
  'No. Empleado','Empleado','Puesto','Departamento','Sucursal','Año','Mes','KPI','Objetivo','Unidad',
  'Resultado','Semáforo','Puntaje base','Peso (%)','Puntaje ponderado','Estado','Aprobado por','Fecha aprobación',
  'En revisión por','Fecha revisión','Motivo revisión','Comentario KPI','Fortalezas','Áreas de oportunidad','Compromisos'
];
const FEEDBACK_HEADERS = ['No. Empleado','Empleado','Año','Mes','Fortalezas','Áreas de oportunidad','Compromisos'];

function clean(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (Object.prototype.hasOwnProperty.call(v, 'result')) return clean(v.result);
    if (Object.prototype.hasOwnProperty.call(v, 'text')) return clean(v.text);
    if (Array.isArray(v.richText)) return v.richText.map(x => x.text || '').join('').trim() || null;
  }
  const s = String(v).trim();
  return s === '' ? null : s;
}
function textValue(v) {
  const c = clean(v);
  if (c === null) return null;
  if (c instanceof Date) return c.toISOString();
  return String(c);
}
function numberOrNull(v) {
  const c = clean(v);
  if (c === null) return null;
  if (typeof c === 'number') return Number.isFinite(c) ? c : null;
  const n = Number(String(c).replace('%','').replace(',','.'));
  return Number.isFinite(n) ? n : null;
}
function normalizeKey(v) {
  return String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
}
function monthToNumber(v) {
  const c = clean(v);
  if (c === null) return null;
  const n = Number(c);
  if (Number.isInteger(n) && n >= 1 && n <= 12) return n;
  const idx = MONTHS.map(normalizeKey).indexOf(normalizeKey(c));
  return idx >= 0 ? idx + 1 : null;
}
function excelDate(v) {
  const c = clean(v);
  if (c === null) return null;
  if (c instanceof Date && !Number.isNaN(c.getTime())) return c;
  if (typeof c === 'number' && c > 0) {
    const d = new Date(Math.round((c - 25569) * 86400 * 1000));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(c);
  return Number.isNaN(d.getTime()) ? null : d;
}
function hashBuffer(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function rowHasData(row, maxCol) {
  for (let i = 1; i <= maxCol; i++) if (clean(row.getCell(i).value) !== null) return true;
  return false;
}
function getHeaderMap(ws) {
  const m = new Map();
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => m.set(normalizeKey(cell.value), col));
  return m;
}
function valuesByHeaders(row, map, headers) {
  const out = {};
  for (const h of headers) out[h] = map.has(normalizeKey(h)) ? row.getCell(map.get(normalizeKey(h))).value : null;
  return out;
}
function compareFeedback(a, b) {
  return ['fortalezas','areas_oportunidad','compromisos'].filter(k => {
    const av = normalizeKey(a[k]); const bv = normalizeKey(b[k]);
    return av && bv && av !== bv;
  });
}

async function parseHistoricalWorkbook(buffer, filename = 'archivo.xlsx') {
  const errors = [], warnings = [];
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer); }
  catch (e) { return { valid: false, errors: ['El workbook está corrupto o no es un .xlsx válido.'], warnings, filename, sha256: hashBuffer(buffer) }; }

  const equipo = workbook.getWorksheet('Equipo');
  if (!equipo) return { valid: false, errors: ['No existe la hoja Equipo.'], warnings, filename, sha256: hashBuffer(buffer) };
  const map = getHeaderMap(equipo);
  const missing = EQUIPO_HEADERS.filter(h => !map.has(normalizeKey(h)));
  if (missing.length) errors.push(`Faltan columnas esenciales en Equipo: ${missing.join(', ')}.`);
  if (errors.length) return { valid: false, errors, warnings, filename, sha256: hashBuffer(buffer) };

  const rows = [], periods = new Set(), duplicates = new Set(), seen = new Set(), employeeSet = new Set();
  const feedbackFromEquipo = new Map();
  const weightByEmployee = new Map();
  const states = new Map(), colors = new Map();
  let captured = 0;
  for (let r = 2; r <= equipo.rowCount; r++) {
    const row = equipo.getRow(r);
    if (!rowHasData(row, EQUIPO_HEADERS.length)) continue;
    if (rows.length >= MAX_ROWS) { errors.push(`El archivo supera el límite de ${MAX_ROWS.toLocaleString()} filas.`); break; }
    const v = valuesByHeaders(row, map, EQUIPO_HEADERS);
    const year = Number(clean(v['Año']));
    const month = monthToNumber(v['Mes']);
    const noEmpleado = textValue(v['No. Empleado']);
    const kpi = textValue(v['KPI']);
    if (!Number.isInteger(year) || year < 2000 || year > 2100 || !month) errors.push(`Fila ${r}: año o mes inválido.`);
    periods.add(`${year}|${month}`);
    const dupKey = `${normalizeKey(noEmpleado)}|${normalizeKey(kpi)}|${year}|${month}`;
    if (seen.has(dupKey)) duplicates.add(dupKey); else seen.add(dupKey);
    if (noEmpleado) employeeSet.add(noEmpleado);
    const result = textValue(v['Resultado']);
    if (result !== null) captured++;
    const estado = textValue(v['Estado']); if (estado) states.set(estado, (states.get(estado)||0)+1);
    const semaforo = textValue(v['Semáforo']); if (semaforo) colors.set(semaforo, (colors.get(semaforo)||0)+1);
    const peso = numberOrNull(v['Peso (%)']);
    if (noEmpleado && peso !== null) weightByEmployee.set(noEmpleado, (weightByEmployee.get(noEmpleado)||0)+peso);
    const eqFb = { fortalezas:textValue(v['Fortalezas']), areas_oportunidad:textValue(v['Áreas de oportunidad']), compromisos:textValue(v['Compromisos']) };
    if (noEmpleado) {
      const prev = feedbackFromEquipo.get(noEmpleado);
      if (!prev || (!prev.fortalezas && !prev.areas_oportunidad && !prev.compromisos)) feedbackFromEquipo.set(noEmpleado, eqFb);
      else if (compareFeedback(prev, eqFb).length && (eqFb.fortalezas || eqFb.areas_oportunidad || eqFb.compromisos)) errors.push(`Fila ${r}: retroalimentación inconsistente dentro de Equipo para empleado ${noEmpleado}.`);
    }
    rows.push({
      orden: rows.length + 1, no_empleado:noEmpleado, empleado_nombre:textValue(v['Empleado']), puesto_nombre:textValue(v['Puesto']),
      departamento_nombre:textValue(v['Departamento']), sucursal_nombre:textValue(v['Sucursal']), anio:year, mes:month,
      kpi_nombre:kpi, objetivo:textValue(v['Objetivo']), unidad:textValue(v['Unidad']), resultado:result,
      semaforo:textValue(v['Semáforo']), puntaje_base:numberOrNull(v['Puntaje base']), peso,
      puntaje_ponderado:numberOrNull(v['Puntaje ponderado']), estado, aprobado_por_nombre:textValue(v['Aprobado por']),
      fecha_aprobacion:excelDate(v['Fecha aprobación']), revision_por_nombre:textValue(v['En revisión por']), fecha_revision:excelDate(v['Fecha revisión']),
      motivo_revision:textValue(v['Motivo revisión']), comentario_kpi:textValue(v['Comentario KPI'])
    });
  }
  if (!rows.length) errors.push('No hay filas válidas en Equipo.');
  if (periods.size > 1) errors.push('El archivo contiene años o meses diferentes en la hoja Equipo.');
  if (duplicates.size) errors.push(`Se detectaron ${duplicates.size} duplicados exactos de No. Empleado + KPI + Año + Mes.`);

  for (const [emp, total] of weightByEmployee) if (Math.abs(total - 100) > 0.02) warnings.push(`El empleado ${emp} suma ${total.toFixed(2)}% de peso, no 100%.`);
  const knownStates = new Set(['ABIERTO','APROBADO','EN REVISIÓN']);
  for (const state of states.keys()) if (!knownStates.has(String(state).toUpperCase())) warnings.push(`Estado desconocido detectado: ${state}.`);
  const knownColors = new Set(['ROJO','AMARILLO','VERDE']);
  for (const color of colors.keys()) if (!knownColors.has(String(color).toUpperCase())) warnings.push(`Semáforo desconocido detectado: ${color}.`);

  const feedback = new Map();
  const fbWs = workbook.getWorksheet('Retroalimentación');
  if (fbWs) {
    const fm = getHeaderMap(fbWs);
    const fbMissing = FEEDBACK_HEADERS.filter(h => !fm.has(normalizeKey(h)));
    if (fbMissing.length) errors.push(`Faltan columnas en Retroalimentación: ${fbMissing.join(', ')}.`);
    else {
      for (let r = 2; r <= fbWs.rowCount; r++) {
        const row = fbWs.getRow(r); if (!rowHasData(row, FEEDBACK_HEADERS.length)) continue;
        const v = valuesByHeaders(row, fm, FEEDBACK_HEADERS); const emp = textValue(v['No. Empleado']); if (!emp) continue;
        const f = { no_empleado:emp, empleado_nombre:textValue(v['Empleado']), anio:Number(clean(v['Año'])), mes:monthToNumber(v['Mes']),
          fortalezas:textValue(v['Fortalezas']), areas_oportunidad:textValue(v['Áreas de oportunidad']), compromisos:textValue(v['Compromisos']) };
        feedback.set(emp, f);
        const eq = feedbackFromEquipo.get(emp);
        if (eq && (f.fortalezas || f.areas_oportunidad || f.compromisos) && (eq.fortalezas || eq.areas_oportunidad || eq.compromisos)) {
          const diffs = compareFeedback(f, eq);
          if (diffs.length) errors.push(`Retroalimentación contradice Equipo para empleado ${emp}: ${diffs.join(', ')}.`);
        }
      }
    }
  } else {
    for (const [emp, f] of feedbackFromEquipo) feedback.set(emp, { no_empleado:emp, empleado_nombre:(rows.find(x=>x.no_empleado===emp)||{}).empleado_nombre || null,
      anio:rows[0]?.anio || null, mes:rows[0]?.mes || null, ...f });
  }

  let resumenCollaborators = null;
  const resumen = workbook.getWorksheet('Resumen');
  if (resumen) {
    for (let r=2; r<=resumen.rowCount; r++) {
      const k = normalizeKey(resumen.getRow(r).getCell(1).value);
      if (k === normalizeKey('No. colaboradores')) resumenCollaborators = Number(clean(resumen.getRow(r).getCell(2).value));
    }
    if (Number.isFinite(resumenCollaborators) && resumenCollaborators !== employeeSet.size) warnings.push(`Resumen indica ${resumenCollaborators} colaboradores, pero Equipo contiene ${employeeSet.size}.`);
  }

  const period = periods.size === 1 ? [...periods][0].split('|').map(Number) : [null,null];
  const feedbackWithContent = [...feedback.values()].filter(f => f.fortalezas || f.areas_oportunidad || f.compromisos).length;
  const stateCounts = { aprobado:0, revision:0, abierto:0 };
  for (const [k,v] of states) { const s=String(k).toUpperCase(); if(s==='APROBADO')stateCounts.aprobado+=v; else if(s==='EN REVISIÓN')stateCounts.revision+=v; else if(s==='ABIERTO')stateCounts.abierto+=v; }
  return { valid: errors.length===0, filename, sha256:hashBuffer(buffer), errors:[...new Set(errors)], warnings:[...new Set(warnings)],
    year:period[0], month:period[1], monthName:period[1] ? MONTHS[period[1]-1] : '', rows, feedback:[...feedback.values()],
    stats:{ employees:employeeSet.size, rows:rows.length, captured, stateCounts, feedbackWithContent }, resumenCollaborators };
}

function styleHeader(ws) {
  const row=ws.getRow(1); row.font={bold:true,color:{argb:'FFFFFFFF'}}; row.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF343A40'}};
  row.alignment={vertical:'middle',horizontal:'center',wrapText:true}; ws.views=[{state:'frozen',ySplit:1}];
}
function autoWidth(ws, min=12, max=45) { ws.columns.forEach(c => { let len=String(c.header||'').length; c.eachCell({includeEmpty:false},cell=>{len=Math.max(len,String(cell.value??'').length)}); c.width=Math.min(max,Math.max(min,len+2)); }); }
async function buildHistoricalWorkbook({ period, details, feedback, creatorName = '' }) {
  const wb=new ExcelJS.Workbook(); wb.creator='KPI Manager CHC'; wb.created=new Date();
  const ws=wb.addWorksheet('Equipo'); ws.columns=EQUIPO_HEADERS.map(h=>({header:h,key:h}));
  const fbMap=new Map((feedback||[]).map(f=>[String(f.no_empleado||''),f]));
  for(const d of details||[]) { const f=fbMap.get(String(d.no_empleado||''))||{}; ws.addRow({
    'No. Empleado':d.no_empleado||'', 'Empleado':d.empleado_nombre||'', 'Puesto':d.puesto_nombre||'', 'Departamento':d.departamento_nombre||'', 'Sucursal':d.sucursal_nombre||'',
    'Año':period.anio, 'Mes':MONTHS[period.mes-1]||period.mes, 'KPI':d.kpi_nombre||'', 'Objetivo':d.objetivo??'', 'Unidad':d.unidad||'', 'Resultado':d.resultado??'',
    'Semáforo':d.semaforo||'', 'Puntaje base':d.puntaje_base??'', 'Peso (%)':d.peso??'', 'Puntaje ponderado':d.puntaje_ponderado??'', 'Estado':d.estado||'',
    'Aprobado por':d.aprobado_por_nombre||'', 'Fecha aprobación':d.fecha_aprobacion||'', 'En revisión por':d.revision_por_nombre||'', 'Fecha revisión':d.fecha_revision||'',
    'Motivo revisión':d.motivo_revision||'', 'Comentario KPI':d.comentario_kpi||'', 'Fortalezas':f.fortalezas||'', 'Áreas de oportunidad':f.areas_oportunidad||'', 'Compromisos':f.compromisos||'' }); }
  styleHeader(ws); autoWidth(ws);
  const wf=wb.addWorksheet('Retroalimentación'); wf.columns=FEEDBACK_HEADERS.map(h=>({header:h,key:h}));
  for(const f of feedback||[]) wf.addRow({'No. Empleado':f.no_empleado||'', 'Empleado':f.empleado_nombre||'', 'Año':period.anio, 'Mes':MONTHS[period.mes-1]||period.mes,
    'Fortalezas':f.fortalezas||'', 'Áreas de oportunidad':f.areas_oportunidad||'', 'Compromisos':f.compromisos||''});
  styleHeader(wf); autoWidth(wf,12,70);
  const wr=wb.addWorksheet('Resumen'); wr.columns=[{header:'Campo',key:'k'},{header:'Valor',key:'v'}];
  wr.addRow({k:'Jefe',v:creatorName||''}); wr.addRow({k:'No. colaboradores',v:String(period.empleados_total||0)});
  wr.addRow({k:'Modo',v:`Mensual (${MONTHS[period.mes-1]} ${period.anio})`}); wr.addRow({k:'Incluye BAJAS',v:'Histórico'}); styleHeader(wr); autoWidth(wr,12,70);
  return wb;
}

module.exports={ MONTHS, EQUIPO_HEADERS, parseHistoricalWorkbook, buildHistoricalWorkbook, monthToNumber, hashBuffer };
