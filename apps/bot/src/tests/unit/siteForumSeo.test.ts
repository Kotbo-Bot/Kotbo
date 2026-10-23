/**
 * Forum trouvable : adresses des sujets, texte brut, balisage questions-réponses,
 * étiquettes « résolu » de Discord.
 */
import { describe, expect, test } from 'bun:test';
// Chargé d'abord, comme en production : les blocs se référencent entre eux par le rendu.
import '../../services/site/sitePages.js';
import { forumTopicJsonLd, parseTopicSegment, plainDiscordText, topicSegment } from '../../services/site/siteForumPages.js';
import { isSolvedTagName } from '../../services/site/siteForumService.js';

const ID = 'cmtopic000000000000000001';

describe('adresse d’un sujet', () => {
  test('identifiant puis titre, et retour à l’identifiant', () => {
    expect(topicSegment({ id: ID, title: 'Comment réinstaller le mod ?' })).toBe(`${ID}-comment-reinstaller-le-mod`);
    expect(topicSegment({ id: ID, title: '???' })).toBe(ID);
    expect(parseTopicSegment(`${ID}-comment-reinstaller-le-mod`)).toBe(ID);
    expect(parseTopicSegment(ID)).toBe(ID);
    expect(parseTopicSegment('../etc')).toBeNull();
    expect(parseTopicSegment(`${ID}-Majuscules`)).toBeNull();
  });
});

describe('texte brut d’un message Discord', () => {
  test('mentions, emojis, code et liens retirés ou simplifiés', () => {
    expect(plainDiscordText('Salut <@123456789012345678> ! Regarde <#123456789012345678> :\n```js\ncode()\n```\n**Important** [ici](https://x.fr) <:pepe:123456789012345678>')).toBe(
      'Salut ! Regarde : Important ici :pepe:',
    );
    expect(plainDiscordText('a '.repeat(200), 20).length).toBeLessThanOrEqual(21);
  });
});

describe('balisage du sujet', () => {
  const at = new Date('2026-10-11T10:00:00Z');
  const topic = { title: 'Le mod plante au lancement', solved: false, acceptedPostId: null, replyCount: 2, createdAt: at, lastPostAt: at };
  const first = { text: 'Le jeu se ferme tout seul.', author: 'Ana', createdAt: at };
  const replies = [
    { id: 'r1', text: 'Mets à jour Java.', author: 'Bob', createdAt: at },
    { id: 'r2', text: 'Supprime le cache.', author: 'Membre', createdAt: at },
  ];

  test('discussion tant que le sujet n’est pas résolu', () => {
    const ld = forumTopicJsonLd({ topic, url: 'https://dash.kotbo.fr/s/x/forum/aide/t', first, replies });
    expect(ld?.['@type']).toBe('DiscussionForumPosting');
    expect((ld?.comment as unknown[]).length).toBe(2);
  });

  test('questions-réponses une fois résolu, réponse acceptée à part', () => {
    const ld = forumTopicJsonLd({ topic: { ...topic, solved: true, acceptedPostId: 'r2' }, url: 'https://u', first, replies });
    expect(ld?.['@type']).toBe('QAPage');
    const question = ld?.mainEntity as Record<string, unknown>;
    expect((question.acceptedAnswer as Record<string, unknown>).url).toBe('https://u#p-r2');
    expect((question.suggestedAnswer as unknown[]).length).toBe(1);
    expect(question.answerCount).toBe(2);
  });

  test('rien sans premier message, discussion si résolu sans réponse', () => {
    expect(forumTopicJsonLd({ topic, url: 'u', first: null, replies })).toBeNull();
    expect(forumTopicJsonLd({ topic: { ...topic, solved: true }, url: 'u', first, replies: [] })?.['@type']).toBe('DiscussionForumPosting');
  });
});

describe('étiquettes de forum Discord', () => {
  test('résolu sous ses formes courantes', () => {
    for (const name of ['Résolu', '✅ Solved', 'RESOLVED', 'Répondu', 'Corrigé']) expect(isSolvedTagName(name)).toBe(true);
    for (const name of ['Question', 'Bug', 'En cours']) expect(isSolvedTagName(name)).toBe(false);
  });
});
