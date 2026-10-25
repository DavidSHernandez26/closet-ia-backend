// Opciones validadas para el asistente de moda: del mensaje del usuario a la lista corta de
// combinaciones que ve la IA, y de la respuesta de la IA a lo que recibe el cliente.
import { interpretarPedido } from "./pedidoColor.js";
import { generarCandidatos, candidatosGuardados, aptaParaClima, abrigoSegunClima } from "./generador.js";
import { contarEstilo, normalizarEstilo, estiloSinOutfit, idsDeEntrada, piezasDe, puntuarCandidato } from "./estilo.js";
import { colorDe, detectarRegla, NOMBRE_REGLA, REGLAS } from "./reglas.js";
import { normalizarTipo } from "./outfit.js";
import { describirPieza, resolverEleccion, leerOpcion } from "./fashion.js";
import { safeParseJSON } from "./outfit.js";

export const MAX_OPCIONES = 6; // tamaño de la lista corta que ve la IA (anti-objetivo de costo)
export const REGLAS_RECIENTES = 2; // reglas recientes del calendario que se intentan no repetir
export const MAX_GUARDADOS_EN_LISTA = 2; // outfits guardados como mucho en la lista corta
export const MAX_POR_BASE = 2; // opciones como mucho con la misma base (superior + inferior, o vestido)
const BASE = new Set(["parte superior", "parte inferior", "vestido"]);

const PADRE = { "azul marino": "azul", denim: "azul", beige: "café" };
const tipoDe = (p) => normalizarTipo(p.descripcion || "", p.metadata_ia || {});
const tipoPieza = (p) => String(p?.tipo || "").toLowerCase().trim();

const RESPUESTA_SIN_JSON = "Te armé una combinación con lo que tienes disponible. ¡Pruébala y dime qué piensas!";
const RESPUESTA_POR_DEFECTO = "Aquí tienes un outfit que combina muy bien.";

/* Últimas reglas no nulas del calendario (viene ordenado por fecha descendente). */
export function reglasRecientes(calendario, n = REGLAS_RECIENTES) {
  return (calendario || [])
    .map((e) => e?.metadata?.regla)
    .filter((r) => REGLAS.includes(r))
    .slice(0, n);
}

const idsDelCalendario = (calendario) => (calendario || []).flatMap((e) => idsDeEntrada(e?.metadata));

/* Pieza detectada de un outfit guardado ({nombre, tipo}) con la forma de prenda que espera
   el generador, para aplicarle las mismas reglas de clima. */
const comoPrenda = (p) => ({
  descripcion: `${p?.nombre || ""} - ${p?.tipo || ""}`,
  metadata_ia: { nombre: p?.nombre || "", tipo: p?.tipo || "" },
});

/* Outfit guardado como candidato: respeta clima y exclusiones por id, tipo de pieza y familia. */
function guardadoPermitido(c, { excluirIds, excluirTipos, excluirFamilias }, clima) {
  if (c.ids.some((x) => excluirIds.has(x))) return false;
  const piezas = piezasDe(c.prendas);
  const comoPrendas = piezas.map(comoPrenda);
  if (!comoPrendas.every((p) => aptaParaClima(p, clima))) return false;
  if (abrigoSegunClima(clima) === "obligatorio" && !comoPrendas.some((p) => tipoDe(p) === "abrigo")) return false;
  return piezas.every((p) => {
    if (excluirTipos.includes(tipoPieza(p))) return false;
    const f = colorDe(p)?.familia;
    return !f || !(excluirFamilias.includes(f) || excluirFamilias.includes(PADRE[f]));
  });
}

/* Modo edición ("cambia solo X"): el outfit actual sin ese tipo queda fijo. La pieza actual de
   ese tipo se excluye solo si el closet tiene otra; si no, el outfit quedaría incompleto. */
function planEdicion(pedido, prendasSueltas, outfitIdsAnteriores) {
  if (!pedido.editarTipo || !outfitIdsAnteriores.length) return null;
  const anteriores = new Set(outfitIdsAnteriores.map(String));
  const actuales = prendasSueltas.filter((p) => anteriores.has(String(p.id)));
  if (!actuales.length) return null;
  const cambiar = actuales.filter((p) => tipoDe(p) === pedido.editarTipo);
  const idsCambiar = new Set(cambiar.map((p) => String(p.id)));
  const hayOtra = prendasSueltas.some((p) => tipoDe(p) === pedido.editarTipo && !idsCambiar.has(String(p.id)));
  return {
    fijas: actuales.filter((p) => tipoDe(p) !== pedido.editarTipo),
    excluirIds: hayOtra ? [...idsCambiar] : [],
    reglaActual: detectarRegla(actuales),
  };
}

