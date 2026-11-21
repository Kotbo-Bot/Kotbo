/**
 * Règles des fils automatiques : quel message ouvre un fil, sous quel nom, et
 * ce que la validation laisse passer.
 *
 * Une erreur ici ouvre des fils sur des messages qui n'en voulaient pas, ou
 * pire, supprime ceux que la configuration aurait dû accepter.
 */
import { describe, expect, test } from 'bun:test';
import {
  autoThreadAccepts,
  autoThreadAcceptsEverything,
  buildAutoThreadName,
  checkAutoThreadRegex,
  exportAutoThreadConfig,
  firstLineOf,
  normalizeAutoThreadConfig,
  parseAutoThreadImport,
  sampleAutoThreadFacts,
  type AutoThreadFacts,
} from '@kotbo/shared';

function facts(overrides: Partial<AutoThreadFacts> = {}): AutoThreadFacts {
  return { ...sampleAutoThreadFacts('fr'), content: 'Bonjour', mediaCount: 0, ...overrides };
}

const ctx = { locale: 'fr' as const, count: 7 };

describe('déclenchement', () => {
  test('les préréglages lisent le texte, les liens et les médias', () => {
    expect(autoThreadAccepts({ trigger: 'text', conditions: null }, facts({ content: '  ' }))).toBe(false);
    expect(autoThreadAccepts({ trigger: 'text', conditions: null }, facts())).toBe(true);
    expect(autoThreadAccepts({ trigger: 'links', conditions: null }, facts())).toBe(false);
    expect(autoThreadAccepts({ trigger: 'links', conditions: null }, facts({ content: 'vu https://a.b/c' }))).toBe(true);
    expect(autoThreadAccepts({ trigger: 'media', conditions: null }, facts({ mediaCount: 1, content: '' }))).toBe(true);
  });

  test('un groupe « au moins une » inversé refuse ce qu’il accepterait', () => {
    const conditions = {
      kind: 'group' as const,
      op: 'any' as const,
      negate: true,
      children: [
        { kind: 'rule' as const, type: 'has_link' as const },
        { kind: 'rule' as const, type: 'contains' as const, value: 'BUG' },
      ],
    };
    expect(autoThreadAccepts({ trigger: 'custom', conditions }, facts({ content: 'un bug ici' }))).toBe(false);
    expect(autoThreadAccepts({ trigger: 'custom', conditions }, facts({ content: 'merci' }))).toBe(true);
  });

  test('rôle de l’auteur et longueur minimale', () => {
    const conditions = {
      kind: 'group' as const,
      op: 'all' as const,
      children: [
        { kind: 'rule' as const, type: 'author_has_role' as const, ids: ['123456789012345678'] },
        { kind: 'rule' as const, type: 'min_length' as const, value: '5' },
      ],
    };
    expect(autoThreadAccepts({ trigger: 'custom', conditions }, facts({ authorRoleIds: ['123456789012345678'] }))).toBe(true);
    expect(autoThreadAccepts({ trigger: 'custom', conditions }, facts({ authorRoleIds: [] }))).toBe(false);
    expect(autoThreadAccepts({ trigger: 'custom', conditions }, facts({ authorRoleIds: ['123456789012345678'], content: 'ok' }))).toBe(false);
  });

  test('seuls « tous les messages » et la condition « toujours » acceptent tout', () => {
    expect(autoThreadAcceptsEverything({ trigger: 'all', conditions: null })).toBe(true);
    expect(autoThreadAcceptsEverything({ trigger: 'text', conditions: null })).toBe(false);
    expect(autoThreadAcceptsEverything({ trigger: 'custom', conditions: { kind: 'rule', type: 'always' } })).toBe(true);
    expect(autoThreadAcceptsEverything({ trigger: 'custom', conditions: { kind: 'rule', type: 'always', negate: true } })).toBe(false);
  });
});

describe('nom du fil', () => {
  test('la première ligne perd sa mise en forme', () => {
    expect(firstLineOf('\n\n## **Crash** au lancement\nsuite')).toBe('Crash au lancement');
  });

  test('l’ancien format est conservé pour les configurations reprises', () => {
    const name = buildAutoThreadName({ namingMode: 'author_first_line', namingRules: [] }, facts({ content: 'Salut' }), ctx);
    expect(name).toBe('Fil de Alex - Salut');
  });

  test('les règles personnalisées passent la main quand un placeholder est vide', () => {
    const config = {
      namingMode: 'custom' as const,
      namingRules: [
        { type: 'template' as const, value: 'Média : {embedTitle}' },
        { type: 'regex' as const, value: 'ticket\\s*#?(\\d+)' },
        { type: 'template' as const, value: '#{count} {firstLine}' },
      ],
    };
    expect(buildAutoThreadName(config, facts({ content: 'voir ticket #42' }), ctx)).toBe('42');
    expect(buildAutoThreadName(config, facts({ content: 'Problème de son' }), ctx)).toBe('#7 Problème de son');
  });

  test('l’auteur sert de repli et le nom tient en 100 caractères', () => {
    expect(buildAutoThreadName({ namingMode: 'first_line', namingRules: [] }, facts({ content: '' }), ctx)).toBe('Alex');
    const long = buildAutoThreadName({ namingMode: 'first_line', namingRules: [] }, facts({ content: 'x'.repeat(300) }), ctx);
    expect(long.length).toBe(100);
  });
});

describe('validation', () => {
  test('refuse un motif à backtracking catastrophique', () => {
    expect(checkAutoThreadRegex('(a+)+$')).toBe('regex_unsafe');
    expect(checkAutoThreadRegex('[unclosed')).toBe('regex_invalid');
    expect(checkAutoThreadRegex('^bug')).toBeNull();
  });

  test('une condition de rôle sans rôle bloque seulement en mode personnalisé', () => {
    const conditions = { kind: 'rule', type: 'author_has_role', ids: [] };
    expect(normalizeAutoThreadConfig({ trigger: 'custom', conditions })).toEqual({ ok: false, error: 'condition_value_required' });
    const relaxed = normalizeAutoThreadConfig({ trigger: 'text', conditions });
    expect(relaxed.ok && relaxed.value.conditions).toBeNull();
  });

  test('borne le délai de rejet et la durée d’archivage', () => {
    const result = normalizeAutoThreadConfig({ rejectDelaySeconds: 1, archiveMinutes: 33 });
    expect(result.ok && result.value.rejectDelaySeconds).toBe(5);
    expect(result.ok && result.value.archiveMinutes).toBe(1440);
  });

  test('l’export se relit à l’identique', () => {
    const normalized = normalizeAutoThreadConfig({ name: 'Bugs', trigger: 'links', rejectAction: 'delete' });
    if (!normalized.ok) throw new Error('config invalide');
    const reread = parseAutoThreadImport(JSON.stringify(exportAutoThreadConfig(normalized.value)));
    expect(reread).toEqual(normalized);
    expect(parseAutoThreadImport('{oups')).toEqual({ ok: false, error: 'json_invalid' });
  });
});
