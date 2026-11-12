import { describe, expect, it } from 'vitest';
import { buildReplyPrefix, parseReplyPrefix, withReplyPrefix } from '../src/discord/reply.js';
import { normalizeApiMessage, replyTargetOf } from '../src/discord/normalize.js';
import type { DiscordApiMessage } from '../src/adapters/discord.js';

// La línea de respuesta es el contrato entre roz (que la escribe al responder por webhook) y el
// puente (que la lee del eco para llenar reply_to_id). Si una cambia sin la otra, las respuestas
// hechas desde roz dejan de verse como respuestas.

const G = '100000000000000001';
const C = '400000000000000002';
const M = '500000000000000001';
const A = '200000000000000002';

describe('prefijo de respuesta', () => {
  it('ida y vuelta: lo que escribe roz lo lee el puente', () => {
    const content = withReplyPrefix({ guildId: G, channelId: C, messageId: M, authorId: A }, 'va, lo reviso');
    expect(content).toBe(`-# ↪ <@${A}> · https://discord.com/channels/${G}/${C}/${M}\nva, lo reviso`);
    expect(parseReplyPrefix(content)).toEqual({
      replyTo: { guildId: G, channelId: C, messageId: M, authorId: A },
      body: 'va, lo reviso',
    });
  });

  it('sin autor (p. ej. respuesta a otro webhook) no menciona a nadie', () => {
    const prefix = buildReplyPrefix({ guildId: G, channelId: C, messageId: M, authorId: null });
    expect(prefix).not.toContain('<@');
    expect(parseReplyPrefix(prefix + 'ok').replyTo).toEqual({ guildId: G, channelId: C, messageId: M, authorId: null });
  });

  it('un texto sin la línea vuelve intacto', () => {
    for (const t of ['hola', '', `https://discord.com/channels/${G}/${C}/${M}`, `-# nota\nhola`, `> -# ↪ <@${A}> · https://discord.com/channels/${G}/${C}/${M}`]) {
      expect(parseReplyPrefix(t)).toEqual({ replyTo: null, body: t });
    }
  });

  it('solo cuenta al inicio del mensaje', () => {
    const t = `hola\n-# ↪ <@${A}> · https://discord.com/channels/${G}/${C}/${M}\n`;
    expect(parseReplyPrefix(t).replyTo).toBeNull();
  });

  it('respuesta con cuerpo vacío (solo adjunto) y CRLF', () => {
    expect(parseReplyPrefix(`-# ↪ https://discord.com/channels/${G}/${C}/${M}`).body).toBe('');
    expect(parseReplyPrefix(`-# ↪ <@!${A}> · https://discord.com/channels/${G}/${C}/${M}\r\nx`)).toEqual({
      replyTo: { guildId: G, channelId: C, messageId: M, authorId: A },
      body: 'x',
    });
  });
});

function apiMessage(over: Partial<DiscordApiMessage> = {}): DiscordApiMessage {
  return {
    id: '500000000000000009',
    channel_id: C,
    type: 0,
    author: { id: '600000000000000001', username: 'Ana López', bot: true },
    content: 'hola',
    timestamp: '2026-11-11T12:00:00.000000+00:00',
    edited_timestamp: null,
    attachments: [],
    embeds: [],
    mentions: [],
    mention_roles: [],
    mention_everyone: false,
    pinned: false,
    ...over,
  };
}

describe('normalizeApiMessage / replyTargetOf', () => {
  it('respuesta nativa (tipo 19) toma message_reference', () => {
    expect(replyTargetOf(apiMessage({ type: 19, message_reference: { message_id: M, type: 0 } }))).toBe(M);
  });

  it('un reenvío (message_reference.type 1) no es respuesta', () => {
    expect(replyTargetOf(apiMessage({ type: 19, message_reference: { message_id: M, type: 1 } }))).toBeNull();
  });

  it('mensaje de webhook con la línea de roz → reply_to_id', () => {
    const content = withReplyPrefix({ guildId: G, channelId: C, messageId: M, authorId: A }, 'sí');
    const row = normalizeApiMessage(apiMessage({ webhook_id: '700000000000000001', content }), G);
    expect(row.reply_to_id).toBe(M);
    expect(row.webhook_id).toBe('700000000000000001');
    // El contenido se guarda tal cual (la línea se quita al armar la vista).
    expect(row.content).toBe(content);
  });

  it('la línea de un webhook que apunta a OTRO canal no es respuesta (no se filtra su texto)', () => {
    const OTHER = '400000000000000003';
    const content = withReplyPrefix({ guildId: G, channelId: OTHER, messageId: M, authorId: A }, 'mira esto');
    expect(normalizeApiMessage(apiMessage({ webhook_id: '700000000000000001', content }), G).reply_to_id).toBeNull();
  });

  it('embeds: solo URLs http(s) (nada de javascript:)', () => {
    const row = normalizeApiMessage(
      apiMessage({
        embeds: [
          {
            title: 'x',
            url: 'javascript:alert(1)',
            author: { name: 'a', url: ' JavaScript:alert(1)', icon_url: 'data:image/svg+xml,<svg/>' },
            image: { url: 'javascript:alert(1)' },
            thumbnail: { url: 'https://ok.test/t.png' },
          },
        ],
      }),
      G,
    );
    expect(row.embeds[0]).toMatchObject({ url: null, author: { name: 'a', url: null, iconUrl: null }, image: null, thumbnail: { url: 'https://ok.test/t.png' } });
  });

  it('la línea en un mensaje que NO es de webhook no se interpreta (cualquiera podría escribirla)', () => {
    const content = withReplyPrefix({ guildId: G, channelId: C, messageId: M, authorId: A }, 'sí');
    expect(normalizeApiMessage(apiMessage({ content }), G).reply_to_id).toBeNull();
  });

  it('normaliza adjuntos, embeds, menciones y reacciones; nunca escribe dev_id', () => {
    const row = normalizeApiMessage(
      apiMessage({
        guild_id: G,
        attachments: [{ id: '1', filename: 'SPOILER_a.png', size: 10, url: 'https://cdn/x', content_type: 'image/png', width: 2, height: 3 }],
        embeds: [{ title: 'T', image: { url: 'https://i' }, fields: [{ name: 'n', value: 'v' }] }],
        mentions: [{ id: A, username: 'ana', global_name: 'Ana' }],
        reactions: [{ count: 2, count_details: { burst: 1, normal: 1 }, emoji: { id: null, name: '👍' } }],
        thread: { id: '800000000000000001', name: 'hilo' },
      }),
      G,
    );
    expect(row.attachments[0]).toMatchObject({ filename: 'SPOILER_a.png', spoiler: true, contentType: 'image/png', width: 2 });
    expect(row.embeds[0]).toMatchObject({ title: 'T', image: { url: 'https://i', width: null }, fields: [{ name: 'n', value: 'v', inline: false }] });
    expect(row.mentions).toEqual([{ id: A, username: 'ana', globalName: 'Ana' }]);
    expect(row.reactions).toEqual([{ emoji: { id: null, name: '👍', animated: false }, count: 2, burstCount: 1, userIds: [] }]);
    expect(row.thread_id).toBe('800000000000000001');
    expect(row.created_at).toBe('2026-11-11T12:00:00.000000+00:00');
    expect('dev_id' in row).toBe(false);
    expect('client_nonce' in row).toBe(false);
  });
});
