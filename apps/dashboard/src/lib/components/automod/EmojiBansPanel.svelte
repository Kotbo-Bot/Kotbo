<script lang="ts">
  /**
   * Emojis et stickers interdits : liste des règles (une sanction chacune),
   * ajout d'un emoji Discord natif, et recherche d'un serveur pour interdire
   * tous ses emojis et stickers ou seulement certains d'entre eux.
   * Le clic droit sur un message (Actions Kotbo) écrit dans la même liste.
   */
  import { onMount } from 'svelte';
  import Papicon from '../Papicon.svelte';
  import DurationPresets from '../DurationPresets.svelte';
  import Button from '../ui/Button.svelte';
  import Callout from '../ui/Callout.svelte';
  import { m } from '../../i18n';
  import { toast } from '../../stores/toast.svelte';
  import {
    deleteEmojiBan,
    fetchEmojiBanSource,
    fetchEmojiBans,
    saveEmojiBan,
    searchEmojiBanServers,
    type EmojiBanAction,
    type EmojiBanDraft,
    type EmojiBanRule,
    type EmojiBanServer,
    type EmojiBanSourceAssets,
  } from '../../api/emojiBans';

  let { canManage = false }: { canManage?: boolean } = $props();

  const ACTIONS: EmojiBanAction[] = ['DELETE', 'WARN', 'TIMEOUT', 'JAIL', 'KICK', 'SOFTBAN', 'BAN'];
  const WITH_DURATION = new Set<EmojiBanAction>(['TIMEOUT', 'BAN', 'JAIL']);
  const DURATION_PRESETS = [10, 60, 1440, 10080];

  const actionLabel = (a: EmojiBanAction) => ({
    DELETE: m.eb_action_delete(), WARN: m.eb_action_warn(), TIMEOUT: m.eb_action_timeout(), JAIL: m.eb_action_jail(),
    KICK: m.eb_action_kick(), SOFTBAN: m.eb_action_softban(), BAN: m.eb_action_ban(),
  })[a];
  const kindLabel = (k: EmojiBanRule['kind']) => ({
    EMOJI: m.eb_kind_emoji(), UNICODE: m.eb_kind_unicode(), STICKER: m.eb_kind_sticker(), SOURCE_GUILD: m.eb_kind_server(),
  })[k];

  let rules = $state<EmojiBanRule[]>([]);
  let maxRules = $state(200);
  let jailConfigured = $state(true);
  let loading = $state(true);
  let busy = $state<string | null>(null);

  // Sanction appliquée aux prochains ajouts.
  let newAction = $state<EmojiBanAction>('DELETE');
  let newDuration = $state(60);

  let unicodeInput = $state('');
  let query = $state('');
  let servers = $state<EmojiBanServer[]>([]);
  let searching = $state(false);
  let openSource = $state<string | null>(null);
  let sourceAssets = $state<EmojiBanSourceAssets | null>(null);

  const bannedKeys = $derived(new Set(rules.map((r) => `${r.kind}:${r.key}`)));

  async function load() {
    loading = true;
    try {
      const res = await fetchEmojiBans();
      if (res) {
        rules = res.rules;
        maxRules = res.maxRules;
        jailConfigured = res.jailConfigured;
      }
    } finally {
      loading = false;
    }
  }
  onMount(load);

  async function add(draft: EmojiBanDraft) {
    busy = `${draft.kind}:${draft.key}`;
    try {
      const res = await saveEmojiBan(draft);
      if (res?.rule) {
        rules = [res.rule, ...rules.filter((r) => r.id !== res.rule.id)];
        toast.success(m.eb_saved());
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.eb_err_save());
    } finally {
      busy = null;
    }
  }

  const withSanction = (draft: Omit<EmojiBanDraft, 'action' | 'durationMin'>): EmojiBanDraft => ({
    ...draft,
    action: newAction,
    durationMin: WITH_DURATION.has(newAction) ? newDuration : null,
  });

  async function changeAction(rule: EmojiBanRule, action: EmojiBanAction) {
    await add({ kind: rule.kind, key: rule.key, name: rule.name, iconUrl: rule.iconUrl, action, durationMin: WITH_DURATION.has(action) ? rule.durationMin ?? 60 : null });
  }

  async function changeDuration(rule: EmojiBanRule, durationMin: number) {
    if (!Number.isFinite(durationMin) || durationMin < 1) return;
    await add({ kind: rule.kind, key: rule.key, name: rule.name, iconUrl: rule.iconUrl, action: rule.action, durationMin });
  }

  async function remove(rule: EmojiBanRule) {
    busy = rule.id;
    try {
      await deleteEmojiBan(rule.id);
      rules = rules.filter((r) => r.id !== rule.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.eb_err_save());
    } finally {
      busy = null;
    }
  }

  async function addUnicode() {
    const value = unicodeInput.trim();
    if (!value) return;
    await add(withSanction({ kind: 'UNICODE', key: value, name: value }));
    unicodeInput = '';
  }

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  function onSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = query.trim();
      if (!q) { servers = []; return; }
      searching = true;
      try {
        servers = (await searchEmojiBanServers(q))?.servers ?? [];
      } finally {
        searching = false;
      }
    }, 300);
  }

  async function toggleSource(server: EmojiBanServer) {
    if (openSource === server.guildId) { openSource = null; return; }
    openSource = server.guildId;
    sourceAssets = null;
    sourceAssets = await fetchEmojiBanSource(server.guildId);
  }
