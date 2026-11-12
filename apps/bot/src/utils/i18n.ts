import * as m from '../lib/paraglide/messages.js';
import { getCachedGuild } from './cache.js';

export type BotLocale = 'fr' | 'en';

/** Repli ultime quand aucune information de langue n'est exploitable. */
export const FALLBACK_LOCALE: BotLocale = 'en';

/**
 * Normalise un code de locale Discord (`fr`, `fr-FR`, `en-GB`, `es-ES`…) vers
 * une locale supportee par le bot. Tout ce qui n'est pas francais retombe sur
 * l'anglais, qui est notre langue de repli.
 */
export function normalizeLocale(code: string | null | undefined): BotLocale | null {
  if (!code) return null;
  return code.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

// `guildLocale` vaut `null` hors serveur cote discord.js (et `locale` est un
// enum Locale, compatible string) : le type doit accepter les deux.
export function getLocale(interaction: { locale?: string | null; guildLocale?: string | null }): BotLocale {
  return normalizeLocale(interaction.locale ?? interaction.guildLocale) ?? FALLBACK_LOCALE;
}

/**
 * Resout la langue des reponses du bot pour un serveur, selon la cascade :
 *
 *  1. choix explicite d'un admin (`Guild.language`, via `/languages lang` ou le
 *     dashboard) - prioritaire ;
 *  2. sinon, la langue declaree du serveur Discord (`preferredLocale`, exposee
 *     sur les interactions via `guildLocale`) ;
 *  3. sinon, repli sur l'anglais.
 *
 * `Guild.language === null` signifie « automatique » : on laisse la cascade
 * descendre au palier 2.
 */
export async function resolveGuildLocale(
  guildId: string | null | undefined,
  discordGuildLocale?: string | null,
): Promise<BotLocale> {
  if (guildId) {
    const guild = await getCachedGuild(guildId);
    const explicit = normalizeLocale(
      guild?.language === 'fr' || guild?.language === 'en' ? guild.language : null,
    );
    if (explicit) return explicit;
  }
  return normalizeLocale(discordGuildLocale) ?? FALLBACK_LOCALE;
}

/**
 * Indique si le serveur suit la detection automatique (`auto`) ou un choix
 * explicite (`manual`), et quelle langue en decoule.
 */
export async function getGuildLanguageState(
  guildId: string | null | undefined,
  discordGuildLocale?: string | null,
): Promise<{ mode: 'manual' | 'auto'; locale: BotLocale; detected: BotLocale | null }> {
  const detected = normalizeLocale(discordGuildLocale);
  if (guildId) {
    const guild = await getCachedGuild(guildId);
    if (guild?.language === 'fr' || guild?.language === 'en') {
      return { mode: 'manual', locale: guild.language, detected };
    }
  }
  return { mode: 'auto', locale: detected ?? FALLBACK_LOCALE, detected };
}

/**
 * Langue a utiliser pour repondre a une interaction.
 *
 * Les reponses du bot suivent la langue du **serveur** (cascade ci-dessus), pas
 * celle du client Discord de l'utilisateur : seuls les noms et descriptions des
 * commandes slash sont localises par utilisateur, via `getCommandMetadata`.
 */
export async function getEffectiveLocale(interaction: {
  locale?: string | null;
  guildLocale?: string | null;
  guildId?: string | null;
}): Promise<BotLocale> {
  if (!interaction.guildId) {
    // En MP il n'y a pas de serveur : on suit le client de l'utilisateur.
    return getLocale(interaction);
  }
  return resolveGuildLocale(interaction.guildId, interaction.guildLocale);
}

export function getCommandMetadata(keyPrefix: string) {
  const enName = (m as any)[`${keyPrefix}_name`]?.({}, { locale: 'en' }) || keyPrefix;
  const frName = (m as any)[`${keyPrefix}_name`]?.({}, { locale: 'fr' }) || keyPrefix;
  const enDesc = (m as any)[`${keyPrefix}_description`]?.({}, { locale: 'en' }) || 'No description';
  const frDesc = (m as any)[`${keyPrefix}_description`]?.({}, { locale: 'fr' }) || 'Pas de description';

  return {
    name: enName,
    nameLocalizations: {
      fr: frName,
    },
    description: enDesc,
    descriptionLocalizations: {
      fr: frDesc,
    },
  };
}

interface LocalizableBuilder {
  setName(name: string): this;
  setNameLocalizations(map: Record<string, string>): this;
  setDescription(description: string): this;
  setDescriptionLocalizations(map: Record<string, string>): this;
}

/**
 * Nom et description fr/en d'une commande, sous-commande ou option, lus dans
 * les clés `${keyPrefix}_name` et `${keyPrefix}_description`. Le nom anglais
 * est le nom de base : c'est lui que l'interaction renvoie au code.
 */
export function localized<T extends LocalizableBuilder>(builder: T, keyPrefix: string): T {
  const meta = getCommandMetadata(keyPrefix);
  return builder
    .setName(meta.name)
    .setNameLocalizations(meta.nameLocalizations)
    .setDescription(meta.description)
    .setDescriptionLocalizations(meta.descriptionLocalizations);
}

/** Choix d'option fr/en lu dans la clé `key`. */
export function localizedChoice<V extends string | number>(key: string, value: V) {
  const msg = (m as any)[key];
  return { name: msg({}, { locale: 'en' }) as string, name_localizations: { fr: msg({}, { locale: 'fr' }) as string }, value };
}
