/**
 * Seuls la base, la langue et les services voisins (offre, bot perso, essai,
 * prix Stripe, acquisition) sont simulés : la synchronisation, le cron et
 * l'annonce, jusqu'au salon et au MP du propriétaire, sont les vrais.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { ChannelType, PermissionFlagsBits, type Client } from 'discord.js';
import type { Stripe } from '../../services/billing/stripeService.js';
import * as m from '../../lib/paraglide/messages.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

const GUILD_ID = '100000000000000001';

type GuildRow = Record<string, unknown>;
/** Ligne `Guild` du serveur, telle que la base la garde entre deux synchronisations. */
let row: GuildRow = {};

/** Comme Prisma : seules les colonnes demandées reviennent. */
function pick(source: GuildRow, select?: Record<string, boolean>): GuildRow {
  if (!select) return { ...source };
  return Object.fromEntries(Object.keys(select).map((key) => [key, source[key] ?? null]));
}

const fauxPrisma = {
  guild: {
    findFirst: mock(async () => ({ id: GUILD_ID })),
    findUnique: mock(async ({ select }: { select?: Record<string, boolean> }) => pick(row, select)),
    upsert: mock(async ({ update }: { update: GuildRow }) => {
      row = { ...row, ...update };
      return row;
    }),
    update: mock(async ({ data }: { data: GuildRow }) => {
      row = { ...row, ...data };
      return row;
    }),
    // Comme un UPDATE … WHERE : condition vérifiée et écriture faites d'un seul tenant.
    updateMany: mock(async ({ where, data }: { where: GuildRow; data: GuildRow }) => {
      if (Object.entries(where).some(([key, value]) => (row[key] ?? null) !== value)) return { count: 0 };
      row = { ...row, ...data };
      return { count: 1 };
    }),
  },
};

function mockModule(relative: string, overrides: Record<string, unknown>): void {
  const source = path.resolve(import.meta.dir, `${relative}.ts`);
  for (const ext of ['ts', 'js']) {
    mock.module(path.resolve(import.meta.dir, `${relative}.${ext}`), () => completeModuleMock(source, overrides));
  }
}
mockModule('../../utils/db', { default: fauxPrisma, prisma: fauxPrisma, prismaRead: fauxPrisma });
mockModule('../../utils/cache', { getCachedGuild: async () => ({ language: 'fr' }) });
/** Passage en gratuit par le cron, qu'un test suspend le temps de faire passer le webhook. */
let cronPlanWrite = Promise.resolve();
mockModule('../../services/system/planService', { invalidatePlan: async () => {}, setGuildPlan: () => cronPlanWrite });
mockModule('../../services/analytics/acquisitionService', { trackAcquisitionStep: () => {} });
mockModule('../../services/system/customBotRetire', { retireCustomBotIfIneligible: async () => {} });
mockModule('../../services/billing/trialService', { confirmTrialStarted: async () => {} });
mockModule('../../services/billing/stripeService', { planForPriceId: () => null });

const { syncSubscription } = await import('../../services/billing/subscriptionSync.js');
const { expireAccess } = await import('../../services/system/accessService.js');
const { setClient } = await import('../../utils/client.js');

// ─── Faux serveur Discord : un salon où le bot écrit, un propriétaire joignable ───

const channelPosts: unknown[] = [];
const ownerDms: unknown[] = [];
const salon = {
  id: 'salon-1',
  type: ChannelType.GuildText,
  isTextBased: () => true,
  permissionsFor: () => ({ has: (bit: bigint) => bit === PermissionFlagsBits.SendMessages }),
  send: async (payload: unknown) => {
    channelPosts.push(payload);
    return { id: 'message-1' };
  },
};
const guild = {
  id: GUILD_ID,
  name: 'Serveur test',
  preferredLocale: 'fr',
  systemChannelId: 'salon-1',
  members: { me: {} },
  // `resolveNoticeChannel` appelle `.get()` et `.find()` d'une Collection discord.js.
  channels: {
    cache: {
      get: (id: string) => (id === 'salon-1' ? salon : undefined),
      find: (predicate: (channel: unknown) => boolean) => (predicate(salon) ? salon : undefined),
    },
  },
  fetchOwner: async () => ({
    send: async (payload: unknown) => {
      ownerDms.push(payload);
    },
  }),
};
const client = { guilds: { fetch: async () => guild } } as unknown as Client;
setClient(client);

