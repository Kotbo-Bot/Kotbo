<!--
  Section « Tags de serveur » : repartition des tags Discord portes par les
  membres, serveurs associes et liste filtrable des porteurs.
-->
<script lang="ts">
  import { Callout, EmptyState, SectionCard } from '../ui';
  import Papicon from '../Papicon.svelte';
  import BarList, { type BarListItem } from './BarList.svelte';
  import ShareBar, { type ShareSegment } from './ShareBar.svelte';
  import KpiTile from './KpiTile.svelte';
  import AnalyticsSkeleton from './AnalyticsSkeleton.svelte';
  import {
    fetchServerTagAnalytics,
    type ServerTagServerSummary,
    type ServerTagsAnalytics,
  } from '../../api';
  import { memberAvatarSrc } from '../../discordMedia';
  import { serverDetailsModal } from '../../stores/serverDetailsModal.svelte';
  import { memberCaseModal } from '../../stores/memberCaseModal.svelte';
  import { canViewFeature } from '../../permissions.svelte';
  import { m } from '../../i18n';
  import { errorMessage } from '@kotbo/shared';
  import { analyticsFilters as filters } from './analyticsFilters.svelte';
  import { fmtNumber, fmtPct, SERIES, SERIES_NEUTRAL } from './analyticsFormat';

  let data = $state<ServerTagsAnalytics | null>(null);
  let loading = $state(true);
  let error = $state('');
  let searchQuery = $state('');
  let selectedServerId = $state('');
  let requestId = 0;

  const canOpenMembers = $derived(canViewFeature('members'));

  $effect(() => {
    const includeBots = filters.includeBots;
    const id = ++requestId;
    loading = true;
    error = '';
    fetchServerTagAnalytics({ includeBots })
      .then((res) => {
        if (id !== requestId) return;
        data = res;
      })
      .catch((e) => {
        if (id === requestId) error = errorMessage(e) || m.an_error_generic();
      })
      .finally(() => {
        if (id === requestId) loading = false;
      });
  });

  const shareSegments: ShareSegment[] = $derived(
    data
      ? [
          { id: 'own', label: m.anx_tags_share_own(), value: data.ownGuildTagged, color: SERIES[0] },
          { id: 'external', label: m.anx_tags_share_external(), value: data.externalTagged, color: SERIES[1] },
          { id: 'none', label: m.anx_tags_share_none(), value: data.untaggedMembers, color: SERIES_NEUTRAL },
        ]
      : [],
  );

  type ServerBarItem = BarListItem & { server: ServerTagServerSummary };
  const serverItems: ServerBarItem[] = $derived(
    (data?.servers ?? []).map((s) => ({
      id: s.guildId,
      label: s.name ?? m.anx_tags_private_server({ id: s.guildId }),
      sub: s.tag ? `${s.tag} · ${s.share}%` : `${s.share}%`,
      value: s.count,
      color: s.isOwnGuild ? SERIES[0] : SERIES[1],
      server: s,
    })),
  );

  const filteredMembers = $derived.by(() => {
    const list = data?.members ?? [];
    const q = searchQuery.trim().toLowerCase();
    return list.filter((item) => {
      if (selectedServerId && item.serverId !== selectedServerId) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q)
        || (item.username?.toLowerCase().includes(q) ?? false)
        || item.tag.toLowerCase().includes(q)
        || (item.serverName?.toLowerCase().includes(q) ?? false)
      );
    });
  });

  function serverInitials(name: string): string {
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
    return name.slice(0, 2).toUpperCase() || 'SV';
  }
</script>

