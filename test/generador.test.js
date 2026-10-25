import test from "node:test";
import assert from "node:assert/strict";
import { colorMedible } from "../lib/color.js";
import { cumpleRegla, detectarRegla } from "../lib/reglas.js";
import { normalizarTipo } from "../lib/outfit.js";
import { aptaParaClima, generarCandidatos, candidatosGuardados, MAX_COMBINACIONES } from "../lib/generador.js";

let n = 0;
const prenda = (nombre, tipo, hex, extra = {}) => ({
  id: ++n,
  tipo: "prenda",
  descripcion: `${nombre} (x) - ${tipo}`,
  metadata_ia: { nombre, tipo, color_medible: hex ? colorMedible(hex) : undefined, ...extra },
});

const supAzul = prenda("camisa azul", "parte superior", "#1E50C8");
const supBlanco = prenda("camiseta blanca", "parte superior", "#FFFFFF");
const supRojo = prenda("camiseta roja", "parte superior", "#E02020");
const jean = prenda("jean", "parte inferior", "#5B7FA6");
const pantNegro = prenda("pantalón negro", "parte inferior", "#111111");
const zapNegro = prenda("zapatos negros", "calzado", "#000000");
const zapBlanco = prenda("tenis blancos", "calzado", "#F5F5F5");
const abrigoGris = prenda("chaqueta gris", "abrigo", "#808080");
const accNegro = prenda("reloj negro", "accesorio", "#000000");
const accRojo = prenda("gorra roja", "accesorio", "#E02020");
const short = prenda("short azul", "parte inferior", "#2A5FD0", { temporada: "verano" });

const closet = [supAzul, supBlanco, supRojo, jean, pantNegro, zapNegro, zapBlanco, abrigoGris, accNegro, accRojo, short];
const id = (p) => String(p.id);
const tipoDe = (p) => normalizarTipo(p.descripcion, p.metadata_ia);

test("aptaParaClima", () => {
  assert.equal(aptaParaClima(short, null), true);
  assert.equal(aptaParaClima(short, { temp: 8, feels: 6 }), false);
  assert.equal(aptaParaClima(abrigoGris, { temp: 30, feels: 31 }), false);
  assert.equal(aptaParaClima(abrigoGris, { temp: 8 }), true);
  assert.equal(aptaParaClima(prenda("sandalias", "calzado", "#000000"), { temp: 10 }), false);
  assert.equal(aptaParaClima(prenda("abrigo lana", "abrigo", "#808080", { temporada: "invierno" }), { temp: 20 }), true);
  assert.equal(aptaParaClima(prenda("suéter", "parte superior", "#808080", { temporada: "invierno" }), { temp: 27 }), false);
  // sensación manda sobre temp
  assert.equal(aptaParaClima(short, { temp: 14, feels: 10 }), false);
});

test("monocromático en azul: todo candidato cumple la regla", () => {
  const cs = generarCandidatos({ prendas: closet, regla: "monocromatico", familias: ["azul"] });
  assert.ok(cs.length > 0);
  for (const c of cs) {
    assert.equal(cumpleRegla(c.prendas, "monocromatico", ["azul"]), true);
    assert.equal(c.regla, "monocromatico");
    assert.ok(c.ids.every((x) => typeof x === "string"));
    // hay un accesorio compatible (negro): de 1 a 2 accesorios
    const acc = c.prendas.filter((p) => tipoDe(p) === "accesorio").length;
    assert.ok(acc >= 1 && acc <= 2);
    assert.ok(!c.ids.includes(id(accRojo)));
  }
});

test("frío: sin short y siempre con abrigo", () => {
  const cs = generarCandidatos({ prendas: closet, regla: null, clima: { temp: 8, feels: 6 } });
  assert.ok(cs.length > 0);
  for (const c of cs) {
    assert.ok(!c.ids.includes(id(short)));
    assert.ok(c.ids.includes(id(abrigoGris)));
  }
});

test("calor: nunca abrigo", () => {
  const cs = generarCandidatos({ prendas: closet, regla: null, clima: { temp: 30, feels: 31 } });
  assert.ok(cs.length > 0);
  for (const c of cs) assert.ok(!c.ids.includes(id(abrigoGris)));
});

test("excluirTipos abrigo", () => {
  const cs = generarCandidatos({ prendas: closet, regla: null, excluirTipos: ["abrigo"] });
  assert.ok(cs.length > 0);
  for (const c of cs) assert.ok(c.prendas.every((p) => tipoDe(p) !== "abrigo"));
});

