import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';
import type { ChatInputCommandInteraction, Client } from 'discord.js';

/**
 * Refus individuel du ping du rappel de bump (`/bump-ping`).
 *
 * Ce qui compte : le rappel part toujours ; seul le dernier bumpeur qui
 * l'accepte est notifié, et une base illisible ne doit jamais se traduire par
 * un ping envoyé à quelqu'un qui l'a refusé.
 */

const GUILD = 'guild-bump';
const BUMPER = 'user-bumper';

type BumpRow = {
  guildId: string;
  providerLabel: string;
  lastBumpUserId: string | null;
  lastChannelId: string;
  nextBumpAt: Date;
};

let dueStates: BumpRow[] = [];
let profileRow: { bumpReminderPingOptOut: boolean } | null = null;
let profileReadFails = false;

const findUnique = mock((_args?: unknown) => {
  if (profileReadFails) return Promise.reject(new Error('base indisponible'));
  return Promise.resolve(profileRow);
});
const profileUpsert = mock((_args?: unknown) => Promise.resolve({ id: 'row' }));
const bumpUpdate = mock((_args?: unknown) => Promise.resolve({}));

const mockDb = {
  bumpState: {
    findMany: mock((_args?: unknown) => Promise.resolve(dueStates)),
    update: bumpUpdate,
  },
  memberProfile: { findUnique, upsert: profileUpsert },
  guild: {
    upsert: mock((_args?: unknown) => Promise.resolve({ id: GUILD })),
    // Lu par `getEffectiveLocale` pour la langue de la réponse.
    findUnique: mock((_args?: unknown) => Promise.resolve({ id: GUILD, language: 'fr' })),
  },
};

for (const file of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(import.meta.dir, file), () => ({
    default: mockDb,
    prisma: mockDb,
    prismaRead: mockDb,
  }));
}

const {
  processDueBumpReminders,
  acceptsBumpReminderPing,
  setBumpReminderPingOptOut,
  BUMP_PING_OPT_OUT_HINT,
} = await import('../../services/integrations/bumpDetectionService.js');
const { bumpPingCommand } = await import('../../commands/utility/bump-ping.js');

type SentPayload = {
  components: Array<{ toJSON: () => unknown }>;
  allowedMentions: { parse?: string[]; users?: string[] };
};

function fakeClient() {
  const sent: SentPayload[] = [];
  const channel = {
    isTextBased: () => true,
    send: mock(async (payload: SentPayload) => {
      sent.push(payload);
      return {};
    }),
  };
  const client = { channels: { fetch: mock(async () => channel) } } as unknown as Client;
  return { client, sent };
}

function dueState(overrides: Partial<BumpRow> = {}): BumpRow {
  return {
    guildId: GUILD,
    providerLabel: 'Disboard',
    lastBumpUserId: BUMPER,
    lastChannelId: 'channel-bump',
    nextBumpAt: new Date(Date.now() - 60_000),
    ...overrides,
  };
}

/** Tout le texte affiché par le message, container compris. */
function renderedText(payload: SentPayload): string {
  return JSON.stringify(payload.components.map((component) => component.toJSON()));
}

beforeEach(() => {
  dueStates = [];
  profileRow = null;
  profileReadFails = false;
  findUnique.mockClear();
  profileUpsert.mockClear();
  bumpUpdate.mockClear();
});

describe('acceptsBumpReminderPing', () => {
  test('accepte le ping par défaut, sans profil enregistré', async () => {
    expect(await acceptsBumpReminderPing(GUILD, BUMPER)).toBe(true);
  });

  test('respecte un refus enregistré', async () => {
    profileRow = { bumpReminderPingOptOut: true };
    expect(await acceptsBumpReminderPing(GUILD, BUMPER)).toBe(false);
  });

  test('ne ping pas quand la lecture échoue', async () => {
    profileReadFails = true;
    expect(await acceptsBumpReminderPing(GUILD, BUMPER)).toBe(false);
  });
});

