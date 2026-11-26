/**
 * Toutes les routes de la démo, déclarées en une fois au démarrage.
 *
 * Chaque fichier de ce dossier couvre un domaine, sur les mêmes chemins que
 * l'API du bot. Les importer ici plutôt qu'au fil de l'eau permet à la
 * construction de production de tout écarter d'un bloc.
 */
import { registerAutoModRoutes } from './automod';
import { registerEconomyRoutes } from './economy';
import { registerHomeRoutes } from './home';
import { registerLevelingRoutes } from './leveling';
import { registerLogsRoutes } from './logs';
import { registerMembersRoutes } from './members';
import { registerModulesRoutes } from './modules';
import { registerSanctionsRoutes } from './sanctions';
import { registerSessionRoutes } from './session';
import { registerStaffRoutes } from './staff';
import { registerTelemetryRoutes } from './telemetry';
import { registerTicketsRoutes } from './tickets';
import { registerPulseRoutes } from './pulse';
import { registerAnalyticsRoutes } from './analytics';
import { registerAnalyticsInsightsRoutes } from './analyticsInsights';
import { registerRankCardRoutes } from './rankCard';
import { registerServerRoutes } from './server';
import { registerCommunityRoutes } from './community';
import { registerPlanningRoutes } from './planning';
import { registerToolsRoutes } from './tools';
import { registerChannelsRoutes } from './channels';
import { registerWebhookRoutes } from './webhooks';
import { registerTutoringRoutes } from './tutoring';
import { registerShopRoutes } from './shop';
import { registerTagAutomodRoutes } from './tagAutomod';
import { registerRaidRoutes } from './raid';
import { registerFilterRoutes, registerSecurityRoutes } from './security';
import { registerWelcomeRoutes } from './welcome';
import { registerSiteRoutes } from './site';
import { registerLinksRoutes } from './links';
import { registerDoingListRoutes } from './doingLists';
import { registerEventRoutes } from './events';
import { registerFormRoutes } from './forms';
import { registerDetailRoutes } from './details';
import { registerNotificationRoutes } from './notifications';
import { registerEngagementRoutes } from './engagement';
import { registerContentRoutes } from './content';
import { registerWorkflowRoutes } from './workflows';
import { registerProgressionRoutes } from './progression';
import { registerClanRoutes } from './clans';
import { registerRpgRoutes } from './rpg';
import { registerOnboardingRoutes } from './onboarding';

export function registerDemoRoutes(): void {
  // Avant les routes Analytics historiques : la première route qui correspond gagne.
  registerAnalyticsInsightsRoutes();
  registerAnalyticsRoutes();
  registerRankCardRoutes();
  registerServerRoutes();
  registerCommunityRoutes();
  registerPlanningRoutes();
  registerToolsRoutes();
  registerChannelsRoutes();
  registerWebhookRoutes();
  registerTutoringRoutes();
  registerShopRoutes();
  registerTagAutomodRoutes();
  registerRaidRoutes();
  registerSecurityRoutes();
  registerFilterRoutes();
  registerWelcomeRoutes();
  registerSiteRoutes();
  registerLinksRoutes();
  registerDoingListRoutes();
  registerEventRoutes();
  registerFormRoutes();
  registerDetailRoutes();
  registerNotificationRoutes();
  registerEngagementRoutes();
  registerContentRoutes();
  registerWorkflowRoutes();
  registerProgressionRoutes();
  registerClanRoutes();
  registerRpgRoutes();
  registerSessionRoutes();
  registerHomeRoutes();
  registerTelemetryRoutes();
  registerMembersRoutes();
  registerSanctionsRoutes();
  registerTicketsRoutes();
  registerStaffRoutes();
  registerAutoModRoutes();
  registerLevelingRoutes();
  registerEconomyRoutes();
  registerLogsRoutes();
  registerModulesRoutes();
  registerPulseRoutes();
  registerOnboardingRoutes();
}
