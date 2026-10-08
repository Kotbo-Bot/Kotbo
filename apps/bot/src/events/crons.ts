import { type Client } from 'discord.js';
import cron from 'node-cron';
import prisma from '../utils/db.js';
import { runDailyAlgoForAllGuilds, runDailyAlgoSummariesForAllGuilds } from '../services/progression/dailyAlgoService.js';
import { runDailyAlgoWeeklyClosuresForAllGuilds } from '../services/progression/dailyAlgoWeekService.js';
import { scanGuildMembersForYoungAccounts, JOIN_TO_ACCOUNT_CREATION_PROXIMITY_MS } from '../services/moderation/dcDetectionService.js';
import { processScheduledSanctions, checkMissingReports } from '../services/moderation/sanctionService.js';
import { processMeetingNotifications } from '../services/staff/staffLeadershipService.js';
import { logger } from '../utils/logger.js';
import pLimit from 'p-limit';
import { runActivitySnapshot } from './advancedLogs.js';
import { enqueueBackgroundJob, registerBackgroundJobHandlers, type BackgroundJobName } from '../infra/queues/backgroundQueue.js';
import { captureException } from '../observability/sentry.js';
import { checkYoutubeFollows } from '../services/integrations/youtubeService.js';
import { checkTwitchFollows } from '../services/integrations/twitchService.js';
import { checkGithubFollows } from '../services/integrations/githubService.js';
import { checkHuggingFaceFollows } from '../services/integrations/huggingFaceService.js';
import { initializeDatabaseBackup } from '../services/system/databaseBackupService.js';
import { checkTicketInactivity } from '../services/features/ticketService.js';
import { checkExpiredGiveaways } from '../services/features/giveawayService.js';
import { refreshAllAutoLeaderboards } from '../services/progression/leaderboardService.js';
import { pruneOldMessageLogs } from './messageLogging.js';
import { pruneOldAuditEvents } from '../services/analytics/auditDiffService.js';
import { dispatchScheduledWorkflows, pruneWorkflowExecutions, resumePendingExecutions } from '../services/features/workflow/workflowService.js';
import { expireTemporaryRoles } from '../services/features/workflow/temporaryRoles.js';
import { pruneOldWordStats } from '../services/analytics/wordStatsService.js';
import { runBanHygieneScan } from '../services/moderation/banHygieneService.js';
import { isModuleEnabled } from '../services/core/moduleGate.js';

const runningJobs = new Set<string>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Planifie un job, en file d'attente si Redis repond, en local sinon.
 *
 * `name` est TYPE : il l'etait autrefois en `string` avec un cast vers
 * `BackgroundJobName` juste en dessous, si bien qu'un job planifie sans handler
 * enregistre compilait sans un mot. En file d'attente, `enqueueBackgroundJob`
 * reussit, le repli local ne s'execute donc jamais, et le worker echoue a chaque
 * declenchement sur un « Aucun handler enregistre ». C'est ce qui est arrive aux
 * quatre cycles de partenariats, restes muets depuis leur arrivee.
 */
async function runCronJob(name: BackgroundJobName, task: () => Promise<void>, jitterMs = 0): Promise<void> {
  const minuteTimestamp = Math.floor(Date.now() / 60000);
  const enqueued = await enqueueBackgroundJob(name, { jitterMs }, { jobId: `cron-${name}-${minuteTimestamp}` });
  if (enqueued) {
    logger.debug('Cron', `Job mis en file: ${name}`);
    return;
  }

  if (runningJobs.has(name)) {
    logger.warn('Cron', `Job ignoré (déjà en cours): ${name}`);
    return;
  }

  runningJobs.add(name);
  const startedAt = Date.now();

  try {
    if (jitterMs > 0) {
      const jitter = Math.floor(Math.random() * jitterMs);
      await delay(jitter);
    }

    await task();
    logger.debug('Cron', `Job terminé: ${name} (${Date.now() - startedAt}ms)`);
  } catch (error) {
    logger.error('Cron', `Erreur job ${name}:`, error);
    // Meme raison que pour la file : un cron qui echoue en repli local ne
    // laisse qu'une ligne de journal, aussitot noyee par le passage suivant.
    captureException(error, `Cron:${name}`);
  } finally {
    runningJobs.delete(name);
  }
}

/**
 * Balayage propre à ce processus, sans passer par la file d'attente : pour les
 * traitements qui ne portent que sur les serveurs du shard courant. Un passage
 * encore en cours fait sauter le suivant plutôt que de le doubler.
 */
const runningSweeps = new Set<string>();

async function runLocalSweep(name: string, task: () => Promise<void>): Promise<void> {
  if (runningSweeps.has(name)) return;
  runningSweeps.add(name);
  try {
    await task();
  } catch (error) {
    logger.error('Cron', `Erreur balayage ${name}:`, error);
  } finally {
    runningSweeps.delete(name);
  }
}

async function expireStaffWarnings(): Promise<void> {
  logger.debug('Cron', "Vérification de l'expiration des avertissements staff...");
  const now = new Date();

  const expiredWarnings = await prisma.staffWarning.findMany({
    where: {
      isActive: true,
      expiresAt: { lte: now },
    },
    select: { id: true, staffUserId: true },
  });

  if (expiredWarnings.length > 0) {
    await prisma.staffWarning.updateMany({
      where: {
        id: { in: expiredWarnings.map((w) => w.id) },
      },
      data: { isActive: false },
    });
    logger.info('Cron', `✅ ${expiredWarnings.length} avertissement(s) staff expiré(s)`);
  }
}

async function expireStaffBlacklist(): Promise<void> {
  logger.debug('Cron', "Vérification de l'expiration de la blacklist staff...");
  const now = new Date();

  const expiredBlacklists = await prisma.staffBlacklist.findMany({
    where: {
      isActive: true,
      endDate: { lte: now },
    },
    select: { id: true, staffUserId: true },
  });

  if (expiredBlacklists.length > 0) {
    await prisma.staffBlacklist.updateMany({
      where: {
        id: { in: expiredBlacklists.map((b) => b.id) },
      },
      data: { isActive: false },
    });
    logger.info('Cron', `✅ ${expiredBlacklists.length} blacklist(s) staff expiré(e)s`);
  }
}

