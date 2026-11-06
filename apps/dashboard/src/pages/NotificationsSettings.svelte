<script lang="ts">
  import { channelDisplayName } from '../lib/channelUtils';
  import { onDestroy, untrack } from 'svelte';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { updateGlobalSettings, updateNotificationsSettings } from '../lib/api';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import SectionCard from '../lib/components/SectionCard.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import FormInput from '../lib/components/FormInput.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import Field from '../lib/components/ui/Field.svelte';
  import Button from '../lib/components/ui/Button.svelte';
  import Callout from '../lib/components/ui/Callout.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import { m } from '../lib/i18n';

  const availableChannels = $derived(dashboardStore.state.discordChannels || []);
  const availableRoles = $derived(dashboardStore.state.discordRoles || []);
  const canManageSettings = $derived(!!dashboardStore.state.access?.canManageSettings);

  const saveAction = createAsyncActionState();

  const DEFAULTS = {
    discordChannel: '#alertes-redaction',
    logChannelId: '',
    moderatorRoleId: '',
    email: '',
    emailEnabled: false,
    cloudBackup: true,
    debugLog: false,
    killSwitchEnabled: false,
    severityByModule: [] as any[]
  };
  type Draft = typeof DEFAULTS;
  type ToggleKey = 'cloudBackup' | 'debugLog' | 'emailEnabled' | 'killSwitchEnabled';

  const clone = (value: Draft): Draft => JSON.parse(JSON.stringify(value));

  let notificationsDraft = $state<Draft>(clone(DEFAULTS));
  let savedNotifications = $state<Draft>(clone(DEFAULTS));

  /** Les interrupteurs des préférences, rendus par la même ligne. */
  const PREFERENCE_TOGGLES: { key: ToggleKey; icon: string; label: () => string; desc: () => string }[] = [
    { key: 'cloudBackup', icon: 'cloud_upload', label: () => m.nset_cloud_backup_label(), desc: () => m.nset_cloud_backup_desc() },
    { key: 'debugLog', icon: 'bug_report', label: () => m.nset_debug_label(), desc: () => m.nset_debug_desc() },
    { key: 'emailEnabled', icon: 'mail', label: () => m.nset_email_label(), desc: () => m.nset_email_desc() },
  ];

  $effect(() => {
    if (!dashboardStore.state.loading) {
      const loaded: Draft = {
        discordChannel: dashboardStore.state.notifications?.discordChannel || DEFAULTS.discordChannel,
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
      savedNotifications = clone(loaded);
    }
  });

  $effect(() => {
    const dirty = JSON.stringify(notificationsDraft) !== JSON.stringify(savedNotifications);
    if (dirty && canManageSettings) {
      untrack(() => {
        unsavedChanges.register({
          id: 'notifications-settings',
          label: m.nset_page_title(),
          onSave: () => saveNotifications(),
          onReset: () => {
            notificationsDraft = clone(savedNotifications);
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
      saveAction.setError(m.nset_admin_only_error());
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
        savedNotifications = clone(notificationsDraft);
        success = true;
        return true;
      },
      {
        successMessage: m.nset_saved(),
        failureMessage: m.nset_save_failed()
      }
    );
    return success;
  }

  async function resetAndSaveFactory() {
    const confirmed = await confirmDialog.ask({
      title: m.nset_reset_confirm_title(),
      description: m.nset_reset_confirm_desc(),
      confirmLabel: m.nset_reset_confirm_button(),
      variant: 'danger'
    });
    if (!confirmed) return;
    notificationsDraft = clone(DEFAULTS);
    saveAction.clearFeedback();
    await saveNotifications();
  }
</script>

{#snippet toggleRow(key: ToggleKey, icon: string, label: string, desc: string)}
  <div class="flex items-start gap-3">
    <div class="w-8 h-8 rounded-lg bg-surface-container text-on-surface-variant flex items-center justify-center shrink-0">
      <Papicon {icon} size={16} />
    </div>
    <div class="min-w-0 flex-1">
      <p class="text-sm font-medium text-on-surface">{label}</p>
      <p class="text-body-sm text-on-surface-variant">{desc}</p>
    </div>
    <ToggleSwitch
      ariaLabel={label}
      checked={notificationsDraft[key]}
      onToggle={(checked: boolean) => (notificationsDraft[key] = checked)}
    />
  </div>
{/snippet}

<ModulePage
  title={m.nset_page_title()}
  description={m.nset_page_desc({ guild: dashboardStore.state.guildName ?? '' })}
  icon="bell"
>
  <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
    <div class="lg:col-span-2 space-y-6">
      <SectionCard title={m.nset_section_discord_title()} description={m.nset_section_discord_desc()} icon="discord">
        <div class="space-y-4">
          <Field label={m.nset_moderator_role_label()} hint={m.nset_moderator_role_hint()} id="moderator-role">
            {#snippet children(id)}
              <SearchableSelect {id} bind:value={notificationsDraft.moderatorRoleId} options={availableRoles.map(r => ({ id: r.id, name: `@${r.name}` }))} placeholder={m.nset_moderator_role_placeholder()} className="w-full" />
            {/snippet}
          </Field>

          <Field label={m.nset_alert_channel_label()} id="discord-channel">
            {#snippet children(id)}
              <SearchableSelect {id} bind:value={notificationsDraft.discordChannel} options={availableChannels.map(c => ({ id: c.mention, name: channelDisplayName(c) }))} placeholder={m.nset_channel_placeholder()} className="w-full" />
            {/snippet}
          </Field>

          <Field label={m.nset_log_channel_label()} hint={m.nset_log_channel_hint()} id="log-channel">
            {#snippet children(id)}
              <SearchableSelect {id} bind:value={notificationsDraft.logChannelId} options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))} placeholder={m.nset_log_channel_placeholder()} className="w-full" />
            {/snippet}
          </Field>
        </div>
      </SectionCard>

      <SectionCard title={m.nset_section_notifications_title()} description={m.nset_section_notifications_desc()} icon="notifications_active">
        <div class="space-y-4">
          {#each PREFERENCE_TOGGLES as toggle (toggle.key)}
            {@render toggleRow(toggle.key, toggle.icon, toggle.label(), toggle.desc())}
            {#if toggle.key === 'emailEnabled' && notificationsDraft.emailEnabled}
              <div class="pl-11">
                <FormInput
                  id="alert-email"
                  type="email"
                  label={m.nset_email_address_label()}
                  bind:value={notificationsDraft.email}
                  placeholder={m.nset_email_placeholder()}
                  className="w-full"
                />
              </div>
            {/if}
          {/each}
        </div>
      </SectionCard>

      <SectionCard title={m.nset_section_security_title()} icon="shield">
        {@render toggleRow('killSwitchEnabled', 'power', m.nset_kill_switch_label(), m.nset_kill_switch_desc())}
      </SectionCard>

      <div class="flex flex-wrap items-center justify-between gap-3">
        <InlineFeedback
          message={saveAction.state.message}
          error={saveAction.state.error}
          idleText={m.nset_idle_feedback()}
        />
        {#if !canManageSettings}
          <p class="text-body-sm text-on-surface-variant">{m.nset_moderator_readonly()}</p>
        {/if}
      </div>
    </div>

    <div class="space-y-6">
      <SectionCard title={m.nset_status_title()}>
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 {dashboardStore.state.error ? 'bg-error/10 text-error' : 'bg-success/10 text-success'}">
            <Papicon icon={dashboardStore.state.error ? 'report_problem' : 'check_circle'} size={20} />
          </div>
          <div>
            <p class="text-sm font-semibold text-on-surface">{dashboardStore.state.error ? m.nset_status_offline() : m.nset_status_online()}</p>
            <p class="text-body-sm text-on-surface-variant">{dashboardStore.state.error ? m.nset_status_offline_desc() : m.nset_status_online_desc()}</p>
          </div>
        </div>
      </SectionCard>

      <SectionCard title={m.nset_summary_title()}>
        <ul class="space-y-3">
          <li class="flex items-center gap-3 text-body-sm text-on-surface">
            <Papicon icon="extension" size={16} class="text-on-surface-variant" />
            {m.nset_summary_modules({ count: dashboardStore.state.modules?.length ?? 0 })}
          </li>
          <li class="flex items-center gap-3 text-body-sm text-on-surface">
            <Papicon icon="rss_feed" size={16} class="text-on-surface-variant" />
            {m.nset_summary_feeds({ count: (dashboardStore.state as any).feeds?.length ?? 0 })}
          </li>
        </ul>
      </SectionCard>

      <Callout variant="danger" title={m.nset_reset_title()}>
        {m.nset_reset_desc()}
        {#snippet actions()}
          <Button variant="danger" size="sm" icon="refresh" onclick={resetAndSaveFactory} disabled={!canManageSettings} disabledReason={m.nset_admin_only_error()}>
            {m.nset_reset_button()}
          </Button>
        {/snippet}
      </Callout>
    </div>
  </div>
</ModulePage>
