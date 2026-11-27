<script lang="ts">
  /**
   * Grille « famille × canal » des notifications, enregistrée côté serveur :
   * elle vaut pour la boîte du dashboard comme pour les MP du bot, sur tous
   * les serveurs. Le résumé du jour remplace les MP de la famille.
   */
  import { onMount } from 'svelte';
  import { notificationsStore, type CategoryPrefs } from '../stores/notifications.svelte';
  import { toast } from '../stores/toast.svelte';
  import { categoryMeta } from '../notificationUi';
  import ToggleSwitch from './ToggleSwitch.svelte';
  import Papicon from './Papicon.svelte';
  import Button from './ui/Button.svelte';
  import Skeleton from './Skeleton.svelte';
  import { m } from '../i18n';

  let rows = $state<CategoryPrefs[]>([]);
  let loading = $state(true);
  let loadError = $state(false);
  let saving = $state<string | null>(null);

  async function loadPreferences() {
    loading = true;
    loadError = false;
    try {
      rows = await notificationsStore.fetchPreferences();
    } catch {
      loadError = true;
      toast.error(m.ntf_prefs_error());
    } finally {
      loading = false;
    }
  }

  onMount(loadPreferences);

  async function update(row: CategoryPrefs, patch: Partial<CategoryPrefs>) {
    const previous = { ...row };
    const next = { ...row, ...patch };
    if (!next.dm) next.digest = false;
    Object.assign(row, next);
    saving = row.category;
    const saved = await notificationsStore.savePreference(next);
    saving = null;
    if (saved) Object.assign(row, saved);
    else {
      Object.assign(row, previous);
      toast.error(m.ntf_prefs_error());
    }
  }
</script>

<div class="px-4 py-3.5 space-y-3">
  <div>
    <p class="text-sm font-medium text-on-surface">{m.ntf_prefs_title()}</p>
    <p class="text-xs text-on-surface-variant mt-0.5">{m.ntf_prefs_desc()}</p>
  </div>

  {#if loading}
    <div class="space-y-2 py-1" aria-busy="true">
      {#each Array(3) as _}
        <Skeleton class="h-8 w-full rounded-lg" />
      {/each}
    </div>
  {:else if loadError}
    <div class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-error/25 bg-error-container/30 px-3 py-2.5 text-xs text-on-error-container">
      <span>{m.ntf_prefs_error()}</span>
      <Button variant="secondary" size="sm" icon="refresh-cw" onclick={loadPreferences}>
        {m.common_retry()}
      </Button>
    </div>
  {:else if rows.length === 0}
    <p class="text-xs text-on-surface-variant py-1">{m.ntf_empty_title()}</p>
  {:else}
    <div class="ntf-grid" role="table" aria-label={m.ntf_prefs_title()}>
      <div class="ntf-grid__row ntf-grid__head" role="row">
        <span role="columnheader"></span>
        <span role="columnheader">{m.ntf_prefs_dashboard()}</span>
        <span role="columnheader">{m.ntf_prefs_dm()}</span>
        <span role="columnheader" title={m.ntf_prefs_digest_hint()}>{m.ntf_prefs_digest()}</span>
      </div>
      {#each rows as row (row.category)}
        {@const meta = categoryMeta(row.category)}
        <div class="ntf-grid__row" role="row" aria-busy={saving === row.category}>
          <span class="ntf-grid__label" role="rowheader">
            <Papicon icon={meta.icon} size={14} class="text-on-surface-variant shrink-0" />
            <span class="truncate">{meta.label()}</span>
          </span>
          <span role="cell"><ToggleSwitch checked={row.dashboard} onToggle={(v: boolean) => update(row, { dashboard: v })} /></span>
          <span role="cell"><ToggleSwitch checked={row.dm} onToggle={(v: boolean) => update(row, { dm: v })} /></span>
          <span role="cell"><ToggleSwitch checked={row.digest} disabled={!row.dm} onToggle={(v: boolean) => update(row, { digest: v })} /></span>
        </div>
      {/each}
    </div>
    <p class="text-2xs text-on-surface-variant">{m.ntf_prefs_digest_hint()}</p>
  {/if}
</div>

<style>
  .ntf-grid {
    display: grid;
    gap: 0.125rem;
  }

  .ntf-grid__row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) repeat(3, 4.5rem);
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0;
  }

  .ntf-grid__row + .ntf-grid__row {
    border-top: 1px solid var(--outline-variant);
  }

  .ntf-grid__row > span:not(.ntf-grid__label) {
    display: flex;
    justify-content: center;
  }

  .ntf-grid__head {
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--on-surface-variant);
    text-align: center;
  }

  .ntf-grid__label {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    color: var(--on-surface);
    min-width: 0;
  }

  @media (max-width: 480px) {
    .ntf-grid__row {
      grid-template-columns: minmax(0, 1fr) repeat(3, 3.25rem);
    }
  }
</style>
