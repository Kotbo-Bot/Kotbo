/**
 * Drops aléatoires : un cadeau que le bot pose de lui-même dans un salon, à une
 * heure imprévisible, et que les membres ramassent en cliquant.
 *
 * Quatre ressources (XP de progression, XP RPG, points de clan, pièces), chacune
 * avec son salon, sa fréquence et ses fourchettes. Trois façons de ramasser -
 * premier arrivé, les N premiers, ouvert à tous pendant un moment - réglables
 * séparément : la course au clic peut rapporter davantage que la fenêtre
 * ouverte à tous, ce qui est tout l'intérêt de les distinguer.
 *
 * Les décisions d'équilibrage (quand, combien, quel mode) vivent dans
 * `@kotbo/shared` pour rester testables ; ce service ne fait que les appliquer,
 * publier les messages et créditer les gains.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, GuildMember, MessageFlags, SnowflakeUtil, type ButtonInteraction, type Client } from 'discord.js';
import type { Prisma } from '@prisma/client';
import {
  DROP_ACTIVITY_DISABLED,
  DROP_CLAIM_LIMIT_WINDOW_MS,
  DROP_DELETE_AFTER_DISABLED,
  DROP_ITEM_WEIGHT_RANGE,
  DROP_TYPES,
  DROP_TYPE_MODULE,
  defaultDropTypeSettings,
  drawDropAmount,
  dropActivityCheckDue,
  dropActivityVerdict,
  dropClaimBlocker,
  dropClaimSettleAction,
  dropExpiresAt,
  dropJackpotAmount,
  dropMentionRoleId,
  dropMaxClaims,
  dropMessageDeleteAt,
  effectiveDropClaimRules,
  enabledDropModes,
  hasDropClaimRules,
  nextAllowedPublicationAt,
  normalizeDropClaimRules,
  normalizeDropDeleteAfterMinutes,
  normalizeDropItems,
  normalizeDropTypeSettings,
  pickDropMode,
  pickWeightedDropItem,
  planNextDropAt,
  rollDropJackpot,
  type DropClaimFacts,
  type DropItemChance,
  type DropMode,
  type DropType,
  type DropTypeSettings,
} from '@kotbo/shared';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { isShopItemUnlocked } from './economyPolicy.js';
import { COLORS } from '../../utils/embeds.js';
import { resolveGuildLocale, type BotLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { addXp } from '../progression/levelingService.js';
import { checkLevelUp, getOrCreateRpgProfile, getShopModuleState } from './economyService.js';
import { awardClanPointsToMembers } from '../community/clanService.js';
import { flushClanPointsFeedGroup } from '../community/clanPointsFeedService.js';
import { isModuleEnabled } from '../core/moduleGate.js';

export const DROP_CLAIM_PREFIX = 'drop_claim:';

/** Groupe du flux des points de clan qui rassemble les gagnants d'un drop. */
function dropFeedGroupKey(dropId: string): string {
  return `drop:${dropId}`;
}

/** Gagnants nommés dans le récapitulatif de clôture ; au-delà, ils sont comptés. */
const RECAP_WINNERS_LIMIT = 20;

type DropConfigRow = Awaited<ReturnType<typeof prisma.dropConfig.findFirst>>;
type DropRow = NonNullable<Awaited<ReturnType<typeof prisma.drop.findFirst>>>;

interface DropGuildContext {
  id: string;
  dropChannelId: string | null;
  dropMentionRoleId: string | null;
  dropMentionJackpotOnly: boolean;
  dropLifetimeMinutes: number;
  dropDeleteAfterMinutes: number;
  dropJackpotEnabled: boolean;
  dropJackpotChance: number;
  dropJackpotMultiplier: number;
}

/** Salon où tombe un type : le sien, sinon celui par défaut du serveur. */
function dropChannelIdFor(settings: DropTypeSettings, guild: DropGuildContext): string | null {
  return settings.channelId ?? guild.dropChannelId;
}

/** Colonnes plates de la base vers l'objet de réglages de `@kotbo/shared`. */
export function dropSettingsFromRow(row: NonNullable<DropConfigRow>): DropTypeSettings {
  return normalizeDropTypeSettings(row.type as DropType, {
    enabled: row.enabled,
    items: normalizeDropItems(row.items),
    channelId: row.channelId,
    intervalMinutes: row.intervalMinutes,
    activity: { minMessages: row.activityMinMessages, windowMinutes: row.activityWindowMinutes },
    first: { enabled: row.firstEnabled, minAmount: row.firstMinAmount, maxAmount: row.firstMaxAmount },
    race: {
      enabled: row.raceEnabled,
      winnerCount: row.raceWinnerCount,
      minAmount: row.raceMinAmount,
      maxAmount: row.raceMaxAmount,
    },
    window: {
      enabled: row.windowEnabled,
      durationMinutes: row.windowDurationMinutes,
      minAmount: row.windowMinAmount,
      maxAmount: row.windowMaxAmount,
    },
  });
}

/** Colonnes plates à écrire en base pour des réglages normalisés. */
export function dropSettingsToRow(settings: DropTypeSettings) {
  return {
    enabled: settings.enabled,
    items: settings.items as unknown as Prisma.InputJsonValue,
    channelId: settings.channelId,
    intervalMinutes: settings.intervalMinutes,
    activityMinMessages: settings.activity.minMessages,
    activityWindowMinutes: settings.activity.windowMinutes,
    firstEnabled: settings.first.enabled,
    firstMinAmount: settings.first.minAmount,
    firstMaxAmount: settings.first.maxAmount,
    raceEnabled: settings.race.enabled,
    raceWinnerCount: settings.race.winnerCount,
    raceMinAmount: settings.race.minAmount,
    raceMaxAmount: settings.race.maxAmount,
    windowEnabled: settings.window.enabled,
    windowDurationMinutes: settings.window.durationMinutes,
    windowMinAmount: settings.window.minAmount,
    windowMaxAmount: settings.window.maxAmount,
  };
}

