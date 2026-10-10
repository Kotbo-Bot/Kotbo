import { describe, test, expect, mock } from 'bun:test';

/**
 * `tabRouting.ts` importe `tinro` uniquement pour `router.goto`, qui delegue
 * a `history.pushState`. On mock le module plutot que d'ajouter jsdom comme
 * dependance de test : `gotoTab` est verifiee par ce qu'elle passe a
 * `router.goto`, jamais par un vrai changement d'URL DOM.
 *
 * IMPORTANT : un mock qui se contente d'enregistrer la chaine brute passee a
 * `goto()` ne prouve RIEN sur ce bug. Le bug n'existe que parce qu'un vrai
 * navigateur re-encode le pathname entre l'ecriture (`history.pushState`) et
 * la lecture (`window.location.pathname`) : tout caractere hors de l'espace
 * "path-safe" de l'URL (non-ASCII, espace...) est percent-encode en UTF-8,
 * un `%XY` deja valide etant lui laisse intact. `browserNormalizePathname`
 * simule ce comportement pour que le mock reproduise fidelement la panne.
 */
function browserNormalizePathname(raw: string): string {
  const SAFE = /[A-Za-z0-9\-_.~!$&'()*+,;=:@/]/;
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '%' && /^[0-9A-Fa-f]{2}$/.test(raw.slice(i + 1, i + 3))) {
      out += raw.slice(i, i + 3);
      i += 2;
      continue;
    }
    out += SAFE.test(ch) ? ch : encodeURIComponent(ch);
  }
  return out;
}

const lastUrl = { value: '' };
const gotoMock = mock((path: string) => {
  lastUrl.value = browserNormalizePathname(path);
});
mock.module('tinro', () => ({
  router: { goto: gotoMock },
}));

// Import dynamique : le mock doit etre enregistre avant que `tabRouting.ts`
// (qui fait `import { router } from 'tinro'`) ne soit charge.
const { resolveTabFromUrl, gotoTab } = await import('./tabRouting');

const BASE = '/inbox';
// Libelles reels de l'Inbox (Inbox.svelte) : ce sont les valeurs qui
// transitent par l'URL, pas seulement des libelles d'affichage traduits.
const INBOX_TABS = ['tous', 'modération', 'recrutement', 'staff', 'système'] as const;

/** Chemin tel qu'un vrai navigateur le rendrait dans `window.location.pathname`
 *  apres le dernier appel de `gotoTab`. */
function lastGotoPath(): string {
  expect(gotoMock.mock.calls.length).toBeGreaterThan(0);
  return lastUrl.value;
}

describe('tabRouting: aller-retour URL par onglet', () => {
  test('onglet accentue « modération » : aller-retour identique (LE cas rouge avant correctif)', () => {
    gotoTab(BASE, 'modération', 'tous');
    const path = lastGotoPath();
    const resolved = resolveTabFromUrl(BASE, INBOX_TABS, 'tous', path);
    expect(resolved).toBe('modération');
  });

  test('onglet accentue « système » : aller-retour identique (LE cas rouge avant correctif)', () => {
    gotoTab(BASE, 'système', 'tous');
    const path = lastGotoPath();
    const resolved = resolveTabFromUrl(BASE, INBOX_TABS, 'tous', path);
    expect(resolved).toBe('système');
  });

  test('onglet ASCII pur : continue de fonctionner (temoin de non-regression)', () => {
    gotoTab(BASE, 'staff', 'tous');
    const path = lastGotoPath();
    expect(path).toBe('/inbox/staff');
    const resolved = resolveTabFromUrl(BASE, INBOX_TABS, 'tous', path);
    expect(resolved).toBe('staff');
  });

  test('onglet inconnu : retombe sur la valeur par defaut', () => {
    const resolved = resolveTabFromUrl(BASE, INBOX_TABS, 'tous', '/inbox/nexistepas');
    expect(resolved).toBe('tous');
  });

  test('URL malformee (sequence de pourcentage invalide) : ne jette pas, retombe sur le defaut', () => {
    // %E9 est un octet UTF-8 isole invalide : decodeURIComponent leve
    // normalement une URIError ("URI malformed"). resolveTabFromUrl doit
    // l'avaler et retomber proprement, jamais laisser l'exception remonter.
    expect(() => resolveTabFromUrl(BASE, INBOX_TABS, 'tous', '/inbox/%E9')).not.toThrow();
    const resolved = resolveTabFromUrl(BASE, INBOX_TABS, 'tous', '/inbox/%E9');
    expect(resolved).toBe('tous');
  });

  test("libelle contenant une barre oblique : l'encodage empeche la coupure du chemin", () => {
    // CASSE SI: `gotoTab` cesse d'encoder le libelle. C'est le seul cas ou
    // l'encodage est porteur : un navigateur percent-encode de lui-meme les
    // accents et les espaces, mais PAS la barre oblique, qui est un separateur
    // de chemin legitime. Sans encodage, « signalements/urgents » devient deux
    // segments et `resolveTabFromUrl` ne verrait que « signalements ».
    const tabs = ['tous', 'signalements/urgents'] as const;
    gotoTab(BASE, 'signalements/urgents', 'tous');
    const path = lastGotoPath();
    expect(path).toBe('/inbox/signalements%2Furgents');
    const resolved = resolveTabFromUrl(BASE, tabs, 'tous', path);
    expect(resolved).toBe('signalements/urgents');
  });

  test('libelle avec espace : aller-retour identique', () => {
    const tabs = ['tous', 'sous menu'] as const;
    gotoTab(BASE, 'sous menu', 'tous');
    const path = lastGotoPath();
    const resolved = resolveTabFromUrl(BASE, tabs, 'tous', path);
    expect(resolved).toBe('sous menu');
  });

  test('libelle avec accent ET espace : aller-retour identique', () => {
    const tabs = ['tous', 'système avancé'] as const;
    gotoTab(BASE, 'système avancé', 'tous');
    const path = lastGotoPath();
    const resolved = resolveTabFromUrl(BASE, tabs, 'tous', path);
    expect(resolved).toBe('système avancé');
  });

  test('onglet = defaut : gotoTab ecrit le basePath nu, sans segment', () => {
    gotoTab(BASE, 'tous', 'tous');
    const path = lastGotoPath();
    expect(path).toBe('/inbox');
    const resolved = resolveTabFromUrl(BASE, INBOX_TABS, 'tous', path);
    expect(resolved).toBe('tous');
  });
});

