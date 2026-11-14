/**
 * Paliers de réputation : rôles donnés à un total de points reçus, annonce
 * optionnelle dans un salon.
 *
 * Un rôle que le bot ne peut pas donner (supprimé, géré par une intégration,
 * au-dessus du sien) est sauté et journalisé : un vote ne doit jamais échouer
 * pour un palier mal réglé. Le dashboard signale ces rôles sur l'onglet Paliers.
 */
import { EmbedBuilder, type Client, type Guild, type GuildMember, type Role } from 'discord.js';
import { reachedTiers, tiersAbove, type ReputationTier } from '@kotbo/shared';
import { COLORS } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { resolveGuildLocale, type BotLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { getReputationConfig } from './reputationService.js';

/** Gabarits de l'annonce dans la langue du serveur, trous compris, pour l'aperçu du dashboard. */
export function tierAnnouncementLabels(locale: BotLocale) {
  return {
    locale,
    title: m.b2_rep_tier_title({}, { locale }),
    body: m.b2_rep_tier_body({ user: '{user}', role: '{role}', threshold: '{threshold}' }, { locale }),
  };
}

/** Rôle que le bot peut réellement donner ou retirer, sinon `null`. */
export function manageableRole(guild: Pick<Guild, 'roles'>, roleId: string): Role | null {
  const role = guild.roles.cache.get(roleId);
  if (!role || role.managed || !role.editable) return null;
  return role;
}

/**
 * Donne les rôles de tous les paliers atteints que le membre n'a pas encore.
 * Pas seulement celui franchi par ce vote : un palier créé après coup, ou un
 * rôle retiré à la main, est rattrapé au remerciement suivant. Rend les
 * paliers réellement donnés.
 */
export async function grantReachedTiers(
  member: GuildMember,
  tiers: readonly ReputationTier[],
  total: number,
  reason: string,
): Promise<ReputationTier[]> {
  const granted: ReputationTier[] = [];
  for (const tier of reachedTiers(total, tiers)) {
    const role = manageableRole(member.guild, tier.roleId);
    if (!role) {
      logger.warn('Reputation', `Palier ${tier.threshold} : rôle ${tier.roleId} impossible à donner sur ${member.guild.id ?? '?'}`);
      continue;
    }
    if (member.roles.cache.has(role.id)) continue;
    try {
      await member.roles.add(role, reason);
      granted.push(tier);
    } catch (err) {
      logger.warn('Reputation', `Palier ${tier.threshold} : ajout du rôle ${role.id} refusé`, err);
    }
  }
  return granted;
}

/** Retire les rôles des paliers que le total n'atteint plus. */
export async function revokeLostTiers(
  member: GuildMember,
  tiers: readonly ReputationTier[],
  total: number,
  reason: string,
): Promise<void> {
  for (const tier of tiersAbove(total, tiers)) {
    if (!member.roles.cache.has(tier.roleId)) continue;
    const role = manageableRole(member.guild, tier.roleId);
    if (!role) continue;
    await member.roles.remove(role, reason).catch((err) => {
      logger.warn('Reputation', `Palier ${tier.threshold} : retrait du rôle ${role.id} refusé`, err);
    });
  }
}

async function fetchMember(client: Client, guildId: string, userId: string): Promise<GuildMember | null> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;
  return guild.members.fetch(userId).catch(() => null);
}

/** Annonce le plus haut des paliers donnés. Un seul message, même pour plusieurs paliers d'un coup. */
async function announce(member: GuildMember, channelId: string, tier: ReputationTier, locale: BotLocale): Promise<void> {
  const channel = member.guild.channels.cache.get(channelId);
  if (!channel?.isTextBased() || !channel.isSendable()) {
    logger.warn('Reputation', `Salon d'annonce ${channelId} introuvable ou fermé au bot sur ${member.guild.id}`);
    return;
  }
  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(m.b2_rep_tier_title({}, { locale }))
    .setDescription(m.b2_rep_tier_body({ user: `<@${member.id}>`, role: `<@&${tier.roleId}>`, threshold: tier.threshold }, { locale }));
  // Les mentions d'un embed ne notifient personne : rien à neutraliser de plus.
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch((err) => {
    logger.warn('Reputation', `Annonce de palier impossible dans ${channelId}`, err);
  });
}

/**
 * Après un gain : rôles des paliers atteints, puis annonce. Seul un palier
 * franchi par ce vote est annoncé : un rattrapage se fait en silence, sans quoi
 * le salon annoncerait comme nouveau un seuil dépassé depuis longtemps.
 * `announce: false` pour un geste du staff : le palier est donné sans message.
 */
export async function applyReputationGain(
  client: Client,
  guildId: string,
  userId: string,
  before: number,
  after: number,
  { announce: shouldAnnounce = true }: { announce?: boolean } = {},
): Promise<void> {
  const { tiers, announceChannelId } = await getReputationConfig(guildId);
  if (reachedTiers(after, tiers).length === 0) return;

  const member = await fetchMember(client, guildId, userId);
  if (!member) return;
  const locale = await resolveGuildLocale(guildId, member.guild.preferredLocale);
  const granted = await grantReachedTiers(member, tiers, after, m.b2_rep_tier_audit_reason({}, { locale }));
  const newlyCrossed = granted.filter((tier) => tier.threshold > before);
  if (shouldAnnounce && announceChannelId && newlyCrossed.length > 0) {
    await announce(member, announceChannelId, newlyCrossed[newlyCrossed.length - 1], locale);
  }
}

/** Après un retrait de vote : rôles des paliers que le membre ne remplit plus. */
export async function applyReputationLoss(client: Client, guildId: string, userId: string, total: number): Promise<void> {
  const { tiers } = await getReputationConfig(guildId);
  if (tiersAbove(total, tiers).length === 0) return;

  const member = await fetchMember(client, guildId, userId);
  if (!member) return;
  const locale = await resolveGuildLocale(guildId, member.guild.preferredLocale);
  await revokeLostTiers(member, tiers, total, m.b2_rep_tier_audit_reason({}, { locale }));
}
