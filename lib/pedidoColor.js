// Interpreta el pedido de color/prendas del usuario en el chat.
import { familiaDeNombre } from "./color.js";

const PRENDAS = {
  "parte superior": ["camisa", "camiseta", "polo", "blusa", "top"],
  "parte inferior": ["pantalon", "jean", "short", "falda", "bermuda"],
  calzado: ["zapato", "tenis", "bota", "calzado", "zapatilla", "sandalia"],
  abrigo: ["chaqueta", "abrigo", "sudadera", "hoodie", "saco", "blazer"],
  accesorio: ["gorra", "bolso", "reloj", "collar", "cinturon", "lente", "accesorio"],
  vestido: ["vestido"],
};
const TIPO_POR_PALABRA = new Map(
  Object.entries(PRENDAS).flatMap(([tipo, ps]) => ps.map((p) => [p, tipo])),
);

const ARTICULOS = new Set(["el", "la", "los", "las", "un", "una", "unos", "unas", "mi", "mis", "tu", "tus", "solo", "solamente", "esa", "ese", "esos", "esas", "este", "esta", "nada", "algo"]);
const CONECTORES = new Set(["y", "ni", "e", "o"]);

const sinAcentos = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

function tipoDePrenda(tok) {
  if (TIPO_POR_PALABRA.has(tok)) return TIPO_POR_PALABRA.get(tok);
  if (tok.endsWith("es") && TIPO_POR_PALABRA.has(tok.slice(0, -2))) return TIPO_POR_PALABRA.get(tok.slice(0, -2));
  if (tok.endsWith("s") && TIPO_POR_PALABRA.has(tok.slice(0, -1))) return TIPO_POR_PALABRA.get(tok.slice(0, -1));
  return null;
}

function familiaDeToken(tok) {
  const cand = [tok];
  if (tok.endsWith("s")) cand.push(tok.slice(0, -1));
  for (const c of [...cand]) if (c.endsWith("a")) cand.push(c.slice(0, -1) + "o");
  for (const c of cand) {
    const f = familiaDeNombre(c);
    if (f) return f;
  }
  return null;
}

// Devuelve [familia, tokensConsumidos] si hay color en la posición i ("azul marino" cuenta como uno).
function colorEn(toks, i) {
  if (i >= toks.length) return [null, 0];
  if (toks[i] === "azul" && toks[i + 1] === "marino") return ["azul marino", 2];
  const f = familiaDeToken(toks[i]);
  return f ? [f, 1] : [null, 0];
}

// Disparadores: neg (color o prenda negados), excluir (prenda), editar (prenda).
function esDisparador(toks, i) {
  const t = toks[i];
  if (t === "sin") return { modo: "neg", n: 1 };
  if (t === "evita" || t === "evitar" || t === "evito") return { modo: "neg", n: 1 };
  if (t === "no" && toks[i + 1] === "quiero") return { modo: "neg", n: 2 };
  if (t === "no" && toks[i + 1] === "me" && ["gusta", "gustan"].includes(toks[i + 2])) return { modo: "neg", n: 3 };
  if (["quita", "quitale", "quitame", "quitar"].includes(t)) return { modo: "neg", n: 1, soloPrenda: true };
  if (["cambia", "cambiar", "cambiame", "cambiale"].includes(t)) return { modo: "editar", n: 1 };
  return null;
}

const saltarArticulos = (toks, j) => {
  while (j < toks.length && ARTICULOS.has(toks[j])) j++;
  return j;
};

export function interpretarPedido(mensaje) {
  const texto = sinAcentos(String(mensaje ?? "").toLowerCase());
  const toks = texto.match(/[a-z0-9ñ]+/g) || [];
  const familias = [];
  const excluirFamilias = [];
  const excluirTipos = [];
  let editarTipo = null;
  const sueltos = []; // colores sueltos: { f, ini, fin, enfatico }

  const addUnico = (arr, v) => { if (!arr.includes(v)) arr.push(v); };
  const consumirColores = (j) => {
    for (;;) {
      const k = saltarArticulos(toks, j);
      const [f, n] = colorEn(toks, k);
      if (!f) return j;
      j = k + n;
    }
  };

  for (let i = 0; i < toks.length; ) {
    const d = esDisparador(toks, i);
    if (d) {
      let j = i + d.n;
      let hecho = false;
      for (;;) {
        j = saltarArticulos(toks, j);
        const tipo = j < toks.length ? tipoDePrenda(toks[j]) : null;
        const [fc, nc] = d.soloPrenda || tipo ? [null, 0] : colorEn(toks, j);
        if (tipo) {
          if (d.modo === "editar") { if (!editarTipo) editarTipo = tipo; }
          else addUnico(excluirTipos, tipo);
          j = consumirColores(j + 1);
        } else if (fc && d.modo === "neg") {
          addUnico(excluirFamilias, fc);
          j += nc;
        } else break;
        hecho = true;
        if (d.modo === "neg" && CONECTORES.has(toks[j])) {
          const k = saltarArticulos(toks, j + 1);
          if (k < toks.length && (tipoDePrenda(toks[k]) || (!d.soloPrenda && colorEn(toks, k)[0]))) { j = k; continue; }
        }
        break;
      }
      i = hecho ? j : i + d.n;
      continue;
    }
    if (i < toks.length && tipoDePrenda(toks[i])) {
      // colores pegados a una prenda mencionada describen esa prenda, no el pedido
      i = consumirColores(i + 1);
      continue;
    }
    const [f, n] = colorEn(toks, i);
    if (f) {
      addUnico(familias, f);
      sueltos.push({ f, ini: i, fin: i + n, enfatico: ["solo", "todo", "toda", "puro"].includes(toks[i - 1]) });
      i += n;
      continue;
    }
    i++;
  }

  let regla = null;
  if (/monocromat/.test(texto)) regla = "monocromatico";
  else if (/complementari/.test(texto)) regla = "complementarios";
  else if (/analog/.test(texto)) regla = "analogos";
  else if (/triada/.test(texto)) regla = "triada";
  else if (/neutro/.test(texto)) regla = "neutros_acento";
  else if (/\b(2|dos) colores\b/.test(texto)) regla = "dos_colores";
  else if (familias.length === 1 && sueltos.some((c) => c.enfatico)) regla = "monocromatico";
  else if (familias.length === 2) {
    const [a, b] = sueltos.filter((c, k, arr) => arr.findIndex((x) => x.f === c.f) === k);
    if (a && b && b.ini === a.fin + 1 && toks[a.fin] === "y") regla = "dos_colores";
  }

  return { regla, familias, excluirFamilias, excluirTipos, editarTipo };
}
