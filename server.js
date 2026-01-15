/*
 * Punto de entrada principal de la aplicación.
 * Configura Express, sesiones, carga variables de entorno y registra
 * todas las rutas del sistema.  Esta aplicación se construye para
 * funcionar con Node.js y EJS como motor de plantillas.
 */

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const flash = require('connect-flash');
const bodyParser = require('body-parser');

const app = express();

// Configuración del motor de plantillas
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Directorio de archivos estáticos (CSS, JS, imágenes)
app.use(express.static(path.join(__dirname, 'public')));

// Middleware para parsear solicitudes
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Configuración de la sesión.  Se utiliza un valor secreto definido
// en el archivo .env.  La opción saveUninitialized=false evita
// sesiones vacías; resave=false para no guardar sesiones no
// modificadas en cada petición.
app.use(session({
  secret: process.env.SESSION_SECRET || 'defaultSecret',
  resave: false,
  saveUninitialized: false
}));

// Flash messages para mostrar avisos y errores al usuario
app.use(flash());

// Variables locales disponibles en todas las vistas.  Aquí definimos
// usuario y mensajes flash que se pasarán automáticamente a las
// plantillas sin necesidad de declararlos en cada controlador.
app.use((req, res, next) => {
  res.locals.user = req.session.user;
  res.locals.success_msg = req.flash('success');
  res.locals.error_msg = req.flash('error');
  next();
});

// Importación de rutas
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const employeeRoutes = require('./routes/employees');
const positionRoutes = require('./routes/positions');
const kpiRoutes = require('./routes/kpis');
const organigramaRoutes = require('./routes/organigrama');

// Registro de rutas
app.use('/', authRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/personal', employeeRoutes);
app.use('/puestos', positionRoutes);
app.use('/kpis', kpiRoutes);
app.use('/organigrama', organigramaRoutes);

// Ruta por defecto: redirige a dashboard si autenticado o a login.
app.get('*', (req, res) => {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  return res.redirect('/login');
});

// Arranque del servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});