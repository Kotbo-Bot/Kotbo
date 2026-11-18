<script lang="ts">
  import { m } from '../lib/i18n';
  import { onDestroy, onMount, untrack, type Snippet } from 'svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import {
    fetchCustomBotConfig,
    updateCustomBotConfig,
    validateCustomBotToken,
    startCustomBot,
    stopCustomBot,
    verifyCustomBotDomain,
    switchToCustomBot,
    revertToKotbo,
  } from '../lib/api';
  import Papicon from '../lib/components/Papicon.svelte';
  import Button from '../lib/components/ui/Button.svelte';
  import Callout from '../lib/components/ui/Callout.svelte';
  import Field from '../lib/components/ui/Field.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import LoadingHint from '../lib/components/LoadingHint.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import ImagePicker from '../lib/components/ImagePicker.svelte';
  import { errorMessage } from '@kotbo/shared';

  type DomainInfo = {
    target: string | null;
    verification: { name: string; value: string } | null;
    redirectUri: string | null;
    active: boolean;
  };
  type OwnBotState = {
    instanceId: string | null;
    switched: boolean;
    botInGuild: boolean;
    kotboInGuild: boolean;
    invitePermissions: string;
    kotboClientId: string;
  };
  type Config = Record<string, any> & { domain?: DomainInfo };
  type Draft = {
    botName: string;
    botAvatarUrl: string;
    botBannerUrl: string;
    botBio: string;
    botStatus: string;
    activityType: string;
    activityText: string;
    activityUrl: string;
    customDashboardUrl: string;
    botClientId: string;
    botClientSecret: string;
  };

  const BIO_MAX = 190;
  const SAVE_OWNER = 'custom-bot';

  let config = $state<Config | null>(null);
  let ownBot = $state<OwnBotState | null>(null);
  let allowed = $state(true);
  let runningWithoutPlan = $state(false);
  let loading = $state(true);
  let busy = $state(false);
  let destroyed = false;

  let tokenInput = $state('');
  let showToken = $state(false);
  let replacingToken = $state(false);
  let connecting = $state(false);
  let connectedBot = $state<{ id: string; username: string; avatar: string | null } | null>(null);

  let verifying = $state(false);
  let dnsChecks = $state<{ txt: boolean; pointing: boolean } | null>(null);
  let checkingInvite = $state(false);

  function draftFrom(c: Config | null): Draft {
    return {
      botName: c?.botName ?? '',
      botAvatarUrl: c?.botAvatarUrl ?? '',
      botBannerUrl: c?.botBannerUrl ?? '',
      botBio: c?.botBio ?? '',
      botStatus: c?.botStatus ?? 'ONLINE',
      activityType: c?.activityType ?? 'NONE',
      activityText: c?.activityText ?? '',
      activityUrl: c?.activityUrl ?? '',
      customDashboardUrl: c?.customDashboardUrl ?? '',
      botClientId: c?.botClientId ?? '',
      // Jamais prerempli : le serveur ne renvoie qu'une version masquee.
      botClientSecret: '',
    };
  }

  let saved = $state<Draft>(draftFrom(null));
  let draft = $state<Draft>(draftFrom(null));
  const dirty = $derived(JSON.stringify(draft) !== JSON.stringify(saved));

  function applyConfig(next: Config | null) {
    config = next;
    saved = draftFrom(next);
    draft = draftFrom(next);
  }

  async function loadConfig() {
    try {
      const data = await fetchCustomBotConfig();
      allowed = data?.allowed !== false;
      runningWithoutPlan = !allowed && data?.isRunning === true;
      ownBot = data?.ownBot ?? null;
      applyConfig(data?.config ?? null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      loading = false;
    }
  }

  /** Recharge l'etat sans toucher aux modifications en cours. */
  async function refreshStatus() {
    const data = await fetchCustomBotConfig();
    if (data?.config) config = data.config;
    if (data?.ownBot) ownBot = data.ownBot;
  }

  onMount(loadConfig);
  onDestroy(() => {
    destroyed = true;
    unsavedChanges.release(SAVE_OWNER);
  });

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // L'instance met quelques secondes a se connecter et n'ecrit l'erreur qu'ensuite :
  // sans ce suivi, un token refuse laissait la page afficher « demarrage en cours ».
  async function followStart() {
    for (const wait of [3000, 5000, 8000]) {
      await sleep(wait);
      if (destroyed) return;
      await refreshStatus().catch(() => {});
      if (config?.lastError || config?.isRunning) break;
    }
  }

  async function run(action: () => Promise<unknown>) {
    busy = true;
    try {
      await action();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      busy = false;
    }
  }

  const start = () => run(async () => {
    await startCustomBot();
    toast.success(m.cb_bot_starting());
    await followStart();
  });

  const stop = () => run(async () => {
    await stopCustomBot();
    toast.success(m.cb_bot_stopped());
    await refreshStatus();
  });

  async function toggleOwnBot(next: boolean) {
    if (!next && isRunning && !(await confirmDialog.ask({ title: m.cbd_own_off_confirm(), description: m.cbd_own_off_desc(), confirmLabel: m.cbd_own_off_action(), variant: 'warning' }))) return;
    await run(async () => {
      const data = await updateCustomBotConfig({ enabled: next });
      config = data.config;
      reportProfile(data.profileErrors);
      await refreshStatus();
    });
  }

  // Un seul bouton : le token est teste aupres de Discord avant d'etre enregistre.
  async function connectToken() {
    const token = tokenInput.trim();
    if (!token) return;
    connecting = true;
    try {
      const result = await validateCustomBotToken(token);
      if (!result.valid) {
        toast.error(result.error || m.cb_token_invalid());
        return;
      }
      const data = await updateCustomBotConfig({
        botToken: token,
        // L'identifiant de l'application est celui de son bot.
        ...(config?.botClientId ? {} : { botClientId: result.bot.id }),
      });
      config = data.config;
      saved.botClientId = draft.botClientId = data.config.botClientId ?? '';
      connectedBot = result.bot;
      tokenInput = '';
      replacingToken = false;
      toast.success(m.cb_token_valid({ name: result.bot.username, id: result.bot.id }));
      if (config?.isRunning) await start();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      connecting = false;
    }
  }

  function reportProfile(errors: string[] | undefined) {
    if (errors?.length) toast.error(m.cbd_profile_partial({ details: errors.join(' · ') }));
  }

  async function save(): Promise<boolean> {
    try {
      const data = await updateCustomBotConfig({
        botName: draft.botName || null,
        botAvatarUrl: draft.botAvatarUrl || null,
        botBannerUrl: draft.botBannerUrl || null,
        botBio: draft.botBio || null,
        botStatus: draft.botStatus,
        activityType: draft.activityType,
        activityText: draft.activityText || null,
        activityUrl: draft.activityUrl || null,
        customDashboardUrl: draft.customDashboardUrl || null,
        botClientId: draft.botClientId || null,
        // Laisse vide, le secret enregistre est conserve.
        ...(draft.botClientSecret.trim() ? { botClientSecret: draft.botClientSecret.trim() } : {}),
      });
      applyConfig(data.config);
      dnsChecks = null;
      if (data.profileErrors?.length) reportProfile(data.profileErrors);
      else toast.success(m.cb_config_saved());
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  }

  $effect(() => {
    if (dirty) {
      untrack(() => unsavedChanges.register({
        id: SAVE_OWNER,
        label: m.cbx_title(),
        onSave: save,
        onReset: () => { draft = { ...saved }; },
      }));
    } else {
      untrack(() => unsavedChanges.release(SAVE_OWNER));
    }
  });

  async function verifyDomain() {
    verifying = true;
    try {
      const result = await verifyCustomBotDomain();
      dnsChecks = result.checks;
      config = result.config;
      if (result.verified) toast.success(m.cbd_domain_verified());
      else toast.error(m.cbd_domain_not_ready());
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      verifying = false;
    }
  }

  async function checkInvite() {
    checkingInvite = true;
    try {
      await refreshStatus();
      if (!ownBot?.botInGuild) toast.error(m.cbd_invite_not_yet());
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      checkingInvite = false;
    }
  }

  // Revenu de l'onglet d'invitation Discord : on regarde tout de suite si le bot est arrive.
  function onWindowFocus() {
    if (config?.enabled && !ownBot?.switched && !destroyed) void refreshStatus().catch(() => {});
  }

  async function switchBot() {
    const ok = await confirmDialog.ask({
      title: m.cbd_switch_confirm(),
      description: m.cbd_switch_confirm_desc(),
      confirmLabel: m.cbd_switch_action(),
      variant: 'danger',
      impacts: [m.cbd_switch_impact_kotbo(), domainState === 'active' ? m.cbd_switch_impact_dashboard({ host: savedHost }) : m.cbd_switch_impact_nodash(), m.cbd_switch_impact_back()],
    });
    if (!ok) return;
    await run(async () => {
      const result = await switchToCustomBot();
      toast.success(m.cbd_switched());
      // Ce dashboard ne voit plus le serveur : on part sur le sien (s'il a un domaine).
      await sleep(1500);
      if (result.dashboardUrl) window.location.href = `${result.dashboardUrl}/?guild=${authStore.selectedGuildId}`;
      else window.location.reload();
    });
  }

  async function revert() {
    const ok = await confirmDialog.ask({
      title: m.cbd_revert_confirm(),
      description: m.cbd_revert_confirm_desc(),
      confirmLabel: m.cbd_revert_action(),
      variant: 'warning',
    });
    if (!ok) return;
    await run(async () => {
      await revertToKotbo();
      toast.success(m.cbd_reverted());
      await refreshStatus();
    });
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(m.pf_copied());
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  function inviteUrl(clientId: string | null | undefined): string {
    if (!clientId || !ownBot) return '';
    const params = new URLSearchParams({
      client_id: clientId,
      scope: 'bot applications.commands',
      permissions: ownBot.invitePermissions,
      guild_id: authStore.selectedGuildId ?? '',
      disable_guild_select: 'true',
    });
    return `https://discord.com/oauth2/authorize?${params}`;
  }

  const statusOptions = [
    { value: 'ONLINE', get label() { return m.cbx_status_online(); }, dot: 'bg-emerald-500' },
    { value: 'IDLE', get label() { return m.cbx_status_idle(); }, dot: 'bg-amber-500' },
    { value: 'DND', get label() { return m.cbx_status_dnd(); }, dot: 'bg-red-500' },
    { value: 'INVISIBLE', get label() { return m.cbx_status_invisible(); }, dot: 'bg-gray-500' },
  ];

  const activityOptions = [
    { value: 'NONE', get label() { return m.cbx_activity_none(); } },
    { value: 'PLAYING', get label() { return m.cbx_activity_playing(); } },
    { value: 'STREAMING', get label() { return m.cbx_activity_streaming(); } },
    { value: 'LISTENING', get label() { return m.cbx_activity_listening(); } },
    { value: 'WATCHING', get label() { return m.cbx_activity_watching(); } },
    { value: 'COMPETING', get label() { return m.cbx_activity_competing(); } },
  ];

  const ownBotOn = $derived(Boolean(config?.enabled));
  const hasToken = $derived(Boolean(config?.botToken));
  const isRunning = $derived(Boolean(config?.isRunning));
  const previewName = $derived(draft.botName || connectedBot?.username || (ownBotOn ? m.cbx_name_ph() : 'Kotbo'));
  const previewAvatar = $derived(draft.botAvatarUrl || connectedBot?.avatar || '');
  const statusDot = $derived(statusOptions.find((o) => o.value === draft.botStatus)?.dot ?? 'bg-emerald-500');
  const activityLabel = $derived(
    ownBotOn && draft.activityType !== 'NONE' && draft.activityText
      ? `${activityOptions.find((o) => o.value === draft.activityType)?.label ?? ''} ${draft.activityText}`
      : '',
  );

  const domain = $derived(config?.domain ?? null);
  const savedHost = $derived(config?.customDashboardUrl ?? '');
  const hostChanged = $derived(draft.customDashboardUrl.trim().toLowerCase() !== savedHost);
  const oauthReady = $derived(Boolean(config?.botClientId && config?.botClientSecret));
  const domainState = $derived(
    !savedHost ? 'none'
      : !config?.customDomainVerifiedAt ? 'dns'
      : !oauthReady ? 'oauth'
      : domain?.active ? 'active'
      : 'syncing',
  );
  const ownInviteUrl = $derived(inviteUrl(config?.botClientId || connectedBot?.id));
  const kotboInviteUrl = $derived(inviteUrl(ownBot?.kotboClientId));

  const steps = $derived([
    { key: 'token', title: m.cbd_s_token(), done: hasToken },
    { key: 'start', title: m.cbd_s_start(), done: isRunning },
    { key: 'domain', title: `${m.cbd_s_domain()} (${m.cbd_optional()})`, done: domainState === 'active' },
    { key: 'invite', title: m.cbd_s_invite(), done: Boolean(ownBot?.botInGuild) },
    { key: 'switch', title: m.cbd_s_switch(), done: Boolean(ownBot?.switched) },
  ]);
  // L'etape ouverte est la premiere qui reste a faire.
  const currentStep = $derived(steps.find((s) => !s.done)?.key ?? 'switch');
</script>

<svelte:window onfocus={onWindowFocus} />

{#snippet stepCard(index: number, key: string, title: string, done: boolean, body: Snippet)}
  <li class="rounded-lg border {currentStep === key ? 'border-primary/40 bg-primary/5' : 'border-outline-variant'} p-4">
    <div class="flex items-center gap-3">
      <span class="w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 {done ? 'bg-success text-on-primary' : 'bg-surface-container-high text-on-surface'}">
        {#if done}<Papicon icon="check" size={12} />{:else}{index}{/if}
      </span>
      <span class="text-sm font-medium text-on-surface">{title}</span>
      {#if done}<span class="sr-only">{m.cbd_step_done()}</span>{/if}
    </div>
    {#if currentStep === key || !done}
      <div class="mt-3 pl-9 space-y-3">{@render body()}</div>
    {/if}
  </li>
{/snippet}

<ModulePage title={m.cbx_title()} description={m.cbx_desc()} icon="bot">
  {#snippet actions()}
    {#if config && allowed && ownBotOn && hasToken}
      <div class="flex items-center flex-wrap md:justify-end gap-3">
        <span class="flex items-center gap-2 text-sm {isRunning ? 'text-success' : 'text-on-surface-variant'}" role="status">
          <span class="w-2 h-2 rounded-full {isRunning ? 'bg-success' : 'bg-on-surface-variant'}"></span>
          {isRunning ? m.cbx_status_online() : m.cbx_offline()}
        </span>
        {#if isRunning}
          <Button icon="refresh-cw" onclick={start} loading={busy}>{m.cbd_restart()}</Button>
          {#if !ownBot?.switched}
            <Button variant="danger" onclick={stop} disabled={busy}>{m.cbx_stop()}</Button>
          {/if}
        {:else}
          <Button variant="primary" icon="play" onclick={start} loading={busy}>{m.cbx_start()}</Button>
        {/if}
      </div>
    {/if}
  {/snippet}

  <div class="space-y-6 max-w-5xl">
    {#if loading}
      <LoadingHint context="config" />
    {:else if !allowed}
      <Callout variant="info" icon="Lock" title={m.cbx_plan_locked()}>
        {#if runningWithoutPlan}{m.cbx_running_without_plan()}{/if}
        {#snippet actions()}
          <Button href="/billing" variant="primary" size="sm">{m.cbd_see_plans()}</Button>
          {#if runningWithoutPlan}
            <Button variant="danger" size="sm" onclick={stop} loading={busy}>{m.cbx_stop()}</Button>
          {/if}
        {/snippet}
      </Callout>
    {:else}
      {#if config?.lastError}
        <Callout variant="danger" title={m.cbx_last_error()}>
          <span class="font-mono text-xs break-words">{config.lastError}</span>
          {#snippet actions()}
            <Button
              href={`https://discord.com/developers/applications${config?.botClientId ? `/${config.botClientId}/bot` : ''}`}
              target="_blank"
              variant="ghost"
              size="sm"
              iconRight="external-link"
            >{m.cbd_open_portal()}</Button>
            {#if ownBotOn && hasToken}
              <Button size="sm" icon="refresh-cw" onclick={start} loading={busy}>{m.common_retry()}</Button>
            {/if}
          {/snippet}
        </Callout>
      {/if}
      {#if config?.secretsUnreadable}
        <Callout variant="warning">{m.cbx_secrets_unreadable()}</Callout>
      {/if}

      <!-- 1. Profil : sur Kotbo pour ce serveur, ou sur le bot du serveur -->
      <section class="section-card p-5" aria-labelledby="cb-profile-title">
        <h2 id="cb-profile-title" class="text-sm font-semibold text-on-surface flex items-center gap-2">
          <Papicon icon="user" size={14} class="text-primary" />
          {m.cbx_profile()}
        </h2>
        <p class="text-xs text-on-surface-variant mt-1 mb-4">{ownBotOn ? m.cbd_profile_desc_own() : m.cbd_profile_desc_kotbo()}</p>

        <div class="grid gap-6 lg:grid-cols-[1fr_300px]">
          <div class="space-y-4">
            <Field label={m.cbx_name()} hint={ownBotOn ? '' : m.cbd_name_hint_kotbo()}>
              {#snippet children(id, describedBy)}
                <input {id} aria-describedby={describedBy} bind:value={draft.botName} placeholder={m.cbx_name_ph()} maxlength={32} class="input" />
              {/snippet}
            </Field>
            <div class="grid gap-4 sm:grid-cols-2">
              <ImagePicker label={m.cbx_avatar()} shape="avatar" bind:value={draft.botAvatarUrl} />
              <ImagePicker label={m.cbx_banner()} shape="banner" bind:value={draft.botBannerUrl} />
            </div>
            <Field label={m.cbx_bio()} hint={m.cbx_bio_count({ count: draft.botBio.length, max: BIO_MAX })}>
              {#snippet children(id, describedBy)}
                <textarea {id} aria-describedby={describedBy} bind:value={draft.botBio} placeholder={m.cbx_bio_ph()} maxlength={BIO_MAX} rows={3} class="input resize-none"></textarea>
              {/snippet}
            </Field>

            {#if ownBotOn}
              <fieldset>
                <legend class="text-xs font-medium text-on-surface-variant mb-1.5">{m.cbx_status()}</legend>
                <div class="flex flex-wrap gap-2">
                  {#each statusOptions as opt}
                    <button
                      type="button"
                      aria-pressed={draft.botStatus === opt.value}
                      onclick={() => (draft.botStatus = opt.value)}
                      class="flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm transition-colors
                        {draft.botStatus === opt.value ? 'border-primary bg-primary/10 text-on-surface' : 'border-outline-variant text-on-surface-variant hover:text-on-surface'}"
                    >
                      <span class="w-2.5 h-2.5 rounded-full {opt.dot}"></span>
                      {opt.label}
                    </button>
                  {/each}
                </div>
              </fieldset>

              <div class="grid gap-4 sm:grid-cols-[180px_1fr]">
                <Field label={m.cbx_activity_type()}>
                  {#snippet children(id, describedBy)}
                    <select {id} aria-describedby={describedBy} bind:value={draft.activityType} class="input">
                      {#each activityOptions as opt}
                        <option value={opt.value}>{opt.label}</option>
                      {/each}
                    </select>
                  {/snippet}
                </Field>
                {#if draft.activityType !== 'NONE'}
                  <Field label={m.cbx_activity_text()}>
                    {#snippet children(id, describedBy)}
                      <input {id} aria-describedby={describedBy} bind:value={draft.activityText} placeholder="/help" maxlength={128} class="input" />
                    {/snippet}
                  </Field>
                {/if}
              </div>
              {#if draft.activityType === 'STREAMING'}
                <Field label={m.cbx_stream_url()}>
                  {#snippet children(id, describedBy)}
                    <input {id} aria-describedby={describedBy} bind:value={draft.activityUrl} type="url" placeholder="https://twitch.tv/..." class="input" />
                  {/snippet}
                </Field>
              {/if}
            {/if}
          </div>

          <!-- Apercu facon carte de profil Discord -->
          <div class="lg:sticky lg:top-4 self-start" aria-label={m.cbd_preview()}>
            <p class="text-xs font-medium text-on-surface-variant mb-1.5">{m.cbd_preview()}</p>
            <div class="rounded-xl overflow-hidden border border-outline-variant bg-surface-container">
              <div class="h-24 bg-primary/30">
                {#if draft.botBannerUrl}
                  <img src={draft.botBannerUrl} alt="" class="w-full h-full object-cover" />
                {/if}
              </div>
              <div class="px-4 pb-4">
                <div class="relative -mt-10 mb-2 w-20 h-20">
                  <div class="w-20 h-20 rounded-full border-4 border-surface-container bg-surface-container-high overflow-hidden flex items-center justify-center">
                    {#if previewAvatar}
                      <img src={previewAvatar} alt="" class="w-full h-full object-cover" />
                    {:else}
                      <Papicon icon="bot" size={28} class="text-on-surface-variant" />
                    {/if}
                  </div>
                  <span class="absolute bottom-1 right-1 w-4 h-4 rounded-full border-2 border-surface-container {ownBotOn ? statusDot : 'bg-emerald-500'}"></span>
                </div>
                <div class="flex items-center gap-1.5">
                  <span class="font-semibold text-on-surface truncate">{previewName}</span>
                  <span class="text-2xs font-semibold px-1 rounded bg-primary text-on-primary">APP</span>
                </div>
                {#if activityLabel}
                  <p class="text-xs text-on-surface-variant mt-1 truncate">{activityLabel}</p>
                {/if}
                {#if draft.botBio}
                  <p class="text-xs text-on-surface mt-3 whitespace-pre-line break-words">{draft.botBio}</p>
                {/if}
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- 2. Ton propre bot : option, puis parcours guide -->
      <section class="section-card p-5 space-y-4" aria-labelledby="cb-own-title">
        <div class="flex items-start justify-between gap-4">
          <div>
            <h2 id="cb-own-title" class="text-sm font-semibold text-on-surface flex items-center gap-2">
              <Papicon icon="bot" size={14} class="text-primary" />
              {m.cbd_own_title()}
            </h2>
            <p class="text-xs text-on-surface-variant mt-1 max-w-prose">{m.cbd_own_desc()}</p>
          </div>
          <ToggleSwitch size="lg" checked={ownBotOn} disabled={busy || Boolean(ownBot?.switched)} ariaLabel={m.cbd_own_title()} onToggle={toggleOwnBot} />
        </div>

        {#if ownBotOn && ownBot?.switched}
          <Callout variant="success" title={m.cbd_switched_title()}>
            {m.cbd_switched_desc()}
            {#snippet actions()}
              <Button size="sm" variant="secondary" href={kotboInviteUrl} target="_blank" iconRight="external-link">{m.cbd_invite_kotbo()}</Button>
              <Button size="sm" variant="danger" onclick={revert} loading={busy}>{m.cbd_revert_action()}</Button>
            {/snippet}
          </Callout>
          {#if !ownBot.kotboInGuild}
            <p class="text-xs text-on-surface-variant">{m.cbd_revert_hint()}</p>
          {/if}
        {:else if ownBotOn}
          <ol class="space-y-3">
            {#snippet tokenBody()}
              <p class="text-xs text-on-surface-variant">{m.cbd_step_bot_desc()}</p>
              {#if hasToken && !replacingToken}
                <div class="flex flex-wrap items-center gap-3 px-4 py-3 bg-success/5 border border-success/20 rounded-lg">
                  <span class="w-2 h-2 rounded-full bg-success"></span>
                  <span class="text-sm text-on-surface">{m.cbx_configured()}</span>
                  <span class="text-xs text-on-surface-variant font-mono">{config?.botToken}</span>
                  <Button variant="ghost" size="sm" class="ml-auto" onclick={() => (replacingToken = true)}>{m.cbd_replace_token()}</Button>
                </div>
              {:else}
                <form class="flex flex-col sm:flex-row gap-2" onsubmit={(e) => { e.preventDefault(); void connectToken(); }}>
                  <div class="relative flex-1">
                    <input
                      bind:value={tokenInput}
                      type={showToken ? 'text' : 'password'}
                      autocomplete="off"
                      aria-label={m.cbx_token_title()}
                      placeholder={m.cbx_token_ph()}
                      class="input font-mono pr-10"
                    />
                    <button
                      type="button"
                      onclick={() => (showToken = !showToken)}
                      aria-label={showToken ? m.cbx_hide_token() : m.cbx_show_token()}
                      class="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface"
                    >
                      <Papicon icon={showToken ? 'eye-off' : 'eye'} size={14} />
                    </button>
                  </div>
                  <Button type="submit" variant="primary" loading={connecting} disabled={!tokenInput.trim()} disabledReason={m.common_reason_fill_field()}>{m.cbd_connect()}</Button>
                  {#if replacingToken}
                    <Button variant="ghost" onclick={() => { replacingToken = false; tokenInput = ''; }}>{m.cbd_cancel()}</Button>
                  {/if}
                </form>
                <Button href="https://discord.com/developers/applications" target="_blank" variant="ghost" size="sm" iconRight="external-link">{m.cbd_open_portal()}</Button>
              {/if}
            {/snippet}
            {@render stepCard(1, 'token', steps[0].title, steps[0].done, tokenBody)}

            {#snippet startBody()}
              <p class="text-xs text-on-surface-variant">{m.cbd_s_start_desc()}</p>
              {#if !isRunning}
                <Button variant="primary" icon="play" onclick={start} loading={busy} disabled={!hasToken} disabledReason={m.cbd_start_needs_token()}>{m.cbx_start()}</Button>
              {/if}
            {/snippet}
            {@render stepCard(2, 'start', steps[1].title, steps[1].done, startBody)}

            {#snippet domainBody()}
              <p class="text-xs text-on-surface-variant">{m.cbd_s_domain_desc()}</p>
              <Button size="sm" variant="secondary" href="#cb-domain-title" icon="arrow-down">{m.cbd_go_domain()}</Button>
            {/snippet}
            {@render stepCard(3, 'domain', steps[2].title, steps[2].done, domainBody)}

            {#snippet inviteBody()}
              <p class="text-xs text-on-surface-variant">{m.cbd_s_invite_desc()}</p>
              <div class="flex flex-wrap gap-2">
                <Button variant="primary" href={ownInviteUrl} target="_blank" iconRight="external-link" disabled={!ownInviteUrl} disabledReason={m.cbd_start_needs_token()}>{m.cbd_invite_own()}</Button>
                <Button icon="refresh-cw" onclick={checkInvite} loading={checkingInvite}>{m.cbd_invite_check()}</Button>
              </div>
            {/snippet}
            {@render stepCard(4, 'invite', steps[3].title, steps[3].done, inviteBody)}

            {#snippet switchBody()}
              <p class="text-xs text-on-surface-variant">{m.cbd_s_switch_desc()}</p>
              <Button
                variant="danger"
                onclick={switchBot}
                loading={busy}
                disabled={!steps.slice(0, 4).filter((s) => s.key !== 'domain').every((s) => s.done)}
                disabledReason={m.cbd_switch_needs_steps()}
              >{m.cbd_switch_action()}</Button>
            {/snippet}
            {@render stepCard(5, 'switch', steps[4].title, steps[4].done, switchBody)}
          </ol>
        {/if}
      </section>

      <!-- 3. Dashboard sur le domaine du serveur -->
      <section class="section-card p-5 space-y-5" aria-labelledby="cb-domain-title">
        <div class="flex items-start justify-between gap-3">
          <div>
            <h2 id="cb-domain-title" class="text-sm font-semibold text-on-surface flex items-center gap-2 scroll-mt-4">
              <Papicon icon="globe" size={14} class="text-primary" />
              {m.cbx_custom_dashboard()}
            </h2>
            <p class="text-xs text-on-surface-variant mt-1">{m.cbx_custom_dashboard_desc()}</p>
          </div>
          {#if domainState === 'active'}
            <Button href={`https://${savedHost}`} target="_blank" variant="primary" size="sm" iconRight="external-link">{m.cbd_open_dashboard()}</Button>
          {/if}
        </div>

        {#if !domain?.target}
          <Callout variant="info">{m.cbd_domain_unavailable()}</Callout>
        {:else}
          {#if domainState === 'active'}
            <Callout variant="success" title={m.cbd_state_active({ host: savedHost })}>{m.cbd_state_active_desc()}</Callout>
          {:else if domainState === 'syncing'}
            <Callout variant="info">{m.cbd_state_syncing()}</Callout>
          {/if}

          <ol class="space-y-5">
            <li class="space-y-2">
              <p class="text-xs font-semibold text-on-surface">{m.cbd_domain_step_host()}</p>
              <Field label={m.cbd_domain_label()} hint={hostChanged && savedHost ? m.cbd_domain_change_hint() : ''}>
                {#snippet children(id, describedBy)}
                  <input {id} aria-describedby={describedBy} bind:value={draft.customDashboardUrl} placeholder={m.cbx_custom_dashboard_ph()} autocomplete="off" spellcheck="false" class="input font-mono" />
                {/snippet}
              </Field>
            </li>

            <li class="space-y-2">
              <p class="text-xs font-semibold text-on-surface">{m.cbd_domain_step_dns()}</p>
              {#if !savedHost || hostChanged}
                <p class="text-xs text-on-surface-variant">{m.cbd_domain_save_first()}</p>
              {:else}
                <p class="text-xs text-on-surface-variant">{m.cbd_dns_desc()}</p>
                <div class="overflow-x-auto">
                  <table class="w-full text-xs">
                    <thead>
                      <tr class="text-left text-on-surface-variant">
                        <th class="py-1.5 pr-3 font-medium">{m.cbd_dns_type()}</th>
                        <th class="py-1.5 pr-3 font-medium">{m.cbd_dns_name()}</th>
                        <th class="py-1.5 pr-3 font-medium">{m.cbd_dns_value()}</th>
                        <th class="py-1.5 font-medium"><span class="sr-only">{m.cbd_dns_check()}</span></th>
                      </tr>
                    </thead>
                    <tbody class="font-mono">
                      {#each [
                        { type: 'CNAME', name: savedHost, value: domain.target, ok: dnsChecks?.pointing },
                        { type: 'TXT', name: domain.verification?.name ?? '', value: domain.verification?.value ?? '', ok: dnsChecks?.txt },
                      ] as record}
                        <tr class="border-t border-outline-variant align-middle">
                          <td class="py-2 pr-3 text-on-surface">{record.type}</td>
                          <td class="py-2 pr-3 text-on-surface break-all">
                            <span class="inline-flex items-center gap-1">
                              {record.name}
                              <Button variant="ghost" size="sm" icon="copy" aria-label={m.common_copy()} onclick={() => copy(record.name)} />
                            </span>
                          </td>
                          <td class="py-2 pr-3 text-on-surface break-all">
                            <span class="inline-flex items-center gap-1">
                              {record.value}
                              <Button variant="ghost" size="sm" icon="copy" aria-label={m.common_copy()} onclick={() => copy(record.value)} />
                            </span>
                          </td>
                          <td class="py-2 font-sans">
                            {#if record.ok === true}
                              <span class="text-success">{m.cbd_dns_ok()}</span>
                            {:else if record.ok === false}
                              <span class="text-error">{m.cbd_dns_missing()}</span>
                            {/if}
                          </td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
                <p class="text-2xs text-on-surface-variant">{m.cbd_dns_cloudflare()}</p>
                <div class="flex flex-wrap items-center gap-3">
                  <Button onclick={verifyDomain} loading={verifying} icon="search">{m.cbd_dns_check()}</Button>
                  {#if config?.customDomainVerifiedAt}
                    <span class="text-xs text-success flex items-center gap-1"><Papicon icon="check" size={12} />{m.cbd_domain_verified_short()}</span>
                  {/if}
                </div>
              {/if}
            </li>

            <li class="space-y-3">
              <p class="text-xs font-semibold text-on-surface">{m.cbd_domain_step_oauth()}</p>
              <p class="text-xs text-on-surface-variant">{m.cbx_oauth_desc()}</p>
              {#if domain.redirectUri && !hostChanged}
                <div class="flex flex-wrap items-center gap-2 text-xs">
                  <span class="text-on-surface-variant">{m.cbd_redirect_uri()}</span>
                  <code class="font-mono text-on-surface break-all">{domain.redirectUri}</code>
                  <Button variant="ghost" size="sm" icon="copy" aria-label={m.common_copy()} onclick={() => copy(domain.redirectUri ?? '')} />
                </div>
              {/if}
              <div class="grid gap-4 sm:grid-cols-2">
                <Field label="Client ID">
                  {#snippet children(id, describedBy)}
                    <input {id} aria-describedby={describedBy} bind:value={draft.botClientId} placeholder={m.cbx_client_id_ph()} autocomplete="off" class="input font-mono" />
                  {/snippet}
                </Field>
                <Field label="Client Secret">
                  {#snippet children(id, describedBy)}
                    <input
                      {id}
                      aria-describedby={describedBy}
                      bind:value={draft.botClientSecret}
                      type="password"
                      autocomplete="off"
                      placeholder={config?.botClientSecret ? m.cbx_secret_set({ value: config.botClientSecret }) : m.cbx_secret_ph()}
                      class="input font-mono"
                    />
                  {/snippet}
                </Field>
              </div>
            </li>
          </ol>
        {/if}
      </section>
    {/if}
  </div>
</ModulePage>
