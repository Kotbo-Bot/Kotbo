/**
 * Kotbo × AegisAI : branchement sur Discord.
 *
 * Rien n'est noté ici : chaque message, édition ou pseudo devient un job de la
 * file (aegisQueue.ts), noté plus tard par aegisProcessor.ts. Le chemin de
 * `MessageCreate` ne fait qu'un tri sans appel réseau.
 *
 * Reçoit la vue du client filtrée sur le module AutoMod, dont AegisAI fait
 * partie ; `AegisConfig.enabled` est la seconde clé.
 */
import {
  Events,
  PermissionFlagsBits,
  type Client,
  type GuildMember,
  type Message,
  type PartialGuildMember,
  type PartialMessage,
} from 'discord.js';
import { logger } from '../utils/logger.js';
import { getOrCreateAutoModConfig } from '../services/moderation/autoModService.js';
import { isAnalyticsCollectionEnabled } from '../services/analytics/analyticsConsent.js';
import { getAegisConfig, type AegisRuntimeConfig } from '../services/moderation/aegis/aegisConfig.js';
import { enqueueAegisJob, startAegisQueue, type AegisJob } from '../services/moderation/aegis/aegisQueue.js';
import { processAegisJob, setAegisDiscordClient } from '../services/moderation/aegis/aegisProcessor.js';
import { restoreDueSlowmodes } from '../services/moderation/aegis/aegisModules.js';
import { excerptOf, prepareText } from '../services/moderation/aegis/aegisText.js';
import { getAegisClient } from '../services/moderation/aegis/aegisClient.js';

const MODULE_NAME = 'aegis';
const RESTORE_SWEEP_MS = 60_000;

/**
 * Membre exempté : admin, ou exempté par AutoMod ou par AegisAI. Son message
 * est noté comme les autres (aucun angle mort), mais le bot ne le sanctionne
 * jamais seul : au-dessus du seuil, il part en revue.
 */
async function isExempt(member: GuildMember | null, channelId: string, parentId: string | null, config: AegisRuntimeConfig): Promise<boolean> {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const automod = await getOrCreateAutoModConfig(member.guild.id);
  const channels = [...automod.bypassChannels, ...config.exemptChannelIds];
  if (channels.includes(channelId) || (parentId !== null && channels.includes(parentId))) return true;
  const roles = [...automod.bypassRoles, ...config.exemptRoleIds];
  return member.roles.cache.some((role) => roles.includes(role.id));
}

/** Membre visé : l'auteur du message auquel on répond, sinon l'unique membre mentionné. */
function targetOf(message: Message): string | null {
  const replied = message.mentions.repliedUser;
  if (replied && !replied.bot && replied.id !== message.author.id) return replied.id;
  const mentioned = message.mentions.users.filter((user) => !user.bot && user.id !== message.author.id);
  return mentioned.size === 1 ? mentioned.first()!.id : null;
}

function parentOf(message: Message): string | null {
  return message.channel.isThread() ? message.channel.parentId : null;
}

async function onMessage(message: Message): Promise<void> {
  if (!message.guild || message.author.bot || message.system || message.webhookId) return;
  const text = prepareText(message.content);
  if (!text) return;
  const config = await getAegisConfig(message.guild.id);
  if (!config || !getAegisClient().configured) return;

  const parentId = parentOf(message);
  const exempt = await isExempt(message.member, message.channelId, parentId, config);
  const job: AegisJob = {
    source: 'MESSAGE',
    guildId: message.guild.id,
    channelId: message.channelId,
    statsChannelId: parentId ?? message.channelId,
    messageId: message.id,
    authorId: message.author.id,
    text,
    excerpt: excerptOf(message.content),
    targetUserId: targetOf(message),
    exempt,
    countStats: await isAnalyticsCollectionEnabled(message.guild.id),
    enqueuedAt: Date.now(),
  };
  await enqueueAegisJob(job);
}

