import { describe, expect, test } from 'bun:test';
import { defaultTempVoicePolicy, normalizeTempVoicePolicy } from '../../services/features/tempVoiceService.js';

/** Visibilité par défaut du serveur et permission des réglages perso : valeurs bornées, jamais de chaîne libre. */
describe('politique des salons temporaires : visibilité et réglages perso', () => {
  test('défauts : visibilité tous, réglages perso permis', () => {
    const d = defaultTempVoicePolicy();
    expect(d.visibilite).toBe('tous');
    expect(d.reglagesPerso).toBe(true);
  });

  test.each(['tous', 'acces', 'prive'] as const)('visibilité valide « %s » conservée', (visibilite) => {
    expect(normalizeTempVoicePolicy({ visibilite }).visibilite).toBe(visibilite);
  });

  test.each(['nimporte', '', 'PRIVE', 3, null, {}])('visibilité invalide %p => tous', (visibilite) => {
    expect(normalizeTempVoicePolicy({ visibilite }).visibilite).toBe('tous');
  });

  test('reglagesPerso : booléen strict conservé, le reste => défaut', () => {
    expect(normalizeTempVoicePolicy({ reglagesPerso: false }).reglagesPerso).toBe(false);
    expect(normalizeTempVoicePolicy({ reglagesPerso: true }).reglagesPerso).toBe(true);
    for (const v of ['false', 0, null, 'non']) {
      expect(normalizeTempVoicePolicy({ reglagesPerso: v }).reglagesPerso).toBe(true);
    }
  });

  test('Json ancien sans les clés => défauts, le reste inchangé', () => {
    const ancien = { userLimit: 4, lockOnCreate: true, autoAllowRoleIds: [], textChat: 'open' };
    const p = normalizeTempVoicePolicy(ancien);
    expect(p.visibilite).toBe('tous');
    expect(p.reglagesPerso).toBe(true);
    expect(p.userLimit).toBe(4);
    expect(p.lockOnCreate).toBe(true);
    expect(normalizeTempVoicePolicy(null)).toEqual(defaultTempVoicePolicy());
  });
});
