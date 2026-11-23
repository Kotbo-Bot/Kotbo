import prisma from '../../../utils/db.js';

const MEDALS = ['🥇', '🥈', '🥉'];

/** Trois lignes « 🥇 <@id> · 1 204 messages » ; vide sans classé. */
export function formatPodium(rows: Array<{ userId: string; value: number }>, unit: string): string {
  return rows
    .filter((row) => row.value > 0)
    .slice(0, 3)
    .map((row, i) => `${MEDALS[i]} <@${row.userId}> · ${row.value.toLocaleString('fr-FR')} ${unit}`)
    .join('\n');
}

/** Premier jour du mois courant en UTC, au format des clés journalières (YYYY-MM-DD). */
export function monthStartKey(now = new Date()): string {
  return `${now.toISOString().slice(0, 7)}-01`;
}

export async function buildRankings(guildId: string) {
  const dateKey = { gte: monthStartKey() };
  const [messages, voice, thanks, xp] = await Promise.all([
    prisma.memberDailyStat.groupBy({ by: ['userId'], where: { guildId, dateKey }, _sum: { messagesCount: true }, orderBy: { _sum: { messagesCount: 'desc' } }, take: 3 }),
    prisma.memberDailyStat.groupBy({ by: ['userId'], where: { guildId, dateKey }, _sum: { voiceMinutes: true }, orderBy: { _sum: { voiceMinutes: 'desc' } }, take: 3 }),
    prisma.reputationVote.groupBy({ by: ['receiverId'], where: { guildId, createdAt: { gte: new Date(`${monthStartKey()}T00:00:00Z`) } }, _sum: { value: true }, orderBy: { _sum: { value: 'desc' } }, take: 3 }),
    prisma.memberLevel.findMany({ where: { guildId }, orderBy: { xp: 'desc' }, take: 3, select: { userId: true, xp: true } }),
  ]);
  return {
    topMessagesMonth: formatPodium(messages.map((r) => ({ userId: r.userId, value: r._sum.messagesCount ?? 0 })), 'messages'),
    topVoiceMonth: formatPodium(voice.map((r) => ({ userId: r.userId, value: r._sum.voiceMinutes ?? 0 })), 'min'),
    topThanksMonth: formatPodium(thanks.map((r) => ({ userId: r.receiverId, value: r._sum.value ?? 0 })), 'remerciements'),
    topXp: formatPodium(xp.map((r) => ({ userId: r.userId, value: r.xp })), 'XP'),
  };
}
