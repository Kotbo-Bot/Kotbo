import { Message, EmbedBuilder, Client, ChannelType, PermissionFlagsBits, type TextBasedChannel, type GuildMember, type User } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { neutralizeMassMentions } from '../../utils/mentions.js';
import { firstKillRoleProblem } from './rpg/rpgFirstKillService.js';

import { testSafeRegex } from '../../utils/safeRegex.js';
interface WeightedMessage {
  message: string;
  weight: number;
}

function parseWeightedResponses(response: string | null): WeightedMessage[] | null {
  if (!response || !response.trim()) return null;
  try {
    const parsed = JSON.parse(response);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].message !== undefined) {
      return parsed.filter((m: any) => m.message && m.weight > 0) as WeightedMessage[];
    }
  } catch {}
  return null;
}

function pickWeightedResponse(responses: WeightedMessage[]): string {
  const totalWeight = responses.reduce((sum, r) => sum + r.weight, 0);
  let random = Math.random() * totalWeight;
  for (const r of responses) {
    random -= r.weight;
    if (random <= 0) return r.message;
  }
  return responses[responses.length - 1].message;
}

function resolveResponse(response: string | null): string | null {
  if (!response || !response.trim()) return null;
  const weighted = parseWeightedResponses(response);
  if (weighted && weighted.length > 0) {
    return pickWeightedResponse(weighted);
  }
  return response;
}

/**
 * Remplace les variables (`{user}`, `{username}`, `{server}`, `{channel}`) dans le texte
 * de réponse d'un déclencheur par leurs valeurs réelles pour le contexte donné.
 */
function resolveResponsePlaceholders(
  text: string,
  ctx: { userId: string; member?: GuildMember | null; user?: User | null; guildName?: string | null; channel?: TextBasedChannel | null }
): string {
  if (!text.includes('{')) return text;

  // Pseudo et tag viennent du membre : neutralisés pour qu'un « @everyone »
  // glissé dedans ne notifie pas tout le serveur.
  const username = neutralizeMassMentions(ctx.member?.displayName || ctx.user?.username || 'Utilisateur');
  const tag = neutralizeMassMentions(ctx.user?.username || ctx.member?.user.username || 'inconnu');
  const channelMention = ctx.channel && 'toString' in ctx.channel ? ctx.channel.toString() : '';

  return text
    .replace(/{user}/g, `<@${ctx.userId}>`)
    .replace(/{username}/g, username)
    .replace(/{tag}/g, tag)
    .replace(/{server}/g, ctx.guildName || '')
    .replace(/{channel}/g, channelMention);
}

function buildSendPayload(responseText: string): string | { embeds: EmbedBuilder[] } {
  const isJson = responseText.startsWith('{') && responseText.endsWith('}');
  if (isJson) {
    try {
      const embed = new EmbedBuilder(JSON.parse(responseText));
      return { embeds: [embed] };
    } catch {
      return responseText;
    }
  }
  return responseText;
}

/**
 * Résout le salon de logs du serveur staff lié (si un lien actif existe) pour y relayer une réponse.
 */
async function resolveStaffRelayChannel(client: Client, guildId: string): Promise<TextBasedChannel | null> {
  const staffLink = await prisma.staffServerLink.findFirst({ where: { mainGuildId: guildId, enabled: true } });
  if (!staffLink?.staffLogChannelId) return null;
  const staffGuild = client.guilds.cache.get(staffLink.staffGuildId) || await client.guilds.fetch(staffLink.staffGuildId).catch(() => null);
  const channel = staffGuild?.channels.cache.get(staffLink.staffLogChannelId);
  return channel?.isTextBased() ? (channel as TextBasedChannel) : null;
}

/**
 * Envoie le message de réponse d'un déclencheur vers sa destination configurée
 * (MP, salon du déclencheur, ou salon spécifique), puis relaie sur le serveur staff si demandé.
 */
