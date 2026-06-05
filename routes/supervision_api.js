const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const isAuth = require('../middleware/isAuth');
const { requireRole } = require('../middleware/roles');

/**
 * API para la administración de rutas de supervisión.
 *
 * Esta API expone endpoints bajo /api/supervision que permiten listar
 * las rutas, obtener detalles, asignar supervisores y colaboradores,
 * actualizar herencia de KPIs y calificación, y desactivar asignaciones.
 *
 * Los roles permitidos para acceder a estos endpoints son:
 *   - admin y manager para lectura
 *   - admin para escritura
 */

// Lista todas las rutas activas
router.get('/rutas', isAuth, requireRole(['admin', 'manager']), async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, nombre, activo FROM supervision_rutas WHERE activo = 1 ORDER BY id'
    );
    return res.json({ ok: true, rutas: rows });
  } catch (err) {
    console.error('Error al listar rutas:', err);
    return res.status(500).json({ ok: false, error: 'No se pudieron obtener las rutas' });
  }
});

// Devuelve el detalle de una ruta: supervisor, colaboradores y sucursales asignadas.
router.get('/rutas/:id', isAuth, requireRole(['admin', 'manager']), async (req, res) => {
  const rutaId = parseInt(req.params.id, 10);
  if (!rutaId || Number.isNaN(rutaId)) {
    return res.status(400).json({ ok: false, error: 'Ruta inválida' });
  }
  try {
    // Datos de la ruta
    const [rRows] = await pool.execute(
      'SELECT id, nombre, activo FROM supervision_rutas WHERE id = ? LIMIT 1',
      [rutaId]
    );
    if (!rRows.length) {
      return res.status(404).json({ ok: false, error: 'Ruta no encontrada' });
    }
    const ruta = rRows[0];
    // Supervisor asignado
    const [supRows] = await pool.execute(
      `SELECT esr.empleado_id AS id, e.incidencia_id, e.nombre, e.puesto_id,
              p.nombre AS puesto, d.nombre AS departamento, s.nombre AS sucursal,
              esr.hereda_kpis, esr.hereda_calificacion_supervisor, esr.activo
       FROM empleado_supervision_ruta esr
       JOIN empleados e ON e.id = esr.empleado_id
       JOIN puestos p ON p.id = e.puesto_id
       LEFT JOIN departamentos d ON d.id = e.departamento_id
       LEFT JOIN supervision_rutas sd ON UPPER(TRIM(sd.nombre)) = UPPER(TRIM(d.nombre))
       LEFT JOIN sucursales s ON s.id = e.sucursal_id
       WHERE esr.ruta_id = ? AND esr.rol_en_ruta = 'supervisor' AND esr.activo = 1
       LIMIT 1`,
      [rutaId]
    );
    const supervisor = supRows.length ? supRows[0] : null;
    // Colaboradores asignados
    const [colRows] = await pool.execute(
      `SELECT esr.empleado_id AS id, e.incidencia_id, e.nombre, e.puesto_id,
              p.nombre AS puesto, d.nombre AS departamento, s.nombre AS sucursal,
              esr.hereda_kpis, esr.hereda_calificacion_supervisor, esr.activo
       FROM empleado_supervision_ruta esr
       JOIN empleados e ON e.id = esr.empleado_id
       JOIN puestos p ON p.id = e.puesto_id
       LEFT JOIN departamentos d ON d.id = e.departamento_id
       LEFT JOIN supervision_rutas sd ON UPPER(TRIM(sd.nombre)) = UPPER(TRIM(d.nombre))
       LEFT JOIN sucursales s ON s.id = e.sucursal_id
       WHERE esr.ruta_id = ? AND esr.rol_en_ruta = 'colaborador' AND esr.activo = 1
       ORDER BY e.nombre`,
      [rutaId]
    );
    // Empleados detectados automaticamente por departamento o sucursal virtual de la ruta.
    // En la practica, incidencias puede traerlos como departamento OPERACIONES
    // y sucursal SUPERVISION 1..6. Por eso revisamos ambas fuentes:
    //   1) departamento = SUPERVISION X
    //   2) sucursal     = SUPERVISION X
    // Solo se muestran los que aun NO tienen asignacion manual activa para no duplicarlos
    // con la tabla de colaboradores definitivos.
    const [autoDeptRows] = await pool.execute(
      `SELECT e.id, e.incidencia_id, e.nombre, e.puesto_id,
              p.nombre AS puesto,
              d.nombre AS departamento,
              s.nombre AS sucursal,
              CASE
                WHEN sd.id IS NOT NULL THEN 'Departamento de incidencias'
                WHEN sv.id IS NOT NULL THEN 'Sucursal virtual'
                ELSE 'Sin origen'
              END AS origen
       FROM empleados e
       LEFT JOIN puestos p ON p.id = e.puesto_id
       LEFT JOIN departamentos d ON d.id = e.departamento_id
       LEFT JOIN supervision_rutas sd ON UPPER(TRIM(sd.nombre)) = UPPER(TRIM(d.nombre))
       LEFT JOIN sucursales s ON s.id = e.sucursal_id
       LEFT JOIN supervision_rutas sv ON UPPER(TRIM(sv.nombre)) = UPPER(TRIM(s.nombre))
       LEFT JOIN empleado_supervision_ruta esr ON esr.empleado_id = e.id AND esr.activo = 1
       WHERE COALESCE(sd.id, sv.id) = ?
         AND esr.empleado_id IS NULL
         AND (d.nombre IS NULL OR UPPER(d.nombre) <> 'BAJA')
         AND UPPER(COALESCE(p.nombre, '')) NOT LIKE '%SUPERVISOR%'
       ORDER BY p.nombre, e.nombre`,
      [rutaId]
    );

    // Sucursales asignadas
    const [branchRows] = await pool.execute(
      `SELECT ssr.sucursal_id AS id, s.nombre
       FROM sucursal_supervision_ruta ssr
       JOIN sucursales s ON s.id = ssr.sucursal_id
       WHERE ssr.ruta_id = ? AND ssr.activo = 1
       ORDER BY s.nombre`,
      [rutaId]
    );
    return res.json({
      ok: true,
      ruta,
      supervisor,
      colaboradores: colRows,
      detectados_departamento: autoDeptRows,
      sucursales: branchRows
    });
  } catch (err) {
    console.error('Error al obtener detalle de ruta:', err);
    return res.status(500).json({ ok: false, error: 'No se pudo obtener el detalle de la ruta' });
  }
});

