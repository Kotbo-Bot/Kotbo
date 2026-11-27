/**
 * Cellule de suivi : espace confidentiel cloisonné avec accès d'urgence
 * journalisé pour la direction en cas d'enquête interne.
 *
 * Les textes des dossiers sont chiffrés en base (wellbeingCrypto), chaque
 * modification laisse une entrée d'historique, et l'accès d'urgence peut
 * exiger la validation d'une seconde personne et se limiter à un membre.
 *
 * Ce fichier porte la cellule elle-même (état, réglages, revue des accès,
 * désactivation, journal) et monte les routes des dossiers, de l'accès
 * d'urgence, de la charge et des liens avec les membres.
 */
import { Hono } from 'hono';
import type { Client } from 'discord.js';
import type { Prisma } from '@prisma/client';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
import { DEFAULT_ALERT_EVENTS, MAX_ALERT_USERS, alertPreviews, cleanAlertEvents } from '../../../../services/staff/wellbeingAlertPolicy.js';
import {
  WELLBEING_AUDIT_MODULE,
  accessReviewDue,
  emptiesComposition,
  journalCsv,
  describeConfigChange,
} from '../../../../services/staff/wellbeingAccessPolicy.js';
import { MAX_FOLLOW_UP_DAYS } from '../../../../services/staff/wellbeingCasePolicy.js';
import { sendWellbeingAlert } from '../../../../services/staff/wellbeingAlerts.js';
import { cancelDissolution, requestDissolution } from '../../../../services/staff/wellbeingDissolution.js';
import { bodyText } from '../../../../utils/bodyText.js';
import { PROFILE_RETENTION_DEFAULT_MONTHS, cleanProfileRetention } from '../../../../services/staff/wellbeingProfilePolicy.js';
import { applyProfileRetention } from '../../../../services/staff/wellbeingProfiles.js';
import { cleanBoardColumns, describeBoardColumns } from '../../../../services/staff/wellbeingBoardPolicy.js';
import { actorName, audit, customizationOf, HOUR_MS, newColumnId, resolveWellbeingRole, SNOWFLAKE_RE } from './wellbeingShared.js';
import {
  CUSTOMIZATION_FIELDS,
  copyableCustomization,
  describeCustomization,
  type CustomizationKind,
} from '../../../../services/staff/wellbeingCustomPolicy.js';
import { networkGuildIds } from '../../../../services/staff/wellbeingNetwork.js';
import { sharesNetworkPool } from '../../../../services/staff/wellbeingNetworkPolicy.js';
import { createWellbeingBreakGlassRouter } from './wellbeingBreakGlass.js';
import { createWellbeingCasesRouter } from './wellbeingCases.js';
import { createWellbeingCaseItemsRouter } from './wellbeingCaseItems.js';
import { createWellbeingWorkloadRouter } from './wellbeingWorkload.js';
import { createWellbeingCareRouter } from './wellbeingCare.js';

const MAX_STALE_DAYS = 90;

