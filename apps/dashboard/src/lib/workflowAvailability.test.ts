import { describe, expect, it } from 'bun:test';
import { NODE_CATALOG, TRIGGER_LIBRARY } from '@kotbo/shared';
import { OFFERED_NODE_CATALOG, OFFERED_TRIGGERS, isNodeOffered } from './workflowAvailability';

describe('workflowAvailability', () => {
  it('garde les déclencheurs dont le module tourne', () => {
    expect(isNodeOffered('OnMemberJoin')).toBe(true);
    expect(isNodeOffered('OnTicketCreated')).toBe(true);
    expect(OFFERED_TRIGGERS.some((trigger) => trigger.type === 'OnMemberJoin')).toBe(true);
  });

  it('un nœud inconnu du catalogue reste proposé', () => {
    expect(isNodeOffered('TypeInconnu')).toBe(true);
  });

  it('chaque déclencheur de la bibliothèque existe dans le catalogue', () => {
    for (const trigger of TRIGGER_LIBRARY) {
      expect(NODE_CATALOG.some((def) => def.type === trigger.type)).toBe(true);
    }
  });
});
