<!--
  Tests A/B de l'accueil.

  Plusieurs versions du message de bienvenue (et du fil d'accueil) réparties
  au hasard entre les arrivants, puis comparées sur ce qui compte pour un
  serveur : qui reste, et qui se met à parler. La lecture reprend celle des
  outils d'expérimentation (GrowthBook, Statsig) : un taux par version, l'écart
  au contrôle, et la chance de faire mieux, avec une recommandation en clair.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import Skeleton from '../Skeleton.svelte';
  import { Button, Callout, EmptyState, Field, Modal, SectionCard } from '../ui';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { m, dateLocale } from '../../i18n';
  import {
    createWelcomeExperiment,
    deleteWelcomeExperiment,
    fetchWelcomeExperimentResults,
    fetchWelcomeExperiments,
    shipWelcomeVariant,
    startWelcomeExperiment,
    stopWelcomeExperiment,
    updateWelcomeExperiment,
    type ExperimentMetric,
    type ExperimentResults,
    type WelcomeExperiment,
    type WelcomeExperimentList,
  } from '../../api';

  let data = $state<WelcomeExperimentList | null>(null);
  let loading = $state(true);

  async function load() {
    loading = true;
    try {
      data = await fetchWelcomeExperiments();
    } catch {
      toast.error(m.wx_load_error());
    } finally {
      loading = false;
    }
  }
  onMount(load);

  const METRIC_LABEL: Record<ExperimentMetric, () => string> = {
    retained_d1: () => m.wx_metric_d1(),
    retained_d7: () => m.wx_metric_d7(),
    retained_d30: () => m.wx_metric_d30(),
    activated_d7: () => m.wx_metric_activated(),
  };
  const METRICS: ExperimentMetric[] = ['retained_d7', 'activated_d7', 'retained_d1', 'retained_d30'];

  const running = $derived(data?.experiments.find((experiment) => experiment.status === 'RUNNING') ?? null);

  function statusLabel(experiment: WelcomeExperiment): { label: string; tone: string } {
    if (experiment.status === 'RUNNING') return { label: m.wx_status_running({ date: formatDate(experiment.startedAt) }), tone: 'bg-success/10 text-success' };
    if (experiment.status === 'STOPPED') {
      const winner = experiment.variants.find((variant) => variant.key === experiment.winnerKey);
      return winner
        ? { label: m.wx_status_shipped({ name: winner.name }), tone: 'bg-primary/10 text-primary' }
        : { label: m.wx_status_stopped(), tone: 'bg-surface-container text-on-surface-variant' };
    }
    return { label: m.wx_status_draft(), tone: 'bg-warning/10 text-warning' };
  }

  const formatDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' }) : '—');
  const totalAssigned = (experiment: WelcomeExperiment) => Object.values(experiment.assigned).reduce((sum, count) => sum + count, 0);

  // ── Éditeur ────────────────────────────────────────────
  type DraftVariant = { name: string; weight: number; message: string; image: 'inherit' | 'on' | 'off'; thread: 'inherit' | 'off' };
  let editorOpen = $state(false);
  let editingId = $state<string | null>(null);
  let draftName = $state('');
  let draftHypothesis = $state('');
  let draftMetric = $state<ExperimentMetric>('retained_d7');
  let draftVariants = $state<DraftVariant[]>([]);
  let saving = $state(false);
  let editorError = $state('');

  const emptyVariant = (name: string): DraftVariant => ({ name, weight: 50, message: '', image: 'inherit', thread: 'inherit' });

  function openCreate() {
    editingId = null;
    draftName = '';
    draftHypothesis = '';
    draftMetric = 'retained_d7';
    draftVariants = [emptyVariant(m.wx_control_name()), { ...emptyVariant(m.wx_variant_name({ key: 'B' })), message: data?.welcome.welcomeMessage ?? '' }];
    editorError = '';
    editorOpen = true;
  }

  function openEdit(experiment: WelcomeExperiment) {
    editingId = experiment.id;
    draftName = experiment.name;
    draftHypothesis = experiment.hypothesis ?? '';
    draftMetric = experiment.primaryMetric;
    draftVariants = experiment.variants.map((variant) => ({
      name: variant.name,
      weight: variant.weight,
      message: variant.message ?? '',
      image: variant.imageEnabled === null ? 'inherit' : variant.imageEnabled ? 'on' : 'off',
      thread: variant.threadEnabled === false ? 'off' : 'inherit',
    }));
    editorError = '';
    editorOpen = true;
  }

  const keyOf = (index: number) => 'ABCD'[index];
  const weightTotal = $derived(draftVariants.reduce((sum, variant) => sum + (Number(variant.weight) || 0), 0));

  async function saveDraft(event: SubmitEvent) {
    event.preventDefault();
    editorError = '';
    if (!draftName.trim()) return void (editorError = m.wx_error_name());
    const payload = {
      name: draftName.trim(),
      hypothesis: draftHypothesis.trim() || null,
      primaryMetric: draftMetric,
      variants: draftVariants.map((variant) => ({
        name: variant.name,
        weight: Number(variant.weight) || 1,
        message: variant.message.trim() || null,
        imageEnabled: variant.image === 'inherit' ? null : variant.image === 'on',
        threadEnabled: variant.thread === 'off' ? false : null,
      })),
    };
    saving = true;
    try {
      if (editingId) await updateWelcomeExperiment(editingId, payload);
      else await createWelcomeExperiment(payload);
      editorOpen = false;
      toast.success(m.wx_saved());
      await load();
    } catch (err) {
      editorError = err instanceof Error ? err.message : m.wx_save_error();
    } finally {
      saving = false;
    }
  }

  // ── Actions ────────────────────────────────────────────
  async function act(fn: () => Promise<unknown>, success: string) {
    try {
      await fn();
      toast.success(success);
      await load();
      if (selected) void loadResults(selected.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.wx_save_error());
    }
  }

  async function start(experiment: WelcomeExperiment) {
    const ok = await confirmDialog.ask({ title: m.wx_start_title(), description: m.wx_start_desc(), confirmLabel: m.wx_start() });
    if (ok) await act(() => startWelcomeExperiment(experiment.id), m.wx_started());
  }

  async function stop(experiment: WelcomeExperiment) {
    const ok = await confirmDialog.ask({ title: m.wx_stop_title(), description: m.wx_stop_desc(), confirmLabel: m.wx_stop(), variant: 'warning' });
    if (ok) await act(() => stopWelcomeExperiment(experiment.id), m.wx_stopped());
  }

  async function remove(experiment: WelcomeExperiment) {
    if (!(await confirmDialog.danger(m.wx_delete_title({ name: experiment.name }), m.wx_delete_desc()))) return;
    if (selected?.id === experiment.id) selected = null;
    await act(() => deleteWelcomeExperiment(experiment.id), m.wx_deleted());
  }

  async function ship(experiment: WelcomeExperiment, key: string) {
    const variant = experiment.variants.find((item) => item.key === key);
    if (!variant) return;
    const ok = await confirmDialog.ask({ title: m.wx_ship_title({ name: variant.name }), description: m.wx_ship_desc(), confirmLabel: m.wx_ship() });
    if (ok) await act(() => shipWelcomeVariant(experiment.id, key), m.wx_shipped());
  }

  // ── Résultats ──────────────────────────────────────────
  let selected = $state<WelcomeExperiment | null>(null);
  let results = $state<ExperimentResults | null>(null);
  let resultsLoading = $state(false);

  async function loadResults(id: string) {
    resultsLoading = true;
    try {
      results = await fetchWelcomeExperimentResults(id);
    } catch {
      results = null;
      toast.error(m.wx_results_error());
    } finally {
      resultsLoading = false;
    }
  }

  function openResults(experiment: WelcomeExperiment) {
    selected = experiment;
    results = null;
    void loadResults(experiment.id);
  }

  const pct = (value: number | null, digits = 1) => (value === null ? '—' : `${(value * 100).toLocaleString(dateLocale(), { maximumFractionDigits: digits })} %`);
  const signed = (value: number | null) => (value === null ? '' : `${value > 0 ? '+' : ''}${(value * 100).toLocaleString(dateLocale(), { maximumFractionDigits: 1 })} %`);

  const recommendation = $derived.by(() => {
    if (!results || !selected) return null;
    const rec = results.recommendation;
    const winner = results.variants.find((variant) => variant.key === rec.winnerKey);
    const metric = METRIC_LABEL[results.primaryMetric]();
    if (rec.status === 'winner' && winner) {
      const vs = winner.metrics[results.primaryMetric].vsControl;
      return { tone: 'success' as const, title: m.wx_rec_winner_title({ name: winner.name }), body: m.wx_rec_winner_body({ uplift: signed(vs?.uplift ?? null), metric, chance: pct(vs?.chanceToBeat ?? null, 0) }), shipKey: winner.key };
    }
    if (rec.status === 'control_wins') return { tone: 'info' as const, title: m.wx_rec_control_title(), body: m.wx_rec_control_body({ metric }), shipKey: null };
    if (rec.status === 'no_difference') return { tone: 'info' as const, title: m.wx_rec_none_title(), body: m.wx_rec_none_body(), shipKey: null };
    const measured = Math.min(...results.variants.map((variant) => variant.metrics[results!.primaryMetric].eligible));
    return {
      tone: 'info' as const,
      title: m.wx_rec_collecting_title(),
      body: rec.neededPerVariant ? m.wx_rec_collecting_body({ current: measured, needed: rec.neededPerVariant, metric }) : m.wx_rec_collecting_early({ metric }),
      shipKey: null,
    };
  });
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="max-w-2xl">
      <h3 class="text-base font-semibold text-on-surface">{m.wx_title()}</h3>
      <p class="text-body-sm text-on-surface-variant mt-0.5">{m.wx_intro()}</p>
    </div>
    {#if data?.canEdit}
      <Button variant="primary" icon="plus" onclick={openCreate}>{m.wx_new()}</Button>
    {/if}
  </div>

  {#if data && (!data.welcome.welcomeEnabled || !data.welcome.welcomeChannelId)}
    <Callout variant="warning">{m.wx_welcome_off()}</Callout>
  {/if}

  {#if loading && !data}
    <Skeleton height="h-24" />
    <Skeleton height="h-24" />
  {:else if data && data.experiments.length === 0}
    <SectionCard>
      <EmptyState icon="git-branch" title={m.wx_empty_title()} description={m.wx_empty_desc()} />
    </SectionCard>
  {:else if data}
    <ul class="space-y-2">
      {#each data.experiments as experiment (experiment.id)}
        {@const status = statusLabel(experiment)}
        <li class="wx-card {selected?.id === experiment.id ? 'wx-card--active' : ''}">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-body-sm font-semibold text-on-surface">{experiment.name}</span>
              <span class="text-2xs font-medium px-2 py-0.5 rounded-full {status.tone}">{status.label}</span>
            </div>
            {#if experiment.hypothesis}<p class="text-2xs text-on-surface-variant mt-0.5">{experiment.hypothesis}</p>{/if}
            <p class="text-2xs text-on-surface-variant mt-1">
              {METRIC_LABEL[experiment.primaryMetric]()} ·
              {experiment.variants.map((variant) => `${variant.key} ${variant.name} (${experiment.assigned[variant.key] ?? 0})`).join(' · ')}
            </p>
          </div>
          <div class="flex flex-wrap gap-1.5 shrink-0">
            {#if totalAssigned(experiment) > 0 || experiment.status !== 'DRAFT'}
              <Button size="sm" icon="bar-chart" onclick={() => openResults(experiment)}>{m.wx_results()}</Button>
            {/if}
            {#if data.canEdit}
              {#if experiment.status === 'DRAFT'}
                <Button size="sm" variant="ghost" icon="edit" onclick={() => openEdit(experiment)}>{m.wx_edit()}</Button>
                <Button size="sm" variant="primary" icon="play" disabled={!!running} onclick={() => start(experiment)}>{m.wx_start()}</Button>
              {:else if experiment.status === 'RUNNING'}
                <Button size="sm" variant="ghost" icon="pause" onclick={() => stop(experiment)}>{m.wx_stop()}</Button>
              {/if}
              {#if experiment.status !== 'RUNNING'}
                <Button size="sm" variant="danger" icon="trash-2" aria-label={m.common_delete()} onclick={() => remove(experiment)} />
              {/if}
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  {#if selected}
    <SectionCard title={m.wx_results_title({ name: selected.name })} description={m.wx_results_desc()} flush>
      {#snippet actions()}
        <Button size="sm" variant="ghost" icon="refresh-cw" aria-label={m.wx_refresh()} loading={resultsLoading} onclick={() => selected && loadResults(selected.id)} />
        <Button size="sm" variant="ghost" icon="x" aria-label={m.common_close()} onclick={() => { selected = null; results = null; }} />
      {/snippet}
      {#if resultsLoading && !results}
        <div class="p-5"><Skeleton height="h-40" /></div>
      {:else if results}
        {#if recommendation}
          <div class="px-5 pt-4">
            <Callout variant={recommendation.tone} title={recommendation.title}>
              {recommendation.body}
              {#snippet actions()}
                {#if recommendation.shipKey && data?.canEdit}
                  <Button size="sm" variant="primary" onclick={() => selected && ship(selected, recommendation.shipKey!)}>{m.wx_ship_short()}</Button>
                {/if}
              {/snippet}
            </Callout>
          </div>
        {/if}
        <div class="overflow-x-auto">
          <table class="wx-table">
            <thead>
              <tr>
                <th>{m.wx_col_variant()}</th>
                <th>{m.wx_col_assigned()}</th>
                {#each METRICS as metric (metric)}
                  <th class={metric === results.primaryMetric ? 'wx-primary' : ''}>{METRIC_LABEL[metric]()}</th>
                {/each}
                <th>{m.wx_col_messages()}</th>
                {#if data?.canEdit}<th></th>{/if}
              </tr>
            </thead>
            <tbody>
              {#each results.variants as variant, index (variant.key)}
                <tr>
                  <td>
                    <span class="font-medium text-on-surface">{variant.key} · {variant.name}</span>
                    {#if index === 0}<span class="block text-2xs text-on-surface-variant">{m.wx_control()}</span>{/if}
                  </td>
                  <td class="tabular-nums">{variant.assigned}</td>
                  {#each METRICS as metric (metric)}
                    {@const result = variant.metrics[metric]}
                    <td class="tabular-nums {metric === results.primaryMetric ? 'wx-primary' : ''}">
                      <span class="text-on-surface">{pct(result.rate)}</span>
                      <span class="block text-2xs text-on-surface-variant">{m.wx_measured({ count: result.eligible })}</span>
                      {#if result.vsControl && result.vsControl.uplift !== null}
                        <span class="block text-2xs {result.vsControl.uplift > 0 ? 'text-success' : result.vsControl.uplift < 0 ? 'text-error' : 'text-on-surface-variant'}">
                          {signed(result.vsControl.uplift)}
                        </span>
                      {/if}
                      {#if result.vsControl && result.vsControl.chanceToBeat !== null}
                        <span class="wx-chance" title={m.wx_chance_tip({ p: result.vsControl.pValue === null ? '—' : result.vsControl.pValue.toFixed(3) })}>
                          <span class="wx-chance__bar"><span style="width: {result.vsControl.chanceToBeat * 100}%"></span></span>
                          <span class="text-2xs text-on-surface-variant">{m.wx_chance({ value: pct(result.vsControl.chanceToBeat, 0) })}</span>
                        </span>
                      {/if}
                    </td>
                  {/each}
                  <td class="tabular-nums">{variant.messagesFirstWeek ?? '—'}</td>
                  {#if data?.canEdit}
                    <td>
                      {#if selected.winnerKey !== variant.key}
                        <Button size="sm" variant="ghost" onclick={() => selected && ship(selected, variant.key)}>{m.wx_ship_short()}</Button>
                      {:else}
                        <span class="text-2xs text-primary">{m.wx_applied()}</span>
                      {/if}
                    </td>
                  {/if}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="px-5 py-3 text-2xs text-on-surface-variant border-t border-outline-variant">{m.wx_method_note()}</p>
      {/if}
    </SectionCard>
  {/if}
</div>

<Modal bind:open={editorOpen} title={editingId ? m.wx_edit_title() : m.wx_new_title()} size="lg">
  <form id="wx-form" class="space-y-4" onsubmit={saveDraft}>
    <div class="grid gap-3 sm:grid-cols-2">
      <Field label={m.wx_field_name()} required>
        {#snippet children(id)}<input {id} class="input" maxlength="80" bind:value={draftName} placeholder={m.wx_field_name_ph()} />{/snippet}
      </Field>
      <Field label={m.wx_field_metric()} hint={m.wx_field_metric_hint()}>
        {#snippet children(id, describedBy)}
          <select {id} aria-describedby={describedBy} class="input" bind:value={draftMetric}>
            {#each METRICS as metric (metric)}<option value={metric}>{METRIC_LABEL[metric]()}</option>{/each}
          </select>
        {/snippet}
      </Field>
    </div>
    <Field label={m.wx_field_hypothesis()} hint={m.wx_field_hypothesis_hint()}>
      {#snippet children(id, describedBy)}<input {id} aria-describedby={describedBy} class="input" maxlength="500" bind:value={draftHypothesis} placeholder={m.wx_field_hypothesis_ph()} />{/snippet}
    </Field>

    <div class="space-y-3">
      {#each draftVariants as variant, index (index)}
        <fieldset class="wx-variant">
          <legend class="flex items-center gap-2 text-body-sm font-medium text-on-surface">
            <span class="wx-key">{keyOf(index)}</span>
            {index === 0 ? m.wx_control() : m.wx_variant()}
            <span class="text-2xs text-on-surface-variant font-normal">{m.wx_share({ value: weightTotal ? Math.round(((Number(variant.weight) || 0) / weightTotal) * 100) : 0 })}</span>
          </legend>
          <div class="grid gap-3 sm:grid-cols-[1fr_7rem]">
            <input class="input" maxlength="40" aria-label={m.wx_field_variant_name()} bind:value={variant.name} />
            <input class="input" type="number" min="1" max="100" aria-label={m.wx_field_weight()} bind:value={variant.weight} />
          </div>
          <textarea class="input h-24 mt-2" maxlength="2000" aria-label={m.wx_field_message()} bind:value={variant.message} placeholder={index === 0 ? m.wx_field_message_control_ph() : m.wx_field_message_ph()}></textarea>
          <div class="grid gap-3 sm:grid-cols-2 mt-2">
            <label class="text-2xs text-on-surface-variant">
              {m.wx_field_image()}
              <select class="input mt-1" bind:value={variant.image}>
                <option value="inherit">{m.wx_inherit()}</option>
                <option value="on">{m.wx_image_on()}</option>
                <option value="off">{m.wx_image_off()}</option>
              </select>
            </label>
            <label class="text-2xs text-on-surface-variant">
              {m.wx_field_thread()}
              <select class="input mt-1" bind:value={variant.thread}>
                <option value="inherit">{m.wx_inherit()}</option>
                <option value="off">{m.wx_thread_off()}</option>
              </select>
            </label>
          </div>
          {#if index >= 2}
            <button type="button" class="mt-2 text-2xs text-error hover:underline" onclick={() => (draftVariants = draftVariants.filter((_, i) => i !== index))}>{m.wx_remove_variant()}</button>
          {/if}
        </fieldset>
      {/each}
      {#if draftVariants.length < 4}
        <Button size="sm" variant="ghost" icon="plus" onclick={() => (draftVariants = [...draftVariants, emptyVariant(m.wx_variant_name({ key: keyOf(draftVariants.length) }))])}>{m.wx_add_variant()}</Button>
      {/if}
    </div>
    {#if editorError}<Callout variant="danger">{editorError}</Callout>{/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (editorOpen = false)}>{m.common_cancel()}</Button>
    <Button variant="primary" type="submit" form="wx-form" loading={saving}>{m.common_save()}</Button>
  {/snippet}
</Modal>

<style>
  .wx-card {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.9rem 1.1rem;
    border: 1px solid var(--outline-variant);
    border-radius: 0.875rem;
    background: var(--surface-container-lowest);
  }
  .wx-card--active {
    border-color: color-mix(in srgb, var(--primary) 50%, transparent);
  }
  .wx-variant {
    padding: 0.85rem 1rem;
    border: 1px solid var(--outline-variant);
    border-radius: 0.75rem;
  }
  .wx-key {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.35rem;
    height: 1.35rem;
    border-radius: 0.375rem;
    background: var(--surface-container);
    font-size: 0.75rem;
    font-weight: 600;
  }
  .wx-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;
    margin-top: 0.75rem;
  }
  .wx-table th {
    padding: 0.55rem 1.25rem;
    text-align: left;
    font-weight: 500;
    font-size: 0.75rem;
    color: var(--on-surface-variant);
    border-bottom: 1px solid var(--outline-variant);
    white-space: nowrap;
  }
  .wx-table td {
    padding: 0.65rem 1.25rem;
    vertical-align: top;
    color: var(--on-surface-variant);
    border-bottom: 1px solid color-mix(in srgb, var(--outline-variant) 50%, transparent);
  }
  .wx-table tr:last-child td {
    border-bottom: none;
  }
  .wx-primary {
    background: color-mix(in srgb, var(--primary) 5%, transparent);
  }
  .wx-chance {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.25rem;
  }
  .wx-chance__bar {
    width: 3.5rem;
    height: 5px;
    border-radius: 999px;
    background: var(--surface-container);
    overflow: hidden;
  }
  .wx-chance__bar span {
    display: block;
    height: 100%;
    background: var(--series-1);
  }
</style>
