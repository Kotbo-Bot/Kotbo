import { describe, expect, test } from 'bun:test';
import { LOCAL_MODELS, isSynced, redirectGuildIds, resolveDataGuild } from '../../services/network/networkScope.js';

const resolve = async (id: string) => (id === 'sub' ? 'primary' : id);

describe('redirectGuildIds', () => {
  test('redirige un where simple et une création', async () => {
    expect(await redirectGuildIds({ where: { guildId: 'sub', userId: 'u' } }, resolve))
      .toEqual({ where: { guildId: 'primary', userId: 'u' } });
    expect(await redirectGuildIds({ data: { guildId: 'sub', xp: 3 } }, resolve))
      .toEqual({ data: { guildId: 'primary', xp: 3 } });
  });

  test('redirige les clés composées et les AND/OR', async () => {
    const out = await redirectGuildIds({
      where: { guildId_userId: { guildId: 'sub', userId: 'u' }, OR: [{ guildId: 'sub' }, { guildId: 'other' }] },
    }, resolve);
    expect(out).toEqual({
      where: { guildId_userId: { guildId: 'primary', userId: 'u' }, OR: [{ guildId: 'primary' }, { guildId: 'other' }] },
    });
  });

  test('ne touche ni aux select ni aux dates, et ne mute pas les arguments', async () => {
    const date = new Date();
    const args = { where: { guildId: 'sub', createdAt: { gte: date } }, select: { guildId: true } };
    const out = await redirectGuildIds(args, resolve);
    expect(out).toEqual({ where: { guildId: 'primary', createdAt: { gte: date } }, select: { guildId: true } });
    expect(args.where.guildId).toBe('sub');
  });

  test('préserve les instances de classe (ex. FieldRef Prisma) sans les aplatir', async () => {
    class FakeFieldRef {
      constructor(public readonly modelName: string, public readonly name: string) {}
    }
    const ref = new FakeFieldRef('Ticket', 'lastStaffMessageAt');
    const out = await redirectGuildIds({
      where: { guildId: 'sub', lastMemberMessageAt: { gt: ref } },
    }, resolve);
    expect(out.where.guildId).toBe('primary');
    expect(out.where.lastMemberMessageAt.gt).toBe(ref);
    expect(out.where.lastMemberMessageAt.gt instanceof FakeFieldRef).toBe(true);
  });
});

describe('resolveDataGuild', () => {
  test('retombe sur le serveur lui-même si la recherche échoue', async () => {
    expect(await resolveDataGuild('failing', async () => { throw new Error('db'); })).toBe('failing');
  });
  test('renvoie le principal pour un sous-serveur', async () => {
    expect(await resolveDataGuild('member-1', async () => 'main-1')).toBe('main-1');
  });
});

describe('LOCAL_MODELS', () => {
  test('tickets, sanctions, niveaux, RPG et formulaires sont partagés', () => {
    for (const m of ['Ticket', 'Sanction', 'MemberLevel', 'RpgProfile', 'CustomForm', 'Event', 'StaffHierarchy', 'StaffRole']) {
      expect(isSynced(m)).toBe(true);
    }
  });
  test('un modèle inconnu (future fonctionnalité) est partagé par défaut', () => {
    expect(isSynced('FutureFeatureModel')).toBe(true);
    expect(LOCAL_MODELS.has('FutureFeatureModel')).toBe(false);
  });
  test('les dossiers de la cellule bien-être restent sur leur serveur', () => {
    // La composition de la cellule est propre à chaque serveur : partager les
    // dossiers ouvrirait ceux du principal à la cellule d'un sous-serveur.
    expect(isSynced('WellbeingCase')).toBe(false);
  });
});
