/**
 * otherServersFilter.ts - Automod « Autres serveurs ».
 *
 * Trois comportements, réglés chacun sur OFF, BLACKLIST ou WHITELIST avec une
 * même liste de serveurs :
 *  - invitations vers un autre serveur (y compris ptb./canary., et celles
 *    cachées dans un embed, un bouton ou un message transféré) ;
 *  - messages transférés depuis un autre serveur, et liens vers un salon ou
 *    un événement d'un autre serveur ;
 *  - tag d'un autre serveur affiché sur le profil : le membre est mis en
 *    quarantaine (Jail) tant qu'il l'affiche, et libéré dès qu'il le retire.
 *
 * Le serveur lui-même passe toujours ; le staff (Gérer le serveur ou Gérer les
 * messages) n'est jamais visé.
 */

import {
  InviteType,
  MessageReferenceType,
  PermissionFlagsBits,
  type Client,
  type GuildMember,
  type Message,
} from 'discord.js';
import type { RaidProtectionConfig } from '@prisma/client';
import { logger } from '../../utils/logger.js';
import { getCachedGuild } from '../../utils/cache.js';
import { resolveLogChannel } from '../../utils/logChannel.js';
import { getRaidProtectionConfig } from './raidProtectionService.js';
import { applyAutoSanction, autoSanctionLabel, normalizeAutoSanction } from './autoSanction.js';
import { getActiveJail, isJailConfigured, releaseJail } from './jailService.js';
import { registerJailSanction } from './sanctionService.js';

export type ListMode = 'OFF' | 'BLACKLIST' | 'WHITELIST';
export const MAX_OTHER_SERVERS = 25;

function mode(value: string | null | undefined): ListMode {
  return value === 'BLACKLIST' || value === 'WHITELIST' ? value : 'OFF';
}

export function listedServerIds(config: RaidProtectionConfig): Set<string> {
  return new Set(config.otherServers.map((entry) => entry.split('|')[0]).filter(Boolean));
}

/** Un serveur est-il refusé par ce mode ? (`null` = serveur inconnu) */
export function isRefused(listMode: ListMode, guildId: string | null, ownGuildId: string, listed: Set<string>): boolean {
  if (listMode === 'OFF' || guildId === ownGuildId) return false;
  if (listMode === 'BLACKLIST') return guildId !== null && listed.has(guildId);
  // Liste blanche : seuls les serveurs listés passent, une invitation
  // invérifiable aussi est refusée.
  return guildId === null || !listed.has(guildId);
}

// ── Lecture des invitations et des liens ───────────────────────────────────

// Les caractères invisibles et les espaces autour des points servent à casser
// les filtres : « discord . gg / abc ».
const INVISIBLE = /[​-‍⁠﻿­]/g;
const INVITE_REGEX = /(?:https?:\/\/)?(?:(?:www|ptb|canary)\.)?(?:discord(?:app)?\s*\.\s*com\s*\/\s*invite|discord\s*\.\s*gg)\s*\/\s*([a-z0-9-]{2,32})/gi;
const GUILD_LINK_REGEX = /(?:https?:\/\/)?(?:(?:www|ptb|canary)\.)?discord(?:app)?\.com\/(channels|events)\/(\d{17,20})\//gi;

/** Tout le texte d'un message où une invitation peut se cacher. */
export function messageTexts(message: Message): string[] {
  const texts: string[] = [message.content];
  const fromEmbeds = (embeds: Message['embeds']) => {
    for (const e of embeds) {
      texts.push(e.title ?? '', e.description ?? '', e.url ?? '', e.footer?.text ?? '', e.author?.name ?? '', e.author?.url ?? '');
      for (const f of e.fields) texts.push(f.name, f.value);
    }
  };
  fromEmbeds(message.embeds);
  // Boutons-liens des composants (les messages de bots relayés en contiennent).
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const data = node as { url?: string; components?: unknown[]; data?: { url?: string } };
    if (typeof data.url === 'string') texts.push(data.url);
    if (typeof data.data?.url === 'string') texts.push(data.data.url);
    for (const child of data.components ?? []) walk(child);
  };
  for (const row of message.components ?? []) walk(row);
  for (const snapshot of message.messageSnapshots?.values() ?? []) {
    texts.push(snapshot.content ?? '');
    fromEmbeds(snapshot.embeds);
  }
  return texts.filter(Boolean).map((t) => t.replace(INVISIBLE, ''));
}

