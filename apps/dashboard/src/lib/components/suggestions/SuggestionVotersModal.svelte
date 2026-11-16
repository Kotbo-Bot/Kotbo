<script lang="ts">
  /**
   * Qui a voté pour et contre une suggestion, pour le staff, quand le serveur
   * a choisi de montrer les votants.
   */
  import { fetchSuggestionVoters, type SuggestionItem, type SuggestionVoter } from '../../api';
  import { m } from '../../i18n';
  import { memberCaseModal } from '../../stores/memberCaseModal.svelte';
  import Modal from '../Modal.svelte';
  import Skeleton from '../Skeleton.svelte';
  import UserDisplay from '../UserDisplay.svelte';

  interface Props {
    open?: boolean;
    suggestion: SuggestionItem | null;
  }

  let { open = $bindable(false), suggestion }: Props = $props();

  let loading = $state(false);
  let voters = $state<{ up: SuggestionVoter[]; down: SuggestionVoter[] } | null>(null);

  $effect(() => {
    if (open && suggestion) void load(suggestion.id);
  });

  async function load(id: string) {
    loading = true;
    voters = null;
    try {
      voters = await fetchSuggestionVoters(id);
    } finally {
      loading = false;
    }
  }

  function opener(name: string | null) {
    return memberCaseModal.canOpen ? (userId: string) => memberCaseModal.show(userId, name || userId) : null;
  }
</script>

{#snippet column(title: string, list: SuggestionVoter[], tone: string)}
  <section class="space-y-2 min-w-0">
    <h4 class="text-sm font-semibold {tone}">{title} · {list.length}</h4>
    {#if list.length === 0}
      <p class="text-xs text-on-surface-variant">{m.suggestions_voters_none()}</p>
    {:else}
      <ul class="space-y-1.5 max-h-72 overflow-y-auto">
        {#each list as voter (voter.userId)}
          <li><UserDisplay userId={voter.userId} name={voter.name} avatarUrl={voter.avatarUrl} size="xs" onClick={opener(voter.name)} /></li>
        {/each}
      </ul>
    {/if}
  </section>
{/snippet}

<Modal bind:open onClose={() => open = false} title={m.suggestions_voters_title()} subtitle={suggestion?.title || suggestion?.username || ''} size="md">
  {#if loading}
    <Skeleton height="160px" />
  {:else if !voters}
    <p class="text-sm text-on-surface-variant">{m.suggestions_voters_error()}</p>
  {:else}
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
      {@render column(m.suggestions_voters_up(), voters.up, 'text-success')}
      {@render column(m.suggestions_voters_down(), voters.down, 'text-error')}
    </div>
  {/if}
</Modal>
