const { pool } = require('../db');
const { VIRTUAL_BRANCH_REGEX } = require('./kpiVirtual');
const { parseHistoricalWorkbook } = require('./historicosExcel');

function normalizeColor(color) {
  const c=String(color||'').trim().toLowerCase();
  if(c==='red') return 'rojo'; if(c==='yellow') return 'amarillo'; if(c==='green') return 'verde'; return c;
}
function scoreFromColor(color) { const c=normalizeColor(color); if(c==='rojo')return 40; if(c==='amarillo')return 70; if(c==='verde')return 100; return null; }
function statusFromResult(r) { if(r && Number(r.visto_bueno)===1)return 'APROBADO'; if(r && r.revision_por)return 'EN REVISIÓN'; return 'ABIERTO'; }
function trimOrNull(v){ if(v===null||v===undefined)return null; const s=String(v).trim(); return s===''?null:s; }
function resultText(v){ if(v===null||v===undefined)return null; return String(v); }
function numericOrNull(v){ if(v===null||v===undefined||v==='')return null; const n=Number(String(v).replace(',','.')); return Number.isFinite(n)?n:null; }
async function querySafe(conn, sql, params=[], fallback=[]) { try { const [rows]=await conn.execute(sql,params); return rows||[]; } catch(e){ return fallback; } }
async function nextVersion(conn, year, month) { const [rows]=await conn.execute('SELECT COALESCE(MAX(version),0)+1 AS version FROM kpi_historico_periodos WHERE anio=? AND mes=?',[year,month]); return Number(rows[0]?.version||1); }
async function supersedeCurrent(conn, year, month, reason) { await conn.execute(`UPDATE kpi_historico_periodos SET es_actual=0, superseded_at=NOW(), superseded_reason=? WHERE anio=? AND mes=? AND es_actual=1`,[reason,year,month]); }

