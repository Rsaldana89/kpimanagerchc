const express = require('express');
const router = express.Router();
const { pool } = require('../db');
// Logger helper to record significant actions in KPI manager
const { logAction } = require('../services/logger');
const isAuth = require('../middleware/isAuth');
const { requireRole } = require('../middleware/roles');
const { scoreKpi } = require('../services/kpiScoring');
const multer = require('multer');
// Importación de Excel (calificaciones masivas) - usamos memoria para evitar archivos temporales
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB
});

/*
 * Calcula el periodo por defecto basado en la fecha actual.  Si el día
 * del mes es menor o igual a 10, se considera que el periodo por
 * defecto corresponde al mes anterior; de lo contrario se toma el
 * mes actual.  Este comportamiento permite que, durante los
 * primeros 10 días del mes, se sigan mostrando y editando los
 * resultados del mes pasado.  El cálculo usa la fecha del
 * servidor (por ejemplo, la configuración de la PC donde corre
 * Node.js), de modo que cambiar el reloj del equipo afecta el
 * periodo que se selecciona.
 *
 * @param {Date} [now] Objeto Date opcional para pruebas; por
 *     defecto usa new Date().
 * @returns {{year:number, month:number}} Objeto con año y mes (1-12).
 */
function getDefaultPeriod(now = new Date()) {
  let year = now.getFullYear();
  let month = now.getMonth() + 1; // 1-12
  if (now.getDate() <= 10) {
    month -= 1;
    if (month < 1) {
      month = 12;
      year -= 1;
    }
  }
  return { year, month };
}
const ExcelJS = require('exceljs');

/*
 * Obtiene los KPIs asignados a un puesto determinado.  Devuelve una
 * lista con la definición completa de cada KPI (incluyendo rangos
 * máximos y mínimos).
 */
async function getKPIsByPosition(positionId) {
  const [rows] = await pool.execute(
    `SELECT k.*, pk.peso
     FROM puesto_kpis pk
     JOIN kpis k ON pk.kpi_id = k.id
     WHERE pk.puesto_id = ?`,
    [positionId]
  );
  return rows;
}

/*
 * Obtiene todos los KPIs que deben aparecer en el reporte anual histórico para un empleado.
 * Devuelve los KPIs que el empleado ya tiene capturados en el año dado (aunque esos KPIs
 * ya no pertenezcan a su puesto actual) más los KPIs asignados a su puesto actual.  Esto
 * permite que el reporte "Anual histórico" incluya resultados de puestos anteriores.
 *
 * @param {Object} params
 *   - employeeId: ID del empleado
 *   - year: Año a consultar
 *   - puestoActualId: ID del puesto actual del empleado (para incluir KPIs del puesto)
 *
 * @returns {Promise<Array>}  Lista de KPIs con sus pesos (si aplica)
 */
async function getKPIsAnnualHistorico({ employeeId, year, puestoActualId }) {
  const [rows] = await pool.execute(
    `SELECT DISTINCT k.id, k.nombre, k.objetivo, k.unidad,
            pk.peso
     FROM (
       -- KPIs ya capturados por el empleado en el año
       SELECT kr.kpi_id AS kpi_id
       FROM kpi_resultados kr
       WHERE kr.empleado_id = ? AND kr.anio = ?

       UNION

       -- KPIs asignados al puesto actual
       SELECT pk2.kpi_id AS kpi_id
       FROM puesto_kpis pk2
       WHERE pk2.puesto_id = ?
     ) x
     JOIN kpis k ON k.id = x.kpi_id
     LEFT JOIN puesto_kpis pk
       ON pk.kpi_id = k.id AND pk.puesto_id = ?
     ORDER BY k.nombre ASC`,
    [employeeId, year, puestoActualId, puestoActualId]
  );
  return rows;
}

/*
 * Obtiene los resultados de un empleado para un año dado.  El
 * resultado se devuelve como un objeto cuya clave es el kpi_id y
 * contiene otro objeto con los meses (1-12) y los valores
 * correspondientes.  Si no hay resultado para un mes se deja
 * undefined.
 */
async function getKpiResultsForEmployee(employeeId, year) {
  let rows = [];
  try {
    const [r] = await pool.execute(
      `SELECT kr.kpi_id, kr.mes, kr.valor, kr.color, kr.comentario,
              kr.visto_bueno, kr.visto_por, kr.visto_fecha,
              kr.revision_por, kr.revision_fecha, kr.revision_motivo,
              vp.nombre AS visto_nombre,
              rp.nombre AS revision_nombre
       FROM kpi_resultados kr
       LEFT JOIN empleados vp ON vp.id = kr.visto_por
       LEFT JOIN empleados rp ON rp.id = kr.revision_por
       WHERE kr.empleado_id = ? AND kr.anio = ?`,
      [employeeId, year]
    );
    rows = r;
  } catch (e) {
    // Compatibilidad: si columnas nuevas aún no existen (DB sin actualizar), cargamos sin romper.
    const [r] = await pool.execute(
      `SELECT kpi_id, mes, valor, color, visto_bueno, visto_por
       FROM kpi_resultados
       WHERE empleado_id = ? AND anio = ?`,
      [employeeId, year]
    );
    rows = r.map(x => ({
      ...x,
      comentario: null,
      visto_fecha: null,
      revision_por: null,
      revision_fecha: null,
      revision_motivo: null,
      visto_nombre: null,
      revision_nombre: null
    }));
  }
  const result = {};
  rows.forEach(row => {
    if (!result[row.kpi_id]) {
      result[row.kpi_id] = {};
    }
    result[row.kpi_id][row.mes] = {
      valor: row.valor,
      color: row.color,
      comentario: row.comentario,
      visto_bueno: row.visto_bueno,
      visto_por: row.visto_por,
      visto_fecha: row.visto_fecha,
      visto_nombre: row.visto_nombre,
      revision_por: row.revision_por,
      revision_fecha: row.revision_fecha,
      revision_motivo: row.revision_motivo,
      revision_nombre: row.revision_nombre
    };
  });
  return result;
}

// Determina si el usuario es el jefe DIRECTO de un empleado en base a la jerarquía de puestos.
// Regla: user es jefe directo si el puesto del empleado responde_a_id === user.puesto_id.
async function isDirectBossByPuesto(user, targetEmployeeId) {
  if (!targetEmployeeId || isNaN(targetEmployeeId)) return false;
  if (user.role === 'admin' || user.role === 'manager') return true;
  const [empRows] = await pool.execute(
    `SELECT e.puesto_id, p.responde_a_id
     FROM empleados e
     LEFT JOIN puestos p ON p.id = e.puesto_id
     WHERE e.id = ?
     LIMIT 1`,
    [targetEmployeeId]
  );
  if (!empRows.length) return false;
  const respondeA = empRows[0].responde_a_id;
  return (respondeA !== null && respondeA !== undefined) && (Number(respondeA) === Number(user.puesto_id));
}

// Determina si el empleado NO tiene jefe directo (su puesto no responde a nadie).
async function employeeHasNoDirectBoss(employeeId) {
  const [rows] = await pool.execute(
    `SELECT p.responde_a_id
     FROM empleados e
     LEFT JOIN puestos p ON p.id = e.puesto_id
     WHERE e.id = ?
     LIMIT 1`,
    [employeeId]
  );
  if (!rows.length) return true;
  return (rows[0].responde_a_id === null || rows[0].responde_a_id === undefined);
}

// Convierte valores (DB o formulario) a número de forma segura.
// Soporta coma decimal ("90,5") y strings DECIMAL de MySQL.
function toNumberOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace('%','').trim().replace(',', '.');
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// Nota: el cálculo de color ahora vive en services/kpiScoring.js y usa
// ÚNICAMENTE el modelo nuevo (thresholds / criterion).

// Obtiene retroalimentación (Fortalezas / Oportunidades / Compromisos) por empleado y periodo.
async function getFeedback(employeeId, year, month) {
  try {
    const [rows] = await pool.execute(
      `SELECT fortalezas, oportunidades, compromisos
       FROM retroalimentacion
       WHERE empleado_id = ? AND anio = ? AND mes = ?
       LIMIT 1`,
      [employeeId, year, month]
    );
    return rows.length ? rows[0] : { fortalezas: '', oportunidades: '', compromisos: '' };
  } catch (e) {
    // Si la tabla aún no existe (DB no actualizada), no rompemos el dashboard.
    return { fortalezas: '', oportunidades: '', compromisos: '' };
  }
}

/*
 * Construye de forma recursiva la lista de puestos subordinados a un
 * puesto dado.  Utiliza una estructura de datos cargada previamente
 * con todas las relaciones de reporte.
 */
function buildSubordinatePuestoIds(puestoId, puestoMap, visited = new Set()) {
  // Convert to number to handle string vs number equality
  const pid = Number(puestoId);
  let subordinates = [];
  for (const p of puestoMap) {
    // If responde_a_id is not numeric, attempt to convert; else compare strictly
    const respondsTo = (p.responde_a_id !== null && p.responde_a_id !== undefined) ? Number(p.responde_a_id) : null;
    if (respondsTo === pid) {
      const sid = Number(p.id);
      // Avoid cycles by checking visited set
      if (!visited.has(sid)) {
        visited.add(sid);
        subordinates.push(sid);
        const children = buildSubordinatePuestoIds(sid, puestoMap, visited);
        if (children && children.length) {
          subordinates = subordinates.concat(children);
        }
      }
    }
  }
  return subordinates;
}

/*
 * Construye de forma recursiva una estructura jerárquica de empleados subordinados
 * a un puesto dado.  Para cada puesto subordinado directo se buscan los
 * empleados que ocupan ese puesto y se recopila su lista de KPIs, sus
 * resultados y sus propios subordinados (si los hay) en la misma estructura.
 * Devuelve un array de nodos con la forma:
 *  {
 *    empleado: { id, nombre, puesto_id, departamento_id, puesto_nombre, departamento_nombre },
 *    kpis: [...],
 *    resultados: {...},
 *    subordinados: [...] // nodos hijos
 *  }
 *
 * Se pasa el año como parámetro para poder obtener los resultados del periodo deseado.
 */
/**
 * Construye UNA SOLA CAPA de subordinados (puestos que responden directamente al puesto dado).
 *
 * Importante: no construye recursivamente todo el árbol.  Esto permite cargar el dashboard
 * más rápido y desplegar niveles bajo demanda (un nivel por click).
 */
async function buildDirectSubordinateNodes(currentUser, puestoId, puestoMap, year, month, showBajas = false, routeFilterId = null) {
  const directPuestos = puestoMap.filter(p => p.responde_a_id === puestoId).map(p => p.id);
  if (directPuestos.length === 0) return [];

  const nodes = [];
  const empIds = [];
  for (const subPuestoId of directPuestos) {
    // Construir la consulta base para los empleados de este subPuestoId.
    let sql = `SELECT e.id,
              e.incidencia_id,
              e.nombre,
              e.puesto_id,
              e.departamento_id,
              e.sucursal_id,
              s.nombre AS sucursal_nombre,
              COALESCE(sv.id, sr.ruta_id) AS ruta_id,
              COALESCE(sv.nombre, r.nombre) AS ruta_nombre,
              p.nombre AS puesto_nombre,
              d.nombre AS departamento_nombre
       FROM empleados e
       LEFT JOIN sucursales s ON s.id = e.sucursal_id
       LEFT JOIN supervision_rutas sv ON sv.nombre = s.nombre
       LEFT JOIN sucursal_supervision_ruta sr ON sr.sucursal_id = s.id AND sr.activo = 1
       LEFT JOIN supervision_rutas r ON r.id = sr.ruta_id
       LEFT JOIN puestos p ON e.puesto_id = p.id
       LEFT JOIN departamentos d ON e.departamento_id = d.id
       WHERE e.puesto_id = ? `;
    // Condición para bajas
    if (!showBajas) {
      sql += "AND (d.nombre IS NULL OR d.nombre <> 'BAJA') ";
    }
    // Condición de filtro por ruta: si se pasa un routeFilterId, filtrar empleados cuya ruta coincide
    // o no tienen sucursal asignada (e.sucursal_id IS NULL).  Esto evita ocultar colaboradores
    // que no tienen ruta asignada mientras restringe a los que sí la tienen.
    const params = [subPuestoId];
    if (routeFilterId !== null && routeFilterId !== undefined) {
      sql += "AND (COALESCE(sv.id, sr.ruta_id) = ? OR e.sucursal_id IS NULL) ";
      params.push(routeFilterId);
    }
    const [emps] = await pool.execute(sql, params);

    // Si no hay empleados en este puesto, buscamos en sus puestos hijos para incluirlos
    // directamente en este nivel.  Esto permite que los colaboradores de las categorías
    // inferiores aparezcan aunque el puesto intermedio no esté ocupado.
    let effectiveEmps = emps;
    if ((!effectiveEmps || effectiveEmps.length === 0) && routeFilterId !== null && routeFilterId !== undefined) {
      // Obtener puestos hijos
      const childPuestos = puestoMap
        .filter(pp => pp.responde_a_id !== null && pp.responde_a_id !== undefined && Number(pp.responde_a_id) === Number(subPuestoId))
        .map(pp => pp.id);
      if (childPuestos.length) {
        effectiveEmps = [];
        for (const childId of childPuestos) {
          let childSql = `SELECT e.id,
                    e.incidencia_id,
                    e.nombre,
                    e.puesto_id,
                    e.departamento_id,
                    e.sucursal_id,
                    s.nombre AS sucursal_nombre,
                    COALESCE(sv.id, sr.ruta_id) AS ruta_id,
                    COALESCE(sv.nombre, r.nombre) AS ruta_nombre,
                    p.nombre AS puesto_nombre,
                    d.nombre AS departamento_nombre
             FROM empleados e
             LEFT JOIN sucursales s ON s.id = e.sucursal_id
             LEFT JOIN supervision_rutas sv ON sv.nombre = s.nombre
             LEFT JOIN sucursal_supervision_ruta sr ON sr.sucursal_id = s.id AND sr.activo = 1
             LEFT JOIN supervision_rutas r ON r.id = sr.ruta_id
             LEFT JOIN puestos p ON e.puesto_id = p.id
             LEFT JOIN departamentos d ON e.departamento_id = d.id
             WHERE e.puesto_id = ? `;
          if (!showBajas) {
            childSql += "AND (d.nombre IS NULL OR d.nombre <> 'BAJA') ";
          }
          const childParams = [childId];
          // Filtro de ruta para hijos: mismos criterios que arriba
          childSql += "AND (COALESCE(sv.id, sr.ruta_id) = ? OR e.sucursal_id IS NULL) ";
          childParams.push(routeFilterId);
          const [childRows] = await pool.execute(childSql, childParams);
          if (childRows && childRows.length) {
            effectiveEmps.push(...childRows);
          }
        }
      }
    }

    // Agregar empleados efectivos al arreglo de nodos
    if (effectiveEmps && effectiveEmps.length) {
      for (const emp of effectiveEmps) {
        const subKpis = await getKPIsByPosition(emp.puesto_id);
        const subRes = await getKpiResultsForEmployee(emp.id, year);
        const hasChildren = puestoMap.some(p => p.responde_a_id === emp.puesto_id);
        let canApprove = await isDirectBossByPuesto(currentUser, emp.id);
        // Si un Auxiliar de Supervisión (puesto 45) está fungiendo como líder de ruta,
        // permitimos aprobar/enviar a revisión dentro de su ruta aunque su puesto no tenga colgantes.
        if (!canApprove && Number(currentUser.puesto_id) === 45 && routeFilterId !== null) {
          const empRuta = emp.ruta_id !== null ? Number(emp.ruta_id) : null;
          if (empRuta !== null && empRuta === Number(routeFilterId)) {
            canApprove = true;
          }
        }
        const canSendToReview = await canAccessEmployeeTree(currentUser, emp.id);
        nodes.push({ empleado: emp, kpis: subKpis, resultados: subRes, hasChildren, feedback: null, canApprove, canSendToReview });
        empIds.push(emp.id);
      }
    }
  }

  // Cargar retroalimentación del periodo para este nivel (en batch) si existe la tabla.
  if (empIds.length) {
    try {
      const placeholders = empIds.map(() => '?').join(',');
      const [fRows] = await pool.execute(
        `SELECT empleado_id, fortalezas, oportunidades, compromisos
         FROM retroalimentacion
         WHERE empleado_id IN (${placeholders}) AND anio = ? AND mes = ?`,
        [...empIds, year, month]
      );
      const fMap = new Map();
      fRows.forEach(r => fMap.set(r.empleado_id, {
        fortalezas: r.fortalezas || '',
        oportunidades: r.oportunidades || '',
        compromisos: r.compromisos || ''
      }));
      nodes.forEach(n => {
        n.feedback = fMap.get(n.empleado.id) || { fortalezas: '', oportunidades: '', compromisos: '' };
      });
    } catch (e) {
      // tabla no existe o error: dejar feedback vacío sin romper
      nodes.forEach(n => {
        n.feedback = { fortalezas: '', oportunidades: '', compromisos: '' };
      });
    }
  }
  return nodes;
}