/**
 * Cas limites demandes en revue sur resolveTabFromUrl, testables sans DOM
 * (appel direct avec un `pathname` ecrit a la main, sans passer par le mock
 * de `router.goto`). Chaque test documente en tete la regression precise
 * qu'il detecterait si elle etait reintroduite.
 */
describe('tabRouting: cas limites (segments, prefixe, decodage)', () => {
  test('URL a plusieurs segments : seul le premier segment apres le prefixe compte', () => {
    // CASSE SI: resolveTabFromUrl cesse de faire
    // `pathname.slice(prefix.length).split('/')[0]` (par ex. compare le reste
    // du chemin tel quel) — un lien profond vers un sous-ecran de l'onglet
    // (/inbox/moderation/detail/42, ouvert directement ou apres rechargement)
    // ne retomberait plus sur l'onglet 'moderation'.
    const tabs = ['tous', 'moderation'] as const;
    const resolved = resolveTabFromUrl('/inbox', tabs, 'tous', '/inbox/moderation/detail/42');
    expect(resolved).toBe('moderation');
  });

  test('%2F dans le libelle : le decoupage en segments precede le decodage', () => {
    // CASSE SI: resolveTabFromUrl decodait `pathname` en entier avant de le
    // decouper par '/' (au lieu de decouper le chemin BRUT puis decoder
    // seulement le segment obtenu) — un %2F destine a rester a l'interieur
    // d'un seul segment redeviendrait un '/' avant la coupure, et
    // 'signalements%2Furgents' se retrouverait tronque a 'signalements'.
    // C'est exactement le bug que l'encodage de gotoTab est cense eviter ;
    // ce test verifie l'ordre des operations cote decodage, independamment
    // du round-trip via gotoTab deja couvert plus haut.
    const tabs = ['tous', 'signalements/urgents'] as const;
    const resolved = resolveTabFromUrl('/inbox', tabs, 'tous', '/inbox/signalements%2Furgents');
    expect(resolved).toBe('signalements/urgents');
  });

  test('chemin qui ne commence pas par le prefixe : retombe sur le defaut', () => {
    // CASSE SI: resolveTabFromUrl testait une sous-chaine (`includes`) au
    // lieu d'un prefixe strict (`startsWith`) — une page sans rapport avec
    // l'Inbox (ici /analytics/moderation, qui contient pourtant le libelle
    // 'moderation') se verrait attribuer cet onglet au lieu du defaut.
    const resolved = resolveTabFromUrl('/inbox', INBOX_TABS, 'tous', '/analytics/moderation');
    expect(resolved).toBe('tous');
  });

  test('prefixe seul, sans segment ni slash final : retombe sur le defaut', () => {
    // CASSE SI: resolveTabFromUrl construisait son prefixe sans le '/' de
    // separation (compare directement a `basePath`) — `/inbox` matcherait
    // alors n'importe quel chemin qui commence par les memes lettres
    // (ex. /inboxydoc) au lieu d'exiger un vrai separateur de segment. Ce cas
    // ne rentre jamais dans le `if (pathname.startsWith(prefix))` : le defaut
    // vient du garde-fou externe, pas du `if (rawSegment)` teste ci-dessous.
    const resolved = resolveTabFromUrl('/inbox', INBOX_TABS, 'tous', '/inbox');
    expect(resolved).toBe('tous');
  });

  test('segment vide (prefixe suivi d\'un slash final, sans rien apres) : retombe sur le defaut', () => {
    // CASSE SI: le garde `if (rawSegment)` est retire ou remplace par un test
    // qui accepte la chaine vide (ex. `!== undefined`) — un chemin qui
    // s'arrete juste apres le prefixe (/inbox/) donnerait un rawSegment vide
    // qui ne doit jamais etre compare a validTabs ni renvoye tel quel.
    const resolved = resolveTabFromUrl('/inbox', INBOX_TABS, 'tous', '/inbox/');
    expect(resolved).toBe('tous');
  });
});
