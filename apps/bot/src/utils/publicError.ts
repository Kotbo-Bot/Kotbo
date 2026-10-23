/**
 * Message d'erreur montré à l'utilisateur (dashboard, Discord, outils MCP).
 *
 * Les `catch` renvoyaient `err.message` tel quel : une requête Prisma ratée
 * affichait sa requête, un appel réseau son hôte, une variable d'environnement
 * absente son nom. Trois cas, désormais :
 *
 * - une panne connue (base, cache, Discord, réseau) prend la phrase que lui
 *   donne `classifyFailure` ;
 * - une erreur écrite pour l'utilisateur passe telle quelle : `UserFacingError`
 *   et ses dérivées, ou un `new Error('…')` levé par notre propre code ;
 * - tout le reste devient le message générique de l'appelant, et l'erreur
 *   complète part dans les journaux et Sentry, où elle sert au débogage.
 */
import { classifyFailure } from './failureKind.js';
import { logger } from './logger.js';
import { captureException } from '../observability/sentry.js';

export { UserFacingError } from './userFacingError.js';

export const GENERIC_ERROR_MESSAGE = 'Une erreur inattendue est survenue. Réessayez dans quelques instants.';

/**
 * Indices d'un message technique : trace, requête, chemin de fichier, code
 * système, message natif du moteur JavaScript.
 */
const TECHNICAL_HINTS = new RegExp(
  [
    String.raw`\n\s*at\s`,
    String.raw`\binvocation\b`,
    String.raw`\bprisma\b`,
    String.raw`\bE(?:CONN\w+|TIMEDOUT|NOTFOUND|HOSTUNREACH|PIPE|ADDRINUSE)\b`,
    String.raw`is not a function`,
    String.raw`Cannot (?:read|set) propert`,
    String.raw`is not defined`,
    String.raw`Unexpected (?:token|end of)`,
    String.raw`fetch failed`,
    String.raw`\.(?:ts|js|mjs):\d+`,
    String.raw`\b(?:SELECT|INSERT INTO|DELETE FROM)\b`,
    String.raw`\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b`,
    String.raw`https?://`,
  ].join('|'),
  'i',
);

const MAX_PUBLIC_LENGTH = 300;

function looksTechnical(message: string): boolean {
  return message.length > MAX_PUBLIC_LENGTH || TECHNICAL_HINTS.test(message);
}

/** Vrai si le message de `err` peut être montré tel quel. */
export function isUserFacing(err: unknown): err is Error {
  if (!(err instanceof Error) || !err.message.trim()) return false;
  if ((err as { expose?: unknown }).expose === true) return true;
  // Un `Error` nu sans code système vient de notre code : les bibliothèques
  // lèvent leurs propres sous-classes ou portent un `code` (ECONNREFUSED…).
  if (Object.getPrototypeOf(err) !== Error.prototype) return false;
  if ('code' in err) return false;
  return !looksTechnical(err.message);
}

/**
 * Message à montrer pour `err`. `fallback` décrit l'opération ratée
 * (« Impossible de créer le salon. ») et sert pour les erreurs imprévues.
 * `scope` nomme la source dans les journaux.
 */
export function publicErrorMessage(err: unknown, fallback = GENERIC_ERROR_MESSAGE, scope = 'Erreur'): string {
  const { code, message } = classifyFailure(err);
  if (code !== 'internal_error' && message) return message;
  if (isUserFacing(err)) return err.message.trim();

  logger.error(scope, `${fallback} (détail masqué à l'utilisateur)`, err);
  captureException(err, scope);
  return fallback;
}
