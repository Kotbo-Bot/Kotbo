<script lang="ts">
  import { searchGuildMembers, type GuildMemberSearchResult } from '../api';
  import { m } from '../i18n';
  import Papicon from './Papicon.svelte';

  interface Props {
    id?: string;
    value?: string;
    placeholder?: string;
    disabled?: boolean;
    /** Appelé avec le membre choisi, pour qui a besoin de plus que son identifiant. */
    onselect?: (member: GuildMemberSearchResult) => void;
  }

  let {
    id = '',
    value = $bindable(''),
    placeholder = '',
    disabled = false,
    onselect
  }: Props = $props();

  let query = $state('');
  let open = $state(false);
  let loading = $state(false);
  let results = $state<GuildMemberSearchResult[]>([]);
  let highlighted = $state(0);
  let selected = $state<GuildMemberSearchResult | null>(null);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let requestId = 0;

  $effect(() => {
    if (!value && selected) {
      selected = null;
      query = '';
    }
  });

  async function runSearch(q: string) {
    const currentId = ++requestId;
    loading = true;
    try {
      const members = await searchGuildMembers(q, 15);
      if (currentId !== requestId) return;
      results = members;
      highlighted = 0;
    } catch {
      if (currentId === requestId) results = [];
    } finally {
      if (currentId === requestId) loading = false;
    }
  }

  function handleInput() {
    if (disabled) return;
    open = true;
    if (selected) {
      selected = null;
      value = '';
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    const q = query.trim();
    if (!q) {
      results = [];
      loading = false;
      return;
    }
    debounceTimer = setTimeout(() => runSearch(q), 300);
  }

  function select(member: GuildMemberSearchResult) {
    if (disabled) return;
    selected = member;
    value = member.id;
    query = member.displayName || member.username;
    open = false;
    results = [];
    onselect?.(member);
  }

  function clear() {
    if (disabled) return;
    selected = null;
    value = '';
    query = '';
    results = [];
  }

  function handleKeydown(e: KeyboardEvent) {
    if (disabled) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      open = true;
      highlighted = Math.min(highlighted + 1, results.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlighted = Math.max(highlighted - 1, 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && results[highlighted]) select(results[highlighted]);
    } else if (e.key === 'Escape') {
      open = false;
    }
  }
</script>

<div style="position:relative">
  <input
    {id}
    type="text"
    placeholder={placeholder || m.member_search_placeholder()}
    bind:value={query}
    oninput={handleInput}
    onfocus={() => !disabled && (open = true)}
    onblur={() => setTimeout(() => (open = false), 150)}
    onkeydown={handleKeydown}
    class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-medium disabled:opacity-50 disabled:cursor-not-allowed"
    autocomplete="off"
    {disabled}
  />

  {#if query && !disabled}
    <button
      type="button"
      class="absolute right-3 top-1/2 -translate-y-1/2 inline-flex items-center justify-center text-on-surface-variant hover:text-error transition-colors"
      onmousedown={(e) => { e.preventDefault(); clear(); }}
      aria-label={m.member_search_clear()}
    ><Papicon icon="x" size={14} /></button>
  {/if}

  {#if open && !disabled}
    <div class="absolute left-0 right-0 mt-2 z-30 rounded-lg border border-outline-variant/20 bg-surface-container-high text-on-surface p-1.5 shadow-lg max-h-64 overflow-auto">
      {#if loading}
        <div class="px-4 py-3 text-xs text-on-surface-variant flex items-center gap-2">
          <svg class="animate-spin h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
          </svg>
          {m.member_search_loading()}
        </div>
      {:else if query.trim() && results.length === 0}
        <div class="px-4 py-3 text-xs text-on-surface-variant">{m.member_search_no_results()}</div>
      {:else if !query.trim()}
        <div class="px-4 py-3 text-xs text-on-surface-variant">{m.member_search_prompt()}</div>
      {:else}
        {#each results as member, i (member.id)}
          <button
            type="button"
            class="w-full text-left px-3 py-2 rounded-lg hover:bg-surface-container-low transition-colors flex items-center gap-3 {i === highlighted ? 'ring-1 ring-inset ring-primary bg-surface-container-low' : ''}"
            onmousedown={(e) => { e.preventDefault(); select(member); }}
            onmouseenter={() => (highlighted = i)}
          >
            {#if member.avatarUrl}
              <img src={member.avatarUrl} alt={member.displayName} class="w-7 h-7 rounded-full shrink-0 object-cover" />
            {:else}
              <div class="w-7 h-7 rounded-full bg-surface-container-low flex items-center justify-center text-2xs font-bold text-on-surface-variant uppercase shrink-0">
                {(member.displayName || member.username || '?').slice(0, 2)}
              </div>
            {/if}
            <div class="min-w-0 flex-1">
              <div class="text-sm font-semibold truncate">{member.displayName || member.username}</div>
              {#if member.username && member.username !== member.displayName}
                <div class="text-2xs text-on-surface-variant truncate">@{member.username}</div>
              {/if}
            </div>
            {#if !member.isOnServer}
              <span class="text-xs font-semibold px-1.5 py-0.5 rounded bg-surface-container-low text-on-surface-variant shrink-0">{m.member_search_left_badge()}</span>
            {/if}
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</div>
