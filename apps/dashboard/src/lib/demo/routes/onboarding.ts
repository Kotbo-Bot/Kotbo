/**
 * Parcours d'onboarding en mode démonstration.
 *
 * Permet de tester l'intégralité du wizard (`/onboarding`) après avoir ajouté
 * un serveur sur `/servers`, sans appel réseau externe ni facturation réelle.
 */
import { route } from '../backend';
import { demoDb } from '../db';
import { CATEGORIES, CHANNELS, ROLES, VOICE_CHANNELS } from '../fixtures';
import type { ServerTemplatePlanItem, ServerTemplateState } from '../../api/serverTemplateTypes';

const COMPLETED_KEY = 'demo/onboarding-completed';
const STATE_KEY = (guildId: string) => `onboarding/state/${guildId}`;
const APPLIED_KEY = (guildId: string) => `onboarding/applied/${guildId}`;

const DEMO_PLAN: ServerTemplatePlanItem[] = [
  { key: 'role-admin', section: 'staff', kind: 'role', parent: null, name: 'Admin', wiring: 'staff', audience: 'staff', readOnly: false, required: true, moduleId: null, linkedTo: null, dependsOn: null },
  { key: 'role-mod', section: 'staff', kind: 'role', parent: null, name: 'Modérateur', wiring: 'staff', audience: 'staff', readOnly: false, required: false, moduleId: null, linkedTo: null, dependsOn: null },
  { key: 'role-member', section: 'access', kind: 'role', parent: null, name: 'Membre', wiring: 'member', audience: 'member', readOnly: false, required: true, moduleId: null, linkedTo: null, dependsOn: null },
  { key: 'cat-welcome', section: 'welcome', kind: 'category', parent: null, name: 'Accueil', wiring: null, audience: 'everyone', readOnly: true, required: true, moduleId: null, linkedTo: null, dependsOn: null },
  { key: 'ch-rules', section: 'welcome', kind: 'text', parent: 'cat-welcome', name: 'règlement', wiring: 'rules', audience: 'everyone', readOnly: true, required: true, moduleId: null, linkedTo: null, dependsOn: 'cat-welcome' },
  { key: 'ch-welcome', section: 'welcome', kind: 'text', parent: 'cat-welcome', name: 'bienvenue', wiring: 'welcome', audience: 'everyone', readOnly: true, required: false, moduleId: null, linkedTo: null, dependsOn: 'cat-welcome' },
  { key: 'cat-community', section: 'text', kind: 'category', parent: null, name: 'Communauté', wiring: null, audience: 'member', readOnly: false, required: true, moduleId: null, linkedTo: null, dependsOn: null },
  { key: 'ch-general', section: 'text', kind: 'text', parent: 'cat-community', name: 'général', wiring: null, audience: 'member', readOnly: false, required: true, moduleId: null, linkedTo: null, dependsOn: 'cat-community' },
  { key: 'ch-support', section: 'tickets', kind: 'text', parent: 'cat-community', name: 'support', wiring: 'tickets', audience: 'member', readOnly: false, required: false, moduleId: 'tickets', linkedTo: null, dependsOn: 'cat-community' },
  { key: 'cat-staff', section: 'staff', kind: 'category', parent: null, name: 'Staff', wiring: null, audience: 'staff', readOnly: false, required: false, moduleId: null, linkedTo: null, dependsOn: null },
  { key: 'ch-logs', section: 'security', kind: 'text', parent: 'cat-staff', name: 'logs', wiring: 'logs', audience: 'staff', readOnly: true, required: false, moduleId: 'logs', linkedTo: null, dependsOn: 'cat-staff' },
  { key: 'vc-lounge', section: 'voice', kind: 'voice', parent: 'cat-community', name: 'Salon vocal', wiring: null, audience: 'member', readOnly: false, required: false, moduleId: null, linkedTo: null, dependsOn: 'cat-community' },
];

