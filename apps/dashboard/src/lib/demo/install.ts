/**
 * Mise en route de la démo. Importé en tout premier par `main.ts`.
 *
 * L'ordre compte : le store d'authentification lit la session dès son import,
 * avant même que l'App soit montée. Ce module doit donc avoir remplacé `fetch`
 * avant que le reste du graphe d'imports s'évalue - d'où sa place en tête de
 * `main.ts`, et le test sur `import.meta.env` plutôt qu'un import conditionnel
 * qui arriverait trop tard.
 *
 * Hors démo, la condition vaut `false` à la construction et tout ce qui suit
 * disparaît du paquet de production.
 */
import { router } from 'tinro';
import { installDemoBackend } from './backend';
import { DEMO_BASE, DEMO_GUILD_ID } from './mode';
import { registerDemoRoutes } from './routes';

const isDemoRuntime =
  import.meta.env.VITE_DEMO === '1' ||
  (typeof window !== 'undefined' && (window.location.pathname.startsWith('/demo') || window.location.port === '5199'));

if (isDemoRuntime) {
  registerDemoRoutes();
  installDemoBackend();

  // Servie sous kotbo.fr/demo : les routes du dashboard restent écrites
  // depuis la racine, tinro retire et rajoute le préfixe.
  if (DEMO_BASE) {
    router.base(DEMO_BASE);
    if (typeof window !== 'undefined') {
      // `?to=` : la page d'erreur de kotbo.fr y renvoie les liens profonds, que
      // GitHub Pages ne sait pas servir. Seul un chemin interne est suivi.
      const to = new URLSearchParams(window.location.search).get('to');
      const currentRel = window.location.pathname.replace(new RegExp(`^${DEMO_BASE}`), '') || '/';
      router.goto(to?.startsWith('/') && !to.startsWith('//') ? to : currentRel + window.location.search + window.location.hash, true);
    }
  }

  // Le serveur de démo est sélectionné d'office, avant que le store
  // d'authentification ne relise ce choix.
  try {
    localStorage.setItem('kotbo_guild_id', DEMO_GUILD_ID);
    if (!localStorage.getItem(`onboarding-${DEMO_GUILD_ID}`)) {
      localStorage.setItem(`onboarding-${DEMO_GUILD_ID}`, JSON.stringify({
        welcomeSeen: true,
        checklistDismissed: true,
        checklistMinimized: true,
        completedTasks: [],
        completedSetupTasks: [],
        activeTab: 'discover',
        visitedPages: [],
        startedAt: Date.now(),
      }));
    }
  } catch {
    // Stockage refusé : la première guilde de la liste sera choisie.
  }
}