/* Primero los candidatos que cumplen `preferir`; dentro de cada grupo, por puntaje. */
const ordenar = (cs, preferir) =>
  [...cs].sort((a, b) => (preferir(b) - preferir(a)) || (b.puntaje - a.puntaje));

const esGuardado = (c) => c.prendas.length === 1 && c.prendas[0]?.tipo === "outfit";

/* Lista corta en orden, con tope de outfits guardados y de opciones por base. La base no
   cuenta las prendas fijas (en "cambia solo los zapatos" la base es la misma a propósito). */
function listaCorta(ordenados, idsFijos) {
  const out = [];
  const porBase = new Map();
  let guardados = 0;
  for (const c of ordenados) {
    if (out.length >= MAX_OPCIONES) break;
    if (esGuardado(c)) {
      if (guardados >= MAX_GUARDADOS_EN_LISTA) continue;
      guardados++;
      out.push(c);
      continue;
    }
    const base = c.prendas.filter((p) => BASE.has(tipoDe(p)) && !idsFijos.has(String(p.id))).map((p) => String(p.id)).join("|");
    if (base) {
      const n = porBase.get(base) || 0;
      if (n >= MAX_POR_BASE) continue;
      porBase.set(base, n + 1);
    }
    out.push(c);
  }
  return out;
}

export function prepararOpciones({ datos = {}, prendasSueltas = [], outfitsGuardados = [], peticion }) {
  const pedido = interpretarPedido(peticion.mensaje);
  const outfitIdsAnteriores = (peticion.outfitIdsAnteriores || []).map(String);
  const edicion = planEdicion(pedido, prendasSueltas, outfitIdsAnteriores);
  const cuentas = contarEstilo({ calendario: datos.calendarioEstilo, prendasSueltas, outfitsGuardados });
  const estilo = normalizarEstilo(cuentas);
  const idsRecientes = idsDelCalendario(datos.calendarioReciente);
  const excluirIds = edicion ? edicion.excluirIds : outfitIdsAnteriores;
  const filtros = {
    excluirIds: new Set(excluirIds),
    excluirTipos: pedido.excluirTipos || [],
    excluirFamilias: pedido.excluirFamilias || [],
  };

  const generar = (regla, familias) => {
    const sueltos = generarCandidatos({
      prendas: prendasSueltas, regla, familias, clima: peticion.clima,
      excluirIds, excluirTipos: filtros.excluirTipos, excluirFamilias: filtros.excluirFamilias,
      // Se piden más de las que se muestran: listaCorta descarta las que repiten base.
      fijas: edicion?.fijas || [], max: MAX_OPCIONES * MAX_POR_BASE, estilo, idsRecientes,
      exclusionBlanda: !edicion,
    });
    // En edición el resto del outfit queda fijo: un outfit guardado lo reemplazaría entero.
    const guardados = edicion ? [] : candidatosGuardados(outfitsGuardados, regla, familias)
      .filter((c) => guardadoPermitido(c, filtros, peticion.clima))
      // Sin su propio aporte al estilo: un guardado no se sube el puntaje a sí mismo.
      .map((c) => ({ ...c, puntaje: puntuarCandidato(c, estiloSinOutfit(cuentas, c.prendas[0]), idsRecientes) }));
    return [...sueltos, ...guardados];
  };

  let candidatos = generar(pedido.regla, pedido.familias);
  let avisoRegla = null;
  let avisoUsuario = null;
  if (pedido.regla && !candidatos.length) {
    const lo = `${NOMBRE_REGLA[pedido.regla]}${pedido.familias.length ? ` en ${pedido.familias.join(" y ")}` : ""}`;
    avisoRegla = `No hay suficientes prendas para ${lo} — dilo y elige la mejor alternativa`;
    avisoUsuario = `No tienes suficientes prendas para un look ${lo}.`;
    candidatos = generar(null, []);
  }

  // Variedad: sin regla pedida, primero las reglas que no se usaron hace poco. En edición,
  // primero las que mantienen la regla del outfit actual.
  let preferir = () => 0;
  if (!pedido.regla && edicion?.reglaActual) preferir = (c) => (c.regla === edicion.reglaActual ? 1 : 0);
  else if (!pedido.regla) {
    const recientes = reglasRecientes(datos.calendarioReciente);
    preferir = (c) => (recientes.includes(c.regla) ? 0 : 1);
    // La selección variada del generador es aleatoria y puede dejar fuera las demás reglas:
    // si todo repite una regla reciente, se buscan explícitamente las otras.
    if (recientes.length && candidatos.length && candidatos.every((c) => recientes.includes(c.regla))) {
      const vistos = new Set(candidatos.map((c) => c.ids.join()));
      for (const r of REGLAS.filter((x) => !recientes.includes(x))) {
        for (const c of generar(r, []).slice(0, 2)) {
          if (!vistos.has(c.ids.join())) { vistos.add(c.ids.join()); candidatos.push(c); }
        }
      }
    }
  }
  const idsFijos = new Set((edicion?.fijas || []).map((p) => String(p.id)));
  candidatos = listaCorta(ordenar(candidatos, preferir), idsFijos);

  return { candidatos, avisoRegla, avisoUsuario };
}

