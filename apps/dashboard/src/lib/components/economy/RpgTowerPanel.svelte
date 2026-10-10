<script lang="ts">
  /** La Tour (mode roguelite du RPG) et la Tour de clan, dans une coque façon Analytics. */
  import { onMount } from 'svelte';
  import { m } from '../../i18n';
  import { channelDisplayName } from '../../channelUtils';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import { authStore } from '../../stores/auth.svelte';
  import { createAsyncActionState } from '../../asyncAction.svelte';
  import {
    deleteRpgTowerReward,
    fetchRpgClanTower,
    fetchRpgItems,
    fetchRpgTitles,
    fetchRpgTower,
    resetRpgTower,
    saveRpgClanTowerSettings,
    saveRpgTowerReward,
    saveRpgTowerSettings,
    simulateRpgTower,
    startRpgTowerSeason,
    type RpgTowerSimResult,
  } from '../../api';
  import Papicon from '../Papicon.svelte';
  import EmojiPicker from '../EmojiPicker.svelte';
  import EmojiText from '../EmojiText.svelte';
  import InlineFeedback from '../InlineFeedback.svelte';
  import HintTip from './HintTip.svelte';
  import SearchableSelect from '../SearchableSelect.svelte';
  import { Button, Callout, SectionCard, Tabs, ToggleSwitch } from '../ui';
  import RpgTowerMapEditor from './RpgTowerMapEditor.svelte';
  import RpgClanTowerPanel, { CLAN_DEFAULTS, type ClanSettings, type ClanWeek, type ClanAward } from './RpgClanTowerPanel.svelte';

  const { canManage = false, disabled = false, currencyName = '' }: { canManage?: boolean; disabled?: boolean; currencyName?: string } = $props();

  type EntryMode = 'COMPRESSED' | 'RESET';
  type OfferKind = 'POTION' | 'HEAL' | 'GEAR';
  type UpgradeEffect = 'POTION' | 'HEALTH' | 'ATTACK' | 'DEFENSE' | 'SPEED' | 'CRIT' | 'GOLD' | 'FORTUNE';
  type Upgrade = {
    id: string;
    enabled: boolean;
    name: string;
    emoji: string;
    description: string;
    effect: UpgradeEffect;
    perLevel: number;
    maxLevel: number;
    baseCost: number;
    costGrowthPercent: number;
  };
  type Merchant = {
    offers: OfferKind[];
    potionPrice: number;
    potionPricePerFloor: number;
    healPrice: number;
    healPricePerFloor: number;
    healPercent: number;
    gearPrice: number;
    gearPricePerFloor: number;
    potionHealPercent: number;
  };
  type Settings = {
    enabled: boolean;
    name: string;
    emoji: string;
    description: string;
    entryMode: EntryMode;
    inheritCapPercent: number;
    titleCapPercent: number;
    floorGrowthPercent: number;
    bossEvery: number;
    blessingEvery: number;
    maxBlessings: number;
    shardsPerFloor: number;
    shardsPerRoom: number;
    deathShardPercent: number;
    leaveShardPercent: number;
    skillPrice: number;
    weeklyShardCap: number;
    idleTimeoutMinutes: number;
    currencyName: string;
    currencyEmoji: string;
    upgrades: Upgrade[];
    merchant: Merchant;
    floorsAfter: 'GENERATE' | 'LOOP';
    generatedFog: boolean;
    dailyEnabled: boolean;
    announceChannelId: string | null;
    seasonStartedAt?: string;
    floors?: any[];
  };
  type Reward = {
    id: string;
    kind: 'SHOP' | 'MILESTONE';
    name: string;
    description: string;
    emoji: string;
    price: number;
    floor: number;
    repeatable: boolean;
    titleId: string | null;
    roleId: string | null;
    coins: number;
    xp: number;
    clanPoints: number;
    itemName: string | null;
    shards: number;
    stat: RewardStat | null;
    statAmount: number;
    maxEnergy: number;
    reclassVouchers: number;
    maxPurchases: number;
    limitPeriod: LimitPeriod;
    enabled: boolean;
  };
  type LimitPeriod = 'NEVER' | 'DAILY' | 'WEEKLY';
  type RewardStat = 'POINTS' | 'ATTACK' | 'DEFENSE' | 'SPEED' | 'HEALTH' | 'RANDOM';
  type RewardDraft = Omit<Reward, 'id'> & { id?: string };
  type NumericSetting = { [K in keyof Settings]-?: Settings[K] extends number ? K : never }[keyof Settings];
  type NumericMerchant = { [K in keyof Merchant]-?: Merchant[K] extends number ? K : never }[keyof Merchant];
  type LeaderboardEntry = { userId: string; displayName: string; avatarUrl?: string | null; bestFloor: number; bestRooms?: number; totalRuns: number };
  type DailyEntry = { userId: string; displayName: string; avatarUrl?: string | null; floorsCleared: number; roomsExplored: number; status: string };
  type Insights = {
    finishedRuns: number;
    averageFloor: number;
    deathRate: number;
    topKillers: { name: string; deaths: number }[];
    deadliestFloor: { floor: number; variant?: string; label?: string; name?: string; deaths: number } | null;
    cards?: CardStats[];
  };
  type CardStats = { index: number; floor: number; variant: string; chance?: number; name: string; arrivals: number; cleared: number; deaths: number; left?: number };
  type Mode = 'solo' | 'clan';
  type View = 'overview' | 'board' | 'rules' | 'rewards' | 'map' | 'lab';
  type RewardsTab = 'upgrades' | 'shop' | 'milestones' | 'merchant';
  type AdvancedField = { id: string; label: string; hint: string; key: NumericSetting; min: number; max: number };

  // Mêmes valeurs que `rpgTowerPolicy.ts` côté bot.
  const UPGRADE_EFFECTS: UpgradeEffect[] = ['POTION', 'HEALTH', 'ATTACK', 'DEFENSE', 'SPEED', 'CRIT', 'GOLD', 'FORTUNE'];
  const UPGRADE_ICON: Record<UpgradeEffect, string> = {
    POTION: 'FlaskConical', HEALTH: 'heart', ATTACK: 'Swords', DEFENSE: 'shield', SPEED: 'walk', CRIT: 'Target', GOLD: 'piggy-bank', FORTUNE: 'sparkles',
  };
  const PER_LEVEL_MAX: Record<UpgradeEffect, number> = { POTION: 5, HEALTH: 100, ATTACK: 100, DEFENSE: 100, SPEED: 100, CRIT: 20, GOLD: 10000, FORTUNE: 10 };
  const UPGRADES_MAX = 10;
  const OFFERS: OfferKind[] = ['POTION', 'HEAL', 'GEAR'];
  const OFFER_ICON: Record<OfferKind, string> = { POTION: 'FlaskConical', HEAL: 'heart', GEAR: 'Swords' };
  const MERCHANT_DEFAULTS: Merchant = {
    offers: [...OFFERS],
    potionPrice: 20,
    potionPricePerFloor: 2,
    healPrice: 25,
    healPricePerFloor: 3,
    healPercent: 40,
    gearPrice: 40,
    gearPricePerFloor: 5,
    potionHealPercent: 35,
  };

  function defaultUpgrades(): Upgrade[] {
    return [
      { id: 'potion', enabled: true, name: '', emoji: '', description: '', effect: 'POTION', perLevel: 1, maxLevel: 3, baseCost: 25, costGrowthPercent: 100 },
      { id: 'vigor', enabled: true, name: '', emoji: '', description: '', effect: 'HEALTH', perLevel: 5, maxLevel: 5, baseCost: 40, costGrowthPercent: 100 },
    ];
  }

  const DEFAULTS: Settings = {
    enabled: false,
    name: 'La Tour',
    emoji: '',
    description: '',
    entryMode: 'COMPRESSED',
    inheritCapPercent: 50,
    titleCapPercent: 30,
    floorGrowthPercent: 8,
    bossEvery: 10,
    blessingEvery: 5,
    maxBlessings: 6,
    shardsPerFloor: 10,
    shardsPerRoom: 0,
    deathShardPercent: 50,
    leaveShardPercent: 80,
    skillPrice: 10,
    weeklyShardCap: 0,
    idleTimeoutMinutes: 30,
    currencyName: 'Éclats de Tour',
    currencyEmoji: '',
    upgrades: defaultUpgrades(),
    merchant: { ...MERCHANT_DEFAULTS, offers: [...OFFERS] },
    floorsAfter: 'GENERATE',
    generatedFog: true,
    dailyEnabled: true,
    announceChannelId: null,
  };

  const BASE_ATTACK = 20;
  const INHERIT_SLOPE = 0.2;
  const MONSTER_BASE_HEALTH = 70;
  const MONSTER_BASE_ATTACK = 13;
  // Au-delà de cet étage, la croissance des monstres est divisée par deux (miroir du bot).
  const GROWTH_KNEE = 25;

  const actionState = createAsyncActionState();
  let loading = $state(true);
  let mode = $state<Mode>('solo');
  let view = $state<View>('overview');
  let rewardsTab = $state<RewardsTab>('upgrades');
  let boardTab = $state<'season' | 'daily'>('season');
  let settings = $state<Settings>({ ...DEFAULTS });
  let savedSettings = $state('');
  let rewards = $state<Reward[]>([]);
  let leaderboard = $state<LeaderboardEntry[]>([]);
  let stats = $state({ players: 0, runs: 0, activeRuns: 0, bestFloor: 0 });
  let limits = $state<{ rewardsMax: number; mapSize?: { min: number; max: number }; mapRoomsMax?: number; floorsMax?: number }>({ rewardsMax: 40 });
  let resetMilestones = $state(true);
  let insights = $state<Insights | null>(null);
  let dailyBoard = $state<DailyEntry[]>([]);
  let foes = $state<{ name: string; emoji: string; isBoss: boolean; enabled: boolean }[]>([]);
  let deathMap = $state<Record<string, Record<string, number>>>({});
  let mapVersion = $state(0);
  let titles = $state<{ id: string; name: string }[]>([]);
  let items = $state<{ name: string; emoji: string; guildId: string | null }[]>([]);
  let editing = $state<RewardDraft | null>(null);
  let selectedUpgradeId = $state<string | null>(null);
  let showAllRules = $state(false);
  let openAdvanced = $state<Record<string, boolean>>({});
  let showCards = $state(false);

  let clan = $state<ClanSettings>(CLAN_DEFAULTS());
  let savedClan = $state('');
  let clanLoaded = $state(false);
  let clansEnabled = $state(true);
  let clanCurrent = $state<ClanWeek | null>(null);
  let clanLast = $state<{ endsAt: string; results: { awards?: ClanAward[] } | null } | null>(null);
  let clanNextOpensAt = $state<string | null>(null);
  let clanMapVersion = $state(0);

  const channels = $derived(((dashboardStore.state.discordChannels ?? []) as any[]).map((channel) => ({ id: channel.id, name: channelDisplayName(channel) })));
  const roles = $derived((dashboardStore.state.discordRoles || []).map((role: any) => ({ id: role.id, name: `@${role.name}` })));
  const titleOptions = $derived(titles.map((title) => ({ id: title.id, name: title.name })));
  const itemOptions = $derived.by(() => {
    const byName = new Map<string, { name: string; emoji: string; guildId: string | null }>();
    for (const item of items) {
      if (!byName.has(item.name) || item.guildId) byName.set(item.name, item);
    }
    return [...byName.values()].map((item) => ({ id: item.name, name: `${item.emoji} ${item.name}` }));
  });
  const shopRewards = $derived(rewards.filter((reward) => reward.kind === 'SHOP'));
  const milestones = $derived(rewards.filter((reward) => reward.kind === 'MILESTONE').sort((a, b) => a.floor - b.floor));
  const topFloor = $derived(Math.max(1, leaderboard[0]?.bestFloor ?? 1));
  const selectedUpgradeIndex = $derived(settings.upgrades.findIndex((upgrade) => upgrade.id === selectedUpgradeId));

  const soloChanges = $derived(countChanges(settingsPayload(settings), savedSettings));
  const clanChanges = $derived(clanLoaded ? countChanges(clanPayload(clan), savedClan) : 0);
  const pendingChanges = $derived(soloChanges + clanChanges);
  const clanAvailable = $derived(clanLoaded && clan.enabled);
  const headerEnabled = $derived(mode === 'clan' ? clan.enabled : settings.enabled);

  const navGroups = $derived([
    { label: m.eco_tower_nav_follow(), items: [
      { id: 'overview' as View, label: m.eco_tower_nav_overview(), icon: 'grid' },
      { id: 'board' as View, label: m.eco_tower_tab_leaderboard(), icon: 'crown' },
    ] },
    { label: m.eco_tower_nav_configure(), items: [
      { id: 'rules' as View, label: m.eco_tower_nav_rules(), icon: 'settings' },
      { id: 'rewards' as View, label: m.eco_tower_nav_rewards(), icon: 'star', count: mode === 'solo' ? settings.upgrades.length + rewards.length : undefined },
      { id: 'map' as View, label: m.eco_tower_tab_map(), icon: 'map-pin', count: mode === 'solo' ? settings.floors?.length || undefined : clan.floors?.length || undefined },
    ] },
    ...(mode === 'solo'
      ? [{ label: m.eco_tower_nav_test(), items: [{ id: 'lab' as View, label: m.eco_tower_tab_simulation(), icon: 'coefficient' }] }]
      : []),
  ]);
  const navItems = $derived(navGroups.flatMap((group) => group.items));

  const rewardTabs = $derived([
    { id: 'upgrades', label: m.eco_tower_tab_upgrades(), icon: 'arrow-up-box', badge: settings.upgrades.length || undefined },
    { id: 'shop', label: m.eco_tower_tab_shop(), icon: 'card', badge: shopRewards.length || undefined },
    { id: 'milestones', label: m.eco_tower_tab_milestones(), icon: 'bookmark', badge: milestones.length || undefined },
    { id: 'merchant', label: m.eco_tower_tab_merchant(), icon: 'piggy-bank' },
  ]);

  $effect(() => {
    if (mode === 'clan' && (!clanAvailable || view === 'lab')) {
      if (!clanAvailable) mode = 'solo';
      else view = 'overview';
    }
  });

  // Tour et section affichées, retrouvées au prochain passage sur ce serveur.
  const VIEWS: View[] = ['overview', 'board', 'rules', 'rewards', 'map', 'lab'];
  const navKey = `kotbo_tower_nav_${authStore.selectedGuildId ?? ''}`;
  let restoreClan = false;

  function restoreNav() {
    try {
      const saved = JSON.parse(localStorage.getItem(navKey) ?? 'null') as { mode?: Mode; view?: View } | null;
      if (saved?.view && VIEWS.includes(saved.view)) view = saved.view;
      restoreClan = saved?.mode === 'clan';
    } catch {
      // Stockage indisponible ou valeur illisible : on garde la vue par défaut.
    }
  }

  restoreNav();

  $effect(() => {
    const value = JSON.stringify({ mode, view });
    try {
      localStorage.setItem(navKey, value);
    } catch {
      // Stockage indisponible : la navigation n'est simplement pas retenue.
    }
  });

  const SIM_CLASSES = [
    { id: 'WARRIOR', label: () => m.eco_tower_sim_class_warrior() },
    { id: 'RANGER', label: () => m.eco_tower_sim_class_ranger() },
    { id: 'MAGE', label: () => m.eco_tower_sim_class_mage() },
  ];
  // Mêmes malédictions et dans le même ordre que `TOWER_HEATS` côté bot.
  const SIM_HEATS = [
    { label: () => m.eco_tower_sim_heat_ferocious() },
    { label: () => m.eco_tower_sim_heat_famine() },
    { label: () => m.eco_tower_sim_heat_greed() },
    { label: () => m.eco_tower_sim_heat_dry() },
  ];
  let simClass = $state('WARRIOR');
  let simRuns = $state(50);
  let simSkills = $state(false);
  let simHeat = $state(0);
  let simLoading = $state(false);
  let simResult = $state<RpgTowerSimResult | null>(null);
  let simError = $state<string | null>(null);
  const simDeathsMax = $derived(Math.max(1, ...(simResult?.deathsByFloor ?? []).map((entry) => entry.deaths)));

  async function runSimulation() {
    simLoading = true;
    simError = null;
    try {
      simResult = await simulateRpgTower({ className: simClass, runs: simRuns, skills: simSkills, heatMask: simHeat });
    } catch (err) {
      simError = err instanceof Error && err.message ? err.message : m.eco_tower_sim_failed();
    } finally {
      simLoading = false;
    }
  }

  function towerAttack(mainAttack: number): number {
    const inherited = settings.entryMode === 'COMPRESSED'
      ? Math.min(settings.inheritCapPercent / 100, INHERIT_SLOPE * Math.log10(1 + mainAttack / BASE_ATTACK))
      : 0;
    return Math.round(BASE_ATTACK * (1 + inherited));
  }

  const entryPreview = $derived([20, 2_000, 200_000, 20_000_000].map((main) => ({ main, tower: towerAttack(main) })));
  const floorPreview = $derived([1, 10, 25, 50].map((floor) => {
    const rate = (Number(settings.floorGrowthPercent) || 0) / 100;
    const steep = Math.min(floor - 1, GROWTH_KNEE - 1);
    const growth = Math.pow(1 + rate, steep) * Math.pow(1 + rate / 2, floor - 1 - steep);
    return { floor, health: Math.round(MONSTER_BASE_HEALTH * growth), attack: Math.round(MONSTER_BASE_ATTACK * growth) };
  }));
  const veteranRatio = $derived((towerAttack(20_000_000) / towerAttack(20)).toFixed(2));

  function merchantPrice(base: number, perFloor: number, floor: number): number {
    return Math.max(1, Math.round((Number(base) || 0) + floor * (Number(perFloor) || 0)));
  }

  const merchantPreview = $derived([1, 10, 25, 50].map((floor) => ({
    floor,
    potion: merchantPrice(settings.merchant.potionPrice, settings.merchant.potionPricePerFloor, floor),
    heal: merchantPrice(settings.merchant.healPrice, settings.merchant.healPricePerFloor, floor),
    gear: merchantPrice(settings.merchant.gearPrice, settings.merchant.gearPricePerFloor, floor),
  })));

  function upgradeCost(upgrade: Upgrade, level: number): number {
    return Math.round((Number(upgrade.baseCost) || 0) * Math.pow(1 + (Number(upgrade.costGrowthPercent) || 0) / 100, level));
  }

  function upgradeCosts(upgrade: Upgrade): string {
    const levels = Math.min(Math.max(1, Number(upgrade.maxLevel) || 1), 6);
    const costs = Array.from({ length: levels }, (_, level) => upgradeCost(upgrade, level).toLocaleString());
    return `${costs.join(' · ')}${(Number(upgrade.maxLevel) || 1) > levels ? ' …' : ''}`;
  }

  function upgradeCostRange(upgrade: Upgrade): string {
    const last = Math.max(0, (Number(upgrade.maxLevel) || 1) - 1);
    const first = upgradeCost(upgrade, 0);
    return last === 0 ? first.toLocaleString() : `${first.toLocaleString()} → ${upgradeCost(upgrade, last).toLocaleString()}`;
  }

  function effectLabel(effect: UpgradeEffect): string {
    switch (effect) {
      case 'POTION': return m.eco_tower_upgrade_effect_POTION();
      case 'HEALTH': return m.eco_tower_upgrade_effect_HEALTH();
      case 'ATTACK': return m.eco_tower_upgrade_effect_ATTACK();
      case 'DEFENSE': return m.eco_tower_upgrade_effect_DEFENSE();
      case 'SPEED': return m.eco_tower_upgrade_effect_SPEED();
      case 'CRIT': return m.eco_tower_upgrade_effect_CRIT();
      case 'FORTUNE': return m.eco_tower_upgrade_effect_FORTUNE();
      default: return m.eco_tower_upgrade_effect_GOLD();
    }
  }

  function effectUnit(effect: UpgradeEffect): string {
    switch (effect) {
      case 'POTION': return m.eco_tower_upgrade_unit_POTION();
      case 'HEALTH': return m.eco_tower_upgrade_unit_HEALTH();
      case 'ATTACK': return m.eco_tower_upgrade_unit_ATTACK();
      case 'DEFENSE': return m.eco_tower_upgrade_unit_DEFENSE();
      case 'SPEED': return m.eco_tower_upgrade_unit_SPEED();
      case 'CRIT': return m.eco_tower_upgrade_unit_CRIT();
      case 'FORTUNE': return m.eco_tower_upgrade_unit_FORTUNE();
      default: return m.eco_tower_upgrade_unit_GOLD();
    }
  }

  function offerLabel(offer: OfferKind): string {
    if (offer === 'POTION') return m.eco_tower_merchant_potion();
    if (offer === 'HEAL') return m.eco_tower_merchant_heal();
    return m.eco_tower_merchant_gear();
  }

  function offerTip(offer: OfferKind): string {
    if (offer === 'POTION') return m.eco_tower_merchant_potion_tip();
    if (offer === 'HEAL') return m.eco_tower_merchant_heal_tip();
    return m.eco_tower_merchant_gear_tip();
  }

  function roleName(roleId: string | null): string | null {
    return roleId ? roles.find((role) => role.id === roleId)?.name ?? roleId : null;
  }

  function titleName(titleId: string | null): string | null {
    return titleId ? titles.find((title) => title.id === titleId)?.name ?? titleId : null;
  }

  // La carte et la saison s'enregistrent à part : elles ne comptent pas comme modifications.
  function settingsPayload(value: Settings): Record<string, unknown> {
    const payload: Record<string, unknown> = { ...$state.snapshot(value) };
    delete payload.seasonStartedAt;
    delete payload.floors;
    return payload;
  }

  function clanPayload(value: ClanSettings): Record<string, unknown> {
    const payload: Record<string, unknown> = { ...$state.snapshot(value) };
    delete payload.floors;
    return payload;
  }

  function countChanges(current: Record<string, unknown>, saved: string): number {
    if (!saved) return 0;
    const before = JSON.parse(saved) as Record<string, unknown>;
    return Object.keys(current).filter((key) => JSON.stringify(current[key]) !== JSON.stringify(before[key])).length;
  }

  function discardChanges() {
    if (savedSettings) settings = { ...settings, ...JSON.parse(savedSettings) };
    if (savedClan) clan = { ...clan, ...JSON.parse(savedClan) };
  }

  // Recharger après une récompense ou un étage garde les réglages en cours d'édition.
  async function load() {
    const edits = soloChanges > 0 ? settingsPayload(settings) : null;
    try {
      const res = await fetchRpgTower();
      if (res) {
        const loaded = res.settings ?? {};
        const fresh: Settings = {
          ...DEFAULTS,
          ...loaded,
          upgrades: Array.isArray(loaded.upgrades) ? loaded.upgrades : defaultUpgrades(),
          merchant: { ...MERCHANT_DEFAULTS, ...(loaded.merchant ?? {}) },
        };
        savedSettings = JSON.stringify(settingsPayload(fresh));
        settings = edits ? { ...fresh, ...edits } as Settings : fresh;
        rewards = res.rewards ?? [];
        leaderboard = res.leaderboard ?? [];
        if (res.stats) stats = res.stats;
        if (res.limits) limits = res.limits;
        foes = res.foes ?? [];
        deathMap = res.deathMap ?? {};
        insights = res.insights ?? null;
        dailyBoard = res.daily?.leaderboard ?? [];
        mapVersion += 1;
      }
    } catch (err) {
      console.error(err);
    } finally {
      loading = false;
    }
  }

  async function loadClan() {
    const edits = clanChanges > 0 ? clanPayload(clan) : null;
    try {
      const res = await fetchRpgClanTower();
      if (res) {
        const base = CLAN_DEFAULTS();
        const loaded = res.settings ?? {};
        const fresh: ClanSettings = {
          ...base,
          ...loaded,
          podiumPoints: [...(loaded.podiumPoints ?? base.podiumPoints)],
          milestones: [...(loaded.milestones ?? base.milestones)],
        };
        savedClan = JSON.stringify(clanPayload(fresh));
        clan = edits ? { ...fresh, ...edits } as ClanSettings : fresh;
        clansEnabled = res.clansEnabled !== false;
        clanCurrent = res.current ?? null;
        clanLast = res.last ?? null;
        clanNextOpensAt = res.nextOpensAt ?? null;
        clanLoaded = true;
        clanMapVersion += 1;
        if (restoreClan && fresh.enabled) mode = 'clan';
        restoreClan = false;
      }
    } catch (err) {
      console.error(err);
    }
  }

  onMount(() => {
    void load();
    void loadClan();
    void fetchRpgTitles().then((res) => { if (res?.titles) titles = res.titles; }).catch(console.error);
    void fetchRpgItems().then((res) => { if (res?.items) items = res.items; }).catch(console.error);
  });

  async function saveAll() {
    await actionState.run(async () => {
      if (soloChanges > 0) {
        const payload = settingsPayload(settings);
        payload.upgrades = settings.upgrades.map((upgrade) => ({
          ...upgrade,
          perLevel: Number(upgrade.perLevel) || 1,
          maxLevel: Number(upgrade.maxLevel) || 1,
          baseCost: Number(upgrade.baseCost) || 1,
          costGrowthPercent: Number(upgrade.costGrowthPercent) || 0,
        }));
        await saveRpgTowerSettings(payload);
        savedSettings = '';
        await load();
      }
      if (clanChanges > 0) {
        const payload = clanPayload(clan);
        payload.podiumPoints = clan.podiumPoints.map((value) => Number(value) || 0);
        payload.milestones = clan.milestones.map((value) => Number(value) || 0);
        await saveRpgClanTowerSettings(payload);
        savedClan = '';
        await loadClan();
      }
      return true;
    });
  }

  function toggleHeader(value: boolean) {
    if (mode === 'clan') clan.enabled = value;
    else settings.enabled = value;
  }

  function go(target: View) {
    view = target;
  }

  function addUpgrade() {
    if (settings.upgrades.length >= UPGRADES_MAX) return;
    const id = `u${Date.now().toString(36)}`;
    settings.upgrades = [...settings.upgrades, {
      id, enabled: true, name: '', emoji: '', description: '', effect: 'ATTACK', perLevel: 5, maxLevel: 3, baseCost: 50, costGrowthPercent: 100,
    }];
    selectedUpgradeId = id;
  }

  async function removeUpgrade(upgrade: Upgrade) {
    const confirmed = await confirmDialog.danger(
      m.eco_tower_upgrade_delete_confirm({ name: upgrade.name || effectLabel(upgrade.effect) }),
      m.eco_tower_upgrade_delete_confirm_desc(),
    );
    if (!confirmed) return;
    settings.upgrades = settings.upgrades.filter((candidate) => candidate.id !== upgrade.id);
    selectedUpgradeId = null;
  }

  function toggleOffer(offer: OfferKind) {
    const current = settings.merchant.offers;
    const next = current.includes(offer) ? current.filter((entry) => entry !== offer) : OFFERS.filter((entry) => entry === offer || current.includes(entry));
    if (next.length > 0) settings.merchant.offers = next;
  }

  function openNew(kind: 'SHOP' | 'MILESTONE') {
    editing = {
      kind,
      name: '',
      description: '',
      emoji: '',
      price: 100,
      floor: 10,
      repeatable: false,
      titleId: null,
      roleId: null,
      coins: 0,
      xp: 0,
      clanPoints: 0,
      itemName: null,
      shards: 0,
      stat: null,
      statAmount: 1,
      maxEnergy: 0,
      reclassVouchers: 0,
      maxPurchases: 0,
      limitPeriod: 'NEVER',
      enabled: true,
    };
  }

  function openEdit(reward: Reward) {
    editing = {
      ...reward,
      stat: reward.stat ?? null,
      statAmount: reward.statAmount || 1,
      maxEnergy: reward.maxEnergy ?? 0,
      reclassVouchers: reward.reclassVouchers ?? 0,
      maxPurchases: reward.maxPurchases ?? 0,
      limitPeriod: reward.limitPeriod ?? 'NEVER',
    };
  }

  function pickRewardsTab(id: string) {
    rewardsTab = id as RewardsTab;
    editing = null;
  }

  const LIMIT_PERIODS: LimitPeriod[] = ['NEVER', 'DAILY', 'WEEKLY'];

  function limitPeriodLabel(period: LimitPeriod): string {
    if (period === 'DAILY') return m.eco_tower_limit_daily();
    if (period === 'WEEKLY') return m.eco_tower_limit_weekly();
    return m.eco_tower_limit_never();
  }

  function limitBadge(reward: Reward): string {
    if (reward.limitPeriod === 'DAILY') return m.eco_tower_reward_max_purchases_daily({ max: reward.maxPurchases });
    if (reward.limitPeriod === 'WEEKLY') return m.eco_tower_reward_max_purchases_weekly({ max: reward.maxPurchases });
    return m.eco_tower_reward_max_purchases({ max: reward.maxPurchases });
  }

  const REWARD_STATS: RewardStat[] = ['POINTS', 'ATTACK', 'DEFENSE', 'SPEED', 'HEALTH', 'RANDOM'];

  function statLabel(stat: RewardStat): string {
    switch (stat) {
      case 'POINTS': return m.eco_tower_stat_points();
      case 'ATTACK': return m.eco_tower_stat_attack();
      case 'DEFENSE': return m.eco_tower_stat_defense();
      case 'SPEED': return m.eco_tower_stat_speed();
      case 'HEALTH': return m.eco_tower_stat_health();
      case 'RANDOM': return m.eco_tower_stat_random();
    }
  }

  function statBadge(reward: Reward): string {
    if (!reward.stat) return '';
    if (reward.stat === 'POINTS') return m.eco_tower_reward_stat_points({ amount: reward.statAmount });
    if (reward.stat === 'RANDOM') return m.eco_tower_reward_stat_random({ amount: reward.statAmount });
    // Un point de vitalité vaut 8 PV max, comme à la répartition des points dans le RPG.
    const amount = reward.stat === 'HEALTH' ? reward.statAmount * 8 : reward.statAmount;
    return m.eco_tower_reward_stat({ amount, stat: statLabel(reward.stat) });
  }

  async function saveReward() {
    if (!editing) return;
    const draft = editing;
    await actionState.run(async () => {
      await saveRpgTowerReward({
        ...draft,
        price: Number(draft.price) || 0,
        floor: Number(draft.floor) || 0,
        coins: Number(draft.coins) || 0,
        xp: Number(draft.xp) || 0,
        clanPoints: Number(draft.clanPoints) || 0,
        itemName: draft.itemName || null,
        shards: Number(draft.shards) || 0,
        stat: draft.stat || null,
        statAmount: Number(draft.statAmount) || 1,
        maxEnergy: Number(draft.maxEnergy) || 0,
        reclassVouchers: Number(draft.reclassVouchers) || 0,
        maxPurchases: Number(draft.maxPurchases) || 0,
        limitPeriod: draft.limitPeriod || 'NEVER',
        titleId: draft.titleId || null,
        roleId: draft.roleId || null,
      });
      editing = null;
      await load();
      return true;
    });
  }

  async function removeReward(reward: RewardDraft) {
    if (!reward.id) return;
    const id = reward.id;
    const confirmed = await confirmDialog.danger(m.eco_tower_reward_delete_confirm({ name: reward.name }), m.eco_tower_reward_delete_confirm_desc());
    if (!confirmed) return;
    await actionState.run(async () => {
      await deleteRpgTowerReward(id);
      editing = null;
      await load();
      return true;
    });
  }

  async function resetTower(everything: boolean) {
    const confirmed = await confirmDialog.danger(
      everything ? m.eco_tower_reset_all_confirm() : m.eco_tower_reset_players_confirm(),
      everything ? m.eco_tower_reset_all_confirm_desc() : m.eco_tower_reset_players_confirm_desc(),
      m.eco_tower_reset_confirm_btn(),
    );
    if (!confirmed) return;
    await actionState.run(async () => {
      await resetRpgTower({ everything });
      await load();
      return true;
    });
  }

  async function newSeason() {
    const confirmed = await confirmDialog.ask({
      title: m.eco_tower_season_confirm(),
      description: m.eco_tower_season_confirm_desc(),
      confirmLabel: m.eco_tower_season_btn(),
      variant: 'warning',
    });
    if (!confirmed) return;
    await actionState.run(async () => {
      await startRpgTowerSeason({ resetMilestones });
      await load();
      return true;
    });
  }

  const difficultyAdvanced = $derived<AdvancedField[]>([
    { id: 'towerMaxBlessings', label: m.eco_tower_field_max_blessings(), hint: m.eco_tower_field_max_blessings_hint(), key: 'maxBlessings', min: 1, max: 12 },
    { id: 'towerIdle', label: m.eco_tower_field_idle(), hint: m.eco_tower_field_idle_hint(), key: 'idleTimeoutMinutes', min: 5, max: 1440 },
  ]);
  const shardsAdvanced = $derived<AdvancedField[]>([
    { id: 'towerShardsRoom', label: m.eco_tower_field_shards_room(), hint: m.eco_tower_field_shards_room_hint(), key: 'shardsPerRoom', min: 0, max: 1000 },
    { id: 'towerLeave', label: m.eco_tower_field_leave(), hint: m.eco_tower_field_leave_hint(), key: 'leaveShardPercent', min: 0, max: 100 },
    { id: 'towerCap', label: m.eco_tower_field_cap(), hint: m.eco_tower_field_cap_hint(), key: 'weeklyShardCap', min: 0, max: 1000000 },
    { id: 'towerSkillPrice', label: m.eco_tower_field_skill_price(), hint: m.eco_tower_field_skill_price_hint(), key: 'skillPrice', min: 0, max: 1000 },
  ]);

  function isAdvancedOpen(section: string): boolean {
    return showAllRules || !!openAdvanced[section];
  }

  const inputClass = 'w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:border-primary disabled:opacity-60';
  const labelClass = 'text-xs font-semibold text-on-surface-variant flex items-center gap-1.5';
  const choiceClass = 'text-left p-3.5 rounded-xl border transition-colors disabled:cursor-not-allowed';
