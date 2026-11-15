<script lang="ts">
  /**
   * Aperçu des deux annonces d'une saison, construites par la même fonction
   * que celles du bot (`@kotbo/shared`). Le podium de clôture est fictif.
   */
  import {
    planSeasonRewards,
    seasonEndAnnouncement,
    seasonStartAnnouncement,
    type SeasonAnnouncementLabels,
    type SeasonReward,
  } from '@kotbo/shared';
  import { m } from '../../i18n';
  import Papicon from '../Papicon.svelte';
  import DiscordEmbedPreview from '../DiscordEmbedPreview.svelte';

  const {
    labels,
    season,
    rewards,
    topRoleId,
    roleName,
  }: {
    labels: SeasonAnnouncementLabels;
    season: { number: number; name: string; endDate: string };
    rewards: readonly SeasonReward[];
    topRoleId: string | null;
    roleName: (roleId: string) => string;
  } = $props();

  const SAMPLE_XP = [1_240, 980, 655];

  const intl = $derived(labels.locale === 'fr' ? 'fr-FR' : 'en-US');
  const format = (value: number) => value.toLocaleString(intl);
  const named = (reward: { roleId: string | null; coins: number }) => ({
    role: reward.roleId ? `@${roleName(reward.roleId)}` : null,
    coins: reward.coins > 0 ? format(reward.coins) : null,
  });

  const sample = $derived(SAMPLE_XP.map((xp, index) => ({ userId: String(index + 1), rank: index + 1, xp })));
  const member = (rank: number) => `@${m.sea_preview_member({ rank })}`;

  const start = $derived(seasonStartAnnouncement(
    labels,
    {
      number: season.number,
      name: season.name || m.sea_name_ph(),
      date: season.endDate ? new Date(season.endDate).toLocaleDateString(intl, { day: 'numeric', month: 'long', year: 'numeric' }) : '-',
    },
    rewards.map((reward) => ({ rank: reward.rank, ...named(reward) })),
    topRoleId ? `@${roleName(topRoleId)}` : null,
  ));

  const end = $derived(seasonEndAnnouncement(
    labels,
    { number: season.number, name: season.name || m.sea_name_ph() },
    sample.map((entry) => ({ rank: entry.rank, user: member(entry.rank), xp: format(entry.xp) })),
    planSeasonRewards(rewards, sample, topRoleId).map((entry) => ({ user: member(entry.rank), ...named(entry) })),
  ));
</script>

<div class="space-y-3">
  <p class="text-xs font-semibold text-on-surface-variant flex items-center gap-1.5"><Papicon icon="Eye" size={13} /> {m.sea_preview_start()}</p>
  <DiscordEmbedPreview title={start.title} body={start.description} />
  <p class="text-xs font-semibold text-on-surface-variant flex items-center gap-1.5"><Papicon icon="Eye" size={13} /> {m.sea_preview_end()}</p>
  <DiscordEmbedPreview title={end.title} body={end.description} />
</div>