</script>

<div class="space-y-6 animate-in fade-in duration-300">
  <Callout variant="info">{m.eb_hint_context_menu()}</Callout>

  <!-- Sanction des prochains ajouts -->
  <section class="bg-surface-container-low/30 border border-outline-variant/10 p-6 rounded-xl space-y-4">
    <div>
      <h3 class="text-sm font-bold text-on-surface">{m.eb_new_sanction_title()}</h3>
      <p class="text-xs text-on-surface-variant">{m.eb_new_sanction_desc()}</p>
    </div>
    <div class="flex flex-wrap items-start gap-4">
      <label class="space-y-1">
        <span class="text-2xs font-semibold uppercase tracking-wide text-on-surface-variant">{m.eb_sanction()}</span>
        <select bind:value={newAction} disabled={!canManage} class="block bg-surface-container border border-field-border rounded-lg px-3 py-2 text-sm">
          {#each ACTIONS as a (a)}
            <option value={a}>{actionLabel(a)}</option>
          {/each}
        </select>
      </label>
      {#if WITH_DURATION.has(newAction)}
        <label class="space-y-1">
          <span class="text-2xs font-semibold uppercase tracking-wide text-on-surface-variant">{m.eb_duration_min()}</span>
          <input type="number" min="1" bind:value={newDuration} disabled={!canManage} class="block w-32 bg-surface-container border border-field-border rounded-lg px-3 py-2 text-sm" />
          <DurationPresets bind:value={newDuration} presets={DURATION_PRESETS} label={m.eb_duration_min()} disabled={!canManage} />
        </label>
      {/if}
    </div>
    {#if newAction === 'JAIL' && !jailConfigured}
      <p class="text-xs text-warning">{m.eb_jail_fallback()}</p>
    {/if}
  </section>

  <!-- Emoji Discord natif -->
  <section class="bg-surface-container-low/30 border border-outline-variant/10 p-6 rounded-xl space-y-3">
    <h3 class="text-sm font-bold text-on-surface">{m.eb_unicode_title()}</h3>
    <form class="flex gap-2" onsubmit={(e) => { e.preventDefault(); addUnicode(); }}>
      <input
        bind:value={unicodeInput}
        maxlength="32"
        placeholder="🍆"
        aria-label={m.eb_unicode_title()}
        disabled={!canManage}
        class="w-28 bg-surface-container border border-field-border rounded-lg px-3 py-2 text-lg"
      />
      <Button type="submit" variant="primary" icon="plus" disabled={!canManage || !unicodeInput.trim()} loading={busy?.startsWith('UNICODE:') ?? false}>{m.eb_ban()}</Button>
    </form>
  </section>

  <!-- Serveurs -->
  <section class="bg-surface-container-low/30 border border-outline-variant/10 p-6 rounded-xl space-y-3">
    <div>
      <h3 class="text-sm font-bold text-on-surface">{m.eb_server_title()}</h3>
      <p class="text-xs text-on-surface-variant">{m.eb_server_desc()}</p>
    </div>
    <input
      bind:value={query}
      oninput={onSearch}
      placeholder={m.eb_server_search()}
      aria-label={m.eb_server_search()}
      class="w-full bg-surface-container border border-field-border rounded-lg px-3 py-2 text-sm"
    />
    {#if searching}
      <p class="text-xs text-on-surface-variant">{m.eb_searching()}</p>
    {/if}
    <ul class="space-y-2">
      {#each servers as server (server.guildId)}
        {@const banned = bannedKeys.has(`SOURCE_GUILD:${server.guildId}`)}
        <li class="border border-outline-variant/10 rounded-lg p-3 space-y-3">
          <div class="flex items-center gap-3 min-w-0">
            {#if server.iconUrl}
              <img src={server.iconUrl} alt="" class="w-8 h-8 rounded-full shrink-0" />
            {:else}
              <Papicon icon="globe" size={20} class="shrink-0 text-on-surface-variant" />
            {/if}
            <span class="flex-1 min-w-0 truncate text-sm font-medium">{server.name}</span>
            {#if server.kotboPresent}
              <Button size="sm" variant="ghost" iconRight={openSource === server.guildId ? 'chevron-up' : 'chevron-down'} onclick={() => toggleSource(server)}>{m.eb_server_pick()}</Button>
            {/if}
            <Button
              size="sm"
              variant={banned ? 'ghost' : 'danger'}
              disabled={!canManage || banned}
              disabledReason={banned ? m.eb_already() : ''}
              loading={busy === `SOURCE_GUILD:${server.guildId}`}
              onclick={() => add(withSanction({ kind: 'SOURCE_GUILD', key: server.guildId, name: server.name, iconUrl: server.iconUrl }))}
            >{m.eb_server_ban_all()}</Button>
          </div>

          {#if openSource === server.guildId}
            {#if !sourceAssets}
              <p class="text-xs text-on-surface-variant">{m.eb_searching()}</p>
            {:else if sourceAssets.emojis.length === 0 && sourceAssets.stickers.length === 0}
              <p class="text-xs text-on-surface-variant">{m.eb_server_empty()}</p>
            {:else}
              <div class="flex flex-wrap gap-2">
                {#each sourceAssets.emojis as e (e.id)}
                  {@const done = bannedKeys.has(`EMOJI:${e.id}`)}
                  <button
                    type="button"
                    title={`:${e.name}:`}
                    aria-label={`${m.eb_ban()} :${e.name}:`}
                    aria-pressed={done}
                    disabled={!canManage || done || busy !== null}
                    onclick={() => add(withSanction({ kind: 'EMOJI', key: e.id, name: e.name, iconUrl: e.url }))}
                    class="w-10 h-10 grid place-items-center rounded-lg border transition-colors disabled:cursor-not-allowed {done ? 'border-danger/50 bg-danger/10 opacity-60' : 'border-outline-variant/20 hover:border-danger/50'}"
                  ><img src={e.url} alt="" class="w-7 h-7 object-contain" /></button>
                {/each}
                {#each sourceAssets.stickers as s (s.id)}
                  {@const done = bannedKeys.has(`STICKER:${s.id}`)}
                  <button
                    type="button"
                    title={s.name}
                    aria-label={`${m.eb_ban()} ${s.name}`}
                    aria-pressed={done}
                    disabled={!canManage || done || busy !== null}
                    onclick={() => add(withSanction({ kind: 'STICKER', key: s.id, name: s.name, iconUrl: s.url }))}
                    class="w-14 h-14 grid place-items-center rounded-lg border transition-colors disabled:cursor-not-allowed {done ? 'border-danger/50 bg-danger/10 opacity-60' : 'border-outline-variant/20 hover:border-danger/50'}"
                  ><img src={s.url} alt="" class="w-12 h-12 object-contain" /></button>
                {/each}
              </div>
              <p class="text-2xs text-on-surface-variant">{m.eb_server_pick_hint()}</p>
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
  </section>

  <!-- Règles -->
  <section class="bg-surface-container-low/30 border border-outline-variant/10 p-6 rounded-xl space-y-3">
    <h3 class="text-sm font-bold text-on-surface">{m.eb_rules_title({ count: rules.length, max: maxRules })}</h3>
    {#if loading}
      <p class="text-xs text-on-surface-variant">{m.eb_searching()}</p>
    {:else if rules.length === 0}
      <p class="text-sm text-on-surface-variant">{m.eb_rules_empty()}</p>
    {:else}
      <ul class="divide-y divide-outline-variant/10">
        {#each rules as rule (rule.id)}
          <li class="flex flex-wrap items-center gap-3 py-3">
            <span class="w-10 h-10 grid place-items-center shrink-0">
              {#if rule.kind === 'UNICODE'}
                <span class="text-2xl">{rule.key}</span>
              {:else if rule.iconUrl}
                <img src={rule.iconUrl} alt="" class="max-w-10 max-h-10 object-contain {rule.kind === 'SOURCE_GUILD' ? 'rounded-full' : ''}" />
              {:else}
                <Papicon icon={rule.kind === 'SOURCE_GUILD' ? 'globe' : 'smile'} size={20} class="text-on-surface-variant" />
              {/if}
            </span>
            <span class="flex-1 min-w-40">
              <span class="block text-sm font-medium truncate">{rule.kind === 'EMOJI' ? `:${rule.name ?? rule.key}:` : rule.name ?? rule.key}</span>
              <span class="block text-2xs text-on-surface-variant">{kindLabel(rule.kind)}</span>
            </span>
            <select
              value={rule.action}
              aria-label={m.eb_sanction()}
              disabled={!canManage || busy !== null}
              onchange={(e) => changeAction(rule, (e.currentTarget as HTMLSelectElement).value as EmojiBanAction)}
              class="bg-surface-container border border-field-border rounded-lg px-2 py-1.5 text-xs"
            >
              {#each ACTIONS as a (a)}
                <option value={a}>{actionLabel(a)}</option>
              {/each}
            </select>
            {#if WITH_DURATION.has(rule.action)}
              <input
                type="number"
                min="1"
                value={rule.durationMin ?? ''}
                placeholder={m.eb_permanent()}
                aria-label={m.eb_duration_min()}
                disabled={!canManage || busy !== null}
                onchange={(e) => changeDuration(rule, Number((e.currentTarget as HTMLInputElement).value))}
                class="w-24 bg-surface-container border border-field-border rounded-lg px-2 py-1.5 text-xs"
              />
            {/if}
            <Button size="sm" variant="ghost" icon="trash-2" aria-label={m.eb_unban()} disabled={!canManage} loading={busy === rule.id} onclick={() => remove(rule)} />
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>
