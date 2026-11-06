import { describe, expect, test } from 'bun:test';
import {
  availableActions,
  availableConditions,
  compileRecipe,
  contextTokens,
  decompileGraph,
  hasBlockingIssue,
  isEmptyValue,
  validateGraph,
  type Recipe,
} from '@kotbo/shared';

/**
 * Le modèle « recette » n'est jamais stocké : il est compilé vers le graphe à
 * l'enregistrement et relu depuis le graphe à l'ouverture. L'aller-retour est
 * donc le seul invariant qui compte - s'il se perd, l'utilisateur voit son
 * automatisation se transformer toute seule entre deux visites.
 */

/**
 * Les identifiants de tests ne survivent pas à l'aller-retour : ils ne servent
 * qu'à la boucle de rendu de l'éditeur et n'ont pas d'équivalent dans le
 * graphe, où un test est un nœud repéré par sa position. On les neutralise
 * avant comparaison plutôt que d'alourdir la compilation pour les conserver.
 */
function withoutTestIds(recipe: Recipe | null): unknown {
  return JSON.parse(JSON.stringify(recipe), (_key, value) => (
    value && typeof value === 'object' && 'condition' in value ? { ...value, id: 'ID' } : value
  ));
}

/** Retire les valeurs vides, qui ne survivent pas à la compilation. */
function withoutEmptyValues(recipe: Recipe): Recipe {
  return JSON.parse(JSON.stringify(recipe), (_key, value) => {
    // `'values' in value` est vrai pour un tableau - d'où le garde-fou.
    if (value && typeof value === 'object' && !Array.isArray(value) && 'values' in value) {
      const kept = Object.entries(value.values as Record<string, { from: string } & Record<string, unknown>>)
        .filter(([, ref]) => !isEmptyValue(ref as never));
      return { ...value, values: Object.fromEntries(kept) };
    }
    return value;
  });
}

const welcome: Recipe = {
  trigger: { type: 'OnMemberJoin' },
  steps: [
    {
      id: 's1',
      kind: 'action',
      action: 'SendMessage',
      values: {
        text: { from: 'text', template: 'Bienvenue {member.displayName} sur {guild.name} !' },
        channel: { from: 'channel', channelId: '1234' },
      },
    },
    {
      id: 's2',
      kind: 'condition',
      match: 'all',
      tests: [
        { id: 't1', condition: 'member.accountAge', operator: 'lt', value: { from: 'number', value: 7 } },
      ],
      then: [
        {
          id: 's3',
          kind: 'action',
          action: 'AddRole',
          values: { role: { from: 'role', roleId: '999' }, member: { from: 'context', path: 'member' } },
        },
      ],
      otherwise: [
        { id: 's4', kind: 'wait', seconds: 120 },
      ],
    },
  ],
};

describe('compilation des recettes', () => {
  test('produit un graphe valide pour le moteur', () => {
    const graph = compileRecipe(welcome);
    expect(hasBlockingIssue(validateGraph(graph))).toBe(false);
  });

  test('est déterministe : deux compilations donnent le même graphe', () => {
    expect(compileRecipe(welcome)).toEqual(compileRecipe(welcome));
  });

  test('mutualise les nœuds auxiliaires partagés entre deux étapes', () => {
    const recipe: Recipe = {
      trigger: { type: 'OnMemberJoin' },
      steps: [
        {
          id: 'a', kind: 'action', action: 'SendDM',
          values: { text: { from: 'text', template: 'Salut {member.tag}' }, member: { from: 'context', path: 'member' } },
        },
        {
          id: 'b', kind: 'action', action: 'SendDM',
          values: { text: { from: 'text', template: 'Encore {member.tag}' }, member: { from: 'context', path: 'member' } },
        },
      ],
    };

    const graph = compileRecipe(recipe);
    expect(graph.nodes.filter((node) => node.type === 'MemberInfo')).toHaveLength(1);
  });

  test('traduit un texte à jetons en emplacements branchés', () => {
    const graph = compileRecipe(welcome);
    const format = graph.nodes.find((node) => node.type === 'FormatText');

    expect(format?.config?.template).toBe('Bienvenue {slot0} sur {slot1} !');
    expect(graph.edges.filter((edge) => edge.target === format?.id)).toHaveLength(2);
  });

  test('un texte sans jeton reste une simple constante', () => {
    const graph = compileRecipe({
      trigger: { type: 'OnMemberJoin' },
      steps: [{
        id: 'a', kind: 'action', action: 'SendMessage',
        values: { text: { from: 'text', template: 'Coucou' }, channel: { from: 'channel', channelId: '1' } },
      }],
    });

    expect(graph.nodes.some((node) => node.type === 'ConstText')).toBe(true);
    expect(graph.nodes.some((node) => node.type === 'FormatText')).toBe(false);
  });
});

