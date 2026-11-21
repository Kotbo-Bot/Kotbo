/**
 * emojiBanPanel.ts - Panneau « Interdire des emojis / stickers » du clic droit.
 *
 * Étape 1 : liste des emojis (natifs et personnalisés), stickers et serveurs
 * d'origine du message, choix multiple de ce qu'il faut interdire.
 * Étape 2 : une sanction par élément choisi, un élément à la fois.
 *
 * L'état du panneau vit en mémoire 15 min (jeton dans le customId) : il est
 * éphémère et propre à celui qui l'a ouvert.
 */

import { randomBytes } from 'node:crypto';
import { PermissionFlagsBits, StringSelectMenuBuilder, type Message, type StringSelectMenuInteraction } from 'discord.js';
import { actionRow, separator, v2Message } from '@arcscord/components';
import { kotboContainer, truncate } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { publicErrorMessage } from '../../utils/publicError.js';
import prisma from '../../utils/db.js';
import { autoSanctionLabel, type AutoSanction } from './autoSanction.js';
import {
  customEmojiUrl,
  emojiSourceGuildId,
  extractCustomEmojis,
  extractUnicodeEmojis,
  stickerSourceGuildId,
  upsertEmojiBan,
  type EmojiBanKind,
} from './emojiBanService.js';

const SESSION_TTL_MS = 15 * 60_000;
export const EMOJI_BAN_PERMISSION = PermissionFlagsBits.ManageGuild;

type Item = { kind: EmojiBanKind; key: string; name: string; iconUrl: string | null; display: string };
type Session = {
  guildId: string;
  invokerId: string;
  items: Item[];
  queue: number[];
  results: string[];
  at: number;
};

const sessions = new Map<string, Session>();

function newSession(session: Omit<Session, 'at'>): string {
  for (const [token, s] of sessions) if (Date.now() - s.at > SESSION_TTL_MS) sessions.delete(token);
  const token = randomBytes(6).toString('hex');
  sessions.set(token, { ...session, at: Date.now() });
  return token;
}

/** Sanctions proposées : action + durée en minutes. */
const PRESETS: { value: string; action: AutoSanction; durationMin: number | null; label: string }[] = [
  { value: 'DELETE', action: 'DELETE', durationMin: null, label: 'Supprimer le message seulement' },
  { value: 'WARN', action: 'WARN', durationMin: null, label: 'Supprimer + avertissement' },
  { value: 'TIMEOUT:10', action: 'TIMEOUT', durationMin: 10, label: 'Supprimer + timeout 10 min' },
  { value: 'TIMEOUT:60', action: 'TIMEOUT', durationMin: 60, label: 'Supprimer + timeout 1 h' },
  { value: 'TIMEOUT:1440', action: 'TIMEOUT', durationMin: 1440, label: 'Supprimer + timeout 1 j' },
  { value: 'JAIL', action: 'JAIL', durationMin: null, label: 'Supprimer + quarantaine' },
  { value: 'KICK', action: 'KICK', durationMin: null, label: 'Supprimer + expulsion' },
  { value: 'SOFTBAN', action: 'SOFTBAN', durationMin: null, label: 'Supprimer + softban' },
  { value: 'BAN', action: 'BAN', durationMin: null, label: 'Supprimer + bannissement' },
];

async function collectItems(message: Message<true>): Promise<Item[]> {
  const items: Item[] = [];
  const sources = new Map<string, number>();
  const addSource = (guildId: string | null) => {
    if (!guildId || guildId === message.guildId) return;
    sources.set(guildId, (sources.get(guildId) ?? 0) + 1);
  };

  for (const e of extractCustomEmojis(message.content)) {
    items.push({ kind: 'EMOJI', key: e.id, name: e.name, iconUrl: customEmojiUrl(e.id, e.animated), display: `<${e.animated ? 'a' : ''}:${e.name}:${e.id}> \`:${e.name}:\`` });
    addSource(emojiSourceGuildId(message.client, e.id));
  }
  for (const char of extractUnicodeEmojis(message.content)) {
    items.push({ kind: 'UNICODE', key: char, name: char, iconUrl: null, display: `${char} (emoji Discord)` });
  }
  for (const s of message.stickers.values()) {
    items.push({ kind: 'STICKER', key: s.id, name: s.name, iconUrl: s.url, display: `Sticker **${s.name}**` });
    addSource(await stickerSourceGuildId(message, s.id));
  }

  if (sources.size > 0) {
    const known = await prisma.discordExternalGuild.findMany({ where: { guildId: { in: [...sources.keys()] } }, select: { guildId: true, name: true } });
    const names = new Map(known.map((g) => [g.guildId, g.name]));
    for (const guildId of sources.keys()) {
      const name = message.client.guilds.cache.get(guildId)?.name ?? names.get(guildId) ?? guildId;
      items.push({ kind: 'SOURCE_GUILD', key: guildId, name, iconUrl: message.client.guilds.cache.get(guildId)?.iconURL() ?? null, display: `Tous les emojis et stickers de **${name}**` });
    }
  }
  return items.slice(0, 25);
}

function errorPanel(text: string) {
  return kotboContainer({ color: 'danger', title: '❌ Action impossible', fields: [text] });
}

