import { describe, expect, it } from 'bun:test';
import { messagePreviewOf, permissionHint, portLabel, readValue, roleChangeOf } from './workflowReplay';

const alice = { kind: 'Member', id: 'u1', tag: 'alice', displayName: 'Alice' };
const general = { kind: 'Channel', id: 'c1', name: 'général', categoryName: null };
const newcomer = { kind: 'Role', id: 'r1', name: 'Nouveau' };

describe('portLabel', () => {
  it('donne le libellé du port plutôt que son identifiant', () => {
    expect(portLabel('SendMessage', 'channel', 'inputs')).toBe('Salon');
    expect(portLabel('SendMessage', 'text', 'inputs')).toBe('Texte');
  });

  it('garde l identifiant d une valeur que le catalogue ne décrit pas', () => {
    expect(portLabel('If', 'branche', 'outputs')).toBe('branche');
  });
});

describe('readValue', () => {
  it('montre un membre, un salon et un rôle comme Discord', () => {
    expect(readValue(alice)).toEqual({ kind: 'mention', text: '@Alice' });
    expect(readValue(general)).toEqual({ kind: 'mention', text: '#général' });
    expect(readValue(newcomer)).toEqual({ kind: 'mention', text: '@Nouveau' });
  });

  it('montre un message par son contenu', () => {
    expect(readValue({ kind: 'Message', id: 'm1', content: 'Bonjour', channelId: 'c1', authorId: 'u1' }))
      .toEqual({ kind: 'text', text: 'Bonjour' });
  });

  it('montre une valeur absente comme vide', () => {
    expect(readValue(null)).toEqual({ kind: 'empty', text: '-' });
    expect(readValue([])).toEqual({ kind: 'empty', text: '-' });
  });

  it('écrit oui ou non pour un booléen', () => {
    expect(readValue(true)).toEqual({ kind: 'text', text: 'oui' });
  });
});

describe('messagePreviewOf', () => {
  it('rend le message envoyé dans son salon', () => {
    expect(messagePreviewOf('SendMessage', { channel: general, text: 'Bonjour Alice' })).toEqual({
      channel: 'général',
      content: 'Bonjour Alice',
    });
  });

  it('rend le message tenu à jour comme un message', () => {
    expect(messagePreviewOf('KeepMessage', { channel: general, text: 'Nous sommes 250' })).toEqual({
      channel: 'général',
      content: 'Nous sommes 250',
    });
  });

  it('rend un encadré avec sa couleur', () => {
    expect(messagePreviewOf('SendEmbed', { channel: general, title: 'Bienvenue', description: 'Lis le règlement' }, { color: '#ff0000' }))
      .toEqual({ channel: 'général', embed: { title: 'Bienvenue', description: 'Lis le règlement', color: '#ff0000' } });
  });

  it('ignore une couleur qui n est pas un code hexadécimal', () => {
    expect(messagePreviewOf('SendEmbed', { channel: general, title: 'T' }, { color: 'red;x' })?.embed?.color).toBe('#5865F2');
  });

  it('rend l écriture dans les logs comme un encadré du salon de logs', () => {
    expect(messagePreviewOf('SendLogMessage', { text: 'Alice est arrivée' })).toEqual({
      channel: 'logs',
      embed: { title: '', description: 'Alice est arrivée', color: '#5865F2' },
    });
  });

  it('ne rend rien pour une action qui n écrit pas', () => {
    expect(messagePreviewOf('AddRole', { member: alice, role: newcomer })).toBeNull();
  });
});

describe('roleChangeOf', () => {
  it('décrit le rôle donné ou retiré au membre', () => {
    expect(roleChangeOf('AddRole', { member: alice, role: newcomer })).toEqual({ member: '@Alice', role: '@Nouveau', added: true });
    expect(roleChangeOf('RemoveRole', { member: alice, role: newcomer })).toEqual({ member: '@Alice', role: '@Nouveau', added: false });
    expect(roleChangeOf('AddTemporaryRole', { member: alice, role: newcomer })?.added).toBe(true);
  });

  it('ne décrit rien sans membre ou sans rôle', () => {
    expect(roleChangeOf('AddRole', { member: alice })).toBeNull();
    expect(roleChangeOf('SendMessage', { channel: general })).toBeNull();
  });
});

describe('permissionHint', () => {
  it('dit quoi faire quand il manque une permission dans un salon', () => {
    expect(permissionHint('Envoyer un message : il manque au bot « Envoyer des messages », « Intégrer des liens » dans #général'))
      .toEqual({ permissions: ['Envoyer des messages', 'Intégrer des liens'], channel: 'général' });
  });

  it('dit quoi faire quand il manque une permission sur le serveur', () => {
    expect(permissionHint('Ouvrir un ticket : il manque au bot « Gérer les salons » sur le serveur'))
      .toEqual({ permissions: ['Gérer les salons'], channel: null });
  });

  it('ne dit rien pour une autre erreur', () => {
    expect(permissionHint('Membre : alice est introuvable sur le serveur')).toBeNull();
    expect(permissionHint(null)).toBeNull();
  });
});
