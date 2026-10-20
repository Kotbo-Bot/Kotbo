/** Outils MCP - write channels (permission WRITE_MEMBERS). */
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { z } from 'zod';
import { type McpToolContext, err, ok, resolveGuildChannel, resolveMember, toolError } from '../toolkit.js';

export function registerWriteChannelsTools(ctx: McpToolContext) {
  const { server, guildId, client, shouldRegister, guard, audit, toolMeta } = ctx;

  // ── WRITE_MEMBERS - Gestion des salons ────────────────────────────────────
  if (shouldRegister('WRITE_MEMBERS')) {

    // create_category - Créer une catégorie
    server.registerTool(
      'create_category',
      {
        description: 'Crée une catégorie sur le serveur Discord. Requiert WRITE_MEMBERS.',
        inputSchema: {
          name: z.string().describe('Nom de la catégorie'),
          position: z.number().int().min(0).optional().describe('Position (0 = en haut)'),
          private: z.boolean().default(false).describe('Si true, la catégorie est cachée au rôle @everyone'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ name, position, private: isPrivate, key_name }) => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur introuvable.');
        try {
          const permissionOverwrites = isPrivate ? [
            { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
          ] : [];
          const cat = await guild.channels.create({
            name,
            type: ChannelType.GuildCategory,
            position,
            permissionOverwrites,
          });
          await audit(key_name, 'Création catégorie MCP', name, `ID: ${cat.id}`);
          return ok({ ok: true, categoryId: cat.id, name: cat.name });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    // create_channel - Créer un salon textuel, vocal ou d'annonce
    server.registerTool(
      'create_channel',
      {
        description: 'Crée un salon Discord (texte, vocal, annonces, forum, stage). Requiert WRITE_MEMBERS.',
        inputSchema: {
          name: z.string().describe('Nom du salon'),
          type: z.enum(['text', 'voice', 'announcement', 'forum', 'stage']).default('text').describe('Type de salon'),
          category: z.string().optional().describe('Nom ou ID de la catégorie parente'),
          topic: z.string().optional().describe('Sujet du salon (salons textuels uniquement, max 1024 car.)'),
          private: z.boolean().default(false).describe('Si true, caché au @everyone'),
          nsfw: z.boolean().default(false).describe('Marquer le salon comme NSFW'),
          slowmode: z.number().int().min(0).max(21600).default(0).describe('Délai de lenteur en secondes (0 = désactivé)'),
          user_limit: z.number().int().min(0).max(99).optional().describe('Limite d\'utilisateurs (salons vocaux, 0 = illimité)'),
          bitrate: z.number().int().min(8000).max(384000).optional().describe('Bitrate en bps pour les salons vocaux (ex: 64000)'),
          position: z.number().int().min(0).optional().describe('Position dans la catégorie'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ name, type, category, topic, private: isPrivate, nsfw, slowmode, user_limit, bitrate, position, key_name }) => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur introuvable.');

        // Résoudre la catégorie parente
        let parentId: string | undefined;
        if (category) {
          const cat = guild.channels.cache.find(c =>
            c.type === ChannelType.GuildCategory &&
            (c.id === category || c.name.toLowerCase() === category.toLowerCase())
          );
          if (!cat) return err(`Catégorie introuvable : « ${category} ». Vérifiez le nom ou l'ID.`);
          parentId = cat.id;
        }

        const channelTypeMap: Record<string, number> = {
          text: ChannelType.GuildText,
          voice: ChannelType.GuildVoice,
          announcement: ChannelType.GuildAnnouncement,
          forum: ChannelType.GuildForum,
          stage: ChannelType.GuildStageVoice,
        };

        const permissionOverwrites = isPrivate ? [
          { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
        ] : [];

        try {
          const ch = await guild.channels.create({
            name,
            type: channelTypeMap[type] as any,
            parent: parentId,
            topic: topic?.slice(0, 1024),
            nsfw,
            rateLimitPerUser: slowmode,
            userLimit: user_limit,
            bitrate,
            position,
            permissionOverwrites,
          });
          await audit(key_name, 'Création salon MCP', `#${name} (${type})`, `ID: ${ch.id}${parentId ? ` | catégorie: ${parentId}` : ''}`);
          return ok({ ok: true, channelId: ch.id, name: ch.name, type });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    // edit_channel - Modifier un salon existant
    server.registerTool(
      'edit_channel',
      {
        description: 'Modifie les propriétés d\'un salon existant, forum et catégorie compris (nom, sujet ou consignes du forum, catégorie, lenteur…). Requiert WRITE_MEMBERS.',
        inputSchema: {
          channel: z.string().describe('Nom, mention <#id> ou ID du salon à modifier'),
          name: z.string().optional().describe('Nouveau nom'),
          topic: z.string().optional().describe('Nouveau sujet (max 1024 car.)'),
          category: z.string().optional().describe('Nouvelle catégorie (nom ou ID), "" pour retirer'),
          nsfw: z.boolean().optional(),
          slowmode: z.number().int().min(0).max(21600).optional().describe('Délai de lenteur en secondes'),
          user_limit: z.number().int().min(0).max(99).optional().describe('Limite d\'utilisateurs (vocaux)'),
          bitrate: z.number().int().min(8000).max(384000).optional().describe('Bitrate bps (vocaux)'),
          position: z.number().int().min(0).optional(),
          reason: z.string().optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ channel, name, topic, category, nsfw, slowmode, user_limit, bitrate, position, reason, key_name }) => {
        const resolved = resolveGuildChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;
        const ch = resolved.channel as any;

        const guild = client.guilds.cache.get(guildId)!;
        let parentId: string | null | undefined = undefined;
        if (category !== undefined) {
          if (category === '') {
            parentId = null; // retirer de la catégorie
          } else {
            const cat = guild.channels.cache.find(c =>
              c.type === ChannelType.GuildCategory &&
              (c.id === category || c.name.toLowerCase() === category.toLowerCase())
            );
            if (!cat) return err(`Catégorie introuvable : « ${category} ».`);
            parentId = cat.id;
          }
        }

        const options: Record<string, unknown> = {};
        if (name !== undefined) options.name = name;
        if (topic !== undefined) options.topic = topic.slice(0, 1024);
        if (parentId !== undefined) options.parent = parentId;
        if (nsfw !== undefined) options.nsfw = nsfw;
        if (slowmode !== undefined) options.rateLimitPerUser = slowmode;
        if (user_limit !== undefined) options.userLimit = user_limit;
        if (bitrate !== undefined) options.bitrate = bitrate;
        if (position !== undefined) options.position = position;

        try {
          await ch.edit(options, reason);
          await audit(key_name, 'Modification salon MCP', `#${ch.name}`, JSON.stringify(options).slice(0, 200));
          return ok({ ok: true, channelId: ch.id, updates: Object.keys(options) });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    // set_channel_permissions - Gérer les permissions d'un salon
    server.registerTool(
      'set_channel_permissions',
      {
        description:
          'Définit ou supprime des permissions sur un salon (textuel, vocal, forum ou catégorie) pour un rôle ou un membre. ' +
          'Utilise allow/deny comme listes de permissions Discord (ex: ["ViewChannel","SendMessages"] ; ' +
          'sur un forum, SendMessages = publier un post, SendMessagesInThreads = répondre). ' +
          'Requiert WRITE_MEMBERS.',
        inputSchema: {
          channel: z.string().describe('Nom, mention <#id> ou ID du salon'),
          target: z.string().describe('Nom ou ID du rôle OU @mention/nom/ID du membre concerné'),
          target_type: z.enum(['role', 'member']).default('role'),
          allow: z.array(z.string()).default([]).describe('Permissions à autoriser (ex: ["ViewChannel","SendMessages"])'),
          deny: z.array(z.string()).default([]).describe('Permissions à refuser (ex: ["SendMessages"])'),
          reset: z.boolean().default(false).describe('Si true, supprime la surcharge de permission existante'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ channel, target, target_type, allow, deny, reset, key_name }) => {
        const resolved = resolveGuildChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;
        const ch = resolved.channel as any;

        const guild = client.guilds.cache.get(guildId)!;

        // Résoudre la cible (rôle ou membre)
        let targetId: string;
        if (target_type === 'role') {
          const SNOWFLAKE_RE = /^\d{16,20}$/;
          const role = SNOWFLAKE_RE.test(target)
            ? guild.roles.cache.get(target)
            : guild.roles.cache.find(r => r.name.toLowerCase() === target.toLowerCase());
          if (!role) return err(`Rôle introuvable : « ${target} ». Vérifiez le nom ou l'ID.`);
          targetId = role.id;
        } else {
          const rm = await resolveMember(guildId, target);
          if (!rm.ok) return rm.response;
          targetId = rm.userId;
        }

        try {
          if (reset) {
            await ch.permissionOverwrites.delete(targetId);
            await audit(key_name, 'Reset permissions salon MCP', `#${ch.name}`, `Cible: ${target}`);
            return ok({ ok: true, reset: true, channelId: ch.id, targetId });
          }

          // Construire l'objet de surcharge : { ViewChannel: true, SendMessages: false, ... }
          const overwrite: Record<string, boolean> = {};
          for (const p of allow) {
            if ((PermissionFlagsBits as any)[p] !== undefined) overwrite[p] = true;
          }
          for (const p of deny) {
            if ((PermissionFlagsBits as any)[p] !== undefined) overwrite[p] = false;
          }

          if (Object.keys(overwrite).length === 0) {
            return err('Aucune permission valide reconnue. Exemples valides : ViewChannel, SendMessages, Connect, Speak, ManageMessages…');
          }

          await ch.permissionOverwrites.edit(targetId, overwrite);

          await audit(key_name, 'Permissions salon MCP', `#${ch.name}`, `Cible: ${target} | allow: [${allow}] | deny: [${deny}]`);
          return ok({ ok: true, channelId: ch.id, targetId, allow, deny });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    // delete_channel - Supprimer un salon ou une catégorie
    server.registerTool(
      'delete_channel',
      {
        description: 'Supprime un salon ou une catégorie Discord. Requiert WRITE_MEMBERS.',
        inputSchema: {
          channel: z.string().describe('Nom, mention <#id> ou ID du salon / catégorie à supprimer'),
          reason: z.string().optional().describe('Raison de la suppression (visible dans les logs Discord)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ channel, reason, key_name }) => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur introuvable.');

        const SNOWFLAKE_RE = /^\d{16,20}$/;
        const MENTION_CH = /^<#(\d+)>$/;
        const mentionMatch = channel.match(MENTION_CH);
        const rawId = mentionMatch ? mentionMatch[1] : SNOWFLAKE_RE.test(channel) ? channel : null;

        const ch = rawId
          ? guild.channels.cache.get(rawId)
          : guild.channels.cache.find(c => c.name.toLowerCase() === channel.replace(/^#/, '').toLowerCase());

        if (!ch) return err(`Salon/catégorie introuvable : « ${channel} ».`);

        try {
          const savedName = ch.name;
          const savedId = ch.id;
          await (ch as any).delete(reason ?? 'Suppression via MCP');
          await audit(key_name, 'Suppression salon MCP', `#${savedName}`, `ID: ${savedId}${reason ? ` | ${reason}` : ''}`);
          return ok({ ok: true, deletedId: savedId, name: savedName });
        } catch (e) {
          return toolError(e);
        }
      })
    );
  }
}
