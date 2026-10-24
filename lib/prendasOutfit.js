// Fusiona la lista de prendas de un outfit con el reanálisis de color.
import { colorMedible } from "./color.js";

// Con el mismo largo se fusiona por índice (conserva lo ya guardado);
// si no, se reemplaza por la lista nueva. color_medible solo si el hex es válido.
export function fusionarPrendasOutfit(actuales, nuevas) {
  if (!Array.isArray(nuevas) || nuevas.length === 0) return null;
  const base = Array.isArray(actuales) ? actuales : [];
  const mismoLargo = base.length === nuevas.length;
  return nuevas.map((n, i) => {
    const previa = mismoLargo ? base[i] || {} : {};
    const item = { ...previa, nombre: n?.nombre ?? previa.nombre, color: n?.color ?? previa.color, tipo: n?.tipo ?? previa.tipo };
    const cm = colorMedible(n?.color_hex);
    if (cm) item.color_medible = cm;
    return item;
  });
}