/**
 * Les quatre lignes de réglages du serveur, créées au barème par défaut si elles
 * manquent. Appelée par le dashboard : la page doit pouvoir afficher les quatre
 * onglets avant qu'un seul drop n'ait été configuré.
 */
export async function getOrCreateDropConfigs(guildId: string) {
  const existing = await prisma.dropConfig.findMany({ where: { guildId } });
  const missing = DROP_TYPES.filter((type) => !existing.some((row) => row.type === type));

  if (missing.length > 0) {
    await prisma.dropConfig.createMany({
      data: missing.map((type) => ({ guildId, type, ...dropSettingsToRow(defaultDropTypeSettings(type)) })),
      skipDuplicates: true,
    });
    return prisma.dropConfig.findMany({ where: { guildId } });
  }

  return existing;
}

/**
 * Ce que le drop annonce.
 *
 * Un drop d'objet nomme la pièce tirée plutôt qu'une ressource : « 1 objet » n'attire
 * personne, « 1 Lame du Crépuscule » si. Le nom est passé par l'appelant, qui vient de le
 * lire, plutôt que relu ici à chaque affichage.
 */
function resourceLabel(type: DropType, locale: BotLocale, itemLabel?: string | null): string {
  if (type === 'RPG_ITEM') return itemLabel ?? m.drop_resource_rpg_item({}, { locale });
  if (type === 'RPG_XP') return m.drop_resource_rpg_xp({}, { locale });
  if (type === 'CLAN_POINTS') return m.drop_resource_clan_points({}, { locale });
  if (type === 'COINS') return m.drop_resource_coins({}, { locale });
  return m.drop_resource_xp({}, { locale });
}

/**
 * Gabarits de l'annonce dans la langue du serveur, pour l'aperçu du dashboard.
 *
 * Les messages sont rendus avec leurs marqueurs (`{amount}`, `{resource}`...) en guise de
 * valeurs : la page les remplit avec le formulaire en cours, sans route d'aperçu ni copie
 * des textes de son côté. Mêmes messages que `buildDropEmbed`, donc même annonce.
 */
export function dropAnnouncementLabels(locale: BotLocale) {
  const amount = '{amount}';
  const resource = '{resource}';
  return {
    locale,
    title: m.drop_announce_title({}, { locale }),
    jackpotTitle: m.drop_jackpot_title({}, { locale }),
    claimButton: m.drop_claim_button({}, { locale }),
    first: m.drop_announce_desc_first({ amount, resource }, { locale }),
    race: m.drop_announce_desc_race({ amount, resource, winners: '{winners}' }, { locale }),
    window: m.drop_announce_desc_window({ amount, resource, closes: '{closes}' }, { locale }),
    resources: Object.fromEntries(DROP_TYPES.map((type) => [type, resourceLabel(type, locale)])) as Record<DropType, string>,
  };
}

function buildDropEmbed(drop: DropRow, locale: BotLocale, itemLabel?: string | null): EmbedBuilder {
  const resource = resourceLabel(drop.type as DropType, locale, itemLabel);
  const amount = drop.amount.toLocaleString(locale === 'fr' ? 'fr-FR' : 'en-US');

  let description: string;
  if (drop.mode === 'RACE') {
    description = m.drop_announce_desc_race({ amount, resource, winners: drop.maxClaims }, { locale });
  } else if (drop.mode === 'WINDOW') {
    description = m.drop_announce_desc_window(
      { amount, resource, closes: `<t:${Math.floor(drop.expiresAt.getTime() / 1000)}:R>` },
      { locale },
    );
  } else {
    description = m.drop_announce_desc_first({ amount, resource }, { locale });
  }

  return new EmbedBuilder()
    .setTitle(dropTitle(drop, locale))
    .setDescription(description)
    .setColor(drop.jackpot ? COLORS.warning : COLORS.primary);
}

/** Un jackpot s'annonce comme tel, du message d'apparition jusqu'au bilan. */
function dropTitle(drop: DropRow, locale: BotLocale): string {
  return drop.jackpot ? m.drop_jackpot_title({}, { locale }) : m.drop_announce_title({}, { locale });
}