/**
 * Validación: determina si el usuario actual puede consultar el subárbol de un empleado.
 * - admin/manager: siempre
 * - user: sólo si el empleado es él mismo o está dentro de su cadena de subordinación.
 */
async function canAccessEmployeeTree(user, targetEmployeeId) {
  if (user.role === 'admin' || user.role === 'manager') return true;
  if (targetEmployeeId === user.id) return true;

  const [puestos] = await pool.execute('SELECT id, responde_a_id FROM puestos');
  const subordinatePuestos = buildSubordinatePuestoIds(user.puesto_id, puestos);
  const [tRows] = await pool.execute('SELECT puesto_id FROM empleados WHERE id = ?', [targetEmployeeId]);
  const targetPuestoId = tRows.length ? Number(tRows[0].puesto_id) : null;
  const allowedByHierarchy = !!targetPuestoId && subordinatePuestos.includes(targetPuestoId);

  // -------------------------------------------------------------------
  // Restricción/adición por RUTA DE SUPERVISIÓN (solo para Operaciones):
  // - Un Supervisor de Sucursal (46) no debe poder ver/editar empleados
  //   de otras rutas.
  // - Un Auxiliar de Supervisión (45) asignado a una sucursal virtual
  //   "SUPERVISION X" puede fungir como líder de ruta temporal y acceder
  //   al mismo árbol de colaboradores que un supervisor, pero restringido
  //   a su ruta.
  //
  // Esto NO debe afectar el resto de departamentos (lógica tradicional).
  if (Number(user.puesto_id) !== 46 && Number(user.puesto_id) !== 45) {
    return allowedByHierarchy;
  }

  // Obtener contexto de ruta del usuario.
  let userRouteId = null;
  let userBranchName = '';
  try {
    const [uRows] = await pool.execute(
      `SELECT s.nombre AS sucursal_nombre,
              COALESCE(sv.id, sr.ruta_id) AS ruta_id
       FROM empleados e
       LEFT JOIN sucursales s ON s.id = e.sucursal_id
       LEFT JOIN supervision_rutas sv ON sv.nombre = s.nombre
       LEFT JOIN sucursal_supervision_ruta sr ON sr.sucursal_id = s.id AND sr.activo = 1
       WHERE e.id = ?
       LIMIT 1`,
      [user.id]
    );
    if (uRows && uRows.length) {
      userBranchName = uRows[0].sucursal_nombre || '';
      if (uRows[0].ruta_id !== null && uRows[0].ruta_id !== undefined) {
        userRouteId = Number(uRows[0].ruta_id);
      }
    }
  } catch (e) {
    // Si no podemos resolver ruta, devolvemos solo jerarquía.
    return allowedByHierarchy;
  }

  const userIsVirtual = !!(userBranchName && /^SUPERVISION\s+\d+$/i.test(String(userBranchName).trim()));
  const userIsRouteLeader = !!(userRouteId && (Number(user.puesto_id) === 46 || (Number(user.puesto_id) === 45 && userIsVirtual)));
  if (!userIsRouteLeader) {
    return allowedByHierarchy;
  }

  // Obtener ruta del empleado objetivo.
  let targetRouteId = null;
  try {
    const [trRows] = await pool.execute(
      `SELECT COALESCE(sv.id, sr.ruta_id) AS ruta_id
       FROM empleados e
       LEFT JOIN sucursales s ON s.id = e.sucursal_id
       LEFT JOIN supervision_rutas sv ON sv.nombre = s.nombre
       LEFT JOIN sucursal_supervision_ruta sr ON sr.sucursal_id = s.id AND sr.activo = 1
       WHERE e.id = ?
       LIMIT 1`,
      [targetEmployeeId]
    );
    if (trRows && trRows.length) {
      if (trRows[0].ruta_id !== null && trRows[0].ruta_id !== undefined) {
        targetRouteId = Number(trRows[0].ruta_id);
      }
    }
  } catch (e) {
    // Si no podemos resolver ruta del target, caemos a jerarquía.
    return allowedByHierarchy;
  }

  // Si el target pertenece a otra ruta, bloquear incluso si la jerarquía lo permitiría.
  if (targetRouteId !== null && targetRouteId !== userRouteId) {
    return false;
  }

  // Si jerarquía permite y no hay conflicto de ruta, permitir.
  if (allowedByHierarchy) return true;

  // Caso especial: Auxiliar de Supervisión (45) líder de ruta temporal.
  // No tiene puestos colgando, pero puede acceder al árbol del supervisor (46)
  // dentro de su ruta.
  if (Number(user.puesto_id) === 45 && targetRouteId !== null && targetRouteId === userRouteId) {
    // Permitir sólo para puestos subordinados al Supervisor de Sucursal (46)
    // y nunca para acceder a otros supervisores.
    const supSubPuestos = buildSubordinatePuestoIds(46, puestos);
    if (targetPuestoId && targetPuestoId !== 46 && supSubPuestos.includes(targetPuestoId)) {
      return true;
    }
  }

  return false;
}

/*
 * Ruta principal del dashboard: muestra los KPIs del usuario y de
 * sus subordinados directos e indirectos.  Permite ingresar
 * resultados para el periodo actual.  Para simplificar, los datos se
 * muestran para el año en curso.
 */
router.get('/', isAuth, async (req, res) => {
  try {
    const user = req.session.user;
    // Obtener año y mes seleccionados de la consulta; por defecto el año y mes actuales
    let selectedYear = parseInt(req.query.anio, 10);
    let selectedMonth = parseInt(req.query.mes, 10);
    // Si falta el año o el mes, utilizamos el periodo por defecto basado en la
    // fecha del servidor (ver getDefaultPeriod).  Esto permite que en los
    // primeros 10 días del mes se muestre el mes anterior por defecto.
    const def = getDefaultPeriod();
    if (!selectedYear || isNaN(selectedYear)) selectedYear = def.year;
    if (!selectedMonth || isNaN(selectedMonth) || selectedMonth < 1 || selectedMonth > 12) selectedMonth = def.month;
    // Obtener los KPIs asignados a este usuario a través de su puesto
    const kpis = await getKPIsByPosition(user.puesto_id);
    // Obtener los resultados del usuario para cada KPI y mes del año seleccionado
    const resultados = await getKpiResultsForEmployee(user.id, selectedYear);

    // No. de empleado para mostrar en UI (cabecera). No rompe si está vacío.
    const [meRows] = await pool.execute('SELECT incidencia_id, nombre FROM empleados WHERE id = ? LIMIT 1', [user.id]);
    const currentEmpNo = (meRows && meRows[0]) ? (meRows[0].incidencia_id || '') : '';
    const currentEmpName = (meRows && meRows[0]) ? (meRows[0].nombre || '') : '';
    // Retroalimentación (si la tabla no existe aún, regresa vacío sin romper el dashboard)
    const feedback = await getFeedback(user.id, selectedYear, selectedMonth);
    const showBajas = String(req.query.showBajas || '') === '1';

    // ---------------------------------------------------------------------
    // Determinar la sucursal y la ruta de supervisión del usuario.
    // La ruta puede derivarse de dos formas:
    //  - Si el usuario pertenece a una sucursal virtual (p.ej. "SUPERVISION 1"),
    //    esa sucursal coincide con el nombre de la ruta en supervision_rutas.
    //  - En caso contrario, la sucursal real puede estar mapeada en la tabla
    //    sucursal_supervision_ruta.  Se toma el id y nombre de la ruta allí.
    let currentRouteName = '';
    let currentBranchName = '';
    let currentRouteId = null;
    try {
      const [routeRows] = await pool.execute(
        `SELECT s.nombre AS sucursal_nombre,
                COALESCE(sv.id, sr.ruta_id) AS ruta_id,
                COALESCE(sv.nombre, r.nombre) AS ruta_nombre
         FROM empleados e
         LEFT JOIN sucursales s ON s.id = e.sucursal_id
         LEFT JOIN supervision_rutas sv ON sv.nombre = s.nombre
         LEFT JOIN sucursal_supervision_ruta sr ON sr.sucursal_id = s.id AND sr.activo = 1
         LEFT JOIN supervision_rutas r ON r.id = sr.ruta_id
         WHERE e.id = ?
         LIMIT 1`,
        [user.id]
      );
      if (routeRows && routeRows.length) {
        currentRouteName = routeRows[0].ruta_nombre || '';
        currentBranchName = routeRows[0].sucursal_nombre || '';
        currentRouteId = (routeRows[0].ruta_id !== undefined && routeRows[0].ruta_id !== null) ? Number(routeRows[0].ruta_id) : null;
      }
    } catch (err) {
      console.error('No se pudo determinar ruta del usuario:', err);
    }
    // Cargar el mapa de puestos (id, responde_a_id) para construir el árbol de subordinados
    const [puestos] = await pool.execute('SELECT id, responde_a_id FROM puestos');

    // ---------------------------------------------------------------------
    // IMPORTANTE:
    // El agrupado por rutas/sucursales (tarjetas) SOLO debe aplicar cuando el
    // usuario actúa como líder de ruta (Supervisor de Sucursal o Auxiliar de
    // Supervisión asignado a una sucursal virtual "SUPERVISION X").
    // Para el resto de puestos/departamentos, el dashboard debe mostrarse con
    // la lógica tradicional (sin agrupado por sucursal/ruta).
    const branchIsVirtual = !!(currentBranchName && /^SUPERVISION\s+\d+$/i.test(String(currentBranchName).trim()));
    const isRouteLeader = !!(currentRouteId && (Number(user.puesto_id) === 46 || (Number(user.puesto_id) === 45 && branchIsVirtual)));

    // Si es Auxiliar de Supervisión (45) pero asignado a una ruta, queremos que
    // vea el mismo árbol que un Supervisor (46) aunque no tenga puestos colgando.
    const effectiveTreeRootPuestoId = (isRouteLeader && Number(user.puesto_id) === 45)
      ? 46
      : Number(user.puesto_id);

    // Determinar si se debe filtrar por ruta en el nivel principal.
    const filterRouteId = isRouteLeader ? currentRouteId : null;

    // Construir SOLO el primer nivel de subordinados (puestos directos)
    const subordinateTree = await buildDirectSubordinateNodes(
      user,
      effectiveTreeRootPuestoId,
      puestos,
      selectedYear,
      selectedMonth,
      showBajas,
      filterRouteId
    );

    // Determinar si el usuario tiene subordinados directos y/o en todo su árbol
    const hasDirectSubordinates = Array.isArray(subordinateTree) && subordinateTree.length > 0;
    // Para verificar subordinados en cualquier nivel usamos buildSubordinatePuestoIds
    const subordinatePuestos = buildSubordinatePuestoIds(effectiveTreeRootPuestoId, puestos);
    const hasAnySubordinates = subordinatePuestos && subordinatePuestos.length > 0;
    // Construir lista de subordinados directos que a su vez tienen subordinados
    let subordinatesWithChildren = [];
    if (Array.isArray(subordinateTree)) {
      subordinatesWithChildren = subordinateTree
        .filter(node => node && node.hasChildren)
        .map(node => ({ id: node.empleado.id, nombre: node.empleado.nombre }));
    }
    // Reglas de aprobación: el usuario NO puede aprobarse a sí mismo si tiene jefe directo.
    const canApproveSelf = (await employeeHasNoDirectBoss(user.id));
    res.render('dashboard', {
      title: 'Mis KPIs',
      kpis,
      resultados,
      subordinateTree,
      feedback,
      currentEmpNo,
      currentEmpName,
      currentYear: selectedYear,
      selectedYear,
      selectedMonth,
      showBajas,
      canApproveSelf,
      hasDirectSubordinates,
      hasAnySubordinates,
      subordinatesWithChildren,
      currentRouteName,
      currentBranchName,
      isRouteLeader,
      useBranchGrouping: isRouteLeader
    });
  } catch (err) {
    console.error('Error al cargar el dashboard:', err);
    req.flash('error', 'Se produjo un error al cargar el dashboard');
    return res.redirect('/login');
  }
});

