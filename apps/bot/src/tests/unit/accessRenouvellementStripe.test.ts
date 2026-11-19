/**
 * `accessExpiresAt` d'un abonnement Stripe vaut la fin de la période en cours :
 * le webhook `customer.subscription.updated` la repousse au paiement suivant.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { ChannelType, PermissionFlagsBits, type Client, type Guild } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

const GUILD_ID = '222222222222222222';
const HEURE = 60 * 60 * 1000;
const JOUR_MIN = 24 * 60;

type LigneGuild = {
  id: string;
  activated: boolean;
  activatedViaStaffLink: boolean;
  accessType: string;
  accessExpiresAt: Date | null;
  accessExpiredAt: Date | null;
  accessDurationMinutes: number | null;
  accessRemindersSent: number[];
  stripeSubscriptionStatus: string | null;
  stripeCancelAtPeriodEnd: boolean;
  broadcastChannelId: string | null;
  logChannelId: string | null;
};

let ligne: LigneGuild;
const ecritures: Array<Record<string, unknown>> = [];

const fauxPrisma = {
  guild: {
    // Même filtre que le cron : serveurs activés, échéance posée, pas encore expirés.
    findMany: mock(async () =>
      ligne.activated && !ligne.activatedViaStaffLink && ligne.accessExpiresAt && !ligne.accessExpiredAt
        ? [{ ...ligne }]
        : []),
    findUnique: mock(async () => ({ ...ligne })),
    update: mock(async ({ data }: { data: Record<string, unknown> }) => {
      ecritures.push(data);
      ligne = { ...ligne, ...data } as LigneGuild;
      return { ...ligne };
    }),
  },
};

const setGuildPlan = mock(async (_guildId: string, _plan: string, _raison: string) => undefined);

function mockerModule(relatif: string, overrides: Record<string, unknown>): void {
  const source = path.resolve(import.meta.dir, `${relatif}.ts`);
  for (const suffixe of ['.ts', '.js']) {
    mock.module(path.resolve(import.meta.dir, `${relatif}${suffixe}`), () => completeModuleMock(source, overrides));
  }
}
mockerModule('../../utils/db', { default: fauxPrisma, prisma: fauxPrisma, prismaRead: fauxPrisma });
mockerModule('../../utils/cache', {
  cache: { get: async () => null, set: async () => undefined, delete: async () => undefined },
  getCachedGuild: async () => ({ language: 'fr' }),
});
mockerModule('../../services/system/planService', { setGuildPlan });
mockerModule('../../services/analytics/acquisitionService', { trackAcquisitionStep: () => undefined });

const { runAccessLifecycleCheck, resetReminderRetries } = await import('../../services/system/accessService.js');

/** Serveur avec un salon où le bot peut écrire, et un propriétaire joignable en MP. */
function serveur() {
  const envoisSalon = mock(async () => ({ id: 'message-1' }));
  const envoisMp = mock(async () => ({ id: 'mp-1' }));
  const salon = {
    id: 'salon-1',
    type: ChannelType.GuildText,
    isTextBased: () => true,
    permissionsFor: () => ({ has: (bit: bigint) => bit === PermissionFlagsBits.SendMessages }),
    send: envoisSalon,
  };
  const guild = {
    id: GUILD_ID,
    name: 'Serveur abonné',
    preferredLocale: 'fr',
    systemChannelId: 'salon-1',
    members: { me: {} },
    channels: {
      cache: {
        get: (id: string) => (id === 'salon-1' ? salon : undefined),
        find: (predicat: (c: unknown) => boolean) => (predicat(salon) ? salon : undefined),
      },
    },
    fetchOwner: async () => ({ send: envoisMp }),
  } as unknown as Guild;
  const client = { guilds: { fetch: mock(async () => guild) } } as unknown as Client;
  return { client, envoisSalon, envoisMp };
}

