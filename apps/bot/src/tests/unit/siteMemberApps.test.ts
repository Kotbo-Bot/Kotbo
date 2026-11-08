/**
 * Espace membre en apps : les pages virtuelles portent l'app et l'identifiant
 * de la fiche, et une app dont les modules sont éteints disparaît.
 */
import { describe, expect, test } from 'bun:test';
// sitePages d'abord : il charge le registre des blocs dans le bon ordre.
import { memberPageId, virtualDocument } from '../../services/site/sitePages.js';
import { availableApps } from '../../services/site/blocks/memberAppBlocks.js';
import type { SiteNode } from '@kotbo/shared';

const ID = 'ckabcdefghijklmnopqrstuv';

function memberAppConfigs(pageId: string): Array<Record<string, unknown>> {
  const doc = virtualDocument(pageId);
  const found: Array<Record<string, unknown>> = [];
  const visit = (node: SiteNode) => {
    if (node.type === 'module' && node.attrs?.module === 'memberApp') found.push(node.attrs.config as Record<string, unknown>);
    node.content?.forEach(visit);
  };
  doc?.content.forEach(visit);
  return found;
}

describe('pages de l\'espace membre', () => {
  test('identifiants de page', () => {
    expect(memberPageId('home')).toBe('_me');
    expect(memberPageId('tickets')).toBe('_me-tickets');
    expect(memberPageId('applications', ID)).toBe(`_me-applications-${ID}`);
  });

  test('la fiche voyage dans l\'identifiant de page', () => {
    expect(memberAppConfigs(`_me-tickets-${ID}`)).toEqual([{ app: 'tickets', id: ID }]);
    expect(memberAppConfigs('_me')).toEqual([{ app: 'home', id: '' }]);
  });

  test('progression et réglages ajoutent les blocs existants sous la barre', () => {
    const modules = (pageId: string) => JSON.stringify(virtualDocument(pageId)).match(/"module":"(\w+)"/g);
    expect(modules('_me-progress')).toEqual(expect.arrayContaining(['"module":"memberApp"', '"module":"memberQuests"', '"module":"memberRewards"', '"module":"memberInventory"']));
    expect(modules('_me-settings')).toEqual(['"module":"memberApp"', '"module":"memberSettings"']);
  });

  test('identifiants inconnus ou mal formés refusés', () => {
    expect(virtualDocument('_me-shop')).toBeNull();
    expect(virtualDocument('_me-tickets-../../x')).toBeNull();
    expect(virtualDocument('_me-tickets-ABC')).toBeNull();
  });
});

describe('apps ouvertes', () => {
  test('toutes allumées par défaut', () => {
    expect(availableApps({})).toEqual(['tickets', 'applications', 'progress', 'events', 'settings']);
  });

  test('une app disparaît quand ses modules sont éteints', () => {
    expect(availableApps({ tickets: false, recruitment: false, custom_forms: false, events: false, giveaways: false })).toEqual(['progress', 'settings']);
    expect(availableApps({ recruitment: false })).toContain('applications');
  });
});
