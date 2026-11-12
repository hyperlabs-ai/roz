import { describe, it, expect } from 'vitest';
import { isEmojiOnly, parseDiscordMarkdown, parseInline, plainText } from '../web/src/discord/markdown.js';
import {
  compareSnowflake, continuesGroup, decodeComposer, encodeComposer, indexChannels, mentionsMe, removeMessages,
  replaceRecent, sortMessages, triggerAt, upsertMessage, LOCAL_PREFIX, type UiMessage,
} from '../web/src/discord/model.js';
import type { DiscordChannelTreeView, DiscordMessageView } from '../web/src/lib/api.js';

// Lado cliente del chat de Discord: el markdown se pinta sin HTML (árbol puro) y el upsert por id
// es lo que deduplica el eco del webhook (contrato §C/§D). Un error aquí duplica mensajes o deja
// el optimista colgado para siempre.

const U1 = '111111111111111111';
const U2 = '222222222222222222';
const R1 = '333333333333333333';
const C1 = '444444444444444444';

function msg(id: string, over: Partial<DiscordMessageView> = {}): DiscordMessageView {
  return {
    id,
    channelId: C1,
    guildId: '1',
    type: 0,
    author: { discordUserId: U1, displayName: 'Ana', username: 'ana', avatarUrl: null, bot: false, webhook: false, devId: null },
    content: 'hola',
    attachments: [],
    embeds: [],
    stickers: [],
    mentions: [],
    mentionRoles: [],
    mentionEveryone: false,
    reactions: [],
    replyTo: null,
    thread: null,
    tasks: [],
    pinned: false,
    createdAt: '2026-11-11T10:00:00.000Z',
    editedAt: null,
    fromRoz: false,
    clientNonce: null,
    ...over,
  };
}

describe('markdown de Discord', () => {
  it('negritas, cursivas, subrayado, tachado, spoiler y código', () => {
    expect(parseInline('**a** *b* __c__ ~~d~~ ||e|| `f`')).toEqual([
      { t: 'strong', c: [{ t: 'text', v: 'a' }] },
      { t: 'text', v: ' ' },
      { t: 'em', c: [{ t: 'text', v: 'b' }] },
      { t: 'text', v: ' ' },
      { t: 'u', c: [{ t: 'text', v: 'c' }] },
      { t: 'text', v: ' ' },
      { t: 's', c: [{ t: 'text', v: 'd' }] },
      { t: 'text', v: ' ' },
      { t: 'spoiler', c: [{ t: 'text', v: 'e' }] },
      { t: 'text', v: ' ' },
      { t: 'code', v: 'f' },
    ]);
  });

  it('snake_case no es cursiva', () => {
    expect(parseInline('mi_var_x')).toEqual([{ t: 'text', v: 'mi_var_x' }]);
  });

  it('menciones de usuario, rol, canal, emoji propio y fecha', () => {
    const nodes = parseInline(`<@${U1}> <@!${U2}> <@&${R1}> <#${C1}> <a:baila:${R1}> <t:1700000000:R>`);
    expect(nodes.filter((n) => n.t !== 'text')).toEqual([
      { t: 'user', id: U1 },
      { t: 'user', id: U2 },
      { t: 'role', id: R1 },
      { t: 'channel', id: C1 },
      { t: 'emoji', id: R1, name: 'baila', animated: true },
      { t: 'time', unix: 1700000000, style: 'R' },
    ]);
  });

  it('enlaces: solo http(s), con texto o sueltos', () => {
    expect(parseInline('[doc](https://x.dev/a)')).toEqual([{ t: 'link', href: 'https://x.dev/a', c: [{ t: 'text', v: 'doc' }] }]);
    expect(parseInline('[mal](javascript:alert(1))').some((n) => n.t === 'link')).toBe(false);
    expect(parseInline('ve https://x.dev/a.')).toEqual([
      { t: 'text', v: 've ' },
      { t: 'link', href: 'https://x.dev/a', c: [{ t: 'text', v: 'https://x.dev/a' }] },
      { t: 'text', v: '.' },
    ]);
  });

  it('referencias a tareas (HYP-12, #ROZ-123) pero no dentro de palabras', () => {
    expect(parseInline('ver #HYP-12 y ROZ-123').filter((n) => n.t === 'task')).toEqual([
      { t: 'task', identifier: 'HYP-12', raw: '#HYP-12' },
      { t: 'task', identifier: 'ROZ-123', raw: 'ROZ-123' },
    ]);
    expect(parseInline('xHYP-12').some((n) => n.t === 'task')).toBe(false);
  });

  it('bloques: código, citas, encabezados, subtexto y listas', () => {
    const blocks = parseDiscordMarkdown('# Título\n> cita\n> dos\n-# chiquito\n- a\n- b\n```ts\nconst x = 1;\n```\nfin');
    expect(blocks.map((b) => b.t)).toEqual(['h', 'quote', 'sub', 'list', 'codeblock', 'p']);
    expect(blocks[4]).toEqual({ t: 'codeblock', lang: 'ts', v: 'const x = 1;' });
  });

  it('>>> cita todo lo que sigue', () => {
    const blocks = parseDiscordMarkdown('antes\n>>> uno\ndos');
    expect(blocks).toHaveLength(2);
    expect(blocks[1]!.t).toBe('quote');
  });

  it('solo emojis → grande', () => {
    expect(isEmojiOnly(parseDiscordMarkdown(`🔥 <:ok:${R1}>`))).toBe(true);
    expect(isEmojiOnly(parseDiscordMarkdown('🔥 listo'))).toBe(false);
  });

  it('texto plano para nombres de tarea', () => {
    expect(plainText(`**Arreglar** login <@${U1}>`, { user: () => 'Ana' })).toBe('Arreglar login @Ana');
  });
});