export async function registerCrons(client: Client): Promise<void> {
  logger.info('Cron', "Début de l'enregistrement des cron jobs...");
  // Initialiser le backup automatique de la base de données
  initializeDatabaseBackup();
  logger.info('Cron', 'Backup automatique initialisé');

  // Initialiser les planifications dynamiques de la base de données
  try {
    logger.info('Cron', 'Chargement du planificateur de tâches planifiées...');
    const { initializeScheduler } = await import('../services/system/scheduleService.js');
    await initializeScheduler(client);
    logger.info('Cron', 'Planificateur de tâches planifiées initialisé');
  } catch (err) {
    logger.error('Cron', 'Erreur lors du démarrage du planificateur de tâches planifiées:', err);
  }

  registerBackgroundJobHandlers({
    'scheduled-events': async () => {
      logger.debug('Cron', 'Vérification des événements planifiés...');
      const { checkScheduledEvents } = await import('../services/features/eventService.js');
      await checkScheduledEvents(client);
    },
    'daily-algo': async () => {
      const now = new Date();
      const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      logger.debug('Cron', `Vérification du daily algo à ${currentTime}...`);
      await runDailyAlgoForAllGuilds(client);
    },
    'daily-algo-summary': async () => {
      logger.debug('Cron', 'Génération du bilan quotidien Daily Algo...');
      await runDailyAlgoSummariesForAllGuilds(client);
    },
    'daily-algo-week': async () => {
      logger.debug('Cron', 'Clôture de la semaine Daily Algo...');
      await runDailyAlgoWeeklyClosuresForAllGuilds(client);
    },
    sanctions: async () => {
      logger.debug('Cron', 'Traitement des sanctions planifiées...');
      await processScheduledSanctions(client);
    },
    youtube: async () => {
      logger.debug('Cron', 'Vérification YouTube...');
      await checkYoutubeFollows(client);
    },
    twitch: async () => {
      logger.debug('Cron', 'Vérification Twitch...');
      await checkTwitchFollows(client);
    },
    github: async () => {
      logger.debug('Cron', 'Vérification GitHub...');
      await checkGithubFollows(client);
    },
    huggingface: async () => {
      logger.debug('Cron', 'Vérification Hugging Face...');
      await checkHuggingFaceFollows(client);
    },
    'staff-warnings-expiration': expireStaffWarnings,
    'staff-blacklist-expiration': expireStaffBlacklist,
    'activity-10min-snapshot': async () => {
      await runActivitySnapshot(client);
    },
    'missing-reports-check': async () => {
      logger.info('Cron', 'Vérification des rapports de sanction manquants...');
      await checkMissingReports();
    },
    'ticket-inactivity': async () => {
      logger.debug('Cron', "Vérification de l'inactivité des tickets...");
      await checkTicketInactivity(client);
    },
    'satisfaction-prompt-expiry': async () => {
      const { expirePendingCommentPrompts } = await import('../services/features/ticketSatisfactionService.js');
      await expirePendingCommentPrompts(client);
    },
    'leaderboard-refresh': async () => {
      logger.debug('Cron', 'Actualisation des leaderboards automatiques...');
      await refreshAllAutoLeaderboards(client);
    },
    'giveaways-expiration': async () => {
      logger.debug('Cron', 'Clôture des giveaways arrivés à échéance...');
      await checkExpiredGiveaways(client);
    },
    'black-market-cycle': async () => {
      logger.debug('Cron', 'Cycle du marché noir (planification + annonces)...');
      const { runBlackMarketCycle } = await import('../services/features/rpg/rpgBlackMarketService.js');
      await runBlackMarketCycle(client);
    },
    'drop-cycle': async () => {
      logger.debug('Cron', 'Cycle des drops (planification, publication, clôture)...');
      const { runDropCycle } = await import('../services/features/dropService.js');
      await runDropCycle(client);
    },
    'campaign-cycle': async () => {
      logger.debug('Cron', 'Cycle des campagnes (étapes dues, mesures)...');
      const { runCampaignCycle } = await import('../services/features/campaignService.js');
      await runCampaignCycle(client);
    },
    'raid-cycle': async () => {
      logger.debug('Cron', 'Cycle du raid hebdomadaire (ouverture, avancement, clôture)...');
      const { runRaidCycle } = await import('../services/features/rpg/rpgRaidService.js');
      await runRaidCycle(client);
    },
    'clan-tower-cycle': async () => {
      logger.debug('Cron', 'Cycle de la Tour de clan (ouverture, clôture)...');
      const { runClanTowerCycle } = await import('../services/features/rpg/rpgClanTowerService.js');
      await runClanTowerCycle(client);
    },
    'tower-idle-expiration': async () => {
      logger.debug('Cron', 'Clôture des ascensions de la Tour inactives...');
      const { expireIdleTowerRuns } = await import('../services/features/rpg/rpgTowerService.js');
      await expireIdleTowerRuns(client);
    },
    'tower-daily-podium': async () => {
      logger.debug('Cron', 'Podium du défi du jour de la Tour...');
      const { payTowerDailyPodiums } = await import('../services/features/rpg/rpgTowerService.js');
      await payTowerDailyPodiums();
    },
    'meeting-notifications': async () => {
      await processMeetingNotifications();
    },
    'channel-health-analysis': async () => {
      logger.debug('Cron', 'Analyse de santé des salons...');
      const { runChannelHealthAnalysis } = await import('../services/analytics/channelHealthService.js');
      await runChannelHealthAnalysis(client);
    },
    'analytics-alerts': async () => {
      const { runAnalyticsAlerts } = await import('../services/analytics/analyticsAlertsService.js');
      await runAnalyticsAlerts(client);
    },
    'analytics-reports': async () => {
      const { runAnalyticsReports } = await import('../services/analytics/analyticsReportService.js');
      await runAnalyticsReports(client);
    },
    'pulse-snapshot': async () => {
      logger.debug('Cron', 'Calcul du Pulse pour tous les serveurs...');
      const { runPulseForAllGuilds } = await import('../services/analytics/pulseService.js');
      await runPulseForAllGuilds(client);
    },
    'season-check': async () => {
      logger.debug('Cron', 'Vérification des saisons de leveling...');
      const { checkAndProgressSeasons } = await import('../services/progression/seasonService.js');
      await checkAndProgressSeasons(client);
    },
    'clan-season-check': async () => {
      logger.debug('Cron', 'Vérification des saisons de clans...');
      const { checkAndProgressClanSeasons } = await import('../services/community/clanService.js');
      await checkAndProgressClanSeasons(client);
    },
    'clan-weekly-digest': async () => {
      logger.debug('Cron', 'Bilan hebdomadaire des clans...');
      const { runClanWeeklyDigests } = await import('../services/community/clanDigestService.js');
      await runClanWeeklyDigests(client);
    },
    'clan-bet-expiration': async () => {
      logger.debug('Cron', 'Expiration des propositions de paris sans réponse...');
      const { expireStaleBets } = await import('../services/community/clanBetService.js');
      await expireStaleBets(client);
    },
    'marketplace-expiration': async () => {
      logger.debug('Cron', 'Traitement des annonces marketplace expirées...');
      const { processExpiredListings } = await import('../services/economy/marketplaceService.js');
      await processExpiredListings();
    },
    'quest-expiration': async () => {
      logger.debug('Cron', 'Expiration des quêtes anciennes...');
      const { expireOldProgress } = await import('../services/community/questService.js');
      await expireOldProgress();
    },
    'widget-refresh': async () => {
      logger.debug('Cron', 'Rafraîchissement des widgets staff...');
      const { refreshAllStaffWidgets } = await import('../services/integrations/widgetService.js');
      const guilds = await prisma.widgetSubscription.findMany({
        where: { enabled: true },
        select: { guildId: true },
        distinct: ['guildId'],
      });
      for (const { guildId } of guilds) {
        if (!(await isModuleEnabled(guildId, 'staff_directory'))) continue;
        try {
          await refreshAllStaffWidgets(guildId);
        } catch (error) {
          logger.error('Cron', `Refresh widgets échoué pour ${guildId}:`, error);
        }
      }
    },
    'dc-scan': async () => {
      const featureConfigs = await prisma.dashboardFeatureConfig.findMany({
        where: { featureKey: 'double_accounts', enabled: true },
        select: { guildId: true, metadata: true }
      });

      const limit = pLimit(5);
      const tasks = featureConfigs.map((cfg) => limit(async () => {
        try {
          // La ligne filtrée ci-dessus dit que le module est allumé, mais pas
          // qu'une de ses dépendances l'est : la garde tranche pour de bon.
          if (!(await isModuleEnabled(cfg.guildId, 'double_accounts'))) return;

          const meta = cfg.metadata as { workflowDraft?: { autoDetectionEnabled?: boolean }; autoDetectionEnabled?: boolean } | null;
          const autoEnabled = meta?.workflowDraft?.autoDetectionEnabled ?? meta?.autoDetectionEnabled ?? false;
          if (!autoEnabled) return;

          const guild = await client.guilds.fetch(cfg.guildId).catch(() => null);
          if (!guild) return;

          const res = await scanGuildMembersForYoungAccounts(guild, JOIN_TO_ACCOUNT_CREATION_PROXIMITY_MS).catch((e) => {
            logger.error('Cron', `Erreur pendant dc-scan pour guild ${cfg.guildId}:`, e);
            return null;
          });

          if (res && res.flaggedCount > 0) {
            logger.info('Cron', `dc-scan: ${res.flaggedCount} détection(s) sur la guilde ${cfg.guildId}`);
          }
        } catch (e) {
          logger.error('Cron', 'Erreur dc-scan boucle:', e);
        }
      }));

      await Promise.all(tasks);
    },
    'stats-ping': async () => {
      logger.debug('Cron', 'Vérification du stats ping...');
      const { pingMasterServer } = await import('../services/system/statsService.js');
      await pingMasterServer(client);
    },
    'access-lifecycle': async () => {
      logger.debug('Cron', 'Vérification des accès à durée limitée...');
      const { runAccessLifecycleCheck } = await import('../services/system/accessService.js');
      await runAccessLifecycleCheck(client);
    },
    'message-logs-prune': pruneOldMessageLogs,
    'audit-events-prune': pruneOldAuditEvents,
    'member-role-snapshots-prune': async () => {
      const { pruneMemberRoleSnapshots } = await import('../services/moderation/rolePersistenceService.js');
      await pruneMemberRoleSnapshots();
    },
    'billing-events-prune': async () => {
      const { pruneOldBillingEvents } = await import('../services/billing/subscriptionSync.js');
      await pruneOldBillingEvents();
    },
    'billing-renewal-notice': async () => {
      const { runRenewalNoticeCheck } = await import('../services/billing/renewalNoticeService.js');
      await runRenewalNoticeCheck(client);
    },
    'analytics-daily-snapshot': async () => {
      const { runDailySnapshot } = await import('../services/analytics/acquisitionSnapshotService.js');
      await runDailySnapshot();
    },
    'acquisition-events-prune': async () => {
      const { pruneAcquisitionEvents, anonymiseDepartedGuilds } = await import(
        '../services/analytics/acquisitionMaintenance.js'
      );
      await pruneAcquisitionEvents();
      await anonymiseDepartedGuilds();
    },
    'dashboard-telemetry-prune': async () => {
      const { pruneDashboardTelemetry } = await import('../services/analytics/dashboardTelemetryService.js');
      await pruneDashboardTelemetry();
    },
    'site-analytics-prune': async () => {
      const { pruneSiteAnalytics } = await import('../services/site/siteAnalyticsService.js');
      await pruneSiteAnalytics();
    },
    'acquisition-abandon-scan': async () => {
      const { scanAbandonedOnboardings } = await import('../services/analytics/acquisitionMaintenance.js');
      await scanAbandonedOnboardings();
    },
    'acquisition-alerts-check': async () => {
      const { runAcquisitionAlertsCheck } = await import('../services/analytics/acquisitionAlertsService.js');
      await runAcquisitionAlertsCheck(client);
    },
    'acquisition-weekly-recap': async () => {
      const { runWeeklyAcquisitionRecap } = await import('../services/analytics/acquisitionAlertsService.js');
      await runWeeklyAcquisitionRecap(client);
    },
    'word-stats-prune': async () => {
      await pruneOldWordStats();
    },
    'aegis-prune': async () => {
      const { pruneAegisData } = await import('../services/moderation/aegis/aegisRetention.js');
      await pruneAegisData();
    },
    'workflow-executions-prune': async () => {
      const deleted = await pruneWorkflowExecutions();
      if (deleted > 0) logger.info('Cron', `${deleted} exécution(s) de workflow purgée(s)`);
    },
    'ban-hygiene-scan': async () => {
      await runBanHygieneScan(client);
    },
    'warn-auto-archive': async () => {
      const { runWarnAutoArchive } = await import('../services/moderation/sanctionArchiveService.js');
      const archived = await runWarnAutoArchive();
      if (archived > 0) logger.info('Cron', `${archived} warn(s) archivé(s) automatiquement`);
    },
    'staff-reminders': async () => {
      const { processDueReminders } = await import('../services/staff/reminderService.js');
      await processDueReminders(client);
    },
    'bump-reminder-tick': async () => {
      const { processDueBumpReminders } = await import('../services/integrations/bumpDetectionService.js');
      await processDueBumpReminders(client);
    },
    'raid-protection-tick': async () => {
      const { expireOverdueCaptchaSessions, recoverStrandedVoiceSessions } = await import('../services/moderation/captchaService.js');
      const { autoDisableExpiredRaidModes } = await import('../services/moderation/raidProtectionService.js');
      await recoverStrandedVoiceSessions(client);
      await expireOverdueCaptchaSessions(client);
      await autoDisableExpiredRaidModes(client);
    },
    'raid-protection-locks-renew': async () => {
      const { renewActiveLocks } = await import('../services/moderation/raidProtectionService.js');
      await renewActiveLocks(client);
    },
    'welcome-thread-cleanup': async () => {
      const { cleanupInactiveWelcomeThreads } = await import('../services/features/welcomeThreadService.js');
      await cleanupInactiveWelcomeThreads(client);
    },
    'member-access-reconcile': async () => {
      const { reconcileAllMemberAccess } = await import('../services/core/memberAccessService.js');
      await reconcileAllMemberAccess(client);
    },
    'ranked-decay': async () => {
      const { runDecaySweep } = await import('../services/progression/ranked/rankedDecayService.js');
      await runDecaySweep(client);
    },
    'ranked-events': async () => {
      const { progressRankedEvents } = await import('../services/progression/ranked/rankedEventService.js');
      await progressRankedEvents(client);
    },
    'ranked-streak-freezes': async () => {
      const { refillAllStreakFreezes } = await import('../services/progression/ranked/rankedMaintenance.js');
      await refillAllStreakFreezes();
    },
    'ranked-logs-prune': async () => {
      const { purgeRankedLogs } = await import('../services/progression/ranked/rankedService.js');
      await purgeRankedLogs();
    },
  });

  logger.info('Cron', "Handlers de jobs de fond enregistrés, début de l'enregistrement des cron schedules...");

  // Une passe au démarrage, sans attendre l'heure ronde : les membres arrivés
  // pendant que le bot était coupé n'ont reçu aucun rôle, et Discord ne rejoue
  // pas les arrivées manquées. Différée, le temps que les guildes soient là.
  setTimeout(() => {
    void runCronJob('member-access-reconcile', async () => {
      const { reconcileAllMemberAccess } = await import('../services/core/memberAccessService.js');
      await reconcileAllMemberAccess(client);
    }, 5000);
  }, 60_000).unref?.();

  // Même raison pour la présence : les retours et départs survenus pendant la
  // coupure n'ont été vus par personne.
  setTimeout(() => {
    void runLocalSweep('member-presence-reconcile', async () => {
      const { reconcileAllMemberPresence } = await import('../services/analytics/memberPresenceService.js');
      await reconcileAllMemberPresence(client);
    });
  }, 5 * 60_000).unref?.();

  // 📊 Daily Algo: Toutes les minutes (vérification de l'heure configurée)
  cron.schedule('* * * * *', async () => {
    await runCronJob('daily-algo', async () => {
      await runDailyAlgoForAllGuilds(client);
    }, 3000);
  });

  // 📊 Daily Algo: Bilan à 23:59 UTC
  cron.schedule('59 23 * * *', async () => {
    await runCronJob('daily-algo-summary', async () => {
      await runDailyAlgoSummariesForAllGuilds(client);
    }, 2000);
  }, { timezone: 'UTC' });

  // 🏁 Daily Algo: Clôture de la semaine, le lundi à 00:05 UTC.
  // Un peu après minuit pour laisser passer le bilan de 23:59 de la veille.
  cron.schedule('5 0 * * 1', async () => {
    await runCronJob('daily-algo-week', async () => {
      await runDailyAlgoWeeklyClosuresForAllGuilds(client);
    }, 2000);
  }, { timezone: 'UTC' });

  // 🛡️ Sanctions: Toutes les minutes (expiration des mutes/bans)
  cron.schedule('* * * * *', async () => {
    await runCronJob('sanctions', async () => {
      await processScheduledSanctions(client);
    }, 1000);
  });

  // 🎯 Événements planifiés: Toutes les minutes (CTF & Quiz planifiés)
  cron.schedule('* * * * *', async () => {
    await runCronJob('scheduled-events', async () => {
      const { checkScheduledEvents } = await import('../services/features/eventService.js');
      await checkScheduledEvents(client);
    }, 1000);
  });

  // 🎉 Giveaways: Toutes les minutes (clôture des concours arrivés à échéance)
  cron.schedule('* * * * *', async () => {
    await runCronJob('giveaways-expiration', async () => {
      await checkExpiredGiveaways(client);
    }, 1000);
  });

  // 🕯️ Marché noir: Toutes les minutes (planification de la prochaine ouverture + annonce)
  cron.schedule('* * * * *', async () => {
    await runCronJob('black-market-cycle', async () => {
      const { runBlackMarketCycle } = await import('../services/features/rpg/rpgBlackMarketService.js');
      await runBlackMarketCycle(client);
    }, 1000);
  });

  // 🎁 Drops: Toutes les minutes (apparition à l'heure tirée au sort + clôture des expirés)
  cron.schedule('* * * * *', async () => {
    await runCronJob('drop-cycle', async () => {
      const { runDropCycle } = await import('../services/features/dropService.js');
      await runDropCycle(client);
    }, 1000);
  });

  // ⚔️ Raid hebdomadaire: Toutes les minutes (ouverture, barre de progression, clôture)
  cron.schedule('* * * * *', async () => {
    await runCronJob('raid-cycle', async () => {
      const { runRaidCycle } = await import('../services/features/rpg/rpgRaidService.js');
      await runRaidCycle(client);
    }, 1000);
  });

  // La Tour de clan : ouverture de la semaine, annonce et clôture (toutes les minutes)
  cron.schedule('* * * * *', async () => {
    await runCronJob('clan-tower-cycle', async () => {
      const { runClanTowerCycle } = await import('../services/features/rpg/rpgClanTowerService.js');
      await runClanTowerCycle(client);
    }, 1000);
  });

  // La Tour : clôture des ascensions restées inactives (toutes les 5 minutes)
  cron.schedule('*/5 * * * *', async () => {
    await runCronJob('tower-idle-expiration', async () => {
      const { expireIdleTowerRuns } = await import('../services/features/rpg/rpgTowerService.js');
      await expireIdleTowerRuns(client);
    }, 2000);
  });

  // La Tour : podium du défi de la veille, dès que ses dernières ascensions sont closes (tous les quarts d'heure)
  cron.schedule('*/15 * * * *', async () => {
    await runCronJob('tower-daily-podium', async () => {
      const { payTowerDailyPodiums } = await import('../services/features/rpg/rpgTowerService.js');
      await payTowerDailyPodiums();
    }, 2000);
  });

  // 📊 Activity & Heatmap: Toutes les 10 minutes (Snapshot présences lissé)
  // Offloaded to BullMQ worker to avoid blocking the main event loop
  cron.schedule('*/10 * * * *', async () => {
    await runCronJob('activity-10min-snapshot', async () => {
      await runActivitySnapshot(client);
    }, 2000);
  });

  // 🛡️ Staff Management: Expirations à minuit
  cron.schedule('0 0 * * *', async () => {
    await runCronJob('staff-warnings-expiration', expireStaffWarnings, 1000);
  });

  cron.schedule('0 1 * * *', async () => {
    await runCronJob('staff-blacklist-expiration', expireStaffBlacklist, 1000);
  });

  // 🗂️ Journalisation des messages: purge selon la rétention (tous les jours à 03:30)
  cron.schedule('30 3 * * *', async () => {
    await runCronJob('message-logs-prune', pruneOldMessageLogs, 2000);
  });

  // 📜 Audit structurel: purge des états avant/après expirés (tous les jours à 03:35)
  cron.schedule('35 3 * * *', async () => {
    await runCronJob('audit-events-prune', pruneOldAuditEvents, 2000);
  });

  // 💳 Facturation: purge des webhooks Stripe archivés (tous les jours à 03:40).
  // Ces lignes servent d'abord de verrou d'idempotence, sur une fenêtre bien
  // plus courte que leur intérêt d'audit : Stripe cesse de rejouer un événement
  // au bout de 3 jours, on garde large.
  cron.schedule('40 3 * * *', async () => {
    await runCronJob('billing-events-prune', async () => {
      const { pruneOldBillingEvents } = await import('../services/billing/subscriptionSync.js');
      await pruneOldBillingEvents();
    }, 2000);
  });

  // 📅 Facturation: avis de reconduction des abonnements annuels (tous les jours à 09:15).
  // L'article L215-1 du code de la consommation impose de prevenir entre trois
  // mois et un mois avant l'echeance. En matinee plutot qu'en pleine nuit : le
  // message part aussi en prive, et un avis commercial recu a 3 h du matin se
  // lit mal.
  cron.schedule('15 9 * * *', async () => {
    await runCronJob('billing-renewal-notice', async () => {
      const { runRenewalNoticeCheck } = await import('../services/billing/renewalNoticeService.js');
      await runRenewalNoticeCheck(client);
    }, 2000);
  });

  // 📊 Acquisition: instantane quotidien de l'etat commercial (03:20).
  // Fige la veille, pas le jour courant : une journee en cours donnerait un
  // instantane partiel qui serait pris pour un chiffre definitif des le
  // lendemain matin.
  cron.schedule('20 3 * * *', async () => {
    await runCronJob('analytics-daily-snapshot', async () => {
      const { runDailySnapshot } = await import('../services/analytics/acquisitionSnapshotService.js');
      await runDailySnapshot();
    }, 2000);
  });

  // 🧹 Acquisition: purge du journal et anonymisation des serveurs partis (03:50).
  // Apres l'instantane : ce qui est purge doit d'abord avoir ete agrege.
  cron.schedule('50 3 * * *', async () => {
    await runCronJob('acquisition-events-prune', async () => {
      const { pruneAcquisitionEvents, anonymiseDepartedGuilds } = await import(
        '../services/analytics/acquisitionMaintenance.js'
      );
      await pruneAcquisitionEvents();
      await anonymiseDepartedGuilds();
    }, 2000);
  });

  // 🧭 Telemetrie du dashboard : purge au-dela de 180 jours (03:55).
  cron.schedule('55 3 * * *', async () => {
    await runCronJob('dashboard-telemetry-prune', async () => {
      const { pruneDashboardTelemetry } = await import('../services/analytics/dashboardTelemetryService.js');
      await pruneDashboardTelemetry();
    }, 2000);
  });

  // 🌐 Frequentation des sites communautaires : purge au-dela de 180 jours (03:57).
  cron.schedule('57 3 * * *', async () => {
    await runCronJob('site-analytics-prune', async () => {
      const { pruneSiteAnalytics } = await import('../services/site/siteAnalyticsService.js');
      await pruneSiteAnalytics();
    }, 2000);
  });

  // 🕳️ Acquisition: parcours de configuration abandonnes (toutes les heures).
  // L'abandon est la seule etape que personne n'emet : un visiteur qui renonce
  // ferme l'onglet. Elle ne peut etre que deduite.
  cron.schedule('40 * * * *', async () => {
    await runCronJob('acquisition-abandon-scan', async () => {
      const { scanAbandonedOnboardings } = await import('../services/analytics/acquisitionMaintenance.js');
      await scanAbandonedOnboardings();
    }, 2000);
  });

  // 🔔 Acquisition: vérification des alertes et anomalies commerciales (tous les jours à 09:30).
  cron.schedule('30 9 * * *', async () => {
    await runCronJob('acquisition-alerts-check', async () => {
      const { runAcquisitionAlertsCheck } = await import('../services/analytics/acquisitionAlertsService.js');
      await runAcquisitionAlertsCheck(client);
    }, 2000);
  });

  // 📬 Acquisition: récapitulatif commercial hebdomadaire (chaque lundi à 09:00).
  cron.schedule('0 9 * * 1', async () => {
    await runCronJob('acquisition-weekly-recap', async () => {
      const { runWeeklyAcquisitionRecap } = await import('../services/analytics/acquisitionAlertsService.js');
      await runWeeklyAcquisitionRecap(client);
    }, 2000);
  });

  // 🧩 Workflows: reprise des exécutions suspendues par un nœud « Attendre »,
  // et déclencheurs planifiés. Un balayage plutôt qu'une tâche cron par
  // workflow : la liste change à chaque enregistrement, et un balayage reprend
  // tout seul après un redémarrage.
  //
  // Hors file d'attente, volontairement : un job en file n'est traité que par
  // un seul processus par minute, qui ne voit que les serveurs de son shard.
  // Chaque processus balaie ici les siens.
  cron.schedule('* * * * *', async () => {
    await runLocalSweep('workflow-resume', () => resumePendingExecutions(client));
  });

  cron.schedule('* * * * *', async () => {
    await runLocalSweep('workflow-schedule', () => dispatchScheduledWorkflows(client));
  });

  // Webhooks sortants : relances dues et purge du journal (30 jours). Chaque
  // envoi est réservé avant d'être tenté, deux processus ne le doublent pas.
  cron.schedule('* * * * *', async () => {
    await runLocalSweep('outgoing-webhooks', async () => {
      const { runOutgoingWebhookSweep } = await import('../services/integrations/outgoingWebhookService.js');
      await runOutgoingWebhookSweep();
    });
  });

  // Workflows : purge du journal des exécutions (tous les jours à 04:25). En
  // file, contrairement aux balayages : elle porte sur toute la base, un seul
  // processus suffit.
  cron.schedule('25 4 * * *', async () => {
    await runCronJob('workflow-executions-prune', async () => {
      const deleted = await pruneWorkflowExecutions();
      if (deleted > 0) logger.info('Cron', `${deleted} exécution(s) de workflow purgée(s)`);
    }, 2000);
  });

  // Workflows : retrait des rôles donnés pour une durée, hors file pour la même
  // raison que les deux balayages ci-dessus.
  cron.schedule('* * * * *', async () => {
    await runLocalSweep('workflow-temporary-roles', () => expireTemporaryRoles(client));
  });

  // 📣 Campagnes : un balayage a la minute plutot qu'une tache cron par
  // campagne. La liste change a chaque enregistrement, et un balayage reprend
  // les etapes en retard tout seul apres un redemarrage.
  cron.schedule('* * * * *', async () => {
    await runCronJob('campaign-cycle', async () => {
      const { runCampaignCycle } = await import('../services/features/campaignService.js');
      await runCampaignCycle(client);
    });
  });

  // Rôles persistants: purge des traces expirées ou orphelines (tous les jours à 03:55)
  cron.schedule('55 3 * * *', async () => {
    await runCronJob('member-role-snapshots-prune', async () => {
      const { pruneMemberRoleSnapshots } = await import('../services/moderation/rolePersistenceService.js');
      await pruneMemberRoleSnapshots();
    }, 2000);
  });

  // 📊 Stats de mots: purge des agrégats de plus de 90 jours (tous les jours à 03:45)
  cron.schedule('45 3 * * *', async () => {
    await runCronJob('word-stats-prune', async () => {
      await pruneOldWordStats();
    }, 2000);
  });

  // 🛡️ Kotbo × AegisAI: extraits à l'échéance de la rétention des logs, détections et agrégats anciens (tous les jours à 03:50)
  cron.schedule('50 3 * * *', async () => {
    await runCronJob('aegis-prune', async () => {
      const { pruneAegisData } = await import('../services/moderation/aegis/aegisRetention.js');
      await pruneAegisData();
    }, 2000);
  });

  // 🧹 Hygiène des bans: détection des comptes supprimés (tous les jours à 05:15)
  cron.schedule('15 5 * * *', async () => {
    await runCronJob('ban-hygiene-scan', async () => {
      await runBanHygieneScan(client);
    }, 3000);
  });

  // 📦 Sanctions: expiration automatique des warns (tous les jours à 05:30)
  cron.schedule('30 5 * * *', async () => {
    await runCronJob('warn-auto-archive', async () => {
      const { runWarnAutoArchive } = await import('../services/moderation/sanctionArchiveService.js');
      const archived = await runWarnAutoArchive();
      if (archived > 0) logger.info('Cron', `${archived} warn(s) archivé(s) automatiquement`);
    }, 3000);
  });

  // 🛡️ Sanctions: Rapports manquants (tous les jours à 12:00, heure de Paris)
  cron.schedule('0 12 * * *', async () => {
    await runCronJob('missing-reports-check', async () => {
      await checkMissingReports();
    }, 2000);
  }, { timezone: 'Europe/Paris' });

  // 📅 Réunions: Notifications (toutes les 2 minutes - suffisant pour les rappels)
  cron.schedule('*/2 * * * *', async () => {
    await runCronJob('meeting-notifications', async () => {
      await processMeetingNotifications();
    }, 3000);
  });

  // ⏰ Rappels Staff: Toutes les minutes
  cron.schedule('* * * * *', async () => {
    await runCronJob('staff-reminders', async () => {
      const { processDueReminders } = await import('../services/staff/reminderService.js');
      await processDueReminders(client);
    }, 1000);
  });

  // 📈 Rappel de bump: envoi dès que la fenêtre est ouverte (toutes les minutes)
  cron.schedule('* * * * *', async () => {
    await runCronJob('bump-reminder-tick', async () => {
      const { processDueBumpReminders } = await import('../services/integrations/bumpDetectionService.js');
      await processDueBumpReminders(client);
    }, 1000);
  });

  // 🛡️ Protection anti-raid: expiration des captchas + auto-disable du raid mode (toutes les minutes)
  cron.schedule('* * * * *', async () => {
    await runCronJob('raid-protection-tick', async () => {
      const { expireOverdueCaptchaSessions, recoverStrandedVoiceSessions } = await import('../services/moderation/captchaService.js');
      const { autoDisableExpiredRaidModes } = await import('../services/moderation/raidProtectionService.js');
      await recoverStrandedVoiceSessions(client);
      await expireOverdueCaptchaSessions(client);
      await autoDisableExpiredRaidModes(client);
    }, 1000);
  });

  // 🛡️ Protection anti-raid: renouvellement des join/DM locks (plafond Discord 24h) - toutes les heures
  cron.schedule('30 * * * *', async () => {
    await runCronJob('raid-protection-locks-renew', async () => {
      const { renewActiveLocks } = await import('../services/moderation/raidProtectionService.js');
      await renewActiveLocks(client);
    }, 2000);
  });

  // Accès au serveur : rend le rôle Membre à qui ne l'a pas reçu - arrivée
  // pendant une coupure du bot, attribution refusée, captcha réussi sans rôle.
  // Sur un serveur mis en place, ce rôle est le seul qui ouvre les salons.
  cron.schedule('20 * * * *', async () => {
    await runCronJob('member-access-reconcile', async () => {
      const { reconcileAllMemberAccess } = await import('../services/core/memberAccessService.js');
      await reconcileAllMemberAccess(client);
    }, 5000);
  });

  // 👥 Présence des membres : corrige les fiches « parti » de membres revenus,
  // et les départs manqués, toutes les 6 h. Propre au shard, chacun ne voyant
  // que ses serveurs : une passe mise en file n'en couvrirait qu'un.
  cron.schedule('15 */6 * * *', async () => {
    await runLocalSweep('member-presence-reconcile', async () => {
      const { reconcileAllMemberPresence } = await import('../services/analytics/memberPresenceService.js');
      await reconcileAllMemberPresence(client);
    });
  });

  // 👋 Threads d'accueil: purge des threads inactifs (toutes les heures).
  // Le plafond de suppressions par passage étale la charge sur plusieurs heures
  // quand un salon a accumulé un gros retard.
  cron.schedule('25 * * * *', async () => {
    await runCronJob('welcome-thread-cleanup', async () => {
      const { cleanupInactiveWelcomeThreads } = await import('../services/features/welcomeThreadService.js');
      await cleanupInactiveWelcomeThreads(client);
    }, 5000);
  });

  // 🏆 Ranked: cycle des événements RP (démarrage/clôture), toutes les minutes.
  // Le multiplicateur ne dépend que des dates : un cron en retard ne fausse
  // aucun gain, il ne retarde que l'annonce.
  cron.schedule('* * * * *', async () => {
    await runCronJob('ranked-events', async () => {
      const { progressRankedEvents } = await import('../services/progression/ranked/rankedEventService.js');
      await progressRankedEvents(client);
    }, 1000);
  });

  // 📉 Ranked: decay quotidien à 04:10 UTC. Après le pic d'activité des
  // serveurs européens, pour qu'un membre actif la veille au soir ne se réveille
  // pas avec une perte à cheval sur sa journée.
  cron.schedule('10 4 * * *', async () => {
    await runCronJob('ranked-decay', async () => {
      const { runDecaySweep } = await import('../services/progression/ranked/rankedDecayService.js');
      await runDecaySweep(client);
    }, 5000);
  }, { timezone: 'UTC' });

  // 🧊 Ranked: recharge des gels de série, le lundi à 00:10 UTC.
  cron.schedule('10 0 * * 1', async () => {
    await runCronJob('ranked-streak-freezes', async () => {
      const { refillAllStreakFreezes } = await import('../services/progression/ranked/rankedMaintenance.js');
      await refillAllStreakFreezes();
    }, 5000);
  }, { timezone: 'UTC' });

  // 🧹 Ranked: purge du journal de RP (tous les jours à 03:40).
  cron.schedule('40 3 * * *', async () => {
    await runCronJob('ranked-logs-prune', async () => {
      const { purgeRankedLogs } = await import('../services/progression/ranked/rankedService.js');
      await purgeRankedLogs();
    }, 2000);
  });

  // 🔍 DC Scan: Toutes les heures (vérifie les guildes qui ont activé l'auto-détection)
  cron.schedule('0 * * * *', async () => {
    await runCronJob('dc-scan', async () => {
      const featureConfigs = await prisma.dashboardFeatureConfig.findMany({
        where: { featureKey: 'double_accounts', enabled: true },
        select: { guildId: true, metadata: true }
      });

      const dcLimit = pLimit(5);
      await Promise.all(featureConfigs.map((cfg) => dcLimit(async () => {
        try {
          const meta = cfg.metadata as { workflowDraft?: { autoDetectionEnabled?: boolean }; autoDetectionEnabled?: boolean } | null;
          const autoEnabled = meta?.workflowDraft?.autoDetectionEnabled ?? meta?.autoDetectionEnabled ?? false;
          if (!autoEnabled) return;

          const guild = await client.guilds.fetch(cfg.guildId).catch(() => null);
          if (!guild) return;

          await scanGuildMembersForYoungAccounts(guild, JOIN_TO_ACCOUNT_CREATION_PROXIMITY_MS).catch((e) => {
            logger.error('Cron', `Erreur pendant dc-scan pour guild ${cfg.guildId}:`, e);
          });
        } catch (e) {
          logger.error('Cron', 'Erreur dc-scan cron:', e);
        }
      })));
    }, 5000);
  });

  // 📺 YouTube & Twitch checks: toutes les 5 minutes (en parallèle)
  cron.schedule('*/5 * * * *', async () => {
    await Promise.allSettled([
      runCronJob('youtube', async () => {
        await checkYoutubeFollows(client);
      }, 5000),
      runCronJob('twitch', async () => {
        await checkTwitchFollows(client);
      }, 5000),
      runCronJob('github', async () => {
        await checkGithubFollows(client);
      }, 5000),
      runCronJob('huggingface', async () => {
        await checkHuggingFaceFollows(client);
      }, 5000),
    ]);
  });

  // 🎫 Ticket Inactivity Checks: toutes les 10 minutes
  cron.schedule('*/10 * * * *', async () => {
    await runCronJob('ticket-inactivity', async () => {
      await checkTicketInactivity(client);
    }, 2000);
  });

  // 📋 Sondages de satisfaction expirés: toutes les minutes.
  // Le minuteur en mémoire ferme le sondage à la seconde près ; ce balayage
  // rattrape ceux dont le délai est passé pendant un redémarrage du bot.
  cron.schedule('* * * * *', async () => {
    await runCronJob('satisfaction-prompt-expiry', async () => {
      const { expirePendingCommentPrompts } = await import('../services/features/ticketSatisfactionService.js');
      await expirePendingCommentPrompts(client);
    }, 1000);
  });

  // 🏆 Leaderboard Auto-Refresh: toutes les heures
  cron.schedule('5 * * * *', async () => {
    await runCronJob('leaderboard-refresh', async () => {
      await refreshAllAutoLeaderboards(client);
    }, 5000);
  });

  // 📈 Analytics : alertes sur seuil et rapports planifiés, toutes les 5 minutes.
  // Chaque règle n'évalue qu'une fois sa période ; chaque rapport part à son heure.
  cron.schedule('*/5 * * * *', async () => {
    await runCronJob('analytics-alerts', async () => {
      const { runAnalyticsAlerts } = await import('../services/analytics/analyticsAlertsService.js');
      await runAnalyticsAlerts(client);
    }, 2000);
    await runCronJob('analytics-reports', async () => {
      const { runAnalyticsReports } = await import('../services/analytics/analyticsReportService.js');
      await runAnalyticsReports(client);
    }, 4000);
  });

  // 📊 Channel Health Analysis: tous les jours à 4h du matin
  cron.schedule('0 4 * * *', async () => {
    await runCronJob('channel-health-analysis', async () => {
      const { runChannelHealthAnalysis } = await import('../services/analytics/channelHealthService.js');
      await runChannelHealthAnalysis(client);
    }, 5000);
  }, { timezone: 'Europe/Paris' });

  // 💓 Pulse: Snapshot quotidien à 3h du matin
  cron.schedule('0 3 * * *', async () => {
    await runCronJob('pulse-snapshot', async () => {
      const { runPulseForAllGuilds } = await import('../services/analytics/pulseService.js');
      await runPulseForAllGuilds(client);
    }, 5000);
  }, { timezone: 'Europe/Paris' });

  // 🏆 Leveling Seasons: Vérification quotidienne à 0h05
  cron.schedule('5 0 * * *', async () => {
    await runCronJob('season-check', async () => {
      const { checkAndProgressSeasons } = await import('../services/progression/seasonService.js');
      await checkAndProgressSeasons(client);
    }, 3000);
  }, { timezone: 'Europe/Paris' });

  // 🛡️ Clan Seasons: Vérification toutes les 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    await runCronJob('clan-season-check', async () => {
      const { checkAndProgressClanSeasons } = await import('../services/community/clanService.js');
      await checkAndProgressClanSeasons(client);
    }, 3000);
  });

  // 🛡️ Clans: Bilan hebdomadaire dans les QG, toutes les heures.
  // Toutes les heures et non le lundi : l'heure de parution suit le fuseau de chaque
  // serveur, et un bot arrêté ce matin-là doit pouvoir rattraper son bilan.
  cron.schedule('20 * * * *', async () => {
    await runCronJob('clan-weekly-digest', async () => {
      const { runClanWeeklyDigests } = await import('../services/community/clanDigestService.js');
      await runClanWeeklyDigests(client);
    }, 5000);
  });

  // 🎲 Paris: Expiration des propositions sans réponse toutes les 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    await runCronJob('clan-bet-expiration', async () => {
      const { expireStaleBets } = await import('../services/community/clanBetService.js');
      await expireStaleBets(client);
    }, 3000);
  });

  // 🏪 Marketplace: Expiration des annonces toutes les 10 minutes
  cron.schedule('*/10 * * * *', async () => {
    await runCronJob('marketplace-expiration', async () => {
      const { processExpiredListings } = await import('../services/economy/marketplaceService.js');
      await processExpiredListings();
    }, 2000);
  });

  // 📋 Quests: Expiration des quêtes quotidiennes à minuit
  cron.schedule('0 0 * * *', async () => {
    await runCronJob('quest-expiration', async () => {
      const { expireOldProgress } = await import('../services/community/questService.js');
      await expireOldProgress();
    }, 2000);
  }, { timezone: 'Europe/Paris' });

  // 🎨 Widget: Refresh des widgets staff toutes les 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    await runCronJob('widget-refresh', async () => {
      const { refreshAllStaffWidgets } = await import('../services/integrations/widgetService.js');
      const guilds = await prisma.widgetSubscription.findMany({
        where: { enabled: true },
        select: { guildId: true },
        distinct: ['guildId'],
      });
      for (const { guildId } of guilds) {
        try {
          await refreshAllStaffWidgets(guildId);
        } catch (error) {
          logger.error('Cron', `Refresh widgets échoué pour ${guildId}:`, error);
        }
      }
    }, 5000);
  });

  // 🔑 Accès à durée limitée: rappels et expiration des essais/abonnements.
  // Toutes les minutes, car c'est la granularité d'une durée d'accès : un essai
  // court doit se couper à l'heure dite. La requête est filtrée par index partiel
  // et ne remonte que les serveurs ayant une échéance en cours.
  cron.schedule('* * * * *', async () => {
    await runCronJob('access-lifecycle', async () => {
      const { runAccessLifecycleCheck } = await import('../services/system/accessService.js');
      await runAccessLifecycleCheck(client);
    }, 1000);
  });

  // 📊 Stats: Ping all instances every 15 minutes.
  // C'est le seul canal par lequel le master peut transmettre une directive
  // de bannissement a une instance self-host (qui ne fait que sortir) : une
  // cadence de 6h rendrait un bannissement quasi-imperceptible.
  cron.schedule('*/15 * * * *', async () => {
    await runCronJob('stats-ping', async () => {
      const { pingMasterServer } = await import('../services/system/statsService.js');
      await pingMasterServer(client);
    }, 5000);
  });

  // Trigger a stats ping shortly after startup (10 seconds) to refresh stats
  setTimeout(() => {
    logger.info('Cron', 'Triggering startup stats ping...');
    import('../services/system/statsService.js')
      .then(({ pingMasterServer }) => pingMasterServer(client))
      .catch((err) => logger.error('Cron', 'Failed to run startup stats ping:', err));
  }, 10_000);

  logger.success('Cron', "Tous les jobs cron sont enregistrés (Suivi d'activité minute activé)");
}
