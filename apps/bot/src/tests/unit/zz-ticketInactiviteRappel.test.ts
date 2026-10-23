/**
 * Le rappel d'inactivité qui n'est jamais parti ne doit pas être enregistré
 * comme délivré.
 *
 * `checkTicketInactivity` avalait l'échec d'envoi (`.catch(() => null)`) puis
 * posait `inactivityAlertSent: true` sans condition, et annonçait un succès
 * dans le journal. Ce n'est pas une perte de log : c'est une corruption d'état.
 * La requête qui alimente le cron ne retient que les tickets dont le drapeau
 * est `false` — un rappel refusé sortait donc le ticket de la file pour de bon.
 *
 * Le seul réarmement (`modules/tickets.module.ts`) attend un message du
 * créateur, c'est-à-dire exactement ce que le rappel jamais reçu ne l'a pas
 * poussé à écrire.
 *
 * Préfixe `zz-` : ce fichier pose un `mock.module` sur `utils/db`, `i18n` et
 * `moduleGate`, et `bun test --isolate` n'isole pas les `mock.module` — il doit
 * charger en dernier pour ne pas servir ces doublures aux autres fichiers.
 * `logger`, lui, est un objet exporté mutable : on remplace sa méthode le temps
 * du cas et on la remet, sans toucher au registre de modules.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { TextChannel, type Client } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

const GUILD_ID = 'guilde-1';
const TICKET_ID = 'ticket-1';
const CHANNEL_ID = 'salon-ticket';
const CREATOR_ID = 'membre-1';

let ticketRow: Record<string, unknown>;
const mises = new Map<string, Record<string, unknown>>();

const fauxPrisma = {
  guild: {
    findMany: mock(async () => [
      { id: GUILD_ID, ticketInactivityHours: 24, ticketInactivityMessage: 'Toujours là {user} ?' },
    ]),
  },
  ticket: {
    findMany: mock(async () => [ticketRow]),
    update: mock(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      mises.set(where.id, data);
      Object.assign(ticketRow, data);
      return ticketRow;
    }),
  },
};

// `completeModuleMock` lit les exports reels du fichier source sans l'evaluer,
// et complete la doublure : un mock partiel ferait disparaitre les autres
// exports pour TOUS les fichiers de test charges ensuite, qui echoueraient au
// chargement sur un « Export named 'x' not found », loin du test fautif. C'est
// exactement ce qui vient d'arriver avec `prismaRead` et `getEffectiveLocale`.
function mockerModule(relatif: string, overrides: Record<string, unknown>): void {
  const source = path.resolve(import.meta.dir, `${relatif}.ts`);
  for (const suffixe of ['.ts', '.js']) {
    mock.module(path.resolve(import.meta.dir, `${relatif}${suffixe}`), () =>
      completeModuleMock(source, overrides));
  }
}

mockerModule('../../utils/db', { default: fauxPrisma, prisma: fauxPrisma, prismaRead: fauxPrisma });
// Pas de doublure sur `i18n` : d'autres modules charges par `ticketService`
// appellent ses fonctions a l'import, et une doublure partielle les ferait
// echouer. On coupe une marche plus bas — `resolveGuildLocale` ne fait qu'un
// `getCachedGuild`, dont la vraie implementation ouvrirait Redis.
mockerModule('../../utils/cache', { getCachedGuild: mock(async () => ({ language: 'fr' })) });
mockerModule('../../services/core/moduleGate', { isModuleEnabled: mock(async () => true) });

const { checkTicketInactivity } = await import('../../services/features/ticketService.js');
const { logger } = await import('../../utils/logger.js');

/**
 * Le salon est posé sur `TextChannel.prototype` À DESSEIN : la fonction filtre
 * par `instanceof TextChannel`, et un objet nu échouerait ce filtre — le test
 * passerait alors sans jamais atteindre l'envoi, donc sans rien prouver.
 */
function salonDeTicket(envoiEchoue: boolean | Error) {
  const send = mock(async () => {
    if (envoiEchoue instanceof Error) throw envoiEchoue;
    if (envoiEchoue) throw new Error('Missing Permissions');
    return { id: 'message-1' };
  });
  const salon = Object.create(TextChannel.prototype) as Record<string, unknown>;
  salon.id = CHANNEL_ID;
  salon.send = send;
  salon.messages = {
    // Dernier message du staff, très ancien : c'est ce qui rend le rappel dû.
    fetch: mock(async () => ({
      first: () => ({ author: { id: 'staff-1' }, createdTimestamp: 0 }),
    })),
  };
  return { salon, send };
}

function clientAvec(salon: unknown): Client {
  return {
    channels: { fetch: mock(async () => salon) },
    guilds: { cache: { get: () => undefined } },
  } as unknown as Client;
}