describe('modelo de mensajes', () => {
  it('compara snowflakes como números', () => {
    expect(compareSnowflake('9', '10')).toBeLessThan(0);
    expect(compareSnowflake('200', '100')).toBeGreaterThan(0);
  });

  it('el optimista se reemplaza por el real con el mismo clientNonce y el eco solo reemplaza', () => {
    const local: UiMessage = { ...msg(`${LOCAL_PREFIX}n1`, { clientNonce: 'n1' }), pending: true };
    let list: UiMessage[] = sortMessages([msg('100'), local]);
    list = upsertMessage(list, msg('200', { clientNonce: 'n1', content: 'real' }));
    expect(list.map((m) => m.id)).toEqual(['100', '200']);
    // Eco del puente (sin clientNonce): misma fila, no se duplica.
    list = upsertMessage(list, msg('200', { content: 'eco' }));
    expect(list.map((m) => m.id)).toEqual(['100', '200']);
    expect(list[1]!.content).toBe('eco');
  });

  it('un eco del webhook leído antes de la atribución no le quita el mensaje al dev', () => {
    const hookAuthor = { discordUserId: '700000000000000001', displayName: 'Ana', username: 'Ana', avatarUrl: null, bot: true, webhook: true, devId: 'dev-ana' };
    const mine = msg('300', { fromRoz: true, clientNonce: 'n9', author: hookAuthor });
    let list: UiMessage[] = [mine];
    // El puente avisó con la fila aún sin dev_id: webhook sin dueño, sin clientNonce.
    list = upsertMessage(list, msg('300', { fromRoz: false, clientNonce: null, content: 'eco', author: { ...hookAuthor, devId: null, displayName: 'Ana (APP)' } }));
    expect(list[0]).toMatchObject({ fromRoz: true, clientNonce: 'n9', content: 'eco', author: { devId: 'dev-ana', displayName: 'Ana' } });
    // De OTRO autor (no el mismo webhook) sí se reemplaza tal cual.
    list = upsertMessage(list, msg('300', { fromRoz: false, author: { ...hookAuthor, discordUserId: '700000000000000009', devId: null } }));
    expect(list[0]!.fromRoz).toBe(false);
  });

  it('borrar marca la cita de las respuestas como eliminada', () => {
    const list = [msg('100'), msg('200', { replyTo: { id: '100', author: null, excerpt: 'hola', deleted: false } })];
    const next = removeMessages(list, ['100']);
    expect(next.map((m) => m.id)).toEqual(['200']);
    expect(next[0]!.replyTo).toEqual({ id: '100', author: null, excerpt: null, deleted: true });
  });

  it('al resincronizar se conserva lo viejo cargado y los optimistas en vuelo', () => {
    const local: UiMessage = { ...msg(`${LOCAL_PREFIX}n2`, { clientNonce: 'n2' }), pending: true };
    const list = sortMessages([msg('50'), msg('100'), local]);
    const next = replaceRecent(list, [msg('300'), msg('100')]);
    // '50' es más viejo que la página nueva: se conserva (la persona ya había subido a verlo).
    expect(next.map((m) => m.id)).toEqual(['50', '100', '300', `${LOCAL_PREFIX}n2`]);
  });

  it('agrupa por autor (los de roz por dev, no por webhook) y corta con respuestas', () => {
    const a = msg('100', { author: { ...msg('1').author, discordUserId: 'wh', webhook: true, devId: 'dev-a', displayName: 'Ana' } });
    const b = msg('101', { author: { ...msg('1').author, discordUserId: 'wh', webhook: true, devId: 'dev-b', displayName: 'Beto' }, createdAt: '2026-11-11T10:01:00.000Z' });
    const a2 = msg('102', { author: a.author, createdAt: '2026-11-11T10:02:00.000Z' });
    expect(continuesGroup(a, b)).toBe(false);
    expect(continuesGroup(a, a2)).toBe(true);
    expect(continuesGroup(a, { ...a2, replyTo: { id: '1', author: null, excerpt: null, deleted: false } })).toBe(false);
  });

  it('me menciona: directo o @everyone', () => {
    expect(mentionsMe(msg('1', { mentions: [{ id: U1, username: 'a', globalName: null }] }), U1)).toBe(true);
    expect(mentionsMe(msg('1', { mentionEveryone: true }), U2)).toBe(true);
    expect(mentionsMe(msg('1'), U2)).toBe(false);
  });
});