function buildClaimRow(dropId: string, locale: BotLocale, disabled: boolean): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${DROP_CLAIM_PREFIX}${dropId}`)
      .setLabel(disabled ? m.drop_claimed_button({}, { locale }) : m.drop_claim_button({}, { locale }))
      .setStyle(disabled ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setDisabled(disabled),
  );
}

/**
 * Objets d'un serveur réellement susceptibles de tomber.
 *
 * Le filtre est volontairement strict, et il est repassé au ramassage : entre le message
 * et le clic, un objet peut avoir été supprimé, un module éteint, et le gagnant se
 * retrouverait avec une ligne d'inventaire qui ne vaut rien.
 *
 * Sont écartés : ce que le serveur n'a pas listé, ce qui appartient à un autre serveur, ce
 * qui n'existe plus, et ce dont la récompense de module est éteinte - un objet qui vend de
 * l'XP de niveaux sur un serveur sans niveaux ne vaut pas mieux qu'un objet absent.
 */
async function eligibleDropItems(guildId: string, chances: DropItemChance[]) {
  if (chances.length === 0) return [];

  const config = await prisma.economyConfig.findUnique({
    where: { guildId },
    select: { enabled: true, rpgEnabled: true },
  });
  // Sans RPG, il n'y a pas d'inventaire où déposer quoi que ce soit.
  if (!config?.enabled || !config.rpgEnabled) return [];

  const [items, modules] = await Promise.all([
    prisma.rpgItem.findMany({
      where: { id: { in: chances.map((entry) => entry.itemId) }, OR: [{ guildId: null }, { guildId }] },
    }),
    getShopModuleState(guildId),
  ]);

  const weightOf = new Map(chances.map((entry) => [entry.itemId, entry.weight]));
  // Le taux voyage avec l'objet : écarter une pièce inéligible ne doit pas décaler les
  // parts des autres, seulement les renormaliser entre elles.
  return items
    .filter((item) => isShopItemUnlocked(item, modules))
    .map((item) => ({ item, weight: weightOf.get(item.id) ?? DROP_ITEM_WEIGHT_RANGE.min }));
}

/** Une page de messages Discord : la plus grande lecture faite en un appel. */
const RECENT_MESSAGES_PAGE = 100;

/**
 * Messages de membres postés dans un salon depuis `since`.
 *
 * Lu sur Discord au moment où le drop est dû plutôt que compté au fil de l'eau : le cycle
 * tourne dans un seul processus pour tous les shards, un compteur en mémoire n'y verrait
 * que les serveurs du sien. Les bots (dont les drops eux-mêmes), les webhooks et les
 * messages système ne comptent pas. Un salon injoignable vaut zéro : le drop attend son
 * plafond de retard, puis la publication dira elle-même ce qui ne va pas.
 */
export async function countRecentMemberMessages(client: Client, channelId: string, since: Date): Promise<number> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return 0;

  // `after` : Discord ne renvoie que la fenêtre, un salon calme répond une page vide.
  const after = SnowflakeUtil.generate({ timestamp: since.getTime() }).toString();
  const messages = await channel.messages.fetch({ limit: RECENT_MESSAGES_PAGE, after }).catch(() => null);
  if (!messages) return 0;

  let count = 0;
  for (const message of messages.values()) {
    if (message.author.bot || message.system || message.webhookId) continue;
    if (message.createdTimestamp >= since.getTime()) count += 1;
  }
  return count;
}

/**
 * Dernière lecture de l'activité de chaque type en attente, par config. En mémoire : le
 * cycle tourne dans un seul processus, et un redémarrage ne coûte qu'une lecture de plus.
 */
const activityCheckedAt = new Map<string, Date>();

/**
 * Messages récents du salon d'un type en attente d'activité. Entre deux lectures, le
 * salon est tenu pour calme : le drop continue d'attendre, et le plafond de retard
 * de `dropActivityVerdict` le fait partir à l'heure même sans relecture.
 */
async function recentMessagesForActivity(
  client: Client,
  configId: string,
  channelId: string | null,
  settings: DropTypeSettings,
  now: Date,
): Promise<number> {
  if (!channelId || !dropActivityCheckDue(activityCheckedAt.get(configId) ?? null, now)) return 0;
  activityCheckedAt.set(configId, now);
  const since = new Date(now.getTime() - settings.activity.windowMinutes * 60 * 1000);
  return countRecentMemberMessages(client, channelId, since);
}

async function publishDrop(
  client: Client,
  guild: DropGuildContext,
  config: NonNullable<DropConfigRow>,
  settings: DropTypeSettings,
  mode: DropMode,
): Promise<void> {
  const channelId = dropChannelIdFor(settings, guild);
  if (!channelId) {
    logger.warn('Drops', `Aucun salon configuré pour le drop ${config.type} sur ${guild.id}.`);
    return;
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !channel.isSendable()) {
    logger.warn('Drops', `Salon ${channelId} injoignable pour le drop ${config.type} sur ${guild.id}.`);
    return;
  }

  // L'objet est tiré maintenant et recopié sur le drop : le message annonce une pièce
  // précise, elle ne peut pas changer entre l'annonce et le clic.
  let itemId: string | null = null;
  let itemLabel: string | null = null;
  if (config.type === 'RPG_ITEM') {
    const eligible = await eligibleDropItems(guild.id, settings.items);
    if (eligible.length === 0) {
      logger.warn('Drops', `Aucun objet éligible pour le drop d'objet sur ${guild.id}.`);
      return;
    }

    const drawnId = pickWeightedDropItem(eligible.map((entry) => ({ itemId: entry.item.id, weight: entry.weight })));
    const drawn = eligible.find((entry) => entry.item.id === drawnId)?.item;
    if (!drawn) return;

    itemId = drawn.id;
    itemLabel = `${drawn.emoji} ${drawn.name}`;
  }

  const now = new Date();
  const drawn = drawDropAmount(settings, mode);
  const jackpot = rollDropJackpot(config.type as DropType, guild);
  const drop = await prisma.drop.create({
    data: {
      guildId: guild.id,
      configId: config.id,
      type: config.type,
      mode,
      channelId,
      itemId,
      amount: jackpot ? dropJackpotAmount(drawn, guild.dropJackpotMultiplier) : drawn,
      jackpot,
      maxClaims: dropMaxClaims(settings, mode),
      expiresAt: dropExpiresAt(now, settings, mode, guild.dropLifetimeMinutes),
      // Recopié du serveur : le délai suit le drop, régler l'option n'emporte
      // pas les messages des drops déjà publiés.
      deleteAfterMinutes: normalizeDropDeleteAfterMinutes(guild.dropDeleteAfterMinutes),
    },
  });

  const locale = await resolveGuildLocale(guild.id);
  const mentionRoleId = dropMentionRoleId(guild, jackpot);
  const mention = mentionRoleId ? `<@&${mentionRoleId}>` : undefined;

  const message = await channel.send({
    content: mention,
    embeds: [buildDropEmbed(drop, locale, itemLabel)],
    components: [buildClaimRow(drop.id, locale, false)],
    allowedMentions: mentionRoleId ? { roles: [mentionRoleId] } : { parse: [] },
  }).catch((error: unknown) => {
    logger.error('Drops', `Publication impossible du drop ${config.type} sur ${guild.id}:`, error);
    return null;
  });

  if (!message) {
    // Sans message, le drop n'est cliquable par personne : le laisser ouvert
    // ferait traîner une ligne que le balayage clôturerait pour rien.
    await prisma.drop.delete({ where: { id: drop.id } }).catch(() => null);
    return;
  }

  await prisma.drop.update({ where: { id: drop.id }, data: { messageId: message.id } }).catch(() => null);
  logger.info('Drops', `Drop ${config.type}/${mode}${jackpot ? ' (jackpot)' : ''} de ${drop.amount} publié sur ${guild.id}.`);
}

