/**
 * Chronologie d'un membre : tout ce qui le concerne sur le serveur, dans une
 * seule liste datée.
 *
 * Comme le fil d'activité d'une fiche contact de CRM, chaque source garde sa
 * table et se contente de produire des événements au même format ; la fusion
 * et la pagination se font ici. La pagination est par curseur de date
 * (`before`) : chaque source renvoie ses `limit` événements les plus récents
 * avant ce curseur, la fusion garde les `limit` premiers, et le dernier gardé
 * devient le curseur suivant. Aucun événement ne peut donc être sauté.
 */
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

export type TimelineCategory = 'membership' | 'moderation' | 'support' | 'community' | 'changes';
export type TimelineTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export interface TimelineItem {
  id: string;
  type: string;
  category: TimelineCategory;
  at: string;
  title: string;
  description: string | null;
  actor: { id: string | null; name: string | null } | null;
  /** Lien vers l'écran du dashboard qui porte le détail. */
  link: string | null;
  tone: TimelineTone;
}

export const TIMELINE_CATEGORIES: TimelineCategory[] = ['membership', 'moderation', 'support', 'community', 'changes'];

type Source = {
  category: TimelineCategory;
  load: (ctx: SourceContext) => Promise<TimelineItem[]>;
};

interface SourceContext {
  guildId: string;
  userId: string;
  before: Date;
  limit: number;
}

const SANCTION_LABEL: Record<string, string> = {
  WARN: 'Avertissement',
  KICK: 'Exclusion',
  TIMEOUT: 'Mise en sourdine',
  TEMP_BAN: 'Bannissement temporaire',
  BAN: 'Bannissement',
  SOFTBAN: 'Softban',
};

const truncate = (text: string | null | undefined, max = 220) =>
  !text ? null : text.length > max ? `${text.slice(0, max - 1)}…` : text;