function buildTemplateState(guildId: string): ServerTemplateState {
  const applied = demoDb.get<ServerTemplateState['applied']>(APPLIED_KEY(guildId), () => null);
  return {
    locale: 'fr',
    plan: DEMO_PLAN,
    present: [],
    matches: {},
    inventory: {
      channels: [
        ...CATEGORIES.map((c, i) => ({ id: c.id, name: c.name, kind: 'category' as const, parentId: null, position: i })),
        ...CHANNELS.map((c, i) => ({ id: c.id, name: c.name, kind: 'text' as const, parentId: null, position: i })),
        ...VOICE_CHANNELS.map((c, i) => ({ id: c.id, name: c.name, kind: 'voice' as const, parentId: null, position: i })),
      ],
      roles: ROLES.map((r, i) => ({ id: r.id, name: r.name, color: r.color, position: i, assignable: true, managed: false })),
    },
    defaults: {},
    structured: false,
    defaultSelection: DEMO_PLAN.map((item) => item.key),
    missingPermissions: [],
    canCreateChannels: true,
    hasLogChannel: false,
    isAdministrator: true,
    maturity: {
      maturity: 'fresh',
      ageDays: 2,
      reasons: [],
    },
    fullSelection: DEMO_PLAN.map((item) => item.key),
    applied,
  };
}

export function registerOnboardingRoutes(): void {
  route('GET', '/api/discord/client-id', () => ({ clientId: '1100000000000000001' }));

  route('GET', '/api/dashboard/guilds/:guildId/onboarding/state', ({ params }) => ({
    state: demoDb.get<Record<string, unknown> | null>(STATE_KEY(params.guildId), () => null),
  }));

  route('PUT', '/api/dashboard/guilds/:guildId/onboarding/state', ({ params, body }) => {
    demoDb.set(STATE_KEY(params.guildId), body ?? null);
    return { ok: true, state: body ?? null };
  });

  route('POST', '/api/dashboard/guilds/:guildId/onboarding/complete', ({ params }) => {
    const completed = demoDb.get<string[]>(COMPLETED_KEY, () => []);
    if (!completed.includes(params.guildId)) {
      demoDb.set(COMPLETED_KEY, [...completed, params.guildId]);
    }
    return { ok: true };
  });

  route('GET', '/api/dashboard/guilds/:guildId/server-template', ({ params }) =>
    buildTemplateState(params.guildId),
  );

  route('POST', '/api/dashboard/guilds/:guildId/server-template/apply', ({ params, body }) => {
    const payload = (body ?? {}) as { selection?: string[] };
    const selection = Array.isArray(payload.selection) ? payload.selection : DEMO_PLAN.map((item) => item.key);
    demoDb.set(APPLIED_KEY(params.guildId), {
      at: new Date().toISOString(),
      by: 'demo',
      selection,
    });
    return {
      applied: true,
      roles: 3,
      categories: 3,
      channels: 5,
      modules: 2,
    };
  });

  route('POST', '/api/dashboard/guilds/:guildId/server-template/channel', ({ body }) => {
    const purpose = ((body ?? {}) as { purpose?: string }).purpose ?? 'salon';
    return {
      id: `9300000000000009${Math.floor(Math.random() * 89 + 10)}`,
      name: purpose === 'staffAlerts' ? 'alertes-staff' : purpose,
      created: true,
    };
  });

  route('POST', '/api/dashboard/guilds/:guildId/server-template/roles', ({ body }) => {
    const roles = ((body ?? {}) as { roles?: { name: string; color?: string }[] }).roles ?? [];
    return {
      created: roles.length,
      roles: roles.map((r, i) => ({
        id: `930000000000008${i}`,
        name: r.name,
        color: r.color ?? '#5865f2',
      })),
    };
  });

  route('GET', '/api/dashboard/guilds/:guildId/migration', () => ({
    bots: [],
    findings: [],
    manualSteps: [],
  }));

  route('POST', '/api/dashboard/guilds/:guildId/migration/apply', () => ({
    ok: true,
    applied: 0,
  }));

  route('GET', '/api/dashboard/guilds/:guildId/billing/status', () => ({
    plan: 'FREE',
    status: 'none',
    trialEligible: true,
    trialDays: 14,
    canFinishWithoutPayment: true,
  }));
}
