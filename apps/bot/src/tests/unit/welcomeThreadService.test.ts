import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { ThreadAutoArchiveDuration, ComponentType, SnowflakeUtil } from 'discord.js';
import type { WelcomeMenuPage } from '@prisma/client';
import type { WelcomeThreadConfigWithRelations } from '../../services/features/welcomeThreadService.js';

const moduleMocks: Array<[string, () => Record<string, unknown>]> = [
  ['../../utils/db', () => ({ default: {}, prisma: {}, prismaRead: {} })],
  ['../../utils/logger', () => ({
    logger: {
      info: mock(() => undefined),
      warn: mock(() => undefined),
      error: mock(() => undefined),
      debug: mock(() => undefined),
    },
  })],
];

for (const [relativePath, factory] of moduleMocks) {
  const tsPath = path.resolve(import.meta.dir, `${relativePath}.ts`);
  const jsPath = path.resolve(import.meta.dir, `${relativePath}.js`);
  mock.module(tsPath, factory);
  mock.module(jsPath, factory);
}

const {
  clampStepDelay,
  clampInactivityDeleteHours,
  resolveThreadLastActivityAt,
  resolveAutoArchiveDuration,
  parseEmbedColor,
  buildWelcomeMenuComponents,
  buildMenuPageEmbed,
  resolveExclusiveRoleIds,
  MAX_THREAD_STEPS,
} = await import('../../services/features/welcomeThreadService.js');

const guildId = '987654321098765432';

function makeConfig(overrides: Partial<WelcomeThreadConfigWithRelations> = {}): WelcomeThreadConfigWithRelations {
  return {
    guildId,
    enabled: true,
    channelId: '111111111111111111',
    threadNameTemplate: '👋 Bienvenue {username} !',
    threadMode: 'public',
    autoArchiveMinutes: 1440,
    typingEnabled: true,
    inactivityDeleteEnabled: true,
    inactivityDeleteHours: 48,
    webhookName: 'Kotbo',
    webhookAvatarUrl: null,
    menuEnabled: true,
    menuStyle: 'buttons',
    menuPlaceholder: 'Découvrir le serveur...',
    embedTitle: 'Bienvenue sur {server} !',
    embedDescription: 'Explore les sections ci-dessous. 👇',
    embedColor: '#5865F2',
    embedImageUrl: null,
    embedThumbnailUrl: null,
    steps: [],
    pages: [],
    ...overrides,
  } as WelcomeThreadConfigWithRelations;
}

function makePage(id: string, order: number, overrides: Partial<WelcomeMenuPage> = {}): WelcomeMenuPage {
  return {
    id,
    guildId,
    order,
    label: `Page ${order}`,
    emoji: null,
    summary: null,
    actionType: 'EMBED',
    roleId: null,
    roleAction: 'ADD',
    roleGroup: null,
    linkUrl: null,
    embedTitle: `Titre ${order}`,
    embedDescription: `Description ${order}`,
    embedColor: '#5865F2',
    embedImageUrl: null,
    embedThumbnailUrl: null,
    ...overrides,
  };
}

describe('clampStepDelay', () => {
  test('borne les valeurs trop petites et trop grandes', () => {
    expect(clampStepDelay(0)).toBe(250);
    expect(clampStepDelay(-500)).toBe(250);
    expect(clampStepDelay(999_999)).toBe(120_000);
  });

  test('conserve les valeurs valides', () => {
    expect(clampStepDelay(3000)).toBe(3000);
  });

  test('gère les valeurs non finies', () => {
    expect(clampStepDelay(Number.NaN)).toBe(250);
    expect(clampStepDelay(Number.POSITIVE_INFINITY)).toBe(250);
  });
});

describe('clampInactivityDeleteHours', () => {
  test('borne les valeurs hors plage', () => {
    expect(clampInactivityDeleteHours(0)).toBe(1);
    expect(clampInactivityDeleteHours(-12)).toBe(1);
    expect(clampInactivityDeleteHours(10_000)).toBe(720);
  });

  test('conserve les valeurs valides et retombe sur 48h', () => {
    expect(clampInactivityDeleteHours(48)).toBe(48);
    expect(clampInactivityDeleteHours(Number.NaN)).toBe(48);
  });
});

