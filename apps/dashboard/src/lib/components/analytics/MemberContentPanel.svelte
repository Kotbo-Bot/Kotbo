<!--
  Onglet « Contenu » de la fiche membre : ce que ce membre poste, en résumé.
  Types de message, emojis et réactions favoris, stickers, sites cités, mise
  en forme. Sa propre période, indépendante de la page qui ouvre la fiche.
-->
<script lang="ts">
  import { Callout, EmptyState, FilterPills } from '../ui';
  import BarList, { type BarListItem } from './BarList.svelte';
  import ShareBar, { type ShareSegment } from './ShareBar.svelte';
  import { fetchContentAnalytics, type ContentAnalytics, type ContentEmoji } from '../../api';
  import { m } from '../../i18n';
  import { errorMessage } from '@kotbo/shared';
  import { pct } from './analyticsFilters.svelte';
  import { fmtNumber, fmtPct, SERIES, SERIES_NEUTRAL } from './analyticsFormat';

  const { userId }: { userId: string } = $props();

  let period = $state<'30' | '90' | '365'>('30');
  let data = $state<ContentAnalytics | null>(null);
  let loading = $state(true);
  let error = $state('');
  let requestId = 0;

  $effect(() => {
    const id = ++requestId;
    const query = { period: Number(period), userId };
    loading = true;
    error = '';
    fetchContentAnalytics(query)
      .then((res) => {
        if (id === requestId) data = res;
      })
      .catch((e) => {
        if (id === requestId) error = errorMessage(e) || m.an_error_generic();
      })
      .finally(() => {
        if (id === requestId) loading = false;
      });
  });

  const t = $derived(data?.totals ?? {});
  const messages = $derived(t.messages ?? 0);

  const facts = $derived([
    { label: m.anx_content_kpi_emoji(), value: fmtPct(pct(t.withEmoji ?? 0, messages), 0) },
    { label: m.anx_type_gif(), value: fmtPct(pct(t.typeGif ?? 0, messages), 0) },
    { label: m.anx_content_kpi_markdown(), value: fmtPct(pct(t.withMarkdown ?? 0, messages), 0) },
    { label: m.anx_content_kpi_link(), value: fmtPct(pct(t.withLink ?? 0, messages), 0) },
  ]);

  const typeSegments: ShareSegment[] = $derived([
    { id: 'text', label: m.anx_type_text(), value: t.typeText ?? 0, color: SERIES_NEUTRAL },
    { id: 'image', label: m.anx_type_image(), value: t.typeImage ?? 0, color: SERIES[0] },
    { id: 'gif', label: m.anx_type_gif(), value: t.typeGif ?? 0, color: SERIES[1] },
    { id: 'link', label: m.anx_type_link(), value: t.typeLink ?? 0, color: SERIES[2] },
    { id: 'video', label: m.anx_type_video(), value: t.typeVideo ?? 0, color: SERIES[3] },
    { id: 'sticker', label: m.anx_type_sticker(), value: t.typeSticker ?? 0, color: SERIES[4] },
    { id: 'forward', label: m.anx_type_forward(), value: t.typeForward ?? 0, color: SERIES[5] },
    { id: 'voice', label: m.anx_type_voice(), value: (t.typeVoice ?? 0) + (t.typeAudio ?? 0), color: SERIES[6] },
    { id: 'other', label: m.anx_type_other(), value: (t.typeFile ?? 0) + (t.typePoll ?? 0), color: SERIES[7] },
  ]);

  type EmojiItem = BarListItem & { emoji: ContentEmoji };
  const toItems = (list: ContentEmoji[] | undefined): EmojiItem[] =>
    (list ?? []).slice(0, 6).map((e) => ({
      id: `${e.origin}:${e.key}`,
      label: e.origin === 'unicode' ? e.key : `:${e.name ?? '?'}:`,
      value: e.count,
      emoji: e,
    }));

  const emojiItems = $derived(toItems(data?.emojis));
  const reactionItems = $derived(toItems(data?.reactions));
  const domainItems: BarListItem[] = $derived((data?.domains ?? []).slice(0, 5).map((d) => ({ id: d.domain, label: d.domain, value: d.count })));
