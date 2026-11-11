import { describe, expect, test } from 'bun:test';
import { applicationCommands } from '../../commands.js';

// Accents français absents de l'anglais : un nom, une description ou un choix de
// base qui en contient est du français que verrait un serveur réglé en anglais.
const FRENCH = /[éèêàâùûçôîœ«»]/i;

// Cliquet : commandes pas encore traduites. La liste ne doit que rétrécir.
const PENDING = new Set<string>(['boutique', 'excuse', 'market', 'simulation']);

// Noms propres volontairement en français, quelle que soit la langue.
const ALLOWED = new Set(['Français']);

type Node = {
  name: string;
  description?: string;
  name_localizations?: Record<string, string> | null;
  description_localizations?: Record<string, string> | null;
  options?: Node[];
  choices?: { name: string; name_localizations?: Record<string, string> | null }[];
};

function frenchLeaks(node: Node, path: string): string[] {
  const here = `${path}${node.name}`;
  const leaks: string[] = [];
  if (FRENCH.test(node.name)) leaks.push(`${here} (nom)`);
  if (node.description && FRENCH.test(node.description)) leaks.push(`${here} : ${node.description}`);
  if (node.description === 'No description') leaks.push(`${here} : clé de description manquante`);
  for (const choice of node.choices ?? []) {
    if (FRENCH.test(choice.name) && !ALLOWED.has(choice.name)) leaks.push(`${here} choix : ${choice.name}`);
  }
  for (const child of node.options ?? []) leaks.push(...frenchLeaks(child, `${here} `));
  return leaks;
}

describe('commandes localisées', () => {
  const commands = applicationCommands.map((c) => c.data.toJSON() as Node);

  test('aucun texte français dans les noms, descriptions et choix de base', () => {
    const leaks = commands
      .filter((c) => !PENDING.has(c.name))
      .flatMap((c) => frenchLeaks(c, '/'));
    expect(leaks).toEqual([]);
  });

  test('la liste des commandes en attente ne contient que des commandes encore fautives', () => {
    const stale = [...PENDING].filter((name) => {
      const cmd = commands.find((c) => c.name === name);
      return !cmd || frenchLeaks(cmd, '/').length === 0;
    });
    expect(stale).toEqual([]);
  });
});
