<script lang="ts">
  import { m } from '../i18n';
  import { dashboardFetch } from '../api';
  import { authStore } from '../stores/auth.svelte';
  import Papicon from './Papicon.svelte';

  type DiscordMemberSuggestion = {
    id: string;
    username: string;
    displayName: string | null;
    userTag: string | null;
    avatarUrl: string | null;
    roleIds?: string[];
  };

  let {
    guildId,
    query = $bindable(''),
    selectedId = $bindable(''),
    selectedUsername = $bindable(''),
    selectedAvatarUrl = $bindable(''),
    selectedRoleIds = $bindable<string[]>([]),
    placeholder = m.dml_placeholder(),
    autoSelectOnExactMatch = true,
    disabled = false,
    staffOnly = false,
    className = '',
  }: {
    guildId: string | null;
    query?: string;
    selectedId?: string;
    selectedUsername?: string;
    selectedAvatarUrl?: string;
    selectedRoleIds?: string[];
    placeholder?: string;
    selectedIdPlaceholder?: string;
    autoSelectOnExactMatch?: boolean;
    disabled?: boolean;
    staffOnly?: boolean;
    className?: string;
  } = $props();

  let suggestions = $state<DiscordMemberSuggestion[]>([]);
  let isLoading = $state(false);
  let error = $state('');
  let debounceTimer = $state<ReturnType<typeof setTimeout> | null>(null);
  let abortController = $state<AbortController | null>(null);

  function extractDiscordUserId(value: string | null | undefined): string | null {
    const text = (value ?? '').trim();
    if (!text) return null;

    const mentionMatch = text.match(/<@!?(\d{15,25})>/);
    if (mentionMatch?.[1]) return mentionMatch[1];

    if (/^\d{15,25}$/.test(text)) {
      return text;
    }

    return null;
  }

  function resetSuggestions(): void {
    suggestions = [];
    error = '';
    isLoading = false;
  }

  function syncExactMatch(value: string): void {
    if (!autoSelectOnExactMatch) return;

    const extractedUserId = extractDiscordUserId(value);
    if (extractedUserId) {
      selectedId = extractedUserId;
      return;
    }

    if (!value.trim()) return;

    const match = suggestions.find((member) => {
      const normalizedValue = value.trim().toLowerCase();
      return member.id === normalizedValue
        || member.username.toLowerCase() === normalizedValue
        || (member.displayName ?? '').toLowerCase() === normalizedValue
        || (member.userTag ?? '').toLowerCase() === normalizedValue;
    });

    if (match) {
      selectedId = match.id;
      selectedUsername = match.username;
      selectedAvatarUrl = match.avatarUrl ?? '';
      selectedRoleIds = match.roleIds ?? [];
    }
  }

  async function fetchSuggestions(value: string): Promise<void> {
    if (!guildId || !authStore.token || disabled) return;

    const trimmed = value.trim();
    if (!trimmed) {
      resetSuggestions();
      selectedId = '';
      selectedUsername = '';
      selectedRoleIds = [];
      return;
    }

    abortController?.abort();
    abortController = new AbortController();
    isLoading = true;
    error = '';

    try {
      const searchParams = new URLSearchParams({ 
        q: trimmed, 
        limit: '10',
        staffOnly: staffOnly.toString()
      });
      const response = await dashboardFetch(`/staff/discord-members?${searchParams.toString()}`, { guildId,
        
        signal: abortController.signal
      });

      if (!response.ok) {
        throw new Error(m.dml_fetch_failed());
      }

      const data = await response.json();
      suggestions = data.members || [];
      syncExactMatch(trimmed);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      console.error('Erreur chargement suggestions membres:', err);
      suggestions = [];
      error = m.dml_suggest_failed();
    } finally {
      isLoading = false;
    }
  }

  function queueSearch(value: string): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      void fetchSuggestions(value);
    }, 220);
  }

  function handleInput(value: string): void {
    query = value;

    const extractedUserId = extractDiscordUserId(value);
    if (extractedUserId) {
      selectedId = extractedUserId;
    }

    queueSearch(value);
  }

  function selectSuggestion(member: DiscordMemberSuggestion): void {
    query = `<@${member.id}>`;
    selectedId = member.id;
    selectedUsername = member.username;
    selectedAvatarUrl = member.avatarUrl ?? '';
    selectedRoleIds = member.roleIds ?? [];
    suggestions = [];
    error = '';
  }
</script>

<div class={`relative ${className}`.trim()}>
  <input
    type="text"
    value={query}
    placeholder={placeholder}
    oninput={(event) => handleInput((event.currentTarget as HTMLInputElement).value)}
    class="w-full bg-[#1e1e2e]/60 border border-white/5 rounded-xl px-4 py-3 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-[#8a2be2]/50 focus:border-transparent transition-all duration-300"
    {disabled}
  />

  {#if isLoading}
    <p class="text-xs text-on-surface-variant mt-2 px-1">{m.dml_searching()}</p>
  {/if}

  {#if error}
    <p class="text-xs text-error mt-2 px-1">{error}</p>
  {/if}

  {#if suggestions.length > 0}
    <div class="absolute z-50 w-full mt-2 bg-[#1e1e2e] border border-white/10 rounded-xl shadow-sm overflow-hidden">
      <div class="max-h-60 overflow-y-auto p-2 space-y-1">
        {#each suggestions as suggestion (suggestion.id)}
          <button
            type="button"
            class="w-full text-left px-3 py-2 rounded-lg hover:bg-white/5 transition-colors flex items-center gap-3 group"
            onclick={() => selectSuggestion(suggestion)}
            {disabled}
          >
            <div class="h-8 w-8 rounded-full overflow-hidden bg-white/5 shrink-0 border border-white/10 group-hover:border-white/20 transition-colors">
              {#if suggestion.avatarUrl}
                <img src={suggestion.avatarUrl} alt="" class="h-full w-full object-cover" />
              {:else}
                <div class="h-full w-full flex items-center justify-center text-on-surface-variant">
                  <Papicon icon="user" size={14} />
                </div>
              {/if}
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center justify-between">
                <span class="text-sm font-medium text-gray-200 group-hover:text-white transition-colors truncate">
                  {suggestion.displayName || suggestion.username}
                </span>
                <span class="text-2xs text-on-surface-variant group-hover:text-on-surface-variant transition-colors shrink-0 ml-2">
                  @{suggestion.username}
                </span>
              </div>
            </div>
          </button>
        {/each}
      </div>
    </div>
  {/if}
</div>
