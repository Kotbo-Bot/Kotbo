<script lang="ts">
  import { onMount } from 'svelte';
  import { RANK_CARD_ACHIEVEMENTS, RANK_CARD_BADGE_ICONS, RANK_CARD_TIER_COLORS, errorMessage, isManualRankCardAchievement } from '@kotbo/shared';
  import { toast } from '../../lib/stores/toast.svelte';
  import { confirmDialog } from '../../lib/stores/confirmDialog.svelte';
  import {
    fetchManualAchievements,
    grantManualAchievement,
    revokeManualAchievement,
    type DiscordProfile,
    type ManualAchievementHolder,
  } from '../../lib/api';
  import Papicon from '../../lib/components/Papicon.svelte';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';

  const manualAchievements = RANK_CARD_ACHIEVEMENTS.filter(isManualRankCardAchievement);

  let holders = $state<Record<string, ManualAchievementHolder[]>>({});
  let profiles = $state<Record<string, DiscordProfile>>({});
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  let userId = $state('');
  let achievementId = $state(manualAchievements[0]?.id ?? '');
  let note = $state('');
  let granting = $state(false);
  let revoking = $state<string | null>(null);

  const canGrant = $derived(/^\d{17,20}$/.test(userId.trim()) && Boolean(achievementId));

  function nameOf(id: string | null): string {
    if (!id) return '-';
    return profiles[id]?.username ?? id;
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  async function load() {
    loading = true;
    loadError = null;
    try {
      const result = await fetchManualAchievements();
      holders = result.holders;
      profiles = result.profiles;
    } catch (err) {
      loadError = errorMessage(err) ?? 'Erreur lors du chargement des succès';
    } finally {
      loading = false;
    }
  }

  async function grant() {
    if (!canGrant || granting) return;
    granting = true;
    try {
      const target = userId.trim();
      const result = await grantManualAchievement(target, achievementId, note);
      profiles = { ...profiles, ...result.profiles };
      holders = { ...holders, [achievementId]: [result.holder, ...(holders[achievementId] ?? [])] };
      toast.success(`Succès attribué à ${nameOf(target)}.`);
      userId = '';
      note = '';
    } catch (err) {
      toast.error(errorMessage(err) ?? "Erreur lors de l'attribution du succès");
    } finally {
      granting = false;
    }
  }

  async function revoke(id: string, holder: ManualAchievementHolder) {
    const label = manualAchievements.find((achievement) => achievement.id === id)?.label.fr ?? id;
    if (!(await confirmDialog.danger(`Retirer le succès « ${label} » à ${nameOf(holder.userId)} ?`, '', 'Retirer'))) return;
    revoking = `${id}:${holder.userId}`;
    try {
      await revokeManualAchievement(holder.userId, id);
      holders = { ...holders, [id]: (holders[id] ?? []).filter((entry) => entry.userId !== holder.userId) };
      toast.success('Succès retiré.');
    } catch (err) {
      toast.error(errorMessage(err) ?? 'Erreur lors du retrait du succès');
    } finally {
      revoking = null;
    }
  }

  onMount(load);
</script>

<svg width="0" height="0" class="absolute" aria-hidden="true">
  <defs>
    {#each Object.entries(RANK_CARD_TIER_COLORS) as [tier, colors] (tier)}
      <linearGradient id="admin-tier-{tier}" x1="0" y1="0" x2="1" y2="1">
        {#each colors as color, index (index)}
          <stop offset={colors.length === 1 ? 0 : index / (colors.length - 1)} stop-color={color} />
        {/each}
      </linearGradient>
    {/each}
  </defs>
</svg>

<AdminShell title="Succès attribués" description="Succès de carte de rang donnés à la main par l'équipe Kotbo.">
  <div class="max-w-4xl mx-auto space-y-6">
    <div class="flex items-center gap-3">
      <div class="w-11 h-11 rounded-2xl bg-primary/15 border border-primary/20 flex items-center justify-center">
        <Papicon icon="Award" size={20} class="text-primary" />
      </div>
      <div>
        <h1 class="text-xl font-bold text-on-surface leading-tight">Succès attribués</h1>
        <p class="text-sm text-on-surface-variant/60">
          Ces succès ne se calculent pas : ils récompensent une aide à Kotbo. Les administrateurs Kotbo ne les ont pas d'office.
        </p>
      </div>
    </div>

    <div class="bg-surface-container-low/50 border border-outline-variant/10 rounded-2xl p-6 space-y-4">
      <h2 class="text-sm font-semibold text-on-surface">Attribuer un succès</h2>
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="space-y-1.5">
          <span class="block text-xs font-medium text-on-surface-variant">Identifiant Discord</span>
          <input
            bind:value={userId}
            placeholder="123456789012345678"
            inputmode="numeric"
            class="w-full px-4 py-2.5 rounded-xl bg-surface-container border border-outline-variant/20 text-on-surface text-sm focus:outline-none focus:border-primary/50 transition-colors"
          />
        </label>
        <label class="space-y-1.5">
          <span class="block text-xs font-medium text-on-surface-variant">Succès</span>
          <select
            bind:value={achievementId}
            class="w-full px-4 py-2.5 rounded-xl bg-surface-container border border-outline-variant/20 text-on-surface text-sm focus:outline-none focus:border-primary/50 transition-colors"
          >
            {#each manualAchievements as achievement (achievement.id)}
              <option value={achievement.id}>{achievement.label.fr}</option>
            {/each}
          </select>
        </label>
      </div>
      <label class="block space-y-1.5">
        <span class="block text-xs font-medium text-on-surface-variant">Note (facultative, visible par l'équipe seulement)</span>
        <input
          bind:value={note}
          maxlength="300"
          placeholder="Ex. : doublon des annonces de raid signalé le 12 septembre"
          class="w-full px-4 py-2.5 rounded-xl bg-surface-container border border-outline-variant/20 text-on-surface text-sm focus:outline-none focus:border-primary/50 transition-colors"
        />
      </label>
      <button
        onclick={grant}
        disabled={!canGrant || granting}
        class="px-5 py-2.5 rounded-xl bg-primary text-on-primary text-sm font-bold flex items-center justify-center gap-2 hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
      >
        {#if granting}
          <span class="w-4 h-4 border-2 border-on-primary/30 border-t-on-primary rounded-full animate-spin"></span>
        {:else}
          <Papicon icon="Plus" size={15} />
        {/if}
        Attribuer
      </button>
    </div>

    {#if loadError}
      <div class="flex items-center gap-3 px-4 py-3 rounded-xl bg-error/10 border border-error/20 text-error text-sm">
        <Papicon icon="AlertTriangle" size={16} />
        {loadError}
      </div>
    {/if}

    {#if loading}
      <div class="h-40 animate-pulse rounded-2xl bg-surface-container-low/50"></div>
    {:else if !loadError}
      {#each manualAchievements as achievement (achievement.id)}
        {@const list = holders[achievement.id] ?? []}
        <div class="bg-surface-container-low/50 border border-outline-variant/10 rounded-2xl overflow-hidden">
          <div class="flex items-center gap-3 px-5 py-4 border-b border-outline-variant/10">
            <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/70">
              <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                <path d={RANK_CARD_BADGE_ICONS[achievement.icon]} fill="url(#admin-tier-{achievement.tier})" fill-rule="evenodd" />
              </svg>
            </span>
            <div class="min-w-0 flex-1">
              <p class="font-semibold text-on-surface flex items-center gap-2">
                {achievement.label.fr}
                <span class="text-xs px-2 py-0.5 rounded-full bg-primary/15 text-primary font-bold">{list.length}</span>
              </p>
              <p class="text-xs text-on-surface-variant/50 truncate">{achievement.description.fr}</p>
            </div>
          </div>

          {#if list.length === 0}
            <p class="px-5 py-4 text-sm text-on-surface-variant/40">Personne n'a encore ce succès.</p>
          {:else}
            <ul class="divide-y divide-outline-variant/10">
              {#each list as holder (holder.userId)}
                <li class="flex items-center gap-3 px-5 py-3">
                  {#if profiles[holder.userId]?.avatarUrl}
                    <img src={profiles[holder.userId].avatarUrl} alt="" class="w-8 h-8 rounded-full" />
                  {:else}
                    <div class="w-8 h-8 rounded-full bg-on-surface/5 flex items-center justify-center">
                      <Papicon icon="User" size={14} class="text-on-surface-variant/40" />
                    </div>
                  {/if}
                  <div class="min-w-0 flex-1">
                    <p class="text-sm text-on-surface truncate">
                      {nameOf(holder.userId)}
                      <span class="font-mono text-xs text-on-surface-variant/40">{holder.userId}</span>
                    </p>
                    <p class="text-xs text-on-surface-variant/50 truncate">
                      {formatDate(holder.unlockedAt)}
                      {#if holder.grantedBy} · par {nameOf(holder.grantedBy)}{/if}
                      {#if holder.note} · {holder.note}{/if}
                    </p>
                  </div>
                  <button
                    onclick={() => revoke(achievement.id, holder)}
                    disabled={revoking === `${achievement.id}:${holder.userId}`}
                    title="Retirer le succès"
                    aria-label="Retirer le succès"
                    class="p-2 rounded-lg text-on-surface-variant/50 hover:text-error hover:bg-error/10 disabled:opacity-40 transition-colors"
                  >
                    <Papicon icon="Trash2" size={15} />
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</AdminShell>
