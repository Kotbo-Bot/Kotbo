/**
 * Mise à jour de la configuration économique d'un serveur.
 *
 * Partagée par le dashboard et les outils MCP : les contrôles de cohérence (annonce du
 * raid, mode d'équipe, bornes du marché noir) doivent s'appliquer quel que soit le chemin,
 * sans quoi un outil pouvait laisser le raid dans un état que la page refuse ensuite.
 */

import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { getOrCreateEconomyConfig } from '../economyService.js';
import {
  clampInt,
  DISCOUNT_RANGE,
  DURATION_MIN_RANGE,
  INTERVAL_DAYS_RANGE,
  MAX_QUANTITY_RANGE,
  OFFER_COUNT_RANGE,
} from './rpgBlackMarketPolicy.js';
import {
  BOSS_COOLDOWN_MIN_RANGE,
  FIGHT_COOLDOWN_SEC_RANGE,
  HUNT_COOLDOWN_PERCENT_RANGE,
  HUNT_ENERGY_PERCENT_RANGE,
} from './rpgCombatCooldownPolicy.js';
import { isFirstKillAnnounceMode } from './rpgBestiaryPolicy.js';
import {
  asRaidTeamMode,
  isRaidTeamMode,
  RAID_ASSAULTS_RANGE,
  RAID_BOUGHT_ASSAULTS_RANGE,
  RAID_CLAN_POINTS_RANGE,
  RAID_CONSOLATION_RANGE,
  RAID_DURATION_RANGE,
  RAID_ENERGY_RANGE,
  RAID_HEALTH_BOUND_RANGE,
  RAID_HEALTH_PER_MEMBER_RANGE,
  RAID_HOUR_RANGE,
  RAID_REWARD_RANGE,
  RAID_WEEKDAY_RANGE,
} from './rpgRaidPolicy.js';
import { resyncScheduledRaidBoss } from './rpgRaidService.js';
import { MARKETPLACE_TAX_RANGE } from '../../economy/marketplacePolicy.js';
import { UserFacingError } from '../../../utils/userFacingError.js';

export const ANNOUNCE_MODE_VALUES = ['NONE', 'CHANNEL', 'CHANNEL_ROLE'] as const;
export const ANNOUNCE_MODES = new Set<string>(ANNOUNCE_MODE_VALUES);

export class EconomyConfigError extends UserFacingError {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'EconomyConfigError';
  }
}

export type EconomySettingsInput = {
  enabled?: boolean;
  rpgEnabled?: boolean;
  guildsEnabled?: boolean;
  shopEnabled?: boolean;
  currencyName?: string;
  currencyEmoji?: string;
  currencyIcon?: string | null;
  dailyRewardMin?: number;
  dailyRewardMax?: number;
  dailyCooldownHour?: number;
  adventureCooldownMin?: number;
  fightCooldownSec?: number;
  bossCooldownMin?: number;
  huntEnergyPercent?: number;
  huntCooldownPercent?: number;
  firstKillAnnounce?: string;
  firstKillChannelId?: string | null;
  maxEnergy?: number;
  energyRecoveryPerHour?: number;
  maxBetAmount?: number;
  maxDailyBets?: number;
  maxTransferAmount?: number;
  transferCooldownMin?: number;
  marketplaceTaxPercent?: number;
  blackMarketEnabled?: boolean;
  blackMarketIntervalDays?: number;
  blackMarketDurationMin?: number;
  blackMarketOfferCount?: number;
  blackMarketMaxQuantity?: number;
  blackMarketDiscountMin?: number;
  blackMarketDiscountMax?: number;
  blackMarketAnnounce?: string;
  blackMarketChannelId?: string | null;
  blackMarketRoleId?: string | null;
  clanPointsFromRpg?: boolean;
  raidEnabled?: boolean;
  raidAutoSchedule?: boolean;
  raidTeamMode?: string;
  raidBossName?: string | null;
  raidHealthPerMember?: number;
  raidHealthFloor?: number;
  raidHealthCap?: number;
  raidAssaultsPerMember?: number;
  raidBoughtAssaultsMax?: number;
  raidConsolationShare?: number;
  raidEnergyCost?: number;
  raidWeekday?: number;
  raidHour?: number;
  raidDurationHours?: number;
  raidXpReward?: number;
  raidCoinReward?: number;
  raidClanPoints?: number;
  raidAnnounce?: string;
  raidChannelId?: string | null;
  raidRoleId?: string | null;
};

