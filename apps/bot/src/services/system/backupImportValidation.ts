import { z } from 'zod';
import type { BackupData } from './backupService.js';

export const MAX_BACKUP_IMPORT_BYTES = 8 * 1024 * 1024;
export const SUPPORTED_BACKUP_VERSION = '1.0';

const snowflake = z.string().regex(/^\d{17,20}$/, 'ID Discord invalide');
const nullableUrl = z.string().url().max(2_048).nullable().optional();
const permissionBits = z.string().regex(/^\d{1,30}$/, 'Permissions invalides');

const overwriteSchema = z.object({
  id: snowflake,
  type: z.enum(['role', 'member']),
  allow: permissionBits,
  deny: permissionBits,
}).strict();

const roleSchema = z.object({
  id: snowflake,
  name: z.string().trim().min(1).max(100),
  color: z.number().int().min(0).max(0xFFFFFF),
  hoist: z.boolean(),
  position: z.number().int().min(0).max(10_000),
  permissions: permissionBits,
  mentionable: z.boolean(),
  icon: nullableUrl,
  unicodeEmoji: z.string().max(100).nullable().optional(),
}).strict();

const channelSchema = z.object({
  id: snowflake,
  name: z.string().trim().min(1).max(100),
  type: z.number().int().refine(
    (value) => [0, 2, 4, 5, 13, 14, 15, 16].includes(value),
    'Type de salon non pris en charge',
  ),
  parentId: snowflake.nullable().optional(),
  position: z.number().int().min(0).max(10_000).optional(),
  topic: z.string().max(4_096).nullable().optional(),
  nsfw: z.boolean().optional(),
  rateLimitPerUser: z.number().int().min(0).max(21_600).nullable().optional(),
  bitrate: z.number().int().min(8_000).max(384_000).optional(),
  userLimit: z.number().int().min(0).max(99).optional(),
  permissionOverwrites: z.array(overwriteSchema).max(1_000).optional(),
}).strict();

const memberSchema = z.object({
  id: snowflake,
  username: z.string().min(1).max(100),
  discriminator: z.string().max(4),
  displayName: z.string().max(100).optional(),
  avatar: nullableUrl,
  roles: z.array(snowflake).max(500),
  joinedAt: z.string().datetime().nullable().optional(),
  nick: z.string().max(32).nullable().optional(),
}).strict();

const discordCdnUrl = z.string().url().max(2_048).refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && [
      'cdn.discordapp.com',
      'media.discordapp.net',
      'cdn.discord.com',
    ].includes(parsed.hostname);
  } catch {
    return false;
  }
}, 'Le média doit provenir du CDN Discord');

const emojiSchema = z.object({
  id: snowflake,
  name: z.string().trim().min(1).max(32),
  animated: z.boolean(),
  available: z.boolean().nullable(),
  url: discordCdnUrl,
}).strict();

const stickerSchema = z.object({
  id: snowflake,
  name: z.string().trim().min(2).max(30),
  description: z.string().max(100).nullable().optional(),
  tags: z.string().max(200).nullable(),
  format: z.number().int().min(1).max(4),
  url: discordCdnUrl,
}).strict();

const reactionSchema = z.object({
  emoji: z.unknown(),
  count: z.number().int().min(0).max(1_000_000),
}).strict();

const messageSchema = z.object({
  id: snowflake,
  channelId: snowflake,
  authorId: snowflake,
  content: z.string().max(2_000),
  timestamp: z.string().datetime(),
  editedTimestamp: z.string().datetime().optional(),
  attachments: z.array(z.string().url().max(2_048)).max(10),
  embeds: z.array(z.record(z.unknown())).max(10),
  reactions: z.array(reactionSchema).max(20),
}).strict();

const backupDataSchema = z.object({
  roles: z.array(roleSchema).max(500),
  channels: z.array(channelSchema).max(1_000),
  members: z.array(memberSchema).max(100_000),
  emojis: z.array(emojiSchema).max(500),
  stickers: z.array(stickerSchema).max(100),
  messages: z.array(messageSchema).max(25_000).optional(),
  // Accepté pour relire nos propres exports, mais jamais conservé : une config Kotbo
  // venue d'un fichier pourrait viser les lignes d'un autre serveur.
  kotbo: z.unknown().optional(),
}).strict();