/**
 * GET /dashboard/subtree/:empleadoId
 * Devuelve (HTML) el siguiente nivel de subordinados DIRECTOS del empleado indicado.
 * Se usa para carga bajo demanda (un nivel por click) en la sección "KPIs de mi equipo".
 */
router.get('/subtree/:empleadoId', isAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const empleadoId = parseInt(req.params.empleadoId, 10);
    const anio = parseInt(req.query.anio, 10);
    const mes = parseInt(req.query.mes, 10);
    // Si no se especifica año o mes, usar periodo por defecto
    let year = parseInt(anio, 10);
    let month = parseInt(mes, 10);
    const def = getDefaultPeriod();
    if (!year || isNaN(year)) year = def.year;
    if (!month || isNaN(month) || month < 1 || month > 12) month = def.month;
	  const showBajas = String(req.query.showBajas || '') === '1';

    if (!empleadoId || isNaN(empleadoId)) {
      return res.status(400).send('Empleado inválido');
    }

    const allowed = await canAccessEmployeeTree(user, empleadoId);
    if (!allowed) {
      return res.status(403).send('Sin permisos');
    }

    // Obtener información del empleado objetivo (puesto + sucursal + ruta)
    const [empRows] = await pool.execute(
      `SELECT e.puesto_id,
              s.nombre AS sucursal_nombre,
              COALESCE(sv.id, sr.ruta_id) AS ruta_id
       FROM empleados e
       LEFT JOIN sucursales s ON s.id = e.sucursal_id
       LEFT JOIN supervision_rutas sv ON sv.nombre = s.nombre
       LEFT JOIN sucursal_supervision_ruta sr ON sr.sucursal_id = s.id AND sr.activo = 1
       WHERE e.id = ?
       LIMIT 1`,
      [empleadoId]
    );
    if (!empRows.length) {
      return res.status(404).send('Empleado no encontrado');
    }
    const targetPuestoId = Number(empRows[0].puesto_id);
    const targetSucursalNombre = empRows[0].sucursal_nombre || '';
    const targetRutaId = (empRows[0].ruta_id !== null && empRows[0].ruta_id !== undefined) ? Number(empRows[0].ruta_id) : null;

    // Cargar mapa de puestos (id, responde_a_id)
    const [puestos] = await pool.execute('SELECT id, responde_a_id FROM puestos');

    // El filtro por ruta y el agrupado por sucursal SOLO aplica cuando el nodo padre
    // es un líder de ruta (Supervisor 46 o Auxiliar 45 asignado a sucursal virtual).
    const targetIsVirtual = !!(targetSucursalNombre && /^SUPERVISION\s+\d+$/i.test(String(targetSucursalNombre).trim()));
    const isTargetRouteLeader = !!(targetRutaId && (targetPuestoId === 46 || (targetPuestoId === 45 && targetIsVirtual)));
    const parentRouteId = isTargetRouteLeader ? targetRutaId : null;
    const groupBySucursal = isTargetRouteLeader;

    // Si el padre es Auxiliar de Supervisión (45) asignado a ruta, se comporta como Supervisor (46)
    const effectiveTargetPuestoId = (isTargetRouteLeader && targetPuestoId === 45)
      ? 46
      : targetPuestoId;

    // Construir SOLO el siguiente nivel
    const nodes = await buildDirectSubordinateNodes(user, effectiveTargetPuestoId, puestos, year, month, showBajas, parentRouteId);

    // Renderizar solo el fragmento HTML del siguiente nivel
	  return res.render('partials/sub_kpi_level', {
      nodes,
      selectedYear: year,
      selectedMonth: month,
	    showBajas,
      groupBySucursal,
      layout: false
    });
  } catch (err) {
    console.error('Error al cargar subtree:', err);
    return res.status(500).send('Error al cargar nivel');
  }
});

/**
 * POST /dashboard/feedback/save
 * Guarda la retroalimentación del periodo (Fortalezas / Áreas de oportunidad / Compromisos).
 * Por simplicidad, la UI inicial lo usa para el empleado actual, pero se deja listo
 * para que admin/manager lo puedan usar también con empleado_id si se requiere.
 */
router.post('/feedback/save', isAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const { anio, mes, fortalezas, oportunidades, compromisos, empleado_id } = req.body;
    const year = parseInt(anio, 10);
    const month = parseInt(mes, 10);
    const targetEmployeeId = empleado_id && String(empleado_id).trim() !== '' ? parseInt(empleado_id, 10) : user.id;

    if (!year || !month) {
      return res.status(400).json({ ok: false, error: 'Periodo inválido' });
    }

    // Permisos: admin/manager siempre; user sólo él mismo o dentro de su árbol
    const allowed = await canAccessEmployeeTree(user, targetEmployeeId);
    if (!allowed) {
      return res.status(403).json({ ok: false, error: 'Sin permisos' });
    }

    await pool.execute(
      `INSERT INTO retroalimentacion (empleado_id, anio, mes, fortalezas, oportunidades, compromisos)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         fortalezas = VALUES(fortalezas),
         oportunidades = VALUES(oportunidades),
         compromisos = VALUES(compromisos)`,
      [targetEmployeeId, year, month, fortalezas || '', oportunidades || '', compromisos || '']
    );

    if ((req.get('X-Requested-With') || '').toLowerCase() === 'fetch') {
      return res.json({ ok: true });
    }

    req.flash('success', 'Retroalimentación guardada');
    return res.redirect(`/dashboard?anio=${year}&mes=${month}`);
  } catch (err) {
    console.error('Error guardando retroalimentación:', err);
    if ((req.get('X-Requested-With') || '').toLowerCase() === 'fetch') {
      return res.status(500).json({ ok: false, error: 'No se pudo guardar' });
    }
    req.flash('error', 'No se pudo guardar la retroalimentación');
    return res.redirect('/dashboard');
  }
});

/*
 * Ruta POST /dashboard/save
 * Permite guardar los resultados de los KPIs para el usuario actual.
 * Se espera que se envíen kpi_id, año, mes y valor.  El color se
 * calcula según los rangos definidos en el KPI si la unidad es
 * numérica o porcentaje.  Para valores de texto el color se puede
 * seleccionar manualmente desde la interfaz (campo opcional color).
 */
router.post('/save', isAuth, async (req, res) => {
  const user = req.session.user;
  // Si se envía un empleado_id diferente significa que el jefe está editando el KPI de un subordinado
  const { kpi_id, anio, mes, valor, color, empleado_id, comentario } = req.body;
  if (!kpi_id || !anio || !mes) {
    const msg = 'Datos insuficientes para guardar el resultado';
    if ((req.get('X-Requested-With') || '').toLowerCase() === 'fetch') {
      return res.status(400).json({ ok: false, error: msg });
    }
    req.flash('error', msg);
    return res.redirect(`/dashboard?anio=${anio || ''}&mes=${mes || ''}`);
  }
  try {
    const hasValue = !(valor === undefined || valor === null || String(valor).trim() === '');

    // Obtener definición del KPI para calcular color automáticamente (modelo nuevo)
    const [kpiRows] = await pool.execute(
      `SELECT id, unidad, score_type, direction, threshold_yellow, threshold_green,
              criterion_red, criterion_yellow, criterion_green
       FROM kpis WHERE id = ?`,
      [kpi_id]
    );
    if (kpiRows.length === 0) {
      const msg = 'El KPI especificado no existe';
      if ((req.get('X-Requested-With') || '').toLowerCase() === 'fetch') {
        return res.status(404).json({ ok: false, error: msg });
      }
      req.flash('error', msg);
      return res.redirect('/dashboard');
    }
    // Respetar color manual si viene explícito (compatibilidad),
    // pero por defecto calificar con la nueva lógica.
    const kpi = kpiRows[0];
    let resultadoColor = color || null;
    let score = null;

    if (hasValue) {
      if (!resultadoColor) {
        const r = scoreKpi(kpi, valor);
        resultadoColor = r.color;
        score = r.score;
      } else {
        score = resultadoColor === 'rojo' ? 40 : (resultadoColor === 'amarillo' ? 70 : (resultadoColor === 'verde' ? 100 : null));
      }
    }
    // Determinar a qué empleado aplicar el resultado
    const targetEmployeeId = empleado_id && String(empleado_id).trim() !== '' ? parseInt(empleado_id, 10) : user.id;
    // Verificar permisos: si el usuario no es admin ni manager, sólo puede guardar KPIs propios
    // o de colaboradores dentro de su árbol. Para Supervisión (Operaciones) se respeta la ruta.
    if (targetEmployeeId !== user.id && user.role !== 'admin' && user.role !== 'manager') {
      const allowed = await canAccessEmployeeTree(user, targetEmployeeId);
      if (!allowed) {
        const msg = 'No tiene permisos para editar los KPIs de este empleado';
        if ((req.get('X-Requested-With') || '').toLowerCase() === 'fetch') {
          return res.status(403).json({ ok: false, error: msg });
        }
        req.flash('error', msg);
        return res.redirect(`/dashboard?anio=${anio}&mes=${mes}`);
      }
    }
    // Candado: si el KPI ya fue cerrado (visto bueno), el colaborador no puede editar.
    // Solo el jefe que lo cerró o un jefe superior (o admin/manager) puede reabrir/editar.
    const [lockRows] = await pool.execute(
      `SELECT visto_bueno, visto_por FROM kpi_resultados
       WHERE empleado_id = ? AND kpi_id = ? AND anio = ? AND mes = ?
       LIMIT 1`,
      [targetEmployeeId, kpi_id, anio, mes]
    );
    const isLocked = lockRows.length && lockRows[0].visto_bueno === 1;
    const lockedBy = lockRows.length ? lockRows[0].visto_por : null;

    if (isLocked) {
      let canEditLocked = false;
      if (user.role === 'admin' || user.role === 'manager') {
        canEditLocked = true;
      } else if (lockedBy && user.id === lockedBy) {
        canEditLocked = true;
      } else if (lockedBy) {
        // Si el aprobador (lockedBy) está dentro del árbol del usuario, entonces el usuario es un jefe superior.
        canEditLocked = await canAccessEmployeeTree(user, lockedBy);
      }

      if (!canEditLocked) {
        const msg = 'Este KPI está cerrado por visto bueno. Solo tu jefe (o un jefe superior) puede reabrirlo.';
        if ((req.get('X-Requested-With') || '').toLowerCase() === 'fetch') {
          return res.status(423).json({ ok: false, locked: true, error: msg });
        }
        req.flash('error', msg);
        return res.redirect(`/dashboard?anio=${anio}&mes=${mes}`);
      }
    }

    // Insertar o actualizar resultado
    if (hasValue) {
      try {
        await pool.execute(
          `INSERT INTO kpi_resultados (empleado_id, kpi_id, anio, mes, valor, color, comentario)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             valor = VALUES(valor),
             color = VALUES(color),
             comentario = VALUES(comentario)`,
          [targetEmployeeId, kpi_id, anio, mes, valor, resultadoColor, comentario || null]
        );
      } catch (e) {
        // Si la columna comentario aún no existe, guardar sin comentario (DB sin actualizar)
        await pool.execute(
          `INSERT INTO kpi_resultados (empleado_id, kpi_id, anio, mes, valor, color)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE valor = VALUES(valor), color = VALUES(color)`,
          [targetEmployeeId, kpi_id, anio, mes, valor, resultadoColor]
        );
      }
      // Registrar log de guardado de KPI
      await logAction({
        accion: 'KPI_SAVE',
        entidad: 'kpi_resultados',
        entidadId: null,
        descripcion: 'Guardó calificación de KPI',
        detalle: {
          empleadoId: targetEmployeeId,
          kpiId: parseInt(kpi_id, 10),
          anio: parseInt(anio, 10),
          mes: parseInt(mes, 10),
          valor: valor,
          color: resultadoColor,
          comentario: comentario || null
        },
        req
      });
    } else {
      // Guardado de comentario sin tocar valor/color (evita sobrescrituras).
      try {
        await pool.execute(
          `INSERT INTO kpi_resultados (empleado_id, kpi_id, anio, mes, comentario)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE comentario = VALUES(comentario)`,
          [targetEmployeeId, kpi_id, anio, mes, comentario || null]
        );
      } catch (e) {
        // Si la columna comentario aún no existe, no rompemos.
        // En ese caso simplemente no guardamos comentario.
      }
      // Registrar log de comentario de KPI
      await logAction({
        accion: 'KPI_COMMENT_SAVE',
        entidad: 'kpi_resultados',
        entidadId: null,
        descripcion: 'Guardó comentario de KPI',
        detalle: {
          empleadoId: targetEmployeeId,
          kpiId: parseInt(kpi_id, 10),
          anio: parseInt(anio, 10),
          mes: parseInt(mes, 10),
          comentario: comentario || null
        },
        req
      });
    }
    // Si la petición viene vía fetch/AJAX, devolver JSON para evitar recargar el dashboard
    if ((req.get('X-Requested-With') || '').toLowerCase() === 'fetch') {
      // Calcular valores adicionales para puntaje ponderado y total del mes cuando sea posible.
      let puntajePonderado = null;
      let totalMesEmpleado = null;
      let colorResultadoMes = null;
      try {
        // Solo calcular si existe un score (para este KPI) y si existe un puesto asociado
        // Se requiere el puesto del empleado para conocer el peso de cada KPI
        const [empInfo] = await pool.execute(
          'SELECT puesto_id FROM empleados WHERE id = ? LIMIT 1',
          [targetEmployeeId]
        );
        const empPuestoId = (empInfo.length ? empInfo[0].puesto_id : null);
        if (empPuestoId) {
          // Obtener el peso de este KPI
          const [pesoRows] = await pool.execute(
            'SELECT peso FROM puesto_kpis WHERE puesto_id = ? AND kpi_id = ? LIMIT 1',
            [empPuestoId, kpi_id]
          );
          const pesoVal = (pesoRows.length ? parseFloat(pesoRows[0].peso) : null);
          if (score !== null && pesoVal && !isNaN(pesoVal)) {
            const pponder = score * (pesoVal / 100);
            // Redondear a 2 decimales
            puntajePonderado = Number(pponder.toFixed(2));
          }
          // Calcular el total ponderado del mes para el empleado
          // Obtener definiciones y pesos de todos los KPIs asignados a este puesto
          const [defs] = await pool.execute(
            `SELECT pk.kpi_id, pk.peso, k.score_type, k.direction, k.threshold_yellow,
                    k.threshold_green, k.criterion_red, k.criterion_yellow, k.criterion_green
             FROM puesto_kpis pk
             JOIN kpis k ON k.id = pk.kpi_id
             WHERE pk.puesto_id = ?`,
            [empPuestoId]
          );
          // Obtener valores capturados para este empleado en el mes
          const [resVals] = await pool.execute(
            'SELECT kpi_id, valor, color FROM kpi_resultados WHERE empleado_id = ? AND anio = ? AND mes = ?',
            [targetEmployeeId, anio, mes]
          );
          const valMap = new Map();
          resVals.forEach(r => {
            valMap.set(Number(r.kpi_id), r.valor);
          });
          let totalAcc = 0;
          defs.forEach(d => {
            const w = parseFloat(d.peso);
            if (!w || isNaN(w)) return;
            // Valor capturado (puede ser null)
            const rawVal = valMap.has(Number(d.kpi_id)) ? valMap.get(Number(d.kpi_id)) : null;
            // Calcular color/score para este KPI
            const { score: sc } = scoreKpi(d, rawVal);
            if (sc !== null && !isNaN(sc)) {
              totalAcc += sc * (w / 100);
            }
          });
          // Guardar total con hasta 2 decimales
          totalMesEmpleado = Number(totalAcc.toFixed(2));
          // Determinar color general
          // Ajuste de umbrales: rojo hasta 40.99, amarillo de 41 a 70.99, verde desde 71
          if (totalAcc >= 71) {
            colorResultadoMes = 'verde';
          } else if (totalAcc >= 41) {
            colorResultadoMes = 'amarillo';
          } else {
            colorResultadoMes = 'rojo';
          }
        }
      } catch (calcErr) {
        console.error('Error calculando puntajes ponderados:', calcErr);
      }
      return res.json({ ok: true, color: resultadoColor || null, puntaje: score, puntaje_ponderado: puntajePonderado, total_mes_empleado: totalMesEmpleado, color_resultado_mes: colorResultadoMes });
    }

    req.flash('success', 'Resultado guardado correctamente');
    return res.redirect(`/dashboard?anio=${anio}&mes=${mes}`);
  } catch (err) {
    console.error('Error al guardar resultado:', err);
    if ((req.get('X-Requested-With') || '').toLowerCase() === 'fetch') {
      return res.status(500).json({ ok: false, error: 'No se pudo guardar el resultado' });
    }
    req.flash('error', 'No se pudo guardar el resultado');
    return res.redirect('/dashboard');
  }
});

