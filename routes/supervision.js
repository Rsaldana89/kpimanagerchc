const express = require('express');
const router = express.Router();

const { pool } = require('../db');
const isAuth = require('../middleware/isAuth');
const { requireRole } = require('../middleware/roles');

/**
 * Gestión de rutas de supervisión.
 *
 * Tablas:
 *  - supervision_rutas (1..6)
 *  - sucursal_supervision_ruta (sucursal_id -> ruta_id)
 *  - empleado_supervision_ruta (empleado_id -> ruta_id) para empleados SIN sucursal
 *
 * Nota: este módulo NO cambia la lógica de jerarquía por puesto (responde_a_id).
 */

async function ensureSupervisionTables() {
  // 1) Catálogo de rutas
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS supervision_rutas (
      id TINYINT UNSIGNED NOT NULL,
      nombre VARCHAR(30) NOT NULL,
      activo TINYINT(1) NOT NULL DEFAULT 1,
      PRIMARY KEY (id),
      UNIQUE KEY uq_supervision_rutas_nombre (nombre)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Seed 1..6
  await pool.execute(`
    INSERT INTO supervision_rutas (id, nombre) VALUES
      (1,'SUPERVISION 1'),
      (2,'SUPERVISION 2'),
      (3,'SUPERVISION 3'),
      (4,'SUPERVISION 4'),
      (5,'SUPERVISION 5'),
      (6,'SUPERVISION 6')
    ON DUPLICATE KEY UPDATE
      nombre = VALUES(nombre),
      activo = 1
  `);

  // 2) Sucursal -> ruta
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS sucursal_supervision_ruta (
      sucursal_id INT NOT NULL,
      ruta_id TINYINT UNSIGNED NOT NULL,
      activo TINYINT(1) NOT NULL DEFAULT 1,
      actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (sucursal_id),
      KEY idx_ssr_ruta (ruta_id),
      CONSTRAINT fk_ssr_sucursal
        FOREIGN KEY (sucursal_id) REFERENCES sucursales(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
      CONSTRAINT fk_ssr_ruta
        FOREIGN KEY (ruta_id) REFERENCES supervision_rutas(id)
        ON DELETE RESTRICT
        ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // 3) Empleado -> ruta (para roles sin sucursal)
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS empleado_supervision_ruta (
      empleado_id INT NOT NULL,
      ruta_id TINYINT UNSIGNED NOT NULL,
      activo TINYINT(1) NOT NULL DEFAULT 1,
      actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (empleado_id),
      KEY idx_esr_ruta (ruta_id),
      CONSTRAINT fk_esr_empleado
        FOREIGN KEY (empleado_id) REFERENCES empleados(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
      CONSTRAINT fk_esr_ruta
        FOREIGN KEY (ruta_id) REFERENCES supervision_rutas(id)
        ON DELETE RESTRICT
        ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

function parseRutaId(val) {
  const n = parseInt(val, 10);
  if (!n || Number.isNaN(n) || n < 1 || n > 6) return null;
  return n;
}

async function getRutaAndVirtualSucursal(rutaId) {
  // Ruta
  const [rRows] = await pool.execute(
    'SELECT id, nombre, activo FROM supervision_rutas WHERE id = ? LIMIT 1',
    [rutaId]
  );
  if (!rRows.length) return null;
  const ruta = rRows[0];
  // La sucursal virtual se llama igual que la ruta (SUPERVISION 1..6)
  const [sRows] = await pool.execute(
    'SELECT id, nombre FROM sucursales WHERE nombre = ? LIMIT 1',
    [ruta.nombre]
  );
    return {
    ruta,
    virtualSucursalId: sRows.length ? sRows[0].id : null
  };
}

async function getOperacionesDepartamentoId() {
  const [dRows] = await pool.execute(
    "SELECT id FROM departamentos WHERE UPPER(nombre) = 'OPERACIONES' LIMIT 1"
  );
  return dRows.length ? dRows[0].id : null;
}

// ---------------------------------------------------------------------------
// READ
// ---------------------------------------------------------------------------

// GET /supervision/routes
router.get('/routes', isAuth, requireRole(['admin', 'manager']), async (req, res) => {
  try {
    await ensureSupervisionTables();
    const [rows] = await pool.execute(
      `SELECT id, nombre, activo FROM supervision_rutas WHERE activo = 1 ORDER BY id`
    );
    return res.json({ ok: true, routes: rows });
  } catch (err) {
    console.error('Error al listar rutas de supervisión:', err);
    return res.status(500).json({ ok: false, error: 'No se pudieron obtener las rutas' });
  }
});

// GET /supervision/eligible-employees
// Devuelve empleados elegibles para asignar a una ruta.
// A petición de Capital Humano, sólo los SUPERVISORES DE SUCURSAL (puesto 46) pueden ser
// responsables de una ruta.  No se listan los auxiliares de supervisión (puesto 45).
router.get('/eligible-employees', isAuth, requireRole(['admin', 'manager']), async (req, res) => {
  try {
    await ensureSupervisionTables();
    // Puesto objetivo: 46 SUPERVISOR DE SUCURSAL
    const [rows] = await pool.execute(
      `SELECT e.id, e.nombre, p.nombre AS puesto
       FROM empleados e
       JOIN puestos p ON p.id = e.puesto_id
       WHERE e.puesto_id = 46
       ORDER BY e.nombre`
    );
    return res.json({ ok: true, employees: rows });
  } catch (err) {
    console.error('Error al listar empleados elegibles para ruta:', err);
    return res.status(500).json({ ok: false, error: 'No se pudieron obtener los empleados' });
  }
});

// GET /supervision/routes/:rutaId/branches
router.get('/routes/:rutaId/branches', isAuth, requireRole(['admin', 'manager']), async (req, res) => {
  const rutaId = parseRutaId(req.params.rutaId);
  if (!rutaId) return res.status(400).json({ ok: false, error: 'Ruta inválida' });
  try {
    await ensureSupervisionTables();
    const [rows] = await pool.execute(
      `SELECT s.id, s.nombre
       FROM sucursal_supervision_ruta ssr
       JOIN sucursales s ON s.id = ssr.sucursal_id
       WHERE ssr.ruta_id = ? AND ssr.activo = 1
       ORDER BY s.nombre`,
      [rutaId]
    );
    return res.json({ ok: true, branches: rows });
  } catch (err) {
    console.error('Error al listar sucursales de ruta:', err);
    return res.status(500).json({ ok: false, error: 'No se pudieron obtener las sucursales de la ruta' });
  }
});

// GET /supervision/routes/:rutaId/employees
router.get('/routes/:rutaId/employees', isAuth, requireRole(['admin', 'manager']), async (req, res) => {
  const rutaId = parseRutaId(req.params.rutaId);
  if (!rutaId) return res.status(400).json({ ok: false, error: 'Ruta inválida' });
  try {
    await ensureSupervisionTables();
    const rutaInfo = await getRutaAndVirtualSucursal(rutaId);
    if (!rutaInfo) return res.status(404).json({ ok: false, error: 'Ruta no encontrada' });

    // Si no existe la sucursal virtual (SUPERVISION X), regresamos vacío y dejamos que el usuario la cree.
    if (!rutaInfo.virtualSucursalId) {
      return res.json({ ok: true, employees: [], virtualSucursalMissing: true });
    }

    // Los responsables de ruta viven en la sucursal virtual: SUPERVISION X
    // Además, incluir empleados asignados a la ruta mediante la tabla empleado_supervision_ruta
    // Seleccionar todos los empleados asignados a la ruta.
    // Incluye:
    //   1) Empleados de la sucursal virtual SUPERVISION X (cualquier puesto)
    //   2) Empleados asignados a la ruta mediante empleado_supervision_ruta (cualquier puesto)
    const [rows] = await pool.execute(
      `SELECT DISTINCT e.id, e.nombre, e.puesto_id, p.nombre AS puesto
       FROM empleados e
       JOIN puestos p ON p.id = e.puesto_id
       LEFT JOIN departamentos d ON d.id = e.departamento_id
       WHERE (
         e.sucursal_id = ?
         OR e.id IN (
           SELECT esr.empleado_id
           FROM empleado_supervision_ruta esr
           WHERE esr.ruta_id = ? AND esr.activo = 1
         )
       )
         AND (d.nombre IS NULL OR UPPER(d.nombre) <> 'BAJA')
       ORDER BY e.nombre`,
      [rutaInfo.virtualSucursalId, rutaId]
    );
    return res.json({ ok: true, employees: rows, virtualSucursalId: rutaInfo.virtualSucursalId });
  } catch (err) {
    console.error('Error al listar empleados de ruta:', err);
    return res.status(500).json({ ok: false, error: 'No se pudieron obtener los empleados de la ruta' });
  }
});

// ---------------------------------------------------------------------------
// WRITE (solo admin)
// ---------------------------------------------------------------------------

// POST /supervision/routes/:rutaId/branches {branchId}
router.post('/routes/:rutaId/branches', isAuth, requireRole(['admin']), express.json(), async (req, res) => {
  const rutaId = parseRutaId(req.params.rutaId);
  const branchId = parseInt(req.body?.branchId, 10);
  if (!rutaId) return res.status(400).json({ ok: false, error: 'Ruta inválida' });
  if (!branchId || Number.isNaN(branchId)) return res.status(400).json({ ok: false, error: 'Sucursal inválida' });

  try {
    await ensureSupervisionTables();
    // validar sucursal
    const [b] = await pool.execute('SELECT id FROM sucursales WHERE id = ?', [branchId]);
    if (!b.length) return res.status(404).json({ ok: false, error: 'Sucursal no encontrada' });

    // upsert (1 sucursal = 1 ruta)
    await pool.execute(
      `INSERT INTO sucursal_supervision_ruta (sucursal_id, ruta_id, activo)
       VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE ruta_id = VALUES(ruta_id), activo = 1`,
      [branchId, rutaId]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('Error al asignar sucursal a ruta:', err);
    return res.status(500).json({ ok: false, error: 'No se pudo asignar la sucursal a la ruta' });
  }
});

// DELETE /supervision/routes/:rutaId/branches/:branchId
router.delete('/routes/:rutaId/branches/:branchId', isAuth, requireRole(['admin']), async (req, res) => {
  const rutaId = parseRutaId(req.params.rutaId);
  const branchId = parseInt(req.params.branchId, 10);
  if (!rutaId) return res.status(400).json({ ok: false, error: 'Ruta inválida' });
  if (!branchId || Number.isNaN(branchId)) return res.status(400).json({ ok: false, error: 'Sucursal inválida' });

  try {
    await ensureSupervisionTables();
    await pool.execute(
      `DELETE FROM sucursal_supervision_ruta WHERE sucursal_id = ? AND ruta_id = ?`,
      [branchId, rutaId]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('Error al eliminar sucursal de ruta:', err);
    return res.status(500).json({ ok: false, error: 'No se pudo eliminar la sucursal de la ruta' });
  }
});

// POST /supervision/routes/:rutaId/employees {employeeId}
router.post('/routes/:rutaId/employees', isAuth, requireRole(['admin']), express.json(), async (req, res) => {
  const rutaId = parseRutaId(req.params.rutaId);
  const employeeId = parseInt(req.body?.employeeId, 10);
  if (!rutaId) return res.status(400).json({ ok: false, error: 'Ruta inválida' });
  if (!employeeId || Number.isNaN(employeeId)) return res.status(400).json({ ok: false, error: 'Empleado inválido' });

  try {
    await ensureSupervisionTables();
    const rutaInfo = await getRutaAndVirtualSucursal(rutaId);
    if (!rutaInfo) return res.status(404).json({ ok: false, error: 'Ruta no encontrada' });
    if (!rutaInfo.virtualSucursalId) {
      return res.status(400).json({
        ok: false,
        error: `No existe la sucursal virtual "${rutaInfo.nombre}". Créala en el catálogo de sucursales y asígnala a OPERACIONES.`
      });
    }

    const [e] = await pool.execute('SELECT id, puesto_id FROM empleados WHERE id = ? LIMIT 1', [employeeId]);
    if (!e.length) return res.status(404).json({ ok: false, error: 'Empleado no encontrado' });

    // Solo permitir supervisor (46).  A petición de Capital Humano, los auxiliares de
    // supervisión (45) no se asignan como responsables de ruta desde esta interfaz.
    const puestoId = parseInt(e[0].puesto_id, 10);
    if (puestoId !== 46) {
      return res.status(400).json({ ok: false, error: 'Solo se pueden asignar supervisores de sucursal a la ruta' });
    }

    // En la nueva lógica, el responsable de la ruta se asigna por sucursal virtual:
    // - Supervisor/Auxiliar debe tener sucursal_id = (sucursal virtual "SUPERVISION X")
    // - Opcionalmente lo forzamos al departamento OPERACIONES.
    const [opsRows] = await pool.execute(
      "SELECT id FROM departamentos WHERE UPPER(nombre) = 'OPERACIONES' LIMIT 1"
    );
    const operacionesId = opsRows.length ? parseInt(opsRows[0].id, 10) : null;

    // Garantizar un único Supervisor y un único Auxiliar por ruta (para que la UI sea clara)
    if (puestoId === 46) {
      await pool.execute(
        'UPDATE empleados SET sucursal_id = NULL WHERE sucursal_id = ? AND puesto_id = 46 AND id <> ?',
        [rutaInfo.virtualSucursalId, employeeId]
      );
    }
    if (puestoId === 45) {
      await pool.execute(
        'UPDATE empleados SET sucursal_id = NULL WHERE sucursal_id = ? AND puesto_id = 45 AND id <> ?',
        [rutaInfo.virtualSucursalId, employeeId]
      );
    }

    await pool.execute(
      'UPDATE empleados SET sucursal_id = ?, departamento_id = COALESCE(?, departamento_id) WHERE id = ? LIMIT 1',
      [rutaInfo.virtualSucursalId, operacionesId, employeeId]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('Error al asignar empleado a ruta:', err);
    return res.status(500).json({ ok: false, error: 'No se pudo asignar el empleado a la ruta' });
  }
});

// DELETE /supervision/routes/:rutaId/employees/:empId
router.delete('/routes/:rutaId/employees/:empId', isAuth, requireRole(['admin']), async (req, res) => {
  const rutaId = parseRutaId(req.params.rutaId);
  const empId = parseInt(req.params.empId, 10);
  if (!rutaId) return res.status(400).json({ ok: false, error: 'Ruta inválida' });
  if (!empId || Number.isNaN(empId)) return res.status(400).json({ ok: false, error: 'Empleado inválido' });

  try {
    await ensureSupervisionTables();
    const rutaInfo = await getRutaAndVirtualSucursal(rutaId);
    if (!rutaInfo?.virtualSucursalId) {
      return res.status(400).json({ ok: false, error: 'No existe la sucursal virtual para esta ruta' });
    }

    await pool.execute(
      `UPDATE empleados
       SET sucursal_id = NULL
      WHERE id = ? AND sucursal_id = ?`,
      [empId, rutaInfo.virtualSucursalId]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('Error al eliminar empleado de ruta:', err);
    return res.status(500).json({ ok: false, error: 'No se pudo eliminar el empleado de la ruta' });
  }
});

module.exports = router;

/*
 * Vista de supervisión (resumen por ruta) para managers y supervisores.
 *
 * Este endpoint sirve un HTML que permite visualizar la estructura de
 * cada ruta de supervisión: primero se listan los empleados asignados
 * a la sucursal virtual (SUPERVISION X) del supervisor y después se
 * enumeran las sucursales reales de esa ruta con sus respectivos
 * colaboradores.  Si no se pasa un supervisorId en la URL, se muestra
 * una lista de todos los supervisores disponibles para selección (solo
 * visible para administradores y managers).  Si el usuario actual es
 * un supervisor (puesto_id = 46) o auxiliar de supervisión (puesto_id = 45),
 * automáticamente se carga su propia ruta sin necesidad de seleccionar.
 */
router.get('/view/:supervisorId?', isAuth, async (req, res) => {
  try {
    // Obtiene el usuario en sesión
    const currentUser = req.session.user;
    if (!currentUser) {
      return res.redirect('/login');
    }

    // Asegurar tablas necesarias
    await ensureSupervisionTables();

    // Helper para obtener rutaId y sucursal virtual de un supervisor
    async function getSupervisorRouteInfo(supId) {
      const [rows] = await pool.execute(
        `SELECT e.id AS empleado_id, e.nombre AS supervisor_nombre, e.puesto_id,
                s.id AS sucursal_id, s.nombre AS sucursal_nombre,
                CAST(TRIM(SUBSTRING_INDEX(s.nombre, ' ', -1)) AS UNSIGNED) AS ruta_id
         FROM empleados e
         JOIN sucursales s ON s.id = e.sucursal_id
         WHERE e.id = ? AND s.nombre LIKE 'SUPERVISION %'`
      , [supId]);
      if (!rows.length) return null;
      return rows[0];
    }

    // Determinar si el usuario es admin/manager
    const isManager = currentUser.role === 'admin' || currentUser.role === 'manager';
    const isSupervisor = [46, 45].includes(Number(currentUser.puesto_id));

    // Si no se especifica supervisorId:
    // - Si usuario es supervisor o auxiliar de supervisión, mostrar su ruta
    // - Si usuario es manager/admin, listar supervisores para seleccionar
    let supervisorIdParam = req.params.supervisorId;
    let supervisorRouteInfo = null;
    if (!supervisorIdParam) {
      if (isSupervisor) {
        supervisorIdParam = currentUser.id;
      } else if (!isManager) {
        // Si no es manager ni supervisor, no permitir acceso
        req.flash('error', 'No tiene permisos para ver esta página');
        return res.redirect('/dashboard');
      }
    }

    // Si aún no hay supervisorId (manager sin selección), obtener lista de supervisores
    if (!supervisorIdParam) {
      // Lista de todos los empleados con puesto Supervisor de Sucursal (46)
      const [supRows] = await pool.execute(
        `SELECT e.id AS empleado_id, e.nombre AS empleado_nombre,
                s.nombre AS sucursal_nombre,
                CAST(TRIM(SUBSTRING_INDEX(s.nombre, ' ', -1)) AS UNSIGNED) AS ruta_id
         FROM empleados e
         JOIN sucursales s ON s.id = e.sucursal_id
         WHERE e.puesto_id = 46 AND s.nombre LIKE 'SUPERVISION %'
         ORDER BY ruta_id, e.nombre`
      );
      return res.render('supervision_view', {
        title: 'Rutas de supervisión',
        supervisorList: supRows,
        supervisor: null,
        virtualEmployees: null,
        branches: null,
        branchEmployees: null,
        isManager
      });
    }

    // Validar supervisorIdParam (numérico)
    const supId = parseInt(supervisorIdParam, 10);
    if (!supId || isNaN(supId)) {
      req.flash('error', 'Supervisor inválido');
      return res.redirect('/supervision/view');
    }
    // Si el usuario no es manager y quiere ver otra ruta que no es la suya
    if (!isManager && supId !== currentUser.id) {
      req.flash('error', 'No tiene permisos para ver esta ruta');
      return res.redirect('/supervision/view');
    }

    supervisorRouteInfo = await getSupervisorRouteInfo(supId);
    if (!supervisorRouteInfo) {
      req.flash('error', 'Supervisor o ruta no encontrados');
      return res.redirect('/supervision/view');
    }
    const rutaId = supervisorRouteInfo.ruta_id;
    const virtualSucursalId = supervisorRouteInfo.sucursal_id;

    // Obtener colaboradores en la sucursal virtual (supervisor y auxiliares de supervisión)
    const [virtualRows] = await pool.execute(
      `SELECT e.id, e.nombre, p.id AS puesto_id, p.nombre AS puesto_nombre,
              s.id AS sucursal_id, s.nombre AS sucursal_nombre
       FROM empleados e
       JOIN puestos p ON p.id = e.puesto_id
       JOIN sucursales s ON s.id = e.sucursal_id
       WHERE e.sucursal_id = ?
         AND p.id IN (45, 46)
       ORDER BY p.nombre, e.nombre`,
      [virtualSucursalId]
    );

    // Obtener todas las sucursales reales de la ruta
    const [branchRows] = await pool.execute(
      `SELECT s.id AS sucursal_id, s.nombre AS sucursal_nombre
       FROM sucursal_supervision_ruta sr
       JOIN sucursales s ON s.id = sr.sucursal_id
       WHERE sr.ruta_id = ? AND sr.activo = 1
       ORDER BY s.nombre`,
      [rutaId]
    );
    // Obtener empleados de estas sucursales
    let branchEmployeesMap = {};
    if (branchRows.length) {
      const branchIds = branchRows.map(b => b.sucursal_id);
      const placeholders = branchIds.map(() => '?').join(',');
      const [empRows] = await pool.execute(
        `SELECT e.id, e.nombre, p.id AS puesto_id, p.nombre AS puesto_nombre,
                s.id AS sucursal_id, s.nombre AS sucursal_nombre
         FROM empleados e
         JOIN puestos p ON p.id = e.puesto_id
         JOIN sucursales s ON s.id = e.sucursal_id
         WHERE e.sucursal_id IN (${placeholders})
         ORDER BY s.nombre, p.nombre, e.nombre`,
        branchIds
      );
      // Agrupar por sucursal
      branchEmployeesMap = empRows.reduce((acc, row) => {
        if (!acc[row.sucursal_id]) acc[row.sucursal_id] = [];
        acc[row.sucursal_id].push(row);
        return acc;
      }, {});
    }

    return res.render('supervision_view', {
      title: `Ruta de supervisión ${rutaId}`,
      supervisorList: null,
      supervisor: supervisorRouteInfo,
      virtualEmployees: virtualRows,
      branches: branchRows,
      branchEmployees: branchEmployeesMap,
      isManager
    });
  } catch (err) {
    console.error('Error en GET /supervision/view:', err);
    req.flash('error', 'No se pudo cargar la vista de supervisión');
    return res.redirect('/dashboard');
  }
});
