import { beforeAll, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { installDemoBackend, listDemoRoutes } from '../backend';
import { CHANNELS, PEOPLE, ROLES } from '../fixtures';
import { DEMO_GUILD_ID } from '../mode';
import { registerDemoRoutes } from './index';

const PARAM_VALUES: Record<string, string> = {
  guildId: DEMO_GUILD_ID,
  targetGuildId: '900000000000000099',
  userId: PEOPLE[0].id,
  memberId: PEOPLE[0].id,
  staffId: PEOPLE[1].id,
  channelId: CHANNELS[0].id,
  categoryId: '900000000000000301',
  roleId: ROLES[0].id,
  code: 'atelier-nova',
  moduleId: 'tickets',
  featureKey: 'tickets',
  tierKey: 'warn',
  eventType: 'MESSAGE_DELETE',
  source: 'code',
  type: 'text',
  key: 'welcome',
  decision: 'approve',
};

function materializePath(path: string): { url: string; hasSyntheticId: boolean } {
  let hasSyntheticId = false;
  const resolved = path
    .replace(/\/\*$/, '/overview')
    .replace(/:(\w+)/g, (_, key: string) => {
      if (key in PARAM_VALUES) return PARAM_VALUES[key];
      hasSyntheticId = true;
      return `${key}-1`;
    });
  return { url: `https://kotbo.fr${resolved}`, hasSyntheticId };
}

/**
 * Vérifie qu'aucune liste d'objets ne contient de valeurs vides ou dupliquées
 * sur sa clé primaire (`id`, ou `code` / `slug` quand `id` est absent).
 */
function findDuplicatePrimaryKey(value: unknown, trail = 'root'): string | null {
  if (Array.isArray(value)) {
    if (value.length > 1 && value.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))) {
      const items = value as Array<Record<string, unknown>>;
      const key = (['id', 'code', 'slug'] as const).find((k) => items.every((item) => k in item));
      if (key) {
        const seen = new Set<unknown>();
        for (const item of items) {
          const val = item[key];
          if (val === undefined || val === null || val === '') {
            return `${trail}[] a un champ "${key}" vide/undefined`;
          }
          if (seen.has(val)) {
            return `${trail}[] a un champ "${key}" dupliqué (${String(val)})`;
          }
          seen.add(val);
        }
      }
    }
    for (let i = 0; i < value.length; i++) {
      const nested = findDuplicatePrimaryKey(value[i], `${trail}[${i}]`);
      if (nested) return nested;
    }
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const nested = findDuplicatePrimaryKey(v, `${trail}.${k}`);
      if (nested) return nested;
    }
  }
  return null;
}

beforeAll(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://kotbo.fr/demo/' });
  const g = globalThis as Record<string, unknown>;
  for (const key of ['window', 'document', 'localStorage']) {
    g[key] ??= (dom.window as unknown as Record<string, unknown>)[key];
  }
  (window as unknown as { fetch: typeof fetch }).fetch ??= globalThis.fetch;
  registerDemoRoutes();
  installDemoBackend();
});

describe('routes GET de la démo', () => {
  test('toutes les routes GET enregistrées répondent sans erreur serveur ni doublon de clé', async () => {
    const getRoutes = listDemoRoutes().filter((r) => r.method === 'GET');
    expect(getRoutes.length).toBeGreaterThan(50);

    const failures: string[] = [];
    for (const r of getRoutes) {
      const { url, hasSyntheticId } = materializePath(r.path);
      const res = await window.fetch(url);
      if (res.status >= 500) {
        failures.push(`${r.path} -> HTTP ${res.status}`);
        continue;
      }
      if (!hasSyntheticId && res.status !== 200) {
        failures.push(`${r.path} -> HTTP ${res.status} attendu 200`);
        continue;
      }
      if (res.status !== 200) continue;

      let data: unknown;
      try {
        data = await res.json();
      } catch (err) {
        failures.push(`${r.path} -> JSON invalide (${String(err)})`);
        continue;
      }
      if (data === null || data === undefined) {
        failures.push(`${r.path} -> réponse vide`);
        continue;
      }
      const dup = findDuplicatePrimaryKey(data, r.path);
      if (dup) failures.push(dup);
    }

    expect(failures).toEqual([]);
  });

  test('détail d’une invitation : topCodes et survival respectent le contrat de InviteDetailsModal', async () => {
    const res = await window.fetch(`https://kotbo.fr/api/dashboard/guilds/${DEMO_GUILD_ID}/invitations/lina-et-cie?days=30`);
    expect(res.status).toBe(200);
    const data = await res.json() as {
      ranking: { topCodes: Array<{ code: string; joins: number }> };
      retention: { survival: Record<'d1' | 'd7' | 'd30', { rate: number | null; eligible: number }> };
    };

    expect(data.ranking.topCodes.length).toBeGreaterThan(0);
    for (const row of data.ranking.topCodes) {
      expect(typeof row.code).toBe('string');
      expect(row.code.length).toBeGreaterThan(0);
      expect(typeof row.joins).toBe('number');
    }

    for (const bucket of ['d1', 'd7', 'd30'] as const) {
      expect(typeof data.retention.survival[bucket]).toBe('object');
      expect(typeof data.retention.survival[bucket].eligible).toBe('number');
    }
  });
});
