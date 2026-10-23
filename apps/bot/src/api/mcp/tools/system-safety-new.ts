/** Outils MCP - system safety new (permission WRITE_MESSAGES). */
import prisma from '../../../utils/db.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type NewsChannel, PermissionFlagsBits, TextChannel } from 'discord.js';
import { z } from 'zod';
import { type McpToolContext, err, ok, resolveChannel, toolError } from '../toolkit.js';

export function registerSystemSafetyNewTools(ctx: McpToolContext) {
  const { server, guildId, client, shouldRegister, guard, audit, toolMeta } = ctx;

  // ── SYSTEM & SAFETY (NEW) ──────────────────────────────────────────────────
  if (shouldRegister('WRITE_MESSAGES')) {
    // 1. request_staff_approval
    server.registerTool(
      'request_staff_approval',
      {
        description: 'Soumet une action critique (comme réinitialiser l\'économie ou bannir) à l\'approbation manuelle du Staff via un bouton Discord.',
        inputSchema: {
          action_name: z.string().describe('Nom court de l\'action (ex: "reset_economy", "ban_member")'),
          details: z.string().describe('Détails textuels décrivant l\'action demandée par l\'IA'),
          channel: z.string().optional().describe('Salon où envoyer la demande (défaut: salon de logs)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ action_name, details, channel, key_name }) => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        // Récupérer le salon de logs
        let targetChannel: TextChannel | NewsChannel | null = null;
        if (channel) {
          const resolved = resolveChannel(guildId, client, channel);
          if (resolved.ok) targetChannel = resolved.channel;
        }

        if (!targetChannel) {
          const config = await prisma.guild.findUnique({ where: { id: guildId }, select: { logChannelId: true } });
          const ch = config?.logChannelId ? guild.channels.cache.get(config.logChannelId) : null;
          if (ch instanceof TextChannel) targetChannel = ch;
        }

        if (!targetChannel) {
          // Fallback sur le premier salon texte disponible si aucun salon de log configuré
          const fallback = guild.channels.cache.find(c => c instanceof TextChannel && c.permissionsFor(guild.members.me!).has(PermissionFlagsBits.SendMessages));
          if (fallback instanceof TextChannel) targetChannel = fallback;
        }

        if (!targetChannel) return err('Aucun salon textuel trouvé pour envoyer la demande.');

        try {
          const { randomBytes } = await import('crypto');
          const requestId = `mcp_approve:${randomBytes(8).toString('hex')}`;
          
          // Stocker temporairement la demande d'approbation en base (si une table existe, ou en log)
          // Pour éviter de surcharger le schema, on crée un log d'audit spécifique en statut PENDING
          await prisma.dashboardAuditLog.create({
            data: {
              guildId,
              user: `MCP[${key_name || 'agent'}]`,
              action: `Demande d'approbation : ${action_name}`,
              context: requestId,
              module: 'MCP',
              eventType: 'Action',
              details: `PENDING - Détails : ${details}`,
              dateIso: new Date(),
            }
          });

          const embed = new EmbedBuilder()
            .setTitle(`⚠️ Demande d'autorisation critique · IA`)
            .setDescription(`L'agent IA demande l'autorisation d'exécuter l'action suivante :\n\n**Action :** \`${action_name}\`\n**Détails :**\n${details}`)
            .setColor(0xd97757) // Orange
            .setTimestamp()
            .setFooter({ text: `ID Demande : ${requestId}` });

          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`mcp_approve:ok:${requestId}`).setLabel('Approuver').setStyle(ButtonStyle.Success).setEmoji('✅'),
            new ButtonBuilder().setCustomId(`mcp_approve:no:${requestId}`).setLabel('Rejeter').setStyle(ButtonStyle.Danger).setEmoji('❌')
          );

          await targetChannel.send({
            content: '🔔 **Alerte Staff :** Une action IA requiert votre validation.',
            embeds: [embed],
            components: [row]
          });

          return ok({ ok: true, pendingApproval: true, requestId, message: "La demande d'approbation a été envoyée au staff." });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    // 2. generate_server_digest
    server.registerTool(
      'generate_server_digest',
      {
        description: 'Publie un digest/récapitulatif rédigé par l\'IA dans un salon textuel.',
        inputSchema: {
          channel: z.string().describe('Salon cible'),
          title: z.string().default('Récapitulatif Hebdomadaire'),
          content: z.string().describe('Texte du digest/récapitulatif rédigé par l\'IA'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ channel, title, content, key_name }) => {
        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;

        const embed = new EmbedBuilder()
          .setTitle(title)
          .setDescription(content)
          .setColor(0x5865F2)
          .setTimestamp();

        try {
          const sent = await resolved.channel.send({ embeds: [embed] });
          await audit(key_name, 'Publication Digest MCP', title, `Salon: #${resolved.channel.name}`);
          return ok({ ok: true, messageId: sent.id });
        } catch (e) {
          return toolError(e, "Erreur d'envoi");
        }
      })
    );

    // ── Messages épinglés & threads ─────────────────────────────────────────

    server.registerTool(
      'pin_message',
      {
        description: 'Épingle un message dans un salon. Requiert WRITE_MESSAGES.',
        inputSchema: {
          channel: z.string().describe('Nom, mention <#id> ou ID du salon'),
          message_id: z.string().describe('ID du message à épingler'),
          reason: z.string().optional().describe('Raison'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ channel, message_id, reason, key_name }) => {
        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;

        try {
          const msg = await resolved.channel.messages.fetch(message_id);
          await msg.pin(reason || 'Épinglé via MCP');

          await audit(key_name, 'Épinglage message MCP', `#${resolved.channel.name}`, `Message: ${message_id}`);
          return ok({ ok: true, messageId: message_id, channelId: resolved.channel.id });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'unpin_message',
      {
        description: 'Désépingle un message d\'un salon. Requiert WRITE_MESSAGES.',
        inputSchema: {
          channel: z.string().describe('Nom, mention <#id> ou ID du salon'),
          message_id: z.string().describe('ID du message à désépingler'),
          reason: z.string().optional().describe('Raison'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ channel, message_id, reason, key_name }) => {
        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;

        try {
          const msg = await resolved.channel.messages.fetch(message_id);
          await msg.unpin(reason || 'Désépinglé via MCP');

          await audit(key_name, 'Désépinglage message MCP', `#${resolved.channel.name}`, `Message: ${message_id}`);
          return ok({ ok: true, messageId: message_id, channelId: resolved.channel.id });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'create_thread',
      {
        description: 'Crée un thread dans un salon (à partir d\'un message existant ou non). Requiert WRITE_MESSAGES.',
        inputSchema: {
          channel: z.string().describe('Nom, mention <#id> ou ID du salon parent'),
          name: z.string().describe('Nom du thread'),
          message_id: z.string().optional().describe('ID du message à partir duquel créer le thread (optionnel)'),
          auto_archive_duration: z.enum(['60', '1440', '4320', '10080']).default('1440').describe('Durée avant archivage auto (en minutes) : 60, 1440, 4320, 10080'),
          reason: z.string().optional().describe('Raison de la création'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ channel, name, message_id, auto_archive_duration, reason, key_name }) => {
        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;

        try {
          const duration = parseInt(auto_archive_duration, 10) as 60 | 1440 | 4320 | 10080;

          let thread;
          if (message_id) {
            const msg = await resolved.channel.messages.fetch(message_id);
            thread = await msg.startThread({
              name,
              autoArchiveDuration: duration,
              reason: reason || 'Créé via MCP',
            });
          } else {
            thread = await resolved.channel.threads.create({
              name,
              autoArchiveDuration: duration,
              reason: reason || 'Créé via MCP',
            });
          }

          await audit(key_name, 'Création thread MCP', name, `ID: ${thread.id} dans #${resolved.channel.name}`);
          return ok({ ok: true, threadId: thread.id, name: thread.name, channelId: resolved.channel.id });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'archive_thread',
      {
        description: 'Archive ou désarchive un thread. Requiert WRITE_MESSAGES.',
        inputSchema: {
          thread: z.string().describe('ID du thread'),
          archived: z.boolean().default(true).describe('true pour archiver, false pour désarchiver'),
          reason: z.string().optional().describe('Raison'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ thread, archived, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const threadChannel = guild.channels.cache.get(thread);
          if (!threadChannel?.isThread()) return err(`Thread « ${thread} » introuvable`);

          await threadChannel.setArchived(archived, reason || 'Via MCP');

          await audit(key_name, archived ? 'Archivage thread MCP' : 'Désarchivage thread MCP', threadChannel.name, `ID: ${thread}`);
          return ok({ ok: true, threadId: thread, archived });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'lock_thread',
      {
        description: 'Verrouille ou déverrouille un thread. Requiert WRITE_MESSAGES.',
        inputSchema: {
          thread: z.string().describe('ID du thread'),
          locked: z.boolean().default(true).describe('true pour verrouiller, false pour déverrouiller'),
          reason: z.string().optional().describe('Raison'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ thread, locked, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const threadChannel = guild.channels.cache.get(thread);
          if (!threadChannel?.isThread()) return err(`Thread « ${thread} » introuvable`);

          await threadChannel.setLocked(locked, reason || 'Via MCP');

          await audit(key_name, locked ? 'Verrouillage thread MCP' : 'Déverrouillage thread MCP', threadChannel.name, `ID: ${thread}`);
          return ok({ ok: true, threadId: thread, locked });
        } catch (e) {
          return toolError(e);
        }
      })
    );
  }
}
