import { describe, expect, test, mock } from 'bun:test';
import path from 'node:path';
import { ActivityType } from 'discord.js';

// Le service touche la base et le cache au chargement : on les neutralise avant
// d'importer les fonctions pures que ce fichier exerce.
const mockDb = {
  welcomeConfig: {
    findUnique: mock((): Promise<unknown> => Promise.resolve(null)),
  },
};

for (const file of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(import.meta.dir, file), () => ({
    default: mockDb,
    prisma: mockDb,
    prismaRead: mockDb,
    upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert(),
  }));
}

const { collectPresenceText, getAutoRoleConfig, isAutoRoleActive } = await import(
  '../../services/features/serverTagRoleService.js'
);

/** Statut personnalisé : le texte visible vit dans `state`. */
function customStatus(state: string) {
  return { type: ActivityType.Custom, name: 'Custom Status', state, details: null } as never;
}

/** Activité classique : nom du jeu + details/state de rich presence. */
function playing(name: string, details?: string, state?: string) {
  return { type: ActivityType.Playing, name, details: details ?? null, state: state ?? null } as never;
}

describe('collectPresenceText', () => {
  test('ne lit que le statut personnalisé en portée STATUS', () => {
    const activities = [customStatus('rejoins .gg/kotbo'), playing('Minecraft', 'Survie', 'Solo')];

    const text = collectPresenceText(activities, 'STATUS');

    expect(text).toContain('rejoins .gg/kotbo');
    expect(text).not.toContain('Minecraft');
    expect(text).not.toContain('Survie');
  });

  test('ne lit que le texte de l\'activité en portée ACTIVITY', () => {
    const activities = [customStatus('rejoins .gg/kotbo'), playing('Minecraft', 'Survie', 'Solo')];

    const text = collectPresenceText(activities, 'ACTIVITY');

    expect(text).toContain('Minecraft');
    expect(text).toContain('Survie');
    expect(text).toContain('Solo');
    expect(text).not.toContain('rejoins .gg/kotbo');
  });

  test('cumule les deux sources en portée BOTH', () => {
    const activities = [customStatus('rejoins .gg/kotbo'), playing('Minecraft')];

    const text = collectPresenceText(activities, 'BOTH');

    expect(text).toContain('rejoins .gg/kotbo');
    expect(text).toContain('Minecraft');
  });

  test('renvoie une chaîne vide sans présence', () => {
    expect(collectPresenceText(undefined, 'BOTH')).toBe('');
    expect(collectPresenceText([], 'BOTH')).toBe('');
  });
});

describe('isAutoRoleActive', () => {
  const base = {
    tagAutoRoleEnabled: false,
    tagAutoRoleId: null as string | null,
    statusScanEnabled: false,
    statusScanKeyword: '',
    statusScanRoleId: null as string | null,
    statusScanScope: 'STATUS',
  };

  test('inactif sans configuration', () => {
    expect(isAutoRoleActive(null)).toBe(false);
    expect(isAutoRoleActive(base)).toBe(false);
  });

  test('inactif si le tag est activé sans rôle cible', () => {
    expect(isAutoRoleActive({ ...base, tagAutoRoleEnabled: true })).toBe(false);
  });

  test('actif dès que le tag a un rôle cible', () => {
    expect(isAutoRoleActive({ ...base, tagAutoRoleEnabled: true, tagAutoRoleId: 'role-1' })).toBe(true);
  });

  test('inactif si le scan de statut n\'a pas de mot-clé', () => {
    expect(isAutoRoleActive({
      ...base,
      statusScanEnabled: true,
      statusScanKeyword: '   ',
      statusScanRoleId: 'role-2',
    })).toBe(false);
  });

  test('le scan de statut peut retomber sur le rôle du tag', () => {
    expect(isAutoRoleActive({
      ...base,
      tagAutoRoleId: 'role-1',
      statusScanEnabled: true,
      statusScanKeyword: '.gg/kotbo',
    })).toBe(true);
  });

  test('inactif si le scan de statut n\'a aucun rôle à attribuer', () => {
    expect(isAutoRoleActive({
      ...base,
      statusScanEnabled: true,
      statusScanKeyword: '.gg/kotbo',
    })).toBe(false);
  });
});

describe('getAutoRoleConfig', () => {
  test("met en cache l'absence de config pour ne pas relire la base à chaque présence", async () => {
    mockDb.welcomeConfig.findUnique.mockClear();
    const guildId = `sans-config-${Date.now()}`;

    expect(await getAutoRoleConfig(guildId)).toBeNull();
    expect(await getAutoRoleConfig(guildId)).toBeNull();

    expect(mockDb.welcomeConfig.findUnique).toHaveBeenCalledTimes(1);
  });
});
