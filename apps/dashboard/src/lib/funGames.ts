/**
 * Les salons fun, décrits une seule fois : la page en tire ses réglages,
 * l'état du module et la liste des salons actifs. Les textes restent dans la
 * page (i18n). L'ordre est celui de l'affichage : les jeux à score (dont on
 * suit et relance la partie), puis les salons à règle.
 */
export type FunGameId =
  | 'counting' | 'guess' | 'wordchain' | 'emojiriddle'
  | 'oneword' | 'neversay' | 'emojionly' | 'imageofday';

export type FunChannelKey =
  | 'funCountingChannelId' | 'funGuessNumberChannelId' | 'funWordChainChannelId' | 'funEmojiRiddleChannelId'
  | 'funOneWordStoryChannelId' | 'funNeverSayChannelId' | 'funEmojiOnlyChannelId' | 'funImageOfDayChannelId';

export interface FunGame {
  id: FunGameId;
  channelKey: FunChannelKey;
  icon: string;
  /** Fond et couleur de la pastille d'icône. */
  tone: string;
}

export const FUN_GAMES: readonly FunGame[] = [
  { id: 'counting', channelKey: 'funCountingChannelId', icon: 'Binary', tone: 'bg-warning/10 text-on-warning-container' },
  { id: 'guess', channelKey: 'funGuessNumberChannelId', icon: 'Gamepad2', tone: 'bg-success/10 text-on-success-container' },
  { id: 'wordchain', channelKey: 'funWordChainChannelId', icon: 'Link', tone: 'bg-sky-500/10 text-sky-500' },
  { id: 'emojiriddle', channelKey: 'funEmojiRiddleChannelId', icon: 'Puzzle', tone: 'bg-error/10 text-on-error-container' },
  { id: 'oneword', channelKey: 'funOneWordStoryChannelId', icon: 'BookOpen', tone: 'bg-purple-500/10 text-purple-500' },
  { id: 'neversay', channelKey: 'funNeverSayChannelId', icon: 'MessageSquareOff', tone: 'bg-orange-500/10 text-orange-500' },
  { id: 'emojionly', channelKey: 'funEmojiOnlyChannelId', icon: 'Sticker', tone: 'bg-teal-500/10 text-teal-500' },
  { id: 'imageofday', channelKey: 'funImageOfDayChannelId', icon: 'Image', tone: 'bg-pink-500/10 text-pink-500' },
];

/** Jeux dont le salon est choisi, dans l'ordre de FUN_GAMES. */
export function activeGames(config: Partial<Record<FunChannelKey, string | null>>): FunGame[] {
  return FUN_GAMES.filter((game) => !!config[game.channelKey]);
}
