/**
 * Envoi des annonces globales Kotbo.
 *
 * Extrait de `routes/admin.ts`, ou la logique d'envoi vivait au milieu du
 * routeur et ne remontait que deux compteurs agreges. Le service ajoute :
 *   - un resultat serveur par serveur (salon retenu, raison d'echec) ;
 *   - un cycle de vie (brouillon, programme, en cours, envoye, annule) ;
 *   - la validation des URL d'image avant diffusion.
 */
import type { ButtonInteraction, Client, ModalSubmitInteraction } from 'discord.js';
import {
  ActionRowBuilder, ChannelType, EmbedBuilder, MessageFlags, ModalBuilder,
  PermissionFlagsBits, Routes, TextInputBuilder, TextInputStyle, WebhookType,
  type ColorResolvable,
} from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { resolveEmojiShortcodes, resolveEmojiShortcodesToUnicode } from '../../utils/emojis.js';
import { checkEmbedImageUrl, markBroadcastMediaUsed } from './broadcastMediaService.js';
import { UserFacingError } from '../../utils/userFacingError.js';

export type BroadcastTarget = 'ALL' | 'ACTIVATED' | 'CUSTOM';
export type BroadcastChannelPref = 'AUTO' | 'NEWS' | 'PUBLIC' | 'STAFF' | 'FALLBACK';
export type BroadcastStatus = 'DRAFT' | 'SCHEDULED' | 'SENDING' | 'SENT' | 'CANCELLED' | 'FAILED';

export interface BroadcastContent {
  title?: string;
  message: string;
  color?: string;
  thumbnailUrl?: string | null;
  imageUrl?: string | null;
  footerText?: string;
  target?: BroadcastTarget;
  targetGuilds?: string[];
  channelPref?: BroadcastChannelPref;
  /** 2 a 5 choix : un bouton par option, une rangee Discord n'en porte pas plus. */
  pollOptions?: string[];
  /** ISO 8601. Passe cette date, les votes sont refuses. */
  pollClosesAt?: string | null;
  /** Libelle du bouton : present = demande d'avis (bouton -> formulaire) au lieu d'un sondage. */
  feedbackLabel?: string | null;
  /** Variante anglaise ; le texte de base est en français. */
  translations?: BroadcastTranslations | null;
}

// `type` et non `interface` : Prisma exige une signature d'index pour les colonnes JSON.
export type BroadcastTranslation = { title?: string; message?: string; footerText?: string };
export type BroadcastTranslations = { en?: BroadcastTranslation };
/** Textes d'une langue une fois resolus (rien d'optionnel). */
export interface BroadcastText { title: string; message: string; footerText: string }

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 5;
export const POLL_BUTTON_PREFIX = 'bcpoll:';
export const FEEDBACK_BUTTON_PREFIX = 'bcfb:';
export const FEEDBACK_MODAL_PREFIX = 'bcfbm:';

export const DEFAULT_BROADCAST_TITLE = '📢 Annonce Globale Kotbo';
export const DEFAULT_BROADCAST_FOOTER = "Système d'annonce globale Kotbo";
export const DEFAULT_BROADCAST_TITLE_EN = '📢 Kotbo Global Announcement';
export const DEFAULT_BROADCAST_FOOTER_EN = 'Kotbo global announcement system';

/**
 * Langue d'un serveur : choix explicite (`Guild.language`), sinon langue
 * Discord du serveur, sinon anglais. Meme cascade que `resolveGuildLocale`.
 */
export function pickBroadcastLocale(language: string | null | undefined, preferredLocale: string | null | undefined): 'fr' | 'en' {
  if (language === 'fr' || language === 'en') return language;
  return (preferredLocale ?? '').toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

/** Texte a envoyer a un serveur : la variante anglaise si elle existe, le texte de base sinon. */
export function pickBroadcastText(
  base: BroadcastText,
  translations: BroadcastTranslations | null | undefined,
  locale: 'fr' | 'en',
): BroadcastText {
  const en = translations?.en;
  return locale === 'en' && en?.message
    ? { title: en.title || base.title, message: en.message, footerText: en.footerText || base.footerText }
    : base;
}

interface GuildChannelConfig {
  language: string | null;
  broadcastChannelId: string | null;
  newsChannelId: string | null;
  publicChannelId: string | null;
  staffAnnouncementChannelId: string | null;
}

export interface DeliveryResult {
  guildId: string;
  guildName: string;
  channelId: string | null;
  channelName: string | null;
  status: 'SENT' | 'FAILED' | 'SKIPPED';
  reason: string | null;
  messageId: string | null;
}

export class BroadcastValidationError extends UserFacingError {
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = 'BroadcastValidationError';
  }
}

/**
 * Normalise le contenu et refuse ce que Discord ne saura pas afficher.
 * Les URL d'image sont le point sensible : voir `checkEmbedImageUrl`.
 */