async function onMessageUpdate(oldMessage: Message | PartialMessage, newMessage: Message | PartialMessage): Promise<void> {
  if (!newMessage.guild) return;
  const config = await getAegisConfig(newMessage.guild.id);
  if (!config?.analyzeEdits || !getAegisClient().configured) return;
  const message = newMessage.partial ? await newMessage.fetch().catch(() => null) : newMessage;
  if (!message || message.author.bot || message.webhookId) return;
  // Intégration de lien, épinglage : le texte n'a pas bougé.
  if (!oldMessage.partial && oldMessage.content === message.content) return;
  const text = prepareText(message.content);
  if (!text) return;
  const parentId = parentOf(message);

  await enqueueAegisJob({
    source: 'EDIT',
    guildId: message.guild!.id,
    channelId: message.channelId,
    statsChannelId: parentId ?? message.channelId,
    messageId: message.id,
    authorId: message.author.id,
    text,
    excerpt: excerptOf(message.content),
    targetUserId: targetOf(message),
    exempt: await isExempt(message.member, message.channelId, parentId, config),
    countStats: false,
    enqueuedAt: Date.now(),
  });
}

async function checkNickname(member: GuildMember): Promise<void> {
  if (member.user.bot) return;
  const config = await getAegisConfig(member.guild.id);
  if (!config?.analyzeNicknames || !getAegisClient().configured) return;
  const name = member.nickname ?? member.user.globalName ?? member.user.username;
  const text = prepareText(name);
  if (!text) return;

  await enqueueAegisJob({
    source: 'NICKNAME',
    guildId: member.guild.id,
    channelId: '',
    statsChannelId: '',
    messageId: null,
    authorId: member.id,
    text,
    excerpt: excerptOf(name, 100),
    targetUserId: null,
    exempt: await isExempt(member, '', null, config),
    countStats: false,
    enqueuedAt: Date.now(),
  });
}

async function onMemberUpdate(oldMember: GuildMember | PartialGuildMember, newMember: GuildMember): Promise<void> {
  const before = oldMember.partial ? null : oldMember.nickname ?? oldMember.user.globalName;
  const after = newMember.nickname ?? newMember.user.globalName;
  if (before === after) return;
  await checkNickname(newMember);
}

/**
 * @param client  client brut : la file et la levée des modes lents tournent
 *                pour tous les serveurs.
 * @param scoped  vue filtrée sur le module AutoMod, pour les écouteurs.
 */
export async function registerAegisModule(client: Client, scoped: Client): Promise<void> {
  setAegisDiscordClient(client);
  await startAegisQueue(processAegisJob);

  const guard = (label: string, run: () => Promise<void>) => {
    run().catch((err) => logger.error(`[EventBus:${MODULE_NAME}]`, `Erreur ${label} :`, err));
  };
  scoped.on(Events.MessageCreate, (message: Message) => guard('MessageCreate', () => onMessage(message)));
  scoped.on(Events.MessageUpdate, (oldMessage: Message | PartialMessage, newMessage: Message | PartialMessage) =>
    guard('MessageUpdate', () => onMessageUpdate(oldMessage, newMessage)));
  scoped.on(Events.GuildMemberAdd, (member: GuildMember) => guard('GuildMemberAdd', () => checkNickname(member)));
  scoped.on(Events.GuildMemberUpdate, (oldMember: GuildMember | PartialGuildMember, newMember: GuildMember) =>
    guard('GuildMemberUpdate', () => onMemberUpdate(oldMember, newMember)));

  const sweep = () => void restoreDueSlowmodes(client).catch((err) => logger.warn('AegisAI', 'Levée des modes lents :', err));
  sweep();
  const timer = setInterval(sweep, RESTORE_SWEEP_MS);
  if (typeof timer.unref === 'function') timer.unref();

  if (!getAegisClient().configured) {
    logger.warn('Modules', 'AEGISAI_API_KEY absente : le module AegisAI reste inactif.');
  }
  logger.info('Modules', `Module "${MODULE_NAME}" enregistré.`);
}
