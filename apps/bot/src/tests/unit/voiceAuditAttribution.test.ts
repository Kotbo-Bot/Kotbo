import { describe, expect, test } from 'bun:test';
import { attribuerParCompteur, type EntreeAuditVocale } from '../../events/voiceAuditAttribution';

const NOW = 1_000_000;
const FENETRE = 12_000;
const e = (id: string, executorId: string, count: number, channelId: string | null, age = 60_000): EntreeAuditVocale =>
  ({ id, executorId, count, channelId, createdTimestamp: NOW - age });

describe('attribuerParCompteur', () => {
  test('entrée neuve vers le salon d’arrivée : son modérateur est l’auteur', () => {
    const r = attribuerParCompteur([e('a', 'modo', 1, 'B', 1_000)], new Map(), 'B', NOW, FENETRE);
    expect(r.auteurId).toBe('modo');
  });

  test('compteur d’une entrée agrégée qui monte : attribué, puis consommé', () => {
    const premier = attribuerParCompteur([e('a', 'modo', 3, 'B')], new Map([['a', 2]]), 'B', NOW, FENETRE);
    expect(premier.auteurId).toBe('modo');
    // Relu sans nouvelle hausse : c’est le membre qui a bougé seul.
    expect(attribuerParCompteur([e('a', 'modo', 3, 'B')], premier.releve, 'B', NOW, FENETRE).auteurId).toBeNull();
  });

  test('hausse vers un autre salon : pas cet événement', () => {
    expect(attribuerParCompteur([e('a', 'modo', 3, 'C')], new Map([['a', 2]]), 'B', NOW, FENETRE).auteurId).toBeNull();
  });

  test('deux modérateurs candidats : on ne devine pas, et on solde', () => {
    const r = attribuerParCompteur([e('a', 'm1', 1, 'B', 500), e('b', 'm2', 1, 'B', 500)], new Map(), 'B', NOW, FENETRE);
    expect(r.auteurId).toBeUndefined();
    expect(attribuerParCompteur([e('a', 'm1', 1, 'B', 500), e('b', 'm2', 1, 'B', 500)], r.releve, 'B', NOW, FENETRE).auteurId).toBeNull();
  });

  test('premier relevé du serveur, aucune entrée neuve : inconnu, jamais « lui-même »', () => {
    const r = attribuerParCompteur([e('a', 'modo', 5, 'B')], undefined, 'B', NOW, FENETRE);
    expect(r.auteurId).toBeUndefined();
    // L’ancienne entrée devient le point de départ : sa prochaine hausse compte.
    expect(attribuerParCompteur([e('a', 'modo', 6, 'B')], r.releve, 'B', NOW, FENETRE).auteurId).toBe('modo');
  });

  test('déconnexion (pas de salon) : deux déconnexions du même modo, deux attributions', () => {
    const r1 = attribuerParCompteur([e('d', 'modo', 2, null, 1_000)], new Map(), null, NOW, FENETRE);
    const r2 = attribuerParCompteur([e('d', 'modo', 2, null, 1_000)], r1.releve, null, NOW, FENETRE);
    const r3 = attribuerParCompteur([e('d', 'modo', 2, null, 1_000)], r2.releve, null, NOW, FENETRE);
    expect([r1.auteurId, r2.auteurId, r3.auteurId]).toEqual(['modo', 'modo', null]);
  });
});
