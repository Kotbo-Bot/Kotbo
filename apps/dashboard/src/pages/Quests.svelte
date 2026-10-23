<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchQuestsData, createQuest, updateQuest, deleteQuest } from '../lib/api';
  import { toast } from '../lib/stores/toast.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import { m } from '../lib/i18n';

  let loading = $state(true);
  let data: any = $state(null);
  let showCreate = $state(false);
  let showTemplates = $state(false);
  let newQuest = $state({
    name: '', description: '', type: 'SEND_MESSAGES', frequency: 'DAILY',
    target: 10, rewardCoins: 50, rewardXp: 25
  });

  const questTypes = $derived<Record<string, string>>({
    SEND_MESSAGES: m.que_type_send_messages(),
    VOICE_MINUTES: m.que_type_voice_minutes(),
    REACT_MESSAGES: m.que_type_react_messages(),
    WIN_GAME: m.que_type_win_game(),
    EARN_COINS: m.que_type_earn_coins(),
    GIVE_REP: m.que_type_give_rep(),
    CREATE_THREADS: m.que_type_create_threads(),
    REPLY_MESSAGES: m.que_type_reply_messages(),
  });

  const questTemplates = $derived([
    { name: m.que_tpl_chatter_name(), type: 'SEND_MESSAGES', target: 50, rewardCoins: 100, rewardXp: 50, frequency: 'DAILY', description: m.que_tpl_chatter_desc(), icon: 'MessageSquare', color: 'primary' },
    { name: m.que_tpl_vocalist_name(), type: 'VOICE_MINUTES', target: 30, rewardCoins: 75, rewardXp: 40, frequency: 'DAILY', description: m.que_tpl_vocalist_desc(), icon: 'Mic', color: 'emerald-500' },
    { name: m.que_tpl_reactor_name(), type: 'REACT_MESSAGES', target: 20, rewardCoins: 50, rewardXp: 25, frequency: 'DAILY', description: m.que_tpl_reactor_desc(), icon: 'Heart', color: 'pink-500' },
    { name: m.que_tpl_champion_name(), type: 'WIN_GAME', target: 3, rewardCoins: 150, rewardXp: 75, frequency: 'WEEKLY', description: m.que_tpl_champion_desc(), icon: 'Crown', color: 'amber-500' },
    { name: m.que_tpl_philanthropist_name(), type: 'GIVE_REP', target: 5, rewardCoins: 100, rewardXp: 50, frequency: 'WEEKLY', description: m.que_tpl_philanthropist_desc(), icon: 'Star', color: 'emerald-500' },
    { name: m.que_tpl_creator_name(), type: 'CREATE_THREADS', target: 3, rewardCoins: 80, rewardXp: 40, frequency: 'WEEKLY', description: m.que_tpl_creator_desc(), icon: 'PenLine', color: 'primary' },
  ]);

  function openTemplates() {
    showTemplates = true;
    showCreate = false;
  }

  function selectTemplate(tpl: typeof questTemplates[0]) {
    newQuest = {
      name: tpl.name,
      description: tpl.description,
      type: tpl.type,
      frequency: tpl.frequency,
      target: tpl.target,
      rewardCoins: tpl.rewardCoins,
      rewardXp: tpl.rewardXp,
    };
    showTemplates = false;
    showCreate = true;
  }

  function openBlankForm() {
    newQuest = { name: '', description: '', type: 'SEND_MESSAGES', frequency: 'DAILY', target: 10, rewardCoins: 50, rewardXp: 25 };
    showTemplates = false;
    showCreate = true;
  }

  async function load() {
    loading = true;
    try {
      data = await fetchQuestsData();
    } catch {
      toast.error(m.que_load_error());
    } finally {
      loading = false;
    }
  }

  async function handleCreate() {
    if (!newQuest.name) { toast.error(m.que_name_required()); return; }
    if (
      !Number.isFinite(newQuest.target) || newQuest.target < 1 ||
      !Number.isFinite(newQuest.rewardCoins) || newQuest.rewardCoins < 0 ||
      !Number.isFinite(newQuest.rewardXp) || newQuest.rewardXp < 0
    ) {
      toast.error(m.que_numbers_invalid());
      return;
    }
    try {
      await createQuest(newQuest);
      showCreate = false;
      newQuest = { name: '', description: '', type: 'SEND_MESSAGES', frequency: 'DAILY', target: 10, rewardCoins: 50, rewardXp: 25 };
      await load();
    } catch {
      toast.error(m.que_create_error());
    }
  }

  async function handleToggle(quest: any) {
    try {
      await updateQuest(quest.id, { enabled: !quest.enabled });
      await load();
    } catch {
      toast.error(m.que_update_error());
    }
  }

  async function handleDelete(questId: string) {
    try {
      await deleteQuest(questId);
      await load();
    } catch {
      toast.error(m.que_delete_error());
    }
  }

  onMount(load);
