<script lang="ts">
  /**
   * Vue détaillée d'un code d'invitation, présentée comme la fiche membre :
   * tuiles qui pilotent la courbe (période précédente en pointillé), sections
   * en cartes, actions de modération dans la colonne de droite.
   */
  import { router } from 'tinro';
  import Papicon from '../Papicon.svelte';
  import DetailSheet from '../DetailSheet.svelte';
  import { Button, Callout, FilterPills, SectionCard, type FilterOption } from '../ui';
  import MetricTabs, { type MetricTab } from '../analytics/MetricTabs.svelte';
  import TimeSeriesChart from '../analytics/TimeSeriesChart.svelte';
  import { fmtNumber, shortDate, SERIES } from '../analytics/analyticsFormat';
  import { relativeDelta } from '../analytics/analyticsFilters.svelte';
  import { memberAvatarSrc } from '../../discordMedia';
  import { inviteDetailsModal } from '../../stores/inviteDetailsModal.svelte';
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { downloadSingleSheetXlsx } from '../../xlsxExport';
  import {
    fetchInvitationDetails,
    toggleInvitationSuspension,
    purgeInvitationMembers,
    purgeInviterMembers,
    deleteInvitation,
    updateInvitationSource
  } from '../../api';
  import { m, dateLocale } from '../../i18n';
  import { errorMessage } from '@kotbo/shared';

  type InviteTab = 'resume' | 'retention' | 'qualite' | 'temporalite' | 'invites';
  type Metric = 'arrivals' | 'departures' | 'net';

  let details = $state<any>(null);
  let loading = $state(false);
  let error = $state('');
  let days = $state<'7' | '30' | '90'>('30');
  let activeTab = $state<InviteTab>('resume');
  let activeMetric = $state<Metric>('arrivals');

  // Onglet « Invités » : filtres locaux, aucun aller-retour serveur.
  let joinSearch = $state('');
  let joinStatus = $state<'all' | 'present' | 'left'>('all');
  let joinSort = $state<'recent' | 'oldest' | 'messages'>('recent');
  let joinPage = $state(1);
  const JOINS_PER_PAGE = 25;

  let sourceDraft = $state('');
  let sourceSaving = $state(false);

  const isOpen = $derived(inviteDetailsModal.open);
  const inviteCode = $derived(inviteDetailsModal.code);
  const canModerate = $derived(!!dashboardStore.state.access?.canModerateContent);

  $effect(() => {
    if (!isOpen || !inviteCode) return;
    void days;
    void loadDetails();
  });

  $effect(() => {
    if (isOpen) return;
    details = null;
    error = '';
    loading = false;
    activeTab = 'resume';
    joinSearch = '';
    joinStatus = 'all';
    joinSort = 'recent';
    joinPage = 1;
  });

  async function loadDetails() {
    if (!inviteCode) return;
    loading = true;
    error = '';
    try {
      details = await fetchInvitationDetails(inviteCode, { days: Number(days) });
      sourceDraft = details?.invite?.sourceLabel ?? '';
    } catch (err) {
      error = errorMessage(err) || m.d7_inv_load_error();
      details = null;
    } finally {
      loading = false;
    }
  }

  function closeModal() {
    inviteDetailsModal.close();
  }

  function formatDate(value: string | null | undefined) {
    if (!value) return m.d7_never();
    return new Date(value).toLocaleDateString(dateLocale(), { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function formatDateTime(value: string | null | undefined) {
    if (!value) return m.d7_unknown();
    return new Date(value).toLocaleString(dateLocale());
  }

  function formatPct(value: number | null | undefined) {
    return value === null || value === undefined ? '–' : `${value} %`;
  }

  function formatDays(value: number | null | undefined) {
    return value === null || value === undefined ? '–' : m.d7_inv_days_value({ value });
  }

  async function toggleSuspend() {
    if (!details?.invite) return;
    try {
      await toggleInvitationSuspension(details.invite.code, !details.invite.isSuspended);
      toast.success(details.invite.isSuspended ? m.d7_inv_restored() : m.d7_inv_suspended());
      await loadDetails();
    } catch (err) {
      toast.error(errorMessage(err) || m.d7_inv_modify_error());
    }
  }

  async function purgeInvite() {
    if (!details?.invite) return;
    const ok = await confirmDialog.danger(m.d7_inv_purge_confirm({ code: details.invite.code }), '', m.d7_purge());
    if (!ok) return;
    try {
      const result = await purgeInvitationMembers(details.invite.code);
      toast.success(m.d7_inv_purge_done({ count: result?.purgedCount ?? 0 }));
      await loadDetails();
    } catch (err) {
      toast.error(errorMessage(err) || m.d7_inv_purge_error());
    }
  }

  async function purgeInviter() {
    const inviterId = details?.invite?.inviterId;
    if (!inviterId) return;
    const ok = await confirmDialog.danger(m.d7_inv_cascade_confirm(), m.d7_inv_cascade_desc(), m.d7_purge());
    if (!ok) return;
    try {
      const result = await purgeInviterMembers(inviterId);
      toast.success(m.d7_inv_cascade_done({ count: result?.purgedCount ?? 0 }));
      await loadDetails();
    } catch (err) {
      toast.error(errorMessage(err) || m.d7_inv_cascade_error());
    }
  }

  async function deleteInvite() {
    if (!details?.invite) return;
    const ok = await confirmDialog.danger(m.d7_inv_delete_confirm({ code: details.invite.code }), m.d7_inv_delete_permanent());
    if (!ok) return;
    try {
      await deleteInvitation(details.invite.code);
      toast.success(m.d7_inv_deleted());
      closeModal();
    } catch (err) {
      toast.error(errorMessage(err) || m.d7_inv_delete_error());
    }
  }

  async function saveSource() {
    if (!details?.invite) return;
    sourceSaving = true;
    try {
      const trimmed = sourceDraft.trim();
      await updateInvitationSource(details.invite.code, trimmed || null);
      toast.success(m.d7_inv_source_saved());
      await loadDetails();
    } catch (err) {
      toast.error(errorMessage(err) || m.d7_inv_source_error());
    } finally {
      sourceSaving = false;
    }
  }

  function copyInvite() {
    if (!details?.invite?.code) return;
    navigator.clipboard.writeText(`https://discord.gg/${details.invite.code}`)
      .then(() => toast.success(m.d7_inv_link_copied()))
      .catch(() => toast.warning(m.d7_inv_link_copy_fail()));
  }

  function openMember(userId: string) {
    closeModal();
    router.goto(`/members/${userId}`);
  }

  const tabs = $derived([
    { id: 'resume', label: m.d7_inv_tab_summary(), icon: 'Grid' },
    { id: 'retention', label: m.d7_inv_tab_retention(), icon: 'TrendingUp' },
    { id: 'qualite', label: m.d7_inv_tab_quality(), icon: 'Award' },
    { id: 'temporalite', label: m.d7_inv_tab_timing(), icon: 'Clock' },
    { id: 'invites', label: m.d7_inv_tab_people(), icon: 'Users' },
  ]);

  const periodOptions: FilterOption<'7' | '30' | '90'>[] = $derived([
    { value: '7', label: m.d7_inv_days_7() },
    { value: '30', label: m.d7_inv_days_30() },
    { value: '90', label: m.d7_inv_days_90() },
  ]);

  // ── Courbes : arrivées, départs et solde, contre la période d'avant ──
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const trendLabels = $derived<string[]>((details?.trend?.labels ?? []).map((key: string) => shortDate(key)));

  const series = $derived.by(() => {
    const t = details?.trend ?? {};
    const arrivals: number[] = t.counts ?? [];
    const departures: number[] = t.departures ?? [];
    const prevArrivals: number[] = t.previousArrivals ?? [];
    const prevDepartures: number[] = t.previousDepartures ?? [];
    return {
      arrivals: { cur: arrivals, prev: prevArrivals },
      departures: { cur: departures, prev: prevDepartures },
      net: { cur: arrivals.map((a, i) => a - (departures[i] ?? 0)), prev: prevArrivals.map((a, i) => a - (prevDepartures[i] ?? 0)) },
    };
  });

  const METRICS: Array<{ id: Metric; label: () => string; color: string; invert?: boolean }> = [
    { id: 'arrivals', label: () => m.d7_inv_joins(), color: SERIES[0]! },
    { id: 'departures', label: () => m.d7_inv_departures(), color: SERIES[3], invert: true },
    { id: 'net', label: () => m.d7_inv_remaining(), color: SERIES[2]! },
  ];

  const metrics: MetricTab[] = $derived(METRICS.map((metric) => {
    const { cur, prev } = series[metric.id];
    return {
      id: metric.id,
      label: metric.label(),
      value: fmtNumber(sum(cur)),
      delta: prev.length ? relativeDelta(sum(cur), sum(prev)) : null,
      invert: metric.invert,
      spark: cur,
      color: metric.color,
    };
  }));
  const selected = $derived(METRICS.find((metric) => metric.id === activeMetric) ?? METRICS[0]);

  const weekdayNames = $derived([
    m.d7_inv_day_mon(), m.d7_inv_day_tue(), m.d7_inv_day_wed(),
    m.d7_inv_day_thu(), m.d7_inv_day_fri(), m.d7_inv_day_sat(), m.d7_inv_day_sun(),
  ]);

  const ghostEntries = $derived.by(() => {
    const ghost = details?.quality?.ghost ?? {};
    const labels: Record<string, () => string> = {
      ACTIVE: m.d7_inv_ghost_active,
      SPECTATOR: m.d7_inv_ghost_spectator,
      INACTIVE: m.d7_inv_ghost_inactive,
      NEW: m.d7_inv_ghost_new,
      UNKNOWN: m.d7_inv_ghost_unknown,
    };
    return Object.keys(labels)
      .map((key) => ({ key, label: labels[key](), count: ghost[key] ?? 0 }))
      .filter((entry) => entry.count > 0);
  });

  /** Écart relatif d'un invité moyen par rapport au membre moyen du serveur. */
  function deltaVsGuild(value: number | null, guildValue: number | null): number | null {
    if (value === null || guildValue === null || !guildValue) return null;
    return Math.round(((value - guildValue) / guildValue) * 100);
  }

  const filteredJoins = $derived.by(() => {
    const joins: any[] = details?.joins ?? [];
    const query = joinSearch.trim().toLowerCase();

    const filtered = joins.filter((join) => {
      if (joinStatus === 'present' && join.leftAt) return false;
      if (joinStatus === 'left' && !join.leftAt) return false;
      if (!query) return true;
      return (join.userTag ?? '').toLowerCase().includes(query) || join.userId.includes(query);
    });

    return [...filtered].sort((a, b) => {
      if (joinSort === 'messages') return (b.messageCount ?? 0) - (a.messageCount ?? 0);
      const diff = new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime();
      return joinSort === 'oldest' ? diff : -diff;
    });
  });

  const joinTotalPages = $derived(Math.max(1, Math.ceil(filteredJoins.length / JOINS_PER_PAGE)));
  const pagedJoins = $derived(filteredJoins.slice((joinPage - 1) * JOINS_PER_PAGE, joinPage * JOINS_PER_PAGE));

  // Un filtre qui raccourcit la liste peut laisser `joinPage` hors bornes.
  $effect(() => {
    if (joinPage > joinTotalPages) joinPage = joinTotalPages;
  });

  function joinRows() {
    return filteredJoins.map((join) => ({
      utilisateur: join.userTag,
      id: join.userId,
      arrive_le: formatDateTime(join.joinedAt),
      parti_le: join.leftAt ? formatDateTime(join.leftAt) : '',
      statut: join.leftAt ? m.d7_inv_left() : m.d7_inv_present(),
      messages: join.messageCount ?? 0,
    }));
  }

  function exportCsv() {
    const rows = joinRows();
    if (!rows.length) { toast.error(m.d7_inv_export_empty()); return; }
    const headers = Object.keys(rows[0]);
    const csv = [
      headers.join(','),
      ...rows.map((row) => headers.map((h) => `"${String((row as any)[h] ?? '').replace(/"/g, '""')}"`).join(',')),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `invites_${inviteCode}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  async function exportXlsx() {
    const rows = joinRows();
    if (!rows.length) { toast.error(m.d7_inv_export_empty()); return; }
    await downloadSingleSheetXlsx(`invites_${inviteCode}`, 'invites', rows);
  }
</script>

{#snippet facts(rows: Array<{ label: string; value: string; tone?: string }>)}
  <dl class="sheet-facts">
    {#each rows as row (row.label)}
      <div><dt>{row.label}</dt><dd class={row.tone ?? ''}>{row.value}</dd></div>
    {/each}
  </dl>
{/snippet}

{#snippet empty(text: string)}
  <p class="py-6 text-center text-sm text-on-surface-variant">{text}</p>
{/snippet}

{#snippet bar(label: string, value: string, pct: number, color = 'var(--primary-color)')}
  <div>
    <div class="flex items-center justify-between gap-3 text-sm">
      <span class="text-on-surface">{label}</span>
      <span class="tabular-nums text-on-surface-variant">{value}</span>
    </div>
    <span class="sheet-bar"><span style="width: {Math.min(100, Math.max(0, pct))}%; background: {color}"></span></span>
  </div>
{/snippet}

<DetailSheet
  open={isOpen}
  onClose={closeModal}
  icon="Link"
  title={m.d7_inv_title({ code: inviteCode ?? '' })}
  subtitle={m.d7_inv_moderation_view()}
  tabs={details && !error ? tabs : []}
  active={activeTab}
  onchange={(id) => (activeTab = id as InviteTab)}
>
  {#snippet badges()}
    {#if details?.invite}
      {#if details.invite.sourceLabel}<span class="badge badge-info"><Papicon icon="tag" size={11} />{details.invite.sourceLabel}</span>{/if}
      {#if details.invite.isSuspended}<span class="badge badge-warning">{m.d7_inv_suspended_label()}</span>{/if}
      {#if details.invite.isDeleted}<span class="badge badge-danger">{m.d7_inv_deleted_label()}</span>{/if}
      {#if details.invite.isTemporary}<span class="badge badge-neutral">{m.d7_inv_temporary()}</span>{/if}
    {/if}
  {/snippet}
  {#snippet actions()}
    <FilterPills label={m.d7_inv_joins_trend()} options={periodOptions} value={days} onchange={(value) => (days = value)} />
    <Button size="sm" icon="copy" onclick={copyInvite}>{m.d7_inv_copy_link()}</Button>
    <Button size="sm" variant="ghost" icon="x" aria-label={m.d7_inv_close_view()} onclick={closeModal} />
  {/snippet}

  {#if loading && !details}
    <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]" aria-busy="true">
      <div class="space-y-4">
        <div class="section-card h-64 animate-pulse"></div>
        <div class="section-card h-40 animate-pulse"></div>
      </div>
      <div class="section-card h-80 animate-pulse"></div>
    </div>
  {:else if error}
    <Callout variant="danger" title={m.d7_inv_load_error()}>{error}</Callout>
  {:else if details}
    <div class="space-y-4" class:opacity-60={loading}>

      <!-- ══════════════ RÉSUMÉ ══════════════ -->
      {#if activeTab === 'resume'}
        <div class="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div class="min-w-0 space-y-4">
            <SectionCard title={m.d7_inv_joins_trend()} description={m.d7_inv_period_evolution()}>
              <div class="space-y-3">
                <MetricTabs {metrics} active={activeMetric} onchange={(id) => (activeMetric = id as Metric)} compare label={m.d7_inv_joins_trend()} />
                {#if trendLabels.length > 0}
                  <TimeSeriesChart
                    labels={trendLabels}
                    mode={activeMetric === 'net' ? 'bar' : 'line'}
                    main={{ label: selected.label(), color: selected.color, values: series[activeMetric].cur }}
                    previous={series[activeMetric].prev.length ? { label: m.anx_trend_previous(), values: series[activeMetric].prev } : null}
                    format={fmtNumber}
                    height={220}
                  />
                {:else}
                  {@render empty(m.d7_inv_no_data_available())}
                {/if}
              </div>
            </SectionCard>

            {#if details.ranking}
              <SectionCard title={m.d7_inv_ranking_title()} description={m.d7_inv_ranking_subtitle()} flush>
                {#snippet actions()}
                  <span class="text-right">
                    <span class="block text-lg font-semibold tabular-nums text-on-surface">{details.ranking.rank ? `#${details.ranking.rank}` : '–'} <span class="text-xs text-on-surface-variant">/ {details.ranking.totalCodes}</span></span>
                    <span class="block text-xs text-on-surface-variant">{m.d7_inv_ranking_share({ pct: formatPct(details.ranking.sharePct) })}</span>
                  </span>
                {/snippet}
                {#if details.ranking.topCodes.length > 0}
                  <ul class="divide-y divide-outline-variant">
                    {#each details.ranking.topCodes as top, index (top.code)}
                      <li>
                        <button type="button" class="sheet-row justify-between {top.code === inviteCode ? 'bg-primary/5' : ''}" onclick={() => inviteDetailsModal.show(top.code)}>
                          <span class="text-sm"><span class="mr-2 tabular-nums text-on-surface-variant">{index + 1}</span><span class="font-mono {top.code === inviteCode ? 'text-primary' : 'text-on-surface'}">{top.code}</span></span>
                          <span class="text-sm tabular-nums text-on-surface-variant">{m.d7_inv_joins_count({ count: top.joins })}</span>
                        </button>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </SectionCard>
            {/if}
          </div>

          <div class="space-y-4">
            <SectionCard title={m.d7_inv_meta()}>
              {@render facts([
                { label: m.d7_inv_source_label(), value: details.invite?.sourceLabel || m.d7_inv_source_none() },
                { label: m.d7_inv_created_on(), value: formatDate(details.invite?.createdAt) },
                { label: m.d7_inv_uses(), value: fmtNumber(details.invite?.uses ?? 0) },
                { label: m.d7_inv_max(), value: details.invite?.maxUses ? String(details.invite.maxUses) : '∞' },
                { label: m.d7_inv_expires(), value: details.invite?.expiresAt ? formatDate(details.invite.expiresAt) : m.d7_never() },
              ])}
            </SectionCard>

            <SectionCard title={m.d7_inv_creator()}>
              {@render facts([
                { label: m.d7_inv_tag(), value: details.invite?.inviterTag || m.d7_unknown() },
                { label: m.d7_inv_id(), value: details.invite?.inviterId || '–' },
              ])}
              {#if details.invite?.inviterId}
                <div class="mt-4 flex flex-col gap-2">
                  <Button size="sm" icon="user" onclick={() => openMember(details.invite.inviterId)}>{m.d7_inv_open_creator()}</Button>
                  {#if canModerate}
                    <Button size="sm" variant="danger" icon="trash" onclick={purgeInviter}>{m.d7_inv_purge_cascade_btn()}</Button>
                  {/if}
                </div>
              {/if}
            </SectionCard>

            {#if canModerate}
              <SectionCard title={m.d7_inv_actions()}>
                <div class="flex flex-col gap-2">
                  <Button size="sm" icon={details.invite?.isSuspended ? 'play' : 'pause'} onclick={toggleSuspend}>
                    {details.invite?.isSuspended ? m.d7_inv_restore_btn() : m.d7_inv_suspend_btn()}
                  </Button>
                  <Button size="sm" variant="danger" icon="trash" onclick={purgeInvite}>{m.d7_inv_purge_btn()}</Button>
                  <Button size="sm" variant="danger" icon="x" onclick={deleteInvite}>{m.d7_inv_delete_btn()}</Button>
                </div>
              </SectionCard>
            {/if}
          </div>
        </div>

      <!-- ══════════════ RÉTENTION ══════════════ -->
      {:else if activeTab === 'retention'}
        {#if details.retention}
          {@const r = details.retention}
          <section class="section-card p-5">
            <dl class="sheet-kpis">
              <div><dt><Papicon icon="user-check" size={13} />{m.d7_inv_retention_rate()}</dt><dd class="text-success">{formatPct(r.retentionPct)}</dd><span>{m.d7_inv_retention_ratio({ stayed: r.stayed, total: r.total })}</span></div>
              <div><dt><Papicon icon="clock" size={13} />{m.d7_inv_avg_lifetime()}</dt><dd>{formatDays(r.avgLifetimeDays)}</dd><span>{m.d7_inv_median_lifetime({ value: formatDays(r.medianLifetimeDays) })}</span></div>
              <div><dt><Papicon icon="log-out" size={13} />{m.d7_inv_same_day_leavers()}</dt><dd>{r.sameDayLeavers}</dd><span>{formatPct(r.sameDayLeaversPct)}</span></div>
              <div><dt><Papicon icon="user-minus" size={13} />{m.d7_inv_departures()}</dt><dd class="text-error">{r.left}</dd><span>{m.d7_inv_total_joins({ count: r.total })}</span></div>
            </dl>
          </section>

          <SectionCard title={m.d7_inv_survival_title()} description={m.d7_inv_survival_subtitle()}>
            <div class="space-y-4">
              {#each [['d1', m.d7_inv_survival_d1()], ['d7', m.d7_inv_survival_d7()], ['d30', m.d7_inv_survival_d30()]] as [key, label] (key)}
                {@const bucket = r.survival[key]}
                {@render bar(label, bucket.rate === null ? m.d7_inv_survival_not_enough() : m.d7_inv_survival_value({ pct: bucket.rate, eligible: bucket.eligible }), bucket.rate ?? 0, 'var(--color-success, var(--primary-color))')}
              {/each}
            </div>
          </SectionCard>
        {:else}
          <SectionCard>{@render empty(m.d7_inv_no_data_available())}</SectionCard>
        {/if}

      <!-- ══════════════ QUALITÉ ══════════════ -->
      {:else if activeTab === 'qualite'}
        {#if details.quality}
          {@const q = details.quality}
          {@const msgDelta = deltaVsGuild(q.avgMessages, q.guildAvgMessages)}
          {@const lvlDelta = deltaVsGuild(q.avgLevel, q.guildAvgLevel)}

          {#if q.sampled}
            <Callout variant="warning">{m.d7_inv_quality_sampled({ count: q.analyzed })}</Callout>
          {/if}

          <section class="section-card p-5">
            <dl class="sheet-kpis">
              <div>
                <dt><Papicon icon="message-square" size={13} />{m.d7_inv_avg_messages()}</dt>
                <dd>{q.avgMessages ?? '–'}</dd>
                <span class={msgDelta === null ? '' : msgDelta >= 0 ? 'text-success' : 'text-error'}>{msgDelta === null ? m.d7_inv_no_comparison() : m.d7_inv_vs_guild({ delta: `${msgDelta > 0 ? '+' : ''}${msgDelta}` })}</span>
              </div>
              <div>
                <dt><Papicon icon="star" size={13} />{m.d7_inv_avg_level()}</dt>
                <dd>{q.avgLevel ?? '–'}</dd>
                <span class={lvlDelta === null ? '' : lvlDelta >= 0 ? 'text-success' : 'text-error'}>{lvlDelta === null ? m.d7_inv_no_comparison() : m.d7_inv_vs_guild({ delta: `${lvlDelta > 0 ? '+' : ''}${lvlDelta}` })}</span>
              </div>
              <div>
                <dt><Papicon icon="baby" size={13} />{m.d7_inv_young_accounts()}</dt>
                <dd>{q.youngAccounts}</dd>
                <span>{formatPct(q.youngAccountsPct)} · {m.d7_inv_young_hint()}</span>
              </div>
              <div>
                <dt><Papicon icon="gavel" size={13} />{m.d7_inv_sanctioned()}</dt>
                <dd class="text-error">{q.sanctionedMembers}</dd>
                <span>{m.d7_inv_sanctions_total({ count: q.sanctionsCount })}</span>
              </div>
            </dl>
          </section>

          <div class="grid gap-4 md:grid-cols-2">
            <SectionCard title={m.d7_inv_ghost_title()} description={m.d7_inv_ghost_subtitle()}>
              {#if ghostEntries.length > 0}
                <div class="space-y-3">
                  {#each ghostEntries as entry (entry.key)}
                    {@const pct = q.analyzed > 0 ? Math.round((entry.count / q.analyzed) * 100) : 0}
                    {@render bar(entry.label, `${entry.count} (${pct} %)`, pct)}
                  {/each}
                </div>
              {:else}
                {@render empty(m.d7_inv_no_data_available())}
              {/if}
              {#if q.bots > 0}
                <p class="mt-4 text-xs text-warning">{m.d7_inv_bots_detected({ count: q.bots })}</p>
              {/if}
            </SectionCard>

            <SectionCard title={m.d7_inv_top_sanctioned()} flush>
              {#if q.topSanctioned.length > 0}
                <ul class="divide-y divide-outline-variant">
                  {#each q.topSanctioned as row (row.userId)}
                    <li>
                      <button type="button" class="sheet-row justify-between" onclick={() => openMember(row.userId)}>
                        <span class="truncate text-sm text-on-surface">{row.userTag}</span>
                        <span class="text-sm tabular-nums text-error">{row.count}</span>
                      </button>
                    </li>
                  {/each}
                </ul>
              {:else}
                {@render empty(m.d7_inv_no_sanctioned())}
              {/if}
            </SectionCard>
          </div>
        {:else}
          <SectionCard>{@render empty(m.d7_inv_no_data_available())}</SectionCard>
        {/if}

      <!-- ══════════════ TEMPORALITÉ ══════════════ -->
      {:else if activeTab === 'temporalite'}
        <SectionCard title={m.d7_inv_cumulative_title()} description={m.d7_inv_cumulative_subtitle()}>
          {#if details.timing?.cumulative?.length}
            <TimeSeriesChart
              labels={(details.timing.labels ?? []).map((key: string) => shortDate(key))}
              mode="line"
              main={{ label: m.d7_inv_cumulative(), color: SERIES[0]!, values: details.timing.cumulative }}
              format={fmtNumber}
              height={220}
            />
          {:else}
            {@render empty(m.d7_inv_no_data_available())}
          {/if}
        </SectionCard>

        <div class="grid gap-4 md:grid-cols-2">
          <SectionCard title={m.d7_inv_hourly_title()}>
            {#snippet actions()}
              {#if details.timing?.peakHour !== null && details.timing?.peakHour !== undefined}
                <span class="badge badge-info">{m.d7_inv_peak_hour({ hour: String(details.timing.peakHour).padStart(2, '0') })}</span>
              {/if}
            {/snippet}
            {#if details.timing?.hourly?.length}
              <TimeSeriesChart
                labels={details.timing.hourly.map((_: number, hour: number) => `${String(hour).padStart(2, '0')}h`)}
                mode="bar"
                main={{ label: m.d7_inv_arrivals(), color: SERIES[0]!, values: details.timing.hourly }}
                format={fmtNumber}
                height={200}
              />
            {:else}
              {@render empty(m.d7_inv_no_data_available())}
            {/if}
          </SectionCard>

          <SectionCard title={m.d7_inv_weekday_title()}>
            {#snippet actions()}
              {#if details.timing?.peakWeekday !== null && details.timing?.peakWeekday !== undefined}
                <span class="badge badge-info">{m.d7_inv_peak_weekday({ day: weekdayNames[details.timing.peakWeekday] })}</span>
              {/if}
            {/snippet}
            {#if details.timing?.weekday?.length}
              <TimeSeriesChart
                labels={weekdayNames}
                mode="bar"
                main={{ label: m.d7_inv_arrivals(), color: SERIES[1]!, values: details.timing.weekday }}
                format={fmtNumber}
                height={200}
              />
            {:else}
              {@render empty(m.d7_inv_no_data_available())}
            {/if}
          </SectionCard>
        </div>

        <SectionCard title={m.d7_inv_source_title()} description={m.d7_inv_source_hint()}>
          <div class="flex flex-wrap gap-2">
            <input
              type="text"
              class="input min-w-50 flex-1"
              bind:value={sourceDraft}
              maxlength="60"
              disabled={!canModerate}
              placeholder={m.d7_inv_source_placeholder()}
              aria-label={m.d7_inv_source_title()}
            />
            {#if canModerate}
              <Button
                variant="primary"
                loading={sourceSaving}
                disabled={sourceDraft.trim() === (details.invite?.sourceLabel ?? '')}
                disabledReason={m.common_reason_fill_field()}
                onclick={saveSource}
              >{sourceSaving ? m.d7_inv_source_saving() : m.d7_inv_source_save()}</Button>
            {/if}
          </div>
        </SectionCard>

      <!-- ══════════════ INVITÉS ══════════════ -->
      {:else if activeTab === 'invites'}
        <SectionCard title={m.d7_inv_invited_people()} description={m.d7_inv_click_to_open()} flush>
          {#snippet actions()}
            <span class="badge badge-neutral">{m.d7_inv_entries({ count: filteredJoins.length })}</span>
            <Button size="sm" variant="ghost" icon="download" onclick={exportCsv}>CSV</Button>
            <Button size="sm" variant="ghost" icon="download" onclick={exportXlsx}>XLSX</Button>
          {/snippet}

          <div class="flex flex-wrap gap-2 border-b border-outline-variant px-5 py-3">
            <div class="relative min-w-50 flex-1">
              <span class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-on-surface-variant"><Papicon icon="search" size={15} /></span>
              <input type="search" class="input" style="padding-left: 2.25rem;" bind:value={joinSearch} oninput={() => (joinPage = 1)} placeholder={m.d7_inv_search_placeholder()} aria-label={m.d7_inv_search_placeholder()} />
            </div>
            <select class="input w-auto" bind:value={joinStatus} onchange={() => (joinPage = 1)} aria-label={m.d7_inv_status()}>
              <option value="all">{m.d7_inv_filter_all()}</option>
              <option value="present">{m.d7_inv_present()}</option>
              <option value="left">{m.d7_inv_left()}</option>
            </select>
            <select class="input w-auto" bind:value={joinSort} aria-label={m.d7_inv_sort_recent()}>
              <option value="recent">{m.d7_inv_sort_recent()}</option>
              <option value="oldest">{m.d7_inv_sort_oldest()}</option>
              <option value="messages">{m.d7_inv_sort_messages()}</option>
            </select>
          </div>

          {#if filteredJoins.length === 0}
            {@render empty(m.d7_inv_no_invited())}
          {:else}
            <ul class="divide-y divide-outline-variant">
              {#each pagedJoins as join (join.userId + join.joinedAt)}
                <li>
                  <button type="button" class="sheet-row" onclick={() => openMember(join.userId)}>
                    <img src={memberAvatarSrc(join.avatarUrl, join.userTag, join.userId)} alt="" class="h-9 w-9 shrink-0 rounded-lg object-cover" />
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-sm font-medium text-on-surface">{join.userTag}</span>
                      <span class="block truncate text-xs text-on-surface-variant">{formatDateTime(join.joinedAt)}</span>
                    </span>
                    <span class="shrink-0 text-right text-xs text-on-surface-variant">
                      <span class="block tabular-nums text-sm text-on-surface">{fmtNumber(join.messageCount ?? 0)}</span>
                      {m.d7_inv_messages_label()}
                    </span>
                    <span class="badge shrink-0 {join.leftAt ? 'badge-danger' : 'badge-success'}">{join.leftAt ? m.d7_inv_left() : m.d7_inv_present()}</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}

          {#if joinTotalPages > 1}
            <div class="flex items-center justify-between border-t border-outline-variant px-5 py-3">
              <Button size="sm" variant="ghost" icon="chevron-left" disabled={joinPage === 1} onclick={() => (joinPage = Math.max(1, joinPage - 1))}>{m.d7_inv_previous()}</Button>
              <span class="text-xs text-on-surface-variant">{m.d7_inv_page_of({ current: joinPage, total: joinTotalPages })}</span>
              <Button size="sm" variant="ghost" iconRight="chevron-right" disabled={joinPage === joinTotalPages} onclick={() => (joinPage = Math.min(joinTotalPages, joinPage + 1))}>{m.d7_inv_next()}</Button>
            </div>
          {/if}
        </SectionCard>
      {/if}
    </div>
  {/if}
</DetailSheet>
