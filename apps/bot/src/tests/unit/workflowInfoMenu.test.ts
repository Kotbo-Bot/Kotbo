import { describe, expect, test } from 'bun:test';
import { MAX_MENU_ITEMS, parseInfoMenu } from '../../services/features/workflow/infoMenu';

describe('parseInfoMenu', () => {
  test('une entrée par ligne, « Libellé | Texte »', () => {
    expect(parseInfoMenu('Règlement | Lis #règlement\nRecrutement | Ouvert')).toEqual([
      { label: 'Règlement', text: 'Lis #règlement' },
      { label: 'Recrutement', text: 'Ouvert' },
    ]);
  });

  test('ignore les lignes sans séparateur, sans libellé ou sans texte', () => {
    expect(parseInfoMenu('sans séparateur\n | texte seul\nlibellé seul |\nOk | Oui')).toEqual([{ label: 'Ok', text: 'Oui' }]);
  });

  test('garde les barres verticales du texte et convertit \\n en retour à la ligne', () => {
    expect(parseInfoMenu('A | un | deux\\nligne 2')).toEqual([{ label: 'A', text: 'un | deux\nligne 2' }]);
  });

  test('plafonne à 25 entrées, la limite de Discord', () => {
    const raw = Array.from({ length: 40 }, (_, i) => `L${i} | T${i}`).join('\n');
    expect(parseInfoMenu(raw)).toHaveLength(MAX_MENU_ITEMS);
  });

  test('valeur absente ou non textuelle : aucun menu', () => {
    expect(parseInfoMenu(undefined)).toEqual([]);
    expect(parseInfoMenu(42)).toEqual([]);
  });
});
