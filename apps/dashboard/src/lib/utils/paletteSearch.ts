import { getModuleDefinition, getModuleForPath } from '@kotbo/contracts';

/** Ce que le classement de la palette lit d'une entree. */
export interface SearchableItem {
  label: string;
  sublabel?: string;
  group: string;
  /** Texte cherche mais jamais affiche : nom et description du module. */
  keywords?: string;
}

export const normalize = (value: string): string =>
  value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

const splitWords = (value: string): string[] => value.split(/[\s›>/'(),.:;-]+/).filter(Boolean);

/**
 * Termes qu'on tape pour une page sans qu'ils figurent dans son nom ni dans la
 * description de son module (« mcp » pour « Connecter une IA »). Clef : chemin,
 * valable aussi pour ses sous-pages et ses onglets.
 */
const PAGE_KEYWORDS: Record<string, string> = {
  '/': 'accueil home dashboard tableau de bord apercu overview',
  '/custom-bot': 'bot perso custom white label marque avatar nom domaine personnalise',
  '/setup': 'onboarding demarrage configuration installation premiers pas',
  '/pulse': 'sante score activite climat health',
  '/notifications': 'inbox boite de reception alertes',
  '/members': 'utilisateurs users fiche membre',
  '/invitations': 'invites lien parrainage tracker',
  '/logs': 'logs journal audit historique',
  '/forms': 'formulaire candidature questionnaire',
  '/security': 'securite moderation protection',
  '/security/aegis': 'ia toxicite emotions filtre intelligent',
  '/security/sanctions': 'ban kick mute timeout warn avertissement casier',
  '/security/sanctions/appeals': 'unban appel recours',
  '/economy': 'argent monnaie coins boutique shop',
  '/rpg': 'jeu donjon monstre tour peche',
  '/giveaways': 'concours tirage lot',
  '/reaction-roles': 'roles reaction boutons auto-roles',
  '/starboard': 'etoiles star hall of fame',
  '/embed-builder': 'embed message builder',
  '/regulation': 'reglement regles rules charte',
  '/news': 'flux rss actu youtube twitch',
  '/site': 'site web page wiki blog',
  '/staff-management': 'staff equipe moderateurs',
  '/recruitment': 'candidature postuler recrutement',
  '/tickets': 'support aide transcript',
  '/planning': 'absences calendrier agenda reunion',
  '/doing-lists': 'trello kanban taches todo suivi',
  '/channel-links': 'cross serveur passerelle relais',
  '/channels-management': 'salons auto thread fil sticky',
  '/command-access': 'slash commandes permissions',
  '/backups': 'sauvegarde restauration backup',
  '/schedules': 'cron planifie automatique rappel',
  '/mcp-settings': 'mcp ia ai claude chatgpt agent api cle token llm',
  '/webhooks': 'webhook http integration evenements sortants',
  '/network': 'reseau multi serveurs association regrouper rattacher principal',
  '/billing': 'abonnement paiement plus premium facture prix offre stripe',
  '/userSettings': 'parametres reglages compte langue theme',
};

/**
 * Mots-cles d'une page : les mots de son chemin, ses synonymes, puis le
 * registre des modules. On cherche un sujet (« ban », « captcha », « xp »)
 * plus souvent que le nom exact de la page.
 */
export function moduleKeywords(href: string): string | undefined {
  const path = href.split('?')[0];
  const key = getModuleForPath(path);
  const mod = key ? getModuleDefinition(key) : undefined;
  const aliases = Object.entries(PAGE_KEYWORDS)
    .filter(([prefix]) => path === prefix || (prefix !== '/' && path.startsWith(`${prefix}/`)))
    .map(([, words]) => words);
  const text = [path.replace(/[/-]/g, ' '), ...aliases, mod ? `${mod.name} ${mod.description}` : ''].join(' ');
  return normalize(text) || undefined;
}

function tokenScore(item: SearchableItem, label: string, words: string[], token: string): number {
  if (label.startsWith(token)) return 100;
  if (words.some((word) => word.startsWith(token))) return 80;
  if (label.includes(token)) return 40;
  if (normalize(item.sublabel ?? '').includes(token) || normalize(item.group).includes(token)) return 20;
  if (item.keywords && splitWords(item.keywords).some((word) => word.startsWith(token))) return 15;
  return 0;
}

/**
 * Pertinence d'un element pour la saisie. Un mot qui commence par la saisie
 * passe avant une saisie trouvee au milieu d'un mot : « sanc » trouvait
 * d'abord « Statistiques > Croissance » (cro-issanc-e). Plusieurs mots
 * (« eco bestiaire ») doivent tous trouver leur place, dans n'importe quel
 * ordre. Une page passe avant ses onglets.
 */
export function score(item: SearchableItem, q: string): number {
  const label = normalize(item.label);
  const words = splitWords(label);
  // La saisie entiere d'abord, pour qu'« anti raid » colle a « Anti-raid ».
  let value = tokenScore(item, label, words, q);
  const tokens = q.split(/\s+/).filter(Boolean);
  if (value === 0 && tokens.length > 1) {
    let total = 0;
    for (const token of tokens) {
      const part = tokenScore(item, label, words, token);
      if (part === 0) return 0;
      total += part;
    }
    value = Math.round(total / tokens.length);
  }
  if (value > 0 && !item.label.includes('›')) value += 10;
  return value;
}

/** Distance d'edition entre deux mots courts (insertion, suppression, substitution). */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

/**
 * Seconde chance quand la recherche exacte ne trouve rien : « sactions » ou
 * « anti raid » doivent mener a Sanctions et a Anti-raid. On compare la saisie
 * au debut de chaque mot, avec une faute toleree (deux au-dela de 6 lettres).
 */
export function fuzzyScore(item: SearchableItem, q: string): number {
  if (q.length < 3) return 0;
  const tolerance = q.length >= 6 ? 2 : 1;
  const compact = q.replace(/[\s-]+/g, '');
  const words = splitWords(normalize(item.label));
  const joined = words.join('');
  const candidates = [...words.map((word) => word.slice(0, q.length)), joined.slice(0, compact.length)];
  const best = Math.min(...candidates.map((word) => editDistance(compact, word.replace(/[\s-]+/g, ''))));
  return best <= tolerance ? 10 - best : 0;
}

// ── Recherche dans le texte des pages ───────────────────────────────────────

/** Index généré par `scripts/build-search-index.mjs` : route -> mots de la page, par langue. */
export type SearchIndex = Record<string, { fr: string; en: string }>;

const wordSets = new Map<string, Set<string>>();

/** Mots d'une page : l'entrée de la route la plus longue qui préfixe le chemin demandé. */
export function pageWords(index: SearchIndex, href: string, locale: 'fr' | 'en'): Set<string> | undefined {
  const path = href.split('?')[0].replace(/\/$/, '') || '/';
  let best: string | null = null;
  for (const route of Object.keys(index)) {
    if ((path === route || path.startsWith(`${route}/`)) && (!best || route.length > best.length)) best = route;
  }
  if (!best) return undefined;
  const key = `${locale}:${best}`;
  let set = wordSets.get(key);
  if (!set) {
    set = new Set(index[best][locale].split(' ').filter(Boolean));
    wordSets.set(key, set);
  }
  return set;
}

/**
 * Pertinence d'une page pour des mots cherchés dans son texte : tous les mots
 * saisis doivent y figurer (début de mot accepté), dans n'importe quel ordre,
 * comme un moteur. Reste sous les correspondances sur le nom et les mots-clés,
 * qui visent la page elle-même.
 */
export function contentScore(words: Set<string> | undefined, q: string): number {
  if (!words || q.length < 3) return 0;
  const tokens = q.split(/\s+/).filter((token) => token.length >= 2);
  if (tokens.length === 0) return 0;
  let total = 0;
  for (const token of tokens) {
    if (words.has(token)) {
      total += 9;
      continue;
    }
    let prefix = false;
    for (const word of words) {
      if (word.startsWith(token)) {
        prefix = true;
        break;
      }
    }
    if (!prefix) return 0;
    total += 6;
  }
  return Math.round(total / tokens.length);
}
