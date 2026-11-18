import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

// Le service importe Prisma au chargement : on ne teste ici que la provenance
// automatique posée sur les invitations créées par le bot, sans toucher la base.
const upsert = mock((_args: unknown) => Promise.resolve({}));
const mockDb = { guildInvite: { upsert } };

for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, dbPath), () => ({
    default: mockDb,
    prisma: mockDb,
    prismaRead: mockDb,
  }));
}

import {
  INVITE_SOURCE,
  buildInviteSourceLabel,
  recordBotInvite,
  tagInviteSource,
} from '../../services/analytics/inviteService.js';

function fakeInvite(overrides: Record<string, unknown> = {}) {
  return {
    code: 'abc123',
    guild: { id: '111' },
    inviter: { id: '999', tag: 'Kotbo#0001', username: 'Kotbo' },
    uses: 0,
    maxUses: 5,
    expiresAt: null,
    temporary: false,
    ...overrides,
  } as never;
}

beforeEach(() => {
  upsert.mockClear();
});

describe('buildInviteSourceLabel', () => {
  test('assemble le préfixe et le détail', () => {
    expect(buildInviteSourceLabel('Link', 'Les nerds')).toBe('Link-Les nerds');
  });

  test('normalise les espaces et ignore un détail vide', () => {
    expect(buildInviteSourceLabel('Link', '  Les   nerds  ')).toBe('Link-Les nerds');
    expect(buildInviteSourceLabel('MCP', '   ')).toBe('MCP');
    expect(buildInviteSourceLabel('MCP', null)).toBe('MCP');
  });

  test('tronque à la limite acceptée par le tableau de bord', () => {
    const label = buildInviteSourceLabel('Link', 'x'.repeat(120));
    expect(label.length).toBe(60);
    expect(label.endsWith('…')).toBe(true);
  });
});

describe('INVITE_SOURCE', () => {
  test('nomme les provenances par fonctionnalité', () => {
    expect(INVITE_SOURCE.channelLink('Les nerds')).toBe('Link-Les nerds');
    expect(INVITE_SOURCE.channelLinkPairing()).toBe('Link-Appairage');
    expect(INVITE_SOURCE.staffOnboarding('Les nerds')).toBe('Staff-Les nerds');
    expect(INVITE_SOURCE.mcp()).toBe('MCP');
    expect(INVITE_SOURCE.mcp('cle-support')).toBe('MCP-cle-support');
  });
});

describe('recordBotInvite', () => {
  test('crée l\'enregistrement avec sa provenance', async () => {
    await recordBotInvite(fakeInvite(), INVITE_SOURCE.channelLink('Les nerds'));

    expect(upsert).toHaveBeenCalledTimes(1);
    const args = upsert.mock.calls[0]![0] as {
      where: { code: string };
      update: { sourceLabel: string };
      create: { guildId: string; sourceLabel: string; inviterId: string; maxUses: number };
    };
    expect(args.where.code).toBe('abc123');
    expect(args.update.sourceLabel).toBe('Link-Les nerds');
    expect(args.create.guildId).toBe('111');
    expect(args.create.inviterId).toBe('999');
    expect(args.create.maxUses).toBe(5);
  });

  test('ignore une invitation sans serveur', async () => {
    await recordBotInvite(fakeInvite({ guild: null }), INVITE_SOURCE.honeypot());
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('tagInviteSource', () => {
  test('n\'échoue jamais si la base refuse l\'écriture', async () => {
    upsert.mockImplementationOnce(() => Promise.reject(new Error('db down')));

    await expect(
      tagInviteSource({ guildId: '111', code: 'abc123', sourceLabel: INVITE_SOURCE.banAppeal() }),
    ).resolves.toBeUndefined();
  });
});