const optionsSchema = z.object({
  includeMessages: z.boolean().optional(),
  includeMembers: z.boolean().optional(),
  includeRoles: z.boolean().optional(),
  includeChannels: z.boolean().optional(),
  includeEmojis: z.boolean().optional(),
  includeStickers: z.boolean().optional(),
}).strict();

const importedBackupSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(1_000).nullable().optional(),
  serverName: z.string().trim().min(1).max(100).optional(),
  serverIcon: nullableUrl,
  data: backupDataSchema,
  options: optionsSchema.optional(),
  // Ces compteurs restent acceptés pour la compatibilité des exports, mais ils
  // ne sont jamais crus : ils sont recalculés depuis `data` plus bas.
  stats: z.object({
    rolesCount: z.number().int().nonnegative().optional(),
    channelsCount: z.number().int().nonnegative().optional(),
    membersCount: z.number().int().nonnegative().optional(),
    messagesCount: z.number().int().nonnegative().optional(),
    emojisCount: z.number().int().nonnegative().optional(),
    stickersCount: z.number().int().nonnegative().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
  }).strict().optional(),
  createdByUserId: z.string().optional(),
  createdByUsername: z.string().optional(),
  createdByTag: z.string().optional(),
  createdAt: z.string().or(z.date()).optional(),
}).strict();

const importSchema = z.object({
  version: z.literal(SUPPORTED_BACKUP_VERSION),
  exportedAt: z.string().datetime().optional(),
  backup: importedBackupSchema,
}).strict();

export type ValidatedBackupImport = {
  name?: string;
  description?: string | null;
  serverName?: string;
  serverIcon?: string | null;
  data: BackupData;
  options: {
    includeMessages: boolean;
    includeMembers: boolean;
    includeRoles: boolean;
    includeChannels: boolean;
    includeEmojis: boolean;
    includeStickers: boolean;
  };
  stats: {
    rolesCount: number;
    channelsCount: number;
    membersCount: number;
    messagesCount: number;
    emojisCount: number;
    stickersCount: number;
    sizeBytes: number;
  };
};

export function parseBackupImport(rawJson: string): ValidatedBackupImport {
  const sizeBytes = Buffer.byteLength(rawJson, 'utf8');
  if (sizeBytes > MAX_BACKUP_IMPORT_BYTES) {
    throw new Error(`Le fichier dépasse la taille maximale de ${MAX_BACKUP_IMPORT_BYTES / 1024 / 1024} Mo.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('Le fichier JSON est invalide.');
  }

  const result = importSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const location = issue?.path.length ? ` (${issue.path.join('.')})` : '';
    throw new Error(`Structure de sauvegarde invalide${location} : ${issue?.message ?? 'format incorrect'}.`);
  }

  const backup = result.data.backup;
  const { kotbo: _kotbo, ...data } = backup.data as BackupData;
  return {
    name: backup.name,
    description: backup.description,
    serverName: backup.serverName,
    serverIcon: backup.serverIcon,
    data,
    options: {
      includeMessages: backup.options?.includeMessages === true && (data.messages?.length ?? 0) > 0,
      includeMembers: backup.options?.includeMembers !== false && data.members.length > 0,
      includeRoles: backup.options?.includeRoles !== false && data.roles.length > 0,
      includeChannels: backup.options?.includeChannels !== false && data.channels.length > 0,
      includeEmojis: backup.options?.includeEmojis !== false && data.emojis.length > 0,
      includeStickers: backup.options?.includeStickers !== false && data.stickers.length > 0,
    },
    stats: {
      rolesCount: data.roles.length,
      channelsCount: data.channels.length,
      membersCount: data.members.length,
      messagesCount: data.messages?.length ?? 0,
      emojisCount: data.emojis.length,
      stickersCount: data.stickers.length,
      sizeBytes,
    },
  };
}
