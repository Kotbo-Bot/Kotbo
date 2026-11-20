<!--
  Estimation de l'effet du tag du serveur : porteurs du tag et arrivées sans
  source connue. Discord ne relie jamais une arrivée à un tag, d'où le mot
  « estimation » dans la description.
-->
<script lang="ts">
  import { SectionCard } from '../ui';
  import { m } from '../../i18n';
  import { fmtNumber, fmtPct } from './analyticsFormat';
  import type { MemberOverview } from '../../api';

  const { tag }: { tag: MemberOverview['tag'] } = $props();
</script>

<SectionCard title={m.tjc_title()} description={m.tjc_desc()}>
  {#if !tag}
    <p class="py-4 text-body-sm text-on-surface-variant">{m.tjc_empty()}</p>
  {:else}
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <div>
        <p class="text-body-sm text-on-surface-variant">{m.tjc_holders()}</p>
        <p class="text-2xl font-semibold text-on-surface">{fmtNumber(tag.holders)}</p>
      </div>
      <div>
        <p class="text-body-sm text-on-surface-variant">{m.tjc_gained()}</p>
        <p class="text-2xl font-semibold text-on-surface">{tag.gained > 0 ? '+' : ''}{fmtNumber(tag.gained)}</p>
      </div>
      <div>
        <p class="text-body-sm text-on-surface-variant">{m.tjc_unknown()}</p>
        <p class="text-2xl font-semibold text-on-surface">{fmtNumber(tag.unknownJoins)}</p>
      </div>
    </div>
    <p class="mt-3 text-body-sm text-on-surface-variant">
      {m.tjc_unknown_hint({ count: fmtNumber(tag.unknownJoins), pct: tag.unknownShare === null ? '–' : fmtPct(tag.unknownShare, 0) })}
    </p>
    <p class="mt-1 text-body-sm text-on-surface-variant">{m.tjc_days({ days: tag.daysMeasured })}</p>
  {/if}
</SectionCard>
