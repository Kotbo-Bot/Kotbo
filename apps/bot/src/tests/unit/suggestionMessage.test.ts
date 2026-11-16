import { describe, expect, test } from 'bun:test';
import { SUGGESTION_STATUS_COLORS } from '@kotbo/shared';
import {
  buildSuggestionMessage,
  isSuggestionMessageFor,
  type SuggestionMessageLabels,
  type SuggestionMessageView,
} from '../../services/features/suggestionMessage.js';

const LABELS: SuggestionMessageLabels = {
  locale: 'fr',
  title: 'Nouvelle suggestion',
  statusField: 'Statut',
  votesField: 'Votes',
  finalVotesField: 'Votes finaux',
  votesValue: 'Pour : `{up}` | Contre : `{down}`',
  responseField: 'Réponse de la modération',
  noResponse: 'Aucun commentaire.',
  voteUp: 'Pour',
  voteDown: 'Contre',
  footer: 'ID de la suggestion : {id}',
  status: {
    PENDING: 'En cours d\'évaluation',
    APPROVED: 'Approuvée par le staff',
    REJECTED: 'Refusée par le staff',
    IMPLEMENTED: 'Mise en place',
  },
};

const PENDING: SuggestionMessageView = {
  id: 'cmsugg1',
  authorName: 'Alice',
  authorAvatarUrl: 'https://cdn/a.png',
  content: 'Un salon pour les memes',
  status: 'PENDING',
  upvotes: 3,
  downvotes: 1,
  responseText: null,
  votingOpen: true,
};

function render(view: SuggestionMessageView) {
  const message = buildSuggestionMessage(view, LABELS);
  return {
    embed: message.embeds[0].toJSON(),
    buttons: message.components[0].toJSON().components as Array<{ custom_id: string; label: string; disabled?: boolean }>,
  };
}

describe('message d\'une suggestion', () => {
  test('en attente : statut, votes, auteur et boutons actifs', () => {
    const { embed, buttons } = render(PENDING);
    expect(embed.title).toBe('Nouvelle suggestion');
    expect(embed.description).toBe('Un salon pour les memes');
    expect(embed.author).toEqual({ name: 'Alice', icon_url: 'https://cdn/a.png' });
    expect(embed.color).toBe(parseInt(SUGGESTION_STATUS_COLORS.PENDING.slice(1), 16));
    expect(embed.fields).toEqual([
      { name: 'Statut', value: 'En cours d\'évaluation', inline: true },
      { name: 'Votes', value: 'Pour : `3` | Contre : `1`', inline: true },
    ]);
    expect(embed.footer?.text).toBe('ID de la suggestion : cmsugg1');
    expect(buttons.map((b) => b.custom_id)).toEqual(['suggest_vote:cmsugg1:up', 'suggest_vote:cmsugg1:down']);
    expect(buttons.map((b) => b.label)).toEqual(['Pour · 3', 'Contre · 1']);
    expect(buttons.every((b) => !b.disabled)).toBe(true);
  });

  test('tranchée : votes finaux, réponse et boutons scellés', () => {
    const { embed, buttons } = render({ ...PENDING, status: 'REJECTED', responseText: 'Pas pour le moment.', votingOpen: false });
    expect(embed.color).toBe(parseInt(SUGGESTION_STATUS_COLORS.REJECTED.slice(1), 16));
    expect(embed.fields).toEqual([
      { name: 'Statut', value: 'Refusée par le staff', inline: true },
      { name: 'Votes finaux', value: 'Pour : `3` | Contre : `1`', inline: true },
      { name: 'Réponse de la modération', value: 'Pas pour le moment.', inline: false },
    ]);
    expect(buttons.map((b) => b.custom_id)).toEqual(['suggest_vote_disabled_up:cmsugg1', 'suggest_vote_disabled_down:cmsugg1']);
    expect(buttons.every((b) => b.disabled)).toBe(true);
  });

  test('approuvée avec votes ouverts : la réponse est là, les boutons restent actifs', () => {
    const { embed, buttons } = render({ ...PENDING, status: 'APPROVED', responseText: null, votingOpen: true });
    expect(embed.fields?.map((f) => f.name)).toEqual(['Statut', 'Votes', 'Réponse de la modération']);
    expect(embed.fields?.[2].value).toBe('Aucun commentaire.');
    expect(buttons.map((b) => b.custom_id)).toEqual(['suggest_vote:cmsugg1:up', 'suggest_vote:cmsugg1:down']);
  });

  test('sans photo : auteur sans icône', () => {
    const { embed } = render({ ...PENDING, authorAvatarUrl: null });
    expect(embed.author).toEqual({ name: 'Alice' });
  });
});

describe('reconnaissance du message', () => {
  const asMessage = (footer: string | null, components: unknown[]) => ({
    embeds: footer ? [{ footer: { text: footer } }] : [],
    components,
  });

  test('par le pied de l\'embed, quelle que soit la langue', () => {
    expect(isSuggestionMessageFor(asMessage('Suggestion ID: cmsugg1', []), 'cmsugg1')).toBe(true);
  });

  test('par l\'identifiant des boutons d\'un message en composants', () => {
    expect(isSuggestionMessageFor(asMessage(null, [{ components: [{ custom_id: 'suggest_vote_disabled_up:cmsugg1' }] }]), 'cmsugg1')).toBe(true);
  });

  test('pas le message d\'une autre suggestion', () => {
    expect(isSuggestionMessageFor(asMessage('ID de la suggestion : cmautre', [{ custom_id: 'suggest_vote:cmautre:up' }]), 'cmsugg1')).toBe(false);
  });
});
