/**
 * Le salon d'alerte de la cellule de suivi porte les traces des accès aux
 * dossiers : aucun outil MCP ne doit le lire, l'effacer ou le modifier.
 */
import { describe, expect, mock, test } from 'bun:test';
import { channelArgValues, refersToChannel, withWellbeingChannelGuard } from '../../api/mcp/wellbeingGuard.js';

const ALERT = { id: '300000000000000001', name: 'alertes-bien-etre' };

describe('arguments désignant un salon', () => {
  test('seuls les arguments de salon ou de fil sont retenus, listes comprises', () => {
    expect(channelArgValues({
      channel: 'general',
      log_channel_id: '1',
      allowed_channels: ['2', '3'],
      thread: '4',
      channel_type: 'text',
      content: 'alertes-bien-etre',
    }).sort()).toEqual(['1', '2', '3', '4', 'general']);
  });

  test('un salon se reconnaît par son id, sa mention ou son nom', () => {
    for (const raw of [ALERT.id, `<#${ALERT.id}>`, '#alertes-bien-etre', 'Alertes-Bien-Etre']) {
      expect(refersToChannel(raw, ALERT)).toBe(true);
    }
    expect(refersToChannel('general', ALERT)).toBe(false);
  });
});

describe('garde du salon d alerte', () => {
  const handler = mock(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));

  test("un outil qui vise le salon d'alerte refuse sans appeler son gestionnaire", async () => {
    handler.mockClear();
    const result = await withWellbeingChannelGuard(handler, async () => ALERT)({ channel: `<#${ALERT.id}>`, limit: 20 });
    expect(handler).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  test('un autre salon passe', async () => {
    handler.mockClear();
    await withWellbeingChannelGuard(handler, async () => ALERT)({ channel: 'general' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("sans argument de salon, la configuration n'est même pas lue", async () => {
    handler.mockClear();
    const load = mock(async () => ALERT);
    await withWellbeingChannelGuard(handler, load)({ user: '200000000000000001' });
    expect(load).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
