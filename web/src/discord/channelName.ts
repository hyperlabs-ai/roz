/**
 * Nombres de canal y categoría como los escriben los servidores de Discord: muchos llevan un emoji o
 * un símbolo de adorno delante ("💻│dev", "📁 PROYECTOS", "【📢】anuncios"). roz ya pinta el ícono
 * del tipo de canal (#, megáfono, foro…), así que ese adorno duplicaba el ícono: "# 💻 dev".
 *
 * `splitChannelName` separa el adorno del nombre. Si hay emoji, la UI lo usa EN LUGAR del ícono del
 * tipo (un solo glifo por fila, como pide diseño); si no, queda el ícono del tipo.
 */

// Emoji (incluye secuencias con ZWJ, selector de variación y tono de piel) y banderas.
const EMOJI = /^(?:\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?)*|\p{Regional_Indicator}{2})/u;
// Separadores y marcos de adorno que se ponen entre el emoji y el nombre.
const ORNAMENT = /^[\s・|│┃｜︱┊┆╏⁄/\\\-_~:>»›•·.,【】「」『』〔〕［］[\]()（）{}<>«]+/u;

export interface ChannelNameParts {
  /** Emoji del adorno (el primero), o null si el nombre no traía. */
  glyph: string | null;
  /** Nombre sin el adorno. Nunca queda vacío: si todo era adorno, se devuelve el original. */
  label: string;
}

export function splitChannelName(name: string): ChannelNameParts {
  let rest = name.trim();
  let glyph: string | null = null;
  // Hasta 3 vueltas: "【📢】anuncios", "💻 ┃ dev", "🔒-🎨-diseño".
  for (let i = 0; i < 3; i++) {
    const before = rest;
    rest = rest.replace(ORNAMENT, '');
    const m = rest.match(EMOJI);
    if (m) {
      glyph ??= m[0];
      rest = rest.slice(m[0].length);
    }
    if (rest === before) break;
  }
  rest = rest.replace(ORNAMENT, '').trim();
  return { glyph, label: rest || name.trim() };
}
