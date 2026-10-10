<script lang="ts">
  import { channelDisplayName } from '../lib/channelUtils';
  import { isMissingReference } from '../lib/discordReferences';
  import { m } from '../lib/i18n';
  import { onMount, onDestroy, untrack } from 'svelte';
  import { router } from 'tinro';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { pageTabItems } from '../lib/config/pageTabs';
  import { Tabs, FilterPills } from '../lib/components/ui';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { memberAvatarSrc } from '../lib/discordMedia';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import Callout from '../lib/components/ui/Callout.svelte';
  import Button from '../lib/components/ui/Button.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import SimpleModeToggle from '../lib/components/SimpleModeToggle.svelte';
  import SimpleModeNotice from '../lib/components/SimpleModeNotice.svelte';
  import LevelingPresetPicker from '../lib/components/LevelingPresetPicker.svelte';
  import { createSimpleModePreference, nearestStep } from '../lib/simpleMode.svelte';
  import {
    CURVE_EXPONENT_STEPS,
    CURVE_PACE_FACTORS,
    GAIN_STEPS,
    curvePaceValues,
    findLevelingPreset,
    levelingPresetValues,
    type LevelingPreset,
    type LevelingPresetValues,
  } from '../lib/levelingPresets';
  import { 
    fetchLevelingData,
    fetchLevelingCurveImpact,
    fetchLevelingLeaderboard,
    fetchLevelingRoleResync,
    runLevelingRoleResync,
    updateLevelingConfig,
    updateModuleStatus,
    createLevelUpChannel,
    addLevelingReward,
    deleteLevelingReward,
    importLevelingData,
    fetchClansData,
    updateClanSettings
  } from '../lib/api';
  import {
    DEFAULT_LEVEL_CURVE,
    LEVEL_CURVE_LIMITS,
    levelCurvePreview,
    normalizeLevelCurve,
    xpForLevel,
  } from '@kotbo/shared';

  const saveAction = createAsyncActionState();

  // Le module se bascule depuis le menu de ModulePage, qui ecrit aussi
  // `levelConfig.enabled`. Les deux ne divergent que sur un serveur passe par
  // l'ancien interrupteur de la page : l'encadre le dit et la bascule repare.
  let levelingLoaded = $state(false);
  const levelingModuleActive = $derived(
    (dashboardStore.state.modules as any[]).find((mod) => mod.id === 'leveling')?.status === 'active'
  );

  async function resumeLeveling() {
    await saveAction.run(async () => {
      const ok = await updateModuleStatus('leveling', 'active');
      if (!ok) throw new Error(m.lv_err_save());
      config.enabled = true;
      savedConfig.enabled = true;
      return true;
    });
  }
  const rewardAction = createAsyncActionState();
  const createChannelAction = createAsyncActionState();
  let loading = $state(false);
  // 'config' a disparu au profit d'onglets thematiques. Il n'est pas conserve
  // comme alias : `resolveTabFromUrl` renvoie l'onglet par defaut pour tout
  // segment inconnu, donc les anciens liens /leveling/config atterrissent sur
  // l'accueil au lieu de casser.
  // 'accueil' est la porte d'entree : la page s'ouvre sur les prereglages, la
  // configuration detaillee reste a un clic derriere.
  const levelingTabs = ['accueil', 'gains', 'progression', 'annonces', 'leaderboard', 'import'] as const;
  type LevelingTab = (typeof levelingTabs)[number];
  const DEFAULT_TAB: LevelingTab = 'accueil';
  let activeTab = $state<LevelingTab>(DEFAULT_TAB);

  $effect(() => {
    const _path = $router.path;
    activeTab = resolveTabFromUrl('/leveling', levelingTabs, DEFAULT_TAB) as LevelingTab;
  });
  let copySuccess = $state(false);

  const canManageSettings = $derived(
    !!(dashboardStore.state.featureAccess as any)?.leveling?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
  );

  const availableChannels = $derived(dashboardStore.state.discordChannels || []);
  const availableRoles = $derived(dashboardStore.state.discordRoles || []);

  // URL publique du classement
  const publicLeaderboardUrl = $derived(
    authStore.selectedGuildId
      ? `${window.location.origin}/${authStore.selectedGuildId}/leveling/classement`
      : ''
  );

  let config = $state({
    enabled: false,
    xpMin: 15,
    xpMax: 25,
    cooldownSeconds: 60,
    vocalXpPerMin: 5,
    levelUpChannelId: null as string | null,
    levelUpMessage: 'Félicitations {user} ! Tu passes au niveau **{level}** ! 🎉',
    stackRewards: false,
    ignoredChannels: [] as string[],
    ignoredRoles: [] as string[],
    xpMultipliers: {} as Record<string, number>,
    lengthBonusEnabled: false,
    lengthBonusThreshold: 200,
    lengthBonusMaxMultiplier: 2.0,
    curveBaseXp: DEFAULT_LEVEL_CURVE.baseXp,
    curveLinearXp: DEFAULT_LEVEL_CURVE.linearXp,
    curveExponent: DEFAULT_LEVEL_CURVE.exponent,
    maxLevel: DEFAULT_LEVEL_CURVE.maxLevel,
    voiceRequireUnmuted: true,
    voiceRequireUndeafened: true,
    voiceIgnoreAfkChannel: true,
    voiceMinMembers: 1,
    dailyXpCap: 0
  });

  // Snapshot of last-saved state
  let savedConfig = $state(JSON.parse(JSON.stringify({
    enabled: false,
    xpMin: 15,
    xpMax: 25,
    cooldownSeconds: 60,
    vocalXpPerMin: 5,
    levelUpChannelId: null as string | null,
    levelUpMessage: 'Félicitations {user} ! Tu passes au niveau **{level}** ! 🎉',
    stackRewards: false,
    ignoredChannels: [] as string[],
    ignoredRoles: [] as string[],
    xpMultipliers: {} as Record<string, number>,
    lengthBonusEnabled: false,
    lengthBonusThreshold: 200,
    lengthBonusMaxMultiplier: 2.0,
    curveBaseXp: DEFAULT_LEVEL_CURVE.baseXp,
    curveLinearXp: DEFAULT_LEVEL_CURVE.linearXp,
    curveExponent: DEFAULT_LEVEL_CURVE.exponent,
    maxLevel: DEFAULT_LEVEL_CURVE.maxLevel,
    voiceRequireUnmuted: true,
    voiceRequireUndeafened: true,
    voiceIgnoreAfkChannel: true,
    voiceMinMembers: 1,
    dailyXpCap: 0
  })));

  // Clan states for boost configuration
  let clansEnabled = $state(false);
  let clanRewardXpBoost = $state(false);
  let clanRewardXpBoostRate = $state(1.2);
  let lastWinningClanId = $state<string | null>(null);
  let clans = $state<any[]>([]);

  // Saved versions for dirty checking
  let savedClanRewardXpBoost = $state(false);
  let savedClanRewardXpBoostRate = $state(1.2);

  /**
   * `levelUpChannelId` porte trois choix distincts : vide pour le salon
   * d'origine, `DM` pour le message prive, un identifiant pour un salon. Le
   * quatrieme etat n'en est pas un : l'identifiant enregistre ne designe plus
   * aucun salon, le module annonce alors dans le vide.
   */
  const levelUpChannelState = $derived.by(() => {
    const id = config.levelUpChannelId;
    if (!id) return 'origin';
    if (id === 'DM') return 'dm';
    // Liste vide = pas encore chargee, ce qui n'est pas un salon disparu.
    if (availableChannels.length > 0 && !availableChannels.some((c: any) => c.id === id)) return 'missing';
    return 'channel';
  });

  /**
   * Creer un salon n'a de sens que quand aucun ne tient le role. Le message
   * prive en est exclu : c'est un choix delibere, pas un reglage a completer.
   */
  const canCreateLevelUpChannel = $derived(
    levelUpChannelState === 'origin' || levelUpChannelState === 'missing'
  );

  const levelUpChannelLabel = $derived.by(() => {
    const channel = availableChannels.find((c: any) => c.id === config.levelUpChannelId);
    return channel ? channelDisplayName(channel) : (config.levelUpChannelId ?? '');
  });

  const configDirty = $derived(
    JSON.stringify(config) !== JSON.stringify(savedConfig)
      || clanRewardXpBoost !== savedClanRewardXpBoost
      || clanRewardXpBoostRate !== savedClanRewardXpBoostRate
  );

  $effect(() => {
    const dirty = configDirty;

    if (dirty && canManageSettings) {
      untrack(() => {
        unsavedChanges.register({
          id: 'leveling',
          label: 'Leveling & XP',
          onSave: () => handleSaveConfig(),
          onReset: () => {
            config = JSON.parse(JSON.stringify(savedConfig));
            clanRewardXpBoost = savedClanRewardXpBoost;
            clanRewardXpBoostRate = savedClanRewardXpBoostRate;
          }
        });
      });
    } else if (!dirty) {
      untrack(() => {
        unsavedChanges.release('leveling');
      });
    }
  });

  onDestroy(() => {
    unsavedChanges.release('leveling');
  });

  let rewards = $state<Array<{ id: string; level: number; roleId: string }>>([]);
  // Le classement arrive page par page : une guilde de cinquante mille membres
  // n'a aucune raison de traverser le reseau pour en afficher vingt-cinq.
  type LeaderboardRow = {
    userId: string; xp: number; level: number; lastXpGain: string; rank: number;
    username?: string | null; displayName?: string | null; avatarUrl?: string | null;
  };
  let leaderboardRows = $state<LeaderboardRow[]>([]);
  let leaderboardPage = $state(1);
  let leaderboardPageCount = $state(1);
  let leaderboardTotal = $state(0);
  let leaderboardLoading = $state(false);
  let searchLimited = $state(false);
  let leaderboardStats = $state<{ memberCount: number; totalXp: number; avgLevel: number; maxLevel: number } | null>(null);

  // Form states for adding reward
  let newRewardLevel = $state<number | null>(null);
  let newRewardRoleId = $state('');

  // New features UI states
  let newMultRoleId = $state('');
  let newMultValue = $state<number | null>(1.5);
  let searchQuery = $state('');
  let pendingIgnoreChannelId = $state<string | null>(null);
  let pendingIgnoreRoleId = $state<string | null>(null);

  $effect(() => {
    const channelId = pendingIgnoreChannelId;
    if (!channelId || config.ignoredChannels.includes(channelId)) return;
    config.ignoredChannels = [...config.ignoredChannels, channelId];
    pendingIgnoreChannelId = null;
  });

  $effect(() => {
    const roleId = pendingIgnoreRoleId;
    if (!roleId || config.ignoredRoles.includes(roleId)) return;
    config.ignoredRoles = [...config.ignoredRoles, roleId];
    pendingIgnoreRoleId = null;
  });

  onMount(async () => {
    loading = true;
    try {
      await dashboardStore.refresh();
      const res = await fetchLevelingData();
      if (res) {
        config = {
          enabled: res.config.enabled ?? false,
          xpMin: res.config.xpMin ?? 15,
          xpMax: res.config.xpMax ?? 25,
          cooldownSeconds: res.config.cooldownSeconds ?? 60,
          vocalXpPerMin: res.config.vocalXpPerMin ?? 5,
          levelUpChannelId: res.config.levelUpChannelId ?? null,
          levelUpMessage: res.config.levelUpMessage ?? '',
          stackRewards: res.config.stackRewards ?? false,
          ignoredChannels: res.config.ignoredChannels ?? [],
          ignoredRoles: res.config.ignoredRoles ?? [],
          xpMultipliers: res.config.xpMultipliers ?? {},
          lengthBonusEnabled: res.config.lengthBonusEnabled ?? false,
          lengthBonusThreshold: res.config.lengthBonusThreshold ?? 200,
          lengthBonusMaxMultiplier: res.config.lengthBonusMaxMultiplier ?? 2.0,
          curveBaseXp: res.config.curveBaseXp ?? DEFAULT_LEVEL_CURVE.baseXp,
          curveLinearXp: res.config.curveLinearXp ?? DEFAULT_LEVEL_CURVE.linearXp,
          curveExponent: res.config.curveExponent ?? DEFAULT_LEVEL_CURVE.exponent,
          maxLevel: res.config.maxLevel ?? DEFAULT_LEVEL_CURVE.maxLevel,
          voiceRequireUnmuted: res.config.voiceRequireUnmuted ?? true,
          voiceRequireUndeafened: res.config.voiceRequireUndeafened ?? true,
          voiceIgnoreAfkChannel: res.config.voiceIgnoreAfkChannel ?? true,
          voiceMinMembers: res.config.voiceMinMembers ?? 1,
          dailyXpCap: res.config.dailyXpCap ?? 0
        };
        savedConfig = JSON.parse(JSON.stringify(config));
        levelingLoaded = true;
        curveMode.resolve(curveFitsSimpleMode());
        // La carte des parametres XP n'ouvre en simple que si tout ce qu'elle
        // contient est representable par ses crans.
        xpMode.resolve(gainsFitSimpleMode() && lengthBonusFitsSimpleMode());
        rewards = res.rewards || [];
        leaderboardStats = res.stats ?? null;
        // Un rangement de roles peut avoir ete prepare par un enregistrement
        // precedent, ou etre en cours : la page le reprend a son ouverture.
        const pendingRoles = await fetchLevelingRoleResync().catch(() => null);
        if (pendingRoles) {
          roleResync = pendingRoles;
          if (roleResync.running) watchRoleResync();
        }
      }

      // Récupérer les paramètres de clan pour le boost d'XP de saison
      const clansRes = await fetchClansData().catch(() => null);
      if (clansRes) {
        clansEnabled = clansRes.clansEnabled;
        clanRewardXpBoost = clansRes.clanRewardXpBoost;
        clanRewardXpBoostRate = clansRes.clanRewardXpBoostRate;
        lastWinningClanId = clansRes.lastWinningClanId;
        clans = clansRes.clans;

        savedClanRewardXpBoost = clansRes.clanRewardXpBoost;
        savedClanRewardXpBoostRate = clansRes.clanRewardXpBoostRate;
      }
    } catch (err) {
      console.error(err);
    } finally {
      loading = false;
    }
  });

  async function handleCreateLevelUpChannel() {
    if (!canManageSettings) return;
    await createChannelAction.run(async () => {
      const res = await createLevelUpChannel();
      if (!res?.channelId) throw new Error(m.lv_err_create_channel());

      // La liste des salons d'abord : le champ pointerait sinon sur un salon
      // qu'elle ne connait pas encore, et la page afficherait son identifiant
      // brut le temps du rafraichissement.
      await dashboardStore.refresh();

      // Le salon est deja enregistre cote serveur : `savedConfig` suit, sinon
      // la page se croirait modifiee par un changement deja en base. Le message
      // par defaut est depose au meme moment, la reponse le porte.
      config.levelUpChannelId = res.channelId;
      savedConfig.levelUpChannelId = res.channelId;

      // `savedConfig` prend ce que la base contient maintenant. Le champ, lui,
      // n'est rempli que s'il etait vide : un texte en cours de saisie, pas
      // encore enregistre, ne doit pas disparaitre sous le clic.
      savedConfig.levelUpMessage = res.levelUpMessage ?? savedConfig.levelUpMessage;
      if (!config.levelUpMessage?.trim()) {
        config.levelUpMessage = savedConfig.levelUpMessage;
      }
      return true;
    }, { successMessage: m.lv_channel_created() });
  }

  async function handleSaveConfig(): Promise<boolean> {
    if (!canManageSettings) return false;
    let success = false;
    let resynced: number | null = 0;
    // Lu avant l'enregistrement : `savedConfig` aura bouge ensuite.
    const curveWasDirty = curveDirty;
    await saveAction.run(async () => {
      // 1. Enregistrer la configuration du leveling
      // `enabled` reste hors de l'envoi : la bascule du module (menu de
      // ModulePage) l'ecrit avec la ligne du module. La route des reglages ne
      // tient que la colonne, et la renvoyer telle que chargee au montage
      // laissait la page dire « actif » quand le bot ne donnait plus d'XP.
      const { enabled: _moduleState, ...editable } = config;
      const res = await updateLevelingConfig(editable);
      if (!res) throw new Error(m.lv_err_save());
      config = res.config;
      savedConfig = JSON.parse(JSON.stringify(res.config));
      resynced = res.resynced === undefined ? 0 : res.resynced;
      // Le serveur vient de realigner la colonne `level` : les compteurs et la
      // page de classement affiches parlent encore de l'ancienne courbe.
      if (curveWasDirty && resynced !== null) {
        const refreshed = await fetchLevelingData().catch(() => null);
        if (refreshed) leaderboardStats = refreshed.stats ?? null;
        if (res.roleResync) roleResync = res.roleResync;
        await loadLeaderboard();
      }

      // 2. Enregistrer la configuration du boost d'XP de clan si modifiée
      if (clanRewardXpBoost !== savedClanRewardXpBoost || clanRewardXpBoostRate !== savedClanRewardXpBoostRate) {
        const clanRes = await updateClanSettings({
          clanRewardXpBoost,
          clanRewardXpBoostRate,
        });
        if (!clanRes) throw new Error(m.lv_err_save_clan());
        clanRewardXpBoost = clanRes.clanRewardXpBoost;
        clanRewardXpBoostRate = clanRes.clanRewardXpBoostRate;
        savedClanRewardXpBoost = clanRes.clanRewardXpBoost;
        savedClanRewardXpBoostRate = clanRes.clanRewardXpBoostRate;
      }

      success = true;
      return true;
    }, { successMessage: m.lv_toast_saved() });

    // Le compte rendu du serveur remplace le message generique : il confirme
    // l'estimation affichee avant l'enregistrement, ou signale que le
    // realignement a echoue alors que la courbe, elle, est bien enregistree.
    const outcome: number | null = resynced;
    if (success && outcome === null) {
      saveAction.setError(m.lv_toast_resync_failed());
    } else if (success && outcome !== null && outcome > 0) {
      saveAction.setMessage(
        outcome === 1 ? m.lv_toast_resynced_one() : m.lv_toast_resynced({ count: outcome.toLocaleString() })
      );
    }

    return success;
  }

  async function handleAddReward() {
    if (!canManageSettings || !newRewardLevel || !newRewardRoleId) return;
    await rewardAction.run(async () => {
      const res = await addLevelingReward(newRewardLevel!, newRewardRoleId);
      if (!res) throw new Error(m.lv_err_add());
      rewards = [...rewards, res.reward].sort((a, b) => a.level - b.level);
      newRewardLevel = null;
      newRewardRoleId = '';
      return true;
    }, { successMessage: m.lv_toast_reward_added() });
  }

  async function handleDeleteReward(id: string) {
    if (!canManageSettings) return;
    const ok = await deleteLevelingReward(id);
    if (ok) {
      rewards = rewards.filter(r => r.id !== id);
    }
  }


  function getRoleName(roleId: string) {
    const role = availableRoles.find(r => r.id === roleId);
    return role ? `@${role.name}` : m.lv_unknown_role({ id: roleId });
  }

  function handleAddMultiplier() {
    if (!newMultRoleId || !newMultValue) return;
    config.xpMultipliers = {
      ...config.xpMultipliers,
      [newMultRoleId]: newMultValue
    };
    newMultRoleId = '';
    newMultValue = 1.5;
  }

  function handleRemoveMultiplier(roleId: string) {
    const updated = { ...config.xpMultipliers };
    delete updated[roleId];
    config.xpMultipliers = updated;
  }

  // Normalisée pour l'affichage : un champ vidé ou une valeur hors bornes ne
  // doit pas produire un aperçu incohérent, et le serveur applique de toute
  // façon les mêmes bornes à l'enregistrement.
  const levelCurve = $derived(normalizeLevelCurve({
    baseXp: config.curveBaseXp,
    linearXp: config.curveLinearXp,
    exponent: config.curveExponent,
    maxLevel: config.maxLevel
  }));

  // Même calcul que le bot, courbe de la guilde comprise : les deux importent
  // la logique de `@kotbo/shared`.
  const getXpForLevel = (level: number) => xpForLevel(level, levelCurve);

  const curvePreview = $derived(levelCurvePreview(levelCurve, 30));

  // Changer la courbe redistribue les niveaux de tout le serveur, et
  // l'avertissement generique ne disait pas dans quelle mesure.
  const curveDirty = $derived(
    config.curveBaseXp !== savedConfig.curveBaseXp
      || config.curveLinearXp !== savedConfig.curveLinearXp
      || config.curveExponent !== savedConfig.curveExponent
      || config.maxLevel !== savedConfig.maxLevel
  );

  // La courbe enregistree, tracee derriere celle qu'on edite : sans elle, le
  // graphique montre un etat sans jamais montrer ce qu'il remplace.
  const savedLevelCurve = $derived(normalizeLevelCurve({
    baseXp: savedConfig.curveBaseXp,
    linearXp: savedConfig.curveLinearXp,
    exponent: savedConfig.curveExponent,
    maxLevel: savedConfig.maxLevel
  }));
  // Tronquee aux colonnes affichees : un plafond enregistre plus haut que
  // celui qu'on edite tirerait l'echelle vers une colonne qu'on ne voit pas.
  const savedCurvePreview = $derived(
    curveDirty ? levelCurvePreview(savedLevelCurve, 30).slice(0, curvePreview.length) : []
  );

  // Une seule echelle pour les deux series : comparer deux courbes chacune
  // ramenee a son propre maximum ne comparerait rien du tout.
  const curvePreviewMax = $derived(Math.max(
    ...curvePreview.map(p => p.deltaXp),
    ...savedCurvePreview.map(p => p.deltaXp),
    1,
  ));

  // Reperes de l'axe : le premier niveau, le dernier, et un sur cinq entre les
  // deux. Numeroter chaque colonne les rendrait illisibles. Deduits du nombre
  // de colonnes reellement rendues, pour que les deux graphiques restent
  // d'accord meme si l'un d'eux est momentanement en retard sur l'autre.
  function axisTicks(columns: number): Set<number> {
    const step = columns <= 10 ? 2 : 5;
    const ticks = new Set<number>([1, columns]);
    for (let level = step; level < columns; level += step) ticks.add(level);
    return ticks;
  }
  // Les paliers au-delà du plafond afficheraient tous la même XP : ils sont
  // remplacés par le plafond lui-même, qui est l'information utile.
  const curveMilestoneLevels = $derived(
    levelCurve.maxLevel > 0
      ? [...new Set([5, 10, 25, 50].filter(level => level < levelCurve.maxLevel).concat(levelCurve.maxLevel))]
      : [5, 10, 25, 50]
  );
  // `xpForLevel(n)` est le seuil auquel on QUITTE le niveau n : pour afficher
  // l'XP a laquelle on l'atteint, il faut le palier precedent. Sans ce decalage,
  // la tuile « niveau 5 » montrait l'XP d'un membre deja niveau 6.
  const curveMilestones = $derived(curveMilestoneLevels.map(level => ({ level, totalXp: xpForLevel(level - 1, levelCurve) })));

  // Mode simple : deux curseurs a cinq crans plutot que trois coefficients. Les
  // paliers sont volontairement grossiers, le cran du milieu reproduisant
  // exactement la courbe par defaut. On y perd en finesse, on y gagne un reglage
  // comprehensible sans connaitre la formule. Les crans eux-memes vivent dans
  // `levelingPresets`, qui compose les prereglages de la page d'accueil a partir
  // d'eux.
  const CURVE_PACE_LABELS = [
    m.lv_curve_pace_1, m.lv_curve_pace_2, m.lv_curve_pace_3, m.lv_curve_pace_4, m.lv_curve_pace_5,
  ];
  const CURVE_STEEP_LABELS = [
    m.lv_curve_steep_1, m.lv_curve_steep_2, m.lv_curve_steep_3, m.lv_curve_steep_4, m.lv_curve_steep_5,
  ];

  /** La courbe courante tombe-t-elle exactement sur un cran des curseurs ? */
  function curveFitsSimpleMode(): boolean {
    const pace = CURVE_PACE_FACTORS[nearestStep(CURVE_PACE_FACTORS, (config.curveBaseXp || 0) / DEFAULT_LEVEL_CURVE.baseXp) - 1];
    const steep = CURVE_EXPONENT_STEPS[nearestStep(CURVE_EXPONENT_STEPS, config.curveExponent) - 1];
    return Math.round(DEFAULT_LEVEL_CURVE.baseXp * pace) === config.curveBaseXp
      && Math.round(DEFAULT_LEVEL_CURVE.linearXp * pace) === config.curveLinearXp
      && steep === config.curveExponent;
  }

  // Reglage simple des gains : les quatre nombres qui decident de la vitesse
  // d'accumulation bougent ensemble. Le cran median reprend exactement les
  // valeurs par defaut, comme pour la courbe.
  const GAIN_LABELS = [
    m.lv_gains_level_1, m.lv_gains_level_2, m.lv_gains_level_3, m.lv_gains_level_4, m.lv_gains_level_5,
  ];

  const xpMode = createSimpleModePreference('kotbo_leveling_xp_mode');

  /** Le reglage courant tombe-t-il exactement sur un cran ? */
  function gainsFitSimpleMode(): boolean {
    return GAIN_STEPS.some((preset) =>
      preset.xpMin === config.xpMin
      && preset.xpMax === config.xpMax
      && preset.cooldownSeconds === config.cooldownSeconds
      && preset.vocalXpPerMin === config.vocalXpPerMin);
  }

  // Cran le plus proche, mesure sur l'XP moyenne par message.
  const gainsStep = $derived(nearestStep(
    GAIN_STEPS.map((preset) => (preset.xpMin + preset.xpMax) / 2),
    ((config.xpMin || 0) + (config.xpMax || 0)) / 2,
  ));
  const gainsOffGrid = $derived(xpMode.simple && !gainsFitSimpleMode());

  // Bonus de longueur : le seuil et le multiplicateur maximum vont de pair,
  // l'un sans l'autre ne veut rien dire. Un cran les pose ensemble, du bonus a
  // peine perceptible a celui qui double largement un message fourni.
  const LENGTH_BONUS_PRESETS = [
    { threshold: 300, max: 1.3 },
    { threshold: 250, max: 1.5 },
    { threshold: 200, max: 2 },
    { threshold: 150, max: 2.5 },
    { threshold: 100, max: 3 },
  ];

  const LENGTH_BONUS_LABELS = [
    m.lv_length_bonus_step_1, m.lv_length_bonus_step_2, m.lv_length_bonus_step_3,
    m.lv_length_bonus_step_4, m.lv_length_bonus_step_5,
  ];

  function lengthBonusFitsSimpleMode(): boolean {
    // Desactive, ses valeurs ne s'affichent pas : elles n'ont pas a coller.
    if (!config.lengthBonusEnabled) return true;
    return LENGTH_BONUS_PRESETS.some((preset) =>
      preset.threshold === config.lengthBonusThreshold && preset.max === config.lengthBonusMaxMultiplier);
  }

  const lengthBonusStep = $derived(nearestStep(
    LENGTH_BONUS_PRESETS.map((preset) => preset.max),
    config.lengthBonusMaxMultiplier || LENGTH_BONUS_PRESETS[2].max,
  ));
  const lengthBonusOffGrid = $derived(xpMode.simple && !lengthBonusFitsSimpleMode());

  function applyLengthBonusStep(step: number) {
    const preset = LENGTH_BONUS_PRESETS[Math.min(LENGTH_BONUS_PRESETS.length, Math.max(1, step)) - 1];
    config.lengthBonusThreshold = preset.threshold;
    config.lengthBonusMaxMultiplier = preset.max;
  }

  // Le curseur de la courbe a son graphique en dessous ; celui des gains n'avait
  // rien. Ces quatre tuiles montrent les valeurs reellement posees, plus le
  // rythme qui en decoule, seule facon de comparer deux crans entre eux.
  const gainsHourlyXp = $derived(Math.round(
    ((config.xpMin || 0) + (config.xpMax || 0)) / 2 * (3600 / Math.max(1, config.cooldownSeconds || 1)),
  ));

  function applyGainsStep(step: number) {
    const preset = GAIN_STEPS[Math.min(GAIN_STEPS.length, Math.max(1, step)) - 1];
    config.xpMin = preset.xpMin;
    config.xpMax = preset.xpMax;
    config.cooldownSeconds = preset.cooldownSeconds;
    config.vocalXpPerMin = preset.vocalXpPerMin;
  }

  const curveMode = createSimpleModePreference('kotbo_leveling_curve_mode');

  // Les curseurs sont deduits de la configuration et non l'inverse : elle reste
  // la seule source, et basculer de mode ne deplace donc jamais la courbe.
  const curvePaceStep = $derived(nearestStep(CURVE_PACE_FACTORS, (config.curveBaseXp || DEFAULT_LEVEL_CURVE.baseXp) / DEFAULT_LEVEL_CURVE.baseXp));
  const curveSteepStep = $derived(nearestStep(CURVE_EXPONENT_STEPS, config.curveExponent || DEFAULT_LEVEL_CURVE.exponent));

  // Le chargement ouvre en mode detaille quand la courbe ne tombe sur aucun
  // cran, mais rien n'empeche d'y basculer a la main : les curseurs affichent
  // alors le cran le plus proche, qui n'est pas la valeur enregistree. On le dit
  // plutot que de laisser croire le contraire ou de modifier la courbe d'office.
  const curveOffGrid = $derived(curveMode.simple && !curveFitsSimpleMode());

  function applyCurvePace(step: number) {
    const pace = curvePaceValues(step);
    config.curveBaseXp = pace.baseXp;
    config.curveLinearXp = pace.linearXp;
  }

  function applyCurveSteepness(step: number) {
    config.curveExponent = CURVE_EXPONENT_STEPS[Math.min(CURVE_EXPONENT_STEPS.length, Math.max(1, step)) - 1];
  }

  // Prereglages de la page d'accueil : ils ne touchent qu'aux gains et a la
  // courbe. Le salon d'annonce et les roles de recompense restent a regler dans
  // les onglets, un prereglage n'ayant aucun moyen de deviner lesquels.
  const selectedPreset = $derived(findLevelingPreset(config));
  const activePreset = $derived(findLevelingPreset(savedConfig));

  function applyLevelingPreset(preset: LevelingPreset) {
    if (!canManageSettings) return;
    Object.assign(config, levelingPresetValues(preset));
    // Le prereglage pose des valeurs qui tombent toutes sur les crans : les
    // cartes detaillees peuvent s'ouvrir en mode simple.
    xpMode.resolve(gainsFitSimpleMode() && lengthBonusFitsSimpleMode());
    curveMode.resolve(curveFitsSimpleMode());
  }

  // La carte « Personnalise » n'a rien a appliquer : elle affiche deja la
  // configuration courante, elle ouvre juste les onglets.
  function openPresetDetail() {
    gotoTab('/leveling', 'gains', DEFAULT_TAB);
  }

  function levelingValuesOf(source: typeof config): LevelingPresetValues {
    return {
      xpMin: source.xpMin,
      xpMax: source.xpMax,
      cooldownSeconds: source.cooldownSeconds,
      vocalXpPerMin: source.vocalXpPerMin,
      curveBaseXp: source.curveBaseXp,
      curveLinearXp: source.curveLinearXp,
      curveExponent: source.curveExponent,
      maxLevel: source.maxLevel,
    };
  }

  // Des qu'un prereglage est choisi, la configuration courante est la sienne :
  // la carte « Personnalise » doit alors montrer la configuration enregistree,
  // sans quoi elle devient le sosie de la carte qu'on vient de cliquer.
  const customPresetValues = $derived(levelingValuesOf(selectedPreset ? savedConfig : config));

  // Estimation de duree : les curseurs repondent chacun a un fragment, aucun ne
  // dit combien de temps il faut pour atteindre un niveau. Le calcul combine le
  // rythme des gains, le bonus de longueur et le plafond quotidien, sur une
  // hypothese d'activite que l'utilisateur choisit lui-meme.
  const ACTIVITY_PRESETS = [10, 30, 100];
  const ACTIVITY_LABELS = [m.lv_estimate_activity_low, m.lv_estimate_activity_mid, m.lv_estimate_activity_high];
  /** Longueur retenue pour un message courant, quand le bonus de longueur est actif. */
  const TYPICAL_MESSAGE_LENGTH = 100;

  let activityStep = $state(2);

  const estimatedXpPerDay = $derived.by(() => {
    const bonus = config.lengthBonusEnabled && config.lengthBonusThreshold > 0 && config.lengthBonusMaxMultiplier > 1
      ? 1 + Math.min(1, TYPICAL_MESSAGE_LENGTH / config.lengthBonusThreshold) * (config.lengthBonusMaxMultiplier - 1)
      : 1;
    const perMessage = ((config.xpMin || 0) + (config.xpMax || 0)) / 2 * bonus;
    // Le delai borne le nombre de messages qui rapportent dans une journee.
    const counted = Math.min(ACTIVITY_PRESETS[activityStep - 1], Math.floor(86400 / Math.max(1, config.cooldownSeconds || 1)));
    const perDay = perMessage * counted;
    return config.dailyXpCap > 0 ? Math.min(perDay, config.dailyXpCap) : perDay;
  });

  function estimateDays(level: number): number {
    if (estimatedXpPerDay <= 0) return Infinity;
    return xpForLevel(level - 1, levelCurve) / estimatedXpPerDay;
  }

  function formatDuration(days: number): string {
    if (!Number.isFinite(days)) return '-';
    if (days < 1) return m.lv_estimate_under_a_day();
    if (days < 60) return m.lv_estimate_days({ days: Math.round(days) });
    if (days < 730) return m.lv_estimate_months({ months: Math.round(days / 30) });
    return m.lv_estimate_years({ years: (days / 365).toFixed(1) });
  }

  type CurveStats = {
    total: number;
    changed: number;
    lowered: number;
    /** Nombre de membres par niveau, index 0 pour le niveau 1. */
    distribution: number[];
    beyond: number;
    rewardMoves: Array<{ roleId: string; gained: number; lost: number }>;
  };

  // Effet de la courbe en cours d'edition : combien de membres changent de
  // niveau, combien en perdent, ou ils se repartissent, et quels roles de
  // recompense changent de main. La courbe se reglait jusqu'ici sans rien
  // savoir de tout ca - durcir les niveaux 40 ne change rien si tout le monde
  // plafonne au niveau 12.
  //
  // Tout est compte par le bot, tranche d'XP par tranche d'XP, sans qu'une
  // ligne de membre quitte la base. Debounce, sinon un curseur tire une requete
  // par cran. Les colonnes suivent l'apercu de la courbe juste au-dessus, pour
  // que les deux graphiques se lisent ensemble.
  let curveStatsRaw = $state<CurveStats | null>(null);

  $effect(() => {
    if (loading) return;
    const curve = { ...levelCurve };
    let cancelled = false;
    const timer = setTimeout(async () => {
      const stats = await fetchLevelingCurveImpact(curve).catch(() => null);
      // Un bot plus ancien repond 404 sur cette route : on garde null plutot
      // que d'aller lire une repartition absente.
      if (!cancelled) curveStatsRaw = Array.isArray(stats?.distribution) ? stats : null;
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  });

  // Une guilde sans membre n'a rien a montrer : ni histogramme vide, ni
  // « aucun membre ne changera de niveau », qui se lirait comme un resultat.
  const curveStats = $derived(curveStatsRaw && curveStatsRaw.total > 0 ? curveStatsRaw : null);
  const curveStatsMax = $derived(Math.max(...(curveStats?.distribution ?? []), 1));

  // Une recompense posee au-dessus du plafond ne sera jamais attribuee, et rien
  // ne le disait au moment de la creer.
  const unreachableRewardIds = $derived(new Set(
    levelCurve.maxLevel > 0
      ? rewards.filter(reward => reward.level > levelCurve.maxLevel).map(reward => reward.id)
      : []
  ));

  // Mouvements de roles : comptes par le bot en meme temps que le reste, la
  // page n'ayant plus la liste des membres pour les deduire elle-meme.
  const rewardImpact = $derived(curveDirty ? (curveStats?.rewardMoves ?? []) : []);

  // Rangement des roles apres un changement de courbe : prepare par le bot,
  // jamais lance tout seul. Sur un gros serveur, reaccorder les recompenses fait
  // bouger des milliers de roles d'un coup - c'est une decision, pas un effet de
  // bord d'un curseur enregistre.
  let roleResync = $state<{ pending: number; done: number; running: boolean }>({ pending: 0, done: 0, running: false });
  let roleResyncTimer: ReturnType<typeof setInterval> | null = null;

  function watchRoleResync() {
    if (roleResyncTimer) return;
    roleResyncTimer = setInterval(async () => {
      const status = await fetchLevelingRoleResync().catch(() => null);
      if (status) roleResync = status;
      if (!roleResync.running && roleResyncTimer) {
        clearInterval(roleResyncTimer);
        roleResyncTimer = null;
      }
    }, 3000);
  }

  async function startRoleResync() {
    const status = await runLevelingRoleResync().catch(() => null);
    if (status) roleResync = status;
    watchRoleResync();
  }

  async function stopRoleResync() {
    const status = await runLevelingRoleResync({ stop: true }).catch(() => null);
    if (status) roleResync = status;
  }

  onDestroy(() => {
    if (roleResyncTimer) clearInterval(roleResyncTimer);
  });

  const curveImpactLabel = $derived.by(() => {
    const { changed, lowered, total: members } = curveStats ?? { changed: 0, lowered: 0, total: 0 };
    if (changed === 0) return m.lv_curve_impact_none();
    const total = members.toLocaleString();
    if (changed === 1) {
      return lowered === 1 ? m.lv_curve_impact_one_lowered({ total }) : m.lv_curve_impact_one({ total });
    }
    const count = changed.toLocaleString();
    return lowered > 0
      ? m.lv_curve_impact_many_lowered({ changed: count, total, lowered: lowered.toLocaleString() })
      : m.lv_curve_impact_many({ changed: count, total });
  });

  function resetCurve() {
    config.curveBaseXp = DEFAULT_LEVEL_CURVE.baseXp;
    config.curveLinearXp = DEFAULT_LEVEL_CURVE.linearXp;
    config.curveExponent = DEFAULT_LEVEL_CURVE.exponent;
    config.maxLevel = DEFAULT_LEVEL_CURVE.maxLevel;
  }

  async function copyPublicUrl() {
    if (!publicLeaderboardUrl) return;
    await navigator.clipboard.writeText(publicLeaderboardUrl);
    copySuccess = true;
    setTimeout(() => { copySuccess = false; }, 2000);
  }

  // Le podium n'a de sens que sur la premiere page non filtree : ailleurs, les
  // trois premieres lignes ne sont pas les trois premiers du serveur.
  const podium = $derived(!searchQuery.trim() && leaderboardPage === 1 ? leaderboardRows.slice(0, 3) : []);

  async function loadLeaderboard(page = leaderboardPage) {
    leaderboardLoading = true;
    try {
      const res = await fetchLevelingLeaderboard({ page, search: searchQuery.trim() }).catch(() => null);
      if (!res || !Array.isArray(res.rows)) return;
      leaderboardRows = res.rows;
      leaderboardPage = res.page ?? 1;
      leaderboardPageCount = res.pageCount ?? 1;
      leaderboardTotal = res.total ?? 0;
      searchLimited = res.searchLimited === true;
    } finally {
      leaderboardLoading = false;
    }
  }

  // La recherche interroge la base, donc on attend une pause de frappe, et on
  // revient a la premiere page : rester page 4 d'un resultat qui n'en a qu'une
  // n'aurait rien affiche.
  $effect(() => {
    const search = searchQuery;
    if (loading) return;
    const timer = setTimeout(() => {
      untrack(() => loadLeaderboard(1));
    }, search ? 300 : 0);
    return () => clearTimeout(timer);
  });

  // Stats du classement : la base les tient deja (`_count`, `_sum`, `_avg`,
  // `_max` sur des colonnes indexees), donc elles arrivent avec la reponse
  // plutot que d'etre reconstituees membre par membre ici - ce que la page ne
  // pourrait plus faire de toute facon, puisqu'elle n'a plus qu'une page de
  // classement a la fois.
  const memberCount = $derived(leaderboardStats?.memberCount ?? 0);
  const totalXp = $derived(leaderboardStats?.totalXp ?? 0);
  const avgLevel = $derived(leaderboardStats?.avgLevel ?? 0);
  const maxLevel = $derived(leaderboardStats?.maxLevel ?? 0);

  // Import states
  let importRawJson = $state('');
  let importFileError = $state<string | null>(null);
  const importActionState = createAsyncActionState();
  let importResults = $state<{
    dryRun?: boolean;
    importedCount: number;
    failedCount: number;
    failedMembers: Array<{ username?: string; display_name?: string; reason: string }>;
    createdCount?: number;
    levelChangeCount?: number;
    xpLoweredCount?: number;
  } | null>(null);

  let isDragging = $state(false);

  async function handleImportSubmit(dryRun = false) {
    importFileError = null;
    importResults = null;
    if (!importRawJson.trim()) {
      importFileError = m.lv_import_err_empty();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(importRawJson);
    } catch (err) {
      importFileError = m.lv_import_err_json({ message: (err as Error).message });
      return;
    }

    if (!Array.isArray(parsed)) {
      importFileError = m.lv_import_err_not_array();
      return;
    }

    await importActionState.run(async () => {
      const res = await importLevelingData(parsed, { dryRun });
      if (!res) throw new Error(m.lv_import_err_failed());
      importResults = res;
      // Rien n'a ete ecrit en mode analyse : le classement affiche est encore
      // le bon, le recharger ne ferait que le faire clignoter.
      if (!dryRun) {
        const updatedData = await fetchLevelingData();
        if (updatedData) leaderboardStats = updatedData.stats ?? null;
        await loadLeaderboard(1);
      }
      return true;
    }, { successMessage: dryRun ? m.lv_import_toast_dry_run() : m.lv_import_toast_ok() });
  }

  function handleFileDrop(e: DragEvent) {
    e.preventDefault();
    isDragging = false;
    importFileError = null;
    importResults = null;

    const file = e.dataTransfer?.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.json')) {
      importFileError = m.lv_import_err_filetype();
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result;
      if (typeof text === 'string') {
        importRawJson = text;
      }
    };
    reader.onerror = () => {
      importFileError = m.lv_import_err_read();
    };
    reader.readAsText(file);
  }

  function handleFileSelect(e: Event) {
    importFileError = null;
    importResults = null;
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.json')) {
      importFileError = m.lv_import_err_filetype();
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result;
      if (typeof text === 'string') {
        importRawJson = text;
      }
    };
    reader.onerror = () => {
      importFileError = m.lv_import_err_read();
    };
    reader.readAsText(file);
  }