async function tickDropConfig(client: Client, guild: DropGuildContext, config: NonNullable<DropConfigRow>): Promise<void> {
  const settings = dropSettingsFromRow(config);

  // Tous les modes éteints : le drop n'aurait aucune façon d'être ramassé.
  if (enabledDropModes(settings).length === 0) return;

  // Liste vide : rien à tirer. Le contrôle est fait ici, avant de consommer le créneau,
  // parce qu'il ne coûte aucune requête - la vérification complète des objets, elle, reste
  // à la publication. Sans ça, un type mal réglé se replanifie et prévient toutes les
  // six heures pour rien.
  if (config.type === 'RPG_ITEM' && settings.items.length === 0) return;

  const now = new Date();

  if (!config.nextDropAt) {
    await prisma.dropConfig.update({
      where: { id: config.id },
      data: { nextDropAt: planNextDropAt(now, settings.intervalMinutes) },
    });
    return;
  }

  if (config.nextDropAt > now) return;

  // Attente d'activité : le drop reste dû, sans consommer son créneau, tant que
  // le salon est calme. Le cycle repasse à la minute suivante. Placée avant le
  // garde-fou anti-spam, qui décale l'échéance : sinon chaque drop d'un autre
  // type remettrait à zéro le plafond de retard, mesuré depuis cette échéance.
  if (settings.activity.minMessages > DROP_ACTIVITY_DISABLED) {
    const recentMessages = await recentMessagesForActivity(client, config.id, dropChannelIdFor(settings, guild), settings, now);
    const verdict = dropActivityVerdict({
      dueAt: config.nextDropAt,
      now,
      intervalMinutes: settings.intervalMinutes,
      activity: settings.activity,
      recentMessages,
    });
    if (verdict === 'wait') return;
    activityCheckedAt.delete(config.id);
  }

  // Garde-fou anti-spam, tous types confondus : quatre ressources qui tombent
  // coup sur coup font un bot qui inonde un salon, ce qui lui vaut d'être
  // signalé et restreint par Discord. Le type en avance est reporté juste après
  // l'écart minimal plutôt que de sauter son tour.
  const lastPublished = await prisma.drop.findFirst({
    where: { guildId: guild.id },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });

  const allowedFrom = nextAllowedPublicationAt(lastPublished?.createdAt);
  if (allowedFrom && allowedFrom > now) {
    await prisma.dropConfig.updateMany({
      where: { id: config.id, nextDropAt: config.nextDropAt },
      data: { nextDropAt: allowedFrom },
    });
    return;
  }

  // Réservation avant publication : la date planifiée sert de jeton. Deux
  // processus qui tickent en même temps ne peuvent pas poser deux drops, le
  // second ne retrouve plus la date qu'il avait lue.
  const reserved = await prisma.dropConfig.updateMany({
    where: { id: config.id, nextDropAt: config.nextDropAt },
    data: { nextDropAt: planNextDropAt(now, settings.intervalMinutes) },
  });
  if (reserved.count === 0) return;

  const mode = pickDropMode(settings);
  if (!mode) return;

  await publishDrop(client, guild, config, settings, mode);
}

/**
 * Tick de cron : planifie, publie, puis clôt les drops arrivés à échéance.
 *
 * Deux lectures pour tout le monde, et non une par serveur : ce cycle tourne à
 * la minute, une requête par serveur configuré ferait grossir la charge avec le
 * nombre de serveurs pour, la plupart du temps, ne rien trouver à publier.
 */
export async function runDropCycle(client: Client): Promise<void> {
  const guilds = await prisma.guild.findMany({
    where: { dropsEnabled: true },
    select: {
      id: true,
      dropChannelId: true,
      dropMentionRoleId: true,
      dropMentionJackpotOnly: true,
      dropLifetimeMinutes: true,
      dropDeleteAfterMinutes: true,
      dropJackpotEnabled: true,
      dropJackpotChance: true,
      dropJackpotMultiplier: true,
    },
  });
  if (guilds.length === 0) {
    await closeExpiredDrops(client);
    await purgeDeletedDropMessages(client);
    await settlePendingDropClaims(client);
    return;
  }

  const guildById = new Map(guilds.map((guild) => [guild.id, guild]));

  // Seuls les types dont l'heure est passée, ou qui n'ont pas encore d'heure.
  const due = await prisma.dropConfig.findMany({
    where: {
      guildId: { in: [...guildById.keys()] },
      enabled: true,
      OR: [{ nextDropAt: null }, { nextDropAt: { lte: new Date() } }],
    },
  });

  // Traitement en série, volontairement : l'écart minimal entre deux
  // publications se lit sur le dernier drop enregistré, ce qu'un parcours
  // parallèle rendrait faux - deux types liraient la même base d'avant.
  for (const config of due) {
    const guild = guildById.get(config.guildId);
    if (!guild) continue;

    try {
      // La colonne dit que les drops sont allumés, la garde dit s'ils le sont
      // vraiment (bascule de module, cascade de dépendances). Lecture en cache.
      if (!(await isModuleEnabled(guild.id, 'drops'))) continue;
      // Le module qui tient la ressource doit tourner lui aussi : sinon le drop
      // se publie, se ramasse, et ne verse rien qu'on puisse voir.
      if (!(await isModuleEnabled(guild.id, DROP_TYPE_MODULE[config.type as DropType]))) continue;

      await tickDropConfig(client, guild, config);
    } catch (error) {
      logger.error('Drops', `Cycle en échec pour ${guild.id} (${config.type}):`, error);
    }
  }

  await closeExpiredDrops(client);
  await purgeDeletedDropMessages(client);
  await settlePendingDropClaims(client);
}

