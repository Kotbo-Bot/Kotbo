import { describe, expect, test } from 'bun:test';
import { buildIcs, signIcalToken, verifyIcalToken } from '../../services/staff/planningIcal.js';

const SECRET = 'test-secret';

describe('lien iCal du planning', () => {
  test('un lien signé se relit, un lien modifié est refusé', () => {
    const token = signIcalToken('123456789012345678', '987654321098765432', SECRET);
    expect(verifyIcalToken(token, SECRET)).toEqual({ guildId: '123456789012345678', userId: '987654321098765432' });

    const [payload, sig] = token.split('.');
    const other = Buffer.from('123456789012345678.111111111111111111').toString('base64url');
    expect(verifyIcalToken(`${other}.${sig}`, SECRET)).toBeNull();
    expect(verifyIcalToken(`${payload}.${sig}`, 'autre-secret')).toBeNull();
    expect(verifyIcalToken('nimporte-quoi', SECRET)).toBeNull();
  });
});

describe('fichier iCal', () => {
  test('échappe le texte, coupe les longues lignes et gère la journée entière', () => {
    const ics = buildIcs('Planning', [
      { uid: 'm1', start: new Date('2026-10-27T19:00:00Z'), end: new Date('2026-10-27T20:00:00Z'), summary: 'Réunion; staff, hebdo', description: 'ligne 1\nligne 2' },
      { uid: 'a1', start: new Date('2026-10-28T00:00:00Z'), allDay: true, summary: 'Absence' },
      { uid: 'long', start: new Date('2026-10-29T10:00:00Z'), summary: 'x'.repeat(200) },
    ], new Date('2026-10-26T12:00:00Z'));

    expect(ics).toContain('DTSTART:20261027T190000Z\r\nDTEND:20261027T200000Z');
    expect(ics).toContain('SUMMARY:Réunion\\; staff\\, hebdo');
    expect(ics).toContain('DESCRIPTION:ligne 1\\nligne 2');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261028\r\nDTEND;VALUE=DATE:20261029');
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBeTrue();
  });
});