export function createWellbeingRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/wellbeing';
  const gate = guildRoute(client);
  router.route('/', createWellbeingBreakGlassRouter(client));
  router.route('/', createWellbeingCasesRouter(client));
  router.route('/', createWellbeingCaseItemsRouter(client));
  router.route('/', createWellbeingWorkloadRouter(client));
  router.route('/', createWellbeingCareRouter(client));

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
        // Étapes de la vue en colonnes : seulement pour qui lit les dossiers.
        boardColumns: state.canReadCases ? cleanBoardColumns(state.config?.boardColumns, newColumnId) : [],
        // Catégories, protocole de crise, plans types et étiquettes de la cellule.
        customization: state.canReadCases ? customizationOf(state.config) : null,
      });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error fetching status:', err);
      return fail(c, err, 'Erreur lors du chargement de la cellule de suivi.', 'WellbeingAPI');
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
        return send(c, { error: 'Seul le propriétaire du serveur peut modifier la cellule de suivi.' }, 403);
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

      // Une durée baissée vaut aussi pour les notes déjà écrites ; une hausse ne rallonge rien.
      if (state.config && config.profileRetentionMonths < state.config.profileRetentionMonths) {
        const shortened = await applyProfileRetention(guildId, config.profileRetentionMonths);
        if (shortened > 0) {
          await audit(client, c, guildId, 'Configuration Cellule de suivi',
            `${shortened} note(s) de fiche ramenée(s) à ${config.profileRetentionMonths} mois.`, 'Sécurité');
        }
      }

      await audit(client, c, guildId, 'Configuration Cellule de suivi', describeConfigChange(state.config, config, (id) => {
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
        await audit(client, c, guildId, 'Configuration Cellule de suivi',
          `Désactivation de la cellule demandée, effective le ${dissolutionAt.toISOString()} sauf annulation.`, 'Sécurité');
      }

      const { resources: _resources, ...saved } = config;
      return send(c, { config: { ...saved, dissolutionAt } });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error saving config:', err);
      return fail(c, err, 'Erreur lors de la sauvegarde de la configuration.', 'WellbeingAPI');
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
      await audit(client, c, guildId, 'Revue des accès Cellule de suivi', 'Composition de la cellule et de la direction confirmée.');
      return send(c, { accessReviewedAt: now.toISOString() });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error confirming access review:', err);
      return fail(c, err, 'Erreur lors de la confirmation.', 'WellbeingAPI');
    }
  });

  // Colonnes ajoutées à la vue en colonnes : un outil de travail de la cellule.
  router.put(`${base}/board-columns`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const state = await resolveWellbeingRole(client, guildId, c.var.dashboardUser.userId);
      if (!state.canWriteCases || !state.config) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const body = await readBody<{ columns?: unknown }>(c);
      const columns = cleanBoardColumns(body?.columns, newColumnId);
      await prisma.wellbeingConfig.update({ where: { guildId }, data: { boardColumns: columns as unknown as Prisma.InputJsonValue } });
      // Une colonne supprimée rend ses dossiers à la colonne de leur statut.
      await prisma.wellbeingCase.updateMany({
        where: { guildId, stage: { not: null, notIn: columns.map((column) => column.id) } },
        data: { stage: null },
      });
      await audit(client, c, guildId, 'Colonnes Cellule de suivi', describeBoardColumns(columns));
      return send(c, { columns });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error saving board columns:', err);
      return fail(c, err, "Erreur lors de l'enregistrement des colonnes.", 'WellbeingAPI');
    }
  });

  // Réglages de la cellule : catégories et trames, protocole de crise, plans
  // d'action types, étiquettes, trames de notes. Seuls les réglages envoyés changent.
  router.put(`${base}/customization`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const state = await resolveWellbeingRole(client, guildId, c.var.dashboardUser.userId);
      if (!state.canWriteCases || !state.config) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const body = await readBody<Partial<Record<CustomizationKind, unknown>>>(c);
      const kinds = (Object.keys(CUSTOMIZATION_FIELDS) as CustomizationKind[]).filter((kind) => body?.[kind] !== undefined);
      if (kinds.length === 0) return send(c, { error: 'Aucun réglage reçu.' }, 400);
      const changes = kinds.map((kind) => ({ kind, value: CUSTOMIZATION_FIELDS[kind].clean(body?.[kind], newColumnId) }));
      const data = Object.fromEntries(changes.map((change) => [CUSTOMIZATION_FIELDS[change.kind].column, change.value as unknown as Prisma.InputJsonValue]));
      await prisma.wellbeingConfig.update({ where: { guildId }, data });
      for (const change of changes) {
        await audit(client, c, guildId, 'Réglages Cellule de suivi', describeCustomization(change.kind, change.value));
      }
      return send(c, { customization: customizationOf({ ...state.config, ...data }) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error saving customization:', err);
      return fail(c, err, "Erreur lors de l'enregistrement des réglages.", 'WellbeingAPI');
    }
  });

  /** Autres serveurs du réseau dont la cellule partage avec le réseau, et leur réglage. */
  async function sharingSources(guildId: string) {
    const ids = (await networkGuildIds(guildId)).filter((id) => id !== guildId);
    if (ids.length === 0) return [];
    const configs = await prisma.wellbeingConfig.findMany({ where: { guildId: { in: ids } } });
    return configs.filter((config) => sharesNetworkPool(config));
  }

  // Cellules du réseau dont on peut reprendre les réglages : des libellés, jamais un dossier.
  router.get(`${base}/customization/sources`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const state = await resolveWellbeingRole(client, guildId, c.var.dashboardUser.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const sources = (await sharingSources(guildId)).map((config) => {
        const custom = customizationOf(config);
        return {
          guildId: config.guildId,
          guildName: client.guilds.cache.get(config.guildId)?.name ?? config.guildId,
          counts: {
            categories: custom.categories.length,
            crisisTasks: custom.crisisDefault ? 0 : custom.crisisTasks.length,
            taskPlans: custom.taskPlans.length,
            tags: custom.tags.length,
            noteTemplates: custom.noteTemplates.length,
          },
        };
      });
      return send(c, { sources });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error listing customization sources:', err);
      return fail(c, err, 'Erreur lors du chargement du réseau.', 'WellbeingAPI');
    }
  });

  // Reprendre des réglages d'une cellule du réseau : ils remplacent ceux d'ici.
  router.post(`${base}/customization/import`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const state = await resolveWellbeingRole(client, guildId, c.var.dashboardUser.userId);
      if (!state.canWriteCases || !state.config) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const body = await readBody<{ guildId?: string; kinds?: unknown }>(c);
      const sourceId = bodyText(body?.guildId, 20);
      const inNetwork = sourceId !== guildId && (await networkGuildIds(guildId)).includes(sourceId);
      const source = inNetwork ? await prisma.wellbeingConfig.findUnique({ where: { guildId: sourceId } }) : null;
      if (!source) return send(c, { error: 'Serveur introuvable dans le réseau.' }, 404);
      const copy = copyableCustomization(source as unknown as Parameters<typeof copyableCustomization>[0], Array.isArray(body?.kinds) ? body.kinds : []);
      if (!copy) return send(c, { error: 'Cette cellule ne partage pas ses réglages avec le réseau.' }, 403);
      if (Object.keys(copy).length === 0) return send(c, { error: 'Aucun réglage choisi.' }, 400);
      const data = Object.fromEntries(Object.entries(copy).map(([column, value]) => [column, value as unknown as Prisma.InputJsonValue]));
      await prisma.wellbeingConfig.update({ where: { guildId }, data });
      const sourceName = client.guilds.cache.get(sourceId)?.name ?? sourceId;
      for (const [kind, field] of Object.entries(CUSTOMIZATION_FIELDS) as Array<[CustomizationKind, (typeof CUSTOMIZATION_FIELDS)[CustomizationKind]]>) {
        const value = copy[field.column];
        if (value) await audit(client, c, guildId, 'Réglages Cellule de suivi', `${describeCustomization(kind, value)} (repris de ${sourceName})`);
      }
      return send(c, { customization: customizationOf({ ...state.config, ...data }) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error importing customization:', err);
      return fail(c, err, 'Erreur lors de la reprise des réglages.', 'WellbeingAPI');
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
      await audit(client, c, guildId, 'Configuration Cellule de suivi', 'Désactivation de la cellule annulée.', 'Sécurité');
      return send(c, { ok: true });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error cancelling dissolution:', err);
      return fail(c, err, "Erreur lors de l'annulation.", 'WellbeingAPI');
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
      await audit(client, c, guildId, 'Journal Cellule de suivi', `Journal exporté (${rows.length} entrées).`, 'Sécurité');
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

  return router;
}
