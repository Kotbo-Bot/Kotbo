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
  COMMAND_CATALOG,
  COMMAND_RESTRICTIONS,
  regulationSeed,
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

const EXTRA_DEMO_SERVERS = [
  { id: '930000000000000031', name: 'Les Veilleurs', icon: null, owner: true, botPresent: false, activated: false },
  { id: '930000000000000032', name: 'Labo de Zenox', icon: null, owner: false, botPresent: true, activated: false },
];

export function registerSessionRoutes(): void {
  route('GET', '/api/auth/session', () => ({ user: sessionUser() }));
  route('POST', '/api/auth/migrate', () => ({ ok: true }));
  route('POST', '/api/auth/logout', () => ({ ok: true }));
  route('GET', '/api/user/me', () => sessionUser());

  const installedIds = () => new Set(demoDb.get<string[]>('demo/installed-guilds', () => []));

  route('GET', '/api/user/guilds', () => {
    const installed = installedIds();
    const extra = EXTRA_DEMO_SERVERS
      .filter((g) => g.botPresent || installed.has(g.id))
      .map((g) => ({
        id: g.id,
        name: g.name,
        icon: g.icon,
        owner: g.owner,
        botPresent: true,
        accessLevel: 'admin' as const,
        isStaffServer: false,
        pairedGuildId: null,
        billingAccess: true,
      }));
    return { guilds: [...sessionGuilds(), ...extra] };
  });

  // Page « Mes serveurs » : le serveur de démo, plus deux autres où l'on est admin mais sans Kotbo.
  route('GET', '/api/user/servers', () => {
    const installed = installedIds();
    return {
      guilds: [
        ...sessionGuilds().map((g) => ({ id: g.id, name: g.name, icon: g.icon, owner: true, botPresent: true, activated: true })),
        ...EXTRA_DEMO_SERVERS.map((g) =>
          installed.has(g.id)
            ? { ...g, botPresent: true, activated: true }
            : g,
        ),
      ],
      clientId: '1100000000000000001',
      invitePermissions: '8',
      oauthUnavailable: false,
    };
  });

  route('POST', '/api/demo/guilds/:guildId/install', ({ params }) => {
    const list = demoDb.get<string[]>('demo/installed-guilds', () => []);
    if (!list.includes(params.guildId)) {
      demoDb.set('demo/installed-guilds', [...list, params.guildId]);
    }
    return { ok: true };
  });
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
  const guildState = ({ params }: { params: Record<string, string> }) => {
    const states = moduleStates();
    const featureKeys = [...MODULE_REGISTRY.map((m) => m.key), 'centralized_config', 'commands', 'settings'];
    const extraGuild = EXTRA_DEMO_SERVERS.find((g) => g.id === params.guildId);
    const completedOnboarding = new Set(demoDb.get<string[]>('demo/onboarding-completed', () => []));
    const onboardingRequired = extraGuild ? !completedOnboarding.has(extraGuild.id) : false;

    return {
      guildName: extraGuild?.name ?? DEMO_GUILD_NAME,
      plan: 'PLUS',
      onboardingRequired,
      onboardingCanFinishWithoutPayment: true,
      configChannelId: channelByName('staff').id,
      logChannelId: channelByName('logs').id,
      logIgnoredChannelIds: [],
      regulationChannelId: channelByName('règlement').id,
      regulationMessageId: '900000000000009301',
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
      commandRestrictions: demoDb.get('command-access', () => COMMAND_RESTRICTIONS),
      sidebarFavorites: [],
      commandCatalog: COMMAND_CATALOG,
      access: { level: 'admin', canModerateContent: true, canManageSettings: true },
      featureAccess: featureAccessFor(featureKeys),
      auditTrail: demoDb.get(AUDIT, auditSeed),
      sanctions: demoDb.get(SANCTIONS, sanctionsSeed),
      sanctionReports: [],
      sanctionTables: [],
      regulationRules: demoDb.get('regulation/rules', regulationSeed),
      messageTemplate: '',
      member: sessionMember(),
    };
  };
  route('GET', '/api/dashboard/guilds/:guildId', guildState);
  route('GET', '/api/dashboard/guilds/:guildId/state', guildState);
}
