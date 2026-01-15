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
router.get('/', isAuth, requireRole(['admin','manager']), async (req, res) => {
  try {
    const [puestos] = await pool.execute(
      `SELECT p.id, p.nombre AS puesto, p.responde_a_id AS responde_id, d.nombre AS departamento, r.nombre AS responde_nombre, p.role
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
      roles: ['admin','manager','user'],
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
      `SELECT k.id, k.nombre FROM kpis k WHERE k.departamento_id = ? ORDER BY k.nombre`,
      [puesto.departamento_id]
    );
    // Obtener KPIs ya asignados
    const [asignados] = await pool.execute(
      `SELECT kpi_id FROM puesto_kpis WHERE puesto_id = ?`,
      [puestoId]
    );
    const asignadosSet = new Set(asignados.map(r => r.kpi_id));
    // Crear bandera checked para cada KPI
    const kpiList = kpis.map(k => ({ id: k.id, nombre: k.nombre, checked: asignadosSet.has(k.id) }));
    res.render('puesto_kpis', {
      title: `KPIs del puesto ${puesto.nombre}`,
      puesto,
      kpis: kpiList
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
router.post('/:id(\\d+)', isAuth, requireRole(['admin','manager']), async (req, res) => {
  const puestoId = req.params.id;
  let { kpi_ids } = req.body;
  if (!Array.isArray(kpi_ids)) {
    // Si solo se seleccionó uno, vendrá como cadena
    if (kpi_ids) {
      kpi_ids = [kpi_ids];
    } else {
      kpi_ids = [];
    }
  }
  try {
    // Eliminar asignaciones actuales
    await pool.execute('DELETE FROM puesto_kpis WHERE puesto_id = ?', [puestoId]);
    // Insertar nuevas asignaciones
    for (const kpiId of kpi_ids) {
      await pool.execute('INSERT INTO puesto_kpis (puesto_id, kpi_id) VALUES (?, ?)', [puestoId, kpiId]);
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
router.post('/crear-departamento', isAuth, requireRole(['admin','manager']), async (req, res) => {
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
router.post('/crear-sucursal', isAuth, requireRole(['admin','manager']), async (req, res) => {
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
router.post('/editar/:id', isAuth, requireRole(['admin','manager']), async (req, res) => {
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
router.post('/crear', isAuth, requireRole(['admin','manager']), async (req, res) => {
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