describe('relecture des graphes', () => {
  test('retrouve la recette d\'origine', () => {
    const recipe = decompileGraph(compileRecipe(welcome));
    expect(withoutTestIds(recipe)).toEqual(withoutTestIds(welcome));
  });

  test('conserve la négation d\'une condition', () => {
    const recipe: Recipe = {
      trigger: { type: 'OnMemberJoin' },
      steps: [{
        id: 'c', kind: 'condition', match: 'all',
        tests: [{ id: 't', condition: 'member.hasRole', negate: true, value: { from: 'role', roleId: '42' } }],
        then: [], otherwise: [],
      }],
    };

    expect(withoutTestIds(decompileGraph(compileRecipe(recipe)))).toEqual(withoutTestIds(recipe));
  });

  test('conserve plusieurs conditions combinées', () => {
    const recipe: Recipe = {
      trigger: { type: 'OnMessageSend' },
      steps: [{
        id: 'c', kind: 'condition', match: 'any',
        tests: [
          { id: 't1', condition: 'message.contains', value: { from: 'text', template: 'discord.gg' } },
          { id: 't2', condition: 'message.length', operator: 'gt', value: { from: 'number', value: 500 } },
        ],
        then: [], otherwise: [],
      }],
    };

    expect(withoutTestIds(decompileGraph(compileRecipe(recipe)))).toEqual(withoutTestIds(recipe));
  });

  test('distingue les deux mini-jeux après relecture', () => {
    // Deux conditions sans valeur sur le même déclencheur : si la relecture les
    // confondait, un « rébus emoji » redeviendrait « nombre mystère » au
    // prochain enregistrement.
    const recipe: Recipe = {
      trigger: { type: 'OnFunGameWon' },
      steps: [{
        id: 'c', kind: 'condition', match: 'all',
        tests: [
          { id: 't1', condition: 'fun.isEmojiRiddle' },
          { id: 't2', condition: 'fun.isGuessNumber', negate: true },
        ],
        then: [{
          id: 'a', kind: 'action', action: 'SendMessage',
          values: {
            text: { from: 'text', template: '{member.displayName} a trouvé {answer} ({game})' },
            channel: { from: 'context', path: 'channel' },
          },
        }],
        otherwise: [],
      }],
    };

    const graph = compileRecipe(recipe);
    expect(hasBlockingIssue(validateGraph(graph))).toBe(false);
    expect(withoutTestIds(decompileGraph(graph))).toEqual(withoutTestIds(recipe));
  });

  test('refuse un graphe qui sort du modèle linéaire', () => {
    const graph = compileRecipe(welcome);
    graph.nodes.push({ id: 'loop', type: 'ForEach', position: { x: 0, y: 0 } });

    expect(decompileGraph(graph)).toBeNull();
  });

  test('refuse un graphe sans déclencheur', () => {
    expect(decompileGraph({ nodes: [], edges: [] })).toBeNull();
  });
});

describe('modèles proposés à la création', () => {
  /** Les modèles partagés doivent rester compilables par le moteur du bot. */
  test('se compilent et se relisent tous', async () => {
    const { RECIPE_TEMPLATES } = await import('@kotbo/shared');

    for (const template of RECIPE_TEMPLATES) {
      const recipe = template.build();
      const graph = compileRecipe(recipe);

      // Un champ laissé vide ne produit aucun nœud : il revient absent plutôt
      // que vide, ce que l'éditeur affiche de la même façon.
      expect(withoutTestIds(decompileGraph(graph))).toEqual(withoutTestIds(withoutEmptyValues(recipe)));

      // Les rôles et salons sont laissés vides à dessein : seules ces entrées
      // manquantes doivent être signalées, pas une erreur de construction.
      const codes = new Set(validateGraph(graph).filter((i) => i.severity === 'error').map((i) => i.code));
      expect([...codes].every((code) => code === 'MISSING_INPUT')).toBe(true);
    }
  });
});

describe('rôles par réaction emoji', () => {
  // La page des rôles par réaction renvoie ici pour les réactions emoji : il
  // faut un modèle pour la prise et un pour le retrait, sinon le rôle reste.
  test('un modèle donne le rôle à la réaction, l’autre le retire quand elle part', async () => {
    const { RECIPE_TEMPLATES } = await import('@kotbo/shared');
    const byId = (id: string) => RECIPE_TEMPLATES.find((template) => template.id === id)?.build();

    const add = byId('reaction-role');
    const remove = byId('reaction-role-remove');

    expect(add?.trigger.type).toBe('OnReactionAdd');
    expect(add?.steps.map((step) => step.kind === 'action' && step.action)).toEqual(['AddRole']);
    expect(remove?.trigger.type).toBe('OnReactionRemove');
    expect(remove?.steps.map((step) => step.kind === 'action' && step.action)).toEqual(['RemoveRole']);
  });
});

describe('bibliothèque humaine', () => {
  test('n\'expose que les actions réalisables avec le contexte du déclencheur', () => {
    const types = availableActions('OnMemberJoin').map((action) => action.type);
    expect(types).toContain('AddRole');

    // Un ticket n'expose pas de membre : les actions qui en réclament un sont
    // masquées plutôt que proposées puis refusées.
    const forGuildOnly = availableActions('Inconnu').map((action) => action.type);
    expect(forGuildOnly).not.toContain('AddRole');
    expect(forGuildOnly).toContain('SendMessage');
  });

  test('n\'expose que les conditions formulables', () => {
    const keys = availableConditions('OnMemberJoin').map((condition) => condition.key);
    expect(keys).toContain('member.hasRole');
    expect(keys).not.toContain('message.contains');
  });

  test('réserve les conditions de mini-jeu au déclencheur de victoire', () => {
    const keys = availableConditions('OnFunGameWon').map((condition) => condition.key);
    expect(keys).toContain('fun.isGuessNumber');
    expect(keys).toContain('fun.isEmojiRiddle');
    expect(keys).toContain('message.contains');

    const elsewhere = availableConditions('OnMessageSend').map((condition) => condition.key);
    expect(elsewhere).not.toContain('fun.isGuessNumber');
  });

  test('dérive les propriétés accessibles depuis le catalogue', () => {
    const paths = contextTokens('OnMessageSend').map((token) => token.path);
    expect(paths).toContain('message.content');
    expect(paths).toContain('member.accountAgeDays');
    expect(paths).toContain('guild.memberCount');
  });
});
