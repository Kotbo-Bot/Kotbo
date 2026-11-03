/**
 * Outils MCP - centre de gestion.
 *
 * Les droits par role etaient deja exposes (`get_dashboard_feature_access`,
 * `set_dashboard_feature_access`), l'activation d'un module aussi
 * (`set_module_activation`). Manquait tout le reste de la page : ou chaque
 * fonctionnalite ecrit, quel role elle exige, comment elle previent. Un agent
 * pouvait ouvrir une section a un role sans pouvoir lui designer son salon.
 *
 * ── Pourquoi l'etat vient du registre et non de la table ────────────────────
 *
 * `DashboardFeatureConfig.enabled` ignore la cascade des dependances et l'offre
 * commerciale du serveur. Un module peut y etre a `true` tout en etant eteint
 * en pratique. `getModuleStates` fait foi, comme pour la page.
 */
import { z } from 'zod';
import { ChannelType } from 'discord.js';
import { MODULE_REGISTRY, getModuleDefinition, isModulePaused } from '@kotbo/contracts';
import {
  getAvailableFeatureConfigs,
  updateFeatureConfig,
} from '../../../services/core/dashboardManagementService.js';
import { getModuleStates } from '../../../services/core/moduleGate.js';
import { SNOWFLAKE, requireOwnerIsDashboardAdmin, type McpToolContext, err, ok } from '../toolkit.js';