async function dispatchTriggerResponse(
  client: Client,
  guildId: string,
  item: Pick<AutoResponse, 'responseDestination' | 'responseChannelId' | 'relayToStaffServer'>,
  responseText: string,
  targetUserId: string,
  options: { contextChannel?: TextBasedChannel | null; replyToMessage?: Message | null; member?: GuildMember | null; guildName?: string | null } = {}
) {
  const resolvedText = resolveResponsePlaceholders(responseText, {
    userId: targetUserId,
    member: options.member,
    user: options.member?.user,
    guildName: options.guildName,
    channel: options.contextChannel,
  });
  const payload = buildSendPayload(resolvedText);
  const destination = item.responseDestination || 'DM';

  if (destination === 'CHANNEL' && options.contextChannel?.isSendable()) {
    const channel = options.contextChannel;
    if (options.replyToMessage) {
      await options.replyToMessage.reply(payload).catch(async () => { await channel.send(payload).catch(() => null); });
    } else {
      await channel.send(payload).catch(() => null);
    }
  } else if (destination === 'SPECIFIC_CHANNEL' && item.responseChannelId) {
    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    const channel = guild?.channels.cache.get(item.responseChannelId);
    if (channel?.isTextBased() && channel.isSendable()) {
      await channel.send(payload).catch(() => null);
    } else {
      const user = await client.users.fetch(targetUserId).catch(() => null);
      await user?.send(payload).catch(() => null);
    }
  } else {
    const user = await client.users.fetch(targetUserId).catch(() => null);
    await user?.send(payload).catch(() => null);
  }

  if (item.relayToStaffServer) {
    const relayChannel = await resolveStaffRelayChannel(client, guildId).catch(() => null);
    if (relayChannel?.isSendable()) await relayChannel.send(payload).catch(() => null);
  }
}

interface AutoResponse {
  id: string;
  guildId: string;
  triggerType: string;
  trigger: string;
  response: string | null;
  matchType: string;
  enabled: boolean;
  roleIdToAdd: string | null;
  roleIdToRemove: string | null;
  deleteTrigger: boolean;
  allowedRoleIds: string[];
  bannedRoleIds: string[];
  allowedChannelIds: string[];
  bannedChannelIds: string[];
  formId: string | null;
  formQuestionLabel: string | null;
  ticketTypeId: string | null;
  ticketQuestionLabel: string | null;
  closeTicket: boolean;
  rejectForm: boolean;
  reactions: string[];
  actions: any;
  responseDestination: string | null;
  responseChannelId: string | null;
  relayToStaffServer: boolean;
}

// Cache for triggers: key is guildId, value is list of auto responses
const responsesCache = new Map<string, AutoResponse[]>();

/**
 * Invalide le cache des auto-réponses pour une guilde donnée
 */
/**
 * Donne le rôle d'une réponse automatique, après contrôle à l'exécution : une règle déjà en base
 * (ou écrite par l'agent MCP) ne doit jamais distribuer un rôle Administrateur, @everyone ou
 * géré. Le bot étant l'exécutant, le verrou d'administration ne verrait pas l'ajout.
 */
async function addAutoResponseRole(member: GuildMember, roleId: string): Promise<void> {
  const role = member.guild.roles.cache.get(roleId) ?? await member.guild.roles.fetch(roleId).catch(() => null);
  const problem = firstKillRoleProblem(member.guild, role);
  if (problem) throw new Error(`Rôle refusé pour une réponse automatique : ${problem}`);
  await member.roles.add(roleId);
}

export function invalidateAutoResponseCache(guildId: string) {
  responsesCache.delete(guildId);
}

/**
 * Charge ou récupère depuis le cache les auto-réponses d'une guilde
 */
export async function getAutoResponsesForGuild(guildId: string): Promise<AutoResponse[]> {
  let list = responsesCache.get(guildId);
  if (!list) {
    const dbList = await prisma.autoResponse.findMany({
      where: { guildId, enabled: true },
    });
    list = dbList as unknown as AutoResponse[];
    responsesCache.set(guildId, list);
  }
  return list;
}

/**
 * Analyse un message et envoie une réponse automatique si un mot-clé correspond
 */