/**
 * Ajoute à la configuration économique l'état des modules voisins.
 *
 * Ces réglages ne vivent pas sur `EconomyConfig` : `clansEnabled` et `levelingEnabled` ne
 * sont là que pour dire à la page quelles options proposer, seul `clanPointsFromRpg` s'écrit.
 */
export async function withModuleFlags<T extends object>(guildId: string, config: T) {
  const [guild, levelConfig] = await Promise.all([
    prisma.guild.findUnique({
      where: { id: guildId },
      select: { clansEnabled: true, clanPointsFromRpg: true },
    }),
    prisma.levelConfig.findUnique({ where: { guildId }, select: { enabled: true } }),
  ]);

  return {
    ...config,
    clansEnabled: guild?.clansEnabled ?? false,
    clanPointsFromRpg: guild?.clanPointsFromRpg ?? false,
    levelingEnabled: levelConfig?.enabled ?? false,
  };
}

/** Le module Clans ne vit pas sur `EconomyConfig` : son état se lit sur le serveur. */
async function areClansEnabled(guildId: string): Promise<boolean> {
  const guild = await prisma.guild.findUnique({ where: { id: guildId }, select: { clansEnabled: true } });
  return guild?.clansEnabled ?? false;
}

/** Applique les bornes du marché noir sans écraser un champ que le client n'a pas envoyé. */
function clampOptional(value: number | undefined, range: { min: number; max: number }): number | undefined {
  return value === undefined ? undefined : clampInt(value, range, range.min);
}

/**
 * Applique une modification partielle de la configuration.
 *
 * Un champ omis n'est pas touché. Renvoie la configuration complète, avec l'état des
 * modules voisins.
 */
