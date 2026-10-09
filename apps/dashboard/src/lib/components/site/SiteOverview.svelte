<script lang="ts">
  /**
   * Aperçu du site : en ligne ou non, adresse, fréquentation récente, pages à
   * reprendre, et la fiche de la personne connectée pour la page Équipe.
   */
  import { onMount } from 'svelte';
  import { Button, Field, SectionCard, ToggleSwitch } from '../ui';
  import { toast } from '../../stores/toast.svelte';
  import { m, dateLocale } from '../../i18n';
  import {
    fetchSiteAnalytics,
    fetchSiteStaffProfile,
    updateSite,
    updateSiteStaffProfile,
    type SiteAnalyticsReport,
    type SitePageSummary,
    type SiteState,
  } from '../../api/site';
  import { siteErrorMessage } from './siteErrors';

  let { siteState, guildId, onChanged }: { siteState: SiteState; guildId: string; onChanged: () => void } = $props();

  const site = $derived(siteState.site!);
  const url = $derived(`${siteState.baseUrl}${site.slug}`);
  let publishing = $state(false);
  let report = $state<SiteAnalyticsReport | null>(null);
  let profile = $state<{ isStaff: boolean; bio: string; hidden: boolean } | null>(null);
  let savingProfile = $state(false);

  onMount(async () => {
    const [r, p] = await Promise.all([
      siteState.rights.viewStats ? fetchSiteAnalytics(7, guildId).catch(() => null) : Promise.resolve(null),
      fetchSiteStaffProfile(guildId).catch(() => null),
    ]);
    report = r?.report ?? null;
    profile = p?.profile ?? null;
  });

  async function setPublished(value: boolean) {
    publishing = true;
    try {
      await updateSite({ published: value }, guildId);
      toast.success(value ? m.ste_site_online_toast() : m.ste_site_offline_toast());
      onChanged();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      publishing = false;
    }
  }

  async function copy() {
    await navigator.clipboard?.writeText(url);
    toast.success(m.ste_link_copied());
  }

  async function saveProfile() {
    if (!profile) return;
    savingProfile = true;
    try {
      const saved = await updateSiteStaffProfile({ bio: profile.bio, hidden: profile.hidden }, guildId);
      profile = { ...profile, ...saved.profile };
      toast.success(m.ste_profile_saved());
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      savingProfile = false;
    }
  }

  const counts = $derived({
    PAGE: siteState.pages.filter((p) => p.kind === 'PAGE').length,
    WIKI: siteState.pages.filter((p) => p.kind === 'WIKI').length,
    BLOG: siteState.pages.filter((p) => p.kind === 'BLOG').length,
  });

  const toResume = $derived(
    siteState.pages
      .filter((p) => p.hasUnpublishedChanges || p.scheduledAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 6),
  );

  function delta(now: number, before: number): string {
    if (!before) return now ? '+∞' : '0';
    const pct = Math.round(((now - before) / before) * 100);
    return `${pct > 0 ? '+' : ''}${pct} %`;
  }

  const kindLabel = (p: SitePageSummary) => (p.kind === 'WIKI' ? m.ste_kind_wiki() : p.kind === 'BLOG' ? m.ste_kind_blog() : m.ste_kind_page());
</script>

