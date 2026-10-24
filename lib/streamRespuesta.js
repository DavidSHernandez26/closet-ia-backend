// Extrae, pieza a pieza, el valor del campo "respuesta" de un JSON que llega en streaming.
const MARKER = '"respuesta":"';
const ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };

export function crearExtractorRespuesta() {
  let estado = "ANTES"; // ANTES | DENTRO | FIN
  let buf = ""; // ANTES: busca el marcador; DENTRO: escape incompleto pendiente

  return {
    get terminado() {
      return estado === "FIN";
    },
    push(pieza) {
      if (estado === "FIN" || !pieza) return "";
      let s;
      if (estado === "ANTES") {
        buf += pieza;
        const idx = buf.indexOf(MARKER);
        if (idx === -1) {
          if (buf.length > MARKER.length) buf = buf.slice(-MARKER.length);
          return "";
        }
        s = buf.slice(idx + MARKER.length);
        buf = "";
        estado = "DENTRO";
      } else {
        s = buf + pieza;
        buf = "";
      }

      let texto = "";
      let i = 0;
      while (i < s.length) {
        const ch = s[i];
        if (ch === '"') {
          estado = "FIN";
          break;
        }
        if (ch !== "\\") {
          texto += ch;
          i++;
          continue;
        }
        if (i + 1 >= s.length) { buf = s.slice(i); break; }
        const esc = s[i + 1];
        if (esc === "u") {
          if (i + 6 > s.length) { buf = s.slice(i); break; }
          const hex = s.slice(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            texto += String.fromCharCode(parseInt(hex, 16));
            i += 6;
          } else {
            texto += "u";
            i += 2;
          }
          continue;
        }
        texto += ESCAPES[esc] ?? esc; // incluye \" \\ \/ y desconocidos
        i += 2;
      }
      return texto;
    },
  };
}
