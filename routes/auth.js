const express = require('express');
const router = express.Router();
const { pool } = require('../db');

/*
 * Ruta GET /login
 * Muestra el formulario de acceso al sistema.  Si ya existe una
 * sesión activa, redirige al dashboard.
 */
router.get('/login', (req, res) => {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  res.render('login', { title: 'Acceso al sistema' });
});

/*
 * Ruta POST /login
 * Procesa las credenciales enviadas por el usuario, comprueba la
 * existencia de un registro coincidente y crea la sesión.  Los
 * passwords se almacenan en texto plano de acuerdo a la petición del
 * usuario.  En caso de error, se muestra un mensaje flash.
 */
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    req.flash('error', 'Debe proporcionar usuario y contraseña');
    return res.redirect('/login');
  }
  try {
    // Incluir nombre del puesto y del departamento para mostrar en la interfaz
    const [rows] = await pool.execute(
      `SELECT e.id, e.nombre, e.username, e.puesto_id, e.departamento_id,
              p.nombre AS puesto_nombre, d.nombre AS departamento_nombre,
              p.role AS puesto_role
       FROM empleados e
       LEFT JOIN puestos p ON e.puesto_id = p.id
       LEFT JOIN departamentos d ON e.departamento_id = d.id
       WHERE e.username = ? AND e.password = ? AND e.login_enabled = 1`,
      [username, password]
    );
    if (rows.length === 1) {
      // usuario válido: guardamos la información mínima en sesión
      req.session.user = {
        id: rows[0].id,
        nombre: rows[0].nombre,
        puesto_id: rows[0].puesto_id,
        departamento_id: rows[0].departamento_id,
        username: rows[0].username,
        puesto_nombre: rows[0].puesto_nombre,
        departamento_nombre: rows[0].departamento_nombre,
        role: rows[0].puesto_role || 'user'
      };
      // Mensaje de bienvenida con puesto y departamento
      let welcomeMsg = 'Bienvenido ' + rows[0].nombre;
      if (rows[0].puesto_nombre) {
        welcomeMsg += ' - ' + rows[0].puesto_nombre;
      }
      if (rows[0].departamento_nombre) {
        welcomeMsg += ' (' + rows[0].departamento_nombre + ')';
      }
      req.flash('success', welcomeMsg);
      return res.redirect('/dashboard');
    }
    req.flash('error', 'Usuario o contraseña incorrecta');
    return res.redirect('/login');
  } catch (error) {
    console.error('Error al iniciar sesión:', error);
    req.flash('error', 'Error de conexión con la base de datos');
    return res.redirect('/login');
  }
});

/*
 * Ruta GET /logout
 * Destruye la sesión del usuario y redirige al formulario de login.
 */
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

module.exports = router;