export function extractInviteCodes(texts: string[]): string[] {
  const codes = new Set<string>();
  for (const text of texts) for (const match of text.matchAll(INVITE_REGEX)) codes.add(match[1]);
  return [...codes].slice(0, 10);
}

export function extractGuildLinks(texts: string[]): string[] {
  const ids = new Set<string>();
  for (const text of texts) for (const match of text.matchAll(GUILD_LINK_REGEX)) ids.add(match[2]);
  return [...ids];
}

type ResolvedInvite = { kind: 'GUILD'; guildId: string; guildName: string } | { kind: 'FRIEND' | 'GROUP' } | { kind: 'INVALID' };

const INVITE_TTL_MS = 60 * 60 * 1000;
const inviteCache = new Map<string, { value: ResolvedInvite; expiresAt: number }>();

/** Serveur visé par une invitation, mis en cache une heure (les invitations de raid tournent en boucle). */
export async function resolveInvite(client: Client, code: string): Promise<ResolvedInvite> {
  const cached = inviteCache.get(code.toLowerCase());
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  let value: ResolvedInvite = { kind: 'INVALID' };
  try {
    const invite = await client.fetchInvite(code);
    if (invite.type === InviteType.Friend) value = { kind: 'FRIEND' };
    else if (invite.type === InviteType.GroupDM) value = { kind: 'GROUP' };
    else if (invite.guild) value = { kind: 'GUILD', guildId: invite.guild.id, guildName: invite.guild.name };
  } catch {
    value = { kind: 'INVALID' };
  }
  if (inviteCache.size > 5000) inviteCache.clear();
  inviteCache.set(code.toLowerCase(), { value, expiresAt: Date.now() + INVITE_TTL_MS });
  return value;
}

// ── Messages ────────────────────────────────────────────────────────────────

function isStaff(member: GuildMember | null): boolean {
  return Boolean(member?.permissions.has(PermissionFlagsBits.ManageGuild) || member?.permissions.has(PermissionFlagsBits.ManageMessages));
}

type Verdict = { refused: false } | { refused: true; reason: string; detail: string };

async function judgeMessage(message: Message<true>, config: RaidProtectionConfig): Promise<Verdict> {
  const own = message.guild.id;
  const listed = listedServerIds(config);
  const texts = messageTexts(message);

  const invitesMode = mode(config.otherInvitesMode);
  if (invitesMode !== 'OFF') {
    for (const code of extractInviteCodes(texts)) {
      const invite = await resolveInvite(message.client, code);
      if (invite.kind === 'FRIEND' || invite.kind === 'GROUP') {
        const policy = config.otherFriendInvites;
        const refused = policy === 'BLOCK' || (policy !== 'ALLOW' && invitesMode === 'WHITELIST');
        if (refused) return { refused: true, reason: 'Invitation d\'ami ou de groupe', detail: `discord.gg/${code}` };
        continue;
      }
      const guildId = invite.kind === 'GUILD' ? invite.guildId : null;
      if (isRefused(invitesMode, guildId, own, listed)) {
        const name = invite.kind === 'GUILD' ? ` (${invite.guildName})` : ' (invitation invalide ou expirée)';
        return { refused: true, reason: 'Invitation vers un autre serveur', detail: `discord.gg/${code}${name}` };
      }
    }
  }

  const forwardsMode = mode(config.otherForwardsMode);
  if (forwardsMode !== 'OFF') {
    const ref = message.reference;
    if (ref?.type === MessageReferenceType.Forward && ref.guildId && isRefused(forwardsMode, ref.guildId, own, listed)) {
      return { refused: true, reason: 'Message transféré depuis un autre serveur', detail: `serveur ${ref.guildId}` };
    }
    for (const guildId of extractGuildLinks(texts)) {
      if (isRefused(forwardsMode, guildId, own, listed)) {
        return { refused: true, reason: 'Lien vers un salon ou un événement d\'un autre serveur', detail: `serveur ${guildId}` };
      }
    }
  }
  return { refused: false };
}