export async function updateEconomySettings(guildId: string, body: EconomySettingsInput | null) {
  if (!body) {
    throw new EconomyConfigError('Corps de requête manquant.');
  }

  if (body.blackMarketAnnounce !== undefined && !ANNOUNCE_MODES.has(body.blackMarketAnnounce)) {
    throw new EconomyConfigError("Mode d'annonce du marché noir invalide.");
  }

  if (body.raidAnnounce !== undefined && !ANNOUNCE_MODES.has(body.raidAnnounce)) {
    throw new EconomyConfigError("Mode d'annonce du raid invalide.");
  }
  if (body.raidTeamMode !== undefined && !isRaidTeamMode(body.raidTeamMode)) {
    throw new EconomyConfigError("Mode d'équipe du raid invalide.");
  }
  if (body.firstKillAnnounce !== undefined && !isFirstKillAnnounceMode(body.firstKillAnnounce)) {
    throw new EconomyConfigError("Mode d'annonce du premier vainqueur invalide.");
  }

  // Un mode d'annonce sans destinataire produirait un marché noir « annoncé » qui
  // ne s'annonce jamais : on refuse la combinaison au lieu de la laisser passer.
  const current = await getOrCreateEconomyConfig(guildId);
  const announceMode = body.blackMarketAnnounce ?? current.blackMarketAnnounce;
  const announceChannel = body.blackMarketChannelId !== undefined ? body.blackMarketChannelId : current.blackMarketChannelId;
  const announceRole = body.blackMarketRoleId !== undefined ? body.blackMarketRoleId : current.blackMarketRoleId;
  if (announceMode !== 'NONE' && !announceChannel) {
    throw new EconomyConfigError("Sélectionnez un salon d'annonce pour le marché noir.");
  }
  if (announceMode === 'CHANNEL_ROLE' && !announceRole) {
    throw new EconomyConfigError('Sélectionnez un rôle à mentionner pour le marché noir.');
  }

  const firstKillMode = body.firstKillAnnounce ?? current.firstKillAnnounce;
  const firstKillChannel = body.firstKillChannelId !== undefined ? body.firstKillChannelId : current.firstKillChannelId;
  if (firstKillMode !== 'NONE' && !firstKillChannel) {
    throw new EconomyConfigError("Sélectionnez un salon d'annonce pour le premier vainqueur.");
  }

  const raidOn = body.raidEnabled ?? current.raidEnabled;
  const raidAnnounceMode = body.raidAnnounce ?? current.raidAnnounce;
  const raidChannel = body.raidChannelId !== undefined ? body.raidChannelId : current.raidChannelId;
  const raidRole = body.raidRoleId !== undefined ? body.raidRoleId : current.raidRoleId;
  const raidMode = asRaidTeamMode(body.raidTeamMode ?? current.raidTeamMode);
  const rpgGuildsOn = body.guildsEnabled ?? current.guildsEnabled;

  /**
   * Le corps change-t-il vraiment ce réglage ?
   *
   * La page renvoie la configuration entière à chaque enregistrement : « le champ est
   * présent » ne dit donc rien. Ce qui compte est qu'il *change*, sinon un serveur
   * déjà dans un état bancal ne pourrait plus rien enregistrer de l'onglet - pas même
   * le nom de sa monnaie - tant qu'il n'aurait pas réparé son raid. Le fichier prend
   * déjà ce parti pour le pont RPG vers les clans, quelques lignes plus bas.
   */
  const changes = (field: keyof typeof current, sent: unknown): boolean =>
    sent !== undefined && sent !== current[field];

  // Le raid se joue depuis le bouton de son annonce : sans annonce ni salon, la
  // fenêtre s'ouvre et se referme sans que personne n'ait pu frapper.
  const touchesAnnounce = changes('raidEnabled', body.raidEnabled)
    || changes('raidAnnounce', body.raidAnnounce)
    || changes('raidChannelId', body.raidChannelId)
    || changes('raidRoleId', body.raidRoleId);

  if (raidOn && touchesAnnounce) {
    if (raidAnnounceMode === 'NONE') {
      throw new EconomyConfigError("Le raid se joue depuis le bouton de son annonce : choisissez un mode d'annonce.");
    }
    if (!raidChannel) {
      throw new EconomyConfigError("Sélectionnez un salon d'annonce pour le raid.");
    }
    if (raidAnnounceMode === 'CHANNEL_ROLE' && !raidRole) {
      throw new EconomyConfigError('Sélectionnez un rôle à mentionner pour le raid.');
    }
  }

  // Un raid ne peut pas opposer des équipes que le serveur n'a pas : en mode guilde
  // RPG sans guildes du jeu, ou en mode clan sans module Clans, la fenêtre s'ouvre et
  // tout le monde se voit répondre qu'il n'appartient à aucune équipe.
  const touchesTeamMode = changes('raidEnabled', body.raidEnabled)
    || changes('raidTeamMode', body.raidTeamMode)
    || changes('guildsEnabled', body.guildsEnabled);

  if (raidOn && touchesTeamMode) {
    if (raidMode === 'RPG_GUILD' && !rpgGuildsOn) {
      throw new EconomyConfigError('Activez les guildes RPG, faites jouer le raid en mode clan, ou désactivez le raid.');
    }
    if (raidMode === 'CLAN' && !(await areClansEnabled(guildId))) {
      throw new EconomyConfigError('Activez le module Clans, faites jouer le raid en mode guilde RPG, ou désactivez le raid.');
    }
  }

  const config = await prisma.economyConfig.update({
    where: { guildId },
    data: {
      enabled: body.enabled,
      rpgEnabled: body.rpgEnabled,
      guildsEnabled: body.guildsEnabled,
      shopEnabled: body.shopEnabled,
      currencyName: body.currencyName,
      currencyEmoji: body.currencyEmoji,
      currencyIcon: body.currencyIcon,
      dailyRewardMin: body.dailyRewardMin,
      dailyRewardMax: body.dailyRewardMax,
      dailyCooldownHour: body.dailyCooldownHour,
      adventureCooldownMin: body.adventureCooldownMin,
      fightCooldownSec: clampOptional(body.fightCooldownSec, FIGHT_COOLDOWN_SEC_RANGE),
      bossCooldownMin: clampOptional(body.bossCooldownMin, BOSS_COOLDOWN_MIN_RANGE),
      huntEnergyPercent: clampOptional(body.huntEnergyPercent, HUNT_ENERGY_PERCENT_RANGE),
      huntCooldownPercent: clampOptional(body.huntCooldownPercent, HUNT_COOLDOWN_PERCENT_RANGE),
      firstKillAnnounce: body.firstKillAnnounce,
      firstKillChannelId: body.firstKillChannelId,
      maxEnergy: body.maxEnergy,
      energyRecoveryPerHour: body.energyRecoveryPerHour,
      maxBetAmount: body.maxBetAmount,
      maxDailyBets: body.maxDailyBets,
      maxTransferAmount: body.maxTransferAmount,
      transferCooldownMin: body.transferCooldownMin,
      marketplaceTaxPercent: clampOptional(body.marketplaceTaxPercent, MARKETPLACE_TAX_RANGE),
      blackMarketEnabled: body.blackMarketEnabled,
      // Les bornes sont celles qu'applique le tirage : les faire respecter ici évite
      // qu'une saisie aberrante ne soit silencieusement corrigée à chaque ouverture.
      blackMarketIntervalDays: clampOptional(body.blackMarketIntervalDays, INTERVAL_DAYS_RANGE),
      blackMarketDurationMin: clampOptional(body.blackMarketDurationMin, DURATION_MIN_RANGE),
      blackMarketOfferCount: clampOptional(body.blackMarketOfferCount, OFFER_COUNT_RANGE),
      blackMarketMaxQuantity: clampOptional(body.blackMarketMaxQuantity, MAX_QUANTITY_RANGE),
      blackMarketDiscountMin: clampOptional(body.blackMarketDiscountMin, DISCOUNT_RANGE),
      blackMarketDiscountMax: clampOptional(body.blackMarketDiscountMax, DISCOUNT_RANGE),
      blackMarketAnnounce: body.blackMarketAnnounce,
      blackMarketChannelId: body.blackMarketChannelId,
      blackMarketRoleId: body.blackMarketRoleId,
      raidEnabled: body.raidEnabled,
      raidAutoSchedule: body.raidAutoSchedule,
      raidTeamMode: body.raidTeamMode,
      // Une chaîne vide vaut « aucun boss fixé », donc tirage au sort : sans cette
      // conversion, le raid chercherait un boss nommé « ».
      raidBossName: body.raidBossName === undefined ? undefined : (body.raidBossName?.trim() || null),
      raidHealthPerMember: clampOptional(body.raidHealthPerMember, RAID_HEALTH_PER_MEMBER_RANGE),
      raidHealthFloor: clampOptional(body.raidHealthFloor, RAID_HEALTH_BOUND_RANGE),
      raidHealthCap: clampOptional(body.raidHealthCap, RAID_HEALTH_BOUND_RANGE),
      raidAssaultsPerMember: clampOptional(body.raidAssaultsPerMember, RAID_ASSAULTS_RANGE),
      raidBoughtAssaultsMax: clampOptional(body.raidBoughtAssaultsMax, RAID_BOUGHT_ASSAULTS_RANGE),
      raidConsolationShare: clampOptional(body.raidConsolationShare, RAID_CONSOLATION_RANGE),
      raidEnergyCost: clampOptional(body.raidEnergyCost, RAID_ENERGY_RANGE),
      raidWeekday: clampOptional(body.raidWeekday, RAID_WEEKDAY_RANGE),
      raidHour: clampOptional(body.raidHour, RAID_HOUR_RANGE),
      raidDurationHours: clampOptional(body.raidDurationHours, RAID_DURATION_RANGE),
      raidXpReward: clampOptional(body.raidXpReward, RAID_REWARD_RANGE),
      raidCoinReward: clampOptional(body.raidCoinReward, RAID_REWARD_RANGE),
      raidClanPoints: clampOptional(body.raidClanPoints, RAID_CLAN_POINTS_RANGE),
      raidAnnounce: body.raidAnnounce,
      raidChannelId: body.raidChannelId,
      raidRoleId: body.raidRoleId
    }
  });

  // Le boss fixé ne sert qu'à la *prochaine* planification : la fenêtre déjà en
  // attente porte l'instantané du boss tiré quand elle a été écrite. Sans cette
  // reprise, choisir un boss n'avait aucun effet visible avant le raid suivant.
  if (config.raidEnabled) {
    await resyncScheduledRaidBoss(guildId, config).catch((err) => {
      logger.error('EconomyConfig', `Boss de la fenêtre en attente non repris pour ${guildId}:`, err);
    });
  }

  // Ouvrir le pont RPG vers les clans exige des clans actifs ; le refermer est
  // toujours permis. La demande est ignorée plutôt que refusée : la page renvoie la
  // configuration entière à chaque enregistrement, et un serveur ayant éteint ses
  // clans après avoir ouvert le pont verrait sinon toutes ses sauvegardes rejetées.
  const guildRow = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { clansEnabled: true }
  });
  const clanPointsFromRpg = body.clanPointsFromRpg === true && !guildRow?.clansEnabled
    ? undefined
    : body.clanPointsFromRpg;

  // Also sync the main Guild model toggle
  if (body.enabled !== undefined || clanPointsFromRpg !== undefined) {
    await prisma.guild.update({
      where: { id: guildId },
      data: { economyEnabled: body.enabled, clanPointsFromRpg }
    });
  }

  return withModuleFlags(guildId, config);
}