async function insertDetails(conn, periodId, details) {
  const chunkSize=400;
  for(let i=0;i<details.length;i+=chunkSize){
    const chunk=details.slice(i,i+chunkSize);
    const vals=chunk.map(d=>[periodId,d.orden,d.empleado_id_origen,d.no_empleado,d.empleado_nombre,d.puesto_id_origen,d.puesto_nombre,d.departamento_id_origen,d.departamento_nombre,d.sucursal_id_origen,d.sucursal_nombre,d.kpi_id_origen,d.kpi_nombre,d.objetivo,d.unidad,d.resultado,d.semaforo,d.puntaje_base,d.peso,d.puntaje_ponderado,d.estado,d.aprobado_por_nombre,d.fecha_aprobacion,d.revision_por_nombre,d.fecha_revision,d.motivo_revision,d.comentario_kpi]);
    const ph=vals.map(()=>'(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
    await conn.query(`INSERT INTO kpi_historico_detalle (historico_periodo_id,orden,empleado_id_origen,no_empleado,empleado_nombre,puesto_id_origen,puesto_nombre,departamento_id_origen,departamento_nombre,sucursal_id_origen,sucursal_nombre,kpi_id_origen,kpi_nombre,objetivo,unidad,resultado,semaforo,puntaje_base,peso,puntaje_ponderado,estado,aprobado_por_nombre,fecha_aprobacion,revision_por_nombre,fecha_revision,motivo_revision,comentario_kpi) VALUES ${ph}`, vals.flat());
  }
}
async function insertFeedback(conn, periodId, feedback) {
  const chunkSize=400;
  for(let i=0;i<feedback.length;i+=chunkSize){
    const chunk=feedback.slice(i,i+chunkSize);
    const vals=chunk.map(f=>[periodId,f.empleado_id_origen,f.no_empleado||'',f.empleado_nombre,f.fortalezas,f.areas_oportunidad,f.compromisos]);
    const ph=vals.map(()=>'(?,?,?,?,?,?,?)').join(',');
    await conn.query(`INSERT INTO kpi_historico_feedback (historico_periodo_id,empleado_id_origen,no_empleado,empleado_nombre,fortalezas,areas_oportunidad,compromisos) VALUES ${ph}`,vals.flat());
  }
}

async function buildSystemSnapshot(conn,{year,month}) {
  const [emps]=await conn.execute(`SELECT pe.empleado_id AS id, pe.incidencia_id, pe.nombre, pe.puesto_id, pe.departamento_id, pe.departamento_nombre, pe.sucursal_id, pe.sucursal_nombre
    FROM kpi_periodo_empleados pe WHERE pe.anio=? AND pe.mes=? ORDER BY pe.nombre`,[year,month]);
  if(!emps.length) throw new Error('No existe snapshot de personal para el periodo.');
  const realPuestos=[...new Set(emps.map(e=>Number(e.puesto_id)).filter(Boolean))];
  const effectiveByEmp=new Map();
  for(const e of emps){ const branch=String(e.sucursal_nombre||'').trim(); effectiveByEmp.set(Number(e.id),(branch&&VIRTUAL_BRANCH_REGEX.test(branch)&&Number(e.puesto_id)!==46)?46:Number(e.puesto_id)); }
  const effPuestos=[...new Set([...effectiveByEmp.values()].filter(Boolean))];
  const allPuestos=[...new Set([...realPuestos,...effPuestos])];
  const puestoNames=new Map();
  if(allPuestos.length){ const ph=allPuestos.map(()=>'?').join(','); const [ps]=await conn.execute(`SELECT id,nombre FROM puestos WHERE id IN (${ph})`,allPuestos); ps.forEach(p=>puestoNames.set(Number(p.id),p.nombre)); }
  const kpisByPuesto=new Map();
  if(effPuestos.length){ const ph=effPuestos.map(()=>'?').join(','); const [ks]=await conn.execute(`SELECT pk.puesto_id,k.id AS kpi_id,k.nombre,k.objetivo,k.unidad,pk.peso FROM puesto_kpis pk JOIN kpis k ON k.id=pk.kpi_id WHERE pk.puesto_id IN (${ph}) ORDER BY pk.puesto_id,k.nombre`,effPuestos); for(const k of ks){ const arr=kpisByPuesto.get(Number(k.puesto_id))||[]; arr.push(k); kpisByPuesto.set(Number(k.puesto_id),arr); } }
  const empIds=emps.map(e=>Number(e.id)).filter(Boolean); const results=new Map();
  if(empIds.length){ const ph=empIds.map(()=>'?').join(','); const [rr]=await conn.execute(`SELECT kr.empleado_id,kr.kpi_id,kr.valor,kr.color,kr.comentario,kr.visto_bueno,kr.visto_por,kr.visto_fecha,kr.revision_por,kr.revision_fecha,kr.revision_motivo,vp.nombre AS visto_nombre,rp.nombre AS revision_nombre FROM kpi_resultados kr LEFT JOIN empleados vp ON vp.id=kr.visto_por LEFT JOIN empleados rp ON rp.id=kr.revision_por WHERE kr.empleado_id IN (${ph}) AND kr.anio=? AND kr.mes=?`,[...empIds,year,month]); rr.forEach(r=>results.set(`${r.empleado_id}|${r.kpi_id}`,r)); }
  const fbMap=new Map();
  if(empIds.length){ const ph=empIds.map(()=>'?').join(','); const fbs=await querySafe(conn,`SELECT empleado_id,fortalezas,oportunidades,compromisos FROM retroalimentacion WHERE empleado_id IN (${ph}) AND anio=? AND mes=?`,[...empIds,year,month],[]); fbs.forEach(f=>fbMap.set(Number(f.empleado_id),f)); }
  const details=[]; const feedback=[]; let orden=0;
  for(const e of emps){
    const eff=effectiveByEmp.get(Number(e.id)); const ks=kpisByPuesto.get(eff)||[];
    for(const k of ks){ const r=results.get(`${e.id}|${k.kpi_id}`)||{}; const color=normalizeColor(r.color||''); const score=scoreFromColor(color); const peso=numericOrNull(k.peso); details.push({
      orden:++orden, empleado_id_origen:e.id, no_empleado:trimOrNull(e.incidencia_id), empleado_nombre:trimOrNull(e.nombre), puesto_id_origen:e.puesto_id, puesto_nombre:trimOrNull(puestoNames.get(Number(e.puesto_id))), departamento_id_origen:e.departamento_id, departamento_nombre:trimOrNull(e.departamento_nombre), sucursal_id_origen:e.sucursal_id, sucursal_nombre:trimOrNull(e.sucursal_nombre), kpi_id_origen:k.kpi_id, kpi_nombre:trimOrNull(k.nombre), objetivo:resultText(k.objetivo), unidad:trimOrNull(k.unidad), resultado:resultText(r.valor), semaforo:color?color.toUpperCase():null, puntaje_base:score, peso, puntaje_ponderado:(score!==null&&peso!==null)?Number((score*peso/100).toFixed(4)):null, estado:statusFromResult(r), aprobado_por_nombre:trimOrNull(r.visto_nombre), fecha_aprobacion:r.visto_fecha||null, revision_por_nombre:trimOrNull(r.revision_nombre), fecha_revision:r.revision_fecha||null, motivo_revision:trimOrNull(r.revision_motivo), comentario_kpi:trimOrNull(r.comentario)
    }); }
    const f=fbMap.get(Number(e.id))||{}; feedback.push({ empleado_id_origen:e.id,no_empleado:trimOrNull(e.incidencia_id)||String(e.id),empleado_nombre:trimOrNull(e.nombre),fortalezas:trimOrNull(f.fortalezas),areas_oportunidad:trimOrNull(f.oportunidades),compromisos:trimOrNull(f.compromisos) });
  }
  return {employees:emps.length,details,feedback};
}

async function createSystemHistoryWithConnection(conn,{year,month,userId=null}) {
  const snapshot=await buildSystemSnapshot(conn,{year,month});
  await supersedeCurrent(conn,year,month,'NUEVO_CIERRE');
  const version=await nextVersion(conn,year,month);
  const [ins]=await conn.execute(`INSERT INTO kpi_historico_periodos (anio,mes,version,es_actual,origen,snapshot_el,cerrado_el,creado_por,empleados_total,filas_kpi_total,feedback_total) VALUES (?,?,?,1,'SYSTEM_CLOSE',NOW(),NOW(),?,?,?,?)`,[year,month,version,userId,snapshot.employees,snapshot.details.length,snapshot.feedback.length]);
  await insertDetails(conn,ins.insertId,snapshot.details); await insertFeedback(conn,ins.insertId,snapshot.feedback);
  return {id:ins.insertId,version,employees:snapshot.employees,rows:snapshot.details.length,feedback:snapshot.feedback.length};
}

async function supersedeHistoryForReopenWithConnection(conn,{year,month}) { await supersedeCurrent(conn,year,month,'PERIODO_REABIERTO'); }

async function addCatalogWarnings(parsed) {
  if(!parsed.valid) return parsed;
  try {
    const [emps]=await pool.execute('SELECT id,incidencia_id,puesto_id FROM empleados'); const empMap=new Map(emps.map(e=>[String(e.incidencia_id||'').trim(),e]));
    const [ks]=await pool.execute('SELECT id,nombre FROM kpis'); const kSet=new Set(ks.map(k=>String(k.nombre||'').trim().toLowerCase()));
    const [ps]=await pool.execute('SELECT id,nombre FROM puestos'); const pSet=new Set(ps.map(p=>String(p.nombre||'').trim().toLowerCase()));
    const missingEmp=new Set(),missingKpi=new Set(),missingPuesto=new Set();
    for(const r of parsed.rows){ if(r.no_empleado&&!empMap.has(String(r.no_empleado).trim()))missingEmp.add(r.no_empleado); if(r.kpi_nombre&&!kSet.has(String(r.kpi_nombre).trim().toLowerCase()))missingKpi.add(r.kpi_nombre); if(r.puesto_nombre&&!pSet.has(String(r.puesto_nombre).trim().toLowerCase()))missingPuesto.add(r.puesto_nombre); }
    if(missingEmp.size)parsed.warnings.push(`${missingEmp.size} No. Empleado no existen actualmente.`); if(missingKpi.size)parsed.warnings.push(`${missingKpi.size} KPI no existen actualmente.`); if(missingPuesto.size)parsed.warnings.push(`${missingPuesto.size} puestos no existen actualmente.`);
  } catch(e) { parsed.warnings.push('No fue posible comparar contra los catálogos actuales; esto no impide importar el histórico.'); }
  return parsed;
}
async function analyzeImport(buffer,filename){ const parsed=await parseHistoricalWorkbook(buffer,filename); await addCatalogWarnings(parsed); if(parsed.valid){ try{ const [rows]=await pool.execute(`SELECT id,version,es_actual,archivo_sha256 FROM kpi_historico_periodos WHERE anio=? AND mes=? ORDER BY version DESC`,[parsed.year,parsed.month]); parsed.existing={hasCurrent:rows.some(r=>Number(r.es_actual)===1),versions:rows.map(r=>r.version),sameHash:rows.some(r=>r.archivo_sha256===parsed.sha256)}; }catch(e){ parsed.existing={hasCurrent:false,versions:[],sameHash:false}; } } return parsed; }

async function importHistorical(buffer,filename,userId,{asNewVersion=false}={}) {
  const parsed=await analyzeImport(buffer,filename); if(!parsed.valid){ const e=new Error(parsed.errors.join(' ')); e.code='INVALID_HISTORY_FILE'; e.parsed=parsed; throw e; }
  if(parsed.existing?.sameHash){ const e=new Error('Este mismo archivo ya fue importado.'); e.code='DUPLICATE_HISTORY_FILE'; throw e; }
  if(parsed.existing?.hasCurrent&&!asNewVersion){ const e=new Error('Este periodo ya cuenta con un histórico actual. Selecciona “Importar como nueva versión”.'); e.code='HISTORY_EXISTS'; throw e; }
  const conn=await pool.getConnection();
  try{
    await conn.beginTransaction();
    const [dups]=await conn.execute(`SELECT id FROM kpi_historico_periodos WHERE anio=? AND mes=? AND archivo_sha256=? LIMIT 1`,[parsed.year,parsed.month,parsed.sha256]); if(dups.length)throw Object.assign(new Error('Este mismo archivo ya fue importado.'),{code:'DUPLICATE_HISTORY_FILE'});
    const [current]=await conn.execute(`SELECT id FROM kpi_historico_periodos WHERE anio=? AND mes=? AND es_actual=1 FOR UPDATE`,[parsed.year,parsed.month]); if(current.length&&!asNewVersion)throw Object.assign(new Error('Este periodo ya cuenta con un histórico actual.'),{code:'HISTORY_EXISTS'});
    if(current.length)await supersedeCurrent(conn,parsed.year,parsed.month,'IMPORT_NUEVA_VERSION');
    const version=await nextVersion(conn,parsed.year,parsed.month);
    const empNos=[...new Set(parsed.rows.map(r=>r.no_empleado).filter(Boolean))]; const empMap=new Map();
    if(empNos.length){ const ph=empNos.map(()=>'?').join(','); const [es]=await conn.execute(`SELECT id,incidencia_id,puesto_id,departamento_id,sucursal_id FROM empleados WHERE incidencia_id IN (${ph})`,empNos); es.forEach(e=>empMap.set(String(e.incidencia_id),e)); }
    const kpiNames=[...new Set(parsed.rows.map(r=>r.kpi_nombre).filter(Boolean))]; const kpiMap=new Map();
    if(kpiNames.length){ const ph=kpiNames.map(()=>'?').join(','); const [ks]=await conn.execute(`SELECT id,nombre FROM kpis WHERE nombre IN (${ph})`,kpiNames); ks.forEach(k=>kpiMap.set(String(k.nombre).trim().toLowerCase(),k.id)); }
    const [ins]=await conn.execute(`INSERT INTO kpi_historico_periodos (anio,mes,version,es_actual,origen,snapshot_el,creado_por,archivo_origen,archivo_sha256,empleados_total,filas_kpi_total,feedback_total,observaciones) VALUES (?,?,?,1,'EXCEL_IMPORT',NOW(),?,?,?,?,?,?,?)`,[parsed.year,parsed.month,version,userId,filename,parsed.sha256,parsed.stats.employees,parsed.stats.rows,parsed.feedback.length,parsed.warnings.length?parsed.warnings.join('\n'):null]);
    const details=parsed.rows.map(r=>{ const e=empMap.get(String(r.no_empleado||'')); return {...r,empleado_id_origen:e?.id||null,puesto_id_origen:e?.puesto_id||null,departamento_id_origen:e?.departamento_id||null,sucursal_id_origen:e?.sucursal_id||null,kpi_id_origen:kpiMap.get(String(r.kpi_nombre||'').trim().toLowerCase())||null}; });
    const feedback=parsed.feedback.map(f=>({...f,empleado_id_origen:empMap.get(String(f.no_empleado||''))?.id||null}));
    await insertDetails(conn,ins.insertId,details); await insertFeedback(conn,ins.insertId,feedback);
    await conn.execute(`INSERT INTO kpi_historico_importaciones (historico_periodo_id,usuario_id,archivo_nombre,archivo_sha256,anio,mes,estado,filas_detectadas,empleados_detectados,feedback_detectado,advertencias) VALUES (?,?,?,?,?,?,'IMPORTADO',?,?,?,?)`,[ins.insertId,userId,filename,parsed.sha256,parsed.year,parsed.month,parsed.stats.rows,parsed.stats.employees,parsed.feedback.length,parsed.warnings.length?parsed.warnings.join('\n'):null]);
    await conn.commit(); return {id:ins.insertId,version,parsed};
  }catch(e){ await conn.rollback(); throw e; }finally{ conn.release(); }
}

async function listPeriods({year=null,month=null}={}) { let sql=`SELECT hp.*, e.nombre AS creado_por_nombre FROM kpi_historico_periodos hp LEFT JOIN empleados e ON e.id=hp.creado_por WHERE 1=1`; const p=[]; if(year){sql+=' AND hp.anio=?';p.push(year);} if(month){sql+=' AND hp.mes=?';p.push(month);} sql+=' ORDER BY hp.anio DESC,hp.mes DESC,hp.version DESC'; const [rows]=await pool.execute(sql,p); return rows; }
async function getPeriod(id){ const [rows]=await pool.execute(`SELECT hp.*,e.nombre AS creado_por_nombre FROM kpi_historico_periodos hp LEFT JOIN empleados e ON e.id=hp.creado_por WHERE hp.id=? LIMIT 1`,[id]); return rows[0]||null; }
async function getEmployeeSummary(periodId,{search='',puesto='',departamento='',sucursal=''}={}) { let sql=`SELECT no_empleado,MAX(empleado_nombre) empleado_nombre,MAX(puesto_nombre) puesto_nombre,MAX(departamento_nombre) departamento_nombre,MAX(sucursal_nombre) sucursal_nombre,SUM(CASE WHEN resultado IS NOT NULL AND TRIM(resultado)<>'' THEN 1 ELSE 0 END) kpi_capturados,COUNT(*) kpi_totales,ROUND(SUM(COALESCE(puntaje_ponderado,0)),2) puntaje_total FROM kpi_historico_detalle WHERE historico_periodo_id=?`; const p=[periodId]; if(search){sql+=' AND (empleado_nombre LIKE ? OR no_empleado LIKE ?)';p.push(`%${search}%`,`%${search}%`);} if(puesto){sql+=' AND puesto_nombre=?';p.push(puesto);} if(departamento){sql+=' AND departamento_nombre=?';p.push(departamento);} if(sucursal){sql+=' AND sucursal_nombre=?';p.push(sucursal);} sql+=' GROUP BY no_empleado ORDER BY empleado_nombre'; const [rows]=await pool.execute(sql,p); return rows; }
async function getFilters(periodId){ const [p]=await pool.execute(`SELECT DISTINCT puesto_nombre v FROM kpi_historico_detalle WHERE historico_periodo_id=? AND puesto_nombre IS NOT NULL ORDER BY v`,[periodId]); const [d]=await pool.execute(`SELECT DISTINCT departamento_nombre v FROM kpi_historico_detalle WHERE historico_periodo_id=? AND departamento_nombre IS NOT NULL ORDER BY v`,[periodId]); const [s]=await pool.execute(`SELECT DISTINCT sucursal_nombre v FROM kpi_historico_detalle WHERE historico_periodo_id=? AND sucursal_nombre IS NOT NULL ORDER BY v`,[periodId]); return {puestos:p.map(x=>x.v),departamentos:d.map(x=>x.v),sucursales:s.map(x=>x.v)}; }
async function getEmployeeDetail(periodId,noEmpleado){ const [rows]=await pool.execute(`SELECT * FROM kpi_historico_detalle WHERE historico_periodo_id=? AND no_empleado=? ORDER BY orden`,[periodId,noEmpleado]); const [fb]=await pool.execute(`SELECT * FROM kpi_historico_feedback WHERE historico_periodo_id=? AND no_empleado=? LIMIT 1`,[periodId,noEmpleado]); return {details:rows,feedback:fb[0]||null}; }
async function getExportData(periodId){ const period=await getPeriod(periodId); if(!period)return null; const [details]=await pool.execute(`SELECT * FROM kpi_historico_detalle WHERE historico_periodo_id=? ORDER BY orden`,[periodId]); const [feedback]=await pool.execute(`SELECT * FROM kpi_historico_feedback WHERE historico_periodo_id=? ORDER BY empleado_nombre`,[periodId]); return {period,details,feedback}; }

module.exports={ analyzeImport,importHistorical,createSystemHistoryWithConnection,supersedeHistoryForReopenWithConnection,listPeriods,getPeriod,getEmployeeSummary,getFilters,getEmployeeDetail,getExportData };