describe('processDueBumpReminders', () => {
  test('mentionne le dernier bumpeur qui accepte les pings', async () => {
    dueStates = [dueState()];
    const { client, sent } = fakeClient();

    await processDueBumpReminders(client);

    expect(sent).toHaveLength(1);
    expect(sent[0].allowedMentions).toEqual({ parse: [], users: [BUMPER] });
    expect(renderedText(sent[0])).toContain(`<@${BUMPER}>`);
  });

  test('affiche le bumpeur retiré sans le notifier, et envoie quand même le rappel', async () => {
    profileRow = { bumpReminderPingOptOut: true };
    dueStates = [dueState()];
    const { client, sent } = fakeClient();

    await processDueBumpReminders(client);

    expect(sent).toHaveLength(1);
    expect(sent[0].allowedMentions).toEqual({ parse: [], users: [] });
    expect(renderedText(sent[0])).toContain(`<@${BUMPER}>`);
    expect(bumpUpdate).toHaveBeenCalledWith({ where: { guildId: GUILD }, data: { reminded: true } });
  });

  test('envoie le rappel sans ping quand la préférence est illisible', async () => {
    profileReadFails = true;
    dueStates = [dueState()];
    const { client, sent } = fakeClient();

    await processDueBumpReminders(client);

    expect(sent).toHaveLength(1);
    expect(sent[0].allowedMentions.users).toEqual([]);
  });

  test('ne lit aucune préférence sans bumpeur connu', async () => {
    dueStates = [dueState({ lastBumpUserId: null })];
    const { client, sent } = fakeClient();

    await processDueBumpReminders(client);

    expect(findUnique).not.toHaveBeenCalled();
    expect(sent[0].allowedMentions).toEqual({ parse: [], users: [] });
  });

  test('pose l\'indication de désactivation sous le container, ping ou non', async () => {
    for (const optedOut of [false, true]) {
      profileRow = { bumpReminderPingOptOut: optedOut };
      dueStates = [dueState()];
      const { client, sent } = fakeClient();

      await processDueBumpReminders(client);

      expect(sent[0].components).toHaveLength(2);
      expect(sent[0].components[1].toJSON()).toMatchObject({ content: BUMP_PING_OPT_OUT_HINT });
    }
    expect(BUMP_PING_OPT_OUT_HINT).toBe('-# 🔕 Pour ne plus être ping : /bump-ping desactiver');
  });
});

describe('setBumpReminderPingOptOut', () => {
  test('écrit le choix sur le profil du membre, propre au serveur', async () => {
    await setBumpReminderPingOptOut(GUILD, BUMPER, true, { username: 'bumper' });

    expect(profileUpsert).toHaveBeenCalledWith({
      where: { guildId_userId: { guildId: GUILD, userId: BUMPER } },
      update: { bumpReminderPingOptOut: true },
      create: { guildId: GUILD, userId: BUMPER, username: 'bumper', bumpReminderPingOptOut: true },
    });
  });
});

describe('/bump-ping', () => {
  function fakeInteraction(subcommand: string) {
    const replies: Array<{ kind: string; payload: { content?: string; flags?: unknown } }> = [];
    const interaction = {
      guildId: GUILD,
      guildLocale: 'fr',
      locale: 'fr',
      guild: null,
      user: { id: BUMPER },
      options: { getSubcommand: () => subcommand },
      reply: async (payload: { content?: string }) => { replies.push({ kind: 'reply', payload }); },
      deferReply: async (payload: { flags?: unknown }) => { replies.push({ kind: 'defer', payload }); },
      editReply: async (payload: { content?: string }) => { replies.push({ kind: 'edit', payload }); },
    } as unknown as ChatInputCommandInteraction;
    return { interaction, replies };
  }

  test('desactiver enregistre le refus et répond en éphémère', async () => {
    const { interaction, replies } = fakeInteraction('disable');

    await bumpPingCommand.execute(interaction);

    expect(profileUpsert.mock.calls[0]?.[0]).toMatchObject({ update: { bumpReminderPingOptOut: true } });
    expect(replies[0]).toMatchObject({ kind: 'defer', payload: { flags: [64] } });
    expect(replies[1]?.payload.content).toContain('/bump-ping activer');
  });

  test('activer rétablit le ping', async () => {
    const { interaction, replies } = fakeInteraction('enable');

    await bumpPingCommand.execute(interaction);

    expect(profileUpsert.mock.calls[0]?.[0]).toMatchObject({ update: { bumpReminderPingOptOut: false } });
    expect(replies[1]?.kind).toBe('edit');
  });
});
