const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const isAuth = require('../middleware/isAuth');
const { requireRole } = require('../middleware/roles');

/*
 * GET /puestos
 * Muestra la lista de puestos con su departamento y a quién reportan.
 * Incluye enlaces para asignar KPIs y formularios para crear
 * departamentos y sucursales.
 */
// Lista de puestos.  Sólo accesible para administradores y managers.
router.get('/', isAuth, requireRole(['admin', 'manager']), async (req, res) => {
  try {
    const [puestos] = await pool.execute(
      `SELECT p.id,
              p.nombre AS puesto,
              p.responde_a_id AS responde_id,
              d.nombre AS departamento,
              r.nombre AS responde_nombre,
              p.role,
              (
                SELECT COUNT(*)
                FROM puesto_kpis pk
                WHERE pk.puesto_id = p.id
              ) AS kpi_count
       FROM puestos p
       JOIN departamentos d ON p.departamento_id = d.id
       LEFT JOIN puestos r ON p.responde_a_id = r.id
       ORDER BY d.nombre, p.nombre`
    );
    // Obtener departamentos y sucursales para formularios de creación
    const [departamentos] = await pool.execute('SELECT id, nombre FROM departamentos ORDER BY nombre');
    const [sucursales] = await pool.execute('SELECT id, nombre FROM sucursales ORDER BY nombre');
    res.render('puestos', {
      title: 'Puestos',
      puestos,
      departamentos,
      sucursales,
      roles: ['admin', 'manager', 'user'],
      userRole: req.session.user.role,
      isAdmin: req.session.user && req.session.user.role === 'admin'
    });
  } catch (err) {
    console.error('Error al cargar puestos:', err);
    req.flash('error', 'No se pudo cargar la lista de puestos');
    return res.redirect('/dashboard');
  }
});

/*
 * GET /puestos/:id
 * Muestra un formulario para asignar o quitar KPIs a un puesto
 * específico.  Sólo se listan los KPIs del mismo departamento para
 * evitar confusión.
 */
// Formulario para asignar/quitar KPIs a un puesto específico
router.get('/:id(\\d+)', isAuth, requireRole(['admin','manager']), async (req, res) => {
  const puestoId = req.params.id;
  try {
    // Obtener información del puesto
    const [puestoRows] = await pool.execute(
      `SELECT p.id, p.nombre, d.id AS departamento_id, d.nombre AS departamento
       FROM puestos p JOIN departamentos d ON p.departamento_id = d.id
       WHERE p.id = ?`,
      [puestoId]
    );
    if (puestoRows.length === 0) {
      req.flash('error', 'Puesto no encontrado');
      return res.redirect('/puestos');
    }
    const puesto = puestoRows[0];
    // Obtener todos los KPIs de ese departamento
    const [kpis] = await pool.execute(
      `SELECT k.id, k.nombre
       FROM kpis k
       WHERE k.departamento_id = ?
       ORDER BY k.nombre`,
      [puesto.departamento_id]
    );
    // Obtener KPIs ya asignados con su peso
    const [asignados] = await pool.execute(
      `SELECT kpi_id, peso
       FROM puesto_kpis
       WHERE puesto_id = ?`,
      [puestoId]
    );
    const asignadosSet = new Set(asignados.map(r => r.kpi_id));
    const pesoMap = {};
    asignados.forEach(({ kpi_id, peso }) => { pesoMap[kpi_id] = peso; });
    // Crear objeto para cada KPI con bandera y peso
    const kpiList = kpis.map(k => ({
      id: k.id,
      nombre: k.nombre,
      checked: asignadosSet.has(k.id),
      peso: asignadosSet.has(k.id) ? (pesoMap[k.id] != null ? pesoMap[k.id] : '') : ''
    }));
    res.render('puesto_kpis', {
      title: `KPIs del puesto ${puesto.nombre}`,
      puesto,
      kpis: kpiList,
      userRole: req.session.user.role,
      isAdmin: req.session.user && req.session.user.role === 'admin'
    });
  } catch (err) {
    console.error('Error al cargar KPIs del puesto:', err);
    req.flash('error', 'No se pudieron cargar los KPIs');
    return res.redirect('/puestos');
  }
});

