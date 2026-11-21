/**
 * Annonces : accueil, départs, boosts, rôles automatiques, fil d'accueil et
 * tests A/B du message d'accueil. Formes de `generalistModules.ts` et
 * `welcomeExperiments.ts` côté bot.
 */
import { route } from '../backend';
import { demoDb, demoId } from '../db';
import { row } from '../model';
import { G } from '../crud';
import { DAY, ago, channelByName, role } from '../fixtures';

const welcomeSeed = () =>
  row('WelcomeConfig', {
    welcomeEnabled: true,
    welcomeChannelId: channelByName('bienvenue').id,
    welcomeMessage: 'Bienvenue {user} sur **{server}** ! Tu es notre {memberCount}ᵉ membre 🎉\nPasse par <#900000000000000311> avant de discuter.',
    welcomeImageEnabled: true,
    leaveEnabled: true,
    leaveChannelId: channelByName('bienvenue').id,
    leaveMessage: '{username} nous a quittés. À bientôt peut-être 👋',
    boostEnabled: true,
    boostChannelId: channelByName('annonces').id,
    boostMessage: 'Merci {user} pour le boost 🚀 Le serveur passe à {boostCount} boosts !',
    boostImageEnabled: true,
    joinRoleId: role('Membre').id,
    tagAutoRoleEnabled: true,
    tagAutoRoleId: role('Habitué').id,
    statusScanEnabled: true,
    statusScanKeyword: '.gg/nova',
    statusScanRoleId: role('Habitué').id,
  });

function threadSeed() {
  const base = row('WelcomeThreadConfig', {
    enabled: true,
    channelId: channelByName('bienvenue').id,
    embedTitle: 'Bienvenue sur Atelier Nova !',
    embedColor: '#22D3EE',
  });
  const step = (n: number, content: string, delayMs: number) => row('WelcomeThreadStep', { id: `wts-${n}`, order: n, content, delayMs });
  const page = (n: number, label: string, emoji: string, extra: Record<string, unknown>) => row('WelcomeMenuPage', { id: `wmp-${n}`, order: n, label, emoji, ...extra });
  return {
    ...base,
    steps: [
      step(0, 'Salut {user} 👋 Je suis Kotbo, je vais te faire visiter.', 1_500),
      step(1, 'Ici on parle jeux, création et entraide. Choisis ce qui t’intéresse dans le menu juste en dessous.', 3_000),
      step(2, 'Une question ? Ouvre un ticket dans <#900000000000000317>, le staff répond vite.', 3_000),
    ],
    pages: [
      page(0, 'Le règlement', '📜', { summary: 'Les 6 règles à connaître', actionType: 'EMBED', embedTitle: 'Le règlement en bref', embedDescription: '1. Respect\n2. Pas de pub\n3. Pas de spam…' }),
      page(1, 'Je joue', '🎮', { summary: 'Accès aux salons de jeu', actionType: 'ROLE', roleId: role('Habitué').id, roleAction: 'ADD' }),
      page(2, 'Notre site', '🌐', { summary: 'Wiki, actus et classement', actionType: 'LINK', linkUrl: 'https://kotbo.fr/s/atelier-nova' }),
    ],
  };
}

type Experiment = {
  id: string;
  name: string;
  hypothesis: string | null;
  status: 'DRAFT' | 'RUNNING' | 'STOPPED';
  primaryMetric: 'retained_d1' | 'retained_d7' | 'retained_d30' | 'activated_d7';
  variants: Array<{ key: string; name: string; weight: number; message: string | null; imageEnabled: boolean | null; threadEnabled: boolean | null }>;
  winnerKey: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  createdAt: string;
  assigned: Record<string, number>;
};

const experimentsSeed = (): Experiment[] => [
  {
    id: 'exp-1',
    name: 'Message court ou message long ?',
    hypothesis: 'Un accueil court fait plus parler les nouveaux la première semaine.',
    status: 'RUNNING',
    primaryMetric: 'activated_d7',
    variants: [
      { key: 'A', name: 'Actuel (long)', weight: 50, message: null, imageEnabled: null, threadEnabled: null },
      { key: 'B', name: 'Court + fil', weight: 50, message: 'Bienvenue {user} ! Dis-nous à quoi tu joues 👇', imageEnabled: false, threadEnabled: true },
    ],
    winnerKey: null,
    startedAt: ago(12 * DAY),
    stoppedAt: null,
    createdAt: ago(13 * DAY),
    assigned: { A: 41, B: 43 },
  },
];

const experiments = () => demoDb.get('welcome/experiments', experimentsSeed);

