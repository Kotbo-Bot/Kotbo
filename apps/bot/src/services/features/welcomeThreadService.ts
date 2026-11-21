import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SnowflakeUtil,
  StringSelectMenuBuilder,
  ThreadAutoArchiveDuration,
  type ButtonInteraction,
  type Client,
  type ColorResolvable,
  type Guild,
  type GuildMember,
  type MessageActionRowComponentBuilder,
  type NewsChannel,
  type StringSelectMenuInteraction,
  type TextChannel,
  type ThreadChannel,
  type Webhook,
} from 'discord.js';
import type { WelcomeMenuPage, WelcomeThreadConfig, WelcomeThreadStep } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { resolvePlaceholders, type PlaceholderContext } from '../../utils/placeholders.js';

const TAG = 'WelcomeThreadService';
const WEBHOOK_NAME = 'Kotbo Accueil';

// Cache mémoire du webhook par salon : évite un appel API fetchWebhooks() à chaque arrivée de membre
const webhookCache = new Map<string, Webhook>();
const exclusiveRoleLocks = new Map<string, Promise<void>>();

/** Intervalle de rafraîchissement de l'indicateur "est en train d'écrire" (Discord l'affiche ~10s) */
const TYPING_REFRESH_MS = 8_000;
/** Bornes de l'intervalle entre deux messages scénarisés */
const MIN_STEP_DELAY_MS = 250;
const MAX_STEP_DELAY_MS = 120_000;
/** Limites Discord sur les composants */
export const MAX_MENU_PAGES = 25;
export const MAX_THREAD_STEPS = 20;
/** Bornes du délai d'inactivité avant suppression d'un thread d'accueil (1h → 30j) */
export const MIN_INACTIVITY_DELETE_HOURS = 1;
export const MAX_INACTIVITY_DELETE_HOURS = 720;
/** Plafonds du balayage : la suppression de thread est fortement limitée côté Discord */
const MAX_DELETIONS_PER_GUILD_PER_RUN = 25;
const DELETION_SPACING_MS = 1_000;
const ARCHIVED_PAGE_SIZE = 100;
const MAX_ARCHIVED_PAGES = 10;

// Type écrit à la main plutôt que Prisma.WelcomeThreadConfigGetPayload<{ include: ... }> :
// ce générique force tsc à réexpanser tout le graphe de relations du schéma (143 modèles)
// à chaque usage, ce qui provoque des OOM du typechecker sur ce projet.
export type WelcomeThreadConfigWithRelations = WelcomeThreadConfig & {
  steps: WelcomeThreadStep[];
  pages: WelcomeMenuPage[];
};

/**
 * Récupère ou initialise la configuration du thread d'accueil d'une guilde
 */
export async function getOrCreateWelcomeThreadConfig(guildId: string): Promise<WelcomeThreadConfigWithRelations> {
  const include = {
    steps: { orderBy: { order: 'asc' as const } },
    pages: { orderBy: { order: 'asc' as const } },
  };

  const existing = await prisma.welcomeThreadConfig.findUnique({ where: { guildId }, include });
  if (existing) return existing;

  return prisma.welcomeThreadConfig.create({ data: { guildId }, include });
}

export function clampStepDelay(delayMs: number): number {
  if (!Number.isFinite(delayMs)) return MIN_STEP_DELAY_MS;
  return Math.min(Math.max(Math.round(delayMs), MIN_STEP_DELAY_MS), MAX_STEP_DELAY_MS);
}

export function clampInactivityDeleteHours(hours: number): number {
  if (!Number.isFinite(hours)) return 48;
  return Math.min(Math.max(Math.round(hours), MIN_INACTIVITY_DELETE_HOURS), MAX_INACTIVITY_DELETE_HOURS);
}

export function resolveAutoArchiveDuration(minutes: number): ThreadAutoArchiveDuration {
  switch (minutes) {
    case 60: return ThreadAutoArchiveDuration.OneHour;
    case 4320: return ThreadAutoArchiveDuration.ThreeDays;
    case 10080: return ThreadAutoArchiveDuration.OneWeek;
    default: return ThreadAutoArchiveDuration.OneDay;
  }
}

