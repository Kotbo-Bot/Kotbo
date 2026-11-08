/**
 * fileExtensionFilter.ts - Automod « Extensions de fichiers ».
 *
 * Une règle du serveur, plus des règles par salon, fil ou catégorie ; la plus
 * précise l'emporte (salon, puis catégorie, puis serveur). Chaque règle est
 * une liste noire (les extensions nommées sont refusées) ou une liste blanche
 * (seules les extensions nommées passent).
 *
 * Fichiers déguisés : un exécutable renommé en .png garde sa signature binaire
 * (« MZ », « \x7fELF »…), et une « image » que Discord n'a pas su lire n'a pas
 * de dimensions. Une liste blanche les refuse toujours ; l'option
 * fileRejectCorrupted les supprime partout.
 */

import { PermissionFlagsBits, type Attachment, type GuildBasedChannel, type Message } from 'discord.js';
import type { FileFilterRule, RaidProtectionConfig } from '@prisma/client';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { fetchExternal } from '../../utils/http.js';
import { getCachedGuild } from '../../utils/cache.js';
import { resolveLogChannel } from '../../utils/logChannel.js';
import { getRaidProtectionConfig } from './raidProtectionService.js';
import { applyAutoSanction, autoSanctionLabel, normalizeAutoSanction } from './autoSanction.js';

export const FILE_GROUPS: Record<string, string[]> = {
  EXECUTABLES: ['exe', 'msi', 'msp', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'jar', 'apk', 'xapk', 'ipa', 'app', 'dmg', 'pkg', 'deb', 'rpm', 'sh', 'run', 'bin', 'elf', 'lnk', 'reg', 'gadget', 'appx', 'msix', 'dll', 'sys'],
  IMAGES: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'svg', 'heic', 'heif', 'avif', 'ico'],
  VIDEOS: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'flv', 'm4v', '3gp', 'mpeg', 'mpg'],
  AUDIO: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'wma', 'mid', 'midi'],
  ARCHIVES: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'iso', 'img', 'cab', 'lz', 'lzma'],
  DOCUMENTS: ['pdf', 'doc', 'docx', 'docm', 'xls', 'xlsx', 'xlsm', 'ppt', 'pptx', 'pptm', 'odt', 'ods', 'odp', 'rtf', 'txt', 'csv', 'md', 'epub', 'html', 'htm', 'xml', 'json'],
};

export const MAX_CUSTOM_EXTENSIONS = 50;
export const MAX_FILE_RULES = 20;

/** Extension d'un nom de fichier, en minuscules, sans le point. */
export function extensionOf(name: string): string {
  const match = /\.([a-z0-9]{1,10})$/i.exec(name.trim());
  return match ? match[1].toLowerCase() : '';
}

export function normalizeExtensions(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[,\s]+/) : [];
  return [...new Set(raw.map((e) => String(e).trim().toLowerCase().replace(/^\./, '')).filter((e) => /^[a-z0-9]{1,10}$/.test(e)))].slice(0, MAX_CUSTOM_EXTENSIONS);
}

type Rule = { mode: 'BLACKLIST' | 'WHITELIST'; groups: string[]; extensions: string[]; scope: string };

function namedBy(rule: Rule, ext: string): boolean {
  return rule.extensions.includes(ext) || rule.groups.some((g) => FILE_GROUPS[g]?.includes(ext));
}

async function loadRules(guildId: string): Promise<FileFilterRule[]> {
  const key = `guild:${guildId}:fileFilterRules`;
  const cached = await cache.get<FileFilterRule[]>(key);
  if (cached) return cached;
  const rules = await prisma.fileFilterRule.findMany({ where: { guildId } });
  await cache.set(key, rules, 60);
  return rules;
}

export async function invalidateFileRules(guildId: string): Promise<void> {
  await cache.delete(`guild:${guildId}:fileFilterRules`);
}

/** Règle applicable à un salon : salon (ou parent d'un fil), puis catégorie, puis serveur. */
export function resolveRule(channel: GuildBasedChannel, rules: FileFilterRule[], config: RaidProtectionConfig): Rule | null {
  const channelId = channel.isThread() ? channel.parentId : channel.id;
  const categoryId = channel.isThread() ? channel.parent?.parentId ?? null : channel.parentId;
  const asRule = (r: FileFilterRule, scope: string): Rule => ({ mode: r.mode === 'WHITELIST' ? 'WHITELIST' : 'BLACKLIST', groups: r.groups, extensions: r.extensions, scope });
  const exactThread = channel.isThread() ? rules.find((r) => r.targetId === channel.id) : undefined;
  if (exactThread) return asRule(exactThread, 'fil');
  const forChannel = rules.find((r) => r.targetId === channelId);
  if (forChannel) return asRule(forChannel, 'salon');
  const forCategory = categoryId ? rules.find((r) => r.targetId === categoryId) : undefined;
  if (forCategory) return asRule(forCategory, 'catégorie');
  if (config.fileFilterMode === 'BLACKLIST' || config.fileFilterMode === 'WHITELIST') {
    return { mode: config.fileFilterMode, groups: config.fileGroups, extensions: config.fileExtensions, scope: 'serveur' };
  }
  return null;
}

// ── Fichiers déguisés ───────────────────────────────────────────────────────

