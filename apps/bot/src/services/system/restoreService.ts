import { type APIEmbed, Guild, Role, ButtonStyle, ActionRowBuilder, ButtonBuilder, EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';

import { BackupData, RoleData, ChannelData, MemberData, EmojiData, StickerData , type MessageData } from './backupService.js';
import { fetchExternal } from '../../utils/http.js';
import { restoreKotboConfig } from './kotboConfigBackup.js';

export interface RestoreOptions {
  fullRestore: boolean;
  includeRoles: boolean;
  includeChannels: boolean;
  includeMembers: boolean;
  includeEmojis: boolean;
  includeStickers: boolean;
  includeMessages: boolean;
  /** Uniquement pour une sauvegarde créée par le bot sur ce même serveur. */
  includeKotbo?: boolean;
  conflictResolution: 'ask' | 'ignore' | 'replace' | 'replace_all';
}

export interface ConflictResolution {
  decision: 'ignore' | 'replace';
  applyToAll: boolean;
}

/**
 * Restaure un backup avec gestion des conflits
 */
export async function restoreBackup(
  guild: Guild,
  backupData: BackupData,
  options: RestoreOptions,
  interaction?: ChatInputCommandInteraction,
): Promise<void> {
  console.log(`🔄 Début de la restauration pour le serveur ${guild.name}...`);

  const roleIdMap = new Map<string, string>();
  const channelIdMap = new Map<string, string>();

  // Restaurer les rôles
  if (options.includeRoles && backupData.roles && backupData.roles.length > 0) {
    await restoreRoles(guild, backupData.roles, options.conflictResolution, roleIdMap, interaction);
  }

  // Restaurer les emojis
  if (options.includeEmojis && backupData.emojis && backupData.emojis.length > 0) {
    await restoreEmojis(guild, backupData.emojis);
  }

  // Restaurer les stickers
  if (options.includeStickers && backupData.stickers && backupData.stickers.length > 0) {
    await restoreStickers(guild, backupData.stickers);
  }

  // Restaurer les salons
  if (options.includeChannels && backupData.channels && backupData.channels.length > 0) {
    await restoreChannels(guild, backupData.channels, options.conflictResolution, roleIdMap, channelIdMap, interaction);
  }

  // Restaurer les membres
  if (options.includeMembers && backupData.members && backupData.members.length > 0) {
    await restoreMembers(guild, backupData.members, options, roleIdMap);
  }

  // Restaurer les messages (optionnel)
  if (options.includeMessages && backupData.messages && backupData.messages.length > 0) {
    await restoreMessages(guild, backupData.messages, channelIdMap);
  }

  // En dernier : la config pointe vers des rôles et salons qui viennent peut-être d'être recréés.
  if (options.includeKotbo && backupData.kotbo) {
    const { restored, failed } = await restoreKotboConfig(guild.id, backupData.kotbo, new Map([...roleIdMap, ...channelIdMap]));
    console.log(`⚙️ Configuration Kotbo restaurée : ${restored} éléments, ${failed} échecs`);
  }

  console.log(`✅ Restauration terminée pour le serveur ${guild.name}`);
}

/**
 * Restaure les rôles
 */
async function restoreRoles(
  guild: Guild,
  roles: RoleData[],
  conflictResolution: RestoreOptions['conflictResolution'],
  roleIdMap: Map<string, string>,
  interaction?: ChatInputCommandInteraction,
): Promise<void> {
  console.log(`🔄 Restauration de ${roles.length} rôles...`);

  let currentResolution = conflictResolution;

  for (const roleData of roles) {
    try {
      // Vérifier si un rôle avec le même nom existe déjà
      const existingRole = guild.roles.cache.find((r) => r.name === roleData.name);

      if (existingRole) {
        if (currentResolution === 'ignore') {
          console.log(`⏭️ Rôle ignoré: ${roleData.name}`);
          roleIdMap.set(roleData.id, existingRole.id);
          continue;
        }

        if (currentResolution === 'ask' && interaction) {
          const resolution = await askConflictResolution(
            interaction,
            'role',
            roleData.name,
            'Un rôle avec ce nom existe déjà',
          );

          if (resolution.decision === 'ignore') {
            console.log(`⏭️ Rôle ignoré: ${roleData.name}`);
            roleIdMap.set(roleData.id, existingRole.id);
            continue;
          }

          if (resolution.applyToAll) {
            currentResolution = 'replace_all';
          }
        }

        // Mettre à jour le rôle existant
        await existingRole.edit({
          color: roleData.color,
          hoist: roleData.hoist,
          position: roleData.position,
          permissions: BigInt(roleData.permissions),
          mentionable: roleData.mentionable,
          icon: roleData.icon || null,
          unicodeEmoji: roleData.unicodeEmoji || null,
        });
        roleIdMap.set(roleData.id, existingRole.id);
        console.log(`✏️ Rôle mis à jour: ${roleData.name}`);
      } else {
        // Créer un nouveau rôle
        const newRole = await guild.roles.create({
          name: roleData.name,
          color: roleData.color,
          hoist: roleData.hoist,
          position: roleData.position,
          permissions: BigInt(roleData.permissions),
          mentionable: roleData.mentionable,
          icon: roleData.icon || undefined,
          unicodeEmoji: roleData.unicodeEmoji || undefined,
        });
        roleIdMap.set(roleData.id, newRole.id);
        console.log(`✅ Rôle créé: ${roleData.name}`);
      }
    } catch (error) {
      console.error(`❌ Erreur lors de la restauration du rôle ${roleData.name}:`, error);
    }
  }
}

/**
 * Restaure les emojis
 */
async function restoreEmojis(guild: Guild, emojis: EmojiData[]): Promise<void> {
  console.log(`🔄 Restauration de ${emojis.length} emojis...`);

  for (const emojiData of emojis) {
    try {
      // Vérifier si l'emoji existe déjà
      const existingEmoji = guild.emojis.cache.find((e) => e.name === emojiData.name);

      if (existingEmoji) {
        console.log(`⏭️ Emoji déjà existant: ${emojiData.name}`);
        continue;
      }

      // Télécharger et créer l'emoji
      const response = await fetchExternal(emojiData.url, {}, 15_000);
      const buffer = Buffer.from(await response.arrayBuffer());

      await guild.emojis.create({
        attachment: buffer,
        name: emojiData.name,
      });
      console.log(`✅ Emoji créé: ${emojiData.name}`);
    } catch (error) {
      console.error(`❌ Erreur lors de la restauration de l'emoji ${emojiData.name}:`, error);
    }
  }
}

/**
 * Restaure les stickers
 */
async function restoreStickers(guild: Guild, stickers: StickerData[]): Promise<void> {
  console.log(`🔄 Restauration de ${stickers.length} stickers...`);

  for (const stickerData of stickers) {
    try {
      // Vérifier si le sticker existe déjà
      const existingSticker = guild.stickers.cache.find((s) => s.name === stickerData.name);

      if (existingSticker) {
        console.log(`⏭️ Sticker déjà existant: ${stickerData.name}`);
        continue;
      }

      // Télécharger et créer le sticker
      const response = await fetchExternal(stickerData.url, {}, 15_000);
      const buffer = Buffer.from(await response.arrayBuffer());

      const tagsString = stickerData.tags 
        ? (Array.isArray(stickerData.tags) ? stickerData.tags.join(',') : stickerData.tags)
        : '';

      await guild.stickers.create({
        file: buffer,
        name: stickerData.name,
        description: stickerData.description || undefined,
        tags: tagsString,
      });
      console.log(`✅ Sticker créé: ${stickerData.name}`);
    } catch (error) {
      console.error(`❌ Erreur lors de la restauration du sticker ${stickerData.name}:`, error);
    }
  }
}

/**
 * Restaure les salons
 */
async function restoreChannels(
  guild: Guild,
  channels: ChannelData[],
  conflictResolution: RestoreOptions['conflictResolution'],
  roleIdMap: Map<string, string>,
  channelIdMap: Map<string, string>,
  interaction?: ChatInputCommandInteraction,
): Promise<void> {
  console.log(`🔄 Restauration de ${channels.length} salons...`);

  // Trier les salons par position
  const sortedChannels = [...channels].sort((a, b) => (a.position || 0) - (b.position || 0));

  // D'abord restaurer les catégories (type = 4)
  const categories = sortedChannels.filter((c) => c.type === 4);
  for (const categoryData of categories) {
    await restoreChannel(guild, categoryData, conflictResolution, roleIdMap, channelIdMap, interaction);
  }

  // Ensuite restaurer les autres salons
  const otherChannels = sortedChannels.filter((c) => c.type !== 4);
  for (const channelData of otherChannels) {
    await restoreChannel(guild, channelData, conflictResolution, roleIdMap, channelIdMap, interaction);
  }
}

/**
 * Restaure un salon individuel
 */
async function restoreChannel(
  guild: Guild,
  channelData: ChannelData,
  conflictResolution: RestoreOptions['conflictResolution'],
  roleIdMap: Map<string, string>,
  channelIdMap: Map<string, string>,
  interaction?: ChatInputCommandInteraction,
): Promise<void> {
  let currentResolution = conflictResolution;
  try {
    // Vérifier si un salon avec le même nom existe déjà
    const existingChannel = guild.channels.cache.find((c) => c.name === channelData.name);

    if (existingChannel) {
      if (currentResolution === 'ignore') {
        console.log(`⏭️ Salon ignoré: ${channelData.name}`);
        channelIdMap.set(channelData.id, existingChannel.id);
        return;
      }

      if (currentResolution === 'ask' && interaction) {
        const resolution = await askConflictResolution(
          interaction,
          'channel',
          channelData.name,
          'Un salon avec ce nom existe déjà',
        );

        if (resolution.decision === 'ignore') {
          console.log(`⏭️ Salon ignoré: ${channelData.name}`);
          channelIdMap.set(channelData.id, existingChannel.id);
          return;
        }

        if (resolution.applyToAll) {
          currentResolution = 'replace_all';
        }
      }

      // Mettre à jour le salon existant
      if ('edit' in existingChannel) {
        const updateData: Record<string, unknown> = {};
        if (channelData.topic) updateData.topic = channelData.topic;
        if (channelData.nsfw !== undefined) updateData.nsfw = channelData.nsfw;
        if (channelData.rateLimitPerUser) updateData.rateLimitPerUser = channelData.rateLimitPerUser;
        if (channelData.bitrate) updateData.bitrate = channelData.bitrate;
        if (channelData.userLimit) updateData.userLimit = channelData.userLimit;

        const newParentId = channelData.parentId ? channelIdMap.get(channelData.parentId) : null;
        if (newParentId) {
          updateData.parent = newParentId;
        }

        await existingChannel.edit(updateData);
        channelIdMap.set(channelData.id, existingChannel.id);
        console.log(`✏️ Salon mis à jour: ${channelData.name}`);
      }
    } else {
      // Créer un nouveau salon
      const createData: Record<string, unknown> = {
        name: channelData.name,
        type: channelData.type,
        position: channelData.position,
      };

      const newParentId = channelData.parentId ? channelIdMap.get(channelData.parentId) : null;
      if (newParentId) {
        createData.parent = newParentId;
      }

      if (channelData.topic) createData.topic = channelData.topic;
      if (channelData.nsfw !== undefined) createData.nsfw = channelData.nsfw;
      if (channelData.rateLimitPerUser) createData.rateLimitPerUser = channelData.rateLimitPerUser;
      if (channelData.bitrate) createData.bitrate = channelData.bitrate;
      if (channelData.userLimit) createData.userLimit = channelData.userLimit;

      const newChannel = await guild.channels.create(createData as unknown as Parameters<typeof guild.channels.create>[0]);
      channelIdMap.set(channelData.id, newChannel.id);
      console.log(`✅ Salon créé: ${channelData.name}`);

      // Restaurer les permissions
      if (channelData.permissionOverwrites && 'permissionOverwrites' in newChannel) {
        const overwritesToSet = [];
        for (const overwrite of channelData.permissionOverwrites) {
          try {
            let targetId = overwrite.id;
            if (overwrite.type === 'role') {
              const mappedId = roleIdMap.get(overwrite.id);
              if (mappedId) targetId = mappedId;
            }
            overwritesToSet.push({
              id: targetId,
              allow: BigInt(overwrite.allow),
              deny: BigInt(overwrite.deny),
              type: overwrite.type === 'role' ? 0 : 1,
            });
          } catch (error) {
            console.error(`❌ Erreur lors du mapping des permissions pour ${channelData.name}:`, error);
          }
        }

        if (overwritesToSet.length > 0) {
          await newChannel.permissionOverwrites.set(overwritesToSet);
        }
      }
    }
  } catch (error) {
    console.error(`❌ Erreur lors de la restauration du salon ${channelData.name}:`, error);
  }
}

/**
 * Restaure les membres
 */
async function restoreMembers(
  guild: Guild,
  members: MemberData[],
  options: RestoreOptions,
  roleIdMap: Map<string, string>,
): Promise<void> {
  console.log(`🔄 Restauration de ${members.length} membres...`);

  for (const memberData of members) {
    try {
      // Vérifier si le membre est dans le serveur
      const member = await guild.members.fetch(memberData.id).catch(() => null);

      if (!member) {
        console.log(`⏭️ Membre non trouvé: ${memberData.username}`);
        continue;
      }

      // Restaurer les rôles
      if (options.includeRoles && memberData.roles) {
        const rolesToAdd = memberData.roles
          .map((roleId) => {
            const mappedId = roleIdMap.get(roleId) || roleId;
            return guild.roles.cache.get(mappedId);
          })
          .filter((r) => r !== undefined) as Role[];

        if (rolesToAdd.length > 0) {
          await member.roles.add(rolesToAdd, 'Restauration depuis backup');
          console.log(`✅ Rôles restaurés pour: ${memberData.username}`);
        }
      }

      // Restaurer le nickname
      if (memberData.nick) {
        await member.setNickname(memberData.nick, 'Restauration depuis backup');
        console.log(`✅ Nickname restauré pour: ${memberData.username}`);
      }
    } catch (error) {
      console.error(`❌ Erreur lors de la restauration du membre ${memberData.username}:`, error);
    }
  }
}

/**
 * Restaure les messages
 */
async function restoreMessages(guild: Guild, messages: MessageData[], channelIdMap: Map<string, string>): Promise<void> {
  console.log(`🔄 Restauration de ${messages.length} messages...`);

  for (const messageData of messages) {
    try {
      const mappedChannelId = channelIdMap.get(messageData.channelId) || messageData.channelId;
      const channel = guild.channels.cache.get(mappedChannelId);

      if (!channel || !('send' in channel)) {
        console.log(`⏭️ Salon non trouvé: ${mappedChannelId}`);
        continue;
      }

      if (!channel.isTextBased() || !channel.isSendable()) continue;
      await channel.send({
        content: messageData.content || undefined,
        embeds: (messageData.embeds as APIEmbed[]) || [],
        allowedMentions: { parse: [] },
      });
      console.log(`✅ Message restauré dans: ${channel.name}`);
    } catch (error) {
      console.error(`❌ Erreur lors de la restauration d'un message:`, error);
    }
  }
}

/**
 * Demande à l'utilisateur comment résoudre un conflit (style Windows)
 */
async function askConflictResolution(
  interaction: ChatInputCommandInteraction,
  type: 'role' | 'channel',
  name: string,
  reason: string,
): Promise<ConflictResolution> {
  const embed = new EmbedBuilder()
    .setTitle('⚠️ Conflit détecté')
    .setDescription(
      `Conflit pour ${type === 'role' ? 'le rôle' : 'le salon'} **${name}**\n\n` +
      `Raison: ${reason}\n\n` +
      `Que souhaitez-vous faire ?`,
    )
    .setColor('#FFA500');

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('conflict_ignore')
      .setLabel('Ignorer')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('conflict_replace')
      .setLabel('Remplacer')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('conflict_ignore_all')
      .setLabel('Ignorer tout')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('conflict_replace_all')
      .setLabel('Remplacer tout')
      .setStyle(ButtonStyle.Success),
  );

  const response = await interaction.followUp({
    embeds: [embed],
    components: [row],
    fetchReply: true,
  });

  try {
    const confirmation = await response.awaitMessageComponent({
      filter: (i) => i.user.id === interaction.user.id,
      time: 60000,
    });

    const customId = confirmation.customId;

    if (customId === 'conflict_ignore') {
      await confirmation.update({ content: 'Élément ignoré.', components: [] });
      return { decision: 'ignore', applyToAll: false };
    } else if (customId === 'conflict_replace') {
      await confirmation.update({ content: 'Élément remplacé.', components: [] });
      return { decision: 'replace', applyToAll: false };
    } else if (customId === 'conflict_ignore_all') {
      await confirmation.update({ content: 'Tous les éléments similaires seront ignorés.', components: [] });
      return { decision: 'ignore', applyToAll: true };
    } else if (customId === 'conflict_replace_all') {
      await confirmation.update({ content: 'Tous les éléments similaires seront remplacés.', components: [] });
      return { decision: 'replace', applyToAll: true };
    }
  } catch (error) {
    // Timeout
    await interaction.followUp({ content: '⏱️ Délai expiré. Élément ignoré par défaut.', ephemeral: true });
  }

  return { decision: 'ignore', applyToAll: false };
}
