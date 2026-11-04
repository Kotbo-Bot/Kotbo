import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type Message,
  type TextChannel,
} from 'discord.js';
import { currentCascadeDepth } from '@kotbo/core';
import {
  getNodeDef,
  MAX_TEMPORARY_ROLE_MINUTES,
  MAX_WORKFLOW_COINS,
  MAX_WORKFLOW_XP,
} from '@kotbo/shared';
import { SanctionType } from '@prisma/client';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { isModuleEnabled } from '../../core/moduleGate.js';
import { memberProfileIdentity } from '../../moderation/memberIdentityService.js';
import type { WorkflowEffects } from './engine.js';
import { claimCooldown, getVariable, updateVariable } from './workflowStore.js';
import { MEMBER_NOTE_MAX_LENGTH, appendAutomaticNoteLine, formatAutomaticNoteLine } from './memberNote.js';
import { expectBotNickname } from './nicknameEcho.js';
import { expectBotRoleChange } from './roleEcho.js';
import { keepMessage, serialized } from './keptMessage.js';
import {
  coerceToNumber,
  coerceToString,
  isChannel,
  isMember,
  isMessage,
  isRole,
  type ChannelValue,
  type MemberValue,
  type MessageValue,
  type RoleValue,
} from './values.js';
import { UserFacingError } from '../../../utils/userFacingError.js';
import {
  CHANNEL_REQUIREMENTS,
  GUILD_REQUIREMENTS,
  describeMissingPermissions,
  inThread,
  missingPermissions,
  type BotPermission,
} from './actionPermissions.js';

/**
 * Pont entre le moteur de workflows et Discord.
 *
 * Le moteur ne connaît que cette interface : tout ce qui touche à discord.js
 * ou à la base est isolé ici, ce qui laisse l'interpréteur testable sans bot.
 */

// ============================================================================
// CONVERSION DEPUIS DISCORD
// ============================================================================

export function toMemberValue(member: GuildMember): MemberValue {
  return {
    kind: 'Member',
    id: member.id,
    tag: member.user.tag,
    displayName: member.displayName,
    isBot: member.user.bot,
    roleIds: [...member.roles.cache.keys()],
    accountCreatedAt: member.user.createdTimestamp ?? null,
    joinedAt: member.joinedTimestamp ?? null,
  };
}

export function toRoleValue(role: { id: string; name: string }): RoleValue {
  return { kind: 'Role', id: role.id, name: role.name };
}

export function toChannelValue(channel: {
  id: string;
  name: string;
  parent?: { name: string } | null;
}): ChannelValue {
  return {
    kind: 'Channel',
    id: channel.id,
    name: channel.name,
    categoryName: channel.parent?.name ?? null,
  };
}

export function toMessageValue(message: {
  id: string;
  content: string;
  channelId: string;
  authorId: string;
}): MessageValue {
  return {
    kind: 'Message',
    id: message.id,
    content: message.content,
    channelId: message.channelId,
    authorId: message.authorId,
  };
}

// ============================================================================
// ACTIONS
// ============================================================================

/** Une action refusée par Discord doit remonter un message exploitable. */
class WorkflowActionError extends UserFacingError {
  constructor(action: string, detail: string) {
    super(`${action} : ${detail}`);
    this.name = 'WorkflowActionError';
  }
}

async function resolveMember(guild: Guild, value: unknown): Promise<GuildMember> {
  if (!isMember(value)) throw new WorkflowActionError('Membre', 'entrée absente ou invalide');
  const member = guild.members.cache.get(value.id) ?? await guild.members.fetch(value.id).catch(() => null);
  if (!member) throw new WorkflowActionError('Membre', `${value.tag} est introuvable sur le serveur`);
  return member;
}

async function resolveTextChannel(guild: Guild, value: unknown): Promise<TextChannel> {
  if (!isChannel(value)) throw new WorkflowActionError('Salon', 'entrée absente ou invalide');
  const channel = guild.channels.cache.get(value.id) ?? await guild.channels.fetch(value.id).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    throw new WorkflowActionError('Salon', `${value.name} est introuvable ou n'accepte pas de message`);
  }
  return channel as TextChannel;
}

