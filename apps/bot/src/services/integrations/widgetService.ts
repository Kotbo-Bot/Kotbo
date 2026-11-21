import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getStaffMember } from '../staff/staffManagementService.js';
import { getGuildLevelCurve, getLevelFromXp } from '../progression/levelingService.js';
import { getClient } from '../../utils/client.js';
import { fetchExternal } from '../../utils/http.js';

const TAG = 'Widget';
const API = 'https://discord.com/api/v9';

const ICON_MSG = 'https://cdn.discordapp.com/emojis/1519265291849170994.png';
const ICON_VOICE = 'https://cdn.discordapp.com/emojis/1519265313911345234.png';
const ICON_LEVEL = 'https://cdn.discordapp.com/emojis/1519265285251792927.png';
const ICON_SHIELD = 'https://cdn.discordapp.com/emojis/1519265302968406096.png';

interface DynamicField {
  type: 1 | 2 | 3;
  name: string;
  value: string | number | { url: string };
}

interface WidgetPayload {
  username: string;
  data: { dynamic: DynamicField[] };
}

interface DiscordApiError {
  code?: number;
  message?: string;
  errors?: {
    provider_issued_user_id?: { _errors?: Array<{ code?: string; message?: string }> };
  };
}

/**
 * Discord refuse le PATCH quand l'identité envoyée n'est pas celle enregistrée
 * à la liaison du compte : 50035 (Invalid Form Body) portant
 * APPLICATION_IDENTITY_PROVIDER_USER_ID_MISMATCH sur provider_issued_user_id.
 * Ce n'est pas un défaut d'autorisation - c'est un identifiant d'identité erroné,
 * qu'on corrige en essayant le candidat suivant.
 */
function isIdentityMismatch(parsed: DiscordApiError): boolean {
  return (
    parsed.errors?.provider_issued_user_id?._errors?.some(
      (e) => e.code === 'APPLICATION_IDENTITY_PROVIDER_USER_ID_MISMATCH',
    ) ?? false
  );
}

/** Discord accepte une identité différente de celle tentée : essayer la suivante. */
function shouldTryNextIdentity(parsed: DiscordApiError): boolean {
  return parsed.code === 40113 || isIdentityMismatch(parsed);
}

/**
 * 403 / 50026 (Missing required OAuth2 scope) : ce membre-là n'a pas, ou plus,
 * autorisé l'application pour son profil. La portée est accordée par
 * l'utilisateur au moment de la liaison, pas configurée sur l'application :
 * aucun réglage côté bot ne débloque le cas, seul le membre peut réautoriser.
 * Inutile donc de tenter l'identité suivante, et inutile de logger en erreur.
 */
function isMissingUserAuthorization(parsed: DiscordApiError): boolean {
  return parsed.code === 50026;
}

const REAUTHORIZE_HINT =
  "Kotbo n'est plus autorisé sur ton profil Discord. Réautorise Kotbo depuis le dashboard, puis relance `/widget activer`.";

function getWidgetProfileUrl(appId: string, userId: string, identityId: string): string {
  return `${API}/applications/${appId}/users/${userId}/identities/${encodeURIComponent(identityId)}/profile`;
}

function formatGrade(grade: string): string {
  const grades: Record<string, string> = {
    HELPER: 'Helper',
    MODERATOR: 'Modérateur',
    ADMIN: 'Admin',
    OWNER: 'Propriétaire',
  };
  return grades[grade] ?? grade;
}

/**
 * Statistiques brutes du widget, consommées par le widget Discord mais aussi
 * par les widgets externes (Scriptable iOS, KWGT Android, widget Windows 11/Edge)
 * via l'endpoint public /api/public/widget-data.
 */
export interface WidgetStats {
  server: {
    name: string;
    iconUrl: string;
    memberCount: number;
    inviteUrl: string;
    inviteImageUrl: string;
  };
  user: {
    username: string;
    staffRank: string;
    staffSince: string;
    level: number;
    messageCount: number;
    voiceMinutes: number;
    staffScore: number;
  };
  updatedAt: string;
}

