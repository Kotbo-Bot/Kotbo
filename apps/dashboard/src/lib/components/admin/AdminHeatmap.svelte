<script lang="ts">
  /**
   * Carte de chaleur jour x heure.
   *
   * Les donnees arrivent en UTC (c'est ainsi qu'elles sont stockees) ; elles
   * sont decalees ici vers le fuseau du navigateur, sinon « le pic de 20 h »
   * s'afficherait a 18 h ou 19 h selon la saison.
   */
  const {
    grid,
    unit = 'messages',
  }: {
    /** 7 lignes (lundi en premier) de 24 valeurs, en heures UTC. */
    grid: number[][];
    unit?: string;
  } = $props();

  const DAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

  const local = $derived.by(() => {
    const offset = Math.round(-new Date().getTimezoneOffset() / 60);
    const shifted = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    for (let day = 0; day < 7; day += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        const target = hour + offset;
        const dayShift = Math.floor(target / 24);
        shifted[(((day + dayShift) % 7) + 7) % 7][((target % 24) + 24) % 24] += grid[day]?.[hour] ?? 0;
      }
    }
    return shifted;
  });

  const max = $derived(Math.max(1, ...local.flat()));
  const peak = $derived.by(() => {
    let best = { day: 0, hour: 0, value: 0 };
    local.forEach((row, day) => row.forEach((value, hour) => {
      if (value > best.value) best = { day, hour, value };
    }));
    return best;
  });
</script>

<div class="space-y-3">
  <div class="heat" role="img" aria-label="Activité par jour de la semaine et par heure">
    {#each local as row, day (day)}
      <span class="text-xs font-semibold text-on-surface-variant pr-2 self-center">{DAYS[day]}</span>
      {#each row as value, hour (hour)}
        <span
          class="cell"
          style="--level: {value === 0 ? 0 : 0.12 + 0.88 * (value / max)}"
          title="{DAYS[day]} {hour} h : {value.toLocaleString('fr-FR')} {unit}"
        ></span>
      {/each}
    {/each}
    <span></span>
    {#each Array(24) as _, hour (hour)}
      <span class="text-2xs text-on-surface-variant tabular-nums whitespace-nowrap">{hour % 6 === 0 ? `${hour} h` : ''}</span>
    {/each}
  </div>
  {#if peak.value > 0}
    <p class="text-body-sm text-on-surface-variant">
      Pic d’activité : <span class="font-semibold text-on-surface">{DAYS[peak.day].toLowerCase()}. vers {peak.hour} h</span>, heure locale.
    </p>
  {/if}
</div>

<style>
  .heat {
    display: grid;
    grid-template-columns: auto repeat(24, minmax(0, 1fr));
    gap: 3px;
  }
  .cell {
    aspect-ratio: 1;
    min-height: 12px;
    max-height: 26px;
    border-radius: 5px;
    background: color-mix(in srgb, var(--primary-color) calc(var(--level) * 100%), var(--surface-container));
  }
</style>
