/**
 * Permissions qu'une action demande au bot dans le salon où elle agit.
 *
 * Sans dépendance à discord.js : les noms reprennent ceux de
 * `PermissionFlagsBits`, que `effects.ts` traduit. Le contrôle sert deux fois :
 * avant chaque vraie action, pour nommer la permission manquante au lieu de
 * l'erreur opaque de Discord, et pendant l'essai à blanc, pour prévenir avant
 * le vrai échec.
 */

export type BotPermission =
  | 'ViewChannel'
  | 'SendMessages'
  | 'SendMessagesInThreads'
  | 'EmbedLinks'
  | 'ReadMessageHistory'
  | 'AddReactions'
  | 'ManageMessages'
  | 'CreatePublicThreads'
  | 'ManageChannels'
  | 'ManageNicknames';

export const PERMISSION_LABELS: Record<BotPermission, string> = {
  ViewChannel: 'Voir le salon',
  SendMessages: 'Envoyer des messages',
  SendMessagesInThreads: 'Envoyer des messages dans les fils',
  EmbedLinks: 'Intégrer des liens',
  ReadMessageHistory: 'Voir les anciens messages',
  AddReactions: 'Ajouter des réactions',
  ManageMessages: 'Gérer les messages',
  CreatePublicThreads: 'Créer des fils publics',
  ManageChannels: 'Gérer les salons',
  ManageNicknames: 'Gérer les pseudos',
};

/**
 * Salon visé : celui passé à l'action, celui du message passé, ou le salon de
 * logs configuré pour le serveur.
 */
export type ChannelTarget = 'channel' | 'message' | 'logs';

export interface ChannelRequirement {
  target: ChannelTarget;
  permissions: BotPermission[];
}

const WRITE: BotPermission[] = ['ViewChannel', 'SendMessages'];

export const CHANNEL_REQUIREMENTS: Partial<Record<string, ChannelRequirement>> = {
  SendMessage: { target: 'channel', permissions: WRITE },
  SendEmbed: { target: 'channel', permissions: [...WRITE, 'EmbedLinks'] },
  CreateThread: { target: 'channel', permissions: ['ViewChannel', 'CreatePublicThreads'] },
  ReplyToMessage: { target: 'message', permissions: [...WRITE, 'ReadMessageHistory'] },
  AddReaction: { target: 'message', permissions: ['ViewChannel', 'ReadMessageHistory', 'AddReactions'] },
  DeleteMessage: { target: 'message', permissions: ['ViewChannel', 'ManageMessages'] },
  PinMessage: { target: 'message', permissions: ['ViewChannel', 'ReadMessageHistory', 'ManageMessages'] },
  SendLogMessage: { target: 'logs', permissions: [...WRITE, 'EmbedLinks'] },
};

/**
 * Permissions demandées sur tout le serveur. Les sanctions n'y figurent pas :
 * `kickable`, `bannable` et `moderatable` contrôlent déjà la permission et la
 * hiérarchie ensemble.
 */
export const GUILD_REQUIREMENTS: Partial<Record<string, BotPermission[]>> = {
  CreateTicket: ['ManageChannels'],
  SetNickname: ['ManageNicknames'],
};

/**
 * Dans un fil, Discord demande « Envoyer des messages dans les fils » et non
 * « Envoyer des messages » : un forum peut accorder l'une sans l'autre.
 */
export function inThread(permissions: readonly BotPermission[]): BotPermission[] {
  return permissions.map((permission) => (permission === 'SendMessages' ? 'SendMessagesInThreads' : permission));
}

export function missingPermissions(
  required: readonly BotPermission[],
  has: (permission: BotPermission) => boolean,
): BotPermission[] {
  return required.filter((permission) => !has(permission));
}

/** `channelName` nul pour une permission demandée sur tout le serveur. */
export function describeMissingPermissions(missing: readonly BotPermission[], channelName: string | null): string {
  const names = missing.map((permission) => `« ${PERMISSION_LABELS[permission]} »`).join(', ');
  return `il manque au bot ${names} ${channelName === null ? 'sur le serveur' : `dans #${channelName}`}`;
}
