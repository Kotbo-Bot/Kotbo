<script lang="ts">
  import { router } from 'tinro';
  import { fetchMemberReputation, resetReputation, type MemberReputation } from '../../api';
  import { canConfigureFeature, canViewFeature } from '../../permissions.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { m, dateLocale } from '../../i18n';
  import Papicon from '../Papicon.svelte';
  import Skeleton from '../Skeleton.svelte';
  import ReputationAdjustModal from '../ReputationAdjustModal.svelte';
  import { Button, SectionCard } from '../ui';

  interface Props {
    userId: string;
    userName: string;
    /** Ferme la fiche avant d'ouvrir la page Réputation. */
    onLeave?: () => void;
  }

  let { userId, userName, onLeave }: Props = $props();

  let data = $state<MemberReputation | null>(null);
  let loading = $state(false);
  let adjustOpen = $state(false);

  const canView = $derived(canViewFeature('reputation'));
  const canManage = $derived(canConfigureFeature('reputation'));

  /** Seule la réponse du membre affiché a le droit d'écrire : la fiche peut changer de membre en cours de route. */
  async function load(target: string) {
    loading = true;
    try {
      const result = await fetchMemberReputation(target);
      if (target === userId) data = result;
    } finally {
      if (target === userId) loading = false;
    }
  }

  $effect(() => {
    data = null;
    if (canView && userId) void load(userId);
  });

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString(dateLocale(), { dateStyle: 'medium' });
  }

  function openHistory() {
    onLeave?.();
    router.goto(`/reputation?member=${encodeURIComponent(userId)}`);
  }

  async function resetMember() {
    const confirmed = await confirmDialog.ask({
      title: m.rep_reset_member_title(),
      description: m.rep_reset_member_desc({ name: userName }),
      confirmLabel: m.rep_reset_member_confirm(),
      variant: 'danger',
      impacts: [m.rep_reset_impact_tiers(), m.rep_reset_impact_gains_kept()],
    });
    if (!confirmed) return;
    if (await resetReputation({ scope: 'member', userId })) void load(userId);
  }
</script>

<!-- Module éteint ou fermé à ce rôle : l'API ne répond rien, la carte n'existe pas. -->
{#if canView && (loading || data)}
  <SectionCard title={m.rep_member_card_title()}>
    {#snippet actions()}
      {#if data && (data.receivedVotes > 0 || data.givenVotes > 0 || data.recent.length > 0)}
        <Button size="sm" variant="ghost" icon="Clock" onclick={openHistory}>{m.rep_member_card_history()}</Button>
      {/if}
      {#if canManage && data}
        <Button size="sm" variant="ghost" icon="SlidersHorizontal" onclick={() => adjustOpen = true}>{m.rep_staff_adjust_action()}</Button>
        <Button size="sm" variant="ghost" icon="RotateCcw" disabled={data.totalRep === 0 && data.recent.length === 0} onclick={resetMember}>{m.rep_member_card_reset()}</Button>
      {/if}
    {/snippet}

    {#if loading && !data}
      <Skeleton height="96px" />
    {:else if data}
      <dl class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <div>
          <dt class="text-xs text-on-surface-variant flex items-center gap-1"><Papicon icon="Star" size={12} />{m.rep_member_card_points()}</dt>
          <dd class="text-lg font-bold tabular-nums">{data.totalRep}</dd>
        </div>
        <div>
          <dt class="text-xs text-on-surface-variant flex items-center gap-1"><Papicon icon="Crown" size={12} />{m.rep_member_card_rank()}</dt>
          <dd class="text-lg font-bold tabular-nums">{data.totalRep > 0 ? `#${data.rank}` : '-'}</dd>
        </div>
        <div>
          <dt class="text-xs text-on-surface-variant flex items-center gap-1"><Papicon icon="Heart" size={12} />{m.rep_member_card_received()}</dt>
          <dd class="text-lg font-bold tabular-nums">{data.receivedVotes}<span class="ml-1 text-xs font-medium text-on-surface-variant">{m.rep_member_card_week({ count: data.receivedLast7Days })}</span></dd>
        </div>
        <div>
          <dt class="text-xs text-on-surface-variant flex items-center gap-1"><Papicon icon="ArrowRight" size={12} />{m.rep_member_card_given()}</dt>
          <dd class="text-lg font-bold tabular-nums">{data.givenVotes}</dd>
        </div>
      </dl>

      {#if data.recent.length > 0}
        <ul class="mt-4 divide-y divide-outline-variant">
          {#each data.recent as entry (entry.id)}
            <li class="py-2.5 flex items-start justify-between gap-3 text-sm">
              <div class="min-w-0">
                <p class="text-on-surface">
                  {#if entry.kind === 'ADJUSTMENT'}
                    {m.rep_member_card_adjusted({ points: entry.value > 0 ? `+${entry.value}` : `${entry.value}`, name: entry.giverName || entry.giverId })}
                  {:else}
                    {m.rep_member_card_thanked_by({ name: entry.giverName || entry.giverId })}
                  {/if}
                </p>
                {#if entry.reason}
                  <p class="text-xs text-on-surface-variant italic truncate">{entry.reason}</p>
                {/if}
              </div>
              <span class="shrink-0 text-xs text-on-surface-variant">{formatDate(entry.createdAt)}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="mt-4 text-sm text-on-surface-variant">{m.rep_member_card_empty()}</p>
      {/if}
    {/if}
  </SectionCard>

  {#if canManage}
    <ReputationAdjustModal
      bind:open={adjustOpen}
      member={{ id: userId, name: userName }}
      aboveCase
      onDone={() => void load(userId)}
    />
  {/if}
{/if}