/**
 * Rôle que le bot a le droit de gérer. Contrôlé avant d'agir : Discord refuse
 * sinon avec une erreur de permission qui ne dit ni quel rôle ni pourquoi.
 */
async function resolveManageableRole(guild: Guild, value: unknown, action: string) {
  if (!isRole(value)) throw new WorkflowActionError(action, 'rôle absent ou invalide');

  const role = guild.roles.cache.get(value.id) ?? await guild.roles.fetch(value.id).catch(() => null);
  if (!role) throw new WorkflowActionError(action, `${value.name} est introuvable`);

  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles) || role.position >= me.roles.highest.position) {
    throw new WorkflowActionError(action, `le bot ne peut pas gérer ${role.name} (hiérarchie ou permission)`);
  }
  if (role.managed) {
    throw new WorkflowActionError(action, `${role.name} est géré par une intégration et ne s'attribue pas`);
  }
  return role;
}

/**
 * Quantité entière saisie ou venue du contexte.
 *
 * Sous le minimum, l'action échoue plutôt que d'agir avec une valeur
 * inventée : un jeton de texte non numérique vaut 0, et « donner 0 pièce »
 * cacherait l'erreur de saisie. Au-dessus du plafond, la valeur est ramenée au
 * plafond, que l'éditeur simple impose déjà.
 */
function boundedAmount(raw: unknown, max: number, action: string, what: string): number {
  const value = Math.floor(coerceToNumber(raw));
  if (value < 1) throw new WorkflowActionError(action, `${what} invalide (${coerceToString(raw) || 'vide'}), minimum 1`);
  return Math.min(value, max);
}

function parseColor(raw: unknown): number {
  const value = coerceToString(raw).replace('#', '');
  const parsed = Number.parseInt(value, 16);
  return Number.isFinite(parsed) ? parsed : 0x5865f2;
}

/** Discord refuse tout contenu vide et tronque au-delà de 2000 caractères. */
function safeContent(raw: unknown, action: string): string {
  const text = coerceToString(raw).trim();
  if (!text) throw new WorkflowActionError(action, 'le texte est vide');
  return text.slice(0, 2000);
}

/** Salon d'un message transporté, sans recharger le message lui-même. */
async function resolveMessageChannel(guild: Guild, value: unknown, action: string): Promise<TextChannel> {
  if (!isMessage(value)) throw new WorkflowActionError(action, 'message absent ou invalide');

  const channel = guild.channels.cache.get(value.channelId)
    ?? await guild.channels.fetch(value.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    throw new WorkflowActionError(action, 'le salon du message est introuvable');
  }
  return channel as TextChannel;
}

/** Salon de logs configuré pour le serveur. */
async function resolveLogChannel(guild: Guild, action: string): Promise<TextChannel> {
  const config = await prisma.guild.findUnique({ where: { id: guild.id }, select: { logChannelId: true } });
  if (!config?.logChannelId) {
    throw new WorkflowActionError(action, 'aucun salon de logs n\'est configuré sur le serveur');
  }

  const channel = guild.channels.cache.get(config.logChannelId)
    ?? await guild.channels.fetch(config.logChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    throw new WorkflowActionError(action, 'le salon de logs configuré est introuvable');
  }
  return channel as TextChannel;
}

/**
 * Retrouve le vrai message Discord derrière la valeur transportée.
 *
 * Le moteur ne garde qu'un instantané sérialisable : agir dessus - supprimer,
 * épingler, réagir - demande de le recharger. Un message effacé entre-temps est
 * le cas normal, pas une anomalie du workflow, mais l'action ne peut pas
 * aboutir et le dit.
 */
async function resolveMessage(guild: Guild, value: unknown, action: string): Promise<Message> {
  const channel = await resolveMessageChannel(guild, value, action);
  const message = await channel.messages.fetch((value as MessageValue).id).catch(() => null);
  if (!message) throw new WorkflowActionError(action, 'le message n\'existe plus');
  return message;
}

/**
 * Identité portée par les sanctions qu'un workflow prononce.
 *
 * Elles sont enregistrées au nom du bot : le casier du membre, les statistiques
 * et les alertes du staff doivent montrer d'où vient la décision.
 */
function botActor(guild: Guild): { id: string; tag: string } {
  const me = guild.members.me;
  return { id: me?.id ?? guild.client.user?.id ?? '0', tag: me?.user.tag ?? 'Kotbo' };
}

