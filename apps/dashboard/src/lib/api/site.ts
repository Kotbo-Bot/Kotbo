/**
 * Site communautaire : réglages, pages, publication, images, commentaires,
 * fréquentation (API /api/site-admin/:guildId), et administration Kotbo
 * (/api/admin/sites).
 */
import type { ShopOfferKind, SiteDocument, SiteNavItem, SiteThemeSettings } from '@kotbo/shared';
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
  settings: { commentsByDefault?: boolean; showMemberCount?: boolean; auto?: unknown };
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

// ─── Galerie de thèmes ───────────────────────────────────────────────────────

interface GalleryPalette {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  header: string;
  accent: string;
}

export interface GalleryCard {
  id: string;
  name: string;
  description: string;
  authorName: string;
  installs: number;
  templates: Array<{ key: string; title: string }>;
  hasCss: boolean;
  hasMenu: boolean;
  createdAt: string;
  preview: { mode: string; font: string; headingFont: string; radius: number; light: GalleryPalette; dark: GalleryPalette };
  installed: boolean;
  own: boolean;
}

export interface GalleryState {
  items: GalleryCard[];
  pages: number;
  own: Array<{ id: string; name: string; description: string; installs: number; hidden: boolean; createdAt: string; updatedAt: string }>;
}

export function fetchGallery(params: { sort: 'popular' | 'recent'; q: string; page: number }, guildId?: string) {
  const query = new URLSearchParams({ sort: params.sort, page: String(params.page), ...(params.q ? { q: params.q } : {}) });
  return apiRequest<GalleryState>(`${base(gid(guildId))}/gallery?${query}`, { errorContext: 'API Error (Theme gallery):' });
}

export function publishThemeShare(input: { id?: string; name: string; description: string; includeCss: boolean; includeMenu: boolean; pageIds: string[] }, guildId?: string) {
  return apiRequest<{ id: string }>(`${base(gid(guildId))}/gallery`, { method: 'POST', payload: input, errorContext: 'API Error (Publish theme):' });
}

export function deleteThemeShare(id: string, guildId?: string) {
  return apiRequest<{ ok: boolean }>(`${base(gid(guildId))}/gallery/${id}`, { method: 'DELETE', errorContext: 'API Error (Delete theme):' });
}

export function installThemeShare(id: string, parts: { style: boolean; css: boolean; templates: boolean; menu: boolean }, guildId?: string) {
  return apiRequest<{ pagesCreated: number }>(`${base(gid(guildId))}/gallery/${id}/install`, { method: 'POST', payload: parts, errorContext: 'API Error (Install theme):' });
}

export function reportThemeShare(id: string, reason: string, guildId?: string) {
  return apiRequest<{ ok: boolean }>(`${base(gid(guildId))}/gallery/${id}/report`, { method: 'POST', payload: { reason }, errorContext: 'API Error (Report theme):' });
}

// ─── Site automatique ────────────────────────────────────────────────────────

export function publishWeeklySummaryNow(guildId?: string) {
  return apiRequest<{ pageId: string | null }>(`${base(gid(guildId))}/auto/weekly`, { method: 'POST', errorContext: 'API Error (Weekly summary):' });
}

export function syncModulePagesNow(guildId?: string) {
  return apiRequest<{ created: number }>(`${base(gid(guildId))}/auto/module-pages`, { method: 'POST', errorContext: 'API Error (Module pages):' });
}

// ─── Forum ───────────────────────────────────────────────────────────────────

export interface ForumCategoryAdmin {
  id: string;
  name: string;
  slug: string;
  description: string;
  mode: 'SITE' | 'MIRROR';
  channelId: string | null;
  webhookId: string | null;
  writeRoleIds: string[];
  staffTopicsOnly: boolean;
  sortOrder: number;
  topicCount: number;
  lastPostAt: string | null;
}

export interface ForumRecentPost {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  source: string;
  createdAt: string;
  topic: { id: string; title: string; pinned: boolean; locked: boolean; category: { name: string; slug: string } };
}

export interface ForumAdminState {
  categories: ForumCategoryAdmin[];
  recent: ForumRecentPost[];
  forumChannels: Array<{ id: string; name: string; botCanManage: boolean }>;
}

export function fetchForumAdmin(guildId?: string) {
  return apiRequest<ForumAdminState>(`${base(gid(guildId))}/forum`, { errorContext: 'API Error (Forum):' });
}

export function createForumCategory(input: Record<string, unknown>, guildId?: string) {
  return apiRequest<{ id: string }>(`${base(gid(guildId))}/forum/categories`, { method: 'POST', payload: input, errorContext: 'API Error (Create forum category):' });
}

export function updateForumCategory(id: string, input: Record<string, unknown>, guildId?: string) {
  return apiRequest<{ ok: boolean }>(`${base(gid(guildId))}/forum/categories/${id}`, { method: 'PATCH', payload: input, errorContext: 'API Error (Update forum category):' });
}

export function deleteForumCategory(id: string, guildId?: string) {
  return apiRequest<{ ok: boolean }>(`${base(gid(guildId))}/forum/categories/${id}`, { method: 'DELETE', errorContext: 'API Error (Delete forum category):' });
}

export function reorderForumCategories(ids: string[], guildId?: string) {
  return apiRequest<{ ok: boolean }>(`${base(gid(guildId))}/forum/categories/reorder`, { method: 'POST', payload: { ids }, errorContext: 'API Error (Reorder forum categories):' });
}

