<!--
  Onglet « Staff » du dossier membre, quand on l'ouvre depuis la gestion du
  staff : grade et actions rapides, chiffres, discipline, hierarchies et
  parcours. Le dossier reste la meme fenetre que partout ailleurs ; cet
  onglet y ajoute ce que seule cette page connait.
-->
<script lang="ts">
  import Papicon from '../Papicon.svelte';
  import { Button, Menu } from '../ui';
  import WarnMeter from './WarnMeter.svelte';
  import HierarchyIcon from './HierarchyIcon.svelte';
  import { staff, staffName } from './staffStore.svelte';
  import { memberMenuItems } from './memberActions';
  import { formatDate, formatNumber, formatRelative, formatTenure, formatVoice, weekTrend } from './format';
  import { m } from '../../i18n';

  const { userId }: { userId: string } = $props();

  const member = $derived(staff.memberByUserId(userId));
  const metric = $derived(staff.metricFor(userId));
  const trend = $derived(metric ? weekTrend(metric.avg7d, metric.avg30d) : null);
  const threshold = $derived(staff.config.warnsToDemote || 3);
  const gradeColor = $derived(member ? staff.gradeColor(member.grade) : null);

  type TimelineEvent = { at: string; icon: string; tone: 'neutral' | 'warning' | 'danger' | 'primary'; title: string; detail?: string };

  const timeline = $derived.by((): TimelineEvent[] => {
    if (!member) return [];
    const events: TimelineEvent[] = [];
    for (const warning of staff.warnings.filter((w) => w.staffUserId === userId)) {
      events.push({
        at: warning.createdAt,
        icon: 'alert-triangle',
        tone: warning.isActive ? 'warning' : 'neutral',
        title: warning.isActive ? m.sx_tl_warning() : m.sx_tl_warning_expired(),
        detail: warning.reason + (warning.issuedByTag ? ` · ${m.sx_by({ name: warning.issuedByTag })}` : ''),
      });
    }
    if (member.suspendedAt) {
      events.push({ at: String(member.suspendedAt), icon: 'pause', tone: 'danger', title: m.sx_tl_suspended(), detail: member.suspendedReason || undefined });
    }
    for (const grade of member.hierarchyGrades ?? []) {
      const hierarchy = grade.hierarchy ?? staff.hierarchyById(grade.hierarchyId);
      if (grade.joinedAt) {
        events.push({ at: String(grade.joinedAt), icon: 'git-branch', tone: 'neutral', title: m.sx_tl_joined_hierarchy({ name: hierarchy?.name ?? '' }), detail: grade.grade });
      }
    }
    if (member.currentRoleStartedAt && member.currentRoleStartedAt !== member.joinedStaffAt) {
      events.push({ at: String(member.currentRoleStartedAt), icon: 'chevrons-up', tone: 'primary', title: m.sx_tl_grade({ grade: member.grade }) });
    }
    if (member.joinedStaffAt) {
      events.push({ at: String(member.joinedStaffAt), icon: 'user-plus', tone: 'primary', title: m.sx_tl_joined() });
    }
    return events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  });

  $effect(() => {
    // Le parcours lit l'historique complet, avertissements expires compris.
    if (staff.guildId) void staff.loadWarnings();
  });
</script>

