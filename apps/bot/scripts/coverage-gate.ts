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
  // Récapitulatif en fin de log : la sortie complète fait plusieurs Mio.
  const recap = output.split('\n').filter((line) => /\(fail\)|^\s*\d+ (pass|fail)\s*$/.test(line));
  if (recap.length) console.error(`\nRécapitulatif des tests :\n${recap.join('\n')}`);

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