export function normalizeBroadcastContent(content: BroadcastContent): {
  title: string;
  message: string;
  color: string;
  thumbnailUrl: string | null;
  imageUrl: string | null;
  footerText: string;
  target: BroadcastTarget;
  targetGuilds: string[];
  channelPref: BroadcastChannelPref;
  pollOptions: string[];
  pollClosesAt: Date | null;
  feedbackLabel: string | null;
  translations: BroadcastTranslations | null;
  warnings: string[];
} {
  const message = content.message?.trim();
  if (!message) throw new BroadcastValidationError('Message requis', 'message');
  if (message.length > 4000) {
    throw new BroadcastValidationError('Le message dépasse la limite Discord de 4000 caractères.', 'message');
  }

  const title = resolveEmojiShortcodesToUnicode(content.title?.trim() || DEFAULT_BROADCAST_TITLE);
  if (title.length > 256) {
    throw new BroadcastValidationError('Le titre dépasse la limite Discord de 256 caractères.', 'title');
  }

  const footerText = resolveEmojiShortcodesToUnicode(content.footerText?.trim() || DEFAULT_BROADCAST_FOOTER);
  if (footerText.length > 2048) {
    throw new BroadcastValidationError('Le pied de page dépasse la limite Discord de 2048 caractères.', 'footerText');
  }

  const rawColor = (content.color || '#5865F2').trim();
  const color = /^#[0-9a-fA-F]{6}$/.test(rawColor) ? rawColor.toUpperCase() : '#5865F2';

  const warnings: string[] = [];

  const thumbnail = checkEmbedImageUrl(content.thumbnailUrl);
  if (!thumbnail.ok) throw new BroadcastValidationError(thumbnail.message ?? 'Vignette invalide.', 'thumbnailUrl');
  if (thumbnail.message) warnings.push(`Vignette : ${thumbnail.message}`);

  const image = checkEmbedImageUrl(content.imageUrl);
  if (!image.ok) throw new BroadcastValidationError(image.message ?? 'Image invalide.', 'imageUrl');
  if (image.message) warnings.push(`Image : ${image.message}`);

  const target: BroadcastTarget = content.target ?? 'ALL';
  const targetGuilds = Array.isArray(content.targetGuilds) ? content.targetGuilds.filter((id) => /^\d{17,20}$/.test(id)) : [];
  if (target === 'CUSTOM' && targetGuilds.length === 0) {
    throw new BroadcastValidationError('Sélectionnez au moins un serveur pour un ciblage personnalisé.', 'targetGuilds');
  }

  const pollOptions = [...new Set((content.pollOptions ?? []).map((option) => option.trim()).filter(Boolean))];
  if (pollOptions.length > 0 && (pollOptions.length < POLL_MIN_OPTIONS || pollOptions.length > POLL_MAX_OPTIONS)) {
    throw new BroadcastValidationError(
      `Un sondage demande entre ${POLL_MIN_OPTIONS} et ${POLL_MAX_OPTIONS} options distinctes.`,
      'pollOptions',
    );
  }
  if (pollOptions.some((option) => option.length > 80)) {
    throw new BroadcastValidationError('Une option de sondage dépasse 80 caractères.', 'pollOptions');
  }

  const feedbackLabel = content.feedbackLabel?.trim() || null;
  if (feedbackLabel && feedbackLabel.length > 80) {
    throw new BroadcastValidationError('Le libellé du bouton dépasse 80 caractères.', 'feedbackLabel');
  }
  if (feedbackLabel && pollOptions.length > 0) {
    throw new BroadcastValidationError('Une annonce porte un sondage ou une demande d’avis, pas les deux.', 'feedbackLabel');
  }

  let pollClosesAt: Date | null = null;
  if ((pollOptions.length > 0 || feedbackLabel) && content.pollClosesAt) {
    pollClosesAt = new Date(content.pollClosesAt);
    if (Number.isNaN(pollClosesAt.getTime()) || pollClosesAt.getTime() <= Date.now()) {
      throw new BroadcastValidationError('La clôture du sondage doit être dans le futur.', 'pollClosesAt');
    }
  }

  // Variante anglaise : le message est requis des qu'un champ est rempli ;
  // titre et pied vides retombent sur le defaut anglais (si le base est le defaut) ou sur le base.
  const en = content.translations?.en;
  const enMessage = en?.message?.trim();
  const enTitle = en?.title?.trim();
  const enFooter = en?.footerText?.trim();
  let translations: BroadcastTranslations | null = null;
  if (enMessage || enTitle || enFooter) {
    if (!enMessage) throw new BroadcastValidationError('Le message anglais est requis.', 'translations');
    if (enMessage.length > 4000) throw new BroadcastValidationError('Le message anglais dépasse 4000 caractères.', 'translations');
    if ((enTitle?.length ?? 0) > 256) throw new BroadcastValidationError('Le titre anglais dépasse 256 caractères.', 'translations');
    if ((enFooter?.length ?? 0) > 2048) throw new BroadcastValidationError('Le pied de page anglais dépasse 2048 caractères.', 'translations');
    translations = {
      en: {
        title: resolveEmojiShortcodesToUnicode(enTitle || (title === resolveEmojiShortcodesToUnicode(DEFAULT_BROADCAST_TITLE) ? DEFAULT_BROADCAST_TITLE_EN : title)),
        message: resolveEmojiShortcodes(enMessage),
        footerText: resolveEmojiShortcodesToUnicode(enFooter || (footerText === DEFAULT_BROADCAST_FOOTER ? DEFAULT_BROADCAST_FOOTER_EN : footerText)),
      },
    };
  }

  return {
    title,
    message: resolveEmojiShortcodes(message),
    color,
    thumbnailUrl: thumbnail.value,
    imageUrl: image.value,
    footerText,
    target,
    targetGuilds,
    channelPref: content.channelPref ?? 'AUTO',
    pollOptions,
    pollClosesAt,
    feedbackLabel,
    translations,
    warnings,
  };
}

/** Rangee de boutons du sondage, en JSON brut : `broadcastEval` ne transporte pas de builders. */
function buildPollComponents(broadcastId: string, options: string[]) {
  return [{
    type: 1,
    components: options.map((label, index) => ({
      type: 2,
      style: 2,
      label,
      custom_id: `${POLL_BUTTON_PREFIX}${broadcastId}:${index}`,
    })),
  }];
}

/** Bouton unique qui ouvre le formulaire d'avis. */
function buildFeedbackComponents(broadcastId: string, label: string) {
  return [{
    type: 1,
    components: [{ type: 2, style: 1, label, custom_id: `${FEEDBACK_BUTTON_PREFIX}${broadcastId}` }],
  }];
}

/** Ordre de repli des salons, identique dans le processus principal et dans les shards. */
function buildChannelPreference(config: GuildChannelConfig | undefined, pref: BroadcastChannelPref): string[] {
  const order: (string | null | undefined)[] = [config?.broadcastChannelId];
  if (pref === 'NEWS') order.push(config?.newsChannelId, config?.publicChannelId);
  else if (pref === 'PUBLIC') order.push(config?.publicChannelId, config?.newsChannelId);
  else if (pref === 'STAFF') order.push(config?.staffAnnouncementChannelId, config?.newsChannelId);
  else if (pref === 'FALLBACK') order.push(config?.newsChannelId, config?.publicChannelId, config?.staffAnnouncementChannelId);
  else order.push(config?.newsChannelId, config?.publicChannelId, config?.staffAnnouncementChannelId);
  return order.filter((id): id is string => Boolean(id));
}

export async function loadGuildChannelMap(): Promise<Record<string, GuildChannelConfig>> {
  const rows = await prisma.guild.findMany({
    select: {
      id: true,
      language: true,
      broadcastChannelId: true,
      newsChannelId: true,
      publicChannelId: true,
      staffAnnouncementChannelId: true,
    },
  });
  const map: Record<string, GuildChannelConfig> = Object.create(null);
  for (const row of rows) {
    map[row.id] = {
      language: row.language,
      broadcastChannelId: row.broadcastChannelId,
      newsChannelId: row.newsChannelId,
      publicChannelId: row.publicChannelId,
      staffAnnouncementChannelId: row.staffAnnouncementChannelId,
    };
  }
  return map;
}

