/**
 * Site communautaire : réglages, pages, publication, images, commentaires,
 * fréquentation (API /api/site-admin/:guildId), et administration Kotbo
 * (/api/admin/sites).
 */
import type { SiteDocument, SiteNavItem, SiteThemeSettings } from '@kotbo/shared';
import { authStore } from '../stores/auth.svelte';
import { apiRequest, API_BASE_URL, authorizedFetch } from './client';
import { DashboardApiError } from './errors';

export type SitePageKind = 'PAGE' | 'WIKI' | 'BLOG';
export type SiteVisibility = 'PUBLIC' | 'MEMBERS' | 'ROLES' | 'STAFF';
export type SiteTemplate = 'general' | 'gaming' | 'rp' | 'esport' | 'etude';

export interface CommunitySite {
  id: string;
  guildId: string;
  slug: string;
  published: boolean;
  name: string | null;
  tagline: string | null;
  logoUrl: string | null;
  bannerUrl: string | null;
  faviconUrl: string | null;
  theme: string;
  themeSettings: SiteThemeSettings;
  customCss: string | null;
  navigation: SiteNavItem[];
  homePageId: string | null;
  staffPage: { bio?: boolean; absence?: boolean; seniority?: boolean; stats?: boolean };
  settings: { commentsByDefault?: boolean; showMemberCount?: boolean };
  /** Récompenses de l'activité sur le site (voir `normalizeSiteRewards`). */
  rewards: Record<string, unknown>;
  wikiEditorRoleIds: string[];
  blogEditorRoleIds: string[];
  wikiAnnounceChannelId: string | null;
  blogAnnounceChannelId: string | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
  updatedAt: string;
}

export interface SitePageSummary {
  id: string;
  kind: SitePageKind;
  slug: string;
  title: string;
  parentId: string | null;
  sortOrder: number;
  tags: string[];
  visibility: SiteVisibility;
  publishedAt: string | null;
  firstPublishedAt: string | null;
  scheduledAt: string | null;
  hasUnpublishedChanges: boolean;
  archivedAt: string | null;
  authorId: string;
  lastEditedById: string | null;
  updatedAt: string;
}

export interface SitePageDetail extends SitePageSummary {
  excerpt: string | null;
  coverUrl: string | null;
  icon: string | null;
  visibleRoleIds: string[];
  draftContent: SiteDocument;
  publishedTitle: string | null;
  commentsEnabled: boolean;
  seoTitle: string | null;
  seoDescription: string | null;
}

export interface SiteRights {
  manage: boolean;
  wiki: boolean;
  blog: boolean;
  moderateComments: boolean;
  viewStats: boolean;
}

export interface SiteState {
  site: CommunitySite | null;
  pages: SitePageSummary[];
  rights: SiteRights;
  modules: { site: boolean; site_wiki: boolean; site_blog: boolean };
  baseUrl: string;
  suggestedSlug: string | null;
  templates: SiteTemplate[];
  guild: { name: string; iconUrl: string | null; bannerUrl: string | null } | null;
}

export interface SiteCatalog {
  blocks: Array<{ key: string; category: string; available: boolean; dependency: string | null }>;
  forms: Array<{ id: string; name: string; isRecruitment: boolean }>;
  hierarchies: Array<{ id: string; name: string; icon: string | null }>;
  channels: Array<{ id: string; name: string; public: boolean; botCanSend: boolean }>;
  roles: Array<{ id: string; name: string; color: string }>;
}

export interface SiteAsset {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  mimeType: string;
  fileName: string;
}

export interface SiteRevision {
  id: string;
  title: string;
  authorId: string;
  note: string | null;
  createdAt: string;
}

export interface SiteComment {
  id: string;
  pageId: string;
  authorId: string;
  authorName: string;
  authorAvatar: string | null;
  content: string;
  status: 'VISIBLE' | 'PENDING' | 'HIDDEN';
  moderationReason: string | null;
  createdAt: string;
  page: { title: string; slug: string };
}