function results(e: Experiment) {
  const metric = (eligible: number, success: number, control?: { rate: number }) => {
    const rate = eligible ? success / eligible : null;
    return { eligible, success, rate, vsControl: control && rate !== null ? { uplift: rate / control.rate - 1, chanceToBeat: 0.87, pValue: 0.09 } : null };
  };
  return {
    variants: e.variants.map((v, i) => {
      const assigned = e.assigned[v.key] ?? 0;
      const base = i === 0 ? { d1: 0.71, d7: 0.52, d30: 0.38, act: 0.34 } : { d1: 0.76, d7: 0.58, d30: 0.41, act: 0.47 };
      const control = i === 0 ? undefined : { rate: 0.34 };
      return {
        key: v.key,
        name: v.name,
        weight: v.weight,
        assigned,
        metrics: {
          retained_d1: metric(assigned, Math.round(assigned * base.d1)),
          retained_d7: metric(assigned, Math.round(assigned * base.d7)),
          retained_d30: metric(Math.round(assigned * 0.4), Math.round(assigned * 0.4 * base.d30)),
          activated_d7: metric(assigned, Math.round(assigned * base.act), control),
        },
        messagesFirstWeek: i === 0 ? 6.2 : 8.9,
      };
    }),
    primaryMetric: e.primaryMetric,
    recommendation: { status: 'collecting' as const, winnerKey: null, neededPerVariant: 60 },
  };
}

export function registerWelcomeRoutes(): void {
  const welcome = () => demoDb.get('welcome/config', welcomeSeed);
  route('GET', `${G}/announcement`, () => ({ config: welcome() }));
  route('PATCH', `${G}/announcement`, ({ body }) => ({ config: demoDb.update('welcome/config', welcomeSeed, (c) => ({ ...c, ...(body ?? {}) })) }));

  const thread = () => demoDb.get('welcome/thread', threadSeed);
  route('GET', `${G}/welcome-thread`, () => ({ config: thread() }));
  route('PATCH', `${G}/welcome-thread`, ({ body }) => ({ config: demoDb.update('welcome/thread', threadSeed, (c) => ({ ...c, ...(body ?? {}), steps: c.steps, pages: c.pages })) }));
  route('PUT', `${G}/welcome-thread/steps`, ({ body }) => {
    const steps = (body?.steps ?? []).map((s: Record<string, unknown>, i: number) => row('WelcomeThreadStep', { ...s, id: (s.id as string) ?? demoId(), order: i }));
    return { config: demoDb.update('welcome/thread', threadSeed, (c) => ({ ...c, steps })), steps };
  });
  route('PUT', `${G}/welcome-thread/pages`, ({ body }) => {
    const pages = (body?.pages ?? []).map((p: Record<string, unknown>, i: number) => row('WelcomeMenuPage', { ...p, id: (p.id as string) ?? demoId(), order: i }));
    return { config: demoDb.update('welcome/thread', threadSeed, (c) => ({ ...c, pages })), pages };
  });

  const base = `${G}/welcome-experiments`;
  route('GET', base, () => {
    const w = welcome();
    return {
      experiments: experiments(),
      welcome: { welcomeEnabled: w.welcomeEnabled, welcomeChannelId: w.welcomeChannelId, welcomeMessage: w.welcomeMessage, welcomeImageEnabled: w.welcomeImageEnabled },
      canEdit: true,
    };
  });
  route('POST', base, ({ body }) => {
    const experiment: Experiment = {
      id: demoId(),
      name: body?.name ?? 'Nouveau test',
      hypothesis: body?.hypothesis ?? null,
      status: 'DRAFT',
      primaryMetric: body?.primaryMetric ?? 'retained_d7',
      variants: (body?.variants ?? []).map((v: Experiment['variants'][number], i: number) => ({ ...v, key: String.fromCharCode(65 + i) })),
      winnerKey: null,
      startedAt: null,
      stoppedAt: null,
      createdAt: new Date().toISOString(),
      assigned: {},
    };
    demoDb.set('welcome/experiments', [experiment, ...experiments()]);
    return { experiment };
  });
  const change = (id: string, patch: Partial<Experiment>) => {
    let experiment: Experiment | undefined;
    demoDb.set('welcome/experiments', experiments().map((e) => (e.id === id ? (experiment = { ...e, ...patch }) : e)));
    return { experiment };
  };
  route('PATCH', `${base}/:id`, ({ params, body }) => change(params.id, body ?? {}));
  route('POST', `${base}/:id/start`, ({ params }) => change(params.id, { status: 'RUNNING', startedAt: new Date().toISOString() }));
  route('POST', `${base}/:id/stop`, ({ params }) => change(params.id, { status: 'STOPPED', stoppedAt: new Date().toISOString() }));
  route('POST', `${base}/:id/ship`, ({ params }) => {
    change(params.id, { status: 'STOPPED', stoppedAt: new Date().toISOString(), winnerKey: 'B' });
    return { ok: true };
  });
  route('DELETE', `${base}/:id`, ({ params }) => {
    demoDb.set('welcome/experiments', experiments().filter((e) => e.id !== params.id));
    return { ok: true };
  });
  route('GET', `${base}/:id/results`, ({ params }) => {
    const e = experiments().find((x) => x.id === params.id);
    return e ? results(e) : new Response(JSON.stringify({ error: 'Introuvable' }), { status: 404 });
  });
}
