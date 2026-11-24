/**
 * Envoi d'un embed vers le salon de logs d'un serveur.
 *
 * Extrait tel quel de `events/advancedLogs.ts` : le corps des fonctions n'a pas
 * change d'un caractere, seul le mot-cle `export` a ete ajoute a celles que le
 * fichier d'origine continue d'appeler.
 *
 * La raison du deplacement n'est pas cosmetique. `sendLogEmbed` est le seul
 * chemin qui respecte les reglages de journalisation — l'interrupteur par type
 * d'evenement, le salon dedie, les salons ignores — et une quinzaine de
 * services ecrivent pourtant en direct sur `logChannelId`, sans ces garde-fous.
 * Ils ne pouvaient pas faire autrement : `advancedLogs.ts` importe lui-meme
 * `dcDetectionService` et, par `memberCaseService`, `sanctionService`. Un import
 * en retour aurait referme un cycle.
 *
 * Ce module est une feuille, et c'est verifiable : ses seules dependances sont
 * `prisma`, `logger`, `cache`, `queueAuditLog` et discord.js. Aucune ne peut
 * remonter jusqu'ici. Le seul chemin qui en avait l'air — `auditLogger` vers
 * `api/shared/sharding.ts` vers `api/shared/core.ts`, qui reexporte bien
 * `sanctionService` — est neutralise : `sharding.ts` importe `core.ts` par un
 * `import type` complet, efface a la compilation. Rien de `core.ts` n'est donc
 * charge a l'execution par cette chaine.
 */

import { ActionRowBuilder, ButtonBuilder, EmbedBuilder, Guild, type SendableChannels } from 'discord.js';
import { routeLogEvent, type LogEventType } from '@kotbo/shared';
import { queueAuditLog } from './auditLogger.js';
import { cache, getCachedGuild } from './cache.js';
import prisma from './db.js';
import { logger } from './logger.js';
import { resoudreConfigLog, type EntreeConfigLog } from '../events/logEventConfig.js';
import { resoudreLogChannel, type EntreeLogChannel } from '../events/logChannelConfig.js';
import { resolveLogChannel } from './logChannel.js';

/**
 * Copie deliberee de la fonction homonyme d'`advancedLogs.ts`.
 *
 * `utils/embeds.ts` en exporte une version plus soignee — elle coupe a
 * `max - 3`, termine par trois points ASCII et evite de trancher un emoji
 * personnalise ou une paire de substitution. Elle ne produit donc PAS le meme
 * texte : sur n'importe quel contenu tronque, la longueur et le caractere final
 * different. S'en servir ici changerait le rendu de tous les champs coupes,
 * alors que cette extraction ne doit rien changer du tout. L'unification est un
 * travail a part, avec ses propres tests de rendu.
 */
