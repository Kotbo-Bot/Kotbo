<script lang="ts">
  import { channelDisplayName } from '../lib/channelUtils';
  import { onDestroy, untrack } from 'svelte';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { updateGlobalSettings, updateNotificationsSettings } from '../lib/api';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import FormInput from '../lib/components/FormInput.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  const availableChannels = $derived(dashboardStore.state.discordChannels || []);
  const availableRoles = $derived(dashboardStore.state.discordRoles || []);
  const canManageSettings = $derived(!!dashboardStore.state.access?.canManageSettings);

  const saveAction = createAsyncActionState();

  let notificationsDraft = $state({
    discordChannel: '#alertes-redaction',
    logChannelId: '',
    moderatorRoleId: '',
    email: '',
    emailEnabled: false,
    cloudBackup: true,
    debugLog: false,
    killSwitchEnabled: false,
    severityByModule: []
  });

  let savedNotifications = $state({
    discordChannel: '#alertes-redaction',
    logChannelId: '',
    moderatorRoleId: '',
    email: '',
    emailEnabled: false,
    cloudBackup: true,
    debugLog: false,
    killSwitchEnabled: false,
    severityByModule: [] as any[]
  });

  $effect(() => {
    if (!dashboardStore.state.loading) {
      const loaded = {
        discordChannel: dashboardStore.state.notifications?.discordChannel || '#alertes-redaction',
        logChannelId: dashboardStore.state.logChannelId || '',
        moderatorRoleId: dashboardStore.state.moderatorRoleId || '',
        email: dashboardStore.state.notifications?.email || '',
        emailEnabled: !!dashboardStore.state.notifications?.emailEnabled,
        cloudBackup: !!dashboardStore.state.notifications?.cloudBackup,
        debugLog: !!dashboardStore.state.notifications?.debugLog,
        killSwitchEnabled: !!dashboardStore.state.notifications?.killSwitchEnabled,
        severityByModule: dashboardStore.state.notifications?.severityByModule || []
      };
      notificationsDraft = { ...loaded };
      savedNotifications = JSON.parse(JSON.stringify(loaded));
    }
  });

  $effect(() => {
    const dirty = JSON.stringify(notificationsDraft) !== JSON.stringify(savedNotifications);
    if (dirty && canManageSettings) {
      untrack(() => {
        unsavedChanges.register({
          id: 'notifications-settings',
          label: 'Paramètres & Notifications',
          onSave: () => saveNotifications(),
          onReset: () => {
            notificationsDraft = JSON.parse(JSON.stringify(savedNotifications));
          }
        });
      });
    } else if (!dirty) {
      untrack(() => {
        unsavedChanges.release('notifications-settings');
      });
    }
  });

  onDestroy(() => {
    unsavedChanges.release('notifications-settings');
  });

  async function saveNotifications(): Promise<boolean> {
    if (!canManageSettings) {
      saveAction.setError('Seuls les administrateurs peuvent modifier ces paramètres.');
      return false;
    }

    let success = false;
    await saveAction.run(
      async () => {
        const notificationsPayload = {
          discordChannel: notificationsDraft.discordChannel,
          email: notificationsDraft.email,
          emailEnabled: notificationsDraft.emailEnabled,
          cloudBackup: notificationsDraft.cloudBackup,
          debugLog: notificationsDraft.debugLog,
          killSwitchEnabled: notificationsDraft.killSwitchEnabled,
          severityByModule: notificationsDraft.severityByModule
        };

        const notificationsSaved = await updateNotificationsSettings(notificationsPayload);
        if (!notificationsSaved) return false;

        const settingsSaved = await updateGlobalSettings({
          discordChannel: notificationsDraft.discordChannel,
          logChannelId: notificationsDraft.logChannelId || null,
          moderatorRoleId: notificationsDraft.moderatorRoleId || null
        });

        if (!settingsSaved) return false;

        await dashboardStore.refresh();
        savedNotifications = JSON.parse(JSON.stringify(notificationsDraft));
        success = true;
        return true;
      },
      {
        successMessage: 'Paramètres enregistrés avec succès.',
        failureMessage: 'Impossible d\'enregistrer les paramètres pour le moment.'
      }
    );
    return success;
  }


  function resetNotifications() {
    notificationsDraft = {
      discordChannel: '#alertes-redaction',
      logChannelId: '',
      moderatorRoleId: '',
      email: '',
      emailEnabled: false,
      cloudBackup: true,
      debugLog: false,
      killSwitchEnabled: false,
      severityByModule: []
    };
    saveAction.clearFeedback();
  }

  async function resetAndSaveFactory() {
    resetNotifications();
    await saveNotifications();
  }
</script>


