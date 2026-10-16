/**
 * Exportación de catálogo de KPIs (sin resultados ni cambios en la BD).
 * Diseño alineado con el resumen mensual histórico: título, metadatos,
 * tabla Excel con filtros/filas alternadas y paneles inmovilizados.
 */
const ExcelJS = require('exceljs');

const COLORS = {
  vino: 'FF7E2231', vinoClaro: 'FFF6E9EC', oscuro: 'FF253044',
  gris: 'FF64748B', blanco: 'FFFFFFFF',
  rojo: 'FFFDE9E9', rojoTexto: 'FF9B1C26',
  amarillo: 'FFFFF3D2', amarilloTexto: 'FF795300',
  verde: 'FFE6F4EA', verdeTexto: 'FF186534'
};

function text(value, fallback = '') {
  return value === undefined || value === null ? fallback : String(value);
}
function numeric(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function valueForExcel(value, field = '') {
  if (value === undefined || value === null) return null;
  if (/^(id|departamento_id|rojo_min|rojo_max|amarillo_min|amarillo_max|verde_min|verde_max|threshold_yellow|threshold_green)$/.test(field)) {
    return numeric(value);
  }
  return value instanceof Date ? value : text(value);
}
function meaningful(value) {
  return value !== undefined && value !== null && text(value).trim() !== '';
}
function numberLabel(value) {
  const n = numeric(value);
  return n === null ? '' : new Intl.NumberFormat('es-MX', { maximumFractionDigits: 6 }).format(n);
}

function semaforo(kpi) {
  const type = text(kpi.score_type || (kpi.unidad === 'texto' ? 'CRITERION' : 'PERCENT')).toUpperCase();
  if (type === 'CRITERION') {
    return [text(kpi.criterion_red ?? kpi.rojo_txt), text(kpi.criterion_yellow ?? kpi.amarillo_txt), text(kpi.criterion_green ?? kpi.verde_txt)];
  }
  const yellow = numeric(kpi.threshold_yellow);
  const green = numeric(kpi.threshold_green);
  if (yellow !== null && green !== null) {
    const a = numberLabel(yellow), v = numberLabel(green);
    return text(kpi.direction).toUpperCase() === 'LOWER_BETTER'
      ? [`Mayor que ${a}`, `Mayor que ${v} y hasta ${a}`, `${v} o menos`]
      : [`Menor que ${a}`, `Desde ${a} hasta antes de ${v}`, `${v} o más`];
  }
  // Rangos antiguos: mostrar como referencia explícita, sin afirmar que califican hoy.
  const ranges = [['rojo_min','rojo_max'],['amarillo_min','amarillo_max'],['verde_min','verde_max']];
  return ranges.map(([min,max]) => {
    const low = numeric(kpi[min]), high = numeric(kpi[max]);
    return low === null && high === null ? 'Sin configurar' :
      `Legado: ${low === null ? '—' : numberLabel(low)} a ${high === null ? '—' : numberLabel(high)}`;
  });
}

function typeLabel(type) {
  return ({PERCENT:'Porcentaje',NUMBER:'Número',CRITERION:'Criterio (texto)'})[text(type).toUpperCase()] || text(type);
}
function directionLabel(direction, scoreType) {
  if (text(scoreType).toUpperCase() === 'CRITERION') return 'No aplica';
  return text(direction).toUpperCase() === 'LOWER_BETTER' ? '↓ Menos es mejor' :
    text(direction).toUpperCase() === 'HIGHER_BETTER' ? '↑ Más es mejor' : 'No definido';
}

function addBanner(ws, totalColumns, heading, subtitle, meta, note) {
  const last = ws.getColumn(totalColumns).letter;
  for (const index of [1, 2, 3, 4]) ws.mergeCells(`A${index}:${last}${index}`);
  const r1 = ws.getRow(1);
  r1.height = 34;
  ws.getCell('A1').value = heading;
  ws.getCell('A1').font = { name:'Calibri',bold:true,size:17,color:{argb:COLORS.blanco} };
  ws.getCell('A1').alignment = {vertical:'middle',horizontal:'left',indent:1};
  ws.getCell('A1').fill = {type:'pattern',pattern:'solid',fgColor:{argb:COLORS.vino}};
  ws.getRow(2).height = 25;
  ws.getCell('A2').value = subtitle;
  ws.getCell('A2').font = {name:'Calibri',size:11,bold:true,color:{argb:COLORS.vino}};
  ws.getCell('A2').fill = {type:'pattern',pattern:'solid',fgColor:{argb:COLORS.vinoClaro}};
  ws.getCell('A2').alignment = {vertical:'middle',indent:1};
  ws.getRow(3).height = 24;
  ws.getCell('A3').value = meta;
  ws.getCell('A3').font = {name:'Calibri',size:10,color:{argb:COLORS.oscuro}};
  ws.getCell('A3').alignment = {vertical:'middle',indent:1};
  ws.getRow(4).height = 30;
  ws.getCell('A4').value = note;
  ws.getCell('A4').font = {name:'Calibri',size:10,italic:true,color:{argb:COLORS.gris}};
  ws.getCell('A4').alignment = {vertical:'middle',wrapText:true,indent:1};
  ws.getRow(5).height = 9;
  ws.views = [{state:'frozen',xSplit:3,ySplit:6}];
  ws.pageSetup = {orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0};
  ws.headerFooter.oddFooter = '&LCHC KPI Manager&CCatálogo de indicadores&R&P / &N';
}

function addFilterTable(ws, name, headers, rows, widths) {
  ws.addTable({
    name, ref:'A6', headerRow:true, totalsRow:false,
    style:{theme:'TableStyleMedium2',showRowStripes:true},
    columns:headers.map(h=>({name:h,filterButton:true})), rows
  });
  ws.getRow(6).height = 36;
  ws.getRow(6).eachCell(cell=>{
    cell.font={name:'Calibri',size:10,bold:true,color:{argb:COLORS.blanco}};
    cell.alignment={vertical:'middle',horizontal:'center',wrapText:true};
  });
  widths.forEach((width,index)=>ws.getColumn(index+1).width=width);
  rows.forEach((_,i)=>{
    const row=ws.getRow(i+7);
    row.height=42;
    row.alignment={vertical:'middle',wrapText:true};
    if(i%2===0) row.eachCell(cell=>{
      if(!cell.fill || !cell.fill.fgColor) cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF8F9FB'}};
    });
  });
}

function colorRule(cell, color, hasLegacy) {
  const pal = color === 'rojo'
    ? [COLORS.rojo,COLORS.rojoTexto]
    : color === 'amarillo'
      ? [COLORS.amarillo,COLORS.amarilloTexto]
      : [COLORS.verde,COLORS.verdeTexto];
  cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:pal[0]}};
  cell.font={name:'Calibri',size:10,bold:!hasLegacy,color:{argb:pal[1]}};
  cell.alignment={vertical:'middle',horizontal:'center',wrapText:true};
}