/* Texto propio del backend cuando la IA no eligió una opción válida. */
export function textoPropuesta(candidato, avisoUsuario = null) {
  const nombre = NOMBRE_REGLA[candidato.regla] ?? candidato.regla;
  const texto = `Te propongo este look (${nombre}): ${candidato.prendas.map(describirPieza).join(", ")}`;
  return avisoUsuario ? `${avisoUsuario} ${texto}` : texto;
}

// 0 = "ninguna opción sirve" (la IA arma el outfit con outfit_ids, como en el flujo tradicional).
const opcionValida = (n, candidatos) => Number.isInteger(n) && n >= 0 && n <= candidatos.length;

/* Streaming: ¿se puede transmitir el texto de la IA? Sí sin opciones, con una opción válida
   o si ya se sabe que es una pregunta pura (cambiar_panel false). */
export function puedeTransmitir(acumulado, candidatos) {
  if (!candidatos?.length) return true;
  if (opcionValida(leerOpcion(acumulado), candidatos)) return true;
  return /"cambiar_panel"\s*:\s*false/.test(String(acumulado ?? ""));
}

/* Streaming: JSON final de la IA. Si llegó roto pero el texto ya se transmitió, se respeta lo
   que se narró: una pregunta pura (cambiar_panel false) o la opción leída. */
export function parsearStream(acumulado, transmitido) {
  const parsed = safeParseJSON(acumulado);
  if (parsed || !transmitido) return parsed;
  if (/"cambiar_panel"\s*:\s*false/.test(String(acumulado ?? ""))) return { cambiar_panel: false };
  const n = leerOpcion(acumulado);
  return n !== null ? { opcion: n } : null;
}

/* Respuesta final común a los dos endpoints. `propio` = el texto lo armó el backend. */
export function cerrarRespuesta(parsed, opciones, prendasSueltas, outfitsGuardados) {
  const candidatos = opciones?.candidatos || [];
  const { valida, ...resultado } = resolverEleccion(parsed, candidatos, prendasSueltas, outfitsGuardados);
  const pregunta = parsed?.cambiar_panel === false;
  // Una pregunta pura no cambia el panel: no se nombra la regla de un outfit que no se muestra.
  if (pregunta) resultado.regla = null;
  if (candidatos.length && !valida && !pregunta) {
    return { resultado, respuesta: textoPropuesta(candidatos[0], opciones.avisoUsuario), propio: true };
  }
  const respuesta = !parsed ? RESPUESTA_SIN_JSON : parsed.respuesta || RESPUESTA_POR_DEFECTO;
  return { resultado, respuesta, propio: false };
}

/* Metadata del calendario: la regla la calcula el backend con las prendas del usuario. */
export function metadataCalendario(metadata, prendas) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const { regla: _cliente, ...resto } = metadata;
  // outfit_ids; si no vienen, los ids de metadata.outfit (outfit editado) o outfit_guardado_id.
  if (!idsDeEntrada(resto).length) return resto;
  const regla = detectarRegla(piezasDe(prendas));
  return regla ? { ...resto, regla } : resto;
}
