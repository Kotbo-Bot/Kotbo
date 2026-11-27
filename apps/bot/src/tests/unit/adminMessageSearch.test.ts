import { describe, expect, test } from 'bun:test';
import { parseMessageQuery } from '../../services/analytics/adminMessageSearchService.js';

const [guildId, channelId, messageId] = ['111111111111111111', '222222222222222222', '333333333333333333'];

describe('recherche globale de messages', () => {
  test('lit un lien Discord, y compris canary et entre chevrons', () => {
    const link = `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
    for (const raw of [link, ` <${link.replace('discord.com', 'canary.discord.com')}> `]) {
      expect(parseMessageQuery(raw)).toEqual({ kind: 'link', guildId, channelId, messageId });
    }
  });

  test('distingue identifiant et texte', () => {
    expect(parseMessageQuery(messageId)).toEqual({ kind: 'id', id: messageId });
    expect(parseMessageQuery('  nitro gratuit ')).toEqual({ kind: 'text', text: 'nitro gratuit' });
  });

  test('refuse une saisie trop courte', () => {
    expect(parseMessageQuery('  ab ')).toBeNull();
    expect(parseMessageQuery('')).toBeNull();
  });
});
