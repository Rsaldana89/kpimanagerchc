/*
 * Middleware y utilidades relacionadas con los roles de usuario.
 *
 * Este módulo expone funciones para comprobar que el usuario
 * conectado cuenta con alguno de los roles permitidos antes de
 * continuar con la ejecución de la ruta.  Si el usuario no
 * tiene una sesión activa o su rol no está dentro de la lista
 * proporcionada, se redirige al dashboard y se muestra un
 * mensaje de error.
 */

/**
 * Crea un middleware que permite el acceso únicamente a los
 * usuarios cuyo rol esté en el arreglo proporcionado.
 *
 * @param {string[]} roles - Lista de roles autorizados (por ejemplo ['admin', 'manager']).
 * @returns {Function} Middleware de Express.
 */
function requireRole(roles) {
  return function (req, res, next) {
    // Si no hay usuario en sesión, redirigir a login
    if (!req.session || !req.session.user) {
      return res.redirect('/login');
    }
    const userRole = req.session.user.role || 'user';
    if (roles.includes(userRole)) {
      return next();
    }
    // Usuario no autorizado
    req.flash('error', 'No tiene permisos para acceder a esta sección');
    return res.redirect('/dashboard');
  };
}

module.exports = { requireRole };