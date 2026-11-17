<script lang="ts">
  import { onMount } from 'svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import { API_BASE_URL, fetchMcpKeys, createMcpKey, deleteMcpKey, fetchMcpDirectUrl, fetchMcpLogs } from '../lib/api';
  import ConfirmModal from '../lib/components/ConfirmModal.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import LoadingHint from '../lib/components/LoadingHint.svelte';
  import { Button, Callout, Field, Modal, SectionCard, EmptyState } from '../lib/components/ui';
  import { localInitialAvatar } from '../lib/discordMedia';
  import { m, dateLocale } from '../lib/i18n';

  const PERMISSIONS = $derived([
    { value: 'READ_STATS',      label: m.mcp_perm_read_stats_label(),     desc: m.mcp_perm_read_stats_desc() },
    { value: 'READ_MEMBERS',    label: m.mcp_perm_read_members_label(),   desc: m.mcp_perm_read_members_desc() },
    { value: 'READ_SANCTIONS',  label: m.mcp_perm_read_sanctions_label(), desc: m.mcp_perm_read_sanctions_desc() },
    { value: 'READ_STAFF',      label: m.mcp_perm_read_staff_label(),     desc: m.mcp_perm_read_staff_desc() },
    { value: 'READ_TICKETS',    label: m.mcp_perm_read_tickets_label(),   desc: m.mcp_perm_read_tickets_desc() },
    { value: 'READ_COMMUNITY',  label: m.mcp_perm_read_community_label(), desc: m.mcp_perm_read_community_desc() },
    { value: 'READ_ECONOMY',    label: m.mcp_perm_read_economy_label(),   desc: m.mcp_perm_read_economy_desc() },
    { value: 'READ_MODERATION', label: m.mcp_perm_read_moderation_label(),desc: m.mcp_perm_read_moderation_desc() },
    { value: 'READ_ANALYTICS',  label: m.mcp_perm_read_analytics_label(), desc: m.mcp_perm_read_analytics_desc() },
    { value: 'WRITE_SANCTIONS', label: m.mcp_perm_write_sanctions_label(),desc: m.mcp_perm_write_sanctions_desc() },
    { value: 'WRITE_MESSAGES',  label: m.mcp_perm_write_messages_label(), desc: m.mcp_perm_write_messages_desc() },
    { value: 'WRITE_TICKETS',   label: m.mcp_perm_write_tickets_label(),  desc: m.mcp_perm_write_tickets_desc() },
    { value: 'WRITE_COMMUNITY', label: m.mcp_perm_write_community_label(),desc: m.mcp_perm_write_community_desc() },
    { value: 'WRITE_MEMBERS',   label: m.mcp_perm_write_members_label(),  desc: m.mcp_perm_write_members_desc() },
    { value: 'READ_WORKFLOWS',  label: m.mcp_perm_read_workflows_label(), desc: m.mcp_perm_read_workflows_desc() },
    { value: 'WRITE_WORKFLOWS', label: m.mcp_perm_write_workflows_label(),desc: m.mcp_perm_write_workflows_desc() },
    { value: 'READ_SITE',       label: m.mcp_perm_read_site_label(),      desc: m.mcp_perm_read_site_desc() },
    { value: 'WRITE_SITE',      label: m.mcp_perm_write_site_label(),     desc: m.mcp_perm_write_site_desc() },
  ]);
  const DEFAULT_PERMS = ['READ_STATS', 'READ_MEMBERS', 'READ_SANCTIONS'];

  type McpKey = {
    id: string;
    name: string;
    displayKey: string;
    permissions: string[];
    lastUsedAt: string | null;
    createdAt: string;
    ownerId?: string | null;
  };

  type CreatedKey = {
    clientId: string;
    clientSecret: string;
    name: string;
    directUrl?: string;
  };

  type McpLogEntry = {
    id: string;
    ts: string;
    level: 'info' | 'warn' | 'error';
    guildId: string;
    event: string;
    method: string;
    url: string;
    ua: string;
    data: Record<string, unknown>;
  };

  let keys = $state<McpKey[]>([]);
  let loading = $state(true);

  // Create modal
  let createOpen = $state(false);
  let newKeyName = $state('');
  let newKeyPerms = $state<string[]>([...DEFAULT_PERMS]);
  let creating = $state(false);
  let createdKey = $state<CreatedKey | null>(null);
  let helpOpen = $state(false);
  let selectedAi = $state<'claude' | 'chatgpt' | 'gemini'>('claude');
  let diagOpen = $state(false);
  let diagRunning = $state(false);
  let diagLogs = $state<McpLogEntry[]>([]);
  let directUrls = $state<Record<string, { url: string; expiresAt: string }>>({});
  let directUrlLoadingKeyId = $state<string | null>(null);

  // Delete modal
  let deleteOpen = $state(false);
  let deletingKeyId = $state<string | null>(null);
  let deletingKeyName = $state('');

  // Copy state
  let copiedField = $state<string | null>(null);

  // Expanded row for credentials
  let expandedKeyId = $state<string | null>(null);

  const guildId = $derived(authStore.selectedGuildId ?? '');
  const readPermissions = $derived(PERMISSIONS.filter((p) => p.value.startsWith('READ_')));
  const writePermissions = $derived(PERMISSIONS.filter((p) => p.value.startsWith('WRITE_')));
  const readValues = $derived(readPermissions.map((p) => p.value));
  const allValues = $derived(PERMISSIONS.map((p) => p.value));
  const selectedReadCount = $derived(newKeyPerms.filter((p) => p.startsWith('READ_')).length);
  const selectedWriteCount = $derived(newKeyPerms.filter((p) => p.startsWith('WRITE_')).length);
  const endpointUrl = $derived(guildId ? `${API_BASE_URL}/api/mcp/${guildId}` : '');
  const restApiUrl = $derived(guildId ? `${API_BASE_URL}/api/v1/${guildId}` : '');

  const presets = $derived([
    { id: 'read', label: m.mcp_preset_read_only(), hint: m.mcp_preset_read_only_hint(), icon: 'eye', perms: readValues },
    { id: 'all', label: m.mcp_preset_all(), hint: m.mcp_preset_all_hint(), icon: 'zap', perms: allValues },
    { id: 'none', label: m.mcp_preset_none(), hint: m.mcp_preset_none_hint(), icon: 'rotate-ccw', perms: [] as string[] },
  ]);
  const permSections = $derived([
    { id: 'read', title: m.mcp_perm_read_section(), hint: m.mcp_perm_read_section_hint(), icon: 'eye', perms: readPermissions, write: false },
    { id: 'write', title: m.mcp_perm_write_section(), hint: m.mcp_perm_write_section_hint(), icon: 'edit-3', perms: writePermissions, write: true },
  ]);

  const aiGuides = $derived({
    claude: {
      name: 'Claude',
      logoUrl: localInitialAvatar('Claude'),
      badge: m.mcp_help_guide_claude_badge(),
      setupUrl: 'https://claude.ai/settings/connectors',
      docsUrl: 'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp',
      primaryAction: m.mcp_help_claude_action(),
      note: m.mcp_help_claude_note(),
      fields: [
        { label: 'Name', value: 'Kotbo' },
        { label: 'URL', value: m.mcp_help_claude_field_url() },
        { label: 'Advanced settings', value: m.mcp_help_claude_field_advanced() },
      ],
      steps: [
        m.mcp_help_claude_step1(),
        m.mcp_help_claude_step2(),
        m.mcp_help_claude_step3(),
        m.mcp_help_claude_step4(),
        m.mcp_help_claude_step5(),
      ],
    },
    chatgpt: {
      name: 'ChatGPT',
      logoUrl: localInitialAvatar('ChatGPT'),
      badge: m.mcp_help_guide_chatgpt_badge(),
      setupUrl: 'https://chatgpt.com/#settings/Apps',
      docsUrl: 'https://developers.openai.com/api/docs/guides/developer-mode',
      primaryAction: m.mcp_help_chatgpt_action(),
      note: m.mcp_help_chatgpt_note(),
      fields: [
        { label: 'App name', value: 'Kotbo' },
        { label: 'MCP server URL', value: m.mcp_help_chatgpt_field_url() },
        { label: 'Authentication', value: m.mcp_help_chatgpt_field_auth() },
      ],
      steps: [
        m.mcp_help_chatgpt_step1(),
        m.mcp_help_chatgpt_step2(),
        m.mcp_help_chatgpt_step3(),
        m.mcp_help_chatgpt_step4(),
        m.mcp_help_chatgpt_step5(),
      ],
    },
    gemini: {
      name: 'Gemini',
      logoUrl: localInitialAvatar('Gemini'),
      badge: m.mcp_help_guide_gemini_badge(),
      setupUrl: 'https://ai.google.dev/gemini-api/docs/interactions/deep-research',
      docsUrl: 'https://ai.google.dev/gemini-api/docs/interactions/deep-research',
      primaryAction: m.mcp_help_gemini_action(),
      note: m.mcp_help_gemini_note(),
      fields: [
        { label: 'type', value: 'mcp_server' },
        { label: 'name', value: 'Kotbo' },
        { label: 'url', value: m.mcp_help_gemini_field_url() },
        { label: 'headers', value: m.mcp_help_gemini_field_headers() },
      ],
      steps: [
        m.mcp_help_gemini_step1(),
        m.mcp_help_gemini_step2(),
        m.mcp_help_gemini_step3(),
        m.mcp_help_gemini_step4(),
        m.mcp_help_gemini_step5(),
      ],
    },
  });
  const currentGuide = $derived(aiGuides[selectedAi]);

  onMount(async () => {
    await loadKeys();
  });

  async function loadKeys() {
    loading = true;
    try {
      const result = await fetchMcpKeys();
      keys = Array.isArray(result) ? result : [];
    } catch {
      toast.error(m.mcp_toast_err_load_keys());
    } finally {
      loading = false;
    }
  }

  function togglePerm(perm: string) {
    newKeyPerms = newKeyPerms.includes(perm)
      ? newKeyPerms.filter((p) => p !== perm)
      : [...newKeyPerms, perm];
  }

  function sameSet(a: string[], b: string[]) {
    return a.length === b.length && a.every((p) => b.includes(p));
  }

  /** Coche ou decoche toute une section sans toucher a l'autre. */
  function toggleSection(values: string[]) {
    const allOn = values.every((v) => newKeyPerms.includes(v));
    newKeyPerms = allOn
      ? newKeyPerms.filter((p) => !values.includes(p))
      : [...new Set([...newKeyPerms, ...values])];
  }

  function openCreateModal() {
    createdKey = null;
    newKeyName = '';
    newKeyPerms = [...DEFAULT_PERMS];
    createOpen = true;
  }

  async function handleCreate() {
    if (!newKeyName.trim() || newKeyPerms.length === 0) return;
    creating = true;
    try {
      const result = await createMcpKey({ name: newKeyName.trim(), permissions: newKeyPerms });
      if (result?.fullKey) {
        createdKey = { clientId: result.id, clientSecret: result.fullKey, name: result.name };
        keys = [{ id: result.id, name: result.name, displayKey: result.displayKey, permissions: result.permissions, lastUsedAt: null, createdAt: result.createdAt }, ...keys];
        const directUrl = await loadDirectUrl(result.id, false);
        if (directUrl) {
          createdKey = { ...createdKey, directUrl };
        }
        newKeyName = '';
        newKeyPerms = [...DEFAULT_PERMS];
      }
    } catch {
      toast.error(m.mcp_toast_err_create_key());
    } finally {
      creating = false;
    }
  }

  function closeCreateModal() {
    createOpen = false;
    createdKey = null;
    copiedField = null;
  }

  async function copy(text: string, field: string) {
    await navigator.clipboard.writeText(text).catch(() => {});
    copiedField = field;
    setTimeout(() => { copiedField = null; }, 2000);
  }

  async function loadDirectUrl(keyId: string, copyAfterLoad = true) {
    if (!guildId) return null;
    directUrlLoadingKeyId = keyId;
    try {
      const result = await fetchMcpDirectUrl(keyId, guildId);
      if (result?.directUrl) {
        directUrls = {
          ...directUrls,
          [keyId]: { url: result.directUrl, expiresAt: result.expiresAt },
        };
        if (copyAfterLoad) {
          await copy(result.directUrl, `direct-${keyId}`);
        }
        return result.directUrl as string;
      }
    } catch {
      toast.error(m.mcp_toast_err_direct_url());
    } finally {
      directUrlLoadingKeyId = null;
    }
    return null;
  }

  function confirmDelete(key: McpKey) {
    deletingKeyId = key.id;
    deletingKeyName = key.name;
    deleteOpen = true;
  }

  async function handleDelete() {
    if (!deletingKeyId) return;
    try {
      await deleteMcpKey(deletingKeyId);
      keys = keys.filter((k) => k.id !== deletingKeyId);
      delete directUrls[deletingKeyId];
      directUrls = { ...directUrls };
      if (expandedKeyId === deletingKeyId) expandedKeyId = null;
      toast.success(m.mcp_toast_key_revoked());
    } catch {
      toast.error(m.mcp_toast_err_delete());
    } finally {
      deletingKeyId = null;
      deletingKeyName = '';
    }
  }

  function formatDate(iso: string | null) {
    if (!iso) return '-';
    return new Date(iso).toLocaleDateString(dateLocale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function permInfo(perm: string) {
    return PERMISSIONS.find((p) => p.value === perm);
  }

  function selectAiGuide(id: string) {
    if (id === 'claude' || id === 'chatgpt' || id === 'gemini') {
      selectedAi = id;
    }
  }

  function toggleExpandedKey(keyId: string) {
    expandedKeyId = expandedKeyId === keyId ? null : keyId;
  }

  function formatLogTime(ts: string) {
    return new Date(ts).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  async function refreshMcpLogs() {
    if (!guildId) return;
    diagRunning = true;
    try {
      const result = await fetchMcpLogs(guildId);
      diagLogs = Array.isArray(result?.logs) ? result.logs : [];
    } catch {
      toast.error(m.mcp_toast_err_load_logs());
    } finally {
      diagRunning = false;
    }
  }

  async function openMcpDiagnostics() {
    diagOpen = true;
    await refreshMcpLogs();
  }

  function handleKeyRowKeyboard(event: KeyboardEvent, keyId: string) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleExpandedKey(keyId);
    }
  }

  const LOG_TONE = {
    error: 'border-error/30 bg-error/5 text-on-error-container',
    warn: 'border-warning/30 bg-warning/5 text-on-warning-container',
    info: 'border-outline-variant bg-surface-container-low text-on-surface',
  } as const;
</script>

<!-- Valeur copiable : code + bouton Copier. -->
{#snippet copyRow(text: string, field: string, highlight = false)}
  <div class="flex items-center gap-2">
    <code class="flex-1 min-w-0 rounded-lg border px-2.5 py-1.5 font-mono text-2xs break-all bg-surface-container-lowest {highlight ? 'border-primary/40 text-primary' : 'border-outline-variant text-on-surface'}">
      {text}
    </code>
    <Button size="sm" variant="secondary" icon={copiedField === field ? 'check' : 'copy'} onclick={() => copy(text, field)}>
      {copiedField === field ? m.mcp_btn_copied() : m.mcp_btn_copy()}
    </Button>
  </div>
{/snippet}

{#snippet permChip(perm: string)}
  <span class="px-1.5 py-0.5 rounded text-2xs font-medium {perm.startsWith('WRITE_') ? 'bg-error/10 text-error' : 'bg-primary/10 text-primary'}">
    {permInfo(perm)?.label ?? perm}
  </span>
{/snippet}

<ModulePage
  title={m.mcp_title()}
  description={m.mcp_description()}
  icon="cpu"
>
  {#snippet actions()}
    <Button variant="ghost" icon="help-circle" aria-label={m.mcp_btn_help()} title={m.mcp_btn_help()} onclick={() => { helpOpen = true; }} />
    <Button variant="primary" icon="plus" onclick={openCreateModal}>{m.mcp_btn_new_key()}</Button>
  {/snippet}

<div class="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
  <!-- Colonne de droite : brancher l'IA (les clés, le travail courant, restent à gauche) -->
  <aside class="space-y-3 lg:order-2">
    <SectionCard title={m.mcp_howto_title()} icon="sparkles">
      <ol class="space-y-2 px-4 pb-4 pt-2">
        {#each [m.mcp_howto_step1(), m.mcp_howto_step2(), m.mcp_howto_step3()] as step, i}
          <li class="flex gap-2.5 text-xs leading-relaxed text-on-surface-variant">
            <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-2xs font-semibold text-primary">{i + 1}</span>
            <span>{step}</span>
          </li>
        {/each}
      </ol>
    </SectionCard>

    <SectionCard title={m.mcp_endpoint_label()} description={m.mcp_endpoint_notice()} icon="globe">
      {#snippet actions()}
        {#if endpointUrl}
          <Button size="sm" variant="ghost" icon="activity" onclick={openMcpDiagnostics}>{m.mcp_btn_logs()}</Button>
        {/if}
      {/snippet}
      <div class="space-y-3 px-4 pb-4 pt-2">
        {#if endpointUrl}
          {@render copyRow(endpointUrl, 'endpoint')}
        {:else}
          <p class="text-xs text-on-surface-variant">{m.mcp_endpoint_select_server()}</p>
        {/if}
        {#if restApiUrl}
          <div class="space-y-1">
            <p class="text-2xs font-medium text-on-surface-variant">{m.mcp_rest_label()}</p>
            {@render copyRow(restApiUrl, 'rest')}
            <p class="text-2xs text-on-surface-variant">{m.mcp_rest_notice()}</p>
          </div>
        {/if}
      </div>
    </SectionCard>
  </aside>

  <!-- Keys -->
  <div class="min-w-0 lg:order-1">
  <SectionCard title={m.mcp_keys_section_title()} icon="key" flush>
    {#if loading}
      <div class="flex flex-col items-center justify-center py-12 text-on-surface-variant">
        <div class="flex items-center">
          <Papicon icon="loader-2" size={18} class="animate-spin mr-2" />
          <span class="text-sm">{m.mcp_loading()}</span>
        </div>
        <LoadingHint context="config" />
      </div>

    {:else if keys.length === 0}
      <EmptyState
        icon="key"
        title={m.mcp_empty_title()}
        description={m.mcp_empty_desc()}
        actionLabel={m.mcp_btn_new_key()}
        actionIcon="plus"
        onAction={openCreateModal}
      />

    {:else}
      {#each keys as key (key.id)}
        <div class="border-b border-outline-variant last:border-0">
          <div
            role="button"
            tabindex="0"
            aria-expanded={expandedKeyId === key.id}
            class="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-container-low transition-colors cursor-pointer"
            onclick={() => toggleExpandedKey(key.id)}
            onkeydown={(event) => handleKeyRowKeyboard(event, key.id)}
          >
            <div class="w-2 h-2 rounded-full bg-success shrink-0"></div>

            <div class="flex-1 min-w-0">
              <p class="flex items-center gap-1.5 text-body-sm font-medium text-on-surface">
                {key.name}
                {#if !key.ownerId}
                  <!-- Une cle sans proprietaire survit au depart de celui qui
                       s'en sert : rien ne la relie a un compte, seule une
                       revocation a la main l'arrete. -->
                  <span class="px-1.5 py-0.5 rounded text-2xs font-medium bg-warning/15 text-on-warning-container" title={m.mcp_key_orphan_hint()}>
                    {m.mcp_key_orphan()}
                  </span>
                {/if}
              </p>
              <p class="text-2xs text-on-surface-variant mt-0.5">
                {m.mcp_last_used({ date: formatDate(key.lastUsedAt) })}
              </p>
              <div class="mt-1.5 flex flex-wrap gap-1">
                {#each key.permissions as perm}
                  {@render permChip(perm)}
                {/each}
              </div>
            </div>

            <div class="flex items-center gap-1 shrink-0">
              <Button
                size="sm"
                variant="ghost"
                icon="trash-2"
                aria-label={m.mcp_btn_revoke()}
                title={m.mcp_btn_revoke()}
                onclick={(e) => { e.stopPropagation(); confirmDelete(key); }}
              />
              <Papicon
                icon="chevron-down"
                size={14}
                class="text-on-surface-variant transition-transform duration-200 {expandedKeyId === key.id ? 'rotate-180' : ''}"
              />
            </div>
          </div>

          {#if expandedKeyId === key.id}
            <div class="px-5 pb-5 pt-3 border-t border-outline-variant bg-surface-container-low space-y-3">
              <div class="space-y-1">
                <p class="text-xs font-medium text-on-surface-variant">{m.mcp_client_id_label()}</p>
                {@render copyRow(key.id, `id-${key.id}`)}
              </div>

              <div class="space-y-1">
                <p class="text-xs font-medium text-on-surface-variant">
                  {m.mcp_client_secret_label()} <span class="font-normal">{m.mcp_client_secret_hint()}</span>
                </p>
                <code class="block rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 font-mono text-xs text-on-surface-variant break-all">
                  {key.displayKey}
                </code>
              </div>

              <div class="space-y-1">
                <p class="text-xs font-medium text-on-surface-variant">{m.mcp_endpoint_url_label()}</p>
                {@render copyRow(endpointUrl, `url-${key.id}`)}
              </div>

              <Callout variant="warning" icon="link" title={m.mcp_direct_url_title()}>
                <p>{m.mcp_direct_url_desc()}</p>
                {#if directUrls[key.id]?.url}
                  <div class="mt-2">{@render copyRow(directUrls[key.id].url, `direct-${key.id}`)}</div>
                  <p class="mt-1 text-2xs">
                    {m.mcp_direct_url_expires({ date: new Date(directUrls[key.id].expiresAt).toLocaleDateString(dateLocale()) })}
                  </p>
                {/if}
                {#snippet actions()}
                  {#if !directUrls[key.id]?.url}
                    <Button size="sm" variant="secondary" loading={directUrlLoadingKeyId === key.id} onclick={() => loadDirectUrl(key.id)}>
                      {directUrlLoadingKeyId === key.id ? m.mcp_btn_generating() : m.mcp_btn_generate()}
                    </Button>
                  {/if}
                {/snippet}
              </Callout>

              <div class="space-y-1.5">
                <p class="text-xs font-medium text-on-surface-variant">{m.mcp_permissions_label()}</p>
                <ul class="grid gap-1.5 sm:grid-cols-2">
                  {#each key.permissions as perm}
                    <li class="rounded-lg border px-3 py-2 {perm.startsWith('WRITE_') ? 'border-error/25 bg-error/5' : 'border-outline-variant bg-surface-container-lowest'}">
                      <p class="text-xs font-semibold {perm.startsWith('WRITE_') ? 'text-error' : 'text-on-surface'}">{permInfo(perm)?.label ?? perm}</p>
                      <p class="mt-0.5 text-2xs leading-relaxed text-on-surface-variant">{permInfo(perm)?.desc}</p>
                    </li>
                  {/each}
                </ul>
              </div>
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </SectionCard>
  </div>
</div>
</ModulePage>

<!-- ── Create Modal ──────────────────────────────────────────────────────── -->
<Modal
  bind:open={createOpen}
  onClose={closeCreateModal}
  size={createdKey ? 'md' : 'lg'}
  title={createdKey ? m.mcp_modal_created_title() : m.mcp_modal_create_title()}
  subtitle={createdKey ? '' : m.mcp_create_intro()}
>
  {#if createdKey}
    <div class="space-y-4">
      <Callout variant="warning">{m.mcp_modal_created_warning()}</Callout>

      <div class="space-y-1.5">
        <p class="flex items-center gap-1.5 text-xs font-medium text-on-surface-variant">
          <Papicon icon="hash" size={12} />
          {m.mcp_client_id_label()}
          <span class="font-normal">{m.mcp_client_id_hint()}</span>
        </p>
        {@render copyRow(createdKey.clientId, 'new-id')}
      </div>

      <div class="space-y-1.5">
        <p class="flex items-center gap-1.5 text-xs font-medium text-on-surface-variant">
          <Papicon icon="key" size={12} />
          {m.mcp_client_secret_label()}
          <span class="font-normal">{m.mcp_modal_created_secret_hint()}</span>
        </p>
        {@render copyRow(createdKey.clientSecret, 'new-secret', true)}
      </div>

      <div class="space-y-1.5">
        <p class="flex items-center gap-1.5 text-xs font-medium text-on-surface-variant">
          <Papicon icon="globe" size={12} />
          {m.mcp_modal_created_mcp_url_label()}
        </p>
        {@render copyRow(endpointUrl, 'new-url')}
      </div>

      {#if createdKey.directUrl}
        <Callout variant="warning" icon="link" title={m.mcp_direct_url_title()}>
          <div class="my-1.5">{@render copyRow(createdKey.directUrl, 'new-direct-url')}</div>
          <p>{m.mcp_modal_created_claude_notice()}</p>
        </Callout>
      {/if}
    </div>

  {:else}
    <div class="space-y-5">
      <Field label={m.mcp_form_key_name()} hint={m.mcp_form_key_name_hint()} required>
        {#snippet children(id, describedBy)}
          <input
            {id}
            aria-describedby={describedBy}
            type="text"
            class="input"
            bind:value={newKeyName}
            placeholder={m.mcp_form_key_name_placeholder()}
            maxlength={64}
          />
        {/snippet}
      </Field>

      <!-- Choix rapide : un clic remplit toute la grille, on affine ensuite. -->
      <div class="space-y-2">
        <p class="text-sm font-medium text-on-surface">{m.mcp_preset_label()}</p>
        <div class="grid gap-2 sm:grid-cols-3">
          {#each presets as preset (preset.id)}
            {@const active = sameSet(newKeyPerms, preset.perms)}
            <button
              type="button"
              aria-pressed={active}
              onclick={() => { newKeyPerms = [...preset.perms]; }}
              class="flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 {active ? 'border-primary bg-primary/10' : 'border-outline-variant bg-surface-container-low hover:border-primary/40'}"
            >
              <Papicon icon={preset.icon} size={16} class="mt-0.5 shrink-0 {active ? 'text-primary' : 'text-on-surface-variant'}" />
              <span class="min-w-0">
                <span class="block text-sm font-semibold {active ? 'text-primary' : 'text-on-surface'}">{preset.label}</span>
                <span class="mt-0.5 block text-xs leading-snug text-on-surface-variant">{preset.hint}</span>
              </span>
            </button>
          {/each}
        </div>
      </div>

      {#each permSections as section (section.id)}
        {@const values = section.perms.map((p) => p.value)}
        {@const count = values.filter((v) => newKeyPerms.includes(v)).length}
        <fieldset class="space-y-2">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div class="min-w-0">
              <legend class="flex items-center gap-2 text-sm font-semibold {section.write ? 'text-error' : 'text-on-surface'}">
                <Papicon icon={section.icon} size={15} />
                {section.title}
                <span class="rounded-full bg-surface-container-high px-2 py-0.5 text-2xs font-medium text-on-surface-variant">
                  {m.mcp_perm_count({ selected: count, total: values.length })}
                </span>
              </legend>
              <p class="mt-0.5 text-xs text-on-surface-variant">{section.hint}</p>
            </div>
            <Button size="sm" variant="ghost" icon={count === values.length ? 'square' : 'check-square'} onclick={() => toggleSection(values)}>
              {count === values.length ? m.mcp_deselect_all() : m.mcp_select_all()}
            </Button>
          </div>

          <div class="grid gap-2 sm:grid-cols-2">
            {#each section.perms as perm (perm.value)}
              {@const on = newKeyPerms.includes(perm.value)}
              <label
                class="flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary/50
                  {on
                    ? (section.write ? 'border-error/40 bg-error/5' : 'border-primary/40 bg-primary/5')
                    : 'border-outline-variant bg-surface-container-low hover:border-outline'}"
              >
                <input
                  type="checkbox"
                  checked={on}
                  onchange={() => togglePerm(perm.value)}
                  class="mt-0.5 h-4 w-4 shrink-0 cursor-pointer {section.write ? 'accent-error' : 'accent-primary'}"
                />
                <span class="min-w-0">
                  <span class="block text-sm font-medium text-on-surface">{perm.label}</span>
                  <span class="mt-0.5 block text-xs leading-relaxed text-on-surface-variant">{perm.desc.replace(/^⚠\s*/, '')}</span>
                </span>
              </label>
            {/each}
          </div>
        </fieldset>
      {/each}

      {#if selectedWriteCount > 0}
        <Callout variant="danger" title={m.mcp_write_warning_title()}>{m.mcp_write_warning()}</Callout>
      {/if}
    </div>
  {/if}

  {#snippet footer()}
    {#if createdKey}
      <Button variant="primary" fullWidth onclick={closeCreateModal}>{m.mcp_modal_created_btn_done()}</Button>
    {:else}
      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="text-xs text-on-surface-variant">
          {m.mcp_summary({ read: selectedReadCount, write: selectedWriteCount })}
        </p>
        <div class="flex items-center gap-2">
          <Button variant="ghost" onclick={closeCreateModal}>{m.common_cancel()}</Button>
          <Button
            variant="primary"
            icon="key"
            loading={creating}
            disabled={!newKeyName.trim() || newKeyPerms.length === 0}
            disabledReason={!newKeyName.trim() ? m.common_reason_fill_field() : m.common_reason_select_one()}
            onclick={handleCreate}
          >
            {creating ? m.mcp_btn_creating() : m.mcp_btn_generate_key()}
          </Button>
        </div>
      </div>
    {/if}
  {/snippet}
</Modal>

<!-- ── AI setup helper ───────────────────────────────────────────────────── -->
<Modal bind:open={helpOpen} onClose={() => { helpOpen = false; }} title={m.mcp_help_modal_title()} size="xl">
  <div class="space-y-5">
    <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {#each Object.entries(aiGuides) as [id, guide]}
        <button
          type="button"
          aria-pressed={selectedAi === id}
          onclick={() => selectAiGuide(id)}
          class="rounded-lg border p-3 text-left transition-colors {selectedAi === id ? 'border-primary bg-primary/10' : 'border-outline-variant bg-surface-container-low hover:border-primary/40'}"
        >
          <div class="flex items-start gap-3">
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-outline-variant bg-white">
              <img src={guide.logoUrl} alt="" class="h-6 w-6 object-contain" loading="lazy" />
            </div>
            <div class="min-w-0">
              <span class="block text-sm font-semibold {selectedAi === id ? 'text-primary' : 'text-on-surface'}">{guide.name}</span>
              <span class="mt-1 block text-xs leading-relaxed text-on-surface-variant">{guide.badge}</span>
            </div>
          </div>
        </button>
      {/each}
    </div>

    <Callout variant="info" title={currentGuide.name}>{currentGuide.note}</Callout>

    <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
      <div class="space-y-4">
        <div class="space-y-2">
          <p class="text-xs font-medium text-on-surface-variant">{m.mcp_help_tutorial_title({ name: currentGuide.name })}</p>
          <ol class="space-y-2">
            {#each currentGuide.steps as step, index}
              <li class="flex gap-2 text-sm text-on-surface">
                <span class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-2xs text-on-surface-variant">{index + 1}</span>
                <span class="leading-relaxed">{step}</span>
              </li>
            {/each}
          </ol>
        </div>

        <div class="flex flex-col gap-2 sm:flex-row">
          <Button variant="primary" icon="external-link" href={currentGuide.setupUrl} target="_blank" class="flex-1">
            {currentGuide.primaryAction}
          </Button>
          <Button variant="secondary" icon="book-open" href={currentGuide.docsUrl} target="_blank">
            {m.mcp_help_official_doc()}
          </Button>
        </div>
      </div>

      <div class="space-y-3">
        <div class="rounded-lg border border-outline-variant bg-surface-container-low p-3 space-y-2">
          <p class="text-xs font-medium text-on-surface-variant">{m.mcp_help_mcp_url()}</p>
          {#if endpointUrl}
            {@render copyRow(endpointUrl, 'help-endpoint')}
          {:else}
            <p class="text-xs text-on-surface-variant">{m.mcp_help_select_server_placeholder()}</p>
          {/if}
        </div>

        <div class="rounded-lg border border-outline-variant bg-surface-container-low p-3">
          <p class="mb-2 text-xs font-medium text-on-surface-variant">{m.mcp_help_fields_to_fill()}</p>
          <div class="space-y-2">
            {#each currentGuide.fields as field}
              <div class="rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2">
                <p class="text-2xs font-medium text-on-surface-variant">{field.label}</p>
                <p class="mt-0.5 text-xs leading-relaxed text-on-surface">{field.value}</p>
              </div>
            {/each}
          </div>
        </div>

        {#if selectedAi === 'gemini'}
          <div class="rounded-lg border border-outline-variant bg-surface-container-low p-3">
            <p class="mb-2 text-xs font-medium text-on-surface-variant">{m.mcp_help_gemini_example()}</p>
            <pre class="overflow-x-auto rounded-lg border border-outline-variant bg-surface-container-lowest p-3 text-2xs leading-relaxed text-on-surface">{`{
  "type": "mcp_server",
  "name": "Kotbo",
  "url": "${endpointUrl || 'https://api-kotbo.example/api/mcp/GUILD_ID'}",
  "headers": {
    "Authorization": "Bearer mcp_..."
  }
}`}</pre>
          </div>
        {/if}

        <p class="text-xs leading-relaxed text-on-surface-variant">
          {m.mcp_help_key_notice()}
        </p>
      </div>
    </div>
  </div>
</Modal>

<Modal bind:open={diagOpen} onClose={() => { diagOpen = false; }} title={m.mcp_logs_modal_title()} size="xl">
  <div class="space-y-3">
    <div class="flex items-center justify-between gap-3">
      <p class="text-sm text-on-surface-variant">{m.mcp_logs_subtitle()}</p>
      <Button
        size="sm"
        icon="refresh-cw"
        loading={diagRunning}
        disabled={!guildId}
        disabledReason={m.common_reason_fill_field()}
        onclick={refreshMcpLogs}
      >
        {diagRunning ? m.mcp_logs_btn_refreshing() : m.mcp_logs_btn_refresh()}
      </Button>
    </div>

    {#if diagLogs.length === 0}
      <div class="rounded-lg border border-outline-variant bg-surface-container-low p-6 text-sm text-on-surface-variant">
        {diagRunning ? m.mcp_logs_loading() : m.mcp_logs_empty()}
      </div>
    {:else}
      <div class="space-y-2">
        {#each diagLogs as log (log.id)}
          <div class="rounded-lg border p-3 {LOG_TONE[log.level] ?? LOG_TONE.info}">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-xs text-on-surface-variant">{formatLogTime(log.ts)}</span>
                  <span class="rounded border border-current px-1.5 py-0.5 text-2xs">{log.level}</span>
                  <span class="text-sm font-semibold">{log.event}</span>
                </div>
                <p class="mt-1 break-all font-mono text-2xs text-on-surface-variant">{log.method} {log.url}</p>
              </div>
              <span class="max-w-full truncate text-xs text-on-surface-variant">{log.ua || m.mcp_logs_no_ua()}</span>
            </div>
            <pre class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-container-lowest p-3 text-xs leading-relaxed text-on-surface">{JSON.stringify(log.data, null, 2)}</pre>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</Modal>

<!-- ── Delete Confirm ────────────────────────────────────────────────────── -->
<ConfirmModal
  bind:open={deleteOpen}
  title={m.mcp_delete_modal_title()}
  description={m.mcp_delete_modal_desc({ name: deletingKeyName })}
  variant="danger"
  confirmLabel={m.mcp_delete_modal_confirm()}
  onConfirm={handleDelete}
/>
