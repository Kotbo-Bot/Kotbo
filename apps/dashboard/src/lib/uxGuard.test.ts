import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Garde-fou des parcours : un ecran ne doit pas laisser l'utilisateur sans
 * suite. Comme styleGuard.test.ts, c'est un cliquet : quand une page passe a
 * la bonne pratique, baisser le plafond ci-dessous ; il ne remonte jamais.
 *
 * - Etat vide sans suite : un « Aucune donnee » qui ne propose rien laisse
 *   l'utilisateur seul la ou il hesite le plus. Passer `actionLabel` avec
 *   `onAction` ou `actionHref` ; a defaut, dire pourquoi il n'y a rien a faire
 *   avec `reason` (bonne nouvelle, donnees qui s'accumulent, filtre vide,
 *   droits insuffisants, mode d'emploi) - voir EmptyState.svelte.
 * - « Clique sur X » dans un texte : on envoie chercher un bouton ailleurs
 *   au lieu de le mettre la. Mettre le bouton dans le message.
 */
const SRC = join(import.meta.dir, '..');
const MESSAGES = join(import.meta.dir, '..', '..', 'messages', 'fr.json');

const CEILINGS = {
  // Le dernier, « Pas encore de site » (pages/Site.svelte), attend la fin
  // d'un chantier en cours sur ce fichier : il prendra `reason="read-only"`.
  emptyStateWithoutReason: 1,
  sendsToAnotherButton: 0,
} as const;

/** Boutons hors du dashboard (Google Sheets, page de vote du membre) : rien a placer ici. */
const EXTERNAL_BUTTON_TEXTS = new Set(['recruit_script_step2', 'ste_votes_verify_user', 'ste_votes_verify_ip']);

/**
 * Dans un texte affiche : « Clique sur « X » » ou « Clique sur Recalculer ».
 * Dans un composant, seule la forme entre guillemets est cherchee : la forme
 * nue se confondrait avec les commentaires de code.
 */
const MESSAGE_PATTERN = /[Cc]lique sur (?:«|[A-ZÀ-Ý])/;
const SOURCE_PATTERN = /[Cc]lique sur «/;

function svelteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'paraglide' || name === 'node_modules') return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return svelteFiles(path);
    return name.endsWith('.svelte') ? [path] : [];
  });
}

describe('garde-fou des parcours', () => {
  const sources = svelteFiles(SRC).map((file) => ({ file, text: readFileSync(file, 'utf-8') }));

  test(`états vides sans action ni raison : pas plus de ${CEILINGS.emptyStateWithoutReason}`, () => {
    const offenders: string[] = [];
    for (const { file, text } of sources) {
      for (const match of text.matchAll(/<EmptyState\b([^>]*?)\/>/gs)) {
        if (!match[1].includes('actionLabel') && !match[1].includes('reason=')) {
          offenders.push(file.slice(SRC.length + 1));
        }
      }
    }
    if (offenders.length > CEILINGS.emptyStateWithoutReason) {
      throw new Error(
        `${offenders.length} états vides sans suite (plafond ${CEILINGS.emptyStateWithoutReason}). `
        + `Donne-leur une étape suivante (actionLabel + onAction ou actionHref), ou dis pourquoi avec reason :\n  ${[...new Set(offenders)].join('\n  ')}`,
      );
    }
    expect(offenders.length).toBeLessThanOrEqual(CEILINGS.emptyStateWithoutReason);
  });

  test(`textes qui renvoient vers un autre bouton : pas plus de ${CEILINGS.sendsToAnotherButton}`, () => {
    const messages = JSON.parse(readFileSync(MESSAGES, 'utf-8')) as Record<string, string>;
    const offenders = Object.entries(messages)
      .filter(([key, value]) => MESSAGE_PATTERN.test(value) && !EXTERNAL_BUTTON_TEXTS.has(key))
      .map(([key]) => key);
    // Les textes ecrits en dur dans les composants comptent aussi.
    for (const { file, text } of sources) {
      if (SOURCE_PATTERN.test(text)) offenders.push(file.slice(SRC.length + 1));
    }
    if (offenders.length > CEILINGS.sendsToAnotherButton) {
      throw new Error(`Ces textes envoient chercher un bouton ailleurs ; mets le bouton dans le message :\n  ${offenders.join('\n  ')}`);
    }
    expect(offenders.length).toBeLessThanOrEqual(CEILINGS.sendsToAnotherButton);
  });
});
