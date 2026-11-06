<script lang="ts">
  import Papicon from '../Papicon.svelte';
  import { memberAvatarSrc } from '../../discordMedia';
  import DetailedAnalyticsModal from './DetailedAnalyticsModal.svelte';
  import { m } from '../../i18n';

  const { data, onOpenMember, fmt, fmtH } = $props<{ 
    data: any; 
    onOpenMember?: (id: string, name: string) => void;
    fmt: (n: number) => string;
    fmtH: (mins: number) => string;
  }>();

  let showStaffModal = $state(false);
  const staffList = $derived(data?.staff?.leaderboard ?? []);
  // Un repli sur l'avatar Discord generique donnerait la meme vignette a tous
  // les membres sans photo : on passe le nom et l'id pour obtenir une
  // initiale coloree distincte (issue #211).
  const getAvatar = (url: string | null, name?: string | null, userId?: string | null) =>
    memberAvatarSrc(url, name, userId);
</script>

<div class="space-y-6">
  <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
    {#each [
      { l: m.d1_sa_headcount(), v: fmt(data.staff?.totalStaff), icon: 'Users', color: 'primary' },
      { l: m.d1_sa_absences(), v: fmt(data.staff?.activeAbsences), icon: 'CalendarSlash', color: 'rose-500' },
      { l: m.d1_sa_meetings(), v: fmt(data.staff?.meetings), icon: 'UsersThree', color: 'amber-500' },
      { l: m.d1_sa_avg_attendance(), v: `${data.staff?.avgMeetingAttendance ?? 0}%`, icon: 'CheckCircle', color: 'emerald-500' },
    ] as s}
      <div class="premium-card p-6 rounded-xl group">
        <div class="flex justify-between items-start mb-4">
          <div class="p-2 rounded-xl bg-on-surface/5 text-on-surface-variant/40 group-hover:text-primary transition-colors">
            <Papicon icon={s.icon} size={18} />
          </div>
          <span class="text-xs font-semibold text-on-surface-variant/40">{s.l}</span>
        </div>
        <div class="text-lg font-semibold text-on-surface">{s.v}</div>
      </div>
    {/each}
  </div>

  <div class="premium-card p-8 rounded-xl space-y-6 flex flex-col">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-4">
        <div class="p-3 rounded-lg bg-primary/10 text-primary">
          <Papicon icon="Crown" size={24} />
        </div>
        <div>
          <h3 class="text-xl font-semibold text-on-surface">{m.d1_sa_leaderboard()}</h3>
          <p class="text-xs font-bold text-on-surface-variant/40">{m.d1_sa_team_activity()}</p>
        </div>
      </div>
      <button 
        onclick={() => showStaffModal = true}
        class="px-4 py-2 rounded-xl bg-surface-container-high/40 hover:bg-surface-container-high text-xs font-bold text-on-surface transition-colors"
      >
        {m.d1_sa_see_more()}
      </button>
    </div>

    <div class="space-y-3 flex-grow pr-2">
      {#each staffList.slice(0, 5) as s, i}
        <button
          disabled={!onOpenMember}
          onclick={() => onOpenMember?.(s.userId, s.name)}
          class="w-full flex items-center gap-4 p-4 rounded-lg bg-surface-container-high/20 enabled:hover:bg-surface-container-high/50 border border-outline-variant/5 transition-all text-left group"
        >
          <div class="flex items-center justify-center w-8 h-8 rounded-full font-semibold text-xs {i < 3 ? 'bg-warning/10 text-warning' : 'bg-on-surface/5 text-on-surface-variant/30'}">
            {i + 1}
          </div>
          <div class="relative">
            <img src={getAvatar(s.avatarUrl, s.name, s.userId)} alt="" class="w-10 h-10 rounded-xl object-cover" />
            <div class="absolute -bottom-1 -right-1 w-3 h-3 rounded-full border-2 border-surface bg-emerald-500"></div>
          </div>
          <div class="flex-1 min-w-0">
            <span class="text-base font-semibold text-on-surface block truncate">{s.name}</span>
            <span class="text-xs font-semibold text-on-surface-variant/40">{s.grade || m.d1_sa_staff()}</span>
          </div>
          <div class="hidden md:flex items-center gap-6 mr-4">
            <div class="text-right">
              <p class="text-xs font-semibold text-on-surface-variant/30">{m.d1_sa_messages()}</p>
              <p class="text-xs font-bold text-on-surface">{fmt(s.messages)}</p>
            </div>
            <div class="text-right">
              <p class="text-xs font-semibold text-on-surface-variant/30">{m.d1_sa_voice()}</p>
              <p class="text-xs font-bold text-on-surface">{fmtH(s.voiceMinutes)}</p>
            </div>
          </div>
          <div class="text-right pl-4 border-l border-outline-variant/10">
            <p class="text-xs font-semibold text-primary">{m.d1_sa_score()}</p>
            <p class="text-lg font-semibold text-primary">{fmt(s.score)}</p>
          </div>
        </button>
      {/each}
      {#if staffList.length === 0}
        <div class="py-20 text-center opacity-40">
          <Papicon icon="Users" size={48} class="mx-auto mb-4" />
          <p class="text-sm font-bold">{m.d1_sa_no_activity()}</p>
        </div>
      {/if}
    </div>
  </div>
</div>

<DetailedAnalyticsModal
  open={showStaffModal}
  onClose={() => showStaffModal = false}
  title={m.d1_sa_leaderboard()}
  subtitle={m.d1_sa_detailed_ranking()}
  icon="Crown"
  iconBgClass="bg-primary/10"
  iconColorClass="text-primary"
  type="staff"
  data={staffList}
  {onOpenMember}
  {fmt}
  {fmtH}
/>

<style>
  .premium-card {
    background: rgba(var(--color-surface-container-low), 0.4);
    backdrop-filter: blur(24px);
    border: 1px solid rgba(var(--color-outline-variant), 0.1);
    transition: all 0.4s cubic-bezier(0.2, 1, 0.3, 1);
  }
</style>
