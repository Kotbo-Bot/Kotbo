import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { GuildMember, type ButtonInteraction, type Client } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

const prismaMock = {
  reactionRoleMenu: {
    findFirst: mock(async () => null as Record<string, unknown> | null),
    findUnique: mock(async () => null as Record<string, unknown> | null),
    findMany: mock(async () => [] as Array<Record<string, unknown>>),
    create: mock(async () => ({ id: 'menu-1' })),
    update: mock(async () => ({ id: 'menu-1' })),
    delete: mock(async () => ({})),
  },
  // Dernière alerte « rôle bloqué » déjà envoyée au propriétaire.
  notification: {
    findFirst: mock(async () => null as { updatedAt: Date } | null),
  },
};

// Le service résout la langue du serveur avant de répondre : sans ce cache
// neutralisé, la résolution retomberait sur l'anglais et les messages attendus
// ici ne seraient plus les bons.
const cacheMock = {
  cache: {
    get: mock(async () => null),
    set: mock(async () => undefined),
  },
  getCachedGuild: mock(async () => ({ language: 'fr' })),
  getCachedDashboardSettings: mock(async () => null),
};

// Un rôle bloqué prévient le staff : l'envoi réel tirerait toute l'API.
const notifyMock = mock(async () => ({ notification: null, dm: 'off' }));
const notifyModule = () => completeModuleMock(
  path.resolve(import.meta.dir, '../../services/notifications/notifyService.ts'),
  { notify: notifyMock, dashboardLink: (link: string) => link },
);

