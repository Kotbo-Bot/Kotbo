/**
 * Règles des panneaux de discussion : ce que la validation laisse passer, le
 * nom du fil et son message de départ.
 *
 * Une erreur ici casse des panneaux déjà publiés (identifiant de bouton
 * perdu) ou ouvre un modal que Discord refuse (plus de 5 composants).
 */
import { describe, expect, test } from 'bun:test';
import {
  buildThreadPanelName,
  buildThreadPanelStarter,
  defaultThreadPanel,
  maxThreadPanelFields,
  normalizeThreadPanel,
  threadPanelCooldownLeft,
} from '@kotbo/shared';

const FORUM = '123456789012345678';
const TAG = '223456789012345678';

function panel(button: Record<string, unknown> = {}) {
  return { ...defaultThreadPanel(), buttons: [{ ...defaultThreadPanel().buttons[0], ...button }] };
}

describe('validation', () => {
  test('un panneau par défaut passe', () => {
    expect(normalizeThreadPanel(defaultThreadPanel()).ok).toBe(true);
  });

  test('un post de forum exige son salon', () => {
    expect(normalizeThreadPanel(panel({ target: 'forum' }))).toEqual({ ok: false, error: 'forum_channel_required' });
    expect(normalizeThreadPanel(panel({ target: 'forum', targetChannelId: FORUM })).ok).toBe(true);
  });

  test('le menu de tags prend une place du modal', () => {
    const field = { label: 'Détails' };
    expect(maxThreadPanelFields({ target: 'public', forumChoiceTagIds: [] })).toBe(4);
    expect(maxThreadPanelFields({ target: 'forum', forumChoiceTagIds: [TAG] })).toBe(3);
    const tooMany = panel({ target: 'forum', targetChannelId: FORUM, forumChoiceTagIds: [TAG], fields: [field, field, field, field] });
    expect(normalizeThreadPanel(tooMany)).toEqual({ ok: false, error: 'fields_too_many' });
  });

  test('l’identifiant d’un bouton survit à l’enregistrement, un doublon en reçoit un neuf', () => {
    const result = normalizeThreadPanel({
      ...defaultThreadPanel(),
      buttons: [{ label: 'A', id: 'abcd1234' }, { label: 'B', id: 'abcd1234' }],
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.buttons[0].id).toBe('abcd1234');
    expect(result.value.buttons[1].id).not.toBe('abcd1234');
  });

  test('les réglages propres à une cible sont oubliés ailleurs', () => {
    const result = normalizeThreadPanel(panel({ target: 'public', joinRequests: true, forumTagIds: [TAG] }));
    if (!result.ok) throw new Error(result.error);
    expect(result.value.buttons[0].joinRequests).toBe(false);
    expect(result.value.buttons[0].forumTagIds).toEqual([]);
  });

  test('une image doit être en https', () => {
    expect(normalizeThreadPanel({ ...defaultThreadPanel(), imageUrl: 'http://a.b/c.png' }).ok).toBe(false);
  });
});

describe('nom et message de départ', () => {
  const vars = { title: 'Mon  idée\nsuper', displayName: 'Léa', username: 'lea', count: 4, date: new Date('2026-10-26T12:00:00Z') };

  test('le modèle est rempli et tient sur une ligne', () => {
    expect(buildThreadPanelName({ nameTemplate: '#{count} {title} ({user})' }, vars)).toBe('#4 Mon idée super (Léa)');
  });

  test('un modèle qui finit vide retombe sur le titre', () => {
    expect(buildThreadPanelName({ nameTemplate: '   ' }, vars)).toBe('Mon idée super');
  });

  test('le message par défaut mentionne l’auteur et saute les réponses vides', () => {
    const text = buildThreadPanelStarter({ starterMessage: '' }, {
      userMention: '<@1>',
      title: 'T',
      count: 1,
      answers: [{ label: 'Quoi', value: 'Un bug' }, { label: 'Où', value: '  ' }],
    });
    expect(text).toBe('<@1>\n\n**Quoi**\nUn bug');
  });
});

describe('délai entre deux fils', () => {
  test('compte le temps restant', () => {
    const now = new Date('2026-10-26T12:10:00Z');
    expect(threadPanelCooldownLeft(600, new Date('2026-10-26T12:05:00Z'), now)).toBe(300);
    expect(threadPanelCooldownLeft(600, new Date('2026-10-26T11:00:00Z'), now)).toBe(0);
    expect(threadPanelCooldownLeft(0, new Date(), now)).toBe(0);
  });
});
