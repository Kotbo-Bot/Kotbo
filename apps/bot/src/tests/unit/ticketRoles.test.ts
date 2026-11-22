import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

for (const file of ['db.ts', 'db.js']) {
  mock.module(path.resolve(import.meta.dir, '../../utils', file), () => ({ default: {}, prisma: {}, prismaRead: {} }));
}

const {
  cleanRoleIds,
  hasTicketExcludedRole,
  roleMentionText,
  ticketAccessRoleIds,
  ticketManagerRoleIds,
  ticketMentionRoleIds,
  ticketSupportRoleIds,
} = await import('../../services/features/ticketRoles.js');
const { describeHandlingEvent, formatHandlingHistory, parseHandlingLog } = await import('../../services/features/ticketHandling.js');

describe('rôles des tickets', () => {
  test('cleanRoleIds écarte le bruit et les doublons', () => {
    expect(cleanRoleIds(['a', ' a ', '', 3, null, 'b'])).toEqual(['a', 'b']);
    expect(cleanRoleIds('a')).toEqual([]);
  });

  test("l'équipe d'assistance reprend l'ancien rôle unique, sans doublon", () => {
    expect(ticketSupportRoleIds({ ticketStaffRoleId: 'r1' })).toEqual(['r1']);
    expect(ticketSupportRoleIds({ ticketStaffRoleId: 'r1', ticketSupportRoleIds: ['r1', 'r2'] })).toEqual(['r1', 'r2']);
  });

  test("le rôle d'un type de ticket remplace l'équipe du serveur, pas les responsables", () => {
    const cfg = { ticketStaffRoleId: 'r1', ticketSupportRoleIds: ['r1', 'r2'], ticketManagerRoleIds: ['boss'] };
    expect(ticketSupportRoleIds(cfg, 'typeRole')).toEqual(['typeRole']);
    expect(ticketManagerRoleIds(cfg)).toEqual(['boss']);
    expect(ticketAccessRoleIds(cfg, 'typeRole')).toEqual(['typeRole', 'boss']);
  });

  test("les mentions retombent sur l'équipe d'assistance quand la liste est vide", () => {
    expect(ticketMentionRoleIds({ ticketSupportRoleIds: ['r1'] })).toEqual(['r1']);
    expect(ticketMentionRoleIds({ ticketSupportRoleIds: ['r1'], ticketMentionRoleIds: ['m1'] })).toEqual(['m1']);
    expect(roleMentionText(['a', 'b'])).toBe('<@&a> <@&b>');
    expect(roleMentionText([])).toBeNull();
  });

  test("l'exclusion se joue sur un seul rôle commun", () => {
    const cfg = { ticketExcludedRoleIds: ['ban'] };
    expect(hasTicketExcludedRole(cfg, ['x', 'ban'])).toBe(true);
    expect(hasTicketExcludedRole(cfg, ['x'])).toBe(false);
    expect(hasTicketExcludedRole({}, ['ban'])).toBe(false);
  });
});

describe('historique de prise en charge', () => {
  const log = [
    { type: 'CLAIM', at: '2026-11-22T10:00:00.000Z', byId: '1', byName: 'Alice' },
    { type: 'TRANSFER', at: '2026-11-22T10:05:00.000Z', byId: '1', byName: 'Alice', toRoleId: 'r2', toRoleName: 'Admins', note: 'litige' },
  ];

  test('parseHandlingLog ignore ce qui a la mauvaise forme', () => {
    expect(parseHandlingLog([...log, { type: 'AUTRE' }, null, 'x'])).toHaveLength(2);
    expect(parseHandlingLog(null)).toEqual([]);
  });

  test('texte brut pour la transcription, mentions pour Discord', () => {
    const [claim, transfer] = parseHandlingLog(log);
    expect(describeHandlingEvent(claim, false)).toBe('2026-11-22 10:00 · Prise en charge par Alice');
    expect(describeHandlingEvent(transfer, false)).toContain('Transfert par Alice → @Admins (litige)');
    expect(describeHandlingEvent(transfer, true)).toContain('<@&r2>');
  });

  test("formatHandlingHistory tient dans un champ d'embed", () => {
    expect(formatHandlingHistory([])).toBeNull();
    const many = Array.from({ length: 50 }, (_, i) => ({ ...log[0], at: `2026-11-22T10:${String(i).padStart(2, '0')}:00.000Z` }));
    const text = formatHandlingHistory(parseHandlingLog(many));
    expect(text!.length).toBeLessThanOrEqual(1024);
  });
});
