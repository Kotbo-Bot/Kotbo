/**
 * Balayage des planifications : le repère de minute murale doit survivre à la
 * DURÉE de l'exécution.
 *
 * Le défaut corrigé ici : `lastRunAt` était écrit avec l'instant où l'exécution
 * se terminait, et non avec la minute où la planification était tombée. Une
 * exécution qui franchit une frontière de minute (départ 02h30, fin 02h31)
 * déplaçait donc le repère d'une minute. La nuit du retour à l'heure d'hiver,
 * l'horloge repasse par 02h30 une heure plus tard : la garde
 * `wallClockMinuteKey` comparait « 02h31 » à « 02h30 », ne reconnaissait plus
 * la minute déjà jouée, et le workflow repartait une seconde fois.
 *
 * Trois écritures portaient le défaut, et chacune a son cas ici : celle des
 * compteurs (exécution normale), celle de la réservation (exécution suspendue
 * par un « Attendre ») et celle de la reprise qui suit l'attente.
 *
 * Préfixe `zz-` : ce fichier remplace `utils/db`, `utils/cache`,
 * `utils/activation` et `services/core/moduleGate` pour tout le process
 * (`mock.module` est global et n'est jamais annulé, même sous `--isolate`).
 * Chargé en dernier, il ne peut plus fausser les suites suivantes.
 */
import { afterAll, describe, expect, mock, setSystemTime, test } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';

const at = (iso: string) => new Date(iso);

/**
 * 2026-10-25, dernier dimanche d'octobre : Paris repasse de 03h CEST à 02h CET
 * à 01h00 UTC. « 02h30 » y tombe une première fois à 00h30 UTC, une seconde à
 * 01h30 UTC.
 */
const PREMIER_PASSAGE = at('2026-10-25T00:30:10.000Z');
const FIN_DU_PREMIER_RUN = at('2026-10-25T00:31:05.000Z');
const FIN_DE_L_ATTENTE = at('2026-10-25T01:00:02.000Z');
const SECOND_PASSAGE = at('2026-10-25T01:30:05.000Z');
const LENDEMAIN = at('2026-10-26T01:30:04.000Z');

interface WorkflowRow {
  id: string;
  guildId: string;
  enabled: boolean;
  triggerEvent: string;
  triggerType: string;
  graph: unknown;
  lastRunAt: Date | null;
}

let row: WorkflowRow;
/** Instant auquel l'exécution en cours est réputée s'achever, s'il y en a un. */
let finDExecution: Date | null = null;
/** Instant auquel le balayage est réputé arriver sur ce workflow. */
let horlogeALaLecture: Date | null = null;
const executionsCreees: Record<string, unknown>[] = [];

const prismaMock = {
  workflow: {
    findMany: mock(async () => {
      // Le balayage peut avoir déjà tourné une minute sur d'autres workflows
      // avant d'arriver ici : la boucle attend chaque exécution avant la
      // suivante. C'est ce décalage-là que voit la réservation.
      if (horlogeALaLecture) setSystemTime(horlogeALaLecture);
      return [{ ...row }];
    }),
    // Réservation conditionnelle, comme la fait Postgres : l'écriture n'a lieu
    // que si la ligne satisfait encore le `where` au moment de l'UPDATE. Un
    // double qui rendrait toujours { count: 1 } ne saurait pas dire non.
    updateMany: mock(async ({ where, data }: any) => {
      const borne = where.OR?.[1]?.lastRunAt?.lt as Date | undefined;
      const libre = row.lastRunAt === null
        || (borne !== undefined && row.lastRunAt.getTime() < borne.getTime());
      if (where.id !== row.id || !libre) return { count: 0 };
      row.lastRunAt = data.lastRunAt;
      return { count: 1 };
    }),
    update: mock(async ({ data }: any) => {
      if (data.lastRunAt !== undefined) row.lastRunAt = data.lastRunAt;
      return { ...row };
    }),
  },
  workflowExecution: {
    create: mock(async ({ data }: any) => {
      executionsCreees.push(data);
      // L'exécution a duré : l'horloge avance entre la réservation de la minute
      // et l'écriture des compteurs, exactement comme en production.
      if (finDExecution) setSystemTime(finDExecution);
      return { id: `exec-${executionsCreees.length}` };
    }),
    update: mock(async () => ({ id: 'exec-1' })),
    updateMany: mock(async () => ({ count: 0 })),
    findMany: mock(async () => []),
  },
  workflowExecutionStep: {
    createMany: mock(async () => ({ count: 0 })),
  },
};