test("excluirIds", () => {
  const cs = generarCandidatos({ prendas: closet, regla: null, excluirIds: [supAzul.id] });
  assert.ok(cs.length > 0);
  for (const c of cs) assert.ok(!c.ids.includes(id(supAzul)));
});

test("excluirFamilias rojo: sin la camiseta ni la gorra roja", () => {
  const cs = generarCandidatos({ prendas: closet, regla: null, excluirFamilias: ["rojo"] });
  assert.ok(cs.length > 0);
  for (const c of cs) {
    assert.ok(!c.ids.includes(id(supRojo)));
    assert.ok(!c.ids.includes(id(accRojo)));
  }
});

test("excluirFamilias azul también quita denim", () => {
  const cs = generarCandidatos({ prendas: closet, regla: null, excluirFamilias: ["azul"] });
  for (const c of cs) assert.ok(!c.ids.includes(id(jean)) && !c.ids.includes(id(supAzul)));
});

test("fijas: todos incluyen el pantalón negro", () => {
  const cs = generarCandidatos({ prendas: closet, regla: null, fijas: [pantNegro] });
  assert.ok(cs.length > 0);
  for (const c of cs) assert.ok(c.ids.includes(id(pantNegro)));
});

test("regla null: etiqueta con detectarRegla e ignora familias", () => {
  const cs = generarCandidatos({ prendas: closet, regla: null, familias: ["verde"] });
  assert.ok(cs.length > 0);
  for (const c of cs) assert.equal(c.regla, detectarRegla(c.prendas));
});

test("variedad: cada par difiere en ≥ 2 IDs y respeta max", () => {
  const cs = generarCandidatos({ prendas: closet, regla: null, max: 6 });
  assert.ok(cs.length > 1 && cs.length <= 6);
  for (let i = 0; i < cs.length; i++) {
    for (let j = i + 1; j < cs.length; j++) {
      const a = new Set(cs[i].ids);
      const b = new Set(cs[j].ids);
      const dif = Math.max([...a].filter((x) => !b.has(x)).length, [...b].filter((x) => !a.has(x)).length);
      assert.ok(dif >= 2, `candidatos ${i} y ${j} difieren en ${dif}`);
    }
  }
  for (let i = 1; i < cs.length; i++) assert.ok(cs[i - 1].puntaje >= cs[i].puntaje);
});

test("closet sin color_medible devuelve []", () => {
  const sin = [prenda("a", "parte superior", null), prenda("b", "parte inferior", null), prenda("c", "calzado", null)];
  assert.deepEqual(generarCandidatos({ prendas: sin, regla: null }), []);
  assert.deepEqual(generarCandidatos({ prendas: sin, regla: "dos_colores" }), []);
});

test("closet sin calzado devuelve candidatos sin calzado", () => {
  const sinCalzado = closet.filter((p) => tipoDe(p) !== "calzado");
  const cs = generarCandidatos({ prendas: sinCalzado, regla: null });
  assert.ok(cs.length > 0);
  for (const c of cs) assert.ok(c.prendas.every((p) => tipoDe(p) !== "calzado"));
});

test("regla imposible devuelve []", () => {
  assert.deepEqual(generarCandidatos({ prendas: closet, regla: "monocromatico", familias: ["verde"] }), []);
});

test("vestido: nunca con superior ni inferior", () => {
  const vestido = prenda("vestido negro", "vestido", "#000000");
  const cs = generarCandidatos({ prendas: [...closet, vestido], regla: null, max: 20 });
  const conVestido = cs.filter((c) => c.ids.includes(id(vestido)));
  assert.ok(conVestido.length > 0);
  for (const c of conVestido) {
    assert.ok(c.prendas.every((p) => !["parte superior", "parte inferior"].includes(tipoDe(p))));
  }
});

test("outfits guardados en prendas se ignoran como pieza", () => {
  const outfit = { id: 999, tipo: "outfit", descripcion: "outfit", metadata_ia: { prendas: [] } };
  const cs = generarCandidatos({ prendas: [...closet, outfit], regla: null });
  for (const c of cs) assert.ok(!c.ids.includes("999"));
});

test("closet grande: muestrea y responde rápido", () => {
  const colores = ["#1E50C8", "#FFFFFF", "#E02020", "#111111", "#2E8B57", "#E07020", "#808080", "#5B7FA6"];
  const grande = [];
  for (let i = 0; i < 200; i++) {
    const tipo = ["parte superior", "parte inferior", "calzado", "accesorio", "abrigo"][i % 5];
    grande.push(prenda(`p${i} ${["reloj", "gorra", "collar", "bolso"][i % 4]}`, tipo, colores[i % colores.length]));
  }
  assert.ok(MAX_COMBINACIONES === 3000);
  const t0 = Date.now();
  const cs = generarCandidatos({ prendas: grande, regla: null });
  assert.ok(cs.length > 0);
  assert.ok(Date.now() - t0 < 3000, `tardó ${Date.now() - t0} ms`);
});

