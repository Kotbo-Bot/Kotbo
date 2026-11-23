/**
 * Outils MCP - configuration de l'anti-raid (seuils, action, durée du verrou,
 * comptes trop récents, rôles rendus au retour, filtre anti-arnaque).
 *
 * Lecture sous READ_MODERATION, écriture sous WRITE_MEMBERS (comme la
 * modération des pseudos). Mêmes champs et mêmes bornes que le PATCH du
 * dashboard (`routes/dashboard/raidProtection.ts`).
 */
import { z } from 'zod';
import {
  getRaidProtectionConfig,
  upsertRaidProtectionConfig,
} from '../../../services/moderation/raidProtectionService.js';
import { type McpToolContext, SNOWFLAKE, err, ok, toolError } from '../toolkit.js';

const SNOWFLAKE_OR_NULL = z.string().regex(SNOWFLAKE).nullable();
const SNOWFLAKE_LIST = z.array(z.string().regex(SNOWFLAKE)).max(100);
const DOMAIN_LIST = z.array(z.string().trim().toLowerCase().min(3).max(253)).max(200);

/** Champs modifiables, bornés comme dans le dashboard. */
export const ANTIRAID_INPUT = {
  anti_raid_enabled: z.boolean().optional().describe('Détection des vagues d\'arrivées'),
  join_threshold: z.number().int().min(2).max(500).optional().describe('Arrivées déclenchant le raid mode…'),
  join_window_seconds: z.number().int().min(5).max(3600).optional().describe('…dans cette fenêtre (secondes)'),
  action: z.enum(['LOCK', 'CAPTCHA', 'KICK']).optional().describe('Action au déclenchement : verrou des arrivées, captcha forcé ou expulsion'),
  alert_channel_id: SNOWFLAKE_OR_NULL.optional().describe('Salon d\'alerte (null pour retirer)'),
  auto_disable_minutes: z.number().int().min(1).max(10080).optional().describe('Durée du verrou avant levée automatique (minutes)'),
  join_lock_kick: z.boolean().optional().describe('Expulser les arrivants pendant un verrou'),
  join_lock_message: z.string().max(500).optional().describe('Message envoyé à l\'arrivant refoulé'),
  account_age_enabled: z.boolean().optional().describe('Refuser les comptes trop récents'),
  account_age_min_value: z.number().int().min(1).max(3650).optional().describe('Ancienneté minimale (jours ou mois selon account_age_unit)'),
  account_age_unit: z.enum(['DAYS', 'MONTHS']).optional(),
  account_age_action: z.enum(['ALERT', 'KICK', 'BAN', 'JAIL', 'TEMPBAN']).optional(),
  account_age_message: z.string().max(500).optional(),
  account_age_whitelist: SNOWFLAKE_LIST.optional().describe('Membres exemptés (IDs)'),
  role_persist_enabled: z.boolean().optional().describe('Rendre ses rôles à un membre qui revient'),
  role_persist_mode: z.enum(['ALL', 'LIST']).optional(),
  role_persist_role_ids: SNOWFLAKE_LIST.optional(),
  role_persist_max_days: z.number().int().min(1).max(365).optional(),
  scam_filter_enabled: z.boolean().optional().describe('Filtre anti-arnaque (liens de phishing connus)'),
  scam_filter_action: z.enum(['DELETE', 'DELETE_AND_WARN', 'DELETE_AND_TIMEOUT', 'DELETE_AND_BAN']).optional(),
  scam_filter_timeout_minutes: z.number().int().min(1).max(40320).optional(),
  scam_filter_custom_domains: DOMAIN_LIST.optional().describe('Domaines supplémentaires bloqués'),
  scam_filter_whitelist: DOMAIN_LIST.optional().describe('Domaines exemptés'),
  scam_filter_alert_channel_id: SNOWFLAKE_OR_NULL.optional(),
};

type AntiraidInput = { [K in keyof typeof ANTIRAID_INPUT]?: z.infer<(typeof ANTIRAID_INPUT)[K]> };

