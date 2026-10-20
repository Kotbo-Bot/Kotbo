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
  import { m } from '../i18n';

  let rows = $state<CategoryPrefs[]>([]);
  let saving = $state<string | null>(null);

  onMount(async () => {
    try {
      rows = await notificationsStore.fetchPreferences();
    } catch {
      toast.error(m.ntf_prefs_error());
    }
  });

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

<div class="p-4 rounded-lg bg-surface-container-high/20 border border-outline-variant/5 space-y-3">
  <div>
    <p class="text-sm font-bold">{m.ntf_prefs_title()}</p>
    <p class="text-2xs text-on-surface-variant">{m.ntf_prefs_desc()}</p>
  </div>

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
          <Papicon icon={meta.icon} size={13} />
          {meta.label()}
        </span>
        <span role="cell"><ToggleSwitch checked={row.dashboard} onToggle={(v: boolean) => update(row, { dashboard: v })} /></span>
        <span role="cell"><ToggleSwitch checked={row.dm} onToggle={(v: boolean) => update(row, { dm: v })} /></span>
        <span role="cell"><ToggleSwitch checked={row.digest} disabled={!row.dm} onToggle={(v: boolean) => update(row, { digest: v })} /></span>
      </div>
    {/each}
  </div>
  <p class="text-2xs text-on-surface-variant">{m.ntf_prefs_digest_hint()}</p>
</div>

<style>
  .ntf-grid {
    display: grid;
    gap: 0.25rem;
  }

  .ntf-grid__row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) repeat(3, 4.5rem);
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0;
  }

  .ntf-grid__row > span:not(.ntf-grid__label) {
    display: flex;
    justify-content: center;
  }

  .ntf-grid__head {
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--on-surface-variant);
    text-align: center;
  }

  .ntf-grid__label {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.875rem;
    min-width: 0;
  }

  @media (max-width: 480px) {
    .ntf-grid__row {
      grid-template-columns: minmax(0, 1fr) repeat(3, 3.25rem);
    }
  }
</style>