export async function handleAutoResponse(message: Message) {
  if (!message.guildId || message.author.bot) return;

  try {
    const responses = await getAutoResponsesForGuild(message.guildId);
    if (responses.length === 0) return;

    const content = message.content.trim();
    const contentLower = content.toLowerCase();

    for (const item of responses) {
      // Ignorer les triggers qui ne sont pas de type MESSAGE
      if (item.triggerType && item.triggerType !== 'MESSAGE') continue;

      let isMatch = false;

      if (item.matchType === 'EXACT') {
        isMatch = contentLower === item.trigger.toLowerCase();
      } else if (item.matchType === 'CONTAINS') {
        isMatch = contentLower.includes(item.trigger.toLowerCase());
      } else if (item.matchType === 'REGEX') {
        try {
          isMatch = testSafeRegex(item.trigger, content);
        } catch (e) {
          logger.warn('AutoResponseService', `Regex invalide pour l'auto-réponse ${item.id}:`, e);
        }
      }

      if (isMatch) {
        // ── Filtres salon ──────────────────────────────────────────────
        const channelId = message.channelId;
        if (item.bannedChannelIds?.length && item.bannedChannelIds.includes(channelId)) continue;
        if (item.allowedChannelIds?.length && !item.allowedChannelIds.includes(channelId)) continue;

        // ── Filtres rôle ───────────────────────────────────────────────
        const member = message.member || await message.guild?.members.fetch(message.author.id).catch(() => null);
        if (item.bannedRoleIds?.length && member?.roles.cache.some((r) => item.bannedRoleIds.includes(r.id))) continue;
        if (item.allowedRoleIds?.length && !member?.roles.cache.some((r) => item.allowedRoleIds.includes(r.id))) continue;

        // 1. Actions sur les rôles
        if (member) {
          if (item.roleIdToAdd) {
            await addAutoResponseRole(member, item.roleIdToAdd).catch((e) => {
              logger.error('AutoResponseService', `Impossible d'ajouter le rôle ${item.roleIdToAdd} au membre ${member.id}:`, e);
            });
          }
          if (item.roleIdToRemove) {
            await member.roles.remove(item.roleIdToRemove).catch((e) => {
              logger.error('AutoResponseService', `Impossible de retirer le rôle ${item.roleIdToRemove} du membre ${member.id}:`, e);
            });
          }
        }

        // 2. Suppression du message déclencheur si requis
        if (item.deleteTrigger) {
          await message.delete().catch((e) => {
            logger.error('AutoResponseService', `Impossible de supprimer le message déclencheur ${message.id}:`, e);
          });
        }

        // 2.5. Réactions automatiques
        if (item.reactions && item.reactions.length > 0 && !item.deleteTrigger) {
          for (const emoji of item.reactions) {
            await message.react(emoji).catch((e) => {
              logger.error('AutoResponseService', `Impossible de réagir avec ${emoji} au message ${message.id}:`, e);
            });
          }
        }

        // 2.6. Actions complexes (CRUD, DMs, timeouts, etc.)
        if (item.actions) {
          try {
            const actions = typeof item.actions === 'string' ? JSON.parse(item.actions) : item.actions;

            // Envoi de DM
            if (actions.sendDm && typeof actions.sendDm === 'string') {
              await message.author.send(actions.sendDm).catch((e) => {
                logger.error('AutoResponseService', `Impossible d'envoyer le DM à ${message.author.id}:`, e);
              });
            }

            // Timeout temporaire
            if (actions.timeoutSeconds && typeof actions.timeoutSeconds === 'number' && member) {
              await member.timeout(actions.timeoutSeconds * 1000, 'Déclenché par AutoResponse').catch((e) => {
                logger.error('AutoResponseService', `Impossible d'exécuter le timeout sur ${member.id}:`, e);
              });
            }

            // Alerte Staff
            if (actions.staffAlertChannelId && typeof actions.staffAlertChannelId === 'string' && actions.staffAlertMessage) {
              const alertChan = message.guild?.channels.cache.get(actions.staffAlertChannelId);
              if (alertChan?.isTextBased()) {
                await alertChan.send(actions.staffAlertMessage).catch(() => null);
              }
            }

            // Gain d'XP. `actions` vient d'un JSON libre : un montant négatif y
            // est parfaitement saisissable et doit retirer de l'XP, sans quoi la
            // règle ne ferait rien du tout.
            if (typeof actions.addXp === 'number' && actions.addXp !== 0) {
              const { addXp, removeXp } = await import('../../services/progression/levelingService.js');
              const applied = actions.addXp > 0
                ? addXp(message.guildId, message.author.id, actions.addXp, message.client, message.channelId)
                : removeXp(message.guildId, message.author.id, -actions.addXp, message.client);
              await applied.catch(() => null);
            }

            // CRUD Salons
            if (actions.createChannel) {
              const cc = actions.createChannel;
              if (cc.name && typeof cc.name === 'string') {
                const channelTypeMap: Record<string, number> = {
                  text: ChannelType.GuildText,
                  voice: ChannelType.GuildVoice,
                  category: ChannelType.GuildCategory,
                };
                await message.guild?.channels.create({
                  name: cc.name,
                  type: channelTypeMap[cc.type] || ChannelType.GuildText,
                  parent: cc.categoryId || undefined,
                }).catch(() => null);
              }
            }

            if (actions.deleteChannelId && typeof actions.deleteChannelId === 'string') {
              const ch = message.guild?.channels.cache.get(actions.deleteChannelId);
              if (ch) {
                await ch.delete('Déclenché par AutoResponse').catch(() => null);
              }
            }

            // CRUD Rôles
            if (actions.createRole) {
              const cr = actions.createRole;
              if (cr.name && typeof cr.name === 'string') {
                await message.guild?.roles.create({
                  name: cr.name,
                  color: cr.color || undefined,
                  reason: 'Déclenché par AutoResponse',
                }).catch(() => null);
              }
            }

            if (actions.deleteRoleId && typeof actions.deleteRoleId === 'string') {
              const r = message.guild?.roles.cache.get(actions.deleteRoleId);
              if (r) {
                await r.delete('Déclenché par AutoResponse').catch(() => null);
              }
            }

            // Création de Thread (reprendre le truc d'autothread)
            if (actions.createThread && !item.deleteTrigger) {
              const channel = message.channel;
              if (!channel.isThread() && ('guild' in channel)) {
                const botMember = message.guild?.members.me ?? await message.guild?.members.fetchMe();
                const permissions = botMember?.permissionsIn(channel as any);
                if (permissions?.has(PermissionFlagsBits.CreatePublicThreads) &&
                    permissions?.has(PermissionFlagsBits.SendMessagesInThreads)) {

                  let rawName = message.content ? message.content.replace(/[\n\r]+/g, ' ').trim() : '';
                  let authorName = message.member?.displayName || message.author.displayName || message.author.username;

                  if (!rawName && message.embeds.length > 0) {
                    const embed = message.embeds[0];
                    rawName = (embed.description || embed.title || '').replace(/[\n\r]+/g, ' ').trim();
                    if (embed.author?.name) authorName = embed.author.name;
                  }

                  const cleanContent = rawName.substring(0, 40);
                  let threadName = '';
                  
                  if (typeof actions.createThread === 'string') {
                    threadName = actions.createThread
                      .replace(/{user}/g, authorName)
                      .replace(/{content}/g, cleanContent);
                  } else {
                    threadName = cleanContent
                      ? `Fil de ${authorName} - ${cleanContent}...`
                      : `Fil de ${authorName}`;
                  }

                  await message.startThread({
                    name: threadName.substring(0, 100),
                    autoArchiveDuration: 1440,
                    reason: 'Créé via AutoResponse.',
                  }).catch((e: unknown) => {
                    logger.error('AutoResponseService', `Erreur lors de la création du fil pour le message ${message.id}:`, e);
                  });
                }
              }
            }
          } catch (e) {
            logger.error('AutoResponseService', `Erreur lors de l'exécution des actions pour ${item.id}:`, e);
          }
        }

        // 3. Envoi de la réponse si elle existe
        const responseText = resolveResponse(item.response);
        if (responseText && responseText.trim()) {
          const contextChannel = message.channel.isTextBased() ? (message.channel as TextBasedChannel) : null;
          await dispatchTriggerResponse(message.client, message.guildId, item, responseText, message.author.id, {
            contextChannel,
            replyToMessage: item.deleteTrigger ? null : message,
            member,
            guildName: message.guild?.name,
          });
        }

        // 4. Fermeture du ticket si requis
        if (item.closeTicket) {
          const ticket = await prisma.ticket.findFirst({
            where: {
              guildId: message.guildId,
              status: 'OPEN',
              OR: [
                { channelId: message.channelId },
                { threadId: message.channelId }
              ]
            }
          });
          if (ticket) {
            const { closeTicket: performClose } = await import('./ticketService.js');
            await performClose(message.client, ticket.id, message.author.id, message.author.username).catch(err => {
              logger.error('AutoResponseService', `Erreur lors de la fermeture automatique du ticket ${ticket.id} via message:`, err);
            });
          }
        }

        return;
      }
    }
  } catch (err) {
    logger.error('AutoResponseService', `Erreur lors de l'analyse du message pour auto-réponse:`, err);
  }
}