/** Discord attend `nom:id` pour un émoji du serveur, l'unicode tel quel. */
function normalizeEmoji(raw: unknown): string {
  const value = coerceToString(raw).trim();
  if (!value) throw new WorkflowActionError('Réagir à un message', 'aucun émoji indiqué');
  const custom = value.match(/^<a?:(\w+):(\d+)>$/);
  return custom ? `${custom[1]}:${custom[2]}` : value;
}

/**
 * Charge le service de sanctions à la demande.
 *
 * En import statique, la chaîne `sanctionService` -> `dashboardApi` -> routes
 * -> `workflowService` reviendrait sur ce fichier. Le projet dénoue ce genre de
 * boucle par un import dynamique, comme le fait déjà `sanctionService` pour le
 * service de seuil de vérification.
 */
function sanctions() {
  return import('../../moderation/sanctionService.js');
}

/**
 * Même boucle que `sanctions()`. Le MP de contestation part avant l'expulsion
 * ou le bannissement : une fois sorti, le membre ne partage plus forcément de
 * serveur avec le bot et ne recevrait jamais le lien de demande de débannissement.
 */
async function sendAppealLinkBeforeRemoval(guild: Guild, member: GuildMember, type: SanctionType): Promise<void> {
  const { sendPreActionAppealDM } = await import('../../moderation/banAppealService.js');
  await sendPreActionAppealDM(guild.client, guild.id, member.id, type).catch(() => false);
}

const MODULE_REQUIREMENTS: Partial<Record<string, { module: string; label: string }>> = {
  TimeoutMember: { module: 'sanctions', label: 'Sanctions' },
  KickMember: { module: 'sanctions', label: 'Sanctions' },
  BanMember: { module: 'sanctions', label: 'Sanctions' },
  CreateTicket: { module: 'tickets', label: 'Tickets' },
  GiveCoins: { module: 'economy', label: 'Économie' },
  RemoveCoins: { module: 'economy', label: 'Économie' },
  GiveXp: { module: 'leveling', label: 'Leveling' },
};

/** Ce que le bot doit pouvoir faire au membre visé, contrôlé par discord.js. */
const MEMBER_REQUIREMENTS: Partial<Record<string, { allowed: (member: GuildMember) => boolean; refusal: string }>> = {
  SetNickname: { allowed: (member) => member.manageable, refusal: 'est au-dessus du bot' },
  TimeoutMember: { allowed: (member) => member.moderatable, refusal: 'ne peut pas être modéré' },
  KickMember: { allowed: (member) => member.kickable, refusal: 'ne peut pas être expulsé' },
  BanMember: { allowed: (member) => member.bannable, refusal: 'ne peut pas être banni' },
  GiveCoins: { allowed: (member) => !member.user.bot, refusal: 'est un bot, sans solde' },
  RemoveCoins: { allowed: (member) => !member.user.bot, refusal: 'est un bot, sans solde' },
  GiveXp: { allowed: (member) => !member.user.bot, refusal: 'est un bot, sans niveau' },
};

const ROLE_ACTIONS = new Set(['AddRole', 'RemoveRole', 'AddTemporaryRole']);

function actionLabel(type: string): string {
  return getNodeDef(type)?.label ?? type;
}

function requirePermissions(
  action: string,
  required: readonly BotPermission[] | undefined,
  has: ((permission: BotPermission) => boolean) | null,
  channelName: string | null,
): void {
  // Sans le membre du bot en cache, rien ne permet de conclure : Discord
  // tranchera, comme avant ce contrôle.
  if (!required || !has) return;
  const missing = missingPermissions(required, has);
  if (missing.length > 0) throw new WorkflowActionError(action, describeMissingPermissions(missing, channelName));
}

/**
 * Ce que le bot doit pouvoir faire pour qu'une action aboutisse : module
 * actif, permissions dans le salon visé et sur le serveur, rôle et membre à sa
 * portée. Rien n'est modifié.
 *
 * Appelé avant chaque vraie action, et seul pendant l'essai à blanc : l'essai
 * signale ainsi exactement ce que la vraie exécution refuserait.
 */
