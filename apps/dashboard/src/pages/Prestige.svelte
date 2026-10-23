<script lang="ts">
  import { explainDisabled } from '../lib/actions/explainDisabled';
  /**
   * Prestige - pilotage du classement competitif (RP).
   *
   * Le module se greffe sur le leveling : les gains de RP derivent de l'XP
   * reellement accordee, d'ou l'absence ici de tout reglage de cooldown ou
   * d'exclusion de salon, qui vivent sur la page Niveaux.
   *
   * La page se regle comme celle des niveaux : on entre par des prereglages, et
   * la configuration detaillee attend derriere des onglets, avec les memes
   * curseurs a crans et le meme mode avance. Les paliers, eux, ne se saisissent
   * plus un par un : une courbe les pose tous, et le nombre de paliers - donc de
   * roles a tenir - est le premier curseur de la carte.
   */
  import { onDestroy, untrack } from 'svelte';
  import { router } from 'tinro';
  import {
    fetchRankedOverview,
    updateRankedConfig,
    setRankedTierRole,
    removeRankedTierRole,
    createRankedEvent,
    cancelRankedEvent,
    previewRankedDecay,
    runRankedDecay,
    fetchRankedLadderImpact,
    provisionRankedTierRoles,
    deleteRankedTierRoles,
    fetchRankedTierRoleSync,
    runRankedTierRoleSync,
    fetchRankedLeaderboard,
    fetchRankedGlobalLeaderboard,
    fetchRankedMember,
    adjustRankedMember,
    createRankedAnnounceChannel,
  } from '../lib/api';
  import { isMissingReference } from '../lib/discordReferences';
  import { channelDisplayName } from '../lib/channelUtils';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { pageTabItems } from '../lib/config/pageTabs';
  import { Tabs, FilterPills } from '../lib/components/ui';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import { createSimpleModePreference, nearestStep } from '../lib/simpleMode.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import SectionCard from '../lib/components/SectionCard.svelte';
  import MetricCard from '../lib/components/MetricCard.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import UserDisplay from '../lib/components/UserDisplay.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import ModuleDisabledNotice from '../lib/components/ModuleDisabledNotice.svelte';
  import LoadingHint from '../lib/components/LoadingHint.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import SimpleModeToggle from '../lib/components/SimpleModeToggle.svelte';
  import SimpleModeNotice from '../lib/components/SimpleModeNotice.svelte';
  import RankedPresetPicker from '../lib/components/RankedPresetPicker.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import { m } from '../lib/i18n';
  import {
    DECAY_STEPS,
    DEFAULT_LADDER_CURVE,
    LADDER_CURVE_LIMITS,
    LADDER_EXPONENT_STEPS,
    LADDER_PACE_FACTORS,
    LADDER_REFERENCE_BASE_RP,
    RP_GAIN_STEPS,
    STREAK_STEPS,
    computeRankedDecay,
    findRankedPreset,
    generateRankedLadder,
    ladderApexRp,
    ladderMatchesCurve,
    ladderPaceBaseRp,
    rankedFloorRp,
    rankedPresetValues,
    rankedTierIndex,
    streakMultiplier,
    type RankedLadder,
    type RankedPreset,
    type RankedPresetValues,
  } from '@kotbo/shared';

  type Tier = { key: string; tier: string; division: number; name: string; minRp: number; color: string };
  type LeaderboardEntry = { rank: number; userId: string; rp: number; tier: Tier; streakDays: number; flames: number; percent: number };
  type StreakEntry = { rank: number; userId: string; streakDays: number; bestStreak: number; flames: number; displayName?: string | null; avatarUrl?: string | null };
  type RankedEvent = {
    id: string;
    type: string;
    name: string;
    multiplier: number;
    startsAt: string;
    endsAt: string;
    status: string;
    participants: number;
    bonusRpGranted: number;
  };

  const prestigeTabs = ['accueil', 'gains', 'echelle', 'annonces', 'evenements', 'classement'] as const;
  type PrestigeTab = (typeof prestigeTabs)[number];
  const DEFAULT_TAB: PrestigeTab = 'accueil';
  let activeTab = $state<PrestigeTab>(DEFAULT_TAB);

  $effect(() => {
    const _path = $router.path;
    activeTab = resolveTabFromUrl('/prestige', prestigeTabs, DEFAULT_TAB) as PrestigeTab;
  });

  const saveAction = createAsyncActionState();
  const roleAction = createAsyncActionState();

  let loading = $state(true);
  let config = $state<Record<string, any> | null>(null);
  let savedConfig = $state<Record<string, any> | null>(null);
  let savedLadder = $state<RankedLadder>([]);
  let tierRoles = $state<Array<{ tierKey: string; roleId: string }>>([]);
  let stats = $state<any>(null);
  let leaderboard = $state<LeaderboardEntry[]>([]);
  let streaks = $state<StreakEntry[]>([]);
  let events = $state<RankedEvent[]>([]);
  let decayPreview = $state<{ affected: number; rpLost: number } | null>(null);

  let showEventForm = $state(false);
  let newEvent = $state({ type: 'MESSAGE_RUSH', name: '', multiplier: 2, durationMinutes: 60, announceChannelId: '' });

  /**
   * L'API ferme les routes d'un module eteint (403 `module_disabled`), comme
   * pour tous les autres modules. Sans ce garde-fou, ouvrir la page d'un
   * prestige desactive declencherait un appel voue a l'echec et un bandeau
   * d'erreur trompeur : le module n'est pas en panne, il est juste eteint.
   *
   * L'etat est a trois valeurs : tant que le store n'a pas rendu la liste des
   * modules, on ne sait pas encore. Repondre « actif » dans cet intervalle
   * lancait le chargement avant l'heure, et l'API le refusait.
   */
  const moduleStatus = $derived.by<'unknown' | 'enabled' | 'disabled'>(() => {
    const list = (dashboardStore.state.modules ?? []) as Array<{ id: string; status: string }>;
    if (list.length === 0) return 'unknown';
    const mod = list.find((entry) => entry.id === 'prestige');
    if (!mod) return 'enabled';
    return mod.status === 'active' ? 'enabled' : 'disabled';
  });
  const moduleEnabled = $derived(moduleStatus !== 'disabled');

  /**
   * Le serveur refuse deja toute ecriture sans ce droit : la page se contente
   * de ne pas proposer ce qu'il refuserait, plutot que de laisser cliquer pour
   * un 403.
   */
  const canManageSettings = $derived(
    !!(dashboardStore.state.featureAccess as any)?.prestige?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings,
  );

  const channels = $derived(dashboardStore.state.discordChannels ?? []);
  const roles = $derived(dashboardStore.state.discordRoles ?? []);

  const EVENT_TYPES = [
    { value: 'MESSAGE_RUSH', label: 'Message Rush' },
    { value: 'REACTION_STORM', label: 'Reaction Storm' },
    { value: 'VOCAL_TIME', label: 'Vocal Time' },
    { value: 'CUSTOM', label: 'Custom' },
  ];

  /** Colonnes que la page edite : le reste de la config n'est pas renvoye. */
  const EDITABLE_KEYS = [
    'rpPerXp', 'reactionRp', 'reactionDailyCap', 'dailyRpCap',
    'streakEnabled', 'streakBonusPerDay', 'streakMaxBonus', 'streakGraceDays',
    'streakWeeklyFreezes', 'streakMaxFreezes',
    'decayEnabled', 'decayGraceDays', 'decayRpPerDay', 'decayPercentPerDay', 'decayFloorTierKey',
    'ladderTierCount', 'ladderBaseRp', 'ladderExponent', 'ladderDivisions',
    'tierRolesEnabled', 'tierRolesExclusive',
    'announceChannelId', 'announcePromotions', 'announceDemotions', 'globalLeaderboard',
  ] as const;

  function editableSnapshot(source: Record<string, any> | null): Record<string, any> {
    if (!source) return {};
    return Object.fromEntries(EDITABLE_KEYS.map((key) => [key, source[key]]));
  }

  /**
   * Seules les colonnes reellement modifiees partent au serveur.
   *
   * Renvoyer la courbe a chaque enregistrement regenererait l'echelle meme
   * quand on n'a touche qu'aux gains : une guilde dont l'echelle a ete
   * retouchee palier par palier la verrait remplacee sans l'avoir demande.
   */
  function changedSnapshot(): Record<string, any> {
    const current = editableSnapshot(config);
    const saved = editableSnapshot(savedConfig);
    return Object.fromEntries(
      Object.entries(current).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(saved[key])),
    );
  }

  const configDirty = $derived(
    !!config && JSON.stringify(editableSnapshot(config)) !== JSON.stringify(editableSnapshot(savedConfig)),
  );

  $effect(() => {
    const dirty = configDirty && canManageSettings;
    if (dirty) {
      untrack(() => {
        unsavedChanges.register({
          id: 'prestige',
          label: m.prg_page_title(),
          onSave: () => handleSave(),
          onReset: () => { config = JSON.parse(JSON.stringify(savedConfig)); },
        });
      });
    } else {
      untrack(() => unsavedChanges.release('prestige'));
    }
  });

  onDestroy(() => {
    unsavedChanges.release('prestige');
    if (syncTimer) clearInterval(syncTimer);
  });

  // ---------------------------------------------------------------------------
  // Courbe de l'echelle
  // ---------------------------------------------------------------------------

  const curveValues = $derived<RankedPresetValues>({
    rpPerXp: config?.rpPerXp ?? 0,
    reactionRp: config?.reactionRp ?? 0,
    reactionDailyCap: config?.reactionDailyCap ?? 0,
    dailyRpCap: config?.dailyRpCap ?? 0,
    ladderTierCount: config?.ladderTierCount ?? 19,
    ladderBaseRp: config?.ladderBaseRp ?? LADDER_REFERENCE_BASE_RP,
    ladderExponent: config?.ladderExponent ?? 1.35,
    ladderDivisions: config?.ladderDivisions ?? 3,
    decayEnabled: config?.decayEnabled ?? false,
    streakEnabled: config?.streakEnabled ?? true,
  });

  /** L'echelle telle que la courbe en cours d'edition la produirait. */
  const previewLadder = $derived(generateRankedLadder({
    tierCount: curveValues.ladderTierCount,
    baseRp: curveValues.ladderBaseRp,
    exponent: curveValues.ladderExponent,
    divisions: curveValues.ladderDivisions,
  }));

  /**
   * L'echelle enregistree est-elle celle que decrivent les curseurs ?
   *
   * Une echelle retouchee palier par palier (par le MCP, une ancienne version,
   * ou un import) ne tombe sur aucune courbe : les curseurs affichent alors une
   * echelle qui n'est pas celle qui tourne, et la page le dit plutot que de la
   * remplacer d'office.
   */
  const ladderOffGrid = $derived(
    savedLadder.length > 0 && savedConfig !== null && !ladderMatchesCurve(savedLadder, {
      tierCount: savedConfig.ladderTierCount,
      baseRp: savedConfig.ladderBaseRp,
      exponent: savedConfig.ladderExponent,
      divisions: savedConfig.ladderDivisions,
    }),
  );

  /** L'echelle qui tourne aujourd'hui : celle du serveur, pas celle en cours d'edition. */
  const activeLadder = $derived<Tier[]>(savedLadder as Tier[]);

  const ladderDirty = $derived(
    !!config && !!savedConfig && (
      config.ladderTierCount !== savedConfig.ladderTierCount
      || config.ladderBaseRp !== savedConfig.ladderBaseRp
      || config.ladderExponent !== savedConfig.ladderExponent
      || config.ladderDivisions !== savedConfig.ladderDivisions
    ),
  );

  const tierCountStep = $derived(curveValues.ladderTierCount);
  const pacePreviewStep = $derived(nearestStep(
    LADDER_PACE_FACTORS,
    (curveValues.ladderBaseRp || LADDER_REFERENCE_BASE_RP) / LADDER_REFERENCE_BASE_RP,
  ));
  const steepPreviewStep = $derived(nearestStep(LADDER_EXPONENT_STEPS, curveValues.ladderExponent));

  const LADDER_PACE_LABELS = [
    m.prg_ladder_pace_1, m.prg_ladder_pace_2, m.prg_ladder_pace_3, m.prg_ladder_pace_4, m.prg_ladder_pace_5,
  ];
  const LADDER_STEEP_LABELS = [
    m.prg_ladder_steep_1, m.prg_ladder_steep_2, m.prg_ladder_steep_3, m.prg_ladder_steep_4, m.prg_ladder_steep_5,
  ];
  const GAIN_LABELS = [
    m.prg_gains_level_1, m.prg_gains_level_2, m.prg_gains_level_3, m.prg_gains_level_4, m.prg_gains_level_5,
  ];

  const ladderMode = createSimpleModePreference('kotbo_ranked_ladder_mode');
  const gainMode = createSimpleModePreference('kotbo_ranked_gain_mode');

  function ladderFitsSimpleMode(): boolean {
    const pace = ladderPaceBaseRp(nearestStep(
      LADDER_PACE_FACTORS,
      (curveValues.ladderBaseRp || LADDER_REFERENCE_BASE_RP) / LADDER_REFERENCE_BASE_RP,
    ));
    const steep = LADDER_EXPONENT_STEPS[nearestStep(LADDER_EXPONENT_STEPS, curveValues.ladderExponent) - 1];
    return pace === curveValues.ladderBaseRp && steep === curveValues.ladderExponent;
  }

  function gainsFitSimpleMode(): boolean {
    return RP_GAIN_STEPS.some((step) =>
      step.rpPerXp === curveValues.rpPerXp
      && step.reactionRp === curveValues.reactionRp
      && step.reactionDailyCap === curveValues.reactionDailyCap
      && step.dailyRpCap === curveValues.dailyRpCap);
  }

  const gainsStep = $derived(nearestStep(RP_GAIN_STEPS.map((step) => step.rpPerXp), curveValues.rpPerXp));
  const gainsOffGrid = $derived(gainMode.simple && !gainsFitSimpleMode());
  const curveOffGrid = $derived(ladderMode.simple && !ladderFitsSimpleMode());

  function applyGainsStep(step: number) {
    if (!config) return;
    const preset = RP_GAIN_STEPS[Math.min(RP_GAIN_STEPS.length, Math.max(1, step)) - 1];
    config.rpPerXp = preset.rpPerXp;
    config.reactionRp = preset.reactionRp;
    config.reactionDailyCap = preset.reactionDailyCap;
    config.dailyRpCap = preset.dailyRpCap;
  }

  function applyLadderPace(step: number) {
    if (!config) return;
    config.ladderBaseRp = ladderPaceBaseRp(step);
  }

  function applyLadderSteepness(step: number) {
    if (!config) return;
    config.ladderExponent = LADDER_EXPONENT_STEPS[Math.min(LADDER_EXPONENT_STEPS.length, Math.max(1, step)) - 1];
  }

  /** Retour a la courbe d'origine, sans passer par trois curseurs a repositionner. */
  function resetLadderCurve() {
    if (!config) return;
    config.ladderTierCount = DEFAULT_LADDER_CURVE.tierCount;
    config.ladderBaseRp = DEFAULT_LADDER_CURVE.baseRp;
    config.ladderExponent = DEFAULT_LADDER_CURVE.exponent;
    config.ladderDivisions = DEFAULT_LADDER_CURVE.divisions;
  }

  // ---------------------------------------------------------------------------
  // Prereglages
  // ---------------------------------------------------------------------------

  const selectedPreset = $derived(findRankedPreset(curveValues));
  const activePreset = $derived(savedConfig ? findRankedPreset(savedConfig as Partial<RankedPresetValues>) : null);
  const customPresetValues = $derived<RankedPresetValues>(
    selectedPreset && savedConfig
      ? {
          rpPerXp: savedConfig.rpPerXp,
          reactionRp: savedConfig.reactionRp,
          reactionDailyCap: savedConfig.reactionDailyCap,
          dailyRpCap: savedConfig.dailyRpCap,
          ladderTierCount: savedConfig.ladderTierCount,
          ladderBaseRp: savedConfig.ladderBaseRp,
          ladderExponent: savedConfig.ladderExponent,
          ladderDivisions: savedConfig.ladderDivisions,
          decayEnabled: savedConfig.decayEnabled,
          streakEnabled: savedConfig.streakEnabled,
        }
      : curveValues,
  );

  function applyPreset(preset: RankedPreset) {
    if (!config) return;
    Object.assign(config, rankedPresetValues(preset));
    gainMode.resolve(gainsFitSimpleMode());
    ladderMode.resolve(ladderFitsSimpleMode());
  }

  // ---------------------------------------------------------------------------
  // Chargement & enregistrement
  // ---------------------------------------------------------------------------

  function applyOverview(data: any) {
    config = data.config;
    savedConfig = JSON.parse(JSON.stringify(data.config));
    savedLadder = data.ladder ?? [];
    tierRoles = data.tierRoles ?? [];
    stats = data.stats;
    leaderboard = data.leaderboard ?? [];
    streaks = data.streaks ?? [];
    events = data.events ?? [];
    if (data.tierRoleSync) {
      roleSync = data.tierRoleSync;
      if (roleSync.running) watchRoleSync();
    }
  }

  /**
   * L'echec du chargement s'affiche dans la page, pas en notification : une
   * page qui ne charge pas se reessaie, et empiler des bulles par tentative ne
   * dit rien de plus que le bandeau deja present a l'ecran.
   */
  let loadFailed = $state(false);

  async function load() {
    if (moduleStatus !== 'enabled') {
      loading = false;
      return;
    }
    loading = true;
    try {
      applyOverview(await fetchRankedOverview());
      loadFailed = false;
      gainMode.resolve(gainsFitSimpleMode());
      ladderMode.resolve(ladderFitsSimpleMode());
    } catch {
      loadFailed = true;
    } finally {
      loading = false;
    }
  }

  async function handleSave(): Promise<boolean> {
    if (!config) return false;
    let retiered = 0;
    const success = await saveAction.run(async () => {
      const result: any = await updateRankedConfig(changedSnapshot());
      if (!result?.config) throw new Error(m.prg_save_error());
      config = result.config;
      savedConfig = JSON.parse(JSON.stringify(result.config));
      if (result.ladder) savedLadder = result.ladder;
      retiered = result.retiered ?? 0;
      return true;
    }, { successMessage: m.prg_saved(), failureMessage: m.prg_save_error() });

    // Le compte rendu du serveur remplace le message generique : reclasser des
    // membres est la consequence la moins evidente d'un curseur d'echelle.
    if (success && retiered > 0) {
      saveAction.setMessage(m.prg_saved_retiered({ count: retiered.toLocaleString() }));
    }
    return success;
  }

  /**
   * Un reglage isole (interrupteur, salon d'annonce) s'enregistre seul : il n'a
   * aucune raison d'attendre le bandeau de sauvegarde, et le laisser en attente
   * ferait croire a un echec.
   */
  async function patch(changes: Record<string, unknown>) {
    if (!config) return;
    Object.assign(config, changes);
    try {
      const result: any = await updateRankedConfig(changes);
      // Seules les colonnes envoyees passent dans l'instantane : reprendre la
      // config entiere effacerait les curseurs encore en attente d'un
      // enregistrement, sans que rien ne le signale.
      if (result?.config && savedConfig) {
        for (const key of Object.keys(changes)) savedConfig[key] = result.config[key];
        if (result.ladder) savedLadder = result.ladder;
      }
      toast.success(m.prg_saved());
    } catch {
      toast.error(m.prg_save_error());
      await load();
    }
  }

  async function bindRole(tierKey: string, roleId: string) {
    try {
      if (!roleId) {
        await removeRankedTierRole(tierKey);
        tierRoles = tierRoles.filter((mapping) => mapping.tierKey !== tierKey);
      } else {
        await setRankedTierRole(tierKey, roleId);
        tierRoles = [...tierRoles.filter((mapping) => mapping.tierKey !== tierKey), { tierKey, roleId }];
      }
      toast.success(m.prg_saved());
    } catch {
      toast.error(m.prg_save_error());
    }
  }

  function roleFor(tierKey: string): string | null {
    return tierRoles.find((mapping) => mapping.tierKey === tierKey)?.roleId ?? null;
  }

  /** Paliers encore sans role : le chiffre qui decide de l'interet du bouton. */
  const tiersWithoutRole = $derived(
    activeLadder.filter((tier) => {
      const roleId = roleFor(tier.key);
      return !roleId || !roles.some((role) => role.id === roleId);
    }).length,
  );

  // ---------------------------------------------------------------------------
  // Roles de palier : creation et attribution
  // ---------------------------------------------------------------------------

  const PROVISION_ERRORS: Record<string, () => string> = {
    missing_manage_roles: m.prg_roles_err_permission,
    role_limit: m.prg_roles_err_limit,
    guild_unavailable: m.prg_roles_err_guild,
    tier_roles_disabled: m.prg_roles_err_disabled,
    no_tier_roles: m.prg_roles_err_none,
    no_members: m.prg_roles_err_no_members,
  };

  async function handleProvisionRoles() {
    await roleAction.run(async () => {
      const result: any = await provisionRankedTierRoles();
      if (!result) throw new Error(m.prg_roles_err_failed());
      if (result.error && !result.created) {
        throw new Error((PROVISION_ERRORS[result.error] ?? m.prg_roles_err_failed)());
      }
      tierRoles = result.tierRoles ?? tierRoles;
      // Les rôles viennent d'être créés sur Discord : sans ce rafraîchissement,
      // les listes déroulantes ne les connaissent pas encore et les paliers
      // qu'ils viennent de couvrir s'affichent toujours comme orphelins.
      if (result.created > 0) await dashboardStore.refresh();
      roleAction.setMessage(
        result.created === 0
          ? m.prg_roles_created_none()
          : m.prg_roles_created({ created: result.created, kept: result.kept }),
      );
      return true;
    });
  }

  /** Roles de palier a supprimer : le chiffre annonce l'ampleur du geste. */
  const linkedRoleCount = $derived(tierRoles.length);

  async function handleDeleteRoles() {
    const confirmed = await confirmDialog.ask({
      title: m.prg_roles_delete_confirm_title({ count: linkedRoleCount }),
      description: m.prg_roles_delete_confirm_desc(),
      confirmLabel: m.prg_roles_delete_action(),
      variant: 'danger',
    });
    if (!confirmed) return;

    await roleAction.run(async () => {
      const result: any = await deleteRankedTierRoles();
      if (!result) throw new Error(m.prg_roles_err_failed());
      if (result.error) {
        throw new Error((PROVISION_ERRORS[result.error] ?? m.prg_roles_err_failed)());
      }
      tierRoles = result.tierRoles ?? [];
      // Les listes deroulantes proposent encore des roles qui n'existent plus.
      if (result.deleted > 0) await dashboardStore.refresh();
      roleAction.setMessage(
        result.failed > 0
          ? m.prg_roles_deleted_partial({ deleted: result.deleted, failed: result.failed })
          : m.prg_roles_deleted({ deleted: result.deleted }),
      );
      return true;
    });
  }

  let roleSync = $state<{ pending: number; done: number; updated: number; running: boolean }>({ pending: 0, done: 0, updated: 0, running: false });
  let syncTimer: ReturnType<typeof setInterval> | null = null;

  function watchRoleSync() {
    if (syncTimer) return;
    syncTimer = setInterval(async () => {
      const status: any = await fetchRankedTierRoleSync().catch(() => null);
      if (status) roleSync = status;
      if (!roleSync.running && syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
      }
    }, 3000);
  }

  async function startRoleSync() {
    await roleAction.run(async () => {
      const status: any = await runRankedTierRoleSync();
      if (!status) throw new Error(m.prg_roles_err_failed());
      if (status.error && !status.started) {
        throw new Error((PROVISION_ERRORS[status.error] ?? m.prg_roles_err_failed)());
      }
      roleSync = { pending: status.pending ?? 0, done: status.done ?? 0, updated: status.updated ?? 0, running: true };
      watchRoleSync();
      return true;
    }, { successMessage: m.prg_roles_sync_started() });
  }

  async function stopRoleSync() {
    const status: any = await runRankedTierRoleSync({ stop: true }).catch(() => null);
    if (status) roleSync = status;
  }

  // ---------------------------------------------------------------------------
  // Repartition des membres sur l'echelle en cours d'edition
  // ---------------------------------------------------------------------------

  type LadderImpact = { total: number; changed: number; distribution: number[] };
  let impactRaw = $state<LadderImpact | null>(null);

  $effect(() => {
    if (loading || !config) return;
    const curve = {
      tierCount: curveValues.ladderTierCount,
      baseRp: curveValues.ladderBaseRp,
      exponent: curveValues.ladderExponent,
      divisions: curveValues.ladderDivisions,
    };
    let cancelled = false;
    // Debounce : sans lui, un curseur tire une requete par cran traverse.
    const timer = setTimeout(async () => {
      const result: any = await fetchRankedLadderImpact({ curve }).catch(() => null);
      if (!cancelled) impactRaw = Array.isArray(result?.distribution) ? result : null;
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  });

  // Une guilde sans membre classe n'a rien a montrer : ni histogramme vide, ni
  // « aucun membre ne change de palier », qui se lirait comme un resultat.
  const impact = $derived(impactRaw && impactRaw.total > 0 ? impactRaw : null);
  const impactMax = $derived(Math.max(...(impact?.distribution ?? []), 1));

  /** Ecart entre deux paliers : ce que la barre du graphique represente. */
  function ladderGapsOf(ladder: RankedLadder): number[] {
    return ladder.map((tier, index) => (index === 0 ? 0 : tier.minRp - ladder[index - 1].minRp));
  }

  const ladderGaps = $derived(previewLadder.map((tier, index) => ({
    tier,
    gap: index === 0 ? 0 : tier.minRp - previewLadder[index - 1].minRp,
  })));

  /**
   * L'echelle enregistree, tracee derriere celle qu'on edite.
   *
   * Sans elle, le graphique montre un etat sans jamais montrer ce qu'il
   * remplace. Tronquee aux colonnes affichees : une echelle enregistree plus
   * longue tirerait l'echelle verticale vers une colonne qu'on ne voit pas.
   */
  const savedLadderGaps = $derived(
    ladderDirty ? ladderGapsOf(activeLadder).slice(0, previewLadder.length) : [],
  );

  const ladderGapMax = $derived(Math.max(
    ...ladderGaps.map((entry) => entry.gap),
    ...savedLadderGaps,
    1,
  ));

  /**
   * Reperes de l'axe : le premier palier, le dernier, et un sur cinq entre les
   * deux. Numeroter chaque colonne les rendrait illisibles.
   */
  function axisTicks(columns: number): Set<number> {
    const step = columns <= 10 ? 2 : 5;
    const ticks = new Set<number>([1, columns]);
    for (let index = step; index < columns; index += step) ticks.add(index);
    return ticks;
  }

  /**
   * Associations qui ne designent plus rien : un role supprime sur Discord, ou
   * un palier disparu d'une echelle raccourcie. Les deux laissent une ligne en
   * base que rien n'affichait.
   */
  const orphanTierRoles = $derived(tierRoles.filter((mapping) =>
    !activeLadder.some((tier) => tier.key === mapping.tierKey)));

  const apexRp = $derived(ladderApexRp(previewLadder));

  /**
   * Duree estimee pour atteindre le sommet, a partir du rythme de gains reglé
   * ici et d'une activite choisie. Les curseurs repondent chacun a un fragment,
   * aucun ne dit combien de temps l'echelle demande.
   */
  const ACTIVITY_PRESETS = [10, 30, 100];
  const ACTIVITY_LABELS = [m.prg_estimate_activity_low, m.prg_estimate_activity_mid, m.prg_estimate_activity_high];
  /** XP moyenne d'un message, valeur par defaut du module Niveaux. */
  const TYPICAL_XP_PER_MESSAGE = 20;

  let activityStep = $state(2);

  const estimatedRpPerDay = $derived.by(() => {
    const fromXp = ACTIVITY_PRESETS[activityStep - 1] * TYPICAL_XP_PER_MESSAGE * (curveValues.rpPerXp || 0);
    const fromReactions = Math.min(curveValues.reactionDailyCap || 0, 10) * (curveValues.reactionRp || 0);
    const perDay = fromXp + fromReactions;
    return curveValues.dailyRpCap > 0 ? Math.min(perDay, curveValues.dailyRpCap) : perDay;
  });

  function estimateDays(rp: number): number {
    if (estimatedRpPerDay <= 0) return Infinity;
    return rp / estimatedRpPerDay;
  }

  function formatDuration(days: number): string {
    if (!Number.isFinite(days)) return '-';
    if (days < 1) return m.prg_estimate_under_a_day();
    if (days < 60) return m.prg_estimate_days({ days: Math.round(days) });
    if (days < 730) return m.prg_estimate_months({ months: Math.round(days / 30) });
    return m.prg_estimate_years({ years: (days / 365).toFixed(1) });
  }

  /** Quatre reperes de l'echelle : le premier promu, deux paliers intermediaires, le sommet. */
  const ladderMilestones = $derived.by(() => {
    const count = previewLadder.length;
    if (count === 0) return [];
    const indexes = [...new Set([1, Math.floor(count / 3), Math.floor((count * 2) / 3), count - 1])]
      .filter((index) => index > 0 && index < count);
    return indexes.map((index) => previewLadder[index]);
  });

  // ---------------------------------------------------------------------------
  // Series & decay : crans et apercus
  // ---------------------------------------------------------------------------

  const streakMode = createSimpleModePreference('kotbo_ranked_streak_mode');
  const decayMode = createSimpleModePreference('kotbo_ranked_decay_mode');

  const STREAK_LABELS = [
    m.prg_streak_level_1, m.prg_streak_level_2, m.prg_streak_level_3, m.prg_streak_level_4, m.prg_streak_level_5,
  ];
  const DECAY_LABELS = [
    m.prg_decay_level_1, m.prg_decay_level_2, m.prg_decay_level_3, m.prg_decay_level_4, m.prg_decay_level_5,
  ];

  function streakFitsSimpleMode(): boolean {
    // Desactivees, leurs valeurs ne s'affichent pas : elles n'ont pas a coller.
    if (!config?.streakEnabled) return true;
    return STREAK_STEPS.some((step) => (Object.keys(step) as Array<keyof typeof step>)
      .every((key) => step[key] === config?.[key]));
  }

  function decayFitsSimpleMode(): boolean {
    if (!config?.decayEnabled) return true;
    return DECAY_STEPS.some((step) => (Object.keys(step) as Array<keyof typeof step>)
      .every((key) => step[key] === config?.[key]));
  }

  const streakStep = $derived(nearestStep(
    STREAK_STEPS.map((step) => step.streakBonusPerDay),
    config?.streakBonusPerDay ?? STREAK_STEPS[2].streakBonusPerDay,
  ));
  const decayStep = $derived(nearestStep(
    DECAY_STEPS.map((step) => step.decayRpPerDay),
    config?.decayRpPerDay ?? DECAY_STEPS[2].decayRpPerDay,
  ));
  const streakOffGrid = $derived(streakMode.simple && !streakFitsSimpleMode());
  const decayOffGrid = $derived(decayMode.simple && !decayFitsSimpleMode());

  function applyStreakStep(step: number) {
    if (!config) return;
    Object.assign(config, STREAK_STEPS[Math.min(STREAK_STEPS.length, Math.max(1, step)) - 1]);
  }

  function applyDecayStep(step: number) {
    if (!config) return;
    Object.assign(config, DECAY_STEPS[Math.min(DECAY_STEPS.length, Math.max(1, step)) - 1]);
  }

  /** Fenetre des deux apercus : un mois, la duree d'une saison courte. */
  const PREVIEW_DAYS = 30;

  // Le multiplicateur vient du bot (`streakMultiplier`), pas d'une formule
  // recopiee : la courbe montre ce qui sera reellement applique.
  const streakCurve = $derived(Array.from({ length: PREVIEW_DAYS }, (_, index) => ({
    day: index + 1,
    multiplier: streakMultiplier(index + 1, {
      graceDays: config?.streakGraceDays ?? 0,
      bonusPerDay: config?.streakEnabled ? (config?.streakBonusPerDay ?? 0) : 0,
      maxBonus: config?.streakEnabled ? (config?.streakMaxBonus ?? 0) : 0,
    }),
  })));
  const streakCurveMax = $derived(Math.max(...streakCurve.map((point) => point.multiplier), 1.01));

  /**
   * Membre de reference du decay : celui du milieu de l'echelle. Un chiffre
   * abstrait ne dirait rien, et le RP moyen de la guilde vaut 0 tant que
   * personne n'a joue.
   */
  const decayReferenceRp = $derived(
    previewLadder[Math.floor(previewLadder.length / 2)]?.minRp || 1_000,
  );

  const decayCurve = $derived(Array.from({ length: PREVIEW_DAYS + 1 }, (_, days) => computeRankedDecay(
    decayReferenceRp,
    days,
    {
      enabled: config?.decayEnabled ?? false,
      graceDays: config?.decayGraceDays ?? 0,
      rpPerDay: config?.decayRpPerDay ?? 0,
      percentPerDay: config?.decayPercentPerDay ?? 0,
      floorRp: rankedFloorRp(config?.decayFloorTierKey, ladderDirty ? previewLadder : activeLadder),
    },
  ).newRp));

  /** Jours avant de perdre un palier : le seul chiffre qui parle vraiment. */
  const decayDaysToDemotion = $derived.by(() => {
    const ladder = ladderDirty ? previewLadder : activeLadder;
    const tierIndex = rankedTierIndex(decayReferenceRp, ladder);
    const floor = ladder[tierIndex]?.minRp ?? 0;
    if (!config?.decayEnabled) return null;
    const day = decayCurve.findIndex((rp) => rp < floor);
    return day === -1 ? null : day;
  });

  // ---------------------------------------------------------------------------
  // Salon d'annonce
  // ---------------------------------------------------------------------------

  const announceAction = createAsyncActionState();

  /**
   * Le champ porte deux etats qui ne sont pas des salons : vide (aucune
   * annonce) et un identifiant qui ne designe plus rien. Les distinguer evite
   * d'afficher un identifiant brut la ou on attend un nom de salon.
   */
  const announceChannelState = $derived.by(() => {
    const id = config?.announceChannelId;
    if (!id) return 'none';
    if (channels.length > 0 && !channels.some((channel) => channel.id === id)) return 'missing';
    return 'channel';
  });

  const announceChannelLabel = $derived.by(() => {
    const channel = channels.find((entry) => entry.id === config?.announceChannelId);
    return channel ? channelDisplayName(channel) : (config?.announceChannelId ?? '');
  });

  async function handleCreateAnnounceChannel() {
    if (!canManageSettings) return;
    await announceAction.run(async () => {
      const result: any = await createRankedAnnounceChannel();
      if (!result?.channelId) throw new Error(m.prg_announce_create_failed());
      // La liste des salons d'abord : le champ pointerait sinon sur un salon
      // qu'elle ne connait pas encore.
      await dashboardStore.refresh();
      if (config) config.announceChannelId = result.channelId;
      if (savedConfig) savedConfig.announceChannelId = result.channelId;
      return true;
    }, { successMessage: m.prg_announce_created() });
  }

  /** Apercu du message, variables remplacees par un exemple. */
  function announcePreview(template: string, fallback: string): string {
    const sample = {
      user: '@Membre',
      tier: activeLadder[Math.min(3, activeLadder.length - 1)]?.name ?? 'Gold I',
      from: activeLadder[Math.min(2, activeLadder.length - 1)]?.name ?? 'Silver III',
      rp: '2 000',
    };
    const text = template?.trim() || fallback;
    return text.replace(/\{(user|tier|from|rp)\}/g, (_match, key: keyof typeof sample) => sample[key]);
  }

  // ---------------------------------------------------------------------------
  // Classement : page, recherche, fiche membre
  // ---------------------------------------------------------------------------

  type BoardRow = LeaderboardEntry & { displayName?: string | null; avatarUrl?: string | null };

  let boardView = $state<'guild' | 'global'>('guild');
  let boardRows = $state<BoardRow[]>([]);
  let boardPage = $state(1);
  let boardPageCount = $state(1);
  let boardTotal = $state(0);
  let boardSearch = $state('');
  let boardLoading = $state(false);
  let boardLimited = $state(false);
  let globalRows = $state<Array<{ rank: number; userId: string; rp: number; guilds: number; tier: Tier; displayName?: string | null; avatarUrl?: string | null }>>([]);

  async function loadBoard(page = boardPage) {
    boardLoading = true;
    try {
      const result: any = await fetchRankedLeaderboard({ page, search: boardSearch.trim() }).catch(() => null);
      if (!result || !Array.isArray(result.rows)) return;
      boardRows = result.rows;
      boardPage = result.page ?? 1;
      boardPageCount = result.pageCount ?? 1;
      boardTotal = result.total ?? 0;
      boardLimited = result.searchLimited === true;
    } finally {
      boardLoading = false;
    }
  }

  // La recherche interroge la base : on attend une pause de frappe, et on revient
  // a la premiere page - rester page 4 d'un resultat qui n'en a qu'une
  // n'afficherait rien.
  $effect(() => {
    const search = boardSearch;
    // `config` absent = module eteint ou chargement en echec : la route est
    // fermee, l'interroger ne rendrait qu'un refus de plus.
    if (loading || !config || activeTab !== 'classement' || boardView !== 'guild') return;
    const timer = setTimeout(() => {
      untrack(() => loadBoard(1));
    }, search ? 300 : 0);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    if (boardView !== 'global' || globalRows.length > 0 || !config) return;
    untrack(async () => {
      const result: any = await fetchRankedGlobalLeaderboard(25).catch(() => null);
      if (Array.isArray(result?.leaderboard)) globalRows = result.leaderboard;
    });
  });

  // Le podium n'a de sens que sur la premiere page non filtree : ailleurs, les
  // trois premieres lignes ne sont pas les trois premiers du serveur.
  const podium = $derived(!boardSearch.trim() && boardPage === 1 ? boardRows.slice(0, 3) : []);

  /**
   * Lien public du classement : la meme adresse que celle des niveaux, cote
   * prestige. Le classement ne vivait que dans le dashboard, donc derriere une
   * authentification, alors qu'il est fait pour etre montre.
   */
  const publicBoardUrl = $derived(
    authStore.selectedGuildId
      ? `${window.location.origin}/${authStore.selectedGuildId}/prestige/classement`
      : '',
  );
  let copiedPublicUrl = $state(false);

  async function copyPublicUrl() {
    if (!publicBoardUrl) return;
    await navigator.clipboard.writeText(publicBoardUrl);
    copiedPublicUrl = true;
    setTimeout(() => { copiedPublicUrl = false; }, 2000);
  }

  const adjustAction = createAsyncActionState();
  let openedMemberId = $state<string | null>(null);
  let memberProfile = $state<any>(null);
  let memberHistory = $state<Array<{ delta: number; rpAfter: number; source: string; createdAt: string }>>([]);
  let memberLoading = $state(false);
  let adjustDelta = $state<number | null>(null);
  let adjustReason = $state('');

  async function openMember(userId: string) {
    openedMemberId = userId;
    memberProfile = null;
    memberHistory = [];
    adjustDelta = null;
    adjustReason = '';
    adjustAction.clearFeedback();
    memberLoading = true;
    try {
      const result: any = await fetchRankedMember(userId).catch(() => null);
      memberProfile = result?.profile ?? null;
      memberHistory = Array.isArray(result?.history) ? result.history : [];
    } finally {
      memberLoading = false;
    }
  }

  function closeMember() {
    openedMemberId = null;
    memberProfile = null;
  }

  async function handleAdjust(sign: 1 | -1) {
    if (!openedMemberId || !adjustDelta) return;
    await adjustAction.run(async () => {
      const delta = Math.trunc(adjustDelta!) * sign;
      if (!delta) throw new Error(m.prg_member_adjust_zero());
      const result: any = await adjustRankedMember(openedMemberId!, delta, adjustReason.trim() || undefined);
      if (!result?.result) throw new Error(m.prg_save_error());
      adjustDelta = null;
      adjustReason = '';
      // La fiche et le classement parlent du meme membre : les laisser diverger
      // ferait douter de celui qui a raison.
      await openMember(openedMemberId!);
      await loadBoard();
      return true;
    }, { successMessage: m.prg_member_adjusted() });
  }

  /** Courbe de RP de la fiche membre, en pourcentage de son maximum. */
  const memberCurve = $derived.by(() => {
    if (memberHistory.length < 2) return '';
    const max = Math.max(...memberHistory.map((entry) => entry.rpAfter), 1);
    return memberHistory
      .map((entry, index) => {
        const x = (index / (memberHistory.length - 1)) * 100;
        const y = 100 - (entry.rpAfter / max) * 100;
        return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
  });

  const RP_SOURCE_LABELS: Record<string, () => string> = {
    text: m.prg_source_text,
    voice: m.prg_source_voice,
    reaction: m.prg_source_reaction,
    event: m.prg_source_event,
    manual: m.prg_source_manual,
    decay: m.prg_source_decay,
    season: m.prg_source_season,
  };

  // ---------------------------------------------------------------------------
  // Decay & evenements
  // ---------------------------------------------------------------------------

  async function handlePreviewDecay() {
    try {
      decayPreview = (await previewRankedDecay()) as any;
    } catch {
      toast.error(m.prg_load_error());
    }
  }

  async function handleRunDecay() {
    try {
      const report: any = await runRankedDecay();
      toast.success(m.prg_decay_ran({ affected: report.affected, rpLost: report.rpLost }));
      await load();
    } catch {
      toast.error(m.prg_save_error());
    }
  }

  async function handleCreateEvent() {
    try {
      await createRankedEvent({
        type: newEvent.type,
        name: newEvent.name || EVENT_TYPES.find((t) => t.value === newEvent.type)?.label || newEvent.type,
        multiplier: newEvent.multiplier,
        durationMinutes: newEvent.durationMinutes,
        announceChannelId: newEvent.announceChannelId || undefined,
      });
      showEventForm = false;
      newEvent = { type: 'MESSAGE_RUSH', name: '', multiplier: 2, durationMinutes: 60, announceChannelId: '' };
      toast.success(m.prg_event_created());
      await load();
    } catch {
      toast.error(m.prg_save_error());
    }
  }

  async function handleCancelEvent(eventId: string) {
    try {
      await cancelRankedEvent(eventId);
      toast.success(m.prg_event_cancelled());
      await load();
    } catch {
      toast.error(m.prg_save_error());
    }
  }

  function statusLabel(status: string): string {
    if (status === 'RUNNING') return m.prg_event_status_running();
    if (status === 'SCHEDULED') return m.prg_event_status_scheduled();
    if (status === 'CANCELLED') return m.prg_event_status_cancelled();
    return m.prg_event_status_ended();
  }

  function statusClass(status: string): string {
    if (status === 'RUNNING') return 'bg-success/10 text-success';
    if (status === 'SCHEDULED') return 'bg-primary/10 text-primary';
    if (status === 'CANCELLED') return 'bg-error/10 text-error';
    return 'bg-surface-container-high/40 text-on-surface-variant';
  }

  /**
   * Un seul chargement par etat du module.
   *
   * L'interrupteur de l'en-tete rafraichit le store des modules mais ne sait
   * rien de cette page : sans ce rappel, allumer le prestige laisserait un
   * ecran vide jusqu'au prochain rechargement manuel. En revanche le declencher
   * sur « config toujours vide » relancait l'appel a chaque echec, en boucle -
   * d'ou le repere, volontairement hors reactivite, sur l'etat deja traite.
   */
  let handledStatus: 'unknown' | 'enabled' | 'disabled' | null = null;

  $effect(() => {
    const status = moduleStatus;
    if (status === handledStatus) return;
    handledStatus = status;
    if (status === 'enabled') void load();
    else if (status === 'disabled') loading = false;
  });
</script>

<!-- Axe des graphiques de l'echelle : memes colonnes, meme gouttiere, donc les
     reperes tombent sous les barres correspondantes des deux graphiques.
     `border-transparent` : le graphique au-dessus a une bordure d'1px, sans
     quoi les reperes seraient decales d'un pixel. -->
{#snippet ladderAxis(columns: number)}
  {@const ticks = axisTicks(columns)}
  <div class="flex gap-[3px] px-2 border border-transparent" aria-hidden="true">
    {#each Array.from({ length: columns }) as _, index}
      <span class="flex-1 text-center text-2xs leading-none tabular-nums text-on-surface-variant">
        {ticks.has(index + 1) ? index + 1 : ''}
      </span>
    {/each}
  </div>
{/snippet}

<!-- Bandeau d'enregistrement des onglets detailles : les curseurs posent
     plusieurs colonnes a la fois, les enregistrer champ par champ ferait
     autant de requetes que de crans traverses. -->
{#snippet saveBar()}
  <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-surface-container-low/30 border border-outline-variant/10 rounded-xl px-6 py-5">
    <p class="text-body-sm text-on-surface-variant">{m.prg_presets_save_hint()}</p>
    <div class="flex items-center gap-2">
      <button
        type="button"
        onclick={() => { config = JSON.parse(JSON.stringify(savedConfig)); }}
        class="px-5 py-3 rounded-lg text-body-sm font-medium text-on-surface-variant hover:bg-surface-container-high/40 transition-all"
      >
        {m.prg_btn_reset()}
      </button>
      <button
        type="button"
        onclick={handleSave}
        disabled={saveAction.state.loading}
        class="px-6 py-3 bg-primary hover:bg-primary/90 text-on-primary text-body-sm font-medium rounded-lg shadow-md shadow-primary/20 transition-all disabled:opacity-50 flex items-center gap-2"
      >
        <Papicon icon="Check" size={16} />
        {m.prg_presets_save()}
      </button>
    </div>
  </div>
{/snippet}

<ModulePage
  title={m.prg_page_title()}
  description={m.prg_page_desc()}
  icon="crown"
  featureKey="prestige"
>
  {#snippet actions()}
    {#if !loading && config}
      <button
        type="button"
        onclick={() => gotoTab('/prestige', activeTab === 'accueil' ? 'gains' : 'accueil', DEFAULT_TAB)}
        class="group flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-bold bg-primary text-on-primary shadow-md shadow-primary/20 hover:bg-primary/90 transition-all"
      >
        <Papicon icon={activeTab === 'accueil' ? 'Settings' : 'ArrowLeft'} size={15} />
        {activeTab === 'accueil' ? m.prg_presets_open_advanced() : m.prg_presets_back()}
      </button>
    {/if}
  {/snippet}

  {#if loading}
    <LoadingHint context="config" />
  {:else if config}
    <InlineFeedback state={saveAction} />
    <InlineFeedback state={roleAction} />

    {#if activeTab !== 'accueil'}
      <Tabs
        label={m.prg_page_title()}
        tabs={pageTabItems('/prestige', (id) => id !== 'accueil')
          .map((item) => item.id === 'classement' && boardTotal > 0 ? { ...item, badge: boardTotal.toLocaleString() } : item)}
        active={activeTab}
        onchange={(id) => gotoTab('/prestige', id, DEFAULT_TAB)}
      />
    {/if}

    {#if activeTab === 'accueil'}
      <!-- ==================== ACCUEIL : PREREGLAGES ==================== -->
      <div class="space-y-8">
        <!-- A quoi servent les RP : la page reglait un compteur sans jamais
             dire ce qu'il compte, ni d'ou il vient. -->
        <section class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
          <div class="flex items-start gap-3">
            <div class="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <Papicon icon="info" size={18} />
            </div>
            <div class="space-y-1">
              <h3 class="text-base font-semibold text-on-surface">{m.prg_about_title()}</h3>
              <p class="text-body-sm text-on-surface-variant leading-relaxed">{m.prg_about_desc()}</p>
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div class="px-4 py-3 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg space-y-1">
              <p class="text-xs font-semibold text-on-surface-variant">{m.prg_about_earn_title()}</p>
              <p class="text-xs text-on-surface-variant leading-relaxed">{m.prg_about_earn_desc()}</p>
            </div>
            <div class="px-4 py-3 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg space-y-1">
              <p class="text-xs font-semibold text-on-surface-variant">{m.prg_about_lose_title()}</p>
              <p class="text-xs text-on-surface-variant leading-relaxed">{m.prg_about_lose_desc()}</p>
            </div>
            <div class="px-4 py-3 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg space-y-1">
              <p class="text-xs font-semibold text-on-surface-variant">{m.prg_about_spend_title()}</p>
              <p class="text-xs text-on-surface-variant leading-relaxed">{m.prg_about_spend_desc()}</p>
            </div>
          </div>
        </section>

        <RankedPresetPicker
          selectedId={selectedPreset?.id ?? null}
          activeId={activePreset?.id ?? null}
          customValues={customPresetValues}
          disabled={!canManageSettings}
          dirty={configDirty}
          saving={saveAction.state.loading}
          {moduleEnabled}
          onselect={applyPreset}
          onsave={handleSave}
          ondetail={() => gotoTab('/prestige', 'gains', DEFAULT_TAB)}
        />

        <!-- Un preregle pose une echelle, pas les roles qui vont avec : la mise
             en route se termine ici, la ou l'oeil arrive. -->
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-surface-container-low/30 border border-outline-variant/10 rounded-xl px-6 py-5">
          <div class="flex items-start gap-3">
            <div class="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <Papicon icon="shield" size={18} />
            </div>
            <div class="space-y-0.5">
              <p class="text-sm font-semibold text-on-surface">{m.prg_setup_roles_title()}</p>
              <p class="text-body-sm text-on-surface-variant">
                {tiersWithoutRole === 0
                  ? m.prg_setup_roles_done({ count: activeLadder.length })
                  : m.prg_setup_roles_desc({ count: tiersWithoutRole })}
              </p>
            </div>
          </div>
          <button
            type="button"
            onclick={() => gotoTab('/prestige', 'echelle', DEFAULT_TAB)}
            class="shrink-0 px-6 py-3 bg-surface-container-high/40 hover:bg-surface-container-high/60 text-on-surface text-body-sm font-medium rounded-lg transition-all flex items-center gap-2"
          >
            <Papicon icon="ArrowRight" size={16} />
            {m.prg_setup_roles_open()}
          </button>
        </div>
      </div>
    {:else if activeTab === 'gains'}
      <!-- ==================== GAINS & SERIES ==================== -->
      <div class="space-y-8 animate-in fade-in duration-300">
        <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <MetricCard label={m.prg_stat_ranked()} value={stats?.rankedMembers ?? 0} icon="users" />
          <MetricCard label={m.prg_stat_streaks()} value={stats?.activeStreaks ?? 0} icon="activity" toneClass="bg-warning/10 text-warning" />
          <MetricCard label={m.prg_stat_total_rp()} value={(stats?.totalRp ?? 0).toLocaleString()} icon="chart" toneClass="bg-success/10 text-success" />
          <MetricCard label={m.prg_stat_best_streak()} value={stats?.bestStreak ?? 0} icon="crown" toneClass="bg-pink-500/10 text-pink-500" />
        </div>

        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
          <div class="flex items-start justify-between gap-4">
            <div>
              <h3 class="text-xl font-semibold flex items-center gap-3">
                <Papicon icon="chart" size={20} class="text-primary" />
                {m.prg_section_gains()}
              </h3>
              <p class="text-xs text-on-surface-variant mt-1">{m.prg_section_gains_hint()}</p>
            </div>
            <SimpleModeToggle simple={gainMode.simple} onchange={(v) => gainMode.set(v)} />
          </div>

          {#if gainMode.simple}
            <div class="space-y-2">
              <div class="flex items-baseline justify-between gap-3">
                <label for="rpGains" class="text-xs font-semibold text-on-surface-variant ml-2">{m.prg_gains_level_label()}</label>
                <span class="text-xs font-semibold text-primary">{GAIN_LABELS[gainsStep - 1]()}</span>
              </div>
              <input
                id="rpGains"
                type="range" min="1" max="5" step="1"
                value={gainsStep}
                oninput={(e) => applyGainsStep(Number(e.currentTarget.value))}
                class="w-full accent-primary"
                disabled={!canManageSettings}
              />

              <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
                <div class="px-3 py-2.5 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
                  <p class="text-xs font-semibold text-on-surface-variant">{m.prg_tile_rp_per_xp()}</p>
                  <p class="text-sm font-semibold text-on-surface">×{config.rpPerXp}</p>
                </div>
                <div class="px-3 py-2.5 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
                  <p class="text-xs font-semibold text-on-surface-variant">{m.prg_field_reaction_rp()}</p>
                  <p class="text-sm font-semibold text-on-surface">{config.reactionRp} RP</p>
                </div>
                <div class="px-3 py-2.5 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
                  <p class="text-xs font-semibold text-on-surface-variant">{m.prg_field_reaction_cap()}</p>
                  <p class="text-sm font-semibold text-on-surface">{config.reactionDailyCap}</p>
                </div>
                <div class="px-3 py-2.5 bg-primary/5 border border-primary/15 rounded-lg">
                  <p class="text-xs font-semibold text-primary/70">{m.prg_tile_daily()}</p>
                  <p class="text-sm font-semibold text-primary">≈ {Math.round(estimatedRpPerDay).toLocaleString()} RP</p>
                </div>
              </div>

              {#if gainsOffGrid}
                <SimpleModeNotice message={m.prg_gains_off_grid()} />
              {/if}
            </div>
          {:else}
            <div class="grid sm:grid-cols-2 xl:grid-cols-4 gap-3">
              <label class="block">
                <span class="field-label">{m.prg_field_rp_per_xp()}</span>
                <input type="number" step="0.05" min="0" max="10" bind:value={config.rpPerXp} class="prestige-input" disabled={!canManageSettings} />
              </label>
              <label class="block">
                <span class="field-label">{m.prg_field_reaction_rp()}</span>
                <input type="number" min="0" max="100" bind:value={config.reactionRp} class="prestige-input" disabled={!canManageSettings} />
              </label>
              <label class="block">
                <span class="field-label">{m.prg_field_reaction_cap()}</span>
                <input type="number" min="0" max="500" bind:value={config.reactionDailyCap} class="prestige-input" disabled={!canManageSettings} />
              </label>
              <label class="block">
                <span class="field-label">{m.prg_field_daily_cap()}</span>
                <input type="number" min="0" bind:value={config.dailyRpCap} class="prestige-input" disabled={!canManageSettings} />
              </label>
            </div>
          {/if}

          <!-- Le RP derive de l'XP : les exclusions de salons, les roles
               ignores et les multiplicateurs sont ceux de Niveaux. Sans cette
               ligne, leur absence ici se lit comme un oubli. -->
          <div class="flex items-start gap-2.5 pt-4 border-t border-outline-variant/10 text-2xs text-on-surface-variant leading-relaxed">
            <Papicon icon="info" size={14} class="shrink-0 mt-0.5" />
            <p>{m.prg_gains_inherits_levels()}</p>
          </div>
        </section>

        <!-- ==================== SERIES ==================== -->
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
          <div class="flex items-start justify-between gap-4">
            <div>
              <h3 class="text-xl font-semibold flex items-center gap-3">
                <Papicon icon="activity" size={20} class="text-warning" />
                {m.prg_section_streaks()}
              </h3>
              <p class="text-xs text-on-surface-variant mt-1">{m.prg_section_streaks_hint()}</p>
            </div>
            {#if config.streakEnabled}
              <SimpleModeToggle simple={streakMode.simple} onchange={(v) => streakMode.set(v)} />
            {/if}
          </div>

          <label class="flex items-center justify-between gap-4">
            <span class="text-body-sm font-medium text-on-surface">{m.prg_field_streak_enabled()}</span>
            <ToggleSwitch checked={config.streakEnabled} onToggle={(v) => { config!.streakEnabled = v; }} disabled={!canManageSettings} />
          </label>

          {#if config.streakEnabled}
            {#if streakMode.simple}
              <div class="space-y-2">
                <div class="flex items-baseline justify-between gap-3">
                  <label for="streakLevel" class="text-xs font-semibold text-on-surface-variant ml-2">{m.prg_streak_level_label()}</label>
                  <span class="text-xs font-semibold text-primary">{STREAK_LABELS[streakStep - 1]()}</span>
                </div>
                <input
                  id="streakLevel"
                  type="range" min="1" max="5" step="1"
                  value={streakStep}
                  oninput={(e) => applyStreakStep(Number(e.currentTarget.value))}
                  class="w-full accent-primary"
                  disabled={!canManageSettings}
                />

                <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
                  <div class="px-3 py-2.5 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
                    <p class="text-xs font-semibold text-on-surface-variant">{m.prg_field_streak_bonus()}</p>
                    <p class="text-sm font-semibold text-on-surface">+{Math.round((config.streakBonusPerDay ?? 0) * 100)} %/j</p>
                  </div>
                  <div class="px-3 py-2.5 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
                    <p class="text-xs font-semibold text-on-surface-variant">{m.prg_field_streak_max()}</p>
                    <p class="text-sm font-semibold text-on-surface">+{Math.round((config.streakMaxBonus ?? 0) * 100)} %</p>
                  </div>
                  <div class="px-3 py-2.5 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
                    <p class="text-xs font-semibold text-on-surface-variant">{m.prg_field_streak_grace()}</p>
                    <p class="text-sm font-semibold text-on-surface">{config.streakGraceDays} j</p>
                  </div>
                  <div class="px-3 py-2.5 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
                    <p class="text-xs font-semibold text-on-surface-variant">{m.prg_field_streak_max_freezes()}</p>
                    <p class="text-sm font-semibold text-on-surface">{config.streakMaxFreezes}</p>
                  </div>
                </div>

                {#if streakOffGrid}
                  <SimpleModeNotice message={m.prg_streak_off_grid()} />
                {/if}
              </div>
            {:else}
              <div class="grid sm:grid-cols-2 xl:grid-cols-5 gap-3">
                <label class="block">
                  <span class="field-label">{m.prg_field_streak_bonus()}</span>
                  <input
                    type="number" min="0" max="100"
                    value={Math.round((config.streakBonusPerDay ?? 0) * 100)}
                    oninput={(e) => { config!.streakBonusPerDay = Number((e.currentTarget as HTMLInputElement).value) / 100; }}
                    class="prestige-input"
                    disabled={!canManageSettings}
                  />
                </label>
                <label class="block">
                  <span class="field-label">{m.prg_field_streak_max()}</span>
                  <input
                    type="number" min="0" max="500"
                    value={Math.round((config.streakMaxBonus ?? 0) * 100)}
                    oninput={(e) => { config!.streakMaxBonus = Number((e.currentTarget as HTMLInputElement).value) / 100; }}
                    class="prestige-input"
                    disabled={!canManageSettings}
                  />
                </label>
                <label class="block">
                  <span class="field-label">{m.prg_field_streak_grace()}</span>
                  <input type="number" min="0" max="7" bind:value={config.streakGraceDays} class="prestige-input" disabled={!canManageSettings} />
                </label>
                <label class="block">
                  <span class="field-label">{m.prg_field_streak_weekly_freezes()}</span>
                  <input type="number" min="0" max="7" bind:value={config.streakWeeklyFreezes} class="prestige-input" disabled={!canManageSettings} />
                </label>
                <label class="block">
                  <span class="field-label">{m.prg_field_streak_max_freezes()}</span>
                  <input type="number" min="0" max="14" bind:value={config.streakMaxFreezes} class="prestige-input" disabled={!canManageSettings} />
                </label>
              </div>
            {/if}

            <!-- Ce que la serie rapporte vraiment, jour par jour : trois nombres
                 ne disent pas ou le bonus plafonne. -->
            <div class="space-y-2 pt-4 border-t border-outline-variant/10">
              <div class="flex items-baseline justify-between gap-3">
                <h4 class="text-sm font-bold text-on-surface-variant">{m.prg_streak_preview_title()}</h4>
                <span class="text-2xs font-semibold text-primary">
                  {m.prg_streak_preview_peak({ percent: Math.round((streakCurveMax - 1) * 100) })}
                </span>
              </div>
              <div class="flex items-end gap-[3px] h-20 px-2 py-2 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
                {#each streakCurve as point (point.day)}
                  <div
                    class="flex-1 rounded-t-sm min-h-[2px] bg-warning/60"
                    style="height: {Math.max(2, ((point.multiplier - 1) / Math.max(0.01, streakCurveMax - 1)) * 100)}%"
                    title={m.prg_streak_preview_bar({ day: point.day, percent: Math.round((point.multiplier - 1) * 100) })}
                  ></div>
                {/each}
              </div>
              {@render ladderAxis(streakCurve.length)}
              <p class="text-2xs text-on-surface-variant ml-2">{m.prg_streak_preview_desc()}</p>
            </div>
          {/if}
        </section>

        {#if configDirty}
          {@render saveBar()}
        {/if}
      </div>
    {:else if activeTab === 'echelle'}
      <!-- ==================== ECHELLE & ROLES ==================== -->
      <div class="space-y-8 animate-in fade-in duration-300">
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
          <div class="flex items-start justify-between gap-4">
            <div>
              <h3 class="text-xl font-semibold flex items-center gap-3">
                <Papicon icon="shield" size={20} class="text-primary" />
                {m.prg_section_ladder()}
              </h3>
              <p class="text-xs text-on-surface-variant mt-1">{m.prg_ladder_hint()}</p>
            </div>
            <div class="flex flex-wrap items-center justify-end gap-2">
              <SimpleModeToggle simple={ladderMode.simple} onchange={(v) => ladderMode.set(v)} />
              {#if canManageSettings}
                <button
                  type="button"
                  onclick={resetLadderCurve}
                  class="text-2xs font-semibold text-on-surface-variant hover:text-on-surface px-3 py-1.5 rounded-lg border border-outline-variant/20 transition-all"
                >
                  {m.prg_ladder_reset()}
                </button>
              {/if}
            </div>
          </div>

          <!-- Quantite de roles : premier curseur de la carte, parce que c'est
               le premier chiffre qu'une guilde doit assumer - un palier, c'est un
               role Discord de plus a tenir. -->
          <div class="space-y-2">
            <div class="flex items-baseline justify-between gap-3">
              <label for="tierCount" class="text-xs font-semibold text-on-surface-variant ml-2">{m.prg_ladder_count_label()}</label>
              <span class="text-xs font-semibold text-primary">{m.prg_ladder_count_value({ count: tierCountStep })}</span>
            </div>
            <input
              id="tierCount"
              type="range"
              min={LADDER_CURVE_LIMITS.tierCount.min}
              max={LADDER_CURVE_LIMITS.tierCount.max}
              step="1"
              value={tierCountStep}
              oninput={(e) => { config!.ladderTierCount = Number(e.currentTarget.value); }}
              class="w-full accent-primary"
              disabled={!canManageSettings}
            />
            <p class="text-2xs text-on-surface-variant ml-2">{m.prg_ladder_count_hint()}</p>
          </div>

          {#if ladderMode.simple}
            <div class="space-y-6">
              <div class="space-y-2">
                <div class="flex items-baseline justify-between gap-3">
                  <label for="ladderPace" class="text-xs font-semibold text-on-surface-variant ml-2">{m.prg_ladder_pace_label()}</label>
                  <span class="text-xs font-semibold text-primary">{LADDER_PACE_LABELS[pacePreviewStep - 1]()}</span>
                </div>
                <input
                  id="ladderPace"
                  type="range" min="1" max="5" step="1"
                  value={pacePreviewStep}
                  oninput={(e) => applyLadderPace(Number(e.currentTarget.value))}
                  class="w-full accent-primary"
                  disabled={!canManageSettings}
                />
              </div>

              <div class="space-y-2">
                <div class="flex items-baseline justify-between gap-3">
                  <label for="ladderSteep" class="text-xs font-semibold text-on-surface-variant ml-2">{m.prg_ladder_steep_label()}</label>
                  <span class="text-xs font-semibold text-primary">{LADDER_STEEP_LABELS[steepPreviewStep - 1]()}</span>
                </div>
                <input
                  id="ladderSteep"
                  type="range" min="1" max="5" step="1"
                  value={steepPreviewStep}
                  oninput={(e) => applyLadderSteepness(Number(e.currentTarget.value))}
                  class="w-full accent-primary"
                  disabled={!canManageSettings}
                />
              </div>

              {#if curveOffGrid}
                <SimpleModeNotice message={m.prg_ladder_off_grid()} />
              {/if}
            </div>
          {:else}
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
              <label class="block">
                <span class="field-label">{m.prg_ladder_base_rp()}</span>
                <input
                  type="number"
                  min={LADDER_CURVE_LIMITS.baseRp.min}
                  max={LADDER_CURVE_LIMITS.baseRp.max}
                  bind:value={config.ladderBaseRp}
                  class="prestige-input"
                  disabled={!canManageSettings}
                />
                <span class="text-2xs text-on-surface-variant ml-2">{m.prg_ladder_base_rp_hint()}</span>
              </label>
              <label class="block">
                <span class="field-label">{m.prg_ladder_exponent()}</span>
                <input
                  type="number" step="0.05"
                  min={LADDER_CURVE_LIMITS.exponent.min}
                  max={LADDER_CURVE_LIMITS.exponent.max}
                  bind:value={config.ladderExponent}
                  class="prestige-input"
                  disabled={!canManageSettings}
                />
                <span class="text-2xs text-on-surface-variant ml-2">{m.prg_ladder_exponent_hint()}</span>
              </label>
            </div>
          {/if}

          <div class="space-y-2">
            <span class="text-xs font-semibold text-on-surface-variant ml-2">{m.prg_ladder_divisions_label()}</span>
            <FilterPills
              label={m.prg_ladder_divisions_label()}
              options={[1, 2, 3, 4, 5].map((count) => ({ value: String(count), label: String(count) }))}
              value={String(curveValues.ladderDivisions)}
              onchange={(value) => { config!.ladderDivisions = Number(value); }}
              disabled={!canManageSettings}
            />
            <p class="text-2xs text-on-surface-variant ml-2">{m.prg_ladder_divisions_hint()}</p>
          </div>

          <!-- Apercu : ecart de RP entre paliers successifs, puis repartition
               reelle des membres sous la meme echelle. -->
          <div class="space-y-3 pt-4 border-t border-outline-variant/10">
            <div>
              <h4 class="text-sm font-bold text-on-surface-variant">{m.prg_ladder_preview_title()}</h4>
              <p class="text-2xs text-on-surface-variant font-medium">{m.prg_ladder_preview_desc()}</p>
            </div>

            {#if savedLadderGaps.length > 0}
              <div class="flex items-center gap-4 text-2xs font-medium text-on-surface-variant">
                <span class="flex items-center gap-1.5">
                  <span class="w-3 h-2 rounded-sm bg-primary/60"></span>{m.prg_ladder_legend_edited()}
                </span>
                <span class="flex items-center gap-1.5">
                  <span class="w-3 h-[2px] bg-on-surface-variant/70"></span>{m.prg_ladder_legend_saved()}
                </span>
              </div>
            {/if}

            <div class="flex items-end gap-[3px] h-32 px-2 py-2 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
              {#each ladderGaps as entry, index (entry.tier.key)}
                {@const savedGap = savedLadderGaps[index]}
                <div
                  class="relative flex-1 h-full flex items-end"
                  title="{entry.tier.name} · {entry.tier.minRp.toLocaleString()} RP{savedGap === undefined ? '' : ` · ${m.prg_ladder_legend_saved()} ${savedGap.toLocaleString()} RP`}"
                >
                  <div
                    class="w-full rounded-t-sm min-h-[2px]"
                    style="height: {Math.max(2, (entry.gap / ladderGapMax) * 100)}%; background: {entry.tier.color}99"
                  ></div>
                  {#if savedGap !== undefined}
                    <!-- Anneau de la couleur du fond : le repere reste lisible
                         quand il tombe au milieu de la barre. -->
                    <div
                      class="absolute inset-x-0 h-[2px] bg-on-surface-variant/70 pointer-events-none"
                      style="bottom: calc({Math.min(100, (savedGap / ladderGapMax) * 100)}% - 1px); box-shadow: 0 0 0 1px var(--color-surface-container-low, transparent);"
                    ></div>
                  {/if}
                </div>
              {/each}
            </div>

            {@render ladderAxis(ladderGaps.length)}

            {#if impact}
              <div>
                <h4 class="text-sm font-bold text-on-surface-variant">{m.prg_ladder_population_title()}</h4>
                <p class="text-2xs text-on-surface-variant font-medium">{m.prg_ladder_population_desc()}</p>
              </div>

              <div class="flex items-end gap-[3px] h-16 px-2 py-2 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
                {#each impact.distribution as count, index}
                  <div
                    class="flex-1 rounded-t-sm min-h-[2px] {count > 0 ? 'bg-teal-600' : 'bg-outline-variant/20'}"
                    style="height: {count > 0 ? Math.max(4, (count / impactMax) * 100) : 0}%"
                    title="{previewLadder[index]?.name ?? ''} · {count.toLocaleString()}"
                  ></div>
                {/each}
              </div>

              {@render ladderAxis(impact.distribution.length)}
            {/if}

            <div class="flex flex-wrap items-center justify-between gap-3 pt-1">
              <p class="text-2xs text-on-surface-variant">{m.prg_estimate_intro()}</p>
              <FilterPills
                label={m.prg_estimate_intro()}
                options={ACTIVITY_LABELS.map((label, index) => ({ value: String(index + 1), label: label() }))}
                value={String(activityStep)}
                onchange={(value) => (activityStep = Number(value))}
              />
            </div>

            <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {#each ladderMilestones as tier (tier.key)}
                <div class="px-3 py-2.5 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
                  <p class="text-xs font-semibold truncate" style="color: {tier.color}">{tier.name}</p>
                  <p class="text-sm font-semibold text-on-surface">{tier.minRp.toLocaleString()} RP</p>
                  <p class="text-2xs font-semibold text-primary">{formatDuration(estimateDays(tier.minRp))}</p>
                </div>
              {/each}
            </div>

            {#if ladderDirty}
              <div class="p-3 bg-warning/10 border border-warning/20 rounded-lg text-2xs text-warning leading-relaxed flex items-start gap-2">
                <Papicon icon="AlertTriangle" size={13} class="shrink-0 mt-0.5" />
                <div class="min-w-0 flex-1">
                  {#if impact && impact.changed > 0}
                    <p class="font-bold mb-1">{m.prg_ladder_impact({ changed: impact.changed.toLocaleString(), total: impact.total.toLocaleString() })}</p>
                  {/if}
                  {m.prg_ladder_warning({ apex: apexRp.toLocaleString() })}
                </div>
              </div>
            {/if}

            {#if ladderOffGrid}
              <SimpleModeNotice message={m.prg_ladder_custom_notice()} />
            {/if}
          </div>
        </section>

        <!-- ==================== ROLES DE PALIER ==================== -->
        <SectionCard title={m.prg_section_tier_roles()} description={m.prg_tier_roles_hint()} icon="shield">
          <div class="space-y-5">
            <div class="grid sm:grid-cols-2 gap-2">
              <label class="flex items-center justify-between gap-4">
                <span class="text-body-sm text-on-surface-variant">{m.prg_field_tier_roles_enabled()}</span>
                <ToggleSwitch checked={config.tierRolesEnabled} size="sm" onToggle={(v) => patch({ tierRolesEnabled: v })} />
              </label>
              <label class="flex items-center justify-between gap-4">
                <span class="text-body-sm text-on-surface-variant">{m.prg_field_tier_roles_exclusive()}</span>
                <ToggleSwitch checked={config.tierRolesExclusive} size="sm" onToggle={(v) => patch({ tierRolesExclusive: v })} />
              </label>
            </div>

            <!-- Creation et attribution : les deux gestes qui manquaient. Rien
                 ne part tout seul - creer vingt roles et en deplacer des
                 milliers sont des decisions, pas des effets de bord. -->
            <div class="rounded-lg border border-outline-variant/20 bg-surface-container-low/30 p-4 space-y-4">
              <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div class="space-y-0.5 min-w-0">
                  <p class="text-body-sm font-semibold text-on-surface">{m.prg_roles_provision_title()}</p>
                  <p class="text-2xs text-on-surface-variant leading-relaxed">
                    {tiersWithoutRole === 0
                      ? m.prg_roles_provision_done({ count: activeLadder.length })
                      : m.prg_roles_provision_desc({ count: tiersWithoutRole })}
                  </p>
                </div>
                <button
                  type="button"
                  onclick={handleProvisionRoles}
                  disabled={roleAction.state.loading || tiersWithoutRole === 0}
                  class="shrink-0 px-5 py-2.5 bg-primary text-on-primary text-xs font-bold rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  <Papicon icon="sparkles" size={15} />
                  {m.prg_roles_provision_action()}
                </button>
              </div>

              <!-- Le geste inverse : une echelle refondue laisse sinon une
                   vingtaine de roles a supprimer un par un dans Discord. -->
              <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-3 border-t border-outline-variant/10">
                <div class="space-y-0.5 min-w-0">
                  <p class="text-body-sm font-semibold text-on-surface">{m.prg_roles_delete_title()}</p>
                  <p class="text-2xs text-on-surface-variant leading-relaxed">
                    {linkedRoleCount === 0
                      ? m.prg_roles_delete_none()
                      : m.prg_roles_delete_desc({ count: linkedRoleCount })}
                  </p>
                </div>
                <button
                  type="button"
                  onclick={handleDeleteRoles}
                  disabled={roleAction.state.loading || linkedRoleCount === 0}
                  class="shrink-0 px-5 py-2.5 bg-error/10 text-error text-xs font-bold rounded-lg hover:bg-error/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  <Papicon icon="Trash" size={15} />
                  {m.prg_roles_delete_action()}
                </button>
              </div>

              <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-3 border-t border-outline-variant/10">
                <div class="space-y-0.5 min-w-0">
                  <p class="text-body-sm font-semibold text-on-surface">{m.prg_roles_sync_title()}</p>
                  <p class="text-2xs text-on-surface-variant leading-relaxed">{m.prg_roles_sync_desc()}</p>
                </div>
                {#if roleSync.running}
                  <div class="flex items-center gap-3 shrink-0">
                    <span class="text-2xs font-semibold text-on-surface-variant tabular-nums">
                      {m.prg_roles_sync_progress({ done: roleSync.done.toLocaleString(), total: roleSync.pending.toLocaleString() })}
                    </span>
                    <button type="button" onclick={stopRoleSync} class="px-4 py-2 bg-error/10 text-error font-medium text-xs rounded-lg hover:bg-error/20 transition-all">
                      {m.prg_roles_sync_stop()}
                    </button>
                  </div>
                {:else}
                  <button
                    type="button"
                    onclick={startRoleSync}
                    disabled={roleAction.state.loading}
                    use:explainDisabled={(!config.tierRolesEnabled) ? m.common_reason_pick_role() : ''}
                    class="shrink-0 px-5 py-2.5 bg-secondary text-on-secondary text-xs font-bold rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {m.prg_roles_sync_action()}
                  </button>
                {/if}
              </div>

            </div>

            <div class="grid sm:grid-cols-2 xl:grid-cols-3 gap-2">
              {#each activeLadder as tier (tier.key)}
                {@const linkedRoleId = roleFor(tier.key)}
                {@const missingRole = !!linkedRoleId && isMissingReference(linkedRoleId, roles)}
                <div class="flex items-center gap-3 rounded-lg border px-3 py-2 {missingRole ? 'border-warning/30 bg-warning/5' : 'border-outline-variant/20 bg-surface-container-low/30'}">
                  <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:{tier.color}"></span>
                  <div class="min-w-0 flex-1">
                    <p class="text-body-sm font-semibold text-on-surface truncate">{tier.name}</p>
                    <p class="text-2xs text-on-surface-variant">
                      {tier.minRp.toLocaleString()} RP
                      {#if missingRole}
                        <!-- Le role a ete supprime sur Discord : la ligne
                             existe toujours en base et n'attribuait plus rien,
                             sans que rien ne le dise. -->
                        <span class="text-warning font-semibold" title={m.prg_role_missing_hint()}>
                          · {m.prg_role_missing()}
                        </span>
                      {/if}
                    </p>
                  </div>
                  <select
                    value={missingRole ? '' : (linkedRoleId ?? '')}
                    onchange={(e) => bindRole(tier.key, (e.currentTarget as HTMLSelectElement).value)}
                    class="prestige-input mt-0! max-w-[45%]"
                    disabled={!canManageSettings}
                  >
                    <option value="">{m.prg_ladder_no_role()}</option>
                    {#each roles as role (role.id)}
                      <option value={role.id}>{role.name}</option>
                    {/each}
                  </select>
                </div>
              {/each}
            </div>

            {#if orphanTierRoles.length > 0}
              <!-- Paliers disparus d'une echelle raccourcie : leurs roles
                   existent encore sur Discord et restent portes par des membres,
                   mais plus rien ne les attribue ni ne les retire. -->
              <div class="p-4 bg-warning/10 border border-warning/20 rounded-lg space-y-3">
                <div class="flex items-start gap-2 text-2xs text-warning leading-relaxed">
                  <Papicon icon="AlertTriangle" size={13} class="shrink-0 mt-0.5" />
                  <p>{m.prg_roles_orphan_desc({ count: orphanTierRoles.length })}</p>
                </div>
                <div class="flex flex-wrap gap-2">
                  {#each orphanTierRoles as mapping (mapping.tierKey)}
                    {@const role = roles.find((entry) => entry.id === mapping.roleId)}
                    <span class="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-surface-container-high/40 text-2xs font-medium text-on-surface-variant">
                      {mapping.tierKey}
                      <span class="text-on-surface-variant">→ {role ? `@${role.name}` : m.prg_role_missing()}</span>
                      {#if canManageSettings}
                        <button
                          type="button"
                          onclick={() => bindRole(mapping.tierKey, '')}
                          class="text-error hover:opacity-80"
                          title={m.prg_roles_orphan_unlink()}
                        >
                          <Papicon icon="Trash" size={12} />
                        </button>
                      {/if}
                    </span>
                  {/each}
                </div>
              </div>
            {/if}
          </div>
        </SectionCard>

        <!-- ==================== DECAY ==================== -->
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
          <div class="flex items-start justify-between gap-4">
            <div>
              <h3 class="text-xl font-semibold flex items-center gap-3">
                <Papicon icon="arrow-down" size={20} class="text-error" />
                {m.prg_section_decay()}
              </h3>
              <p class="text-xs text-on-surface-variant mt-1">{m.prg_section_decay_hint()}</p>
            </div>
            {#if config.decayEnabled}
              <SimpleModeToggle simple={decayMode.simple} onchange={(v) => decayMode.set(v)} />
            {/if}
          </div>

          <label class="flex items-center justify-between gap-4">
            <span class="text-body-sm font-medium text-on-surface">{m.prg_field_decay_enabled()}</span>
            <ToggleSwitch checked={config.decayEnabled} onToggle={(v) => { config!.decayEnabled = v; }} disabled={!canManageSettings} />
          </label>

          {#if config.decayEnabled}
            {#if decayMode.simple}
              <div class="space-y-2">
                <div class="flex items-baseline justify-between gap-3">
                  <label for="decayLevel" class="text-xs font-semibold text-on-surface-variant ml-2">{m.prg_decay_level_label()}</label>
                  <span class="text-xs font-semibold text-primary">{DECAY_LABELS[decayStep - 1]()}</span>
                </div>
                <input
                  id="decayLevel"
                  type="range" min="1" max="5" step="1"
                  value={decayStep}
                  oninput={(e) => applyDecayStep(Number(e.currentTarget.value))}
                  class="w-full accent-primary"
                  disabled={!canManageSettings}
                />

                <div class="grid grid-cols-3 gap-3 pt-2">
                  <div class="px-3 py-2.5 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
                    <p class="text-xs font-semibold text-on-surface-variant">{m.prg_field_decay_grace()}</p>
                    <p class="text-sm font-semibold text-on-surface">{config.decayGraceDays} j</p>
                  </div>
                  <div class="px-3 py-2.5 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
                    <p class="text-xs font-semibold text-on-surface-variant">{m.prg_field_decay_rp()}</p>
                    <p class="text-sm font-semibold text-on-surface">−{config.decayRpPerDay}/j</p>
                  </div>
                  <div class="px-3 py-2.5 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
                    <p class="text-xs font-semibold text-on-surface-variant">{m.prg_field_decay_percent()}</p>
                    <p class="text-sm font-semibold text-on-surface">−{Math.round((config.decayPercentPerDay ?? 0) * 100)} %/j</p>
                  </div>
                </div>

                {#if decayOffGrid}
                  <SimpleModeNotice message={m.prg_decay_off_grid()} />
                {/if}
              </div>
            {:else}
              <div class="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
                <label class="block">
                  <span class="field-label">{m.prg_field_decay_grace()}</span>
                  <input type="number" min="0" max="60" bind:value={config.decayGraceDays} class="prestige-input" disabled={!canManageSettings} />
                </label>
                <label class="block">
                  <span class="field-label">{m.prg_field_decay_rp()}</span>
                  <input type="number" min="0" bind:value={config.decayRpPerDay} class="prestige-input" disabled={!canManageSettings} />
                </label>
                <label class="block">
                  <span class="field-label">{m.prg_field_decay_percent()}</span>
                  <input
                    type="number" min="0" max="50"
                    value={Math.round((config.decayPercentPerDay ?? 0) * 100)}
                    oninput={(e) => { config!.decayPercentPerDay = Number((e.currentTarget as HTMLInputElement).value) / 100; }}
                    class="prestige-input"
                    disabled={!canManageSettings}
                  />
                </label>
              </div>
            {/if}

            <label class="block max-w-sm">
              <span class="field-label">{m.prg_field_decay_floor()}</span>
              <!-- Les paliers proposes sont ceux qui seront enregistres :
                   choisir un plancher dans l'ancienne echelle poserait une cle
                   que la nouvelle ne connait pas. -->
              <select bind:value={config.decayFloorTierKey} class="prestige-input" disabled={!canManageSettings}>
                <option value={null}>{m.prg_decay_floor_none()}</option>
                {#each (ladderDirty ? previewLadder : activeLadder) as tier (tier.key)}
                  <option value={tier.key}>{tier.name}</option>
                {/each}
              </select>
            </label>

            <!-- Ce que l'absence coute vraiment : trois nombres ne disent pas
                 combien de jours separent un membre de sa retrogradation. -->
            <div class="space-y-2 pt-4 border-t border-outline-variant/10">
              <div class="flex items-baseline justify-between gap-3">
                <h4 class="text-sm font-bold text-on-surface-variant">{m.prg_decay_preview_title()}</h4>
                <span class="text-2xs font-semibold text-error">
                  {decayDaysToDemotion === null
                    ? m.prg_decay_preview_safe()
                    : m.prg_decay_preview_demotion({ days: decayDaysToDemotion })}
                </span>
              </div>
              <div class="flex items-end gap-[3px] h-20 px-2 py-2 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
                {#each decayCurve as rp, days}
                  <div
                    class="flex-1 rounded-t-sm min-h-[2px] bg-error/50"
                    style="height: {Math.max(2, (rp / Math.max(1, decayReferenceRp)) * 100)}%"
                    title={m.prg_decay_preview_bar({ days, rp: rp.toLocaleString() })}
                  ></div>
                {/each}
              </div>
              {@render ladderAxis(decayCurve.length)}
              <p class="text-2xs text-on-surface-variant ml-2">
                {m.prg_decay_preview_desc({ rp: decayReferenceRp.toLocaleString() })}
              </p>
            </div>

            <div class="flex flex-wrap items-center gap-2 pt-1">
              <button class="px-3 py-1.5 rounded-lg bg-surface-container-high/40 text-on-surface-variant text-xs font-bold" onclick={handlePreviewDecay}>
                {m.prg_btn_preview_decay()}
              </button>
              {#if canManageSettings}
                <button class="px-3 py-1.5 rounded-lg bg-error/10 text-error text-xs font-bold" onclick={handleRunDecay}>
                  {m.prg_btn_run_decay()}
                </button>
              {/if}
              {#if decayPreview}
                <span class="text-xs text-on-surface-variant">
                  {m.prg_decay_preview({ affected: decayPreview.affected, rpLost: decayPreview.rpLost })}
                </span>
              {/if}
            </div>
          {/if}
        </section>

        {#if configDirty}
          {@render saveBar()}
        {/if}
      </div>
    {:else if activeTab === 'annonces'}
      <!-- ==================== ANNONCES ==================== -->
      <div class="space-y-8 animate-in fade-in duration-300">
        <InlineFeedback state={announceAction} />

        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
          <div>
            <h3 class="text-xl font-semibold flex items-center gap-3">
              <Papicon icon="bell" size={20} class="text-primary" />
              {m.prg_section_announce()}
            </h3>
            <p class="text-xs text-on-surface-variant mt-1">{m.prg_section_announce_hint()}</p>
          </div>

          <div class="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
            <label class="block flex-1 max-w-sm">
              <span class="field-label">{m.prg_field_announce_channel()}</span>
              <select
                bind:value={config.announceChannelId}
                onchange={() => patch({ announceChannelId: config?.announceChannelId ?? null })}
                class="prestige-input"
                disabled={!canManageSettings}
              >
                <option value={null}>{m.prg_announce_channel_none()}</option>
                {#each channels as channel (channel.id)}
                  <option value={channel.id}>#{channel.name}</option>
                {/each}
              </select>
            </label>

            {#if canManageSettings && announceChannelState !== 'channel'}
              <!-- Creer le salon n'a de sens que quand aucun ne tient le role. -->
              <button
                type="button"
                onclick={handleCreateAnnounceChannel}
                disabled={announceAction.state.loading}
                class="shrink-0 px-5 py-3 bg-primary hover:bg-primary/90 text-on-primary text-body-sm font-medium rounded-lg shadow-md shadow-primary/20 transition-all disabled:opacity-50 flex items-center gap-2"
              >
                <Papicon icon="sparkles" size={16} />
                {announceAction.state.loading ? m.prg_announce_creating() : m.prg_announce_create()}
              </button>
            {/if}
          </div>

          <p class="text-2xs text-on-surface-variant">
            {#if announceChannelState === 'channel'}
              {m.prg_announce_channel_set({ channel: announceChannelLabel })}
            {:else if announceChannelState === 'missing'}
              {m.prg_announce_channel_missing()}
            {:else}
              {m.prg_announce_channel_desc()}
            {/if}
          </p>

          <div class="grid sm:grid-cols-3 gap-3 pt-4 border-t border-outline-variant/10">
            <label class="flex items-center justify-between gap-4">
              <span class="text-body-sm text-on-surface-variant">{m.prg_field_announce_promotions()}</span>
              <ToggleSwitch checked={config.announcePromotions} size="sm" onToggle={(v) => patch({ announcePromotions: v })} disabled={!canManageSettings} />
            </label>
            <label class="flex items-center justify-between gap-4">
              <span class="text-body-sm text-on-surface-variant">{m.prg_field_announce_demotions()}</span>
              <ToggleSwitch checked={config.announceDemotions} size="sm" onToggle={(v) => patch({ announceDemotions: v })} disabled={!canManageSettings} />
            </label>
            <label class="flex items-center justify-between gap-4">
              <span class="text-body-sm text-on-surface-variant">{m.prg_field_global()}</span>
              <ToggleSwitch checked={config.globalLeaderboard} size="sm" onToggle={(v) => patch({ globalLeaderboard: v })} disabled={!canManageSettings} />
            </label>
          </div>
        </section>

        <!-- Textes des annonces : vides, ce sont les messages traduits par
             defaut. Chaque champ montre ce qui partira reellement. -->
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
          <div>
            <h3 class="text-xl font-semibold flex items-center gap-3">
              <Papicon icon="edit" size={20} class="text-secondary" />
              {m.prg_section_messages()}
            </h3>
            <p class="text-xs text-on-surface-variant mt-1">{m.prg_section_messages_hint()}</p>
          </div>

          <div class="flex flex-wrap gap-2">
            {#each ['{user}', '{tier}', '{from}', '{rp}'] as variable (variable)}
              <code class="px-2 py-1 rounded-lg bg-surface-container-high/40 text-2xs font-mono text-primary">{variable}</code>
            {/each}
            <span class="text-2xs text-on-surface-variant self-center">{m.prg_messages_variables_hint()}</span>
          </div>

          <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div class="space-y-2">
              <label for="promoMessage" class="field-label">{m.prg_field_promotion_message()}</label>
              <textarea
                id="promoMessage"
                rows="3"
                placeholder={m.prg_message_default_promotion()}
                bind:value={config.announcePromotionMessage}
                class="prestige-input font-mono text-xs"
                disabled={!canManageSettings}
              ></textarea>
              <p class="text-2xs text-on-surface-variant bg-surface-container-high/20 border border-outline-variant/5 rounded-lg px-3 py-2">
                {announcePreview(config.announcePromotionMessage ?? '', m.prg_message_default_promotion())}
              </p>
            </div>

            <div class="space-y-2">
              <label for="demoMessage" class="field-label">{m.prg_field_demotion_message()}</label>
              <textarea
                id="demoMessage"
                rows="3"
                placeholder={m.prg_message_default_demotion()}
                bind:value={config.announceDemotionMessage}
                class="prestige-input font-mono text-xs"
                disabled={!canManageSettings}
              ></textarea>
              <p class="text-2xs text-on-surface-variant bg-surface-container-high/20 border border-outline-variant/5 rounded-lg px-3 py-2">
                {announcePreview(config.announceDemotionMessage ?? '', m.prg_message_default_demotion())}
              </p>
            </div>
          </div>

          <p class="text-2xs text-on-surface-variant">{m.prg_messages_empty_hint()}</p>
        </section>

        {#if configDirty}
          {@render saveBar()}
        {/if}
      </div>
    {:else if activeTab === 'evenements'}
      <!-- ==================== EVENEMENTS ==================== -->
      <SectionCard title={m.prg_section_events()} description={m.prg_events_hint()} icon="zap">
        {#snippet actions()}
          <button
            class="px-3 py-1.5 rounded-lg bg-primary text-on-primary text-xs font-bold flex items-center gap-1.5"
            onclick={() => (showEventForm = !showEventForm)}
          >
            <Papicon icon="plus" size={14} />
            {m.prg_btn_new_event()}
          </button>
        {/snippet}

        <div class="space-y-4">
          {#if showEventForm}
            <div class="rounded-lg border border-outline-variant/20 bg-surface-container-low/30 p-4 space-y-3">
              <div class="grid sm:grid-cols-2 xl:grid-cols-5 gap-3">
                <label class="block">
                  <span class="field-label">{m.prg_event_type()}</span>
                  <select bind:value={newEvent.type} class="prestige-input">
                    {#each EVENT_TYPES as type (type.value)}
                      <option value={type.value}>{type.label}</option>
                    {/each}
                  </select>
                </label>
                <label class="block">
                  <span class="field-label">{m.prg_event_name()}</span>
                  <input type="text" bind:value={newEvent.name} class="prestige-input" />
                </label>
                <label class="block">
                  <span class="field-label">{m.prg_event_multiplier()}</span>
                  <input type="number" min="1" max="10" step="0.5" bind:value={newEvent.multiplier} class="prestige-input" />
                </label>
                <label class="block">
                  <span class="field-label">{m.prg_event_duration()}</span>
                  <input type="number" min="5" max="1440" bind:value={newEvent.durationMinutes} class="prestige-input" />
                </label>
                <label class="block">
                  <span class="field-label">{m.prg_event_channel()}</span>
                  <select bind:value={newEvent.announceChannelId} class="prestige-input">
                    <option value="">-</option>
                    {#each channels as channel (channel.id)}
                      <option value={channel.id}>#{channel.name}</option>
                    {/each}
                  </select>
                </label>
              </div>
              <div class="flex justify-end gap-2">
                <button class="px-3 py-1.5 rounded-lg bg-surface-container-high/40 text-on-surface-variant text-xs font-bold" onclick={() => (showEventForm = false)}>
                  {m.prg_btn_cancel()}
                </button>
                <button class="px-3 py-1.5 rounded-lg bg-primary text-on-primary text-xs font-bold" onclick={handleCreateEvent}>
                  {m.prg_btn_create()}
                </button>
              </div>
            </div>
          {/if}

          {#if events.length === 0}
            <EmptyState icon="zap" title={m.prg_event_empty()} reason="accumulating" />
          {:else}
            <div class="space-y-1">
              {#each events as event (event.id)}
                <div class="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-surface-container-high/10">
                  <span class="px-2 py-0.5 rounded-full text-2xs font-medium {statusClass(event.status)}">{statusLabel(event.status)}</span>
                  <div class="min-w-0 flex-1">
                    <p class="text-body-sm font-semibold text-on-surface truncate">{event.name} · ×{event.multiplier}</p>
                    <p class="text-2xs text-on-surface-variant">
                      {new Date(event.startsAt).toLocaleString()} → {new Date(event.endsAt).toLocaleString()}
                    </p>
                  </div>
                  <span class="text-2xs text-on-surface-variant hidden sm:block">
                    {m.prg_event_result({ participants: event.participants, bonus: event.bonusRpGranted })}
                  </span>
                  {#if event.status === 'SCHEDULED' || event.status === 'RUNNING'}
                    <button class="text-2xs font-bold text-error" onclick={() => handleCancelEvent(event.id)}>
                      {m.prg_btn_cancel_event()}
                    </button>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </SectionCard>
    {:else}
      <!-- ==================== CLASSEMENTS ==================== -->
      <div class="space-y-6 animate-in fade-in duration-300">
        <!-- Le classement est fait pour etre montre : le lien public le sort
             du dashboard, sans authentification ni compte Discord. -->
        {#if publicBoardUrl}
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-surface-container-low/30 border border-outline-variant/10 rounded-xl px-5 py-4">
            <div class="flex items-start gap-3 min-w-0">
              <div class="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                <Papicon icon="globe" size={18} />
              </div>
              <div class="min-w-0 space-y-0.5">
                <p class="text-sm font-semibold text-on-surface">{m.prg_public_link_title()}</p>
                <p class="text-xs font-mono text-on-surface-variant truncate">{publicBoardUrl}</p>
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onclick={copyPublicUrl}
                class="px-4 py-2.5 rounded-lg bg-surface-container-high/40 hover:bg-surface-container-high/60 text-on-surface text-xs font-bold transition-all flex items-center gap-2"
              >
                <Papicon icon={copiedPublicUrl ? 'Check' : 'copy'} size={14} />
                {copiedPublicUrl ? m.prg_public_link_copied() : m.prg_public_link_copy()}
              </button>
              <a
                href={publicBoardUrl}
                target="_blank"
                rel="noopener noreferrer"
                class="px-4 py-2.5 rounded-lg bg-primary text-on-primary text-xs font-bold transition-all flex items-center gap-2"
              >
                <Papicon icon="ArrowRight" size={14} />
                {m.prg_public_link_open()}
              </a>
            </div>
          </div>
        {/if}

        <div class="flex flex-wrap items-center justify-between gap-3">
          <FilterPills
            label={m.prg_tab_leaderboard()}
            options={[
              { value: 'guild', label: m.prg_board_guild() },
              { value: 'global', label: m.prg_board_global() },
            ]}
            value={boardView}
            onchange={(value) => (boardView = value)}
          />

          {#if boardView === 'guild'}
            <div class="relative flex-1 min-w-[240px] max-w-sm">
              <input
                type="search"
                bind:value={boardSearch}
                placeholder={m.prg_board_search_placeholder()}
                class="prestige-input mt-0! pl-9"
              />
              <span class="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant">
                <Papicon icon="search" size={14} />
              </span>
            </div>
          {/if}
        </div>

        {#if boardView === 'global'}
          <!-- Le classement global additionne le RP d'un membre sur tous les
               serveurs qui y participent : il ne se regle pas ici, il se lit. -->
          <SectionCard title={m.prg_section_global()} description={m.prg_global_hint()} icon="globe">
            {#if globalRows.length === 0}
              <EmptyState icon="globe" title={m.prg_global_empty()} description={config.globalLeaderboard ? undefined : m.prg_global_opted_out()} actionLabel={config.globalLeaderboard ? '' : m.prg_global_open_settings()} actionIcon="ArrowRight" onAction={() => gotoTab('/prestige', 'annonces', DEFAULT_TAB)} reason="accumulating" />
            {:else}
              <div class="space-y-0.5">
                {#each globalRows as entry (entry.userId)}
                  <div class="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-container-high/10">
                    <span class="w-7 text-right text-body-sm font-semibold text-on-surface-variant">#{entry.rank}</span>
                    <UserDisplay userId={entry.userId} name={entry.displayName} avatarUrl={entry.avatarUrl} size="sm" class="min-w-0 flex-1" />
                    <span class="text-2xs text-on-surface-variant hidden sm:block">{m.prg_global_guilds({ count: entry.guilds })}</span>
                    <span class="px-2 py-0.5 rounded-full text-2xs font-medium" style="background:{entry.tier.color}22;color:{entry.tier.color}">
                      {entry.tier.name}
                    </span>
                    <span class="text-xs font-mono text-on-surface-variant w-16 text-right">{entry.rp.toLocaleString()}</span>
                  </div>
                {/each}
              </div>
            {/if}
          </SectionCard>
        {:else}
          {#if podium.length === 3}
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {#each [podium[1], podium[0], podium[2]] as entry, index (entry.userId)}
                {@const medal = index === 1 ? '🥇' : index === 0 ? '🥈' : '🥉'}
                <button
                  type="button"
                  onclick={() => openMember(entry.userId)}
                  class="text-left rounded-xl border px-4 py-4 transition-all hover:bg-surface-container-high/20 {index === 1 ? 'border-primary/40 bg-primary/5 sm:-translate-y-1' : 'border-outline-variant/15 bg-surface-container-low/30'}"
                >
                  <div class="flex items-center gap-2 mb-2">
                    <span class="text-lg leading-none">{medal}</span>
                    <span class="px-2 py-0.5 rounded-full text-2xs font-medium" style="background:{entry.tier.color}22;color:{entry.tier.color}">
                      {entry.tier.name}
                    </span>
                  </div>
                  <UserDisplay userId={entry.userId} name={entry.displayName} avatarUrl={entry.avatarUrl} size="sm" class="min-w-0" />
                  <p class="text-lg font-bold text-on-surface mt-2 tabular-nums">{entry.rp.toLocaleString()} <span class="text-2xs font-medium text-on-surface-variant">RP</span></p>
                </button>
              {/each}
            </div>
          {/if}

          <SectionCard title={m.prg_section_leaderboard()} icon="crown">
            {#if boardLoading && boardRows.length === 0}
              <LoadingHint context="members" />
            {:else if boardRows.length === 0}
              {#if boardSearch.trim()}
                <EmptyState icon="crown" title={m.prg_board_no_result()} actionLabel={m.common_clear_search()} actionIcon="Eraser" onAction={() => (boardSearch = '')} />
              {:else}
                <EmptyState icon="crown" title={m.prg_leaderboard_empty()} reason="accumulating" />
              {/if}
            {:else}
              <div class="space-y-0.5">
                {#each boardRows as entry (entry.userId)}
                  <button
                    type="button"
                    onclick={() => openMember(entry.userId)}
                    class="w-full flex items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-surface-container-high/10 {openedMemberId === entry.userId ? 'bg-primary/5' : ''}"
                  >
                    <span class="w-9 text-right text-body-sm font-semibold text-on-surface-variant tabular-nums">#{entry.rank}</span>
                    <UserDisplay userId={entry.userId} name={entry.displayName} avatarUrl={entry.avatarUrl} size="sm" class="min-w-0 flex-1" />
                    {#if entry.flames > 0}
                      <span class="text-body-sm hidden sm:inline" title={m.prg_streak_days({ days: entry.streakDays })}>{'🔥'.repeat(entry.flames)}</span>
                    {/if}
                    <span class="px-2 py-0.5 rounded-full text-2xs font-medium" style="background:{entry.tier.color}22;color:{entry.tier.color}">
                      {entry.tier.name}
                    </span>
                    <span class="text-xs font-mono text-on-surface-variant w-16 text-right">{entry.rp.toLocaleString()}</span>
                  </button>
                {/each}
              </div>

              {#if boardLimited}
                <p class="text-2xs text-on-surface-variant mt-3">{m.prg_board_search_limited()}</p>
              {/if}

              {#if boardPageCount > 1}
                <div class="flex items-center justify-between gap-3 pt-4 mt-3 border-t border-outline-variant/10">
                  <button
                    type="button"
                    onclick={() => loadBoard(boardPage - 1)}
                    disabled={boardPage <= 1 || boardLoading}
                    class="px-3 py-1.5 rounded-lg bg-surface-container-high/40 text-on-surface-variant text-xs font-bold disabled:opacity-40"
                  >
                    {m.prg_board_previous()}
                  </button>
                  <span class="text-2xs text-on-surface-variant tabular-nums">
                    {m.prg_board_page({ page: boardPage, pages: boardPageCount, total: boardTotal.toLocaleString() })}
                  </span>
                  <button
                    type="button"
                    onclick={() => loadBoard(boardPage + 1)}
                    disabled={boardPage >= boardPageCount || boardLoading}
                    class="px-3 py-1.5 rounded-lg bg-surface-container-high/40 text-on-surface-variant text-xs font-bold disabled:opacity-40"
                  >
                    {m.prg_board_next()}
                  </button>
                </div>
              {/if}
            {/if}
          </SectionCard>
        {/if}

        <!-- Fiche membre : le RP d'un membre, son historique, et l'ajustement
             manuel que l'API sait faire depuis toujours sans que rien ne
             l'expose. -->
        {#if openedMemberId}
          <SectionCard title={m.prg_member_title()} icon="users">
            {#snippet actions()}
              <button class="px-3 py-1.5 rounded-lg bg-surface-container-high/40 text-on-surface-variant text-xs font-bold" onclick={closeMember}>
                {m.prg_member_close()}
              </button>
            {/snippet}

            {#if memberLoading}
              <LoadingHint context="members" />
            {:else if memberProfile}
              <div class="space-y-5">
                <div class="flex flex-wrap items-center justify-between gap-3">
                  <UserDisplay
                    userId={openedMemberId}
                    name={memberProfile.displayName}
                    avatarUrl={memberProfile.avatarUrl}
                    size="md"
                    subtitle={m.prg_member_rank({ rank: memberProfile.rank, total: memberProfile.totalRanked })}
                  />
                  <span class="px-3 py-1 rounded-full text-xs font-semibold" style="background:{memberProfile.tier.color}22;color:{memberProfile.tier.color}">
                    {memberProfile.tier.name}
                  </span>
                </div>

                <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div class="px-3 py-2.5 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
                    <p class="text-xs font-semibold text-on-surface-variant">RP</p>
                    <p class="text-sm font-semibold text-on-surface tabular-nums">{memberProfile.rp.toLocaleString()}</p>
                  </div>
                  <div class="px-3 py-2.5 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
                    <p class="text-xs font-semibold text-on-surface-variant">{m.prg_member_peak()}</p>
                    <p class="text-sm font-semibold text-on-surface tabular-nums">{memberProfile.peakRp.toLocaleString()}</p>
                  </div>
                  <div class="px-3 py-2.5 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
                    <p class="text-xs font-semibold text-on-surface-variant">{m.prg_member_streak()}</p>
                    <p class="text-sm font-semibold text-on-surface">
                      {m.prg_streak_days({ days: memberProfile.streakDays })}
                      {#if !memberProfile.streakAlive}
                        <span class="text-2xs text-on-surface-variant">· {m.prg_member_streak_broken()}</span>
                      {/if}
                    </p>
                  </div>
                  <div class="px-3 py-2.5 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
                    <p class="text-xs font-semibold text-on-surface-variant">{m.prg_member_next()}</p>
                    <p class="text-sm font-semibold text-on-surface">
                      {memberProfile.nextTier
                        ? m.prg_member_next_value({ rp: memberProfile.rpRemaining.toLocaleString(), tier: memberProfile.nextTier.name })
                        : m.prg_member_next_apex()}
                    </p>
                  </div>
                </div>

                {#if memberCurve}
                  <div class="space-y-1.5">
                    <p class="text-xs font-semibold text-on-surface-variant">{m.prg_member_history()}</p>
                    <svg viewBox="0 0 100 100" preserveAspectRatio="none" class="w-full h-20 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
                      <path d={memberCurve} fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke" class="text-primary" />
                    </svg>
                  </div>
                {/if}

                {#if memberHistory.length > 0}
                  <div class="space-y-1">
                    {#each memberHistory.slice(-8).reverse() as entry (entry.createdAt + entry.delta)}
                      <div class="flex items-center gap-3 text-2xs px-2 py-1 rounded-lg hover:bg-surface-container-high/10">
                        <span class="w-16 font-mono tabular-nums {entry.delta >= 0 ? 'text-success' : 'text-error'}">
                          {entry.delta >= 0 ? '+' : ''}{entry.delta.toLocaleString()}
                        </span>
                        <span class="flex-1 text-on-surface-variant">{(RP_SOURCE_LABELS[entry.source] ?? (() => entry.source))()}</span>
                        <span class="text-on-surface-variant">{new Date(entry.createdAt).toLocaleDateString()}</span>
                        <span class="font-mono tabular-nums text-on-surface-variant w-16 text-right">{entry.rpAfter.toLocaleString()}</span>
                      </div>
                    {/each}
                  </div>
                {:else}
                  <p class="text-2xs text-on-surface-variant">{m.prg_member_history_empty()}</p>
                {/if}

                {#if canManageSettings}
                  <div class="pt-4 border-t border-outline-variant/10 space-y-3">
                    <InlineFeedback state={adjustAction} />
                    <p class="text-2xs text-on-surface-variant">{m.prg_member_adjust_hint()}</p>
                    <div class="flex flex-wrap items-end gap-3">
                      <label class="block w-32">
                        <span class="field-label">{m.prg_member_adjust_amount()}</span>
                        <input type="number" min="1" bind:value={adjustDelta} class="prestige-input" placeholder="100" />
                      </label>
                      <label class="block flex-1 min-w-[180px]">
                        <span class="field-label">{m.prg_member_adjust_reason()}</span>
                        <input type="text" bind:value={adjustReason} class="prestige-input" maxlength="200" />
                      </label>
                      <button
                        type="button"
                        onclick={() => handleAdjust(1)}
                        disabled={!adjustDelta || adjustAction.state.loading}
                        class="px-4 py-2.5 rounded-lg bg-success/10 text-success text-xs font-bold disabled:opacity-40"
                      >
                        {m.prg_member_adjust_add()}
                      </button>
                      <button
                        type="button"
                        onclick={() => handleAdjust(-1)}
                        disabled={!adjustDelta || adjustAction.state.loading}
                        class="px-4 py-2.5 rounded-lg bg-error/10 text-error text-xs font-bold disabled:opacity-40"
                      >
                        {m.prg_member_adjust_remove()}
                      </button>
                    </div>
                  </div>
                {/if}
              </div>
            {:else}
              <EmptyState icon="users" title={m.prg_member_not_found()} reason="accumulating" />
            {/if}
          </SectionCard>
        {/if}

        <SectionCard title={m.prg_section_streak_board()} icon="activity">
          {#if streaks.length === 0}
            <EmptyState icon="activity" title={m.prg_streak_board_empty()} reason="accumulating" />
          {:else}
            <div class="space-y-0.5">
              {#each streaks as entry (entry.userId)}
                <button
                  type="button"
                  onclick={() => openMember(entry.userId)}
                  class="w-full flex items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-surface-container-high/10"
                >
                  <span class="w-7 text-right text-body-sm font-semibold text-on-surface-variant">#{entry.rank}</span>
                  <UserDisplay userId={entry.userId} name={entry.displayName} avatarUrl={entry.avatarUrl} size="sm" class="min-w-0 flex-1" />
                  <span class="text-body-sm">{'🔥'.repeat(Math.max(1, entry.flames))}</span>
                  <span class="text-xs font-mono text-on-surface-variant w-14 text-right">
                    {m.prg_streak_days({ days: entry.streakDays })}
                  </span>
                </button>
              {/each}
            </div>
          {/if}
        </SectionCard>
      </div>
    {/if}
  {:else if !moduleEnabled}
    <!-- L'API refuse les routes d'un module eteint : il n'y a pas de
         configuration a montrer, seulement la raison. -->
    <ModuleDisabledNotice moduleKey="prestige" />
  {:else if loadFailed}
    <EmptyState icon="warning" title={m.prg_load_error()} description={m.prg_load_error_hint()}>
      {#snippet action()}
        <button
          type="button"
          onclick={load}
          class="px-5 py-2.5 rounded-lg bg-primary text-on-primary text-body-sm font-medium hover:bg-primary/90 transition-all"
        >
          {m.prg_load_retry()}
        </button>
      {/snippet}
    </EmptyState>
  {/if}
</ModulePage>

<style>
  .prestige-input {
    margin-top: 0.25rem;
    width: 100%;
    border-radius: 0.5rem;
    background: var(--surface-container, rgba(255, 255, 255, 0.04));
    border: 1px solid rgb(from var(--outline-variant, #444) r g b / 40%);
    padding: 0.5rem 0.75rem;
    font-size: 13px;
    color: var(--on-surface, inherit);
  }
</style>
