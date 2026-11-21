/**
 * Auto-rôles « identité de serveur » configurés depuis le module Annonces.
 *
 * Deux détections indépendantes, qui peuvent viser le même rôle ou deux rôles
 * distincts :
 *
 *  1. Tag du serveur - le tag identitaire officiel affiché à côté du pseudo
 *     (celui débloqué par les boosts). Exposé par l'API via `user.primary_guild`
 *     et mappé par discord.js sur `user.primaryGuild`. Aucun motif n'est cherché
 *     dans le pseudo : la détection est binaire et fiable.
 *
 *  2. Mot-clé dans la présence - statut personnalisé et/ou texte de l'activité
 *     en cours. Limite de l'API Discord : la section « À propos de moi » d'un
 *     profil n'est PAS exposée aux bots, seul le statut/l'activité est lisible.
 *
 * Les deux détections sont fusionnées par rôle (OU logique) avant d'appliquer le
 * moindre changement : si elles pointent le même rôle, l'une ne défait pas
 * l'autre.
 */

import { ActivityType, PermissionFlagsBits, type Activity, type Client, type GuildMember } from 'discord.js';
import type { WelcomeConfig } from '@prisma/client';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { memberDisplaysGuildTag } from '../moderation/tagRoleService.js';
import { hasOptedOutOfPresenceTracking } from '../core/presencePrivacyService.js';

const CONFIG_TTL_SECONDS = 300;

function cacheKey(guildId: string): string {
  return `guild:${guildId}:welcome-autorole`;
}

type AutoRoleConfig = Pick<
  WelcomeConfig,
  | 'tagAutoRoleEnabled'
  | 'tagAutoRoleId'
  | 'statusScanEnabled'
  | 'statusScanKeyword'
  | 'statusScanRoleId'
  | 'statusScanScope'
>;

/**
 * Marqueur mis en cache pour une guilde sans config : `null` n'est pas
 * stockable, et sans ce marqueur chaque changement de présence d'un serveur
 * sans config relançait la requête (la plus fréquente du bot).
 */
type NoAutoRoleConfig = { __none: true };

function isNoConfigMarker(value: unknown): value is NoAutoRoleConfig {
  return typeof value === 'object' && value !== null && (value as { __none?: unknown }).__none === true;
}

/** Config d'auto-rôle d'une guilde, ou null si la guilde n'en a aucune. */
export async function getAutoRoleConfig(guildId: string): Promise<AutoRoleConfig | null> {
  const cached = await cache.get<AutoRoleConfig | NoAutoRoleConfig>(cacheKey(guildId));
  if (isNoConfigMarker(cached)) return null;
  if (cached) return cached;

  const config = await prisma.welcomeConfig.findUnique({
    where: { guildId },
    select: {
      tagAutoRoleEnabled: true,
      tagAutoRoleId: true,
      statusScanEnabled: true,
      statusScanKeyword: true,
      statusScanRoleId: true,
      statusScanScope: true,
    },
  }).catch((err) => {
    logger.error('ServerTagRole', `Lecture de la config d'auto-rôle de ${guildId} impossible`, err);
    return undefined;
  });
  // Erreur de lecture : pas de mise en cache, la prochaine présence réessaiera.
  if (config === undefined) return null;
  if (config === null) {
    await cache.set(cacheKey(guildId), { __none: true } satisfies NoAutoRoleConfig, CONFIG_TTL_SECONDS);
    return null;
  }

  await cache.set(cacheKey(guildId), config, CONFIG_TTL_SECONDS);
  return config;
}

/** À appeler après toute écriture de la config depuis le dashboard. */
export async function invalidateAutoRoleCache(guildId: string): Promise<void> {
  await cache.delete(cacheKey(guildId));
}

/** true si au moins une des deux détections est active et exploitable. */
export function isAutoRoleActive(config: AutoRoleConfig | null): boolean {
  if (!config) return false;
  const tagActive = config.tagAutoRoleEnabled && !!config.tagAutoRoleId;
  const statusActive =
    config.statusScanEnabled &&
    !!config.statusScanKeyword.trim() &&
    !!(config.statusScanRoleId || config.tagAutoRoleId);
  return tagActive || statusActive;
}

/**
 * Concatène les textes de présence lisibles selon la portée choisie.
 * STATUS = statut personnalisé, ACTIVITY = nom/détails/état de l'activité.
 *
 * Prend les activités et non le membre : sur `presenceUpdate`, l'ancienne et la
 * nouvelle présence pointent le même GuildMember en cache, donc lire
 * `member.presence` renverrait deux fois le nouvel état.
 */
