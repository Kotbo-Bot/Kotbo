<!--
  Temps réel, façon GA4 : ce qui se passe sur le serveur maintenant. Les
  barres donnent les messages minute par minute sur les 30 dernières
  minutes ; à côté, le rythme actuel, les membres en ligne et en vocal, les
  salons qui bougent. Mis à jour toutes les 5 secondes par le WebSocket.
  En mode compact (vue d'ensemble), seule une ligne de chiffres et les barres.
-->
<script lang="ts">
  import { Callout } from '../ui';
  import { authStore } from '../../stores/auth.svelte';
  import { realtimeStore } from '../../stores/realtime.svelte';
  import { channelDetailsModal } from '../../stores/channelDetailsModal.svelte';
  import { m, dateLocale } from '../../i18n';
  import { analyticsLive } from './analyticsLive.svelte';
  import { fmtNumber } from './analyticsFormat';

  const { compact = false }: { compact?: boolean } = $props();

  const live = analyticsLive(() => authStore.selectedGuildId);
  const snap = $derived(live.snapshot);
  const max = $derived(Math.max(1, ...(snap?.minutes.map((x) => x.messages) ?? [1])));
  const partial = $derived(snap ? Date.now() - Date.parse(snap.since) < snap.windowMinutes * 60_000 : false);
  const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' });
</script>

<section class="live" class:live--compact={compact} aria-live="off">
  <header class="live__head">
    <span class="live__title">
      <span class="live__dot" class:live__dot--off={!realtimeStore.live || !snap} aria-hidden="true"></span>
      {m.anx_live_title_rt()}
    </span>
    <span class="live__sub">
      {#if snap}
        {m.anx_live_window({ minutes: String(snap.windowMinutes) })} · {m.anx_live_updated({ time: timeOf(snap.at) })}
      {:else if live.denied}
        {m.anx_live_denied()}
      {:else}
        {m.anx_live_waiting()}
      {/if}
    </span>
  </header>

  {#if live.denied}
    <Callout variant="info">{m.anx_live_denied()}</Callout>
  {:else if snap}
    <div class="live__body">
      <dl class="live__facts">
        <div><dt>{m.anx_live_messages()}</dt><dd>{fmtNumber(snap.messages)}</dd></div>
        <div><dt>{m.anx_live_per_minute()}</dt><dd>{fmtNumber(snap.perMinute)}</dd></div>
        <div><dt>{m.anx_live_authors()}</dt><dd>{fmtNumber(snap.authors)}</dd></div>
        <div><dt>{m.anx_live_voice_now()}</dt><dd>{fmtNumber(snap.voiceNow)}</dd></div>
        <div><dt>{m.anx_live_online_now()}</dt><dd>{fmtNumber(snap.onlineNow)}</dd></div>
        {#if !compact}
          <div><dt>{m.anx_live_joins()}</dt><dd>{snap.joins > 0 ? '+' : ''}{fmtNumber(snap.joins)}{#if snap.leaves > 0}<span class="live__minus"> −{fmtNumber(snap.leaves)}</span>{/if}</dd></div>
        {/if}
      </dl>

      <div class="live__bars" role="img" aria-label={m.anx_live_bars_label({ total: fmtNumber(snap.messages) })}>
        {#each snap.minutes as minute (minute.at)}
          <span class="live__bar" style="height: {Math.max(4, (minute.messages / max) * 100)}%;" title={`${timeOf(minute.at)} : ${fmtNumber(minute.messages)}`}></span>
        {/each}
      </div>

      {#if !compact}
        <div class="live__lists">
          <div>
            <h4 class="live__list-title">{m.anx_live_hot_channels()}</h4>
            {#if snap.channels.length === 0}
              <p class="live__empty">{m.anx_live_quiet()}</p>
            {:else}
              <ul>
                {#each snap.channels as c (c.channelId)}
                  <li>
                    <button type="button" class="live__row" onclick={() => channelDetailsModal.show(c.channelId, c.name ? `#${c.name}` : m.anx_channel_deleted())}>
                      <span class="truncate">#{c.name ?? '?'}</span><span class="live__count">{fmtNumber(c.messages)}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
          <div>
            <h4 class="live__list-title">{m.anx_live_voice_channels()}</h4>
            {#if snap.voiceChannels.length === 0}
              <p class="live__empty">{m.anx_live_voice_empty()}</p>
            {:else}
              <ul>
                {#each snap.voiceChannels as c (c.channelId)}
                  <li class="live__row live__row--static"><span class="truncate">{c.name ?? '?'}</span><span class="live__count">{fmtNumber(c.members)}</span></li>
                {/each}
              </ul>
            {/if}
          </div>
        </div>
      {/if}
      {#if partial}
        <p class="live__note">{m.anx_live_partial({ time: timeOf(snap.since) })}</p>
      {/if}
    </div>
  {/if}
</section>

<style>
  .live {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1rem;
    border-radius: 0.875rem;
    border: 1px solid var(--color-outline-variant);
    background: var(--color-surface-container-lowest, var(--color-surface));
  }

  .live__head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.25rem 1rem;
  }

  .live__title {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--color-on-surface);
  }

  .live__dot {
    position: relative;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 999px;
    background: var(--color-success);
  }

  /* Halo animé en transform/opacity (compositeur) : animer box-shadow repeignait à chaque image. */
  .live__dot::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: var(--color-success);
    will-change: transform, opacity;
    animation: live-pulse 2s ease-out infinite;
  }

  .live__dot--off {
    background: var(--series-neutral);
  }

  .live__dot--off::after {
    animation: none;
    display: none;
  }

  @keyframes live-pulse {
    0% { transform: scale(1); opacity: 0.5; }
    100% { transform: scale(3); opacity: 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    .live__dot::after {
      animation: none;
    }
  }

  .live__sub {
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }

  .live__body {
    display: grid;
    gap: 0.875rem 1.5rem;
    grid-template-columns: minmax(0, 1fr);
  }

  .live__facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
    gap: 0.5rem 1.25rem;
  }

  .live__facts dt {
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }

  .live__facts dd {
    font-family: var(--font-headline);
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--color-on-surface);
  }

  .live--compact .live__facts dd {
    font-size: 1.0625rem;
  }

  .live__minus {
    font-size: 0.875rem;
    color: var(--color-on-surface-variant);
  }

  .live__bars {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 3.5rem;
  }

  .live--compact .live__bars {
    height: 2.25rem;
  }

  .live__bar {
    flex: 1;
    min-width: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--series-1);
  }

  .live__bar:last-child {
    opacity: 0.55;
  }

  .live__lists {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr));
  }

  .live__list-title {
    margin-bottom: 0.375rem;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-on-surface);
  }

  .live__row {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    width: 100%;
    padding: 0.25rem 0.375rem;
    border-radius: 0.375rem;
    font-size: 0.8125rem;
    color: var(--color-on-surface);
    text-align: left;
  }

  button.live__row:hover {
    background: var(--color-surface-container);
  }

  .live__count {
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
    color: var(--color-on-surface-variant);
  }

  .live__empty,
  .live__note {
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }
</style>
