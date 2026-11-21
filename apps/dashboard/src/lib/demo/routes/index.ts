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

export function registerDemoRoutes(): void {
  // Avant les routes Analytics historiques : la première route qui correspond gagne.
  registerAnalyticsInsightsRoutes();
  registerAnalyticsRoutes();
  registerRankCardRoutes();
  registerServerRoutes();
  registerCommunityRoutes();
  registerPlanningRoutes();
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
}
