const cron = require('node-cron');
const { pool, incidenciasPool } = require('../db');
const { logAction } = require('./logger');

/*
 * Programador de sincronización automática de personal desde incidencias.
 * Ejecuta la importación de empleados cada viernes a las 20:00 (8 pm)
 * en la zona horaria de Ciudad de México.  La lógica de importación
 * se replica de la ruta POST /personal/import, pero se implementa aquí
 * de forma independiente para su uso desde cron.  Después de la
 * importación, registra la acción en la tabla logkpimanager con
 * accion 'PERSONAL_IMPORT_AUTO'.
 */

// Normaliza cadenas: trim, colapsa espacios, quita acentos y pasa a mayúsculas.
function normUpper(v) {
  return String(v || '')
    .trim()
    .replace(/\s+/g, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

// Cache para ids de departamentos por nombre normalizado.
const deptIdCache = new Map();
async function getDepartamentoIdByNombreUpper(nombreUpper) {
  const key = normUpper(nombreUpper);
  if (!key) return null;
  if (deptIdCache.has(key)) return deptIdCache.get(key);
  const [rows] = await pool.execute('SELECT id FROM departamentos WHERE UPPER(nombre) = ? LIMIT 1', [key]);
  const id = rows.length ? rows[0].id : null;
  deptIdCache.set(key, id);
  return id;
}

async function ensureDepartamentoIdByNombreUpper(nombreUpper) {
  const key = normUpper(nombreUpper);
  if (!key) return null;
  let id = await getDepartamentoIdByNombreUpper(key);
  if (id) return id;
  try {
    await pool.execute('INSERT INTO departamentos (nombre) VALUES (?)', [key]);
  } catch (e) {
    // ignorar; posiblemente es UNIQUE
  }
  deptIdCache.delete(key);
  id = await getDepartamentoIdByNombreUpper(key);
  return id;
}

// Construye un resolvedor para puestos locales con base en nombre y departamento.
async function buildPuestoResolver() {
  const [puestosRows] = await pool.execute('SELECT id, nombre, departamento_id FROM puestos');
  const [deptRows] = await pool.execute('SELECT id, nombre FROM departamentos');
  const deptNameById = new Map();
  const deptIdByNameUpper = new Map();
  for (const d of deptRows) {
    const up = normUpper(d.nombre);
    deptNameById.set(Number(d.id), up);
    deptIdByNameUpper.set(up, Number(d.id));
  }
  const puestosByName = new Map();
  const puestosByNameDept = new Map();
  for (const p of puestosRows) {
    const nameU = normUpper(p.nombre);
    const deptU = deptNameById.get(Number(p.departamento_id)) || '';
    if (!puestosByName.has(nameU)) puestosByName.set(nameU, []);
    puestosByName.get(nameU).push({ id: Number(p.id), departamento_id: Number(p.departamento_id), deptU });
    const key = `${nameU}|${deptU}`;
    if (!puestosByNameDept.has(key)) puestosByNameDept.set(key, []);
    puestosByNameDept.get(key).push({ id: Number(p.id), departamento_id: Number(p.departamento_id), deptU });
  }
  const getByName = (name) => puestosByName.get(normUpper(name)) || [];
  const getByNameDept = (name, deptName) => {
    const key = `${normUpper(name)}|${normUpper(deptName)}`;
    return puestosByNameDept.get(key) || [];
  };
  function resolvePuestoLocal(remotePuestoName, remoteDeptName) {
    const puestoNameU = normUpper(remotePuestoName);
    const deptNameU = normUpper(remoteDeptName);
    const isEYE = deptNameU.startsWith('EYE');
    let candidates = [];
    if (isEYE) {
      candidates = getByNameDept(puestoNameU, deptNameU);
      if (!candidates.length) {
        const allCandidates = getByName(puestoNameU);
        if (allCandidates && allCandidates.length) {
          const eyeMatches = allCandidates.filter(c => {
            const dname = deptNameById.get(Number(c.departamento_id)) || '';
            return dname.startsWith('EYE');
          });
          if (eyeMatches.length) {
            eyeMatches.sort((a, b) => a.id - b.id);
            return eyeMatches[0].id;
          }
        }
        candidates = getByNameDept('OTRO', deptNameU);
      }
    } else {
      const nameCandidates = getByName(puestoNameU);
      if (nameCandidates.length && deptNameU) {
        const deptMatches = getByNameDept(puestoNameU, deptNameU);
        if (deptMatches && deptMatches.length) {
          candidates = deptMatches;
        }
      }
      if (!candidates || candidates.length === 0) {
        candidates = nameCandidates;
      }
      if (candidates && candidates.length > 1) {
        const nonEye = candidates.filter(c => {
          const dname = deptNameById.get(Number(c.departamento_id)) || '';
          return !dname.startsWith('EYE');
        });
        if (nonEye.length) {
          candidates = nonEye;
        }
      }
      if (!candidates || candidates.length === 0) {
        candidates = getByName('OTRO');
      }
    }
    if (candidates && candidates.length) {
      candidates.sort((a, b) => a.id - b.id);
      return candidates[0].id;
    }
    const any = puestosRows[0];
    return any ? Number(any.id) : null;
  }
  return { resolvePuestoLocal, deptNameById, deptIdByNameUpper };
}

// Determina destino (departamento, sucursal, dept para puesto) y si es BAJA.
async function resolveImportDestino(departamentoOrigen, deptIdByNameUpper) {
  const depUpper = normUpper(departamentoOrigen || '');
  const esBaja = depUpper.includes('BAJA');
  let sucursalId = null;
  let deptId = null;
  let deptName = departamentoOrigen || '';
  if (esBaja) {
    deptName = 'BAJA';
    deptId = deptIdByNameUpper.get(normUpper('BAJA')) || null;
    if (!deptId) {
      deptId = await ensureDepartamentoIdByNombreUpper('BAJA');
    }
  } else {
    const [sucRows] = await pool.execute('SELECT id FROM sucursales WHERE UPPER(nombre) = ? LIMIT 1', [depUpper]);
    if (sucRows.length) {
      sucursalId = sucRows[0].id;
      deptId = deptIdByNameUpper.get(normUpper('OPERACIONES')) || null;
      if (!deptId) {
        deptId = await ensureDepartamentoIdByNombreUpper('OPERACIONES');
      }
    } else {
      deptId = deptIdByNameUpper.get(depUpper) || null;
      if (!deptId) {
        deptId = await ensureDepartamentoIdByNombreUpper(departamentoOrigen);
      }
    }
  }
  return { deptId, sucursalId, deptForPuesto: deptName || '', esBaja };
}

async function importEmployeesAndLog(mode = 'auto') {
  let importados = 0;
  try {
    const { resolvePuestoLocal, deptIdByNameUpper } = await buildPuestoResolver();
    const [remotos] = await incidenciasPool.execute(
      `SELECT employee_number AS codigo,
              full_name AS nombre,
              puesto AS puesto,
              department_name AS departamento
       FROM personal`
    );
    for (const emp of remotos) {
      const codigo = emp.codigo;
      const nombre = emp.nombre;
      let puestoBase = String(emp.puesto || '').trim();
      const cutIdx = puestoBase.indexOf(' - ');
      if (cutIdx > 0) {
        puestoBase = puestoBase.substring(0, cutIdx).trim();
      }
      const departamentoOrigen = emp.departamento || '';
      const { deptId, sucursalId, deptForPuesto, esBaja } = await resolveImportDestino(departamentoOrigen, deptIdByNameUpper);
      const puestoId = resolvePuestoLocal(puestoBase, deptForPuesto);
      let departamentoId = deptId;
      if (!departamentoId) {
        const [pDept] = await pool.execute('SELECT departamento_id FROM puestos WHERE id = ? LIMIT 1', [puestoId]);
        departamentoId = pDept.length ? pDept[0].departamento_id : null;
      }
      const [existRows] = await pool.execute('SELECT id FROM empleados WHERE incidencia_id = ?', [codigo]);
      if (existRows.length > 0) {
        if (esBaja) {
          await pool.execute(
            `UPDATE empleados
             SET nombre = ?, puesto_id = ?, departamento_id = ?, sucursal_id = NULL, login_enabled = 0
             WHERE incidencia_id = ?`,
            [nombre, puestoId, departamentoId, codigo]
          );
        } else {
          await pool.execute(
            `UPDATE empleados SET nombre = ?, puesto_id = ?, departamento_id = ?, sucursal_id = ? WHERE incidencia_id = ?`,
            [nombre, puestoId, departamentoId, sucursalId, codigo]
          );
        }
      } else {
        await pool.execute(
          `INSERT INTO empleados (incidencia_id, nombre, puesto_id, departamento_id, sucursal_id, login_enabled)
           VALUES (?, ?, ?, ?, ?, 0)`,
          [codigo, nombre, puestoId, departamentoId, sucursalId]
        );
      }
      importados++;
    }
    await logAction({
      accion: mode === 'manual' ? 'PERSONAL_IMPORT_MANUAL' : 'PERSONAL_IMPORT_AUTO',
      entidad: 'empleados',
      descripcion: `Se importaron/actualizaron ${importados} empleados (${mode})`,
      detalle: { importados, mode }
    });
    return { ok: true, importados };
  } catch (err) {
    console.error('[PersonalSync] Error al importar desde incidencias:', err);
    try {
      await logAction({
        accion: 'PERSONAL_IMPORT_ERROR',
        entidad: 'empleados',
        descripcion: 'Error al importar personal',
        detalle: { error: String(err) }
      });
    } catch (e) {}
    return { ok: false, error: err };
  }
}

async function schedulePersonalSync() {
  const cronExpr = '0 20 * * 5'; // Viernes 20:00
  const timezone = process.env.PERSONAL_SYNC_TZ || process.env.TZ || 'America/Mexico_City';
  cron.schedule(cronExpr, async () => {
    console.log('[PersonalSync] Ejecutando sincronización automática de personal...');
    const result = await importEmployeesAndLog('auto');
    if (result.ok) {
      console.log(`[PersonalSync] Importados/actualizados: ${result.importados}`);
    } else {
      console.error('[PersonalSync] Error en importación automática:', result.error);
    }
  }, { timezone });
}

module.exports = { schedulePersonalSync, importEmployeesAndLog };