export function collectPresenceText(
  activities: readonly Activity[] | undefined,
  scope: string,
): string {
  if (!activities || activities.length === 0) return '';

  const wantStatus = scope === 'STATUS' || scope === 'BOTH';
  const wantActivity = scope === 'ACTIVITY' || scope === 'BOTH';
  const parts: string[] = [];

  for (const activity of activities) {
    if (activity.type === ActivityType.Custom) {
      if (wantStatus) parts.push(activity.state ?? '', activity.name ?? '');
      continue;
    }
    if (wantActivity) parts.push(activity.name ?? '', activity.details ?? '', activity.state ?? '');
  }

  return parts.filter(Boolean).join(' ');
}

function matchesKeyword(text: string, keyword: string): boolean {
  if (!text || !keyword.trim()) return false;
  return text.toLowerCase().includes(keyword.trim().toLowerCase());
}

/**
 * Applique les auto-rôles d'identité à un membre. Retourne true si au moins un
 * rôle a été ajouté ou retiré.
 */
export async function syncMemberAutoRoles(
  member: GuildMember,
  config?: AutoRoleConfig | null,
): Promise<boolean> {
  if (member.user.bot) return false;

  const cfg = config ?? (await getAutoRoleConfig(member.guild.id));
  if (!isAutoRoleActive(cfg) || !cfg) return false;

  const me = member.guild.members.me ?? (await member.guild.members.fetchMe().catch(() => null));
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) return false;

  // Fusion par rôle : deux détections peuvent viser le même rôle, auquel cas
  // il suffit que l'une des deux soit vraie pour que le membre le conserve.
  const targets = new Map<string, boolean>();

  if (cfg.tagAutoRoleEnabled && cfg.tagAutoRoleId) {
    targets.set(cfg.tagAutoRoleId, memberDisplaysGuildTag(member));
  }

  if (cfg.statusScanEnabled && cfg.statusScanKeyword.trim()) {
    const roleId = cfg.statusScanRoleId || cfg.tagAutoRoleId;
    if (roleId) {
      // Un membre qui a coupé le suivi de sa présence (`/opt-out presence`) n'a
      // pas son statut lu : la détection vaut faux, donc le rôle déjà posé lui
      // est retiré au prochain passage. La détection du tag, elle, ne lit pas la
      // présence et continue de s'appliquer.
      const optedOut = await hasOptedOutOfPresenceTracking(member.guild.id, member.id);
      const matched =
        !optedOut &&
        matchesKeyword(
          collectPresenceText(member.presence?.activities, cfg.statusScanScope),
          cfg.statusScanKeyword,
        );
      targets.set(roleId, (targets.get(roleId) ?? false) || matched);
    }
  }

  let changed = false;
  for (const [roleId, shouldHave] of targets) {
    const role = member.guild.roles.cache.get(roleId);
    // Rôle supprimé, ou trop haut dans la hiérarchie pour que le bot y touche.
    if (!role || role.managed || role.position >= me.roles.highest.position) continue;

    const hasRole = member.roles.cache.has(roleId);
    if (shouldHave === hasRole) continue;

    try {
      if (shouldHave) {
        await member.roles.add(roleId, "Auto-rôle : identité de serveur détectée");
      } else {
        await member.roles.remove(roleId, "Auto-rôle : identité de serveur retirée");
      }
      changed = true;
    } catch (err) {
      logger.error('ServerTagRole', `Sync du rôle ${roleId} impossible pour ${member.id}`, err);
    }
  }

  return changed;
}

/** Rescan complet d'une guilde (bouton dashboard). */
export async function rescanGuildAutoRoles(
  client: Client,
  guildId: string,
): Promise<{ scanned: number; changed: number } | null> {
  const config = await getAutoRoleConfig(guildId);
  if (!isAutoRoleActive(config)) return null;

  const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return null;

  // Les présences ne remontent pas avec un fetch classique : il faut les
  // demander explicitement pour que le scan de statut ait matière à travailler.
  const withPresences = !!config?.statusScanEnabled;
  const members = await guild.members.fetch({ withPresences }).catch(() => null);
  if (!members) return null;

  let scanned = 0;
  let changed = 0;
  for (const member of members.values()) {
    if (member.user.bot) continue;
    scanned++;
    if (await syncMemberAutoRoles(member, config)) changed++;
  }
  return { scanned, changed };
}