/**
 * Resout la liste des serveurs cibles.
 *
 * `ALL` inclut les serveurs presents en cache Discord meme s'ils n'ont pas
 * encore de ligne en base : sinon un serveur fraichement rejoint ne recevrait
 * aucune annonce globale.
 */
export async function resolveTargetGuildIds(
  client: Client,
  target: BroadcastTarget,
  targetGuilds: string[],
  collectShardGuilds: (client: Client) => Promise<{ id: string }[]>,
): Promise<Set<string>> {
  const dbGuilds = await prisma.guild.findMany({ select: { id: true, activated: true } });
  const allowed = new Set<string>();

  for (const guild of dbGuilds) {
    if (target === 'ALL') allowed.add(guild.id);
    else if (target === 'ACTIVATED' && guild.activated) allowed.add(guild.id);
    else if (target === 'CUSTOM' && targetGuilds.includes(guild.id)) allowed.add(guild.id);
  }

  if (target === 'ALL') {
    for (const guild of await collectShardGuilds(client)) allowed.add(guild.id);
  }

  return allowed;
}

interface ShardBroadcastContext {
  embed: {
    title: string;
    message: string;
    color: string;
    thumbnailUrl: string | null;
    imageUrl: string | null;
    footerText: string;
  };
  channelMap: Record<string, GuildChannelConfig>;
  allowedIds: string[];
  channelPref: BroadcastChannelPref;
  translations: BroadcastTranslations | null;
  components: ReturnType<typeof buildPollComponents> | ReturnType<typeof buildFeedbackComponents> | undefined;
}

/**
 * Diffuse l'annonce et renvoie le detail par serveur.
 *
 * Le corps de `broadcastEval` est serialise puis execute dans chaque shard :
 * il ne peut donc rien capturer du scope courant, d'ou la duplication de la
 * logique de choix de salon dans la fonction inline.
 */
export async function deliverBroadcast(
  client: Client,
  params: {
    title: string;
    message: string;
    color: string;
    thumbnailUrl: string | null;
    imageUrl: string | null;
    footerText: string;
    channelPref: BroadcastChannelPref;
    allowedIds: string[];
    channelMap: Record<string, GuildChannelConfig>;
    /** Variante par langue, choisie serveur par serveur d'apres sa configuration. */
    translations?: BroadcastTranslations | null;
    /** Present = l'annonce porte un sondage ; `broadcastId` sert d'ancre aux boutons. */
    poll?: { broadcastId: string; options: string[] };
    /** Present = demande d'avis : un bouton ouvre un formulaire. */
    feedback?: { broadcastId: string; label: string };
  },
): Promise<DeliveryResult[]> {
  const components = params.feedback
    ? buildFeedbackComponents(params.feedback.broadcastId, params.feedback.label)
    : params.poll && params.poll.options.length > 0
      ? buildPollComponents(params.poll.broadcastId, params.poll.options)
      : undefined;
  const context: ShardBroadcastContext = {
    components,
    embed: {
      title: params.title,
      message: params.message,
      color: params.color,
      thumbnailUrl: params.thumbnailUrl,
      imageUrl: params.imageUrl,
      footerText: params.footerText,
    },
    channelMap: params.channelMap,
    allowedIds: params.allowedIds,
    channelPref: params.channelPref,
    translations: params.translations ?? null,
  };

  if (client.shard) {
    const results = await client.shard.broadcastEval<DeliveryResult[], ShardBroadcastContext>(
      async (shardClient, ctx) => {
        const { EmbedBuilder: ShardEmbed } = await import('discord.js');
        const out: DeliveryResult[] = [];

        for (const [id, guild] of shardClient.guilds.cache) {
          if (!ctx.allowedIds.includes(id)) continue;

          const config = ctx.channelMap[id];
          const order: (string | null | undefined)[] = [config?.broadcastChannelId];
          if (ctx.channelPref === 'NEWS') order.push(config?.newsChannelId, config?.publicChannelId);
          else if (ctx.channelPref === 'PUBLIC') order.push(config?.publicChannelId, config?.newsChannelId);
          else if (ctx.channelPref === 'STAFF') order.push(config?.staffAnnouncementChannelId, config?.newsChannelId);
          else order.push(config?.newsChannelId, config?.publicChannelId, config?.staffAnnouncementChannelId);

          let channel = null as null | { id: string; name: string; isTextBased: () => boolean; send: (payload: unknown) => Promise<{ id: string }> };

          for (const channelId of order) {
            if (!channelId) continue;
            const found = guild.channels.cache.get(channelId);
            if (found && (found.type === 0 || found.type === 5)) {
              channel = found as unknown as typeof channel;
              break;
            }
          }

          if (!channel) {
            const fallback = guild.channels.cache.find(
              (c) => c.type === 0 && c.permissionsFor(shardClient.user!)?.has('SendMessages'),
            );
            channel = (fallback ?? null) as unknown as typeof channel;
          }

          if (!channel) {
            out.push({
              guildId: id,
              guildName: guild.name,
              channelId: null,
              channelName: null,
              status: 'SKIPPED',
              reason: "Aucun salon textuel accessible : configurez un salon de broadcast pour ce serveur.",
              messageId: null,
            });
            continue;
          }

          try {
            // Meme cascade que pickBroadcastLocale/pickBroadcastText (non capturables ici).
            const lang = config?.language === 'fr' || config?.language === 'en'
              ? config.language
              : String(guild.preferredLocale ?? '').toLowerCase().startsWith('fr') ? 'fr' : 'en';
            const en = ctx.translations?.en;
            const useEn = lang === 'en' && Boolean(en?.message);
            const embed = new ShardEmbed()
              .setTitle(useEn ? (en!.title || ctx.embed.title) : ctx.embed.title)
              .setDescription(useEn ? en!.message! : ctx.embed.message)
              .setColor(parseInt(ctx.embed.color.replace('#', ''), 16))
              .setFooter({ text: useEn ? (en!.footerText || ctx.embed.footerText) : ctx.embed.footerText })
              .setTimestamp();
            if (ctx.embed.thumbnailUrl) embed.setThumbnail(ctx.embed.thumbnailUrl);
            if (ctx.embed.imageUrl) embed.setImage(ctx.embed.imageUrl);

            const sent = await channel.send({ embeds: [embed], ...(ctx.components ? { components: ctx.components } : {}) });
            out.push({
              guildId: id,
              guildName: guild.name,
              channelId: channel.id,
              channelName: channel.name,
              status: 'SENT',
              reason: null,
              messageId: sent.id,
            });
          } catch (err) {
            out.push({
              guildId: id,
              guildName: guild.name,
              channelId: channel.id,
              channelName: channel.name,
              status: 'FAILED',
              reason: (err as Error).message?.slice(0, 300) ?? 'Erreur inconnue',
              messageId: null,
            });
          }
        }

        return out;
      },
      { context },
    );

    return results.flat();
  }

  // Processus unique (developpement, ou bot non sharde).
  const out: DeliveryResult[] = [];
  for (const [id, guild] of client.guilds.cache) {
    if (!params.allowedIds.includes(id)) continue;

    const order = buildChannelPreference(params.channelMap[id], params.channelPref);
    let channel = order
      .map((channelId) => guild.channels.cache.get(channelId))
      .find((found) => found && (found.type === 0 || found.type === 5));

    if (!channel) {
      channel = guild.channels.cache.find(
        (c) => c.type === 0 && c.permissionsFor(client.user!)?.has('SendMessages'),
      );
    }

    if (!channel || !channel.isTextBased()) {
      out.push({
        guildId: id,
        guildName: guild.name,
        channelId: null,
        channelName: null,
        status: 'SKIPPED',
        reason: "Aucun salon textuel accessible : configurez un salon de broadcast pour ce serveur.",
        messageId: null,
      });
      continue;
    }

    try {
      const text = pickBroadcastText(
        { title: params.title, message: params.message, footerText: params.footerText },
        params.translations,
        pickBroadcastLocale(params.channelMap[id]?.language, guild.preferredLocale),
      );
      const embed = new EmbedBuilder()
        .setTitle(text.title)
        .setDescription(text.message)
        .setColor(params.color as ColorResolvable)
        .setFooter({ text: text.footerText })
        .setTimestamp();
      if (params.thumbnailUrl) embed.setThumbnail(params.thumbnailUrl);
      if (params.imageUrl) embed.setImage(params.imageUrl);

      const sent = await channel.send({ embeds: [embed], ...(components ? { components } : {}) });
      out.push({
        guildId: id,
        guildName: guild.name,
        channelId: channel.id,
        channelName: 'name' in channel ? String(channel.name) : null,
        status: 'SENT',
        reason: null,
        messageId: sent.id,
      });
    } catch (err) {
      out.push({
        guildId: id,
        guildName: guild.name,
        channelId: channel.id,
        channelName: 'name' in channel ? String(channel.name) : null,
        status: 'FAILED',
        reason: (err as Error).message?.slice(0, 300) ?? 'Erreur inconnue',
        messageId: null,
      });
    }
  }
  return out;
}

