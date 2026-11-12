// Mantenimiento de discord_message.reactions a partir de los eventos del gateway. Puro.
//
// Discord no reenvía el mensaje completo al reaccionar: manda ADD/REMOVE con el usuario y el emoji,
// y el puente lleva la cuenta (contrato §A.3). `count` es el total (normal + super), `burstCount`
// solo las super reacciones, y `userIds` quiénes reaccionaron cuando el puente lo sabe (un mensaje
// traído por REST trae conteos pero no usuarios).
import type { DiscordEmojiRef, DiscordReaction } from './shared/types.js';

export interface RawEmoji {
  id?: string | null;
  name?: string | null;
  animated?: boolean;
}

export function emojiKey(e: RawEmoji | DiscordEmojiRef): string {
  return e.id ? `c:${e.id}` : `u:${e.name ?? ''}`;
}

function toRef(e: RawEmoji): DiscordEmojiRef {
  return { id: e.id ?? null, name: e.name ?? null, animated: e.animated ?? false };
}

/** Devuelve un arreglo NUEVO; el mismo contenido si el evento es repetido (ADD de un usuario ya contado). */
export function applyReactionAdd(list: DiscordReaction[], emoji: RawEmoji, userId: string, burst = false): DiscordReaction[] {
  const key = emojiKey(emoji);
  const idx = list.findIndex((r) => emojiKey(r.emoji) === key);
  if (idx === -1) {
    return [...list, { emoji: toRef(emoji), count: 1, burstCount: burst ? 1 : 0, userIds: [userId] }];
  }
  const cur = list[idx]!;
  // Repetido: el usuario ya está contado (solo se puede deduplicar la normal; la super va aparte).
  if (!burst && cur.userIds.includes(userId)) return list;
  const next: DiscordReaction = {
    ...cur,
    count: cur.count + 1,
    burstCount: cur.burstCount + (burst ? 1 : 0),
    userIds: cur.userIds.includes(userId) ? cur.userIds : [...cur.userIds, userId],
  };
  return list.map((r, i) => (i === idx ? next : r));
}

export function applyReactionRemove(list: DiscordReaction[], emoji: RawEmoji, userId: string, burst = false): DiscordReaction[] {
  const key = emojiKey(emoji);
  const idx = list.findIndex((r) => emojiKey(r.emoji) === key);
  if (idx === -1) return list;
  const cur = list[idx]!;
  const count = Math.max(0, cur.count - 1);
  if (count === 0) return list.filter((_, i) => i !== idx);
  const next: DiscordReaction = {
    ...cur,
    count,
    burstCount: burst ? Math.max(0, cur.burstCount - 1) : cur.burstCount,
    userIds: cur.userIds.filter((u) => u !== userId),
  };
  return list.map((r, i) => (i === idx ? next : r));
}

export function applyReactionRemoveEmoji(list: DiscordReaction[], emoji: RawEmoji): DiscordReaction[] {
  const key = emojiKey(emoji);
  return list.filter((r) => emojiKey(r.emoji) !== key);
}

/**
 * Al re-escribir un mensaje desde la REST (backfill/reconciliación) los conteos vienen frescos pero
 * sin usuarios: se conservan los `userIds` que ya se conocían de ese emoji (sin pasar del conteo).
 */
export function mergeReactions(fresh: DiscordReaction[], existing: DiscordReaction[] | null | undefined): DiscordReaction[] {
  if (!existing?.length) return fresh;
  const known = new Map(existing.map((r) => [emojiKey(r.emoji), r.userIds]));
  return fresh.map((r) => {
    if (r.userIds.length) return r;
    const ids = known.get(emojiKey(r.emoji));
    return ids?.length ? { ...r, userIds: ids.slice(0, r.count) } : r;
  });
}

export function sameReactions(a: DiscordReaction[], b: DiscordReaction[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
