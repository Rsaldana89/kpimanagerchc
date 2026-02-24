/*
 * Utilities for handling KPIs in the context of virtual supervisory branches.
 *
 * This module provides helpers to override KPI assignments for employees
 * assigned to virtual branches named `SUPERVISION X` (where `X` is 1‑6) and
 * to mirror KPI results from branch supervisors to all employees in the same
 * virtual branch.  The purpose of these helpers is to encapsulate the
 * business rules described in the specification:
 *
 *   • If an employee belongs to a virtual branch whose name matches
 *     /^SUPERVISION\s+[1-6]$/i and their puesto_id is not 46
 *     (Supervisor de Sucursal), they should see the KPIs assigned to
 *     puesto 46 instead of their own puesto.
 *
 *   • When a supervisor (puesto_id = 46) belonging to a virtual branch
 *     saves a KPI result, marks it as approved (visto bueno) or when
 *     their boss sends the KPI to review or re-approves it, the system
 *     must replicate (upsert) that result and state to all other
 *     employees in the same branch (excluding other supervisors and the
 *     supervisor themself).  This ensures that employees under the
 *     virtual branch have mirrored data for reporting and export.
 */

const { pool } = require('../db');
const { logAction } = require('./logger');

// Regular expression to detect names like "SUPERVISION 1", "SUPERVISION 2", … "SUPERVISION 6".
// It is case-insensitive and trims surrounding whitespace before testing.
const VIRTUAL_BRANCH_REGEX = /^SUPERVISION\s+[1-6]$/i;

/**
 * Determine the effective puesto_id to use for KPI assignment for a given employee.
 *
 * For employees in a virtual supervisory branch (sucursal.nombre matches
 * VIRTUAL_BRANCH_REGEX) whose puesto_id is not 46, this function returns 46.
 * Otherwise it returns the employee's actual puesto_id.
 *
 * @param {number} employeeId ID of the employee
 * @returns {Promise<number|null>} Effective puesto ID or null if employee not found
 */
async function getEffectivePositionId(employeeId) {
  if (!employeeId || isNaN(employeeId)) return null;
  const [rows] = await pool.execute(
    `SELECT e.puesto_id, s.nombre AS sucursal_nombre
     FROM empleados e
     LEFT JOIN sucursales s ON s.id = e.sucursal_id
     WHERE e.id = ?
     LIMIT 1`,
    [employeeId]
  );
  if (!rows || !rows.length) return null;
  const { puesto_id, sucursal_nombre } = rows[0];
  if (sucursal_nombre && VIRTUAL_BRANCH_REGEX.test(String(sucursal_nombre).trim()) && Number(puesto_id) !== 46) {
    return 46;
  }
  return Number(puesto_id);
}

/**
 * Return the list of KPIs for an employee, taking into account virtual branch
 * rules.  If the employee is in a virtual branch (1–6) and not already a
 * supervisor (puesto_id 46), the KPIs assigned to puesto 46 are returned.
 * Otherwise the KPIs assigned to the employee's own puesto are returned.
 *
 * @param {number} employeeId ID of the employee
 * @param {Function} getKPIsByPosition Function that fetches KPIs by puesto
 *   (signature: async function(positionId) => array)
 * @returns {Promise<Array>} List of KPI definitions for the employee
 */
async function getKPIsForEmployee(employeeId, getKPIsByPosition) {
  const posId = await getEffectivePositionId(employeeId);
  if (!posId) return [];
  return await getKPIsByPosition(posId);
}

/**
 * Mirror a supervisor's KPI result to all employees in the same virtual
 * branch.  This helper should be invoked after the supervisor's own KPI
 * record has been inserted or updated.  It will replicate the supervisor's
 * result and approval/revision state to each employee in the same
 * sucursal_id whose puesto_id is not 46 (excluding the supervisor).
 *
 * @param {number} supervisorId ID of the supervisor whose result was updated
 * @param {number|string} kpiId ID of the KPI
 * @param {number|string} anio Year of the result
 * @param {number|string} mes Month of the result (1–12)
 * @param {number|null} actorUserId ID of the user performing the operation
 *   (for logging purposes).  May be null.
 */