export interface SiteAnalyticsReport {
  from: string;
  to: string;
  totals: { views: number; visitors: number };
  previous: { views: number; visitors: number };
  daily: Array<{ date: string; views: number; visitors: number }>;
  pages: Array<{ path: string; views: number; visitors: number }>;
  referrers: Array<{ host: string; views: number }>;
  devices: Array<{ device: string; views: number }>;
}

const base = (guildId: string) => `/api/site-admin/${guildId}`;
const gid = (guildId?: string | null) => guildId || authStore.selectedGuildId || '';

export function fetchSiteState(guildId?: string) {
  return apiRequest<SiteState>(base(gid(guildId)), { errorContext: 'API Error (Site):' });
}

export function fetchSiteCatalog(guildId?: string) {
  return apiRequest<SiteCatalog>(`${base(gid(guildId))}/catalog`, { errorContext: 'API Error (Site catalog):' });
}

export function createSite(input: { slug: string; template: SiteTemplate }, guildId?: string) {
  return apiRequest<{ site: CommunitySite }>(base(gid(guildId)), { method: 'POST', payload: input, errorContext: 'API Error (Create site):' });
}

export function updateSite(patch: Partial<Omit<CommunitySite, 'id' | 'guildId' | 'updatedAt' | 'suspendedAt' | 'suspendedReason'>>, guildId?: string) {
  return apiRequest<{ site: CommunitySite }>(base(gid(guildId)), { method: 'PATCH', payload: patch, errorContext: 'API Error (Update site):' });
}

export function deleteSite(guildId?: string) {
  return apiRequest<{ ok: boolean }>(base(gid(guildId)), { method: 'DELETE', errorContext: 'API Error (Delete site):' });
}

export function createSitePage(input: { kind: SitePageKind; title: string; slug?: string; parentId?: string | null; content?: SiteDocument }, guildId?: string) {
  return apiRequest<{ page: { id: string; kind: SitePageKind; slug: string; title: string } }>(`${base(gid(guildId))}/pages`, { method: 'POST', payload: input, errorContext: 'API Error (Create page):' });
}

export function fetchSitePage(pageId: string, guildId?: string) {
  return apiRequest<{ page: SitePageDetail }>(`${base(gid(guildId))}/pages/${pageId}`, { errorContext: 'API Error (Site page):' });
}

export type SitePagePatch = Partial<Pick<SitePageDetail, 'title' | 'slug' | 'excerpt' | 'coverUrl' | 'icon' | 'tags' | 'visibility' | 'visibleRoleIds' | 'commentsEnabled' | 'seoTitle' | 'seoDescription' | 'parentId' | 'draftContent'>>;

export function updateSitePage(pageId: string, patch: SitePagePatch, guildId?: string) {
  return apiRequest<{ page: { id: string; slug: string; title: string; updatedAt: string; hasUnpublishedChanges: boolean } }>(`${base(gid(guildId))}/pages/${pageId}`, { method: 'PATCH', payload: patch, errorContext: 'API Error (Update page):' });
}

export function deleteSitePage(pageId: string, guildId?: string) {
  return apiRequest<{ ok: boolean }>(`${base(gid(guildId))}/pages/${pageId}`, { method: 'DELETE', errorContext: 'API Error (Delete page):' });
}

export function publishSitePage(pageId: string, note?: string, guildId?: string) {
  return apiRequest<{ page: { id: string; publishedAt: string; slug: string } }>(`${base(gid(guildId))}/pages/${pageId}/publish`, { method: 'POST', payload: { note }, errorContext: 'API Error (Publish page):' });
}

export function unpublishSitePage(pageId: string, guildId?: string) {
  return apiRequest<{ ok: boolean }>(`${base(gid(guildId))}/pages/${pageId}/unpublish`, { method: 'POST', errorContext: 'API Error (Unpublish page):' });
}

export function scheduleSitePage(pageId: string, at: string | null, guildId?: string) {
  return apiRequest<{ scheduledAt: string | null }>(`${base(gid(guildId))}/pages/${pageId}/schedule`, { method: 'POST', payload: { at }, errorContext: 'API Error (Schedule page):' });
}

export function createSitePreviewLink(pageId: string, guildId?: string) {
  return apiRequest<{ url: string; expiresAt: string }>(`${base(gid(guildId))}/pages/${pageId}/preview`, { method: 'POST', errorContext: 'API Error (Preview link):' });
}

