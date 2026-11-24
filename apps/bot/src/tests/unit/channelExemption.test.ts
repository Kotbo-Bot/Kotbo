import { describe, expect, test } from 'bun:test';
import { channelScope, isChannelExempt } from '../../utils/channelExemption';

/** Salon factice : seuls `id`, `parentId` et `parent.parentId` sont lus. */
const category = { id: 'cat-tickets', parentId: null, parent: null };
const ticket = { id: 'ticket-42', parentId: 'cat-tickets', parent: category };
const thread = { id: 'fil-7', parentId: 'ticket-42', parent: ticket };
const loose = { id: 'general', parentId: null, parent: null };

describe('channelScope', () => {
  test('un salon rangé couvre lui-même et sa catégorie', () => {
    expect(channelScope(ticket)).toEqual(['ticket-42', 'cat-tickets']);
  });

  test('un fil remonte jusqu\'à la catégorie de son salon', () => {
    expect(channelScope(thread)).toEqual(['fil-7', 'ticket-42', 'cat-tickets']);
  });

  test('un salon hors catégorie ne couvre que lui-même', () => {
    expect(channelScope(loose)).toEqual(['general']);
  });

  test('sans salon, rien n\'est couvert', () => {
    expect(channelScope(null)).toEqual([]);
  });
});

describe('isChannelExempt', () => {
  test('une catégorie exemptée couvre les salons créés à la volée dedans', () => {
    expect(isChannelExempt(ticket, ['cat-tickets'])).toBe(true);
  });

  test('une catégorie exemptée couvre aussi les fils de ses salons', () => {
    expect(isChannelExempt(thread, ['cat-tickets'])).toBe(true);
  });

  test('un salon exempté reste exempté comme avant', () => {
    expect(isChannelExempt(loose, ['general'])).toBe(true);
  });

  test('un salon d\'une autre catégorie n\'est pas exempté', () => {
    expect(isChannelExempt(ticket, ['cat-staff', 'general'])).toBe(false);
  });
});