<div class="overview">
  <SectionCard>
    <div class="px-5 py-5 flex flex-wrap items-center justify-between gap-4">
      <div class="min-w-0">
        <p class="text-2xs uppercase tracking-wider text-on-surface-variant">{m.ste_site_address()}</p>
        <a class="text-body font-semibold text-on-surface break-all" href={url} target="_blank" rel="noopener">{url}</a>
        <p class="text-body-sm text-on-surface-variant mt-1">{site.published ? m.ste_site_online_desc() : m.ste_site_offline_desc()}</p>
      </div>
      <div class="flex items-center gap-3">
        <Button size="sm" variant="ghost" icon="copy" onclick={copy}>{m.ste_copy_link()}</Button>
        {#if siteState.rights.manage}
          <ToggleSwitch checked={site.published} disabled={publishing || !!site.suspendedAt} ariaLabel={m.ste_site_online_label()} onToggle={setPublished} />
          <span class="text-body-sm text-on-surface">{site.published ? m.ste_site_online() : m.ste_site_offline()}</span>
        {/if}
      </div>
    </div>
  </SectionCard>

  <div class="bento-row">
    <SectionCard title={m.ste_overview_content()} icon="file-text">
      <ul class="px-5 pb-5 counts">
        <li><strong>{counts.PAGE}</strong><span>{m.ste_kind_pages()}</span></li>
        {#if siteState.modules.site_wiki}<li><strong>{counts.WIKI}</strong><span>{m.ste_kind_wiki()}</span></li>{/if}
        {#if siteState.modules.site_blog}<li><strong>{counts.BLOG}</strong><span>{m.ste_kind_blog()}</span></li>{/if}
      </ul>
    </SectionCard>

    {#if report}
      <SectionCard title={m.ste_overview_traffic()} icon="trending-up">
        <ul class="px-5 pb-5 counts">
          <li><strong>{report.totals.views}</strong><span>{m.ste_views()} · {delta(report.totals.views, report.previous.views)}</span></li>
          <li><strong>{report.totals.visitors}</strong><span>{m.ste_visitors()} · {delta(report.totals.visitors, report.previous.visitors)}</span></li>
        </ul>
      </SectionCard>
    {/if}
  </div>

  {#if toResume.length > 0}
    <SectionCard title={m.ste_overview_resume()} description={m.ste_overview_resume_desc()} icon="edit-2">
      <ul class="px-5 pb-5 resume">
        {#each toResume as page (page.id)}
          <li>
            <a href={`/site/edit/${page.id}`}>
              <span class="font-medium text-on-surface">{page.title}</span>
              <span class="text-2xs text-on-surface-variant">{kindLabel(page)} · {page.scheduledAt ? m.ste_status_scheduled({ date: new Date(page.scheduledAt).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' }) }) : page.publishedAt ? m.ste_status_changes() : m.ste_status_draft()}</span>
            </a>
          </li>
        {/each}
      </ul>
    </SectionCard>
  {/if}

  {#if profile?.isStaff}
    <SectionCard title={m.ste_profile_title()} description={m.ste_profile_desc()} icon="user">
      <div class="px-5 pb-5 space-y-4">
        <Field label={m.ste_profile_bio()} hint={m.ste_profile_bio_hint()}>
          {#snippet children(id, describedBy)}
            <textarea {id} aria-describedby={describedBy} class="input w-full" rows="3" maxlength="400" bind:value={profile!.bio}></textarea>
          {/snippet}
        </Field>
        <label class="flex items-center gap-3 text-body-sm text-on-surface">
          <ToggleSwitch size="sm" checked={profile.hidden} ariaLabel={m.ste_profile_hidden()} onToggle={(v) => (profile!.hidden = v)} />
          {m.ste_profile_hidden()}
        </label>
        <div class="flex justify-end"><Button size="sm" variant="primary" loading={savingProfile} onclick={saveProfile}>{m.common_save()}</Button></div>
      </div>
    </SectionCard>
  {/if}
</div>

<style>
  .overview { display: flex; flex-direction: column; gap: 16px; }
  .bento-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
  .counts { list-style: none; margin: 0; display: flex; flex-wrap: wrap; gap: 24px; }
  .counts li { display: flex; flex-direction: column; }
  .counts strong { font-size: 1.6rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .counts span { font-size: 0.8rem; color: rgb(255 255 255 / 0.55); }
  .resume { list-style: none; margin: 0; display: flex; flex-direction: column; gap: 6px; }
  .resume a { display: flex; flex-direction: column; padding: 8px 10px; border-radius: 10px; text-decoration: none; }
  .resume a:hover { background: rgb(255 255 255 / 0.05); }
</style>
