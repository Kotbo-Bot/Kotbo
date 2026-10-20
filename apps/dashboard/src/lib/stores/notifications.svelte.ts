import { router } from 'tinro';
import type { NotificationCategory, NotificationChannelPrefs, NotificationSeverity } from '@kotbo/contracts';
import { apiRequest } from '../api/client';
import { authStore } from './auth.svelte';
import { announceNotifications, onNotificationOpened } from '../notificationAlerts';

/**
 * Boîte de notifications de la personne connectée, tous serveurs confondus.
 *
 * La cloche et la page /notifications lisent le même store. La cloche ne tient
 * que la première page de la boîte ; la page charge ses propres listes
 * (filtres, archives, pages suivantes) via `fetchPage`.
 */
export type Notification = {
  id: string;
  guildId: string;
  guildName: string | null;
  kind: string;
  category: NotificationCategory;
  title: string;
  message: string;
  type: NotificationSeverity;
  link: string | null;
  actorId: string | null;
  count: number;
  data: Record<string, unknown> | null;
  isRead: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NotificationStatus = 'inbox' | 'unread' | 'archived';
export type NotificationFilters = { status: NotificationStatus; guildId?: string; category?: NotificationCategory };
export type NotificationPage = { notifications: Notification[]; nextCursor: string | null; unread: number; unreadByGuild: Record<string, number> };
export type CategoryPrefs = NotificationChannelPrefs & { category: NotificationCategory };

const API = '/api/dashboard/notifications';

function query(filters: NotificationFilters, cursor?: string | null, limit = 30): string {
  const params = new URLSearchParams({ status: filters.status, limit: String(limit) });
  if (filters.guildId) params.set('guild', filters.guildId);
  if (filters.category) params.set('category', filters.category);
  if (cursor) params.set('cursor', cursor);
  return `${API}?${params}`;
}

class NotificationsStore {
  /** Première page de la boîte : ce que montre la cloche. */
  items = $state<Notification[]>([]);
  unreadCount = $state(0);
  unreadByGuild = $state<Record<string, number>>({});
  loading = $state(false);
  error = $state<string | null>(null);
  /** Incrémenté à chaque changement, pour que la page recharge sa liste. */
  revision = $state(0);
  private inflight: Promise<void> | null = null;
  private fetchedAt = 0;

  private static readonly FRESH_FOR_MS = 30_000;
  /** Une notification plus ancienne n'est plus « nouvelle », même jamais vue. */
  private static readonly ANNOUNCE_WITHIN_MS = 15 * 60_000;

  /** Le premier chargement sert de référence et n'annonce rien. */
  private knownIds: Set<string> | null = null;

  constructor() {
    onNotificationOpened((id) => {
      const notif = this.items.find((n) => n.id === id);
      if (notif && !notif.isRead) void this.markAsRead(id);
    });
  }

  private detectNew(incoming: Notification[]) {
    // Une notification regroupée revient sous le même id : c'est sa date de mise à jour qui la rend neuve.
    const key = (n: Notification) => `${n.id}:${n.updatedAt}`;
    if (this.knownIds) {
      const known = this.knownIds;
      const now = Date.now();
      const fresh = incoming.filter(
        (n) => !n.isRead && !known.has(key(n)) && now - Date.parse(n.updatedAt) < NotificationsStore.ANNOUNCE_WITHIN_MS,
      );
      if (fresh.length > 0) void announceNotifications(fresh.map((n) => ({ ...n, link: this.href(n) })));
    }
    this.knownIds = new Set(incoming.map(key));
  }

  /** Lien interne ouvrant le bon serveur, ou lien absolu tel quel. */
  href(n: Pick<Notification, 'guildId' | 'link'>): string {
    const link = n.link || '/notifications';
    if (!link.startsWith('/') || link.startsWith('//') || n.guildId === authStore.selectedGuildId) return link;
    return `${link}${link.includes('?') ? '&' : '?'}guild=${n.guildId}`;
  }

  /** Ouvre ce qu'annonce la notification, en basculant sur son serveur si besoin. */
  open(n: Notification) {
    if (!n.isRead) void this.markAsRead(n.id);
    const link = n.link || '/notifications';
    if (!link.startsWith('/') || link.startsWith('//')) {
      window.location.href = link;
      return;
    }
    if (n.guildId !== authStore.selectedGuildId && authStore.guilds.some((g) => g.id === n.guildId)) authStore.setGuild(n.guildId);
    router.goto(link);
  }

  guildName(n: Pick<Notification, 'guildId' | 'guildName'>): string {
    return authStore.guilds.find((g) => g.id === n.guildId)?.name ?? n.guildName ?? n.guildId;
  }

  async fetchPage(filters: NotificationFilters, cursor?: string | null, limit?: number): Promise<NotificationPage> {
    return apiRequest<NotificationPage>(query(filters, cursor, limit), { silent: true, errorContext: 'Notifications' });
  }

  async fetchNotifications(force = false): Promise<void> {
    if (!authStore.token) return;
    if (!force && Date.now() - this.fetchedAt < NotificationsStore.FRESH_FOR_MS) return;
    if (this.inflight) return this.inflight;

    this.loading = true;
    this.inflight = (async () => {
      try {
        const page = await this.fetchPage({ status: 'inbox' }, null, 20);
        this.items = page.notifications;
        this.unreadCount = page.unread;
        this.unreadByGuild = page.unreadByGuild;
        this.detectNew(page.notifications);
        this.error = null;
        this.fetchedAt = Date.now();
        this.revision += 1;
      } catch {
        this.error = 'Impossible de récupérer les notifications. Réessaie.';
      } finally {
        this.loading = false;
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  private local(id: string, patch: Partial<Notification>) {
    const notif = this.items.find((n) => n.id === id);
    if (!notif) return;
    if (patch.isRead !== undefined && patch.isRead !== notif.isRead) {
      const delta = patch.isRead ? -1 : 1;
      this.unreadCount = Math.max(0, this.unreadCount + delta);
      this.unreadByGuild = { ...this.unreadByGuild, [notif.guildId]: Math.max(0, (this.unreadByGuild[notif.guildId] ?? 0) + delta) };
    }
    Object.assign(notif, patch);
  }

  private async write(path: string, method: string, payload?: unknown): Promise<boolean> {
    try {
      await apiRequest(`${API}${path}`, { method, payload, errorContext: 'Notifications' });
      return true;
    } catch {
      return false;
    }
  }

  async markAsRead(id: string, read = true) {
    this.local(id, { isRead: read });
    if (!(await this.write(`/${id}`, 'PATCH', { read }))) this.local(id, { isRead: !read });
    this.revision += 1;
  }

  async archive(id: string, archived = true) {
    if (archived) {
      this.local(id, { isRead: true });
      this.items = this.items.filter((n) => n.id !== id);
    }
    await this.write(`/${id}`, 'PATCH', { archived });
    await this.fetchNotifications(true);
  }

  async remove(id: string) {
    this.local(id, { isRead: true });
    this.items = this.items.filter((n) => n.id !== id);
    await this.write(`/${id}`, 'DELETE');
    await this.fetchNotifications(true);
  }

  async markAllAsRead(guildId?: string) {
    for (const n of this.items) if (!guildId || n.guildId === guildId) n.isRead = true;
    await this.write('/read-all', 'POST', guildId ? { guildId } : {});
    await this.fetchNotifications(true);
  }

  // ── Grille de préférences (côté serveur, vaut pour le dashboard et les MP) ──

  async fetchPreferences(): Promise<CategoryPrefs[]> {
    const data = await apiRequest<{ categories: CategoryPrefs[] }>(`${API}/preferences`, { silent: true, errorContext: 'Notifications' });
    return data.categories;
  }

  async savePreference(prefs: CategoryPrefs): Promise<CategoryPrefs | null> {
    try {
      return await apiRequest<CategoryPrefs>(`${API}/preferences`, { method: 'PUT', payload: prefs, errorContext: 'Notifications' });
    } catch {
      return null;
    }
  }
}

export const notificationsStore = new NotificationsStore();