export async function getWidgetStats(guildId: string, userId: string): Promise<WidgetStats | null> {
  const client = getClient();
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;

  const [staffMember, memberProfile, memberLevel] = await Promise.all([
    getStaffMember(guildId, userId),
    prisma.memberProfile.findFirst({ where: { guildId, userId } }),
    prisma.memberLevel.findFirst({ where: { guildId, userId } }),
  ]);

  if (!staffMember) return null;

  const level = memberLevel ? getLevelFromXp(memberLevel.xp, await getGuildLevelCurve(guildId)) : 0;
  const messageCount = memberProfile?.messageCount ?? 0;
  const voiceSeconds = memberProfile?.voiceTimeSeconds ?? 0;
  const username = guild.members.cache.get(userId)?.user.username ?? memberProfile?.username ?? userId;
  const guildIconUrl = guild.iconURL({ size: 256 }) ?? '';

  const staffSince = staffMember.joinedStaffAt
    ? staffMember.joinedStaffAt.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : '-';

  const staffActivities = await prisma.staffActivity.findMany({
    where: { guildId, staffUserId: staffMember.id },
    orderBy: { activityDate: 'desc' },
    take: 30,
  });
  const staffScore = staffActivities.length > 0
    ? Math.min(100, Math.round(staffActivities.reduce((s, a) => s + a.messageCount + a.voiceMinutes, 0) / staffActivities.length))
    : 0;

  const inviteImageUrl = guild.splashURL({ size: 256 }) ?? guild.bannerURL({ size: 256 }) ?? guildIconUrl;
  let inviteUrl = '';
  if (guild.vanityURLCode) {
    inviteUrl = `discord.gg/${guild.vanityURLCode}`;
  } else {
    const invites = await guild.invites.fetch().catch(() => null);
    const permanent = invites?.find(i => i.maxAge === 0);
    if (permanent) inviteUrl = `discord.gg/${permanent.code}`;
  }

  return {
    server: {
      name: guild.name,
      iconUrl: guildIconUrl,
      memberCount: guild.memberCount,
      inviteUrl,
      inviteImageUrl,
    },
    user: {
      username,
      staffRank: formatGrade(staffMember.grade),
      staffSince,
      level,
      messageCount,
      voiceMinutes: Math.floor(voiceSeconds / 60),
      staffScore,
    },
    updatedAt: new Date().toISOString(),
  };
}

async function buildWidgetPayload(guildId: string, userId: string): Promise<WidgetPayload | null> {
  const stats = await getWidgetStats(guildId, userId);
  if (!stats) return null;

  const { server, user } = stats;
  const { messageCount, voiceMinutes, level, staffScore } = user;
  const guildIconUrl = server.iconUrl;
  const guildName = server.name;

  const dynamic: DynamicField[] = [
    { type: 3, name: 'serveur.logo', value: { url: guildIconUrl } },
    { type: 1, name: 'user.staffRank', value: user.staffRank },
    { type: 1, name: 'server.name', value: guildName },
    { type: 1, name: 'serveur.membersCount', value: server.memberCount.toLocaleString('fr-FR') },
    { type: 1, name: 'user.staffSinceTo', value: user.staffSince },
    { type: 3, name: 'user.statMessage.image', value: { url: ICON_MSG } },
    { type: 1, name: 'user.statMessage.title', value: 'Message count :' },
    { type: 1, name: 'user.statMessage.description', value: messageCount.toLocaleString('fr-FR') },
    { type: 3, name: 'user.statVocal.image', value: { url: ICON_VOICE } },
    { type: 1, name: 'user.statVocal.title', value: 'Vocal Count :' },
    { type: 1, name: 'user.statVocal.description', value: `${voiceMinutes.toLocaleString('fr-FR')} min` },
    { type: 3, name: 'user.level.image', value: { url: ICON_LEVEL } },
    { type: 1, name: 'user.level.title', value: 'Level :' },
    { type: 1, name: 'user.level.description', value: `${level} lvl` },
    { type: 3, name: 'user.statStaffScore.image', value: { url: ICON_SHIELD } },
    { type: 1, name: 'user.statStaffScore.title', value: 'Staff Score :' },
    { type: 1, name: 'user.statStaffScore.description', value: `${staffScore} points` },
    { type: 1, name: 'user.staffRankHero', value: user.staffRank },
    { type: 1, name: 'serveur.name', value: guildName },
    { type: 3, name: 'server.images.invite', value: { url: server.inviteImageUrl } },
    { type: 1, name: 'server.invite.name', value: guildName },
    { type: 1, name: 'server.invite.description', value: server.inviteUrl },
  ];

  return { username: user.username, data: { dynamic } };
}

