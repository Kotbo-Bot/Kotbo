<script lang="ts">
  import { explainDisabled } from '../../lib/actions/explainDisabled';
  import { m, dateLocale } from '../../lib/i18n';
  import { onMount } from 'svelte';
  import { authStore } from '../../lib/stores/auth.svelte';
  import { dashboardStore } from '../../lib/stores/dashboard.svelte';
  import {
    fetchRaidProtection,
    updateRaidProtection,
    setRaidMode,
    setJoinLock,
    setDmLock,
    setInviteEmergency,
    fetchMemberReports,
    decideMemberReport,
    fetchInviteRequests,
    decideInviteRequest,
    fetchInviteLineage,
    provisionJailRole,
    fetchJailedMembers,
    quarantineInviteLineage,
  } from '../../lib/api';
  import { toast } from '../../lib/stores/toast.svelte';
  import { confirmDialog } from '../../lib/stores/confirmDialog.svelte';
  import SecurityPage, { type SecurityTab } from '../../lib/components/security/SecurityPage.svelte';
  import SectionCard from '../../lib/components/SectionCard.svelte';
  import CaptchaFields from '../../lib/components/security/CaptchaFields.svelte';
  import ToggleSwitch from '../../lib/components/ToggleSwitch.svelte';
  import RefreshButton from '../../lib/components/RefreshButton.svelte';
  import Button from '../../lib/components/ui/Button.svelte';
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import LoadingHint from '../../lib/components/LoadingHint.svelte';
  import VisionPanel from '../../lib/components/security/VisionPanel.svelte';
  import ShieldCard from '../../lib/components/security/ShieldCard.svelte';
  import Callout from '../../lib/components/ui/Callout.svelte';
  import MemberName from '../../lib/components/MemberName.svelte';
  import { formatRelative } from '../../lib/components/staff/format';

  type Config = Record<string, any>;

  type Report = {
    id: string;
    reporterId: string;
    targetId: string;
    reason: string;
    channelId: string | null;
    messageContent: string | null;
    status: string;
    createdAt: string;
  };

  type InviteRequest = {
    id: string;
    creatorId: string;
    channelId: string;
    inviteCode: string | null;
    maxUses: number;
    maxAgeSec: number;
    status: string;
    createdAt: string;
  };

  type Jailed = { userId: string; source: string; reason: string | null; releaseAt: string | null; createdAt: string };

  const JAIL_SOURCES: Record<string, string> = {
    MANUAL: m.arx_jail_src_manual(),
    SERVER_TAG: m.arx_jail_src_server_tag(),
    ACCOUNT_AGE: m.arx_jail_src_account_age(),
    DISCORD_QUARANTINE: m.arx_jail_src_discord(),
    HONEYPOT: 'Honeypot',
    VISION: m.sec_tab_antiraid_vision(),
  };

  const SANCTION_OPTIONS = [
    { value: 'DELETE', label: m.arx_sanction_delete_only() },
    { value: 'WARN', label: m.arx_sanction_warn() },
    { value: 'TIMEOUT', label: 'Timeout' },
    { value: 'JAIL', label: m.arx_jail_title() },
    { value: 'KICK', label: m.arx_sanction_kick() },
    { value: 'SOFTBAN', label: 'Softban' },
    { value: 'BAN', label: m.arx_sanction_ban() },
  ];
  const DURATION_OPTIONS: { value: number | null; label: string }[] = [
    { value: 5, label: '5 minutes' },
    { value: 60, label: m.arx_duration_1h() },
    { value: 1440, label: m.arx_duration_1d() },
    { value: 10080, label: m.arx_duration_7d() },
    { value: 43200, label: m.arx_duration_30d() },
    { value: null, label: m.arx_duration_permanent() },
  ];

  let config = $state<Config>({});
  let original = $state<Config>({});
  let reportStats = $state<{ pending: number; resolved: number; dismissed: number } | null>(null);
  let pendingInvites = $state(0);
  let scamImageCount = $state(0);

  let reports = $state<Report[]>([]);
  let inviteRequests = $state<InviteRequest[]>([]);
  let jailed = $state<Jailed[]>([]);

  let loading = $state(true);
  let saving = $state(false);
  let busyAction = $state<string | null>(null);
  let error = $state('');

  type Lineage = {
    userId: string;
    chain: string[];
    trust: { penalty: number; taintedBy: string | null; depth: number };
    directInvites: number;
    totalDescendants: number;
    taintedDescendants: number;
  };

  let lineageUserId = $state('');
  let lineage = $state<Lineage | null>(null);
  let lineageLoading = $state(false);
  /** Nombre de membres qu'une application réelle toucherait, issu de la simulation. */
  let quarantinePreview = $state<number | null>(null);

  const dirty = $derived(JSON.stringify(config) !== JSON.stringify(original));

  const channels = $derived((dashboardStore.state.discordChannels ?? []) as { id: string; name: string }[]);
  const roles = $derived((dashboardStore.state.discordRoles ?? []) as { id: string; name: string }[]);

  // « Captcha d'entree » et non « Verification » : la verification d'identite
  // OAuth du multi-comptes porte deja ce nom, et la confusion entre les deux
  // etait l'une des raisons du reagencement.
  const TABS = $derived<SecurityTab[]>([
    { key: 'detection', label: m.arx_tab_detection(), icon: 'ShieldAlert' },
    { key: 'captcha',   label: m.arx_tab_captcha(),    icon: 'UserCheck' },
    { key: 'scams',     label: m.arx_tab_scams(),      icon: 'Fishing' },
    { key: 'vision',  label: m.sec_tab_antiraid_vision(), icon: 'ImageOff' },
    { key: 'jail',      label: m.sec_tab_antiraid_jail(), icon: 'Lock', count: jailed.length || undefined },
    { key: 'invites',   label: m.arx_tab_invites(),         icon: 'Link' },
    {
      key: 'queues',
      label: m.arx_tab_queues(),
      icon: 'Inbox',
      count: reports.length + inviteRequests.length,
    },
  ]);

  function channelName(id: string | null | undefined): string {
    if (!id) return '-';
    return channels.find((c) => c.id === id)?.name ?? id;
  }

  async function load() {
    if (!authStore.selectedGuildId) return;
    loading = true;
    error = '';
    try {
      const res = await fetchRaidProtection(authStore.selectedGuildId);
      const loaded = res?.config ?? {};
      config = { ...loaded };
      original = { ...loaded };
      reportStats = res?.reportStats ?? null;
      pendingInvites = res?.pendingInvites ?? 0;
      scamImageCount = res?.scamImageCount ?? 0;
    } catch (err) {
      error = err instanceof Error ? err.message : m.arx_load_failed();
    } finally {
      loading = false;
    }
  }

  async function loadQueues() {
    if (!authStore.selectedGuildId) return;
    try {
      const [r, i, j] = await Promise.all([
        fetchMemberReports('PENDING', authStore.selectedGuildId),
        fetchInviteRequests(authStore.selectedGuildId),
        fetchJailedMembers(authStore.selectedGuildId),
      ]);
      reports = r?.reports ?? [];
      inviteRequests = (i?.requests ?? []).filter((req: InviteRequest) => req.status === 'PENDING');
      jailed = j?.jails ?? [];
    } catch {
      toast.error(m.ar_queues_load_error());
    }
  }

  async function save() {
    if (!dirty || saving) return;
    saving = true;
    try {
      const res = await updateRaidProtection({ ...config }, authStore.selectedGuildId);
      const saved = res?.config ?? config;
      config = { ...saved };
      original = { ...saved };
      toast.success(m.ba_config_saved());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.tmac_err_save());
    } finally {
      saving = false;
    }
  }

  /** Les bascules d'urgence agissent immédiatement : elles ne passent pas par le formulaire. */
  async function runEmergency(
    id: string,
    fn: () => Promise<any>,
    successMessage: string,
    confirmMessage?: string
  ) {
    if (busyAction) return;
    if (confirmMessage && !(await confirmDialog.ask({
      title: m.arx_emergency_confirm_title(),
      description: confirmMessage,
      confirmLabel: m.arx_emergency_confirm_button(),
      variant: 'danger',
    }))) return;

    busyAction = id;
    try {
      const res = await fn();
      if (res?.config) {
        config = { ...res.config };
        original = { ...res.config };
      }
      toast.success(successMessage);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.common_action_failed());
    } finally {
      busyAction = null;
    }
  }

  async function decideReport(report: Report, resolved: boolean) {
    busyAction = report.id;
    try {
      await decideMemberReport(report.id, resolved, authStore.selectedGuildId);
      reports = reports.filter((r) => r.id !== report.id);
      if (reportStats) reportStats.pending = Math.max(0, reportStats.pending - 1);
      toast.success(resolved ? m.ar_report_resolved() : m.ar_report_rejected());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.common_decision_failed());
    } finally {
      busyAction = null;
    }
  }

  async function decideInvite(request: InviteRequest, approved: boolean) {
    busyAction = request.id;
    try {
      await decideInviteRequest(request.id, approved, authStore.selectedGuildId);
      inviteRequests = inviteRequests.filter((r) => r.id !== request.id);
      pendingInvites = Math.max(0, pendingInvites - 1);
      toast.success(approved ? m.ar_invite_approved() : m.ar_request_rejected());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.common_decision_failed());
    } finally {
      busyAction = null;
    }
  }

  async function setupJail(createChannel: boolean) {
    if (busyAction) return;
    busyAction = 'jail';
    try {
      const res = await provisionJailRole(createChannel, authStore.selectedGuildId);
      if (res) {
        config.jailRoleId = res.roleId;
        original.jailRoleId = res.roleId;
        config.jailChannelId = res.channelId;
        original.jailChannelId = res.channelId;
        toast.success(m.ar_jail_role_ready({ count: res.channelsUpdated }));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.common_create_failed());
    } finally {
      busyAction = null;
    }
  }

  async function loadLineage() {
    const userId = lineageUserId.trim();
    if (!userId) return;

    lineageLoading = true;
    quarantinePreview = null;
    try {
      const res = await fetchInviteLineage(userId, authStore.selectedGuildId);
      lineage = res?.report ?? null;
    } catch (err) {
      lineage = null;
      toast.error(err instanceof Error ? err.message : m.ar_scan_failed());
    } finally {
      lineageLoading = false;
    }
  }

  async function runQuarantine(dryRun: boolean) {
    if (!lineage || busyAction) return;
    if (!dryRun) {
      const confirmed = await confirmDialog.ask({
        title: m.arx_quarantine_confirm_title({ count: quarantinePreview ?? 0 }),
        description: m.arx_quarantine_confirm_desc(),
        confirmLabel: m.arx_quarantine_confirm_button(),
        variant: 'warning',
      });
      if (!confirmed) return;
    }

    busyAction = 'quarantine';
    try {
      const res = await quarantineInviteLineage(lineage.userId, { dryRun }, authStore.selectedGuildId);
      const result = res?.result;
      if (dryRun) {
        quarantinePreview = result?.targets?.length ?? 0;
      } else {
        toast.success(m.ar_quarantine_applied({ applied: result?.applied ?? 0, skipped: result?.skipped ?? 0 }));
        quarantinePreview = null;
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.ar_quarantine_failed());
    } finally {
      busyAction = null;
    }
  }

  /**
   * Champs modifiés côté serveur par une action immédiate (Shield) : reportés
   * dans le formulaire et dans sa référence, sans écraser les autres saisies.
   */
  const SERVER_DRIVEN_FIELDS = [
    'shieldLevel', 'shieldPanelChannelId', 'shieldPanelMessageId', 'shieldStatusChannelId', 'shieldChangedAt', 'shieldChangedBy',
    'captchaEnabled', 'dmLockEnabled', 'dmLockUntil', 'raidModeActive', 'raidModeActivatedAt', 'raidModeManual', 'joinLockEnabled', 'joinLockUntil',
  ];

  function syncServerFields(fresh: Config) {
    for (const field of SERVER_DRIVEN_FIELDS) {
      if (field in fresh) {
        config[field] = fresh[field];
        original[field] = fresh[field];
      }
    }
  }

  function toggleInList(field: string, value: string) {
    const list: string[] = config[field] ?? [];
    config[field] = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  }

  onMount(async () => {
    await load();
    await loadQueues();
  });

  $effect(() => {
    const guildId = authStore.selectedGuildId;
    if (guildId) {
      void load();
      void loadQueues();
    }
  });