/**
 * Exécute les déclencheurs de formulaires
 */
export async function handleFormTrigger(
  guildId: string,
  userId: string,
  formId: string,
  answers: Record<string, string>,
  client: Client
) {
  try {
    const responses = await getAutoResponsesForGuild(guildId);
    const triggers = responses.filter(
      (item) => item.enabled && item.triggerType === 'FORM' && item.formId === formId
    );

    if (triggers.length === 0) return;

    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return;

    const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);

    for (const item of triggers) {
      if (!item.formQuestionLabel) continue;

      // Recherche de la réponse de la question par libellé (insensible à la casse)
      const questionKeys = Object.keys(answers);
      const matchedKey = questionKeys.find(
        (k) => k.toLowerCase() === item.formQuestionLabel!.toLowerCase() || answers[k] === item.formQuestionLabel
      );

      if (!matchedKey) continue;
      const answerValue = answers[matchedKey];
      if (!answerValue) continue;

      let isMatch = false;
      const triggerLower = item.trigger.toLowerCase();
      const answerLower = answerValue.toLowerCase();

      if (item.matchType === 'EXACT') {
        isMatch = answerLower === triggerLower;
      } else if (item.matchType === 'CONTAINS') {
        isMatch = answerLower.includes(triggerLower);
      } else if (item.matchType === 'REGEX') {
        try {
          isMatch = testSafeRegex(item.trigger, answerValue);
        } catch (e) {
          logger.warn('AutoResponseService', `Regex invalide pour l'auto-réponse formulaire ${item.id}:`, e);
        }
      }

      if (isMatch) {
        // Exécuter les actions
        if (member) {
          if (item.roleIdToAdd) {
            await addAutoResponseRole(member, item.roleIdToAdd).catch((e) => {
              logger.error('AutoResponseService', `Impossible d'ajouter le rôle ${item.roleIdToAdd} au membre ${member.id} via formulaire:`, e);
            });
          }
          if (item.roleIdToRemove) {
            await member.roles.remove(item.roleIdToRemove).catch((e) => {
              logger.error('AutoResponseService', `Impossible de retirer le rôle ${item.roleIdToRemove} du membre ${member.id} via formulaire:`, e);
            });
          }
        }

        // Nouvelle action : Rejeter le formulaire / la candidature
        if (item.rejectForm) {
          const candidature = await prisma.recruitmentCandidature.findFirst({
            where: {
              guildId,
              discordId: userId,
              status: 'PENDING',
              OR: [
                { formId: formId },
                { customFormId: formId }
              ]
            },
            orderBy: { createdAt: 'desc' }
          });

          if (candidature) {
            const rejectMessage = resolveResponse(item.response) || 'Rejet automatique via déclencheur';
            const { rejectCandidature: performReject } = await import('../staff/recruitmentService.js');
            await performReject(
              client,
              guildId,
              candidature.id,
              rejectMessage,
              client.user?.id || 'system'
            ).catch(err => {
              logger.error('AutoResponseService', `Erreur lors du rejet de la candidature ${candidature.id}:`, err);
            });
          }
        } else {
          const resolvedFormResponse = resolveResponse(item.response);
          if (resolvedFormResponse && resolvedFormResponse.trim()) {
            await dispatchTriggerResponse(client, guildId, item, resolvedFormResponse, userId, { member, guildName: guild.name }).catch((e) => {
              logger.error('AutoResponseService', `Impossible d'envoyer la réponse pour trigger de formulaire:`, e);
            });
          }
        }
      }
    }
  } catch (err) {
    logger.error('AutoResponseService', 'Erreur lors du traitement des déclencheurs de formulaires:', err);
  }
}