export function importForumCategory(id: string, guildId?: string) {
  return apiRequest<{ imported: number }>(`${base(gid(guildId))}/forum/categories/${id}/import`, { method: 'POST', errorContext: 'API Error (Import forum):' });
}

export function setForumTopicFlags(topicId: string, flags: { pinned?: boolean; locked?: boolean }, guildId?: string) {
  return apiRequest<{ ok: boolean }>(`${base(gid(guildId))}/forum/topics/${topicId}/flags`, { method: 'POST', payload: flags, errorContext: 'API Error (Forum topic):' });
}

export function deleteForumPostAdmin(postId: string, guildId?: string) {
  return apiRequest<{ ok: boolean }>(`${base(gid(guildId))}/forum/posts/${postId}`, { method: 'DELETE', errorContext: 'API Error (Delete forum post):' });
}

// ─── Boutique ────────────────────────────────────────────────────────────────

export interface ShopSettingsAdmin {
  enabled: boolean;
  approvalChannelId: string | null;
  logChannelId: string | null;
  graceDays: number;
}

export interface ShopOfferAdmin {
  id: string;
  kind: ShopOfferKind;
  name: string;
  description: string;
  imageUrl: string | null;
  category: string | null;
  price: number;
  roleId: string | null;
  durationDays: number | null;
  itemId: string | null;
  quantity: number;
  stock: number | null;
  perMemberLimit: number | null;
  requiredRoleIds: string[];
  minLevel: number;
  requiresApproval: boolean;
  giftable: boolean;
  enabled: boolean;
  sortOrder: number;
  sales30d: { count: number; revenue: number };
}

export interface ShopPromoCodeAdmin {
  id: string;
  code: string;
  percentOff: number | null;
  amountOff: number | null;
  maxUses: number | null;
  uses: number;
  offerIds: string[];
  expiresAt: string | null;
  enabled: boolean;
}

export interface ShopOrderAdmin {
  id: string;
  offerId: string | null;
  offerName: string;
  kind: ShopOfferKind;
  buyerId: string;
  recipientId: string;
  buyerName: string;
  recipientName: string;
  price: number;
  listPrice: number;
  status: 'PENDING' | 'COMPLETED' | 'REFUSED';
  source: string;
  note: string | null;
  refusalReason: string | null;
  createdAt: string;
}

export interface ShopAdminState {
  settings: ShopSettingsAdmin;
  currency: { name: string; emoji: string };
  offers: ShopOfferAdmin[];
  codes: ShopPromoCodeAdmin[];
  pending: ShopOrderAdmin[];
  recent: ShopOrderAdmin[];
  items: Array<{ id: string; name: string; emoji: string; type: string }>;
  roles: Array<{ id: string; name: string; color: string; assignable: boolean }>;
}

export function fetchShopAdmin(guildId?: string) {
  return apiRequest<ShopAdminState>(`${base(gid(guildId))}/shop`, { errorContext: 'API Error (Shop):' });
}

export function saveShopSettingsAdmin(input: Partial<ShopSettingsAdmin>, guildId?: string) {
  return apiRequest<{ settings: ShopSettingsAdmin }>(`${base(gid(guildId))}/shop/settings`, { method: 'PUT', payload: input, errorContext: 'API Error (Shop settings):' });
}

export function createShopOffer(input: Record<string, unknown>, guildId?: string) {
  return apiRequest<{ id: string }>(`${base(gid(guildId))}/shop/offers`, { method: 'POST', payload: input, errorContext: 'API Error (Create shop offer):' });
}

export function updateShopOffer(id: string, input: Record<string, unknown>, guildId?: string) {
  return apiRequest<{ ok: boolean }>(`${base(gid(guildId))}/shop/offers/${id}`, { method: 'PATCH', payload: input, errorContext: 'API Error (Update shop offer):' });
}

export function deleteShopOffer(id: string, guildId?: string) {
  return apiRequest<{ ok: boolean; result: 'deleted' | 'disabled' }>(`${base(gid(guildId))}/shop/offers/${id}`, { method: 'DELETE', errorContext: 'API Error (Delete shop offer):' });
}

export function reorderShopOffers(ids: string[], guildId?: string) {
  return apiRequest<{ ok: boolean }>(`${base(gid(guildId))}/shop/offers/reorder`, { method: 'POST', payload: { ids }, errorContext: 'API Error (Reorder shop offers):' });
}

export function createShopCode(input: Record<string, unknown>, guildId?: string) {
  return apiRequest<{ id: string }>(`${base(gid(guildId))}/shop/codes`, { method: 'POST', payload: input, errorContext: 'API Error (Create promo code):' });
}

export function updateShopCode(id: string, input: Record<string, unknown>, guildId?: string) {
  return apiRequest<{ ok: boolean }>(`${base(gid(guildId))}/shop/codes/${id}`, { method: 'PATCH', payload: input, errorContext: 'API Error (Update promo code):' });
}

export function deleteShopCode(id: string, guildId?: string) {
  return apiRequest<{ ok: boolean }>(`${base(gid(guildId))}/shop/codes/${id}`, { method: 'DELETE', errorContext: 'API Error (Delete promo code):' });
}

export function decideShopOrder(id: string, approve: boolean, reason: string, guildId?: string) {
  return apiRequest<{ ok: boolean; status: string }>(`${base(gid(guildId))}/shop/orders/${id}/decide`, { method: 'POST', payload: { approve, reason }, errorContext: 'API Error (Decide shop order):' });
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
