import { describe, expect, mock, test } from 'bun:test';

mock.module('../../utils/db.js', () => ({ default: {}, prisma: {}, prismaRead: {} }));

const { buildButtons, parseAegisButton } = await import('../../services/moderation/aegis/aegisAlerts');

describe('parseAegisButton', () => {
  test('lit le geste et la détection', () => {
    expect(parseAegisButton('aegis:confirm:abc')).toEqual({ action: 'confirm', detectionId: 'abc' });
    expect(parseAegisButton('aegis:unslow:abc')).toEqual({ action: 'unslow', detectionId: 'abc' });
  });

  test('refuse le reste', () => {
    expect(parseAegisButton('aegis:ban:abc')).toBeNull();
    expect(parseAegisButton('aegis:confirm')).toBeNull();
    expect(parseAegisButton('ticket:confirm:abc')).toBeNull();
  });
});

describe('buildButtons', () => {
  const base = { id: 'd1', guildId: 'g', channelId: 'c', messageId: 'm', source: 'MESSAGE' };
  const ids = (rows: ReturnType<typeof buildButtons>) =>
    rows.flatMap((row) => row.components.map((c) => {
      const data = c.toJSON() as { custom_id?: string; url?: string };
      return data.custom_id ?? data.url;
    }));

  test('en attente : confirmer, faux positif, lien', () => {
    expect(ids(buildButtons({ ...base, kind: 'TOXIC', status: 'PENDING' })))
      .toEqual(['aegis:confirm:d1', 'aegis:dismiss:d1', 'https://discord.com/channels/g/c/m']);
  });

  test("action automatique : faux positif seul, pas de lien vers un message retiré", () => {
    expect(ids(buildButtons({ ...base, kind: 'TOXIC', status: 'AUTO' }))).toEqual(['aegis:dismiss:d1']);
  });

  test('décision prise : plus de boutons', () => {
    expect(buildButtons({ ...base, kind: 'TOXIC', status: 'DISMISSED', messageId: null })).toEqual([]);
  });

  test('escalade : bouton pour lever le mode lent', () => {
    expect(ids(buildButtons({ ...base, kind: 'CONFLICT', status: 'AUTO' }, { canUnslow: true })))
      .toEqual(['aegis:unslow:d1', 'aegis:dismiss:d1']);
  });
});