export function parseEmbedColor(color: string | null | undefined): ColorResolvable {
  if (color && /^#[0-9a-fA-F]{6}$/.test(color.trim())) {
    return color.trim() as ColorResolvable;
  }
  return '#5865F2';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Point d'entrée : crée le thread d'accueil et lance la séquence scénarisée
 */
export async function handleWelcomeThread(member: GuildMember, _client: Client): Promise<void> {
  try {
    const config = await getOrCreateWelcomeThreadConfig(member.guild.id);
    if (!config.enabled || !config.channelId) return;

    const channel = member.guild.channels.cache.get(config.channelId);
    if (!channel) return;
    if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) return;

    const ctx: PlaceholderContext = { guild: member.guild, member };
    const threadName = (resolvePlaceholders(config.threadNameTemplate, ctx).trim()
      || `Bienvenue ${member.user.username}`).slice(0, 100);
    const autoArchiveDuration = resolveAutoArchiveDuration(config.autoArchiveMinutes);
    const reason = `Thread d'accueil pour ${member.user.tag}`;

    let thread: ThreadChannel;
    if (channel.type === ChannelType.GuildText && config.threadMode === 'private') {
      thread = await channel.threads.create({
        name: threadName,
        autoArchiveDuration,
        type: ChannelType.PrivateThread,
        invitable: false,
        reason,
      });
    } else {
      thread = await channel.threads.create({ name: threadName, autoArchiveDuration, reason });
    }

    await thread.members.add(member.id).catch(() => null);

    // Séquence détachée : les délais entre messages ne doivent pas bloquer le traitement du join
    void runWelcomeSequence(channel, thread, member, config).catch((err) => {
      logger.error(TAG, `Erreur séquence d'accueil pour ${member.id}:`, err);
    });
  } catch (err) {
    logger.error(TAG, `Erreur création du thread d'accueil pour ${member.id}:`, err);
  }
}

/**
 * Envoie les messages scénarisés via webhook (persona personnalisée) puis l'embed menu
 */
async function runWelcomeSequence(
  parentChannel: TextChannel | NewsChannel,
  thread: ThreadChannel,
  member: GuildMember,
  config: WelcomeThreadConfigWithRelations,
): Promise<void> {
  const ctx: PlaceholderContext = { guild: member.guild, member };
  const steps = config.steps.slice(0, MAX_THREAD_STEPS);
  const webhook = steps.length > 0 ? await getOrCreateWelcomeWebhook(parentChannel) : null;

  for (const step of steps) {
    const delay = clampStepDelay(step.delayMs);
    if (config.typingEnabled) {
      await showTyping(thread, delay);
    } else {
      await sleep(delay);
    }

    await sendStepMessage(webhook, thread, member, config, step, ctx);
  }

  if (config.menuEnabled) {
    const embed = buildWelcomeMenuEmbed(config, ctx);
    const components = buildWelcomeMenuComponents(config);
    await thread.send({ embeds: [embed], components }).catch((err) => {
      logger.warn(TAG, `Impossible d'envoyer l'embed d'accueil dans ${thread.id}:`, err);
    });
  }
}

async function sendStepMessage(
  webhook: Webhook | null,
  thread: ThreadChannel,
  member: GuildMember,
  config: WelcomeThreadConfigWithRelations,
  step: WelcomeThreadStep,
  ctx: PlaceholderContext,
): Promise<void> {
  const content = resolvePlaceholders(step.content, ctx).slice(0, 2000);
  if (!content) return;

  const allowedMentions = { users: [member.id] };

  if (webhook) {
    try {
      await webhook.send({
        content,
        username: (step.name ?? config.webhookName).slice(0, 80),
        avatarURL: step.avatarUrl ?? config.webhookAvatarUrl ?? undefined,
        threadId: thread.id,
        allowedMentions,
      });
      return;
    } catch (err) {
      // Webhook supprimé côté Discord (10015) : purge le cache pour forcer une recréation au prochain join
      webhookCache.delete(webhook.channelId);
      logger.warn(TAG, `Envoi webhook échoué dans ${thread.id}, fallback bot:`, err);
    }
  }

  await thread.send({ content, allowedMentions }).catch(() => null);
}

/**
 * Maintient l'indicateur "est en train d'écrire" pendant toute la durée demandée
 */
async function showTyping(thread: ThreadChannel, durationMs: number): Promise<void> {
  let remaining = durationMs;
  while (remaining > 0) {
    await thread.sendTyping().catch(() => null);
    const wait = Math.min(remaining, TYPING_REFRESH_MS);
    await sleep(wait);
    remaining -= wait;
  }
}

/**
 * Récupère ou crée le webhook d'accueil sur le salon parent (les webhooks ne vivent pas dans les threads)
 */
