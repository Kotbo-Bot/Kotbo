import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { GuildMember, type ButtonInteraction, type Client } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

const prismaMock = {
  reactionRoleMenu: {
    findFirst: mock(async () => null as Record<string, unknown> | null),
    findUnique: mock(async () => null as Record<string, unknown> | null),
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
  createReactionRoleMenu,
  deleteReactionRoleMenu,
  getBotRoleAccess,
  handleRoleToggleInteraction,
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

  test('n’écrit en base que les modes de bouton connus', async () => {
    prismaMock.reactionRoleMenu.create.mockResolvedValueOnce({ id: 'menu-1' });
    prismaMock.reactionRoleMenu.findUnique.mockResolvedValueOnce(null);

    const client = {
      guilds: {
        cache: { get: mock(() => undefined) },
        fetch: mock(async () => null),
      },
    } as unknown as Client;

    await createReactionRoleMenu(
      client,
      'guild-1',
      'channel-1',
      'Mes rôles',
      [
        { emoji: '', label: 'Annonces', roleId: 'role-1', mode: 'nawak' as never },
        { emoji: '📢', label: 'Events', roleId: 'role-2', mode: 'add_only' },
      ],
      'add_only',
    );

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

    await createReactionRoleMenu(client, 'guild-1', 'channel-1', 'Couleurs', [{ label: 'Rouge', roleId: 'rouge' }], 'exclusive');

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

    await createReactionRoleMenu(
      client,
      'guild-1',
      'channel-1',
      'Mes rôles',
      [
        { label: 'Annonces', roleId: 'role-1', style: 'arc-en-ciel' as never },
        { label: 'Events', roleId: 'role-2', style: 'danger' },
      ],
    );

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
