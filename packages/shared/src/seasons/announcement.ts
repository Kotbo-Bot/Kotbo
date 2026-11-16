/**
 * Texte des annonces de saison, partagé entre le bot (message envoyé) et le
 * dashboard (aperçu). Les gabarits viennent du bot dans la langue du serveur ;
 * les valeurs arrivent déjà mises en forme (mentions côté bot, noms lisibles
 * côté aperçu).
 */

export const SEASON_PODIUM_SIZE = 3;

/** Gabarits à trous : `{number}`, `{name}`, `{date}`, `{role}`, `{coins}`, `{rank}`, `{user}`, `{xp}`. */
export interface SeasonAnnouncementLabels {
  locale: string;
  startTitle: string;
  startBody: string;
  rewardsHeading: string;
  topRoleLine: string;
  rewardCoins: string;
  endTitle: string;
  endLine: string;
  endEmpty: string;
  rewardsGivenHeading: string;
}

export interface SeasonAnnouncementText {
  title: string;
  description: string;
}

/** Une récompense déjà nommée : rôle (mention ou nom) et montant formaté, chacun facultatif. */
export interface NamedSeasonReward {
  role: string | null;
  coins: string | null;
}

export function fillSeasonTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (marker, key: string) => (key in values ? String(values[key]) : marker));
}

function rewardText(labels: SeasonAnnouncementLabels, reward: NamedSeasonReward): string {
  return [
    reward.role,
    reward.coins ? fillSeasonTemplate(labels.rewardCoins, { coins: reward.coins }) : null,
  ].filter(Boolean).join(' + ');
}

export function seasonStartAnnouncement(
  labels: SeasonAnnouncementLabels,
  season: { number: number; name: string; date: string },
  rewards: ReadonlyArray<NamedSeasonReward & { rank: number }>,
  topRole: string | null,
): SeasonAnnouncementText {
  const lines = [fillSeasonTemplate(labels.startBody, { date: season.date })];
  if (rewards.length > 0 || topRole) {
    lines.push('', `**${labels.rewardsHeading}**`);
    if (topRole) lines.push(fillSeasonTemplate(labels.topRoleLine, { role: topRole }));
    for (const reward of rewards) lines.push(`#${reward.rank} · ${rewardText(labels, reward)}`);
  }
  return {
    title: fillSeasonTemplate(labels.startTitle, { number: season.number, name: season.name }),
    description: lines.join('\n'),
  };
}

export function seasonEndAnnouncement(
  labels: SeasonAnnouncementLabels,
  season: { number: number; name: string },
  standings: ReadonlyArray<{ rank: number; user: string; xp: string }>,
  given: ReadonlyArray<NamedSeasonReward & { user: string }>,
): SeasonAnnouncementText {
  const title = fillSeasonTemplate(labels.endTitle, { number: season.number, name: season.name });
  if (standings.length === 0) return { title, description: labels.endEmpty };

  const lines = standings.slice(0, SEASON_PODIUM_SIZE).map((entry) => fillSeasonTemplate(labels.endLine, entry));
  if (given.length > 0) {
    lines.push('', `**${labels.rewardsGivenHeading}**`);
    for (const entry of given) lines.push(`${entry.user} · ${rewardText(labels, entry)}`);
  }
  return { title, description: lines.join('\n') };
}

/**
 * Classement fictif de l'aperçu de clôture : le podium, prolongé jusqu'au
 * dernier rang récompensé pour que chaque récompense y trouve un gagnant.
 */
export function sampleSeasonStandings(rewards: ReadonlyArray<{ rank: number }>): Array<{ userId: string; rank: number; xp: number }> {
  const size = Math.max(SEASON_PODIUM_SIZE, ...rewards.map((reward) => reward.rank));
  return Array.from({ length: size }, (_, index) => ({ userId: String(index + 1), rank: index + 1, xp: (size - index) * 120 }));
}
