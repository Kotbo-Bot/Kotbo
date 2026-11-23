import type { Client, GuildMember } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { receivedTotal } from '../community/reputationService.js';
import {
  periodStartKey,
  type ConditionResolvers,
  type ConditionSubject,
  type PeriodStat,
} from './giveawayConditions.js';

/**
 * Branchement base de données et Discord du moteur de conditions : lit ce que
 * Kotbo sait déjà du membre. Toute lecture qui échoue rend `null` (donnée
 * inconnue, le membre passe) : une panne ne doit pas fermer un concours.
 */

const safe = async <T>(label: string, read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch (err) {
    logger.warn('GiveawayConditions', `${label} illisible : ${err instanceof Error ? err.message : err}`);
    return null;
  }
};

/** Vote Top.gg encore valide, ou `null` si le jeton n'est pas configuré ou l'API injoignable. */
async function topggVoted(botId: string, userId: string): Promise<boolean | null> {
  const token = process.env.TOPGG_API_TOKEN?.trim();
  if (!token) return null;
  const v0 = process.env.TOPGG_API_VERSION?.trim().toLowerCase() === 'v0';
  const res = await fetch(
    v0
      ? `https://top.gg/api/bots/${botId}/check?userId=${userId}`
      : `https://top.gg/api/v1/projects/@me/votes/${userId}?source=discord`,
    { headers: { Authorization: v0 ? token : `Bearer ${token}` }, signal: AbortSignal.timeout(4000) },
  );
  if (!v0 && res.status === 404) return false; // v1 : pas de vote actif
  if (!res.ok) return null;
  const body = (await res.json()) as { voted?: number; expires_at?: string };
  if (v0) return body.voted === 1;
  return !body.expires_at || new Date(body.expires_at).getTime() > Date.now();
}

export function buildConditionResolvers(client: Client, guildId: string, userId: string): ConditionResolvers {
  return {
    periodStat: (stat: PeriodStat, period, since) => safe('statistique', async () => {
      const from = periodStartKey(period, since);
      const field = stat === 'messages' ? 'messagesCount' : 'voiceMinutes';
      const sum = await prisma.memberDailyStat.aggregate({
        where: { guildId, userId, ...(from ? { dateKey: { gte: from } } : {}) },
        _sum: { [field]: true },
      });
      return (sum._sum as Record<string, number | null>)[field] ?? 0;
    }),

    flatStat: (stat) => safe(stat, async () => {
      switch (stat) {
        case 'invites':
          // Seuls les invités encore présents comptent : un aller-retour ne rapporte rien.
          return prisma.memberInvite.count({ where: { guildId, inviterId: userId, leftAt: null } });
        case 'level':
        case 'xp': {
          const row = await prisma.memberLevel.findUnique({
            where: { guildId_userId: { guildId, userId } },
            select: { level: true, xp: true },
          });
          return row?.[stat] ?? 0;
        }
        case 'coins':
          return (await prisma.rpgProfile.findUnique({
            where: { guildId_userId: { guildId, userId } },
            select: { balance: true },
          }))?.balance ?? 0;
        case 'reputation':
          return receivedTotal(guildId, userId, prisma);
      }
    }),

    hasVotedTopgg: () => safe('vote Top.gg', () => topggVoted(client.user?.id ?? '', userId)),

    isInGuild: (otherGuildId) => safe('autre serveur', async () => {
      const guild = client.guilds.cache.get(otherGuildId);
      // Le bot n'y est pas : impossible de vérifier, on ne pénalise personne.
      if (!guild) return null;
      return (await guild.members.fetch(userId).catch(() => null)) !== null;
    }),
  };
}

/** Données du membre au clic. `member` nul (parti, introuvable) laisse tout inconnu. */
export function buildConditionSubject(
  base: { userId: string; guildId: string; roleIds: string[]; accountCreatedAt: Date | null; joinedAt: Date | null },
  member: GuildMember | null,
  startedAt: Date,
): ConditionSubject {
  const presence = member?.presence;
  return {
    ...base,
    isBooster: member ? member.premiumSince !== null : null,
    // Avatar par défaut = pas d'avatar choisi ; la bannière demande un fetch de l'utilisateur.
    hasAvatar: member ? member.user.avatar !== null : null,
    hasBanner: member ? (member.user.banner === undefined ? null : member.user.banner !== null) : null,
    // Le tag affiché doit être celui de CE serveur, pas d'un autre.
    hasServerTag: member
      ? member.user.primaryGuild?.identityEnabled === true && member.user.primaryGuild.identityGuildId === base.guildId
      : null,
    nickname: member ? member.displayName : null,
    // Sans l'intent Presences, `presence` est toujours nul : statut non vérifiable.
    customStatus: member && presence !== undefined && presence !== null
      ? (presence.activities.find((a) => a.type === 4)?.state ?? '')
      : undefined,
    startedAt,
  };
}
