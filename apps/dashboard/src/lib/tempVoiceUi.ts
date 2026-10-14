/**
 * Logique pure de la page « Gestion des salons » (volet vocal), sortie du
 * composant pour être testée sans rendu : sélecteurs de générateurs, bornes
 * numériques, sous-onglet dans l'URL.
 */

export type TempVoiceSubTab = 'generators' | 'permissions' | 'panel' | 'active';

export const TEMP_VOICE_SUB_TABS: readonly TempVoiceSubTab[] = ['generators', 'permissions', 'panel', 'active'];

/**
 * Salons déjà pris par le principal et par les autres générateurs. Le serveur
 * écarte un second générateur sur le même salon : le proposer ferait disparaître
 * la carte à l'enregistrement. `exceptIndex` : le générateur en cours d'édition,
 * dont le propre salon doit rester sélectionnable.
 */
export function takenGeneratorChannelIds(
  mainChannelId: string | null | undefined,
  generators: ReadonlyArray<{ channelId?: string | null }>,
  exceptIndex?: number,
): Set<string> {
  const taken = new Set<string>();
  if (mainChannelId) taken.add(mainChannelId);
  generators.forEach((generator, index) => {
    if (index !== exceptIndex && generator.channelId) taken.add(generator.channelId);
  });
  return taken;
}

/** Les salons proposés, sans ceux de `taken`. */
export function selectableGeneratorChannels<T extends { id: string }>(channels: readonly T[], taken: ReadonlySet<string>): T[] {
  return channels.filter((channel) => !taken.has(channel.id));
}

/** Entier borné ; `fallback` quand la saisie n'est pas un nombre (champ vidé). */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/** Même plafond que le bot pour les places d'un salon (0 = sans limite). */
export const MAX_USER_LIMIT = 99;

/**
 * Valeur à AFFICHER dans le champ « Places » après une saisie : `null` quand
 * elle est déjà juste (ou vide, le temps de taper). Sans cette correction, la
 * valeur enregistrée restait à 99 alors que le champ gardait « 150 » : le DOM ne
 * bouge pas quand l'état ne change pas.
 */
export function userLimitDisplayFix(typed: string, max = MAX_USER_LIMIT): string | null {
  const n = Number.parseInt(typed, 10);
  if (!Number.isFinite(n)) return null;
  const clamped = Math.min(Math.max(n, 0), max);
  return String(clamped) === typed ? null : String(clamped);
}

/** Sous-onglet demandé par `?sub=` ; `generators` (le défaut) quand absent ou inconnu. */
export function tempVoiceSubFromSearch(search: string): TempVoiceSubTab {
  const requested = new URLSearchParams(search).get('sub');
  return TEMP_VOICE_SUB_TABS.includes(requested as TempVoiceSubTab) ? (requested as TempVoiceSubTab) : 'generators';
}

/** Query string avec le sous-onglet posé (ou retiré pour le défaut), autres paramètres conservés. */
export function withTempVoiceSub(search: string, sub: TempVoiceSubTab): string {
  const params = new URLSearchParams(search);
  if (sub === 'generators') params.delete('sub');
  else params.set('sub', sub);
  const out = params.toString();
  return out ? `?${out}` : '';
}
