<!--
  Lecture du réseau de conversation, sous le graphe : groupes de membres qui
  se parlent entre eux, membres « ponts » qui relient plusieurs groupes,
  paires les plus liées, et membres actifs que personne ne relance (ils
  écrivent sans jamais répondre ni recevoir de réponse ou de mention).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { Callout, SectionCard } from '../ui';
  import MetricTabs, { type MetricTab } from './MetricTabs.svelte';
  import AnalyticsSkeleton from './AnalyticsSkeleton.svelte';
  import { fetchConversationNetwork, type ConversationNetwork, type NetworkMember } from '../../api';
  import { memberAvatarSrc } from '../../discordMedia';
  import { m } from '../../i18n';
  import { analyticsExport, analyticsFilters as filters } from './analyticsFilters.svelte';
  import { fmtNumber, fmtPct, SERIES } from './analyticsFormat';

  const { onOpenMember }: { onOpenMember: (userId: string, name: string) => void } = $props();

  let data = $state<ConversationNetwork | null>(null);
  let failed = $state(false);

  $effect(() => {
    const query = filters.query;
    untrack(() => {
      failed = false;
      fetchConversationNetwork(query)
        .then((res) => {
          data = res;
          analyticsExport.network = res;
        })
        .catch(() => (failed = true));
    });
  });

  const tiles: MetricTab[] = $derived.by(() => {
    if (!data) return [];
    const t = data.totals;
    return [
      { id: 'members', label: m.anx_net_members(), value: fmtNumber(t.members), color: SERIES[0], hint: m.anx_net_members_hint() },
      { id: 'links', label: m.anx_net_links(), value: fmtNumber(t.links), color: SERIES[0] },
      { id: 'reciprocity', label: m.anx_net_reciprocity(), value: t.reciprocity === null ? '—' : fmtPct(t.reciprocity), color: SERIES[0], hint: m.anx_net_reciprocity_hint() },
      { id: 'isolated', label: m.anx_net_isolated(), value: fmtNumber(t.isolatedCount), color: SERIES[0], hint: m.anx_net_isolated_hint() },
    ];
  });

  const nameOf = (member: NetworkMember) => member.name ?? m.an_member_fallback();
</script>

