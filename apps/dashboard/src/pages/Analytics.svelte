<script lang="ts">
  /**
   * Page Analytics : huit sections dans une barre latérale repliable (des onglets sur
   * mobile), chacune découpée en sous-onglets comme les autres pages. L'adresse
   * porte le sous-onglet (/analytics/emojis), la section s'en déduit : les
   * anciens liens d'onglets restent valables.
   *
   * Chaque sous-onglet dit ce qu'il suit : tous les filtres, la période seule,
   * ou sa propre fenêtre de temps (la barre de filtres est alors masquée).
   * Les anciens composants qui dépendent de la grosse réponse /analytics la
   * reçoivent d'ici, chargée seulement quand un sous-onglet en a besoin.
   */
  import { untrack } from 'svelte';
  import { router } from 'tinro';
  import { canViewFeature } from '../lib/permissions.svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { downloadXlsx } from '../lib/xlsxExport';
  import { gotoTab, resolveTabFromUrl } from '../lib/tabRouting';
  import { m, dateLocale } from '../lib/i18n';
  import { errorMessage } from '@kotbo/shared';
  import { fetchAnalytics, fetchGlobalInteractions, fetchMemberCase } from '../lib/api';
  import Papicon from '../lib/components/Papicon.svelte';
  import MemberCaseModal from '../lib/components/MemberCaseModal.svelte';
  import { Button, Callout, SectionCard, Tabs } from '../lib/components/ui';
  import ExportDropdown from '../lib/components/analytics/ExportDropdown.svelte';
  import AnalyticsFilterBar from '../lib/components/analytics/AnalyticsFilterBar.svelte';
  import AnalyticsSkeleton from '../lib/components/analytics/AnalyticsSkeleton.svelte';
  import OverviewSection from '../lib/components/analytics/OverviewSection.svelte';
  import ActivitySection, { type ActivityView } from '../lib/components/analytics/ActivitySection.svelte';
  import ContentSection, { type ContentView } from '../lib/components/analytics/ContentSection.svelte';
  import ChannelsSection from '../lib/components/analytics/ChannelsSection.svelte';
  import GrowthSection from '../lib/components/analytics/GrowthSection.svelte';
  import KpiTile from '../lib/components/analytics/KpiTile.svelte';
  import MembersView from '../lib/components/analytics/MembersView.svelte';
  import GhostMembersPanel from '../lib/components/analytics/GhostMembersPanel.svelte';
  import EngagementView from '../lib/components/analytics/EngagementView.svelte';
  import LifecycleView from '../lib/components/analytics/LifecycleView.svelte';
  import FunnelView from '../lib/components/analytics/FunnelView.svelte';
  import CohortTriangle from '../lib/components/analytics/CohortTriangle.svelte';
  import ResponseTimesView from '../lib/components/analytics/ResponseTimesView.svelte';
  import ConcentrationView from '../lib/components/analytics/ConcentrationView.svelte';
  import ClimateView from '../lib/components/analytics/ClimateView.svelte';
  import ChannelHealthView from '../lib/components/analytics/ChannelHealthView.svelte';
  import NetworkInsightsView from '../lib/components/analytics/NetworkInsightsView.svelte';
  import GrowthInsightsView from '../lib/components/analytics/GrowthInsightsView.svelte';
  import ModerationTrendsView from '../lib/components/analytics/ModerationTrendsView.svelte';
  import StaffInsightsView from '../lib/components/analytics/StaffInsightsView.svelte';
  import RisingWordsView from '../lib/components/analytics/RisingWordsView.svelte';
  import LivePanel from '../lib/components/analytics/LivePanel.svelte';
  import AlertsView from '../lib/components/analytics/AlertsView.svelte';
  import CompareView from '../lib/components/analytics/CompareView.svelte';
  import SavedViewsMenu from '../lib/components/analytics/SavedViewsMenu.svelte';
  import ReportsView from '../lib/components/analytics/ReportsView.svelte';
  import AdvancedAnalyticsPanel from '../lib/components/analytics/AdvancedAnalyticsPanel.svelte';
  import ModerationAudit from '../lib/components/analytics/ModerationAudit.svelte';
  import StaffAudit from '../lib/components/analytics/StaffAudit.svelte';
  import StaffPerformance from '../lib/components/analytics/StaffPerformance.svelte';
  import GlobalInteractionGraph from '../lib/components/charts/GlobalInteractionGraph.svelte';
  import { analyticsExport, analyticsFilters as filters } from '../lib/components/analytics/analyticsFilters.svelte';
  import { fmtNumber } from '../lib/components/analytics/analyticsFormat';

  /** Ce que suit un sous-onglet : tous les filtres, la période, ou sa propre fenêtre. */
  type Scope = 'full' | 'period' | 'own';

  interface SubTab {
    id: string;
    label: string;
    icon: string;
    scope: Scope;
    /** A besoin de la réponse /analytics historique. */
    legacy?: boolean;
  }

  interface Section {
    id: string;
    label: string;
    icon: string;
    description: string;
    isNew?: boolean;
    tabs: SubTab[];
  }

  const sections: Section[] = $derived([
    {
      id: 'overview', label: m.an_tab_overview(), icon: 'Grid', description: m.anx_section_overview_desc(),
      tabs: [{ id: 'overview', label: m.an_tab_overview(), icon: 'Grid', scope: 'full', legacy: true }],
    },
    {
      id: 'activity', label: m.anx_section_activity(), icon: 'Activity', description: m.anx_section_activity_desc(),
      tabs: [
        { id: 'messages', label: m.an_tab_messages(), icon: 'ChatCircleDots', scope: 'full' },
        { id: 'voice', label: m.an_tab_voice(), icon: 'Microphone', scope: 'full', legacy: true },
        { id: 'live', label: m.anx_tab_live(), icon: 'Radio', scope: 'own' },
        { id: 'compare', label: m.anx_tab_compare(), icon: 'GitCompare', scope: 'period' },
        { id: 'heatmap', label: m.an_tab_heatmap(), icon: 'Fire', scope: 'period' },
        { id: 'pulse', label: m.an_tab_pulse(), icon: 'Activity', scope: 'own' },
        { id: 'weekly', label: m.an_tab_weekly(), icon: 'Calendar', scope: 'own' },
        { id: 'commands', label: m.an_tab_commands(), icon: 'Code', scope: 'period' },
        { id: 'algo', label: m.an_tab_algo(), icon: 'Code', scope: 'period' },
      ],
    },
    {
      id: 'content', label: m.anx_section_content(), icon: 'ChatCircleDots', description: m.anx_section_content_desc(), isNew: true,
      tabs: [
        { id: 'content', label: m.anx_tab_content_overview(), icon: 'Grid', scope: 'full' },
        { id: 'emojis', label: m.anx_tab_emojis(), icon: 'Smile', scope: 'full' },
        { id: 'stickers', label: m.anx_tab_stickers(), icon: 'image', scope: 'full' },
        { id: 'gifs', label: m.anx_tab_gifs(), icon: 'Lightning', scope: 'full' },
        { id: 'sites', label: m.anx_tab_sites(), icon: 'link', scope: 'full' },
        { id: 'formatting', label: m.anx_tab_formatting(), icon: 'Type', scope: 'full' },
        { id: 'words', label: m.an_tab_words(), icon: 'ChatCircleDots', scope: 'period' },
      ],
    },
    {
      id: 'channels', label: m.anx_section_channels(), icon: 'ChatBubbles', description: m.anx_section_channels_desc(),
      tabs: [
        { id: 'channels', label: m.anx_tab_channel_tree(), icon: 'ChatBubbles', scope: 'period' },
        { id: 'responses', label: m.anx_tab_responses(), icon: 'Clock', scope: 'full' },
        { id: 'channel-health', label: m.anx_channels_health_title(), icon: 'heart', scope: 'period' },
      ],
    },
    {
      id: 'members', label: m.an_tab_members(), icon: 'UsersFour', description: m.anx_section_members_desc(),
      tabs: [
        { id: 'members', label: m.an_tab_members(), icon: 'UsersFour', scope: 'period', legacy: true },
        { id: 'engagement', label: m.anx_tab_engagement(), icon: 'Activity', scope: 'full' },
        { id: 'lifecycle', label: m.anx_tab_lifecycle(), icon: 'Users', scope: 'full' },
        { id: 'concentration', label: m.anx_tab_concentration(), icon: 'PieChart', scope: 'full' },
        { id: 'interactions', label: m.an_tab_network(), icon: 'Compass', scope: 'period' },
        { id: 'social', label: m.an_tab_social(), icon: 'Users', scope: 'own' },
        { id: 'ghosts', label: m.ghost_tab(), icon: 'Ghost', scope: 'own' },
      ],
    },
    {
      id: 'growth', label: m.anx_section_growth(), icon: 'TrendingUp', description: m.anx_section_growth_desc(),
      tabs: [
        { id: 'growth', label: m.anx_tab_growth(), icon: 'TrendingUp', scope: 'period', legacy: true },
        { id: 'funnel', label: m.anx_tab_funnel(), icon: 'Filter', scope: 'full' },
        { id: 'cohorts', label: m.an_tab_cohorts(), icon: 'UsersFour', scope: 'own' },
        { id: 'churn', label: m.an_tab_churn(), icon: 'Warning', scope: 'own' },
      ],
    },
    {
      id: 'moderation', label: m.an_tab_moderation(), icon: 'Gavel', description: m.anx_section_moderation_desc(),
      tabs: [
        { id: 'moderation', label: m.an_tab_moderation(), icon: 'Gavel', scope: 'period', legacy: true },
        { id: 'mod-advanced', label: m.an_tab_mod_advanced(), icon: 'ChartLineUp', scope: 'own' },
      ],
    },
    {
      id: 'climate', label: m.anx_section_climate(), icon: 'sparkles', description: m.anx_section_climate_desc(), isNew: true,
      tabs: [{ id: 'climate', label: m.anx_tab_climate(), icon: 'sparkles', scope: 'period' }],
    },
    {
      id: 'staff', label: m.anx_section_staff(), icon: 'Users', description: m.anx_section_staff_desc(),
      tabs: [
        { id: 'staff', label: m.an_tab_staff_directory(), icon: 'Users', scope: 'period', legacy: true },
        { id: 'performance', label: m.an_tab_staff_performance(), icon: 'TrendUp', scope: 'period', legacy: true },
        { id: 'tickets', label: m.anx_tab_tickets(), icon: 'Ticket', scope: 'period' },
      ],
    },
    {
      id: 'automation', label: m.anx_section_automation(), icon: 'Bell', description: m.anx_section_automation_desc(),
      tabs: [
        { id: 'alerts', label: m.anx_tab_alerts(), icon: 'Bell', scope: 'own' },
        { id: 'reports', label: m.anx_tab_reports(), icon: 'Mail', scope: 'own' },
      ],
    },
  ]);

  const allTabIds = $derived(sections.flatMap((s) => s.tabs.map((t) => t.id)));

  /** Anciens onglets partis sur leur propre page. */
  const MOVED_TO_PAGE: Record<string, string> = { invitations: '/invitations' };

  let activeTab = $state('overview');

  $effect(() => {
    const path = $router.path;
    const prefix = '/analytics/';
    if (path.startsWith(prefix)) {
      const segment = decodeURIComponent(path.slice(prefix.length).split('/')[0] ?? '');
      if (MOVED_TO_PAGE[segment]) {
        router.goto(MOVED_TO_PAGE[segment]!, true);
        return;
      }
    }
    activeTab = resolveTabFromUrl('/analytics', allTabIds, 'overview', path);
  });

  const section = $derived(sections.find((s) => s.tabs.some((t) => t.id === activeTab)) ?? sections[0]!);
  const tab = $derived(section.tabs.find((t) => t.id === activeTab) ?? section.tabs[0]!);

  // ── Barre latérale repliable ───────────────────────────────────────────────
  // Dépliée sur grand écran, repliée en icônes en dessous, sauf choix manuel
  // retenu dans le navigateur.
  const SIDEBAR_KEY = 'kotbo.analytics.sidebar';

  function readSidebarChoice(): 'open' | 'closed' | null {
    try {
      const value = localStorage.getItem(SIDEBAR_KEY);
      return value === 'open' || value === 'closed' ? value : null;
    } catch {
      return null;
    }
  }

  let sidebarChoice = $state<'open' | 'closed' | null>(typeof window === 'undefined' ? null : readSidebarChoice());
  let wideScreen = $state(true);

  $effect(() => {
    const query = window.matchMedia('(min-width: 1440px)');
    wideScreen = query.matches;
    const onChange = (event: MediaQueryListEvent) => (wideScreen = event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  });

  const sidebarCollapsed = $derived(sidebarChoice ? sidebarChoice === 'closed' : !wideScreen);

  function toggleSidebar() {
    sidebarChoice = sidebarCollapsed ? 'open' : 'closed';
    try {
      localStorage.setItem(SIDEBAR_KEY, sidebarChoice);
    } catch {
      /* stockage indisponible : le choix vaut pour la visite */
    }
  }

  function goTab(id: string) {
    gotoTab('/analytics', id, 'overview');
  }

  function goSection(id: string) {
    const target = sections.find((s) => s.id === id);
    if (target) goTab(target.tabs[0]!.id);
  }

  // ── Réponse /analytics historique, pour les anciens composants ─────────────
  let legacy = $state<any>(null);
  let legacyKey = '';
  let legacyLoading = $state(false);
  let legacyError = $state('');

  $effect(() => {
    if (!tab.legacy) return;
    const period = filters.periodQuery;
    untrack(() => loadLegacy(period));
  });

  function loadLegacy(period: { period?: number; startDate?: string; endDate?: string }) {
    const key = JSON.stringify(period);
    if (key === legacyKey && (legacy || legacyLoading)) return;
    legacyKey = key;
    legacyLoading = true;
    legacyError = '';
    const options = period.period === 1 ? { ...period, granularity: '30' } : period;
    fetchAnalytics(options)
      .then((res) => {
        if (legacyKey !== key) return;
        legacy = res;
        analyticsExport.legacy = res;
      })
      .catch((e) => {
        if (legacyKey === key) legacyError = errorMessage(e) || m.an_error_generic();
      })
      .finally(() => {
        if (legacyKey === key) legacyLoading = false;
      });
  }

  const isWeeklyView = $derived(!filters.isCustom && filters.days > 90);
  const chartLabels = $derived(legacy?.dailyTrend?.map((d: any) => {
    if (isWeeklyView) {
      const parts = d.dateKey?.slice(5)?.split('-');
      return { ...d, label: parts ? m.an_week_short({ date: `${parts[1]}/${parts[0]}` }) : d.dateKey?.slice(5) };
    }
    return { ...d, label: d.dateKey?.slice(5) };
  }) ?? []);

  const fmt = (n: number) => n?.toLocaleString(dateLocale()) ?? '0';
  const fmtH = (mins: number) => {
    const h = Math.floor((mins || 0) / 60);
    const min = Math.round((mins || 0) % 60);
    if (h > 0) return `${h}h${min > 0 ? String(min).padStart(2, '0') : ''}`;
    return `${min}min`;
  };

  // ── Réseau d'interactions ──────────────────────────────────────────────────
  let interactions = $state<any>(null);
  let interactionsKey = '';
  let interactionsLoading = $state(false);
  let interactionsError = $state('');

  $effect(() => {
    if (activeTab !== 'interactions') return;
    const period = filters.periodQuery;
    untrack(() => loadInteractions(period));
  });

  async function loadInteractions(period = filters.periodQuery, force = false) {
    const key = JSON.stringify(period);
    if (!force && key === interactionsKey && (interactions || interactionsLoading)) return;
    interactionsKey = key;
    interactionsLoading = true;
    interactionsError = '';
    try {
      const res = await fetchGlobalInteractions(period);
      if (interactionsKey === key) interactions = res;
    } catch (e) {
      if (interactionsKey === key) interactionsError = errorMessage(e) || m.an_error_interactions();
    } finally {
      if (interactionsKey === key) interactionsLoading = false;
    }
  }

  // ── Fiche membre ───────────────────────────────────────────────────────────
  let modalOpen = $state(false);
  let selectedUserId = $state<string | null>(null);
  let selectedUserName = $state('');
  let caseData = $state<any>(null);
  let loadingCase = $state(false);
  let caseError = $state('');

  /** La fiche membre appartient à la section Membres du centre de gestion. */
  const canOpenMemberCase = $derived(canViewFeature('members'));

  async function openMemberDetails(memberId: string, memberName: string) {
    if (!canOpenMemberCase) return;
    selectedUserId = memberId;
    selectedUserName = memberName || m.an_member_fallback();
    modalOpen = true;
    loadingCase = true;
    caseError = '';
    caseData = null;
    try {
      caseData = await fetchMemberCase(memberId, authStore.selectedGuildId);
    } catch (e) {
      caseError = errorMessage(e) || m.an_case_load_error();
    } finally {
      loadingCase = false;
    }
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  type ExportRow = Record<string, string | number | boolean | null>;
  type ExportSheet = { name: string; rows: ExportRow[] };

  function cell(value: unknown): string | number | boolean | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    return JSON.stringify(value);
  }

  function appendSheets(sheets: ExportSheet[], name: string, value: unknown) {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      if (value.length === 0) return;
      sheets.push({
        name,
        rows: value.map((entry, index) =>
          typeof entry === 'object' && entry !== null
            ? Object.fromEntries(Object.entries(entry).map(([k, v]) => [k, cell(v)]))
            : { index: index + 1, value: cell(entry) }),
      });
      return;
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);
      for (const [key, nested] of entries) {
        if (Array.isArray(nested)) appendSheets(sheets, `${name}_${key}`, nested);
      }
      const scalars = entries.filter(([, v]) => !Array.isArray(v));
      if (scalars.length > 0) sheets.push({ name: `${name}_resume`, rows: scalars.map(([key, v]) => ({ key, value: cell(v) })) });
    }
  }

  function collectSheets(): ExportSheet[] {
    const sheets: ExportSheet[] = [];
    for (const [name, value] of Object.entries(analyticsExport)) appendSheets(sheets, name, value);
    return sheets;
  }

  function triggerDownload(content: BlobPart, fileName: string, mimeType: string) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  const csvCell = (v: string | number | boolean | null) => {
    if (v === null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  function exportCSV() {
    const sheets = collectSheets();
    if (sheets.length === 0) return toast.error(m.an_export_no_data());
    const lines: string[] = [];
    for (const sheet of sheets) {
      const headers = [...new Set(sheet.rows.flatMap((r) => Object.keys(r)))];
      lines.push(`# ${sheet.name}`, headers.join(','), ...sheet.rows.map((r) => headers.map((h) => csvCell(r[h] ?? null)).join(',')), '');
    }
    triggerDownload(lines.join('\n'), `analytics_kotbo_${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv;charset=utf-8');
    toast.success(m.an_export_csv_done());
  }

  async function exportXLSX() {
    const sheets = collectSheets();
    if (sheets.length === 0) return toast.error(m.an_export_no_data());
    const ok = await downloadXlsx(`analytics_kotbo_${new Date().toISOString().slice(0, 10)}.xlsx`, sheets);
    if (ok) toast.success(m.an_export_xlsx_done());
    else toast.error(m.an_export_no_data());
  }

  async function exportImages() {
    const root = document.getElementById('analytics-export-root');
    const canvases = root ? [...root.querySelectorAll('canvas')].filter((c) => c.width >= 280 && c.height >= 160) : [];
    if (canvases.length === 0) return toast.error(m.an_export_no_visible_chart());
    let count = 0;
    for (const [index, canvas] of canvases.entries()) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) continue;
      triggerDownload(blob, `analytics_${activeTab}_${String(index + 1).padStart(2, '0')}.png`, 'image/png');
      count += 1;
    }
    if (count === 0) toast.error(m.an_export_images_failed());
    else toast.success(m.an_export_images_done({ count }));
  }
</script>

<div id="analytics-export-root" class="analytics-v2 mx-auto flex w-full max-w-[96rem] flex-col gap-5 pb-20">
  <header class="flex flex-wrap items-end justify-between gap-4">
    <div class="flex min-w-0 flex-col gap-1">
      <h1 class="font-headline text-2xl font-semibold text-on-surface">{m.anx_page_title()}</h1>
      <p class="max-w-2xl text-body-sm text-on-surface-variant">{section.description}</p>
    </div>
    <div class="flex items-center gap-2">
      <SavedViewsMenu {activeTab} onApply={goTab} />
      <ExportDropdown onExportCSV={exportCSV} onExportXLSX={exportXLSX} onExportImage={exportImages} />
    </div>
  </header>

  <div class="analytics-v2__layout" class:analytics-v2__layout--collapsed={sidebarCollapsed}>
    <aside class="analytics-v2__sidebar">
      <button
        type="button"
        class="side-link side-link--quiet side-toggle"
        aria-expanded={!sidebarCollapsed}
        aria-label={sidebarCollapsed ? m.anx_sidebar_expand() : m.anx_sidebar_collapse()}
        title={sidebarCollapsed ? m.anx_sidebar_expand() : m.anx_sidebar_collapse()}
        onclick={toggleSidebar}
      >
        <Papicon icon={sidebarCollapsed ? 'panel-left-open' : 'panel-left-close'} size={16} />
        {#if !sidebarCollapsed}<span class="truncate">{m.anx_sidebar_collapse()}</span>{/if}
      </button>
      <nav aria-label={m.anx_nav_label()} class="flex flex-col gap-0.5">
        {#each sections as s (s.id)}
          <button
            type="button"
            class="side-link"
            aria-current={s.id === section.id ? 'page' : undefined}
            aria-label={sidebarCollapsed ? s.label : undefined}
            title={sidebarCollapsed ? s.label : undefined}
            onclick={() => goSection(s.id)}
          >
            <Papicon icon={s.icon} size={18} />
            {#if sidebarCollapsed}
              {#if s.isNew}<span class="side-link__dot" aria-hidden="true"></span>{/if}
            {:else}
              <span class="truncate">{s.label}</span>
              {#if s.isNew}<span class="side-link__badge">{m.anx_badge_new()}</span>{/if}
              {#if s.tabs.length > 1}<span class="side-link__count">{s.tabs.length}</span>{/if}
            {/if}
          </button>
        {/each}
      </nav>
      <div class="flex flex-col gap-1 border-t border-outline-variant pt-3">
        {#if !sidebarCollapsed}<span class="px-3 text-2xs text-on-surface-variant">{m.anx_nav_elsewhere()}</span>{/if}
        <a class="side-link side-link--quiet" href="/pulse" title={sidebarCollapsed ? m.nav_pulse() : undefined} aria-label={sidebarCollapsed ? m.nav_pulse() : undefined}>
          <Papicon icon="activity" size={16} />{#if !sidebarCollapsed}{m.nav_pulse()}{/if}
        </a>
        <a class="side-link side-link--quiet" href="/invitations" title={sidebarCollapsed ? m.nav_invitations() : undefined} aria-label={sidebarCollapsed ? m.nav_invitations() : undefined}>
          <Papicon icon="link" size={16} />{#if !sidebarCollapsed}{m.nav_invitations()}{/if}
        </a>
      </div>
    </aside>

    <div class="flex min-w-0 flex-col gap-4">
      <div class="analytics-v2__mobile-sections">
        <Tabs
          label={m.anx_nav_label()}
          tabs={sections.map((s) => ({ id: s.id, label: s.label, icon: s.icon, badge: s.isNew ? m.anx_badge_new() : undefined }))}
          active={section.id}
          onchange={goSection}
        />
      </div>

      {#if section.tabs.length > 1}
        <Tabs
          label={m.anx_subtabs_label({ section: section.label })}
          tabs={section.tabs.map((t) => ({ id: t.id, label: t.label, icon: t.icon }))}
          active={tab.id}
          onchange={goTab}
        />
      {/if}

      {#if tab.scope === 'own'}
        <Callout variant="info">{m.anx_filter_own_window()}</Callout>
      {:else}
        <AnalyticsFilterBar scopeSupport={tab.scope === 'full' ? 'full' : 'period'} />
      {/if}

      {#key activeTab}
        {#if activeTab === 'overview'}
          <OverviewSection onNavigate={goTab} {legacy} />
        {:else if ['messages', 'voice', 'heatmap', 'pulse', 'weekly', 'commands', 'algo'].includes(activeTab)}
          <ActivitySection view={activeTab as ActivityView} {legacy} {legacyLoading} onOpenMember={openMemberDetails} />
        {:else if ['content', 'emojis', 'stickers', 'gifs', 'sites', 'formatting'].includes(activeTab)}
          <ContentSection view={activeTab as ContentView} />
        {:else if activeTab === 'words'}
          <div class="flex flex-col gap-4">
            <RisingWordsView />
            <AdvancedAnalyticsPanel section="words" onOpenMember={openMemberDetails} />
          </div>
        {:else if activeTab === 'channels'}
          <ChannelsSection onOpenMember={openMemberDetails} />
        {:else if activeTab === 'responses'}
          <ResponseTimesView />
        {:else if activeTab === 'channel-health'}
          <div class="flex flex-col gap-4">
            <ChannelHealthView />
            <AdvancedAnalyticsPanel section="channels" onOpenMember={openMemberDetails} />
          </div>
        {:else if activeTab === 'concentration'}
          <ConcentrationView />
        {:else if activeTab === 'climate'}
          <ClimateView onOpenMember={openMemberDetails} />
        {:else if activeTab === 'interactions'}
          {#if interactions}
            <div class="flex flex-col gap-4">
              <GlobalInteractionGraph
                nodes={interactions.nodes || []}
                edges={interactions.edges || []}
                hiddenMembersCount={interactions.hiddenMembersCount || 0}
                onSelectNode={(userId) => openMemberDetails(userId, m.an_loading_short())}
              />
              <NetworkInsightsView onOpenMember={openMemberDetails} />
            </div>
          {:else if interactionsError}
            <Callout variant="danger" title={m.an_network_error()}>
              {interactionsError}
              {#snippet actions()}<Button size="sm" onclick={() => loadInteractions(filters.periodQuery, true)}>{m.an_retry()}</Button>{/snippet}
            </Callout>
          {:else}
            <AnalyticsSkeleton />
          {/if}
        {:else if activeTab === 'social'}
          <AdvancedAnalyticsPanel section="social" onOpenMember={openMemberDetails} />
        {:else if activeTab === 'ghosts'}
          <GhostMembersPanel onOpenMember={openMemberDetails} />
        {:else if activeTab === 'growth'}
          <div class="flex flex-col gap-4">
            <GrowthSection {legacy} {legacyLoading} onOpenMember={openMemberDetails} />
            <GrowthInsightsView />
          </div>
        {:else if activeTab === 'tickets'}
          <StaffInsightsView onOpenMember={openMemberDetails} />
        {:else if activeTab === 'compare'}
          <CompareView />
        {:else if activeTab === 'alerts'}
          <AlertsView />
        {:else if activeTab === 'reports'}
          <ReportsView />
        {:else if activeTab === 'live'}
          <LivePanel />
        {:else if activeTab === 'engagement'}
          <EngagementView />
        {:else if activeTab === 'lifecycle'}
          <LifecycleView onOpenMember={openMemberDetails} />
        {:else if activeTab === 'funnel'}
          <FunnelView />
        {:else if activeTab === 'cohorts'}
          <div class="flex flex-col gap-4">
            <CohortTriangle />
            <AdvancedAnalyticsPanel section="retention" onOpenMember={openMemberDetails} />
          </div>
        {:else if activeTab === 'churn'}
          <AdvancedAnalyticsPanel section="churn" onOpenMember={openMemberDetails} />
        {:else if activeTab === 'mod-advanced'}
          <AdvancedAnalyticsPanel section="moderation" onOpenMember={openMemberDetails} />
        {:else if legacyError}
          <Callout variant="danger" title={m.an_error_generic()}>{legacyError}</Callout>
        {:else if !legacy}
          <AnalyticsSkeleton />
        {:else if activeTab === 'members'}
          <MembersView {legacy} onOpenMember={openMemberDetails} />
        {:else if activeTab === 'moderation'}
          <div class="flex flex-col gap-4">
            <div class="kpi-grid kpi-grid--4">
              <KpiTile label={m.anx_fact_sanctions()} value={fmtNumber(legacy.totals?.sanctions ?? 0)} />
              <KpiTile label={m.anx_mod_active()} value={fmtNumber(legacy.moderation?.activeSanctions ?? 0)} hint={m.anx_mod_active_hint()} />
              <KpiTile label={m.anx_mod_per_day()} value={fmtNumber(Math.round(((legacy.totals?.sanctions ?? 0) / Math.max(1, filters.days)) * 10) / 10)} />
              <KpiTile label={m.anx_mod_moderators()} value={fmtNumber(legacy.topModerators?.length ?? 0)} hint={m.anx_mod_moderators_hint()} />
            </div>
            <ModerationTrendsView onOpenMember={openMemberDetails} />
            <ModerationAudit data={legacy} {chartLabels} onOpenMember={openMemberDetails} />
          </div>
        {:else if activeTab === 'staff'}
          <StaffAudit data={legacy} onOpenMember={openMemberDetails} {fmt} {fmtH} />
        {:else if activeTab === 'performance'}
          {#if legacy.staffPerformance}
            <StaffPerformance data={legacy.staffPerformance} onOpenMember={openMemberDetails} />
          {/if}
        {/if}
      {/key}
    </div>
  </div>

  <MemberCaseModal
    bind:open={modalOpen}
    userId={selectedUserId}
    userName={selectedUserName}
    {caseData}
    loading={loadingCase}
    error={caseError}
    onClose={() => (modalOpen = false)}
    onSelectUser={(userId) => openMemberDetails(userId, m.an_loading_short())}
  />
</div>

<style>
  .analytics-v2__layout {
    display: grid;
    grid-template-columns: 13.5rem minmax(0, 1fr);
    gap: 1.5rem;
    align-items: start;
    transition: grid-template-columns 180ms ease;
  }

  .analytics-v2__layout--collapsed {
    grid-template-columns: 2.75rem minmax(0, 1fr);
    gap: 1rem;
  }

  .analytics-v2__layout--collapsed .side-link {
    justify-content: center;
    padding: 0;
  }

  .side-link__dot {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    width: 0.4375rem;
    height: 0.4375rem;
    border-radius: 999px;
    background: var(--color-primary);
  }

  .side-toggle {
    color: var(--color-on-surface-variant);
  }

  @media (prefers-reduced-motion: reduce) {
    .analytics-v2__layout {
      transition: none;
    }
  }

  .analytics-v2__sidebar {
    position: sticky;
    top: calc(var(--app-navbar-height) + 1rem);
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .analytics-v2__mobile-sections {
    display: none;
  }

  .side-link {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.625rem;
    width: 100%;
    min-height: 2.5rem;
    padding: 0 0.75rem;
    border-radius: 0.5rem;
    font-size: 0.875rem;
    font-weight: 500;
    text-align: left;
    color: var(--color-on-surface-variant);
  }

  .side-link:hover {
    background: var(--color-surface-container);
    color: var(--color-on-surface);
  }

  .side-link:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .side-link[aria-current='page'] {
    background: color-mix(in srgb, var(--color-primary) 14%, transparent);
    color: var(--color-primary);
  }

  .side-link--quiet {
    min-height: 2.25rem;
    font-size: 0.8125rem;
  }

  .side-link__badge {
    margin-left: auto;
    padding: 0.0625rem 0.4375rem;
    border-radius: 999px;
    font-size: 0.6875rem;
    font-weight: 600;
    background: var(--color-primary);
    color: var(--color-on-primary);
  }

  .side-link__count {
    margin-left: auto;
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    color: var(--color-on-surface-variant);
  }

  .side-link__badge + .side-link__count {
    margin-left: 0.375rem;
  }

  /* Grilles partagées par les sections. */
  .analytics-v2 :global(.kpi-grid) {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(var(--kpi-cols, 4), minmax(0, 1fr));
  }

  .analytics-v2 :global(.kpi-grid--4) {
    --kpi-cols: 4;
  }

  .analytics-v2 :global(.kpi-grid--5) {
    --kpi-cols: 5;
  }

  .analytics-v2 :global(.section-grid) {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(12, minmax(0, 1fr));
    align-items: start;
  }

  .analytics-v2 :global(.span-4) { grid-column: span 4; }
  .analytics-v2 :global(.span-5) { grid-column: span 5; }
  .analytics-v2 :global(.span-6) { grid-column: span 6; }
  .analytics-v2 :global(.span-7) { grid-column: span 7; }
  .analytics-v2 :global(.span-12) { grid-column: span 12; }

  @media (max-width: 1279px) {
    .analytics-v2 :global(.kpi-grid--5) {
      --kpi-cols: 3;
    }

    .analytics-v2 :global(.span-4),
    .analytics-v2 :global(.span-5),
    .analytics-v2 :global(.span-7) {
      grid-column: span 12;
    }
  }

  @media (max-width: 1023px) {
    .analytics-v2__layout {
      grid-template-columns: minmax(0, 1fr);
    }

    .analytics-v2__sidebar {
      display: none;
    }

    .analytics-v2__mobile-sections {
      display: block;
    }

    .analytics-v2 :global(.span-6) {
      grid-column: span 12;
    }
  }

  @media (max-width: 639px) {
    .analytics-v2 :global(.kpi-grid) {
      --kpi-cols: 2;
    }
  }
</style>