async function getOrCreateWelcomeWebhook(channel: TextChannel | NewsChannel): Promise<Webhook | null> {
  const cached = webhookCache.get(channel.id);
  if (cached) return cached;

  try {
    const webhooks = await channel.fetchWebhooks();
    const existing = webhooks.find(
      (w) => w.owner?.id === channel.client.user?.id && w.name === WEBHOOK_NAME,
    );
    const webhook = existing?.token ? existing : await channel.createWebhook({
      name: WEBHOOK_NAME,
      reason: "Webhook du système d'accueil personnalisé",
    });

    webhookCache.set(channel.id, webhook);
    return webhook;
  } catch (err) {
    logger.warn(TAG, `Impossible de créer le webhook d'accueil pour ${channel.id}:`, err);
    return null;
  }
}

/**
 * Dernière activité d'un thread : l'horodatage de son dernier message, ou à
 * défaut celui de sa création. `lastMessageId` reste exploitable même si le
 * message a été supprimé depuis, l'horodatage étant encodé dans le snowflake.
 */
export function resolveThreadLastActivityAt(
  thread: Pick<ThreadChannel, 'id' | 'lastMessageId' | 'createdTimestamp'>,
): number {
  if (thread.lastMessageId) return Number(SnowflakeUtil.timestampFrom(thread.lastMessageId));
  if (thread.createdTimestamp) return thread.createdTimestamp;
  return Number(SnowflakeUtil.timestampFrom(thread.id));
}

/**
 * Parcourt les threads archivés d'un salon (l'API les renvoie du plus récemment
 * archivé au plus ancien) et retient ceux créés par le bot.
 */
async function collectArchivedBotThreads(
  channel: TextChannel | NewsChannel,
  type: 'public' | 'private',
  botId: string,
  collected: Map<string, ThreadChannel>,
): Promise<void> {
  let before: ThreadChannel | undefined;

  for (let page = 0; page < MAX_ARCHIVED_PAGES; page++) {
    const fetched = await channel.threads.fetchArchived({
      type,
      limit: ARCHIVED_PAGE_SIZE,
      // Le listing global des threads privés archivés exige « Gérer les fils »,
      // déjà vérifié par l'appelant.
      ...(type === 'private' ? { fetchAll: true } : {}),
      ...(before ? { before } : {}),
    }).catch((err) => {
      logger.debug(TAG, `Listing des threads ${type} archivés impossible sur ${channel.id}:`, err);
      return null;
    });
    if (!fetched) return;

    let oldest: ThreadChannel | undefined;
    for (const thread of fetched.threads.values()) {
      oldest = thread;
      if (thread.ownerId === botId) collected.set(thread.id, thread);
    }

    if (!fetched.hasMore || !oldest) return;
    before = oldest;
  }
}

/**
 * Threads d'accueil du salon : ceux dont le bot est l'auteur, actifs comme archivés
 */
async function collectWelcomeThreads(
  channel: TextChannel | NewsChannel,
  botId: string,
): Promise<ThreadChannel[]> {
  const collected = new Map<string, ThreadChannel>();

  const active = await channel.threads.fetchActive().catch((err) => {
    logger.debug(TAG, `Listing des threads actifs impossible sur ${channel.id}:`, err);
    return null;
  });
  for (const thread of active?.threads.values() ?? []) {
    if (thread.ownerId === botId) collected.set(thread.id, thread);
  }

  await collectArchivedBotThreads(channel, 'public', botId, collected);
  await collectArchivedBotThreads(channel, 'private', botId, collected);

  return [...collected.values()];
}

async function cleanupGuildWelcomeThreads(
  client: Client,
  config: { guildId: string; channelId: string | null; inactivityDeleteHours: number },
): Promise<number> {
  const botId = client.user?.id;
  if (!botId || !config.channelId) return 0;

  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return 0;

  const channel = guild.channels.cache.get(config.channelId);
  if (!channel) return 0;
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) return 0;

  const botMember = guild.members.me;
  if (!botMember?.permissionsIn(channel).has(PermissionFlagsBits.ManageThreads)) {
    logger.warn(TAG, `Permission « Gérer les fils » manquante sur ${channel.id}, purge ignorée`);
    return 0;
  }

  const hours = clampInactivityDeleteHours(config.inactivityDeleteHours);
  const thresholdMs = hours * 3_600_000;
  const now = Date.now();
  const threads = await collectWelcomeThreads(channel, botId);

  let deleted = 0;
  for (const thread of threads) {
    if (now - resolveThreadLastActivityAt(thread) < thresholdMs) continue;
    if (deleted >= MAX_DELETIONS_PER_GUILD_PER_RUN) {
      logger.info(TAG, `Plafond de purge atteint sur ${guild.id}, le reste suivra au prochain passage`);
      break;
    }

    try {
      await thread.delete(`Thread d'accueil inactif depuis plus de ${hours}h`);
      deleted += 1;
      await sleep(DELETION_SPACING_MS);
    } catch (err) {
      logger.warn(TAG, `Suppression du thread d'accueil ${thread.id} impossible:`, err);
    }
  }

  if (deleted > 0) {
    logger.info(TAG, `${deleted} thread(s) d'accueil inactif(s) supprimé(s) sur ${guild.id}`);
  }
  return deleted;
}

