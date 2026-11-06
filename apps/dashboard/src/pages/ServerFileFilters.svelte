<script lang="ts">
  /**
   * Sécurité > Filtres > Serveurs & fichiers.
   *
   * Deux filtres de l'Automod : « Autres serveurs » (invitations, messages
   * transférés, tags) et « Extensions de fichiers ». Leurs réglages vivent dans
   * la config anti-raid ; les règles de fichiers par salon sont enregistrées
   * une par une, immédiatement.
   */
  import { onMount } from 'svelte';
  import { gotoTab } from '../lib/tabRouting';
  import { pageTabItems } from '../lib/config/pageTabs';
  import { Tabs } from '../lib/components/ui';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import SectionCard from '../lib/components/SectionCard.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import Callout from '../lib/components/ui/Callout.svelte';
  import Button from '../lib/components/ui/Button.svelte';
  import LoadingHint from '../lib/components/LoadingHint.svelte';
  import { m } from '../lib/i18n';
  import { authStore } from '../lib/stores/auth.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import {
    fetchRaidProtection,
    updateRaidProtection,
    addOtherServer,
    fetchFileRules,
    saveFileRule,
    deleteFileRule,
    type FileFilterRule,
  } from '../lib/api';

  type Config = Record<string, any>;

  const MODES = [
    { value: 'OFF', label: m.common_disabled() },
    { value: 'BLACKLIST', label: m.sff_mode_blacklist() },
    { value: 'WHITELIST', label: m.sff_mode_whitelist() },
  ];
  const SANCTIONS = [
    { value: 'DELETE', label: m.sff_sanction_delete() },
    { value: 'WARN', label: m.arx_sanction_warn() },
    { value: 'TIMEOUT', label: 'Timeout' },
    { value: 'JAIL', label: m.arx_jail_title() },
    { value: 'KICK', label: m.arx_sanction_kick() },
    { value: 'BAN', label: m.arx_sanction_ban() },
  ];
  const DURATIONS = [
    { value: 10, label: '10 minutes' },
    { value: 60, label: m.arx_duration_1h() },
    { value: 1440, label: m.arx_duration_1d() },
    { value: 10080, label: m.arx_duration_7d() },
  ];
  const GROUP_LABELS: Record<string, string> = {
    EXECUTABLES: m.sff_group_executables(),
    IMAGES: m.sff_group_images(),
    VIDEOS: m.sff_group_videos(),
    AUDIO: 'Audio',
    ARCHIVES: m.sff_group_archives(),
    DOCUMENTS: m.sff_group_documents(),
  };

  let config = $state<Config>({});
  let original = $state<Config>({});
  let loading = $state(true);
  let saving = $state(false);
  let busy = $state(false);
  let invite = $state('');

  let rules = $state<FileFilterRule[]>([]);
  let groups = $state<Record<string, string[]>>({});
  let maxRules = $state(20);
  let draft = $state<{ targetId: string; mode: 'BLACKLIST' | 'WHITELIST'; groups: string[]; extensions: string }>({ targetId: '', mode: 'BLACKLIST', groups: [], extensions: '' });

  const dirty = $derived(JSON.stringify(config) !== JSON.stringify(original));
  const channels = $derived(dashboardStore.state.discordChannels ?? []);
  const categories = $derived(dashboardStore.state.discordCategories ?? []);
  const servers = $derived(((config.otherServers ?? []) as string[]).map((entry) => {
    const [id, ...name] = entry.split('|');
    return { entry, id, name: name.join('|') || id };
  }));

  function channelName(id: string): string {
    const category = categories.find((c) => c.id === id);
    if (category) return `📁 ${category.name}`;
    const channel = channels.find((c) => c.id === id);
    return channel ? `#${channel.name}` : id;
  }

  async function load() {
    if (!authStore.selectedGuildId) return;
    loading = true;
    try {
      const [res, fileRes] = await Promise.all([fetchRaidProtection(authStore.selectedGuildId), fetchFileRules(authStore.selectedGuildId)]);
      config = { ...(res?.config ?? {}) };
      original = { ...(res?.config ?? {}) };
      rules = fileRes?.rules ?? [];
      groups = fileRes?.groups ?? {};
      maxRules = fileRes?.maxRules ?? 20;
    } catch {
      toast.error(m.sff_load_error());
    } finally {
      loading = false;
    }
  }

  async function save() {
    if (!dirty || saving) return;
    saving = true;
    try {
      const res = await updateRaidProtection({ ...config }, authStore.selectedGuildId);
      config = { ...(res?.config ?? config) };
      original = { ...config };
      toast.success(m.sff_saved());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.tmac_err_save());
    } finally {
      saving = false;
    }
  }

  async function addServer() {
    if (!invite.trim() || busy) return;
    busy = true;
    try {
      const res = await addOtherServer(invite.trim(), authStore.selectedGuildId);
      if (res?.config) {
        config.otherServers = res.config.otherServers;
        original.otherServers = res.config.otherServers;
        invite = '';
        toast.success(m.sff_server_added());
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.sff_add_failed());
    } finally {
      busy = false;
    }
  }

  function removeServer(entry: string) {
    config.otherServers = (config.otherServers as string[]).filter((e) => e !== entry);
  }

  function toggleGroup(list: string[], group: string): string[] {
    return list.includes(group) ? list.filter((g) => g !== group) : [...list, group];
  }

  async function addRule() {
    if (!draft.targetId || busy) return;
    busy = true;
    try {
      const res = await saveFileRule({ ...draft, extensions: draft.extensions.split(/[,\s]+/).filter(Boolean) }, authStore.selectedGuildId);
      if (res?.rule) {
        rules = [...rules.filter((r) => r.targetId !== res.rule.targetId), res.rule];
        draft = { targetId: '', mode: 'BLACKLIST', groups: [], extensions: '' };
        toast.success(m.sff_rule_saved());
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.tmac_err_save());
    } finally {
      busy = false;
    }
  }

  async function removeRule(rule: FileFilterRule) {
    busy = true;
    try {
      await deleteFileRule(rule.id, authStore.selectedGuildId);
      rules = rules.filter((r) => r.id !== rule.id);
    } finally {
      busy = false;
    }
  }

  onMount(load);
  $effect(() => {
    if (authStore.selectedGuildId) void load();
  });
