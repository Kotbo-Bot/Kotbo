import { ActivityType, type ActivitiesOptions, type PresenceStatusData } from 'discord.js';
import { fetchExternal } from '../../utils/http.js';
import { assertWebhookUrlReachable } from '../integrations/outgoingWebhookSecurity.js';
import { sniffImage } from '../site/siteUploads.js';

export interface CustomBotProfile {
  botName?: string | null;
  botAvatarUrl?: string | null;
  botBannerUrl?: string | null;
  botBio?: string | null;
}

export interface CustomBotPresence {
  botStatus?: string | null;
  activityType?: string | null;
  activityText?: string | null;
  activityUrl?: string | null;
}

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const DISCORD_API = 'https://discord.com/api/v10';

const STATUS: Record<string, PresenceStatusData> = { ONLINE: 'online', IDLE: 'idle', DND: 'dnd', INVISIBLE: 'invisible' };
const ACTIVITY: Record<string, ActivityType> = {
  PLAYING: ActivityType.Playing,
  STREAMING: ActivityType.Streaming,
  LISTENING: ActivityType.Listening,
  WATCHING: ActivityType.Watching,
  COMPETING: ActivityType.Competing,
};

/**
 * Image importée depuis le PC : une data URI dont les octets sont bien ceux
 * d'une image du type annoncé. Null si la valeur n'en est pas une valide.
 */
export function parseDataImage(value: string): Buffer | null {
  const match = DATA_IMAGE.exec(value);
  if (!match) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
  const kind = sniffImage(bytes);
  const declared = match[1] === 'jpeg' ? 'jpeg' : match[1];
  return kind === declared ? bytes : null;
}

/**
 * Image saisie (lien https ou import) en data URI, la forme qu'attend Discord.
 * Un lien est contrôlé comme celui d'un webhook sortant (https, pas de réseau
 * interne) et les redirections sont refusées : elles contourneraient ce contrôle.
 */
async function toImageData(raw: string): Promise<string> {
  if (raw.startsWith('data:')) {
    if (!parseDataImage(raw)) throw new Error("Le fichier importé n'est pas une image valide.");
    return raw;
  }
  const url = await assertWebhookUrlReachable(raw);
  const response = await fetchExternal(url, { redirect: 'error' });
  if (!response.ok) throw new Error(`Image inaccessible (HTTP ${response.status}).`);
  const image = Buffer.from(await response.arrayBuffer());
  if (image.length > MAX_IMAGE_BYTES) throw new Error('Image trop lourde (8 Mo maximum).');
  const kind = sniffImage(image);
  if (!kind || kind === 'avif') throw new Error('Le lien ne pointe pas vers une image PNG, JPEG, GIF ou WebP.');
  return `data:image/${kind};base64,${image.toString('base64')}`;
}

async function discord(token: string, method: 'GET' | 'PATCH', path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetchExternal(`${DISCORD_API}${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.message ?? `HTTP ${response.status}`));
  return data;
}

async function collect(errors: string[], label: string, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (err) {
    errors.push(`${label} : ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Profil du bot du serveur, poussé par l'API Discord sans connexion gateway.
 * Chaque champ échoue seul : Discord limite le changement de nom à deux par
 * heure, ce qui ne doit pas empêcher l'avatar de passer.
 */
export async function applyOwnBotProfile(token: string, profile: CustomBotProfile): Promise<string[]> {
  const errors: string[] = [];
  const me = await discord(token, 'GET', '/users/@me').catch(() => null);
  const name = profile.botName?.trim();
  if (name && me && name !== me.username) await collect(errors, 'Nom', () => discord(token, 'PATCH', '/users/@me', { username: name }));
  if (profile.botAvatarUrl) {
    const raw = profile.botAvatarUrl;
    await collect(errors, 'Avatar', async () => discord(token, 'PATCH', '/users/@me', { avatar: await toImageData(raw) }));
  }
  if (profile.botBannerUrl) {
    const raw = profile.botBannerUrl;
    await collect(errors, 'Bannière', async () => discord(token, 'PATCH', '/users/@me', { banner: await toImageData(raw) }));
  }
  if (profile.botBio != null) {
    const bio = profile.botBio;
    await collect(errors, 'Bio', () => discord(token, 'PATCH', '/applications/@me', { description: bio }));
  }
  return errors;
}

/**
 * Identité de Kotbo sur ce serveur seulement (pseudo, avatar, bannière, bio de
 * membre). Un champ vide rend celui de Kotbo.
 */
export async function applyKotboGuildIdentity(kotboToken: string, guildId: string, profile: CustomBotProfile): Promise<string[]> {
  const errors: string[] = [];
  const body: Record<string, string | null> = {
    nick: profile.botName?.trim() || null,
    bio: profile.botBio?.trim() || null,
  };
  await collect(errors, 'Avatar', async () => { body.avatar = profile.botAvatarUrl ? await toImageData(profile.botAvatarUrl) : null; });
  await collect(errors, 'Bannière', async () => { body.banner = profile.botBannerUrl ? await toImageData(profile.botBannerUrl) : null; });
  await collect(errors, 'Profil', () => discord(kotboToken, 'PATCH', `/guilds/${guildId}/members/@me`, body));
  return errors;
}

export function presenceFrom(config: CustomBotPresence): { status: PresenceStatusData; activities: ActivitiesOptions[] } {
  const activities: ActivitiesOptions[] = [];
  if (config.activityType && config.activityType !== 'NONE' && config.activityText) {
    activities.push({
      name: config.activityText,
      type: ACTIVITY[config.activityType] ?? ActivityType.Playing,
      url: config.activityType === 'STREAMING' ? config.activityUrl ?? undefined : undefined,
    });
  }
  return { status: STATUS[config.botStatus || 'ONLINE'] ?? 'online', activities };
}