/*
 * Ruta POST /dashboard/visto
 * Marca un KPI como visto bueno para el usuario actual.  El jefe
 * también podrá marcar visto bueno para sus subordinados; en este
 * ejemplo simple sólo se marca para el usuario activo.  Se puede
 * ampliar para aceptar un parámetro empleado_id.
 */
router.post('/visto', isAuth, async (req, res) => {
  const user = req.session.user;
  const { kpi_id, anio, mes, empleado_id } = req.body;
  if (!kpi_id || !anio || !mes) {
    if ((req.get('X-Requested-With') || '').toLowerCase() === 'fetch') {
      return res.status(400).json({ ok: false, error: 'Datos insuficientes para marcar visto bueno' });
    }
    req.flash('error', 'Datos insuficientes para marcar visto bueno');
    return res.redirect(`/dashboard?anio=${anio || ''}&mes=${mes || ''}`);
  }
  try {
    const targetEmployeeId = empleado_id && String(empleado_id).trim() !== '' ? parseInt(empleado_id, 10) : user.id;
    // Reglas de aprobación (claras):
    // - Solo el JEFE DIRECTO puede aprobar (cerrar) a sus subordinados.
    // - El empleado NO puede aprobarse a sí mismo, excepto si NO tiene jefe directo.
    // - admin/manager siempre.
    // Seguridad: si se intenta aprobar a otra persona, validar que esté dentro de tu árbol permitido
    // (incluye restricción por ruta para supervisores y líderes de ruta).
    if (targetEmployeeId !== user.id) {
      const allowed = await canAccessEmployeeTree(user, targetEmployeeId);
      if (!allowed) {
        const msg = 'Sin permisos para aprobar a este colaborador.';
        if ((req.get('X-Requested-With') || '').toLowerCase() === 'fetch') {
          return res.status(403).json({ ok: false, error: msg });
        }
        req.flash('error', msg);
        return res.redirect(`/dashboard?anio=${anio}&mes=${mes}`);
      }
    }

    let canApprove = false;
    if (user.role === 'admin' || user.role === 'manager') {
      canApprove = true;
    } else if (targetEmployeeId === user.id) {
      canApprove = await employeeHasNoDirectBoss(user.id);
    } else {
      // Auxiliar de Supervisión (puesto 45) que funge como líder de ruta: puede aprobar dentro de su ruta.
      if (Number(user.puesto_id) === 45) {
        canApprove = true;
      } else {
        canApprove = await isDirectBossByPuesto(user, targetEmployeeId);
      }
    }
    if (!canApprove) {
      const msg = 'No tiene permisos para aprobar. Solo el jefe directo puede aprobar (o el empleado si no tiene jefe directo).';
      if ((req.get('X-Requested-With') || '').toLowerCase() === 'fetch') {
        return res.status(403).json({ ok: false, error: msg });
      }
      req.flash('error', msg);
      return res.redirect(`/dashboard?anio=${anio}&mes=${mes}`);
    }
    // Asegura que exista el registro para poder “cerrar” aunque aún no haya valor capturado.
    await pool.execute(
      `INSERT INTO kpi_resultados (empleado_id, kpi_id, anio, mes, visto_bueno, visto_por, visto_fecha,
                                  revision_por, revision_fecha, revision_motivo)
       VALUES (?, ?, ?, ?, 1, ?, NOW(), NULL, NULL, NULL)
       ON DUPLICATE KEY UPDATE
         visto_bueno = 1,
         visto_por = VALUES(visto_por),
         visto_fecha = NOW(),
         revision_por = NULL,
         revision_fecha = NULL,
         revision_motivo = NULL`,
      [targetEmployeeId, kpi_id, anio, mes, user.id]
    );

    if ((req.get('X-Requested-With') || '').toLowerCase() === 'fetch') {
      return res.json({ ok: true, locked: true, visto_por: user.id, visto_nombre: user.nombre || '', visto_fecha: new Date() });
    }
    req.flash('success', 'KPI cerrado con visto bueno');
    return res.redirect(`/dashboard?anio=${anio}&mes=${mes}`);
  } catch (err) {
    console.error('Error al marcar visto bueno:', err);
    if ((req.get('X-Requested-With') || '').toLowerCase() === 'fetch') {
      return res.status(500).json({ ok: false, error: 'No se pudo marcar visto bueno' });
    }
    req.flash('error', 'No se pudo marcar visto bueno');
    return res.redirect(`/dashboard?anio=${anio}&mes=${mes}`);
  }
});

/**
 * POST /dashboard/unlock
 * (Compat) Enviar a revisión: reabre un KPI, limpia aprobación y marca revisión.
 *
 * Regla: cualquier jefe en la cadena (incluye jefe del jefe) puede enviar a revisión.
 * El empleado NO debe auto-enviarse a revisión (salvo admin/manager).
 */
async function sendToReviewHandler(req, res) {
  const user = req.session.user;
  const { kpi_id, anio, mes, empleado_id, revision_motivo } = req.body;
  if (!kpi_id || !anio || !mes) {
    return res.status(400).json({ ok: false, error: 'Datos insuficientes' });
  }
  try {
    const targetEmployeeId = empleado_id && String(empleado_id).trim() !== '' ? parseInt(empleado_id, 10) : user.id;

    // Permisos base: ver/gestionar solo dentro de tu árbol (o todo si admin/manager)
    const allowed = await canAccessEmployeeTree(user, targetEmployeeId);
    if (!allowed) {
      return res.status(403).json({ ok: false, error: 'Sin permisos' });
    }

    // Si el usuario no es admin ni manager y está intentando enviarse a revisión a sí mismo,
    // permitirlo únicamente si NO tiene jefe directo.  De lo contrario, bloquear.
    if ((user.role !== 'admin' && user.role !== 'manager') && (targetEmployeeId === user.id)) {
      // Verificar si el empleado tiene jefe directo
      const noBoss = await employeeHasNoDirectBoss(user.id);
      if (!noBoss) {
        return res.status(403).json({ ok: false, error: 'No puedes enviarte a revisión a ti mismo.' });
      }
    }

    const motivo = (revision_motivo || '').toString().trim().slice(0, 255);

    // Upsert: reabre, limpia aprobación y marca revisión.
    await pool.execute(
      `INSERT INTO kpi_resultados (empleado_id, kpi_id, anio, mes, visto_bueno,
                                  visto_por, visto_fecha,
                                  revision_por, revision_fecha, revision_motivo)
       VALUES (?, ?, ?, ?, 0, NULL, NULL, ?, NOW(), ?)
       ON DUPLICATE KEY UPDATE
         visto_bueno = 0,
         visto_por = NULL,
         visto_fecha = NULL,
         revision_por = VALUES(revision_por),
         revision_fecha = NOW(),
         revision_motivo = VALUES(revision_motivo)`,
      [targetEmployeeId, kpi_id, anio, mes, user.id, motivo]
    );

    return res.json({ ok: true, locked: false, review: true, revision_por: user.id, revision_nombre: user.nombre || '', revision_fecha: new Date(), revision_motivo: motivo });
  } catch (err) {
    console.error('Error al reabrir KPI:', err);
    return res.status(500).json({ ok: false, error: 'No se pudo reabrir' });
  }
}

// Endpoint histórico ("Reabrir") -> ahora significa "Enviar a revisión".
router.post('/unlock', isAuth, sendToReviewHandler);

// Endpoint nuevo y más claro
router.post('/review', isAuth, sendToReviewHandler);


/* =========================
 * EXPORTACIÓN A EXCEL (0.87)
 * ========================= */

// Mes -> Nombre
const __MONTH_NAMES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
function monthName(m) {
  const i = (parseInt(m, 10) || 0) - 1;
  return (i >= 0 && i < 12) ? __MONTH_NAMES[i] : '';
}

function scoreFromColor(color) {
  if (color === 'rojo') return 40;
  if (color === 'amarillo') return 70;
  if (color === 'verde') return 100;
  return null;
}

function normalizeColor(color) {
  const c = String(color || '').trim().toLowerCase();
  if (c === 'red') return 'rojo';
  if (c === 'yellow') return 'amarillo';
  if (c === 'green') return 'verde';
  return c;
}

function statusFromResult(r) {
  if (r && Number(r.visto_bueno) === 1) return 'APROBADO';
  if (r && r.revision_por) return 'EN REVISIÓN';
  return 'ABIERTO';
}

function styleStatus(cell, status) {
  const s = String(status || '').toUpperCase();
  const styles = {
    'APROBADO':   { fg: 'FF00B050', font: 'FFFFFFFF' },
    'EN REVISIÓN': { fg: 'FFFFC000', font: 'FF000000' },
    'ABIERTO':    { fg: 'FFE7E6E6', font: 'FF000000' }
  };
  const st = styles[s];
  if (!st) return;
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: st.fg } };
  cell.font = { ...(cell.font || {}), bold: true, color: { argb: st.font } };
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
}

function toExcelDateOrBlank(v) {
  if (!v) return '';
  const d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d.getTime())) return '';
  return d;
}

async function getFeedbackMapForEmployee(employeeId, year, months) {
  const map = new Map();
  try {
    if (!months || months.length === 12) {
      const [rows] = await pool.execute(
        `SELECT mes, fortalezas, oportunidades, compromisos
         FROM retroalimentacion
         WHERE empleado_id = ? AND anio = ?`,
        [employeeId, year]
      );
      rows.forEach(r => map.set(Number(r.mes), {
        fortalezas: r.fortalezas || '',
        oportunidades: r.oportunidades || '',
        compromisos: r.compromisos || ''
      }));
    } else {
      const m = months[0];
      const fb = await getFeedback(employeeId, year, m);
      map.set(Number(m), {
        fortalezas: fb.fortalezas || '',
        oportunidades: fb.oportunidades || '',
        compromisos: fb.compromisos || ''
      });
    }
  } catch (e) {
    // sin tabla, sin feedback
  }
  return map;
}

function styleSemaforo(cell, color) {
  const c = normalizeColor(color);
  // ARGB
  const styles = {
    rojo:      { fg: 'FFFF0000', font: 'FFFFFFFF' }, // rojo fuerte, texto blanco
    amarillo:  { fg: 'FFFFFF00', font: 'FF000000' }, // amarillo, texto negro
    verde:     { fg: 'FF00B050', font: 'FFFFFFFF' }  // verde excel, texto blanco
  };
  if (!styles[c]) return;
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: styles[c].fg } };
  cell.font = { ...(cell.font || {}), bold: true, color: { argb: styles[c].font } };
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
}

function applyTableHeader(ws) {
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: ws.columnCount }
  };
}

function autoWidth(ws, min = 10, max = 45) {
  ws.columns.forEach(col => {
    let width = min;
    col.eachCell({ includeEmpty: true }, (cell) => {
      const v = cell.value;
      const s = (v === null || v === undefined) ? '' : String((typeof v === 'object' && v.text) ? v.text : v);
      width = Math.max(width, Math.min(max, s.length + 2));
    });
    col.width = width;
  });
}

async function fetchEmployeeInfo(employeeId) {
  const [rows] = await pool.execute(
    `SELECT e.id, e.incidencia_id, e.nombre, e.correo,
            p.nombre AS puesto_nombre,
            d.nombre AS departamento_nombre,
            s.nombre AS sucursal_nombre,
            e.puesto_id
     FROM empleados e
     LEFT JOIN puestos p ON e.puesto_id = p.id
     LEFT JOIN departamentos d ON e.departamento_id = d.id
     LEFT JOIN sucursales s ON e.sucursal_id = s.id
     WHERE e.id = ?
     LIMIT 1`,
    [employeeId]
  );
  return rows.length ? rows[0] : null;
}

async function fetchFeedbackMapForEmployee(employeeId, year) {
  const map = new Map(); // month -> {fortalezas,oportunidades,compromisos}
  try {
    const [rows] = await pool.execute(
      `SELECT mes, fortalezas, oportunidades, compromisos
       FROM retroalimentacion
       WHERE empleado_id = ? AND anio = ?`,
      [employeeId, year]
    );
    rows.forEach(r => map.set(Number(r.mes), {
      fortalezas: r.fortalezas || '',
      oportunidades: r.oportunidades || '',
      compromisos: r.compromisos || ''
    }));
  } catch (e) {
    // tabla no existe o error: devolver mapa vacío
  }
  return map;
}