export interface PollResults {
  options: { label: string; votes: number }[];
  total: number;
  closesAt: Date | null;
  /** Votes par serveur, du plus au moins representatif. */
  byGuild: { guildId: string; votes: number }[];
}

export async function getPollResults(broadcastId: string): Promise<PollResults | null> {
  const broadcast = await prisma.broadcastLog.findUnique({
    where: { id: broadcastId },
    select: { pollOptions: true, pollClosesAt: true },
  });
  if (!broadcast || broadcast.pollOptions.length === 0) return null;

  const [byOption, byGuild] = await Promise.all([
    prisma.broadcastPollVote.groupBy({ by: ['optionIndex'], where: { broadcastId }, _count: { _all: true } }),
    prisma.broadcastPollVote.groupBy({ by: ['guildId'], where: { broadcastId }, _count: { _all: true } }),
  ]);
  const counts = new Map(byOption.map((row) => [row.optionIndex, row._count._all]));
  const options = broadcast.pollOptions.map((label, index) => ({ label, votes: counts.get(index) ?? 0 }));

  return {
    options,
    total: options.reduce((sum, option) => sum + option.votes, 0),
    closesAt: broadcast.pollClosesAt,
    byGuild: byGuild
      .map((row) => ({ guildId: row.guildId, votes: row._count._all }))
      .sort((a, b) => b.votes - a.votes),
  };
}

function formatPollResults(results: PollResults, chosen: number): string {
  return results.options
    .map((option, index) => {
      const percent = results.total > 0 ? Math.round((option.votes / results.total) * 100) : 0;
      return `${index === chosen ? '▸' : '▫️'} **${option.label}** : ${option.votes} (${percent} %)`;
    })
    .join('\n');
}

/** Bouton `bcpoll:<broadcastId>:<index>` : enregistre le vote puis montre l'etat global, en prive. */
export async function handleBroadcastPollVote(interaction: ButtonInteraction): Promise<void> {
  const [, broadcastId, rawIndex] = interaction.customId.split(':');
  const optionIndex = Number.parseInt(rawIndex ?? '', 10);
  const reply = (content: string) => interaction.reply({ content, flags: [MessageFlags.Ephemeral] });

  const broadcast = broadcastId
    ? await prisma.broadcastLog.findUnique({
      where: { id: broadcastId },
      select: { pollOptions: true, pollClosesAt: true },
    })
    : null;
  if (!broadcast || !Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= broadcast.pollOptions.length) {
    await reply('Ce sondage n’existe plus.');
    return;
  }
  if (broadcast.pollClosesAt && broadcast.pollClosesAt.getTime() <= Date.now()) {
    const closed = await getPollResults(broadcastId);
    await reply(`Ce sondage est clos.${closed ? `\n\n${formatPollResults(closed, -1)}` : ''}`);
    return;
  }

  await prisma.broadcastPollVote.upsert({
    where: { broadcastId_userId: { broadcastId, userId: interaction.user.id } },
    update: { optionIndex, guildId: interaction.guildId ?? 'dm' },
    create: { broadcastId, userId: interaction.user.id, guildId: interaction.guildId ?? 'dm', optionIndex },
  });

  const results = await getPollResults(broadcastId);
  await reply(
    `Vote enregistré : **${broadcast.pollOptions[optionIndex]}**. Tu peux le changer en cliquant sur une autre option.`
    + (results ? `\n\n${formatPollResults(results, optionIndex)}\n_${results.total} vote(s), tous serveurs confondus_` : ''),
  );
}

/** Annonce ouverte aux avis, ou `null` (inconnue, sans demande d'avis, ou close). */
async function findOpenFeedbackBroadcast(broadcastId: string | undefined) {
  if (!broadcastId) return { broadcast: null, closed: false };
  const broadcast = await prisma.broadcastLog.findUnique({
    where: { id: broadcastId },
    select: { feedbackLabel: true, pollClosesAt: true, title: true },
  });
  if (!broadcast?.feedbackLabel) return { broadcast: null, closed: false };
  const closed = Boolean(broadcast.pollClosesAt && broadcast.pollClosesAt.getTime() <= Date.now());
  return { broadcast: closed ? null : broadcast, closed };
}

