/** Routes dashboard du module `modules`. */
import { Hono } from 'hono';
import type { Client } from 'discord.js';
import { getModuleActivationStats, getModulePerformanceStats, getModuleStatsSummary, getModuleUsageStats, KOTBO_MODULES, type KotboModule } from '../../../../services/analytics/moduleStatsService.js';
import { CoreModuleError, PlanLockedError, setDashboardModuleStatus } from '../../../../services/core/moduleActivationService.js';
import { logger } from '../../../../utils/logger.js';
import { getGuildName, type ModuleStatus, pushAudit } from '../../../shared.js';
import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
import { canonicalModuleKey, isRestrictedModule } from '@kotbo/contracts';
import { requestDissolution } from '../../../../services/staff/wellbeingDissolution.js';

export function createModuleToggleRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/modules';

  // Statistiques des modules : déclarée avant `/:moduleId`, qui ne prend que PUT.
  router.get(`${base}/stats`, ...guildRoute(client), async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const moduleName = (c.req.query('moduleName') as KotboModule | undefined) ?? undefined;
      const startDate = c.req.query('startDate') || undefined;
      const endDate = c.req.query('endDate') || undefined;
      const period = c.req.query('period');
      const periodDays = period ? parseInt(period) : 30;

      if (c.req.query('summary') === 'true') {
        return send(c, await getModuleStatsSummary({ guildId, periodDays }));
      }
      const [activation, usage, performance] = await Promise.all([
        getModuleActivationStats(guildId),
        getModuleUsageStats({ guildId, moduleName, startDate, endDate, periodDays }),
        getModulePerformanceStats({ guildId, moduleName, startDate, endDate, periodDays }),
      ]);
      return send(c, { modules: KOTBO_MODULES, activation, usage, performance });
    } catch (err) {
      logger.error('ModulesAPI', 'Error fetching module stats:', err);
      return fail(c, err, 'Erreur interne du serveur', 'ModulesAPI');
    }
  });

  router.put(`${base}/:moduleId`, ...guildRoute(client), async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = (await readBody<{ status: ModuleStatus }>(c)) ?? { status: 'inactive' };
      const moduleKey = canonicalModuleKey(c.req.param('moduleId'));

      // Module confidentiel (cellule bien-être) : l'éteindre coupe la cellule de
      // ses dossiers. Seul le propriétaire le peut, et l'extinction est différée
      // de 24 h, annoncée à la cellule, comme sa désactivation dans ses réglages.
      if (body.status !== 'active' && isRestrictedModule(moduleKey)) {
        const user = c.var.dashboardUser;
        if (client.guilds.cache.get(guildId)?.ownerId !== user.userId) {
          return send(c, { error: 'Seul le propriétaire du serveur peut éteindre ce module.', code: 'owner_only' }, 403);
        }
        const at = await requestDissolution(client, guildId, { id: user.userId, name: auditUserOf(c) }, 'MODULE');
        if (at) {
          await pushAudit(guildId, {
            user: auditUserOf(c),
            action: 'Mise à jour module',
            context: getGuildName(client, guildId),
            module: moduleKey,
            eventType: 'Manuel',
            details: `Extinction demandée, effective le ${at.toISOString()} sauf annulation.`,
            channelId: null,
          });
          return send(c, { ok: true, pending: true, moduleKey, dissolutionAt: at.toISOString() }, 202);
        }
        // Cellule jamais configurée : il n'y a rien à protéger, l'extinction est immédiate.
      }

      const result = await setDashboardModuleStatus(guildId, moduleKey, body.status === 'active');

      // La cascade fait partie du journal : sans elle, un module éteint « tout
      // seul » n'aurait aucune trace expliquant pourquoi.
      const cascade = [
        ...result.enabledRequirements.map((key) => `${key} activé (dépendance)`),
        ...result.disabledDependents.map((key) => `${key} désactivé (dépendant)`),
      ];

      await pushAudit(guildId, {
        user: auditUserOf(c),
        action: 'Mise à jour module',
        context: getGuildName(client, guildId),
        module: result.moduleKey,
        eventType: 'Manuel',
        details: `Statut changé vers ${body.status}.${cascade.length > 0 ? ` En cascade : ${cascade.join(', ')}.` : ''}`,
        channelId: null
      });

      return send(c, { ok: true, ...result });
    } catch (err) {
      if (err instanceof CoreModuleError) {
        return send(c, { error: err.message, code: 'core_module' }, 400);
      }
      // 402 et non 400 : ce n'est pas une requete malformee, c'est un module
      // qui se vend. Le dashboard s'en sert pour ouvrir la page des offres
      // plutot que d'afficher une erreur que l'administrateur ne peut pas
      // corriger lui-meme.
      if (err instanceof PlanLockedError) {
        return send(c, {
          error: err.message,
          code: 'plan_locked',
          moduleKey: err.moduleKey,
          currentPlan: err.currentPlan,
          requiredPlan: err.requiredPlan,
        }, 402);
      }
      logger.error('ModulesAPI', 'Error updating module:', err);
      return fail(c, err, 'Erreur lors de la mise à jour du module', 'ModulesAPI');
    }
  });

  return router;
}
