<!-- Classement d'un tournoi : place finale (ex aequo possibles), bilan des matchs et des manches. -->
<script lang="ts">
  import type { Tournament } from '../../api/tournaments';
  import { m } from '../../i18n';

  let { tournament }: { tournament: Tournament } = $props();

  const medal = (placement: number | null) => (placement === 1 ? '🥇' : placement === 2 ? '🥈' : placement === 3 ? '🥉' : null);
</script>

<div class="overflow-x-auto rounded-xl border border-outline-variant bg-surface-container-low">
  <table class="w-full text-left text-sm">
    <thead class="border-b border-outline-variant text-xs text-on-surface-variant">
      <tr>
        <th class="px-4 py-3 font-medium">{m.tn_col_place()}</th>
        <th class="px-4 py-3 font-medium">{tournament.settings.teamSize > 1 ? m.tn_col_team() : m.tn_col_player()}</th>
        <th class="px-4 py-3 text-center font-medium">{m.tn_col_wins()}</th>
        <th class="px-4 py-3 text-center font-medium">{m.tn_col_losses()}</th>
        <th class="px-4 py-3 text-center font-medium">{m.tn_col_sets()}</th>
      </tr>
    </thead>
    <tbody class="divide-y divide-outline-variant">
      {#each tournament.standings as row (row.entrant.id)}
        <tr>
          <td class="whitespace-nowrap px-4 py-3 font-semibold text-on-surface">
            {#if row.placement === null}
              <span class="rounded-md bg-success/10 px-2 py-0.5 text-xs font-medium text-success">{m.tn_still_in()}</span>
            {:else}
              {medal(row.placement) ?? ''} {m.tn_place({ n: row.placement })}
            {/if}
          </td>
          <td class="px-4 py-3">
            <span class="font-medium text-on-surface">{row.entrant.name}</span>
            <span class="ml-1 text-xs text-on-surface-variant">#{row.entrant.seed}</span>
            {#if row.entrant.members.length}
              <p class="mt-0.5 text-xs text-on-surface-variant">{row.entrant.members.join(', ')}</p>
            {/if}
          </td>
          <td class="px-4 py-3 text-center text-on-surface">{row.wins}</td>
          <td class="px-4 py-3 text-center text-on-surface">{row.losses}</td>
          <td class="px-4 py-3 text-center text-on-surface-variant">{row.setsWon} – {row.setsLost}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
