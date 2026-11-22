/**
 * Un serveur staff lié vit sous l'abonnement du serveur principal : il hérite de
 * son offre (sans coût en plus) et retombe en FREE quand le lien ou l'activation
 * du principal disparaît.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { completeModuleMock } from '../helpers/moduleMock.js';

const MAIN = '100000000000000001';
const STAFF = '100000000000000002';

type Row = Record<string, unknown>;

let links: Row[] = [];
let staffRow: Row | null = null;

const guildUpdate = mock(async (_args: { where: Row; data: Row }) => ({}));
const guildUpsert = mock(async (_args: { where: Row; update: Row; create: Row }) => ({}));
const noopUpsert = mock(async () => ({}));
const fakePrisma = {
  staffServerLink: { findMany: mock(async () => links) },
  guild: {
    findUnique: mock(async () => staffRow),
    update: guildUpdate,
    upsert: guildUpsert,
  },
  economyConfig: { upsert: noopUpsert },
  levelConfig: { upsert: noopUpsert },
};

function mockModule(relative: string, overrides: Record<string, unknown>): void {
  const source = path.resolve(import.meta.dir, `${relative}.ts`);
  for (const ext of ['ts', 'js']) {
    mock.module(path.resolve(import.meta.dir, `${relative}.${ext}`), () => completeModuleMock(source, overrides));
  }
}
const invalidatePlan = mock(async (_guildId: string) => {});
mockModule('../../utils/db', { default: fakePrisma, prisma: fakePrisma, prismaRead: fakePrisma });
mockModule('../../services/system/planService', { invalidatePlan });
mockModule('../../services/progression/levelingService', { invalidateLevelConfigCache: async () => {} });

const { reconcileStaffGuildActivation } = await import('../../utils/activation.js');

const mainLink = (over: Row = {}): Row => ({
  staffGuildId: STAFF,
  enabled: true,
  mainGuild: { id: MAIN, activated: true, activationCode: 'KB-AAAA-BBBB-CCCC', plan: 'PLUS', ...over },
});

beforeEach(() => {
  guildUpdate.mockClear();
  guildUpsert.mockClear();
  invalidatePlan.mockClear();
  links = [mainLink()];
  staffRow = null;
});

describe("héritage de l'offre par le serveur staff", () => {
  test("à l'activation par le lien, le serveur staff reçoit l'offre du principal", async () => {
    expect(await reconcileStaffGuildActivation(STAFF)).toBe('activated');
    const arg = guildUpsert.mock.calls[0]![0];
    expect(arg.update.plan).toBe('PLUS');
    expect(arg.create.plan).toBe('PLUS');
    expect(invalidatePlan).toHaveBeenCalledWith(STAFF);
  });

  test("déjà activé par le lien mais en FREE : il passe à l'offre du principal", async () => {
    staffRow = { activated: true, activatedViaStaffLink: true, plan: 'FREE' };
    expect(await reconcileStaffGuildActivation(STAFF)).toBe('unchanged');
    expect(guildUpdate.mock.calls[0]![0]).toEqual({ where: { id: STAFF }, data: { plan: 'PLUS' } });
    expect(invalidatePlan).toHaveBeenCalledWith(STAFF);
  });

  test("offre déjà alignée : aucune écriture", async () => {
    staffRow = { activated: true, activatedViaStaffLink: true, plan: 'PLUS' };
    await reconcileStaffGuildActivation(STAFF);
    expect(guildUpdate).not.toHaveBeenCalled();
    expect(invalidatePlan).not.toHaveBeenCalled();
  });

  test("un serveur staff activé par son propre code garde son offre", async () => {
    staffRow = { activated: true, activatedViaStaffLink: false, plan: 'FREE' };
    await reconcileStaffGuildActivation(STAFF);
    expect(guildUpdate).not.toHaveBeenCalled();
  });

  test("principal désactivé : le serveur staff repasse en FREE", async () => {
    links = [mainLink({ activated: false })];
    staffRow = { activated: true, activatedViaStaffLink: true, plan: 'PLUS' };
    expect(await reconcileStaffGuildActivation(STAFF)).toBe('deactivated');
    expect(guildUpdate.mock.calls[0]![0].data.plan).toBe('FREE');
    expect(invalidatePlan).toHaveBeenCalledWith(STAFF);
  });

  test("plus aucun lien : le serveur staff repasse en FREE", async () => {
    links = [];
    staffRow = { activated: true, activatedViaStaffLink: true, plan: 'PLUS' };
    expect(await reconcileStaffGuildActivation(STAFF)).toBe('deactivated');
    expect(guildUpdate.mock.calls[0]![0].data.plan).toBe('FREE');
  });
});
