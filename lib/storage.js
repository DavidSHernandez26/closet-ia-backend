// Extrae la ruta del objeto dentro del bucket a partir de su URL pública de Supabase.
export function rutaDesdeUrlPublica(url, bucket = "prendas") {
  if (typeof url !== "string") return null;
  const marcador = `/storage/v1/object/public/${bucket}/`;
  const i = url.indexOf(marcador);
  if (i === -1) return null;
  const cruda = url.slice(i + marcador.length).split(/[?#]/)[0];
  if (!cruda) return null;
  try {
    return decodeURIComponent(cruda);
  } catch {
    return null;
  }
}