describe('resolveThreadLastActivityAt', () => {
  const threadCreatedAt = Date.UTC(2026, 0, 1, 12, 0, 0);
  const lastMessageAt = Date.UTC(2026, 0, 3, 8, 30, 0);

  test('utilise le dernier message quand il existe', () => {
    const thread = {
      id: String(SnowflakeUtil.generate({ timestamp: threadCreatedAt })),
      lastMessageId: String(SnowflakeUtil.generate({ timestamp: lastMessageAt })),
      createdTimestamp: threadCreatedAt,
    };
    expect(resolveThreadLastActivityAt(thread)).toBe(lastMessageAt);
  });

  test('retombe sur la création pour un thread sans message', () => {
    const thread = {
      id: String(SnowflakeUtil.generate({ timestamp: threadCreatedAt })),
      lastMessageId: null,
      createdTimestamp: threadCreatedAt,
    };
    expect(resolveThreadLastActivityAt(thread)).toBe(threadCreatedAt);
  });

  test('déduit la date du snowflake si createdTimestamp est absent', () => {
    const thread = {
      id: String(SnowflakeUtil.generate({ timestamp: threadCreatedAt })),
      lastMessageId: null,
      createdTimestamp: null,
    };
    expect(resolveThreadLastActivityAt(thread)).toBe(threadCreatedAt);
  });
});

describe('resolveAutoArchiveDuration', () => {
  test('mappe les durées supportées', () => {
    expect(resolveAutoArchiveDuration(60)).toBe(ThreadAutoArchiveDuration.OneHour);
    expect(resolveAutoArchiveDuration(4320)).toBe(ThreadAutoArchiveDuration.ThreeDays);
    expect(resolveAutoArchiveDuration(10080)).toBe(ThreadAutoArchiveDuration.OneWeek);
  });

  test('retombe sur 24h pour les valeurs inconnues', () => {
    expect(resolveAutoArchiveDuration(1440)).toBe(ThreadAutoArchiveDuration.OneDay);
    expect(resolveAutoArchiveDuration(123)).toBe(ThreadAutoArchiveDuration.OneDay);
  });
});

describe('parseEmbedColor', () => {
  test('accepte un hex valide', () => {
    expect(parseEmbedColor('#FF0000')).toBe('#FF0000');
  });

  test('retombe sur le blurple pour les valeurs invalides', () => {
    expect(parseEmbedColor('rouge')).toBe('#5865F2');
    expect(parseEmbedColor(null)).toBe('#5865F2');
    expect(parseEmbedColor('#FFF')).toBe('#5865F2');
  });
});

describe('buildWelcomeMenuComponents', () => {
  test('retourne aucun composant sans pages', () => {
    expect(buildWelcomeMenuComponents(makeConfig())).toEqual([]);
  });

  test('mode boutons : 5 boutons max par ligne', () => {
    const pages = Array.from({ length: 7 }, (_, i) => makePage(`page-${i}`, i));
    const rows = buildWelcomeMenuComponents(makeConfig({ pages }));

    expect(rows).toHaveLength(2);
    const first = rows[0].toJSON();
    const second = rows[1].toJSON();
    expect(first.components).toHaveLength(5);
    expect(second.components).toHaveLength(2);
    expect(first.components[0]).toMatchObject({
      type: ComponentType.Button,
      custom_id: 'wpage:page-0',
      label: 'Page 0',
    });
  });

  test('mode select : une seule ligne avec toutes les options', () => {
    const pages = Array.from({ length: 3 }, (_, i) => makePage(`page-${i}`, i, { summary: `Résumé ${i}` }));
    const rows = buildWelcomeMenuComponents(makeConfig({ menuStyle: 'select', pages }));

    expect(rows).toHaveLength(1);
    const row = rows[0].toJSON();
    expect(row.components).toHaveLength(1);
    const select = row.components[0] as { type: number; custom_id: string; options: Array<{ value: string; description?: string }> };
    expect(select.type).toBe(ComponentType.StringSelect);
    expect(select.custom_id).toBe('wpage_select');
    expect(select.options).toHaveLength(3);
    expect(select.options[1].value).toBe('page-1');
    expect(select.options[1].description).toBe('Résumé 1');
  });

  test('tronque à 25 pages maximum', () => {
    const pages = Array.from({ length: 30 }, (_, i) => makePage(`page-${i}`, i));
    const rows = buildWelcomeMenuComponents(makeConfig({ pages }));
    const total = rows.reduce((sum, row) => sum + row.toJSON().components.length, 0);
    expect(total).toBe(25);
  });
});