/** Étape 1, appelée par l'action du registre. */
export async function buildEmojiBanPicker(message: Message<true>, invokerId: string) {
  const items = await collectItems(message);
  if (items.length === 0) {
    return kotboContainer({ color: 'warning', title: '🚫 Interdire des emojis', fields: ["Ce message ne contient ni emoji ni sticker."] });
  }

  const token = newSession({ guildId: message.guildId, invokerId, items, queue: [], results: [] });
  const select = new StringSelectMenuBuilder()
    .setCustomId(`emojiban:pick:${token}`)
    .setPlaceholder('Choisis ce qu\'il faut interdire...')
    .setMinValues(1)
    .setMaxValues(items.length)
    .addOptions(items.map((item, i) => ({
      label: truncate(item.kind === 'SOURCE_GUILD' ? `Serveur : ${item.name}` : item.kind === 'STICKER' ? `Sticker : ${item.name}` : item.kind === 'EMOJI' ? `:${item.name}:` : item.name, 100),
      value: String(i),
      description: { EMOJI: 'Emoji personnalisé', UNICODE: 'Emoji Discord', STICKER: 'Sticker', SOURCE_GUILD: 'Tous ses emojis et stickers' }[item.kind],
    })));

  return kotboContainer({
    color: 'primary',
    title: '🚫 Interdire des emojis et stickers',
    fields: [
      items.map((item, i) => `**${i + 1}.** ${item.display}`).join('\n'),
      separator({ divider: true, spacing: 'small' }),
      actionRow(select),
      '-# Tu choisiras ensuite la sanction de chaque élément.',
    ],
  });
}

async function sanctionStep(session: Session, token: string) {
  const index = session.queue[0]!;
  const item = session.items[index]!;
  const existing = await prisma.emojiBanRule.findUnique({
    where: { guildId_kind_key: { guildId: session.guildId, kind: item.kind, key: item.key } },
    select: { action: true, durationMin: true },
  });
  const select = new StringSelectMenuBuilder()
    .setCustomId(`emojiban:act:${token}`)
    .setPlaceholder('Sanction pour cet élément...')
    .addOptions([
      ...PRESETS.map((p) => ({ label: p.label, value: p.value })),
      { label: 'Ne pas interdire', value: 'SKIP' },
    ]);

  return kotboContainer({
    color: 'primary',
    title: '🚫 Choisis la sanction',
    fields: [
      `${item.display}`,
      existing ? `-# Déjà interdit : ${autoSanctionLabel(existing.action as AutoSanction, existing.durationMin)}. Ton choix remplace la règle.` : '',
      separator({ divider: true, spacing: 'small' }),
      actionRow(select),
      `-# Élément ${session.results.length + 1} sur ${session.results.length + session.queue.length}`,
    ].filter(Boolean),
  });
}

function summary(session: Session) {
  return kotboContainer({
    color: 'success',
    title: '✅ Règles enregistrées',
    fields: [
      session.results.join('\n') || 'Aucun élément interdit.',
      '-# Retrouve et modifie ces règles dans le dashboard, module Automod.',
    ],
  });
}

/** Route `emojiban:<pick|act>:<token>`. */
export async function handleEmojiBanSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.inCachedGuild()) return;
  const [, step, token] = interaction.customId.split(':');
  const session = token ? sessions.get(token) : undefined;

  await interaction.deferUpdate();
  if (!session || Date.now() - session.at > SESSION_TTL_MS || session.guildId !== interaction.guildId) {
    await interaction.editReply(v2Message(errorPanel('Ce panneau a expiré. Relance l\'action depuis le clic droit.')));
    return;
  }
  if (session.invokerId !== interaction.user.id || !interaction.member.permissions.has(EMOJI_BAN_PERMISSION)) {
    await interaction.editReply(v2Message(errorPanel("Tu n'as pas la permission nécessaire pour cette action.")));
    return;
  }
  session.at = Date.now();

  try {
    if (step === 'pick') {
      session.queue = interaction.values.map(Number).filter((i) => session.items[i]);
      session.results = [];
    } else if (step === 'act') {
      const index = session.queue.shift();
      const item = index === undefined ? undefined : session.items[index];
      const preset = PRESETS.find((p) => p.value === interaction.values[0]);
      if (item && preset) {
        const rule = await upsertEmojiBan(session.guildId, {
          kind: item.kind, key: item.key, name: item.name, iconUrl: item.iconUrl,
          action: preset.action, durationMin: preset.durationMin, createdBy: interaction.user.id,
        });
        session.results.push('error' in rule ? `❌ ${item.display} : ${rule.error}` : `🚫 ${item.display} → ${preset.label}`);
      } else if (item) {
        session.results.push(`➖ ${item.display} : non interdit`);
      }
    }

    if (session.queue.length > 0) {
      await interaction.editReply(v2Message(await sanctionStep(session, token!)));
    } else {
      sessions.delete(token!);
      await interaction.editReply(v2Message(summary(session)));
    }
  } catch (error) {
    logger.error('EmojiBan', 'Panneau en échec', error);
    await interaction.editReply(v2Message(errorPanel(publicErrorMessage(error, 'Une erreur inattendue est survenue.'))));
  }
}
