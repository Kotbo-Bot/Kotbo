import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodeCron from 'node-cron';
import type { Client } from 'discord.js';
import type { Hono } from 'hono';
import { completeModuleMock } from '../helpers/moduleMock.js';

const GUILD_ID = '111111111111111111';

type Ligne = { id: string; guildId: string; name: string; type: string; cron: string; targetId: string | null; enabled: boolean; message?: string };

/** Table `scheduledTask` en mémoire : chaque lecture rend une copie. */
const taches = new Map<string, Ligne>();
let prochainId = 0;

const fauxPrisma = {
  // Journal des écritures du dashboard.
  dashboardAuditLog: { create: async () => ({}) },
  scheduledTask: {
    create: mock(async ({ data }: { data: Omit<Ligne, 'id'> }) => {
      const ligne = { id: `tache-${++prochainId}`, ...data };
      taches.set(ligne.id, ligne);
      return { ...ligne };
    }),
    findMany: mock(async ({ where }: { where: { enabled: boolean } }) =>
      [...taches.values()].filter((ligne) => ligne.enabled === where.enabled).map((ligne) => ({ ...ligne }))),
    findFirst: mock(async ({ where }: { where: { id: string; guildId: string } }) => {
      const ligne = taches.get(where.id);
      return ligne && ligne.guildId === where.guildId ? { ...ligne } : null;
    }),
    findUnique: mock(async ({ where }: { where: { id: string } }) => {
      const ligne = taches.get(where.id);
      return ligne ? { ...ligne } : null;
    }),
    update: mock(async ({ where, data }: { where: { id: string }; data: Partial<Ligne> }) => {
      const ligne = { ...taches.get(where.id)!, ...data };
      taches.set(where.id, ligne);
      return { ...ligne };
    }),
    delete: mock(async ({ where }: { where: { id: string } }) => {
      const ligne = taches.get(where.id);
      taches.delete(where.id);
      return ligne;
    }),
  },
};

for (const suffixe of ['.ts', '.js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db${suffixe}`), () =>
    completeModuleMock(path.resolve(import.meta.dir, '../../utils/db.ts'), {
      default: fauxPrisma,
      prisma: fauxPrisma,
      prismaRead: fauxPrisma,
    }));
}

/** Un cron planifié par le service, tel que node-cron l'aurait rendu ; `tick` joue une échéance. */
type FauxCron = { expression: string; tick: () => Promise<void>; stop: ReturnType<typeof mock> };
const crons: FauxCron[] = [];
// Seul `schedule` est doublé : le vrai scheduleService planifie, sans minuterie.
const fauxNodeCron = {
  validate: nodeCron.validate,
  schedule: (expression: string, tick: () => Promise<void>) => {
    const job: FauxCron = { expression, tick, stop: mock(() => undefined) };
    crons.push(job);
    return job;
  },
};
mock.module('node-cron', () => ({ default: fauxNodeCron, ...fauxNodeCron }));

// Dashboard : session, garde du serveur et offre simulées, seule la route est testée.
const admin = { level: 'admin', canViewDashboard: true, canManageSettings: true, canModerateContent: true };
for (const [module, overrides] of [
  ['api/auth/sessionStore', { sessionIdFromCookieHeader: () => 'sid', getDashboardSession: async () => ({ userId: '222222222222222222', username: 'admin' }) }],
  ['api/routes/dashboard/guildGate', { auditGlobalAdminWrite: async () => {}, evaluateGuildGate: async () => ({ denied: null, access: admin, effectiveAccess: admin }) }],
  ['services/system/planService', { getGuildPlan: async () => 'PLUS' }],
] as const) {
  for (const suffixe of ['.ts', '.js']) {
    mock.module(path.resolve(import.meta.dir, `../../${module}${suffixe}`), () =>
      completeModuleMock(path.resolve(import.meta.dir, `../../${module}.ts`), overrides));
  }
}
const { createSchedulesRouter } = await import('../../api/routes/dashboard/schedules.js');

const { registerWriteCommunityNewTools } = await import('../../api/mcp/tools/write-community-new.js');
const { initializeScheduler } = await import('../../services/system/scheduleService.js');

type Resultat = { isError?: boolean; content: Array<{ text: string }> };
const outils = new Map<string, (args: Record<string, unknown>) => Promise<Resultat>>();
const client = {} as Client;

registerWriteCommunityNewTools({
  server: {
    registerTool: (name: string, _config: unknown, handler: unknown) => {
      outils.set(name, handler as (args: Record<string, unknown>) => Promise<Resultat>);
    },
  },
  guildId: GUILD_ID,
  client,
  shouldRegister: () => true,
  guard: (_permission: unknown, handler: unknown) => handler,
  audit: async () => undefined,
} as never);

