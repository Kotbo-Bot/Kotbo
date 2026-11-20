import { describe, expect, test } from 'bun:test';
import { SUGGESTION_STATUS_COLORS } from '@kotbo/shared';
import {
  buildSuggestionMessage,
  buildSuggestionNotice,
  isSuggestionMessageFor,
  type SuggestionMessageLabels,
  type SuggestionMessageView,
  type SuggestionNoticeLabels,
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
  categoryField: 'Catégorie',
  voteUp: 'Pour',
  voteDown: 'Contre',
  footer: 'ID de la suggestion : {id}',
  status: {
    PENDING: 'En cours d\'évaluation',
    APPROVED: 'Approuvée par le staff',
    IN_PROGRESS: 'En cours de réalisation',
    REJECTED: 'Refusée par le staff',
    IMPLEMENTED: 'Mise en place',
  },
};

const PENDING: SuggestionMessageView = {
  id: 'cmsugg1',
  title: null,
  category: null,
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

  test('un titre saisi remplace le titre générique', () => {
    expect(render({ ...PENDING, title: 'Salon memes' }).embed.title).toBe('Salon memes');
  });

  test('une catégorie s\'affiche avant le statut', () => {
    const { embed } = render({ ...PENDING, category: 'Événements' });
    expect(embed.fields?.[0]).toEqual({ name: 'Catégorie', value: 'Événements', inline: true });
    expect(embed.fields?.[1].name).toBe('Statut');
  });

  test('en cours avec votes ouverts : réponse affichée, boutons actifs', () => {
    const { embed, buttons } = render({ ...PENDING, status: 'IN_PROGRESS', responseText: 'On s\'y met', votingOpen: true });
    expect(embed.fields?.[0].value).toBe('En cours de réalisation');
    expect(embed.fields?.[2].value).toBe('On s\'y met');
    expect(buttons.every((b) => !b.disabled)).toBe(true);
  });

  test('sans photo : auteur sans icône', () => {
    const { embed } = render({ ...PENDING, authorAvatarUrl: null });
    expect(embed.author).toEqual({ name: 'Alice' });
  });
});

describe('avis de décision envoyé à l\'auteur', () => {
  const NOTICE: SuggestionNoticeLabels = {
    title: 'Ta suggestion sur {server}',
    contentField: 'Ta suggestion',
    responseField: 'Réponse du staff',
    decided: {
      APPROVED: 'Le staff a approuvé ta suggestion.',
      IN_PROGRESS: 'Ta suggestion est en cours de réalisation.',
      REJECTED: 'Le staff a refusé ta suggestion.',
      IMPLEMENTED: 'Ta suggestion a été mise en place.',
    },
  };

  test('statut, suggestion, réponse et lien vers le message', () => {
    const embed = buildSuggestionNotice({
      guildName: 'Kotbo',
      status: 'APPROVED',
      title: null,
      content: 'Un salon memes',
      responseText: 'Bonne idée',
      messageUrl: 'https://discord.com/channels/1/2/3',
    }, NOTICE).toJSON();
    expect(embed.title).toBe('Ta suggestion sur Kotbo');
    expect(embed.description).toBe('Le staff a approuvé ta suggestion.');
    expect(embed.url).toBe('https://discord.com/channels/1/2/3');
    expect(embed.color).toBe(parseInt(SUGGESTION_STATUS_COLORS.APPROVED.slice(1), 16));
    expect(embed.fields).toEqual([
      { name: 'Ta suggestion', value: 'Un salon memes', inline: false },
      { name: 'Réponse du staff', value: 'Bonne idée', inline: false },
    ]);
  });

  test('le titre plutôt que le texte, et pas de champ de réponse vide', () => {
    const embed = buildSuggestionNotice({
      guildName: 'Kotbo',
      status: 'REJECTED',
      title: 'Salon memes',
      content: 'x'.repeat(3000),
      responseText: null,
      messageUrl: null,
    }, NOTICE).toJSON();
    expect(embed.fields).toEqual([{ name: 'Ta suggestion', value: 'Salon memes', inline: false }]);
    expect(embed.url).toBeUndefined();
  });

  test('un long texte sans titre est coupé sous la limite d\'un champ', () => {
    const embed = buildSuggestionNotice({
      guildName: 'Kotbo',
      status: 'IMPLEMENTED',
      title: null,
      content: 'x'.repeat(3000),
      responseText: null,
      messageUrl: null,
    }, NOTICE).toJSON();
    expect(embed.fields?.[0].value.length).toBeLessThanOrEqual(1024);
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