describe('buildMenuPageEmbed', () => {
  test('construit un embed avec titre, description et couleur', () => {
    const page = makePage('page-a', 0, {
      embedTitle: 'Règlement',
      embedDescription: 'Les règles du serveur.',
      embedColor: '#00FF00',
      embedImageUrl: 'https://cdn.example/image.png',
    });
    const embed = buildMenuPageEmbed(page).toJSON();

    expect(embed.title).toBe('Règlement');
    expect(embed.description).toBe('Les règles du serveur.');
    expect(embed.color).toBe(0x00ff00);
    expect(embed.image?.url).toBe('https://cdn.example/image.png');
  });
});

describe('resolveExclusiveRoleIds', () => {
  test('retourne uniquement les autres rôles du même groupe exclusif', () => {
    const selected = makePage('clan-blue', 0, {
      actionType: 'ROLE',
      roleId: 'role-blue',
      roleAction: 'EXCLUSIVE',
      roleGroup: 'Clans',
    });
    const pages = [
      selected,
      makePage('clan-red', 1, { actionType: 'ROLE', roleId: 'role-red', roleAction: 'EXCLUSIVE', roleGroup: 'clans' }),
      makePage('clan-green', 2, { actionType: 'ROLE', roleId: 'role-green', roleAction: 'EXCLUSIVE', roleGroup: '  Clans  ' }),
      makePage('notification', 3, { actionType: 'ROLE', roleId: 'role-news', roleAction: 'ADD', roleGroup: 'Clans' }),
      makePage('region', 4, { actionType: 'ROLE', roleId: 'role-eu', roleAction: 'EXCLUSIVE', roleGroup: 'Régions' }),
    ];

    expect(resolveExclusiveRoleIds(selected, pages)).toEqual(['role-red', 'role-green']);
  });

  test('déduplique les rôles et exclut toujours le rôle cible', () => {
    const selected = makePage('clan-blue', 0, {
      actionType: 'ROLE',
      roleId: 'role-blue',
      roleAction: 'EXCLUSIVE',
      roleGroup: 'Clans majeurs',
    });
    const pages = [
      selected,
      makePage('duplicate-target', 1, { actionType: 'ROLE', roleId: 'role-blue', roleAction: 'EXCLUSIVE', roleGroup: 'Clans majeurs' }),
      makePage('clan-red-a', 2, { actionType: 'ROLE', roleId: 'role-red', roleAction: 'EXCLUSIVE', roleGroup: 'Clans majeurs' }),
      makePage('clan-red-b', 3, { actionType: 'ROLE', roleId: 'role-red', roleAction: 'EXCLUSIVE', roleGroup: 'Clans majeurs' }),
    ];

    expect(resolveExclusiveRoleIds(selected, pages)).toEqual(['role-red']);
  });

  test('retourne une liste vide sans rôle ou sans groupe', () => {
    const pages = [makePage('clan-red', 1, { actionType: 'ROLE', roleId: 'role-red', roleAction: 'EXCLUSIVE', roleGroup: 'Clans' })];
    expect(resolveExclusiveRoleIds({ roleId: null, roleGroup: 'Clans' }, pages)).toEqual([]);
    expect(resolveExclusiveRoleIds({ roleId: 'role-blue', roleGroup: null }, pages)).toEqual([]);
  });
});

describe('MAX_THREAD_STEPS', () => {
  test('la limite de séquence est raisonnable', () => {
    expect(MAX_THREAD_STEPS).toBe(20);
  });
});
