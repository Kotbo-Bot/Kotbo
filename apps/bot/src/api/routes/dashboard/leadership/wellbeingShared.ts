/**
 * Outils communs aux routes de la cellule de suivi : droits de la personne,
 * lecture des dossiers visibles, historique et journal d'audit.
 */
import type { Client } from 'discord.js';
import type { Context } from 'hono';
import prisma from '../../../../utils/db.js';
import { getGuildName, pushAudit } from '../../../shared.js';
import { auditUserOf } from '../../../hono/dashboard/kit.js';
import {
  UNUSUAL_ACCESS_COOLDOWN_MS,
  UNUSUAL_ACCESS_WINDOW_MS,
  WELLBEING_AUDIT_MODULE,
  caseVisibilityWhere,
  isUnusualAccess,
  openingsInWindow,
  resolveWellbeingAccess,
  wellbeingSessionExpired,
  type CaseEventDraft,
} from '../../../../services/staff/wellbeingPolicy.js';
import { appendCaseEvents } from '../../../../services/staff/wellbeingEvents.js';
import { cellActorOf, discordGuildOf } from '../../../../services/staff/wellbeingRoles.js';
import { sendWellbeingAlert } from '../../../../services/staff/wellbeingAlerts.js';

export const SNOWFLAKE_RE = /^\d{17,20}$/;

export const CASE_INCLUDE = {
  notes: { orderBy: { createdAt: 'asc' as const } },
  events: { orderBy: { createdAt: 'asc' as const } },
  attachments: { orderBy: { createdAt: 'asc' as const } },
  tasks: { orderBy: { createdAt: 'asc' as const } },
  reporterMessages: { orderBy: { createdAt: 'asc' as const } },
};

/**
 * La liste ne porte que l'en-tête des dossiers : le contenu se lit dossier par
 * dossier (GET /cases/:caseId), ce qui laisse une trace de qui a ouvert quoi.
 */
export const CASE_LIST_SELECT = {
  id: true,
  guildId: true,
  subjectUserId: true,
  subjectName: true,
  title: true,
  category: true,
  severity: true,
  status: true,
  source: true,
  assigneeId: true,
  reviewAt: true,
  lastActivityAt: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  deletedByName: true,
  purgeRequestedById: true,
  purgeRequestedByName: true,
  purgeRequestedAt: true,
} as const;

/**
 * Dossier de ce serveur que la personne peut voir : ni un dossier qui la
 * concerne (conflit d'intérêts), ni un dossier en corbeille sauf demande.
 */
export function findVisibleCase(guildId: string, caseId: string, viewerId: string, options: { trashed?: boolean } = {}) {
  return prisma.wellbeingCase.findFirst({ where: { AND: [{ id: caseId }, caseVisibilityWhere(guildId, viewerId, options)] } });
}

/**
 * Lire le contenu des dossiers exige une connexion récente : un poste resté
 * connecté des jours ne donne pas accès à la cellule. Le dashboard reconnaît
 * le code et propose de se reconnecter.
 */
export function staleSession(c: Context): Response | null {
  if (!wellbeingSessionExpired(c.var.dashboardUser.sessionCreatedAt, Date.now())) return null;
  return c.json({ error: 'Reconnectez-vous pour ouvrir les dossiers de la cellule de suivi.', code: 'WELLBEING_REAUTH' }, 403);
}

export async function resolveWellbeingRole(client: Client, guildId: string, userId: string) {
  const config = await prisma.wellbeingConfig.findUnique({ where: { guildId } });
  const discordGuild = await discordGuildOf(client, guildId);
  const actor = await cellActorOf(discordGuild, userId);

  const base = resolveWellbeingAccess(config, actor, false);
  // Seul un accès validé et non échu compte : une demande en attente n'ouvre rien.
  const activeBreakGlass = base.isDirector && !base.isTeamMember
    ? await prisma.wellbeingBreakGlassLog.findFirst({
        where: { guildId, actorId: userId, status: 'APPROVED', expiresAt: { gt: new Date() } },
        orderBy: { expiresAt: 'desc' },
      })
    : null;

  return {
    ...resolveWellbeingAccess(config, actor, !!activeBreakGlass),
    config,
    discordGuild,
    activeBreakGlass,
  };
}