// Asigna o cambia el supervisor de una ruta.
router.post('/rutas/:id/supervisor', isAuth, requireRole(['admin']), async (req, res) => {
  const rutaId = parseInt(req.params.id, 10);
  const empleadoId = parseInt(req.body?.empleado_id, 10);
  if (!rutaId || Number.isNaN(rutaId) || !empleadoId || Number.isNaN(empleadoId)) {
    return res.status(400).json({ ok: false, error: 'Datos inválidos' });
  }
  try {
    // Verificar que la ruta exista
    const [rRows] = await pool.execute('SELECT id FROM supervision_rutas WHERE id = ? LIMIT 1', [rutaId]);
    if (!rRows.length) return res.status(404).json({ ok: false, error: 'Ruta no encontrada' });
    // Verificar que el empleado exista
    const [eRows] = await pool.execute('SELECT id FROM empleados WHERE id = ? LIMIT 1', [empleadoId]);
    if (!eRows.length) return res.status(404).json({ ok: false, error: 'Empleado no encontrado' });
    // Desactivar supervisor anterior (baja lógica)
    await pool.execute(
      `UPDATE empleado_supervision_ruta
       SET activo = 0
       WHERE ruta_id = ? AND rol_en_ruta = 'supervisor' AND activo = 1`,
      [rutaId]
    );
    // Crear o actualizar asignación para el nuevo supervisor
    await pool.execute(
      `INSERT INTO empleado_supervision_ruta
        (empleado_id, ruta_id, rol_en_ruta, hereda_kpis, hereda_calificacion_supervisor, asignado_por, activo, asignado_en)
       VALUES (?, ?, 'supervisor', 0, 0, ?, 1, NOW())
       ON DUPLICATE KEY UPDATE
         ruta_id = VALUES(ruta_id),
         rol_en_ruta = 'supervisor',
         hereda_kpis = 0,
         hereda_calificacion_supervisor = 0,
         asignado_por = VALUES(asignado_por),
         asignado_en = NOW(),
         activo = 1`,
      [empleadoId, rutaId, req.session?.user?.id || null]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('Error al asignar supervisor a ruta:', err);
    return res.status(500).json({ ok: false, error: 'No se pudo asignar el supervisor a la ruta' });
  }
});

// Agrega un colaborador a una ruta.
router.post('/rutas/:id/colaboradores', isAuth, requireRole(['admin']), async (req, res) => {
  const rutaId = parseInt(req.params.id, 10);
  const empleadoId = parseInt(req.body?.empleado_id, 10);
  const heredaKpis = req.body?.hereda_kpis ? 1 : 0;
  const heredaCalif = req.body?.hereda_calificacion_supervisor ? 1 : 0;
  if (!rutaId || Number.isNaN(rutaId) || !empleadoId || Number.isNaN(empleadoId)) {
    return res.status(400).json({ ok: false, error: 'Datos inválidos' });
  }
  try {
    // Verificar ruta y empleado
    const [[routeExists]] = await pool.execute('SELECT COUNT(*) AS cnt FROM supervision_rutas WHERE id = ?', [rutaId]);
    if (!routeExists || routeExists.cnt === 0) return res.status(404).json({ ok: false, error: 'Ruta no encontrada' });
    const [[empExists]] = await pool.execute('SELECT COUNT(*) AS cnt FROM empleados WHERE id = ?', [empleadoId]);
    if (!empExists || empExists.cnt === 0) return res.status(404).json({ ok: false, error: 'Empleado no encontrado' });
    // Insertar o actualizar colaborador
    await pool.execute(
      `INSERT INTO empleado_supervision_ruta
        (empleado_id, ruta_id, rol_en_ruta, hereda_kpis, hereda_calificacion_supervisor, asignado_por, activo, asignado_en)
       VALUES (?, ?, 'colaborador', ?, ?, ?, 1, NOW())
       ON DUPLICATE KEY UPDATE
         ruta_id = VALUES(ruta_id),
         rol_en_ruta = 'colaborador',
         hereda_kpis = VALUES(hereda_kpis),
         hereda_calificacion_supervisor = VALUES(hereda_calificacion_supervisor),
         asignado_por = VALUES(asignado_por),
         asignado_en = NOW(),
         activo = 1`,
      [empleadoId, rutaId, heredaKpis, heredaCalif, req.session?.user?.id || null]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('Error al agregar colaborador a ruta:', err);
    return res.status(500).json({ ok: false, error: 'No se pudo agregar el colaborador' });
  }
});

// Actualiza propiedades de un colaborador en una ruta.
router.put('/rutas/:id/colaboradores/:empleadoId', isAuth, requireRole(['admin']), async (req, res) => {
  const rutaId = parseInt(req.params.id, 10);
  const empleadoId = parseInt(req.params.empleadoId, 10);
  const heredaKpis = req.body?.hereda_kpis ? 1 : 0;
  const heredaCalif = req.body?.hereda_calificacion_supervisor ? 1 : 0;
  const activo = req.body?.activo ? 1 : 0;
  if (!rutaId || Number.isNaN(rutaId) || !empleadoId || Number.isNaN(empleadoId)) {
    return res.status(400).json({ ok: false, error: 'Datos inválidos' });
  }
  try {
    await pool.execute(
      `UPDATE empleado_supervision_ruta
       SET hereda_kpis = ?,
           hereda_calificacion_supervisor = ?,
           activo = ?,
           asignado_por = ?,
           asignado_en = NOW()
       WHERE empleado_id = ? AND ruta_id = ? AND rol_en_ruta = 'colaborador'`,
      [heredaKpis, heredaCalif, activo, req.session?.user?.id || null, empleadoId, rutaId]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('Error al actualizar colaborador de ruta:', err);
    return res.status(500).json({ ok: false, error: 'No se pudo actualizar el colaborador' });
  }
});

// Desactiva (baja lógica) un colaborador de una ruta.
router.delete('/rutas/:id/colaboradores/:empleadoId', isAuth, requireRole(['admin']), async (req, res) => {
  const rutaId = parseInt(req.params.id, 10);
  const empleadoId = parseInt(req.params.empleadoId, 10);
  if (!rutaId || Number.isNaN(rutaId) || !empleadoId || Number.isNaN(empleadoId)) {
    return res.status(400).json({ ok: false, error: 'Datos inválidos' });
  }
  try {
    await pool.execute(
      `UPDATE empleado_supervision_ruta
       SET activo = 0,
           asignado_por = ?,
           asignado_en = NOW()
       WHERE empleado_id = ? AND ruta_id = ?`,
      [req.session?.user?.id || null, empleadoId, rutaId]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('Error al eliminar colaborador de ruta:', err);
    return res.status(500).json({ ok: false, error: 'No se pudo eliminar el colaborador' });
  }
});

// Endpoint de búsqueda de empleados disponibles para asignar a una ruta.
// Permite filtrar por texto libre en nombre, número de incidencia, puesto, departamento o sucursal.
router.get('/empleados-disponibles', isAuth, requireRole(['admin', 'manager']), async (req, res) => {
  const q = String(req.query.q || '').trim();
  const soloOperaciones = String(req.query.solo_operaciones || '').trim() === '1';
  const rutaId = parseInt(req.query.ruta_id, 10) || null;
  try {
    let where = '';
    const params = [];
    if (soloOperaciones) {
      // Capital Humano puede traer estos empleados de varias formas:
      //   1) Departamento OPERACIONES SUCURSALES
      //   2) Departamento OPERACIONES (sin la palabra SUCURSALES)
      //   3) Departamento SUPERVISION 1..6
      //   4) Sucursal virtual SUPERVISION 1..6
      //
      // Por eso la busqueda de colaboradores debe aceptar OPERACIONES completo,
      // no solo OPERACIONES SUCURSALES.  La ruta especifica se sigue respetando
      // para los detectados por departamento/sucursal SUPERVISION X, pero los
      // empleados de OPERACIONES quedan disponibles para asignarse manualmente
      // a cualquier ruta desde la pantalla.
      if (rutaId) {
        where += `AND (
                    UPPER(COALESCE(d.nombre, '')) LIKE '%OPERACIONES%'
                    OR sd.id = ?
                    OR sv.id = ?
                  ) `;
        params.push(rutaId, rutaId);
      } else {
        where += `AND UPPER(COALESCE(d.nombre, '')) LIKE '%OPERACIONES%' `;
      }
      // Este endpoint alimenta el selector de colaboradores, por lo que no
      // debe mezclar supervisores. Los supervisores se administran en su selector.
      where += `AND UPPER(COALESCE(p.nombre, '')) NOT LIKE '%SUPERVISOR%' `;
    }
    if (q) {
      where += `AND (
        e.nombre LIKE ? OR
        e.incidencia_id LIKE ? OR
        p.nombre LIKE ? OR
        d.nombre LIKE ? OR
        s.nombre LIKE ?
      )`;
      const like = `%${q}%`;
      params.push(like, like, like, like, like);
    }
    // Excluir empleados ya asignados (activos) a cualquier ruta
    const sql = `SELECT e.id, e.incidencia_id, e.nombre,
                        p.nombre AS puesto,
                        d.nombre AS departamento,
                        s.nombre AS sucursal
                 FROM empleados e
                 LEFT JOIN puestos p ON p.id = e.puesto_id
                 LEFT JOIN departamentos d ON d.id = e.departamento_id
                 LEFT JOIN supervision_rutas sd ON UPPER(TRIM(sd.nombre)) = UPPER(TRIM(d.nombre))
                 LEFT JOIN sucursales s ON s.id = e.sucursal_id
                 LEFT JOIN supervision_rutas sv ON UPPER(TRIM(sv.nombre)) = UPPER(TRIM(s.nombre))
                 WHERE e.id NOT IN (
                   SELECT empleado_id FROM empleado_supervision_ruta WHERE activo = 1
                 )
                   AND (d.nombre IS NULL OR UPPER(d.nombre) <> 'BAJA')
                   ${where}
                 ORDER BY e.nombre
                 LIMIT 50`;
    const [rows] = await pool.execute(sql, params);
    return res.json({ ok: true, empleados: rows });
  } catch (err) {
    console.error('Error al buscar empleados disponibles:', err);
    return res.status(500).json({ ok: false, error: 'No se pudieron buscar empleados' });
  }
});

module.exports = router;