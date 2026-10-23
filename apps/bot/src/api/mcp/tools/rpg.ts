/**
 * Outils MCP du RPG : bestiaire, pêche, raid, quêtes, recettes, voyages, guildes et joueurs.
 *
 * Chaque outil passe par le même service que le dashboard, jamais par une écriture
 * Prisma à part : les deux chemins refusent ainsi exactement les mêmes valeurs, et un
 * agent ne peut pas laisser le jeu dans un état que la page ne saurait plus afficher.
 *
 * Lecture sous READ_ECONOMY, écriture sous WRITE_MEMBERS, comme les outils d'économie
 * déjà exposés.
 */
import { z } from 'zod';
import { RPG_ENCHANTMENTS, RPG_ITEM_RARITIES, RPG_ITEM_TYPES } from '@kotbo/contracts';
import prisma from '../../../utils/db.js';
import { type McpToolContext, err, ok, resolveMember, toolError } from '../toolkit.js';
import { getOrCreateEconomyConfig } from '../../../services/features/economyService.js';
import {
  deleteGuildMonster,
  listGuildMonsters,
  saveGuildMonster,
  setGuildMonsterEnabled,
} from '../../../services/features/rpg/rpgBestiaryService.js';
import { parseMonsterDrops } from '../../../services/features/rpg/rpgBestiaryPolicy.js';
import { assertFirstKillRole, clearFirstKill, listFirstKills } from '../../../services/features/rpg/rpgFirstKillService.js';
import {
  getItemCatalog,
  isUnavailableItem,
  isUniqueItem,
  ITEM_SOURCE_FILTERS,
  matchesSourceFilter,
} from '../../../services/features/rpg/rpgItemCatalogService.js';
import {
  deleteGuildFish,
  fishKey,
  getGuildFishCatalog,
  saveGuildFish,
} from '../../../services/features/rpg/rpgFishService.js';
import { FISH_RARITIES, FISH_RARITY_WEIGHTS } from '../../../services/features/rpg/rpgFishCatalog.js';
import { FISH_BOOK_TIERS } from '../../../services/features/rpg/rpgFishBook.js';
import { getFishBookRewards, resetFishBookReward, saveFishBookReward } from '../../../services/features/rpg/rpgFishBookRewardService.js';
import { deleteGuildTitle, grantTitle, listGuildTitles, revokeTitle, saveGuildTitle } from '../../../services/features/rpg/rpgTitleService.js';
import { asDifficulty, DIFFICULTIES } from '../../../services/features/rpg/rpgDifficultyPolicy.js';
import { applyBestiaryDifficulty, applyShopDifficulty } from '../../../services/features/rpg/rpgDifficultyService.js';
import {
  deleteGuildRaidBoss,
  getOpenRaid,
  getRaidRecap,
  getRaidState,
  listGuildRaidBosses,
  resyncScheduledRaidBoss,
  saveGuildRaidBoss,
  seedGuildRaidBosses,
  startRaidNow,
} from '../../../services/features/rpg/rpgRaidService.js';
import { announceOpenRaid } from '../../../services/features/rpg/rpgRaidPanel.js';
import { RAID_SPELLS } from '../../../services/features/rpg/rpgRaidContent.js';
import { deleteGuildQuest, listGuildQuests, saveGuildQuest } from '../../../services/features/rpg/rpgQuestService.js';
import { RPG_QUEST_OBJECTIVES, RPG_QUEST_SCOPES } from '../../../services/features/rpg/rpgQuestPolicy.js';
import { deleteGuildRecipe, listGuildRecipes, saveGuildRecipe } from '../../../services/features/rpg/rpgRecipeService.js';
import {
  deleteGuildAdventureEvent,
  listGuildAdventureEvents,
  saveGuildAdventureEvent,
  setGlobalAdventureEventEnabled,
} from '../../../services/features/rpg/rpgAdventureEventService.js';
import { parseAdventureChoices } from '../../../services/features/rpg/rpgAdventureEventPolicy.js';
import {
  adminDissolveRpgGuild,
  adminRemoveRpgGuildMember,
  adminUpdateRpgGuild,
  listRpgGuildsForAdmin,
} from '../../../services/features/rpg/rpgGuildAdminService.js';
import {
  clearDungeonFirstClear,
  deleteGuildDungeon,
  listDungeonBossChoices,
  listGuildDungeons,
  saveGuildDungeon,
  setGuildDungeonEnabled,
} from '../../../services/features/rpg/rpgDungeonService.js';
import { DUNGEON_FLOORS_MAX, DUNGEON_IDLE_TIMEOUT_MINUTES, DUNGEONS_PER_GUILD_MAX } from '../../../services/features/rpg/rpgDungeonPolicy.js';
import {
  adminGrantItem,
  adminTakeItem,
  adminUpdatePlayerStats,
  getPlayerInventory,
} from '../../../services/features/rpg/rpgPlayerAdminService.js';

const fail = (e: unknown) => toolError(e);

/**
 * Superpose les champs envoyés à la fiche existante.
 *
 * Les services valident une fiche complète : sans cette base, modifier le seul niveau d'un
 * boss aurait remis ses autres champs à leur valeur par défaut, et fait de lui un monstre
 * ordinaire faute d'avoir renvoyé `isBoss`.
 */
function mergeDefined(base: Record<string, unknown> | null, sent: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(base ?? {}) };
  for (const [field, value] of Object.entries(sent)) {
    if (value !== undefined) merged[field] = value;
  }
  return merged;
}

const creationOnly = (label: string) => `${label} (requis à la création)`;

const dropSchema = z.object({
  itemName: z.string().describe("Nom exact d'un objet de la boutique ou du catalogue"),
  chance: z.number().min(0).max(1).describe('Probabilité entre 0 et 1'),
  emoji: z.string().optional(),
  coinBonus: z.number().int().optional().describe('Pièces en plus quand ce butin tombe'),
});

const choiceSchema = z.object({
  text: z.string().describe('Libellé du bouton (80 caractères maximum)'),
  hpEffect: z.number().int().optional().describe('PV gagnés (positif) ou perdus (négatif)'),
  coinEffect: z.number().int().optional().describe('Pièces gagnées ou perdues'),
  xpEffect: z.number().int().min(0).optional().describe('XP gagnée'),
  minLevel: z.number().int().min(0).optional().describe('Niveau minimum pour choisir cette option'),
  titleId: z.string().nullable().optional().describe('ID du titre remis à qui fait ce choix (voir get_rpg_titles)'),
});

/**
 * Retrouve un objet par identifiant ou par nom, parmi ceux que ce serveur voit.
 *
 * Un agent connaît le nom d'un objet bien plus souvent que son identifiant : refuser le
 * nom l'obligerait à un aller-retour par la liste à chaque don.
 */