const BASE_COLUMNS = [
  ['id','ID KPI'],['departamento_nombre','Departamento'],['nombre','Nombre del KPI'],
  ['objetivo','Objetivo'],['unidad','Unidad'],['periodicidad','Periodicidad'],
  ['score_type','Tipo de calificación'],['direction','Sentido (código)'],
  ['threshold_yellow','Umbral amarillo'],['threshold_green','Umbral verde'],
  ['criterion_red','Criterio rojo'],['criterion_yellow','Criterio amarillo'],
  ['criterion_green','Criterio verde'],['rojo_min','Rojo mínimo (legado)'],
  ['rojo_max','Rojo máximo (legado)'],['amarillo_min','Amarillo mínimo (legado)'],
  ['amarillo_max','Amarillo máximo (legado)'],['verde_min','Verde mínimo (legado)'],
  ['verde_max','Verde máximo (legado)'],['rojo_txt','Texto rojo (legado)'],
  ['amarillo_txt','Texto amarillo (legado)'],['verde_txt','Texto verde (legado)'],
  ['departamento_id','ID departamento']
];

function buildKpiCatalogWorkbook({kpis, departamento='Todos', busqueda=''}) {
  const list=Array.isArray(kpis)?kpis:[];
  const wb=new ExcelJS.Workbook();
  wb.creator='CHC KPI Manager';
  wb.created=new Date();
  wb.subject='Catálogo de KPI y configuración';
  wb.company='Cremería Hermanos Coronel';
  const generated=new Date().toLocaleString('es-MX',{timeZone:'America/Mexico_City'});
  const scope=`Departamento: ${departamento || 'Todos'} | Búsqueda: ${busqueda || 'Sin filtro'}`;

  const ws=wb.addWorksheet('Catálogo de KPIs',{properties:{tabColor:{argb:COLORS.vino}}});
  const headers=['N.º','ID KPI','Departamento','Nombre del KPI','Objetivo / meta','Periodicidad','Unidad','Tipo de calificación','Sentido','Rojo','Amarillo','Verde','Umbral amarillo','Umbral verde'];
  addBanner(ws,headers.length,'CHC  |  CATÁLOGO DE KPIs',
    'Indicadores y reglas de calificación',
    `${list.length.toLocaleString('es-MX')} indicadores  |  ${scope}  |  Generado: ${generated}`,
    'Los colores muestran reglas del catálogo, NO resultados mensuales. “Legado” indica rangos de referencia antiguos; la calificación actual usa umbrales/criterios.');
  const rows=list.map((k,i)=>{
    const [rojo,amarillo,verde]=semaforo(k);
    return [i+1,numeric(k.id),text(k.departamento_nombre,'Sin departamento'),text(k.nombre),text(k.objetivo),
      text(k.periodicidad),text(k.unidad),typeLabel(k.score_type),directionLabel(k.direction,k.score_type),
      rojo,amarillo,verde,numeric(k.threshold_yellow),numeric(k.threshold_green)];
  });
  addFilterTable(ws,'CatalogoKpisCHC',headers,rows,[8,10,27,48,50,17,16,23,21,29,31,28,19,19]);
  list.forEach((k,i)=>{
    const row=ws.getRow(i+7);
    ['rojo','amarillo','verde'].forEach((color,j)=>{
      const cell=row.getCell(j+10);
      colorRule(cell,color,text(cell.value).startsWith('Legado:'));
    });
    row.getCell(1).alignment={vertical:'middle',horizontal:'center'};
    row.getCell(2).alignment={vertical:'middle',horizontal:'center'};
    for (const col of [13,14]) row.getCell(col).numFmt='#,##0.00';
  });

  // La hoja técnica conserva TODOS los campos presentes en SELECT k.*,
  // incluidos los que se añadan en el futuro a la tabla de KPIs.
  const known = BASE_COLUMNS.map(([field])=>field);
  const additional = Array.from(new Set(list.flatMap(row=>Object.keys(row)))).filter(field=>!known.includes(field));
  const fields = [...BASE_COLUMNS,...additional.map(field=>[field,field])];
  const tech=wb.addWorksheet('Configuración completa',{properties:{tabColor:{argb:'FF8290A3'}}});
  addBanner(tech,fields.length,'CHC  |  CONFIGURACIÓN COMPLETA DE KPIs',
    'Consulta de configuración actual y valores originales de la base de datos',
    `${list.length.toLocaleString('es-MX')} indicadores  |  ${scope}  |  Generado: ${generated}`,
    'Los campos de rango mínimo/máximo “legado” son históricos y no sustituyen los umbrales/criterios del modelo de evaluación actual.');
  addFilterTable(tech,'KpisConfiguracionCHC',fields.map(x=>x[1]),
    list.map(k=>fields.map(([key])=>valueForExcel(k[key],key))),
    fields.map(([key])=>['nombre','objetivo'].includes(key)?48:
      key==='departamento_nombre'?28:/^criterion_/.test(key)?28:key.endsWith('_txt')?28:19));
  for(let i=7;i<=list.length+6;i++) {
    tech.getRow(i).height=32;
    fields.forEach(([field],j)=>{
      if (/^(id|departamento_id)$/.test(field)) tech.getRow(i).getCell(j+1).numFmt='0';
      if (/^(threshold_|rojo_min|rojo_max|amarillo_min|amarillo_max|verde_min|verde_max)/.test(field)) tech.getRow(i).getCell(j+1).numFmt='#,##0.00';
    });
  }
  return wb;
}

module.exports={buildKpiCatalogWorkbook, semaforo};