/** Grise le bouton d'un drop terminé et récapitule ce qui a été ramassé. */
async function closeDropMessage(client: Client, drop: DropRow): Promise<void> {
  if (!drop.messageId) return;

  const channel = await client.channels.fetch(drop.channelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  const message = await channel.messages.fetch(drop.messageId).catch(() => null);
  if (!message) return;

  // Une fenêtre ouverte à tous peut réunir des dizaines de membres : la liste
  // est bornée pour ne pas dépasser la taille d'un message, et le reste est
  // compté plutôt que passé sous silence.
  const [claims, claimCount] = await Promise.all([
    prisma.dropClaim.findMany({
      where: { dropId: drop.id },
      orderBy: { createdAt: 'asc' },
      select: { userId: true },
      take: RECAP_WINNERS_LIMIT,
    }),
    prisma.dropClaim.count({ where: { dropId: drop.id } }),
  ]);

  const locale = await resolveGuildLocale(drop.guildId);
  // Le bilan nomme la pièce comme le faisait l'annonce : « 3 objet » à la fermeture d'un
  // drop qui annonçait une épée laisserait croire à un autre lot.
  const droppedItem = drop.itemId
    ? await prisma.rpgItem.findUnique({ where: { id: drop.itemId }, select: { name: true, emoji: true } })
    : null;
  const resource = resourceLabel(
    drop.type as DropType,
    locale,
    droppedItem ? `${droppedItem.emoji} ${droppedItem.name}` : null,
  );
  const amount = drop.amount.toLocaleString(locale === 'fr' ? 'fr-FR' : 'en-US');

  const mentions = claims.map((claim) => `<@${claim.userId}>`).join(', ');
  const hidden = claimCount - claims.length;
  const winners = hidden > 0
    ? `${mentions} ${m.drop_closed_more({ count: hidden }, { locale })}`
    : mentions;

  const embed = new EmbedBuilder()
    .setTitle(dropTitle(drop, locale))
    .setColor(claimCount > 0 ? COLORS.success : COLORS.dark)
    .setDescription(
      claimCount === 0
        ? m.drop_closed_desc_empty({ amount, resource }, { locale })
        : m.drop_closed_desc({ amount, resource, winners }, { locale }),
    );

  // Le message est en Components V2 (voir utils/patchV2.ts) : l'embed est
  // reconstruit à chaque édition, `message.embeds` y est toujours vide.
  await message.edit({
    embeds: [embed],
    components: [buildClaimRow(drop.id, locale, true)],
  }).catch(() => null);
}

/**
 * Efface les messages des drops clos dont le délai de suppression est écoulé.
 *
 * Le délai est celui recopié sur le drop à sa publication : un serveur qui règle
 * l'option ne voit pas disparaître les messages de ses drops passés. Le
 * `messageId` est vidé une fois le message parti, ce qui sort définitivement le
 * drop du balayage - la ligne, elle, reste pour l'historique de la page.
 */
async function purgeDeletedDropMessages(client: Client): Promise<void> {
  const pending = await prisma.drop.findMany({
    where: {
      closedAt: { not: null },
      messageId: { not: null },
      deleteAfterMinutes: { gt: DROP_DELETE_AFTER_DISABLED },
    },
    orderBy: { closedAt: 'asc' },
    take: 50,
    select: {
      id: true,
      channelId: true,
      messageId: true,
      closedAt: true,
      deleteAfterMinutes: true,
    },
  });

  const now = new Date();
  for (const drop of pending) {
    if (!drop.closedAt || !drop.messageId) continue;

    const deleteAt = dropMessageDeleteAt(drop.closedAt, drop.deleteAfterMinutes);
    if (!deleteAt || deleteAt > now) continue;

    const channel = await client.channels.fetch(drop.channelId).catch(() => null);
    if (channel?.isTextBased()) {
      await channel.messages.delete(drop.messageId).catch(() => null);
    }

    // Le `messageId` est vidé même quand la suppression a échoué : un message
    // déjà effacé à la main, ou un salon devenu injoignable, ferait sinon
    // repasser le drop à chaque minute jusqu'à la fin des temps.
    await prisma.drop.update({ where: { id: drop.id }, data: { messageId: null } }).catch(() => null);
  }
}

async function closeExpiredDrops(client: Client): Promise<void> {
  const expired = await prisma.drop.findMany({
    where: { closedAt: null, expiresAt: { lte: new Date() } },
    // Les plus anciens d'abord : en cas d'arriéré, le lot suivant reprend là
    // où celui-ci s'arrête au lieu de retomber sur un tirage arbitraire.
    orderBy: { expiresAt: 'asc' },
    take: 50,
  });

  for (const drop of expired) {
    const closed = await prisma.drop.updateMany({
      where: { id: drop.id, closedAt: null },
      data: { closedAt: new Date() },
    });
    if (closed.count === 0) continue;
    flushClanPointsFeedGroup(drop.guildId, dropFeedGroupKey(drop.id));

    await closeDropMessage(client, drop).catch((error: unknown) => {
      logger.error('Drops', `Clôture du message du drop ${drop.id} impossible:`, error);
    });
  }
}

type ClaimOutcome =
  | { ok: true; claimId: string; full: boolean }
  | { ok: false; reason: 'already' | 'full' | 'error' };

/** Ramassage à verser : sa ligne, et le membre qui touche le gain. */
interface PendingClaim {
  id: string;
  userId: string;
}

/** Délai avant de reprendre un versement en suspens, bien au-delà de la durée d'un clic. */
const CLAIM_SETTLE_RETRY_MS = 5 * 60 * 1000;
/** Ramassages repris par passage du cycle. */
const CLAIM_SETTLE_BATCH = 50;

/**
 * Marque un ramassage comme versé. Écriture conditionnelle : `false` quand un
 * autre passage l'a déjà marqué.
 */
async function markClaimPaid(db: Prisma.TransactionClient, claimId: string): Promise<boolean> {
  const marked = await db.dropClaim.updateMany({
    where: { id: claimId, paidAt: null },
    data: { paidAt: new Date() },
  });
  return marked.count > 0;
}

/**
 * Verse dans la même transaction que le marquage : une ressource qui ne vit qu'en
 * base est versée une fois, jamais deux, même si deux passages se croisent.
 * Renvoie `false` quand le ramassage était déjà versé.
 */
async function payInTransaction(
  claimId: string,
  pay: (tx: Prisma.TransactionClient) => Promise<unknown>,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    if (!(await markClaimPaid(tx, claimId))) return false;
    await pay(tx);
    return true;
  });
}

