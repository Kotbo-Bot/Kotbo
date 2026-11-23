import { describe, expect, test } from 'bun:test';
import {
  normalizeQuestConditions,
  normalizeQuestRewards,
  questConditionsMet,
  renderQuestMessage,
} from '../../services/features/rpg/rpgQuestRules.js';
import { normalizeRpgQuestInput } from '../../services/features/rpg/rpgQuestPolicy.js';

const CH = '111111111111111111';
const CAT = '222222222222222222';
const ROLE = '333333333333333333';

describe('normalizeQuestConditions', () => {
  test('écarte les clés inconnues, les identifiants invalides et les valeurs vides', () => {
    expect(normalizeQuestConditions({ channelIds: ['abc', CH], bogus: 1, customRule: 'x' })).toEqual({ channelIds: [CH] });
    expect(normalizeQuestConditions({ channelIds: [], minLength: 0 })).toBeNull();
    expect(normalizeQuestConditions('x')).toBeNull();
  });

  test('reprend l\'ancien mot-clé séparé par des virgules', () => {
    expect(normalizeQuestConditions({ keyword: 'event, #fun ' })?.keywords).toEqual(['event', '#fun']);
  });

  test('une plage horaire sans écart ou des 7 jours ne filtrent rien', () => {
    expect(normalizeQuestConditions({ hourFrom: 5, hourTo: 5, weekdays: [0, 1, 2, 3, 4, 5, 6] })).toBeNull();
  });
});

describe('questConditionsMet', () => {
  test('salon, catégorie et rôles', () => {
    const c = { channelIds: [CH], roleIds: [ROLE] };
    expect(questConditionsMet(c, { channelId: CH, roleIds: [ROLE] })).toBe(true);
    expect(questConditionsMet(c, { channelId: CAT, roleIds: [ROLE] })).toBe(false);
    expect(questConditionsMet(c, { channelId: CH, roleIds: [] })).toBe(false);
    expect(questConditionsMet({ excludeRoleIds: [ROLE] }, { roleIds: [ROLE] })).toBe(false);
    expect(questConditionsMet({ categoryIds: [CAT] }, { categoryId: CAT })).toBe(true);
    expect(questConditionsMet({ categoryIds: [CAT] }, {})).toBe(false);
  });

  test('contenu du message', () => {
    expect(questConditionsMet({ minLength: 10 }, { content: 'court' })).toBe(false);
    expect(questConditionsMet({ keywords: ['Event'] }, { content: 'un EVENT ce soir' })).toBe(true);
    expect(questConditionsMet({ requireLink: true }, { content: 'voir https://kotbo.fr' })).toBe(true);
    expect(questConditionsMet({ requireAttachment: true }, { content: 'x', attachmentCount: 0 })).toBe(false);
    // Sans contenu (vocal, concours...), les filtres de texte ne sont pas reprochés.
    expect(questConditionsMet({ minLength: 10 }, {})).toBe(true);
  });

  test('jours et heures dans le fuseau du serveur, avec passage de minuit', () => {
    const friday2230Utc = new Date('2026-11-20T22:30:00Z'); // vendredi 23:30 à Paris
    expect(questConditionsMet({ weekdays: [5] }, {}, { now: friday2230Utc, timeZone: 'Europe/Paris' })).toBe(true);
    expect(questConditionsMet({ weekdays: [6] }, {}, { now: friday2230Utc, timeZone: 'Europe/Paris' })).toBe(false);
    expect(questConditionsMet({ hourFrom: 22, hourTo: 2 }, {}, { now: friday2230Utc, timeZone: 'Europe/Paris' })).toBe(true);
    expect(questConditionsMet({ hourFrom: 8, hourTo: 18 }, {}, { now: friday2230Utc, timeZone: 'Europe/Paris' })).toBe(false);
  });
});

describe('normalizeQuestRewards', () => {
  test('borne chaque type et écarte l\'incomplet', () => {
    const rewards = normalizeQuestRewards([
      { type: 'LEVEL_XP', amount: 50 },
      { type: 'ROLE', roleId: ROLE, durationHours: 24 },
      { type: 'ROLE', roleId: 'pas-un-id' },
      { type: 'ITEM', itemId: 'epee', quantity: 99999 },
      { type: 'MESSAGE', content: '   ' },
      { type: 'INCONNU' },
    ]);
    expect(rewards).toEqual([
      { type: 'LEVEL_XP', amount: 50 },
      { type: 'ROLE', roleId: ROLE, durationHours: 24 },
      { type: 'ITEM', itemId: 'epee', quantity: 1000 },
    ]);
  });

  test('rien de valable : null', () => {
    expect(normalizeQuestRewards([{ type: 'LEVEL_XP', amount: 0 }])).toBeNull();
  });
});

describe('renderQuestMessage', () => {
  test('remplace les variables', () => {
    expect(renderQuestMessage('{user} a fini {quest} ({target})', { userId: '1', quest: 'Bavard', target: 5 }))
      .toBe('<@1> a fini Bavard (5)');
  });
});

describe('normalizeRpgQuestInput - champs de personnalisation', () => {
  const base = { name: 'Q', description: 'd', objective: 'SEND_MESSAGES', target: 5 };

  test('absents : laissés à undefined pour ne pas écraser une fiche existante', () => {
    const result = normalizeRpgQuestInput(base);
    expect(result.ok && 'conditions' in result.value).toBe(false);
  });

  test('un objectif d\'état n\'est jamais répétable', () => {
    const result = normalizeRpgQuestInput({ ...base, objective: 'LEVEL_REACHED', repeatable: true });
    expect(result.ok && result.value.repeatable).toBe(false);
  });

  test('dates et prérequis', () => {
    const result = normalizeRpgQuestInput({ ...base, activeFrom: '2026-12-01T00:00:00Z', prerequisiteQuestId: ' abc ' });
    expect(result.ok && result.value.activeFrom?.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(result.ok && result.value.prerequisiteQuestId).toBe('abc');
  });
});
