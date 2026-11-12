<script lang="ts">
  import { m } from '../../lib/i18n';
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
  import AdminCard from '../../lib/components/admin/AdminCard.svelte';
  import AdminBadge from '../../lib/components/admin/AdminBadge.svelte';
  import { Button, Callout, Field } from '../../lib/components/ui';

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
      loadError = errorMessage(err) ?? 'Impossible de charger les succès. Réessaie.';
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
      toast.success(m.aach_granted({ name: nameOf(target) }));
      userId = '';
      note = '';
    } catch (err) {
      toast.error(errorMessage(err) ?? m.aach_grant_error());
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
      toast.success(m.aach_revoked());
    } catch (err) {
      toast.error(errorMessage(err) ?? m.aach_revoke_error());
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

<AdminShell
  title="Succès attribués"
  description="Ces succès ne se calculent pas : ils récompensent une aide à Kotbo. Les administrateurs Kotbo ne les ont pas d'office."
>
  <AdminCard title="Attribuer un succès" icon="Award" tone="primary">
    <form class="grid gap-4 sm:grid-cols-2" onsubmit={(e) => { e.preventDefault(); void grant(); }}>
      <Field label="Identifiant Discord">
        {#snippet children(id)}
          <input {id} bind:value={userId} placeholder="123456789012345678" inputmode="numeric" class="input font-mono" />
        {/snippet}
      </Field>
      <Field label="Succès">
        {#snippet children(id)}
          <select {id} bind:value={achievementId} class="input">
            {#each manualAchievements as achievement (achievement.id)}
              <option value={achievement.id}>{achievement.label.fr}</option>
            {/each}
          </select>
        {/snippet}
      </Field>
      <Field label="Note (facultative, visible par l'équipe seulement)" class="sm:col-span-2">
        {#snippet children(id)}
          <input
            {id}
            bind:value={note}
            maxlength="300"
            placeholder="Ex. : doublon des annonces de raid signalé le 12 septembre"
            class="input"
          />
        {/snippet}
      </Field>
      <div class="sm:col-span-2">
        <Button
          type="submit"
          variant="primary"
          icon="Plus"
          loading={granting}
          disabled={!canGrant}
          disabledReason="Saisis un identifiant Discord valide (17 à 20 chiffres)."
        >
          Attribuer
        </Button>
      </div>
    </form>
  </AdminCard>

  {#if loadError}
    <Callout variant="danger">
      {loadError}
      {#snippet actions()}
        <Button size="sm" icon="RefreshCw" onclick={load}>Réessayer</Button>
      {/snippet}
    </Callout>
  {/if}

  {#if loading}
    <div class="h-40 animate-pulse rounded-2xl bg-on-surface/6"></div>
  {:else if !loadError}
    <div class="grid gap-4 lg:grid-cols-2">
      {#each manualAchievements as achievement (achievement.id)}
        {@const list = holders[achievement.id] ?? []}
        <AdminCard padded={false}>
          <div class="flex items-center gap-3 px-5 py-4 border-b border-outline-variant/20">
            <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/70">
              <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                <path d={RANK_CARD_BADGE_ICONS[achievement.icon]} fill="url(#admin-tier-{achievement.tier})" fill-rule="evenodd" />
              </svg>
            </span>
            <div class="min-w-0 flex-1">
              <h2 class="text-[15px] font-semibold text-on-surface flex items-center gap-2">
                {achievement.label.fr}
                <AdminBadge size="sm" label={String(list.length)} tone="primary" />
              </h2>
              <p class="text-xs text-on-surface-variant truncate">{achievement.description.fr}</p>
            </div>
          </div>

          {#if list.length === 0}
            <p class="px-5 py-4 text-body-sm text-on-surface-variant">Personne n'a encore ce succès.</p>
          {:else}
            <ul class="divide-y divide-outline-variant/20">
              {#each list as holder (holder.userId)}
                <li class="flex items-center gap-3 px-5 py-3">
                  {#if profiles[holder.userId]?.avatarUrl}
                    <img src={profiles[holder.userId].avatarUrl} alt="" class="w-8 h-8 rounded-full shrink-0" />
                  {:else}
                    <div class="w-8 h-8 rounded-full bg-on-surface/6 flex items-center justify-center shrink-0 text-on-surface-variant">
                      <Papicon icon="User" size={14} />
                    </div>
                  {/if}
                  <div class="min-w-0 flex-1">
                    <p class="text-body-sm text-on-surface truncate">
                      {nameOf(holder.userId)}
                      <span class="font-mono text-xs text-on-surface-variant">{holder.userId}</span>
                    </p>
                    <p class="text-xs text-on-surface-variant truncate">
                      {formatDate(holder.unlockedAt)}
                      {#if holder.grantedBy} · par {nameOf(holder.grantedBy)}{/if}
                      {#if holder.note} · {holder.note}{/if}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="danger"
                    icon="Trash2"
                    title="Retirer le succès"
                    aria-label="Retirer le succès"
                    loading={revoking === `${achievement.id}:${holder.userId}`}
                    onclick={() => revoke(achievement.id, holder)}
                  />
                </li>
              {/each}
            </ul>
          {/if}
        </AdminCard>
      {/each}
    </div>
  {/if}
</AdminShell>
