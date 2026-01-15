// Lógica única y estandarizada de calificación de KPIs.
//
// Modelo nuevo (sin usar rangos legacy):
// - score_type: PERCENT | NUMBER | CRITERION
// - direction: HIGHER_BETTER | LOWER_BETTER
// - thresholds: threshold_yellow, threshold_green
// - criteria: criterion_red, criterion_yellow, criterion_green

function toNumberOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace('%', '').trim().replace(',', '.');
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Calcula el semáforo del KPI en base al modelo nuevo.
 *
 * @param {object} kpi - fila de la tabla kpis
 * @param {string|number|null} rawValue - valor capturado
 * @returns {{color: ('rojo'|'amarillo'|'verde'|null), score: (40|70|100|null), reason: string|null}}
 */
function scoreKpi(kpi, rawValue) {
  if (!kpi) return { color: null, score: null, reason: 'KPI inválido' };

  const scoreType = (kpi.score_type || '').toUpperCase();
  const direction = (kpi.direction || 'HIGHER_BETTER').toUpperCase();

  // CRITERION: match exacto contra los 3 criterios. (En UI se sugiere usar select)
  if (scoreType === 'CRITERION') {
    const v = rawValue === null || rawValue === undefined ? '' : String(rawValue).trim();
    const r = (kpi.criterion_red || '').trim();
    const y = (kpi.criterion_yellow || '').trim();
    const g = (kpi.criterion_green || '').trim();

    // Si no hay criterios definidos, no calificamos (pero tampoco rompemos)
    if (!r && !y && !g) {
      return { color: null, score: null, reason: 'Sin criterios definidos' };
    }

    if (g && v === g) return { color: 'verde', score: 100, reason: null };
    if (y && v === y) return { color: 'amarillo', score: 70, reason: null };
    if (r && v === r) return { color: 'rojo', score: 40, reason: null };

    // Valor no coincide con ninguno (evita asignar color incorrecto)
    return { color: null, score: null, reason: 'Valor no coincide con criterio' };
  }

  // NUMBER / PERCENT: thresholds
  const n = toNumberOrNull(rawValue);
  if (n === null) return { color: null, score: null, reason: 'Valor no numérico' };

  const ty = toNumberOrNull(kpi.threshold_yellow);
  const tg = toNumberOrNull(kpi.threshold_green);
  if (ty === null || tg === null) {
    return { color: null, score: null, reason: 'Sin umbrales definidos' };
  }

  // HIGHER_BETTER (↑)
  if (direction === 'HIGHER_BETTER') {
    if (n >= tg) return { color: 'verde', score: 100, reason: null };
    if (n >= ty) return { color: 'amarillo', score: 70, reason: null };
    return { color: 'rojo', score: 40, reason: null };
  }

  // LOWER_BETTER (↓)
  if (n <= tg) return { color: 'verde', score: 100, reason: null };
  if (n <= ty) return { color: 'amarillo', score: 70, reason: null };
  return { color: 'rojo', score: 40, reason: null };
}

module.exports = {
  scoreKpi,
  toNumberOrNull,
};
