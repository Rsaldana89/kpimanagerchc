/**
 * Pequeña utilidad para pausar la ejecución de forma asíncrona.
 * Útil para aplicar un "delay" entre envíos de correos y evitar
 * saturar el proveedor SMTP (Brevo).
 */
function sleep(ms) {
  const n = Number(ms);
  return new Promise(resolve => setTimeout(resolve, Number.isFinite(n) ? n : 0));
}

module.exports = { sleep };
