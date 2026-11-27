import { describe, expect, test } from 'bun:test';
import {
  CATEGORY_MAX,
  CRISIS_TASK_MAX,
  DEFAULT_CATEGORY_IDS,
  PLAN_TASK_MAX,
  TAG_MAX,
  caseCategoryIds,
  cleanCaseCategories,
  cleanCrisisTasks,
  cleanTagIds,
  cleanTags,
  cleanTaskPlans,
  crisisTasksOf,
  describeCustomization,
  planTaskDrafts,
  tagNames,
  tagCounts,
  cleanNoteTemplates,
  NOTE_TEMPLATE_MAX,
  NOTE_TEMPLATE_TEXT_MAX,
  copyableCustomization,
} from '../../services/staff/wellbeingCustomPolicy';
import { CRISIS_PROTOCOL_TASKS, crisisTaskDrafts } from '../../services/staff/wellbeingCasePolicy';
import { cleanBoardColumns } from '../../services/staff/wellbeingBoardPolicy';
import { cleanPanelText, PANEL_TEXT_MAX } from '../../services/staff/wellbeingReportPolicy';

let counter = 0;
const newId = () => `id-${++counter}`;
const DAY = 24 * 60 * 60 * 1000;

describe('catégories de la cellule', () => {
  test('sans catégorie réglée, les quatre catégories de départ restent proposées', () => {
    expect(caseCategoryIds([])).toEqual([...DEFAULT_CATEGORY_IDS]);
  });

  test('les catégories réglées remplacent celles de départ', () => {
    expect(caseCategoryIds([{ id: 'SOUTIEN', label: 'Écoute', template: '' }, { id: 'abc', label: 'Hors serveur', template: '' }]))
      .toEqual(['SOUTIEN', 'abc']);
  });

  test('libellé obligatoire et unique, trame bornée, identifiant des catégories de départ gardé', () => {
    const categories = cleanCaseCategories([
      { id: 'SOUTIEN', label: ' Écoute ', template: 'x'.repeat(5000) },
      { id: 'SOUTIEN', label: 'écoute', template: '' },
      { label: '', template: 'vide' },
      { id: '../pas bon', label: 'Hors serveur', template: 42 },
    ], newId);
    expect(categories.map((item) => item.label)).toEqual(['Écoute', 'Hors serveur']);
    expect(categories[0]?.id).toBe('SOUTIEN');
    expect(categories[0]?.template.length).toBe(2000);
    expect(categories[1]?.id).toMatch(/^id-/);
    expect(categories[1]?.template).toBe('');
  });

  test('une catégorie peut appliquer un plan type à la création', () => {
    const [withPlan, withoutPlan] = cleanCaseCategories([
      { label: 'Médiation', template: '', planId: 'plan-1' },
      { label: 'Soutien', template: '', planId: '../mauvais' },
    ], newId);
    expect(withPlan?.planId).toBe('plan-1');
    expect(withoutPlan?.planId).toBeNull();
  });

  test('au plus CATEGORY_MAX catégories', () => {
    const many = Array.from({ length: CATEGORY_MAX + 3 }, (_, index) => ({ label: `C${index}`, template: '' }));
    expect(cleanCaseCategories(many, newId)).toHaveLength(CATEGORY_MAX);
  });
});

describe('protocole de crise modifiable', () => {
  test('sans étape réglée, le protocole de départ s’applique', () => {
    expect(crisisTasksOf([])).toEqual(CRISIS_PROTOCOL_TASKS);
  });

  test('les étapes réglées sont nettoyées : libellé obligatoire, délai entre 1 et 168 heures', () => {
    const tasks = cleanCrisisTasks([
      { label: ' Appeler la personne ', dueHours: 0 },
      { label: '', dueHours: 4 },
      { label: 'Prévenir la direction', dueHours: 500 },
      { label: 'Noter', dueHours: 'trois' },
    ]);
    expect(tasks).toEqual([
      { label: 'Appeler la personne', dueHours: 1 },
      { label: 'Prévenir la direction', dueHours: 168 },
      { label: 'Noter', dueHours: 24 },
    ]);
  });

  test('au plus CRISIS_TASK_MAX étapes', () => {
    const many = Array.from({ length: CRISIS_TASK_MAX + 2 }, (_, index) => ({ label: `E${index}`, dueHours: 2 }));
    expect(cleanCrisisTasks(many)).toHaveLength(CRISIS_TASK_MAX);
  });

  test('les étapes réglées deviennent les tâches du dossier', () => {
    const now = new Date('2026-11-27T10:00:00Z');
    const drafts = crisisTaskDrafts(now, [{ label: 'Appeler', dueHours: 3 }]);
    expect(drafts).toEqual([{ label: 'Appeler', dueAt: new Date(now.getTime() + 3 * 60 * 60 * 1000) }]);
  });
});

