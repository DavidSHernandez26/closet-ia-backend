import test from "node:test";
import assert from "node:assert/strict";
import { colorMedible } from "../lib/color.js";
import { cumpleRegla } from "../lib/reglas.js";
import { normalizarTipo } from "../lib/outfit.js";
import {
  reglasRecientes, prepararOpciones, textoPropuesta, puedeTransmitir, cerrarRespuesta, metadataCalendario, MAX_OPCIONES,
} from "../lib/opciones.js";

let n = 0;
const prenda = (nombre, tipo, hex) => ({
  id: ++n,
  tipo: "prenda",
  descripcion: `${nombre} - ${tipo}`,
  metadata_ia: { nombre, tipo, color: nombre.split(" ").pop(), color_medible: hex ? colorMedible(hex) : undefined },
});

const supAzul = prenda("camisa azul", "parte superior", "#1E50C8");
const supBlanco = prenda("camiseta blanca", "parte superior", "#FFFFFF");
const supRojo = prenda("camiseta roja", "parte superior", "#E02020");
const jean = prenda("jean azul", "parte inferior", "#5B7FA6");
const pantNegro = prenda("pantalón negro", "parte inferior", "#111111");
const zapNegro = prenda("zapatos negros", "calzado", "#000000");
const zapBlanco = prenda("tenis blancos", "calzado", "#F5F5F5");
const accNegro = prenda("reloj negro", "accesorio", "#000000");
const closet = [supAzul, supBlanco, supRojo, jean, pantNegro, zapNegro, zapBlanco, accNegro];

const pz = (tipo, hex) => ({ nombre: "x", color: "x", tipo, color_medible: colorMedible(hex) });
const guardado = {
  id: 500, tipo: "outfit", descripcion: "Outfit azul",
  metadata_ia: { prendas: [pz("parte superior", "#1E50C8"), pz("parte inferior", "#0A2F80"), pz("abrigo", "#3060D0")] },
};

const id = (p) => String(p.id);
const tipoDe = (p) => normalizarTipo(p.descripcion, p.metadata_ia);
const datos = (extra = {}) => ({ calendarioEstilo: [], calendarioReciente: [], ...extra });
const peticion = (mensaje, extra = {}) => ({ mensaje, historial: [], outfitIdsAnteriores: [], clima: null, ...extra });
const preparar = (mensaje, { pet = {}, dat = {}, sueltas = closet, guardados = [guardado] } = {}) =>
  prepararOpciones({ datos: datos(dat), prendasSueltas: sueltas, outfitsGuardados: guardados, peticion: peticion(mensaje, pet) });

test("reglasRecientes: las 2 últimas reglas no nulas del calendario (orden desc)", () => {
  const cal = [
    { fecha: "2026-10-23", metadata: { regla: "analogos" } },
    { fecha: "2026-10-22", metadata: {} },
    { fecha: "2026-10-21", metadata: { regla: "nada_valido" } },
    { fecha: "2026-10-20", metadata: { regla: "monocromatico" } },
    { fecha: "2026-10-19", metadata: { regla: "triada" } },
  ];
  assert.deepEqual(reglasRecientes(cal), ["analogos", "monocromatico"]);
  assert.deepEqual(reglasRecientes(null), []);
});

test("monocromático en azul: todas las opciones cumplen, sin aviso, tope de opciones", () => {
  const { candidatos, avisoRegla } = preparar("algo monocromático en azul");
  assert.ok(candidatos.length > 0 && candidatos.length <= MAX_OPCIONES);
  assert.equal(avisoRegla, null);
  for (const c of candidatos) {
    assert.equal(c.regla, "monocromatico");
    const piezas = c.prendas.flatMap((p) => (p.tipo === "outfit" ? p.metadata_ia.prendas : [p]));
    assert.ok(cumpleRegla(piezas, "monocromatico", ["azul"]));
  }
  for (let i = 1; i < candidatos.length; i++) assert.ok(candidatos[i - 1].puntaje >= candidatos[i].puntaje);
});

test("regla imposible: reintenta sin regla y arma el aviso", () => {
  const r = preparar("monocromático en verde");
  assert.ok(r.candidatos.length > 0);
  assert.equal(r.avisoRegla, "No hay suficientes prendas para Monocromático en verde — dilo y elige la mejor alternativa");
  assert.equal(r.avisoUsuario, "No tienes suficientes prendas para un look Monocromático en verde.");
});