/**
 * Balayage périodique : supprime les threads d'accueil sans activité depuis le
 * délai configuré (48h par défaut), pour éviter qu'ils ne s'entassent.
 */
export async function cleanupInactiveWelcomeThreads(client: Client): Promise<number> {
  const configs = await prisma.welcomeThreadConfig.findMany({
    where: { enabled: true, inactivityDeleteEnabled: true, channelId: { not: null } },
    select: { guildId: true, channelId: true, inactivityDeleteHours: true },
  });

  let deleted = 0;
  for (const config of configs) {
    try {
      deleted += await cleanupGuildWelcomeThreads(client, config);
    } catch (err) {
      logger.error(TAG, `Erreur purge des threads d'accueil pour ${config.guildId}:`, err);
    }
  }
  return deleted;
}

export function buildWelcomeMenuEmbed(
  config: WelcomeThreadConfigWithRelations,
  ctx: PlaceholderContext,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(resolvePlaceholders(config.embedTitle, ctx).slice(0, 256))
    .setDescription(resolvePlaceholders(config.embedDescription, ctx).slice(0, 4096))
    .setColor(parseEmbedColor(config.embedColor));

  if (config.embedImageUrl) embed.setImage(config.embedImageUrl);
  if (config.embedThumbnailUrl) embed.setThumbnail(config.embedThumbnailUrl);
  return embed;
}

/**
 * Construit les composants du menu de présentation (boutons ou menu déroulant)
 */
export function buildWelcomeMenuComponents(
  config: WelcomeThreadConfigWithRelations,
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const pages = config.pages.slice(0, MAX_MENU_PAGES);
  if (pages.length === 0) return [];

  if (config.menuStyle === 'select') {
    const select = new StringSelectMenuBuilder()
      .setCustomId('wpage_select')
      .setPlaceholder(config.menuPlaceholder.slice(0, 150) || 'Découvrir le serveur...')
      .addOptions(pages.map((page) => ({
        label: page.label.slice(0, 100),
        value: page.id,
        ...(page.summary ? { description: page.summary.slice(0, 100) } : {}),
        ...(page.emoji ? { emoji: page.emoji } : {}),
      })));

    return [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(select)];
  }

  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  for (let i = 0; i < pages.length; i += 5) {
    const row = new ActionRowBuilder<MessageActionRowComponentBuilder>();
    for (const page of pages.slice(i, i + 5)) {
      // Les pages "Lien" utilisent un vrai bouton de lien Discord : navigation
      // gérée côté client, aucune interaction n'est envoyée au bot.
      if (page.actionType === 'LINK' && page.linkUrl) {
        const linkButton = new ButtonBuilder()
          .setLabel(page.label.slice(0, 80))
          .setStyle(ButtonStyle.Link)
          .setURL(page.linkUrl);
        if (page.emoji) linkButton.setEmoji(page.emoji);
        row.addComponents(linkButton);
        continue;
      }

      const button = new ButtonBuilder()
        .setCustomId(`wpage:${page.id}`)
        .setLabel(page.label.slice(0, 80))
        .setStyle(page.actionType === 'ROLE' ? ButtonStyle.Success : ButtonStyle.Secondary);
      if (page.emoji) button.setEmoji(page.emoji);
      row.addComponents(button);
    }
    rows.push(row);
  }
  return rows;
}

export function buildMenuPageEmbed(page: WelcomeMenuPage, ctx?: PlaceholderContext): EmbedBuilder {
  const titleRaw = page.embedTitle ?? '';
  const descriptionRaw = page.embedDescription ?? '';
  const title = ctx ? resolvePlaceholders(titleRaw, ctx) : titleRaw;
  const description = ctx ? resolvePlaceholders(descriptionRaw, ctx) : descriptionRaw;

  const embed = new EmbedBuilder()
    .setTitle(title.slice(0, 256))
    .setDescription(description.slice(0, 4096))
    .setColor(parseEmbedColor(page.embedColor));

  if (page.embedImageUrl) embed.setImage(page.embedImageUrl);
  if (page.embedThumbnailUrl) embed.setThumbnail(page.embedThumbnailUrl);
  return embed;
}