/**
 * Verse la récompense d'un drop et marque le ramassage comme versé.
 *
 * Renvoie ce qui a réellement été crédité : les points de clan d'un membre sans
 * clan ne vont nulle part, et le drop doit alors rester ouvert pour quelqu'un
 * d'autre plutôt que de disparaître dans le vide. Une erreur est propagée : le
 * ramassage reste alors en suspens, et le cycle le reprendra.
 *
 * Pièces, XP RPG et objets ne vivent qu'en base : versement et marquage partagent
 * une transaction. L'XP de niveau et les points de clan passent par leurs modules,
 * qui annoncent, donnent des rôles et lisent Discord : le marquage suit le
 * versement, et un arrêt entre les deux le ferait reprendre une seconde fois.
 * Mieux vaut ce cas, rare et borné à un gain, qu'un clic qui ne rapporte rien.
 */
async function creditDrop(client: Client, drop: DropRow, claim: PendingClaim): Promise<number> {
  const userId = claim.userId;
  switch (drop.type as DropType) {
    case 'XP': {
      await addXp(drop.guildId, userId, drop.amount, client, drop.channelId);
      await markClaimPaid(prisma, claim.id);
      return drop.amount;
    }
    case 'RPG_XP': {
      const profile = await getOrCreateRpgProfile(drop.guildId, userId);
      const paid = await payInTransaction(claim.id, (tx) =>
        tx.rpgProfile.update({ where: { id: profile.id }, data: { xp: { increment: drop.amount } } }));
      // Comme tout gain d'XP RPG : sans ce passage, l'XP s'empile sans jamais
      // faire monter de niveau tant qu'aucune autre action ne le déclenche.
      if (paid) await checkLevelUp(drop.guildId, userId);
      return drop.amount;
    }
    case 'COINS': {
      const profile = await getOrCreateRpgProfile(drop.guildId, userId);
      await payInTransaction(claim.id, (tx) =>
        tx.rpgProfile.update({ where: { id: profile.id }, data: { balance: { increment: drop.amount } } }));
      return drop.amount;
    }
    case 'RPG_ITEM': {
      if (!drop.itemId) return 0;
      const itemId = drop.itemId;

      // Le module a pu être éteint et l'objet supprimé depuis la publication : les mêmes
      // contrôles sont repassés. Rendre 0 laisse le drop ouvert plutôt que de le consommer
      // pour rien - c'est déjà ce que fait un drop de points sans clan.
      //
      // La liste du serveur n'est volontairement pas relue : elle décide de ce qui *peut
      // être publié*, et un objet retiré après coup ne doit pas reprendre ce que le salon
      // a déjà promis nommément.
      const eligible = await eligibleDropItems(drop.guildId, [{ itemId, weight: DROP_ITEM_WEIGHT_RANGE.min }]);
      if (eligible.length === 0) return 0;

      const profile = await getOrCreateRpgProfile(drop.guildId, userId);
      await payInTransaction(claim.id, (tx) => tx.rpgInventoryItem.upsert({
        where: { rpgProfileId_itemId: { rpgProfileId: profile.id, itemId } },
        create: { rpgProfileId: profile.id, itemId, quantity: drop.amount },
        update: { quantity: { increment: drop.amount } },
      }));
      return drop.amount;
    }
    case 'CLAN_POINTS': {
      const granted = await awardClanPointsToMembers({
        guildId: drop.guildId,
        client,
        source: 'DROP',
        awards: [{ userId, amount: drop.amount }],
        reason: 'drop',
        // Tous les gagnants du drop partent dans un seul message du flux, publié à sa clôture.
        feedGroup: { key: dropFeedGroupKey(drop.id), flushAt: drop.expiresAt },
      });
      const credited = granted.get(userId) ?? 0;
      if (credited > 0) await markClaimPaid(prisma, claim.id);
      return credited;
    }
    default:
      return 0;
  }
}

/**
 * Réserve une place sur un drop pour un membre.
 *
 * La contrainte d'unicité `(dropId, userId)` bloque le double clic, et
 * l'incrément conditionnel sur `claimCount` empêche deux clics simultanés de
 * dépasser le nombre de gagnants : un contrôle applicatif « compter puis
 * écrire » laisserait passer les deux.
 */
