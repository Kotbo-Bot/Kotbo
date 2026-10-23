<script lang="ts">
  import Papicon from '../Papicon.svelte';
  import { m } from '../../i18n';
  import { memberAvatarSrc } from '../../discordMedia';

  const { data = [], onOpenMember = (_id: string, _name: string) => {} } = $props();

  const metrics = [
    { key: 'sanctionsCount', label: m.sp_metric_sanctions(), icon: 'Gavel', color: 'text-warning' },
    { key: 'reportsCount', label: m.sp_metric_reports(), icon: 'Megaphone', color: 'text-error' },
    { key: 'warns', label: m.sp_metric_warns(), icon: 'Warning', color: 'text-orange-400' },
    { key: 'bans', label: m.sp_metric_bans(), icon: 'Banning', color: 'text-error' },
  ];
</script>

<div class="space-y-6 animate-in fade-in slide-in-from-top-4 duration-500">
  <div class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
    <div class="flex justify-between items-center">
      <div>
        <h3 class="text-xl font-semibold flex items-center gap-3">
          <Papicon icon="TrendUp" size={20} class="text-primary" />
          {m.sp_title()}
        </h3>
        <p class="text-xs text-on-surface-variant mt-1 font-semibold">{m.sp_subtitle()}</p>
      </div>
    </div>

    <div class="overflow-x-auto no-scrollbar rounded-lg border border-outline-variant/5">
      <table class="w-full text-left border-collapse">
        <thead class="bg-surface-container-high/40 text-xs font-medium text-on-surface-variant">
          <tr>
            <th class="px-6 py-4">{m.sp_col_staff_member()}</th>
            {#each metrics as metric}
              <th class="px-6 py-4 text-center">
                <div class="flex items-center justify-center gap-1.5">
                  <Papicon icon={metric.icon} size={12} class={metric.color} />
                  {metric.label}
                </div>
              </th>
            {/each}
            <th class="px-6 py-4 text-center">{m.sp_col_score()}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/5">
          {#each data as staff}
            <tr class="hover:bg-surface-container-high/10 transition-colors group">
              <td class="px-6 py-4">
                <button
                  onclick={() => onOpenMember(staff.userId, staff.displayName || staff.username)}
                  class="flex items-center gap-3 hover:opacity-80 transition-opacity"
                >
                  <div class="relative">
                    <img src={memberAvatarSrc(staff.avatarUrl, staff.displayName || staff.username, staff.userId)} alt={staff.username} class="w-10 h-10 rounded-full border-2 border-outline-variant/10" />
                    {#if staff.reportRate > 80}
                      <span class="absolute -top-1 -right-1 w-4 h-4 bg-emerald-500 rounded-full border-2 border-surface flex items-center justify-center text-white"><Papicon icon="star" size={9} /></span>
                    {/if}
                  </div>
                  <div class="flex flex-col items-start">
                    <span class="text-sm font-semibold">{staff.displayName || staff.username}</span>
                    <span class="text-2xs text-on-surface-variant/40 font-mono">@{staff.username}</span>
                  </div>
                </button>
              </td>
              {#each metrics as metric}
                <td class="px-6 py-4 text-center font-bold text-sm">
                  {staff[metric.key] || 0}
                </td>
              {/each}
              <td class="px-6 py-4 text-center">
                <div class="flex flex-col items-center gap-1">
                  <span class="text-xs font-semibold text-primary">{staff.reportRate}%</span>
                  <div class="w-16 h-1 bg-surface-container-high rounded-full overflow-hidden">
                    <div class="h-full bg-primary rounded-full" style="width: {staff.reportRate}%"></div>
                  </div>
                  <span class="text-2xs font-bold text-on-surface-variant/30 uppercase tracking-tighter">{m.sp_accuracy_label()}</span>
                </div>
              </td>
            </tr>
          {:else}
            <tr>
              <td colspan="6" class="px-6 py-12 text-center text-on-surface-variant/30">
                <div class="flex flex-col items-center gap-3">
                  <Papicon icon="UserFocus" size={48} />
                  <p class="text-sm font-bold">{m.sp_empty()}</p>
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
</div>
