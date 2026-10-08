# Site communautaire

Chaque serveur peut publier son propre site : une vitrine (équipe, règlement, actualités), les démarches (appel de ban, candidature, ticket, suggestion), les modules du bot qui ont du sens pour un membre (classements, clans, giveaways, événements, marché…), et des contenus libres (pages, wiki, FAQ, blog).

Décisions arrêtées avec Elouan le 2026-10-08. Ce qui suit est la référence du chantier `feat/site-communautaire`.

## Décisions de fond

| Sujet | Décision |
| --- | --- |
| Adresse | Chemin sur le dashboard : `dash.kotbo.fr/s/<slug>`. Le slug est choisi, unique, modifiable (l'ancien redirige). `/s/<identifiant Discord>` redirige vers le slug. |
| Rendu | Rendu serveur par l'API Bun, indexable. nginx du dashboard relaie `/s/` vers l'API au lieu de servir la SPA. |
| Édition | Tout en WYSIWYG : la page s'édite telle qu'elle s'affiche. Barre flottante à la sélection + menu `/` pour insérer un bloc. Raccourcis Markdown à la frappe. Pas de format Markdown stocké. |
| Structure d'une page | Blocs empilés (texte riche, image, grille bento, blocs de modules). Pas de placement libre. |
| Collaboration | Édition à plusieurs en direct (Yjs), curseurs et présence. |
| Publication | Brouillon + Publier, aperçu par lien privé, publication programmée. |
| Offre | Le bot est payant uniquement. Le site est inclus dans toutes les offres, sans plafond différencié. |
| Mention | « Propulsé par Kotbo » toujours présente en pied de page. |
| Thème | Thèmes prêts + réglages (accent, police, arrondis, fond) + CSS libre. La navigation (en-tête ou barre latérale) dépend du thème. |
| Branding | Nom, icône et bannière repris de Discord, remplaçables par téléversement. |
| Images | Disque du VPS (volume Docker), servies par l'API. |
| Langues | Interface du site traduite selon le visiteur ; le contenu reste dans la langue du propriétaire. |
| Visibilité | Par page : public, membres connectés du serveur, rôles précis, staff. |
| Droits dashboard | Sections distinctes : `site` (apparence, menu, pages, réglages), `site_wiki`, `site_blog`. |
| Pages publiques existantes | Si le serveur a un site publié, `/appeal`, `/form`, classements, giveaways… redirigent vers la page équivalente du site. Sinon rien ne change. |
| Démarrage | Choix d'un modèle par type de communauté, puis remplissage automatique d'après les modules actifs. |
| Livraison | Une seule livraison, sur une branche longue, commits fins. |

## Contenus

- **Pages libres** : composées de blocs, rangées dans le menu.
- **Wiki** : arborescence (catégories, sous-pages) **et** étiquettes transverses ; sommaire latéral, fil d'Ariane ; historique des versions avec restauration ; recherche plein texte Postgres ; commande `/wiki` sur Discord ; annonce dans un salon à la publication. Rédacteurs : rôles choisis par le propriétaire.
- **FAQ** : bloc de questions dépliables, cherchable.
- **Blog** : articles datés avec auteur, couverture, étiquettes ; commentaires des membres connectés (filtre de liens d'arnaque + AegisAI), désactivables par article ; flux RSS.

## Pages et blocs de modules

| Domaine | Bloc / page | Interaction depuis le site |
| --- | --- | --- |
| Équipe | Organigramme tiré de la hiérarchie staff | Chaque staff édite sa bio et peut se masquer |
| Règlement | Articles du module Règlement | — |
| Actualités | Module News | — |
| Partenaires | Liste saisie à la main (le module Partenariats est en pause) | — |
| Appels de ban | Formulaire d'appel existant | Dépôt (connexion Discord) |
| Recrutement | Postes ouverts + formulaires `isRecruitment` | Candidature |
| Support | Ouverture de ticket | Conversation synchronisée avec le salon Discord |
| Suggestions | Liste et dépôt | Vote et commentaire, synchronisés avec Discord |
| Classements | XP, prestige, réputation, saisons | — |
| Clans | Clans leveling et RPG | — |
| Giveaways | En cours et passés | Participation |
| Événements | Calendrier | Inscription |
| Marché | Annonces | Achat / vente |
| Starboard | Meilleurs messages | — |
| Profil | « Mon espace » pour le membre connecté, profil des autres s'ils l'ont rendu visible | — |
| Widgets Discord | Membres en ligne/total, bouton Rejoindre (invitation suivie, source = site), vocaux actifs, fil d'un salon | — |

Fiche staff, chaque champ activable par le propriétaire : bio, statut absent/présent, ancienneté, statistiques d'activité (tickets, appels traités ; jamais le détail des sanctions).

## Diffusion

`sitemap.xml` et `robots.txt` générés, flux RSS (blog, actualités), balises Open Graph par page, blocs intégrables en iframe (`/s/<slug>/embed/<bloc>`).

## Modération

Filtre de liens d'arnaque (jeu de domaines du honeypot) sur tout contenu publié, passage AegisAI des contributions de membres, bouton « Signaler ce site », suspension par l'admin global depuis `/admin` (auditée).

## Statistiques

Visites, pages vues, sources, sans cookie (hachage quotidien comme la télémétrie du dashboard), dans un onglet Site de la page Analytics.

## Architecture

### Données (`packages/database/prisma/site.prisma`)

- `CommunitySite` : un par serveur. Slug, état (publié, suspendu), thème et réglages, CSS libre, menu, branding, réglages de la page équipe.
- `SiteSlugRedirect` : anciens slugs.
- `SitePage` : page libre, page de wiki ou article. Contenu brouillon et contenu publié (document ProseMirror JSON), état collaboratif Yjs, visibilité, programmation, arborescence (`parentId`), étiquettes, vecteur de recherche.
- `SitePageRevision` : une ligne par publication, pour l'historique et la restauration.
- `SiteComment`, `SiteAsset`, `SiteReport`, `SiteStaffProfile`, `SiteDailyStat`.

### Rendu

`apps/bot/src/services/site/` :

- `siteDocument.ts` : liste blanche des nœuds et marques, normalisation de tout document reçu (attributs typés, URL `http(s)` uniquement). Aucun HTML brut n'est jamais stocké.
- `siteRenderer.ts` : document → HTML, tout échappé. Les blocs de modules sont résolus côté serveur.
- `siteTheme.ts` : thèmes, variables CSS, assainissement du CSS libre (réutilise `sanitizeCustomCss`).
- `siteBlocks/` : un résolveur de données par bloc de module.

Routes Hono `GET /api/site/render/s/<slug>/…` (pages, `sitemap.xml`, `robots.txt`, `rss.xml`, `embed/…`, `_/site.css`, `_/site.js`, `_/a/<asset>`).

**Sécurité**, le site étant servi sous le domaine du dashboard :

- CSP stricte propre aux pages du site : `script-src 'self' 'nonce-…'`, aucun script en ligne sans nonce, `connect-src` limité à l'API, `frame-ancestors 'none'` sauf `/embed/`.
- Le CSS libre est filtré : pas de `@import`, pas d'URL hors de nos images, pas d'`expression`, portée limitée au conteneur du site.
- Le cookie de session vit sur l'hôte de l'API et n'arrive donc pas au rendu serveur. Les pages publiques sont rendues entièrement. Les pages restreintes, « Mon espace » et toutes les actions passent par le script du site, qui appelle l'API avec les identifiants (`credentials: 'include'`), comme le dashboard.

### Édition

Tiptap (ProseMirror) dans le dashboard, avec `BubbleMenu`, menu `/`, nœuds personnalisés pour les blocs de modules (aperçu Svelte), extension Collaboration branchée sur un WebSocket Yjs de l'API (`/api/site/collab/<pageId>`). L'état Yjs est persisté sur la page ; « Publier » fige le document dans `publishedContent` et crée une révision.