async function resolveItem(guildId: string, raw: string) {
  const byId = await prisma.rpgItem.findUnique({ where: { id: raw } });
  if (byId && (byId.guildId === null || byId.guildId === guildId)) return { ok: true as const, item: byId };

  const matches = await prisma.rpgItem.findMany({
    where: { OR: [{ guildId: null }, { guildId }], name: { equals: raw.trim(), mode: 'insensitive' } },
    orderBy: { guildId: { sort: 'desc', nulls: 'last' } },
  });
  if (matches.length === 0) return { ok: false as const, response: err(`Objet introuvable : « ${raw} ».`) };
  // Un objet du serveur qui porte le même nom qu'un objet livré est celui que le serveur
  // a voulu : il passe devant, comme pour les récompenses de campagne.
  return { ok: true as const, item: matches[0] };
}

export function registerRpgTools(ctx: McpToolContext) {
  const { server, guildId, client, shouldRegister, guard, audit, toolMeta } = ctx;

  if (shouldRegister('READ_ECONOMY')) {
    server.registerTool(
      'get_rpg_reference',
      {
        description: "Valeurs acceptées par les outils RPG : types et raretés d'objets, enchantements, sorts de raid, objectifs de quête, paliers de difficulté.",
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_ECONOMY', async () => ok({
        itemTypes: RPG_ITEM_TYPES,
        itemRarities: RPG_ITEM_RARITIES,
        enchantments: RPG_ENCHANTMENTS.map((enchant) => ({ id: enchant.id, name: enchant.name, maxTier: enchant.maxTier })),
        raidSpells: RAID_SPELLS.map((spell) => ({ id: spell.id, name: spell.name })),
        questObjectives: RPG_QUEST_OBJECTIVES,
        questScopes: RPG_QUEST_SCOPES,
        difficulties: DIFFICULTIES,
      }))
    );

    server.registerTool(
      'get_rpg_monsters',
      {
        description: 'Liste le bestiaire du serveur (monstres et boss), créatures livrées de base comprises.',
        inputSchema: {
          kind: z.enum(['all', 'boss', 'monster']).default('all'),
          include_disabled: z.boolean().default(true).describe('Inclure les créatures désactivées'),
        },
        _meta: toolMeta,
      },
      guard('READ_ECONOMY', async ({ kind, include_disabled }) => {
        const [monsters, firstKills] = await Promise.all([
          listGuildMonsters(guildId, {
            includeDisabled: include_disabled,
            ...(kind === 'all' ? {} : { isBoss: kind === 'boss' }),
          }),
          listFirstKills(guildId),
        ]);
        return ok(monsters.map((monster) => ({
          id: monster.id,
          name: monster.name,
          emoji: monster.emoji,
          description: monster.description,
          isBoss: monster.isBoss,
          level: monster.level,
          health: monster.health,
          attack: monster.attack,
          defense: monster.defense,
          speed: monster.speed,
          xpReward: monster.xpReward,
          coinReward: monster.coinReward,
          clanPoints: monster.clanPoints,
          bossRespawnHours: monster.bossRespawnHours,
          firstKillCoinReward: monster.firstKillCoinReward,
          firstKillXpReward: monster.firstKillXpReward,
          firstKillItemName: monster.firstKillItemName,
          firstKillClanPoints: monster.firstKillClanPoints,
          firstKillRoleId: monster.firstKillRoleId,
          firstKillTitleId: monster.firstKillTitleId,
          winTitleId: monster.winTitleId,
          firstKill: firstKills.get(monster.name) ?? null,
          drops: parseMonsterDrops(monster.drops),
          enabled: monster.enabled,
          scope: monster.scope,
          overridesGlobal: monster.overridesGlobal,
        })));
      })
    );

    server.registerTool(
      'get_rpg_item_catalog',
      {
        description: "Catalogue de tous les objets du RPG du serveur, comme l'écran du jeu : statistiques, description et provenance (boutique, monstres, boss, artisanat, prime de premier vainqueur, campagne). Un objet unique ne se gagne qu'une fois, un objet indisponible n'est donné par rien dans le jeu.",
        inputSchema: {
          type: z.enum(RPG_ITEM_TYPES).optional().describe("Famille d'objet"),
          source: z.enum(ITEM_SOURCE_FILTERS).default('all').describe('Provenance : all, shop, monster, boss, craft, unique ou unavailable'),
        },
        _meta: toolMeta,
      },
      guard('READ_ECONOMY', async ({ type, source }) => {
        const catalog = await getItemCatalog(guildId);
        return ok(catalog
          .filter((entry) => !type || entry.item.type === type)
          .filter((entry) => matchesSourceFilter(entry, source))
          .map((entry) => ({
            id: entry.item.id,
            scope: entry.item.guildId === null ? 'GLOBAL' : 'GUILD',
            name: entry.item.name,
            emoji: entry.item.emoji,
            description: entry.item.description,
            type: entry.item.type,
            rarity: entry.item.rarity,
            levelRequired: entry.item.levelRequired,
            price: entry.item.price,
            atkBonus: entry.item.atkBonus,
            defBonus: entry.item.defBonus,
            spdBonus: entry.item.spdBonus,
            hpBonus: entry.item.hpBonus,
            hpRestore: entry.item.hpRestore,
            energyRestore: entry.item.energyRestore,
            sources: {
              shop: entry.shop,
              monsters: entry.monsters,
              bosses: entry.bosses,
              crafted: entry.crafted,
              firstKill: entry.firstKill,
              firstKillClaimed: entry.firstKillClaimed,
              campaign: entry.campaign,
            },
            unique: isUniqueItem(entry),
            unavailable: isUnavailableItem(entry),
          })));
      })
    );

    server.registerTool(
      'get_rpg_fish',
      {
        description: "Espèces de poisson du serveur (livrées de base, personnalisées ou créées), poids de tirage par rareté, et récompenses des paliers du carnet de pêche (une par rareté terminée, plus COMPLETE pour le carnet entier).",
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_ECONOMY', async () => {
        const [species, rewards] = await Promise.all([getGuildFishCatalog(guildId), getFishBookRewards(guildId)]);
        return ok({
          rarityWeights: FISH_RARITY_WEIGHTS,
          species: species.map((fish) => ({
            key: fishKey(fish),
            name: fish.name,
            emoji: fish.emoji,
            rarity: fish.rarity,
            value: fish.value,
            xp: fish.xp,
            enabled: fish.enabled,
            scope: fish.scope,
            overridesDefault: fish.overridesDefault,
          })),
          fishBookRewards: rewards,
        });
      })
    );

    server.registerTool(
      'get_rpg_dungeons',
      {
        description: "Liste les donjons du serveur : étages (boss du bestiaire, désactivés compris), niveau requis, coût en énergie, attente entre deux entrées, coffre final, prime et record du premier vainqueur, statistiques des parties. Donne aussi les boss utilisables comme étages. L'XP versée est celle du RPG, jamais celle du niveau du serveur.",
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_ECONOMY', async () => {
        const [dungeons, bosses] = await Promise.all([listGuildDungeons(guildId), listDungeonBossChoices(guildId)]);
        return ok({
          limits: { floorsMax: DUNGEON_FLOORS_MAX, dungeonsMax: DUNGEONS_PER_GUILD_MAX, idleTimeoutMinutes: DUNGEON_IDLE_TIMEOUT_MINUTES },
          dungeons: dungeons.map((dungeon) => ({
            id: dungeon.id,
            name: dungeon.name,
            emoji: dungeon.emoji,
            description: dungeon.description,
            enabled: dungeon.enabled,
            levelRequired: dungeon.levelRequired,
            energyCost: dungeon.energyCost,
            cooldownHours: dungeon.cooldownHours,
            floors: dungeon.floors,
            chest: {
              coins: dungeon.completionCoins,
              rpgXp: dungeon.completionXp,
              itemName: dungeon.completionItemName,
              titleId: dungeon.completionTitleId,
              titleName: dungeon.completionTitle?.name ?? null,
              roleId: dungeon.completionRoleId,
            },
            firstClearBounty: {
              coins: dungeon.firstClearCoins,
              rpgXp: dungeon.firstClearXp,
              itemName: dungeon.firstClearItemName,
              titleId: dungeon.firstClearTitleId,
              titleName: dungeon.firstClearTitle?.name ?? null,
              roleId: dungeon.firstClearRoleId,
            },
            firstClear: dungeon.firstClearUserId ? { userId: dungeon.firstClearUserId, at: dungeon.firstClearAt } : null,
            runs: dungeon.runs,
            completions: dungeon.completions,
            defeats: dungeon.defeats,
          })),
          bossChoices: bosses,
        });
      })
    );

    server.registerTool(
      'get_rpg_titles',
      {
        description: 'Liste les titres du RPG du serveur : bonus accordés au porteur et nombre de joueurs qui les possèdent.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_ECONOMY', async () => ok(await listGuildTitles(guildId)))
    );

    server.registerTool(
      'get_rpg_raid',
      {
        description: 'État du raid hebdomadaire : fenêtre ouverte ou prochaine, boss disponibles, bilan du dernier raid.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_ECONOMY', async () => {
        const [bosses, state, recap] = await Promise.all([
          listGuildRaidBosses(guildId),
          getRaidState(guildId),
          getRaidRecap(guildId),
        ]);
        return ok({
          enabled: state.enabled,
          teamMode: state.teamMode,
          nextOpensAt: state.nextOpensAt,
          open: state.open,
          bosses,
          lastRecap: state.open ? null : recap,
        });
      })
    );

    server.registerTool(
      'get_rpg_quests',
      {
        description: 'Liste les quêtes du RPG (/rpg) du serveur. Distinctes des quêtes communautaires de get_quest_definitions.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_ECONOMY', async () => ok(await listGuildQuests(guildId)))
    );

    server.registerTool(
      'get_rpg_recipes',
      {
        description: "Liste les recettes d'artisanat, livrées de base et propres au serveur.",
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_ECONOMY', async () => ok(await listGuildRecipes(guildId)))
    );

    server.registerTool(
      'get_rpg_adventure_events',
      {
        description: 'Liste les événements de voyage : livrés de base, personnalisés, désactivés ou propres au serveur.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_ECONOMY', async () => ok(await listGuildAdventureEvents(guildId)))
    );

    server.registerTool(
      'get_rpg_guilds',
      {
        description: 'Liste les guildes RPG du serveur avec leurs membres, leur trésor et leur village.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_ECONOMY', async () => ok(await listRpgGuildsForAdmin(guildId)))
    );

    server.registerTool(
      'get_rpg_player_inventory',
      {
        description: "Inventaire complet d'un joueur, avec les objets équipés et leur niveau de forge.",
        inputSchema: {
          member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre'),
        },
        _meta: toolMeta,
      },
      guard('READ_ECONOMY', async ({ member }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;
        try {
          return ok(await getPlayerInventory(guildId, resolved.userId));
        } catch (e) {
          return fail(e);
        }
      })
    );
  }

  if (shouldRegister('WRITE_MEMBERS')) {
    server.registerTool(
      'save_rpg_monster',
      {
        description: "Crée un monstre ou un boss, ou modifie une créature existante. Modifier une créature livrée de base en crée une version propre au serveur. Requiert WRITE_MEMBERS.",
        inputSchema: {
          id: z.string().optional().describe('ID de la créature à modifier (voir get_rpg_monsters). Absent : création.'),
          name: z.string().optional().describe(creationOnly('Nom')),
          description: z.string().optional().describe(creationOnly('Description')),
          emoji: z.string().optional(),
          level: z.number().int().optional().describe(creationOnly('Niveau')),
          health: z.number().int().optional().describe(creationOnly('PV')),
          attack: z.number().int().optional().describe(creationOnly('Attaque')),
          defense: z.number().int().optional().describe(creationOnly('Défense')),
          speed: z.number().int().optional().describe(creationOnly('Vitesse')),
          xpReward: z.number().int().optional().describe(creationOnly('XP gagnée')),
          coinReward: z.number().int().optional().describe(creationOnly('Pièces gagnées')),
          isBoss: z.boolean().optional().describe('Boss (faux par défaut à la création)'),
          bossRespawnHours: z.number().int().optional().describe('Boss uniquement : délai de réapparition'),
          clanPoints: z.number().int().optional().describe("Points de clan ou XP de guilde gagnés à l'abattre"),
          firstKillCoinReward: z.number().int().optional().describe('Prime en pièces du premier joueur du serveur à la vaincre'),
          firstKillXpReward: z.number().int().optional().describe('Prime en XP du premier vainqueur'),
          firstKillItemName: z.string().nullable().optional().describe("Objet offert au premier vainqueur (nom exact), null pour aucun"),
          firstKillClanPoints: z.number().int().optional().describe('Points de clan ou XP de guilde du premier vainqueur'),
          firstKillRoleId: z.string().nullable().optional().describe('ID du rôle Discord offert au premier vainqueur, null pour aucun'),
          firstKillTitleId: z.string().nullable().optional().describe('ID du titre offert au premier vainqueur (voir get_rpg_titles), null pour aucun'),
          winTitleId: z.string().nullable().optional().describe('ID du titre gagné par tout joueur qui abat la créature, null pour aucun'),
          drops: z.array(dropSchema).optional(),
          enabled: z.boolean().optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ id, key_name, ...input }) => {
        try {
          const existing = id ? await prisma.rpgMonster.findUnique({ where: { id } }) : null;
          const base = existing ? {
            name: existing.name,
            description: existing.description,
            emoji: existing.emoji,
            level: existing.level,
            health: existing.health,
            attack: existing.attack,
            defense: existing.defense,
            speed: existing.speed,
            xpReward: existing.xpReward,
            coinReward: existing.coinReward,
            isBoss: existing.isBoss,
            bossRespawnHours: existing.bossRespawnHours,
            clanPoints: existing.clanPoints,
            firstKillCoinReward: existing.firstKillCoinReward,
            firstKillXpReward: existing.firstKillXpReward,
            firstKillItemName: existing.firstKillItemName,
            firstKillClanPoints: existing.firstKillClanPoints,
            firstKillRoleId: existing.firstKillRoleId,
            firstKillTitleId: existing.firstKillTitleId,
            winTitleId: existing.winTitleId,
            drops: parseMonsterDrops(existing.drops),
            enabled: existing.enabled,
          } : null;
          if (input.firstKillRoleId && input.firstKillRoleId !== existing?.firstKillRoleId) {
            await assertFirstKillRole(client, guildId, input.firstKillRoleId);
          }
          const { monster, created, overrode } = await saveGuildMonster(guildId, mergeDefined(base, input), id);
          await audit(key_name, created ? 'Création monstre RPG MCP' : 'Modification monstre RPG MCP', monster.name,
            `${monster.isBoss ? 'Boss' : 'Monstre'} niv. ${monster.level}${overrode ? ' - version propre au serveur' : ''}`);
          return ok({ ok: true, id: monster.id, created });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'reset_rpg_first_kill',
      {
        description: "Efface le premier vainqueur d'une créature : le prochain joueur qui la bat redevient le premier et touche la prime. Ce que l'ancien vainqueur a reçu lui reste. Requiert WRITE_MEMBERS.",
        inputSchema: {
          monster: z.string().describe('ID ou nom exact de la créature (voir get_rpg_monsters)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ monster, key_name }) => {
        try {
          const creatures = await listGuildMonsters(guildId, { includeDisabled: true });
          const target = creatures.find((creature) => creature.id === monster)
            ?? creatures.find((creature) => creature.name.toLowerCase() === monster.trim().toLowerCase());
          if (!target) return err('Créature introuvable dans le bestiaire du serveur.');

          const cleared = await clearFirstKill(guildId, target.name);
          if (!cleared) return err(`Personne n'a encore battu « ${target.name} » : il n'y a pas de record à effacer.`);

          await audit(key_name, 'Réinitialisation premier vainqueur RPG MCP', target.name, `Ancien premier vainqueur : ${cleared.userId}`);
          return ok({ ok: true, monster: target.name, previousWinner: cleared.userId, since: cleared.createdAt });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'save_rpg_title',
      {
        description: "Crée un titre du RPG, ou modifie celui qui porte cet ID. Seul le titre porté par un joueur lui donne ses bonus. Requiert WRITE_MEMBERS.",
        inputSchema: {
          id: z.string().optional().describe('ID du titre à modifier (voir get_rpg_titles). Absent : création.'),
          name: z.string().max(24).optional().describe('Nom affiché en haut de la carte du personnage, 24 caractères maximum (requis à la création)'),
          description: z.string().optional(),
          color: z.string().optional().describe('Couleur hexadécimale, ex. #fbbf24'),
          attackBonus: z.number().int().optional(),
          defenseBonus: z.number().int().optional(),
          speedBonus: z.number().int().optional(),
          healthBonus: z.number().int().optional().describe('PV maximum ajoutés'),
          critBonus: z.number().int().optional().describe('Chance de critique ajoutée, en points de pourcentage'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ id, key_name, ...input }) => {
        try {
          // En modification, le titre existant sert de base : un appel qui ne voulait changer
          // qu'un bonus ne doit pas remettre les autres à zéro.
          const existing = id ? await prisma.rpgTitle.findUnique({ where: { id } }) : null;
          const base = existing && existing.guildId === guildId ? {
            name: existing.name,
            description: existing.description,
            color: existing.color,
            attackBonus: existing.attackBonus,
            defenseBonus: existing.defenseBonus,
            speedBonus: existing.speedBonus,
            healthBonus: existing.healthBonus,
            critBonus: existing.critBonus,
          } : null;
          const { title, created } = await saveGuildTitle(guildId, mergeDefined(base, input), id);
          await audit(key_name, created ? 'Création titre RPG MCP' : 'Modification titre RPG MCP', title.name, title.description);
          return ok({ ok: true, id: title.id, created });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'delete_rpg_title',
      {
        description: "Supprime un titre du RPG : les joueurs le perdent et les créatures qui l'offraient n'offrent plus rien. Requiert WRITE_MEMBERS.",
        inputSchema: { id: z.string(), key_name: z.string().optional() },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ id, key_name }) => {
        try {
          const title = await deleteGuildTitle(guildId, id);
          await audit(key_name, 'Suppression titre RPG MCP', title.name, '');
          return ok({ ok: true });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'set_rpg_player_title',
      {
        description: "Donne un titre du RPG à un joueur, ou le lui retire. Requiert WRITE_MEMBERS.",
        inputSchema: {
          member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre'),
          title_id: z.string().describe('ID du titre (voir get_rpg_titles)'),
          owned: z.boolean().describe('Vrai pour le donner, faux pour le retirer'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, title_id, owned, key_name }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;
        try {
          const title = await prisma.rpgTitle.findUnique({ where: { id: title_id } });
          if (!title || title.guildId !== guildId) return err('Titre introuvable.');
          const profile = await prisma.rpgProfile.findUnique({
            where: { guildId_userId: { guildId, userId: resolved.userId } },
            select: { id: true },
          });
          if (!profile) return err("Ce membre n'a pas encore de personnage RPG.");

          const changed = owned ? Boolean(await grantTitle(profile.id, title_id)) : await revokeTitle(profile.id, title_id);
          await audit(key_name, owned ? 'Attribution titre RPG MCP' : 'Retrait titre RPG MCP', title.name, resolved.userId);
          return ok({ ok: true, changed });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'set_rpg_monster_enabled',
      {
        description: 'Active ou désactive une créature du bestiaire. Requiert WRITE_MEMBERS.',
        inputSchema: {
          id: z.string().describe('ID de la créature'),
          enabled: z.boolean(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ id, enabled, key_name }) => {
        try {
          const monster = await setGuildMonsterEnabled(guildId, id, enabled);
          await audit(key_name, enabled ? 'Réactivation monstre RPG MCP' : 'Désactivation monstre RPG MCP', monster.name, '');
          return ok({ ok: true });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'delete_rpg_monster',
      {
        description: "Supprime une créature du serveur. Sur une version personnalisée, rétablit la créature livrée de base. Requiert WRITE_MEMBERS.",
        inputSchema: {
          id: z.string().describe('ID de la créature'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ id, key_name }) => {
        try {
          const { monster, restoredGlobal } = await deleteGuildMonster(guildId, id);
          await audit(key_name, restoredGlobal ? 'Restauration monstre RPG MCP' : 'Suppression monstre RPG MCP', monster.name, '');
          return ok({ ok: true, restoredGlobal });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'save_rpg_fish',
      {
        description: "Crée une espèce de poisson, ou modifie celle désignée par `key` (voir get_rpg_fish). Modifier une espèce livrée de base en crée une version propre au serveur, dont le nom reste verrouillé. Renommer une espèce du serveur renomme aussi les prises déjà faites : les joueurs gardent leur progression. `enabled: false` la retire de la pêche. Requiert WRITE_MEMBERS.",
        inputSchema: {
          key: z.string().optional().describe('Clé de l\'espèce à modifier (voir get_rpg_fish). Absente : création.'),
          name: z.string().optional().describe(creationOnly('Nom')),
          emoji: z.string().optional(),
          rarity: z.enum(FISH_RARITIES).optional().describe('Rareté, COMMON par défaut'),
          value: z.number().int().min(0).optional().describe('Pièces gagnées à la prise'),
          xp: z.number().int().min(0).optional().describe('XP gagnée à la prise'),
          enabled: z.boolean().optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ key, key_name, ...input }) => {
        try {
          const existing = key ? (await getGuildFishCatalog(guildId)).find((fish) => fishKey(fish) === key) : null;
          if (key && !existing) return err('Poisson introuvable.');
          const base = existing
            ? { name: existing.name, emoji: existing.emoji, rarity: existing.rarity, value: existing.value, xp: existing.xp, enabled: existing.enabled }
            : null;
          const { fish, created } = await saveGuildFish(guildId, mergeDefined(base, input), key);
          await audit(key_name, created ? 'Création poisson RPG MCP' : 'Modification poisson RPG MCP', fish.name, `${fish.rarity}${fish.enabled ? '' : ' - désactivé'}`);
          return ok({ ok: true, key: fish.id, created });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'delete_rpg_fish',
      {
        description: "Supprime une espèce propre au serveur. Sur une version personnalisée d'une espèce livrée, rétablit l'originale. Les prises déjà faites restent comptées dans le total des joueurs. Requiert WRITE_MEMBERS.",
        inputSchema: {
          key: z.string().describe('Clé de l\'espèce (voir get_rpg_fish)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ key, key_name }) => {
        try {
          const { fish, restoredDefault } = await deleteGuildFish(guildId, key);
          await audit(key_name, restoredDefault ? 'Restauration poisson RPG MCP' : 'Suppression poisson RPG MCP', fish.name, '');
          return ok({ ok: true, restoredDefault });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'save_rpg_dungeon',
      {
        description: "Crée un donjon, ou modifie celui désigné par `id` (voir get_rpg_dungeons). Les étages sont des boss du bestiaire désignés par leur nom exact, dans l'ordre, désactivés compris ; un même boss peut revenir. Les parties déjà lancées gardent leurs étages. Le coffre est versé à chaque joueur qui termine, la prime du premier vainqueur une seule fois. L'XP est celle du RPG. Un champ omis garde sa valeur. Requiert WRITE_MEMBERS.",
        inputSchema: {
          id: z.string().optional().describe('ID du donjon à modifier. Absent : création.'),
          name: z.string().optional().describe(creationOnly('Nom')),
          emoji: z.string().optional(),
          description: z.string().optional(),
          bossNames: z.array(z.string()).min(1).max(DUNGEON_FLOORS_MAX).optional().describe(creationOnly('Noms des boss, un par étage, dans l\'ordre')),
          levelRequired: z.number().int().min(1).optional(),
          energyCost: z.number().int().min(0).optional(),
          cooldownHours: z.number().int().min(0).max(720).optional().describe('Attente entre deux entrées d\'un même joueur, 0 pour aucune'),
          completionCoins: z.number().int().min(0).optional(),
          completionXp: z.number().int().min(0).optional().describe('XP RPG du coffre'),
          completionItemName: z.string().nullable().optional().describe('Objet du coffre (nom exact), null pour aucun'),
          completionTitleId: z.string().nullable().optional().describe('Titre du coffre (voir get_rpg_titles), null pour aucun'),
          completionRoleId: z.string().nullable().optional().describe('Rôle Discord du coffre, null pour aucun'),
          firstClearCoins: z.number().int().min(0).optional(),
          firstClearXp: z.number().int().min(0).optional().describe('XP RPG de la prime du premier vainqueur'),
          firstClearItemName: z.string().nullable().optional(),
          firstClearTitleId: z.string().nullable().optional(),
          firstClearRoleId: z.string().nullable().optional(),
          enabled: z.boolean().optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ id, key_name, ...input }) => {
        try {
          const existing = id ? (await listGuildDungeons(guildId)).find((dungeon) => dungeon.id === id) : null;
          if (id && !existing) return err('Donjon introuvable.');
          const base = existing
            ? {
              name: existing.name,
              emoji: existing.emoji,
              description: existing.description,
              bossNames: existing.bossNames,
              levelRequired: existing.levelRequired,
              energyCost: existing.energyCost,
              cooldownHours: existing.cooldownHours,
              completionCoins: existing.completionCoins,
              completionXp: existing.completionXp,
              completionItemName: existing.completionItemName,
              completionTitleId: existing.completionTitleId,
              completionRoleId: existing.completionRoleId,
              firstClearCoins: existing.firstClearCoins,
              firstClearXp: existing.firstClearXp,
              firstClearItemName: existing.firstClearItemName,
              firstClearTitleId: existing.firstClearTitleId,
              firstClearRoleId: existing.firstClearRoleId,
              enabled: existing.enabled,
            }
            : null;
          const { dungeon, created } = await saveGuildDungeon(client, guildId, mergeDefined(base, input), id);
          await audit(key_name, created ? 'Création donjon RPG MCP' : 'Modification donjon RPG MCP', dungeon.name, `${dungeon.bossNames.length} étages${dungeon.enabled ? '' : ' - fermé'}`);
          return ok({ ok: true, id: dungeon.id, created });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'set_rpg_dungeon_enabled',
      {
        description: "Ouvre ou ferme un donjon. Fermé, il disparaît de la salle des donjons ; les parties déjà lancées peuvent se terminer. Requiert WRITE_MEMBERS.",
        inputSchema: {
          id: z.string().describe('ID du donjon (voir get_rpg_dungeons)'),
          enabled: z.boolean(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ id, enabled, key_name }) => {
        try {
          const dungeon = await setGuildDungeonEnabled(guildId, id, enabled);
          await audit(key_name, enabled ? 'Ouverture donjon RPG MCP' : 'Fermeture donjon RPG MCP', dungeon.name, '');
          return ok({ ok: true });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'delete_rpg_dungeon',
      {
        description: "Supprime un donjon. Les joueurs en pleine partie repartent avec le butin déjà gagné, comme s'ils étaient sortis d'eux-mêmes. Requiert WRITE_MEMBERS.",
        inputSchema: {
          id: z.string().describe('ID du donjon (voir get_rpg_dungeons)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ id, key_name }) => {
        try {
          const { dungeon, settledRuns } = await deleteGuildDungeon(guildId, id);
          await audit(key_name, 'Suppression donjon RPG MCP', dungeon.name, settledRuns > 0 ? `${settledRuns} partie(s) en cours soldée(s)` : '');
          return ok({ ok: true, settledRuns });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'reset_rpg_dungeon_first_clear',
      {
        description: "Efface le premier vainqueur d'un donjon : le prochain joueur à le terminer touchera la prime. Ce que l'ancien vainqueur a reçu lui reste acquis. Requiert WRITE_MEMBERS.",
        inputSchema: {
          id: z.string().describe('ID du donjon (voir get_rpg_dungeons)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ id, key_name }) => {
        try {
          const dungeon = await clearDungeonFirstClear(guildId, id);
          await audit(key_name, 'Remise en jeu premier vainqueur donjon MCP', dungeon.name, '');
          return ok({ ok: true });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'save_rpg_fishbook_reward',
      {
        description: "Règle la récompense d'un palier du carnet de pêche : une rareté entière (COMMON...LEGENDARY) ou COMPLETE pour le carnet entier. Elle peut combiner pièces, XP, points de clan (ou XP de guilde), un objet, un titre et un rôle. Chaque joueur la touche une fois, dès que le palier est terminé. Tout à zéro rend le palier muet ; `reset: true` rend la récompense par défaut. Requiert WRITE_MEMBERS.",
        inputSchema: {
          tier: z.enum(FISH_BOOK_TIERS),
          coinReward: z.number().int().min(0).optional(),
          xpReward: z.number().int().min(0).optional(),
          clanPoints: z.number().int().min(0).optional().describe('Points de clan, ou XP de guilde selon les équipes du serveur'),
          itemName: z.string().nullable().optional().describe('Objet offert (nom exact), null pour aucun'),
          roleId: z.string().nullable().optional().describe('ID du rôle Discord offert, null pour aucun'),
          titleId: z.string().nullable().optional().describe('ID du titre offert (voir get_rpg_titles), null pour aucun'),
          reset: z.boolean().optional().describe('Revenir à la récompense par défaut'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ tier, reset, key_name, ...input }) => {
        try {
          if (reset) {
            await resetFishBookReward(guildId, tier);
            await audit(key_name, 'Réinitialisation récompense carnet de pêche MCP', tier, '');
            return ok({ ok: true, reset: true });
          }
          const current = (await getFishBookRewards(guildId)).find((reward) => reward.tier === tier);
          const base = current
            ? { coinReward: current.coinReward, xpReward: current.xpReward, clanPoints: current.clanPoints, itemName: current.itemName, roleId: current.roleId, titleId: current.titleId }
            : null;
          const reward = await saveFishBookReward(client, guildId, tier, mergeDefined(base, input));
          await audit(key_name, 'Récompense carnet de pêche MCP', tier, `${reward.coinReward} pièces, ${reward.xpReward} XP`);
          return ok({ ok: true, reward });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'apply_rpg_difficulty',
      {
        description: "Applique un palier de difficulté aux boss, aux monstres ou aux prix de la boutique. `preview` montre les changements sans rien écrire. Requiert WRITE_MEMBERS.",
        inputSchema: {
          target: z.enum(['boss', 'monster', 'shop']),
          difficulty: z.enum(DIFFICULTIES),
          preview: z.boolean().default(true).describe('Vrai : simulation seulement'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ target, difficulty, preview, key_name }) => {
        try {
          const config = await getOrCreateEconomyConfig(guildId);
          if (target === 'shop') {
            const from = asDifficulty(config.shopDifficulty);
            const result = await applyShopDifficulty(guildId, { from, to: difficulty, dryRun: preview });
            if (!preview) await audit(key_name, 'Difficulté des prix RPG MCP', `${from} vers ${difficulty}`, `${result.updated} prix modifié(s)`);
            // `result.preview` porte le detail des lignes : le drapeau de
            // simulation se nomme donc `dryRun`, sinon le spread l'ecrase et
            // l'appelant ne sait plus si quoi que ce soit a ete ecrit.
            return ok({ ok: true, from, to: difficulty, dryRun: preview, ...result });
          }

          const isBoss = target === 'boss';
          const from = asDifficulty(isBoss ? config.bossDifficulty : config.monsterDifficulty);
          const result = await applyBestiaryDifficulty(guildId, { isBoss, from, to: difficulty, dryRun: preview });
          if (!preview) await audit(key_name, 'Difficulté du bestiaire RPG MCP', `${isBoss ? 'Boss' : 'Monstres'} : ${from} vers ${difficulty}`, `${result.updated} fiche(s) réécrite(s)`);
          return ok({ ok: true, from, to: difficulty, dryRun: preview, ...result });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'save_rpg_raid_boss',
      {
        description: 'Crée ou modifie un boss de raid. Requiert WRITE_MEMBERS.',
        inputSchema: {
          id: z.string().optional().describe('ID du boss à modifier (voir get_rpg_raid). Absent : création.'),
          name: z.string().optional().describe(creationOnly('Nom')),
          description: z.string().optional().describe(creationOnly('Description')),
          emoji: z.string().optional(),
          level: z.number().int().optional().describe(creationOnly('Niveau')),
          attack: z.number().int().optional().describe(creationOnly('Attaque')),
          defense: z.number().int().optional().describe(creationOnly('Défense')),
          speed: z.number().int().optional().describe(creationOnly('Vitesse')),
          spellIds: z.array(z.string()).optional().describe('Sorts du boss (voir get_rpg_reference)'),
          enabled: z.boolean().optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ id, key_name, ...input }) => {
        try {
          const existing = id ? await prisma.rpgRaidBoss.findFirst({ where: { id, guildId } }) : null;
          const base = existing ? {
            name: existing.name,
            description: existing.description,
            emoji: existing.emoji,
            level: existing.level,
            attack: existing.attack,
            defense: existing.defense,
            speed: existing.speed,
            spellIds: Array.isArray(existing.spells)
              ? existing.spells.flatMap((spell) => (spell && typeof spell === 'object' && 'id' in spell ? [String(spell.id)] : []))
              : [],
            enabled: existing.enabled,
          } : null;
          const { boss, created } = await saveGuildRaidBoss(guildId, mergeDefined(base, input), id);
          // La fenêtre déjà planifiée porte une copie de la fiche : sans cette reprise, la
          // modification ne se verrait qu'au raid suivant.
          await resyncScheduledRaidBoss(guildId, await getOrCreateEconomyConfig(guildId)).catch(() => undefined);
          await audit(key_name, created ? 'Création boss de raid MCP' : 'Modification boss de raid MCP', boss.name, `niv. ${boss.level}`);
          return ok({ ok: true, id: boss.id, created });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'delete_rpg_raid_boss',
      {
        description: 'Supprime un boss de raid. Requiert WRITE_MEMBERS.',
        inputSchema: {
          id: z.string(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ id, key_name }) => {
        try {
          const { name } = await deleteGuildRaidBoss(guildId, id);
          await resyncScheduledRaidBoss(guildId, await getOrCreateEconomyConfig(guildId)).catch(() => undefined);
          await audit(key_name, 'Suppression boss de raid MCP', name, '');
          return ok({ ok: true });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'restore_rpg_raid_bosses',
      {
        description: 'Rétablit les boss de raid livrés de base qui manquent. Ne touche pas aux boss existants. Requiert WRITE_MEMBERS.',
        inputSchema: { key_name: z.string().optional() },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ key_name }) => {
        try {
          const restored = await seedGuildRaidBosses(guildId);
          await audit(key_name, 'Restauration des boss de raid MCP', `${restored} boss`, '');
          return ok({ ok: true, restored });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'start_rpg_raid',
      {
        description: "Ouvre le raid tout de suite, sans attendre la fenêtre planifiée, et publie son annonce. Requiert WRITE_MEMBERS.",
        inputSchema: { key_name: z.string().optional() },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ key_name }) => {
        try {
          const config = await getOrCreateEconomyConfig(guildId);
          await startRaidNow(guildId, config);
          const raid = await getOpenRaid(guildId);
          if (raid) await announceOpenRaid(client, raid, config.raidAnnounce, config.raidRoleId);
          await audit(key_name, 'Lancement manuel du raid MCP', raid?.bossName ?? '', raid ? `jusqu'au ${raid.closesAt.toISOString()}` : '');
          return ok({ ok: true, bossName: raid?.bossName ?? null, closesAt: raid?.closesAt ?? null });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'save_rpg_quest',
      {
        description: "Crée ou modifie une quête du RPG. Objectifs et portées : voir get_rpg_reference. Requiert WRITE_MEMBERS.",
        inputSchema: {
          id: z.string().optional().describe('ID de la quête à modifier. Absent : création.'),
          name: z.string().optional().describe(creationOnly('Nom')),
          description: z.string().optional().describe(creationOnly('Description')),
          emoji: z.string().optional(),
          objective: z.enum(RPG_QUEST_OBJECTIVES).optional().describe(creationOnly('Objectif')),
          target: z.number().int().min(1).optional().describe(creationOnly('Quantité à atteindre')),
          scope: z.enum(RPG_QUEST_SCOPES).optional().describe('MEMBER par défaut à la création'),
          teamMode: z.string().optional().describe("Quêtes d'équipe : CLAN ou RPG_GUILD"),
          windowHours: z.number().int().optional().describe('Durée de la fenêtre en heures (24 = quotidienne, 168 = hebdomadaire)'),
          rewardCoins: z.number().int().optional(),
          rewardXp: z.number().int().optional(),
          rewardClanPoints: z.number().int().optional(),
          repeatable: z.boolean().optional(),
          enabled: z.boolean().optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ id, key_name, ...input }) => {
        try {
          const existing = id ? await prisma.rpgQuest.findFirst({ where: { id, guildId } }) : null;
          const base = existing ? {
            name: existing.name,
            description: existing.description,
            emoji: existing.emoji,
            objective: existing.objective,
            target: existing.target,
            scope: existing.scope,
            teamMode: existing.teamMode,
            windowHours: existing.windowHours,
            rewardCoins: existing.rewardCoins,
            rewardXp: existing.rewardXp,
            rewardClanPoints: existing.rewardClanPoints,
            repeatable: existing.repeatable,
            enabled: existing.enabled,
          } : null;
          const { quest, created } = await saveGuildQuest(guildId, mergeDefined(base, input), id);
          await audit(key_name, created ? 'Création quête RPG MCP' : 'Modification quête RPG MCP', quest.name, `${quest.objective} x${quest.target}`);
          return ok({ ok: true, id: quest.id, created });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'delete_rpg_quest',
      {
        description: 'Supprime une quête du RPG. Requiert WRITE_MEMBERS.',
        inputSchema: { id: z.string(), key_name: z.string().optional() },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ id, key_name }) => {
        try {
          const { name } = await deleteGuildQuest(guildId, id);
          await audit(key_name, 'Suppression quête RPG MCP', name, '');
          return ok({ ok: true });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'save_rpg_recipe',
      {
        description: "Crée ou modifie une recette d'artisanat. Requiert WRITE_MEMBERS.",
        inputSchema: {
          id: z.string().optional().describe('ID de la recette à modifier. Absent : création.'),
          result_item: z.string().optional().describe(creationOnly("ID ou nom de l'objet fabriqué")),
          ingredients: z.array(z.object({
            itemName: z.string().describe("Nom exact d'un matériau"),
            quantity: z.number().int().min(1),
          })).min(1).optional().describe(creationOnly('Matériaux')),
          coinCost: z.number().int().min(0).optional().describe('0 par défaut à la création'),
          levelRequired: z.number().int().min(1).optional().describe('1 par défaut à la création'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ id, result_item, ingredients, coinCost, levelRequired, key_name }) => {
        try {
          let resultItemId: string | undefined;
          if (result_item) {
            const resolved = await resolveItem(guildId, result_item);
            if (!resolved.ok) return resolved.response;
            resultItemId = resolved.item.id;
          }
          const existing = id ? await prisma.rpgRecipe.findUnique({ where: { id } }) : null;
          const base = existing
            ? { resultItemId: existing.resultItemId, ingredients: existing.ingredients, coinCost: existing.coinCost, levelRequired: existing.levelRequired }
            : { coinCost: 0, levelRequired: 1 };
          const { recipe, created } = await saveGuildRecipe(guildId, mergeDefined(base, { resultItemId, ingredients, coinCost, levelRequired }), id);
          await audit(key_name, created ? 'Création recette RPG MCP' : 'Modification recette RPG MCP', recipe.id, '');
          return ok({ ok: true, id: recipe.id, created });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'delete_rpg_recipe',
      {
        description: "Supprime une recette d'artisanat du serveur. Requiert WRITE_MEMBERS.",
        inputSchema: { id: z.string(), key_name: z.string().optional() },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ id, key_name }) => {
        try {
          const { name } = await deleteGuildRecipe(guildId, id);
          await audit(key_name, 'Suppression recette RPG MCP', name, '');
          return ok({ ok: true });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'save_rpg_adventure_event',
      {
        description: "Crée ou modifie un événement de voyage (1 à 5 choix). Modifier un événement livré de base en crée une version propre au serveur, sous le même titre. Requiert WRITE_MEMBERS.",
        inputSchema: {
          id: z.string().optional().describe("ID de l'événement à modifier (voir get_rpg_adventure_events). Absent : création."),
          title: z.string().optional().describe(creationOnly('Titre')),
          description: z.string().optional().describe(creationOnly('Ce qui se passe')),
          emoji: z.string().optional(),
          choices: z.array(choiceSchema).min(1).max(5).optional().describe(creationOnly('Choix proposés, 1 à 5')),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ id, key_name, ...input }) => {
        try {
          const existing = id ? await prisma.rpgAdventureEvent.findUnique({ where: { id } }) : null;
          const base = existing
            ? { title: existing.title, description: existing.description, emoji: existing.emoji, choices: parseAdventureChoices(existing.choices) }
            : null;
          const { event, created } = await saveGuildAdventureEvent(guildId, mergeDefined(base, input), id);
          await audit(key_name, created ? 'Création événement de voyage MCP' : 'Modification événement de voyage MCP', event.title, '');
          return ok({ ok: true, id: event.id, created, overridesGlobal: event.overridesGlobal });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'set_rpg_adventure_event_enabled',
      {
        description: "Retire un événement livré de base du tirage des voyages, ou l'y remet. Requiert WRITE_MEMBERS.",
        inputSchema: { id: z.string(), enabled: z.boolean(), key_name: z.string().optional() },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ id, enabled, key_name }) => {
        try {
          const { title } = await setGlobalAdventureEventEnabled(guildId, id, enabled);
          await audit(key_name, enabled ? 'Réactivation événement de voyage MCP' : 'Désactivation événement de voyage MCP', title, '');
          return ok({ ok: true });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'delete_rpg_adventure_event',
      {
        description: "Supprime un événement du serveur. Sur une version personnalisée, rétablit l'événement livré de base. Requiert WRITE_MEMBERS.",
        inputSchema: { id: z.string(), key_name: z.string().optional() },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ id, key_name }) => {
        try {
          const { title, restoredGlobal } = await deleteGuildAdventureEvent(guildId, id);
          await audit(key_name, restoredGlobal ? 'Restauration événement de voyage MCP' : 'Suppression événement de voyage MCP', title, '');
          return ok({ ok: true, restoredGlobal });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'update_rpg_guild',
      {
        description: "Modifie une guilde RPG : nom, description, étendard, trésor ou chef (qui doit en être membre). Requiert WRITE_MEMBERS.",
        inputSchema: {
          id: z.string().describe('ID de la guilde (voir get_rpg_guilds)'),
          name: z.string().optional(),
          description: z.string().optional(),
          emoji: z.string().optional(),
          treasury: z.number().int().min(0).optional(),
          owner: z.string().optional().describe('Nouveau chef : nom, @mention ou ID du membre'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ id, name, description, emoji, treasury, owner, key_name }) => {
        try {
          let ownerId: string | undefined;
          if (owner) {
            const resolved = await resolveMember(guildId, owner);
            if (!resolved.ok) return resolved.response;
            ownerId = resolved.userId;
          }
          const { before, after } = await adminUpdateRpgGuild(guildId, id, { name, description, emoji, treasury, ownerId });
          await audit(key_name, 'Modification guilde RPG MCP', after.name,
            before.treasury !== after.treasury ? `trésor : ${before.treasury} vers ${after.treasury}` : '');
          return ok({ ok: true });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'remove_rpg_guild_member',
      {
        description: "Retire un membre d'une guilde RPG. Le chef ne peut pas être retiré. Requiert WRITE_MEMBERS.",
        inputSchema: {
          id: z.string().describe('ID de la guilde'),
          member: z.string().describe('Nom, @mention ou ID du membre'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ id, member, key_name }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;
        try {
          const { guildName } = await adminRemoveRpgGuildMember(guildId, id, resolved.userId);
          await audit(key_name, 'Exclusion membre guilde RPG MCP', guildName, resolved.label);
          return ok({ ok: true });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'dissolve_rpg_guild',
      {
        description: "Dissout une guilde RPG : ses membres gardent leur profil, son trésor et son village sont perdus. Requiert une validation staff (request_staff_approval). Requiert WRITE_MEMBERS.",
        inputSchema: {
          id: z.string().describe('ID de la guilde'),
          approved_by_staff: z.boolean().default(false).describe('Indique si un bouton Discord a déjà approuvé cette demande'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ id, approved_by_staff, key_name }) => {
        // Même garde que la remise à zéro de l'économie : le trésor d'une guilde est le
        // fruit du travail de tous ses membres, il ne part pas sur une simple demande.
        if (!approved_by_staff) {
          return err('Action critique rejetée. Utilisez request_staff_approval pour soumettre la dissolution à la validation humaine du staff.');
        }
        try {
          const { name, members, treasury } = await adminDissolveRpgGuild(guildId, id);
          await audit(key_name, 'Dissolution guilde RPG MCP', name, `${members} membre(s) détaché(s), trésor de ${treasury} perdu`);
          return ok({ ok: true, name, members, treasury });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'update_rpg_player',
      {
        description: "Fixe des statistiques de base d'un joueur RPG. Un champ omis n'est pas touché. Requiert WRITE_MEMBERS.",
        inputSchema: {
          member: z.string().describe('Nom, @mention ou ID du membre'),
          balance: z.number().int().optional(),
          level: z.number().int().optional(),
          xp: z.number().int().optional(),
          health: z.number().int().optional(),
          maxHealth: z.number().int().optional(),
          energy: z.number().int().optional(),
          attack: z.number().int().optional(),
          defense: z.number().int().optional(),
          speed: z.number().int().optional(),
          statPoints: z.number().int().optional(),
          skillPoints: z.number().int().optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, key_name, ...stats }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;
        try {
          const profile = await adminUpdatePlayerStats(guildId, resolved.userId, stats);
          await audit(key_name, 'Modification profil RPG MCP', resolved.label, Object.keys(stats).join(', '));
          return ok({ ok: true, balance: profile.balance, level: profile.level, xp: profile.xp });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'give_rpg_item',
      {
        description: "Donne des exemplaires d'un objet à un joueur RPG. Requiert WRITE_MEMBERS.",
        inputSchema: {
          member: z.string().describe('Nom, @mention ou ID du membre'),
          item: z.string().describe("ID ou nom exact de l'objet"),
          quantity: z.number().int().min(1).default(1),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, item, quantity, key_name }) => {
        const resolvedMember = await resolveMember(guildId, member);
        if (!resolvedMember.ok) return resolvedMember.response;
        const resolvedItem = await resolveItem(guildId, item);
        if (!resolvedItem.ok) return resolvedItem.response;
        try {
          const granted = await adminGrantItem(guildId, resolvedMember.userId, resolvedItem.item.id, quantity);
          await audit(key_name, 'Don objet RPG MCP', resolvedMember.label, `${granted.quantity} x ${granted.itemName}`);
          return ok({ ok: true, ...granted });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'remove_rpg_item',
      {
        description: "Retire des exemplaires d'un objet à un joueur RPG. Retirer le dernier exemplaire le déséquipe et efface sa forge et ses enchantements. Requiert WRITE_MEMBERS.",
        inputSchema: {
          member: z.string().describe('Nom, @mention ou ID du membre'),
          item: z.string().describe("ID ou nom exact de l'objet"),
          quantity: z.number().int().min(1).default(1),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, item, quantity, key_name }) => {
        const resolvedMember = await resolveMember(guildId, member);
        if (!resolvedMember.ok) return resolvedMember.response;
        const resolvedItem = await resolveItem(guildId, item);
        if (!resolvedItem.ok) return resolvedItem.response;
        try {
          const result = await adminTakeItem(guildId, resolvedMember.userId, resolvedItem.item.id, quantity);
          await audit(key_name, 'Retrait objet RPG MCP', resolvedMember.label, `${result.removedQuantity} x ${result.itemName}`);
          return ok({ ok: true, removed: result.removedQuantity, remaining: result.remainingQuantity });
        } catch (e) {
          return fail(e);
        }
      })
    );
  }
}