async function checkAction(
  guild: Guild,
  type: string,
  inputs: Record<string, unknown>,
  ahead = false,
): Promise<void> {
  const action = actionLabel(type);
  // À l'avance, une entrée encore inconnue (membre, message, salon venus du
  // déclencheur) ne se vérifie pas : seule l'exécution la fournira.
  const unknown = (value: unknown) => ahead && (value === undefined || value === null);

  const gate = MODULE_REQUIREMENTS[type];
  if (gate && !(await isModuleEnabled(guild.id, gate.module))) {
    throw new WorkflowActionError(action, `le module ${gate.label} est désactivé`);
  }

  const me = guild.members.me;
  requirePermissions(
    action,
    GUILD_REQUIREMENTS[type],
    me ? (permission) => me.permissions.has(PermissionFlagsBits[permission]) : null,
    null,
  );

  const requirement = CHANNEL_REQUIREMENTS[type];
  const channelInput = requirement?.target === 'channel' ? inputs.channel : requirement?.target === 'message' ? inputs.message : true;
  if (requirement && !unknown(channelInput)) {
    const channel = requirement.target === 'channel'
      ? await resolveTextChannel(guild, inputs.channel)
      : requirement.target === 'message'
        ? await resolveMessageChannel(guild, inputs.message, action)
        : await resolveLogChannel(guild, action);
    const granted = me ? channel.permissionsFor(me) : null;
    requirePermissions(
      action,
      channel.isThread() ? inThread(requirement.permissions) : requirement.permissions,
      granted ? (permission) => granted.has(PermissionFlagsBits[permission]) : null,
      channel.name,
    );
  }

  if (ROLE_ACTIONS.has(type) && !unknown(inputs.role)) await resolveManageableRole(guild, inputs.role, action);

  const target = MEMBER_REQUIREMENTS[type];
  if (target && !unknown(inputs.member)) {
    const member = await resolveMember(guild, inputs.member);
    if (!target.allowed(member)) throw new WorkflowActionError(action, `${member.user.tag} ${target.refusal}`);
  }
}

/**
 * Vérifie une action avant toute exécution, avec les seules entrées connues à
 * l'enregistrement (salons et rôles choisis dans l'éditeur).
 */
export function checkActionAhead(guild: Guild, type: string, inputs: Record<string, unknown>): Promise<void> {
  return checkAction(guild, type, inputs, true);
}

/**
 * `workflowId` n'est requis que par le délai de récupération, propre à chaque
 * automatisation : sans lui, le délai laisse passer.
 */
