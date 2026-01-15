/*
 * Módulo de conexión a la base de datos.
 * Define dos pools de conexiones: uno para la base de datos local
 * de KPIs y otro para la base de datos remota de incidencias.
 * Utiliza mysql2/promise para trabajar de forma asincrónica.
 */

const mysql = require('mysql2/promise');
require('dotenv').config();

// Pool para la base de datos principal del sistema de KPIs
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Pool para la base de datos de incidencias.  Se utiliza únicamente
// cuando el usuario solicita la importación de personal.  En caso de
// error de conexión (por ejemplo si el host no es accesible) se
// manejará la excepción en el controlador correspondiente.
const incidenciasPool = mysql.createPool({
  host: process.env.INCIDENCIAS_DB_HOST,
  port: process.env.INCIDENCIAS_DB_PORT,
  user: process.env.INCIDENCIAS_DB_USER,
  password: process.env.INCIDENCIAS_DB_PASSWORD,
  database: process.env.INCIDENCIAS_DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

module.exports = { pool, incidenciasPool };