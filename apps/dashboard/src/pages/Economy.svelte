<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import { RPG_ENCHANTMENTS, RPG_ITEM_RARITIES } from '@kotbo/contracts';
  import { router } from 'tinro';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { pageTabItems } from '../lib/config/pageTabs';
  import { Tabs, FilterPills, Callout, Button } from '../lib/components/ui';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import LoadingHint from '../lib/components/LoadingHint.svelte';
import EmojiPicker from '../lib/components/EmojiPicker.svelte';
import EmojiText from '../lib/components/EmojiText.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import MultiSelect from '../lib/components/MultiSelect.svelte';
  import RpgEventsPanel from '../lib/components/economy/RpgEventsPanel.svelte';
  import RpgFishPanel from '../lib/components/economy/RpgFishPanel.svelte';
  import RpgDungeonsPanel from '../lib/components/economy/RpgDungeonsPanel.svelte';
  import RpgTowerPanel from '../lib/components/economy/RpgTowerPanel.svelte';
  import RpgGuildsPanel from '../lib/components/economy/RpgGuildsPanel.svelte';
  import RpgPlayerInventoryModal from '../lib/components/economy/RpgPlayerInventoryModal.svelte';
  import { channelDisplayName } from '../lib/channelUtils';
  import { stripCustomEmoji } from '../lib/emojiParser';
  import {
    asBestiaryDifficulty,
    BESTIARY_DIFFICULTIES,
    BESTIARY_DIFFICULTY_ICONS,
    formatDifficultyDelta,
    isDifficultyNeutral,
    LEVEL_WEIGHT_FLOOR,
    scaleToDifficulty,
    winRate,
    type BattleSample,
    type BestiaryDifficulty,
    type BestiaryScope,
  } from '../lib/bestiaryDifficulty';
  import {
    applyRpgBestiaryDifficulty,
    applyRpgShopDifficulty,
    exportRpgBestiary,
    importRpgBestiary,
    fetchRpgRaid,
    saveRpgRaidBoss,
    deleteRpgRaidBoss,
    restoreRpgRaidBosses,
    startRpgRaid,
    fetchRpgQuests,
    fetchRpgRecipes,
    saveRpgRecipe,
    deleteRpgRecipe,
    saveRpgQuest,
    deleteRpgQuest,
    fetchEconomyConfig,
    updateEconomyConfig,
    fetchRpgChannels,
    updateRpgChannels,
    fetchGamblingGames,
    updateGamblingGames,
    fetchRpgItems,
    saveRpgItem,
    deleteRpgItem,
    fetchRpgMonsters,
    saveRpgMonster,
    setRpgMonsterEnabled,
    deleteRpgMonster,
    fetchRpgPlayers,
    updateRpgPlayer,
    fetchRpgTitles,
    saveRpgTitle,
    deleteRpgTitle,
    grantRpgTitle,
    revokeRpgTitle,
    resetEconomy
  } from '../lib/api';
  import { m } from '../lib/i18n';

  const actionState = createAsyncActionState();
  let loading = $state(false);
  // Une configuration qui ne se charge pas laissait la page afficher ses valeurs par
  // defaut : tout paraissait eteint, et activer le module echouait a l'enregistrement sans
  // que rien n'explique pourquoi.
  let loadFailed = $state(false);

  // Page publique unifiee des clans : elle vit hors du dashboard connecte, donc rien ne
  // l'atteint depuis le menu. Le lien se pose ici, visible depuis tous les onglets, comme
  // les pages Niveaux et Prestige exposent le leur.
  let publicUrlCopied = $state(false);
  const publicRpgUrl = $derived(
    authStore.selectedGuildId
      ? `${window.location.origin}/${authStore.selectedGuildId}/clan-rpg`
      : ''
  );

  async function copyPublicRpgUrl() {
    if (!publicRpgUrl) return;
    await navigator.clipboard.writeText(publicRpgUrl);
    publicUrlCopied = true;
    setTimeout(() => { publicUrlCopied = false; }, 2000);
  }
  // Economie et Jeu RPG sont deux pages du menu qui partagent ce composant :
  // l'une porte la monnaie et la boutique, l'autre le jeu. Onze onglets sur
  // une seule barre ne laissaient plus voir ce que la page contenait.
  const { section = 'economy' }: { section?: 'economy' | 'rpg' } = $props();
  const ECONOMY_TABS = ['config', 'items', 'blackmarket', 'players'] as const;
  const RPG_TABS = ['recettes', 'bestiaire', 'donjons', 'tour', 'peche', 'raid', 'quetes', 'titres', 'aventures', 'guildes'] as const;
  const BASE = $derived(section === 'rpg' ? '/rpg' : '/economy');
  const DEFAULT_TAB = $derived(section === 'rpg' ? RPG_TABS[0] : ECONOMY_TABS[0]);
  // Pose par l'effet ci-dessous, avant le premier rendu.
  let activeTab = $state<string>('');

  $effect.pre(() => {
    const path = $router.path;
    if (section === 'rpg') {
      activeTab = resolveTabFromUrl('/rpg', RPG_TABS, 'recettes');
      return;
    }
    // Les anciens liens (/economy/bestiaire, favoris compris) menent au jeu.
    const segment = path.startsWith('/economy/') ? path.slice('/economy/'.length).split('/')[0] : '';
    if ((RPG_TABS as readonly string[]).includes(segment)) {
      router.goto(`/rpg/${segment}`, true);
      return;
    }
    activeTab = resolveTabFromUrl('/economy', ECONOMY_TABS, 'config');
  });

  const canManageSettings = $derived(
    !!dashboardStore.state.featureAccess?.economy?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
  );

  const DEFAULT_CONFIG = {
    enabled: false,
    rpgEnabled: false,
    guildsEnabled: false,
    shopEnabled: false,
    currencyName: 'KotboCoins',
    currencyEmoji: '🪙',
    currencyIcon: null as string | null,
    dailyRewardMin: 50,
    dailyRewardMax: 150,
    dailyCooldownHour: 20,
    adventureCooldownMin: 30,
    fightCooldownSec: 120,
    bossCooldownMin: 2,
    huntEnergyPercent: 150,
    huntCooldownPercent: 200,
    firstKillAnnounce: 'NONE',
    firstKillChannelId: null as string | null,
    maxEnergy: 100,
    energyRecoveryPerHour: 10,
    maxBetAmount: 1000,
    maxDailyBets: 20,
    maxTransferAmount: 5000,
    transferCooldownMin: 15,
    marketplaceTaxPercent: 5,
    blackMarketEnabled: false,
    blackMarketIntervalDays: 7,
    blackMarketDurationMin: 120,
    blackMarketOfferCount: 4,
    blackMarketMaxQuantity: 3,
    blackMarketDiscountMin: 20,
    blackMarketDiscountMax: 50,
    blackMarketAnnounce: 'NONE',
    blackMarketChannelId: null as string | null,
    blackMarketRoleId: null as string | null,
    // Réglages portés par la guilde et non par la config économique : `clansEnabled` est
    // en lecture seule ici, il dit seulement s'il faut proposer les points de clan.
    clansEnabled: false,
    clanPointsFromRpg: false,
    levelingEnabled: false,
    bossDifficulty: 'NORMAL',
    monsterDifficulty: 'NORMAL',
    shopDifficulty: 'NORMAL',
    raidEnabled: false,
    raidAutoSchedule: true,
    raidTeamMode: 'CLAN',
    raidBossName: null as string | null,
    raidHealthPerMember: 1200,
    raidHealthFloor: 2500,
    raidHealthCap: 60000,
    raidAssaultsPerMember: 3,
    raidBoughtAssaultsMax: 3,
    raidConsolationShare: 25,
    raidEnergyCost: 25,
    raidWeekday: 6,
    raidHour: 20,
    raidDurationHours: 24,
    raidXpReward: 60,
    raidCoinReward: 45,
    raidClanPoints: 6,
    raidAnnounce: 'CHANNEL',
    raidChannelId: null as string | null,
    raidRoleId: null as string | null
  };

  // Configuration state
  let config = $state(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));

  let savedConfig = $state(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));

  // Shop items list
  let items = $state<any[]>([]);
  let itemsLoading = $state(false);
  let editingItem = $state<any>(null); // For Item Modal

  type ItemFilter = 'all' | 'WEAPON' | 'ARMOR' | 'ACCESSORY' | 'POTION' | 'MATERIAL' | 'SCROLL' | 'QUEST';
  const ITEM_FILTER_LABELS: Record<Exclude<ItemFilter, 'all'>, () => string> = {
    WEAPON: m.eco_items_filter_weapon,
    ARMOR: m.eco_items_filter_armor,
    ACCESSORY: m.eco_items_filter_accessory,
    POTION: m.eco_items_filter_potion,
    MATERIAL: m.eco_items_filter_material,
    SCROLL: m.eco_items_filter_scroll,
    QUEST: m.eco_items_filter_quest,
  };
  let itemFilter = $state<ItemFilter>('all');
  // Un type sans aucun objet n'a pas d'onglet : il n'afficherait qu'une liste vide.
  const itemFilters = $derived(
    (Object.keys(ITEM_FILTER_LABELS) as Exclude<ItemFilter, 'all'>[]).filter((type) => items.some((item) => item.type === type))
  );
  // Retombe sur « Tout » quand le type choisi n'a plus d'objet (dernier supprimé, autre
  // serveur sélectionné) : sinon aucun onglet n'est actif et la grille reste vide.
  const activeItemFilter = $derived<ItemFilter>(
    itemFilter !== 'all' && itemFilters.includes(itemFilter) ? itemFilter : 'all'
  );
  const filteredItems = $derived(activeItemFilter === 'all' ? items : items.filter((item) => item.type === activeItemFilter));

  const rarityLabels = $derived<Record<string, string>>({
    COMMON: m.eco_rarity_common(),
    UNCOMMON: m.eco_rarity_uncommon(),
    RARE: m.eco_rarity_rare(),
    EPIC: m.eco_rarity_epic(),
    LEGENDARY: m.eco_rarity_legendary(),
  });

  // Bestiaire (monstres et boss)
  const DROPS_MAX = 8;
  let monsters = $state<any[]>([]);
  let monstersLoading = $state(false);
  let editingMonster = $state<any>(null);
  let bestiaryFilter = $state<'all' | 'boss' | 'monster'>('boss');

  // Renseignes par la liste du bestiaire : taux de victoire observe et palier qu'il suggere.
  const EMPTY_SAMPLE: BattleSample = { battles: 0, wins: 0 };
  let battleStatsDays = $state(30);
  let battleSamples = $state<Record<BestiaryScope, BattleSample>>({ boss: EMPTY_SAMPLE, monster: EMPTY_SAMPLE });
  let difficultyAdvice = $state<Record<BestiaryScope, BestiaryDifficulty | null>>({ boss: null, monster: null });
  let bestiaryFileInput = $state<HTMLInputElement | null>(null);

  // Titres RPG
  let titles = $state<any[]>([]);
  let titlesLoading = $state(false);
  let editingTitle = $state<any>(null);
  // Membre choisi dans le selecteur d'attribution, par titre.
  let titleGrantPick = $state<Record<string, string | null>>({});

  // Quetes RPG
  let quests = $state<any[]>([]);
  let questObjectives = $state<string[]>([]);
  let questsLoading = $state(false);
  let editingQuest = $state<any>(null);

  // Raid hebdomadaire
  let raidBosses = $state<any[]>([]);
  let raidSpells = $state<any[]>([]);
  let raidState = $state<any>(null);
  // Bilan du dernier raid clos, servi par l'API tant qu'il a moins d'un jour.
  let raidRecap = $state<any>(null);
  /** Raids clos, du plus récent au plus ancien. Ne périme pas, contrairement au bilan. */
  let raidHistory = $state<any[]>([]);

  // Le bilan détaille déjà la dernière fenêtre : la répéter juste en dessous, en une ligne,
  // ferait lire deux fois le même raid.
  const pastRaids = $derived(raidHistory.filter((past) => past.id !== raidRecap?.raid?.id));
  let raidLoading = $state(false);
  let editingRaidBoss = $state<any>(null);

  // Players list
  let players = $state<any[]>([]);
  let playersLoading = $state(false);
  let editingPlayer = $state<any>(null); // For Player Modal
  let searchQuery = $state('');

  // Reset component state
  let resetComponent = $state<'all' | 'profiles' | 'items' | 'config' | 'guilds' | 'bestiary' | 'titles' | null>(null);
  let resetConfirmInput = $state('');

  // La confirmation affichait la cle technique du composant (« profiles », « guilds »).
  const resetComponentLabels = $derived<Record<string, string>>({
    all: m.eco_reset_all_btn(),
    profiles: m.eco_reset_players_btn(),
    items: m.eco_reset_items_btn(),
    config: m.eco_reset_config_btn(),
    guilds: m.eco_reset_guilds_btn(),
    bestiary: m.eco_reset_bestiary_btn(),
    titles: m.eco_reset_titles_btn(),
  });

  function triggerReset(component: 'all' | 'profiles' | 'items' | 'config' | 'guilds' | 'bestiary' | 'titles') {
    resetComponent = component;
    resetConfirmInput = '';
  }

  // Le mot est compare sans tenir compte de la casse ni des espaces autour : on cherche une
  // intention deliberee, pas une dictee.
  const resetConfirmed = $derived(
    resetConfirmInput.trim().toUpperCase() === m.eco_reset_confirm_word().toUpperCase()
  );

  async function confirmReset() {
    if (!resetComponent || !resetConfirmed) return;
    const comp = resetComponent;
    resetComponent = null;
    resetConfirmInput = '';

    await actionState.run(async () => {
      await resetEconomy(comp);
      // Vider le bestiaire ou la boutique remet aussi leur palier de difficulte a zero :
      // sans relecture, la page continuerait d'annoncer un palier que plus rien ne porte.
      if (comp === 'config' || comp === 'all' || comp === 'bestiary' || comp === 'items') {
        const res = await fetchEconomyConfig();
        if (res && res.config) {
          config = res.config;
          savedConfig = JSON.parse(JSON.stringify(res.config));
        }
      }
      if (comp === 'items' || comp === 'all') {
        if (activeTab === 'items') await loadItems();
      }
      if (comp === 'bestiary' || comp === 'all') {
        if (activeTab === 'bestiaire') await loadMonsters();
      }
      // Les fiches de monstre citent les titres : la liste en mémoire doit suivre.
      if (comp === 'titles' || comp === 'all') await loadTitles();
      if (comp === 'profiles' || comp === 'guilds' || comp === 'all') {
        // La suppression des guildes RPG detache les joueurs : la colonne du tableau
        // afficherait encore l'appartenance sans ce rechargement.
        if (activeTab === 'players') await loadPlayers();
      }
      return true;
    }, { successMessage: m.eco_toast_reset_success() });
  }

  // Salons RPG : stockés avec les restrictions de commandes et non dans la configuration
  // de l'économie, d'où un état et un enregistrement à part, sous la même barre.
  let rpgChannelIds = $state<string[]>([]);
  let savedRpgChannelIds = $state<string[]>([]);
  let rpgChannelsDiverged = $state(false);
  const rpgChannelsDirty = $derived(
    [...rpgChannelIds].sort().join(',') !== [...savedRpgChannelIds].sort().join(',')
  );

  async function loadRpgChannels() {
    const res = await fetchRpgChannels().catch(() => null);
    if (!res) return;
    rpgChannelIds = [...res.channelIds];
    savedRpgChannelIds = [...res.channelIds];
    rpgChannelsDiverged = res.diverged;
  }

  // Jeux d'argent : eux aussi sur les restrictions de commandes, enregistrés sous la même barre.
  const GAMBLING_GAMES = ['dice', 'roulette', 'rps', 'guess'] as const;
  const allGamesOpen = () => Object.fromEntries(GAMBLING_GAMES.map((game) => [game, true])) as Record<string, boolean>;
  let gamblingGames = $state<Record<string, boolean>>(allGamesOpen());
  let savedGamblingGames = $state<Record<string, boolean>>(allGamesOpen());
  const gamblingDirty = $derived(GAMBLING_GAMES.some((game) => gamblingGames[game] !== savedGamblingGames[game]));
  const allGamblingOpen = $derived(GAMBLING_GAMES.every((game) => gamblingGames[game]));

  async function loadGamblingGames() {
    const res = await fetchGamblingGames().catch(() => null);
    if (!res?.games) return;
    gamblingGames = { ...res.games };
    savedGamblingGames = { ...res.games };
  }

  function setAllGambling(open: boolean) {
    gamblingGames = Object.fromEntries(GAMBLING_GAMES.map((game) => [game, open]));
  }

  const configDirty = $derived(JSON.stringify(config) !== JSON.stringify(savedConfig) || rpgChannelsDirty || gamblingDirty);

  // Unsaved changes tracker
  $effect(() => {
    const dirty = configDirty;
    if (dirty && canManageSettings) {
      untrack(() => {
        unsavedChanges.register({
          id: 'economy',
          label: 'Économie & RPG',
          onSave: () => handleSaveConfig(),
          onReset: () => {
            config = JSON.parse(JSON.stringify(savedConfig));
            rpgChannelIds = [...savedRpgChannelIds];
            gamblingGames = { ...savedGamblingGames };
          }
        });
      });
    } else if (!dirty) {
      untrack(() => {
        unsavedChanges.release('economy');
      });
    }
  });

  onDestroy(() => {
    unsavedChanges.release('economy');
  });

  onMount(async () => {
    loading = true;
    try {
      await dashboardStore.refresh();
      const [res] = await Promise.all([fetchEconomyConfig(), loadRpgChannels(), loadGamblingGames()]);
      if (res && res.config) {
        config = res.config;
        savedConfig = JSON.parse(JSON.stringify(res.config));
      } else {
        loadFailed = true;
      }
    } catch (err) {
      console.error(err);
      loadFailed = true;
    } finally {
      loading = false;
    }
  });

  // Tab change triggers loaders
  $effect(() => {
    if (activeTab === 'items') {
      void loadItems();
    } else if (activeTab === 'bestiaire') {
      // Le catalogue d'objets sert à composer le butin : sans lui, la fiche d'une
      // créature ne pourrait proposer aucun drop.
      void loadItems();
      void loadMonsters();
      // Les titres alimentent les deux recompenses de titre de la fiche.
      void loadTitles();
    } else if (activeTab === 'titres') {
      void loadTitles();
      // La liste des joueurs sert au selecteur d'attribution.
      void loadPlayers();
    } else if (activeTab === 'raid') {
      void loadRaid();
    } else if (activeTab === 'recettes') {
      // Le catalogue sert à choisir l'objet fabriqué comme ses matériaux : sans lui, la
      // fiche d'une recette n'aurait rien à proposer.
      void loadItems();
      void loadRecipes();
    } else if (activeTab === 'quetes') {
      void loadQuests();
    } else if (activeTab === 'players') {
      void loadPlayers();
    }
  });

  async function loadItems() {
    itemsLoading = true;
    try {
      const res = await fetchRpgItems();
      if (res && res.items) {
        items = res.items;
      }
    } catch (err) {
      console.error(err);
    } finally {
      itemsLoading = false;
    }
  }

  async function loadMonsters() {
    monstersLoading = true;
    try {
      const res = await fetchRpgMonsters();
      if (res && res.monsters) {
        monsters = res.monsters;
        battleStatsDays = res.battleStatsDays ?? battleStatsDays;
        battleSamples = {
          boss: res.samples?.boss ?? EMPTY_SAMPLE,
          monster: res.samples?.monster ?? EMPTY_SAMPLE,
        };
        difficultyAdvice = {
          boss: asAdvice(res.recommendations?.boss),
          monster: asAdvice(res.recommendations?.monster),
        };
      }
    } catch (err) {
      console.error(err);
    } finally {
      monstersLoading = false;
    }
  }

  // Le serveur renvoie `null` tant qu'il n'a pas assez de combats pour conseiller quoi que ce soit.
  function asAdvice(value: unknown): BestiaryDifficulty | null {
    return BESTIARY_DIFFICULTIES.includes(value as BestiaryDifficulty) ? (value as BestiaryDifficulty) : null;
  }

  /** Même plafond que la validation du bot : la page ne doit pas proposer un refus. */
  const RECIPE_INGREDIENTS_MAX = 6;

  let recipes = $state<any[]>([]);
  let recipesLoading = $state(false);
  let editingRecipe = $state<any>(null);

  async function loadRecipes() {
    recipesLoading = true;
    try {
      const res = await fetchRpgRecipes();
      if (res) recipes = res.recipes ?? [];
    } catch (err) {
      console.error(err);
    } finally {
      recipesLoading = false;
    }
  }

  /** Objets que ce serveur peut utiliser : son catalogue et celui livré de base. */
  const guildItems = $derived(items);

  /**
   * Options de liste désignant un objet par son nom, comme les butins et les recettes.
   *
   * Un serveur peut créer un objet du même nom qu'un objet livré : sans dédoublonnage, la
   * liste recevait deux options de même identifiant et Svelte refuse une clé en double.
   * L'objet du serveur l'emporte, comme côté bot.
   */
  function itemNameOptions(source: any[]) {
    const byName = new Map<string, any>();
    for (const item of source) {
      if (!byName.has(item.name) || item.guildId) byName.set(item.name, item);
    }
    return [...byName.values()].map((item) => ({ id: item.name, name: `${item.emoji} ${item.name}` }));
  }

  // Seuls les matériaux sont proposés, sauf un objet d'un autre type déjà posé sur la
  // recette : le retirer de la liste viderait le champ à l'ouverture de la fiche.
  const recipeMaterialOptions = $derived(
    itemNameOptions(
      items
        .filter((item) => item.type === 'MATERIAL' || editingRecipe?.ingredients.some((ing: any) => ing.itemName === item.name))
        .sort((a, b) => a.name.localeCompare(b.name))
    )
  );

  function blankRecipe() {
    return {
      resultItemId: guildItems[0]?.id ?? '',
      ingredients: [{ itemName: '', quantity: 1 }],
      coinCost: 0,
      levelRequired: 1,
    };
  }

  function addRecipeIngredient() {
    if (editingRecipe.ingredients.length >= RECIPE_INGREDIENTS_MAX) return;
    editingRecipe.ingredients = [...editingRecipe.ingredients, { itemName: '', quantity: 1 }];
  }

  function removeRecipeIngredient(index: number) {
    editingRecipe.ingredients = editingRecipe.ingredients.filter((_: unknown, i: number) => i !== index);
  }

  async function handleSaveRecipe() {
    if (!editingRecipe.resultItemId) {
      toast.error(m.eco_recipe_result_required());
      return;
    }
    if (editingRecipe.ingredients.some((ing: any) => !ing.itemName)) {
      toast.error(m.eco_recipe_material_required());
      return;
    }

    await actionState.run(async () => {
      const res = await saveRpgRecipe({
        id: editingRecipe.id,
        resultItemId: editingRecipe.resultItemId,
        ingredients: editingRecipe.ingredients,
        coinCost: editingRecipe.coinCost,
        levelRequired: editingRecipe.levelRequired,
      });
      if (!res) throw new Error(m.eco_recipe_save_error());
      editingRecipe = null;
      await loadRecipes();
      return true;
    }, { successMessage: m.eco_recipe_saved() });
  }

  async function handleDeleteRecipe(recipeId: string) {
    await actionState.run(async () => {
      const res = await deleteRpgRecipe(recipeId);
      if (!res) throw new Error(m.eco_recipe_delete_error());
      await loadRecipes();
      return true;
    }, { successMessage: m.eco_recipe_deleted() });
  }

  async function loadTitles() {
    titlesLoading = true;
    try {
      const res = await fetchRpgTitles();
      if (res) titles = res.titles ?? [];
    } catch (err) {
      console.error(err);
    } finally {
      titlesLoading = false;
    }
  }

  const titleOptions = $derived(titles.map((title: any) => ({ id: title.id, name: title.name })));

  function titleName(titleId: string | null | undefined): string | null {
    if (!titleId) return null;
    return titles.find((title: any) => title.id === titleId)?.name ?? null;
  }

  function titleBonusBadges(title: any): { label: string; value: string }[] {
    return [
      { label: m.eco_atk(), value: title.attackBonus },
      { label: m.eco_def(), value: title.defenseBonus },
      { label: m.eco_spd(), value: title.speedBonus },
      { label: m.eco_bestiary_health(), value: title.healthBonus },
      { label: m.eco_title_crit(), value: title.critBonus ? `${title.critBonus} %` : 0 },
    ]
      .filter((entry) => entry.value)
      .map((entry) => ({ label: entry.label, value: `+${entry.value}` }));
  }

  function openNewTitle() {
    editingTitle = {
      name: '',
      description: '',
      color: '#fbbf24',
      attackBonus: 0,
      defenseBonus: 0,
      speedBonus: 0,
      healthBonus: 0,
      critBonus: 0,
    };
  }

  function openEditTitle(title: any) {
    editingTitle = { ...title };
  }

  async function handleSaveTitle() {
    if (!editingTitle.name?.trim()) {
      toast.error(m.eco_toast_missing_fields());
      return;
    }

    await actionState.run(async () => {
      const res = await saveRpgTitle({
        id: editingTitle.id,
        name: editingTitle.name,
        description: editingTitle.description,
        color: editingTitle.color,
        attackBonus: Number(editingTitle.attackBonus) || 0,
        defenseBonus: Number(editingTitle.defenseBonus) || 0,
        speedBonus: Number(editingTitle.speedBonus) || 0,
        healthBonus: Number(editingTitle.healthBonus) || 0,
        critBonus: Number(editingTitle.critBonus) || 0,
      });
      if (res && res.title) {
        await loadTitles();
        editingTitle = null;
      }
      return true;
    });
  }

  async function handleDeleteTitle(title: any) {
    if (!(await confirmDialog.danger(m.eco_title_delete_confirm({ name: title.name })))) return;

    await actionState.run(async () => {
      await deleteRpgTitle(title.id);
      await loadTitles();
      return true;
    });
  }

  async function handleGrantTitle(title: any) {
    const userId = titleGrantPick[title.id];
    if (!userId) return;

    await actionState.run(async () => {
      const res = await grantRpgTitle(title.id, userId);
      if (res) {
        titleGrantPick[title.id] = null;
        await loadTitles();
      }
      return true;
    });
  }

  async function handleRevokeTitle(title: any, owner: any) {
    if (!(await confirmDialog.danger(m.eco_title_revoke_confirm({ name: title.name, player: owner.displayName })))) return;

    await actionState.run(async () => {
      await revokeRpgTitle(title.id, owner.userId);
      await loadTitles();
      return true;
    });
  }

  async function loadQuests() {
    questsLoading = true;
    try {
      const res = await fetchRpgQuests();
      if (res) {
        quests = res.quests ?? [];
        questObjectives = res.objectives ?? [];
      }
    } catch (err) {
      console.error(err);
    } finally {
      questsLoading = false;
    }
  }

  const QUEST_OBJECTIVE_LABELS: Record<string, () => string> = {
    MONSTER_KILLS: m.eco_quest_obj_monsters,
    BOSS_KILLS: m.eco_quest_obj_bosses,
    RAID_ASSAULTS: m.eco_quest_obj_raid_assaults,
    RAID_DAMAGE: m.eco_quest_obj_raid_damage,
    ITEMS_LOOTED: m.eco_quest_obj_items,
    FISH_CAUGHT: m.eco_quest_obj_fish,
    ITEMS_CRAFTED: m.eco_quest_obj_crafted,
    UPGRADES_SUCCEEDED: m.eco_quest_obj_upgrades,
    SHOP_PURCHASES: m.eco_quest_obj_shop,
    BLACK_MARKET_PURCHASES: m.eco_quest_obj_black_market,
    COINS_SPENT: m.eco_quest_obj_coins_spent,
    ADVENTURES_COMPLETED: m.eco_quest_obj_adventures,
    DAILY_CLAIMS: m.eco_quest_obj_daily,
    TOWER_FLOORS: m.eco_quest_obj_tower_floors,
    TOWER_MONSTER_KILLS: m.eco_quest_obj_tower_monsters,
    TOWER_BOSS_KILLS: m.eco_quest_obj_tower_bosses,
  };

  function questObjectiveLabel(objective: string): string {
    return QUEST_OBJECTIVE_LABELS[objective]?.() ?? objective;
  }

  function blankQuest() {
    return {
      name: '',
      description: '',
      emoji: '📜',
      objective: questObjectives[0] ?? 'MONSTER_KILLS',
      target: 10,
      scope: 'MEMBER',
      teamMode: 'CLAN',
      repeatable: false,
      windowHours: 24,
      rewardCoins: 100,
      rewardXp: 50,
      rewardClanPoints: 0,
      enabled: true,
    };
  }

  function openNewQuest() {
    editingQuest = blankQuest();
  }

  function openEditQuest(quest: any) {
    editingQuest = { ...quest };
  }

  async function handleSaveQuest() {
    if (!editingQuest.name?.trim() || !editingQuest.description?.trim()) {
      toast.error(m.eco_toast_missing_fields());
      return;
    }
    // Une quete d'equipe sans module d'equipe ne compterait jamais rien : aucun membre ne
    // pourrait etre rattache a quoi que ce soit. Le serveur refuse la meme combinaison.
    const teamAvailable = editingQuest.teamMode === 'CLAN' ? config.clansEnabled : config.guildsEnabled;
    if (editingQuest.scope === 'TEAM' && !teamAvailable) {
      toast.error(m.eco_quest_team_unavailable());
      return;
    }

    await actionState.run(async () => {
      const res = await saveRpgQuest({
        id: editingQuest.id,
        name: editingQuest.name,
        description: editingQuest.description,
        emoji: editingQuest.emoji,
        objective: editingQuest.objective,
        target: editingQuest.target,
        scope: editingQuest.scope,
        teamMode: editingQuest.teamMode,
        repeatable: editingQuest.repeatable,
        windowHours: editingQuest.windowHours,
        rewardCoins: editingQuest.rewardCoins,
        rewardXp: editingQuest.rewardXp,
        rewardClanPoints: editingQuest.rewardClanPoints,
        enabled: editingQuest.enabled,
      });
      if (res && res.quest) {
        await loadQuests();
        editingQuest = null;
      }
      return true;
    }, { successMessage: m.eco_quest_toast_saved() });
  }

  async function handleDeleteQuest(quest: any) {
    if (!(await confirmDialog.danger(m.eco_quest_delete_confirm({ name: quest.name })))) return;

    await actionState.run(async () => {
      await deleteRpgQuest(quest.id);
      await loadQuests();
      return true;
    }, { successMessage: m.eco_quest_toast_deleted() });
  }

  async function loadRaid() {
    raidLoading = true;
    try {
      const res = await fetchRpgRaid();
      if (res) {
        raidBosses = res.bosses ?? [];
        raidSpells = res.spells ?? [];
        raidState = res.state ?? null;
        raidRecap = res.recap ?? null;
        raidHistory = res.history ?? [];
      }
    } catch (err) {
      console.error(err);
    } finally {
      raidLoading = false;
    }
  }

  function blankRaidBoss() {
    return {
      name: '',
      description: '',
      emoji: '🐲',
      level: 20,
      attack: 60,
      defense: 35,
      speed: 20,
      spellIds: [] as string[],
      enabled: true,
    };
  }

  function openNewRaidBoss() {
    editingRaidBoss = blankRaidBoss();
  }

  function openEditRaidBoss(boss: any) {
    editingRaidBoss = { ...boss, spellIds: (boss.spells ?? []).map((spell: any) => spell.id) };
  }

  function toggleRaidSpell(spellId: string) {
    const chosen = editingRaidBoss.spellIds ?? [];
    editingRaidBoss.spellIds = chosen.includes(spellId)
      ? chosen.filter((id: string) => id !== spellId)
      : [...chosen, spellId];
  }

  async function handleSaveRaidBoss() {
    if (!editingRaidBoss.name?.trim() || !editingRaidBoss.description?.trim()) {
      toast.error(m.eco_toast_missing_fields());
      return;
    }

    await actionState.run(async () => {
      const res = await saveRpgRaidBoss({
        id: editingRaidBoss.id,
        name: editingRaidBoss.name,
        description: editingRaidBoss.description,
        emoji: editingRaidBoss.emoji,
        level: editingRaidBoss.level,
        attack: editingRaidBoss.attack,
        defense: editingRaidBoss.defense,
        speed: editingRaidBoss.speed,
        spellIds: editingRaidBoss.spellIds ?? [],
        enabled: editingRaidBoss.enabled,
      });
      if (res && res.boss) {
        await loadRaid();
        editingRaidBoss = null;
      }
      return true;
    }, { successMessage: m.eco_raid_toast_boss_saved() });
  }

  async function handleDeleteRaidBoss(boss: any) {
    if (!(await confirmDialog.danger(m.eco_raid_delete_confirm({ name: boss.name })))) return;

    await actionState.run(async () => {
      await deleteRpgRaidBoss(boss.id);
      await loadRaid();
      return true;
    }, { successMessage: m.eco_raid_toast_boss_deleted() });
  }

  // Un lancement manuel ouvre la fenetre sur-le-champ : il ne se confirme pas, il
  // s'annonce a tout le serveur, et rien ne permet de le reprendre.
  async function handleStartRaid() {
    if (!canManageSettings || !config.enabled || !config.raidEnabled || configDirty) return;

    const confirmed = await confirmDialog.ask({
      title: m.eco_raid_start_confirm_title(),
      description: m.eco_raid_start_confirm_desc({ hours: config.raidDurationHours }),
      confirmLabel: m.eco_raid_start(),
      variant: 'warning',
    });
    if (!confirmed) return;

    await actionState.run(async () => {
      const res = await startRpgRaid();
      if (!res || !res.success) throw new Error('Le raid n\'a pas pu être lancé.');
      await loadRaid();
      return true;
    }, { successMessage: m.eco_raid_toast_started() });
  }

  async function handleRestoreRaidBosses() {
    await actionState.run(async () => {
      const res = await restoreRpgRaidBosses();
      if (!res) throw new Error('Restauration impossible.');
      await loadRaid();
      if (res.restored === 0) toast.info(m.eco_raid_restore_none());
      return true;
    }, { successMessage: m.eco_raid_toast_restored() });
  }

  const selectableRaidBosses = $derived(raidBosses.filter((boss: any) => boss.enabled));

  // Un boss fixe puis desactive ne figure plus dans la liste : sans cette option, le
  // selecteur s'affichait vide et rien ne disait que le raid etait retombe sur le tirage
  // au sort. Le catalogue vide, lui, ne dit rien tant qu'il n'a pas fini de charger.
  const unavailableRaidBoss = $derived(
    !raidLoading
      && raidBosses.length > 0
      && config.raidBossName
      && !selectableRaidBosses.some((boss: any) => boss.name === config.raidBossName)
      ? config.raidBossName
      : null,
  );

  // Une <option> ne rend pas d'image : un emoji personnalise du serveur y serait lu comme
  // son code source. Il est retire plutot qu'affiche brut.
  function bossOptionLabel(boss: any): string {
    const emoji = stripCustomEmoji(boss.emoji);
    return emoji ? `${emoji} ${boss.name}` : boss.name;
  }

  // Le mode clan demande le module Clans ; le mode guilde RPG demande les guildes du jeu.
  // Sans le module correspondant, le raid n'aurait aucune equipe a opposer.
  const raidTeamModeAvailable = $derived({
    CLAN: !!config.clansEnabled,
    RPG_GUILD: !!config.guildsEnabled,
  });

  // Points d'équipe : ils vont au clan du serveur ou à la guilde du jeu selon le mode, et
  // c'est le module correspondant qui décide si le champ est saisissable.
  const raidGuildMode = $derived(config.raidTeamMode === 'RPG_GUILD');
  const questGuildMode = $derived(editingQuest?.scope === 'TEAM' && editingQuest?.teamMode === 'RPG_GUILD');

  const raidWeekdayLabels = $derived([
    m.eco_raid_day_sunday(), m.eco_raid_day_monday(), m.eco_raid_day_tuesday(), m.eco_raid_day_wednesday(),
    m.eco_raid_day_thursday(), m.eco_raid_day_friday(), m.eco_raid_day_saturday(),
  ]);

  function raidHealthPreview(members: number): number {
    const floor = Number(config.raidHealthFloor) || 0;
    const cap = Math.max(floor, Number(config.raidHealthCap) || 0);
    return Math.min(cap, Math.max(floor, members * (Number(config.raidHealthPerMember) || 0)));
  }

  async function loadPlayers() {
    playersLoading = true;
    try {
      const res = await fetchRpgPlayers();
      if (res && res.players) {
        players = res.players;
      }
    } catch (err) {
      console.error(err);
    } finally {
      playersLoading = false;
    }
  }

  /*
   * Deux interrupteurs gardent l'economie, et le bot exige les deux : le module
   * (menu de ModulePage, garde des commandes) et `EconomyConfig.enabled`, que
   * /daily, /rpg et les jeux d'argent lisent avant de repondre. Le second n'est
   * plus un interrupteur d'en-tete : c'est une pause, montree en encadre quand
   * elle est active et proposee en bas de la configuration sinon.
   */
  const economyModuleActive = $derived(
    (dashboardStore.state.modules as any[]).find((mod) => mod.id === 'economy')?.status === 'active'
  );

  async function setEconomyRunning(running: boolean) {
    if (!canManageSettings) return;
    if (!running) {
      const confirmed = await confirmDialog.ask({
        title: m.eco_pause_confirm_title(),
        description: m.eco_pause_confirm_desc(),
        confirmLabel: m.eco_pause_action(),
        variant: 'warning',
      });
      if (!confirmed) return;
    }
    await actionState.run(async () => {
      // Envoi partiel : le reste du formulaire, peut-etre en cours d'edition,
      // n'est ni enregistre ni ecrase.
      const res = await updateEconomyConfig({ enabled: running });
      if (!res || !res.config) throw new Error(m.eco_pause_error());
      config.enabled = running;
      savedConfig.enabled = running;
      return true;
    }, { successMessage: running ? m.eco_resumed_toast() : m.eco_paused_toast() });
  }

  async function handleSaveConfig(): Promise<boolean> {
    if (!canManageSettings) return false;
    if (config.dailyRewardMax < config.dailyRewardMin) {
      toast.error(m.eco_toast_daily_invalid());
      return false;
    }
    if (config.blackMarketDiscountMax < config.blackMarketDiscountMin) {
      toast.error(m.eco_toast_bm_discount_invalid());
      return false;
    }
    // Le serveur refuse déjà ces combinaisons ; les intercepter ici évite un aller-retour
    // et une erreur brute pour ce qui reste une case oubliée.
    if (config.blackMarketAnnounce !== 'NONE' && !config.blackMarketChannelId) {
      toast.error(m.eco_toast_bm_channel_required());
      return false;
    }
    if (config.blackMarketAnnounce === 'CHANNEL_ROLE' && !config.blackMarketRoleId) {
      toast.error(m.eco_toast_bm_role_required());
      return false;
    }
    if (config.firstKillAnnounce !== 'NONE' && !config.firstKillChannelId) {
      toast.error(m.eco_toast_first_kill_channel_required());
      return false;
    }
    // Le raid se joue depuis le bouton de son annonce : sans annonce ni salon, la fenetre
    // s'ouvre et se referme sans que personne n'ait pu frapper.
    if (config.raidEnabled && config.raidAnnounce === 'NONE') {
      toast.error(m.eco_toast_raid_announce_required());
      return false;
    }
    if (config.raidEnabled && !config.raidChannelId) {
      toast.error(m.eco_toast_raid_channel_required());
      return false;
    }
    if (config.raidEnabled && config.raidAnnounce === 'CHANNEL_ROLE' && !config.raidRoleId) {
      toast.error(m.eco_toast_raid_role_required());
      return false;
    }
    // Un raid ne peut pas opposer des equipes que le serveur n'a pas : le bot refuse la
    // meme combinaison, autant la dire ici plutot que de faire echouer l'enregistrement.
    if (config.raidEnabled && !raidTeamModeAvailable[config.raidTeamMode as 'CLAN' | 'RPG_GUILD']) {
      toast.error(m.eco_toast_raid_team_mode_off());
      return false;
    }

    let success = false;
    await actionState.run(async () => {
      if (JSON.stringify(config) !== JSON.stringify(savedConfig)) {
        const res = await updateEconomyConfig(config);
        if (!res || !res.config) throw new Error('Erreur de sauvegarde de la configuration.');
        config = res.config;
        savedConfig = JSON.parse(JSON.stringify(res.config));
      }
      if (rpgChannelsDirty) {
        const res = await updateRpgChannels(rpgChannelIds);
        if (!res) throw new Error('Erreur de sauvegarde des salons RPG.');
        rpgChannelIds = [...res.channelIds];
        savedRpgChannelIds = [...res.channelIds];
        rpgChannelsDiverged = res.diverged;
      }
      if (gamblingDirty) {
        const res = await updateGamblingGames(gamblingGames);
        if (!res?.games) throw new Error("Erreur de sauvegarde des jeux d'argent.");
        gamblingGames = { ...res.games };
        savedGamblingGames = { ...res.games };
      }
      success = true;
      return true;
    }, { successMessage: m.eco_toast_config_saved() });
    return success;
  }

  // Shop Item CRUD actions
  function openNewItem() {
    editingItem = {
      name: '',
      description: '',
      emoji: '📦',
      type: 'POTION',
      atkBonus: 0,
      defBonus: 0,
      spdBonus: 0,
      hpBonus: 0,
      hpRestore: 0,
      energyRestore: 0,
      levelXpReward: 0,
      clanPointsReward: 0,
      raidAssaultBonus: 0,
      rarity: 'COMMON',
      levelRequired: 0,
      price: 10,
      purchasable: true,
      salvageable: true
    };
  }

  function openEditItem(item: any) {
    editingItem = { ...item };
  }

  async function handleSaveItem() {
    // La description part dans le menu déroulant de la boutique Discord, qui refuse une
    // option sans description : sans elle, la boutique entière devient inaccessible.
    if (!editingItem.name?.trim() || !editingItem.description?.trim() || !editingItem.type || editingItem.price === undefined) {
      toast.error(m.eco_toast_missing_fields());
      return;
    }
    // La route refuse elle aussi : le dire ici evite un aller-retour pour un
    // oubli que l'ecran voit tout de suite.
    if (editingItem.type === 'SCROLL' && !editingItem.enchantId) {
      toast.error(m.eco_item_enchant_required());
      return;
    }

    await actionState.run(async () => {
      const res = await saveRpgItem(editingItem);
      if (res && res.item) {
        await loadItems();
        editingItem = null;
      }
      return true;
    }, { successMessage: m.eco_toast_item_saved() });
  }

  async function handleDeleteItem(itemId: string) {
    if (!(await confirmDialog.danger(m.eco_delete_item_confirm()))) return;

    await actionState.run(async () => {
      await deleteRpgItem(itemId);
      await loadItems();
      return true;
    }, { successMessage: m.eco_toast_item_deleted() });
  }

  // Bestiaire CRUD actions
  const BLANK_BOSS_STATS = { health: 300, attack: 30, defense: 18, speed: 10, xpReward: 200, coinReward: 150 };
  const BLANK_MONSTER_STATS = { health: 40, attack: 8, defense: 4, speed: 5, xpReward: 20, coinReward: 10 };

  // Les statistiques proposees suivent le palier du serveur : une creature creee apres
  // coup au palier normal detonnerait au milieu d'un bestiaire deja reecrit.
  function blankMonster(isBoss: boolean) {
    const level = isBoss ? 10 : 1;
    const stats = scaleToDifficulty(
      isBoss ? BLANK_BOSS_STATS : BLANK_MONSTER_STATS,
      isBoss ? bossDifficulty : monsterDifficulty,
      level,
    );

    return {
      name: '',
      description: '',
      emoji: isBoss ? '👑' : '👹',
      level,
      ...stats,
      drops: [] as any[],
      isBoss,
      bossRespawnHours: isBoss ? 2 : null,
      clanPoints: 0,
      firstKillCoinReward: 0,
      firstKillXpReward: 0,
      firstKillItemName: null as string | null,
      firstKillClanPoints: 0,
      firstKillRoleId: null as string | null,
      firstKillTitleId: null as string | null,
      winTitleId: null as string | null,
      firstKillOn: false,
      enabled: true,
      scope: 'GUILD',
      overridesGlobal: false
    };
  }

  function openNewMonster(isBoss: boolean) {
    editingMonster = blankMonster(isBoss);
  }

  // La chance est stockée en fraction (0-1) et saisie en pourcentage : la conversion se
  // fait aux deux bouts de la fiche pour ne jamais exposer un 0.35 à l'utilisateur.
  function openEditMonster(monster: any) {
    editingMonster = {
      ...monster,
      firstKillOn: monster.firstKillCoinReward > 0 || monster.firstKillXpReward > 0
        || monster.firstKillClanPoints > 0 || Boolean(monster.firstKillItemName) || Boolean(monster.firstKillRoleId)
        || Boolean(monster.firstKillTitleId),
      drops: (monster.drops ?? []).map((drop: any) => ({
        itemName: drop.itemName,
        emoji: drop.emoji ?? '📦',
        chancePercent: Math.round((drop.chance ?? 0) * 100),
        coinBonus: drop.coinBonus ?? 0
      }))
    };
  }

  function addDrop() {
    if (editingMonster.drops.length >= DROPS_MAX) {
      toast.error(m.eco_bestiary_drops_max({ max: DROPS_MAX }));
      return;
    }
    editingMonster.drops = [...editingMonster.drops, { itemName: '', emoji: '📦', chancePercent: 25, coinBonus: 0 }];
  }

  function removeDrop(index: number) {
    editingMonster.drops = editingMonster.drops.filter((_: any, i: number) => i !== index);
  }

  function onDropItemChange(index: number, itemName: string | null) {
    const picked = items.find((item) => item.name === itemName);
    editingMonster.drops[index].itemName = itemName ?? '';
    if (picked) editingMonster.drops[index].emoji = picked.emoji;
  }

  async function handleSaveMonster() {
    if (!editingMonster.name?.trim() || !editingMonster.description?.trim()) {
      toast.error(m.eco_toast_missing_fields());
      return;
    }

    const payload = {
      id: editingMonster.id,
      name: editingMonster.name,
      description: editingMonster.description,
      emoji: editingMonster.emoji,
      level: editingMonster.level,
      health: editingMonster.health,
      attack: editingMonster.attack,
      defense: editingMonster.defense,
      speed: editingMonster.speed,
      xpReward: editingMonster.xpReward,
      coinReward: editingMonster.coinReward,
      isBoss: editingMonster.isBoss,
      bossRespawnHours: editingMonster.bossRespawnHours,
      clanPoints: editingMonster.clanPoints ?? 0,
      // Décocher la section retire la prime ; le record du premier vainqueur, lui, reste.
      firstKillCoinReward: editingMonster.firstKillOn ? Number(editingMonster.firstKillCoinReward) || 0 : 0,
      firstKillXpReward: editingMonster.firstKillOn ? Number(editingMonster.firstKillXpReward) || 0 : 0,
      firstKillClanPoints: editingMonster.firstKillOn ? Number(editingMonster.firstKillClanPoints) || 0 : 0,
      firstKillItemName: editingMonster.firstKillOn ? editingMonster.firstKillItemName || null : null,
      firstKillRoleId: editingMonster.firstKillOn ? editingMonster.firstKillRoleId || null : null,
      firstKillTitleId: editingMonster.firstKillOn ? editingMonster.firstKillTitleId || null : null,
      winTitleId: editingMonster.winTitleId || null,
      enabled: editingMonster.enabled,
      drops: editingMonster.drops
        .filter((drop: any) => drop.itemName)
        .map((drop: any) => ({
          itemName: drop.itemName,
          emoji: drop.emoji,
          chance: Math.min(100, Math.max(1, Number(drop.chancePercent) || 0)) / 100,
          coinBonus: Number(drop.coinBonus) || 0
        }))
    };

    await actionState.run(async () => {
      const res = await saveRpgMonster(payload);
      if (res && res.monster) {
        await loadMonsters();
        editingMonster = null;
      }
      return true;
    }, { successMessage: m.eco_toast_monster_saved() });
  }

  async function handleToggleMonster(monster: any, enabled: boolean) {
    await actionState.run(async () => {
      await setRpgMonsterEnabled(monster.id, enabled);
      await loadMonsters();
      return true;
    }, { successMessage: enabled ? m.eco_toast_monster_enabled() : m.eco_toast_monster_disabled() });
  }

  async function handleDeleteMonster(monster: any) {
    const restoring = monster.overridesGlobal;
    const confirmed = await confirmDialog.danger(
      restoring
        ? m.eco_bestiary_reset_confirm({ name: monster.name })
        : m.eco_bestiary_delete_confirm({ name: monster.name })
    );
    if (!confirmed) return;

    await actionState.run(async () => {
      await deleteRpgMonster(monster.id);
      await loadMonsters();
      return true;
    }, { successMessage: restoring ? m.eco_toast_monster_restored() : m.eco_toast_monster_deleted() });
  }

  const bossDifficulty = $derived(asBestiaryDifficulty(config.bossDifficulty));
  const monsterDifficulty = $derived(asBestiaryDifficulty(config.monsterDifficulty));
  const shopDifficulty = $derived(asBestiaryDifficulty(config.shopDifficulty));

  const DIFFICULTY_LABELS: Record<BestiaryDifficulty, () => string> = {
    EASY: m.eco_bestiary_difficulty_easy,
    NORMAL: m.eco_bestiary_difficulty_normal,
    HARD: m.eco_bestiary_difficulty_hard,
  };

  const DIFFICULTY_DESCRIPTIONS: Record<BestiaryDifficulty, () => string> = {
    EASY: m.eco_bestiary_difficulty_easy_desc,
    NORMAL: m.eco_bestiary_difficulty_normal_desc,
    HARD: m.eco_bestiary_difficulty_hard_desc,
  };

  // Trois exemples pris aux deux bouts du bestiaire et au milieu : un palier qui ne se voit
  // que sur le Slime ou que sur le boss final ne dit rien de ce qu'il fait.
  function previewSample<T>(rows: T[], max = 3): T[] {
    if (rows.length <= max) return rows;
    const step = (rows.length - 1) / (max - 1);
    return Array.from({ length: max }, (_, index) => rows[Math.round(index * step)]);
  }

  function describeStatPreview(rows: any[]): string {
    return previewSample(rows)
      .map((row) => m.eco_difficulty_preview_row({
        name: row.name,
        before: row.before.health,
        after: row.after.health,
      }))
      .join(' · ');
  }

  // L'essai a blanc ne passe pas par `actionState` : celui-ci ne rend qu'un booleen, et c'est
  // justement le detail de l'apercu qu'on vient chercher.
  async function runPreview(request: () => Promise<any>): Promise<any | null> {
    try {
      return await request();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.eco_difficulty_preview_failed());
      return null;
    }
  }

  // Les paliers sont independants : appliquer « Difficile » aux boss ne dit rien du bestiaire
  // courant ni des prix, et l'inverse est vrai aussi.
  async function handleApplyDifficulty(scope: BestiaryScope, difficulty: BestiaryDifficulty) {
    if (!canManageSettings) return;
    const current = scope === 'boss' ? bossDifficulty : monsterDifficulty;
    if (current === difficulty) return;

    const scopeLabel = scope === 'boss' ? m.eco_bestiary_filter_boss() : m.eco_bestiary_filter_monster();
    const dry = await runPreview(() => applyRpgBestiaryDifficulty(scope, difficulty, { preview: true }));
    if (!dry) return;

    // Un palier qui ne change aucune fiche n'a rien a faire confirmer : il n'y a que la
    // valeur retenue a enregistrer.
    if (dry.updated > 0) {
      const details = [
        m.eco_difficulty_confirm_count({ count: dry.updated }),
        describeStatPreview(dry.preview ?? []),
      ];
      if (dry.protectedDrops > 0) details.push(m.eco_difficulty_protected_drops({ count: dry.protectedDrops }));

      const confirmed = await confirmDialog.ask({
        title: m.eco_bestiary_difficulty_confirm_title({
          difficulty: DIFFICULTY_LABELS[difficulty]().toLowerCase(),
          scope: scopeLabel.toLowerCase(),
        }),
        description: `${m.eco_bestiary_difficulty_confirm_desc()} ${details.join(' ')}`,
        confirmLabel: m.eco_bestiary_difficulty_confirm_apply(),
        variant: 'warning',
      });
      if (!confirmed) return;
    }

    await actionState.run(async () => {
      const res = await applyRpgBestiaryDifficulty(scope, difficulty);
      if (!res || !res.success) throw new Error('Erreur lors de l\'application de la difficulte.');
      rememberDifficulty(scope === 'boss' ? 'bossDifficulty' : 'monsterDifficulty', difficulty);
      await loadMonsters();
      return true;
    }, { successMessage: m.eco_toast_difficulty_applied() });
  }

  async function handleApplyShopDifficulty(difficulty: BestiaryDifficulty) {
    if (!canManageSettings) return;
    if (shopDifficulty === difficulty) return;

    const dry = await runPreview(() => applyRpgShopDifficulty(difficulty, { preview: true }));
    if (!dry) return;

    if (dry.updated > 0) {
      const details = [
        m.eco_shop_difficulty_confirm_count({ count: dry.updated }),
        previewSample(dry.preview ?? [])
          .map((row: any) => m.eco_difficulty_preview_price({ name: row.name, before: row.before, after: row.after }))
          .join(' · '),
      ];
      if (dry.protectedItems > 0) details.push(m.eco_difficulty_protected_items({ count: dry.protectedItems }));

      const confirmed = await confirmDialog.ask({
        title: m.eco_shop_difficulty_confirm_title({ difficulty: DIFFICULTY_LABELS[difficulty]().toLowerCase() }),
        description: `${m.eco_shop_difficulty_confirm_desc()} ${details.join(' ')}`,
        confirmLabel: m.eco_bestiary_difficulty_confirm_apply(),
        variant: 'warning',
      });
      if (!confirmed) return;
    }

    // Un palier qui n'a rien reecrit ne s'annonce pas comme applique : sur un serveur qui
    // n'a cree aucun objet, toute la boutique vient du catalogue partage et le reglage ne
    // peut rien y faire. Le dire vaut mieux qu'un succes sans effet visible.
    const nothingMoved = dry.updated === 0;
    const successMessage = nothingMoved
      ? m.eco_shop_difficulty_toast_catalog_only({ count: dry.catalogItems ?? 0 })
      : m.eco_toast_difficulty_applied();

    await actionState.run(async () => {
      const res = await applyRpgShopDifficulty(difficulty);
      if (!res || !res.success) throw new Error('Erreur lors de l\'application de la difficulte.');
      rememberDifficulty('shopDifficulty', difficulty);
      await loadItems();
      return true;
    }, { successMessage });
  }

  // Le palier est ecrit par une route dediee, hors du formulaire de configuration : sans cette
  // mise a jour des deux cotes, la page se croirait modifiee.
  function rememberDifficulty(field: 'bossDifficulty' | 'monsterDifficulty' | 'shopDifficulty', value: BestiaryDifficulty) {
    config[field] = value;
    savedConfig[field] = value;
  }

  async function handleExportBestiary() {
    const data = await runPreview(() => exportRpgBestiary());
    if (data) {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `bestiaire-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }
  }

  async function handleImportBestiary(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    // Le champ est remis a zero tout de suite : sans ca, reimporter le meme fichier apres
    // correction ne declenche plus rien, le navigateur n'y voyant aucun changement.
    input.value = '';
    if (!file) return;

    let payload: unknown;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      toast.error(m.eco_bestiary_import_invalid());
      return;
    }

    const confirmed = await confirmDialog.ask({
      title: m.eco_bestiary_import_confirm_title(),
      description: m.eco_bestiary_import_confirm_desc(),
      confirmLabel: m.eco_bestiary_import_confirm_apply(),
      variant: 'warning',
    });
    if (!confirmed) return;

    await actionState.run(async () => {
      const res = await importRpgBestiary(payload);
      if (!res || !res.success) throw new Error("Erreur lors de l'import du bestiaire.");
      await loadMonsters();
      if (res.droppedLoot > 0) toast.warning(m.eco_bestiary_import_dropped_loot({ count: res.droppedLoot }));
      return true;
    }, { successMessage: m.eco_bestiary_import_done() });
  }

  const difficultyRows = $derived<Array<{
    scope: BestiaryScope;
    label: string;
    current: BestiaryDifficulty;
    advice: BestiaryDifficulty | null;
    adviceLabel: string;
    sample: BattleSample;
  }>>([
    {
      scope: 'boss',
      label: m.eco_bestiary_filter_boss(),
      current: bossDifficulty,
      advice: difficultyAdvice.boss,
      adviceLabel: DIFFICULTY_LABELS[difficultyAdvice.boss ?? bossDifficulty](),
      sample: battleSamples.boss,
    },
    {
      scope: 'monster',
      label: m.eco_bestiary_filter_monster(),
      current: monsterDifficulty,
      advice: difficultyAdvice.monster,
      adviceLabel: DIFFICULTY_LABELS[difficultyAdvice.monster ?? monsterDifficulty](),
      sample: battleSamples.monster,
    },
  ]);

  const filteredMonsters = $derived(
    monsters.filter((monster) =>
      bestiaryFilter === 'all'
        ? true
        : bestiaryFilter === 'boss'
          ? monster.isBoss
          : !monster.isBoss
    )
  );

  const dropItemOptions = $derived(itemNameOptions(items));

  // Player Editing actions
  function openEditPlayer(player: any) {
    editingPlayer = { ...player };
  }

  // L'inventaire a besoin du catalogue pour proposer des objets à donner.
  let inventoryPlayer = $state<any>(null);

  function openInventory(player: any) {
    inventoryPlayer = player;
    if (items.length === 0) void loadItems();
  }

  async function handleSavePlayer() {
    await actionState.run(async () => {
      const res = await updateRpgPlayer(editingPlayer.userId, {
        balance: editingPlayer.balance,
        level: editingPlayer.level,
        xp: editingPlayer.xp,
        health: editingPlayer.health,
        energy: editingPlayer.energy,
        attack: editingPlayer.attack,
        defense: editingPlayer.defense,
        speed: editingPlayer.speed,
        maxHealth: editingPlayer.maxHealth,
        statPoints: editingPlayer.statPoints,
        skillPoints: editingPlayer.skillPoints
      });
      if (res && res.player) {
        await loadPlayers();
        editingPlayer = null;
      }
      return true;
    }, { successMessage: m.eco_toast_player_saved() });
  }

  const availableChannels = $derived(dashboardStore.state.discordChannels || []);
  const availableRoles = $derived(dashboardStore.state.discordRoles || []);

  // Rang calculé sur la liste complète, ex aequo compris comme sur la page publique :
  // la recherche filtre l'affichage sans renuméroter les joueurs.
  const playerRanks = $derived.by(() => {
    const ranks = new Map<string, number>();
    let rank = 0;
    let previous: string | null = null;
    players.forEach((p, index) => {
      const key = `${p.level}:${p.xp}`;
      if (key !== previous) rank = index + 1;
      previous = key;
      ranks.set(p.userId, rank);
    });
    return ranks;
  });

  const filteredPlayers = $derived(
    players.filter(p => 
      p.userId.includes(searchQuery) || 
      (p.username && p.username.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (p.displayName && p.displayName.toLowerCase().includes(searchQuery.toLowerCase()))
    )
  );
</script>

<!-- `featureKey` n'est pas decoratif : c'est lui qui donne a la page l'interrupteur
     d'activation, la banniere qui explique un module eteint, et le grisage du corps.
     Sans lui, la garde d'API refusait chaque appel sans que rien ne dise pourquoi, et
     aucun chemin ne permettait de rallumer le module depuis ici. -->
<ModulePage
  title={section === 'rpg' ? m.rpg_page_title() : m.eco_page_title()}
  description={section === 'rpg' ? m.rpg_page_desc() : m.eco_page_desc()}
  icon={section === 'rpg' ? 'sword' : 'coins'}
  featureKey="economy"
>
  {#snippet actions()}
    {#if !loading}
      {#if section === 'economy'}
      <button
        type="button"
        onclick={() => router.goto('/economy-setup')}
        class="group flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-bold bg-primary text-on-primary shadow-md shadow-primary/20 hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/25 transition-all"
      >
        <Papicon icon="Sparkles" size={15} />
        {m.eco_quick_setup_title()}
        <Papicon icon="ChevronRight" size={14} class="transition-transform group-hover:translate-x-0.5" />
      </button>
      {/if}
      {#if publicRpgUrl && section === 'rpg'}
        <a
          href={publicRpgUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-bold bg-tertiary/20 text-tertiary border border-tertiary/25 hover:bg-tertiary/30 transition-all"
          title={m.eco_public_page_hint()}
        >
          <Papicon icon="ExternalLink" size={15} />
          {m.eco_public_page()}
        </a>
        <button
          type="button"
          onclick={copyPublicRpgUrl}
          title={m.eco_public_page_copy()}
          aria-label={m.eco_public_page_copy()}
          class="flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs font-bold transition-all {publicUrlCopied ? 'bg-success/15 text-success border border-success/20' : 'bg-surface-container-high/40 text-on-surface-variant border border-outline-variant/10 hover:bg-surface-container-high/60'}"
        >
          <Papicon icon={publicUrlCopied ? 'Check' : 'Link'} size={15} />
        </button>
      {/if}
    {/if}
  {/snippet}

  <InlineFeedback state={actionState} />

  <!-- Module actif mais economie a l'arret : le cas de tout serveur neuf, la
       configuration naissant avec `enabled: false`. Le dire une fois ici vaut
       mieux qu'un formulaire grise sans explication. -->
  {#if !loading && !loadFailed && economyModuleActive && !config.enabled}
    <Callout variant="warning" title={m.eco_paused_title()}>
      {m.eco_paused_desc()}
      {#snippet actions()}
        {#if canManageSettings}
          <Button variant="primary" size="sm" icon="Play" loading={actionState.state.loading} onclick={() => setEconomyRunning(true)}>
            {m.eco_paused_action()}
          </Button>
        {/if}
      {/snippet}
    </Callout>
  {/if}

  {#if loadFailed}
    <p class="text-xs text-warning/90 bg-warning/5 border border-warning/20 rounded-lg px-4 py-3 leading-relaxed">
      {m.eco_config_load_failed()}
    </p>
  {/if}

  <Tabs
    label={section === 'rpg' ? m.rpg_page_title() : m.eco_page_title()}
    tabs={pageTabItems(BASE)}
    active={activeTab}
    onchange={(id) => gotoTab(BASE, id, DEFAULT_TAB)}
  />

  {#if loading}
    <Skeleton height="350px" radius="2.5rem" />
    <div class="flex justify-center mt-4">
      <LoadingHint context="config" />
    </div>
  {:else}
    <!-- Tab 1: Configuration -->
    {#if activeTab === 'config'}
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <!-- Activation settings -->
        <div class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6 h-fit">
          <h3 class="text-lg font-semibold border-b border-outline-variant/15 pb-4">{m.eco_activation_title()}</h3>
          
          <div class="space-y-4">
            <!-- RPG Toggle -->
            <div class="flex items-center justify-between py-2 border-b border-outline-variant/5">
              <div>
                <h4 class="text-sm font-bold">{m.eco_rpg_toggle_title()}</h4>
                <p class="text-xs text-on-surface-variant/60 mt-0.5">{m.eco_rpg_toggle_desc()}</p>
              </div>
              <ToggleSwitch checked={config.rpgEnabled} onToggle={(v: boolean) => config.rpgEnabled = v} disabled={!canManageSettings} />
            </div>

            <!-- Shop Toggle -->
            <div class="flex items-center justify-between py-2 border-b border-outline-variant/5">
              <div>
                <h4 class="text-sm font-bold">{m.eco_shop_toggle_title()}</h4>
                <p class="text-xs text-on-surface-variant/60 mt-0.5">{m.eco_shop_toggle_desc()}</p>
              </div>
              <ToggleSwitch checked={config.shopEnabled} onToggle={(v: boolean) => config.shopEnabled = v} disabled={!canManageSettings} />
            </div>

            <!-- Guilds Toggle -->
            <div class="flex items-center justify-between py-2">
              <div>
                <h4 class="text-sm font-bold">{m.eco_guilds_toggle_title()}</h4>
                <p class="text-xs text-on-surface-variant/60 mt-0.5">{m.eco_guilds_toggle_desc()}</p>
              </div>
              <ToggleSwitch checked={config.guildsEnabled} onToggle={(v: boolean) => config.guildsEnabled = v} disabled={!canManageSettings} />
            </div>

            <div class="space-y-2 pt-4 border-t border-outline-variant/5">
              <div>
                <label for="rpgChannels" class="text-sm font-bold">{m.eco_rpg_channels_title()}</label>
                <p class="text-xs text-on-surface-variant/60 mt-0.5">{m.eco_rpg_channels_desc()}</p>
              </div>
              <MultiSelect
                id="rpgChannels"
                bind:values={rpgChannelIds}
                options={availableChannels.map((c: any) => ({ id: c.id, name: channelDisplayName(c) }))}
                disabled={!canManageSettings || !config.rpgEnabled}
              />
              {#if rpgChannelsDiverged}
                <p class="text-2xs text-warning/90 leading-relaxed">{m.eco_rpg_channels_diverged()}</p>
              {/if}
            </div>
          </div>
        </div>

        <!-- Details config -->
        <div class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
          <h3 class="text-lg font-semibold border-b border-outline-variant/15 pb-4">{m.eco_settings_title()}</h3>
          
          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-1.5">
              <label for="curName" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_currency_name()}</label>
              <input id="curName" type="text" bind:value={config.currencyName} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed" disabled={!canManageSettings} />
            </div>

            <div class="space-y-1.5">
              <label for="curEmoji" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_currency_emoji()}</label>
              <div class="flex gap-2">
                <input id="curEmoji" type="text" bind:value={config.currencyEmoji} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed" disabled={!canManageSettings} />
                <EmojiPicker bind:value={config.currencyEmoji} disabled={!canManageSettings} />
              </div>
            </div>

            <!-- Currency Image Upload -->
            <div class="col-span-2 space-y-2 pt-2 border-t border-outline-variant/10">
              <span class="text-xs font-semibold text-on-surface-variant/60 ml-2 block">{m.eco_currency_icon()}</span>
              <div class="flex items-center gap-4 bg-surface-container-high/20 p-4 rounded-lg border border-outline-variant/10">
                {#if config.currencyIcon}
                  <!-- L'overflow-hidden qui arrondit l'apercu vit sur le cadre
                       interieur : porte par ce conteneur, il rognait la croix
                       posee en -top-1 -right-1, qui semblait alors faire partie
                       de l'image. -->
                  <div class="relative w-12 h-12 shrink-0">
                    <div class="w-full h-full rounded-xl bg-surface-container overflow-hidden border border-outline-variant/20 flex items-center justify-center">
                      <img src={config.currencyIcon} alt="Icone" class="w-full h-full object-contain" />
                    </div>
                    {#if canManageSettings}
                      <button
                        type="button"
                        onclick={() => { config.currencyIcon = null; }}
                        class="absolute -top-1.5 -right-1.5 bg-red-500 hover:bg-red-600 text-white w-5 h-5 rounded-full flex items-center justify-center shadow-sm ring-2 ring-surface-container-high transition-colors"
                        title="Supprimer"
                      >
                        <Papicon icon="x" size={11} />
                      </button>
                    {/if}
                  </div>
                {:else}
                  <div class="w-12 h-12 rounded-xl bg-surface-container/60 border-2 border-dashed border-outline-variant/25 flex items-center justify-center text-on-surface-variant/30 text-2xs font-semibold shrink-0">
                    {m.eco_no_icon()}
                  </div>
                {/if}

                {#if canManageSettings}
                  <div class="flex-1 space-y-1">
                    <input
                      type="file"
                      id="currencyIconUpload"
                      accept="image/*"
                      class="hidden"
                      onchange={(e: Event) => {
                        const file = (e.currentTarget as HTMLInputElement).files?.[0];
                        if (file) {
                          const reader = new FileReader();
                          reader.onload = (event) => {
                            const res = event.target?.result;
                            if (typeof res === 'string') {
                              config.currencyIcon = res;
                            }
                          };
                          reader.readAsDataURL(file);
                        }
                      }}
                    />
                    <button
                      type="button"
                      onclick={() => document.getElementById('currencyIconUpload')?.click()}
                      class="px-4 py-2 bg-secondary text-on-secondary hover:scale-102 active:scale-98 transition-all text-xs font-bold rounded-xl shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {config.currencyIcon ? m.eco_change_icon() : m.eco_upload_icon()}
                    </button>
                    <p class="text-2xs text-on-surface-variant/40 leading-none">{m.eco_icon_hint()}</p>
                  </div>
                {:else}
                  <p class="text-xs text-on-surface-variant/40 italic">{m.eco_readonly()}</p>
                {/if}
              </div>
            </div>

            <div class="space-y-1.5">
              <label for="dailyMin" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_daily_min()}</label>
              <input id="dailyMin" type="number" bind:value={config.dailyRewardMin} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed" disabled={!canManageSettings} />
            </div>

            <div class="space-y-1.5">
              <label for="dailyMax" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_daily_max()}</label>
              <input id="dailyMax" type="number" bind:value={config.dailyRewardMax} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed" disabled={!canManageSettings} />
            </div>

            <div class="space-y-1.5">
              <label for="dailyCd" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_daily_cd()}</label>
              <input id="dailyCd" type="number" bind:value={config.dailyCooldownHour} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed" disabled={!canManageSettings} />
            </div>

            <div class="space-y-1.5">
              <label for="advCd" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_adv_cd()}</label>
              <input id="advCd" type="number" bind:value={config.adventureCooldownMin} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed" disabled={!canManageSettings} />
            </div>

            <div class="space-y-1.5">
              <label for="maxEnergy" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_max_energy()}</label>
              <input id="maxEnergy" type="number" bind:value={config.maxEnergy} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed" disabled={!canManageSettings} />
            </div>

            <div class="space-y-1.5">
              <label for="energyRecovery" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_energy_recovery()}</label>
              <input id="energyRecovery" type="number" bind:value={config.energyRecoveryPerHour} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed" disabled={!canManageSettings} />
            </div>
          </div>
        </div>

        <!-- Les quatre plafonds que le bot applique deja aux jeux d'argent et
             aux transferts : ils vivaient en base sans aucun ecran pour les
             regler. -->
        <div class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6 h-fit">
          <div class="border-b border-outline-variant/15 pb-4">
            <h3 class="text-lg font-semibold">{m.eco_limits_title()}</h3>
            <p class="text-xs text-on-surface-variant/60 mt-1">{m.eco_limits_desc()}</p>
          </div>

          <div class="space-y-3">
            <div class="flex items-center justify-between gap-4">
              <div>
                <h4 class="text-sm font-bold">{m.eco_gambling_title()}</h4>
                <p class="text-xs text-on-surface-variant/60 mt-0.5 leading-relaxed">{m.eco_gambling_desc()}</p>
              </div>
              <ToggleSwitch
                checked={allGamblingOpen}
                ariaLabel={m.eco_gambling_all_aria()}
                onToggle={(open: boolean) => setAllGambling(open)}
                disabled={!canManageSettings}
              />
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {#each GAMBLING_GAMES as game (game)}
                <div class="flex items-center justify-between gap-3 bg-surface-container-high/30 border border-outline-variant/10 rounded-lg px-3 py-2">
                  <div class="min-w-0">
                    <code class="text-xs font-semibold">/{game}</code>
                    <span class="text-2xs text-on-surface-variant/60 ml-1.5">{
                      game === 'dice' ? m.eco_gambling_dice()
                        : game === 'roulette' ? m.eco_gambling_roulette()
                          : game === 'rps' ? m.eco_gambling_rps()
                            : m.eco_gambling_guess()
                    }</span>
                  </div>
                  <ToggleSwitch
                    checked={gamblingGames[game]}
                    ariaLabel={`/${game}`}
                    onToggle={(open: boolean) => { gamblingGames = { ...gamblingGames, [game]: open }; }}
                    disabled={!canManageSettings}
                  />
                </div>
              {/each}
            </div>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div class="space-y-1.5">
              <label for="maxBet" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_max_bet()}</label>
              <input id="maxBet" type="number" min="1" bind:value={config.maxBetAmount} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed" disabled={!canManageSettings} />
              <p class="text-2xs text-on-surface-variant/40">{m.eco_max_bet_hint()}</p>
            </div>

            <div class="space-y-1.5">
              <label for="maxDailyBets" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_max_daily_bets()}</label>
              <input id="maxDailyBets" type="number" min="0" bind:value={config.maxDailyBets} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed" disabled={!canManageSettings} />
              <p class="text-2xs text-on-surface-variant/40">{m.eco_max_daily_bets_hint()}</p>
            </div>

            <div class="space-y-1.5">
              <label for="maxTransfer" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_max_transfer()}</label>
              <input id="maxTransfer" type="number" min="1" bind:value={config.maxTransferAmount} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed" disabled={!canManageSettings} />
              <p class="text-2xs text-on-surface-variant/40">{m.eco_max_transfer_hint()}</p>
            </div>

            <div class="space-y-1.5">
              <label for="transferCd" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_transfer_cd()}</label>
              <input id="transferCd" type="number" min="0" bind:value={config.transferCooldownMin} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed" disabled={!canManageSettings} />
            </div>

            <div class="space-y-1.5">
              <label for="marketTax" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_market_tax()}</label>
              <input id="marketTax" type="number" min="0" max="50" bind:value={config.marketplaceTaxPercent} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed" disabled={!canManageSettings} />
              <p class="text-2xs text-on-surface-variant/40">{m.eco_market_tax_hint()}</p>
            </div>
          </div>
        </div>

        <div class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6 h-fit">
          <div class="border-b border-outline-variant/15 pb-4">
            <h3 class="text-lg font-semibold">{m.eco_fight_timers_title()}</h3>
            <p class="text-xs text-on-surface-variant/60 mt-1">{m.eco_fight_timers_desc()}</p>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div class="space-y-1.5">
              <label for="fightCd" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_fight_cd()}</label>
              <input id="fightCd" type="number" min="0" max="3600" bind:value={config.fightCooldownSec} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed" disabled={!canManageSettings} />
              <p class="text-2xs text-on-surface-variant/40">{m.eco_fight_cd_hint()}</p>
            </div>

            <div class="space-y-1.5">
              <label for="bossCd" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_boss_cd()}</label>
              <input id="bossCd" type="number" min="0" max="1440" bind:value={config.bossCooldownMin} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed" disabled={!canManageSettings} />
              <p class="text-2xs text-on-surface-variant/40">{m.eco_boss_cd_hint()}</p>
            </div>

            <div class="space-y-1.5">
              <label for="huntEnergy" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_hunt_energy()}</label>
              <input id="huntEnergy" type="number" min="100" max="500" bind:value={config.huntEnergyPercent} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed" disabled={!canManageSettings} />
              <p class="text-2xs text-on-surface-variant/40">{m.eco_hunt_energy_hint()}</p>
            </div>

            <div class="space-y-1.5">
              <label for="huntCd" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_hunt_cd()}</label>
              <input id="huntCd" type="number" min="100" max="1000" bind:value={config.huntCooldownPercent} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed" disabled={!canManageSettings} />
              <p class="text-2xs text-on-surface-variant/40">{m.eco_hunt_cd_hint()}</p>
            </div>
          </div>

          <div class="space-y-4 pt-4 border-t border-outline-variant/10">
            <div>
              <h4 class="text-sm font-bold">{m.eco_first_kill_announce_title()}</h4>
              <p class="text-xs text-on-surface-variant/60 mt-0.5">{m.eco_first_kill_announce_desc()}</p>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div class="space-y-1.5">
                <label for="firstKillAnnounce" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bm_announce_mode()}</label>
                <select id="firstKillAnnounce" bind:value={config.firstKillAnnounce} disabled={!canManageSettings} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50">
                  <option value="NONE">{m.eco_first_kill_announce_none()}</option>
                  <option value="BOSSES">{m.eco_first_kill_announce_bosses()}</option>
                  <option value="ALL">{m.eco_first_kill_announce_all()}</option>
                </select>
              </div>
              {#if config.firstKillAnnounce !== 'NONE'}
                <div class="space-y-1.5">
                  <label for="firstKillChannel" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bm_announce_channel_label()}</label>
                  <SearchableSelect
                    id="firstKillChannel"
                    bind:value={config.firstKillChannelId}
                    options={availableChannels.map((c: any) => ({ id: c.id, name: channelDisplayName(c) }))}
                    placeholder={m.eco_bm_select_channel()}
                    className="w-full"
                  />
                </div>
              {/if}
            </div>
          </div>
        </div>

        <!-- Pause et reinitialisations : rares, et pour certaines definitives.
             Elles ferment la configuration, la pause en ligne discrete, les
             remises a zero repliees derriere la zone de danger. -->
        {#if canManageSettings}
          <div class="col-span-1 lg:col-span-2 space-y-4">
            {#if config.enabled}
              <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-1">
                <div>
                  <p class="text-sm font-medium text-on-surface">{m.eco_pause_title()}</p>
                  <p class="text-xs text-on-surface-variant mt-0.5">{m.eco_pause_desc()}</p>
                </div>
                <Button variant="secondary" size="sm" icon="Pause" class="shrink-0" onclick={() => setEconomyRunning(false)}>
                  {m.eco_pause_action()}
                </Button>
              </div>
            {/if}

            <details class="group rounded-xl border border-error/20 bg-error/5">
              <summary class="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 [&::-webkit-details-marker]:hidden">
                <span class="min-w-0">
                  <span class="flex items-center gap-2 text-sm font-semibold text-error">
                    <Papicon icon="alert-triangle" size={16} />
                    {m.eco_reset_section_title()}
                  </span>
                  <span class="block text-xs text-on-surface-variant mt-0.5">{m.eco_reset_section_desc()}</span>
                </span>
                <Papicon icon="chevron-down" size={18} class="shrink-0 text-on-surface-variant transition-transform group-open:rotate-180" />
              </summary>
              <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 px-5 pb-5">
                <button
                  type="button"
                  onclick={() => triggerReset('profiles')}
                  class="px-5 py-4 bg-error/10 hover:bg-error/20 text-error text-xs font-bold rounded-lg transition-all border border-error/20 flex flex-col items-center justify-center text-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <span class="font-semibold flex items-center gap-1.5"><Papicon icon="users" size={14} /> {m.eco_reset_players_btn()}</span>
                  <span class="text-2xs text-on-surface-variant/60 font-normal">{m.eco_reset_players_desc()}</span>
                </button>

                <button
                  type="button"
                  onclick={() => triggerReset('items')}
                  class="px-5 py-4 bg-error/10 hover:bg-error/20 text-error text-xs font-bold rounded-lg transition-all border border-error/20 flex flex-col items-center justify-center text-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <span class="font-semibold flex items-center gap-1.5"><Papicon icon="package" size={14} /> {m.eco_reset_items_btn()}</span>
                  <span class="text-2xs text-on-surface-variant/60 font-normal">{m.eco_reset_items_desc()}</span>
                </button>

                <button
                  type="button"
                  onclick={() => triggerReset('bestiary')}
                  class="px-5 py-4 bg-error/10 hover:bg-error/20 text-error text-xs font-bold rounded-lg transition-all border border-error/20 flex flex-col items-center justify-center text-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <span class="font-semibold flex items-center gap-1.5"><Papicon icon="ghost" size={14} /> {m.eco_reset_bestiary_btn()}</span>
                  <span class="text-2xs text-on-surface-variant/60 font-normal">{m.eco_reset_bestiary_desc()}</span>
                </button>

                <button
                  type="button"
                  onclick={() => triggerReset('guilds')}
                  class="px-5 py-4 bg-error/10 hover:bg-error/20 text-error text-xs font-bold rounded-lg transition-all border border-error/20 flex flex-col items-center justify-center text-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <span class="font-semibold flex items-center gap-1.5"><Papicon icon="shield" size={14} /> {m.eco_reset_guilds_btn()}</span>
                  <span class="text-2xs text-on-surface-variant/60 font-normal">{m.eco_reset_guilds_desc()}</span>
                </button>

                <button
                  type="button"
                  onclick={() => triggerReset('titles')}
                  class="px-5 py-4 bg-error/10 hover:bg-error/20 text-error text-xs font-bold rounded-lg transition-all border border-error/20 flex flex-col items-center justify-center text-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <span class="font-semibold flex items-center gap-1.5"><Papicon icon="award" size={14} /> {m.eco_reset_titles_btn()}</span>
                  <span class="text-2xs text-on-surface-variant/60 font-normal">{m.eco_reset_titles_desc()}</span>
                </button>

                <button
                  type="button"
                  onclick={() => triggerReset('config')}
                  class="px-5 py-4 bg-error/10 hover:bg-error/20 text-error text-xs font-bold rounded-lg transition-all border border-error/20 flex flex-col items-center justify-center text-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <span class="font-semibold flex items-center gap-1.5"><Papicon icon="settings" size={14} /> {m.eco_reset_config_btn()}</span>
                  <span class="text-2xs text-on-surface-variant/60 font-normal">{m.eco_reset_config_desc()}</span>
                </button>

                <button
                  type="button"
                  onclick={() => triggerReset('all')}
                  class="px-5 py-4 bg-error text-on-error hover:bg-error-hover text-xs font-bold rounded-lg shadow-lg transition-all flex flex-col items-center justify-center text-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <span class="font-semibold flex items-center gap-1.5"><Papicon icon="alert-triangle" size={14} /> {m.eco_reset_all_btn()}</span>
                  <span class="text-2xs text-on-error/80 font-normal">{m.eco_reset_all_desc()}</span>
                </button>
              </div>
            </details>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Tab 2: Shop Items -->
    {#if activeTab === 'items'}
      <div class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
        <div class="flex items-center justify-between border-b border-outline-variant/15 pb-4">
          <h3 class="text-lg font-semibold">{m.eco_shop_title()}</h3>
          {#if canManageSettings}
            <button 
              type="button" 
              onclick={openNewItem}
              class="px-4 py-2 bg-primary hover:bg-primary-hover text-on-primary text-body-sm font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              <Papicon icon="plus" size={14} />
              {m.eco_create_item_btn()}
            </button>
          {/if}
        </div>

        <div class="bg-surface-container-high/30 border border-outline-variant/10 rounded-xl px-5 py-4 space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h4 class="text-sm font-bold">{m.eco_shop_difficulty_title()}</h4>
              <p class="text-xs text-on-surface-variant/60 mt-0.5 leading-relaxed">{m.eco_shop_difficulty_desc()}</p>
            </div>
            <span class="text-2xs text-on-surface-variant/50">
              {m.eco_bestiary_difficulty_current({ difficulty: DIFFICULTY_LABELS[shopDifficulty]() })}
            </span>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {#each BESTIARY_DIFFICULTIES as level (level)}
              {@const selected = shopDifficulty === level}
              <button
                type="button"
                onclick={() => handleApplyShopDifficulty(level)}
                disabled={!canManageSettings}
                aria-pressed={selected}
                class="text-left p-4 rounded-xl border transition-all disabled:opacity-50 disabled:cursor-not-allowed {selected ? 'bg-primary/8 border-primary/50' : 'bg-surface-container-low/30 border-outline-variant/10 hover:border-outline-variant/30 hover:bg-surface-container-high/20'}"
              >
                <div class="flex items-center gap-2">
                  <Papicon icon={BESTIARY_DIFFICULTY_ICONS[level]} size={14} class={selected ? 'text-primary' : 'text-on-surface-variant/70'} />
                  <span class="text-body-sm font-semibold">{DIFFICULTY_LABELS[level]()}</span>
                  {#if selected}
                    <span class="ml-auto text-xs font-semibold px-2 py-0.5 rounded-lg bg-primary/15 text-primary">
                      {m.eco_bestiary_difficulty_active()}
                    </span>
                  {/if}
                </div>
                <p class="text-2xs text-on-surface-variant/60 mt-2">
                  {#if isDifficultyNeutral(level, ['itemPrice'])}
                    {m.eco_difficulty_untouched_prices()}
                  {:else}
                    {m.eco_shop_difficulty_price({ delta: formatDifficultyDelta(level, 'itemPrice') })}
                  {/if}
                </p>
              </button>
            {/each}
          </div>

          <p class="text-2xs text-on-surface-variant/50 leading-relaxed">{m.eco_shop_difficulty_scope_hint()}</p>
        </div>

        <FilterPills
          label={m.eco_tab_items()}
          options={[{ value: 'all' as ItemFilter, label: m.eco_bestiary_filter_all() }, ...itemFilters.map((type) => ({ value: type, label: ITEM_FILTER_LABELS[type]() }))]}
          value={activeItemFilter}
          onchange={(value) => itemFilter = value}
        />

        {#if itemsLoading}
          <div class="flex items-center justify-center py-12">
            <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        {:else}
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {#each filteredItems as item}
              <div class="bg-surface-container-high/30 border border-outline-variant/10 p-6 rounded-xl relative group flex flex-col justify-between">
                <div class="space-y-3">
                  <div class="flex items-center gap-3">
                    <EmojiText value={item.emoji} size="1.125rem" class="text-lg" />
                    <div>
                      <h4 class="font-semibold text-base leading-none">{item.name}</h4>
                      <span class="text-xs font-semibold text-primary bg-primary/10 px-2 py-0.5 rounded-full inline-block mt-1">{item.type}</span>
                    </div>
                  </div>
                  <p class="text-xs text-on-surface-variant/60 leading-relaxed">{item.description}</p>
                  
                  <!-- Stat bonuses summary -->
                  <div class="flex flex-wrap gap-1.5 text-2xs font-bold">
                    {#if item.atkBonus} <span class="bg-error/10 text-error px-2 py-0.5 rounded-lg flex items-center gap-1"><Papicon icon="zap" size={10} /> ATK +{item.atkBonus}</span> {/if}
                    {#if item.defBonus} <span class="bg-blue-500/10 text-blue-400 px-2 py-0.5 rounded-lg flex items-center gap-1"><Papicon icon="shield" size={10} /> DEF +{item.defBonus}</span> {/if}
                    {#if item.spdBonus} <span class="bg-warning/10 text-warning px-2 py-0.5 rounded-lg flex items-center gap-1"><Papicon icon="activity" size={10} /> SPD +{item.spdBonus}</span> {/if}
                    {#if item.hpBonus} <span class="bg-error/10 text-error px-2 py-0.5 rounded-lg flex items-center gap-1"><Papicon icon="heart" size={10} /> {m.eco_item_hp_bonus_badge({ hp: item.hpBonus })}</span> {/if}
                    {#if item.levelRequired > 0} <span class="bg-outline-variant/15 text-on-surface-variant/80 px-2 py-0.5 rounded-lg">{m.eco_item_level_badge({ level: item.levelRequired })}</span> {/if}
                    {#if item.rarity && item.rarity !== 'COMMON'} <span class="bg-violet-500/10 text-violet-400 px-2 py-0.5 rounded-lg">{rarityLabels[item.rarity] ?? item.rarity}</span> {/if}
                    {#if item.purchasable === false} <span class="bg-outline-variant/15 text-on-surface-variant/70 px-2 py-0.5 rounded-lg">{m.eco_item_not_sold_badge()}</span> {/if}
                    {#if item.hpRestore} <span class="bg-success/10 text-success px-2 py-0.5 rounded-lg flex items-center gap-1"><Papicon icon="heart" size={10} /> HP +{item.hpRestore}</span> {/if}
                    {#if item.energyRestore} <span class="bg-purple-500/10 text-purple-400 px-2 py-0.5 rounded-lg flex items-center gap-1"><Papicon icon="zap" size={10} /> ÉNERGIE +{item.energyRestore}</span> {/if}
                    {#if item.levelXpReward} <span class="bg-sky-500/10 text-sky-400 px-2 py-0.5 rounded-lg flex items-center gap-1"><Papicon icon="star" size={10} /> XP +{item.levelXpReward}</span> {/if}
                    {#if item.clanPointsReward} <span class="bg-fuchsia-500/10 text-fuchsia-400 px-2 py-0.5 rounded-lg flex items-center gap-1"><Papicon icon="flag" size={10} /> {m.eco_item_clan_points_badge({ points: item.clanPointsReward })}</span> {/if}
                    {#if item.raidAssaultBonus} <span class="bg-error/10 text-error px-2 py-0.5 rounded-lg flex items-center gap-1"><Papicon icon="Crown" size={10} /> {m.eco_item_raid_assaults_badge({ assaults: item.raidAssaultBonus })}</span> {/if}
                  </div>

                  {#if (item.levelXpReward && !config.levelingEnabled) || (item.clanPointsReward && !(config.clansEnabled && config.clanPointsFromRpg)) || (item.raidAssaultBonus && !config.raidEnabled)}
                    <p class="text-2xs text-warning/90 leading-relaxed">{m.eco_item_module_locked_warning()}</p>
                  {/if}
                </div>

                <div class="mt-6 border-t border-outline-variant/5 pt-4 flex items-center justify-between">
                  <span class="text-sm font-bold text-on-surface flex items-center gap-1.5">
                    {#if config.currencyIcon}
                      <img src={config.currencyIcon} alt={config.currencyName} class="w-4 h-4 object-contain inline-block" />
                    {:else}
                      <EmojiText value={config.currencyEmoji} />
                    {/if}
                    <span>{item.price} {config.currencyName}</span>
                  </span>
                  
                  {#if canManageSettings && item.guildId}
                    <div class="flex gap-2">
                      <button 
                        type="button" 
                        onclick={() => openEditItem(item)}
                        class="p-2 bg-outline-variant/10 hover:bg-outline-variant/20 rounded-lg text-xs disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                        title={m.eco_btn_edit()}
                      >
                        <Papicon icon="edit" size={14} />
                      </button>
                      <button 
                        type="button" 
                        onclick={() => handleDeleteItem(item.id)}
                        class="p-2 bg-error/10 hover:bg-error/25 rounded-lg text-xs disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                        title={m.fb_delete()}
                      >
                        <Papicon icon="trash" size={14} />
                      </button>
                    </div>
                  {:else}
                    <span class="text-2xs font-bold text-on-surface-variant/40 italic">{m.eco_global_readonly()}</span>
                  {/if}
                </div>
              </div>
            {:else}
              <p class="text-xs text-on-surface-variant/60 italic py-6">{m.eco_no_items()}</p>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Tab 3: Bestiaire (boss et monstres) -->
    {#if activeTab === 'bestiaire'}
      <div class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
        <div class="flex flex-wrap items-start justify-between gap-4 border-b border-outline-variant/15 pb-4">
          <div class="max-w-2xl">
            <h3 class="text-lg font-semibold">{m.eco_bestiary_title()}</h3>
            <p class="text-xs text-on-surface-variant/60 mt-1 leading-relaxed">{m.eco_bestiary_desc()}</p>
          </div>
          {#if canManageSettings}
            <div class="flex gap-2">
              <button
                type="button"
                onclick={() => openNewMonster(true)}
                class="px-4 py-2 bg-primary hover:bg-primary-hover text-on-primary text-body-sm font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                <Papicon icon="plus" size={14} />
                {m.eco_bestiary_create_boss()}
              </button>
              <button
                type="button"
                onclick={() => openNewMonster(false)}
                class="px-4 py-2 bg-outline-variant/10 hover:bg-outline-variant/20 text-body-sm font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                <Papicon icon="plus" size={14} />
                {m.eco_bestiary_create_monster()}
              </button>
              <button
                type="button"
                onclick={handleExportBestiary}
                class="px-4 py-2 bg-outline-variant/10 hover:bg-outline-variant/20 text-body-sm font-medium rounded-lg transition-all flex items-center gap-1.5"
                title={m.eco_bestiary_export_hint()}
              >
                <Papicon icon="Download" size={14} />
                {m.eco_bestiary_export()}
              </button>
              <button
                type="button"
                onclick={() => bestiaryFileInput?.click()}
                class="px-4 py-2 bg-outline-variant/10 hover:bg-outline-variant/20 text-body-sm font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                title={m.eco_bestiary_import_hint()}
              >
                <Papicon icon="Upload" size={14} />
                {m.eco_bestiary_import()}
              </button>
              <input
                bind:this={bestiaryFileInput}
                type="file"
                accept="application/json,.json"
                onchange={handleImportBestiary}
                class="hidden"
              />
            </div>
          {/if}
        </div>

        {#if config.clansEnabled}
          <div class="flex items-center justify-between gap-4 bg-surface-container-high/30 border border-outline-variant/10 rounded-xl px-5 py-4">
            <div>
              <h4 class="text-sm font-bold">{m.eco_bestiary_clan_bridge_title()}</h4>
              <p class="text-xs text-on-surface-variant/60 mt-0.5 leading-relaxed">{m.eco_bestiary_clan_bridge_desc()}</p>
            </div>
            <ToggleSwitch
              checked={config.clanPointsFromRpg}
              onToggle={(v: boolean) => config.clanPointsFromRpg = v}
              disabled={!canManageSettings}
            />
          </div>
        {/if}

        <div class="space-y-4">
          <div class="max-w-3xl">
            <h4 class="text-sm font-bold">{m.eco_bestiary_difficulty_title()}</h4>
            <p class="text-xs text-on-surface-variant/60 mt-0.5 leading-relaxed">{m.eco_bestiary_difficulty_desc()}</p>
          </div>

          {#each difficultyRows as row (row.scope)}
            {@const rate = winRate(row.sample)}
            <div class="bg-surface-container-high/30 border border-outline-variant/10 rounded-xl px-5 py-4 space-y-3">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="text-xs font-semibold text-on-surface-variant/60">{row.label}</span>
                <span class="text-2xs text-on-surface-variant/50">
                  {m.eco_bestiary_difficulty_current({ difficulty: DIFFICULTY_LABELS[row.current]() })}
                </span>
              </div>

              <!-- Le palier conseille sort des combats deja livres : c'est la seule mesure
                   qui dise si le bestiaire est trop tendre ou trop dur pour ce serveur. -->
              <p class="text-2xs leading-relaxed {row.advice && row.advice !== row.current ? 'text-primary/80' : 'text-on-surface-variant/50'}">
                <!-- Le conseil se tait tant que le serveur n'a pas livre assez de combats :
                     cinq victoires d'affilee ne disent rien de l'equilibrage. -->
                {#if row.advice === null}
                  {m.eco_difficulty_advice_none({ days: battleStatsDays })}
                {:else if row.advice !== row.current}
                  {m.eco_difficulty_advice({
                    rate: rate ?? 0,
                    battles: row.sample.battles,
                    days: battleStatsDays,
                    difficulty: row.adviceLabel.toLowerCase(),
                  })}
                {:else}
                  {m.eco_difficulty_advice_ok({ rate: rate ?? 0, battles: row.sample.battles, days: battleStatsDays })}
                {/if}
              </p>

              <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {#each BESTIARY_DIFFICULTIES as level (level)}
                  {@const selected = row.current === level}
                  <button
                    type="button"
                    onclick={() => handleApplyDifficulty(row.scope, level)}
                    disabled={!canManageSettings}
                    aria-pressed={selected}
                    class="text-left p-4 rounded-xl border transition-all disabled:opacity-50 disabled:cursor-not-allowed {selected ? 'bg-primary/8 border-primary/50' : 'bg-surface-container-low/30 border-outline-variant/10 hover:border-outline-variant/30 hover:bg-surface-container-high/20'}"
                  >
                    <div class="flex items-center gap-2">
                      <Papicon icon={BESTIARY_DIFFICULTY_ICONS[level]} size={14} class={selected ? 'text-primary' : 'text-on-surface-variant/70'} />
                      <span class="text-body-sm font-semibold">{DIFFICULTY_LABELS[level]()}</span>
                      {#if selected}
                        <span class="ml-auto text-xs font-semibold px-2 py-0.5 rounded-lg bg-primary/15 text-primary">
                          {m.eco_bestiary_difficulty_active()}
                        </span>
                      {:else if row.advice === level}
                        <span class="ml-auto text-xs font-semibold px-2 py-0.5 rounded-lg border border-primary/30 text-primary/80">
                          {m.eco_difficulty_advised()}
                        </span>
                      {/if}
                    </div>
                    <p class="text-2xs text-on-surface-variant/60 mt-2 leading-relaxed">{DIFFICULTY_DESCRIPTIONS[level]()}</p>
                    {#if isDifficultyNeutral(level, ['health', 'attack', 'defense', 'xpReward', 'dropChance', 'bossRespawnHours'])}
                      <p class="mt-3 text-2xs font-bold text-on-surface-variant/50 flex items-center gap-1.5">
                        <Papicon icon="Check" size={11} class="text-success/80" />
                        {m.eco_difficulty_untouched_stats()}
                      </p>
                    {:else}
                      <div class="flex flex-wrap gap-1.5 mt-3 text-2xs font-bold text-on-surface-variant/70">
                        <span class="bg-outline-variant/10 px-2 py-0.5 rounded-lg">{m.eco_bestiary_difficulty_stat_health()} {formatDifficultyDelta(level, 'health')}</span>
                        <span class="bg-outline-variant/10 px-2 py-0.5 rounded-lg">{m.eco_bestiary_difficulty_stat_attack()} {formatDifficultyDelta(level, 'attack')}</span>
                        <span class="bg-outline-variant/10 px-2 py-0.5 rounded-lg">{m.eco_bestiary_difficulty_stat_defense()} {formatDifficultyDelta(level, 'defense')}</span>
                        <span class="bg-outline-variant/10 px-2 py-0.5 rounded-lg">{m.eco_bestiary_difficulty_stat_rewards()} {formatDifficultyDelta(level, 'xpReward')}</span>
                        <span class="bg-outline-variant/10 px-2 py-0.5 rounded-lg">{m.eco_bestiary_difficulty_stat_drops()} {formatDifficultyDelta(level, 'dropChance')}</span>
                        {#if row.scope === 'boss'}
                          <span class="bg-outline-variant/10 px-2 py-0.5 rounded-lg">{m.eco_bestiary_difficulty_stat_respawn()} {formatDifficultyDelta(level, 'bossRespawnHours')}</span>
                        {/if}
                      </div>
                    {/if}
                  </button>
                {/each}
              </div>

              <p class="text-2xs text-on-surface-variant/50 leading-relaxed">
                {m.eco_difficulty_level_hint({ floor: Math.round(LEVEL_WEIGHT_FLOOR * 100) })}
                {m.eco_difficulty_protected_hint()}
              </p>
            </div>
          {/each}
        </div>

        <FilterPills
          label={m.eco_bestiary_filter_all()}
          options={[
            { value: 'boss', label: m.eco_bestiary_filter_boss() },
            { value: 'monster', label: m.eco_bestiary_filter_monster() },
            { value: 'all', label: m.eco_bestiary_filter_all() },
          ]}
          value={bestiaryFilter}
          onchange={(value) => bestiaryFilter = value}
        />

        {#if monstersLoading}
          <div class="flex items-center justify-center py-12">
            <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        {:else}
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {#each filteredMonsters as monster (monster.id)}
              <div class="bg-surface-container-high/30 border border-outline-variant/10 p-6 rounded-xl flex flex-col justify-between {monster.enabled ? '' : 'opacity-50'}">
                <div class="space-y-3">
                  <div class="flex items-start gap-3">
                    <EmojiText value={monster.emoji} size="1.125rem" class="text-lg" />
                    <div class="min-w-0">
                      <h4 class="font-semibold text-base leading-tight break-words">{monster.name}</h4>
                      <div class="flex flex-wrap gap-1 mt-1.5">
                        <span class="text-xs font-semibold text-on-surface-variant/60 bg-outline-variant/10 px-2 py-0.5 rounded-full">{m.eco_rpg_level()} {monster.level}</span>
                        {#if monster.isBoss}
                          <span class="text-xs font-semibold text-warning bg-warning/10 px-2 py-0.5 rounded-full">{m.eco_bestiary_badge_boss()}</span>
                        {/if}
                        {#if monster.scope === 'GLOBAL'}
                          <span class="text-xs font-semibold text-on-surface-variant/50 bg-outline-variant/10 px-2 py-0.5 rounded-full">{m.eco_bestiary_badge_default()}</span>
                        {:else if monster.overridesGlobal}
                          <span class="text-xs font-semibold text-primary bg-primary/10 px-2 py-0.5 rounded-full">{m.eco_bestiary_badge_custom()}</span>
                        {:else}
                          <span class="text-xs font-semibold text-success bg-success/10 px-2 py-0.5 rounded-full">{m.eco_bestiary_badge_local()}</span>
                        {/if}
                        {#if !monster.enabled}
                          <span class="text-xs font-semibold text-error bg-error/10 px-2 py-0.5 rounded-full">{m.eco_bestiary_badge_disabled()}</span>
                        {/if}
                        <!-- Une fiche qui ne correspond plus au palier annonce a ete reglee a la
                             main : le prochain clic passera dessus comme sur les autres. -->
                        {#if monster.offDifficulty}
                          <span class="text-xs font-semibold text-tertiary bg-tertiary/10 px-2 py-0.5 rounded-full" title={m.eco_bestiary_badge_tuned_hint()}>{m.eco_bestiary_badge_tuned()}</span>
                        {/if}
                      </div>
                    </div>
                  </div>

                  <p class="text-xs text-on-surface-variant/60 leading-relaxed">{monster.description}</p>

                  <div class="flex flex-wrap gap-1.5 text-2xs font-bold">
                    <span class="bg-success/10 text-success px-2 py-0.5 rounded-lg flex items-center gap-1"><Papicon icon="heart" size={10} /> {monster.health}</span>
                    <span class="bg-error/10 text-error px-2 py-0.5 rounded-lg flex items-center gap-1"><Papicon icon="zap" size={10} /> {monster.attack}</span>
                    <span class="bg-blue-500/10 text-blue-400 px-2 py-0.5 rounded-lg flex items-center gap-1"><Papicon icon="shield" size={10} /> {monster.defense}</span>
                    <span class="bg-warning/10 text-warning px-2 py-0.5 rounded-lg flex items-center gap-1"><Papicon icon="activity" size={10} /> {monster.speed}</span>
                  </div>

                  <div class="text-2xs text-on-surface-variant/70 flex flex-wrap gap-3">
                    <span>{m.eco_xp()} +{monster.xpReward}</span>
                    <span><EmojiText value={config.currencyEmoji} /> +{monster.coinReward}</span>
                    {#if monster.isBoss && monster.bossRespawnHours}
                      <span>{m.eco_bestiary_respawn({ hours: monster.bossRespawnHours })}</span>
                    {/if}
                    {#if monster.clanPoints > 0 && (raidGuildMode ? config.guildsEnabled : config.clansEnabled)}
                      <span class="{raidGuildMode || config.clanPointsFromRpg ? '' : 'line-through opacity-60'}">
                        {raidGuildMode
                          ? m.eco_quest_guild_xp_short({ points: monster.clanPoints })
                          : m.eco_bestiary_clan_points_short({ points: monster.clanPoints })}
                      </span>
                    {/if}
                    {#if titleName(monster.winTitleId)}
                      <span class="flex items-center gap-1"><Papicon icon="crown" size={11} /> {titleName(monster.winTitleId)}</span>
                    {/if}
                    {#if monster.firstKill}
                      <span class="flex items-center gap-1" title={m.eco_bestiary_first_kill_hint({ date: new Date(monster.firstKill.at).toLocaleDateString() })}>
                        <Papicon icon="award" size={11} /> {monster.firstKill.displayName ?? monster.firstKill.userId}
                      </span>
                    {:else if monster.firstKillCoinReward > 0 || monster.firstKillXpReward > 0 || monster.firstKillClanPoints > 0 || monster.firstKillItemName || monster.firstKillRoleId || monster.firstKillTitleId}
                      <span class="flex items-center gap-1"><Papicon icon="award" size={11} /> {m.eco_bestiary_first_kill_open()}</span>
                    {/if}
                    {#if monster.battles?.battles > 0}
                      <span title={m.eco_bestiary_winrate_hint({ days: battleStatsDays })}>
                        {m.eco_bestiary_winrate({ rate: winRate(monster.battles) ?? 0, battles: monster.battles.battles })}
                      </span>
                    {/if}
                  </div>

                  <div class="border-t border-outline-variant/5 pt-3 space-y-1">
                    <span class="text-xs font-semibold text-on-surface-variant/50">{m.eco_bestiary_drops_label()}</span>
                    {#each monster.drops ?? [] as drop}
                      <div class="text-2xs text-on-surface-variant/80 flex items-center justify-between gap-2">
                        <span class="truncate"><EmojiText value={drop.emoji} /> {drop.itemName}</span>
                        <span class="font-bold shrink-0">{Math.round(drop.chance * 100)} %{drop.coinBonus ? ` +${drop.coinBonus}` : ''}</span>
                      </div>
                    {:else}
                      <p class="text-2xs text-on-surface-variant/40 italic">{m.eco_bestiary_no_drops()}</p>
                    {/each}
                  </div>
                </div>

                {#if canManageSettings}
                  <div class="mt-6 border-t border-outline-variant/5 pt-4 flex items-center gap-2">
                    <button
                      type="button"
                      onclick={() => openEditMonster(monster)}
                      class="flex-1 px-3 py-2 bg-outline-variant/10 hover:bg-outline-variant/20 rounded-lg text-2xs font-bold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                    >
                      <Papicon icon="edit" size={13} />
                      {monster.scope === 'GLOBAL' ? m.eco_bestiary_btn_customize() : m.eco_btn_edit()}
                    </button>
                    <button
                      type="button"
                      onclick={() => handleToggleMonster(monster, !monster.enabled)}
                      class="p-2 bg-outline-variant/10 hover:bg-outline-variant/20 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                      title={monster.enabled ? m.eco_bestiary_btn_disable() : m.eco_bestiary_btn_enable()}
                    >
                      <Papicon icon={monster.enabled ? 'ban' : 'power'} size={14} />
                    </button>
                    {#if monster.scope === 'GUILD'}
                      <button
                        type="button"
                        onclick={() => handleDeleteMonster(monster)}
                        class="p-2 bg-error/10 hover:bg-error/25 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                        title={monster.overridesGlobal ? m.eco_bestiary_btn_reset() : m.fb_delete()}
                      >
                        <Papicon icon={monster.overridesGlobal ? 'rotate-ccw' : 'trash'} size={14} />
                      </button>
                    {/if}
                  </div>
                {/if}
              </div>
            {:else}
              <p class="text-xs text-on-surface-variant/60 italic py-6">{m.eco_bestiary_empty()}</p>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Tab 4: Marché noir -->
    <!-- Tab : Quetes RPG -->
    {#if activeTab === 'recettes'}
      <div class="space-y-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 class="text-lg font-semibold">{m.eco_recipes_title()}</h3>
            <p class="text-xs text-on-surface-variant/60 mt-0.5 leading-relaxed max-w-2xl">{m.eco_recipes_desc()}</p>
          </div>
          <button
            type="button"
            onclick={() => editingRecipe = blankRecipe()}
            disabled={!canManageSettings || guildItems.length === 0}
            class="px-4 py-2.5 rounded-lg bg-primary text-on-primary text-body-sm font-semibold disabled:opacity-50"
          >
            {m.eco_recipe_new()}
          </button>
        </div>

        {#if recipesLoading}
          <Skeleton height="180px" radius="0.75rem" />
        {:else if recipes.length === 0}
          <p class="text-sm text-on-surface-variant/60 italic py-8 text-center">{m.eco_recipes_empty()}</p>
        {:else}
          <div class="space-y-2">
            {#each recipes as recipe (recipe.id)}
              <div class="bg-surface-container-high/30 border border-outline-variant/10 rounded-xl px-5 py-4 flex flex-wrap items-center gap-4">
                <div class="flex-1 min-w-0">
                  <p class="text-body-sm font-semibold flex items-center gap-2">
                    <EmojiText value={recipe.resultItem.emoji} /> {recipe.resultItem.name}
                    {#if !recipe.editable}
                      <span class="text-xs font-semibold px-2 py-0.5 rounded-lg border border-outline-variant/20 text-on-surface-variant/50">
                        {m.eco_recipe_shipped()}
                      </span>
                    {/if}
                  </p>
                  <p class="text-2xs text-on-surface-variant/60 mt-1">
                    {recipe.ingredients.map((ing: any) => `${ing.quantity} × ${ing.itemName}`).join(' + ')}
                  </p>
                  <p class="text-2xs text-on-surface-variant/50 mt-0.5">
                    {m.eco_recipe_line({ level: recipe.levelRequired, cost: recipe.coinCost })}
                  </p>
                </div>

                {#if recipe.editable && canManageSettings}
                  <div class="flex gap-2 shrink-0">
                    <button
                      type="button"
                      onclick={() => editingRecipe = { ...recipe, ingredients: recipe.ingredients.map((ing: any) => ({ ...ing })) }}
                      class="px-3 py-1.5 rounded-lg border border-outline-variant/20 text-2xs font-medium hover:border-outline-variant/40"
                    >
                      {m.eco_btn_edit()}
                    </button>
                    <button
                      type="button"
                      onclick={() => handleDeleteRecipe(recipe.id)}
                      class="px-3 py-1.5 rounded-lg border border-error/30 text-error text-2xs font-medium hover:bg-error/10"
                    >
                      {m.eco_btn_delete()}
                    </button>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}

        <p class="text-2xs text-on-surface-variant/50 leading-relaxed">{m.eco_recipe_shipped_hint()}</p>
      </div>
    {/if}

    {#if activeTab === 'titres'}
      <div class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
        <div class="flex flex-wrap items-start justify-between gap-4 border-b border-outline-variant/15 pb-4">
          <div class="max-w-2xl">
            <h3 class="text-lg font-semibold">{m.eco_titles_title()}</h3>
            <p class="text-xs text-on-surface-variant/60 mt-1 leading-relaxed">{m.eco_titles_desc()}</p>
          </div>
          {#if canManageSettings}
            <button type="button" onclick={openNewTitle} class="px-4 py-2 bg-primary hover:bg-primary-hover text-on-primary text-body-sm font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5">
              <Papicon icon="plus" size={14} />
              {m.eco_title_create()}
            </button>
          {/if}
        </div>

        {#if titlesLoading}
          <div class="flex items-center justify-center py-12">
            <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        {:else if titles.length === 0}
          <p class="text-xs text-on-surface-variant/50 italic text-center py-8">{m.eco_titles_empty()}</p>
        {:else}
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {#each titles as title (title.id)}
              {@const ownerIds = new Set(title.owners.map((owner: any) => owner.userId))}
              <div class="bg-surface-container-high/30 border border-outline-variant/10 p-6 rounded-xl flex flex-col justify-between">
                <div class="space-y-3">
                  <h4 class="font-semibold text-base leading-tight break-words" style="color: {title.color}">{title.name}</h4>
                  {#if title.description}
                    <p class="text-xs text-on-surface-variant/60 leading-relaxed">{title.description}</p>
                  {/if}

                  <div class="flex flex-wrap gap-1.5 text-2xs font-bold">
                    {#each titleBonusBadges(title) as badge}
                      <span class="bg-primary/10 text-primary px-2 py-0.5 rounded-lg">{badge.label} {badge.value}</span>
                    {:else}
                      <span class="text-on-surface-variant/50 italic font-normal">{m.eco_title_no_bonus()}</span>
                    {/each}
                  </div>

                  <div class="border-t border-outline-variant/5 pt-3 space-y-2">
                    <span class="text-xs font-semibold text-on-surface-variant/50">{m.eco_title_owners({ count: title.owners.length })}</span>
                    <div class="flex flex-wrap gap-1.5">
                      {#each title.owners as owner (owner.userId)}
                        <span class="text-2xs bg-outline-variant/10 rounded-lg pl-2 pr-1 py-0.5 flex items-center gap-1">
                          {owner.displayName}
                          {#if canManageSettings}
                            <button type="button" onclick={() => handleRevokeTitle(title, owner)} class="p-0.5 rounded hover:bg-error/20 text-error" title={m.eco_title_revoke()}>
                              <Papicon icon="x" size={10} />
                            </button>
                          {/if}
                        </span>
                      {/each}
                    </div>

                    {#if canManageSettings}
                      <div class="flex items-center gap-2">
                        <SearchableSelect
                          value={titleGrantPick[title.id] ?? null}
                          options={players.filter((player: any) => !ownerIds.has(player.userId)).map((player: any) => ({ id: player.userId, name: player.displayName }))}
                          placeholder={m.eco_title_grant_placeholder()}
                          clearable={true}
                          className="flex-1 min-w-0"
                          on:change={(e: any) => titleGrantPick[title.id] = e.detail?.value ?? null}
                        />
                        <button type="button" onclick={() => handleGrantTitle(title)} disabled={!titleGrantPick[title.id]} class="px-3 py-2 bg-primary/10 hover:bg-primary/20 text-primary rounded-lg text-2xs font-bold disabled:opacity-50 shrink-0">
                          {m.eco_title_grant()}
                        </button>
                      </div>
                    {/if}
                  </div>
                </div>

                {#if canManageSettings}
                  <div class="mt-6 border-t border-outline-variant/5 pt-4 flex items-center gap-2">
                    <button type="button" onclick={() => openEditTitle(title)} class="flex-1 px-3 py-2 bg-outline-variant/10 hover:bg-outline-variant/20 rounded-lg text-2xs font-bold disabled:opacity-50 flex items-center justify-center gap-1.5">
                      <Papicon icon="edit" size={12} />
                      {m.eco_bestiary_btn_customize()}
                    </button>
                    <button type="button" onclick={() => handleDeleteTitle(title)} class="px-3 py-2 bg-error/10 hover:bg-error/20 text-error rounded-lg text-2xs font-bold disabled:opacity-50">
                      <Papicon icon="trash" size={12} />
                    </button>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    {#if activeTab === 'quetes'}
      <div class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
        <div class="flex flex-wrap items-start justify-between gap-4 border-b border-outline-variant/15 pb-4">
          <div class="max-w-2xl">
            <h3 class="text-lg font-semibold">{m.eco_quests_title()}</h3>
            <p class="text-xs text-on-surface-variant/60 mt-1 leading-relaxed">{m.eco_quests_desc()}</p>
          </div>
          {#if canManageSettings}
            <button type="button" onclick={openNewQuest} class="px-4 py-2 bg-primary hover:bg-primary-hover text-on-primary text-body-sm font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5">
              <Papicon icon="plus" size={14} />
              {m.eco_quest_create()}
            </button>
          {/if}
        </div>

        {#if !config.clansEnabled}
          <p class="text-2xs text-warning/80 bg-warning/5 border border-warning/20 rounded-lg px-4 py-3 leading-relaxed">
            {m.eco_quests_clans_off()}
          </p>
        {/if}

        {#if questsLoading}
          <div class="flex items-center justify-center py-12">
            <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        {:else}
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {#each quests as quest (quest.id)}
              <div class="bg-surface-container-high/30 border border-outline-variant/10 p-6 rounded-xl flex flex-col justify-between {quest.enabled ? '' : 'opacity-50'}">
                <div class="space-y-3">
                  <div class="flex items-start gap-3">
                    <EmojiText value={quest.emoji} size="1.125rem" class="text-lg" />
                    <div class="min-w-0">
                      <h4 class="font-semibold text-base leading-tight break-words">{quest.name}</h4>
                      <div class="flex flex-wrap gap-1 mt-1.5">
                        <span class="text-2xs font-bold uppercase tracking-widest px-2 py-0.5 rounded-full {quest.scope === 'TEAM' ? 'text-tertiary bg-tertiary/10' : 'text-on-surface-variant/60 bg-outline-variant/10'}">
                          {quest.scope === 'TEAM' ? m.eco_quest_scope_team() : m.eco_quest_scope_member()}
                        </span>
                        {#if quest.scope === 'TEAM'}
                          <span class="text-xs font-semibold text-on-surface-variant/60 bg-outline-variant/10 px-2 py-0.5 rounded-full">
                            {quest.teamMode === 'CLAN' ? m.eco_raid_mode_clan() : m.eco_raid_mode_guild()}
                          </span>
                        {/if}
                        {#if quest.repeatable}
                          <span class="text-xs font-semibold text-tertiary bg-tertiary/10 px-2 py-0.5 rounded-full">{m.eco_quest_badge_repeatable()}</span>
                        {/if}
                        {#if !quest.enabled}
                          <span class="text-xs font-semibold text-error bg-error/10 px-2 py-0.5 rounded-full">{m.eco_bestiary_badge_disabled()}</span>
                        {/if}
                      </div>
                    </div>
                  </div>

                  <p class="text-xs text-on-surface-variant/60 leading-relaxed">{quest.description}</p>

                  <p class="text-body-sm font-semibold">
                    {m.eco_quest_goal({ target: quest.target, objective: questObjectiveLabel(quest.objective), hours: quest.windowHours })}
                  </p>

                  <div class="text-2xs text-on-surface-variant/70 flex flex-wrap gap-3">
                    {#if quest.rewardXp > 0}<span>{m.eco_xp()} +{quest.rewardXp}</span>{/if}
                    {#if quest.rewardCoins > 0}<span><EmojiText value={config.currencyEmoji} /> +{quest.rewardCoins}</span>{/if}
                    {#if quest.rewardClanPoints > 0}
                      {@const toGuild = quest.scope === 'TEAM' && quest.teamMode === 'RPG_GUILD'}
                      <span class="{(toGuild ? config.guildsEnabled : config.clansEnabled) ? '' : 'line-through opacity-60'}">
                        {toGuild
                          ? m.eco_quest_guild_xp_short({ points: quest.rewardClanPoints })
                          : m.eco_bestiary_clan_points_short({ points: quest.rewardClanPoints })}
                      </span>
                    {/if}
                  </div>

                  {#if quest.windowEndsAt}
                    <p class="text-2xs text-on-surface-variant/50">
                      {m.eco_quest_window_ends({ date: new Date(quest.windowEndsAt).toLocaleString() })}
                    </p>
                  {/if}
                </div>

                {#if canManageSettings}
                  <div class="mt-6 border-t border-outline-variant/5 pt-4 flex items-center gap-2">
                    <button type="button" onclick={() => openEditQuest(quest)} class="flex-1 px-3 py-2 bg-outline-variant/10 hover:bg-outline-variant/20 rounded-lg text-2xs font-bold disabled:opacity-50 flex items-center justify-center gap-1.5">
                      <Papicon icon="edit" size={12} />
                      {m.eco_bestiary_btn_customize()}
                    </button>
                    <button type="button" onclick={() => handleDeleteQuest(quest)} class="px-3 py-2 bg-error/10 hover:bg-error/20 text-error rounded-lg text-2xs font-bold disabled:opacity-50">
                      <Papicon icon="trash" size={12} />
                    </button>
                  </div>
                {/if}
              </div>
            {:else}
              <p class="text-xs text-on-surface-variant/60 italic py-6">{m.eco_quests_empty()}</p>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Tab 4: Raid hebdomadaire -->
    {#if activeTab === 'raid'}
      <div class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
        <div class="border-b border-outline-variant/15 pb-4 max-w-3xl">
          <h3 class="text-lg font-semibold">{m.eco_raid_title()}</h3>
          <p class="text-xs text-on-surface-variant/60 mt-1 leading-relaxed">{m.eco_raid_desc()}</p>
        </div>

        <div class="flex items-center justify-between gap-4 bg-surface-container-high/30 border border-outline-variant/10 rounded-xl px-5 py-4">
          <div>
            <h4 class="text-sm font-bold">{m.eco_raid_toggle_title()}</h4>
            <p class="text-xs text-on-surface-variant/60 mt-0.5 leading-relaxed">{m.eco_raid_toggle_desc()}</p>
          </div>
          <ToggleSwitch
            checked={config.raidEnabled}
            onToggle={(v: boolean) => config.raidEnabled = v}
            disabled={!canManageSettings}
          />
        </div>

        <!-- Les deux modes ne se valent pas : le clan du serveur porte les points, les
             saisons et le classement, la guilde RPG n'est qu'une equipe de jeu. -->
        <div class="space-y-3">
          <h4 class="text-xs font-semibold text-on-surface-variant/60">{m.eco_raid_team_mode_title()}</h4>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            {#each [{ id: 'CLAN', name: m.eco_raid_mode_clan(), desc: m.eco_raid_mode_clan_desc(), off: m.eco_raid_mode_clan_off() }, { id: 'RPG_GUILD', name: m.eco_raid_mode_guild(), desc: m.eco_raid_mode_guild_desc(), off: m.eco_raid_mode_guild_off() }] as mode (mode.id)}
              {@const available = raidTeamModeAvailable[mode.id as 'CLAN' | 'RPG_GUILD']}
              {@const selected = config.raidTeamMode === mode.id}
              <button
                type="button"
                onclick={() => config.raidTeamMode = mode.id}
                disabled={!canManageSettings || !available}
                aria-pressed={selected}
                class="text-left p-4 rounded-xl border transition-all disabled:opacity-50 disabled:cursor-not-allowed {selected ? 'bg-primary/8 border-primary/50' : 'bg-surface-container-low/30 border-outline-variant/10 hover:border-outline-variant/30'}"
              >
                <div class="flex items-center gap-2">
                  <span class="text-body-sm font-semibold">{mode.name}</span>
                  {#if mode.id === 'CLAN'}
                    <span class="text-xs font-semibold px-2 py-0.5 rounded-lg border border-primary/30 text-primary/80">{m.eco_raid_mode_recommended()}</span>
                  {/if}
                </div>
                <p class="text-2xs text-on-surface-variant/60 mt-2 leading-relaxed">{mode.desc}</p>
                {#if !available}
                  <p class="text-2xs text-warning/80 mt-2 leading-relaxed">{mode.off}</p>
                {/if}
              </button>
            {/each}
          </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div class="space-y-4 bg-surface-container-high/20 border border-outline-variant/10 rounded-xl p-5">
            <h4 class="text-xs font-semibold text-on-surface-variant/60">{m.eco_raid_window_title()}</h4>

            <!-- Un serveur peut preferer lancer son raid quand son equipe est la, plutot
                 qu'a heure fixe. Le jour et l'heure n'ont alors plus d'objet. -->
            <div class="flex items-center justify-between gap-4 bg-surface-container-high/30 border border-outline-variant/10 rounded-lg px-4 py-3">
              <div>
                <h5 class="text-body-sm font-semibold">{m.eco_raid_auto_title()}</h5>
                <p class="text-2xs text-on-surface-variant/60 mt-0.5 leading-relaxed">{m.eco_raid_auto_desc()}</p>
              </div>
              <ToggleSwitch
                checked={config.raidAutoSchedule}
                onToggle={(v: boolean) => config.raidAutoSchedule = v}
                disabled={!canManageSettings || !config.raidEnabled}
              />
            </div>

            <!-- Le lancement lit la configuration enregistree, pas le formulaire : sans ce
                 verrou, eteindre l'ouverture automatique puis cliquer aussitot lancerait un
                 raid avec la duree et les recompenses d'avant. -->
            {#if !config.raidAutoSchedule}
              <button
                type="button"
                onclick={handleStartRaid}
                disabled={!canManageSettings || !config.enabled || !config.raidEnabled || !!raidState?.open || configDirty}
                class="w-full px-4 py-3 bg-primary hover:bg-primary-hover text-on-primary text-body-sm font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                <Papicon icon="Sparkles" size={15} />
                {raidState?.open ? m.eco_raid_start_running() : m.eco_raid_start()}
              </button>
              <p class="text-2xs text-on-surface-variant/50 leading-relaxed">
                {!config.enabled ? m.eco_paused_title() : configDirty ? m.eco_raid_start_unsaved() : m.eco_raid_start_hint()}
              </p>
            {/if}

            <div class="grid grid-cols-2 gap-3 {config.raidAutoSchedule ? '' : 'opacity-50'}">
              <div class="space-y-1.5">
                <label for="raidWeekday" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_raid_weekday()}</label>
                <select id="raidWeekday" bind:value={config.raidWeekday} disabled={!canManageSettings || !config.raidEnabled || !config.raidAutoSchedule} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50">
                  {#each raidWeekdayLabels as label, index (label)}
                    <option value={index}>{label}</option>
                  {/each}
                </select>
              </div>
              <div class="space-y-1.5">
                <label for="raidHour" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_raid_hour()}</label>
                <input id="raidHour" type="number" min="0" max="23" bind:value={config.raidHour} disabled={!canManageSettings || !config.raidEnabled || !config.raidAutoSchedule} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50" />
              </div>
            </div>

            <div class="space-y-1.5">
              <label for="raidDuration" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_raid_duration()}</label>
              <input id="raidDuration" type="number" min="1" max="168" bind:value={config.raidDurationHours} disabled={!canManageSettings || !config.raidEnabled} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50" />
              <p class="text-2xs text-on-surface-variant/50">{m.eco_raid_window_hint()}</p>
            </div>

            <div class="space-y-1.5">
              <label for="raidBoss" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_raid_boss_choice()}</label>
              <select id="raidBoss" bind:value={config.raidBossName} disabled={!canManageSettings || !config.raidEnabled} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50">
                <option value={null}>{m.eco_raid_boss_random()}</option>
                {#each selectableRaidBosses as boss (boss.id)}
                  <option value={boss.name}>{bossOptionLabel(boss)}</option>
                {/each}
                {#if unavailableRaidBoss}
                  <option value={unavailableRaidBoss}>{m.eco_raid_boss_unavailable({ name: unavailableRaidBoss })}</option>
                {/if}
              </select>
            </div>
          </div>

          <div class="space-y-4 bg-surface-container-high/20 border border-outline-variant/10 rounded-xl p-5">
            <h4 class="text-xs font-semibold text-on-surface-variant/60">{m.eco_raid_balance_title()}</h4>

            <div class="grid grid-cols-2 gap-3">
              <div class="space-y-1.5">
                <label for="raidPerMember" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_raid_health_per_member()}</label>
                <input id="raidPerMember" type="number" min="100" max="10000000" bind:value={config.raidHealthPerMember} disabled={!canManageSettings || !config.raidEnabled} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50" />
              </div>
              <div class="space-y-1.5">
                <label for="raidAssaults" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_raid_assaults()}</label>
                <input id="raidAssaults" type="number" min="1" max="20" bind:value={config.raidAssaultsPerMember} disabled={!canManageSettings || !config.raidEnabled} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50" />
              </div>
              <div class="space-y-1.5">
                <label for="raidBoughtAssaults" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_raid_bought_assaults()}</label>
                <input id="raidBoughtAssaults" type="number" min="0" max="20" bind:value={config.raidBoughtAssaultsMax} disabled={!canManageSettings || !config.raidEnabled} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50" />
                <p class="text-2xs text-on-surface-variant/50">{m.eco_raid_bought_assaults_hint()}</p>
              </div>
              <div class="space-y-1.5">
                <label for="raidFloor" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_raid_health_floor()}</label>
                <input id="raidFloor" type="number" min="500" bind:value={config.raidHealthFloor} disabled={!canManageSettings || !config.raidEnabled} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50" />
              </div>
              <div class="space-y-1.5">
                <label for="raidCap" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_raid_health_cap()}</label>
                <input id="raidCap" type="number" min="500" bind:value={config.raidHealthCap} disabled={!canManageSettings || !config.raidEnabled} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50" />
              </div>
              <div class="space-y-1.5 col-span-2">
                <label for="raidEnergy" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_raid_energy()}</label>
                <input id="raidEnergy" type="number" min="0" max="100" bind:value={config.raidEnergyCost} disabled={!canManageSettings || !config.raidEnabled} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50" />
              </div>
            </div>

            <!-- Une reserve ne se juge pas sur son chiffre mais sur ce qu'elle donne pour
                 une equipe reelle : trois joueurs d'un cote, vingt de l'autre. -->
            <div class="text-2xs text-on-surface-variant/60 bg-surface-container-high/30 border border-outline-variant/5 rounded-lg px-3 py-2 leading-relaxed">
              {m.eco_raid_health_preview({
                small: raidHealthPreview(3).toLocaleString(),
                large: raidHealthPreview(20).toLocaleString(),
              })}
            </div>
          </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div class="space-y-4 bg-surface-container-high/20 border border-outline-variant/10 rounded-xl p-5">
            <h4 class="text-xs font-semibold text-on-surface-variant/60">{m.eco_raid_rewards_title()}</h4>
            <p class="text-2xs text-on-surface-variant/50 leading-relaxed">{m.eco_raid_rewards_hint()}</p>

            <div class="grid grid-cols-2 gap-3">
              <div class="space-y-1.5">
                <label for="raidXp" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_raid_reward_xp()}</label>
                <input id="raidXp" type="number" min="0" bind:value={config.raidXpReward} disabled={!canManageSettings || !config.raidEnabled} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50" />
              </div>
              <div class="space-y-1.5">
                <label for="raidCoins" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_raid_reward_coins({ currency: config.currencyName })}</label>
                <input id="raidCoins" type="number" min="0" bind:value={config.raidCoinReward} disabled={!canManageSettings || !config.raidEnabled} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50" />
              </div>
              <!-- Le meme reglage credite le clan ou la guilde du jeu selon le mode : ce
                   qui change, c'est qui encaisse au bout, pas le montant a saisir. -->
              <div class="space-y-1.5 col-span-2">
                <label for="raidPoints" class="text-xs font-semibold text-on-surface-variant/60">{raidGuildMode ? m.eco_raid_reward_guild_xp() : m.eco_raid_reward_points()}</label>
                <input id="raidPoints" type="number" min="0" bind:value={config.raidClanPoints} disabled={!canManageSettings || !config.raidEnabled || !(raidGuildMode ? config.guildsEnabled : config.clansEnabled)} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50" />
                <p class="text-2xs text-on-surface-variant/50">{raidGuildMode ? m.eco_raid_reward_guild_xp_hint() : m.eco_raid_reward_points_hint()}</p>
              </div>
              <div class="space-y-1.5 col-span-2">
                <label for="raidConsolation" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_raid_consolation()}</label>
                <input id="raidConsolation" type="number" min="0" max="100" bind:value={config.raidConsolationShare} disabled={!canManageSettings || !config.raidEnabled} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50" />
                <p class="text-2xs text-on-surface-variant/50">{m.eco_raid_consolation_hint()}</p>
              </div>
            </div>
          </div>

          <div class="space-y-4 bg-surface-container-high/20 border border-outline-variant/10 rounded-xl p-5">
            <h4 class="text-xs font-semibold text-on-surface-variant/60">{m.eco_raid_announce_title()}</h4>
            <p class="text-2xs text-on-surface-variant/50 leading-relaxed">{m.eco_raid_announce_hint()}</p>

            <div class="space-y-1.5">
              <label for="raidAnnounce" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bm_announce_mode()}</label>
              <select id="raidAnnounce" bind:value={config.raidAnnounce} disabled={!canManageSettings || !config.raidEnabled} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50">
                <option value="NONE" disabled={config.raidEnabled}>{m.eco_raid_announce_none()}</option>
                <option value="CHANNEL">{m.eco_bm_announce_channel()}</option>
                <option value="CHANNEL_ROLE">{m.eco_bm_announce_channel_role()}</option>
              </select>
            </div>

            {#if config.raidAnnounce !== 'NONE'}
              <div class="space-y-1.5">
                <label for="raidChannel" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bm_announce_channel_label()}</label>
                <SearchableSelect
                  id="raidChannel"
                  bind:value={config.raidChannelId}
                  options={availableChannels.map((c: any) => ({ id: c.id, name: channelDisplayName(c) }))}
                  placeholder={m.eco_bm_select_channel()}
                  className="w-full"
                />
              </div>
            {/if}

            {#if config.raidAnnounce === 'CHANNEL_ROLE'}
              <div class="space-y-1.5">
                <label for="raidRole" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bm_announce_role_label()}</label>
                <SearchableSelect
                  id="raidRole"
                  bind:value={config.raidRoleId}
                  options={availableRoles.map((r: any) => ({ id: r.id, name: `@${r.name}` }))}
                  placeholder={m.eco_bm_select_role()}
                  className="w-full"
                />
              </div>
            {/if}
          </div>
        </div>

        {#if raidState?.open}
          <div class="bg-surface-container-high/30 border border-outline-variant/10 rounded-xl px-5 py-4 space-y-3">
            <h4 class="text-sm font-bold"><EmojiText value={raidState.open.bossEmoji} /> {m.eco_raid_live_title({ boss: raidState.open.bossName })}</h4>
            {#each raidState.teams ?? [] as team (team.id)}
              <div class="flex items-center justify-between gap-3 text-xs">
                <span class="font-semibold truncate">{team.teamName}</span>
                <span class="text-on-surface-variant/60 shrink-0">
                  {team.remainingHealth <= 0
                    ? m.eco_raid_live_defeated()
                    : `${team.remainingHealth.toLocaleString()} / ${team.totalHealth.toLocaleString()}`}
                </span>
              </div>
            {:else}
              <p class="text-2xs text-on-surface-variant/50 italic">{m.eco_raid_live_no_team()}</p>
            {/each}
          </div>
        {:else if raidState?.nextOpensAt && config.raidAutoSchedule}
          <p class="text-2xs text-on-surface-variant/50">
            {m.eco_raid_next_opening({ date: new Date(raidState.nextOpensAt).toLocaleString() })}
          </p>
        {/if}

        <!-- Le bilan du dernier raid tient une journee : passe ce delai il n'interesse plus
             personne, et la place revient aux reglages du raid suivant. -->
        <!-- L'historique ne perime pas : sans lui, l'onglet se vidait des que le bilan
             expirait et ne disait plus rien des semaines passees. -->
        {#if pastRaids.length > 0}
          <div class="bg-surface-container-high/20 border border-outline-variant/10 rounded-xl px-5 py-4 space-y-2">
            <h4 class="text-xs font-semibold text-on-surface-variant/60">{m.eco_raid_history_title()}</h4>
            {#each pastRaids as past (past.id)}
              {@const downed = past.teams.filter((team: any) => team.defeated).length}
              <div class="flex flex-wrap items-baseline justify-between gap-2 text-xs border-b border-outline-variant/10 last:border-0 py-1.5">
                <span class="font-semibold truncate"><EmojiText value={past.bossEmoji} /> {past.bossName}</span>
                <span class="text-on-surface-variant/60 text-2xs">
                  {m.eco_raid_history_line({
                    date: new Date(past.resolvedAt ?? past.opensAt).toLocaleDateString(),
                    teams: past.teams.length,
                  })}
                  ·
                  {downed > 0 ? m.eco_raid_history_downed({ count: downed }) : m.eco_raid_history_survived()}
                </span>
              </div>
            {/each}
          </div>
        {/if}

        {#if raidRecap}
          <div class="bg-surface-container-high/30 border border-outline-variant/10 rounded-xl px-5 py-4 space-y-4">
            <div>
              <h4 class="text-sm font-bold"><EmojiText value={raidRecap.raid.bossEmoji} /> {m.eco_raid_recap_title({ boss: raidRecap.raid.bossName })}</h4>
              <p class="text-2xs text-on-surface-variant/50 mt-0.5">
                {m.eco_raid_recap_closed({ date: new Date(raidRecap.raid.resolvedAt).toLocaleString() })}
              </p>
            </div>

            <div class="space-y-1.5">
              <h5 class="text-xs font-semibold text-on-surface-variant/60">{m.eco_raid_recap_teams()}</h5>
              {#each raidRecap.teams as team (team.id)}
                <div class="flex items-center justify-between gap-3 text-xs">
                  <span class="font-semibold truncate flex items-center gap-1.5">
                    {#if team.defeatedAt}
                      <Papicon icon="Trophy" size={12} class="text-success shrink-0" />
                    {:else}
                      <Papicon icon="Shield" size={12} class="text-on-surface-variant/40 shrink-0" />
                    {/if}
                    {team.teamName}
                  </span>
                  <span class="text-on-surface-variant/60 shrink-0">
                    {team.defeatedAt
                      ? m.eco_raid_live_defeated()
                      : `${team.remainingHealth.toLocaleString()} / ${team.totalHealth.toLocaleString()}`}
                  </span>
                </div>
              {:else}
                <p class="text-2xs text-on-surface-variant/50 italic">{m.eco_raid_live_no_team()}</p>
              {/each}
            </div>

            {#if raidRecap.strikers.length > 0}
              <div class="space-y-1.5">
                <h5 class="text-xs font-semibold text-on-surface-variant/60">{m.eco_raid_recap_strikers()}</h5>
                {#each raidRecap.strikers as striker, i (striker.userId)}
                  <div class="flex items-center justify-between gap-3 text-xs">
                    <span class="truncate">{i + 1}. {striker.displayName}</span>
                    <span class="text-on-surface-variant/60 shrink-0">
                      {m.eco_raid_recap_damage({ damage: striker.damage.toLocaleString(), assaults: striker.assaults })}
                    </span>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}

        <div class="border-t border-outline-variant/15 pt-6 space-y-4">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="max-w-2xl">
              <h4 class="text-sm font-bold">{m.eco_raid_bosses_title()}</h4>
              <p class="text-xs text-on-surface-variant/60 mt-0.5 leading-relaxed">{m.eco_raid_bosses_desc()}</p>
            </div>
            {#if canManageSettings}
              <div class="flex gap-2">
                <button type="button" onclick={openNewRaidBoss} class="px-4 py-2 bg-primary hover:bg-primary-hover text-on-primary text-body-sm font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5">
                  <Papicon icon="plus" size={14} />
                  {m.eco_raid_boss_create()}
                </button>
                <button type="button" onclick={handleRestoreRaidBosses} class="px-4 py-2 bg-outline-variant/10 hover:bg-outline-variant/20 text-body-sm font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5" title={m.eco_raid_restore_hint()}>
                  <Papicon icon="refresh" size={14} />
                  {m.eco_raid_restore()}
                </button>
              </div>
            {/if}
          </div>

          {#if raidLoading}
            <div class="flex items-center justify-center py-12">
              <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          {:else}
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {#each raidBosses as boss (boss.id)}
                <div class="bg-surface-container-high/30 border border-outline-variant/10 p-6 rounded-xl flex flex-col justify-between {boss.enabled ? '' : 'opacity-50'}">
                  <div class="space-y-3">
                    <div class="flex items-start gap-3">
                      <EmojiText value={boss.emoji} size="1.125rem" class="text-lg" />
                      <div class="min-w-0">
                        <h4 class="font-semibold text-base leading-tight break-words">{boss.name}</h4>
                        <div class="flex flex-wrap gap-1 mt-1.5">
                          <span class="text-xs font-semibold text-on-surface-variant/60 bg-outline-variant/10 px-2 py-0.5 rounded-full">{m.eco_rpg_level()} {boss.level}</span>
                          {#if !boss.enabled}
                            <span class="text-xs font-semibold text-error bg-error/10 px-2 py-0.5 rounded-full">{m.eco_bestiary_badge_disabled()}</span>
                          {/if}
                        </div>
                      </div>
                    </div>

                    <p class="text-xs text-on-surface-variant/60 leading-relaxed">{boss.description}</p>

                    <div class="flex flex-wrap gap-1.5 text-2xs font-bold">
                      <span class="bg-error/10 text-error px-2 py-0.5 rounded-lg flex items-center gap-1"><Papicon icon="zap" size={10} /> {boss.attack}</span>
                      <span class="bg-blue-500/10 text-blue-400 px-2 py-0.5 rounded-lg flex items-center gap-1"><Papicon icon="shield" size={10} /> {boss.defense}</span>
                      <span class="bg-warning/10 text-warning px-2 py-0.5 rounded-lg flex items-center gap-1"><Papicon icon="activity" size={10} /> {boss.speed}</span>
                    </div>

                    <div class="border-t border-outline-variant/5 pt-3 space-y-1">
                      <span class="text-xs font-semibold text-on-surface-variant/50">{m.eco_raid_spells_label()}</span>
                      {#each boss.spells ?? [] as spell (spell.id)}
                        <p class="text-2xs text-on-surface-variant/80 flex items-center gap-1.5">
                          <Papicon icon={spell.icon} size={11} class="text-on-surface-variant/60" />
                          {spell.name}
                        </p>
                      {:else}
                        <p class="text-2xs text-on-surface-variant/40 italic">{m.eco_raid_no_spell()}</p>
                      {/each}
                    </div>
                  </div>

                  {#if canManageSettings}
                    <div class="mt-6 border-t border-outline-variant/5 pt-4 flex items-center gap-2">
                      <button type="button" onclick={() => openEditRaidBoss(boss)} class="flex-1 px-3 py-2 bg-outline-variant/10 hover:bg-outline-variant/20 rounded-lg text-2xs font-bold disabled:opacity-50 flex items-center justify-center gap-1.5">
                        <Papicon icon="edit" size={12} />
                        {m.eco_bestiary_btn_customize()}
                      </button>
                      <button type="button" onclick={() => handleDeleteRaidBoss(boss)} class="px-3 py-2 bg-error/10 hover:bg-error/20 text-error rounded-lg text-2xs font-bold disabled:opacity-50">
                        <Papicon icon="trash" size={12} />
                      </button>
                    </div>
                  {/if}
                </div>
              {:else}
                <p class="text-xs text-on-surface-variant/60 italic py-6">{m.eco_raid_no_boss()}</p>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    {/if}

    {#if activeTab === 'blackmarket'}
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6 h-fit">
          <div class="border-b border-outline-variant/15 pb-4">
            <h3 class="text-lg font-semibold">{m.eco_bm_title()}</h3>
            <p class="text-xs text-on-surface-variant/60 mt-1">{m.eco_bm_desc()}</p>
          </div>

          <div class="flex items-center justify-between py-2">
            <div>
              <h4 class="text-sm font-bold">{m.eco_bm_toggle_title()}</h4>
              <p class="text-xs text-on-surface-variant/60 mt-0.5">{m.eco_bm_toggle_desc()}</p>
            </div>
            <ToggleSwitch
              checked={config.blackMarketEnabled}
              onToggle={(v: boolean) => config.blackMarketEnabled = v}
              disabled={!canManageSettings || !config.shopEnabled}
            />
          </div>

          {#if !config.shopEnabled}
            <p class="text-xs text-on-surface-variant/60 bg-surface-container-high/30 border border-outline-variant/10 rounded-lg px-4 py-3">
              {m.eco_bm_requires_shop()}
            </p>
          {/if}

          <div class="space-y-4 pt-2 border-t border-outline-variant/10 transition-opacity duration-300 {!config.blackMarketEnabled ? 'opacity-60' : ''}">
            <h4 class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bm_rhythm_title()}</h4>
            <div class="grid grid-cols-2 gap-4">
              <div class="space-y-1.5">
                <label for="bmInterval" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bm_interval()}</label>
                <input id="bmInterval" type="number" min="1" max="365" bind:value={config.blackMarketIntervalDays} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed" disabled={!canManageSettings || !config.blackMarketEnabled} />
                <p class="text-2xs text-on-surface-variant/40">{m.eco_bm_interval_hint()}</p>
              </div>
              <div class="space-y-1.5">
                <label for="bmDuration" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bm_duration()}</label>
                <input id="bmDuration" type="number" min="15" max="1440" bind:value={config.blackMarketDurationMin} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed" disabled={!canManageSettings || !config.blackMarketEnabled} />
                <p class="text-2xs text-on-surface-variant/40">{m.eco_bm_duration_hint()}</p>
              </div>
            </div>
          </div>
        </div>

        <div class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6 h-fit transition-opacity duration-300 {!config.blackMarketEnabled ? 'opacity-60' : ''}">
          <h3 class="text-lg font-semibold border-b border-outline-variant/15 pb-4">{m.eco_bm_offers_title()}</h3>

          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-1.5">
              <label for="bmOfferCount" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bm_offer_count()}</label>
              <input id="bmOfferCount" type="number" min="1" max="25" bind:value={config.blackMarketOfferCount} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed" disabled={!canManageSettings || !config.blackMarketEnabled} />
            </div>
            <div class="space-y-1.5">
              <label for="bmMaxQty" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bm_max_quantity()}</label>
              <input id="bmMaxQty" type="number" min="1" max="99" bind:value={config.blackMarketMaxQuantity} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed" disabled={!canManageSettings || !config.blackMarketEnabled} />
            </div>
            <div class="space-y-1.5">
              <label for="bmDiscountMin" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bm_discount_min()}</label>
              <input id="bmDiscountMin" type="number" min="1" max="90" bind:value={config.blackMarketDiscountMin} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed" disabled={!canManageSettings || !config.blackMarketEnabled} />
            </div>
            <div class="space-y-1.5">
              <label for="bmDiscountMax" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bm_discount_max()}</label>
              <input id="bmDiscountMax" type="number" min="1" max="90" bind:value={config.blackMarketDiscountMax} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed" disabled={!canManageSettings || !config.blackMarketEnabled} />
            </div>
          </div>

          <div class="space-y-4 pt-2 border-t border-outline-variant/10">
            <h4 class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bm_announce_title()}</h4>

            <div class="space-y-1.5">
              <label for="bmAnnounce" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bm_announce_mode()}</label>
              <select id="bmAnnounce" bind:value={config.blackMarketAnnounce} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed" disabled={!canManageSettings || !config.blackMarketEnabled}>
                <option value="NONE">{m.eco_bm_announce_none()}</option>
                <option value="CHANNEL">{m.eco_bm_announce_channel()}</option>
                <option value="CHANNEL_ROLE">{m.eco_bm_announce_channel_role()}</option>
              </select>
            </div>

            {#if config.blackMarketAnnounce !== 'NONE'}
              <div class="space-y-1.5">
                <label for="bmChannel" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bm_announce_channel_label()}</label>
                <SearchableSelect
                  id="bmChannel"
                  bind:value={config.blackMarketChannelId}
                  options={availableChannels.map((c: any) => ({ id: c.id, name: channelDisplayName(c) }))}
                  placeholder={m.eco_bm_select_channel()}
                  className="w-full"
                />
              </div>
            {/if}

            {#if config.blackMarketAnnounce === 'CHANNEL_ROLE'}
              <div class="space-y-1.5">
                <label for="bmRole" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bm_announce_role_label()}</label>
                <SearchableSelect
                  id="bmRole"
                  bind:value={config.blackMarketRoleId}
                  options={availableRoles.map((r: any) => ({ id: r.id, name: `@${r.name}` }))}
                  placeholder={m.eco_bm_select_role()}
                  className="w-full"
                />
              </div>
            {/if}
          </div>
        </div>
      </div>
    {/if}

    <!-- Tab 4: Players list & Leaderboard -->
    {#if activeTab === 'peche'}
      <RpgFishPanel canManage={canManageSettings} currencyName={config.currencyName} />
    {/if}

    {#if activeTab === 'donjons'}
      <RpgDungeonsPanel canManage={canManageSettings} currencyName={config.currencyName} />
    {/if}

    {#if activeTab === 'tour'}
      <RpgTowerPanel canManage={canManageSettings} currencyName={config.currencyName} />
    {/if}

    {#if activeTab === 'aventures'}
      <RpgEventsPanel canManage={canManageSettings} />
    {/if}

    {#if activeTab === 'guildes'}
      <RpgGuildsPanel canManage={canManageSettings} currencyName={config.currencyName} />
    {/if}

    {#if activeTab === 'players'}
      <div class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
        <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-outline-variant/15 pb-4">
          <h3 class="text-lg font-semibold">{m.eco_players_title()}</h3>
          
          <div class="flex flex-col sm:flex-row sm:items-center gap-2 w-full md:w-auto">
            <input 
              type="search" 
              placeholder={m.eco_search_players_ph()} 
              bind:value={searchQuery}
              class="bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none w-full md:w-64"
            />

            {#if canManageSettings}
              <button
                type="button"
                onclick={() => triggerReset('profiles')}
                disabled={players.length === 0}
                title={m.eco_players_reset_all_hint()}
                class="px-4 py-2.5 bg-error/10 hover:bg-error/20 text-error text-2xs font-bold rounded-lg border border-error/20 transition-all flex items-center justify-center gap-1.5 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Papicon icon="trash" size={13} />
                {m.eco_players_reset_all_btn()}
              </button>
            {/if}
          </div>
        </div>

        {#if playersLoading}
          <div class="flex items-center justify-center py-12">
            <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse text-xs">
              <thead>
                <tr class="border-b border-outline-variant/10 text-on-surface-variant/55 font-semibold text-xs">
                  <th class="py-4 px-4">{m.eco_col_rank()}</th>
                  <th class="py-4 px-4">{m.eco_col_player()}</th>
                  <th class="py-4 px-4">{m.eco_col_balance()}</th>
                  <th class="py-4 px-4">{m.eco_col_stats_gear()}</th>
                  <th class="py-4 px-4">{m.eco_col_hp_energy()}</th>
                  <th class="py-4 px-4">{m.eco_col_location_guild()}</th>
                  {#if canManageSettings}
                    <th class="py-4 px-4 text-right">{m.eco_col_actions()}</th>
                  {/if}
                </tr>
              </thead>
              <tbody>
                {#each filteredPlayers as player (player.userId)}
                  <tr class="border-b border-outline-variant/5 hover:bg-surface-container-high/10 transition-colors">
                    <td class="py-4 px-4 font-bold">#{playerRanks.get(player.userId)}</td>
                    <td class="py-4 px-4 flex items-center gap-3">
                      {#if player.avatarUrl}
                        <img src={player.avatarUrl} alt="Avatar" class="w-8 h-8 rounded-full border border-outline-variant/20" />
                      {:else}
                        <div class="w-8 h-8 rounded-full bg-primary/20 text-primary flex items-center justify-center font-bold">U</div>
                      {/if}
                      <div>
                        <div class="font-semibold text-sm">{player.displayName || player.username}</div>
                        <div class="text-2xs text-on-surface-variant/40 font-mono mt-0.5">{player.userId}</div>
                        <!-- Bento mini-stats -->
                        <div class="flex items-center gap-2 mt-1 text-2xs font-bold text-on-surface-variant/50">
                          <span class="bg-error/5 text-error px-1.5 py-0.5 rounded">⚔️ {player.attack} ATK</span>
                          <span class="bg-blue-500/5 text-blue-400 px-1.5 py-0.5 rounded">🛡️ {player.defense} DEF</span>
                          <span class="bg-warning/5 text-warning px-1.5 py-0.5 rounded">⚡ {player.speed} SPD</span>
                        </div>
                      </div>
                    </td>
                    <td class="py-4 px-4 font-bold text-on-surface">
                      <div class="flex items-center gap-1.5">
                        {#if config.currencyIcon}
                          <img src={config.currencyIcon} alt={config.currencyName} class="w-4 h-4 object-contain inline-block" />
                        {:else}
                          <EmojiText value={config.currencyEmoji} />
                        {/if}
                        <span>{player.balance} {config.currencyName}</span>
                      </div>
                      <div class="text-2xs text-on-surface-variant/50 mt-0.5 font-normal">{m.eco_player_level_xp({ level: player.level, xp: player.xp })}</div>
                    </td>
                    <td class="py-4 px-4">
                      <!-- Equipment display -->
                      <div class="space-y-1.5">
                        {#if player.weapon}
                          <div class="flex items-center gap-1.5 text-2xs bg-primary/10 text-primary px-2 py-0.5 rounded-lg w-fit font-bold">
                            <EmojiText value={player.weapon.emoji || '⚔️'} />
                            <span class="truncate max-w-[120px]">{player.weapon.name} (+{player.weapon.atkBonus} ATK)</span>
                          </div>
                        {:else}
                          <div class="text-2xs text-on-surface-variant/30 italic">{m.eco_no_weapon()}</div>
                        {/if}

                        {#if player.armor}
                          <div class="flex items-center gap-1.5 text-2xs bg-success/10 text-success px-2 py-0.5 rounded-lg w-fit font-bold">
                            <EmojiText value={player.armor.emoji || '🛡️'} />
                            <span class="truncate max-w-[120px]">{player.armor.name} (+{player.armor.defBonus} DEF)</span>
                          </div>
                        {:else}
                          <div class="text-2xs text-on-surface-variant/30 italic">{m.eco_no_armor()}</div>
                        {/if}

                        {#each player.accessories ?? [] as accessory}
                          <div class="flex items-center gap-1.5 text-2xs bg-violet-500/10 text-violet-400 px-2 py-0.5 rounded-lg w-fit font-bold">
                            <EmojiText value={accessory.emoji || '💍'} />
                            <span class="truncate max-w-[120px]">{accessory.name}</span>
                          </div>
                        {/each}

                        <div class="text-2xs text-on-surface-variant/50">{m.eco_player_bag_size({ count: player.bagSize ?? 0 })}</div>
                      </div>
                    </td>
                    <td class="py-4 px-4">
                      <div class="flex items-center gap-2">
                        <div class="w-20 bg-surface-container-high rounded-full h-2">
                          <div class="bg-red-500 h-2 rounded-full" style="width: {Math.round((player.health / player.maxHealth) * 100)}%"></div>
                        </div>
                        <span class="font-bold">{player.health} / {player.maxHealth} HP</span>
                      </div>
                      <div class="flex items-center gap-2 mt-1.5">
                        <div class="w-20 bg-surface-container-high rounded-full h-2">
                          <div class="bg-purple-500 h-2 rounded-full" style="width: {player.energy}%"></div>
                        </div>
                        <span class="font-bold text-on-surface-variant/70">{player.energy}{m.eco_energy_unit()}</span>
                      </div>
                    </td>
                    <td class="py-4 px-4 space-y-1">
                      <!-- Location -->
                      <div class="font-semibold text-on-surface flex items-center gap-1">
                        {#if player.isTraveling}
                          <span>{m.eco_traveling_to()}</span>
                          <span class="text-primary font-bold">{player.travelDestination}</span>
                        {:else}
                          <span>{m.eco_location_at()}</span>
                          <span class="text-success font-bold">{player.travelDestination || m.eco_wild_lands()}</span>
                        {/if}
                      </div>
                      <!-- Guild -->
                      <div class="text-2xs text-on-surface-variant/60 font-medium">
                        {#if player.rpgGuild}
                          <span>{m.eco_alliance()} <strong><EmojiText value={player.rpgGuild.emoji} /> {player.rpgGuild.name}</strong></span>
                        {:else}
                          <span class="italic text-on-surface-variant/30">{m.eco_no_guild()}</span>
                        {/if}
                      </div>
                    </td>
                    {#if canManageSettings}
                      <td class="py-4 px-4 text-right">
                        <div class="flex flex-col items-end gap-1.5">
                          <button 
                             type="button" 
                             onclick={() => openEditPlayer(player)}
                             class="px-3 py-1.5 bg-outline-variant/10 hover:bg-outline-variant/25 text-xs font-bold rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 w-fit"
                          >
                            <Papicon icon="edit" size={12} /> {m.eco_btn_edit()}
                          </button>
                          <button
                             type="button"
                             onclick={() => openInventory(player)}
                             class="px-3 py-1.5 bg-outline-variant/10 hover:bg-outline-variant/25 text-xs font-bold rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 w-fit"
                          >
                            <Papicon icon="package" size={12} /> {m.eco_inventory_btn()}
                          </button>
                        </div>
                      </td>
                    {/if}
                  </tr>
                {:else}
                  <tr>
                    <td colspan="7" class="text-center py-8 text-on-surface-variant/50 italic">{m.eco_no_players()}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</ModulePage>

<!-- ITEM MODAL EDITOR -->
{#if editingItem}
  <!-- Tant que l'admin n'a pas tranché, un objet qui vend une récompense de module reste
       hors du marché noir : c'est la valeur que le serveur appliquera aussi. -->
  {@const blackMarketChecked = editingItem.blackMarketEligible
    ?? !((editingItem.levelXpReward ?? 0) > 0 || (editingItem.clanPointsReward ?? 0) > 0 || (editingItem.raidAssaultBonus ?? 0) > 0)}
  {#snippet hpBonusField()}
    <div class="space-y-1">
      <label for="itemHpBonus" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_hp_bonus()}</label>
      <input id="itemHpBonus" type="number" min="0" bind:value={editingItem.hpBonus} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
    </div>
  {/snippet}
  <div class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
    <div class="bg-surface-container rounded-xl border border-outline-variant/30 p-8 w-full max-w-lg space-y-6 max-h-[90vh] overflow-y-auto animate-in zoom-in-95 duration-200">
      <h3 class="text-xl font-semibold">{editingItem.id ? m.eco_modal_edit_item() : m.eco_modal_create_item()}</h3>
      
      <div class="space-y-4">
        <div class="grid grid-cols-3 gap-3">
          <div class="col-span-2 space-y-1">
            <label for="itemName" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_item_name()}</label>
            <input id="itemName" type="text" bind:value={editingItem.name} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
          </div>
          <div class="space-y-1">
            <label for="itemEmoji" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_item_emoji()}</label>
            <div class="flex gap-2">
              <input id="itemEmoji" type="text" bind:value={editingItem.emoji} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
              <EmojiPicker bind:value={editingItem.emoji} />
            </div>
          </div>
        </div>

        <div class="space-y-1">
          <label for="itemDesc" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_item_desc()}</label>
          <textarea id="itemDesc" bind:value={editingItem.description} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none h-16 resize-none"></textarea>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1">
            <label for="itemType" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_item_type()}</label>
            <select id="itemType" bind:value={editingItem.type} class="w-full bg-surface-container-high/45 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none text-on-surface">
              <option value="WEAPON">🗡️ WEAPON (Arme)</option>
              <option value="ARMOR">🦺 ARMOR (Armure)</option>
              <option value="ACCESSORY">💍 ACCESSORY (Accessoire)</option>
              <option value="POTION">🧪 POTION (Consommable)</option>
              <option value="MATERIAL">⚒️ MATERIAL (Matériau d'artisanat)</option>
              <option value="SCROLL">🔮 SCROLL (Parchemin d'enchantement)</option>
              <option value="QUEST">🔑 QUEST (Quête)</option>
            </select>
          </div>
          <div class="space-y-1">
            <label for="itemPrice" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_item_price({ currency: config.currencyName })}</label>
            <input id="itemPrice" type="number" min="0" bind:value={editingItem.price} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
          </div>
        </div>

        <!-- La rareté fixe le nombre d'enchantements qu'un équipement peut porter, et le
             niveau requis bloque l'équipement : les deux étaient réglables par l'API mais
             absents d'ici, si bien que tout objet créé depuis le dashboard sortait commun
             et sans exigence de niveau. -->
        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1">
            <label for="itemRarity" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_item_rarity()}</label>
            <select id="itemRarity" bind:value={editingItem.rarity} class="w-full bg-surface-container-high/45 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none text-on-surface">
              {#each RPG_ITEM_RARITIES as rarity (rarity)}
                <option value={rarity}>{rarityLabels[rarity]}</option>
              {/each}
            </select>
          </div>
          <div class="space-y-1">
            <label for="itemLevel" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_item_level_required()}</label>
            <input id="itemLevel" type="number" min="0" bind:value={editingItem.levelRequired} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
          </div>
        </div>

        <div class="flex items-center justify-between gap-4 bg-surface-container-high/30 border border-outline-variant/10 rounded-lg px-4 py-3">
          <div>
            <p class="text-xs font-bold">{m.eco_item_purchasable()}</p>
            <p class="text-2xs text-on-surface-variant/60 mt-0.5 leading-relaxed">{m.eco_item_purchasable_hint()}</p>
          </div>
          <ToggleSwitch
            checked={editingItem.purchasable ?? true}
            onToggle={(v: boolean) => editingItem.purchasable = v}
          />
        </div>

        <!-- Dynamic inputs depending on item type -->
        <fieldset class="border border-outline-variant/10 p-4 rounded-lg space-y-3">
          <legend class="text-xs font-semibold text-on-surface-variant/50 px-2">{m.eco_stats_effects()}</legend>
          {#if editingItem.type === 'WEAPON'}
            <div class="space-y-1">
              <label for="itemAtk" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_atk_bonus()}</label>
              <input id="itemAtk" type="number" min="0" bind:value={editingItem.atkBonus} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
            </div>
            {@render hpBonusField()}
          {:else if editingItem.type === 'ARMOR'}
            <div class="space-y-1">
              <label for="itemDef" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_def_bonus()}</label>
              <input id="itemDef" type="number" min="0" bind:value={editingItem.defBonus} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
            </div>
            {@render hpBonusField()}
          {:else if editingItem.type === 'ACCESSORY'}
            <!-- Un accessoire porte les trois bonus a la fois : c'est ce qui le
                 distingue de l'arme et de l'armure, qui n'en portent qu'un. -->
            <div class="grid grid-cols-3 gap-3">
              <div class="space-y-1">
                <label for="itemAccAtk" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_atk_bonus()}</label>
                <input id="itemAccAtk" type="number" bind:value={editingItem.atkBonus} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
              </div>
              <div class="space-y-1">
                <label for="itemAccDef" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_def_bonus()}</label>
                <input id="itemAccDef" type="number" bind:value={editingItem.defBonus} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
              </div>
              <div class="space-y-1">
                <label for="itemAccSpd" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_spd_bonus()}</label>
                <input id="itemAccSpd" type="number" bind:value={editingItem.spdBonus} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
              </div>
            </div>
            {@render hpBonusField()}
          {:else if editingItem.type === 'SCROLL'}
            <!-- Un parchemin ne vaut que par l'enchantement qu'il pose : sans lui
                 l'objet s'achete, se consomme, et ne fait rien. -->
            {@const enchantment = RPG_ENCHANTMENTS.find((entry) => entry.id === editingItem.enchantId) ?? null}
            <div class="grid grid-cols-2 gap-3">
              <div class="space-y-1">
                <label for="itemEnchant" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_item_enchant()}</label>
                <select id="itemEnchant" bind:value={editingItem.enchantId} class="w-full bg-surface-container-high/45 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none text-on-surface">
                  <option value={null}>{m.eco_item_enchant_none()}</option>
                  {#each RPG_ENCHANTMENTS as entry (entry.id)}
                    <option value={entry.id}>{entry.emoji} {entry.name}</option>
                  {/each}
                </select>
              </div>
              <div class="space-y-1">
                <label for="itemEnchantTier" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_item_enchant_tier()}</label>
                <input
                  id="itemEnchantTier"
                  type="number"
                  min="1"
                  max={enchantment?.maxTier ?? 1}
                  disabled={!enchantment}
                  bind:value={editingItem.enchantTier}
                  class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none disabled:opacity-40"
                />
                {#if enchantment}
                  <p class="text-2xs text-on-surface-variant/50 leading-relaxed mt-1">{m.eco_item_enchant_tier_hint({ max: enchantment.maxTier })}</p>
                {/if}
              </div>
            </div>
            {#if enchantment}
              <p class="text-2xs text-on-surface-variant/60 leading-relaxed">{enchantment.description}</p>
              <p class="text-2xs text-on-surface-variant/50">{m.eco_item_enchant_slots({ slots: enchantment.slots.join(', ') })}</p>
            {/if}
          {:else if editingItem.type === 'POTION'}
            <div class="grid grid-cols-2 gap-3">
              <div class="space-y-1">
                <label for="itemHp" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_hp_heal()}</label>
                <input id="itemHp" type="number" bind:value={editingItem.hpRestore} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
              </div>
              <div class="space-y-1">
                <label for="itemEnergy" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_energy_heal()}</label>
                <input id="itemEnergy" type="number" bind:value={editingItem.energyRestore} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
              </div>
            </div>

            {#if config.levelingEnabled || config.clansEnabled}
              <div class="border-t border-outline-variant/10 pt-3 space-y-3">
                <p class="text-2xs text-on-surface-variant/60 leading-relaxed">{m.eco_item_module_rewards_desc()}</p>
                <div class="grid grid-cols-2 gap-3">
                  {#if config.levelingEnabled}
                    <div class="space-y-1">
                      <label for="itemLevelXp" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_item_level_xp_reward()}</label>
                      <input id="itemLevelXp" type="number" min="0" bind:value={editingItem.levelXpReward} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
                    </div>
                  {/if}
                  {#if config.clansEnabled}
                    <div class="space-y-1">
                      <label for="itemClanPoints" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_item_clan_points_reward()}</label>
                      <input id="itemClanPoints" type="number" min="0" bind:value={editingItem.clanPointsReward} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
                      {#if !config.clanPointsFromRpg}
                        <p class="text-2xs text-on-surface-variant/50 leading-relaxed mt-1">{m.eco_item_clan_points_bridge_off()}</p>
                      {/if}
                    </div>
                  {/if}
                  <!-- La potion d'assaut ne se boit que pendant un raid : hors module, elle
                       ne rendrait rien et sortirait de la vente. -->
                  {#if config.raidEnabled}
                    <div class="space-y-1">
                      <label for="itemRaidAssaults" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_item_raid_assaults()}</label>
                      <input id="itemRaidAssaults" type="number" min="0" bind:value={editingItem.raidAssaultBonus} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
                      <p class="text-2xs text-on-surface-variant/50 leading-relaxed mt-1">{m.eco_item_raid_assaults_hint({ max: config.raidBoughtAssaultsMax })}</p>
                    </div>
                  {/if}
                </div>
              </div>
            {/if}
          {:else}
            <p class="text-xs text-on-surface-variant/50 italic text-center py-2">{m.eco_no_attrs_needed()}</p>
          {/if}
        </fieldset>

        <div class="flex items-center justify-between gap-4 border border-outline-variant/10 p-4 rounded-lg">
          <div>
            <h4 class="text-sm font-bold">{m.eco_item_black_market_title()}</h4>
            <p class="text-xs text-on-surface-variant/60 mt-0.5 leading-relaxed">{m.eco_item_black_market_desc()}</p>
          </div>
          <ToggleSwitch
            checked={blackMarketChecked}
            onToggle={(v: boolean) => editingItem.blackMarketEligible = v}
          />
        </div>

        <div class="flex items-center justify-between gap-4 border border-outline-variant/10 p-4 rounded-lg">
          <div>
            <h4 class="text-sm font-bold">{m.eco_item_salvageable_title()}</h4>
            <p class="text-xs text-on-surface-variant/60 mt-0.5 leading-relaxed">{m.eco_item_salvageable_desc()}</p>
          </div>
          <ToggleSwitch
            checked={editingItem.salvageable ?? true}
            onToggle={(v: boolean) => editingItem.salvageable = v}
          />
        </div>
      </div>

      <div class="flex justify-end gap-3 pt-4 border-t border-outline-variant/10">
        <button 
          type="button" 
          onclick={() => editingItem = null}
          class="px-5 py-2.5 bg-outline-variant/10 hover:bg-outline-variant/20 rounded-xl text-xs font-bold transition-all"
        >
          {m.eco_btn_cancel()}
        </button>
        <button 
          type="button" 
          onclick={handleSaveItem}
          class="px-4 py-2 bg-primary hover:bg-primary-hover text-on-primary text-body-sm font-medium rounded-lg transition-all"
        >
          {m.eco_btn_save()}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- MONSTER / BOSS MODAL EDITOR -->
{#if editingMonster}
  {@const nameLocked = editingMonster.scope === 'GLOBAL' || editingMonster.overridesGlobal}
  <div class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
    <div class="bg-surface-container rounded-xl border border-outline-variant/30 p-8 w-full max-w-2xl space-y-6 max-h-[90vh] overflow-y-auto animate-in zoom-in-95 duration-200">
      <h3 class="text-xl font-semibold">
        {editingMonster.id ? m.eco_bestiary_modal_edit({ name: editingMonster.name }) : m.eco_bestiary_modal_create()}
      </h3>

      <div class="space-y-4">
        <div class="grid grid-cols-3 gap-3">
          <div class="col-span-2 space-y-1">
            <label for="monsterName" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_bestiary_name()}</label>
            <input id="monsterName" type="text" bind:value={editingMonster.name} disabled={nameLocked} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none disabled:opacity-60" />
            {#if nameLocked}
              <p class="text-2xs text-on-surface-variant/50 leading-relaxed ml-2 mt-1">{m.eco_bestiary_name_locked()}</p>
            {/if}
          </div>
          <div class="space-y-1">
            <label for="monsterEmoji" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_bestiary_emoji()}</label>
            <div class="flex gap-2">
              <input id="monsterEmoji" type="text" bind:value={editingMonster.emoji} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
              <EmojiPicker bind:value={editingMonster.emoji} />
            </div>
          </div>
        </div>

        <div class="space-y-1">
          <label for="monsterDesc" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_bestiary_desc_field()}</label>
          <textarea id="monsterDesc" bind:value={editingMonster.description} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none h-16 resize-none"></textarea>
        </div>

        <fieldset class="border border-outline-variant/10 p-4 rounded-lg">
          <legend class="text-xs font-semibold text-on-surface-variant/50 px-2">{m.eco_stats_effects()}</legend>
          <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div class="space-y-1">
              <label for="monsterLevel" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bestiary_level()}</label>
              <input id="monsterLevel" type="number" min="1" bind:value={editingMonster.level} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
            </div>
            <div class="space-y-1">
              <label for="monsterHp" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bestiary_health()}</label>
              <input id="monsterHp" type="number" min="1" bind:value={editingMonster.health} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
            </div>
            <div class="space-y-1">
              <label for="monsterAtk" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_atk()}</label>
              <input id="monsterAtk" type="number" min="0" bind:value={editingMonster.attack} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
            </div>
            <div class="space-y-1">
              <label for="monsterDef" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_def()}</label>
              <input id="monsterDef" type="number" min="0" bind:value={editingMonster.defense} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
            </div>
            <div class="space-y-1">
              <label for="monsterSpd" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_spd()}</label>
              <input id="monsterSpd" type="number" min="0" bind:value={editingMonster.speed} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
            </div>
            <div class="space-y-1">
              <label for="monsterXp" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bestiary_xp_reward()}</label>
              <input id="monsterXp" type="number" min="0" bind:value={editingMonster.xpReward} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
            </div>
            <div class="space-y-1 col-span-2 md:col-span-3">
              <label for="monsterCoins" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bestiary_coin_reward({ currency: config.currencyName })}</label>
              <input id="monsterCoins" type="number" min="0" bind:value={editingMonster.coinReward} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
            </div>
          </div>
        </fieldset>

        <div class="space-y-3 border border-outline-variant/10 p-4 rounded-lg">
          <div class="flex items-center justify-between">
            <div>
              <h4 class="text-sm font-bold">{m.eco_bestiary_is_boss_title()}</h4>
              <p class="text-xs text-on-surface-variant/60 mt-0.5">{m.eco_bestiary_is_boss_desc()}</p>
            </div>
            <ToggleSwitch
              checked={editingMonster.isBoss}
              onToggle={(v: boolean) => {
                editingMonster.isBoss = v;
                editingMonster.bossRespawnHours = v ? (editingMonster.bossRespawnHours ?? 2) : null;
              }}
            />
          </div>

          {#if editingMonster.isBoss}
            <div class="space-y-1">
              <label for="monsterRespawn" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bestiary_respawn_hours()}</label>
              <input id="monsterRespawn" type="number" min="1" max="720" bind:value={editingMonster.bossRespawnHours} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
            </div>
          {/if}

          <!-- La prime va au clan du vainqueur, ou a sa guilde du jeu si le serveur joue
               en guildes RPG : le champ suit le module qui l'encaissera. -->
          {#if raidGuildMode ? config.guildsEnabled : config.clansEnabled}
            <div class="space-y-1 pt-2 border-t border-outline-variant/5">
              <label for="monsterClanPoints" class="text-xs font-semibold text-on-surface-variant/60">{raidGuildMode ? m.eco_raid_reward_guild_xp() : m.eco_bestiary_clan_points()}</label>
              <input id="monsterClanPoints" type="number" min="0" bind:value={editingMonster.clanPoints} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
              <p class="text-2xs text-on-surface-variant/50 leading-relaxed mt-1">
                {#if raidGuildMode}
                  {m.eco_bestiary_guild_xp_hint()}
                {:else}
                  {config.clanPointsFromRpg ? m.eco_bestiary_clan_points_hint() : m.eco_bestiary_clan_points_off()}
                {/if}
              </p>
            </div>
          {/if}

          <div class="space-y-1 pt-2 border-t border-outline-variant/5">
            <span class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bestiary_win_title()}</span>
            <SearchableSelect
              value={editingMonster.winTitleId || null}
              options={titleOptions}
              placeholder={titles.length > 0 ? m.eco_bestiary_title_none() : m.eco_bestiary_title_empty()}
              clearable={true}
              className="w-full"
              on:change={(e: any) => editingMonster.winTitleId = e.detail?.value ?? null}
            />
            <p class="text-2xs text-on-surface-variant/50 leading-relaxed mt-1">{m.eco_bestiary_win_title_hint()}</p>
          </div>

          <div class="space-y-3 pt-2 border-t border-outline-variant/5">
            <div class="flex items-center justify-between">
              <div>
                <h4 class="text-sm font-bold">{m.eco_bestiary_first_kill_title()}</h4>
                <p class="text-xs text-on-surface-variant/60 mt-0.5">{m.eco_bestiary_first_kill_desc()}</p>
              </div>
              <ToggleSwitch checked={editingMonster.firstKillOn} onToggle={(v: boolean) => editingMonster.firstKillOn = v} />
            </div>

            {#if editingMonster.firstKill}
              <p class="text-xs bg-warning/10 text-warning rounded-lg px-3 py-2">
                {m.eco_bestiary_first_kill_holder({
                  name: editingMonster.firstKill.displayName ?? editingMonster.firstKill.userId,
                  date: new Date(editingMonster.firstKill.at).toLocaleDateString()
                })}
              </p>
            {/if}

            {#if editingMonster.firstKillOn}
              <div class="grid grid-cols-2 gap-3">
                <div class="space-y-1">
                  <label for="monsterFirstKillCoins" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bestiary_coin_reward({ currency: config.currencyName })}</label>
                  <input id="monsterFirstKillCoins" type="number" min="0" bind:value={editingMonster.firstKillCoinReward} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
                </div>
                <div class="space-y-1">
                  <label for="monsterFirstKillXp" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bestiary_xp_reward()}</label>
                  <input id="monsterFirstKillXp" type="number" min="0" bind:value={editingMonster.firstKillXpReward} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
                </div>
                {#if raidGuildMode ? config.guildsEnabled : config.clansEnabled}
                  <div class="col-span-2 space-y-1">
                    <label for="monsterFirstKillClan" class="text-xs font-semibold text-on-surface-variant/60">{raidGuildMode ? m.eco_raid_reward_guild_xp() : m.eco_bestiary_clan_points()}</label>
                    <input id="monsterFirstKillClan" type="number" min="0" bind:value={editingMonster.firstKillClanPoints} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
                  </div>
                {/if}
                <div class="col-span-2 space-y-1">
                  <span class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bestiary_first_kill_item()}</span>
                  <SearchableSelect
                    value={editingMonster.firstKillItemName || null}
                    options={dropItemOptions}
                    placeholder={m.eco_bestiary_first_kill_item_none()}
                    clearable={true}
                    className="w-full"
                    on:change={(e: any) => editingMonster.firstKillItemName = e.detail?.value ?? null}
                  />
                </div>
                <div class="col-span-2 space-y-1">
                  <span class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bestiary_first_kill_role()}</span>
                  <SearchableSelect
                    value={editingMonster.firstKillRoleId || null}
                    options={availableRoles.map((r: any) => ({ id: r.id, name: `@${r.name}` }))}
                    placeholder={m.eco_bestiary_first_kill_role_none()}
                    clearable={true}
                    className="w-full"
                    on:change={(e: any) => editingMonster.firstKillRoleId = e.detail?.value ?? null}
                  />
                  <p class="text-2xs text-on-surface-variant/50 leading-relaxed mt-1">{m.eco_bestiary_first_kill_role_hint()}</p>
                </div>
                <div class="col-span-2 space-y-1">
                  <span class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bestiary_first_kill_title_reward()}</span>
                  <SearchableSelect
                    value={editingMonster.firstKillTitleId || null}
                    options={titleOptions}
                    placeholder={titles.length > 0 ? m.eco_bestiary_title_none() : m.eco_bestiary_title_empty()}
                    clearable={true}
                    className="w-full"
                    on:change={(e: any) => editingMonster.firstKillTitleId = e.detail?.value ?? null}
                  />
                </div>
              </div>
            {/if}
          </div>

          <div class="flex items-center justify-between pt-2 border-t border-outline-variant/5">
            <div>
              <h4 class="text-sm font-bold">{m.eco_bestiary_enabled_title()}</h4>
              <p class="text-xs text-on-surface-variant/60 mt-0.5">{m.eco_bestiary_enabled_desc()}</p>
            </div>
            <ToggleSwitch checked={editingMonster.enabled} onToggle={(v: boolean) => editingMonster.enabled = v} />
          </div>
        </div>

        <fieldset class="border border-outline-variant/10 p-4 rounded-lg space-y-3">
          <legend class="text-xs font-semibold text-on-surface-variant/50 px-2">{m.eco_bestiary_drops_title()}</legend>
          <p class="text-2xs text-on-surface-variant/60 leading-relaxed">{m.eco_bestiary_drops_desc()}</p>

          {#each editingMonster.drops as drop, index}
            <div class="grid grid-cols-12 gap-2 items-end">
              <div class="col-span-6 space-y-1">
                <span class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bestiary_drop_item()}</span>
                <SearchableSelect
                  value={drop.itemName || null}
                  options={dropItemOptions}
                  placeholder={m.eco_bestiary_drop_select()}
                  clearable={false}
                  className="w-full"
                  on:change={(e: any) => onDropItemChange(index, e.detail?.value ?? null)}
                />
              </div>
              <div class="col-span-3 space-y-1">
                <label for="drop-chance-{index}" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bestiary_drop_chance()}</label>
                <input id="drop-chance-{index}" type="number" min="1" max="100" bind:value={drop.chancePercent} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
              </div>
              <div class="col-span-2 space-y-1">
                <label for="drop-bonus-{index}" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bestiary_drop_bonus()}</label>
                <input id="drop-bonus-{index}" type="number" min="0" bind:value={drop.coinBonus} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
              </div>
              <button
                type="button"
                onclick={() => removeDrop(index)}
                class="col-span-1 p-2 bg-error/10 hover:bg-error/25 rounded-lg flex items-center justify-center"
                title={m.fb_delete()}
              >
                <Papicon icon="trash" size={14} />
              </button>
            </div>
          {:else}
            <p class="text-2xs text-on-surface-variant/40 italic">{m.eco_bestiary_drops_empty()}</p>
          {/each}

          <button
            type="button"
            onclick={addDrop}
            disabled={editingMonster.drops.length >= DROPS_MAX}
            class="px-3 py-2 bg-outline-variant/10 hover:bg-outline-variant/20 rounded-lg text-2xs font-bold disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            <Papicon icon="plus" size={13} />
            {m.eco_bestiary_drop_add()}
          </button>
        </fieldset>
      </div>

      <div class="flex justify-end gap-3 pt-4 border-t border-outline-variant/10">
        <button
          type="button"
          onclick={() => editingMonster = null}
          class="px-5 py-2.5 bg-outline-variant/10 hover:bg-outline-variant/20 rounded-xl text-xs font-bold transition-all"
        >
          {m.eco_btn_cancel()}
        </button>
        <button
          type="button"
          onclick={handleSaveMonster}
          class="px-4 py-2 bg-primary hover:bg-primary-hover text-on-primary text-body-sm font-medium rounded-lg transition-all"
        >
          {m.eco_btn_save()}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- FICHE D'UN TITRE -->
{#if editingTitle}
  <div class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
    <div class="bg-surface-container rounded-xl border border-outline-variant/30 p-8 w-full max-w-lg space-y-6 max-h-[90vh] overflow-y-auto animate-in zoom-in-95 duration-200">
      <h3 class="text-xl font-semibold">{editingTitle.id ? m.eco_title_modal_edit() : m.eco_title_modal_create()}</h3>

      <div class="space-y-4">
        <div class="grid grid-cols-4 gap-3">
          <div class="col-span-3 space-y-1">
            <label for="titleName" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_title_name()}</label>
            <input id="titleName" type="text" maxlength="24" bind:value={editingTitle.name} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
            <p class="text-2xs text-on-surface-variant/50 ml-2">{m.eco_title_name_hint({ count: editingTitle.name?.length ?? 0 })}</p>
          </div>
          <div class="space-y-1">
            <label for="titleColor" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_title_color()}</label>
            <input id="titleColor" type="color" bind:value={editingTitle.color} class="w-full h-[38px] bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-1 cursor-pointer" />
          </div>
        </div>

        <div class="space-y-1">
          <label for="titleDesc" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_bestiary_desc_field()}</label>
          <textarea id="titleDesc" maxlength="200" bind:value={editingTitle.description} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none h-16 resize-none"></textarea>
        </div>

        <p class="text-center text-sm font-bold bg-[#161221] rounded-lg py-3" style="color: {editingTitle.color}">{editingTitle.name || m.eco_title_name()}</p>

        <fieldset class="border border-outline-variant/10 p-4 rounded-lg">
          <legend class="text-xs font-semibold text-on-surface-variant/50 px-2">{m.eco_title_bonuses()}</legend>
          <p class="text-2xs text-on-surface-variant/60 leading-relaxed mb-3">{m.eco_title_bonuses_hint()}</p>
          <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div class="space-y-1">
              <label for="titleAtk" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_atk()}</label>
              <input id="titleAtk" type="number" min="0" max="1000" bind:value={editingTitle.attackBonus} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
            </div>
            <div class="space-y-1">
              <label for="titleDef" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_def()}</label>
              <input id="titleDef" type="number" min="0" max="1000" bind:value={editingTitle.defenseBonus} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
            </div>
            <div class="space-y-1">
              <label for="titleSpd" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_spd()}</label>
              <input id="titleSpd" type="number" min="0" max="1000" bind:value={editingTitle.speedBonus} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
            </div>
            <div class="space-y-1">
              <label for="titleHp" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_bestiary_health()}</label>
              <input id="titleHp" type="number" min="0" max="10000" bind:value={editingTitle.healthBonus} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
            </div>
            <div class="space-y-1">
              <label for="titleCrit" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_title_crit()} (%)</label>
              <input id="titleCrit" type="number" min="0" max="25" bind:value={editingTitle.critBonus} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none" />
            </div>
          </div>
        </fieldset>
      </div>

      <div class="flex justify-end gap-3 pt-4 border-t border-outline-variant/10">
        <button type="button" onclick={() => editingTitle = null} class="px-5 py-2.5 bg-outline-variant/10 hover:bg-outline-variant/20 rounded-xl text-xs font-bold transition-all">
          {m.eco_btn_cancel()}
        </button>
        <button type="button" onclick={handleSaveTitle} class="px-4 py-2 bg-primary hover:bg-primary-hover text-on-primary text-body-sm font-medium rounded-lg transition-all">
          {m.eco_btn_save()}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- QUEST MODAL EDITOR -->
<!-- FICHE D'UNE RECETTE -->
{#if editingRecipe}
  <div class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
    <div class="bg-surface-container rounded-xl border border-outline-variant/30 p-8 w-full max-w-lg space-y-5 max-h-[90vh] overflow-y-auto animate-in zoom-in-95 duration-200">
      <h3 class="text-xl font-semibold">{editingRecipe.id ? m.eco_btn_edit() : m.eco_recipe_new()}</h3>

      <div class="space-y-1">
        <label for="recipeResult" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_recipe_result()}</label>
        <select id="recipeResult" bind:value={editingRecipe.resultItemId} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none">
          {#each guildItems as item (item.id)}
            <option value={item.id}>{item.emoji} {item.name}</option>
          {/each}
        </select>
      </div>

      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_recipe_materials()}</span>
          <button
            type="button"
            onclick={addRecipeIngredient}
            disabled={editingRecipe.ingredients.length >= RECIPE_INGREDIENTS_MAX}
            class="text-2xs font-medium px-3 py-1.5 rounded-lg border border-outline-variant/20 hover:border-outline-variant/40 disabled:opacity-40"
          >
            {m.eco_recipe_add_material()}
          </button>
        </div>

        {#each editingRecipe.ingredients as ingredient, index}
          <div class="flex items-center gap-2">
            <SearchableSelect
              value={ingredient.itemName || null}
              options={recipeMaterialOptions}
              placeholder={m.eco_recipe_material_select()}
              clearable={false}
              showId={false}
              className="flex-1 min-w-0"
              on:change={(e: any) => ingredient.itemName = e.detail?.value ?? ''}
            />
            <input type="number" min="1" bind:value={ingredient.quantity} class="w-20 bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs text-right focus:outline-none" />
            <button
              type="button"
              onclick={() => removeRecipeIngredient(index)}
              disabled={editingRecipe.ingredients.length <= 1}
              class="px-2.5 py-2 rounded-lg border border-outline-variant/20 text-on-surface-variant/60 hover:text-error disabled:opacity-30"
            >
              <Papicon icon="Trash" size={12} />
            </button>
          </div>
        {/each}
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div class="space-y-1">
          <label for="recipeCost" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_recipe_coin_cost()}</label>
          <input id="recipeCost" type="number" min="0" bind:value={editingRecipe.coinCost} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
        </div>
        <div class="space-y-1">
          <label for="recipeLevel" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_recipe_level()}</label>
          <input id="recipeLevel" type="number" min="1" max="100" bind:value={editingRecipe.levelRequired} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
        </div>
      </div>

      <div class="flex gap-3 pt-2">
        <button type="button" onclick={() => editingRecipe = null} class="flex-1 px-4 py-3 bg-outline-variant/10 hover:bg-outline-variant/20 rounded-lg text-body-sm font-medium transition-all">
          {m.eco_btn_cancel()}
        </button>
        <button type="button" onclick={handleSaveRecipe} class="flex-1 px-4 py-3 bg-primary text-on-primary rounded-lg text-body-sm font-semibold">
          {m.eco_btn_save()}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if editingQuest}
  <div class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
    <div class="bg-surface-container rounded-xl border border-outline-variant/30 p-8 w-full max-w-2xl space-y-6 max-h-[90vh] overflow-y-auto animate-in zoom-in-95 duration-200">
      <h3 class="text-xl font-semibold">
        {editingQuest.id ? m.eco_quest_modal_edit({ name: editingQuest.name }) : m.eco_quest_modal_create()}
      </h3>

      <div class="space-y-4">
        <div class="grid grid-cols-3 gap-3">
          <div class="col-span-2 space-y-1">
            <label for="questName" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_bestiary_name()}</label>
            <input id="questName" type="text" bind:value={editingQuest.name} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
          </div>
          <div class="space-y-1">
            <label for="questEmoji" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_bestiary_emoji()}</label>
            <div class="flex gap-2">
              <input id="questEmoji" type="text" bind:value={editingQuest.emoji} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
              <EmojiPicker bind:value={editingQuest.emoji} />
            </div>
          </div>
        </div>

        <div class="space-y-1">
          <label for="questDesc" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_bestiary_desc_field()}</label>
          <textarea id="questDesc" rows="2" bind:value={editingQuest.description} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none resize-none"></textarea>
        </div>

        <!-- Une quete personnelle se compte par membre et se reclame ; une quete d'equipe
             additionne tout un clan sur la meme fenetre et se paie d'elle-meme. -->
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {#each [{ id: 'MEMBER', name: m.eco_quest_scope_member(), desc: m.eco_quest_scope_member_desc() }, { id: 'TEAM', name: m.eco_quest_scope_team(), desc: m.eco_quest_scope_team_desc() }] as scope (scope.id)}
            {@const selected = editingQuest.scope === scope.id}
            <button
              type="button"
              onclick={() => editingQuest.scope = scope.id}
              aria-pressed={selected}
              class="text-left p-4 rounded-lg border transition-all {selected ? 'bg-primary/8 border-primary/50' : 'bg-surface-container-high/30 border-outline-variant/10 hover:border-outline-variant/30'}"
            >
              <span class="text-body-sm font-semibold">{scope.name}</span>
              <p class="text-2xs text-on-surface-variant/60 mt-1 leading-relaxed">{scope.desc}</p>
            </button>
          {/each}
        </div>

        {#if editingQuest.scope === 'TEAM'}
          <div class="space-y-1">
            <label for="questTeamMode" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_raid_team_mode_title()}</label>
            <select id="questTeamMode" bind:value={editingQuest.teamMode} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none">
              <option value="CLAN" disabled={!config.clansEnabled}>{m.eco_raid_mode_clan()}</option>
              <option value="RPG_GUILD" disabled={!config.guildsEnabled}>{m.eco_raid_mode_guild()}</option>
            </select>
          </div>
        {/if}

        <div class="grid grid-cols-3 gap-3">
          <div class="space-y-1">
            <label for="questObjective" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_quest_objective()}</label>
            <select id="questObjective" bind:value={editingQuest.objective} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none">
              {#each questObjectives as objective (objective)}
                <option value={objective}>{questObjectiveLabel(objective)}</option>
              {/each}
            </select>
          </div>
          <div class="space-y-1">
            <label for="questTarget" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_quest_target()}</label>
            <input id="questTarget" type="number" min="1" bind:value={editingQuest.target} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
          </div>
          <div class="space-y-1">
            <label for="questWindow" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_quest_window()}</label>
            <input id="questWindow" type="number" min="1" max="720" bind:value={editingQuest.windowHours} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
          </div>
        </div>
        <p class="text-2xs text-on-surface-variant/50 leading-relaxed ml-2">{m.eco_quest_window_hint()}</p>

        <div class="grid grid-cols-3 gap-3">
          <div class="space-y-1">
            <label for="questXp" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_xp()}</label>
            <input id="questXp" type="number" min="0" bind:value={editingQuest.rewardXp} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
          </div>
          <div class="space-y-1">
            <label for="questCoins" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_bestiary_coin_reward({ currency: config.currencyName })}</label>
            <input id="questCoins" type="number" min="0" bind:value={editingQuest.rewardCoins} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
          </div>
          <!-- Une quete personnelle credite le clan de celui qui la termine, comme le fait
               deja un monstre vaincu ; une quete d'equipe credite l'equipe, clan ou guilde
               du jeu selon le mode choisi juste au-dessus. -->
          <div class="space-y-1">
            <label for="questPoints" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{questGuildMode ? m.eco_raid_reward_guild_xp() : m.eco_raid_reward_points()}</label>
            <input id="questPoints" type="number" min="0" bind:value={editingQuest.rewardClanPoints} disabled={!(questGuildMode ? config.guildsEnabled : config.clansEnabled)} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none disabled:opacity-50" />
          </div>
        </div>
        <p class="text-2xs text-on-surface-variant/50 leading-relaxed ml-2">
          {editingQuest.scope === 'TEAM' ? m.eco_quest_rewards_team_hint() : m.eco_quest_rewards_member_hint()}
          {#if editingQuest.rewardClanPoints > 0 && !(editingQuest.scope === 'TEAM' && editingQuest.teamMode === 'RPG_GUILD')}
            {' '}{m.eco_quest_rewards_bridge_hint()}
          {/if}
        </p>

        <!-- La repetition ne concerne que la portee personnelle : une quete d'equipe se paie
             deja d'elle-meme a chaque completion, sans verrou de journee. -->
        {#if editingQuest.scope === 'MEMBER'}
          <div class="flex items-center justify-between gap-4 bg-surface-container-high/30 border border-outline-variant/10 rounded-xl px-5 py-4">
            <div>
              <h4 class="text-sm font-bold">{m.eco_quest_repeatable_title()}</h4>
              <p class="text-xs text-on-surface-variant/60 mt-0.5">{editingQuest.repeatable ? m.eco_quest_repeatable_on_desc() : m.eco_quest_repeatable_off_desc()}</p>
            </div>
            <ToggleSwitch checked={editingQuest.repeatable} onToggle={(v: boolean) => editingQuest.repeatable = v} />
          </div>
        {/if}

        <div class="flex items-center justify-between gap-4 bg-surface-container-high/30 border border-outline-variant/10 rounded-xl px-5 py-4">
          <div>
            <h4 class="text-sm font-bold">{m.eco_bestiary_enabled_title()}</h4>
            <p class="text-xs text-on-surface-variant/60 mt-0.5">{m.eco_quest_enabled_desc()}</p>
          </div>
          <ToggleSwitch checked={editingQuest.enabled} onToggle={(v: boolean) => editingQuest.enabled = v} />
        </div>
      </div>

      <div class="flex gap-3 pt-2">
        <button type="button" onclick={() => editingQuest = null} class="flex-1 px-4 py-3 bg-outline-variant/10 hover:bg-outline-variant/20 rounded-lg text-body-sm font-medium transition-all">
          {m.eco_btn_cancel()}
        </button>
        <button type="button" onclick={handleSaveQuest} class="flex-1 px-4 py-3 bg-primary hover:bg-primary-hover text-on-primary rounded-lg text-body-sm font-medium transition-all">
          {m.eco_btn_save()}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- RAID BOSS MODAL EDITOR -->
{#if editingRaidBoss}
  <div class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
    <div class="bg-surface-container rounded-xl border border-outline-variant/30 p-8 w-full max-w-2xl space-y-6 max-h-[90vh] overflow-y-auto animate-in zoom-in-95 duration-200">
      <h3 class="text-xl font-semibold">
        {editingRaidBoss.id ? m.eco_raid_modal_edit({ name: editingRaidBoss.name }) : m.eco_raid_modal_create()}
      </h3>

      <div class="space-y-4">
        <div class="grid grid-cols-3 gap-3">
          <div class="col-span-2 space-y-1">
            <label for="raidBossName" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_bestiary_name()}</label>
            <input id="raidBossName" type="text" bind:value={editingRaidBoss.name} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
          </div>
          <div class="space-y-1">
            <label for="raidBossEmoji" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_bestiary_emoji()}</label>
            <div class="flex gap-2">
              <input id="raidBossEmoji" type="text" bind:value={editingRaidBoss.emoji} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
              <EmojiPicker bind:value={editingRaidBoss.emoji} />
            </div>
          </div>
        </div>

        <div class="space-y-1">
          <label for="raidBossDesc" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_bestiary_desc_field()}</label>
          <textarea id="raidBossDesc" rows="2" bind:value={editingRaidBoss.description} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none resize-none"></textarea>
        </div>

        <div class="grid grid-cols-4 gap-3">
          <div class="space-y-1">
            <label for="raidBossLevel" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_bestiary_level()}</label>
            <input id="raidBossLevel" type="number" min="1" bind:value={editingRaidBoss.level} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
          </div>
          <div class="space-y-1">
            <label for="raidBossAtk" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_atk()}</label>
            <input id="raidBossAtk" type="number" min="1" bind:value={editingRaidBoss.attack} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
          </div>
          <div class="space-y-1">
            <label for="raidBossDef" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_def()}</label>
            <input id="raidBossDef" type="number" min="1" bind:value={editingRaidBoss.defense} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
          </div>
          <div class="space-y-1">
            <label for="raidBossSpd" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_spd()}</label>
            <input id="raidBossSpd" type="number" min="1" bind:value={editingRaidBoss.speed} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
          </div>
        </div>

        <!-- Les sorts se choisissent dans le catalogue : un effet compose champ par champ
             laisserait ecrire un sort a cent fois les degats, qui ne serait plus un reglage
             mais une panne. L'ordre de la liste decide des priorites a egalite. -->
        <div class="space-y-2">
          <div>
            <h4 class="text-sm font-bold">{m.eco_raid_spells_title()}</h4>
            <p class="text-2xs text-on-surface-variant/60 mt-0.5 leading-relaxed">{m.eco_raid_spells_desc()}</p>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {#each raidSpells as spell (spell.id)}
              {@const chosen = (editingRaidBoss.spellIds ?? []).includes(spell.id)}
              <button
                type="button"
                onclick={() => toggleRaidSpell(spell.id)}
                aria-pressed={chosen}
                class="text-left p-3 rounded-lg border transition-all {chosen ? 'bg-primary/8 border-primary/50' : 'bg-surface-container-high/30 border-outline-variant/10 hover:border-outline-variant/30'}"
              >
                <div class="flex items-center gap-2">
                  <Papicon icon={spell.icon} size={14} class={chosen ? 'text-primary' : 'text-on-surface-variant/70'} />
                  <span class="text-xs font-semibold">{spell.name}</span>
                  {#if spell.triggerBelowHealth !== undefined && spell.triggerBelowHealth !== null}
                    <span class="ml-auto text-xs font-semibold text-warning bg-warning/10 px-1.5 py-0.5 rounded">
                      {m.eco_raid_spell_phase({ percent: Math.round(spell.triggerBelowHealth * 100) })}
                    </span>
                  {/if}
                </div>
                <p class="text-2xs text-on-surface-variant/60 mt-1 leading-relaxed">{spell.description}</p>
                <p class="text-2xs text-on-surface-variant/40 mt-1">{m.eco_raid_spell_cooldown({ turns: spell.cooldownTurns })}</p>
              </button>
            {/each}
          </div>
        </div>

        <div class="flex items-center justify-between gap-4 bg-surface-container-high/30 border border-outline-variant/10 rounded-xl px-5 py-4">
          <div>
            <h4 class="text-sm font-bold">{m.eco_bestiary_enabled_title()}</h4>
            <p class="text-xs text-on-surface-variant/60 mt-0.5">{m.eco_raid_enabled_desc()}</p>
          </div>
          <ToggleSwitch checked={editingRaidBoss.enabled} onToggle={(v: boolean) => editingRaidBoss.enabled = v} />
        </div>
      </div>

      <div class="flex gap-3 pt-2">
        <button type="button" onclick={() => editingRaidBoss = null} class="flex-1 px-4 py-3 bg-outline-variant/10 hover:bg-outline-variant/20 rounded-lg text-body-sm font-medium transition-all">
          {m.eco_btn_cancel()}
        </button>
        <button type="button" onclick={handleSaveRaidBoss} class="flex-1 px-4 py-3 bg-primary hover:bg-primary-hover text-on-primary rounded-lg text-body-sm font-medium transition-all">
          {m.eco_btn_save()}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- PLAYER MODAL EDITOR -->
{#if editingPlayer}
  <div class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
    <div class="bg-surface-container rounded-xl border border-outline-variant/30 p-8 w-full max-w-lg space-y-6 max-h-[90vh] overflow-y-auto animate-in zoom-in-95 duration-200">
      <h3 class="text-xl font-semibold">{m.eco_modal_edit_player({ name: editingPlayer.displayName || editingPlayer.username })}</h3>
      
      <div class="grid grid-cols-2 gap-4">
        <div class="space-y-1">
          <label for="pBalance" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_balance_currency({ currency: config.currencyName })}</label>
          <input id="pBalance" type="number" bind:value={editingPlayer.balance} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
        </div>

        <div class="space-y-1">
          <label for="pLevel" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_rpg_level()}</label>
          <input id="pLevel" type="number" bind:value={editingPlayer.level} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
        </div>

        <div class="space-y-1">
          <label for="pXp" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_xp()}</label>
          <input id="pXp" type="number" bind:value={editingPlayer.xp} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
        </div>

        <div class="space-y-1">
          <label for="pHp" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_hp()}</label>
          <input id="pHp" type="number" bind:value={editingPlayer.health} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
        </div>

        <div class="space-y-1">
          <label for="pEnergy" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_energy_pct()}</label>
          <input id="pEnergy" type="number" bind:value={editingPlayer.energy} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
        </div>

        <div class="space-y-1">
          <label for="pAtk" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_atk()}</label>
          <input id="pAtk" type="number" bind:value={editingPlayer.attack} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
        </div>

        <div class="space-y-1">
          <label for="pDef" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_def()}</label>
          <input id="pDef" type="number" bind:value={editingPlayer.defense} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
        </div>

        <div class="space-y-1">
          <label for="pSpd" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_spd()}</label>
          <input id="pSpd" type="number" bind:value={editingPlayer.speed} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
        </div>

        <div class="space-y-1">
          <label for="pMaxHp" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_max_hp()}</label>
          <input id="pMaxHp" type="number" min="1" bind:value={editingPlayer.maxHealth} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
        </div>

        <div class="space-y-1">
          <label for="pStatPoints" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_stat_points()}</label>
          <input id="pStatPoints" type="number" min="0" bind:value={editingPlayer.statPoints} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
        </div>

        <div class="space-y-1">
          <label for="pSkillPoints" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_skill_points()}</label>
          <input id="pSkillPoints" type="number" min="0" bind:value={editingPlayer.skillPoints} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
        </div>
      </div>
      <p class="text-2xs text-on-surface-variant/50 leading-relaxed">{m.eco_player_base_stats_hint()}</p>

      <div class="flex justify-end gap-3 pt-4 border-t border-outline-variant/10">
        <button 
          type="button" 
          onclick={() => editingPlayer = null}
          class="px-5 py-2.5 bg-outline-variant/10 hover:bg-outline-variant/20 rounded-xl text-xs font-bold transition-all"
        >
          {m.eco_btn_cancel()}
        </button>
        <button 
          type="button" 
          onclick={handleSavePlayer}
          class="px-4 py-2 bg-primary hover:bg-primary-hover text-on-primary text-body-sm font-medium rounded-lg transition-all"
        >
          {m.eco_btn_save()}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if inventoryPlayer}
  <RpgPlayerInventoryModal
    player={inventoryPlayer}
    catalog={items}
    canManage={canManageSettings}
    onClose={() => inventoryPlayer = null}
    onChanged={() => void loadPlayers()}
  />
{/if}

<!-- RESET CONFIRMATION MODAL -->
{#if resetComponent}
  <div class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
    <div class="bg-surface-container rounded-xl border border-outline-variant/30 p-8 w-full max-w-md space-y-6 max-h-[90vh] overflow-y-auto animate-in zoom-in-95 duration-200">
      <div class="text-center space-y-3 flex flex-col items-center">
        <div class="w-16 h-16 bg-error/10 text-error rounded-full flex items-center justify-center mb-2">
          <Papicon icon="alert-triangle" size={32} />
        </div>
        <h3 class="text-xl font-semibold text-error">{m.eco_reset_modal_title()}</h3>
        <p class="text-xs text-on-surface-variant/80 leading-relaxed text-center">
          {m.eco_reset_modal_desc({ component: resetComponentLabels[resetComponent] ?? resetComponent })}
        </p>
      </div>

      <div class="space-y-1.5">
        <label for="resetConfirmWord" class="text-xs font-semibold text-on-surface-variant/60 ml-1">
          {m.eco_reset_confirm_label({ word: m.eco_reset_confirm_word() })}
        </label>
        <input
          id="resetConfirmWord"
          type="text"
          bind:value={resetConfirmInput}
          placeholder={m.eco_reset_confirm_word()}
          autocomplete="off"
          onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter' && resetConfirmed) confirmReset(); }}
          class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm font-semibold text-center focus:outline-none focus:ring-2 focus:ring-error/30 transition-all"
        />
      </div>

      <div class="flex justify-center gap-3 pt-2">
        <button
          type="button"
          onclick={() => resetComponent = null}
          class="px-5 py-2.5 bg-outline-variant/10 hover:bg-outline-variant/20 rounded-xl text-xs font-bold transition-all"
        >
          {m.eco_btn_cancel()}
        </button>
        <button
          type="button"
          onclick={confirmReset}
          disabled={!resetConfirmed}
          class="px-5 py-2.5 bg-error hover:bg-error-hover text-on-error text-body-sm font-medium rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {m.eco_confirm_delete_btn()}
        </button>
      </div>
    </div>
  </div>
{/if}