async function reserveClaim(drop: DropRow, userId: string): Promise<ClaimOutcome> {
  try {
    return await prisma.$transaction(async (tx) => {
      const claim = await tx.dropClaim.create({
        data: { dropId: drop.id, guildId: drop.guildId, userId, amount: drop.amount },
      });

      const taken = await tx.drop.updateMany({
        where: {
          id: drop.id,
          closedAt: null,
          expiresAt: { gt: new Date() },
          ...(drop.maxClaims > 0 ? { claimCount: { lt: drop.maxClaims } } : {}),
        },
        data: { claimCount: { increment: 1 } },
      });

      if (taken.count === 0) throw new Error('DROP_FULL');

      const updated = await tx.drop.findUnique({ where: { id: drop.id }, select: { claimCount: true } });
      const full = drop.maxClaims > 0 && (updated?.claimCount ?? 0) >= drop.maxClaims;
      return { ok: true as const, claimId: claim.id, full };
    });
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === 'P2002') return { ok: false, reason: 'already' };
    if (error instanceof Error && error.message === 'DROP_FULL') return { ok: false, reason: 'full' };
    throw error;
  }
}

/**
 * Rend la place d'un ramassage dont la récompense ne sera pas versée. Un
 * ramassage déjà versé n'est jamais retiré, et la place n'est rendue que si la
 * ligne a bien été supprimée ici.
 */
async function releaseClaim(dropId: string, claimId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const removed = await tx.dropClaim.deleteMany({ where: { id: claimId, paidAt: null } });
    if (removed.count > 0) {
      await tx.drop.update({ where: { id: dropId }, data: { claimCount: { decrement: 1 } } });
    }
  }).catch((error: unknown) => {
    // Le ramassage reste en suspens : la reprise le retentera.
    logger.error('Drops', `Libération du ramassage ${claimId} sur le drop ${dropId} impossible:`, error);
  });
}

/**
 * Reprend les versements qu'un redémarrage ou une erreur a laissés en route.
 *
 * Chaque ramassage est d'abord pris à bail par une écriture conditionnelle sur
 * `attemptedAt` : le cycle peut tourner sur plusieurs processus, et le second
 * à lire la ligne la trouve déjà repoussée. Un nouvel échec la laisse en
 * suspens jusqu'au passage suivant, après le même délai, et le plafond de
 * reprises de `@kotbo/shared` l'abandonne plutôt que de la reprendre sans fin.
 */
export async function settlePendingDropClaims(client: Client): Promise<void> {
  const pending = await prisma.dropClaim.findMany({
    where: { paidAt: null, abandonedAt: null, attemptedAt: { lte: new Date(Date.now() - CLAIM_SETTLE_RETRY_MS) } },
    orderBy: { attemptedAt: 'asc' },
    take: CLAIM_SETTLE_BATCH,
    include: { drop: true },
  });

  for (const claim of pending) {
    const leased = await prisma.dropClaim.updateMany({
      where: { id: claim.id, paidAt: null, attemptedAt: claim.attemptedAt },
      data: { attemptedAt: new Date() },
    });
    if (leased.count === 0) continue;

    // Le membre a lu « le gain suivra » : un module coupé depuis garde le gain en
    // attente de son retour au lieu de le retirer.
    const moduleEnabled = await isModuleEnabled(claim.guildId, DROP_TYPE_MODULE[claim.drop.type as DropType]);
    const action = dropClaimSettleAction({ moduleEnabled, attempts: claim.attempts });
    if (action === 'hold') continue;
    if (action === 'abandon') {
      await prisma.dropClaim.updateMany({ where: { id: claim.id, paidAt: null }, data: { abandonedAt: new Date() } });
      logger.error('Drops', `Versement ${claim.id} (drop ${claim.dropId}, membre ${claim.userId}) abandonné après ${claim.attempts} reprises.`);
      continue;
    }

    await prisma.dropClaim.update({ where: { id: claim.id }, data: { attempts: { increment: 1 } } });
    const credited = await creditDrop(client, claim.drop, claim).catch((error: unknown) => {
      logger.error('Drops', `Reprise du versement ${claim.id} (drop ${claim.dropId}) impossible:`, error);
      return null;
    });
    if (credited === null) continue;

    if (credited <= 0) {
      await releaseClaim(claim.dropId, claim.id);
    } else {
      logger.info('Drops', `Versement repris pour ${claim.userId} sur le drop ${claim.dropId}.`);
    }
  }
}

/** Arrivée et rôles du membre qui clique, qu'il soit en cache ou brut de l'API. */
function memberFacts(member: ButtonInteraction['member']): Pick<DropClaimFacts, 'joinedAt' | 'roleIds'> {
  if (!member) return { joinedAt: null, roleIds: [] };
  if (member instanceof GuildMember) {
    return { joinedAt: member.joinedAt, roleIds: [...member.roles.cache.keys()] };
  }
  return { joinedAt: member.joined_at ? new Date(member.joined_at) : null, roleIds: member.roles };
}

/**
 * Rôles du serveur, pour écarter un rôle requis supprimé depuis. `null` quand le serveur
 * n'est pas en cache : sans liste fiable, la règle s'applique telle qu'enregistrée.
 */
function guildRoleIds(interaction: ButtonInteraction): string[] | null {
  const roles = interaction.guild?.roles.cache;
  return roles && roles.size > 0 ? [...roles.keys()] : null;
}

/**
 * Message de refus quand le membre ne respecte pas une règle de ramassage du
 * serveur, `null` sinon. Sans règle réglée, le clic ne coûte qu'une lecture de
 * la colonne : les ramassages du jour ne sont comptés que sous un plafond.
 *
 * Le comptage précède la réservation sans la verrouiller : deux clics simultanés
 * sur deux drops peuvent dépasser le plafond d'un ramassage, ce qui reste sans
 * conséquence pour une règle de confort.
 */
