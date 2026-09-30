const express = require('express');
const multer = require('multer');
const path = require('path');
const isAuth = require('../middleware/isAuth');
const { requireRole } = require('../middleware/roles');
const { logKpiManager } = require('../utils/logkpimanager');
const { MONTHS, buildHistoricalWorkbook } = require('../services/historicosExcel');
const {
  analyzeImport, importHistorical, listPeriods, getPeriod, getEmployeeSummary,
  getFilters, getEmployeeDetail, getExportData
} = require('../services/historicosService');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ext !== '.xlsx') return cb(new Error('Solo se permiten archivos .xlsx.'));
    cb(null, true);
  }
});
const admin = [isAuth, requireRole(['admin'])];
function intOrNull(v,min,max){ const n=Number(v); return Number.isInteger(n)&&n>=min&&n<=max?n:null; }
function uploadOne(req,res,next){ upload.single('archivo')(req,res,err=>{ if(!err)return next(); const msg=err.code==='LIMIT_FILE_SIZE'?'El archivo supera el máximo de 15 MB.':err.message; if(req.path.includes('/preview')) return res.status(400).json({ok:false,errors:[msg]}); req.flash('error',msg); return res.redirect('/admin/historicos'); }); }

router.get('/admin/historicos', ...admin, async (req,res)=>{
  try{
    const year=intOrNull(req.query.anio,2000,2100), month=intOrNull(req.query.mes,1,12);
    const periods=await listPeriods({year,month});
    res.render('admin_historicos',{title:'Históricos',periods,selectedYear:year,selectedMonth:month,MONTHS,period:null,employees:[],filters:null,employeeDetail:null,query:{}});
  }catch(e){ console.error('[Historicos] listado',e); req.flash('error','No se pudieron cargar los históricos. ¿Ya ejecutaste la migración v1.5?'); res.redirect('/dashboard'); }
});

router.get('/admin/historicos/periodo/:id', ...admin, async (req,res)=>{
  try{
    const id=Number(req.params.id); const period=await getPeriod(id); if(!period)return res.status(404).send('Histórico no encontrado');
    const query={search:String(req.query.buscar||'').trim(),puesto:String(req.query.puesto||'').trim(),departamento:String(req.query.departamento||'').trim(),sucursal:String(req.query.sucursal||'').trim()};
    const [periods,employees,filters]=await Promise.all([listPeriods(),getEmployeeSummary(id,query),getFilters(id)]);
    res.render('admin_historicos',{title:'Históricos',periods,selectedYear:null,selectedMonth:null,MONTHS,period,employees,filters,employeeDetail:null,query});
  }catch(e){ console.error('[Historicos] periodo',e); req.flash('error','No se pudo consultar el histórico.'); res.redirect('/admin/historicos'); }
});

router.get('/admin/historicos/periodo/:id/empleado/:noEmpleado', ...admin, async (req,res)=>{
  try{
    const id=Number(req.params.id);
    if(!Number.isInteger(id)||id<=0)return res.status(400).json({ok:false,error:'Histórico inválido.'});
    const period=await getPeriod(id);
    if(!period)return res.status(404).json({ok:false,error:'Histórico no encontrado.'});
    const noEmpleado=String(req.params.noEmpleado||'').trim();
    if(!noEmpleado)return res.status(400).json({ok:false,error:'Empleado inválido.'});
    const detail=await getEmployeeDetail(id,noEmpleado);
    if(!detail.details.length)return res.status(404).json({ok:false,error:'No se encontró información histórica para este empleado.'});
    return res.json({ok:true,detail});
  }catch(e){
    console.error('[Historicos] detalle empleado',e);
    return res.status(500).json({ok:false,error:'No se pudo consultar el detalle histórico.'});
  }
});

router.post('/admin/historicos/import/preview', ...admin, uploadOne, async (req,res)=>{
  if(!req.file)return res.status(400).json({ok:false,errors:['Selecciona un archivo .xlsx.']});
  try{
    const parsed=await analyzeImport(req.file.buffer,req.file.originalname);
    return res.status(parsed.valid?200:422).json({ok:parsed.valid,filename:parsed.filename,sha256:parsed.sha256,year:parsed.year,month:parsed.month,monthName:parsed.monthName,stats:parsed.stats,errors:parsed.errors,warnings:parsed.warnings,existing:parsed.existing||{hasCurrent:false,sameHash:false,versions:[]}});
  }catch(e){ console.error('[Historicos] preview',e); return res.status(500).json({ok:false,errors:['No fue posible analizar el archivo.']}); }
});

router.post('/admin/historicos/import', ...admin, uploadOne, async (req,res)=>{
  if(!req.file){ req.flash('error','Selecciona un archivo .xlsx.'); return res.redirect('/admin/historicos'); }
  try{
    const userId=req.session?.user?.id||null; const result=await importHistorical(req.file.buffer,req.file.originalname,userId,{asNewVersion:req.body.asNewVersion==='1'});
    await logKpiManager(req,{accion:'HISTORY_IMPORT',entidad:'kpi_historico_periodos',entidad_id:result.id,descripcion:'Importó histórico de KPI',detalle:{anio:result.parsed.year,mes:result.parsed.month,version:result.version,archivo:req.file.originalname,filas:result.parsed.stats.rows,empleados:result.parsed.stats.employees}});
    req.flash('success',`${MONTHS[result.parsed.month-1]} ${result.parsed.year} importado como histórico v${result.version}: ${result.parsed.stats.employees} colaboradores y ${result.parsed.stats.rows.toLocaleString('es-MX')} registros KPI.`);
    return res.redirect(`/admin/historicos/periodo/${result.id}`);
  }catch(e){ console.error('[Historicos] import',e); req.flash('error',e.message||'No se pudo importar el histórico. No se realizaron cambios.'); return res.redirect('/admin/historicos'); }
});

router.get('/admin/historicos/periodo/:id/export', ...admin, async (req,res)=>{
  try{
    const data=await getExportData(Number(req.params.id)); if(!data)return res.status(404).send('Histórico no encontrado');
    const wb=await buildHistoricalWorkbook({period:data.period,details:data.details,feedback:data.feedback,creatorName:data.period.creado_por_nombre||''});
    const buffer=await wb.xlsx.writeBuffer(); const filename=`KPIs_Historico_${data.period.anio}-${String(data.period.mes).padStart(2,'0')}_v${data.period.version}.xlsx`;
    await logKpiManager(req,{accion:'HISTORY_EXPORT',entidad:'kpi_historico_periodos',entidad_id:data.period.id,descripcion:'Exportó histórico de KPI',detalle:{anio:data.period.anio,mes:data.period.mes,version:data.period.version}});
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition',`attachment; filename="${filename}"`); return res.send(Buffer.from(buffer));
  }catch(e){ console.error('[Historicos] export',e); req.flash('error','No se pudo exportar el histórico.'); return res.redirect(`/admin/historicos/periodo/${req.params.id}`); }
});

module.exports = router;
