import { describe, expect, test } from 'bun:test';
import { buildEmbedMessage } from '../../services/features/workflow/embedMessage';

describe('buildEmbedMessage', () => {
  test('place le texte au-dessus de l’embed et laisse ses mentions notifier', () => {
    const message = buildEmbedMessage({ title: 'Annonce', description: 'Ouverture', content: '<@&123> réveillez-vous', color: 0x5865f2 });
    expect(message?.content).toBe('<@&123> réveillez-vous');
    expect(message?.allowedMentions).toEqual({ parse: ['users', 'roles'] });
    expect(message?.embeds[0]?.data.title).toBe('Annonce');
  });

  test('@everyone et @here ne notifient jamais', () => {
    const message = buildEmbedMessage({ title: 'Annonce', description: '', content: '@everyone', color: 0 });
    expect(message?.allowedMentions.parse).not.toContain('everyone');
  });

  test('sans texte au-dessus, aucun contenu et aucune mention', () => {
    const message = buildEmbedMessage({ title: '', description: 'Seul', content: '  ', color: 0 });
    expect(message?.content).toBeUndefined();
    expect(message?.allowedMentions).toEqual({ parse: [] });
  });

  test('coupe le texte au-dessus à la limite Discord de 2000 caractères', () => {
    const message = buildEmbedMessage({ title: 'T', description: '', content: 'a'.repeat(2500), color: 0 });
    expect(message?.content?.length).toBe(2000);
  });

  test('rien à envoyer sans titre ni description', () => {
    expect(buildEmbedMessage({ title: '', description: '', content: 'ping', color: 0 })).toBeNull();
  });
});