function outil(nom: string) {
  const handler = outils.get(nom);
  if (!handler) throw new Error(`outil ${nom} non enregistré`);
  return handler;
}

/** Une tâche active en base, planifiée comme au démarrage du bot. */
async function tacheEnCours(cron = '0 3 * * *'): Promise<{ id: string; job: FauxCron }> {
  const ligne: Ligne = {
    id: `tache-${++prochainId}`,
    guildId: GUILD_ID,
    name: 'Sauvegarde nocturne',
    type: 'SERVER_BACKUP',
    cron,
    targetId: null,
    enabled: true,
  };
  taches.set(ligne.id, ligne);
  await initializeScheduler(client);
  const job = crons.at(-1)!;
  expect(job.expression).toBe(cron);
  return { id: ligne.id, job };
}

/**
 * Un second shard dans ce processus : `broadcastEval` y exécute le script sérialisé,
 * sans accès à la portée locale, et les modules qu'il importe par leur URL y sont
 * rechargés sous une autre, avec leur propre mémoire. La base reste partagée.
 */
const SHARD_1 = '?shard=1';
const versShard1 = (contexte: Record<string, unknown>) => Object.fromEntries(Object.entries(contexte).map(([cle, valeur]) =>
  [cle, typeof valeur === 'string' && valeur.startsWith('file:') ? `${fileURLToPath(valeur)}${SHARD_1}` : valeur]));
const clientShard1 = {} as Client;
const deuxShards = {
  broadcastEval: (script: unknown, { context }: { context: Record<string, unknown> }) =>
    Promise.all([context, versShard1(context)].map((contexte, shard) => (0, eval)(`(${script})`)([client, clientShard1][shard], contexte))),
};

const salon = { isTextBased: () => true, send: mock(async () => ({})) };
const serveur = { id: GUILD_ID, name: 'Serveur', channels: { fetch: async () => salon } };
/** Seul ce shard a le serveur en cache ; l'API REST, elle, le rend à tous. */
function serveurSurLeShard(shard: 0 | 1): void {
  [client, clientShard1].forEach((shardClient, i) => Object.assign(shardClient, {
    guilds: { cache: new Map<string, unknown>(i === shard ? [[GUILD_ID, serveur]] : []), fetch: async () => serveur },
  }));
}

/** Un message programmé actif au démarrage des deux shards, pour un serveur du shard 1. */
async function tacheSurLeShard1(): Promise<{ id: string; job: FauxCron }> {
  serveurSurLeShard(1);
  const id = `tache-${++prochainId}`;
  taches.set(id, { id, guildId: GUILD_ID, name: 'Rappel', type: 'SEND_MESSAGE', cron: '0 9 * * *', targetId: '333333333333333333', enabled: true, message: 'Bonjour' });
  const shard1 = await import(`${path.resolve(import.meta.dir, '../../services/system/scheduleService.ts')}${SHARD_1}`);
  await initializeScheduler(client);
  await shard1.initializeScheduler(clientShard1);
  // Le shard 1 seul la planifie.
  expect(crons).toHaveLength(1);
  return { id, job: crons[0] };
}

async function surDeuxShards(action: () => Promise<unknown>): Promise<void> {
  Object.assign(client, { shard: deuxShards });
  try {
    await action();
  } finally {
    delete (client as { shard?: unknown }).shard;
  }
}

/** Une écriture du dashboard, servi lui aussi par le seul shard 0. */
async function ecrireDepuisDashboard(routeur: (client: Client) => Hono, method: string, chemin: string, corps?: unknown): Promise<void> {
  Object.assign(client, { guilds: { cache: new Map([[GUILD_ID, {}]]) } });
  const res = await routeur(client).request(`/api/dashboard/guilds/${GUILD_ID}${chemin}`, {
    method,
    headers: { cookie: 'kotbo_session=x', 'content-type': 'application/json' },
    body: corps === undefined ? undefined : JSON.stringify(corps),
  });
  expect(res.status).toBe(200);
}

beforeEach(async () => {
  serveurSurLeShard(0);
  taches.clear();
  // Vide la mémoire du planificateur entre deux cas.
  await initializeScheduler(client);
  crons.length = 0;
  fauxPrisma.scheduledTask.create.mockClear();
  fauxPrisma.scheduledTask.update.mockClear();
});

