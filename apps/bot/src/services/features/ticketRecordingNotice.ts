/**
 * Avertissement d'enregistrement avant la création d'un ticket.
 *
 * Le membre qui ouvre un ticket lit d'abord, dans une réponse que lui seul
 * voit, que l'échange sera conservé, transcrit à la fermeture et archivé, à
 * des fins de formation et de qualité de service. Le ticket n'est créé
 * qu'après le délai de lecture : l'information précède l'échange au lieu de
 * l'accompagner.
 */
import { EmbedBuilder, type ButtonInteraction, type ModalSubmitInteraction, type StringSelectMenuInteraction } from 'discord.js';
import { COLORS } from '../../utils/embeds.js';

export const MIN_NOTICE_SECONDS = 5;
export const MAX_NOTICE_SECONDS = 30;
export const DEFAULT_NOTICE_SECONDS = 10;

export const DEFAULT_NOTICE_TEXT = [
  'Ce ticket va être **enregistré** : les messages échangés sont conservés.',
  'À sa **fermeture**, une **transcription** complète est générée et **archivée**.',
  "Ces enregistrements servent à la **formation** de l'équipe et à la **qualité de service**. Ils ne sont accessibles qu'au staff habilité.",
].join('\n\n');

export interface NoticeSettings {
  ticketRecordingNoticeEnabled: boolean;
  ticketRecordingNoticeSeconds: number;
  ticketRecordingNoticeText: string | null;
}

export function noticeSeconds(value: unknown): number {
  const seconds = Math.trunc(Number(value));
  if (!Number.isFinite(seconds)) return DEFAULT_NOTICE_SECONDS;
  return Math.min(MAX_NOTICE_SECONDS, Math.max(MIN_NOTICE_SECONDS, seconds));
}

export function buildNoticeEmbed(settings: NoticeSettings, readyAt: Date): EmbedBuilder {
  const text = settings.ticketRecordingNoticeText?.trim() || DEFAULT_NOTICE_TEXT;
  // Horodatage relatif : Discord fait défiler le compte à rebours lui-même,
  // sans qu'on modifie le message chaque seconde.
  const countdown = `⏳ Ton ticket sera créé <t:${Math.ceil(readyAt.getTime() / 1000)}:R>.`;
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('ℹ️ Avant d’ouvrir ton ticket')
    .setDescription(`${text}\n\n${countdown}`.slice(0, 4096));
}

// ── Une seule ouverture à la fois par membre ────────────
//
// Pendant le délai de lecture, un second clic sur le panneau relancerait une
// création en parallèle : les contrôles « ticket déjà ouvert » ne voient rien
// tant que le premier n'est pas écrit en base.

const pending = new Set<string>();

export function beginTicketOpening(guildId: string, userId: string): boolean {
  const key = `${guildId}:${userId}`;
  if (pending.has(key)) return false;
  pending.add(key);
  return true;
}

export function endTicketOpening(guildId: string, userId: string): void {
  pending.delete(`${guildId}:${userId}`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Affiche l'avertissement dans la réponse différée (éphémère) de
 * l'interaction, puis attend le délai de lecture. Sans effet si le serveur
 * l'a désactivé.
 */
export async function showRecordingNotice(
  interaction: ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
  settings: NoticeSettings,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<void> {
  if (!settings.ticketRecordingNoticeEnabled) return;
  const seconds = noticeSeconds(settings.ticketRecordingNoticeSeconds);
  const readyAt = new Date(Date.now() + seconds * 1000);
  await interaction.editReply({ content: '', embeds: [buildNoticeEmbed(settings, readyAt)] }).catch(() => null);
  await wait(seconds * 1000);
}
