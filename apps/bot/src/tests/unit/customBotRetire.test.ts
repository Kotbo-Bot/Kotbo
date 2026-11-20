import { describe, expect, test } from 'bun:test';
import { kotboReinviteUrl, retireNoticeText } from '../../services/system/customBotRetire.js';

describe('retour de Kotbo après la fin du bot perso', () => {
  test("le lien d'invitation vise le serveur seul, sans double barre", () => {
    expect(kotboReinviteUrl('https://api.kotbo.app/', '123456789012345678')).toBe(
      'https://api.kotbo.app/api/public/invite?direct=1&guild_id=123456789012345678',
    );
  });

  test('le message contient le lien et promet que la configuration est conservée', () => {
    const text = retireNoticeText('https://x/invite');
    expect(text).toContain('https://x/invite');
    expect(text).toContain('onboarding');
  });
});