</script>

<!-- Axe des deux graphiques de la courbe : memes colonnes, meme gouttiere, donc
     les reperes tombent sous les barres correspondantes des deux graphiques. -->
{#snippet levelAxis(columns: number)}
  {@const ticks = axisTicks(columns)}
  <!-- `border-transparent` : le graphique au-dessus a une bordure d'1px, sans
       quoi les reperes seraient decales d'un pixel par rapport aux colonnes. -->
  <div class="flex gap-[3px] px-2 border border-transparent" aria-hidden="true">
    {#each Array.from({ length: columns }) as _, index}
      <span class="flex-1 text-center text-2xs leading-none tabular-nums text-on-surface-variant/50">
        {ticks.has(index + 1) ? index + 1 : ''}
      </span>
    {/each}
  </div>
{/snippet}

<ModulePage
  title={m.nav_leveling()}
  description={m.lv_page_description()}
  icon="trophy"
  featureKey="leveling"
>
  {#snippet actions()}
    {#if !loading}
      <button
        type="button"
        onclick={() => gotoTab('/leveling', activeTab === 'accueil' ? 'gains' : 'accueil', DEFAULT_TAB)}
        data-tour="leveling-advanced"
        class="group flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-bold bg-primary text-on-primary shadow-md shadow-primary/20 hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/25 transition-all"
      >
        <Papicon icon={activeTab === 'accueil' ? 'Settings' : 'ArrowLeft'} size={15} />
        {activeTab === 'accueil' ? m.lv_presets_open_advanced() : m.lv_presets_back()}
        {#if activeTab === 'accueil'}
          <Papicon icon="ChevronRight" size={14} class="transition-transform group-hover:translate-x-0.5" />
        {/if}
      </button>
    {/if}
  {/snippet}

  <InlineFeedback state={saveAction} />
  <InlineFeedback state={rewardAction} />
  <InlineFeedback state={createChannelAction} />

  {#if levelingLoaded && levelingModuleActive && !config.enabled}
    <Callout variant="warning" title={m.lv_paused_title()}>
      {m.lv_paused_desc()}
      {#snippet actions()}
        {#if canManageSettings}
          <Button variant="primary" size="sm" icon="power" loading={saveAction.state.loading} onclick={resumeLeveling}>
            {m.lv_paused_action()}
          </Button>
        {/if}
      {/snippet}
    </Callout>
  {/if}

  <!-- L'accueil (les preselections) n'est pas un onglet : on y entre et on
       en sort par le bouton de l'en-tete. -->
  {#if activeTab !== 'accueil'}
    <Tabs
      label={m.lv_page_description()}
      tabs={pageTabItems('/leveling', (id) => id !== 'accueil' && (id !== 'import' || canManageSettings))
        .map((item) => item.id === 'leaderboard' && memberCount > 0 ? { ...item, badge: memberCount.toLocaleString() } : item)}
      active={activeTab}
      onchange={(id) => gotoTab('/leveling', id, DEFAULT_TAB)}
    />
  {/if}

  {#if loading}
    <div class="space-y-8">
      <Skeleton height="350px" radius="2.5rem" />
      <Skeleton height="250px" radius="2.5rem" />
    </div>
  {:else if activeTab === 'accueil'}
    <div class="space-y-8">
      <LevelingPresetPicker
        selectedId={selectedPreset?.id ?? null}
        activeId={activePreset?.id ?? null}
        customValues={customPresetValues}
        disabled={!canManageSettings}
        dirty={configDirty}
        saving={saveAction.state.loading}
        onselect={applyLevelingPreset}
        onsave={handleSaveConfig}
        ondetail={openPresetDetail}
      />

      <!-- Un rythme choisi ne dit pas encore ou les montees de niveau
           s'annoncent : la carte porte cette derniere etape la ou l'oeil
           arrive, au lieu de la laisser au fond de l'onglet Annonces. -->
      {#if canManageSettings}
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-surface-container-low/30 border border-outline-variant/10 rounded-xl px-6 py-5" data-tour="leveling-announce">
          <div class="flex items-start gap-3">
            <div class="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <Papicon icon="Bell" size={18} />
            </div>
            <div class="space-y-0.5">
              <p class="text-sm font-semibold text-on-surface">{m.lv_setup_channel_title()}</p>
              <p class="text-body-sm text-on-surface-variant/70">
                {#if levelUpChannelState === 'channel'}
                  {m.lv_setup_channel_done({ channel: levelUpChannelLabel })}
                  <!-- Le nom de l'onglet vient de sa propre traduction : le lien
                       et la barre d'onglets ne peuvent pas se contredire. -->
                  <button
                    type="button"
                    onclick={() => gotoTab('/leveling', 'annonces', DEFAULT_TAB)}
                    class="text-primary font-medium hover:underline"
                  >
                    {m.lv_setup_channel_change({ tab: m.lv_tab_announcements() })}
                  </button>
                {:else if levelUpChannelState === 'dm'}
                  {m.lv_setup_channel_dm()}
                {:else if levelUpChannelState === 'missing'}
                  {m.lv_setup_channel_missing()}
                {:else}
                  {m.lv_setup_channel_desc()}
                {/if}
              </p>
            </div>
          </div>
          {#if canCreateLevelUpChannel}
            <button
              type="button"
              onclick={handleCreateLevelUpChannel}
              disabled={createChannelAction.state.loading}
              class="shrink-0 px-6 py-3 bg-primary hover:bg-primary/90 text-on-primary text-body-sm font-medium rounded-lg shadow-md shadow-primary/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none flex items-center justify-center gap-2"
            >
              <Papicon icon="sparkles" size={16} />
              {createChannelAction.state.loading ? m.lv_creating_channel() : m.lv_create_channel()}
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {:else if activeTab === 'gains'}
    <!-- === ONGLET GAINS D'XP === -->
    <div class="space-y-8 animate-in fade-in duration-300">
      <!-- Paramètres XP -->
      <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
        <div class="flex items-start justify-between gap-4">
          <h3 class="text-xl font-semibold flex items-center gap-3">
            <Papicon icon="Settings" size={20} class="text-primary" />
            {m.lv_xp_params_title()}
          </h3>
          <SimpleModeToggle simple={xpMode.simple} onchange={(v) => xpMode.set(v)} />
        </div>

        <div class="leveling-xp-grid grid grid-cols-1 md:grid-cols-2 gap-6">
          {#if xpMode.simple}
            <div class="md:col-span-2 space-y-2">
              <div class="flex items-baseline justify-between gap-3">
                <label for="gainsLevel" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.lv_gains_level_label()}</label>
                <span class="text-xs font-semibold text-primary">{GAIN_LABELS[gainsStep - 1]()}</span>
              </div>
              <input
                id="gainsLevel"
                type="range"
                min="1"
                max="5"
                step="1"
                value={gainsStep}
                oninput={(e) => applyGainsStep(Number(e.currentTarget.value))}
                class="w-full accent-primary"
                disabled={!canManageSettings}
              />

              <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
                <div class="px-3 py-2.5 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
                  <p class="text-xs font-semibold text-on-surface-variant/60">{m.lv_gains_tile_message()}</p>
                  <p class="text-sm font-semibold text-on-surface">{config.xpMin} – {config.xpMax}</p>
                </div>
                <div class="px-3 py-2.5 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
                  <p class="text-xs font-semibold text-on-surface-variant/60">{m.lv_gains_tile_cooldown()}</p>
                  <p class="text-sm font-semibold text-on-surface">{config.cooldownSeconds} s</p>
                </div>
                <div class="px-3 py-2.5 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
                  <p class="text-xs font-semibold text-on-surface-variant/60">{m.lv_gains_tile_voice()}</p>
                  <p class="text-sm font-semibold text-on-surface">{config.vocalXpPerMin} / min</p>
                </div>
                <div class="px-3 py-2.5 bg-primary/5 border border-primary/15 rounded-lg">
                  <p class="text-xs font-semibold text-primary/70">{m.lv_gains_tile_hourly()}</p>
                  <p class="text-sm font-semibold text-primary">≈ {gainsHourlyXp.toLocaleString()} XP</p>
                </div>
              </div>

              {#if gainsOffGrid}
                <SimpleModeNotice message={m.lv_gains_off_grid()} />
              {/if}
            </div>
          {:else}
          <div class="space-y-1.5">
            <label for="xpMin" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.lv_xp_min()}</label>
            <input 
              id="xpMin"
              type="number" 
              bind:value={config.xpMin} 
              class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
              disabled={!canManageSettings}
            />
          </div>

          <div class="space-y-1.5">
            <label for="xpMax" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.lv_xp_max()}</label>
            <input 
              id="xpMax"
              type="number" 
              bind:value={config.xpMax} 
              class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
              disabled={!canManageSettings}
            />
          </div>

          <div class="space-y-1.5">
            <label for="cooldown" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.lv_cooldown()}</label>
            <input 
              id="cooldown"
              type="number" 
              bind:value={config.cooldownSeconds} 
              class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
              disabled={!canManageSettings}
            />
          </div>

          <div class="space-y-1.5">
            <label for="vocalXp" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.lv_vocal_xp()}</label>
            <input 
              id="vocalXp"
              type="number" 
              bind:value={config.vocalXpPerMin} 
              class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
              disabled={!canManageSettings}
            />
          </div>

          {/if}

          <!-- Conditions d'XP vocale -->
          <div class="col-span-2 mt-2 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg px-6 py-4 space-y-4">
            <div>
              <span class="text-xs font-bold text-on-surface">{m.lv_voice_conditions_title()}</span>
              <p class="text-2xs text-on-surface-variant/60 font-medium">{m.lv_voice_conditions_desc()}</p>
            </div>

            <div class="space-y-3 pt-3 border-t border-outline-variant/10">
              <div class="flex items-center justify-between gap-4">
                <div>
                  <span class="text-xs font-semibold text-on-surface">{m.lv_voice_require_unmuted()}</span>
                  <p class="text-2xs text-on-surface-variant/60 font-medium">{m.lv_voice_require_unmuted_desc()}</p>
                </div>
                <ToggleSwitch
                  checked={config.voiceRequireUnmuted}
                  onToggle={(v: boolean) => { config.voiceRequireUnmuted = v; }}
                  disabled={!canManageSettings}
                />
              </div>

              <div class="flex items-center justify-between gap-4">
                <div>
                  <span class="text-xs font-semibold text-on-surface">{m.lv_voice_require_undeafened()}</span>
                  <p class="text-2xs text-on-surface-variant/60 font-medium">{m.lv_voice_require_undeafened_desc()}</p>
                </div>
                <ToggleSwitch
                  checked={config.voiceRequireUndeafened}
                  onToggle={(v: boolean) => { config.voiceRequireUndeafened = v; }}
                  disabled={!canManageSettings}
                />
              </div>

              <div class="flex items-center justify-between gap-4">
                <div>
                  <span class="text-xs font-semibold text-on-surface">{m.lv_voice_ignore_afk()}</span>
                  <p class="text-2xs text-on-surface-variant/60 font-medium">{m.lv_voice_ignore_afk_desc()}</p>
                </div>
                <ToggleSwitch
                  checked={config.voiceIgnoreAfkChannel}
                  onToggle={(v: boolean) => { config.voiceIgnoreAfkChannel = v; }}
                  disabled={!canManageSettings}
                />
              </div>

              <div class="space-y-1.5 pt-1">
                <label for="voiceMinMembers" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.lv_voice_min_members()}</label>
                <input
                  id="voiceMinMembers"
                  type="number"
                  min="1"
                  max="25"
                  bind:value={config.voiceMinMembers}
                  class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
                  disabled={!canManageSettings}
                />
                <p class="text-2xs text-on-surface-variant/50 ml-2">{m.lv_voice_min_members_hint({ count: config.voiceMinMembers })}</p>
              </div>
            </div>
          </div>

          <!-- Plafond d'XP quotidien -->
          <div class="col-span-2 mt-2 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg px-6 py-4 space-y-4">
            <div>
              <span class="text-xs font-bold text-on-surface">{m.lv_daily_cap_title()}</span>
              <p class="text-2xs text-on-surface-variant/60 font-medium">{m.lv_daily_cap_desc()}</p>
            </div>

            <div class="space-y-1.5 pt-3 border-t border-outline-variant/10">
              <label for="dailyXpCap" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.lv_daily_cap_label()}</label>
              <input
                id="dailyXpCap"
                type="number"
                min="0"
                bind:value={config.dailyXpCap}
                class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
                disabled={!canManageSettings}
              />
              <p class="text-2xs text-on-surface-variant/50 ml-2">{m.lv_daily_cap_hint()}</p>
            </div>

            {#if config.dailyXpCap > 0}
              <div class="p-3 bg-primary/5 border border-primary/15 rounded-lg text-2xs text-primary/90 leading-relaxed">
                {m.lv_daily_cap_enabled_hint({ cap: config.dailyXpCap.toLocaleString() })}
              </div>
            {/if}
          </div>

          <!-- Bonus d'XP selon la longueur du message -->
          <div class="col-span-2 mt-2 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg px-6 py-4 space-y-4">
            <div class="flex items-center justify-between">
              <div>
                <span class="text-xs font-bold text-on-surface">{m.lv_length_bonus_title()}</span>
                <p class="text-2xs text-on-surface-variant/60 font-medium">{m.lv_length_bonus_desc()}</p>
              </div>
              <ToggleSwitch
                checked={config.lengthBonusEnabled}
                onToggle={(v: boolean) => { config.lengthBonusEnabled = v; }}
                disabled={!canManageSettings}
              />
            </div>

            {#if config.lengthBonusEnabled}
              {#if xpMode.simple}
                <div class="space-y-2 pt-3 border-t border-outline-variant/10 animate-in fade-in duration-200">
                  <div class="flex items-baseline justify-between gap-3">
                    <label for="lengthBonusStep" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.lv_length_bonus_step_label()}</label>
                    <span class="text-xs font-semibold text-primary">{LENGTH_BONUS_LABELS[lengthBonusStep - 1]()}</span>
                  </div>
                  <input
                    id="lengthBonusStep"
                    type="range"
                    min="1"
                    max="5"
                    step="1"
                    value={lengthBonusStep}
                    oninput={(e) => applyLengthBonusStep(Number(e.currentTarget.value))}
                    class="w-full accent-primary"
                    disabled={!canManageSettings}
                  />

                  {#if lengthBonusOffGrid}
                    <SimpleModeNotice message={m.lv_length_bonus_off_grid()} />
                  {/if}
                </div>
              {:else}
                <div class="grid grid-cols-1 md:grid-cols-2 gap-6 pt-3 border-t border-outline-variant/10 animate-in fade-in duration-200">
                  <div class="space-y-1.5">
                    <label for="lengthBonusThreshold" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.lv_length_bonus_threshold()}</label>
                    <input
                      id="lengthBonusThreshold"
                      type="number"
                      min="1"
                      bind:value={config.lengthBonusThreshold}
                      class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
                      disabled={!canManageSettings}
                    />
                    <p class="text-2xs text-on-surface-variant/50 ml-2">{m.lv_length_bonus_threshold_hint({ count: config.lengthBonusThreshold })}</p>
                  </div>

                  <div class="space-y-1.5">
                    <label for="lengthBonusMaxMultiplier" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.lv_length_bonus_max()}</label>
                    <input
                      id="lengthBonusMaxMultiplier"
                      type="number"
                      min="1"
                      max="10"
                      step="0.1"
                      bind:value={config.lengthBonusMaxMultiplier}
                      class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
                      disabled={!canManageSettings}
                    />
                    <p class="text-2xs text-on-surface-variant/50 ml-2">{m.lv_length_bonus_max_hint({ max: config.lengthBonusMaxMultiplier })}</p>
                  </div>
                </div>
              {/if}

              <div class="p-3 bg-primary/5 border border-primary/15 rounded-lg text-2xs text-primary/90 leading-relaxed flex items-start gap-2">
                <Papicon icon="Info" size={13} class="shrink-0 mt-0.5" />
                <span>{m.lv_length_bonus_example({ half: Math.round((config.lengthBonusThreshold || 1) / 2), midMult: (1 + 0.5 * ((config.lengthBonusMaxMultiplier || 1) - 1)).toFixed(2), threshold: config.lengthBonusThreshold, maxMult: Number(config.lengthBonusMaxMultiplier).toFixed(2) })}</span>
              </div>
            {/if}
          </div>

        </div>

      </section>

      <!-- Exclusions et multiplicateurs -->
      <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
        <h3 class="text-xl font-semibold flex items-center gap-3">
          <Papicon icon="Filter" size={20} class="text-primary" />
          {m.lv_exclusions_title()}
        </h3>

        <p class="text-xs text-on-surface-variant/70 leading-relaxed">{m.lv_exclusions_desc()}</p>

        <div class="grid grid-cols-1 gap-6">
          <!-- Salons exclus -->
          <div class="space-y-2">
            <p class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.lv_ignored_channels()}</p>
            <div class="flex flex-wrap gap-2 p-2.5 bg-surface-container-high/20 border border-outline-variant/10 rounded-lg min-h-[46px] items-center">
              {#each config.ignoredChannels as channelId}
                {@const channel = availableChannels.find(c => c.id === channelId)}
                {@const missing = isMissingReference(channelId, availableChannels)}
                <span
                  class="flex items-center gap-1.5 px-3 py-1 text-xs font-bold rounded-xl border shadow-sm {missing ? 'bg-warning/10 text-warning border-warning/30' : 'bg-surface-container-low text-on-surface-variant border-outline-variant/10'}"
                  title={missing ? m.lv_missing_ref_hint() : undefined}
                >
                  #{channel ? channel.name : channelId}
                  {#if canManageSettings}
                    <button type="button" onclick={() => config.ignoredChannels = config.ignoredChannels.filter(id => id !== channelId)} aria-label={m.d4_remove_item({ name: channel ? channel.name : channelId })} class="inline-flex items-center text-error transition-transform"><Papicon icon="x" size={11} /></button>
                  {/if}
                </span>
              {:else}
                <span class="text-xs text-on-surface-variant/40 ml-2 font-medium">{m.lv_no_ignored_channel()}</span>
              {/each}
            </div>
            {#if canManageSettings}
              <div class="relative w-full">
                <SearchableSelect 
                  bind:value={pendingIgnoreChannelId}
                  options={availableChannels.filter(c => !config.ignoredChannels.includes(c.id)).map(c => ({ id: c.id, name: channelDisplayName(c) }))} 
                  placeholder={m.lv_add_ignored_channel()} 
                  className="w-full"
                  clearable={false}
                />
              </div>
            {/if}
          </div>

          <!-- Rôles exclus -->
          <div class="space-y-2 pt-2 border-t border-outline-variant/10">
            <p class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.lv_ignored_roles()}</p>
            <div class="flex flex-wrap gap-2 p-2.5 bg-surface-container-high/20 border border-outline-variant/10 rounded-lg min-h-[46px] items-center">
              {#each config.ignoredRoles as roleId}
                {@const role = availableRoles.find(r => r.id === roleId)}
                {@const missing = isMissingReference(roleId, availableRoles)}
                <span
                  class="flex items-center gap-1.5 px-3 py-1 text-xs font-bold rounded-xl border shadow-sm {missing ? 'bg-warning/10 text-warning border-warning/30' : 'bg-surface-container-low text-on-surface-variant border-outline-variant/10'}"
                  title={missing ? m.lv_missing_ref_hint() : undefined}
                >
                  @{role ? role.name : roleId}
                  {#if canManageSettings}
                    <button type="button" onclick={() => config.ignoredRoles = config.ignoredRoles.filter(id => id !== roleId)} aria-label={m.d4_remove_item({ name: role ? role.name : roleId })} class="inline-flex items-center text-error transition-transform"><Papicon icon="x" size={11} /></button>
                  {/if}
                </span>
              {:else}
                <span class="text-xs text-on-surface-variant/40 ml-2 font-medium">{m.lv_no_ignored_role()}</span>
              {/each}
            </div>
            {#if canManageSettings}
              <div class="relative w-full">
                <SearchableSelect 
                  bind:value={pendingIgnoreRoleId}
                  options={availableRoles.filter(r => !config.ignoredRoles.includes(r.id)).map(r => ({ id: r.id, name: `@${r.name}` }))} 
                  placeholder={m.lv_add_ignored_role()} 
                  className="w-full"
                  clearable={false}
                />
              </div>
            {/if}
          </div>

          <!-- Multiplicateurs par rôle -->
          <div class="space-y-4 pt-4 border-t border-outline-variant/20">
            <h4 class="text-sm font-bold text-on-surface-variant">{m.lv_multipliers_title()}</h4>
      
            {#if canManageSettings}
              <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end bg-surface-container-high/20 p-4 rounded-xl border border-outline-variant/5">
                <div class="space-y-1.5">
                  <label for="multRole" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.lv_role()}</label>
                  <SearchableSelect 
                    id="multRole"
                    bind:value={newMultRoleId}
                    options={availableRoles.filter(r => !Object.keys(config.xpMultipliers).includes(r.id) && !(clanRewardXpBoost && lastWinningClanId && lastWinningClanId.split(',').some(id => clans.find(c => c.id === id)?.roleId === r.id))).map(r => ({ id: r.id, name: `@${r.name}` }))}
                    placeholder={m.lv_choose_role()}
                    className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg"
                    clearable={true}
                  />
                </div>

                <div class="space-y-1.5">
                  <label for="multValue" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.lv_multiplier()}</label>
                  <input 
                    id="multValue"
                    type="number" 
                    step="0.1"
                    min="0.1"
                    max="10"
                    bind:value={newMultValue} 
                    class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
                  />
                </div>

                <button 
                  type="button"
                  onclick={handleAddMultiplier}
                  disabled={!newMultRoleId || !newMultValue}
                  class="w-full py-3.5 bg-secondary text-on-secondary font-medium text-body-sm rounded-lg transition-all disabled:opacity-50"
                >
                  {m.common_add()}
                </button>
              </div>
            {/if}

            <div class="overflow-hidden rounded-lg border border-outline-variant/10 bg-surface-container-low/10">
              <table class="w-full border-collapse text-left">
                <thead>
                  <tr class="bg-surface-container-high/50 border-b border-outline-variant/10">
                    <th class="px-6 py-3 text-xs font-semibold text-on-surface-variant/70">{m.lv_role()}</th>
                    <th class="px-6 py-3 text-xs font-semibold text-on-surface-variant/70">{m.lv_multiplier()}</th>
                    {#if canManageSettings}
                      <th class="px-6 py-3 text-right text-xs font-semibold text-on-surface-variant/70">{m.lv_actions()}</th>
                    {/if}
                  </tr>
                </thead>
                <tbody class="divide-y divide-outline-variant/5">
                  {#if clanRewardXpBoost && lastWinningClanId}
                    {@const winnerIds = lastWinningClanId.split(',')}
                    {@const winningClansList = clans.filter(c => winnerIds.includes(c.id))}
                    {#each winningClansList as winningClan}
                      {#if winningClan.roleId}
                        <tr class="bg-warning/10 border-l-4 border-warning transition-all font-semibold">
                          <td class="px-6 py-3.5 text-sm font-semibold flex items-center gap-2">
                            <Papicon icon="Trophy" size={15} class="shrink-0 text-warning" />
                            <span>{getRoleName(winningClan.roleId)}</span>
                            <span class="text-xs bg-warning/20 text-warning px-1.5 py-0.5 rounded font-semibold">{m.lv_winning_clan_badge()}</span>
                          </td>
                          <td class="px-6 py-3.5 text-sm font-semibold text-warning">{clanRewardXpBoostRate}x</td>
                          {#if canManageSettings}
                            <td class="px-6 py-3.5 text-right text-xs text-on-surface-variant/60 font-medium italic">
                              {m.lv_auto_managed()}
                            </td>
                          {/if}
                        </tr>
                      {/if}
                    {/each}
                  {/if}

                  {#each Object.entries(config.xpMultipliers) as [roleId, mult]}
                    {@const missing = isMissingReference(roleId, availableRoles)}
                    <tr class="hover:bg-surface-hover/20 transition-all font-semibold">
                      <td
                        class="px-6 py-3.5 text-sm font-semibold {missing ? 'text-warning' : ''}"
                        title={missing ? m.lv_missing_ref_hint() : undefined}
                      >{getRoleName(roleId)}</td>
                      <td class="px-6 py-3.5 text-sm font-semibold text-primary">{mult}x</td>
                      {#if canManageSettings}
                        <td class="px-6 py-3.5 text-right">
                          <button 
                            type="button"
                            onclick={() => handleRemoveMultiplier(roleId)}
                            class="p-2 text-error hover:bg-error/10 rounded-xl transition-all"
                            title={m.common_delete()}
                          >
                            <Papicon icon="Trash" size={14} />
                          </button>
                        </td>
                      {/if}
                    </tr>
                  {/each}

                  {#if Object.keys(config.xpMultipliers).length === 0 && !(clanRewardXpBoost && lastWinningClanId && lastWinningClanId.split(',').some(id => clans.find(c => c.id === id)?.roleId))}
                    <tr>
                      <td colspan={canManageSettings ? 3 : 2} class="px-6 py-6 text-center text-xs text-on-surface-variant/60 font-medium">{m.lv_no_multiplier()}</td>
                    </tr>
                  {/if}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
    </div>

  {:else if activeTab === 'progression'}
    <!-- === ONGLET PROGRESSION === -->
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-8 animate-in fade-in duration-300">
      <div class="lg:col-span-2 space-y-8">
        <!-- Courbe de progression -->
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
          <div class="flex items-start justify-between gap-4">
            <h3 class="text-xl font-semibold flex items-center gap-3">
              <Papicon icon="Grades" size={20} class="text-primary" />
              {m.lv_curve_title()}
            </h3>
            <div class="flex flex-wrap items-center justify-end gap-2">
              <!-- Meme pave que les onglets de la page : les deux options sont
                   visibles cote a cote, avec icone, et l'active se detache. -->
              <SimpleModeToggle simple={curveMode.simple} onchange={(v) => curveMode.set(v)} />
              {#if canManageSettings}
                <button
                  type="button"
                  onclick={resetCurve}
                  class="text-2xs font-semibold text-on-surface-variant/70 hover:text-on-surface px-3 py-1.5 rounded-lg border border-outline-variant/20 transition-all"
                >
                  {m.lv_curve_reset()}
                </button>
              {/if}
            </div>
          </div>

          <p class="text-xs text-on-surface-variant/70 leading-relaxed">
            {curveMode.simple ? m.lv_curve_simple_desc() : m.lv_curve_desc()}
          </p>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            {#if curveMode.simple}
              <div class="md:col-span-2 space-y-6">
                <div class="space-y-2">
                  <div class="flex items-baseline justify-between gap-3">
                    <label for="curvePace" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.lv_curve_pace_label()}</label>
                    <span class="text-xs font-semibold text-primary">{CURVE_PACE_LABELS[curvePaceStep - 1]()}</span>
                  </div>
                  <input
                    id="curvePace"
                    type="range"
                    min="1"
                    max="5"
                    step="1"
                    value={curvePaceStep}
                    oninput={(e) => applyCurvePace(Number(e.currentTarget.value))}
                    class="w-full accent-primary"
                    disabled={!canManageSettings}
                  />
                </div>

                <div class="space-y-2">
                  <div class="flex items-baseline justify-between gap-3">
                    <label for="curveSteep" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.lv_curve_steep_label()}</label>
                    <span class="text-xs font-semibold text-primary">{CURVE_STEEP_LABELS[curveSteepStep - 1]()}</span>
                  </div>
                  <input
                    id="curveSteep"
                    type="range"
                    min="1"
                    max="5"
                    step="1"
                    value={curveSteepStep}
                    oninput={(e) => applyCurveSteepness(Number(e.currentTarget.value))}
                    class="w-full accent-primary"
                    disabled={!canManageSettings}
                  />
                </div>

                {#if curveOffGrid}
                  <SimpleModeNotice message={m.lv_curve_off_grid()} />
                {/if}
              </div>
            {:else}
            <div class="space-y-1.5">
              <label for="curveBaseXp" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.lv_curve_base()}</label>
              <input
                id="curveBaseXp"
                type="number"
                min={LEVEL_CURVE_LIMITS.baseXp.min}
                max={LEVEL_CURVE_LIMITS.baseXp.max}
                bind:value={config.curveBaseXp}
                class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
                disabled={!canManageSettings}
              />
              <p class="text-2xs text-on-surface-variant/50 ml-2">{m.lv_curve_base_hint()}</p>
            </div>

            <div class="space-y-1.5">
              <label for="curveLinearXp" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.lv_curve_linear()}</label>
              <input
                id="curveLinearXp"
                type="number"
                min={LEVEL_CURVE_LIMITS.linearXp.min}
                max={LEVEL_CURVE_LIMITS.linearXp.max}
                bind:value={config.curveLinearXp}
                class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
                disabled={!canManageSettings}
              />
              <p class="text-2xs text-on-surface-variant/50 ml-2">{m.lv_curve_linear_hint()}</p>
            </div>

            <div class="space-y-1.5">
              <label for="curveExponent" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.lv_curve_exponent()}</label>
              <input
                id="curveExponent"
                type="number"
                min={LEVEL_CURVE_LIMITS.exponent.min}
                max={LEVEL_CURVE_LIMITS.exponent.max}
                step="0.1"
                bind:value={config.curveExponent}
                class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
                disabled={!canManageSettings}
              />
              <p class="text-2xs text-on-surface-variant/50 ml-2">{m.lv_curve_exponent_hint()}</p>
            </div>

            {/if}

            <div class="space-y-1.5">
              <label for="maxLevel" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.lv_curve_max_level()}</label>
              <input
                id="maxLevel"
                type="number"
                min={LEVEL_CURVE_LIMITS.maxLevel.min}
                max={LEVEL_CURVE_LIMITS.maxLevel.max}
                bind:value={config.maxLevel}
                class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
                disabled={!canManageSettings}
              />
              <p class="text-2xs text-on-surface-variant/50 ml-2">{m.lv_curve_max_level_hint()}</p>
            </div>
          </div>

          <div class="space-y-3 pt-4 border-t border-outline-variant/10">
            <div>
              <h4 class="text-sm font-bold text-on-surface-variant">{m.lv_curve_preview_title()}</h4>
              <p class="text-2xs text-on-surface-variant/60 font-medium">{m.lv_curve_preview_desc()}</p>
            </div>

            {#if savedCurvePreview.length > 0}
              <div class="flex items-center gap-4 text-2xs font-medium text-on-surface-variant/70">
                <span class="flex items-center gap-1.5">
                  <span class="w-3 h-2 rounded-sm bg-primary/60"></span>{m.lv_curve_legend_edited()}
                </span>
                <span class="flex items-center gap-1.5">
                  <span class="w-3 h-[2px] bg-on-surface-variant/70"></span>{m.lv_curve_legend_saved()}
                </span>
              </div>
            {/if}

            <div class="flex items-end gap-[3px] h-32 px-2 py-2 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
              {#each curvePreview as point, index}
                {@const savedDelta = savedCurvePreview[index]?.deltaXp}
                <div
                  class="relative flex-1 h-full flex items-end"
                  title={m.lv_curve_milestone({ level: point.level }) + ' : ' + point.deltaXp.toLocaleString() + ' XP'
                    + (savedDelta === undefined ? '' : ' · ' + m.lv_curve_legend_saved() + ' ' + savedDelta.toLocaleString() + ' XP')}
                >
                  <div
                    class="w-full bg-primary/60 rounded-t-sm min-h-[2px]"
                    style="height: {Math.max(2, (point.deltaXp / curvePreviewMax) * 100)}%"
                  ></div>
                  {#if savedDelta !== undefined}
                    <!-- Anneau de la couleur du fond : le repere reste lisible
                         quand il tombe au milieu de la barre. -->
                    <div
                      class="absolute inset-x-0 h-[2px] bg-on-surface-variant/70 pointer-events-none"
                      style="bottom: calc({Math.min(100, (savedDelta / curvePreviewMax) * 100)}% - 1px); box-shadow: 0 0 0 1px var(--color-surface-container-low, transparent);"
                    ></div>
                  {/if}
                </div>
              {/each}
            </div>

            {@render levelAxis(curvePreview.length)}

            {#if curveStats}
              <div>
                <h4 class="text-sm font-bold text-on-surface-variant">{m.lv_curve_population_title()}</h4>
                <p class="text-2xs text-on-surface-variant/60 font-medium">{m.lv_curve_population_desc()}</p>
              </div>

              <div class="flex items-end gap-[3px] h-16 px-2 py-2 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
                {#each curveStats.distribution as count, index}
                  <div
                    class="flex-1 rounded-t-sm min-h-[2px] {count > 0 ? 'bg-teal-600' : 'bg-outline-variant/20'}"
                    style="height: {count > 0 ? Math.max(4, (count / curveStatsMax) * 100) : 0}%"
                    title={m.lv_curve_population_bar({ level: index + 1, count: count.toLocaleString() })}
                  ></div>
                {/each}
              </div>

              {@render levelAxis(curveStats.distribution.length)}

              {#if curveStats.beyond > 0}
                <p class="text-2xs text-on-surface-variant/60 ml-2">
                  {m.lv_curve_population_beyond({ count: curveStats.beyond.toLocaleString(), level: curveStats.distribution.length })}
                </p>
              {/if}
            {/if}

            <div class="flex flex-wrap items-center justify-between gap-3 pt-1">
              <p class="text-2xs text-on-surface-variant/70">{m.lv_estimate_intro()}</p>
              <FilterPills
                label={m.lv_estimate_intro()}
                options={ACTIVITY_LABELS.map((label, i) => ({ value: String(i + 1), label: label() }))}
                value={String(activityStep)}
                onchange={(value) => (activityStep = Number(value))}
              />
            </div>

            <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {#each curveMilestones as milestone}
                <div class="px-3 py-2.5 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
                  <p class="text-xs font-semibold text-on-surface-variant/60">{m.lv_curve_milestone({ level: milestone.level })}</p>
                  <p class="text-sm font-semibold text-on-surface">{m.lv_curve_milestone_total({ xp: milestone.totalXp.toLocaleString() })}</p>
                  <p class="text-2xs font-semibold text-primary">{formatDuration(estimateDays(milestone.level))}</p>
                </div>
              {/each}
            </div>

            <div class="p-3 bg-warning/10 border border-warning/20 rounded-lg text-2xs text-warning leading-relaxed flex items-start gap-2">
              <Papicon icon="AlertTriangle" size={13} class="shrink-0 mt-0.5" />
              <div class="min-w-0 flex-1">
              {#if curveDirty && curveStats}
                <p class="font-bold mb-1">{curveImpactLabel}</p>
              {/if}
              {m.lv_curve_warning()}
              {#if rewardImpact.length > 0}
                <p class="font-bold mt-2">{m.lv_reward_impact_title()}</p>
                <ul class="space-y-0.5">
                  {#each rewardImpact as row}
                    <li class="flex justify-between gap-3">
                      <span>{getRoleName(row.roleId)}</span>
                      <span class="font-semibold tabular-nums flex gap-2">
                        {#if row.gained > 0}<span class="text-success">+{row.gained.toLocaleString()}</span>{/if}
                        {#if row.lost > 0}<span class="text-error">−{row.lost.toLocaleString()}</span>{/if}
                      </span>
                    </li>
                  {/each}
                </ul>
                <p class="mt-1 opacity-80">{m.lv_reward_impact_desc()}</p>
              {/if}
              </div>
            </div>

            {#if roleResync.pending > 0}
              <div class="p-4 bg-surface-container-high/25 border border-outline-variant/10 rounded-lg space-y-3">
                <div>
                  <p class="text-sm font-bold text-on-surface">{m.lv_role_resync_title({ count: roleResync.pending.toLocaleString() })}</p>
                  <p class="text-2xs text-on-surface-variant/70 leading-relaxed">{m.lv_role_resync_desc()}</p>
                </div>

                {#if roleResync.running}
                  <div class="flex items-center justify-between gap-4">
                    <span class="text-2xs font-semibold text-on-surface-variant tabular-nums">
                      {m.lv_role_resync_progress({ done: roleResync.done.toLocaleString(), total: roleResync.pending.toLocaleString() })}
                    </span>
                    <button
                      type="button"
                      onclick={stopRoleResync}
                      class="px-4 py-2 bg-error/10 text-error font-medium text-xs rounded-lg hover:bg-error/20 transition-all"
                    >
                      {m.lv_role_resync_stop()}
                    </button>
                  </div>
                {:else if canManageSettings}
                  <button
                    type="button"
                    onclick={startRoleResync}
                    class="px-5 py-2.5 bg-secondary text-on-secondary font-medium text-xs rounded-lg transition-all"
                  >
                    {m.lv_role_resync_start()}
                  </button>
                {/if}
              </div>
            {/if}
          </div>
        </section>

        <!-- Boost de Saison de Clan -->
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
          <h3 class="text-xl font-semibold flex items-center gap-3">
            <Papicon icon="Award" size={20} class="text-warning" />
            {m.lv_clan_boost_title()}
          </h3>

          {#if !clansEnabled}
            <div class="p-6 bg-surface-container-high/20 rounded-xl border border-outline-variant/10 flex flex-col items-center justify-center text-center space-y-3">
              <span class="text-3xl">🔒</span>
              <div>
                <h4 class="text-sm font-semibold text-on-surface">{m.lv_clans_disabled_title()}</h4>
                <p class="text-xs text-on-surface-variant/70 max-w-md mt-1">
                  {m.lv_clans_disabled_desc()}
                </p>
              </div>
            </div>
          {:else}
            <div class="space-y-4">
              <div class="flex items-center justify-between">
                <div>
                  <span class="text-sm font-medium text-on-surface">{m.lv_clan_boost_enable()}</span>
                  <p class="text-xs text-on-surface-variant/70">
                    {m.lv_clan_boost_desc()}
                  </p>
                </div>
                <ToggleSwitch checked={clanRewardXpBoost} onToggle={(v) => clanRewardXpBoost = v} disabled={!canManageSettings} />
              </div>

              {#if clanRewardXpBoost}
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-6 pt-4 border-t border-outline-variant/10 animate-in slide-in-from-top-2 duration-200">
                  <div class="space-y-1.5">
                    <span class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.lv_clan_target_role()}</span>
                    <div class="px-4 py-3 bg-primary/10 rounded-lg text-sm text-primary font-semibold border border-primary/20 flex items-center gap-2">
                      <Papicon icon="Crown" size={15} class="shrink-0" />
                      {#if lastWinningClanId}
                        {@const winningClan = clans.find(c => c.id === lastWinningClanId)}
                        {@const targetRole = availableRoles.find(r => r.id === winningClan?.roleId)}
                        <span>
                          {winningClan ? `${winningClan.name} (@${targetRole?.name || m.lv_unknown_role_short()})` : m.lv_winning_clan()}
                        </span>
                      {:else}
                        <span class="italic text-primary/70">{m.lv_waiting_first_season()}</span>
                      {/if}
                    </div>
                  </div>

                  <div class="space-y-1.5">
                    <label for="clanXpBoostRate" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.lv_clan_boost_rate()}</label>
                    <input 
                      id="clanXpBoostRate"
                      type="number" 
                      step="0.05"
                      min="1.0"
                      max="10"
                      bind:value={clanRewardXpBoostRate} 
                      class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none font-bold"
                      disabled={!canManageSettings}
                    />
                  </div>
                </div>
              {/if}
            </div>
          {/if}
        </section>
      </div>

      <!-- Récompenses (sidebar droite) -->
      <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
        <h3 class="text-xl font-semibold flex items-center gap-3">
          <Papicon icon="Award" size={20} class="text-secondary" />
          {m.lv_rewards_title()}
        </h3>

        <div class="space-y-1.5 flex items-center justify-between bg-surface-container-high/20 border border-outline-variant/5 rounded-lg px-6 py-4">
          <div>
            <span class="text-xs font-bold text-on-surface">{m.lv_stack_title()}</span>
            <p class="text-2xs text-on-surface-variant/60 font-medium">{m.lv_stack_desc()}</p>
          </div>
          <ToggleSwitch 
            checked={config.stackRewards} 
            onToggle={(v: boolean) => { config.stackRewards = v; }} 
            disabled={!canManageSettings}
          />
        </div>

        {#if canManageSettings}
          <form onsubmit={(e) => { e.preventDefault(); handleAddReward(); }} class="space-y-4 bg-surface-container-high/20 p-4 rounded-xl border border-outline-variant/5">
            <div class="space-y-1.5">
              <label for="rewardLvl" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.lv_reward_level()}</label>
              <input 
                id="rewardLvl"
                type="number" 
                min="1"
                placeholder="Ex: 5"
                bind:value={newRewardLevel} 
                class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
                required
              />
            </div>

            <div class="space-y-1.5">
              <label for="rewardRole" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.lv_reward_role()}</label>
              <SearchableSelect 
                id="rewardRole"
                bind:value={newRewardRoleId} 
                options={availableRoles.map(r => ({ id: r.id, name: `@${r.name}` }))} 
                placeholder={m.lv_choose_role()} 
                className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all"
              />
            </div>

            <button 
              type="submit"
              disabled={!newRewardLevel || !newRewardRoleId}
              class="w-full py-3.5 bg-secondary text-on-secondary font-medium text-body-sm rounded-lg transition-all disabled:opacity-50"
            >
              {m.lv_add_reward()}
            </button>
          </form>
        {/if}

        <div class="overflow-hidden rounded-xl border border-outline-variant/10 bg-surface-container-low/10">
          <table class="w-full border-collapse text-left">
            <thead>
              <tr class="bg-surface-container-high/50 border-b border-outline-variant/10">
                <th class="px-5 py-4 text-xs font-semibold text-on-surface-variant/70">{m.lv_level()}</th>
                <th class="px-5 py-4 text-xs font-semibold text-on-surface-variant/70">{m.lv_role()}</th>
                {#if canManageSettings}
                  <th class="px-5 py-4 text-right text-xs font-semibold text-on-surface-variant/70">–</th>
                {/if}
              </tr>
            </thead>
            <tbody class="divide-y divide-outline-variant/5">
              {#each rewards as reward}
                {@const missingRole = isMissingReference(reward.roleId, availableRoles)}
                <tr class="hover:bg-surface-hover/20 transition-all">
                  <td class="px-5 py-4 font-semibold text-primary text-sm">
                    Lvl {reward.level}
                    {#if unreachableRewardIds.has(reward.id)}
                      <span
                        class="ml-2 px-2 py-0.5 rounded-full bg-warning/15 text-warning text-2xs font-bold align-middle"
                        title={m.lv_reward_unreachable_hint({ level: levelCurve.maxLevel })}
                      >{m.lv_reward_unreachable()}</span>
                    {/if}
                  </td>
                  <td
                    class="px-5 py-4 text-xs font-semibold {missingRole ? 'text-warning' : ''}"
                    title={missingRole ? m.lv_missing_ref_hint() : undefined}
                  >{getRoleName(reward.roleId)}</td>
                  {#if canManageSettings}
                    <td class="px-5 py-4 text-right">
                      <button 
                        onclick={() => handleDeleteReward(reward.id)}
                        class="p-2 text-error hover:bg-error/10 rounded-xl transition-all"
                        title={m.lv_delete_reward()}
                      >
                        <Papicon icon="Trash" size={14} />
                      </button>
                    </td>
                  {/if}
                </tr>
              {:else}
                <tr>
                  <td colspan={canManageSettings ? 3 : 2} class="px-5 py-8 text-center text-xs text-on-surface-variant/60 font-medium">{m.lv_no_reward()}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    </div>

  {:else if activeTab === 'annonces'}
    <!-- === ONGLET ANNONCES === -->
    <div class="space-y-8 animate-in fade-in duration-300">
      <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
        <h3 class="text-xl font-semibold flex items-center gap-3">
          <Papicon icon="Bell" size={20} class="text-primary" />
          {m.lv_levelup_notifs()}
        </h3>
        <div class="space-y-6">
  
          <div class="space-y-1.5">
            <label for="lvlChannel" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.lv_levelup_channel()}</label>
            <SearchableSelect 
              id="lvlChannel"
              bind:value={config.levelUpChannelId} 
              options={[
                { id: '', name: m.lv_levelup_origin_channel() },
                { id: 'DM', name: m.lv_levelup_dm() },
                ...availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))
              ]} 
              placeholder={m.lv_select_placeholder()} 
              className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all"
              disabled={!canManageSettings}
            />
            {#if levelUpChannelState === 'missing'}
              <p class="text-2xs text-warning mt-1.5">{m.lv_missing_ref_hint()}</p>
            {/if}
            {#if canManageSettings && canCreateLevelUpChannel}
              <div class="flex items-center gap-3 pt-1">
                <button
                  type="button"
                  onclick={handleCreateLevelUpChannel}
                  disabled={createChannelAction.state.loading}
                  class="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-container-high/40 border border-outline-variant/10 text-xs font-semibold text-on-surface-variant hover:text-on-surface transition-colors disabled:opacity-50"
                >
                  <Papicon icon="sparkles" size={13} />
                  {createChannelAction.state.loading ? m.lv_creating_channel() : m.lv_create_channel()}
                </button>
                <span class="text-2xs text-on-surface-variant/50">{m.lv_create_channel_hint()}</span>
              </div>
            {/if}
          </div>

          <div class="space-y-1.5">
            <label for="lvlMsg" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.lv_levelup_message()}</label>
            <input 
              id="lvlMsg"
              type="text" 
              bind:value={config.levelUpMessage} 
              class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
              placeholder={m.lv_levelup_message_ph({ user: '{user}', level: '{level}' })}
              disabled={!canManageSettings}
            />
            <p class="text-2xs text-on-surface-variant/40 ml-2">{m.lv_variables_label()} <code class="bg-surface-container px-1 py-0.5 rounded text-primary dark:text-blue-300">{`{user}`}</code> {m.lv_variables_mention()}, <code class="bg-surface-container px-1 py-0.5 rounded text-primary dark:text-blue-300">{`{username}`}</code>, <code class="bg-surface-container px-1 py-0.5 rounded text-primary dark:text-blue-300">{`{level}`}</code></p>
            <p class="text-2xs text-on-surface-variant/40 ml-2">{m.lv_levelup_message_hint()}</p>
          </div>
        </div>
      </section>
    </div>

  {:else if activeTab === 'leaderboard'}
    <!-- === ONGLET CLASSEMENT === -->
    <div class="space-y-6 animate-in fade-in duration-300">

      <!-- Bannière lien public premium -->
      <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-linear-to-r from-tertiary/10 to-secondary/10 border border-tertiary/20 rounded-xl p-6 px-8 shadow-xs relative overflow-hidden group">
        <div class="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-700" style="background: radial-gradient(circle, color-mix(in srgb, var(--color-tertiary) 5%, transparent) 0%, transparent 70%);"></div>
        <div class="flex items-center gap-4 relative z-10">
          <div class="w-12 h-12 rounded-lg bg-tertiary/10 border border-tertiary/20 flex items-center justify-center text-tertiary shadow-inner transform transition-transform duration-350">
            <Papicon icon="Globe" size={22} />
          </div>
          <div>
            <p class="text-sm font-semibold text-on-surface">{m.lv_public_page_title()}</p>
            <p class="text-xs text-on-surface-variant/70 font-medium">{m.lv_public_page_desc()}</p>
          </div>
        </div>
        <div class="flex items-center gap-3 shrink-0 relative z-10 w-full sm:w-auto">
          <a
            href={publicLeaderboardUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="flex items-center justify-center gap-2 px-5 py-3 bg-tertiary/20 text-tertiary border border-tertiary/25 rounded-lg text-xs font-semibold hover:bg-tertiary/30 transition-all hover:scale-103 w-full sm:w-auto text-center"
          >
            <Papicon icon="ExternalLink" size={14} />
            {m.lv_view_page()}
          </a>
          <button
            onclick={copyPublicUrl}
            class="flex items-center justify-center gap-2 px-5 py-3 rounded-lg text-xs font-semibold transition-all hover:scale-103 w-full sm:w-auto {copySuccess ? 'bg-success/15 text-success border border-success/20' : 'bg-surface-container-high/40 text-on-surface-variant border border-outline-variant/10 hover:bg-surface-container-high/60'}"
          >
            {#if copySuccess}
              <Papicon icon="Check" size={14} />
              {m.lv_copied()}
            {:else}
              <Papicon icon="Copy" size={14} />
              {m.lv_copy_link()}
            {/if}
          </button>
        </div>
      </div>

      <!-- Stats globales -->
      {#if memberCount > 0}
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-4" data-tour="leveling-stats">
          <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-5 text-center space-y-1.5 hover:border-primary/20 transition-all duration-300 group">
            <p class="text-2xl font-semibold text-primary transition-transform duration-300">{memberCount.toLocaleString()}</p>
            <p class="text-xs font-semibold text-on-surface-variant/60">{m.lv_stat_members()}</p>
          </div>
          <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-5 text-center space-y-1.5 hover:border-secondary/20 transition-all duration-300 group">
            <p class="text-2xl font-semibold text-secondary transition-transform duration-300">{maxLevel}</p>
            <p class="text-xs font-semibold text-on-surface-variant/60">{m.lv_stat_maxlevel()}</p>
          </div>
          <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-5 text-center space-y-1.5 hover:border-tertiary/20 transition-all duration-300 group">
            <p class="text-2xl font-semibold text-tertiary transition-transform duration-300">{avgLevel}</p>
            <p class="text-xs font-semibold text-on-surface-variant/60">{m.lv_stat_avglevel()}</p>
          </div>
          <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-5 text-center space-y-1.5 hover:border-warning/20 transition-all duration-300 group">
            <p class="text-2xl font-semibold text-warning transition-transform duration-300">{(totalXp / 1000).toFixed(1)}k</p>
            <p class="text-xs font-semibold text-on-surface-variant/60">{m.lv_stat_totalxp()}</p>
          </div>
        </div>
      {/if}

      <!-- Classement principal -->
      <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6" data-tour="leveling-leaderboard">
        <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <h3 class="text-xl font-semibold flex items-center gap-3">
            <Papicon icon="Grades" size={20} class="text-tertiary" />
            {m.lv_leaderboard_title({ count: memberCount })}
          </h3>

          <!-- Barre de recherche -->
          <div class="relative w-full md:w-80">
            <input 
              type="text" 
              placeholder={m.lv_search_member()} 
              bind:value={searchQuery}
              class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 pl-11 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-tertiary/30 placeholder:text-on-surface-variant/50 transition-all shadow-inner"
            />
            <div class="absolute left-4 top-1/2 -translate-y-1/2 text-sm opacity-40 text-on-surface flex items-center">
              <Papicon icon="Search" size={14} />
            </div>
            {#if searchQuery}
              <button 
                onclick={() => searchQuery = ''}
                aria-label={m.lv_clear_search()}
                class="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-surface-container-high/60 hover:bg-error/10 hover:text-error text-on-surface-variant/60 flex items-center justify-center transition-all"
              >
                <Papicon icon="x" size={11} />
              </button>
            {/if}
          </div>
        </div>

        <!-- Section Top 3 Sleek Cards -->
        {#if podium.length > 0}
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-4xl mx-auto pt-4 pb-8 border-b border-outline-variant/10" data-tour="leveling-podium">
            
            <!-- Rank 2 Card -->
            {#if podium[1]}
              <div class="relative bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 flex flex-col justify-between hover:border-primary/25 transition-all duration-300 group shadow-sm order-2 sm:order-1">
                <div class="flex items-start justify-between">
                  <div class="relative">
                    <img
                      src={memberAvatarSrc(podium[1].avatarUrl, podium[1].displayName || podium[1].username, podium[1].userId)}
                      alt=""
                      class="w-16 h-16 rounded-lg object-cover border border-outline-variant/10 shadow-inner"
                    />
                    <!-- Rank indicator -->
                    <div class="absolute -bottom-2 -right-2 bg-surface-container-high text-on-surface-variant border border-outline-variant/15 w-6 h-6 rounded-lg flex items-center justify-center font-bold text-xs font-mono">
                      2
                    </div>
                  </div>
                  <!-- Medal Icon -->
                  <div class="text-on-surface-variant/40 group-hover:text-primary transition-colors">
                    <Papicon icon="Medal" size={20} />
                  </div>
                </div>
                
                <div class="mt-6 space-y-4">
                  <div class="space-y-0.5">
                    <p class="font-bold text-on-surface truncate group-hover:text-primary transition-colors" title={podium[1].displayName}>
                      {podium[1].displayName || podium[1].username || m.lv_unknown_member()}
                    </p>
                    {#if podium[1].username && podium[1].displayName !== podium[1].username}
                      <p class="text-xs text-on-surface-variant/50 font-medium truncate">@{podium[1].username}</p>
                    {/if}
                  </div>
                  
                  <div class="flex items-center justify-between border-t border-outline-variant/5 pt-3 text-xs">
                    <span class="text-on-surface-variant/70 font-semibold">{m.lv_level_n({ level: podium[1].level })}</span>
                    <span class="text-on-surface-variant/80 font-mono font-medium">{podium[1].xp.toLocaleString()} XP</span>
                  </div>
                </div>
              </div>
            {/if}

            <!-- Rank 1 Card (Highlighted) -->
            {#if podium[0]}
              <div class="relative bg-surface-container-low/60 border border-tertiary/20 rounded-xl overflow-hidden p-6 flex flex-col justify-between hover:border-tertiary/40 transition-all duration-300 group shadow-md ring-1 ring-tertiary/5 order-1 sm:order-2">
                <!-- Top accent bar -->
                <div class="absolute top-0 inset-x-0 h-1 bg-linear-to-r from-tertiary to-secondary"></div>
                
                <div class="flex items-start justify-between mt-1">
                  <div class="relative">
                    <img
                      src={memberAvatarSrc(podium[0].avatarUrl, podium[0].displayName || podium[0].username, podium[0].userId)}
                      alt=""
                      class="w-20 h-20 rounded-lg object-cover border border-tertiary/20 shadow-inner"
                    />
                    <!-- Rank indicator -->
                    <div class="absolute -bottom-2 -right-2 bg-tertiary text-on-tertiary w-7 h-7 rounded-lg flex items-center justify-center font-semibold text-sm font-mono shadow-md">
                      1
                    </div>
                  </div>
                  <!-- Crown Icon -->
                  <div class="text-tertiary filter drop-shadow-[0_0_8px_rgba(var(--tertiary-color),0.2)]">
                    <Papicon icon="Crown" size={24} />
                  </div>
                </div>
                
                <div class="mt-6 space-y-4">
                  <div class="space-y-0.5">
                    <p class="font-semibold text-on-surface text-lg truncate group-hover:text-tertiary transition-colors" title={podium[0].displayName}>
                      {podium[0].displayName || podium[0].username || m.lv_unknown_member()}
                    </p>
                    {#if podium[0].username && podium[0].displayName !== podium[0].username}
                      <p class="text-xs text-tertiary/70 font-medium truncate">@{podium[0].username}</p>
                    {/if}
                  </div>
                  
                  <div class="flex items-center justify-between border-t border-tertiary/10 pt-3 text-sm">
                    <span class="text-tertiary font-semibold">{m.lv_level_n({ level: podium[0].level })}</span>
                    <span class="text-tertiary/90 font-mono font-bold">{podium[0].xp.toLocaleString()} XP</span>
                  </div>
                </div>
              </div>
            {/if}

            <!-- Rank 3 Card -->
            {#if podium[2]}
              <div class="relative bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 flex flex-col justify-between hover:border-primary/25 transition-all duration-300 group shadow-sm order-3">
                <div class="flex items-start justify-between">
                  <div class="relative">
                    <img
                      src={memberAvatarSrc(podium[2].avatarUrl, podium[2].displayName || podium[2].username, podium[2].userId)}
                      alt=""
                      class="w-16 h-16 rounded-lg object-cover border border-outline-variant/10 shadow-inner"
                    />
                    <!-- Rank indicator -->
                    <div class="absolute -bottom-2 -right-2 bg-surface-container-high text-on-surface-variant border border-outline-variant/15 w-6 h-6 rounded-lg flex items-center justify-center font-bold text-xs font-mono">
                      3
                    </div>
                  </div>
                  <!-- Medal Icon -->
                  <div class="text-on-surface-variant/40 group-hover:text-primary transition-colors">
                    <Papicon icon="Medal" size={20} />
                  </div>
                </div>
                
                <div class="mt-6 space-y-4">
                  <div class="space-y-0.5">
                    <p class="font-bold text-on-surface truncate group-hover:text-primary transition-colors" title={podium[2].displayName}>
                      {podium[2].displayName || podium[2].username || m.lv_unknown_member()}
                    </p>
                    {#if podium[2].username && podium[2].displayName !== podium[2].username}
                      <p class="text-xs text-on-surface-variant/50 font-medium truncate">@{podium[2].username}</p>
                    {/if}
                  </div>
                  
                  <div class="flex items-center justify-between border-t border-outline-variant/5 pt-3 text-xs">
                    <span class="text-on-surface-variant/70 font-semibold">{m.lv_level_n({ level: podium[2].level })}</span>
                    <span class="text-on-surface-variant/80 font-mono font-medium">{podium[2].xp.toLocaleString()} XP</span>
                  </div>
                </div>
              </div>
            {/if}

          </div>
        {/if}

        <!-- Liste complète des membres avec design en cartes premiums -->
        <div class="space-y-3 max-h-[600px] overflow-y-auto pr-1">
          {#each leaderboardRows as userLvl (userLvl.userId)}
            {@const index = userLvl.rank - 1}
            {@const lvl = userLvl.level}
            {@const nextLvlXp = getXpForLevel(lvl)}
            {@const prevLvlXp = getXpForLevel(lvl - 1)}
            {@const neededProgress = Math.max(1, nextLvlXp - prevLvlXp)}
            {@const currentProgress = Math.min(Math.max(0, userLvl.xp - prevLvlXp), neededProgress)}
            {@const percent = Math.min(100, Math.max(0, (currentProgress / neededProgress) * 100))}
            
            <div class="flex items-center gap-4 p-4 rounded-lg bg-surface-container-high/15 border border-outline-variant/5 hover:bg-surface-container-high/30 hover:border-outline-variant/15 transition-all duration-350 group">
              <!-- Rang -->
              <div class="w-10 h-10 rounded-xl flex items-center justify-center font-semibold text-sm shrink-0 font-mono
 {index === 0 ? 'bg-warning/15 text-warning border border-warning/25 shadow-sm shadow-amber-400/5' : 
                 index === 1 ? 'bg-slate-400/15 text-on-surface-variant border border-slate-400/25 shadow-sm shadow-slate-400/5' : 
                 index === 2 ? 'bg-amber-700/15 text-warning border border-amber-700/25 shadow-sm shadow-amber-700/5' : 
                 'bg-surface-container text-on-surface-variant/50 border border-outline-variant/5'}">
                {index + 1}
              </div>

              <!-- Avatar -->
              <img 
                src={memberAvatarSrc(userLvl.avatarUrl, userLvl.displayName || userLvl.username, userLvl.userId)} 
                alt="" 
                class="w-11 h-11 rounded-xl border border-outline-variant/10 shadow-inner object-cover shrink-0"
              />

              <!-- Nom & Progression -->
              <div class="flex-1 min-w-0">
                <div class="flex items-baseline gap-2 mb-1.5">
                  <p class="text-sm font-semibold text-on-surface truncate">{userLvl.displayName || userLvl.username || m.lv_unknown_member()}</p>
                  {#if userLvl.username && userLvl.displayName !== userLvl.username}
                    <span class="text-2xs text-on-surface-variant/40 truncate font-semibold font-mono">@{userLvl.username}</span>
                  {/if}
                </div>

                <!-- Barre de progression -->
                <div class="flex items-center gap-2.5">
                  <div class="flex-1 h-2 bg-surface-container/60 rounded-full overflow-hidden p-[2px] border border-outline-variant/5">
                    <div 
                      class="h-full rounded-full transition-all duration-700
 {index === 0 ? 'bg-linear-to-r from-amber-400 to-yellow-300' : 
                         index === 1 ? 'bg-linear-to-r from-slate-300 to-slate-400' : 
                         index === 2 ? 'bg-linear-to-r from-amber-700 to-amber-600' : 
                         'bg-linear-to-r from-primary to-secondary'}" 
                      style="width: {percent}%"
                    ></div>
                  </div>
                  <span class="text-2xs font-bold text-on-surface-variant/40 whitespace-nowrap font-mono tracking-wide">{currentProgress.toLocaleString()} / {neededProgress.toLocaleString()} XP</span>
                </div>
              </div>

              <!-- Niveau Badge -->
              <div class="text-right shrink-0">
                <span class="text-body-sm font-medium px-3.5 py-2 rounded-xl border whitespace-nowrap shadow-xs
 {index === 0 ? 'bg-warning/10 text-warning border-warning/20' : 
                   index === 1 ? 'bg-slate-400/10 text-on-surface-variant border-slate-400/20' : 
                   index === 2 ? 'bg-amber-700/10 text-warning border-amber-700/20' : 
                   'bg-primary/10 text-primary border-primary/15'}">
                  Lvl {lvl}
                </span>
              </div>
            </div>
          {:else}
            <!-- Aucun membre trouvé -->
            <div class="flex flex-col items-center justify-center py-20 text-center space-y-4">
              <div class="w-16 h-16 rounded-lg bg-surface-container-high/30 border border-outline-variant/10 flex items-center justify-center text-primary animate-bounce">
                {#if searchQuery}
                  <Papicon icon="Search" size={24} />
                {:else}
                  <Papicon icon="Trophy" size={24} />
                {/if}
              </div>
              <div class="space-y-1">
                <p class="text-sm text-on-surface font-semibold">
                  {#if searchQuery}{m.lv_no_member_found({ query: searchQuery })}{:else}{m.lv_leaderboard_empty()}{/if}
                </p>
                {#if searchQuery}
                  <button onclick={() => searchQuery = ''} class="text-primary text-xs font-semibold hover:underline">{m.lv_clear_search()}</button>
                {/if}
              </div>
            </div>
          {/each}
        </div>

        {#if searchLimited}
          <p class="text-2xs text-warning font-medium">{m.lv_search_limited()}</p>
        {/if}

        {#if leaderboardPageCount > 1}
          <div class="flex items-center justify-between gap-4 pt-2">
            <button
              type="button"
              onclick={() => loadLeaderboard(leaderboardPage - 1)}
              disabled={leaderboardPage <= 1 || leaderboardLoading}
              class="px-4 py-2.5 bg-surface-container-high/50 text-on-surface-variant font-medium text-xs rounded-lg hover:bg-surface-container-high transition-all disabled:opacity-40"
            >
              {m.lv_page_previous()}
            </button>
            <span class="text-2xs font-medium text-on-surface-variant/70 tabular-nums">
              {m.lv_page_position({ page: leaderboardPage, pageCount: leaderboardPageCount, total: leaderboardTotal.toLocaleString() })}
            </span>
            <button
              type="button"
              onclick={() => loadLeaderboard(leaderboardPage + 1)}
              disabled={leaderboardPage >= leaderboardPageCount || leaderboardLoading}
              class="px-4 py-2.5 bg-surface-container-high/50 text-on-surface-variant font-medium text-xs rounded-lg hover:bg-surface-container-high transition-all disabled:opacity-40"
            >
              {m.lv_page_next()}
            </button>
          </div>
        {/if}
      </section>
    </div>
  {:else if activeTab === 'import'}
    <!-- === ONGLET IMPORTATION === -->
    <div class="space-y-8 animate-in fade-in duration-300">
      
      <!-- Avertissement de sécurité / explicatif -->
      <div class="bg-surface-container-low/40 border border-outline-variant/10 p-6 rounded-xl flex items-start gap-4">
        <div class="w-10 h-10 bg-secondary/15 rounded-lg flex items-center justify-center text-secondary shrink-0">
          <Papicon icon="Info" size={20} />
        </div>
        <div class="space-y-1">
          <h4 class="text-sm font-semibold text-on-surface">{m.lv_import_how_title()}</h4>
          <p class="text-xs text-on-surface-variant/70 leading-relaxed font-medium">
            {m.lv_import_how_1()}<strong>{m.lv_import_how_strong_username()}</strong>{m.lv_import_how_2()}<strong>{m.lv_import_how_strong_display()}</strong>{m.lv_import_how_3()}<strong>{m.lv_import_how_strong_tag()}</strong>{m.lv_import_how_4()}
          </p>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <!-- Zone d'importation (2/3 de large) -->
        <div class="lg:col-span-2 space-y-6">
          <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
            <h3 class="text-xl font-semibold flex items-center gap-3">
              <Papicon icon="Upload" size={20} class="text-secondary" />
              {m.lv_import_input_title()}
            </h3>

            <!-- Glisser-déposer / Sélecteur de fichier -->
            <div 
              role="button"
              tabindex="0"
              class="w-full border-2 border-dashed border-outline-variant/20 rounded-xl p-8 text-center hover:bg-surface-container-high/20 transition-all cursor-pointer flex flex-col items-center justify-center space-y-2 relative {isDragging ? 'border-primary bg-primary/5 scale-[1.01]' : ''}"
              ondragover={(e) => { e.preventDefault(); isDragging = true; }}
              ondragleave={() => isDragging = false}
              ondrop={handleFileDrop}
            >
              <input 
                type="file" 
                accept=".json" 
                class="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                onchange={handleFileSelect}
              />
              <div class="w-12 h-12 bg-secondary/10 text-secondary rounded-lg flex items-center justify-center shadow-inner mb-2">
                <Papicon icon="Upload" size={24} />
              </div>
              <p class="text-sm font-semibold text-on-surface">{m.lv_import_drop()}</p>
              <p class="text-xs text-on-surface-variant/60 font-medium">{m.lv_import_browse()}</p>
            </div>

            <!-- Textarea alternatif -->
            <div class="space-y-2">
              <label for="rawJsonTextarea" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.lv_import_paste()}</label>
              <textarea
                id="rawJsonTextarea"
                rows="10"
                bind:value={importRawJson}
                placeholder={`[\n  {\n    "username": "@klaynight",\n    "display_name": "Klaynight",\n    "level": 48,\n    "xp": 119652\n  }\n]`}
                class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-xs font-mono focus:ring-2 focus:ring-secondary/30 transition-all text-on-surface focus:outline-none resize-y"
              ></textarea>
            </div>

            <!-- Messages d'erreur locaux / globaux -->
            {#if importFileError}
              <div class="bg-error/10 text-error text-xs font-bold px-4 py-3 rounded-lg border border-error/20 flex items-center gap-2">
                <Papicon icon="x" size={13} />
                <span>{importFileError}</span>
              </div>
            {/if}

            <InlineFeedback state={importActionState} />

            <!-- Boutons de validation -->
            <div class="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onclick={() => { importRawJson = ''; importFileError = null; importResults = null; }}
                class="px-6 py-3.5 bg-surface-container-high/50 text-on-surface-variant font-medium text-body-sm rounded-lg hover:bg-surface-container-high transition-all"
              >
                {m.lv_clear()}
              </button>
              <button
                type="button"
                onclick={() => handleImportSubmit(true)}
                disabled={!importRawJson.trim()}
                class="px-6 py-3.5 bg-surface-container-high/50 text-on-surface-variant font-medium text-body-sm rounded-lg hover:bg-surface-container-high transition-all disabled:opacity-50"
              >
                {m.lv_import_dry_run()}
              </button>
              <button
                type="button"
                onclick={() => handleImportSubmit(false)}
                disabled={!importRawJson.trim()}
                class="px-8 py-3.5 bg-secondary text-on-secondary font-medium text-body-sm rounded-lg transition-all disabled:opacity-50"
              >
                {m.lv_run_import()}
              </button>
            </div>
          </section>

          <!-- Liste des erreurs d'import (si présentes) -->
          {#if importResults && importResults.failedCount > 0}
            <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-4">
              <div class="flex items-center gap-3 text-error">
                <div class="w-8 h-8 rounded-xl bg-error/15 flex items-center justify-center">
                  <Papicon icon="x" size={16} />
                </div>
                <div>
                  <h3 class="text-base font-semibold">{m.lv_import_failed_title({ count: importResults.failedCount })}</h3>
                  <p class="text-xs text-on-surface-variant/60 font-semibold">{m.lv_import_failed_desc()}</p>
                </div>
              </div>

              <div class="overflow-hidden rounded-lg border border-outline-variant/10 bg-surface-container-low/10 max-h-72 overflow-y-auto">
                <table class="w-full border-collapse text-left">
                  <thead>
                    <tr class="bg-surface-container-high/50 border-b border-outline-variant/10">
                      <th class="px-5 py-3 text-xs font-semibold text-on-surface-variant/70">Username</th>
                      <th class="px-5 py-3 text-xs font-semibold text-on-surface-variant/70">Display Name</th>
                      <th class="px-5 py-3 text-xs font-semibold text-on-surface-variant/70">{m.lv_reason()}</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-outline-variant/5">
                    {#each importResults.failedMembers as failed}
                      <tr class="text-xs font-semibold hover:bg-surface-hover/20 transition-all">
                        <td class="px-5 py-3 font-mono text-on-surface">{failed.username || '-'}</td>
                        <td class="px-5 py-3 text-on-surface">{failed.display_name || '-'}</td>
                        <td class="px-5 py-3 text-error font-medium">{failed.reason}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            </section>
          {/if}
        </div>

        <!-- Format Attendu & Résumé (1/3 de large) -->
        <div class="space-y-6">
          <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
            <h3 class="text-lg font-semibold flex items-center gap-3">
              <Papicon icon="Info" size={18} class="text-primary" />
              {m.lv_expected_format()}
            </h3>
            
            <p class="text-xs text-on-surface-variant/85 leading-relaxed font-medium">
              {m.lv_format_1()}<code>username</code>{m.lv_format_2()}<code>display_name</code>{m.lv_format_3()}<code>level</code>{m.lv_format_4()}<code>xp</code>{m.lv_format_5()}
            </p>

            <div class="relative bg-surface-container-high/60 border border-outline-variant/5 p-4 rounded-lg">
              <pre class="text-2xs font-mono text-on-surface-variant/90 overflow-x-auto leading-relaxed">{`[
  {
    "username": "@klaynight",
    "display_name": "Klaynight",
    "level": 48,
    "xp": 119652
  },
  {
    "username": "@nathan_nrg4",
    "display_name": "SailingTeam4",
    "level": 44,
    "xp": 99301
  }
]`}</pre>
            </div>

            <div class="space-y-2.5 pt-2 border-t border-outline-variant/10">
              <h4 class="text-xs font-semibold text-on-surface-variant/50">{m.lv_conversion_rules()}</h4>
              <ul class="list-disc list-inside text-2xs text-on-surface-variant/80 space-y-1 font-medium">
                <li>{m.lv_rule_1_a()}<strong>XP</strong>{m.lv_rule_1_b()}</li>
                <li>{m.lv_rule_2_a()}<strong>{m.lv_rule_2_strong()}</strong>{m.lv_rule_2_b()}</li>
                <li>{m.lv_rule_3()}</li>
              </ul>
            </div>
          </section>

          <!-- Carte de résumé rapide des résultats d'importation -->
          {#if importResults}
            <section class="bg-linear-to-b from-secondary/15 to-transparent border border-secondary/20 p-8 rounded-xl space-y-4">
              <h3 class="text-base font-semibold flex items-center gap-2 text-secondary">
                <Papicon icon="Check" size={18} />
                {importResults.dryRun ? m.lv_import_result_dry_run() : m.lv_import_result()}
              </h3>

              <div class="grid grid-cols-2 gap-4">
                <div class="bg-surface-container-low/50 border border-outline-variant/10 rounded-lg p-4 text-center">
                  <p class="text-2xl font-semibold text-success">{importResults.importedCount}</p>
                  <p class="text-xs font-semibold text-on-surface-variant/60">
                    {importResults.dryRun ? m.lv_import_matched() : m.lv_success()}
                  </p>
                </div>
                <div class="bg-surface-container-low/50 border border-outline-variant/10 rounded-lg p-4 text-center">
                  <p class="text-2xl font-semibold {importResults.failedCount > 0 ? 'text-error' : 'text-on-surface-variant/40'}">{importResults.failedCount}</p>
                  <p class="text-xs font-semibold text-on-surface-variant/60">{m.lv_failures()}</p>
                </div>
              </div>

              {#if importResults.levelChangeCount !== undefined}
                <dl class="text-2xs text-on-surface-variant/70 space-y-1">
                  <div class="flex justify-between gap-4">
                    <dt>{m.lv_import_stat_created()}</dt>
                    <dd class="font-semibold text-on-surface">{importResults.createdCount?.toLocaleString()}</dd>
                  </div>
                  <div class="flex justify-between gap-4">
                    <dt>{m.lv_import_stat_level_changes()}</dt>
                    <dd class="font-semibold text-on-surface">{importResults.levelChangeCount.toLocaleString()}</dd>
                  </div>
                  <div class="flex justify-between gap-4">
                    <dt>{m.lv_import_stat_xp_lowered()}</dt>
                    <dd class="font-semibold {importResults.xpLoweredCount ? 'text-warning' : 'text-on-surface'}">{importResults.xpLoweredCount?.toLocaleString()}</dd>
                  </div>
                </dl>
              {/if}

              {#if importResults.dryRun}
                <p class="p-3 bg-warning/10 border border-warning/20 rounded-lg text-2xs text-warning leading-relaxed">
                  {m.lv_import_dry_run_notice()}
                </p>
              {/if}
            </section>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</ModulePage>
