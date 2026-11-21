/**
 * Déclencheurs (workflows). Les scénarios de la démo sont les modèles proposés
 * par le dashboard (`workflowTemplates.ts`), avec un historique d'exécutions.
 * Le déclencheur et son événement sont lus dans le graphe, comme côté bot.
 */
import { getNodeDef, type WorkflowGraph } from '@kotbo/shared';
import { route } from '../backend';
import { demoDb, demoId } from '../db';
import { G } from '../crud';
import { DAY, HOUR, ago } from '../fixtures';
import { WORKFLOW_TEMPLATES } from '../../components/workflows/workflowTemplates';

function triggerOf(graph: WorkflowGraph) {
  const node = graph.nodes.find((n) => getNodeDef(n.type)?.category === 'trigger');
  return { triggerType: node?.type ?? 'OnMemberJoin', triggerEvent: (node && getNodeDef(node.type)?.event) || 'member:join' };
}

type Workflow = ReturnType<typeof make>;

function make(id: string, name: string, description: string | null, graph: WorkflowGraph, extra: Partial<{ enabled: boolean; runCount: number; failureCount: number; lastRunAt: string | null; lastError: string | null }> = {}) {
  const runCount = extra.runCount ?? 0;
  const failureCount = extra.failureCount ?? 0;
  return {
    id,
    name,
    description,
    enabled: extra.enabled ?? true,
    ...triggerOf(graph),
    runCount,
    successCount: runCount - failureCount,
    failureCount,
    lastRunAt: extra.lastRunAt ?? null,
    lastError: extra.lastError ?? null,
    updatedAt: ago(3 * DAY),
    graph,
  };
}

function seed(): Workflow[] {
  const stats = [
    { runCount: 312, lastRunAt: ago(40) },
    { runCount: 298, failureCount: 4, lastRunAt: ago(40), lastError: 'Le membre a fermé ses MP.' },
    { runCount: 57, lastRunAt: ago(5 * HOUR) },
    { runCount: 18, lastRunAt: ago(2 * DAY), enabled: false },
  ];
  return WORKFLOW_TEMPLATES.slice(0, 6).map((t, i) => make(`wf-${i + 1}`, t.name, t.description, t.graph, stats[i] ?? { runCount: 4 + i * 3, lastRunAt: ago((i + 1) * DAY) }));
}

const workflows = () => demoDb.get('workflows', seed);
const save = (list: Workflow[]) => demoDb.set('workflows', list);
const summary = ({ graph, ...w }: Workflow) => w;

function executions(list: Workflow[]) {
  return list.filter((w) => w.runCount > 0).flatMap((w, i) =>
    Array.from({ length: 3 }, (_, j) => {
      const failed = w.failureCount > 0 && j === 0;
      const startedAt = ago(40 + i * 90 + j * 240);
      return {
        id: `${w.id}-run${j}`, workflowId: w.id, status: failed ? 'FAILED' : 'COMPLETED', error: failed ? w.lastError : null, nodeVisits: w.graph.nodes.length,
        iterations: 1, resumeAt: null, startedAt, completedAt: startedAt, failedStep: failed ? w.graph.nodes[w.graph.nodes.length - 1]?.id ?? null : null,
      };
    }),
  ).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function steps(w: Workflow, failed: boolean) {
  return w.graph.nodes.map((n, i) => {
    const last = i === w.graph.nodes.length - 1;
    return {
      id: `${w.id}-step${i}`, order: i, nodeId: n.id, nodeType: n.type, status: failed && last ? 'ERROR' : 'OK',
      inputs: n.config ?? {}, outputs: { ok: !(failed && last) }, error: failed && last ? w.lastError : null, durationMs: 12 + i * 18,
    };
  });
}

export function registerWorkflowRoutes(): void {
  const base = `${G}/workflows`;
  route('GET', base, () => ({ workflows: workflows().map(summary) }));
  route('GET', `${base}/executions`, ({ query }) => {
    const id = query.get('workflowId');
    return { executions: executions(workflows()).filter((e) => !id || e.workflowId === id) };
  });
  route('GET', `${base}/executions/:executionId`, ({ params }) => {
    const execution = executions(workflows()).find((e) => e.id === params.executionId);
    const w = execution && workflows().find((x) => x.id === execution.workflowId);
    return { execution: execution && w ? { ...execution, steps: steps(w, execution.status === 'FAILED') } : null };
  });
  route('POST', `${base}/validate`, () => ({ issues: [] }));
  route('POST', `${base}/test`, ({ body }) => {
    const graph: WorkflowGraph = body?.graph ?? { nodes: [], edges: [] };
    return {
      test: {
        status: 'COMPLETED',
        source: 'sample',
        error: null,
        steps: graph.nodes.map((n, i) => ({ order: i, nodeId: n.id, nodeType: n.type, status: 'OK', inputs: n.config ?? {}, outputs: { ok: true }, durationMs: 10 + i * 15 })),
      },
    };
  });
  route('POST', base, ({ body }) => {
    const workflow = make(demoId(), body?.name ?? 'Nouveau déclencheur', body?.description ?? null, body?.graph ?? { nodes: [], edges: [] }, { enabled: body?.enabled ?? true });
    save([workflow, ...workflows()]);
    return { workflow, warnings: [] };
  });
  route('GET', `${base}/:workflowId`, ({ params }) => ({ workflow: workflows().find((w) => w.id === params.workflowId) ?? null }));
  route('PUT', `${base}/:workflowId`, ({ params, body }) => {
    let workflow: Workflow | undefined;
    save(workflows().map((w) => {
      if (w.id !== params.workflowId) return w;
      const graph = body?.graph ?? w.graph;
      workflow = { ...w, ...(body ?? {}), graph, ...triggerOf(graph), updatedAt: new Date().toISOString() };
      return workflow;
    }));
    return { workflow, warnings: [] };
  });
  route('POST', `${base}/:workflowId/toggle`, ({ params, body }) => {
    save(workflows().map((w) => (w.id === params.workflowId ? { ...w, enabled: body?.enabled ?? !w.enabled } : w)));
    return { success: true };
  });
  route('DELETE', `${base}/:workflowId`, ({ params }) => {
    save(workflows().filter((w) => w.id !== params.workflowId));
    return { success: true };
  });
}
