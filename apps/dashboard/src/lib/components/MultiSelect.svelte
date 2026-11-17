<script lang="ts">
  import { m } from '../i18n';
  import Papicon from './Papicon.svelte';
  export let values: string[] = [];
  export let options: Array<{ id: string; name: string }> = [];
  export let placeholder: string = m.d4_search_placeholder();
  export let disabled: boolean = false;
  export let accentClass: string = 'bg-primary/20 text-primary border-primary/40'; // active pill style
  export let id: string = '';
  /** Id de l'aide ou de l'erreur du champ (`describedBy` de Field, RGAA 11.2). */
  export let describedBy: string | undefined = undefined;

  let query = '';
  let open = false;
  let inputEl: HTMLInputElement;
  /** Option mise en avant au clavier (fleches), annoncee via aria-activedescendant. */
  let active = -1;

  // L'id va au champ, pas au cadre : c'est lui que vise le `for` du label
  // de l'appelant (RGAA 11.1). Sans id fourni, un id propre a l'instance.
  const fallbackId = `multiselect-${Math.random().toString(36).slice(2, 10)}`;
  $: inputId = id || fallbackId;

  function normalize(text: string) {
    return (text || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  }

  // Des options en doublon (id fourni deux fois par l'appelant) font planter
  // les {#each ... (opt.id)} avec each_key_duplicate : on déduplique en amont.
  $: uniqueOptions = [...new Map(options.map((o) => [o.id, o])).values()];

  $: filtered = uniqueOptions.filter(
    (o) => !values.includes(o.id) && normalize(o.name).includes(normalize(query))
  );

  $: selectedOptions = uniqueOptions.filter((o) => values.includes(o.id));

  $: if (active >= filtered.length) active = filtered.length - 1;
  $: activeOption = open && !disabled && active >= 0 ? filtered[active] : undefined;

  function toggle(optId: string) {
    if (disabled) return;
    if (values.includes(optId)) {
      values = values.filter((id) => id !== optId);
    } else {
      values = [...values, optId];
    }
    query = '';
    inputEl?.focus();
  }

  function remove(optId: string) {
    if (disabled) return;
    values = values.filter((id) => id !== optId);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Backspace' && !query && values.length > 0) {
      values = values.slice(0, -1);
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      open = true;
      active = Math.min(active + 1, filtered.length - 1);
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(active - 1, 0);
    }
    if (e.key === 'Enter' && activeOption) {
      e.preventDefault();
      toggle(activeOption.id);
    }
    if (e.key === 'Escape') {
      open = false;
      active = -1;
    }
  }
</script>

<div class="relative">
  <!-- Tag input box. Le clic sur le cadre ne fait que donner le focus au champ,
       qui porte le role combobox et toute la gestion du clavier. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="flex flex-wrap gap-1.5 min-h-11 w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 cursor-text transition-all {open ? 'ring-2 ring-primary/30' : ''} focus-within:ring-2 focus-within:ring-primary {disabled ? 'opacity-50 cursor-not-allowed' : ''}"
    onclick={() => { if (!disabled) { open = true; inputEl?.focus(); } }}
  >
    <!-- Selected pills -->
    {#each selectedOptions as opt (opt.id)}
      <span class="inline-flex items-center gap-1 text-2xs font-bold px-2 py-0.5 rounded-lg border {accentClass} transition-all">
        {opt.name}
        {#if !disabled}
          <button
            type="button"
            onclick={(e) => { e.stopPropagation(); remove(opt.id); }}
            class="-my-1 -mr-1.5 inline-flex size-6 items-center justify-center rounded opacity-60 hover:opacity-100 transition-opacity cursor-pointer"
            aria-label={m.d4_remove_item({ name: opt.name })}
          ><Papicon icon="x" size={12} /></button>
        {/if}
      </span>
    {/each}

    <!-- Search input -->
    <input
      bind:this={inputEl}
      id={inputId}
      aria-describedby={describedBy}
      type="text"
      role="combobox"
      aria-expanded={open && !disabled && filtered.length > 0}
      aria-controls={open && !disabled && filtered.length > 0 ? `${inputId}-listbox` : undefined}
      aria-autocomplete="list"
      aria-activedescendant={activeOption ? `${inputId}-opt-${activeOption.id}` : undefined}
      {disabled}
      bind:value={query}
      {placeholder}
      class="flex-1 min-w-[120px] bg-transparent text-sm text-on-surface placeholder:text-on-surface-variant/40 outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed"
      oninput={() => { open = true; }}
      onfocus={() => { open = true; }}
      onblur={() => setTimeout(() => open = false, 180)}
      onkeydown={onKeydown}
      autocomplete="off"
    />
  </div>

  <!-- Dropdown -->
  {#if open && !disabled}
    {#if filtered.length === 0}
      <!-- Hors du listbox, qui ne porte que des options ; annonce a la saisie. -->
      <div role="status" class="absolute left-0 right-0 mt-2 z-30 rounded-lg border border-outline-variant/20 bg-surface-container-high shadow-sm max-h-52 overflow-y-auto px-4 py-3 text-xs text-on-surface-variant italic">
        {query ? m.d4_no_result_for({ query }) : m.d4_all_selected()}
      </div>
    {:else}
      <div
        id="{inputId}-listbox"
        role="listbox"
        class="absolute left-0 right-0 mt-2 z-30 rounded-lg border border-outline-variant/20 bg-surface-container-high shadow-sm max-h-52 overflow-y-auto"
      >
        <div class="p-1.5 space-y-0.5">
          {#each filtered as opt, i (opt.id)}
            <!-- Options hors de l'ordre de tabulation : le clavier reste dans le
                 champ (fleches, Entree), mousedown ne lui retire pas le focus. -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
              id="{inputId}-opt-{opt.id}"
              role="option"
              aria-selected={i === active}
              tabindex="-1"
              onmousedown={(e) => e.preventDefault()}
              onclick={() => toggle(opt.id)}
              class="w-full text-left px-3 py-2 rounded-xl hover:bg-surface-container-low/60 text-sm font-semibold text-on-surface transition-colors flex items-center justify-between gap-2 cursor-pointer {i === active ? 'bg-surface-container-low/60 outline outline-2 outline-primary' : ''}"
            >
              <span>{opt.name}</span>
              <span class="text-2xs text-on-surface-variant font-mono">{opt.id.slice(0, 8)}…</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>
