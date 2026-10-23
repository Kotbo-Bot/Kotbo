<!--
  Climat d'un membre dans sa fiche (Kotbo × AegisAI) : toxicité moyenne et
  messages au-dessus du seuil sur 30 jours, émotions, dernières détections.
  Les extraits ne sont fournis qu'au staff de modération.
-->
<script lang="ts">
  import { SectionCard } from '../ui';
  import Sparkline from '../analytics/Sparkline.svelte';
  import { fmtNumber, fmtPct } from '../analytics/analyticsFormat';
  import { m, getLocale } from '../../i18n';
  import type { MemberClimate } from '../../api';
  import { EMOTION_COLORS, EMOTION_ORDER, emotionLabel, formatDateTime, kindLabel, points, statusLabel } from './aegisFormat';

  const { climate }: { climate: MemberClimate } = $props();

  const s = $derived(climate.summary);
  const emotionTotal = $derived(EMOTION_ORDER.reduce((sum, e) => sum + s.emotions[e], 0));
  const locale = $derived(getLocale());
</script>

<SectionCard title={m.aegis_member_title()} description={m.aegis_member_desc()}>
  <div class="px-5 pb-5 pt-3 flex flex-col gap-4">
    {#if s.analyzed === 0 && climate.detections.length === 0}
      <p class="text-body-sm text-on-surface-variant">{m.aegis_member_none()}</p>
    {:else}
      <dl class="facts">
        <div>
          <dt>{m.aegis_metric_avg()}</dt>
          <dd class="tabular-nums">{s.avgToxicity === null ? '—' : `${fmtNumber(Math.round(s.avgToxicity))} / 100`}</dd>
        </div>
        <div>
          <dt>{m.aegis_metric_toxic()}</dt>
          <dd class="tabular-nums {s.toxic > 0 ? 'text-error' : ''}">{fmtNumber(s.toxic)}<span class="text-on-surface-variant"> / {fmtNumber(s.analyzed)}</span></dd>
        </div>
        <div>
          <dt>{m.aegis_metric_dominant()}</dt>
          <dd>
            {#if s.dominant}<span class="dot" style="background: {EMOTION_COLORS[s.dominant]};" aria-hidden="true"></span>{/if}
            {emotionLabel(s.dominant)}
          </dd>
        </div>
      </dl>

      <Sparkline values={climate.days.map((d) => d.toxic)} width={280} height={32} color="var(--color-error)" />

      {#if emotionTotal > 0}
        <div class="mix" role="img" aria-label={EMOTION_ORDER.map((e) => `${emotionLabel(e)} ${fmtPct((s.emotions[e] / emotionTotal) * 100)}`).join(', ')}>
          {#each EMOTION_ORDER as e (e)}
            {#if s.emotions[e] > 0}<span style="width: {(s.emotions[e] / emotionTotal) * 100}%; background: {EMOTION_COLORS[e]};" title={`${emotionLabel(e)} ${fmtPct((s.emotions[e] / emotionTotal) * 100)}`}></span>{/if}
          {/each}
        </div>
      {/if}

      {#if climate.detections.length > 0}
        <div>
          <p class="recent__title">{m.aegis_member_recent()}</p>
          <ul class="recent">
            {#each climate.detections as d (d.id)}
              <li>
                <div class="recent__head">
                  <span class="recent__kind">{kindLabel(d.kind)}</span>
                  {#if d.toxicity !== null}<span class="tabular-nums text-on-surface-variant">{points(d.toxicity)}</span>{/if}
                  <span class="recent__meta">{statusLabel(d.status)} · {formatDateTime(d.createdAt, locale)}</span>
                </div>
                {#if d.excerpt}<p class="recent__excerpt">{d.excerpt}</p>{/if}
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    {/if}
  </div>
</SectionCard>

<style>
  .facts {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.75rem;
    margin: 0;
  }

  dt {
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }

  dd {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin: 0.125rem 0 0;
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--color-on-surface);
  }

  .dot {
    display: inline-block;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 999px;
  }

  .mix {
    display: flex;
    height: 0.5rem;
    overflow: hidden;
    border-radius: 999px;
    background: var(--color-surface-container);
  }

  .mix span {
    height: 100%;
  }

  .recent__title {
    margin: 0 0 0.5rem;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--color-on-surface-variant);
  }

  .recent {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .recent__head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.375rem;
    font-size: 0.8125rem;
  }

  .recent__kind {
    font-weight: 600;
    color: var(--color-on-surface);
  }

  .recent__meta {
    margin-left: auto;
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }

  .recent__excerpt {
    margin: 0.25rem 0 0;
    padding-left: 0.625rem;
    border-left: 2px solid var(--color-outline-variant);
    font-size: 0.75rem;
    line-height: 1.45;
    color: var(--color-on-surface-variant);
    overflow-wrap: anywhere;
  }
</style>