function abonnement(status: Stripe.Subscription.Status): Stripe.Subscription {
  return {
    id: 'sub_1',
    status,
    customer: 'cus_1',
    metadata: { guildId: GUILD_ID },
    cancel_at_period_end: false,
    items: { data: [{ price: { id: 'price_plus' }, current_period_end: Math.floor(Date.now() / 1000) + 86_400 }] },
  } as unknown as Stripe.Subscription;
}

const SUB_ENDED = m.access_sub_ended_title({}, { locale: 'fr' });
const TRIAL_ENDED = m.access_trial_ended_title({}, { locale: 'fr' });
const REVOKED = m.access_revoked_title({}, { locale: 'fr' });
const notices = () => [...channelPosts, ...ownerDms].map((payload) => JSON.stringify(payload));

beforeEach(() => {
  channelPosts.length = 0;
  ownerDms.length = 0;
  // Abonnement courant du serveur, actif jusqu'ici.
  row = { id: GUILD_ID, plan: 'PLUS', stripeSubscriptionId: 'sub_1', stripeSubscriptionStatus: 'active', accessType: 'SUBSCRIPTION', accessExpiredAt: null };
});

describe("fin d'un abonnement Stripe", () => {
  test("la résiliation d'un abonnement actif annonce sa fin, pas un retrait d'accès par l'équipe Kotbo", async () => {
    await syncSubscription(abonnement('canceled'));

    expect(channelPosts).toHaveLength(1);
    expect(ownerDms).toHaveLength(1);
    for (const notice of notices()) {
      expect(notice).toContain(SUB_ENDED);
      expect(notice).not.toContain(REVOKED);
    }
    // Accès marqué expiré : le cron access-lifecycle n'enverra ni second avis ni rappel.
    expect(row.accessExpiredAt).toBeInstanceOf(Date);
  });

  test("un rejeu de la même résiliation ne renvoie pas l'avis", async () => {
    await syncSubscription(abonnement('canceled'));
    await syncSubscription(abonnement('canceled'));

    expect(channelPosts).toHaveLength(1);
    expect(ownerDms).toHaveLength(1);
  });

  test("deux webhooks simultanés de la même résiliation n'envoient qu'un avis", async () => {
    await Promise.all([syncSubscription(abonnement('canceled')), syncSubscription(abonnement('canceled'))]);

    expect(channelPosts).toHaveLength(1);
    expect(ownerDms).toHaveLength(1);
  });

  test("le cron qui clôt l'accès pendant le webhook ne double pas l'avis", async () => {
    let resumeCron!: () => void;
    cronPlanWrite = new Promise((resolve) => { resumeCron = resolve; });

    // Le cron a lu l'accès encore ouvert et repasse l'offre en gratuit quand la résiliation arrive.
    const cron = expireAccess(client, GUILD_ID);
    await syncSubscription(abonnement('canceled'));
    resumeCron();
    await cron;

    expect(channelPosts).toHaveLength(1);
    expect(ownerDms).toHaveLength(1);
  });

  test("l'annulation d'un essai annonce la fin de l'essai, pas celle d'un abonnement", async () => {
    row = { ...row, stripeSubscriptionStatus: 'trialing', accessType: 'TRIAL' };

    await syncSubscription(abonnement('canceled'));

    expect(notices()).toHaveLength(2);
    for (const notice of notices()) {
      expect(notice).toContain(TRIAL_ENDED);
      expect(notice).not.toContain(SUB_ENDED);
    }
  });

  test("la resynchronisation d'un abonnement déjà clos ne prévient personne", async () => {
    row = { ...row, stripeSubscriptionStatus: 'canceled' };

    await syncSubscription(abonnement('canceled'));

    expect(notices()).toEqual([]);
  });

  test("un abonnement qui n'a jamais couvert le serveur ne déclenche aucun avis", async () => {
    row = { ...row, plan: 'FREE', stripeSubscriptionId: null, stripeSubscriptionStatus: null };

    await syncSubscription(abonnement('incomplete'));
    await syncSubscription(abonnement('incomplete_expired'));

    expect(notices()).toEqual([]);
  });

  test("l'avis n'est pas doublé quand l'accès a déjà été clos par le cron", async () => {
    row = { ...row, accessExpiredAt: new Date(Date.now() - 60_000) };

    await syncSubscription(abonnement('canceled'));

    expect(notices()).toEqual([]);
  });
});
