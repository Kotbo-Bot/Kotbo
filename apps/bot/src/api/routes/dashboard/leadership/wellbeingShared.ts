/**
 * Outils communs aux routes de la cellule de suivi : droits de la personne,
 * lecture des dossiers visibles, historique et journal d'audit.
 */
import type { Client } from 'discord.js';
import type { Context } from 'hono';
import { randomUUID } from 'node:crypto';
import prisma from '../../../../utils/db.js';
import { bodyText } from '../../../../utils/bodyText.js';
import { getGuildName, pushAudit } from '../../../shared.js';
import { auditUserOf } from '../../../hono/dashboard/kit.js';
import {
  UNUSUAL_ACCESS_COOLDOWN_MS,
  UNUSUAL_ACCESS_WINDOW_MS,
  forgetStale,
  isUnusualAccess,
  openingsInWindow,
} from '../../../../services/staff/wellbeingAlertPolicy.js';
import {
  WELLBEING_AUDIT_MODULE,
  cellMemberIds,
  resolveWellbeingAccess,
  wellbeingSessionExpired,
} from '../../../../services/staff/wellbeingAccessPolicy.js';
import { caseVisibilityWhere, type CaseEventDraft } from '../../../../services/staff/wellbeingCasePolicy.js';
import { appendCaseEvents } from '../../../../services/staff/wellbeingEvents.js';
import { cellActorOf, discordGuildOf, loadCellMembers } from '../../../../services/staff/wellbeingRoles.js';
import { openCase } from '../../../../services/staff/wellbeingCrypto.js';
import {
  cleanCaseCategories,
  cleanCrisisTasks,
  cleanNoteTemplates,
  cleanTags,
  cleanTaskPlans,
  crisisTasksOf,
} from '../../../../services/staff/wellbeingCustomPolicy.js';
import { sendWellbeingAlert } from '../../../../services/staff/wellbeingAlerts.js';

export const SNOWFLAKE_RE = /^\d{17,20}$/;
export const HOUR_MS = 60 * 60 * 1000;

/** Identifiant d'une nouvelle colonne de la vue en colonnes. */
export const newColumnId = () => randomUUID().slice(0, 8);

/** Échéance envoyée par la page : `undefined` si absente ou invalide, `null` pour l'effacer. */
export function parseReviewAt(value: unknown): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const date = new Date(bodyText(value, 40));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

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
  stage: true,
  tagIds: true,
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
  // Une personne sans ouverture récente n'a plus rien à compter.
  if (profileOpenings.size > 500) {
    for (const [other, times] of profileOpenings) if (openingsInWindow(times, now.getTime()).length === 0) profileOpenings.delete(other);
  }
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
  forgetStale(unusualAlertAt, now.getTime(), UNUSUAL_ACCESS_COOLDOWN_MS);
  await audit(client, c, guildId, 'Consultation Cellule de suivi',
    `Consultation inhabituelle : ${opened} dossiers ou fiches ouverts en ${UNUSUAL_ACCESS_WINDOW_MS / 60_000} minutes.`, 'Sécurité');
  void sendWellbeingAlert(client, guildId, config, 'UNUSUAL_ACCESS', { actorId: userId, caseCount: opened });
}

/** Membres de la cellule, rôles compris : le cache est complété au besoin. */
export async function teamIdsOf(state: WellbeingState): Promise<string[]> {
  if (!state.config) return [];
  await loadCellMembers(state.discordGuild, state.config.teamRoleIds);
  return cellMemberIds(state.config, [...(state.discordGuild?.members.cache.values() ?? [])].map((member) => ({ id: member.id, roleIds: [...member.roles.cache.keys()] })));
}

/** Relit un dossier complet après un geste. */
export async function fullCase(caseId: string) {
  return openCase(await prisma.wellbeingCase.findUniqueOrThrow({ where: { id: caseId }, include: CASE_INCLUDE }));
}

type CustomizationSource = { caseCategories?: unknown; crisisTasks?: unknown; taskPlans?: unknown; caseTags?: unknown; noteTemplates?: unknown } | null | undefined;

/**
 * Réglages de la cellule lus en base, nettoyés. `crisisTasks` est le protocole
 * appliqué (celui de départ si la cellule n'a rien réglé, `crisisDefault`).
 */
export function customizationOf(config: CustomizationSource) {
  const crisisTasks = cleanCrisisTasks(config?.crisisTasks);
  return {
    categories: cleanCaseCategories(config?.caseCategories, newColumnId),
    crisisTasks: [...crisisTasksOf(crisisTasks)],
    crisisDefault: crisisTasks.length === 0,
    taskPlans: cleanTaskPlans(config?.taskPlans, newColumnId),
    tags: cleanTags(config?.caseTags, newColumnId),
    noteTemplates: cleanNoteTemplates(config?.noteTemplates, newColumnId),
  };
}