function truncate(value: string, max = 1000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function stripLeadingEmoji(value: string): string {
  return value.replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

function embedSummary(embed: EmbedBuilder): { action: string; details: string } {
  const payload = embed.toJSON();
  const rawTitle = payload.title?.trim() || 'Événement Discord';
  const action = stripLeadingEmoji(rawTitle) || rawTitle;
  const description = payload.description?.trim() || '';
  const fieldPreview = (payload.fields ?? [])
    .slice(0, 4)
    .map((field) => {
      const fieldName = field.name.trim().toLowerCase();
      if (fieldName.startsWith('membre')) return `${field.value}`;
      return `${field.name}: ${field.value}`;
    })
    .join(' | ');

  const details = truncate([description, fieldPreview].filter(Boolean).join(' | '), 900) || 'Aucun détail.';
  return { action, details };
}

async function getGuildLogChannelId(guildId: string): Promise<string | null> {
  return resoudreLogChannel({
    // Le prefixe `guild:<id>:` n'est pas decoratif : c'est lui qui rend cette
    // entree visible de `cache.invalidateGuild`, donc effacee des qu'un
    // administrateur change son salon depuis le dashboard.
    cle: `guild:${guildId}:log_channel`,
    lireEnBase: async () => {
      const guild = await prisma.guild.findUnique({
        where: { id: guildId },
        select: {
          logChannelId: true,
          dashboardFeatureConfigs: {
            where: { featureKey: 'logs' },
            select: { enabled: true },
          },
        },
      });
      return {
        logChannelId: guild?.logChannelId ?? null,
        // Absence de ligne vaut « active » : le defaut du code doit coincider
        // avec celui du schema, sinon on refait le defaut precedent.
        logsEnabled: guild?.dashboardFeatureConfigs?.[0]?.enabled !== false,
      };
    },
    cacheGet: (cle) => cache.get<EntreeLogChannel>(cle),
    cacheSet: (cle, valeur) => cache.set(cle, valeur, 60),
  });
}

/**
 * Salons dont l'activité ne doit générer aucun log. La liste ne contient que
 * des salons : un fil suit l'exclusion de son parent, sans quoi la moitié des
 * messages d'un salon exclu continuerait d'être journalisée.
 */
export async function isLogIgnoredChannel(
  guild: Guild,
  channelIds: Array<string | null | undefined>,
): Promise<boolean> {
  const ids = channelIds.filter((id): id is string => !!id);
  if (ids.length === 0) return false;

  const guildConfig = await getCachedGuild(guild.id);
  const ignored = (guildConfig?.logIgnoredChannelIds ?? []) as string[];
  if (ignored.length === 0) return false;

  return ids.some((id) => {
    if (ignored.includes(id)) return true;
    const channel = guild.channels.cache.get(id);
    return !!channel?.isThread() && !!channel.parentId && ignored.includes(channel.parentId);
  });
}

function configEvenementLog(guildId: string, eventType: string) {
  return resoudreConfigLog({
    cle: `guild:${guildId}:log_event_config:${eventType}`,
    lireEnBase: () => prisma.guildLogEventConfig.findUnique({
      where: { guildId_eventType: { guildId, eventType } },
      select: { enabled: true, channelId: true },
    }),
    cacheGet: (cle) => cache.get<EntreeConfigLog>(cle),
    cacheSet: (cle, valeur) => cache.set(cle, valeur, 60),
  });
}

/** Pour éviter un travail coûteux (journal d'audit) dont le log serait jeté. */
export async function isLogEventEnabled(guildId: string, eventType: LogEventType): Promise<boolean> {
  return (await configEvenementLog(guildId, eventType)).journaliser;
}

export async function sendLogEmbed(
  guild: Guild,
  embed: EmbedBuilder,
  eventType: LogEventType,
  components?: Array<ActionRowBuilder<ButtonBuilder>>,
  executorTag?: string | null,
  sourceChannelIds?: Array<string | null | undefined>,
  /**
   * Ce que l'audit en base doit garder, quand le résumé de l'embed (description
   * et quatre premiers champs) en perdrait : passé tel quel à `queueAuditLog`.
   * Sans lui, rien ne change pour l'appelant.
   */
  audit?: { details?: string; channelId?: string | null },
): Promise<void> {
  if (sourceChannelIds && await isLogIgnoredChannel(guild, sourceChannelIds)) return;

  const summary = embedSummary(embed);

  // Pied de page « Action realisee par » : le titre dit ce qui s'est passe, le
  // pied de page dit par qui. Un embed qui porte deja son propre pied de page
  // garde le sien - il n'y a qu'un emplacement, et l'ecraser perdrait une
  // information au lieu d'en ajouter une.
  if (executorTag && !embed.toJSON().footer) {
    embed.setFooter({ text: `Action réalisée par ${executorTag}` });
  }

  // 1. Configuration du type d'evenement, cache compris.
  //
  // La resolution vit dans `logEventConfig.ts` : elle met la lecture de base et
  // le contenu du cache sous la meme forme, pour que le chemin froid et le
  // chemin chaud ne puissent plus decider differemment. Ils le faisaient : une
  // absence de ligne journalisait au premier passage puis etait relue comme un
  // refus pendant toute la duree de vie du cache.
  const decision = await configEvenementLog(guild.id, eventType);

  if (!decision.journaliser) return;

  // 2. Salon de destination : celui du type s'il en a un, sinon le salon de
  // logs du serveur.
  let channelId = decision.channelId;
  if (!channelId) {
    channelId = await getGuildLogChannelId(guild.id);
  }
  
  queueAuditLog({
    guildId: guild.id,
    channelId: audit?.channelId ?? channelId,
    user: executorTag ?? 'Système',
    action: summary.action,
    context: guild.name,
    module: 'Logs avancés',
    eventType: 'Discord',
    details: audit?.details ?? summary.details,
  });

  if (!channelId) return;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  await channel.send({ embeds: [embed], components, allowedMentions: { parse: [] } }).catch((error) => {
    logger.warn('Logs', `Impossible d'envoyer un log dans ${guild.id}: ${String(error)}`);
  });
}

export interface LogRouteOptions {
  /**
   * Salon propre au module (salon d'alerte anti-spam, de Vision, du captcha…).
   * Prioritaire quand il est rempli ; s'il est introuvable, on retombe sur le
   * routage normal, comme le faisaient déjà ces modules avant d'être routés.
   */
  moduleChannelId?: string | null;
  /** Dernier recours, après le salon de logs du serveur. */
  fallbackChannelId?: string | null;
}

/**
 * Salon où publier un journal d'un module, ou `null` s'il ne doit pas partir.
 *
 * Le pendant de `sendLogEmbed` pour la vingtaine de services qui écrivaient en
 * direct sur `logChannelId` : même réglage par type (activé, salon dédié),
 * mêmes caches, même invalidation depuis le dashboard. L'ordre de priorité est
 * celui de `routeLogEvent`, partagé avec le dashboard pour que la page affiche
 * exactement le salon où le bot écrira.
 *
 * Ces services ne suivent volontairement pas l'interrupteur global du module
 * « logs » ni les salons ignorés : ce sont des alertes de sécurité et de
 * modération, et elles partaient déjà sans ces deux garde-fous. Seul le
 * réglage par type, que l'administrateur choisit un par un, peut les couper.
 */
export async function resolveEventLogChannelId(
  guildId: string,
  eventType: LogEventType,
  options: LogRouteOptions = {},
): Promise<string | null> {
  const decision = await configEvenementLog(guildId, eventType);
  if (!decision.journaliser) return null;

  const needsGuildChannel = !options.moduleChannelId && !decision.channelId;
  const guildConfig = needsGuildChannel ? await getCachedGuild(guildId) : null;

  return routeLogEvent({
    enabled: true,
    moduleChannelId: options.moduleChannelId,
    eventChannelId: decision.channelId,
    guildLogChannelId: guildConfig?.logChannelId ?? null,
    fallbackChannelId: options.fallbackChannelId,
  });
}

/** Comme `resolveEventLogChannelId`, mais rend le salon prêt à l'envoi. */
export async function resolveEventLogChannel(
  guild: Guild,
  eventType: LogEventType,
  label: string,
  options: LogRouteOptions = {},
): Promise<SendableChannels | null> {
  if (options.moduleChannelId) {
    const enabled = (await configEvenementLog(guild.id, eventType)).journaliser;
    if (!enabled) return null;
    const moduleChannel = await resolveLogChannel(guild, options.moduleChannelId, label);
    if (moduleChannel) return moduleChannel;
  }
  const channelId = await resolveEventLogChannelId(guild.id, eventType, {
    fallbackChannelId: options.fallbackChannelId,
  });
  return resolveLogChannel(guild, channelId, label);
}
