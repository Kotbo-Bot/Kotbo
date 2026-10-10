<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import {
    fetchCustomBotConfig,
    updateCustomBotConfig,
    validateCustomBotToken,
    startCustomBot,
    stopCustomBot,
  } from '../lib/api';
  import Papicon from '../lib/components/Papicon.svelte';

  import { errorMessage } from '@kotbo/shared';
  let config = $state<any>(null);
  let allowed = $state(true);
  let runningWithoutPlan = $state(false);
  let loading = $state(true);
  let saving = $state(false);
  let validating = $state(false);
  let validatedBot = $state<{ id: string; username: string; avatar: string | null } | null>(null);
  let tokenInput = $state('');
  let showToken = $state(false);

  // Form fields
  let enabled = $state(false);
  let botClientId = $state('');
  let botClientSecret = $state('');
  let botName = $state('');
  let botAvatarUrl = $state('');
  let botBannerUrl = $state('');
  let botBio = $state('');
  let botStatus = $state('ONLINE');
  let activityType = $state('NONE');
  let activityText = $state('');
  let activityUrl = $state('');
  let customDashboardUrl = $state('');

  async function loadConfig() {
    try {
      const data = await fetchCustomBotConfig();
      allowed = data?.allowed !== false;
      runningWithoutPlan = !allowed && data?.isRunning === true;
      config = data?.config ?? null;
      if (!config) return;
      enabled = config.enabled;
      botClientId = config.botClientId || '';
      // Jamais prérempli : le serveur ne renvoie qu'une version masquée, et
      // l'enregistrer telle quelle écrasait le vrai secret.
      botClientSecret = '';
      botName = config.botName || '';
      botAvatarUrl = config.botAvatarUrl || '';
      botBannerUrl = config.botBannerUrl || '';
      botBio = config.botBio || '';
      botStatus = config.botStatus || 'ONLINE';
      activityType = config.activityType || 'NONE';
      activityText = config.activityText || '';
      activityUrl = config.activityUrl || '';
      customDashboardUrl = config.customDashboardUrl || '';
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      loading = false;
    }
  }

  onMount(loadConfig);

  async function handleValidateToken() {
    if (!tokenInput.trim()) {
      toast.error('Saisis un token de bot');
      return;
    }
    validating = true;
    try {
      const result = await validateCustomBotToken(tokenInput.trim());
      if (result.valid) {
        validatedBot = result.bot;
        toast.success(`Token valide - Bot: ${result.bot.username} (${result.bot.id})`);
      } else {
        validatedBot = null;
        toast.error(result.error || 'Token invalide');
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      validating = false;
    }
  }

  async function handleSaveToken() {
    if (!tokenInput.trim()) return;
    saving = true;
    try {
      await updateCustomBotConfig({ botToken: tokenInput.trim() });
      toast.success('Token enregistre');
      await loadConfig();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      saving = false;
    }
  }

  async function handleSave() {
    saving = true;
    try {
      await updateCustomBotConfig({
        enabled,
        botClientId: botClientId || null,
        // Laissé vide, le secret enregistré est conservé.
        ...(botClientSecret.trim() ? { botClientSecret: botClientSecret.trim() } : {}),
        botName: botName || null,
        botAvatarUrl: botAvatarUrl || null,
        botBannerUrl: botBannerUrl || null,
        botBio: botBio || null,
        botStatus,
        activityType,
        activityText: activityText || null,
        activityUrl: activityUrl || null,
        customDashboardUrl: customDashboardUrl || null,
      });
      botClientSecret = '';
      toast.success('Configuration sauvegardee');
      await loadConfig();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      saving = false;
    }
  }

  async function handleStart() {
    try {
      await startCustomBot();
      toast.success('Bot en cours de demarrage...');
      await loadConfig();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function handleStop() {
    try {
      await stopCustomBot();
      toast.success('Bot arrete');
      await loadConfig();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const statusOptions = [
    { value: 'ONLINE', label: 'En ligne', color: 'bg-emerald-500' },
    { value: 'IDLE', label: 'Inactif', color: 'bg-amber-500' },
    { value: 'DND', label: 'Ne pas deranger', color: 'bg-red-500' },
    { value: 'INVISIBLE', label: 'Invisible', color: 'bg-gray-500' },
  ];

  const activityOptions = [
    { value: 'NONE', label: 'Aucune' },
    { value: 'PLAYING', label: 'Joue a' },
    { value: 'STREAMING', label: 'Streame' },
    { value: 'LISTENING', label: 'Ecoute' },
    { value: 'WATCHING', label: 'Regarde' },
    { value: 'COMPETING', label: 'Participe a' },
  ];
</script>

<div class="space-y-6 max-w-4xl">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-3">
      <div class="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
        <Papicon icon="bot" size={20} class="text-primary" />
      </div>
      <div>
        <h2 class="text-xl font-semibold text-on-surface">Custom Bot</h2>
        <p class="text-sm text-on-surface-variant">Lance ton propre bot avec les fonctionnalités Kotbo</p>
      </div>
    </div>

    {#if config}
      <div class="flex items-center gap-3">
        {#if config.isRunning}
          <div class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-success/10 border border-success/20">
            <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            <span class="text-xs font-medium text-success">En ligne</span>
          </div>
          <button onclick={handleStop} class="px-3 py-1.5 bg-error/10 text-error rounded-lg text-sm font-medium hover:bg-error/20 transition-colors">
            Arreter
          </button>
        {:else}
          <div class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-500/10 border border-gray-500/20">
            <span class="w-2 h-2 rounded-full bg-gray-500"></span>
            <span class="text-xs font-medium text-on-surface-variant">Hors ligne</span>
          </div>
          <button
            onclick={handleStart}
            disabled={!config.botToken || !config.enabled}
            class="px-3 py-1.5 bg-emerald-500 text-white rounded-lg text-sm font-medium hover:bg-emerald-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Demarrer
          </button>
        {/if}
      </div>
    {/if}
  </div>

  {#if loading}
    <div class="flex items-center justify-center py-16">
      <div class="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full"></div>
    </div>
  {:else if !allowed}
    <div class="section-card p-5 text-sm text-on-surface-variant">
      Le bot personnalisé est réservé à l'offre sur mesure. Contacte l'équipe Kotbo pour l'activer sur ce serveur.
      {#if runningWithoutPlan}
        <div class="flex items-center justify-between gap-3 mt-3">
          <span>Un bot personnalise lance auparavant tourne encore.</span>
          <button onclick={handleStop} class="px-3 py-1.5 bg-error/10 text-error rounded-lg text-sm font-medium hover:bg-error/20 transition-colors">
            Arreter
          </button>
        </div>
      {/if}
    </div>
  {:else}
    {#if config?.secretsUnreadable}
      <div class="section-card p-4 border-warning/30 bg-warning/5 text-xs text-warning">
        Un secret enregistre est illisible (cle de chiffrement changee). Ressaisissez le token et le client secret.
      </div>
    {/if}
    <!-- Enable toggle -->
    <div class="section-card p-4">
      <div class="flex items-center justify-between">
        <div>
          <span class="font-medium text-on-surface">Activer le Custom Bot</span>
          <p class="text-xs text-on-surface-variant mt-0.5">Lance ta propre instance de bot Discord avec tes identifiants</p>
        </div>
        <label class="relative inline-flex items-center cursor-pointer">
          <input type="checkbox" bind:checked={enabled} onchange={() => updateCustomBotConfig({ enabled })} class="sr-only peer" />
          <div class="w-11 h-6 bg-surface-container-highest rounded-full peer-checked:bg-primary transition-colors after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full"></div>
        </label>
      </div>
    </div>

    <!-- Bot Token -->
    <div class="section-card p-5 space-y-4">
      <h3 class="text-sm font-semibold text-on-surface flex items-center gap-2">
        <Papicon icon="key" size={14} class="text-primary" />
        Token du Bot
      </h3>

      {#if config?.botToken}
        <div class="flex items-center gap-3 px-4 py-3 bg-success/5 border border-success/20 rounded-lg">
          <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
          <span class="text-sm text-on-surface font-mono">{config.botToken}</span>
          <span class="text-xs text-success ml-auto">Configure</span>
        </div>
      {/if}

      <div class="flex gap-2">
        <div class="relative flex-1">
          <input
            bind:value={tokenInput}
            type={showToken ? 'text' : 'password'}
            placeholder="Colle le token de ton bot Discord ici..."
            class="w-full px-4 py-2.5 bg-surface-container border border-outline-variant rounded-lg text-sm text-on-surface font-mono pr-10"
          />
          <button
            onclick={() => showToken = !showToken}
            class="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface"
          >
            <Papicon icon={showToken ? 'eye-off' : 'eye'} size={14} />
          </button>
        </div>
        <button
          onclick={handleValidateToken}
          disabled={validating || !tokenInput.trim()}
          class="px-4 py-2.5 bg-surface-container border border-outline-variant rounded-lg text-sm font-medium text-on-surface hover:bg-surface-container-high transition-colors disabled:opacity-50"
        >
          {validating ? 'Test...' : 'Tester'}
        </button>
        <button
          onclick={handleSaveToken}
          disabled={saving || !tokenInput.trim()}
          class="px-4 py-2.5 bg-primary text-on-primary rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          Sauvegarder
        </button>
      </div>

      {#if validatedBot}
        <div class="flex items-center gap-3 p-3 bg-surface-container rounded-lg">
          {#if validatedBot.avatar}
            <img src={validatedBot.avatar} alt={validatedBot.username} class="w-10 h-10 rounded-full" />
          {:else}
            <div class="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
              <Papicon icon="bot" size={18} class="text-primary" />
            </div>
          {/if}
          <div>
            <span class="font-medium text-on-surface">{validatedBot.username}</span>
            <span class="text-xs text-on-surface-variant block font-mono">{validatedBot.id}</span>
          </div>
        </div>
      {/if}
    </div>

    <!-- Bot Profile Customization -->
    <div class="section-card p-5 space-y-4">
      <h3 class="text-sm font-semibold text-on-surface flex items-center gap-2">
        <Papicon icon="user" size={14} class="text-primary" />
        Profil du Bot
      </h3>

      <!-- Banner -->
      <div>
        <label for="bot-banner-url" class="text-xs text-on-surface-variant block mb-1.5 font-medium">Banniere</label>
        {#if botBannerUrl}
          <div class="relative rounded-xl overflow-hidden mb-2">
            <img src={botBannerUrl} alt="Banner" class="w-full h-32 object-cover" />
          </div>
        {/if}
        <input
          id="bot-banner-url"
          bind:value={botBannerUrl}
          placeholder="URL de la banniere..."
          class="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded-lg text-sm text-on-surface"
        />
      </div>

      <div class="grid grid-cols-[auto_1fr] gap-4">
        <!-- Avatar -->
        <div>
          <label for="bot-avatar-url" class="text-xs text-on-surface-variant block mb-1.5 font-medium">Avatar</label>
          <div class="w-24 h-24 rounded-xl bg-surface-container border-2 border-dashed border-outline-variant flex items-center justify-center overflow-hidden">
            {#if botAvatarUrl}
              <img src={botAvatarUrl} alt="Avatar" class="w-full h-full object-cover" />
            {:else}
              <Papicon icon="image" size={24} class="text-on-surface-variant/40" />
            {/if}
          </div>
          <input
            id="bot-avatar-url"
            bind:value={botAvatarUrl}
            placeholder="URL..."
            class="w-24 mt-1.5 px-2 py-1 bg-surface-container border border-outline-variant rounded text-2xs text-on-surface truncate"
          />
        </div>

        <!-- Name + Bio -->
        <div class="space-y-3">
          <div>
            <label for="bot-name" class="text-xs text-on-surface-variant block mb-1.5 font-medium">Nom</label>
            <input
              id="bot-name"
              bind:value={botName}
              placeholder="Nom du bot..."
              class="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded-lg text-sm text-on-surface"
            />
          </div>
          <div>
            <label for="bot-bio" class="text-xs text-on-surface-variant block mb-1.5 font-medium">Bio</label>
            <textarea
              id="bot-bio"
              bind:value={botBio}
              placeholder="Saisis la bio..."
              maxlength={190}
              rows={3}
              class="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded-lg text-sm text-on-surface resize-none"
            ></textarea>
            <span class="text-2xs text-on-surface-variant">{botBio.length}/190 caracteres</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Status & Activity -->
    <div class="section-card p-5 space-y-4">
      <h3 class="text-sm font-semibold text-on-surface flex items-center gap-2">
        <Papicon icon="activity" size={14} class="text-primary" />
        Statut & Activite
      </h3>

      <!-- Status -->
      <div>
        <label for="bot-status" class="text-xs text-on-surface-variant block mb-1.5 font-medium">Statut</label>
        <div class="relative">
          <select
            id="bot-status"
            bind:value={botStatus}
            class="w-full px-3 py-2.5 bg-surface-container border border-outline-variant rounded-lg text-sm text-on-surface appearance-none pr-8"
          >
            {#each statusOptions as opt}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
          <div class="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">
            <span class="w-2.5 h-2.5 rounded-full inline-block {statusOptions.find(o => o.value === botStatus)?.color || 'bg-emerald-500'}"></span>
          </div>
        </div>
      </div>

      <!-- Activity -->
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label for="activity-type" class="text-xs text-on-surface-variant block mb-1.5 font-medium">Type d'activite</label>
          <select
            id="activity-type"
            bind:value={activityType}
            class="w-full px-3 py-2.5 bg-surface-container border border-outline-variant rounded-lg text-sm text-on-surface appearance-none"
          >
            {#each activityOptions as opt}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
        </div>
        <div>
          <label for="activity-text" class="text-xs text-on-surface-variant block mb-1.5 font-medium">Texte d'activite</label>
          <input
            id="activity-text"
            bind:value={activityText}
            placeholder="/help"
            disabled={activityType === 'NONE'}
            class="w-full px-3 py-2.5 bg-surface-container border border-outline-variant rounded-lg text-sm text-on-surface disabled:opacity-50"
          />
        </div>
      </div>

      {#if activityType === 'STREAMING'}
        <div>
          <label for="activity-url" class="text-xs text-on-surface-variant block mb-1.5 font-medium">URL du stream</label>
          <input
            id="activity-url"
            bind:value={activityUrl}
            placeholder="https://twitch.tv/..."
            class="w-full px-3 py-2.5 bg-surface-container border border-outline-variant rounded-lg text-sm text-on-surface"
          />
        </div>
      {/if}
    </div>

    <!-- Custom Dashboard URL -->
    <div class="section-card p-5 space-y-3">
      <h3 class="text-sm font-semibold text-on-surface flex items-center gap-2">
        <Papicon icon="globe" size={14} class="text-primary" />
        Dashboard Personnalise
      </h3>
      <p class="text-xs text-on-surface-variant">Redirige ton dashboard vers une URL personnalisée</p>
      <input
        bind:value={customDashboardUrl}
        placeholder="https://panel.monserveur.fr"
        class="w-full px-3 py-2.5 bg-surface-container border border-outline-variant rounded-lg text-sm text-on-surface"
      />
    </div>

    <!-- OAuth Credentials (optional) -->
    <div class="section-card p-5 space-y-3">
      <h3 class="text-sm font-semibold text-on-surface flex items-center gap-2">
        <Papicon icon="shield" size={14} class="text-primary" />
        OAuth (optionnel)
      </h3>
      <p class="text-xs text-on-surface-variant">Nécessaire uniquement si tu utilises un dashboard personnalisé avec connexion</p>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label for="bot-client-id" class="text-xs text-on-surface-variant block mb-1">Client ID</label>
          <input
            id="bot-client-id"
            bind:value={botClientId}
            placeholder="Client ID Discord..."
            class="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded-lg text-sm text-on-surface font-mono"
          />
        </div>
        <div>
          <label for="bot-client-secret" class="text-xs text-on-surface-variant block mb-1">Client Secret</label>
          <input
            id="bot-client-secret"
            bind:value={botClientSecret}
            type="password"
            placeholder={config?.botClientSecret ? `Configure (${config.botClientSecret}), laisser vide pour conserver` : 'Client Secret...'}
            class="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded-lg text-sm text-on-surface font-mono"
          />
        </div>
      </div>
    </div>

    <!-- Save button -->
    <div class="flex justify-end">
      <button
        onclick={handleSave}
        disabled={saving}
        class="px-6 py-2.5 bg-primary text-on-primary rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-2"
      >
        {#if saving}
          <div class="animate-spin w-4 h-4 border-2 border-on-primary border-t-transparent rounded-full"></div>
        {/if}
        Sauvegarder les modifications
      </button>
    </div>

    <!-- Error display -->
    {#if config?.lastError}
      <div class="section-card p-4 border-error/30 bg-error/5">
        <div class="flex items-center gap-2 mb-1">
          <Papicon icon="alert-triangle" size={14} class="text-error" />
          <span class="text-sm font-medium text-error">Derniere erreur</span>
        </div>
        <p class="text-xs text-error/80 font-mono">{config.lastError}</p>
      </div>
    {/if}
  {/if}
</div>
