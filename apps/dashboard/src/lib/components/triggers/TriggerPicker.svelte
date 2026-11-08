<script lang="ts">
  import { m } from '../../i18n';
  import Papicon from '../Papicon.svelte';
  import { matchesQuery } from '../../workflowSearch';
  import { TRIGGER_GROUP_LABELS, type TriggerGroup } from '@kotbo/shared';
  import { OFFERED_TRIGGERS } from '../../workflowAvailability';

  /**
   * Choix du déclencheur - la toute première question posée.
   *
   * Chaque carte porte la phrase complète et un exemple concret : le but est
   * qu'on reconnaisse son besoin dans un exemple plutôt que d'avoir à traduire
   * une intention en vocabulaire technique.
   */
  const {
    selected = '',
    onPick,
  }: {
    selected?: string;
    onPick: (type: string) => void;
  } = $props();

  let search = $state('');

  const triggers = $derived(
    OFFERED_TRIGGERS.filter((trigger) => (
      matchesQuery(search, [trigger.sentence, trigger.short, trigger.example, TRIGGER_GROUP_LABELS[trigger.group]])
    )),
  );

  const groups = $derived([...new Set(triggers.map((trigger) => trigger.group))] as TriggerGroup[]);
</script>

<div class="space-y-5">
  <input
    type="search"
    bind:value={search}
    placeholder={m.wf_search_trigger()}
    aria-label={m.wf_search_trigger()}
    class="w-full px-3 py-2 rounded-xl bg-surface-container-highest border border-outline-variant/20 text-sm text-on-surface focus:outline-none focus:border-primary/50"
  />

  {#if triggers.length === 0}
    <p class="px-4 py-6 rounded-2xl bg-surface-container-high/30 text-center text-xs text-on-surface-variant">
      {m.wf_no_result()} · {m.wf_try_other()}
    </p>
  {/if}

  {#each groups as group (group)}
    <section class="space-y-2">
      <h4 class="text-xs font-semibold text-on-surface-variant">
        {TRIGGER_GROUP_LABELS[group]}
      </h4>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
        {#each triggers.filter((trigger) => trigger.group === group) as trigger (trigger.type)}
          <button
            type="button"
            onclick={() => onPick(trigger.type)}
            class="flex items-start gap-3 p-3.5 rounded-2xl text-left border transition-all {selected === trigger.type
              ? 'bg-primary/10 border-primary/50'
              : 'bg-surface-container-high/50 border-outline-variant/15 hover:border-primary/30 hover:bg-surface-container-high'}"
          >
            <span class="p-2 rounded-xl bg-primary/10 text-primary shrink-0">
              <Papicon icon={trigger.icon} size={15} />
            </span>
            <span class="min-w-0 space-y-0.5">
              <span class="block text-xs font-semibold text-on-surface">{trigger.sentence}</span>
              <span class="block text-2xs text-on-surface-variant leading-snug">{trigger.example}</span>
            </span>
          </button>
        {/each}
      </div>
    </section>
  {/each}
</div>