/*
 * POST /puestos/:id
 * Actualiza las asignaciones de KPIs a un puesto.  Se reciben los
 * identificadores de los KPIs seleccionados en el formulario.  La
 * estrategia consiste en eliminar todas las asignaciones actuales y
 * luego insertar las nuevas.
 */
// Actualiza las asignaciones de KPIs a un puesto específico
// Actualiza las asignaciones de KPIs a un puesto específico.
// Sólo los administradores pueden modificar; los managers tienen acceso de sólo lectura
router.post('/:id(\\d+)', isAuth, requireRole(['admin']), async (req, res) => {
  const puestoId = req.params.id;

  // Debug opcional: activa con DEBUG_PUESTO_KPIS=1 en .env
  const debugEnabled = String(process.env.DEBUG_PUESTO_KPIS || '').trim() === '1';
  if (debugEnabled) {
    try {
      const keys = Object.keys(req.body || {});
      console.log('\n[DEBUG_PUESTO_KPIS] ---- POST /puestos/' + puestoId + ' ----');
      console.log('[DEBUG_PUESTO_KPIS] content-type:', (req.headers['content-type'] || '').toString());
      console.log('[DEBUG_PUESTO_KPIS] body keys (' + keys.length + '):', keys.slice(0, 60));
      if (keys.length > 60) console.log('[DEBUG_PUESTO_KPIS] ... more keys:', keys.length - 60);
      // imprime únicamente campos relevantes
      const relevant = {};
      for (const k of keys) {
        if (k === 'kpi_ids' || k === 'pesos' || /^pesos\[\d+\]$/.test(k) || /^peso_post\[\d+\]$/.test(k)) {
          relevant[k] = req.body[k];
        }
      }
      console.log('[DEBUG_PUESTO_KPIS] relevant body:', JSON.stringify(relevant, null, 2));
    } catch (e) {
      console.log('[DEBUG_PUESTO_KPIS] error printing debug:', e.message);
    }
  }
  // kpi_ids puede venir como array o valor único (checkboxes). En algunos
  // entornos/proxys el body puede no incluir kpi_ids (por ejemplo, si el
  // formulario fue manipulado o si los inputs estaban deshabilitados).
  // Para evitar falsos "0.00%", reconstruimos kpi_ids a partir de pesos[]
  // cuando sea necesario.
  let { kpi_ids } = req.body;
  if (!Array.isArray(kpi_ids)) {
    kpi_ids = kpi_ids ? [kpi_ids] : [];
  }

  // pesos puede venir en distintos formatos:
  // 1) Objeto: {"12":"50", "13":"30"} si qs lo parsea correctamente.
  // 2) Array: ["50", "30", ...] cuando qs no interpreta los índices y junta
  //    todos los valores de pesos[n] en un arreglo. En ese caso debemos
  //    asociar los valores al orden de kpi_ids.
  // 3) Claves planas: "pesos[12]":"50". 4) Respaldos enviados como
  //    "peso_post[12]":"50".
  const rawPesos = (req.body && typeof req.body.pesos === 'object' && req.body.pesos) ? req.body.pesos : undefined;
  // Construir flat maps para claves planas
  const flatPesoPairs = [];
  for (const [key, value] of Object.entries(req.body || {})) {
    const m = /^pesos\[(\d+)\]$/.exec(key);
    if (m) flatPesoPairs.push({ kpiId: m[1], value });
  }
  const flatPesoMap = {};
  for (const p of flatPesoPairs) {
    flatPesoMap[String(p.kpiId)] = p.value;
  }
  // Respaldos adicionales desde frontend: peso_post[ID]
  const flatPesoPostPairs = [];
  for (const [key, value] of Object.entries(req.body || {})) {
    const m = /^peso_post\[(\d+)\]$/.exec(key);
    if (m) flatPesoPostPairs.push({ kpiId: m[1], value });
  }
  const flatPesoPostMap = {};
  for (const p of flatPesoPostPairs) {
    flatPesoPostMap[String(p.kpiId)] = p.value;
  }

  // Convertir rawPesos a un map de id => valor.  Si rawPesos es un array,
  // se asociará cada valor a la primera ocurrencia de cada kpi_id en kpi_ids.
  let pesoMap = {};
  if (rawPesos && !Array.isArray(rawPesos)) {
    // Ya es objeto, usarlo tal cual (puede contener claves tipo '0','1' si
    // viene como array-like de qs; por seguridad convertimos a map string)
    for (const [key, val] of Object.entries(rawPesos)) {
      pesoMap[String(key)] = val;
    }
  } else if (Array.isArray(rawPesos)) {
    // Asociar secuencialmente a la primera ocurrencia de cada KPI ID en kpi_ids
    const values = rawPesos.slice();
    const assigned = {};
    let idxVal = 0;
    for (const kpiId of kpi_ids) {
      const key = String(kpiId);
      if (assigned[key] === undefined && idxVal < values.length) {
        pesoMap[key] = values[idxVal++];
        assigned[key] = true;
      }
    }
  }

  // Si no llegaron kpi_ids, inferirlos por pesos con valor (objeto o plano)
  // Nota: "pesos" puede venir como req.body.pesos (objeto/array) o como claves
  // planas "pesos[ID]" / respaldos "peso_post[ID]".
  if (kpi_ids.length === 0) {
    const inferred = new Set();

    // 1) Desde req.body.pesos cuando llega como objeto (id => valor)
    if (rawPesos && !Array.isArray(rawPesos)) {
      for (const [kpiId, value] of Object.entries(rawPesos)) {
        if (String(value ?? '').trim() !== '') inferred.add(String(kpiId));
      }
    }

    // 2) Desde claves planas "pesos[ID]"
    for (const p of flatPesoPairs) {
      if (String(p.value ?? '').trim() !== '') inferred.add(String(p.kpiId));
    }

    // 3) Desde respaldos "peso_post[ID]"
    for (const p of flatPesoPostPairs) {
      if (String(p.value ?? '').trim() !== '') inferred.add(String(p.kpiId));
    }

    kpi_ids = Array.from(inferred);
  }

  // Si aún no tenemos KPIs, no tiene sentido validar suma: el formulario no
  // envió datos (típicamente por inputs deshabilitados o manipulación).
  if (kpi_ids.length === 0) {
    req.flash('error', 'No se recibieron KPIs/pesos desde el formulario. Verifica que tengas KPIs seleccionados y que los campos de peso estén habilitados (usuario Admin).');
    return res.redirect(`/puestos/${puestoId}`);
  }

  // Deduplicar kpi_ids para evitar contar varias veces el mismo KPI.  En
  // algunos formularios, kpi_ids puede contener el mismo ID múltiples
  // veces debido a respaldos ocultos.  Conservamos el orden de primera
  // aparición.
  {
    const seenKpi = new Set();
    const unique = [];
    for (const id of kpi_ids) {
      const key = String(id);
      if (!seenKpi.has(key)) {
        seenKpi.add(key);
        unique.push(id);
      }
    }
    kpi_ids = unique;
  }
  try {
    // Validar suma de pesos: convertir a números y sumar sólo los seleccionados
    let totalPeso = 0;
    const pesoValues = [];
    for (const kpiId of kpi_ids) {
      const key = String(kpiId);
      // Orden de precedencia para obtener el peso:
      // 1) pesoMap (map construido a partir de rawPesos cuando viene como objeto o array)
      // 2) flatPesoMap (claves planas "pesos[ID]")
      // 3) flatPesoPostMap (respaldo hidden enviado como "peso_post[ID]")
      let raw;
      if (pesoMap && pesoMap[key] !== undefined) {
        raw = pesoMap[key];
      } else if (flatPesoMap[key] !== undefined) {
        raw = flatPesoMap[key];
      } else if (flatPesoPostMap[key] !== undefined) {
        raw = flatPesoPostMap[key];
      } else {
        raw = '';
      }

      // Si llega como arreglo (inputs duplicados), tomar el último no vacío
      if (Array.isArray(raw)) {
        const cleaned = raw.map(v => String(v ?? '').trim()).filter(v => v !== '');
        raw = cleaned.length ? cleaned[cleaned.length - 1] : (raw.length ? raw[raw.length - 1] : '');
      }

      const num = parseFloat(String(raw).replace(',', '.'));
      const pesoVal = Number.isFinite(num) ? num : 0;
      pesoValues.push({ id: kpiId, peso: pesoVal });
      totalPeso += pesoVal;
    }

    if (debugEnabled) {
      console.log('[DEBUG_PUESTO_KPIS] computed pesoValues:', pesoValues);
      console.log('[DEBUG_PUESTO_KPIS] computed totalPeso:', totalPeso);
    }
    // Debe sumar exactamente 100 (permite pequeño margen por redondeo)
    if (Math.abs(totalPeso - 100) > 0.01) {
      if (!debugEnabled && totalPeso === 0) {
        console.log('[PUESTO_KPIS] totalPeso=0: probablemente no llegaron los pesos en el POST. Activa DEBUG_PUESTO_KPIS=1 para ver el body recibido.');
      }
      req.flash('error', `La suma actual de pesos es ${totalPeso.toFixed(2)}%. Debe ser 100% para continuar.`);
      return res.redirect(`/puestos/${puestoId}`);
    }
    // Eliminar asignaciones actuales
    await pool.execute('DELETE FROM puesto_kpis WHERE puesto_id = ?', [puestoId]);
    // Insertar nuevas asignaciones con peso
    for (const { id: kpiId, peso } of pesoValues) {
      await pool.execute(
        'INSERT INTO puesto_kpis (puesto_id, kpi_id, peso) VALUES (?, ?, ?)',
        [puestoId, kpiId, peso]
      );
    }
    req.flash('success', 'Asignaciones de KPIs actualizadas');
    return res.redirect('/puestos');
  } catch (err) {
    console.error('Error al actualizar KPIs del puesto:', err);
    req.flash('error', 'No se pudieron actualizar los KPIs');
    return res.redirect('/puestos');
  }
});

