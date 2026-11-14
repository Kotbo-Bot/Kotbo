/**
 * Gains du membre remercié : XP de niveau et pièces, selon les réglages.
 *
 * Préfixe `zzz-` : ce fichier remplace `moduleGate`, `levelingService` et
 * `economyService` pour tout le process (`mock.module` est global). Il doit
 * charger après leurs propres tests, et avant `zzz-reputationActions` qui
 * remplace `reputationRewards` lui-même : d'où le tiret, trié avant les lettres.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

const rpgUpdate = mock(async (_args: unknown) => ({}));
/** Solde du membre lu par le retrait : `updateMany` ne décrémente que s'il suffit. */
let balance = 100;
const rpgUpdateMany = mock(async (args: { where: { balance?: { gte: number } }; data: Record<string, unknown> }) => {
  const floor = args.where.balance?.gte;
  if (floor !== undefined && balance < floor) return { count: 0 };
  return { count: 1 };
});
const fauxPrisma = { rpgProfile: { update: rpgUpdate, updateMany: rpgUpdateMany } };
const addXp = mock(async (..._args: unknown[]) => undefined);
const removeXp = mock(async (..._args: unknown[]) => undefined);
const getOrCreateRpgProfile = mock(async (..._args: unknown[]) => ({ id: 'profil-1' }));
let economyOn = true;
let levelingOn = true;

function mockerModule(relatif: string, overrides: Record<string, unknown>): void {
  const source = path.resolve(import.meta.dir, `${relatif}.ts`);
  for (const suffixe of ['.ts', '.js']) {
    mock.module(path.resolve(import.meta.dir, `${relatif}${suffixe}`), () => completeModuleMock(source, overrides));
  }
}

mockerModule('../../utils/db', { default: fauxPrisma, prisma: fauxPrisma, prismaRead: fauxPrisma });
mockerModule('../../services/core/moduleGate', {
  isModuleEnabled: mock(async (_guildId: string, moduleKey: string) => {
    if (moduleKey === 'economy') return economyOn;
    if (moduleKey === 'leveling') return levelingOn;
    return true;
  }),
});
mockerModule('../../services/progression/levelingService', { addXp, removeXp });
mockerModule('../../services/features/economyService', { getOrCreateRpgProfile });

const { grantRepRewards, reclaimRepRewards } = await import('../../services/community/reputationRewards.js');

const client = {} as Client;

beforeEach(() => {
  economyOn = true;
  levelingOn = true;
  balance = 100;
  for (const fn of [rpgUpdate, rpgUpdateMany, addXp, removeXp, getOrCreateRpgProfile]) fn.mockClear();
});

describe('grantRepRewards', () => {
  test('aucun gain réglé : rien n\'est versé', async () => {
    await grantRepRewards(client, 'g', 'u', { xpPerRep: 0, coinsPerRep: 0 }, 'c');
    expect(addXp).not.toHaveBeenCalled();
    expect(rpgUpdate).not.toHaveBeenCalled();
  });

  test('verse l\'XP par le module Niveaux, avec le salon du remerciement', async () => {
    await grantRepRewards(client, 'g', 'u', { xpPerRep: 25, coinsPerRep: 0 }, 'c');
    expect(addXp.mock.calls[0]).toEqual(['g', 'u', 25, client, 'c']);
  });

  test('verse les pièces sur le profil du membre', async () => {
    await grantRepRewards(client, 'g', 'u', { xpPerRep: 0, coinsPerRep: 40 }, undefined);
    expect(getOrCreateRpgProfile.mock.calls[0]).toEqual(['g', 'u']);
    expect(rpgUpdate.mock.calls[0][0]).toEqual({ where: { id: 'profil-1' }, data: { balance: { increment: 40 } } });
  });

  test('pas de pièces quand le module Économie est éteint', async () => {
    economyOn = false;
    await grantRepRewards(client, 'g', 'u', { xpPerRep: 0, coinsPerRep: 40 }, undefined);
    expect(rpgUpdate).not.toHaveBeenCalled();
  });

  test('un échec de l\'XP n\'empêche pas les pièces', async () => {
    addXp.mockImplementationOnce(async () => { throw new Error('leveling'); });
    await grantRepRewards(client, 'g', 'u', { xpPerRep: 10, coinsPerRep: 5 }, undefined);
    expect(rpgUpdate).toHaveBeenCalledTimes(1);
  });

  test('rend les gains réellement versés', async () => {
    expect(await grantRepRewards(client, 'g', 'u', { xpPerRep: 10, coinsPerRep: 5 }, undefined)).toEqual({ xp: 10, coins: 5 });
  });

  test('un module éteint ne compte pas son gain comme versé', async () => {
    economyOn = false;
    levelingOn = false;
    expect(await grantRepRewards(client, 'g', 'u', { xpPerRep: 10, coinsPerRep: 5 }, undefined)).toEqual({ xp: 0, coins: 0 });
    expect(addXp).not.toHaveBeenCalled();
  });

  test('un gain en échec n\'est pas compté comme versé', async () => {
    addXp.mockImplementationOnce(async () => { throw new Error('leveling'); });
    expect(await grantRepRewards(client, 'g', 'u', { xpPerRep: 10, coinsPerRep: 5 }, undefined)).toEqual({ xp: 0, coins: 5 });
  });
});

describe('reclaimRepRewards', () => {
  test('rien de versé : rien à reprendre', async () => {
    await reclaimRepRewards(client, 'g', 'u', { xp: 0, coins: 0 });
    expect(removeXp).not.toHaveBeenCalled();
    expect(rpgUpdateMany).not.toHaveBeenCalled();
  });

  test('reprend l\'XP versée', async () => {
    await reclaimRepRewards(client, 'g', 'u', { xp: 25, coins: 0 });
    expect(removeXp.mock.calls[0]).toEqual(['g', 'u', 25, client]);
  });

  test('reprend les pièces quand le solde suffit', async () => {
    await reclaimRepRewards(client, 'g', 'u', { xp: 0, coins: 40 });
    expect(rpgUpdateMany).toHaveBeenCalledTimes(1);
    expect(rpgUpdateMany.mock.calls[0][0]).toEqual({
      where: { guildId: 'g', userId: 'u', balance: { gte: 40 } },
      data: { balance: { decrement: 40 } },
    });
  });

  test('un solde déjà dépensé descend à zéro, jamais en dessous', async () => {
    balance = 10;
    await reclaimRepRewards(client, 'g', 'u', { xp: 0, coins: 40 });
    expect(rpgUpdateMany).toHaveBeenCalledTimes(2);
    expect(rpgUpdateMany.mock.calls[1][0]).toEqual({
      where: { guildId: 'g', userId: 'u', balance: { lt: 40 } },
      data: { balance: 0 },
    });
  });

  test('les pièces sont reprises même si Économie a été éteint depuis', async () => {
    economyOn = false;
    await reclaimRepRewards(client, 'g', 'u', { xp: 0, coins: 40 });
    expect(rpgUpdateMany).toHaveBeenCalled();
  });

  test('un échec de l\'XP n\'empêche pas la reprise des pièces', async () => {
    removeXp.mockImplementationOnce(async () => { throw new Error('leveling'); });
    await reclaimRepRewards(client, 'g', 'u', { xp: 10, coins: 5 });
    expect(rpgUpdateMany).toHaveBeenCalled();
  });
});
