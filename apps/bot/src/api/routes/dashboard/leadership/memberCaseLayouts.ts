/** Disposition des onglets de la fiche membre, par rôle du staff. */
import { Hono } from 'hono';
import type { Client } from 'discord.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
import { getGuildName, pushAudit } from '../../../shared.js';
import { pickLayoutRule, sanitizeLayoutRule } from '../../../../services/staff/memberCaseLayout.js';

const MAX_RULES = 20;

export function createMemberCaseLayoutsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/member-case-layout';
  const gate = guildRoute(client);

  // Ce que voit le lecteur : sa règle, et toutes les règles s'il est admin.
  router.get(base, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const rules = await prisma.memberCaseLayout.findMany({ where: { guildId }, orderBy: { position: 'asc' } });
      const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
      const member = guild ? await guild.members.fetch(c.var.dashboardUser.userId).catch(() => null) : null;
      const mine = pickLayoutRule(rules, new Set(member ? member.roles.cache.map((r) => r.id) : []));
      const isAdmin = c.var.effectiveAccess.level === 'admin';
      return send(c, {
        mine: mine ? { tabOrder: mine.tabOrder, hiddenTabs: mine.hiddenTabs } : null,
        ...(isAdmin ? { rules } : {}),
      });
    } catch (err) {
      logger.error('MemberCaseLayoutAPI', 'Error loading layout:', err);
      return fail(c, err, 'Erreur lors du chargement de la disposition.', 'MemberCaseLayoutAPI');
    }
  });

  router.put(base, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    if (c.var.effectiveAccess.level !== 'admin') return send(c, { error: 'Réservé aux administrateurs.' }, 403);
    try {
      const body = await readBody<{ rules?: Array<{ name?: unknown; roleIds?: unknown; tabOrder?: unknown; hiddenTabs?: unknown }> }>(c);
      const input = Array.isArray(body?.rules) ? body.rules.slice(0, MAX_RULES) : [];
      const data = input.map((rule, position) => ({
        guildId,
        position,
        name: (typeof rule.name === 'string' ? rule.name.trim() : '').slice(0, 60) || `Règle ${position + 1}`,
        ...sanitizeLayoutRule(rule),
      }));
      await prisma.$transaction([
        prisma.memberCaseLayout.deleteMany({ where: { guildId } }),
        prisma.memberCaseLayout.createMany({ data }),
      ]);
      await pushAudit(guildId, {
        user: auditUserOf(c),
        action: 'Disposition de la fiche membre',
        context: getGuildName(client, guildId),
        module: 'Fiche membre',
        eventType: 'Manuel',
        details: `${data.length} règle(s) enregistrée(s).`,
        channelId: null,
      });
      return send(c, { ok: true, count: data.length });
    } catch (err) {
      logger.error('MemberCaseLayoutAPI', 'Error saving layout:', err);
      return fail(c, err, 'Erreur lors de la sauvegarde de la disposition.', 'MemberCaseLayoutAPI');
    }
  });

  return router;
}