export function reorderSitePages(kind: SitePageKind, ids: string[], guildId?: string) {
  return apiRequest<{ ok: boolean }>(`${base(gid(guildId))}/pages/reorder`, { method: 'POST', payload: { kind, ids }, errorContext: 'API Error (Reorder pages):' });
}

export function fetchSiteRevisions(pageId: string, guildId?: string) {
  return apiRequest<{ revisions: SiteRevision[] }>(`${base(gid(guildId))}/pages/${pageId}/revisions`, { errorContext: 'API Error (Revisions):' });
}

export function fetchSiteRevision(pageId: string, revisionId: string, guildId?: string) {
  return apiRequest<{ revision: SiteRevision & { content: SiteDocument } }>(`${base(gid(guildId))}/pages/${pageId}/revisions/${revisionId}`, { errorContext: 'API Error (Revision):' });
}

export function restoreSiteRevision(pageId: string, revisionId: string, guildId?: string) {
  return apiRequest<{ page: { id: string; title: string; draftContent: SiteDocument } }>(`${base(gid(guildId))}/pages/${pageId}/revisions/${revisionId}/restore`, { method: 'POST', errorContext: 'API Error (Restore revision):' });
}

export function fetchSiteAssets(guildId?: string) {
  return apiRequest<{ assets: SiteAsset[] }>(`${base(gid(guildId))}/assets`, { errorContext: 'API Error (Site assets):' });
}

/** Téléversement multipart : le navigateur pose lui-même la frontière. */
export async function uploadSiteAsset(file: File, guildId?: string): Promise<SiteAsset> {
  const form = new FormData();
  form.append('file', file);
  const res = await authorizedFetch(`${API_BASE_URL}${base(gid(guildId))}/assets`, { method: 'POST', body: form, timeoutMs: 60_000 });
  const data = (await res.json().catch(() => ({}))) as { asset?: SiteAsset; error?: string };
  if (!res.ok || !data.asset) {
    throw new DashboardApiError({ kind: res.status >= 500 ? 'server' : 'client', status: res.status, code: data.error, serverMessage: data.error, path: '/assets', method: 'POST' });
  }
  return data.asset;
}

export function deleteSiteAsset(assetId: string, guildId?: string) {
  return apiRequest<{ ok: boolean }>(`${base(gid(guildId))}/assets/${assetId}`, { method: 'DELETE', errorContext: 'API Error (Delete asset):' });
}

export function fetchSiteComments(status: 'PENDING' | 'VISIBLE' | 'HIDDEN' | null, guildId?: string) {
  return apiRequest<{ comments: SiteComment[] }>(`${base(gid(guildId))}/comments${status ? `?status=${status}` : ''}`, { errorContext: 'API Error (Site comments):' });
}

export function setSiteCommentStatus(commentId: string, status: 'VISIBLE' | 'HIDDEN', guildId?: string) {
  return apiRequest<{ ok: boolean }>(`${base(gid(guildId))}/comments/${commentId}`, { method: 'PATCH', payload: { status }, errorContext: 'API Error (Comment status):' });
}

export function deleteSiteComment(commentId: string, guildId?: string) {
  return apiRequest<{ ok: boolean }>(`${base(gid(guildId))}/comments/${commentId}`, { method: 'DELETE', errorContext: 'API Error (Delete comment):' });
}

// ─── Votes ──────────────────────────────────────────────────────────────────

export interface SiteVoteSiteAdmin {
  id: string;
  provider: string;
  label: string;
  voteUrl: string;
  cooldownHours: number;
  enabled: boolean;
  sortOrder: number;
  hasKey: boolean;
  /** top.gg : adresse et secret à coller dans le tableau de bord du site de classement. */
  webhookUrl: string | null;
  webhookSecret: string | null;
  votes30d: number;
}

export interface SiteVoteSiteInput {
  provider?: string;
  label?: string;
  voteUrl?: string;
  verificationKey?: string | null;
  cooldownHours?: number;
  enabled?: boolean;
}

