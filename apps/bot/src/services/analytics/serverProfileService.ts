/**
 * Profil public d'un serveur pour sa fiche : invitation par defaut, page de
 * decouverte, site communautaire et caracteristiques Discord (tags/features).
 * Partage entre la fiche serveur et la fiche d'une invitation, pour que les
 * deux designent la meme « invitation par defaut ».
 */

import type { Client, Guild } from 'discord.js';
import prisma from '../../utils/db.js';
import { getDashboardUrl } from '../../api/shared.js';

export type DefaultInviteKind = 'vanity' | 'widget' | 'tracked';

export interface DefaultInvite {
  code: string;
  url: string;
  kind: DefaultInviteKind;
}

export interface ServerProfile {
  defaultInvite: DefaultInvite | null;
  /** Page publique de decouverte Discord (serveurs decouvrables seulement). */
  discoveryUrl: string | null;
  discoverable: boolean;
  /** Site communautaire Kotbo publie pour ce serveur. */
  siteUrl: string | null;
  /** Tags Discord du serveur (COMMUNITY, DISCOVERABLE, PARTNERED...). */
  features: string[];
  vanityCode: string | null;
  createdAt: string;
  premiumTier: number | null;
  boostCount: number | null;
  locale: string | null;
  verificationLevel: number | null;
}

const DISCORD_EPOCH = 1420070400000n;
const CACHE_TTL_MS = 10 * 60 * 1000;
// shortcut: cache memoire par processus, a remplacer par cache.wrap si la fiche devient tres consultee.
const remoteCache = new Map<string, { at: number; value: { widgetInvite: string | null; features: string[] | null } }>();

/** Date de creation lue dans le snowflake : disponible meme pour un serveur externe. */
export function guildCreatedAt(guildId: string): string {
  try {
    return new Date(Number((BigInt(guildId) >> 22n) + DISCORD_EPOCH)).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function slugify(name: string | null): string {
  return (name ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Widget public (si active) et apercu de decouverte : seules sources pour un serveur ou le bot n'est pas. */
async function fetchRemote(client: Client, guildId: string, live: Guild | undefined) {
  const cached = remoteCache.get(guildId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const [widget, preview] = await Promise.all([
    fetch(`https://discord.com/api/v10/guilds/${guildId}/widget.json`, { signal: AbortSignal.timeout(3000) })
      .then((res) => (res.ok ? (res.json() as Promise<{ instant_invite?: string | null }>) : null))
      .catch(() => null),
    live ? Promise.resolve(null) : client.fetchGuildPreview(guildId).catch(() => null),
  ]);

  const value = {
    widgetInvite: widget?.instant_invite?.split('/').pop() ?? null,
    features: preview ? [...preview.features] : null,
  };
  remoteCache.set(guildId, { at: Date.now(), value });
  return value;
}

/** Invitation par defaut : lien personnalise, sinon invitation du widget, sinon la plus utilisee des invitations permanentes suivies. */
export async function resolveDefaultInvite(client: Client, guildId: string, opts?: { includeTracked?: boolean }): Promise<DefaultInvite | null> {
  const live = client.guilds.cache.get(guildId);
  if (live?.vanityURLCode) {
    return { code: live.vanityURLCode, url: `https://discord.gg/${live.vanityURLCode}`, kind: 'vanity' };
  }
  const remote = await fetchRemote(client, guildId, live);
  if (remote.widgetInvite) {
    return { code: remote.widgetInvite, url: `https://discord.gg/${remote.widgetInvite}`, kind: 'widget' };
  }
  // Vanity et widget sont publics, l'invitation suivie non : elle ne sort pas pour
  // un serveur tiers designe par son seul identifiant.
  if (opts?.includeTracked === false) return null;
  const tracked = await prisma.guildInvite.findFirst({
    where: { guildId, expiresAt: null, isTemporary: false, isDeleted: false, isSuspended: false },
    orderBy: { uses: 'desc' },
    select: { code: true },
  }).catch(() => null);
  return tracked ? { code: tracked.code, url: `https://discord.gg/${tracked.code}`, kind: 'tracked' } : null;
}

export async function getServerProfile(client: Client, guildId: string, name: string | null): Promise<ServerProfile> {
  const live = client.guilds.cache.get(guildId);
  const [defaultInvite, remote, site] = await Promise.all([
    resolveDefaultInvite(client, guildId, { includeTracked: false }),
    fetchRemote(client, guildId, live),
    prisma.communitySite.findUnique({ where: { guildId }, select: { slug: true, published: true } }).catch(() => null),
  ]);

  // Un apercu obtenu sans etre membre prouve que le serveur est dans la decouverte.
  const features = live ? [...live.features] : remote.features ?? [];
  const discoverable = live ? (live.features as string[]).includes('DISCOVERABLE') : remote.features !== null;
  const slug = slugify(name);

  return {
    defaultInvite,
    discoverable,
    discoveryUrl: discoverable ? `https://discord.com/servers/${slug ? `${slug}-` : ''}${guildId}` : null,
    siteUrl: site?.published ? `${getDashboardUrl().replace(/\/$/, '')}/s/${site.slug}` : null,
    features: features.map(String).sort(),
    vanityCode: live?.vanityURLCode ?? null,
    createdAt: guildCreatedAt(guildId),
    premiumTier: live ? live.premiumTier : null,
    boostCount: live?.premiumSubscriptionCount ?? null,
    locale: live?.preferredLocale ?? null,
    verificationLevel: live ? live.verificationLevel : null,
  };
}
