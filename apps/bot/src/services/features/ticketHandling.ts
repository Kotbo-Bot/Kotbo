/**
 * Historique de prise en charge d'un ticket : prises, restitutions et
 * transferts, dans l'ordre. Stocké en JSON sur le ticket (`handlingLog`) pour
 * rester lisible dans l'embed de fermeture, le journal et la transcription,
 * même si le staff ou les rôles ont changé depuis.
 */
import prisma from '../../utils/db.js';

export type TicketHandlingEvent = {
  type: 'CLAIM' | 'UNCLAIM' | 'TRANSFER';
  at: string;
  byId: string;
  byName: string;
  /** Équipe (rôle) destinataire d'un transfert. */
  toRoleId?: string | null;
  toRoleName?: string | null;
  /** Membre destinataire d'un transfert (un supérieur, par exemple). */
  toUserId?: string | null;
  toUserName?: string | null;
  note?: string | null;
};

/** Plafond de la liste : un ticket qui change dix fois de mains en a déjà assez dit. */
const MAX_EVENTS = 50;

/** Relit le JSON stocké en ignorant tout ce qui n'a pas la forme d'un événement. */
export function parseHandlingLog(value: unknown): TicketHandlingEvent[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is TicketHandlingEvent => {
    if (!item || typeof item !== 'object') return false;
    const ev = item as Record<string, unknown>;
    return (ev.type === 'CLAIM' || ev.type === 'UNCLAIM' || ev.type === 'TRANSFER')
      && typeof ev.at === 'string' && typeof ev.byId === 'string' && typeof ev.byName === 'string';
  });
}

/** Ajoute un événement à l'historique du ticket et renvoie l'historique à jour. */
export async function recordHandlingEvent(
  ticketId: string,
  event: Omit<TicketHandlingEvent, 'at'>,
): Promise<TicketHandlingEvent[]> {
  const row = await prisma.ticket.findUnique({ where: { id: ticketId }, select: { handlingLog: true } });
  const next = [...parseHandlingLog(row?.handlingLog), { ...event, at: new Date().toISOString() }].slice(-MAX_EVENTS);
  await prisma.ticket.update({ where: { id: ticketId }, data: { handlingLog: next as never } });
  return next;
}

/** Destinataire d'un transfert, en mentions Discord (`<@id>` / `<@&id>`) ou en texte brut. */
function targetOf(ev: TicketHandlingEvent, mentions: boolean): string {
  const parts: string[] = [];
  if (ev.toRoleId) parts.push(mentions ? `<@&${ev.toRoleId}>` : `@${ev.toRoleName ?? ev.toRoleId}`);
  if (ev.toUserId) parts.push(mentions ? `<@${ev.toUserId}>` : (ev.toUserName ?? ev.toUserId));
  return parts.join(' · ');
}

/** Une ligne par événement : « 12/11 14:02 · Transfert : A → @Équipe ». */
export function describeHandlingEvent(ev: TicketHandlingEvent, mentions: boolean): string {
  const who = mentions ? `<@${ev.byId}>` : ev.byName;
  const when = mentions ? `<t:${Math.floor(new Date(ev.at).getTime() / 1000)}:f>` : new Date(ev.at).toISOString().slice(0, 16).replace('T', ' ');
  const label = ev.type === 'CLAIM' ? 'Prise en charge' : ev.type === 'UNCLAIM' ? 'Remis en file' : 'Transfert';
  const to = ev.type === 'TRANSFER' ? ` → ${targetOf(ev, mentions)}` : '';
  const note = ev.note ? ` (${ev.note})` : '';
  return `${when} · ${label} par ${who}${to}${note}`;
}

/**
 * Historique prêt pour un champ d'embed (1024 caractères max), les plus
 * récents d'abord gardés si la liste déborde. `null` quand il n'y a rien à dire.
 */
export function formatHandlingHistory(events: TicketHandlingEvent[], mentions = true): string | null {
  if (events.length === 0) return null;
  const lines = events.map((ev) => describeHandlingEvent(ev, mentions));
  while (lines.join('\n').length > 1000 && lines.length > 1) lines.shift();
  return lines.join('\n').slice(0, 1024);
}