{#if member}
  <div class="space-y-4">
    <!-- Grade et actions -->
    <section class="sc-card flex flex-wrap items-center justify-between gap-4 p-4">
      <div class="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2">
        <span class="sc-chip" style="color: {gradeColor || 'var(--primary-color)'}; background: color-mix(in srgb, {gradeColor || 'var(--primary-color)'} 12%, transparent);">
          <Papicon icon="shield" size={13} />{member.grade}
        </span>
        {#if member.isTutor}
          <span class="sc-chip bg-primary/10 text-primary"><Papicon icon="user-check" size={12} />{m.sm_tutor_badge()}</span>
        {/if}
        {#if member.suspendedAt}
          <span class="sc-chip bg-warning/10 text-warning"><Papicon icon="pause" size={12} />{m.sx_suspended_since({ date: formatDate(member.suspendedAt) })}</span>
        {/if}
        <dl class="flex flex-wrap gap-x-5 gap-y-1 text-xs">
          <div class="flex gap-1"><dt class="text-on-surface-variant">{m.sx_fact_joined()}</dt><dd class="text-on-surface">{formatDate(member.joinedStaffAt)}</dd></div>
          <div class="flex gap-1"><dt class="text-on-surface-variant">{m.sx_fact_grade_since()}</dt><dd class="text-on-surface">{formatDate(member.currentRoleStartedAt)}</dd></div>
        </dl>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        {#if staff.canManageSettings}
          <Button size="sm" icon="chevrons-down" disabled={!staff.canDemote(member)} disabledReason={m.sm_toast_grade_min()} onclick={() => staff.shiftGrade(member, 'down')}>{m.sm_title_demote()}</Button>
          <Button size="sm" variant="primary" icon="chevrons-up" disabled={!staff.canPromote(member)} disabledReason={m.sm_toast_grade_max()} onclick={() => staff.shiftGrade(member, 'up')}>{m.sm_title_promote()}</Button>
        {/if}
        <Menu label={m.sx_member_menu({ name: staffName(member) })} items={memberMenuItems(member)} />
      </div>
    </section>

    <div class="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)] xl:grid-cols-[16rem_minmax(0,1fr)_18rem]">
      <!-- En bref -->
      <div class="space-y-4">
        <section class="sc-card">
          <h4 class="sc-title">{m.mp_brief()}</h4>
          <dl class="sc-brief">
            <div><dt>{m.sx_stat_messages()}</dt><dd>{formatNumber(member.stats?.totalMessages)}</dd></div>
            <div><dt>{m.sx_stat_voice()}</dt><dd>{formatVoice(member.stats?.totalVoiceMinutes)}</dd></div>
            <div><dt>{m.sx_sanctions_given()}</dt><dd>{formatNumber(member.stats?.sanctionsIssued)}</dd></div>
            {#if metric}
              <div><dt>{m.sm_col_progression_score()}</dt><dd>{metric.progressionScore}/100</dd></div>
              <div>
                <dt>{m.sx_pace()}</dt>
                <dd class={trend !== null && trend <= -50 ? 'text-warning' : ''}>
                  {metric.avg7d}
                  <span>{m.sx_vs_month({ avg: metric.avg30d, trend: trend === null ? '-' : `${trend > 0 ? '+' : ''}${trend} %` })}</span>
                </dd>
              </div>
            {/if}
            <div><dt>{m.sx_col_tenure()}</dt><dd>{formatTenure(member.joinedStaffAt)}</dd></div>
          </dl>
        </section>

        <section class="sc-card">
          <div class="flex items-center justify-between pr-3">
            <h4 class="sc-title">{m.sx_col_hierarchies()}</h4>
            {#if staff.canManageSettings}
              <Button size="sm" variant="ghost" onclick={() => (staff.dialogs.grades = member.userId)}>{m.sx_action_edit()}</Button>
            {/if}
          </div>
          {#if member.hierarchyGrades?.length}
            <ul class="space-y-2 px-4 pb-4 pt-1">
              {#each member.hierarchyGrades as grade (grade.id)}
                {@const hierarchy = grade.hierarchy ?? staff.hierarchyById(grade.hierarchyId)}
                <li class="flex items-center gap-3">
                  <HierarchyIcon icon={hierarchy?.icon} color={hierarchy?.color} size={28} />
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm font-medium text-on-surface">{hierarchy?.name ?? ''}</span>
                    <span class="block truncate text-xs text-on-surface-variant">{grade.grade}</span>
                  </span>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="px-4 pb-4 pt-1 text-sm text-on-surface-variant">{m.sm_no_secondary_hierarchy()}</p>
          {/if}
        </section>
      </div>

      <!-- Parcours -->
      <section class="sc-card min-w-0">
        <h4 class="sc-title">{m.sx_section_timeline()}</h4>
        <p class="-mt-2 px-4 text-xs text-on-surface-variant">{m.sx_tenure({ d: formatTenure(member.joinedStaffAt) })}</p>
        <ol class="px-4 pb-2 pt-4">
          {#each timeline as event, i (i)}
            <li class="sc-event sc-event--{event.tone}">
              <span class="sc-event__dot" aria-hidden="true"><Papicon icon={event.icon} size={12} /></span>
              <div class="min-w-0 flex-1 pb-4">
                <div class="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span class="text-sm text-on-surface">{event.title}</span>
                  <time class="text-2xs tabular-nums text-on-surface-variant" datetime={event.at} title={formatDate(event.at)}>{formatRelative(event.at)}</time>
                </div>
                {#if event.detail}
                  <p class="mt-0.5 wrap-break-word text-sm text-on-surface-variant">{event.detail}</p>
                {/if}
              </div>
            </li>
          {/each}
        </ol>
      </section>

      <!-- Discipline -->
      <section class="sc-card lg:col-span-2 xl:col-span-1">
        <h4 class="sc-title">{m.sx_section_discipline()}</h4>
        <div class="space-y-3 px-4 pb-4">
          <WarnMeter count={member.warnings?.length ?? 0} {threshold} />
          <p class="text-xs text-on-surface-variant">
            {m.sx_threshold_sentence({ demote: staff.config.warnsToDemote, blacklist: staff.config.warnsToBlacklist })}
            {staff.config.actionMode === 'auto' ? m.sx_mode_auto_hint() : m.sx_mode_validation_hint()}
          </p>
          {#if member.warnings?.length}
            <ul class="space-y-2 border-t border-outline-variant pt-3">
              {#each member.warnings as warning (warning.id)}
                <li>
                  <p class="text-sm text-on-surface">{warning.reason}</p>
                  {#if warning.expiresAt}
                    <p class="text-xs text-on-surface-variant">{m.sx_expires({ when: formatRelative(warning.expiresAt) })}</p>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
          {#if staff.canModerate}
            <Button size="sm" fullWidth icon="alert-triangle" onclick={() => (staff.dialogs.warn = { userId: member.userId })}>{m.sx_action_warn()}</Button>
          {/if}
        </div>
      </section>
    </div>
  </div>
{/if}

<style>
  .sc-card {
    border: 1px solid var(--outline-variant);
    border-radius: 0.75rem;
    background: var(--surface-container-lowest);
  }
  .sc-title {
    padding: 1rem 1rem 0.75rem;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--on-surface);
  }
  .sc-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.2rem 0.6rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 500;
  }

  .sc-brief {
    display: flex;
    flex-direction: column;
    padding-bottom: 0.25rem;
  }
  .sc-brief > div {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.55rem 1rem;
    border-top: 1px solid color-mix(in srgb, var(--outline-variant) 50%, transparent);
  }
  .sc-brief dt {
    font-size: 0.8125rem;
    color: var(--on-surface-variant);
  }
  .sc-brief dd {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--on-surface);
    font-variant-numeric: tabular-nums;
  }
  .sc-brief dd span {
    font-size: 0.6875rem;
    font-weight: 400;
    color: var(--on-surface-variant);
  }

  .sc-event {
    --tone: var(--on-surface-variant);
    position: relative;
    display: flex;
    gap: 0.75rem;
  }
  .sc-event--primary { --tone: var(--primary-color); }
  .sc-event--warning { --tone: var(--warning-color); }
  .sc-event--danger { --tone: var(--error-color); }
  .sc-event:not(:last-child)::before {
    content: '';
    position: absolute;
    left: 11px;
    top: 24px;
    bottom: 0;
    width: 1px;
    background: var(--outline-variant);
  }
  .sc-event__dot {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 23px;
    height: 23px;
    border-radius: 9999px;
    color: var(--tone);
    background: color-mix(in srgb, var(--tone) 12%, var(--surface-container-lowest));
  }
</style>
