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
const fauxPrisma = { rpgProfile: { update: rpgUpdate } };
const addXp = mock(async (..._args: unknown[]) => undefined);
const getOrCreateRpgProfile = mock(async (..._args: unknown[]) => ({ id: 'profil-1' }));
let economyOn = true;

function mockerModule(relatif: string, overrides: Record<string, unknown>): void {
  const source = path.resolve(import.meta.dir, `${relatif}.ts`);
  for (const suffixe of ['.ts', '.js']) {
    mock.module(path.resolve(import.meta.dir, `${relatif}${suffixe}`), () => completeModuleMock(source, overrides));
  }
}

mockerModule('../../utils/db', { default: fauxPrisma, prisma: fauxPrisma, prismaRead: fauxPrisma });
mockerModule('../../services/core/moduleGate', {
  isModuleEnabled: mock(async (_guildId: string, moduleKey: string) => moduleKey !== 'economy' || economyOn),
});
mockerModule('../../services/progression/levelingService', { addXp });
mockerModule('../../services/features/economyService', { getOrCreateRpgProfile });

const { grantRepRewards } = await import('../../services/community/reputationRewards.js');

const client = {} as Client;

beforeEach(() => {
  economyOn = true;
  for (const fn of [rpgUpdate, addXp, getOrCreateRpgProfile]) fn.mockClear();
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
});