async function mirrorVirtualSucursalKpi(supervisorId, kpiId, anio, mes, actorUserId = null) {
  // Validate supervisor identity and branch
  const [supRows] = await pool.execute(
    `SELECT e.puesto_id, e.sucursal_id, s.nombre AS sucursal_nombre
     FROM empleados e
     LEFT JOIN sucursales s ON s.id = e.sucursal_id
     WHERE e.id = ?
     LIMIT 1`,
    [supervisorId]
  );
  if (!supRows || supRows.length === 0) return;
  const sup = supRows[0];
  if (Number(sup.puesto_id) !== 46) return;
  const branchName = sup.sucursal_nombre ? String(sup.sucursal_nombre).trim() : '';
  if (!branchName || !VIRTUAL_BRANCH_REGEX.test(branchName)) return;
  const sucursalId = sup.sucursal_id;
  // Fetch the supervisor's KPI result to copy
  const [resRows] = await pool.execute(
    `SELECT valor, color, comentario, visto_bueno, visto_por, visto_fecha,
            revision_por, revision_fecha, revision_motivo
     FROM kpi_resultados
     WHERE empleado_id = ? AND kpi_id = ? AND anio = ? AND mes = ?
     LIMIT 1`,
    [supervisorId, kpiId, anio, mes]
  );
  if (!resRows || resRows.length === 0) return;
  const res = resRows[0];
  // Identify all employees in the same sucursal who are not supervisors (46) and not the supervisor
  const [empRows] = await pool.execute(
    `SELECT id
     FROM empleados
     WHERE sucursal_id = ? AND id <> ? AND puesto_id <> 46`,
    [sucursalId, supervisorId]
  );
  if (!empRows || empRows.length === 0) return;
  let replicatedCount = 0;
  for (const emp of empRows) {
    await pool.execute(
      `INSERT INTO kpi_resultados (empleado_id, kpi_id, anio, mes, valor, color, comentario,
                                   visto_bueno, visto_por, visto_fecha,
                                   revision_por, revision_fecha, revision_motivo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         valor = VALUES(valor),
         color = VALUES(color),
         comentario = VALUES(comentario),
         visto_bueno = VALUES(visto_bueno),
         visto_por = VALUES(visto_por),
         visto_fecha = VALUES(visto_fecha),
         revision_por = VALUES(revision_por),
         revision_fecha = VALUES(revision_fecha),
         revision_motivo = VALUES(revision_motivo)`,
      [emp.id, kpiId, anio, mes,
       res.valor || null,
       res.color || null,
       res.comentario || null,
       res.visto_bueno || 0,
       res.visto_por || null,
       res.visto_fecha || null,
       res.revision_por || null,
       res.revision_fecha || null,
       res.revision_motivo || null]
    );
    replicatedCount++;
  }
  // Log the replication; the log is tolerant to errors.
  const detalle = {
    kpiId: Number(kpiId),
    anio: Number(anio),
    mes: Number(mes),
    supervisorId: Number(supervisorId),
    replicatedEmployees: replicatedCount,
    branchName
  };
  try {
    await logAction({ accion: 'KPI_MIRROR', entidad: 'kpi_resultados', entidadId: null,
                      descripcion: 'Replica de KPI a sucursal virtual', detalle, req: null });
  } catch (e) {
    // ignore logging errors
  }
  // Also output to console for operational visibility
  console.log(`[MIRROR] replicated KPI ${kpiId} ${anio}-${mes} from supervisor ${supervisorId} to ${replicatedCount} employees in sucursal ${branchName}`);
}

module.exports = {
  getEffectivePositionId,
  getKPIsForEmployee,
  mirrorVirtualSucursalKpi,
  VIRTUAL_BRANCH_REGEX
};