<script lang="ts">
  import { m } from '../../i18n';
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import { channelDisplayName } from '../../channelUtils';
  import Papicon from '../Papicon.svelte';

  /**
   * Salons écoutés par un déclencheur. Laissé vide, il écoute tout le serveur.
   * Une catégorie couvre ses salons, un salon couvre ses fils : le bot fait la
   * même remontée avant de lancer l'automatisation.
   */
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

  const categories = $derived<Option[]>(
    (dashboardStore.state.discordCategories ?? []).map((c: any) => ({ id: c.id, label: String(c.name).toUpperCase() })),
  );
  const textChannels = $derived<Option[]>(
    (dashboardStore.state.discordChannels ?? []).map((c: any) => ({ id: c.id, label: channelDisplayName(c) })),
  );
  const voiceChannels = $derived<Option[]>(
    (dashboardStore.state.discordVoiceChannels ?? []).map((c: any) => ({ id: c.id, label: channelDisplayName({ ...c, type: 'voice' }) })),
  );

  const labels = $derived(new Map([...categories, ...textChannels, ...voiceChannels].map((o) => [o.id, o.label])));

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
    <p class="text-2xs font-medium text-on-surface-variant/80">{m.wf_channel_filter_label()}</p>
  {/if}

  <div class="flex flex-wrap gap-1.5">
    {#each selected as id (id)}
      <button
        type="button"
        onclick={() => remove(id)}
        aria-label={m.wf_channel_filter_remove({ name: labels.get(id) ?? id })}
        class="group flex items-center gap-1 pl-2 pr-1.5 py-0.5 rounded-md text-2xs bg-primary/10 border border-primary/25 text-on-surface hover:bg-primary/20 transition-colors"
      >
        <span class="truncate max-w-40">{labels.get(id) ?? m.wf_channel_filter_unknown()}</span>
        <Papicon icon="Cross" size={10} class="opacity-50 group-hover:opacity-90" />
      </button>
    {:else}
      <span class="text-2xs text-on-surface-variant">{m.wf_channel_filter_all()}</span>
    {/each}
  </div>

  <select
    value=""
    onchange={(e) => { add(e.currentTarget.value); e.currentTarget.value = ''; }}
    class="w-full px-2 py-1 rounded-lg bg-surface-container-highest border border-outline-variant/20 text-2xs text-on-surface {compact ? 'nodrag' : ''}"
  >
    <option value="">{m.wf_channel_filter_add()}</option>
    {#if categories.length > 0}
      <optgroup label={m.wf_channel_filter_categories()}>
        {#each categories.filter((o) => !selected.includes(o.id)) as option (option.id)}
          <option value={option.id}>{option.label}</option>
        {/each}
      </optgroup>
    {/if}
    {#if textChannels.length > 0}
      <optgroup label={m.wf_channel_filter_text()}>
        {#each textChannels.filter((o) => !selected.includes(o.id)) as option (option.id)}
          <option value={option.id}>{option.label}</option>
        {/each}
      </optgroup>
    {/if}
    {#if voiceChannels.length > 0}
      <optgroup label={m.wf_channel_filter_voice()}>
        {#each voiceChannels.filter((o) => !selected.includes(o.id)) as option (option.id)}
          <option value={option.id}>{option.label}</option>
        {/each}
      </optgroup>
    {/if}
  </select>
</div>