/** Bouton `bcfb:<broadcastId>` : ouvre le formulaire d'avis. */
export async function handleBroadcastFeedbackButton(interaction: ButtonInteraction): Promise<void> {
  const broadcastId = interaction.customId.split(':')[1];
  const { broadcast, closed } = await findOpenFeedbackBroadcast(broadcastId);
  if (!broadcast) {
    await interaction.reply({
      content: closed ? 'Cette demande d’avis est close.' : 'Cette demande d’avis n’existe plus.',
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`${FEEDBACK_MODAL_PREFIX}${broadcastId}`)
    .setTitle(broadcast.title.slice(0, 45))
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('content')
        .setLabel('Ton retour')
        .setStyle(TextInputStyle.Paragraph)
        .setMinLength(5)
        .setMaxLength(1500)
        .setRequired(true),
    ));
  await interaction.showModal(modal);
}

/** Formulaire `bcfbm:<broadcastId>` : un avis par envoi, plusieurs par personne autorises. */
export async function handleBroadcastFeedbackSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  const broadcastId = interaction.customId.split(':')[1];
  const { broadcast, closed } = await findOpenFeedbackBroadcast(broadcastId);
  if (!broadcastId || !broadcast) {
    await interaction.reply({
      content: closed ? 'Cette demande d’avis est close.' : 'Cette demande d’avis n’existe plus.',
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  const content = interaction.fields.getTextInputValue('content').trim().slice(0, 1500);
  if (!content) {
    await interaction.reply({ content: 'Ton retour est vide.', flags: [MessageFlags.Ephemeral] });
    return;
  }
  await prisma.broadcastFeedback.create({
    data: { broadcastId, userId: interaction.user.id, guildId: interaction.guildId ?? 'dm', content },
  });
  await interaction.reply({ content: 'Merci, ton retour a bien été transmis à l’équipe Kotbo.', flags: [MessageFlags.Ephemeral] });
}

/** Persiste le detail d'envoi et met le broadcast dans son etat final. */
export async function finalizeBroadcast(
  broadcastId: string,
  deliveries: DeliveryResult[],
  totalTargeted: number,
): Promise<{ successCount: number; failCount: number }> {
  const successCount = deliveries.filter((d) => d.status === 'SENT').length;
  const failCount = deliveries.length - successCount;

  if (deliveries.length > 0) {
    await prisma.broadcastDelivery.createMany({
      data: deliveries.map((delivery) => ({
        broadcastId,
        guildId: delivery.guildId,
        guildName: delivery.guildName.slice(0, 200),
        channelId: delivery.channelId,
        channelName: delivery.channelName?.slice(0, 200) ?? null,
        status: delivery.status,
        reason: delivery.reason?.slice(0, 500) ?? null,
        messageId: delivery.messageId,
      })),
      skipDuplicates: true,
    });
  }

  await prisma.broadcastLog.update({
    where: { id: broadcastId },
    data: {
      status: successCount === 0 && totalTargeted > 0 ? 'FAILED' : 'SENT',
      successCount,
      failCount,
      totalTargeted,
      finishedAt: new Date(),
    },
  });

  return { successCount, failCount };
}

export const BROADCAST_SOURCE_CHANNEL_KEY = 'BROADCAST_SOURCE_CHANNEL';

export interface BroadcastSourceConfig {
  guildId: string;
  channelId: string;
}

export interface BroadcastSubscribeResult {
  guildId: string;
  guildName: string;
  channelId: string | null;
  channelName: string | null;
  status: 'SUBSCRIBED' | 'ALREADY_SUBSCRIBED' | 'SKIPPED' | 'FAILED';
  reason: string | null;
}

export interface BroadcastSubscribeAllSummary {
  total: number;
  subscribed: number;
  alreadySubscribed: number;
  skipped: number;
  failed: number;
  results: BroadcastSubscribeResult[];
}

export async function getBroadcastSourceConfig(): Promise<BroadcastSourceConfig | null> {
  const row = await prisma.botGlobalConfig.findUnique({ where: { key: BROADCAST_SOURCE_CHANNEL_KEY } });
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<BroadcastSourceConfig>;
    if (typeof parsed.guildId === 'string' && typeof parsed.channelId === 'string' && parsed.guildId && parsed.channelId) {
      return { guildId: parsed.guildId, channelId: parsed.channelId };
    }
  } catch {
    // Valeur corrompue en base : ignoree.
  }
  return null;
}

export async function setBroadcastSourceConfig(config: BroadcastSourceConfig | null): Promise<void> {
  if (!config) {
    await prisma.botGlobalConfig.deleteMany({ where: { key: BROADCAST_SOURCE_CHANNEL_KEY } });
    return;
  }
  const value = JSON.stringify({ guildId: config.guildId, channelId: config.channelId });
  await prisma.botGlobalConfig.upsert({
    where: { key: BROADCAST_SOURCE_CHANNEL_KEY },
    update: { value },
    create: { key: BROADCAST_SOURCE_CHANNEL_KEY, value },
  });
}

/** Verifie que le salon source existe, est un salon d'annonce (type 5) et reste accessible au bot. */
export async function validateBroadcastSourceChannel(
  client: Client,
  guildId: string,
  channelId: string,
): Promise<{ ok: true; guildName: string; channelName: string } | { ok: false; error: string }> {
  type CheckResult = { ok: true; guildName: string; channelName: string } | { ok: false; error: string } | null;

  let result: CheckResult = null;
  if (client.shard) {
    const results = await client.shard.broadcastEval<CheckResult, { guildId: string; channelId: string }>(
      (shardClient, ctx) => {
        const guild = shardClient.guilds.cache.get(ctx.guildId);
        if (!guild) return null;
        const ch = guild.channels.cache.get(ctx.channelId);
        if (!ch) return { ok: false, error: 'Salon introuvable sur ce serveur.' };
        if (ch.type !== 5) return { ok: false, error: "Le salon sélectionné doit être un salon d'annonces Discord." };
        const perms = shardClient.user ? ch.permissionsFor(shardClient.user) : null;
        if (!perms?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
          return { ok: false, error: "Le bot n'a pas les permissions Voir, Envoyer et Intégrer des liens dans ce salon." };
        }
        return { ok: true, guildName: guild.name, channelName: ch.name };
      },
      { context: { guildId, channelId } },
    );
    result = results.find((r) => r !== null) ?? null;
  } else {
    const guild = client.guilds.cache.get(guildId);
    if (guild) {
      const ch = guild.channels.cache.get(channelId);
      if (!ch) result = { ok: false, error: 'Salon introuvable sur ce serveur.' };
      else if (ch.type !== ChannelType.GuildAnnouncement) result = { ok: false, error: "Le salon sélectionné doit être un salon d'annonces Discord." };
      else {
        const perms = client.user ? ch.permissionsFor(client.user) : null;
        if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
          result = { ok: false, error: "Le bot n'a pas les permissions Voir, Envoyer et Intégrer des liens dans ce salon." };
        } else {
          result = { ok: true, guildName: guild.name, channelName: ch.name };
        }
      }
    }
  }

  return result ?? { ok: false, error: 'Serveur introuvable dans le cache du bot.' };
}

