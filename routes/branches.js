const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const isAuth = require('../middleware/isAuth');
const { requireRole } = require('../middleware/roles');

// Helper to ensure the departamento_sucursales table exists.
async function ensureDepSucTable() {
  // Creates a join table between departamentos and sucursales if it does not exist yet.
  // The table uses a composite primary key to avoid duplicate assignments.
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS departamento_sucursales (
      departamento_id INT NOT NULL,
      sucursal_id INT NOT NULL,
      PRIMARY KEY (departamento_id, sucursal_id),
      FOREIGN KEY (departamento_id) REFERENCES departamentos(id) ON DELETE CASCADE,
      FOREIGN KEY (sucursal_id) REFERENCES sucursales(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

/*
 * GET /branches
 * Devuelve la lista de todas las sucursales disponibles.
 * Respuesta: { branches: [ { id, nombre } ] }
 */
router.get('/branches', isAuth, requireRole(['admin','manager']), async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT id, nombre FROM sucursales ORDER BY nombre');
    return res.json({ ok: true, branches: rows });
  } catch (err) {
    console.error('Error al listar sucursales:', err);
    return res.status(500).json({ ok: false, error: 'No se pudo obtener la lista de sucursales' });
  }
});

/*
 * GET /departments/:id/branches
 * Devuelve las sucursales asignadas a un departamento específico.
 * Respuesta: { branches: [ { id, nombre } ] }
 */
router.get('/departments/:id/branches', isAuth, requireRole(['admin','manager']), async (req, res) => {
  const deptId = parseInt(req.params.id, 10);
  if (!deptId || isNaN(deptId)) {
    return res.status(400).json({ ok: false, error: 'Departamento inválido' });
  }
  try {
    await ensureDepSucTable();
    const [rows] = await pool.execute(
      `SELECT s.id, s.nombre
       FROM departamento_sucursales ds
       JOIN sucursales s ON s.id = ds.sucursal_id
       WHERE ds.departamento_id = ?
       ORDER BY s.nombre`,
      [deptId]
    );
    return res.json({ ok: true, branches: rows });
  } catch (err) {
    console.error('Error al listar sucursales del departamento:', err);
    return res.status(500).json({ ok: false, error: 'No se pudieron obtener las sucursales del departamento' });
  }
});

/*
 * POST /departments/:id/branches
 * Asigna una sucursal a un departamento.  Si ya existe la asignación, se ignora.
 * Body: { branchId: number }
 * Respuesta: { ok: true }
 */
router.post('/departments/:id/branches', isAuth, requireRole(['admin','manager']), express.json(), async (req, res) => {
  const deptId = parseInt(req.params.id, 10);
  const branchId = req.body && (req.body.branchId || req.body.branch_id);
  const branchIdNum = parseInt(branchId, 10);
  if (!deptId || isNaN(deptId) || !branchIdNum || isNaN(branchIdNum)) {
    return res.status(400).json({ ok: false, error: 'Datos inválidos' });
  }
  try {
    await ensureDepSucTable();
    // Verificar que la sucursal exista
    const [branchRows] = await pool.execute('SELECT id FROM sucursales WHERE id = ?', [branchIdNum]);
    if (!branchRows.length) {
      return res.status(404).json({ ok: false, error: 'Sucursal no encontrada' });
    }
    // Insertar relación si no existe
    await pool.execute(
      `INSERT IGNORE INTO departamento_sucursales (departamento_id, sucursal_id)
       VALUES (?, ?)`,
      [deptId, branchIdNum]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('Error al asignar sucursal:', err);
    return res.status(500).json({ ok: false, error: 'No se pudo asignar la sucursal al departamento' });
  }
});

/*
 * DELETE /departments/:id/branches/:branchId
 * Elimina la relación entre una sucursal y un departamento.
 * Respuesta: { ok: true }
 */
router.delete('/departments/:id/branches/:branchId', isAuth, requireRole(['admin','manager']), async (req, res) => {
  const deptId = parseInt(req.params.id, 10);
  const branchId = parseInt(req.params.branchId, 10);
  if (!deptId || isNaN(deptId) || !branchId || isNaN(branchId)) {
    return res.status(400).json({ ok: false, error: 'Datos inválidos' });
  }
  try {
    await ensureDepSucTable();
    await pool.execute(
      `DELETE FROM departamento_sucursales WHERE departamento_id = ? AND sucursal_id = ?`,
      [deptId, branchId]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('Error al eliminar sucursal del departamento:', err);
    return res.status(500).json({ ok: false, error: 'No se pudo eliminar la sucursal del departamento' });
  }
});

module.exports = router;