const EXECUTABLE_SIGNATURES: { bytes: number[]; label: string }[] = [
  { bytes: [0x4d, 0x5a], label: 'exécutable Windows' },
  { bytes: [0x7f, 0x45, 0x4c, 0x46], label: 'exécutable Linux' },
  { bytes: [0xcf, 0xfa, 0xed, 0xfe], label: 'exécutable macOS' },
  { bytes: [0xfe, 0xed, 0xfa, 0xcf], label: 'exécutable macOS' },
  { bytes: [0xca, 0xfe, 0xba, 0xbe], label: 'exécutable macOS' },
];

/** Signature d'exécutable dans les premiers octets, lus sans télécharger le fichier entier. */
async function sniffExecutable(attachment: Attachment): Promise<string | null> {
  try {
    const res = await fetchExternal(attachment.url, { headers: { Range: 'bytes=0-15' } }, 4_000);
    if (!res.ok) return null;
    const head = new Uint8Array(await res.arrayBuffer()).slice(0, 16);
    const found = EXECUTABLE_SIGNATURES.find((sig) => sig.bytes.every((b, i) => head[i] === b));
    return found?.label ?? null;
  } catch {
    return null;
  }
}

const MEDIA_EXTENSIONS = new Set([...FILE_GROUPS.IMAGES, ...FILE_GROUPS.VIDEOS].filter((e) => e !== 'svg' && e !== 'ico'));

/**
 * Un fichier qui se dit image ou vidéo mais que Discord n'a pas su lire (pas
 * de dimensions), ou qui porte une signature d'exécutable, est déguisé.
 */
export async function detectDisguise(attachment: Attachment): Promise<string | null> {
  const ext = extensionOf(attachment.name);
  if (MEDIA_EXTENSIONS.has(ext) && (attachment.width === null || attachment.height === null)) {
    return `fichier .${ext} illisible comme ${FILE_GROUPS.VIDEOS.includes(ext) ? 'vidéo' : 'image'}`;
  }
  if (FILE_GROUPS.EXECUTABLES.includes(ext)) return null;
  const executable = await sniffExecutable(attachment);
  return executable ? `${executable} déguisé en .${ext || 'sans extension'}` : null;
}

// ── Messages ────────────────────────────────────────────────────────────────

type Refusal = { file: string; ext: string; reason: string };

async function judge(attachments: Attachment[], rule: Rule | null, rejectCorrupted: boolean): Promise<Refusal | null> {
  for (const attachment of attachments) {
    const ext = extensionOf(attachment.name);
    if (rule) {
      const named = namedBy(rule, ext);
      if (rule.mode === 'BLACKLIST' && named) return { file: attachment.name, ext, reason: `extension .${ext} refusée (règle du ${rule.scope})` };
      if (rule.mode === 'WHITELIST' && !named) return { file: attachment.name, ext, reason: `extension ${ext ? `.${ext}` : 'absente'} non autorisée (règle du ${rule.scope})` };
    }
    // Un déguisement ne se cherche que là où il change quelque chose : liste
    // blanche, option « toujours refuser », ou liste noire des exécutables.
    const checkDisguise = rejectCorrupted || rule?.mode === 'WHITELIST' || (rule?.mode === 'BLACKLIST' && rule.groups.includes('EXECUTABLES'));
    if (checkDisguise) {
      const disguise = await detectDisguise(attachment);
      if (disguise) return { file: attachment.name, ext, reason: `fichier corrompu ou déguisé (${disguise})` };
    }
  }
  return null;
}

/** Point d'entrée des messages. Retourne true si le message a été supprimé. */
export async function handleFileExtensionMessage(message: Message): Promise<boolean> {
  if (!message.inGuild() || message.author.bot) return false;
  const attachments = [...message.attachments.values()];
  for (const snapshot of message.messageSnapshots?.values() ?? []) attachments.push(...snapshot.attachments.values());
  if (attachments.length === 0) return false;
  const permissions = message.member?.permissions;
  if (permissions?.has(PermissionFlagsBits.ManageGuild) || permissions?.has(PermissionFlagsBits.ManageMessages)) return false;

  const config = await getRaidProtectionConfig(message.guild.id);
  if (!config) return false;
  const rules = await loadRules(message.guild.id);
  const rule = resolveRule(message.channel as GuildBasedChannel, rules, config);
  if (!rule && !config.fileRejectCorrupted) return false;

  const refusal = await judge(attachments, rule, config.fileRejectCorrupted);
  if (!refusal) return false;

  await message.delete().catch(() => null);
  const action = normalizeAutoSanction(config.fileSanction, 'DELETE');
  const result = await applyAutoSanction({
    client: message.client,
    guild: message.guild,
    user: message.author,
    member: message.member,
    action,
    durationMin: config.fileDurationMin,
    reason: `Fichier d'une extension refusée : ${refusal.file}`,
  });

  const guildConfig = await getCachedGuild(message.guild.id);
  const channel = await resolveLogChannel(message.guild, guildConfig?.logChannelId, 'Automod');
  await channel
    ?.send({
      content: [
        `📎 **Fichier refusé** : <@${message.author.id}> dans <#${message.channelId}>`,
        `\`${refusal.file}\` : ${refusal.reason}`,
        result.done && result.applied !== 'DELETE' ? `Sanction : ${autoSanctionLabel(result.applied, config.fileDurationMin)}` : 'Message supprimé seulement',
      ].join('\n'),
      allowedMentions: { parse: [] },
    })
    .catch(() => null);
  return true;
}
