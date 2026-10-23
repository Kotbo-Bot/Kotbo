<script lang="ts">
  import { explainDisabled } from '../../actions/explainDisabled';
  import { untrack } from 'svelte';
  import { fade, scale } from 'svelte/transition';
  import Papicon from '../Papicon.svelte';
  import { m, dateLocale } from '../../i18n';
  import {
    previewClanRebalance,
    runClanRebalance,
    type ClanEntry,
    type ClanRebalanceMember,
    type ClanRebalancePreview,
    type ClanRebalanceExclusion,
    type ClanRebalanceMode,
  } from '../../api';

  const {
    clans,
    onclose,
    onlaunched,
  }: {
    clans: ClanEntry[];
    onclose: () => void;
    onlaunched: (message: string) => void;
  } = $props();

  // Les clans nettement sous la moyenne sont presque toujours ceux qu'on vient de créer :
  // on les propose d'office, l'administrateur corrige s'il le faut.
  //
  // `untrack` dit ce que ces deux lignes font vraiment : elles prennent la
  // valeur d'ouverture de la modale, et rien d'autre. Sans lui, le compilateur
  // Svelte y voyait une lecture reactive incomplete et refusait de compiler.
  // Les recalculer a chaque changement de `clans` serait pire : la selection
  // que l'administrateur vient de corriger serait effacee sous ses yeux.
  const average = untrack(() =>
    clans.length > 0 ? clans.reduce((sum, clan) => sum + clan.memberCount, 0) / clans.length : 0,
  );
  let targetClanIds = $state<string[]>(
    untrack(() => clans.filter((clan) => clan.memberCount < average / 2).map((clan) => clan.id)),
  );
  let targetSizeInput = $state<number | null>(null);
  let protectAboveInput = $state<number | null>(null);
  let excludedKeys = $state<string[]>([]);
  let mode = $state<ClanRebalanceMode>('least_active');
  let seed = $state(newSeed());

  const modes: Array<{ id: ClanRebalanceMode; label: () => string; hint: () => string }> = [
    { id: 'least_active', label: () => m.clan_rebalance_mode_least(), hint: () => m.clan_rebalance_mode_least_hint() },
    { id: 'random', label: () => m.clan_rebalance_mode_random(), hint: () => m.clan_rebalance_mode_random_hint() },
    { id: 'most_active', label: () => m.clan_rebalance_mode_most(), hint: () => m.clan_rebalance_mode_most_hint() },
  ];

  function newSeed(): number {
    return Math.floor(Math.random() * 2_147_483_647);
  }

  let preview = $state<ClanRebalancePreview | null>(null);
  let loadingPreview = $state(false);
  let launching = $state(false);
  let error = $state('');
  let confirmInput = $state('');

  const clanName = (id: string) => clans.find((clan) => clan.id === id)?.name ?? '?';
  const confirmWord = $derived(m.clan_rebalance_confirm_word());
  const canLaunch = $derived(
    !!preview && preview.moves.length > 0 && !launching && !loadingPreview
      && confirmInput.trim().toUpperCase() === confirmWord.toUpperCase(),
  );

  function parseOptionalInt(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
  }

  // Une réponse d'aperçu peut arriver après un changement de réglage : sans ce compteur,
  // elle réafficherait un plan calculé avec les anciens réglages, et c'est lui qui serait lancé.
  let previewRequest = 0;

  function currentOptions() {
    return {
      targetClanIds,
      targetSize: parseOptionalInt(targetSizeInput),
      protectAbove: parseOptionalInt(protectAboveInput),
      excludedKeys,
      mode,
      seed,
    };
  }

  // Tout réglage modifié rend l'aperçu obsolète : on le retire pour ne jamais lancer
  // autre chose que ce qui est affiché.
  function invalidate() {
    previewRequest++;
    loadingPreview = false;
    preview = null;
    confirmInput = '';
  }

  function toggleTarget(id: string) {
    targetClanIds = targetClanIds.includes(id) ? targetClanIds.filter((entry) => entry !== id) : [...targetClanIds, id];
    excludedKeys = [];
    invalidate();
  }

  function selectMode(next: ClanRebalanceMode) {
    if (mode === next) return;
    mode = next;
    excludedKeys = [];
    invalidate();
  }

  async function redraw() {
    seed = newSeed();
    excludedKeys = [];
    await computePreview();
  }

  async function computePreview() {
    if (targetClanIds.length === 0) {
      error = m.clan_rebalance_err_no_target();
      return;
    }
    const request = ++previewRequest;
    loadingPreview = true;
    error = '';
    try {
      const result = await previewClanRebalance(currentOptions());
      if (request !== previewRequest) return;
      preview = result;
      confirmInput = '';
    } catch (err) {
      if (request !== previewRequest) return;
      preview = null;
      error = err instanceof Error && err.message ? err.message : m.clan_rebalance_err_preview();
    } finally {
      if (request === previewRequest) loadingPreview = false;
    }
  }

  async function setExcluded(key: string, excluded: boolean) {
    excludedKeys = excluded ? [...excludedKeys, key] : excludedKeys.filter((entry) => entry !== key);
    await computePreview();
  }

  async function launch() {
    if (!preview || !canLaunch) return;
    launching = true;
    error = '';
    try {
      const res = await runClanRebalance({
        ...currentOptions(),
        moves: preview.moves.map((move) => ({ key: move.key, fromClanId: move.clanId, toClanId: move.toClanId })),
      });
      if (!res) throw new Error(m.clan_rebalance_err_run());
      onlaunched(res.message);
    } catch (err) {
      error = err instanceof Error && err.message ? err.message : m.clan_rebalance_err_run();
    } finally {
      launching = false;
    }
  }

  function basisLabel(member: ClanRebalanceMember): string {
    if (member.basis === 'previous') return m.clan_rebalance_basis_previous({ season: preview?.referenceSeason ?? '' });
    if (member.basis === 'current') return m.clan_rebalance_basis_current();
    return m.clan_rebalance_basis_none();
  }

  function exclusionLabel(reason: ClanRebalanceExclusion): string {
    switch (reason) {
      case 'leader': return m.clan_rebalance_excl_leader();
      case 'open_bet': return m.clan_rebalance_excl_open_bet();
      case 'protected': return m.clan_rebalance_excl_protected();
      case 'excluded': return m.clan_rebalance_excl_manual();
      case 'split_accounts': return m.clan_rebalance_excl_split();
      case 'multi_clan': return m.clan_rebalance_excl_multi();
    }
  }

  const formatNumber = (value: number) => value.toLocaleString(dateLocale());