async function fetchFeedbackBatch(empIds, year, monthOrNull) {
  const map = new Map(); // key empId|mes -> feedback
  if (!empIds || !empIds.length) return map;
  try {
    const place = empIds.map(() => '?').join(',');
    let sql = `SELECT empleado_id, mes, fortalezas, oportunidades, compromisos
               FROM retroalimentacion
               WHERE empleado_id IN (${place}) AND anio = ?`;
    const params = [...empIds, year];
    if (monthOrNull) {
      sql += ` AND mes = ?`;
      params.push(monthOrNull);
    }
    const [rows] = await pool.execute(sql, params);
    rows.forEach(r => map.set(`${r.empleado_id}|${r.mes}`, {
      fortalezas: r.fortalezas || '',
      oportunidades: r.oportunidades || '',
      compromisos: r.compromisos || ''
    }));
  } catch (e) {
    // tabla no existe o error: vacío
  }
  return map;
}

async function buildEmployeeWorkbook({ employeeId, year, month, mode }) {
  const emp = await fetchEmployeeInfo(employeeId);
  if (!emp) return null;

  // Determinar los KPIs a reportar según el modo.  Para el modo anual
  // siempre se incluyen los KPIs asignados al puesto actual y aquellos
  // KPIs que el empleado ya haya capturado en el año (histórico).  Para
  // el modo mensual se usan solo los KPIs del puesto actual.
  let kpis;
  if (mode === 'annual') {
    kpis = await getKPIsAnnualHistorico({ employeeId, year, puestoActualId: emp.puesto_id });
  } else {
    kpis = await getKPIsByPosition(emp.puesto_id);
  }
  const resultados = await getKpiResultsForEmployee(employeeId, year);
  const feedbackMap = await fetchFeedbackMapForEmployee(employeeId, year);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'KPI Manager CHC';
  wb.created = new Date();

  const ws = wb.addWorksheet('KPIs');
  ws.columns = [
    { header: 'No. Empleado', key: 'incidencia_id' },
    { header: 'Nombre', key: 'nombre' },
    { header: 'Puesto', key: 'puesto' },
    { header: 'Departamento', key: 'depto' },
    { header: 'Sucursal', key: 'sucursal' },
    { header: 'Año', key: 'anio' },
    { header: 'Mes', key: 'mes' },
    { header: 'KPI', key: 'kpi' },
    { header: 'Objetivo', key: 'objetivo' },
    { header: 'Unidad', key: 'unidad' },
    { header: 'Resultado', key: 'valor' },
    { header: 'Semáforo', key: 'semaforo' },
    { header: 'Puntaje base', key: 'puntaje' },
    // Peso (%) y puntaje ponderado proporcionan contexto sobre la contribución de cada KPI
    { header: 'Peso (%)', key: 'peso' },
    { header: 'Puntaje ponderado', key: 'puntaje_ponderado' },
    { header: 'Estado', key: 'estado' },
    { header: 'Aprobado por', key: 'aprobado_por' },
    { header: 'Fecha aprobación', key: 'aprobado_fecha' },
    { header: 'En revisión por', key: 'revision_por' },
    { header: 'Fecha revisión', key: 'revision_fecha' },
    { header: 'Motivo revisión', key: 'revision_motivo' },
    { header: 'Comentario KPI', key: 'comentario' },
    { header: 'Fortalezas', key: 'fortalezas' },
    { header: 'Áreas de oportunidad', key: 'oportunidades' },
    { header: 'Compromisos', key: 'compromisos' }
  ];

  const months = (mode === 'annual')
    ? Array.from({ length: 12 }, (_, i) => i + 1)
    : [month];

  months.forEach(m => {
    kpis.forEach(kpi => {
      const r = (resultados[kpi.id] && resultados[kpi.id][m]) || {};
      const color = normalizeColor(r.color || '');
      const puntaje = scoreFromColor(color);
      // Calcular peso (%).  kpi.peso puede ser string o número.  Convertir a número seguro.
      const pesoVal = toNumberOrNull(kpi.peso);
      // Puntaje ponderado = puntaje * peso/100.  Si puntaje es null o peso inválido, se deja vacío.
      let puntajePonderado = '';
      if (pesoVal !== null && typeof puntaje === 'number') {
        const ws = puntaje * (pesoVal / 100);
        // Redondear a 2 decimales y eliminar ceros extra
        puntajePonderado = ws.toFixed(2).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
      }
      const fb = feedbackMap.get(Number(m)) || { fortalezas: '', oportunidades: '', compromisos: '' };
      const estado = statusFromResult(r);
      ws.addRow({
        incidencia_id: emp.incidencia_id || '',
        nombre: emp.nombre || '',
        puesto: emp.puesto_nombre || '',
        depto: emp.departamento_nombre || '',
        sucursal: emp.sucursal_nombre || '',
        anio: year,
        mes: monthName(m) || m,
        kpi: kpi.nombre || '',
        objetivo: kpi.objetivo || '',
        unidad: kpi.unidad || '',
        valor: (r.valor !== undefined && r.valor !== null) ? r.valor : '',
        semaforo: color ? color.toUpperCase() : '',
        puntaje: (typeof puntaje === 'number') ? puntaje : '',
        peso: (pesoVal !== null) ? (Number(pesoVal).toFixed(2).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1')) : '',
        puntaje_ponderado: puntajePonderado,
        estado,
        aprobado_por: r.visto_nombre || '',
        aprobado_fecha: toExcelDateOrBlank(r.visto_fecha),
        revision_por: r.revision_nombre || '',
        revision_fecha: toExcelDateOrBlank(r.revision_fecha),
        revision_motivo: r.revision_motivo || '',
        comentario: r.comentario || '',
        fortalezas: fb.fortalezas || '',
        oportunidades: fb.oportunidades || '',
        compromisos: fb.compromisos || ''
      });
      const lastRow = ws.lastRow;
      // Aplicar estilo semáforo a la celda "Semáforo"
      const semCell = lastRow.getCell(ws.getColumn('semaforo').number);
      styleSemaforo(semCell, color);
      // Color también en "Resultado" para visual rápido
      const valCell = lastRow.getCell(ws.getColumn('valor').number);
      styleSemaforo(valCell, color);
      // Color en puntaje ponderado para consistencia visual
      const pponCell = lastRow.getCell(ws.getColumn('puntaje_ponderado').number);
      styleSemaforo(pponCell, color);

      // Estilo en Estado
      const stCell = lastRow.getCell(ws.getColumn('estado').number);
      styleStatus(stCell, estado);
    });
  });

  applyTableHeader(ws);
  autoWidth(ws);

  // Hoja retroalimentación (una fila por mes)
  const wsfb = wb.addWorksheet('Retroalimentación');
  wsfb.columns = [
    { header: 'Año', key: 'anio' },
    { header: 'Mes', key: 'mes' },
    { header: 'Fortalezas', key: 'fortalezas' },
    { header: 'Áreas de oportunidad', key: 'oportunidades' },
    { header: 'Compromisos', key: 'compromisos' }
  ];
  months.forEach(m => {
    const fb = feedbackMap.get(Number(m)) || { fortalezas: '', oportunidades: '', compromisos: '' };
    wsfb.addRow({
      anio: year,
      mes: monthName(m) || m,
      fortalezas: fb.fortalezas || '',
      oportunidades: fb.oportunidades || '',
      compromisos: fb.compromisos || ''
    });
  });
  applyTableHeader(wsfb);
  autoWidth(wsfb, 12, 70);

  // Hoja resumen
  const meta = wb.addWorksheet('Resumen');
  meta.columns = [
    { header: 'Campo', key: 'k' },
    { header: 'Valor', key: 'v' }
  ];
  meta.addRow({ k: 'Empleado', v: `${emp.nombre || ''}` });
  meta.addRow({ k: 'No. Empleado', v: `${emp.incidencia_id || ''}` });
  meta.addRow({ k: 'Puesto', v: `${emp.puesto_nombre || ''}` });
  meta.addRow({ k: 'Departamento', v: `${emp.departamento_nombre || ''}` });
  meta.addRow({ k: 'Sucursal', v: `${emp.sucursal_nombre || ''}` });
  meta.addRow({ k: 'Modo', v: (mode === 'annual') ? `Anual (${year})` : `Mensual (${monthName(month)} ${year})` });
  applyTableHeader(meta);
  autoWidth(meta, 12, 60);

  return { wb, emp };
}

async function buildTeamWorkbook({ user, year, month, mode, includeBajas, includeSelf = false, employees = null }) {
  // ------------------------------------------------------------------
  // Si recibimos una lista de empleados, la usamos tal cual (respetando el orden)
  // y NO aplicamos la lógica de jerarquía por puestos.
  // Esto se usa para exportaciones especiales (por ejemplo, exportar solo una ruta).
  let empsFinal = Array.isArray(employees) ? employees.filter(Boolean) : null;

  if (!empsFinal || !empsFinal.length) {
    const [puestos] = await pool.execute('SELECT id, responde_a_id FROM puestos');
    const subPuestos = buildSubordinatePuestoIds(user.puesto_id, puestos);
    if (!subPuestos.length) return null;

    const pPlace = subPuestos.map(() => '?').join(',');
    const params = [...subPuestos];

    const whereBajas = includeBajas ? '' : "AND (d.nombre IS NULL OR d.nombre <> 'BAJA')";

    const [emps] = await pool.execute(
      `SELECT e.id, e.incidencia_id, e.nombre,
              e.puesto_id,
              p.nombre AS puesto_nombre,
              d.nombre AS departamento_nombre,
              s.nombre AS sucursal_nombre
       FROM empleados e
       LEFT JOIN puestos p ON e.puesto_id = p.id
       LEFT JOIN departamentos d ON e.departamento_id = d.id
       LEFT JOIN sucursales s ON e.sucursal_id = s.id
       WHERE e.puesto_id IN (${pPlace})
       ${whereBajas}
       ORDER BY e.nombre`,
      params
    );
    empsFinal = [...emps];
  }

  // Si se solicita incluir los KPIs del usuario (jefe), obtener su registro
  if (includeSelf) {
    const [selfRows] = await pool.execute(
      `SELECT e.id, e.incidencia_id, e.nombre,
              e.puesto_id,
              p.nombre AS puesto_nombre,
              d.nombre AS departamento_nombre,
              s.nombre AS sucursal_nombre
       FROM empleados e
       LEFT JOIN puestos p ON e.puesto_id = p.id
       LEFT JOIN departamentos d ON e.departamento_id = d.id
       LEFT JOIN sucursales s ON e.sucursal_id = s.id
       WHERE e.id = ?
       LIMIT 1`,
      [user.id]
    );
    if (selfRows.length) {
      const already = empsFinal.some(emp => emp.id === user.id);
      if (!already) {
        // Insertar al inicio para que sus KPIs aparezcan primero
        empsFinal = [selfRows[0], ...empsFinal];
      }
    }
  }
  if (!empsFinal.length) return null;

  const empIds = empsFinal.map(e => e.id);
  const empPlace = empIds.map(() => '?').join(',');

  // KPIs por puesto
  const puestoIds = [...new Set(empsFinal.map(e => e.puesto_id))];
  const puestoPlace = puestoIds.map(() => '?').join(',');
  const [pkRows] = await pool.execute(
    `SELECT pk.puesto_id, k.*
     FROM puesto_kpis pk
     JOIN kpis k ON pk.kpi_id = k.id
     WHERE pk.puesto_id IN (${puestoPlace})
     ORDER BY pk.puesto_id, k.nombre`,
    puestoIds
  );
  const kpisByPuesto = new Map();
  pkRows.forEach(r => {
    const arr = kpisByPuesto.get(r.puesto_id) || [];
    arr.push(r);
    kpisByPuesto.set(r.puesto_id, arr);
  });

  // Resultados en batch
  const months = (mode === 'annual')
    ? null
    : [month];

  const resParams = [...empIds, year];
  let resSql = `SELECT kr.empleado_id, kr.kpi_id, kr.anio, kr.mes,
                       kr.valor, kr.color, kr.comentario,
                       kr.visto_bueno, kr.visto_por, kr.visto_fecha,
                       kr.revision_por, kr.revision_fecha, kr.revision_motivo,
                       vp.nombre AS visto_nombre,
                       rp.nombre AS revision_nombre
                FROM kpi_resultados kr
                LEFT JOIN empleados vp ON vp.id = kr.visto_por
                LEFT JOIN empleados rp ON rp.id = kr.revision_por
                WHERE kr.empleado_id IN (${empPlace}) AND kr.anio = ?`;
  if (months) {
    resSql += ` AND mes = ?`;
    resParams.push(month);
  }
  let resRows = [];
  try {
    const [rr] = await pool.execute(resSql, resParams);
    resRows = rr;
  } catch (e) {
    // DB sin columnas nuevas (compat)
    let resSql2 = `SELECT empleado_id, kpi_id, anio, mes, valor, color, visto_bueno, visto_por
                   FROM kpi_resultados
                   WHERE empleado_id IN (${empPlace}) AND anio = ?`;
    const resParams2 = [...empIds, year];
    if (months) { resSql2 += ` AND mes = ?`; resParams2.push(month); }
    const [rr] = await pool.execute(resSql2, resParams2);
    resRows = rr.map(x => ({
      ...x,
      comentario: null,
      visto_fecha: null,
      revision_por: null,
      revision_fecha: null,
      revision_motivo: null,
      visto_nombre: null,
      revision_nombre: null
    }));
  }

  const resMap = new Map(); // key: empId|kpiId|mes
  resRows.forEach(r => {
    resMap.set(`${r.empleado_id}|${r.kpi_id}|${r.mes}`, r);
  });

  const fbMap = await fetchFeedbackBatch(empIds, year, (mode === 'annual') ? null : month);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'KPI Manager CHC';
  wb.created = new Date();

  const ws = wb.addWorksheet('Equipo');
  ws.columns = [
    { header: 'No. Empleado', key: 'incidencia_id' },
    { header: 'Empleado', key: 'nombre' },
    { header: 'Puesto', key: 'puesto' },
    { header: 'Departamento', key: 'depto' },
    { header: 'Sucursal', key: 'sucursal' },
    { header: 'Año', key: 'anio' },
    { header: 'Mes', key: 'mes' },
    { header: 'KPI', key: 'kpi' },
    { header: 'Objetivo', key: 'objetivo' },
    { header: 'Unidad', key: 'unidad' },
    { header: 'Resultado', key: 'valor' },
    { header: 'Semáforo', key: 'semaforo' },
    { header: 'Puntaje base', key: 'puntaje' },
    { header: 'Peso (%)', key: 'peso' },
    { header: 'Puntaje ponderado', key: 'puntaje_ponderado' },
    { header: 'Estado', key: 'estado' },
    { header: 'Aprobado por', key: 'aprobado_por' },
    { header: 'Fecha aprobación', key: 'aprobado_fecha' },
    { header: 'En revisión por', key: 'revision_por' },
    { header: 'Fecha revisión', key: 'revision_fecha' },
    { header: 'Motivo revisión', key: 'revision_motivo' },
    { header: 'Comentario KPI', key: 'comentario' },
    { header: 'Fortalezas', key: 'fortalezas' },
    { header: 'Áreas de oportunidad', key: 'oportunidades' },
    { header: 'Compromisos', key: 'compromisos' }
  ];

  const monthList = (mode === 'annual') ? Array.from({ length: 12 }, (_, i) => i + 1) : [month];

  empsFinal.forEach(emp => {
    const kpis = kpisByPuesto.get(emp.puesto_id) || [];
    monthList.forEach(m => {
      kpis.forEach(kpi => {
        const r = resMap.get(`${emp.id}|${kpi.id}|${m}`) || {};
        const color = normalizeColor(r.color || '');
        const puntaje = scoreFromColor(color);
        // Calcular peso y puntaje ponderado
        const pesoVal = toNumberOrNull(kpi.peso);
        let puntajePonderado = '';
        if (pesoVal !== null && typeof puntaje === 'number') {
          const wsVal = puntaje * (pesoVal / 100);
          puntajePonderado = wsVal.toFixed(2).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
        }
        const fb = fbMap.get(`${emp.id}|${m}`) || { fortalezas: '', oportunidades: '', compromisos: '' };
        const estado = statusFromResult(r);
        ws.addRow({
          incidencia_id: emp.incidencia_id || '',
          nombre: emp.nombre || '',
          puesto: emp.puesto_nombre || '',
          depto: emp.departamento_nombre || '',
          sucursal: emp.sucursal_nombre || '',
          anio: year,
          mes: monthName(m) || m,
          kpi: kpi.nombre || '',
          objetivo: kpi.objetivo || '',
          unidad: kpi.unidad || '',
          valor: (r.valor !== undefined && r.valor !== null) ? r.valor : '',
          semaforo: color ? color.toUpperCase() : '',
          puntaje: (typeof puntaje === 'number') ? puntaje : '',
          peso: (pesoVal !== null) ? (Number(pesoVal).toFixed(2).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1')) : '',
          puntaje_ponderado: puntajePonderado,
          estado,
          aprobado_por: r.visto_nombre || '',
          aprobado_fecha: toExcelDateOrBlank(r.visto_fecha),
          revision_por: r.revision_nombre || '',
          revision_fecha: toExcelDateOrBlank(r.revision_fecha),
          revision_motivo: r.revision_motivo || '',
          comentario: r.comentario || '',
          fortalezas: fb.fortalezas || '',
          oportunidades: fb.oportunidades || '',
          compromisos: fb.compromisos || ''
        });
        const lastRow = ws.lastRow;
        styleSemaforo(lastRow.getCell(ws.getColumn('semaforo').number), color);
        styleSemaforo(lastRow.getCell(ws.getColumn('valor').number), color);
        // Estilo también en puntaje ponderado
        styleSemaforo(lastRow.getCell(ws.getColumn('puntaje_ponderado').number), color);
        styleStatus(lastRow.getCell(ws.getColumn('estado').number), estado);

        // --------------------------------------------
        // Destacar columnas editables y permitir edición
        // Resultado (valor) → fondo verde claro y desbloqueado
        const valorCell = lastRow.getCell(ws.getColumn('valor').number);
        valorCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFE8F5E9' }
        };
        valorCell.protection = { locked: false };

        // Comentario KPI → fondo amarillo claro y desbloqueado
        const comentarioCell = lastRow.getCell(ws.getColumn('comentario').number);
        comentarioCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFF8E1' }
        };
        comentarioCell.protection = { locked: false };
      });
    });
  });

  applyTableHeader(ws);
  autoWidth(ws);

  // Hoja de retroalimentación del equipo (1 fila por empleado y mes)
  const wsfb = wb.addWorksheet('Retroalimentación');
  wsfb.columns = [
    { header: 'No. Empleado', key: 'incidencia_id' },
    { header: 'Empleado', key: 'nombre' },
    { header: 'Año', key: 'anio' },
    { header: 'Mes', key: 'mes' },
    { header: 'Fortalezas', key: 'fortalezas' },
    { header: 'Áreas de oportunidad', key: 'oportunidades' },
    { header: 'Compromisos', key: 'compromisos' }
  ];
  empsFinal.forEach(emp => {
    monthList.forEach(m => {
      const fb = fbMap.get(`${emp.id}|${m}`) || { fortalezas: '', oportunidades: '', compromisos: '' };
      wsfb.addRow({
        incidencia_id: emp.incidencia_id || '',
        nombre: emp.nombre || '',
        anio: year,
        mes: monthName(m) || m,
        fortalezas: fb.fortalezas || '',
        oportunidades: fb.oportunidades || '',
        compromisos: fb.compromisos || ''
      });

      // Resaltar campos editables en la hoja de retroalimentación
      const fbRow = wsfb.lastRow;
      ['fortalezas', 'oportunidades', 'compromisos'].forEach(colKey => {
        const cell = fbRow.getCell(wsfb.getColumn(colKey).number);
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFF8E1' }
        };
        cell.protection = { locked: false };
      });
    });
  });
  applyTableHeader(wsfb);
  autoWidth(wsfb, 12, 70);

  const meta = wb.addWorksheet('Resumen');
  meta.columns = [
    { header: 'Campo', key: 'k' },
    { header: 'Valor', key: 'v' }
  ];
  meta.addRow({ k: 'Jefe', v: user.nombre || '' });
  meta.addRow({ k: 'No. colaboradores', v: String((empsFinal || []).length) });
  meta.addRow({ k: 'Modo', v: (mode === 'annual') ? `Anual (${year})` : `Mensual (${monthName(month)} ${year})` });
  meta.addRow({ k: 'Incluye BAJAS', v: includeBajas ? 'Sí' : 'No' });
  applyTableHeader(meta);
  autoWidth(meta, 12, 70);

  // Proteger las hojas para que sólo las celdas marcadas como desbloqueadas puedan editarse.
  // Esto se aplica a la hoja principal de KPIs (ws) y a la hoja de retroalimentación (wsfb).
  await ws.protect('', {
    selectLockedCells: true,
    selectUnlockedCells: true
  });
  await wsfb.protect('', {
    selectLockedCells: true,
    selectUnlockedCells: true
  });

  return wb;
}

