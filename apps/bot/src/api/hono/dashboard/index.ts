/**
 * Routes `/api/dashboard/*` servies par Hono.
 *
 * Ce qui n'est pas encore ici passe par `routes/dashboard.ts` (ancien routeur),
 * atteint quand aucune route Hono ne correspond.
 */
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import type { Client } from 'discord.js';
import { createDailyAlgoSubmissionsRouter } from '../../routes/dashboard/modules/daily-algo-submissions.js';
import { createInvitationsRouter } from '../../routes/dashboard/modules/invitations.js';
import { createNewsRouter } from '../../routes/dashboard/modules/news.js';
import { createDailyAlgoProblemsRouter } from '../../routes/dashboard/modules/daily-algo-problems.js';
import { createRegulationRouter } from '../../routes/dashboard/modules/regulation.js';
import { createVerificationModuleRouter } from '../../routes/dashboard/modules/verification.js';
import { createChannelLinksRouter } from '../../routes/dashboard/channelLinks.js';
import { createDropsRouter } from '../../routes/dashboard/drops.js';
import { createCustomFormsRouter } from '../../routes/dashboard/customForms.js';
import { createStaffServerRouter } from '../../routes/dashboard/staffServer.js';
import { createRecruitmentFormsRouter } from '../../routes/dashboard/recruitmentForms.js';
import { createMessageLogsRouter } from '../../routes/dashboard/messageLogs.js';
import { createSuggestionsRouter } from '../../routes/dashboard/suggestions.js';
import { createReputationRouter } from '../../routes/dashboard/reputation.js';
import { createAbsencesRouter } from '../../routes/dashboard/leadership/absences.js';
import { createMeetingsRouter } from '../../routes/dashboard/leadership/meetings.js';
import { createCallsRouter } from '../../routes/dashboard/leadership/calls.js';
import { createTasksRouter } from '../../routes/dashboard/leadership/tasks.js';
import { createTestingPeriodsRouter } from '../../routes/dashboard/leadership/testingPeriods.js';
import { createApiKeysRouter } from '../../routes/dashboard/leadership/apiKeys.js';
import { createMentorReportsRouter } from '../../routes/dashboard/leadership/mentorReports.js';
import { createRemindersRouter } from '../../routes/dashboard/leadership/reminders.js';
import { createEventsRouter } from '../../routes/dashboard/events.js';
import { createWorkflowsRouter } from '../../routes/dashboard/workflows.js';
import { createOutgoingWebhooksRouter } from '../../routes/dashboard/outgoingWebhooks.js';
import { createBackupsRouter } from '../../routes/dashboard/backups.js';
import { createCampaignsRouter } from '../../routes/dashboard/campaigns.js';
import { createSchedulesRouter } from '../../routes/dashboard/schedules.js';
import { createMigrationRouter } from '../../routes/dashboard/migration.js';
import { createWelcomeExperimentsRouter } from '../../routes/dashboard/welcomeExperiments.js';
import { createSimulationRouter } from '../../routes/dashboard/simulation.js';
import { createSeasonsRouter } from '../../routes/dashboard/seasons.js';
import { createTelemetryRouter } from '../../routes/dashboard/telemetry.js';
import { createNotificationInboxRouter } from '../../routes/dashboard/notificationInbox.js';
import { createMemberProfileRouter } from '../../routes/dashboard/memberProfile.js';
import { createAutomodSimulationRouter } from '../../routes/dashboard/automodSimulation.js';
import { createSetupRouter } from '../../routes/dashboard/setup.js';
import { createLogsRouter } from '../../routes/dashboard/modules/logs.js';
import { createNotificationsRouter } from '../../routes/dashboard/modules/notifications.js';
import { createDailyAlgoWeeksRouter } from '../../routes/dashboard/modules/daily-algo-weeks.js';
import { createPresetsRouter } from '../../routes/dashboard/modules/presets.js';
import { createModuleToggleRouter } from '../../routes/dashboard/modules/modules.js';
import { createManagementRouter } from '../../routes/dashboard/modules/management.js';
import { createImportRouter } from '../../routes/dashboard/modules/import.js';
import { createCommandAccessRouter } from '../../routes/dashboard/modules/command-access.js';
import { createDailyAlgoRunsRouter } from '../../routes/dashboard/modules/daily-algo-runs.js';
import { createTemplateRouter } from '../../routes/dashboard/modules/template.js';
import { createGhostMembersRouter } from '../../routes/dashboard/ghostMembers.js';
import { createChannelHealthRouter } from '../../routes/dashboard/channelHealth.js';
import { createMcpKeysRouter } from '../../routes/dashboard/mcp.js';
import { createWidgetRouter } from '../../routes/dashboard/widget.js';
import { createAdminLockRouter } from '../../routes/dashboard/adminLock.js';
import { createAuditEventsRouter } from '../../routes/dashboard/auditEvents.js';
import { createQuestsRouter } from '../../routes/dashboard/quests.js';
import { createEvaluationsRouter } from '../../routes/dashboard/evaluations.js';
import { createPulseRouter } from '../../routes/dashboard/pulse.js';
import { createHomeTasksRouter } from '../../routes/dashboard/homeTasks.js';
import { createPredictionsRouter } from '../../routes/dashboard/predictions.js';
import { createSatisfactionRouter } from '../../routes/dashboard/satisfaction.js';
import { createMarketplaceRouter } from '../../routes/dashboard/marketplace.js';

