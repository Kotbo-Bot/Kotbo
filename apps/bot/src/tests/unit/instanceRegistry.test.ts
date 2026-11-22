import { afterAll, describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// La clé privée réelle vit hors du dépôt : sans elle (CI), on saute les tests
// qui signent plutôt que d'en fabriquer une qui ne correspondrait pas à la clé publique embarquée.
const keyFile = path.resolve(import.meta.dir, '../../../../../.registry-private-key');
const hasKey = fs.existsSync(keyFile);
if (hasKey) process.env.KOTBO_REGISTRY_PRIVATE_KEY = fs.readFileSync(keyFile, 'utf8').trim();

const { signLease, verifyLease, isRegistryIssuer, LEASE_TTL_MS } = await import('../../services/system/instanceRegistry.js');

afterAll(() => {
  delete process.env.KOTBO_REGISTRY_PRIVATE_KEY;
});

describe('verifyLease sans clé privée', () => {
  test('refuse un bail absent ou mal formé', () => {
    expect(verifyLease(null, 'bot', 'fp')).toBe(false);
    expect(verifyLease('', 'bot', 'fp')).toBe(false);
    expect(verifyLease('abc', 'bot', 'fp')).toBe(false);
    expect(verifyLease('a.b.c', 'bot', 'fp')).toBe(false);
  });

  test('refuse un bail signé par une autre clé (faux master)', () => {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const body = Buffer.from(JSON.stringify({ botClientId: 'bot', machineFingerprint: 'fp', exp: Date.now() + 1e6 }));
    const forged = `${body.toString('base64url')}.${crypto.sign(null, body, privateKey).toString('base64url')}`;
    expect(verifyLease(forged, 'bot', 'fp')).toBe(false);
  });
});

describe.skipIf(!hasKey)('bail signé par le master', () => {
  test("le détenteur de la vraie clé est reconnu comme émetteur", () => {
    expect(isRegistryIssuer()).toBe(true);
  });

  test('un bail valide passe', () => {
    expect(verifyLease(signLease('bot', 'fp'), 'bot', 'fp')).toBe(true);
  });

  test("refuse un bail délivré à une autre instance", () => {
    expect(verifyLease(signLease('bot', 'fp'), 'autre', 'fp')).toBe(false);
  });

  test("refuse un bail d'une autre installation (empreinte différente)", () => {
    expect(verifyLease(signLease('bot', 'fp'), 'bot', 'autre-fp')).toBe(false);
  });

  test('refuse un bail expiré', () => {
    const now = Date.now();
    const lease = signLease('bot', 'fp', now);
    expect(verifyLease(lease, 'bot', 'fp', now + LEASE_TTL_MS + 1)).toBe(false);
  });

  test('refuse un bail dont le contenu a été modifié', () => {
    const [, sig] = signLease('bot', 'fp').split('.');
    const body = Buffer.from(JSON.stringify({ botClientId: 'bot', machineFingerprint: 'fp', exp: Date.now() + 9e12 }));
    expect(verifyLease(`${body.toString('base64url')}.${sig}`, 'bot', 'fp')).toBe(false);
  });
});