/**
 * Exporta mis KPIs (mensual o anual)
 * GET /dashboard/export/self?anio=2026&mes=1&mode=period|annual
 */
router.get('/export/self', isAuth, async (req, res) => {
  const user = req.session.user;
  let year = parseInt(req.query.anio, 10);
  let month = parseInt(req.query.mes, 10);
  const def = getDefaultPeriod();
  if (!year || isNaN(year)) year = def.year;
  if (!month || isNaN(month) || month < 1 || month > 12) month = def.month;
  const modeQuery = String(req.query.mode || 'period').toLowerCase();
  // Consolidar cualquier valor "annual_historico" a "annual".  Se elimina el modo
  // separado porque ahora el reporte anual siempre incluye KPIs de puestos
  // anteriores.  Cualquier otro valor distinto de "annual" se trata como
  // "period".
  const mode = (modeQuery === 'annual' || modeQuery === 'annual_historico')
    ? 'annual'
    : 'period';

  try {
    const built = await buildEmployeeWorkbook({ employeeId: user.id, year, month, mode });
    if (!built) return res.status(404).send('Empleado no encontrado');

    // Construir nombre de archivo según el modo.  Para 'annual' usar sufijo "Anual", para
    // 'annual_historico' reutilizar el nombre del período (mes) ya que es anual pero
    // histórico (no se distingue en el nombre), y para 'period' usar año-mes.
    let filename;
    if (mode === 'annual') {
      filename = `KPIs_${built.emp.incidencia_id || user.id}_Anual_${year}.xlsx`;
    } else {
      filename = `KPIs_${built.emp.incidencia_id || user.id}_${year}-${String(month).padStart(2,'0')}.xlsx`;
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await built.wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('Error export self:', e);
    return res.status(500).send('No se pudo exportar');
  }
});

/**
 * Exporta KPIs de un empleado (si está en mi árbol)
 * GET /dashboard/export/employee/:empleadoId?anio=...&mes=...&mode=...
 */
router.get('/export/employee/:empleadoId', isAuth, async (req, res) => {
  const user = req.session.user;
  const employeeId = parseInt(req.params.empleadoId, 10);
  let year = parseInt(req.query.anio, 10);
  let month = parseInt(req.query.mes, 10);
  const def = getDefaultPeriod();
  if (!year || isNaN(year)) year = def.year;
  if (!month || isNaN(month) || month < 1 || month > 12) month = def.month;
  const modeQuery = String(req.query.mode || 'period').toLowerCase();
  // Normalizar el modo: annual_historico se trata como annual
  const mode = (modeQuery === 'annual' || modeQuery === 'annual_historico')
    ? 'annual'
    : 'period';

  try {
    if (!employeeId) return res.status(400).send('Empleado inválido');

    const allowed = await canAccessEmployeeTree(user, employeeId);
    if (!allowed) return res.status(403).send('Sin permisos');

    const built = await buildEmployeeWorkbook({ employeeId, year, month, mode });
    if (!built) return res.status(404).send('Empleado no encontrado');

    let filename;
    if (mode === 'annual') {
      filename = `KPIs_${built.emp.incidencia_id || employeeId}_Anual_${year}.xlsx`;
    } else {
      filename = `KPIs_${built.emp.incidencia_id || employeeId}_${year}-${String(month).padStart(2,'0')}.xlsx`;
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await built.wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('Error export employee:', e);
    return res.status(500).send('No se pudo exportar');
  }
});

/**
 * Exporta el equipo de una RUTA de supervisión (solo para líderes de ruta).
 *
 * - Supervisor de sucursal (puesto 46): exporta su ruta
 * - Auxiliar de supervisión (puesto 45) asignado a sucursal virtual SUPERVISION X: exporta su ruta
 *
 * GET /dashboard/export/route?anio=YYYY&mes=MM&mode=period|annual&showBajas=0|1
 */
router.get('/export/route', isAuth, async (req, res) => {
  const user = req.session.user;
  let year = parseInt(req.query.anio, 10);
  let month = parseInt(req.query.mes, 10);
  const def = getDefaultPeriod();
  if (!year || isNaN(year)) year = def.year;
  if (!month || isNaN(month) || month < 1 || month > 12) month = def.month;
  const mode = (String(req.query.mode || 'period').toLowerCase() === 'annual') ? 'annual' : 'period';
  const includeBajas = String(req.query.showBajas || '') === '1';

  try {
    // Determinar la ruta del usuario
    const [uRows] = await pool.execute(
      `SELECT e.puesto_id,
              s.nombre AS sucursal_nombre,
              COALESCE(sv.id, sr.ruta_id) AS ruta_id
       FROM empleados e
       LEFT JOIN sucursales s ON s.id = e.sucursal_id
       LEFT JOIN supervision_rutas sv ON sv.nombre = s.nombre
       LEFT JOIN sucursal_supervision_ruta sr ON sr.sucursal_id = s.id AND sr.activo = 1
       WHERE e.id = ?
       LIMIT 1`,
      [user.id]
    );
    if (!uRows.length) return res.status(404).send('Usuario no encontrado');

    const puestoId = Number(uRows[0].puesto_id);
    const sucursalNombre = String(uRows[0].sucursal_nombre || '').trim();
    const rutaId = uRows[0].ruta_id ? Number(uRows[0].ruta_id) : null;
    const isVirtual = /^SUPERVISION\s+\d+/i.test(sucursalNombre);
    const isRouteLeader = Boolean(rutaId) && (puestoId === 46 || (puestoId === 45 && isVirtual));
    if (!isRouteLeader) return res.status(403).send('Este usuario no tiene una ruta de supervisión asignada');

    // Obtener empleados de la ruta (sucursal virtual + sucursales reales mapeadas a la ruta)
    const whereBajas = includeBajas ? '' : "AND (d.nombre IS NULL OR d.nombre <> 'BAJA')";
    const [emps] = await pool.execute(
      `SELECT e.id, e.incidencia_id, e.nombre,
              e.puesto_id,
              p.nombre AS puesto_nombre,
              d.nombre AS departamento_nombre,
              s.nombre AS sucursal_nombre
       FROM empleados e
       LEFT JOIN puestos p ON e.puesto_id = p.id
       LEFT JOIN departamentos d ON e.departamento_id = d.id
       LEFT JOIN sucursales s ON s.id = e.sucursal_id
       LEFT JOIN supervision_rutas sv ON sv.nombre = s.nombre
       LEFT JOIN sucursal_supervision_ruta sr ON sr.sucursal_id = s.id AND sr.activo = 1
       WHERE COALESCE(sv.id, sr.ruta_id) = ?
       ${whereBajas}`,
      [rutaId]
    );

    // Asegurar que el usuario esté incluido (por si faltara por datos inconsistentes)
    const hasSelf = emps.some(e => e.id === user.id);
    if (!hasSelf) {
      const [selfRows] = await pool.execute(
        `SELECT e.id, e.incidencia_id, e.nombre,
                e.puesto_id,
                p.nombre AS puesto_nombre,
                d.nombre AS departamento_nombre,
                s.nombre AS sucursal_nombre
         FROM empleados e
         LEFT JOIN puestos p ON e.puesto_id = p.id
         LEFT JOIN departamentos d ON e.departamento_id = d.id
         LEFT JOIN sucursales s ON s.id = e.sucursal_id
         WHERE e.id = ?
         LIMIT 1`,
        [user.id]
      );
      if (selfRows.length) emps.unshift(selfRows[0]);
    }

    // Orden profesional: 1) Yo 2) Auxiliares de supervisión (sucursal virtual) 3) Sucursal por sucursal
    const norm = (v) => String(v || '').trim().toUpperCase();
    const isVirtualSucursal = (name) => /^SUPERVISION\s+\d+$/i.test(String(name || '').trim());
    const rolePriority = (puestoName) => {
      const p = norm(puestoName);
      if (p.includes('ENCARGADO')) return 0;
      if (p.includes('AUXILIAR')) return 1;
      if (p.includes('SUPERVISOR')) return 2;
      return 3;
    };

    const empsSorted = [...emps].sort((a, b) => {
      if (a.id === user.id && b.id !== user.id) return -1;
      if (b.id === user.id && a.id !== user.id) return 1;

      const aVirt = isVirtualSucursal(a.sucursal_nombre);
      const bVirt = isVirtualSucursal(b.sucursal_nombre);
      const aSec = aVirt ? 1 : 2;
      const bSec = bVirt ? 1 : 2;
      if (aSec !== bSec) return aSec - bSec;

      // Virtual: ordenar por puesto y nombre
      if (aSec === 1) {
        const rp = rolePriority(a.puesto_nombre) - rolePriority(b.puesto_nombre);
        if (rp !== 0) return rp;
        return norm(a.nombre).localeCompare(norm(b.nombre));
      }

      // Sucursales reales: agrupar por sucursal y dentro por rol (encargados primero)
      const sComp = norm(a.sucursal_nombre).localeCompare(norm(b.sucursal_nombre));
      if (sComp !== 0) return sComp;
      const rp = rolePriority(a.puesto_nombre) - rolePriority(b.puesto_nombre);
      if (rp !== 0) return rp;
      return norm(a.nombre).localeCompare(norm(b.nombre));
    });

    const wb = await buildTeamWorkbook({
      user,
      year,
      month,
      mode,
      includeBajas,
      includeSelf: false,
      employees: empsSorted
    });
    if (!wb) return res.status(404).send('No hay colaboradores para exportar');

    const filename = mode === 'annual'
      ? `KPIs_Ruta_${rutaId}_${year}_Anual.xlsx`
      : `KPIs_Ruta_${rutaId}_${year}-${String(month).padStart(2, '0')}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('Error export route team:', e);
    return res.status(500).send('No se pudo exportar');
  }
});

/**
 * Exporta TODOS los KPIs del equipo (árbol completo bajo el usuario)
 * GET /dashboard/export/team?anio=...&mes=...&mode=...
 * Opcional: showBajas=1 para incluir BAJA
 */
router.get('/export/team', isAuth, async (req, res) => {
  const user = req.session.user;
  let year = parseInt(req.query.anio, 10);
  let month = parseInt(req.query.mes, 10);
  const def = getDefaultPeriod();
  if (!year || isNaN(year)) year = def.year;
  if (!month || isNaN(month) || month < 1 || month > 12) month = def.month;
  const mode = (String(req.query.mode || 'period').toLowerCase() === 'annual') ? 'annual' : 'period';
  const includeBajas = String(req.query.showBajas || '') === '1';

  try {
    // Incluir los KPIs del propio usuario al inicio del reporte del equipo
    const includeSelfParam = String(req.query.includeSelf || '1');
    const includeSelf = includeSelfParam === '1' || includeSelfParam.toLowerCase() === 'true';
    const wb = await buildTeamWorkbook({ user, year, month, mode, includeBajas, includeSelf });
    if (!wb) return res.status(404).send('No hay colaboradores para exportar');

    const filename = mode === 'annual'
      ? `KPIs_Equipo_${year}_Anual.xlsx`
      : `KPIs_Equipo_${year}-${String(month).padStart(2,'0')}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('Error export team:', e);
    return res.status(500).send('No se pudo exportar');
  }
});

/**
 * Exporta KPIs del equipo de un subordinado específico.  Incluye al subordinado
 * seleccionado y a todos sus subordinados (árbol completo debajo de él).  Esta
 * opción sólo está disponible para el jefe que tiene acceso a ese subárbol.  El
 * parámetro includeSelf se fuerza a true para que se incluyan los KPIs del
 * colaborador como primera sección del reporte.
 *
 * GET /dashboard/export/subteam/:empleadoId?anio=YYYY&mes=MM&mode=period|annual&showBajas=0|1
 */
router.get('/export/subteam/:empleadoId', isAuth, async (req, res) => {
  const user = req.session.user;
  const employeeId = parseInt(req.params.empleadoId, 10);
  let year = parseInt(req.query.anio, 10);
  let month = parseInt(req.query.mes, 10);
  const def = getDefaultPeriod();
  if (!year || isNaN(year)) year = def.year;
  if (!month || isNaN(month) || month < 1 || month > 12) month = def.month;
  const modeQuery = String(req.query.mode || 'period').toLowerCase();
  const mode = (modeQuery === 'annual' || modeQuery === 'annual_historico') ? 'annual' : 'period';
  const includeBajas = String(req.query.showBajas || '') === '1';
  try {
    if (!employeeId) return res.status(400).send('Empleado inválido');
    // Verificar permiso sobre el subárbol del empleado
    const allowed = await canAccessEmployeeTree(user, employeeId);
    if (!allowed) return res.status(403).send('Sin permisos');
    // Obtener información del empleado para construir un usuario "falso" con su puesto
    const [empRows] = await pool.execute('SELECT id, puesto_id, incidencia_id, nombre FROM empleados WHERE id = ? LIMIT 1', [employeeId]);
    if (!empRows.length) return res.status(404).send('Empleado no encontrado');
    const emp = empRows[0];
    // Crear usuario temporal con puesto del colaborador.  Incluimos id y puesto_id.
    const tempUser = { id: emp.id, puesto_id: emp.puesto_id, role: user.role };
    const wb = await buildTeamWorkbook({ user: tempUser, year, month, mode, includeBajas, includeSelf: true });
    if (!wb) return res.status(404).send('No hay colaboradores para exportar');
    const filename = mode === 'annual'
      ? `KPIs_Equipo_${emp.incidencia_id || emp.id}_${year}_Anual.xlsx`
      : `KPIs_Equipo_${emp.incidencia_id || emp.id}_${year}-${String(month).padStart(2,'0')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('Error export subteam:', e);
    return res.status(500).send('No se pudo exportar');
  }
});

// ============================================================================
// IMPORTACIÓN MASIVA (EXCEL) - EQUIPO DE RUTA
// ============================================================================
function parseMesToNumber(mesVal) {
  if (mesVal === null || mesVal === undefined) return null;
  const mStr = String(mesVal).trim();
  if (!mStr) return null;
  const asNum = Number(mStr);
  if (Number.isFinite(asNum) && asNum >= 1 && asNum <= 12) return asNum;
  const up = mStr.toUpperCase();
  const idx = __MONTH_NAMES.findIndex(n => String(n).toUpperCase() === up);
  if (idx >= 0) return idx + 1;
  // Aceptar abreviaciones
  const abbrIdx = __MONTH_NAMES.findIndex(n => String(n).toUpperCase().startsWith(up));
  if (abbrIdx >= 0) return abbrIdx + 1;
  return null;
}

function cleanCellString(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && v.text) return String(v.text).trim();
  return String(v).trim();
}

router.post('/import/route', isAuth, upload.single('file'), async (req, res) => {
  const user = req.session.user;
  try {
    const year = parseInt(req.body.anio || req.query.anio, 10);
    const month = parseInt(req.body.mes || req.query.mes, 10);
    const def = getDefaultPeriod();
    const selectedYear = (Number.isFinite(year) && year > 2000) ? year : def.year;
    const selectedMonth = (Number.isFinite(month) && month >= 1 && month <= 12) ? month : def.month;

    if (!req.file || !req.file.buffer) {
      req.flash('error', 'No se recibió el archivo Excel (.xlsx).');
      return res.redirect(`/dashboard?anio=${selectedYear}&mes=${selectedMonth}`);
    }

    // Determinar contexto de ruta del usuario
    const [uRows] = await pool.execute(
      `SELECT e.puesto_id, s.nombre AS sucursal_nombre,
              COALESCE(sv.id, sr.ruta_id) AS ruta_id
       FROM empleados e
       LEFT JOIN sucursales s ON s.id = e.sucursal_id
       LEFT JOIN supervision_rutas sv ON sv.nombre = s.nombre
       LEFT JOIN sucursal_supervision_ruta sr ON sr.sucursal_id = s.id AND sr.activo = 1
       WHERE e.id = ?
       LIMIT 1`,
      [user.id]
    );
    if (!uRows.length) {
      req.flash('error', 'No se pudo determinar tu ruta.');
      return res.redirect(`/dashboard?anio=${selectedYear}&mes=${selectedMonth}`);
    }
    const userPuestoId = Number(uRows[0].puesto_id);
    const userRutaId = uRows[0].ruta_id !== null ? Number(uRows[0].ruta_id) : null;
    const userSucursalNombre = String(uRows[0].sucursal_nombre || '').trim();
    const userIsVirtual = /^SUPERVISION\s+\d+/i.test(userSucursalNombre);
    const userIsRouteLeader = !!userRutaId && (userPuestoId === 46 || (userPuestoId === 45 && userIsVirtual));
    if (!userIsRouteLeader) {
      req.flash('error', 'No tienes permisos para importar calificaciones masivas de una ruta.');
      return res.redirect(`/dashboard?anio=${selectedYear}&mes=${selectedMonth}`);
    }

    // Cargar workbook
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const wsEquipo = wb.getWorksheet('Equipo') || wb.worksheets[0];
    const wsRetro = wb.getWorksheet('Retroalimentación');

    if (!wsEquipo) {
      req.flash('error', 'El archivo no contiene la hoja "Equipo".');
      return res.redirect(`/dashboard?anio=${selectedYear}&mes=${selectedMonth}`);
    }

    // Mapear headers -> columna
    const headerRow = wsEquipo.getRow(1);
    const headerMap = {};
    headerRow.eachCell((cell, colNumber) => {
      const key = cleanCellString(cell.value).toUpperCase();
      if (key) headerMap[key] = colNumber;
    });
    const colEmpNo = headerMap['NO. EMPLEADO'] || headerMap['NO. EMPLEADO '] || headerMap['NO EMPLEADO'];
    const colKpi = headerMap['KPI'];
    const colYear = headerMap['AÑO'];
    const colMonth = headerMap['MES'];
    const colResultado = headerMap['RESULTADO'];
    const colComentario = headerMap['COMENTARIO KPI'] || headerMap['COMENTARIO'];

    if (!colEmpNo || !colKpi || !colYear || !colMonth) {
      req.flash('error', 'La hoja "Equipo" no tiene las columnas mínimas esperadas (No. Empleado, KPI, Año, Mes).');
      return res.redirect(`/dashboard?anio=${selectedYear}&mes=${selectedMonth}`);
    }

    // Leer filas y colectar claves
    const rowsToProcess = [];
    const empNoSet = new Set();
    const kpiNameSet = new Set();

    for (let r = 2; r <= wsEquipo.rowCount; r++) {
      const row = wsEquipo.getRow(r);
      const empNo = cleanCellString(row.getCell(colEmpNo).value);
      const kpiName = cleanCellString(row.getCell(colKpi).value);
      const rowYear = parseInt(cleanCellString(row.getCell(colYear).value), 10);
      const rowMonth = parseMesToNumber(row.getCell(colMonth).value);
      if (!empNo || !kpiName || !rowYear || !rowMonth) continue;
      // Solo procesar periodo seleccionado
      if (rowYear !== selectedYear || rowMonth !== selectedMonth) continue;

      const valorRaw = colResultado ? row.getCell(colResultado).value : null;
      const comentarioRaw = colComentario ? row.getCell(colComentario).value : null;
      const valorStr = cleanCellString(valorRaw);
      const comentarioStr = cleanCellString(comentarioRaw);
      if (!valorStr && !comentarioStr) continue;

      rowsToProcess.push({ empNo, kpiName, valorStr, comentarioStr, rowNum: r });
      empNoSet.add(empNo);
      kpiNameSet.add(kpiName);
    }

    if (!rowsToProcess.length && (!wsRetro || wsRetro.rowCount <= 1)) {
      req.flash('error', 'No se encontraron cambios para importar en el periodo seleccionado.');
      return res.redirect(`/dashboard?anio=${selectedYear}&mes=${selectedMonth}`);
    }

    // Cargar empleados del archivo (y su ruta) para validar
    const empNos = Array.from(empNoSet);
    const empNoPlace = empNos.map(() => '?').join(',');
    let empRows = [];
    if (empNos.length) {
      const [eRows] = await pool.execute(
        `SELECT e.id, e.incidencia_id, e.nombre, e.puesto_id,
                s.nombre AS sucursal_nombre,
                COALESCE(sv.id, sr.ruta_id) AS ruta_id
         FROM empleados e
         LEFT JOIN sucursales s ON s.id = e.sucursal_id
         LEFT JOIN supervision_rutas sv ON sv.nombre = s.nombre
         LEFT JOIN sucursal_supervision_ruta sr ON sr.sucursal_id = s.id AND sr.activo = 1
         WHERE e.incidencia_id IN (${empNoPlace})`,
        empNos
      );
      empRows = eRows;
    }
    const empByNo = new Map();
    empRows.forEach(e => empByNo.set(String(e.incidencia_id), e));

    // Cargar KPIs por nombre
    const kpiNames = Array.from(kpiNameSet);
    const kpiPlace = kpiNames.map(() => '?').join(',');
    let kpiRows = [];
    if (kpiNames.length) {
      const [kRows] = await pool.execute(
        `SELECT * FROM kpis WHERE nombre IN (${kpiPlace})`,
        kpiNames
      );
      kpiRows = kRows;
    }
    const kpiByName = new Map();
    kpiRows.forEach(k => kpiByName.set(String(k.nombre), k));

    // Pre-cargar locks existentes para el periodo
    const employeeIds = Array.from(new Set(empRows.map(e => Number(e.id)))).filter(Boolean);
    const kpiIds = Array.from(new Set(kpiRows.map(k => Number(k.id)))).filter(Boolean);
    const lockMap = new Map();
    if (employeeIds.length && kpiIds.length) {
      const empIdPlace = employeeIds.map(() => '?').join(',');
      const kpiIdPlace = kpiIds.map(() => '?').join(',');
      const [lockRows] = await pool.execute(
        `SELECT empleado_id, kpi_id, visto_bueno, visto_por
         FROM kpi_resultados
         WHERE empleado_id IN (${empIdPlace})
           AND kpi_id IN (${kpiIdPlace})
           AND anio = ? AND mes = ?`,
        [...employeeIds, ...kpiIds, selectedYear, selectedMonth]
      );
      lockRows.forEach(r => {
        lockMap.set(`${r.empleado_id}|${r.kpi_id}`, {
          visto_bueno: Number(r.visto_bueno) === 1,
          visto_por: r.visto_por !== null ? Number(r.visto_por) : null
        });
      });
    }

    // Procesar en transacción
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      let updated = 0;
      let inserted = 0;
      let skipped = 0;
      let lockedSkipped = 0;
      let notFound = 0;
      let outOfRoute = 0;

      for (const r of rowsToProcess) {
        const emp = empByNo.get(String(r.empNo));
        const kpi = kpiByName.get(String(r.kpiName));
        if (!emp || !kpi) {
          notFound++;
          continue;
        }
        const empRuta = emp.ruta_id !== null ? Number(emp.ruta_id) : null;
        if (empRuta !== userRutaId) {
          outOfRoute++;
          continue;
        }

        const lockKey = `${emp.id}|${kpi.id}`;
        const lockInfo = lockMap.get(lockKey);
        const isLocked = lockInfo ? !!lockInfo.visto_bueno : false;
        const lockedBy = lockInfo ? lockInfo.visto_por : null;

        let canEditLocked = false;
        if (isLocked) {
          if (user.role === 'admin' || user.role === 'manager') {
            canEditLocked = true;
          } else if (lockedBy && Number(lockedBy) === Number(user.id)) {
            canEditLocked = true;
          } else if (lockedBy) {
            // Si el usuario puede ver al aprobador, asumimos que puede editar (mismo criterio que el guardado manual)
            const canSeeApprover = await canAccessEmployeeTree(user, Number(lockedBy));
            canEditLocked = !!canSeeApprover;
          }
          if (!canEditLocked) {
            lockedSkipped++;
            continue;
          }
        }

        // Preparar cambios
        const changes = {};
        const hasValor = r.valorStr !== '';
        const hasComentario = r.comentarioStr !== '';
        if (!hasValor && !hasComentario) {
          skipped++;
          continue;
        }
        if (hasValor) {
          const asNum = Number(String(r.valorStr).replace(',', '.'));
          const finalValor = Number.isFinite(asNum) ? asNum : null;
          changes.valor = finalValor;
          if (finalValor !== null) {
            const score = scoreKpi(kpi, finalValor);
            // Solo se almacena el color (calculado) y no se persiste el puntaje en la tabla
            changes.color = score.color;
            // El puntaje se calcula dinámicamente en UI y no se guarda en base de datos
          }
        }
        if (hasComentario) {
          changes.comentario = r.comentarioStr;
        }

        // Upsert
        const [existsRows] = await conn.execute(
          'SELECT id FROM kpi_resultados WHERE empleado_id = ? AND kpi_id = ? AND anio = ? AND mes = ? LIMIT 1',
          [emp.id, kpi.id, selectedYear, selectedMonth]
        );
        if (existsRows.length) {
          const idRes = existsRows[0].id;
          const fields = [];
          const vals = [];
          if (Object.prototype.hasOwnProperty.call(changes, 'valor')) { fields.push('valor = ?'); vals.push(changes.valor); }
          if (Object.prototype.hasOwnProperty.call(changes, 'color')) { fields.push('color = ?'); vals.push(changes.color); }
          if (Object.prototype.hasOwnProperty.call(changes, 'comentario')) { fields.push('comentario = ?'); vals.push(changes.comentario); }
          if (fields.length === 0) { skipped++; continue; }
          fields.push('updated_at = NOW()');
          await conn.execute(`UPDATE kpi_resultados SET ${fields.join(', ')} WHERE id = ?`, [...vals, idRes]);
          updated++;
        } else {
          const insertVals = {
            empleado_id: emp.id,
            kpi_id: kpi.id,
            anio: selectedYear,
            mes: selectedMonth,
            valor: Object.prototype.hasOwnProperty.call(changes, 'valor') ? changes.valor : null,
            color: Object.prototype.hasOwnProperty.call(changes, 'color') ? changes.color : null,
            comentario: Object.prototype.hasOwnProperty.call(changes, 'comentario') ? changes.comentario : null
          };
          // Inserta únicamente las columnas existentes: valor, color y comentario
          await conn.execute(
            `INSERT INTO kpi_resultados (empleado_id, kpi_id, anio, mes, valor, color, comentario, visto_bueno, visto_por)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
            [insertVals.empleado_id, insertVals.kpi_id, insertVals.anio, insertVals.mes, insertVals.valor, insertVals.color, insertVals.comentario]
          );
          inserted++;
        }
      }

      // Retroalimentación (opcional)
      let retroUpdated = 0;
      if (wsRetro && wsRetro.rowCount > 1) {
        const retroHeader = wsRetro.getRow(1);
        const retroMap = {};
        retroHeader.eachCell((cell, colNumber) => {
          const key = cleanCellString(cell.value).toUpperCase();
          if (key) retroMap[key] = colNumber;
        });
        const rEmpNo = retroMap['NO. EMPLEADO'] || retroMap['NO EMPLEADO'];
        const rYear = retroMap['AÑO'];
        const rMonth = retroMap['MES'];
        const rFort = retroMap['FORTALEZAS'] || retroMap['FORTALEZAS Y'];
        const rOpor = retroMap['ÁREAS DE OPORTUNIDAD'] || retroMap['AREAS DE OPORTUNIDAD'];
        const rComp = retroMap['COMPROMISOS'];

        for (let rr = 2; rr <= wsRetro.rowCount; rr++) {
          const row = wsRetro.getRow(rr);
          const empNo = rEmpNo ? cleanCellString(row.getCell(rEmpNo).value) : '';
          const rowYear = rYear ? parseInt(cleanCellString(row.getCell(rYear).value), 10) : NaN;
          const rowMonth = rMonth ? parseMesToNumber(row.getCell(rMonth).value) : null;
          if (!empNo || !rowYear || !rowMonth) continue;
          if (rowYear !== selectedYear || rowMonth !== selectedMonth) continue;
          const emp = empByNo.get(String(empNo));
          if (!emp) continue;
          const empRuta = emp.ruta_id !== null ? Number(emp.ruta_id) : null;
          if (empRuta !== userRutaId) continue;

          const fortalezas = rFort ? cleanCellString(row.getCell(rFort).value) : '';
          const oportunidades = rOpor ? cleanCellString(row.getCell(rOpor).value) : '';
          const compromisos = rComp ? cleanCellString(row.getCell(rComp).value) : '';

          if (!fortalezas && !oportunidades && !compromisos) continue;

          await conn.execute(
            `INSERT INTO retroalimentacion (empleado_id, anio, mes, fortalezas, oportunidades, compromisos)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               fortalezas = VALUES(fortalezas),
               oportunidades = VALUES(oportunidades),
               compromisos = VALUES(compromisos),
               actualizado_en = CURRENT_TIMESTAMP`,
            [emp.id, selectedYear, selectedMonth, fortalezas, oportunidades, compromisos]
          );
          retroUpdated++;
        }
      }

      await conn.commit();

      // Log
      try {
        await logAction(user.id, user.nombre, `Importación masiva ruta ${userRutaId} (${selectedYear}-${selectedMonth}) | upd:${updated} ins:${inserted} retro:${retroUpdated} locked:${lockedSkipped} oor:${outOfRoute} nf:${notFound}`);
      } catch (_) {}

      const msg = `Importación completada. Actualizados: ${updated}, nuevos: ${inserted}, retroalimentación: ${retroUpdated}.` +
        (lockedSkipped ? ` Omitidos por Visto Bueno: ${lockedSkipped}.` : '') +
        (outOfRoute ? ` Fuera de tu ruta: ${outOfRoute}.` : '') +
        (notFound ? ` No encontrados: ${notFound}.` : '');
      req.flash('success', msg);
      return res.redirect(`/dashboard?anio=${selectedYear}&mes=${selectedMonth}`);
    } catch (txErr) {
      await conn.rollback();
      console.error('Error import route (tx):', txErr);
      req.flash('error', 'No se pudo importar. Verifica el archivo y vuelve a intentar.');
      return res.redirect(`/dashboard?anio=${selectedYear}&mes=${selectedMonth}`);
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('Error import route:', err);
    req.flash('error', 'No se pudo procesar el archivo de importación.');
    return res.redirect('/dashboard');
  }
});

