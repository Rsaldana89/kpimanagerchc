/*
 * Employee Sync Scheduler
 *
 * Este módulo define un programador (cron) que sincroniza
 * automáticamente la información de los empleados desde la base
 * "incidencias" hacia la base principal de KPIs. La lógica de
 * sincronización replica lo que hace la ruta POST
 * /personal/import-puestos: actualiza el correo electrónico y,
 * cuando el nombre de puesto difiere, actualiza también el puesto,
 * el departamento y la sucursal de cada empleado. Los empleados
 * marcados como "BAJA" se mueven al departamento BAJA y se deshabilita
 * su acceso.
 *
 * Además de ejecutar la sincronización en un horario programado,
 * este módulo mantiene un registro de la última fecha/hora de
 * sincronización en un archivo JSON dentro del directorio de
 * servicios. Este valor puede consultarse desde las rutas para
 * mostrar al usuario cuándo se realizó la última sincronización
 * (ya sea manual o por el cron).
 */

const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { pool, incidenciasPool } = require('../db');

// === Helpers importados de routes/employees.js ===
// Copia de utilidades para normalizar textos y resolver puestos y departamentos.

// Normaliza strings para comparaciones:
//  - trim
//  - colapsa espacios múltiples
//  - quita acentos/diacríticos (p.ej. PRODUCCIÓN -> PRODUCCION)
//  - UPPER
function normUpper(v) {
  return String(v || '')
    .trim()
    .replace(/\s+/g, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

// Cache simple de ids de departamentos por nombre (en UPPER)
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

// Asegura que exista un departamento con ese nombre (case-insensitive) y regresa su id.
// Se usa para BAJA durante importaciones para no depender de una migración previa.
async function ensureDepartamentoIdByNombreUpper(nombreUpper) {
  const key = normUpper(nombreUpper);
  if (!key) return null;
  let id = await getDepartamentoIdByNombreUpper(key);
  if (id) return id;
  try {
    // Intentar crearlo (si ya existe, puede fallar por UNIQUE; lo ignoramos)
    await pool.execute('INSERT INTO departamentos (nombre) VALUES (?)', [key]);
  } catch (e) {
    // ignore
  }
  // Re-consultar
  deptIdCache.delete(key);
  id = await getDepartamentoIdByNombreUpper(key);
  return id;
}

// Construye un resolver para elegir el puesto "correcto" cuando existen duplicados
// del mismo nombre en distintos departamentos (caso típico: EYE).
async function buildPuestoResolver() {
  const [puestosRows] = await pool.execute(
    'SELECT id, nombre, departamento_id FROM puestos'
  );
  const [deptRows] = await pool.execute(
    'SELECT id, nombre FROM departamentos'
  );

  const deptNameById = new Map();
  const deptIdByNameUpper = new Map();
  for (const d of deptRows) {
    const up = normUpper(d.nombre);
    deptNameById.set(Number(d.id), up);
    deptIdByNameUpper.set(up, Number(d.id));
  }

  // Mapa: NOMBRE_UPPER -> [puestos]
  const puestosByName = new Map();
  // Mapa: NOMBRE_UPPER|DEPTO_UPPER -> [puestos]
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

  // Resolver principal
  // Devuelve el id del puesto local que corresponde con el nombre y departamento remotos.
  // Maneja casos donde existen duplicados de nombre en múltiples departamentos (p. ej. EYE vs no-EYE).
  function resolvePuestoLocal(remotePuestoName, remoteDeptName) {
    const puestoNameU = normUpper(remotePuestoName);
    const deptNameU = normUpper(remoteDeptName);
    const isEYE = deptNameU.startsWith('EYE');

    let candidates = [];
    if (isEYE) {
      // Si el departamento remoto es EYE, se intenta encontrar el puesto exacto por nombre+departamento.
      candidates = getByNameDept(puestoNameU, deptNameU);
      if (!candidates.length) {
        // No hay un puesto con ese nombre en este mismo departamento EYE.
        // Buscar algún puesto con ese nombre en CUALQUIER departamento EYE y usar el primero por id.
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
        // Como fallback, intenta "OTRO" del mismo departamento
        candidates = getByNameDept('OTRO', deptNameU);
      }
    } else {
      // Para departamentos que no son EYE: buscar por nombre solamente.
      const nameCandidates = getByName(puestoNameU);
      // Si se reconoce el nombre del departamento remoto (y no es vacío), intentar match exacto nombre+departamento primero
      if (nameCandidates.length && deptNameU) {
        const deptMatches = getByNameDept(puestoNameU, deptNameU);
        if (deptMatches && deptMatches.length) {
          candidates = deptMatches;
        }
      }
      // Si aún no hay candidatos específicos, usar los candidatos por nombre
      if (!candidates || candidates.length === 0) {
        candidates = nameCandidates;
      }
      // Cuando hay duplicados de nombre entre EYE y otros departamentos, priorizar los NO-EYE si el depto remoto no es EYE.
      if (candidates && candidates.length > 1) {
        const nonEye = candidates.filter(c => {
          const dname = deptNameById.get(Number(c.departamento_id)) || '';
          return !dname.startsWith('EYE');
        });
        if (nonEye.length) {
          candidates = nonEye;
        }
      }
      // Si no se encontró ningún candidato (nombre inexistente), usar "OTRO" genérico
      if (!candidates || candidates.length === 0) {
        candidates = getByName('OTRO');
      }
    }
    if (candidates && candidates.length) {
      // Determinístico: ordenar por id para que siempre elija el mismo cuando hay varios
      candidates.sort((a, b) => a.id - b.id);
      return candidates[0].id;
    }
    // fallback absoluto a cualquier puesto si no hay candidatos
    const any = puestosRows[0];
    return any ? Number(any.id) : null;
  }

  return {
    resolvePuestoLocal,
    deptNameById,
    deptIdByNameUpper
  };
}

// Determina el departamento de destino, la sucursal (si aplica) y el nombre de departamento
// que debe usarse para la resolución del puesto al importar personal desde incidencias.
// Devuelve un objeto con:
// { deptId, sucursalId, deptForPuesto, esBaja }
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
    // Buscar coincidencia exacta por nombre (después de normalizar)
    let matchId = deptIdByNameUpper.get(depUpper) || null;
    if (!matchId) {
      // Para nombres que empiezan con "EYE" no siempre hay coincidencia exacta en el catálogo.
      // Intentamos coincidencias parciales más flexibles:
      if (depUpper.startsWith('EYE')) {
        // 1) Buscar un departamento cuyo nombre normalizado incluya el nombre remoto completo
        for (const [nameU, id] of deptIdByNameUpper.entries()) {
          if (nameU.includes(depUpper)) {
            matchId = id;
            break;
          }
        }
        // 2) Si no se encontró, buscar donde el nombre remoto incluya al nombre del catálogo
        if (!matchId) {
          for (const [nameU, id] of deptIdByNameUpper.entries()) {
            if (depUpper.includes(nameU)) {
              matchId = id;
              break;
            }
          }
        }
        // 3) Como último recurso, seleccionar cualquier departamento cuyo nombre contenga "EYE"
        if (!matchId) {
          for (const [nameU, id] of deptIdByNameUpper.entries()) {
            if (nameU.includes('EYE')) {
              matchId = id;
              break;
            }
          }
        }
        if (matchId) {
          deptName = departamentoOrigen;
          deptId = matchId;
        }
      }
    }
    if (matchId) {
      // Si se encontró coincidencia exacta o parcial, usarla
      deptName = departamentoOrigen;
      deptId = matchId;
    } else {
      // Departamento no existe: verificar si es una sucursal
      if (departamentoOrigen && departamentoOrigen.trim() !== '') {
        const [sucRows] = await pool.execute(
          'SELECT id FROM sucursales WHERE UPPER(TRIM(nombre)) = ?',
          [depUpper]
        );
        if (sucRows.length > 0) {
          sucursalId = sucRows[0].id;
        }
      }
    }
  }
  const deptForPuesto = deptName;
  return { deptId, sucursalId, deptForPuesto, esBaja };
}

