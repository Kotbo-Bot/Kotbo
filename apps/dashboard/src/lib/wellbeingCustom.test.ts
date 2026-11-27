import { describe, expect, test } from 'bun:test';
import {
  WB_EMPTY_CUSTOMIZATION,
  wbCaseTags,
  wbCategories,
  wbCategoryName,
  wbCategoryPlan,
  wbCategoryTemplate,
  wbFilterByTag,
  wbIsCategoryTemplate,
  type WbCustomization,
} from './wellbeingCustom';
import { WB_CATEGORIES, wbCategoryLabel, wbSummaryTemplate } from './wellbeingLabels';

const custom = (over: Partial<WbCustomization>): WbCustomization => ({ ...WB_EMPTY_CUSTOMIZATION, ...over });

describe('catégories de la cellule', () => {
  test('sans réglage, les quatre catégories de départ, traduites, avec leur trame', () => {
    const categories = wbCategories(WB_EMPTY_CUSTOMIZATION);
    expect(categories.map((category) => category.id)).toEqual([...WB_CATEGORIES]);
    expect(categories[0]?.label).toBe(wbCategoryLabel('SOUTIEN'));
    expect(categories[0]?.template).toBe(wbSummaryTemplate('SOUTIEN'));
  });

  test('les catégories réglées remplacent celles de départ', () => {
    const settings = custom({ categories: [{ id: 'abc', label: 'Hors serveur', template: 'Contexte :' }] });
    expect(wbCategories(settings).map((category) => category.id)).toEqual(['abc']);
    expect(wbCategoryName(settings, 'abc')).toBe('Hors serveur');
    expect(wbCategoryTemplate(settings, 'abc')).toBe('Contexte :');
  });

  test('une catégorie retirée garde un nom lisible', () => {
    const settings = custom({ categories: [{ id: 'abc', label: 'Hors serveur', template: '' }] });
    expect(wbCategoryName(settings, 'SOUTIEN')).toBe(wbCategoryLabel('SOUTIEN'));
    expect(wbCategoryName(settings, 'disparue')).not.toBe('disparue');
  });

  test('un résumé resté tel que la trame peut être remplacé', () => {
    const settings = custom({ categories: [{ id: 'abc', label: 'Hors serveur', template: 'Contexte :' }] });
    expect(wbIsCategoryTemplate(settings, ' Contexte : ')).toBe(true);
    expect(wbIsCategoryTemplate(settings, '')).toBe(true);
    expect(wbIsCategoryTemplate(settings, 'Contexte : appel du 12')).toBe(false);
  });
});

describe('plan relié à une catégorie', () => {
  test('le plan relié est retrouvé, un plan supprimé ne l’est plus', () => {
    const plan = { id: 'p', label: 'Médiation', tasks: [{ label: 'A', dueDays: null }] };
    const settings = custom({ categories: [{ id: 'abc', label: 'Médiation', template: '', planId: 'p' }], taskPlans: [plan] });
    expect(wbCategoryPlan(settings, 'abc')).toEqual(plan);
    expect(wbCategoryPlan({ ...settings, taskPlans: [] }, 'abc')).toBeNull();
    expect(wbCategoryPlan(settings, 'SOUTIEN')).toBeNull();
  });
});

describe('étiquettes', () => {
  const settings = custom({ tags: [{ id: 'a', label: 'Mineur' }, { id: 'b', label: 'Hors serveur' }] });

  test('seules les étiquettes qui existent encore sont montrées, dans l’ordre de la cellule', () => {
    expect(wbCaseTags(settings, ['b', 'disparue', 'a']).map((tag) => tag.label)).toEqual(['Mineur', 'Hors serveur']);
    expect(wbCaseTags(settings, undefined)).toEqual([]);
  });

  test('filtrer par étiquette', () => {
    const cases = [{ id: '1', tagIds: ['a'] }, { id: '2', tagIds: [] }, { id: '3' }];
    expect(wbFilterByTag(cases, 'a').map((item) => item.id)).toEqual(['1']);
    expect(wbFilterByTag(cases, null)).toHaveLength(3);
  });
});
