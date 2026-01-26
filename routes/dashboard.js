const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const isAuth = require('../middleware/isAuth');
const { requireRole } = require('../middleware/roles');
const { scoreKpi } = require('../services/kpiScoring');

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
function buildSubordinatePuestoIds(puestoId, puestoMap) {
  let subordinates = [];
  for (const p of puestoMap) {
    if (p.responde_a_id === puestoId) {
      subordinates.push(p.id);
      subordinates = subordinates.concat(buildSubordinatePuestoIds(p.id, puestoMap));
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
async function buildDirectSubordinateNodes(currentUser, puestoId, puestoMap, year, month, showBajas = false) {
  const directPuestos = puestoMap.filter(p => p.responde_a_id === puestoId).map(p => p.id);
  if (directPuestos.length === 0) return [];

  const nodes = [];
  const empIds = [];
  for (const subPuestoId of directPuestos) {
    const [emps] = await pool.execute(
      `SELECT e.id, e.incidencia_id, e.nombre, e.puesto_id, e.departamento_id,
              p.nombre AS puesto_nombre,
              d.nombre AS departamento_nombre
       FROM empleados e
       LEFT JOIN puestos p ON e.puesto_id = p.id
       LEFT JOIN departamentos d ON e.departamento_id = d.id
       WHERE e.puesto_id = ?
         ${showBajas ? '' : "AND (d.nombre IS NULL OR d.nombre <> 'BAJA')"}`,
      [subPuestoId]
    );

    for (const emp of emps) {
      const subKpis = await getKPIsByPosition(emp.puesto_id);
      const subRes = await getKpiResultsForEmployee(emp.id, year);
      const hasChildren = puestoMap.some(p => p.responde_a_id === emp.puesto_id);
      // Permisos para UI:
      // - canApprove: sólo ...
      // - canSendToReview: cualquier jefe en la cadena (incluye jefe del jefe) puede enviar a revisión.
      const canApprove = await isDirectBossByPuesto(currentUser, emp.id);
      const canSendToReview = await canAccessEmployeeTree(currentUser, emp.id);
      nodes.push({ empleado: emp, kpis: subKpis, resultados: subRes, hasChildren, feedback: null, canApprove, canSendToReview });
      empIds.push(emp.id);
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
  const targetPuestoId = tRows.length ? tRows[0].puesto_id : null;
  return !!targetPuestoId && subordinatePuestos.includes(targetPuestoId);
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
    // Cargar el mapa de puestos (id, responde_a_id) para construir el árbol de subordinados
    const [puestos] = await pool.execute('SELECT id, responde_a_id FROM puestos');
    // Construir SOLO el primer nivel de subordinados (puestos directos)
	    const subordinateTree = await buildDirectSubordinateNodes(user, user.puesto_id, puestos, selectedYear, selectedMonth, showBajas);

    // Determinar si el usuario tiene subordinados directos y/o en todo su árbol
    const hasDirectSubordinates = Array.isArray(subordinateTree) && subordinateTree.length > 0;
    // Para verificar subordinados en cualquier nivel usamos buildSubordinatePuestoIds
    const subordinatePuestos = buildSubordinatePuestoIds(user.puesto_id, puestos);
    const hasAnySubordinates = subordinatePuestos && subordinatePuestos.length > 0;
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
      hasAnySubordinates
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

    // Obtener el puesto del empleado objetivo
    const [empRows] = await pool.execute('SELECT puesto_id FROM empleados WHERE id = ?', [empleadoId]);
    if (!empRows.length) {
      return res.status(404).send('Empleado no encontrado');
    }
    const targetPuestoId = empRows[0].puesto_id;

    // Cargar mapa de puestos (id, responde_a_id)
    const [puestos] = await pool.execute('SELECT id, responde_a_id FROM puestos');

    // Construir SOLO el siguiente nivel
	  const nodes = await buildDirectSubordinateNodes(user, targetPuestoId, puestos, year, month, showBajas);

    // Renderizar solo el fragmento HTML del siguiente nivel
	  return res.render('partials/sub_kpi_level', {
      nodes,
      selectedYear: year,
      selectedMonth: month,
	    showBajas,
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
    // Verificar permisos: si el usuario no es admin ni manager, sólo puede guardar KPIs propios o de subordinados
    if (targetEmployeeId !== user.id && user.role !== 'admin' && user.role !== 'manager') {
      try {
        // Obtener mapa de puestos para construir la lista de subordinados
        const [puestos] = await pool.execute('SELECT id, responde_a_id FROM puestos');
        const subordinates = buildSubordinatePuestoIds(user.puesto_id, puestos);
        // Obtener el puesto del empleado objetivo
        const [tRows] = await pool.execute('SELECT puesto_id FROM empleados WHERE id = ?', [targetEmployeeId]);
        const targetPuestoId = tRows.length ? tRows[0].puesto_id : null;
        if (!targetPuestoId || !subordinates.includes(targetPuestoId)) {
          const msg = 'No tiene permisos para editar los KPIs de este empleado';
          if ((req.get('X-Requested-With') || '').toLowerCase() === 'fetch') {
            return res.status(403).json({ ok: false, error: msg });
          }
          req.flash('error', msg);
          return res.redirect(`/dashboard?anio=${anio}&mes=${mes}`);
        }
      } catch (e) {
        console.error('Error al validar subordinados:', e);
        const msg = 'No se pudo validar la jerarquía';
        if ((req.get('X-Requested-With') || '').toLowerCase() === 'fetch') {
          return res.status(500).json({ ok: false, error: msg });
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
    }
    // Si la petición viene vía fetch/AJAX, devolver JSON para evitar recargar el dashboard
    if ((req.get('X-Requested-With') || '').toLowerCase() === 'fetch') {
      return res.json({ ok: true, color: resultadoColor || null, puntaje: score });
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
    let canApprove = false;
    if (user.role === 'admin' || user.role === 'manager') {
      canApprove = true;
    } else if (targetEmployeeId === user.id) {
      canApprove = await employeeHasNoDirectBoss(user.id);
    } else {
      canApprove = await isDirectBossByPuesto(user, targetEmployeeId);
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

    if ((user.role !== 'admin' && user.role !== 'manager') && (targetEmployeeId === user.id)) {
      return res.status(403).json({ ok: false, error: 'No puedes enviarte a revisión a ti mismo.' });
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

  const kpis = await getKPIsByPosition(emp.puesto_id);
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

async function buildTeamWorkbook({ user, year, month, mode, includeBajas }) {
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
  if (!emps.length) return null;

  const empIds = emps.map(e => e.id);
  const empPlace = empIds.map(() => '?').join(',');

  // KPIs por puesto
  const puestoIds = [...new Set(emps.map(e => e.puesto_id))];
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

  emps.forEach(emp => {
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
  emps.forEach(emp => {
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
  meta.addRow({ k: 'No. colaboradores', v: String(emps.length) });
  meta.addRow({ k: 'Modo', v: (mode === 'annual') ? `Anual (${year})` : `Mensual (${monthName(month)} ${year})` });
  meta.addRow({ k: 'Incluye BAJAS', v: includeBajas ? 'Sí' : 'No' });
  applyTableHeader(meta);
  autoWidth(meta, 12, 70);

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
  const mode = (String(req.query.mode || 'period').toLowerCase() === 'annual') ? 'annual' : 'period';

  try {
    const built = await buildEmployeeWorkbook({ employeeId: user.id, year, month, mode });
    if (!built) return res.status(404).send('Empleado no encontrado');

    const filename = mode === 'annual'
      ? `KPIs_${built.emp.incidencia_id || user.id}_Anual_${year}.xlsx`
      : `KPIs_${built.emp.incidencia_id || user.id}_${year}-${String(month).padStart(2,'0')}.xlsx`;

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
  const mode = (String(req.query.mode || 'period').toLowerCase() === 'annual') ? 'annual' : 'period';

  try {
    if (!employeeId) return res.status(400).send('Empleado inválido');

    const allowed = await canAccessEmployeeTree(user, employeeId);
    if (!allowed) return res.status(403).send('Sin permisos');

    const built = await buildEmployeeWorkbook({ employeeId, year, month, mode });
    if (!built) return res.status(404).send('Empleado no encontrado');

    const filename = mode === 'annual'
      ? `KPIs_${built.emp.incidencia_id || employeeId}_Anual_${year}.xlsx`
      : `KPIs_${built.emp.incidencia_id || employeeId}_${year}-${String(month).padStart(2,'0')}.xlsx`;

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
    const wb = await buildTeamWorkbook({ user, year, month, mode, includeBajas });
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
  try {
    const { sendIndividualKpiResults } = require('../services/kpiEmail');
    const result = await sendIndividualKpiResults({ employeeId: user.id, year, month });
    return res.json({ success: true, skipped: result.skipped, message: result.skipped ? 'Los resultados ya habían sido enviados anteriormente' : 'Correo enviado correctamente' });
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
  try {
    const { sendSubordinateKpiResults } = require('../services/kpiEmail');
    const result = await sendSubordinateKpiResults({ bossId: user.id, year, month });
    return res.json({ success: true, count: result.count });
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
  try {
    const { sendDirectSubordinateKpiResults } = require('../services/kpiEmail');
    const result = await sendDirectSubordinateKpiResults({ bossId: user.id, year, month });
    return res.json({ success: true, count: result.count });
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