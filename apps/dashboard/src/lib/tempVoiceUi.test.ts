import { describe, test, expect } from 'bun:test';
import {
  clampInt,
  selectableGeneratorChannels,
  takenGeneratorChannelIds,
  tempVoiceSubFromSearch,
  userLimitDisplayFix,
  withTempVoiceSub,
} from './tempVoiceUi';

describe('1 — salons déjà pris exclus des sélecteurs de générateurs', () => {
  const salons = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

  test('le principal et les autres générateurs sont pris, pas le générateur édité', () => {
    const generateurs = [{ channelId: 'b' }, { channelId: 'c' }, { channelId: '' }, {}];
    expect([...takenGeneratorChannelIds('a', generateurs, 1)].sort()).toEqual(['a', 'b']);
    expect([...takenGeneratorChannelIds(null, generateurs)].sort()).toEqual(['b', 'c']);
  });

  test('les sélecteurs ne proposent plus les salons pris, et gardent celui du générateur édité', () => {
    const generateurs = [{ channelId: 'b' }, { channelId: 'c' }];
    // sélecteur du principal (a) : ne propose ni b ni c
    expect(selectableGeneratorChannels(salons, takenGeneratorChannelIds(null, generateurs)).map((s) => s.id)).toEqual(['a', 'd']);
    // sélecteur du générateur 0 (b) : ni le principal a, ni c ; b reste choisissable
    expect(selectableGeneratorChannels(salons, takenGeneratorChannelIds('a', generateurs, 0)).map((s) => s.id)).toEqual(['b', 'd']);
  });
});

describe('3 — bornes numériques', () => {
  test('clampInt borne, tronque et retombe sur le repli quand le champ est vidé', () => {
    expect(clampInt(0, 1, 1440, 10)).toBe(1);
    expect(clampInt(5000, 1, 1440, 10)).toBe(1440);
    expect(clampInt(12.9, 1, 1440, 10)).toBe(12);
    expect(clampInt(null, 1, 1440, 10)).toBe(10);
    expect(clampInt('', 1, 1440, 10)).toBe(10);
    expect(clampInt('abc', 1, 1440, 10)).toBe(10);
    expect(clampInt('30', 1, 1440, 10)).toBe(30);
  });
});

describe('4 — « Places par défaut » resynchronisé', () => {
  test('150 tapé alors que 99 est enregistré : le champ doit afficher 99', () => {
    expect(userLimitDisplayFix('150')).toBe('99');
    expect(userLimitDisplayFix('-3')).toBe('0');
    expect(userLimitDisplayFix('007')).toBe('7');
  });

  test('une valeur déjà juste, ou un champ vide en cours de frappe, ne sont pas retouchés', () => {
    expect(userLimitDisplayFix('99')).toBeNull();
    expect(userLimitDisplayFix('0')).toBeNull();
    expect(userLimitDisplayFix('')).toBeNull();
  });
});

describe('12 — sous-onglet vocal dans l\'URL', () => {
  test('lecture : valeur connue, inconnue ou absente', () => {
    expect(tempVoiceSubFromSearch('?sub=panel')).toBe('panel');
    expect(tempVoiceSubFromSearch('?sub=active&x=1')).toBe('active');
    expect(tempVoiceSubFromSearch('?sub=nimporte')).toBe('generators');
    expect(tempVoiceSubFromSearch('')).toBe('generators');
  });

  test('écriture : le défaut retire le paramètre, les autres paramètres sont gardés', () => {
    expect(withTempVoiceSub('', 'panel')).toBe('?sub=panel');
    expect(withTempVoiceSub('?sub=panel', 'generators')).toBe('');
    expect(withTempVoiceSub('?x=1&sub=panel', 'active')).toBe('?x=1&sub=active');
    expect(withTempVoiceSub('?x=1&sub=panel', 'generators')).toBe('?x=1');
  });

  test('aller-retour', () => {
    for (const sub of ['generators', 'permissions', 'panel', 'active'] as const) {
      expect(tempVoiceSubFromSearch(withTempVoiceSub('', sub))).toBe(sub);
    }
  });
});
