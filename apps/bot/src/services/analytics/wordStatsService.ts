/**
 * wordStatsService.ts
 *
 * Agrège la fréquence des mots par serveur et par jour - sans jamais stocker
 * de contenu brut ni d'auteur. Les messages sont tokenisés à la volée, les
 * compteurs sont bufferisés en mémoire puis flushés en base par lots.
 *
 * Opt-in par serveur via guild.wordStatsEnabled.
 */

import prisma from '../../utils/db.js';
import { flushBulk, type BulkRow, type BulkTarget } from './analyticsBulkFlush.js';

const FLUSH_INTERVAL_MS = 60_000;
const MAX_WORD_LENGTH = 24;
const MIN_WORD_LENGTH = 3;
/** Coupe-circuit mémoire : au-delà, on flush immédiatement. */
const MAX_BUFFERED_ENTRIES = 20_000;

// Mots-outils FR + EN + argot Discord courant, exclus des stats.
const STOPWORDS = new Set([
  // Français
  'les', 'des', 'une', 'est', 'pas', 'que', 'qui', 'dans', 'pour', 'sur', 'avec', 'son', 'ses',
  'mais', 'comme', 'tout', 'nous', 'vous', 'ils', 'elle', 'elles', 'leur', 'leurs', 'ont', 'aux',
  'ces', 'cette', 'plus', 'moins', 'bien', 'quand', 'aussi', 'fait', 'faire', 'être', 'avoir',
  'suis', 'sont', 'était', 'étais', 'sera', 'très', 'peu', 'donc', 'car', 'ainsi', 'alors',
  'après', 'avant', 'chez', 'entre', 'sans', 'sous', 'vers', 'chaque', 'même', 'autre', 'autres',
  'quel', 'quelle', 'quels', 'quelles', 'dont', 'lui', 'moi', 'toi', 'eux', 'notre', 'votre',
  'mon', 'ton', 'mes', 'tes', 'nos', 'vos', 'par', 'peut', 'veux', 'veut', 'dit', 'dire',
  'oui', 'non', 'ouais', 'nan', 'jai', 'cest', 'sil', 'quil', 'quon', 'nest', 'jsuis', 'jsais',
  // Anglais
  'the', 'and', 'you', 'that', 'was', 'for', 'are', 'with', 'his', 'they', 'this', 'have',
  'from', 'one', 'had', 'word', 'but', 'not', 'what', 'all', 'were', 'when', 'your', 'can',
  'said', 'there', 'use', 'each', 'she', 'which', 'how', 'their', 'will', 'other', 'about',
  'out', 'many', 'then', 'them', 'these', 'some', 'her', 'would', 'make', 'like', 'him',
  'into', 'time', 'has', 'look', 'two', 'more', 'see', 'way', 'who', 'its', 'did', 'get',
  'come', 'made', 'may', 'part', 'just', 'dont', 'yeah', 'yes',
  // Argot Discord
  'mdr', 'lol', 'ptdr', 'xd', 'jsp', 'jpp', 'wsh', 'bref', 'genre', 'truc', 'trucs', 'ouai',
]);

// guildId -> (word -> count) pour la journée en cours
const buffer = new Map<string, Map<string, number>>();
let bufferedEntries = 0;
let flushTimer: ReturnType<typeof setInterval> | null = null;

/** Extrait les mots significatifs d'un message. Exporté pour les tests. */
export function tokenize(content: string): string[] {
  const cleaned = content
    .toLowerCase()
    // Blocs et inline code
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    // URLs, mentions, emojis custom, timestamps Discord
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<a?:\w+:\d+>/g, ' ')
    .replace(/<[@#][!&]?\d+>/g, ' ')
    .replace(/<t:\d+(:[a-zA-Z])?>/g, ' ');

  const words: string[] = [];
  for (const raw of cleaned.split(/[^\p{L}\p{N}']+/u)) {
    const word = raw.replace(/^'+|'+$/g, '');
    if (word.length < MIN_WORD_LENGTH || word.length > MAX_WORD_LENGTH) continue;
    if (/^\d+$/.test(word)) continue;
    if (STOPWORDS.has(word)) continue;
    words.push(word);
  }
  return words;
}

/** Comptabilise un message dans le buffer (appelé sur chaque MessageCreate éligible). */
export function trackMessageWords(guildId: string, content: string): void {
  const words = tokenize(content);
  if (words.length === 0) return;

  let guildBuffer = buffer.get(guildId);
  if (!guildBuffer) {
    guildBuffer = new Map();
    buffer.set(guildId, guildBuffer);
  }

  for (const word of words) {
    if (!guildBuffer.has(word)) bufferedEntries++;
    guildBuffer.set(word, (guildBuffer.get(word) ?? 0) + 1);
  }

  if (bufferedEntries >= MAX_BUFFERED_ENTRIES) {
    void flushWordStats();
  }
}

/** Vide le buffer en base (INSERT groupé par lots). Exporté pour les tests et l'arrêt propre. */
export async function flushWordStats(): Promise<void> {
  if (buffer.size === 0) return;

  const snapshot = new Map(buffer);
  buffer.clear();
  bufferedEntries = 0;

  const dateKey = new Date().toISOString().slice(0, 10);

  // Un upsert par mot faisait des centaines d'instructions par serveur et par
  // minute : on passe par le même INSERT ... ON CONFLICT groupé que les autres stats.
  const rows: BulkRow[] = [];
  for (const [guildId, words] of snapshot) {
    for (const [word, count] of words) {
      rows.push({ keys: [guildId, dateKey, word], counters: { count } });
    }
  }
  await flushBulk(WORD_TARGET, rows);
}

const WORD_TARGET: BulkTarget = {
  label: 'GuildWordStats',
  table: 'guild_word_stats',
  keys: [
    { name: 'guildId', type: 'text' },
    { name: 'dateKey', type: 'text' },
    { name: 'word', type: 'text' },
  ],
  counterColumns: ['count'],
  timestamps: false,
};

export function startWordStatsFlusher(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    void flushWordStats();
  }, FLUSH_INTERVAL_MS);
  // Ne pas retenir le process en vie pour ce timer
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

/** Purge les stats de mots plus vieilles que N jours (défaut 90). */
export async function pruneOldWordStats(retentionDays = 90): Promise<number> {
  const cutoffKey = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const { count } = await prisma.guildWordStat.deleteMany({
    where: { dateKey: { lt: cutoffKey } },
  });
  return count;
}

/** Top mots sur une plage de jours, agrégé côté SQL. */
export async function getTopWords(
  guildId: string,
  days: number,
  limit = 50,
): Promise<Array<{ word: string; count: number }>> {
  const sinceKey = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rows = await prisma.guildWordStat.groupBy({
    by: ['word'],
    where: { guildId, dateKey: { gte: sinceKey } },
    _sum: { count: true },
    orderBy: { _sum: { count: 'desc' } },
    take: limit,
  });
  return rows.map((r) => ({ word: r.word, count: r._sum.count ?? 0 }));
}
