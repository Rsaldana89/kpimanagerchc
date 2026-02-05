const { pool } = require('../db');

/**
 * Inserta un registro en logkpimanager.
 * No rompe el flujo principal si falla el INSERT.
 */
async function logKpiManager(req, {
  accion,
  entidad = null,
  entidad_id = null,
  descripcion = null,
  detalle = null,
} = {}) {
  try {
    if (!accion) return;

    const user = (req && req.session) ? req.session.user : null;
    const usuario_id = (user && user.id) ? user.id : null;
    const usuario_nombre = (user && user.nombre) ? user.nombre : null;

    const forwarded = req && req.headers ? req.headers['x-forwarded-for'] : null;
    const remote = req && req.connection ? req.connection.remoteAddress : null;
    const ip = forwarded ? String(forwarded).split(',')[0].trim() : (remote ? String(remote) : null);
    const user_agent = (req && req.headers) ? (req.headers['user-agent'] || null) : null;

    let detalleJson = null;
    if (detalle !== null && typeof detalle !== 'undefined') {
      try {
        detalleJson = JSON.stringify(detalle);
      } catch (e) {
        detalleJson = JSON.stringify({ error: 'detalle_no_serializable' });
      }
    }

    await pool.query(
      `INSERT INTO logkpimanager (usuario_id, usuario_nombre, accion, entidad, entidad_id, descripcion, detalle, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?)`,
      [usuario_id, usuario_nombre, accion, entidad, entidad_id, descripcion, detalleJson, ip, user_agent]
    );
  } catch (err) {
    // Intencional: no romper flujo principal
  }
}

module.exports = { logKpiManager };