describe('tâches planifiées écrites par MCP ou le dashboard', () => {
  test('une tâche créée est planifiée tout de suite, sans attendre un redémarrage', async () => {
    const resultat = await outil('create_scheduled_task')({ name: 'Sauvegarde', type: 'SERVER_BACKUP', cron: '0 3 * * *' });

    expect(resultat.isError).toBeFalsy();
    expect(crons.map((job) => job.expression)).toEqual(['0 3 * * *']);
  });

  test('désactiver une tâche arrête son cron', async () => {
    const { id, job } = await tacheEnCours();

    const resultat = await outil('update_scheduled_task')({ task_id: id, enabled: false });

    expect(resultat.isError).toBeFalsy();
    expect(job.stop).toHaveBeenCalledTimes(1);
    expect(crons).toHaveLength(1);
  });

  test('changer le cron replanifie la tâche sur la nouvelle expression', async () => {
    const { id, job } = await tacheEnCours('0 3 * * *');

    await outil('update_scheduled_task')({ task_id: id, cron: '*/5 * * * *' });

    expect(job.stop).toHaveBeenCalledTimes(1);
    expect(crons.at(-1)?.expression).toBe('*/5 * * * *');
    expect(crons.at(-1)?.stop).not.toHaveBeenCalled();
  });

  test('supprimer une tâche arrête son cron', async () => {
    const { id, job } = await tacheEnCours();

    const resultat = await outil('delete_scheduled_task')({ task_id: id });

    expect(resultat.isError).toBeFalsy();
    expect(job.stop).toHaveBeenCalledTimes(1);
    expect(taches.has(id)).toBe(false);
  });

  test('une expression cron invalide est refusée à la création, sans rien écrire', async () => {
    const resultat = await outil('create_scheduled_task')({ name: 'Cassée', type: 'SERVER_BACKUP', cron: 'tous les jours' });

    expect(resultat.isError).toBe(true);
    expect(fauxPrisma.scheduledTask.create).not.toHaveBeenCalled();
    expect(taches.size).toBe(0);
  });

  test('une expression cron invalide est refusée à la modification, la tâche reste intacte', async () => {
    const { id, job } = await tacheEnCours('0 3 * * *');

    const resultat = await outil('update_scheduled_task')({ task_id: id, cron: '99 99 * * *' });

    expect(resultat.isError).toBe(true);
    expect(fauxPrisma.scheduledTask.update).not.toHaveBeenCalled();
    expect(taches.get(id)?.cron).toBe('0 3 * * *');
    expect(job.stop).not.toHaveBeenCalled();
  });

  test('une tâche ne se planifie et ne s’exécute que sur le shard qui a son serveur', async () => {
    const { id, job } = await tacheSurLeShard1();

    await job.tick();
    // Le shard 0 obtiendrait le serveur par l'API REST, mais ne l'a pas en cache.
    const { executeSchedule } = await import('../../services/system/scheduleService.js');
    await executeSchedule(client, id);

    expect(salon.send).toHaveBeenCalledTimes(1);
  });

  test('désactiver une tâche arrête son cron sur le shard de son serveur, pas seulement celui de MCP', async () => {
    const { id, job } = await tacheSurLeShard1();

    await surDeuxShards(() => outil('update_scheduled_task')({ task_id: id, enabled: false }));

    expect(job.stop).toHaveBeenCalledTimes(1);
  });

  test('supprimer une tâche arrête son cron sur le shard de son serveur', async () => {
    const { id, job } = await tacheSurLeShard1();

    await surDeuxShards(() => outil('delete_scheduled_task')({ task_id: id }));

    expect(job.stop).toHaveBeenCalledTimes(1);
  });

  const dashboard = (method: string, chemin: string, corps?: unknown) => ecrireDepuisDashboard(createSchedulesRouter, method, chemin, corps);

  test('une tâche créée depuis le dashboard n’est planifiée que sur le shard de son serveur', async () => {
    await surDeuxShards(() => dashboard('POST', '/schedules', { name: 'Sauvegarde', type: 'SERVER_BACKUP', cron: '0 3 * * *' }));

    expect(crons.map((job) => job.expression)).toEqual(['0 3 * * *']);
  });

  test('désactiver ou supprimer une tâche depuis le dashboard arrête son cron', async () => {
    const desactivee = await tacheEnCours();
    await surDeuxShards(() => dashboard('PATCH', `/schedules/${desactivee.id}`, { enabled: false }));
    expect(desactivee.job.stop).toHaveBeenCalledTimes(1);

    const supprimee = await tacheEnCours();
    await surDeuxShards(() => dashboard('DELETE', `/schedules/${supprimee.id}`));
    expect(supprimee.job.stop).toHaveBeenCalledTimes(1);
    expect(taches.has(supprimee.id)).toBe(false);
  });
});
