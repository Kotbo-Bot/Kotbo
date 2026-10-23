/**
 * Limites Discord qui empechent de creer l'espace d'un ticket.
 *
 * Un serveur plafonne a 500 salons, une categorie a 50, et un serveur a 1000
 * fils actifs. Ces refus ne disent rien de faux sur la demande : elle passera
 * des qu'une place se liberera. Les reconnaitre permet de mettre le ticket en
 * file d'attente au lieu de renvoyer une erreur au membre.
 *
 * Module sans dependance au reste du service pour rester testable seul.
 */
import { DiscordAPIError } from 'discord.js';

export type TicketCapacityLimit = 'GUILD_CHANNELS' | 'CATEGORY_CHANNELS' | 'ACTIVE_THREADS';

/** 30013 : « Maximum number of guild channels reached (500) ». */
const DISCORD_MAX_GUILD_CHANNELS = 30013;
/** 160006 : « Maximum number of active threads reached ». */
const DISCORD_MAX_ACTIVE_THREADS = 160006;
/**
 * Une categorie pleine ne porte pas de code a elle : Discord repond 50035
 * (corps invalide) et nomme la cause dans le detail du champ `parent_id`.
 */
const DISCORD_INVALID_FORM_BODY = 50035;
const CATEGORY_FULL_MARKER = 'CHANNEL_PARENT_MAX_CHANNELS';

export function classifyTicketCapacityError(err: unknown): TicketCapacityLimit | null {
  if (!(err instanceof DiscordAPIError)) return null;
  if (err.code === DISCORD_MAX_GUILD_CHANNELS) return 'GUILD_CHANNELS';
  if (err.code === DISCORD_MAX_ACTIVE_THREADS) return 'ACTIVE_THREADS';
  if (err.code === DISCORD_INVALID_FORM_BODY) {
    const detail = `${err.message} ${JSON.stringify(err.rawError ?? {})}`;
    if (detail.includes(CATEGORY_FULL_MARKER)) return 'CATEGORY_CHANNELS';
  }
  return null;
}

/**
 * Cle de la limite qui bloque un ticket. Deux tickets de meme cle attendent la
 * meme place : quand l'un echoue, inutile de retenter l'autre dans la foulee.
 */
export function ticketCapacityScope(limit: TicketCapacityLimit, ids: { guildId: string; categoryId?: string | null }): string {
  if (limit === 'CATEGORY_CHANNELS' && ids.categoryId) return `CATEGORY_CHANNELS:${ids.categoryId}`;
  if (limit === 'ACTIVE_THREADS') return `ACTIVE_THREADS:${ids.guildId}`;
  return `GUILD_CHANNELS:${ids.guildId}`;
}

/** Ce que la limite empeche de creer, pour les messages au membre. */
export function describeTicketCapacityLimit(limit: TicketCapacityLimit): string {
  switch (limit) {
    case 'GUILD_CHANNELS': return 'son nombre maximal de salons (500)';
    case 'CATEGORY_CHANNELS': return 'le nombre maximal de salons de la catégorie des tickets (50)';
    case 'ACTIVE_THREADS': return 'son nombre maximal de fils actifs';
  }
}

/**
 * Levee par la creation quand une limite Discord bloque. `ticketId` est
 * renseigne quand la ligne du ticket existe deja en base (mode fil ou MP, ou
 * demande validee) : la file la reprend au lieu d'en ouvrir une seconde.
 */
export class TicketCapacityError extends Error {
  constructor(
    readonly limit: TicketCapacityLimit,
    readonly scope: string,
    readonly ticketId: string | null,
  ) {
    super(`❌ Le serveur a atteint ${describeTicketCapacityLimit(limit)} : impossible de créer le ticket pour le moment.`);
    this.name = 'TicketCapacityError';
  }
}

/**
 * Execute la creation Discord et traduit un refus de capacite en
 * `TicketCapacityError`. Les autres erreurs passent telles quelles.
 */
export async function guardTicketCapacity<T>(
  create: () => Promise<T>,
  context: { guildId: string; categoryId?: string | null; ticketId: string | null },
): Promise<T> {
  try {
    return await create();
  } catch (err) {
    const limit = classifyTicketCapacityError(err);
    if (!limit) throw err;
    throw new TicketCapacityError(limit, ticketCapacityScope(limit, context), context.ticketId);
  }
}