/**
 * Enviar por correo mis propios resultados de KPIs para un periodo.
 * POST /dashboard/email/self?anio=YYYY&mes=MM
 * El periodo se infiere del cuerpo o de la query.  Si no se
 * especifica, utiliza el periodo por defecto.  Devuelve JSON con
 * información sobre si el correo fue enviado o se omitió porque ya
 * se había enviado.
 */
router.post('/email/self', isAuth, async (req, res) => {
  const user = req.session.user;
  if (!user) return res.status(401).json({ success: false, error: 'No autenticado' });
  let year = parseInt(req.body.anio || req.query.anio, 10);
  let month = parseInt(req.body.mes || req.query.mes, 10);
  const def = getDefaultPeriod();
  if (!year || isNaN(year)) year = def.year;
  if (!month || isNaN(month) || month < 1 || month > 12) month = def.month;
  const force = String(req.body.force ?? req.query.force ?? '').toLowerCase() === 'true' || String(req.body.force ?? req.query.force ?? '') === '1';
  try {
    const { sendIndividualKpiResults } = require('../services/kpiEmail');
    const result = await sendIndividualKpiResults({ employeeId: user.id, year, month, force });
    return res.json({
      success: true,
      skipped: !!result.skipped,
      forced: force,
      message: result.skipped ? 'Los resultados ya habían sido enviados anteriormente' : 'Correo enviado correctamente'
    });
  } catch (e) {
    console.error('Error enviando correo individual:', e);
    return res.status(500).json({ success: false, error: e.message || 'No se pudo enviar el correo' });
  }
});

