<!--
  Adaptateur Kotbo autour de TopList (@kotbo/ui/analytics) :
  gère le chargement API (top N + complet 500), l'avatar/nom Discord et l'export XLSX.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { TopList as KotboTopList, type TopListItem } from '@kotbo/ui/analytics';
  import { memberAvatarSrc } from '../../discordMedia';
  import UserDisplay from '../UserDisplay.svelte';
  import { downloadSingleSheetXlsx } from '../../xlsxExport';
  import { toast } from '../../stores/toast.svelte';
  import { m } from '../../i18n';
  import { errorMessage } from '@kotbo/shared';
  import type { ActivityRankingItem, ActivityRankings } from '../../api';
  import { fmtNumber } from './analyticsFormat';

  interface AdaptedTopItem extends TopListItem {
    raw: ActivityRankingItem;
  }

  const {
    title,
    description = '',
    icon = '',
    kind,
    load,
    reloadKey,
    format = fmtNumber,
    compare = false,
    color = 'var(--series-1)',
    onselect,
    exportName = 'classement',
    limit = 8,
    bare = false,
  }: {
    title: string;
    description?: string;
    icon?: string;
    kind: 'members' | 'channels';
    load: (limit: number) => Promise<ActivityRankings | null>;
    reloadKey: string;
    format?: (value: number) => string;
    compare?: boolean;
    color?: string;
    onselect?: (item: ActivityRankingItem) => void;
    exportName?: string;
    limit?: number;
    bare?: boolean;
  } = $props();

  const FULL = 500;

  let data = $state<ActivityRankings | null>(null);
  let loading = $state(true);
  let error = $state('');
  let requestKey = '';
  let fullCache: { key: string; items: AdaptedTopItem[] } | null = null;

  $effect(() => {
    const key = reloadKey;
    untrack(() => {
      requestKey = key;
      loading = true;
      error = '';
      fullCache = null;
      load(limit)
        .then((res) => {
          if (requestKey === key) data = res;
        })
        .catch((e) => {
          if (requestKey === key) error = errorMessage(e) || m.an_error_generic();
        })
        .finally(() => {
          if (requestKey === key) loading = false;
        });
    });
  });

  function displayName(item: ActivityRankingItem): string {
    if (kind === 'channels') return item.name ? `#${item.name}` : m.anx_channel_deleted();
    return item.name ?? m.an_member_fallback();
  }

  function mapItems(items: ActivityRankingItem[]): AdaptedTopItem[] {
    return items.map((item) => ({
      id: item.id,
      name: displayName(item),
      value: item.value,
      previous: item.previous,
      share: item.share,
      spark: item.spark,
      avatarUrl: item.avatarUrl,
      raw: item,
    }));
  }

  const mappedItems = $derived(mapItems(data?.items ?? []));

  async function handleLoadFull(): Promise<AdaptedTopItem[] | null> {
    if (fullCache && fullCache.key === reloadKey) return fullCache.items;
    const key = reloadKey;
    try {
      const res = await load(FULL);
      const items = mapItems(res?.items ?? []);
      if (key === reloadKey) fullCache = { key, items };
      return items;
    } catch (e) {
      toast.error(errorMessage(e) || m.an_error_generic());
      return null;
    }
  }

  async function handleExport(items: AdaptedTopItem[]) {
    const rows = items.map((entry, i) => ({
      [m.anx_top_rank()]: i + 1,
      [m.anx_top_name()]: displayName(entry.raw),
      id: entry.raw.id,
      [m.anx_top_value()]: entry.raw.value,
      [m.anx_table_previous()]: entry.raw.previous,
      [m.anx_top_share()]: entry.raw.share,
    }));
    const ok = await downloadSingleSheetXlsx(
      `${exportName}_${new Date().toISOString().slice(0, 10)}.xlsx`,
      exportName.slice(0, 31),
      rows,
    );
    if (ok) toast.success(m.an_export_xlsx_done());
    else toast.error(m.an_export_no_data());
  }
</script>

<KotboTopList
  {title}
  {description}
  {icon}
  entityLabel={kind === 'members' ? m.anx_top_member() : m.anx_top_channel()}
  items={mappedItems}
  total={data?.total ?? 0}
  prevTotal={data?.prevTotal ?? 0}
  available={data ? data.available : true}
  {loading}
  {error}
  {format}
  {compare}
  {color}
  {bare}
  onselect={onselect ? (entry) => onselect(entry.raw) : undefined}
  onLoadFull={handleLoadFull}
  onExport={handleExport}
>
  {#snippet renderIdentity(entry)}
    {#if kind === 'members'}
      <img
        class="h-6 w-6 shrink-0 rounded-full object-cover"
        src={memberAvatarSrc(entry.raw.avatarUrl, entry.raw.name, entry.raw.id)}
        alt=""
        loading="lazy"
        width="24"
        height="24"
      />
    {:else}
      <span class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-surface-container text-xs font-semibold text-on-surface-variant" aria-hidden="true">#</span>
    {/if}
  {/snippet}

  {#snippet renderRowName(entry)}
    {#if kind === 'members'}
      <img
        class="h-6 w-6 shrink-0 rounded-full object-cover"
        src={memberAvatarSrc(entry.raw.avatarUrl, entry.raw.name, entry.raw.id)}
        alt=""
        loading="lazy"
        width="24"
        height="24"
      />
      <UserDisplay
        userId={entry.raw.id}
        name={entry.raw.name}
        avatarUrl={entry.raw.avatarUrl}
        size="sm"
        class="min-w-0"
        onClick={onselect ? () => onselect(entry.raw) : undefined}
      />
    {:else}
      <span class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-surface-container text-xs font-semibold text-on-surface-variant" aria-hidden="true">#</span>
      {#if onselect}
        <button type="button" class="truncate text-left font-medium text-on-surface hover:underline" onclick={() => onselect(entry.raw)}>
          {displayName(entry.raw)}
        </button>
      {:else}
        <span class="truncate font-medium text-on-surface">{displayName(entry.raw)}</span>
      {/if}
    {/if}
  {/snippet}
</KotboTopList>
