import { describe, expect, test } from 'bun:test';
import { hasUnsavedAutoModChanges } from './automodDirty';

const ENREGISTREE = { customWordsEnabled: true, linksWhitelist: [], customWords: ['spam'], customWordsAllowList: [], profanityAllowList: [], inviteFilterAllowedGuilds: [] };
const LISTES = { linksWhitelist: '', customWords: 'spam', customWordsAllowList: '', profanityAllowList: '', inviteFilterAllowedGuilds: '' };

describe('modifications AutoMod non enregistrées', () => {
  test('une liste modifiée seule est détectée, à la normalisation de l’enregistrement près', () => {
    expect(hasUnsavedAutoModChanges(ENREGISTREE, ENREGISTREE, { ...LISTES, customWords: 'spam\narnaque' })).toBe(true);
    expect(hasUnsavedAutoModChanges(ENREGISTREE, ENREGISTREE, { ...LISTES, customWords: '  SPAM \n' })).toBe(false);
  });

  test('une liste enregistrée sans normalisation, par MCP, ne rend pas la page non enregistrée au chargement', () => {
    const parMcp = { ...ENREGISTREE, customWords: ['SPAM', ' Arnaque '] };
    // Au chargement, les textarea reprennent la liste telle qu'enregistrée.
    expect(hasUnsavedAutoModChanges(parMcp, parMcp, { ...LISTES, customWords: 'SPAM\n Arnaque ' })).toBe(false);
    expect(hasUnsavedAutoModChanges(parMcp, parMcp, { ...LISTES, customWords: 'SPAM' })).toBe(true);
  });
});
