/**
 * Enregistrer sans faire attendre : l'écran suivant s'affiche tout de suite.
 *
 * L'étape n'est marquée validée qu'à la réussite (un rechargement en cours de
 * route ne ment donc pas), et un échec interrompt avec « Réessayer ». Les écrans
 * dont le suivant dépend (langue, tickets, structure, règlement) attendent
 * toujours : ils n'utilisent pas ce module.
 */
import { toast } from '../stores/toast.svelte';
import { wizard } from '../stores/onboardingWizard.svelte';
import { m } from '../i18n';
import { play } from './celebrate';
import type { WizardStep } from './steps';
import { errorMessage } from '@kotbo/shared';

const pending = new Set<Promise<void>>();
const failed = new Map<WizardStep, () => Promise<void>>();

export function saveInBackground(step: WizardStep, task: () => Promise<unknown>, failure: string): Promise<void> {
  failed.delete(step);
  const run: Promise<void> = task()
    .then(() => wizard.markDone(step))
    .catch((err) => {
      const retry = () => saveInBackground(step, task, failure);
      failed.set(step, retry);
      play('error');
      toast.error(errorMessage(err) || failure, 10_000, { label: m.common_retry(), onClick: retry });
    })
    .finally(() => pending.delete(run));
  pending.add(run);
  return run;
}

/**
 * Avant de quitter le parcours : attendre les écritures et rejouer une fois
 * celles qui ont échoué. Faux s'il en reste.
 */
export async function settleSaves(): Promise<boolean> {
  await Promise.all([...pending]);
  await Promise.all([...failed.values()].map((retry) => retry()));
  return failed.size === 0;
}