/** Refus Discord tel que discord.js le leve : un message et un `code` numerique. */
function refusDiscord(code: number): Error {
  return Object.assign(new Error(code === 50001 ? 'Missing Access' : 'Missing Permissions'), { code, status: 403 });
}

const erreurOrigine = logger.error;
const infoOrigine = logger.info;
const warnOrigine = logger.warn;
let erreurs: string[] = [];
let infos: string[] = [];
let avertissements: string[] = [];

beforeEach(() => {
  erreurs = [];
  infos = [];
  avertissements = [];
  mises.clear();
  ticketRow = {
    id: TICKET_ID,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    userId: CREATOR_ID,
    status: 'OPEN',
    createdAt: new Date(0),
    inactivityAlertSent: false,
  };
  logger.error = (tag: string, ...args: unknown[]) => {
    erreurs.push(`${tag} ${args.map((a) => String(a)).join(' ')}`);
  };
  logger.info = (tag: string, ...args: unknown[]) => {
    infos.push(`${tag} ${args.map((a) => String(a)).join(' ')}`);
  };
  logger.warn = (tag: string, ...args: unknown[]) => {
    avertissements.push(`${tag} ${args.map((a) => String(a)).join(' ')}`);
  };
});

afterEach(() => {
  logger.error = erreurOrigine;
  logger.info = infoOrigine;
  logger.warn = warnOrigine;
});

describe('checkTicketInactivity', () => {
  test("un rappel refusé ne marque pas le ticket comme relancé, et laisse une trace", async () => {
    const { salon, send } = salonDeTicket(true);

    await checkTicketInactivity(clientAvec(salon));

    expect(send).toHaveBeenCalledTimes(1);
    // Le cœur : le drapeau reste `false`, donc le ticket reste dans la file du
    // cron et sera relancé au prochain passage.
    expect(ticketRow.inactivityAlertSent).toBe(false);
    expect(mises.has(TICKET_ID)).toBe(false);
    // Et l'échec est visible : sans cette trace, la panne serait doublement
    // silencieuse — ni rappel, ni explication.
    expect(erreurs).toHaveLength(1);
    expect(erreurs[0]).toContain(TICKET_ID);
    // Le journal ne doit surtout pas annoncer un envoi qui n'a pas eu lieu.
    expect(infos.some((ligne) => ligne.includes('envoyée'))).toBe(false);
  });

  test("témoin : un rappel délivré marque bien le ticket", async () => {
    // Ce cas passe des deux côtés — il ne garde rien, il prouve que le montage
    // sait aussi rendre vert. Sans lui, le rouge du cas précédent pourrait
    // venir d'un faux salon que la fonction refuse avant même d'envoyer.
    const { salon, send } = salonDeTicket(false);

    await checkTicketInactivity(clientAvec(salon));

    expect(send).toHaveBeenCalledTimes(1);
    expect(ticketRow.inactivityAlertSent).toBe(true);
    expect(mises.get(TICKET_ID)).toEqual({ inactivityAlertSent: true });
    expect(erreurs).toEqual([]);
  });

  test("salon fermé au bot : « Missing Access » signalé une fois, sans erreur à chaque tour", async () => {
    // Ticket distinct : le registre des salons deja signales vit dans le module.
    ticketRow.id = 'ticket-ferme';
    const { salon, send } = salonDeTicket(refusDiscord(50001));

    await checkTicketInactivity(clientAvec(salon));
    await checkTicketInactivity(clientAvec(salon));

    // Le ticket reste dans la file : il sera relancé quand l'accès reviendra.
    expect(ticketRow.inactivityAlertSent).toBe(false);
    // Un 403 de droits n'est pas une panne du bot : pas d'erreur, et un seul
    // avertissement pour deux tours au lieu d'une ligne rouge à chaque passage.
    expect(erreurs).toEqual([]);
    expect(avertissements).toHaveLength(1);
    expect(avertissements[0]).toContain('ticket-ferme');
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("droits manquants vus d'avance : rien n'est tenté dans le salon", async () => {
    ticketRow.id = 'ticket-sans-droit';
    const { salon, send } = salonDeTicket(false);
    const fetchMessages = (salon.messages as { fetch: ReturnType<typeof mock> }).fetch;
    salon.guild = { members: { me: { id: 'kotbo' } } };
    salon.permissionsFor = () => ({ missing: () => ['ViewChannel', 'SendMessages'] });

    await checkTicketInactivity(clientAvec(salon));

    expect(send).not.toHaveBeenCalled();
    expect(fetchMessages).not.toHaveBeenCalled();
    expect(ticketRow.inactivityAlertSent).toBe(false);
    expect(erreurs).toEqual([]);
    expect(avertissements).toHaveLength(1);
  });
});
