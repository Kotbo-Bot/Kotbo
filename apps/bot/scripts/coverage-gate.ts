import { spawnSync } from 'node:child_process';

// TODO: augmenter progressivement ces seuils avec l'ajout de tests.
const minLines = Number(process.env.KOTBO_COVERAGE_LINES ?? '30');
const minFuncs = Number(process.env.KOTBO_COVERAGE_FUNCS ?? '32');

// --isolate : mock.module est global au process et n'est jamais annule, donc
// un mock partiel pose par un fichier casse les fichiers executes ensuite.
// --timeout : les tests qui decodent ou composent une image tiennent largement
// dans les 5 s par defaut seuls, mais pas quand toute la suite tourne en
// parallele, encore moins sous instrumentation de couverture.
// Doit rester aligne avec le script test:unit.
const run = spawnSync('bun', ['test', '--isolate', '--timeout', '30000', '--coverage', 'src/tests'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  stdio: 'pipe',
  env: {
    ...process.env,
    BUN_TEST_RUNNING: '1',
  },
  // En CI, Bun liste chaque test réussi : la sortie dépasse le plafond de 1 Mio
  // par défaut, au-delà duquel spawnSync tue les tests (ENOBUFS).
  maxBuffer: 256 * 1024 * 1024,
});

const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
process.stdout.write(output);

// process.exitCode et jamais process.exit() : vers un pipe (la CI), exit()
// coupait l'écriture de la sortie en plein milieu, résumé des échecs compris.
process.exitCode = check();

function check(): number {
  // Récapitulatif en fin de log : la sortie complète fait plusieurs Mio et les
  // visualiseurs de CI (ex. GitHub Actions) tronquent l'affichage web.
  const stripAnsi = (str: string) => str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
  const rawLines = output.split(/\r?\n/);

  const failureBlocks: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const clean = stripAnsi(rawLines[i]);
    // Détecte les symboles d'échec Bun (croix unicode, (fail), préfixe d'erreur)
    if (/^\s*([✗✕]|\(fail\)|error:)/i.test(clean) || /\berror:\s*expect\(/i.test(clean)) {
      const start = Math.max(0, i - 4);
      const end = Math.min(rawLines.length - 1, i + 15);
      const block: string[] = [];
      for (let j = start; j <= end; j++) {
        block.push(stripAnsi(rawLines[j]));
      }
      failureBlocks.push(block.join('\n'));
      i = end;
    }
  }

  const summaryLines = rawLines
    .map((l) => stripAnsi(l).trim())
    .filter((l) => /^\d+\s+(pass|fail)\b/i.test(l) || /^Ran\s+\d+\s+tests\b/i.test(l));

  if (run.status !== 0 || failureBlocks.length > 0) {
    console.error('\n==================== ÉCHECS DE TESTS DÉTECTÉS ====================');
    if (failureBlocks.length > 0) {
      console.error(failureBlocks.join('\n----------------------------------------\n'));
    }
    if (summaryLines.length > 0) {
      console.error('\nBilan : ' + summaryLines.join(' | '));
    }
    console.error('==================================================================\n');
  }

  if (run.error) console.error(`Exécution des tests interrompue : ${run.error.message}`);
  if (run.signal) console.error(`Tests tués par le signal ${run.signal} (mémoire épuisée ?).`);
  if (run.status !== 0) return run.status ?? 1;

  const match = output.match(/All files\s+\|\s+([0-9.]+)\s+\|\s+([0-9.]+)\s+\|/);
  if (!match) {
    console.error('Impossible de lire la table de couverture Bun (ligne All files introuvable).');
    return 1;
  }

  const funcs = Number(match[1]);
  const lines = Number(match[2]);

  if (Number.isNaN(funcs) || Number.isNaN(lines)) {
    console.error('Valeurs de couverture invalides.');
    return 1;
  }

  if (funcs < minFuncs || lines < minLines) {
    console.error(
      `Seuil de couverture non atteint: fonctions=${funcs.toFixed(2)}% (min ${minFuncs}%), lignes=${lines.toFixed(2)}% (min ${minLines}%).`,
    );
    return 1;
  }

  console.log(
    `Seuil de couverture valide: fonctions=${funcs.toFixed(2)}% (min ${minFuncs}%), lignes=${lines.toFixed(2)}% (min ${minLines}%).`,
  );
  return 0;
}
