const express = require('express');
const router = express.Router();

// Redirige al listado de KPIs preservando el filtro de departamento.
// (No rompe rutas: si no hay deptId, vuelve a /kpis sin filtro).
function redirectToKpis(req, res, deptId, anchorId) {
  // Si el frontend manda un return_to seguro (misma app), lo respetamos
  const rt = (req?.body?.return_to || '').toString();
  if (rt && rt.startsWith('/kpis')) {
    return res.redirect(rt);
  }
  const d = (deptId ?? req?.body?.departamento_id ?? req?.query?.departamento_id);
  const qRaw = (req?.body?.q ?? req?.query?.q ?? '').toString();
  const q = qRaw.trim();

  const qs = [];
  if (d && String(d) !== 'all') qs.push(`departamento_id=${encodeURIComponent(d)}`);
  if (q) qs.push(`q=${encodeURIComponent(q)}`);
  const query = qs.length ? `?${qs.join('&')}` : '';
  const anchor = anchorId ? `#kpi-${encodeURIComponent(anchorId)}` : '';
  return res.redirect(`/kpis${query}${anchor}`);
}

const { pool } = require('../db');
const isAuth = require('../middleware/isAuth');
const { requireRole } = require('../middleware/roles');

// Si un KPI es de tipo "porcentaje", estandarizamos los límites a un máximo de 100.00
// (esto evita rangos > 100 que después no califican correctamente en el sistema).
function clampPct100(val) {
  if (val === undefined || val === null || val === '') return null;
  const num = Number(val);
  if (Number.isNaN(num)) return null;
  return Math.min(num, 100);
}