export function fetchSiteVotes(guildId?: string) {
  return apiRequest<{ voteSites: SiteVoteSiteAdmin[]; topVoters: Array<{ userId: string; votes: number; name: string; avatarUrl: string | null }> }>(`${base(gid(guildId))}/votes`, { errorContext: 'API Error (Site votes):' });
}

export function createSiteVoteSite(input: SiteVoteSiteInput, guildId?: string) {
  return apiRequest<{ id: string }>(`${base(gid(guildId))}/votes`, { method: 'POST', payload: input, errorContext: 'API Error (Create vote site):' });
}

export function updateSiteVoteSite(id: string, input: SiteVoteSiteInput, guildId?: string) {
  return apiRequest<{ ok: boolean }>(`${base(gid(guildId))}/votes/${id}`, { method: 'PATCH', payload: input, errorContext: 'API Error (Update vote site):' });
}

export function deleteSiteVoteSite(id: string, guildId?: string) {
  return apiRequest<{ ok: boolean }>(`${base(gid(guildId))}/votes/${id}`, { method: 'DELETE', errorContext: 'API Error (Delete vote site):' });
}

export function regenerateSiteVoteSecret(id: string, guildId?: string) {
  return apiRequest<{ ok: boolean }>(`${base(gid(guildId))}/votes/${id}/secret`, { method: 'POST', errorContext: 'API Error (Vote secret):' });
}

export function reorderSiteVoteSites(ids: string[], guildId?: string) {
  return apiRequest<{ ok: boolean }>(`${base(gid(guildId))}/votes/reorder`, { method: 'POST', payload: { ids }, errorContext: 'API Error (Reorder vote sites):' });
}

export function fetchSiteAnalytics(days: number, guildId?: string) {
  return apiRequest<{ report: SiteAnalyticsReport }>(`${base(gid(guildId))}/analytics?days=${days}`, { errorContext: 'API Error (Site analytics):' });
}

export function fetchSiteStaffProfile(guildId?: string) {
  return apiRequest<{ profile: { isStaff: boolean; bio: string; hidden: boolean } }>(`${base(gid(guildId))}/staff-profile`, { errorContext: 'API Error (Staff profile):' });
}

export function updateSiteStaffProfile(input: { bio?: string; hidden?: boolean }, guildId?: string) {
  return apiRequest<{ profile: { bio: string; hidden: boolean } }>(`${base(gid(guildId))}/staff-profile`, { method: 'PUT', payload: input, errorContext: 'API Error (Staff profile):' });
}

/** Adresse du serveur d'édition à plusieurs pour une page. */
export function siteCollabUrl(guildId: string): string {
  const origin = API_BASE_URL || (typeof window !== 'undefined' ? window.location.origin : '');
  return `${origin.replace(/^http/i, 'ws')}/api/site/collab/${guildId}`;
}

/**
 * Signaux temps réel d'un site (« ceci a changé »), par le même WebSocket que
 * le site publié. Reconnexion progressive ; `close()` arrête tout. Le contenu
 * se relit toujours par l'API habituelle.
 */
export function subscribeSiteSignals(
  siteId: string,
  channels: string[],
  onSignal: (channel: string) => void,
  onStatus?: (connected: boolean) => void,
): { close: () => void } {
  const origin = API_BASE_URL || (typeof window !== 'undefined' ? window.location.origin : '');
  const url = `${origin.replace(/^http/i, 'ws')}/api/site/live/${encodeURIComponent(siteId)}`;
  let socket: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (closed || typeof WebSocket === 'undefined') return;
    socket = new WebSocket(url);
    socket.addEventListener('message', (event) => {
      let data: { type?: string; channel?: unknown };
      try {
        data = JSON.parse(String(event.data)) as typeof data;
      } catch {
        return;
      }
      if (data.type === 'site_live_ready') {
        retry = 0;
        socket?.send(JSON.stringify({ type: 'subscribe', channels }));
        onStatus?.(true);
      } else if (data.type === 'site_signal' && typeof data.channel === 'string') {
        onSignal(data.channel);
      }
    });
    socket.addEventListener('close', () => {
      onStatus?.(false);
      socket = null;
      if (closed) return;
      timer = setTimeout(connect, Math.min(60_000, 2000 * 2 ** retry));
      retry += 1;
    });
  };
  connect();

  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      socket?.close();
    },
  };
}

