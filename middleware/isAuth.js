/*
 * Middleware para verificar si el usuario ha iniciado sesión.
 * Si no existe una sesión activa, redirige al formulario de login.
 */

module.exports = function isAuthenticated(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  return res.redirect('/login');
};