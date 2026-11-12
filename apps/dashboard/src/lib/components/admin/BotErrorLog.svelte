<script lang="ts">
  /**
   * Journal des erreurs non rattrapées du bot.
   *
   * Une même panne se répète à chaque message : la liste brute des cinquante
   * dernières lignes la montrait cinquante fois et masquait les autres. Les
   * erreurs arrivent donc regroupées (même message, même source) ; un groupe se
   * déplie sur ses occurrences, pile d'appels comprise, chargées page par page.
   */
  import { onMount } from 'svelte';
  import { toast } from '../../stores/toast.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import {
    clearBotErrors,
    fetchBotErrorGroups,
    fetchBotErrorOccurrences,
    type BotErrorGroup,
    type BotErrorOccurrence,
  } from '../../api';
  import Papicon from '../Papicon.svelte';
  import AdminBadge from './AdminBadge.svelte';
  import { formatRelative } from '../staff/format';
  import { m } from '../../i18n';
  import { errorMessage } from '@kotbo/shared';

  let groups = $state<BotErrorGroup[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  /** Groupe déplié et ses occurrences déjà chargées. */
  let openId = $state<string | null>(null);
  let occurrences = $state<{ items: BotErrorOccurrence[]; nextCursor: string | null; loading: boolean }>({
    items: [],
    nextCursor: null,
    loading: false,
  });

  const total = $derived(groups.reduce((sum, group) => sum + group.count, 0));

  async function load() {
    loading = true;
    loadError = null;
    try {
      groups = (await fetchBotErrorGroups()).groups;
    } catch (err) {
      loadError = errorMessage(err);
    } finally {
      loading = false;
    }
  }

  async function loadOccurrences(groupId: string, cursor: string | null) {
    occurrences.loading = true;
    try {
      const page = await fetchBotErrorOccurrences(groupId, cursor);
      // Un autre groupe a pu être déplié pendant le chargement.
      if (openId !== groupId) return;
      occurrences.items = cursor ? [...occurrences.items, ...page.errors] : page.errors;
      occurrences.nextCursor = page.nextCursor;
    } catch (err) {
      if (openId === groupId) toast.error(errorMessage(err));
    } finally {
      if (openId === groupId) occurrences.loading = false;
    }
  }

  async function toggle(group: BotErrorGroup) {
    if (openId === group.id) {
      openId = null;
      return;
    }
    openId = group.id;
    occurrences = { items: [], nextCursor: null, loading: false };
    await loadOccurrences(group.id, null);
  }

  async function purge(group?: BotErrorGroup) {
    const question = group
      ? `Purger les ${group.count} erreurs de ce groupe ?`
      : m.d7_purge_logs_confirm();
    if (!(await confirmDialog.danger(question, '', m.d7_purge()))) return;
    try {
      await clearBotErrors(group?.id);
      groups = group ? groups.filter((entry) => entry.id !== group.id) : [];
      if (!group || openId === group.id) openId = null;
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  function formatFull(iso: string): string {
    return new Date(iso).toLocaleString('fr-FR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  onMount(load);
</script>

<section class="space-y-4" aria-labelledby="bot-error-log-title">
  <div class="flex flex-wrap items-center justify-between gap-3 px-2">
    <div>
      <h2 id="bot-error-log-title" class="text-xl font-semibold font-headline flex items-center gap-3">
        <Papicon icon="Terminal" size={24} class="text-error" />
        {m.d7_error_stream()}
      </h2>
      {#if !loading && !loadError}
        <p class="text-body-sm text-on-surface-variant mt-1">
          {groups.length} groupe{groups.length > 1 ? 's' : ''}, {total} erreur{total > 1 ? 's' : ''}
        </p>
      {/if}
    </div>
    <div class="flex items-center gap-2">
      <button
        type="button"
        onclick={load}
        disabled={loading}
        class="px-3 py-2 rounded-lg text-body-sm font-semibold bg-surface-variant/60 hover:bg-surface-variant disabled:opacity-50 flex items-center gap-1.5"
      >
        <Papicon icon="RefreshCw" size={14} /> Actualiser
      </button>
      <button
        type="button"
        onclick={() => purge()}
        disabled={loading || groups.length === 0}
        class="px-3 py-2 rounded-lg text-body-sm font-semibold text-error bg-error/10 hover:bg-error/15 disabled:opacity-50 flex items-center gap-1.5"
      >
        <Papicon icon="Trash" size={14} /> Tout purger
      </button>
    </div>
  </div>

  <div class="premium-card rounded-[2.25rem] p-3 sm:p-4">
    {#if loading}
      <div class="animate-pulse space-y-3 p-2" aria-busy="true">
        <div class="h-14 bg-surface/40 rounded-xl"></div>
        <div class="h-14 bg-surface/40 rounded-xl"></div>
        <div class="h-14 bg-surface/40 rounded-xl"></div>
      </div>
    {:else if loadError}
      <p class="p-6 text-center text-error" role="alert">{loadError}</p>
    {:else if groups.length === 0}
      <p class="p-6 text-center text-success/80 italic">{m.d7_no_errors_detected()}</p>
    {:else}
      <ul class="divide-y divide-outline-variant/30">
        {#each groups as group (group.id)}
          {@const open = openId === group.id}
          <li class="py-1">
            <div class="flex items-start gap-2">
              <button
                type="button"
                onclick={() => toggle(group)}
                aria-expanded={open}
                aria-controls={open ? `bot-error-${group.id}` : undefined}
                class="flex-1 min-w-0 text-left rounded-xl px-3 py-2.5 hover:bg-surface-variant/40 flex items-start gap-3"
              >
                <Papicon icon={open ? 'ChevronDown' : 'ChevronRight'} size={16} class="mt-0.5 shrink-0 text-on-surface-variant" />
                <span class="min-w-0 flex-1 space-y-1">
                  <span class="block font-mono text-body-sm text-error line-clamp-2 wrap-break-word">{group.message}</span>
                  <span class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-on-surface-variant">
                    <span class="text-warning">{group.source || m.d7_unknown()}</span>
                    <span>dernière {formatRelative(group.lastAt)}</span>
                    {#if group.count > 1}<span>première {formatRelative(group.firstAt)}</span>{/if}
                  </span>
                </span>
                <AdminBadge label={`× ${group.count}`} tone={group.count >= 10 ? 'danger' : 'warning'} size="sm" />
              </button>
              <button
                type="button"
                onclick={() => purge(group)}
                class="mt-1.5 p-2 rounded-lg text-on-surface-variant hover:text-error hover:bg-error/10"
                aria-label="Purger ce groupe d'erreurs"
                title="Purger ce groupe"
              >
                <Papicon icon="Trash" size={14} />
              </button>
            </div>

            {#if open}
              <div id={`bot-error-${group.id}`} class="ml-9 mr-2 mb-3 space-y-3">
                {#each occurrences.items as occurrence (occurrence.id)}
                  <div class="rounded-xl bg-[#0d1117] border border-white/5 p-3">
                    <p class="text-xs text-white/50 mb-2">{formatFull(occurrence.createdAt)}</p>
                    <pre class="font-mono text-xs text-white/80 whitespace-pre-wrap wrap-break-word max-h-64 overflow-y-auto">{occurrence.stack || occurrence.message}</pre>
                  </div>
                {/each}
                {#if occurrences.loading}
                  <p class="text-xs text-on-surface-variant" aria-live="polite">Chargement…</p>
                {:else if occurrences.nextCursor}
                  <button
                    type="button"
                    onclick={() => loadOccurrences(group.id, occurrences.nextCursor)}
                    class="text-body-sm font-semibold text-primary hover:underline"
                  >
                    Charger les occurrences plus anciennes
                  </button>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>