// ─── Administration Kotbo ───────────────────────────────────────────────────

export interface AdminSiteRow {
  id: string;
  guildId: string;
  guildName: string | null;
  slug: string;
  name: string | null;
  published: boolean;
  suspendedAt: string | null;
  suspendedReason: string | null;
  updatedAt: string;
  _count: { pages: number; reports: number };
}

export interface AdminSiteReport {
  id: string;
  siteId: string;
  guildId: string;
  path: string;
  reason: string;
  details: string | null;
  status: 'OPEN' | 'RESOLVED' | 'DISMISSED';
  createdAt: string;
  resolvedAt: string | null;
  site: { slug: string; name: string | null; suspendedAt: string | null };
}

export function fetchAdminSites(query = '') {
  return apiRequest<{ sites: AdminSiteRow[] }>(`/api/admin/sites${query ? `?q=${encodeURIComponent(query)}` : ''}`, { errorContext: 'API Error (Admin sites):' });
}

export function fetchAdminSiteReports(status: 'OPEN' | 'RESOLVED' | 'DISMISSED' | 'ALL' = 'OPEN') {
  return apiRequest<{ reports: AdminSiteReport[] }>(`/api/admin/sites/reports?status=${status}`, { errorContext: 'API Error (Site reports):' });
}

export function setAdminSiteReportStatus(reportId: string, status: 'OPEN' | 'RESOLVED' | 'DISMISSED') {
  return apiRequest<{ ok: boolean }>(`/api/admin/sites/reports/${reportId}`, { method: 'PATCH', payload: { status }, errorContext: 'API Error (Site report):' });
}

export function suspendAdminSite(siteId: string, reason: string) {
  return apiRequest<{ ok: boolean }>(`/api/admin/sites/${siteId}/suspend`, { method: 'POST', payload: { reason }, errorContext: 'API Error (Suspend site):' });
}

export function unsuspendAdminSite(siteId: string) {
  return apiRequest<{ ok: boolean }>(`/api/admin/sites/${siteId}/unsuspend`, { method: 'POST', errorContext: 'API Error (Unsuspend site):' });
}

/** Page du site qui remplace une ancienne page publique, ou nulle (appelée sans session). */
export async function fetchSiteRedirect(params: { guildId?: string; kind?: string; formId?: string }): Promise<string | null> {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => Boolean(v)) as Array<[string, string]>);
  try {
    const res = await fetch(`${API_BASE_URL}/api/site/redirect?${query}`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { path?: string | null };
    return typeof data.path === 'string' && data.path.startsWith('/s/') ? data.path : null;
  } catch {
    return null;
  }
}

// ─── Agent MCP ──────────────────────────────────────────────────────────────

export interface SiteAgentStatus {
  active: boolean;
  keyName: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  activity: string | null;
  pageIds: string[];
  interrupted: { byName: string; at: string; until: string } | null;
}

export function fetchSiteAgent(guildId?: string) {
  return apiRequest<{ agent: SiteAgentStatus }>(`${base(gid(guildId))}/agent`, { errorContext: 'API Error (Site agent):', silent: true });
}

export function interruptSiteAgent(guildId?: string) {
  return apiRequest<{ agent: SiteAgentStatus }>(`${base(gid(guildId))}/agent/interrupt`, { method: 'POST', errorContext: 'API Error (Interrupt agent):' });
}

export function allowSiteAgent(guildId?: string) {
  return apiRequest<{ agent: SiteAgentStatus }>(`${base(gid(guildId))}/agent/allow`, { method: 'POST', errorContext: 'API Error (Allow agent):' });
}

// ─── Rédaction depuis « Mon espace » ────────────────────────────────────────

export interface MyEditorSite {
  guildId: string;
  guildName: string;
  guildIcon: string | null;
  site: { slug: string; name: string | null; url: string };
  kinds: SitePageKind[];
  pages: SitePageSummary[];
}

export function fetchMyEditorSites() {
  return apiRequest<{ sites: MyEditorSite[] }>('/api/site-editor/mine', { errorContext: 'API Error (My editor sites):', silent: true });
}
