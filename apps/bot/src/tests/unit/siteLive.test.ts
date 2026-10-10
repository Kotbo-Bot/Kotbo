/**
 * Signaux temps réel du site : canaux acceptés à l'abonnement, regroupement
 * des rafales.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { isAllowedLiveChannel, publishSiteSignal, setSiteLivePublisher, siteLiveTopic } from '../../services/site/siteLive.js';

describe('canaux temps réel', () => {
  test('canaux publics acceptés pour tous', () => {
    expect(isAllowedLiveChannel('agent', null)).toBe(true);
    expect(isAllowedLiveChannel('module:giveaways', null)).toBe(true);
    expect(isAllowedLiveChannel('comments:abcdefghijklmnopqrstuvwx', null)).toBe(true);
  });

  test('canaux inconnus ou mal formés refusés', () => {
    expect(isAllowedLiveChannel('module:inexistant', null)).toBe(false);
    expect(isAllowedLiveChannel('comments:../../x', null)).toBe(false);
    expect(isAllowedLiveChannel('autre', null)).toBe(false);
    expect(isAllowedLiveChannel(42, null)).toBe(false);
  });

  test('canal d’un membre réservé au membre lui-même', () => {
    expect(isAllowedLiveChannel('user:111111111111111111', '111111111111111111')).toBe(true);
    expect(isAllowedLiveChannel('user:111111111111111111', '222222222222222222')).toBe(false);
    expect(isAllowedLiveChannel('user:111111111111111111', null)).toBe(false);
  });
});

describe('diffusion', () => {
  afterEach(() => {
    globalThis.KOTBO_SITE_LIVE_PUBLISHER = undefined;
  });

  test('une rafale sur un même sujet ne part qu’une fois', async () => {
    const sent: Array<{ topic: string; message: string }> = [];
    setSiteLivePublisher((topic, message) => sent.push({ topic, message }));
    publishSiteSignal('site1', 'module:giveaways');
    publishSiteSignal('site1', 'module:giveaways');
    publishSiteSignal('site1', 'agent');
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(sent.map((s) => s.topic).sort()).toEqual([siteLiveTopic('site1', 'agent'), siteLiveTopic('site1', 'module:giveaways')].sort());
    expect(JSON.parse(sent[0].message).type).toBe('site_signal');
  });
});
