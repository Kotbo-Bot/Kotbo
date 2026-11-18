/**
 * Routes de reprise de configuration depuis les autres bots du serveur.
 *
 * Trois surfaces : le plan (ce qu'on a detecte), l'application des propositions
 * retenues, et l'inspection d'un fichier d'export tiers.
 */
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Client, Guild } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { pushAudit, getGuildName } from '../../shared.js';
import { applyMigrationPlan, buildMigrationPlan } from '../../../services/core/botMigrationService.js';

import { auditUserOf, fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';
/**
 * Reglages de la guilde qu'une valeur importee peut alimenter.
 *
 * Liste fermee : le fichier vient de l'exterieur, il ne doit pas pouvoir
 * designer une colonne arbitraire de la table.
 */
const ASSIGNABLE_SETTINGS: Record<string, string> = {
  ticketCategory: 'ticketCategoryId',
  ticketLogChannel: 'ticketLogChannelId',
  welcomeChannel: 'publicChannelId',
  logChannel: 'logChannelId',
  suggestionChannel: 'digestChannelId',
  moderatorRole: 'moderatorRoleId',
};

/** Un identifiant Discord : 17 a 20 chiffres. */
const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Aplatit un JSON quelconque et retient les valeurs qui ressemblent a des
 * identifiants Discord.
 *
 * Aucun format tiers n'est devine : les bots n'exportent pas la meme structure,
 * et un parseur specifique se casserait a leur prochaine mise a jour. On montre
 * ce qu'on a trouve, avec son chemin, et le staff associe lui-meme chaque
 * valeur au reglage Kotbo correspondant.
 */
function collectSnowflakes(
  value: unknown,
  path: string[] = [],
  out: { path: string; value: string }[] = [],
  depth = 0,
): { path: string; value: string }[] {
  // Un export profond ou circulaire ne doit pas faire tourner le serveur.
  if (depth > 8 || out.length >= 200) return out;

  if (typeof value === 'string') {
    if (SNOWFLAKE.test(value)) out.push({ path: path.join('.') || '(racine)', value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectSnowflakes(item, [...path, String(index)], out, depth + 1));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collectSnowflakes(child, [...path, key], out, depth + 1);
    }
  }
  return out;
}

export function createMigrationRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/migration';

  /** Administrateur seulement, et serveur Discord joignable. */
  const migrationAccess = createMiddleware<{ Variables: { guild: Guild } }>(async (c, next) => {
    if (!c.var.access.canManageSettings) return send(c, { error: 'Accès refusé' }, 403);
    const guildId = c.req.param('guildId')!;
    const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
    if (!guild) return send(c, { error: 'Serveur Discord introuvable' }, 404);
    c.set('guild', guild);
    await next();
  });
  const gate = [...guildRoute(client), migrationAccess] as const;

  router.get(base, ...gate, async (c) => {
    try {
      return send(c, await buildMigrationPlan(c.var.guild));
    } catch (err) {
      logger.error('MigrationAPI', 'Erreur GET plan:', err);
      return fail(c, err, 'Erreur lors de l\'analyse du serveur', 'MigrationAPI');
    }
  });

  // { keys }
  router.post(`${base}/apply`, ...gate, async (c) => {
    const guild = c.var.guild;
    const guildId = guild.id;
    try {
      const body = await readBody<{ keys?: unknown }>(c);
      const keys = Array.isArray(body?.keys)
        ? body.keys.filter((k): k is string => typeof k === 'string')
        : [];
      if (keys.length === 0) return send(c, { error: 'Aucune proposition sélectionnée' }, 400);

      const result = await applyMigrationPlan(guild, keys);
      if (result.applied.length > 0) {
        await pushAudit(guildId, {
          channelId: null,
          user: auditUserOf(c),
          action: `Reprise de configuration : ${result.applied.length} réglage(s)`,
          context: getGuildName(client, guildId),
          module: 'Reprise',
          eventType: 'Settings',
          details: result.applied.join(', '),
        });
      }

      return send(c, { ...result, plan: await buildMigrationPlan(guild) });
    } catch (err) {
      logger.error('MigrationAPI', 'Erreur POST apply:', err);
      return fail(c, err, 'Erreur lors de la reprise', 'MigrationAPI');
    }
  });

  // { export }
  router.post(`${base}/inspect`, ...gate, async (c) => {
    const guild = c.var.guild;
    try {
      const body = await readBody<{ export?: unknown }>(c);
      if (body?.export === undefined) return send(c, { error: 'Fichier vide ou illisible' }, 400);

      const found = collectSnowflakes(body.export);

      // Chaque identifiant est resolu contre le serveur : un identifiant qui ne
      // correspond a rien ici vient d'un autre serveur et n'a rien a faire dans
      // la liste des choix.
      if (guild.channels.cache.size === 0) await guild.channels.fetch().catch(() => null);
      const candidates = found
        .map(({ path, value }) => {
          const channel = guild.channels.cache.get(value);
          const role = guild.roles.cache.get(value);
          if (channel) return { path, value, kind: 'channel' as const, name: channel.name };
          if (role) return { path, value, kind: 'role' as const, name: role.name };
          return null;
        })
        .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);

      return send(c, {
        candidates,
        // Doublons retires : un meme salon cite dix fois dans l'export ne
        // merite pas dix lignes a l'ecran.
        settings: Object.keys(ASSIGNABLE_SETTINGS),
        inspected: found.length,
      });
    } catch (err) {
      logger.error('MigrationAPI', 'Erreur POST inspect:', err);
      return fail(c, err, "Erreur lors de la lecture de l'export", 'MigrationAPI');
    }
  });

  // { assignments }
  router.post(`${base}/assign`, ...gate, async (c) => {
    const guildId = c.var.guild.id;
    try {
      const body = await readBody<{ assignments?: unknown }>(c);
      const raw = Array.isArray(body?.assignments) ? body.assignments : [];

      const data: Record<string, string> = {};
      for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const { setting, value } = item as { setting?: unknown; value?: unknown };
        if (typeof setting !== 'string' || typeof value !== 'string') continue;

        const column = ASSIGNABLE_SETTINGS[setting];
        // Identifiant revalide cote serveur : le client a pu envoyer autre chose
        // que ce que l'inspection avait propose.
        if (!column || !SNOWFLAKE.test(value)) continue;
        data[column] = value;
      }

      if (Object.keys(data).length === 0) return send(c, { error: 'Aucune association valide' }, 400);

      await prisma.guild.update({ where: { id: guildId }, data });

      await pushAudit(guildId, {
        channelId: null,
        user: auditUserOf(c),
        action: `Reprise depuis un export : ${Object.keys(data).length} réglage(s)`,
        context: getGuildName(client, guildId),
        module: 'Reprise',
        eventType: 'Settings',
        details: Object.keys(data).join(', '),
      });

      return send(c, { success: true, applied: Object.keys(data) });
    } catch (err) {
      logger.error('MigrationAPI', 'Erreur POST assign:', err);
      return fail(c, err, "Erreur lors de l'association", 'MigrationAPI');
    }
  });

  return router;
}