function normalizeRoleGroup(value: string | null | undefined): string {
  return value?.trim().replace(/\s+/g, ' ').toLocaleLowerCase('fr-FR') || '';
}

export function resolveExclusiveRoleIds(
  page: Pick<WelcomeMenuPage, 'roleId' | 'roleGroup'>,
  pages: Array<Pick<WelcomeMenuPage, 'actionType' | 'roleAction' | 'roleId' | 'roleGroup'>>,
): string[] {
  const targetRoleId = page.roleId;
  const groupKey = normalizeRoleGroup(page.roleGroup);
  if (!targetRoleId || !groupKey) return [];

  return [...new Set(pages
    .filter((candidate) =>
      candidate.actionType === 'ROLE'
      && candidate.roleAction === 'EXCLUSIVE'
      && normalizeRoleGroup(candidate.roleGroup) === groupKey
      && candidate.roleId
      && candidate.roleId !== targetRoleId
    )
    .map((candidate) => candidate.roleId as string))];
}

async function withExclusiveRoleLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = exclusiveRoleLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => gate);
  exclusiveRoleLocks.set(key, queued);

  await previous;
  try {
    return await task();
  } finally {
    release();
    if (exclusiveRoleLocks.get(key) === queued) exclusiveRoleLocks.delete(key);
  }
}

/**
 * Ajoute, retire ou bascule le rôle configuré sur une page "Rôle" du menu d'accueil
 */
