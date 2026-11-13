import { describe, expect, it } from 'vitest';
import { isFullMessage, mapChannel, mapEmoji, mapMember, mapMessage, mapMessagePatch, mapOverwrites, mapRole } from '../../src/bridge/map.js';
import { buildReplyPrefix } from '../../src/bridge/shared/reply.js';
import { GUILD, msg, sf, textChannel, thread } from './fakes/discord.js';

const CH = '300000000000000001';

describe('mapChannel', () => {
  it('copia overwrites tal cual con strings y normaliza el tipo', () => {
    const row = mapChannel(
      textChannel(CH, {
        name: 'general',
        topic: 'charla',
        position: 3,
        parent_id: '300000000000000099',
        permission_overwrites: [
          { id: GUILD, type: 0, allow: '0', deny: '1024' },
          { id: '200000000000000001', type: 'member', allow: '1024', deny: '0' },
        ],
      }),
      GUILD,
    );
    expect(row).toMatchObject({ id: CH, guild_id: GUILD, type: 0, name: 'general', topic: 'charla', position: 3, parent_id: '300000000000000099', deleted_at: null });
    expect(row.overwrites).toEqual([
      { id: GUILD, type: 0, allow: '0', deny: '1024' },
      { id: '200000000000000001', type: 1, allow: '1024', deny: '0' },
    ]);
  });

  it('no incluye columnas que el payload no trae (no pisa con null)', () => {
    const row = mapChannel({ id: CH, type: 0, guild_id: GUILD }, GUILD);
    expect(Object.keys(row).sort()).toEqual(['deleted_at', 'guild_id', 'id', 'type']);
  });

  it('nunca produce member_ids ni starter_message_id (los mantiene el puente aparte)', () => {
    const row = mapChannel(thread('300000000000000002', CH, { type: 12 }), GUILD);
    expect(row).not.toHaveProperty('member_ids');
    expect(row).not.toHaveProperty('starter_message_id');
  });

  it('hilos: archivado, bloqueado, dueño y conteo', () => {
    const row = mapChannel(
      thread('300000000000000002', CH, {
        message_count: 7,
        thread_metadata: { archived: true, locked: true, archive_timestamp: '2026-02-01T00:00:00.000Z' },
      }),
      GUILD,
    );
    expect(row).toMatchObject({ parent_id: CH, archived: true, locked: true, archived_at: '2026-02-01T00:00:00.000Z', message_count: 7, owner_id: '200000000000000001' });
  });

  it('last_message_at se deduce del snowflake', () => {
    const id = sf(60);
    const row = mapChannel(textChannel(CH, { last_message_id: id }), GUILD);
    expect(row.last_message_at).toBe('2026-01-01T00:01:00.000Z');
  });

  it('mapOverwrites tolera lista ausente', () => {
    expect(mapOverwrites(undefined)).toEqual([]);
  });
});

describe('roles, miembros, emojis', () => {
  it('rol con bitfield en string', () => {
    expect(mapRole({ id: '1', name: 'dev', permissions: '2199023255552' }, GUILD)).toMatchObject({ permissions: '2199023255552', color: 0, deleted_at: null });
  });

  it('miembro: quita @everyone de roles y revive con left_at null', () => {
    const row = mapMember(
      {
        user: { id: '200000000000000001', username: 'ana', global_name: 'Ana', avatar: 'abc' },
        nick: 'anita',
        avatar: 'srv',
        roles: [GUILD, '500000000000000001'],
        joined_at: '2025-01-01T00:00:00Z',
        communication_disabled_until: '2026-01-02T00:00:00Z',
      },
      GUILD,
    );
    expect(row).toMatchObject({ user_id: '200000000000000001', nick: 'anita', avatar: 'abc', guild_avatar: 'srv', roles: ['500000000000000001'], left_at: null, communication_disabled_until: '2026-01-02T00:00:00Z' });
  });

  it('miembro sin usuario → null', () => {
    expect(mapMember({ roles: [] }, GUILD)).toBeNull();
  });

  it('emoji unicode (sin id) → null', () => {
    expect(mapEmoji({ id: null, name: '👍' }, GUILD)).toBeNull();
    expect(mapEmoji({ id: '9', name: 'party', animated: true }, GUILD)).toMatchObject({ id: '9', animated: true, available: true, roles: [] });
  });
});

