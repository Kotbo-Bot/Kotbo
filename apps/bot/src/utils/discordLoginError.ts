/** Cause lisible d'un refus de connexion Discord, ou null si on ne la reconnaît pas. */
export function explainLoginError(err: unknown): string | null {
  const text = `${(err as { code?: unknown })?.code ?? ''} ${err instanceof Error ? err.message : String(err)}`;
  if (/disallowed intents|DisallowedIntents/i.test(text)) {
    return 'Discord refuse la connexion : active « Server Members Intent » et « Message Content Intent » dans le portail développeur (onglet Bot, Privileged Gateway Intents), puis relance.';
  }
  if (/invalid token|TokenInvalid|An invalid token/i.test(text)) {
    return 'Discord refuse le token : régénère-le dans le portail développeur (onglet Bot), ressaisis-le ici, puis relance.';
  }
  return null;
}