{#if loading && !data}
  <AnalyticsSkeleton />
{:else if error}
  <Callout variant="danger" title={m.an_error_generic()}>{error}</Callout>
{:else if data}
  <div class="flex flex-col gap-4" aria-busy={loading}>
    <div class="kpi-grid kpi-grid--4">
      <KpiTile
        label={m.anx_tags_kpi_tagged()}
        value={fmtNumber(data.taggedMembers)}
        hint={data.totalMembers > 0 ? fmtPct((data.taggedMembers / data.totalMembers) * 100, 1) : undefined}
      />
      <KpiTile
        label={m.anx_tags_kpi_own()}
        value={fmtNumber(data.ownGuildTagged)}
        hint={data.ownGuild.tag ?? undefined}
      />
      <KpiTile label={m.anx_tags_kpi_external()} value={fmtNumber(data.externalTagged)} />
      <KpiTile label={m.anx_tags_kpi_servers()} value={fmtNumber(data.serverCount)} />
    </div>

    <SectionCard title={m.anx_tags_share_title()} description={m.anx_tags_share_desc()}>
      <ShareBar segments={shareSegments} columns={3} showCounts />
    </SectionCard>

    <div class="section-grid">
      <div class="span-6">
        <SectionCard title={m.anx_tags_servers_title()} description={m.anx_tags_servers_desc()}>
          <BarList
            items={serverItems}
            empty={m.anx_tags_servers_empty()}
            onselect={(item) => serverDetailsModal.show(item.id, item.label)}
          >
            {#snippet leading(item)}
              <div class="tag-server-avatar">
                {#if item.server.iconUrl}
                  <img src={item.server.iconUrl} alt="" class="h-full w-full rounded-lg object-cover" loading="lazy" />
                {:else}
                  <span class="text-xs font-semibold text-on-surface-variant">{serverInitials(item.label)}</span>
                {/if}
              </div>
            {/snippet}
            {#snippet trailing(item)}
              {#if item.server.tag}
                <span class="tag-chip">
                  {#if item.server.badgeUrl}
                    <img src={item.server.badgeUrl} alt="" class="h-3.5 w-3.5 object-contain" loading="lazy" />
                  {/if}
                  <span>{item.server.tag}</span>
                </span>
              {/if}
            {/snippet}
          </BarList>
        </SectionCard>
      </div>

      <div class="span-6">
        <SectionCard
          title={m.anx_tags_members_title()}
          description={m.anx_tags_members_desc({ count: fmtNumber(data.taggedMembers) })}
          flush
        >
          <div class="flex flex-col gap-2 border-b border-outline-variant px-5 py-3 sm:flex-row sm:items-center">
            <div class="relative flex-1">
              <span class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-on-surface-variant">
                <Papicon icon="search" size={14} />
              </span>
              <input
                type="search"
                class="input w-full"
                style="padding-left: 2.1rem;"
                placeholder={m.anx_tags_members_search()}
                aria-label={m.anx_tags_members_search()}
                bind:value={searchQuery}
              />
            </div>
            <select
              class="input sm:w-48"
              aria-label={m.anx_tags_members_all_servers()}
              bind:value={selectedServerId}
            >
              <option value="">{m.anx_tags_members_all_servers()}</option>
              {#each data.servers as srv (srv.guildId)}
                <option value={srv.guildId}>
                  {srv.name ?? srv.guildId} ({srv.count})
                </option>
              {/each}
            </select>
          </div>

          {#if filteredMembers.length === 0}
            <div class="p-6">
              <EmptyState icon="tag" title={m.anx_tags_members_empty()} />
            </div>
          {:else}
            <ul class="max-h-[30rem] divide-y divide-outline-variant overflow-y-auto">
              {#each filteredMembers as member (member.userId)}
                <li class="flex items-center justify-between gap-3 px-5 py-2.5 hover:bg-surface-container-low">
                  {#if canOpenMembers}
                    <button
                      type="button"
                      class="flex min-w-0 flex-1 items-center gap-3 text-left"
                      onclick={() => void memberCaseModal.show(member.userId, member.name)}
                    >
                      <img
                        src={memberAvatarSrc(member.avatarUrl, member.name, member.userId)}
                        alt=""
                        class="h-8 w-8 shrink-0 rounded-full object-cover"
                        loading="lazy"
                      />
                      <div class="min-w-0 flex-1">
                        <p class="truncate text-sm font-medium text-on-surface">{member.name}</p>
                        <p class="truncate text-xs text-on-surface-variant">
                          {member.serverName ?? member.serverId}
                        </p>
                      </div>
                    </button>
                  {:else}
                    <div class="flex min-w-0 flex-1 items-center gap-3">
                      <img
                        src={memberAvatarSrc(member.avatarUrl, member.name, member.userId)}
                        alt=""
                        class="h-8 w-8 shrink-0 rounded-full object-cover"
                        loading="lazy"
                      />
                      <div class="min-w-0 flex-1">
                        <p class="truncate text-sm font-medium text-on-surface">{member.name}</p>
                        <p class="truncate text-xs text-on-surface-variant">
                          {member.serverName ?? member.serverId}
                        </p>
                      </div>
                    </div>
                  {/if}

                  <button
                    type="button"
                    class="tag-chip tag-chip--clickable"
                    title={m.mcm_open_server_details()}
                    onclick={() => serverDetailsModal.show(member.serverId, member.serverName)}
                  >
                    {#if member.badgeUrl}
                      <img src={member.badgeUrl} alt="" class="h-3.5 w-3.5 object-contain" loading="lazy" />
                    {/if}
                    <span>{member.tag}</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </SectionCard>
      </div>
    </div>
  </div>
{/if}

<style>
  .tag-server-avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    flex-shrink: 0;
    border-radius: 0.5rem;
    background: var(--color-surface-container);
    border: 1px solid var(--color-outline-variant);
    overflow: hidden;
  }

  .tag-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    flex-shrink: 0;
    padding: 0.15rem 0.5rem;
    border-radius: 0.375rem;
    border: 1px solid var(--color-outline-variant);
    background: var(--color-surface-container);
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-on-surface);
    white-space: nowrap;
  }

  .tag-chip--clickable {
    transition: border-color 140ms ease, background-color 140ms ease;
  }

  .tag-chip--clickable:hover {
    border-color: var(--color-primary);
    background: var(--color-surface-container-high);
  }
</style>
