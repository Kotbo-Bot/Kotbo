import type { Recipe } from './recipe.js';

/** Recette prête à l'emploi proposée à la création d'un workflow. */
export interface RecipeTemplate {
  /** Sert aussi de clé de libellé, traduite côté dashboard. */
  id: string;
  icon: string;
  build: () => Recipe;
}

/*
 * Chaque `build` ci-dessous annote explicitement son retour `(): Recipe`.
 * Sans cette annotation, TypeScript unifie les étapes du tableau `steps` en un
 * type commun où les clés absentes d'une étape deviennent `?: undefined`
 * (`role?: undefined` sur une étape SendMessage, par exemple). Cette forme n'est
 * plus assignable à `Record<string, ValueRef>`, dont l'index refuse `undefined`.
 * L'annotation force le contrôle étape par étape et fait disparaître le problème.
 * Invisible ici (le dashboard compile sans `strict`), mais bloquant pour le test
 * du bot qui relit ces modèles depuis leur source.
 */

export const RECIPE_TEMPLATES: RecipeTemplate[] = [
  {
    id: 'welcome',
    icon: 'User',
    build: (): Recipe => ({
      trigger: { type: 'OnMemberJoin' },
      steps: [
        {
          id: 'welcome-message',
          kind: 'action',
          action: 'SendMessage',
          values: {
            text: { from: 'text', template: 'Bienvenue {member.displayName} sur {guild.name} !' },
            channel: { from: 'channel', channelId: '' },
          },
        },
        {
          id: 'welcome-role',
          kind: 'action',
          action: 'AddRole',
          values: {
            role: { from: 'role', roleId: '' },
            member: { from: 'context', path: 'member' },
          },
        },
      ],
    }),
  },
  {
    id: 'young-account',
    icon: 'Shield',
    build: (): Recipe => ({
      trigger: { type: 'OnMemberJoin' },
      steps: [
        {
          id: 'young-check',
          kind: 'condition',
          match: 'all',
          tests: [
            { id: 'young-test', condition: 'member.accountAge', operator: 'lt', value: { from: 'number', value: 7 } },
          ],
          then: [
            {
              id: 'young-alert',
              kind: 'action',
              action: 'SendMessage',
              values: {
                text: { from: 'text', template: '⚠️ Compte récent : {member.tag} ({member.accountAgeDays} jours)' },
                channel: { from: 'channel', channelId: '' },
              },
            },
          ],
          otherwise: [],
        },
      ],
    }),
  },
  {
    id: 'anti-invite',
    icon: 'AlertTriangle',
    build: (): Recipe => ({
      trigger: { type: 'OnMessageSend' },
      steps: [
        {
          id: 'invite-check',
          kind: 'condition',
          match: 'all',
          tests: [
            { id: 'invite-test', condition: 'message.contains', value: { from: 'text', template: 'discord.gg' } },
          ],
          then: [
            {
              id: 'invite-timeout',
              kind: 'action',
              action: 'TimeoutMember',
              values: {
                member: { from: 'context', path: 'member' },
                minutes: { from: 'number', value: 10 },
                reason: { from: 'text', template: 'Lien d\'invitation non autorisé' },
              },
            },
          ],
          otherwise: [],
        },
      ],
    }),
  },
  {
    id: 'level-reward',
    icon: 'Sparkles',
    build: (): Recipe => ({
      trigger: { type: 'OnLevelUp' },
      steps: [
        {
          id: 'level-message',
          kind: 'action',
          action: 'SendMessage',
          values: {
            text: { from: 'text', template: '🎉 {member.displayName} passe niveau {level} !' },
            channel: { from: 'channel', channelId: '' },
          },
        },
      ],
    }),
  },
  // Rôles par réaction emoji : deux workflows, l'un donne le rôle, l'autre le
  // retire quand la réaction part. Le message visé se règle sur le déclencheur.
  {
    id: 'reaction-role',
    icon: 'Smile',
    build: (): Recipe => ({
      trigger: { type: 'OnReactionAdd' },
      steps: [
        {
          id: 'reaction-role-add',
          kind: 'action',
          action: 'AddRole',
          values: {
            role: { from: 'role', roleId: '' },
            member: { from: 'context', path: 'member' },
          },
        },
      ],
    }),
  },
  {
    id: 'reaction-role-remove',
    icon: 'Smile',
    build: (): Recipe => ({
      trigger: { type: 'OnReactionRemove' },
      steps: [
        {
          id: 'reaction-role-drop',
          kind: 'action',
          action: 'RemoveRole',
          values: {
            role: { from: 'role', roleId: '' },
            member: { from: 'context', path: 'member' },
          },
        },
      ],
    }),
  },
  {
    id: 'ticket-welcome',
    icon: 'TextBubble',
    build: (): Recipe => ({
      trigger: { type: 'OnTicketCreated' },
      steps: [
        {
          id: 'ticket-message',
          kind: 'action',
          action: 'SendMessage',
          values: {
            text: {
              from: 'text',
              template: 'Bonjour {member.displayName}, décris ton problème en détail, un membre du staff arrive.',
            },
            channel: { from: 'context', path: 'channel' },
          },
        },
      ],
    }),
  },
];
