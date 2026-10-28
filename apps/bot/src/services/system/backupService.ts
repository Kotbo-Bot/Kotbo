import type { Prisma } from '@prisma/client';
import { Guild } from 'discord.js';
import prisma from '../../utils/db.js';
import { fetchAllMembers } from '../../utils/discord.js';
import { exportKotboConfig, type KotboConfigData } from './kotboConfigBackup.js';

export interface BackupOptions {
  name: string;
  description?: string;
  includeMessages: boolean;
  includeMembers: boolean;
  includeRoles: boolean;
  includeChannels: boolean;
  includeEmojis: boolean;
  includeStickers: boolean;
  /** Configuration Kotbo (modules, staff, formulaires…). Incluse par défaut. */
  includeKotbo?: boolean;
  createdByUserId: string;
  createdByUsername: string;
  createdByTag?: string;
}

export interface BackupData {
  roles: RoleData[];
  channels: ChannelData[];
  members: MemberData[];
  emojis: EmojiData[];
  stickers: StickerData[];
  messages?: MessageData[];
  kotbo?: KotboConfigData;
}

export interface RoleData {
  id: string;
  name: string;
  color: number;
  hoist: boolean;
  position: number;
  permissions: string;
  mentionable: boolean;
  icon?: string | null;
  unicodeEmoji?: string | null;
}

export interface ChannelData {
  id: string;
  name: string;
  type: number;
  parentId?: string | null;
  position?: number;
  topic?: string | null;
  nsfw?: boolean;
  rateLimitPerUser?: number | null;
  bitrate?: number;
  userLimit?: number;
  permissionOverwrites?: OverwriteData[];
}

export interface OverwriteData {
  id: string;
  type: 'role' | 'member';
  allow: string;
  deny: string;
}

export interface MemberData {
  id: string;
  username: string;
  discriminator: string;
  displayName?: string;
  avatar?: string | null;
  roles: string[];
  joinedAt?: string | null;
  nick?: string | null;
}

export interface EmojiData {
  id: string;
  name: string;
  animated: boolean;
  available: boolean | null;
  url: string;
}

export interface StickerData {
  id: string;
  name: string;
  description?: string | null;
  tags: string | null;
  format: number;
  url: string;
}

export interface MessageData {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  timestamp: string;
  editedTimestamp?: string;
  attachments: string[];
  embeds: unknown[];
  reactions: ReactionData[];
}

export interface ReactionData {
  emoji: unknown;
  count: number;
}

