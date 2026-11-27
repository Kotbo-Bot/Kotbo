import { describe, expect, test } from 'bun:test';
import {
  BOARD_COLUMN_MAX,
  cleanBoardColumns,
  describeBoardColumns,
  stageChange,
  stageCounts,
  stageLabel,
} from '../../services/staff/wellbeingBoardPolicy';

let counter = 0;
const nextId = () => `col-${++counter}`;

describe('colonnes ajoutées par la cellule', () => {
  test('un libellé vide, en double ou trop long est écarté ou raccourci', () => {
    counter = 0;
    const columns = cleanBoardColumns([
      { id: 'a-contacter', label: '  À contacter ' },
      { label: 'à contacter' },
      { label: '   ' },
      { label: 'x'.repeat(80) },
      'pas un objet',
    ], nextId);
    expect(columns).toEqual([
      { id: 'a-contacter', label: 'À contacter' },
      { id: 'col-1', label: 'x'.repeat(40) },
    ]);
  });

  test('un identifiant invalide ou répété est remplacé', () => {
    counter = 0;
    const columns = cleanBoardColumns([{ id: 'Bad Id!', label: 'Un' }, { id: 'deux', label: 'Deux' }, { id: 'deux', label: 'Trois' }], nextId);
    expect(columns.map((column) => column.id)).toEqual(['col-1', 'deux', 'col-2']);
  });

  test(`au plus ${BOARD_COLUMN_MAX} colonnes`, () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ label: `Étape ${i}` }));
    expect(cleanBoardColumns(many, nextId)).toHaveLength(BOARD_COLUMN_MAX);
  });

  test('une valeur absente donne aucune colonne', () => {
    expect(cleanBoardColumns(undefined, nextId)).toEqual([]);
  });

  test('le journal nomme les colonnes', () => {
    expect(describeBoardColumns([{ id: 'a', label: 'À contacter' }, { id: 'b', label: 'En médiation' }]))
      .toBe('Colonnes du suivi : À contacter, En médiation');
    expect(describeBoardColumns([])).toBe('Colonnes du suivi : aucune');
  });
});

describe('bilan par étape', () => {
  test('les dossiers actifs de chaque étape, dans l ordre des colonnes', () => {
    const columns = [{ id: 'a', label: 'À contacter' }, { id: 'b', label: 'En médiation' }];
    const cases = [
      { status: 'OPEN', stage: 'b' },
      { status: 'MONITORING', stage: 'b' },
      { status: 'CLOSED', stage: 'a' },
      { status: 'OPEN', stage: null },
      { status: 'OPEN', stage: 'supprimee' },
    ];
    expect(stageCounts(cases, columns)).toEqual([{ label: 'À contacter', count: 0 }, { label: 'En médiation', count: 2 }]);
  });
});

describe('étape d un dossier', () => {
  const columns = [{ id: 'a', label: 'À contacter' }, { id: 'b', label: 'En médiation' }];

  test('une étape connue est posée, une étape inconnue refusée', () => {
    expect(stageChange({ stage: null, status: 'OPEN' }, { stage: 'b' }, columns)).toEqual({ stage: 'b' });
    expect(stageChange({ stage: null, status: 'OPEN' }, { stage: 'zz' }, columns)).toEqual({ error: expect.any(String) });
  });

  test('retirer l étape la vide', () => {
    expect(stageChange({ stage: 'a', status: 'OPEN' }, { stage: null }, columns)).toEqual({ stage: null });
  });

  test('clore un dossier le sort de son étape', () => {
    expect(stageChange({ stage: 'a', status: 'OPEN' }, { status: 'CLOSED' }, columns)).toEqual({ stage: null });
  });

  test('un dossier clos ne prend pas d étape sans être rouvert', () => {
    expect(stageChange({ stage: null, status: 'CLOSED' }, { stage: 'a' }, columns)).toEqual({ error: expect.any(String) });
    expect(stageChange({ stage: null, status: 'CLOSED' }, { stage: 'a', status: 'OPEN' }, columns)).toEqual({ stage: 'a' });
  });

  test('rien à changer', () => {
    expect(stageChange({ stage: 'a', status: 'OPEN' }, {}, columns)).toBeNull();
    expect(stageChange({ stage: 'a', status: 'OPEN' }, { stage: 'a' }, columns)).toBeNull();
  });

  test("l'historique garde le nom de l'étape", () => {
    expect(stageLabel(columns, 'b')).toBe('En médiation');
    expect(stageLabel(columns, null)).toBeNull();
    expect(stageLabel(columns, 'supprimee')).toBeNull();
  });
});