export type WellbeingState = Awaited<ReturnType<typeof resolveWellbeingRole>>;

/** Un référent doit appartenir à la cellule : il lit le dossier qu'on lui confie. */
export async function isTeamMemberId(state: WellbeingState, userId: string): Promise<boolean> {
  if (!SNOWFLAKE_RE.test(userId)) return false;
  return resolveWellbeingAccess(state.config, await cellActorOf(state.discordGuild, userId), false).isTeamMember;
}

export function actorName(c: Context): string {
  const user = c.var.dashboardUser;
  return user.username ?? user.userId;
}

export async function recordEvents(caseId: string, c: Context, drafts: Array<CaseEventDraft | { type: string; fromValue?: string | null; toValue?: string | null }>) {
  if (drafts.length === 0) return;
  await appendCaseEvents(caseId, drafts.map((draft) => ({
    type: draft.type,
    actorId: c.var.dashboardUser.userId,
    actorName: actorName(c),
    fromValue: draft.fromValue ?? null,
    toValue: draft.toValue ?? null,
  })));
}

export async function audit(client: Client, c: Context, guildId: string, action: string, details: string, eventType = 'Manuel') {
  await pushAudit(guildId, {
    user: auditUserOf(c),
    action,
    context: getGuildName(client, guildId),
    module: WELLBEING_AUDIT_MODULE,
    eventType,
    details,
    channelId: null,
  });
}

// ── Consultation inhabituelle ──────────────────────────────────────────────

/** Dernière alerte de consultation inhabituelle, par serveur et par personne. */
const unusualAlertAt = new Map<string, number>();
/**
 * Fiches ouvertes, par serveur et par personne. Une fiche n'a pas d'historique
 * comme un dossier : ses ouvertures sont comptées ici, sur la seule fenêtre.
 */
const profileOpenings = new Map<string, number[]>();

/** Une fiche vient d'être ouverte : elle compte pour la consultation inhabituelle. */
export function recordProfileOpening(guildId: string, userId: string, now: Date): void {
  const key = `${guildId}:${userId}`;
  profileOpenings.set(key, [...openingsInWindow(profileOpenings.get(key) ?? [], now.getTime()), now.getTime()]);
}

/**
 * Beaucoup de dossiers et de fiches ouverts en peu de temps par une même
 * personne : compte inhabituel ou curiosité, la cellule est prévenue (une
 * fois par heure).
 */
export async function checkUnusualAccess(client: Client, c: Context, guildId: string, config: WellbeingState['config'], now: Date): Promise<void> {
  const userId = c.var.dashboardUser.userId;
  const key = `${guildId}:${userId}`;
  const cases = await prisma.wellbeingCaseEvent.count({
    where: { type: 'VIEWED', actorId: userId, createdAt: { gte: new Date(now.getTime() - UNUSUAL_ACCESS_WINDOW_MS) }, wellbeingCase: { guildId } },
  });
  const opened = cases + openingsInWindow(profileOpenings.get(key) ?? [], now.getTime()).length;
  if (!isUnusualAccess(opened)) return;
  const last = unusualAlertAt.get(key);
  if (last !== undefined && now.getTime() - last < UNUSUAL_ACCESS_COOLDOWN_MS) return;
  unusualAlertAt.set(key, now.getTime());
  await audit(client, c, guildId, 'Consultation Cellule de suivi',
    `Consultation inhabituelle : ${opened} dossiers ou fiches ouverts en ${UNUSUAL_ACCESS_WINDOW_MS / 60_000} minutes.`, 'Sécurité');
  void sendWellbeingAlert(client, guildId, config, 'UNUSUAL_ACCESS', { actorId: userId, caseCount: opened });
}
