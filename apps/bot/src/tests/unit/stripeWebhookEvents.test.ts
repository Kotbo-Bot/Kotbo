import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const source = (relatif: string) => readFileSync(path.resolve(import.meta.dir, relatif), 'utf8');

describe('mise en production Stripe', () => {
  test('le webhook est abonné à exactement les événements que le code traite', () => {
    const abonnes = [...source('../../../../../docs/stripe.md').matchAll(/^\s+- `([a-z_.]+)`$/gm)].map(([, type]) => type);
    const traites = [...source('../../api/hono/routes/billing.ts').matchAll(/case '([a-z_]+\.[a-z_.]+)'/g)].map(([, type]) => type);

    expect(traites).not.toEqual([]);
    expect(abonnes.sort()).toEqual(traites.sort());
  });
});