test("candidatosGuardados", () => {
  const pz = (tipo, hex) => ({ nombre: "x", color: "x", tipo, color_medible: colorMedible(hex) });
  const mono = { id: 50, tipo: "outfit", metadata_ia: { prendas: [pz("parte superior", "#1E50C8"), pz("parte inferior", "#0A2F80"), pz("calzado", "#000000")] } };
  const rojoVerde = { id: 51, tipo: "outfit", metadata_ia: { prendas: [pz("parte superior", "#E02020"), pz("parte inferior", "#2E8B57")] } };
  const sinColor = { id: 52, tipo: "outfit", metadata_ia: { prendas: [{ nombre: "x", tipo: "parte superior" }] } };
  const todos = [mono, rojoVerde, sinColor];

  const m = candidatosGuardados(todos, "monocromatico", ["azul"]);
  assert.deepEqual(m.map((c) => c.ids), [["50"]]);
  assert.equal(m[0].regla, "monocromatico");

  const libres = candidatosGuardados(todos, null, []);
  assert.deepEqual(libres.map((c) => c.ids[0]).sort(), ["50", "51"]);
  for (const c of libres) assert.ok(c.regla);
  assert.deepEqual(candidatosGuardados(todos, "triada", []), []);
});

test("closet a medio analizar: calzado/abrigo sin color → []", () => {
  const camisa = prenda("camisa", "parte superior", "#1E50C8");
  const pant = prenda("pantalón negro", "parte inferior", "#111111");
  const zap = prenda("zapatos", "calzado", null);
  const chaqueta = prenda("chaqueta", "abrigo", null);
  assert.deepEqual(generarCandidatos({ prendas: [camisa, pant, zap, chaqueta], regla: null, clima: { temp: 5 } }), []);
  // sin calzado en absoluto sí arma (sin zapatos)
  const sinNada = generarCandidatos({ prendas: [camisa, pant], regla: null });
  assert.ok(sinNada.length > 0);
  // abrigo sin color pero opcional (clima templado, zapatos con color): sí arma
  const zapC = prenda("zapatos negros", "calzado", "#000000");
  assert.ok(generarCandidatos({ prendas: [camisa, pant, zapC, chaqueta], regla: null, clima: { temp: 21 } }).length > 0);
});

test("aptaParaClima: temp null es sin clima", () => {
  assert.equal(aptaParaClima(short, { temp: null }), true);
  assert.equal(aptaParaClima(abrigoGris, { temp: null, feels: null }), true);
});

test("calor con lluvia: abrigo de lluvia opcional, otros no", () => {
  const imper = prenda("impermeable amarillo", "abrigo", "#808080");
  assert.equal(aptaParaClima(imper, { temp: 28, rain_prob: 60 }), true);
  assert.equal(aptaParaClima(imper, { temp: 28, rain_prob: 10 }), false);
  assert.equal(aptaParaClima(abrigoGris, { temp: 28, rain_prob: 60 }), false);
  const cs = generarCandidatos({ prendas: [...closet, imper], regla: null, clima: { temp: 28, rain_prob: 60 }, max: 20 });
  assert.ok(cs.length > 0);
  for (const c of cs) assert.ok(!c.ids.includes(id(abrigoGris)));
});

test("excluirIds: calzado/accesorio excluidos se conservan con penalización si no hay otro", () => {
  const chico = [supAzul, supBlanco, jean, pantNegro, zapNegro, accNegro];
  const cs = generarCandidatos({ prendas: chico, regla: null, excluirIds: [supAzul.id, zapNegro.id, accNegro.id] });
  assert.ok(cs.length > 0);
  for (const c of cs) {
    assert.ok(!c.ids.includes(id(supAzul)));
    assert.ok(c.ids.includes(id(zapNegro)) && c.ids.includes(id(accNegro)));
    assert.ok(c.puntaje <= -1);
  }
  // exclusionBlanda false (modo edición: "cambia solo los zapatos"): estricto en todo slot
  const estricto = generarCandidatos({ prendas: chico, regla: null, excluirIds: [zapNegro.id], exclusionBlanda: false });
  for (const c of estricto) assert.ok(!c.ids.includes(id(zapNegro)));
});