// Appelée uniquement après que handleWelcomeMenuInteraction a différé la réponse : les
// requêtes DB et appels de rôle qui suivent peuvent dépasser la fenêtre de 3s que Discord
// laisse pour un reply() direct (interaction « Unknown interaction », code 10062).
async function handleMenuRoleAction(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  guild: Guild,
  page: WelcomeMenuPage,
  member: GuildMember | undefined,
): Promise<void> {
  const roleId = page.roleId;
  if (!roleId || !member) {
    await interaction.editReply({
      content: "❌ Ce bouton n'est pas correctement configuré.",
    }).catch(() => null);
    return;
  }

  const role = guild.roles.cache.get(roleId);
  const botMember = guild.members.me;
  if (!role || !botMember) {
    await interaction.editReply({
      content: '❌ Le rôle configuré est introuvable.',
    }).catch(() => null);
    return;
  }

  if (role.managed || role.position >= botMember.roles.highest.position) {
    await interaction.editReply({
      content: '❌ Le bot ne peut pas gérer ce rôle (rôle intégré ou supérieur à son propre rôle le plus élevé).',
    }).catch(() => null);
    return;
  }

  const hasRole = member.roles.cache.has(roleId);

  try {
    if (page.roleAction === 'EXCLUSIVE') {
      const groupKey = normalizeRoleGroup(page.roleGroup);
      if (!groupKey) {
        await interaction.editReply({ content: "❌ Ce choix exclusif n'a pas de groupe configuré." });
        return;
      }

      await withExclusiveRoleLock(`${guild.id}:${member.id}:${groupKey}`, async () => {
        const exclusivePages = await prisma.welcomeMenuPage.findMany({
          where: { guildId: guild.id, actionType: 'ROLE', roleAction: 'EXCLUSIVE' },
          select: { actionType: true, roleAction: true, roleId: true, roleGroup: true },
        });
        const conflictingRoleIds = resolveExclusiveRoleIds(page, exclusivePages);
        if (conflictingRoleIds.length === 0) {
          await interaction.editReply({ content: '❌ Ce groupe exclusif doit contenir au moins deux rôles.' });
          return;
        }

        const targetAlreadyPresent = member.roles.cache.has(roleId);
        const heldConflictingRoleIds = conflictingRoleIds.filter((id) => member.roles.cache.has(id));
        const unmanageableRole = heldConflictingRoleIds
          .map((id) => guild.roles.cache.get(id))
          .find((candidate) => candidate && (candidate.managed || candidate.position >= botMember.roles.highest.position));

        if (unmanageableRole) {
          await interaction.editReply({
            content: `❌ Le bot ne peut pas retirer le rôle concurrent <@&${unmanageableRole.id}>. Placez le rôle de Kotbo au-dessus des rôles du groupe.`,
          });
          return;
        }

        if (targetAlreadyPresent && heldConflictingRoleIds.length === 0) {
          await interaction.editReply({ content: `ℹ️ Vous avez déjà choisi le rôle <@&${roleId}>.` });
          return;
        }

        let targetAdded = false;
        try {
          if (!targetAlreadyPresent) {
            await member.roles.add(roleId, `Choix exclusif « ${page.roleGroup} »`);
            targetAdded = true;
          }
          if (heldConflictingRoleIds.length > 0) {
            await member.roles.remove(heldConflictingRoleIds, `Remplacement dans le groupe exclusif « ${page.roleGroup} »`);
          }
        } catch (err) {
          if (targetAdded) {
            await member.roles.remove(roleId, 'Annulation après échec du choix exclusif').catch(() => null);
          }
          throw err;
        }

        const removedText = heldConflictingRoleIds.length > 0
          ? ` Le${heldConflictingRoleIds.length > 1 ? 's' : ''} rôle${heldConflictingRoleIds.length > 1 ? 's' : ''} ${heldConflictingRoleIds.map((id) => `<@&${id}>`).join(', ')} ${heldConflictingRoleIds.length > 1 ? 'ont' : 'a'} été retiré${heldConflictingRoleIds.length > 1 ? 's' : ''}.`
          : '';
        await interaction.editReply({
          content: `✅ Votre choix est maintenant <@&${roleId}>.${removedText}`,
        });
      });
      return;
    }

    if (page.roleAction === 'REMOVE') {
      if (!hasRole) {
        await interaction.editReply({ content: `ℹ️ Vous n'avez pas le rôle <@&${roleId}>.` });
        return;
      }
      await member.roles.remove(roleId);
      await interaction.editReply({ content: `✅ Le rôle <@&${roleId}> vous a été retiré.` });
      return;
    }

    if (page.roleAction === 'TOGGLE') {
      if (hasRole) {
        await member.roles.remove(roleId);
        await interaction.editReply({ content: `✅ Le rôle <@&${roleId}> vous a été retiré.` });
      } else {
        await member.roles.add(roleId);
        await interaction.editReply({ content: `✅ Le rôle <@&${roleId}> vous a été attribué.` });
      }
      return;
    }

    // ADD (défaut)
    if (hasRole) {
      await interaction.editReply({ content: `ℹ️ Vous avez déjà le rôle <@&${roleId}>.` });
      return;
    }
    await member.roles.add(roleId);
    await interaction.editReply({ content: `✅ Le rôle <@&${roleId}> vous a été attribué.` });
  } catch (err) {
    logger.warn(TAG, `Erreur gestion de rôle (menu accueil) pour ${member.id}:`, err);
    await interaction.editReply({
      content: '❌ Une erreur est survenue (permissions insuffisantes du bot pour gérer ce rôle).',
    }).catch(() => null);
  }
}

/**
 * Répond aux clics sur le menu de présentation (bouton `wpage:<id>` ou menu déroulant `wpage_select`)
 */
export async function handleWelcomeMenuInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): Promise<void> {
  const { guildId, guild } = interaction;
  if (!guildId || !guild) return;

  const pageId = interaction.isButton()
    ? interaction.customId.split(':')[1]
    : interaction.values[0];
  if (!pageId) return;

  // Différer avant toute requête DB/appel de rôle : au-delà de 3s sans accusé de
  // réception, Discord invalide le token et reply()/editReply() échouent en
  // « Unknown interaction » (code 10062).
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }).catch(() => null);

  const page = await prisma.welcomeMenuPage.findFirst({ where: { id: pageId, guildId } });
  if (!page) {
    await interaction.editReply({
      content: "❌ Cette page de présentation n'existe plus.",
    }).catch(() => null);
    return;
  }

  const member = interaction.member && 'guild' in interaction.member ? interaction.member as GuildMember : undefined;

  if (page.actionType === 'ROLE') {
    await handleMenuRoleAction(interaction, guild, page, member);
    return;
  }

  if (page.actionType === 'LINK') {
    const url = page.linkUrl?.trim();
    await interaction.editReply({
      content: url ? `🔗 ${url}` : "❌ Aucun lien n'est configuré pour ce bouton.",
    }).catch(() => null);
    return;
  }

  const embed = buildMenuPageEmbed(page, { guild, member });
  await interaction.editReply({ embeds: [embed] }).catch(() => null);
}