/** Abonnement mensuel dont la période s'est terminée (ou se termine) à `echeance`. */
function abonnement(echeance: Date, stripe: Partial<Pick<LigneGuild, 'stripeSubscriptionStatus' | 'stripeCancelAtPeriodEnd' | 'accessRemindersSent'>> = {}): LigneGuild {
  return {
    id: GUILD_ID,
    activated: true,
    activatedViaStaffLink: false,
    accessType: 'SUBSCRIPTION',
    accessExpiresAt: echeance,
    accessExpiredAt: null,
    accessDurationMinutes: 30 * JOUR_MIN,
    // Rappels de mi-parcours et J-3 déjà passés : seul le J-1 reste à venir.
    accessRemindersSent: [15 * JOUR_MIN, 3 * JOUR_MIN],
    stripeSubscriptionStatus: 'active',
    stripeCancelAtPeriodEnd: false,
    broadcastChannelId: null,
    logChannelId: null,
    ...stripe,
  };
}

const ilYa = (ms: number) => new Date(Date.now() - ms);
const dans = (ms: number) => new Date(Date.now() + ms);

beforeEach(() => {
  resetReminderRetries();
  ecritures.length = 0;
  setGuildPlan.mockClear();
});

describe('abonnement Stripe qui se renouvelle', () => {
  test('la fin de période franchie avant le webhook de renouvellement ne coupe pas l\'accès', async () => {
    ligne = abonnement(ilYa(HEURE));
    const { client, envoisSalon, envoisMp } = serveur();

    await runAccessLifecycleCheck(client);

    expect(setGuildPlan).not.toHaveBeenCalled();
    expect(ligne.accessExpiredAt).toBeNull();
    expect(envoisSalon).not.toHaveBeenCalled();
    expect(envoisMp).not.toHaveBeenCalled();
  });

  test('un statut past_due garde aussi sa marge le temps que Stripe relance le paiement', async () => {
    ligne = abonnement(ilYa(HEURE), { stripeSubscriptionStatus: 'past_due' });
    const { client } = serveur();

    await runAccessLifecycleCheck(client);

    expect(setGuildPlan).not.toHaveBeenCalled();
    expect(ligne.accessExpiredAt).toBeNull();
  });

  test('aucun rappel d\'expiration pour un abonnement qui se reconduit seul', async () => {
    // Moins d'un jour avant la fin de période : le palier J-1 est atteint.
    ligne = abonnement(dans(12 * HEURE));
    const { client, envoisSalon } = serveur();

    await runAccessLifecycleCheck(client);

    expect(envoisSalon).not.toHaveBeenCalled();
    expect(ecritures).toEqual([]);
  });

  test('témoin : passé 48 h sans renouvellement, l\'accès est coupé', async () => {
    ligne = abonnement(ilYa(49 * HEURE));
    const { client, envoisSalon } = serveur();

    await runAccessLifecycleCheck(client);

    expect(setGuildPlan).toHaveBeenCalledTimes(1);
    expect(setGuildPlan.mock.calls[0]?.[1]).toBe('FREE');
    expect(ligne.accessExpiredAt).toBeInstanceOf(Date);
    expect(envoisSalon).toHaveBeenCalledTimes(1);
  });
});

describe('abonnement qui s\'arrête vraiment', () => {
  test('résilié en fin de période : coupé dès l\'échéance', async () => {
    ligne = abonnement(ilYa(HEURE), { stripeCancelAtPeriodEnd: true });
    const { client } = serveur();

    await runAccessLifecycleCheck(client);

    expect(setGuildPlan).toHaveBeenCalledTimes(1);
    expect(ligne.accessExpiredAt).toBeInstanceOf(Date);
  });

  test('statut Stripe sans droit (canceled) : coupé dès l\'échéance', async () => {
    ligne = abonnement(ilYa(HEURE), { stripeSubscriptionStatus: 'canceled' });
    const { client } = serveur();

    await runAccessLifecycleCheck(client);

    expect(setGuildPlan).toHaveBeenCalledTimes(1);
    expect(ligne.accessExpiredAt).toBeInstanceOf(Date);
  });

  test('résilié en fin de période : le rappel J-1 part toujours', async () => {
    ligne = abonnement(dans(12 * HEURE), { stripeCancelAtPeriodEnd: true });
    const { client, envoisSalon } = serveur();

    await runAccessLifecycleCheck(client);

    expect(envoisSalon).toHaveBeenCalledTimes(1);
    expect(ligne.accessRemindersSent).toEqual([15 * JOUR_MIN, 3 * JOUR_MIN, JOUR_MIN]);
  });
});