<div class="mb-12 font-inter">
  <h2 class="text-lg font-semibold text-primary tracking-tight font-headline">Paramètres & Notifications</h2>
  <p class="text-on-surface-variant mt-2 text-lg">Configure les alertes système et les préférences globales de {dashboardStore.state.guildName}.</p>
</div>


<div class="grid grid-cols-12 gap-8 font-inter">
  
  <div class="col-span-12 lg:col-span-8 space-y-8">
    <div class="section-card p-8">
      <div class="flex items-center justify-between mb-8">
        <div class="flex items-center gap-4">
          <div class="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center text-primary shrink-0 transition-transform">
            <Papicon icon="discord" size={24} />
          </div>
          <h3 class="text-xl font-bold font-headline">Configuration Discord</h3>
        </div>
      </div>

      <div class="space-y-6">
          <div class="space-y-2">
          <label class="text-xs font-semibold text-on-surface-variant ml-1" for="moderator-role">Rôle modérateur dashboard</label>
          <SearchableSelect id="moderator-role" bind:value={notificationsDraft.moderatorRoleId} options={availableRoles.map(r => ({ id: r.id, name: `@${r.name}` }))} placeholder="Admin uniquement" className="w-full px-6 py-4 bg-surface-container-low border-none rounded-lg text-sm focus:ring-2 focus:ring-primary/20 transition-all font-bold" />
          
          <p class="text-xs text-on-surface-variant">Les membres de ce rôle peuvent accéder au dashboard avec des permissions limitées.</p>
        </div>

          <div class="space-y-2">
          <label class="text-xs font-semibold text-on-surface-variant ml-1" for="discord-channel">Salon d'alertes</label>
          <SearchableSelect id="discord-channel" bind:value={notificationsDraft.discordChannel} options={availableChannels.map(c => ({ id: c.mention, name: channelDisplayName(c) }))} placeholder="Sélectionner un salon" className="w-full px-6 py-4 bg-surface-container-low border-none rounded-lg text-sm focus:ring-2 focus:ring-primary/20 transition-all font-bold" />
        </div>

          <div class="space-y-2">
          <label class="text-xs font-semibold text-on-surface-variant ml-1" for="log-channel">Salon des embeds de logs (optionnel)</label>
          <SearchableSelect id="log-channel" bind:value={notificationsDraft.logChannelId} options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))} placeholder="Ne pas envoyer d'embed" className="w-full px-6 py-4 bg-surface-container-low border-none rounded-lg text-sm focus:ring-2 focus:ring-primary/20 transition-all font-bold" />
          <p class="text-xs text-on-surface-variant">Les logs restent consultables dans le dashboard même si aucun salon n'est défini.</p>
        </div>
        
        
        <div class="flex items-center justify-between p-4 bg-surface-container-low rounded-lg border border-outline-variant">
          <div>
            <p class="font-bold text-on-surface">Kill-Switch de Sécurité</p>
            <p class="text-xs text-on-surface-variant">Désactive instantanément tous les modules en cas d'urgence.</p>
          </div>
          <ToggleSwitch
            checked={notificationsDraft.killSwitchEnabled}
            onToggle={(checked: boolean) => (notificationsDraft.killSwitchEnabled = checked)}
            activeClass="bg-red-500"
          />
        </div>
      </div>
    </div>

    
    <div class="section-card p-8">
      <h3 class="text-xl font-bold font-headline mb-8 flex items-center gap-4">
        <Papicon icon="notifications_active" size={24} class="text-primary" />
        Préférences de Notifications
      </h3>
      
      <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div class="flex items-start gap-4 p-4 rounded-lg hover:bg-surface-container-low dark:hover:bg-white/5 transition-colors group">
          <div class="p-3 rounded-xl bg-surface-container text-on-surface-variant group-hover:bg-primary/10 group-hover:text-primary transition-all">
            <Papicon icon="cloud_upload" size={24} />
          </div>
          <div class="flex-1">
            <div class="flex items-center justify-between mb-1">
              <span class="font-bold text-on-surface">Backup Cloud</span>
              <ToggleSwitch
                size="sm"
                checked={notificationsDraft.cloudBackup}
                onToggle={(checked: boolean) => (notificationsDraft.cloudBackup = checked)}
              />
            </div>
            <p class="text-xs text-on-surface-variant">Synchronisation quotidienne de la base de données.</p>
          </div>
        </div>

        <div class="flex items-start gap-4 p-4 rounded-lg hover:bg-surface-container-low dark:hover:bg-white/5 transition-colors group">
          <div class="p-3 rounded-xl bg-surface-container text-on-surface-variant group-hover:bg-primary/10 group-hover:text-primary transition-all">
            <Papicon icon="bug_report" size={24} />
          </div>
          <div class="flex-1">
            <div class="flex items-center justify-between mb-1">
              <span class="font-bold text-on-surface">Mode Débogage</span>
              <ToggleSwitch
                size="sm"
                checked={notificationsDraft.debugLog}
                onToggle={(checked: boolean) => (notificationsDraft.debugLog = checked)}
              />
            </div>
            <p class="text-xs text-on-surface-variant">Logs plus verbeux pour l'analyse des erreurs.</p>
          </div>
        </div>

        <div class="flex items-start gap-4 p-4 rounded-lg hover:bg-surface-container-low dark:hover:bg-white/5 transition-colors group">
          <div class="p-3 rounded-xl bg-surface-container text-on-surface-variant group-hover:bg-primary/10 group-hover:text-primary transition-all">
            <Papicon icon="mail" size={24} />
          </div>
          <div class="flex-1">
            <div class="flex items-center justify-between mb-1">
              <span class="font-bold text-on-surface">Alertes Email</span>
              <ToggleSwitch
                size="sm"
                checked={notificationsDraft.emailEnabled}
                onToggle={(checked: boolean) => (notificationsDraft.emailEnabled = checked)}
              />
            </div>
            <p class="text-xs text-on-surface-variant">Recevoir un rapport par email si le bot crash.</p>
            {#if notificationsDraft.emailEnabled}
              <FormInput
                type="email"
                bind:value={notificationsDraft.email}
                placeholder="admin@exemple.fr"
                className="mt-3 w-full px-4 py-2.5 bg-surface-container-low border border-outline-variant rounded-xl text-xs font-semibold focus:ring-2 focus:ring-primary/20 transition-all"
              />
            {/if}
          </div>
        </div>
      </div>

      <div class="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-outline-variant pt-6">
        <InlineFeedback
          message={saveAction.state.message}
          error={saveAction.state.error}
          idleText="Les changements ne sont pas enregistrés tant que tu ne valides pas."
        />
        {#if !canManageSettings}
          <p class="text-xs text-on-surface-variant">Accès modérateur: consultation et modération de contenu uniquement.</p>
        {/if}
      </div>
    </div>
  </div>

  
  <div class="col-span-12 lg:col-span-4 space-y-8">
    <div class="bg-primary p-8 rounded-xl text-white overflow-hidden relative group">
      <div class="relative z-10">
        <h4 class="text-body-sm font-medium opacity-60 mb-6">Statut de Connexion</h4>
        <div class="flex items-center gap-6 mb-8">
          <div class="w-16 h-16 rounded-xl bg-white/10 flex items-center justify-center border border-white/20">
            <Papicon 
              icon={dashboardStore.state.error ? 'report_problem' : 'check_circle'} 
              size={36} 
              class={dashboardStore.state.error ? 'text-red-300' : 'text-green-300'} 
            />
          </div>
          <div>
            <div class="text-lg font-semibold font-headline">{dashboardStore.state.error ? 'Erreur' : 'Connecté'}</div>
            <div class="text-xs font-bold opacity-70">
              {dashboardStore.state.error ? 'API Bot inaccessible' : 'Communication API stable'}
            </div>
          </div>
        </div>
      </div>
      
      <div class="absolute -right-20 -bottom-20 w-64 h-64 bg-white/10 rounded-full blur-none hidden transition-transform duration-700"></div>
    </div>

    
    <div class="section-card p-8">
      <h4 class="text-xs font-semibold text-on-surface-variant mb-6">Résumé Technique</h4>
      <div class="space-y-6">
        <div class="flex gap-4">
          <div class="w-8 h-8 rounded-xl bg-surface-container-low flex items-center justify-center shrink-0">
            <Papicon icon="extension" size={18} class="text-on-surface-variant" />
          </div>
          <div>
            <p class="text-xs font-bold text-on-surface">{dashboardStore.state.modules?.length ?? 0} Modules Détectés</p>
          </div>
        </div>
        <div class="flex gap-4">
          <div class="w-8 h-8 rounded-xl bg-surface-container-low flex items-center justify-center shrink-0">
            <Papicon icon="rss_feed" size={18} class="text-on-surface-variant" />
          </div>
          <div>
            <p class="text-xs font-bold text-on-surface">{(dashboardStore.state as any).feeds?.length ?? 0} Flux RSS Configurés</p>
          </div>
        </div>
      </div>
    </div>

    
    <div class="bg-error/10 p-8 rounded-xl border border-red-100">
      <h4 class="text-xs font-semibold text-error mb-4">Zone Critique</h4>
      <p class="text-xs text-error/70 mb-6 leading-relaxed font-medium">Réinitialiser les paramètres globaux désactivera tous les modules actifs et supprimera les flux.</p>
      <button onclick={resetAndSaveFactory} class="w-full py-3 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-semibold transition-all shadow-sm active:scale-[0.98]">
        Réinitialisation d'usine (UI)
      </button>
    </div>
  </div>
</div>
