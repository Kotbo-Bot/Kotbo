import { describe, expect, test } from 'bun:test';
import {
  extractSlashCommandName,
  listSourceFiles,
  readModuleSource,
  toProjectPath,
} from './helpers/moduleContracts';

/**
 * Une commande peut exposer son `execute` de deux facons :
 *  - en declarant la fonction sur place  -> `export async function execute(...)`
 *  - en pointant une fonction importee   -> `execute: openUserHub`
 *
 * Les deux respectent le contrat. N'accepter que la premiere forme rejetait a
 * tort commands/context/contextMenuHub.ts, qui delegue au service du hub.
 */
const EXECUTE_CONTRACT = /(?:(?:export\s+)?(?:async\s+)?function\s+\w*[Ee]xecute\w*\s*\()|(?:\bexecute\s*[:=])/;

describe('Contrats des features', () => {
  test('Toutes les commandes exposent data + execute et ont un nom unique', () => {
    const commandFiles = listSourceFiles('commands');
    expect(commandFiles.length).toBeGreaterThan(0);

    const names = new Set<string>();

    for (const file of commandFiles) {
      const source = readModuleSource(file);
      const relativePath = toProjectPath(file);

      expect(source).toMatch(/(?:export\s+)?const\s+\w*[Dd]ata\s*=/);
      expect(source, `Aucun execute expose dans ${relativePath}`).toMatch(EXECUTE_CONTRACT);

      const commandName = extractSlashCommandName(source);
      expect(commandName).not.toBeNull();

      if (!commandName) continue;
      expect(names.has(commandName), `Commande dupliquée "${commandName}" dans ${relativePath}`).toBeFalse();
      names.add(commandName);
    }
  });

  test('Handlers, events, panels, services et utils exportent des symboles', () => {
    const folders = ['handlers', 'events', 'panels', 'services', 'utils'];

    for (const folder of folders) {
      const files = listSourceFiles(folder);
      expect(files.length).toBeGreaterThan(0);

      for (const file of files) {
        const source = readModuleSource(file);
        const relativePath = toProjectPath(file);
        // `export { ... } from` et `export * from` comptent : un module qui ne
        // fait que reexporter expose bien des symboles. Le contrat vise les
        // fichiers muets, pas la forme de la declaration.
        expect(source, `Aucun export trouvé dans ${relativePath}`).toMatch(
          /export\s+(const|function|async\s+function|interface|type|class|\*|\{)/,
        );
      }
    }
  });

  test("Le registre des commandes importe toutes les commandes déclarées", () => {
    const registryPath = listSourceFiles('.').find((file) => file.replace(/\\/g, '/').endsWith('/commands.ts'));
    expect(registryPath).toBeDefined();
    if (!registryPath) return;

    const registrySource = readModuleSource(registryPath);
    const commandFiles = listSourceFiles('commands');

    // Hors registre volontairement : `partenariat` est déréférencée tant que le module est en pause.
    const unregistered = new Set(['backup', 'partenariat']);

    for (const file of commandFiles) {
      const normalized = file.replace(/\\/g, '/');
      const match = normalized.match(/commands\/([^/]+)\/([^/]+)\.ts$/);
      if (!match) continue;
      const [, category, baseName] = match;
      if (unregistered.has(baseName)) continue;

      const importPath = `./commands/${category}/${baseName}.js`;
      expect(registrySource, `Commande ${baseName} non importée dans le registre`).toContain(importPath);
    }
  });

  test('Le worker BullMQ démarre après l’enregistrement de ses handlers', () => {
    const indexPath = listSourceFiles('.').find((file) => file.replace(/\\/g, '/').endsWith('/index.ts'));
    expect(indexPath).toBeDefined();
    if (!indexPath) return;

    const indexSource = readModuleSource(indexPath);
    const registerCronsIndex = indexSource.indexOf('await registerCrons(client)');
    const startWorkerIndex = indexSource.indexOf('await startBackgroundQueueWorker()');

    expect(registerCronsIndex).toBeGreaterThan(-1);
    expect(startWorkerIndex).toBeGreaterThan(registerCronsIndex);
  });
});
