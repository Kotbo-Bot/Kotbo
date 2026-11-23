import { describe, expect, test } from 'bun:test';
import { toConfigPatch } from '../../api/mcp/tools/antiraid-config';

describe('toConfigPatch (anti-raid MCP)', () => {
  test('ne touche que les champs fournis', () => {
    expect(toConfigPatch({ join_threshold: 8, action: 'CAPTCHA' })).toEqual({ antiRaidJoinThreshold: 8, antiRaidAction: 'CAPTCHA' });
  });

  test('null retire un salon, faux désactive un interrupteur', () => {
    expect(toConfigPatch({ alert_channel_id: null, account_age_enabled: false })).toEqual({ antiRaidAlertChannelId: null, accountAgeGuardEnabled: false });
  });

  test('plafonne l\'ancienneté à dix ans en mois', () => {
    expect(toConfigPatch({ account_age_min_value: 500, account_age_unit: 'MONTHS' }).accountAgeMinValue).toBe(120);
  });

  test('aucun champ, aucun changement', () => {
    expect(toConfigPatch({})).toEqual({});
  });
});
