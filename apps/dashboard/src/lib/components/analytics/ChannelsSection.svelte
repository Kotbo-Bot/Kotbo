<!--
  Salons et catégories : chaque catégorie avec ses salons, texte et vocal sur
  la même ligne. Un clic sur une catégorie ouvre sa vue détaillée, un clic sur
  un salon ouvre la fiche salon commune au dashboard.
-->
<script lang="ts">
  import Papicon from '../Papicon.svelte';
  import { Button, Callout, FilterPills, SectionCard } from '../ui';
  import AnalyticsSkeleton from './AnalyticsSkeleton.svelte';
  import CategoryModal from './CategoryModal.svelte';
  import { fetchChannelTree, type ChannelTree, type ChannelTreeCategory, type ChannelTreeChannel } from '../../api';
  import { channelDetailsModal } from '../../stores/channelDetailsModal.svelte';
  import { m } from '../../i18n';
  import { errorMessage } from '@kotbo/shared';
  import { analyticsExport, analyticsFilters as filters, pct, relativeDelta } from './analyticsFilters.svelte';
  import { daysSince, fmtDelta, fmtMinutes, fmtNumber, fmtPct } from './analyticsFormat';

  const { onOpenMember }: { onOpenMember: (userId: string, name: string) => void } = $props();

  let tree = $state<ChannelTree | null>(null);
  let loading = $state(true);
  let error = $state('');
  let requestId = 0;

  $effect(() => {
    const query = filters.query;
    const id = ++requestId;
    loading = true;
    error = '';
    fetchChannelTree(query)
      .then((res) => {
        if (id !== requestId) return;
        tree = res;
        analyticsExport.channels = res;
      })
      .catch((e) => {
        if (id === requestId) error = errorMessage(e) || m.an_error_generic();
      })
      .finally(() => {
        if (id === requestId) loading = false;
      });
  });

  let sort = $state<'discord' | 'activity'>('discord');
  let collapsed = $state<Record<string, boolean>>({});
  let openCategory = $state<{ id: string; name: string } | null>(null);

  const catKey = (c: ChannelTreeCategory) => c.id ?? 'none';
  const activity = (x: { messages: number; voiceMinutes: number }) => x.messages + x.voiceMinutes / 10;

  const categories = $derived.by(() => {
    const list = (tree?.categories ?? []).map((cat) => ({
      ...cat,
      channels: sort === 'activity' ? [...cat.channels].sort((a, b) => activity(b) - activity(a)) : cat.channels,
    }));
    return sort === 'activity' ? list.sort((a, b) => activity(b) - activity(a)) : list;
  });

  const allCollapsed = $derived(categories.length > 0 && categories.every((c) => collapsed[catKey(c)]));

  function toggleAll() {
    const next = !allCollapsed;
    collapsed = Object.fromEntries(categories.map((c) => [catKey(c), next]));
  }

  const totals = $derived(tree?.totals ?? { messages: 0, voiceMinutes: 0 });

  /** Part du serveur : messages pour l'écrit, temps pour le vocal. */
  function share(row: { messages: number; voiceMinutes: number }, voice = false): string {
    if (voice) return totals.voiceMinutes > 0 ? fmtPct(pct(row.voiceMinutes, totals.voiceMinutes)) : '—';
    return totals.messages > 0 ? fmtPct(pct(row.messages, totals.messages)) : '—';
  }

  function trend(now: number, before: number): { text: string; cls: string } {
    const delta = relativeDelta(now, before);
    const cls = delta === null || Math.abs(delta) < 0.05 ? 'text-on-surface-variant' : delta > 0 ? 'text-success' : 'text-error';
    return { text: fmtDelta(delta, 'pct'), cls };
  }

  function rowTrend(row: ChannelTreeCategory | ChannelTreeChannel, voice = false) {
    return voice ? trend(row.voiceMinutes, row.prevVoiceMinutes) : trend(row.messages, row.prevMessages);
  }

  function quietLabel(channel: ChannelTreeChannel): string | null {
    if (channel.kind === 'voice') return null;
    const days = daysSince(channel.lastActiveDate);
    if (days === null) return m.anx_channel_never_active();
    return days >= 7 ? m.anx_channel_quiet({ days: String(days) }) : null;
  }

  const KIND_ICON: Record<string, string> = { voice: 'Microphone', forum: 'message-square' };
</script>