export function createWorkflowEffects(guild: Guild, workflowId?: string): WorkflowEffects {
  return {
    ...(workflowId
      ? { claimCooldown: (nodeId: string, subject: string, seconds: number) => claimCooldown(workflowId, nodeId, subject, seconds) }
      : {}),
    getVariable: (name, subject) => getVariable(guild.id, name, subject),
    updateVariable: (name, subject, operation, amount) => updateVariable(guild.id, name, subject, operation, amount),

    async getRole(roleId) {
      if (!roleId) return null;
      const role = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId).catch(() => null);
      return role ? toRoleValue(role) : null;
    },

    async getChannel(channelId) {
      if (!channelId) return null;
      const channel = guild.channels.cache.get(channelId)
        ?? await guild.channels.fetch(channelId).catch(() => null);
      return channel && 'name' in channel ? toChannelValue(channel) : null;
    },

    async getMember(userId) {
      if (!userId) return null;
      const member = guild.members.cache.get(userId)
        ?? await guild.members.fetch(userId).catch(() => null);
      return member ? toMemberValue(member) : null;
    },

    async getGuildInfo() {
      return { name: guild.name, memberCount: guild.memberCount };
    },

    checkAction: (type, inputs) => checkAction(guild, type, inputs),

    async runAction(type, inputs, config, context) {
      await checkAction(guild, type, inputs);
      switch (type) {
        case 'KeepMessage': {
          const action = 'Tenir un message à jour';
          const channel = await resolveTextChannel(guild, inputs.channel);
          const text = safeContent(inputs.text, action);
          // Sans automatisation enregistrée (appel hors moteur), rien à quoi
          // rattacher le message : il est simplement publié.
          if (!workflowId || !context) {
            const sent = await channel.send(text);
            return { message: toMessageValue({ id: sent.id, content: text, channelId: channel.id, authorId: sent.author.id }) };
          }
          const where = { workflowId_nodeId: { workflowId, nodeId: context.nodeId } };
          const kept = await serialized(`${workflowId}:${context.nodeId}`, () => keepMessage(channel.id, text, {
            load: () => prisma.workflowKeptMessage.findUnique({ where, select: { channelId: true, messageId: true } }),
            save: async (ref) => {
              await prisma.workflowKeptMessage.upsert({
                where,
                create: { workflowId, nodeId: context.nodeId, ...ref },
                update: ref,
              });
            },
            edit: async (ref, content) => {
              const message = await channel.messages.fetch(ref.messageId).catch(() => null);
              if (!message) return false;
              await message.edit(content);
              return true;
            },
            send: async (_channelId, content) => (await channel.send(content)).id,
          }));
          return {
            message: toMessageValue({ id: kept.messageId, content: text, channelId: kept.channelId, authorId: guild.client.user?.id ?? '' }),
          };
        }

        case 'SendMessage': {
          const channel = await resolveTextChannel(guild, inputs.channel);
          await channel.send(safeContent(inputs.text, 'Envoyer un message'));
          return {};
        }

        case 'SendEmbed': {
          const channel = await resolveTextChannel(guild, inputs.channel);
          const embed = new EmbedBuilder().setColor(parseColor(config.color));
          const title = coerceToString(inputs.title).slice(0, 256);
          const description = coerceToString(inputs.description).slice(0, 4096);
          if (title) embed.setTitle(title);
          if (description) embed.setDescription(description);
          if (!title && !description) throw new WorkflowActionError('Envoyer un embed', 'titre et description vides');
          await channel.send({ embeds: [embed] });
          return {};
        }

        case 'SendDM': {
          const target = inputs.member;
          if (!isMember(target)) throw new WorkflowActionError('Membre', 'entrée absente ou invalide');
          const member = guild.members.cache.get(target.id) ?? await guild.members.fetch(target.id).catch(() => null);
          // Un membre expulsé ou banni ne partage plus de serveur avec le bot :
          // Discord refuserait le MP, comme pour des MP fermés.
          if (!member) {
            logger.debug('Workflow', `MP impossible vers ${target.tag} (plus sur le serveur).`);
            return {};
          }
          // Des MP fermés sont un cas normal, pas une erreur de workflow.
          await member.send(safeContent(inputs.text, 'Envoyer un message privé')).catch(() => {
            logger.debug('Workflow', `MP impossible vers ${member.user.tag} (messages privés fermés).`);
          });
          return {};
        }

        case 'AddRole':
        case 'RemoveRole': {
          const member = await resolveMember(guild, inputs.member);
          const role = await resolveManageableRole(guild, inputs.role, 'Rôle');

          // Annoncé avant d'agir : l'événement que Discord renverra est le
          // nôtre, à dépêcher dans la cascade en cours (cf. roleEcho.ts). Pas
          // d'annonce sans changement : Discord ne renverrait rien, et
          // l'annonce avalerait le prochain geste identique d'un humain.
          const kind = type === 'AddRole' ? 'added' : 'removed';
          const willChange = member.roles.cache.has(role.id) !== (kind === 'added');
          const forget = willChange
            ? expectBotRoleChange(guild.id, member.id, role.id, kind, currentCascadeDepth())
            : () => {};
          try {
            if (type === 'AddRole') await member.roles.add(role, 'Workflow');
            else await member.roles.remove(role, 'Workflow');
          } catch (error) {
            forget();
            throw error;
          }
          return {};
        }

        case 'SetNickname': {
          const member = await resolveMember(guild, inputs.member);
          const nickname = coerceToString(inputs.nickname).slice(0, 32) || null;
          // Annoncé avant l'appel : la mise à jour de Discord peut arriver
          // avant que la requête ne rende la main.
          const forget = expectBotNickname(guild.id, member.id, nickname);
          try {
            await member.setNickname(nickname, 'Workflow');
          } catch (error) {
            forget();
            throw error;
          }
          return {};
        }

        /**
         * Les trois sanctions passent par `sanctionService` plutôt que par
         * discord.js seul : c'est lui qui tient le casier du membre, les
         * statistiques de modération, l'alerte du staff et la propagation aux
         * comptes liés. Agir en direct laissait ces actions sans aucune trace,
         * invisibles de la fiche membre comme des rapports.
         */
        case 'TimeoutMember': {
          const member = await resolveMember(guild, inputs.member);
          const minutes = Math.max(1, Math.min(40_320, coerceToNumber(inputs.minutes)));

          // `registerTimeoutSanction` applique l'exclusion elle-même.
          await (await sanctions()).registerTimeoutSanction({
            guildId: guild.id,
            target: { id: member.id, tag: member.user.tag },
            moderator: botActor(guild),
            reason: coerceToString(inputs.reason) || 'Automatisation',
            durationMs: minutes * 60_000,
            member,
            client: guild.client,
          });
          return {};
        }

        case 'KickMember': {
          const member = await resolveMember(guild, inputs.member);

          const reason = coerceToString(inputs.reason) || 'Automatisation';
          const target = { id: member.id, tag: member.user.tag };
          await sendAppealLinkBeforeRemoval(guild, member, SanctionType.KICK);
          await member.kick(reason);
          await (await sanctions()).registerKickSanction({
            guildId: guild.id,
            target,
            moderator: botActor(guild),
            reason,
            client: guild.client,
          }).catch(() => null);
          return {};
        }

        case 'BanMember': {
          const member = await resolveMember(guild, inputs.member);

          const days = Math.max(0, Math.min(3650, coerceToNumber(inputs.days)));
          const reason = coerceToString(inputs.reason) || 'Automatisation';
          const target = { id: member.id, tag: member.user.tag };

          await sendAppealLinkBeforeRemoval(guild, member, days > 0 ? SanctionType.TEMP_BAN : SanctionType.BAN);
          await member.ban({ reason, deleteMessageSeconds: 0 });
          await (await sanctions()).registerBanSanction({
            guildId: guild.id,
            target,
            moderator: botActor(guild),
            reason,
            // Zéro jour vaut bannissement définitif : le service choisit
            // BAN ou TEMP_BAN selon la présence d'une durée.
            temporaryDurationMs: days > 0 ? days * 86_400_000 : undefined,
            client: guild.client,
          }).catch(() => null);
          return {};
        }

        case 'DeleteMessage': {
          const message = await resolveMessage(guild, inputs.message, 'Supprimer un message');
          if (!message.deletable) {
            throw new WorkflowActionError('Supprimer un message', 'le bot n\'a pas le droit de le supprimer');
          }
          await message.delete();
          return {};
        }

        case 'AddReaction': {
          const message = await resolveMessage(guild, inputs.message, 'Réagir à un message');
          const emoji = normalizeEmoji(inputs.emoji);
          try {
            await message.react(emoji);
          } catch {
            // Un émoji d'un autre serveur ou mal orthographié : Discord répond
            // par une erreur peu lisible, on la reformule.
            throw new WorkflowActionError('Réagir à un message', `émoji « ${coerceToString(inputs.emoji)} » refusé par Discord`);
          }
          return {};
        }

        case 'PinMessage': {
          const message = await resolveMessage(guild, inputs.message, 'Épingler un message');
          if (message.pinned) return {};
          try {
            await message.pin();
          } catch {
            // Deux causes se ressemblent de l'extérieur : le plafond de
            // cinquante épingles par salon, et le droit manquant. Les nommer
            // toutes deux vaut mieux que d'en affirmer une au hasard.
            throw new WorkflowActionError(
              'Épingler un message',
              'refusé par Discord : salon plein (50 épingles) ou permission « Gérer les messages » manquante',
            );
          }
          return {};
        }

        case 'CreateThread': {
          const channel = await resolveTextChannel(guild, inputs.channel);
          const name = coerceToString(inputs.name).trim().slice(0, 100);
          if (!name) throw new WorkflowActionError('Ouvrir un fil', 'le nom du fil est vide');
          if (typeof channel.threads?.create !== 'function') {
            throw new WorkflowActionError('Ouvrir un fil', `${channel.name} n'accepte pas de fil`);
          }

          const thread = await channel.threads.create({
            name,
            autoArchiveDuration: 1440,
            reason: 'Automatisation',
          });
          return { thread: toChannelValue(thread) };
        }

        case 'CreateTicket': {
          const member = await resolveMember(guild, inputs.member);
          const subject = coerceToString(inputs.subject).slice(0, 100) || 'Ticket automatique';
          const channel = await createTicketChannel(guild, member, subject);
          return { channel: toChannelValue(channel) };
        }

        case 'ReplyToMessage': {
          const action = 'Répondre à un message';
          const channel = await resolveMessageChannel(guild, inputs.message, action);
          const value = inputs.message as MessageValue;

          // `failIfNotExists: false` : un message effacé entre-temps (un
          // workflow qui supprime puis répond, un membre qui efface le sien)
          // n'empêche pas la réponse, qui part alors sans citation.
          await channel.send({
            content: safeContent(inputs.text, action),
            reply: { messageReference: value.id, failIfNotExists: false },
          });
          return {};
        }

        case 'AddTemporaryRole': {
          const action = 'Donner un rôle temporaire';
          const member = await resolveMember(guild, inputs.member);
          const role = await resolveManageableRole(guild, inputs.role, action);
          const minutes = boundedAmount(inputs.minutes, MAX_TEMPORARY_ROLE_MINUTES, action, 'durée');

          const key = { guildId: guild.id, userId: member.id, roleId: role.id };
          const existing = await prisma.workflowTemporaryRole.findUnique({ where: { guildId_userId_roleId: key } });

          // Un rôle déjà porté sans trace de cette action a été donné par
          // quelqu'un d'autre : le retirer à l'échéance le reprendrait à tort.
          if (!existing && member.roles.cache.has(role.id)) return {};

          // Une prolongation ne raccourcit jamais une échéance plus lointaine.
          const requested = new Date(Date.now() + minutes * 60_000);
          const expiresAt = existing && existing.expiresAt > requested ? existing.expiresAt : requested;

          // L'échéance est écrite avant le rôle : dans l'ordre inverse, une panne
          // de base entre les deux laisserait un rôle que personne ne retirerait.
          await prisma.workflowTemporaryRole.upsert({
            where: { guildId_userId_roleId: key },
            create: { ...key, expiresAt },
            update: { expiresAt, attempts: 0 },
          });

          if (!member.roles.cache.has(role.id)) {
            const forget = expectBotRoleChange(guild.id, member.id, role.id, 'added', currentCascadeDepth());
            try {
              await member.roles.add(role, 'Automatisation : rôle temporaire');
            } catch (error) {
              forget();
              if (!existing) {
                await prisma.workflowTemporaryRole.deleteMany({ where: key }).catch(() => null);
              }
              throw error;
            }
          }
          return {};
        }

        case 'GiveCoins':
        case 'RemoveCoins': {
          const action = type === 'GiveCoins' ? 'Donner des pièces' : 'Retirer des pièces';
          const member = await resolveMember(guild, inputs.member);
          const amount = boundedAmount(inputs.amount, MAX_WORKFLOW_COINS, action, 'montant');
          const where = { guildId: guild.id, userId: member.id };

          if (type === 'GiveCoins') {
            const profile = await prisma.rpgProfile.upsert({
              where: { guildId_userId: where },
              create: { ...where, balance: amount },
              update: { balance: { increment: amount } },
              select: { balance: true },
            });
            return { balance: profile.balance };
          }

          // Deux écritures conditionnelles plutôt qu'une lecture puis une
          // écriture : un gain versé entre les deux serait sinon écrasé. Un
          // solde trop court est ramené à zéro, jamais en négatif. La boucle
          // couvre le cas où le solde franchit le seuil entre les deux.
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const debited = await prisma.rpgProfile.updateMany({
              where: { ...where, balance: { gte: amount } },
              data: { balance: { decrement: amount } },
            });
            if (debited.count > 0) break;

            const emptied = await prisma.rpgProfile.updateMany({
              where: { ...where, balance: { lt: amount } },
              data: { balance: 0 },
            });
            if (emptied.count > 0) break;

            // Ni l'un ni l'autre : le membre n'a pas de profil, rien à retirer.
            const exists = await prisma.rpgProfile.findUnique({ where: { guildId_userId: where }, select: { id: true } });
            if (!exists) break;
          }

          const profile = await prisma.rpgProfile.findUnique({
            where: { guildId_userId: where },
            select: { balance: true },
          });
          return { balance: profile?.balance ?? 0 };
        }

        case 'GiveXp': {
          const action = 'Donner de l\'XP';
          const member = await resolveMember(guild, inputs.member);
          const amount = boundedAmount(inputs.amount, MAX_WORKFLOW_XP, action, 'quantité d\'XP');

          // Import dynamique : le service de niveaux charge le rendu des cartes
          // de rang, inutile à chaque exécution de workflow qui ne s'en sert pas.
          const { addXp } = await import('../../progression/levelingService.js');
          await addXp(guild.id, member.id, amount, guild.client);
          return {};
        }

        case 'AddMemberNote': {
          const action = 'Ajouter une note au membre';
          const member = await resolveMember(guild, inputs.member);
          // Coupé par caractère et non par unité UTF-16 : un émoji tranché en
          // deux laisserait un demi-caractère illisible dans la fiche.
          const text = Array.from(coerceToString(inputs.text).replace(/\s+/g, ' ').trim()).slice(0, 300).join('');
          if (!text) throw new WorkflowActionError(action, 'la note est vide');

          const where = { guildId_userId: { guildId: guild.id, userId: member.id } };
          const profile = await prisma.memberProfile.findUnique({ where, select: { moderatorNote: true } });
          const line = formatAutomaticNoteLine(text, new Date());
          const note = appendAutomaticNoteLine(profile?.moderatorNote ?? null, line);
          if (note === null) {
            throw new WorkflowActionError(
              action,
              `la note de ${member.user.tag} est pleine (${MEMBER_NOTE_MAX_LENGTH} caractères) et ne contient aucune ligne automatique à retirer`,
            );
          }

          await prisma.memberProfile.upsert({
            where,
            update: { moderatorNote: note },
            create: {
              guildId: guild.id,
              userId: member.id,
              ...memberProfileIdentity(member),
              moderatorNote: note,
              lastSeenAt: new Date(),
            },
          });
          return {};
        }

        case 'SendLogMessage': {
          const action = 'Écrire dans les logs';
          const text = coerceToString(inputs.text).trim().slice(0, 4096);
          if (!text) throw new WorkflowActionError(action, 'le texte est vide');

          const channel = await resolveLogChannel(guild, action);

          await channel.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0x5865f2)
                .setDescription(text)
                .setFooter({ text: 'Automatisation' })
                .setTimestamp(),
            ],
          });
          return {};
        }

        default:
          throw new WorkflowActionError(type, 'action inconnue');
      }
    },
  };
}

