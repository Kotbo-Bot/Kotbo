import { describe, expect, test } from 'bun:test';
import {
  fillTemplate,
  renderMarkdown,
  type PreviewLabels,
  type PreviewSample,
} from '../../../../dashboard/src/lib/giveawayPreview.ts';

/**
 * Aperçu de l'annonce, rendu dans le dashboard par @arcscord/discord-ui. Le
 * gabarit, librement saisi, ressort en Markdown Discord : c'est la lib qui le
 * met en forme et en échappe le HTML, le rendu ne produit aucune balise.
 */

const labels: PreviewLabels = {
  rewardsTitle: 'En plus du lot :',
  coins: 'Pièces :',
  xp: 'XP RPG :',
  item: 'Objet :',
  validation: 'Validation du staff requise',
  bonusRolesTitle: 'Chances supplémentaires :',
  endsIn: 'dans',
};

const sample: PreviewSample = {
  prize: 'Un mois de Nitro',
  description: 'Merci de votre participation',
  winnerCount: 2,
  participants: 37,
  winners: ['Camille', 'Dominique'],
  host: 'Alex',
  serverName: 'Mon serveur',
  bonusRoles: [{ name: 'Actifs', weight: 2 }, { name: 'Boosters', weight: 5 }],
  coins: 250,
  xp: 100,
  item: '',
  needValidation: false,
  endsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
};

/** Nom de la mention `<@id>` d'après les entités renvoyées. */
function mentionNames(markdown: string, users: Record<string, { name: string }> = {}): string {
  return markdown.replace(/<@(\d{17,20})>/g, (_, id: string) => `@${users[id]?.name ?? '?'}`);
}

describe('renderMarkdown', () => {
  test('laisse le HTML d\'un gabarit en texte, sans le transformer', () => {
    // Plus de HTML construit ici : la lib affiche le texte tel quel.
    expect(renderMarkdown('<img src=x onerror="alert(1)">', sample, labels).markdown)
      .toBe('<img src=x onerror="alert(1)">');
  });

  test('mentions du remplissage en vraies mentions nommées, virgule hors mention', () => {
    const { markdown, entities } = renderMarkdown('Bravo {winners} de {server}', sample, labels);
    expect(markdown).toMatch(/^Bravo <@\d{18}>, <@\d{18}> de Mon serveur$/);
    expect(mentionNames(markdown, entities.users)).toBe('Bravo @Camille, @Dominique de Mon serveur');
  });

  test('assemble le gabarit : la variable porte déjà l\'arobase', () => {
    const { markdown, entities } = renderMarkdown('**{prize}** pour {host}', sample, labels);
    expect(mentionNames(markdown, entities.users)).toBe('**Un mois de Nitro** pour @Alex');
  });

  test('titre ou pied : le nom reste écrit en clair, comme Discord', () => {
    expect(renderMarkdown('Concours de {host}', sample, labels, { mentions: false }))
      .toEqual({ markdown: 'Concours de @Alex', entities: {} });
  });

  test('laisse nue une arobase simplement tapée', () => {
    // Discord ne fait rien d'une arobase écrite à la main : seule une vraie
    // mention devient une pastille, et l'aperçu doit dire la même chose.
    expect(renderMarkdown('écris @Camille pour la retrouver', sample, labels))
      .toEqual({ markdown: 'écris @Camille pour la retrouver', entities: {} });
  });

  test('mention d\'un rôle nommé avec un emoji ou plusieurs mots', () => {
    // La pastille se devinait du texte et s'arrêtait au premier caractère qui
    // n'était ni lettre ni chiffre : le nom sortait nu, emoji compris.
    const orne = { ...sample, bonusRoles: [{ name: '🔺 Ancien Membre', weight: 4 }] };
    const { markdown, entities } = renderMarkdown('{bonusRoles}', orne, labels);
    expect(mentionNames(markdown, entities.users)).toContain('@🔺 Ancien Membre ×4');
  });

  test('rôles avantagés, le plus favorisé devant', () => {
    const { markdown, entities } = renderMarkdown('{bonusRoles}', sample, labels);
    expect(mentionNames(markdown, entities.users))
      .toBe('\n**Chances supplémentaires :**\n@Boosters ×5\n@Actifs ×2\n');
  });

  test('émojis du serveur en entité, pour leur image', () => {
    const { entities } = renderMarkdown('🎉 <:gift:123456789012345678> {prize}', sample, labels);
    expect(entities.emojis?.['123456789012345678']).toMatchObject({ name: 'gift' });
  });
});

describe('fillTemplate', () => {
  test('remplace les variables du concours', () => {
    expect(fillTemplate('{prize} pour {winnerCount} sur {participants}', sample, labels))
      .toBe('Un mois de Nitro pour 2 sur 37');
  });

  test('compose les blocs des récompenses', () => {
    const rewards = fillTemplate('{bonus}', sample, labels);
    expect(rewards).toContain('**En plus du lot :**');
    expect(rewards).toContain('**Pièces :** +250');
    expect(rewards).not.toContain('Objet');
  });

  test('efface les blocs facultatifs quand il n\'y a rien à montrer', () => {
    const empty = { ...sample, description: '', coins: 0, xp: 0, item: '', bonusRoles: [] };

    expect(fillTemplate('{description}{bonus}{bonusRoles}', empty, labels)).toBe('');
  });

  test('rend la fin de concours lisible plutôt qu\'en horodatage Discord', () => {
    const rendered = fillTemplate('{endsRelative}', sample, labels);

    // Discord affiche un compte à rebours vivant, impossible à reproduire.
    expect(rendered).toBe('dans 2 j');
    expect(rendered).not.toContain('<t:');
  });
});