export async function pushWidgetForUser(guildId: string, userId: string): Promise<{ ok: boolean; error?: string }> {
  const botToken = process.env.DISCORD_TOKEN;
  const appId = process.env.DISCORD_CLIENT_ID;
  if (!botToken || !appId) {
    return { ok: false, error: 'DISCORD_TOKEN ou DISCORD_CLIENT_ID manquant' };
  }

  let payload: WidgetPayload | null;
  try {
    payload = await buildWidgetPayload(guildId, userId);
  } catch (err) {
    // Une requête Prisma (ou autre lookup) qui échoue ici pour un membre ne
    // doit pas remonter jusqu'au cron : ça arrêterait le refresh de tous les
    // autres membres/serveurs de la même passe.
    logger.error(TAG, `Construction du payload échouée pour ${userId} sur ${guildId}:`, err);
    return { ok: false, error: String(err) };
  }
  if (!payload) {
    return { ok: false, error: 'Membre staff introuvable ou serveur inaccessible' };
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bot ${botToken}`,
    'User-Agent': 'DiscordBot (https://kotbo.fr, 1.0.0)',
  };

  try {
    // The identity is an external-account identifier and must be unique per
    // Discord user. The former constant "0" made the first user claim the
    // identity and caused every subsequent user to receive Discord error 40106.
    // Keep "0" only as a compatibility fallback for that first legacy user.
    const identityIds = [userId, '0'];
    for (const [index, identityId] of identityIds.entries()) {
      const res = await fetchExternal(getWidgetProfileUrl(appId, userId, identityId), {
        method: 'PATCH',
        headers,
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        logger.info(TAG, `Widget mis à jour pour ${userId} sur ${guildId} (identité ${identityId})`);
        return { ok: true };
      }

      const body = await res.text();
      let parsed: DiscordApiError = {};
      try { parsed = JSON.parse(body); } catch { /* Preserve the raw Discord response below. */ }

      const isLastCandidate = index === identityIds.length - 1;

      if (shouldTryNextIdentity(parsed) && !isLastCandidate) {
        logger.info(
          TAG,
          `Identité ${identityId} refusée pour ${userId} (code ${parsed.code}); tentative avec l'identité suivante`,
        );
        continue;
      }

      if (isMissingUserAuthorization(parsed)) {
        // Se reproduit à chaque cycle de refresh (toutes les 30 min) tant que le
        // membre n'a pas réautorisé l'app : un WARN ici ne fait que noyer les
        // vrais problèmes dans les logs sans rien indiquer d'actionnable côté bot.
        logger.debug(TAG, `Autorisation Discord absente pour ${userId} sur ${guildId} (50026): ${body}`);
        return { ok: false, error: REAUTHORIZE_HINT };
      }

      if (parsed.code === 40106) {
        logger.warn(TAG, `Conflit d'identité Discord 40106 pour ${userId} sur ${guildId}: ${body}`);
        return {
          ok: false,
          error: 'Une identité Kotbo est déjà liée à un autre compte Discord. Contacte un administrateur.',
        };
      }

      if (isIdentityMismatch(parsed)) {
        logger.warn(TAG, `Aucune identité connue ne correspond à l'enregistrement Discord de ${userId}: ${body}`);
        return {
          ok: false,
          error:
            "Le widget est rattaché à une identité Discord que Kotbo ne connaît pas. Désactive puis réactive le widget pour recréer la liaison.",
        };
      }

      logger.error(TAG, `PATCH échoué pour ${userId} sur ${guildId}: ${res.status} ${body}`);
      return { ok: false, error: `Discord API ${res.status}: ${body}` };
    }

    return { ok: false, error: 'Impossible de sélectionner une identité Discord pour ce widget.' };
  } catch (err) {
    logger.error(TAG, `Erreur réseau widget ${userId}:`, err);
    return { ok: false, error: String(err) };
  }
}

