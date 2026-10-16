/**
 * Exportación de la estructura de puestos y KPIs asignados.
 * Solo lectura. ExcelJS ya es dependencia del proyecto.
 * La consulta obtiene una fila por asignación y una fila con KPI NULL
 * para cada puesto sin indicadores, de modo que nunca desaparezcan.
 */
const ExcelJS = require('exceljs');

const COLOR = {
  vino: 'FF7E2231', vinoClaro: 'FFF6E9EC', blanco: 'FFFFFFFF',
  texto: 'FF253044', gris: 'FF65738A', azul: 'FF305780',
  azulClaro: 'FFF0F5FA', linea: 'FFD9E1EB',
  verde: 'FFE6F4EA', verdeTexto: 'FF186534',
  amarillo: 'FFFFF3D2', amarilloTexto: 'FF825800',
  rojo: 'FFFDE9E9', rojoTexto: 'FF9B1C26'
};

const PREFERIDOS = ['DIRECCION', 'DIRECCIÓN', 'EYE', 'SISTEMAS', 'CAPITAL HUMANO', 'OPERACIONES'];
const TEXTO_SIN_KPIS = 'Sin KPIs asignados';

function texto(value, fallback = '') {
  return value == null ? fallback : String(value);
}
function numero(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function idValido(value) {
  const n = numero(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
function normalizarDepartamento(value) {
  const dep = texto(value).trim();
  return !dep || dep.toUpperCase() === 'BAJA' ? 'SIN DEPARTAMENTO' : dep;
}
function compararDepartamentos(a, b) {
  const ia = PREFERIDOS.indexOf(a.toUpperCase());
  const ib = PREFERIDOS.indexOf(b.toUpperCase());
  if (ia !== -1 || ib !== -1) {
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  }
  return a.localeCompare(b, 'es');
}
function rolLegible(value) {
  const rol = texto(value, 'user').toLowerCase();
  return ({admin: 'Admin', manager: 'Manager', user: 'User'})[rol] || texto(value, 'User');
}
function estadoPesos(puesto) {
  if (puesto.kpis.length === 0) return 'Sin KPIs';
  if (puesto.pesos_invalidos || Math.abs(puesto.peso_total - 100) > 0.01) return 'Revisar pesos';
  return 'Completo';
}

/**
 * Agrupa la consulta de lectura por puesto para que el resumen y el
 * detalle siempre tengan exactamente las mismas asignaciones.
 * peso = número de puntos porcentuales (25 significa 25 %, NO 0.25).
 */
function prepararDatosPuestos(registros) {
  const map = new Map();
  for (const r of Array.isArray(registros) ? registros : []) {
    const id = idValido(r.puesto_id);
    if (id === null) continue;
    if (!map.has(id)) {
      map.set(id, {
        id, departamento: normalizarDepartamento(r.departamento_nombre),
        nombre: texto(r.puesto_nombre),
        responde_a: texto(r.responde_a_nombre, 'Sin jefe directo'),
        responde_a_departamento: texto(r.responde_a_departamento),
        rol: rolLegible(r.rol), kpis: [], centavos: 0,
        pesos_invalidos: false, peso_total: 0, estado: ''
      });
    }
    const puesto = map.get(id);
    // NULL en el LEFT JOIN significa puesto sin KPIs; no sumar esa fila.
    const kpiId = idValido(r.kpi_id);
    if (kpiId === null) continue;
    const peso = numero(r.peso);
    if (peso === null) puesto.pesos_invalidos = true;
    else puesto.centavos += Math.round(peso * 100);
    puesto.kpis.push({
      id: kpiId,
      nombre: texto(r.kpi_nombre, 'KPI no encontrado en el catálogo'),
      objetivo: texto(r.objetivo), unidad: texto(r.unidad),
      periodicidad: texto(r.periodicidad), peso
    });
  }

  const puestos = [...map.values()];
  for (const puesto of puestos) {
    puesto.peso_total = puesto.centavos / 100;
    puesto.estado = estadoPesos(puesto);
    puesto.kpis.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es') || a.id - b.id);
  }
  puestos.sort((a, b) =>
    compararDepartamentos(a.departamento, b.departamento) ||
    a.nombre.localeCompare(b.nombre, 'es') || a.id - b.id
  );

  const detalle = [];
  let deptActual = null, correlativo = 0;
  for (const puesto of puestos) {
    if (puesto.departamento !== deptActual) { deptActual = puesto.departamento; correlativo = 0; }
    puesto.numero = ++correlativo; // Igual que la numeración por departamento de la pantalla.
    if (!puesto.kpis.length) {
      detalle.push({ puesto, kpi: null, primero: true });
    } else {
      puesto.kpis.forEach((kpi, i) => detalle.push({ puesto, kpi, primero: i === 0 }));
    }
  }
  const stats = {
    puestos: puestos.length,
    departamentos: new Set(puestos.map(p => p.departamento)).size,
    conKpis: puestos.filter(p => p.kpis.length > 0).length,
    sinKpis: puestos.filter(p => p.kpis.length === 0).length,
    revisar: puestos.filter(p => p.estado === 'Revisar pesos').length,
    asignaciones: puestos.reduce((acc, p) => acc + p.kpis.length, 0),
    kpisDistintos: new Set(puestos.flatMap(p => p.kpis.map(k => k.id))).size
  };
  return { puestos, detalle, stats };
}

function addBanner(ws, count, titulo, subtitulo, meta, tarjetas) {
  const last = ws.getColumn(count).letter;
  for (const row of [1, 2, 3]) ws.mergeCells(`A${row}:${last}${row}`);
  ws.getCell('A1').value = titulo;
  ws.getCell('A1').fill = {type:'pattern',pattern:'solid',fgColor:{argb:COLOR.vino}};
  ws.getCell('A1').font = {name:'Calibri',size:17,bold:true,color:{argb:COLOR.blanco}};
  ws.getCell('A1').alignment = {vertical:'middle',indent:1};
  ws.getRow(1).height = 34;
  ws.getCell('A2').value = subtitulo;
  ws.getCell('A2').fill = {type:'pattern',pattern:'solid',fgColor:{argb:COLOR.vinoClaro}};
  ws.getCell('A2').font = {name:'Calibri',size:11,bold:true,color:{argb:COLOR.vino}};
  ws.getCell('A2').alignment = {vertical:'middle',indent:1};
  ws.getRow(2).height = 27;
  ws.getCell('A3').value = meta;
  ws.getCell('A3').font = {name:'Calibri',size:10,color:{argb:COLOR.texto}};
  ws.getCell('A3').alignment = {vertical:'middle',indent:1};
  ws.getRow(3).height = 25;

  ws.getRow(4).height = 31;
  for (const tarjeta of tarjetas) {
    ws.mergeCells(tarjeta.rango);
    const celda = ws.getCell(tarjeta.rango.split(':')[0]);
    celda.value = tarjeta.valor;
    celda.fill = {type:'pattern',pattern:'solid',fgColor:{argb:tarjeta.fondo || COLOR.azulClaro}};
    celda.font = {name:'Calibri',size:10,bold:true,color:{argb:tarjeta.texto || COLOR.azul}};
    celda.alignment = {vertical:'middle',horizontal:'center'};
  }
  ws.getRow(5).height = 10;
  ws.views = [{state:'frozen',xSplit:count > 10 ? 4 : 3,ySplit:6}];
  ws.pageSetup = {paperSize:9,orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0};
  ws.pageSetup.printTitlesRow = '1:6';
  ws.headerFooter.oddFooter = '&LCHC KPI Manager&CExportación de puestos&R&P / &N';
  ws.properties.defaultRowHeight = 23;
}

function addTabla(ws, nombre, columnas, filas, anchos) {
  ws.addTable({
    name:nombre,ref:'A6',headerRow:true,totalsRow:false,
    style:{theme:'TableStyleMedium2',showRowStripes:true},
    columns:columnas.map(name=>({name,filterButton:true})),rows:filas
  });
  ws.getRow(6).height = 36;
  ws.getRow(6).eachCell(cell => {
    cell.font={name:'Calibri',size:10,bold:true,color:{argb:COLOR.blanco}};
    cell.alignment={vertical:'middle',horizontal:'center',wrapText:true};
  });
  anchos.forEach((width,i) => {ws.getColumn(i+1).width = width;});
}

function colorearEstado(cell, estado) {
  const [bg,fg] = estado === 'Completo'
    ? [COLOR.verde,COLOR.verdeTexto]
    : estado === 'Sin KPIs'
      ? [COLOR.amarillo,COLOR.amarilloTexto]
      : [COLOR.rojo,COLOR.rojoTexto];
  cell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:bg}};
  cell.font = {name:'Calibri',size:10,bold:true,color:{argb:fg}};
  cell.alignment={vertical:'middle',horizontal:'center',wrapText:true};
}
function marcarGrupo(ws, index, total, deptNuevo) {
  const row=ws.getRow(index);
  if (deptNuevo) {
    for (let col=1;col<=total;col++) {
      row.getCell(col).border = {top:{style:'medium',color:{argb:COLOR.linea}}};
    }
    const celda=row.getCell(3);
    celda.fill={type:'pattern',pattern:'solid',fgColor:{argb:COLOR.azulClaro}};
    celda.font={name:'Calibri',size:10,bold:true,color:{argb:COLOR.azul}};
  }
}

function buildPuestosWorkbook({ registros = [] } = {}) {
  const {puestos, detalle, stats} = prepararDatosPuestos(registros);
  const wb = new ExcelJS.Workbook();
  wb.creator='CHC KPI Manager';
  wb.company='Cremería Hermanos Coronel';
  wb.subject='Catálogo de puestos y KPIs asignados';
  wb.created=new Date();
  const generado = new Date().toLocaleString('es-MX',{timeZone:'America/Mexico_City'});

  const resumen=wb.addWorksheet('Resumen de puestos',{properties:{tabColor:{argb:COLOR.vino}}});
  const headResumen=['N.º','ID Puesto','Departamento','Puesto','Responde a','Rol','KPIs asignados','Peso total (%)','Estado'];
  addBanner(resumen,headResumen.length,'CHC  |  CATÁLOGO DE PUESTOS',
    'Estructura de puestos, responsables y asignación de indicadores',
    `Generado: ${generado}  |  ${stats.puestos} puestos en ${stats.departamentos} departamentos  |  ${stats.asignaciones} asignaciones`,[
      {rango:'A4:B4',valor:`PUESTOS: ${stats.puestos}`},
      {rango:'C4:D4',valor:`DEPARTAMENTOS: ${stats.departamentos}`},
      {rango:'E4:F4',valor:`COMPLETOS: ${stats.conKpis-stats.revisar}`,
        fondo:COLOR.verde,texto:COLOR.verdeTexto},
      {rango:'G4:I4',valor:`SIN KPIs: ${stats.sinKpis}  |  REVISAR: ${stats.revisar}`,
        fondo:(stats.sinKpis || stats.revisar)?COLOR.amarillo:COLOR.verde,
        texto:(stats.sinKpis || stats.revisar)?COLOR.amarilloTexto:COLOR.verdeTexto}
    ]);
  const filasResumen=puestos.map(p=>[
    p.numero,p.id,p.departamento,p.nombre,p.responde_a,p.rol,
    p.kpis.length,p.peso_total,p.estado
  ]);
  addTabla(resumen,'CHCResumenPuestos',headResumen,filasResumen,[8,12,29,44,43,16,19,20,22]);
  let deptAnterior=null;
  puestos.forEach((p,i)=>{
    const row=resumen.getRow(i+7);
    row.height=37;
    row.alignment={vertical:'middle',wrapText:true};
    marcarGrupo(resumen,i+7,headResumen.length,p.departamento!==deptAnterior);
    colorearEstado(row.getCell(9),p.estado);
    row.getCell(7).alignment={vertical:'middle',horizontal:'center'};
    row.getCell(8).numFmt='#,##0.00" %"';
    row.getCell(8).alignment={vertical:'middle',horizontal:'center'};
    deptAnterior=p.departamento;
  });

  const detalleWs=wb.addWorksheet('KPIs por puesto',{properties:{tabColor:{argb:COLOR.azul}}});
  const headDetalle=['N.º','ID Puesto','Departamento','Puesto','Responde a','Rol','ID KPI','Nombre del KPI','Objetivo / meta','Unidad','Periodicidad','Peso (%)','Estado del puesto'];
  addBanner(detalleWs,headDetalle.length,'CHC  |  KPIs ASIGNADOS POR PUESTO',
    'Detalle de indicadores, objetivos y pesos por puesto',
    `Generado: ${generado}  |  ${stats.asignaciones} asignaciones reales  |  ${stats.sinKpis} puestos sin KPIs`,[
      {rango:'A4:C4',valor:`ASIGNACIONES: ${stats.asignaciones}`},
      {rango:'D4:F4',valor:`KPIs DISTINTOS: ${stats.kpisDistintos}`},
      {rango:'G4:I4',valor:`PUESTOS CON KPIs: ${stats.conKpis}`,fondo:COLOR.verde,texto:COLOR.verdeTexto},
      {rango:'J4:M4',valor:`PUESTOS SIN KPIs: ${stats.sinKpis}`,
        fondo:stats.sinKpis?COLOR.amarillo:COLOR.verde,
        texto:stats.sinKpis?COLOR.amarilloTexto:COLOR.verdeTexto}
    ]);
  const filasDetalle=detalle.map(({puesto:p,kpi:k})=>[
    p.numero,p.id,p.departamento,p.nombre,p.responde_a,p.rol,
    k ? k.id : null,k ? k.nombre : TEXTO_SIN_KPIS,
    k ? k.objetivo : '',k ? k.unidad : '',k ? k.periodicidad : '',
    k ? k.peso : null,p.estado
  ]);
  addTabla(detalleWs,'CHCDetallePuestoKpis',headDetalle,filasDetalle,
    [8,12,29,43,41,14,12,52,43,18,17,16,22]);
  let puestoAnterior=null;
  detalle.forEach(({puesto:p,kpi:k},i)=>{
    const row=detalleWs.getRow(i+7);
    row.height=39;
    row.alignment={vertical:'middle',wrapText:true};
    marcarGrupo(detalleWs,i+7,headDetalle.length,p.id!==puestoAnterior);
    colorearEstado(row.getCell(13),p.estado);
    row.getCell(12).numFmt='#,##0.00" %"';
    row.getCell(12).alignment={vertical:'middle',horizontal:'center'};
    if (!k) {
      const cell=row.getCell(8);
      cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:COLOR.amarillo}};
      cell.font={name:'Calibri',size:10,bold:true,color:{argb:COLOR.amarilloTexto}};
    }
    puestoAnterior=p.id;
  });
  return {workbook:wb,stats};
}

module.exports={buildPuestosWorkbook,prepararDatosPuestos};