/*
 * POST /puestos/crear-departamento
 * Permite crear un nuevo departamento.  El nombre se recibe por
 * formulario.  Se valida que no exista ya un departamento con el
 * mismo nombre.  Si se crea correctamente, se redirige a la lista de
 * puestos.
 */
router.post('/crear-departamento', isAuth, requireRole(['admin']), async (req, res) => {
  const { nombre } = req.body;
  if (!nombre) {
    req.flash('error', 'Debe especificar el nombre del departamento');
    return res.redirect('/puestos');
  }
  try {
    const [exists] = await pool.execute('SELECT id FROM departamentos WHERE nombre = ?', [nombre]);
    if (exists.length > 0) {
      req.flash('error', 'El departamento ya existe');
      return res.redirect('/puestos');
    }
    await pool.execute('INSERT INTO departamentos (nombre) VALUES (?)', [nombre]);
    req.flash('success', 'Departamento creado');
    return res.redirect('/puestos');
  } catch (err) {
    console.error('Error al crear departamento:', err);
    req.flash('error', 'No se pudo crear el departamento');
    return res.redirect('/puestos');
  }
});

/*
 * POST /puestos/crear-sucursal
 * Crea una sucursal para el departamento OPERACIONES.  Sólo se
 * requiere el nombre.  Si ya existe, se muestra un mensaje.
 */
