import { describe, expect, it } from 'bun:test';
import { NODE_CATALOG, TRIGGER_LIBRARY } from '@kotbo/shared';
import { isModulePaused } from '@kotbo/contracts';
import { OFFERED_NODE_CATALOG, OFFERED_TRIGGERS, isNodeOffered } from './workflowAvailability';

describe('workflowAvailability', () => {
  it('ne propose plus les déclencheurs des partenariats, en pause', () => {
    const offered = OFFERED_TRIGGERS.map((trigger) => trigger.type);
    expect(offered).not.toContain('OnPartnershipStage');
    expect(offered).not.toContain('OnPartnershipCommitmentFailed');
    expect(offered).not.toContain('OnPartnershipReferral');
    expect(OFFERED_NODE_CATALOG.some((def) => def.type.startsWith('OnPartnership'))).toBe(false);
  });

  it('garde les déclencheurs dont le module tourne', () => {
    expect(isNodeOffered('OnMemberJoin')).toBe(true);
    expect(isNodeOffered('OnTicketCreated')).toBe(true);
    expect(OFFERED_TRIGGERS.some((trigger) => trigger.type === 'OnMemberJoin')).toBe(true);
  });

  it('ne retire que les nœuds rattachés à un module en pause', () => {
    const removed = NODE_CATALOG.filter((def) => !OFFERED_NODE_CATALOG.includes(def));
    expect(removed.length).toBeGreaterThan(0);
    for (const def of removed) {
      expect(def.module).toBeDefined();
      expect(isModulePaused(def.module)).toBe(true);
    }
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