</script>

{#snippet hintIcon(hint: string)}
  {#if hint}<HintTip text={hint} />{/if}
{/snippet}

{#snippet numberField(id: string, label: string, hint: string, key: NumericSetting, min: number, max: number)}
  <div class="flex flex-col gap-1.5 min-w-0">
    <label for={id} class={labelClass}>{label} {@render hintIcon(hint)}</label>
    <input {id} type="number" {min} {max} bind:value={settings[key]} disabled={!canManage || disabled} class={inputClass} />
  </div>
{/snippet}

{#snippet merchantField(id: string, label: string, key: NumericMerchant, min: number, max: number, hint: string = '')}
  <div class="flex flex-col gap-1.5 min-w-0">
    <label for={id} class={labelClass}>{label} {@render hintIcon(hint)}</label>
    <input {id} type="number" {min} {max} bind:value={settings.merchant[key]} disabled={!canManage || disabled} class={inputClass} />
  </div>
{/snippet}

{#snippet advanced(section: string, fields: AdvancedField[])}
  {#if isAdvancedOpen(section)}
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      {#each fields as field (field.key)}
        {@render numberField(field.id, field.label, field.hint, field.key, field.min, field.max)}
      {/each}
    </div>
    {#if !showAllRules}
      <button type="button" class="self-start text-xs font-semibold text-primary flex items-center gap-1" onclick={() => { openAdvanced[section] = false; }}>
        <Papicon icon="chevron-up" size={12} /> {m.eco_tower_advanced_hide()}
      </button>
    {/if}
  {:else}
    <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-outline-variant bg-surface-container-low px-3 py-2.5 text-xs text-on-surface-variant">
      <span class="min-w-0">{fields.map((field) => `${field.label} : ${settings[field.key]}`).join(' · ')}</span>
      <button type="button" class="font-semibold text-primary flex items-center gap-1 whitespace-nowrap" onclick={() => { openAdvanced[section] = true; }}>
        <Papicon icon="chevron-down" size={12} /> {m.eco_tower_advanced_show({ count: fields.length })}
      </button>
    </div>
  {/if}
{/snippet}

{#snippet kpi(label: string, value: string | number, sub: string, icon: string, hint: string = '')}
  <div class="flex flex-col gap-1 min-w-0 rounded-xl border border-outline-variant bg-surface-container-low px-4 py-3.5" title={hint || undefined}>
    <span class="text-body-sm text-on-surface-variant flex items-center gap-1.5"><Papicon {icon} size={13} /> {label}</span>
    <span class="font-headline text-2xl font-semibold tabular-nums truncate">{value}</span>
    {#if sub}<span class="text-2xs text-on-surface-variant/80 truncate">{sub}</span>{/if}
  </div>
{/snippet}

{#snippet cardTable(cards: CardStats[], withLeft: boolean)}
  <div class="overflow-x-auto">
    <table class="w-full text-2xs">
      <thead>
        <tr class="text-left text-on-surface-variant">
          <th class="py-1 pr-3 font-semibold">{m.eco_tower_sim_card()}</th>
          <th class="py-1 px-2 font-semibold text-right">{m.eco_tower_sim_card_arrivals()}</th>
          <th class="py-1 px-2 font-semibold text-right">{m.eco_tower_sim_card_cleared()}</th>
          <th class="py-1 px-2 font-semibold text-right">{m.eco_tower_sim_card_deaths()}</th>
          {#if withLeft}<th class="py-1 px-2 font-semibold text-right">{m.eco_tower_card_left()}</th>{/if}
          <th class="py-1 pl-2 font-semibold w-1/3">{m.eco_tower_sim_card_death_rate()}</th>
        </tr>
      </thead>
      <tbody>
        {#each cards as card (card.index)}
          {@const rate = card.arrivals > 0 ? Math.round((card.deaths / card.arrivals) * 100) : 0}
          <tr class="border-t border-outline-variant">
            <td class="py-1.5 pr-3">
              <span class="font-mono font-semibold">{m.eco_tower_milestone_floor({ floor: card.variant ? `${card.floor}-${card.variant}` : card.floor })}</span>
              {#if card.variant && card.chance !== undefined}<span class="text-on-surface-variant"> ({card.chance} %)</span>{/if}
              {#if card.name}<span class="text-on-surface-variant"> · {card.name}</span>{/if}
            </td>
            <td class="py-1.5 px-2 text-right font-mono">{card.arrivals}</td>
            <td class="py-1.5 px-2 text-right font-mono">{card.cleared}</td>
            <td class="py-1.5 px-2 text-right font-mono">{card.deaths}</td>
            {#if withLeft}<td class="py-1.5 px-2 text-right font-mono">{card.left ?? 0}</td>{/if}
            <td class="py-1.5 pl-2">
              <div class="flex items-center gap-2">
                <div class="flex-1 h-2 rounded-full bg-surface-container overflow-hidden"><div class="h-full bg-error/70" style="width: {rate}%"></div></div>
                <span class="w-9 text-right font-mono">{card.arrivals > 0 ? `${rate} %` : '—'}</span>
              </div>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/snippet}

{#snippet shardIcon(size: number)}
  {#if settings.currencyEmoji}<EmojiText value={settings.currencyEmoji} />{:else}<Papicon icon="Diamond" {size} />{/if}
{/snippet}

{#snippet rewardPerks(reward: Reward)}
  <span class="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs">
    {#if reward.coins > 0}<span class="text-warning font-semibold flex items-center gap-1"><Papicon icon="piggy-bank" size={11} /> +{reward.coins} {currencyName}</span>{/if}
    {#if reward.xp > 0}<span class="text-primary font-semibold flex items-center gap-1"><Papicon icon="sparkles" size={11} /> +{reward.xp} {m.eco_dungeon_rpg_xp()}</span>{/if}
    {#if reward.clanPoints > 0}<span class="text-success font-semibold flex items-center gap-1"><Papicon icon="user" size={11} /> {m.eco_tower_reward_clan_points({ amount: reward.clanPoints })}</span>{/if}
    {#if reward.itemName}<span class="font-semibold flex items-center gap-1"><Papicon icon="grid" size={11} /> {reward.itemName}</span>{/if}
    {#if reward.stat}<span class="text-error font-semibold flex items-center gap-1"><Papicon icon="arrow-right-up" size={11} /> {statBadge(reward)}</span>{/if}
    {#if reward.maxEnergy > 0}<span class="text-warning font-semibold flex items-center gap-1"><Papicon icon="sparkles" size={11} /> {m.eco_tower_reward_max_energy({ amount: reward.maxEnergy.toLocaleString() })}</span>{/if}
    {#if reward.reclassVouchers > 0}<span class="text-primary font-semibold flex items-center gap-1"><Papicon icon="RefreshCw" size={11} /> {m.eco_tower_reward_reclass_vouchers({ count: reward.reclassVouchers })}</span>{/if}
    {#if reward.shards > 0}<span class="text-primary font-semibold flex items-center gap-1">+{reward.shards} {@render shardIcon(11)}</span>{/if}
    {#if reward.titleId}<span class="font-semibold text-warning flex items-center gap-1"><Papicon icon="star" size={11} /> {titleName(reward.titleId)}</span>{/if}
    {#if reward.roleId}<span class="font-semibold text-primary">{roleName(reward.roleId)}</span>{/if}
    {#if reward.repeatable}<span class="text-on-surface-variant">{m.eco_tower_reward_repeatable()}</span>{/if}
    {#if reward.repeatable && reward.maxPurchases > 0}<span class="text-on-surface-variant">{limitBadge(reward)}</span>{/if}
  </span>
{/snippet}

{#snippet rewardRow(reward: Reward)}
  {@const selected = editing?.id === reward.id}
  <button type="button" onclick={() => openEdit(reward)} aria-pressed={selected}
    class="w-full text-left grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 border-t border-outline-variant first:border-t-0 transition-colors {selected ? 'bg-primary/10' : 'hover:bg-surface-container-low'} {reward.enabled ? '' : 'opacity-60'}">
    <span class="w-8 h-8 rounded-lg bg-surface-container text-primary flex items-center justify-center">
      {#if reward.emoji}<EmojiText value={reward.emoji} />{:else}<Papicon icon={reward.kind === 'SHOP' ? 'card' : 'bookmark'} size={16} />{/if}
    </span>
    <span class="min-w-0 flex flex-col gap-0.5">
      <span class="text-sm font-semibold truncate">{reward.name}</span>
      {@render rewardPerks(reward)}
    </span>
    <span class="text-xs font-bold whitespace-nowrap flex items-center gap-1 {reward.kind === 'SHOP' ? 'text-primary' : 'text-warning'}">
      {#if reward.kind === 'SHOP'}{reward.price} {@render shardIcon(12)}{:else}{m.eco_tower_milestone_floor({ floor: reward.floor })}{/if}
    </span>
  </button>
{/snippet}

{#snippet rewardEditor(kind: 'SHOP' | 'MILESTONE')}
  {#if editing && editing.kind === kind}
    {@const draft = editing}
    <SectionCard
      title={kind === 'SHOP'
        ? (draft.id ? m.eco_tower_modal_edit_shop() : m.eco_tower_modal_new_shop())
        : (draft.id ? m.eco_tower_modal_edit_milestone() : m.eco_tower_modal_new_milestone())}
      icon={kind === 'SHOP' ? 'card' : 'bookmark'}
    >
      {#snippet actions()}
        <Button variant="ghost" size="sm" icon="cross" aria-label={m.eco_btn_cancel()} onclick={() => { editing = null; }} />
      {/snippet}
      <div class="flex flex-col gap-4">
        <div class="grid grid-cols-3 gap-3">
          <div class="col-span-2 flex flex-col gap-1.5">
            <label for="rewardName" class={labelClass}>{m.eco_tower_field_reward_name()}</label>
            <input id="rewardName" type="text" maxlength="50" bind:value={draft.name} disabled={!canManage} class={inputClass} />
          </div>
          <div class="flex flex-col gap-1.5">
            <label for="rewardEmoji" class={labelClass}>{m.eco_item_emoji()}</label>
            <div class="flex gap-2">
              <input id="rewardEmoji" type="text" bind:value={draft.emoji} disabled={!canManage} placeholder={m.eco_tower_emoji_default_hint()} class={inputClass} />
              {#if canManage}<EmojiPicker bind:value={draft.emoji} />{/if}
            </div>
          </div>
          <div class="col-span-3 flex flex-col gap-1.5">
            <label for="rewardDescription" class={labelClass}>{m.eco_tower_field_description()}</label>
            <textarea id="rewardDescription" rows="2" maxlength="300" bind:value={draft.description} disabled={!canManage} class="{inputClass} resize-none"></textarea>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          {#if kind === 'SHOP'}
            <div class="flex flex-col gap-1.5">
              <label for="rewardPrice" class={labelClass}>{m.eco_tower_field_price({ currency: settings.currencyName })}</label>
              <input id="rewardPrice" type="number" min="1" bind:value={draft.price} disabled={!canManage} class={inputClass} />
            </div>
            <div class="flex items-center justify-between gap-3">
              <span class={labelClass}>{m.eco_tower_field_repeatable()} {@render hintIcon(m.eco_tower_field_repeatable_hint())}</span>
              <ToggleSwitch checked={draft.repeatable} disabled={!canManage} ariaLabel={m.eco_tower_field_repeatable()} onToggle={(value: boolean) => { draft.repeatable = value; }} />
            </div>
            {#if draft.repeatable}
              <div class="flex flex-col gap-1.5">
                <label for="rewardMaxPurchases" class={labelClass}>{m.eco_tower_field_max_purchases()} {@render hintIcon(m.eco_tower_field_max_purchases_hint())}</label>
                <input id="rewardMaxPurchases" type="number" min="0" bind:value={draft.maxPurchases} disabled={!canManage} class={inputClass} />
              </div>
              <div class="flex flex-col gap-1.5">
                <label for="rewardLimitPeriod" class={labelClass}>{m.eco_tower_field_limit_period()} {@render hintIcon(m.eco_tower_field_limit_period_hint())}</label>
                <select id="rewardLimitPeriod" bind:value={draft.limitPeriod} disabled={!canManage || !(Number(draft.maxPurchases) > 0)} class={inputClass}>
                  {#each LIMIT_PERIODS as period}<option value={period}>{limitPeriodLabel(period)}</option>{/each}
                </select>
              </div>
            {/if}
          {:else}
            <div class="flex flex-col gap-1.5">
              <label for="rewardFloor" class={labelClass}>{m.eco_tower_field_floor()}</label>
              <input id="rewardFloor" type="number" min="1" bind:value={draft.floor} disabled={!canManage} class={inputClass} />
            </div>
            <div class="flex flex-col gap-1.5">
              <label for="rewardShards" class={labelClass}>{m.eco_tower_field_bonus_shards({ currency: settings.currencyName })}</label>
              <input id="rewardShards" type="number" min="0" bind:value={draft.shards} disabled={!canManage} class={inputClass} />
            </div>
          {/if}
          <div class="flex flex-col gap-1.5">
            <label for="rewardCoins" class={labelClass}>{currencyName || m.eco_fish_field_value()}</label>
            <input id="rewardCoins" type="number" min="0" bind:value={draft.coins} disabled={!canManage} class={inputClass} />
          </div>
          <div class="flex flex-col gap-1.5">
            <label for="rewardXp" class={labelClass}>{m.eco_dungeon_rpg_xp()}</label>
            <input id="rewardXp" type="number" min="0" bind:value={draft.xp} disabled={!canManage} class={inputClass} />
          </div>
          <div class="flex flex-col gap-1.5">
            <label for="rewardClan" class={labelClass}>{m.eco_tower_field_clan_points()} {@render hintIcon(m.eco_tower_field_clan_points_hint())}</label>
            <input id="rewardClan" type="number" min="0" bind:value={draft.clanPoints} disabled={!canManage} class={inputClass} />
          </div>
          <div class="flex flex-col gap-1.5">
            <span class={labelClass}>{m.eco_fish_reward_title()} {@render hintIcon(m.eco_tower_reward_power_hint())}</span>
            <SearchableSelect
              value={draft.titleId || null}
              options={titleOptions}
              placeholder={titles.length > 0 ? m.eco_bestiary_title_none() : m.eco_bestiary_title_empty()}
              clearable={true}
              showId={false}
              className="w-full"
              on:change={(e: any) => { draft.titleId = e.detail?.value ?? null; }}
            />
          </div>
          <div class="col-span-2 flex flex-col gap-1.5">
            <span class={labelClass}>{m.eco_fish_reward_item()}</span>
            <SearchableSelect
              value={draft.itemName || null}
              options={itemOptions}
              placeholder={m.eco_fish_reward_item_none()}
              clearable={true}
              showId={false}
              className="w-full"
              on:change={(e: any) => { draft.itemName = e.detail?.value ?? null; }}
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <label for="rewardStat" class={labelClass}>{m.eco_tower_field_stat()} {@render hintIcon(m.eco_tower_field_stat_hint())}</label>
            <select id="rewardStat" bind:value={draft.stat} disabled={!canManage} class={inputClass}>
              <option value={null}>{m.eco_tower_stat_none()}</option>
              {#each REWARD_STATS as stat}<option value={stat}>{statLabel(stat)}</option>{/each}
            </select>
          </div>
          <div class="flex flex-col gap-1.5">
            <label for="rewardStatAmount" class={labelClass}>{m.eco_tower_field_stat_amount()}</label>
            <input id="rewardStatAmount" type="number" min="1" max="100" bind:value={draft.statAmount} disabled={!canManage || !draft.stat} class={inputClass} />
          </div>
          <div class="flex flex-col gap-1.5">
            <label for="rewardMaxEnergy" class={labelClass}>{m.eco_tower_field_max_energy()} {@render hintIcon(m.eco_tower_field_max_energy_hint())}</label>
            <input id="rewardMaxEnergy" type="number" min="0" max="2000000" bind:value={draft.maxEnergy} disabled={!canManage} class={inputClass} />
          </div>
          <div class="flex flex-col gap-1.5">
            <label for="rewardReclassVouchers" class={labelClass}>{m.eco_tower_field_reclass_vouchers()} {@render hintIcon(m.eco_tower_field_reclass_vouchers_hint())}</label>
            <input id="rewardReclassVouchers" type="number" min="0" max="10" bind:value={draft.reclassVouchers} disabled={!canManage} class={inputClass} />
          </div>
          <div class="col-span-2 flex flex-col gap-1.5">
            <span class={labelClass}>{m.eco_fish_reward_role()}</span>
            <SearchableSelect
              value={draft.roleId || null}
              options={roles}
              placeholder={m.eco_fish_reward_role_none()}
              clearable={true}
              className="w-full"
              on:change={(e: any) => { draft.roleId = e.detail?.value ?? null; }}
            />
          </div>
        </div>

        <div class="flex items-center justify-between gap-3 pt-3 border-t border-outline-variant">
          <span class="text-sm font-semibold">{m.eco_tower_reward_enabled()}</span>
          <ToggleSwitch checked={draft.enabled} disabled={!canManage} ariaLabel={m.eco_tower_reward_enabled()} onToggle={(value: boolean) => { draft.enabled = value; }} />
        </div>

        {#if canManage}
          <div class="flex flex-wrap justify-between gap-2">
            {#if draft.id}
              <Button variant="danger" size="sm" icon="trash" disabled={disabled || actionState.state.loading} onclick={() => removeReward(draft)}>{m.eco_tower_reward_delete_btn()}</Button>
            {:else}
              <span></span>
            {/if}
            <Button variant="primary" size="sm" icon="check" disabled={disabled || actionState.state.loading || !draft.name.trim()} onclick={saveReward}>{m.eco_btn_save()}</Button>
          </div>
        {/if}
      </div>
    </SectionCard>
  {:else}
    <div class="rounded-xl border border-dashed border-outline-variant p-6 text-center text-body-sm text-on-surface-variant">{m.eco_tower_rewards_pick()}</div>
  {/if}
{/snippet}

{#snippet leaderboardList(entries: LeaderboardEntry[], extra: boolean)}
  <ol class="flex flex-col gap-1.5">
    {#each entries as entry, index (entry.userId)}
      <li class="relative overflow-hidden flex items-center gap-3 rounded-lg px-3 py-2 text-xs">
        <div class="absolute inset-y-0 left-0 bg-warning/10 pointer-events-none" style="width: {Math.round((entry.bestFloor / topFloor) * 100)}%"></div>
        <span class="relative w-6 text-right font-mono text-on-surface-variant">{index + 1}</span>
        {#if entry.avatarUrl}
          <img src={entry.avatarUrl} alt="" class="relative w-6 h-6 rounded-full" loading="lazy" />
        {:else}
          <span class="relative w-6 h-6 rounded-full bg-surface-container flex items-center justify-center text-on-surface-variant"><Papicon icon="user" size={12} /></span>
        {/if}
        <span class="relative flex-1 font-semibold truncate">{entry.displayName}</span>
        {#if extra}
          <span class="relative text-on-surface-variant hidden sm:inline">{m.eco_tower_leaderboard_runs({ runs: entry.totalRuns })}</span>
          {#if entry.bestRooms}<span class="relative text-on-surface-variant hidden sm:inline" title={m.eco_tower_leaderboard_rooms_tip()}>{m.eco_tower_leaderboard_rooms({ rooms: entry.bestRooms })}</span>{/if}
        {/if}
        <span class="relative font-bold text-warning whitespace-nowrap">{m.eco_tower_milestone_floor({ floor: entry.bestFloor })}</span>
      </li>
    {/each}
  </ol>
{/snippet}

<div class="tower flex flex-col gap-5 {disabled ? 'opacity-60' : ''}">
  <InlineFeedback state={actionState} />

  {#if loading}
    <div class="flex items-center justify-center py-12">
      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
    </div>
  {:else}
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div class="flex min-w-0 flex-col gap-1">
        <h2 class="font-headline text-2xl font-semibold flex items-center gap-2.5 flex-wrap">
          {#if mode === 'clan'}
            <span class="text-primary flex"><Papicon icon="user" size={22} /></span>
            {clan.name || m.eco_clan_tower_title()}
          {:else}
            {#if settings.emoji}<EmojiText value={settings.emoji} />{:else}<span class="text-primary flex"><Papicon icon="Building" size={22} /></span>{/if}
            {settings.name || m.eco_tower_title()}
          {/if}
          <span class="text-2xs font-semibold px-2 py-0.5 rounded-full {headerEnabled ? 'bg-success/15 text-success' : 'bg-surface-container text-on-surface-variant'}">
            {mode === 'clan'
              ? (headerEnabled ? m.eco_tower_daily_on() : m.eco_tower_daily_off())
              : (headerEnabled ? m.eco_tower_open() : m.eco_tower_closed())}
          </span>
        </h2>
        <p class="max-w-2xl text-body-sm text-on-surface-variant">{mode === 'clan' ? m.eco_clan_tower_short_desc() : m.eco_tower_short_desc()}</p>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        {#if clanAvailable}
          <Tabs
            label={m.eco_tower_mode_label()}
            tabs={[
              { id: 'solo', label: m.eco_tower_mode_solo(), icon: 'Building' },
              { id: 'clan', label: m.eco_tower_tab_clan(), icon: 'user' },
            ]}
            active={mode}
            onchange={(id) => { mode = id as Mode; editing = null; }}
          />
        {/if}
        <ToggleSwitch
          checked={headerEnabled}
          disabled={!canManage || disabled}
          ariaLabel={mode === 'clan' ? m.eco_clan_tower_title() : m.eco_tower_toggle_aria()}
          onToggle={toggleHeader}
        />
      </div>
    </header>

    <div class="tower__layout">
      <aside class="tower__sidebar">
        {#each navGroups as group (group.label)}
          <nav aria-label={group.label} class="flex flex-col gap-0.5">
            <span class="px-3 pb-1 text-2xs text-on-surface-variant">{group.label}</span>
            {#each group.items as item (item.id)}
              <button type="button" class="side-link" aria-current={item.id === view ? 'page' : undefined} onclick={() => go(item.id)}>
                <Papicon icon={item.icon} size={18} />
                <span class="truncate">{item.label}</span>
                {#if 'count' in item && item.count}<span class="side-link__count">{item.count}</span>{/if}
              </button>
            {/each}
          </nav>
        {/each}
      </aside>

      <div class="flex min-w-0 flex-col gap-4">
        <div class="tower__mobile-nav">
          <Tabs label={m.eco_tower_tabs_label()} tabs={navItems.map((item) => ({ id: item.id, label: item.label, icon: item.icon }))} active={view} onchange={(id) => go(id as View)} />
        </div>

        {#if mode === 'clan'}
          <RpgClanTowerPanel
            {view}
            {canManage}
            {disabled}
            bind:settings={clan}
            clansEnabled={clansEnabled}
            current={clanCurrent}
            last={clanLast}
            nextOpensAt={clanNextOpensAt}
            mapVersion={clanMapVersion}
            {foes}
            {limits}
            {channels}
            growthPercent={Number(settings.floorGrowthPercent) || 8}
            onSaved={loadClan}
          />
        {:else if view === 'overview'}
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {@render kpi(m.eco_tower_stat_players(), stats.players.toLocaleString(), m.eco_tower_kpi_active({ count: stats.activeRuns }), 'user', m.eco_tower_stat_players_tip())}
            {@render kpi(m.eco_tower_stat_runs(), stats.runs.toLocaleString(), m.eco_tower_kpi_best({ floor: stats.bestFloor }), 'walk', m.eco_tower_stat_runs_tip())}
            {@render kpi(m.eco_tower_insight_average(), insights && insights.finishedRuns > 0 ? insights.averageFloor : '—', '', 'grades', m.eco_tower_insight_average_tip())}
            {@render kpi(m.eco_tower_insight_deaths(), insights && insights.finishedRuns > 0 ? `${insights.deathRate} %` : '—', '', 'ghost', m.eco_tower_insight_deaths_tip())}
          </div>

          {#if !settings.enabled}
            <Callout variant="info">{m.eco_tower_alert_closed()}</Callout>
          {/if}
          {#if insights?.deadliestFloor && insights.deadliestFloor.deaths > 0}
            <Callout variant="danger" icon="alert-triangle">
              {m.eco_tower_alert_deadliest({
                floor: insights.deadliestFloor.label ?? insights.deadliestFloor.floor,
                name: insights.deadliestFloor.name ? ` (${insights.deadliestFloor.name})` : '',
                count: insights.deadliestFloor.deaths,
              })}
              {#snippet actions()}<Button size="sm" variant="ghost" iconRight="arrow-right" onclick={() => go('map')}>{m.eco_tower_alert_open_map()}</Button>{/snippet}
            </Callout>
          {/if}
          {#if insights?.topKillers?.[0]}
            <Callout variant="warning" icon="alert-triangle">
              {m.eco_tower_alert_killer({ name: insights.topKillers[0].name, count: insights.topKillers[0].deaths })}
              {#snippet actions()}<Button size="sm" variant="ghost" iconRight="arrow-right" onclick={() => go('lab')}>{m.eco_tower_alert_open_lab()}</Button>{/snippet}
            </Callout>
          {/if}

          <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <SectionCard title={m.eco_tower_top_title()} icon="crown">
              {#snippet actions()}<Button size="sm" variant="ghost" iconRight="arrow-right" onclick={() => go('board')}>{m.eco_tower_top_all()}</Button>{/snippet}
              {#if leaderboard.length === 0}
                <p class="text-body-sm text-on-surface-variant">{m.eco_tower_leaderboard_empty()}</p>
              {:else}
                {@render leaderboardList(leaderboard.slice(0, 5), false)}
              {/if}
            </SectionCard>
            <SectionCard title={m.eco_tower_insight_killers()} icon="ghost" description={m.eco_tower_insight_killers_tip()}>
              {#if insights && insights.topKillers.length > 0}
                <ol class="flex flex-col gap-1.5 text-xs">
                  {#each insights.topKillers as killer}
                    <li class="flex justify-between gap-2 rounded-lg bg-surface-container-low px-3 py-2"><span class="truncate font-semibold">{killer.name}</span><span class="text-on-surface-variant tabular-nums">{killer.deaths}</span></li>
                  {/each}
                </ol>
              {:else}
                <p class="text-body-sm text-on-surface-variant">—</p>
              {/if}
            </SectionCard>
          </div>

          {#if insights?.cards && insights.cards.some((card) => card.arrivals > 0)}
            <SectionCard title={m.eco_tower_cards_real()} description={m.eco_tower_cards_real_desc()} icon="grid">
              {#snippet actions()}
                <Button size="sm" variant="ghost" icon={showCards ? 'chevron-up' : 'chevron-down'} onclick={() => { showCards = !showCards; }}>
                  {showCards ? m.eco_tower_advanced_hide_short() : m.eco_tower_cards_toggle()}
                </Button>
              {/snippet}
              {#if showCards}{@render cardTable(insights.cards, true)}{/if}
            </SectionCard>
          {/if}
        {:else if view === 'board'}
          {#if settings.dailyEnabled}
            <Tabs
              label={m.eco_tower_tab_leaderboard()}
              tabs={[
                { id: 'season', label: m.eco_tower_board_season(), icon: 'crown' },
                { id: 'daily', label: m.eco_tower_daily_board_title(), icon: 'calendar' },
              ]}
              active={boardTab}
              onchange={(id) => { boardTab = id as 'season' | 'daily'; }}
            />
          {/if}
          {#if boardTab === 'daily' && settings.dailyEnabled}
            <SectionCard title={m.eco_tower_daily_board_title()} icon="calendar" description={m.eco_tower_daily_desc()}>
              {#if dailyBoard.length === 0}
                <p class="text-body-sm text-on-surface-variant">{m.eco_tower_daily_board_empty()}</p>
              {:else}
                <ol class="flex flex-col gap-1.5">
                  {#each dailyBoard as entry, index (entry.userId)}
                    <li class="flex items-center gap-3 rounded-lg bg-surface-container-low px-3 py-2 text-xs">
                      <span class="w-6 text-right font-mono text-on-surface-variant">{index + 1}</span>
                      {#if entry.avatarUrl}<img src={entry.avatarUrl} alt="" class="w-6 h-6 rounded-full" loading="lazy" />{/if}
                      <span class="flex-1 font-semibold truncate">{entry.displayName}</span>
                      <span class="text-on-surface-variant">{m.eco_tower_leaderboard_rooms({ rooms: entry.roomsExplored })}</span>
                      <span class="font-bold text-warning">{m.eco_tower_milestone_floor({ floor: entry.floorsCleared })}</span>
                    </li>
                  {/each}
                </ol>
              {/if}
            </SectionCard>
          {:else}
            <SectionCard
              title={m.eco_tower_leaderboard_title()}
              icon="crown"
              description={settings.seasonStartedAt && new Date(settings.seasonStartedAt).getTime() > 0
                ? m.eco_tower_season_since({ date: new Date(settings.seasonStartedAt).toLocaleDateString() })
                : m.eco_tower_season_first()}
            >
              {#snippet actions()}
                {#if canManage}
                  <span class="flex items-center gap-2" title={m.eco_tower_season_reset_milestones_hint()}>
                    <ToggleSwitch checked={resetMilestones} disabled={disabled} size="sm" ariaLabel={m.eco_tower_season_reset_milestones()} onToggle={(value: boolean) => { resetMilestones = value; }} />
                    <span class="text-2xs font-semibold text-on-surface-variant hidden sm:inline">{m.eco_tower_season_reset_milestones()}</span>
                  </span>
                  <Button size="sm" icon="RotateCcw" disabled={disabled} title={m.eco_tower_season_confirm_desc()} onclick={newSeason}>{m.eco_tower_season_btn()}</Button>
                {/if}
              {/snippet}
              {#if leaderboard.length === 0}
                <p class="text-body-sm text-on-surface-variant">{m.eco_tower_leaderboard_empty()}</p>
              {:else}
                {@render leaderboardList(leaderboard, true)}
              {/if}
            </SectionCard>
          {/if}
        {:else if view === 'rules'}
          <div class="flex justify-end">
            <Button size="sm" variant="ghost" icon={showAllRules ? 'chevron-up' : 'chevron-down'} onclick={() => { showAllRules = !showAllRules; }}>
              {showAllRules ? m.eco_tower_rules_simple() : m.eco_tower_rules_show_all()}
            </Button>
          </div>
          <div class="tower__rules">
            <div class="flex min-w-0 flex-col gap-4">
              <SectionCard title={m.eco_tower_identity_title()} icon="pen">
                <div class="flex flex-col gap-4">
                  <div class="grid grid-cols-3 gap-3">
                    <div class="col-span-2 flex flex-col gap-1.5">
                      <label for="towerName" class={labelClass}>{m.eco_tower_field_name()}</label>
                      <input id="towerName" type="text" maxlength="50" bind:value={settings.name} disabled={!canManage || disabled} class={inputClass} />
                    </div>
                    <div class="flex flex-col gap-1.5">
                      <label for="towerEmoji" class={labelClass}>{m.eco_item_emoji()} {@render hintIcon(m.eco_tower_emoji_default_hint())}</label>
                      <div class="flex gap-2">
                        <input id="towerEmoji" type="text" bind:value={settings.emoji} disabled={!canManage || disabled} class={inputClass} />
                        {#if canManage}<EmojiPicker bind:value={settings.emoji} />{/if}
                      </div>
                    </div>
                    <div class="col-span-3 flex flex-col gap-1.5">
                      <label for="towerDescription" class={labelClass}>{m.eco_tower_field_description()}</label>
                      <textarea id="towerDescription" rows="2" maxlength="300" bind:value={settings.description} disabled={!canManage || disabled} placeholder={m.eco_tower_field_description_placeholder()} class="{inputClass} resize-none"></textarea>
                    </div>
                  </div>
                  <div class="flex items-center justify-between gap-4">
                    <span class={labelClass}><Papicon icon="calendar" size={13} /> {m.eco_tower_daily_title()} {@render hintIcon(m.eco_tower_daily_desc())}</span>
                    <ToggleSwitch checked={settings.dailyEnabled} disabled={!canManage || disabled} ariaLabel={m.eco_tower_daily_title()} onToggle={(value: boolean) => { settings.dailyEnabled = value; }} />
                  </div>
                  <details class="rounded-lg bg-surface-container-low px-3 py-2.5">
                    <summary class="text-xs font-semibold cursor-pointer flex items-center gap-2 select-none"><Papicon icon="info" size={13} /> {m.eco_tower_guide_title()}</summary>
                    <ul class="mt-3 flex flex-col gap-2 text-xs text-on-surface-variant leading-relaxed list-disc pl-5">
                      <li>{m.eco_tower_guide_floor()}</li>
                      <li>{m.eco_tower_guide_boss()}</li>
                      <li>{m.eco_tower_guide_growth()}</li>
                      <li>{m.eco_tower_guide_combat()}</li>
                      <li>{m.eco_tower_guide_depth()}</li>
                      <li>{m.eco_tower_guide_milestones()}</li>
                      <li>{m.eco_tower_guide_start()}</li>
                    </ul>
                  </details>
                </div>
              </SectionCard>

              <SectionCard title={m.eco_tower_entry_title()} description={m.eco_tower_entry_hint()} icon="login">
                <div class="flex flex-col gap-4">
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {#each [
                      { mode: 'COMPRESSED' as EntryMode, title: m.eco_tower_mode_compressed(), desc: m.eco_tower_mode_compressed_desc() },
                      { mode: 'RESET' as EntryMode, title: m.eco_tower_mode_reset(), desc: m.eco_tower_mode_reset_desc() },
                    ] as option}
                      <button type="button" disabled={!canManage || disabled} aria-pressed={settings.entryMode === option.mode} onclick={() => { settings.entryMode = option.mode; }}
                        class="{choiceClass} {settings.entryMode === option.mode ? 'border-primary bg-primary/10' : 'border-outline-variant hover:bg-surface-container-low'}">
                        <p class="text-sm font-semibold {settings.entryMode === option.mode ? 'text-primary' : ''}">{option.title}</p>
                        <p class="text-2xs text-on-surface-variant mt-1 leading-relaxed">{option.desc}</p>
                      </button>
                    {/each}
                  </div>
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {#if settings.entryMode === 'COMPRESSED'}
                      {@render numberField('towerInherit', m.eco_tower_field_inherit(), m.eco_tower_field_inherit_hint(), 'inheritCapPercent', 0, 300)}
                    {/if}
                    {@render numberField('towerTitle', m.eco_tower_field_title_cap(), m.eco_tower_field_title_cap_hint(), 'titleCapPercent', 0, 200)}
                  </div>
                </div>
              </SectionCard>

              <SectionCard title={m.eco_tower_difficulty_title()} icon="Flame">
                <div class="flex flex-col gap-4">
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {@render numberField('towerGrowth', m.eco_tower_field_growth(), m.eco_tower_field_growth_hint(), 'floorGrowthPercent', 1, 30)}
                    {@render numberField('towerBlessing', m.eco_tower_field_blessing(), m.eco_tower_field_blessing_map_hint(), 'blessingEvery', 0, 20)}
                  </div>
                  {@render advanced('difficulty', difficultyAdvanced)}
                </div>
              </SectionCard>

              <SectionCard title={m.eco_tower_climb_title()} icon="walk">
                <div class="flex flex-col gap-4">
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {#each [
                      { value: 'GENERATE' as const, title: m.eco_tower_floors_after_generate(), desc: m.eco_tower_floors_after_generate_desc() },
                      { value: 'LOOP' as const, title: m.eco_tower_floors_after_loop(), desc: m.eco_tower_floors_after_loop_desc() },
                    ] as option}
                      <button type="button" disabled={!canManage || disabled} aria-pressed={settings.floorsAfter === option.value} onclick={() => { settings.floorsAfter = option.value; }}
                        class="{choiceClass} {settings.floorsAfter === option.value ? 'border-primary bg-primary/10' : 'border-outline-variant hover:bg-surface-container-low'}">
                        <p class="text-sm font-semibold {settings.floorsAfter === option.value ? 'text-primary' : ''}">{option.title}</p>
                        <p class="text-2xs text-on-surface-variant mt-1 leading-relaxed">{option.desc}</p>
                      </button>
                    {/each}
                  </div>
                  <div class="flex items-center justify-between gap-4">
                    <span class={labelClass}><Papicon icon="Eye" size={13} /> {m.eco_tower_generated_fog()} {@render hintIcon(m.eco_tower_generated_fog_hint())}</span>
                    <ToggleSwitch checked={settings.generatedFog} disabled={!canManage || disabled} ariaLabel={m.eco_tower_generated_fog()} onToggle={(value: boolean) => { settings.generatedFog = value; }} />
                  </div>
                  <div class="flex flex-col gap-1.5">
                    <span class={labelClass}>{m.eco_tower_announce_channel()} {@render hintIcon(m.eco_tower_announce_hint())}</span>
                    <SearchableSelect
                      value={settings.announceChannelId}
                      options={channels}
                      placeholder={m.eco_tower_announce_none()}
                      clearable={true}
                      className="w-full"
                      on:change={(e: any) => { settings.announceChannelId = e.detail?.value ?? null; }}
                    />
                  </div>
                </div>
              </SectionCard>

              <SectionCard title={m.eco_tower_shards_title()} icon="Diamond">
                <div class="flex flex-col gap-4">
                  <div class="grid grid-cols-3 gap-3">
                    <div class="col-span-2 flex flex-col gap-1.5">
                      <label for="towerCurrency" class={labelClass}>{m.eco_tower_field_currency()}</label>
                      <input id="towerCurrency" type="text" maxlength="30" bind:value={settings.currencyName} disabled={!canManage || disabled} class={inputClass} />
                    </div>
                    <div class="flex flex-col gap-1.5">
                      <label for="towerCurrencyEmoji" class={labelClass}>{m.eco_item_emoji()} {@render hintIcon(m.eco_tower_emoji_default_hint())}</label>
                      <div class="flex gap-2">
                        <input id="towerCurrencyEmoji" type="text" bind:value={settings.currencyEmoji} disabled={!canManage || disabled} class={inputClass} />
                        {#if canManage}<EmojiPicker bind:value={settings.currencyEmoji} />{/if}
                      </div>
                    </div>
                  </div>
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {@render numberField('towerShards', m.eco_tower_field_shards(), m.eco_tower_field_shards_hint(), 'shardsPerFloor', 0, 1000)}
                    {@render numberField('towerDeath', m.eco_tower_field_death(), m.eco_tower_field_death_hint(), 'deathShardPercent', 0, 100)}
                  </div>
                  {@render advanced('shards', shardsAdvanced)}
                </div>
              </SectionCard>

              {#if clanLoaded}
                <SectionCard title={m.eco_tower_tab_clan()} description={m.eco_tower_clan_card_desc()} icon="user">
                  {#snippet actions()}
                    <ToggleSwitch checked={clan.enabled} disabled={!canManage || disabled} ariaLabel={m.eco_clan_tower_title()} onToggle={(value: boolean) => { clan.enabled = value; }} />
                  {/snippet}
                  {#if !clansEnabled}
                    <Callout variant="warning">{m.eco_clan_tower_clans_off()}</Callout>
                  {:else}
                    <p class="text-body-sm text-on-surface-variant">{clan.enabled ? m.eco_tower_clan_card_on() : m.eco_tower_clan_card_off()}</p>
                  {/if}
                </SectionCard>
              {/if}

              {#if canManage}
                <SectionCard title={m.eco_tower_reset_title()} description={m.eco_tower_reset_desc()} icon="alert-triangle">
                  <div class="flex flex-wrap gap-3">
                    <Button variant="danger" size="sm" icon="user" disabled={disabled || actionState.state.loading} onclick={() => resetTower(false)}>{m.eco_tower_reset_players_btn()}</Button>
                    <Button variant="danger" size="sm" icon="trash" disabled={disabled || actionState.state.loading} onclick={() => resetTower(true)}>{m.eco_tower_reset_all_btn()}</Button>
                  </div>
                </SectionCard>
              {/if}
            </div>

            <aside class="tower__preview">
              <SectionCard title={m.eco_tower_live_preview()} icon="gallery">
                <div class="flex flex-col gap-3 text-xs">
                  <p class="font-semibold">{m.eco_tower_preview_entry()}</p>
                  {#each entryPreview as row}
                    <div class="flex justify-between gap-2 tabular-nums">
                      <span class="text-on-surface-variant">{m.eco_tower_preview_rpg({ value: row.main.toLocaleString() })}</span>
                      <span class="font-semibold flex items-center gap-1"><Papicon icon="Swords" size={12} /> {row.tower}</span>
                    </div>
                  {/each}
                  <p class="text-2xs text-on-surface-variant">{m.eco_tower_preview_lead({ ratio: veteranRatio })}</p>
                  <div class="h-px bg-outline-variant"></div>
                  {#each floorPreview as row}
                    <div class="flex justify-between gap-2 tabular-nums">
                      <span class="text-on-surface-variant">{m.eco_tower_preview_floor({ floor: row.floor })}</span>
                      <span class="font-semibold flex items-center gap-2">
                        <span class="flex items-center gap-1"><Papicon icon="heart" size={11} /> {row.health}</span>
                        <span class="flex items-center gap-1"><Papicon icon="Swords" size={11} /> {row.attack}</span>
                      </span>
                    </div>
                  {/each}
                </div>
              </SectionCard>
            </aside>
          </div>
        {:else if view === 'rewards'}
          <Tabs label={m.eco_tower_nav_rewards()} tabs={rewardTabs} active={rewardsTab} onchange={pickRewardsTab} />

          {#if rewardsTab === 'upgrades'}
            <div class="tower__split">
              <SectionCard title={m.eco_tower_upgrades_title()} description={m.eco_tower_upgrades_desc()} flush>
                {#snippet actions()}
                  {#if canManage}
                    <Button variant="primary" size="sm" icon="plus" disabled={disabled || settings.upgrades.length >= UPGRADES_MAX} title={m.eco_tower_upgrades_max({ max: UPGRADES_MAX })} onclick={addUpgrade}>{m.eco_tower_upgrade_add()}</Button>
                  {/if}
                {/snippet}
                {#if settings.upgrades.length === 0}
                  <p class="p-5 text-body-sm text-on-surface-variant">{m.eco_tower_upgrades_empty()}</p>
                {:else}
                  {#each settings.upgrades as upgrade, index (upgrade.id)}
                    {@const selected = upgrade.id === selectedUpgradeId}
                    <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 border-t border-outline-variant first:border-t-0 transition-colors {selected ? 'bg-primary/10' : 'hover:bg-surface-container-low'}">
                      <button type="button" class="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 text-left min-w-0 {upgrade.enabled ? '' : 'opacity-60'}" aria-pressed={selected} onclick={() => { selectedUpgradeId = upgrade.id; }}>
                        <span class="w-8 h-8 rounded-lg bg-surface-container text-primary flex items-center justify-center">
                          {#if upgrade.emoji}<EmojiText value={upgrade.emoji} />{:else}<Papicon icon={UPGRADE_ICON[upgrade.effect]} size={16} />{/if}
                        </span>
                        <span class="min-w-0">
                          <span class="block text-sm font-semibold truncate">{upgrade.name || effectLabel(upgrade.effect)}</span>
                          <span class="block text-2xs text-on-surface-variant truncate">{m.eco_tower_upgrade_summary({ effect: effectLabel(upgrade.effect), amount: upgrade.perLevel, levels: upgrade.maxLevel })}</span>
                        </span>
                        <span class="text-xs font-bold text-primary whitespace-nowrap flex items-center gap-1 tabular-nums">{upgradeCostRange(upgrade)} {@render shardIcon(12)}</span>
                      </button>
                      <ToggleSwitch checked={upgrade.enabled} size="sm" disabled={!canManage || disabled} ariaLabel={m.eco_tower_upgrade_enabled_aria()} onToggle={(value: boolean) => { settings.upgrades[index].enabled = value; }} />
                    </div>
                  {/each}
                {/if}
              </SectionCard>

              <div class="tower__panel">
                {#if selectedUpgradeIndex >= 0}
                  {@const index = selectedUpgradeIndex}
                  {@const upgrade = settings.upgrades[index]}
                  <SectionCard title={upgrade.name || effectLabel(upgrade.effect)} icon={UPGRADE_ICON[upgrade.effect]}>
                    {#snippet actions()}
                      <Button variant="ghost" size="sm" icon="cross" aria-label={m.eco_btn_cancel()} onclick={() => { selectedUpgradeId = null; }} />
                    {/snippet}
                    <div class="flex flex-col gap-4">
                      <div class="grid grid-cols-2 gap-3">
                        <div class="flex flex-col gap-1.5">
                          <label for="upgEffect" class={labelClass}>{m.eco_tower_upgrade_effect()}</label>
                          <select id="upgEffect" bind:value={settings.upgrades[index].effect} disabled={!canManage || disabled} class={inputClass}>
                            {#each UPGRADE_EFFECTS as effect}<option value={effect}>{effectLabel(effect)}</option>{/each}
                          </select>
                        </div>
                        <div class="flex flex-col gap-1.5">
                          <label for="upgPer" class={labelClass}>{effectUnit(upgrade.effect)}</label>
                          <input id="upgPer" type="number" min="1" max={PER_LEVEL_MAX[upgrade.effect]} bind:value={settings.upgrades[index].perLevel} disabled={!canManage || disabled} class={inputClass} />
                        </div>
                        <div class="flex flex-col gap-1.5">
                          <label for="upgMax" class={labelClass}>{m.eco_tower_upgrade_max_level()}</label>
                          <input id="upgMax" type="number" min="1" max="20" bind:value={settings.upgrades[index].maxLevel} disabled={!canManage || disabled} class={inputClass} />
                        </div>
                        <div class="flex flex-col gap-1.5">
                          <label for="upgCost" class={labelClass}>{m.eco_tower_upgrade_base_cost({ currency: settings.currencyName })}</label>
                          <input id="upgCost" type="number" min="1" bind:value={settings.upgrades[index].baseCost} disabled={!canManage || disabled} class={inputClass} />
                        </div>
                        <div class="col-span-2 flex flex-col gap-1.5">
                          <label for="upgGrowth" class={labelClass}>{m.eco_tower_upgrade_growth()} {@render hintIcon(m.eco_tower_upgrade_growth_hint())}</label>
                          <input id="upgGrowth" type="number" min="0" max="300" bind:value={settings.upgrades[index].costGrowthPercent} disabled={!canManage || disabled} class={inputClass} />
                        </div>
                      </div>
                      <p class="text-2xs text-on-surface-variant flex items-center gap-1 flex-wrap">{m.eco_tower_upgrade_costs({ list: upgradeCosts(upgrade) })} {@render shardIcon(11)}</p>

                      <details class="rounded-lg bg-surface-container-low px-3 py-2.5" open={!!(upgrade.name || upgrade.emoji || upgrade.description)}>
                        <summary class="text-xs font-semibold cursor-pointer select-none">{m.eco_tower_upgrade_presentation()}</summary>
                        <div class="mt-3 grid grid-cols-2 gap-3">
                          <div class="flex flex-col gap-1.5">
                            <label for="upgName" class={labelClass}>{m.eco_tower_field_reward_name()}</label>
                            <input id="upgName" type="text" maxlength="50" bind:value={settings.upgrades[index].name} disabled={!canManage || disabled} placeholder={m.eco_tower_upgrade_name_placeholder({ name: effectLabel(upgrade.effect) })} class={inputClass} />
                          </div>
                          <div class="flex flex-col gap-1.5">
                            <label for="upgEmoji" class={labelClass}>{m.eco_item_emoji()}</label>
                            <div class="flex gap-2">
                              <input id="upgEmoji" type="text" bind:value={settings.upgrades[index].emoji} disabled={!canManage || disabled} class={inputClass} />
                              {#if canManage}<EmojiPicker bind:value={settings.upgrades[index].emoji} />{/if}
                            </div>
                          </div>
                          <div class="col-span-2 flex flex-col gap-1.5">
                            <label for="upgDesc" class={labelClass}>{m.eco_tower_field_description()}</label>
                            <input id="upgDesc" type="text" maxlength="300" bind:value={settings.upgrades[index].description} disabled={!canManage || disabled} class={inputClass} />
                          </div>
                        </div>
                      </details>

                      {#if canManage}
                        <Button variant="danger" size="sm" icon="trash" class="self-start" disabled={disabled} onclick={() => removeUpgrade(upgrade)}>{m.eco_tower_reward_delete_btn()}</Button>
                      {/if}
                    </div>
                  </SectionCard>
                {:else}
                  <div class="rounded-xl border border-dashed border-outline-variant p-6 text-center text-body-sm text-on-surface-variant">{m.eco_tower_rewards_pick()}</div>
                {/if}
              </div>
            </div>
          {:else if rewardsTab === 'shop'}
            <div class="tower__split">
              <SectionCard title={m.eco_tower_items_title()} description={m.eco_tower_items_desc()} flush>
                {#snippet actions()}
                  {#if canManage}
                    <Button variant="primary" size="sm" icon="plus" disabled={disabled || rewards.length >= limits.rewardsMax} onclick={() => openNew('SHOP')}>{m.eco_tower_new_shop_btn()}</Button>
                  {/if}
                {/snippet}
                {#if shopRewards.length === 0}
                  <p class="p-5 text-body-sm text-on-surface-variant">{m.eco_tower_shop_empty()}</p>
                {:else}
                  {#each shopRewards as reward (reward.id)}{@render rewardRow(reward)}{/each}
                {/if}
              </SectionCard>
              <div class="tower__panel">{@render rewardEditor('SHOP')}</div>
            </div>
            <p class="text-2xs text-on-surface-variant">{m.eco_tower_rewards_desc()}</p>
          {:else if rewardsTab === 'milestones'}
            <div class="tower__split">
              <SectionCard title={m.eco_tower_milestones_title()} description={m.eco_tower_guide_milestones()} flush>
                {#snippet actions()}
                  {#if canManage}
                    <Button variant="primary" size="sm" icon="plus" disabled={disabled || rewards.length >= limits.rewardsMax} onclick={() => openNew('MILESTONE')}>{m.eco_tower_new_milestone_btn()}</Button>
                  {/if}
                {/snippet}
                {#if milestones.length === 0}
                  <p class="p-5 text-body-sm text-on-surface-variant">{m.eco_tower_milestones_empty()}</p>
                {:else}
                  {#each [...milestones].reverse() as reward (reward.id)}{@render rewardRow(reward)}{/each}
                {/if}
              </SectionCard>
              <div class="tower__panel">{@render rewardEditor('MILESTONE')}</div>
            </div>
          {:else}
            <SectionCard title={m.eco_tower_merchant_title()} description={m.eco_tower_merchant_desc()} icon="piggy-bank">
              <div class="flex flex-col gap-5">
                <div class="flex flex-col gap-2">
                  <span class={labelClass}>{m.eco_tower_merchant_offers()} {@render hintIcon(m.eco_tower_merchant_offers_hint())}</span>
                  <div class="flex flex-wrap gap-2">
                    {#each OFFERS as offer}
                      <label class="flex items-center gap-2 text-xs px-3 py-2 rounded-lg border border-outline-variant bg-surface-container-low" title={offerTip(offer)}>
                        <input type="checkbox" checked={settings.merchant.offers.includes(offer)} disabled={!canManage || disabled} onchange={() => toggleOffer(offer)} />
                        {offerLabel(offer)}
                      </label>
                    {/each}
                  </div>
                </div>

                <div class="grid grid-cols-1 lg:grid-cols-3 gap-3">
                  {#each OFFERS as offer}
                    <div class="rounded-xl border border-outline-variant bg-surface-container-low p-4 flex flex-col gap-3 {settings.merchant.offers.includes(offer) ? '' : 'opacity-60'}">
                      <p class="text-sm font-semibold flex items-center gap-2">
                        <span class="text-primary flex"><Papicon icon={OFFER_ICON[offer]} size={14} /></span>
                        {offerLabel(offer)} {@render hintIcon(offerTip(offer))}
                      </p>
                      {#if offer === 'POTION'}
                        {@render merchantField('merchPotion', m.eco_tower_merchant_base_price(), 'potionPrice', 1, 100000)}
                        {@render merchantField('merchPotionFloor', m.eco_tower_merchant_per_floor(), 'potionPricePerFloor', 0, 10000)}
                      {:else if offer === 'HEAL'}
                        {@render merchantField('merchHeal', m.eco_tower_merchant_base_price(), 'healPrice', 1, 100000)}
                        {@render merchantField('merchHealFloor', m.eco_tower_merchant_per_floor(), 'healPricePerFloor', 0, 10000)}
                        {@render merchantField('merchHealPercent', m.eco_tower_merchant_heal_percent(), 'healPercent', 5, 100)}
                      {:else}
                        {@render merchantField('merchGear', m.eco_tower_merchant_base_price(), 'gearPrice', 1, 100000)}
                        {@render merchantField('merchGearFloor', m.eco_tower_merchant_per_floor(), 'gearPricePerFloor', 0, 10000)}
                      {/if}
                    </div>
                  {/each}
                </div>

                <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {@render merchantField('merchPotionHeal', m.eco_tower_merchant_potion_heal(), 'potionHealPercent', 5, 100, m.eco_tower_merchant_potion_heal_hint())}
                </div>

                <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-2xs">
                  {#each merchantPreview as row}
                    <div class="rounded-lg bg-surface-container-low px-3 py-2 flex flex-col gap-0.5 tabular-nums">
                      <p class="text-on-surface-variant">{m.eco_tower_merchant_preview({ floor: row.floor })}</p>
                      <p class="flex items-center gap-1" title={m.eco_tower_merchant_potion()}><Papicon icon="FlaskConical" size={11} /> {row.potion} <Papicon icon="Coins" size={10} /></p>
                      <p class="flex items-center gap-1" title={m.eco_tower_merchant_heal()}><Papicon icon="heart" size={11} /> {row.heal} <Papicon icon="Coins" size={10} /></p>
                      <p class="flex items-center gap-1" title={m.eco_tower_merchant_gear()}><Papicon icon="Swords" size={11} /> {row.gear} <Papicon icon="Coins" size={10} /></p>
                    </div>
                  {/each}
                </div>
              </div>
            </SectionCard>
          {/if}
        {:else if view === 'map'}
          {#key mapVersion}
            <RpgTowerMapEditor
              {canManage}
              {disabled}
              initialFloors={settings.floors ?? []}
              floorsMax={limits.floorsMax ?? 300}
              growthPercent={Number(settings.floorGrowthPercent) || 8}
              floorsAfter={settings.floorsAfter}
              {foes}
              {deathMap}
              sizeLimits={limits.mapSize ?? { min: 3, max: 20 }}
              roomsMax={limits.mapRoomsMax ?? 300}
              onSaved={load}
            />
          {/key}
        {:else if view === 'lab'}
          <SectionCard title={m.eco_tower_sim_title()} description={m.eco_tower_sim_desc()} icon="coefficient">
            <div class="flex flex-col gap-4">
              <div class="flex flex-wrap items-end gap-4">
                <div class="flex flex-col gap-1.5">
                  <span class={labelClass}>{m.eco_tower_sim_class()}</span>
                  <Tabs label={m.eco_tower_sim_class()} tabs={SIM_CLASSES.map((entry) => ({ id: entry.id, label: entry.label() }))} active={simClass} onchange={(id) => { simClass = id; }} />
                </div>
                <div class="flex flex-col gap-1.5">
                  <span class={labelClass}>{m.eco_tower_sim_runs()}</span>
                  <Tabs label={m.eco_tower_sim_runs()} tabs={[25, 50, 100, 200].map((count) => ({ id: String(count), label: String(count) }))} active={String(simRuns)} onchange={(id) => { simRuns = Number(id); }} />
                </div>
                <div class="flex items-center gap-2 pb-2">
                  <ToggleSwitch checked={simSkills} ariaLabel={m.eco_tower_sim_skills()} onToggle={(value: boolean) => { simSkills = value; }} />
                  <span class={labelClass}>{m.eco_tower_sim_skills()} {@render hintIcon(m.eco_tower_sim_skills_tip())}</span>
                </div>
              </div>
              <div class="flex flex-col gap-1.5">
                <span class={labelClass}>{m.eco_tower_sim_heat()}</span>
                <div class="flex flex-wrap gap-1.5">
                  {#each SIM_HEATS as heat, index}
                    <button type="button" aria-pressed={(simHeat & (1 << index)) !== 0} onclick={() => { simHeat ^= 1 << index; }}
                      class="px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors {(simHeat & (1 << index)) !== 0 ? 'border-error bg-error/15 text-error' : 'border-outline-variant hover:bg-surface-container-low'}">{heat.label()}</button>
                  {/each}
                </div>
              </div>
              <Button variant="primary" icon="FlaskConical" class="self-start" loading={simLoading} onclick={runSimulation}>
                {simLoading ? m.eco_tower_sim_running() : m.eco_tower_sim_run()}
              </Button>
              {#if simError}
                <Callout variant="danger">{simError}</Callout>
              {/if}

              {#if simResult}
                <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
                  {@render kpi(m.eco_tower_sim_average(), simResult.averageFloor, '', 'grades')}
                  {@render kpi(m.eco_tower_sim_median(), simResult.medianFloor, '', 'grades')}
                  {@render kpi(m.eco_tower_sim_best(), simResult.bestFloor, '', 'crown')}
                  {@render kpi(m.eco_tower_sim_rooms(), simResult.averageRooms, '', 'map-pin')}
                  {@render kpi(m.eco_tower_sim_shards({ currency: settings.currencyName }), simResult.averageShards, '', 'Diamond')}
                </div>
                <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  <div class="lg:col-span-2 rounded-xl border border-outline-variant p-4 flex flex-col gap-1.5">
                    <p class="text-xs font-semibold flex items-center gap-1.5"><Papicon icon="ghost" size={12} /> {m.eco_tower_sim_deaths_by_floor()}</p>
                    {#each simResult.deathsByFloor as entry}
                      <div class="flex items-center gap-2 text-2xs">
                        <span class="w-16 shrink-0 text-on-surface-variant">{m.eco_tower_milestone_floor({ floor: entry.floor })}</span>
                        <div class="flex-1 h-2.5 rounded-full bg-surface-container overflow-hidden"><div class="h-full bg-error/70" style="width: {(entry.deaths / simDeathsMax) * 100}%"></div></div>
                        <span class="w-8 text-right font-mono">{entry.deaths}</span>
                      </div>
                    {:else}
                      <p class="text-2xs text-on-surface-variant">—</p>
                    {/each}
                  </div>
                  <div class="rounded-xl border border-outline-variant p-4">
                    <p class="text-xs font-semibold flex items-center gap-1.5"><Papicon icon="Swords" size={12} /> {m.eco_tower_insight_killers()}</p>
                    <ol class="mt-2 flex flex-col gap-0.5 text-xs">
                      {#each simResult.topKillers as killer}
                        <li class="flex justify-between gap-2"><span class="truncate font-semibold">{killer.name}</span><span class="text-on-surface-variant">{killer.deaths}</span></li>
                      {:else}
                        <li class="text-on-surface-variant">—</li>
                      {/each}
                    </ol>
                  </div>
                </div>
                {#if simResult.cards && simResult.cards.length > 0}
                  <div class="rounded-xl border border-outline-variant p-4 flex flex-col gap-2">
                    <p class="text-xs font-semibold">{m.eco_tower_sim_cards()}</p>
                    <p class="text-2xs text-on-surface-variant">{m.eco_tower_sim_cards_desc()}</p>
                    {@render cardTable(simResult.cards, false)}
                  </div>
                {/if}
                {#if simResult.capped > 0}
                  <p class="text-2xs text-on-surface-variant flex items-start gap-1.5"><Papicon icon="info" size={11} /> {m.eco_tower_sim_capped({ count: simResult.capped })}</p>
                {/if}
              {/if}
            </div>
          </SectionCard>
        {/if}
      </div>
    </div>

    {#if canManage && pendingChanges > 0}
      <div class="tower__savebar" role="status">
        <span class="flex items-center gap-2 text-body-sm text-on-surface-variant">
          <span class="w-2 h-2 rounded-full bg-warning"></span>
          {m.eco_tower_unsaved({ count: pendingChanges })}
        </span>
        <span class="flex gap-2 ml-auto">
          <Button variant="ghost" size="sm" disabled={actionState.state.loading} onclick={discardChanges}>{m.eco_btn_cancel()}</Button>
          <Button variant="primary" size="sm" icon="check" loading={actionState.state.loading} disabled={disabled} onclick={saveAll}>{m.eco_btn_save()}</Button>
        </span>
      </div>
    {/if}
  {/if}
</div>

<style>
  .tower__layout {
    display: grid;
    grid-template-columns: 13.5rem minmax(0, 1fr);
    gap: 1.5rem;
    align-items: start;
  }

  .tower__sidebar {
    position: sticky;
    top: calc(var(--app-navbar-height) + 1rem);
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .tower__mobile-nav {
    display: none;
  }

  .tower__rules {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 17rem;
    gap: 1rem;
    align-items: start;
  }

  .tower__preview {
    position: sticky;
    top: calc(var(--app-navbar-height) + 1rem);
  }

  .tower__split {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 22rem;
    gap: 1rem;
    align-items: start;
  }

  .tower__panel {
    position: sticky;
    top: calc(var(--app-navbar-height) + 1rem);
    min-width: 0;
  }

  .tower__savebar {
    position: sticky;
    bottom: 1rem;
    z-index: 20;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem 1rem;
    padding: 0.75rem 1rem;
    border-radius: 0.75rem;
    border: 1px solid var(--color-outline-variant);
    background: var(--color-surface-container);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  }

  .side-link {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    width: 100%;
    min-height: 2.5rem;
    padding: 0 0.75rem;
    border-radius: 0.5rem;
    font-size: 0.875rem;
    font-weight: 500;
    text-align: left;
    color: var(--color-on-surface-variant);
  }

  .side-link:hover {
    background: var(--color-surface-container);
    color: var(--color-on-surface);
  }

  .side-link:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .side-link[aria-current='page'] {
    background: color-mix(in srgb, var(--color-primary) 14%, transparent);
    color: var(--color-primary);
  }

  .side-link__count {
    margin-left: auto;
    font-size: 0.6875rem;
    font-variant-numeric: tabular-nums;
    opacity: 0.8;
  }

  @media (max-width: 1279px) {
    .tower__rules,
    .tower__split {
      grid-template-columns: minmax(0, 1fr);
    }

    .tower__preview,
    .tower__panel {
      position: static;
    }
  }

  @media (max-width: 1023px) {
    .tower__layout {
      grid-template-columns: minmax(0, 1fr);
    }

    .tower__sidebar {
      display: none;
    }

    .tower__mobile-nav {
      display: block;
    }
  }
</style>
