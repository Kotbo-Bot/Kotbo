<script lang="ts">
  /**
   * Notifications : la boîte de la personne connectée, tous serveurs confondus.
   *
   * Trois vues (boîte, non lues, archivées), filtrées par serveur et par
   * famille, chargées page par page. Les notifications qui portent une décision
   * (absence, démission) se traitent sur place : l'action passe par la route
   * du module, avec ses propres contrôles d'accès.
   */
  import { untrack } from 'svelte';
  import type { NotificationCategory } from '@kotbo/contracts';
  import { Button, Tabs } from '../lib/components/ui';
  import {
    notificationsStore,
    type Notification,
    type NotificationFilters,
    type NotificationStatus,
  } from '../lib/stores/notifications.svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { dashboardMutation } from '../lib/api/client';
  import { CATEGORIES, categoryMeta, severityMeta } from '../lib/notificationUi';
  import Papicon from '../lib/components/Papicon.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import SectionCard from '../lib/components/SectionCard.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import { m, dateLocale } from '../lib/i18n';

  let status = $state<NotificationStatus>('inbox');
  let guildId = $state('');
  let category = $state<NotificationCategory | ''>('');

  let items = $state<Notification[]>([]);
  let nextCursor = $state<string | null>(null);
  let loading = $state(false);
  let loadingMore = $state(false);
  let busy = $state<string | null>(null);

  const filters = $derived<NotificationFilters>({
    status,
    guildId: guildId || undefined,
    category: category || undefined,
  });

  // Recharge quand un filtre change, ou quand la boîte bouge (cloche, temps réel).
  $effect(() => {
    void notificationsStore.revision;
    const current = filters;
    // `load` lit `items` : sans untrack, chaque chargement relancerait l'effet.
    untrack(() => void load(current));
  });

  async function load(current: NotificationFilters) {
    loading = items.length === 0;
    try {
      const page = await notificationsStore.fetchPage(current);
      items = page.notifications;
      nextCursor = page.nextCursor;
    } catch {
      toast.error(notificationsStore.error ?? 'Erreur réseau');
    } finally {
      loading = false;
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    loadingMore = true;
    try {
      const page = await notificationsStore.fetchPage(filters, nextCursor);
      items = [...items, ...page.notifications];
      nextCursor = page.nextCursor;
    } finally {
      loadingMore = false;
    }
  }

  const statusTabs = $derived([
    { id: 'inbox', label: m.ntf_status_inbox(), icon: 'inbox' },
    { id: 'unread', label: m.ntf_status_unread(), icon: 'mail', badge: notificationsStore.unreadCount || undefined },
    { id: 'archived', label: m.ntf_status_archived(), icon: 'archive' },
  ]);

  /** Les serveurs de la personne, plus ceux d'où viennent des notifications qu'elle ne voit plus dans sa liste. */
  const guildOptions = $derived.by(() => {
    const ids = new Set([...authStore.guilds.map((g) => g.id), ...Object.keys(notificationsStore.unreadByGuild)]);
    return [...ids].map((id) => ({ id, name: notificationsStore.guildName({ guildId: id, guildName: items.find((n) => n.guildId === id)?.guildName ?? null }) }));
  });

  // ── Actions rapides ──────────────────────────────────────────────────────

  type QuickAction = { label: string; icon: string; variant: 'primary' | 'secondary'; run: () => Promise<boolean> };

  function quickActions(n: Notification): QuickAction[] {
    if (n.archivedAt) return [];
    const data = n.data ?? {};
    const absenceId = typeof data.absenceId === 'string' ? data.absenceId : null;
    const resignationId = typeof data.resignationId === 'string' ? data.resignationId : null;

    if (absenceId && (n.kind === 'planning.absence_pending' || n.kind === 'planning.absence_requested')) {
      const decide = (decision: 'APPROVED' | 'REJECTED') => () =>
        dashboardMutation(`/absences/${absenceId}`, { method: 'PATCH', payload: { status: decision }, guildId: n.guildId });
      return [
        { label: m.ntf_qa_approve(), icon: 'check', variant: 'primary', run: decide('APPROVED') },
        { label: m.ntf_qa_reject(), icon: 'x', variant: 'secondary', run: decide('REJECTED') },
      ];
    }
    if (resignationId && n.kind === 'staff.resignation_requested') {
      const decide = (action: 'APPROVED' | 'REJECTED') => () =>
        dashboardMutation(`/staff/resignations/${resignationId}`, { method: 'PATCH', payload: { action }, guildId: n.guildId });
      return [
        { label: m.ntf_qa_approve(), icon: 'check', variant: 'primary', run: decide('APPROVED') },
        { label: m.ntf_qa_reject(), icon: 'x', variant: 'secondary', run: decide('REJECTED') },
      ];
    }
    return [];
  }

  async function runQuickAction(n: Notification, action: QuickAction) {
    busy = n.id;
    try {
      if (await action.run()) {
        toast.success(m.ntf_qa_done());
        await notificationsStore.archive(n.id);
      }
    } finally {
      busy = null;
    }
  }

  async function act(n: Notification, fn: () => Promise<void>) {
    busy = n.id;
    try {
      await fn();
    } finally {
      busy = null;
    }
  }

  function formatDate(value: string): string {
    return new Date(value).toLocaleString(dateLocale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
</script>

<ModulePage title={m.nav_inbox()} description={m.ntf_page_desc()} icon="inbox">
  {#snippet actions()}
    <Button size="sm" icon="settings" href="/userSettings">{m.ntf_settings()}</Button>
    {#if notificationsStore.unreadCount > 0}
      <Button variant="primary" size="sm" icon="check" onclick={() => notificationsStore.markAllAsRead(guildId || undefined)}>{m.notif_mark_all_read()}</Button>
    {/if}
    <RefreshButton onclick={() => notificationsStore.fetchNotifications(true)} loading={loading} />
  {/snippet}

  <div class="ntf-toolbar mb-5">
    <Tabs label={m.nav_inbox()} tabs={statusTabs} active={status} onchange={(id) => (status = id as NotificationStatus)} />
    <div class="ntf-filters">
      <label>
        <span>{m.ntf_filter_server()}</span>
        <select bind:value={guildId}>
          <option value="">{m.ntf_all_servers()}</option>
          {#each guildOptions as option (option.id)}
            <option value={option.id}>{option.name}</option>
          {/each}
        </select>
      </label>
      <label>
        <span>{m.ntf_filter_category()}</span>
        <select bind:value={category}>
          <option value="">{m.ntf_all_categories()}</option>
          {#each CATEGORIES as key (key)}
            <option value={key}>{categoryMeta(key).label()}</option>
          {/each}
        </select>
      </label>
    </div>
  </div>

  <SectionCard title={statusTabs.find((t) => t.id === status)?.label ?? ''} flush>
    {#if loading}
      <div class="p-5 space-y-2">
        {#each Array(4) as _}
          <Skeleton height="h-16" />
        {/each}
      </div>
    {:else if items.length === 0}
      <EmptyState icon="inbox" title={m.ntf_empty_title()} description={m.ntf_empty_desc()} reason="all-clear" />
    {:else}
      <ul class="divide-y divide-outline-variant/10">
        {#each items as notif (notif.id)}
          {@const meta = severityMeta(notif.type)}
          {@const cat = categoryMeta(notif.category)}
          {@const actions = quickActions(notif)}
          <li
            class="relative flex items-start gap-3 px-5 py-4 transition-colors hover:bg-white/2
            {notif.isRead ? '' : 'before:absolute before:left-0 before:top-3 before:bottom-3 before:w-0.5 before:bg-primary before:rounded-full'}"
          >
            <div class="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center {meta.bg} {meta.text}">
              <Papicon icon={meta.icon} size={14} />
            </div>

            <div class="min-w-0 flex-1">
              <div class="flex items-start justify-between gap-3">
                <h3 class="text-body-sm font-semibold text-on-surface leading-snug wrap-break-word">
                  {notif.title}
                  {#if notif.count > 1}
                    <span class="ml-1 text-2xs font-medium text-primary">{m.ntf_grouped({ count: notif.count })}</span>
                  {/if}
                </h3>
                <span class="text-2xs text-on-surface-variant whitespace-nowrap shrink-0 tabular-nums">{formatDate(notif.updatedAt)}</span>
              </div>

              <p class="mt-1 text-xs text-on-surface-variant leading-relaxed whitespace-pre-line wrap-break-word">{notif.message}</p>

              <div class="mt-2 flex flex-wrap items-center gap-1.5 text-2xs text-on-surface-variant">
                <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface-container">
                  <Papicon icon={cat.icon} size={10} />
                  {cat.label()}
                </span>
                <span class="px-1.5 py-0.5 rounded bg-surface-container truncate max-w-[14rem]">{notificationsStore.guildName(notif)}</span>
              </div>

              <div class="mt-2.5 flex flex-wrap items-center gap-2">
                {#each actions as action (action.label)}
                  <Button variant={action.variant} size="sm" icon={action.icon} loading={busy === notif.id} onclick={() => runQuickAction(notif, action)}>{action.label}</Button>
                {/each}
                {#if notif.link}
                  <Button size="sm" icon="external-link" onclick={() => notificationsStore.open(notif)}>{m.ntf_open()}</Button>
                {/if}
                <Button variant="ghost" size="sm" icon={notif.isRead ? 'mail' : 'check'} disabled={busy === notif.id} onclick={() => act(notif, () => notificationsStore.markAsRead(notif.id, !notif.isRead))}>{notif.isRead ? m.ntf_mark_unread() : m.ntf_mark_read()}</Button>
                <Button variant="ghost" size="sm" icon="archive" disabled={busy === notif.id} onclick={() => act(notif, () => notificationsStore.archive(notif.id, !notif.archivedAt))}>{notif.archivedAt ? m.ntf_unarchive() : m.ntf_archive()}</Button>
                <Button variant="ghost" size="sm" icon="trash-2" disabled={busy === notif.id} onclick={() => act(notif, () => notificationsStore.remove(notif.id))}>{m.ntf_delete()}</Button>
              </div>
            </div>
          </li>
        {/each}
      </ul>
      {#if nextCursor}
        <div class="p-4 flex justify-center">
          <Button size="sm" icon="chevron-down" loading={loadingMore} onclick={loadMore}>{m.ntf_load_more()}</Button>
        </div>
      {/if}
    {/if}
  </SectionCard>
</ModulePage>

<style>
  .ntf-toolbar {
    display: grid;
    gap: 0.75rem;
  }

  .ntf-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
  }

  .ntf-filters label {
    display: grid;
    gap: 0.3rem;
    min-width: 12rem;
    flex: 1 1 12rem;
    color: var(--on-surface-variant);
    font-size: 0.75rem;
    font-weight: 600;
  }

  .ntf-filters select {
    width: 100%;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--outline-variant);
    border-radius: 0.75rem;
    background: var(--surface-container-lowest);
    color: var(--on-surface);
  }
</style>
