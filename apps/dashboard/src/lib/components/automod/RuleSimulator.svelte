<!--
  Simulateur de règles : rejoue une règle d'automodération sur les messages
  passés du serveur avant de l'activer.

  Il teste le brouillon tel qu'il est à l'écran, sans l'enregistrer, et peut le
  comparer à la version en service : c'est l'aperçu qu'offrent les pare-feu
  applicatifs avant de passer une règle en blocage. On y règle aussi les seuils
  directement, puis « Appliquer » reporte les valeurs dans la page.
-->
<script lang="ts" module>
  export interface AutoModDraft {
    spamEnabled: boolean; spamLimit: number; spamIntervalSeconds: number;
    linksEnabled: boolean; linksWhitelist: string[];
    capsEnabled: boolean; capsThresholdPercent: number; capsMinLength: number;
    emojisEnabled: boolean; emojisLimit: number;
    mentionsEnabled: boolean; mentionsLimit: number;
    antiEveryoneEnabled: boolean;
    customWordsEnabled: boolean; customWords: string[]; customWordsAllowList: string[];
  }
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import Papicon from '../Papicon.svelte';
  import Skeleton from '../Skeleton.svelte';
  import BarList from '../analytics/BarList.svelte';
  import { fmtNumber } from '../analytics/analyticsFormat';
  import { Button, Callout, EmptyState, Field, FilterPills, SectionCard, Tabs, type FilterOption } from '../ui';
  import { toast } from '../../stores/toast.svelte';
  import { authStore } from '../../stores/auth.svelte';
  import { m, dateLocale } from '../../i18n';
  import {
    fetchRaidProtection,
    simulateAutomodRule,
    type SimulatedRule,
    type SimulatedRuleKind,
    type SimulationReport,
    type SimulationSample,
  } from '../../api';

  let {
    draft,
    saved,
    kind = $bindable<SimulatedRuleKind>('keywords'),
    canApply = false,
    onapply,
  }: {
    draft: AutoModDraft;
    saved: AutoModDraft;
    kind?: SimulatedRuleKind;
    canApply?: boolean;
    /** Reporte les réglages simulés dans la configuration de la page. */
    onapply?: (rule: SimulatedRule) => void;
  } = $props();

  const KINDS: Array<{ id: SimulatedRuleKind; icon: string; label: () => string }> = [
    { id: 'keywords', icon: 'type', label: () => m.sim_kind_keywords() },
    { id: 'links', icon: 'link', label: () => m.sim_kind_links() },
    { id: 'caps', icon: 'Font', label: () => m.sim_kind_caps() },
    { id: 'emojis', icon: 'smile', label: () => m.sim_kind_emojis() },
    { id: 'mentions', icon: 'at-sign', label: () => m.sim_kind_mentions() },
    { id: 'everyone', icon: 'megaphone', label: () => m.sim_kind_everyone() },
    { id: 'spam', icon: 'Clock', label: () => m.sim_kind_spam() },
    { id: 'scam', icon: 'shield-alert', label: () => m.sim_kind_scam() },
    { id: 'regex', icon: 'code', label: () => m.sim_kind_regex() },
  ];

  // ── Réglages de la règle simulée ───────────────────────
  let limit = $state(5);
  let intervalSeconds = $state(5);
  let thresholdPercent = $state(80);
  let minLength = $state(10);
  let listA = $state('');
  let listB = $state('');
  let pattern = $state('');

  let scamLists = $state<{ whitelist: string[]; customDomains: string[]; enabled: boolean } | null>(null);

  const lines = (text: string) => text.split('\n').map((line) => line.trim().toLowerCase()).filter(Boolean);

  async function ensureScamLists() {
    if (scamLists) return scamLists;
    try {
      const res = await fetchRaidProtection();
      const config = res?.config ?? {};
      scamLists = {
        whitelist: config.scamFilterWhitelist ?? [],
        customDomains: config.scamFilterCustomDomains ?? [],
        enabled: !!config.scamFilterEnabled,
      };
    } catch {
      scamLists = { whitelist: [], customDomains: [], enabled: false };
    }
    return scamLists;
  }

  /** Remet les champs du simulateur sur les réglages actuels de la page. */
  async function loadFromPage(target: SimulatedRuleKind) {
    switch (target) {
      case 'spam': limit = draft.spamLimit; intervalSeconds = draft.spamIntervalSeconds; break;
      case 'links': listA = draft.linksWhitelist.join('\n'); break;
      case 'caps': thresholdPercent = draft.capsThresholdPercent; minLength = draft.capsMinLength; break;
      case 'emojis': limit = draft.emojisLimit; break;
      case 'mentions': limit = draft.mentionsLimit; break;
      case 'keywords': listA = draft.customWords.join('\n'); listB = draft.customWordsAllowList.join('\n'); break;
      case 'scam': {
        const lists = await ensureScamLists();
        listA = lists.whitelist.join('\n');
        listB = lists.customDomains.join('\n');
        break;
      }
      default: break;
    }
  }

  $effect(() => {
    const target = kind;
    untrack(() => {
      report = null;
      void loadFromPage(target);
    });
  });

  function currentRule(): SimulatedRule {
    switch (kind) {
      case 'spam': return { kind, limit, intervalSeconds };
      case 'links': return { kind, whitelist: lines(listA) };
      case 'caps': return { kind, thresholdPercent, minLength };
      case 'emojis': return { kind, limit };
      case 'mentions': return { kind, limit };
      case 'everyone': return { kind };
      case 'keywords': return { kind, keywords: lines(listA), allowList: lines(listB) };
      case 'regex': return { kind, pattern };
      case 'scam': return { kind, whitelist: lines(listA), customDomains: lines(listB) };
    }
  }

  /** La version en service, quand la règle est active : sert de point de comparaison. */
  function savedRule(target: SimulatedRuleKind): SimulatedRule | null {
    switch (target) {
      case 'spam': return saved.spamEnabled ? { kind: target, limit: saved.spamLimit, intervalSeconds: saved.spamIntervalSeconds } : null;
      case 'links': return saved.linksEnabled ? { kind: target, whitelist: saved.linksWhitelist } : null;
      case 'caps': return saved.capsEnabled ? { kind: target, thresholdPercent: saved.capsThresholdPercent, minLength: saved.capsMinLength } : null;
      case 'emojis': return saved.emojisEnabled ? { kind: target, limit: saved.emojisLimit } : null;
      case 'mentions': return saved.mentionsEnabled ? { kind: target, limit: saved.mentionsLimit } : null;
      case 'everyone': return saved.antiEveryoneEnabled ? { kind: target } : null;
      case 'keywords': return saved.customWordsEnabled && saved.customWords.length > 0
        ? { kind: target, keywords: saved.customWords, allowList: saved.customWordsAllowList }
        : null;
      case 'scam': return scamLists?.enabled ? { kind: target, whitelist: scamLists.whitelist, customDomains: scamLists.customDomains } : null;
      default: return null;
    }
  }

  const baselineAvailable = $derived(savedRule(kind) !== null);
  let compare = $state(true);

  // ── Lancement ──────────────────────────────────────────
  type Period = '1' | '7' | '30';
  let period = $state<Period>('7');
  const periodOptions: FilterOption<Period>[] = $derived([
    { value: '1', label: m.sim_period_24h() },
    { value: '7', label: m.sim_period_7d() },
    { value: '30', label: m.sim_period_30d() },
  ]);

  let running = $state(false);
  let error = $state('');
  let report = $state<SimulationReport | null>(null);

  async function run() {
    error = '';
    running = true;
    try {
      const baseline = compare ? savedRule(kind) : null;
      report = await simulateAutomodRule({ rule: currentRule(), baseline, days: Number(period) });
      sampleTab = 'all';
    } catch (err) {
      error = err instanceof Error ? err.message : m.sim_error();
    } finally {
      running = false;
    }
  }

  function apply() {
    onapply?.(currentRule());
    toast.success(m.sim_applied());
  }

  /** Ajoute un passage à la liste d'autorisations, puis relance. */
  function allowPassage(sample: SimulationSample) {
    const [start, end] = sample.highlights[0] ?? [0, 0];
    const passage = sample.content.slice(start, end).toLowerCase().trim();
    if (!passage) return;
    const current = lines(listB);
    if (!current.includes(passage)) listB = [...current, passage].join('\n');
    toast.info(m.sim_allowed({ word: passage }));
    void run();
  }

  // ── Affichage ──────────────────────────────────────────
  type SampleTab = 'all' | 'added' | 'removed';
  let sampleTab = $state<SampleTab>('all');

  const samples = $derived(
    !report ? [] : sampleTab === 'added' ? report.diff?.addedSamples ?? [] : sampleTab === 'removed' ? report.diff?.removedSamples ?? [] : report.draft.samples,
  );

  const maxDay = $derived(Math.max(1, ...(report?.draft.byDay.map((day) => day.count) ?? [0])));

  function segments(sample: SimulationSample): Array<{ text: string; hit: boolean }> {
    const ranges = [...sample.highlights].sort((a, b) => a[0] - b[0]);
    const parts: Array<{ text: string; hit: boolean }> = [];
    let cursor = 0;
    for (const [start, end] of ranges) {
      if (start < cursor) continue;
      if (start > cursor) parts.push({ text: sample.content.slice(cursor, start), hit: false });
      parts.push({ text: sample.content.slice(start, end), hit: true });
      cursor = end;
    }
    if (cursor < sample.content.length) parts.push({ text: sample.content.slice(cursor), hit: false });
    return parts;
  }

  const formatDay = (key: string) => new Date(`${key}T12:00:00Z`).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' });
  const formatDate = (iso: string) => new Date(iso).toLocaleString(dateLocale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const messageLink = (sample: SimulationSample) => `https://discord.com/channels/${authStore.selectedGuildId}/${sample.channelId}/${sample.messageId}`;

  const coverageShort = $derived(
    !!report?.window.firstMessageAt
      && new Date(report.window.firstMessageAt).getTime() - new Date(report.window.from).getTime() > 86_400_000,
  );
</script>

<div class="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
  <!-- Réglages -->
  <SectionCard title={m.sim_setup_title()} description={m.sim_setup_desc()} icon="sliders">
    <div class="px-5 pb-5 pt-3 space-y-4">
      <div class="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label={m.sim_rule_label()}>
        {#each KINDS as item (item.id)}
          <button
            type="button"
            role="radio"
            aria-checked={kind === item.id}
            class="sim-kind {kind === item.id ? 'sim-kind--active' : ''}"
            onclick={() => (kind = item.id)}
          >
            <Papicon icon={item.icon} size={15} />
            <span>{item.label()}</span>
          </button>
        {/each}
      </div>

      {#if kind === 'keywords'}
        <Field label={m.sim_keywords()} hint={m.sim_keywords_hint()}>
          {#snippet children(id, describedBy)}
            <textarea {id} aria-describedby={describedBy} class="input w-full h-28 font-mono" bind:value={listA} placeholder="arnaque&#10;*nitro*&#10;gratuit*"></textarea>
          {/snippet}
        </Field>
        <Field label={m.sim_allowlist()} hint={m.sim_allowlist_hint()}>
          {#snippet children(id, describedBy)}
            <textarea {id} aria-describedby={describedBy} class="input w-full h-20 font-mono" bind:value={listB}></textarea>
          {/snippet}
        </Field>
      {:else if kind === 'links'}
        <Field label={m.sim_links_whitelist()} hint={m.sim_links_whitelist_hint()}>
          {#snippet children(id, describedBy)}
            <textarea {id} aria-describedby={describedBy} class="input w-full h-24 font-mono" bind:value={listA} placeholder="discord.gg/monserveur"></textarea>
          {/snippet}
        </Field>
      {:else if kind === 'caps'}
        <div class="grid grid-cols-2 gap-3">
          <Field label={m.sim_caps_threshold()}>
            {#snippet children(id)}<input {id} class="input w-full" type="number" min="20" max="100" bind:value={thresholdPercent} />{/snippet}
          </Field>
          <Field label={m.sim_caps_min_length()}>
            {#snippet children(id)}<input {id} class="input w-full" type="number" min="1" max="200" bind:value={minLength} />{/snippet}
          </Field>
        </div>
      {:else if kind === 'emojis' || kind === 'mentions'}
        <Field label={kind === 'emojis' ? m.sim_emojis_limit() : m.sim_mentions_limit()} hint={m.sim_limit_hint()}>
          {#snippet children(id, describedBy)}<input {id} aria-describedby={describedBy} class="input w-full" type="number" min="1" max="100" bind:value={limit} />{/snippet}
        </Field>
      {:else if kind === 'spam'}
        <div class="grid grid-cols-2 gap-3">
          <Field label={m.sim_spam_limit()}>
            {#snippet children(id)}<input {id} class="input w-full" type="number" min="2" max="50" bind:value={limit} />{/snippet}
          </Field>
          <Field label={m.sim_spam_interval()}>
            {#snippet children(id)}<input {id} class="input w-full" type="number" min="1" max="60" bind:value={intervalSeconds} />{/snippet}
          </Field>
        </div>
      {:else if kind === 'regex'}
        <Field label={m.sim_regex()} hint={m.sim_regex_hint()}>
          {#snippet children(id, describedBy)}
            <input {id} aria-describedby={describedBy} class="input w-full font-mono" maxlength="300" bind:value={pattern} placeholder={'n[i1]tr[o0]\\s*(free|gratuit)'} />
          {/snippet}
        </Field>
      {:else if kind === 'scam'}
        <Field label={m.sim_scam_whitelist()} hint={m.sim_scam_whitelist_hint()}>
          {#snippet children(id, describedBy)}
            <textarea {id} aria-describedby={describedBy} class="input w-full h-20 font-mono" bind:value={listA}></textarea>
          {/snippet}
        </Field>
        <Field label={m.sim_scam_blocked()}>
          {#snippet children(id)}
            <textarea {id} class="input w-full h-20 font-mono" bind:value={listB}></textarea>
          {/snippet}
        </Field>
      {:else if kind === 'everyone'}
        <p class="text-body-sm text-on-surface-variant">{m.sim_everyone_hint()}</p>
      {/if}

      <div class="space-y-2">
        <span class="text-body-sm text-on-surface-variant">{m.sim_period()}</span>
        <FilterPills label={m.sim_period()} options={periodOptions} value={period} onchange={(value) => (period = value)} />
      </div>

      <label class="flex items-start gap-2.5 text-body-sm {baselineAvailable ? 'text-on-surface' : 'text-on-surface-variant'}">
        <input type="checkbox" class="mt-0.5" bind:checked={compare} disabled={!baselineAvailable} />
        <span>
          {m.sim_compare()}
          <span class="block text-2xs text-on-surface-variant">{baselineAvailable ? m.sim_compare_hint() : m.sim_compare_unavailable()}</span>
        </span>
      </label>

      {#if error}<Callout variant="danger">{error}</Callout>{/if}

      <div class="flex flex-wrap gap-2">
        <Button variant="primary" icon="play" loading={running} onclick={run}>{m.sim_run()}</Button>
        {#if kind !== 'regex' && kind !== 'everyone'}
          <Button variant="ghost" icon="rotate-ccw" onclick={() => loadFromPage(kind)}>{m.sim_reset()}</Button>
        {/if}
      </div>
      {#if canApply && onapply && kind !== 'regex' && kind !== 'scam' && kind !== 'everyone'}
        <Button size="sm" variant="secondary" icon="check" onclick={apply}>{m.sim_apply()}</Button>
      {/if}
    </div>
  </SectionCard>

  <!-- Résultats -->
  <div class="space-y-4 min-w-0">
    {#if running && !report}
      <Skeleton height="h-24" />
      <Skeleton height="h-48" />
    {:else if !report}
      <SectionCard>
        <EmptyState icon="history" title={m.sim_empty_title()} description={m.sim_empty_desc()} />
      </SectionCard>
    {:else}
      {@const result = report.draft}
      <div class="grid gap-3 grid-cols-2 xl:grid-cols-4">
        <div class="sim-kpi">
          <span class="sim-kpi__label">{m.sim_kpi_matched()}</span>
          <span class="sim-kpi__value">{fmtNumber(result.matched)}</span>
          <span class="sim-kpi__hint">{m.sim_kpi_share({ share: result.share.toLocaleString(dateLocale()) })}</span>
        </div>
        <div class="sim-kpi">
          <span class="sim-kpi__label">{m.sim_kpi_authors()}</span>
          <span class="sim-kpi__value">{fmtNumber(result.authors)}</span>
          <span class="sim-kpi__hint">{m.sim_kpi_per_day({ count: (result.matched / Math.max(1, report.window.days)).toLocaleString(dateLocale(), { maximumFractionDigits: 1 }) })}</span>
        </div>
        <div class="sim-kpi">
          <span class="sim-kpi__label">{m.sim_kpi_false_positives()}</span>
          <span class="sim-kpi__value {result.falsePositiveHints > 0 ? 'text-warning' : ''}">{fmtNumber(result.falsePositiveHints)}</span>
          <span class="sim-kpi__hint">{m.sim_kpi_false_positives_hint()}</span>
        </div>
        <div class="sim-kpi">
          <span class="sim-kpi__label">{m.sim_kpi_scanned()}</span>
          <span class="sim-kpi__value">{fmtNumber(report.scanned)}</span>
          <span class="sim-kpi__hint">{m.sim_kpi_exempted({ count: fmtNumber(report.exempted) })}</span>
        </div>
      </div>

      {#if report.diff}
        <Callout variant={report.diff.added > 0 ? 'warning' : 'info'} title={m.sim_diff_title()} icon="git-compare">
          {m.sim_diff_body({ added: fmtNumber(report.diff.added), removed: fmtNumber(report.diff.removed), current: fmtNumber(report.baseline?.matched ?? 0) })}
        </Callout>
      {/if}
      {#if report.approximate}
        <Callout variant="info">{m.sim_approximate()}</Callout>
      {/if}
      {#if report.truncated}
        <Callout variant="warning">{m.sim_truncated({ count: fmtNumber(report.scanned) })}</Callout>
      {:else if coverageShort && report.window.firstMessageAt}
        <Callout variant="info">{m.sim_coverage({ date: formatDate(report.window.firstMessageAt) })}</Callout>
      {/if}

      <SectionCard title={m.sim_by_day()} description={m.sim_by_day_desc({ ms: report.durationMs })}>
        <div class="px-5 pb-5 pt-4">
          <div class="sim-bars" role="img" aria-label={m.sim_by_day()}>
            {#each result.byDay as day (day.date)}
              <div class="sim-bar" title={`${formatDay(day.date)} : ${day.count}`}>
                <span class="sim-bar__fill" style="height: {day.count === 0 ? 0 : Math.max(4, (day.count / maxDay) * 100)}%"></span>
              </div>
            {/each}
          </div>
          {#if result.byDay.length > 0}
            <div class="flex justify-between mt-1.5 text-2xs text-on-surface-variant">
              <span>{formatDay(result.byDay[0].date)}</span>
              <span>{formatDay(result.byDay[result.byDay.length - 1].date)}</span>
            </div>
          {/if}
        </div>
      </SectionCard>

      <div class="grid gap-4 md:grid-cols-2">
        <SectionCard title={m.sim_top_channels()}>
          <div class="px-5 pb-5 pt-3">
            <BarList items={result.topChannels.map((c) => ({ id: c.channelId, label: `#${c.name}`, value: c.count }))} empty={m.sim_none()} />
          </div>
        </SectionCard>
        <SectionCard title={m.sim_top_authors()}>
          <div class="px-5 pb-5 pt-3">
            <BarList
              items={result.topAuthors.map((a) => ({ id: a.userId, label: a.name, value: a.count, sub: a.isStaff ? m.sim_staff() : undefined }))}
              empty={m.sim_none()}
            />
          </div>
        </SectionCard>
      </div>

      <SectionCard title={m.sim_samples_title()} description={m.sim_samples_desc()} flush>
        {#if report.diff}
          <div class="px-5 pt-3">
            <Tabs
              label={m.sim_samples_title()}
              tabs={[
                { id: 'all', label: m.sim_tab_all(), badge: result.matched || undefined },
                { id: 'added', label: m.sim_tab_added(), badge: report.diff.added || undefined },
                { id: 'removed', label: m.sim_tab_removed(), badge: report.diff.removed || undefined },
              ]}
              active={sampleTab}
              onchange={(id) => (sampleTab = id as SampleTab)}
            />
          </div>
        {/if}
        {#if samples.length === 0}
          <EmptyState icon="check-circle" title={m.sim_no_match()} description={m.sim_no_match_desc()} />
        {:else}
          <ul class="divide-y divide-outline-variant/40">
            {#each samples as sample (sample.messageId)}
              <li class="px-5 py-3.5 flex gap-3">
                {#if sample.authorAvatar}
                  <img src={sample.authorAvatar} alt="" class="w-8 h-8 rounded-full shrink-0" loading="lazy" />
                {:else}
                  <span class="w-8 h-8 rounded-full shrink-0 bg-surface-container flex items-center justify-center text-on-surface-variant"><Papicon icon="user" size={14} /></span>
                {/if}
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span class="text-body-sm font-medium text-on-surface">{sample.authorName}</span>
                    <span class="text-2xs text-on-surface-variant">#{sample.channelName} · {formatDate(sample.createdAt)}</span>
                    {#if sample.deleted}<span class="text-2xs text-on-surface-variant">· {m.sim_deleted()}</span>{/if}
                  </div>
                  <p class="sim-content">
                    {#each segments(sample) as part, i (i)}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}
                  </p>
                  <div class="mt-1.5 flex flex-wrap items-center gap-2">
                    <span class="text-2xs px-1.5 py-0.5 rounded bg-surface-container text-on-surface-variant">{sample.detail}</span>
                    {#if sample.falsePositiveHint}
                      <span class="text-2xs px-1.5 py-0.5 rounded bg-warning/10 text-warning">{m.sim_fp_prefix()} {sample.falsePositiveHint}</span>
                    {/if}
                    <a class="text-2xs text-primary hover:underline" href={messageLink(sample)} target="_blank" rel="noopener">{m.sim_open_discord()}</a>
                    {#if kind === 'keywords' && sampleTab !== 'removed' && sample.highlights.length > 0}
                      <button type="button" class="text-2xs text-primary hover:underline" onclick={() => allowPassage(sample)}>{m.sim_allow_here()}</button>
                    {/if}
                  </div>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </SectionCard>
    {/if}
  </div>
</div>

<style>
  .sim-kind {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.3rem;
    padding: 0.6rem 0.35rem;
    border: 1px solid var(--outline-variant);
    border-radius: 0.625rem;
    color: var(--on-surface-variant);
    font-size: 0.6875rem;
    line-height: 1.2;
    text-align: center;
    transition: border-color 120ms ease, background-color 120ms ease;
  }
  .sim-kind:hover {
    background: var(--surface-container-low);
  }
  .sim-kind--active {
    border-color: var(--primary);
    background: color-mix(in srgb, var(--primary) 10%, transparent);
    color: var(--on-surface);
  }

  .sim-kpi {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0.875rem 1rem;
    border: 1px solid var(--outline-variant);
    border-radius: 0.875rem;
    background: var(--surface-container-lowest);
  }
  .sim-kpi__label {
    font-size: 0.75rem;
    color: var(--on-surface-variant);
  }
  .sim-kpi__value {
    font-size: 1.375rem;
    font-weight: 600;
    color: var(--on-surface);
    font-variant-numeric: tabular-nums;
  }
  .sim-kpi__hint {
    font-size: 0.6875rem;
    color: var(--on-surface-variant);
  }

  .sim-bars {
    display: flex;
    align-items: flex-end;
    gap: 3px;
    height: 7rem;
  }
  .sim-bar {
    flex: 1;
    height: 100%;
    display: flex;
    align-items: flex-end;
    border-radius: 3px;
    background: var(--surface-container-low);
  }
  .sim-bar__fill {
    width: 100%;
    border-radius: 3px;
    background: var(--series-1);
  }

  .sim-content {
    margin-top: 0.25rem;
    color: var(--on-surface);
    font-size: 0.8125rem;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .sim-content :global(mark) {
    padding: 0 0.15rem;
    border-radius: 0.25rem;
    background: color-mix(in srgb, var(--error) 22%, transparent);
    color: inherit;
  }
</style>