/**
 * Ouvre un salon de ticket au nom d'un membre.
 *
 * Le service de tickets historique part d'une interaction Discord, dont un
 * workflow ne dispose pas : on recrée donc ici le strict nécessaire, en
 * réutilisant la catégorie et le rôle staff configurés pour le serveur.
 */
async function createTicketChannel(guild: Guild, member: GuildMember, subject: string): Promise<TextChannel> {
  const config = await prisma.guild.findUnique({
    where: { id: guild.id },
    select: { ticketCategoryId: true, ticketStaffRoleId: true },
  });

  const channel = await guild.channels.create({
    name: `ticket-${member.user.username}`.slice(0, 100),
    type: ChannelType.GuildText,
    parent: config?.ticketCategoryId ?? undefined,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: member.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      },
      ...(config?.ticketStaffRoleId
        ? [{
          id: config.ticketStaffRoleId,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
        }]
        : []),
    ],
  });

  await prisma.ticket.create({
    data: {
      guildId: guild.id,
      channelId: channel.id,
      mode: 'CHANNEL',
      userId: member.id,
      username: member.user.username,
      reason: subject,
      description: 'Ticket ouvert automatiquement par un workflow.',
      staffRoleId: config?.ticketStaffRoleId ?? null,
      categoryId: config?.ticketCategoryId ?? null,
    },
  });

  await channel.send({
    content: `${member}${config?.ticketStaffRoleId ? ` <@&${config.ticketStaffRoleId}>` : ''}`,
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('🎫 Ticket ouvert automatiquement')
        .setDescription(subject),
    ],
  }).catch(() => null);

  return channel;
}
