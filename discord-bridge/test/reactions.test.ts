import { describe, expect, it } from 'vitest';
import {
  applyReactionAdd,
  applyReactionRemove,
  applyReactionRemoveEmoji,
  mergeReactions,
} from '../src/reactions.js';
import type { DiscordReaction } from '../src/shared/types.js';

const THUMB = { id: null, name: '👍' };
const PARTY = { id: '900000000000000001', name: 'party', animated: true };

describe('reacciones', () => {
  it('ADD crea la entrada, suma y recuerda al usuario', () => {
    let list: DiscordReaction[] = [];
    list = applyReactionAdd(list, THUMB, 'a');
    list = applyReactionAdd(list, THUMB, 'b');
    list = applyReactionAdd(list, PARTY, 'a');
    expect(list).toEqual([
      { emoji: { id: null, name: '👍', animated: false }, count: 2, burstCount: 0, userIds: ['a', 'b'] },
      { emoji: { id: PARTY.id, name: 'party', animated: true }, count: 1, burstCount: 0, userIds: ['a'] },
    ]);
  });

  it('ADD repetido del mismo usuario no cuenta doble', () => {
    const once = applyReactionAdd([], THUMB, 'a');
    expect(applyReactionAdd(once, THUMB, 'a')).toBe(once);
  });

  it('super reacción suma a count y burstCount', () => {
    const list = applyReactionAdd(applyReactionAdd([], THUMB, 'a'), THUMB, 'b', true);
    expect(list[0]).toMatchObject({ count: 2, burstCount: 1 });
  });

  it('REMOVE resta y quita la entrada al llegar a 0', () => {
    let list = applyReactionAdd(applyReactionAdd([], THUMB, 'a'), THUMB, 'b');
    list = applyReactionRemove(list, THUMB, 'a');
    expect(list[0]).toMatchObject({ count: 1, userIds: ['b'] });
    list = applyReactionRemove(list, THUMB, 'b');
    expect(list).toEqual([]);
  });

  it('REMOVE de un emoji desconocido no cambia nada', () => {
    const list = applyReactionAdd([], THUMB, 'a');
    expect(applyReactionRemove(list, PARTY, 'a')).toBe(list);
  });

  it('REMOVE_EMOJI quita solo ese emoji (custom por id)', () => {
    const list = applyReactionAdd(applyReactionAdd([], THUMB, 'a'), PARTY, 'a');
    expect(applyReactionRemoveEmoji(list, { id: PARTY.id, name: 'otro-nombre' })).toHaveLength(1);
  });

  it('mergeReactions conserva usuarios conocidos sin pasar del conteo fresco', () => {
    const existing = applyReactionAdd(applyReactionAdd([], THUMB, 'a'), THUMB, 'b');
    const fresh: DiscordReaction[] = [{ emoji: { id: null, name: '👍', animated: false }, count: 1, burstCount: 0, userIds: [] }];
    expect(mergeReactions(fresh, existing)[0]!.userIds).toEqual(['a']);
    expect(mergeReactions(fresh, null)).toBe(fresh);
  });
});
