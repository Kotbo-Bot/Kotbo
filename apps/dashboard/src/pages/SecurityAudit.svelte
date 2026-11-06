<script lang="ts">
  import { m, dateLocale } from '../lib/i18n';
  import { onMount } from 'svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { fetchSecurityAudit, applySecurityFix, applyAllSecurityFixes } from '../lib/api';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import SectionCard from '../lib/components/SectionCard.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import LoadingHint from '../lib/components/LoadingHint.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import Modal from '../lib/components/Modal.svelte';
  import ActionButton from '../lib/components/ActionButton.svelte';

  type Severity = 'CRITICAL' | 'WARNING' | 'INFO' | 'OK';
  type Category =
    | 'DISCORD' | 'PERMISSIONS' | 'BOTS' | 'WEBHOOKS'
    | 'INVITES' | 'MODULES' | 'BOT_PERMS' | 'HYGIENE';

  type AuditEntity = { id: string; name: string; type: string; detail?: string };
  type AuditFix = { action: string; label: string; risky?: boolean };
  /** Renvoi vers la page qui traite le constat a la main (constats sans correctif). */
  type AuditLink = { href: string; label: string };

  type Finding = {
    id: string;
    category: Category;
    severity: Severity;
    title: string;
    detail: string;
    recommendation?: string;
    weight: number;
    entities?: AuditEntity[];
    fix?: AuditFix;
    link?: AuditLink;
  };

  type CategoryScore = {
    category: Category;
    label: string;
    score: number;
    lost: number;
    max: number;
    counts: { critical: number; warning: number; info: number; ok: number };
  };

  type Report = {
    score: number;
    grade: string;
    categories: CategoryScore[];
    findings: Finding[];
    degraded: string[];
    stats: {
      memberCount: number;
      roleCount: number;
      channelCount: number;
      botCount: number;
      webhookCount: number | null;
      inviteCount: number | null;
      adminMemberCount: number;
      nativeAutoModRules: number | null;
    };
    generatedAt: string;
    durationMs: number;
  };

  let report = $state<Report | null>(null);
  let loading = $state(true);
  let error = $state('');
  let fixingId = $state<string | null>(null);
  let severityFilter = $state<Severity | 'ALL'>('ALL');
  let categoryFilter = $state<Category | 'ALL'>('ALL');
  let showResolved = $state(false);

  // Application en lot : la modale recapitule avant d'agir, puis affiche son
  // resultat a la place du recapitulatif. Un lot partiellement en echec merite
  // mieux qu'un toast qui disparait sans nommer ce qui a rate.
  let bulkOpen = $state(false);
  let bulkRunning = $state(false);
  let bulkResult = $state<{
    applied: { title: string }[];
    failed: { title: string; message: string }[];
  } | null>(null);

  const SEVERITY_META: Record<Severity, { label: string; icon: string; text: string; bg: string; ring: string }> = {
    CRITICAL: { label: m.sax_sev_critical(), icon: 'AlertOctagon', text: 'text-error', bg: 'bg-error/10', ring: 'ring-error/30' },
    WARNING: { label: m.sax_sev_warning(), icon: 'AlertTriangle', text: 'text-warning', bg: 'bg-warning/10', ring: 'ring-warning/30' },
    INFO: { label: m.sax_sev_info(), icon: 'Info', text: 'text-sky-500', bg: 'bg-sky-500/10', ring: 'ring-sky-500/30' },
    OK: { label: m.sax_sev_ok(), icon: 'ShieldCheck', text: 'text-success', bg: 'bg-success/10', ring: 'ring-success/30' },
  };

  /**
   * Largeur de la tuile dans la grille Bento. Un constat critique prend deux
   * colonnes : c'est ce qu'on doit lire en premier, et son detail est le plus
   * long. La hauteur suit le contenu (`items-start` sur la grille), ce qui
   * donne le relief attendu sans avoir a la calculer.
   */
  const TILE_SPAN: Record<Severity, string> = {
    CRITICAL: 'sm:col-span-2',
    WARNING: '',
    INFO: '',
    OK: '',
  };

  /** Entites listees dans la tuile : une grande tuile peut en montrer plus. */
  const ENTITY_CAP: Record<Severity, number> = {
    CRITICAL: 12,
    WARNING: 6,
    INFO: 6,
    OK: 0,
  };

  const CATEGORY_ICONS: Record<Category, string> = {
    DISCORD: 'Discord',
    PERMISSIONS: 'Lock',
    BOTS: 'Robot',
    WEBHOOKS: 'Link',
    INVITES: 'MailOpen',
    MODULES: 'Gears',
    BOT_PERMS: 'ShieldAlert',
    HYGIENE: 'Sparkles',
  };

  const problems = $derived((report?.findings ?? []).filter((f) => f.severity !== 'OK'));
  const resolved = $derived((report?.findings ?? []).filter((f) => f.severity === 'OK'));

  const visibleFindings = $derived(
    (showResolved ? (report?.findings ?? []) : problems).filter(
      (f) =>
        (severityFilter === 'ALL' || f.severity === severityFilter) &&
        (categoryFilter === 'ALL' || f.category === categoryFilter)
    )
  );

  const counts = $derived({
    critical: problems.filter((f) => f.severity === 'CRITICAL').length,
    warning: problems.filter((f) => f.severity === 'WARNING').length,
    info: problems.filter((f) => f.severity === 'INFO').length,
    ok: resolved.length,
  });

  /**
   * Le bouton « Tout activer » ne porte que sur les correctifs sans risque.
   * Les `risky` modifient des permissions existantes : ils gardent leur bouton
   * et leur confirmation, pour qu'un clic global ne retire jamais de droits.
   */
  const safeFixes = $derived(problems.filter((f) => f.fix && !f.fix.risky));
  const riskyFixCount = $derived(problems.filter((f) => f.fix?.risky).length);

  /** Points regagnes si tous les correctifs sans risque etaient appliques. */
  const safeFixPoints = $derived(safeFixes.reduce((sum, f) => sum + f.weight, 0));

  /** Un correctif a la fois : unitaire ou en lot, jamais les deux. */
  const busy = $derived(fixingId !== null || bulkRunning);

  function scoreColor(value: number): string {
    if (value >= 85) return 'text-success';
    if (value >= 65) return 'text-warning';
    if (value >= 45) return 'text-orange-500';
    return 'text-error';
  }

  function scoreStroke(value: number): string {
    if (value >= 85) return 'stroke-emerald-500';
    if (value >= 65) return 'stroke-amber-500';
    if (value >= 45) return 'stroke-orange-500';
    return 'stroke-error';
  }

  function barColor(value: number): string {
    if (value >= 85) return 'bg-emerald-500';
    if (value >= 65) return 'bg-amber-500';
    if (value >= 45) return 'bg-orange-500';
    return 'bg-error';
  }

  function formatDuration(ms: number): string {
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
  }

  /** Echappe le HTML du detail, puis rend son gras et son code inline. */
  function renderDetail(detail: string): string {
    return detail
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong class="text-on-surface font-medium">$1</strong>')
      .replace(/`(.+?)`/g, '<code class="px-1 py-0.5 rounded bg-surface-container text-xs">$1</code>');
  }

  async function load(showToast = false) {
    if (!authStore.selectedGuildId) return;
    loading = true;
    error = '';
    try {
      const res = await fetchSecurityAudit(true, authStore.selectedGuildId);
      report = res?.report ?? null;
      if (showToast) toast.success(m.sa_refreshed());
    } catch (err) {
      error = err instanceof Error ? err.message : m.sax_load_failed();
      report = null;
    } finally {
      loading = false;
    }
  }

  async function runFix(finding: Finding) {
    if (!finding.fix || busy) return;
    if (finding.fix.risky) {
      const confirmed = await confirmDialog.ask({
        title: finding.fix.label,
        description: m.sax_risky_desc(),
        confirmLabel: m.sax_apply(),
        variant: 'warning',
      });
      if (!confirmed) return;
    }

    fixingId = finding.id;
    try {
      const res = await applySecurityFix(finding.id, authStore.selectedGuildId);
      if (res?.report) report = res.report;
      toast.success(res?.message ?? m.sa_fix_applied());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.sa_fix_failed());
    } finally {
      fixingId = null;
    }
  }

  function openBulk() {
    bulkResult = null;
    bulkOpen = true;
  }

  async function runAllFixes() {
    if (bulkRunning) return;
    bulkRunning = true;
    try {
      const res = await applyAllSecurityFixes(authStore.selectedGuildId);
      if (res?.report) report = res.report;
      const applied = res?.applied ?? [];
      const failed = res?.failed ?? [];

      if (failed.length === 0) {
        toast.success(m.sa_fixes_applied({ count: applied.length }));
        bulkOpen = false;
      } else {
        // On garde la modale ouverte pour nommer les echecs : « 3 en echec »
        // sans dire lesquels n'aide personne a rattraper le coup.
        bulkResult = { applied, failed };
        toast.warning(m.sa_fixes_partial({ applied: applied.length, failed: failed.length }));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.sa_fixes_failed());
    } finally {
      bulkRunning = false;
    }
  }

  onMount(load);

  // Recharge quand l'utilisateur change de serveur.
  $effect(() => {
    const guildId = authStore.selectedGuildId;
    if (guildId) void load();
  });

  // Geometrie de l'anneau de score.
  const RING_RADIUS = 52;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
  const ringOffset = $derived(RING_CIRCUMFERENCE * (1 - (report?.score ?? 0) / 100));
