<script lang="ts">
  /**
   * Sites communautaires, vus par l'administration Kotbo : signalements reçus
   * (« Signaler ce site »), recherche d'un site, suspension motivée et levée.
   * Chaque décision part au journal d'audit.
   */
  import { onMount } from 'svelte';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import { Button, EmptyState, Field, FilterPills, Modal, SectionCard, type FilterOption } from '../../lib/components/ui';
  import { toast } from '../../lib/stores/toast.svelte';
  import { m, dateLocale } from '../../lib/i18n';
  import {
    fetchAdminSiteReports,
    fetchAdminSites,
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
  let query = $state('');
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
      reports = (await fetchAdminSiteReports(reportStatus)).reports;
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  async function loadSites() {
    try {
      sites = (await fetchAdminSites(query.trim())).sites;
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  onMount(() => {
    void loadReports();
    void loadSites();
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
</script>

<AdminShell title={m.ste_admin_title()} description={m.ste_admin_desc()}>
  <div class="space-y-6">
    <SectionCard title={m.ste_admin_reports()} flush>
      {#snippet actions()}
        <FilterPills label={m.ste_admin_reports()} options={statusFilters} value={reportStatus} onchange={(v) => { reportStatus = v as typeof reportStatus; void loadReports(); }} />
      {/snippet}
      {#if reports.length === 0}
        <div class="p-6"><EmptyState icon="shield-check" title={m.ste_admin_no_reports()} description="" /></div>
      {:else}
        <ul class="admin-list">
          {#each reports as report (report.id)}
            <li>
              <div class="min-w-0 flex-1">
                <p class="text-body-sm text-on-surface font-medium">{REASONS[report.reason]?.() ?? report.reason} · <a class="underline" href={report.path} target="_blank" rel="noopener">{report.path}</a></p>
                {#if report.details}<p class="text-body-sm text-on-surface-variant whitespace-pre-line">{report.details}</p>{/if}
                <p class="text-2xs text-on-surface-variant">{when(report.createdAt)} · /s/{report.site.slug}{report.site.suspendedAt ? ` · ${m.ste_admin_is_suspended()}` : ''}</p>
              </div>
              <div class="flex gap-1 flex-none flex-wrap justify-end">
                {#if report.status === 'OPEN'}
                  {#if !report.site.suspendedAt}<Button size="sm" variant="danger" onclick={() => askSuspend(report.siteId, report.site.slug)}>{m.ste_admin_suspend()}</Button>{/if}
                  <Button size="sm" onclick={() => setReport(report, 'RESOLVED')}>{m.ste_admin_resolve()}</Button>
                  <Button size="sm" variant="ghost" onclick={() => setReport(report, 'DISMISSED')}>{m.ste_admin_dismiss()}</Button>
                {:else}
                  <Button size="sm" variant="ghost" onclick={() => setReport(report, 'OPEN')}>{m.ste_admin_reopen()}</Button>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </SectionCard>

    <SectionCard title={m.ste_admin_sites()} flush>
      {#snippet actions()}
        <form class="flex gap-2" onsubmit={(e) => { e.preventDefault(); void loadSites(); }}>
          <input class="input input-sm w-56" type="search" placeholder={m.ste_admin_search()} aria-label={m.ste_admin_search()} bind:value={query} />
          <Button size="sm" type="submit" icon="search">{m.ste_admin_search_button()}</Button>
        </form>
      {/snippet}
      <ul class="admin-list">
        {#each sites as site (site.id)}
          <li>
            <div class="min-w-0 flex-1">
              <p class="text-body-sm text-on-surface font-medium">
                <a class="underline" href={`/s/${site.slug}`} target="_blank" rel="noopener">/s/{site.slug}</a>
                · {site.guildName ?? site.guildId}
              </p>
              <p class="text-2xs text-on-surface-variant">
                {site.published ? m.ste_site_online() : m.ste_site_offline()} · {m.ste_admin_pages({ count: site._count.pages })} · {m.ste_admin_open_reports({ count: site._count.reports })}
                {#if site.suspendedAt} · {m.ste_admin_is_suspended()} : {site.suspendedReason}{/if}
              </p>
            </div>
            {#if site.suspendedAt}
              <Button size="sm" onclick={() => unsuspend(site)}>{m.ste_admin_unsuspend()}</Button>
            {:else}
              <Button size="sm" variant="danger" onclick={() => askSuspend(site.id, site.slug)}>{m.ste_admin_suspend()}</Button>
            {/if}
          </li>
        {/each}
      </ul>
    </SectionCard>
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

<style>
  .admin-list { list-style: none; margin: 0; padding: 0; }
  .admin-list li { display: flex; gap: 12px; align-items: center; padding: 12px 16px; border-top: 1px solid rgb(255 255 255 / 0.06); }
</style>