describe('plans d’action types', () => {
  test('un plan sans nom ou sans tâche est écarté, ses tâches sont bornées', () => {
    const plans = cleanTaskPlans([
      { label: 'Médiation', tasks: [{ label: 'Entendre les deux parties', dueDays: 2 }, { label: '' }, { label: 'Bilan', dueDays: 999 }] },
      { label: 'Vide', tasks: [] },
      { label: '', tasks: [{ label: 'Orpheline' }] },
    ], newId);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.label).toBe('Médiation');
    expect(plans[0]?.tasks).toEqual([{ label: 'Entendre les deux parties', dueDays: 2 }, { label: 'Bilan', dueDays: 90 }]);
  });

  test('au plus PLAN_TASK_MAX tâches par plan', () => {
    const tasks = Array.from({ length: PLAN_TASK_MAX + 5 }, (_, index) => ({ label: `T${index}` }));
    expect(cleanTaskPlans([{ label: 'Long', tasks }], newId)[0]?.tasks).toHaveLength(PLAN_TASK_MAX);
  });

  test('appliquer un plan donne ses tâches datées, dans la place qui reste', () => {
    const now = new Date('2026-11-27T10:00:00Z');
    const plan = { id: 'p', label: 'Suivi', tasks: [{ label: 'A', dueDays: 1 }, { label: 'B', dueDays: null }, { label: 'C', dueDays: 7 }] };
    expect(planTaskDrafts(plan, now, 2)).toEqual([
      { label: 'A', dueAt: new Date(now.getTime() + DAY) },
      { label: 'B', dueAt: null },
    ]);
    expect(planTaskDrafts(plan, now, 0)).toEqual([]);
  });
});

describe('étiquettes', () => {
  test('libellé obligatoire et unique, au plus TAG_MAX', () => {
    const tags = cleanTags([{ label: 'Mineur' }, { label: 'mineur' }, { label: '  ' }, ...Array.from({ length: TAG_MAX + 2 }, (_, i) => ({ label: `E${i}` }))], newId);
    expect(tags[0]?.label).toBe('Mineur');
    expect(tags).toHaveLength(TAG_MAX);
  });

  test('un dossier ne garde que des étiquettes qui existent, sans doublon', () => {
    const tags = [{ id: 'a', label: 'Mineur' }, { id: 'b', label: 'Hors serveur' }];
    expect(cleanTagIds(['b', 'a', 'b', 'zz', 3], tags)).toEqual(['b', 'a']);
    expect(cleanTagIds('a', tags)).toEqual([]);
  });

  test('l’historique nomme les étiquettes posées', () => {
    const tags = [{ id: 'a', label: 'Mineur' }, { id: 'b', label: 'Hors serveur' }];
    expect(tagNames(tags, ['b', 'a', 'disparue'])).toBe('Hors serveur, Mineur');
    expect(tagNames(tags, [])).toBeNull();
  });
});

describe('journal de la personnalisation', () => {
  test('la ligne d’audit nomme ce qui a été réglé', () => {
    expect(describeCustomization('tags', [{ label: 'Mineur' }, { label: 'Hors serveur' }])).toBe('Étiquettes : Mineur, Hors serveur');
    expect(describeCustomization('crisisTasks', [])).toBe('Protocole de crise : protocole de départ');
  });
});