export function registerManagementCenterTools(ctx: McpToolContext) {
  const { server, client, guildId, shouldRegister, guard, toolMeta } = ctx;

  if (shouldRegister('READ_STAFF')) {
    server.registerTool(
      'get_management_center',
      {
        description:
          "Etat du centre de gestion : pour chaque fonctionnalite, son etat reel, son salon, " +
          "son salon secondaire, le role exige pour y acceder, le role prevenu, et la facon dont " +
          "elle notifie. L'etat rendu tient compte des dependances entre modules et de l'offre du " +
          "serveur, contrairement au drapeau brut de la table. Requiert READ_STAFF.",
        inputSchema: {
          feature_key: z
            .string()
            .optional()
            .describe('Limiter a une fonctionnalite (ex: "tickets", "workflows"). Toutes par defaut.'),
          configured_only: z
            .boolean()
            .optional()
            .describe('Ne rendre que les fonctionnalites ayant au moins un salon ou un role designe.'),
        },
        _meta: toolMeta,
      },
      guard('READ_STAFF', async ({ feature_key, configured_only }) => {
        const [configs, states] = await Promise.all([
          getAvailableFeatureConfigs(guildId),
          getModuleStates(guildId),
        ]);

        const guild = client.guilds.cache.get(guildId);
        const nameOfChannel = (id: string | null) =>
          id ? (guild?.channels.cache.get(id)?.name ?? null) : null;
        const nameOfRole = (id: string | null) => (id ? (guild?.roles.cache.get(id)?.name ?? null) : null);

        let selected = feature_key
          ? configs.filter((config) => config.featureKey === feature_key)
          : configs;

        if (feature_key && selected.length === 0) {
          return err(
            `Fonctionnalite « ${feature_key} » inconnue. Cles disponibles : ${configs
              .map((config) => config.featureKey)
              .join(', ')}`,
          );
        }

        if (configured_only) {
          selected = selected.filter(
            (config) => config.channelId || config.secondaryChannelId || config.requiredRoleId || config.notificationRoleId,
          );
        }

        return ok({
          features: selected.map((config) => {
            const definition = getModuleDefinition(config.featureKey);
            return {
              featureKey: config.featureKey,
              featureName: config.featureName,
              category: definition?.category ?? null,
              // L'etat qui compte : celui que la garde d'execution relit.
              active: states[config.featureKey] !== false,
              declaredEnabled: config.enabled,
              core: definition?.core ?? false,
              channel: config.channelId
                ? { id: config.channelId, name: nameOfChannel(config.channelId) }
                : null,
              secondaryChannel: config.secondaryChannelId
                ? { id: config.secondaryChannelId, name: nameOfChannel(config.secondaryChannelId) }
                : null,
              requiredRole: config.requiredRoleId
                ? { id: config.requiredRoleId, name: nameOfRole(config.requiredRoleId) }
                : null,
              notificationRole: config.notificationRoleId
                ? { id: config.notificationRoleId, name: nameOfRole(config.notificationRoleId) }
                : null,
              notifyViaDiscordChannel: config.notifyViaDiscordChannel,
              notifyViaDM: config.notifyViaDM,
              loggingEnabled: config.loggingEnabled,
              userActivityTracking: config.userActivityTracking,
              restricted: (config.roleAccessByRole?.length ?? 0) > 0,
            };
          }),
          // Rappele ici pour qu'un agent sache quelles clefs existent sans
          // avoir a les deviner ni a lister les modules par un autre appel.
          knownFeatureKeys: MODULE_REGISTRY.filter((module) => !isModulePaused(module.key)).map((module) => module.key),
        });
      }),
    );
  }

  if (shouldRegister('WRITE_MEMBERS')) {
    server.registerTool(
      'set_feature_configuration',
      {
        description:
          "Regle une fonctionnalite du centre de gestion : son salon, son salon secondaire, le role " +
          "exige pour y acceder, le role prevenu, et ses canaux de notification. Ne change pas les " +
          "droits par role, qui passent par set_dashboard_feature_access, ni l'activation, qui passe " +
          "par set_module_activation. Les champs non precises gardent leur valeur. Passer null a un " +
          "salon ou un role le retire. Requiert WRITE_MEMBERS, et que le proprietaire de la cle soit " +
          'administrateur du dashboard.',
        inputSchema: {
          feature_key: z.string().describe('Cle de la fonctionnalite (ex: "tickets", "workflows")'),
          channel: z
            .string()
            .nullable()
            .optional()
            .describe('Salon principal : nom ou ID. null pour retirer.'),
          secondary_channel: z
            .string()
            .nullable()
            .optional()
            .describe('Salon secondaire : nom ou ID. null pour retirer.'),
          required_role: z
            .string()
            .nullable()
            .optional()
            .describe("Role exige pour acceder a la section : nom ou ID. null pour retirer."),
          notification_role: z
            .string()
            .nullable()
            .optional()
            .describe('Role mentionne par les notifications : nom ou ID. null pour retirer.'),
          notify_via_channel: z.boolean().optional().describe('Prevenir dans le salon Discord'),
          notify_via_dm: z.boolean().optional().describe('Prevenir en message prive'),
          logging_enabled: z.boolean().optional().describe('Journaliser les actions de la section'),
          activity_tracking: z.boolean().optional().describe("Suivre l'activite des membres sur la section"),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard(
        'WRITE_MEMBERS',
        async ({
          feature_key,
          channel,
          secondary_channel,
          required_role,
          notification_role,
          notify_via_channel,
          notify_via_dm,
          logging_enabled,
          activity_tracking,
        }) => {
          // Cette section distribue les droits et les salons des autres : la
          // reserver aux administrateurs du dashboard, comme la page elle-meme.
          const allowed = await requireOwnerIsDashboardAdmin(ctx);
          if (!allowed.allowed) return err(allowed.reason);

          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const configs = await getAvailableFeatureConfigs(guildId);
          const config = configs.find((entry) => entry.featureKey === feature_key);
          if (!config) {
            return err(
              `Fonctionnalite « ${feature_key} » inconnue. Cles disponibles : ${configs
                .map((entry) => entry.featureKey)
                .join(', ')}`,
            );
          }

          /**
           * Un nom plutot qu'un identifiant : c'est ce qu'un agent a sous la
           * main. `undefined` laisse le champ tel quel, `null` le vide - la
           * distinction compte, sans elle on ne pourrait plus retirer un salon.
           */
          const resolveChannel = (value: string | null | undefined) => {
            if (value === undefined) return undefined;
            if (value === null) return null;

            const found = SNOWFLAKE.test(value)
              ? guild.channels.cache.get(value)
              : guild.channels.cache.find(
                  (candidate) =>
                    candidate.type === ChannelType.GuildText
                    && candidate.name.toLowerCase() === value.toLowerCase().replace(/^#/, ''),
                );
            return found ? found.id : { error: `Salon « ${value} » introuvable` };
          };

          const resolveRole = (value: string | null | undefined) => {
            if (value === undefined) return undefined;
            if (value === null) return null;

            const found = SNOWFLAKE.test(value)
              ? guild.roles.cache.get(value)
              : guild.roles.cache.find(
                  (candidate) => candidate.name.toLowerCase() === value.toLowerCase().replace(/^@/, ''),
                );
            return found ? found.id : { error: `Role « ${value} » introuvable` };
          };

          const resolved = {
            channelId: resolveChannel(channel),
            secondaryChannelId: resolveChannel(secondary_channel),
            requiredRoleId: resolveRole(required_role),
            notificationRoleId: resolveRole(notification_role),
          };

          // Une seule cible introuvable arrete tout : appliquer la moitie d'un
          // reglage laisserait la fonctionnalite dans un etat que personne n'a
          // demande.
          for (const value of Object.values(resolved)) {
            if (value && typeof value === 'object' && 'error' in value) return err(value.error);
          }

          const updated = await updateFeatureConfig(guildId, feature_key, {
            channelId: resolved.channelId as string | null | undefined,
            secondaryChannelId: resolved.secondaryChannelId as string | null | undefined,
            requiredRoleId: resolved.requiredRoleId as string | null | undefined,
            notificationRoleId: resolved.notificationRoleId as string | null | undefined,
            notifyViaDiscordChannel: notify_via_channel,
            notifyViaDM: notify_via_dm,
            loggingEnabled: logging_enabled,
            userActivityTracking: activity_tracking,
          });

          return ok({
            featureKey: updated.featureKey,
            featureName: updated.featureName,
            channelId: updated.channelId,
            secondaryChannelId: updated.secondaryChannelId,
            requiredRoleId: updated.requiredRoleId,
            notificationRoleId: updated.notificationRoleId,
            notifyViaDiscordChannel: updated.notifyViaDiscordChannel,
            notifyViaDM: updated.notifyViaDM,
            loggingEnabled: updated.loggingEnabled,
            userActivityTracking: updated.userActivityTracking,
          });
        },
      ),
    );
  }
}
