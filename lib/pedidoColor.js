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

const ARTICULOS = new Set(["el", "la", "los", "las", "un", "una", "unos", "unas", "mi", "mis", "tu", "tus", "solo", "solamente", "esa", "ese", "esos", "esas", "este", "esta"]);
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

function esDisparador(toks, i) {
  const t = toks[i];
  if (t === "sin") return { modo: "excluir", n: 1 };
  if (t === "no" && toks[i + 1] === "quiero") return { modo: "excluir", n: 2 };
  if (["quita", "quitale", "quitame", "quitar"].includes(t)) return { modo: "excluir", n: 1 };
  if (["cambia", "cambiar", "cambiame", "cambiale"].includes(t)) return { modo: "editar", n: 1 };
  return null;
}

export function interpretarPedido(mensaje) {
  const texto = sinAcentos(String(mensaje ?? "").toLowerCase());
  const toks = texto.match(/[a-z0-9ñ]+/g) || [];
  const familias = [];
  const excluirTipos = [];
  let editarTipo = null;

  const addUnico = (arr, v) => { if (!arr.includes(v)) arr.push(v); };

  for (let i = 0; i < toks.length; ) {
    const d = esDisparador(toks, i);
    if (d) {
      let j = i + d.n;
      let tipos = 0;
      // prendas (posible lista "x y z" / "x ni z"), cada una seguida de sus colores
      for (;;) {
        while (j < toks.length && ARTICULOS.has(toks[j])) j++;
        const tipo = j < toks.length ? tipoDePrenda(toks[j]) : null;
        if (!tipo) break;
        if (d.modo === "excluir") addUnico(excluirTipos, tipo);
        else if (!editarTipo) editarTipo = tipo;
        tipos++;
        j++;
        for (;;) {
          while (j < toks.length && ARTICULOS.has(toks[j])) j++;
          const [f, n] = colorEn(toks, j);
          if (!f) break;
          j += n;
        }
        if (d.modo === "excluir" && CONECTORES.has(toks[j])) {
          let k = j + 1;
          while (k < toks.length && ARTICULOS.has(toks[k])) k++;
          if (k < toks.length && tipoDePrenda(toks[k])) { j = k; continue; }
        }
        break;
      }
      i = tipos ? j : i + d.n;
      continue;
    }
    const [f, n] = colorEn(toks, i);
    if (f) { addUnico(familias, f); i += n; continue; }
    i++;
  }

  let regla = null;
  if (/monocromat/.test(texto)) regla = "monocromatico";
  else if (/complementari/.test(texto)) regla = "complementarios";
  else if (/analog/.test(texto)) regla = "analogos";
  else if (/triada/.test(texto)) regla = "triada";
  else if (/neutro/.test(texto)) regla = "neutros_acento";
  else if (/\b(2|dos) colores\b/.test(texto) || familias.length === 2) regla = "dos_colores";

  return { regla, familias, excluirTipos, editarTipo };
}