describe('colonnes, toujours nettoyées de la même façon', () => {
  test('libellé unique et identifiant valide', () => {
    const columns = cleanBoardColumns([{ id: 'a-1', label: 'À contacter' }, { id: 'a-1', label: 'à contacter' }, { id: 'BAD ID', label: 'Médiation' }], newId);
    expect(columns).toEqual([{ id: 'a-1', label: 'À contacter' }, { id: expect.stringMatching(/^id-/), label: 'Médiation' }]);
  });
});

describe('texte libre du message permanent', () => {
  test('nettoyé et borné, vide refusé', () => {
    expect(cleanPanelText('  Bonjour  ')).toBe('Bonjour');
    expect(cleanPanelText('   ')).toBeNull();
    expect(cleanPanelText(12)).toBeNull();
    expect(cleanPanelText('x'.repeat(PANEL_TEXT_MAX + 10))?.length).toBe(PANEL_TEXT_MAX);
  });
});

describe('étiquettes dans le bilan', () => {
  test('dossiers actifs par étiquette, dans l’ordre de la cellule', () => {
    const tags = [{ id: 'a', label: 'Mineur' }, { id: 'b', label: 'Hors serveur' }];
    const cases = [
      { status: 'OPEN', tagIds: ['a', 'b'] },
      { status: 'MONITORING', tagIds: ['a'] },
      { status: 'CLOSED', tagIds: ['a'] },
      { status: 'OPEN', tagIds: [] },
    ];
    expect(tagCounts(cases, tags)).toEqual([{ label: 'Mineur', count: 2 }, { label: 'Hors serveur', count: 1 }]);
  });
});

describe('trames de notes de fiche', () => {
  test('nom et texte obligatoires, texte borné', () => {
    const templates = cleanNoteTemplates([
      { label: 'Échange privé', text: 'Échange du … avec …' },
      { label: 'Sans texte', text: '  ' },
      { label: 'Long', text: 'x'.repeat(NOTE_TEMPLATE_TEXT_MAX + 50) },
    ], newId);
    expect(templates.map((item) => item.label)).toEqual(['Échange privé', 'Long']);
    expect(templates[1]?.text.length).toBe(NOTE_TEMPLATE_TEXT_MAX);
  });

  test('au plus NOTE_TEMPLATE_MAX trames', () => {
    const many = Array.from({ length: NOTE_TEMPLATE_MAX + 3 }, (_, i) => ({ label: `T${i}`, text: 'texte' }));
    expect(cleanNoteTemplates(many, newId)).toHaveLength(NOTE_TEMPLATE_MAX);
  });

  test('le journal les nomme', () => {
    expect(describeCustomization('noteTemplates', [])).toBe('Trames de notes : aucune');
  });
});

describe('réglages repris d’une autre cellule du réseau', () => {
  const source = {
    enabled: true,
    networkPool: true,
    caseCategories: [{ id: 'abc', label: 'Hors serveur', template: '', planId: null }],
    crisisTasks: [{ label: 'Appeler', dueHours: 2 }],
    taskPlans: [],
    noteTemplates: [],
    caseTags: [{ id: 't', label: 'Mineur' }],
  };

  test('seuls les réglages demandés sont repris, nettoyés', () => {
    expect(copyableCustomization(source, ['categories', 'crisisTasks'])).toEqual({
      caseCategories: [{ id: 'abc', label: 'Hors serveur', template: '', planId: null }],
      crisisTasks: [{ label: 'Appeler', dueHours: 2 }],
    });
  });

  test('une cellule qui ne partage pas avec le réseau ne se copie pas', () => {
    expect(copyableCustomization({ ...source, networkPool: false }, ['categories'])).toBeNull();
    expect(copyableCustomization({ ...source, enabled: false }, ['categories'])).toBeNull();
  });

  test('un réglage inconnu est ignoré', () => {
    expect(copyableCustomization(source, ['inconnu', 'tags'])).toEqual({ caseTags: [{ id: 't', label: 'Mineur' }] });
    expect(copyableCustomization(source, ['constructor', 'toString', '__proto__'])).toEqual({});
  });
});