/**
 * Publie l'annonce une seule fois dans le salon d'annonces source puis la
 * crossposte : Discord se charge ensuite de la diffuser a tous les serveurs abonnes.
 */
export async function deliverBroadcastViaSource(
  client: Client,
  source: BroadcastSourceConfig,
  params: {
    title: string;
    message: string;
    color: string;
    thumbnailUrl: string | null;
    imageUrl: string | null;
    footerText: string;
  },
): Promise<DeliveryResult[]> {
  if (client.shard) {
    const results = await client.shard.broadcastEval<DeliveryResult | null, {
      guildId: string;
      channelId: string;
      embed: typeof params;
    }>(
      async (shardClient, ctx) => {
        const guild = shardClient.guilds.cache.get(ctx.guildId);
        if (!guild) return null;
        const ch = guild.channels.cache.get(ctx.channelId);
        if (!ch || ch.type !== 5) {
          return {
            guildId: guild.id,
            guildName: guild.name,
            channelId: ctx.channelId,
            channelName: ch?.name ?? null,
            status: 'FAILED',
            reason: "Salon d'annonces source introuvable ou invalide.",
            messageId: null,
          };
        }

        try {
          const { EmbedBuilder: ShardEmbed } = await import('discord.js');
          const embed = new ShardEmbed()
            .setTitle(ctx.embed.title)
            .setDescription(ctx.embed.message)
            .setColor(parseInt(ctx.embed.color.replace('#', ''), 16))
            .setFooter({ text: ctx.embed.footerText })
            .setTimestamp();
          if (ctx.embed.thumbnailUrl) embed.setThumbnail(ctx.embed.thumbnailUrl);
          if (ctx.embed.imageUrl) embed.setImage(ctx.embed.imageUrl);

          const sent = await (ch as import('discord.js').NewsChannel).send({ embeds: [embed] });
          await sent.crosspost().catch((err: unknown) => {
            throw new Error(`Message envoyé mais publication (crosspost) refusée : ${(err as Error).message}`);
          });
          return {
            guildId: guild.id,
            guildName: guild.name,
            channelId: ch.id,
            channelName: ch.name,
            status: 'SENT',
            reason: null,
            messageId: sent.id,
          };
        } catch (err) {
          return {
            guildId: guild.id,
            guildName: guild.name,
            channelId: ch.id,
            channelName: ch.name,
            status: 'FAILED',
            reason: (err as Error).message?.slice(0, 300) ?? 'Erreur inconnue',
            messageId: null,
          };
        }
      },
      { context: { guildId: source.guildId, channelId: source.channelId, embed: params } },
    );

    const found = results.find((r) => r !== null);
    return found ? [found] : [{
      guildId: source.guildId,
      guildName: source.guildId,
      channelId: source.channelId,
      channelName: null,
      status: 'FAILED',
      reason: 'Serveur source introuvable sur les shards.',
      messageId: null,
    }];
  }

  const guild = client.guilds.cache.get(source.guildId);
  if (!guild) {
    return [{
      guildId: source.guildId,
      guildName: source.guildId,
      channelId: source.channelId,
      channelName: null,
      status: 'FAILED',
      reason: 'Serveur source introuvable.',
      messageId: null,
    }];
  }

  const ch = guild.channels.cache.get(source.channelId);
  if (!ch || ch.type !== ChannelType.GuildAnnouncement) {
    return [{
      guildId: guild.id,
      guildName: guild.name,
      channelId: source.channelId,
      channelName: ch?.name ?? null,
      status: 'FAILED',
      reason: "Salon d'annonces source introuvable ou invalide.",
      messageId: null,
    }];
  }

  try {
    const embed = new EmbedBuilder()
      .setTitle(params.title)
      .setDescription(params.message)
      .setColor(params.color as ColorResolvable)
      .setFooter({ text: params.footerText })
      .setTimestamp();
    if (params.thumbnailUrl) embed.setThumbnail(params.thumbnailUrl);
    if (params.imageUrl) embed.setImage(params.imageUrl);

    const sent = await ch.send({ embeds: [embed] });
    await sent.crosspost();
    return [{
      guildId: guild.id,
      guildName: guild.name,
      channelId: ch.id,
      channelName: ch.name,
      status: 'SENT',
      reason: null,
      messageId: sent.id,
    }];
  } catch (err) {
    return [{
      guildId: guild.id,
      guildName: guild.name,
      channelId: ch.id,
      channelName: ch.name,
      status: 'FAILED',
      reason: (err as Error).message?.slice(0, 300) ?? 'Erreur inconnue',
      messageId: null,
    }];
  }
}

interface TargetChannelResolution {
  guildId: string;
  guildName: string;
  channelId: string | null;
  channelName: string | null;
  alreadySubscribed: boolean;
  skipReason?: string;
}

/**
 * Resout le salon cible d'un serveur et verifie s'il suit deja `sourceChannelId`.
 * Execute cote shard (ou localement) pour acceder au cache des salons et aux webhooks.
 */
