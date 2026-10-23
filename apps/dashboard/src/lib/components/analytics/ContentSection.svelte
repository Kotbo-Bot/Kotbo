<!--
  Section « Contenu » : ce que les membres postent. Types de message, emojis
  (dans les messages et en réaction) et leur serveur d'origine, stickers, GIF,
  sites cités, mise en forme et style de message. Suit tous les filtres.
  Un sous-onglet à la fois ; les mots ont leur propre panneau, monté par la page.
-->
<script lang="ts" module>
  export type ContentView = 'content' | 'emojis' | 'stickers' | 'gifs' | 'sites' | 'formatting';
</script>

<script lang="ts">
  import { Callout, EmptyState, FilterPills, SectionCard } from '../ui';
  import BarList, { type BarListItem } from './BarList.svelte';
  import ShareBar, { type ShareSegment } from './ShareBar.svelte';
  import KpiTile from './KpiTile.svelte';
  import AnalyticsSkeleton from './AnalyticsSkeleton.svelte';
  import { fetchContentAnalytics, type ContentAnalytics, type ContentEmoji, type ContentSourceServer, type ContentSticker } from '../../api';
  import { channelDetailsModal } from '../../stores/channelDetailsModal.svelte';
  import { m } from '../../i18n';
  import { errorMessage } from '@kotbo/shared';
  import { analyticsExport, analyticsFilters as filters, pct } from './analyticsFilters.svelte';
  import { fmtNumber, fmtPct, SERIES, SERIES_NEUTRAL } from './analyticsFormat';

  const { view }: { view: ContentView } = $props();

  let data = $state<ContentAnalytics | null>(null);
  let loading = $state(true);
  let error = $state('');
  let requestId = 0;

  $effect(() => {
    const query = filters.query;
    const id = ++requestId;
    loading = true;
    error = '';
    fetchContentAnalytics(query)
      .then((res) => {
        if (id !== requestId) return;
        data = res;
        analyticsExport.content = res;
      })
      .catch((e) => {
        if (id === requestId) error = errorMessage(e) || m.an_error_generic();
      })
      .finally(() => {
        if (id === requestId) loading = false;
      });
  });

  const t = $derived(data?.totals ?? {});
  const p = $derived(data?.previous ?? {});
  const messages = $derived(t.messages ?? 0);

  /** Écart en points entre deux parts de messages. */
  function ptsDelta(key: string): number | null {
    if (!(p.messages > 0)) return null;
    return pct(t[key] ?? 0, messages) - pct(p[key] ?? 0, p.messages);
  }

  const kpis = $derived([
    { key: 'withEmoji', label: m.anx_content_kpi_emoji() },
    { key: 'withMarkdown', label: m.anx_content_kpi_markdown() },
    { key: 'reactedMessages', label: m.anx_content_kpi_reaction(), hint: m.anx_content_kpi_reaction_hint() },
    { key: 'withLink', label: m.anx_content_kpi_link() },
    { key: 'withMedia', label: m.anx_content_kpi_media() },
  ]);

  // Couleurs d'identité, dans l'ordre fixe de la palette. Au-delà de huit
  // teintes, les types rares sont regroupés plutôt que d'inventer une couleur.
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

  // Origine : Discord de base, du serveur, externe. Mêmes couleurs pour les
  // emojis et les stickers, pour qu'une origine se reconnaisse partout.
  const ORIGIN_COLOR: Record<string, string> = {
    unicode: SERIES[0], standard: SERIES[0], guild: SERIES[1], external: SERIES[2],
  };
  const originLabel = (origin: string) => ({
    unicode: m.anx_origin_unicode(),
    standard: m.anx_origin_standard(),
    guild: m.anx_origin_guild(),
    external: m.anx_origin_external(),
  })[origin] ?? origin;

  let emojiMode = $state<'messages' | 'reactions'>('messages');
  const emojiOrigins: ShareSegment[] = $derived(
    emojiMode === 'messages'
      ? [
          { id: 'unicode', label: m.anx_origin_unicode(), value: t.emojiUnicode ?? 0, color: ORIGIN_COLOR.unicode },
          { id: 'guild', label: m.anx_origin_guild(), value: t.emojiGuild ?? 0, color: ORIGIN_COLOR.guild },
          { id: 'external', label: m.anx_origin_external(), value: t.emojiExternal ?? 0, color: ORIGIN_COLOR.external },
        ]
      : [
          { id: 'unicode', label: m.anx_origin_unicode(), value: t.reactUnicode ?? 0, color: ORIGIN_COLOR.unicode },
          { id: 'guild', label: m.anx_origin_guild(), value: t.reactGuild ?? 0, color: ORIGIN_COLOR.guild },
          { id: 'external', label: m.anx_origin_external(), value: t.reactExternal ?? 0, color: ORIGIN_COLOR.external },
        ],
  );

  type EmojiItem = BarListItem & { emoji: ContentEmoji };
  const emojiItems: EmojiItem[] = $derived(
    ((emojiMode === 'messages' ? data?.emojis : data?.reactions) ?? []).map((e) => ({
      id: `${e.origin}:${e.key}`,
      label: e.origin === 'unicode' ? e.key : `:${e.name ?? '?'}:`,
      sub: e.origin === 'external' ? e.sourceName ?? m.anx_source_unknown() : undefined,
      value: e.count,
      color: ORIGIN_COLOR[e.origin],
      emoji: e,
    })),
  );

  function serverItems(list: ContentSourceServer[] | undefined): BarListItem[] {
    return (list ?? []).map((s, i) => ({
      id: s.guildId ?? `unknown-${i}`,
      label: s.name ?? (s.guildId ? m.anx_source_private() : m.anx_source_unknown()),
      sub: m.anx_source_items({ count: String(s.items) }),
      value: s.count,
      color: s.name || s.guildId ? ORIGIN_COLOR.external : SERIES_NEUTRAL,
    }));
  }

  const emojiServerItems = $derived(serverItems(emojiMode === 'messages' ? data?.emojiServers : data?.reactionServers));

  const customEmojiUses = $derived((t.emojiGuild ?? 0) + (t.emojiExternal ?? 0));
  const emojiStyleItems: BarListItem[] = $derived([
    { id: 'animated', label: m.anx_emoji_style_animated(), value: pct(t.emojiAnimated ?? 0, customEmojiUses), display: fmtPct(pct(t.emojiAnimated ?? 0, customEmojiUses)), sub: m.anx_emoji_style_animated_sub() },
    { id: 'only', label: m.anx_emoji_style_only(), value: pct(t.emojiOnly ?? 0, messages), display: fmtPct(pct(t.emojiOnly ?? 0, messages)), sub: m.anx_emoji_style_only_sub() },
  ]);

  const stickerOrigins: ShareSegment[] = $derived([
    { id: 'standard', label: m.anx_origin_standard(), value: t.stickerStandard ?? 0, color: ORIGIN_COLOR.standard },
    { id: 'guild', label: m.anx_origin_guild(), value: t.stickerGuild ?? 0, color: ORIGIN_COLOR.guild },
    { id: 'external', label: m.anx_origin_external(), value: t.stickerExternal ?? 0, color: ORIGIN_COLOR.external },
  ]);

  type StickerItem = BarListItem & { sticker: ContentSticker };
  const stickerItems: StickerItem[] = $derived(
    (data?.stickers ?? []).map((s) => ({
      id: s.key,
      label: s.name ?? m.anx_sticker_unnamed(),
      sub: s.origin === 'standard' ? m.anx_origin_standard() : s.sourceName ?? m.anx_source_unknown(),
      value: s.count,
      color: ORIGIN_COLOR[s.origin],
      sticker: s,
    })),
  );

  const gifTotal = $derived((t.gifTenor ?? 0) + (t.gifGiphy ?? 0) + (t.gifUpload ?? 0) + (t.gifOther ?? 0));
  const gifItems: BarListItem[] = $derived([
    { id: 'tenor', label: 'Tenor', value: t.gifTenor ?? 0, color: SERIES[0] },
    { id: 'giphy', label: 'Giphy', value: t.gifGiphy ?? 0, color: SERIES[1] },
    { id: 'upload', label: m.anx_gif_upload(), value: t.gifUpload ?? 0, color: SERIES[2] },
    { id: 'other', label: m.anx_gif_other(), value: t.gifOther ?? 0, color: SERIES_NEUTRAL },
  ].map((g) => ({ ...g, display: fmtPct(pct(g.value, gifTotal)), sub: fmtNumber(g.value) })));

  const familyLabel = (family: string) => ({
    video: m.anx_family_video(), stream: m.anx_family_stream(), social: m.anx_family_social(),
    discord_invite: m.anx_family_discord_invite(), discord: m.anx_family_discord(), code: m.anx_family_code(),
    game: m.anx_family_game(), music: m.anx_family_music(), tech: m.anx_family_tech(), tool: m.anx_family_tool(),
    reference: m.anx_family_reference(), image: m.anx_family_image(), shop: m.anx_family_shop(),
  })[family] ?? m.anx_family_other();

  const domainItems: BarListItem[] = $derived(
    (data?.domains ?? []).map((d) => ({ id: d.domain, label: d.domain, sub: familyLabel(d.family), value: d.count })),
  );

  const markdownItems: BarListItem[] = $derived(
    [
      ['mdBold', m.anx_md_bold()], ['mdItalic', m.anx_md_italic()], ['mdUnderline', m.anx_md_underline()],
      ['mdStrike', m.anx_md_strike()], ['mdSpoiler', m.anx_md_spoiler()], ['mdInlineCode', m.anx_md_inline_code()],
      ['mdCodeBlock', m.anx_md_code_block()], ['mdQuote', m.anx_md_quote()], ['mdHeading', m.anx_md_heading()],
      ['mdList', m.anx_md_list()], ['mdMaskedLink', m.anx_md_masked_link()], ['mdSubtext', m.anx_md_subtext()],
    ]
      .map(([key, label]) => ({ id: key, label, value: t[key] ?? 0, display: fmtPct(pct(t[key] ?? 0, t.withMarkdown ?? 0)) }))
      .sort((a, b) => b.value - a.value),
  );

  const styleItems: BarListItem[] = $derived(
    [
      ['styleReply', m.anx_style_reply()], ['styleMention', m.anx_style_mention()], ['styleThread', m.anx_style_thread()],
      ['styleEdited', m.anx_style_edited()], ['typeForward', m.anx_style_forward()],
    ].map(([key, label]) => ({ id: key, label, value: t[key] ?? 0, display: fmtPct(pct(t[key] ?? 0, messages)) })),
  );

  const lengthSegments: ShareSegment[] = $derived([
    { id: 'short', label: m.anx_length_short(), value: t.lenShort ?? 0, color: SERIES[0] },
    { id: 'medium', label: m.anx_length_medium(), value: t.lenMedium ?? 0, color: SERIES[1] },
    { id: 'long', label: m.anx_length_long(), value: t.lenLong ?? 0, color: SERIES[2] },
  ]);

  const gifChannelItems: BarListItem[] = $derived(
    (data?.gifChannels ?? []).map((c) => ({ id: c.channelId, label: c.name ? `#${c.name}` : m.anx_channel_deleted(), value: c.count })),
  );

  const backfillRunning = $derived(data?.backfill && (data.backfill.status === 'PENDING' || data.backfill.status === 'IN_PROGRESS'));

  // Chiffres clés des sous-onglets.
  const emojiUses = $derived((t.emojiUnicode ?? 0) + (t.emojiGuild ?? 0) + (t.emojiExternal ?? 0));
  const reactionUses = $derived((t.reactUnicode ?? 0) + (t.reactGuild ?? 0) + (t.reactExternal ?? 0));
  const stickerUses = $derived((t.stickerGuild ?? 0) + (t.stickerExternal ?? 0) + (t.stickerStandard ?? 0));
  const emojiServerCount = $derived((data?.emojiServers ?? []).filter((s) => s.name || s.guildId).length);

  /** Répartition des liens par famille de site, sur les domaines du classement. */
  const familySegments: ShareSegment[] = $derived.by(() => {
    const byFamily = new Map<string, number>();
    for (const d of data?.domains ?? []) byFamily.set(d.family, (byFamily.get(d.family) ?? 0) + d.count);
    const sorted = [...byFamily.entries()].sort((a, b) => b[1] - a[1]);
    const head = sorted.slice(0, 7);
    const rest = sorted.slice(7).reduce((s, [, n]) => s + n, 0);
    return [
      ...head.map(([family, value], i) => ({ id: family, label: familyLabel(family), value, color: SERIES[i]! })),
      ...(rest > 0 ? [{ id: 'rest', label: m.anx_family_other(), value: rest, color: SERIES_NEUTRAL }] : []),
    ];
  });