// === Gestión de última sincronización ===
// Ruta del archivo donde se guarda la última fecha/hora de sincronización.
const lastSyncFile = path.join(__dirname, 'employee_last_sync.json');

/**
 * Convierte un objeto Date en una cadena legible en la zona horaria configurada.
 * La zona horaria por defecto es America/Mexico_City pero puede
 * configurarse con la variable de entorno EMPLOYEE_SYNC_DISPLAY_TZ o TZ.
 * El formato es YYYY-MM-DD HH:mm:ss (24h).
 */
function formatDateForDisplay(date) {
  const tz = process.env.EMPLOYEE_SYNC_DISPLAY_TZ || process.env.TZ || 'America/Mexico_City';
  // Intl.DateTimeFormat formatea según locale; usamos es-MX para ordenar dia/mes/año.
  const fmt = new Intl.DateTimeFormat('es-MX', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = fmt.formatToParts(date);
  // Reordenar a YYYY-MM-DD HH:mm:ss
  let y, m, d, hr, min, sec;
  for (const p of parts) {
    if (p.type === 'year') y = p.value;
    if (p.type === 'month') m = p.value;
    if (p.type === 'day') d = p.value;
    if (p.type === 'hour') hr = p.value;
    if (p.type === 'minute') min = p.value;
    if (p.type === 'second') sec = p.value;
  }
  return `${y}-${m}-${d} ${hr}:${min}:${sec}`;
}

/**
 * Actualiza el archivo de última sincronización con la fecha/hora actual.
 * Se guarda tanto el valor en formato ISO como en el formato local legible.
 */
async function updateLastSyncTime() {
  try {
    const now = new Date();
    const iso = now.toISOString();
    const display = formatDateForDisplay(now);
    const data = { iso, display };
    await fs.promises.writeFile(lastSyncFile, JSON.stringify(data), 'utf8');
  } catch (err) {
    console.error('No se pudo actualizar el registro de última sincronización:', err);
  }
}

/**
 * Obtiene la fecha/hora de la última sincronización registrada. Si el archivo
 * no existe o no se puede leer, devuelve null.
 * Retorna el campo `display` almacenado si está disponible, o el ISO si no.
 */
async function getLastSyncTime() {
  try {
    const content = await fs.promises.readFile(lastSyncFile, 'utf8');
    const data = JSON.parse(content);
    return data.display || data.iso || null;
  } catch (err) {
    return null;
  }
}

/**
 * Sincroniza empleados desde la tabla `personal` de la base de incidencias.
 * Actualiza correos y puestos/dep/sucursal según sea necesario. Registra
 * estadísticas de cuántos correos y puestos se actualizaron. Siempre que
 * encuentre un empleado con su departamento "BAJA" lo mueve a ese
 * departamento y deshabilita el login. Al finalizar se actualiza el
 * registro de última sincronización.
 */
async function syncEmployees() {
  try {
    // Resolver datos de puestos y departamentos locales.
    const { resolvePuestoLocal, deptIdByNameUpper } = await buildPuestoResolver();
    const [remotos] = await incidenciasPool.execute(
      `SELECT employee_number AS codigo,
              puesto AS puesto,
              department_name AS departamento,
              email AS correo
       FROM personal`
    );
    let correosActualizados = 0;
    let puestosActualizados = 0;
    let sucursalesActualizadas = 0;
    for (const emp of remotos) {
      const codigo = emp.codigo;
      // Normalizar el puesto y recortar sufijos como ' - CEDIS' o cualquier ' - ...'
      let puestoBase = String(emp.puesto || '').trim();
      const cutIdx = puestoBase.indexOf(' - ');
      if (cutIdx > 0) {
        puestoBase = puestoBase.substring(0, cutIdx).trim();
      }
      const departamentoOrigen = emp.departamento || '';
      const correo = emp.correo;
      // Buscar empleado existente
      const [existRows] = await pool.execute(
        `SELECT e.id, e.puesto_id, e.departamento_id, e.sucursal_id, e.correo
         FROM empleados e
         WHERE e.incidencia_id = ?
         LIMIT 1`,
        [codigo]
      );
      if (!existRows || existRows.length === 0) continue;
      const actual = existRows[0];
      // Actualizar correo si viene con valor
      if (correo !== undefined && correo !== null && String(correo).trim() !== '') {
        const [rEmail] = await pool.execute(
          `UPDATE empleados SET correo = ? WHERE incidencia_id = ?`,
          [String(correo).trim(), codigo]
        );
        if (rEmail && typeof rEmail.affectedRows === 'number' && rEmail.affectedRows > 0) {
          correosActualizados++;
        }
      }
      // Determinar destino (departamento, sucursal y si es BAJA)
      const { deptId, sucursalId: remoteSucursalId, deptForPuesto, esBaja } = await resolveImportDestino(departamentoOrigen, deptIdByNameUpper);
      if (esBaja) {
        // Mover a BAJA y deshabilitar login
        const bajaId = await ensureDepartamentoIdByNombreUpper('BAJA');
        if (bajaId) {
          await pool.execute(
            `UPDATE empleados SET departamento_id = ?, sucursal_id = NULL, login_enabled = 0 WHERE incidencia_id = ?`,
            [bajaId, codigo]
          );
          puestosActualizados++;
        }
        continue;
      }
      // Resolver puesto id local con el departamento calculado
      const puestoId = resolvePuestoLocal(puestoBase, deptForPuesto);
      // Determinar departamento final: si deptId no es null usarlo, si no usar el depto del puesto
      let departamentoId = deptId;
      if (!departamentoId) {
        const [pDept] = await pool.execute('SELECT departamento_id FROM puestos WHERE id = ? LIMIT 1', [puestoId]);
        departamentoId = pDept.length ? pDept[0].departamento_id : null;
      }
      // Determinar sucursal final: si remoteSucursalId es definido (departamento es sucursal), usarlo; de lo contrario, null
      const sucursalId = remoteSucursalId || null;
      // Si remote department es sucursal, forzar departamento OPERACIONES
      if (remoteSucursalId) {
        const [depOps] = await pool.execute('SELECT id FROM departamentos WHERE nombre = "OPERACIONES"');
        if (depOps.length > 0) {
          departamentoId = depOps[0].id;
        }
      }
      // Actualizar puesto, departamento y sucursal si difieren del actual
      if (String(actual.puesto_id) !== String(puestoId) || String(actual.departamento_id) !== String(departamentoId) || String(actual.sucursal_id || '') !== String(sucursalId || '')) {
        await pool.execute(
          `UPDATE empleados SET puesto_id = ?, departamento_id = ?, sucursal_id = ? WHERE incidencia_id = ?`,
          [puestoId, departamentoId, sucursalId, codigo]
        );
        puestosActualizados++;
      }
    }
    // Registrar hora de última sincronización
    await updateLastSyncTime();
    // Devuelve estadísticas por si quien lo invoca desea mostrarlas o registrarlas
    return { correosActualizados, puestosActualizados, sucursalesActualizadas };
  } catch (err) {
    console.error('Error al sincronizar empleados (servicio):', err);
    throw err;
  }
}

/**
 * Configura una tarea programada para ejecutar la sincronización de
 * empleados de manera periódica.  Por defecto la tarea se ejecuta
 * diariamente a las 03:00 hora local (America/Mexico_City). Esto puede
 * personalizarse mediante las variables de entorno:
 *  - EMPLOYEE_SYNC_ENABLED: "true" para habilitar la tarea (por defecto "true").
 *  - EMPLOYEE_SYNC_TIME: hora en formato HH:MM para ejecutar el cron diario (por defecto "03:00").
 *  - EMPLOYEE_SYNC_TZ: zona horaria IANA (por defecto "America/Mexico_City").
 */
function scheduleEmployeeSync() {
  let enabled = String(process.env.EMPLOYEE_SYNC_ENABLED || 'true').toLowerCase() === 'true';
  let timeStr = process.env.EMPLOYEE_SYNC_TIME || '03:00';
  const timezone = process.env.EMPLOYEE_SYNC_TZ || process.env.TZ || 'America/Mexico_City';
  if (!enabled) {
    console.log('[Employee Sync] Tarea programada deshabilitada por configuración');
    return;
  }
  // Descomponer hora:minuto; si hay error usar 03:00
  let hour = 3;
  let minute = 0;
  if (timeStr && /^\d{1,2}:\d{2}$/.test(timeStr)) {
    const [h, m] = timeStr.split(':').map(v => parseInt(v, 10));
    if (!isNaN(h) && h >= 0 && h < 24) hour = h;
    if (!isNaN(m) && m >= 0 && m < 60) minute = m;
  }
  const cronExpr = `${minute} ${hour} * * *`;
  cron.schedule(cronExpr, async () => {
    try {
      console.log(`[Employee Sync] Ejecutando sincronización programada (${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')} ${timezone})...`);
      const stats = await syncEmployees();
      console.log(`[Employee Sync] Sincronización completa. Correos actualizados: ${stats.correosActualizados}. Puestos/dep actualizados: ${stats.puestosActualizados}.`);
    } catch (err) {
      console.error('[Employee Sync] Error en sincronización programada:', err);
    }
  }, { timezone });
}

module.exports = {
  scheduleEmployeeSync,
  syncEmployees,
  updateLastSyncTime,
  getLastSyncTime
};