describe('mensajes', () => {
  it('mapMessage nunca escribe dev_id ni client_nonce', () => {
    const row = mapMessage(msg(CH, 1), GUILD);
    expect(row).not.toHaveProperty('dev_id');
    expect(row).not.toHaveProperty('client_nonce');
    expect(row.deleted_at).toBeNull();
  });

  it('respuesta nativa → reply_to_id', () => {
    const row = mapMessage(msg(CH, 2, { type: 19, message_reference: { message_id: sf(1), type: 0 } }), GUILD);
    expect(row.reply_to_id).toBe(sf(1));
  });

  it('respuesta de roz (webhook con la línea) → reply_to_id', () => {
    const target = sf(1);
    const content = buildReplyPrefix({ guildId: GUILD, channelId: CH, messageId: target, authorId: '200000000000000001' }) + 'hola';
    const row = mapMessage(msg(CH, 2, { webhook_id: '700000000000000001', content }), GUILD);
    expect(row.reply_to_id).toBe(target);
  });

  it('isFullMessage distingue el parcial', () => {
    expect(isFullMessage(msg(CH, 1))).toBe(true);
    expect(isFullMessage({ id: '1', channel_id: CH, embeds: [] })).toBe(false);
  });

  it('MESSAGE_UPDATE parcial (solo embeds) no toca contenido, autor ni respuesta', () => {
    const patch = mapMessagePatch({ id: sf(1), channel_id: CH, embeds: [{ title: 'vista previa' }] }, GUILD);
    expect(Object.keys(patch)).toEqual(['embeds']);
    expect(patch.embeds?.[0]?.title).toBe('vista previa');
  });

  it('ficha de roz en Components V2: sin embeds, sus componentes se aplanan en un embed (también al editarse)', () => {
    const components = [
      {
        type: 17,
        accent_color: 0xff5b23,
        components: [
          { type: 10, content: '### Infraestructura\n-# 2 servicios · 2 en línea' },
          { type: 9, components: [{ type: 10, content: '**Login**\n`WAT-44` · 🟢 En curso' }], accessory: { type: 11, media: { url: 'https://github.com/ana.png' } } },
        ],
      },
    ];
    const full = mapMessage(msg(CH, 3, { content: '', flags: 1 << 15, components }), GUILD);
    expect(full.embeds).toHaveLength(1);
    expect(full.embeds[0]).toMatchObject({ title: 'Infraestructura', color: 0xff5b23, thumbnail: { url: 'https://github.com/ana.png' } });
    expect(full.embeds[0]!.description).toBe('2 servicios · 2 en línea\n\n**Login**\n`WAT-44` · 🟢 En curso');
    const patch = mapMessagePatch({ id: sf(3), channel_id: CH, flags: 1 << 15, components }, GUILD);
    expect(patch.embeds?.[0]?.title).toBe('Infraestructura');
    // Un mensaje normal con botones (sin el flag) no inventa embeds.
    expect(mapMessagePatch({ id: sf(4), channel_id: CH, components: [{ type: 1, components: [] }] }, GUILD).embeds).toBeUndefined();
  });

  it('MESSAGE_UPDATE de edición trae contenido y edited_at', () => {
    const patch = mapMessagePatch({ id: sf(1), channel_id: CH, content: 'editado', edited_timestamp: '2026-01-01T01:00:00Z' }, GUILD);
    expect(patch).toEqual({ content: 'editado', edited_at: '2026-01-01T01:00:00Z' });
  });

  it('MESSAGE_UPDATE completo no incluye dev_id/client_nonce', () => {
    const patch = mapMessagePatch(msg(CH, 1, { content: 'x' }), GUILD);
    expect(patch).not.toHaveProperty('dev_id');
    expect(patch).not.toHaveProperty('client_nonce');
    expect(patch.author_id).toBe('200000000000000001');
  });

  it('edición de webhook de roz conserva reply_to_id al releer la línea', () => {
    const target = sf(1);
    const content = buildReplyPrefix({ guildId: GUILD, channelId: CH, messageId: target, authorId: null }) + 'editado';
    const patch = mapMessagePatch({ id: sf(2), channel_id: CH, webhook_id: '700000000000000001', content }, GUILD);
    expect(patch.reply_to_id).toBe(target);
  });
});