/** Entrée de l'outil → colonnes de la configuration ; les champs absents ne bougent pas. */
export function toConfigPatch(input: AntiraidInput): Record<string, unknown> {
  const map: Array<[keyof AntiraidInput, string]> = [
    ['anti_raid_enabled', 'antiRaidEnabled'],
    ['join_threshold', 'antiRaidJoinThreshold'],
    ['join_window_seconds', 'antiRaidJoinWindowSec'],
    ['action', 'antiRaidAction'],
    ['alert_channel_id', 'antiRaidAlertChannelId'],
    ['auto_disable_minutes', 'antiRaidAutoDisableMinutes'],
    ['join_lock_kick', 'joinLockKick'],
    ['join_lock_message', 'joinLockMessage'],
    ['account_age_enabled', 'accountAgeGuardEnabled'],
    ['account_age_min_value', 'accountAgeMinValue'],
    ['account_age_unit', 'accountAgeMinUnit'],
    ['account_age_action', 'accountAgeAction'],
    ['account_age_message', 'accountAgeMessage'],
    ['account_age_whitelist', 'accountAgeWhitelist'],
    ['role_persist_enabled', 'rolePersistEnabled'],
    ['role_persist_mode', 'rolePersistMode'],
    ['role_persist_role_ids', 'rolePersistRoleIds'],
    ['role_persist_max_days', 'rolePersistMaxDays'],
    ['scam_filter_enabled', 'scamFilterEnabled'],
    ['scam_filter_action', 'scamFilterAction'],
    ['scam_filter_timeout_minutes', 'scamFilterTimeoutMin'],
    ['scam_filter_custom_domains', 'scamFilterCustomDomains'],
    ['scam_filter_whitelist', 'scamFilterWhitelist'],
    ['scam_filter_alert_channel_id', 'scamFilterAlertChannelId'],
  ];
  const patch: Record<string, unknown> = {};
  for (const [from, to] of map) {
    if (input[from] !== undefined) patch[to] = input[from];
  }
  // Un plafond de dix ans dans les deux unités, comme le dashboard.
  if (typeof patch.accountAgeMinValue === 'number' && input.account_age_unit === 'MONTHS') {
    patch.accountAgeMinValue = Math.min(patch.accountAgeMinValue, 120);
  }
  return patch;
}

export function registerAntiraidConfigTools(ctx: McpToolContext) {
  const { server, guildId, shouldRegister, guard, audit, toolMeta } = ctx;

  if (shouldRegister('READ_MODERATION')) {
    server.registerTool(
      'get_antiraid_config',
      {
        description: "Lit la configuration de l'anti-raid : détection de vague d'arrivées, action, durée du verrou, comptes trop récents, rôles rendus au retour et filtre anti-arnaque.",
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_MODERATION', async () => {
        try {
          const c = await getRaidProtectionConfig(guildId);
          if (!c) return ok({ configured: false });
          return ok({
            configured: true,
            raidModeActive: c.raidModeActive,
            antiRaid: {
              enabled: c.antiRaidEnabled, joinThreshold: c.antiRaidJoinThreshold, joinWindowSeconds: c.antiRaidJoinWindowSec,
              action: c.antiRaidAction, alertChannelId: c.antiRaidAlertChannelId, autoDisableMinutes: c.antiRaidAutoDisableMinutes,
              joinLockKick: c.joinLockKick, joinLockMessage: c.joinLockMessage,
            },
            accountAge: {
              enabled: c.accountAgeGuardEnabled, minValue: c.accountAgeMinValue, unit: c.accountAgeMinUnit,
              action: c.accountAgeAction, message: c.accountAgeMessage, whitelist: c.accountAgeWhitelist,
            },
            rolePersist: { enabled: c.rolePersistEnabled, mode: c.rolePersistMode, roleIds: c.rolePersistRoleIds, maxDays: c.rolePersistMaxDays },
            scamFilter: {
              enabled: c.scamFilterEnabled, action: c.scamFilterAction, timeoutMinutes: c.scamFilterTimeoutMin,
              customDomains: c.scamFilterCustomDomains, whitelist: c.scamFilterWhitelist, alertChannelId: c.scamFilterAlertChannelId,
            },
          });
        } catch (e) {
          return toolError(e, "Erreur lors de la lecture de la configuration anti-raid");
        }
      })
    );
  }

  if (shouldRegister('WRITE_MEMBERS')) {
    server.registerTool(
      'update_antiraid_config',
      {
        description: "Modifie la configuration de l'anti-raid. Seuls les champs fournis changent. Requiert WRITE_MEMBERS.",
        inputSchema: { ...ANTIRAID_INPUT, key_name: z.string().optional() },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ key_name, ...input }) => {
        try {
          const patch = toConfigPatch(input);
          if (Object.keys(patch).length === 0) return err('Aucun champ à modifier.');
          await upsertRaidProtectionConfig(guildId, patch);
          await audit(key_name, 'Configuration anti-raid MCP', 'Anti-raid', `Champs : ${Object.keys(patch).join(', ')}`);
          return ok({ ok: true, updated: Object.keys(patch) });
        } catch (e) {
          return toolError(e, "Erreur lors de la mise à jour de la configuration anti-raid");
        }
      })
    );
  }
}
