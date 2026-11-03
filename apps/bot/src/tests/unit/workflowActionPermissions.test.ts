/**
 * Permissions qu'une action demande au bot dans le salon où elle agit.
 *
 * C'est ce qui permet à l'essai à blanc de prévenir avant le vrai échec, et à
 * la vraie exécution de dire quelle permission manque au lieu de l'erreur
 * opaque de Discord.
 */
import { describe, expect, test } from 'bun:test';
import {
  CHANNEL_REQUIREMENTS,
  GUILD_REQUIREMENTS,
  describeMissingPermissions,
  inThread,
  missingPermissions,
} from '../../services/features/workflow/actionPermissions';

describe('permissions requises par action', () => {
  test('un encadré demande de voir le salon, d y écrire et d intégrer des liens', () => {
    expect(CHANNEL_REQUIREMENTS.SendEmbed).toEqual({
      target: 'channel',
      permissions: ['ViewChannel', 'SendMessages', 'EmbedLinks'],
    });
  });

  test('une réaction se pose dans le salon du message', () => {
    expect(CHANNEL_REQUIREMENTS.AddReaction?.target).toBe('message');
    expect(CHANNEL_REQUIREMENTS.AddReaction?.permissions).toContain('AddReactions');
  });

  test('l écriture dans les logs vise le salon de logs', () => {
    expect(CHANNEL_REQUIREMENTS.SendLogMessage?.target).toBe('logs');
  });

  test('une action sans salon n en demande aucune', () => {
    expect(CHANNEL_REQUIREMENTS.GiveCoins).toBeUndefined();
  });
});

describe('missingPermissions', () => {
  test('ne garde que les permissions absentes, dans l ordre demandé', () => {
    const granted = new Set(['ViewChannel']);
    expect(missingPermissions(['ViewChannel', 'SendMessages', 'EmbedLinks'], (p) => granted.has(p)))
      .toEqual(['SendMessages', 'EmbedLinks']);
  });

  test('rien ne manque quand tout est accordé', () => {
    expect(missingPermissions(['ViewChannel', 'SendMessages'], () => true)).toEqual([]);
  });
});

describe('describeMissingPermissions', () => {
  test('nomme les permissions et le salon en français', () => {
    expect(describeMissingPermissions(['SendMessages', 'EmbedLinks'], 'général'))
      .toBe('il manque au bot « Envoyer des messages », « Intégrer des liens » dans #général');
  });

  test('parle du serveur pour une permission générale', () => {
    expect(describeMissingPermissions(['ManageChannels'], null))
      .toBe('il manque au bot « Gérer les salons » sur le serveur');
  });
});

describe('permissions générales', () => {
  test('ouvrir un ticket demande de gérer les salons', () => {
    expect(GUILD_REQUIREMENTS.CreateTicket).toEqual(['ManageChannels']);
  });

  test('changer un surnom demande de gérer les pseudos', () => {
    expect(GUILD_REQUIREMENTS.SetNickname).toEqual(['ManageNicknames']);
  });
});

describe('inThread', () => {
  test('dans un fil, écrire demande la permission propre aux fils', () => {
    expect(inThread(['ViewChannel', 'SendMessages', 'EmbedLinks']))
      .toEqual(['ViewChannel', 'SendMessagesInThreads', 'EmbedLinks']);
  });
});