</script>

<div class="flex flex-col gap-5">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <p class="text-body-sm text-on-surface-variant">{m.anx_member_content_desc()}</p>
    <FilterPills
      label={m.anx_filter_period_label()}
      options={[{ value: '30', label: m.an_period_30d() }, { value: '90', label: m.an_period_90d() }, { value: '365', label: m.an_period_365d() }]}
      value={period}
      onchange={(v) => (period = v as typeof period)}
    />
  </div>

  {#if loading && !data}
    <p class="py-10 text-center text-body-sm text-on-surface-variant">{m.an_loading_short()}</p>
  {:else if error}
    <Callout variant="danger" title={m.an_error_generic()}>{error}</Callout>
  {:else if messages === 0}
    <EmptyState icon="message-square" title={m.anx_member_content_empty()} description={m.anx_content_empty_desc()} reason="accumulating" />
  {:else}
    <div class="member-facts">
      <div class="member-fact">
        <span class="text-body-sm text-on-surface-variant">{m.anx_kpi_messages()}</span>
        <span class="member-fact__value">{fmtNumber(messages)}</span>
      </div>
      {#each facts as fact (fact.label)}
        <div class="member-fact">
          <span class="text-body-sm text-on-surface-variant">{fact.label}</span>
          <span class="member-fact__value">{fact.value}</span>
        </div>
      {/each}
    </div>

    <div class="flex flex-col gap-2">
      <h4 class="text-sm font-semibold text-on-surface">{m.anx_types_title()}</h4>
      <ShareBar segments={typeSegments} columns={3} />
    </div>

    <div class="member-grid">
      <div class="flex flex-col gap-2">
        <h4 class="text-sm font-semibold text-on-surface">{m.anx_member_top_emojis()}</h4>
        <BarList items={emojiItems} empty={m.anx_emojis_empty()}>
          {#snippet leading(item)}
            <span class="member-glyph">
              {#if item.emoji.imageUrl}<img src={item.emoji.imageUrl} alt="" width="20" height="20" loading="lazy" />{:else}<span aria-hidden="true">{item.emoji.key}</span>{/if}
            </span>
          {/snippet}
        </BarList>
      </div>
      <div class="flex flex-col gap-2">
        <h4 class="text-sm font-semibold text-on-surface">{m.anx_member_top_reactions()}</h4>
        <BarList items={reactionItems} color={SERIES[1]} empty={m.anx_emojis_empty()}>
          {#snippet leading(item)}
            <span class="member-glyph">
              {#if item.emoji.imageUrl}<img src={item.emoji.imageUrl} alt="" width="20" height="20" loading="lazy" />{:else}<span aria-hidden="true">{item.emoji.key}</span>{/if}
            </span>
          {/snippet}
        </BarList>
      </div>
      <div class="flex flex-col gap-2">
        <h4 class="text-sm font-semibold text-on-surface">{m.anx_sites_title()}</h4>
        <BarList items={domainItems} color={SERIES[2]} empty={m.anx_sites_empty()} />
      </div>
    </div>
  {/if}
</div>

<style>
  .member-facts {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }

  .member-fact {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    padding: 0.75rem 0.875rem;
    border-radius: 0.75rem;
    border: 1px solid var(--color-outline-variant);
    background: var(--color-surface-container-low);
  }

  .member-fact__value {
    font-family: var(--font-headline);
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--color-on-surface);
    font-variant-numeric: tabular-nums;
  }

  .member-grid {
    display: grid;
    gap: 1.25rem;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .member-glyph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    flex-shrink: 0;
    border-radius: 0.375rem;
    background: var(--color-surface-container);
    font-size: 1rem;
  }

  .member-glyph img {
    width: 1.25rem;
    height: 1.25rem;
    object-fit: contain;
  }

  @media (max-width: 767px) {
    .member-facts {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .member-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
