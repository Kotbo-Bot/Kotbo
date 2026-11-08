import { describe, expect, it } from 'bun:test';
import { previewChannelName, previewTemplate, previewText } from './workflowPreview';

describe('previewTemplate', () => {
  it('remplit le membre par un pseudo d exemple, comme le moteur l écrit', () => {
    expect(previewTemplate('Bienvenue {member} !', 'OnMemberJoin')).toEqual([
      { text: 'Bienvenue ', filled: false },
      { text: 'Alice', filled: true },
      { text: ' !', filled: false },
    ]);
  });

  it('remplit les propriétés d une entité', () => {
    expect(previewText(previewTemplate('{member.tag} ({member.accountAgeDays} j)', 'OnMemberJoin'))).toBe('alice (120 j)');
  });

  it('prend le vrai nom du serveur quand il est connu', () => {
    expect(previewText(previewTemplate('Bienvenue sur {guild.name}', 'OnMemberJoin', { guildName: 'Kotbo' }))).toBe('Bienvenue sur Kotbo');
    expect(previewText(previewTemplate('Bienvenue sur {guild.name}', 'OnMemberJoin'))).toBe('Bienvenue sur Mon serveur');
  });

  it('montre un texte du déclencheur par son libellé', () => {
    expect(previewTemplate('Motif : {reason}', 'OnSanctionApplied')[1]).toEqual({ text: 'Motif', filled: true });
  });

  it('remplit un nombre du déclencheur', () => {
    expect(previewText(previewTemplate('Niveau {level} !', 'OnLevelUp'))).toBe('Niveau 5 !');
  });

  it('laisse tel quel un jeton que le déclencheur ne fournit pas', () => {
    // Le moteur ne le remplace pas non plus : le message part avec le jeton brut.
    expect(previewTemplate('Niveau {level}', 'OnMemberJoin')).toEqual([
      { text: 'Niveau {level}', filled: false },
    ]);
  });

  it('rend un texte vide sans segment', () => {
    expect(previewTemplate('', 'OnMemberJoin')).toEqual([]);
  });
});

describe('previewChannelName', () => {
  const channels = [{ id: 'c1', name: 'accueil' }];

  it('donne le nom d un salon choisi dans la liste', () => {
    expect(previewChannelName({ from: 'channel', channelId: 'c1' }, channels)).toBe('accueil');
  });

  it('donne un nom d exemple pour un salon venu du déclencheur ou pas encore choisi', () => {
    expect(previewChannelName({ from: 'context', path: 'channel' }, channels)).toBe('général');
    expect(previewChannelName(undefined, channels)).toBe('général');
  });
});
