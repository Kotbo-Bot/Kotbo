<script lang="ts">
  /**
   * Aperçu des deux annonces d'une saison, construites par la même fonction
   * que celles du bot (`@kotbo/shared`). Le classement de clôture est fictif
   * et va jusqu'au dernier rang récompensé.
   */
  import {
    planSeasonRewards,
    sampleSeasonStandings,
    seasonEndAnnouncement,
    seasonReminderAnnouncement,
    seasonStartAnnouncement,
    type SeasonAnnouncementLabels,
    type SeasonReward,
    type SeasonTierReward,
  } from '@kotbo/shared';
  import { m } from '../../i18n';
  import Papicon from '../Papicon.svelte';
  import DiscordEmbedPreview from '../DiscordEmbedPreview.svelte';

  const {
    labels,
    season,
    rewards,
    tiers = [],
    topRoleId,
    reminder = false,
    roleName,
  }: {
    labels: SeasonAnnouncementLabels;
    season: { number: number; name: string; endDate: string };
    rewards: readonly SeasonReward[];
    tiers?: readonly SeasonTierReward[];
    topRoleId: string | null;
    /** Montrer aussi le rappel des dernières 24 h. */
    reminder?: boolean;
    roleName: (roleId: string) => string;
  } = $props();

  const intl = $derived(labels.locale === 'fr' ? 'fr-FR' : 'en-US');
  const format = (value: number) => value.toLocaleString(intl);
  const named = (reward: { roleId: string | null; coins: number }) => ({
    role: reward.roleId ? `@${roleName(reward.roleId)}` : null,
    coins: reward.coins > 0 ? format(reward.coins) : null,
  });

  const sample = $derived(sampleSeasonStandings(rewards));
  const endLabel = $derived(season.endDate ? new Date(season.endDate).toLocaleDateString(intl, { day: 'numeric', month: 'long', year: 'numeric' }) : '-');
  const member = (rank: number) => `@${m.sea_preview_member({ rank })}`;

  const start = $derived(seasonStartAnnouncement(
    labels,
    {
      number: season.number,
      name: season.name || m.sea_name_ph(),
      date: endLabel,
    },
    rewards.map((reward) => ({ rank: reward.rank, ...named(reward) })),
    topRoleId ? `@${roleName(topRoleId)}` : null,
    tiers.map((tier) => ({ xp: format(tier.minXp), ...named(tier) })),
  ));

  const podium = $derived(sample.map((entry) => ({ rank: entry.rank, user: member(entry.rank), xp: format(entry.xp) })));

  const reminderText = $derived(seasonReminderAnnouncement(
    labels,
    { number: season.number, name: season.name || m.sea_name_ph(), date: endLabel },
    podium,
  ));

  const end = $derived(seasonEndAnnouncement(
    labels,
    { number: season.number, name: season.name || m.sea_name_ph() },
    podium,
    planSeasonRewards(rewards, sample, topRoleId).map((entry) => ({ user: member(entry.rank), ...named(entry) })),
  ));
</script>

<div class="space-y-3">
  <p class="text-xs font-semibold text-on-surface-variant flex items-center gap-1.5"><Papicon icon="Eye" size={13} /> {m.sea_preview_start()}</p>
  <DiscordEmbedPreview title={start.title} body={start.description} />
  {#if reminder}
    <p class="text-xs font-semibold text-on-surface-variant flex items-center gap-1.5"><Papicon icon="Eye" size={13} /> {m.sea_preview_reminder()}</p>
    <DiscordEmbedPreview title={reminderText.title} body={reminderText.description} />
  {/if}
  <p class="text-xs font-semibold text-on-surface-variant flex items-center gap-1.5"><Papicon icon="Eye" size={13} /> {m.sea_preview_end()}</p>
  <DiscordEmbedPreview title={end.title} body={end.description} />
</div>
