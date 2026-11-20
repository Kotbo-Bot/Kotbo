import { describe, expect, test } from 'bun:test';
import { attribuerLot, creerRegroupeurLots, type EntreeAuditVocale } from '../../events/voiceAuditAttribution';

const NOW = 1_000_000;
const FENETRE = 12_000;
const BOT = 'kotbo';
const e = (id: string, executorId: string, count: number, channelId: string | null, age = 60_000): EntreeAuditVocale =>
  ({ id, executorId, count, channelId, createdTimestamp: NOW - age });
const lot = (entrees: EntreeAuditVocale[], releve: Map<string, number> | undefined, salons: Array<string | null>) =>
  attribuerLot(entrees, releve, salons, BOT, NOW, FENETRE);

describe('attribuerLot', () => {
  test('entrée neuve vers le salon d’arrivée : son modérateur est l’auteur', () => {
    expect(lot([e('a', 'modo', 1, 'B', 1_000)], new Map(), ['B']).auteurs).toEqual(['modo']);
  });

  test('compteur d’une entrée agrégée qui monte : attribué, puis consommé', () => {
    const premier = lot([e('a', 'modo', 3, 'B')], new Map([['a', 2]]), ['B']);
    expect(premier.auteurs).toEqual(['modo']);
    expect(lot([e('a', 'modo', 3, 'B')], premier.releve, ['B']).auteurs).toEqual([null]);
  });

  test('hausse vers un autre salon : pas cet événement, et elle reste due à son salon', () => {
    const r = lot([e('a', 'modo', 3, 'C')], new Map([['a', 2]]), ['B']);
    expect(r.auteurs).toEqual([null]);
    expect(lot([e('a', 'modo', 3, 'C')], r.releve, ['C']).auteurs).toEqual(['modo']);
  });

  test('deux modérateurs candidats : on ne devine pas, et on solde', () => {
    const entrees = [e('a', 'm1', 1, 'B', 500), e('b', 'm2', 1, 'B', 500)];
    const r = lot(entrees, new Map(), ['B']);
    expect(r.auteurs).toEqual([null]);
    expect(lot(entrees, r.releve, ['B']).auteurs).toEqual([null]);
  });

  test('premier relevé du serveur, aucune entrée neuve : pas d’auteur, point de départ posé', () => {
    const r = lot([e('a', 'modo', 5, 'B')], undefined, ['B']);
    expect(r.auteurs).toEqual([null]);
    expect(lot([e('a', 'modo', 6, 'B')], r.releve, ['B']).auteurs).toEqual(['modo']);
  });

  test('un départ volontaire et un modérateur dans le même lot : aucun auteur, jamais échangé', () => {
    const r = lot([e('d', 'modo', 4, null)], new Map([['d', 3]]), [null, null]);
    expect(r.auteurs).toEqual([null, null]);
    expect(lot([e('d', 'modo', 4, null)], r.releve, [null]).auteurs).toEqual([null]);
  });

  test('autant de hausses que d’événements, un seul modérateur : tous attribués', () => {
    expect(lot([e('d', 'modo', 5, null)], new Map([['d', 3]]), [null, null]).auteurs).toEqual(['modo', 'modo']);
  });

  test('chaque salon d’arrivée du lot compte ses propres hausses', () => {
    const entrees = [e('a', 'm1', 3, 'B'), e('c', 'm2', 8, 'C')];
    const r = lot(entrees, new Map([['a', 2], ['c', 7]]), ['B', 'C', 'B']);
    expect(r.auteurs).toEqual([null, 'm2', null]);
  });

  test('les entrées de Kotbo sont soldées sans gêner un modérateur', () => {
    const entrees = [e('k', BOT, 2, null), e('d', 'modo', 4, null)];
    const r = lot(entrees, new Map([['k', 1], ['d', 3]]), [null]);
    expect(r.auteurs).toEqual(['modo']);
    expect(r.releve.get('k')).toBe(2);
  });
});

describe('creerRegroupeurLots', () => {
  const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test('une rafale partage un seul traitement et chacun reçoit sa réponse', async () => {
    const appels: number[][] = [];
    const demander = creerRegroupeurLots<number, number>(async (_c, d) => {
      appels.push(d);
      return d.map((x) => x * 2);
    }, { calmeMs: 20, plafondMs: 500 });
    expect(await Promise.all([demander('k', 1), demander('k', 2), demander('k', 3)])).toEqual([2, 4, 6]);
    expect(appels).toEqual([[1, 2, 3]]);
  });

  test('deux clés ne partagent pas leur lot', async () => {
    const appels: number[][] = [];
    const demander = creerRegroupeurLots<number, number>(async (_c, d) => {
      appels.push(d);
      return d;
    }, { calmeMs: 10, plafondMs: 500 });
    await Promise.all([demander('a', 1), demander('b', 2)]);
    expect(appels).toHaveLength(2);
  });

  test('un flux continu est coupé au plafond', async () => {
    const appels: number[][] = [];
    const demander = creerRegroupeurLots<number, number>(async (_c, d) => {
      appels.push(d);
      return d;
    }, { calmeMs: 40, plafondMs: 60 });
    const premier = demander('k', 1);
    await attendre(30);
    const second = demander('k', 2);
    await attendre(50);
    expect(appels).toEqual([[1, 2]]);
    await Promise.all([premier, second]);
  });

  test('les lots d’une même clé passent l’un après l’autre', async () => {
    let enCours = 0;
    let maximum = 0;
    const demander = creerRegroupeurLots<number, number>(async (_c, d) => {
      maximum = Math.max(maximum, ++enCours);
      await attendre(30);
      enCours -= 1;
      return d;
    }, { calmeMs: 5, plafondMs: 100 });
    const premier = demander('k', 1);
    await attendre(15);
    await Promise.all([premier, demander('k', 2)]);
    expect(maximum).toBe(1);
  });

  test('un traitement en échec répond null sans bloquer le lot suivant', async () => {
    let essais = 0;
    const demander = creerRegroupeurLots<number, number>(async (_c, d) => {
      essais += 1;
      if (essais === 1) throw new Error('audit indisponible');
      return d;
    }, { calmeMs: 5, plafondMs: 100 });
    expect(await demander('k', 1)).toBeNull();
    expect(await demander('k', 2)).toBe(2);
  });
});