</script>

{#snippet channelSelect(field: string, label: string, help = '', list = channels)}
  <label class="block">
    <span class="text-xs font-medium text-on-surface-variant">{label}</span>
    <select
      bind:value={config[field]}
      class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
    >
      <option value={null}>{m.common_none()}</option>
      {#each list as item (item.id)}
        <option value={item.id}>{item.name}</option>
      {/each}
    </select>
    {#if help}<p class="text-2xs text-on-surface-variant mt-1">{help}</p>{/if}
  </label>
{/snippet}

{#snippet roleSelect(field: string, label: string, help = '')}
  <label class="block">
    <span class="text-xs font-medium text-on-surface-variant">{label}</span>
    <select
      bind:value={config[field]}
      class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
    >
      <option value={null}>{m.common_none()}</option>
      {#each roles as role (role.id)}
        <option value={role.id}>{role.name}</option>
      {/each}
    </select>
    {#if help}<p class="text-2xs text-on-surface-variant mt-1">{help}</p>{/if}
  </label>
{/snippet}

{#snippet numberField(field: string, label: string, min: number, max: number, help = '')}
  <label class="block">
    <span class="text-xs font-medium text-on-surface-variant">{label}</span>
    <input
      type="number" {min} {max}
      bind:value={config[field]}
      class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
    />
    {#if help}<p class="text-2xs text-on-surface-variant mt-1">{help}</p>{/if}
  </label>
{/snippet}

{#snippet switchRow(field: string, label: string, help: string)}
  <div class="flex items-start justify-between gap-4 rounded-xl border border-outline-variant/30 px-4 py-3">
    <div class="min-w-0">
      <p class="text-body-sm font-medium text-on-surface">{label}</p>
      <p class="text-xs text-on-surface-variant mt-1 leading-relaxed">{help}</p>
    </div>
    <ToggleSwitch checked={Boolean(config[field])} onToggle={(v) => (config[field] = v)} />
  </div>
{/snippet}

<SecurityPage
  basePath="/security/anti-raid"
  title={m.nav_security_antiraid()}
  description={m.arx_page_desc()}
  icon="shieldwarning"
  tabs={TABS}
>
  {#snippet actions()}
    <RefreshButton onclick={load} loading={loading} />
  {/snippet}

  {#snippet children(activeTab: string)}
  {#if loading}
    <LoadingHint context="config" />
  {:else if error}
    <EmptyState icon="AlertTriangle" title={m.arx_config_unavailable()} description={error} actionLabel={m.common_retry()} actionIcon="RefreshCw" onAction={load} />
  {:else}
    <!-- ── Barre d'etat & actions d'urgence ───────────────────────────── -->
    <!-- Seulement sur l'onglet des verrous : repetee sur chaque onglet, elle
         repoussait le contenu propre a l'onglet sous la ligne de flottaison. -->
    {#if activeTab === 'detection'}
    <ShieldCard {config} {channels} onSynced={syncServerFields} />

    <SectionCard
      title={m.arx_state_title()}
      description={m.arx_state_desc()}
      icon="Zap"
    >
      <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {#each [
          {
            id: 'raidmode',
            label: m.arx_raid_mode(),
            active: Boolean(config.raidModeActive),
            help: config.raidModeActive
              ? (config.raidModeManual ? m.arx_raid_active_manual() : m.arx_raid_active_auto({ minutes: config.antiRaidAutoDisableMinutes ?? '?' }))
              : m.arx_raid_inactive(),
            run: () => setRaidMode(!config.raidModeActive, authStore.selectedGuildId),
            confirm: config.raidModeActive ? undefined : m.arx_raid_confirm(),
          },
          {
            id: 'joinlock',
            label: m.arx_join_lock(),
            active: Boolean(config.joinLockEnabled),
            help: config.joinLockEnabled ? m.arx_join_lock_on() : m.arx_join_lock_off(),
            run: () => setJoinLock(!config.joinLockEnabled, undefined, authStore.selectedGuildId),
            confirm: config.joinLockEnabled ? undefined : m.arx_join_lock_confirm(),
          },
          {
            id: 'dmlock',
            label: m.arx_dm_lock(),
            active: Boolean(config.dmLockEnabled),
            help: config.dmLockEnabled ? m.arx_dm_lock_on() : m.arx_dm_lock_off(),
            run: () => setDmLock(!config.dmLockEnabled, undefined, authStore.selectedGuildId),
            confirm: undefined,
          },
          {
            id: 'invite-emergency',
            label: m.arx_invite_emergency(),
            active: Boolean(config.inviteEmergencyEnabled),
            help: config.inviteEmergencyEnabled ? m.arx_invite_emergency_on() : m.arx_invite_emergency_off(),
            run: () => setInviteEmergency(!config.inviteEmergencyEnabled, authStore.selectedGuildId),
            confirm: config.inviteEmergencyEnabled ? undefined : m.arx_invite_emergency_confirm(),
          },
        ] as control (control.id)}
          <button
            type="button"
            class="text-left rounded-xl border px-4 py-3.5 transition-colors disabled:opacity-50
            {control.active
              ? 'border-error/40 bg-error/10 hover:bg-error/15'
              : 'border-outline-variant/30 bg-surface-container-low/40 hover:border-outline-variant/60'}"
            disabled={busyAction !== null}
            onclick={() => runEmergency(control.id, control.run, control.active ? m.arx_control_off({ label: control.label }) : m.arx_control_on({ label: control.label }), control.confirm)}
          >
            <div class="flex items-center justify-between gap-2">
              <span class="text-body-sm font-medium text-on-surface">{control.label}</span>
              <span
                class="w-2 h-2 rounded-full shrink-0 {control.active ? 'bg-error animate-pulse' : 'bg-outline-variant'}"
              ></span>
            </div>
            <p class="text-xs mt-1 {control.active ? 'text-error' : 'text-on-surface-variant'}">
              {busyAction === control.id ? m.arx_applying() : control.help}
            </p>
          </button>
        {/each}
      </div>

      <div class="mt-4 grid grid-cols-3 gap-3 text-center">
        <div class="rounded-lg bg-surface-container/60 px-3 py-2">
          <div class="text-[15px] font-semibold text-on-surface tabular-nums">{reportStats?.pending ?? 0}</div>
          <div class="text-2xs text-on-surface-variant">{m.arx_stat_pending_reports()}</div>
        </div>
        <div class="rounded-lg bg-surface-container/60 px-3 py-2">
          <div class="text-[15px] font-semibold text-on-surface tabular-nums">{pendingInvites}</div>
          <div class="text-2xs text-on-surface-variant">{m.arx_stat_pending_invites()}</div>
        </div>
        <div class="rounded-lg bg-surface-container/60 px-3 py-2">
          <div class="text-[15px] font-semibold text-on-surface tabular-nums">{scamImageCount}</div>
          <div class="text-2xs text-on-surface-variant">{m.arx_stat_scam_hashes()}</div>
        </div>
      </div>
    </SectionCard>
    {/if}

    {#if activeTab === 'detection'}
      <SectionCard
        title={m.arx_detection_title()}
        description={m.arx_detection_desc()}
        icon="ShieldAlert"
      >
        <div class="space-y-3">
          {@render switchRow('antiRaidEnabled', m.nav_security_antiraid(), m.arx_antiraid_help())}

          <div class="grid sm:grid-cols-2 gap-3">
            {@render numberField('antiRaidJoinThreshold', m.arx_join_threshold(), 2, 200, m.arx_join_threshold_help())}
            {@render numberField('antiRaidJoinWindowSec', m.arx_window_seconds(), 5, 600, m.arx_join_window_help())}
          </div>

          <label class="block">
            <span class="text-xs font-medium text-on-surface-variant">{m.arx_trigger_action()}</span>
            <select
              bind:value={config.antiRaidAction}
              class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
            >
              <option value="LOCK">{m.arx_action_lock()}</option>
              <option value="CAPTCHA">{m.arx_action_captcha()}</option>
              <option value="KICK">{m.arx_action_kick()}</option>
            </select>
            <p class="text-2xs text-on-surface-variant mt-1">
              {m.arx_action_kick_warning()}
            </p>
          </label>

          <div class="grid sm:grid-cols-2 gap-3">
            {@render channelSelect('antiRaidAlertChannelId', m.arx_alert_channel(), m.arx_alert_channel_help())}
            {@render numberField('antiRaidAutoDisableMinutes', m.arx_auto_disable(), 1, 1440, m.arx_auto_disable_help())}
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title={m.arx_age_title()}
        description={m.arx_age_desc()}
        icon="UserX"
      >
        <div class="space-y-3">
          {@render switchRow('accountAgeGuardEnabled', m.arx_age_switch(), m.arx_age_switch_help())}

          <div class="grid sm:grid-cols-3 gap-3">
            {@render numberField('accountAgeMinValue', m.arx_age_min(), 1, config.accountAgeMinUnit === 'MONTHS' ? 120 : 3650)}
            <label class="block">
              <span class="text-xs font-medium text-on-surface-variant">{m.arx_unit()}</span>
              <select
                bind:value={config.accountAgeMinUnit}
                class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
              >
                <option value="DAYS">{m.arx_unit_days()}</option>
                <option value="MONTHS">{m.arx_unit_months()}</option>
              </select>
            </label>
            <label class="block">
              <span class="text-xs font-medium text-on-surface-variant">{m.arx_action()}</span>
              <select
                bind:value={config.accountAgeAction}
                class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
              >
                <option value="ALERT">{m.arx_age_action_alert()}</option>
                <option value="KICK">{m.arx_age_action_kick()}</option>
                <option value="JAIL">{m.arx_age_action_jail()}</option>
                <option value="TEMPBAN">{m.arx_age_action_tempban()}</option>
                <option value="BAN">{m.arx_age_action_ban()}</option>
              </select>
            </label>
          </div>

          {#if (config.accountAgeMinUnit === 'MONTHS' ? config.accountAgeMinValue * 30 : config.accountAgeMinValue) >= 365}
            <p class="text-2xs text-warning leading-relaxed">
              {m.arx_age_threshold_warning()}
            </p>
          {/if}

          {#if config.accountAgeAction === 'JAIL'}
            <p class="text-2xs text-on-surface-variant leading-relaxed">
              {m.arx_age_jail_hint()}{#if !config.jailRoleId} {m.arx_age_jail_no_role()}{/if}
            </p>
          {/if}

          {#if config.accountAgeAction === 'BAN'}
            <p class="text-2xs text-error/90 leading-relaxed">
              {m.arx_age_ban_warning()}
            </p>
          {/if}

          <div class="grid sm:grid-cols-2 gap-3">
            {@render channelSelect('accountAgeAlertChannelId', m.arx_alert_channel(), m.arx_age_alert_help())}
            <label class="block">
              <span class="text-xs font-medium text-on-surface-variant">{m.arx_dm_message()}</span>
              <textarea
                rows="2"
                bind:value={config.accountAgeMessage}
                class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface resize-y"
              ></textarea>
              <p class="text-2xs text-on-surface-variant mt-1">{m.arx_dm_message_help()}</p>
            </label>
          </div>

          <label class="block">
            <span class="text-xs font-medium text-on-surface-variant">{m.arx_age_whitelist()}</span>
            <textarea
              rows="2"
              value={(config.accountAgeWhitelist ?? []).join('\n')}
              oninput={(e) => (config.accountAgeWhitelist = e.currentTarget.value.split('\n').map((s) => s.trim()).filter(Boolean))}
              placeholder="123456789012345678"
              class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface font-mono resize-y"
            ></textarea>
            <p class="text-2xs text-on-surface-variant mt-1">{m.arx_age_whitelist_help()}</p>
          </label>
        </div>
      </SectionCard>

      <SectionCard
        title={m.arx_persist_title()}
        description={m.arx_persist_desc()}
        icon="UserPlus"
      >
        <div class="space-y-3">
          {@render switchRow('rolePersistEnabled', m.arx_persist_switch(), m.arx_persist_switch_help())}
          {@render switchRow('rolePersistStaff', m.arx_persist_staff(), m.arx_persist_staff_help())}

          <div class="grid sm:grid-cols-2 gap-3">
            <label class="block">
              <span class="text-xs font-medium text-on-surface-variant">{m.arx_persist_mode()}</span>
              <select
                bind:value={config.rolePersistMode}
                class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
              >
                <option value="ALL">{m.arx_persist_mode_all()}</option>
                <option value="LIST">{m.arx_persist_mode_list()}</option>
              </select>
            </label>
            {@render numberField('rolePersistMaxDays', m.arx_persist_days(), 1, 365, m.arx_persist_days_help())}
          </div>

          <div>
            <p class="text-xs font-medium text-on-surface-variant mb-2">
              {config.rolePersistMode === 'LIST' ? m.arx_persist_restored() : m.arx_persist_never()}
            </p>
            <div class="flex flex-wrap gap-1.5">
              {#each roles as role (role.id)}
                <button
                  type="button"
                  class="px-2.5 py-1 rounded-full text-xs font-medium border transition-colors
                  {(config.rolePersistRoleIds ?? []).includes(role.id)
                    ? 'bg-primary/15 border-primary/40 text-primary'
                    : 'bg-surface-container-low border-outline-variant/40 text-on-surface-variant hover:text-on-surface'}"
                  onclick={() => toggleInList('rolePersistRoleIds', role.id)}
                >
                  {role.name}
                </button>
              {/each}
            </div>
          </div>

          {#if config.rolePersistMode === 'LIST' && (config.rolePersistRoleIds ?? []).length === 0}
            <p class="text-2xs text-warning leading-relaxed">
              {m.arx_persist_empty_warning()}
            </p>
          {/if}
        </div>
      </SectionCard>

      <SectionCard title={m.arx_join_lock()} description={m.arx_join_lock_desc()} icon="Lock">
        <div class="space-y-3">
          {@render switchRow('joinLockKick', m.arx_join_lock_kick(), m.arx_join_lock_kick_help())}
          <label class="block">
            <span class="text-xs font-medium text-on-surface-variant">{m.arx_dm_message()}</span>
            <textarea
              rows="2"
              bind:value={config.joinLockMessage}
              class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface resize-y"
            ></textarea>
          </label>
        </div>
      </SectionCard>
    {/if}

    {#if activeTab === 'captcha'}
      <SectionCard
        title={m.arx_captcha_title()}
        description={m.arx_captcha_desc()}
        icon="UserCheck"
      >
        <CaptchaFields bind:config />
        <div class="grid sm:grid-cols-2 gap-3 mt-4">
          <label class="block">
            <span class="text-xs font-medium text-on-surface-variant">{m.arx_captcha_trigger()}</span>
            <select
              bind:value={config.captchaTrigger}
              class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
            >
              <option value="ALWAYS">{m.arx_captcha_always()}</option>
              <option value="AUTO">{m.arx_captcha_auto()}</option>
              <option value="SMART">{m.arx_captcha_smart()}</option>
            </select>
            <p class="text-2xs text-on-surface-variant mt-1">
              {#if config.captchaTrigger === 'SMART'}
                {m.arx_captcha_smart_help()}
              {:else if config.captchaTrigger === 'AUTO'}
                {m.arx_captcha_auto_help()}
              {:else}
                {m.arx_captcha_always_help()}
              {/if}
            </p>
          </label>
          <div class="flex items-start justify-between gap-4 rounded-xl border border-outline-variant/30 px-4 py-3">
            <div class="min-w-0">
              <p class="text-body-sm font-medium text-on-surface">{m.arx_captcha_branding()}</p>
              <p class="text-xs text-on-surface-variant mt-1 leading-relaxed">{m.arx_captcha_branding_help()}</p>
            </div>
            <ToggleSwitch checked={config.captchaUseServerIcon !== false} onToggle={(v) => (config.captchaUseServerIcon = v)} />
          </div>
        </div>
      </SectionCard>
    {/if}

    {#if activeTab === 'scams'}
      <SectionCard
        title={m.arx_scam_title()}
        description={m.arx_scam_desc()}
        icon="Fishing"
      >
        {#snippet actions()}
          <!-- Le simulateur vit dans les filtres AutoMod : il rejoue l'analyse
               de texte et de domaines sur les messages passés. -->
          <Button size="sm" variant="ghost" icon="history" href="/security/filters/simulator?rule=scam">{m.arx_scam_simulate()}</Button>
        {/snippet}
        <div class="space-y-3">
          {@render switchRow('scamFilterEnabled', m.arx_scam_title(), m.arx_scam_switch_help())}
          {@render switchRow('scamQrFilterEnabled', m.arx_qr_switch(), m.arx_qr_switch_help())}

          {@render switchRow('scamOcrEnabled', m.arx_ocr_switch(), m.arx_ocr_switch_help())}

          {#if config.scamQrFilterEnabled || config.scamOcrEnabled}
            <div class="rounded-xl border border-outline-variant/30 p-3">
              {@render numberField('scamQrTrustedMessages', m.arx_qr_trusted(), 0, 10000, m.arx_qr_trusted_help())}
            </div>
          {/if}

          <div class="grid sm:grid-cols-3 gap-3">
            <label class="block">
              <span class="text-xs font-medium text-on-surface-variant">{m.arx_action()}</span>
              <select
                bind:value={config.scamFilterAction}
                class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
              >
                <option value="DELETE">{m.common_delete()}</option>
                <option value="DELETE_AND_WARN">{m.arx_scam_delete_warn()}</option>
                <option value="DELETE_AND_TIMEOUT">{m.arx_scam_delete_timeout()}</option>
                <option value="DELETE_AND_BAN">{m.arx_scam_delete_ban()}</option>
              </select>
            </label>
            {@render numberField('scamFilterTimeoutMin', m.arx_scam_timeout(), 1, 40320)}
            {@render channelSelect('scamFilterAlertChannelId', m.arx_alert_channel())}
          </div>

          <div class="grid sm:grid-cols-2 gap-3">
            <label class="block">
              <span class="text-xs font-medium text-on-surface-variant">{m.arx_scam_extra_domains()}</span>
              <textarea
                rows="3"
                value={(config.scamFilterCustomDomains ?? []).join('\n')}
                oninput={(e) => (config.scamFilterCustomDomains = e.currentTarget.value.split('\n').map((s) => s.trim()).filter(Boolean))}
                placeholder="exemple-scam.com"
                class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface font-mono resize-y"
              ></textarea>
            </label>
            <label class="block">
              <span class="text-xs font-medium text-on-surface-variant">{m.arx_scam_whitelist()}</span>
              <textarea
                rows="3"
                value={(config.scamFilterWhitelist ?? []).join('\n')}
                oninput={(e) => (config.scamFilterWhitelist = e.currentTarget.value.split('\n').map((s) => s.trim()).filter(Boolean))}
                placeholder="mon-site.fr"
                class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface font-mono resize-y"
              ></textarea>
            </label>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title={m.arx_tag_role()}
        description={m.arx_tag_desc()}
        icon="Tag"
      >
        <div class="space-y-3">
          {@render switchRow('tagRoleEnabled', m.arx_tag_role(), m.arx_tag_help())}
          {@render roleSelect('tagRoleId', m.arx_tag_role_given())}
        </div>
      </SectionCard>

      <SectionCard
        title={m.arx_reports_title()}
        description={m.arx_reports_desc()}
        icon="Flag"
      >
        <div class="space-y-3">
          {@render switchRow('reportsEnabled', m.arx_reports_switch(), m.arx_reports_help())}
          {@render switchRow('reportsAnonymous', m.arx_reports_anonymous(), m.arx_reports_anonymous_help())}
          <div class="grid sm:grid-cols-2 gap-3">
            {@render channelSelect('reportsChannelId', m.arx_reports_channel())}
            {@render numberField('reportsCooldownSec', m.arx_reports_cooldown(), 0, 3600, m.arx_reports_cooldown_help())}
          </div>
        </div>
      </SectionCard>
    {/if}

    {#if activeTab === 'invites'}
      <SectionCard
        title="Invite Guard"
        description={m.arx_invite_desc()}
        icon="Link"
      >
        <div class="space-y-3">
          {@render switchRow('inviteGuardEnabled', 'Invite Guard', m.arx_invite_guard_help())}
          {@render switchRow('inviteRequireUnitary', m.arx_invite_unitary(), m.arx_invite_unitary_help())}
          {@render switchRow('inviteValidationEnabled', m.arx_invite_validation(), m.arx_invite_validation_help())}

          <div class="grid sm:grid-cols-3 gap-3">
            {@render numberField('inviteSpamThreshold', m.arx_invite_threshold(), 1, 100, m.arx_invite_threshold_help())}
            {@render numberField('inviteSpamWindowSec', m.arx_window_seconds(), 5, 3600)}
            {@render channelSelect('inviteAlertChannelId', m.arx_alert_channel())}
          </div>

          <div>
            <p class="text-xs font-medium text-on-surface-variant mb-2">{m.arx_invite_bypass_roles()}</p>
            <div class="flex flex-wrap gap-1.5">
              {#each roles as role (role.id)}
                <button
                  type="button"
                  class="px-2.5 py-1 rounded-full text-xs font-medium border transition-colors
                  {(config.inviteBypassRoleIds ?? []).includes(role.id)
                    ? 'bg-primary/15 border-primary/40 text-primary'
                    : 'bg-surface-container-low border-outline-variant/40 text-on-surface-variant hover:text-on-surface'}"
                  onclick={() => toggleInList('inviteBypassRoleIds', role.id)}
                >
                  {role.name}
                </button>
              {/each}
            </div>
          </div>
        </div>
      </SectionCard>
    {/if}

    {#if activeTab === 'queues'}
      <SectionCard title={m.arx_queue_reports_title()} icon="Flag">
        {#snippet actions()}
          <RefreshButton onclick={loadQueues} iconOnly />
        {/snippet}

        {#if reports.length === 0}
          <EmptyState icon="ShieldCheck" title={m.arx_queue_reports_empty()} description={m.arx_queue_empty_desc()} reason="all-clear" />
        {:else}
          <div class="space-y-2.5">
            {#each reports as report (report.id)}
              <article class="rounded-xl border border-outline-variant/30 bg-surface-container-low/40 p-3.5">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0 flex-1">
                    <p class="text-body-sm text-on-surface">
                      <code class="text-2xs">{report.reporterId}</code> {m.arx_report_reports()}
                      <code class="text-2xs">{report.targetId}</code>
                      <span class="text-on-surface-variant ml-1">· {formatRelative(report.createdAt)}</span>
                    </p>
                    <p class="mt-1 text-xs text-on-surface-variant leading-relaxed">{report.reason}</p>
                    {#if report.messageContent}
                      <p class="mt-2 text-xs text-on-surface-variant bg-surface-container/60 rounded px-2.5 py-1.5 font-mono break-words">
                        {report.messageContent}
                      </p>
                    {/if}
                    {#if report.channelId}
                      <p class="mt-1 text-2xs text-on-surface-variant">{m.arx_in_channel({ channel: channelName(report.channelId) })}</p>
                    {/if}
                  </div>
                  <div class="flex flex-col gap-1.5 shrink-0">
                    <button
                      type="button"
                      class="px-2.5 py-1 rounded-lg text-xs font-medium bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 disabled:opacity-50 transition-colors"
                      disabled={busyAction !== null}
                      onclick={() => decideReport(report, true)}
                    >
                      {m.arx_report_resolve()}
                    </button>
                    <button
                      type="button"
                      class="px-2.5 py-1 rounded-lg text-xs font-medium text-on-surface-variant border border-outline-variant/40 hover:text-on-surface disabled:opacity-50 transition-colors"
                      disabled={busyAction !== null}
                      onclick={() => decideReport(report, false)}
                    >
                      {m.arx_reject()}
                    </button>
                  </div>
                </div>
              </article>
            {/each}
          </div>
        {/if}
      </SectionCard>

      <SectionCard title={m.arx_queue_invites_title()} icon="Link">
        {#if inviteRequests.length === 0}
          <EmptyState icon="ShieldCheck" title={m.arx_queue_invites_empty()} description={m.arx_queue_invites_empty_desc()} reason="all-clear" />
        {:else}
          <div class="space-y-2.5">
            {#each inviteRequests as request (request.id)}
              <article class="rounded-xl border border-outline-variant/30 bg-surface-container-low/40 p-3.5 flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="text-body-sm text-on-surface">
                    <code class="text-2xs">{request.creatorId}</code> {m.arx_for_channel({ channel: channelName(request.channelId) })}
                  </p>
                  <p class="text-xs text-on-surface-variant mt-0.5">
                    {request.maxUses === 0 ? m.arx_uses_unlimited() : m.arx_uses_count({ count: request.maxUses })} ·
                    {request.maxAgeSec === 0 ? m.arx_no_expiry() : m.arx_hours({ count: Math.round(request.maxAgeSec / 3600) })} ·
                    {formatRelative(request.createdAt)}
                  </p>
                </div>
                <div class="flex flex-col gap-1.5 shrink-0">
                  <button
                    type="button"
                    class="px-2.5 py-1 rounded-lg text-xs font-medium bg-success/15 text-success border border-success/30 hover:bg-success/25 disabled:opacity-50 transition-colors"
                    disabled={busyAction !== null}
                    onclick={() => decideInvite(request, true)}
                  >
                    {m.arx_approve()}
                  </button>
                  <button
                    type="button"
                    class="px-2.5 py-1 rounded-lg text-xs font-medium bg-error/15 text-error border border-error/30 hover:bg-error/25 disabled:opacity-50 transition-colors"
                    disabled={busyAction !== null}
                    onclick={() => decideInvite(request, false)}
                  >
                    {m.arx_reject()}
                  </button>
                </div>
              </article>
            {/each}
          </div>
        {/if}
      </SectionCard>

      <SectionCard
        title={m.arx_lineage_title()}
        description={m.arx_lineage_desc()}
        icon="GitBranch"
      >
        <div class="flex flex-wrap items-end gap-2">
          <label class="block flex-1 min-w-55">
            <span class="text-xs font-medium text-on-surface-variant">{m.arx_lineage_user_id()}</span>
            <input
              type="text"
              bind:value={lineageUserId}
              placeholder="123456789012345678"
              class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface font-mono"
            />
          </label>
          <button
            type="button"
            class="px-3 py-2 rounded-lg text-xs font-medium bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 disabled:opacity-50 transition-colors"
            disabled={lineageLoading}
            use:explainDisabled={(!lineageUserId.trim()) ? m.common_reason_fill_field() : ''}
            onclick={loadLineage}
          >
            {lineageLoading ? m.arx_analyzing() : m.arx_analyze()}
          </button>
        </div>

        {#if lineage}
          <div class="mt-4 space-y-3">
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
              <div class="rounded-lg bg-surface-container/60 px-2 py-2">
                <div class="text-[15px] font-semibold text-on-surface tabular-nums">{lineage.chain.length}</div>
                <div class="text-2xs text-on-surface-variant">{m.arx_lineage_levels()}</div>
              </div>
              <div class="rounded-lg bg-surface-container/60 px-2 py-2">
                <div class="text-[15px] font-semibold text-on-surface tabular-nums">{lineage.directInvites}</div>
                <div class="text-2xs text-on-surface-variant">{m.arx_lineage_direct()}</div>
              </div>
              <div class="rounded-lg bg-surface-container/60 px-2 py-2">
                <div class="text-[15px] font-semibold text-on-surface tabular-nums">{lineage.totalDescendants}</div>
                <div class="text-2xs text-on-surface-variant">{m.arx_lineage_total()}</div>
              </div>
              <div class="rounded-lg px-2 py-2 {lineage.taintedDescendants > 0 ? 'bg-error/10' : 'bg-surface-container/60'}">
                <div class="text-[15px] font-semibold tabular-nums {lineage.taintedDescendants > 0 ? 'text-error' : 'text-on-surface'}">
                  {lineage.taintedDescendants}
                </div>
                <div class="text-2xs text-on-surface-variant">{m.arx_lineage_tainted()}</div>
              </div>
            </div>

            {#if lineage.trust.penalty > 0}
              <div class="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5">
                <p class="text-xs text-on-surface-variant leading-relaxed">
                  {m.arx_penalty_label()} <span class="font-semibold text-warning">−{lineage.trust.penalty}</span>.
                  {m.arx_penalty_sponsor({ depth: lineage.trust.depth })}
                  <code class="text-2xs">{lineage.trust.taintedBy}</code>.
                </p>
              </div>
            {/if}

            {#if lineage.chain.length > 0}
              <div>
                <p class="text-xs text-on-surface-variant mb-1">{m.arx_lineage_chain()}</p>
                <div class="flex flex-wrap items-center gap-1">
                  {#each [...lineage.chain].reverse() as ancestor}
                    <code class="text-2xs px-1.5 py-0.5 rounded bg-surface-container text-on-surface-variant">{ancestor}</code>
                    <span class="text-on-surface-variant/40">→</span>
                  {/each}
                  <code class="text-2xs px-1.5 py-0.5 rounded bg-primary/15 text-primary">{lineage.userId}</code>
                </div>
              </div>
            {/if}

            {#if lineage.totalDescendants > 0}
              <div class="flex flex-wrap items-center gap-2 pt-2 border-t border-outline-variant/30">
                <button
                  type="button"
                  class="px-3 py-1.5 rounded-lg text-xs font-medium bg-surface-container text-on-surface border border-outline-variant/40 hover:border-outline-variant disabled:opacity-50 transition-colors"
                  disabled={busyAction !== null}
                  onclick={() => runQuarantine(true)}
                >
                  {m.arx_quarantine_simulate()}
                </button>
                {#if quarantinePreview !== null}
                  <span class="text-xs text-on-surface-variant">
                    {m.arx_quarantine_preview({ count: quarantinePreview })}
                  </span>
                  <button
                    type="button"
                    class="px-3 py-1.5 rounded-lg text-xs font-medium bg-error/15 text-error border border-error/30 hover:bg-error/25 disabled:opacity-50 transition-colors"
                    disabled={busyAction !== null || quarantinePreview === 0}
                    onclick={() => runQuarantine(false)}
                  >
                    {m.arx_apply()}
                  </button>
                {/if}
              </div>
              <p class="text-2xs text-on-surface-variant">
                {m.arx_quarantine_note1()}
                {m.arx_quarantine_note2()}
              </p>
            {/if}
          </div>
        {/if}
      </SectionCard>

    {/if}

    {#if activeTab === 'vision'}
      <SectionCard
        title="Kotbo Vision"
        description={m.arx_vision_desc()}
        icon="ImageOff"
      >
        <div class="space-y-3">
          {@render switchRow('visionEnabled', 'Kotbo Vision', m.arx_vision_help())}
          <div class="grid sm:grid-cols-3 gap-3">
            <label class="block">
              <span class="text-xs font-medium text-on-surface-variant">{m.arx_vision_sanction()}</span>
              <select
                bind:value={config.visionSanction}
                class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
              >
                {#each SANCTION_OPTIONS as option (option.value)}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>
            </label>
            {#if ['TIMEOUT', 'BAN', 'JAIL'].includes(config.visionSanction)}
              <label class="block">
                <span class="text-xs font-medium text-on-surface-variant">{m.arx_vision_duration()}</span>
                <select
                  bind:value={config.visionDurationMin}
                  class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
                >
                  {#each DURATION_OPTIONS as option (option.label)}
                    {#if option.value !== null || config.visionSanction !== 'TIMEOUT'}
                      <option value={option.value}>{option.label}</option>
                    {/if}
                  {/each}
                </select>
              </label>
            {/if}
            {@render channelSelect('visionReviewChannelId', m.arx_vision_review_channel(), m.arx_vision_review_help())}
          </div>
          {#if config.visionSanction === 'JAIL' && !config.jailRoleId}
            <Callout variant="warning">{m.arx_vision_no_jail()}</Callout>
          {/if}
          {@render switchRow('visionNotifyMember', m.arx_vision_notify(), m.arx_vision_notify_help())}
        </div>
      </SectionCard>

      <VisionPanel {channels} />
    {/if}

    {#if activeTab === 'jail'}
      <SectionCard
        title={m.arx_jail_title()}
        description={m.arx_jail_desc()}
        icon="Lock"
      >
        {#snippet actions()}
          <Button size="sm" variant="secondary" icon="Wrench" disabled={busyAction !== null} onclick={() => setupJail(!config.jailChannelId)}>
            {config.jailRoleId ? m.arx_jail_repair() : m.arx_jail_create()}
          </Button>
        {/snippet}
        <div class="space-y-3">
          {#if !config.jailRoleId}
            <Callout variant="info">{m.arx_jail_create_hint()}</Callout>
          {/if}
          <div class="grid sm:grid-cols-2 gap-3">
            {@render roleSelect('jailRoleId', m.arx_jail_role(), m.arx_jail_role_help())}
            {@render channelSelect('jailChannelId', m.arx_jail_channel(), m.arx_jail_channel_help())}
          </div>
          {@render switchRow('jailStripRoles', m.arx_jail_strip(), m.arx_jail_strip_help())}
          {@render switchRow('discordQuarantineSyncEnabled', m.arx_jail_discord_sync(), m.arx_jail_discord_sync_help())}
        </div>
      </SectionCard>

      <SectionCard title={m.arx_jailed_title()} description={m.arx_jailed_desc()} icon="Users">
        {#if jailed.length === 0}
          <EmptyState icon="CheckCircle" title={m.arx_jailed_empty()} reason="all-clear" />
        {:else}
          <div class="space-y-1.5">
            {#each jailed as jail (jail.userId)}
              <div class="flex items-center justify-between gap-3 rounded-lg border border-outline-variant/30 px-3 py-2">
                <div class="min-w-0">
                  <p class="text-xs text-on-surface font-mono"><MemberName userId={jail.userId} /></p>
                  <p class="text-xs text-on-surface-variant truncate">{JAIL_SOURCES[jail.source] ?? jail.source}{jail.reason ? ` · ${jail.reason}` : ''}</p>
                </div>
                <span class="text-xs text-on-surface-variant shrink-0">
                  {jail.releaseAt ? m.arx_jail_until({ date: new Date(jail.releaseAt).toLocaleString(dateLocale(), { dateStyle: 'short', timeStyle: 'short' }) }) : m.arx_jail_permanent()}
                </span>
              </div>
            {/each}
          </div>
        {/if}
      </SectionCard>
    {/if}

    {#if dirty}
      <div class="sticky bottom-4 z-10">
        <div class="flex items-center justify-between gap-4 rounded-xl border border-primary/40 bg-surface-container-high/95 backdrop-blur px-4 py-3 shadow-lg">
          <p class="text-body-sm text-on-surface">{m.arx_unsaved()}</p>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="px-3 py-1.5 rounded-lg text-xs font-medium text-on-surface-variant hover:text-on-surface transition-colors"
              onclick={() => (config = { ...original })}
              disabled={saving}
            >
              {m.common_cancel()}
            </button>
            <button
              type="button"
              class="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-primary text-on-primary hover:opacity-90 disabled:opacity-50 transition-opacity"
              onclick={save}
              disabled={saving}
            >
              {saving ? m.arx_saving() : m.common_save()}
            </button>
          </div>
        </div>
      </div>
    {/if}
  {/if}
  {/snippet}
</SecurityPage>