describe('compositor', () => {
  it('codifica menciones y emojis al formato de Discord', () => {
    const out = encodeComposer(
      'hola @Ana López y @Ana en #general :fuego:',
      [
        { label: '@Ana', token: `<@${U2}>` },
        { label: '@Ana López', token: `<@${U1}>` },
        { label: '#general', token: `<#${C1}>` },
      ],
      [{ id: R1, name: 'fuego', animated: false }],
    );
    expect(out).toBe(`hola <@${U1}> y <@${U2}> en <#${C1}> <:fuego:${R1}>`);
  });

  it('decodifica para editar y vuelve a codificar igual', () => {
    const content = `ok <@${U1}> en <#${C1}> <:fuego:${R1}>`;
    const { text, tokens } = decodeComposer(content, { user: () => 'Ana', channel: () => 'general', role: () => undefined });
    expect(text).toBe('ok @Ana en #general :fuego:');
    expect(encodeComposer(text, tokens, [{ id: R1, name: 'fuego', animated: false }])).toBe(content);
  });

  it('detecta el disparador bajo el cursor', () => {
    expect(triggerAt('hola @an', 8)).toEqual({ kind: '@', start: 5, query: 'an' });
    expect(triggerAt('ver #gen', 8)).toEqual({ kind: '#', start: 4, query: 'gen' });
    expect(triggerAt('a las 10:3', 10)).toBeNull();
    expect(triggerAt('correo@x', 8)).toBeNull();
  });
});

describe('índice de canales', () => {
  it('incluye hilos bajo su canal', () => {
    const abilities = { send: true, attach: true, mentionEveryone: false, readHistory: true };
    const tree: DiscordChannelTreeView = {
      uncategorized: [],
      categories: [
        {
          id: 'cat',
          name: 'Equipo',
          position: 0,
          channels: [
            {
              id: C1, type: 0, name: 'general', topic: null, position: 0, parentId: 'cat', nsfw: false, syncedWithCategory: true,
              supported: true, lastMessageId: null, lastMessageAt: null, abilities,
              threads: [
                {
                  id: 't1', parentId: C1, name: 'hilo', type: 11, archived: false, locked: false, private: false,
                  starterMessageId: null, messageCount: 3, lastMessageAt: null, archivedAt: null, abilities,
                },
              ],
            },
          ],
        },
      ],
    };
    const idx = indexChannels(tree);
    expect(idx.get('t1')).toMatchObject({ isThread: true, parentId: C1, name: 'hilo' });
    expect(idx.get(C1)).toMatchObject({ isThread: false, name: 'general' });
  });
});
