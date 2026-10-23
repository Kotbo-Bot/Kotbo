/**
 * Reponse d'une route du dashboard qui a echoue.
 *
 * Les routes repondaient toutes `500` avec un texte ecrit a la main : rien,
 * cote navigateur, ne distinguait une base injoignable d'un bug de la route,
 * ni ne disait s'il valait la peine de reessayer. Le dashboard sait pourtant
 * quoi faire d'un 503 : annoncer la coupure et suspendre les ecritures.
 *
 * `fallbackMessage` decrit l'operation ratee et sert quand la panne n'a rien
 * de particulier a dire. Une panne d'infrastructure, elle, impose son propre
 * texte : « Erreur lors de la mise a jour » n'aide personne quand la base est
 * tombee.
 */
import type { ServerResponse } from 'node:http';
import { json } from './core.js';
import { logger } from '../../utils/logger.js';
import { errorMessage } from '../../utils/errors.js';
import { captureException } from '../../observability/sentry.js';
import { classifyFailure } from '../../utils/failureKind.js';
import { isUserFacing } from '../../utils/publicError.js';

export { classifyFailure, type FailureCode } from '../../utils/failureKind.js';

export function jsonFailure(
  res: ServerResponse,
  err: unknown,
  fallbackMessage: string,
  scope = 'API',
): void {
  const { status, code, message } = classifyFailure(err);

  // Une panne d'infrastructure vaut une ligne de journal distincte : c'est
  // elle qu'on cherche quand plusieurs routes echouent en meme temps. Les
  // erreurs ordinaires n'en ont pas besoin : la route les journalise deja
  // juste avant d'appeler ici, et doubler la ligne brouillerait la lecture.
  if (code !== 'internal_error') {
    logger.error(scope, `[${code}] ${fallbackMessage} (HTTP ${status}): ${errorMessage(err)}`);
  }

  // Sentry etait initialise pour le bot mais presque jamais appele : une route
  // qui plantait en production ne laissait qu'une ligne dans les journaux du
  // conteneur. Seuls les 5xx partent : un doublon ou une permission Discord
  // manquante sont des refus normaux, les remonter noierait les vraies pannes.
  if (status >= 500) {
    captureException(err, `${scope}:${code}`);
  }

  // Une erreur de domaine (« Ce salon n'existe plus ») est écrite pour
  // l'utilisateur et vaut mieux que le texte générique de la route ; tout autre
  // message (requête Prisma, trace réseau) reste dans les journaux.
  const exposed = isUserFacing(err) ? err.message : undefined;
  json(res, status, { error: message ?? exposed ?? fallbackMessage, code });
}
