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
// extended:true permite parsear objetos anidados (ej: pesos[123]=33.33)
// limit: '1mb' limita el tamaño del body para evitar payloads grandes
app.use(bodyParser.urlencoded({ extended: true, limit: '1mb' }));
app.use(bodyParser.json({ limit: '1mb' }));

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

// Cargar el programador de correos.  Se ejecutará una tarea
// recurrente para enviar automáticamente los resultados de KPIs el día
// 10 de cada mes a las 20:00.  Este módulo debe cargarse después de
// haber inicializado las variables de entorno y antes de iniciar el
// servidor para que el cron se configure correctamente.
const { scheduleMonthlyEmails } = require('./services/emailScheduler');

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
  // Iniciar tarea programada de correos
  try {
    scheduleMonthlyEmails();
    console.log('Programador de correos iniciado');
  } catch (e) {
    console.error('No se pudo iniciar el programador de correos:', e);
  }
});
