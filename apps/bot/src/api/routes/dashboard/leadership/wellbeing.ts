/**
 * Cellule bien-être : espace confidentiel cloisonné avec accès d'urgence
 * journalisé pour la direction en cas d'enquête interne.
 *
 * Les textes des dossiers sont chiffrés en base (wellbeingCrypto), chaque
 * modification laisse une entrée d'historique, et l'accès d'urgence peut
 * exiger la validation d'une seconde personne et se limiter à un membre.
 */
import { Hono, type Context } from 'hono';
import type { Client } from 'discord.js';
import type { Prisma } from '@prisma/client';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { getGuildName } from '../../../shared.js';
import { fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
import {
  ATTACHMENT_LABEL_MAX,
  BREAK_GLASS_HOURS,
  MAX_CASE_ATTACHMENTS,
  cleanDriveLink,
  BREAK_GLASS_REQUEST_HOURS,
  CASE_TRASH_DAYS,
  DEFAULT_ALERT_EVENTS,
  WELLBEING_AUDIT_MODULE,
  MAX_ALERT_USERS,
  MAX_CASE_TASKS,
  TASK_LABEL_MAX,
  accessReviewDue,
  REPORTER_REPLY_MAX,
  alertPreviews,
  assigneeConflict,
  emptiesComposition,
  journalCsv,
  canEditNote,
  cleanCloseReason,
  isCaseSubject,
  reminderRecipient,
  breakGlassScope,
  caseVisibilityWhere,
  endBreakGlassError,
  purgeApprovalError,
  purgeRequestPending,
  shouldRecordView,
  UNUSUAL_ACCESS_COOLDOWN_MS,
  UNUSUAL_ACCESS_WINDOW_MS,
  agendaItems,
  cleanMentionIds,
  isUnusualAccess,
  mentionText,
  verifyCaseEventChain,
  wellbeingCellStats,
  caseChangeEvents,
  cleanAlertEvents,
  cleanResources,
  decideBreakGlassError,
  describeConfigChange,
  resourcesMessage,
  MAX_FOLLOW_UP_DAYS,
  PULSE_WEEKS_SHOWN,
  cellMemberIds,
  followUpDate,
  pulseSummary,
  referentLoad,
  suggestAssignee,
  ticketCaseSummary,
  type CaseEventDraft,
  type CaseTracked,
} from '../../../../services/staff/wellbeingPolicy.js';
import { sendWellbeingAlert, sendWellbeingDirect } from '../../../../services/staff/wellbeingAlerts.js';
import { currentAbsence } from '../../../../services/staff/wellbeingAbsence.js';
import { cancelDissolution, requestDissolution } from '../../../../services/staff/wellbeingDissolution.js';
import { openCase, openCaseHeader, openNote, sealCaseFields, sealNote, sealWellbeing } from '../../../../services/staff/wellbeingCrypto.js';
import { applyCrisisProtocolIfDue } from '../../../../services/staff/wellbeingCrisis.js';
import { closeTicket } from '../../../../services/features/ticketService.js';
import { wellbeingPanelMessage } from '../../../../commands/utility/wellbeing.js';
import { resolveGuildLocale } from '../../../../utils/i18n.js';
import { bodyText } from '../../../../utils/bodyText.js';
import { PROFILE_RETENTION_DEFAULT_MONTHS, cleanProfileRetention } from '../../../../services/staff/wellbeingProfilePolicy.js';
import {
  CASE_INCLUDE,
  CASE_LIST_SELECT,
  SNOWFLAKE_RE,
  actorName,
  audit,
  findVisibleCase,
  isTeamMemberId,
  recordEvents,
  resolveWellbeingRole,
  staleSession,
  type WellbeingState,
} from './wellbeingShared.js';

const CATEGORIES = ['SOUTIEN', 'MEDIATION', 'SIGNALEMENT', 'SUIVI'];
const SEVERITIES = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'];
const STATUSES = ['OPEN', 'MONITORING', 'CLOSED'];
const HOUR_MS = 60 * 60 * 1000;
const MAX_STALE_DAYS = 90;

/** Dernière alerte de consultation inhabituelle, par serveur et par personne. */
const unusualAlertAt = new Map<string, number>();

/** Id d'un dossier de ce serveur, ou null : un id inconnu n'entre pas au journal. */
async function caseIdOfGuild(guildId: string, caseId: unknown): Promise<string | null> {
  const id = bodyText(caseId, 64);
  if (!id) return null;
  const found = await prisma.wellbeingCase.findFirst({ where: { id, guildId }, select: { id: true } });
  return found?.id ?? null;
}

function parseReviewAt(value: unknown): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const date = new Date(bodyText(value, 40));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function createWellbeingRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/wellbeing';
  const gate = guildRoute(client);

  /** Membres de la cellule présents sur le serveur, désignés ou par rôle. */
  const teamIdsOf = (state: WellbeingState) => (state.config
    ? cellMemberIds(state.config, [...(state.discordGuild?.members.cache.values() ?? [])].map((member) => ({ id: member.id, roleIds: [...member.roles.cache.keys()] })))
    : []);

  /** Relit un dossier complet après un geste. */
  const fullCase = async (caseId: string) =>
    openCase(await prisma.wellbeingCase.findUniqueOrThrow({ where: { id: caseId }, include: CASE_INCLUDE }));

  router.get(`${base}/status`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const state = await resolveWellbeingRole(client, guildId, c.var.dashboardUser.userId);
      return send(c, {
        enabled: state.config?.enabled ?? false,
        requireReason: state.config?.requireReason ?? true,
        breakGlassApproval: state.config?.breakGlassApproval ?? false,
        reportEnabled: state.config?.reportEnabled ?? false,
        isTeamMember: state.isTeamMember,
        isDirector: state.isDirector,
        canConfigure: state.canConfigure,
        hasCaseAccess: state.canReadCases,
        canWriteCases: state.canWriteCases,
        breakGlassExpiresAt: state.activeBreakGlass?.expiresAt.toISOString() ?? null,
        breakGlassLogId: state.activeBreakGlass?.id ?? null,
        // La revue des accès ne concerne que le propriétaire, seul à changer la composition.
        accessReviewDue: state.canConfigure && !!state.config?.enabled && accessReviewDue(state.config, new Date()),
        // Désactivation demandée : visible de la cellule, annulable par le propriétaire.
        dissolutionAt: state.config?.dissolutionAt?.toISOString() ?? null,
        dissolutionByName: state.config?.dissolutionByName ?? null,
      });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error fetching status:', err);
      return fail(c, err, 'Erreur lors du chargement de la cellule bien-être.', 'WellbeingAPI');
    }
  });

  router.get(`${base}/config`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const state = await resolveWellbeingRole(client, guildId, c.var.dashboardUser.userId);
      if (!state.isDirector) return send(c, { error: 'Réservé à la direction.' }, 403);
      const { resources: _resources, ...config } = state.config ?? {
        guildId,
        enabled: false,
        teamRoleIds: [],
        teamUserIds: [],
        directorRoleIds: [],
        directorUserIds: [],
        requireReason: true,
        alertChannelId: null,
        alertUserIds: [],
        alertEvents: DEFAULT_ALERT_EVENTS,
        breakGlassApproval: false,
        reportEnabled: false,
        staleCriticalDays: 7,
        crisisProtocol: true,
        followUpDays: 30,
        sanctionSignal: false,
        distressWatch: false,
        pulseEnabled: false,
        pulseRoleIds: [],
        networkPool: false,
        profileRetentionMonths: PROFILE_RETENTION_DEFAULT_MONTHS,
        resources: [],
      };
      return send(c, { config });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error fetching config:', err);
      return fail(c, err, 'Erreur lors du chargement de la configuration.', 'WellbeingAPI');
    }
  });

  router.put(`${base}/config`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canConfigure) {
        return send(c, { error: 'Seul le propriétaire du serveur peut modifier la cellule bien-être.' }, 403);
      }
      const body = await readBody<{
        enabled?: boolean;
        teamRoleIds?: string[];
        teamUserIds?: string[];
        directorRoleIds?: string[];
        directorUserIds?: string[];
        requireReason?: boolean;
        alertChannelId?: string | null;
        alertUserIds?: string[];
        alertEvents?: string[];
        breakGlassApproval?: boolean;
        reportEnabled?: boolean;
        staleCriticalDays?: number;
        backupUserId?: string | null;
        crisisProtocol?: boolean;
        followUpDays?: number;
        sanctionSignal?: boolean;
        distressWatch?: boolean;
        pulseEnabled?: boolean;
        pulseRoleIds?: string[];
        networkPool?: boolean;
        profileRetentionMonths?: number;
      }>(c);
      const cleanIds = (arr: unknown) =>
        Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string' && SNOWFLAKE_RE.test(x)) : [];
      // Un salon d'alerte doit appartenir au serveur : sinon les alertes partiraient ailleurs.
      const alertChannelId = (() => {
        const id = bodyText(body?.alertChannelId, 20);
        return SNOWFLAKE_RE.test(id) && state.discordGuild?.channels.cache.has(id) ? id : null;
      })();
      const alertUserIds = [...new Set(cleanIds(body?.alertUserIds))].slice(0, MAX_ALERT_USERS);
      const alertEvents = cleanAlertEvents(body?.alertEvents);
      const staleCriticalDays = typeof body?.staleCriticalDays === 'number' && Number.isInteger(body.staleCriticalDays)
        ? Math.min(Math.max(body.staleCriticalDays, 0), MAX_STALE_DAYS)
        : undefined;
      const followUpDays = typeof body?.followUpDays === 'number' && Number.isInteger(body.followUpDays)
        ? Math.min(Math.max(body.followUpDays, 0), MAX_FOLLOW_UP_DAYS)
        : undefined;
      const profileRetentionMonths = cleanProfileRetention(body?.profileRetentionMonths);
      // Les rôles interrogés par la météo du staff doivent exister sur le serveur.
      const pulseRoleIds = body?.pulseRoleIds !== undefined
        ? cleanIds(body.pulseRoleIds).filter((id) => state.discordGuild?.roles.cache.has(id))
        : undefined;
      const toggles = {
        ...(typeof body?.crisisProtocol === 'boolean' ? { crisisProtocol: body.crisisProtocol } : {}),
        ...(typeof body?.sanctionSignal === 'boolean' ? { sanctionSignal: body.sanctionSignal } : {}),
        ...(typeof body?.distressWatch === 'boolean' ? { distressWatch: body.distressWatch } : {}),
        ...(typeof body?.pulseEnabled === 'boolean' ? { pulseEnabled: body.pulseEnabled } : {}),
        ...(typeof body?.networkPool === 'boolean' ? { networkPool: body.networkPool } : {}),
        ...(profileRetentionMonths !== undefined ? { profileRetentionMonths } : {}),
        ...(followUpDays !== undefined ? { followUpDays } : {}),
        ...(pulseRoleIds !== undefined ? { pulseRoleIds } : {}),
      };
      // Le suppléant est un membre désigné de la cellule ; il perd ce rôle s'il en sort.
      const teamUserIdsAfter = body?.teamUserIds !== undefined ? cleanIds(body.teamUserIds) : (state.config?.teamUserIds ?? []);
      const requestedBackup = body?.backupUserId === undefined ? state.config?.backupUserId ?? null : bodyText(body.backupUserId, 20);
      const backupUserId = requestedBackup && teamUserIdsAfter.includes(requestedBackup) ? requestedBackup : null;

      // Désactiver ou vider une cellule active ne se fait pas d'un clic : la
      // désactivation est différée de 24 h et annoncée ; vider la composition
      // est refusé, puisque c'est une désactivation qui ne dirait pas son nom.
      const active = state.config?.enabled === true;
      const teamRoleIdsAfter = body?.teamRoleIds !== undefined ? cleanIds(body.teamRoleIds) : (state.config?.teamRoleIds ?? []);
      if (active && state.config && !emptiesComposition(state.config) && emptiesComposition({ teamUserIds: teamUserIdsAfter, teamRoleIds: teamRoleIdsAfter })) {
        return send(c, { error: 'Pour vider la cellule, désactivez-la : la désactivation prend effet après 24 heures.' }, 400);
      }
      const disabling = active && body?.enabled === false;

      const config = await prisma.wellbeingConfig.upsert({
        where: { guildId },
        create: {
          guildId,
          enabled: body?.enabled === true,
          teamRoleIds: cleanIds(body?.teamRoleIds),
          teamUserIds: cleanIds(body?.teamUserIds),
          directorRoleIds: cleanIds(body?.directorRoleIds),
          directorUserIds: cleanIds(body?.directorUserIds),
          requireReason: body?.requireReason !== false,
          alertChannelId,
          alertUserIds,
          ...(body?.alertEvents !== undefined ? { alertEvents } : {}),
          breakGlassApproval: body?.breakGlassApproval === true,
          reportEnabled: body?.reportEnabled === true,
          ...(staleCriticalDays !== undefined ? { staleCriticalDays } : {}),
          backupUserId,
          ...toggles,
        },
        update: {
          ...(typeof body?.enabled === 'boolean' && !disabling ? { enabled: body.enabled } : {}),
          ...(typeof body?.requireReason === 'boolean' ? { requireReason: body.requireReason } : {}),
          ...(typeof body?.breakGlassApproval === 'boolean' ? { breakGlassApproval: body.breakGlassApproval } : {}),
          ...(typeof body?.reportEnabled === 'boolean' ? { reportEnabled: body.reportEnabled } : {}),
          ...(body?.teamRoleIds !== undefined ? { teamRoleIds: cleanIds(body.teamRoleIds) } : {}),
          ...(body?.teamUserIds !== undefined ? { teamUserIds: cleanIds(body.teamUserIds) } : {}),
          ...(body?.directorRoleIds !== undefined ? { directorRoleIds: cleanIds(body.directorRoleIds) } : {}),
          ...(body?.directorUserIds !== undefined ? { directorUserIds: cleanIds(body.directorUserIds) } : {}),
          ...(body?.alertChannelId !== undefined ? { alertChannelId } : {}),
          ...(body?.alertUserIds !== undefined ? { alertUserIds } : {}),
          ...(body?.alertEvents !== undefined ? { alertEvents } : {}),
          ...(staleCriticalDays !== undefined ? { staleCriticalDays } : {}),
          backupUserId,
          ...toggles,
        },
      });

      await audit(client, c, guildId, 'Configuration Cellule bien-être', describeConfigChange(state.config, config, (id) => {
        const role = state.discordGuild?.roles.cache.get(id);
        if (role) return `@${role.name}`;
        return state.discordGuild?.members.cache.get(id)?.user.username ?? id;
      }));

      // Les destinataires d'avant comme ceux d'après apprennent le changement :
      // retirer quelqu'un des alertes ne doit pas passer sous silence.
      void sendWellbeingAlert(client, guildId, {
        ...config,
        alertChannelId: config.alertChannelId ?? state.config?.alertChannelId ?? null,
        alertUserIds: [...new Set([...(state.config?.alertUserIds ?? []), ...config.alertUserIds])],
        alertEvents: [...new Set([...(state.config?.alertEvents ?? []), ...config.alertEvents])],
      }, 'CONFIG_CHANGE', { actorId: user.userId });

      const dissolutionAt = disabling
        ? await requestDissolution(client, guildId, { id: user.userId, name: actorName(c) }, 'CONFIG')
        : config.dissolutionAt;
      if (disabling && dissolutionAt) {
        await audit(client, c, guildId, 'Configuration Cellule bien-être',
          `Désactivation de la cellule demandée, effective le ${dissolutionAt.toISOString()} sauf annulation.`, 'Sécurité');
      }

      const { resources: _resources, ...saved } = config;
      return send(c, { config: { ...saved, dissolutionAt } });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error saving config:', err);
      return fail(c, err, 'Erreur lors de la sauvegarde de la configuration.', 'WellbeingAPI');
    }
  });

  // Accès exceptionnel et journalisé (« break-glass ») pour la direction.
  router.post(`${base}/break-glass`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.isDirector) {
        return send(c, { error: "Seule la direction peut déclencher un accès d'urgence." }, 403);
      }
      const body = await readBody<{ reason?: string; caseId?: string; subjectUserId?: string }>(c);
      const reason = bodyText(body?.reason, 500);
      if ((state.config?.requireReason ?? true) && reason.length < 8) {
        return send(c, { error: 'Un motif détaillé (8 caractères min.) est obligatoire pour cet accès journalisé.' }, 400);
      }
      const subjectUserId = bodyText(body?.subjectUserId, 20);
      const needsApproval = state.config?.breakGlassApproval === true;
      const expiresAt = new Date(Date.now() + (needsApproval ? BREAK_GLASS_REQUEST_HOURS : BREAK_GLASS_HOURS) * HOUR_MS);

      const log = await prisma.wellbeingBreakGlassLog.create({
        data: {
          guildId,
          actorId: user.userId,
          actorName: actorName(c),
          caseId: await caseIdOfGuild(guildId, body?.caseId),
          subjectUserId: SNOWFLAKE_RE.test(subjectUserId) ? subjectUserId : null,
          reason: reason || 'Enquête interne (sans motif requis)',
          status: needsApproval ? 'PENDING' : 'APPROVED',
          expiresAt,
        },
      });

      const scope = log.subjectUserId ? ` — limité au membre ${log.subjectUserId}` : '';
      await audit(client, c, guildId, 'Break-glass Cellule bien-être', needsApproval
        ? `Accès exceptionnel demandé, en attente de validation${scope} — Motif : ${log.reason}`
        : `Accès exceptionnel activé jusqu'à ${expiresAt.toISOString()}${scope} — Motif : ${log.reason}`, 'Sécurité');

      void sendWellbeingAlert(client, guildId, state.config, 'BREAK_GLASS', {
        actorId: user.userId,
        reason: log.reason,
        ...(needsApproval ? { stage: 'requested' as const } : { expiresAt }),
      });

      return send(c, { ok: true, pending: needsApproval, expiresAt: expiresAt.toISOString(), log }, 201);
    } catch (err) {
      logger.error('WellbeingAPI', 'Error activating break-glass:', err);
      return fail(c, err, "Erreur lors de l'activation de l'accès d'urgence.", 'WellbeingAPI');
    }
  });

  // Seconde clé : une autre personne de la direction ou de la cellule valide ou refuse.
  router.post(`${base}/break-glass/:logId/decide`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      const log = await prisma.wellbeingBreakGlassLog.findFirst({ where: { id: c.req.param('logId'), guildId } });
      if (!log) return send(c, { error: 'Demande introuvable.' }, 404);
      const now = new Date();
      const error = decideBreakGlassError(log, { userId: user.userId, canDecide: state.isDirector || state.isTeamMember }, now);
      if (error === 'forbidden') return send(c, { error: 'Réservé à la direction et à la cellule.' }, 403);
      if (error === 'self') return send(c, { error: 'Une autre personne doit valider votre demande.' }, 403);
      if (error === 'closed') return send(c, { error: 'Cette demande est déjà traitée ou a expiré.' }, 409);

      const body = await readBody<{ approve?: boolean }>(c);
      const approve = body?.approve === true;
      const expiresAt = approve ? new Date(now.getTime() + BREAK_GLASS_HOURS * HOUR_MS) : now;
      const updated = await prisma.wellbeingBreakGlassLog.update({
        where: { id: log.id },
        data: {
          status: approve ? 'APPROVED' : 'REJECTED',
          approvedById: user.userId,
          approvedByName: actorName(c),
          decidedAt: now,
          expiresAt,
        },
      });

      await audit(client, c, guildId, 'Break-glass Cellule bien-être', approve
        ? `Accès exceptionnel de ${log.actorName} validé jusqu'à ${expiresAt.toISOString()}`
        : `Accès exceptionnel de ${log.actorName} refusé`, 'Sécurité');
      void sendWellbeingAlert(client, guildId, state.config, 'BREAK_GLASS', {
        actorId: user.userId,
        stage: approve ? 'approved' : 'rejected',
        expiresAt,
      }, [log.actorId]);

      return send(c, { log: updated });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error deciding break-glass:', err);
      return fail(c, err, "Erreur lors de la décision sur l'accès d'urgence.", 'WellbeingAPI');
    }
  });

  // Arrêt avant échéance : l'auteur coupe son accès (ou annule sa demande),
  // la cellule et le propriétaire révoquent celui des autres.
  router.post(`${base}/break-glass/:logId/end`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      const log = await prisma.wellbeingBreakGlassLog.findFirst({ where: { id: c.req.param('logId'), guildId } });
      if (!log) return send(c, { error: 'Accès introuvable.' }, 404);
      const now = new Date();
      const error = endBreakGlassError(log, { userId: user.userId, isTeamMember: state.isTeamMember, isOwner: state.canConfigure }, now);
      if (error === 'forbidden') return send(c, { error: "Seuls l'auteur, la cellule et le propriétaire peuvent arrêter cet accès." }, 403);
      if (error === 'closed') return send(c, { error: 'Cet accès est déjà terminé ou a expiré.' }, 409);

      const updated = await prisma.wellbeingBreakGlassLog.update({
        where: { id: log.id },
        data: { status: 'ENDED', endedById: user.userId, endedByName: actorName(c), endedAt: now, expiresAt: now },
      });
      const own = log.actorId === user.userId;
      await audit(client, c, guildId, 'Break-glass Cellule bien-être', own
        ? `Accès exceptionnel de ${log.actorName} arrêté par son auteur`
        : `Accès exceptionnel de ${log.actorName} révoqué`, 'Sécurité');
      void sendWellbeingAlert(client, guildId, state.config, 'BREAK_GLASS', { actorId: user.userId, stage: 'ended' },
        own ? [] : [log.actorId]);
      return send(c, { log: updated });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error ending break-glass:', err);
      return fail(c, err, "Erreur lors de l'arrêt de l'accès d'urgence.", 'WellbeingAPI');
    }
  });

  router.get(`${base}/break-glass-logs`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const state = await resolveWellbeingRole(client, guildId, c.var.dashboardUser.userId);
      if (!state.isDirector && !state.isTeamMember) return send(c, { error: 'Accès refusé.' }, 403);
      const logs = await prisma.wellbeingBreakGlassLog.findMany({
        where: { guildId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      return send(c, { logs });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error fetching break-glass logs:', err);
      return fail(c, err, 'Erreur lors du chargement du journal.', 'WellbeingAPI');
    }
  });

  // Dossiers confidentiels (strictement cloisonnés)
  router.get(`${base}/cases`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canReadCases) {
        return send(c, { error: 'Espace cloisonné : accès réservé à la cellule bien-être (ou break-glass direction).' }, 403);
      }
      const stale = staleSession(c);
      if (stale) return stale;
      // Filtre optionnel : la fiche membre ne charge que les dossiers de la personne.
      const requested = c.req.query('subjectUserId');
      const subjectUserId = requested && SNOWFLAKE_RE.test(requested) ? requested : null;
      // Un accès d'urgence ciblé ne montre que le dossier ou le membre visé.
      const scope = !state.isTeamMember && state.activeBreakGlass ? breakGlassScope(state.activeBreakGlass) : {};
      if (scope.subjectUserId && subjectUserId && scope.subjectUserId !== subjectUserId) return send(c, { cases: [] });
      // La corbeille n'est montrée qu'à la cellule, qui seule peut restaurer.
      const trashed = c.req.query('trash') === '1' && state.canWriteCases;
      const cases = await prisma.wellbeingCase.findMany({
        where: { AND: [caseVisibilityWhere(guildId, user.userId, { trashed }), subjectUserId ? { subjectUserId } : {}, scope] },
        select: CASE_LIST_SELECT,
        orderBy: { updatedAt: 'desc' },
      });
      // Dossier sur un membre de la cellule : il lui est masqué, les autres le savent.
      const subjects = [...new Set(cases.map((item) => item.subjectUserId).filter((id): id is string => !!id))];
      const cellSubjects = new Set<string>();
      for (const id of subjects) if (await isTeamMemberId(state, id)) cellSubjects.add(id);
      // Sous accès d'urgence, chaque consultation laisse une trace, sans le contenu des dossiers.
      if (!state.isTeamMember) {
        await audit(client, c, guildId, 'Consultation Cellule bien-être',
          `Accès d'urgence : ${cases.length} dossier(s) consulté(s)${subjectUserId ? ` pour le membre ${subjectUserId}` : ''}.`, 'Sécurité');
      }
      void sendWellbeingAlert(client, guildId, state.config, state.isTeamMember ? 'TEAM_READ' : 'EMERGENCY_READ', {
        actorId: user.userId,
        caseCount: cases.length,
      });
      return send(c, {
        cases: cases.map((item) => ({ ...openCaseHeader(item), subjectIsTeamMember: !!item.subjectUserId && cellSubjects.has(item.subjectUserId) })),
      });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error listing cases:', err);
      return fail(c, err, 'Erreur lors du chargement des dossiers.', 'WellbeingAPI');
    }
  });

  /**
   * Beaucoup de dossiers ouverts en peu de temps par une même personne :
   * compte inhabituel ou curiosité, la cellule est prévenue (une fois par heure).
   */
  async function checkUnusualAccess(c: Context, guildId: string, state: WellbeingState, now: Date) {
    const userId = c.var.dashboardUser.userId;
    const opened = await prisma.wellbeingCaseEvent.count({
      where: { type: 'VIEWED', actorId: userId, createdAt: { gte: new Date(now.getTime() - UNUSUAL_ACCESS_WINDOW_MS) }, wellbeingCase: { guildId } },
    });
    if (!isUnusualAccess(opened)) return;
    const key = `${guildId}:${userId}`;
    const last = unusualAlertAt.get(key);
    if (last !== undefined && now.getTime() - last < UNUSUAL_ACCESS_COOLDOWN_MS) return;
    unusualAlertAt.set(key, now.getTime());
    await audit(client, c, guildId, 'Consultation Cellule bien-être',
      `Consultation inhabituelle : ${opened} dossiers ouverts en ${UNUSUAL_ACCESS_WINDOW_MS / 60_000} minutes.`, 'Sécurité');
    void sendWellbeingAlert(client, guildId, state.config, 'UNUSUAL_ACCESS', { actorId: userId, caseCount: opened });
  }

  /** Référent absent en ce moment : jusqu'à quand, et qui reçoit ses relances. */
  async function assigneeAbsence(guildId: string, assigneeId: string | null, state: WellbeingState) {
    if (!assigneeId) return null;
    const current = await currentAbsence(guildId, assigneeId);
    if (!current) return null;
    const recipient = reminderRecipient(assigneeId, new Set([assigneeId]), state.config?.backupUserId ?? null);
    return {
      until: current.isIndefinite || !current.endDate ? null : current.endDate.toISOString(),
      backupUserId: recipient === assigneeId ? null : recipient,
    };
  }

  // Contenu d'un dossier : chaque ouverture est tracée dans son historique.
  router.get(`${base}/cases/:caseId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canReadCases) {
        return send(c, { error: 'Espace cloisonné : accès réservé à la cellule bien-être (ou break-glass direction).' }, 403);
      }
      const stale = staleSession(c);
      if (stale) return stale;
      const caseId = c.req.param('caseId');
      const scope = !state.isTeamMember && state.activeBreakGlass ? breakGlassScope(state.activeBreakGlass) : {};
      const found = await prisma.wellbeingCase.findFirst({
        where: { AND: [{ id: caseId }, caseVisibilityWhere(guildId, user.userId, { trashed: c.req.query('trash') === '1' && state.canWriteCases }), scope] },
        select: { id: true },
      });
      if (!found) return send(c, { error: 'Dossier introuvable.' }, 404);

      const now = new Date();
      const lastView = await prisma.wellbeingCaseEvent.findFirst({
        where: { caseId, type: 'VIEWED', actorId: user.userId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (shouldRecordView(lastView?.createdAt ?? null, now)) {
        await recordEvents(caseId, c, [{ type: 'VIEWED', toValue: state.isTeamMember ? null : 'EMERGENCY' }]);
        if (!state.isTeamMember) {
          await audit(client, c, guildId, 'Consultation Cellule bien-être', `Accès d'urgence : dossier ${caseId} ouvert.`, 'Sécurité');
        }
        await checkUnusualAccess(c, guildId, state, now);
      }
      const item = await prisma.wellbeingCase.findUniqueOrThrow({ where: { id: caseId }, include: CASE_INCLUDE });
      return send(c, { item: openCase(item), integrity: verifyCaseEventChain(item.events), assigneeAbsence: await assigneeAbsence(guildId, item.assigneeId, state) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error reading case:', err);
      return fail(c, err, 'Erreur lors du chargement du dossier.', 'WellbeingAPI');
    }
  });

  interface NewCaseInput {
    subjectUserId: string | null;
    subjectName: string;
    title: string;
    summary: string;
    category: string;
    severity: string;
    assigneeId: string | null;
    reviewAt: Date | null;
    source?: string;
    ticketId?: string;
  }

  /**
   * Création d'un dossier, quelle que soit son origine (page, signal de
   * détresse, ticket) : contrôles communs, historique, protocole de crise et
   * alerte. Rend une erreur à renvoyer telle quelle, ou l'id du dossier.
   */
  async function createCase(c: Context, guildId: string, state: WellbeingState, input: NewCaseInput): Promise<{ error: string } | { id: string }> {
    const user = c.var.dashboardUser;
    if (!input.subjectName || !input.title || !input.summary) {
      return { error: 'Personne concernée, titre et résumé sont obligatoires.' };
    }
    // Un dossier sur soi-même serait aussitôt masqué à son auteur (conflit
    // d'intérêts) : il le créerait sans pouvoir le suivre ni le fermer.
    if (isCaseSubject(input.subjectUserId, user.userId)) {
      return { error: "Vous ne pouvez pas ouvrir un dossier qui vous concerne : demandez à un autre membre de la cellule." };
    }
    if (input.assigneeId && !(await isTeamMemberId(state, input.assigneeId))) {
      return { error: 'Le référent doit faire partie de la cellule.' };
    }
    if (assigneeConflict(input.subjectUserId, input.assigneeId)) {
      return { error: 'La personne concernée ne peut pas suivre son propre dossier.' };
    }
    const created = await prisma.wellbeingCase.create({
      data: {
        guildId,
        subjectUserId: input.subjectUserId,
        ...sealCaseFields(guildId, { title: input.title, subjectName: input.subjectName, summary: input.summary }),
        category: CATEGORIES.includes(input.category) ? input.category : 'SOUTIEN',
        severity: SEVERITIES.includes(input.severity) ? input.severity : 'NORMAL',
        createdById: user.userId,
        createdByName: actorName(c),
        assigneeId: input.assigneeId,
        reviewAt: input.reviewAt,
        ...(input.source ? { source: input.source } : {}),
        ...(input.ticketId ? { ticketId: input.ticketId } : {}),
      },
    });
    await recordEvents(created.id, c, [
      { type: 'CREATED', toValue: input.source ?? null },
      ...(input.assigneeId ? [{ type: 'ASSIGNEE', toValue: input.assigneeId }] : []),
      ...(input.reviewAt ? [{ type: 'REVIEW', toValue: input.reviewAt.toISOString() }] : []),
    ]);
    await applyCrisisProtocolIfDue(created, null, created.severity, state.config?.crisisProtocol ?? true, { id: user.userId, name: actorName(c) });
    void sendWellbeingAlert(client, guildId, state.config, 'CASE_CHANGE', { actorId: user.userId, action: 'créé' },
      input.assigneeId ? [input.assigneeId] : []);
    return { id: created.id };
  }

  router.post(`${base}/cases`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      const body = await readBody<{
        subjectUserId?: string;
        subjectName?: string;
        title?: string;
        category?: string;
        severity?: string;
        summary?: string;
        assigneeId?: string | null;
        reviewAt?: string | null;
        signalId?: string;
      }>(c);
      // Dossier ouvert depuis un signal de détresse : le signal est marqué traité.
      const signalId = bodyText(body?.signalId, 64);
      const signal = signalId
        ? await prisma.wellbeingDistressSignal.findFirst({ where: { id: signalId, guildId, handledAt: null } })
        : null;
      if (signalId && !signal) return send(c, { error: 'Signal introuvable ou déjà traité.' }, 404);
      const subjectUserId = bodyText(body?.subjectUserId, 20);
      const result = await createCase(c, guildId, state, {
        subjectUserId: SNOWFLAKE_RE.test(subjectUserId) ? subjectUserId : null,
        subjectName: bodyText(body?.subjectName, 80),
        title: bodyText(body?.title, 160),
        summary: bodyText(body?.summary, 4000),
        category: body?.category ?? '',
        severity: body?.severity ?? '',
        assigneeId: bodyText(body?.assigneeId, 20) || null,
        reviewAt: parseReviewAt(body?.reviewAt) ?? null,
        ...(signal ? { source: 'DISTRESS' } : {}),
      });
      if ('error' in result) return send(c, { error: result.error }, 400);
      if (signal) {
        await prisma.wellbeingDistressSignal.update({
          where: { id: signal.id },
          data: { handledAt: new Date(), handledById: user.userId, handledByName: actorName(c), outcome: 'CASE', caseId: result.id },
        });
      }
      return send(c, { item: await fullCase(result.id) }, 201);
    } catch (err) {
      logger.error('WellbeingAPI', 'Error creating case:', err);
      return fail(c, err, 'Erreur lors de la création du dossier.', 'WellbeingAPI');
    }
  });

  // Ticket transféré à la cellule : il devient un dossier, et peut être fermé.
  router.post(`${base}/cases/from-ticket`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      const body = await readBody<{ ticketId?: string; closeTicket?: boolean }>(c);
      const ticket = await prisma.ticket.findFirst({ where: { id: bodyText(body?.ticketId, 64), guildId } });
      if (!ticket) return send(c, { error: 'Ticket introuvable.' }, 404);
      const already = await prisma.wellbeingCase.findUnique({ where: { ticketId: ticket.id }, select: { id: true } });
      if (already) return send(c, { error: 'Ce ticket a déjà été transféré à la cellule.' }, 409);
      const result = await createCase(c, guildId, state, {
        subjectUserId: ticket.userId,
        subjectName: ticket.username,
        title: `Ticket : ${ticket.reason}`.slice(0, 160),
        summary: ticketCaseSummary(ticket),
        category: 'SOUTIEN',
        severity: 'NORMAL',
        assigneeId: null,
        reviewAt: null,
        source: 'TICKET',
        ticketId: ticket.id,
      });
      if ('error' in result) return send(c, { error: result.error }, 400);
      await audit(client, c, guildId, 'Transfert Cellule bien-être', `Ticket ${ticket.id} transféré à la cellule (dossier ${result.id}).`);
      if (body?.closeTicket === true && ticket.status !== 'CLOSED') {
        await closeTicket(client, ticket.id, user.userId, actorName(c));
      }
      return send(c, { caseId: result.id }, 201);
    } catch (err) {
      logger.error('WellbeingAPI', 'Error transferring ticket:', err);
      return fail(c, err, 'Erreur lors du transfert du ticket.', 'WellbeingAPI');
    }
  });

  router.patch(`${base}/cases/:caseId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      const caseId = c.req.param('caseId');
      const existing = await findVisibleCase(guildId, caseId, user.userId);
      if (!existing) return send(c, { error: 'Dossier introuvable.' }, 404);
      const body = await readBody<{ status?: string; severity?: string; assigneeId?: string | null; reviewAt?: string | null; closedReason?: string }>(c);

      const patch: Partial<CaseTracked> = {
        ...(body?.status && STATUSES.includes(body.status) ? { status: body.status } : {}),
        ...(body?.severity && SEVERITIES.includes(body.severity) ? { severity: body.severity } : {}),
      };
      if (body?.assigneeId !== undefined) {
        const assigneeId = bodyText(body.assigneeId, 20);
        if (assigneeId && !(await isTeamMemberId(state, assigneeId))) {
          return send(c, { error: 'Le référent doit faire partie de la cellule.' }, 400);
        }
        if (assigneeConflict(existing.subjectUserId, assigneeId || null)) {
          return send(c, { error: 'La personne concernée ne peut pas suivre son propre dossier.' }, 400);
        }
        patch.assigneeId = assigneeId || null;
      }
      const reviewAt = parseReviewAt(body?.reviewAt);
      if (reviewAt !== undefined) patch.reviewAt = reviewAt;

      const events: Array<CaseEventDraft | { type: string; toValue: string | null }> = caseChangeEvents(existing, patch);
      // Fermer enregistre son motif ; rouvrir l'efface.
      const closing = patch.status === 'CLOSED' && existing.status !== 'CLOSED';
      const closedReason = closing ? cleanCloseReason(body?.closedReason) : undefined;
      if (closedReason) events.push({ type: 'CLOSED_REASON', toValue: closedReason });
      if (events.length === 0) {
        const unchanged = await prisma.wellbeingCase.findUniqueOrThrow({ where: { id: caseId }, include: CASE_INCLUDE });
        return send(c, { item: openCase(unchanged) });
      }
      const now = new Date();
      const updated = await prisma.wellbeingCase.update({
        where: { id: caseId },
        data: {
          ...patch,
          // Une nouvelle échéance réarme sa relance.
          ...(events.some((e) => e.type === 'REVIEW') ? { reviewRemindedAt: null } : {}),
          // Un dossier résolu programme sa prise de nouvelles ; rouvrir l'annule.
          ...(closing
            ? { closedReason: closedReason ?? null, followUpAt: followUpDate(now, state.config?.followUpDays ?? 30, closedReason ?? null), followUpSentAt: null }
            : {}),
          ...(patch.status && patch.status !== 'CLOSED' ? { closedReason: null, followUpAt: null, followUpSentAt: null } : {}),
          lastActivityAt: now,
        },
      });
      await recordEvents(caseId, c, events);
      if (patch.severity) {
        await applyCrisisProtocolIfDue(updated, existing.severity, patch.severity, state.config?.crisisProtocol ?? true, { id: user.userId, name: actorName(c) });
      }
      const newAssignee = events.find((e) => e.type === 'ASSIGNEE')?.toValue;
      void sendWellbeingAlert(client, guildId, state.config, 'CASE_CHANGE', { actorId: user.userId, action: 'modifié' },
        newAssignee ? [newAssignee] : []);

      const item = await prisma.wellbeingCase.findUniqueOrThrow({ where: { id: updated.id }, include: CASE_INCLUDE });
      return send(c, { item: openCase(item) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error updating case:', err);
      return fail(c, err, 'Erreur lors de la mise à jour du dossier.', 'WellbeingAPI');
    }
  });

  // Créer, modifier, noter ou supprimer : réservé à la cellule, l'accès d'urgence ne sert qu'à lire.
  router.delete(`${base}/cases/:caseId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      const caseId = c.req.param('caseId');
      // Corbeille plutôt qu'effacement : un dossier ne disparaît pas d'un clic, la purge vient 30 jours après.
      const existing = await findVisibleCase(guildId, caseId, user.userId);
      if (!existing) return send(c, { error: 'Dossier introuvable.' }, 404);
      await prisma.wellbeingCase.update({
        where: { id: caseId },
        data: { deletedAt: new Date(), deletedById: user.userId, deletedByName: actorName(c) },
      });
      await recordEvents(caseId, c, [{ type: 'TRASHED' }]);
      await audit(client, c, guildId, 'Suppression Cellule bien-être', `Dossier ${caseId} mis à la corbeille (purge dans ${CASE_TRASH_DAYS} jours).`);
      void sendWellbeingAlert(client, guildId, state.config, 'CASE_CHANGE', { actorId: user.userId, action: 'mis à la corbeille' });
      return send(c, { ok: true });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error deleting case:', err);
      return fail(c, err, 'Erreur lors de la suppression du dossier.', 'WellbeingAPI');
    }
  });

  router.post(`${base}/cases/:caseId/restore`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      const caseId = c.req.param('caseId');
      const existing = await findVisibleCase(guildId, caseId, user.userId, { trashed: true });
      if (!existing) return send(c, { error: 'Dossier introuvable dans la corbeille.' }, 404);
      await prisma.wellbeingCase.update({
        where: { id: caseId },
        data: { deletedAt: null, deletedById: null, deletedByName: null, lastActivityAt: new Date() },
      });
      await recordEvents(caseId, c, [{ type: 'RESTORED' }]);
      await audit(client, c, guildId, 'Restauration Cellule bien-être', `Dossier ${caseId} restauré depuis la corbeille.`);
      void sendWellbeingAlert(client, guildId, state.config, 'CASE_CHANGE', { actorId: user.userId, action: 'restauré' });
      const item = await prisma.wellbeingCase.findUniqueOrThrow({ where: { id: caseId }, include: CASE_INCLUDE });
      return send(c, { item: openCase(item) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error restoring case:', err);
      return fail(c, err, 'Erreur lors de la restauration du dossier.', 'WellbeingAPI');
    }
  });

  router.post(`${base}/cases/:caseId/notes`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      const caseId = c.req.param('caseId');
      const existing = await findVisibleCase(guildId, caseId, user.userId);
      if (!existing) return send(c, { error: 'Dossier introuvable.' }, 404);
      const body = await readBody<{ content?: string; notifyUserIds?: unknown }>(c);
      const content = bodyText(body?.content, 4000);
      if (!content) return send(c, { error: 'Contenu requis.' }, 400);
      const note = await prisma.wellbeingCaseNote.create({
        data: { caseId, authorId: user.userId, authorName: actorName(c), content: sealNote(caseId, content) },
      });
      await prisma.wellbeingCase.update({ where: { id: caseId }, data: { lastActivityAt: new Date() } });
      await recordEvents(caseId, c, [{ type: 'NOTE' }]);
      void sendWellbeingAlert(client, guildId, state.config, 'CASE_CHANGE', { actorId: user.userId, action: 'annoté' });
      // Collègues prévenus : de la cellule seulement, ni l'auteur ni la personne concernée.
      const mentioned: string[] = [];
      for (const id of cleanMentionIds(body?.notifyUserIds)) {
        if (id !== user.userId && id !== existing.subjectUserId && await isTeamMemberId(state, id)) mentioned.push(id);
      }
      if (mentioned.length > 0) void sendWellbeingDirect(client, mentioned, mentionText(user.userId));
      return send(c, { note: openNote(note) }, 201);
    } catch (err) {
      logger.error('WellbeingAPI', 'Error adding case note:', err);
      return fail(c, err, "Erreur lors de l'ajout de la note.", 'WellbeingAPI');
    }
  });

  // Correction d'une note par son auteur : la première version reste lisible.
  router.patch(`${base}/cases/:caseId/notes/:noteId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      const caseId = c.req.param('caseId');
      const note = await prisma.wellbeingCaseNote.findFirst({
        where: { id: c.req.param('noteId'), caseId, wellbeingCase: caseVisibilityWhere(guildId, user.userId) },
      });
      if (!note) return send(c, { error: 'Note introuvable.' }, 404);
      if (!canEditNote(note, user.userId, new Date())) {
        return send(c, { error: 'Seul son auteur corrige une note, dans les 48 heures.' }, 403);
      }
      const body = await readBody<{ content?: string }>(c);
      const content = bodyText(body?.content, 4000);
      if (!content) return send(c, { error: 'Contenu requis.' }, 400);
      await prisma.wellbeingCaseNote.update({
        where: { id: note.id },
        data: {
          content: sealNote(caseId, content),
          // La première version est gardée une fois pour toutes, même après plusieurs corrections.
          ...(note.originalContent ? {} : { originalContent: note.content }),
          editedAt: new Date(),
        },
      });
      await recordEvents(caseId, c, [{ type: 'NOTE_EDITED' }]);
      void sendWellbeingAlert(client, guildId, state.config, 'CASE_CHANGE', { actorId: user.userId, action: 'annoté (note corrigée)' });
      return send(c, { item: await fullCase(caseId) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error editing note:', err);
      return fail(c, err, 'Erreur lors de la correction de la note.', 'WellbeingAPI');
    }
  });

  // Documents Google Drive : seul le lien est gardé, chiffré. L'accès au
  // fichier reste réglé par son partage dans Drive.
  router.post(`${base}/cases/:caseId/attachments`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      const caseId = c.req.param('caseId');
      const existing = await prisma.wellbeingCase.findFirst({
        where: { AND: [{ id: caseId }, caseVisibilityWhere(guildId, user.userId)] },
        select: { id: true, _count: { select: { attachments: true } } },
      });
      if (!existing) return send(c, { error: 'Dossier introuvable.' }, 404);
      if (existing._count.attachments >= MAX_CASE_ATTACHMENTS) {
        return send(c, { error: `Un dossier compte au plus ${MAX_CASE_ATTACHMENTS} documents.` }, 400);
      }
      const body = await readBody<{ label?: string; url?: string }>(c);
      const url = cleanDriveLink(body?.url);
      if (!url) return send(c, { error: 'Seuls les liens https vers Google Drive ou Google Docs sont acceptés.' }, 400);
      const label = bodyText(body?.label, ATTACHMENT_LABEL_MAX) || 'Document Drive';

      await prisma.wellbeingCaseAttachment.create({
        data: {
          caseId,
          label: sealNote(caseId, label),
          url: sealNote(caseId, url),
          addedById: user.userId,
          addedByName: actorName(c),
        },
      });
      await prisma.wellbeingCase.update({ where: { id: caseId }, data: { lastActivityAt: new Date() } });
      await recordEvents(caseId, c, [{ type: 'ATTACHMENT_ADDED' }]);
      void sendWellbeingAlert(client, guildId, state.config, 'CASE_CHANGE', { actorId: user.userId, action: 'complété d\'un document' });

      const item = await prisma.wellbeingCase.findUniqueOrThrow({ where: { id: caseId }, include: CASE_INCLUDE });
      return send(c, { item: openCase(item) }, 201);
    } catch (err) {
      logger.error('WellbeingAPI', 'Error adding attachment:', err);
      return fail(c, err, "Erreur lors de l'ajout du document.", 'WellbeingAPI');
    }
  });

  router.delete(`${base}/cases/:caseId/attachments/:attachmentId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      const caseId = c.req.param('caseId');
      // Le dossier doit être de ce serveur : un id de document seul ne suffit pas.
      const { count } = await prisma.wellbeingCaseAttachment.deleteMany({
        where: { id: c.req.param('attachmentId'), caseId, wellbeingCase: caseVisibilityWhere(guildId, user.userId) },
      });
      if (count === 0) return send(c, { error: 'Document introuvable.' }, 404);
      await prisma.wellbeingCase.update({ where: { id: caseId }, data: { lastActivityAt: new Date() } });
      await recordEvents(caseId, c, [{ type: 'ATTACHMENT_REMOVED' }]);
      void sendWellbeingAlert(client, guildId, state.config, 'CASE_CHANGE', { actorId: user.userId, action: 'modifié' });

      const item = await prisma.wellbeingCase.findUniqueOrThrow({ where: { id: caseId }, include: CASE_INCLUDE });
      return send(c, { item: openCase(item) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error removing attachment:', err);
      return fail(c, err, 'Erreur lors du retrait du document.', 'WellbeingAPI');
    }
  });

  // Prolonger un dossier fermé : son effacement repart pour un an.
  router.post(`${base}/cases/:caseId/extend`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      const caseId = c.req.param('caseId');
      const existing = await findVisibleCase(guildId, caseId, user.userId);
      if (!existing) return send(c, { error: 'Dossier introuvable.' }, 404);
      if (existing.status !== 'CLOSED') return send(c, { error: 'Seul un dossier fermé a une date d\'effacement.' }, 400);
      await prisma.wellbeingCase.update({ where: { id: caseId }, data: { purgeWarnedAt: null } });
      await recordEvents(caseId, c, [{ type: 'EXTENDED' }]);
      await audit(client, c, guildId, 'Conservation Cellule bien-être', `Dossier ${caseId} prolongé d'un an.`);
      return send(c, { item: await fullCase(caseId) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error extending case:', err);
      return fail(c, err, 'Erreur lors de la prolongation du dossier.', 'WellbeingAPI');
    }
  });

  // Export imprimable : tracé, et filigrané côté page au nom de qui l'exporte.
  router.post(`${base}/cases/:caseId/export`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      const stale = staleSession(c);
      if (stale) return stale;
      const caseId = c.req.param('caseId');
      const existing = await findVisibleCase(guildId, caseId, user.userId);
      if (!existing) return send(c, { error: 'Dossier introuvable.' }, 404);
      const exportedAt = new Date();
      await recordEvents(caseId, c, [{ type: 'EXPORTED' }]);
      await audit(client, c, guildId, 'Export Cellule bien-être', `Dossier ${caseId} exporté.`, 'Sécurité');
      void sendWellbeingAlert(client, guildId, state.config, 'CASE_CHANGE', { actorId: user.userId, action: 'exporté' });
      return send(c, { item: await fullCase(caseId), exportedBy: actorName(c), exportedById: user.userId, exportedAt: exportedAt.toISOString() });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error exporting case:', err);
      return fail(c, err, "Erreur lors de l'export du dossier.", 'WellbeingAPI');
    }
  });

  // Plan d'action : tâches du dossier.
  router.post(`${base}/cases/:caseId/tasks`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      const caseId = c.req.param('caseId');
      const existing = await findVisibleCase(guildId, caseId, user.userId);
      if (!existing) return send(c, { error: 'Dossier introuvable.' }, 404);
      const count = await prisma.wellbeingCaseTask.count({ where: { caseId } });
      if (count >= MAX_CASE_TASKS) return send(c, { error: `Un plan d'action compte au plus ${MAX_CASE_TASKS} tâches.` }, 400);
      const body = await readBody<{ label?: string; assigneeId?: string | null; dueAt?: string | null }>(c);
      const label = bodyText(body?.label, TASK_LABEL_MAX);
      if (!label) return send(c, { error: 'Libellé requis.' }, 400);
      const assigneeId = bodyText(body?.assigneeId, 20);
      if (assigneeId && !(await isTeamMemberId(state, assigneeId))) {
        return send(c, { error: 'Le responsable doit faire partie de la cellule.' }, 400);
      }
      if (assigneeConflict(existing.subjectUserId, assigneeId || null)) {
        return send(c, { error: 'La personne concernée ne peut pas suivre son propre dossier.' }, 400);
      }
      await prisma.wellbeingCaseTask.create({
        data: {
          caseId,
          label: sealNote(caseId, label),
          assigneeId: assigneeId || null,
          dueAt: parseReviewAt(body?.dueAt) ?? null,
          createdById: user.userId,
          createdByName: actorName(c),
        },
      });
      await prisma.wellbeingCase.update({ where: { id: caseId }, data: { lastActivityAt: new Date() } });
      await recordEvents(caseId, c, [{ type: 'TASK_ADDED' }]);
      return send(c, { item: await fullCase(caseId) }, 201);
    } catch (err) {
      logger.error('WellbeingAPI', 'Error adding task:', err);
      return fail(c, err, "Erreur lors de l'ajout de la tâche.", 'WellbeingAPI');
    }
  });

  router.patch(`${base}/cases/:caseId/tasks/:taskId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      const caseId = c.req.param('caseId');
      const task = await prisma.wellbeingCaseTask.findFirst({
        where: { id: c.req.param('taskId'), caseId, wellbeingCase: caseVisibilityWhere(guildId, user.userId) },
      });
      if (!task) return send(c, { error: 'Tâche introuvable.' }, 404);
      const body = await readBody<{ done?: boolean }>(c);
      if (typeof body?.done !== 'boolean') return send(c, { error: 'État attendu.' }, 400);
      if (body.done !== !!task.doneAt) {
        await prisma.wellbeingCaseTask.update({
          where: { id: task.id },
          data: body.done ? { doneAt: new Date(), doneById: user.userId } : { doneAt: null, doneById: null },
        });
        await prisma.wellbeingCase.update({ where: { id: caseId }, data: { lastActivityAt: new Date() } });
        await recordEvents(caseId, c, [{ type: body.done ? 'TASK_DONE' : 'TASK_REOPENED' }]);
      }
      return send(c, { item: await fullCase(caseId) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error updating task:', err);
      return fail(c, err, 'Erreur lors de la mise à jour de la tâche.', 'WellbeingAPI');
    }
  });

  router.delete(`${base}/cases/:caseId/tasks/:taskId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      const caseId = c.req.param('caseId');
      const { count } = await prisma.wellbeingCaseTask.deleteMany({
        where: { id: c.req.param('taskId'), caseId, wellbeingCase: caseVisibilityWhere(guildId, user.userId) },
      });
      if (count === 0) return send(c, { error: 'Tâche introuvable.' }, 404);
      await recordEvents(caseId, c, [{ type: 'TASK_REMOVED' }]);
      return send(c, { item: await fullCase(caseId) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error removing task:', err);
      return fail(c, err, 'Erreur lors du retrait de la tâche.', 'WellbeingAPI');
    }
  });

  // Effacement anticipé de la corbeille : une personne demande, une autre valide.
  router.post(`${base}/cases/:caseId/purge-request`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      const caseId = c.req.param('caseId');
      const existing = await findVisibleCase(guildId, caseId, user.userId, { trashed: true });
      if (!existing) return send(c, { error: 'Dossier introuvable dans la corbeille.' }, 404);
      const now = new Date();
      // Une demande en cours n'est pas remplacée : elle se valide ou expire.
      if (purgeRequestPending(existing, now)) {
        return send(c, { error: "Une demande d'effacement est déjà en attente de validation pour ce dossier." }, 409);
      }
      await prisma.wellbeingCase.update({
        where: { id: caseId },
        data: { purgeRequestedById: user.userId, purgeRequestedByName: actorName(c), purgeRequestedAt: now },
      });
      await recordEvents(caseId, c, [{ type: 'PURGE_REQUESTED' }]);
      await audit(client, c, guildId, 'Suppression Cellule bien-être', `Effacement définitif du dossier ${caseId} demandé, à valider par une autre personne.`, 'Sécurité');
      void sendWellbeingAlert(client, guildId, state.config, 'CASE_CHANGE', { actorId: user.userId, action: 'proposé à l\'effacement définitif' });
      return send(c, { ok: true });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error requesting purge:', err);
      return fail(c, err, "Erreur lors de la demande d'effacement.", 'WellbeingAPI');
    }
  });

  router.post(`${base}/cases/:caseId/purge`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      const caseId = c.req.param('caseId');
      const existing = await findVisibleCase(guildId, caseId, user.userId, { trashed: true });
      if (!existing) return send(c, { error: 'Dossier introuvable dans la corbeille.' }, 404);
      const error = purgeApprovalError(existing, user.userId, new Date());
      if (error === 'self') return send(c, { error: 'Une autre personne de la cellule doit valider votre demande.' }, 403);
      if (error === 'expired') return send(c, { error: 'La demande a expiré : il faut la refaire.' }, 409);
      if (error) return send(c, { error: "Aucune demande d'effacement en cours pour ce dossier." }, 409);
      await prisma.wellbeingCase.delete({ where: { id: caseId } });
      await audit(client, c, guildId, 'Suppression Cellule bien-être',
        `Dossier ${caseId} effacé définitivement (demande de ${existing.purgeRequestedByName ?? existing.purgeRequestedById}).`, 'Sécurité');
      void sendWellbeingAlert(client, guildId, state.config, 'CASE_CHANGE', { actorId: user.userId, action: 'effacé définitivement' });
      return send(c, { ok: true });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error purging case:', err);
      return fail(c, err, "Erreur lors de l'effacement du dossier.", 'WellbeingAPI');
    }
  });

  // Revue des accès : le propriétaire confirme la composition de la cellule.
  router.post(`${base}/access-review`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canConfigure) return send(c, { error: 'Seul le propriétaire du serveur confirme la composition.' }, 403);
      if (!state.config) return send(c, { error: 'Cellule non configurée.' }, 404);
      const now = new Date();
      await prisma.wellbeingConfig.update({ where: { guildId }, data: { accessReviewedAt: now, accessReviewSentAt: null } });
      await audit(client, c, guildId, 'Revue des accès Cellule bien-être', 'Composition de la cellule et de la direction confirmée.');
      return send(c, { accessReviewedAt: now.toISOString() });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error confirming access review:', err);
      return fail(c, err, 'Erreur lors de la confirmation.', 'WellbeingAPI');
    }
  });

  // Mes échéances : suivis et tâches des 7 prochains jours, sans titre ni contenu.
  router.get(`${base}/agenda`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { items: [] });
      const cases = await prisma.wellbeingCase.findMany({
        where: { AND: [caseVisibilityWhere(guildId, user.userId), { status: { not: 'CLOSED' } }] },
        select: {
          id: true, status: true, assigneeId: true, reviewAt: true,
          tasks: { where: { doneAt: null, dueAt: { not: null } }, select: { caseId: true, assigneeId: true, dueAt: true, doneAt: true } },
        },
      });
      const items = agendaItems(cases, cases.flatMap((item) => item.tasks), user.userId, new Date());
      return send(c, { items: items.map((item) => ({ ...item, dueAt: item.dueAt.toISOString() })) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error loading agenda:', err);
      return fail(c, err, 'Erreur lors du chargement des échéances.', 'WellbeingAPI');
    }
  });

  // Bilan sans contenu : chiffres de la cellule, lisibles par la direction aussi.
  router.get(`${base}/stats`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.isTeamMember && !state.isDirector) return send(c, { error: 'Accès refusé.' }, 403);
      const [cases, pulseWeeks] = await Promise.all([
        prisma.wellbeingCase.findMany({
          where: caseVisibilityWhere(guildId, user.userId),
          select: {
            status: true, severity: true, category: true, source: true, assigneeId: true, createdAt: true, closedReason: true,
            events: { where: { type: { in: ['STATUS', 'ASSIGNEE'] } }, select: { type: true, toValue: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
          },
        }),
        prisma.wellbeingPulseWeek.findMany({ where: { guildId }, orderBy: { week: 'desc' }, take: PULSE_WEEKS_SHOWN }),
      ]);
      return send(c, {
        stats: wellbeingCellStats(cases, new Date()),
        load: referentLoad(cases, teamIdsOf(state)),
        pulse: state.config?.pulseEnabled || pulseWeeks.length > 0 ? pulseSummary(pulseWeeks) : null,
      });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error computing stats:', err);
      return fail(c, err, 'Erreur lors du calcul du bilan.', 'WellbeingAPI');
    }
  });

  // Aperçu des alertes pour l'onglet Réglages : le texte exact de chaque événement.
  router.get(`${base}/alert-preview`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canConfigure) return send(c, { error: 'Réservé au propriétaire du serveur.' }, 403);
      return send(c, { previews: alertPreviews(actorName(c), new Date()) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error building alert previews:', err);
      return fail(c, err, "Erreur lors de l'aperçu des alertes.", 'WellbeingAPI');
    }
  });

  // Annuler une désactivation demandée : le propriétaire seul.
  router.post(`${base}/dissolution/cancel`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canConfigure) return send(c, { error: 'Seul le propriétaire du serveur peut annuler la désactivation.' }, 403);
      if (!(await cancelDissolution(client, guildId, { id: user.userId }))) {
        return send(c, { error: 'Aucune désactivation en attente.' }, 409);
      }
      await audit(client, c, guildId, 'Configuration Cellule bien-être', 'Désactivation de la cellule annulée.', 'Sécurité');
      return send(c, { ok: true });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error cancelling dissolution:', err);
      return fail(c, err, "Erreur lors de l'annulation.", 'WellbeingAPI');
    }
  });

  // Message à l'auteur d'un signalement : il le lit avec son code de suivi
  // et peut y répondre, sans que la cellule sache qui il est.
  router.post(`${base}/cases/:caseId/reporter-reply`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      const caseId = c.req.param('caseId');
      const existing = await findVisibleCase(guildId, caseId, user.userId);
      if (!existing) return send(c, { error: 'Dossier introuvable.' }, 404);
      if (!existing.trackingCodeHash) return send(c, { error: "Ce dossier n'a pas de code de suivi : il ne vient pas d'un signalement Discord." }, 400);
      const body = await readBody<{ message?: string }>(c);
      const message = bodyText(body?.message, REPORTER_REPLY_MAX);
      if (!message) return send(c, { error: 'Message requis.' }, 400);
      await prisma.wellbeingReporterMessage.create({
        data: { caseId, fromReporter: false, content: sealWellbeing(guildId, message), authorId: user.userId },
      });
      await prisma.wellbeingCase.update({ where: { id: caseId }, data: { lastActivityAt: new Date() } });
      await recordEvents(caseId, c, [{ type: 'REPORTER_REPLY', toValue: 'SET' }]);
      return send(c, { item: await fullCase(caseId) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error replying to reporter:', err);
      return fail(c, err, 'Erreur lors de la réponse au signaleur.', 'WellbeingAPI');
    }
  });

  // Journal de la cellule en CSV, pour un audit : accès, décisions et réglages,
  // jamais le contenu d'un dossier. Douze derniers mois.
  router.get(`${base}/journal`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.isTeamMember && !state.isDirector) return send(c, { error: 'Accès refusé.' }, 403);
      const since = new Date(Date.now() - 365 * 24 * HOUR_MS);
      const [entries, logs] = await Promise.all([
        prisma.dashboardAuditLog.findMany({
          where: { guildId, module: WELLBEING_AUDIT_MODULE, dateIso: { gte: since } },
          orderBy: { dateIso: 'desc' },
          take: 5000,
          select: { dateIso: true, user: true, action: true, details: true },
        }),
        prisma.wellbeingBreakGlassLog.findMany({
          where: { guildId, createdAt: { gte: since } },
          orderBy: { createdAt: 'desc' },
          take: 1000,
        }),
      ]);
      const rows = [
        ...entries.map((entry) => ({ date: entry.dateIso, source: 'audit', actor: entry.user, action: entry.action, details: entry.details ?? '' })),
        ...logs.map((log) => ({
          date: log.createdAt,
          source: 'acces-urgence',
          actor: log.actorName,
          action: log.status,
          details: [
            `Motif : ${log.reason}`,
            log.approvedByName ? `Décision : ${log.approvedByName}` : '',
            log.endedByName ? `Arrêté par : ${log.endedByName}` : '',
            `Échéance : ${log.expiresAt.toISOString()}`,
          ].filter(Boolean).join(' · '),
        })),
      ].sort((a, b) => b.date.getTime() - a.date.getTime());
      await audit(client, c, guildId, 'Journal Cellule bien-être', `Journal exporté (${rows.length} entrées).`, 'Sécurité');
      return new Response(journalCsv(rows), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="journal-cellule-bien-etre-${guildId}.csv"`,
          'Cache-Control': 'no-store',
        },
      });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error exporting journal:', err);
      return fail(c, err, "Erreur lors de l'export du journal.", 'WellbeingAPI');
    }
  });

  // Ressources d'aide : tenues par la cellule, envoyées au membre en un clic.
  router.get(`${base}/resources`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const state = await resolveWellbeingRole(client, guildId, c.var.dashboardUser.userId);
      if (!state.isTeamMember && !state.isDirector) return send(c, { error: 'Accès refusé.' }, 403);
      return send(c, { resources: cleanResources(state.config?.resources) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error fetching resources:', err);
      return fail(c, err, 'Erreur lors du chargement des ressources.', 'WellbeingAPI');
    }
  });

  router.put(`${base}/resources`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const state = await resolveWellbeingRole(client, guildId, c.var.dashboardUser.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      const body = await readBody<{ resources?: unknown }>(c);
      const resources = cleanResources(body?.resources);
      await prisma.wellbeingConfig.update({ where: { guildId }, data: { resources: resources as unknown as Prisma.InputJsonValue } });
      await audit(client, c, guildId, 'Ressources Cellule bien-être', `${resources.length} ressource(s) d'aide enregistrée(s).`);
      return send(c, { resources });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error saving resources:', err);
      return fail(c, err, 'Erreur lors de la sauvegarde des ressources.', 'WellbeingAPI');
    }
  });

  router.post(`${base}/cases/:caseId/send-resources`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      const caseId = c.req.param('caseId');
      const existing = await findVisibleCase(guildId, caseId, user.userId);
      if (!existing) return send(c, { error: 'Dossier introuvable.' }, 404);
      if (!existing.subjectUserId) return send(c, { error: "Ce dossier n'est lié à aucun membre du serveur." }, 400);
      const resources = cleanResources(state.config?.resources);
      if (resources.length === 0) return send(c, { error: "Aucune ressource d'aide n'est enregistrée." }, 400);

      const target = await client.users.fetch(existing.subjectUserId).catch(() => null);
      const delivered = target
        ? await target.send({ content: resourcesMessage(getGuildName(client, guildId), resources), allowedMentions: { parse: [] } })
          .then(() => true, () => false)
        : false;
      if (!delivered) return send(c, { error: 'Message privé impossible : le membre les a peut-être fermés.' }, 409);

      await recordEvents(caseId, c, [{ type: 'RESOURCES_SENT', toValue: String(resources.length) }]);
      await prisma.wellbeingCase.update({ where: { id: caseId }, data: { lastActivityAt: new Date() } });
      return send(c, { ok: true });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error sending resources:', err);
      return fail(c, err, "Erreur lors de l'envoi des ressources.", 'WellbeingAPI');
    }
  });

  // Référent proposé à la création d'un dossier : le membre le moins chargé.
  router.get(`${base}/assignee-suggestion`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { userId: null });
      const subject = c.req.query('subjectUserId');
      const cases = await prisma.wellbeingCase.findMany({
        where: { guildId, deletedAt: null, status: { not: 'CLOSED' } },
        select: { status: true, severity: true, assigneeId: true },
      });
      const exclude = subject && SNOWFLAKE_RE.test(subject) ? [subject] : [];
      return send(c, { userId: suggestAssignee(referentLoad(cases, teamIdsOf(state)), exclude) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error suggesting assignee:', err);
      return fail(c, err, 'Erreur lors de la suggestion du référent.', 'WellbeingAPI');
    }
  });

  // Signaux de détresse à examiner : un lien vers le message, jamais son texte.
  router.get(`${base}/signals`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      // Un signal sur soi-même reste masqué, comme un dossier (conflit d'intérêts).
      const signals = await prisma.wellbeingDistressSignal.findMany({
        where: { guildId, handledAt: null, userId: { not: user.userId } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      const names = new Map<string, string>();
      for (const signal of signals) {
        if (names.has(signal.userId)) continue;
        const member = state.discordGuild?.members.cache.get(signal.userId);
        names.set(signal.userId, member?.displayName ?? member?.user.username ?? signal.userId);
      }
      return send(c, {
        signals: signals.map((signal) => ({
          id: signal.id,
          userId: signal.userId,
          userName: names.get(signal.userId) ?? signal.userId,
          url: `https://discord.com/channels/${guildId}/${signal.channelId}/${signal.messageId}`,
          createdAt: signal.createdAt.toISOString(),
        })),
      });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error listing signals:', err);
      return fail(c, err, 'Erreur lors du chargement des signaux.', 'WellbeingAPI');
    }
  });

  router.post(`${base}/signals/:signalId/dismiss`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      const { count } = await prisma.wellbeingDistressSignal.updateMany({
        where: { id: c.req.param('signalId'), guildId, handledAt: null, userId: { not: user.userId } },
        data: { handledAt: new Date(), handledById: user.userId, handledByName: actorName(c), outcome: 'DISMISSED' },
      });
      if (count === 0) return send(c, { error: 'Signal introuvable ou déjà traité.' }, 404);
      await audit(client, c, guildId, 'Signal Cellule bien-être', 'Signal de détresse écarté.');
      return send(c, { ok: true });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error dismissing signal:', err);
      return fail(c, err, "Erreur lors du traitement du signal.", 'WellbeingAPI');
    }
  });

  // Message permanent dans un salon : écrire à la cellule d'un clic.
  router.post(`${base}/report-panel`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      if (!state.config?.reportEnabled) {
        return send(c, { error: "Ouvrez d'abord les signalements Discord dans les réglages de la cellule." }, 400);
      }
      const body = await readBody<{ channelId?: string }>(c);
      const channelId = bodyText(body?.channelId, 20);
      const channel = SNOWFLAKE_RE.test(channelId) ? state.discordGuild?.channels.cache.get(channelId) : undefined;
      if (!channel || !channel.isSendable()) return send(c, { error: 'Salon introuvable ou fermé au bot.' }, 400);
      const locale = await resolveGuildLocale(guildId, state.discordGuild?.preferredLocale);
      await channel.send(wellbeingPanelMessage(locale));
      await audit(client, c, guildId, 'Message Cellule bien-être', `Message permanent publié dans #${channel.name}.`);
      return send(c, { ok: true });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error posting panel:', err);
      return fail(c, err, 'Erreur lors de la publication du message.', 'WellbeingAPI');
    }
  });

  return router;
}
