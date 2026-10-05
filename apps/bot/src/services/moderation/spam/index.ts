/**
 * spam/index.ts - Point d'entrée du moteur anti-spam comportemental.
 *
 * Chaîne de traitement d'un message :
 *   exemptions → contexte → évaluation (pure) → palier d'action → sanction.
 *
 * En mode shadow, tout se déroule jusqu'au palier d'action mais rien n'est
 * appliqué : seul l'échantillon est enregistré. C'est le mode de démarrage par
 * défaut, et le seul moyen honnête de calibrer des seuils avant de sanctionner.
 */

import { type Message, type TextChannel, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { COLORS, truncate } from '../../../utils/embeds.js';
import { getCachedGuild } from '../../../utils/cache.js';
import { registerTimeoutSanction, registerBanSanction, registerWarnSanction } from '../sanctionService.js';
import { mirrorModlogToStaffServer } from '../../staff/staffServerService.js';
import { getSpamConfig, thresholdsFromConfig, tuningFromConfig } from './config.js';
import {
  getHistory,
  getLastTypingAt,
  getTypingSessionStartAt,
  isTypingObservable,
  recordMessage,
  recordTyping,
} from './activityStore.js';
import { loadSpamWeights, logSpamSample } from './learning.js';
import { normalizeContent } from './normalize.js';
import { evaluateMessage } from './scoring.js';
import { resolveAction, type SpamAction, type SpamVerdict, type TrustContext } from './types.js';

export * from './types.js';
export { evaluateMessage, computeSpamScore, trustMultiplier } from './scoring.js';
export { collectSignals } from './signals.js';
export { normalizeContent, similarity, detectUnicodeObfuscation } from './normalize.js';
export { getSpamConfig, upsertSpamConfig, tuningFromConfig, thresholdsFromConfig } from './config.js';
export { recordTyping, resetActivityStore, activityStoreStats } from './activityStore.js';
export {
  getCalibrationStats,
  recordSpamDecision,
  recalibrateSpamWeights,
  loadSpamWeights,
  invalidateSpamWeightsCache,
} from './learning.js';

/** Le nombre de messages d'un membre ne change pas assez vite pour valoir une requête par message. */
const TRUST_CACHE_TTL_MS = 5 * 60 * 1000;
const trustCache = new Map<string, { trust: TrustContext; expiresAt: number }>();

async function buildTrustContext(message: Message): Promise<TrustContext> {
  const guildId = message.guild!.id;
  const userId = message.author.id;
  const key = `${guildId}:${userId}`;

  const cached = trustCache.get(key);
  const member = message.member;

  const accountAgeMs = Date.now() - message.author.createdTimestamp;
  const membershipMs = member?.joinedTimestamp ? Date.now() - member.joinedTimestamp : null;
  const hasRole = (member?.roles.cache.size ?? 1) > 1;

  if (cached && cached.expiresAt > Date.now()) {
    // Seul le compteur de messages est mis en cache : le reste est gratuit.
    return { ...cached.trust, accountAgeMs, membershipMs, hasRole };
  }

  let messageCount = 0;
  let isTrustedRole = false;

  try {
    const [profile, guildConfig] = await Promise.all([
      prisma.memberProfile.findUnique({
        where: { guildId_userId: { guildId, userId } },
        select: { messageCount: true },
      }),
      getCachedGuild(guildId) as Promise<Record<string, unknown> | null>,
    ]);

    messageCount = profile?.messageCount ?? 0;

    const trustedRoleIds = [
      guildConfig?.moderatorRoleId,
      guildConfig?.baseStaffRoleId,
      guildConfig?.testStaffRoleId,
      guildConfig?.regulationRoleId,
    ].filter((id): id is string => typeof id === 'string' && id.length > 0);

    isTrustedRole = trustedRoleIds.some((roleId) => member?.roles.cache.has(roleId) ?? false);
  } catch (err) {
    logger.debug('SpamEngine', `Contexte de confiance indisponible pour ${userId}: ${String(err)}`);
  }

  const trust: TrustContext = { accountAgeMs, membershipMs, messageCount, hasRole, isTrustedRole };
  trustCache.set(key, { trust, expiresAt: Date.now() + TRUST_CACHE_TTL_MS });
  return trust;
}

const ACTION_LABELS: Record<SpamAction, string> = {
  NONE: 'Aucune',
  LOG: 'Journalisation',
  DELETE: 'Suppression',
  TIMEOUT: 'Suppression + exclusion temporaire',
  BAN: 'Bannissement',
};

function verdictSummary(verdict: SpamVerdict): string {
  if (verdict.signals.length === 0) return '-';
  return verdict.signals
    .sort((a, b) => b.score - a.score)
    .map((s) => `• **${s.label}** (${s.score})${s.detail ? ` - ${s.detail}` : ''}`)
    .join('\n');
}

async function sendAlert(
  message: Message,
  verdict: SpamVerdict,
  action: SpamAction,
  shadow: boolean
): Promise<void> {
  const guild = message.guild!;
  const config = await getSpamConfig(guild.id);
  const guildConfig = (await getCachedGuild(guild.id)) as { logChannelId?: string | null } | null;

  const channelId = config?.alertChannelId ?? guildConfig?.logChannelId;
  if (!channelId) return;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setColor(shadow ? COLORS.info : action === 'BAN' || action === 'TIMEOUT' ? COLORS.danger : COLORS.warning)
    .setTitle(shadow ? '🕵️ Anti-spam (observation)' : '🚫 Anti-spam')
    .setDescription(
      shadow
        ? 'Mode observation : aucune action n\'a été appliquée. Ce constat sert à calibrer les seuils.'
        : null
    )
    .addFields(
      { name: 'Membre', value: `<@${message.author.id}> (\`${message.author.id}\`)`, inline: true },
      { name: 'Salon', value: `<#${message.channelId}>`, inline: true },
      { name: 'Score', value: `**${verdict.score}**/100`, inline: true },
      { name: 'Action', value: ACTION_LABELS[action], inline: true },
      { name: 'Familles concordantes', value: String(verdict.distinctFamilies), inline: true },
      { name: 'Confiance', value: `×${verdict.trustMultiplier.toFixed(2)}`, inline: true },
      { name: 'Signaux', value: truncate(verdictSummary(verdict), 1000), inline: false },
      { name: 'Message', value: truncate(message.content || '[aucun texte]', 500), inline: false }
    )
    .setTimestamp();

  await (channel as TextChannel).send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
  if (!shadow) await mirrorModlogToStaffServer(message.client, guild.id, embed).catch(() => null);
}

async function applySpamAction(message: Message, verdict: SpamVerdict, action: SpamAction): Promise<void> {
  const guildId = message.guild!.id;
  const reason =
    `[Anti-spam] Score ${verdict.score}/100 - ` +
    verdict.signals
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((s) => s.label)
      .join(', ');

  const target = { id: message.author.id, tag: message.author.tag };
  const moderator = { id: message.client.user.id, tag: message.client.user.tag };

  if (action === 'DELETE' || action === 'TIMEOUT' || action === 'BAN') {
    await message.delete().catch(() => null);
  }

  const config = await getSpamConfig(guildId);

  try {
    if (action === 'BAN') {
      await registerBanSanction({ guildId, target, moderator, reason, client: message.client });
    } else if (action === 'TIMEOUT' && message.member) {
      await registerTimeoutSanction({
        guildId,
        target,
        moderator,
        reason,
        durationMs: (config?.timeoutMinutes ?? 60) * 60 * 1000,
        member: message.member,
        client: message.client,
      });
    } else if (action === 'DELETE') {
      await registerWarnSanction({ guildId, target, moderator, reason, client: message.client });
    }
  } catch (err) {
    logger.error('SpamEngine', `Sanction ${action} impossible pour ${message.author.id}`, err);
  }
}

/**
 * Évalue un message et applique le palier d'action correspondant.
 *
 * @returns true si le message a été supprimé ou l'auteur sanctionné, pour que
 *          l'appelant interrompe la chaîne de traitement.
 */
export async function handleSpamMessage(message: Message): Promise<boolean> {
  if (!message.guild || !message.member || message.author.bot) return false;
  if (!message.content && message.attachments.size === 0) return false;

  const guildId = message.guild.id;

  let config;
  try {
    config = await getSpamConfig(guildId);
  } catch (err) {
    logger.error('SpamEngine', `Config anti-spam illisible pour ${guildId}`, err);
    return false;
  }
  if (!config?.enabled) return false;

  // ── Exemptions ─────────────────────────────────────────────────────────────
  if (config.bypassChannelIds.includes(message.channelId)) return false;
  if (message.member.roles.cache.some((r) => config.bypassRoleIds.includes(r.id))) return false;
  // Quiconque peut déjà supprimer des messages n'a pas à être modéré par le bot.
  if (message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return false;

  const tuning = tuningFromConfig(config);
  const now = Date.now();
  const normalized = normalizeContent(message.content);

  const record = {
    at: now,
    channelId: message.channelId,
    normalized,
    length: message.content.length,
    hasAttachment: message.attachments.size > 0,
  };

  let verdict: SpamVerdict;
  try {
    const [trust, weights] = await Promise.all([buildTrustContext(message), loadSpamWeights(guildId)]);

    verdict = evaluateMessage(
      {
        now,
        content: message.content,
        channelId: message.channelId,
        attachmentCount: message.attachments.size,
        mentionCount: message.mentions.users.size + message.mentions.roles.size,
        mentionedEveryone: message.mentions.everyone,
        history: getHistory(guildId, message.author.id),
        lastTypingAt: getLastTypingAt(guildId, message.author.id),
        typingSessionStartAt: getTypingSessionStartAt(guildId, message.author.id),
        typingObservable: isTypingObservable(guildId),
        trust,
        tuning,
      },
      weights
    );
  } catch (err) {
    logger.error('SpamEngine', `Évaluation impossible sur ${guildId}`, err);
    return false;
  } finally {
    // Le message courant entre dans l'historique quoi qu'il arrive : c'est ce
    // qui permet aux messages suivants de voir la rafale se construire.
    recordMessage(guildId, message.author.id, record);
  }

  const thresholds = thresholdsFromConfig(config);
  const action = resolveAction(verdict.score, thresholds);
  if (action === 'NONE') return false;

  const shadow = config.shadowMode;

  void logSpamSample({
    guildId,
    userId: message.author.id,
    channelId: message.channelId,
    messageId: message.id,
    verdict,
    action,
    shadow,
    content: message.content,
  });

  // Les constats de simple journalisation n'alertent pas : ils rempliraient le
  // salon de logs sans qu'aucune décision ne soit attendue.
  if (action !== 'LOG') {
    void sendAlert(message, verdict, action, shadow).catch(() => null);
  }

  if (shadow) {
    logger.debug(
      'SpamEngine',
      `[shadow] ${message.author.tag} score ${verdict.score} → ${action} (${verdict.signals.map((s) => s.type).join(', ')})`
    );
    return false;
  }

  if (action === 'LOG') return false;

  await applySpamAction(message, verdict, action);
  logger.warn(
    'SpamEngine',
    `${action} appliqué à ${message.author.tag} (${message.author.id}) sur ${guildId} - score ${verdict.score}`
  );
  return true;
}

/** Branché sur `typingStart` : alimente les signaux « posté sans frappe » et « copier-coller ». */
export function handleTypingStart(guildId: string, userId: string): void {
  recordTyping(guildId, userId);
}
