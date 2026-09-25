import {
  ActionRowBuilder,
  UserSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  ContainerBuilder,
  EmbedBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Client,
  type GuildMember,
  type MessageActionRowComponentBuilder,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type User,
  type UserSelectMenuInteraction,
} from 'discord.js';
import prisma from '../../utils/db.js';
import { errorMessage } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { errorEmbed, joinFieldEntries, successEmbed, truncate, COLORS } from '../../utils/embeds.js';
import { getEffectiveLocale, type BotLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { parseRpgRoute } from '../../handlers/interactionRoutes.js';
import { applyFirstWinBonus, FIRST_WIN_BONUS } from './rpg/rpgDailyBonusPolicy.js';
import { isFirstWinToday } from './rpg/rpgDailyBonusService.js';
import { embedToV2 } from '../../utils/patchV2.js';
import { combatHpBar, gaugeBar, icon, itemTypeIcon, rarityIcon, RPG_COLORS } from './rpg/rpgIcons.js';
import {
  asClanWarScope,
  getClanWarState,
  getViewerWarTeam,
  type ClanWarScope,
  type ClanWarState,
} from './rpg/rpgClanWarService.js';
import {
  getOrCreateRpgProfile,
  getOrCreateEconomyConfig,
  claimDaily,
  startTravel,
  resolveTravel,
  chooseAdventureOutcome,
  buyShopItem,
  MAX_SHOP_BUY_QUANTITY,
  equipInventoryItem,
  consumePotionItem,
  getShopModuleState,
  createRpgGuild,
  findRpgGuildByName,
  joinRpgGuild,
  leaveRpgGuild,
  depositToRpgGuildTreasury,
  sellShopItem,
  RARITY_COLORS,
  work,
  RPG_GUILD_NAME_MAX,
  RPG_GUILD_NAME_MIN,
  adminSetStats,
  transferCoins,
  fish,
  FISH_COOLDOWN_MS,
  ADVENTURE_ENERGY_COST,
  isItemEquipped,
  xpRequiredForLevel,
} from './economyService.js';
import {
  CLASS_UNLOCK_LEVEL,
  RPG_CLASS_LIST,
  getRpgClass,
} from './rpg/rpgClasses.js';
import { MAX_UPGRADE_LEVEL, itemContribution, type Equipment, type EquippedPiece } from './rpg/rpgStats.js';
import { compareStats, type StatComparison } from './rpg/rpgEquipmentCompare.js';
import {
  ACCESSORY_SLOTS,
  ACCESSORY_SLOT_LEVELS,
  ALL_EQUIPMENT_SLOTS,
  canonicalSlot,
  equippedItemIds,
  isAccessorySlot,
  isEquipmentSlot,
  itemIdInSlot,
  slotForItemType,
  unlockedAccessorySlots,
  type EquipmentSlot,
  type SlottedProfile,
} from './rpg/rpgEquipment.js';
import {
  CHARACTER_CARD_FILENAME,
  renderCharacterCard,
  type CardSlot,
} from './rpg/rpgCharacterCard.js';
import { formatEnchant, type EnchantStack } from './rpg/rpgEnchantments.js';
import { listItemInstances, type ItemProgression } from './rpg/rpgItemInstanceService.js';
import { SKILL_TREE_UNLOCK_LEVEL, getSkillNode } from './rpg/rpgSkillTree.js';
import { discountedPrice, type GuildPerks } from './rpg/rpgGuildBuildings.js';
import {
  ArenaError,
  fightArenaDuel,
  getArenaState,
  type ArenaRecordView,
} from './rpg/rpgArenaService.js';
import {
  buildGuildBuilding,
  getGuildVillageState,
  loadGuildPerksForMember,
  type BuildingView,
} from './rpg/rpgGuildBuildingService.js';
import {
  RPG_GUILD_DESCRIPTION_MAX,
  editRpgGuild,
  getGuildProfile,
  listRpgGuilds,
  type GuildDirectoryEntry,
} from './rpg/rpgGuildDirectoryService.js';
import {
  getSkillTreeState,
  respecSkillTree,
  unlockSkillNode,
  type SkillNodeView,
  type SkillTreeState,
} from './rpg/rpgSkillTreeService.js';
import {
  DISENCHANT_COST,
  applyEnchantScroll,
  getEnchantAltarState,
  removeEnchant,
} from './rpg/rpgEnchantService.js';
import {
  RECLASS_COST,
  allocateStatPoint,
  chooseRpgClass,
  craftRecipe,
  getSalvageQuote,
  getUpgradeQuotes,
  listMaterialSources,
  listRecipesFor,
  salvageItem,
  upgradeEquipment,
  type AllocatableStat,
  type MaterialSource,
} from './rpg/rpgProgressionService.js';
import {
  findRandomMonster,
  listBosses,
  loadAvailableSkills,
  loadEffectiveStats,
  loadEquipment,
  simulateBattle,
} from './combatService.js';
import type { RpgSkill } from './rpg/rpgClasses.js';
import { findGuildMonsterById } from './rpg/rpgBestiaryService.js';
import { huntXpRatio } from './rpg/rpgBestiaryPolicy.js';
import {
  getBestiaryEntry,
  getBestiaryOverview,
  type BestiaryEntry,
} from './rpg/rpgBestiaryStatsService.js';
import { awardRpgTeamPoints } from './rpg/rpgTeamRewards.js';
import type { RpgQuestObjective } from './rpg/rpgQuestPolicy.js';
import { getMemberQuests, type QuestView } from './rpg/rpgQuestService.js';
import type { CampaignReward } from './rpg/rpgCampaign.js';
import {
  getCampaignState,
  openCampaign,
  type CampaignAdvance,
  type CampaignStepView,
} from './rpg/rpgCampaignService.js';
import { trackRpgObjective } from './rpg/rpgObjectiveTracker.js';
import { isShopItemUnlocked, rpgGuildXpNeeded, type ShopModuleState } from './economyPolicy.js';
import { lockRpgProfile, takeInventoryQuantity } from './rpg/rpgInventoryWrites.js';
import { attackRaid, checkRaidAssaultGrant, getRaidPanelState, getRaidState, grantRaidAssaults, RaidError } from './rpg/rpgRaidService.js';
import { buildAssaultEmbed, buildRaidEmbed, healthBar } from './rpg/rpgRaidPanel.js';
import { computeAttack } from './rpg/rpgCombatMath.js';
import {
  bossCooldownMs,
  fightCooldownMs,
  formatCooldown,
  huntCooldownExtraMs,
  huntEnergyCost,
  remainingCooldownMs,
} from './rpg/rpgCombatCooldownPolicy.js';
import { claimFirstKill, formatFirstKillBounty, formatFirstKillReward, getFirstKill, type FirstKillMonster } from './rpg/rpgFirstKillService.js';
import { grantWinTitle, listOwnedTitles, setActiveTitle } from './rpg/rpgTitleService.js';
import { titleBonusParts } from './rpg/rpgTitlePolicy.js';
import { fishBookProgress, type FishBookTier } from './rpg/rpgFishBook.js';
import {
  claimFishBookRewards,
  getFishBookRewards,
  listFishBookClaims,
  type FishBookPayout,
} from './rpg/rpgFishBookRewardService.js';
import {
  getItemCatalog,
  getItemCatalogDetail,
  isUnavailableItem,
  isUniqueItem,
  ITEM_SOURCE_FILTERS,
  matchesSourceFilter,
  type ItemCatalogEntry,
  type ItemSourceFilter,
} from './rpg/rpgItemCatalogService.js';
import {
  DungeonRefused,
  enterDungeon,
  fightDungeonFloor,
  getActiveDungeonRun,
  getDungeonHall,
  leaveDungeon,
  type DungeonFloorResult,
  type DungeonHallEntry,
  type DungeonRefusal,
  type DungeonRunState,
  type DungeonSettlement,
} from './rpg/rpgDungeonService.js';
import { DUNGEON_IDLE_TIMEOUT_MINUTES, groupDungeonLoot, hasFirstClearReward, type DungeonLoot } from './rpg/rpgDungeonPolicy.js';
import {
  buyBlackMarketOffer,
  getBlackMarketState,
  getMemberBlackMarketOffers,
  type BlackMarketOfferView,
} from './rpg/rpgBlackMarketService.js';

export type Locale = BotLocale;
export type PanelInteraction = ButtonInteraction | StringSelectMenuInteraction | UserSelectMenuInteraction | ModalSubmitInteraction;

// Coûts et verrous de combat, centralisés pour que le contrôle préalable et l'écriture
// atomique ne puissent plus diverger.
const FIGHT_ENERGY_COST = 15;
const FIGHT_MIN_HEALTH = 5;
const BOSS_ENERGY_COST = 30;
const BOSS_MIN_HEALTH = 10;
const COMBAT_TURN_TIMEOUT_MS = 60 * 1000;
export type PanelRow = ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>;

/**
 * Un écran du hub.
 *
 * `embeds` reste la façon normale de décrire un écran : le rendu les convertit
 * en Components V2 au dernier moment, ce qui laisse les gestionnaires poser un
 * pied de page sur `view.embeds[0]` après coup, comme avant. `container` sert
 * aux écrans qui ont besoin de composants riches - la boutique et son bouton
 * par article - que jamais un embed ne saura porter.
 */
export type PanelView = {
  embeds: EmbedBuilder[];
  components: PanelRow[];
  container?: ContainerBuilder;
  /**
   * Pièces jointes de l'écran, référencées par `attachment://` dans un embed.
   *
   * Un écran sans image doit poser un tableau VIDE et non l'omettre : sur une mise à
   * jour de message, Discord conserve les pièces jointes précédentes tant qu'on ne lui
   * dit pas le contraire, et la carte d'un écran resterait collée au suivant.
   */
  files?: { attachment: Buffer; name: string }[];
};

/** Charge utile prête à envoyer : un ou plusieurs conteneurs, et leurs pièces jointes. */
type PanelPayload = {
  components: ContainerBuilder[];
  flags: MessageFlags.IsComponentsV2;
  allowedMentions: { parse: [] };
  files: { attachment: Buffer; name: string }[];
};

type AdminStat = 'balance' | 'level' | 'xp';

interface LocalRpgItem {
  id: string;
  name: string;
  description: string;
  emoji: string;
  type: string;
  rarity: string;
  levelRequired: number;
  atkBonus: number;
  defBonus: number;
  spdBonus: number;
  hpBonus: number;
  hpRestore: number;
  energyRestore: number;
  levelXpReward: number;
  clanPointsReward: number;
  raidAssaultBonus: number;
  price: number;
}

interface LocalInventoryEntry {
  id: string;
  rpgProfileId: string;
  itemId: string;
  quantity: number;
  item: LocalRpgItem;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

// Les barres de progression vivent désormais dans `rpgIcons` : elles sont faites
// des segments du module, et non plus de carrés Unicode répétés.

function buildHpBar(current: number, max: number): string {
  return combatHpBar(current, max);
}

/**
 * Identifiant d'un membre saisi à la main, sous forme de mention ou d'identifiant brut.
 *
 * Le paiement passe désormais par un sélecteur natif, mais l'écran d'administration
 * désigne encore sa cible par une saisie libre.
 */
function parseUserIdFromText(text: string): string | null {
  const trimmed = text.trim();
  const mention = trimmed.match(/^<@!?(\d{17,20})>$/);
  if (mention) return mention[1];
  if (/^\d{17,20}$/.test(trimmed)) return trimmed;
  return null;
}

export function isInteractionAdmin(interaction: { memberPermissions: import('discord.js').PermissionsBitField | null }): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
}

export async function ensureOwner(interaction: PanelInteraction, ownerId: string, locale: Locale): Promise<boolean> {
  if (interaction.user.id === ownerId) return true;
  await interaction.reply({ content: m.rpg_hub_not_yours({}, { locale }), flags: [MessageFlags.Ephemeral] });
  return false;
}

export async function replyPanelError(interaction: PanelInteraction, err: unknown, locale: Locale): Promise<void> {
  const embed = errorEmbed(m.rpg_generic_error_title({}, { locale }), errorMessage(err));

  // Les écrans qui défèrent l'interaction (combat, boss) ne peuvent plus utiliser `reply` :
  // l'appel échouait alors en silence et le joueur ne voyait jamais l'erreur.
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ embeds: [embed], flags: [MessageFlags.Ephemeral] }).catch(() => null);
    return;
  }

  await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] }).catch(() => null);
}

/**
 * Compose l'écran en un seul bloc Components V2, commandes comprises.
 *
 * Les rangées vivaient sous l'embed, dans un bloc séparé : à chaque changement
 * d'écran, le corps et les boutons se redessinaient l'un après l'autre et la
 * navigation sautait. Enfermer les commandes dans le conteneur de l'écran -
 * comme le fait `/casier` - donne une carte unique qui se remplace d'un bloc.
 *
 * Le nombre de composants ne change pas : ils sont seulement imbriqués, ce qui
 * laisse intacte la limite des 40 par message.
 */
/**
 * Nombre de composants d'un conteneur, enfants compris.
 *
 * Discord plafonne un message à `MAX_MESSAGE_COMPONENTS`, en comptant TOUT : le
 * conteneur, chaque bloc de texte, chaque séparateur, et surtout chaque section, qui
 * en vaut trois à elle seule. Au-delà, il rejette le message entier avec un
 * `COMPONENT_MAX_TOTAL_COMPONENTS_EXCEEDED` qui ne dit pas quel écran est en cause.
 */
export function countComponents(node: unknown): number {
  if (Array.isArray(node)) {
    return node.reduce<number>((total, child) => total + countComponents(child), 0);
  }
  if (!node || typeof node !== 'object') return 0;

  const record = node as Record<string, unknown>;
  // Un nœud sans `type` est un emballage (accessoire, média) : il ne compte pas pour
  // lui-même, seulement pour ce qu'il contient.
  const self = typeof record.type === 'number' ? 1 : 0;

  return self
    + countComponents(record.components)
    + countComponents(record.accessory)
    + countComponents(record.items);
}

/** Plafond de composants d'un message, imposé par Discord. */
export const MAX_MESSAGE_COMPONENTS = 40;

export function renderPanelView(view: PanelView): PanelPayload {
  const containers = view.container
    ? [view.container]
    : view.embeds.map((embed) => embedToV2(embed));

  if (containers.length === 0) {
    containers.push(new ContainerBuilder().setAccentColor(RPG_COLORS.hub));
  }

  const host = containers[containers.length - 1];
  if (view.components.length > 0) {
    host.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    for (const row of view.components) {
      host.addActionRowComponents(row as ActionRowBuilder<MessageActionRowComponentBuilder>);
    }
  }

  // Un dépassement rend le message inaffichable : mieux vaut le nommer ici, avec ce
  // qu'il contient, que de lire un code d'erreur nu dans les journaux de Discord.
  const used = countComponents(containers.map((entry) => entry.toJSON()));
  if (used > MAX_MESSAGE_COMPONENTS) {
    logger.error('RpgPanel', `Écran à ${used} composants, au-delà des ${MAX_MESSAGE_COMPONENTS} autorisés : Discord le refusera.`);
  }

  return {
    components: containers,
    flags: MessageFlags.IsComponentsV2,
    // Les fiches de guilde et les tableaux de guerre citent des membres : un
    // embed n'a jamais notifié, un TextDisplay le ferait sans ce garde-fou.
    allowedMentions: { parse: [] },
    // Toujours transmis, même vide : une mise à jour de message qui n'énumère pas ses
    // pièces jointes garde celles d'avant, et la carte d'un écran resterait affichée
    // sur le suivant.
    files: view.files ?? [],
  };
}

/**
 * Pose un retour d'action sur une vue, quelle que soit sa forme.
 *
 * Les écrans en conteneur V2 n'ont pas d'embed : écrire dans `view.embeds[0]` y plantait.
 * Le retour y devient une dernière ligne en petit, à l'endroit où l'oeil cherche le pied
 * de page d'un embed.
 */
export function withNote(view: PanelView, text: string): PanelView {
  if (!text) return view;

  if (view.container) {
    view.container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${truncate(text, 400)}`));
    return view;
  }

  view.embeds[0]?.setFooter({ text: truncate(text, 2048) });
  return view;
}

export async function respond(interaction: PanelInteraction, view: PanelView): Promise<void> {
  const payload = renderPanelView(view);

  if (interaction.deferred) {
    await interaction.editReply(payload);
    return;
  }

  if (interaction.isModalSubmit() && interaction.isFromMessage()) {
    await interaction.update(payload);
    return;
  }
  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    await interaction.update(payload);
    return;
  }
  await interaction.reply(payload);
}

function backRow(ownerId: string, locale: Locale): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:hub`)
      .setLabel(m.rpg_hub_btn_back({}, { locale }))
      .setEmoji(icon('rpgBack'))
      .setStyle(ButtonStyle.Secondary),
  );
}

/**
 * Retour de fin de combat : la liste des boss après un boss, le hub sinon. Un joueur qui
 * enchaîne les boss y retourne dans tous les cas, même quand aucun n'est disponible : la
 * liste dit alors lequel revient et quand.
 */
function fightBackRow(ownerId: string, locale: Locale, isBoss: boolean): ActionRowBuilder<ButtonBuilder> {
  if (!isBoss) return backRow(ownerId, locale);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:boss`)
      .setLabel(m.rpg_fight_back_bosses({}, { locale }))
      .setEmoji(icon('rpgBack'))
      .setStyle(ButtonStyle.Secondary),
  );
}

// ─────────────────────────────────────────────────────────────
// Hub (vue par défaut)
// ─────────────────────────────────────────────────────────────

/**
 * Libellé d'un objet équipé : niveau de forge et enchantements posés.
 * Les deux vivent sur l'instance, donc sur l'exemplaire réellement possédé.
 */
function equippedLabel(
  item: { emoji: string; name: string } | null,
  piece: EquippedPiece | null,
  locale: Locale,
): string {
  if (!item) return m.rpg_profile_no_item({}, { locale });

  const upgrade = piece?.upgrade ?? 0;
  const base = upgrade > 0 ? `${item.emoji} ${item.name} **+${upgrade}**` : `${item.emoji} ${item.name}`;

  const enchants = piece?.enchants ?? [];
  if (enchants.length === 0) return base;

  return `${base}\n${enchants.map(formatEnchant).join(' · ')}`;
}

/**
 * Les lignes « Accessoire N » de la fiche.
 *
 * Les emplacements encore verrouillés sont montrés eux aussi : voir qu'un troisième
 * emplacement s'ouvre au niveau 24 est précisément ce qui donne envie d'y arriver, et
 * c'est invisible si on n'affiche que ce qui est déjà débloqué.
 */
function accessoryLines(
  profile: SlottedProfile & { level: number },
  itemById: Map<string, { emoji: string; name: string }>,
  equipment: Equipment,
  locale: Locale,
): string[] {
  return ACCESSORY_SLOTS.map((slot, index) => {
    const label = m.rpg_profile_accessory_slot({ index: index + 1 }, { locale });
    const required = ACCESSORY_SLOT_LEVELS[slot];

    if (profile.level < required) {
      return `🔒 ${label} : *${m.rpg_profile_slot_locked({ level: required }, { locale })}*`;
    }

    const itemId = itemIdInSlot(profile, slot);
    const item = itemId ? itemById.get(itemId) ?? null : null;
    const value = item
      ? equippedLabel(item, equipment.accessories[index] ?? null, locale)
      : `*${m.rpg_profile_slot_empty({}, { locale })}*`;

    return `${icon('rpgAccessory')} ${label} : ${value}`;
  });
}

/**
 * Emplacements d'équipement tels que la carte les dessine.
 *
 * Les emplacements verrouillés y figurent avec leur niveau requis : voir qu'un troisième
 * anneau s'ouvre au niveau 24 est précisément ce qui donne envie d'y arriver.
 */
function cardSlots(
  profile: SlottedProfile & { level: number },
  itemById: Map<string, { name: string; rarity: string }>,
  equipment: Equipment,
  locale: Locale,
): CardSlot[] {
  const pieceFor = (slot: EquipmentSlot, accessoryIndex: number | null) =>
    accessoryIndex === null
      ? (slot === 'weapon' ? equipment.weapon : equipment.armor)
      : equipment.accessories[accessoryIndex] ?? null;

  const build = (slot: EquipmentSlot, label: string, accessoryIndex: number | null, lockedAtLevel: number | null): CardSlot => {
    if (lockedAtLevel !== null) {
      return { label, itemName: null, rarity: null, upgrade: 0, lockedAtLevel };
    }

    const itemId = itemIdInSlot(profile, slot);
    const item = itemId ? itemById.get(itemId) ?? null : null;
    const piece = pieceFor(slot, accessoryIndex);

    return {
      label,
      itemName: item?.name ?? null,
      rarity: item?.rarity ?? null,
      upgrade: piece?.upgrade ?? 0,
      lockedAtLevel: null,
    };
  };

  return [
    build('weapon', m.rpg_card_slot_weapon({}, { locale }), null, null),
    build('armor', m.rpg_card_slot_armor({}, { locale }), null, null),
    ...ACCESSORY_SLOTS.map((slot, index) => build(
      slot,
      m.rpg_profile_accessory_slot({ index: index + 1 }, { locale }),
      index,
      profile.level < ACCESSORY_SLOT_LEVELS[slot] ? ACCESSORY_SLOT_LEVELS[slot] : null,
    )),
  ];
}

/**
 * La fiche : une carte rendue en image, et le peu de texte qu'elle ne porte pas.
 *
 * L'écran est un conteneur V2 et non un embed, pour une raison précise : `embedToV2`
 * transforme chaque champ d'embed en son propre bloc de texte et perd `inline`. Bourse,
 * classe, guilde et points s'empilaient donc sur quatre lignes alors qu'ils tiennent
 * sur une seule. Les écrire à la main est le seul moyen de les garder côte à côte.
 *
 * Le rendu de la carte peut échouer : les jauges et l'équipement reviennent alors en
 * texte, pour que la fiche reste complète.
 */
async function buildHubContainer(
  guildId: string,
  target: User,
  locale: Locale,
): Promise<{ container: ContainerBuilder; files: { attachment: Buffer; name: string }[] }> {
  const profile = await getOrCreateRpgProfile(guildId, target.id);
  const config = await getOrCreateEconomyConfig(guildId);

  const equippedIds = equippedItemIds(profile);
  const [equippedItems, activeTitle] = await Promise.all([
    equippedIds.length > 0 ? prisma.rpgItem.findMany({ where: { id: { in: equippedIds } } }) : Promise.resolve([]),
    profile.activeTitleId
      ? prisma.rpgTitle.findUnique({ where: { id: profile.activeTitleId }, select: { name: true, color: true } })
      : Promise.resolve(null),
  ]);
  const itemById = new Map(equippedItems.map((item) => [item.id, item]));

  // L'équipement est rechargé avec sa progression : c'est elle qui porte la forge et les
  // enchantements, et la fiche doit montrer exactement ce que le combat va utiliser.
  //
  // `loadEffectiveStats` plutôt que `getEffectiveStats` : lui seul charge aussi l'arbre de
  // compétences et le village de guilde. Les oublier ferait afficher à la fiche des
  // statistiques inférieures à celles que le combat emploie réellement.
  const equipment = await loadEquipment(profile);
  const stats = await loadEffectiveStats(profile);
  const rpgClass = getRpgClass(profile.className);
  const xpNeeded = xpRequiredForLevel(profile.level);
  // La fiche affiche les PV plafonnés aux PV max effectifs : déséquiper un objet qui
  // donnait des PV ne doit pas laisser un « 180/140 » incohérent à l'écran.
  const shownHp = Math.min(profile.health, stats.maxHealth);

  const card = await renderCharacterCard({
    displayName: target.displayName,
    avatarUrl: target.displayAvatarURL({ extension: 'png', size: 256 }),
    level: profile.level,
    className: rpgClass?.name ?? null,
    stats,
    hp: { current: shownHp, max: stats.maxHealth },
    xp: { current: profile.xp, max: xpNeeded },
    energy: { current: profile.energy, max: config.maxEnergy },
    slots: cardSlots(profile, itemById, equipment, locale),
    guildName: profile.rpgGuild ? `${profile.rpgGuild.emoji} ${profile.rpgGuild.name}` : null,
    title: activeTitle,
  });

  const container = new ContainerBuilder().setAccentColor(RPG_COLORS.hub);

  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `## ${icon('rpgCharacter')} ${m.rpg_profile_title({ name: target.displayName }, { locale })}\n`
    + (activeTitle && !card ? `*${activeTitle.name}*\n` : '')
    + (profile.isTraveling
      ? `${icon('rpgTravel')} ${m.rpg_profile_traveling({ dest: profile.travelDestination ?? '' }, { locale })}`
      : `${icon('rpgRest')} ${m.rpg_profile_resting({}, { locale })}`),
  ));

  if (card) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder({ media: { url: `attachment://${CHARACTER_CARD_FILENAME}` } }),
      ),
    );
  } else {
    // Repli sans image : la carte porte l'essentiel de la fiche, il faut bien le redire.
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `${icon('rpgHp')} ${shownHp} / ${stats.maxHealth} ${gaugeBar(shownHp, stats.maxHealth, 'hp')}\n`
      + `${icon('rpgXp')} ${profile.xp} / ${xpNeeded} ${gaugeBar(profile.xp, xpNeeded, 'xp')}\n`
      + `${icon('rpgEnergy')} ${profile.energy} / ${config.maxEnergy} ${gaugeBar(profile.energy, config.maxEnergy, 'en')}\n\n`
      + m.rpg_profile_combat_stats_value({
        iAtk: icon('rpgAtk'), atk: stats.attack,
        iDef: icon('rpgDef'), def: stats.defense,
        iSpd: icon('rpgSpd'), spd: stats.speed,
      }, { locale })
      + `\n${m.rpg_profile_crit_value({ iCrit: icon('rpgCrit'), crit: Math.round(stats.critChance * 100) }, { locale })}\n\n`
      + m.rpg_profile_equipment_value({
        iWeapon: icon('rpgSword'), weapon: equippedLabel(itemById.get(profile.weaponId ?? '') ?? null, equipment.weapon, locale),
        iArmor: icon('rpgArmor'), armor: equippedLabel(itemById.get(profile.armorId ?? '') ?? null, equipment.armor, locale),
      }, { locale })
      + `\n${accessoryLines(profile, itemById, equipment, locale).join('\n')}`,
    ));
  }

  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));

  // Une seule ligne : ce que la carte ne porte pas, et que le joueur regarde le plus
  // souvent avant d'agir. En champs d'embed, ces trois-là s'empilaient.
  const summary = [
    `${config.currencyEmoji} **${profile.balance}** ${config.currencyName}`,
    rpgClass
      ? `${rpgClass.emoji} **${rpgClass.name}**`
      : `${icon('rpgEnchant')} ${m.rpg_profile_class_none({ level: CLASS_UNLOCK_LEVEL }, { locale })}`,
    profile.rpgGuild
      ? `${profile.rpgGuild.emoji} **${truncate(profile.rpgGuild.name, 30)}** · ${icon('coins')} ${profile.rpgGuild.treasury}`
      : `${icon('rpgGuild')} ${m.rpg_profile_guild_none({}, { locale })}`,
  ];

  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(summary.join('  ·  ')));

  // Points en attente : une seule ligne de plus, et seulement quand il y a de quoi
  // dépenser. Le passif de classe la complète, faute de place sur la ligne du dessus.
  const notes: string[] = [];
  if (rpgClass) notes.push(`*${rpgClass.passive.name}*`);
  if (profile.statPoints > 0) {
    notes.push(m.rpg_profile_pending_stat_points({ points: profile.statPoints }, { locale }));
  }
  if (profile.skillPoints > 0) {
    notes.push(m.rpg_profile_pending_skill_points({ points: profile.skillPoints }, { locale }));
  }
  if (notes.length > 0) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${notes.join('  ·  ')}`));
  }

  return {
    container,
    files: card ? [{ attachment: card, name: CHARACTER_CARD_FILENAME }] : [],
  };
}

/**
 * Destinations rangées dans le menu de navigation.
 *
 * Le hub alignait treize boutons sur trois rangées, dont neuf menaient à un
 * écran qu'on ouvre une fois par partie : la fiche disparaissait sous ses
 * propres commandes. Ne restent en boutons que les gestes du tour de jeu ; tout
 * ce qui se visite passe par ce menu, qui ne coûte qu'une rangée.
 *
 * `value` est le nom de section lu par `renderSection`, sauf `pay` et `sell`
 * qui ouvrent une fenêtre de saisie.
 */
function hubNavOptions(locale: Locale, isAdmin: boolean): { label: string; value: string; description?: string; emoji: string }[] {
  const options = [
    { label: m.rpg_hub_btn_quests({}, { locale }), value: 'quests', description: m.rpg_hub_nav_quests_desc({}, { locale }), emoji: icon('rpgMap') },
    { label: m.rpg_hub_btn_campaign({}, { locale }), value: 'campaign', description: m.rpg_hub_nav_campaign_desc({}, { locale }), emoji: icon('rpgKey') },
    { label: m.rpg_hub_btn_dungeon({}, { locale }), value: 'dungeon', description: m.rpg_hub_nav_dungeon_desc({}, { locale }), emoji: '🏰' },
    { label: m.rpg_hub_btn_character({}, { locale }), value: 'character', description: m.rpg_hub_nav_character_desc({}, { locale }), emoji: icon('rpgCharacter') },
    { label: m.rpg_hub_btn_skilltree({}, { locale }), value: 'skilltree', description: m.rpg_hub_nav_skilltree_desc({}, { locale }), emoji: icon('rpgEnchant') },
    { label: m.rpg_hub_btn_craft({}, { locale }), value: 'craft', description: m.rpg_hub_nav_craft_desc({}, { locale }), emoji: icon('rpgCraft') },
    { label: m.rpg_hub_btn_forge({}, { locale }), value: 'forge', description: m.rpg_hub_nav_forge_desc({}, { locale }), emoji: icon('rpgForge') },
    { label: m.rpg_hub_btn_enchant({}, { locale }), value: 'enchant', description: m.rpg_hub_nav_enchant_desc({}, { locale }), emoji: icon('rpgEnchant') },
    { label: m.rpg_hub_btn_bestiary({}, { locale }), value: 'bestiary', description: m.rpg_hub_nav_bestiary_desc({}, { locale }), emoji: icon('rpgBestiary') },
    { label: m.rpg_hub_btn_itembook({}, { locale }), value: 'itembook', description: m.rpg_hub_nav_itembook_desc({}, { locale }), emoji: icon('rpgBag') },
    { label: m.rpg_hub_btn_fishbook({}, { locale }), value: 'fishbook', description: m.rpg_hub_nav_fishbook_desc({}, { locale }), emoji: icon('rpgFish') },
    { label: m.rpg_hub_btn_guild({}, { locale }), value: 'guild', description: m.rpg_hub_nav_guild_desc({}, { locale }), emoji: icon('rpgGuild') },
    { label: m.rpg_hub_btn_guilds({}, { locale }), value: 'guilds', description: m.rpg_hub_nav_guilds_desc({}, { locale }), emoji: icon('rpgClan') },
    { label: m.rpg_hub_btn_village({}, { locale }), value: 'village', description: m.rpg_hub_nav_village_desc({}, { locale }), emoji: '🏘️' },
    { label: m.rpg_hub_btn_arena({}, { locale }), value: 'arena', description: m.rpg_hub_nav_arena_desc({}, { locale }), emoji: '⚔️' },
    { label: m.rpg_war_title({}, { locale }), value: 'clanwar', description: m.rpg_hub_nav_war_desc({}, { locale }), emoji: icon('rpgWar') },
    { label: m.rpg_hub_btn_pay({}, { locale }), value: 'pay', description: m.rpg_hub_nav_pay_desc({}, { locale }), emoji: icon('rpgPay') },
    { label: m.rpg_hub_btn_sell({}, { locale }), value: 'sell', description: m.rpg_hub_nav_sell_desc({}, { locale }), emoji: icon('rpgSell') },
    { label: m.rpg_hub_btn_market({}, { locale }), value: 'market', description: m.rpg_hub_nav_market_desc({}, { locale }), emoji: icon('rpgShop') },
  ];

  if (isAdmin) {
    options.push({ label: m.rpg_hub_btn_admin({}, { locale }), value: 'admin', description: m.rpg_hub_nav_admin_desc({}, { locale }), emoji: icon('settings') });
  }

  return options;
}

function hubNavRow(ownerId: string, locale: Locale, isAdmin: boolean): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`rpg:navsel:${ownerId}`)
    .setPlaceholder(m.rpg_hub_nav_placeholder({}, { locale }))
    .addOptions(hubNavOptions(locale, isAdmin).map((option) => ({
      label: truncate(option.label, 100),
      value: option.value,
      description: optionDescription(option.description),
      emoji: optionEmoji(option.emoji),
    })));

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

/** Nombre maximal de boutons que Discord accepte dans une rangée. */
const BUTTONS_PER_ROW = 5;

/**
 * Répartit des boutons en rangées valides.
 *
 * Discord rejette le message ENTIER — pas seulement la rangée — dès qu'une rangée
 * dépasse cinq boutons, avec un `BASE_TYPE_BAD_LENGTH` qui ne dit pas laquelle. Les
 * rangées du hub se remplissent en partie sous condition (marché noir, raid), si bien
 * que le dépassement n'apparaît que sur certains serveurs, à certaines heures.
 */
function buttonRows(buttons: ButtonBuilder[]): PanelRow[] {
  const rows: PanelRow[] = [];

  for (let i = 0; i < buttons.length; i += BUTTONS_PER_ROW) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(i, i + BUTTONS_PER_ROW)));
  }

  return rows;
}

function buildHubButtons(
  ownerId: string,
  locale: Locale,
  isAdmin: boolean,
  blackMarketOpen: boolean,
  raidOpen: boolean,
  tracked: { id: string; name: string } | null,
): PanelRow[] {
  // Ce qui se joue : le tour de jeu, dans l'ordre où on l'enchaîne.
  const played = [
    new ButtonBuilder().setCustomId(`rpg:fight:${ownerId}`).setLabel(m.rpg_hub_btn_fight({}, { locale })).setEmoji(icon('rpgFight')).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`rpg:nav:${ownerId}:boss`).setLabel(m.rpg_hub_btn_boss({}, { locale })).setEmoji(icon('rpgBoss')).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`rpg:nav:${ownerId}:travel`).setLabel(m.rpg_hub_btn_travel({}, { locale })).setEmoji(icon('rpgTravel')).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`rpg:daily:${ownerId}`).setLabel(m.rpg_hub_btn_daily({}, { locale })).setEmoji(icon('rpgDaily')).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`rpg:fish:${ownerId}`).setLabel(m.rpg_hub_btn_fish({}, { locale })).setEmoji(icon('rpgFish')).setStyle(ButtonStyle.Success),
  ];

  // La traque se place à côté du combat au hasard, qu'elle double sans le remplacer : le
  // joueur choisit à chaque clic s'il paie le surcoût. Elle n'existe que le temps d'une
  // traque, et repousse le dernier geste de la rangée vers la suivante.
  //
  // Le bouton ne porte pas le nom de la cible : un nom long l'élargissait assez pour pousser
  // ses voisins à la ligne sur mobile. La cible est nommée sur la fiche, juste au-dessus.
  if (tracked) {
    played.splice(1, 0, new ButtonBuilder()
      .setCustomId(`rpg:hunt:${ownerId}:${tracked.id}`)
      .setLabel(m.rpg_track_hub_btn({}, { locale }))
      .setEmoji(icon('rpgSpd'))
      .setStyle(ButtonStyle.Danger));
  }

  // Ce qui se ramasse et ce qui se porte. `work` ouvre la rangée : il appartient au même
  // tour de jeu que la quotidienne, mais la première rangée est déjà pleine.
  const carried = [
    new ButtonBuilder().setCustomId(`rpg:work:${ownerId}`).setLabel(m.rpg_hub_btn_work({}, { locale })).setEmoji(icon('coins')).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`rpg:nav:${ownerId}:inventory`).setLabel(m.rpg_hub_btn_inventory({}, { locale })).setEmoji(icon('rpgBag')).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`rpg:nav:${ownerId}:shop`).setLabel(m.rpg_hub_btn_shop({}, { locale })).setEmoji(icon('rpgShop')).setStyle(ButtonStyle.Primary),
  ];

  // Le marché noir n'apparaît que pendant sa fenêtre d'ouverture : c'est le seul indice
  // donné aux membres qui ne comptent pas sur l'annonce, et ça garde l'effet de surprise.
  if (blackMarketOpen) {
    carried.push(
      new ButtonBuilder()
        .setCustomId(`rpg:nav:${ownerId}:blackmarket`)
        .setLabel(m.rpg_blackmarket_btn({}, { locale }))
        .setEmoji(icon('rpgBlackMarket'))
        .setStyle(ButtonStyle.Danger),
    );
  }

  // Même règle pour le raid, pour la raison inverse : il se jouait uniquement depuis son
  // annonce, et qui arrivait après elle n'avait plus aucun moyen de le trouver.
  if (raidOpen) {
    carried.push(
      new ButtonBuilder()
        .setCustomId(`rpg:nav:${ownerId}:raid`)
        .setLabel(m.rpg_raid_panel_btn({}, { locale }))
        .setEmoji(icon('rpgRaid'))
        .setStyle(ButtonStyle.Danger),
    );
  }

  carried.unshift(...played.splice(BUTTONS_PER_ROW));

  return [...buttonRows(played), ...buttonRows(carried), hubNavRow(ownerId, locale, isAdmin)];
}

export async function buildHubView(
  guildId: string,
  viewer: User,
  target: User,
  locale: Locale,
  viewerIsAdmin = false,
): Promise<PanelView> {
  const { container, files } = await buildHubContainer(guildId, target, locale);
  // Consulter la fiche d'un autre membre est en lecture seule : aucun bouton d'action.
  if (viewer.id !== target.id) {
    return { embeds: [], components: [], container, files };
  }
  const [blackMarket, raid, potions, hunter] = await Promise.all([
    getBlackMarketState(guildId),
    getRaidState(guildId),
    quickDrinkRow(guildId, viewer.id, locale, 'hub'),
    prisma.rpgProfile.findUnique({ where: { guildId_userId: { guildId, userId: viewer.id } }, select: { trackedMonsterId: true, level: true } }),
  ]);
  const tracked = hunter ? await loadTrackedMonster(guildId, viewer.id, hunter.trackedMonsterId, hunter.level) : null;
  if (tracked) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `-# ${icon('rpgSpd')} ${m.rpg_track_hub_note({ name: `${tracked.emoji} ${tracked.name}` }, { locale })}`,
    ));
  }
  return {
    embeds: [],
    components: [
      ...buildHubButtons(viewer.id, locale, viewerIsAdmin, Boolean(blackMarket.session), raid.enabled && raid.open !== null, tracked),
      ...(potions ? [potions] : []),
    ],
    container,
    files,
  };
}

// ─────────────────────────────────────────────────────────────
// Inventaire
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Inventaire
// ─────────────────────────────────────────────────────────────

/** Part du prix d'achat rendue à la revente. Doit suivre `sellShopItem`. */
const SELL_RATIO = 0.5;

/** Objets par page du sac. Une section par objet : au-delà, le conteneur devient illisible. */
const BAG_PAGE_SIZE = 6;

export type BagCategory = 'all' | 'WEAPON' | 'ARMOR' | 'ACCESSORY' | 'POTION' | 'SCROLL' | 'MATERIAL';

export const BAG_CATEGORIES: BagCategory[] = ['all', 'WEAPON', 'ARMOR', 'ACCESSORY', 'POTION', 'SCROLL', 'MATERIAL'];

export function bagCategoryLabel(category: BagCategory, locale: Locale): string {
  if (category === 'all') return m.rpg_inventory_cat_all({}, { locale });
  return shopCategoryLabel(category, locale);
}

type BagState = { category: BagCategory; page: number };

/** `rest` porte la catégorie puis la page, comme pour la boutique. */
function parseBagState(rest: string[]): BagState {
  const category = BAG_CATEGORIES.includes(rest[0] as BagCategory) ? (rest[0] as BagCategory) : 'all';
  const page = Math.max(0, Number.parseInt(rest[1] ?? '0', 10) || 0);
  return { category, page };
}

function bagNavId(ownerId: string, state: BagState): string {
  return `rpg:nav:${ownerId}:inventory:${state.category}:${state.page}`;
}

/** Bonus d'un objet, en une ligne. Vide quand l'objet n'en porte aucun. */
export function itemStatLine(item: LocalRpgItem, locale: Locale): string {
  const parts = [
    item.atkBonus ? `${icon('rpgAtk')} +${item.atkBonus}` : null,
    item.defBonus ? `${icon('rpgDef')} +${item.defBonus}` : null,
    item.spdBonus ? `${icon('rpgSpd')} +${item.spdBonus}` : null,
    item.hpBonus ? `${icon('rpgHp')} +${item.hpBonus}` : null,
    item.hpRestore ? `${icon('rpgHp')} ${m.rpg_item_restores_hp({ hp: item.hpRestore }, { locale })}` : null,
    item.energyRestore ? `${icon('rpgEnergy')} +${item.energyRestore}` : null,
  ].filter((part): part is string => part !== null);

  return parts.join('  ');
}

const COMPARE_STAT_ICONS: Record<StatComparison['stat'], string> = { atk: 'rpgAtk', def: 'rpgDef', spd: 'rpgSpd', hp: 'rpgHp' };

function comparisonLine(lines: StatComparison[], locale: Locale): string {
  if (lines.length === 0) return m.rpg_item_compare_no_stats({}, { locale });
  return lines
    .map(({ stat, value, delta }) => `${icon(COMPARE_STAT_ICONS[stat])} ${value} (${delta > 0 ? `+${delta}` : delta < 0 ? `−${-delta}` : '='})`)
    .join('  ');
}

/**
 * Enchantements gagnés et perdus en échangeant la pièce portée contre l'exemplaire regardé.
 * Leurs effets ne s'additionnent pas aux stats brutes (une partie est en pourcentage du
 * total) : on les nomme plutôt que de les chiffrer.
 */
function enchantSwapLine(candidate: EnchantStack[], worn: EnchantStack[], locale: Locale): string {
  const same = (a: EnchantStack, b: EnchantStack) => a.id === b.id && a.tier === b.tier;
  const gained = candidate.filter((stack) => !worn.some((other) => same(stack, other)));
  const lost = worn.filter((stack) => !candidate.some((other) => same(stack, other)));
  return [
    gained.length > 0 ? m.rpg_item_compare_enchants_gained({ enchants: gained.map(formatEnchant).join(', ') }, { locale }) : '',
    lost.length > 0 ? m.rpg_item_compare_enchants_lost({ enchants: lost.map(formatEnchant).join(', ') }, { locale }) : '',
  ].filter(Boolean).join(' · ');
}

/**
 * Champ « comparé à ce que vous portez » d'une fiche d'objet, ou `null` quand l'objet ne
 * s'équipe pas ou qu'il est déjà porté.
 *
 * Une arme ou une armure se compare à celle de son emplacement. Un accessoire va dans le
 * premier emplacement libre : s'il y en a un, il n'enlève rien ; sinon le joueur devra en
 * retirer un, et chacun de ceux portés est comparé.
 */
async function equipmentComparisonField(
  profile: Awaited<ReturnType<typeof getOrCreateRpgProfile>>,
  item: LocalRpgItem,
  progression: { upgrade: number; enchants: EnchantStack[] },
  locale: Locale,
): Promise<{ name: string; value: string; inline: boolean } | null> {
  const slot = slotForItemType(item.type);
  if (!slot || equippedItemIds(profile).includes(item.id)) return null;

  const equipment = await loadEquipment(profile);
  const candidate = itemContribution({ ...item, upgrade: progression.upgrade, enchants: progression.enchants });
  const nameOf = (itemId: string | null) => {
    const owned = profile.inventory.find((entry) => entry.itemId === itemId)?.item;
    return owned ? `${owned.emoji} ${owned.name}` : '?';
  };

  const targets: { label: string; piece: EquippedPiece | null }[] = [];
  if (slot === 'weapon' || slot === 'armor') {
    const piece = slot === 'weapon' ? equipment.weapon : equipment.armor;
    targets.push({ label: piece ? nameOf(itemIdInSlot(profile, slot)) : m.rpg_item_compare_free({}, { locale }), piece });
  } else if (equipment.accessories.some((piece) => piece === null)) {
    targets.push({ label: m.rpg_item_compare_free({}, { locale }), piece: null });
  } else {
    unlockedAccessorySlots(profile.level).forEach((accessorySlot, index) => {
      targets.push({ label: nameOf(itemIdInSlot(profile, accessorySlot)), piece: equipment.accessories[index] ?? null });
    });
  }
  if (targets.length === 0) return null;

  const value = targets
    .map((target) => [
      `${target.label} : ${comparisonLine(compareStats(candidate, target.piece ? itemContribution(target.piece) : null), locale)}`,
      enchantSwapLine(progression.enchants, target.piece?.enchants ?? [], locale),
    ].filter(Boolean).join(' · '))
    .join('\n');
  return { name: m.rpg_item_field_compare({}, { locale }), value: truncate(value, 1024), inline: false };
}

/**
 * Exigence de niveau d'un objet, telle qu'elle s'affiche.
 *
 * L'inventaire et la boutique taisaient complètement `levelRequired` : on achetait une
 * arme épique pour découvrir au moment de l'équiper qu'elle demandait dix niveaux de plus.
 */
function levelRequirementLabel(item: { levelRequired: number }, playerLevel: number, locale: Locale): string {
  if (item.levelRequired <= 0) return '';
  return playerLevel >= item.levelRequired
    ? `· ${m.rpg_item_level_required({ level: item.levelRequired }, { locale })}`
    : `· ⚠️ ${m.rpg_item_level_required({ level: item.levelRequired }, { locale })}`;
}

/**
 * Ligne du sac : les exemplaires ordinaires d'un objet, ou UN exemplaire forgé.
 *
 * Un exemplaire forgé ou enchanté a sa propre ligne : il ne s'empile ni avec un autre
 * niveau de forge ni avec les exemplaires ordinaires, qui ne partagent pas sa progression.
 */
type BagEntry = {
  entry: LocalInventoryEntry;
  copy: ItemProgression | null;
  count: number;
  worn: boolean;
  /** L'objet a aussi des exemplaires forgés ou enchantés : la ligne doit dire lequel elle montre. */
  mixed: boolean;
};

function bagEntries(
  inventory: LocalInventoryEntry[],
  copies: ItemProgression[],
  profile: SlottedProfile,
): BagEntry[] {
  const byItem = new Map<string, ItemProgression[]>();
  for (const copy of copies) byItem.set(copy.itemId, [...(byItem.get(copy.itemId) ?? []), copy]);

  return inventory.flatMap((entry) => {
    const forged = (byItem.get(entry.item.id) ?? []).slice(0, Math.max(0, entry.quantity));
    const worn = isItemEquipped(profile, entry.item.id);
    const wornForged = worn && forged.some((copy) => copy.equipped);
    const plain = entry.quantity - forged.length;
    return [
      ...(plain > 0 ? [{ entry, copy: null, count: plain, worn: worn && !wornForged, mixed: forged.length > 0 }] : []),
      ...forged.map((copy) => ({ entry, copy, count: 1, worn: worn && copy.equipped, mixed: true })),
    ];
  });
}

function copyLabel(item: { emoji: string; name: string }, copy: ItemProgression | null): string {
  return copy && copy.upgrade > 0 ? `${item.emoji} ${item.name} +${copy.upgrade}` : `${item.emoji} ${item.name}`;
}

/**
 * Distingue les exemplaires d'un même objet : sans ce repère, la ligne ordinaire et la
 * ligne enchantée portent le même nom, et rééquiper la mauvaise fait croire à un
 * enchantement perdu. La forge se lit déjà dans le « +N » du nom.
 */
function copyKindTag(copy: ItemProgression | null, locale: Locale): string {
  if (!copy) return m.rpg_inventory_plain_tag({}, { locale });
  return copy.enchants.length > 0 ? m.rpg_inventory_enchanted_tag({}, { locale }) : '';
}

/** Une ligne de sac : l'objet, sa rareté, son niveau requis et ses bonus. */
function bagItemLine(bag: BagEntry, playerLevel: number, favorite: boolean, locale: Locale): string {
  const item = bag.entry.item;
  const stats = itemStatLine(item, locale);

  const upgrade = bag.copy && bag.copy.upgrade > 0 ? ` **+${bag.copy.upgrade}**` : '';
  const header = `${favorite ? '⭐ ' : ''}${item.emoji} **${item.name}**${upgrade} ×${bag.count}`
    + (bag.mixed ? copyKindTag(bag.copy, locale) : '')
    + (bag.worn ? ` ${m.rpg_inventory_equipped_tag({}, { locale })}` : '');
  const enchants = bag.copy && bag.copy.enchants.length > 0 ? bag.copy.enchants.map(formatEnchant).join(' · ') : '';

  const meta = `-# ${rarityIcon(item.rarity)} ${shopCategoryLabel(item.type, locale)} `
    + levelRequirementLabel(item, playerLevel, locale);

  return [header, enchants || null, stats || null, meta].filter((line): line is string => line !== null).join('\n');
}

/**
 * Inventaire : ce qu'on porte, puis ce qu'on transporte.
 *
 * L'écran listait tout à plat, sans statistiques, sans niveau requis et sans moyen de
 * vendre : il fallait retenir le nom d'un objet puis le retaper dans une fenêtre de
 * saisie. L'équipement porté est désormais en tête, chaque pièce avec son bouton de
 * retrait, et chaque objet du sac mène à sa fiche.
 */
async function buildInventoryView(
  guildId: string,
  ownerId: string,
  locale: Locale,
  state: BagState = { category: 'all', page: 0 },
): Promise<PanelView> {
  const profile = await getOrCreateRpgProfile(guildId, ownerId);
  const config = await getOrCreateEconomyConfig(guildId);
  const inventory = profile.inventory as unknown as LocalInventoryEntry[];
  const [equipment, ownedTitles, copies] = await Promise.all([
    loadEquipment(profile),
    listOwnedTitles(profile.id),
    listItemInstances(profile.id),
  ]);
  const activeTitle = ownedTitles.find((title) => title.id === profile.activeTitleId) ?? null;

  const itemById = new Map(inventory.map((entry) => [entry.item.id, entry.item]));

  const container = new ContainerBuilder().setAccentColor(RPG_COLORS.hub);

  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `## ${icon('rpgBag')} ${m.rpg_inventory_title({}, { locale })}\n`
    + m.rpg_inventory_summary({
      count: inventory.reduce((total, entry) => total + entry.quantity, 0),
      balance: profile.balance,
      emoji: config.currencyEmoji,
    }, { locale }),
  ));

  // ── Équipement porté ──
  //
  // Un seul bloc de texte, et non une section par emplacement : une section coûte
  // TROIS composants (elle-même, son texte, son accessoire), et cinq d'entre elles
  // suffisaient à faire dépasser l'écran des quarante composants qu'un message
  // accepte. Le retrait passe par un sélecteur, qui n'en coûte que deux pour les
  // cinq emplacements réunis.
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));

  const slotLabels: Record<EquipmentSlot, string> = {
    weapon: m.rpg_card_slot_weapon({}, { locale }),
    armor: m.rpg_card_slot_armor({}, { locale }),
    accessory: m.rpg_profile_accessory_slot({ index: 1 }, { locale }),
    accessory2: m.rpg_profile_accessory_slot({ index: 2 }, { locale }),
    accessory3: m.rpg_profile_accessory_slot({ index: 3 }, { locale }),
  };

  const worn: { itemId: string; label: string; itemName: string; emoji: string }[] = [];
  const equippedLines: string[] = [];

  // Le titre se porte comme une pièce d'équipement : il ouvre la liste, et ses bonus
  // l'accompagnent pour qu'on voie ce qu'il apporte sans passer par la fiche Personnage.
  if (ownedTitles.length > 0) {
    const bonus = activeTitle ? titleBonusText(activeTitle, locale) : '';
    equippedLines.push(activeTitle
      ? `🎖️ **${m.rpg_inventory_title_slot({}, { locale })}** — ${activeTitle.name}${bonus ? `\n${bonus}` : ''}`
      : `🎖️ **${m.rpg_inventory_title_slot({}, { locale })}** — *${m.rpg_character_title_none({}, { locale })}*`);
  }

  for (const slot of ALL_EQUIPMENT_SLOTS) {
    const required = isAccessorySlot(slot) ? ACCESSORY_SLOT_LEVELS[slot] : 1;
    if (profile.level < required) {
      equippedLines.push(`🔒 **${slotLabels[slot]}** — *${m.rpg_profile_slot_locked({ level: required }, { locale })}*`);
      continue;
    }

    const itemId = itemIdInSlot(profile, slot);
    const item = itemId ? itemById.get(itemId) ?? null : null;

    if (!item) {
      equippedLines.push(`${icon('rpgAccessory')} **${slotLabels[slot]}** — *${m.rpg_profile_slot_empty({}, { locale })}*`);
      continue;
    }

    const piece = isAccessorySlot(slot)
      ? equipment.accessories[ACCESSORY_SLOTS.indexOf(slot)] ?? null
      : slot === 'weapon' ? equipment.weapon : equipment.armor;

    const stats = itemStatLine(item, locale);
    equippedLines.push(`${itemTypeIcon(item.type)} **${slotLabels[slot]}** — ${equippedLabel(item, piece, locale)}${stats ? `\n${stats}` : ''}`);
    worn.push({ itemId: item.id, label: slotLabels[slot], itemName: item.name, emoji: item.emoji });
  }

  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `### ${m.rpg_inventory_field_equipped({}, { locale })}\n${truncate(equippedLines.join('\n'), 3500)}`,
  ));

  // ── Sac ──
  const filtered = bagEntries(inventory, copies, profile)
    .filter((bag) => state.category === 'all' || bag.entry.item.type === state.category);

  // Les favoris d'abord, puis le plus utile : ce qui s'équipe, ce qui se boit, la
  // matière première.
  const favorites = new Set(profile.favoriteItemIds);
  const TYPE_ORDER: Record<string, number> = { WEAPON: 0, ARMOR: 1, ACCESSORY: 2, POTION: 3, SCROLL: 4, MATERIAL: 5 };
  const sorted = [...filtered].sort((a, b) =>
    Number(favorites.has(b.entry.item.id)) - Number(favorites.has(a.entry.item.id))
    || (TYPE_ORDER[a.entry.item.type] ?? 9) - (TYPE_ORDER[b.entry.item.type] ?? 9)
    || b.entry.item.levelRequired - a.entry.item.levelRequired
    || a.entry.item.name.localeCompare(b.entry.item.name)
    || (b.copy?.upgrade ?? -1) - (a.copy?.upgrade ?? -1));

  const pageCount = Math.max(1, Math.ceil(sorted.length / BAG_PAGE_SIZE));
  const page = Math.min(state.page, pageCount - 1);
  const shown = sorted.slice(page * BAG_PAGE_SIZE, page * BAG_PAGE_SIZE + BAG_PAGE_SIZE);

  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `### ${m.rpg_inventory_field_bag({}, { locale })} — ${bagCategoryLabel(state.category, locale)} (${sorted.length})`,
  ));

  if (shown.length === 0) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `*${m.rpg_inventory_empty_desc({}, { locale })}*`,
    ));
  }

  for (const bag of shown) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          truncate(bagItemLine(bag, profile.level, favorites.has(bag.entry.item.id), locale), 600),
        ))
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`rpg:invopen:${ownerId}:${bag.entry.item.id}:${state.category}:${page}${bag.copy ? `:${bag.copy.id}` : ''}`)
            .setLabel(m.rpg_inventory_open_btn({}, { locale }))
            .setStyle(ButtonStyle.Primary),
        ),
    );
  }

  const components: PanelRow[] = [];

  // Retirer une pièce : proposé seulement quand il y a quelque chose à retirer, pour
  // ne pas poser un sélecteur vide devant un personnage qui débute.
  if (worn.length > 0) {
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`rpg:invtoggleselect:${ownerId}`)
        .setPlaceholder(m.rpg_inventory_unequip_placeholder({}, { locale }))
        .addOptions(worn.map((entry) => ({
          label: truncate(entry.itemName, 100),
          description: truncate(entry.label, 100),
          value: entry.itemId,
          emoji: optionEmoji(entry.emoji),
        }))),
    ));
  }

  const titleRow = titleSelectRow(ownerId, profile.activeTitleId, ownedTitles, 'inventory', locale);
  if (titleRow) components.push(titleRow);

  components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`rpg:invcat:${ownerId}`)
      .setPlaceholder(m.rpg_inventory_category_placeholder({}, { locale }))
      .addOptions(BAG_CATEGORIES.map((category) => ({
        label: truncate(bagCategoryLabel(category, locale), 100),
        value: category,
        default: category === state.category,
      }))),
  ));

  const navRow = new ActionRowBuilder<ButtonBuilder>();
  if (pageCount > 1) {
    navRow.addComponents(
      new ButtonBuilder()
        .setCustomId(bagNavId(ownerId, { category: state.category, page: page - 1 }))
        .setLabel(m.rpg_shop_prev({}, { locale }))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId(`rpg:noop:${ownerId}`)
        .setLabel(`${page + 1} / ${pageCount}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(bagNavId(ownerId, { category: state.category, page: page + 1 }))
        .setLabel(m.rpg_shop_next({}, { locale }))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= pageCount - 1),
    );
  }
  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:hub`)
      .setLabel(m.rpg_hub_btn_back({}, { locale }))
      .setEmoji(icon('rpgBack'))
      .setStyle(ButtonStyle.Secondary),
  );
  components.push(navRow);

  return { embeds: [], components, container };
}

/**
 * Fiche d'un objet du sac : tout ce qu'il vaut, et ce qu'on peut en faire.
 *
 * C'est l'écran qui portait le plus de manques : ni statistiques, ni niveau requis, ni
 * revente. Vendre supposait de retaper le nom de l'objet dans une fenêtre de saisie.
 */
async function buildInventoryItemView(
  guildId: string,
  ownerId: string,
  itemId: string,
  locale: Locale,
  back: BagState,
  copyId?: string,
): Promise<PanelView> {
  const profile = await getOrCreateRpgProfile(guildId, ownerId);
  const inventory = profile.inventory as unknown as LocalInventoryEntry[];
  const entry = inventory.find((candidate) => candidate.item.id === itemId);
  const copies = entry ? await listItemInstances(profile.id, [itemId]) : [];
  // `copyId` désigne un exemplaire forgé ; sans lui, la fiche parle des exemplaires ordinaires.
  const copy = copyId ? copies.find((candidate) => candidate.id === copyId) ?? null : null;
  const plainCount = entry ? Math.max(0, entry.quantity - copies.length) : 0;

  if (!entry || (copyId && !copy) || (!copyId && plainCount <= 0)) {
    return {
      embeds: [errorEmbed(m.rpg_inventory_title({}, { locale }), m.rpg_inventory_item_gone({}, { locale }))],
      components: [backRow(ownerId, locale)],
    };
  }

  const item = entry.item;
  const itemWorn = isItemEquipped(profile, item.id);
  const wornForged = copies.some((candidate) => candidate.equipped);
  // Cet exemplaire-ci est-il celui porté ? Un objet ne se porte qu'une fois : c'est soit
  // un exemplaire forgé marqué, soit un exemplaire ordinaire.
  const equipped = itemWorn && (copy ? copy.equipped : !wornForged);
  const freePlain = plainCount - (itemWorn && !wornForged ? 1 : 0);

  const embed = new EmbedBuilder()
    .setTitle(truncate(`${copyLabel(item, copy)}${copies.length > 0 ? copyKindTag(copy, locale).replace(/\*/g, '') : ''}`, 256))
    .setDescription(`*${item.description}*`)
    .setColor(RPG_COLORS.hub)
    .addFields(
      { name: m.rpg_item_field_type({}, { locale }), value: `${rarityIcon(item.rarity)} ${shopCategoryLabel(item.type, locale)}`, inline: true },
      {
        name: m.rpg_item_field_level({}, { locale }),
        value: item.levelRequired > 0
          ? (profile.level >= item.levelRequired
            ? `**${item.levelRequired}**`
            : `⚠️ **${item.levelRequired}** ${m.rpg_item_level_short({ level: profile.level }, { locale })}`)
          : m.rpg_item_level_none({}, { locale }),
        inline: true,
      },
      { name: m.rpg_item_field_quantity({}, { locale }), value: `**${copy ? 1 : plainCount}**`, inline: true },
    );

  const stats = itemStatLine(item, locale);
  if (stats) {
    embed.addFields({ name: m.rpg_item_field_stats({}, { locale }), value: stats, inline: false });
  }

  // Un exemplaire forgé ou enchanté resté dans le sac se compare avec sa progression.
  const comparison = equipped ? null : await equipmentComparisonField(profile, item, copy ?? { upgrade: 0, enchants: [] }, locale);
  if (comparison) embed.addFields(comparison);

  // Forge et enchantements appartiennent à cet exemplaire seul.
  if (copy) {
    const progress = [
      copy.upgrade > 0 ? m.rpg_item_field_upgrade_value({ level: copy.upgrade }, { locale }) : null,
      copy.enchants.length > 0 ? copy.enchants.map(formatEnchant).join(' · ') : null,
    ].filter((part): part is string => part !== null);

    embed.addFields({ name: m.rpg_item_field_progress({}, { locale }), value: progress.join('\n'), inline: false });
  }

  const sellPrice = Math.floor(item.price * SELL_RATIO);
  embed.addFields({
    name: m.rpg_item_field_value({}, { locale }),
    value: m.rpg_item_value_line({ price: item.price, sell: sellPrice }, { locale }),
    inline: false,
  });

  const salvage = await getSalvageQuote(guildId, item.id);
  if (salvage) {
    embed.addFields({
      name: m.rpg_item_field_salvage({}, { locale }),
      value: salvage.map((ingredient) => `${ingredient.quantity} × ${ingredient.itemName}`).join('\n'),
      inline: false,
    });
  }

  const row = new ActionRowBuilder<ButtonBuilder>();

  // Une potion se boit, une pièce d'équipement se porte, un matériau ne fait ni l'un ni
  // l'autre : le bouton principal change d'intitulé plutôt que de proposer l'impossible.
  if (item.type === 'POTION') {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`rpg:invuse2:${ownerId}:${item.id}`)
        .setLabel(m.rpg_inventory_drink_btn({}, { locale }))
        .setEmoji(icon('rpgPotion'))
        .setStyle(ButtonStyle.Success),
    );
  } else if (slotForItemType(item.type)) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`rpg:invtoggle:${ownerId}:${item.id}:${copy?.id ?? 'plain'}`)
        .setLabel(equipped ? m.rpg_inventory_unequip_btn({}, { locale }) : m.rpg_inventory_equip_btn({}, { locale }))
        .setEmoji(itemTypeIcon(item.type))
        .setStyle(equipped ? ButtonStyle.Secondary : ButtonStyle.Success)
        // Un objet hors niveau garde son bouton grisé : le voir désactivé dit pourquoi,
        // le retirer laisserait croire que l'objet n'est pas équipable du tout.
        .setDisabled(!equipped && !itemWorn && profile.level < item.levelRequired),
    );
  }

  // Vendre, ici, sur l'exemplaire qu'on regarde. L'exemplaire porté doit d'abord être
  // retiré : le refus vient de `sellShopItem`, on grise plutôt que de le laisser échouer.
  const copySuffix = copy ? `:${copy.id}` : '';
  const onlyWornCopy = copy ? equipped : freePlain < 1;
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`rpg:invsell:${ownerId}:${item.id}:${back.category}:${back.page}${copySuffix}`)
      .setLabel(m.rpg_inventory_sell_btn({ price: sellPrice }, { locale }))
      .setEmoji(icon('rpgSell'))
      .setStyle(ButtonStyle.Danger)
      .setDisabled(onlyWornCopy),
  );
  if (salvage) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`rpg:invsalvage:${ownerId}:${item.id}:${back.category}:${back.page}${copySuffix}`)
        .setLabel(m.rpg_inventory_salvage_btn({}, { locale }))
        .setEmoji(icon('rpgCraft'))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(onlyWornCopy),
    );
  }
  const favorite = profile.favoriteItemIds.includes(item.id);
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`rpg:invfav:${ownerId}:${item.id}:${back.category}:${back.page}${copySuffix}`)
      .setLabel(favorite ? m.rpg_inventory_unfavorite_btn({}, { locale }) : m.rpg_inventory_favorite_btn({}, { locale }))
      .setEmoji('⭐')
      .setStyle(favorite ? ButtonStyle.Primary : ButtonStyle.Secondary),
  );
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(bagNavId(ownerId, back))
      .setLabel(m.rpg_inventory_back_to_bag({}, { locale }))
      .setEmoji(icon('rpgBack'))
      .setStyle(ButtonStyle.Secondary),
  );

  // Seconde rangée : la première est pleine, et Discord refuse une sixième case.
  const marketRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`mkt:sellsetup:${ownerId}:${item.id}:${copy?.id ?? '-'}`)
      .setLabel(m.rpg_inventory_market_btn({}, { locale }))
      .setEmoji(icon('rpgShop'))
      .setStyle(ButtonStyle.Primary)
      .setDisabled(onlyWornCopy),
  );

  return { embeds: [embed], components: [row, marketRow] };
}

/**
 * Verse les récompenses des modules voisins portées par un objet consommé.
 *
 * L'objet a déjà quitté l'inventaire quand on arrive ici : chaque versement est isolé, une
 * panne d'un module ne doit ni emporter l'autre ni transformer la consommation en erreur.
 * Seuls les montants réellement versés sont renvoyés, pour ne rien annoncer de faux.
 */
async function grantItemModuleRewards(
  guildId: string,
  userId: string,
  item: { itemName: string; levelXpReward: number; clanPointsReward: number },
  modules: ShopModuleState,
  interaction: PanelInteraction,
): Promise<{ levelXp: number; clanPoints: number }> {
  const granted = { levelXp: 0, clanPoints: 0 };

  if (modules.levelingEnabled && item.levelXpReward > 0) {
    try {
      const { addXp } = await import('../progression/levelingService.js');
      await addXp(guildId, userId, item.levelXpReward, interaction.client, interaction.channelId ?? undefined);
      granted.levelXp = item.levelXpReward;
    } catch (err) {
      logger.error('RpgPanel', `Échec du versement d'XP pour ${item.itemName} :`, err);
    }
  }

  if (modules.clanPointsEnabled && item.clanPointsReward > 0) {
    try {
      const { awardClanPointsToMembers } = await import('../community/clanService.js');
      const awarded = await awardClanPointsToMembers({
        guildId,
        client: interaction.client,
        source: 'RPG_ITEM',
        awards: [{ userId, amount: item.clanPointsReward }],
        reason: item.itemName,
      });
      granted.clanPoints = awarded.get(userId) ?? 0;
    } catch (err) {
      logger.error('RpgPanel', `Échec du versement de points de clan pour ${item.itemName} :`, err);
    }
  }

  return granted;
}

/**
 * Boit une potion, après tous les refus qui doivent tomber AVANT la consommation.
 *
 * Un module éteint, un clan absent ou une fenêtre de raid fermée entre l'achat et l'usage
 * ferait disparaître l'objet contre une récompense que personne ne verserait.
 */
async function consumePotion(
  interaction: PanelInteraction,
  guildId: string,
  ownerId: string,
  entry: LocalInventoryEntry,
  locale: Locale,
): Promise<string> {
  const modules = await getShopModuleState(guildId);
  if (!isShopItemUnlocked(entry.item, modules)) {
    throw new Error(m.rpg_item_module_locked_desc({ item: entry.item.name }, { locale }));
  }

  if (entry.item.clanPointsReward > 0) {
    const member = interaction.guild?.members.cache.get(ownerId)
      ?? await interaction.guild?.members.fetch(ownerId).catch(() => null);
    const { memberHasClan } = await import('../community/clanService.js');
    if (!member || !(await memberHasClan(guildId, member))) {
      throw new Error(m.rpg_item_no_clan_desc({ item: entry.item.name }, { locale }));
    }
  }

  if (entry.item.raidAssaultBonus > 0) {
    const check = await checkRaidAssaultGrant(guildId, ownerId, entry.item.raidAssaultBonus);
    if (!check.ok) {
      throw new Error(check.reason ?? m.rpg_raid_panel_attack_failed({}, { locale }));
    }
  }

  const used = await consumePotionItem(guildId, ownerId, entry.item.id);
  const rewards = await grantItemModuleRewards(guildId, ownerId, used, modules, interaction);

  let feedback: string = m.rpg_potion_consumed_desc({
    item: used.itemName,
    hp: used.restoredHp,
    newHp: used.newHp,
    energy: used.restoredEnergy,
    newEnergy: used.newEnergy,
  }, { locale });

  if (rewards.levelXp > 0) feedback += m.rpg_reward_xp_suffix({ xp: rewards.levelXp }, { locale });
  if (rewards.clanPoints > 0) feedback += m.rpg_reward_clan_points_suffix({ points: rewards.clanPoints }, { locale });

  if (used.raidAssaultBonus > 0) {
    const granted = await grantRaidAssaults(guildId, ownerId, used.raidAssaultBonus);
    if (granted > 0) feedback += m.rpg_reward_raid_assaults_suffix({ assaults: granted }, { locale });
  }

  return feedback;
}

/** Équipe ou retire l'objet, depuis la liste d'équipement comme depuis la fiche. */
async function handleInventoryToggle(
  interaction: ButtonInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
  itemId: string,
  copy?: string,
): Promise<void> {
  const toggled = await equipInventoryItem(guildId, ownerId, itemId, copy);
  const view = await buildInventoryView(guildId, ownerId, locale);

  await respond(interaction, withNote(view, toggled.equipped
    ? m.rpg_item_equipped_desc({ item: toggled.itemName, type: toggled.type }, { locale })
    : m.rpg_item_unequipped_desc({ item: toggled.itemName }, { locale })));
}

async function handleInventoryDrink(
  interaction: ButtonInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
  itemId: string,
): Promise<void> {
  const profile = await getOrCreateRpgProfile(guildId, ownerId);
  const entry = (profile.inventory as unknown as LocalInventoryEntry[]).find((candidate) => candidate.item.id === itemId);
  if (!entry) {
    await replyPanelError(interaction, new Error(m.rpg_inventory_item_gone({}, { locale })), locale);
    return;
  }

  const feedback = await consumePotion(interaction, guildId, ownerId, entry, locale);
  const view = await buildInventoryView(guildId, ownerId, locale);
  await respond(interaction, withNote(view, feedback));
}

/**
 * Menu « boire une potion » du hub et des refus de combat.
 *
 * Boire passait par l'inventaire, puis la bonne page, puis la fiche de l'objet : trois
 * écrans pour le geste le plus répété du jeu, en plein milieu d'une série de combats.
 * `need` ne garde que les potions qui règlent le refus affiché.
 */
type QuickDrinkNeed = 'any' | 'hp' | 'energy';
type QuickDrinkOrigin = 'hub' | 'alert' | 'travel' | 'dungeon';

async function quickDrinkRow(
  guildId: string,
  ownerId: string,
  locale: Locale,
  origin: QuickDrinkOrigin,
  need: QuickDrinkNeed = 'any',
): Promise<ActionRowBuilder<StringSelectMenuBuilder> | null> {
  const entries = await prisma.rpgInventoryItem.findMany({
    where: {
      quantity: { gt: 0 },
      profile: { guildId, userId: ownerId },
      item: {
        type: 'POTION',
        ...(need === 'hp' ? { hpRestore: { gt: 0 } } : {}),
        ...(need === 'energy' ? { energyRestore: { gt: 0 } } : {}),
      },
    },
    include: { item: true },
  });
  if (entries.length === 0) return null;

  const profile = await prisma.rpgProfile.findUnique({
    where: { guildId_userId: { guildId, userId: ownerId } },
    select: { favoriteItemIds: true },
  });
  const favorites = new Set(profile?.favoriteItemIds ?? []);
  const restored = (item: (typeof entries)[number]['item']) =>
    need === 'hp' ? item.hpRestore : need === 'energy' ? item.energyRestore : item.hpRestore + item.energyRestore;
  entries.sort((a, b) =>
    Number(favorites.has(b.item.id)) - Number(favorites.has(a.item.id))
    || restored(b.item) - restored(a.item)
    || a.item.name.localeCompare(b.item.name));

  const select = new StringSelectMenuBuilder()
    .setCustomId(`rpg:quickdrink:${ownerId}:${origin}:${need}`)
    .setPlaceholder(m.rpg_quickdrink_placeholder({}, { locale }))
    .addOptions(entries.slice(0, 25).map(({ item, quantity }) => {
      const effects = [
        item.hpRestore > 0 ? m.rpg_quickdrink_hp({ hp: item.hpRestore }, { locale }) : null,
        item.energyRestore > 0 ? m.rpg_quickdrink_energy({ energy: item.energyRestore }, { locale }) : null,
      // `LocalizedString` est un type marque, pas `string` : un predicat
      // `effect is string` est plus LARGE que l'element, et TypeScript le
      // refuse. `NonNullable<typeof effect>` reste juste quelle que soit la
      // marque, et le jour ou elle change.
      ].filter((effect): effect is NonNullable<typeof effect> => effect !== null);
      return {
        label: truncate(`${favorites.has(item.id) ? '⭐ ' : ''}${item.name} ×${quantity}`, 100),
        value: item.id,
        description: optionDescription(effects.join(' · ')),
        emoji: optionEmoji(item.emoji),
      };
    }));

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

/** Refus de combat faute de PV ou d'énergie, avec de quoi y remédier sur place. */
async function replyVitalsAlert(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
  embed: EmbedBuilder,
  need: Exclude<QuickDrinkNeed, 'any'>,
): Promise<void> {
  const row = await quickDrinkRow(guildId, ownerId, locale, 'alert', need);
  const components = row ? [row] : [];
  // Le départ en aventure est acquitté avant tout travail : `reply` échouerait alors en silence.
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ embeds: [embed], components, flags: [MessageFlags.Ephemeral] });
    return;
  }
  await interaction.reply({ embeds: [embed], components, flags: [MessageFlags.Ephemeral] });
}

async function handleQuickDrink(
  interaction: StringSelectMenuInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
  rest: string[],
): Promise<void> {
  const rawOrigin = rest[0];
  const origin: QuickDrinkOrigin = rawOrigin === 'alert' || rawOrigin === 'travel' || rawOrigin === 'dungeon' ? rawOrigin : 'hub';
  const requested = rest[1];
  const need: QuickDrinkNeed = requested === 'hp' || requested === 'energy' ? requested : 'any';

  const profile = await getOrCreateRpgProfile(guildId, ownerId);
  const entry = (profile.inventory as unknown as LocalInventoryEntry[]).find((candidate) => candidate.item.id === interaction.values[0]);
  if (!entry) {
    await replyPanelError(interaction, new Error(m.rpg_inventory_item_gone({}, { locale })), locale);
    return;
  }

  const feedback = await consumePotion(interaction, guildId, ownerId, entry, locale);

  if (origin === 'travel') {
    await respond(interaction, withNote(await buildTravelView(guildId, ownerId, locale), feedback));
    return;
  }

  if (origin === 'dungeon') {
    await respond(interaction, withNote(await buildDungeonCurrentView(guildId, ownerId, locale), feedback));
    return;
  }

  if (origin === 'hub') {
    const view = await buildHubView(guildId, interaction.user, interaction.user, locale, isInteractionAdmin(interaction));
    await respond(interaction, withNote(view, feedback));
    return;
  }

  // Le refus est un message éphémère : il devient le compte rendu, et garde le menu tant
  // qu'il reste de quoi boire, pour enchaîner deux potions sans rouvrir le hub.
  const row = await quickDrinkRow(guildId, ownerId, locale, 'alert', need);
  await interaction.editReply({
    embeds: [successEmbed(m.rpg_potion_consumed_title({}, { locale }), feedback)],
    components: row ? [row] : [],
  });
}

/** Ajoute l'objet aux favoris ou l'en retire, puis réaffiche sa fiche. */
async function handleInventoryFavorite(
  interaction: ButtonInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
  rest: string[],
): Promise<void> {
  const [itemId, ...backState] = rest;
  const profile = await getOrCreateRpgProfile(guildId, ownerId);
  const favorites = profile.favoriteItemIds.includes(itemId)
    ? profile.favoriteItemIds.filter((id) => id !== itemId)
    : [...profile.favoriteItemIds, itemId];

  await prisma.rpgProfile.update({ where: { id: profile.id }, data: { favoriteItemIds: favorites } });
  await respond(interaction, await buildInventoryItemView(guildId, ownerId, itemId, locale, parseBagState(backState), backState[2]));
}

/** Vend un exemplaire depuis sa fiche, et ramène au sac là où on l'avait quitté. */
async function handleInventorySell(
  interaction: ButtonInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
  rest: string[],
): Promise<void> {
  const [itemId, ...back] = rest;
  const result = await sellShopItem(guildId, ownerId, itemId, back[2] ? { instanceId: back[2] } : {});

  const view = await buildInventoryView(guildId, ownerId, locale, parseBagState(back));
  await respond(interaction, withNote(
    view,
    m.rpg_sell_success_desc({ item: result.itemName, price: result.sellPrice }, { locale }),
  ));
}

/** Démantèle un exemplaire depuis sa fiche, et ramène au sac là où on l'avait quitté. */
async function handleInventorySalvage(
  interaction: ButtonInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
  rest: string[],
): Promise<void> {
  const [itemId, ...back] = rest;
  const result = await salvageItem(guildId, ownerId, itemId, back[2]);

  const materials = result.returned.map((ingredient) => `${ingredient.emoji} ${ingredient.quantity} × ${ingredient.itemName}`).join(', ');
  const view = await buildInventoryView(guildId, ownerId, locale, parseBagState(back));
  await respond(interaction, withNote(view, m.rpg_salvage_success_desc({ item: result.itemName, materials }, { locale })));
}

/** Retrait depuis le sélecteur d'équipement : même geste que le bouton de la fiche. */
async function handleInventoryUnequip(
  interaction: StringSelectMenuInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
): Promise<void> {
  const toggled = await equipInventoryItem(guildId, ownerId, interaction.values[0]);
  const view = await buildInventoryView(guildId, ownerId, locale);

  await respond(interaction, withNote(view, toggled.equipped
    ? m.rpg_item_equipped_desc({ item: toggled.itemName, type: toggled.type }, { locale })
    : m.rpg_item_unequipped_desc({ item: toggled.itemName }, { locale })));
}

async function handleInventoryCategory(
  interaction: StringSelectMenuInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
): Promise<void> {
  // Changer de catégorie ramène en première page : rester en page 4 d'une catégorie qui
  // n'en compte qu'une afficherait un sac vide.
  await respond(interaction, await buildInventoryView(guildId, ownerId, locale, parseBagState([interaction.values[0], '0'])));
}

// ─────────────────────────────────────────────────────────────
// Boutique
// ─────────────────────────────────────────────────────────────

/**
 * Discord refuse un message dont le texte affichable dépasse 4000 caractères, embed et
 * composants confondus (`COMPONENT_DISPLAYABLE_TEXT_SIZE_EXCEEDED`).
 *
 * La boutique n'en dépend plus : elle pagine. Reste le marché noir, qui liste
 * toutes ses offres dans un champ unique et remplit un sélecteur de 25 options
 * en regard - c'est lui que ce budget protège désormais.
 */
const SHOP_TEXT_BUDGET = 3600;

/** Marge gardée pour le pied de page ajouté après un achat. */
const SHOP_TEXT_RESERVE = 220;

/** Texte affichable déjà consommé par un embed (titre, description, champs, pied de page). */
function embedTextLength(embed: EmbedBuilder): number {
  const data = embed.data;
  return (data.title?.length ?? 0)
    + (data.description?.length ?? 0)
    + (data.footer?.text.length ?? 0)
    + (data.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0);
}

interface BudgetedOption {
  label: string;
  description?: string;
  value: string;
  emoji?: string;
}

/**
 * Remplit un sélecteur sans dépasser le budget de texte du message.
 *
 * Vingt-cinq options aux libellés et descriptions maximaux pèsent 5 000 caractères : le
 * sélecteur seul suffirait à faire refuser le message. On sacrifie donc d'abord les
 * descriptions - une option sans description reste sélectionnable - et seulement en
 * dernier recours des options entières.
 *
 * @returns Le texte consommé par les options retenues.
 */
function addOptionsWithinBudget(select: StringSelectMenuBuilder, entries: BudgetedOption[], budget: number): number {
  const cost = (entry: BudgetedOption, withDescription: boolean) =>
    entry.label.length + (withDescription ? entry.description?.length ?? 0 : 0);

  for (const withDescription of [true, false]) {
    const total = entries.reduce((sum, entry) => sum + cost(entry, withDescription), 0);
    if (total > budget) continue;
    for (const entry of entries) {
      select.addOptions({
        label: entry.label,
        description: withDescription ? entry.description : undefined,
        value: entry.value,
        emoji: entry.emoji,
      });
    }
    return total;
  }

  let used = 0;
  for (const entry of entries) {
    if (used + cost(entry, false) > budget) break;
    used += cost(entry, false);
    select.addOptions({ label: entry.label, value: entry.value, emoji: entry.emoji });
  }
  return used;
}

/**
 * Discord valide chaque option de menu et agrège ses refus en une seule erreur opaque
 * (« Received one or more errors ») qui ne nomme pas l'option fautive. Une description vide
 * ou un emoji qui n'en est pas un suffit : un objet créé au dashboard sans description, ou
 * dont le champ emoji contient du texte, rendait toute la boutique inaccessible.
 */
export function optionDescription(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text ? truncate(text, 100) : undefined;
}

/** Emoji unicode, ou emoji personnalisé `<a?:nom:id>`. Tout le reste est écarté. */
export function optionEmoji(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^<a?:\w{2,32}:\d{17,20}>$/.test(text)) return text;
  return /\p{Extended_Pictographic}/u.test(text) ? text : undefined;
}

/**
 * Objets par page.
 *
 * L'ancienne boutique déversait tout l'étal dans un seul embed, puis rognait
 * lignes et descriptions pour tenir sous la limite de 4 000 caractères de
 * Discord : passé la trentaine d'articles, une partie du catalogue devenait
 * simplement invisible. La pagination remplace ce rognage - chaque objet garde
 * sa place, et le budget de texte n'est plus jamais en cause.
 */
/**
 * Six, et non huit : chaque article porte désormais son propre bouton, donc
 * trois composants au lieu d'une ligne d'embed. Huit articles feraient dépasser
 * la limite de quarante composants par message une fois le filtre, la
 * pagination et le retour comptés.
 */
const SHOP_PAGE_SIZE = 6;

/** Quantités proposées à l'achat depuis la fiche d'un objet. */
const SHOP_BUY_QUANTITIES = [1, 5, 10] as const;

/** Catégories de l'étal, dans l'ordre où elles sont proposées. */
// Materiaux et parchemins figuraient deja dans l'etal - le catalogue n'est pas
// filtre par cette liste, seuls les onglets le sont - mais sans onglet pour les
// isoler : deux familles achetables qu'aucun filtre ne savait montrer seules.
// Un onglet vide ne s'affiche pas, la liste est croisee avec ce qui est present.
const SHOP_CATEGORIES = ['WEAPON', 'ARMOR', 'ACCESSORY', 'POTION', 'MATERIAL', 'SCROLL', 'QUEST'] as const;
type ShopCategory = (typeof SHOP_CATEGORIES)[number];

export function shopCategoryLabel(type: string, locale: Locale): string {
  switch (type) {
    case 'WEAPON': return m.rpg_shop_type_weapon({}, { locale });
    case 'ARMOR': return m.rpg_shop_type_armor({}, { locale });
    case 'ACCESSORY': return m.rpg_shop_type_accessory({}, { locale });
    case 'POTION': return m.rpg_shop_type_potion({}, { locale });
    case 'MATERIAL': return m.rpg_shop_type_material({}, { locale });
    case 'SCROLL': return m.rpg_shop_type_scroll({}, { locale });
    case 'QUEST': return m.rpg_shop_type_quest({}, { locale });
    default: return type;
  }
}

/** Effets d'un objet, sur une ligne. Vide quand l'objet n'en a aucun. */
function shopItemStats(item: LocalRpgItem, locale: Locale): string {
  const parts: string[] = [];
  if (item.atkBonus) parts.push(m.rpg_shop_stat_atk({ v: item.atkBonus }, { locale }));
  if (item.defBonus) parts.push(m.rpg_shop_stat_def({ v: item.defBonus }, { locale }));
  if (item.spdBonus) parts.push(m.rpg_shop_stat_spd({ v: item.spdBonus }, { locale }));
  if (item.hpBonus) parts.push(m.rpg_shop_stat_maxhp({ v: item.hpBonus }, { locale }));
  if (item.hpRestore) parts.push(m.rpg_shop_stat_hp({ v: item.hpRestore }, { locale }));
  // L'energie rendue etait la seule statistique que l'etal taisait : une potion
  // d'energie s'y affichait donc sans aucun effet annonce.
  if (item.energyRestore) parts.push(m.rpg_shop_stat_energy({ v: item.energyRestore }, { locale }));
  if (item.levelXpReward) parts.push(m.rpg_shop_stat_level_xp({ v: item.levelXpReward }, { locale }));
  if (item.clanPointsReward) parts.push(m.rpg_shop_stat_clan_points({ v: item.clanPointsReward }, { locale }));
  if (item.raidAssaultBonus) parts.push(m.rpg_shop_stat_raid_assaults({ v: item.raidAssaultBonus }, { locale }));
  // Les libellés traduits portent leurs propres séparateurs (« · … ») : on les
  // recolle bruts puis on retire celui de tête, sinon la ligne commence par un
  // point médian orphelin.
  return parts.join('').replace(/^[\s·]+/, '').trim();
}

type ShopState = {
  category: ShopCategory | 'ALL';
  page: number;
};

/**
 * Lit l'état de la boutique porté par un `customId`.
 *
 * Tout vient du client : une catégorie inconnue ou une page négative retombent
 * sur l'étal complet en première page plutôt que de produire une vue vide.
 */
function parseShopState(rest: string[]): ShopState {
  const rawCategory = rest[0];
  const category = (SHOP_CATEGORIES as readonly string[]).includes(rawCategory ?? '')
    ? (rawCategory as ShopCategory)
    : 'ALL';
  const page = Math.max(0, Number.parseInt(rest[1] ?? '0', 10) || 0);
  return { category, page };
}

function shopNavId(ownerId: string, state: ShopState): string {
  return `rpg:nav:${ownerId}:shop:${state.category}:${state.page}`;
}

type ShopCatalog = {
  items: LocalRpgItem[];
  /** Catégories réellement représentées, pour ne pas proposer un filtre vide. */
  categories: ShopCategory[];
};

async function loadShopCatalog(guildId: string): Promise<ShopCatalog> {
  const modules = await getShopModuleState(guildId);
  // Un objet qui verse de l'XP ou des points de clan disparaît de l'étal tant que son
  // module est éteint : l'acheter reviendrait à payer une récompense jamais versée.
  const items = (await prisma.rpgItem.findMany({
    where: { OR: [{ guildId: null }, { guildId }], purchasable: true },
    orderBy: [{ type: 'asc' }, { price: 'asc' }],
  })).filter((item) => isShopItemUnlocked(item, modules)) as unknown as LocalRpgItem[];

  const present = new Set(items.map((item) => item.type));
  return { items, categories: SHOP_CATEGORIES.filter((c) => present.has(c)) };
}

/** Corps d'une ligne d'étal : prix, effets, description, exemplaires possédés. */
/**
 * Une ligne d'etal : l'article, son prix reel, ce qu'il apporte et ce qui le bloque.
 *
 * L'etal taisait `levelRequired` : on achetait une arme epique pour decouvrir au moment
 * de l'equiper qu'elle demandait dix niveaux de plus. Il taisait aussi la remise de
 * l'echoppe du village, alors qu'elle change le prix reellement debite.
 */
function shopItemLines(
  item: LocalRpgItem,
  locale: Locale,
  currencyEmoji: string,
  ownedCount: number,
  affordable: boolean,
  playerLevel: number,
  discount: number,
): string {
  const usable = playerLevel >= item.levelRequired;
  const marker = !usable ? icon('lock') : affordable ? icon('success') : icon('lock');

  const finalPrice = discountedPrice(item.price, discount);
  const priceText = finalPrice < item.price
    ? `~~${item.price}~~ **${finalPrice}** ${currencyEmoji}`
    : `**${finalPrice}** ${currencyEmoji}`;

  const lines = [
    `**${itemTypeIcon(item.type)} ${truncate(item.name, 80)}** ${rarityIcon(item.rarity)}`,
    `${marker} ${priceText}${ownedCount ? m.rpg_shop_owned({ count: ownedCount }, { locale }) : ''}`,
  ];

  const stats = shopItemStats(item, locale);
  if (stats) lines.push(stats);

  // L'exigence de niveau ne s'affiche que lorsqu'il y en a une, et se signale quand elle
  // n'est pas satisfaite : c'est la seule information qui change la decision d'achat.
  if (item.levelRequired > 0) {
    lines.push(usable
      ? `-# ${m.rpg_item_level_required({ level: item.levelRequired }, { locale })}`
      : `-# ${m.rpg_shop_level_locked({ level: item.levelRequired, current: playerLevel }, { locale })}`);
  }

  if (item.description?.trim()) lines.push(`-# ${truncate(item.description.trim(), 120)}`);

  return lines.join('\n');
}

/**
 * Étal de la boutique : une page d'articles, un filtre par catégorie, et sur
 * chaque article son propre bouton.
 *
 * L'étal était un embed suivi d'un sélecteur : pour ouvrir la fiche d'un objet,
 * il fallait lire la liste, retrouver le nom dans le menu déroulant, puis le
 * choisir. Le bouton posé à côté de l'article supprime cet aller-retour - on
 * clique ce qu'on regarde - et c'est ce que les Components V2 permettent qu'un
 * embed ne permettait pas.
 */
async function buildShopView(
  guildId: string,
  ownerId: string,
  locale: Locale,
  requested: ShopState = { category: 'ALL', page: 0 },
): Promise<PanelView> {
  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.shopEnabled) {
    const embed = errorEmbed(m.rpg_shop_disabled_title({}, { locale }), m.rpg_shop_disabled_desc({}, { locale }));
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  const [profile, catalog] = await Promise.all([
    getOrCreateRpgProfile(guildId, ownerId),
    loadShopCatalog(guildId),
  ]);

  if (catalog.items.length === 0) {
    const embed = new EmbedBuilder()
      .setTitle(m.rpg_shop_title({}, { locale }))
      .setDescription(m.rpg_shop_empty({}, { locale }))
      .setColor(RPG_COLORS.trade);
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  // Un filtre dont la catégorie a disparu de l'étal retombe sur l'étal complet :
  // mieux vaut montrer autre chose qu'une page vide.
  const category = requested.category !== 'ALL' && catalog.categories.includes(requested.category)
    ? requested.category
    : 'ALL';
  const unsorted = category === 'ALL'
    ? catalog.items
    : catalog.items.filter((item) => item.type === category);

  // Ce qui est utilisable tout de suite passe devant. L'etal rangeait par categorie puis
  // par prix, si bien que les premieres pages etaient pleines d'articles hors niveau.
  const filtered = [...unsorted].sort((a, b) =>
    Number(profile.level < a.levelRequired) - Number(profile.level < b.levelRequired)
    || a.levelRequired - b.levelRequired
    || a.price - b.price);

  const pageCount = Math.max(1, Math.ceil(filtered.length / SHOP_PAGE_SIZE));
  const page = Math.min(requested.page, pageCount - 1);
  const pageItems = filtered.slice(page * SHOP_PAGE_SIZE, (page + 1) * SHOP_PAGE_SIZE);

  const owned = await prisma.rpgInventoryItem.findMany({
    where: { rpgProfileId: profile.id, itemId: { in: pageItems.map((item) => item.id) } },
    select: { itemId: true, quantity: true },
  });
  const ownedByItem = new Map(owned.map((entry) => [entry.itemId, entry.quantity]));

  // La remise de l'echoppe du village s'applique au prix debite : l'etal doit annoncer
  // le prix que le joueur paiera, pas le prix catalogue.
  const perks = await loadGuildPerksForMember(guildId, ownerId);

  const categoryLabel = category === 'ALL'
    ? m.rpg_shop_cat_all({}, { locale })
    : shopCategoryLabel(category, locale);

  const container = new ContainerBuilder().setAccentColor(RPG_COLORS.trade);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `### ${icon('rpgShop')} ${m.rpg_shop_title({}, { locale })}\n`
    + m.rpg_shop_header({
      balance: profile.balance,
      emoji: config.currencyEmoji,
      category: categoryLabel,
      page: page + 1,
      pages: pageCount,
    }, { locale })
    + (perks.shopDiscount > 0
      ? `\n${m.rpg_shop_guild_discount({ percent: Math.round(perks.shopDiscount * 100) }, { locale })}`
      : ''),
  ));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));

  if (pageItems.length === 0) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(m.rpg_shop_empty_in_category({}, { locale })));
  }

  for (const item of pageItems) {
    const affordable = profile.balance >= discountedPrice(item.price, perks.shopDiscount);
    const ownedCount = ownedByItem.get(item.id) ?? 0;

    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            shopItemLines(item, locale, config.currencyEmoji, ownedCount, affordable, profile.level, perks.shopDiscount),
          ),
        )
        // Un article qu'on ne peut pas s'offrir garde son bouton : la fiche dit
        // ce qu'il manque, et c'est précisément ce qu'on vient y chercher.
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`rpg:shopopen:${ownerId}:${item.id}:${category}:${page}`)
            .setLabel(truncate(m.rpg_shop_item_open({}, { locale }), 80))
            .setEmoji(icon('rpgShop'))
            .setStyle(affordable ? ButtonStyle.Success : ButtonStyle.Secondary),
        ),
    );
  }

  const components: PanelRow[] = [];

  // Le filtre n'apparaît qu'à partir de deux catégories : en dessous il ne
  // filtre rien et ne fait que voler une ligne à l'étal.
  if (catalog.categories.length > 1) {
    const categorySelect = new StringSelectMenuBuilder()
      .setCustomId(`rpg:shopcat:${ownerId}`)
      .setPlaceholder(m.rpg_shop_cat_placeholder({}, { locale }))
      .addOptions([
        {
          label: truncate(m.rpg_shop_cat_all({}, { locale }), 100),
          value: 'ALL',
          emoji: optionEmoji(icon('rpgBag')),
          default: category === 'ALL',
        },
        ...catalog.categories.map((type) => ({
          label: truncate(shopCategoryLabel(type, locale), 100),
          value: type,
          emoji: optionEmoji(itemTypeIcon(type)),
          default: category === type,
        })),
      ]);
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(categorySelect));
  }

  if (pageCount > 1) {
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(shopNavId(ownerId, { category, page: Math.max(0, page - 1) }))
        .setLabel(m.rpg_shop_prev({}, { locale }))
        .setEmoji(icon('rpgPrev'))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(shopNavId(ownerId, { category, page: page + 1 }))
        .setLabel(m.rpg_shop_next({}, { locale }))
        .setEmoji(icon('rpgNext'))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= pageCount - 1),
    ));
  }

  components.push(backRow(ownerId, locale));
  return { embeds: [], components, container };
}

/**
 * Fiche d'un objet : ce qu'il fait, ce qu'il coûte, ce qu'il en reste après achat.
 *
 * L'achat se faisait auparavant d'un simple clic dans un sélecteur, sans que le
 * joueur ait jamais vu les effets de l'objet ni le solde qui lui resterait.
 */
async function buildShopItemView(
  guildId: string,
  ownerId: string,
  itemId: string,
  locale: Locale,
  state: ShopState,
): Promise<PanelView> {
  const config = await getOrCreateEconomyConfig(guildId);
  const [profile, catalog] = await Promise.all([
    getOrCreateRpgProfile(guildId, ownerId),
    loadShopCatalog(guildId),
  ]);

  const item = catalog.items.find((entry) => entry.id === itemId);
  if (!item) {
    // L'objet a pu être retiré de l'étal entre l'affichage et le clic.
    return buildShopView(guildId, ownerId, locale, state);
  }

  const ownedEntry = profile.inventory.find((entry) => entry.itemId === item.id);

  // Même prix que celui débité à l'achat, remise de l'échoppe comprise : le prix catalogue
  // grisait des boutons que le joueur avait pourtant les moyens d'utiliser.
  const perks = await loadGuildPerksForMember(guildId, ownerId);
  const unitPrice = discountedPrice(item.price, perks.shopDiscount);
  const maxAffordable = unitPrice > 0 ? Math.floor(profile.balance / unitPrice) : MAX_SHOP_BUY_QUANTITY;
  const stats = shopItemStats(item, locale);

  const embed = new EmbedBuilder()
    .setTitle(truncate(`${itemTypeIcon(item.type)} ${item.name} ${rarityIcon(item.rarity)}`, 256))
    .setColor(RPG_COLORS.trade)
    .addFields([
      { name: m.rpg_shop_detail_price({}, { locale }), value: unitPrice < item.price ? `~~${item.price}~~ **${unitPrice}** ${config.currencyEmoji}` : `**${item.price}** ${config.currencyEmoji}`, inline: true },
      { name: m.rpg_shop_detail_balance({}, { locale }), value: `**${profile.balance}** ${config.currencyEmoji}`, inline: true },
      { name: shopCategoryLabel(item.type, locale), value: rarityIcon(item.rarity) || '-', inline: true },
      { name: m.rpg_shop_detail_stats({}, { locale }), value: stats || m.rpg_shop_detail_no_stats({}, { locale }) },
    ]);

  // Un exemplaire acheté arrive sans forge : c'est un objet neuf qu'on compare.
  const comparison = await equipmentComparisonField(profile, item, { upgrade: 0, enchants: [] }, locale);
  if (comparison) embed.addFields(comparison);

  if (item.description?.trim()) {
    embed.setDescription(truncate(item.description.trim(), 2000));
  }

  const notes: string[] = [];
  if (ownedEntry?.quantity) {
    notes.push(m.rpg_shop_owned({ count: ownedEntry.quantity }, { locale }).replace(/^[\s·]+/, ''));
  }
  notes.push(maxAffordable > 0
    ? m.rpg_shop_detail_max_qty({ count: Math.min(maxAffordable, MAX_SHOP_BUY_QUANTITY) }, { locale })
    : m.rpg_shop_detail_cannot_afford({ missing: unitPrice - profile.balance, emoji: config.currencyEmoji }, { locale }));
  embed.addFields({ name: '​', value: notes.join('\n') });

  const buyRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...SHOP_BUY_QUANTITIES.map((qty) => new ButtonBuilder()
      .setCustomId(`rpg:shopbuy:${ownerId}:${item.id}:${qty}:${state.category}:${state.page}`)
      .setLabel(m.rpg_shop_buy_qty({ qty }, { locale }))
      .setEmoji(icon('rpgShop'))
      .setStyle(qty === 1 ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(maxAffordable < qty)),
  );

  // « Tout » n'apparaît que s'il achète autre chose que ce que proposent déjà les
  // paliers : sinon c'est un doublon du bouton d'à côté.
  const maxQuantity = Math.min(maxAffordable, MAX_SHOP_BUY_QUANTITY);
  if (maxQuantity > 1 && !(SHOP_BUY_QUANTITIES as readonly number[]).includes(maxQuantity)) {
    buyRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`rpg:shopbuy:${ownerId}:${item.id}:${maxQuantity}:${state.category}:${state.page}`)
        .setLabel(m.rpg_shop_buy_max({ qty: maxQuantity }, { locale }))
        .setEmoji(icon('coins'))
        .setStyle(ButtonStyle.Primary),
    );
  }

  const backButton = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(shopNavId(ownerId, state))
      .setLabel(m.rpg_shop_back_to_shop({}, { locale }))
      .setEmoji(icon('rpgPrev'))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:hub`)
      .setLabel(m.rpg_hub_btn_back({}, { locale }))
      .setEmoji(icon('rpgBack'))
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [buyRow, backButton] };
}

/**
 * Ouverture de la fiche d'un article depuis son bouton sur l'étal.
 *
 * `rest` = `[itemId, categorie, page]` : l'état de l'étal voyage avec le clic
 * pour que le retour retombe sur la page exacte qu'on regardait.
 */
async function handleShopItemOpen(
  interaction: ButtonInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
  rest: string[],
): Promise<void> {
  const [itemId, ...stateParts] = rest;
  const view = await buildShopItemView(guildId, ownerId, itemId, locale, parseShopState(stateParts));
  await respond(interaction, view);
}

/**
 * Même chose depuis le sélecteur de l'étal.
 *
 * L'étal n'en propose plus, mais les messages déjà envoyés en portent un : sans
 * cette route, leur menu ne répondrait plus.
 */
async function handleShopItemSelect(
  interaction: StringSelectMenuInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
  rest: string[],
): Promise<void> {
  const state = parseShopState(rest);
  const view = await buildShopItemView(guildId, ownerId, interaction.values[0], locale, state);
  await respond(interaction, view);
}

/** Changement de filtre : on repart en première page, l'ancienne n'a plus de sens. */
async function handleShopCategorySelect(
  interaction: StringSelectMenuInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
): Promise<void> {
  const view = await buildShopView(guildId, ownerId, locale, parseShopState([interaction.values[0], '0']));
  await respond(interaction, view);
}

/**
 * Achat depuis la fiche d'un objet. Le joueur revient sur la fiche, pas sur
 * l'étal : il peut vouloir en reprendre, et son nouveau solde y est déjà à jour.
 */
async function handleShopBuy(
  interaction: ButtonInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
  rest: string[],
): Promise<void> {
  const [itemId, rawQty, ...stateParts] = rest;
  const quantity = Number.parseInt(rawQty ?? '1', 10) || 1;
  const state = parseShopState(stateParts);

  const purchase = await buyShopItem(guildId, ownerId, itemId, quantity);
  await trackQuest(interaction.client, guildId, ownerId, 'SHOP_PURCHASES', purchase.quantity);
  await trackQuest(interaction.client, guildId, ownerId, 'COINS_SPENT', purchase.price);

  const view = await buildShopItemView(guildId, ownerId, itemId, locale, state);
  view.embeds[0]?.setFooter({
    text: m.rpg_shop_bought_bulk({
      item: purchase.itemName,
      qty: purchase.quantity,
      price: purchase.price,
      balance: purchase.newBalance,
    }, { locale }).replace(/\*\*/g, ''),
  });
  await respond(interaction, view);
}

// ─────────────────────────────────────────────────────────────
// Marché noir
// ─────────────────────────────────────────────────────────────

function blackMarketOfferLine(offer: BlackMarketOfferView, locale: Locale): string {
  return m.rpg_blackmarket_offer_line({
    emoji: offer.emoji,
    name: offer.name,
    rarity: rarityIcon(offer.rarity),
    base: offer.basePrice,
    price: offer.price,
    discount: offer.discount,
    left: offer.stock - offer.purchased,
    stock: offer.stock,
  }, { locale });
}

async function buildBlackMarketView(guildId: string, ownerId: string, locale: Locale): Promise<PanelView> {
  const config = await getOrCreateEconomyConfig(guildId);
  const state = await getBlackMarketState(guildId, config);

  if (!state.enabled) {
    const embed = errorEmbed(
      m.rpg_blackmarket_disabled_title({}, { locale }),
      m.rpg_blackmarket_disabled_desc({}, { locale }),
    );
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  // Fermé : on confirme qu'une ouverture est planifiée, sans jamais donner la date -
  // sinon le marché noir devient un rendez-vous, pas une surprise.
  if (!state.session) {
    const embed = new EmbedBuilder()
      .setTitle(m.rpg_blackmarket_closed_title({}, { locale }))
      .setDescription(
        state.nextOpensAt
          ? `${m.rpg_blackmarket_closed_desc({}, { locale })}\n${m.rpg_blackmarket_closed_scheduled({}, { locale })}`
          : m.rpg_blackmarket_closed_desc({}, { locale }),
      )
      .setColor(COLORS.dark);
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  const profile = await getOrCreateRpgProfile(guildId, ownerId);
  const offers = await getMemberBlackMarketOffers(guildId, ownerId, state.session, config);

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_blackmarket_title({}, { locale }))
    .setDescription(m.rpg_blackmarket_desc({
      closes: `<t:${Math.floor(state.session.closesAt.getTime() / 1000)}:R>`,
      balance: profile.balance,
      emoji: config.currencyEmoji,
    }, { locale }))
    .setColor(COLORS.dark);

  if (offers.length === 0) {
    embed.addFields({
      name: m.rpg_blackmarket_field_offers({}, { locale }),
      value: m.rpg_blackmarket_empty_desc({}, { locale }),
    });
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  embed.addFields({
    name: m.rpg_blackmarket_field_offers({}, { locale }),
    value: offers.map((offer) => blackMarketOfferLine(offer, locale)).join('\n\n').slice(0, 1024),
  });

  const available = offers.filter((offer) => offer.purchased < offer.stock);
  if (available.length === 0) return { embeds: [embed], components: [backRow(ownerId, locale)] };

  const placeholder = m.rpg_blackmarket_select_placeholder({}, { locale });
  const select = new StringSelectMenuBuilder()
    .setCustomId(`rpg:bmbuy:${ownerId}`)
    .setPlaceholder(placeholder);

  const fixedText = placeholder.length + m.rpg_hub_btn_back({}, { locale }).length + embedTextLength(embed);
  addOptionsWithinBudget(
    select,
    available.slice(0, 25).map((offer) => ({
      label: truncate(`${offer.name} · ${offer.price} 🪙`, 100),
      description: truncate(m.rpg_blackmarket_option_desc({
        price: offer.price,
        discount: offer.discount,
        left: offer.stock - offer.purchased,
      }, { locale }), 100),
      value: offer.id,
      emoji: optionEmoji(offer.emoji),
    })),
    SHOP_TEXT_BUDGET - SHOP_TEXT_RESERVE - fixedText,
  );

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  return { embeds: [embed], components: [selectRow, backRow(ownerId, locale)] };
}

async function handleBlackMarketBuy(interaction: StringSelectMenuInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const purchase = await buyBlackMarketOffer(guildId, ownerId, interaction.values[0]);
  await trackQuest(interaction.client, guildId, ownerId, 'BLACK_MARKET_PURCHASES');
  await trackQuest(interaction.client, guildId, ownerId, 'COINS_SPENT', purchase.price);

  const view = await buildBlackMarketView(guildId, ownerId, locale);
  view.embeds[0]?.setFooter({
    text: m.rpg_blackmarket_buy_success({
      emoji: purchase.itemEmoji,
      item: purchase.itemName,
      price: purchase.price,
      discount: purchase.discount,
      balance: purchase.newBalance,
    }, { locale }),
  });
  await respond(interaction, view);
}

// ─────────────────────────────────────────────────────────────
// Raid
// ─────────────────────────────────────────────────────────────

type RaidPanelState = Awaited<ReturnType<typeof getRaidPanelState>>;
type RaidViewer = NonNullable<RaidPanelState['viewer']>;

/** Membre Discord du propriétaire du panneau, pour ce qui se lit sur ses rôles. */
async function panelMember(interaction: PanelInteraction, ownerId: string): Promise<GuildMember | null> {
  const guild = interaction.guild;
  if (!guild) return null;
  return guild.members.fetch(ownerId).catch(() => null);
}

/** Où en est le joueur dans le raid : la seule chose que l'annonce publique ne dit pas. */
function raidViewerLine(viewer: RaidViewer, locale: Locale): string {
  if (!viewer.teamName) {
    return viewer.mode === 'CLAN'
      ? m.rpg_raid_panel_no_clan({}, { locale })
      : m.rpg_raid_panel_no_guild({}, { locale });
  }

  if (viewer.engaged && viewer.engaged.remainingHealth <= 0) {
    return m.rpg_raid_panel_defeated({ team: viewer.teamName }, { locale });
  }
  if (viewer.assaultsLeft === 0) {
    return m.rpg_raid_panel_spent({ team: viewer.teamName }, { locale });
  }
  if (!viewer.engaged) {
    return m.rpg_raid_panel_untouched({ team: viewer.teamName, left: viewer.assaultsLeft }, { locale });
  }

  return m.rpg_raid_panel_engaged({
    team: viewer.teamName,
    bar: healthBar(viewer.engaged.remainingHealth, viewer.engaged.totalHealth),
    remaining: viewer.engaged.remainingHealth.toLocaleString('fr-FR'),
    total: viewer.engaged.totalHealth.toLocaleString('fr-FR'),
    left: viewer.assaultsLeft,
  }, { locale });
}

function raidActionRow(ownerId: string, locale: Locale, canAttack: boolean, backTo: 'hub' | 'raid'): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (canAttack) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`rpg:raidattack:${ownerId}`)
        .setLabel(m.rpg_raid_button_attack({}, { locale }))
        .setEmoji(icon('rpgFight'))
        .setStyle(ButtonStyle.Danger),
    );
  }
  return row.addComponents(
    new ButtonBuilder().setCustomId(`rpg:nav:${ownerId}:${backTo}`).setLabel(m.rpg_hub_btn_back({}, { locale })).setEmoji(icon('rpgBack')).setStyle(ButtonStyle.Secondary),
  );
}

async function buildRaidView(guildId: string, ownerId: string, member: GuildMember | null, locale: Locale): Promise<PanelView> {
  const { enabled, raid, viewer, teams, nextOpensAt } = await getRaidPanelState(guildId, ownerId, member);

  if (!enabled) {
    const embed = errorEmbed(m.rpg_raid_panel_title({}, { locale }), m.rpg_raid_panel_disabled({}, { locale }));
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  if (!raid || !viewer) {
    const embed = new EmbedBuilder()
      .setTitle(m.rpg_raid_panel_title({}, { locale }))
      .setDescription(nextOpensAt
        ? m.rpg_raid_panel_next({ when: `<t:${Math.floor(nextOpensAt.getTime() / 1000)}:R>` }, { locale })
        : m.rpg_raid_panel_none({}, { locale }))
      .setColor(RPG_COLORS.combat);
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  // L'embed public est repris tel quel : la barre d'une équipe doit dire la même chose ici
  // et dans le salon, et deux constructions divergeraient au premier changement.
  const embed = buildRaidEmbed(raid, teams, locale);
  embed.addFields({ name: m.rpg_raid_panel_field_you({}, { locale }), value: raidViewerLine(viewer, locale) });

  return { embeds: [embed], components: [raidActionRow(ownerId, locale, viewer.canAttack, 'hub')] };
}

/**
 * Livre un assaut depuis le panneau.
 *
 * L'écran est remplacé par le compte rendu, comme après un combat de boss, avec de quoi
 * frapper à nouveau sans repasser par le hub.
 */
async function handleRaidAttack(interaction: ButtonInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const member = await panelMember(interaction, ownerId);
  await interaction.deferUpdate();

  try {
    const outcome = await attackRaid(interaction.client, guildId, ownerId, member);
    const canAttackAgain = outcome.assaultsLeft > 0 && outcome.team.remainingHealth > 0;
    await interaction.editReply({
      embeds: [await buildAssaultEmbed(guildId, outcome)],
      components: [raidActionRow(ownerId, locale, canAttackAgain, 'raid')],
    });
  } catch (error) {
    // Un refus attendu - plus d'assaut, pas d'énergie, pas d'équipe - se dit au joueur et
    // le laisse sur l'écran ; le reste part au journal, dont il n'a que faire.
    if (!(error instanceof RaidError)) {
      logger.error('RpgPanel', `Assaut de raid en échec sur ${guildId}:`, error);
    }
    const reason = error instanceof RaidError ? error.message : m.rpg_raid_panel_attack_failed({}, { locale });
    await interaction.editReply({
      embeds: [errorEmbed(m.rpg_raid_panel_attack_error({}, { locale }), reason)],
      components: [raidActionRow(ownerId, locale, false, 'raid')],
    }).catch(() => null);
  }
}

// ─────────────────────────────────────────────────────────────
// Guilde
// ─────────────────────────────────────────────────────────────

/** Bouton d'accès au front, commun à tous les états de l'écran de guilde. */
function warButton(ownerId: string, locale: Locale): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(`rpg:nav:${ownerId}:clanwar`)
    .setLabel(m.rpg_war_btn_open({}, { locale }))
    .setEmoji(icon('rpgWar'))
    .setStyle(ButtonStyle.Primary);
}

async function buildGuildView(
  guildId: string,
  ownerId: string,
  locale: Locale,
  member: GuildMember | null = null,
): Promise<PanelView> {
  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.guildsEnabled) {
    const embed = errorEmbed(m.rpg_guild_disabled_title({}, { locale }), m.rpg_guild_disabled_desc({}, { locale }));
    // Le front reste accessible : en mode clan, il ne dépend pas des guildes RPG.
    return {
      embeds: [embed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        warButton(ownerId, locale),
        new ButtonBuilder().setCustomId(`rpg:nav:${ownerId}:hub`).setLabel(m.rpg_hub_btn_back({}, { locale })).setEmoji(icon('rpgBack')).setStyle(ButtonStyle.Secondary),
      )],
    };
  }

  const profile = await getOrCreateRpgProfile(guildId, ownerId);
  // L'appartenance d'équipe se lit à part : en mode clan elle vient des rôles
  // Discord, et une guilde RPG n'en sait rien.
  const warTeam = await getViewerWarTeam(guildId, ownerId, member);

  if (!profile.rpgGuildId) {
    const embed = new EmbedBuilder()
      .setTitle(m.rpg_guild_no_guild_title({}, { locale }))
      .setDescription(m.rpg_guild_no_guild_desc({}, { locale }))
      .setColor(RPG_COLORS.team)
      .addFields({
        name: m.rpg_guild_field_war({}, { locale }),
        value: warTeam.name
          ? m.rpg_guild_war_team({ team: warTeam.name }, { locale })
          : m.rpg_guild_war_none({}, { locale }),
      });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`rpg:guildcreateopen:${ownerId}`).setLabel(m.rpg_hub_guild_btn_create({}, { locale })).setEmoji(icon('rpgGuild')).setStyle(ButtonStyle.Success),
      // L'annuaire arrive en premier après « fonder » : sans lui, trouver une guilde à
      // rejoindre supposait d'en connaître déjà le nom exact.
      new ButtonBuilder().setCustomId(`rpg:nav:${ownerId}:guilds`).setLabel(m.rpg_guilds_btn_directory({}, { locale })).setEmoji(icon('rpgClan')).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`rpg:guildjoinopen:${ownerId}`).setLabel(m.rpg_hub_guild_btn_join({}, { locale })).setEmoji(icon('rpgClan')).setStyle(ButtonStyle.Secondary),
      warButton(ownerId, locale),
      new ButtonBuilder().setCustomId(`rpg:nav:${ownerId}:hub`).setLabel(m.rpg_hub_btn_back({}, { locale })).setEmoji(icon('rpgBack')).setStyle(ButtonStyle.Secondary),
    );

    return { embeds: [embed], components: [row] };
  }

  const rpgGuild = await prisma.rpgGuild.findUnique({ where: { id: profile.rpgGuildId }, include: { members: true } });
  if (!rpgGuild) {
    // Référence orpheline (guilde supprimée entre-temps) : on nettoie le profil puis on
    // ré-affiche l'écran « sans guilde ». L'ancien code se rappelait lui-même sans rien
    // corriger, ce qui bouclait à l'infini jusqu'au dépassement de pile.
    await prisma.rpgProfile.update({ where: { id: profile.id }, data: { rpgGuildId: null } });
    return buildGuildView(guildId, ownerId, locale, member);
  }

  const xpNeeded = rpgGuildXpNeeded(rpgGuild.level);
  // Le plafond de membres suit le niveau de la guilde : une grande guilde dépassait la
  // limite d'un champ d'embed, et Discord refusait l'écran entier, pas seulement la liste.
  const membersList = joinFieldEntries(
    rpgGuild.members.map((mb) => `<@${mb.userId}> (Niveau ${mb.level})`),
    { separator: ', ', more: (count) => m.rpg_guild_members_more({ count }, { locale }) },
  );

  // Place de l'équipe du joueur sur le front, résumée en une ligne : la fiche de
  // guilde était le seul écran où l'on parlait de collectif, et elle ignorait
  // complètement ce que le jeu rapportait au clan.
  const war = await getClanWarState({ guildId, userId: ownerId, member });
  const warValue = war.closure
    ? m.rpg_guild_war_off({}, { locale })
    : !warTeam.name
      ? m.rpg_guild_war_none({}, { locale })
      // En mode guilde RPG, l'équipe est la guilde qu'on regarde déjà : redire
      // son score n'apprend rien, seul son rang en dit quelque chose.
      : war.mode === 'RPG_GUILD'
        ? m.rpg_guild_war_rank({ team: warTeam.name, rank: war.viewer.rank ?? 0 }, { locale })
        : m.rpg_guild_war_standing({
          team: warTeam.name,
          rank: war.viewer.rank ?? 0,
          points: war.viewer.points,
        }, { locale });

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_guild_title({ emoji: rpgGuild.emoji, name: rpgGuild.name }, { locale }))
    .setDescription(rpgGuild.description || m.rpg_guild_no_description({}, { locale }))
    .setColor(RPG_COLORS.team)
    .addFields(
      { name: `${icon('star')} ${m.rpg_guild_field_level({}, { locale })}`, value: m.rpg_profile_level_value({ level: rpgGuild.level }, { locale }), inline: true },
      { name: `${icon('coins')} ${m.rpg_guild_field_treasury({}, { locale })}`, value: m.rpg_guild_treasury_value({ amount: rpgGuild.treasury }, { locale }), inline: true },
      { name: `${icon('rpgXp')} ${m.rpg_guild_field_xp({}, { locale })}`, value: `${rpgGuild.xp} / ${xpNeeded} XP\n${gaugeBar(rpgGuild.xp, xpNeeded, 'xp')}`, inline: false },
      { name: `${icon('rpgWar')} ${m.rpg_guild_field_war({}, { locale })}`, value: warValue, inline: false },
      { name: `${icon('rpgClan')} ${m.rpg_guild_field_members({}, { locale })}`, value: membersList || m.rpg_guild_no_members({}, { locale }) },
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rpg:guilddepositopen:${ownerId}`).setLabel(m.rpg_hub_guild_btn_deposit({}, { locale })).setEmoji(icon('coins')).setStyle(ButtonStyle.Success),
    // Le village se trouve depuis la fiche de guilde : c'est le seul écran qui parle
    // déjà du trésor, donc le seul endroit où « à quoi ça sert » se pose vraiment.
    new ButtonBuilder().setCustomId(`rpg:nav:${ownerId}:village`).setLabel(m.rpg_hub_btn_village({}, { locale })).setEmoji('🏘️').setStyle(ButtonStyle.Primary),
    warButton(ownerId, locale),
    new ButtonBuilder().setCustomId(`rpg:nav:${ownerId}:guilds`).setLabel(m.rpg_guilds_btn_directory({}, { locale })).setEmoji(icon('rpgClan')).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`rpg:nav:${ownerId}:hub`).setLabel(m.rpg_hub_btn_back({}, { locale })).setEmoji(icon('rpgBack')).setStyle(ButtonStyle.Secondary),
  );

  // Seconde rangée : ce qui engage. Le bouton de modification n'apparaît qu'au chef,
  // seul habilité à écrire la fiche commune.
  const secondRow = new ActionRowBuilder<ButtonBuilder>();
  if (rpgGuild.ownerId === ownerId) {
    secondRow.addComponents(
      new ButtonBuilder().setCustomId(`rpg:guildeditopen:${ownerId}`).setLabel(m.rpg_guild_edit_btn({}, { locale })).setEmoji(icon('settings')).setStyle(ButtonStyle.Primary),
    );
  }
  secondRow.addComponents(
    new ButtonBuilder().setCustomId(`rpg:guildleaveask:${ownerId}`).setLabel(m.rpg_hub_guild_btn_leave({}, { locale })).setEmoji(icon('rpgTravel')).setStyle(ButtonStyle.Danger),
  );

  return { embeds: [embed], components: [row, secondRow] };
}

// ─────────────────────────────────────────────────────────────
// Campagne
// ─────────────────────────────────────────────────────────────

/** Récompense rendue en une ligne : pièces, XP, et l'objet s'il y en a un. */
function campaignRewardLine(reward: CampaignReward, locale: Locale): string {
  const parts = [
    `${icon('coins')} **${reward.coins}**`,
    `${icon('rpgXp')} **${reward.xp}** XP`,
  ];
  if (reward.itemName) parts.push(`${icon('rpgBag')} **${reward.itemName}**`);
  return m.rpg_campaign_reward({ parts: parts.join(' · ') }, { locale });
}

/** Ligne d'étape : sa consigne, son avancement, et le récit qui l'accompagne. */
function campaignStepLine(view: CampaignStepView, isCurrent: boolean): string {
  const marker = view.done ? '✅' : isCurrent ? '▶️' : '⬜';
  const title = view.done ? `~~${view.step.title}~~` : `**${view.step.title}**`;

  if (view.done) return `${marker} ${title}`;

  // Le récit n'accompagne que l'étape en cours : le donner pour toutes spolierait la
  // suite, et tripler la hauteur de l'écran pour du texte que personne ne lit encore.
  const narration = isCurrent ? `\n*${view.step.narration}*` : '';
  const progress = isCurrent
    ? `\n${gaugeBar(view.counter, view.target, 'xp')} ${view.counter}/${view.target}`
    : '';

  return `${marker} ${title}${narration}${progress}`;
}

async function buildCampaignView(guildId: string, ownerId: string, locale: Locale): Promise<PanelView> {
  // L'ouverture rattrape ce qui est déjà acquis : un joueur de niveau 30 qui découvre la
  // campagne ne doit pas se voir demander d'atteindre le niveau 5.
  const caught = await openCampaign(guildId, ownerId);
  const state = await getCampaignState(guildId, ownerId);

  const embed = new EmbedBuilder()
    .setTitle(`${icon('rpgKey')} ${m.rpg_campaign_title({}, { locale })}`)
    .setColor(RPG_COLORS.hub);

  if (state.finished || !state.chapter) {
    embed
      .setDescription(m.rpg_campaign_finished({}, { locale }))
      .addFields({
        name: m.rpg_campaign_field_progress({}, { locale }),
        value: `${gaugeBar(state.stepsTotal, state.stepsTotal, 'xp')} ${state.stepsTotal}/${state.stepsTotal}`,
        inline: false,
      });
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  const { chapter } = state;

  embed
    .setDescription(`${chapter.emoji} **${m.rpg_campaign_chapter({ number: state.chapterNumber, total: state.totalChapters, title: chapter.title }, { locale })}**\n*${chapter.intro}*`)
    .addFields(
      {
        name: m.rpg_campaign_field_progress({}, { locale }),
        value: `${gaugeBar(state.stepsDone, state.stepsTotal, 'xp')} ${state.stepsDone}/${state.stepsTotal}\n`
          + m.rpg_campaign_level_hint({ level: chapter.levelHint }, { locale }),
        inline: false,
      },
      {
        name: m.rpg_campaign_field_steps({}, { locale }),
        value: truncate(
          state.steps.map((step) => campaignStepLine(step, step.index === (state.current?.index ?? -1))).join('\n'),
          1024,
        ),
        inline: false,
      },
    );

  if (state.current) {
    embed.addFields({
      name: m.rpg_campaign_field_next_reward({}, { locale }),
      value: campaignRewardLine(state.current.step.reward, locale),
      inline: true,
    });
  }

  embed.addFields({
    name: m.rpg_campaign_field_chapter_reward({}, { locale }),
    value: campaignRewardLine(chapter.reward, locale),
    inline: true,
  });

  // Le rattrapage d'ouverture se dit : sans ça, un joueur verrait son écran sauter
  // plusieurs étapes sans comprendre ce qui vient de se passer.
  const caughtUp = caught.completedSteps.length;
  if (caughtUp > 0) {
    embed.setFooter({ text: m.rpg_campaign_caught_up({ count: caughtUp }, { locale }) });
  }

  return { embeds: [embed], components: [backRow(ownerId, locale)] };
}

/**
 * Résumé d'une progression de campagne, à coller en pied d'un autre écran.
 *
 * Renvoie une chaîne vide quand rien n'a avancé, pour que l'appelant puisse l'ajouter
 * sans condition.
 */
function campaignAdvanceNote(advance: CampaignAdvance, locale: Locale): string {
  if (advance.finished) return m.rpg_campaign_note_finished({}, { locale });

  if (advance.completedChapters.length > 0) {
    const chapter = advance.completedChapters[advance.completedChapters.length - 1].chapter;
    return m.rpg_campaign_note_chapter({ emoji: chapter.emoji, title: chapter.title }, { locale });
  }

  if (advance.completedSteps.length > 0) {
    const step = advance.completedSteps[advance.completedSteps.length - 1].step;
    return m.rpg_campaign_note_step({ title: step.title, count: advance.completedSteps.length }, { locale });
  }

  return '';
}

// ─────────────────────────────────────────────────────────────
// Arène PvP
// ─────────────────────────────────────────────────────────────

/** Ligne du tableau d'arène. Le podium porte sa médaille. */
function arenaStandingLine(record: ArenaRecordView, rank: number, isViewer: boolean): string {
  const medal = rank === 1 ? icon('rank1') : rank === 2 ? icon('rank2') : rank === 3 ? icon('rank3') : `**#${rank}**`;
  const name = isViewer ? `__<@${record.userId}>__` : `<@${record.userId}>`;
  return `${medal} ${name} — ${record.tier.emoji} **${record.rating}** (${record.wins}V / ${record.losses}D)`;
}

/** Série en cours, rendue lisible : « 3 victoires d'affilée » plutôt que « streak: 3 ». */
function arenaStreakLabel(streak: number, locale: Locale): string {
  if (streak === 0) return m.rpg_arena_streak_none({}, { locale });
  return streak > 0
    ? m.rpg_arena_streak_wins({ count: streak }, { locale })
    : m.rpg_arena_streak_losses({ count: -streak }, { locale });
}

async function buildArenaView(guildId: string, ownerId: string, locale: Locale): Promise<PanelView> {
  const state = await getArenaState(guildId, ownerId);
  const { record } = state;

  const embed = new EmbedBuilder()
    .setTitle(`${icon('rpgWar')} ${m.rpg_arena_title({}, { locale })}`)
    .setColor(RPG_COLORS.combat)
    .setDescription(m.rpg_arena_desc({
      emoji: record.tier.emoji,
      tier: record.tier.name,
      rating: record.rating,
      rank: state.rank > 0 ? state.rank : state.totalRanked + 1,
      total: Math.max(state.totalRanked, 1),
    }, { locale }))
    .addFields(
      {
        name: m.rpg_arena_field_record({}, { locale }),
        value: m.rpg_arena_record_value({
          wins: record.wins,
          losses: record.losses,
          best: record.bestRating,
          streak: arenaStreakLabel(record.streak, locale),
        }, { locale }),
        inline: true,
      },
      {
        name: m.rpg_arena_field_entry({}, { locale }),
        value: m.rpg_arena_entry_value({ energy: state.energyCost, level: state.minLevel }, { locale }),
        inline: true,
      },
    );

  if (state.leaderboard.length > 0) {
    embed.addFields({
      name: m.rpg_arena_field_leaderboard({}, { locale }),
      value: truncate(
        state.leaderboard
          .map((entry, index) => arenaStandingLine(entry, index + 1, entry.userId === ownerId))
          .join('\n'),
        1024,
      ),
      inline: false,
    });
  }

  // Les duels subis sont la seule trace qu'a le défenseur d'avoir été attaqué : il n'était
  // pas là quand ça s'est produit, et rien d'autre ne le lui dirait.
  if (state.recentDefenses.length > 0) {
    embed.addFields({
      name: m.rpg_arena_field_defenses({}, { locale }),
      value: truncate(
        state.recentDefenses
          .map((defense) => (defense.won
            ? m.rpg_arena_defense_won({ id: defense.challengerId, points: defense.ratingChange }, { locale })
            : m.rpg_arena_defense_lost({ id: defense.challengerId, points: defense.ratingChange }, { locale })))
          .join('\n'),
        1024,
      ),
      inline: false,
    });
  }

  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

  if (!state.entry.ok) {
    embed.setFooter({
      text: state.entry.reason === 'level'
        ? m.rpg_arena_blocked_level({ level: state.minLevel }, { locale })
        : state.entry.reason === 'energy'
          ? m.rpg_arena_blocked_energy({ energy: state.energyCost }, { locale })
          : m.rpg_arena_blocked_cooldown({ seconds: Math.ceil((state.entry.retryInMs ?? 0) / 1000) }, { locale }),
    });
  } else if (state.opponents.length === 0) {
    embed.setFooter({ text: m.rpg_arena_no_opponent({ level: state.minLevel }, { locale }) });
  } else {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`rpg:arenafight:${ownerId}`)
      .setPlaceholder(m.rpg_arena_select_placeholder({}, { locale }))
      .addOptions(state.opponents.slice(0, 25).map((opponent) => ({
        label: truncate(`${opponent.tier.name} · ${opponent.rating} pts`, 100),
        description: m.rpg_arena_opponent_desc({ level: opponent.level }, { locale }).slice(0, 100),
        value: opponent.userId,
        emoji: optionEmoji(opponent.tier.emoji),
      })));
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  }

  components.push(backRow(ownerId, locale));
  return { embeds: [embed], components };
}

/**
 * Lance un duel et remplace l'écran par son compte rendu.
 *
 * Le duel est résolu côté service : ici on ne fait qu'en rendre les derniers tours, comme
 * après un combat de boss.
 */
async function handleArenaFight(interaction: StringSelectMenuInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const opponentId = interaction.values[0];

  let outcome: Awaited<ReturnType<typeof fightArenaDuel>>;
  try {
    outcome = await fightArenaDuel(guildId, ownerId, opponentId);
  } catch (error) {
    // Un refus attendu — pas d'énergie, cooldown, adversaire parti — se dit au joueur et
    // le laisse sur l'écran ; le reste part au journal, dont il n'a que faire.
    if (!(error instanceof ArenaError)) {
      logger.error('RpgPanel', `Duel d'arène en échec sur ${guildId} :`, error);
    }
    const reason = error instanceof ArenaError ? error.message : m.rpg_arena_failed({}, { locale });
    await replyPanelError(interaction, new Error(reason), locale);
    return;
  }

  const log = outcome.turns.slice(-5).map((turn) => {
    const who = turn.attacker === 'challenger' ? m.rpg_arena_log_you({}, { locale }) : `<@${outcome.opponentId}>`;
    const crit = turn.critical ? ` ${icon('rpgCrit')}` : '';
    const skill = turn.skillName ? ` *(${turn.skillName})*` : '';
    return `${who} — **${turn.damage}**${crit}${skill}`;
  }).join('\n');

  const embed = new EmbedBuilder()
    .setTitle(outcome.won
      ? m.rpg_arena_win_title({}, { locale })
      : m.rpg_arena_lose_title({}, { locale }))
    .setColor(outcome.won ? COLORS.success : COLORS.danger)
    .setDescription(m.rpg_arena_result_desc({
      id: outcome.opponentId,
      points: outcome.ratingChange,
      rating: outcome.newRating,
    }, { locale }))
    .addFields(
      {
        name: m.rpg_arena_field_duel({}, { locale }),
        value: `${m.rpg_arena_log_you({}, { locale })} ${combatHpBar(Math.max(0, outcome.turns.at(-1)?.challengerHp ?? 0), outcome.challengerMaxHp)}\n`
          + `<@${outcome.opponentId}> ${combatHpBar(Math.max(0, outcome.turns.at(-1)?.opponentHp ?? 0), outcome.opponentMaxHp)}`,
        inline: false,
      },
      { name: m.rpg_arena_field_log({}, { locale }), value: truncate(log || '—', 1024), inline: false },
      {
        name: m.rpg_arena_field_reward({}, { locale }),
        value: m.rpg_arena_reward_value({ coins: outcome.reward.coins, xp: outcome.reward.xp }, { locale }),
        inline: false,
      },
    )
    .setFooter({ text: arenaStreakLabel(outcome.streak, locale) });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:arena`)
      .setLabel(m.rpg_arena_btn_again({}, { locale }))
      .setEmoji(icon('rpgWar'))
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:hub`)
      .setLabel(m.rpg_hub_btn_back({}, { locale }))
      .setEmoji(icon('rpgBack'))
      .setStyle(ButtonStyle.Secondary),
  );

  await respond(interaction, { embeds: [embed], components: [row] });
}

// ─────────────────────────────────────────────────────────────
// Village de guilde
// ─────────────────────────────────────────────────────────────

/** Fiche d'un bâtiment : ce qu'il donne aujourd'hui, et ce que coûte le palier suivant. */
function buildingLine(view: BuildingView, locale: Locale): string {
  const active = view.active
    ? `✅ ${view.active.effect}`
    : `*${m.rpg_village_not_built({}, { locale })}*`;

  if (!view.next) {
    return `${active}\n🏆 ${m.rpg_village_maxed({}, { locale })}`;
  }

  const upgrade = m.rpg_village_next_tier({
    level: view.level + 1,
    effect: view.next.effect,
    cost: view.next.cost,
  }, { locale });

  const blocker = view.blockedBy === 'guildLevel'
    ? `🔒 ${m.rpg_village_need_guild_level({ level: view.next.guildLevel }, { locale })}`
    : view.blockedBy === 'treasury'
      ? `💰 ${m.rpg_village_need_treasury({ cost: view.next.cost }, { locale })}`
      : `🟢 ${m.rpg_village_ready({}, { locale })}`;

  return `${active}\n${upgrade}\n${blocker}`;
}

/** Les avantages actifs du village, en une ligne par effet réellement obtenu. */
function villagePerkLine(perks: GuildPerks, locale: Locale): string {
  const parts = [
    perks.shopDiscount > 0 ? `${icon('rpgShop')} −${Math.round(perks.shopDiscount * 100)} %` : null,
    perks.forgeSuccess > 0 ? `${icon('rpgForge')} +${Math.round(perks.forgeSuccess * 100)} %` : null,
    perks.xpBonus > 0 ? `${icon('rpgXp')} +${Math.round(perks.xpBonus * 100)} %` : null,
    perks.coinBonus > 0 ? `${icon('coins')} +${Math.round(perks.coinBonus * 100)} %` : null,
    perks.attackFlat > 0 ? `${icon('rpgAtk')} +${perks.attackFlat}` : null,
    perks.defenseFlat > 0 ? `${icon('rpgDef')} +${perks.defenseFlat}` : null,
    perks.maxHealthFlat > 0 ? `${icon('rpgHp')} +${perks.maxHealthFlat}` : null,
  ].filter((part): part is string => part !== null);

  return parts.length > 0 ? parts.join(' · ') : m.rpg_village_no_perk({}, { locale });
}

async function buildVillageView(guildId: string, ownerId: string, locale: Locale): Promise<PanelView> {
  const profile = await getOrCreateRpgProfile(guildId, ownerId);

  if (!profile.rpgGuildId) {
    const embed = errorEmbed(m.rpg_village_title({}, { locale }), m.rpg_village_no_guild({}, { locale }));
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  const state = await getGuildVillageState(profile.rpgGuildId, ownerId);

  const embed = new EmbedBuilder()
    .setTitle(`${state.guildEmoji} ${m.rpg_village_title({}, { locale })} — ${truncate(state.guildName, 60)}`)
    .setDescription(m.rpg_village_desc({
      level: state.guildLevel,
      treasury: state.treasury,
      perks: villagePerkLine(state.perks, locale),
    }, { locale }))
    .setColor(RPG_COLORS.team);

  // Un bâtiment par colonne : cinq fiches courtes côte à côte se parcourent d'un coup
  // d'œil, là où cinq blocs pleine largeur demandaient de faire défiler l'écran.
  for (const view of state.buildings) {
    embed.addFields({
      name: `${view.building.emoji} ${view.building.name} (${view.level}/${view.maxLevel})`,
      value: truncate(buildingLine(view, locale), 1024),
      inline: true,
    });
  }

  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

  // Seul le chef bâtit : montrer le sélecteur aux autres ne ferait qu'annoncer un refus.
  if (state.isLeader) {
    const buildable = state.buildings.filter((view) => view.buildable);
    if (buildable.length > 0) {
      const select = new StringSelectMenuBuilder()
        .setCustomId(`rpg:villagebuild:${ownerId}`)
        .setPlaceholder(m.rpg_village_select_placeholder({}, { locale }))
        .addOptions(buildable.map((view) => ({
          label: truncate(`${view.building.name} → ${view.level + 1}`, 100),
          description: truncate(`${view.next!.cost} 🪙 — ${view.next!.effect}`, 100),
          value: view.building.id,
          emoji: optionEmoji(view.building.emoji),
        })));
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
    } else {
      embed.setFooter({ text: m.rpg_village_nothing_buildable({}, { locale }) });
    }
  } else {
    embed.setFooter({ text: m.rpg_village_leader_only({}, { locale }) });
  }

  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:guild`)
      .setLabel(m.rpg_hub_btn_guild({}, { locale }))
      .setEmoji(icon('rpgGuild'))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:hub`)
      .setLabel(m.rpg_hub_btn_back({}, { locale }))
      .setEmoji(icon('rpgBack'))
      .setStyle(ButtonStyle.Secondary),
  ));

  return { embeds: [embed], components };
}

async function handleVillageBuild(interaction: StringSelectMenuInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const result = await buildGuildBuilding(guildId, ownerId, interaction.values[0]);

  const view = await buildVillageView(guildId, ownerId, locale);
  view.embeds[0]?.setFooter({
    text: m.rpg_village_built({
      emoji: result.building.emoji,
      name: result.building.name,
      level: result.newLevel,
      effect: result.tier.effect,
      treasury: result.remainingTreasury,
    }, { locale }),
  });
  await respond(interaction, view);
}

// ─────────────────────────────────────────────────────────────
// Annuaire des guildes
// ─────────────────────────────────────────────────────────────

/** Ligne d'annuaire : de quoi choisir sans avoir à ouvrir chaque fiche. */
function guildDirectoryLine(entry: GuildDirectoryEntry, locale: Locale): string {
  const occupancy = m.rpg_guilds_occupancy({ members: entry.memberCount, capacity: entry.capacity }, { locale });
  const badge = entry.isMine
    ? ` ${m.rpg_guilds_tag_mine({}, { locale })}`
    : entry.full
      ? ` ${m.rpg_guilds_tag_full({}, { locale })}`
      : '';

  const description = entry.description
    ? `\n*${truncate(entry.description, 90)}*`
    : '';

  return `${entry.emoji} **${truncate(entry.name, 40)}**${badge}\n${icon('star')} Niv. ${entry.level} · ${icon('rpgClan')} ${occupancy}${description}`;
}

async function buildGuildDirectoryView(guildId: string, ownerId: string, locale: Locale): Promise<PanelView> {
  const guilds = await listRpgGuilds(guildId, ownerId);

  const embed = new EmbedBuilder()
    .setTitle(`${icon('rpgGuild')} ${m.rpg_guilds_title({}, { locale })}`)
    .setColor(RPG_COLORS.team);

  if (guilds.length === 0) {
    embed.setDescription(m.rpg_guilds_empty({}, { locale }));
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  embed.setDescription(m.rpg_guilds_desc({ count: guilds.length }, { locale }));

  // Une guilde par colonne : trois tiennent de front, et l'annuaire se parcourt sans
  // dérouler une liste qui ferait plusieurs écrans de haut.
  for (const entry of guilds.slice(0, 9)) {
    embed.addFields({
      name: `${entry.emoji} ${truncate(entry.name, 40)}`,
      value: truncate(guildDirectoryLine(entry, locale), 1024),
      inline: true,
    });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`rpg:guildview:${ownerId}`)
    .setPlaceholder(m.rpg_guilds_select_placeholder({}, { locale }))
    .addOptions(guilds.slice(0, 25).map((entry) => ({
      label: truncate(entry.name, 100),
      description: m.rpg_guilds_option_desc({
        level: entry.level,
        members: entry.memberCount,
        capacity: entry.capacity,
      }, { locale }).slice(0, 100),
      value: entry.id,
      emoji: optionEmoji(entry.emoji),
    })));

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      backRow(ownerId, locale),
    ],
  };
}

/**
 * Fiche d'une guilde, consultable qu'on en soit membre ou non.
 *
 * Le trésor n'y est chiffré que pour les membres : c'est la caisse commune, l'exposer
 * inviterait à cibler les guildes riches en guerre de clans.
 */
async function buildGuildProfileView(
  guildId: string,
  ownerId: string,
  rpgGuildId: string,
  locale: Locale,
): Promise<PanelView> {
  const view = await getGuildProfile(guildId, rpgGuildId, ownerId);

  if (!view) {
    return {
      embeds: [errorEmbed(m.rpg_guilds_title({}, { locale }), m.rpg_guilds_not_found({}, { locale }))],
      components: [backRow(ownerId, locale)],
    };
  }

  const embed = new EmbedBuilder()
    .setTitle(`${view.emoji} ${truncate(view.name, 60)}`)
    .setDescription(view.description || m.rpg_guild_no_description({}, { locale }))
    .setColor(RPG_COLORS.team)
    .addFields(
      { name: `${icon('star')} ${m.rpg_guild_field_level({}, { locale })}`, value: m.rpg_profile_level_value({ level: view.level }, { locale }), inline: true },
      { name: `${icon('rpgClan')} ${m.rpg_guild_field_members({}, { locale })}`, value: m.rpg_guilds_occupancy({ members: view.memberCount, capacity: view.capacity }, { locale }), inline: true },
      { name: `${icon('rpgGuild')} ${m.rpg_guilds_field_leader({}, { locale })}`, value: `<@${view.ownerId}>`, inline: true },
      { name: `${icon('rpgXp')} ${m.rpg_guild_field_xp({}, { locale })}`, value: `${view.xp} / ${view.xpNeeded} XP\n${gaugeBar(view.xp, view.xpNeeded, 'xp')}`, inline: false },
      {
        name: `🏘️ ${m.rpg_village_title({}, { locale })}`,
        value: view.builtCount > 0
          ? `${m.rpg_guilds_buildings({ count: view.builtCount }, { locale })}\n${villagePerkLine(view.perks, locale)}`
          : m.rpg_guilds_no_building({}, { locale }),
        inline: false,
      },
    );

  if (view.treasury !== null) {
    embed.addFields({
      name: `${icon('coins')} ${m.rpg_guild_field_treasury({}, { locale })}`,
      value: m.rpg_guild_treasury_value({ amount: view.treasury }, { locale }),
      inline: true,
    });
  }

  const roster = joinFieldEntries(
    view.members.map((member) => `<@${member.userId}> (${member.level})`),
    { separator: ', ', more: (count) => m.rpg_guild_members_more({ count }, { locale }) },
  );
  if (roster) {
    embed.addFields({ name: m.rpg_guilds_field_roster({}, { locale }), value: roster, inline: false });
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:guilds`)
      .setLabel(m.rpg_guilds_btn_directory({}, { locale }))
      .setEmoji(icon('rpgGuild'))
      .setStyle(ButtonStyle.Secondary),
  );

  // Rejoindre depuis la fiche : c'est l'écran où l'on vient de décider, et le seul où
  // l'on sait déjà ce qu'on rejoint.
  if (view.canJoin) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`rpg:guildjoinid:${ownerId}:${view.id}`)
        .setLabel(m.rpg_hub_guild_btn_join({}, { locale }))
        .setEmoji(icon('rpgClan'))
        .setStyle(ButtonStyle.Success),
    );
  } else if (view.isMine) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`rpg:nav:${ownerId}:guild`)
        .setLabel(m.rpg_hub_btn_guild({}, { locale }))
        .setEmoji(icon('rpgGuild'))
        .setStyle(ButtonStyle.Primary),
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:hub`)
      .setLabel(m.rpg_hub_btn_back({}, { locale }))
      .setEmoji(icon('rpgBack'))
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

async function handleGuildProfileSelect(interaction: StringSelectMenuInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  await respond(interaction, await buildGuildProfileView(guildId, ownerId, interaction.values[0], locale));
}

/** Rejoindre depuis la fiche : l'identifiant vient du bouton, pas d'une saisie de nom. */
async function handleGuildJoinById(interaction: ButtonInteraction, guildId: string, ownerId: string, locale: Locale, rpgGuildId: string): Promise<void> {
  const joined = await joinRpgGuild(guildId, ownerId, rpgGuildId);

  const view = await buildGuildView(guildId, ownerId, locale, await panelMember(interaction, ownerId));
  view.embeds[0]?.setFooter({ text: m.rpg_guild_joined({ name: joined.name }, { locale }) });
  await respond(interaction, view);
}

/**
 * Fenêtre d'édition de la fiche de guilde.
 *
 * Les champs sont pré-remplis avec l'existant : sans ça, ne vouloir changer que
 * l'étendard obligerait à retaper le nom et la description à l'identique.
 */
function buildGuildEditModal(ownerId: string, locale: Locale, current: { name: string; description: string | null; emoji: string }): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`rpg:guildeditsubmit:${ownerId}`)
    .setTitle(m.rpg_guild_edit_modal_title({}, { locale }));

  const nameInput = new TextInputBuilder()
    .setCustomId('nom')
    .setLabel(m.rpg_guild_edit_field_name({}, { locale }))
    .setStyle(TextInputStyle.Short)
    .setMinLength(RPG_GUILD_NAME_MIN)
    .setMaxLength(RPG_GUILD_NAME_MAX)
    .setValue(current.name)
    .setRequired(true);

  const emojiInput = new TextInputBuilder()
    .setCustomId('embleme')
    .setLabel(m.rpg_guild_edit_field_emoji({}, { locale }))
    .setStyle(TextInputStyle.Short)
    .setMaxLength(16)
    .setValue(current.emoji)
    .setRequired(false);

  const descriptionInput = new TextInputBuilder()
    .setCustomId('description')
    .setLabel(m.rpg_guild_edit_field_description({}, { locale }))
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(RPG_GUILD_DESCRIPTION_MAX)
    .setValue(current.description ?? '')
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(emojiInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(descriptionInput),
  );

  return modal;
}

async function handleGuildEditOpen(interaction: ButtonInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const profile = await getOrCreateRpgProfile(guildId, ownerId);
  if (!profile.rpgGuildId) {
    await replyPanelError(interaction, new Error(m.rpg_guild_edit_no_guild({}, { locale })), locale);
    return;
  }

  const rpgGuild = await prisma.rpgGuild.findUnique({ where: { id: profile.rpgGuildId } });
  if (!rpgGuild) {
    await replyPanelError(interaction, new Error(m.rpg_guilds_not_found({}, { locale })), locale);
    return;
  }
  // Le refus arrive avant la fenêtre : la laisser s'ouvrir pour rejeter la saisie
  // ensuite ferait retaper trois champs pour rien.
  if (rpgGuild.ownerId !== ownerId) {
    await replyPanelError(interaction, new Error(m.rpg_guild_edit_leader_only({}, { locale })), locale);
    return;
  }

  await interaction.showModal(buildGuildEditModal(ownerId, locale, rpgGuild));
}

async function handleGuildEditSubmit(interaction: ModalSubmitInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const updated = await editRpgGuild(guildId, ownerId, {
    name: interaction.fields.getTextInputValue('nom'),
    emoji: interaction.fields.getTextInputValue('embleme'),
    description: interaction.fields.getTextInputValue('description'),
  });

  const view = await buildGuildView(guildId, ownerId, locale, await panelMember(interaction, ownerId));
  view.embeds[0]?.setFooter({ text: m.rpg_guild_edit_done({ emoji: updated.emoji, name: updated.name }, { locale }) });
  await respond(interaction, view);
}

// ─────────────────────────────────────────────────────────────
// Guerre de clans
// ─────────────────────────────────────────────────────────────

/** Une ligne du tableau de guerre. Le podium porte sa médaille. */
function warStandingLine(
  team: ClanWarState['standings'][number],
  rank: number,
  isViewerTeam: boolean,
  mode: ClanWarState['mode'],
  locale: Locale,
): string {
  const medal = rank === 1 ? icon('rank1') : rank === 2 ? icon('rank2') : rank === 3 ? icon('rank3') : `**#${rank}**`;
  const name = isViewerTeam ? `__${truncate(team.name, 60)}__` : truncate(team.name, 60);
  const score = mode === 'RPG_GUILD'
    ? m.rpg_war_line_guild({ level: team.level ?? 1, members: team.members }, { locale })
    : m.rpg_war_line_clan({ points: team.points, members: team.members }, { locale });

  return `${medal} ${name} - ${score}`;
}

/**
 * Tableau de guerre : ce que le RPG rapporte à chaque équipe du serveur.
 *
 * Les monstres, les boss, les quêtes et le raid versaient déjà des points aux
 * clans, mais le jeu ne les montrait nulle part : on jouait pour un classement
 * qu'on ne pouvait consulter qu'ailleurs. L'écran rend cet effort visible depuis
 * le hub, et donne à la guilde RPG la contrepartie collective qui lui manquait.
 */
async function buildClanWarView(
  guildId: string,
  ownerId: string,
  member: GuildMember | null,
  locale: Locale,
  scope: ClanWarScope = 'season',
): Promise<PanelView> {
  const war = await getClanWarState({ guildId, userId: ownerId, member, scope });

  if (war.closure) {
    const reason = war.closure === 'CLANS_OFF'
      ? m.rpg_war_closed_clans({}, { locale })
      : war.closure === 'BRIDGE_OFF'
        ? m.rpg_war_closed_bridge({}, { locale })
        : m.rpg_war_closed_guilds({}, { locale });
    return {
      embeds: [errorEmbed(m.rpg_war_title({}, { locale }), reason)],
      components: [backRow(ownerId, locale)],
    };
  }

  const embed = new EmbedBuilder()
    .setTitle(`${icon('rpgWar')} ${m.rpg_war_title({}, { locale })}`)
    .setColor(RPG_COLORS.team)
    .setDescription(war.mode === 'RPG_GUILD'
      ? m.rpg_war_desc_guild({}, { locale })
      : m.rpg_war_desc_clan({ season: war.season, scope: scope === 'week' ? m.rpg_war_scope_week({}, { locale }) : m.rpg_war_scope_season({}, { locale }) }, { locale }));

  const standings = war.standings.map((team, index) =>
    warStandingLine(team, index + 1, team.key === war.viewer.teamKey, war.mode, locale));

  embed.addFields({
    name: m.rpg_war_field_standings({}, { locale }),
    value: standings.length > 0 ? standings.join('\n') : m.rpg_war_empty({}, { locale }),
  });

  if (war.viewer.teamKey) {
    // L'écart avec la tête est la seule information qui dise s'il reste quelque
    // chose à jouer : un rang seul ne dit pas si le retard est d'une soirée ou
    // d'une saison.
    const leader = war.standings[0];
    const own = war.standings.find((team) => team.key === war.viewer.teamKey);
    const gap = leader && own && leader.key !== own.key ? leader.points - own.points : 0;

    embed.addFields({
      name: m.rpg_war_field_you({}, { locale }),
      value: [
        // En mode guilde, `points` porte le niveau du joueur et non des points
        // marqués : la même phrase y serait un contresens.
        war.mode === 'RPG_GUILD'
          ? m.rpg_war_you_line_guild({
            team: truncate(war.viewer.teamName ?? '', 60),
            rank: war.viewer.rank ?? 0,
            level: war.viewer.points,
          }, { locale })
          : m.rpg_war_you_line({
            team: truncate(war.viewer.teamName ?? '', 60),
            rank: war.viewer.rank ?? 0,
            points: war.viewer.points,
          }, { locale }),
        war.mode === 'RPG_GUILD'
          ? ''
          : gap > 0
            ? m.rpg_war_gap({ points: gap }, { locale })
            : m.rpg_war_leading({}, { locale }),
      ].filter(Boolean).join('\n'),
      inline: false,
    });

    if (war.topContributors.length > 0) {
      embed.addFields({
        name: m.rpg_war_field_top({}, { locale }),
        value: war.topContributors
          .map((entry, index) => m.rpg_war_top_line({ rank: index + 1, id: entry.userId, points: entry.points }, { locale }))
          .join('\n'),
        inline: false,
      });
    }
  } else {
    embed.addFields({ name: m.rpg_war_field_you({}, { locale }), value: m.rpg_war_no_team({}, { locale }) });
  }

  const components: PanelRow[] = [];

  // La portée ne se règle qu'en mode clan : une guilde RPG n'a pas d'historique
  // daté à découper en semaines, et le menu ne changerait rien à l'écran.
  if (war.mode === 'CLAN') {
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`rpg:warscope:${ownerId}`)
        .setPlaceholder(m.rpg_war_scope_placeholder({}, { locale }))
        .addOptions([
          {
            label: truncate(m.rpg_war_scope_season({}, { locale }), 100),
            value: 'season',
            emoji: optionEmoji(icon('trophy')),
            default: scope === 'season',
          },
          {
            label: truncate(m.rpg_war_scope_week({}, { locale }), 100),
            value: 'week',
            emoji: optionEmoji(icon('calendar')),
            default: scope === 'week',
          },
        ]),
    ));
  }

  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:clanwar:${scope}`)
      .setLabel(m.rpg_war_btn_refresh({}, { locale }))
      .setEmoji(icon('rpgRefresh'))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:guild`)
      .setLabel(m.rpg_hub_btn_guild({}, { locale }))
      .setEmoji(icon('rpgGuild'))
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:hub`)
      .setLabel(m.rpg_hub_btn_back({}, { locale }))
      .setEmoji(icon('rpgBack'))
      .setStyle(ButtonStyle.Secondary),
  ));

  return { embeds: [embed], components };
}

/** Changement de fenêtre observée depuis le menu du tableau de guerre. */
async function handleWarScopeSelect(
  interaction: StringSelectMenuInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
): Promise<void> {
  const member = await panelMember(interaction, ownerId);
  const view = await buildClanWarView(guildId, ownerId, member, locale, asClanWarScope(interaction.values[0]));
  await respond(interaction, view);
}

function buildGuildLeaveConfirmView(ownerId: string, locale: Locale): PanelView {
  const embed = new EmbedBuilder()
    .setTitle(m.rpg_hub_guild_leave_confirm_title({}, { locale }))
    .setDescription(m.rpg_hub_guild_leave_confirm_desc({}, { locale }))
    .setColor(COLORS.warning);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rpg:guildleaveyes:${ownerId}`).setLabel(m.rpg_hub_guild_leave_confirm_yes({}, { locale })).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`rpg:guildleaveno:${ownerId}`).setLabel(m.rpg_hub_guild_leave_confirm_no({}, { locale })).setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

async function handleGuildLeaveConfirm(interaction: ButtonInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  await leaveRpgGuild(guildId, ownerId);
  const view = await buildGuildView(guildId, ownerId, locale, await panelMember(interaction, ownerId));
  await respond(interaction, view);
}

function buildGuildCreateModal(ownerId: string, locale: Locale): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(`rpg:guildcreatesubmit:${ownerId}`).setTitle(m.rpg_hub_guild_create_modal_title({}, { locale }));
  const nameInput = new TextInputBuilder().setCustomId('nom').setLabel(m.rpg_hub_guild_field_name({}, { locale })).setStyle(TextInputStyle.Short).setMaxLength(32).setRequired(true);
  const descInput = new TextInputBuilder().setCustomId('description').setLabel(m.rpg_hub_guild_field_desc({}, { locale })).setStyle(TextInputStyle.Paragraph).setMaxLength(256).setRequired(false);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(descInput),
  );
  return modal;
}

function buildGuildJoinModal(ownerId: string, locale: Locale): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(`rpg:guildjoinsubmit:${ownerId}`).setTitle(m.rpg_hub_guild_join_modal_title({}, { locale }));
  const nameInput = new TextInputBuilder().setCustomId('nom').setLabel(m.rpg_hub_guild_field_name({}, { locale })).setStyle(TextInputStyle.Short).setRequired(true);
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput));
  return modal;
}

function buildGuildDepositModal(ownerId: string, locale: Locale): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(`rpg:guilddepositsubmit:${ownerId}`).setTitle(m.rpg_hub_guild_deposit_modal_title({}, { locale }));
  const amountInput = new TextInputBuilder().setCustomId('montant').setLabel(m.rpg_hub_guild_field_amount({}, { locale })).setStyle(TextInputStyle.Short).setRequired(true);
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(amountInput));
  return modal;
}

async function handleGuildCreateSubmit(interaction: ModalSubmitInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const name = interaction.fields.getTextInputValue('nom');
  const description = interaction.fields.getTextInputValue('description') || undefined;
  await createRpgGuild(guildId, ownerId, name, description);
  const view = await buildGuildView(guildId, ownerId, locale, await panelMember(interaction, ownerId));
  await respond(interaction, view);
}

async function handleGuildJoinSubmit(interaction: ModalSubmitInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const name = interaction.fields.getTextInputValue('nom');
  const targetGuild = await findRpgGuildByName(guildId, name);
  if (!targetGuild) {
    await replyPanelError(interaction, new Error(m.rpg_guild_not_found_desc({}, { locale })), locale);
    return;
  }
  await joinRpgGuild(guildId, ownerId, targetGuild.id);
  const view = await buildGuildView(guildId, ownerId, locale, await panelMember(interaction, ownerId));
  await respond(interaction, view);
}

async function handleGuildDepositSubmit(interaction: ModalSubmitInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const amount = Number.parseInt(interaction.fields.getTextInputValue('montant'), 10);
  if (!Number.isFinite(amount) || amount <= 0) {
    await replyPanelError(interaction, new Error(m.rpg_hub_invalid_amount({}, { locale })), locale);
    return;
  }
  const deposit = await depositToRpgGuildTreasury(guildId, ownerId, amount);
  const view = await buildGuildView(guildId, ownerId, locale, await panelMember(interaction, ownerId));
  view.embeds[0]?.setFooter({
    text: deposit.levelUp
      ? m.rpg_guild_deposit_levelup_desc({ level: deposit.levelUp }, { locale })
      : m.rpg_guild_deposit_desc({ amount: deposit.amount }, { locale }),
  });
  await respond(interaction, view);
}

// ─────────────────────────────────────────────────────────────
// Voyage
// ─────────────────────────────────────────────────────────────

function getTravelDestinations(locale: Locale): { name: string; time: number; label: string }[] {
  return [
    { name: 'Forêt Mystique', time: 5, label: m.rpg_travel_dest_forest_label({}, { locale }) },
    { name: 'Montagnes du Destin', time: 15, label: m.rpg_travel_dest_mountains_label({}, { locale }) },
    { name: 'Marécage Maudit', time: 30, label: m.rpg_travel_dest_swamp_label({}, { locale }) },
  ];
}

async function buildTravelView(guildId: string, ownerId: string, locale: Locale): Promise<PanelView> {
  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.rpgEnabled) {
    const embed = errorEmbed(m.rpg_travel_disabled_title({}, { locale }), m.rpg_travel_disabled_desc({}, { locale }));
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  const profile = await getOrCreateRpgProfile(guildId, ownerId);

  if (profile.isTraveling) {
    const status = await resolveTravel(guildId, ownerId);

    if (!status.complete) {
      const embed = errorEmbed(m.rpg_travel_in_progress_title({}, { locale }), m.rpg_travel_in_progress_desc({ dest: profile.travelDestination ?? '', minutes: status.remainingMinutes ?? 0 }, { locale }));
      return { embeds: [embed], components: [backRow(ownerId, locale)] };
    }

    if (status.noEvent) {
      const embed = successEmbed(m.rpg_travel_done_title({}, { locale }), m.rpg_travel_done_desc({}, { locale }));
      return { embeds: [embed], components: [backRow(ownerId, locale)] };
    }

    const event = status.event!;
    const choices = (event.choices ?? []) as Array<{ text: string; minLevel?: number }>;

    const embed = new EmbedBuilder()
      .setTitle(m.rpg_travel_event_title({ emoji: event.emoji, title: event.title }, { locale }))
      .setDescription(event.description)
      .setColor(RPG_COLORS.wild)
      .setFooter({ text: m.rpg_travel_choose_action({}, { locale }) });

    const row = new ActionRowBuilder<ButtonBuilder>();
    choices.forEach((choice, idx) => {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`rpg:choice:${ownerId}:${event.id}:${idx}`)
          .setLabel(choice.text.substring(0, 80))
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(Boolean(choice.minLevel && profile.level < choice.minLevel)),
      );
    });

    return { embeds: [embed], components: [row, backRow(ownerId, locale)] };
  }

  const destinations = getTravelDestinations(locale);
  const embed = new EmbedBuilder()
    .setTitle(m.rpg_travel_start_title({}, { locale }))
    .setDescription(m.rpg_travel_start_desc({}, { locale }))
    .setColor(RPG_COLORS.wild)
    .addFields({ name: m.rpg_travel_field_energy_now({}, { locale }), value: `${profile.energy} / ${config.maxEnergy}` });

  const row = new ActionRowBuilder<ButtonBuilder>();
  destinations.forEach((dest, idx) => {
    row.addComponents(
      new ButtonBuilder().setCustomId(`rpg:dest:${ownerId}:${idx}`).setLabel(dest.label).setStyle(ButtonStyle.Primary),
    );
  });

  const drinkRow = profile.energy < ADVENTURE_ENERGY_COST
    ? await quickDrinkRow(guildId, ownerId, locale, 'travel', 'energy')
    : null;
  return { embeds: [embed], components: drinkRow ? [row, drinkRow, backRow(ownerId, locale)] : [row, backRow(ownerId, locale)] };
}

async function handleTravelDestinationChoice(interaction: ButtonInteraction, guildId: string, ownerId: string, locale: Locale, idxRaw: string): Promise<void> {
  const idx = Number.parseInt(idxRaw, 10);
  const dest = getTravelDestinations(locale)[idx];
  if (!dest) return;

  const profile = await getOrCreateRpgProfile(guildId, ownerId);
  if (!profile.isTraveling && profile.health <= 0) {
    await replyVitalsAlert(interaction, guildId, ownerId, locale, errorEmbed(m.rpg_travel_low_hp_title({}, { locale }), m.rpg_travel_low_hp_desc({}, { locale })), 'hp');
    return;
  }
  if (!profile.isTraveling && profile.energy < ADVENTURE_ENERGY_COST) {
    await replyVitalsAlert(interaction, guildId, ownerId, locale, errorEmbed(m.rpg_travel_energy_insufficient_title({}, { locale }), m.rpg_travel_low_energy_desc({ cost: ADVENTURE_ENERGY_COST, energy: profile.energy }, { locale })), 'energy');
    return;
  }

  await startTravel(guildId, ownerId, dest.name, dest.time);
  const embed = successEmbed(m.rpg_travel_bon_voyage_title({}, { locale }), m.rpg_travel_bon_voyage_desc({ dest: dest.name, time: dest.time }, { locale }));
  await respond(interaction, { embeds: [embed], components: [backRow(ownerId, locale)] });
}

async function handleTravelEventChoice(interaction: ButtonInteraction, guildId: string, ownerId: string, locale: Locale, eventId: string, idxRaw: string): Promise<void> {
  const idx = Number.parseInt(idxRaw, 10);
  const event = await prisma.rpgAdventureEvent.findUnique({ where: { id: eventId } });
  const resolution = await chooseAdventureOutcome(guildId, ownerId, eventId, idx);
  await trackQuest(interaction.client, guildId, ownerId, 'ADVENTURES_COMPLETED');

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_travel_resolution_title({ emoji: event?.emoji ?? '🌲', title: event?.title ?? '' }, { locale }))
    .setDescription(m.rpg_travel_resolution_desc({ choice: resolution.choiceText ?? '', critical: resolution.criticalMessage || '' }, { locale }))
    .addFields(
      { name: m.rpg_travel_field_hp_effect({}, { locale }), value: `${resolution.hpEffect >= 0 ? '+' : ''}${resolution.hpEffect} PV`, inline: true },
      { name: m.rpg_travel_field_coin_effect({}, { locale }), value: `${resolution.coinEffect >= 0 ? '+' : ''}${resolution.coinEffect} 🪙`, inline: true },
      { name: m.rpg_travel_field_xp({}, { locale }), value: `+${resolution.xpEffect} XP`, inline: true },
    )
    .setColor(resolution.hpEffect < 0 ? COLORS.danger : COLORS.success);

  if (resolution.titleName) {
    embed.addFields({
      name: m.rpg_title_obtained_field({}, { locale }),
      value: m.rpg_title_obtained_value({ title: resolution.titleName }, { locale }),
    });
  }
  if (resolution.levelUp) {
    embed.addFields({ name: m.rpg_travel_field_levelup({}, { locale }), value: m.rpg_travel_levelup_value({ level: Number(resolution.levelUp) }, { locale }) });
  }

  await respond(interaction, { embeds: [embed], components: [backRow(ownerId, locale)] });
}

// ─────────────────────────────────────────────────────────────
// Daily & Pêche (actions instantanées)
// ─────────────────────────────────────────────────────────────

/**
 * Ligne de série affichée sous la récompense journalière, ici comme dans `/daily`. Le bonus
 * n'y est pas chiffré : le joueur sait que sa série paie, le barème reste en coulisses.
 */
export function dailyStreakLine(streak: number, locale: Locale): string {
  return streak <= 1
    ? m.rpg_daily_streak_start({}, { locale })
    : m.rpg_daily_streak_value({ streak }, { locale });
}

async function handleDailyClaim(interaction: ButtonInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const config = await getOrCreateEconomyConfig(guildId);
  const result = await claimDaily(guildId, ownerId);

  if (!result.success) {
    await interaction.reply({
      embeds: [errorEmbed(m.rpg_daily_unavailable_title({}, { locale }), m.rpg_daily_unavailable_desc({ hours: result.remainingHours ?? 0, minutes: result.remainingMinutes ?? 0 }, { locale }))],
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  await trackQuest(interaction.client, guildId, ownerId, 'DAILY_CLAIMS');

  const embed = successEmbed(m.rpg_daily_title({}, { locale }), m.rpg_daily_desc({ reward: result.reward ?? 0, emoji: config.currencyEmoji, currency: config.currencyName }, { locale }))
    .addFields(
      { name: m.rpg_daily_new_balance({}, { locale }), value: `**${result.newBalance}** ${config.currencyEmoji}` },
      { name: m.rpg_daily_streak_name({}, { locale }), value: dailyStreakLine(result.streak ?? 1, locale) },
    );

  await respond(interaction, { embeds: [embed], components: [backRow(ownerId, locale)] });
}

async function handleFishClaim(interaction: ButtonInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const config = await getOrCreateEconomyConfig(guildId);
  const result = await fish(guildId, ownerId);

  if (!result.success) {
    if ('noFish' in result && result.noFish) {
      await interaction.reply({ embeds: [errorEmbed(m.rpg_fish_empty_title({}, { locale }), m.rpg_fish_empty_desc({}, { locale }))], flags: [MessageFlags.Ephemeral] });
      return;
    }
    if (!result.cooldown) {
      await replyVitalsAlert(interaction, guildId, ownerId, locale, errorEmbed(m.rpg_fish_no_energy_title({}, { locale }), m.rpg_fish_no_energy_desc({}, { locale })), 'energy');
      return;
    }
    const embed = errorEmbed(m.rpg_fish_cooldown_title({}, { locale }), m.rpg_fish_cooldown_desc({ min: result.remainingMin ?? 0, sec: result.remainingSec ?? 0 }, { locale }));
    await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
    return;
  }

  await trackQuest(interaction.client, guildId, ownerId, 'FISH_CAUGHT');

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_fish_title({}, { locale }))
    .setDescription(m.rpg_fish_desc({ emoji: result.fish.emoji, name: result.fish.name, rarityIcon: result.rarityIcon, rarity: fishRarityLabel(result.fish.rarity, locale) }, { locale }))
    .setColor(
      result.fish.rarity === 'LEGENDARY' ? 0xffd700 :
        result.fish.rarity === 'EPIC' ? 0x9b59b6 :
          result.fish.rarity === 'RARE' ? 0x3498db :
            result.fish.rarity === 'UNCOMMON' ? 0x2ecc71 :
              COLORS.primary,
    )
    .addFields(
      { name: m.rpg_fish_field_value({ emoji: config.currencyEmoji }, { locale }), value: m.rpg_fish_field_value_value({ value: result.fish.value, currency: config.currencyName }, { locale }), inline: true },
      { name: m.rpg_fish_field_xp({}, { locale }), value: `**+${result.fish.xp}**`, inline: true },
      { name: m.rpg_fish_field_total({}, { locale }), value: m.rpg_fish_field_total_value({ count: result.totalFishCaught }, { locale }), inline: true },
    );
  embed.addFields({ name: m.rpg_fish_field_next({}, { locale }), value: `<t:${Math.floor(result.nextFishAt.getTime() / 1000)}:R>`, inline: false });
  if (result.newSpecies) embed.setFooter({ text: m.rpg_fish_new_species({}, { locale }) });

  // Seule une nouvelle espèce peut terminer un palier : les autres prises s'épargnent la lecture.
  // Le versement peut enchaîner plusieurs paliers et un rôle : on acquitte d'abord, Discord
  // n'attend que trois secondes.
  if (result.newSpecies) {
    await interaction.deferUpdate();
    const { payouts } = await claimFishBookRewards(interaction.client, guildId, ownerId).catch((err) => {
      logger.error('RpgPanel', `Récompenses du carnet non versées pour ${ownerId} :`, err);
      return { payouts: [] as FishBookPayout[] };
    });
    for (const payout of payouts) {
      embed.addFields({ name: fishBookTierDoneLabel(payout.tier, locale), value: formatFishBookPayout(payout, config.currencyEmoji, locale), inline: false });
    }
  }

  // Pas de bouton « Pêcher » ici : la ligne vient de servir et reste au repos cinq minutes.
  await respond(interaction, { embeds: [embed], components: [fishBookRow(ownerId, locale, { fish: false, book: true })] });
}

function fishRarityLabel(rarity: string, locale: Locale): string {
  switch (rarity) {
    case 'COMMON': return m.rpg_fish_rarity_common({}, { locale });
    case 'UNCOMMON': return m.rpg_fish_rarity_uncommon({}, { locale });
    case 'RARE': return m.rpg_fish_rarity_rare({}, { locale });
    case 'EPIC': return m.rpg_fish_rarity_epic({}, { locale });
    case 'LEGENDARY': return m.rpg_fish_rarity_legendary({}, { locale });
    default: return rarity;
  }
}

function fishBookRow(ownerId: string, locale: Locale, show: { fish: boolean; book: boolean }): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (show.fish) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`rpg:fish:${ownerId}`).setLabel(m.rpg_hub_btn_fish({}, { locale })).setEmoji(icon('rpgFish')).setStyle(ButtonStyle.Success),
    );
  }
  if (show.book) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`rpg:nav:${ownerId}:fishbook`).setLabel(m.rpg_hub_btn_fishbook({}, { locale })).setEmoji(icon('rpgBestiary')).setStyle(ButtonStyle.Primary),
    );
  }
  row.addComponents(
    new ButtonBuilder().setCustomId(`rpg:nav:${ownerId}:hub`).setLabel(m.rpg_hub_btn_back({}, { locale })).setEmoji(icon('rpgBack')).setStyle(ButtonStyle.Secondary),
  );
  return row;
}

function fishBookTierLabel(tier: FishBookTier, locale: Locale): string {
  return tier === 'COMPLETE' ? m.rpg_fishbook_tier_complete({}, { locale }) : fishRarityLabel(tier, locale);
}

function fishBookTierDoneLabel(tier: FishBookTier, locale: Locale): string {
  return tier === 'COMPLETE'
    ? m.rpg_fishbook_done_complete({}, { locale })
    : m.rpg_fishbook_done_rarity({ rarity: fishRarityLabel(tier, locale) }, { locale });
}

function formatFishBookReward(
  reward: { coinReward: number; xpReward: number; clanPoints: number; itemName: string | null; roleId: string | null; titleName: string | null },
  currencyEmoji: string,
  locale: Locale,
): string {
  const parts = [
    reward.coinReward > 0 ? `${currencyEmoji} +${reward.coinReward}` : null,
    reward.xpReward > 0 ? `${icon('rpgXp')} +${reward.xpReward} XP` : null,
    reward.clanPoints > 0 ? `${icon('rpgClan')} +${reward.clanPoints}` : null,
    reward.itemName ? `📦 ${reward.itemName}` : null,
    reward.titleName ? `🏅 ${reward.titleName}` : null,
    reward.roleId ? `<@&${reward.roleId}>` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' · ') : m.rpg_fishbook_no_reward({}, { locale });
}

function formatFishBookPayout(payout: FishBookPayout, currencyEmoji: string, locale: Locale): string {
  return formatFishBookReward({
    coinReward: payout.coins,
    xpReward: payout.xp,
    // Seuls les points réellement encaissés : un joueur sans clan ni guilde n'a rien reçu.
    clanPoints: payout.teamPoints,
    itemName: payout.itemName ? `${payout.itemEmoji ?? ''} ${payout.itemName}`.trim() : null,
    roleId: payout.roleId,
    titleName: payout.titleName,
  }, currencyEmoji, locale);
}

/**
 * Carnet de pêche : chaque espèce du catalogue, rangée par rareté, avec la récompense de
 * chaque série et celle du carnet complet.
 *
 * Les espèces jamais attrapées restent listées sans leur nom, comme les créatures du
 * bestiaire : voir ce qui manque est ce qui donne envie de relancer sa ligne. L'ouverture
 * verse aussi les paliers terminés avant que les récompenses n'existent.
 */
const FISH_BOOK_FIELD_MAX = 520;

async function buildFishBookView(client: Client, guildId: string, ownerId: string, locale: Locale): Promise<PanelView> {
  const { book, payouts } = await claimFishBookRewards(client, guildId, ownerId);
  const [rewards, claimed, config, profile] = await Promise.all([
    getFishBookRewards(guildId),
    listFishBookClaims(guildId, ownerId),
    getOrCreateEconomyConfig(guildId),
    getOrCreateRpgProfile(guildId, ownerId),
  ]);
  const rewardByTier = new Map(rewards.map((reward) => [reward.tier, reward]));
  const progress = new Map(fishBookProgress(book).map((tier) => [tier.tier, tier]));

  const rewardLine = (tier: FishBookTier): string => {
    const reward = rewardByTier.get(tier);
    const status = claimed.has(tier) ? `${icon('success')} ${m.rpg_fishbook_reward_claimed({}, { locale })}` : `🎁 ${m.rpg_fishbook_reward_pending({}, { locale })}`;
    return `-# ${status} : ${reward ? formatFishBookReward(reward, config.currencyEmoji, locale) : m.rpg_fishbook_no_reward({}, { locale })}`;
  };

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_fishbook_title({}, { locale }))
    .setDescription(m.rpg_fishbook_desc({ discovered: book.discovered, total: book.total, caught: book.totalCaught }, { locale }))
    .setColor(RPG_COLORS.wild);

  const rarities = [...new Set(book.entries.map((entry) => entry.rarity))];
  for (const rarity of rarities) {
    const tier = progress.get(rarity as FishBookTier);
    const lines = book.entries
      .filter((entry) => entry.rarity === rarity)
      .map((entry) => (entry.caught > 0
        ? `${entry.emoji} **${entry.name}** ×${entry.caught}`
        : `❔ ${m.rpg_fishbook_unknown({}, { locale })}`));
    const footer = tier ? `\n${rewardLine(tier.tier)}` : '';
    const count = tier ? ` · ${tier.caught}/${tier.total}` : '';
    embed.addFields({
      name: `${RARITY_COLORS[rarity] ?? '⬜'} ${fishRarityLabel(rarity, locale)}${count}`,
      value: joinFieldEntries(lines, {
        more: (hidden) => m.rpg_itembook_detail_more({ count: hidden }, { locale }),
        // Chaque champ devient un bloc de texte Components V2, et Discord refuse un message
        // au-delà de 4000 caractères au total : cinq séries pleines doivent tenir ensemble.
        max: FISH_BOOK_FIELD_MAX - footer.length,
      }) + footer,
      inline: true,
    });
  }

  const complete = progress.get('COMPLETE');
  if (complete) {
    embed.addFields({
      name: `🏆 ${fishBookTierLabel('COMPLETE', locale)} · ${complete.caught}/${complete.total}`,
      value: rewardLine('COMPLETE'),
      inline: false,
    });
  }

  for (const payout of payouts) {
    embed.addFields({ name: fishBookTierDoneLabel(payout.tier, locale), value: formatFishBookPayout(payout, config.currencyEmoji, locale), inline: false });
  }

  const canFish = !profile.lastFish || Date.now() - profile.lastFish.getTime() >= FISH_COOLDOWN_MS;
  return { embeds: [embed], components: [fishBookRow(ownerId, locale, { fish: canFish, book: false })] };
}

// ─────────────────────────────────────────────────────────────
// Bestiaire
// ─────────────────────────────────────────────────────────────

/** Créatures par page. Une section chacune : au-delà, le conteneur devient illisible. */
const BESTIARY_PAGE_SIZE = 6;

type BestiaryFilter = 'all' | 'discovered' | 'unknown' | 'boss';

const BESTIARY_FILTERS: BestiaryFilter[] = ['all', 'discovered', 'unknown', 'boss'];

type BestiaryState = { filter: BestiaryFilter; page: number };

function parseBestiaryState(rest: string[]): BestiaryState {
  const filter = BESTIARY_FILTERS.includes(rest[0] as BestiaryFilter) ? (rest[0] as BestiaryFilter) : 'all';
  const page = Math.max(0, Number.parseInt(rest[1] ?? '0', 10) || 0);
  return { filter, page };
}

function bestiaryFilterLabel(filter: BestiaryFilter, locale: Locale): string {
  switch (filter) {
    case 'discovered': return m.rpg_bestiary_filter_discovered({}, { locale });
    case 'unknown': return m.rpg_bestiary_filter_unknown({}, { locale });
    case 'boss': return m.rpg_bestiary_filter_boss({}, { locale });
    default: return m.rpg_bestiary_filter_all({}, { locale });
  }
}

/** Ligne d'une créature : sa fiche technique, et le bilan du joueur face à elle. */
function bestiaryLine(entry: BestiaryEntry, locale: Locale): string {
  const { monster, record } = entry;

  if (!entry.discovered) {
    // Une créature jamais affrontée ne dévoile que son niveau : le reste se mérite.
    return `${monster.isBoss ? icon('rpgBoss') : '❔'} **${m.rpg_bestiary_unknown_name({}, { locale })}**\n`
      + `-# ${m.rpg_bestiary_unknown_hint({ level: monster.level }, { locale })}`;
  }

  const bossTag = monster.isBoss ? ` ${m.rpg_bestiary_boss_tag({}, { locale })}` : '';
  const sheet = `${icon('star')} ${monster.level} · ${icon('rpgHp')} ${monster.health} · ${icon('rpgAtk')} ${monster.attack} · ${icon('rpgDef')} ${monster.defense} · ${icon('rpgSpd')} ${monster.speed}`;
  const tally = m.rpg_bestiary_tally({ kills: record.kills, defeats: record.defeats }, { locale });

  return `${monster.emoji} **${monster.name}**${bossTag}\n${sheet}\n-# ${tally}`;
}

/**
 * Suivre ou lâcher la trace d'une créature. `origin` dit quel écran redessiner ensuite :
 * la liste du bestiaire ou la fiche, avec le filtre et la page d'où l'on vient.
 */
function trackButton(
  ownerId: string,
  monsterId: string,
  tracked: boolean,
  origin: 'list' | 'entry',
  state: BestiaryState,
  locale: Locale,
): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(`rpg:${tracked ? 'untrack' : 'track'}:${ownerId}:${monsterId}:${origin}:${state.filter}:${state.page}`)
    .setLabel(tracked ? m.rpg_track_stop_btn({}, { locale }) : m.rpg_track_start_btn({}, { locale }))
    .setStyle(tracked ? ButtonStyle.Secondary : ButtonStyle.Danger);
}

async function setTrackedMonster(guildId: string, userId: string, monsterId: string | null): Promise<void> {
  await prisma.rpgProfile.updateMany({ where: { guildId, userId }, data: { trackedMonsterId: monsterId } });
}

/**
 * Créature traquée, si elle se traque encore. Une cible disparue, désactivée ou devenue boss
 * est oubliée au passage ; une cible passée au-dessus du niveau du joueur, elle, reste : elle
 * redeviendra traquable quand il la rattrapera.
 */
async function loadTrackedMonster(guildId: string, userId: string, trackedMonsterId: string | null, playerLevel: number) {
  if (!trackedMonsterId) return null;
  const monster = await findGuildMonsterById(guildId, trackedMonsterId);
  if (!monster || monster.isBoss) {
    await setTrackedMonster(guildId, userId, null);
    return null;
  }
  // Un monstre global personnalisé depuis a changé de ligne : la cible suit la copie du
  // serveur, pour que le bestiaire la reconnaisse comme traquée.
  if (monster.id !== trackedMonsterId) await setTrackedMonster(guildId, userId, monster.id);
  return canHunt(monster, playerLevel) ? monster : null;
}

async function handleTrackToggle(
  interaction: ButtonInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
  rest: string[],
  track: boolean,
): Promise<void> {
  const [monsterId, origin] = rest;
  const state = parseBestiaryState(rest.slice(2));
  let note = '';

  if (track) {
    const [monster, profile] = await Promise.all([findGuildMonsterById(guildId, monsterId), getOrCreateRpgProfile(guildId, ownerId)]);
    if (!monster || !canHunt(monster, profile.level)) {
      note = m.rpg_hunt_refused_desc({}, { locale });
    } else {
      await setTrackedMonster(guildId, ownerId, monster.id);
      const config = await getOrCreateEconomyConfig(guildId);
      // `formatCooldown` ne descend pas sous la seconde : sans délai de combat, il dirait « 1s ».
      const waitMs = fightCooldownMs(config) + huntCooldownExtraMs(config);
      note = m.rpg_track_started_note({
        name: monster.name,
        energy: huntEnergyCost(FIGHT_ENERGY_COST, config),
        cooldown: waitMs > 0 ? formatCooldown(waitMs) : '0s',
      }, { locale });
    }
  } else {
    await setTrackedMonster(guildId, ownerId, null);
    note = m.rpg_track_stopped_note({}, { locale });
  }

  const view = origin === 'entry'
    ? await buildBestiaryEntryView(guildId, ownerId, monsterId, locale, state)
    : await buildBestiaryView(guildId, ownerId, interaction.user, locale, state);
  await respond(interaction, withNote(view, note));
}

async function buildBestiaryView(
  guildId: string,
  ownerId: string,
  viewer: User,
  locale: Locale,
  state: BestiaryState = { filter: 'all', page: 0 },
): Promise<PanelView> {
  const [overview, profile] = await Promise.all([
    getBestiaryOverview(guildId, ownerId),
    getOrCreateRpgProfile(guildId, ownerId),
  ]);

  const container = new ContainerBuilder().setAccentColor(RPG_COLORS.wild);

  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `## ${icon('rpgBestiary')} ${m.rpg_bestiary_title({ name: viewer.displayName }, { locale })}\n`
    + m.rpg_bestiary_progress({
      discovered: overview.discoveredCount,
      total: overview.totalCount,
    }, { locale }),
  ));

  // Le carnet de chasse : ce que le joueur a fait, pas seulement ce qu'il a vu.
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    m.rpg_bestiary_tracker({
      kills: overview.totalKills,
      defeats: overview.totalDefeats,
      rate: Math.round(overview.winRate * 100),
      bosses: overview.bossesSlain,
    }, { locale }),
  ));

  const filtered = overview.entries.filter((entry) => {
    if (state.filter === 'discovered') return entry.discovered;
    if (state.filter === 'unknown') return !entry.discovered;
    if (state.filter === 'boss') return entry.monster.isBoss;
    return true;
  });

  const pageCount = Math.max(1, Math.ceil(filtered.length / BESTIARY_PAGE_SIZE));
  const page = Math.min(state.page, pageCount - 1);
  const shown = filtered.slice(page * BESTIARY_PAGE_SIZE, page * BESTIARY_PAGE_SIZE + BESTIARY_PAGE_SIZE);

  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `### ${bestiaryFilterLabel(state.filter, locale)} (${filtered.length})`,
  ));

  if (shown.length === 0) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `*${m.rpg_bestiary_empty_desc({}, { locale })}*`,
    ));
  }

  for (const entry of shown) {
    const line = new TextDisplayBuilder().setContent(truncate(bestiaryLine(entry, locale), 600));

    // Une créature inconnue n'a pas de fiche à ouvrir : le bouton mènerait à un écran
    // qui ne dirait rien de plus que la ligne elle-même. On peut en revanche aller la
    // chercher, si elle n'est pas au-dessus du niveau du joueur.
    if (!entry.discovered) {
      if (canHunt(entry.monster, profile.level)) {
        const tracked = profile.trackedMonsterId === entry.monster.id;
        container.addSectionComponents(
          new SectionBuilder()
            .addTextDisplayComponents(line)
            .setButtonAccessory(trackButton(ownerId, entry.monster.id, tracked, 'list', state, locale)),
        );
      } else {
        container.addTextDisplayComponents(line);
      }
      continue;
    }

    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(line)
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`rpg:bestopen:${ownerId}:${entry.monster.id}:${state.filter}:${page}`)
            .setLabel(m.rpg_bestiary_open_btn({}, { locale }))
            .setStyle(ButtonStyle.Primary),
        ),
    );
  }

  const components: PanelRow[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`rpg:bestfilter:${ownerId}`)
        .setPlaceholder(m.rpg_bestiary_filter_placeholder({}, { locale }))
        .addOptions(BESTIARY_FILTERS.map((filter) => ({
          label: truncate(bestiaryFilterLabel(filter, locale), 100),
          value: filter,
          default: filter === state.filter,
        }))),
    ),
  ];

  const navRow = new ActionRowBuilder<ButtonBuilder>();
  if (pageCount > 1) {
    navRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`rpg:nav:${ownerId}:bestiary:${state.filter}:${page - 1}`)
        .setLabel(m.rpg_shop_prev({}, { locale }))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId(`rpg:noop:${ownerId}`)
        .setLabel(`${page + 1} / ${pageCount}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`rpg:nav:${ownerId}:bestiary:${state.filter}:${page + 1}`)
        .setLabel(m.rpg_shop_next({}, { locale }))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= pageCount - 1),
    );
  }
  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:hub`)
      .setLabel(m.rpg_hub_btn_back({}, { locale }))
      .setEmoji(icon('rpgBack'))
      .setStyle(ButtonStyle.Secondary),
  );
  components.push(navRow);

  return { embeds: [], components, container };
}

// ─────────────────────────────────────────────────────────────
// Catalogue des objets
// ─────────────────────────────────────────────────────────────

/** Objets par page. Chaque fiche porte sa description : au-delà, l'écran déborde. */
const ITEM_BOOK_PAGE_SIZE = 5;

/** Noms de créatures cités par provenance, avant de résumer le reste en « +N ». */
const ITEM_BOOK_NAMES_SHOWN = 3;

type ItemBookState = { category: BagCategory; source: ItemSourceFilter; page: number };

/** `rest` porte la catégorie, la provenance puis la page. */
function parseItemBookState(rest: string[]): ItemBookState {
  const category = BAG_CATEGORIES.includes(rest[0] as BagCategory) ? (rest[0] as BagCategory) : 'all';
  const source = ITEM_SOURCE_FILTERS.includes(rest[1] as ItemSourceFilter) ? (rest[1] as ItemSourceFilter) : 'all';
  const page = Math.max(0, Number.parseInt(rest[2] ?? '0', 10) || 0);
  return { category, source, page };
}

function itemBookNavId(ownerId: string, state: ItemBookState): string {
  return `rpg:nav:${ownerId}:itembook:${state.category}:${state.source}:${state.page}`;
}

function itemSourceLabel(source: ItemSourceFilter, locale: Locale): string {
  switch (source) {
    case 'shop': return m.rpg_itembook_source_shop({}, { locale });
    case 'monster': return m.rpg_itembook_source_monster({}, { locale });
    case 'boss': return m.rpg_itembook_source_boss({}, { locale });
    case 'craft': return m.rpg_itembook_source_craft({}, { locale });
    case 'unique': return m.rpg_itembook_source_unique({}, { locale });
    case 'unavailable': return m.rpg_itembook_source_unavailable({}, { locale });
    default: return m.rpg_itembook_source_all({}, { locale });
  }
}

function shortNameList(names: string[]): string {
  const shown = names.slice(0, ITEM_BOOK_NAMES_SHOWN).join(', ');
  const hidden = names.length - ITEM_BOOK_NAMES_SHOWN;
  return hidden > 0 ? `${shown} +${hidden}` : shown;
}

/** Où obtenir l'objet, en une ligne. */
function itemProvenanceLine(entry: ItemCatalogEntry, currencyEmoji: string, locale: Locale): string {
  const parts = [
    entry.shop ? `${icon('rpgShop')} ${m.rpg_itembook_source_shop({}, { locale })} (${entry.item.price} ${currencyEmoji})` : null,
    entry.monsters.length > 0 ? `${icon('rpgFight')} ${shortNameList(entry.monsters)}` : null,
    entry.bosses.length > 0 ? `${icon('rpgBoss')} ${shortNameList(entry.bosses)}` : null,
    entry.crafted ? `${icon('rpgCraft')} ${m.rpg_itembook_source_craft({}, { locale })}` : null,
    entry.firstKill.length > 0 ? `🏆 ${m.rpg_itembook_first_kill({ names: shortNameList(entry.firstKill) }, { locale })}` : null,
    entry.firstKillClaimed.length > 0 ? `🏅 ${m.rpg_itembook_first_kill_claimed({ names: shortNameList(entry.firstKillClaimed) }, { locale })}` : null,
    entry.campaign ? `${icon('rpgKey')} ${m.rpg_itembook_campaign({}, { locale })}` : null,
  ].filter((part): part is string => part !== null);

  // Un objet qu'aucune source régulière ne donne est marqué comme tel, même s'il se gagne
  // une fois par la campagne ou une prime : on ne peut pas aller le chercher à volonté.
  if (isUniqueItem(entry)) parts.unshift(`✨ **${m.rpg_itembook_source_unique({}, { locale })}**`);
  if (isUnavailableItem(entry)) parts.unshift(`⛔ **${m.rpg_itembook_source_unavailable({}, { locale })}**`);
  return parts.join('  ·  ');
}

function itemBookLine(entry: ItemCatalogEntry, currencyEmoji: string, locale: Locale): string {
  const item = entry.item;
  const stats = itemStatLine(item, locale);
  const meta = `${rarityIcon(item.rarity)} ${shopCategoryLabel(item.type, locale)}`
    + (item.levelRequired > 0 ? ` · ${m.rpg_item_level_required({ level: item.levelRequired }, { locale })}` : '');

  return [
    `${item.emoji} **${item.name}**`,
    `-# ${meta}`,
    item.description ? `*${truncate(item.description, 180)}*` : null,
    stats || null,
    `-# ${itemProvenanceLine(entry, currencyEmoji, locale)}`,
  ].filter((line): line is string => line !== null).join('\n');
}

/**
 * Catalogue de tous les objets du serveur.
 *
 * Tout y est visible d'emblée, sans rien à débloquer : c'est un guide, pas une collection.
 * Chaque fiche dit ce que vaut l'objet et où aller le chercher.
 */
async function buildItemBookView(
  guildId: string,
  ownerId: string,
  locale: Locale,
  state: ItemBookState = { category: 'all', source: 'all', page: 0 },
): Promise<PanelView> {
  const [catalog, config] = await Promise.all([getItemCatalog(guildId), getOrCreateEconomyConfig(guildId)]);

  const TYPE_ORDER: Record<string, number> = { WEAPON: 0, ARMOR: 1, ACCESSORY: 2, POTION: 3, SCROLL: 4, MATERIAL: 5 };
  const filtered = catalog
    .filter((entry) => state.category === 'all' || entry.item.type === state.category)
    .filter((entry) => matchesSourceFilter(entry, state.source))
    .sort((a, b) =>
      (TYPE_ORDER[a.item.type] ?? 9) - (TYPE_ORDER[b.item.type] ?? 9)
      || a.item.levelRequired - b.item.levelRequired
      || a.item.name.localeCompare(b.item.name));

  const pageCount = Math.max(1, Math.ceil(filtered.length / ITEM_BOOK_PAGE_SIZE));
  const page = Math.min(state.page, pageCount - 1);
  const shown = filtered.slice(page * ITEM_BOOK_PAGE_SIZE, page * ITEM_BOOK_PAGE_SIZE + ITEM_BOOK_PAGE_SIZE);

  const container = new ContainerBuilder().setAccentColor(RPG_COLORS.hub);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `## ${icon('rpgBag')} ${m.rpg_itembook_title({}, { locale })}\n${m.rpg_itembook_desc({ count: catalog.length }, { locale })}`,
  ));

  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `### ${bagCategoryLabel(state.category, locale)} · ${itemSourceLabel(state.source, locale)} (${filtered.length})`,
  ));

  if (shown.length === 0) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`*${m.rpg_itembook_empty({}, { locale })}*`));
  }
  for (const entry of shown) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          truncate(itemBookLine(entry, config.currencyEmoji, locale), 900),
        ))
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`rpg:itemopen:${ownerId}:${entry.item.id}:${state.category}:${state.source}:${page}`)
            .setEmoji('🔍')
            .setLabel(m.rpg_itembook_details_btn({}, { locale }))
            .setStyle(ButtonStyle.Secondary),
        ),
    );
  }

  const components: PanelRow[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`rpg:itembookcat:${ownerId}:${state.source}`)
        .setPlaceholder(m.rpg_inventory_category_placeholder({}, { locale }))
        .addOptions(BAG_CATEGORIES.map((category) => ({
          label: truncate(bagCategoryLabel(category, locale), 100),
          value: category,
          default: category === state.category,
        }))),
    ),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`rpg:itembooksrc:${ownerId}:${state.category}`)
        .setPlaceholder(m.rpg_itembook_source_placeholder({}, { locale }))
        .addOptions(ITEM_SOURCE_FILTERS.map((source) => ({
          label: truncate(itemSourceLabel(source, locale), 100),
          value: source,
          default: source === state.source,
        }))),
    ),
  ];

  const navRow = new ActionRowBuilder<ButtonBuilder>();
  if (pageCount > 1) {
    navRow.addComponents(
      new ButtonBuilder()
        .setCustomId(itemBookNavId(ownerId, { ...state, page: page - 1 }))
        .setLabel(m.rpg_shop_prev({}, { locale }))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId(`rpg:noop:${ownerId}`)
        .setLabel(`${page + 1} / ${pageCount}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(itemBookNavId(ownerId, { ...state, page: page + 1 }))
        .setLabel(m.rpg_shop_next({}, { locale }))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= pageCount - 1),
    );
  }
  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:hub`)
      .setLabel(m.rpg_hub_btn_back({}, { locale }))
      .setEmoji(icon('rpgBack'))
      .setStyle(ButtonStyle.Secondary),
  );
  components.push(navRow);

  return { embeds: [], components, container };
}

function dropChanceLabel(chance: number): string {
  const percent = chance * 100;
  return `${percent >= 10 || Number.isInteger(percent) ? Math.round(percent) : percent.toFixed(1)} %`;
}

/**
 * Fiche d'un objet du catalogue : tout ce que la ligne résumait, en entier.
 *
 * La ligne du catalogue tronque les créatures à trois noms et ne dit rien de la recette :
 * la fiche liste chaque source avec sa chance, et chaque matériau avec ce que le joueur
 * en possède déjà, pour savoir d'un coup d'oeil ce qui manque.
 */
async function buildItemBookEntryView(
  guildId: string,
  ownerId: string,
  itemId: string,
  locale: Locale,
  state: ItemBookState,
): Promise<PanelView> {
  const [detail, config, inventory] = await Promise.all([
    getItemCatalogDetail(guildId, itemId),
    getOrCreateEconomyConfig(guildId),
    prisma.rpgInventoryItem.findMany({
      where: { profile: { guildId, userId: ownerId }, quantity: { gt: 0 } },
      select: { quantity: true, item: { select: { name: true } } },
    }),
  ]);
  if (!detail) return buildItemBookView(guildId, ownerId, locale, state);

  const owned = new Map<string, number>();
  for (const row of inventory) owned.set(row.item.name, (owned.get(row.item.name) ?? 0) + row.quantity);

  const { entry, drops, recipe, usedIn } = detail;
  const item = entry.item;
  const meta = `${rarityIcon(item.rarity)} ${shopCategoryLabel(item.type, locale)}`
    + (item.levelRequired > 0 ? ` · ${m.rpg_item_level_required({ level: item.levelRequired }, { locale })}` : '')
    + ` · ${m.rpg_itembook_owned({ count: owned.get(item.name) ?? 0 }, { locale })}`;

  const container = new ContainerBuilder().setAccentColor(RPG_COLORS.hub);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent([
    `## ${item.emoji} ${item.name}`,
    `-# ${meta}`,
    item.description ? `*${truncate(item.description, 400)}*` : null,
    itemStatLine(item, locale) || null,
  ].filter((line): line is string => line !== null).join('\n')));

  const sources: string[] = [];
  if (isUniqueItem(entry)) sources.push(`✨ **${m.rpg_itembook_source_unique({}, { locale })}**`);
  if (isUnavailableItem(entry)) sources.push(`⛔ **${m.rpg_itembook_source_unavailable({}, { locale })}**`);
  if (entry.shop) sources.push(`${icon('rpgShop')} ${m.rpg_itembook_detail_shop({ price: item.price, emoji: config.currencyEmoji }, { locale })}`);
  for (const drop of drops.slice(0, 12)) {
    sources.push(`${drop.isBoss ? icon('rpgBoss') : icon('rpgFight')} ${drop.emoji} **${drop.name}** · ${m.rpg_itembook_detail_drop({ level: drop.level, chance: dropChanceLabel(drop.chance) }, { locale })}`);
  }
  if (drops.length > 12) sources.push(`-# ${m.rpg_itembook_detail_more({ count: drops.length - 12 }, { locale })}`);
  if (entry.firstKill.length > 0) sources.push(`🏆 ${m.rpg_itembook_first_kill({ names: entry.firstKill.join(', ') }, { locale })}`);
  if (entry.firstKillClaimed.length > 0) sources.push(`🏅 ${m.rpg_itembook_first_kill_claimed({ names: entry.firstKillClaimed.join(', ') }, { locale })}`);
  if (entry.campaign) sources.push(`${icon('rpgKey')} ${m.rpg_itembook_campaign({}, { locale })}`);

  if (sources.length > 0) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      truncate(`### ${m.rpg_itembook_detail_sources({}, { locale })}\n${sources.join('\n')}`, 1400),
    ));
  }

  if (recipe) {
    const lines = recipe.ingredients.map((ingredient) => {
      const have = owned.get(ingredient.itemName) ?? 0;
      const mark = have >= ingredient.quantity ? icon('success') : '▫️';
      return `${mark} ${ingredient.emoji} **${ingredient.itemName}** ${have}/${ingredient.quantity}`;
    });
    const extras = [
      recipe.coinCost > 0 ? `${recipe.coinCost} ${config.currencyEmoji}` : null,
      m.rpg_item_level_required({ level: recipe.levelRequired }, { locale }),
    ].filter((part): part is string => part !== null).join(' · ');
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      truncate(`### ${icon('rpgCraft')} ${m.rpg_itembook_detail_recipe({}, { locale })}\n${lines.join('\n')}\n-# ${extras}`, 800),
    ));
  }

  if (usedIn.length > 0) {
    const lines = usedIn.slice(0, 12).map((use) => `${use.emoji} **${use.itemName}** · ×${use.quantity}`);
    if (usedIn.length > 12) lines.push(`-# ${m.rpg_itembook_detail_more({ count: usedIn.length - 12 }, { locale })}`);
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      truncate(`### ${m.rpg_itembook_detail_used_in({}, { locale })}\n${lines.join('\n')}`, 800),
    ));
  }

  const navRow = new ActionRowBuilder<ButtonBuilder>();
  if (recipe) {
    navRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`rpg:nav:${ownerId}:craft`)
        .setLabel(m.rpg_itembook_detail_to_craft({}, { locale }))
        .setEmoji(icon('rpgCraft'))
        .setStyle(ButtonStyle.Primary),
    );
  }
  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId(itemBookNavId(ownerId, state))
      .setLabel(m.rpg_itembook_detail_back({}, { locale }))
      .setEmoji(icon('rpgBag'))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:hub`)
      .setLabel(m.rpg_hub_btn_back({}, { locale }))
      .setEmoji(icon('rpgBack'))
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [], components: [navRow], container };
}

/** Changer de filtre ramène en première page, comme partout ailleurs. */
async function handleItemBookFilter(
  interaction: StringSelectMenuInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
  action: 'itembookcat' | 'itembooksrc',
  rest: string[],
): Promise<void> {
  const picked = interaction.values[0];
  const state = action === 'itembookcat'
    ? parseItemBookState([picked, rest[0], '0'])
    : parseItemBookState([rest[0], picked, '0']);
  await respond(interaction, await buildItemBookView(guildId, ownerId, locale, state));
}

/** Butin d'une créature, tel que le bestiaire l'annonce. */
function monsterDropLines(monster: { drops: unknown }, locale: Locale): string {
  const drops = (Array.isArray(monster.drops)
    ? monster.drops
    : []) as { itemName?: string; emoji?: string; chance?: number }[];

  const lines = drops
    .filter((drop) => typeof drop.itemName === 'string')
    .map((drop) => `${drop.emoji || '📦'} **${drop.itemName}** — ${Math.round((drop.chance ?? 0) * 100)} %`);

  return lines.length > 0 ? lines.join('\n') : m.rpg_bestiary_no_drop({}, { locale });
}

/**
 * Fiche d'une créature : sa feuille de statistiques, son butin, et le carnet du joueur.
 *
 * Le bestiaire d'avant tenait en une ligne par bête, sans butin ni historique : il disait
 * qu'on l'avait croisée, jamais ce qu'on y avait gagné ni perdu.
 */
async function buildBestiaryEntryView(
  guildId: string,
  ownerId: string,
  monsterId: string,
  locale: Locale,
  back: BestiaryState,
): Promise<PanelView> {
  const entry = await getBestiaryEntry(guildId, ownerId, monsterId);

  if (!entry || !entry.discovered) {
    return {
      embeds: [errorEmbed(m.rpg_bestiary_empty_title({}, { locale }), m.rpg_bestiary_entry_unknown({}, { locale }))],
      components: [backRow(ownerId, locale)],
    };
  }

  const { monster, record } = entry;

  const embed = new EmbedBuilder()
    .setTitle(truncate(`${monster.emoji} ${monster.name}${monster.isBoss ? ` ${m.rpg_bestiary_boss_tag({}, { locale })}` : ''}`, 256))
    .setDescription(`*${monster.description}*`)
    .setColor(monster.isBoss ? RPG_COLORS.combat : RPG_COLORS.wild)
    .addFields(
      {
        name: m.rpg_bestiary_field_sheet({}, { locale }),
        value: `${icon('star')} ${m.rpg_bestiary_level({ level: monster.level }, { locale })}\n`
          + `${icon('rpgHp')} **${monster.health}**  ${icon('rpgAtk')} **${monster.attack}**\n`
          + `${icon('rpgDef')} **${monster.defense}**  ${icon('rpgSpd')} **${monster.speed}**`,
        inline: true,
      },
      {
        name: m.rpg_bestiary_field_rewards({}, { locale }),
        value: `${icon('rpgXp')} **${monster.xpReward}** XP\n${icon('coins')} **${monster.coinReward}**`
          + (monster.clanPoints > 0 ? `\n${icon('rpgClan')} **${monster.clanPoints}**` : ''),
        inline: true,
      },
      {
        name: m.rpg_bestiary_field_drops({}, { locale }),
        value: truncate(monsterDropLines(monster, locale), 1024),
        inline: false,
      },
      {
        name: m.rpg_bestiary_field_record({}, { locale }),
        value: m.rpg_bestiary_record_value({
          kills: record.kills,
          defeats: record.defeats,
          best: record.bestDamage,
          dealt: record.totalDamageDealt,
          taken: record.totalDamageTaken,
        }, { locale }),
        inline: false,
      },
      {
        name: m.rpg_bestiary_field_spoils({}, { locale }),
        value: m.rpg_bestiary_spoils_value({ coins: record.coinsEarned, xp: record.xpEarned }, { locale }),
        inline: true,
      },
    );

  // Le premier vainqueur, ou la prime qui attend encore preneur : c'est elle qui donne
  // envie d'aller affronter une créature que personne n'a encore battue.
  const firstKill = await getFirstKill(guildId, monster.name);
  if (firstKill) {
    embed.addFields({
      name: m.rpg_bestiary_field_first_kill({}, { locale }),
      value: m.rpg_bestiary_first_kill_value({ user: `<@${firstKill.userId}>`, date: `<t:${Math.floor(firstKill.createdAt.getTime() / 1000)}:d>` }, { locale }),
      inline: false,
    });
  } else {
    const bountyTitle = monster.firstKillTitleId
      ? await prisma.rpgTitle.findUnique({ where: { id: monster.firstKillTitleId }, select: { name: true } })
      : null;
    const bounty = formatFirstKillBounty(monster, await getOrCreateEconomyConfig(guildId), locale, bountyTitle?.name ?? null);
    if (bounty) {
      embed.addFields({ name: m.rpg_bestiary_field_first_kill_bounty({}, { locale }), value: bounty, inline: false });
    }
  }

  if (monster.winTitleId) {
    const winTitle = await prisma.rpgTitle.findUnique({ where: { id: monster.winTitleId }, select: { name: true } });
    if (winTitle) {
      embed.addFields({ name: m.rpg_bestiary_field_win_title({}, { locale }), value: `**${winTitle.name}**`, inline: false });
    }
  }

  if (record.lastFoughtAt) {
    embed.addFields({
      name: m.rpg_bestiary_field_last({}, { locale }),
      value: `<t:${Math.floor(record.lastFoughtAt.getTime() / 1000)}:R>`,
      inline: true,
    });
  }

  const profile = await getOrCreateRpgProfile(guildId, ownerId);
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (canHunt(monster, profile.level)) {
    row.addComponents(trackButton(ownerId, monster.id, profile.trackedMonsterId === monster.id, 'entry', back, locale));
  }
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:bestiary:${back.filter}:${back.page}`)
      .setLabel(m.rpg_bestiary_back_btn({}, { locale }))
      .setEmoji(icon('rpgBestiary'))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:hub`)
      .setLabel(m.rpg_hub_btn_back({}, { locale }))
      .setEmoji(icon('rpgBack'))
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

async function handleBestiaryFilter(
  interaction: StringSelectMenuInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
): Promise<void> {
  // Changer de filtre ramène en première page : rester en page 4 d'un filtre qui n'en
  // compte qu'une afficherait une liste vide.
  await respond(interaction, await buildBestiaryView(
    guildId, ownerId, interaction.user, locale, parseBestiaryState([interaction.values[0], '0']),
  ));
}

// ─────────────────────────────────────────────────────────────
// Combat - Monstre aléatoire (boucle interactive)
// ─────────────────────────────────────────────────────────────

/**
 * Verse au clan du vainqueur la prime portée par la créature vaincue.
 *
 * Le pont RPG vers les clans est un interrupteur de serveur distinct de `clansEnabled` :
 * le couper ne doit pas obliger à remettre à zéro la prime de chaque monstre du bestiaire.
 * Les deux interrupteurs sont vérifiés ici, avant même de charger le module des clans : une
 * prime réglée sur un serveur dont les clans sont éteints reste dormante, sans rien tenter.
 * Un vainqueur sans clan ne reçoit rien, ce dont `awardClanPointsToMembers` se charge.
 */
/**
 * Compte une victoire, et le butin qu'elle a rendu, sur les quêtes RPG en cours.
 *
 * Posé ici et non dans le service de combat, qui ne reçoit pas le client : la résolution de
 * l'équipe d'un membre passe par ses rôles Discord, comme pour les points de clan juste
 * au-dessus. Volontairement silencieux, une quête ne doit jamais faire échouer un combat
 * déjà gagné.
 */
/**
 * Fait avancer quêtes ET campagne, sans jamais faire échouer l'action.
 *
 * Tout passe par `trackRpgObjective` : brancher les deux systèmes séparément à chaque
 * endroit qui compte quelque chose reviendrait à en oublier un, et une action
 * progresserait dans un écran sans progresser dans l'autre.
 *
 * Renvoie ce que la campagne a validé, pour que l'écran à l'origine de l'action puisse
 * l'annoncer plutôt que de laisser le joueur le découvrir plus tard.
 */
async function trackQuest(
  client: Client,
  guildId: string,
  userId: string,
  objective: RpgQuestObjective,
  amount = 1,
): Promise<CampaignAdvance> {
  try {
    return await trackRpgObjective(client, guildId, userId, objective, amount);
  } catch {
    // Déjà journalisé par l'entonnoir. L'achat, la fabrication ou le combat sont derrière
    // nous : rien de ce qui suit ne doit les faire échouer après coup.
    return { completedSteps: [], completedChapters: [], finished: false };
  }
}

async function trackCombatQuests(
  client: Client,
  guildId: string,
  userId: string,
  isBoss: boolean,
  itemDropped: string | null,
): Promise<CampaignAdvance> {
  const kill = await trackQuest(client, guildId, userId, isBoss ? 'BOSS_KILLS' : 'MONSTER_KILLS');
  const loot = itemDropped
    ? await trackQuest(client, guildId, userId, 'ITEMS_LOOTED')
    : { completedSteps: [], completedChapters: [], finished: false };

  // Un même combat peut valider une étape par le kill et une autre par le butin : les
  // deux se disent au joueur, pas seulement la première.
  return {
    completedSteps: [...kill.completedSteps, ...loot.completedSteps],
    completedChapters: [...kill.completedChapters, ...loot.completedChapters],
    finished: kill.finished || loot.finished,
  };
}

/**
 * Premier vainqueur : le record, la prime et l'annonce.
 *
 * Un incident ici ne doit pas priver le joueur du compte rendu d'une victoire déjà versée :
 * il est journalisé, et le combat se termine comme si de rien n'était.
 */
async function firstKillField(
  client: Client,
  guildId: string,
  userId: string,
  monster: FirstKillMonster,
  locale: Locale,
): Promise<{ name: string; value: string; inline: boolean } | null> {
  try {
    const claimed = await claimFirstKill(client, guildId, userId, monster);
    if (!claimed) return null;
    const config = await getOrCreateEconomyConfig(guildId);
    const reward = formatFirstKillReward(claimed, config.currencyEmoji, locale);
    return {
      name: m.rpg_first_kill_field_title({}, { locale }),
      value: reward
        ? m.rpg_first_kill_field_reward_value({ reward }, { locale })
        : m.rpg_first_kill_field_value({}, { locale }),
      inline: false,
    };
  } catch (err) {
    logger.error('RpgPanel', `Premier vainqueur non enregistré pour ${monster.name} :`, err);
    return null;
  }
}

/**
 * Bouton de revente du butin d'un combat, ou `null` s'il n'y a rien à en tirer.
 *
 * Seul l'objet tombé est proposé : les récompenses uniques (objet, titre ou rôle du premier
 * vainqueur) restent au joueur, puisqu'il ne pourra jamais les regagner.
 *
 * Le bouton porte le nombre d'exemplaires possédés juste après le combat, et la vente exige
 * de le retrouver. Un clic rejoué - Discord qui annonce un échec alors que la vente est
 * passée, un message resté affiché après un redémarrage - ne peut donc plus vendre un
 * exemplaire que le joueur avait avant ce combat.
 */
async function lootSellRow(
  guildId: string,
  ownerId: string,
  lootName: string | null,
  locale: Locale,
  isBoss = false,
): Promise<ActionRowBuilder<ButtonBuilder> | null> {
  if (!lootName) return null;

  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.shopEnabled) return null;

  const owned = await prisma.rpgInventoryItem.findFirst({
    where: { quantity: { gt: 0 }, profile: { guildId, userId: ownerId }, item: { name: lootName, price: { gt: 0 } } },
    include: { item: true },
  });
  const price = owned ? Math.floor(owned.item.price * SELL_RATIO) : 0;
  if (!owned || price <= 0) return null;

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      // `b` : le combat était un boss, le retour qui remplace le bouton mène à leur liste.
      .setCustomId(`rpg:sellloot:${ownerId}:${owned.itemId}:${owned.quantity}${isBoss ? ':b' : ''}`)
      .setLabel(m.rpg_fight_sell_loot_btn({ price }, { locale }))
      .setEmoji(icon('rpgSell'))
      .setStyle(ButtonStyle.Success),
  );
}

/**
 * Revend le butin du combat, puis retire le bouton.
 *
 * Le bouton est retiré même quand la vente est refusée : un clic rejoué après une vente déjà
 * passée doit remettre le message d'aplomb, pas laisser un bouton qui ne fait plus rien.
 */
async function handleSellLoot(
  interaction: ButtonInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
  rest: string[],
): Promise<void> {
  const [itemId, ownedAfterFight, fightKind] = rest;
  const minOwned = Number.parseInt(ownedAfterFight ?? '', 10);

  let summary: string;
  let sold = false;
  try {
    const config = await getOrCreateEconomyConfig(guildId);
    const result = await sellShopItem(guildId, ownerId, itemId, Number.isFinite(minOwned) ? { minOwned } : {});
    summary = m.rpg_fight_sell_loot_done({ items: result.itemName, price: result.sellPrice, emoji: config.currencyEmoji }, { locale });
    sold = true;
  } catch {
    summary = m.rpg_fight_sell_loot_none({}, { locale });
  }

  await interaction.editReply({ components: [fightBackRow(ownerId, locale, fightKind === 'b')] }).catch(() => null);
  await interaction.followUp({
    embeds: [sold
      ? successEmbed(m.rpg_fight_sell_loot_title({}, { locale }), summary)
      : errorEmbed(m.rpg_fight_sell_loot_title({}, { locale }), summary)],
    flags: [MessageFlags.Ephemeral],
  }).catch(() => null);
}

async function handleTitleSelect(
  interaction: StringSelectMenuInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
  origin: string | undefined,
): Promise<void> {
  const profile = await getOrCreateRpgProfile(guildId, ownerId);
  const choice = interaction.values[0];
  const title = await setActiveTitle(profile.id, choice === 'none' ? null : choice);
  const view = origin === 'inventory'
    ? await buildInventoryView(guildId, ownerId, locale)
    : await buildCharacterView(guildId, ownerId, locale);
  await respond(interaction, withNote(view, title
    ? m.rpg_character_title_equipped({ title: title.name }, { locale })
    : m.rpg_character_title_removed({}, { locale })));
}

/** Titre gagné à la victoire, s'il vient d'entrer dans la collection du joueur. */
async function winTitleField(
  guildId: string,
  userId: string,
  monster: { name: string; winTitleId: string | null },
  locale: Locale,
): Promise<{ name: string; value: string; inline: boolean } | null> {
  try {
    const title = await grantWinTitle(guildId, userId, monster.winTitleId);
    if (!title) return null;
    return {
      name: m.rpg_title_obtained_field({}, { locale }),
      value: m.rpg_title_obtained_value({ title: title.name }, { locale }),
      inline: false,
    };
  } catch (err) {
    logger.error('RpgPanel', `Titre de victoire non attribué pour ${monster.name} :`, err);
    return null;
  }
}

async function awardMonsterTeamPoints(
  guildId: string,
  userId: string,
  monster: { name: string; clanPoints: number; isBoss: boolean },
  client: Client,
): Promise<{ amount: number; toGuild: boolean }> {
  // Court-circuit avant toute requête : la grande majorité du bestiaire ne porte pas de prime.
  if (!(monster.clanPoints > 0)) return { amount: 0, toGuild: false };

  return awardRpgTeamPoints({
    client,
    guildId,
    userId,
    amount: monster.clanPoints,
    source: monster.isBoss ? 'RPG_BOSS' : 'RPG_MOB',
    reason: monster.name,
  });
}

/**
 * Reporte sur le profil les PV gagnés ou perdus pendant un combat.
 *
 * Par écart et non par réécriture : un combat dure plusieurs minutes, et une potion bue
 * entre-temps depuis une autre fenêtre était effacée par les PV mémorisés au début.
 */
async function settleFightHealth(profileId: string, delta: number, maxHp: number): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "rpg_profiles"
    SET "health" = GREATEST(1, LEAST(GREATEST("health", ${maxHp}), "health" + ${delta}))
    WHERE "id" = ${profileId}
  `;
}

function firstWinField(locale: Locale) {
  return {
    name: m.rpg_fight_field_first_win({}, { locale }),
    value: m.rpg_fight_field_first_win_value({ percent: Math.round(FIRST_WIN_BONUS * 100) }, { locale }),
    inline: false,
  };
}

/**
 * Créature qu'un joueur peut traquer depuis le bestiaire : ni boss, ni plus forte que lui.
 *
 * Les rencontres ordinaires ne tirent qu'autour du niveau du joueur : passé ce palier, les
 * premières créatures ne se croisaient plus jamais et le bestiaire restait incomplet. Le
 * plafond au niveau du joueur empêche de s'en servir pour sauter en avant, et `huntXpRatio`
 * rogne l'XP d'une proie trop faible.
 */
function canHunt(monster: { isBoss: boolean; level: number }, playerLevel: number): boolean {
  return !monster.isBoss && monster.level <= playerLevel;
}

async function startFightSession(
  interaction: ButtonInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
  targetMonsterId?: string,
): Promise<void> {
  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.rpgEnabled) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_travel_disabled_title({}, { locale }), m.rpg_boss_disabled_desc({}, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  const profile = await getOrCreateRpgProfile(guildId, ownerId);
  const cooldownMs = fightCooldownMs(config);

  // Résolue avant tout débit d'énergie : une cible refusée ne doit rien coûter.
  const target = targetMonsterId ? await findGuildMonsterById(guildId, targetMonsterId) : null;
  if (targetMonsterId && (!target || !canHunt(target, profile.level))) {
    // Une cible devenue introuvable ou boss ne se traquera plus jamais : la garder ferait
    // réapparaître au hub un bouton qui ne mène qu'à ce refus.
    if (profile.trackedMonsterId === targetMonsterId && (!target || target.isBoss)) await setTrackedMonster(guildId, ownerId, null);
    await interaction.reply({ embeds: [errorEmbed(m.rpg_hunt_refused_title({}, { locale }), m.rpg_hunt_refused_desc({}, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  // Une traque coûte plus qu'une rencontre au hasard, et repousse le verrou commun des
  // combats : `lastBattle` est alors posé dans le futur, et chaque écriture du verrou,
  // jusqu'à la fin du combat, doit reprendre ce report.
  const energyCost = target ? huntEnergyCost(FIGHT_ENERGY_COST, config) : FIGHT_ENERGY_COST;
  const lockExtraMs = target ? huntCooldownExtraMs(config) : 0;
  const lockRelease = () => new Date(Date.now() + lockExtraMs);

  const remainingMs = remainingCooldownMs(profile.lastBattle, cooldownMs);
  if (remainingMs > 0) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_fight_cooldown_title({}, { locale }), m.rpg_fight_cooldown_desc({ wait: formatCooldown(remainingMs) }, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  if (profile.energy < energyCost) {
    await replyVitalsAlert(interaction, guildId, ownerId, locale, errorEmbed(m.rpg_fight_low_energy_title({}, { locale }), m.rpg_fight_low_energy_desc({ energy: profile.energy, cost: energyCost }, { locale })), 'energy');
    return;
  }

  if (profile.health <= FIGHT_MIN_HEALTH) {
    await replyVitalsAlert(interaction, guildId, ownerId, locale, errorEmbed(m.rpg_fight_low_hp_title({}, { locale }), m.rpg_fight_low_hp_desc({}, { locale })), 'hp');
    return;
  }

  // Débit d'énergie ET pose du verrou de combat dans la même écriture atomique :
  // `lastBattle` était auparavant écrit seulement à la fin du combat, ce qui permettait
  // de spammer le bouton pour ouvrir plusieurs sessions en parallèle sur le même profil
  // (chaque session sauvegardant ses PV à la fin, la dernière écrasant les dégâts subis).
  const battleLockedAt = new Date();
  const energySpent = await prisma.rpgProfile.updateMany({
    where: {
      guildId,
      userId: ownerId,
      energy: { gte: energyCost },
      OR: [
        { lastBattle: null },
        { lastBattle: { lte: new Date(battleLockedAt.getTime() - cooldownMs) } },
      ],
    },
    data: { energy: { decrement: energyCost }, lastBattle: new Date(battleLockedAt.getTime() + lockExtraMs) },
  });

  if (energySpent.count === 0) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_fight_low_energy_title({}, { locale }), m.rpg_fight_low_energy_desc({ energy: profile.energy, cost: energyCost }, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  /** Rend l'énergie (et libère le verrou) quand le combat ne peut pas démarrer. */
  const refundFightCost = () => prisma.rpgProfile.update({
    where: { guildId_userId: { guildId, userId: ownerId } },
    data: { energy: { increment: energyCost }, lastBattle: profile.lastBattle },
  }).catch(() => null);

  await interaction.deferUpdate();

  const monster = target ?? await findRandomMonster(guildId, profile.level);
  if (!monster) {
    await refundFightCost();
    await interaction.editReply({ embeds: [errorEmbed(m.rpg_fight_no_monster_title({}, { locale }), m.rpg_fight_no_monster_desc({}, { locale }))], components: [backRow(ownerId, locale)] });
    return;
  }

  // Statistiques dérivées : base du profil + équipement + forge + modificateurs de classe.
  const stats = await loadEffectiveStats(profile);
  const playerMaxHp = stats.maxHealth;
  // `loadAvailableSkills` ajoute les compétences accordées par l'arbre : les omettre ici
  // les rendrait achetables mais injouables, visibles seulement sur l'écran de l'arbre.
  const skills = await loadAvailableSkills(profile);

  let playerHp = Math.min(profile.health, playerMaxHp);
  const startHp = playerHp;
  let monsterHp = monster.health;
  const monsterMaxHp = monster.health;

  // En combat, seules les potions qui rendent des PV ont un intérêt : filtrer sur
  // `hpRestore > 0` évite que le bouton consomme une potion d'énergie pour 0 soin.
  // On sert la plus faible en premier pour ne pas gaspiller un élixir sur une égratignure.
  const getPotions = () => prisma.rpgInventoryItem.findMany({
    where: {
      rpgProfileId: profile.id,
      quantity: { gte: 1 },
      item: { type: 'POTION', hpRestore: { gt: 0 } },
    },
    include: { item: true },
    orderBy: { item: { hpRestore: 'asc' } },
  });

  const getEmbed = (turnsLog: string[]) => {
    const logs = turnsLog.slice(-5).join('\n') || m.rpg_fight_combat_start_log({}, { locale });
    return new EmbedBuilder()
      .setTitle(m.rpg_fight_title({ emoji: monster.emoji, name: monster.name }, { locale }))
      .setDescription(
        `${monster.description}\n\n` +
        `${m.rpg_fight_you_label_block({}, { locale })}\n${buildHpBar(playerHp, playerMaxHp)}\n\n` +
        `${m.rpg_fight_enemy_label_block({ emoji: monster.emoji, name: monster.name, level: monster.level }, { locale })}\n${buildHpBar(monsterHp, monsterMaxHp)}\n\n` +
        `${m.rpg_fight_combat_log_label({}, { locale })}\n${logs}`,
      )
      .setColor('#5865F2');
  };

  // Tours restants avant que chaque compétence redevienne disponible.
  const skillCooldowns = new Map<string, number>(skills.map((skill) => [skill.id, 0]));

  const getActionRows = async () => {
    const userPotions = await getPotions();
    const potionsCount = userPotions.reduce((sum, p) => sum + p.quantity, 0);

    const mainRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`rpg:combat_attack:${ownerId}`).setLabel(m.rpg_fight_btn_attack({}, { locale })).setEmoji(icon('rpgAtk')).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`rpg:combat_defend:${ownerId}`).setLabel(m.rpg_fight_btn_defend({}, { locale })).setEmoji(icon('rpgDef')).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`rpg:combat_potion:${ownerId}`).setLabel(m.rpg_fight_btn_potion({ count: potionsCount }, { locale })).setEmoji(icon('rpgPotion')).setStyle(ButtonStyle.Success).setDisabled(potionsCount === 0),
      new ButtonBuilder().setCustomId(`rpg:combat_flee:${ownerId}`).setLabel(m.rpg_fight_btn_flee({}, { locale })).setEmoji(icon('rpgSpd')).setStyle(ButtonStyle.Danger),
    );

    if (skills.length === 0) return [mainRow];

    // Une compétence en recharge reste visible mais désactivée, avec le nombre de tours
    // restants sur le libellé : le joueur peut planifier au lieu de deviner.
    const skillRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...skills.map((skill) => {
        const remaining = skillCooldowns.get(skill.id) ?? 0;
        return new ButtonBuilder()
          .setCustomId(`rpg:combat_skill_${skill.id}:${ownerId}`)
          .setLabel(remaining > 0 ? `${skill.name} (${remaining})` : skill.name)
          .setEmoji(skill.emoji)
          .setStyle(ButtonStyle.Success)
          .setDisabled(remaining > 0);
      }),
    );

    return [mainRow, skillRow];
  };

  const message = await interaction.editReply({ embeds: [getEmbed([])], components: await getActionRows() });

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) => i.user.id === ownerId && i.customId.startsWith('rpg:combat_'),
    time: COMBAT_TURN_TIMEOUT_MS,
  });

  const turnsLog: string[] = [];
  let defenseMultiplier = 1;
  let evadeNextAttack = false;
  let totalDamageDealt = 0;
  let totalDamageTaken = 0;

  /** Applique une attaque du joueur, éventuellement portée par une compétence. */
  const strike = (skill: RpgSkill | null): string => {
    const { damage, critical, healed } = computeAttack({
      attack: stats.attack,
      targetDefense: monster.defense,
      speed: stats.speed,
      critChance: stats.critChance,
      armorPiercing: Math.max(stats.armorPiercing, skill?.effect.armorPiercing ?? 0),
      skillMultiplier: skill?.effect.damageMultiplier ?? 1,
      // Vol de vie de la compétence et des enchantements : deux sources distinctes, qui
      // se cumulent plutôt que de s'annuler.
      lifesteal: stats.lifesteal + (skill?.effect.lifesteal ?? 0),
    });

    monsterHp = Math.max(0, monsterHp - damage);
    totalDamageDealt += damage;

    if (healed > 0) playerHp = Math.min(playerMaxHp, playerHp + healed);

    const crit = critical ? m.rpg_fight_critical_suffix({}, { locale }) : '';
    return skill
      ? m.rpg_fight_action_skill({ emoji: skill.emoji, skill: skill.name, dmg: damage, crit, name: monster.name }, { locale })
      : m.rpg_fight_action_attack({ dmg: damage, crit, name: monster.name }, { locale });
  };

  collector.on('collect', async (btnInt) => {
    try {
      await btnInt.deferUpdate();
      collector.resetTimer();

      // Les postures ne durent qu'un tour : elles se réinitialisent à chaque action.
      defenseMultiplier = 1;
      let actionTaken = '';
      const action = btnInt.customId.split(':')[1];

      if (action === 'combat_attack') {
        actionTaken = strike(null);
      } else if (action === 'combat_defend') {
        defenseMultiplier = 2;
        actionTaken = m.rpg_fight_action_defend({}, { locale });
      } else if (action.startsWith('combat_skill_')) {
        const skillId = action.slice('combat_skill_'.length);
        const skill = skills.find((s) => s.id === skillId);
        const remaining = skill ? skillCooldowns.get(skill.id) ?? 0 : 0;

        if (!skill || remaining > 0) {
          // Le bouton est désactivé côté client : ce cas ne survient que sur un clic
          // concurrent, on ne consomme donc pas le tour.
          return;
        }

        skillCooldowns.set(skill.id, skill.cooldownTurns);
        if (skill.effect.defenseMultiplier) defenseMultiplier = skill.effect.defenseMultiplier;
        if (skill.effect.evadeNextAttack) evadeNextAttack = true;
        if (skill.effect.healPercent) {
          playerHp = Math.min(playerMaxHp, playerHp + Math.floor(playerMaxHp * skill.effect.healPercent));
        }

        actionTaken = skill.effect.damageMultiplier > 0
          ? strike(skill)
          : m.rpg_fight_action_skill_support({ emoji: skill.emoji, skill: skill.name }, { locale });
      } else if (action === 'combat_potion') {
        const userPotions = await getPotions();
        // Le soin n'est accordé qu'une fois la potion effectivement retirée : il l'était
        // avant, et une potion déjà bue dans une autre fenêtre soignait quand même.
        const drunk = userPotions.length === 0 ? null : await prisma.$transaction(async (tx) => {
          await lockRpgProfile(tx, profile.id);
          for (const candidate of userPotions) {
            const taken = await takeInventoryQuantity(tx, profile.id, candidate.itemId, 1);
            if (taken) return taken;
          }
          return null;
        });

        if (!drunk) {
          actionTaken = m.rpg_fight_no_potions({}, { locale });
        } else {
          const restored = drunk.item.hpRestore;
          playerHp = Math.min(playerMaxHp, playerHp + restored);
          actionTaken = m.rpg_fight_action_potion({ item: drunk.item.name, hp: restored }, { locale });
        }
      } else if (action === 'combat_flee') {
        turnsLog.push(m.rpg_fight_action_flee({}, { locale }));
        collector.stop('fled');
        return;
      }

      turnsLog.push(actionTaken);

      // Une compétence consommée fait progresser toutes les recharges d'un tour.
      for (const [id, remaining] of skillCooldowns) {
        if (remaining > 0) skillCooldowns.set(id, remaining - 1);
      }

      if (monsterHp <= 0) {
        collector.stop('victory');
        return;
      }

      if (evadeNextAttack) {
        evadeNextAttack = false;
        turnsLog.push(m.rpg_fight_monster_evaded({ emoji: monster.emoji, name: monster.name }, { locale }));
      } else {
        const { damage: monsterDamage, critical: monsterCrit, reflected } = computeAttack({
          attack: monster.attack,
          targetDefense: stats.defense,
          speed: monster.speed,
          critChance: 0.08,
          targetDefenseMultiplier: defenseMultiplier,
          targetDamageReduction: stats.damageReduction,
          targetThorns: stats.thorns,
        });

        playerHp = Math.max(0, playerHp - monsterDamage);
        totalDamageTaken += monsterDamage;
        turnsLog.push(m.rpg_fight_monster_turn_log({ emoji: monster.emoji, name: monster.name, dmg: monsterDamage, crit: monsterCrit ? m.rpg_fight_critical_suffix({}, { locale }) : '' }, { locale }));

        // Les épines répliquent même sur un coup mortel : l'armure réagit à l'impact.
        if (reflected > 0) {
          monsterHp = Math.max(0, monsterHp - reflected);
          totalDamageDealt += reflected;
          turnsLog.push(m.rpg_fight_thorns_log({ dmg: reflected, emoji: monster.emoji, name: monster.name }, { locale }));
        }

        if (monsterHp <= 0) {
          collector.stop('victory');
          return;
        }

        if (playerHp <= 0) {
          collector.stop('defeat');
          return;
        }
      }

      await interaction.editReply({ embeds: [getEmbed(turnsLog)], components: await getActionRows() });
    } catch (err) {
      console.error(err);
    }
  });

  collector.on('end', async (_, reason) => {
    try {
      // Le combat est terminé : on grise toutes les actions et on ne laisse que le retour.
      const rows = await getActionRows();
      rows.forEach((row) => row.components.forEach((c) => c.setDisabled(true)));
      const back = fightBackRow(ownerId, locale, monster.isBoss);
      const finalComponents = [...rows, back];

      if (reason === 'fled' || reason === 'time') {
        await prisma.rpgProfile.update({ where: { guildId_userId: { guildId, userId: ownerId } }, data: { lastBattle: lockRelease() } });
        await settleFightHealth(profile.id, playerHp - startHp, playerMaxHp);

        const embed = reason === 'fled'
          ? new EmbedBuilder()
            .setTitle(m.rpg_fight_fled_title({ emoji: monster.emoji, name: monster.name }, { locale }))
            .setDescription(m.rpg_fight_fled_desc({ playerBar: buildHpBar(playerHp, playerMaxHp), name: monster.name, monsterBar: buildHpBar(monsterHp, monsterMaxHp) }, { locale }))
            .setColor('#FFA500')
          : new EmbedBuilder()
            .setTitle(m.rpg_fight_timeout_title({}, { locale }))
            .setDescription(m.rpg_fight_timeout_desc({}, { locale }))
            .setColor('#808080');

        await interaction.editReply({ embeds: [embed], components: finalComponents });
        return;
      }

      if (reason === 'victory') {
        // La taverne et la chambre forte du village majorent le butin. Le bonus s'applique
        // au tirage complet (base + aléa) : appliqué à la seule base, il serait invisible
        // sur les petits monstres, précisément ceux qu'on enchaîne le plus.
        const villagePerks = await loadGuildPerksForMember(guildId, ownerId);
        const rawXp = monster.xpReward + Math.floor(Math.random() * Math.floor(monster.xpReward * 0.3));
        const rawCoins = monster.coinReward + Math.floor(Math.random() * Math.floor(monster.coinReward * 0.3));

        const huntRatio = target ? huntXpRatio(profile.level, monster.level) : 1;
        let xpEarned = Math.round(rawXp * (1 + villagePerks.xpBonus) * huntRatio);
        let coinsEarned = Math.round(rawCoins * (1 + villagePerks.coinBonus));

        let itemDropped: string | null = null;
        let itemDropEmoji: string | null = null;

        const drops = (Array.isArray(monster.drops) ? monster.drops : JSON.parse(String(monster.drops || '[]'))) as { itemName: string; chance: number; emoji?: string; coinBonus?: number }[];
        for (const drop of drops) {
          if (Math.random() < drop.chance) {
            itemDropped = drop.itemName;
            itemDropEmoji = drop.emoji || null;
            if (drop.coinBonus) coinsEarned += drop.coinBonus;

            const dropItem = await prisma.rpgItem.findFirst({ where: { OR: [{ guildId: null }, { guildId }], name: drop.itemName } });
            if (dropItem) {
              await prisma.rpgInventoryItem.upsert({
                where: { rpgProfileId_itemId: { rpgProfileId: profile.id, itemId: dropItem.id } },
                update: { quantity: { increment: 1 } },
                create: { rpgProfileId: profile.id, itemId: dropItem.id, quantity: 1 },
              });
            }
            break;
          }
        }

        const firstWinBonus = await isFirstWinToday(guildId, ownerId);
        if (firstWinBonus) {
          const boosted = applyFirstWinBonus(xpEarned, coinsEarned);
          xpEarned = boosted.xp;
          coinsEarned = boosted.coins;
        }

        await prisma.rpgProfile.update({
          where: { guildId_userId: { guildId, userId: ownerId } },
          data: {
            balance: { increment: coinsEarned },
            xp: { increment: xpEarned },
            totalMonstersKilled: !monster.isBoss ? { increment: 1 } : undefined,
            totalBossesKilled: monster.isBoss ? { increment: 1 } : undefined,
            lastBattle: lockRelease(),
          },
        });

        await settleFightHealth(profile.id, playerHp - startHp, playerMaxHp);

        await prisma.rpgBattle.create({
          data: { guildId, userId: ownerId, monsterId: monster.id, monsterName: monster.name, won: true, damageDealt: totalDamageDealt, damageTaken: totalDamageTaken, xpEarned, coinsEarned, itemDropped },
        });

        const { checkLevelUp } = await import('./economyService.js');
        const beforeLevel = profile.level;
        await checkLevelUp(guildId, ownerId);
        const afterProfile = await prisma.rpgProfile.findUnique({ where: { guildId_userId: { guildId, userId: ownerId } } });
        const levelUp = afterProfile && afterProfile.level > beforeLevel ? afterProfile.level : null;

        const victoryEmbed = new EmbedBuilder()
          .setTitle(m.rpg_fight_victory_title({ emoji: monster.emoji, name: monster.name }, { locale }))
          .setDescription(m.rpg_fight_victory_desc({ name: monster.name, playerBar: buildHpBar(playerHp, playerMaxHp), log: turnsLog.slice(-4).join('\n') }, { locale }))
          .setColor(COLORS.success)
          .addFields(
            { name: m.rpg_fight_field_dmg_dealt({}, { locale }), value: `${totalDamageDealt}`, inline: true },
            { name: m.rpg_fight_field_dmg_taken({}, { locale }), value: `${totalDamageTaken}`, inline: true },
            { name: m.rpg_fight_field_xp_earned({}, { locale }), value: `+${xpEarned}`, inline: true },
            { name: m.rpg_fight_field_coins_earned({ emoji: '🪙' }, { locale }), value: `+${coinsEarned}`, inline: true },
          );

        const teamPoints = await awardMonsterTeamPoints(guildId, ownerId, monster, interaction.client);
        const campaign = await trackCombatQuests(interaction.client, guildId, ownerId, monster.isBoss, itemDropped);
        const firstKill = await firstKillField(interaction.client, guildId, ownerId, monster, locale);
        const winTitle = await winTitleField(guildId, ownerId, monster, locale);
        const sellRow = await lootSellRow(guildId, ownerId, itemDropped, locale, monster.isBoss);

        if (itemDropped) victoryEmbed.addFields({ name: m.rpg_fight_field_drop({}, { locale }), value: `${itemDropEmoji || '📦'} **${itemDropped}**`, inline: true });
        if (teamPoints.amount > 0) {
          victoryEmbed.addFields({
            name: teamPoints.toGuild ? m.rpg_fight_field_guild_xp({}, { locale }) : m.rpg_fight_field_clan_points({}, { locale }),
            value: `+${teamPoints.amount}`,
            inline: true,
          });
        }
        if (firstWinBonus) victoryEmbed.addFields(firstWinField(locale));
        if (firstKill) victoryEmbed.addFields(firstKill);
        if (winTitle) victoryEmbed.addFields(winTitle);
        if (levelUp) victoryEmbed.addFields({ name: m.rpg_fight_field_levelup({}, { locale }), value: m.rpg_fight_field_levelup_desc({ level: levelUp }, { locale }) });

        // Le pied de compte rendu annonce l'étape de campagne validée : sans lui, le
        // joueur ne découvrirait sa progression qu'en rouvrant l'écran de campagne.
        const campaignNote = campaignAdvanceNote(campaign, locale);
        if (campaignNote) victoryEmbed.setFooter({ text: campaignNote });

        await interaction.editReply({
          embeds: [victoryEmbed],
          components: sellRow ? [...rows, sellRow, back] : finalComponents,
        });
        return;
      }

      if (reason === 'defeat') {
        const xpEarned = Math.floor(monster.xpReward * 0.15);

        await prisma.rpgProfile.update({ where: { guildId_userId: { guildId, userId: ownerId } }, data: { health: 1, xp: { increment: xpEarned }, lastBattle: lockRelease() } });
        await prisma.rpgBattle.create({ data: { guildId, userId: ownerId, monsterId: monster.id, monsterName: monster.name, won: false, damageDealt: totalDamageDealt, damageTaken: totalDamageTaken, xpEarned, coinsEarned: 0, itemDropped: null } });

        const defeatEmbed = new EmbedBuilder()
          .setTitle(m.rpg_fight_defeat_title({ emoji: monster.emoji, name: monster.name }, { locale }))
          .setDescription(m.rpg_fight_defeat_desc({ name: monster.name, playerBar: buildHpBar(0, playerMaxHp), log: turnsLog.slice(-4).join('\n') }, { locale }))
          .setColor(COLORS.danger)
          .addFields(
            { name: m.rpg_fight_field_dmg_dealt({}, { locale }), value: `${totalDamageDealt}`, inline: true },
            { name: m.rpg_fight_field_dmg_taken({}, { locale }), value: `${totalDamageTaken}`, inline: true },
            { name: m.rpg_fight_field_xp_earned({}, { locale }), value: `+${xpEarned}`, inline: true },
          );

        await interaction.editReply({ embeds: [defeatEmbed], components: finalComponents });
      }
    } catch (err) {
      console.error(err);
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Boss (résolution instantanée, une fiche par boss)
// ─────────────────────────────────────────────────────────────

/** Boss par page. Une section chacune, comme le bestiaire. */
const BOSS_PAGE_SIZE = 6;

type BossReadiness =
  | { kind: 'ready' }
  | { kind: 'resting'; until: Date }
  | { kind: 'locked'; level: number };

type BossRow = {
  boss: Awaited<ReturnType<typeof listBosses>>[number];
  readiness: BossReadiness;
  kills: number;
};

function bossReadinessRank(readiness: BossReadiness): number {
  return readiness.kind === 'ready' ? 0 : readiness.kind === 'resting' ? 1 : 2;
}

function discordTimestamp(date: Date): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:R>`;
}

function bossLine(row: BossRow, currencyEmoji: string, locale: Locale): string {
  const { boss, readiness } = row;
  const status = readiness.kind === 'ready'
    ? `${icon('success')} ${m.rpg_boss_status_ready({}, { locale })}`
    : readiness.kind === 'resting'
      ? `${icon('rpgRest')} ${m.rpg_boss_status_resting({ when: discordTimestamp(readiness.until) }, { locale })}`
      : `${icon('lock')} ${m.rpg_boss_status_locked({ level: readiness.level }, { locale })}`;
  const sheet = `${icon('star')} ${boss.level} · ${icon('rpgHp')} ${boss.health} · ${icon('rpgAtk')} ${boss.attack} · ${icon('rpgDef')} ${boss.defense}`;
  const gains = `${icon('rpgXp')} ${boss.xpReward} XP · ${boss.coinReward} ${currencyEmoji}`
    + (boss.bossRespawnHours ? ` · ${m.rpg_boss_respawn_every({ hours: boss.bossRespawnHours }, { locale })}` : '')
    + (row.kills > 0 ? ` · ${m.rpg_boss_kills({ count: row.kills }, { locale })}` : '');
  return `${boss.emoji} **${boss.name}**\n${status}\n${sheet}\n-# ${gains}`;
}

/**
 * Salle des boss : chacun avec son état pour ce joueur, et le délai commun en tête.
 *
 * Les deux attentes (le repos d'un boss vaincu, et la pause entre deux boss) ne se
 * découvraient qu'en tentant le combat. Les horodatages relatifs de Discord se mettent à
 * jour seuls : le joueur voit le compte à rebours sans rafraîchir l'écran.
 */
async function buildBossSelectView(guildId: string, ownerId: string, locale: Locale, page = 0): Promise<PanelView> {
  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.rpgEnabled) {
    const embed = errorEmbed(m.rpg_travel_disabled_title({}, { locale }), m.rpg_boss_disabled_desc({}, { locale }));
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  const bosses = await listBosses(guildId);
  if (bosses.length === 0) {
    const embed = errorEmbed(m.rpg_boss_not_found_title({}, { locale }), m.rpg_hub_boss_none({}, { locale }));
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  const [profile, wins] = await Promise.all([
    getOrCreateRpgProfile(guildId, ownerId),
    prisma.rpgBattle.groupBy({
      by: ['monsterId'],
      where: { guildId, userId: ownerId, won: true, monsterId: { in: bosses.map((boss) => boss.id) } },
      _count: { _all: true },
      _max: { createdAt: true },
    }),
  ]);
  const winsByBoss = new Map(wins.map((row) => [row.monsterId, row]));

  const now = Date.now();
  const rows: BossRow[] = bosses.map((boss) => {
    const record = winsByBoss.get(boss.id);
    const lastWin = record?._max.createdAt;
    let readiness: BossReadiness = { kind: 'ready' };
    if (profile.level < boss.level) {
      readiness = { kind: 'locked', level: boss.level };
    } else if (boss.bossRespawnHours && boss.bossRespawnHours > 0 && lastWin) {
      const until = lastWin.getTime() + boss.bossRespawnHours * 60 * 60 * 1000;
      if (until > now) readiness = { kind: 'resting', until: new Date(until) };
    }
    return { boss, readiness, kills: record?._count._all ?? 0 };
  });
  rows.sort((a, b) =>
    bossReadinessRank(a.readiness) - bossReadinessRank(b.readiness)
    || (a.readiness.kind === 'resting' && b.readiness.kind === 'resting' ? a.readiness.until.getTime() - b.readiness.until.getTime() : 0)
    || a.boss.level - b.boss.level);

  const pauseMs = remainingCooldownMs(profile.lastBossBattle, bossCooldownMs(config));
  const pauseLine = pauseMs > 0
    ? `${icon('rpgRest')} ${m.rpg_boss_pause_until({ when: discordTimestamp(new Date(now + pauseMs)) }, { locale })}`
    : `${icon('success')} ${m.rpg_boss_pause_none({}, { locale })}`;
  const energyLine = `${icon('rpgEnergy')} ${m.rpg_boss_energy_line({ energy: profile.energy, cost: BOSS_ENERGY_COST }, { locale })}`;

  const pageCount = Math.max(1, Math.ceil(rows.length / BOSS_PAGE_SIZE));
  const current = Math.min(Math.max(0, page), pageCount - 1);
  const shown = rows.slice(current * BOSS_PAGE_SIZE, current * BOSS_PAGE_SIZE + BOSS_PAGE_SIZE);

  const container = new ContainerBuilder().setAccentColor(RPG_COLORS.combat);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `## ${icon('rpgBoss')} ${m.rpg_hub_boss_select_title({}, { locale })}\n${pauseLine}\n${energyLine}`,
  ));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));

  for (const row of shown) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(truncate(bossLine(row, config.currencyEmoji, locale), 450)))
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`rpg:bossfight:${ownerId}:${row.boss.id}`)
            .setLabel(m.rpg_boss_fight_btn({}, { locale }))
            .setStyle(ButtonStyle.Danger)
            // Le manque d'énergie ou de PV ne désactive rien : le clic ouvre alors le menu
            // des potions, qui règle le problème sur place.
            .setDisabled(row.readiness.kind !== 'ready' || pauseMs > 0),
        ),
    );
  }

  const navRow = new ActionRowBuilder<ButtonBuilder>();
  if (pageCount > 1) {
    navRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`rpg:nav:${ownerId}:boss:${current - 1}`)
        .setLabel(m.rpg_shop_prev({}, { locale }))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(current <= 0),
      new ButtonBuilder()
        .setCustomId(`rpg:noop:${ownerId}`)
        .setLabel(`${current + 1} / ${pageCount}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`rpg:nav:${ownerId}:boss:${current + 1}`)
        .setLabel(m.rpg_shop_next({}, { locale }))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(current >= pageCount - 1),
    );
  }
  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:boss:${current}`)
      .setLabel(m.rpg_boss_refresh_btn({}, { locale }))
      .setEmoji(icon('rpgRefresh'))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:hub`)
      .setLabel(m.rpg_hub_btn_back({}, { locale }))
      .setEmoji(icon('rpgBack'))
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [], components: [navRow], container };
}

// Sans délai entre deux boss, plus rien ne sérialise les combats d'un même joueur : deux
// sélections simultanées du même boss passeraient toutes deux le contrôle de respawn,
// qui ne voit la victoire qu'une fois le premier combat enregistré.
const bossFightsInFlight = new Set<string>();

async function handleBossSelect(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
  bossId: string,
): Promise<void> {
  const key = `${guildId}:${ownerId}`;
  if (bossFightsInFlight.has(key)) {
    await interaction.deferUpdate().catch(() => null);
    return;
  }
  bossFightsInFlight.add(key);
  try {
    await runBossFight(interaction, guildId, ownerId, locale, bossId);
  } finally {
    bossFightsInFlight.delete(key);
  }
}

async function runBossFight(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
  bossId: string,
): Promise<void> {
  const boss = await findGuildMonsterById(guildId, bossId);
  if (!boss || !boss.isBoss) {
    await replyPanelError(interaction, new Error(m.rpg_boss_not_found_desc({ name: bossId }, { locale })), locale);
    return;
  }

  const config = await getOrCreateEconomyConfig(guildId);
  const profile = await getOrCreateRpgProfile(guildId, ownerId);
  const cooldownMs = bossCooldownMs(config);

  const remainingMs = remainingCooldownMs(profile.lastBossBattle, cooldownMs);
  if (remainingMs > 0) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_boss_cooldown_title({}, { locale }), m.rpg_boss_cooldown_desc({ wait: formatCooldown(remainingMs) }, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  if (profile.level < boss.level) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_boss_low_level_title({}, { locale }), m.rpg_boss_low_level_desc({ level: boss.level, myLevel: profile.level }, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }
  if (profile.energy < BOSS_ENERGY_COST) {
    await replyVitalsAlert(interaction, guildId, ownerId, locale, errorEmbed(m.rpg_boss_low_energy_title({}, { locale }), m.rpg_boss_low_energy_desc({ energy: profile.energy }, { locale })), 'energy');
    return;
  }
  if (profile.health <= BOSS_MIN_HEALTH) {
    await replyVitalsAlert(interaction, guildId, ownerId, locale, errorEmbed(m.rpg_boss_low_hp_title({}, { locale }), m.rpg_boss_low_hp_desc({}, { locale })), 'hp');
    return;
  }

  // `bossRespawnHours` existait dans le schéma mais n'était jamais appliqué : le même boss
  // pouvait être farmé en boucle. Le respawn est par joueur, calculé sur sa dernière victoire.
  if (boss.bossRespawnHours && boss.bossRespawnHours > 0) {
    const respawnMs = boss.bossRespawnHours * 60 * 60 * 1000;
    const lastWin = await prisma.rpgBattle.findFirst({
      where: { guildId, userId: ownerId, monsterId: boss.id, won: true },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    if (lastWin) {
      const remainingMs = respawnMs - (Date.now() - lastWin.createdAt.getTime());
      if (remainingMs > 0) {
        await interaction.reply({
          embeds: [errorEmbed(
            m.rpg_boss_respawn_title({}, { locale }),
            m.rpg_boss_respawn_desc({
              name: boss.name,
              hours: Math.floor(remainingMs / (60 * 60 * 1000)),
              minutes: Math.ceil((remainingMs % (60 * 60 * 1000)) / (60 * 1000)),
            }, { locale }),
          )],
          flags: [MessageFlags.Ephemeral],
        });
        return;
      }
    }
  }

  // Les boss ont leur propre verrou, réglé par `bossCooldownMin` : à 0, le serveur laisse
  // enchaîner des boss différents, le respawn ci-dessus empêchant toujours de refaire le même.
  const battleLockedAt = new Date();
  const energySpent = await prisma.rpgProfile.updateMany({
    where: {
      guildId,
      userId: ownerId,
      energy: { gte: BOSS_ENERGY_COST },
      OR: [
        { lastBossBattle: null },
        { lastBossBattle: { lte: new Date(battleLockedAt.getTime() - cooldownMs) } },
      ],
    },
    data: { energy: { decrement: BOSS_ENERGY_COST }, lastBossBattle: battleLockedAt },
  });
  if (energySpent.count === 0) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_boss_low_energy_title({}, { locale }), m.rpg_boss_low_energy_desc({ energy: profile.energy }, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  await interaction.deferUpdate();

  let result;
  try {
    result = await simulateBattle(profile, boss);
  } catch (err) {
    // Sans ce rattrapage, un échec de la simulation faisait perdre l'énergie déjà débitée.
    await prisma.rpgProfile.update({
      where: { guildId_userId: { guildId, userId: ownerId } },
      data: { energy: { increment: BOSS_ENERGY_COST }, lastBossBattle: profile.lastBossBattle },
    }).catch(() => null);
    throw err;
  }
  const teamPoints = result.won
    ? await awardMonsterTeamPoints(guildId, ownerId, boss, interaction.client)
    : { amount: 0, toGuild: false };
  const campaign = result.won
    ? await trackCombatQuests(interaction.client, guildId, ownerId, boss.isBoss, result.itemDropped)
    : null;
  const firstKill = result.won
    ? await firstKillField(interaction.client, guildId, ownerId, boss, locale)
    : null;
  const winTitle = result.won ? await winTitleField(guildId, ownerId, boss, locale) : null;
  const sellRow = result.won
    ? await lootSellRow(guildId, ownerId, result.itemDropped, locale, true)
    : null;

  const turnSummary = result.turns.slice(-8).map((t) => {
    const who = t.attacker === 'player' ? m.rpg_boss_you_label({}, { locale }) : `${boss.emoji} ${boss.name}`;
    const crit = t.critical ? m.rpg_fight_critical_suffix({}, { locale }) : '';
    return m.rpg_boss_turn_log({ who, dmg: t.damage, crit }, { locale });
  }).join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`${result.won ? m.rpg_boss_won_title({}, { locale }) : m.rpg_boss_lost_title({}, { locale })} - ${boss.emoji} ${boss.name}`)
    .setDescription(`${boss.description}\n\n${m.rpg_boss_combat_summary_label({ turns: result.turns.length }, { locale })}\n${turnSummary}`)
    .setColor(result.won ? COLORS.success : COLORS.danger)
    .addFields(
      { name: m.rpg_fight_field_dmg_dealt({}, { locale }), value: `${result.totalDamageDealt}`, inline: true },
      { name: m.rpg_fight_field_dmg_taken({}, { locale }), value: `${result.totalDamageTaken}`, inline: true },
      { name: m.rpg_fight_field_hp_remaining({}, { locale }), value: `${result.playerHpRemaining} / ${profile.maxHealth}`, inline: true },
      { name: m.rpg_fight_field_xp_earned({}, { locale }), value: `+${result.xpEarned}`, inline: true },
      { name: m.rpg_fight_field_coins_earned({ emoji: config.currencyEmoji }, { locale }), value: `+${result.coinsEarned}`, inline: true },
    );

  if (result.itemDropped) embed.addFields({ name: m.rpg_boss_field_drop({}, { locale }), value: `${result.itemDropEmoji || '📦'} **${result.itemDropped}**` });
  if (teamPoints.amount > 0) {
    embed.addFields({
      name: teamPoints.toGuild ? m.rpg_fight_field_guild_xp({}, { locale }) : m.rpg_fight_field_clan_points({}, { locale }),
      value: `+${teamPoints.amount}`,
      inline: true,
    });
  }
  if (result.firstWinBonus) embed.addFields(firstWinField(locale));
  if (firstKill) embed.addFields(firstKill);
  if (winTitle) embed.addFields(winTitle);
  if (result.levelUp) embed.addFields({ name: m.rpg_fight_field_levelup({}, { locale }), value: m.rpg_fight_field_levelup_desc({ level: result.levelUp }, { locale }) });

  const campaignNote = campaign ? campaignAdvanceNote(campaign, locale) : '';
  if (campaignNote) embed.setFooter({ text: campaignNote });

  // Un boss se choisit dans leur liste : c'est là que le retour ramène, pas au hub.
  const back = fightBackRow(ownerId, locale, true);
  await interaction.editReply({ embeds: [embed], components: sellRow ? [sellRow, back] : [back] });
}

// ─────────────────────────────────────────────────────────────
// Donjons
// ─────────────────────────────────────────────────────────────

function dungeonRefusalText(refusal: DungeonRefusal, locale: Locale): string {
  switch (refusal.kind) {
    case 'not_found': return m.rpg_dungeon_refused_not_found({}, { locale });
    case 'disabled': return m.rpg_dungeon_refused_disabled({}, { locale });
    case 'broken': return m.rpg_dungeon_refused_broken({}, { locale });
    case 'level': return m.rpg_dungeon_refused_level({ level: refusal.level }, { locale });
    case 'cooldown': return m.rpg_dungeon_refused_cooldown({ when: discordTimestamp(refusal.readyAt) }, { locale });
    case 'energy': return m.rpg_dungeon_refused_energy({ cost: refusal.cost, energy: refusal.energy }, { locale });
    case 'health': return m.rpg_dungeon_refused_health({}, { locale });
    case 'active_run': return m.rpg_dungeon_refused_active({}, { locale });
    case 'expired': return m.rpg_dungeon_refused_expired({ minutes: DUNGEON_IDLE_TIMEOUT_MINUTES }, { locale });
    case 'stale': return m.rpg_dungeon_refused_stale({}, { locale });
  }
}

/**
 * Refus d'entrer ou de combattre. Le manque de PV ou d'énergie ouvre le menu des potions,
 * comme pour les boss.
 */
async function replyDungeonRefusal(
  interaction: ButtonInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
  refusal: DungeonRefusal,
): Promise<void> {
  const text = dungeonRefusalText(refusal, locale);

  // L'écran est redessiné dans son état réel : la partie si elle se joue encore, la salle
  // sinon. Passer par la salle clorait une partie en cours, ce qu'un double clic ne doit pas faire.
  if (refusal.kind === 'stale' || refusal.kind === 'active_run' || refusal.kind === 'expired') {
    await respond(interaction, withNote(await buildDungeonCurrentView(guildId, ownerId, locale), text));
    return;
  }
  if (refusal.kind === 'energy' || refusal.kind === 'health') {
    const title = refusal.kind === 'energy' ? m.rpg_dungeon_low_energy_title({}, { locale }) : m.rpg_dungeon_low_hp_title({}, { locale });
    await replyVitalsAlert(interaction, guildId, ownerId, locale, errorEmbed(title, text), refusal.kind === 'energy' ? 'energy' : 'hp');
    return;
  }
  await interaction.followUp({ embeds: [errorEmbed(m.rpg_dungeon_refused_title({}, { locale }), text)], flags: [MessageFlags.Ephemeral] });
}

function dungeonStatusLine(entry: DungeonHallEntry, playerLevel: number, locale: Locale): string {
  if (!entry.playable) return `${icon('lock')} ${m.rpg_dungeon_status_broken({}, { locale })}`;
  if (playerLevel < entry.dungeon.levelRequired) return `${icon('lock')} ${m.rpg_dungeon_status_locked({ level: entry.dungeon.levelRequired }, { locale })}`;
  if (entry.readyAt) return `${icon('rpgRest')} ${m.rpg_dungeon_status_cooldown({ when: discordTimestamp(entry.readyAt) }, { locale })}`;
  return `${icon('success')} ${m.rpg_dungeon_status_ready({}, { locale })}`;
}

/** Coffre, et premier vainqueur ou prime qui l'attend encore : ce qui donne envie d'y aller. */
function dungeonRewardLines(dungeon: DungeonHallEntry['dungeon'], currencyEmoji: string, locale: Locale): string[] {
  const chest = formatFirstKillReward({
    coins: dungeon.completionCoins,
    xp: dungeon.completionXp,
    itemName: dungeon.completionItemName,
    teamPoints: 0,
    toGuild: false,
    roleId: dungeon.completionRoleId,
    titleName: dungeon.completionTitle?.name ?? null,
  }, currencyEmoji, locale);

  const lines = chest ? [`-# ${m.rpg_dungeon_chest_line({ reward: chest }, { locale })}`] : [];
  if (dungeon.firstClearUserId) {
    lines.push(`-# ${m.rpg_dungeon_first_clear_line({ user: `<@${dungeon.firstClearUserId}>` }, { locale })}`);
  } else if (hasFirstClearReward(dungeon)) {
    const bounty = formatFirstKillReward({
      coins: dungeon.firstClearCoins,
      xp: dungeon.firstClearXp,
      itemName: dungeon.firstClearItemName,
      teamPoints: 0,
      toGuild: false,
      roleId: dungeon.firstClearRoleId,
      titleName: dungeon.firstClearTitle?.name ?? null,
    }, currencyEmoji, locale);
    lines.push(`-# ${m.rpg_dungeon_first_clear_bounty_line({ reward: bounty }, { locale })}`);
  }
  return lines;
}

function dungeonHallLine(entry: DungeonHallEntry, playerLevel: number, currencyEmoji: string, locale: Locale): string {
  const { dungeon } = entry;
  const meta = m.rpg_dungeon_meta({ floors: entry.floors.length, level: dungeon.levelRequired, energy: dungeon.energyCost }, { locale })
    + (entry.clears > 0 ? ` · ${m.rpg_dungeon_clears({ count: entry.clears }, { locale })}` : '');
  const bosses = entry.floors.map((floor) => floor.boss?.emoji ?? icon('lock')).join(' ');
  return [
    `${dungeon.emoji} **${dungeon.name}**`,
    dungeon.description ? truncate(dungeon.description, DUNGEON_DESCRIPTION_SHOWN) : null,
    dungeonStatusLine(entry, playerLevel, locale),
    `-# ${meta}`,
    `-# ${bosses}`,
    ...dungeonRewardLines(dungeon, currencyEmoji, locale),
  ].filter((line): line is string => line !== null).join('\n');
}

/**
 * Donjons par page, et place de chacun. Un message en Components V2 ne porte que 4000
 * caractères de texte en tout : quatre fiches de 750, plus l'en-tête, y tiennent même avec
 * un coffre, une prime et des emojis de boss personnalisés.
 */
const DUNGEON_PAGE_SIZE = 4;
const DUNGEON_LINE_MAX = 750;
const DUNGEON_DESCRIPTION_SHOWN = 150;

/**
 * Salle des donjons.
 *
 * Une partie ne se reprend pas : arriver ici alors qu'elle est ouverte, c'est avoir quitté
 * le donjon, et elle est soldée comme une sortie avec le butin. L'écran de la partie n'a pas
 * de bouton de retour, si bien qu'on n'y arrive que par un autre message ou par le menu.
 */
async function buildDungeonHallView(guildId: string, ownerId: string, locale: Locale, page = 0): Promise<PanelView> {
  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.rpgEnabled) {
    const embed = errorEmbed(m.rpg_travel_disabled_title({}, { locale }), m.rpg_boss_disabled_desc({}, { locale }));
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  let note = '';
  const active = await getActiveDungeonRun(guildId, ownerId);
  if (active) {
    try {
      const settlement = await leaveDungeon(guildId, ownerId, active.run.id);
      return withNote(
        buildDungeonSettlementView(ownerId, locale, config.currencyEmoji, settlement, null),
        m.rpg_dungeon_left_by_navigation({}, { locale }),
      );
    } catch (err) {
      if (!(err instanceof DungeonRefused)) throw err;
      if (err.refusal.kind === 'expired') note = dungeonRefusalText(err.refusal, locale);
    }
  }

  const view = await buildDungeonHallPage(guildId, ownerId, locale, page);
  return note ? withNote(view, note) : view;
}

/** Partie en cours si elle se joue encore, salle des donjons sinon. */
async function buildDungeonCurrentView(guildId: string, ownerId: string, locale: Locale): Promise<PanelView> {
  const active = await getActiveDungeonRun(guildId, ownerId);
  if (active && !active.expired) return buildDungeonRunView(guildId, ownerId, locale, active);
  return buildDungeonHallView(guildId, ownerId, locale);
}

async function buildDungeonHallPage(guildId: string, ownerId: string, locale: Locale, page: number): Promise<PanelView> {
  const [hall, profile, config] = await Promise.all([
    getDungeonHall(guildId, ownerId),
    getOrCreateRpgProfile(guildId, ownerId),
    getOrCreateEconomyConfig(guildId),
  ]);
  if (hall.length === 0) {
    const embed = errorEmbed(m.rpg_dungeon_none_title({}, { locale }), m.rpg_dungeon_none_desc({}, { locale }));
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  const container = new ContainerBuilder().setAccentColor(RPG_COLORS.combat);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `## ${icon('rpgBoss')} ${m.rpg_dungeon_hall_title({}, { locale })}\n`
    + `${m.rpg_dungeon_hall_intro({ minutes: DUNGEON_IDLE_TIMEOUT_MINUTES }, { locale })}\n`
    + `${icon('rpgEnergy')} ${m.rpg_dungeon_hall_energy({ energy: profile.energy }, { locale })}`
    + `  ·  ${icon('rpgHp')} ${profile.health}`,
  ));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));

  const pageCount = Math.max(1, Math.ceil(hall.length / DUNGEON_PAGE_SIZE));
  const current = Math.min(Math.max(0, page), pageCount - 1);
  for (const entry of hall.slice(current * DUNGEON_PAGE_SIZE, current * DUNGEON_PAGE_SIZE + DUNGEON_PAGE_SIZE)) {
    const open = entry.playable && !entry.readyAt && profile.level >= entry.dungeon.levelRequired;
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(truncate(dungeonHallLine(entry, profile.level, config.currencyEmoji, locale), DUNGEON_LINE_MAX)))
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`rpg:dgenter:${ownerId}:${entry.dungeon.id}`)
            .setLabel(m.rpg_dungeon_enter_btn({}, { locale }))
            .setStyle(ButtonStyle.Danger)
            // Le manque d'énergie ou de PV ne désactive rien : le clic ouvre alors le menu
            // des potions, qui règle le problème sur place.
            .setDisabled(!open),
        ),
    );
  }

  const navRow = new ActionRowBuilder<ButtonBuilder>();
  if (pageCount > 1) {
    navRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`rpg:nav:${ownerId}:dungeon:${current - 1}`)
        .setLabel(m.rpg_shop_prev({}, { locale }))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(current <= 0),
      new ButtonBuilder()
        .setCustomId(`rpg:noop:${ownerId}`)
        .setLabel(`${current + 1} / ${pageCount}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`rpg:nav:${ownerId}:dungeon:${current + 1}`)
        .setLabel(m.rpg_shop_next({}, { locale }))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(current >= pageCount - 1),
    );
  }
  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:dungeon:${current}`)
      .setLabel(m.rpg_boss_refresh_btn({}, { locale }))
      .setEmoji(icon('rpgRefresh'))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:hub`)
      .setLabel(m.rpg_hub_btn_back({}, { locale }))
      .setEmoji(icon('rpgBack'))
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [], components: [navRow], container };
}

function dungeonFloorLines(state: DungeonRunState, locale: Locale): string {
  return state.floors.map((floor, index) => {
    const mark = index < state.run.floorsCleared
      ? icon('success')
      : index === state.run.floorsCleared ? icon('rpgFight') : icon('lock');
    return floor.boss
      ? m.rpg_dungeon_floor_line({ mark, index: index + 1, emoji: floor.boss.emoji, name: floor.boss.name, level: floor.boss.level }, { locale })
      : m.rpg_dungeon_floor_missing({ mark, index: index + 1, name: floor.bossName }, { locale });
  }).join('\n');
}

function dungeonLootText(loot: DungeonLoot[]): string {
  return groupDungeonLoot(loot)
    .map((entry) => `${entry.emoji ?? '📦'} ${entry.itemName}${entry.quantity > 1 ? ` ×${entry.quantity}` : ''}`)
    .join(', ');
}

function duelLog(result: DungeonFloorResult, locale: Locale): string {
  const turns = result.duel.turns.slice(-6).map((turn) => {
    const who = turn.attacker === 'player' ? m.rpg_boss_you_label({}, { locale }) : `${result.boss.emoji} ${result.boss.name}`;
    const crit = turn.critical ? m.rpg_fight_critical_suffix({}, { locale }) : '';
    return m.rpg_boss_turn_log({ who, dmg: turn.damage, crit }, { locale });
  });
  return `${m.rpg_boss_combat_summary_label({ turns: result.duel.turns.length }, { locale })}\n${turns.join('\n')}`;
}

/** Écran d'une partie en cours, avec le compte rendu de l'étage qui vient de tomber. */
async function buildDungeonRunView(
  guildId: string,
  ownerId: string,
  locale: Locale,
  state: DungeonRunState,
  lastFight: DungeonFloorResult | null = null,
): Promise<PanelView> {
  const [config, profile] = await Promise.all([getOrCreateEconomyConfig(guildId), getOrCreateRpgProfile(guildId, ownerId)]);
  const stats = await loadEffectiveStats(profile);
  const { run, dungeon } = state;
  const total = state.floors.length;
  const nextFloor = Math.min(run.floorsCleared + 1, total);

  const parts: string[] = [];
  if (lastFight?.gains) {
    const gains = m.rpg_dungeon_pending_value({ xp: lastFight.gains.xp, coins: lastFight.gains.coins, currency: config.currencyEmoji }, { locale });
    const drop = lastFight.gains.drop ? ` · ${m.rpg_dungeon_floor_drop({ item: `${lastFight.gains.drop.emoji ?? '📦'} ${lastFight.gains.drop.itemName}` }, { locale })}` : '';
    parts.push(`${m.rpg_dungeon_floor_won({ floor: lastFight.floorIndex + 1, emoji: lastFight.boss.emoji, name: lastFight.boss.name }, { locale })}\n-# ${gains}${drop}`);
    parts.push(duelLog(lastFight, locale));
  } else if (dungeon.description) {
    parts.push(dungeon.description);
  }

  parts.push(`${m.rpg_dungeon_floors_label({}, { locale })}\n${dungeonFloorLines(state, locale)}`);
  parts.push(`${m.rpg_dungeon_hp_label({}, { locale })}\n${buildHpBar(Math.min(profile.health, stats.maxHealth), stats.maxHealth)}`);

  const pending = m.rpg_dungeon_pending_value({ xp: run.xpEarned, coins: run.coinsEarned, currency: config.currencyEmoji }, { locale });
  const items = dungeonLootText(state.loot);
  parts.push(`${m.rpg_dungeon_pending_label({}, { locale })}\n${pending}${items ? `\n${items}` : ''}`);
  parts.push(`-# ${m.rpg_dungeon_run_rules({ minutes: DUNGEON_IDLE_TIMEOUT_MINUTES }, { locale })}`);

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_dungeon_run_title({ emoji: dungeon.emoji, name: dungeon.name, floor: nextFloor, total }, { locale }))
    // L'écran passe en Components V2, où tout le texte du message tient en 4000 caractères.
    .setDescription(truncate(parts.join('\n\n'), 3500))
    .setColor(RPG_COLORS.combat);

  const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`rpg:dgfight:${ownerId}:${run.id}:${run.floorsCleared}`)
      .setLabel(m.rpg_dungeon_fight_btn({ floor: nextFloor }, { locale }))
      .setEmoji(icon('rpgFight'))
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!state.floors[run.floorsCleared]?.boss),
    new ButtonBuilder()
      .setCustomId(`rpg:dgleave:${ownerId}:${run.id}`)
      .setLabel(m.rpg_dungeon_leave_btn({}, { locale }))
      .setEmoji(icon('rpgBag'))
      .setStyle(ButtonStyle.Success),
  );

  // Pas de retour au hub : quitter l'écran ne mettrait pas la partie en pause, et le seul
  // chemin de sortie doit être celui qui dit ce qu'il coûte.
  const potions = await quickDrinkRow(guildId, ownerId, locale, 'dungeon', 'hp');
  return {
    embeds: [embed],
    components: [actions, ...(potions ? [potions] : [])],
  };
}

function buildDungeonSettlementView(
  ownerId: string,
  locale: Locale,
  currencyEmoji: string,
  settlement: DungeonSettlement,
  lastFight: DungeonFloorResult | null,
): PanelView {
  const { dungeon } = settlement;
  const total = settlement.totalFloors;

  const title = settlement.outcome === 'COMPLETED'
    ? m.rpg_dungeon_completed_title({ emoji: dungeon.emoji, name: dungeon.name }, { locale })
    : settlement.outcome === 'LEFT'
      ? m.rpg_dungeon_left_title({ emoji: dungeon.emoji, name: dungeon.name }, { locale })
      : m.rpg_dungeon_defeat_title({ emoji: dungeon.emoji, name: dungeon.name }, { locale });

  const summary = settlement.outcome === 'COMPLETED'
    ? m.rpg_dungeon_completed_desc({ floors: total }, { locale })
    : settlement.outcome === 'LEFT'
      ? m.rpg_dungeon_left_desc({ floors: settlement.floorsCleared, total }, { locale })
      : m.rpg_dungeon_defeat_desc({
        boss: lastFight ? `${lastFight.boss.emoji} ${lastFight.boss.name}` : '',
        floor: (lastFight?.floorIndex ?? settlement.floorsCleared) + 1,
      }, { locale });

  const description = [summary, lastFight ? duelLog(lastFight, locale) : null]
    .filter((part): part is NonNullable<typeof part> => part !== null)
    .join('\n\n');

  const embed = new EmbedBuilder()
    .setTitle(title)
    // Les champs du coffre, du butin et de la prime s'ajoutent à ce texte dans les 4000
    // caractères d'un message en Components V2.
    .setDescription(truncate(description, 2500))
    .setColor(settlement.outcome === 'DEFEATED' ? COLORS.danger : COLORS.success);

  if (settlement.outcome !== 'DEFEATED') {
    embed.addFields(
      { name: m.rpg_fight_field_xp_earned({}, { locale }), value: `+${settlement.xp}`, inline: true },
      { name: m.rpg_fight_field_coins_earned({ emoji: currencyEmoji }, { locale }), value: `+${settlement.coins}`, inline: true },
    );
    if (settlement.items.length > 0) {
      const lines = settlement.items.map((entry) => {
        const label = `${entry.emoji ?? '📦'} ${entry.itemName}${entry.quantity > 1 ? ` ×${entry.quantity}` : ''}`;
        return entry.granted ? label : m.rpg_dungeon_item_missing({ item: label }, { locale });
      });
      embed.addFields({ name: m.rpg_dungeon_field_items({}, { locale }), value: truncate(lines.join('\n'), 1024) });
    }
  }
  // Titre et rôle du coffre : les pièces, l'XP et les objets ont déjà leurs champs.
  const chestExtras = formatFirstKillReward({
    coins: 0,
    xp: 0,
    itemName: null,
    teamPoints: 0,
    toGuild: false,
    roleId: settlement.chestRoleId,
    titleName: settlement.chestTitleName,
  }, currencyEmoji, locale);
  if (chestExtras) embed.addFields({ name: m.rpg_dungeon_field_chest({}, { locale }), value: chestExtras });

  // Le compte rendu met à jour l'écran de la partie, il n'ajoute aucun message au salon :
  // le joueur apprend qu'il est le premier même sans prime, comme au bestiaire. Seule
  // l'annonce dans le salon des premiers vainqueurs se tait dans ce cas.
  if (settlement.firstClear) {
    const bounty = formatFirstKillReward(settlement.firstClear, currencyEmoji, locale);
    embed.addFields({
      name: m.rpg_dungeon_field_first_clear({}, { locale }),
      value: bounty || m.rpg_dungeon_first_clear_no_bounty({}, { locale }),
    });
  }

  if (settlement.levelUp) {
    embed.addFields({ name: m.rpg_fight_field_levelup({}, { locale }), value: m.rpg_fight_field_levelup_desc({ level: settlement.levelUp }, { locale }) });
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:dungeon`)
      .setLabel(m.rpg_dungeon_back_btn({}, { locale }))
      .setEmoji(icon('rpgBoss'))
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:hub`)
      .setLabel(m.rpg_hub_btn_back({}, { locale }))
      .setEmoji(icon('rpgBack'))
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

async function handleDungeonEnter(interaction: ButtonInteraction, guildId: string, ownerId: string, locale: Locale, dungeonId: string): Promise<void> {
  try {
    await enterDungeon(guildId, ownerId, dungeonId);
  } catch (err) {
    if (err instanceof DungeonRefused) {
      await replyDungeonRefusal(interaction, guildId, ownerId, locale, err.refusal);
      return;
    }
    throw err;
  }

  await respond(interaction, await buildDungeonCurrentView(guildId, ownerId, locale));
}

async function handleDungeonFight(
  interaction: ButtonInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
  runId: string,
  floorRaw: string,
): Promise<void> {
  const floor = Number.parseInt(floorRaw ?? '', 10);
  let result: DungeonFloorResult;
  try {
    if (!Number.isInteger(floor) || floor < 0) throw new DungeonRefused({ kind: 'stale' });
    result = await fightDungeonFloor(interaction.client, guildId, ownerId, runId, floor);
  } catch (err) {
    if (err instanceof DungeonRefused) {
      await replyDungeonRefusal(interaction, guildId, ownerId, locale, err.refusal);
      return;
    }
    throw err;
  }

  if (result.duel.won) {
    // La campagne et les quêtes comptent le boss abattu, même si la partie finit mal : il
    // est bien tombé. Un incident ici ne doit pas masquer le compte rendu de l'étage.
    await trackCombatQuests(interaction.client, guildId, ownerId, true, null).catch((err) => {
      logger.warn('RpgPanel', `Suivi des quêtes après un étage de donjon en échec pour ${ownerId} :`, err);
    });
  }

  if (result.settlement) {
    const config = await getOrCreateEconomyConfig(guildId);
    await respond(interaction, buildDungeonSettlementView(ownerId, locale, config.currencyEmoji, result.settlement, result));
    return;
  }

  const state = await getActiveDungeonRun(guildId, ownerId);
  if (!state) {
    await respond(interaction, await buildDungeonCurrentView(guildId, ownerId, locale));
    return;
  }
  await respond(interaction, await buildDungeonRunView(guildId, ownerId, locale, state, result));
}

async function handleDungeonLeave(interaction: ButtonInteraction, guildId: string, ownerId: string, locale: Locale, runId: string): Promise<void> {
  let settlement: DungeonSettlement;
  try {
    settlement = await leaveDungeon(guildId, ownerId, runId);
  } catch (err) {
    if (err instanceof DungeonRefused) {
      await replyDungeonRefusal(interaction, guildId, ownerId, locale, err.refusal);
      return;
    }
    throw err;
  }

  const config = await getOrCreateEconomyConfig(guildId);
  await respond(interaction, buildDungeonSettlementView(ownerId, locale, config.currencyEmoji, settlement, null));
}

// ─────────────────────────────────────────────────────────────
// Travail
// ─────────────────────────────────────────────────────────────

/** Récits de travail, tirés au sort. Ils viennent du catalogue de `/travailler`. */
const WORK_STORY_KEYS = [
  'b5_work_msg_1', 'b5_work_msg_2', 'b5_work_msg_3', 'b5_work_msg_4', 'b5_work_msg_5',
  'b5_work_msg_6', 'b5_work_msg_7', 'b5_work_msg_8', 'b5_work_msg_9', 'b5_work_msg_10',
] as const;

function workStory(locale: Locale): string {
  const key = WORK_STORY_KEYS[Math.floor(Math.random() * WORK_STORY_KEYS.length)];
  const messages = m as unknown as Record<string, (args: object, opts: { locale: Locale }) => string>;
  return messages[key]({}, { locale });
}

/**
 * Travailler depuis le hub.
 *
 * Le geste n'existait qu'en commande séparée (`/travailler`), alors qu'il appartient au
 * même tour de jeu que la quotidienne et la pêche, toutes deux déjà en boutons.
 */
async function handleWork(interaction: ButtonInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const result = await work(guildId, ownerId);

  if (result.cooldown) {
    await replyPanelError(
      interaction,
      new Error(m.b5_work_cooldown_desc({
        minutes: result.remainingMinutes ?? 0,
        seconds: result.remainingSeconds ?? 0,
      }, { locale })),
      locale,
    );
    return;
  }

  const config = await getOrCreateEconomyConfig(guildId);

  const embed = successEmbed(
    m.b5_work_done_title({}, { locale }),
    m.b5_work_done_desc({
      story: workStory(locale),
      salary: result.salary ?? 0,
      emoji: config.currencyEmoji,
      name: config.currencyName,
      xp: result.xpReward ?? 0,
    }, { locale }),
  ).addFields({
    name: m.b5_work_new_balance({}, { locale }),
    value: `**${result.newBalance}** ${config.currencyEmoji}`,
  });

  if (result.levelUp) {
    embed.addFields({
      name: m.b5_work_levelup_title({}, { locale }),
      value: m.b5_work_levelup_desc({ level: result.levelUp }, { locale }),
    });
  }

  await respond(interaction, { embeds: [embed], components: [backRow(ownerId, locale)] });
}

// ─────────────────────────────────────────────────────────────
// Quêtes
// ─────────────────────────────────────────────────────────────

/** Libellé d'un objectif de quête, dans la langue du lecteur. */
function questObjectiveLabel(objective: string, locale: Locale): string {
  const messages = m as unknown as Record<string, ((args: object, opts: { locale: Locale }) => string) | undefined>;
  // Le catalogue d'objectifs vit en base et peut contenir une valeur qu'aucune clé ne
  // traduit : on retombe sur le code brut plutôt que d'afficher un vide.
  return messages[`rpg_quest_objective_${objective.toLowerCase()}`]?.({}, { locale }) ?? objective;
}

/** Ligne d'une quête : sa consigne, son avancement et ce qu'elle rapporte. */
function questLine(quest: QuestView, locale: Locale): string {
  const done = quest.current >= quest.target;
  const marker = done ? '✅' : '▶️';

  const scope = quest.teamName
    ? m.rpg_quests_team_scope({ team: quest.teamName }, { locale })
    : m.rpg_quests_member_scope({}, { locale });

  const rewards = [
    quest.rewardCoins > 0 ? `${icon('coins')} ${quest.rewardCoins}` : null,
    quest.rewardXp > 0 ? `${icon('rpgXp')} ${quest.rewardXp} XP` : null,
    quest.rewardClanPoints > 0 ? `${icon('rpgClan')} ${quest.rewardClanPoints}` : null,
  ].filter((part): part is string => part !== null).join(' · ');

  return `${marker} ${quest.emoji} **${quest.name}** — ${questObjectiveLabel(quest.objective, locale)}\n`
    + `${gaugeBar(Math.min(quest.current, quest.target), quest.target, 'xp')} ${Math.min(quest.current, quest.target)}/${quest.target}\n`
    + `-# ${scope} · ${rewards || m.rpg_quests_no_reward({}, { locale })} · ${m.rpg_quests_ends({ ts: Math.floor(quest.endsAt.getTime() / 1000) }, { locale })}`;
}

/**
 * Les quêtes en cours, depuis le menu du hub.
 *
 * Elles ne se consultaient que par une commande à part : le joueur ne savait pas, en
 * jouant, qu'une quête comptait précisément ce qu'il était en train de faire.
 */
async function buildQuestsView(client: Client, guildId: string, ownerId: string, locale: Locale): Promise<PanelView> {
  const quests = await getMemberQuests(client, guildId, ownerId);

  const embed = new EmbedBuilder()
    .setTitle(`${icon('rpgKey')} ${m.rpg_quests_title({}, { locale })}`)
    .setColor(RPG_COLORS.hub);

  if (quests.length === 0) {
    embed.setDescription(m.rpg_quests_empty({}, { locale }));
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  // Ce qui reste à faire d'abord : une quête déjà remplie n'appelle aucune action.
  const sorted = [...quests].sort((a, b) =>
    Number(a.current >= a.target) - Number(b.current >= b.target)
    || b.current / b.target - a.current / a.target);

  embed
    .setDescription(m.rpg_quests_desc({ count: quests.length }, { locale }))
    .addFields({
      name: m.rpg_quests_field_running({}, { locale }),
      value: joinFieldEntries(
        sorted.map((quest) => questLine(quest, locale)),
        { separator: '\n\n', more: (count) => m.rpg_quests_more({ count }, { locale }) },
      ),
      inline: false,
    });

  return { embeds: [embed], components: [backRow(ownerId, locale)] };
}

// ─────────────────────────────────────────────────────────────
// Payer / Vendre
// ─────────────────────────────────────────────────────────────

/**
 * Écran de paiement : on désigne le destinataire dans la liste des membres.
 *
 * Il fallait auparavant taper une mention ou coller un identifiant dans une fenêtre de
 * saisie, sans la moindre vérification avant validation. Le sélecteur natif de Discord
 * apporte la recherche, l'avatar et le pseudo — et il ne peut désigner qu'un membre qui
 * existe vraiment.
 */
async function buildPayView(guildId: string, ownerId: string, locale: Locale): Promise<PanelView> {
  const profile = await getOrCreateRpgProfile(guildId, ownerId);
  const config = await getOrCreateEconomyConfig(guildId);

  const embed = new EmbedBuilder()
    .setTitle(`${icon('rpgPay')} ${m.rpg_hub_pay_modal_title({}, { locale })}`)
    .setDescription(m.rpg_pay_pick_desc({ balance: profile.balance, emoji: config.currencyEmoji }, { locale }))
    .setColor(RPG_COLORS.trade);

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId(`rpg:payto:${ownerId}`)
          .setPlaceholder(m.rpg_pay_select_placeholder({}, { locale }))
          .setMinValues(1)
          .setMaxValues(1),
      ) as unknown as PanelRow,
      backRow(ownerId, locale),
    ],
  };
}

/**
 * Fenêtre du montant. Le destinataire voyage dans le `customId`.
 *
 * Le faire ressaisir dans le formulaire annulerait tout le bénéfice du sélecteur.
 */
function buildPayAmountModal(ownerId: string, recipientId: string, recipientName: string, locale: Locale): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`rpg:paysubmit:${ownerId}:${recipientId}`)
    .setTitle(truncate(m.rpg_pay_amount_title({ name: recipientName }, { locale }), 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('montant')
          .setLabel(m.rpg_hub_pay_field_amount({}, { locale }))
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
    );
}

/** Le destinataire choisi ouvre la saisie du montant. */
async function handlePayRecipient(
  interaction: UserSelectMenuInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
): Promise<void> {
  const recipient = interaction.users.first();
  if (!recipient) return;

  // Les deux refus qui se voient tout de suite tombent ici : ouvrir la fenêtre pour
  // rejeter ensuite ferait saisir un montant pour rien.
  if (recipient.id === ownerId) {
    await replyPanelError(interaction, new Error(m.rpg_pay_no_self({}, { locale })), locale);
    return;
  }
  if (recipient.bot) {
    await replyPanelError(interaction, new Error(m.rpg_pay_no_bot({}, { locale })), locale);
    return;
  }

  await interaction.showModal(buildPayAmountModal(ownerId, recipient.id, recipient.displayName, locale));
}

async function handlePaySubmit(
  interaction: ModalSubmitInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
  client: Client,
  recipientId: string,
): Promise<void> {
  const amount = Number.parseInt(interaction.fields.getTextInputValue('montant'), 10);

  if (!recipientId) {
    await replyPanelError(interaction, new Error(m.rpg_hub_pay_invalid_recipient({}, { locale })), locale);
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    await replyPanelError(interaction, new Error(m.rpg_hub_invalid_amount({}, { locale })), locale);
    return;
  }
  if (recipientId === ownerId) {
    await replyPanelError(interaction, new Error(m.rpg_pay_no_self({}, { locale })), locale);
    return;
  }

  const recipient = await client.users.fetch(recipientId).catch(() => null);
  if (!recipient || recipient.bot) {
    await replyPanelError(interaction, new Error(m.rpg_pay_no_bot({}, { locale })), locale);
    return;
  }

  // On délègue à `transferCoins` plutôt que d'écrire les deux soldes à la main : le
  // transfert brut d'origine ignorait le plafond `maxTransferAmount`, le cooldown
  // `transferCooldownMin` et la garde atomique sur le solde du payeur.
  const transfer = await transferCoins(guildId, ownerId, recipient.id, amount);

  const config = await getOrCreateEconomyConfig(guildId);
  const embed = successEmbed(m.rpg_pay_success_title({}, { locale }), m.rpg_pay_success_desc({ amount, emoji: config.currencyEmoji, id: recipient.id }, { locale }))
    .addFields({ name: m.rpg_pay_field_your_balance({}, { locale }), value: `**${transfer.senderBalance}** ${config.currencyEmoji}` });

  await respond(interaction, { embeds: [embed], components: [backRow(ownerId, locale)] });
}

function buildSellModal(ownerId: string, locale: Locale): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(`rpg:sellsubmit:${ownerId}`).setTitle(m.rpg_hub_sell_modal_title({}, { locale }));
  const itemInput = new TextInputBuilder().setCustomId('objet').setLabel(m.rpg_hub_sell_field_item({}, { locale })).setStyle(TextInputStyle.Short).setRequired(true);
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(itemInput));
  return modal;
}

async function handleSellSubmit(interaction: ModalSubmitInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const query = interaction.fields.getTextInputValue('objet').trim().toLowerCase();
  const profile = await getOrCreateRpgProfile(guildId, ownerId);
  const inventory = profile.inventory as unknown as LocalInventoryEntry[];

  // Le nom exact d'abord, puis une correspondance partielle seulement si elle est unique :
  // « potion de vie » vendait au hasard la Mineure, la normale ou la Majeure.
  const exact = inventory.filter((e) => e.item.name.toLowerCase() === query);
  const partial = inventory.filter((e) => e.item.name.toLowerCase().includes(query));
  // Deux lignes du même nom exact (catalogue global et copie du serveur) désignent le même
  // objet aux yeux du joueur : l'une ou l'autre convient.
  const candidates = exact.length > 0 ? exact.slice(0, 1) : partial;

  if (candidates.length === 0) {
    await replyPanelError(interaction, new Error(m.rpg_sell_not_found_desc({ query }, { locale })), locale);
    return;
  }

  if (candidates.length > 1) {
    const names = candidates.slice(0, 10).map((e) => `« ${e.item.name} »`).join(', ');
    await replyPanelError(interaction, new Error(`Plusieurs objets correspondent : ${names}. Tapez le nom complet.`), locale);
    return;
  }

  const entry = candidates[0];

  const sellResult = await sellShopItem(guildId, ownerId, entry.item.id);
  const embed = successEmbed(m.rpg_sell_success_title({}, { locale }), m.rpg_sell_success_desc({ item: sellResult.itemName, price: sellResult.sellPrice }, { locale }))
    .addFields({ name: m.rpg_sell_new_balance({}, { locale }), value: `**${sellResult.newBalance}** 🪙` });

  await respond(interaction, { embeds: [embed], components: [backRow(ownerId, locale)] });
}

// ─────────────────────────────────────────────────────────────
// Admin
// ─────────────────────────────────────────────────────────────

async function buildAdminView(ownerId: string, locale: Locale): Promise<PanelView> {
  const embed = new EmbedBuilder()
    .setTitle(m.rpg_hub_admin_title({}, { locale }))
    .setDescription(m.rpg_hub_admin_desc({}, { locale }))
    .setColor(COLORS.warning);

  const resetSelect = new StringSelectMenuBuilder()
    .setCustomId(`rpg:adminresetselect:${ownerId}`)
    .setPlaceholder(m.rpg_hub_admin_reset_placeholder({}, { locale }))
    .addOptions(
      { label: m.rpg_hub_admin_reset_all({}, { locale }), value: 'all' },
      { label: m.rpg_hub_admin_reset_profiles({}, { locale }), value: 'profiles' },
      { label: m.rpg_hub_admin_reset_items({}, { locale }), value: 'items' },
      { label: m.rpg_hub_admin_reset_config({}, { locale }), value: 'config' },
      { label: m.rpg_hub_admin_reset_guilds({}, { locale }), value: 'guilds' },
    );

  const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rpg:adminsetopen:${ownerId}:balance`).setLabel(m.rpg_hub_admin_btn_balance({}, { locale })).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`rpg:adminsetopen:${ownerId}:level`).setLabel(m.rpg_hub_admin_btn_level({}, { locale })).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`rpg:adminsetopen:${ownerId}:xp`).setLabel(m.rpg_hub_admin_btn_xp({}, { locale })).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`rpg:admindropopen:${ownerId}`).setLabel(m.rpg_hub_admin_btn_drop({}, { locale })).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`rpg:nav:${ownerId}:hub`).setLabel(m.rpg_hub_btn_back({}, { locale })).setEmoji(icon('rpgBack')).setStyle(ButtonStyle.Secondary),
  );

  return {
    embeds: [embed],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(resetSelect), buttonRow],
  };
}

function buildAdminSetModal(ownerId: string, stat: AdminStat, locale: Locale): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(`rpg:adminsetsubmit:${ownerId}:${stat}`).setTitle(m.rpg_hub_admin_set_modal_title({ stat }, { locale }));
  const memberInput = new TextInputBuilder().setCustomId('membre').setLabel(m.rpg_hub_admin_field_member({}, { locale })).setStyle(TextInputStyle.Short).setPlaceholder('@membre ou ID').setRequired(true);
  const valueInput = new TextInputBuilder().setCustomId('valeur').setLabel(m.rpg_hub_admin_field_value({}, { locale })).setStyle(TextInputStyle.Short).setRequired(true);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(memberInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(valueInput),
  );
  return modal;
}

function buildAdminDropModal(ownerId: string, locale: Locale): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(`rpg:admindropsubmit:${ownerId}`).setTitle(m.rpg_hub_admin_drop_modal_title({}, { locale }));
  const typeInput = new TextInputBuilder().setCustomId('type').setLabel(m.rpg_hub_admin_drop_field_type({}, { locale })).setStyle(TextInputStyle.Short).setPlaceholder('COINS ou XP').setRequired(true);
  const amountInput = new TextInputBuilder().setCustomId('montant').setLabel(m.rpg_hub_admin_drop_field_amount({}, { locale })).setStyle(TextInputStyle.Short).setRequired(true);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(typeInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(amountInput),
  );
  return modal;
}

async function handleAdminResetSelect(interaction: StringSelectMenuInteraction, ownerId: string, locale: Locale): Promise<void> {
  if (!isInteractionAdmin(interaction)) {
    await interaction.reply({ content: m.rpg_hub_admin_only({}, { locale }), flags: [MessageFlags.Ephemeral] });
    return;
  }

  const component = interaction.values[0] as 'all' | 'profiles' | 'items' | 'config' | 'guilds';

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_admin_reset_confirm_title({}, { locale }))
    .setDescription(m.rpg_admin_reset_confirm_desc({ component }, { locale }))
    .setColor(COLORS.warning);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rpg_reset_confirm:${component}`).setLabel(m.rpg_admin_reset_confirm_button({}, { locale })).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('rpg_reset_cancel').setLabel(m.rpg_admin_reset_cancel_button({}, { locale })).setStyle(ButtonStyle.Secondary),
  );

  await respond(interaction, { embeds: [embed], components: [row] });
}

async function handleAdminSetSubmit(interaction: ModalSubmitInteraction, guildId: string, ownerId: string, stat: AdminStat, locale: Locale): Promise<void> {
  if (!isInteractionAdmin(interaction)) {
    await interaction.reply({ content: m.rpg_hub_admin_only({}, { locale }), flags: [MessageFlags.Ephemeral] });
    return;
  }

  const memberText = interaction.fields.getTextInputValue('membre');
  const value = Number.parseInt(interaction.fields.getTextInputValue('valeur'), 10);
  const targetId = parseUserIdFromText(memberText);

  if (!targetId || !Number.isFinite(value)) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_admin_modify_error_title({}, { locale }), m.rpg_hub_pay_invalid_recipient({}, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  await adminSetStats(guildId, targetId, { [stat]: value });
  await interaction.reply({ embeds: [successEmbed(m.rpg_admin_stats_updated_title({}, { locale }), m.rpg_admin_balance_set_desc({ id: targetId, value }, { locale }))], flags: [MessageFlags.Ephemeral] });
}

async function handleAdminDropSubmit(interaction: ModalSubmitInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  if (!isInteractionAdmin(interaction)) {
    await interaction.reply({ content: m.rpg_hub_admin_only({}, { locale }), flags: [MessageFlags.Ephemeral] });
    return;
  }

  const typeRaw = interaction.fields.getTextInputValue('type').trim().toUpperCase();
  const amount = Number.parseInt(interaction.fields.getTextInputValue('montant'), 10);
  const type = typeRaw === 'XP' ? 'XP' : 'COINS';

  if (!Number.isFinite(amount) || amount <= 0) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_drop_error_title({}, { locale }), m.rpg_hub_invalid_amount({}, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  const drop = await prisma.rpgDrop.create({ data: { guildId, amount, type } });
  const resourceName = type === 'COINS' ? m.rpg_drop_resource_coins({}, { locale }) : m.rpg_drop_resource_xp({}, { locale });

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_drop_title({}, { locale }))
    .setDescription(m.rpg_drop_desc({ amount, resource: resourceName }, { locale }))
    .setColor(COLORS.primary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rpg_drop_claim:${drop.id}`).setLabel(m.rpg_drop_claim_button({}, { locale })).setStyle(ButtonStyle.Success),
  );

  if (interaction.channel?.isSendable()) {
    await interaction.channel.send({ embeds: [embed], components: [row] });
  }

  await interaction.reply({ content: m.rpg_hub_admin_drop_posted({}, { locale }), flags: [MessageFlags.Ephemeral] });
}

// ─────────────────────────────────────────────────────────────
// Personnage - classe & points de caractéristiques
// ─────────────────────────────────────────────────────────────

/** Bonus d'un titre : en icônes pour un texte, en mots pour une option de menu. */
function titleBonusText(
  title: Parameters<typeof titleBonusParts>[0],
  locale: Locale,
  plain = false,
): string {
  const labels = {
    atk: plain ? m.rpg_title_stat_atk({}, { locale }) : icon('rpgAtk'),
    def: plain ? m.rpg_title_stat_def({}, { locale }) : icon('rpgDef'),
    spd: plain ? m.rpg_title_stat_spd({}, { locale }) : icon('rpgSpd'),
    hp: plain ? m.rpg_title_stat_hp({}, { locale }) : icon('rpgHp'),
    crit: plain ? m.rpg_title_stat_crit({}, { locale }) : icon('rpgCrit'),
  };
  return titleBonusParts(title)
    .map(({ stat, value }) => `${labels[stat]} +${value}${stat === 'crit' ? ' %' : ''}`)
    .join(plain ? ' · ' : '  ');
}

/**
 * Menu du titre porté, partagé par la fiche Personnage et l'inventaire.
 *
 * Un seul titre se porte à la fois : ses bonus ne s'additionnent pas à ceux des autres.
 * `origin` dit quel écran réafficher après le changement.
 */
function titleSelectRow(
  ownerId: string,
  activeTitleId: string | null,
  ownedTitles: Awaited<ReturnType<typeof listOwnedTitles>>,
  origin: 'character' | 'inventory',
  locale: Locale,
): ActionRowBuilder<StringSelectMenuBuilder> | null {
  if (ownedTitles.length === 0) return null;

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`rpg:titleselect:${ownerId}:${origin}`)
      .setPlaceholder(m.rpg_character_title_placeholder({}, { locale }))
      .addOptions(
        {
          label: m.rpg_character_title_remove({}, { locale }),
          value: 'none',
          default: activeTitleId === null,
        },
        // Le titre porté passe en tête : au-delà de vingt-quatre titres possédés, Discord
        // ne montrerait plus l'option cochée et le menu paraîtrait sans titre porté.
        ...[...ownedTitles]
          .sort((a, b) => Number(b.id === activeTitleId) - Number(a.id === activeTitleId))
          .slice(0, 24)
          .map((title) => ({
            label: truncate(title.name, 100),
            description: optionDescription(titleBonusText(title, locale, true) || title.description),
            value: title.id,
            default: title.id === activeTitleId,
          })),
      ),
  );
}

const STAT_ALLOCATIONS: { stat: AllocatableStat; emoji: string; label: (locale: Locale) => string }[] = [
  { stat: 'attack', emoji: '⚔️', label: (locale) => m.rpg_stat_attack({}, { locale }) },
  { stat: 'defense', emoji: '🛡️', label: (locale) => m.rpg_stat_defense({}, { locale }) },
  { stat: 'speed', emoji: '💨', label: (locale) => m.rpg_stat_speed({}, { locale }) },
  { stat: 'maxHealth', emoji: '❤️', label: (locale) => m.rpg_stat_health({}, { locale }) },
];

/**
 * Écran Personnage, en conteneur V2.
 *
 * L'écran alignait quatre boutons de répartition sous un bloc de texte : rien ne disait
 * quel bouton montait quelle ligne, et ils restaient affichés - grisés - même sans point
 * à dépenser. Chaque caractéristique porte désormais SON bouton, à sa droite, et les
 * boutons disparaissent quand il n'y a rien à répartir.
 */
async function buildCharacterView(guildId: string, ownerId: string, locale: Locale): Promise<PanelView> {
  const profile = await getOrCreateRpgProfile(guildId, ownerId);
  const rpgClass = getRpgClass(profile.className);
  const [skills, stats, ownedTitles] = await Promise.all([
    loadAvailableSkills(profile),
    loadEffectiveStats(profile),
    listOwnedTitles(profile.id),
  ]);

  const hasPoints = profile.statPoints > 0;

  const container = new ContainerBuilder().setAccentColor(RPG_COLORS.hub);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## ${icon('rpgCharacter')} ${m.rpg_character_title({}, { locale })}\n`
      + (rpgClass
        ? `${rpgClass.emoji} **${rpgClass.name}** — *${rpgClass.description}*`
        : m.rpg_character_no_class_desc({ level: CLASS_UNLOCK_LEVEL }, { locale })),
    ),
  );

  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      hasPoints
        ? `### ${m.rpg_character_field_base_stats({}, { locale })}\n${m.rpg_character_points_value({ points: profile.statPoints }, { locale })}`
        : `### ${m.rpg_character_field_base_stats({}, { locale })}\n*${m.rpg_character_no_points({}, { locale })}*`,
    ),
  );

  // Une ligne par caractéristique : sa valeur de base, puis sa valeur effective quand
  // l'équipement, l'arbre ou le village y ajoutent quelque chose. Le joueur voit ainsi
  // ce que son point va réellement faire bouger.
  for (const entry of STAT_ALLOCATIONS) {
    const base = profile[entry.stat];
    const effective = stats[entry.stat];
    const bonus = effective - base;
    const line = `${entry.emoji} **${entry.label(locale)}** — \`${base}\``
      + (bonus !== 0 ? ` ${m.rpg_character_stat_effective({ total: effective, bonus: bonus > 0 ? `+${bonus}` : String(bonus) }, { locale })}` : '');

    // Sans point à dépenser, la ligne n'a pas besoin de bouton : un bouton grisé
    // n'apprend rien et occupe la place d'une information.
    if (!hasPoints) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(line));
      continue;
    }

    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(line))
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`rpg:allocstat:${ownerId}:${entry.stat}`)
            .setLabel(m.rpg_character_allocate_btn({}, { locale }))
            .setStyle(ButtonStyle.Success),
        ),
    );
  }

  if (rpgClass) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));

    const skillLines = rpgClass.skills.map((skill) => {
      const unlocked = skills.some((candidate) => candidate.id === skill.id);
      const status = unlocked
        ? m.rpg_character_skill_unlocked({ cooldown: skill.cooldownTurns }, { locale })
        : m.rpg_character_skill_locked({ level: skill.levelRequired }, { locale });
      return `${skill.emoji} **${skill.name}** — ${skill.description}\n-# ${status}`;
    });

    // Les compétences venues de l'arbre sont listées à part : elles ne s'obtiennent pas
    // au niveau mais à l'achat, et les mélanger ferait croire qu'elles sont automatiques.
    const treeSkills = skills.filter((skill) => !rpgClass.skills.some((base) => base.id === skill.id));
    if (treeSkills.length > 0) {
      skillLines.push(
        `### ${m.rpg_character_field_tree_skills({}, { locale })}`,
        ...treeSkills.map((skill) => `${skill.emoji} **${skill.name}** — ${skill.description}`),
      );
    }

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### ${m.rpg_character_field_passive({}, { locale })}\n`
        + `**${rpgClass.passive.name}** — ${rpgClass.passive.description}\n\n`
        + `### ${m.rpg_character_field_skills({}, { locale })}\n`
        + truncate(skillLines.join('\n\n'), 2000),
      ),
    );
  }

  // Titres : seul celui porté compte, les autres attendent dans la collection. La section
  // n'apparaît qu'une fois un premier titre obtenu, pour ne pas annoncer un écran vide.
  if (ownedTitles.length > 0) {
    const active = ownedTitles.find((title) => title.id === profile.activeTitleId) ?? null;
    const activeLine = active
      ? m.rpg_character_title_active({ title: active.name }, { locale })
        + (titleBonusText(active, locale) ? `\n${titleBonusText(active, locale)}` : '')
      : `*${m.rpg_character_title_none({}, { locale })}*`;

    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `### ${m.rpg_character_field_titles({ count: ownedTitles.length }, { locale })}\n${activeLine}`,
    ));
  }

  const components: PanelRow[] = [];

  const titleRow = titleSelectRow(ownerId, profile.activeTitleId, ownedTitles, 'character', locale);
  if (titleRow) components.push(titleRow);

  if (profile.level >= CLASS_UNLOCK_LEVEL) {
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`rpg:classselect:${ownerId}`)
        .setPlaceholder(
          profile.className
            ? m.rpg_character_reclass_placeholder({ cost: RECLASS_COST }, { locale })
            : m.rpg_character_class_placeholder({}, { locale }),
        )
        .addOptions(
          RPG_CLASS_LIST.map((entry) => ({
            label: entry.name,
            description: truncate(entry.passive.description, 100),
            value: entry.id,
            emoji: entry.emoji,
            default: entry.id === profile.className,
          })),
        ),
    ));
  }

  // L'arbre se trouve depuis la fiche : c'est le seul écran qui parle déjà de
  // progression, et celui d'où l'on vient quand on gagne un niveau.
  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:skilltree`)
      .setLabel(m.rpg_hub_btn_skilltree({}, { locale }))
      .setEmoji(icon('rpgEnchant'))
      .setStyle(profile.skillPoints > 0 ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:hub`)
      .setLabel(m.rpg_hub_btn_back({}, { locale }))
      .setEmoji(icon('rpgBack'))
      .setStyle(ButtonStyle.Secondary),
  ));

  return { embeds: [], components, container };
}

// ─────────────────────────────────────────────────────────────
// Arbre de compétences
// ─────────────────────────────────────────────────────────────

/** Ligne d'un nœud : son rang, son coût, et ce qui le bloque le cas échéant. */
function skillNodeLine(view: SkillNodeView, locale: Locale): string {
  const { node } = view;
  const rank = m.rpg_skilltree_node_rank({ rank: view.rank, max: node.maxRank }, { locale });

  let status: string;
  switch (view.blockedBy) {
    case 'maxed':
      status = `✅ ${m.rpg_skilltree_status_maxed({}, { locale })}`;
      break;
    case 'level':
      status = `🔒 ${m.rpg_skilltree_status_level({ level: node.levelRequired }, { locale })}`;
      break;
    case 'requires': {
      const names = node.requires
        .map((id) => getSkillNode(id)?.name)
        .filter((name): name is string => Boolean(name))
        .join(', ');
      status = `🔗 ${m.rpg_skilltree_status_requires({ names }, { locale })}`;
      break;
    }
    case 'points':
      status = `⚪ ${m.rpg_skilltree_status_points({ cost: node.cost }, { locale })}`;
      break;
    default:
      status = `🟢 ${m.rpg_skilltree_node_cost({ cost: node.cost }, { locale })}`;
  }

  return `${node.emoji} **${node.name}** (${rank}) · ${status}\n*${node.description}*`;
}

/** Les bonus cumulés, rendus en une ligne par effet réellement obtenu. */
function skillBonusLines(bonuses: SkillTreeState['bonuses'], locale: Locale): string {
  const flat: [number, string][] = [
    [bonuses.attackFlat, `${icon('rpgAtk')} +{v} ATQ`],
    [bonuses.defenseFlat, `${icon('rpgDef')} +{v} DÉF`],
    [bonuses.speedFlat, `${icon('rpgSpd')} +{v} VIT`],
    [bonuses.maxHealthFlat, `${icon('rpgHp')} +{v} PV`],
  ];
  const percent: [number, string][] = [
    [bonuses.attackPercent, `${icon('rpgAtk')} +{v} % ATQ`],
    [bonuses.defensePercent, `${icon('rpgDef')} +{v} % DÉF`],
    [bonuses.speedPercent, `${icon('rpgSpd')} +{v} % VIT`],
    [bonuses.maxHealthPercent, `${icon('rpgHp')} +{v} % PV`],
    [bonuses.critChance, `${icon('rpgCrit')} +{v} % critique`],
    [bonuses.armorPiercing, `🪓 +{v} % perce-armure`],
    [bonuses.damageReduction, `🛡️ +{v} % réduction`],
    [bonuses.lifesteal, `🩸 +{v} % vol de vie`],
    [bonuses.thorns, `🌵 +{v} % épines`],
  ];

  const lines = [
    ...flat.filter(([value]) => value > 0).map(([value, label]) => label.replace('{v}', String(value))),
    ...percent.filter(([value]) => value > 0).map(([value, label]) => label.replace('{v}', String(Math.round(value * 100)))),
  ];

  return lines.length > 0 ? lines.join(' · ') : m.rpg_skilltree_no_bonus({}, { locale });
}

async function buildSkillTreeView(guildId: string, ownerId: string, locale: Locale): Promise<PanelView> {
  const state = await getSkillTreeState(guildId, ownerId);

  const embed = new EmbedBuilder()
    .setTitle(`${icon('rpgEnchant')} ${m.rpg_skilltree_title({}, { locale })}`)
    .setColor(RPG_COLORS.hub);

  if (!state.open) {
    embed.setDescription(m.rpg_skilltree_locked_desc({ level: SKILL_TREE_UNLOCK_LEVEL }, { locale }));
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  const rpgClass = getRpgClass(state.className);
  embed.setDescription(m.rpg_skilltree_desc({
    emoji: rpgClass?.emoji ?? '',
    className: rpgClass?.name ?? '',
    points: state.points,
    spent: state.spent,
  }, { locale }));

  // Une branche par colonne : les trois tiennent côte à côte, et l'arbre se lit d'un
  // coup au lieu de dérouler une liste de dix nœuds sur toute la hauteur de l'écran.
  for (const branch of state.branches) {
    embed.addFields({
      name: m.rpg_skilltree_branch({ name: branch.name }, { locale }),
      value: truncate(branch.nodes.map((node) => skillNodeLine(node, locale)).join('\n'), 1024),
      inline: true,
    });
  }

  embed.addFields({
    name: m.rpg_skilltree_field_bonuses({}, { locale }),
    value: truncate(skillBonusLines(state.bonuses, locale), 1024),
    inline: false,
  });

  if (state.skills.length > 0) {
    embed.addFields({
      name: m.rpg_skilltree_field_skills({}, { locale }),
      value: truncate(state.skills.map((skill) => `${skill.emoji} **${skill.name}** — ${skill.description}`).join('\n'), 1024),
      inline: false,
    });
  }

  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

  const buyable = state.branches.flatMap((branch) => branch.nodes).filter((node) => node.affordable);
  if (buyable.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`rpg:skillbuy:${ownerId}`)
      .setPlaceholder(m.rpg_skilltree_select_placeholder({}, { locale }))
      .addOptions(buyable.slice(0, 25).map((view) => ({
        label: truncate(`${view.node.name} (${view.rank + 1}/${view.node.maxRank})`, 100),
        description: m.rpg_skilltree_node_cost({ cost: view.node.cost }, { locale }).slice(0, 100),
        value: view.node.id,
        emoji: optionEmoji(view.node.emoji),
      })));
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  } else {
    embed.setFooter({ text: m.rpg_skilltree_none_available({}, { locale }) });
  }

  // La remise à zéro n'apparaît que s'il y a quelque chose à défaire, et reste grisée
  // tant que le joueur ne peut pas la payer : un bouton qui ne peut qu'échouer ne rend
  // service à personne.
  if (state.spent > 0) {
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`rpg:skillrespec:${ownerId}`)
        .setLabel(`${m.rpg_skilltree_respec_btn({}, { locale })} (${state.respecCost})`)
        .setEmoji('♻️')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(state.balance < state.respecCost),
    ));
  }

  components.push(backRow(ownerId, locale));
  return { embeds: [embed], components };
}

async function handleSkillNodeBuy(interaction: StringSelectMenuInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const result = await unlockSkillNode(guildId, ownerId, interaction.values[0]);

  const view = await buildSkillTreeView(guildId, ownerId, locale);
  view.embeds[0]?.setFooter({
    text: m.rpg_skilltree_unlocked({
      emoji: result.node.emoji,
      name: result.node.name,
      rank: result.newRank,
      points: result.remainingPoints,
    }, { locale }),
  });
  await respond(interaction, view);
}

async function handleSkillRespec(interaction: ButtonInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const result = await respecSkillTree(guildId, ownerId);

  const view = await buildSkillTreeView(guildId, ownerId, locale);
  view.embeds[0]?.setFooter({
    text: m.rpg_skilltree_respec_done({ points: result.refunded, cost: result.cost }, { locale }),
  });
  await respond(interaction, view);
}

async function handleAllocateStat(interaction: ButtonInteraction, guildId: string, ownerId: string, locale: Locale, statRaw: string): Promise<void> {
  const entry = STAT_ALLOCATIONS.find((candidate) => candidate.stat === statRaw);
  if (!entry) return;

  const result = await allocateStatPoint(guildId, ownerId, entry.stat);
  const view = await buildCharacterView(guildId, ownerId, locale);
  await respond(interaction, withNote(
    view,
    m.rpg_character_point_spent({ stat: entry.label(locale), gain: result.gain, remaining: result.remaining }, { locale }),
  ));
}

async function handleClassSelect(interaction: StringSelectMenuInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const result = await chooseRpgClass(guildId, ownerId, interaction.values[0]);
  const view = await buildCharacterView(guildId, ownerId, locale);

  // Une reconversion rend les points d'arbre investis : le taire laisserait croire qu'ils
  // ont été perdus avec l'ancienne classe.
  const note = result.cost > 0
    ? m.rpg_character_class_changed({ name: result.rpgClass.name, cost: result.cost }, { locale })
    : m.rpg_character_class_chosen({ name: result.rpgClass.name }, { locale });
  const refund = result.refundedSkillPoints > 0
    ? ` ${m.rpg_character_skill_points_refunded({ points: result.refundedSkillPoints }, { locale })}`
    : '';

  await respond(interaction, withNote(view, note + refund));
}

// ─────────────────────────────────────────────────────────────
// Artisanat
// ─────────────────────────────────────────────────────────────

/** Plus de trois créatures ne tiennent pas sur une ligne d'embed sans la faire déborder. */
const MATERIAL_SOURCES_SHOWN = 3;
/**
 * Caractères réservés aux lignes « butin de » sur tout l'atelier. Discord refuse un embed
 * au-delà de 6000 caractères : dix recettes aux matériaux tous manquants y arriveraient.
 */
const MATERIAL_SOURCES_BUDGET = 2500;

function materialSourceLine(source: MaterialSource | undefined, locale: Locale): string {
  if (!source || (source.known.length === 0 && source.hidden === 0)) return m.rpg_craft_source_none({}, { locale });

  const parts = source.known.slice(0, MATERIAL_SOURCES_SHOWN);
  if (source.known.length > MATERIAL_SOURCES_SHOWN) parts.push(`+${source.known.length - MATERIAL_SOURCES_SHOWN}`);
  if (source.hidden > 0) parts.push(m.rpg_craft_source_hidden({ count: source.hidden }, { locale }));
  return truncate(m.rpg_craft_source({ sources: parts.join(', ') }, { locale }), 120);
}

async function buildCraftView(guildId: string, ownerId: string, locale: Locale): Promise<PanelView> {
  const recipes = await listRecipesFor(guildId, ownerId);

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_craft_title({}, { locale }))
    .setDescription(m.rpg_craft_desc({}, { locale }))
    .setColor(RPG_COLORS.craft);

  if (recipes.length === 0) {
    embed.setDescription(m.rpg_craft_empty({}, { locale }));
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  // On met les recettes réalisables en tête : c'est la seule information vraiment
  // actionnable quand la liste dépasse la vingtaine d'entrées.
  const sorted = [...recipes].sort((a, b) => Number(b.craftable) - Number(a.craftable) || a.levelRequired - b.levelRequired);
  const shown = sorted.slice(0, 10);

  const missingNames = [...new Set(shown.flatMap((recipe) =>
    recipe.ingredients.filter((ing) => ing.owned < ing.quantity).map((ing) => ing.itemName)))];
  const sources = await listMaterialSources(guildId, ownerId, missingNames);
  let sourcesBudget = MATERIAL_SOURCES_BUDGET;

  for (const recipe of shown) {
    const ingredients = recipe.ingredients
      .map((ing) => {
        const line = `${ing.owned >= ing.quantity ? '✅' : '❌'} ${ing.itemName} ${ing.owned}/${ing.quantity}`;
        if (ing.owned >= ing.quantity) return line;
        const source = `\n-# ${materialSourceLine(sources.get(ing.itemName), locale)}`;
        if (source.length > sourcesBudget) return line;
        sourcesBudget -= source.length;
        return line + source;
      })
      .join('\n');

    embed.addFields({
      name: `${recipe.resultEmoji} ${recipe.resultName} ${rarityIcon(recipe.resultRarity)}`,
      // Six matériaux manquants avec leurs créatures peuvent dépasser la limite de 1024
      // caractères d'un champ, qui ferait refuser l'embed entier par Discord.
      value: truncate(`${m.rpg_craft_requirements({ level: recipe.levelRequired, cost: recipe.coinCost }, { locale })}\n${ingredients}`, 1024),
      inline: false,
    });
  }

  if (sorted.length > shown.length) {
    embed.setFooter({ text: m.rpg_craft_more({ count: sorted.length - shown.length }, { locale }) });
  }

  const craftable = sorted.filter((recipe) => recipe.craftable).slice(0, 25);
  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

  if (craftable.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`rpg:craft:${ownerId}`)
      .setPlaceholder(m.rpg_craft_select_placeholder({}, { locale }))
      .addOptions(
        craftable.map((recipe) => ({
          label: recipe.resultName.slice(0, 100),
          description: m.rpg_craft_option_desc({ cost: recipe.coinCost }, { locale }).slice(0, 100),
          value: recipe.id,
          emoji: recipe.resultEmoji,
        })),
      );
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  }

  components.push(backRow(ownerId, locale));
  return { embeds: [embed], components };
}

async function handleCraft(interaction: StringSelectMenuInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const result = await craftRecipe(guildId, ownerId, interaction.values[0]);
  await trackQuest(interaction.client, guildId, ownerId, 'ITEMS_CRAFTED');
  await trackQuest(interaction.client, guildId, ownerId, 'COINS_SPENT', result.coinCost);

  const view = await buildCraftView(guildId, ownerId, locale);
  view.embeds[0]?.setFooter({
    text: m.rpg_craft_success({ emoji: result.itemEmoji, item: result.itemName, cost: result.coinCost }, { locale }),
  });
  await respond(interaction, view);
}

// ─────────────────────────────────────────────────────────────
// Forge - amélioration de l'équipement porté
// ─────────────────────────────────────────────────────────────

async function buildForgeView(guildId: string, ownerId: string, locale: Locale): Promise<PanelView> {
  const profile = await getOrCreateRpgProfile(guildId, ownerId);
  const quotes = await getUpgradeQuotes(guildId, ownerId);

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_forge_title({}, { locale }))
    .setDescription(m.rpg_forge_desc({ max: MAX_UPGRADE_LEVEL, balance: profile.balance }, { locale }))
    .setColor(RPG_COLORS.craft);

  if (quotes.length === 0) {
    embed.setDescription(m.rpg_forge_nothing_equipped({}, { locale }));
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  for (const quote of quotes) {
    embed.addFields({
      name: `${quote.itemEmoji} ${quote.itemName} (+${quote.currentLevel})`,
      value: quote.maxed
        ? m.rpg_forge_maxed({}, { locale })
        : m.rpg_forge_quote({ cost: quote.cost, chance: Math.round(quote.successChance * 100) }, { locale }),
      inline: false,
    });
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...quotes.map((quote) =>
      new ButtonBuilder()
        .setCustomId(`rpg:upgrade:${ownerId}:${quote.slot}`)
        .setLabel(`${quote.itemName.slice(0, 40)} +${quote.currentLevel}`)
        .setEmoji(icon('rpgForge'))
        .setStyle(ButtonStyle.Primary)
        .setDisabled(quote.maxed || profile.balance < quote.cost),
    ),
  );

  return { embeds: [embed], components: [row, backRow(ownerId, locale)] };
}

// ─────────────────────────────────────────────────────────────
// Autel d'enchantement
// ─────────────────────────────────────────────────────────────

/**
 * Vue de l'autel : l'équipement porté avec ses enchantements, et les parchemins détenus.
 *
 * Un parchemin est posé en deux temps - choisir le parchemin, puis l'emplacement - parce
 * qu'un même parchemin (Célérité, Vitalité) accepte plusieurs emplacements. Le sélecteur
 * porte donc le parchemin, et une rangée de boutons propose les emplacements compatibles.
 */
async function buildEnchantView(
  guildId: string,
  ownerId: string,
  locale: Locale,
  selectedScrollId?: string,
): Promise<PanelView> {
  const state = await getEnchantAltarState(guildId, ownerId);

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_enchant_title({}, { locale }))
    .setDescription(m.rpg_enchant_desc({ balance: state.balance }, { locale }))
    .setColor(RPG_COLORS.craft);

  if (state.pieces.length === 0) {
    embed.setDescription(m.rpg_enchant_nothing_equipped({}, { locale }));
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  for (const piece of state.pieces) {
    const lines = piece.enchants.map((stack) => stack.label);
    for (let i = 0; i < piece.freeSlots; i++) lines.push(m.rpg_enchant_free_slot({}, { locale }));

    embed.addFields({
      name: `${piece.itemEmoji} ${piece.itemName} ${rarityIcon(piece.rarity)}`,
      value: `${lines.join('\n')}\n${m.rpg_enchant_capacity({ used: piece.enchants.length, total: piece.capacity }, { locale })}`,
      inline: false,
    });
  }

  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

  if (state.scrolls.length === 0) {
    embed.addFields({ name: m.rpg_enchant_field_scrolls({}, { locale }), value: m.rpg_enchant_no_scroll({}, { locale }) });
    components.push(backRow(ownerId, locale));
    return { embeds: [embed], components };
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`rpg:enchantpick:${ownerId}`)
    .setPlaceholder(m.rpg_enchant_select_placeholder({}, { locale }));

  state.scrolls.slice(0, 25).forEach((scroll) => {
    select.addOptions({
      label: `${scroll.itemName} (x${scroll.quantity})`.slice(0, 100),
      description: m.rpg_enchant_scroll_option({
        cost: scroll.coinCost,
        chance: Math.round(scroll.successChance * 100),
      }, { locale }).slice(0, 100),
      value: scroll.itemId,
      default: scroll.itemId === selectedScrollId,
      emoji: optionEmoji(scroll.itemEmoji),
    });
  });

  components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));

  // Un parchemin sélectionné ouvre les emplacements où il peut réellement être posé :
  // seulement ceux que l'enchantement accepte ET où un objet est effectivement porté.
  const selected = selectedScrollId ? state.scrolls.find((scroll) => scroll.itemId === selectedScrollId) : null;
  if (selected) {
    // Le catalogue d'enchantements ne connaît que trois emplacements : les accessoires
    // secondaires doivent donc être ramenés à `accessory` avant la comparaison, sinon
    // aucun parchemin ne serait jamais proposé pour eux.
    const targets = state.pieces.filter((piece) => selected.slots.includes(canonicalSlot(piece.slot)));

    embed.addFields({
      name: m.rpg_enchant_field_selected({}, { locale }),
      value: m.rpg_enchant_selected_value({
        emoji: selected.enchantEmoji,
        name: selected.enchantName,
        tier: selected.tier,
        description: selected.enchantDescription,
        cost: selected.coinCost,
        chance: Math.round(selected.successChance * 100),
      }, { locale }),
      inline: false,
    });

    if (targets.length === 0) {
      embed.addFields({ name: m.rpg_enchant_field_target({}, { locale }), value: m.rpg_enchant_no_target({}, { locale }) });
    } else {
      components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...targets.map((piece) =>
          new ButtonBuilder()
            .setCustomId(`rpg:enchantapply:${ownerId}:${piece.slot}:${selected.itemId}`)
            .setLabel(piece.itemName.slice(0, 60))
            .setEmoji(icon('rpgEnchant'))
            .setStyle(ButtonStyle.Primary)
            .setDisabled(state.balance < selected.coinCost),
        ),
      ));
    }
  }

  // Retrait : proposé uniquement quand il y a quelque chose à retirer, pour ne pas
  // encombrer l'écran d'un sélecteur vide au premier passage.
  const removable = state.pieces.flatMap((piece) =>
    piece.enchants.map((stack) => ({ piece, stack })),
  );

  if (removable.length > 0) {
    const removeSelect = new StringSelectMenuBuilder()
      .setCustomId(`rpg:enchantremove:${ownerId}`)
      .setPlaceholder(m.rpg_enchant_remove_placeholder({ cost: DISENCHANT_COST }, { locale }))
      .setDisabled(state.balance < DISENCHANT_COST);

    removable.slice(0, 25).forEach(({ piece, stack }) => {
      removeSelect.addOptions({
        label: `${stack.label} - ${piece.itemName}`.slice(0, 100),
        value: `${piece.slot}:${stack.id}`,
      });
    });

    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(removeSelect));
  }

  components.push(backRow(ownerId, locale));
  return { embeds: [embed], components };
}

/** Sélection d'un parchemin : on réaffiche l'autel avec les emplacements compatibles. */
async function handleEnchantPick(interaction: StringSelectMenuInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  await respond(interaction, await buildEnchantView(guildId, ownerId, locale, interaction.values[0]));
}

async function handleEnchantApply(
  interaction: ButtonInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
  slotRaw: string,
  scrollItemId: string,
): Promise<void> {
  if (!isEquipmentSlot(slotRaw) || !scrollItemId) return;

  const result = await applyEnchantScroll(guildId, ownerId, slotRaw, scrollItemId);
  await trackQuest(interaction.client, guildId, ownerId, 'COINS_SPENT', result.coinCost);

  const view = await buildEnchantView(guildId, ownerId, locale);
  view.embeds[0]?.setFooter({
    text: result.success
      ? m.rpg_enchant_success({
          emoji: result.enchantEmoji,
          enchant: result.enchantName,
          tier: result.tier,
          item: result.itemName,
        }, { locale })
      : m.rpg_enchant_failure({ scroll: result.scrollName, cost: result.coinCost }, { locale }),
  });
  await respond(interaction, view);
}

async function handleEnchantRemove(interaction: StringSelectMenuInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const [slotRaw, enchantId] = interaction.values[0].split(':');
  if (!isEquipmentSlot(slotRaw) || !enchantId) return;

  const result = await removeEnchant(guildId, ownerId, slotRaw, enchantId);
  await trackQuest(interaction.client, guildId, ownerId, 'COINS_SPENT', result.coinCost);

  const view = await buildEnchantView(guildId, ownerId, locale);
  view.embeds[0]?.setFooter({
    text: m.rpg_enchant_removed({ enchant: result.enchantName, item: result.itemName, cost: result.coinCost }, { locale }),
  });
  await respond(interaction, view);
}

async function handleUpgrade(interaction: ButtonInteraction, guildId: string, ownerId: string, locale: Locale, slotRaw: string): Promise<void> {
  if (!isEquipmentSlot(slotRaw)) return;

  const result = await upgradeEquipment(guildId, ownerId, slotRaw);
  await trackQuest(interaction.client, guildId, ownerId, 'COINS_SPENT', result.cost);
  if (result.success) await trackQuest(interaction.client, guildId, ownerId, 'UPGRADES_SUCCEEDED');

  const view = await buildForgeView(guildId, ownerId, locale);
  view.embeds[0]?.setFooter({
    text: result.success
      ? m.rpg_forge_success({ emoji: result.itemEmoji, item: result.itemName, level: result.newLevel }, { locale })
      : m.rpg_forge_failure({ emoji: result.itemEmoji, item: result.itemName, cost: result.cost }, { locale }),
  });
  await respond(interaction, view);
}

// ─────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────

async function renderSection(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  guildId: string,
  ownerId: string,
  section: string,
  locale: Locale,
  rest: string[] = [],
): Promise<PanelView | null> {
  switch (section) {
    case 'hub': return buildHubView(guildId, interaction.user, interaction.user, locale, isInteractionAdmin(interaction));
    // `more` a disparu du hub avec sa rangée de boutons : les messages déjà
    // envoyés qui la visent retombent sur la fiche plutôt que sur un écran mort.
    case 'more': return buildHubView(guildId, interaction.user, interaction.user, locale, isInteractionAdmin(interaction));
    case 'inventory': return buildInventoryView(guildId, ownerId, locale, parseBagState(rest));
    case 'shop': return buildShopView(guildId, ownerId, locale, parseShopState(rest));
    case 'blackmarket': return buildBlackMarketView(guildId, ownerId, locale);
    case 'travel': return buildTravelView(guildId, ownerId, locale);
    case 'guild': return buildGuildView(guildId, ownerId, locale, await panelMember(interaction, ownerId));
    case 'village': return buildVillageView(guildId, ownerId, locale);
    case 'arena': return buildArenaView(guildId, ownerId, locale);
    case 'campaign': return buildCampaignView(guildId, ownerId, locale);
    case 'quests': return buildQuestsView(interaction.client, guildId, ownerId, locale);
    case 'guilds': return buildGuildDirectoryView(guildId, ownerId, locale);
    case 'guildprofile': return buildGuildProfileView(guildId, ownerId, rest[0], locale);
    case 'clanwar': return buildClanWarView(guildId, ownerId, await panelMember(interaction, ownerId), locale, asClanWarScope(rest[0]));
    case 'raid': return buildRaidView(guildId, ownerId, await panelMember(interaction, ownerId), locale);
    case 'fishbook': return buildFishBookView(interaction.client, guildId, ownerId, locale);
    case 'bestiary': return buildBestiaryView(guildId, ownerId, interaction.user, locale, parseBestiaryState(rest));
    case 'itembook': return buildItemBookView(guildId, ownerId, locale, parseItemBookState(rest));
    case 'boss': return buildBossSelectView(guildId, ownerId, locale, Number.parseInt(rest[0] ?? '0', 10) || 0);
    case 'dungeon': return buildDungeonHallView(guildId, ownerId, locale, Number.parseInt(rest[0] ?? '0', 10) || 0);
    case 'character': return buildCharacterView(guildId, ownerId, locale);
    case 'skilltree': return buildSkillTreeView(guildId, ownerId, locale);
    case 'craft': return buildCraftView(guildId, ownerId, locale);
    case 'forge': return buildForgeView(guildId, ownerId, locale);
    case 'enchant': return buildEnchantView(guildId, ownerId, locale);
    // Import tardif : le panneau du marché importe ce module, l'inverse créerait un cycle.
    case 'market': {
      const { buildMarketView } = await import('../economy/marketplacePanel.js');
      return buildMarketView(guildId, ownerId, interaction.guild, locale);
    }
    case 'admin': {
      if (!isInteractionAdmin(interaction)) {
        await interaction.reply({ content: m.rpg_hub_admin_only({}, { locale }), flags: [MessageFlags.Ephemeral] });
        return null;
      }
      return buildAdminView(ownerId, locale);
    }
    default: return null;
  }
}

/**
 * Actions acquittées auprès de Discord avant tout travail.
 *
 * Discord n'attend que trois secondes : au-delà, il affiche « Échec de l'interaction »
 * alors que l'achat ou la potion ont bien été pris en compte, et le joueur reclique.
 * Ne figurent ici que les actions qui répondent par `respond` ou `replyPanelError` :
 * une fenêtre de saisie ou une réponse privée ne peut plus s'ouvrir après l'acquittement.
 */
const DEFERRED_BUTTON_ACTIONS = new Set([
  'nav', 'shopbuy', 'shopopen', 'invopen', 'bestopen', 'itemopen', 'invtoggle', 'invuse2', 'invsell', 'invsalvage', 'invfav', 'sellloot',
  'work', 'upgrade', 'enchantapply', 'dest', 'choice', 'dgenter', 'dgfight', 'dgleave', 'track', 'untrack',
]);

const DEFERRED_SELECT_ACTIONS = new Set([
  'navsel', 'invcat', 'invtoggleselect', 'shopitem', 'shopcat', 'bmbuy', 'craft', 'bestfilter',
  'enchantpick', 'enchantremove', 'skillbuy', 'classselect', 'villagebuild', 'guildview', 'warscope',
  'quickdrink', 'titleselect', 'itembookcat', 'itembooksrc',
]);

export async function handleRpgButton(client: Client, customId: string, interaction: ButtonInteraction): Promise<void> {
  const route = parseRpgRoute(customId);
  if (!route) return;

  const { action, ownerId, rest } = route;
  const locale = await getEffectiveLocale(interaction);
  if (!(await ensureOwner(interaction, ownerId, locale))) return;

  const guildId = interaction.guildId;
  if (!guildId) return;

  try {
    if (DEFERRED_BUTTON_ACTIONS.has(action) && !(action === 'nav' && rest[0] === 'admin')) {
      await interaction.deferUpdate();
    }

    switch (action) {
      case 'nav': {
        // Les segments qui suivent la section lui appartiennent : la boutique y
        // porte sa categorie et sa page.
        const view = await renderSection(interaction, guildId, ownerId, rest[0], locale, rest.slice(1));
        if (view) await respond(interaction, view);
        return;
      }
      case 'shopbuy': await handleShopBuy(interaction, guildId, ownerId, locale, rest); return;
      case 'invopen': await respond(interaction, await buildInventoryItemView(guildId, ownerId, rest[0], locale, parseBagState(rest.slice(1)), rest[3])); return;
      case 'itemopen': await respond(interaction, await buildItemBookEntryView(guildId, ownerId, rest[0], locale, parseItemBookState(rest.slice(1)))); return;
      case 'bestopen': await respond(interaction, await buildBestiaryEntryView(guildId, ownerId, rest[0], locale, parseBestiaryState(rest.slice(1)))); return;
      case 'invtoggle': await handleInventoryToggle(interaction, guildId, ownerId, locale, rest[0], rest[1]); return;
      case 'invuse2': await handleInventoryDrink(interaction, guildId, ownerId, locale, rest[0]); return;
      case 'invsell': await handleInventorySell(interaction, guildId, ownerId, locale, rest); return;
      case 'invsalvage': await handleInventorySalvage(interaction, guildId, ownerId, locale, rest); return;
      case 'invfav': await handleInventoryFavorite(interaction, guildId, ownerId, locale, rest); return;
      case 'sellloot': await handleSellLoot(interaction, guildId, ownerId, locale, rest); return;
      // Compteur de page : désactivé, il ne devrait jamais arriver ici, mais un client
      // qui rejouerait un vieux message ne doit pas se heurter à un silence.
      case 'noop': return;
      case 'shopopen': await handleShopItemOpen(interaction, guildId, ownerId, locale, rest); return;
      case 'daily': await handleDailyClaim(interaction, guildId, ownerId, locale); return;
      case 'fish': await handleFishClaim(interaction, guildId, ownerId, locale); return;
      case 'work': await handleWork(interaction, guildId, ownerId, locale); return;
      case 'allocstat': await handleAllocateStat(interaction, guildId, ownerId, locale, rest[0]); return;
      case 'skillrespec': await handleSkillRespec(interaction, guildId, ownerId, locale); return;
      case 'upgrade': await handleUpgrade(interaction, guildId, ownerId, locale, rest[0]); return;
      case 'enchantapply': await handleEnchantApply(interaction, guildId, ownerId, locale, rest[0], rest[1]); return;
      case 'fight': await startFightSession(interaction, guildId, ownerId, locale); return;
      case 'hunt': await startFightSession(interaction, guildId, ownerId, locale, rest[0]); return;
      case 'track': await handleTrackToggle(interaction, guildId, ownerId, locale, rest, true); return;
      case 'untrack': await handleTrackToggle(interaction, guildId, ownerId, locale, rest, false); return;
      case 'bossfight': await handleBossSelect(interaction, guildId, ownerId, locale, rest[0]); return;
      case 'dgenter': await handleDungeonEnter(interaction, guildId, ownerId, locale, rest[0]); return;
      case 'dgfight': await handleDungeonFight(interaction, guildId, ownerId, locale, rest[0], rest[1]); return;
      case 'dgleave': await handleDungeonLeave(interaction, guildId, ownerId, locale, rest[0]); return;
      case 'raidattack': await handleRaidAttack(interaction, guildId, ownerId, locale); return;
      case 'dest': await handleTravelDestinationChoice(interaction, guildId, ownerId, locale, rest[0]); return;
      case 'choice': await handleTravelEventChoice(interaction, guildId, ownerId, locale, rest[0], rest[1]); return;
      // Les messages envoyés avant le sélecteur de membres visent encore `paymodal` :
      // ils atterrissent sur le nouvel écran plutôt que sur un bouton mort.
      case 'paymodal': await respond(interaction, await buildPayView(guildId, ownerId, locale)); return;
      case 'sellmodal': await interaction.showModal(buildSellModal(ownerId, locale)); return;
      case 'guildcreateopen': await interaction.showModal(buildGuildCreateModal(ownerId, locale)); return;
      case 'guildjoinopen': await interaction.showModal(buildGuildJoinModal(ownerId, locale)); return;
      case 'guilddepositopen': await interaction.showModal(buildGuildDepositModal(ownerId, locale)); return;
      case 'guildleaveask': await respond(interaction, buildGuildLeaveConfirmView(ownerId, locale)); return;
      case 'guildjoinid': await handleGuildJoinById(interaction, guildId, ownerId, locale, rest[0]); return;
      case 'guildeditopen': await handleGuildEditOpen(interaction, guildId, ownerId, locale); return;
      case 'guildleaveyes': await handleGuildLeaveConfirm(interaction, guildId, ownerId, locale); return;
      case 'guildleaveno': await respond(interaction, await buildGuildView(guildId, ownerId, locale, await panelMember(interaction, ownerId))); return;
      case 'adminsetopen': {
        if (!isInteractionAdmin(interaction)) {
          await interaction.reply({ content: m.rpg_hub_admin_only({}, { locale }), flags: [MessageFlags.Ephemeral] });
          return;
        }
        await interaction.showModal(buildAdminSetModal(ownerId, rest[0] as AdminStat, locale));
        return;
      }
      case 'admindropopen': {
        if (!isInteractionAdmin(interaction)) {
          await interaction.reply({ content: m.rpg_hub_admin_only({}, { locale }), flags: [MessageFlags.Ephemeral] });
          return;
        }
        await interaction.showModal(buildAdminDropModal(ownerId, locale));
        return;
      }
      default: return;
    }
  } catch (err) {
    await replyPanelError(interaction, err, locale);
  }
}

export async function handleRpgSelectMenu(client: Client, customId: string, interaction: StringSelectMenuInteraction): Promise<void> {
  const route = parseRpgRoute(customId);
  if (!route) return;

  const { action, ownerId, rest } = route;
  const locale = await getEffectiveLocale(interaction);
  if (!(await ensureOwner(interaction, ownerId, locale))) return;

  const guildId = interaction.guildId;
  if (!guildId) return;

  try {
    const destination = interaction.values[0];
    if (DEFERRED_SELECT_ACTIONS.has(action) && !(action === 'navsel' && (destination === 'sell' || destination === 'admin'))) {
      await interaction.deferUpdate();
    }

    switch (action) {
      case 'navsel': {
        // Le menu du hub mène soit à un écran, soit à une fenêtre de saisie :
        // « payer » et « vendre » n'ont pas d'écran à eux, seulement un modal.
        if (destination === 'pay') {
          await respond(interaction, await buildPayView(guildId, ownerId, locale));
          return;
        }
        if (destination === 'sell') {
          await interaction.showModal(buildSellModal(ownerId, locale));
          return;
        }
        const view = await renderSection(interaction, guildId, ownerId, destination, locale);
        if (view) await respond(interaction, view);
        return;
      }
      case 'warscope': await handleWarScopeSelect(interaction, guildId, ownerId, locale); return;
      case 'invcat': await handleInventoryCategory(interaction, guildId, ownerId, locale); return;
      case 'quickdrink': await handleQuickDrink(interaction, guildId, ownerId, locale, rest); return;
      case 'titleselect': await handleTitleSelect(interaction, guildId, ownerId, locale, rest[0]); return;
      case 'itembookcat':
      case 'itembooksrc': await handleItemBookFilter(interaction, guildId, ownerId, locale, action, rest); return;
      case 'invtoggleselect': await handleInventoryUnequip(interaction, guildId, ownerId, locale); return;
      case 'bestfilter': await handleBestiaryFilter(interaction, guildId, ownerId, locale); return;
      case 'shopitem': await handleShopItemSelect(interaction, guildId, ownerId, locale, rest); return;
      case 'shopcat': await handleShopCategorySelect(interaction, guildId, ownerId, locale); return;
      case 'bmbuy': await handleBlackMarketBuy(interaction, guildId, ownerId, locale); return;
      // Les messages antérieurs aux fiches de boss portent encore le menu déroulant.
      case 'bossselect': await handleBossSelect(interaction, guildId, ownerId, locale, destination); return;
      case 'classselect': await handleClassSelect(interaction, guildId, ownerId, locale); return;
      case 'skillbuy': await handleSkillNodeBuy(interaction, guildId, ownerId, locale); return;
      case 'villagebuild': await handleVillageBuild(interaction, guildId, ownerId, locale); return;
      case 'arenafight': await handleArenaFight(interaction, guildId, ownerId, locale); return;
      case 'guildview': await handleGuildProfileSelect(interaction, guildId, ownerId, locale); return;
      case 'craft': await handleCraft(interaction, guildId, ownerId, locale); return;
      case 'enchantpick': await handleEnchantPick(interaction, guildId, ownerId, locale); return;
      case 'enchantremove': await handleEnchantRemove(interaction, guildId, ownerId, locale); return;
      case 'adminresetselect': await handleAdminResetSelect(interaction, ownerId, locale); return;
      default: return;
    }
  } catch (err) {
    await replyPanelError(interaction, err, locale);
  }
}

/**
 * Sélecteurs de membres du hub.
 *
 * Ils arrivent par un chemin distinct des sélecteurs de chaînes : Discord en fait deux
 * types d'interaction séparés, et le routeur les aiguillait tous vers le second.
 */
export async function handleRpgUserSelect(client: Client, customId: string, interaction: UserSelectMenuInteraction): Promise<void> {
  const route = parseRpgRoute(customId);
  if (!route) return;

  const { action, ownerId } = route;
  const locale = await getEffectiveLocale(interaction);
  if (!(await ensureOwner(interaction, ownerId, locale))) return;

  const guildId = interaction.guildId;
  if (!guildId) return;

  try {
    switch (action) {
      case 'payto': await handlePayRecipient(interaction, guildId, ownerId, locale); return;
      default: return;
    }
  } catch (err) {
    await replyPanelError(interaction, err, locale);
  }
}

export async function handleRpgModalSubmit(client: Client, customId: string, interaction: ModalSubmitInteraction): Promise<void> {
  const route = parseRpgRoute(customId);
  if (!route) return;

  const { action, ownerId, rest } = route;
  const locale = await getEffectiveLocale(interaction);
  if (!(await ensureOwner(interaction, ownerId, locale))) return;

  const guildId = interaction.guildId;
  if (!guildId) return;

  try {
    switch (action) {
      case 'guildcreatesubmit': await handleGuildCreateSubmit(interaction, guildId, ownerId, locale); return;
      case 'guildjoinsubmit': await handleGuildJoinSubmit(interaction, guildId, ownerId, locale); return;
      case 'guilddepositsubmit': await handleGuildDepositSubmit(interaction, guildId, ownerId, locale); return;
      case 'guildeditsubmit': await handleGuildEditSubmit(interaction, guildId, ownerId, locale); return;
      case 'paysubmit': await handlePaySubmit(interaction, guildId, ownerId, locale, client, rest[0]); return;
      case 'sellsubmit': await handleSellSubmit(interaction, guildId, ownerId, locale); return;
      case 'adminsetsubmit': await handleAdminSetSubmit(interaction, guildId, ownerId, rest[0] as AdminStat, locale); return;
      case 'admindropsubmit': await handleAdminDropSubmit(interaction, guildId, ownerId, locale); return;
      default: return;
    }
  } catch (err) {
    await replyPanelError(interaction, err, locale);
  }
}