function toNullableNumber(val) {
  if (val === undefined || val === null || val === '') return null;
  const n = Number(String(val).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function toNullableText(val) {
  if (val === undefined || val === null) return null;
  const s = String(val).trim();
  return s === '' ? null : s;
}

function isPctUnit(unidad) {
  return (unidad || '').toString().trim().toLowerCase() === 'porcentaje';
}

function normalizeKpiPayload(raw) {
  let {
    nombre,
    objetivo,
    unidad,

    rojo_min, rojo_max, amarillo_min, amarillo_max, verde_min, verde_max,

    score_type,
    direction,
    threshold_yellow,
    threshold_green,

    criterion_red,
    criterion_yellow,
    criterion_green,

    departamento_id
  } = raw;

  // Normalizar textos
  nombre = toNullableText(nombre);
  objetivo = toNullableText(objetivo);
  unidad = toNullableText(unidad) || 'numero';
  departamento_id = departamento_id ?? null;

  // Normalizar tipo de calificación
  score_type = (score_type || 'PERCENT').toString().toUpperCase();
  if (!['PERCENT', 'NUMBER', 'CRITERION'].includes(score_type)) {
    score_type = 'PERCENT';
  }

  // Dirección (solo aplica para numérico/porcentaje)
  direction = toNullableText(direction);
  if (score_type !== 'CRITERION') {
    direction = direction || 'HIGHER_BETTER';
    if (!['HIGHER_BETTER', 'LOWER_BETTER'].includes(direction)) {
      direction = 'HIGHER_BETTER';
    }
  } else {
    direction = null;
  }

  // Normalizar numéricos SIEMPRE (esto elimina el '' que rompe MySQL)
  rojo_min = toNullableNumber(rojo_min);
  rojo_max = toNullableNumber(rojo_max);
  amarillo_min = toNullableNumber(amarillo_min);
  amarillo_max = toNullableNumber(amarillo_max);
  verde_min = toNullableNumber(verde_min);
  verde_max = toNullableNumber(verde_max);

  threshold_yellow = toNullableNumber(threshold_yellow);
  threshold_green = toNullableNumber(threshold_green);

  // Normalizar criterios
  criterion_red = toNullableText(criterion_red);
  criterion_yellow = toNullableText(criterion_yellow);
  criterion_green = toNullableText(criterion_green);

  // Si es porcentaje, capar a 100 (sobre valores ya numéricos)
  if (isPctUnit(unidad)) {
    rojo_min = clampPct100(rojo_min);
    rojo_max = clampPct100(rojo_max);
    amarillo_min = clampPct100(amarillo_min);
    amarillo_max = clampPct100(amarillo_max);
    verde_min = clampPct100(verde_min);
    verde_max = clampPct100(verde_max);

    threshold_yellow = clampPct100(threshold_yellow);
    threshold_green = clampPct100(threshold_green);
  }

  // Switch limpio entre modos:
  // - CRITERION -> nulos numéricos
  // - NUMBER/PERCENT -> nulos criterios
  if (score_type === 'CRITERION') {
    rojo_min = null; rojo_max = null;
    amarillo_min = null; amarillo_max = null;
    verde_min = null; verde_max = null;
    threshold_yellow = null;
    threshold_green = null;

    // Si no mandan criterios, puedes poner defaults (opcional)
    // criterion_red = criterion_red || 'NO CUMPLIO';
    // criterion_yellow = criterion_yellow || 'CUMPLIO';
    // criterion_green = criterion_green || 'CUMPLIO EXCELENTE';
  } else {
    criterion_red = null;
    criterion_yellow = null;
    criterion_green = null;
  }

  return {
    nombre,
    objetivo,
    unidad,

    rojo_min, rojo_max, amarillo_min, amarillo_max, verde_min, verde_max,

    score_type,
    direction,
    threshold_yellow,
    threshold_green,

    criterion_red,
    criterion_yellow,
    criterion_green,

    departamento_id
  };
}

/*
 * GET /kpis
 * Muestra la interfaz para crear un nuevo KPI y la lista de KPIs
 * existentes agrupados por departamento.  Permite la edición inline
 * de los KPIs mediante un formulario por cada fila.
 */
router.get('/', isAuth, requireRole(['admin','manager']), async (req, res) => {
  try {
    const [departamentos] = await pool.execute('SELECT id, nombre FROM departamentos ORDER BY nombre');
    const selectedDepartamento = (req.query.departamento_id && req.query.departamento_id !== 'all')
      ? String(req.query.departamento_id)
      : 'all';

    const search = (req.query.q || '').toString().trim();

    // Consultar los KPIs existentes con el nombre del departamento (con filtro opcional)
    let sql = `SELECT k.*, d.nombre AS departamento_nombre
               FROM kpis k
               LEFT JOIN departamentos d ON k.departamento_id = d.id`;
    const params = [];
    const where = [];
    if (selectedDepartamento !== 'all') {
      where.push('k.departamento_id = ?');
      params.push(selectedDepartamento);
    }
    if (search) {
      where.push('k.nombre LIKE ?');
      params.push(`%${search}%`);
    }
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY d.nombre, k.nombre';

    const [kpis] = await pool.execute(sql, params);
    res.render('kpis', {
      title: 'KPIs',
      departamentos,
      kpis,
      selectedDepartamento,
      search
    });
  } catch (err) {
    console.error('Error al cargar KPIs:', err);
    req.flash('error', 'No se pudo cargar la lista de KPIs');
    return res.redirect('/dashboard');
  }
});

/*
 * POST /kpis/create
 * Crea un nuevo KPI con la información proporcionada por el usuario.
 */
router.post('/create', isAuth, requireRole(['admin','manager']), async (req, res) => {
  const p = normalizeKpiPayload(req.body);

  if (!p.nombre || !p.departamento_id) {
    req.flash('error', 'El nombre y el departamento son obligatorios');
    return redirectToKpis(req, res, p.departamento_id);
  }

  try {
    await pool.execute(
      `INSERT INTO kpis (
          nombre, objetivo, unidad,
          rojo_min, rojo_max, amarillo_min, amarillo_max, verde_min, verde_max,
          score_type, direction, threshold_yellow, threshold_green,
          criterion_red, criterion_yellow, criterion_green,
          periodicidad, departamento_id
       )
       VALUES (
          ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          'Mensual', ?
       )`,
      [
        p.nombre,
        p.objetivo,
        p.unidad,

        p.rojo_min,
        p.rojo_max,
        p.amarillo_min,
        p.amarillo_max,
        p.verde_min,
        p.verde_max,

        p.score_type,
        p.direction,
        p.threshold_yellow,
        p.threshold_green,

        p.criterion_red,
        p.criterion_yellow,
        p.criterion_green,

        p.departamento_id
      ]
    );

    req.flash('success', 'KPI creado');
    return redirectToKpis(req, res, p.departamento_id);
  } catch (err) {
    console.error('Error al crear KPI:', err);
    req.flash('error', 'No se pudo crear el KPI');
    return redirectToKpis(req, res, p.departamento_id);
  }
});

/*
 * POST /kpis/update/:id
 * Actualiza los valores de un KPI existente.  Los campos se reciben
 * como texto; se convierten a null cuando vienen vacíos para que se
 * almacenen correctamente en la base.
 */
router.post('/update/:id', isAuth, requireRole(['admin','manager']), async (req, res) => {
  const { id } = req.params;
  const p = normalizeKpiPayload(req.body);

  try {
    await pool.execute(
      `UPDATE kpis SET
         nombre=?,
         objetivo=?,
         unidad=?,
         rojo_min=?, rojo_max=?, amarillo_min=?, amarillo_max=?, verde_min=?, verde_max=?,
         score_type=?, direction=?, threshold_yellow=?, threshold_green=?,
         criterion_red=?, criterion_yellow=?, criterion_green=?,
         departamento_id=?
       WHERE id=?`,
      [
        p.nombre,
        p.objetivo,
        p.unidad,

        p.rojo_min,
        p.rojo_max,
        p.amarillo_min,
        p.amarillo_max,
        p.verde_min,
        p.verde_max,

        p.score_type,
        p.direction,
        p.threshold_yellow,
        p.threshold_green,

        p.criterion_red,
        p.criterion_yellow,
        p.criterion_green,

        p.departamento_id,
        id
      ]
    );

    req.flash('success', 'KPI actualizado');
    return redirectToKpis(req, res, p.departamento_id, id);
  } catch (err) {
    console.error('Error al actualizar KPI:', err);
    req.flash('error', 'No se pudo actualizar el KPI');
    return redirectToKpis(req, res, p.departamento_id, id);
  }
});

module.exports = router;
