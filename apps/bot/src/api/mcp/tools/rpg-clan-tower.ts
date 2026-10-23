/**
 * Outils MCP de la Tour de clan : une tour hebdomadaire que les clans du serveur (rôles
 * Discord, jamais les guildes RPG) gravissent chacun de leur côté.
 */

import { z } from 'zod';
import { type McpToolContext, err, ok, toolError } from '../toolkit.js';
import {
  getClanTowerConfig,
  getClanTowerDashboard,
  saveClanTowerFloors,
  saveClanTowerSettings,
} from '../../../services/features/rpg/rpgClanTowerService.js';
import {
  CLAN_TOWER_MILESTONE_BONUSES,
  CLAN_TOWER_NAME_MAX,
  CLAN_TOWER_PODIUM_SIZE,
  CLAN_TOWER_RANGES,
} from '../../../services/features/rpg/rpgClanTowerPolicy.js';
import {
  TOWER_FLOORS_AFTER,
  TOWER_FLOORS_MAX,
  TOWER_FLOOR_MODIFIERS,
  TOWER_FLOOR_THEMES,
  TOWER_FLOOR_NAME_MAX,
  TOWER_MAP_ROOMS_MAX,
  TOWER_MAP_SIZE,
  TOWER_VARIANT_WEIGHT,
} from '../../../services/features/rpg/rpgTowerMap.js';
import { appendFailed, compactTowerSettings, editTowerFloors, floorSchema, roomSchema, towerCardsReadSchema, towerFloorsSaved, towerSettingsSaved } from './rpg-tower.js';

const fail = (e: unknown) => toolError(e);

const range = (key: keyof typeof CLAN_TOWER_RANGES) =>
  z.number().int().min(CLAN_TOWER_RANGES[key].min).max(CLAN_TOWER_RANGES[key].max);

const RULES = "Chaque semaine, au jour et à l'heure réglés (fuseau du serveur), la Tour de clan ouvre pour `durationHours` heures. Tout membre d'un clan du serveur y entre à égalité (sans héritage du RPG, ni titre, ni compétence), une fois par tranche de 24 h depuis l'ouverture, par /tour. Rien n'en sort : ni éclats, ni équipement, ni record. Le premier membre d'un clan à franchir un étage le conquiert : à la clôture, chaque conquérant reçoit `pointsPerFloor` points de clan par étage conquis, et les trois premiers clans (étage le plus haut, puis premier arrivé) le podium `podiumPoints`, versé au clan entier, sous la source RPG_TOWER_CLAN ; le bilan part en un seul message dans le salon du flux des points de clan. Gardien, élites, épreuves, sceaux, prisonniers et sortie vaincus le restent pour tout le clan (une sortie conquise se franchit sans combat). Paliers collectifs : quand les étages gravis au total par les membres d'un clan atteignent `milestones`, ses tentatives suivantes reçoivent +1 potion, puis +10 % de PV, puis +10 % d'attaque. Même tour et même graine pour tous les clans. Les guildes RPG n'y participent pas.";