</script>

<ModulePage
  title={m.sax_title()}
  description={m.sax_desc()}
  icon="ShieldCheck"
  featureKey="raid_protection"
>
  {#snippet actions()}
    {#if safeFixes.length > 0}
      <ActionButton
        variant="primary"
        size="sm"
        icon="Sparkles"
        label={m.sax_enable_all()}
        disabled={busy}
        onclick={openBulk}
      />
    {/if}
    <RefreshButton onclick={() => load(true)} loading={loading} />
  {/snippet}

  {#if loading && !report}
    <LoadingHint context="config" />
  {:else if error}
    <EmptyState icon="AlertTriangle" title={m.sax_unavailable()} description={error} actionLabel={m.common_retry()} actionIcon="RefreshCw" onAction={() => load()} />
  {:else if report}
    <!-- ── Synthese ───────────────────────────────────────────────────── -->
    <div class="grid gap-4 lg:grid-cols-[minmax(0,320px)_1fr]">
      <SectionCard>
        <div class="flex flex-col items-center gap-4 py-2">
          <div class="relative w-[136px] h-[136px]">
            <svg viewBox="0 0 120 120" class="w-full h-full -rotate-90">
              <circle
                cx="60" cy="60" r={RING_RADIUS}
                class="stroke-outline-variant/30"
                stroke-width="9" fill="none"
              />
              <circle
                cx="60" cy="60" r={RING_RADIUS}
                class="{scoreStroke(report.score)} transition-all duration-700"
                stroke-width="9" fill="none" stroke-linecap="round"
                stroke-dasharray={RING_CIRCUMFERENCE}
                stroke-dashoffset={ringOffset}
              />
            </svg>
            <div class="absolute inset-0 flex flex-col items-center justify-center">
              <span class="text-4xl font-bold tracking-tight {scoreColor(report.score)}">{report.score}</span>
              <span class="text-xs text-on-surface-variant">{m.sax_grade({ grade: report.grade })}</span>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-2 w-full text-center">
            <div class="rounded-lg bg-error/10 px-3 py-2">
              <div class="text-lg font-semibold text-error">{counts.critical}</div>
              <div class="text-2xs text-on-surface-variant">{m.sax_stat_critical()}</div>
            </div>
            <div class="rounded-lg bg-warning/10 px-3 py-2">
              <div class="text-lg font-semibold text-warning">{counts.warning}</div>
              <div class="text-2xs text-on-surface-variant">{m.sax_stat_warning()}</div>
            </div>
            <div class="rounded-lg bg-sky-500/10 px-3 py-2">
              <div class="text-lg font-semibold text-sky-500">{counts.info}</div>
              <div class="text-2xs text-on-surface-variant">{m.sax_stat_info()}</div>
            </div>
            <div class="rounded-lg bg-success/10 px-3 py-2">
              <div class="text-lg font-semibold text-success">{counts.ok}</div>
              <div class="text-2xs text-on-surface-variant">{m.sax_stat_ok()}</div>
            </div>
          </div>

          {#if safeFixes.length > 0}
            <button
              type="button"
              class="w-full rounded-xl border border-primary/30 bg-primary/10 px-3 py-2.5 text-center
              hover:bg-primary/15 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              disabled={busy}
              onclick={openBulk}
            >
              <span class="inline-flex items-center gap-1.5 text-body-sm font-semibold text-primary">
                <Papicon icon="Sparkles" size={14} />
                {m.sax_enable_all()}
              </span>
              <span class="block mt-0.5 text-2xs text-on-surface-variant">
                {m.sax_safe_fixes({ count: safeFixes.length, points: safeFixPoints })}
              </span>
            </button>
          {/if}

          {#if riskyFixCount > 0}
            <p class="text-2xs text-center text-on-surface-variant/75 leading-relaxed">
              {m.sax_risky_count({ count: riskyFixCount })}
            </p>
          {/if}

          <p class="text-2xs text-on-surface-variant text-center">
            {m.sax_done_in({ duration: formatDuration(report.durationMs), date: new Date(report.generatedAt).toLocaleString(dateLocale()) })}
          </p>
        </div>
      </SectionCard>

      <SectionCard title={m.sax_by_category()} description={m.sax_by_category_desc()}>
        <div class="space-y-2.5">
          {#each [...report.categories].sort((a, b) => a.score - b.score) as cat (cat.category)}
            <button
              type="button"
              class="w-full text-left group"
              onclick={() => (categoryFilter = categoryFilter === cat.category ? 'ALL' : cat.category)}
            >
              <div class="flex items-center gap-3">
                <div
                  class="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center transition-colors
                  {categoryFilter === cat.category ? 'bg-primary/20 text-primary' : 'bg-surface-container text-on-surface-variant group-hover:text-on-surface'}"
                >
                  <Papicon icon={CATEGORY_ICONS[cat.category]} size={14} />
                </div>
                <div class="min-w-0 flex-1">
                  <div class="flex items-baseline justify-between gap-2">
                    <span class="text-body-sm font-medium text-on-surface truncate">{cat.label}</span>
                    <span class="text-xs font-semibold tabular-nums {scoreColor(cat.score)}">{cat.score}%</span>
                  </div>
                  <div class="mt-1 h-1.5 rounded-full bg-surface-container overflow-hidden">
                    <div
                      class="h-full rounded-full transition-all duration-700 {barColor(cat.score)}"
                      style="width: {cat.score}%"
                    ></div>
                  </div>
                </div>
                {#if cat.counts.critical > 0}
                  <span class="text-2xs font-semibold text-error shrink-0">{cat.counts.critical} crit.</span>
                {/if}
              </div>
            </button>
          {/each}
        </div>

        <div class="mt-5 pt-4 border-t border-outline-variant/30 grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
          <div>
            <div class="text-sm font-semibold text-on-surface">{report.stats.memberCount.toLocaleString(dateLocale())}</div>
            <div class="text-2xs text-on-surface-variant">{m.sax_members()}</div>
          </div>
          <div>
            <div class="text-sm font-semibold text-on-surface">{report.stats.adminMemberCount}</div>
            <div class="text-2xs text-on-surface-variant">{m.sax_admins()}</div>
          </div>
          <div>
            <div class="text-sm font-semibold text-on-surface">{report.stats.botCount}</div>
            <div class="text-2xs text-on-surface-variant">{m.sax_bots()}</div>
          </div>
          <div>
            <div class="text-sm font-semibold text-on-surface">
              {report.stats.webhookCount ?? '-'}
            </div>
            <div class="text-2xs text-on-surface-variant">{m.sax_webhooks()}</div>
          </div>
        </div>
      </SectionCard>
    </div>

    <!-- ── Controles non executes ─────────────────────────────────────── -->
    {#if report.degraded.length > 0}
      <div class="rounded-xl border border-warning/30 bg-warning/5 px-4 py-3">
        <div class="flex items-start gap-3">
          <Papicon icon="AlertTriangle" size={16} class="text-warning mt-0.5 shrink-0" />
          <div class="min-w-0">
            <p class="text-body-sm font-medium text-on-surface">{m.sax_degraded()}</p>
            <ul class="mt-1 space-y-0.5">
              {#each report.degraded as item}
                <li class="text-xs text-on-surface-variant">• {item}</li>
              {/each}
            </ul>
            <p class="mt-1.5 text-xs text-on-surface-variant">
              {m.sax_degraded_desc()}
            </p>
          </div>
        </div>
      </div>
    {/if}

    <!-- ── Constats ───────────────────────────────────────────────────── -->
    <SectionCard
      title={m.sax_findings()}
      description={m.sax_findings_desc({ shown: visibleFindings.length, total: report.findings.length })}
    >
      {#snippet actions()}
        <label class="flex items-center gap-2 text-xs text-on-surface-variant cursor-pointer select-none">
          <input type="checkbox" bind:checked={showResolved} class="accent-primary" />
          {m.sax_show_resolved()}
        </label>
      {/snippet}

      <div class="flex flex-wrap gap-1.5 mb-4">
        <button
          type="button"
          class="px-2.5 py-1 rounded-full text-xs font-medium border transition-colors
          {severityFilter === 'ALL'
            ? 'bg-primary/15 border-primary/40 text-primary'
            : 'bg-surface-container-low border-outline-variant/40 text-on-surface-variant hover:text-on-surface'}"
          onclick={() => (severityFilter = 'ALL')}
        >
          {m.sax_all()}
        </button>
        {#each ['CRITICAL', 'WARNING', 'INFO'] as sev}
          {@const meta = SEVERITY_META[sev as Severity]}
          <button
            type="button"
            class="px-2.5 py-1 rounded-full text-xs font-medium border transition-colors inline-flex items-center gap-1.5
            {severityFilter === sev
              ? `${meta.bg} border-current ${meta.text}`
              : 'bg-surface-container-low border-outline-variant/40 text-on-surface-variant hover:text-on-surface'}"
            onclick={() => (severityFilter = severityFilter === sev ? 'ALL' : (sev as Severity))}
          >
            <Papicon icon={meta.icon} size={12} />
            {meta.label}
          </button>
        {/each}

        {#if categoryFilter !== 'ALL'}
          <button
            type="button"
            class="px-2.5 py-1 rounded-full text-xs font-medium border border-primary/40 bg-primary/15 text-primary inline-flex items-center gap-1.5"
            onclick={() => (categoryFilter = 'ALL')}
          >
            {report.categories.find((c) => c.category === categoryFilter)?.label}
            <Papicon icon="Cross" size={11} />
          </button>
        {/if}
      </div>

      {#if visibleFindings.length === 0}
        <EmptyState
          icon="ShieldCheck"
          title={m.sax_empty_filter()}
          description={m.sax_empty_filter_desc()}
          actionLabel={m.sax_show_all()}
          actionIcon="Eraser"
          onAction={() => { severityFilter = 'ALL'; categoryFilter = 'ALL'; }}
        />
      {:else}
        <!--
          Grille Bento : une tuile par constat, largeur variable selon la
          gravite. `items-start` laisse chaque tuile a la hauteur de son propre
          contenu au lieu d'etirer toute la rangee sur la plus haute, et
          `grid-auto-flow: dense` rebouche les trous que laissent les tuiles
          doubles. Le tout tient dans la hauteur d'un ecran la ou la liste en
          pleine largeur imposait de derouler.
        -->
        <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 items-start [grid-auto-flow:dense]">
          {#each visibleFindings as finding (finding.id)}
            {@const meta = SEVERITY_META[finding.severity]}
            {@const cap = ENTITY_CAP[finding.severity]}
            <article
              class="rounded-xl border p-4 transition-colors {TILE_SPAN[finding.severity]}
              {finding.severity === 'CRITICAL'
                ? 'border-error/30 bg-error/[0.04] hover:border-error/50'
                : 'border-outline-variant/30 bg-surface-container-low/40 hover:border-outline-variant/60'}"
            >
              <div class="flex items-start gap-2.5">
                <div class="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center {meta.bg} {meta.text}">
                  <Papicon icon={meta.icon} size={14} />
                </div>
                <div class="min-w-0 flex-1">
                  <h4 class="text-body-sm font-semibold text-on-surface leading-snug">{finding.title}</h4>
                  <div class="mt-1 flex flex-wrap items-center gap-1.5">
                    {#if finding.weight > 0}
                      <span class="text-2xs font-semibold tabular-nums {meta.text}">-{finding.weight} pts</span>
                    {/if}
                    <span class="text-2xs px-1.5 py-0.5 rounded bg-surface-container text-on-surface-variant">
                      {report.categories.find((c) => c.category === finding.category)?.label}
                    </span>
                  </div>
                </div>
              </div>

              <p class="mt-2.5 text-xs text-on-surface-variant leading-relaxed">
                {@html renderDetail(finding.detail)}
              </p>

              {#if cap > 0 && finding.entities && finding.entities.length > 0}
                <div class="mt-2 flex flex-wrap gap-1">
                  {#each finding.entities.slice(0, cap) as entity}
                    <span
                      class="text-2xs px-1.5 py-0.5 rounded bg-surface-container text-on-surface-variant"
                      title={entity.detail ?? entity.id}
                    >
                      {entity.type === 'channel' ? '#' : entity.type === 'role' ? '@' : ''}{entity.name}
                    </span>
                  {/each}
                  {#if finding.entities.length > cap}
                    <span class="text-2xs px-1.5 py-0.5 text-on-surface-variant">
                      +{finding.entities.length - cap}
                    </span>
                  {/if}
                </div>
              {/if}

              {#if finding.recommendation}
                <p class="mt-2 text-xs text-on-surface-variant/85 leading-relaxed pl-2.5 border-l-2 border-primary/40">
                  {finding.recommendation}
                </p>
              {/if}

              {#if finding.fix || finding.link}
                <div class="mt-3 flex flex-wrap gap-2">
                  {#if finding.fix}
                    <button
                      type="button"
                      class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                      bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25
                      disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      disabled={busy}
                      onclick={() => runFix(finding)}
                    >
                      {#if fixingId === finding.id}
                        <Papicon icon="Loader" size={13} class="animate-spin" />
                        {m.sax_applying()}
                      {:else}
                        <Papicon icon="Wrench" size={13} />
                        {finding.fix.label}
                        {#if finding.fix.risky}
                          <span class="text-2xs text-warning ml-0.5">· {m.sax_confirmation()}</span>
                        {/if}
                      {/if}
                    </button>
                  {/if}

                  {#if finding.link}
                    <a
                      href={finding.link.href}
                      class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                      bg-surface-container text-on-surface border border-outline-variant/40
                      hover:border-outline-variant transition-colors"
                    >
                      <Papicon icon="ArrowRight" size={13} />
                      {finding.link.label}
                    </a>
                  {/if}
                </div>
              {/if}
            </article>
          {/each}
        </div>
      {/if}
    </SectionCard>
  {/if}
</ModulePage>

<!-- ── Confirmation du lot ────────────────────────────────────────────── -->
<Modal
  bind:open={bulkOpen}
  title={m.sax_bulk_title()}
  subtitle={bulkResult
    ? m.sax_bulk_result()
    : m.sax_safe_fixes({ count: safeFixes.length, points: safeFixPoints })}
  size="lg"
  closeOnBackdropClick={!bulkRunning}
  closeOnEscape={!bulkRunning}
>
  {#if bulkResult}
    <div class="space-y-4">
      {#if bulkResult.applied.length > 0}
        <div>
          <p class="text-body-sm font-medium text-success mb-1.5">
            {m.sax_applied({ count: bulkResult.applied.length })}
          </p>
          <ul class="space-y-1">
            {#each bulkResult.applied as item}
              <li class="text-xs text-on-surface-variant flex items-start gap-2">
                <Papicon icon="CheckCircle" size={13} class="text-success mt-0.5 shrink-0" />
                {item.title}
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if bulkResult.failed.length > 0}
        <div>
          <p class="text-body-sm font-medium text-error mb-1.5">
            {m.sax_failed({ count: bulkResult.failed.length })}
          </p>
          <ul class="space-y-1">
            {#each bulkResult.failed as item}
              <li class="text-xs text-on-surface-variant flex items-start gap-2">
                <Papicon icon="AlertOctagon" size={13} class="text-error mt-0.5 shrink-0" />
                <span><span class="text-on-surface">{item.title}</span> - {item.message}</span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      <div class="flex justify-end pt-1">
        <ActionButton variant="neutral" label={m.common_close()} onclick={() => (bulkOpen = false)} />
      </div>
    </div>
  {:else}
    <div class="space-y-4">
      <p class="text-body-sm text-on-surface-variant leading-relaxed">
        {m.sax_bulk_desc()}
        {#if riskyFixCount > 0}
          {m.sax_bulk_risky({ count: riskyFixCount })}
        {/if}
      </p>

      <ul class="space-y-1.5 max-h-[45vh] overflow-y-auto pr-1">
        {#each safeFixes as finding (finding.id)}
          {@const meta = SEVERITY_META[finding.severity]}
          <li class="flex items-start gap-2.5 rounded-lg border border-outline-variant/30 bg-surface-container-low/40 px-3 py-2">
            <Papicon icon={meta.icon} size={13} class="{meta.text} mt-0.5 shrink-0" />
            <div class="min-w-0 flex-1">
              <p class="text-xs font-medium text-on-surface leading-snug">{finding.title}</p>
              <p class="text-2xs text-on-surface-variant mt-0.5">{finding.fix?.label}</p>
            </div>
            {#if finding.weight > 0}
              <span class="text-2xs font-semibold tabular-nums text-primary shrink-0">+{finding.weight}</span>
            {/if}
          </li>
        {/each}
      </ul>

      <div class="flex justify-end gap-2 pt-1">
        <ActionButton
          variant="neutral"
          label={m.common_cancel()}
          disabled={bulkRunning}
          onclick={() => (bulkOpen = false)}
        />
        <ActionButton
          variant="primary"
          icon={bulkRunning ? 'Loader' : 'Sparkles'}
          label={bulkRunning ? m.sax_applying() : m.sax_bulk_run({ count: safeFixes.length })}
          disabled={bulkRunning}
          onclick={runAllFixes}
        />
      </div>
    </div>
  {/if}
</Modal>