router.post('/crear-sucursal', isAuth, requireRole(['admin']), async (req, res) => {
  const { nombre } = req.body;
  if (!nombre) {
    req.flash('error', 'Debe especificar el nombre de la sucursal');
    return res.redirect('/puestos');
  }
  try {
    const [exists] = await pool.execute('SELECT id FROM sucursales WHERE nombre = ?', [nombre]);
    if (exists.length > 0) {
      req.flash('error', 'La sucursal ya existe');
      return res.redirect('/puestos');
    }
    // Obtener departamento OPERACIONES
    const [depOps] = await pool.execute('SELECT id FROM departamentos WHERE nombre = "OPERACIONES"');
    if (depOps.length === 0) {
      req.flash('error', 'No existe el departamento OPERACIONES');
      return res.redirect('/puestos');
    }
    await pool.execute('INSERT INTO sucursales (nombre, departamento_id) VALUES (?, ?)', [nombre, depOps[0].id]);
    req.flash('success', 'Sucursal creada');
    return res.redirect('/puestos');
  } catch (err) {
    console.error('Error al crear sucursal:', err);
    req.flash('error', 'No se pudo crear la sucursal');
    return res.redirect('/puestos');
  }
});

/*
 * POST /puestos/editar/:id
 * Permite editar el nombre del puesto, su departamento y la persona a quien reporta.
 * Si responde_a_id viene vacío, se establece en NULL.
 */