test("regla pedida y closet sin analizar: [] con aviso (flujo tradicional)", () => {
  const sin = [prenda("a", "parte superior", null), prenda("b", "parte inferior", null), prenda("c", "calzado", null)];
  const r = preparar("solo dos colores", { sueltas: sin, guardados: [] });
  assert.deepEqual(r.candidatos, []);
  assert.match(r.avisoRegla, /^No hay suficientes prendas para Dos colores/);
  const libre = preparar("outfit para hoy", { sueltas: sin, guardados: [] });
  assert.deepEqual(libre.candidatos, []);
  assert.equal(libre.avisoRegla, null);
});

test("excluye las prendas ya mostradas y los outfits guardados ya mostrados", () => {
  const { candidatos } = preparar("otro outfit", { pet: { outfitIdsAnteriores: [id(supAzul), "500"] } });
  assert.ok(candidatos.length > 0);
  for (const c of candidatos) assert.ok(!c.ids.includes(id(supAzul)) && !c.ids.includes("500"));
});

test("outfit guardado: se descarta si tiene un tipo excluido", () => {
  const { candidatos } = preparar("outfit sin chaqueta");
  assert.ok(candidatos.every((c) => !c.ids.includes("500")));
});

test("cambia solo los zapatos: el resto queda fijo y cambia el calzado", () => {
  const actuales = [supBlanco, pantNegro, zapNegro, accNegro].map(id);
  const { candidatos } = preparar("cambia solo los zapatos", { pet: { outfitIdsAnteriores: actuales } });
  assert.ok(candidatos.length > 0);
  for (const c of candidatos) {
    assert.ok(c.ids.includes(id(supBlanco)) && c.ids.includes(id(pantNegro)) && c.ids.includes(id(accNegro)));
    assert.ok(!c.ids.includes(id(zapNegro)));
    assert.ok(c.ids.includes(id(zapBlanco)));
    assert.ok(!c.ids.includes("500"));
  }
});

test("cambia solo los zapatos sin otro calzado: conserva el actual", () => {
  const sueltas = closet.filter((p) => p !== zapBlanco);
  const actuales = [supBlanco, pantNegro, zapNegro].map(id);
  const { candidatos } = preparar("cambia solo los zapatos", { sueltas, pet: { outfitIdsAnteriores: actuales } });
  assert.ok(candidatos.length > 0);
  for (const c of candidatos) assert.ok(c.prendas.some((p) => tipoDe(p) === "calzado"));
});

test("variedad: sin regla pedida, las reglas recientes van al final", () => {
  // closet con varias reglas posibles: monocromático azul, dos colores, neutros + acento
  const sueltas = [...closet, prenda("pantalón celeste", "parte inferior", "#6A9AF0"), prenda("pantalón blanco", "parte inferior", "#FAFAFA")];
  const base = preparar("outfit para hoy", { sueltas, guardados: [] }).candidatos;
  const reglas = [...new Set(base.map((c) => c.regla))];
  assert.ok(reglas.length >= 2, `solo ${reglas}`);
  const recientes = reglas.slice(0, Math.min(2, reglas.length - 1));
  const cal = recientes.map((r, i) => ({ fecha: `2026-10-2${i}`, metadata: { regla: r } }));
  for (let k = 0; k < 5; k++) {
    const { candidatos } = preparar("outfit para hoy", { sueltas, guardados: [], dat: { calendarioReciente: cal } });
    assert.ok(!recientes.includes(candidatos[0].regla));
    const primeraReciente = candidatos.findIndex((c) => recientes.includes(c.regla));
    if (primeraReciente >= 0) assert.ok(candidatos.slice(primeraReciente).every((c) => recientes.includes(c.regla)));
  }
});

test("variedad: con regla pedida no se reordena por reglas recientes", () => {
  const cal = [{ fecha: "2026-10-23", metadata: { regla: "monocromatico" } }];
  const { candidatos } = preparar("monocromático en azul", { dat: { calendarioReciente: cal } });
  assert.ok(candidatos.length > 0 && candidatos.every((c) => c.regla === "monocromatico"));
});

test("textoPropuesta: regla y descripciones, con aviso opcional", () => {
  const c = { ids: [id(supBlanco), id(pantNegro)], prendas: [supBlanco, pantNegro], regla: "dos_colores" };
  assert.equal(textoPropuesta(c), "Te propongo este look (Dos colores): camiseta blanca, pantalón negro");
  assert.equal(textoPropuesta(c, "No tienes suficientes prendas para un look Tríada."),
    "No tienes suficientes prendas para un look Tríada. Te propongo este look (Dos colores): camiseta blanca, pantalón negro");
  assert.equal(textoPropuesta({ ids: ["500"], prendas: [guardado], regla: "monocromatico" }), "Te propongo este look (Monocromático): Outfit azul");
});

