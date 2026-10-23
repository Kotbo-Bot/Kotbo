/** Outils MCP - write messages (permission WRITE_MESSAGES). */
import { embedToV2 } from '../../../utils/patchV2.js';
import { type APIMessageTopLevelComponent, ComponentType, type GuildForumTagData, MessageFlags, TextDisplayBuilder } from 'discord.js';
import { z } from 'zod';
import { type McpToolContext, buildApiEmbed, buildV2MessageComponents, err, mcpEmbedSchema, ok, resolveChannel, resolveForum, resolveForumPost, resolveForumTagIds, resolveMember, serializeDiscordMessage, publicErrorMessage } from '../toolkit.js';
import { GENERIC_ERROR_MESSAGE } from '../../../utils/publicError.js';

export function registerWriteMessagesTools(ctx: McpToolContext) {
  const { server, guildId, client, shouldRegister, guard, audit, toolMeta } = ctx;

  if (shouldRegister('WRITE_MESSAGES')) {
    server.registerTool(
      'send_message',
      {
        description:
          'Envoie un message Discord en tant que bot, au format embed legacy v1 ou Components v2. Requiert WRITE_MESSAGES.',
        inputSchema: {
          channel: z.string().describe('Nom du salon (ex: « general »), mention <#id> ou ID'),
          content: z.string().max(4000).optional().describe('Texte (2000 max en v1, 4000 max par Text Display en v2)'),
          embed: mcpEmbedSchema.optional().describe('Embed structuré ; rendu en embed classique avec v1, en Container avec v2'),
          format: z.enum(['v1', 'v2']).default('v2').describe('v1 = content/embed legacy ; v2 = Components v2'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ channel, content, embed, format, key_name }) => {
        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;
        if (!content && !embed) return err('Renseigne content ou embed.');
        if (format === 'v1' && (content?.length ?? 0) > 2000) return err('Le contenu v1 est limité à 2000 caractères.');

        const sent = await (async () => {
          if (format === 'v1') {
            // Le prototype TextChannel#send est patché globalement par Kotbo pour convertir
            // les embeds en v2. L’API REST directe est volontaire ici afin de garantir un
            // véritable message legacy quand l’appelant choisit explicitement v1.
            const raw = await client.rest.post(`/channels/${resolved.channel.id}/messages`, {
              body: {
                ...(content !== undefined ? { content } : {}),
                ...(embed ? { embeds: [buildApiEmbed(embed)] } : {}),
                allowed_mentions: { parse: [] },
              },
            }) as { id: string };
            return resolved.channel.messages.fetch(raw.id);
          }

          return resolved.channel.send({
            components: buildV2MessageComponents(content, embed),
            flags: MessageFlags.IsComponentsV2,
            allowedMentions: { parse: [] },
          });
        })().catch((e) => {
          return publicErrorMessage(e, GENERIC_ERROR_MESSAGE, 'MCP');
        });
        if (typeof sent === 'string') return err(`Impossible d'envoyer le message : ${sent}`);

        await audit(
          key_name,
          'Message envoyé MCP',
          `Salon: #${resolved.channel.name} (${resolved.channel.id})`,
          `${format.toUpperCase()} - ${(content ?? embed?.title ?? embed?.description ?? '').slice(0, 200)}`
        );

        return ok({
          ok: true,
          messageId: sent.id,
          channelId: resolved.channel.id,
          channelName: resolved.channel.name,
          format,
        });
      })
    );

    server.registerTool(
      'edit_bot_message',
      {
        description:
          'Édite uniquement un message appartenant à Kotbo. Préserve automatiquement le format v1/v2 ; une conversion explicite v1 vers v2 est irréversible. Requiert WRITE_MESSAGES.',
        inputSchema: {
          channel: z.string().describe('Nom du salon ou article, mention <#id> ou ID'),
          message_id: z.string().describe('ID du message à éditer'),
          content: z.string().max(4000).nullable().optional().describe('Nouveau texte ; null ou chaîne vide le supprime'),
          embed: mcpEmbedSchema.nullable().optional().describe('Nouvel embed ; null le supprime'),
          format: z.enum(['auto', 'v1', 'v2']).default('auto').describe('auto conserve le format actuel'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ channel, message_id, content, embed, format, key_name }) => {
        if (content === undefined && embed === undefined) return err('Renseigne content et/ou embed à modifier.');
        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;

        const message = await resolved.channel.messages.fetch(message_id).catch(() => null);
        if (!message) return err(`Message ${message_id} introuvable dans #${resolved.channel.name}.`);
        if (!client.user || message.author.id !== client.user.id) {
          return err('Kotbo peut supprimer les messages d’autres membres, mais ne peut éditer que ses propres messages.');
        }

        const currentFormat = message.flags.has(MessageFlags.IsComponentsV2) ? 'v2' : 'v1';
        const targetFormat = format === 'auto' ? currentFormat : format;
        if (currentFormat === 'v2' && targetFormat === 'v1') {
          return err('Discord interdit de reconvertir un message Components v2 en embed/content v1. Utilise format=v2 ou auto.');
        }
        if (targetFormat === 'v1' && (content?.length ?? 0) > 2000) {
          return err('Le contenu v1 est limité à 2000 caractères.');
        }

        if (targetFormat === 'v1') {
          await client.rest.patch(`/channels/${resolved.channel.id}/messages/${message.id}`, {
            body: {
              ...(content !== undefined ? { content: content ?? '' } : {}),
              ...(embed !== undefined ? { embeds: embed ? [buildApiEmbed(embed)] : [] } : {}),
              allowed_mentions: { parse: [] },
            },
          });
        } else {
          let components: APIMessageTopLevelComponent[];
          if (currentFormat === 'v2') {
            // Sur un message v2, content pilote les Text Displays de premier
            // niveau et embed pilote les Containers. Les autres composants
            // (boutons, galeries, etc.) sont conservés.
            components = message.components.map((component) => component.toJSON());
            if (content !== undefined) {
              components = components.filter((component) => component.type !== ComponentType.TextDisplay);
              if (content) components.unshift(new TextDisplayBuilder().setContent(content).toJSON());
            }
            if (embed !== undefined) {
              components = components.filter((component) => component.type !== ComponentType.Container);
              if (embed) components.push(embedToV2(buildApiEmbed(embed)).toJSON());
            }
          } else {
            const existingEmbed = message.embeds[0]?.toJSON();
            const nextContent = content !== undefined ? content : message.content;
            const nextEmbed = embed !== undefined ? embed : existingEmbed;
            components = [
              ...(nextContent ? [new TextDisplayBuilder().setContent(nextContent).toJSON()] : []),
              ...(nextEmbed ? [embedToV2('thumbnail_url' in nextEmbed ? buildApiEmbed(nextEmbed) : nextEmbed).toJSON()] : []),
            ];
          }
          if (components.length === 0) return err('Un message Components v2 doit conserver au moins un composant.');
          await message.edit({
            // Discord exige d’effacer les champs legacy dans la même requête
            // lorsqu’un message v1 reçoit IS_COMPONENTS_V2 pour la première fois.
            ...(currentFormat === 'v1' ? { content: null, embeds: [] } : {}),
            components,
            flags: MessageFlags.IsComponentsV2,
            allowedMentions: { parse: [] },
          });
        }

        const updated = await resolved.channel.messages.fetch({ message: message.id, force: true }).catch(() => message);
        await audit(
          key_name,
          'Message édité MCP',
          `#${resolved.channel.name}`,
          `MessageID: ${message.id} - ${currentFormat} → ${targetFormat}`,
        );
        return ok({ ok: true, message: serializeDiscordMessage(updated, message.guild ?? undefined) });
      })
    );

    server.registerTool(
      'delete_messages',
      {
        description:
          'Supprime un ou plusieurs messages dans un salon Discord. ' +
          'Mode 1 (message_id) : supprime un message précis, appartenant à Kotbo ou à un autre membre (Gérer les messages requis dans ce second cas). ' +
          'Mode 2 (bulk) : supprime les N derniers messages du salon (max 100, < 14 jours). ' +
          'Requiert la permission WRITE_MESSAGES.',
        inputSchema: {
          channel: z.string().describe('Nom du salon, mention <#id> ou ID'),
          message_id: z.string().optional().describe('ID du message à supprimer (mode suppression unique)'),
          count: z.number().int().min(1).max(100).optional().describe('Nombre de messages récents à supprimer en bulk (max 100)'),
          user_filter: z.string().optional().describe('Limiter le bulk uniquement aux messages de ce membre (nom, mention ou ID)'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ channel, message_id, count, user_filter, key_name }) => {
        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;

        const ch = resolved.channel;

        // ── Mode 1 : suppression d'un message unique ──
        if (message_id) {
          const msg = await ch.messages.fetch(message_id).catch(() => null);
          if (!msg) return err(`Message ${message_id} introuvable dans #${ch.name}.`);

          const deleted = await msg.delete().then(() => true).catch(() => false);
          if (!deleted) return err('Impossible de supprimer le message (permissions insuffisantes ?).');

          const ownedByBot = msg.author.id === client.user?.id;
          await audit(
            key_name,
            'Suppression message MCP',
            `#${ch.name}`,
            `MessageID: ${message_id} - auteur: ${msg.author.id} - messageKotbo: ${ownedByBot}`,
          );
          return ok({
            ok: true,
            deleted: 1,
            messageId: message_id,
            channelId: ch.id,
            authorId: msg.author.id,
            ownedByBot,
          });
        }

        // ── Mode 2 : bulk delete ──
        const bulkCount = count ?? 10;

        // Résoudre l'éventuel filtre utilisateur
        let filterUserId: string | null = null;
        if (user_filter) {
          const ru = await resolveMember(guildId, user_filter);
          if (!ru.ok) return ru.response;
          filterUserId = ru.userId;
        }

        // Récupérer les messages (on prend plus pour compenser les anciens > 14 jours)
        const fetched = await ch.messages.fetch({ limit: Math.min(bulkCount * 3, 100) }).catch(() => null);
        if (!fetched) return err('Impossible de récupérer les messages (permissions insuffisantes ?).');

        const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
        const candidates = fetched
          .filter(m => m.createdTimestamp > twoWeeksAgo)
          .filter(m => !filterUserId || m.author.id === filterUserId)
          .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
          .first(bulkCount);

        if (candidates.length === 0) {
          return err('Aucun message éligible à la suppression (trop anciens ou filtre trop restrictif).');
        }

        let deletedCount = 0;
        if (candidates.length === 1) {
          // bulkDelete ne fonctionne pas pour 1 seul message
          const deleted = await candidates[0]!.delete().then(() => true).catch(() => false);
          deletedCount = deleted ? 1 : 0;
        } else {
          const result = await ch.bulkDelete(candidates, true).catch(() => null);
          deletedCount = result?.size ?? 0;
        }

        const filterLabel = filterUserId ? ` (filtre: <@${filterUserId}>)` : '';
        await audit(key_name, 'Suppression bulk MCP', `#${ch.name}${filterLabel}`, `${deletedCount} message(s) supprimé(s)`);
        return ok({ ok: true, deleted: deletedCount, channelId: ch.id, channelName: ch.name });
      })
    );

    server.registerTool(
      'create_forum_post',
      {
        description:
          'Crée un article dans un forum Discord avec contenu v1 ou Components v2 et tags optionnels. Requiert WRITE_MESSAGES.',
        inputSchema: {
          forum: z.string().describe('Nom, mention ou ID du forum'),
          title: z.string().min(1).max(100).describe('Titre de l’article'),
          content: z.string().max(4000).optional(),
          embed: mcpEmbedSchema.optional(),
          format: z.enum(['v1', 'v2']).default('v2'),
          tags: z.array(z.string()).max(5).default([]).describe('Noms ou IDs des tags à appliquer'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ forum, title, content, embed, format, tags, key_name }) => {
        const resolved = resolveForum(guildId, client, forum);
        if (!resolved.ok) return resolved.response;
        if (!content && !embed) return err('Renseigne content ou embed pour le premier message de l’article.');
        if (format === 'v1' && (content?.length ?? 0) > 2000) return err('Le contenu v1 est limité à 2000 caractères.');
        const resolvedTags = resolveForumTagIds(resolved.forum, tags);
        if (!resolvedTags.ok) return resolvedTags.response;

        const message = format === 'v1'
          ? {
              ...(content !== undefined ? { content } : {}),
              ...(embed ? { embeds: [buildApiEmbed(embed)] } : {}),
              allowedMentions: { parse: [] as never[] },
            }
          : {
              components: buildV2MessageComponents(content, embed),
              flags: MessageFlags.IsComponentsV2 as const,
              allowedMentions: { parse: [] as never[] },
            };

        const post = await resolved.forum.threads.create({
          name: title,
          message,
          appliedTags: resolvedTags.ids,
          reason: `Article créé via MCP${key_name ? ` (${key_name})` : ''}`,
        }).catch((error) => error instanceof Error ? error : new Error(String(error)));
        if (post instanceof Error) return err(`Impossible de créer l’article : ${post.message}`);

        await audit(key_name, 'Article forum créé MCP', `#${resolved.forum.name}`, `${post.name} (${post.id})`);
        return ok({
          ok: true,
          forumId: resolved.forum.id,
          postId: post.id,
          title: post.name,
          format,
          appliedTagIds: post.appliedTags,
        });
      })
    );

    server.registerTool(
      'reply_forum_post',
      {
        description: 'Répond à un article de forum en tant que Kotbo, au format v1 ou v2. Requiert WRITE_MESSAGES.',
        inputSchema: {
          forum: z.string().describe('Nom, mention ou ID du forum'),
          post: z.string().describe('Titre, mention ou ID de l’article'),
          content: z.string().max(4000).optional(),
          embed: mcpEmbedSchema.optional(),
          format: z.enum(['v1', 'v2']).default('v2'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ forum, post, content, embed, format, key_name }) => {
        const resolvedForum = resolveForum(guildId, client, forum);
        if (!resolvedForum.ok) return resolvedForum.response;
        const resolvedPost = await resolveForumPost(resolvedForum.forum, post);
        if (!resolvedPost.ok) return resolvedPost.response;
        if (!content && !embed) return err('Renseigne content ou embed.');
        if (format === 'v1' && (content?.length ?? 0) > 2000) return err('Le contenu v1 est limité à 2000 caractères.');

        const sent = format === 'v1'
          ? await (async () => {
              const raw = await client.rest.post(`/channels/${resolvedPost.post.id}/messages`, {
                body: {
                  ...(content !== undefined ? { content } : {}),
                  ...(embed ? { embeds: [buildApiEmbed(embed)] } : {}),
                  allowed_mentions: { parse: [] },
                },
              }) as { id: string };
              return resolvedPost.post.messages.fetch(raw.id);
            })().catch(() => null)
          : await resolvedPost.post.send({
              components: buildV2MessageComponents(content, embed),
              flags: MessageFlags.IsComponentsV2,
              allowedMentions: { parse: [] },
            }).catch(() => null);
        if (!sent) return err('Impossible de répondre à cet article (permissions insuffisantes ?).');

        await audit(key_name, 'Réponse forum MCP', resolvedPost.post.name, `MessageID: ${sent.id}`);
        return ok({ ok: true, postId: resolvedPost.post.id, messageId: sent.id, format });
      })
    );

    server.registerTool(
      'update_forum_post',
      {
        description:
          'Modifie le titre, l’état (archivé/verrouillé) et les tags appliqués à un article de forum. Requiert WRITE_MESSAGES.',
        inputSchema: {
          forum: z.string().describe('Nom, mention ou ID du forum'),
          post: z.string().describe('Titre, mention ou ID de l’article'),
          title: z.string().min(1).max(100).optional(),
          archived: z.boolean().optional(),
          locked: z.boolean().optional(),
          set_tags: z.array(z.string()).max(5).optional().describe('Remplace tous les tags par cette liste'),
          add_tags: z.array(z.string()).max(5).optional(),
          remove_tags: z.array(z.string()).max(5).optional(),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ forum, post, title, archived, locked, set_tags, add_tags, remove_tags, key_name }) => {
        if (title === undefined && archived === undefined && locked === undefined && set_tags === undefined && !add_tags?.length && !remove_tags?.length) {
          return err('Aucune modification demandée.');
        }
        if (set_tags !== undefined && (add_tags?.length || remove_tags?.length)) {
          return err('Utilise soit set_tags, soit add_tags/remove_tags, pas les deux modes à la fois.');
        }

        const resolvedForum = resolveForum(guildId, client, forum);
        if (!resolvedForum.ok) return resolvedForum.response;
        const resolvedPost = await resolveForumPost(resolvedForum.forum, post);
        if (!resolvedPost.ok) return resolvedPost.response;

        let nextTags = [...resolvedPost.post.appliedTags];
        if (set_tags !== undefined) {
          const tags = resolveForumTagIds(resolvedForum.forum, set_tags);
          if (!tags.ok) return tags.response;
          nextTags = tags.ids;
        } else {
          if (add_tags?.length) {
            const tags = resolveForumTagIds(resolvedForum.forum, add_tags);
            if (!tags.ok) return tags.response;
            nextTags = [...new Set([...nextTags, ...tags.ids])];
          }
          if (remove_tags?.length) {
            const tags = resolveForumTagIds(resolvedForum.forum, remove_tags);
            if (!tags.ok) return tags.response;
            const removed = new Set(tags.ids);
            nextTags = nextTags.filter((id) => !removed.has(id));
          }
        }
        if (nextTags.length > 5) return err('Discord limite un article à 5 tags appliqués.');

        const updated = await resolvedPost.post.edit({
          ...(title !== undefined ? { name: title } : {}),
          ...(archived !== undefined ? { archived } : {}),
          ...(locked !== undefined ? { locked } : {}),
          ...((set_tags !== undefined || add_tags?.length || remove_tags?.length) ? { appliedTags: nextTags } : {}),
          reason: `Article modifié via MCP${key_name ? ` (${key_name})` : ''}`,
        }).catch(() => null);
        if (!updated) return err('Impossible de modifier l’article (permission Gérer les fils requise selon l’action).');

        await audit(key_name, 'Article forum modifié MCP', `#${resolvedForum.forum.name}`, `${updated.name} (${updated.id})`);
        return ok({
          ok: true,
          postId: updated.id,
          title: updated.name,
          archived: updated.archived,
          locked: updated.locked,
          appliedTagIds: updated.appliedTags,
        });
      })
    );

    server.registerTool(
      'delete_forum_post',
      {
        description: 'Supprime définitivement un article de forum Discord et ses réponses. Requiert WRITE_MESSAGES.',
        inputSchema: {
          forum: z.string().describe('Nom, mention ou ID du forum'),
          post: z.string().describe('Titre, mention ou ID de l’article'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ forum, post, key_name }) => {
        const resolvedForum = resolveForum(guildId, client, forum);
        if (!resolvedForum.ok) return resolvedForum.response;
        const resolvedPost = await resolveForumPost(resolvedForum.forum, post);
        if (!resolvedPost.ok) return resolvedPost.response;
        const snapshot = { id: resolvedPost.post.id, name: resolvedPost.post.name };
        const deleted = await resolvedPost.post.delete(`Article supprimé via MCP${key_name ? ` (${key_name})` : ''}`)
          .then(() => true)
          .catch(() => false);
        if (!deleted) return err('Impossible de supprimer l’article (permission Gérer les fils requise).');

        await audit(key_name, 'Article forum supprimé MCP', `#${resolvedForum.forum.name}`, `${snapshot.name} (${snapshot.id})`);
        return ok({ ok: true, deleted: true, postId: snapshot.id, title: snapshot.name });
      })
    );

    server.registerTool(
      'manage_forum_tags',
      {
        description:
          'Crée, renomme, configure ou supprime un tag disponible dans un forum. Les articles utilisant un tag supprimé le perdent. Requiert WRITE_MESSAGES.',
        inputSchema: {
          forum: z.string().describe('Nom, mention ou ID du forum'),
          action: z.enum(['create', 'update', 'delete']),
          tag: z.string().optional().describe('Nom ou ID du tag existant (update/delete)'),
          name: z.string().min(1).max(20).optional().describe('Nom du nouveau tag (create) ou nouveau nom (update)'),
          moderated: z.boolean().optional().describe('Réserve l’application/retrait aux membres avec Gérer les fils'),
          emoji_id: z.string().nullable().optional().describe('ID d’emoji personnalisé, null pour le retirer'),
          emoji_name: z.string().nullable().optional().describe('Emoji Unicode, null pour le retirer'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ forum, action, tag, name, moderated, emoji_id, emoji_name, key_name }) => {
        const resolved = resolveForum(guildId, client, forum);
        if (!resolved.ok) return resolved.response;
        if (emoji_id && emoji_name) return err('Renseigne emoji_id ou emoji_name, jamais les deux.');

        const current: GuildForumTagData[] = resolved.forum.availableTags.map((item) => ({
          id: item.id,
          name: item.name,
          moderated: item.moderated,
          emoji: item.emoji,
        }));
        let next = [...current];

        if (action === 'create') {
          if (!name) return err('name est requis pour créer un tag.');
          if (current.some((item) => item.name.toLowerCase() === name.toLowerCase())) return err(`Le tag « ${name} » existe déjà.`);
          next.push({
            name,
            moderated: moderated ?? false,
            ...((emoji_id !== undefined || emoji_name !== undefined)
              ? { emoji: { id: emoji_id ?? null, name: emoji_name ?? null } }
              : {}),
          });
        } else {
          if (!tag) return err('tag est requis pour modifier ou supprimer un tag.');
          const matches = current.filter((item) => item.id === tag || item.name.toLowerCase() === tag.toLowerCase());
          if (matches.length !== 1) return err(matches.length === 0 ? `Tag « ${tag} » introuvable.` : `Tag « ${tag} » ambigu.`);
          const target = matches[0]!;
          if (action === 'delete') {
            next = current.filter((item) => item.id !== target.id);
          } else {
            next = current.map((item) => item.id === target.id
              ? {
                  ...item,
                  ...(name !== undefined ? { name } : {}),
                  ...(moderated !== undefined ? { moderated } : {}),
                  ...((emoji_id !== undefined || emoji_name !== undefined)
                    ? { emoji: { id: emoji_id ?? null, name: emoji_name ?? null } }
                    : {}),
                }
              : item);
          }
        }

        const updated = await resolved.forum.setAvailableTags(
          next,
          `Tags forum modifiés via MCP${key_name ? ` (${key_name})` : ''}`,
        ).catch(() => null);
        if (!updated) return err('Impossible de modifier les tags du forum (permission Gérer les salons requise).');

        await audit(key_name, 'Tags forum modifiés MCP', `#${resolved.forum.name}`, `${action}: ${tag ?? name ?? ''}`);
        return ok({
          ok: true,
          forumId: updated.id,
          tags: updated.availableTags.map((item) => ({ id: item.id, name: item.name, moderated: item.moderated, emoji: item.emoji })),
        });
      })
    );
  }
}
