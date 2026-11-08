<script lang="ts">
  import { m } from '../../i18n';
  import Papicon from '../Papicon.svelte';
  import DiscordMessage from './DiscordMessage.svelte';
  import { getNodeDef, type WorkflowGraph } from '@kotbo/shared';
  import type { WorkflowExecutionStep } from '../../api/workflows';
  import { messagePreviewOf, permissionHint, portLabel, readValue, roleChangeOf } from '../../workflowReplay';

  /**
   * Panneau du rejeu : les étapes parcourues, puis l'étape courante lue en
   * clair - ce qu'elle a fait sur Discord (ou aurait fait, pour un essai), ses
   * valeurs, et quoi faire quand elle a échoué.
   */
  const {
    steps,
    index,
    graph,
    isTest,
    canFix,
    onSeek,
    onFix,
  }: {
    steps: Array<Pick<WorkflowExecutionStep, 'nodeId' | 'nodeType' | 'status' | 'inputs' | 'outputs' | 'error' | 'durationMs'>>;
    index: number;
    graph: WorkflowGraph;
    isTest: boolean;
    canFix: boolean;
    onSeek: (index: number) => void;
    onFix: (nodeId: string) => void;
  } = $props();

  const step = $derived(steps[index]);
  const inputs = $derived(step?.inputs ?? {});
  const config = $derived(graph.nodes.find((node) => node.id === step?.nodeId)?.config ?? {});
  const message = $derived(step ? messagePreviewOf(step.nodeType, inputs, config) : null);
  const roleChange = $derived(step ? roleChangeOf(step.nodeType, inputs) : null);
  const hint = $derived(permissionHint(step?.error));

  const STATUS = {
    OK: { label: () => m.wf_replay_status_ok(), color: 'bg-success/15 text-success', dot: 'bg-success' },
    ERROR: { label: () => m.wf_replay_status_error(), color: 'bg-error/15 text-error', dot: 'bg-error' },
    SKIPPED: {
      label: () => m.wf_replay_status_skipped(),
      color: 'bg-surface-container-highest text-on-surface-variant',
      dot: 'bg-outline-variant',
    },
  } as const;

  function nodeLabel(nodeType: string): string {
    return getNodeDef(nodeType)?.label ?? nodeType;
  }

  /** Au-delà, un texte se replie : le panneau reste lisible d'un coup d'œil. */
  const LONG_TEXT = 120;
  let expanded = $state<Record<string, boolean>>({});

  // Une autre étape repart repliée.
  $effect(() => {
    void index;
    expanded = {};
  });

  const sections = $derived(
    step
      ? ([
        { side: 'inputs', title: m.wf_replay_inputs(), values: step.inputs ?? {} },
        { side: 'outputs', title: m.wf_replay_outputs(), values: step.outputs ?? {} },
      ] as const).filter((section) => Object.keys(section.values).length > 0)
      : [],
  );
</script>

