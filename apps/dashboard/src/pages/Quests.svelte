<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchQuestsData, saveQuest, updateQuest, deleteQuest } from '../lib/api';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import MultiSelect from '../lib/components/MultiSelect.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import { m } from '../lib/i18n';

  type Extra =
    | { type: 'ROLE'; roleId: string; durationHours: string }
    | { type: 'ITEM'; itemId: string; quantity: number }
    | { type: 'GIVEAWAY_ENTRY'; giveawayId: string }
    | { type: 'MESSAGE'; content: string; channelId: string };

  const blankForm = () => ({
    id: undefined as string | undefined,
    name: '', description: '', emoji: '📜', objective: 'SEND_MESSAGES', target: 10,
    preset: 'DAILY' as 'DAILY' | 'WEEKLY' | 'CUSTOM', windowHours: 24, repeatable: false,
    scope: 'MEMBER', teamMode: 'CLAN', rewardClanPoints: 0,
    rewardCoins: 50, rewardXp: 0, levelXp: 25,
    channelIds: [] as string[], excludeChannelIds: [] as string[], categoryIds: [] as string[],
    roleIds: [] as string[], excludeRoleIds: [] as string[],
    minLength: 0, keywords: '', requireAttachment: false, requireLink: false, requireMention: false,
    weekdays: [] as number[], hourFrom: '', hourTo: '',
    activeFrom: '', activeUntil: '', prerequisiteQuestId: '',
    extras: [] as Extra[],
  });

  let loading = $state(true);
  let saving = $state(false);
  let data: any = $state(null);
  let showForm = $state(false);
  let showTemplates = $state(false);
  let form = $state(blankForm());

  const discordChannels = $derived((dashboardStore.state.discordChannels ?? []) as Array<{ id: string; name: string }>);
  const discordCategories = $derived((dashboardStore.state.discordCategories ?? []) as Array<{ id: string; name: string }>);
  const discordRoles = $derived((dashboardStore.state.discordRoles ?? []) as Array<{ id: string; name: string }>);
  const channelOptions = $derived(discordChannels.map((c) => ({ id: c.id, name: `#${c.name}` })));
  const categoryOptions = $derived(discordCategories.map((c) => ({ id: c.id, name: c.name })));
  const roleOptions = $derived(discordRoles.map((r) => ({ id: r.id, name: `@${r.name}` })));
  const giveawayOptions = $derived(((data?.giveaways ?? []) as Array<{ id: string; prize: string }>).map((g) => ({ id: g.id, name: g.prize })));
  const itemOptions = $derived(((data?.items ?? []) as Array<{ id: string; name: string; emoji?: string }>).map((i) => ({ id: i.id, name: `${i.emoji ?? ''} ${i.name}`.trim() })));
  const prerequisiteOptions = $derived(((data?.definitions ?? []) as any[]).filter((q) => q.id !== form.id).map((q) => ({ id: q.id, name: q.name })));

  const OBJECTIVE_LABELS: Record<string, () => string> = {
    SEND_MESSAGES: m.que_type_send_messages, REPLY_MESSAGES: m.que_type_reply_messages,
    VOICE_MINUTES: m.que_type_voice_minutes, REACT_MESSAGES: m.que_type_react_messages,
    CREATE_THREADS: m.que_type_create_threads, GIVE_REP: m.que_type_give_rep,
    WIN_GAME: m.que_type_win_game, EARN_COINS: m.que_type_earn_coins,
    GIVEAWAYS_JOINED: m.quz_obj_GIVEAWAYS_JOINED, GIVEAWAYS_WON: m.quz_obj_GIVEAWAYS_WON,
    LEVEL_REACHED: m.quz_obj_LEVEL_REACHED, XP_EARNED: m.quz_obj_XP_EARNED,
    ACTIVE_STREAK: m.quz_obj_ACTIVE_STREAK, ACTIVE_DAYS: m.quz_obj_ACTIVE_DAYS,
    INVITES: m.quz_obj_INVITES, TICKETS_OPENED: m.quz_obj_TICKETS_OPENED,
    SUGGESTIONS_SENT: m.quz_obj_SUGGESTIONS_SENT, QUESTS_COMPLETED: m.quz_obj_QUESTS_COMPLETED,
    MONSTER_KILLS: m.eco_quest_obj_monsters, BOSS_KILLS: m.eco_quest_obj_bosses,
    RAID_ASSAULTS: m.eco_quest_obj_raid_assaults, RAID_DAMAGE: m.eco_quest_obj_raid_damage,
    ITEMS_LOOTED: m.eco_quest_obj_items, FISH_CAUGHT: m.eco_quest_obj_fish,
    ITEMS_CRAFTED: m.eco_quest_obj_crafted, UPGRADES_SUCCEEDED: m.eco_quest_obj_upgrades,
    SHOP_PURCHASES: m.eco_quest_obj_shop, BLACK_MARKET_PURCHASES: m.eco_quest_obj_black_market,
    COINS_SPENT: m.eco_quest_obj_coins_spent, ADVENTURES_COMPLETED: m.eco_quest_obj_adventures,
    DAILY_CLAIMS: m.eco_quest_obj_daily, TOWER_FLOORS: m.eco_quest_obj_tower_floors,
    TOWER_MONSTER_KILLS: m.eco_quest_obj_tower_monsters, TOWER_BOSS_KILLS: m.eco_quest_obj_tower_bosses,
  };
  const objectiveLabel = (o: string) => OBJECTIVE_LABELS[o]?.() ?? o;

  const objectiveGroups = $derived([
    { label: m.quz_group_activity(), items: ['SEND_MESSAGES', 'REPLY_MESSAGES', 'VOICE_MINUTES', 'REACT_MESSAGES', 'CREATE_THREADS', 'GIVE_REP', 'WIN_GAME', 'EARN_COINS'] },
    { label: m.quz_group_progress(), items: ['GIVEAWAYS_JOINED', 'GIVEAWAYS_WON', 'LEVEL_REACHED', 'XP_EARNED', 'ACTIVE_STREAK', 'ACTIVE_DAYS'] },
    { label: m.quz_group_community(), items: ['INVITES', 'TICKETS_OPENED', 'SUGGESTIONS_SENT'] },
    { label: m.quz_group_meta(), items: ['QUESTS_COMPLETED'] },
    { label: m.quz_group_rpg(), items: ['MONSTER_KILLS', 'BOSS_KILLS', 'RAID_ASSAULTS', 'RAID_DAMAGE', 'ITEMS_LOOTED', 'FISH_CAUGHT', 'ITEMS_CRAFTED', 'UPGRADES_SUCCEEDED', 'SHOP_PURCHASES', 'BLACK_MARKET_PURCHASES', 'COINS_SPENT', 'ADVENTURES_COMPLETED', 'DAILY_CLAIMS', 'TOWER_FLOORS', 'TOWER_MONSTER_KILLS', 'TOWER_BOSS_KILLS'] },
  ]);

  const questTemplates = $derived([
    { name: m.que_tpl_chatter_name(), objective: 'SEND_MESSAGES', target: 50, rewardCoins: 100, levelXp: 50, preset: 'DAILY', description: m.que_tpl_chatter_desc(), icon: 'MessageSquare', color: 'primary' },
    { name: m.que_tpl_vocalist_name(), objective: 'VOICE_MINUTES', target: 30, rewardCoins: 75, levelXp: 40, preset: 'DAILY', description: m.que_tpl_vocalist_desc(), icon: 'Mic', color: 'emerald-500' },
    { name: m.que_tpl_reactor_name(), objective: 'REACT_MESSAGES', target: 20, rewardCoins: 50, levelXp: 25, preset: 'DAILY', description: m.que_tpl_reactor_desc(), icon: 'Heart', color: 'pink-500' },
    { name: m.quz_tpl_giveaway_name(), objective: 'GIVEAWAYS_JOINED', target: 3, rewardCoins: 100, levelXp: 50, preset: 'WEEKLY', description: m.quz_tpl_giveaway_desc(), icon: 'Gift', color: 'amber-500' },
    { name: m.quz_tpl_level_name(), objective: 'LEVEL_REACHED', target: 10, rewardCoins: 200, levelXp: 0, preset: 'WEEKLY', description: m.quz_tpl_level_desc(), icon: 'TrendingUp', color: 'primary' },
    { name: m.quz_tpl_streak_name(), objective: 'ACTIVE_STREAK', target: 7, rewardCoins: 250, levelXp: 100, preset: 'WEEKLY', description: m.quz_tpl_streak_desc(), icon: 'Flame', color: 'amber-500' },
    { name: m.quz_tpl_invite_name(), objective: 'INVITES', target: 3, rewardCoins: 200, levelXp: 100, preset: 'WEEKLY', description: m.quz_tpl_invite_desc(), icon: 'Users', color: 'emerald-500' },
    { name: m.quz_tpl_bonus_name(), objective: 'QUESTS_COMPLETED', target: 3, rewardCoins: 150, levelXp: 75, preset: 'DAILY', description: m.quz_tpl_bonus_desc(), icon: 'Star', color: 'pink-500' },
  ]);

  const WEEKDAYS: Array<[number, () => string]> = [
    [1, m.quz_wd_1], [2, m.quz_wd_2], [3, m.quz_wd_3], [4, m.quz_wd_4], [5, m.quz_wd_5], [6, m.quz_wd_6], [0, m.quz_wd_0],
  ];

  const input = 'w-full px-3 py-2 bg-surface-container-high/30 border border-field-border rounded-lg text-on-surface text-sm focus:border-primary focus:outline-none transition-colors';
  const ghostBtn = 'px-4 py-2 bg-surface-container-high/40 text-on-surface-variant rounded-xl text-xs font-bold hover:bg-surface-container-high/60 transition-all flex items-center gap-2';

  const presetHours = (preset: string, custom: number) => (preset === 'DAILY' ? 24 : preset === 'WEEKLY' ? 168 : custom);
  const toLocal = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16) : '');

  function openTemplates() { showTemplates = true; showForm = false; }

  function openBlank() { form = blankForm(); showTemplates = false; showForm = true; }

  function selectTemplate(tpl: (typeof questTemplates)[number]) {
    form = { ...blankForm(), name: tpl.name, description: tpl.description, objective: tpl.objective, target: tpl.target,
      preset: tpl.preset as 'DAILY' | 'WEEKLY', windowHours: presetHours(tpl.preset, 24), rewardCoins: tpl.rewardCoins, levelXp: tpl.levelXp };
    showTemplates = false;
    showForm = true;
  }

  function openEdit(quest: any) {
    const c = quest.conditions ?? {};
    const rewards: any[] = Array.isArray(quest.rewards) ? quest.rewards : [];
    const level = rewards.find((r) => r.type === 'LEVEL_XP');
    const preset = quest.windowHours === 24 ? 'DAILY' : quest.windowHours === 168 ? 'WEEKLY' : 'CUSTOM';
    form = {
      ...blankForm(),
      id: quest.id, name: quest.name, description: quest.description, emoji: quest.emoji, objective: quest.objective,
      target: quest.target, preset, windowHours: quest.windowHours, repeatable: quest.repeatable,
      scope: quest.scope, teamMode: quest.teamMode, rewardClanPoints: quest.rewardClanPoints,
      rewardCoins: quest.rewardCoins, rewardXp: quest.rewardXp, levelXp: level?.amount ?? 0,
      channelIds: c.channelIds ?? [], excludeChannelIds: c.excludeChannelIds ?? [], categoryIds: c.categoryIds ?? [],
      roleIds: c.roleIds ?? [], excludeRoleIds: c.excludeRoleIds ?? [],
      minLength: c.minLength ?? 0, keywords: (c.keywords ?? []).join(', '),
      requireAttachment: !!c.requireAttachment, requireLink: !!c.requireLink, requireMention: !!c.requireMention,
      weekdays: c.weekdays ?? [], hourFrom: c.hourFrom ?? '', hourTo: c.hourTo ?? '',
      activeFrom: toLocal(quest.activeFrom), activeUntil: toLocal(quest.activeUntil),
      prerequisiteQuestId: quest.prerequisiteQuestId ?? '',
      extras: rewards.filter((r) => r.type !== 'LEVEL_XP').map((r): Extra =>
        r.type === 'ROLE' ? { type: 'ROLE', roleId: r.roleId, durationHours: r.durationHours ? String(r.durationHours) : '' }
        : r.type === 'ITEM' ? { type: 'ITEM', itemId: r.itemId, quantity: r.quantity ?? 1 }
        : r.type === 'GIVEAWAY_ENTRY' ? { type: 'GIVEAWAY_ENTRY', giveawayId: r.giveawayId }
        : { type: 'MESSAGE', content: r.content ?? '', channelId: r.channelId ?? '' }),
    };
    showTemplates = false;
    showForm = true;
  }

  function addExtra(type: Extra['type']) {
    const extra: Extra = type === 'ROLE' ? { type, roleId: '', durationHours: '' }
      : type === 'ITEM' ? { type, itemId: '', quantity: 1 }
      : type === 'GIVEAWAY_ENTRY' ? { type, giveawayId: '' }
      : { type, content: '', channelId: '' };
    form.extras = [...form.extras, extra];
  }

  function buildPayload() {
    const conditions: Record<string, unknown> = {};
    if (form.channelIds.length) conditions.channelIds = form.channelIds;
    if (form.excludeChannelIds.length) conditions.excludeChannelIds = form.excludeChannelIds;
    if (form.categoryIds.length) conditions.categoryIds = form.categoryIds;
    if (form.roleIds.length) conditions.roleIds = form.roleIds;
    if (form.excludeRoleIds.length) conditions.excludeRoleIds = form.excludeRoleIds;
    if (Number(form.minLength) > 0) conditions.minLength = Number(form.minLength);
    if (form.keywords.trim()) conditions.keywords = form.keywords.split(',').map((k) => k.trim()).filter(Boolean);
    if (form.requireAttachment) conditions.requireAttachment = true;
    if (form.requireLink) conditions.requireLink = true;
    if (form.requireMention) conditions.requireMention = true;
    if (form.weekdays.length) conditions.weekdays = form.weekdays;
    if (form.hourFrom !== '' && form.hourTo !== '') { conditions.hourFrom = Number(form.hourFrom); conditions.hourTo = Number(form.hourTo); }

    const rewards: Array<Record<string, unknown>> = [];
    if (Number(form.levelXp) > 0) rewards.push({ type: 'LEVEL_XP', amount: Number(form.levelXp) });
    for (const extra of form.extras) {
      if (extra.type === 'ROLE' && extra.roleId) rewards.push({ type: 'ROLE', roleId: extra.roleId, ...(extra.durationHours ? { durationHours: Number(extra.durationHours) } : {}) });
      else if (extra.type === 'ITEM' && extra.itemId) rewards.push({ type: 'ITEM', itemId: extra.itemId, quantity: Number(extra.quantity) || 1 });
      else if (extra.type === 'GIVEAWAY_ENTRY' && extra.giveawayId) rewards.push({ type: 'GIVEAWAY_ENTRY', giveawayId: extra.giveawayId });
      else if (extra.type === 'MESSAGE' && extra.content.trim()) rewards.push({ type: 'MESSAGE', content: extra.content, ...(extra.channelId ? { channelId: extra.channelId } : {}) });
    }

    return {
      id: form.id, name: form.name.trim(), description: form.description.trim() || form.name.trim(), emoji: form.emoji,
      objective: form.objective, target: Number(form.target),
      windowHours: presetHours(form.preset, Number(form.windowHours)), repeatable: form.repeatable,
      scope: form.scope, teamMode: form.teamMode, rewardClanPoints: form.rewardClanPoints,
      rewardCoins: Number(form.rewardCoins) || 0, rewardXp: Number(form.rewardXp) || 0,
      conditions, rewards,
      prerequisiteQuestId: form.prerequisiteQuestId || null,
      activeFrom: form.activeFrom ? new Date(form.activeFrom).toISOString() : null,
      activeUntil: form.activeUntil ? new Date(form.activeUntil).toISOString() : null,
    };
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

  async function handleSave() {
    if (!form.name.trim()) { toast.error(m.que_name_required()); return; }
    if (!Number.isFinite(Number(form.target)) || Number(form.target) < 1) { toast.error(m.que_numbers_invalid()); return; }
    saving = true;
    try {
      await saveQuest(buildPayload());
      showForm = false;
      await load();
    } catch {
      toast.error(m.quz_save_error());
    } finally {
      saving = false;
    }
  }

  async function handleToggle(quest: any) {
    try { await updateQuest(quest.id, { enabled: !quest.enabled }); await load(); } catch { toast.error(m.que_update_error()); }
  }

  async function handleDelete(questId: string) {
    try { await deleteQuest(questId); await load(); } catch { toast.error(m.que_delete_error()); }
  }

  function windowLabel(hours: number) {
    return hours === 24 ? m.que_freq_daily() : hours === 168 ? m.que_freq_weekly() : `${hours} h`;
  }

  function rewardSummary(quest: any): string {
    const parts: string[] = [];
    if (quest.rewardCoins) parts.push(`${quest.rewardCoins} coins`);
    const rewards: any[] = Array.isArray(quest.rewards) ? quest.rewards : [];
    const level = rewards.find((r) => r.type === 'LEVEL_XP');
    if (level) parts.push(`${level.amount} XP`);
    if (quest.rewardXp) parts.push(`${quest.rewardXp} ${m.quz_rew_rpg_xp()}`);
    const labels: Record<string, () => string> = { ROLE: m.quz_rew_type_role, ITEM: m.quz_rew_type_item, GIVEAWAY_ENTRY: m.quz_rew_type_giveaway, MESSAGE: m.quz_rew_type_message };
    for (const r of rewards) if (r.type !== 'LEVEL_XP') parts.push(labels[r.type]?.() ?? r.type);
    return parts.join(' · ');
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

{#if showTemplates}
  <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4 mb-4">
    <div>
      <h3 class="text-base font-semibold">{m.que_choose_template()}</h3>
      <p class="text-xs text-on-surface-variant mt-1">{m.que_template_subtitle()}</p>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {#each questTemplates as tpl}
        <button
          class="flex flex-col gap-3 bg-surface-container-high/20 border border-outline-variant/10 rounded-xl p-4 text-left transition-all hover:border-{tpl.color}/40 hover:bg-surface-container-high/40 hover:-translate-y-0.5 border-l-3 border-l-{tpl.color} cursor-pointer"
          onclick={() => selectTemplate(tpl)}
        >
          <div class="text-{tpl.color}"><Papicon icon={tpl.icon} size={22} /></div>
          <div class="flex flex-col gap-0.5">
            <span class="font-semibold text-sm text-on-surface">{tpl.name}</span>
            <span class="text-xs text-on-surface-variant">{tpl.description}</span>
          </div>
          <span class="text-2xs text-on-surface-variant/60">{windowLabel(presetHours(tpl.preset, 24))} · {objectiveLabel(tpl.objective)}</span>
        </button>
      {/each}
      <button
        class="flex flex-col gap-3 bg-surface-container-high/20 border border-outline-variant/10 rounded-xl p-4 text-left transition-all hover:border-on-surface-variant/30 hover:bg-surface-container-high/40 hover:-translate-y-0.5 border-l-3 border-l-outline-variant/20 cursor-pointer"
        onclick={openBlank}
      >
        <div class="text-on-surface-variant/40"><Papicon icon="Plus" size={22} /></div>
        <div class="flex flex-col gap-0.5">
          <span class="font-semibold text-sm text-on-surface">{m.que_custom_title()}</span>
          <span class="text-xs text-on-surface-variant">{m.que_custom_desc()}</span>
        </div>
      </button>
    </div>
    <div class="flex justify-end">
      <button class={ghostBtn} onclick={() => (showTemplates = false)}>{m.que_btn_cancel()}</button>
    </div>
  </div>
{/if}

{#if showForm}
  <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-6 mb-4">
    <h3 class="text-base font-semibold">{form.id ? m.quz_edit_title() : m.que_create_title()}</h3>

    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      <div class="space-y-1">
        <label for="q-name" class="field-label">{m.que_field_name()}</label>
        <input id="q-name" type="text" bind:value={form.name} placeholder={m.que_placeholder_name()} class={input} />
      </div>
      <div class="space-y-1 lg:col-span-2">
        <label for="q-desc" class="field-label">{m.que_field_desc()}</label>
        <input id="q-desc" type="text" bind:value={form.description} placeholder={m.que_placeholder_desc()} class={input} />
      </div>
      <div class="space-y-1">
        <label for="q-obj" class="field-label">{m.que_field_type()}</label>
        <select id="q-obj" bind:value={form.objective} class={input}>
          {#each objectiveGroups as group}
            <optgroup label={group.label}>
              {#each group.items as o}<option value={o}>{objectiveLabel(o)}</option>{/each}
            </optgroup>
          {/each}
        </select>
      </div>
      <div class="space-y-1">
        <label for="q-target" class="field-label">{m.que_field_target()}</label>
        <input id="q-target" type="number" min="1" bind:value={form.target} class={input} />
      </div>
      <div class="space-y-1">
        <label for="q-window" class="field-label">{m.quz_window()}</label>
        <div class="flex gap-2">
          <select id="q-window" bind:value={form.preset} class={input}>
            <option value="DAILY">{m.que_freq_daily()}</option>
            <option value="WEEKLY">{m.que_freq_weekly()}</option>
            <option value="CUSTOM">{m.quz_window_custom()}</option>
          </select>
          {#if form.preset === 'CUSTOM'}
            <input type="number" min="1" max="720" bind:value={form.windowHours} aria-label={m.quz_window_hours()} class={input} />
          {/if}
        </div>
      </div>
    </div>
    <label class="flex items-start gap-2 text-xs text-on-surface-variant">
      <input type="checkbox" bind:checked={form.repeatable} class="mt-0.5" />
      <span><strong class="text-on-surface">{m.quz_repeatable()}</strong> — {m.quz_repeatable_hint()}</span>
    </label>

    <!-- Conditions -->
    <div class="pt-4 border-t border-outline-variant/10 space-y-4">
      <div>
        <p class="text-sm font-semibold text-on-surface">{m.quz_cond_title()}</p>
        <p class="text-xs text-on-surface-variant mt-0.5">{m.quz_cond_hint()}</p>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="space-y-1"><span class="field-label">{m.quz_cond_channels()}</span><MultiSelect bind:values={form.channelIds} options={channelOptions} /></div>
        <div class="space-y-1"><span class="field-label">{m.quz_cond_exclude_channels()}</span><MultiSelect bind:values={form.excludeChannelIds} options={channelOptions} /></div>
        <div class="space-y-1"><span class="field-label">{m.quz_cond_categories()}</span><MultiSelect bind:values={form.categoryIds} options={categoryOptions} /></div>
        <div class="space-y-1"><span class="field-label">{m.quz_cond_roles()}</span><MultiSelect bind:values={form.roleIds} options={roleOptions} /></div>
        <div class="space-y-1"><span class="field-label">{m.quz_cond_exclude_roles()}</span><MultiSelect bind:values={form.excludeRoleIds} options={roleOptions} /></div>
        <div class="space-y-1">
          <span class="field-label">{m.quz_cond_prereq()}</span>
          <SearchableSelect bind:value={form.prerequisiteQuestId} options={prerequisiteOptions} showId={false} />
        </div>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div class="space-y-1">
          <label for="q-minlen" class="field-label">{m.quz_cond_min_length()}</label>
          <input id="q-minlen" type="number" min="0" bind:value={form.minLength} class={input} />
        </div>
        <div class="space-y-1 lg:col-span-3">
          <label for="q-kw" class="field-label">{m.quz_cond_keywords()}</label>
          <input id="q-kw" type="text" bind:value={form.keywords} placeholder={m.quz_cond_keywords_hint()} class={input} />
        </div>
      </div>
      <div class="flex flex-wrap gap-x-6 gap-y-2 text-xs text-on-surface-variant">
        <label class="flex items-center gap-2"><input type="checkbox" bind:checked={form.requireAttachment} /> {m.quz_cond_attachment()}</label>
        <label class="flex items-center gap-2"><input type="checkbox" bind:checked={form.requireLink} /> {m.quz_cond_link()}</label>
        <label class="flex items-center gap-2"><input type="checkbox" bind:checked={form.requireMention} /> {m.quz_cond_mention()}</label>
      </div>
      <div class="space-y-2">
        <span class="field-label">{m.quz_cond_weekdays()}</span>
        <div class="flex flex-wrap gap-2">
          {#each WEEKDAYS as [day, label]}
            <button
              type="button"
              aria-pressed={form.weekdays.includes(day)}
              class="px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors {form.weekdays.includes(day) ? 'bg-primary/20 text-primary border-primary/40' : 'border-outline-variant/20 text-on-surface-variant'}"
              onclick={() => (form.weekdays = form.weekdays.includes(day) ? form.weekdays.filter((d) => d !== day) : [...form.weekdays, day])}
            >{label()}</button>
          {/each}
        </div>
      </div>
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div class="space-y-1">
          <label for="q-hf" class="field-label">{m.quz_cond_hour_from()}</label>
          <input id="q-hf" type="number" min="0" max="23" bind:value={form.hourFrom} class={input} />
        </div>
        <div class="space-y-1">
          <label for="q-ht" class="field-label">{m.quz_cond_hour_to()}</label>
          <input id="q-ht" type="number" min="0" max="23" bind:value={form.hourTo} class={input} />
        </div>
        <div class="space-y-1">
          <label for="q-af" class="field-label">{m.quz_cond_active_from()}</label>
          <input id="q-af" type="datetime-local" bind:value={form.activeFrom} class={input} />
        </div>
        <div class="space-y-1">
          <label for="q-au" class="field-label">{m.quz_cond_active_until()}</label>
          <input id="q-au" type="datetime-local" bind:value={form.activeUntil} class={input} />
        </div>
      </div>
      <p class="text-2xs text-on-surface-variant/70">{m.quz_cond_hours_hint()}</p>
    </div>

    <!-- Récompenses -->
    <div class="pt-4 border-t border-outline-variant/10 space-y-4">
      <p class="text-sm font-semibold text-on-surface">{m.quz_rew_title()}</p>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div class="space-y-1">
          <label for="q-coins" class="field-label">{m.que_field_reward_coins()}</label>
          <input id="q-coins" type="number" min="0" bind:value={form.rewardCoins} class={input} />
        </div>
        <div class="space-y-1">
          <label for="q-lxp" class="field-label">{m.quz_rew_level_xp()}</label>
          <input id="q-lxp" type="number" min="0" bind:value={form.levelXp} class={input} />
        </div>
        <div class="space-y-1">
          <label for="q-rxp" class="field-label">{m.quz_rew_rpg_xp()}</label>
          <input id="q-rxp" type="number" min="0" bind:value={form.rewardXp} class={input} />
        </div>
      </div>

      {#each form.extras as extra, i}
        <div class="bg-surface-container-high/20 border border-outline-variant/10 rounded-xl p-4 space-y-3">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold text-on-surface">
              {extra.type === 'ROLE' ? m.quz_rew_type_role() : extra.type === 'ITEM' ? m.quz_rew_type_item() : extra.type === 'GIVEAWAY_ENTRY' ? m.quz_rew_type_giveaway() : m.quz_rew_type_message()}
            </span>
            <button type="button" class="text-xs text-on-error-container hover:underline" onclick={() => (form.extras = form.extras.filter((_, idx) => idx !== i))}>{m.quz_rew_remove()}</button>
          </div>
          {#if extra.type === 'ROLE'}
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <SearchableSelect bind:value={extra.roleId} options={roleOptions} placeholder={m.quz_rew_role_pick()} showId={false} />
              <input type="number" min="1" bind:value={extra.durationHours} placeholder={m.quz_rew_duration()} aria-label={m.quz_rew_duration()} class={input} />
            </div>
          {:else if extra.type === 'ITEM'}
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <SearchableSelect bind:value={extra.itemId} options={itemOptions} placeholder={m.quz_rew_item_pick()} showId={false} />
              <input type="number" min="1" bind:value={extra.quantity} aria-label={m.quz_rew_qty()} class={input} />
            </div>
          {:else if extra.type === 'GIVEAWAY_ENTRY'}
            <SearchableSelect bind:value={extra.giveawayId} options={giveawayOptions} placeholder={m.quz_rew_giveaway_pick()} showId={false} />
          {:else}
            <textarea rows="3" maxlength="1500" bind:value={extra.content} aria-label={m.quz_rew_message()} class={input}></textarea>
            <p class="text-2xs text-on-surface-variant/70">{m.quz_rew_message_hint()}</p>
            <SearchableSelect bind:value={extra.channelId} options={channelOptions} placeholder={m.quz_rew_channel()} showId={false} />
          {/if}
        </div>
      {/each}

      <div class="flex flex-wrap gap-2">
        <span class="field-label self-center">{m.quz_rew_add()}</span>
        <button type="button" class={ghostBtn} onclick={() => addExtra('ROLE')}>{m.quz_rew_type_role()}</button>
        <button type="button" class={ghostBtn} onclick={() => addExtra('ITEM')}>{m.quz_rew_type_item()}</button>
        <button type="button" class={ghostBtn} onclick={() => addExtra('GIVEAWAY_ENTRY')}>{m.quz_rew_type_giveaway()}</button>
        <button type="button" class={ghostBtn} onclick={() => addExtra('MESSAGE')}>{m.quz_rew_type_message()}</button>
      </div>
    </div>

    <div class="flex justify-end gap-2">
      <button class={ghostBtn} onclick={() => (showForm = false)}>{m.que_btn_cancel()}</button>
      <button
        class="px-4 py-2 bg-primary text-on-primary text-body-sm font-medium rounded-xl shadow-sm active:scale-[0.98] transition-all disabled:opacity-60"
        disabled={saving}
        onclick={handleSave}
      >{form.id ? m.quz_save() : m.que_btn_create()}</button>
    </div>
  </div>
{/if}

{#if loading}
  <div class="flex flex-col items-center justify-center py-16 text-on-surface-variant gap-4">
    <div class="h-8 w-8 animate-spin rounded-full border-3 border-primary border-t-transparent"></div>
    <p class="text-sm">{m.que_loading()}</p>
  </div>
{:else if data}
  <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
    <div class="bg-surface-container-high/30 rounded-xl p-4 flex items-center gap-3">
      <div class="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0"><Papicon icon="Compass" size={20} /></div>
      <div class="flex flex-col">
        <span class="text-xl font-bold text-on-surface">{data.definitions.length}</span>
        <span class="text-xs font-medium text-on-surface-variant">{m.que_stat_configured()}</span>
      </div>
    </div>
    <div class="bg-surface-container-high/30 rounded-xl p-4 flex items-center gap-3">
      <div class="h-9 w-9 rounded-lg bg-success/10 flex items-center justify-center text-on-success-container shrink-0"><Papicon icon="Check" size={20} /></div>
      <div class="flex flex-col">
        <span class="text-xl font-bold text-on-surface">{data.definitions.filter((q: any) => q.enabled).length}</span>
        <span class="text-xs font-medium text-on-surface-variant">{m.que_stat_active()}</span>
      </div>
    </div>
    <div class="bg-surface-container-high/30 rounded-xl p-4 flex items-center gap-3">
      <div class="h-9 w-9 rounded-lg bg-warning/10 flex items-center justify-center text-on-warning-container shrink-0"><Papicon icon="Star" size={20} /></div>
      <div class="flex flex-col">
        <span class="text-xl font-bold text-on-surface">{data.totalClaimed}</span>
        <span class="text-xs font-medium text-on-surface-variant">{m.que_stat_claimed()}</span>
      </div>
    </div>
  </div>

  {#if data.definitions.length === 0}
    <EmptyState icon="compass" title={m.que_empty_title()} description={m.que_empty_desc()} actionLabel={m.que_empty_cta()} actionIcon="sparkles" onAction={openTemplates} />
  {:else}
    <div class="space-y-3">
      {#each data.definitions as quest (quest.id)}
        {@const prereq = quest.prerequisiteQuestId ? data.definitions.find((q: any) => q.id === quest.prerequisiteQuestId) : null}
        <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-5 space-y-3 transition-all border-l-3 {quest.windowHours >= 168 ? 'border-l-pink-500' : 'border-l-primary'} {!quest.enabled ? 'opacity-50' : ''}">
          <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
            <div>
              <h4 class="text-sm font-semibold text-on-surface">{quest.emoji} {quest.name}</h4>
              <p class="text-xs text-on-surface-variant mt-0.5">{quest.description}</p>
            </div>
            <div class="flex flex-wrap items-center gap-2 shrink-0">
              <span class="px-2.5 py-0.5 bg-primary/10 text-primary text-xs font-medium rounded-full">{windowLabel(quest.windowHours)}</span>
              <span class="px-2.5 py-0.5 bg-surface-container-high/40 text-on-surface-variant text-xs font-medium rounded-full">{objectiveLabel(quest.objective)}</span>
              {#if prereq}<span class="px-2.5 py-0.5 bg-surface-container-high/40 text-on-surface-variant text-xs rounded-full">{m.quz_locked_by({ name: prereq.name })}</span>{/if}
            </div>
          </div>
          <div class="flex flex-wrap gap-4 text-xs text-on-surface-variant">
            <span class="flex items-center gap-1.5"><Papicon icon="Flag" size={14} /> {m.que_target_label()} <strong class="text-on-surface">{quest.target}</strong></span>
            <span class="flex items-center gap-1.5"><Papicon icon="Star" size={14} /> {rewardSummary(quest) || '—'}</span>
            <span class="flex items-center gap-1.5"><Papicon icon="Users" size={14} /> {m.que_participations({ count: quest.participants ?? 0 })}</span>
          </div>
          <div class="flex gap-2">
            <button class={ghostBtn} onclick={() => openEdit(quest)}>{m.quz_edit()}</button>
            {#if quest.enabled}
              <button class={ghostBtn} onclick={() => handleToggle(quest)}>{m.que_btn_disable()}</button>
            {:else}
              <button class="px-4 py-2 bg-success/10 text-on-success-container rounded-xl text-xs font-bold hover:bg-success/20 transition-all" onclick={() => handleToggle(quest)}>{m.que_btn_enable()}</button>
            {/if}
            <button class="px-4 py-2 bg-error/10 text-on-error-container rounded-xl text-xs font-bold hover:bg-error/20 transition-all" onclick={() => handleDelete(quest.id)}>{m.que_btn_delete()}</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
{/if}
</ModulePage>