function formatDuration(seconds: number | null): string | null {
  if (!seconds) return null;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86_400)} j`;
}

const SOURCES: Source[] = [
  // ── Arrivées et départs ────────────────────────────────
  {
    category: 'membership',
    load: async ({ guildId, userId, before, limit }) => {
      const joins = await prisma.memberInvite.findMany({
        where: { guildId, userId, joinedAt: { lt: before } },
        orderBy: { joinedAt: 'desc' },
        take: limit,
        select: { id: true, joinedAt: true, leftAt: true, inviteCode: true, inviterId: true, inviterTag: true },
      });
      const items: TimelineItem[] = [];
      for (const join of joins) {
        items.push({
          id: `join:${join.id}`,
          type: 'member.joined',
          category: 'membership',
          at: join.joinedAt.toISOString(),
          title: 'A rejoint le serveur',
          description: join.inviteCode
            ? `Invitation ${join.inviteCode}${join.inviterTag ? ` de ${join.inviterTag}` : ''}`
            : null,
          actor: join.inviterId ? { id: join.inviterId, name: join.inviterTag } : null,
          link: join.inviteCode ? `/invitations/${join.inviteCode}` : null,
          tone: 'success',
        });
        if (join.leftAt && join.leftAt < before) {
          const stayedDays = Math.round((join.leftAt.getTime() - join.joinedAt.getTime()) / 86_400_000);
          items.push({
            id: `leave:${join.id}`,
            type: 'member.left',
            category: 'membership',
            at: join.leftAt.toISOString(),
            title: 'A quitté le serveur',
            description: stayedDays < 1 ? "Moins d'un jour après son arrivée" : `Après ${stayedDays} jour(s)`,
            actor: null,
            link: null,
            tone: 'neutral',
          });
        }
      }
      return items;
    },
  },
  {
    category: 'membership',
    load: async ({ guildId, userId, before, limit }) => {
      const invited = await prisma.memberInvite.findMany({
        where: { guildId, inviterId: userId, joinedAt: { lt: before } },
        orderBy: { joinedAt: 'desc' },
        take: limit,
        select: { id: true, userId: true, joinedAt: true, leftAt: true, inviteCode: true },
      });
      const profiles = invited.length > 0
        ? await prisma.memberProfile.findMany({
          where: { guildId, userId: { in: invited.map((row) => row.userId) } },
          select: { userId: true, username: true, displayName: true },
        })
        : [];
      const names = new Map(profiles.map((p) => [p.userId, p.displayName ?? p.username]));
      return invited.map((row) => ({
        id: `invited:${row.id}`,
        type: 'member.invited',
        category: 'membership' as const,
        at: row.joinedAt.toISOString(),
        title: `A fait venir ${names.get(row.userId) ?? 'un membre'}`,
        description: row.leftAt ? 'Parti depuis' : 'Toujours sur le serveur',
        actor: { id: row.userId, name: names.get(row.userId) ?? null },
        link: `/members/${row.userId}`,
        tone: 'info' as const,
      }));
    },
  },

  // ── Modération ─────────────────────────────────────────
  {
    category: 'moderation',
    load: async ({ guildId, userId, before, limit }) => {
      const sanctions = await prisma.sanction.findMany({
        where: { guildId, targetUserId: userId, createdAt: { lt: before } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true, type: true, status: true, reason: true, durationSeconds: true, moderatorUserId: true,
          moderatorTag: true, createdAt: true, resolvedAt: true, resolutionNote: true, archivedAt: true,
        },
      });
      const items: TimelineItem[] = [];
      for (const s of sanctions) {
        const duration = formatDuration(s.durationSeconds);
        items.push({
          id: `sanction:${s.id}`,
          type: 'sanction.applied',
          category: 'moderation',
          at: s.createdAt.toISOString(),
          title: `${SANCTION_LABEL[s.type] ?? s.type}${duration ? ` (${duration})` : ''}${s.archivedAt ? ' · archivée' : ''}`,
          description: truncate(s.reason),
          actor: { id: s.moderatorUserId, name: s.moderatorTag },
          link: `/security/sanctions?sanction=${s.id}`,
          tone: s.type === 'WARN' ? 'warning' : 'danger',
        });
        if (s.resolvedAt && s.resolvedAt < before && (s.type === 'BAN' || s.type === 'TEMP_BAN' || s.type === 'TIMEOUT')) {
          items.push({
            id: `sanction-end:${s.id}`,
            type: 'sanction.revoked',
            category: 'moderation',
            at: s.resolvedAt.toISOString(),
            title: `${SANCTION_LABEL[s.type] ?? s.type} levé(e)`,
            description: truncate(s.resolutionNote),
            actor: null,
            link: `/security/sanctions?sanction=${s.id}`,
            tone: 'neutral',
          });
        }
      }
      return items;
    },
  },
  {
    category: 'moderation',
    load: async ({ guildId, userId, before, limit }) => {
      const reports = await prisma.memberReport.findMany({
        where: { guildId, targetId: userId, createdAt: { lt: before } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, reporterId: true, reason: true, status: true, createdAt: true },
      });
      return reports.map((r) => ({
        id: `report:${r.id}`,
        type: 'member.reported',
        category: 'moderation' as const,
        at: r.createdAt.toISOString(),
        title: r.status === 'PENDING' ? 'Signalé par un membre (en attente)' : r.status === 'RESOLVED' ? 'Signalé par un membre (traité)' : 'Signalé par un membre (classé)',
        description: truncate(r.reason),
        actor: { id: r.reporterId, name: null },
        link: '/security/anti-raid/queues',
        tone: 'warning' as const,
      }));
    },
  },
  {
    category: 'moderation',
    load: async ({ guildId, userId, before, limit }) => {
      const appeals = await prisma.banAppeal.findMany({
        where: { guildId, userId, createdAt: { lt: before } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, status: true, createdAt: true, decidedAt: true, decidedByUserId: true, decidedByTag: true, decisionReason: true },
      });
      const items: TimelineItem[] = [];
      for (const a of appeals) {
        items.push({
          id: `appeal:${a.id}`,
          type: 'appeal.created',
          category: 'moderation',
          at: a.createdAt.toISOString(),
          title: 'A contesté son bannissement',
          description: null,
          actor: null,
          link: '/security/sanctions/appeals',
          tone: 'info',
        });
        if (a.decidedAt && a.decidedAt < before) {
          items.push({
            id: `appeal-decision:${a.id}`,
            type: 'appeal.decided',
            category: 'moderation',
            at: a.decidedAt.toISOString(),
            title: a.status === 'ACCEPTED' ? 'Contestation acceptée' : a.status === 'DENIED' || a.status === 'DENIED_PERMANENT' ? 'Contestation refusée' : 'Contestation traitée',
            description: truncate(a.decisionReason),
            actor: { id: a.decidedByUserId, name: a.decidedByTag },
            link: '/security/sanctions/appeals',
            tone: a.status === 'ACCEPTED' ? 'success' : 'neutral',
          });
        }
      }
      return items;
    },
  },
  {
    category: 'moderation',
    load: async ({ guildId, userId, before, limit }) => {
      const links = await prisma.linkedAccount.findMany({
        where: { guildId, OR: [{ user1Id: userId }, { user2Id: userId }], createdAt: { lt: before } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, user1Id: true, user2Id: true, type: true, status: true, reason: true, createdAt: true, linkedByUserId: true },
      });
      return links.map((l) => {
        const other = l.user1Id === userId ? l.user2Id : l.user1Id;
        return {
          id: `linked:${l.id}`,
          type: 'account.linked',
          category: 'moderation' as const,
          at: l.createdAt.toISOString(),
          title: l.type === 'AUTOMATIC' ? 'Double compte détecté' : 'Compte lié par le staff',
          description: truncate(l.reason),
          actor: { id: other, name: null },
          link: `/members/${other}`,
          tone: l.status === 'REJECTED' ? 'neutral' as const : 'warning' as const,
        };
      });
    },
  },
  {
    category: 'moderation',
    load: async ({ guildId, userId, before, limit }) => {
      const verifications = await prisma.securityVerification.findMany({
        where: { guildId, userId, createdAt: { lt: before } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, status: true, createdAt: true },
      }).catch(() => []);
      return verifications.map((v) => ({
        id: `verification:${v.id}`,
        type: 'verification.requested',
        category: 'moderation' as const,
        at: v.createdAt.toISOString(),
        title: v.status === 'VERIFIED' ? 'Vérification de sécurité réussie' : v.status === 'FLAGGED' ? 'Vérification de sécurité signalée' : v.status === 'EXPIRED' ? 'Vérification de sécurité expirée' : 'Vérification de sécurité demandée',
        description: null,
        actor: null,
        link: null,
        tone: v.status === 'VERIFIED' ? 'success' as const : v.status === 'FLAGGED' ? 'danger' as const : 'info' as const,
      }));
    },
  },

  // ── Support ────────────────────────────────────────────
  {
    category: 'support',
    load: async ({ guildId, userId, before, limit }) => {
      const tickets = await prisma.ticket.findMany({
        where: { guildId, userId, createdAt: { lt: before } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true, reason: true, ticketTypeLabel: true, status: true, createdAt: true, closedAt: true,
          closedById: true, closedByName: true, claimedById: true, claimedByName: true,
        },
      });
      const items: TimelineItem[] = [];
      for (const t of tickets) {
        items.push({
          id: `ticket:${t.id}`,
          type: 'ticket.created',
          category: 'support',
          at: t.createdAt.toISOString(),
          title: `A ouvert un ticket${t.ticketTypeLabel ? ` « ${t.ticketTypeLabel} »` : ''}`,
          description: truncate(t.reason),
          actor: t.claimedById ? { id: t.claimedById, name: t.claimedByName } : null,
          link: `/tickets?ticket=${t.id}`,
          tone: 'info',
        });
        if (t.closedAt && t.closedAt < before) {
          items.push({
            id: `ticket-closed:${t.id}`,
            type: 'ticket.closed',
            category: 'support',
            at: t.closedAt.toISOString(),
            title: 'Ticket fermé',
            description: `Ouvert ${formatDuration(Math.round((t.closedAt.getTime() - t.createdAt.getTime()) / 1000)) ?? ''}`.trim(),
            actor: t.closedById ? { id: t.closedById, name: t.closedByName } : null,
            link: `/tickets?ticket=${t.id}`,
            tone: 'neutral',
          });
        }
      }
      return items;
    },
  },
  {
    category: 'support',
    load: async ({ guildId, userId, before, limit }) => {
      const ratings = await prisma.ticketSatisfaction.findMany({
        where: { guildId, userId, createdAt: { lt: before } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, rating: true, comment: true, createdAt: true, staffId: true },
      }).catch(() => []);
      return ratings.map((r) => ({
        id: `rating:${r.id}`,
        type: 'ticket.rated',
        category: 'support' as const,
        at: r.createdAt.toISOString(),
        title: `A noté le support ${r.rating}/5`,
        description: truncate(r.comment),
        actor: r.staffId ? { id: r.staffId, name: null } : null,
        link: '/tickets/satisfaction',
        tone: r.rating >= 4 ? 'success' as const : r.rating <= 2 ? 'warning' as const : 'neutral' as const,
      }));
    },
  },

  // ── Communauté ─────────────────────────────────────────
  {
    category: 'community',
    load: async ({ guildId, userId, before, limit }) => {
      const suggestions = await prisma.suggestion.findMany({
        where: { guildId, userId, createdAt: { lt: before } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, content: true, status: true, createdAt: true, upvoters: true, downvoters: true },
      });
      return suggestions.map((s) => ({
        id: `suggestion:${s.id}`,
        type: 'suggestion.created',
        category: 'community' as const,
        at: s.createdAt.toISOString(),
        title: `A proposé une suggestion (${s.upvoters.length} pour, ${s.downvoters.length} contre)`,
        description: truncate(s.content),
        actor: null,
        link: '/suggestions',
        tone: s.status === 'APPROVED' || s.status === 'IMPLEMENTED' ? 'success' as const : 'neutral' as const,
      }));
    },
  },
  {
    category: 'community',
    load: async ({ guildId, userId, before, limit }) => {
      const submissions = await prisma.customFormSubmission.findMany({
        where: { guildId, userId, createdAt: { lt: before } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, createdAt: true, form: { select: { id: true, name: true } } },
      });
      return submissions.map((s) => ({
        id: `form:${s.id}`,
        type: 'form.submitted',
        category: 'community' as const,
        at: s.createdAt.toISOString(),
        title: `A répondu au formulaire « ${s.form.name} »`,
        description: null,
        actor: null,
        link: `/forms/${s.form.id}/responses`,
        tone: 'neutral' as const,
      }));
    },
  },
  {
    category: 'community',
    load: async ({ guildId, userId, before, limit }) => {
      const giveaways = await prisma.giveaway.findMany({
        where: { guildId, winners: { has: userId }, endsAt: { lt: before } },
        orderBy: { endsAt: 'desc' },
        take: limit,
        select: { id: true, prize: true, endsAt: true },
      });
      return giveaways.map((g) => ({
        id: `giveaway:${g.id}`,
        type: 'giveaway.won',
        category: 'community' as const,
        at: g.endsAt.toISOString(),
        title: `A gagné « ${g.prize} »`,
        description: null,
        actor: null,
        link: '/giveaways',
        tone: 'success' as const,
      }));
    },
  },
  {
    category: 'community',
    load: async ({ guildId, userId, before, limit }) => {
      const votes = await prisma.reputationVote.findMany({
        where: { guildId, OR: [{ receiverId: userId }, { giverId: userId }], createdAt: { lt: before } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, giverId: true, receiverId: true, value: true, reason: true, createdAt: true },
      });
      return votes.map((v) => {
        const received = v.receiverId === userId;
        const other = received ? v.giverId : v.receiverId;
        const sign = v.value > 0 ? '+' : '−';
        return {
          id: `rep:${v.id}`,
          type: received ? 'reputation.received' : 'reputation.given',
          category: 'community' as const,
          at: v.createdAt.toISOString(),
          title: received ? `A reçu ${sign}1 de réputation` : `A donné ${sign}1 de réputation`,
          description: truncate(v.reason),
          actor: { id: other, name: null },
          link: `/members/${other}`,
          tone: received && v.value > 0 ? 'success' as const : 'neutral' as const,
        };
      });
    },
  },

  // ── Changements de profil (journal d'audit Discord) ────
  {
    category: 'changes',
    load: async ({ guildId, userId, before, limit }) => {
      const events = await prisma.auditEvent.findMany({
        where: { guildId, targetType: 'MEMBER', targetId: userId, createdAt: { lt: before } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, eventType: true, changedFields: true, executorId: true, executorName: true, reason: true, createdAt: true },
      });
      return events.map((e) => ({
        id: `audit:${e.id}`,
        type: `audit.${e.eventType.toLowerCase()}`,
        category: 'changes' as const,
        at: e.createdAt.toISOString(),
        title: describeAuditEvent(e.eventType, e.changedFields),
        description: truncate(e.reason),
        actor: e.executorId ? { id: e.executorId, name: e.executorName } : null,
        link: '/activity',
        tone: 'neutral' as const,
      }));
    },
  },
];

const AUDIT_FIELD_LABEL: Record<string, string> = {
  nick: 'pseudo',
  nickname: 'pseudo',
  roles: 'rôles',
  avatar: 'avatar',
  communication_disabled_until: 'mise en sourdine',
  communicationDisabledUntil: 'mise en sourdine',
  deaf: 'sourdine vocale',
  mute: 'micro coupé',
};

export function describeAuditEvent(eventType: string, changedFields: string[]): string {
  const fields = [...new Set(changedFields.map((field) => AUDIT_FIELD_LABEL[field] ?? null).filter(Boolean))];
  if (fields.length > 0) return `Modification : ${fields.join(', ')}`;
  return `Événement Discord ${eventType.toLowerCase().replace(/_/g, ' ')}`;
}

/** Fusionne des listes déjà triées par date décroissante et garde les `limit` premiers. */
export function mergeTimeline(lists: TimelineItem[][], limit: number): TimelineItem[] {
  return lists
    .flat()
    .sort((a, b) => (a.at === b.at ? b.id.localeCompare(a.id) : b.at.localeCompare(a.at)))
    .slice(0, limit);
}

export async function getMemberTimeline(
  guildId: string,
  userId: string,
  options: { before?: Date | null; limit?: number; categories?: TimelineCategory[] } = {},
): Promise<{ items: TimelineItem[]; nextBefore: string | null }> {
  const limit = Math.min(100, Math.max(5, options.limit ?? 40));
  const before = options.before ?? new Date(Date.now() + 60_000);
  const wanted = new Set(options.categories?.length ? options.categories : TIMELINE_CATEGORIES);

  const lists = await Promise.all(
    SOURCES.filter((source) => wanted.has(source.category)).map((source) =>
      source.load({ guildId, userId, before, limit }).catch((err) => {
        // Une source en panne ne doit pas vider toute la chronologie.
        logger.warn('MemberTimeline', `Source ${source.category} indisponible pour ${userId} :`, err);
        return [] as TimelineItem[];
      }),
    ),
  );

  const items = mergeTimeline(lists, limit);
  return { items, nextBefore: items.length === limit ? items[items.length - 1].at : null };
}
