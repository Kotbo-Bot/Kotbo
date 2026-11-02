import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';
import { completeModuleMock } from '../helpers/moduleMock.js';

/**
 * Un assaut de raid ne touche pas aux points de vie du joueur (issue #602).
 *
 * Le combat se joue toujours avec les PV du profil, mais ce qu'il retire ou rend reste dans
 * l'assaut : sans quoi chaque coup porté obligeait à se soigner avant le suivant, et le
 * plancher à 1 PV du report en rajoutait à un joueur tombé sans que personne le veuille.
 */

let profileHealth = 120;
let playerStats = { attack: 40, defense: 5, speed: 10, maxHealth: 3000, critChance: 0, armorPiercing: 0, damageReduction: 0, lifesteal: 0, thorns: 0 };

const raidRow = {
  id: 'raid-1',
  guildId: 'guild-1',
  status: 'OPEN',
  teamMode: 'CLAN',
  closesAt: new Date(Date.now() + 3_600_000),
  assaultsPerMember: 3,
  boughtAssaultsMax: 0,
  energyCost: 10,
  bossAttack: 500,
  bossDefense: 1,
  bossSpeed: 1,
  bossSpells: '[]',
};

const teamRow = { id: 'team-1', teamName: 'Aurore', remainingHealth: 1_000_000, totalHealth: 1_000_000, memberCount: 3 };

const profileUpdate = mock(async (_args: { data: Record<string, unknown> }) => ({}));

const mockDb = {
  rpgRaid: { findFirst: mock(async () => raidRow) },
  rpgRaidAssault: { count: mock(async () => 0), create: mock(async () => ({})) },
  rpgRaidBonus: { findUnique: mock(async () => null) },
  rpgRaidTeam: {
    findUnique: mock(async () => teamRow),
    update: mock(async (args: { data: { remainingHealth: { decrement: number } } }) => ({
      ...teamRow,
      remainingHealth: teamRow.remainingHealth - args.data.remainingHealth.decrement,
    })),
    updateMany: mock(async () => ({ count: 0 })),
  },
  rpgProfile: { updateMany: mock(async () => ({ count: 1 })), update: profileUpdate },
};

for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(import.meta.dir, dbPath), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

const economyPath = path.resolve(import.meta.dir, '../../services/features/economyService.ts');
for (const suffix of ['economyService.ts', 'economyService.js']) {
  mock.module(path.resolve(import.meta.dir, '../../services/features', suffix), () => completeModuleMock(economyPath, {
    getOrCreateEconomyConfig: async () => ({ enabled: true, raidEnabled: true }),
    getOrCreateRpgProfile: async () => ({ id: 'profile-1', guildId: 'guild-1', userId: 'user-1', health: profileHealth }),
  }));
}

const combatPath = path.resolve(import.meta.dir, '../../services/features/combatService.ts');
for (const suffix of ['combatService.ts', 'combatService.js']) {
  mock.module(path.resolve(import.meta.dir, '../../services/features', suffix), () => completeModuleMock(combatPath, {
    loadEffectiveStats: async () => playerStats,
    loadAvailableSkills: async () => [],
  }));
}

const teamResolverPath = path.resolve(import.meta.dir, '../../services/features/rpg/rpgTeamResolver.ts');
for (const suffix of ['rpgTeamResolver.ts', 'rpgTeamResolver.js']) {
  mock.module(path.resolve(import.meta.dir, '../../services/features/rpg', suffix), () => completeModuleMock(teamResolverPath, {
    resolveRpgTeam: async () => ({ key: 'clan-a', name: 'Aurore', countMembers: async () => 3 }),
  }));
}

const trackerPath = path.resolve(import.meta.dir, '../../services/features/rpg/rpgObjectiveTracker.ts');
for (const suffix of ['rpgObjectiveTracker.ts', 'rpgObjectiveTracker.js']) {
  mock.module(path.resolve(import.meta.dir, '../../services/features/rpg', suffix), () => completeModuleMock(trackerPath, {
    trackRpgObjective: async () => undefined,
  }));
}

const { attackRaid } = await import('../../services/features/rpg/rpgRaidService.js');

/** Écritures du profil qui portent sur les points de vie, quelle que soit leur forme. */
function healthWrites() {
  return profileUpdate.mock.calls.filter(([args]) => Object.prototype.hasOwnProperty.call(args.data, 'health'));
}

beforeEach(() => {
  profileHealth = 120;
  playerStats = { attack: 40, defense: 5, speed: 10, maxHealth: 3000, critChance: 0, armorPiercing: 0, damageReduction: 0, lifesteal: 0, thorns: 0 };
  profileUpdate.mockClear();
});

describe('attackRaid et points de vie du joueur', () => {
  test('les coups du boss ne retirent aucun PV au profil', async () => {
    const outcome = await attackRaid({} as never, 'guild-1', 'user-1', null);

    expect(outcome.result.damageTaken).toBeGreaterThan(0);
    expect(healthWrites()).toHaveLength(0);
  });

  test('le vol de vie de l\'assaut ne rend aucun PV au profil', async () => {
    profileHealth = 1;
    playerStats = { ...playerStats, attack: 400, lifesteal: 1 };

    await attackRaid({} as never, 'guild-1', 'user-1', null);

    expect(healthWrites()).toHaveLength(0);
  });
});
