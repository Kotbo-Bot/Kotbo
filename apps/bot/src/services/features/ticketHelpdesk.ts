/**
 * Règles du centre de support : priorités, étiquettes, objectifs de service
 * (SLA), tour de parole et vues de la boîte de réception.
 *
 * Le vocabulaire suit celui des outils de support du marché (Zendesk, Front,
 * Intercom) : une vue est une file de travail filtrée, un SLA a une échéance
 * de première réponse et une de résolution, et chaque ticket est « en attente
 * du staff » ou « en attente du membre » selon qui a parlé en dernier.
 *
 * Fichier pur : aucun accès à la base, pour que les mêmes règles servent au
 * filtrage SQL, à l'affichage et aux tests.
 */
import type { Prisma } from '@prisma/client';

export const TICKET_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export function normalizePriority(value: unknown): TicketPriority | null {
  return typeof value === 'string' && (TICKET_PRIORITIES as readonly string[]).includes(value) ? value as TicketPriority : null;
}

export const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 30;

/** Étiquettes en minuscules, sans doublon, bornées en nombre et en longueur. */
export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().toLowerCase().replace(/\s+/g, '-').slice(0, MAX_TAG_LENGTH);
    if (tag && !tags.includes(tag)) tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

// ── Tour de parole ──────────────────────────────────────

export const ACTIVE_STATUSES = ['OPEN', 'CLAIMED'] as const;

export interface TurnFields {
  status: string;
  lastMemberMessageAt: Date | null;
  lastStaffMessageAt: Date | null;
}

/** À qui revient la parole sur un ticket en cours. */
export function waitingOn(ticket: TurnFields): 'staff' | 'member' | null {
  if (!(ACTIVE_STATUSES as readonly string[]).includes(ticket.status)) return null;
  if (!ticket.lastStaffMessageAt) return 'staff';
  if (ticket.lastMemberMessageAt && ticket.lastMemberMessageAt > ticket.lastStaffMessageAt) return 'staff';
  return 'member';
}

// ── Objectifs de service ────────────────────────────────

export interface SlaConfig {
  firstResponseMinutes: number | null;
  resolutionHours: number | null;
}

export type SlaStatus = 'met' | 'breached' | 'running' | 'at_risk';

export interface SlaClock {
  status: SlaStatus;
  dueAt: string;
  completedAt: string | null;
}

export interface SlaFields extends TurnFields {
  createdAt: Date;
  firstResponseAt: Date | null;
  closedAt: Date | null;
}

/** Part du délai restante sous laquelle un ticket passe « à risque ». */
export const AT_RISK_SHARE = 0.25;

function clock(start: Date, budgetMs: number, completedAt: Date | null, active: boolean, now: Date): SlaClock | null {
  const due = new Date(start.getTime() + budgetMs);
  if (completedAt) {
    return { status: completedAt <= due ? 'met' : 'breached', dueAt: due.toISOString(), completedAt: completedAt.toISOString() };
  }
  // Fermé sans que l'échéance soit atteinte : rien à mesurer.
  if (!active) return null;
  const remaining = due.getTime() - now.getTime();
  const status: SlaStatus = remaining < 0 ? 'breached' : remaining < budgetMs * AT_RISK_SHARE ? 'at_risk' : 'running';
  return { status, dueAt: due.toISOString(), completedAt: null };
}

export interface TicketSla {
  firstResponse: SlaClock | null;
  resolution: SlaClock | null;
  /** L'état le plus grave des deux, pour la pastille de la liste. */
  worst: 'breached' | 'at_risk' | 'ok' | null;
}

export function computeSla(ticket: SlaFields, config: SlaConfig, now = new Date()): TicketSla {
  // Une demande en attente de validation n'a pas encore commencé à compter.
  if (ticket.status === 'PENDING' || ticket.status === 'REJECTED') return { firstResponse: null, resolution: null, worst: null };
  const active = (ACTIVE_STATUSES as readonly string[]).includes(ticket.status);

  const firstResponse = config.firstResponseMinutes
    ? clock(ticket.createdAt, config.firstResponseMinutes * 60_000, ticket.firstResponseAt, active, now)
    : null;
  const resolution = config.resolutionHours
    ? clock(ticket.createdAt, config.resolutionHours * 3_600_000, ticket.closedAt, active, now)
    : null;

  const statuses = [firstResponse?.status, resolution?.status];
  const worst = statuses.includes('breached') ? 'breached'
    : statuses.includes('at_risk') ? 'at_risk'
      : statuses.some(Boolean) ? 'ok'
        : null;
  return { firstResponse, resolution, worst };
}

// ── Vues de la boîte de réception ───────────────────────

export const INBOX_VIEWS = ['open', 'unassigned', 'mine', 'waiting_staff', 'breached', 'pending', 'closed', 'all'] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];

export function normalizeView(value: unknown): InboxView {
  return typeof value === 'string' && (INBOX_VIEWS as readonly string[]).includes(value) ? value as InboxView : 'open';
}

/**
 * Filtre SQL d'une vue. `staffTurnField` est la référence de colonne Prisma
 * vers `lastStaffMessageAt`, nécessaire pour comparer deux colonnes entre
 * elles ; le service la fournit, les tests passent une valeur factice.
 */
export function viewWhere(
  view: InboxView,
  ctx: { guildId: string; userId: string; now: Date; sla: SlaConfig; staffTurnField: unknown },
): Prisma.TicketWhereInput | null {
  const base: Prisma.TicketWhereInput = { guildId: ctx.guildId };
  const active: Prisma.TicketWhereInput = { status: { in: [...ACTIVE_STATUSES] } };
  switch (view) {
    case 'open':
      return { ...base, ...active };
    case 'unassigned':
      return { ...base, status: 'OPEN', claimedById: null };
    case 'mine':
      return { ...base, ...active, claimedById: ctx.userId };
    case 'waiting_staff':
      return {
        ...base,
        ...active,
        OR: [
          { lastStaffMessageAt: null },
          { lastMemberMessageAt: { gt: ctx.staffTurnField as Date } },
        ],
      };
    case 'breached': {
      const clauses: Prisma.TicketWhereInput[] = [];
      if (ctx.sla.firstResponseMinutes) {
        clauses.push({ firstResponseAt: null, createdAt: { lt: new Date(ctx.now.getTime() - ctx.sla.firstResponseMinutes * 60_000) } });
      }
      if (ctx.sla.resolutionHours) {
        clauses.push({ createdAt: { lt: new Date(ctx.now.getTime() - ctx.sla.resolutionHours * 3_600_000) } });
      }
      // Sans objectif configuré, la vue n'a pas de sens : elle reste vide.
      if (clauses.length === 0) return null;
      return { ...base, ...active, OR: clauses };
    }
    case 'pending':
      return { ...base, status: 'PENDING' };
    case 'closed':
      return { ...base, status: { in: ['CLOSED', 'ARCHIVED'] } };
    case 'all':
      return base;
  }
}