export function createDashboardRouter(client: Client) {
  const router = new Hono();

  // L'ancien routeur compressait en gzip au-delà de 1 Ko : les listes du
  // dashboard (membres, journaux, analytics) en dépendent.
  router.use('/api/dashboard/*', compress({ threshold: 1024 }));

  router.route('/', createPredictionsRouter(client));
  router.route('/', createSatisfactionRouter(client));
  router.route('/', createMarketplaceRouter(client));

  router.route('/', createHomeTasksRouter(client));
  router.route('/', createPulseRouter(client));
  router.route('/', createEvaluationsRouter(client));
  router.route('/', createQuestsRouter(client));
  router.route('/', createAuditEventsRouter(client));
  router.route('/', createAdminLockRouter(client));
  router.route('/', createWidgetRouter(client));
  router.route('/', createMcpKeysRouter(client));
  router.route('/', createChannelHealthRouter(client));
  router.route('/', createGhostMembersRouter(client));
  router.route('/', createTemplateRouter(client));
  router.route('/', createDailyAlgoRunsRouter(client));
  router.route('/', createCommandAccessRouter(client));
  router.route('/', createImportRouter(client));
  router.route('/', createManagementRouter(client));
  router.route('/', createModuleToggleRouter(client));
  router.route('/', createPresetsRouter(client));
  router.route('/', createDailyAlgoWeeksRouter(client));
  router.route('/', createNotificationsRouter(client));
  router.route('/', createLogsRouter(client));
  router.route('/', createSetupRouter(client));
  router.route('/', createAutomodSimulationRouter(client));
  router.route('/', createMemberProfileRouter(client));
  // Hors serveur : session seule, sans garde de guilde.
  router.route('/', createTelemetryRouter(client));
  router.route('/', createNotificationInboxRouter(client));
  router.route('/', createSeasonsRouter(client));
  router.route('/', createSimulationRouter(client));
  router.route('/', createWelcomeExperimentsRouter(client));
  router.route('/', createMigrationRouter(client));
  router.route('/', createSchedulesRouter(client));
  router.route('/', createCampaignsRouter(client));
  router.route('/', createBackupsRouter(client));
  router.route('/', createOutgoingWebhooksRouter(client));
  router.route('/', createWorkflowsRouter(client));
  router.route('/', createEventsRouter(client));
  router.route('/', createRemindersRouter(client));
  router.route('/', createMentorReportsRouter(client));
  router.route('/', createApiKeysRouter(client));
  router.route('/', createTestingPeriodsRouter(client));
  router.route('/', createTasksRouter(client));
  router.route('/', createCallsRouter(client));
  router.route('/', createMeetingsRouter(client));
  router.route('/', createAbsencesRouter(client));
  router.route('/', createReputationRouter(client));
  router.route('/', createSuggestionsRouter(client));
  router.route('/', createMessageLogsRouter(client));
  router.route('/', createRecruitmentFormsRouter(client));
  router.route('/', createStaffServerRouter(client));
  router.route('/', createCustomFormsRouter(client));
  router.route('/', createDropsRouter(client));
  router.route('/', createChannelLinksRouter(client));
  router.route('/', createVerificationModuleRouter(client));
  router.route('/', createRegulationRouter(client));
  router.route('/', createDailyAlgoProblemsRouter(client));
  router.route('/', createNewsRouter(client));
  router.route('/', createInvitationsRouter(client));
  router.route('/', createDailyAlgoSubmissionsRouter(client));
  return router;
}