export function registerRpgClanTowerTools(ctx: McpToolContext) {
  const { server, guildId, shouldRegister, guard, audit, toolMeta } = ctx;

  if (shouldRegister('READ_ECONOMY')) {
    server.registerTool(
      'get_rpg_clan_tower',
      {
        description: `Lit la Tour de clan. ${RULES} Contient : réglages (settings, dont les étages dessinés settings.floors), clansEnabled (sans les clans du serveur, elle n'ouvre pas), la semaine en cours (current : fin, classement des clans avec étage conquis, meilleurs grimpeurs, étages gravis au total et paliers franchis), le bilan de la semaine précédente (last.results) et la prochaine ouverture (nextOpensAt). Une salle n'indique que les réglages qui s'écartent du défaut. Seules les cartes fromCard à toCard (20 au plus) sont lues en entier ; les autres n'indiquent que leur nom, leur taille et leur nombre de salles (roomCount).`,
        inputSchema: towerCardsReadSchema,
        _meta: toolMeta,
      },
      guard('READ_ECONOMY', async (cards) => {
        const dashboard = await getClanTowerDashboard(guildId);
        return ok({
          ...dashboard,
          settings: compactTowerSettings(dashboard.settings, cards),
          reference: {
            ranges: CLAN_TOWER_RANGES,
            podiumSize: CLAN_TOWER_PODIUM_SIZE,
            milestoneBonuses: CLAN_TOWER_MILESTONE_BONUSES,
            floorsAfter: TOWER_FLOORS_AFTER,
          },
        });
      })
    );
  }

  if (shouldRegister('WRITE_MEMBERS')) {
    server.registerTool(
      'save_rpg_clan_tower_settings',
      {
        description: `Modifie les réglages de la Tour de clan. Un champ omis garde sa valeur. Changer le jour, l'heure ou la durée vaut pour la prochaine ouverture : la semaine en cours garde ses dates. ${RULES} Requiert WRITE_MEMBERS.`,
        inputSchema: {
          enabled: z.boolean().optional().describe('Ouvre chaque semaine (true) ou plus du tout (false). La Tour elle-même, le RPG et les clans du serveur doivent aussi être actifs.'),
          name: z.string().max(CLAN_TOWER_NAME_MAX).optional(),
          weekday: range('weekday').optional().describe('Jour d\'ouverture : 0 = dimanche … 6 = samedi'),
          hour: range('hour').optional().describe('Heure d\'ouverture, sur le fuseau du serveur'),
          durationHours: range('durationHours').optional().describe('Durée en heures ; une tentative par membre et par tranche de 24 h'),
          pointsPerFloor: range('pointsPerFloor').optional().describe('Points de clan par étage conquis, au membre qui l\'a conquis'),
          podiumPoints: z.array(range('podiumPoints')).length(CLAN_TOWER_PODIUM_SIZE).optional().describe('Bonus du podium, 1er, 2e, 3e, versés au clan entier'),
          milestones: z.array(range('milestones')).length(CLAN_TOWER_MILESTONE_BONUSES.length).optional().describe('Paliers collectifs strictement croissants (étages gravis au total par le clan)'),
          floorsAfter: z.enum(TOWER_FLOORS_AFTER).optional().describe('Après le dernier étage dessiné : GENERATE génère des étages, LOOP reprend au premier'),
          generatedFog: z.boolean().optional().describe('Brouillard de guerre sur les étages générés'),
          announceChannelId: z.string().nullable().optional().describe("Salon où annoncer l'ouverture ; null pour aucune annonce"),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ key_name, ...input }) => {
        try {
          const settings = await saveClanTowerSettings(guildId, input);
          await audit(key_name, 'Réglages de la Tour de clan MCP', settings.name, `${settings.enabled ? 'activée' : 'désactivée'}, ${settings.pointsPerFloor} pts par étage`);
          return ok({ ok: true, settings: towerSettingsSaved(settings) });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'save_rpg_clan_tower_layout',
      {
        description: `Dessine les étages de la Tour de clan, au même format que save_rpg_tower_layout (voir sa description pour les règles d'une carte). \`floors\` remplace toute la tour, \`appendFloors\` ajoute plusieurs cartes à la fin (à préférer pour dessiner une longue tour) ; sinon \`floor\` (1 = première carte, variantes comptées) désigne la carte à modifier ou à ajouter à la suite, avec \`name\`, \`variant\`, \`weight\`, \`width\`, \`height\`, \`rooms\`, ou \`useDefault: true\` pour la carte d'exemple. \`removeFloor\` retire la carte \`floor\`. Sans aucun étage, la Tour de clan génère les siens. ${TOWER_FLOORS_MAX} cartes au plus. Un étage redessiné en cours de semaine perd les salles déjà conquises par les clans. Requiert WRITE_MEMBERS.`,
        inputSchema: {
          floors: z.array(floorSchema).max(TOWER_FLOORS_MAX).optional().describe('Remplace tous les étages, dans l\'ordre de la montée'),
          appendFloors: z.array(floorSchema).max(TOWER_FLOORS_MAX).optional().describe('Cartes ajoutées à la fin de la tour, dans l\'ordre de la montée, sans toucher aux cartes existantes'),
          floor: z.number().int().min(1).max(TOWER_FLOORS_MAX).optional().describe('Carte à modifier (1 = première, variantes comptées). Défaut : 1.'),
          removeFloor: z.boolean().optional().describe('Retire la carte `floor`'),
          useDefault: z.boolean().optional().describe('Remplacer la carte par la carte d\'exemple'),
          name: z.string().max(TOWER_FLOOR_NAME_MAX).optional(),
          fog: z.boolean().optional(),
          modifier: z.enum(TOWER_FLOOR_MODIFIERS).optional(),
          theme: z.enum(TOWER_FLOOR_THEMES).optional(),
          variant: z.boolean().optional().describe('Variante de la carte précédente : les deux forment un même étage, l\'une est tirée au sort'),
          weight: z.number().int().min(TOWER_VARIANT_WEIGHT.min).max(TOWER_VARIANT_WEIGHT.max).optional().describe('Poids de la carte au tirage entre les variantes de son étage'),
          width: z.number().int().min(TOWER_MAP_SIZE.min).max(TOWER_MAP_SIZE.max).optional(),
          height: z.number().int().min(TOWER_MAP_SIZE.min).max(TOWER_MAP_SIZE.max).optional(),
          rooms: z.array(roomSchema).max(TOWER_MAP_ROOMS_MAX).optional().describe('Salles de la carte. Absent : celles de la carte actuelle sont gardées.'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ key_name, ...input }) => {
        try {
          const existing = (await getClanTowerConfig(guildId)).floors;
          const next = editTowerFloors(existing, input);
          if (typeof next === 'string') return err(next);
          const settings = await saveClanTowerFloors(guildId, { floors: next }).catch((e: unknown) => {
            throw appendFailed(e, existing.length, input.appendFloors);
          });
          const saved = towerFloorsSaved(settings.floors);
          await audit(key_name, 'Étages de la Tour de clan MCP', 'Carte', `${saved.floors} étage(s), ${saved.cards} carte(s), ${saved.rooms} salles`);
          return ok(saved);
        } catch (e) {
          return fail(e);
        }
      })
    );
  }
}
