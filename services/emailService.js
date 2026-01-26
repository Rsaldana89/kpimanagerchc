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
// ausente se utiliza un valor por defecto seguro (host vacío)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || ''
  }
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
async function sendEmail({ to, subject, text, html, attachments = [] }) {
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER || '';
  const mailOptions = {
    from,
    to,
    subject,
    text,
    html,
    attachments
  };
  return transporter.sendMail(mailOptions);
}

module.exports = {
  sendEmail
};