const cacheMock = {
  cache: {
    get: mock(async () => null),
    set: mock(async () => undefined),
    delete: mock(async () => undefined),
    invalidateGuild: mock(async () => undefined),
  },
  // `resolveGuildTimezone` importe ce module à la demande pour lire le fuseau.
  getCachedGuild: mock(async () => ({ timezone: 'Europe/Paris' })),
  getCachedDashboardSettings: mock(async () => null),
};

for (const extension of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db.${extension}`), () => ({
    default: prismaMock,
    prisma: prismaMock,
    prismaRead: prismaMock,
  }));
  mock.module(path.resolve(import.meta.dir, `../../utils/cache.${extension}`), () => cacheMock);
  mock.module(path.resolve(import.meta.dir, `../../utils/activation.${extension}`), () => ({
    isGuildActivated: () => true,
    activatedGuilds: new Set(['g1']),
    loadActivatedGuilds: async () => undefined,
  }));
  mock.module(path.resolve(import.meta.dir, `../../services/core/moduleGate.${extension}`), () => ({
    isModuleEnabled: async () => true,
  }));
}

const { dispatchScheduledWorkflows, persistOutcome } =
  await import('../../services/features/workflow/workflowService.js');

/** Un client Discord réduit à ce que lit le balayage : la liste de ses serveurs. */
function fakeClient(): Client {
  const guild = {
    id: 'g1',
    roles: { cache: new Map(), fetch: async () => null },
    channels: { cache: new Map(), fetch: async () => null },
    members: { cache: new Map(), fetch: async () => null },
  };
  return { guilds: { cache: new Map([['g1', guild]]) } } as unknown as Client;
}

/** Graphe minimal : le déclencheur planifié, sans aucune action. */
function grapheSansAction(cron: string) {
  return {
    nodes: [{ id: 't', type: 'OnSchedule', position: { x: 0, y: 0 }, config: { cron } }],
    edges: [],
  };
}

/**
 * Graphe qui SUSPEND : un nœud « Attendre » rend l'exécution SUSPENDED, donc
 * `persistOutcome` n'écrit pas les compteurs (`if (!suspended)`). La valeur
 * posée à la réservation est alors la SEULE qui reste en base : c'est le seul
 * montage où ce chemin est observable.
 */
function grapheQuiSuspend(cron: string) {
  return {
    nodes: [
      { id: 't', type: 'OnSchedule', position: { x: 0, y: 0 }, config: { cron } },
      { id: 'd', type: 'Delay', position: { x: 0, y: 0 }, config: { seconds: 3600 } },
    ],
    edges: [
      { id: 'e1', source: 't', sourceHandle: 'next', target: 'd', targetHandle: 'exec' },
    ],
  };
}

/** Remet la base et l'horloge à neuf. */
function neuf(graph: unknown = grapheSansAction('30 2 * * *')): void {
  row = {
    id: 'w1',
    guildId: 'g1',
    enabled: true,
    triggerEvent: 'schedule:fired',
    triggerType: 'OnSchedule',
    graph,
    lastRunAt: null,
  };
  executionsCreees.length = 0;
  finDExecution = null;
  horlogeALaLecture = null;
}

afterAll(() => {
  setSystemTime();
});

describe('balayage planifié, nuit du retour à l\'heure d\'hiver', () => {
  test('une exécution qui déborde sur la minute suivante ne fait pas repartir le workflow', async () => {
    // CASSE SI: persistOutcome réécrit `lastRunAt` avec `new Date()`.
    neuf();
    const client = fakeClient();

    // 00h30 UTC = 02h30 CEST. L'exécution dure 55 s et s'achève donc à 02h31.
    setSystemTime(PREMIER_PASSAGE);
    finDExecution = FIN_DU_PREMIER_RUN;
    await dispatchScheduledWorkflows(client, PREMIER_PASSAGE);
    expect(executionsCreees).toHaveLength(1);

    // Seconde traversée de 02h30, une heure plus tard : instant différent, même
    // heure au mur. La CONSÉQUENCE d'abord, c'est elle qui fait mal : les
    // membres reçoivent le message deux fois.
    setSystemTime(SECOND_PASSAGE);
    finDExecution = null;
    await dispatchScheduledWorkflows(client, SECOND_PASSAGE);
    expect(executionsCreees).toHaveLength(1);

    // Puis le mécanisme : le repère mémorisé est la minute où la planification
    // est TOMBÉE, et non celle où l'exécution s'est achevée.
    expect(row.lastRunAt?.toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  test('la réservation elle-même porte le repère, pas l\'horloge', async () => {
    // CASSE SI: la réservation écrit `new Date()` au lieu de `minuteStart`.
    // Le balayage est ici réputé arriver sur ce workflow une minute après son
    // départ, un workflow lent l'ayant précédé dans la même boucle.
    // Le « Attendre » est indispensable : sans lui l'exécution se termine, les
    // compteurs écrivent, et ils corrigeraient la valeur de la réservation :
    // le défaut deviendrait invisible. La porte l'a d'ailleurs attrapé.
    neuf(grapheQuiSuspend('30 2 * * *'));
    const client = fakeClient();

    setSystemTime(PREMIER_PASSAGE);
    horlogeALaLecture = FIN_DU_PREMIER_RUN;
    await dispatchScheduledWorkflows(client, PREMIER_PASSAGE);

    expect(row.lastRunAt?.toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  test('une reprise après un « Attendre » ne déplace pas le repère', async () => {
    // CASSE SI: la reprise réécrit `lastRunAt` avec l'heure où elle s'achève.
    // Attente de 30 min : la reprise finit à 02h00 CET, avant la seconde
    // traversée de 02h30.
    neuf(grapheQuiSuspend('30 2 * * *'));
    const client = fakeClient();

    setSystemTime(PREMIER_PASSAGE);
    await dispatchScheduledWorkflows(client, PREMIER_PASSAGE);
    expect(executionsCreees).toHaveLength(1);

    setSystemTime(FIN_DE_L_ATTENTE);
    await persistOutcome(
      'w1',
      'g1',
      {
        status: 'COMPLETED',
        steps: [],
        state: { stack: [], triggerOutputs: {}, loopValues: {}, nodeVisits: 2, iterations: 0, stepOrder: 2 },
      },
      executionsCreees[0].triggerPayload as Record<string, unknown>,
      'exec-1',
    );
    expect(row.lastRunAt?.toISOString()).toBe('2026-10-25T00:30:00.000Z');

    setSystemTime(SECOND_PASSAGE);
    await dispatchScheduledWorkflows(client, SECOND_PASSAGE);
    expect(executionsCreees).toHaveLength(1);
  });

  test('le lendemain à la même heure murale, le workflow repart bien', async () => {
    // Témoin : la garde doit fermer la minute rejouée, pas la planification.
    // Une garde qui bloquerait tout ferait passer les cas ci-dessus sans rien
    // prouver : elle doit savoir dire oui.
    neuf();
    const client = fakeClient();

    setSystemTime(PREMIER_PASSAGE);
    await dispatchScheduledWorkflows(client, PREMIER_PASSAGE);
    expect(executionsCreees).toHaveLength(1);

    // 01h30 UTC le 26 = 02h30 CET, même heure murale, autre journée.
    setSystemTime(LENDEMAIN);
    await dispatchScheduledWorkflows(client, LENDEMAIN);
    expect(executionsCreees).toHaveLength(2);
  });
});
