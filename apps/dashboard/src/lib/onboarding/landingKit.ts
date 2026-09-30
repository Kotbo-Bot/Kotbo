/**
 * Le serveur préparé sur kotbo.fr, repris par le parcours d'installation.
 *
 * La landing fait monter son serveur au visiteur avant qu'il ajoute le bot :
 * vocation, pistes, niveau de modération - les trois premières questions de
 * ce parcours. Son lien d'invitation les emporte dans `?kit=`, que
 * `/api/public/invite` recopie jusqu'ici. Les reposer à l'identique après
 * l'ajout donnerait l'impression que ce qu'il a construit a été perdu en
 * chemin ; on les reprend donc comme réponses de départ.
 *
 * Format : `1.<theme>.<moderation>.<piste>-<piste>…` (voir `encodeKit` dans
 * le dépôt de la landing). Tout ce qui ne correspond pas aux clés de ce
 * parcours est écarté un à un : une landing plus récente ou plus ancienne ne
 * doit jamais faire échouer l'installation.
 *
 * `localStorage` et non `sessionStorage` : entre le clic et l'arrivée ici, il
 * y a la connexion Discord puis l'écran d'autorisation du bot, et quelqu'un
 * qui hésite peut y revenir le lendemain. Au-delà de sept jours, l'intention
 * est trop vieille pour être appliquée d'office.
 */
import type { ModerationLevel, ThemeKey } from './presets';
import type { TrackKey } from './tracks';

const STORAGE_KEY = 'kotbo-landing-kit';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const THEMES: readonly ThemeKey[] = ['communaute', 'gaming', 'entraide', 'creation'];
const LEVELS: readonly ModerationLevel[] = ['light', 'standard', 'strict'];
const TRACKS: readonly TrackKey[] = [
  'structure',
  'moderation',
  'logs',
  'greeting',
  'rules',
  'tickets',
  'levels',
  'economy',
  'animation',
  'staff',
  'mcp',
];

export type LandingKit = {
  theme: ThemeKey;
  moderation: ModerationLevel;
  /** `structure` toujours comprise : la landing ne la propose pas, le parcours ne s'en passe pas. */
  tracks: TrackKey[];
};

/** Lit une chaîne `kit`. `null` si elle n'a pas la forme attendue. */
export function parseLandingKit(raw: string | null | undefined): LandingKit | null {
  if (!raw || !/^[a-z0-9.-]{1,160}$/.test(raw)) return null;
  const [version, theme, moderation, tracks = ''] = raw.split('.');
  if (version !== '1') return null;
  if (!THEMES.includes(theme as ThemeKey) || !LEVELS.includes(moderation as ModerationLevel)) return null;

  const picked = tracks.split('-').filter((t): t is TrackKey => TRACKS.includes(t as TrackKey));
  return {
    theme: theme as ThemeKey,
    moderation: moderation as ModerationLevel,
    tracks: TRACKS.filter((t) => t === 'structure' || picked.includes(t)),
  };
}

/**
 * Retient le `kit` de l'URL d'arrivée. Appelé une fois au démarrage, avant
 * toute redirection vers la connexion.
 */
export function captureLandingKit(search: string): void {
  const kit = parseLandingKit(new URLSearchParams(search).get('kit'));
  if (!kit) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ kit, savedAt: Date.now() }));
  } catch {
    // Stockage refusé : le parcours posera ses questions comme d'habitude.
  }
}

/** Rend le serveur préparé et l'oublie. Il ne vaut que pour un seul parcours. */
export function consumeLandingKit(): LandingKit | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    localStorage.removeItem(STORAGE_KEY);
    const saved = JSON.parse(raw) as { kit?: LandingKit; savedAt?: number };
    if (!saved.kit || typeof saved.savedAt !== 'number' || Date.now() - saved.savedAt > MAX_AGE_MS) return null;
    // Relu depuis le stockage : on repasse par le même filtre que l'URL.
    return parseLandingKit(
      ['1', saved.kit.theme, saved.kit.moderation, (saved.kit.tracks ?? []).join('-')].join('.'),
    );
  } catch {
    return null;
  }
}
