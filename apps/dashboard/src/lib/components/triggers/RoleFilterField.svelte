<script lang="ts">
  import { m } from '../../i18n';
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import Papicon from '../Papicon.svelte';

  /** Rôles écoutés par un déclencheur. Laissé vide, il écoute tous les rôles. */
  const {
    value,
    onChange,
    compact = false,
  }: {
    value: unknown;
    onChange: (ids: string[]) => void;
    compact?: boolean;
  } = $props();

  type Option = { id: string; label: string };

  const selected = $derived(
    Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id !== '') : [],
  );

  const roles = $derived<Option[]>(
    (dashboardStore.state.discordRoles ?? []).map((r: any) => ({ id: r.id, label: `@${r.name}` })),
  );

  const labels = $derived(new Map(roles.map((o) => [o.id, o.label])));

  function add(id: string): void {
    if (!id || selected.includes(id)) return;
    onChange([...selected, id]);
  }

  function remove(id: string): void {
    onChange(selected.filter((entry) => entry !== id));
  }
</script>

<div class="space-y-1.5 {compact ? 'nodrag' : ''}">
  {#if !compact}
    <p class="text-2xs font-medium text-on-surface-variant/80">{m.wf_role_filter_label()}</p>
  {/if}

  <div class="flex flex-wrap gap-1.5">
    {#each selected as id (id)}
      <button
        type="button"
        onclick={() => remove(id)}
        aria-label={m.wf_role_filter_remove({ name: labels.get(id) ?? id })}
        class="group flex items-center gap-1 pl-2 pr-1.5 py-0.5 rounded-md text-2xs bg-primary/10 border border-primary/25 text-on-surface hover:bg-primary/20 transition-colors"
      >
        <span class="truncate max-w-40">{labels.get(id) ?? m.wf_role_filter_unknown()}</span>
        <Papicon icon="Cross" size={10} class="opacity-50 group-hover:opacity-90" />
      </button>
    {:else}
      <span class="text-2xs text-on-surface-variant">{m.wf_role_filter_all()}</span>
    {/each}
  </div>

  <select
    value=""
    onchange={(e) => { add(e.currentTarget.value); e.currentTarget.value = ''; }}
    class="w-full px-2 py-1 rounded-lg bg-surface-container-highest border border-outline-variant/20 text-2xs text-on-surface {compact ? 'nodrag' : ''}"
  >
    <option value="">{m.wf_role_filter_add()}</option>
    {#each roles.filter((o) => !selected.includes(o.id)) as option (option.id)}
      <option value={option.id}>{option.label}</option>
    {/each}
  </select>
</div>
