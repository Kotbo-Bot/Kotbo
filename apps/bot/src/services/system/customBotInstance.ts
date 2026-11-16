/**
 * Bot perso complet d'un serveur : une instance marque blanche `cb-<serveur>`,
 * créée et tenue à jour depuis la page Identité. Elle fait tourner le code
 * Kotbo entier sous le token du serveur ; le launcher la lance à la demande.
 */
import crypto from 'node:crypto';
import prisma from '../../utils/db.js';
import { fetchExternal } from '../../utils/http.js';
import { openSecret, sealSecret } from '../../utils/secretBox.js';

const DISCORD_API = 'https://discord.com/api/v10';

export const customInstanceSlug = (guildId: string) => `cb-${guildId}`;

export function findCustomInstance(guildId: string) {
  return prisma.whiteLabelInstance.findUnique({ where: { slug: customInstanceSlug(guildId) } });
}

async function botRequest(token: string, method: 'GET' | 'DELETE', path: string): Promise<Response> {
  return fetchExternal(`${DISCORD_API}${path}`, { method, headers: { Authorization: `Bot ${token}` } });
}

/** Le bot de ce token est-il membre du serveur ? */
export async function botIsMember(token: string | null, guildId: string): Promise<boolean> {
  if (!token) return false;
  const response = await botRequest(token, 'GET', `/guilds/${guildId}`).catch(() => null);
  return response?.ok ?? false;
}

/** Fait quitter le serveur au bot de ce token. */
export async function leaveGuild(token: string, guildId: string): Promise<void> {
  const response = await botRequest(token, 'DELETE', `/users/@me/guilds/${guildId}`);
  if (!response.ok && response.status !== 404) throw new Error(`Discord a refusé le départ (HTTP ${response.status}).`);
}

/**
 * Crée ou met à jour l'instance depuis la configuration du serveur. Les secrets
 * restent scellés : l'instance reprend les valeurs déjà chiffrées.
 */
export async function provisionCustomInstance(guildId: string, ownerId: string) {
  const config = await prisma.customBotConfig.findUnique({ where: { guildId } });
  const token = config?.botToken ? openSecret(config.botToken) : null;
  if (!config?.botToken || !token) throw new Error('Connecte d\'abord ton bot avec un token valide.');

  let clientId = config.botClientId;
  if (!clientId) {
    // L'identifiant de l'application est celui de son bot : on le lit sur le token.
    const me = await botRequest(token, 'GET', '/users/@me');
    if (!me.ok) throw new Error('Token refusé par Discord.');
    clientId = String(((await me.json()) as { id?: string }).id ?? '');
    await prisma.customBotConfig.update({ where: { guildId }, data: { botClientId: clientId } });
  }

  const host = config.customDashboardUrl;
  const data = {
    name: config.botName || `Bot ${guildId}`,
    enabled: true,
    discordToken: config.botToken,
    discordClientId: clientId,
    discordClientSecret: config.botClientSecret ?? '',
    discordRedirectUri: host ? `https://${host}/api/auth/discord/callback` : null,
    dashboardUrl: host ? `https://${host}` : null,
    dashboardOrigin: host ? `https://${host}` : null,
    brandName: config.botName,
    ownerId,
    maxGuilds: 1,
  };
  return prisma.whiteLabelInstance.upsert({
    where: { slug: customInstanceSlug(guildId) },
    update: data,
    create: { ...data, slug: customInstanceSlug(guildId), jwtSecret: sealSecret(crypto.randomBytes(32).toString('hex')) },
  });
}
