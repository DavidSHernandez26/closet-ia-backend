// Elige la tanda a procesar: primero los que faltan color, luego solo enriquecimiento.
export const LOTE_REANALISIS = 40;

export function elegirTanda(items, faltaColor, max = LOTE_REANALISIS) {
  const conColor = items.filter((p) => faltaColor(p));
  const resto = items.filter((p) => !faltaColor(p));
  return [...conColor, ...resto].slice(0, max);
}
