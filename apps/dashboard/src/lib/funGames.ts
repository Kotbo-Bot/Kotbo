/**
 * Les salons fun, décrits une seule fois : la page en tire ses cartes et le
 * compteur de salons actifs. Les textes restent dans la page (i18n).
 *
 * - score : Kotbo suit une partie (nombre, cible, dernier mot, rébus) qu'on relance d'ici.
 * - rule  : Kotbo fait respecter une règle et supprime les messages hors règle.
 */
export type FunGameGroup = 'score' | 'rule';

export type FunGameId =
  | 'counting' | 'guess' | 'wordchain' | 'emojiriddle'
  | 'oneword' | 'neversay' | 'emojionly' | 'imageofday';

export type FunChannelKey =
  | 'funCountingChannelId' | 'funGuessNumberChannelId' | 'funWordChainChannelId' | 'funEmojiRiddleChannelId'
  | 'funOneWordStoryChannelId' | 'funNeverSayChannelId' | 'funEmojiOnlyChannelId' | 'funImageOfDayChannelId';

export interface FunGame {
  id: FunGameId;
  group: FunGameGroup;
  channelKey: FunChannelKey;
  icon: string;
  /** Fond et couleur de la pastille d'icône. */
  tone: string;
  /** Kotbo garde un état de partie à afficher (nombre, dernier joueur, rébus). */
  tracked: boolean;
}

export const FUN_GAMES: readonly FunGame[] = [
  { id: 'counting', group: 'score', channelKey: 'funCountingChannelId', icon: 'Binary', tone: 'bg-warning/10 text-warning', tracked: true },
  { id: 'guess', group: 'score', channelKey: 'funGuessNumberChannelId', icon: 'Gamepad2', tone: 'bg-success/10 text-success', tracked: true },
  { id: 'wordchain', group: 'score', channelKey: 'funWordChainChannelId', icon: 'Link', tone: 'bg-sky-500/10 text-sky-500', tracked: true },
  { id: 'emojiriddle', group: 'score', channelKey: 'funEmojiRiddleChannelId', icon: 'Puzzle', tone: 'bg-error/10 text-error', tracked: true },
  { id: 'oneword', group: 'rule', channelKey: 'funOneWordStoryChannelId', icon: 'BookOpen', tone: 'bg-purple-500/10 text-purple-500', tracked: true },
  { id: 'neversay', group: 'rule', channelKey: 'funNeverSayChannelId', icon: 'MessageSquareOff', tone: 'bg-orange-500/10 text-orange-500', tracked: false },
  { id: 'emojionly', group: 'rule', channelKey: 'funEmojiOnlyChannelId', icon: 'Sticker', tone: 'bg-teal-500/10 text-teal-500', tracked: false },
  { id: 'imageofday', group: 'rule', channelKey: 'funImageOfDayChannelId', icon: 'Image', tone: 'bg-pink-500/10 text-pink-500', tracked: false },
];

export function gamesInGroup(group: FunGameGroup): FunGame[] {
  return FUN_GAMES.filter((game) => game.group === group);
}

export function activeGameCount(config: Partial<Record<FunChannelKey, string | null>>): number {
  return FUN_GAMES.filter((game) => !!config[game.channelKey]).length;
}