/** Point d'entrée des messages. Retourne true si le message a été supprimé. */
export async function handleOtherServersMessage(message: Message): Promise<boolean> {
  if (!message.inGuild() || message.author.bot || isStaff(message.member)) return false;
  const config = await getRaidProtectionConfig(message.guild.id);
  if (!config || (config.otherInvitesMode === 'OFF' && config.otherForwardsMode === 'OFF')) return false;

  const verdict = await judgeMessage(message, config);
  if (!verdict.refused) return false;

  await message.delete().catch(() => null);
  const action = normalizeAutoSanction(config.otherSanction, 'DELETE');
  const result = await applyAutoSanction({
    client: message.client,
    guild: message.guild,
    user: message.author,
    member: message.member,
    action,
    durationMin: config.otherDurationMin,
    reason: `Autres serveurs : ${verdict.reason.toLowerCase()}`,
  });
  await logModeration(message.guild.id, message.client, [
    `🌐 **${verdict.reason}** supprimé : <@${message.author.id}> dans <#${message.channelId}>`,
    `\`${verdict.detail}\``,
    result.done && result.applied !== 'DELETE' ? `Sanction : ${autoSanctionLabel(result.applied, config.otherDurationMin)}` : 'Message supprimé seulement',
  ]);
  return true;
}

async function logModeration(guildId: string, client: Client, lines: string[]): Promise<void> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;
  const guildConfig = await getCachedGuild(guildId);
  const channel = await resolveLogChannel(guild, guildConfig?.logChannelId, 'Automod');
  await channel?.send({ content: lines.join('\n'), allowedMentions: { parse: [] } }).catch(() => null);
}

// ── Tags d'autres serveurs ──────────────────────────────────────────────────

type PrimaryGuild = { identityGuildId: string | null; identityEnabled: boolean | null; tag: string | null } | null | undefined;

function displayedTagGuild(member: GuildMember): { guildId: string; tag: string | null } | null {
  const primary = (member.user as unknown as { primaryGuild?: PrimaryGuild }).primaryGuild;
  if (!primary?.identityEnabled || !primary.identityGuildId) return null;
  return { guildId: primary.identityGuildId, tag: primary.tag };
}

/**
 * Synchronise la quarantaine liée au tag : posée quand le membre affiche le
 * tag d'un serveur refusé, levée dès qu'il le retire (ou que la règle change).
 * Une quarantaine d'une autre origine n'est jamais touchée.
 */
export async function syncServerTagQuarantine(member: GuildMember, config?: RaidProtectionConfig | null): Promise<void> {
  if (member.user.bot || isStaff(member)) return;
  const cfg = config ?? (await getRaidProtectionConfig(member.guild.id));
  if (!cfg) return;

  const tag = displayedTagGuild(member);
  const refused = tag !== null && isRefused(mode(cfg.otherTagsMode), tag.guildId, member.guild.id, listedServerIds(cfg));
  const jail = await getActiveJail(member.guild.id, member.id);

  if (refused && !jail) {
    if (!(await isJailConfigured(member.guild))) {
      logger.debug('OtherServers', `Tag refusé sur ${member.guild.id} mais aucun rôle Jail configuré`);
      return;
    }
    if (!member.manageable) return;
    const reason = `Tag d'un autre serveur affiché${tag.tag ? ` (${tag.tag})` : ''} : quarantaine jusqu'à son retrait`;
    await registerJailSanction({
      guildId: member.guild.id,
      target: { id: member.id, tag: member.user.tag },
      moderator: { id: member.client.user.id, tag: member.client.user.tag },
      reason,
      durationMs: null,
      member,
      source: 'SERVER_TAG',
      client: member.client,
    }).catch((err) => logger.warn('OtherServers', `Quarantaine de tag impossible (${member.id}): ${String(err)}`));
    await member
      .send(`Sur **${member.guild.name}**, afficher le tag d'un autre serveur n'est pas autorisé. Tu es en quarantaine : elle sera levée dès que tu retireras ce tag de ton profil.`)
      .catch(() => null);
    return;
  }

  if (!refused && jail?.source === 'SERVER_TAG') {
    await releaseJail(member.client, member.guild.id, member.id, {
      note: 'Tag de l\'autre serveur retiré : quarantaine levée.',
      onlySource: 'SERVER_TAG',
    });
  }
}
