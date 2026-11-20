import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { resolveMemberAvatarUrl } from '../../../services/moderation/memberIdentityService.js';
import { logger } from '../../../utils/logger.js';
import { getOrCreateEconomyConfig, adminDeleteShopItem } from '../../../services/features/economyService.js';
import { getGuildName, pushAudit, resolveMemberFeatureAccess } from '../../shared.js';
import {
  BestiaryError,
  deleteGuildMonster,
  listGuildMonsters,
  saveGuildMonster,
  setGuildMonsterEnabled,
} from '../../../services/features/rpg/rpgBestiaryService.js';
import { parseMonsterDrops, type MonsterInput } from '../../../services/features/rpg/rpgBestiaryPolicy.js';
import { assertFirstKillRole, listFirstKills } from '../../../services/features/rpg/rpgFirstKillService.js';
import {
  deleteGuildTitle,
  grantTitle,
  listGuildTitles,
  revokeTitle,
  saveGuildTitle,
  TitleError,
} from '../../../services/features/rpg/rpgTitleService.js';
import type { TitleInput } from '../../../services/features/rpg/rpgTitlePolicy.js';
import type { RpgItemPayload } from '@kotbo/contracts';
import { saveGuildShopItem, ShopItemError } from '../../../services/features/rpg/rpgShopItemService.js';
import {
  adminGrantItem,
  adminTakeItem,
  adminUpdatePlayerStats,
  getPlayerInventory,
  PlayerAdminError,
  type PlayerStatsInput,
} from '../../../services/features/rpg/rpgPlayerAdminService.js';
import {
  EconomyConfigError,
  updateEconomySettings,
  withModuleFlags,
  type EconomySettingsInput,
} from '../../../services/features/rpg/rpgEconomyConfigService.js';
import {
  asDifficulty,
  isDifficulty,
  recommendDifficulty,
} from '../../../services/features/rpg/rpgDifficultyPolicy.js';
import {
  applyBestiaryDifficulty,
  applyShopDifficulty,
  findDifficultyDrift,
  getBestiaryBattleStats,
  summarizeBattles,
} from '../../../services/features/rpg/rpgDifficultyService.js';
import {
  exportGuildBestiary,
  importGuildBestiary,
} from '../../../services/features/rpg/rpgBestiaryTransferService.js';
import {
  deleteGuildRaidBoss,
  getOpenRaid,
  getRaidRecap,
  getRaidState,
  listGuildRaidBosses,
  listRaidHistory,
  listRaidTeams,
  RaidError,
  resyncScheduledRaidBoss,
  saveGuildRaidBoss,
  seedGuildRaidBosses,
  startRaidNow,
} from '../../../services/features/rpg/rpgRaidService.js';
import { announceOpenRaid } from '../../../services/features/rpg/rpgRaidPanel.js';
import {
  deleteGuildRecipe,
  listGuildRecipes,
  RecipeError,
  saveGuildRecipe,
} from '../../../services/features/rpg/rpgRecipeService.js';
import { RAID_SPELLS } from '../../../services/features/rpg/rpgRaidContent.js';
import {
  deleteGuildQuest,
  listGuildQuests,
  QuestError,
  saveGuildQuest,
} from '../../../services/features/rpg/rpgQuestService.js';
import {
  questWindowBounds,
  RPG_QUEST_OBJECTIVES,
  RPG_QUEST_SCOPES,
  type RpgQuestInput,
} from '../../../services/features/rpg/rpgQuestPolicy.js';
import type { RaidBossInput } from '../../../services/features/rpg/rpgRaidPolicy.js';
import type { RecipeInput } from '../../../services/features/rpg/rpgRecipePolicy.js';
import {
  ADVENTURE_CHOICE_TEXT_MAX,
  ADVENTURE_CHOICES_MAX,
  ADVENTURE_DESCRIPTION_MAX,
  ADVENTURE_TITLE_MAX,
  AdventureEventError,
  deleteGuildAdventureEvent,
  listGuildAdventureEvents,
  saveGuildAdventureEvent,
  setGlobalAdventureEventEnabled,
  type AdventureEventInput,
} from '../../../services/features/rpg/rpgAdventureEventService.js';
import {
  adminDissolveRpgGuild,
  adminRemoveRpgGuildMember,
  adminUpdateRpgGuild,
  listRpgGuildsForAdmin,
  RpgGuildAdminError,
  type RpgGuildAdminEdit,
} from '../../../services/features/rpg/rpgGuildAdminService.js';
import { fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';
import {
  deleteGuildFish,
  FishCatalogError,
  fishKey,
  getGuildFishCatalog,
  saveGuildFish,
  setGuildFishEnabled,
} from '../../../services/features/rpg/rpgFishService.js';
import { FISH_RARITY_WEIGHTS, type FishInput } from '../../../services/features/rpg/rpgFishCatalog.js';
import { isFishBookTier, type FishBookRewardInput } from '../../../services/features/rpg/rpgFishBook.js';
import { getFishBookRewards, resetFishBookReward, saveFishBookReward } from '../../../services/features/rpg/rpgFishBookRewardService.js';
import {
  DungeonError,
  clearDungeonFirstClear,
  deleteGuildDungeon,
  listDungeonBossChoices,
  listGuildDungeons,
  saveGuildDungeon,
  setGuildDungeonEnabled,
} from '../../../services/features/rpg/rpgDungeonService.js';
import { DUNGEON_FLOORS_MAX, DUNGEONS_PER_GUILD_MAX, type DungeonInput } from '../../../services/features/rpg/rpgDungeonPolicy.js';
import {
  TowerError,
  deleteTowerReward,
  getTowerDashboard,
  previewTowerFloor,
  resetTower,
  simulateTower,
  saveTowerFloors,
  saveTowerReward,
  saveTowerSettings,
  startTowerSeason,
} from '../../../services/features/rpg/rpgTowerService.js';
import {
  ClanTowerError,
  getClanTowerDashboard,
  saveClanTowerFloors,
  saveClanTowerSettings,
} from '../../../services/features/rpg/rpgClanTowerService.js';
import {
  isGamblingCommand,
  normalizeCommandRestrictions,
  readCommandChannels,
  RPG_CHANNEL_COMMANDS,
  withCommandChannels,
  type GamblingCommand,
} from '../../../utils/commandAccess.js';
import { getGamblingState, setGamblingState } from '../../../services/features/gamblingCommandsService.js';
import type { Prisma } from '@prisma/client';

/** Le type du corps de requête ne vaut qu'à la compilation : la valeur reçue est vérifiée. */
const RESET_COMPONENTS = new Set(['all', 'profiles', 'items', 'config', 'guilds', 'bestiary', 'titles']);

/** Fenêtre d'observation des combats : assez large pour un petit serveur, assez courte pour
 *  qu'un réglage récent ne reste pas jugé sur l'ancien équilibrage. */
const BATTLE_STATS_DAYS = 30;

type DomainError = abstract new (...args: never[]) => Error & { status: number };

/** Erreur métier du RPG : son statut et son message valent réponse. */
function rpgFailure(c: Context, err: unknown, fallback: string, ...kinds: DomainError[]): Response {
  if (kinds.some((kind) => err instanceof kind)) {
    const known = err as Error & { status: number };
    return send(c, { error: known.message }, known.status as ContentfulStatusCode);
  }
  logger.error('EconomyAPI', fallback, err);
  return fail(c, err, fallback, 'EconomyAPI');
}

/** Trace d'une action du staff sur le RPG. */
function rpgAudit(c: Context, client: Client, action: string, details: string) {
  const guildId = c.req.param('guildId')!;
  const user = c.var.dashboardUser;
  return pushAudit(guildId, {
    user: `${user.username} (${user.userId})`,
    action,
    context: getGuildName(client, guildId),
    module: 'Économie',
    eventType: 'Manuel',
    details,
    channelId: null
  });
}

export function createEconomyRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  // Masquer la section dans la navigation ne suffit pas : l'API doit aussi
  // refuser un staff à qui le rôle interdit la page.
  const economyAccess = createMiddleware(async (c, next) => {
    const featureAccess = await resolveMemberFeatureAccess(client, c.req.param('guildId')!, c.var.effectiveAccess, c.var.dashboardUser.userId);
    if (!featureAccess.economy?.canView) {
      return send(c, { error: 'Accès refusé. Votre rôle ne donne pas accès à cette section.' }, 403);
    }
    await next();
  });
  const gate = [...guildRoute(client), economyAccess] as const;


  // Salons RPG : une vue sur les règles d'accès de /rpg, /raid et /market, stockées avec les autres
  // restrictions de commandes pour que le bot n'ait qu'un seul endroit à consulter.
  router.get(`${base}/economy/rpg-channels`, ...gate, async (c) => {
    try {
      const settings = await prisma.dashboardSettings.findUnique({ where: { guildId: c.req.param('guildId') }, select: { commandRestrictions: true } });
      const rules = normalizeCommandRestrictions(settings?.commandRestrictions);
      return send(c, readCommandChannels(rules, RPG_CHANNEL_COMMANDS));
    } catch (err) {
      logger.error('EconomyAPI', 'Error fetching RPG channels:', err);
      return fail(c, err, 'Erreur lors de la récupération des salons RPG.', 'EconomyAPI');
    }
  });

  router.put(`${base}/economy/rpg-channels`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = await readBody<{ channelIds?: unknown }>(c);
      if (!body || !Array.isArray(body.channelIds)) {
        return send(c, { error: 'Liste de salons invalide.' }, 400);
      }

      const settings = await prisma.dashboardSettings.findUnique({ where: { guildId }, select: { commandRestrictions: true } });
      const rules = withCommandChannels(
        normalizeCommandRestrictions(settings?.commandRestrictions),
        RPG_CHANNEL_COMMANDS,
        body.channelIds as string[],
      );
      const commandRestrictions = rules as unknown as Prisma.InputJsonValue;
      await prisma.dashboardSettings.upsert({
        where: { guildId },
        update: { commandRestrictions },
        create: { guildId, commandRestrictions },
      });
      const { channelIds } = readCommandChannels(rules, RPG_CHANNEL_COMMANDS);

      await rpgAudit(c, client, 'Mise à jour salons RPG',
        channelIds.length > 0 ? `${channelIds.length} salon(s) autorisé(s) pour /rpg et /raid.` : 'RPG autorisé dans tous les salons.');

      return send(c, { channelIds, diverged: false });
    } catch (err) {
      logger.error('EconomyAPI', 'Error updating RPG channels:', err);
      return fail(c, err, 'Erreur lors de la mise à jour des salons RPG.', 'EconomyAPI');
    }
  });

  // Jeux d'argent : ouverts ou fermés un par un, sur les restrictions de commandes.
  router.get(`${base}/economy/gambling`, ...gate, async (c) => {
    try {
      return send(c, { games: await getGamblingState(c.req.param('guildId')) });
    } catch (err) {
      logger.error('EconomyAPI', 'Error fetching gambling state:', err);
      return fail(c, err, 'Erreur lors de la récupération des jeux.', 'EconomyAPI');
    }
  });

  router.put(`${base}/economy/gambling`, ...gate, async (c) => {
    try {
      const body = await readBody<{ games?: Record<string, unknown> }>(c);
      if (!body?.games || typeof body.games !== 'object') {
        return send(c, { error: 'Liste de jeux invalide.' }, 400);
      }
      const patch: Partial<Record<GamblingCommand, boolean>> = {};
      for (const [name, enabled] of Object.entries(body.games)) {
        if (isGamblingCommand(name) && typeof enabled === 'boolean') patch[name] = enabled;
      }

      const games = await setGamblingState(c.req.param('guildId'), patch);
      const closed = Object.entries(games).filter(([, open]) => !open).map(([name]) => `/${name}`);
      await rpgAudit(c, client, 'Mise à jour jeux d\'argent',
        closed.length > 0 ? `Jeux fermés : ${closed.join(', ')}.` : 'Tous les jeux sont ouverts.');

      return send(c, { games });
    } catch (err) {
      logger.error('EconomyAPI', 'Error updating gambling state:', err);
      return fail(c, err, 'Erreur lors de la mise à jour des jeux.', 'EconomyAPI');
    }
  });

  // POST   /api/dashboard/guilds/:guildId/economy/titles/:titleId/owners           { userId }
  // DELETE /api/dashboard/guilds/:guildId/economy/titles/:titleId/owners/:userId
  router.on(['POST', 'DELETE'], [`${base}/economy/titles/:titleId/owners`, `${base}/economy/titles/:titleId/owners/:userId`], ...gate, async (c) => {
    const guildId = c.req.param('guildId')!;
    const grantsOwner = c.req.method === 'POST' && !c.req.param('userId');
    const revokesOwner = c.req.method === 'DELETE' && !!c.req.param('userId');
    if (!grantsOwner && !revokesOwner) return send(c, { error: 'Route introuvable' }, 404);
    try {
      const titleId = c.req.param('titleId')!;
      const title = await prisma.rpgTitle.findUnique({ where: { id: titleId } });
      if (!title || title.guildId !== guildId) {
        return send(c, { error: 'Titre introuvable.' }, 404);
      }

      const userId = grantsOwner
        ? (await readBody<{ userId?: string }>(c))?.userId
        : c.req.param('userId');
      if (!userId || !/^\d{17,20}$/.test(userId)) {
        return send(c, { error: 'Membre invalide.' }, 400);
      }
      const profile = await prisma.rpgProfile.findUnique({ where: { guildId_userId: { guildId, userId } }, select: { id: true } });
      if (!profile) {
        return send(c, { error: "Ce membre n'a pas encore de personnage RPG." }, 404);
      }

      if (grantsOwner) {
        const granted = await grantTitle(profile.id, titleId);
        if (!granted) {
          return send(c, { error: 'Ce membre possède déjà ce titre.' }, 409);
        }
      } else {
        await revokeTitle(profile.id, titleId);
      }

      await rpgAudit(c, client, grantsOwner ? 'Attribution titre RPG' : 'Retrait titre RPG', `${title.name} - membre ${userId}`);
      return send(c, { success: true });
    } catch (err) {
      return rpgFailure(c, err, "Erreur lors de l'attribution du titre.", TitleError);
    }
  });

  router.get(`${base}/economy/config`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const config = await getOrCreateEconomyConfig(guildId);
      return send(c, { config: await withModuleFlags(guildId, config) });
    } catch (err) {
      logger.error('EconomyAPI', 'Error fetching economy config:', err);
      return fail(c, err, "Erreur lors de la récupération de la configuration de l'économie.", 'EconomyAPI');
    }
  });

  router.patch(`${base}/economy/config`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    try {
      const body = await readBody<EconomySettingsInput>(c);
      const config = await updateEconomySettings(guildId, body);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Mise à jour configuration Économie',
        context: getGuildName(client, guildId),
        module: 'Économie',
        eventType: 'Manuel',
        details: `Config éco mise à jour. Économie active: ${config.enabled}, RPG: ${config.rpgEnabled}`,
        channelId: null
      });

      return send(c, { config });
    } catch (err) {
      if (err instanceof EconomyConfigError) {
        return send(c, { error: err.message }, err.status);
      }
      logger.error('EconomyAPI', 'Error updating economy config:', err);
      return fail(c, err, "Erreur lors de la mise à jour de la configuration de l'économie.", 'EconomyAPI');
    }
  });

  router.get(`${base}/economy/items`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const items = await prisma.rpgItem.findMany({
        where: {
          OR: [
            { guildId: null },
            { guildId }
          ]
        },
        orderBy: { price: 'asc' }
      });
      return send(c, { items });
    } catch (err) {
      logger.error('EconomyAPI', 'Error fetching shop items:', err);
      return fail(c, err, 'Erreur lors de la récupération des objets de la boutique.', 'EconomyAPI');
    }
  });

  router.post(`${base}/economy/items`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    try {
      const body = await readBody<RpgItemPayload>(c);
      if (!body) {
        return send(c, { error: 'Corps de requête manquant.' }, 400);
      }

      const { item } = await saveGuildShopItem(guildId, body);

      await pushAudit(guildId, {
        user: auditUser,
        action: body.id ? 'Modification objet boutique' : 'Création objet boutique',
        context: getGuildName(client, guildId),
        module: 'Économie',
        eventType: 'Manuel',
        details: `Objet: ${body.name} (${body.type}) - Prix: ${body.price}`,
        channelId: null
      });

      return send(c, { item });
    } catch (err) {
      if (err instanceof ShopItemError) {
        return send(c, { error: err.message }, err.status);
      }
      logger.error('EconomyAPI', 'Error saving shop item:', err);
      return fail(c, err, "Erreur lors de la sauvegarde de l'objet.", 'EconomyAPI');
    }
  });

  router.post(`${base}/economy/items/difficulty`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    try {
      const body = await readBody<{ difficulty?: string; preview?: boolean }>(c);
      if (!body || !isDifficulty(body.difficulty)) {
        return send(c, { error: 'Palier de difficulté inconnu.' }, 400);
      }

      const config = await getOrCreateEconomyConfig(guildId);
      const from = asDifficulty(config.shopDifficulty);
      const dryRun = body.preview === true;

      const { updated, preview, protectedItems, catalogItems } = await applyShopDifficulty(
        guildId,
        { from, to: body.difficulty, dryRun },
      );

      if (!dryRun) {
        await pushAudit(guildId, {
          user: auditUser,
          action: 'Difficulté des prix RPG',
          context: getGuildName(client, guildId),
          module: 'Économie',
          eventType: 'Manuel',
          details: `Boutique : ${from} vers ${body.difficulty} - ${updated} prix modifié(s)`,
          channelId: null
        });
      }

      return send(c, { success: true, difficulty: body.difficulty, updated, preview, protectedItems, catalogItems, dryRun });
    } catch (err) {
      logger.error('EconomyAPI', 'Error applying shop difficulty:', err);
      return fail(c, err, "Erreur lors de l'application de la difficulté.", 'EconomyAPI');
    }
  });

  router.delete(`${base}/economy/items/:itemId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    const itemId = c.req.param('itemId');
    try {
      const { item, unequippedCount, cleanedMonsters } = await adminDeleteShopItem(guildId, itemId);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Suppression objet boutique',
        context: getGuildName(client, guildId),
        module: 'Économie',
        eventType: 'Manuel',
        details: `Objet ${item.name} supprimé.${unequippedCount > 0 ? ` Déséquipé de ${unequippedCount} profil(s).` : ''}`
          + `${cleanedMonsters > 0 ? ` Retiré du butin de ${cleanedMonsters} créature(s).` : ''}`,
        channelId: null
      });

      return send(c, { success: true });
    } catch (err) {
      if (err instanceof Error && err.message === 'Objet introuvable.') {
        return send(c, { error: err.message }, 404);
      }
      if (err instanceof Error && err.message.startsWith('Vous ne pouvez supprimer')) {
        return send(c, { error: err.message }, 403);
      }
      logger.error('EconomyAPI', 'Error deleting shop item:', err);
      return fail(c, err, "Erreur lors de la suppression de l'objet.", 'EconomyAPI');
    }
  });

  router.get(`${base}/economy/monsters`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const [monsters, config] = await Promise.all([
        listGuildMonsters(guildId, { includeDisabled: true }),
        getOrCreateEconomyConfig(guildId),
      ]);
      const difficulty = {
        boss: asDifficulty(config.bossDifficulty),
        monster: asDifficulty(config.monsterDifficulty),
      };

      // Le taux de victoire et la dérive ne servent qu'à la page de réglage : ils
      // accompagnent la liste plutôt que de coûter un aller-retour de plus.
      const [battles, drift, firstKills] = await Promise.all([
        getBestiaryBattleStats(guildId, BATTLE_STATS_DAYS),
        findDifficultyDrift(monsters, difficulty),
        listFirstKills(guildId),
      ]);
      const discordGuild = client.guilds.cache.get(guildId);
      const firstKillOf = (name: string) => {
        const record = firstKills.get(name);
        if (!record) return null;
        const member = discordGuild?.members.cache.get(record.userId);
        return {
          userId: record.userId,
          displayName: member?.displayName ?? client.users.cache.get(record.userId)?.username ?? null,
          at: record.createdAt,
        };
      };

      const samples = {
        boss: summarizeBattles(monsters.filter((monster) => monster.isBoss), battles),
        monster: summarizeBattles(monsters.filter((monster) => !monster.isBoss), battles),
      };

      return send(c, {
        monsters: monsters.map((monster) => ({
          ...monster,
          drops: parseMonsterDrops(monster.drops),
          battles: battles[monster.name] ?? { battles: 0, wins: 0 },
          offDifficulty: drift[monster.id] ?? null,
          firstKill: firstKillOf(monster.name),
        })),
        battleStatsDays: BATTLE_STATS_DAYS,
        samples,
        recommendations: {
          boss: recommendDifficulty(samples.boss),
          monster: recommendDifficulty(samples.monster),
        },
      });
    } catch (err) {
      logger.error('EconomyAPI', 'Error fetching monsters:', err);
      return fail(c, err, 'Erreur lors de la récupération du bestiaire.', 'EconomyAPI');
    }
  });

  router.post(`${base}/economy/monsters`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    try {
      const body = await readBody<MonsterInput & { id?: string }>(c);
      if (!body) {
        return send(c, { error: 'Corps de requête manquant.' }, 400);
      }

      // Seul un rôle qui change est contrôlé : une fiche dont le rôle est devenu
      // inutilisable doit rester modifiable, le versement le refusera de toute façon.
      const previous = body.id
        ? await prisma.rpgMonster.findUnique({ where: { id: body.id }, select: { firstKillRoleId: true } })
        : null;
      const roleId = typeof body.firstKillRoleId === 'string' && body.firstKillRoleId ? body.firstKillRoleId : null;
      if (roleId && roleId !== previous?.firstKillRoleId) {
        await assertFirstKillRole(client, guildId, roleId).catch((err: Error) => {
          throw new BestiaryError(err.message, 400);
        });
      }

      const { monster, created, overrode } = await saveGuildMonster(guildId, body, body.id);

      await pushAudit(guildId, {
        user: auditUser,
        action: created ? 'Création monstre RPG' : 'Modification monstre RPG',
        context: getGuildName(client, guildId),
        module: 'Économie',
        eventType: 'Manuel',
        details: `${monster.isBoss ? 'Boss' : 'Monstre'} : ${monster.name} (niv. ${monster.level})`
          + `${overrode ? ' - copie propre au serveur du monstre livré de base' : ''}`,
        channelId: null
      });

      return send(c, { monster: { ...monster, drops: parseMonsterDrops(monster.drops) } });
    } catch (err) {
      if (err instanceof BestiaryError) {
        return send(c, { error: err.message }, err.status);
      }
      logger.error('EconomyAPI', 'Error saving monster:', err);
      return fail(c, err, 'Erreur lors de la sauvegarde du monstre.', 'EconomyAPI');
    }
  });

  router.post(`${base}/economy/monsters/difficulty`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    try {
      const body = await readBody<{ scope?: string; difficulty?: string; preview?: boolean }>(c);
      if (!body || (body.scope !== 'boss' && body.scope !== 'monster')) {
        return send(c, { error: "Champ « scope » manquant : « boss » ou « monster »." }, 400);
      }
      if (!isDifficulty(body.difficulty)) {
        return send(c, { error: 'Palier de difficulté inconnu.' }, 400);
      }

      const isBoss = body.scope === 'boss';
      const config = await getOrCreateEconomyConfig(guildId);
      const from = asDifficulty(isBoss ? config.bossDifficulty : config.monsterDifficulty);
      const dryRun = body.preview === true;

      const { updated, preview, protectedDrops } = await applyBestiaryDifficulty(
        guildId,
        { isBoss, from, to: body.difficulty, dryRun },
      );

      // Un essai à blanc ne change rien : le journaliser noierait les vraies
      // modifications sous les allers-retours de la page de réglage.
      if (!dryRun) {
        await pushAudit(guildId, {
          user: auditUser,
          action: 'Difficulté du bestiaire RPG',
          context: getGuildName(client, guildId),
          module: 'Économie',
          eventType: 'Manuel',
          details: `${isBoss ? 'Boss' : 'Monstres'} : ${from} vers ${body.difficulty}`
            + ` - ${updated} fiche(s) réécrite(s)`,
          channelId: null
        });
      }

      return send(c, { success: true, difficulty: body.difficulty, updated, preview, protectedDrops, dryRun });
    } catch (err) {
      if (err instanceof BestiaryError) {
        return send(c, { error: err.message }, err.status);
      }
      logger.error('EconomyAPI', 'Error applying bestiary difficulty:', err);
      return fail(c, err, "Erreur lors de l'application de la difficulté.", 'EconomyAPI');
    }
  });

  router.get(`${base}/economy/monsters/export`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      return send(c, await exportGuildBestiary(guildId));
    } catch (err) {
      logger.error('EconomyAPI', 'Error exporting bestiary:', err);
      return fail(c, err, "Erreur lors de l'export du bestiaire.", 'EconomyAPI');
    }
  });

  router.post(`${base}/economy/monsters/import`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    try {
      const body = await readBody<unknown>(c);
      if (!body) {
        return send(c, { error: 'Corps de requête manquant.' }, 400);
      }

      const report = await importGuildBestiary(guildId, body);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Import du bestiaire RPG',
        context: getGuildName(client, guildId),
        module: 'Économie',
        eventType: 'Manuel',
        details: `${report.created} créature(s) ajoutée(s), ${report.updated} remplacée(s)`
          + `${report.droppedLoot > 0 ? ` - ${report.droppedLoot} butin(s) retiré(s), objet inconnu ici` : ''}`,
        channelId: null
      });

      return send(c, { success: true, ...report });
    } catch (err) {
      if (err instanceof BestiaryError) {
        return send(c, { error: err.message }, err.status);
      }
      logger.error('EconomyAPI', 'Error importing bestiary:', err);
      return fail(c, err, "Erreur lors de l'import du bestiaire.", 'EconomyAPI');
    }
  });

  router.patch(`${base}/economy/monsters/:monsterId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    const monsterId = c.req.param('monsterId');
    try {
      const body = await readBody<{ enabled?: boolean }>(c);
      if (!body || typeof body.enabled !== 'boolean') {
        return send(c, { error: "Champ « enabled » manquant." }, 400);
      }

      const monster = await setGuildMonsterEnabled(guildId, monsterId, body.enabled);

      await pushAudit(guildId, {
        user: auditUser,
        action: body.enabled ? 'Réactivation monstre RPG' : 'Désactivation monstre RPG',
        context: getGuildName(client, guildId),
        module: 'Économie',
        eventType: 'Manuel',
        details: `${monster.isBoss ? 'Boss' : 'Monstre'} : ${monster.name}`,
        channelId: null
      });

      return send(c, { monster: { ...monster, drops: parseMonsterDrops(monster.drops) } });
    } catch (err) {
      if (err instanceof BestiaryError) {
        return send(c, { error: err.message }, err.status);
      }
      logger.error('EconomyAPI', 'Error toggling monster:', err);
      return fail(c, err, "Erreur lors de la mise à jour du monstre.", 'EconomyAPI');
    }
  });

  router.delete(`${base}/economy/monsters/:monsterId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    const monsterId = c.req.param('monsterId');
    try {
      const { monster, restoredGlobal } = await deleteGuildMonster(guildId, monsterId);

      await pushAudit(guildId, {
        user: auditUser,
        action: restoredGlobal ? 'Restauration monstre RPG par défaut' : 'Suppression monstre RPG',
        context: getGuildName(client, guildId),
        module: 'Économie',
        eventType: 'Manuel',
        details: `${monster.isBoss ? 'Boss' : 'Monstre'} : ${monster.name}`,
        channelId: null
      });

      return send(c, { success: true, restoredGlobal });
    } catch (err) {
      if (err instanceof BestiaryError) {
        return send(c, { error: err.message }, err.status);
      }
      logger.error('EconomyAPI', 'Error deleting monster:', err);
      return fail(c, err, 'Erreur lors de la suppression du monstre.', 'EconomyAPI');
    }
  });

  router.get(`${base}/economy/quests`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const quests = await listGuildQuests(guildId);
      return send(c, {
        quests: quests.map((quest) => ({
          ...quest,
          // La fin de fenêtre est calculée ici : elle depend de l'heure, pas de la fiche,
          // et le dashboard n'a pas a refaire ce calcul de son cote.
          windowEndsAt: questWindowBounds(quest.windowHours).endsAt,
        })),
        objectives: RPG_QUEST_OBJECTIVES,
        scopes: RPG_QUEST_SCOPES,
      });
    } catch (err) {
      logger.error('EconomyAPI', 'Error fetching quests:', err);
      return fail(c, err, 'Erreur lors de la récupération des quêtes.', 'EconomyAPI');
    }
  });

  router.post(`${base}/economy/quests`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    try {
      const body = await readBody<RpgQuestInput & { id?: string }>(c);
      if (!body) {
        return send(c, { error: 'Corps de requête manquant.' }, 400);
      }

      const { quest, created } = await saveGuildQuest(guildId, body, body.id);

      await pushAudit(guildId, {
        user: auditUser,
        action: created ? 'Création quête RPG' : 'Modification quête RPG',
        context: getGuildName(client, guildId),
        module: 'Économie',
        eventType: 'Manuel',
        details: `${quest.name} - ${quest.objective} x${quest.target}`
          + `${quest.scope === 'TEAM' ? ' (équipe)' : ''}`,
        channelId: null
      });

      return send(c, { quest });
    } catch (err) {
      if (err instanceof QuestError) {
        return send(c, { error: err.message }, err.status);
      }
      logger.error('EconomyAPI', 'Error saving quest:', err);
      return fail(c, err, 'Erreur lors de la sauvegarde de la quête.', 'EconomyAPI');
    }
  });

  router.delete(`${base}/economy/quests/:questId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    const questId = c.req.param('questId');
    try {
      const { name } = await deleteGuildQuest(guildId, questId);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Suppression quête RPG',
        context: getGuildName(client, guildId),
        module: 'Économie',
        eventType: 'Manuel',
        details: name,
        channelId: null
      });

      return send(c, { success: true });
    } catch (err) {
      if (err instanceof QuestError) {
        return send(c, { error: err.message }, err.status);
      }
      logger.error('EconomyAPI', 'Error deleting quest:', err);
      return fail(c, err, 'Erreur lors de la suppression de la quête.', 'EconomyAPI');
    }
  });

  router.get(`${base}/economy/fish`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const [species, rewards, catches] = await Promise.all([
        getGuildFishCatalog(guildId),
        getFishBookRewards(guildId),
        prisma.rpgFishCatch.groupBy({ by: ['fishName'], where: { guildId }, _count: { _all: true } }),
      ]);
      const caught = new Map(catches.map((row) => [row.fishName, row._count._all]));
      return send(c, {
        rarityWeights: FISH_RARITY_WEIGHTS,
        species: species.map((fish) => ({ ...fish, key: fishKey(fish), caught: caught.get(fish.name) ?? 0 })),
        rewards,
      });
    } catch (err) {
      return rpgFailure(c, err, 'Erreur lors de la récupération des poissons.', FishCatalogError);
    }
  });

  router.post(`${base}/economy/fish`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = await readBody<FishInput & { key?: string }>(c);
      if (!body) {
        return send(c, { error: 'Corps de requête manquant.' }, 400);
      }
      const { fish, created } = await saveGuildFish(guildId, body, body.key || undefined);
      await rpgAudit(c, client, created ? 'Création poisson RPG' : 'Modification poisson RPG', `${fish.name} (${fish.rarity})`);
      return send(c, { fish });
    } catch (err) {
      return rpgFailure(c, err, 'Erreur lors de la sauvegarde du poisson.', FishCatalogError);
    }
  });

  router.on(['PUT', 'DELETE'], `${base}/economy/fish/rewards/:tier`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const tier = c.req.param('tier');
    if (!isFishBookTier(tier)) {
      return send(c, { error: 'Palier inconnu.' }, 400);
    }
    try {
      const method = c.req.method;
      if (method === 'PUT') {
        const body = await readBody<FishBookRewardInput>(c);
        if (!body) {
          return send(c, { error: 'Corps de requête manquant.' }, 400);
        }
        const reward = await saveFishBookReward(client, guildId, tier, body).catch((err: Error) => {
          throw new FishCatalogError(err.message, 400);
        });
        await rpgAudit(c, client, 'Récompense carnet de pêche', `${tier} : ${reward.coinReward} pièces, ${reward.xpReward} XP`);
        return send(c, { reward });
      }
      if (method === 'DELETE') {
        await resetFishBookReward(guildId, tier);
        await rpgAudit(c, client, 'Réinitialisation récompense carnet de pêche', tier);
        return send(c, { success: true });
      }
    } catch (err) {
      return rpgFailure(c, err, 'Erreur lors de la sauvegarde de la récompense.', FishCatalogError);
    }
  });

  router.on(['PATCH', 'DELETE'], `${base}/economy/fish/:key`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const key = decodeURIComponent(c.req.param('key'));
      if (c.req.method === 'PATCH') {
        const body = await readBody<{ enabled?: boolean }>(c);
        if (!body || typeof body.enabled !== 'boolean') {
          return send(c, { error: "Champ « enabled » manquant." }, 400);
        }
        const fish = await setGuildFishEnabled(guildId, key, body.enabled);
        await rpgAudit(c, client, body.enabled ? 'Réactivation poisson RPG' : 'Désactivation poisson RPG', fish.name);
        return send(c, { fish });
      }
      const { fish, restoredDefault } = await deleteGuildFish(guildId, key);
      await rpgAudit(c, client, restoredDefault ? 'Restauration poisson RPG par défaut' : 'Suppression poisson RPG', fish.name);
      return send(c, { success: true, restoredDefault });
    } catch (err) {
      return rpgFailure(c, err, 'Erreur lors de la mise à jour du poisson.', FishCatalogError);
    }
  });

  router.get(`${base}/economy/dungeons`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const [dungeons, bosses] = await Promise.all([listGuildDungeons(guildId), listDungeonBossChoices(guildId)]);
      const discordGuild = client.guilds.cache.get(guildId);
      const withFirstClear = dungeons.map((dungeon) => ({
        ...dungeon,
        firstClear: dungeon.firstClearUserId
          ? {
            userId: dungeon.firstClearUserId,
            displayName: discordGuild?.members.cache.get(dungeon.firstClearUserId)?.displayName
              ?? client.users.cache.get(dungeon.firstClearUserId)?.username
              ?? null,
            at: dungeon.firstClearAt,
          }
          : null,
      }));
      return send(c, { dungeons: withFirstClear, bosses, limits: { floorsMax: DUNGEON_FLOORS_MAX, dungeonsMax: DUNGEONS_PER_GUILD_MAX } });
    } catch (err) {
      return rpgFailure(c, err, 'Erreur lors de la récupération des donjons.', DungeonError);
    }
  });

  router.post(`${base}/economy/dungeons`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = await readBody<DungeonInput & { id?: string }>(c);
      if (!body) {
        return send(c, { error: 'Corps de requête manquant.' }, 400);
      }
      const { dungeon, created } = await saveGuildDungeon(client, guildId, body, body.id || undefined);
      await rpgAudit(c, client, created ? 'Création donjon RPG' : 'Modification donjon RPG', `${dungeon.name} (${dungeon.bossNames.length} étages)`);
      return send(c, { dungeon });
    } catch (err) {
      return rpgFailure(c, err, 'Erreur lors de la sauvegarde du donjon.', DungeonError);
    }
  });

  router.delete(`${base}/economy/dungeons/:id/first-clear`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const id = c.req.param('id');
    try {
      const dungeon = await clearDungeonFirstClear(guildId, id);
      await rpgAudit(c, client, 'Remise en jeu du premier vainqueur de donjon', dungeon.name);
      return send(c, { success: true });
    } catch (err) {
      return rpgFailure(c, err, 'Erreur lors de la remise en jeu du premier vainqueur.', DungeonError);
    }
  });

  router.on(['PATCH', 'DELETE'], `${base}/economy/dungeons/:id`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const id = c.req.param('id');
    try {
      const dungeonId = id;
      if (c.req.method === 'PATCH') {
        const body = await readBody<{ enabled?: boolean }>(c);
        if (!body || typeof body.enabled !== 'boolean') {
          return send(c, { error: "Champ « enabled » manquant." }, 400);
        }
        const dungeon = await setGuildDungeonEnabled(guildId, dungeonId, body.enabled);
        await rpgAudit(c, client, body.enabled ? 'Ouverture donjon RPG' : 'Fermeture donjon RPG', dungeon.name);
        return send(c, { dungeon });
      }
      const { dungeon, settledRuns } = await deleteGuildDungeon(guildId, dungeonId);
      await rpgAudit(c, client, 
        'Suppression donjon RPG',
        settledRuns > 0 ? `${dungeon.name} (${settledRuns} partie(s) en cours soldée(s))` : dungeon.name,
      );
      return send(c, { success: true, settledRuns });
    } catch (err) {
      return rpgFailure(c, err, 'Erreur lors de la mise à jour du donjon.', DungeonError);
    }
  });

  router.get(`${base}/economy/tower`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const dashboard = await getTowerDashboard(guildId);
      const discordGuild = client.guilds.cache.get(guildId);
      const who = (userId: string) => {
        const member = discordGuild?.members.cache.get(userId);
        const user = member?.user ?? client.users.cache.get(userId);
        return {
          displayName: member?.displayName ?? user?.username ?? userId,
          avatarUrl: member?.displayAvatarURL({ size: 64 }) ?? user?.displayAvatarURL({ size: 64 }) ?? null,
        };
      };
      const leaderboard = dashboard.leaderboard.map((entry) => ({ ...entry, ...who(entry.userId) }));
      const daily = { ...dashboard.daily, leaderboard: dashboard.daily.leaderboard.map((entry) => ({ ...entry, ...who(entry.userId) })) };
      return send(c, { ...dashboard, leaderboard, daily });
    } catch (err) {
      return rpgFailure(c, err, 'Erreur lors de la récupération de la Tour.', TowerError, ClanTowerError);
    }
  });

  router.post(`${base}/economy/tower`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = await readBody<Record<string, unknown>>(c);
      if (!body) {
        return send(c, { error: 'Corps de requête manquant.' }, 400);
      }
      const settings = await saveTowerSettings(guildId, body);
      await rpgAudit(c, client, 'Réglages de la Tour', `${settings.name} (${settings.enabled ? 'ouverte' : 'fermée'}, mode ${settings.entryMode})`);
      return send(c, { settings });
    } catch (err) {
      return rpgFailure(c, err, 'Erreur lors de la sauvegarde de la Tour.', TowerError, ClanTowerError);
    }
  });

  router.post(`${base}/economy/tower/layout`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = await readBody<{ floors?: unknown; layout?: unknown }>(c);
      if (!body) {
        return send(c, { error: 'Corps de requête manquant.' }, 400);
      }
      const settings = await saveTowerFloors(guildId, body);
      const rooms = settings.floors.reduce((sum, floor) => sum + floor.rooms.length, 0);
      await rpgAudit(c, client, 'Étages de la Tour', settings.floors.length > 0
        ? `${settings.floors.length} carte(s), ${rooms} salles`
        : 'Aucun étage dessiné : étages générés');
      return send(c, { settings });
    } catch (err) {
      return rpgFailure(c, err, 'Erreur lors de la sauvegarde de la carte.', TowerError, ClanTowerError);
    }
  });

  router.get(`${base}/economy/tower/clan`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const dashboard = await getClanTowerDashboard(guildId);
      const discordGuild = client.guilds.cache.get(guildId);
      const nameOf = (userId: string) => discordGuild?.members.cache.get(userId)?.displayName ?? client.users.cache.get(userId)?.username ?? userId;
      const current = dashboard.current
        ? {
          ...dashboard.current,
          standings: dashboard.current.standings.map((standing) => ({
            ...standing,
            climbers: standing.climbers.map((climber) => ({ ...climber, displayName: nameOf(climber.userId) })),
          })),
        }
        : null;
      return send(c, { ...dashboard, current });
    } catch (err) {
      return rpgFailure(c, err, 'Erreur lors de la récupération de la Tour de clan.', TowerError, ClanTowerError);
    }
  });

  router.post(`${base}/economy/tower/clan`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = await readBody<Record<string, unknown>>(c);
      if (!body) {
        return send(c, { error: 'Corps de requête manquant.' }, 400);
      }
      const settings = await saveClanTowerSettings(guildId, body);
      await rpgAudit(c, client, 'Réglages de la Tour de clan', `${settings.name} (${settings.enabled ? 'activée' : 'désactivée'}, ${settings.pointsPerFloor} pts par étage)`);
      return send(c, { settings });
    } catch (err) {
      return rpgFailure(c, err, 'Erreur lors de la sauvegarde de la Tour de clan.', TowerError, ClanTowerError);
    }
  });

  router.post(`${base}/economy/tower/clan/layout`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = await readBody<{ floors?: unknown }>(c);
      if (!body) {
        return send(c, { error: 'Corps de requête manquant.' }, 400);
      }
      const settings = await saveClanTowerFloors(guildId, body);
      await rpgAudit(c, client, 'Étages de la Tour de clan', settings.floors.length > 0
        ? `${settings.floors.length} carte(s), ${settings.floors.reduce((sum, floor) => sum + floor.rooms.length, 0)} salles`
        : 'Aucun étage dessiné : étages générés');
      return send(c, { settings });
    } catch (err) {
      return rpgFailure(c, err, 'Erreur lors de la sauvegarde des étages de la Tour de clan.', TowerError, ClanTowerError);
    }
  });

  router.post(`${base}/economy/tower/preview`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = await readBody<{ layout?: unknown; floor?: unknown }>(c);
      if (!body) {
        return send(c, { error: 'Corps de requête manquant.' }, 400);
      }
      return send(c, { image: await previewTowerFloor(guildId, body) });
    } catch (err) {
      return rpgFailure(c, err, 'Erreur lors de l\'aperçu de l\'étage.', TowerError, ClanTowerError);
    }
  });

  router.post(`${base}/economy/tower/simulate`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = await readBody<{ className?: unknown; runs?: unknown; skills?: unknown; heatMask?: unknown }>(c).catch(() => null);
      return send(c, await simulateTower(guildId, body ?? {}));
    } catch (err) {
      return rpgFailure(c, err, 'Erreur lors de la simulation.', TowerError, ClanTowerError);
    }
  });

  router.post(`${base}/economy/tower/reset`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = await readBody<{ everything?: unknown }>(c).catch(() => null);
      const everything = body?.everything === true;
      const reset = await resetTower(guildId, { everything });
      await rpgAudit(c, client, 
        everything ? 'Réinitialisation complète de la Tour' : 'Réinitialisation des joueurs de la Tour',
        `${reset.profiles} profil(s), ${reset.runs} ascension(s)${everything ? `, ${reset.rewards} récompense(s), réglages et étages` : ''} effacés`,
      );
      return send(c, { success: true, ...reset });
    } catch (err) {
      return rpgFailure(c, err, 'Erreur lors de la réinitialisation de la Tour.', TowerError, ClanTowerError);
    }
  });

  router.post(`${base}/economy/tower/season`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = await readBody<{ resetMilestones?: unknown }>(c).catch(() => null);
      const resetMilestones = body?.resetMilestones !== false;
      const reset = await startTowerSeason(guildId, { resetMilestones });
      await rpgAudit(c, client, 'Nouvelle saison de la Tour', `${reset} profil(s) remis à zéro au classement${resetMilestones ? ', paliers regagnables' : ''}`);
      return send(c, { success: true, reset });
    } catch (err) {
      return rpgFailure(c, err, 'Erreur lors du changement de saison.', TowerError, ClanTowerError);
    }
  });

  router.post(`${base}/economy/tower/rewards`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = await readBody<Record<string, unknown> & { id?: string }>(c);
      if (!body) {
        return send(c, { error: 'Corps de requête manquant.' }, 400);
      }
      const id = typeof body.id === 'string' && body.id ? body.id : undefined;
      const { reward, created } = await saveTowerReward(client, guildId, body, id);
      await rpgAudit(c, client, created ? 'Création récompense de Tour' : 'Modification récompense de Tour', reward.name);
      return send(c, { reward });
    } catch (err) {
      return rpgFailure(c, err, 'Erreur lors de la sauvegarde de la récompense.', TowerError, ClanTowerError);
    }
  });

  router.delete(`${base}/economy/tower/rewards/:id`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const id = c.req.param('id');
    try {
      const reward = await deleteTowerReward(guildId, id);
      await rpgAudit(c, client, 'Suppression récompense de Tour', reward.name);
      return send(c, { success: true });
    } catch (err) {
      return rpgFailure(c, err, 'Erreur lors de la suppression de la récompense.', TowerError, ClanTowerError);
    }
  });

  router.get(`${base}/economy/titles`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const [titles, owners] = await Promise.all([
        listGuildTitles(guildId),
        prisma.rpgProfileTitle.findMany({
          where: { title: { guildId } },
          select: { titleId: true, obtainedAt: true, profile: { select: { userId: true } } },
        }),
      ]);
      const discordGuild = client.guilds.cache.get(guildId);
      const ownersByTitle = new Map<string, { userId: string; displayName: string; obtainedAt: Date }[]>();
      for (const owner of owners) {
        const list = ownersByTitle.get(owner.titleId) ?? [];
        list.push({
          userId: owner.profile.userId,
          displayName: discordGuild?.members.cache.get(owner.profile.userId)?.displayName ?? owner.profile.userId,
          obtainedAt: owner.obtainedAt,
        });
        ownersByTitle.set(owner.titleId, list);
      }
      return send(c, { titles: titles.map((title) => ({ ...title, owners: ownersByTitle.get(title.id) ?? [] })) });
    } catch (err) {
      return rpgFailure(c, err, 'Erreur lors de la récupération des titres.', TitleError);
    }
  });

  router.post(`${base}/economy/titles`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    try {
      const body = await readBody<TitleInput & { id?: string }>(c);
      if (!body) {
        return send(c, { error: 'Corps de requête manquant.' }, 400);
      }
      const { title, created } = await saveGuildTitle(guildId, body, body.id);
      await pushAudit(guildId, {
        user: auditUser,
        action: created ? 'Création titre RPG' : 'Modification titre RPG',
        context: getGuildName(client, guildId),
        module: 'Économie',
        eventType: 'Manuel',
        details: title.name,
        channelId: null
      });
      return send(c, { title });
    } catch (err) {
      return rpgFailure(c, err, 'Erreur lors de la sauvegarde du titre.', TitleError);
    }
  });

  router.delete(`${base}/economy/titles/:titleId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    const titleId = c.req.param('titleId');
    try {
      const title = await deleteGuildTitle(guildId, titleId);
      await pushAudit(guildId, {
        user: auditUser,
        action: 'Suppression titre RPG',
        context: getGuildName(client, guildId),
        module: 'Économie',
        eventType: 'Manuel',
        details: title.name,
        channelId: null
      });
      return send(c, { success: true });
    } catch (err) {
      return rpgFailure(c, err, 'Erreur lors de la suppression du titre.', TitleError);
    }
  });

  router.get(`${base}/economy/recipes`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      return send(c, { recipes: await listGuildRecipes(guildId) });
    } catch (err) {
      logger.error('EconomyAPI', 'Error fetching recipes:', err);
      return fail(c, err, 'Erreur lors de la récupération des recettes.', 'EconomyAPI');
    }
  });

  router.post(`${base}/economy/recipes`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    try {
      const body = await readBody<RecipeInput & { id?: string }>(c);
      if (!body) {
        return send(c, { error: 'Corps de requête manquant.' }, 400);
      }

      const { recipe, created } = await saveGuildRecipe(guildId, body, body.id);

      await pushAudit(guildId, {
        user: auditUser,
        action: created ? 'Création recette RPG' : 'Modification recette RPG',
        context: getGuildName(client, guildId),
        module: 'Économie',
        eventType: created ? 'Création' : 'Modification',
        details: recipe.id,
        channelId: null
      });

      return send(c, { success: true, recipe });
    } catch (err) {
      if (err instanceof RecipeError) {
        return send(c, { error: err.message }, err.status);
      }
      logger.error('EconomyAPI', 'Error saving recipe:', err);
      return fail(c, err, 'Erreur lors de la sauvegarde de la recette.', 'EconomyAPI');
    }
  });

  router.delete(`${base}/economy/recipes/:recipeId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    const recipeId = c.req.param('recipeId');
    try {
      const { name } = await deleteGuildRecipe(guildId, recipeId);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Suppression recette RPG',
        context: getGuildName(client, guildId),
        module: 'Économie',
        eventType: 'Suppression',
        details: name,
        channelId: null
      });

      return send(c, { success: true });
    } catch (err) {
      if (err instanceof RecipeError) {
        return send(c, { error: err.message }, err.status);
      }
      logger.error('EconomyAPI', 'Error deleting recipe:', err);
      return fail(c, err, 'Erreur lors de la suppression de la recette.', 'EconomyAPI');
    }
  });

  router.get(`${base}/economy/raid`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      // Le catalogue livré est déposé à la première consultation : sans ça, une page de
      // réglage vide donnerait l'impression qu'il faut tout écrire soi-même.
      await seedGuildRaidBosses(guildId);
      const [bosses, state, recap, history] = await Promise.all([
        listGuildRaidBosses(guildId),
        getRaidState(guildId),
        // Sans borne d'âge : côté réglages, le bilan de la dernière fenêtre reste tant
        // que la suivante n'a pas ouvert, puisque c'est sur lui qu'on ajuste la prochaine.
        getRaidRecap(guildId),
        // L'historique, lui, ne périme pas : sans lui l'onglet se vidait dès que le
        // bilan expirait, sans plus rien dire des semaines passées.
        listRaidHistory(guildId),
      ]);

      // Le bilan ne porte que des identifiants : la page afficherait sinon une colonne de
      // nombres, là où le classement d'un raid n'a d'intérêt qu'avec des noms.
      // Un raid en cours chasse le bilan du précédent : c'est celui qui tourne qui
      // intéresse, et les deux côte à côte se confondraient.
      const discordGuild = client.guilds.cache.get(guildId);
      const recapWithNames = recap && !state.open && {
        ...recap,
        strikers: recap.strikers.map((striker) => ({
          ...striker,
          displayName: discordGuild?.members.cache.get(striker.userId)?.displayName
            ?? `Utilisateur ${striker.userId}`,
        })),
      };

      return send(c, {
        bosses,
        spells: RAID_SPELLS,
        state: {
          enabled: state.enabled,
          teamMode: state.teamMode,
          nextOpensAt: state.nextOpensAt,
          open: state.open,
          teams: state.open ? await listRaidTeams(state.open.id) : [],
        },
        recap: recapWithNames || null,
        history,
      });
    } catch (err) {
      logger.error('EconomyAPI', 'Error fetching raid:', err);
      return fail(c, err, 'Erreur lors de la récupération du raid.', 'EconomyAPI');
    }
  });

  router.post(`${base}/economy/raid/bosses`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    try {
      const body = await readBody<RaidBossInput & { id?: string }>(c);
      if (!body) {
        return send(c, { error: 'Corps de requête manquant.' }, 400);
      }

      const { boss, created } = await saveGuildRaidBoss(guildId, body, body.id);

      // La fenêtre en attente porte une copie de la fiche : sans cette reprise, retoucher
      // le boss annoncé pour samedi ne se verrait qu'au raid d'après. Le boss est déjà
      // enregistré : un incident ici ne doit pas faire passer la sauvegarde pour un échec.
      await resyncScheduledRaidBoss(guildId, await getOrCreateEconomyConfig(guildId)).catch((err) => {
        logger.error('EconomyAPI', `Boss de la fenêtre en attente non repris pour ${guildId}:`, err);
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: created ? 'Création boss de raid' : 'Modification boss de raid',
        context: getGuildName(client, guildId),
        module: 'Économie',
        eventType: 'Manuel',
        details: `${boss.name} (niv. ${boss.level})`,
        channelId: null
      });

      return send(c, { boss });
    } catch (err) {
      if (err instanceof RaidError) {
        return send(c, { error: err.message }, err.status);
      }
      logger.error('EconomyAPI', 'Error saving raid boss:', err);
      return fail(c, err, 'Erreur lors de la sauvegarde du boss de raid.', 'EconomyAPI');
    }
  });

  router.post(`${base}/economy/raid/seed`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    try {
      const restored = await seedGuildRaidBosses(guildId);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Restauration des boss de raid',
        context: getGuildName(client, guildId),
        module: 'Économie',
        eventType: 'Manuel',
        details: `${restored} boss livré(s) de base rétabli(s)`,
        channelId: null
      });

      return send(c, { success: true, restored });
    } catch (err) {
      logger.error('EconomyAPI', 'Error seeding raid bosses:', err);
      return fail(c, err, 'Erreur lors de la restauration des boss.', 'EconomyAPI');
    }
  });

  router.post(`${base}/economy/raid/start`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    try {
      const config = await getOrCreateEconomyConfig(guildId);
      const { id } = await startRaidNow(guildId, config);

      // L'annonce part tout de suite : le cycle l'aurait publiée, mais jusqu'à une
      // minute plus tard, et un lancement manuel se fait justement parce que l'équipe
      // est là maintenant.
      const raid = await getOpenRaid(guildId);
      if (raid) {
        await announceOpenRaid(client, raid, config.raidAnnounce, config.raidRoleId);
      }

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Lancement manuel du raid',
        context: getGuildName(client, guildId),
        module: 'Économie',
        eventType: 'Manuel',
        details: raid ? `${raid.bossName} jusqu'au ${raid.closesAt.toISOString()}` : id,
        channelId: null
      });

      return send(c, { success: true, raid });
    } catch (err) {
      if (err instanceof RaidError) {
        return send(c, { error: err.message }, err.status);
      }
      logger.error('EconomyAPI', 'Error starting raid:', err);
      return fail(c, err, 'Erreur lors du lancement du raid.', 'EconomyAPI');
    }
  });

  router.delete(`${base}/economy/raid/bosses/:bossId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    const bossId = c.req.param('bossId');
    try {
      const { name } = await deleteGuildRaidBoss(guildId, bossId);
      await resyncScheduledRaidBoss(guildId, await getOrCreateEconomyConfig(guildId)).catch((err) => {
        logger.error('EconomyAPI', `Boss de la fenêtre en attente non repris pour ${guildId}:`, err);
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Suppression boss de raid',
        context: getGuildName(client, guildId),
        module: 'Économie',
        eventType: 'Manuel',
        details: name,
        channelId: null
      });

      return send(c, { success: true });
    } catch (err) {
      if (err instanceof RaidError) {
        return send(c, { error: err.message }, err.status);
      }
      logger.error('EconomyAPI', 'Error deleting raid boss:', err);
      return fail(c, err, 'Erreur lors de la suppression du boss de raid.', 'EconomyAPI');
    }
  });

  router.get(`${base}/economy/players`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const players = await prisma.rpgProfile.findMany({
        where: { guildId },
        include: { rpgGuild: true },
        // Même ordre que le classement solo de la page publique.
        orderBy: [{ level: 'desc' }, { xp: 'desc' }]
      });

      const [items, inventoryCounts] = await Promise.all([
        prisma.rpgItem.findMany({ where: { OR: [{ guildId: null }, { guildId }] } }),
        prisma.rpgInventoryItem.groupBy({
          by: ['rpgProfileId'],
          where: { profile: { guildId }, quantity: { gt: 0 } },
          _sum: { quantity: true },
        }),
      ]);
      const itemById = new Map(items.map((item) => [item.id, item]));
      const bagSizeByProfile = new Map(inventoryCounts.map((row) => [row.rpgProfileId, row._sum.quantity ?? 0]));

      // Resolve Discord tags/usernames from cache if possible
      const discordGuild = client.guilds.cache.get(guildId);
      const playerDetails = players.map((player) => {
        const member = discordGuild?.members.cache.get(player.userId);
        const weapon = player.weaponId ? itemById.get(player.weaponId) : undefined;
        const armor = player.armorId ? itemById.get(player.armorId) : undefined;
        // Les trois emplacements d'accessoire étaient absents : un joueur qui en portait
        // paraissait nu sur la page, alors que ses statistiques en dépendaient.
        const accessories = [player.accessoryId, player.accessory2Id, player.accessory3Id]
          .map((id) => (id ? itemById.get(id) : undefined))
          .filter((item): item is NonNullable<typeof item> => Boolean(item))
          .map((item) => ({ name: item.name, emoji: item.emoji }));
        return {
          ...player,
          username: member?.user?.username ?? `Utilisateur ${player.userId}`,
          displayName: member?.displayName ?? `Utilisateur ${player.userId}`,
          avatarUrl: resolveMemberAvatarUrl(member, 128),
          weapon: weapon ? { name: weapon.name, emoji: weapon.emoji, atkBonus: weapon.atkBonus } : null,
          armor: armor ? { name: armor.name, emoji: armor.emoji, defBonus: armor.defBonus } : null,
          accessories,
          bagSize: bagSizeByProfile.get(player.id) ?? 0,
        };
      });

      return send(c, { players: playerDetails });
    } catch (err) {
      logger.error('EconomyAPI', 'Error fetching players:', err);
      return fail(c, err, 'Erreur lors de la récupération des joueurs.', 'EconomyAPI');
    }
  });

  router.get(`${base}/economy/players/:userId/inventory`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const userId = c.req.param('userId');
    try {
      return send(c, { inventory: await getPlayerInventory(guildId, userId) });
    } catch (err) {
      if (err instanceof PlayerAdminError) {
        return send(c, { error: err.message }, err.status);
      }
      logger.error('EconomyAPI', 'Error fetching player inventory:', err);
      return fail(c, err, "Erreur lors de la récupération de l'inventaire.", 'EconomyAPI');
    }
  });

  router.post(`${base}/economy/players/:userId/inventory`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    const userId = c.req.param('userId');
    try {
      const body = await readBody<{ itemId?: string; quantity?: number }>(c);
      if (!body?.itemId) {
        return send(c, { error: 'Objet manquant.' }, 400);
      }

      const { itemName, quantity } = await adminGrantItem(guildId, userId, body.itemId, Number(body.quantity ?? 1));

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Don objet RPG joueur',
        context: getGuildName(client, guildId),
        module: 'Économie',
        eventType: 'Manuel',
        details: `${quantity} x ${itemName} donné(s) à ${userId}`,
        channelId: null
      });

      return send(c, { success: true });
    } catch (err) {
      if (err instanceof PlayerAdminError) {
        return send(c, { error: err.message }, err.status);
      }
      logger.error('EconomyAPI', 'Error granting inventory item:', err);
      return fail(c, err, "Erreur lors de l'ajout de l'objet.", 'EconomyAPI');
    }
  });

  router.delete(`${base}/economy/players/:userId/inventory/:itemId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    const userId = c.req.param('userId');
    const itemId = c.req.param('itemId');
    try {
      const result = await adminTakeItem(guildId, userId, itemId, Number(c.req.query('quantity') ?? '1'));

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Retrait objet RPG joueur',
        context: getGuildName(client, guildId),
        module: 'Économie',
        eventType: 'Manuel',
        details: `${result.removedQuantity} x ${result.itemName} retiré(s) à ${userId}`,
        channelId: null
      });

      return send(c, { success: true, remaining: result.remainingQuantity });
    } catch (err) {
      if (err instanceof PlayerAdminError) {
        return send(c, { error: err.message }, err.status);
      }
      logger.error('EconomyAPI', 'Error removing inventory item:', err);
      return fail(c, err, "Erreur lors du retrait de l'objet.", 'EconomyAPI');
    }
  });

  router.patch(`${base}/economy/players/:userId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    const userId = c.req.param('userId');
    const targetUserId = userId;
    try {
      const body = await readBody<PlayerStatsInput>(c);
      if (!body) {
        return send(c, { error: 'Corps de requête manquant.' }, 400);
      }

      const updatedProfile = await adminUpdatePlayerStats(guildId, targetUserId, body);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Modification profil RPG joueur',
        context: getGuildName(client, guildId),
        module: 'Économie',
        eventType: 'Manuel',
        details: `Modifié joueur ${targetUserId}. Solde: ${updatedProfile.balance}, Niveau: ${updatedProfile.level}`,
        channelId: null
      });

      return send(c, { player: updatedProfile });
    } catch (err) {
      if (err instanceof PlayerAdminError) {
        return send(c, { error: err.message }, err.status);
      }
      logger.error('EconomyAPI', 'Error updating player profile:', err);
      return fail(c, err, 'Erreur lors de la mise à jour du profil du joueur.', 'EconomyAPI');
    }
  });

  router.get(`${base}/economy/events`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      return send(c, {
        events: await listGuildAdventureEvents(guildId),
        limits: {
          titleMax: ADVENTURE_TITLE_MAX,
          descriptionMax: ADVENTURE_DESCRIPTION_MAX,
          choicesMax: ADVENTURE_CHOICES_MAX,
          choiceTextMax: ADVENTURE_CHOICE_TEXT_MAX,
        },
      });
    } catch (err) {
      logger.error('EconomyAPI', 'Error fetching adventure events:', err);
      return fail(c, err, 'Erreur lors de la récupération des événements.', 'EconomyAPI');
    }
  });

  router.post(`${base}/economy/events`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    try {
      const body = await readBody<AdventureEventInput & { id?: string }>(c);
      if (!body) {
        return send(c, { error: 'Corps de requête manquant.' }, 400);
      }

      const { event, created } = await saveGuildAdventureEvent(guildId, body, body.id);

      await pushAudit(guildId, {
        user: auditUser,
        action: created ? 'Création événement de voyage' : 'Modification événement de voyage',
        context: getGuildName(client, guildId),
        module: 'Économie',
        eventType: 'Manuel',
        details: `${event.title}${event.overridesGlobal ? ' - version propre au serveur de l’événement livré' : ''}`,
        channelId: null
      });

      return send(c, { event });
    } catch (err) {
      if (err instanceof AdventureEventError) {
        return send(c, { error: err.message }, err.status);
      }
      logger.error('EconomyAPI', 'Error saving adventure event:', err);
      return fail(c, err, "Erreur lors de la sauvegarde de l'événement.", 'EconomyAPI');
    }
  });

  router.patch(`${base}/economy/events/:eventId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    const eventId = c.req.param('eventId');
    try {
      const body = await readBody<{ enabled?: boolean }>(c);
      if (!body || typeof body.enabled !== 'boolean') {
        return send(c, { error: 'Champ « enabled » manquant.' }, 400);
      }

      const { title } = await setGlobalAdventureEventEnabled(guildId, eventId, body.enabled);

      await pushAudit(guildId, {
        user: auditUser,
        action: body.enabled ? 'Réactivation événement de voyage' : 'Désactivation événement de voyage',
        context: getGuildName(client, guildId),
        module: 'Économie',
        eventType: 'Manuel',
        details: title,
        channelId: null
      });

      return send(c, { success: true });
    } catch (err) {
      if (err instanceof AdventureEventError) {
        return send(c, { error: err.message }, err.status);
      }
      logger.error('EconomyAPI', 'Error toggling adventure event:', err);
      return fail(c, err, "Erreur lors de la mise à jour de l'événement.", 'EconomyAPI');
    }
  });

  router.delete(`${base}/economy/events/:eventId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    const eventId = c.req.param('eventId');
    try {
      const { title, restoredGlobal } = await deleteGuildAdventureEvent(guildId, eventId);

      await pushAudit(guildId, {
        user: auditUser,
        action: restoredGlobal ? 'Restauration événement de voyage livré' : 'Suppression événement de voyage',
        context: getGuildName(client, guildId),
        module: 'Économie',
        eventType: 'Manuel',
        details: title,
        channelId: null
      });

      return send(c, { success: true, restoredGlobal });
    } catch (err) {
      if (err instanceof AdventureEventError) {
        return send(c, { error: err.message }, err.status);
      }
      logger.error('EconomyAPI', 'Error deleting adventure event:', err);
      return fail(c, err, "Erreur lors de la suppression de l'événement.", 'EconomyAPI');
    }
  });

  router.get(`${base}/economy/guilds`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const guilds = await listRpgGuildsForAdmin(guildId);
      const discordGuild = client.guilds.cache.get(guildId);
      const nameOf = (userId: string) => discordGuild?.members.cache.get(userId)?.displayName ?? `Utilisateur ${userId}`;

      return send(c, {
        guilds: guilds.map((rpgGuild) => ({
          ...rpgGuild,
          ownerName: nameOf(rpgGuild.ownerId),
          members: rpgGuild.members.map((member) => ({ ...member, displayName: nameOf(member.userId) })),
        })),
      });
    } catch (err) {
      logger.error('EconomyAPI', 'Error fetching RPG guilds:', err);
      return fail(c, err, 'Erreur lors de la récupération des guildes RPG.', 'EconomyAPI');
    }
  });

  router.patch(`${base}/economy/guilds/:rpgGuildId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    const rpgGuildId = c.req.param('rpgGuildId');
    try {
      const body = await readBody<RpgGuildAdminEdit>(c);
      if (!body) {
        return send(c, { error: 'Corps de requête manquant.' }, 400);
      }

      const { before, after } = await adminUpdateRpgGuild(guildId, rpgGuildId, body);

      const changes = [
        before.name !== after.name ? `nom : ${before.name} vers ${after.name}` : null,
        before.treasury !== after.treasury ? `trésor : ${before.treasury} vers ${after.treasury}` : null,
        before.ownerId !== after.ownerId ? `chef : ${before.ownerId} vers ${after.ownerId}` : null,
      ].filter(Boolean).join(', ');

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Modification guilde RPG',
        context: getGuildName(client, guildId),
        module: 'Économie',
        eventType: 'Manuel',
        details: `${after.name}${changes ? ` - ${changes}` : ''}`,
        channelId: null
      });

      return send(c, { guild: after });
    } catch (err) {
      if (err instanceof RpgGuildAdminError) {
        return send(c, { error: err.message }, err.status);
      }
      logger.error('EconomyAPI', 'Error updating RPG guild:', err);
      return fail(c, err, 'Erreur lors de la mise à jour de la guilde.', 'EconomyAPI');
    }
  });

  router.delete(`${base}/economy/guilds/:rpgGuildId/members/:userId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    const rpgGuildId = c.req.param('rpgGuildId');
    const userId = c.req.param('userId');
    try {
      const { guildName } = await adminRemoveRpgGuildMember(guildId, rpgGuildId, userId);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Exclusion membre guilde RPG',
        context: getGuildName(client, guildId),
        module: 'Économie',
        eventType: 'Manuel',
        details: `${userId} retiré de ${guildName}`,
        channelId: null
      });

      return send(c, { success: true });
    } catch (err) {
      if (err instanceof RpgGuildAdminError) {
        return send(c, { error: err.message }, err.status);
      }
      logger.error('EconomyAPI', 'Error removing RPG guild member:', err);
      return fail(c, err, 'Erreur lors du retrait du membre.', 'EconomyAPI');
    }
  });

  router.delete(`${base}/economy/guilds/:rpgGuildId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    const rpgGuildId = c.req.param('rpgGuildId');
    try {
      const { name, members, treasury } = await adminDissolveRpgGuild(guildId, rpgGuildId);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Dissolution guilde RPG',
        context: getGuildName(client, guildId),
        module: 'Économie',
        eventType: 'Manuel',
        details: `${name} - ${members} membre(s) détaché(s), trésor de ${treasury} perdu`,
        channelId: null
      });

      return send(c, { success: true });
    } catch (err) {
      if (err instanceof RpgGuildAdminError) {
        return send(c, { error: err.message }, err.status);
      }
      logger.error('EconomyAPI', 'Error dissolving RPG guild:', err);
      return fail(c, err, 'Erreur lors de la dissolution de la guilde.', 'EconomyAPI');
    }
  });

  router.post(`${base}/economy/reset`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    try {
      const body = await readBody<{
        component: 'all' | 'profiles' | 'items' | 'config' | 'guilds' | 'bestiary' | 'titles';
      }>(c);

      if (!body || !body.component) {
        return send(c, { error: 'Composant de réinitialisation manquant.' }, 400);
      }
      // Sans ce contrôle, un composant inconnu ne réinitialisait rien tout en repartant
      // avec un 200 et une entrée d'audit annonçant une remise à zéro qui n'a pas eu lieu.
      if (!RESET_COMPONENTS.has(body.component)) {
        return send(c, { error: 'Composant de réinitialisation inconnu.' }, 400);
      }

      const { adminResetGuildEconomy } = await import('../../../services/features/economyService.js');
      const { restored } = await adminResetGuildEconomy(guildId, body.component);

      const componentLabels: Record<string, string> = {
        all: 'Global (tout réinitialiser)',
        profiles: 'Profils des joueurs',
        items: 'Objets de la boutique',
        config: 'Configuration',
        guilds: 'Guildes RPG',
        titles: 'Titres RPG',
        bestiary: 'Bestiaire du serveur'
      };

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Réinitialisation Économie/RPG',
        context: getGuildName(client, guildId),
        module: 'Économie',
        eventType: 'Manuel',
        details: restored.players > 0
          ? `Composant réinitialisé : ${componentLabels[body.component] || body.component} - ${restored.coins} pièces de niveau restituées à ${restored.players} membre(s)`
          : `Composant réinitialisé : ${componentLabels[body.component] || body.component}`,
        channelId: null
      });

      return send(c, { success: true });
    } catch (err) {
      logger.error('EconomyAPI', 'Error resetting guild economy:', err);
      return fail(c, err, "Erreur lors de la réinitialisation de l'économie.", 'EconomyAPI');
    }
  });

  return router;
}

