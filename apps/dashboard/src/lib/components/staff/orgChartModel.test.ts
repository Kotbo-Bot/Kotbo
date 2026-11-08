import { describe, expect, test } from 'bun:test';
import { buildOrgCards, canAttach, orgChartSvg, orgRows, siblingOrder, type HierarchySchema, type SchemaHierarchy } from './orgChartModel';

const labels = { chief: 'Resp', unknownName: 'Inconnu', noGrade: 'Sans grade' };

const pole = (id: string, parentHierarchyId: string | null, extra: Partial<SchemaHierarchy> = {}): SchemaHierarchy => ({
  id,
  name: id,
  parentHierarchyId,
  roles: [],
  members: [],
  memberCount: 0,
  ...extra,
});

const member = (userId: string, grade: string) => ({ userId, username: userId, grade });

const schema = (hierarchies: SchemaHierarchy[], chief: string | null = null): HierarchySchema => ({
  chiefStaff: chief ? { name: chief } : null,
  hierarchies,
});

describe('canAttach', () => {
  const list = [pole('a', null), pole('b', 'a'), pole('c', 'b')];

  test('refuse le pole lui-meme et ses descendants', () => {
    expect(canAttach(list, 'a', 'a')).toBe(false);
    expect(canAttach(list, 'a', 'c')).toBe(false);
  });

  test('accepte un autre parent et le premier niveau', () => {
    expect(canAttach(list, 'c', 'a')).toBe(true);
    expect(canAttach(list, 'b', null)).toBe(true);
  });

  test('ne boucle pas sur un cycle deja en base', () => {
    expect(canAttach([pole('x', 'y'), pole('y', 'x')], 'z', 'x')).toBe(true);
  });
});

describe('siblingOrder', () => {
  const list = [pole('a', null, { sortOrder: 0 }), pole('b', null, { sortOrder: 1 }), pole('c', null, { sortOrder: 2 })];

  test('insere avant le voisin vise', () => {
    expect(siblingOrder(list, 'c', null, 'a')).toEqual(['c', 'a', 'b']);
  });

  test('place en dernier sans voisin', () => {
    expect(siblingOrder(list, 'a', null)).toEqual(['b', 'c', 'a']);
  });

  test('un pole venu d\'ailleurs rejoint ses nouveaux freres', () => {
    expect(siblingOrder([...list, pole('d', 'a')], 'd', null, 'b')).toEqual(['a', 'd', 'b', 'c']);
  });
});

describe('buildOrgCards', () => {
  const roles = [
    { id: 'r1', name: 'Modo', level: 10, isResponsable: false },
    { id: 'r2', name: 'Chef', level: 50, isResponsable: true },
  ];

  test('imbrique les poles et trie les grades du plus haut au plus bas', () => {
    const [root] = buildOrgCards(schema([pole('a', null, { roles }), pole('b', 'a')]), 'hierarchy', labels);
    expect(root.children.map((c) => c.id)).toEqual(['b']);
    expect(root.sections.map((s) => s.title)).toEqual(['Chef', 'Modo']);
  });

  test('un cycle en base garde ses poles visibles', () => {
    const cards = buildOrgCards(schema([pole('a', 'b'), pole('b', 'a')]), 'hierarchy', labels);
    expect(cards.map((c) => c.id).sort()).toEqual(['a', 'b']);
  });

  test('le type « pôles » aplatit, le responsable reste en tete', () => {
    const [chief] = buildOrgCards(schema([pole('a', null), pole('b', 'a')], 'Sam'), 'teams', labels);
    expect(chief.kind).toBe('chief');
    expect(chief.children.map((c) => c.id)).toEqual(['a', 'b']);
    expect(chief.children[0].children).toEqual([]);
  });

  test('le type « grades » enchaine par poids et regroupe un meme nom', () => {
    const [top] = buildOrgCards(schema([
      pole('a', null, { roles, members: [member('u1', 'modo')] }),
      pole('b', null, { roles: [{ id: 'r3', name: 'modo', level: 12, isResponsable: false }], members: [member('u2', 'modo')] }),
    ]), 'grades', labels);
    expect(top.title).toBe('Chef');
    expect(top.children[0].sections.map((s) => s.title)).toEqual(['a', 'b']);
    expect(top.children[0].memberCount).toBe(2);
  });

  test('un membre au grade disparu reste affiche', () => {
    const [root] = buildOrgCards(schema([pole('a', null, { roles, members: [member('u1', 'Ancien')] })]), 'hierarchy', labels);
    expect(root.sections.at(-1)?.title).toBe('Sans grade');
    expect(root.sections.at(-1)?.roleId).toBeNull();
    expect(root.sections.at(-1)?.members[0].userId).toBe('u1');
  });
});

describe('export', () => {
  test('echappe les noms et retire les caracteres qui casseraient le SVG', () => {
    const cards = buildOrgCards(schema([pole('<b>&"\u0007', null)]), 'hierarchy', labels);
    const { source } = orgChartSvg(cards, 'tree', '-');
    expect(source).toContain('&lt;b&gt;&amp;&quot;');
    expect(source).not.toContain('<b>');
    expect(source).not.toContain('\u0007');
  });

  test('les cartes tiennent dans le cadre, dans les deux sens', () => {
    const cards = buildOrgCards(schema([pole('a', null), pole('b', 'a'), pole('c', 'a')]), 'hierarchy', labels);
    const tree = orgChartSvg(cards, 'tree', '-');
    const horizontal = orgChartSvg(cards, 'horizontal', '-');
    // Deux cartes cote a cote dans l'arbre, l'une apres l'autre a l'horizontale.
    expect(tree.width).toBe(588);
    expect(horizontal.width).toBe(604);
  });

  test('le fichier garde les grades vides et une ligne par personne', () => {
    const rows = orgRows(schema([
      pole('a', null, { roles: [{ id: 'r', name: 'Modo', level: 1, isResponsable: false }], members: [member('u1', 'Modo')] }),
      pole('b', 'a', { roles: [{ id: 's', name: 'Vide', level: 1, isResponsable: false }] }),
    ]), labels, { pole: 'P', parent: 'R', grade: 'G', member: 'M', id: 'I' });
    expect(rows).toEqual([
      { P: 'a', R: '', G: 'Modo', M: 'u1', I: 'u1' },
      { P: 'b', R: 'a', G: 'Vide', M: '', I: '' },
    ]);
  });
});
