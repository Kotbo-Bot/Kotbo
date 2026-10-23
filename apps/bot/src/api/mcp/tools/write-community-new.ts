/** Outils MCP - write community new (permission WRITE_COMMUNITY). */
import { createCustomForm, deleteCustomForm } from '../../../services/features/customFormService.js';
import { createCustomEvent } from '../../../services/features/eventService.js';
import { invalidateActiveQuests } from '../../../services/community/questService.js';
import { createGiveaway, deleteGiveaway, endGiveaway, refreshActiveGiveaways, rerollGiveaway } from '../../../services/features/giveawayService.js';
import prisma from '../../../utils/db.js';
import { sanitizeCustomCss, sanitizeFormTheme } from '../../../utils/formCustomization.js';
import { Prisma } from '@prisma/client';
import { ChannelType, EmbedBuilder } from 'discord.js';
import { z } from 'zod';
import { type McpToolContext, err, ok, resolveChannel, toolError } from '../toolkit.js';

export function registerWriteCommunityNewTools(ctx: McpToolContext) {
  const { server, guildId, client, shouldRegister, guard, audit, toolMeta, ownerId } = ctx;

  // ── WRITE_COMMUNITY (NEW) ──────────────────────────────────────────────────
  if (shouldRegister('WRITE_COMMUNITY')) {
    // 1. create_custom_event
    server.registerTool(
      'create_custom_event',
      {
        description: 'Crée un événement personnalisé (base de données et optionnellement sur Discord avec annonce).',
        inputSchema: {
          title: z.string().describe("Titre de l'événement"),
          description: z.string().optional().describe("Description de l'événement"),
          start_time: z.string().describe("Date/heure de début (format ISO, ex: 2026-06-30T18:00:00Z)"),
          end_time: z.string().optional().describe("Date/heure de fin (format ISO)"),
          location: z.string().default('Discord').describe("Lieu de l'événement"),
          announcement_channel: z.string().optional().describe("Nom ou ID du salon d'annonce"),
          form_id: z.string().optional().describe("ID du formulaire d'inscription lié"),
          create_discord_event: z.boolean().default(true).describe("Créer un événement Discord officiel natif"),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ title, description, start_time, end_time, location, announcement_channel, form_id, create_discord_event, key_name }) => {
        let announceChId: string | undefined;
        if (announcement_channel) {
          const resolved = resolveChannel(guildId, client, announcement_channel);
          if (resolved.ok) announceChId = resolved.channel.id;
        }

        try {
          const event = await createCustomEvent(client, guildId, {
            title,
            description,
            announcementChannelId: announceChId,
            formId: form_id,
            startTime: start_time,
            endTime: end_time,
            createDiscordEvent: create_discord_event,
            location,
          });

          // Publier l'annonce s'il y a un salon
          if (event && announceChId) {
            const { publishCustomEventAnnouncement } = await import('../../../services/features/eventService.js');
            await publishCustomEventAnnouncement(client, event.id).catch(() => null);
          }

          await audit(key_name, 'Création événement MCP', title, `Type: CUSTOM | Début: ${start_time}`);
          return ok({ ok: true, eventId: event?.id ?? null, title });
        } catch (e) {
          return toolError(e, "Erreur lors de la création de l'événement");
        }
      })
    );

    // 2. create_custom_form
    server.registerTool(
      'create_custom_form',
      {
        description: 'Crée un formulaire de A à Z avec questions structurées.',
        inputSchema: {
          name: z.string().describe('Nom du formulaire'),
          description: z.string().optional().describe('Description du formulaire'),
          is_recruitment: z.boolean().default(false).describe("Indique s'il s'agit d'un formulaire de recrutement"),
          requires_discord_auth: z.boolean().default(false).describe('Exiger une connexion Discord pour soumettre'),
          theme: z.record(z.unknown()).optional().describe('Thème visuel (couleurs, bannière, police…)'),
          custom_css: z.string().nullable().optional().describe('CSS personnalisé (sanitisé côté serveur)'),
          hierarchy_id: z.string().optional().describe("ID de la hiérarchie staff (ex: Modération, Animation) à associer si formulaire de recrutement : détermine le rôle attribué à l'embauche"),
          questions: z.array(z.object({
            id: z.string().optional().describe('Identifiant unique de la question (généré automatiquement si omis)'),
            label: z.string().describe('Intitulé de la question'),
            type: z.enum(['text', 'paragraph', 'select', 'checkbox', 'discord_connect']).default('text'),
            required: z.boolean().default(true),
            placeholder: z.string().optional(),
            options: z.array(z.string()).optional().describe("Options (obligatoire si type == 'select')"),
          })).default([]).describe('Liste des questions'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ name, description, is_recruitment, requires_discord_auth, theme, custom_css, hierarchy_id, questions, key_name }) => {
        try {
          if (hierarchy_id) {
            const hierarchy = await prisma.staffHierarchy.findFirst({ where: { id: hierarchy_id, guildId } });
            if (!hierarchy) return err('Hiérarchie introuvable pour ce serveur');
          }

          const mappedFields = questions.map((q: any, i: number) => ({
            id: q.id || q.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30) || `field_${i}`,
            label: q.label,
            type: q.type === 'text' ? 'short_text'
                : q.type === 'select' ? 'dropdown'
                : q.type === 'checkbox' ? 'checkboxes'
                : q.type === 'discord_connect' ? 'discord_connect'
                : 'paragraph',
            required: q.required ?? true,
            description: q.placeholder || undefined,
            options: q.options || undefined,
            sectionIndex: 0,
          }));

          const form = await createCustomForm(guildId, {
            name,
            description,
            isRecruitment: is_recruitment,
            requiresDiscordAuth: requires_discord_auth,
            theme: sanitizeFormTheme(theme),
            customCss: sanitizeCustomCss(custom_css),
            hierarchyId: hierarchy_id,
            structure: {
              title: name,
              description: description || undefined,
              fields: mappedFields,
            },
          });

          await audit(key_name, 'Création formulaire MCP', name, `Questions: ${questions.length}`);
          return ok({ ok: true, formId: form.id, name, fieldsCreated: mappedFields.length });
        } catch (e) {
          return toolError(e, 'Erreur lors de la création du formulaire');
        }
      })
    );

    // 3. create_announcement
    server.registerTool(
      'create_announcement',
      {
        description: 'Envoie une annonce structurée sous forme d\'Embed Discord dans un salon.',
        inputSchema: {
          channel: z.string().describe('Salon cible (nom, mention ou ID)'),
          title: z.string().describe('Titre de l\'annonce'),
          description: z.string().describe('Contenu de l\'annonce (markdown autorisé)'),
          color: z.string().default('#5865F2').describe('Couleur hexadécimale de l\'embed (ex: #ff0000)'),
          mention: z.enum(['none', 'everyone', 'here', 'role']).default('none').describe('Mention à inclure'),
          role_mention: z.string().optional().describe('Nom ou ID du rôle à mentionner (si mention == "role")'),
          image_url: z.string().optional().describe('URL d\'une image à intégrer dans l\'embed'),
          thumbnail_url: z.string().optional().describe('URL d\'une miniature à intégrer dans l\'embed'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ channel, title, description, color, mention, role_mention, image_url, thumbnail_url, key_name }) => {
        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;

        const embed = new EmbedBuilder()
          .setTitle(title)
          .setDescription(description)
          .setColor(color.startsWith('#') ? (color as any) : `#${color}`)
          .setTimestamp();

        if (image_url) embed.setImage(image_url);
        if (thumbnail_url) embed.setThumbnail(thumbnail_url);

        let content = '';
        if (mention === 'everyone') content = '@everyone';
        else if (mention === 'here') content = '@here';
        else if (mention === 'role' && role_mention) {
          const guild = client.guilds.cache.get(guildId);
          const role = guild?.roles.cache.find(r => r.id === role_mention || r.name.toLowerCase() === role_mention.toLowerCase());
          if (role) content = `<@&${role.id}>`;
        }

        try {
          const sent = await resolved.channel.send({ content, embeds: [embed] });
          if (resolved.channel.type === ChannelType.GuildAnnouncement) {
            await sent.crosspost().catch(() => null);
          }

          await audit(key_name, 'Annonce MCP', title, `Salon: #${resolved.channel.name}`);
          return ok({ ok: true, messageId: sent.id, channelId: resolved.channel.id });
        } catch (e) {
          return toolError(e, "Erreur lors de l'envoi de l'annonce");
        }
      })
    );

    // 4. create_giveaway / create_giveway
    const giveawayInputSchema = {
      channel: z.string().describe('Salon cible'),
      prize: z.string().describe('Lot à gagner'),
      winner_count: z.number().int().min(1).default(1).describe('Nombre de gagnants'),
      duration_minutes: z.number().int().min(1).describe('Durée en minutes avant le tirage'),
      description: z.string().optional().describe('Description ou règles'),
      rpg_xp: z.number().int().default(0).describe('XP RPG offerte aux gagnants'),
      rpg_coins: z.number().int().default(0).describe('Pièces RPG offertes aux gagnants'),
      rpg_item_id: z.string().optional().describe('ID de l\'objet RPG offert aux gagnants, refuse s\'il n\'existe pas sur ce serveur'),
      need_validation: z.boolean().default(false).describe('Exiger la validation du staff avant de remettre le lot'),
      ignore_bonuses: z.boolean().default(false).describe('Tirage strictement egalitaire : ignore les roles avantages et le bonus de clan'),
      key_name: z.string().optional(),
    };

    const giveawayHandler = guard('WRITE_COMMUNITY', async ({ channel, prize, winner_count, duration_minutes, description, rpg_xp, rpg_coins, rpg_item_id, need_validation, ignore_bonuses, key_name }) => {
      const resolved = resolveChannel(guildId, client, channel);
      if (!resolved.ok) return resolved.response;

      try {
        const giveaway = await createGiveaway(
          client,
          guildId,
          resolved.channel.id,
          prize,
          winner_count,
          duration_minutes,
          description,
          rpg_xp,
          rpg_coins,
          rpg_item_id || null,
          need_validation,
          // Le compte au nom duquel la cle agit, quand elle en declare un :
          // sans lui la variable {host} de l'annonce reste vide.
          ownerId,
          {},
          ignore_bonuses
        );

        await audit(key_name, 'Création giveaway MCP', prize, `Salon: #${resolved.channel.name}`);
        return ok({ ok: true, giveawayId: giveaway.id, prize });
      } catch (e) {
        return toolError(e, 'Erreur lors du lancement du giveaway');
      }
    });

    server.registerTool(
      'create_giveaway',
      {
        description: 'Lance un tirage au sort (giveaway) sur Discord.',
        inputSchema: giveawayInputSchema,
        _meta: toolMeta,
      },
      giveawayHandler
    );

    server.registerTool(
      'create_giveway',
      {
        description: 'Lance un tirage au sort (giveaway) sur Discord (alias).',
        inputSchema: giveawayInputSchema,
        _meta: toolMeta,
      },
      giveawayHandler
    );

    // 5. cancel_giveaway / reroll_giveaway
    server.registerTool(
      'cancel_giveaway',
      {
        description: 'Annule/Met fin à un giveaway actif sans tirer de gagnants ou en forçant le tirage immédiat.',
        inputSchema: {
          giveaway_id: z.string().describe('ID du giveaway'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ giveaway_id, key_name }) => {
        try {
          await endGiveaway(client, giveaway_id, guildId);
          await audit(key_name, 'Annulation giveaway MCP', giveaway_id, '');
          return ok({ ok: true, giveawayId: giveaway_id });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'reroll_giveaway',
      {
        description: 'Tire un nouveau gagnant pour un giveaway déjà terminé.',
        inputSchema: {
          giveaway_id: z.string().describe('ID du giveaway'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ giveaway_id, key_name }) => {
        try {
          if (!(await rerollGiveaway(client, giveaway_id, guildId))) {
            return err('Aucun participant à tirer pour ce giveaway');
          }
          await audit(key_name, 'Reroll giveaway MCP', giveaway_id, '');
          return ok({ ok: true, giveawayId: giveaway_id });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    // 6. create_rpg_adventure / create_quest_definition
    server.registerTool(
      'create_quest_definition',
      {
        description: 'Crée une nouvelle définition de quête pour le système communautaire.',
        inputSchema: {
          name: z.string().describe('Nom de la quête'),
          description: z.string().describe('Description des objectifs'),
          type: z.enum(['SEND_MESSAGES', 'VOICE_MINUTES', 'REACT_MESSAGES', 'WIN_GAME', 'EARN_COINS', 'GIVE_REP', 'CREATE_THREADS', 'REPLY_MESSAGES']),
          frequency: z.enum(['DAILY', 'WEEKLY']),
          target: z.number().int().describe('Nombre de répétitions requises pour valider la quête'),
          reward_coins: z.number().int().default(0),
          reward_xp: z.number().int().default(0),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ name, description, type, frequency, target, reward_coins, reward_xp, key_name }) => {
        try {
          const quest = await prisma.questDefinition.create({
            data: {
              guildId,
              name,
              description,
              type,
              frequency,
              target,
              rewardCoins: reward_coins,
              rewardXp: reward_xp,
              enabled: true,
            }
          });
          await invalidateActiveQuests(guildId);

          await audit(key_name, 'Création quête MCP', name, `Target: ${target} | XP: ${reward_xp}`);
          return ok({ ok: true, questId: quest.id, name });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    // 7. create_auto_response
    server.registerTool(
      'create_auto_response',
      {
        description: 'Configure un déclencheur de réponse automatique (Auto-Response).',
        inputSchema: {
          trigger: z.string().describe('Le mot-clé ou la phrase déclencheuse'),
          response: z.string().describe('La réponse textuelle ou JSON embed à envoyer'),
          trigger_type: z.enum(['MESSAGE', 'FORM', 'TICKET']).default('MESSAGE'),
          match_type: z.enum(['EXACT', 'CONTAINS', 'REGEX']).default('CONTAINS'),
          role_to_add: z.string().optional().describe('ID du rôle à attribuer au déclenchement'),
          role_to_remove: z.string().optional().describe('ID du rôle à retirer au déclenchement'),
          delete_trigger: z.boolean().default(false).describe('Supprimer le message déclencheur (si MESSAGE)'),
          allowed_channels: z.array(z.string()).optional().describe('Liste des IDs de salons autorisés (vide = tous)'),
          banned_channels: z.array(z.string()).optional().describe('Liste des IDs de salons interdits'),
          allowed_roles: z.array(z.string()).optional().describe('Liste des IDs de rôles autorisés (vide = tous)'),
          banned_roles: z.array(z.string()).optional().describe('Liste des IDs de rôles interdits'),
          reactions: z.array(z.string()).optional().describe('Liste des émojis à ajouter en réaction'),
          actions: z.string().optional().describe('Actions complexes au format JSON (ex: { "sendDm": "...", "timeoutSeconds": 300 })'),
          close_ticket: z.boolean().default(false).describe('Fermer le ticket (si TICKET)'),
          reject_form: z.boolean().default(false).describe('Rejeter le formulaire (si FORM)'),
          form_id: z.string().optional().describe('ID du formulaire (si FORM)'),
          form_question_label: z.string().optional().describe('Label ou question du formulaire (si FORM)'),
          ticket_type_id: z.string().optional().describe('ID du type de ticket (si TICKET)'),
          ticket_question_label: z.string().optional().describe('Label ou question du ticket (si TICKET)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ trigger, response, trigger_type, match_type, role_to_add, role_to_remove, delete_trigger, allowed_channels, banned_channels, allowed_roles, banned_roles, reactions, actions, close_ticket, reject_form, form_id, form_question_label, ticket_type_id, ticket_question_label, key_name }) => {
        try {
          let parsedActions: any = null;
          if (actions) {
            try {
              parsedActions = JSON.parse(actions);
            } catch {
              return err('Le paramètre "actions" doit être une chaîne JSON valide.');
            }
          }

          const autoRes = await prisma.autoResponse.create({
            data: {
              guildId,
              trigger,
              response,
              triggerType: trigger_type,
              matchType: match_type,
              roleIdToAdd: role_to_add || null,
              roleIdToRemove: role_to_remove || null,
              deleteTrigger: delete_trigger,
              allowedChannelIds: allowed_channels || [],
              bannedChannelIds: banned_channels || [],
              allowedRoleIds: allowed_roles || [],
              bannedRoleIds: banned_roles || [],
              reactions: reactions || [],
              actions: parsedActions,
              closeTicket: close_ticket,
              rejectForm: reject_form,
              formId: form_id || null,
              formQuestionLabel: form_question_label || null,
              ticketTypeId: ticket_type_id || null,
              ticketQuestionLabel: ticket_question_label || null,
              enabled: true,
            }
          });

          await audit(key_name, 'Création AutoResponse MCP', trigger, `Type: ${trigger_type}`);
          return ok({ ok: true, autoResponseId: autoRes.id });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    // 8. create_scheduled_task
    server.registerTool(
      'create_scheduled_task',
      {
        description: 'Crée une tâche planifiée automatique récurrente.',
        inputSchema: {
          name: z.string().describe('Nom de la tâche'),
          type: z.enum(['CHANNEL_RESET', 'SERVER_BACKUP', 'DATA_EXPORT']),
          cron: z.string().describe('Expression Cron standard (ex: "0 0 * * *" pour tous les minuits)'),
          target_id: z.string().optional().describe('ID Discord cible (ex: salon)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ name, type, cron, target_id, key_name }) => {
        try {
          const task = await prisma.scheduledTask.create({
            data: {
              guildId,
              name,
              type,
              cron,
              targetId: target_id || null,
              enabled: true,
            }
          });

          await audit(key_name, 'Création tâche planifiée MCP', name, `Cron: ${cron}`);
          return ok({ ok: true, taskId: task.id, name });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'update_custom_form',
      {
        description: 'Met à jour un formulaire personnalisé existant. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          form_id: z.string().describe('ID du formulaire à modifier'),
          name: z.string().optional().describe('Nouveau nom du formulaire'),
          description: z.string().optional().describe('Nouvelle description'),
          is_recruitment: z.boolean().optional().describe("Indique s'il s'agit d'un formulaire de recrutement"),
          is_active: z.boolean().optional().describe("Activer ou désactiver le formulaire"),
          requires_discord_auth: z.boolean().optional().describe('Exiger une connexion Discord pour soumettre'),
          theme: z.record(z.unknown()).nullable().optional().describe('Thème visuel (null pour effacer)'),
          custom_css: z.string().nullable().optional().describe('CSS personnalisé (null pour effacer)'),
          hierarchy_id: z.string().nullable().optional().describe("ID de la hiérarchie staff à associer (null pour dissocier) : détermine le rôle attribué à l'embauche pour ce formulaire de recrutement"),
          questions: z.array(z.object({
            id: z.string().optional().describe('Identifiant unique de la question (généré automatiquement si omis)'),
            label: z.string().describe('Intitulé de la question'),
            type: z.enum(['text', 'paragraph', 'select', 'checkbox', 'discord_connect']).default('text'),
            required: z.boolean().default(true),
            placeholder: z.string().optional(),
            options: z.array(z.string()).optional(),
          })).optional().describe('Nouvelle liste complète des questions (si fournie, remplace l\'ancienne)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ form_id, name, description, is_recruitment, is_active, requires_discord_auth, theme, custom_css, hierarchy_id, questions, key_name }) => {
        try {
          const existing = await prisma.customForm.findFirst({ where: { id: form_id, guildId } });
          if (!existing) return err('Formulaire introuvable');

          if (hierarchy_id) {
            const hierarchy = await prisma.staffHierarchy.findFirst({ where: { id: hierarchy_id, guildId } });
            if (!hierarchy) return err('Hiérarchie introuvable pour ce serveur');
          }

          const updateData: any = {};
          if (name !== undefined) updateData.name = name;
          if (description !== undefined) updateData.description = description;
          if (is_recruitment !== undefined) updateData.isRecruitment = is_recruitment;
          if (is_active !== undefined) updateData.isActive = is_active;
          if (requires_discord_auth !== undefined) updateData.requiresDiscordAuth = requires_discord_auth;
          if (hierarchy_id !== undefined) updateData.hierarchyId = hierarchy_id;
          if (theme !== undefined) {
            updateData.theme = theme === null
              ? Prisma.JsonNull
              : ((sanitizeFormTheme(theme) ?? Prisma.JsonNull) as Prisma.InputJsonValue);
          }
          if (custom_css !== undefined) updateData.customCss = sanitizeCustomCss(custom_css);

          if (questions !== undefined) {
            const mappedFields = questions.map((q: any, i: number) => ({
              id: q.id || q.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30) || `field_${i}`,
              label: q.label,
              type: q.type === 'text' ? 'short_text'
                  : q.type === 'select' ? 'dropdown'
                  : q.type === 'checkbox' ? 'checkboxes'
                  : q.type === 'discord_connect' ? 'discord_connect'
                  : 'paragraph',
              required: q.required ?? true,
              description: q.placeholder || undefined,
              options: q.options || undefined,
              sectionIndex: 0,
            }));
            updateData.structure = {
              title: name || (existing as any).name,
              description: description || (existing as any).description || undefined,
              fields: mappedFields,
            };
          }

          const prismaData: Record<string, unknown> = { ...updateData };
          if (updateData.structure) {
            prismaData.structure = updateData.structure as Prisma.InputJsonValue;
          }
          await prisma.customForm.updateMany({
            where: { id: form_id, guildId },
            data: prismaData,
          });
          await audit(key_name, 'Mise à jour formulaire MCP', name || (existing as any).name, `ID: ${form_id}`);
          return ok({ ok: true, formId: form_id });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'delete_custom_form',
      {
        description: 'Supprime un formulaire personnalisé. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          form_id: z.string().describe('ID du formulaire à supprimer'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ form_id, key_name }) => {
        try {
          const existing = await prisma.customForm.findFirst({ where: { id: form_id, guildId } });
          if (!existing) return err('Formulaire introuvable');

          await deleteCustomForm(form_id, guildId);
          await audit(key_name, 'Suppression formulaire MCP', existing.name, `ID: ${form_id}`);
          return ok({ ok: true });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'update_custom_event',
      {
        description: 'Met à jour un événement existant. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          event_id: z.string().describe('ID de l\'événement à modifier'),
          title: z.string().optional().describe('Nouveau titre'),
          description: z.string().optional().describe('Nouvelle description'),
          start_time: z.string().optional().describe('Nouvelle date/heure de début (format ISO)'),
          end_time: z.string().optional().describe('Nouvelle date/heure de fin (format ISO)'),
          location: z.string().optional().describe('Nouveau lieu ou lien de l\'événement'),
          announcement_channel: z.string().optional().describe('Nouveau salon d\'annonce'),
          form_id: z.string().optional().describe('Nouveau formulaire lié'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ event_id, title, description, start_time, end_time, location, announcement_channel, form_id, key_name }) => {
        try {
          const existing = await prisma.event.findFirst({ where: { id: event_id, guildId } });
          if (!existing) return err('Événement introuvable');

          const updateData: any = {};
          if (title !== undefined) updateData.title = title;
          if (description !== undefined) updateData.description = description;
          if (start_time !== undefined) updateData.startDate = new Date(start_time);
          if (end_time !== undefined) updateData.endDate = new Date(end_time);
          if (location !== undefined) updateData.location = location;
          if (announcement_channel !== undefined) {
            const resolvedAnn = resolveChannel(guildId, client, announcement_channel);
            if (resolvedAnn.ok) {
              updateData.announcementChannelId = resolvedAnn.channel.id;
            }
          }
          if (form_id !== undefined) updateData.formId = form_id || null;

          await prisma.event.update({
            where: { id: event_id },
            data: updateData,
          });

          await audit(key_name, 'Mise à jour événement MCP', title || existing.title, `ID: ${event_id}`);
          return ok({ ok: true, eventId: event_id });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'delete_event',
      {
        description: 'Supprime un événement du serveur. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          event_id: z.string().describe('ID de l\'événement à supprimer'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ event_id, key_name }) => {
        try {
          const existing = await prisma.event.findFirst({ where: { id: event_id, guildId } });
          if (!existing) return err('Événement introuvable');

          await prisma.event.delete({ where: { id: event_id } });
          await audit(key_name, 'Suppression événement MCP', existing.title, `ID: ${event_id}`);
          return ok({ ok: true });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'update_giveaway',
      {
        description: 'Met à jour un giveaway actif. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          giveaway_id: z.string().describe('ID du giveaway à modifier'),
          prize: z.string().optional().describe('Nouveau lot'),
          description: z.string().optional().describe('Nouvelle description'),
          duration_minutes: z.number().int().min(1).optional().describe('Ajuster le temps restant en minutes à partir de maintenant'),
          // Meme plafond que `createGiveaway` : cette route ecrit en base sans
          // passer par lui, et un concours a cinquante gagnants n'aurait pu
          // naitre que par ici.
          winner_count: z.number().int().min(1).max(20).optional().describe('Nombre de gagnants, 20 au maximum'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ giveaway_id, prize, description, duration_minutes, winner_count, key_name }) => {
        try {
          const existing = await prisma.giveaway.findFirst({ where: { id: giveaway_id, guildId } });
          if (!existing) return err('Giveaway introuvable');
          if (existing.ended) return err('Impossible de modifier un giveaway terminé');

          const updateData: any = {};
          if (prize !== undefined) updateData.prize = prize;
          if (description !== undefined) updateData.description = description;
          if (duration_minutes !== undefined) {
            const endsAt = new Date();
            endsAt.setMinutes(endsAt.getMinutes() + duration_minutes);
            updateData.endsAt = endsAt;
          }
          if (winner_count !== undefined) updateData.winnerCount = winner_count;

          await prisma.giveaway.update({
            where: { id: giveaway_id },
            data: updateData,
          });

          // L'annonce n'etait redessinee qu'au clic d'un participant : changer
          // le lot ou la date laissait le message Discord mentir jusque-la.
          // Lancee sans attendre, comme apres un enregistrement de config.
          void refreshActiveGiveaways(client, guildId).catch(() => undefined);

          await audit(key_name, 'Mise à jour giveaway MCP', prize || existing.prize, `ID: ${giveaway_id}`);
          return ok({ ok: true, giveawayId: giveaway_id });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'delete_giveaway',
      {
        description: 'Supprime un giveaway. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          giveaway_id: z.string().describe('ID du giveaway à supprimer'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ giveaway_id, key_name }) => {
        try {
          const existing = await prisma.giveaway.findFirst({ where: { id: giveaway_id, guildId } });
          if (!existing) return err('Giveaway introuvable');

          // Passe par le service : l'annonce Discord part avec la ligne, sans
          // quoi le salon gardait un concours que plus rien ne cloturerait.
          await deleteGiveaway(client, giveaway_id, guildId);
          await audit(key_name, 'Suppression giveaway MCP', existing.prize, `ID: ${giveaway_id}`);
          return ok({ ok: true });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'update_quest_definition',
      {
        description: 'Met à jour une quête existante. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          quest_id: z.string().describe('ID de la quête à modifier'),
          name: z.string().optional(),
          description: z.string().optional(),
          type: z.enum(['SEND_MESSAGES', 'VOICE_MINUTES', 'REACT_MESSAGES', 'WIN_GAME', 'EARN_COINS', 'GIVE_REP', 'CREATE_THREADS', 'REPLY_MESSAGES']).optional(),
          frequency: z.enum(['DAILY', 'WEEKLY']).optional(),
          target: z.number().int().min(1).optional().describe('Objectif quantitatif'),
          reward_coins: z.number().int().optional(),
          reward_xp: z.number().int().optional(),
          enabled: z.boolean().optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ quest_id, name, description, type, frequency, target, reward_coins, reward_xp, enabled, key_name }) => {
        try {
          const existing = await prisma.questDefinition.findFirst({ where: { id: quest_id, guildId } });
          if (!existing) return err('Quête introuvable');

          const updateData: any = {};
          if (name !== undefined) updateData.name = name;
          if (description !== undefined) updateData.description = description;
          if (type !== undefined) updateData.type = type;
          if (frequency !== undefined) updateData.frequency = frequency;
          if (target !== undefined) updateData.target = target;
          if (reward_coins !== undefined) updateData.rewardCoins = reward_coins;
          if (reward_xp !== undefined) updateData.rewardXp = reward_xp;
          if (enabled !== undefined) updateData.enabled = enabled;

          await prisma.questDefinition.update({
            where: { id: quest_id },
            data: updateData,
          });
          await invalidateActiveQuests(guildId);

          await audit(key_name, 'Mise à jour quête MCP', name || existing.name, `ID: ${quest_id}`);
          return ok({ ok: true, questId: quest_id });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'delete_quest_definition',
      {
        description: 'Supprime une définition de quête. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          quest_id: z.string().describe('ID de la quête à supprimer'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ quest_id, key_name }) => {
        try {
          const existing = await prisma.questDefinition.findFirst({ where: { id: quest_id, guildId } });
          if (!existing) return err('Quête introuvable');

          await prisma.questDefinition.delete({ where: { id: quest_id } });
          await invalidateActiveQuests(guildId);
          await audit(key_name, 'Suppression quête MCP', existing.name, `ID: ${quest_id}`);
          return ok({ ok: true });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'update_auto_response',
      {
        description: 'Met à jour un déclencheur de réponse automatique existant. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          auto_response_id: z.string().describe('ID de la réponse automatique à modifier'),
          trigger: z.string().optional(),
          response: z.string().optional(),
          trigger_type: z.enum(['MESSAGE', 'FORM', 'TICKET']).optional(),
          match_type: z.enum(['EXACT', 'CONTAINS', 'REGEX']).optional(),
          role_to_add: z.string().optional(),
          role_to_remove: z.string().optional(),
          delete_trigger: z.boolean().optional(),
          enabled: z.boolean().optional(),
          allowed_channels: z.array(z.string()).optional(),
          banned_channels: z.array(z.string()).optional(),
          allowed_roles: z.array(z.string()).optional(),
          banned_roles: z.array(z.string()).optional(),
          reactions: z.array(z.string()).optional().describe('Liste des émojis à ajouter en réaction'),
          actions: z.string().optional().describe('Actions complexes au format JSON'),
          close_ticket: z.boolean().optional().describe('Fermer le ticket (si TICKET)'),
          reject_form: z.boolean().optional().describe('Rejeter le formulaire (si FORM)'),
          form_id: z.string().optional().describe('ID du formulaire (si FORM)'),
          form_question_label: z.string().optional().describe('Label ou question du formulaire (si FORM)'),
          ticket_type_id: z.string().optional().describe('ID du type de ticket (si TICKET)'),
          ticket_question_label: z.string().optional().describe('Label ou question du ticket (si TICKET)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ auto_response_id, trigger, response, trigger_type, match_type, role_to_add, role_to_remove, delete_trigger, enabled, allowed_channels, banned_channels, allowed_roles, banned_roles, reactions, actions, close_ticket, reject_form, form_id, form_question_label, ticket_type_id, ticket_question_label, key_name }) => {
        try {
          const existing = await prisma.autoResponse.findFirst({ where: { id: auto_response_id, guildId } });
          if (!existing) return err('Réponse automatique introuvable');

          const updateData: any = {};
          if (trigger !== undefined) updateData.trigger = trigger;
          if (response !== undefined) updateData.response = response;
          if (trigger_type !== undefined) updateData.triggerType = trigger_type;
          if (match_type !== undefined) updateData.matchType = match_type;
          if (role_to_add !== undefined) updateData.roleIdToAdd = role_to_add || null;
          if (role_to_remove !== undefined) updateData.roleIdToRemove = role_to_remove || null;
          if (delete_trigger !== undefined) updateData.deleteTrigger = delete_trigger;
          if (enabled !== undefined) updateData.enabled = enabled;
          if (allowed_channels !== undefined) updateData.allowedChannelIds = allowed_channels;
          if (banned_channels !== undefined) updateData.bannedChannelIds = banned_channels;
          if (allowed_roles !== undefined) updateData.allowedRoleIds = allowed_roles;
          if (banned_roles !== undefined) updateData.bannedRoleIds = banned_roles;
          if (reactions !== undefined) updateData.reactions = reactions;
          if (close_ticket !== undefined) updateData.closeTicket = close_ticket;
          if (reject_form !== undefined) updateData.rejectForm = reject_form;
          if (form_id !== undefined) updateData.formId = form_id || null;
          if (form_question_label !== undefined) updateData.formQuestionLabel = form_question_label || null;
          if (ticket_type_id !== undefined) updateData.ticketTypeId = ticket_type_id || null;
          if (ticket_question_label !== undefined) updateData.ticketQuestionLabel = ticket_question_label || null;
          if (actions !== undefined) {
            if (actions === '') {
              updateData.actions = null;
            } else {
              try {
                updateData.actions = JSON.parse(actions);
              } catch {
                return err('Le paramètre "actions" doit être une chaîne JSON valide.');
              }
            }
          }

          await prisma.autoResponse.update({
            where: { id: auto_response_id },
            data: updateData,
          });

          await audit(key_name, 'Mise à jour AutoResponse MCP', trigger || existing.trigger, `ID: ${auto_response_id}`);
          return ok({ ok: true, autoResponseId: auto_response_id });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'delete_auto_response',
      {
        description: 'Supprime un déclencheur de réponse automatique. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          auto_response_id: z.string().describe('ID de la réponse automatique à supprimer'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ auto_response_id, key_name }) => {
        try {
          const existing = await prisma.autoResponse.findFirst({ where: { id: auto_response_id, guildId } });
          if (!existing) return err('Réponse automatique introuvable');

          await prisma.autoResponse.delete({ where: { id: auto_response_id } });
          await audit(key_name, 'Suppression AutoResponse MCP', existing.trigger, `ID: ${auto_response_id}`);
          return ok({ ok: true });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'update_scheduled_task',
      {
        description: 'Met à jour une tâche planifiée existante. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          task_id: z.string().describe('ID de la tâche à modifier'),
          name: z.string().optional(),
          type: z.enum(['CHANNEL_RESET', 'SERVER_BACKUP', 'DATA_EXPORT']).optional(),
          cron: z.string().optional().describe('Expression Cron standard'),
          target_id: z.string().optional().describe('ID Discord cible (ex: salon)'),
          enabled: z.boolean().optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ task_id, name, type, cron, target_id, enabled, key_name }) => {
        try {
          const existing = await prisma.scheduledTask.findFirst({ where: { id: task_id, guildId } });
          if (!existing) return err('Tâche planifiée introuvable');

          const updateData: any = {};
          if (name !== undefined) updateData.name = name;
          if (type !== undefined) updateData.type = type;
          if (cron !== undefined) updateData.cron = cron;
          if (target_id !== undefined) updateData.targetId = target_id || null;
          if (enabled !== undefined) updateData.enabled = enabled;

          await prisma.scheduledTask.update({
            where: { id: task_id },
            data: updateData,
          });

          await audit(key_name, 'Mise à jour tâche planifiée MCP', name || existing.name, `ID: ${task_id}`);
          return ok({ ok: true, taskId: task_id });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'delete_scheduled_task',
      {
        description: 'Supprime une tâche planifiée. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          task_id: z.string().describe('ID de la tâche à supprimer'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ task_id, key_name }) => {
        try {
          const existing = await prisma.scheduledTask.findFirst({ where: { id: task_id, guildId } });
          if (!existing) return err('Tâche planifiée introuvable');

          await prisma.scheduledTask.delete({ where: { id: task_id } });
          await audit(key_name, 'Suppression tâche planifiée MCP', existing.name, `ID: ${task_id}`);
          return ok({ ok: true });
        } catch (e) {
          return toolError(e);
        }
      })
    );
  }
}