export async function createBackup(guild: Guild, options: BackupOptions) {
  console.log(`[BackupService] Starting backup for guild: "${guild.name}" (${guild.id})`);
  const backupData: BackupData = {
    roles: [],
    channels: [],
    members: [],
    emojis: [],
    stickers: [],
  };

  let rolesCount = 0;
  let channelsCount = 0;
  let membersCount = 0;
  let messagesCount = 0;
  let emojisCount = 0;
  let stickersCount = 0;

  // Backup des rôles
  if (options.includeRoles) {
    console.log('[BackupService] Fetching roles...');
    backupData.roles = guild.roles.cache
      .filter((role) => role.id !== guild.id)
      .map((role) => ({
        id: role.id,
        name: role.name,
        color: role.color,
        hoist: role.hoist,
        position: role.position,
        permissions: role.permissions.bitfield.toString(),
        mentionable: role.mentionable,
        icon: role.icon,
        unicodeEmoji: role.unicodeEmoji,
      }));
    rolesCount = backupData.roles.length;
    console.log(`[BackupService] Roles fetched: ${rolesCount}`);
  }

  // Backup des salons
  if (options.includeChannels) {
    console.log('[BackupService] Fetching channels...');
    backupData.channels = guild.channels.cache.map((channel) => {
      const channelData: ChannelData = {
        id: channel.id,
        name: channel.name,
        type: channel.type,
        parentId: channel.parentId,
      };

      if ('position' in channel) channelData.position = channel.position;
      if ('topic' in channel) channelData.topic = channel.topic;
      if ('nsfw' in channel) channelData.nsfw = channel.nsfw;
      if ('rateLimitPerUser' in channel) channelData.rateLimitPerUser = channel.rateLimitPerUser;
      if ('bitrate' in channel) channelData.bitrate = channel.bitrate;
      if ('userLimit' in channel) channelData.userLimit = channel.userLimit;
      if ('permissionOverwrites' in channel) {
        channelData.permissionOverwrites = channel.permissionOverwrites.cache.map((overwrite) => ({
          id: overwrite.id,
          type: overwrite.type === 0 ? 'role' : 'member',
          allow: overwrite.allow.bitfield.toString(),
          deny: overwrite.deny.bitfield.toString(),
        }));
      }

      return channelData;
    });
    channelsCount = backupData.channels.length;
    console.log(`[BackupService] Channels fetched: ${channelsCount}`);
  }

  // Backup des membres
  if (options.includeMembers) {
    console.log('[BackupService] Fetching members from API...');
    try {
      // Fetch members reliably using the fetchAllMembers utility
      const members = await fetchAllMembers(guild);
      backupData.members = members.map((member) => ({
        id: member.id,
        username: member.user.username,
        discriminator: member.user.discriminator,
        displayName: member.displayName,
        avatar: member.user.avatar,
        roles: member.roles.cache.map((r) => r.id),
        joinedAt: member.joinedAt?.toISOString(),
        nick: member.nickname,
      }));
      console.log(`[BackupService] Members fetched successfully: ${backupData.members.length}`);
    } catch (err) {
      console.warn('[BackupService] Failed to fetch members via API, using cache fallback:', err);
      backupData.members = guild.members.cache.map((member) => ({
        id: member.id,
        username: member.user.username,
        discriminator: member.user.discriminator,
        displayName: member.displayName,
        avatar: member.user.avatar,
        roles: member.roles.cache.map((r) => r.id),
        joinedAt: member.joinedAt?.toISOString(),
        nick: member.nickname,
      }));
      console.log(`[BackupService] Cached members backup fallback completed: ${backupData.members.length}`);
    }
    membersCount = backupData.members.length;
  }

  // Backup des emojis
  if (options.includeEmojis) {
    console.log('[BackupService] Fetching emojis...');
    backupData.emojis = guild.emojis.cache.map((emoji) => ({
      id: emoji.id,
      name: emoji.name,
      animated: emoji.animated,
      available: emoji.available,
      url: emoji.url,
    }));
    emojisCount = backupData.emojis.length;
    console.log(`[BackupService] Emojis fetched: ${emojisCount}`);
  }

  // Backup des stickers
  if (options.includeStickers) {
    console.log('[BackupService] Fetching stickers (5s timeout)...');
    try {
      // Wrap stickers fetch in a promise race to enforce a 5s timeout
      const stickers = await Promise.race([
        guild.stickers.fetch(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout fetching stickers')), 5000))
      ]);
      backupData.stickers = stickers.map((sticker) => ({
        id: sticker.id,
        name: sticker.name,
        description: sticker.description,
        tags: sticker.tags,
        format: sticker.format,
        url: sticker.url,
      }));
      console.log(`[BackupService] Stickers fetched successfully: ${backupData.stickers.length}`);
    } catch (err) {
      console.warn('[BackupService] Failed to fetch stickers, using cache fallback:', err);
      backupData.stickers = guild.stickers.cache.map((sticker) => ({
        id: sticker.id,
        name: sticker.name,
        description: sticker.description,
        tags: sticker.tags,
        format: sticker.format,
        url: sticker.url,
      }));
      console.log(`[BackupService] Cached stickers backup fallback completed: ${backupData.stickers.length}`);
    }
    stickersCount = backupData.stickers.length;
  }

  // Backup des messages (optionnel et désactivé par défaut)
  if (options.includeMessages) {
    console.log('[BackupService] Fetching messages from channels...');
    backupData.messages = [];
    const textChannels = guild.channels.cache.filter((c) => c.isTextBased());
    for (const [_channelId, channel] of textChannels) {
      try {
        const fetchedMessages = await channel.messages.fetch({ limit: 50 });
        for (const [_msgId, msg] of fetchedMessages) {
          if (msg.content || msg.embeds.length > 0 || msg.attachments.size > 0) {
            backupData.messages.push({
              id: msg.id,
              channelId: msg.channelId,
              authorId: msg.author.id,
              content: msg.content,
              timestamp: msg.createdAt.toISOString(),
              editedTimestamp: msg.editedAt?.toISOString() || undefined,
              attachments: msg.attachments.map((a) => a.url),
              embeds: msg.embeds.map((e) => e.toJSON()),
              reactions: msg.reactions.cache.map((r) => ({
                emoji: r.emoji.id ? { id: r.emoji.id, name: r.emoji.name } : r.emoji.name,
                count: r.count,
              })),
            });
          }
        }
      } catch (error) {
        console.error(`[BackupService] Impossible de sauvegarder les messages du salon ${channel.name}:`, error);
      }
    }
    messagesCount = backupData.messages.length;
    console.log(`[BackupService] Messages fetched: ${messagesCount}`);
  }

  if (options.includeKotbo !== false) {
    backupData.kotbo = await exportKotboConfig(guild.id);
  }

  // Calculer la taille du backup
  console.log('[BackupService] Serializing data and writing to database...');
  const dataString = JSON.stringify(backupData);
  const sizeBytes = Buffer.byteLength(dataString, 'utf8');

  // Sauvegarder dans la base de données
  try {
    const backup = await prisma.serverBackup.create({
      data: {
        guildId: guild.id,
        name: options.name,
        description: options.description,
        data: backupData as unknown as Prisma.InputJsonValue,
        includeMessages: options.includeMessages,
        includeMembers: options.includeMembers,
        includeRoles: options.includeRoles,
        includeChannels: options.includeChannels,
        includeEmojis: options.includeEmojis,
        includeStickers: options.includeStickers,
        createdByUserId: options.createdByUserId,
        createdByUsername: options.createdByUsername,
        createdByTag: options.createdByTag,
        serverName: guild.name,
        serverIcon: guild.iconURL(),
        sizeBytes,
        rolesCount,
        channelsCount,
        membersCount,
        messagesCount,
        emojisCount,
        stickersCount,
      },
    });
    console.log(`[BackupService] Backup created successfully in DB with ID: ${backup.id}`);
    return backup;
  } catch (dbError) {
    console.error('[BackupService] Database write error during backup creation:', dbError);
    throw dbError;
  }
}
