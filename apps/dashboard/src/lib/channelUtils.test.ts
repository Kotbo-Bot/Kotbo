import { describe, expect, test } from 'bun:test';
import { exemptionOptions } from './channelUtils';

describe('exemptionOptions', () => {
  const channels = [{ id: 'c1', name: 'general', type: 'text' }];
  const categories = [{ id: 'k1', name: 'Tickets' }];

  test('propose les catégories avant les salons (#778)', () => {
    expect(exemptionOptions(channels, categories).map((o) => o.id)).toEqual(['k1', 'c1']);
  });

  test('une catégorie s\'écrit en capitales, comme dans Discord', () => {
    expect(exemptionOptions([], categories)[0].name).toBe('TICKETS');
  });

  test('un salon garde son libellé habituel', () => {
    expect(exemptionOptions(channels, [])[0].name).toBe('# general');
  });
});