<aside class="w-full lg:w-80 shrink-0 space-y-3">
  <!-- Étapes parcourues -->
  <nav class="p-3 rounded-2xl bg-surface-container-high/50 border border-outline-variant/10 space-y-1" aria-label={m.wf_replay_steps()}>
    <h3 class="text-xs font-semibold text-on-surface-variant pb-1">{m.wf_replay_steps()}</h3>
    <ol class="max-h-56 overflow-y-auto space-y-0.5">
      {#each steps as entry, position (position)}
        <li>
          <button
            type="button"
            onclick={() => onSeek(position)}
            aria-current={position === index ? 'step' : undefined}
            class="w-full flex items-center gap-2 px-2 py-1 rounded-lg text-left text-2xs transition-colors {position === index
              ? 'bg-primary/10 text-on-surface font-semibold'
              : 'text-on-surface-variant hover:bg-surface-container-highest/60'}"
          >
            <span class="tabular-nums w-4 text-right opacity-60">{position + 1}</span>
            <span class="w-1.5 h-1.5 rounded-full shrink-0 {STATUS[entry.status].dot}"></span>
            <span class="truncate">{nodeLabel(entry.nodeType)}</span>
          </button>
        </li>
      {/each}
    </ol>
  </nav>

  {#if step}
    <!-- Étape courante -->
    <div class="p-3 rounded-2xl bg-surface-container-high/50 border border-outline-variant/10 space-y-2">
      <div class="flex items-center justify-between gap-2">
        <span class="text-sm font-bold text-on-surface truncate">{nodeLabel(step.nodeType)}</span>
        <span class="px-2 py-0.5 rounded-full text-2xs font-bold shrink-0 {STATUS[step.status].color}">
          {STATUS[step.status].label()}
        </span>
      </div>
      <p class="text-2xs text-on-surface-variant">{m.wf_replay_duration({ n: step.durationMs })}</p>

      {#if step.error}
        <div class="space-y-2 px-2.5 py-2 rounded-lg bg-error/10 border border-error/20">
          <p class="text-2xs text-error break-words">{step.error}</p>
          {#if hint}
            <p class="text-2xs text-on-surface">
              {hint.channel === null
                ? m.wf_replay_permission_hint_server({ permissions: hint.permissions.join(', ') })
                : m.wf_replay_permission_hint_channel({ permissions: hint.permissions.join(', '), channel: hint.channel })}
            </p>
          {/if}
          {#if canFix}
            <button
              type="button"
              onclick={() => onFix(step.nodeId)}
              class="inline-flex items-center gap-1.5 text-2xs font-semibold text-error hover:underline"
            >
              <Papicon icon="Pen" size={11} />
              {m.wf_replay_fix_step()}
            </button>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Ce que l'étape a fait sur Discord -->
    {#if step.status !== 'SKIPPED' && (message || roleChange)}
      <div class="p-3 rounded-2xl bg-surface-container-high/50 border border-outline-variant/10 space-y-2">
        <h3 class="text-xs font-semibold text-on-surface-variant">
          {isTest ? m.wf_replay_effect_test() : m.wf_replay_effect()}
        </h3>
        {#if message}
          <DiscordMessage {message} />
        {:else if roleChange}
          <p class="text-xs text-on-surface leading-relaxed">
            {#if roleChange.added}
              {isTest
                ? m.wf_replay_role_added_test({ member: roleChange.member, role: roleChange.role })
                : m.wf_replay_role_added({ member: roleChange.member, role: roleChange.role })}
            {:else}
              {isTest
                ? m.wf_replay_role_removed_test({ member: roleChange.member, role: roleChange.role })
                : m.wf_replay_role_removed({ member: roleChange.member, role: roleChange.role })}
            {/if}
          </p>
        {/if}
      </div>
    {/if}

    <!-- Valeurs consignées : une section vide n'apprend rien, elle est tue -->
    {#each sections as section (section.side)}
      <div class="p-3 rounded-2xl bg-surface-container-high/50 border border-outline-variant/10 space-y-2">
        <h3 class="text-xs font-semibold text-on-surface-variant">{section.title}</h3>
        <dl class="space-y-2">
          {#each Object.entries(section.values) as [key, value] (key)}
            {@const read = readValue(value)}
            {@const id = `${section.side}:${key}`}
            {@const long = read.text.length > LONG_TEXT}
            <div class="space-y-0.5 text-2xs">
              <dt class="font-semibold text-on-surface-variant">{portLabel(step.nodeType, key, section.side)}</dt>
              <dd class="text-on-surface">
                {#if read.kind === 'mention'}
                  <span class="inline-block px-1.5 py-0.5 rounded-md bg-primary/10 text-primary font-medium break-all">{read.text}</span>
                {:else if read.kind === 'empty'}
                  <span class="text-on-surface-variant">{read.text}</span>
                {:else}
                  <span class="block whitespace-pre-wrap break-words {long && !expanded[id] ? 'line-clamp-3' : ''}">{read.text}</span>
                  {#if long}
                    <button
                      type="button"
                      onclick={() => (expanded = { ...expanded, [id]: !expanded[id] })}
                      class="block mt-0.5 font-semibold text-primary hover:underline"
                    >{expanded[id] ? m.wf_replay_show_less() : m.wf_replay_show_more()}</button>
                  {/if}
                {/if}
              </dd>
            </div>
          {/each}
        </dl>
      </div>
    {/each}
  {/if}
</aside>
