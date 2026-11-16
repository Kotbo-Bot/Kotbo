import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { Client, GuildMember, Guild } from 'discord.js';
import { getCachedGuild } from '../../../utils/cache.js';
import { scopedGuildId } from '../../../services/system/customDomain.js';

export type AccessLevel = 'admin' | 'moderator' | 'viewer';

export interface GuildAccessContext {
  level: AccessLevel;
  guildId: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    guildAccess: GuildAccessContext;
  }
}

function resolveAccessLevel(member: GuildMember, guild: Guild, moderatorRoleId: string | null): AccessLevel {
  if (member.id === guild.ownerId) return 'admin';
  if (member.permissions.has('Administrator') || member.permissions.has('ManageGuild')) return 'admin';
  if (moderatorRoleId && member.roles.cache.has(moderatorRoleId)) return 'moderator';
  if (
    member.permissions.has('ModerateMembers') ||
    member.permissions.has('BanMembers') ||
    member.permissions.has('KickMembers')
  ) {
    return 'moderator';
  }
  return 'viewer';
}

const LEVEL_HIERARCHY: Record<AccessLevel, number> = {
  viewer: 0,
  moderator: 1,
  admin: 2,
};

export const requireGuildAccess = (client: Client, minimumLevel: AccessLevel = 'moderator') =>
  createMiddleware(async (c, next) => {
    const auth = c.var.auth;
    const guildId = c.req.param('guildId');

    if (!guildId) {
      throw new HTTPException(400, { message: 'guildId manquant' });
    }

    const scoped = scopedGuildId();
    if (scoped && scoped !== guildId) {
      throw new HTTPException(403, { message: 'Serveur non accessible depuis ce domaine' });
    }

    const guild = client.guilds.cache.get(guildId)
      || await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      throw new HTTPException(404, { message: 'Serveur introuvable ou bot non présent' });
    }

    // Ce middleware s'execute sur chaque appel du dashboard, et une page en
    // declenche une dizaine : lire la ligne du serveur en base a chaque fois
    // ajoutait autant d'allers-retours pour une valeur qui ne change presque
    // jamais. `getCachedGuild` la sert depuis le cache memoire/Redis et se
    // purge via `cache.invalidateGuild`, deja appele par les routes qui
    // modifient la configuration.
    const guildConfig = await getCachedGuild(guildId);

    const member = await guild.members.fetch(auth.userId).catch(() => null);
    if (!member) {
      throw new HTTPException(403, { message: "Vous n'êtes pas membre de ce serveur" });
    }

    const userLevel = resolveAccessLevel(member, guild, guildConfig?.moderatorRoleId ?? null);
    if (LEVEL_HIERARCHY[userLevel] < LEVEL_HIERARCHY[minimumLevel]) {
      throw new HTTPException(403, {
        message: `Accès refusé - niveau ${minimumLevel} requis`,
      });
    }

    c.set('guildAccess', { level: userLevel, guildId });
    await next();
  });