</script>

{#snippet modeSelect(field: string, label: string, help: string)}
  <label class="block">
    <span class="text-xs font-medium text-on-surface-variant">{label}</span>
    <select bind:value={config[field]} class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface">
      {#each MODES as mode (mode.value)}<option value={mode.value}>{mode.label}</option>{/each}
    </select>
    <p class="text-2xs text-on-surface-variant mt-1">{help}</p>
  </label>
{/snippet}

{#snippet sanctionFields(sanctionField: string, durationField: string)}
  <div class="grid sm:grid-cols-2 gap-3">
    <label class="block">
      <span class="text-xs font-medium text-on-surface-variant">{m.sff_sanction()}</span>
      <select bind:value={config[sanctionField]} class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface">
        {#each SANCTIONS as s (s.value)}<option value={s.value}>{s.label}</option>{/each}
      </select>
      <p class="text-2xs text-on-surface-variant mt-1">{m.sff_sanction_hint()}</p>
    </label>
    {#if ['TIMEOUT', 'BAN', 'JAIL'].includes(config[sanctionField])}
      <label class="block">
        <span class="text-xs font-medium text-on-surface-variant">{m.arx_vision_duration()}</span>
        <select bind:value={config[durationField]} class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface">
          {#each DURATIONS as d (d.value)}<option value={d.value}>{d.label}</option>{/each}
        </select>
      </label>
    {/if}
  </div>
{/snippet}

<ModulePage title={m.am_page_title()} description={m.sff_page_desc()} icon="filter" featureKey="raid_protection">
  <Tabs label={m.am_page_title()} tabs={pageTabItems('/security/filters')} active="servers" onchange={(id) => gotoTab('/security/filters', id, 'bot')} />

  {#if loading}
    <LoadingHint context="config" />
  {:else}
    <div class="space-y-6">
      <SectionCard
        title={m.sff_servers_title()}
        description={m.sff_servers_desc()}
        icon="Globe"
      >
        <div class="space-y-4">
          <div class="grid sm:grid-cols-3 gap-3">
            {@render modeSelect('otherInvitesMode', m.sff_invites(), m.sff_invites_help())}
            {@render modeSelect('otherForwardsMode', m.sff_forwards(), m.sff_forwards_help())}
            {@render modeSelect('otherTagsMode', m.sff_tags(), m.sff_tags_help())}
          </div>
          {#if config.otherInvitesMode !== 'OFF'}
            <label class="block sm:w-1/2">
              <span class="text-xs font-medium text-on-surface-variant">{m.sff_friend_invites()}</span>
              <select bind:value={config.otherFriendInvites} class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface">
                <option value="FOLLOW">{m.sff_follow_list()}</option>
                <option value="ALLOW">{m.sff_always_allowed()}</option>
                <option value="BLOCK">{m.sff_always_deleted()}</option>
              </select>
            </label>
          {/if}
          {#if config.otherTagsMode !== 'OFF' && !config.jailRoleId}
            <Callout variant="warning">{m.sff_no_jail()}</Callout>
          {/if}

          <div class="rounded-xl border border-outline-variant/30 p-3 space-y-2">
            <p class="text-body-sm font-medium text-on-surface">{m.sff_server_list({ count: servers.length, max: 25 })}</p>
            {#if servers.length === 0}
              <p class="text-xs text-on-surface-variant">{m.sff_server_list_empty()}</p>
            {:else}
              <div class="flex flex-wrap gap-2">
                {#each servers as server (server.entry)}
                  <span class="inline-flex items-center gap-1 rounded-lg border border-outline-variant/40 px-2 py-1 text-xs text-on-surface">
                    {server.name}
                    <Button size="sm" variant="ghost" icon="X" aria-label={m.sff_remove_server({ name: server.name })} onclick={() => removeServer(server.entry)} />
                  </span>
                {/each}
              </div>
            {/if}
            <form class="flex gap-2" onsubmit={(e) => { e.preventDefault(); void addServer(); }}>
              <input type="text" bind:value={invite} placeholder={m.sff_invite_ph()} class="flex-1 rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface" />
              <Button type="submit" size="sm" icon="Plus" disabled={busy || !invite.trim() || servers.length >= 25}>{m.sff_add()}</Button>
            </form>
          </div>
          {@render sanctionFields('otherSanction', 'otherDurationMin')}
        </div>
      </SectionCard>

      <SectionCard
        title={m.sff_files_title()}
        description={m.sff_files_desc()}
        icon="Paperclip"
      >
        <div class="space-y-4">
          {@render modeSelect('fileFilterMode', m.sff_server_rule(), m.sff_server_rule_help())}
          {#if config.fileFilterMode !== 'OFF'}
            <div class="flex flex-wrap gap-2">
              {#each Object.keys(GROUP_LABELS) as group (group)}
                <label class="inline-flex items-center gap-2 rounded-lg border border-outline-variant/40 px-3 py-1.5 text-xs text-on-surface cursor-pointer" title={(groups[group] ?? []).join(', ')}>
                  <input type="checkbox" checked={(config.fileGroups ?? []).includes(group)} onchange={() => (config.fileGroups = toggleGroup(config.fileGroups ?? [], group))} />
                  {GROUP_LABELS[group]}
                </label>
              {/each}
            </div>
            <label class="block">
              <span class="text-xs font-medium text-on-surface-variant">{m.sff_extra_ext()}</span>
              <input
                type="text"
                value={(config.fileExtensions ?? []).join(', ')}
                onchange={(e) => (config.fileExtensions = e.currentTarget.value.split(/[,\s]+/).map((x) => x.trim().replace(/^\./, '')).filter(Boolean))}
                placeholder="exe, msi"
                class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface font-mono"
              />
            </label>
            {#if config.fileFilterMode === 'WHITELIST' && !(config.fileGroups ?? []).length && !(config.fileExtensions ?? []).length}
              <Callout variant="warning">{m.sff_whitelist_empty()}</Callout>
            {/if}
          {/if}
          <div class="flex items-start justify-between gap-4 rounded-xl border border-outline-variant/30 px-4 py-3">
            <div class="min-w-0">
              <p class="text-body-sm font-medium text-on-surface">{m.sff_disguised()}</p>
              <p class="text-xs text-on-surface-variant mt-1 leading-relaxed">{m.sff_disguised_help()}</p>
            </div>
            <ToggleSwitch checked={Boolean(config.fileRejectCorrupted)} onToggle={(v) => (config.fileRejectCorrupted = v)} />
          </div>
          {@render sanctionFields('fileSanction', 'fileDurationMin')}

          <div class="rounded-xl border border-outline-variant/30 p-3 space-y-3">
            <p class="text-body-sm font-medium text-on-surface">{m.sff_rules({ count: rules.length, max: maxRules })}</p>
            {#each rules as rule (rule.id)}
              <div class="flex items-center justify-between gap-3 rounded-lg border border-outline-variant/30 px-3 py-2">
                <div class="min-w-0">
                  <p class="text-xs text-on-surface">{channelName(rule.targetId)} · {rule.mode === 'WHITELIST' ? m.sff_whitelist_lower() : m.sff_blacklist_lower()}</p>
                  <p class="text-xs text-on-surface-variant truncate">{[...rule.groups.map((g) => GROUP_LABELS[g] ?? g), ...rule.extensions.map((e) => `.${e}`)].join(', ') || m.sff_no_extension()}</p>
                </div>
                <Button size="sm" variant="ghost" icon="Trash2" aria-label={m.sff_remove_rule()} disabled={busy} onclick={() => removeRule(rule)} />
              </div>
            {/each}
            {#if rules.length < maxRules}
              <div class="grid sm:grid-cols-[1fr_1fr_auto] gap-2 items-end">
                <label class="block">
                  <span class="text-xs font-medium text-on-surface-variant">{m.sff_target()}</span>
                  <select bind:value={draft.targetId} class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface">
                    <option value="">{m.sff_choose()}</option>
                    {#each categories as category (category.id)}<option value={category.id}>📁 {category.name}</option>{/each}
                    {#each channels as channel (channel.id)}<option value={channel.id}>#{channel.name}</option>{/each}
                  </select>
                </label>
                <label class="block">
                  <span class="text-xs font-medium text-on-surface-variant">{m.sff_mode()}</span>
                  <select bind:value={draft.mode} class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface">
                    <option value="BLACKLIST">{m.sff_blacklist()}</option>
                    <option value="WHITELIST">{m.sff_whitelist()}</option>
                  </select>
                </label>
                <Button size="sm" icon="Plus" disabled={busy || !draft.targetId} onclick={addRule}>{m.sff_add()}</Button>
              </div>
              {#if draft.targetId}
                <div class="flex flex-wrap gap-2">
                  {#each Object.keys(GROUP_LABELS) as group (group)}
                    <label class="inline-flex items-center gap-2 rounded-lg border border-outline-variant/40 px-3 py-1.5 text-xs text-on-surface cursor-pointer">
                      <input type="checkbox" checked={draft.groups.includes(group)} onchange={() => (draft.groups = toggleGroup(draft.groups, group))} />
                      {GROUP_LABELS[group]}
                    </label>
                  {/each}
                  <input type="text" bind:value={draft.extensions} placeholder={m.sff_extra_ext_ph()} class="flex-1 min-w-40 rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-1.5 text-body-sm text-on-surface font-mono" />
                </div>
              {/if}
            {/if}
          </div>
        </div>
      </SectionCard>
    </div>

    {#if dirty}
      <div class="sticky bottom-4 z-10 mt-6">
        <div class="flex items-center justify-between gap-4 rounded-xl border border-primary/40 bg-surface-container-high/95 backdrop-blur px-4 py-3 shadow-lg">
          <p class="text-body-sm text-on-surface">{m.sff_unsaved()}</p>
          <div class="flex items-center gap-2">
            <Button size="sm" variant="ghost" disabled={saving} onclick={() => (config = { ...original })}>{m.common_cancel()}</Button>
            <Button size="sm" loading={saving} onclick={save}>{m.common_save()}</Button>
          </div>
        </div>
      </div>
    {/if}
  {/if}
</ModulePage>
