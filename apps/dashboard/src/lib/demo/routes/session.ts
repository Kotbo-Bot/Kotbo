/**
 * Session et serveur : ce que le dashboard lit avant d'afficher quoi que ce soit.
 *
 * Mêmes chemins que `apps/bot/src/api/hono/routes/auth.ts`, `user.ts` et
 * `shared/guildState.ts`. La personne de démo est administratrice d'un seul
 * serveur, déjà installé : le parcours d'installation et l'activation sont
 * sautés, on arrive sur l'accueil.
 */
import { MODULE_REGISTRY } from '@kotbo/contracts';
import { route } from '../backend';
import { demoDb } from '../db';
import { DEMO_GUILD_NAME } from '../mode';
import {
  CATEGORIES,
  CHANNELS,
  ROLES,
  VOICE_CHANNELS,
  featureAccessFor,
  moduleItems,
  moduleStatesSeed,
  role,
  sessionGuilds,
  sessionMember,
  sessionUser,
  channelByName,
} from '../fixtures';
import { auditSeed, sanctionsSeed } from '../stories';

export const MODULE_STATES = 'modules/states';
export const SANCTIONS = 'sanctions';
export const AUDIT = 'audit';

export const moduleStates = () => demoDb.get(MODULE_STATES, moduleStatesSeed);

export function registerSessionRoutes(): void {
  route('GET', '/api/auth/session', () => ({ user: sessionUser() }));
  route('POST', '/api/auth/migrate', () => ({ ok: true }));
  route('POST', '/api/auth/logout', () => ({ ok: true }));
  route('GET', '/api/user/me', () => sessionUser());
  route('GET', '/api/user/guilds', () => ({ guilds: sessionGuilds() }));
  // L'instance publique de Kotbo, sans marque blanche.
  route('GET', '/api/branding', () => ({
    instanceId: 'public',
    slug: 'kotbo',
    name: 'Kotbo',
    color: null,
    logoUrl: null,
    faviconUrl: null,
    footerText: null,
    isWhiteLabel: false,
  }));

  /** L'état complet du serveur, tel que le rend `buildGuildState`. */
  route('GET', '/api/dashboard/guilds/:guildId', () => {
    const states = moduleStates();
    const featureKeys = [...MODULE_REGISTRY.map((m) => m.key), 'centralized_config', 'commands', 'settings'];

    return {
      guildName: DEMO_GUILD_NAME,
      plan: 'PLUS',
      onboardingRequired: false,
      onboardingCanFinishWithoutPayment: false,
      configChannelId: channelByName('staff').id,
      logChannelId: channelByName('logs').id,
      logIgnoredChannelIds: [],
      regulationChannelId: channelByName('règlement').id,
      publicChannelId: channelByName('général').id,
      newsChannelId: channelByName('annonces').id,
      baseStaffRoleId: role('Helper').id,
      testStaffRoleId: '',
      moderatorRoleId: role('Modérateur').id,
      staffRoleIds: [role('Fondateur').id, role('Admin').id, role('Modérateur').id, role('Helper').id],
      sanctionAlertChannelId: channelByName('staff').id,
      propagateSanctions: false,
      crossServerSanctionsEnabled: true,
      sanctionReportEnabled: true,
      sanctionReportSkipBots: false,
      analyticsEnabled: true,
      economyEnabled: states.economy !== false,
      levelingEnabled: states.leveling !== false,
      funEnabled: states.fun !== false,
      autoThreadEnabled: states.auto_thread !== false,
      modules: moduleItems(states),
      moduleStates: states,
      discordChannels: CHANNELS,
      discordVoiceChannels: VOICE_CHANNELS,
      discordCategories: CATEGORIES,
      discordRoles: ROLES,
      commandRestrictions: [],
      sidebarFavorites: [],
      commandCatalog: [],
      access: { level: 'admin', canModerateContent: true, canModerateDailyAlgo: true, canManageSettings: true },
      featureAccess: featureAccessFor(featureKeys),
      auditTrail: demoDb.get(AUDIT, auditSeed),
      sanctions: demoDb.get(SANCTIONS, sanctionsSeed),
      sanctionReports: [],
      sanctionTables: [],
      regulationRules: [],
      messageTemplate: '',
      member: sessionMember(),
    };
  });
}
