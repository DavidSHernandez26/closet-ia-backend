// Helpers de fecha en hora local de la app (sin dependencias de red ni de Express).

// Fecha "YYYY-MM-DD" del instante dado, según la zona horaria de la app.
export function fechaHoy(ahora = new Date(), tz = process.env.APP_TZ || "America/Bogota") {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(ahora);
}

// Resta n días a una fecha "YYYY-MM-DD" con aritmética en UTC (sin hora local).
export function restarDias(fecha, n) {
  const [y, m, d] = fecha.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - n));
  return dt.toISOString().slice(0, 10);
}

// Racha de días consecutivos terminando en hoy (o en ayer, que aún la mantiene viva).
export function calcularRacha(fechas, hoy) {
  const unicas = [...new Set(
    (fechas || []).map(f => String(f || "").slice(0, 10)).filter(Boolean)
  )].sort().reverse();

  if (!unicas.length) return { racha: 0, ultimaFecha: null, registroHoy: false };

  const ultimaFecha = unicas[0];
  const registroHoy = ultimaFecha === hoy;

  // Si el último registro es anterior a ayer, la racha se rompió
  if (ultimaFecha < restarDias(hoy, 1)) return { racha: 0, ultimaFecha, registroHoy };

  let racha = 0;
  let esperada = ultimaFecha;
  for (const f of unicas) {
    if (f === esperada) {
      racha++;
      esperada = restarDias(esperada, 1);
    } else if (f < esperada) {
      break;
    }
  }

  return { racha, ultimaFecha, registroHoy };
}