/**
 * Exécute les déclencheurs de tickets
 */
export async function handleTicketTrigger(
  guildId: string,
  userId: string,
  ticketTypeId: string | null,
  reason: string,
  description: string,
  client: Client,
  ticketId?: string
) {
  try {
    const responses = await getAutoResponsesForGuild(guildId);
    const triggers = responses.filter(
      (item) => item.enabled && item.triggerType === 'TICKET'
    );

    if (triggers.length === 0) return;

    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return;

    const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);

    for (const item of triggers) {
      // Filtrer par type de ticket si configuré
      if (item.ticketTypeId && item.ticketTypeId !== ticketTypeId) continue;

      // Choisir le champ à vérifier (raison par défaut, ou description)
      const fieldToCheck = item.ticketQuestionLabel === 'description' ? description : reason;
      if (!fieldToCheck) continue;

      let isMatch = false;
      const triggerLower = item.trigger.toLowerCase();
      const valueLower = fieldToCheck.toLowerCase();

      if (item.matchType === 'EXACT') {
        isMatch = valueLower === triggerLower;
      } else if (item.matchType === 'CONTAINS') {
        isMatch = valueLower.includes(triggerLower);
      } else if (item.matchType === 'REGEX') {
        try {
          isMatch = testSafeRegex(item.trigger, fieldToCheck);
        } catch (e) {
          logger.warn('AutoResponseService', `Regex invalide pour l'auto-réponse ticket ${item.id}:`, e);
        }
      }

      if (isMatch) {
        // Exécuter les actions
        if (member) {
          if (item.roleIdToAdd) {
            await addAutoResponseRole(member, item.roleIdToAdd).catch((e) => {
              logger.error('AutoResponseService', `Impossible d'ajouter le rôle ${item.roleIdToAdd} au membre ${member.id} via ticket:`, e);
            });
          }
          if (item.roleIdToRemove) {
            await member.roles.remove(item.roleIdToRemove).catch((e) => {
              logger.error('AutoResponseService', `Impossible de retirer le rôle ${item.roleIdToRemove} du membre ${member.id} via ticket:`, e);
            });
          }
        }

        const resolvedTicketResponse = resolveResponse(item.response);
        if (resolvedTicketResponse && resolvedTicketResponse.trim()) {
          let contextChannel: TextBasedChannel | null = null;
          if (ticketId) {
            const ticket = await prisma.ticket.findUnique({
              where: { id: ticketId },
              select: { channelId: true, threadId: true },
            }).catch(() => null);
            const contextChannelId = ticket?.threadId || ticket?.channelId;
            if (contextChannelId) {
              const ch = client.channels.cache.get(contextChannelId) || await client.channels.fetch(contextChannelId).catch(() => null);
              if (ch?.isTextBased()) contextChannel = ch as TextBasedChannel;
            }
          }
          await dispatchTriggerResponse(client, guildId, item, resolvedTicketResponse, userId, { contextChannel, member, guildName: guild.name }).catch((e) => {
            logger.error('AutoResponseService', `Impossible d'envoyer la réponse pour trigger de ticket:`, e);
          });
        }

        // Nouvelle action : Fermer le ticket
        if (item.closeTicket && ticketId) {
          const { closeTicket: performClose } = await import('./ticketService.js');
          await performClose(client, ticketId, client.user?.id || 'system', client.user?.username || 'System').catch(err => {
            logger.error('AutoResponseService', `Erreur lors de la fermeture automatique du ticket ${ticketId}:`, err);
          });
        }
      }
    }
  } catch (err) {
    logger.error('AutoResponseService', 'Erreur lors du traitement des déclencheurs de tickets:', err);
  }
}
