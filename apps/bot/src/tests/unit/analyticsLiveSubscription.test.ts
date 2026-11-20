import { describe, expect, mock, spyOn, test } from 'bun:test';
import path from 'node:path';
import { completeModuleMock } from '../helpers/moduleMock.js';

function mockerModule(relatif: string, overrides: Record<string, unknown> = {}, source = `${relatif}.ts`): void {
  for (const suffixe of ['.ts', '.js']) {
    mock.module(path.resolve(import.meta.dir, `${relatif}${suffixe}`), () => completeModuleMock(path.resolve(import.meta.dir, source), overrides));
  }
}

let autoriser: (access: { canViewDashboard: boolean }) => void = () => undefined;
const addLiveSubscriber = mock();
const removeLiveSubscriber = mock();
const rien = () => undefined;

mockerModule('../../utils/db', { default: {}, prisma: {}, prismaRead: {} });
// api/shared.ts ne fait que réexporter (`export *`) : les noms sont lus dans core.ts.
mockerModule('../../api/shared', {
  getDiscordClientId: () => 'client',
  setDashboardStateBroadcaster: rien,
  setDashboardEventBroadcaster: rien,
  collectShardGuilds: rien,
  resolveDashboardAccess: () => new Promise((resolve) => { autoriser = resolve; }),
}, '../../api/shared/core.ts');
mockerModule('../../api/hono/app', { createHonoApp: rien });
mockerModule('../../api/mcp/mcpServer');
mockerModule('../../api/routes/dashboard/featureGate', { canViewFeatureSection: async () => true });
mockerModule('../../services/system/customDomain', { startCustomDomainSync: rien });
mockerModule('../../services/system/broadcastService', { startBroadcastScheduler: rien });
mockerModule('../../services/site/siteRights');
mockerModule('../../services/site/siteLive', { setSiteLivePublisher: rien });
mockerModule('../../services/analytics/analyticsLiveService', {
  addLiveSubscriber,
  removeLiveSubscriber,
  liveTopic: (guildId: string) => `live:${guildId}`,
  liveSnapshot: () => ({}),
  startLivePublisher: rien,
});

const { setCurrentInstance } = await import('../../utils/instanceContext.js');
const { startDashboardApi } = await import('../../api/dashboardApi.js');

type Handlers = { message: (ws: unknown, data: string) => Promise<void>; close: (ws: unknown) => void };

describe('temps réel d\'Analytics', () => {
  test('un socket fermé pendant la vérification des droits ne laisse aucun abonné compté', async () => {
    const serve = spyOn(Bun, 'serve').mockReturnValue({} as never);
    setCurrentInstance({ apiPort: 0 } as never);
    await startDashboardApi({ on: rien } as never);
    const { websocket } = serve.mock.calls[0][0] as unknown as { websocket: Handlers };

    const ws = { data: { userId: 'membre' }, subscribe: mock(), unsubscribe: mock(), send: mock() };
    const abonnement = websocket.message(ws, JSON.stringify({ type: 'analytics_live_subscribe', guildId: '987654321098765432' }));
    websocket.close(ws);
    autoriser({ canViewDashboard: true });
    await abonnement;

    expect(addLiveSubscriber.mock.calls.length).toBe(removeLiveSubscriber.mock.calls.length);
  });
});