</script>

<ModulePage
  title={m.que_page_title()}
  description={m.que_page_desc()}
  icon="compass"
  featureKey="quests"
>
  {#snippet actions()}
    <button
      class="px-4 py-2 bg-primary text-on-primary text-body-sm font-medium rounded-xl shadow-sm active:scale-[0.98] transition-all flex items-center gap-2"
      onclick={openTemplates}
    >
      <Papicon icon="Plus" size={16} /> {m.que_btn_new()}
    </button>
  {/snippet}

<!-- Template Picker -->
{#if showTemplates}
  <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4 mb-4">
    <div>
      <h3 class="text-base font-semibold flex items-center gap-2.5">{m.que_choose_template()}</h3>
      <p class="text-xs text-on-surface-variant mt-1">{m.que_template_subtitle()}</p>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {#each questTemplates as tpl}
        <button
          class="flex flex-col gap-3 bg-surface-container-high/20 border border-outline-variant/10 rounded-xl p-4 text-left transition-all hover:border-{tpl.color}/40 hover:bg-surface-container-high/40 hover:-translate-y-0.5 border-l-3 border-l-{tpl.color} cursor-pointer"
          onclick={() => selectTemplate(tpl)}
        >
          <div class="text-{tpl.color}">
            <Papicon icon={tpl.icon} size={22} />
          </div>
          <div class="flex flex-col gap-0.5">
            <span class="font-semibold text-sm text-on-surface">{tpl.name}</span>
            <span class="text-xs text-on-surface-variant">{tpl.description}</span>
          </div>
          <div class="flex items-center gap-2 flex-wrap">
            {#if tpl.frequency === 'DAILY'}
              <span class="px-2.5 py-0.5 bg-primary/10 text-primary text-xs font-medium rounded-full">{m.que_freq_daily()}</span>
            {:else}
              <span class="px-2.5 py-0.5 bg-pink-500/10 text-pink-500 text-xs font-medium rounded-full">{m.que_freq_weekly()}</span>
            {/if}
            <span class="text-2xs text-on-surface-variant/40">{m.que_rewards_summary({ coins: tpl.rewardCoins, xp: tpl.rewardXp })}</span>
          </div>
        </button>
      {/each}
      <button
        class="flex flex-col gap-3 bg-surface-container-high/20 border border-outline-variant/10 rounded-xl p-4 text-left transition-all hover:border-on-surface-variant/30 hover:bg-surface-container-high/40 hover:-translate-y-0.5 border-l-3 border-l-outline-variant/20 cursor-pointer"
        onclick={openBlankForm}
      >
        <div class="text-on-surface-variant/40">
          <Papicon icon="Plus" size={22} />
        </div>
        <div class="flex flex-col gap-0.5">
          <span class="font-semibold text-sm text-on-surface">{m.que_custom_title()}</span>
          <span class="text-xs text-on-surface-variant">{m.que_custom_desc()}</span>
        </div>
      </button>
    </div>
    <div class="flex justify-end">
      <button
        class="px-4 py-2 bg-surface-container-high/40 text-on-surface-variant rounded-xl text-xs font-bold hover:bg-surface-container-high/60 transition-all flex items-center gap-2"
        onclick={() => showTemplates = false}
      >
        {m.que_btn_cancel()}
      </button>
    </div>
  </div>
{/if}

<!-- Create Form -->
{#if showCreate}
  <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4 mb-4">
    <h3 class="text-base font-semibold flex items-center gap-2.5">{m.que_create_title()}</h3>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      <div class="space-y-1">
        <label for="new-quest-name" class="field-label">{m.que_field_name()}</label>
        <input id="new-quest-name" type="text" bind:value={newQuest.name} placeholder={m.que_placeholder_name()} class="w-full px-3 py-2 bg-surface-container-high/30 border border-outline-variant/10 rounded-lg text-on-surface text-sm focus:border-primary focus:outline-none transition-colors" />
      </div>
      <div class="space-y-1">
        <label for="new-quest-description" class="field-label">{m.que_field_desc()}</label>
        <input id="new-quest-description" type="text" bind:value={newQuest.description} placeholder={m.que_placeholder_desc()} class="w-full px-3 py-2 bg-surface-container-high/30 border border-outline-variant/10 rounded-lg text-on-surface text-sm focus:border-primary focus:outline-none transition-colors" />
      </div>
      <div class="space-y-1">
        <label for="new-quest-type" class="field-label">{m.que_field_type()}</label>
        <select id="new-quest-type" bind:value={newQuest.type} class="w-full px-3 py-2 bg-surface-container-high/30 border border-outline-variant/10 rounded-lg text-on-surface text-sm focus:border-primary focus:outline-none transition-colors">
          {#each Object.entries(questTypes) as [key, label]}
            <option value={key}>{label}</option>
          {/each}
        </select>
      </div>
      <div class="space-y-1">
        <label for="new-quest-frequency" class="field-label">{m.que_field_freq()}</label>
        <select id="new-quest-frequency" bind:value={newQuest.frequency} class="w-full px-3 py-2 bg-surface-container-high/30 border border-outline-variant/10 rounded-lg text-on-surface text-sm focus:border-primary focus:outline-none transition-colors">
          <option value="DAILY">{m.que_freq_daily()}</option>
          <option value="WEEKLY">{m.que_freq_weekly()}</option>
        </select>
      </div>
      <div class="space-y-1">
        <label for="new-quest-target" class="field-label">{m.que_field_target()}</label>
        <input id="new-quest-target" type="number" bind:value={newQuest.target} min="1" class="w-full px-3 py-2 bg-surface-container-high/30 border border-outline-variant/10 rounded-lg text-on-surface text-sm focus:border-primary focus:outline-none transition-colors" />
      </div>
      <div class="space-y-1">
        <label for="new-quest-reward-coins" class="field-label">{m.que_field_reward_coins()}</label>
        <input id="new-quest-reward-coins" type="number" bind:value={newQuest.rewardCoins} min="0" class="w-full px-3 py-2 bg-surface-container-high/30 border border-outline-variant/10 rounded-lg text-on-surface text-sm focus:border-primary focus:outline-none transition-colors" />
      </div>
      <div class="space-y-1">
        <label for="new-quest-reward-xp" class="field-label">{m.que_field_reward_xp()}</label>
        <input id="new-quest-reward-xp" type="number" bind:value={newQuest.rewardXp} min="0" class="w-full px-3 py-2 bg-surface-container-high/30 border border-outline-variant/10 rounded-lg text-on-surface text-sm focus:border-primary focus:outline-none transition-colors" />
      </div>
    </div>
    <div class="flex justify-end gap-2">
      <button
        class="px-4 py-2 bg-surface-container-high/40 text-on-surface-variant rounded-xl text-xs font-bold hover:bg-surface-container-high/60 transition-all flex items-center gap-2"
        onclick={() => showCreate = false}
      >
        {m.que_btn_cancel()}
      </button>
      <button
        class="px-4 py-2 bg-primary text-on-primary text-body-sm font-medium rounded-xl shadow-sm active:scale-[0.98] transition-all flex items-center gap-2"
        onclick={handleCreate}
      >
        {m.que_btn_create()}
      </button>
    </div>
  </div>
{/if}

<!-- Loading -->
{#if loading}
  <div class="flex flex-col items-center justify-center py-16 text-on-surface-variant gap-4">
    <div class="h-8 w-8 animate-spin rounded-full border-3 border-primary border-t-transparent"></div>
    <p class="text-sm">{m.que_loading()}</p>
  </div>
{:else if data}
  <!-- Stats Row -->
  <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
    <div class="bg-surface-container-high/30 rounded-xl p-4 flex items-center gap-3">
      <div class="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0">
        <Papicon icon="Compass" size={20} />
      </div>
      <div class="flex flex-col">
        <span class="text-xl font-bold text-on-surface">{data.definitions.length}</span>
        <span class="text-xs font-medium text-on-surface-variant">{m.que_stat_configured()}</span>
      </div>
    </div>
    <div class="bg-surface-container-high/30 rounded-xl p-4 flex items-center gap-3">
      <div class="h-9 w-9 rounded-lg bg-success/10 flex items-center justify-center text-success shrink-0">
        <Papicon icon="Check" size={20} />
      </div>
      <div class="flex flex-col">
        <span class="text-xl font-bold text-on-surface">{data.definitions.filter((q: any) => q.enabled).length}</span>
        <span class="text-xs font-medium text-on-surface-variant">{m.que_stat_active()}</span>
      </div>
    </div>
    <div class="bg-surface-container-high/30 rounded-xl p-4 flex items-center gap-3">
      <div class="h-9 w-9 rounded-lg bg-warning/10 flex items-center justify-center text-warning shrink-0">
        <Papicon icon="Star" size={20} />
      </div>
      <div class="flex flex-col">
        <span class="text-xl font-bold text-on-surface">{data.totalClaimed}</span>
        <span class="text-xs font-medium text-on-surface-variant">{m.que_stat_claimed()}</span>
      </div>
    </div>
  </div>

  <!-- Quest List or Empty State -->
  {#if data.definitions.length === 0}
    <EmptyState icon="compass" title={m.que_empty_title()} description={m.que_empty_desc()} actionLabel={m.que_empty_cta()} actionIcon="sparkles" onAction={openTemplates} />
  {:else}
    <div class="space-y-3">
      {#each data.definitions as quest}
        <div
          class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-5 space-y-3 transition-all {quest.frequency === 'DAILY' ? 'border-l-3 border-l-primary' : 'border-l-3 border-l-pink-500'} {!quest.enabled ? 'opacity-50' : ''}"
        >
          <!-- Quest Header -->
          <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
            <div>
              <h4 class="text-sm font-semibold text-on-surface">{quest.name}</h4>
              <p class="text-xs text-on-surface-variant mt-0.5">{quest.description}</p>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              {#if quest.frequency === 'DAILY'}
                <span class="px-2.5 py-0.5 bg-primary/10 text-primary text-xs font-medium rounded-full">{m.que_freq_daily()}</span>
              {:else}
                <span class="px-2.5 py-0.5 bg-pink-500/10 text-pink-500 text-xs font-medium rounded-full">{m.que_freq_weekly()}</span>
              {/if}
              <span class="px-2.5 py-0.5 bg-surface-container-high/40 text-on-surface-variant text-xs font-medium rounded-full">{questTypes[quest.type] ?? quest.type}</span>
            </div>
          </div>

          <!-- Quest Details -->
          <div class="flex flex-wrap gap-4 text-xs text-on-surface-variant">
            <div class="flex items-center gap-1.5">
              <Papicon icon="Flag" size={14} />
              <span>{m.que_target_label()} <strong class="text-on-surface">{quest.target}</strong></span>
            </div>
            <div class="flex items-center gap-1.5">
              <Papicon icon="DollarSign" size={14} />
              <span>{m.que_coins_label()} <strong class="text-on-surface">{quest.rewardCoins}</strong></span>
            </div>
            <div class="flex items-center gap-1.5">
              <Papicon icon="TrendingUp" size={14} />
              <span>{m.que_xp_label()} <strong class="text-on-surface">{quest.rewardXp}</strong></span>
            </div>
          </div>

          <!-- Progress -->
          <div class="flex flex-col sm:flex-row items-start sm:items-center gap-3">
            <div class="flex items-center gap-1.5 text-xs text-on-surface-variant shrink-0">
              <Papicon icon="Users" size={14} />
              <span>{m.que_participations({ count: quest._count?.progress ?? 0 })}</span>
            </div>
            {#if (quest._count?.progress ?? 0) > 0}
              <div class="h-2 bg-surface-container-high rounded-full overflow-hidden w-full max-w-50 sm:max-w-50">
                <div
                  class="h-2 rounded-full transition-all duration-500"
                  style="width: {Math.min(100, ((quest._count?.progress ?? 0) / Math.max(quest.target, 1)) * 100)}%; background: {quest.frequency === 'DAILY' ? 'var(--color-primary, #6750a4)' : '#ec4899'}"
                ></div>
              </div>
            {/if}
          </div>

          <!-- Actions -->
          <div class="flex gap-2">
            {#if quest.enabled}
              <button
                class="px-4 py-2 bg-surface-container-high/40 text-on-surface-variant rounded-xl text-xs font-bold hover:bg-surface-container-high/60 transition-all flex items-center gap-2"
                onclick={() => handleToggle(quest)}
              >
                {m.que_btn_disable()}
              </button>
            {:else}
              <button
                class="px-4 py-2 bg-success/10 text-success rounded-xl text-xs font-bold hover:bg-success/20 transition-all flex items-center gap-2"
                onclick={() => handleToggle(quest)}
              >
                {m.que_btn_enable()}
              </button>
            {/if}
            <button
              class="px-4 py-2 bg-error/10 text-error rounded-xl text-xs font-bold hover:bg-error/20 transition-all flex items-center gap-2"
              onclick={() => handleDelete(quest.id)}
            >
              {m.que_btn_delete()}
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
{/if}
</ModulePage>