async function resolveTargetChannelForFollow(
  client: Client,
  guildId: string,
  sourceChannelId: string,
  candidateIds: (string | null | undefined)[],
): Promise<TargetChannelResolution | null> {
  const candidates = candidateIds.filter((id): id is string => Boolean(id));

  if (client.shard) {
    const results = await client.shard.broadcastEval<TargetChannelResolution | null, {
      guildId: string;
      sourceChannelId: string;
      candidates: string[];
    }>(
      async (shardClient, ctx) => {
        const guild = shardClient.guilds.cache.get(ctx.guildId);
        if (!guild || !shardClient.user) return null;

        const hasWebhookPerms = (ch: import('discord.js').GuildBasedChannel) =>
          (ch.type === 0 || ch.type === 5)
          && ch.id !== ctx.sourceChannelId
          && Boolean(ch.permissionsFor(shardClient.user!)?.has(['ViewChannel', 'ManageWebhooks']));

        let target: import('discord.js').TextChannel | import('discord.js').NewsChannel | null = null;
        for (const id of ctx.candidates) {
          const ch = guild.channels.cache.get(id);
          if (ch && hasWebhookPerms(ch)) {
            target = ch as import('discord.js').TextChannel | import('discord.js').NewsChannel;
            break;
          }
        }

        if (!target && guild.systemChannelId) {
          const sys = guild.channels.cache.get(guild.systemChannelId);
          if (sys && hasWebhookPerms(sys)) {
            target = sys as import('discord.js').TextChannel | import('discord.js').NewsChannel;
          }
        }

        if (!target) {
          const everyoneRole = guild.roles.everyone;
          const eligible = guild.channels.cache
            .filter((ch): ch is import('discord.js').TextChannel | import('discord.js').NewsChannel => hasWebhookPerms(ch))
            .sort((a, b) => a.rawPosition - b.rawPosition);
          target = eligible.find((ch) => Boolean(ch.permissionsFor(everyoneRole)?.has('ViewChannel')))
            ?? eligible.first()
            ?? null;
        }

        if (!target) {
          return {
            guildId: guild.id,
            guildName: guild.name,
            channelId: null,
            channelName: null,
            alreadySubscribed: false,
            skipReason: 'Aucun salon avec la permission Gérer les webhooks.',
          };
        }

        try {
          const webhooks = await target.fetchWebhooks();
          const already = webhooks.some((w) => w.type === 2 && w.sourceChannel?.id === ctx.sourceChannelId);
          return {
            guildId: guild.id,
            guildName: guild.name,
            channelId: target.id,
            channelName: target.name,
            alreadySubscribed: already,
          };
        } catch (err) {
          return {
            guildId: guild.id,
            guildName: guild.name,
            channelId: target.id,
            channelName: target.name,
            alreadySubscribed: false,
            skipReason: (err as Error).message?.slice(0, 200) ?? 'Lecture des webhooks impossible.',
          };
        }
      },
      { context: { guildId, sourceChannelId, candidates } },
    );
    return results.find((r) => r !== null) ?? null;
  }

  const guild = client.guilds.cache.get(guildId);
  if (!guild || !client.user) return null;

  const hasWebhookPerms = (ch: import('discord.js').GuildBasedChannel): ch is import('discord.js').TextChannel | import('discord.js').NewsChannel =>
    (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)
    && ch.id !== sourceChannelId
    && Boolean(ch.permissionsFor(client.user!)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageWebhooks]));

  let target = candidates
    .map((id) => guild.channels.cache.get(id))
    .find((ch) => ch && hasWebhookPerms(ch));

  if (!target && guild.systemChannelId) {
    const sys = guild.channels.cache.get(guild.systemChannelId);
    if (sys && hasWebhookPerms(sys)) target = sys;
  }

  if (!target) {
    const everyoneRole = guild.roles.everyone;
    const eligible = guild.channels.cache
      .filter((ch) => hasWebhookPerms(ch))
      .sort((a, b) => a.rawPosition - b.rawPosition);
    target = eligible.find((ch) => Boolean(ch.permissionsFor(everyoneRole)?.has(PermissionFlagsBits.ViewChannel)))
      ?? eligible.first();
  }

  if (!target || (target.type !== ChannelType.GuildText && target.type !== ChannelType.GuildAnnouncement)) {
    return {
      guildId: guild.id,
      guildName: guild.name,
      channelId: null,
      channelName: null,
      alreadySubscribed: false,
      skipReason: 'Aucun salon avec la permission Gérer les webhooks.',
    };
  }

  try {
    const webhooks = await target.fetchWebhooks();
    const already = webhooks.some((w) => w.type === WebhookType.ChannelFollower && w.sourceChannel?.id === sourceChannelId);
    return {
      guildId: guild.id,
      guildName: guild.name,
      channelId: target.id,
      channelName: target.name,
      alreadySubscribed: already,
    };
  } catch (err) {
    return {
      guildId: guild.id,
      guildName: guild.name,
      channelId: target.id,
      channelName: target.name,
      alreadySubscribed: false,
      skipReason: (err as Error).message?.slice(0, 200) ?? 'Lecture des webhooks impossible.',
    };
  }
}

/**
 * Abonne un serveur au salon d'annonces source via Discord Channel Following.
 * Enregistre le salon retenu dans `Guild.broadcastChannelId` s'il n'etait pas encore defini.
 */
export async function subscribeGuildToBroadcastSource(
  client: Client,
  guildId: string,
  sourceChannelId: string,
  explicitChannelId?: string | null,
): Promise<BroadcastSubscribeResult> {
  const dbGuild = await prisma.guild.findUnique({
    where: { id: guildId },
    select: {
      broadcastChannelId: true,
      newsChannelId: true,
      publicChannelId: true,
      staffAnnouncementChannelId: true,
    },
  });

  const candidates = explicitChannelId
    ? [explicitChannelId]
    : [
        dbGuild?.broadcastChannelId,
        dbGuild?.newsChannelId,
        dbGuild?.publicChannelId,
        dbGuild?.staffAnnouncementChannelId,
      ];

  const resolved = await resolveTargetChannelForFollow(client, guildId, sourceChannelId, candidates);
  if (!resolved) {
    return {
      guildId,
      guildName: guildId,
      channelId: null,
      channelName: null,
      status: 'SKIPPED',
      reason: 'Serveur introuvable dans le cache du bot.',
    };
  }

  if (!resolved.channelId || resolved.skipReason) {
    return {
      guildId: resolved.guildId,
      guildName: resolved.guildName,
      channelId: resolved.channelId,
      channelName: resolved.channelName,
      status: 'SKIPPED',
      reason: resolved.skipReason ?? 'Aucun salon compatible.',
    };
  }

  if (resolved.alreadySubscribed) {
    if (!dbGuild?.broadcastChannelId) {
      await prisma.guild.upsert({
        where: { id: guildId },
        update: { broadcastChannelId: resolved.channelId },
        create: { id: guildId, broadcastChannelId: resolved.channelId },
      }).catch(() => {});
    }
    return {
      guildId: resolved.guildId,
      guildName: resolved.guildName,
      channelId: resolved.channelId,
      channelName: resolved.channelName,
      status: 'ALREADY_SUBSCRIBED',
      reason: null,
    };
  }

  try {
    await client.rest.post(Routes.channelFollowers(sourceChannelId), {
      body: { webhook_channel_id: resolved.channelId },
      reason: 'Abonnement aux annonces globales Kotbo',
    });

    if (!dbGuild?.broadcastChannelId) {
      await prisma.guild.upsert({
        where: { id: guildId },
        update: { broadcastChannelId: resolved.channelId },
        create: { id: guildId, broadcastChannelId: resolved.channelId },
      }).catch(() => {});
    }

    return {
      guildId: resolved.guildId,
      guildName: resolved.guildName,
      channelId: resolved.channelId,
      channelName: resolved.channelName,
      status: 'SUBSCRIBED',
      reason: null,
    };
  } catch (err) {
    return {
      guildId: resolved.guildId,
      guildName: resolved.guildName,
      channelId: resolved.channelId,
      channelName: resolved.channelName,
      status: 'FAILED',
      reason: (err as Error).message?.slice(0, 300) ?? "Échec de l'abonnement Discord.",
    };
  }
}

