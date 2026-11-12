// GENERADO por discord-bridge/scripts/sync-shared.mjs desde src/discord/reply.ts. No editar a mano.
// Respuestas desde roz. Un webhook de Discord NO admite `message_reference` (eso es solo para bots y
// usuarios), así que una respuesta escrita en roz no puede salir como "respuesta" nativa. Se publica
// con una primera línea de subtexto que cita al autor y enlaza el mensaje original:
//
//   -# ↪ <@123456789012345678> · https://discord.com/channels/<guild>/<canal>/<mensaje>
//   texto de la respuesta…
//
// En Discord se ve como una línea chica con la mención (que hace sonar al autor, como una respuesta
// normal) y un enlace que salta al mensaje. En roz se quita la línea y se pinta la cita propia.
//
// La línea es el CONTRATO entre roz y el puente: roz la escribe al enviar, y el puente la lee del eco
// para llenar discord_message.reply_to_id sin depender de que roz haya escrito su fila primero.
// Puro, sin red: tests en test/discord-reply.test.ts.

const PREFIX = '-# ↪ ';
// `-# ↪ ` + mención opcional + ` · ` + enlace al mensaje, y fin de línea.
const LINE_RE =
  /^-# ↪ (?:<@!?(\d{15,25})> · )?https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d{15,25})\/(\d{15,25})\/(\d{15,25})[ \t]*(?:\r?\n|$)/;

export interface ReplyTarget {
  guildId: string;
  channelId: string;
  messageId: string;
  /** Autor del mensaje citado (para la mención). null = no se menciona (p. ej. otro webhook). */
  authorId: string | null;
}

export function messageLink(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

/** Primera línea que antepone roz a una respuesta. */
export function buildReplyPrefix(target: ReplyTarget): string {
  const who = target.authorId ? `<@${target.authorId}> · ` : '';
  return `${PREFIX}${who}${messageLink(target.guildId, target.channelId, target.messageId)}\n`;
}

/** Contenido final de una respuesta (prefijo + cuerpo). */
export function withReplyPrefix(target: ReplyTarget, body: string): string {
  return buildReplyPrefix(target) + body;
}

export interface ParsedReply {
  replyTo: ReplyTarget | null;
  /** Contenido sin la línea de respuesta (igual al original si no la había). */
  body: string;
}

/** Separa la línea de respuesta de roz del cuerpo. Un texto sin la línea vuelve intacto. */
export function parseReplyPrefix(content: string): ParsedReply {
  const m = LINE_RE.exec(content);
  if (!m) return { replyTo: null, body: content };
  return {
    replyTo: { authorId: m[1] ?? null, guildId: m[2]!, channelId: m[3]!, messageId: m[4]! },
    body: content.slice(m[0].length),
  };
}
