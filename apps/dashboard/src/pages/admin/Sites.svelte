<script lang="ts">
  /**
   * Sites communautaires, vus par l'administration Kotbo : signalements reçus
   * (« Signaler ce site »), recherche d'un site, suspension motivée et levée.
   * Chaque décision part au journal d'audit.
   */
  import { onMount } from 'svelte';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import AdminCard from '../../lib/components/admin/AdminCard.svelte';
  import AdminTable from '../../lib/components/admin/AdminTable.svelte';
  import AdminToolbar from '../../lib/components/admin/AdminToolbar.svelte';
  import AdminBadge from '../../lib/components/admin/AdminBadge.svelte';
  import type { AdminTableColumn } from '../../lib/components/admin/types';
  import MetricTabs from '../../lib/components/analytics/MetricTabs.svelte';
  import { SERIES, fmtNumber } from '../../lib/components/analytics/analyticsFormat';
  import { Button, EmptyState, Field, FilterPills, Modal, type FilterOption } from '../../lib/components/ui';
  import { toast } from '../../lib/stores/toast.svelte';
  import { m, dateLocale } from '../../lib/i18n';
  import {
    fetchAdminSiteReports,
    fetchAdminSiteTemplates,
    fetchAdminSites,
    setAdminSiteTemplateHidden,
    type AdminSiteTemplate,
    setAdminSiteReportStatus,
    suspendAdminSite,
    unsuspendAdminSite,
    type AdminSiteReport,
    type AdminSiteRow,
  } from '../../lib/api/site';
  import { siteErrorMessage } from '../../lib/components/site/siteErrors';

  let reports = $state<AdminSiteReport[]>([]);
  let reportStatus = $state<'OPEN' | 'RESOLVED' | 'DISMISSED' | 'ALL'>('OPEN');
  let sites = $state<AdminSiteRow[]>([]);
  let templates = $state<AdminSiteTemplate[]>([]);
  let query = $state('');
  let loading = $state(true);
  let suspendTarget = $state<{ id: string; slug: string } | null>(null);
  let suspendOpen = $state(false);
  let suspendReason = $state('');
  let busy = $state(false);

  const statusFilters: FilterOption[] = [
    { value: 'OPEN', label: m.ste_admin_open() },
    { value: 'RESOLVED', label: m.ste_admin_resolved() },
    { value: 'DISMISSED', label: m.ste_admin_dismissed() },
    { value: 'ALL', label: m.ste_admin_all() },
  ];

  const REASONS: Record<string, () => string> = {
    scam: () => m.ste_report_scam(),
    illegal: () => m.ste_report_illegal(),
    hate: () => m.ste_report_hate(),
    impersonation: () => m.ste_report_impersonation(),
    other: () => m.ste_report_other(),
  };

  async function loadReports() {
    try {
      reports = (await fetchAdminSiteReports(reportStatus))?.reports ?? [];
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  async function loadSites() {
    try {
      sites = (await fetchAdminSites(query.trim()))?.sites ?? [];
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  async function loadTemplates() {
    try {
      templates = (await fetchAdminSiteTemplates())?.templates ?? [];
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  async function setTemplateHidden(template: AdminSiteTemplate, hidden: boolean) {
    try {
      await setAdminSiteTemplateHidden(template.id, hidden);
      await loadTemplates();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  onMount(async () => {
    await Promise.all([loadReports(), loadSites(), loadTemplates()]);
    loading = false;
  });

  async function setReport(report: AdminSiteReport, status: 'RESOLVED' | 'DISMISSED' | 'OPEN') {
    try {
      await setAdminSiteReportStatus(report.id, status);
      await loadReports();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  function askSuspend(id: string, slug: string) {
    suspendTarget = { id, slug };
    suspendReason = '';
    suspendOpen = true;
  }

  async function suspend() {
    if (!suspendTarget || !suspendReason.trim()) return;
    busy = true;
    try {
      await suspendAdminSite(suspendTarget.id, suspendReason.trim());
      toast.success(m.ste_admin_suspended());
      suspendOpen = false;
      await Promise.all([loadReports(), loadSites()]);
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      busy = false;
    }
  }

  async function unsuspend(site: AdminSiteRow) {
    try {
      await unsuspendAdminSite(site.id);
      toast.success(m.ste_admin_unsuspended());
      await loadSites();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  const when = (iso: string) => new Date(iso).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' });

  const reportColumns: AdminTableColumn[] = [
    { key: 'reason', label: 'Signalement' },
    { key: 'site', label: 'Site', hideBelow: 'sm' },
    { key: 'date', label: 'Reçu le', hideBelow: 'md' },
    { key: 'actions', label: '', align: 'right' },
  ];

  const siteColumns: AdminTableColumn[] = [
    { key: 'site', label: 'Site' },
    { key: 'state', label: 'État', hideBelow: 'sm' },
    { key: 'counts', label: 'Contenu', hideBelow: 'md' },
    { key: 'actions', label: '', align: 'right', width: 'w-32' },
  ];

  const publishedCount = $derived(sites.filter((s) => s.published && !s.suspendedAt).length);
  const suspendedCount = $derived(sites.filter((s) => Boolean(s.suspendedAt)).length);
</script>

<AdminShell title={m.ste_admin_title()} description={m.ste_admin_desc()}>
  <MetricTabs
    interactive={false}
    active=""
    onchange={() => {}}
    label="Indicateurs des sites"
    metrics={[
      { id: 'reports', label: m.ste_admin_reports(), value: fmtNumber(reports.length), color: SERIES[3] },
      { id: 'sites', label: m.ste_admin_sites(), value: fmtNumber(sites.length), color: SERIES[0] },
      { id: 'online', label: m.ste_site_online(), value: fmtNumber(publishedCount), color: SERIES[1] },
      { id: 'suspended', label: 'Suspendus', value: fmtNumber(suspendedCount), color: SERIES[2] },
    ]}
  />

  <AdminCard title={m.ste_admin_reports()} padded={false}>
    {#snippet actions()}
      <FilterPills
        label={m.ste_admin_reports()}
        options={statusFilters}
        value={reportStatus}
        onchange={(v) => {
          reportStatus = v as typeof reportStatus;
          void loadReports();
        }}
      />
    {/snippet}

    {#if !loading && reports.length === 0}
      <div class="p-6">
        <EmptyState icon="shield-check" title={m.ste_admin_no_reports()} description="" reason="all-clear" />
      </div>
    {:else}
      <AdminTable columns={reportColumns} rows={reports} {loading} emptyTitle={m.ste_admin_no_reports()}>
        {#snippet row(item, _index)}
          {@const report = item as AdminSiteReport}
          <tr class="border-b border-outline-variant/60 hover:bg-on-surface/3 transition-colors">
            <td class="px-4 py-3 min-w-0">
              <p class="text-body-sm font-medium text-on-surface">
                {REASONS[report.reason]?.() ?? report.reason} ·
                <a class="underline hover:text-primary" href={report.path} target="_blank" rel="noopener">{report.path}</a>
              </p>
              {#if report.details}
                <p class="text-xs text-on-surface-variant whitespace-pre-line mt-0.5">{report.details}</p>
              {/if}
            </td>
            <td class="px-4 py-3 hidden sm:table-cell">
              <span class="font-mono text-xs text-on-surface">/s/{report.site.slug}</span>
              {#if report.site.suspendedAt}
                <span class="ml-1.5"><AdminBadge size="sm" tone="danger" label={m.ste_admin_is_suspended()} /></span>
              {/if}
            </td>
            <td class="px-4 py-3 text-xs text-on-surface-variant hidden md:table-cell">{when(report.createdAt)}</td>
            <td class="px-4 py-3 text-right">
              <div class="inline-flex gap-1.5 flex-wrap justify-end">
                {#if report.status === 'OPEN'}
                  {#if !report.site.suspendedAt}
                    <Button size="sm" variant="danger" onclick={() => askSuspend(report.siteId, report.site.slug)}>{m.ste_admin_suspend()}</Button>
                  {/if}
                  <Button size="sm" onclick={() => setReport(report, 'RESOLVED')}>{m.ste_admin_resolve()}</Button>
                  <Button size="sm" variant="ghost" onclick={() => setReport(report, 'DISMISSED')}>{m.ste_admin_dismiss()}</Button>
                {:else}
                  <Button size="sm" variant="ghost" onclick={() => setReport(report, 'OPEN')}>{m.ste_admin_reopen()}</Button>
                {/if}
              </div>
            </td>
          </tr>
        {/snippet}
      </AdminTable>
    {/if}
  </AdminCard>

  <AdminCard title={m.ste_admin_templates()} description={m.ste_admin_templates_desc()} padded={false}>
    {#if templates.length === 0}
      <div class="p-6"><EmptyState icon="shield-check" title={m.ste_admin_no_templates()} description="" reason="all-clear" /></div>
    {:else}
      <ul class="divide-y divide-outline-variant/40">
        {#each templates as template (template.id)}
          <li class="flex items-center gap-3 px-5 py-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <p class="text-body-sm text-on-surface font-medium truncate">{template.name}</p>
                {#if template.hidden}
                  <AdminBadge size="sm" tone="warning" label={m.ste_admin_template_hidden()} />
                {/if}
              </div>
              <p class="text-2xs text-on-surface-variant mt-0.5">
                {m.ste_admin_template_meta({ reports: template.reporterIds.length, uses: template.uses, guild: template.authorGuildId })} · {when(template.createdAt)}
              </p>
            </div>
            {#if template.hidden}
              <Button size="sm" onclick={() => setTemplateHidden(template, false)}>{m.ste_admin_template_show()}</Button>
            {:else}
              <Button size="sm" variant="danger" onclick={() => setTemplateHidden(template, true)}>{m.ste_admin_template_hide()}</Button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </AdminCard>

  <div class="space-y-3">
    <AdminToolbar
      bind:search={query}
      placeholder={m.ste_admin_search()}
      resultCount={sites.length}
      resultLabel="site"
    >
      {#snippet actions()}
        <Button size="sm" variant="secondary" icon="search" onclick={loadSites}>{m.ste_admin_search_button()}</Button>
      {/snippet}
    </AdminToolbar>

    <AdminTable columns={siteColumns} rows={sites} {loading} emptyTitle={m.ste_admin_sites()}>
      {#snippet row(item, _index)}
        {@const site = item as AdminSiteRow}
        <tr class="border-b border-outline-variant/60 hover:bg-on-surface/3 transition-colors">
          <td class="px-4 py-3 min-w-0">
            <a class="font-semibold text-on-surface hover:text-primary hover:underline" href={`/s/${site.slug}`} target="_blank" rel="noopener">/s/{site.slug}</a>
            <p class="text-xs text-on-surface-variant truncate">{site.guildName ?? site.guildId}</p>
          </td>
          <td class="px-4 py-3 hidden sm:table-cell">
            {#if site.suspendedAt}
              <AdminBadge size="sm" tone="danger" label={m.ste_admin_is_suspended()} />
              {#if site.suspendedReason}
                <p class="text-2xs text-on-surface-variant mt-1 truncate max-w-56">{site.suspendedReason}</p>
              {/if}
            {:else}
              <AdminBadge size="sm" tone={site.published ? 'success' : 'neutral'} label={site.published ? m.ste_site_online() : m.ste_site_offline()} dot />
            {/if}
          </td>
          <td class="px-4 py-3 text-xs text-on-surface-variant hidden md:table-cell">
            {m.ste_admin_pages({ count: site._count.pages })} · {m.ste_admin_open_reports({ count: site._count.reports })}
          </td>
          <td class="px-4 py-3 text-right">
            {#if site.suspendedAt}
              <Button size="sm" onclick={() => unsuspend(site)}>{m.ste_admin_unsuspend()}</Button>
            {:else}
              <Button size="sm" variant="danger" onclick={() => askSuspend(site.id, site.slug)}>{m.ste_admin_suspend()}</Button>
            {/if}
          </td>
        </tr>
      {/snippet}
    </AdminTable>
  </div>
</AdminShell>

<Modal bind:open={suspendOpen} title={m.ste_admin_suspend_title({ slug: suspendTarget?.slug ?? '' })} subtitle={m.ste_admin_suspend_desc()} size="md">
  <Field label={m.ste_admin_reason()} required>
    {#snippet children(id)}
      <textarea {id} class="input w-full" rows="3" maxlength="500" bind:value={suspendReason}></textarea>
    {/snippet}
  </Field>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (suspendOpen = false)}>{m.common_cancel()}</Button>
    <Button variant="danger" loading={busy} disabled={!suspendReason.trim()} onclick={suspend}>{m.ste_admin_suspend()}</Button>
  {/snippet}
</Modal>