test("puedeTransmitir", () => {
  const cs = [{}, {}];
  assert.equal(puedeTransmitir('{"respuesta":"ho', []), true);
  assert.equal(puedeTransmitir('{"opcion":2,"respuesta":"ho', cs), true);
  assert.equal(puedeTransmitir('{"opcion":3,"respuesta":"ho', cs), false);
  assert.equal(puedeTransmitir('{"respuesta":"ho', cs), false);
  assert.equal(puedeTransmitir('{"cambiar_panel":false,"respuesta":"ho', cs), true);
});

test("cerrarRespuesta: pregunta pura usa el texto de la IA y no es error", () => {
  const cs = [{ ids: [id(supBlanco)], prendas: [supBlanco], regla: "neutros_acento" }];
  const r = cerrarRespuesta({ respuesta: "Un look análogo usa colores vecinos.", cambiar_panel: false }, { candidatos: cs }, closet, []);
  assert.equal(r.propio, false);
  assert.equal(r.respuesta, "Un look análogo usa colores vecinos.");
  assert.equal(r.resultado.cambiar_panel, false);
  assert.equal(r.resultado.regla, null);
  assert.ok(!("valida" in r.resultado));
});

test("cerrarRespuesta: opción inválida → texto propio con la mejor opción", () => {
  const cs = [{ ids: [id(supBlanco), id(pantNegro)], prendas: [supBlanco, pantNegro], regla: "dos_colores" }];
  const r = cerrarRespuesta({ opcion: 9, respuesta: "otro look", cambiar_panel: true }, { candidatos: cs, avisoUsuario: null }, closet, []);
  assert.equal(r.propio, true);
  assert.equal(r.respuesta, "Te propongo este look (Dos colores): camiseta blanca, pantalón negro");
  assert.deepEqual(r.resultado.outfit.map(id), [id(supBlanco), id(pantNegro)]);
  assert.equal(r.resultado.regla, "Dos colores");
  const nulo = cerrarRespuesta(null, { candidatos: cs }, closet, []);
  assert.equal(nulo.propio, true);
  assert.equal(nulo.resultado.cambiar_panel, true);
});

test("cerrarRespuesta: opción válida usa la respuesta de la IA y nombra la regla", () => {
  const cs = [
    { ids: [id(supBlanco)], prendas: [supBlanco], regla: "dos_colores" },
    { ids: [id(supAzul), id(jean)], prendas: [supAzul, jean], regla: "monocromatico" },
  ];
  const r = cerrarRespuesta({ opcion: 2, respuesta: "Look Monocromático", cambiar_panel: true }, { candidatos: cs }, closet, []);
  assert.equal(r.propio, false);
  assert.equal(r.respuesta, "Look Monocromático");
  assert.equal(r.resultado.regla, "Monocromático");
  assert.deepEqual(r.resultado.outfit.map(id), [id(supAzul), id(jean)]);
});

test("cerrarRespuesta: sin opciones = flujo tradicional y regla null", () => {
  const nulo = cerrarRespuesta(null, { candidatos: [] }, closet, []);
  assert.equal(nulo.respuesta, "Te armé una combinación con lo que tienes disponible. ¡Pruébala y dime qué piensas!");
  assert.equal(nulo.resultado.regla, null);
  const vacio = cerrarRespuesta({ outfit_ids: [id(supBlanco)] }, { candidatos: [] }, closet, []);
  assert.equal(vacio.respuesta, "Aquí tienes un outfit que combina muy bien.");
  assert.deepEqual(vacio.resultado.outfit.map(id), [id(supBlanco)]);
});

test("metadataCalendario: recalcula la regla e ignora la del cliente", () => {
  const pantCeleste = prenda("pantalón celeste", "parte inferior", "#6A9AF0");
  const m = metadataCalendario({ outfit_ids: [1, 2], regla: "triada", otro: 1 }, [supAzul, pantCeleste, zapNegro]);
  assert.equal(m.regla, "monocromatico");
  assert.equal(m.otro, 1);
  const sinIds = metadataCalendario({ regla: "triada" }, []);
  assert.ok(!("regla" in sinIds));
  const sinRegla = metadataCalendario({ outfit_ids: [1], regla: "triada" }, []);
  assert.ok(!("regla" in sinRegla));
  assert.deepEqual(metadataCalendario(null, []), {});
  const conGuardado = metadataCalendario({ outfit_ids: ["500"] }, [guardado]);
  assert.equal(conGuardado.regla, "monocromatico");
});