/** Abonne tous les serveurs connus du bot au salon d'annonces source configure. */
export async function subscribeAllGuildsToBroadcastSource(
  client: Client,
  sourceChannelId: string,
): Promise<BroadcastSubscribeAllSummary> {
  const guildIds: string[] = client.shard
    ? (await client.shard.broadcastEval((c) => [...c.guilds.cache.keys()])).flat()
    : [...client.guilds.cache.keys()];

  const uniqueIds = [...new Set(guildIds)];
  const results: BroadcastSubscribeResult[] = [];

  // Traitement sequentiel : `client.rest` gere le rate-limit Discord sans saturer les webhooks.
  for (const guildId of uniqueIds) {
    results.push(await subscribeGuildToBroadcastSource(client, guildId, sourceChannelId));
  }

  return {
    total: results.length,
    subscribed: results.filter((r) => r.status === 'SUBSCRIBED').length,
    alreadySubscribed: results.filter((r) => r.status === 'ALREADY_SUBSCRIBED').length,
    skipped: results.filter((r) => r.status === 'SKIPPED').length,
    failed: results.filter((r) => r.status === 'FAILED').length,
    results,
  };
}

/** Abonne automatiquement un serveur nouvellement rejoint si un salon source est configure. */
export async function subscribeGuildIfBroadcastSourceConfigured(client: Client, guildId: string): Promise<void> {
  const source = await getBroadcastSourceConfig();
  if (!source) return;
  const res = await subscribeGuildToBroadcastSource(client, guildId, source.channelId);
  if (res.status === 'SUBSCRIBED') {
    logger.info('Broadcast', `Serveur ${res.guildName} (${guildId}) abonné automatiquement au salon source (${res.channelName ?? res.channelId}).`);
  } else if (res.status === 'FAILED') {
    logger.warn('Broadcast', `Abonnement auto échoué pour ${res.guildName} (${guildId}) : ${res.reason}`);
  }
}

/**
 * Reprend les annonces programmees arrivees a echeance.
 *
 * Le scheduler tourne dans le processus qui porte l'API : un redemarrage ne
 * perd rien puisque l'etat vit en base, l'envoi est simplement repris au tick
 * suivant.
 */
export function startBroadcastScheduler(
  client: Client,
  collectShardGuilds: (client: Client) => Promise<{ id: string }[]>,
): () => void {
  const TICK_MS = 60_000;

  const tick = async () => {
    try {
      const due = await prisma.broadcastLog.findMany({
        where: { status: 'SCHEDULED', scheduledAt: { lte: new Date() } },
        orderBy: { scheduledAt: 'asc' },
        take: 5,
      });

      for (const broadcast of due) {
        // Verrou optimiste : seul le tick qui reussit la transition envoie.
        const claimed = await prisma.broadcastLog.updateMany({
          where: { id: broadcast.id, status: 'SCHEDULED' },
          data: { status: 'SENDING', startedAt: new Date() },
        });
        if (claimed.count === 0) continue;

        try {
          const sourceConfig = await getBroadcastSourceConfig();
          const useSourceChannel = Boolean(
            sourceConfig
            && broadcast.target === 'ALL'
            && broadcast.pollOptions.length === 0
            && !broadcast.feedbackLabel,
          );

          if (useSourceChannel && sourceConfig) {
            const deliveries = await deliverBroadcastViaSource(client, sourceConfig, {
              title: broadcast.title,
              message: resolveEmojiShortcodes(broadcast.message),
              color: broadcast.color,
              thumbnailUrl: broadcast.thumbnailUrl,
              imageUrl: broadcast.imageUrl,
              footerText: broadcast.footerText ?? DEFAULT_BROADCAST_FOOTER,
            });
            await finalizeBroadcast(broadcast.id, deliveries, deliveries.length);
            await markBroadcastMediaUsed([broadcast.imageUrl, broadcast.thumbnailUrl]);
            logger.info('Broadcast', `Annonce programmee ${broadcast.id} publiee sur le salon source ${sourceConfig.channelId}`);
          } else {
            const allowed = await resolveTargetGuildIds(
              client,
              broadcast.target as BroadcastTarget,
              broadcast.targetGuilds,
              collectShardGuilds,
            );
            const channelMap = await loadGuildChannelMap();
            const deliveries = await deliverBroadcast(client, {
              title: broadcast.title,
              message: resolveEmojiShortcodes(broadcast.message),
              color: broadcast.color,
              thumbnailUrl: broadcast.thumbnailUrl,
              imageUrl: broadcast.imageUrl,
              footerText: broadcast.footerText ?? DEFAULT_BROADCAST_FOOTER,
              channelPref: broadcast.channelPref as BroadcastChannelPref,
              allowedIds: [...allowed],
              channelMap,
              translations: broadcast.translations as BroadcastTranslations | null,
              poll: { broadcastId: broadcast.id, options: broadcast.pollOptions },
              feedback: broadcast.feedbackLabel ? { broadcastId: broadcast.id, label: broadcast.feedbackLabel } : undefined,
            });

            await finalizeBroadcast(broadcast.id, deliveries, allowed.size);
            await markBroadcastMediaUsed([broadcast.imageUrl, broadcast.thumbnailUrl]);
            logger.info('Broadcast', `Annonce programmee ${broadcast.id} envoyee (${deliveries.length} serveurs)`);
          }
        } catch (err) {
          await prisma.broadcastLog.update({
            where: { id: broadcast.id },
            data: { status: 'FAILED', finishedAt: new Date() },
          }).catch(() => {});
          logger.error('Broadcast', `Annonce programmee ${broadcast.id} en echec:`, err);
        }
      }
    } catch (err) {
      logger.warn('Broadcast', `Tick du planificateur en echec: ${(err as Error).message}`);
    }
  };

  const timer = setInterval(() => { void tick(); }, TICK_MS);
  timer.unref?.();
  void tick();

  return () => clearInterval(timer);
}
