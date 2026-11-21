import { describe, expect, test } from 'bun:test';
import { forgiving } from './backend';

describe('forgiving', () => {
  test('une page qui lit plus loin que le repli obtient du vide, pas une erreur', () => {
    const res = forgiving({});
    expect(res.config.exemptRoleIds.length).toBe(0);
    expect(res.moderation.fleet.blocks > 0).toBe(false);
    expect([...res.pending]).toEqual([]);
    expect(res.webhooks.map((w: unknown) => w)).toEqual([]);
    expect(`${res.name}`).toBe('');
  });

  test('les valeurs réellement présentes passent telles quelles', () => {
    const res = forgiving({ items: [{ id: 'a' }], count: 3, label: 'x' });
    expect(res.items[0].id).toBe('a');
    expect(res.count).toBe(3);
    expect(res.label).toBe('x');
    expect(JSON.parse(JSON.stringify(res))).toEqual({ items: [{ id: 'a' }], count: 3, label: 'x' });
  });

  test('n’a pas l’air d’une promesse', async () => {
    expect(await Promise.resolve(forgiving({ ok: true }))).toMatchObject({ ok: true });
  });
});
