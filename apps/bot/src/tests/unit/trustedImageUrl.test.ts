import { describe, expect, test } from 'bun:test';
import { isTrustedImageUrl } from '../../services/moderation/trustedImageUrl.js';

describe('isTrustedImageUrl', () => {
  test('accepte le CDN et le proxy média de Discord', () => {
    expect(isTrustedImageUrl('https://cdn.discordapp.com/attachments/1/2/a.png')).toBeTrue();
    expect(isTrustedImageUrl('https://media.discordapp.net/external/x/y.png')).toBeTrue();
  });

  test('refuse un hôte tiers, interne ou imitant Discord', () => {
    expect(isTrustedImageUrl('https://evil.example/a.png')).toBeFalse();
    expect(isTrustedImageUrl('https://169.254.169.254/latest/meta-data')).toBeFalse();
    expect(isTrustedImageUrl('https://cdn.discordapp.com.evil.example/a.png')).toBeFalse();
    expect(isTrustedImageUrl('https://notdiscordapp.com/a.png')).toBeFalse();
  });

  test('refuse HTTP, identifiants, port inhabituel et entrée invalide', () => {
    expect(isTrustedImageUrl('http://cdn.discordapp.com/a.png')).toBeFalse();
    expect(isTrustedImageUrl('https://user:pw@cdn.discordapp.com/a.png')).toBeFalse();
    expect(isTrustedImageUrl('https://cdn.discordapp.com:8443/a.png')).toBeFalse();
    expect(isTrustedImageUrl('pas une url')).toBeFalse();
  });
});
