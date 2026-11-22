import { describe, expect, test } from 'bun:test';
import { renderMarkdown, type PreviewLabels, type PreviewSample } from './giveawayPreview';

const labels: PreviewLabels = {
  rewardsTitle: 'Récompenses', coins: 'Pièces', xp: 'XP', item: 'Objet', validation: 'Validation', bonusRolesTitle: 'Rôles avantagés', endsIn: 'dans',
};

const sample: PreviewSample = {
  prize: 'Nitro', description: '', winnerCount: 2, participants: 37, winners: ['Lina', 'Tom'], host: 'Chris Admin', serverName: 'Perso',
  bonusRoles: [{ name: 'Booster', weight: 2 }], coins: 0, xp: 0, item: '', needValidation: false, endsAt: new Date(Date.now() + 86_400_000),
};

describe('renderMarkdown', () => {
  test('mentions du remplissage en vraies mentions nommées, noms à espaces compris', () => {
    const { markdown, entities } = renderMarkdown('**{prize}** par {host}, gagnants : {winners}', sample, labels);
    const names = Object.values(entities.users ?? {}).map((user) => user.name).sort();
    expect(names).toEqual(['Chris Admin', 'Lina', 'Tom']);
    expect(markdown).toMatch(/^\*\*Nitro\*\* par <@\d{18}>, gagnants : <@\d{18}>, <@\d{18}>$/);
  });

  test('titre ou pied : le nom reste en clair', () => {
    expect(renderMarkdown('Concours de {host}', sample, labels, { mentions: false })).toEqual({ markdown: 'Concours de @Chris Admin', entities: {} });
  });

  test('une arobase tapée dans le gabarit reste du texte', () => {
    expect(renderMarkdown('Bonjour @everyone et @Lina', sample, labels).markdown).toBe('Bonjour @everyone et @Lina');
  });

  test('émojis du serveur en entité', () => {
    const { entities } = renderMarkdown('🎉 <:gift:123456789012345678> {prize}', sample, labels);
    expect(entities.emojis?.['123456789012345678']).toMatchObject({ name: 'gift' });
  });
});
