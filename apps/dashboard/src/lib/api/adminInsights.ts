/**
 * adminInsights.ts
 *
 * Client des lectures transverses de la console admin
 * (`/api/admin/insights/*`) : activite de la flotte, fiche d'un serveur,
 * supervision AegisAI et Kotbo Vision, profil des requetes.
 */
import { API_BASE_URL, authorizedFetch } from './client';

async function read<T>(path: string): Promise<T> {
  const response = await authorizedFetch(`${API_BASE_URL}${path}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Impossible de charger ces statistiques. Réessaie.');
  return body as T;
}

/** Repartition des messages : types, styles et longueurs. */
export interface ContentMix {
  messages: number;
  withLink: number;
  withMedia: number;
  withEmoji: number;
  typeText: number;
  typeImage: number;
  typeGif: number;
  typeVideo: number;
  typeSticker: number;
  typeFile: number;
  typeVoice: number;
  typePoll: number;
  styleReply: number;
  styleMention: number;
  styleThread: number;
  lenShort: number;
  lenMedium: number;
  lenLong: number;
}

// ── Activite de la flotte ────────────────────────────────────────────────────

export interface FleetTotals {
  messagesCount: number;
  reactionsCount: number;
  voiceMinutes: number;
  membersJoined: number;
  membersLeft: number;
  activeMembers: number;
  sanctionsCount: number;
}

export interface FleetChannel {
  channelId: string;
  guildId: string;
  name: string | null;
  type: number | null;
  categoryId: string | null;
  categoryName: string | null;
  guildName: string | null;
  messages: number;
  voiceMinutes: number;
}

export interface FleetActivity {
  days: number;
  series: (FleetTotals & { dateKey: string; activeGuilds: number })[];
  totals: FleetTotals;
  previousTotals: FleetTotals;
  /** Messages par jour de semaine (0 = lundi) et par heure UTC. */
  heat: number[][];
  guilds: { guildId: string; name: string | null; icon: string | null; memberCount: number; messages: number; voiceMinutes: number; activeMembers: number }[];
  measuredGuilds: number;
  silentGuilds: number;
  channels: FleetChannel[];
  categories: { categoryId: string | null; name: string | null; guildId: string; guildName: string | null; messages: number; voiceMinutes: number; channels: number }[];
  content: ContentMix;
}

export const fetchFleetActivity = (days = 30) => read<FleetActivity>(`/api/admin/insights/activity?days=${days}`);

// ── Fiche d'un serveur ───────────────────────────────────────────────────────

export interface GuildSheetDay {
  dateKey: string;
  messages: number;
  reactions: number;
  voiceMinutes: number;
  activeMembers: number;
  joined: number;
  left: number;
  totalMembers: number;
  peakOnline: number;
  sanctions: number;
  warns: number;
  timeouts: number;
  kicks: number;
  bans: number;
}

export interface GuildSheet {
  days: number;
  /** Faux quand le bot n'est plus sur le serveur : il ne reste que l'historique. */
  present: boolean;
  guild: {
    id: string;
    name: string | null;
    icon?: string | null;
    banner?: string | null;
    description?: string | null;
    ownerId?: string;
    memberCount?: number;
    createdAt?: string;
    joinedAt?: string | null;
    premiumTier?: number;
    boosts?: number;
    locale?: string;
    features?: string[];
    rolesCount?: number;
    emojisCount?: number;
    channelsCount?: number;
    shardId?: number;
    botIsAdmin?: boolean;
  };
  access: {
    activated: boolean;
    activatedAt: string | null;
    activationCode: string | null;
    plan: string;
    accessType: string;
    accessExpiresAt: string | null;
    onboardingCompletedAt: string | null;
    stripeSubscriptionStatus: string | null;
    stripeCancelAtPeriodEnd: boolean;
    stripeCurrentPeriodEnd: string | null;
    createdAt: string;
  } | null;
  health: { score: number; signals: { tone: 'danger' | 'warning' | 'info' | 'success'; label: string }[] };
  totals: {
    messages: number;
    reactions: number;
    voiceMinutes: number;
    joined: number;
    left: number;
    sanctions: number;
    warns: number;
    timeouts: number;
    kicks: number;
    bans: number;
    activeMembersAvg: number;
    memberCount: number;
  };
  fleet: { rank: number | null; of: number; median: number };
  series: GuildSheetDay[];
  heat: number[][];
  channels: { channelId: string; name: string | null; type: number | null; categoryId: string | null; categoryName: string | null; messages: number; voiceMinutes: number; authors: number }[];
  categories: { categoryId: string | null; name: string | null; messages: number; voiceMinutes: number; channels: number }[];
  content: ContentMix;
  modules: { name: string; enabled: boolean; activatedAt: string | null; lastUsedAt: string | null }[];
  aegis: {
    enabled: boolean;
    reviewThreshold: number | null;
    autoThreshold: number | null;
    analyzed: number;
    toxic: number;
    severe: number;
    averageToxicity: number;
    detections: Record<string, number>;
  };
  vision: { lists: number; images: number; reviews: Record<string, number> };
  audit: { id: string; action: string; summary: string; outcome: string; actorName: string | null; actorId: string; createdAt: string }[];
}

export const fetchGuildSheet = (guildId: string, days = 30) => read<GuildSheet>(`/api/admin/insights/guilds/${guildId}?days=${days}`);

// ── Supervision AegisAI et Kotbo Vision ──────────────────────────────────────

export interface AiSupervision {
  days: number;
  aegis: {
    queue: { backend: 'redis' | 'memory' | 'stopped'; depth: number; active: number; concurrency: number; processed: number; failed: number; dropped: number };
    enabledGuilds: number;
    trainingConsentGuilds: number;
    analyzed: number;
    toxic: number;
    severe: number;
    late: number;
    pendingReviews: number;
    series: { dateKey: string; analyzed: number; toxic: number; severe: number; averageToxicity: number }[];
    emotions: { analyzed: number; joy: number; sad: number; anger: number; fear: number; surprise: number; neutral: number };
    kinds: Record<string, number>;
    status: Record<string, number>;
    actions: Record<string, number>;
    guilds: { guildId: string; name: string | null; analyzed: number; toxic: number; severe: number }[];
  };
  vision: {
    enabledLists: number;
    guildsWithLists: number;
    images: number;
    globalImages: number;
    newImages: number;
    imageSources: Record<string, number>;
    domains: number;
    globalDomains: number;
    textSamples: number;
    reviews: Record<string, number>;
    topDomains: { domain: string; hits: number; source: string; global: boolean; lastSeenAt: string }[];
  };
}

export const fetchAiSupervision = (days = 30) => read<AiSupervision>(`/api/admin/insights/ai?days=${days}`);

// ── Profil des requetes ──────────────────────────────────────────────────────

export interface QueryStats {
  uptimeSeconds: number;
  readReplicaConfigured: boolean;
  entries: { key: string; count: number; totalMs: number; maxMs: number; avgMs: number; slowCount: number; errorCount: number }[];
}

export const fetchQueryStats = (limit = 60) => read<QueryStats>(`/api/admin/query-stats?limit=${limit}`);