/**
 * Enviar por correo los resultados de KPIs a todos los subordinados del usuario.
 * Sólo disponible para roles admin y manager.
 * POST /dashboard/email/team?anio=YYYY&mes=MM
 * Devuelve JSON con la cantidad de correos enviados.
 */
router.post('/email/team', isAuth, async (req, res) => {
  const user = req.session.user;
  if (!user) return res.status(401).json({ success: false, error: 'No autenticado' });
  // Verificar que el usuario tenga subordinados en cualquier nivel
  try {
    const [puestos] = await pool.execute('SELECT id, responde_a_id FROM puestos');
    const subordinatePuestos = buildSubordinatePuestoIds(user.puesto_id, puestos);
    if (!subordinatePuestos || subordinatePuestos.length === 0) {
      return res.status(403).json({ success: false, error: 'No tiene equipo subordinado para enviar' });
    }
  } catch (e) {
    console.error('Error al verificar subordinados:', e);
    return res.status(500).json({ success: false, error: 'Error interno al verificar subordinados' });
  }
  let year = parseInt(req.body.anio || req.query.anio, 10);
  let month = parseInt(req.body.mes || req.query.mes, 10);
  const def = getDefaultPeriod();
  if (!year || isNaN(year)) year = def.year;
  if (!month || isNaN(month) || month < 1 || month > 12) month = def.month;
  const includeSent = String(req.body.includeSent ?? req.query.includeSent ?? '').toLowerCase() === 'true' || String(req.body.includeSent ?? req.query.includeSent ?? '') === '1';
  try {
    const { sendSubordinateKpiResults } = require('../services/kpiEmail');
    const result = await sendSubordinateKpiResults({ bossId: user.id, year, month, includeSent });
    return res.json({ success: true, count: result.count, skipped: result.skipped || 0, includedSent: !!result.includedSent });
  } catch (e) {
    console.error('Error enviando correos al equipo:', e);
    return res.status(500).json({ success: false, error: e.message || 'No se pudo enviar el correo' });
  }
});

/**
 * Enviar por correo los resultados de KPIs a los subordinados directos del usuario.
 * Disponible para cualquier usuario que tenga subordinados directos.
 * POST /dashboard/email/direct?anio=YYYY&mes=MM
 * Devuelve JSON con la cantidad de correos enviados o un error si no hay subordinados directos.
 */
router.post('/email/direct', isAuth, async (req, res) => {
  const user = req.session.user;
  if (!user) return res.status(401).json({ success: false, error: 'No autenticado' });
  // Verificar que el usuario tenga subordinados directos
  try {
    const [directPuestos] = await pool.execute('SELECT id FROM puestos WHERE responde_a_id = ?', [user.puesto_id]);
    if (!directPuestos || directPuestos.length === 0) {
      return res.status(403).json({ success: false, error: 'No tiene subordinados directos para enviar' });
    }
  } catch (e) {
    console.error('Error al verificar subordinados directos:', e);
    return res.status(500).json({ success: false, error: 'Error interno al verificar subordinados directos' });
  }
  let year = parseInt(req.body.anio || req.query.anio, 10);
  let month = parseInt(req.body.mes || req.query.mes, 10);
  const def = getDefaultPeriod();
  if (!year || isNaN(year)) year = def.year;
  if (!month || isNaN(month) || month < 1 || month > 12) month = def.month;
  const includeSent = String(req.body.includeSent ?? req.query.includeSent ?? '').toLowerCase() === 'true' || String(req.body.includeSent ?? req.query.includeSent ?? '') === '1';
  try {
    const { sendDirectSubordinateKpiResults } = require('../services/kpiEmail');
    const result = await sendDirectSubordinateKpiResults({ bossId: user.id, year, month, includeSent });
    return res.json({ success: true, count: result.count, skipped: result.skipped || 0, includedSent: !!result.includedSent });
  } catch (e) {
    console.error('Error enviando correos a subordinados directos:', e);
    return res.status(500).json({ success: false, error: e.message || 'No se pudo enviar el correo' });
  }
});

// Exponer funciones de utilidad en el objeto router para ser reutilizadas en otros módulos.
// Al asignarlas como propiedades del router conservamos la exportación original
// (el router mismo) y permitimos que otros archivos requieran estas
// funciones a través de require('routes/dashboard').buildEmployeeWorkbook, etc.
router.buildEmployeeWorkbook = buildEmployeeWorkbook;
router.buildTeamWorkbook = buildTeamWorkbook;
router.getDefaultPeriod = getDefaultPeriod;
router.buildSubordinatePuestoIds = buildSubordinatePuestoIds;


module.exports = router;