async function claimRuleRefusal(interaction: ButtonInteraction, guildId: string, locale: BotLocale): Promise<string | null> {
  const row = await prisma.guild.findUnique({ where: { id: guildId }, select: { dropClaimRules: true } });
  const rules = effectiveDropClaimRules(normalizeDropClaimRules(row?.dropClaimRules), guildRoleIds(interaction));
  if (!hasDropClaimRules(rules)) return null;

  const now = new Date();
  const claimsLast24h = rules.dailyLimit > 0
    ? await prisma.dropClaim.count({
      where: { guildId, userId: interaction.user.id, createdAt: { gte: new Date(now.getTime() - DROP_CLAIM_LIMIT_WINDOW_MS) } },
    })
    : 0;

  switch (dropClaimBlocker(rules, { ...memberFacts(interaction.member), claimsLast24h, now })) {
    case 'DAILY_LIMIT':
      return m.drop_claim_daily_limit({ limit: rules.dailyLimit }, { locale });
    case 'MEMBER_TOO_NEW':
      return m.drop_claim_member_too_new({ days: rules.minMemberDays }, { locale });
    case 'MISSING_ROLE':
      return m.drop_claim_missing_role({ role: `<@&${rules.requiredRoleId}>` }, { locale });
    default:
      return null;
  }
}

/** Bouton « Ramasser » : réserve la place, verse le gain, ferme si le drop est complet. */
export async function handleDropClaim(interaction: ButtonInteraction, dropId: string): Promise<void> {
  // Réponse différée d'entrée : un versement de points de clan va chercher le
  // membre et ses comptes liés, ce qui dépasse largement les trois secondes
  // laissées par Discord pour accuser réception d'un clic.
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }).catch(() => null);

  const locale = await resolveGuildLocale(interaction.guildId ?? '');
  const drop = await prisma.drop.findUnique({ where: { id: dropId } });

  const refuse = async (message: string): Promise<void> => {
    await interaction.editReply({ content: message }).catch(() => null);
  };

  if (!drop) {
    await refuse(m.drop_claim_gone({}, { locale }));
    return;
  }
  if (drop.closedAt || drop.expiresAt <= new Date()) {
    await refuse(m.drop_claim_closed({}, { locale }));
    return;
  }
  // Même contrôle que le cycle de publication, repassé au clic : un module coupé
  // après l'apparition du drop ne verserait rien (`addXp` se tait), et le membre
  // lirait un gain fictif en consommant une place.
  if (!(await isModuleEnabled(drop.guildId, DROP_TYPE_MODULE[drop.type as DropType]))) {
    await refuse(m.drop_claim_module_off({}, { locale }));
    return;
  }

  const ruleRefusal = await claimRuleRefusal(interaction, drop.guildId, locale);
  if (ruleRefusal) {
    await refuse(ruleRefusal);
    return;
  }

  const reserved = await reserveClaim(drop, interaction.user.id).catch((error: unknown) => {
    // Une contention sur le drop peut faire expirer la transaction : le drop
    // existe toujours, dire le contraire enverrait le membre chercher un
    // problème qui n'existe pas.
    logger.error('Drops', `Réservation du drop ${dropId} impossible pour ${interaction.user.id}:`, error);
    return { ok: false as const, reason: 'error' as const };
  });

  if (!reserved.ok) {
    if (reserved.reason === 'already') await refuse(m.drop_claim_already({}, { locale }));
    else if (reserved.reason === 'full') await refuse(m.drop_claim_full({}, { locale }));
    else await refuse(m.drop_claim_failed({}, { locale }));
    return;
  }

  const credited = await creditDrop(
    interaction.client,
    drop,
    { id: reserved.claimId, userId: interaction.user.id },
  ).catch((error: unknown) => {
    // La place reste réservée et non versée : la reprise du cycle s'en charge.
    logger.error('Drops', `Versement du drop ${dropId} à ${interaction.user.id} impossible, repris plus tard:`, error);
    return null;
  });

  if (credited === null) {
    await refuse(m.drop_claim_pending({}, { locale }));
  } else if (credited <= 0) {
    await releaseClaim(drop.id, reserved.claimId);
    await refuse(
      drop.type === 'CLAN_POINTS'
        ? m.drop_claim_no_clan({}, { locale })
        : drop.type === 'RPG_ITEM'
          ? m.drop_claim_item_gone({}, { locale })
          : m.drop_claim_failed({}, { locale }),
    );
    return;
  } else {
    const claimedItem = drop.itemId
      ? await prisma.rpgItem.findUnique({ where: { id: drop.itemId }, select: { name: true, emoji: true } })
      : null;
    const resource = resourceLabel(
      drop.type as DropType,
      locale,
      claimedItem ? `${claimedItem.emoji} ${claimedItem.name}` : null,
    );
    const amount = credited.toLocaleString(locale === 'fr' ? 'fr-FR' : 'en-US');
    await interaction.editReply({
      content: m.drop_claim_success({ amount, resource }, { locale }),
    }).catch(() => null);
  }

  // Un versement en suspens occupe sa place : le drop complet se ferme quand même.
  if (reserved.full) {
    const closed = await prisma.drop.updateMany({
      where: { id: drop.id, closedAt: null },
      data: { closedAt: new Date() },
    });
    if (closed.count > 0) {
      flushClanPointsFeedGroup(drop.guildId, dropFeedGroupKey(drop.id));
      const refreshed = await prisma.drop.findUnique({ where: { id: drop.id } });
      if (refreshed) await closeDropMessage(interaction.client, refreshed);
    }
  }
}