</script>

<div class="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" transition:fade={{ duration: 150 }}>
  <div
    class="bg-surface-container-low border border-outline-variant/20 max-w-3xl w-full max-h-[90vh] overflow-y-auto rounded-xl p-6 space-y-6 shadow-lg relative"
    transition:scale={{ start: 0.97, duration: 150 }}
  >
    <button
      onclick={onclose}
      class="absolute top-6 right-6 p-2 rounded-full bg-surface-container-high/40 hover:bg-error/15 hover:text-error text-on-surface-variant transition-colors cursor-pointer"
    >
      <Papicon icon="Cross" size={18} />
    </button>

    <div class="pr-12">
      <h3 class="text-lg font-semibold flex items-center gap-2">
        <Papicon icon="ArrowLeftRight" size={18} /> {m.clan_rebalance_title()}
      </h3>
      <p class="text-xs text-on-surface-variant/80 mt-1">{m.clan_rebalance_desc()}</p>
    </div>

    <!-- 1. Réglages -->
    <section class="space-y-4">
      <div class="space-y-2">
        <p class="text-xs font-semibold text-on-surface-variant ml-1">{m.clan_rebalance_mode_label()}</p>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {#each modes as option (option.id)}
            <button
              type="button"
              onclick={() => selectMode(option.id)}
              class="text-left px-3 py-2 rounded-lg border transition-colors cursor-pointer {mode === option.id
                ? 'border-secondary/60 bg-secondary/10'
                : 'border-outline-variant/15 bg-surface-container-high/30 hover:bg-surface-container-high/60'}"
            >
              <span class="block text-sm font-semibold {mode === option.id ? 'text-secondary' : 'text-on-surface'}">{option.label()}</span>
              <span class="block text-2xs text-on-surface-variant mt-0.5">{option.hint()}</span>
            </button>
          {/each}
        </div>
        {#if mode === 'most_active'}
          <p class="text-2xs font-semibold text-warning bg-warning/10 border border-warning/20 rounded-lg px-3 py-2 flex items-start gap-2">
            <Papicon icon="AlertTriangle" size={13} /> <span>{m.clan_rebalance_mode_most_warning()}</span>
          </p>
        {/if}
      </div>

      <div class="space-y-2">
        <p class="text-xs font-semibold text-on-surface-variant ml-1">{m.clan_rebalance_targets_label()}</p>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {#each clans as clan (clan.id)}
            <label class="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-outline-variant/15 bg-surface-container-high/30 cursor-pointer hover:bg-surface-container-high/60 transition-colors">
              <span class="flex items-center gap-2 text-sm text-on-surface min-w-0">
                <input
                  type="checkbox"
                  checked={targetClanIds.includes(clan.id)}
                  onchange={() => toggleTarget(clan.id)}
                  class="w-4 h-4 accent-primary cursor-pointer shrink-0"
                />
                <span class="truncate">{clan.name}</span>
              </span>
              <span class="text-xs text-on-surface-variant shrink-0">{m.clan_rebalance_members_count({ count: clan.memberCount })}</span>
            </label>
          {/each}
        </div>
        <p class="text-2xs text-on-surface-variant ml-1">{m.clan_rebalance_targets_hint()}</p>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div class="space-y-1.5">
          <label for="rebalance-size" class="text-xs font-semibold text-on-surface-variant ml-1">{m.clan_rebalance_size_label()}</label>
          <input
            id="rebalance-size"
            type="number"
            min="1"
            bind:value={targetSizeInput}
            oninput={invalidate}
            placeholder={preview ? String(preview.defaultTargetSize) : m.clan_rebalance_size_auto()}
            class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
          />
          <p class="text-2xs text-on-surface-variant ml-1">{m.clan_rebalance_size_hint()}</p>
        </div>
        <div class="space-y-1.5">
          <label for="rebalance-protect" class="text-xs font-semibold text-on-surface-variant ml-1">{m.clan_rebalance_protect_label()}</label>
          <input
            id="rebalance-protect"
            type="number"
            min="0"
            bind:value={protectAboveInput}
            oninput={invalidate}
            placeholder={m.clan_rebalance_protect_placeholder()}
            class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
          />
          <p class="text-2xs text-on-surface-variant ml-1">{m.clan_rebalance_protect_hint()}</p>
        </div>
      </div>

      <div class="flex justify-end gap-2">
        {#if mode === 'random' && preview}
          <button
            type="button"
            onclick={redraw}
            disabled={loadingPreview}
            class="flex items-center gap-1.5 px-4 py-2 border border-outline-variant/30 hover:bg-surface-container-high/60 text-on-surface-variant text-xs font-bold rounded-lg transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Papicon icon="RotateCcw" size={12} /> {m.clan_rebalance_redraw_btn()}
          </button>
        {/if}
        <button
          type="button"
          onclick={computePreview}
          disabled={loadingPreview}
          use:explainDisabled={(targetClanIds.length === 0) ? m.common_reason_select_one() : ''}
          class="flex items-center gap-1.5 px-4 py-2 bg-secondary/15 hover:bg-secondary/25 text-secondary text-xs font-bold rounded-lg transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Papicon icon="Refresh" size={12} /> {loadingPreview ? m.clan_rebalance_computing() : m.clan_rebalance_preview_btn()}
        </button>
      </div>
    </section>

    {#if error}
      <p class="text-xs font-semibold text-error bg-error/10 border border-error/20 rounded-lg px-3 py-2">{error}</p>
    {/if}

    <!-- 2. Aperçu -->
    {#if preview}
      <section class="space-y-4 border-t border-outline-variant/15 pt-5">
        <p class="text-xs text-on-surface-variant/80 flex items-start gap-2">
          <Papicon icon="Info" size={14} />
          <span>
            {preview.mode === 'random'
              ? m.clan_rebalance_reference_random()
              : preview.referenceSeason
              ? m.clan_rebalance_reference_previous({ season: preview.referenceSeason })
              : m.clan_rebalance_reference_current()}
          </span>
        </p>

        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm border-collapse">
            <thead>
              <tr class="text-xs text-on-surface-variant">
                <th class="py-1.5 font-bold">{m.clan_rebalance_col_clan()}</th>
                <th class="py-1.5 font-bold text-right">{m.clan_rebalance_col_before()}</th>
                <th class="py-1.5 font-bold text-right">{m.clan_rebalance_col_after()}</th>
              </tr>
            </thead>
            <tbody>
              {#each preview.clans as clan (clan.id)}
                <tr class="border-t border-outline-variant/10">
                  <td class="py-1.5">
                    {clan.name}
                    {#if clan.isTarget}
                      <span class="ml-1.5 text-xs font-semibold text-secondary">{m.clan_rebalance_target_tag()}</span>
                    {/if}
                  </td>
                  <td class="py-1.5 text-right tabular-nums">{clan.before}</td>
                  <td class="py-1.5 text-right tabular-nums font-semibold {clan.after > clan.before ? 'text-secondary' : clan.after < clan.before ? 'text-warning' : ''}">{clan.after}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>

        {#if Object.keys(preview.exclusionCounts).length > 0}
          <div class="flex flex-wrap gap-1.5">
            {#each Object.entries(preview.exclusionCounts) as [reason, count] (reason)}
              <span class="text-2xs px-2 py-1 rounded-md bg-surface-container-high/50 text-on-surface-variant">
                {exclusionLabel(reason as ClanRebalanceExclusion)} : {count}
              </span>
            {/each}
          </div>
        {/if}

        {#if preview.moves.length === 0}
          <p class="text-sm text-on-surface-variant text-center py-4">{m.clan_rebalance_no_moves()}</p>
        {:else}
          <div class="space-y-1.5">
            <p class="text-xs font-semibold text-on-surface-variant ml-1">
              {m.clan_rebalance_moves_heading({ count: preview.moves.length })}
            </p>
            <ul class="divide-y divide-outline-variant/10 border border-outline-variant/15 rounded-lg max-h-72 overflow-y-auto">
              {#each preview.moves as move (move.key)}
                <li class="flex items-center gap-3 px-3 py-2">
                  {#if move.avatarUrl}
                    <img src={move.avatarUrl} alt="" class="w-7 h-7 rounded-full shrink-0" />
                  {/if}
                  <div class="min-w-0 flex-1">
                    <p class="text-sm font-medium text-on-surface truncate">
                      {move.displayName}
                      {#if move.userIds.length > 1}
                        <span class="text-2xs text-on-surface-variant">{m.clan_rebalance_linked_accounts({ count: move.userIds.length })}</span>
                      {/if}
                    </p>
                    <p class="text-2xs text-on-surface-variant flex items-center gap-1">
                      {clanName(move.clanId)} <Papicon icon="ArrowRight" size={10} /> <span class="text-secondary font-semibold">{clanName(move.toClanId)}</span>
                    </p>
                  </div>
                  <div class="text-right shrink-0">
                    <p class="text-xs font-semibold tabular-nums">{m.clan_rebalance_points({ points: formatNumber(move.points), days: move.presenceDays })}</p>
                    <p class="text-2xs text-on-surface-variant">{basisLabel(move)}</p>
                  </div>
                  <button
                    type="button"
                    onclick={() => setExcluded(move.key, true)}
                    disabled={loadingPreview}
                    class="px-2 py-1 text-2xs font-semibold border border-outline-variant/30 hover:bg-error/10 hover:text-error rounded-md transition-colors cursor-pointer disabled:opacity-40 shrink-0"
                    title={m.clan_rebalance_exclude_title()}
                  >
                    {m.clan_rebalance_exclude_btn()}
                  </button>
                </li>
              {/each}
            </ul>
          </div>
        {/if}

        {#if preview.excludedMembers.length > 0}
          <div class="space-y-1.5">
            <p class="text-xs font-semibold text-on-surface-variant ml-1">{m.clan_rebalance_excluded_heading()}</p>
            <div class="flex flex-wrap gap-1.5">
              {#each preview.excludedMembers as member (member.key)}
                <button
                  type="button"
                  onclick={() => setExcluded(member.key, false)}
                  disabled={loadingPreview}
                  class="flex items-center gap-1 text-2xs px-2 py-1 rounded-md border border-outline-variant/30 hover:bg-surface-container-high/60 transition-colors cursor-pointer disabled:opacity-40"
                  title={m.clan_rebalance_include_title()}
                >
                  <Papicon icon="Add" size={10} /> {member.displayName}
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </section>

      <!-- 3. Vérification -->
      {#if preview.moves.length > 0}
        <section class="space-y-3 border-t border-outline-variant/15 pt-5">
          <p class="text-xs text-on-surface-variant/80">{m.clan_rebalance_confirm_desc({ count: preview.moves.length })}</p>
          <div class="space-y-1.5">
            <label for="rebalance-confirm" class="text-xs font-semibold text-on-surface-variant ml-1">
              {m.clan_type_to_confirm_label({ word: confirmWord })}
            </label>
            <input
              id="rebalance-confirm"
              type="text"
              bind:value={confirmInput}
              placeholder={confirmWord}
              class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none font-semibold"
            />
          </div>
        </section>
      {/if}
    {/if}

    <div class="flex justify-end gap-2">
      <button
        type="button"
        onclick={onclose}
        class="px-4 py-2 border border-outline-variant/30 hover:bg-surface-container-high/60 text-on-surface text-xs font-semibold rounded-lg transition-colors cursor-pointer"
      >
        {m.clan_cancel_btn()}
      </button>
      <button
        type="button"
        onclick={launch}
        disabled={!canLaunch}
        class="px-4 py-2 bg-rose-500 text-white text-xs font-semibold rounded-lg hover:bg-rose-600 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {launching ? m.clan_rebalance_launching() : m.clan_rebalance_launch_btn()}
      </button>
    </div>
  </div>
</div>
