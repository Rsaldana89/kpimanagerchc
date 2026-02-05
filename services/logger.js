const { pool } = require('../db');

/*
 * Simple logger utility for KPI Manager.
 *
 * This helper writes an entry into the `logkpimanager` table. It is
 * intentionally tolerant to errors: if logging fails it will
 * output to the console but will not prevent the main operation
 * from succeeding.  The table `logkpimanager` should exist with
 * columns matching the insert below (usuario_id, usuario_nombre,
 * accion, entidad, entidad_id, descripcion, detalle, ip, user_agent).
 *
 * Usage example:
 *   const { logAction } = require('../services/logger');
 *   await logAction({
 *     accion: 'KPI_SAVE',
 *     entidad: 'kpi_resultados',
 *     entidadId: someId,
 *     descripcion: 'Guardó resultado de KPI',
 *     detalle: { empleadoId, kpiId, anio, mes, valor, color },
 *     req
 *   });
 */
async function logAction({ accion, entidad = null, entidadId = null, descripcion = null, detalle = null, req = null }) {
  try {
    // Extract user and request metadata if available
    const user = req && req.session ? req.session.user : null;
    const usuarioId = user ? user.id : null;
    const usuarioNombre = user ? (user.nombre || user.username || String(user.id)) : null;
    const ip = req && (req.ip || req.headers['x-forwarded-for']) || null;
    const userAgent = req && req.headers ? req.headers['user-agent'] : null;
    let detalleStr = null;
    if (detalle !== null && detalle !== undefined) {
      try {
        detalleStr = JSON.stringify(detalle);
      } catch (e) {
        detalleStr = String(detalle);
      }
    }
    await pool.execute(
      `INSERT INTO logkpimanager (usuario_id, usuario_nombre, accion, entidad, entidad_id, descripcion, detalle, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [usuarioId, usuarioNombre, accion, entidad, entidadId, descripcion, detalleStr, ip, userAgent]
    );
  } catch (e) {
    // Swallow logging errors to avoid breaking primary flows
    console.error('Error registrando logkpimanager:', e);
  }
}

module.exports = { logAction };