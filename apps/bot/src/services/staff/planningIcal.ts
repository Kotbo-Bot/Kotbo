/**
 * Abonnement iCal au Planning : un lien prive que Google Agenda, Outlook ou
 * le telephone relisent eux-memes.
 *
 * Le lien porte le serveur et le membre, signes avec le secret du dashboard :
 * seule la version de revocation est lue en base. Il ne donne acces qu'au planning de ce membre, et seulement
 * tant qu'il fait partie du staff (verifie a chaque lecture).
 */
import crypto from 'node:crypto';

const TOKEN_PURPOSE = 'planning-ical:v1';

function signature(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(`${TOKEN_PURPOSE}:${payload}`).digest('base64url').slice(0, 32);
}

/**
 * `version` suit `StaffMember.icalTokenVersion` : la relire à chaque lecture et
 * l'incrémenter côté serveur révoque tous les liens déjà distribués. Un lien
 * sans version (émis avant ce champ) vaut 0.
 */
export function signIcalToken(guildId: string, userId: string, secret: string, version = 0): string {
  const payload = Buffer.from(version > 0 ? `${guildId}.${userId}.${version}` : `${guildId}.${userId}`).toString('base64url');
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyIcalToken(token: string, secret: string): { guildId: string; userId: string; version: number } | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = signature(payload, secret);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const [guildId, userId, rawVersion] = Buffer.from(payload, 'base64url').toString().split('.');
  const version = rawVersion === undefined ? 0 : Number(rawVersion);
  if (!Number.isInteger(version) || version < 0) return null;
  return /^\d{5,25}$/.test(guildId ?? '') && /^\d{5,25}$/.test(userId ?? '') ? { guildId, userId, version } : null;
}

export interface IcsEvent {
  uid: string;
  start: Date;
  end?: Date | null;
  allDay?: boolean;
  summary: string;
  description?: string | null;
}

/** Texte iCal : antislash, point-virgule, virgule et retours a la ligne echappes (RFC 5545 §3.3.11). */
function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

const utcStamp = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const dayStamp = (date: Date) => date.toISOString().slice(0, 10).replace(/-/g, '');

/** Coupe les lignes a 75 octets, comme le demande la norme (§3.1). */
function fold(line: string): string {
  const chunks: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    chunks.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  chunks.push(rest);
  return chunks.join('\r\n');
}

export function buildIcs(calendarName: string, events: IcsEvent[], now = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Kotbo//Planning//FR',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
  ];
  for (const e of events) {
    const end = e.end ?? new Date(e.start.getTime() + (e.allDay ? 86400000 : 1800000));
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}@kotbo`,
      `DTSTAMP:${utcStamp(now)}`,
      e.allDay ? `DTSTART;VALUE=DATE:${dayStamp(e.start)}` : `DTSTART:${utcStamp(e.start)}`,
      e.allDay ? `DTEND;VALUE=DATE:${dayStamp(end)}` : `DTEND:${utcStamp(end)}`,
      `SUMMARY:${escapeText(e.summary)}`,
    );
    if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