for (const extension of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../services/notifications/notifyService.${extension}`), notifyModule);
  mock.module(path.resolve(import.meta.dir, `../../utils/db.${extension}`), () => ({
    default: prismaMock,
    prisma: prismaMock,
    prismaRead: prismaMock,
  }));
  mock.module(path.resolve(import.meta.dir, `../../utils/cache.${extension}`), () => cacheMock);
}

const {
  changedRoleIds,
  createReactionRoleMenu,
  handleMenuMessagesDeleted,
  handleMenuRoleDeleted,
  menusUsingRoles,
  refreshCountsForRoles,
  sendOrUpdateMenuMessage,
  deleteReactionRoleMenu,
  getBotRoleAccess,
  handleRoleToggleInteraction,
  buttonLabelWithCount,
  menuDescription,
  menuMessageStatus,
  normalizeEmbedColor,
  normalizeMenuDescription,
  roleMemberCounts,
  normalizeButtonStyle,
  updateReactionRoleMenu,
} = await import('../../services/features/reactionRoleService.js');

/** Un client Discord qui retrouve toujours son salon et son message. */
function fakeClient() {
  const deleteMessage = mock(async () => undefined);
  const fetchMessage = mock(async () => ({ delete: deleteMessage }));
  const channel = {
    isTextBased: () => true,
    messages: { fetch: fetchMessage },
  };
  const guild = {
    channels: {
      cache: { get: mock(() => channel) },
      fetch: mock(async () => channel),
    },
  };
  const client = {
    guilds: {
      cache: { get: mock(() => guild) },
      fetch: mock(async () => guild),
    },
  } as unknown as Client;

  return { client, fetchMessage, deleteMessage };
}

/** Position du rôle le plus haut du bot dans le faux serveur. */
const BOT_TOP_POSITION = 10;

/**
 * Serveur où le bot a « Gérer les rôles ». `positions` place un rôle ; un rôle
 * absent de la liste est sous le bot.
 */
function fakeGuild(positions: Record<string, number> = {}) {
  return {
    id: 'guild-1',
    ownerId: 'owner-1',
    roles: {
      cache: {
        get: (id: string) => ({ id, name: id, managed: false, position: positions[id] ?? 1 }),
      },
      fetch: mock(async () => null),
    },
    members: {
      me: { permissions: { has: () => true }, roles: { highest: { position: BOT_TOP_POSITION } } },
    },
  };
}

/**
 * `roles` est un accesseur sur le prototype de GuildMember : seul
 * `defineProperty` peut le remplacer, et le test a besoin d'un vrai
 * GuildMember car le service refuse les membres hors cache.
 */
function fakeMember(ownedRoleIds: string[], guild = fakeGuild()) {
  const member = Object.create(GuildMember.prototype) as GuildMember;
  const add = mock(async () => undefined);
  const remove = mock(async () => undefined);

  Object.defineProperty(member, 'roles', {
    value: {
      cache: new Map(ownedRoleIds.map((id) => [id, {}])),
      add,
      remove,
    },
    configurable: true,
  });
  Object.defineProperty(member, 'guild', { value: guild, configurable: true });

  return { member, add, remove };
}

function fakeInteraction(customId: string, member: GuildMember, reply: (...args: never[]) => unknown) {
  return {
    customId,
    guildId: 'guild-1',
    guildLocale: 'fr',
    message: { id: 'message-1' },
    member,
    reply,
  } as unknown as ButtonInteraction;
}

describe('reactionRoleService', () => {
  beforeEach(() => {
    prismaMock.reactionRoleMenu.findFirst.mockReset();
    prismaMock.reactionRoleMenu.findUnique.mockReset();
    prismaMock.reactionRoleMenu.create.mockReset();
    prismaMock.reactionRoleMenu.update.mockReset();
    prismaMock.reactionRoleMenu.delete.mockReset();
    prismaMock.reactionRoleMenu.findMany.mockReset();
    prismaMock.reactionRoleMenu.findMany.mockResolvedValue([]);
    prismaMock.notification.findFirst.mockReset();
    prismaMock.notification.findFirst.mockResolvedValue(null);
    notifyMock.mockClear();
  });

  test('supprime le menu en base et son message Discord', async () => {
    const { client, fetchMessage, deleteMessage } = fakeClient();

    prismaMock.reactionRoleMenu.findFirst.mockResolvedValueOnce({
      id: 'menu-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    });

    expect(await deleteReactionRoleMenu(client, 'guild-1', 'menu-1')).toBeTrue();
    expect(prismaMock.reactionRoleMenu.findFirst).toHaveBeenCalledWith({
      where: { id: 'menu-1', guildId: 'guild-1' },
    });
    expect(prismaMock.reactionRoleMenu.delete).toHaveBeenCalledWith({
      where: { id: 'menu-1' },
    });
    expect(fetchMessage).toHaveBeenCalledWith('message-1');
    expect(deleteMessage).toHaveBeenCalledTimes(1);
  });

  test('refuse les boutons d’un panneau qui n’existe plus', async () => {
    const reply = mock(async () => undefined);
    prismaMock.reactionRoleMenu.findFirst.mockResolvedValueOnce(null);

    const { member } = fakeMember([]);
    await handleRoleToggleInteraction(fakeInteraction('role_toggle:role-1:0', member, reply));

    expect(prismaMock.reactionRoleMenu.findFirst).toHaveBeenCalledWith({
      where: { guildId: 'guild-1', messageId: 'message-1' },
    });
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('plus actif'),
    }));
  });

  test('refuse un bouton dont le rôle n’est plus dans le menu', async () => {
    const reply = mock(async () => undefined);
    prismaMock.reactionRoleMenu.findFirst.mockResolvedValueOnce({
      id: 'menu-1',
      buttonMode: 'toggle',
      options: [{ label: 'Autre', roleId: 'role-2' }],
    });

    const { member, add, remove } = fakeMember([]);
    await handleRoleToggleInteraction(fakeInteraction('role_toggle:role-1:0', member, reply));

    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('plus actif'),
    }));
  });

  test('mode bascule : un second clic retire le rôle', async () => {
    const reply = mock(async () => undefined);
    prismaMock.reactionRoleMenu.findFirst.mockResolvedValueOnce({
      id: 'menu-1',
      buttonMode: 'toggle',
      options: [{ label: 'Annonces', roleId: 'role-1' }],
    });

    const { member, remove } = fakeMember(['role-1']);
    await handleRoleToggleInteraction(fakeInteraction('role_toggle:role-1:0', member, reply));

    expect(remove).toHaveBeenCalledWith('role-1');
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('retiré'),
    }));
  });

  test('mode attribution définitive : un second clic garde le rôle', async () => {
    const reply = mock(async () => undefined);
    prismaMock.reactionRoleMenu.findFirst.mockResolvedValueOnce({
      id: 'menu-1',
      buttonMode: 'add_only',
      options: [{ label: 'Annonces', roleId: 'role-1' }],
    });

    const { member, add, remove } = fakeMember(['role-1']);
    await handleRoleToggleInteraction(fakeInteraction('role_toggle:role-1:0', member, reply));

    expect(remove).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('déjà'),
    }));
  });

  test('mode attribution définitive : le premier clic attribue le rôle', async () => {
    const reply = mock(async () => undefined);
    prismaMock.reactionRoleMenu.findFirst.mockResolvedValueOnce({
      id: 'menu-1',
      buttonMode: 'add_only',
      options: [{ label: 'Annonces', roleId: 'role-1' }],
    });

    const { member, add } = fakeMember([]);
    await handleRoleToggleInteraction(fakeInteraction('role_toggle:role-1:0', member, reply));

    expect(add).toHaveBeenCalledWith('role-1');
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('attribué'),
    }));
  });

  test('le mode du bouton l’emporte sur celui du panneau', async () => {
    const reply = mock(async () => undefined);
    prismaMock.reactionRoleMenu.findFirst.mockResolvedValueOnce({
      id: 'menu-1',
      buttonMode: 'toggle',
      options: [{ label: 'Annonces', roleId: 'role-1', mode: 'add_only' }],
    });

    const { member, remove } = fakeMember(['role-1']);
    await handleRoleToggleInteraction(fakeInteraction('role_toggle:role-1:0', member, reply));

    expect(remove).not.toHaveBeenCalled();
  });

  test('l’index du bouton distingue deux boutons portant le même rôle', async () => {
    const reply = mock(async () => undefined);
    prismaMock.reactionRoleMenu.findFirst.mockResolvedValueOnce({
      id: 'menu-1',
      buttonMode: 'toggle',
      options: [
        { label: 'Prendre', roleId: 'role-1', mode: 'add_only' },
        { label: 'Basculer', roleId: 'role-1' },
      ],
    });

    const { member, remove } = fakeMember(['role-1']);
    await handleRoleToggleInteraction(fakeInteraction('role_toggle:role-1:1', member, reply));

    expect(remove).toHaveBeenCalledWith('role-1');
  });

  test('un ancien bouton sans index reste géré', async () => {
    const reply = mock(async () => undefined);
    prismaMock.reactionRoleMenu.findFirst.mockResolvedValueOnce({
      id: 'menu-1',
      buttonMode: 'toggle',
      options: [{ label: 'Annonces', roleId: 'role-1' }],
    });

    const { member, remove } = fakeMember(['role-1']);
    await handleRoleToggleInteraction(fakeInteraction('role_toggle:role-1', member, reply));

    expect(remove).toHaveBeenCalledWith('role-1');
  });

  test('un rôle placé au-dessus du bot n’est pas tenté et le staff est prévenu', async () => {
    const reply = mock(async () => undefined);
    prismaMock.reactionRoleMenu.findFirst.mockResolvedValueOnce({
      id: 'menu-1',
      title: 'Couleurs',
      buttonMode: 'toggle',
      options: [{ label: 'Admin', roleId: 'role-haut' }],
    });

    const { member, add } = fakeMember([], fakeGuild({ 'role-haut': BOT_TOP_POSITION + 1 }));
    await handleRoleToggleInteraction(fakeInteraction('role_toggle:role-haut:0', member, reply));

    expect(add).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('staff a été prévenu'),
    }));
    // L'alerte part sans être attendue par la réponse au membre.
    for (let i = 0; i < 20 && notifyMock.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'owner-1',
      kind: 'system.reaction_role_blocked',
    }));
  });

  /** Clique sur un rôle placé au-dessus du bot, puis attend la fin de l'alerte lancée sans attendre. */
  async function clickBlockedRole(roleId: string) {
    const reply = mock(async () => undefined);
    prismaMock.reactionRoleMenu.findFirst.mockResolvedValueOnce({
      id: 'menu-1',
      title: 'Couleurs',
      buttonMode: 'toggle',
      options: [{ label: 'Admin', roleId }],
    });
    const { member } = fakeMember([], fakeGuild({ [roleId]: BOT_TOP_POSITION + 1 }));
    await handleRoleToggleInteraction(fakeInteraction(`role_toggle:${roleId}:0`, member, reply));
    for (let i = 0; i < 20 && prismaMock.notification.findFirst.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  test('rôle bloqué : pas de nouvelle alerte moins d’une heure après la précédente, même lue', async () => {
    prismaMock.notification.findFirst.mockResolvedValue({ updatedAt: new Date(Date.now() - 10 * 60 * 1000) });

    await clickBlockedRole('role-deja-signale');

    expect(prismaMock.notification.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { guildId: 'guild-1', userId: 'owner-1', groupKey: 'reaction-role-blocked:role-deja-signale' },
    }));
    expect(notifyMock).not.toHaveBeenCalled();
  });

  test('rôle bloqué : une alerte vieille de plus d’une heure en autorise une nouvelle', async () => {
    prismaMock.notification.findFirst.mockResolvedValue({ updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) });

    await clickBlockedRole('role-signale-hier');

    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({
      groupKey: 'reaction-role-blocked:role-signale-hier',
    }));
  });

  test('un seul rôle : prendre un rôle retire les autres rôles du menu', async () => {
    const reply = mock(async () => undefined);
    prismaMock.reactionRoleMenu.findFirst.mockResolvedValueOnce({
      id: 'menu-1',
      buttonMode: 'exclusive',
      options: [
        { label: 'Rouge', roleId: 'rouge' },
        { label: 'Bleu', roleId: 'bleu' },
        { label: 'Vert', roleId: 'vert' },
      ],
    });

    const { member, add, remove } = fakeMember(['rouge', 'moderateur']);
    await handleRoleToggleInteraction(fakeInteraction('role_toggle:bleu:1', member, reply));

    expect(add).toHaveBeenCalledWith('bleu');
    expect(remove).toHaveBeenCalledWith(['rouge']);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('à la place'),
    }));
  });

  test('un seul rôle : un rôle du menu que le bot ne peut pas retirer reste en place', async () => {
    const reply = mock(async () => undefined);
    prismaMock.reactionRoleMenu.findFirst.mockResolvedValueOnce({
      id: 'menu-1',
      buttonMode: 'exclusive',
      options: [
        { label: 'Rouge', roleId: 'rouge' },
        { label: 'Bleu', roleId: 'bleu' },
        { label: 'Vert', roleId: 'vert' },
      ],
    });

    const { member, add, remove } = fakeMember(['rouge', 'vert'], fakeGuild({ vert: BOT_TOP_POSITION + 1 }));
    await handleRoleToggleInteraction(fakeInteraction('role_toggle:bleu:1', member, reply));

    expect(add).toHaveBeenCalledWith('bleu');
    expect(remove).toHaveBeenCalledWith(['rouge']);
  });

  test('un seul rôle : un rôle du menu réglé autrefois en attribution définitive part aussi', async () => {
    const reply = mock(async () => undefined);
    prismaMock.reactionRoleMenu.findFirst.mockResolvedValueOnce({
      id: 'menu-1',
      buttonMode: 'exclusive',
      options: [
        { label: 'Rouge', roleId: 'rouge', mode: 'add_only' },
        { label: 'Bleu', roleId: 'bleu' },
      ],
    });

    const { member, remove } = fakeMember(['rouge']);
    await handleRoleToggleInteraction(fakeInteraction('role_toggle:bleu:1', member, reply));

    expect(remove).toHaveBeenCalledWith(['rouge']);
  });

  test('un seul rôle : recliquer sur son rôle le retire, même réglé en attribution définitive', async () => {
    const reply = mock(async () => undefined);
    prismaMock.reactionRoleMenu.findFirst.mockResolvedValueOnce({
      id: 'menu-1',
      buttonMode: 'exclusive',
      options: [
        { label: 'Rouge', roleId: 'rouge', mode: 'add_only' },
        { label: 'Bleu', roleId: 'bleu' },
      ],
    });

    const { member, remove } = fakeMember(['rouge']);
    await handleRoleToggleInteraction(fakeInteraction('role_toggle:rouge:0', member, reply));

    expect(remove).toHaveBeenCalledWith('rouge');
  });

  test('lit ce que le bot peut attribuer : permission et position de son rôle le plus haut', async () => {
    expect(await getBotRoleAccess(fakeGuild() as never)).toEqual({ canManageRoles: true, topPosition: BOT_TOP_POSITION });
  });

  test('sans le mode un seul rôle, les rôles se cumulent', async () => {
    const reply = mock(async () => undefined);
    prismaMock.reactionRoleMenu.findFirst.mockResolvedValueOnce({
      id: 'menu-1',
      buttonMode: 'toggle',
      options: [
        { label: 'Rouge', roleId: 'rouge' },
        { label: 'Bleu', roleId: 'bleu' },
      ],
    });

    const { member, add, remove } = fakeMember(['rouge']);
    await handleRoleToggleInteraction(fakeInteraction('role_toggle:bleu:1', member, reply));

    expect(add).toHaveBeenCalledWith('bleu');
    expect(remove).not.toHaveBeenCalled();
  });

  test('renvoie null quand le menu a modifier n’existe pas', async () => {
    const { client } = fakeClient();
    prismaMock.reactionRoleMenu.findFirst.mockResolvedValueOnce(null);

    expect(await updateReactionRoleMenu(client, 'guild-1', 'menu-1', { title: 'Nouveau' })).toBeNull();
    expect(prismaMock.reactionRoleMenu.update).not.toHaveBeenCalled();
  });

  test('ne touche qu’aux champs fournis et garde le message en place', async () => {
    const { client, deleteMessage } = fakeClient();

    prismaMock.reactionRoleMenu.findFirst.mockResolvedValueOnce({
      id: 'menu-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      buttonMode: 'toggle',
      options: [{ label: 'Annonces', roleId: 'role-1' }],
    });
    prismaMock.reactionRoleMenu.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'menu-1', messageId: 'message-1' });

    const menu = await updateReactionRoleMenu(client, 'guild-1', 'menu-1', {
      channelId: 'channel-1',
      buttonMode: 'add_only',
    });

    expect(deleteMessage).not.toHaveBeenCalled();
    expect(prismaMock.reactionRoleMenu.update).toHaveBeenCalledWith({
      where: { id: 'menu-1' },
      data: { buttonMode: 'add_only' },
    });
    // `toMatchObject` plutot que `toEqual` : le mock ne rend qu'une ligne partielle, la
    // comparaison exacte demanderait de recopier tout le modele Prisma sans rien verifier
    // de plus. Ce qui compte ici est que le menu ressorte avec son message inchange.
    expect(menu).toMatchObject({ id: 'menu-1', messageId: 'message-1' });
  });

  test('un changement de salon supprime l’ancien message et repart de zero', async () => {
    const { client, fetchMessage, deleteMessage } = fakeClient();

    prismaMock.reactionRoleMenu.findFirst.mockResolvedValueOnce({
      id: 'menu-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      buttonMode: 'toggle',
      options: [{ label: 'Annonces', roleId: 'role-1' }],
    });
    prismaMock.reactionRoleMenu.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'menu-1', channelId: 'channel-2', messageId: 'message-2' });

    await updateReactionRoleMenu(client, 'guild-1', 'menu-1', {
      channelId: 'channel-2',
      title: 'Mes rôles',
      options: [{ label: 'Annonces', roleId: 'role-1', mode: 'nawak' as never }],
    });

    expect(fetchMessage).toHaveBeenCalledWith('message-1');
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(prismaMock.reactionRoleMenu.update).toHaveBeenCalledWith({
      where: { id: 'menu-1' },
      data: {
        title: 'Mes rôles',
        channelId: 'channel-2',
        messageId: null,
        options: [{ label: 'Annonces', roleId: 'role-1' }],
      },
    });
  });

  test('un changement de salon oublie l’ancien message en base avant de le supprimer', async () => {
    // Sinon la suppression, vue par l'écouteur, passerait pour celle d'un
    // membre du staff et déclencherait une alerte « message supprimé ».
    const { client, deleteMessage } = fakeClient();
    const order: string[] = [];
    deleteMessage.mockImplementation(async () => { order.push('delete'); });
    prismaMock.reactionRoleMenu.update.mockImplementation(async () => {
      order.push('update');
      return { id: 'menu-1' };
    });
    prismaMock.reactionRoleMenu.findFirst.mockResolvedValueOnce({
      id: 'menu-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      buttonMode: 'toggle',
      options: [{ label: 'Annonces', roleId: 'role-1' }],
    });

    await updateReactionRoleMenu(client, 'guild-1', 'menu-1', { channelId: 'channel-2' });

    expect(order.slice(0, 2)).toEqual(['update', 'delete']);
  });

  test('n’écrit en base que les modes de bouton connus', async () => {
    prismaMock.reactionRoleMenu.create.mockResolvedValueOnce({ id: 'menu-1' });
    prismaMock.reactionRoleMenu.findUnique.mockResolvedValueOnce(null);

    const client = {
      guilds: {
        cache: { get: mock(() => undefined) },
        fetch: mock(async () => null),
      },
    } as unknown as Client;

    await createReactionRoleMenu(client, 'guild-1', {
      channelId: 'channel-1',
      title: 'Mes rôles',
      options: [
        { emoji: '', label: 'Annonces', roleId: 'role-1', mode: 'nawak' as never },
        { emoji: '📢', label: 'Events', roleId: 'role-2', mode: 'add_only' },
      ],
      buttonMode: 'add_only',
    });

    expect(prismaMock.reactionRoleMenu.create).toHaveBeenCalledWith({
      data: {
        guildId: 'guild-1',
        channelId: 'channel-1',
        title: 'Mes rôles',
        buttonMode: 'add_only',
        options: [
          { label: 'Annonces', roleId: 'role-1' },
          { emoji: '📢', label: 'Events', roleId: 'role-2', mode: 'add_only' },
        ],
      },
    });
  });

  test('un menu « un seul rôle » est enregistré avec ce mode', async () => {
    prismaMock.reactionRoleMenu.create.mockResolvedValueOnce({ id: 'menu-1' });
    prismaMock.reactionRoleMenu.findUnique.mockResolvedValueOnce(null);

    const client = {
      guilds: {
        cache: { get: mock(() => undefined) },
        fetch: mock(async () => null),
      },
    } as unknown as Client;

    await createReactionRoleMenu(client, 'guild-1', { channelId: 'channel-1', title: 'Couleurs', options: [{ label: 'Rouge', roleId: 'rouge' }], buttonMode: 'exclusive' });

    expect(prismaMock.reactionRoleMenu.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ buttonMode: 'exclusive' }),
    });
  });

  test('une couleur inconnue retombe sur le gris', () => {
    expect(normalizeButtonStyle('arc-en-ciel')).toBe('secondary');
    expect(normalizeButtonStyle(undefined, 'danger')).toBe('danger');
    expect(normalizeButtonStyle('success')).toBe('success');
  });

  test('n’écrit en base que les couleurs de bouton connues', async () => {
    prismaMock.reactionRoleMenu.create.mockResolvedValueOnce({ id: 'menu-1' });
    prismaMock.reactionRoleMenu.findUnique.mockResolvedValueOnce(null);

    const client = {
      guilds: {
        cache: { get: mock(() => undefined) },
        fetch: mock(async () => null),
      },
    } as unknown as Client;

    await createReactionRoleMenu(client, 'guild-1', {
      channelId: 'channel-1',
      title: 'Mes rôles',
      options: [
        { label: 'Annonces', roleId: 'role-1', style: 'arc-en-ciel' as never },
        { label: 'Events', roleId: 'role-2', style: 'danger' },
      ],
    });

    expect(prismaMock.reactionRoleMenu.create).toHaveBeenCalledWith({
      data: {
        guildId: 'guild-1',
        channelId: 'channel-1',
        title: 'Mes rôles',
        buttonMode: 'toggle',
        options: [
          { label: 'Annonces', roleId: 'role-1' },
          { label: 'Events', roleId: 'role-2', style: 'danger' },
        ],
      },
    });
  });
});

describe('suivi des menus publiés', () => {
  /** Serveur dont le salon `salon-1` répond à la recherche du message par `fetchMessage`. */
  function guildWithChannel(fetchMessage: () => Promise<unknown>, channel: unknown = undefined) {
    const textChannel = channel === undefined ? { isTextBased: () => true, messages: { fetch: mock(fetchMessage) } } : channel;
    return {
      channels: { fetch: mock(async () => textChannel) },
    } as never;
  }

  test('un message toujours en place est signalé comme publié', async () => {
    const guild = guildWithChannel(async () => ({ id: 'message-1' }));
    expect(await menuMessageStatus(guild, { channelId: 'salon-1', messageId: 'message-1' })).toBe('ok');
  });

  test('un menu jamais publié est signalé comme manquant', async () => {
    const guild = guildWithChannel(async () => ({ id: 'message-1' }));
    expect(await menuMessageStatus(guild, { channelId: 'salon-1', messageId: null })).toBe('missing');
  });

  test('un message supprimé sur Discord est signalé comme manquant', async () => {
    const guild = guildWithChannel(async () => { throw Object.assign(new Error('Unknown Message'), { code: 10008 }); });
    expect(await menuMessageStatus(guild, { channelId: 'salon-1', messageId: 'message-1' })).toBe('missing');
  });

  test('un salon supprimé rend le message manquant', async () => {
    const guild = guildWithChannel(async () => ({}), null);
    expect(await menuMessageStatus(guild, { channelId: 'salon-1', messageId: 'message-1' })).toBe('missing');
  });

  test('un salon que Discord ne connaît plus rend le message manquant', async () => {
    const guild = {
      channels: { fetch: mock(async () => { throw Object.assign(new Error('Unknown Channel'), { code: 10003 }); }) },
    } as never;
    expect(await menuMessageStatus(guild, { channelId: 'salon-1', messageId: 'message-1' })).toBe('missing');
  });

  test('une autre erreur (permission, panne) ne conclut pas à une disparition', async () => {
    const guild = guildWithChannel(async () => { throw Object.assign(new Error('Missing Access'), { code: 50001 }); });
    expect(await menuMessageStatus(guild, { channelId: 'salon-1', messageId: 'message-1' })).toBe('unknown');
  });

  test('compte les membres de chaque rôle des menus, une seule fois par rôle', () => {
    const guild = {
      roles: {
        cache: new Map([
          ['rouge', { members: { size: 42 } }],
          ['bleu', { members: { size: 17 } }],
        ]),
      },
    } as never;

    expect(roleMemberCounts(guild, ['rouge', 'bleu', 'rouge', 'disparu'])).toEqual({ rouge: 42, bleu: 17 });
  });
});

describe('texte du message d’un menu', () => {
  test('un texte saisi par le staff remplace le texte par défaut', () => {
    expect(menuDescription('Choisis tes jeux', [], 'toggle', 'fr')).toBe('Choisis tes jeux');
  });

  test('sans texte saisi, le message explique ce que font les boutons', () => {
    const fallback = menuDescription(null, [], 'exclusive', 'fr');
    expect(fallback).toBe(menuDescription('', [], 'exclusive', 'fr'));
    expect(fallback.length).toBeGreaterThan(0);
  });

  test('le texte reçu est nettoyé : espaces retirés, vide ramené à null, longueur bornée', () => {
    expect(normalizeMenuDescription('  Salut  ')).toBe('Salut');
    expect(normalizeMenuDescription('   ')).toBeNull();
    expect(normalizeMenuDescription(42)).toBeNull();
    expect(normalizeMenuDescription('a'.repeat(5000))).toHaveLength(1000);
  });

  test('le texte saisi est enregistré avec le menu', async () => {
    prismaMock.reactionRoleMenu.create.mockResolvedValueOnce({ id: 'menu-1' });
    prismaMock.reactionRoleMenu.findUnique.mockResolvedValueOnce(null);
    const client = { guilds: { cache: { get: mock(() => undefined) }, fetch: mock(async () => null) } } as unknown as Client;

    await createReactionRoleMenu(client, 'guild-1', { channelId: 'channel-1', title: 'Jeux', options: [{ label: 'LoL', roleId: 'lol' }], description: 'Choisis tes jeux' });

    expect(prismaMock.reactionRoleMenu.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ description: 'Choisis tes jeux' }),
    });
  });
});

describe('nombre de membres sur les boutons', () => {
  test('ajoute au texte du bouton le nombre de membres qui ont le rôle', () => {
    expect(buttonLabelWithCount('Rouge', 12)).toBe('Rouge · 12');
  });

  test('sans nombre connu, le texte reste tel quel', () => {
    expect(buttonLabelWithCount('Rouge', undefined)).toBe('Rouge');
  });

  test('un texte long est raccourci pour que le nombre tienne dans la limite Discord de 80 caractères', () => {
    const label = buttonLabelWithCount('a'.repeat(80), 1234);
    expect(label).toHaveLength(80);
    expect(label.endsWith(' · 1234')).toBeTrue();
  });

  test('l’option est enregistrée avec le menu', async () => {
    prismaMock.reactionRoleMenu.create.mockResolvedValueOnce({ id: 'menu-1' });
    prismaMock.reactionRoleMenu.findUnique.mockResolvedValueOnce(null);
    const client = { guilds: { cache: { get: mock(() => undefined) }, fetch: mock(async () => null) } } as unknown as Client;

    await createReactionRoleMenu(client, 'guild-1', { channelId: 'channel-1', title: 'Couleurs', options: [{ label: 'Rouge', roleId: 'rouge' }], buttonMode: 'exclusive', showCounts: true });

    expect(prismaMock.reactionRoleMenu.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ showCounts: true }),
    });
  });
});

describe('couleur de la barre de l’embed', () => {
  test('accepte une couleur hexadécimale, avec ou sans dièse, et la met en majuscules', () => {
    expect(normalizeEmbedColor('#e74c3c')).toBe('#E74C3C');
    expect(normalizeEmbedColor('2ecc71')).toBe('#2ECC71');
  });

  test('une valeur vide ou invalide remet la couleur par défaut (null)', () => {
    expect(normalizeEmbedColor('')).toBeNull();
    expect(normalizeEmbedColor('rouge')).toBeNull();
    expect(normalizeEmbedColor('#12345')).toBeNull();
    expect(normalizeEmbedColor(null)).toBeNull();
  });

  test('la couleur choisie est enregistrée avec le menu', async () => {
    prismaMock.reactionRoleMenu.create.mockResolvedValueOnce({ id: 'menu-1' });
    prismaMock.reactionRoleMenu.findUnique.mockResolvedValueOnce(null);
    const client = { guilds: { cache: { get: mock(() => undefined) }, fetch: mock(async () => null) } } as unknown as Client;

    await createReactionRoleMenu(client, 'guild-1', { channelId: 'channel-1', title: 'Couleurs', options: [{ label: 'Rouge', roleId: 'rouge' }], embedColor: '#E74C3C' });

    expect(prismaMock.reactionRoleMenu.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ embedColor: '#E74C3C' }),
    });
  });
});

describe('message publié d’un menu', () => {
  test('l’embed ne porte pas d’heure : elle changerait à chaque mise à jour des nombres', async () => {
    const send = mock(async () => ({ id: 'message-1' }));
    const channel = { isTextBased: () => true, send, messages: { fetch: mock(async () => null) } };
    const guild = {
      id: 'guild-1',
      preferredLocale: 'fr',
      channels: { cache: { get: () => channel }, fetch: mock(async () => channel) },
      roles: { cache: { get: () => undefined } },
    };
    const client = { guilds: { cache: { get: () => guild }, fetch: mock(async () => guild) } } as unknown as Client;
    prismaMock.reactionRoleMenu.findUnique.mockResolvedValueOnce({
      id: 'menu-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      messageId: null,
      title: 'Couleurs',
      buttonMode: 'toggle',
      description: null,
      showCounts: false,
      embedColor: null,
      options: [{ label: 'Rouge', roleId: 'rouge' }],
    });

    await sendOrUpdateMenuMessage(client, 'menu-1');

    const payload = (send.mock.calls[0] as unknown as [{ embeds: Array<{ data: { timestamp?: string } }> }])[0];
    expect(payload.embeds[0].data.timestamp).toBeUndefined();
  });
});

describe('suivi des rôles des menus hors du panneau', () => {
  beforeEach(() => {
    prismaMock.reactionRoleMenu.findMany.mockReset();
    prismaMock.reactionRoleMenu.findMany.mockResolvedValue([]);
    prismaMock.notification.findFirst.mockReset();
    prismaMock.notification.findFirst.mockResolvedValue(null);
    notifyMock.mockClear();
  });

  test('ne retient que les rôles gagnés ou perdus entre deux états d’un membre', () => {
    expect(changedRoleIds(['a', 'b'], ['b', 'c']).sort()).toEqual(['a', 'c']);
    expect(changedRoleIds(['a'], ['a'])).toEqual([]);
  });

  test('ne garde que les menus qui portent l’un des rôles', () => {
    const menus = [
      { id: 'm1', options: [{ roleId: 'a' }, { roleId: 'b' }] },
      { id: 'm2', options: [{ roleId: 'c' }] },
      { id: 'm3', options: 'invalide' },
    ];
    expect(menusUsingRoles(menus, ['b']).map((menu) => menu.id)).toEqual(['m1']);
    expect(menusUsingRoles(menus, ['z'])).toEqual([]);
  });

  test('sans rôle changé, aucune lecture en base : un pseudo modifié ne coûte rien', async () => {
    await refreshCountsForRoles({} as Client, 'guild-1', []);

    expect(prismaMock.reactionRoleMenu.findMany).not.toHaveBeenCalled();
  });

  test('un rôle changé relit seulement les menus publiés qui affichent les nombres', async () => {
    await refreshCountsForRoles({} as Client, 'guild-1', ['a']);

    expect(prismaMock.reactionRoleMenu.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { guildId: 'guild-1', showCounts: true, messageId: { not: null } },
    }));
  });

  test('un rôle supprimé sur Discord prévient le staff sans attendre le clic d’un membre', async () => {
    prismaMock.reactionRoleMenu.findMany.mockResolvedValueOnce([
      { title: 'Couleurs', options: [{ roleId: 'rouge' }] },
      { title: 'Pronoms', options: [{ roleId: 'il' }] },
    ]);

    await handleMenuRoleDeleted({ id: 'rouge', name: 'Rouge', guild: fakeGuild() } as never);

    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'owner-1',
      kind: 'system.reaction_role_blocked',
      title: expect.stringContaining('Couleurs'),
      // Même clé que l'alerte au clic : le membre qui clique ensuite n'en relance pas une.
      groupKey: 'reaction-role-blocked:rouge',
    }));
  });

  test('un rôle supprimé qu’aucun menu ne porte ne prévient personne', async () => {
    prismaMock.reactionRoleMenu.findMany.mockResolvedValueOnce([{ title: 'Pronoms', options: [{ roleId: 'il' }] }]);

    await handleMenuRoleDeleted({ id: 'rouge', name: 'Rouge', guild: fakeGuild() } as never);

    expect(notifyMock).not.toHaveBeenCalled();
  });

  test('le message d’un menu supprimé sur Discord prévient le staff', async () => {
    prismaMock.reactionRoleMenu.findMany.mockResolvedValueOnce([{ id: 'menu-1', title: 'Couleurs' }]);

    await handleMenuMessagesDeleted(fakeGuild() as never, ['message-1', 'autre']);

    expect(prismaMock.reactionRoleMenu.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { guildId: 'guild-1', messageId: { in: ['message-1', 'autre'] } },
    }));
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'owner-1',
      kind: 'system.reaction_role_message_deleted',
      title: expect.stringContaining('Couleurs'),
      groupKey: 'reaction-role-message-deleted:menu-1',
    }));
  });

  test('un message supprimé qui n’est pas celui d’un menu ne prévient personne', async () => {
    await handleMenuMessagesDeleted(fakeGuild() as never, ['autre']);

    expect(notifyMock).not.toHaveBeenCalled();
  });
});
