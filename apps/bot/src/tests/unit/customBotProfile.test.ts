import { describe, expect, test } from 'bun:test';
import { parseDataImage, presenceFrom } from '../../services/system/customBotProfile.js';

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);

describe('image importée pour le profil du bot', () => {
  test('accepte une data URI dont les octets sont bien ceux du type annoncé', () => {
    expect(parseDataImage(`data:image/png;base64,${PNG_HEADER.toString('base64')}`)).not.toBeNull();
  });

  test('refuse un type annoncé qui ment, le SVG et le texte', () => {
    expect(parseDataImage(`data:image/gif;base64,${PNG_HEADER.toString('base64')}`)).toBeNull();
    expect(parseDataImage(`data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`)).toBeNull();
    expect(parseDataImage('https://exemple.fr/a.png')).toBeNull();
  });
});

describe('statut du bot', () => {
  test("une activité sans texte n'est pas affichée", () => {
    expect(presenceFrom({ botStatus: 'IDLE', activityType: 'PLAYING', activityText: '' })).toEqual({ status: 'idle', activities: [] });
  });

  test("l'URL ne sert qu'au streaming", () => {
    const { activities } = presenceFrom({ activityType: 'WATCHING', activityText: 'le serveur', activityUrl: 'https://twitch.tv/x' });
    expect(activities[0].url).toBeUndefined();
  });
});
