import { describe, expect, test } from 'bun:test';
import type { lookup } from 'node:dns/promises';
import { guardedLookup } from '../../services/integrations/outgoingWebhookSecurity.js';

const resolver = (addresses: Array<{ address: string; family: number }>) =>
  (async () => addresses) as unknown as typeof lookup;

function run(addresses: Array<{ address: string; family: number }>, options: { all?: boolean } = {}) {
  return new Promise<{ err: Error | null; address?: unknown }>((resolve) => {
    guardedLookup('hook.example', options, (err, address) => resolve({ err, address }), resolver(addresses));
  });
}

describe('guardedLookup (connexion des webhooks sortants)', () => {
  test('renvoie l\'adresse publique résolue', async () => {
    const { err, address } = await run([{ address: '93.184.216.34', family: 4 }]);
    expect(err).toBeNull();
    expect(address).toBe('93.184.216.34');
  });

  test('refuse une adresse interne au moment de la connexion', async () => {
    const { err } = await run([{ address: '10.0.0.5', family: 4 }]);
    expect(err?.message).toContain('réseau interne');
  });

  test('refuse dès qu\'une des adresses est interne, même mêlée à une publique', async () => {
    const { err } = await run([{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }]);
    expect(err).not.toBeNull();
  });

  test('refuse une adresse IPv6 locale et la liste vide', async () => {
    expect((await run([{ address: 'fd00::1', family: 6 }])).err).not.toBeNull();
    expect((await run([])).err).not.toBeNull();
  });

  test('rend la liste complète quand `all` est demandé', async () => {
    const { err, address } = await run([{ address: '93.184.216.34', family: 4 }], { all: true });
    expect(err).toBeNull();
    expect(address).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });
});