router.post('/editar/:id', isAuth, requireRole(['admin']), async (req, res) => {
  const { id } = req.params;
  let { nombre, departamento_id, responde_a_id, role } = req.body;
  // Normalizar valores
  departamento_id = departamento_id || null;
  responde_a_id = responde_a_id && responde_a_id !== '' ? responde_a_id : null;
  if (!nombre) {
    req.flash('error', 'Debe indicar el nombre del puesto');
    return res.redirect('/puestos');
  }
  try {
    // Evitar que un puesto se asigne como jefe a sí mismo
    if (responde_a_id && parseInt(responde_a_id, 10) === parseInt(id, 10)) {
      req.flash('error', 'Un puesto no puede responder a sí mismo');
      return res.redirect('/puestos');
    }
    // Construir consulta dinámica según el rol del usuario.  Sólo los administradores pueden cambiar el rol del puesto.
    let query = 'UPDATE puestos SET nombre = ?, departamento_id = ?, responde_a_id = ?';
    const params = [nombre, departamento_id, responde_a_id];
    if (req.session.user.role === 'admin') {
      // Validar que el rol proporcionado sea uno de los permitidos; de lo contrario usar "user"
      const validRoles = ['admin', 'manager', 'user'];
      const newRole = validRoles.includes(role) ? role : 'user';
      query += ', role = ?';
      params.push(newRole);
    }
    query += ' WHERE id = ?';
    params.push(id);
    await pool.execute(query, params);
    req.flash('success', 'Puesto actualizado');
    return res.redirect('/puestos');
  } catch (err) {
    console.error('Error al actualizar puesto:', err);
    req.flash('error', 'No se pudo actualizar el puesto');
    return res.redirect('/puestos');
  }
});

/*
 * POST /puestos/crear
 * Crea un nuevo puesto.  Recibe nombre, departamento_id y responde_a_id.
 */
router.post('/crear', isAuth, requireRole(['admin']), async (req, res) => {
  let { nombre, departamento_id, responde_a_id, role } = req.body;
  nombre = nombre && nombre.trim();
  if (!nombre) {
    req.flash('error', 'Debe proporcionar un nombre para el puesto');
    return res.redirect('/puestos');
  }
  departamento_id = departamento_id || null;
  responde_a_id = responde_a_id && responde_a_id !== '' ? responde_a_id : null;
  try {
    // Determinar el rol para el nuevo puesto.  Sólo los administradores pueden elegir; los managers crean puestos de rol "user".
    let puestoRole = 'user';
    if (req.session.user.role === 'admin') {
      const validRoles = ['admin', 'manager', 'user'];
      puestoRole = validRoles.includes(role) ? role : 'user';
    }
    await pool.execute(
      'INSERT INTO puestos (nombre, departamento_id, responde_a_id, role) VALUES (?, ?, ?, ?)',
      [nombre, departamento_id, responde_a_id, puestoRole]
    );
    req.flash('success', 'Puesto creado');
    return res.redirect('/puestos');
  } catch (err) {
    console.error('Error al crear puesto:', err);
    req.flash('error', 'No se pudo crear el puesto');
    return res.redirect('/puestos');
  }
});

module.exports = router;