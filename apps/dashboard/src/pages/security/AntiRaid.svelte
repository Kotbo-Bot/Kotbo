<script lang="ts">
  import { explainDisabled } from '../../lib/actions/explainDisabled';
  import { m } from '../../lib/i18n';
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
    MANUAL: 'Manuelle',
    SERVER_TAG: "Tag d'un autre serveur",
    ACCOUNT_AGE: 'Compte trop récent',
    DISCORD_QUARANTINE: 'Quarantaine Discord',
    HONEYPOT: 'Honeypot',
    VISION: 'Kotbo Vision',
  };

  const SANCTION_OPTIONS = [
    { value: 'DELETE', label: 'Supprimer seulement' },
    { value: 'WARN', label: 'Avertissement' },
    { value: 'TIMEOUT', label: 'Timeout' },
    { value: 'JAIL', label: 'Quarantaine (Jail)' },
    { value: 'KICK', label: 'Expulsion' },
    { value: 'SOFTBAN', label: 'Softban' },
    { value: 'BAN', label: 'Bannissement' },
  ];
  const DURATION_OPTIONS: { value: number | null; label: string }[] = [
    { value: 5, label: '5 minutes' },
    { value: 60, label: '1 heure' },
    { value: 1440, label: '1 jour' },
    { value: 10080, label: '7 jours' },
    { value: 43200, label: '30 jours' },
    { value: null, label: 'Permanente' },
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
    { key: 'detection', label: 'Détection & verrous', icon: 'ShieldAlert' },
    { key: 'captcha',   label: "Captcha d'entrée",    icon: 'UserCheck' },
    { key: 'scams',     label: 'Arnaques & tag',      icon: 'Fishing' },
    { key: 'vision',  label: m.sec_tab_antiraid_vision(), icon: 'ImageOff' },
    { key: 'jail',      label: m.sec_tab_antiraid_jail(), icon: 'Lock', count: jailed.length || undefined },
    { key: 'invites',   label: 'Invitations',         icon: 'Link' },
    {
      key: 'queues',
      label: "Files d'attente",
      icon: 'Inbox',
      count: reports.length + inviteRequests.length,
    },
  ]);

  function channelName(id: string | null | undefined): string {
    if (!id) return '-';
    return channels.find((c) => c.id === id)?.name ?? id;
  }

  function formatRelative(value: string): string {
    const diff = Date.now() - new Date(value).getTime();
    const minutes = Math.max(1, Math.floor(diff / 60000));
    if (minutes < 60) return `il y a ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `il y a ${hours} h`;
    return `il y a ${Math.floor(hours / 24)} j`;
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
      error = err instanceof Error ? err.message : 'Impossible de charger la configuration';
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
      toast.error('Impossible de charger les files d\'attente');
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
      toast.success('Configuration enregistrée');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Enregistrement impossible');
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
      title: 'Activer cette mesure d\'urgence ?',
      description: confirmMessage,
      confirmLabel: 'Activer',
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
      toast.error(err instanceof Error ? err.message : 'Action impossible');
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
      toast.success(resolved ? 'Signalement traité' : 'Signalement rejeté');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Décision impossible');
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
      toast.success(approved ? 'Invitation approuvée et recréée' : 'Demande rejetée');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Décision impossible');
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
        toast.success(`Rôle Jail prêt, masqué sur ${res.channelsUpdated} salon(s)`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Création impossible');
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
      toast.error(err instanceof Error ? err.message : 'Analyse impossible');
    } finally {
      lineageLoading = false;
    }
  }

  async function runQuarantine(dryRun: boolean) {
    if (!lineage || busyAction) return;
    if (!dryRun) {
      const confirmed = await confirmDialog.ask({
        title: `Mettre ${quarantinePreview} membre(s) en quarantaine ?`,
        description: 'C\'est réversible, mais les membres concernés le verront.',
        confirmLabel: 'Mettre en quarantaine',
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
        toast.success(`${result?.applied ?? 0} membre(s) mis en quarantaine, ${result?.skipped ?? 0} ignoré(s).`);
        quarantinePreview = null;
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Quarantaine impossible');
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
      <option value={null}>Aucun</option>
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
      <option value={null}>Aucun</option>
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
  title="Anti-raid"
  description="Détection de raid, verrous d'urgence, captcha d'entrée et contrôle des invitations"
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
    <EmptyState icon="AlertTriangle" title="Configuration indisponible" description={error} actionLabel="Réessayer" actionIcon="RefreshCw" onAction={load} />
  {:else}
    <!-- ── Barre d'etat & actions d'urgence ───────────────────────────── -->
    <!-- Seulement sur l'onglet des verrous : repetee sur chaque onglet, elle
         repoussait le contenu propre a l'onglet sous la ligne de flottaison. -->
    {#if activeTab === 'detection'}
    <ShieldCard {config} {channels} onSynced={syncServerFields} />

    <SectionCard
      title="État du serveur"
      description="Ces bascules s'appliquent immédiatement, sans passer par l'enregistrement."
      icon="Zap"
    >
      <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {#each [
          {
            id: 'raidmode',
            label: 'Mode raid',
            active: Boolean(config.raidModeActive),
            help: config.raidModeActive
              ? `Actif${config.raidModeManual ? ' (manuel)' : ` (auto, levée dans ${config.antiRaidAutoDisableMinutes ?? '?'} min)`}`
              : 'Inactif',
            run: () => setRaidMode(!config.raidModeActive, authStore.selectedGuildId),
            confirm: config.raidModeActive ? undefined : 'Activer le mode raid appliquera immédiatement l\'action configurée à toutes les arrivées.',
          },
          {
            id: 'joinlock',
            label: 'Verrou des arrivées',
            active: Boolean(config.joinLockEnabled),
            help: config.joinLockEnabled ? 'Les invitations sont suspendues' : 'Les arrivées sont ouvertes',
            run: () => setJoinLock(!config.joinLockEnabled, undefined, authStore.selectedGuildId),
            confirm: config.joinLockEnabled ? undefined : 'Plus personne ne pourra rejoindre le serveur.',
          },
          {
            id: 'dmlock',
            label: 'Verrou des MP',
            active: Boolean(config.dmLockEnabled),
            help: config.dmLockEnabled ? 'Les MP entre membres sont suspendus' : 'Les MP sont ouverts',
            run: () => setDmLock(!config.dmLockEnabled, undefined, authStore.selectedGuildId),
            confirm: undefined,
          },
          {
            id: 'invite-emergency',
            label: 'Urgence invitations',
            active: Boolean(config.inviteEmergencyEnabled),
            help: config.inviteEmergencyEnabled ? 'Toute invitation est supprimée' : 'Création normale',
            run: () => setInviteEmergency(!config.inviteEmergencyEnabled, authStore.selectedGuildId),
            confirm: config.inviteEmergencyEnabled ? undefined : 'Toutes les invitations existantes seront supprimées, et toute nouvelle invitation le sera aussi.',
          },
        ] as control (control.id)}
          <button
            type="button"
            class="text-left rounded-xl border px-4 py-3.5 transition-colors disabled:opacity-50
            {control.active
              ? 'border-error/40 bg-error/10 hover:bg-error/15'
              : 'border-outline-variant/30 bg-surface-container-low/40 hover:border-outline-variant/60'}"
            disabled={busyAction !== null}
            onclick={() => runEmergency(control.id, control.run, `${control.label} : ${control.active ? 'désactivé' : 'activé'}`, control.confirm)}
          >
            <div class="flex items-center justify-between gap-2">
              <span class="text-body-sm font-medium text-on-surface">{control.label}</span>
              <span
                class="w-2 h-2 rounded-full shrink-0 {control.active ? 'bg-error animate-pulse' : 'bg-outline-variant'}"
              ></span>
            </div>
            <p class="text-xs mt-1 {control.active ? 'text-error' : 'text-on-surface-variant'}">
              {busyAction === control.id ? 'Application…' : control.help}
            </p>
          </button>
        {/each}
      </div>

      <div class="mt-4 grid grid-cols-3 gap-3 text-center">
        <div class="rounded-lg bg-surface-container/60 px-3 py-2">
          <div class="text-[15px] font-semibold text-on-surface tabular-nums">{reportStats?.pending ?? 0}</div>
          <div class="text-2xs text-on-surface-variant">signalements en attente</div>
        </div>
        <div class="rounded-lg bg-surface-container/60 px-3 py-2">
          <div class="text-[15px] font-semibold text-on-surface tabular-nums">{pendingInvites}</div>
          <div class="text-2xs text-on-surface-variant">invitations à valider</div>
        </div>
        <div class="rounded-lg bg-surface-container/60 px-3 py-2">
          <div class="text-[15px] font-semibold text-on-surface tabular-nums">{scamImageCount}</div>
          <div class="text-2xs text-on-surface-variant">empreintes d'arnaque</div>
        </div>
      </div>
    </SectionCard>
    {/if}

    {#if activeTab === 'detection'}
      <SectionCard
        title="Détection de raid"
        description="Une vague d'arrivées anormale déclenche automatiquement le mode raid."
        icon="ShieldAlert"
      >
        <div class="space-y-3">
          {@render switchRow('antiRaidEnabled', 'Anti-raid', 'Surveille le rythme des arrivées sur une fenêtre glissante et bascule le serveur en mode raid au-delà du seuil.')}

          <div class="grid sm:grid-cols-2 gap-3">
            {@render numberField('antiRaidJoinThreshold', 'Seuil d\'arrivées', 2, 200, 'Nombre d\'arrivées déclenchant le mode raid.')}
            {@render numberField('antiRaidJoinWindowSec', 'Fenêtre (secondes)', 5, 600, 'Durée sur laquelle les arrivées sont comptées.')}
          </div>

          <label class="block">
            <span class="text-xs font-medium text-on-surface-variant">Action au déclenchement</span>
            <select
              bind:value={config.antiRaidAction}
              class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
            >
              <option value="LOCK">Verrouiller les arrivées</option>
              <option value="CAPTCHA">Forcer le captcha pour tous les arrivants</option>
              <option value="KICK">Expulser automatiquement les arrivants</option>
            </select>
            <p class="text-2xs text-on-surface-variant mt-1">
              « Expulser » est la plus brutale : elle rejette aussi les arrivées légitimes pendant toute la durée du mode raid.
            </p>
          </label>

          <div class="grid sm:grid-cols-2 gap-3">
            {@render channelSelect('antiRaidAlertChannelId', 'Salon d\'alerte', 'Sans salon d\'alerte, le mode raid s\'active sans que personne ne soit prévenu.')}
            {@render numberField('antiRaidAutoDisableMinutes', 'Levée automatique (minutes)', 1, 1440, 'Durée du mode raid déclenché automatiquement.')}
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Comptes trop récents"
        description="Traite à l'arrivée les comptes Discord créés depuis moins longtemps que le seuil."
        icon="UserX"
      >
        <div class="space-y-3">
          {@render switchRow('accountAgeGuardEnabled', 'Ancienneté minimale du compte', 'Chaque arrivée est comparée à la date de création du compte Discord. Les bots ne sont jamais concernés.')}

          <div class="grid sm:grid-cols-3 gap-3">
            {@render numberField('accountAgeMinValue', 'Ancienneté minimale', 1, config.accountAgeMinUnit === 'MONTHS' ? 120 : 3650)}
            <label class="block">
              <span class="text-xs font-medium text-on-surface-variant">Unité</span>
              <select
                bind:value={config.accountAgeMinUnit}
                class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
              >
                <option value="DAYS">Jours</option>
                <option value="MONTHS">Mois</option>
              </select>
            </label>
            <label class="block">
              <span class="text-xs font-medium text-on-surface-variant">Action</span>
              <select
                bind:value={config.accountAgeAction}
                class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
              >
                <option value="ALERT">Signaler uniquement</option>
                <option value="KICK">Expulser</option>
                <option value="JAIL">Quarantaine jusqu'à l'âge requis</option>
                <option value="TEMPBAN">Bannir jusqu'à l'âge requis</option>
                <option value="BAN">Bannir définitivement</option>
              </select>
            </label>
          </div>

          {#if (config.accountAgeMinUnit === 'MONTHS' ? config.accountAgeMinValue * 30 : config.accountAgeMinValue) >= 365}
            <p class="text-2xs text-warning leading-relaxed">
              Seuil d'un an ou plus : une grande partie des arrivées légitimes sera concernée. Vérifie l'unité.
            </p>
          {/if}

          {#if config.accountAgeAction === 'JAIL'}
            <p class="text-2xs text-on-surface-variant leading-relaxed">
              Le compte entre sans rien voir (rôle Jail) et sort de quarantaine tout seul à la date où il atteint l'âge requis. Il est prévenu en MP de cette date.{#if !config.jailRoleId} Aucun rôle Jail configuré : ce sera un bannissement jusqu'à la même date.{/if}
            </p>
          {/if}

          {#if config.accountAgeAction === 'BAN'}
            <p class="text-2xs text-error/90 leading-relaxed">
              Le bannissement est définitif : le membre ne pourra plus revenir, même une fois son compte assez ancien, sauf déban manuel suivi d'une exemption ci-dessous.
            </p>
          {/if}

          <div class="grid sm:grid-cols-2 gap-3">
            {@render channelSelect('accountAgeAlertChannelId', 'Salon d\'alerte', 'Chaque compte refoulé ou signalé y est publié.')}
            <label class="block">
              <span class="text-xs font-medium text-on-surface-variant">Message envoyé en MP</span>
              <textarea
                rows="2"
                bind:value={config.accountAgeMessage}
                class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface resize-y"
              ></textarea>
              <p class="text-2xs text-on-surface-variant mt-1">Envoyé avant l'expulsion ou le bannissement.</p>
            </label>
          </div>

          <label class="block">
            <span class="text-xs font-medium text-on-surface-variant">Membres exemptés (identifiants)</span>
            <textarea
              rows="2"
              value={(config.accountAgeWhitelist ?? []).join('\n')}
              oninput={(e) => (config.accountAgeWhitelist = e.currentTarget.value.split('\n').map((s) => s.trim()).filter(Boolean))}
              placeholder="123456789012345678"
              class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface font-mono resize-y"
            ></textarea>
            <p class="text-2xs text-on-surface-variant mt-1">Un identifiant par ligne. Permet de laisser entrer un compte récent légitime.</p>
          </label>
        </div>
      </SectionCard>

      <SectionCard
        title="Rôles rendus au retour"
        description="Un membre qui quitte puis revient retrouve les rôles qu'il avait au départ."
        icon="UserPlus"
      >
        <div class="space-y-3">
          {@render switchRow('rolePersistEnabled', 'Rôles persistants', 'Les rôles sont mémorisés au départ et rendus à l\'arrivée, après le captcha s\'il est actif. Les rôles de modération ou d\'administration ne sont rendus que si l\'option ci-dessous est active ; ceux gérés par une intégration, ceux placés au-dessus du bot et ceux du captcha ou de la vérification ne le sont jamais.')}
          {@render switchRow('rolePersistStaff', 'Rendre aussi les rôles staff et admin', 'Un membre du staff qui revient retrouve ses rôles à permissions (donc son accès à la configuration) et son entrée dans l\'annuaire du staff. Ignoré pour un membre suspendu ou blacklisté.')}

          <div class="grid sm:grid-cols-2 gap-3">
            <label class="block">
              <span class="text-xs font-medium text-on-surface-variant">Rôles concernés</span>
              <select
                bind:value={config.rolePersistMode}
                class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
              >
                <option value="ALL">Tous, sauf ceux sélectionnés</option>
                <option value="LIST">Seulement ceux sélectionnés</option>
              </select>
            </label>
            {@render numberField('rolePersistMaxDays', 'Durée de conservation (jours)', 1, 365, 'Au-delà, le membre revient sans ses rôles.')}
          </div>

          <div>
            <p class="text-xs font-medium text-on-surface-variant mb-2">
              {config.rolePersistMode === 'LIST' ? 'Rôles rendus' : 'Rôles jamais rendus'}
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
              Aucun rôle sélectionné : personne ne retrouvera de rôle à son retour.
            </p>
          {/if}
        </div>
      </SectionCard>

      <SectionCard title="Verrou des arrivées" description="Comportement quand le verrou est actif." icon="Lock">
        <div class="space-y-3">
          {@render switchRow('joinLockKick', 'Expulser les arrivées malgré le verrou', 'La suspension des invitations par Discord n\'est pas absolue : ce filet expulse les membres qui passent quand même.')}
          <label class="block">
            <span class="text-xs font-medium text-on-surface-variant">Message envoyé en MP</span>
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
        title="Captcha des nouveaux membres"
        description="Filtre les comptes automatisés à l'entrée."
        icon="UserCheck"
      >
        <CaptchaFields bind:config />
        <div class="grid sm:grid-cols-2 gap-3 mt-4">
          <label class="block">
            <span class="text-xs font-medium text-on-surface-variant">Déclenchement</span>
            <select
              bind:value={config.captchaTrigger}
              class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
            >
              <option value="ALWAYS">En permanence : chaque arrivée</option>
              <option value="AUTO">Automatique : pendant un raid ou une alerte Shield</option>
              <option value="SMART">Intelligent : automatique + comptes au profil suspect</option>
            </select>
            <p class="text-2xs text-on-surface-variant mt-1">
              {#if config.captchaTrigger === 'SMART'}
                Suspect : compte très récent, avatar par défaut, pseudo généré, signalé spammeur ou mis en quarantaine par Discord. Un membre exempté par l'équipe n'est jamais suspect.
              {:else if config.captchaTrigger === 'AUTO'}
                Hors raid, les arrivants entrent directement. À partir de Shield 3, tout le monde passe le captcha.
              {:else}
                Chaque arrivant passe le captcha, raid ou pas.
              {/if}
            </p>
          </label>
          <div class="flex items-start justify-between gap-4 rounded-xl border border-outline-variant/30 px-4 py-3">
            <div class="min-w-0">
              <p class="text-body-sm font-medium text-on-surface">Captcha à l'image du serveur</p>
              <p class="text-xs text-on-surface-variant mt-1 leading-relaxed">L'icône du serveur est incrustée dans l'image du captcha, et ses couleurs reprises.</p>
            </div>
            <ToggleSwitch checked={config.captchaUseServerIcon !== false} onToggle={(v) => (config.captchaUseServerIcon = v)} />
          </div>
        </div>
      </SectionCard>
    {/if}

    {#if activeTab === 'scams'}
      <SectionCard
        title="Filtre anti-arnaque"
        description="Bloque les liens de phishing (faux Nitro, faux Steam), les faux giveaways crypto/casino et les faux recrutements « revenu facile ». Les images d'arnaque connues relèvent de l'onglet Kotbo Vision."
        icon="Fishing"
      >
        {#snippet actions()}
          <!-- Le simulateur vit dans les filtres AutoMod : il rejoue l'analyse
               de texte et de domaines sur les messages passés. -->
          <Button size="sm" variant="ghost" icon="history" href="/security/filters/simulator?rule=scam">Tester sur l'historique</Button>
        {/snippet}
        <div class="space-y-3">
          {@render switchRow('scamFilterEnabled', 'Filtre anti-arnaque', 'Analyse les domaines et les combinaisons de texte typiques des campagnes de phishing.')}
          {@render switchRow('scamQrFilterEnabled', 'Filtre de codes QR', 'Le phishing par QR de connexion Discord ne contient aucun lien : aucun filtre de domaine ne peut l\'attraper. Les images porteuses d\'un code QR envoyées par un compte sans historique sont bloquées.')}

          {@render switchRow('scamOcrEnabled', 'Lecture du texte des images', 'Lit le texte des images postées par un compte sans historique (lecture locale, aucune image n\'est envoyée à un tiers) et le compare aux domaines et textes d\'arnaque connus. Rattrape les captures photographiées ou recadrées que la comparaison d\'empreintes ne reconnaît pas. Consomme du processeur : à activer si le serveur est visé par ces campagnes.')}

          {#if config.scamQrFilterEnabled || config.scamOcrEnabled}
            <div class="rounded-xl border border-outline-variant/30 p-3">
              {@render numberField('scamQrTrustedMessages', 'Messages avant d\'être considéré comme installé', 0, 10000, 'Au-delà, le membre n\'est plus concerné par le filtre de codes QR ni par la lecture du texte des images : partager un QR wifi ou 2FA est légitime.')}
            </div>
          {/if}

          <div class="grid sm:grid-cols-3 gap-3">
            <label class="block">
              <span class="text-xs font-medium text-on-surface-variant">Action</span>
              <select
                bind:value={config.scamFilterAction}
                class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
              >
                <option value="DELETE">Supprimer</option>
                <option value="DELETE_AND_WARN">Supprimer et avertir</option>
                <option value="DELETE_AND_TIMEOUT">Supprimer et exclure</option>
                <option value="DELETE_AND_BAN">Supprimer et bannir</option>
              </select>
            </label>
            {@render numberField('scamFilterTimeoutMin', 'Exclusion (minutes)', 1, 40320)}
            {@render channelSelect('scamFilterAlertChannelId', 'Salon d\'alerte')}
          </div>

          <div class="grid sm:grid-cols-2 gap-3">
            <label class="block">
              <span class="text-xs font-medium text-on-surface-variant">Domaines bloqués supplémentaires</span>
              <textarea
                rows="3"
                value={(config.scamFilterCustomDomains ?? []).join('\n')}
                oninput={(e) => (config.scamFilterCustomDomains = e.currentTarget.value.split('\n').map((s) => s.trim()).filter(Boolean))}
                placeholder="exemple-scam.com"
                class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface font-mono resize-y"
              ></textarea>
            </label>
            <label class="block">
              <span class="text-xs font-medium text-on-surface-variant">Domaines exemptés</span>
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
        title="Rôle de tag"
        description="Récompense les membres qui arborent le tag du serveur sur leur profil."
        icon="Tag"
      >
        <div class="space-y-3">
          {@render switchRow('tagRoleEnabled', 'Rôle de tag', 'Le rôle est attribué automatiquement dès qu\'un membre affiche le tag du serveur, et retiré dès qu\'il l\'enlève.')}
          {@render roleSelect('tagRoleId', 'Rôle attribué')}
        </div>
      </SectionCard>

      <SectionCard
        title="Signalements communautaires"
        description="Donne aux membres un canal structuré pour remonter les abus."
        icon="Flag"
      >
        <div class="space-y-3">
          {@render switchRow('reportsEnabled', 'Signalements', 'Les membres peuvent signaler un message ou un membre vers un salon staff.')}
          {@render switchRow('reportsAnonymous', 'Signalements anonymes', 'Masque l\'auteur du signalement dans l\'embed staff. Réduit la peur des représailles, au prix de la traçabilité des abus de signalement.')}
          <div class="grid sm:grid-cols-2 gap-3">
            {@render channelSelect('reportsChannelId', 'Salon des signalements')}
            {@render numberField('reportsCooldownSec', 'Délai entre deux signalements (s)', 0, 3600, 'Anti-abus.')}
          </div>
        </div>
      </SectionCard>
    {/if}

    {#if activeTab === 'invites'}
      <SectionCard
        title="Invite Guard"
        description="Contrôle qui ouvre le serveur, et comment."
        icon="Link"
      >
        <div class="space-y-3">
          {@render switchRow('inviteGuardEnabled', 'Invite Guard', 'Surveille et journalise les créations d\'invitations.')}
          {@render switchRow('inviteRequireUnitary', 'Exiger des invitations unitaires', 'Toute invitation à usages multiples ou illimités est supprimée. C\'est ce qui rend la source d\'un raid identifiable après coup.')}
          {@render switchRow('inviteValidationEnabled', 'Validation par le staff', 'Chaque invitation est supprimée puis recréée seulement après approbation.')}

          <div class="grid sm:grid-cols-3 gap-3">
            {@render numberField('inviteSpamThreshold', 'Seuil de création', 1, 100, 'Alerte au-delà de N créations.')}
            {@render numberField('inviteSpamWindowSec', 'Fenêtre (secondes)', 5, 3600)}
            {@render channelSelect('inviteAlertChannelId', 'Salon d\'alerte')}
          </div>

          <div>
            <p class="text-xs font-medium text-on-surface-variant mb-2">Rôles exemptés</p>
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
      <SectionCard title="Signalements en attente" icon="Flag">
        {#snippet actions()}
          <RefreshButton onclick={loadQueues} iconOnly />
        {/snippet}

        {#if reports.length === 0}
          <EmptyState icon="ShieldCheck" title="Aucun signalement en attente" description="La file est vide." reason="all-clear" />
        {:else}
          <div class="space-y-2.5">
            {#each reports as report (report.id)}
              <article class="rounded-xl border border-outline-variant/30 bg-surface-container-low/40 p-3.5">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0 flex-1">
                    <p class="text-body-sm text-on-surface">
                      <code class="text-2xs">{report.reporterId}</code> signale
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
                      <p class="mt-1 text-2xs text-on-surface-variant">dans #{channelName(report.channelId)}</p>
                    {/if}
                  </div>
                  <div class="flex flex-col gap-1.5 shrink-0">
                    <button
                      type="button"
                      class="px-2.5 py-1 rounded-lg text-xs font-medium bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 disabled:opacity-50 transition-colors"
                      disabled={busyAction !== null}
                      onclick={() => decideReport(report, true)}
                    >
                      Traiter
                    </button>
                    <button
                      type="button"
                      class="px-2.5 py-1 rounded-lg text-xs font-medium text-on-surface-variant border border-outline-variant/40 hover:text-on-surface disabled:opacity-50 transition-colors"
                      disabled={busyAction !== null}
                      onclick={() => decideReport(report, false)}
                    >
                      Rejeter
                    </button>
                  </div>
                </div>
              </article>
            {/each}
          </div>
        {/if}
      </SectionCard>

      <SectionCard title="Invitations à valider" icon="Link">
        {#if inviteRequests.length === 0}
          <EmptyState icon="ShieldCheck" title="Aucune demande" description="Aucune invitation en attente de validation." reason="all-clear" />
        {:else}
          <div class="space-y-2.5">
            {#each inviteRequests as request (request.id)}
              <article class="rounded-xl border border-outline-variant/30 bg-surface-container-low/40 p-3.5 flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="text-body-sm text-on-surface">
                    <code class="text-2xs">{request.creatorId}</code> pour #{channelName(request.channelId)}
                  </p>
                  <p class="text-xs text-on-surface-variant mt-0.5">
                    {request.maxUses === 0 ? 'usages illimités' : `${request.maxUses} usage(s)`} ·
                    {request.maxAgeSec === 0 ? 'sans expiration' : `${Math.round(request.maxAgeSec / 3600)} h`} ·
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
                    Approuver
                  </button>
                  <button
                    type="button"
                    class="px-2.5 py-1 rounded-lg text-xs font-medium bg-error/15 text-error border border-error/30 hover:bg-error/25 disabled:opacity-50 transition-colors"
                    disabled={busyAction !== null}
                    onclick={() => decideInvite(request, false)}
                  >
                    Rejeter
                  </button>
                </div>
              </article>
            {/each}
          </div>
        {/if}
      </SectionCard>

      <SectionCard
        title="Lignage des invitations"
        description="D'où vient un membre, et qui est entré par la même porte. Quand un raideur est démasqué, ses invités le sont rarement seuls."
        icon="GitBranch"
      >
        <div class="flex flex-wrap items-end gap-2">
          <label class="block flex-1 min-w-55">
            <span class="text-xs font-medium text-on-surface-variant">Identifiant du membre</span>
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
            {lineageLoading ? 'Analyse…' : 'Analyser'}
          </button>
        </div>

        {#if lineage}
          <div class="mt-4 space-y-3">
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
              <div class="rounded-lg bg-surface-container/60 px-2 py-2">
                <div class="text-[15px] font-semibold text-on-surface tabular-nums">{lineage.chain.length}</div>
                <div class="text-2xs text-on-surface-variant">niveaux de parrainage</div>
              </div>
              <div class="rounded-lg bg-surface-container/60 px-2 py-2">
                <div class="text-[15px] font-semibold text-on-surface tabular-nums">{lineage.directInvites}</div>
                <div class="text-2xs text-on-surface-variant">invités directs</div>
              </div>
              <div class="rounded-lg bg-surface-container/60 px-2 py-2">
                <div class="text-[15px] font-semibold text-on-surface tabular-nums">{lineage.totalDescendants}</div>
                <div class="text-2xs text-on-surface-variant">descendance totale</div>
              </div>
              <div class="rounded-lg px-2 py-2 {lineage.taintedDescendants > 0 ? 'bg-error/10' : 'bg-surface-container/60'}">
                <div class="text-[15px] font-semibold tabular-nums {lineage.taintedDescendants > 0 ? 'text-error' : 'text-on-surface'}">
                  {lineage.taintedDescendants}
                </div>
                <div class="text-2xs text-on-surface-variant">déjà sanctionnés</div>
              </div>
            </div>

            {#if lineage.trust.penalty > 0}
              <div class="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5">
                <p class="text-xs text-on-surface-variant leading-relaxed">
                  Pénalité de confiance héritée : <span class="font-semibold text-warning">−{lineage.trust.penalty}</span>.
                  Parrain problématique au degré {lineage.trust.depth} :
                  <code class="text-2xs">{lineage.trust.taintedBy}</code>.
                </p>
              </div>
            {/if}

            {#if lineage.chain.length > 0}
              <div>
                <p class="text-xs text-on-surface-variant mb-1">Chaîne de parrainage</p>
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
                  Simuler la quarantaine
                </button>
                {#if quarantinePreview !== null}
                  <span class="text-xs text-on-surface-variant">
                    {quarantinePreview} membre(s) seraient mis en quarantaine.
                  </span>
                  <button
                    type="button"
                    class="px-3 py-1.5 rounded-lg text-xs font-medium bg-error/15 text-error border border-error/30 hover:bg-error/25 disabled:opacity-50 transition-colors"
                    disabled={busyAction !== null || quarantinePreview === 0}
                    onclick={() => runQuarantine(false)}
                  >
                    Appliquer
                  </button>
                {/if}
              </div>
              <p class="text-2xs text-on-surface-variant">
                La quarantaine pose un rôle restrictif ou une exclusion de 24 h - jamais un bannissement.
                Le staff n'est jamais touché. La décision définitive reste humaine.
              </p>
            {/if}
          </div>
        {/if}
      </SectionCard>

    {/if}

    {#if activeTab === 'vision'}
      <SectionCard
        title="Kotbo Vision"
        description="Compare chaque image postée (pièces jointes, embeds, messages transférés, stickers) aux images d'arnaque connues : catalogue global, catalogue du serveur et tes listes. Une variante recadrée, retournée, recompressée ou prise en capture reste reconnue."
        icon="ImageOff"
      >
        <div class="space-y-3">
          {@render switchRow('visionEnabled', 'Kotbo Vision', "Actif par défaut. Correspondance certaine : message supprimé et auteur sanctionné. Correspondance incertaine : message supprimé par précaution, sans sanction, et envoyé en vérification.")}
          <div class="grid sm:grid-cols-3 gap-3">
            <label class="block">
              <span class="text-xs font-medium text-on-surface-variant">Sanction</span>
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
                <span class="text-xs font-medium text-on-surface-variant">Durée</span>
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
            {@render channelSelect('visionReviewChannelId', 'Salon de vérification', "Pour le catalogue global et celui du serveur. Sans salon, les correspondances incertaines restent silencieuses.")}
          </div>
          {#if config.visionSanction === 'JAIL' && !config.jailRoleId}
            <Callout variant="warning">Aucun rôle Jail configuré : la quarantaine sera remplacée par un timeout. Configure-le dans l'onglet Quarantaine.</Callout>
          {/if}
          {@render switchRow('visionNotifyMember', 'Prévenir le membre en MP', "Explique pourquoi le message a disparu et rappelle quoi faire si le compte a été piraté (mot de passe, double authentification).")}
        </div>
      </SectionCard>

      <VisionPanel {channels} />
    {/if}

    {#if activeTab === 'jail'}
      <SectionCard
        title="Quarantaine (Jail)"
        description="Le membre reste sur le serveur mais n'y voit plus rien. Ses rôles lui sont retirés puis rendus à la levée. Sert à /sanction jail, à Kotbo Vision, au honeypot et aux arrivées suspectes."
        icon="Lock"
      >
        {#snippet actions()}
          <Button size="sm" variant="secondary" icon="Wrench" disabled={busyAction !== null} onclick={() => setupJail(!config.jailChannelId)}>
            {config.jailRoleId ? 'Réparer le rôle' : 'Créer le rôle Jail'}
          </Button>
        {/snippet}
        <div class="space-y-3">
          {#if !config.jailRoleId}
            <Callout variant="info">Crée le rôle en un clic : Kotbo le masque sur tous les salons (y compris ceux créés plus tard) et ouvre un salon #quarantaine où le staff peut échanger avec les membres concernés.</Callout>
          {/if}
          <div class="grid sm:grid-cols-2 gap-3">
            {@render roleSelect('jailRoleId', 'Rôle Jail', "Refusé sur tous les salons. « Réparer le rôle » repose le refus là où il manque.")}
            {@render channelSelect('jailChannelId', 'Salon de quarantaine', "Le seul salon visible en quarantaine. Facultatif.")}
          </div>
          {@render switchRow('jailStripRoles', 'Retirer les rôles du membre', "Sans ça, un rôle qui ouvre un salon annulerait la quarantaine. Les rôles sont rendus à la levée.")}
        </div>
      </SectionCard>

      <SectionCard title="Membres en quarantaine" description="Levée automatique à la date indiquée. Une quarantaine permanente se lève avec /sanction unjail." icon="Users">
        {#if jailed.length === 0}
          <EmptyState icon="CheckCircle" title="Personne en quarantaine" reason="all-clear" />
        {:else}
          <div class="space-y-1.5">
            {#each jailed as jail (jail.userId)}
              <div class="flex items-center justify-between gap-3 rounded-lg border border-outline-variant/30 px-3 py-2">
                <div class="min-w-0">
                  <p class="text-xs text-on-surface font-mono">{jail.userId}</p>
                  <p class="text-xs text-on-surface-variant truncate">{JAIL_SOURCES[jail.source] ?? jail.source}{jail.reason ? ` · ${jail.reason}` : ''}</p>
                </div>
                <span class="text-xs text-on-surface-variant shrink-0">
                  {jail.releaseAt ? `jusqu'au ${new Date(jail.releaseAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}` : 'permanente'}
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
          <p class="text-body-sm text-on-surface">Modifications non enregistrées</p>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="px-3 py-1.5 rounded-lg text-xs font-medium text-on-surface-variant hover:text-on-surface transition-colors"
              onclick={() => (config = { ...original })}
              disabled={saving}
            >
              Annuler
            </button>
            <button
              type="button"
              class="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-primary text-on-primary hover:opacity-90 disabled:opacity-50 transition-opacity"
              onclick={save}
              disabled={saving}
            >
              {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </div>
      </div>
    {/if}
  {/if}
  {/snippet}
</SecurityPage>
