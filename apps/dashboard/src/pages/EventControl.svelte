<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { router } from 'tinro';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import MetricCard from '../lib/components/MetricCard.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import UserDisplay from '../lib/components/UserDisplay.svelte';
  import { Button, EmptyState, SectionCard, Tabs } from '../lib/components/ui';
  import TournamentPanel from '../lib/components/events/TournamentPanel.svelte';
  import { eventTypeMeta, hasRegistrations, statusLabel } from '../lib/components/events/eventTypes';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { subscribeRealtime } from '../lib/stores/realtime.svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { dashboardFetch } from '../lib/api';
  import { m, dateLocale } from '../lib/i18n';

  const { eventId } = $props<{ eventId: string }>();

  let event = $state<any>(null);
  let stats = $state<any>(null);
  let registrations = $state<any[]>([]);
  let activeTab = $state<'stats' | 'participants'>('stats');
  let busy = $state(false);
  let unsubscribeRealtime: (() => void) | null = null;

  const meta = $derived(event ? eventTypeMeta(event.type) : null);
  const withRegistrations = $derived(event ? hasRegistrations(event.type) : false);
  const isQuiz = $derived(event?.type === 'QUIZ');
  const currentQuestion = $derived(event?.questions?.find((q: any) => q.id === stats?.questionId) || event?.questions?.[event?.questions?.length - 1]);
  const currentQIdx = $derived((event?.questions?.findIndex((q: any) => q.id === stats?.questionId) ?? -1) + 1);
  const totalQ = $derived(event?.questions?.length || 0);
  const finished = $derived(event?.status === 'COMPLETED' || event?.status === 'CANCELLED');

  const CHART_COLORS = ['#6366f1', '#ec4899', '#06b6d4', '#f59e0b', '#8b5cf6', '#f97316', '#84cc16', '#14b8a6', '#3b82f6', '#d946ef'];
  const CORRECT_COLOR = '#10b981';

  onMount(async () => {
    await loadEvent();
    const refresh = () => void (withRegistrations ? loadRegistrations() : loadStats());
    refresh();
    unsubscribeRealtime = subscribeRealtime({ reasons: ['events_updated'], fallbackMs: withRegistrations ? 5000 : 3000, onUpdate: refresh });
  });
  onDestroy(() => unsubscribeRealtime?.());

  async function request(path: string, method = 'GET') {
    const res = await dashboardFetch(`/events/${eventId}${path}`, { guildId: authStore.selectedGuildId, method });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || m.evc_action_error());
    return data;
  }

  async function loadEvent() {
    try {
      event = (await request('')).event;
    } catch {
      toast.error(m.eve_load_error());
    }
  }
  async function loadStats() {
    stats = (await request('/stats').catch(() => null))?.stats ?? stats;
  }
  async function loadRegistrations() {
    registrations = (await request('/registrations').catch(() => null))?.registrations ?? registrations;
  }

  async function step(path: '/next' | '/prev') {
    busy = true;
    try {
      const data = await request(path, 'POST');
      if (data.status === 'completed') {
        toast.success(m.evc_event_finished_toast());
        router.goto('/events');
      } else {
        toast.success(path === '/next' ? m.evc_next_question_toast() : m.evc_prev_question_toast());
        await loadStats();
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      busy = false;
    }
  }

  async function finishEvent() {
    const description = event?.type === 'TOURNAMENT' ? m.evc_finish_tournament_desc() : '';
    if (!(await confirmDialog.ask({ title: m.evc_confirm_finish_event(), description, confirmLabel: m.evc_btn_finish(), variant: 'warning' }))) return;
    busy = true;
    try {
      await request('/finish', 'POST');
      toast.success(m.evc_event_finished_toast());
      await loadEvent();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      busy = false;
    }
  }

  async function removeRegistration(userId: string) {
    const warn = event?.type === 'TOURNAMENT' && registrations.some((r) => r.seed !== null);
    if (!(await confirmDialog.danger(m.evc_confirm_remove_reg_title(), warn ? m.tn_remove_seeded_warning() : '', m.evc_confirm_remove_reg_btn()))) return;
    try {
      await request(`/registrations/${userId}`, 'DELETE');
      toast.success(m.evc_reg_removed_toast());
      await loadRegistrations();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  const formatDate = (value: string) => new Date(value).toLocaleString(dateLocale(), { dateStyle: 'short', timeStyle: 'short' });
</script>

{#snippet registrationsTable()}
  <SectionCard title={m.evc_registrations_title({ count: registrations.length })} icon="Users" flush>
    {#if registrations.length === 0}
      <EmptyState icon="UserPlus" title={m.evc_no_registrations()} description={m.evc_no_registrations_desc()} reason="accumulating" />
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="border-b border-outline-variant text-xs text-on-surface-variant">
            <tr>
              {#if event.type === 'TOURNAMENT'}<th class="px-4 py-3 font-medium">{m.tn_col_seed()}</th>{/if}
              <th class="px-4 py-3 font-medium">{m.evc_col_user()}</th>
              <th class="px-4 py-3 font-medium">{m.evc_col_registered_at()}</th>
              {#if event.formId}<th class="px-4 py-3 font-medium">{m.evc_col_form()}</th>{/if}
              <th class="px-4 py-3"><span class="sr-only">{m.evc_col_actions()}</span></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant">
            {#each registrations as reg (reg.id)}
              <tr>
                {#if event.type === 'TOURNAMENT'}
                  <td class="px-4 py-3 font-semibold text-on-surface">{reg.seed ?? '—'}</td>
                {/if}
                <td class="px-4 py-3">
                  {#if reg.teamName}
                    <p class="font-semibold text-on-surface">{reg.teamName}</p>
                  {/if}
                  <UserDisplay userId={reg.userId} name={reg.username || reg.userTag} avatarUrl={reg.avatarUrl} size="sm" onClick={(userId) => router.goto(`/profile/${userId}`)} />
                  {#if reg.teamMembers?.length}
                    <p class="mt-1 text-xs text-on-surface-variant">{m.tn_with_members({ names: reg.teamMembers.map((t: { name: string }) => t.name).join(', ') })}</p>
                  {/if}
                </td>
                <td class="whitespace-nowrap px-4 py-3 text-on-surface-variant">{formatDate(reg.createdAt)}</td>
                {#if event.formId}
                  <td class="px-4 py-3">
                    {#if reg.formData && typeof reg.formData === 'object'}
                      <dl class="space-y-0.5 text-xs">
                        {#each Object.entries(reg.formData) as [key, value] (key)}
                          <div><dt class="inline font-medium text-on-surface">{key} :</dt> <dd class="inline text-on-surface-variant">{value}</dd></div>
                        {/each}
                      </dl>
                    {:else}
                      <span class="text-xs text-on-surface-variant">{m.evc_no_form_data()}</span>
                    {/if}
                  </td>
                {/if}
                <td class="px-4 py-3 text-right">
                  <Button variant="ghost" size="sm" icon="UserMinus" onclick={() => removeRegistration(reg.userId)}>{m.evc_btn_remove_reg()}</Button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </SectionCard>
{/snippet}

<ModulePage
  title={event?.title ?? m.evc_pilot_title()}
  description={meta ? m.evc_page_desc({ type: meta.label() }) : ''}
  icon={meta?.icon ?? 'Calendar'}
  featureKey="events"
>
  {#snippet actions()}
    <div class="flex flex-wrap gap-2">
      <Button variant="ghost" icon="ArrowLeft" href="/events">{m.evc_btn_back()}</Button>
      <Button variant="secondary" icon="Edit3" href="/events/edit/{eventId}">{m.evc_btn_edit()}</Button>
      {#if event && isQuiz && !finished}
        <Button variant="secondary" icon="SkipBack" disabled={currentQIdx <= 1 || busy} disabledReason={m.evc_first_question_reason()} onclick={() => step('/prev')}>{m.evc_btn_prev_question()}</Button>
        <Button variant="primary" icon="SkipForward" loading={busy} onclick={() => step('/next')}>{currentQIdx === totalQ ? m.evc_btn_finish_quiz() : m.evc_btn_next_question()}</Button>
      {/if}
      {#if event && !finished}
        <Button variant="danger" icon="Flag" loading={busy && !isQuiz} onclick={finishEvent}>{m.evc_btn_finish()}</Button>
      {/if}
    </div>
  {/snippet}

  {#if !event}
    <div class="h-64 animate-pulse rounded-xl bg-surface-container-low"></div>
  {:else}
    <div class="space-y-6 pb-20">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard label={m.evc_col_status()} value={statusLabel(event.status)} icon="Zap" />
        {#if withRegistrations}
          <MetricCard label={m.evc_col_form()} value={event.customForm?.name || m.evc_direct_registration()} icon="FileText" toneClass="bg-tertiary/10 text-tertiary" />
          <MetricCard label={m.evc_registered_count()} value={registrations.length} icon="Users" toneClass="bg-success/10 text-success" />
        {:else if event.type === 'CTF'}
          <MetricCard label={m.evc_col_challenges()} value={event.ctfChallenges?.length || 0} icon="Flag" toneClass="bg-success/10 text-success" />
          <MetricCard label={m.evc_participants_count()} value={event.participants?.length || 0} icon="Users" toneClass="bg-tertiary/10 text-tertiary" />
        {:else}
          <MetricCard label={m.evc_col_progression()} value={m.evc_progression_value({ current: currentQIdx || 1, total: totalQ })} icon="HelpCircle" toneClass="bg-primary/10 text-primary" />
          <MetricCard label={m.evc_participants_count()} value={event.participants?.length || 0} icon="Users" toneClass="bg-tertiary/10 text-tertiary" />
        {/if}
      </div>

      {#if event.type === 'TOURNAMENT'}
        <TournamentPanel {eventId} registrations={registrationsTable} />
      {:else if event.type === 'CUSTOM'}
        {@render registrationsTable()}
      {:else}
        <Tabs
          label={m.evc_tabs_label()}
          active={activeTab}
          onchange={(id) => (activeTab = id as typeof activeTab)}
          tabs={[
            { id: 'stats', label: event.type === 'CTF' ? m.evc_tab_challenges() : m.evc_tab_chart(), icon: event.type === 'CTF' ? 'Flag' : 'PieChart' },
            { id: 'participants', label: m.evc_tab_participants(), icon: 'Users', badge: event.participants?.length || 0 },
          ]}
        />

        {#if activeTab === 'stats' && event.type === 'CTF'}
          {#if stats?.challenges?.length}
            <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
              {#each stats.challenges as challenge (challenge.id ?? challenge.title)}
                <SectionCard title={challenge.title} description={`${challenge.points} pts · ${challenge.xpReward} XP`} icon="Flag">
                  {#snippet actions()}
                    <span class="rounded-md bg-success/10 px-2 py-0.5 text-xs font-medium text-success">{m.evc_solves_count({ count: challenge.solveCount })}</span>
                  {/snippet}
                  {#if challenge.solves?.length}
                    <ul class="max-h-40 space-y-1 overflow-y-auto text-sm">
                      {#each challenge.solves as solve, i (i)}
                        <li class="flex justify-between gap-3 rounded-md bg-surface-container-high px-3 py-1.5">
                          <span class="truncate text-on-surface">{solve.username}</span>
                          <span class="shrink-0 text-xs text-on-surface-variant">{new Date(solve.solvedAt).toLocaleTimeString(dateLocale())}</span>
                        </li>
                      {/each}
                    </ul>
                  {:else}
                    <p class="text-sm text-on-surface-variant">{m.evc_no_solves()}</p>
                  {/if}
                </SectionCard>
              {/each}
            </div>
          {:else}
            <EmptyState icon="Flag" title={m.evc_waiting_stats()} reason="accumulating" />
          {/if}
        {:else if activeTab === 'stats'}
          {#if stats}
            {@const values = Object.values(stats.distribution).map(Number)}
            {@const total = values.reduce((a, b) => a + b, 0) || 1}
            <SectionCard title={stats.questionText} icon="PieChart">
              {#snippet actions()}
                <span class="rounded-md bg-success/10 px-2 py-0.5 text-xs font-medium text-success">{m.evc_live_badge()}</span>
              {/snippet}
              <div class="grid grid-cols-1 items-center gap-10 lg:grid-cols-2">
                <div class="relative mx-auto h-56 w-56">
                  <svg viewBox="0 0 100 100" class="h-full w-full -rotate-90" aria-hidden="true">
                    {#each values as value, i (i)}
                      {@const offset = values.slice(0, i).reduce((a, b) => a + b, 0) / total * 100}
                      {#if value > 0}
                        <circle r="40" cx="50" cy="50" fill="transparent"
                          stroke={i === currentQuestion?.correctOptionIndex ? CORRECT_COLOR : CHART_COLORS[i % CHART_COLORS.length]}
                          stroke-width="20" stroke-dasharray="{(value / total) * 100 * 2.51} 251.2" stroke-dashoffset="-{offset * 2.51}"
                          class="transition-all duration-700 ease-out" />
                      {/if}
                    {/each}
                  </svg>
                  <div class="absolute inset-0 flex flex-col items-center justify-center">
                    <span class="text-2xl font-semibold text-on-surface">{values.reduce((a, b) => a + b, 0)}</span>
                    <span class="text-xs text-on-surface-variant">{m.evc_responses_unit()}</span>
                  </div>
                </div>
                <ul class="space-y-4">
                  {#each values as value, i (i)}
                    {@const percentage = Math.round((value / total) * 100)}
                    {@const correct = i === currentQuestion?.correctOptionIndex}
                    {@const color = correct ? CORRECT_COLOR : CHART_COLORS[i % CHART_COLORS.length]}
                    <li class="space-y-1.5">
                      <div class="flex items-center justify-between gap-3 text-sm">
                        <span class="flex items-center gap-2 {correct ? 'font-semibold text-success' : 'text-on-surface'}">
                          {#if correct}<Papicon icon="Check" size={14} />{/if}
                          {(currentQuestion?.options as string[])?.[i] || `Option ${i + 1}`}
                        </span>
                        <span class="text-on-surface-variant">{value} ({percentage} %)</span>
                      </div>
                      <div class="h-2 overflow-hidden rounded-full bg-surface-container-high">
                        <div class="h-full rounded-full transition-all duration-700 ease-out" style:width="{percentage}%" style:background-color={color}></div>
                      </div>
                    </li>
                  {/each}
                </ul>
              </div>
            </SectionCard>
          {:else}
            <EmptyState icon="Zap" title={m.evc_waiting_first_responses()} reason="accumulating" />
          {/if}
        {:else}
          <SectionCard title={m.evc_tab_participants()} icon="Users" flush>
            {#if event.participants?.length}
              <div class="overflow-x-auto">
                <table class="w-full text-left text-sm">
                  <thead class="border-b border-outline-variant text-xs text-on-surface-variant">
                    <tr>
                      <th class="px-4 py-3 font-medium">{m.evc_col_user()}</th>
                      <th class="px-4 py-3 font-medium">{m.evc_col_score()}</th>
                      <th class="px-4 py-3 font-medium">{event.type === 'CTF' ? m.evc_col_last_solve() : m.evc_col_last_activity()}</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-outline-variant">
                    {#each event.participants as p (p.id)}
                      {@const lastResp = stats?.latestResponses?.find((r: any) => r.userId === p.userId) ?? stats?.responses?.find((r: any) => r.userId === p.userId)}
                      <tr>
                        <td class="px-4 py-3">
                          <UserDisplay userId={p.userId} name={p.profile?.displayName || p.username || p.userTag} avatarUrl={p.profile?.avatarUrl} size="sm" onClick={(userId) => router.goto(`/profile/${userId}`)} />
                        </td>
                        <td class="px-4 py-3 font-semibold text-primary">{p.score} pts</td>
                        <td class="px-4 py-3">
                          {#if event.type === 'CTF'}
                            <span class="text-on-surface-variant">{p.lastSolveAt ? formatDate(p.lastSolveAt) : m.evc_no_solves_yet()}</span>
                          {:else if lastResp}
                            <span class="rounded-md px-2 py-0.5 text-xs font-medium {lastResp.isCorrect ? 'bg-success/10 text-success' : 'bg-error/10 text-error'}">
                              {lastResp.optionLabel || (currentQuestion?.options as string[])?.[lastResp.optionIndex] || `Option ${lastResp.optionIndex + 1}`}
                            </span>
                          {:else}
                            <span class="text-on-surface-variant">{m.evc_no_response_yet()}</span>
                          {/if}
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {:else}
              <EmptyState icon="Users" title={m.evc_no_participants()} reason="accumulating" />
            {/if}
          </SectionCard>
        {/if}
      {/if}
    </div>
  {/if}
</ModulePage>