export async function clearWidgetForUser(userId: string): Promise<{ ok: boolean; error?: string }> {
  const botToken = process.env.DISCORD_TOKEN;
  const appId = process.env.DISCORD_CLIENT_ID;
  if (!botToken || !appId) {
    return { ok: false, error: 'DISCORD_TOKEN ou DISCORD_CLIENT_ID manquant' };
  }

  const emptyPayload = { data: { dynamic: [] } };

  try {
    const identityIds = [userId, '0'];
    for (const [index, identityId] of identityIds.entries()) {
      const res = await fetchExternal(getWidgetProfileUrl(appId, userId, identityId), {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bot ${botToken}`,
          'User-Agent': 'DiscordBot (https://kotbo.fr, 1.0.0)',
        },
        body: JSON.stringify(emptyPayload),
      });

      if (res.ok) {
        logger.info(TAG, `Widget vidé pour ${userId} (identité ${identityId})`);
        return { ok: true };
      }

      const body = await res.text();
      let parsed: DiscordApiError = {};
      try { parsed = JSON.parse(body); } catch { /* Preserve the raw Discord response below. */ }

      const isLastCandidate = index === identityIds.length - 1;

      if (shouldTryNextIdentity(parsed) && !isLastCandidate) {
        logger.info(TAG, `Clear via identité ${identityId} refusé pour ${userId} (code ${parsed.code}); tentative suivante`);
        continue;
      }

      // Identité en conflit, absente, ou ne correspondant à aucun de nos
      // candidats : il n'y a rien à vider pour cet utilisateur.
      if (
        parsed.code === 40106
        || parsed.code === 10069
        || res.status === 404
        || isIdentityMismatch(parsed)
        || isMissingUserAuthorization(parsed)
      ) {
        logger.info(TAG, `Clear widget ignoré pour ${userId} (code ${parsed.code ?? res.status}): pas d'identité liée`);
        return { ok: true };
      }
      logger.error(TAG, `Clear widget échoué pour ${userId}: ${res.status} ${body}`);
      return { ok: false, error: `Discord API ${res.status}: ${body}` };
    }

    return { ok: false, error: 'Impossible de sélectionner une identité Discord pour ce widget.' };
  } catch (err) {
    logger.error(TAG, `Erreur réseau clear widget ${userId}:`, err);
    return { ok: false, error: String(err) };
  }
}

export async function refreshAllStaffWidgets(guildId: string): Promise<{
  success: number;
  failed: number;
  failures: Array<{ userId: string; error: string }>;
}> {
  const staffMembers = await prisma.staffMember.findMany({ where: { guildId } });
  let success = 0;
  let failed = 0;
  const failures: Array<{ userId: string; error: string }> = [];

  const widgetSubscriptions = await prisma.widgetSubscription.findMany({
    where: { guildId, enabled: true },
  });
  const subscribedUserIds = new Set(widgetSubscriptions.map((s) => s.userId));

  for (const staff of staffMembers) {
    if (!subscribedUserIds.has(staff.userId)) continue;
    const result = await pushWidgetForUser(guildId, staff.userId);
    if (result.ok) success++;
    else {
      failed++;
      failures.push({ userId: staff.userId, error: result.error ?? 'Erreur Discord inconnue' });
    }
  }

  logger.info(TAG, `Refresh widgets ${guildId}: ${success} OK, ${failed} échoués`);
  return { success, failed, failures };
}