{#snippet avatar(member: NetworkMember, size = 24)}
  <img class="net-avatar" src={memberAvatarSrc(member.avatarUrl, member.name, member.userId)} alt="" width={size} height={size} loading="lazy" style="width: {size}px; height: {size}px;" />
{/snippet}

{#if failed}
  <Callout variant="danger">{m.an_error_generic()}</Callout>
{:else if !data}
  <AnalyticsSkeleton />
{:else if data.totals.links === 0}
  <Callout variant="info" title={m.anx_net_empty_title()}>{m.anx_net_empty_desc()}</Callout>
{:else}
  <div class="flex flex-col gap-4">
    <MetricTabs metrics={tiles} active="" onchange={() => {}} label={m.anx_net_title()} interactive={false} />

    <div class="net-grid">
      <SectionCard title={m.anx_net_groups()} description={m.anx_net_groups_desc()}>
        {#if data.groups.length === 0}
          <p class="py-4 text-body-sm text-on-surface-variant">{m.anx_net_groups_empty()}</p>
        {:else}
          <ul class="net-list">
            {#each data.groups as group, i (group.id)}
              <li class="net-group">
                <span class="net-group__title">{m.anx_net_group_n({ n: i + 1 })} · {m.anx_net_group_size({ count: fmtNumber(group.size) })}</span>
                <span class="net-group__leaders">
                  {#each group.leaders as leader (leader.userId)}
                    <button type="button" class="net-chip" onclick={() => onOpenMember(leader.userId, nameOf(leader))}>
                      {@render avatar(leader, 20)}<span class="truncate">{nameOf(leader)}</span>
                    </button>
                  {/each}
                </span>
              </li>
            {/each}
          </ul>
        {/if}
      </SectionCard>

      <SectionCard title={m.anx_net_bridges()} description={m.anx_net_bridges_desc()}>
        {#if data.bridges.length === 0}
          <p class="py-4 text-body-sm text-on-surface-variant">{m.anx_net_bridges_empty()}</p>
        {:else}
          <ul class="net-list">
            {#each data.bridges as bridge (bridge.userId)}
              <li>
                <button type="button" class="net-row" onclick={() => onOpenMember(bridge.userId, nameOf(bridge))}>
                  {@render avatar(bridge)}
                  <span class="net-row__name">{nameOf(bridge)}</span>
                  <span class="net-row__meta">{m.anx_net_bridge_groups({ count: fmtNumber(bridge.groups) })}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </SectionCard>

      <SectionCard title={m.anx_net_pairs()} description={m.anx_net_pairs_desc()}>
        <ul class="net-list">
          {#each data.pairs as pair (pair.a.userId + pair.b.userId)}
            <li class="net-pair">
              <button type="button" class="net-chip" onclick={() => onOpenMember(pair.a.userId, nameOf(pair.a))}>{@render avatar(pair.a, 20)}<span class="truncate">{nameOf(pair.a)}</span></button>
              <span class="text-on-surface-variant" aria-label={pair.reciprocal ? m.anx_net_mutual() : m.anx_net_one_way()} title={pair.reciprocal ? m.anx_net_mutual() : m.anx_net_one_way()}>{pair.reciprocal ? '⇄' : '→'}</span>
              <button type="button" class="net-chip" onclick={() => onOpenMember(pair.b.userId, nameOf(pair.b))}>{@render avatar(pair.b, 20)}<span class="truncate">{nameOf(pair.b)}</span></button>
              <span class="net-pair__count">{m.anx_net_pair_counts({ replies: fmtNumber(pair.replies), mentions: fmtNumber(pair.mentions) })}</span>
            </li>
          {/each}
        </ul>
      </SectionCard>

      <SectionCard title={m.anx_net_isolated_title()} description={m.anx_net_isolated_desc()}>
        {#if data.isolated.length === 0}
          <p class="py-4 text-body-sm text-on-surface-variant">{m.anx_net_isolated_empty()}</p>
        {:else}
          <ul class="net-list">
            {#each data.isolated as member (member.userId)}
              <li>
                <button type="button" class="net-row" onclick={() => onOpenMember(member.userId, nameOf(member))}>
                  {@render avatar(member)}
                  <span class="net-row__name">{nameOf(member)}</span>
                  <span class="net-row__meta">{m.anx_net_messages({ count: fmtNumber(member.messages) })}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </SectionCard>
    </div>
  </div>
{/if}

<style>
  .net-grid {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr));
    align-items: start;
  }

  .net-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    max-height: 22rem;
    overflow-y: auto;
  }

  .net-group {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--color-outline-variant);
  }

  .net-group__title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-on-surface);
  }

  .net-group__leaders {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .net-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    max-width: 11rem;
    padding: 0.125rem 0.5rem 0.125rem 0.125rem;
    border-radius: 999px;
    background: var(--color-surface-container);
    font-size: 0.8125rem;
    color: var(--color-on-surface);
  }

  .net-chip:hover {
    background: var(--color-surface-container-high);
  }

  .net-row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    width: 100%;
    padding: 0.375rem 0.5rem;
    border-radius: 0.5rem;
    text-align: left;
  }

  .net-row:hover {
    background: var(--color-surface-container);
  }

  .net-row__name {
    flex: 1;
    min-width: 0;
    font-size: 0.875rem;
    color: var(--color-on-surface);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .net-row__meta {
    flex-shrink: 0;
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }

  .net-pair {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0;
  }

  .net-pair__count {
    margin-left: auto;
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }

  .net-avatar {
    flex-shrink: 0;
    border-radius: 999px;
    object-fit: cover;
  }
</style>