{#if loading && !tree}
  <AnalyticsSkeleton />
{:else if error}
  <Callout variant="danger" title={m.an_error_generic()}>{error}</Callout>
{:else if tree}
  <div class="flex flex-col gap-4" aria-busy={loading}>
    <SectionCard title={m.anx_channels_title()} description={m.anx_channels_desc()} flush>
      {#snippet actions()}
        <FilterPills
          label={m.anx_channels_sort_label()}
          options={[{ value: 'discord', label: m.anx_channels_sort_discord() }, { value: 'activity', label: m.anx_channels_sort_activity() }]}
          value={sort}
          onchange={(v) => (sort = v as typeof sort)}
        />
        <Button size="sm" variant="ghost" icon={allCollapsed ? 'ChevronsDown' : 'ChevronsUp'} onclick={toggleAll}>
          {allCollapsed ? m.anx_channels_expand_all() : m.anx_channels_collapse_all()}
        </Button>
      {/snippet}
      <div class="overflow-x-auto">
        <table class="tree-table">
          <thead>
            <tr>
              <th scope="col">{m.anx_col_channel()}</th>
              <th scope="col">{m.anx_col_messages()}</th>
              <th scope="col">{m.anx_col_voice()}</th>
              <th scope="col" title={m.anx_col_authors_hint()}>{m.anx_col_authors()}</th>
              <th scope="col">{m.anx_col_share()}</th>
              {#if filters.compare}<th scope="col">{m.anx_col_trend()}</th>{/if}
            </tr>
          </thead>
          <tbody>
            {#each categories as cat (catKey(cat))}
              {@const open = !collapsed[catKey(cat)]}
              {@const catTrend = rowTrend(cat)}
              <tr class="tree-table__category">
                <th scope="row">
                  <span class="flex items-center gap-1">
                    <button
                      type="button"
                      class="tree-toggle"
                      aria-expanded={open}
                      aria-label={open ? m.anx_channels_collapse({ name: cat.name ?? m.anx_channels_no_category() }) : m.anx_channels_expand({ name: cat.name ?? m.anx_channels_no_category() })}
                      onclick={() => (collapsed = { ...collapsed, [catKey(cat)]: open })}
                    >
                      <Papicon icon={open ? 'chevron-down' : 'chevron-right'} size={14} />
                    </button>
                    {#if cat.id}
                      <button type="button" class="tree-link font-semibold" onclick={() => (openCategory = { id: cat.id!, name: cat.name ?? '' })}>
                        {cat.name}
                      </button>
                    {:else}
                      <span class="font-semibold text-on-surface">{m.anx_channels_no_category()}</span>
                    {/if}
                  </span>
                </th>
                <td>{fmtNumber(cat.messages)}</td>
                <td>{cat.voiceMinutes > 0 ? fmtMinutes(cat.voiceMinutes) : '—'}</td>
                <td>{fmtNumber(cat.authors)}</td>
                <td>{share(cat)}</td>
                {#if filters.compare}<td class={catTrend.cls}>{catTrend.text}</td>{/if}
              </tr>
              {#if open}
                {#each cat.channels as channel (channel.id)}
                  {@const voice = channel.kind === 'voice'}
                  {@const chTrend = rowTrend(channel, voice)}
                  {@const quiet = quietLabel(channel)}
                  <tr>
                    <th scope="row">
                      <span class="flex items-center gap-2 pl-8">
                        {#if KIND_ICON[channel.kind]}
                          <Papicon icon={KIND_ICON[channel.kind]} size={14} class="text-on-surface-variant shrink-0" />
                        {:else}
                          <span class="w-3.5 shrink-0 text-center text-on-surface-variant" aria-hidden="true">#</span>
                        {/if}
                        <button type="button" class="tree-link" onclick={() => channelDetailsModal.show(channel.id, channel.name)}>
                          {channel.name}
                        </button>
                        {#if quiet}<span class="quiet-tag">{quiet}</span>{/if}
                      </span>
                    </th>
                    <td>{voice ? '—' : fmtNumber(channel.messages)}</td>
                    <td>{channel.voiceMinutes > 0 ? fmtMinutes(channel.voiceMinutes) : '—'}</td>
                    <td>{voice ? '—' : fmtNumber(channel.authors)}</td>
                    <td>{share(channel, voice)}</td>
                    {#if filters.compare}<td class={chTrend.cls}>{chTrend.text}</td>{/if}
                  </tr>
                {/each}
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
      {#if tree.orphan}
        <p class="px-5 py-3 text-2xs text-on-surface-variant border-t border-outline-variant">
          {m.anx_channels_orphan({ count: fmtNumber(tree.orphan.messages) })}
        </p>
      {/if}
    </SectionCard>

  </div>
{/if}

{#if openCategory}
  <CategoryModal
    categoryId={openCategory.id}
    categoryName={openCategory.name}
    {onOpenMember}
    onClose={() => (openCategory = null)}
  />
{/if}

<style>
  .tree-table {
    width: 100%;
    min-width: 40rem;
    border-collapse: collapse;
    font-size: 0.875rem;
  }

  .tree-table th,
  .tree-table td {
    padding: 0.625rem 1rem;
    text-align: right;
    font-variant-numeric: tabular-nums;
    border-bottom: 1px solid var(--color-outline-variant);
    color: var(--color-on-surface);
    white-space: nowrap;
  }

  .tree-table thead th {
    font-weight: 500;
    font-size: 0.8125rem;
    color: var(--color-on-surface-variant);
  }

  .tree-table th:first-child {
    text-align: left;
    font-weight: 400;
  }

  .tree-table thead th:first-child {
    font-weight: 500;
  }

  .tree-table__category th,
  .tree-table__category td {
    background: var(--color-surface-container-low);
    font-weight: 600;
  }

  .tree-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 0.375rem;
    color: var(--color-on-surface-variant);
  }

  .tree-toggle:hover {
    background: var(--color-surface-container-high);
    color: var(--color-on-surface);
  }

  .tree-link {
    color: var(--color-on-surface);
    text-align: left;
    border-radius: 0.25rem;
  }

  .tree-link:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }

  .tree-toggle:focus-visible,
  .tree-link:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  .quiet-tag {
    padding: 0.0625rem 0.5rem;
    border-radius: 999px;
    border: 1px solid var(--color-outline-variant);
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--color-warning);
  }
</style>
