const nodemailer = require('nodemailer');

/*
 * Servicio genérico para el envío de correos electrónicos. Utiliza
 * configuraciones definidas en variables de entorno. Los
 * administradores del sistema deben establecer las siguientes
 * variables en un archivo `.env` o en su entorno de ejecución:
 *
 *   SMTP_HOST   - servidor SMTP
 *   SMTP_PORT   - puerto del servidor SMTP (por ejemplo 587 para TLS)
 *   SMTP_SECURE - 'true' si se usa conexión segura (SSL/TLS), en
 *                 cualquier otro valor se asume falso
 *   SMTP_USER   - usuario para autenticación SMTP
 *   SMTP_PASS   - contraseña para autenticación SMTP
 *   EMAIL_FROM  - dirección de remitente que aparecerá en los mensajes
 *
 * El transportador se crea una sola vez y se reutiliza para todos los
 * envíos. Se expone la función `sendEmail` que envía un correo
 * electrónico con asunto, texto/HTML y adjuntos opcionales.
 */

// Crear el transportador SMTP. Si alguna variable de entorno está
// ausente se utiliza un valor por defecto seguro (host vacío).
//
// Nota: Para proveedores como Brevo (Sendinblue) recomendamos mantener
// el envío secuencial con un pequeño delay (ver EMAIL_SEND_DELAY_MS) en
// lugar de abrir demasiadas conexiones. Aun así, dejamos opción de
// habilitar "pool" por variables de entorno si se desea.
const usePool = String(process.env.SMTP_POOL || '').toLowerCase() === 'true';
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || ''
  },
  ...(usePool
    ? {
        pool: true,
        maxConnections: Number(process.env.SMTP_MAX_CONNECTIONS) || 3,
        maxMessages: Number(process.env.SMTP_MAX_MESSAGES) || 100
      }
    : {})
});

/**
 * Envía un correo electrónico utilizando el transportador SMTP.
 * @param {Object} param0
 * @param {string|string[]} param0.to Dirección o lista de direcciones de destinatario.
 * @param {string} param0.subject Asunto del correo.
 * @param {string} [param0.text] Cuerpo en texto plano.
 * @param {string} [param0.html] Cuerpo en HTML.
 * @param {Array} [param0.attachments] Lista de adjuntos ({ filename, content, contentType }).
 * @returns {Promise<Object>} Resultado de nodemailer.
 */
function resolveFromAddress() {
  // Prioridad:
  // 1) EMAIL_FROM (recomendado)
  // 2) BREVO_FROM / SMTP_FROM (por si en Railway usas otro nombre)
  // 3) SMTP_USER (último recurso)
  const from =
    process.env.EMAIL_FROM ||
    process.env.BREVO_FROM ||
    process.env.SMTP_FROM ||
    process.env.SMTP_USER ||
    '';
  return String(from).trim();
}

async function sendEmail({ to, subject, text, html, attachments = [], from }) {
  // Permitir override explícito de "from" por llamada.
  const resolvedFrom = String(from || resolveFromAddress()).trim();
  if (!resolvedFrom) {
    // No rompemos el envío, pero avisamos en log.
    console.warn('[EmailService] EMAIL_FROM vacío. Revisa variables de entorno.');
  }
  const mailOptions = {
    from: resolvedFrom,
    to,
    subject,
    text,
    html,
    attachments
  };
  return transporter.sendMail(mailOptions);
}

module.exports = {
  sendEmail,
  resolveFromAddress
};