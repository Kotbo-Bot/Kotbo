import { describe, expect, test } from 'bun:test';
import {
  computeSla,
  normalizePriority,
  normalizeTags,
  normalizeView,
  viewWhere,
  waitingOn,
} from '../../services/features/ticketHelpdesk.js';

const at = (iso: string) => new Date(iso);

describe('priorités et étiquettes', () => {
  test('seules les priorités connues passent', () => {
    expect(normalizePriority('URGENT')).toBe('URGENT');
    expect(normalizePriority('urgent')).toBeNull();
    expect(normalizePriority(3)).toBeNull();
  });

  test('étiquettes en minuscules, sans doublon, espaces en tirets', () => {
    expect(normalizeTags([' Remboursement ', 'remboursement', 'Bug Paiement', 7, ''])).toEqual(['remboursement', 'bug-paiement']);
    expect(normalizeTags(Array.from({ length: 20 }, (_, i) => `t${i}`))).toHaveLength(10);
  });
});

describe('tour de parole', () => {
  const ticket = (last: { member?: string; staff?: string }, status = 'OPEN') => ({
    status,
    lastMemberMessageAt: last.member ? at(last.member) : null,
    lastStaffMessageAt: last.staff ? at(last.staff) : null,
  });

  test('sans réponse du staff, la parole est au staff', () => {
    expect(waitingOn(ticket({ member: '2026-10-01T10:00:00Z' }))).toBe('staff');
  });

  test('le dernier à avoir parlé passe la main', () => {
    expect(waitingOn(ticket({ member: '2026-10-01T10:00:00Z', staff: '2026-10-01T11:00:00Z' }))).toBe('member');
    expect(waitingOn(ticket({ member: '2026-10-01T12:00:00Z', staff: '2026-10-01T11:00:00Z' }))).toBe('staff');
  });

  test('un ticket fermé n’attend personne', () => {
    expect(waitingOn(ticket({ member: '2026-10-01T12:00:00Z' }, 'CLOSED'))).toBeNull();
  });
});

describe('objectifs de service', () => {
  const sla = { firstResponseMinutes: 60, resolutionHours: 24 };
  const base = {
    status: 'OPEN',
    createdAt: at('2026-10-01T10:00:00Z'),
    firstResponseAt: null as Date | null,
    closedAt: null as Date | null,
    lastMemberMessageAt: null,
    lastStaffMessageAt: null,
  };

  test('en cours, à risque, dépassé', () => {
    expect(computeSla(base, sla, at('2026-10-01T10:20:00Z')).firstResponse?.status).toBe('running');
    expect(computeSla(base, sla, at('2026-10-01T10:50:00Z')).firstResponse?.status).toBe('at_risk');
    const late = computeSla(base, sla, at('2026-10-01T11:30:00Z'));
    expect(late.firstResponse?.status).toBe('breached');
    expect(late.worst).toBe('breached');
  });

  test('une réponse dans les temps est tenue, même lue plus tard', () => {
    const answered = { ...base, firstResponseAt: at('2026-10-01T10:30:00Z') };
    const result = computeSla(answered, sla, at('2026-10-03T00:00:00Z'));
    expect(result.firstResponse).toEqual({ status: 'met', dueAt: '2026-10-01T11:00:00.000Z', completedAt: '2026-10-01T10:30:00.000Z' });
    expect(result.resolution?.status).toBe('breached');
  });

  test('sans objectif ni pour une demande en attente, rien à mesurer', () => {
    expect(computeSla(base, { firstResponseMinutes: null, resolutionHours: null })).toEqual({ firstResponse: null, resolution: null, worst: null });
    expect(computeSla({ ...base, status: 'PENDING' }, sla).worst).toBeNull();
  });

  test('fermé sans réponse avant l’échéance : pas de dépassement inventé', () => {
    const closed = { ...base, status: 'CLOSED', closedAt: at('2026-10-01T10:30:00Z') };
    const result = computeSla(closed, sla, at('2026-10-05T00:00:00Z'));
    expect(result.firstResponse).toBeNull();
    expect(result.resolution?.status).toBe('met');
  });
});

describe('vues', () => {
  const ctx = { guildId: 'g', userId: 'me', now: at('2026-10-01T12:00:00Z'), sla: { firstResponseMinutes: 60, resolutionHours: null }, staffTurnField: 'FIELD' };

  test('vue inconnue : retombe sur « ouverts »', () => {
    expect(normalizeView('nimporte')).toBe('open');
  });

  test('mes tickets, non attribués', () => {
    expect(viewWhere('mine', ctx)).toMatchObject({ guildId: 'g', claimedById: 'me' });
    expect(viewWhere('unassigned', ctx)).toEqual({ guildId: 'g', status: 'OPEN', claimedById: null });
  });

  test('dépassés : seulement avec un objectif', () => {
    expect(viewWhere('breached', ctx)).toMatchObject({ OR: [{ firstResponseAt: null, createdAt: { lt: at('2026-10-01T11:00:00Z') } }] });
    expect(viewWhere('breached', { ...ctx, sla: { firstResponseMinutes: null, resolutionHours: null } })).toBeNull();
  });

  test('en attente du staff compare les deux colonnes', () => {
    expect(viewWhere('waiting_staff', ctx)).toMatchObject({ OR: [{ lastStaffMessageAt: null }, { lastMemberMessageAt: { gt: 'FIELD' } }] });
  });
});