</script>

{#if loading && !data}
  <AnalyticsSkeleton />
{:else if error}
  <Callout variant="danger" title={m.an_error_generic()}>{error}</Callout>
{:else if data}
  <div class="flex flex-col gap-4" aria-busy={loading}>
    {#if backfillRunning}
      <Callout variant="info" title={m.anx_backfill_title()}>
        {m.anx_backfill_desc({ processed: fmtNumber(data.backfill?.processed), total: fmtNumber(data.backfill?.total) })}
      </Callout>
    {/if}
    {#if data.itemBasis === 'channel' && (filters.role || filters.excludeStaff)}
      <Callout variant="info">{m.anx_content_rank_basis_channel()}</Callout>
    {/if}

    {#if messages === 0}
      <SectionCard>
        <EmptyState icon="message-square" title={m.anx_content_empty_title()} description={m.anx_content_empty_desc()} reason="accumulating" />
      </SectionCard>
    {:else if view === 'content'}
      <div class="kpi-grid kpi-grid--5">
        {#each kpis as k (k.key)}
          <KpiTile
            label={k.label}
            value={fmtPct(pct(t[k.key] ?? 0, messages), 0)}
            delta={ptsDelta(k.key)}
            unit="pts"
            compare={filters.compare}
            hint={k.hint}
          />
        {/each}
      </div>

      <SectionCard title={m.anx_types_title()} description={m.anx_types_desc({ count: fmtNumber(messages) })}>
        <ShareBar segments={typeSegments} columns={3} showCounts />
      </SectionCard>

      <div class="section-grid">
        <div class="span-6">
          <SectionCard title={m.anx_style_title()} description={m.anx_style_desc()}>
            <BarList items={styleItems} color={SERIES[2]} />
          </SectionCard>
        </div>
        <div class="span-6">
          <SectionCard title={m.anx_length_title()}>
            <ShareBar segments={lengthSegments} columns={1} showCounts />
          </SectionCard>
        </div>
      </div>
    {:else if view === 'emojis'}
      <div class="kpi-grid kpi-grid--4">
        <KpiTile label={m.anx_emojis_kpi_uses()} value={fmtNumber(emojiUses)} />
        <KpiTile label={m.anx_content_kpi_emoji()} value={fmtPct(pct(t.withEmoji ?? 0, messages), 0)} delta={ptsDelta('withEmoji')} unit="pts" compare={filters.compare} />
        <KpiTile label={m.anx_emojis_kpi_reactions()} value={fmtNumber(reactionUses)} />
        <KpiTile label={m.anx_emojis_kpi_servers()} value={fmtNumber(emojiServerCount)} hint={m.anx_emojis_kpi_servers_hint()} />
      </div>

      <div class="section-grid">
        <div class="span-7">
          <SectionCard title={m.anx_emojis_title()} description={m.anx_emojis_desc()}>
            {#snippet actions()}
              <FilterPills
                label={m.anx_emojis_mode_label()}
                options={[{ value: 'messages', label: m.anx_emojis_mode_messages() }, { value: 'reactions', label: m.anx_emojis_mode_reactions() }]}
                value={emojiMode}
                onchange={(v) => (emojiMode = v as typeof emojiMode)}
              />
            {/snippet}
            <div class="flex flex-col gap-5">
              <ShareBar segments={emojiOrigins} columns={3} showCounts />
              <BarList items={emojiItems} empty={m.anx_emojis_empty()}>
                {#snippet leading(item)}
                  <span class="emoji-glyph">
                    {#if item.emoji.imageUrl}
                      <img src={item.emoji.imageUrl} alt="" loading="lazy" width="24" height="24" />
                    {:else}
                      <span aria-hidden="true">{item.emoji.key}</span>
                    {/if}
                  </span>
                {/snippet}
                {#snippet trailing(item)}
                  <span class="origin-tag">{originLabel(item.emoji.origin)}</span>
                {/snippet}
              </BarList>
            </div>
          </SectionCard>
        </div>
        <div class="span-5 flex flex-col gap-4">
          <SectionCard title={m.anx_emoji_servers_title()} description={m.anx_emoji_servers_desc()}>
            <BarList items={emojiServerItems} empty={m.anx_emoji_servers_empty()} />
          </SectionCard>
          <SectionCard title={m.anx_emoji_style_title()}>
            <BarList items={emojiStyleItems} max={100} />
          </SectionCard>
        </div>
      </div>
    {:else if view === 'stickers'}
      <div class="kpi-grid kpi-grid--4">
        <KpiTile label={m.anx_stickers_kpi_uses()} value={fmtNumber(stickerUses)} />
        <KpiTile label={m.anx_stickers_kpi_share()} value={fmtPct(pct(t.typeSticker ?? 0, messages))} delta={ptsDelta('typeSticker')} unit="pts" compare={filters.compare} />
        <KpiTile label={m.anx_origin_guild()} value={fmtPct(pct(t.stickerGuild ?? 0, stickerUses), 0)} />
        <KpiTile label={m.anx_origin_external()} value={fmtPct(pct(t.stickerExternal ?? 0, stickerUses), 0)} />
      </div>

      <div class="section-grid">
        <div class="span-12">
          <SectionCard title={m.anx_stickers_title()} description={m.anx_stickers_desc()}>
            <div class="flex flex-col gap-5">
              <ShareBar segments={stickerOrigins} columns={3} showCounts />
              <BarList items={stickerItems} empty={m.anx_stickers_empty()}>
                {#snippet leading(item)}
                  <img class="sticker-thumb" src={item.sticker.imageUrl} alt="" loading="lazy" width="36" height="36" />
                {/snippet}
              </BarList>
              {#if (data.stickerServers ?? []).length > 0}
                <div class="flex flex-col gap-2 border-t border-outline-variant pt-4">
                  <span class="text-body-sm font-medium text-on-surface">{m.anx_sticker_servers_title()}</span>
                  <BarList items={serverItems(data.stickerServers)} />
                </div>
              {/if}
            </div>
          </SectionCard>
        </div>
      </div>
    {:else if view === 'gifs'}
      <div class="kpi-grid kpi-grid--4">
        <KpiTile label={m.anx_gif_kpi_count()} value={fmtNumber(gifTotal)} />
        <KpiTile label={m.anx_gif_kpi_share()} value={fmtPct(pct(t.typeGif ?? 0, messages))} delta={ptsDelta('typeGif')} unit="pts" compare={filters.compare} />
        <KpiTile label="Tenor" value={fmtPct(pct(t.gifTenor ?? 0, gifTotal), 0)} />
        <KpiTile label={m.anx_gif_upload()} value={fmtPct(pct(t.gifUpload ?? 0, gifTotal), 0)} />
      </div>

      <div class="section-grid">
        <div class="span-12">
          <SectionCard title={m.anx_gif_title()} description={m.anx_gif_desc({ share: fmtPct(pct(t.typeGif ?? 0, messages)) })}>
            <div class="flex flex-col gap-5">
              <BarList items={gifItems} max={Math.max(1, ...gifItems.map((g) => g.value))} empty={m.anx_gif_empty()} />
              {#if gifChannelItems.length > 0}
                <div class="flex flex-col gap-2 border-t border-outline-variant pt-4">
                  <span class="text-body-sm font-medium text-on-surface">{m.anx_gif_channels_title()}</span>
                  <BarList items={gifChannelItems} color={SERIES[1]} onselect={(item) => channelDetailsModal.show(item.id, item.label)} />
                </div>
              {/if}
            </div>
          </SectionCard>
        </div>
      </div>
    {:else if view === 'sites'}
      <div class="kpi-grid kpi-grid--4">
        <KpiTile label={m.anx_content_kpi_link()} value={fmtPct(pct(t.withLink ?? 0, messages))} delta={ptsDelta('withLink')} unit="pts" compare={filters.compare} />
        <KpiTile label={m.anx_sites_kpi_messages()} value={fmtNumber(t.withLink ?? 0)} />
        <KpiTile label={m.anx_type_link()} value={fmtPct(pct(t.typeLink ?? 0, messages))} hint={m.anx_sites_kpi_type_hint()} />
        <KpiTile label={m.anx_sites_kpi_invites()} value={fmtNumber((data.domains ?? []).find((d) => d.domain === 'discord.gg')?.count ?? 0)} />
      </div>
      <div class="section-grid">
        <div class="span-5">
          <SectionCard title={m.anx_sites_families_title()} description={m.anx_sites_families_desc()}>
            <ShareBar segments={familySegments} columns={1} showCounts />
          </SectionCard>
        </div>
        <div class="span-7">
          <SectionCard title={m.anx_sites_title()} description={m.anx_sites_desc()}>
            <BarList items={domainItems} empty={m.anx_sites_empty()} />
          </SectionCard>
        </div>
      </div>
    {:else if view === 'formatting'}
      <div class="kpi-grid kpi-grid--4">
        <KpiTile label={m.anx_content_kpi_markdown()} value={fmtPct(pct(t.withMarkdown ?? 0, messages))} delta={ptsDelta('withMarkdown')} unit="pts" compare={filters.compare} />
        <KpiTile label={m.anx_md_code_block()} value={fmtNumber(t.mdCodeBlock ?? 0)} />
        <KpiTile label={m.anx_md_spoiler()} value={fmtNumber(t.mdSpoiler ?? 0)} />
        <KpiTile label={m.anx_md_masked_link()} value={fmtNumber(t.mdMaskedLink ?? 0)} />
      </div>
      <SectionCard title={m.anx_markdown_title()} description={m.anx_markdown_desc({ share: fmtPct(pct(t.withMarkdown ?? 0, messages)) })}>
        <BarList items={markdownItems} empty={m.anx_markdown_empty()} />
      </SectionCard>
    {/if}
  </div>
{/if}

<style>
  .emoji-glyph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    flex-shrink: 0;
    border-radius: 0.5rem;
    background: var(--color-surface-container);
    font-size: 1.125rem;
    line-height: 1;
  }

  .emoji-glyph img {
    width: 1.5rem;
    height: 1.5rem;
    object-fit: contain;
  }

  .sticker-thumb {
    width: 2.25rem;
    height: 2.25rem;
    flex-shrink: 0;
    object-fit: contain;
    border-radius: 0.375rem;
    background: var(--color-surface-container);
  }

  .origin-tag {
    flex-shrink: 0;
    padding: 0.125rem 0.5rem;
    border-radius: 999px;
    border: 1px solid var(--color-outline-variant);
    font-size: 0.6875rem;
    color: var(--color-on-surface-variant);
    white-space: nowrap;
  }
</style>
