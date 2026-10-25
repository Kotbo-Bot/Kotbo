import { describe, expect, test } from 'bun:test';
import type { ServerTemplatePlanItem, ServerTemplateState } from '../api/serverTemplateTypes';
import { defaultMapping } from './mapping';

const plan = [
  { key: 'tickets.panel', section: 'tickets', kind: 'text', name: 'ouvrir-un-ticket' },
  { key: 'tickets.logs', section: 'tickets', kind: 'text', name: 'logs-tickets' },
] as ServerTemplatePlanItem[];

const inventory: ServerTemplateState['inventory'] = {
  channels: [{ id: '111111', name: 'support', kind: 'text', parentId: null, position: 0 }],
  roles: [],
};

describe('defaultMapping', () => {
  test("une adoption dont le salon a disparu repart sur la detection", () => {
    const next = defaultMapping(plan, 'communaute', {}, inventory, {
      'tickets.panel': { mode: 'adopt', id: '111111' },
      'tickets.logs': { mode: 'adopt', id: '999999' },
    });
    expect(next['tickets.panel']).toEqual({ mode: 'adopt', id: '111111' });
    expect(next['tickets.logs']).toEqual({ mode: 'create', id: null });
  });

  test('une adoption reconnue par le bot hors inventaire est gardee', () => {
    const next = defaultMapping(
      plan,
      'communaute',
      { 'tickets.logs': { id: '999999', name: 'logs-tickets', source: 'ref' } },
      inventory,
      { 'tickets.logs': { mode: 'adopt', id: '999999' } },
    );
    expect(next['tickets.logs']).toEqual({ mode: 'adopt', id: '999999' });
  });
});
