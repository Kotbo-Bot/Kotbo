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

Logique pure partagée dans `packages/shared/src/site/` (utilisée par le bot et le dashboard) :

- `document.ts` : liste blanche des nœuds et marques, normalisation de tout document reçu (attributs typés, URL `http(s)` uniquement). Aucun HTML brut n'est jamais stocké.
- `modules.ts` : catalogue des 25 blocs de modules (catégorie, module du bot requis, besoin du visiteur, rafraîchissement en direct, configuration par défaut).
- `themes.ts`, `css.ts`, `paths.ts`, `markdown.ts` : thèmes, filtrage et portée du CSS libre, adresses et menu, conversion Markdown ↔ document pour les agents.

Côté bot, `apps/bot/src/services/site/` :

- `siteRenderer.ts` : document → HTML, tout échappé. Les blocs de modules sont résolus côté serveur par `blocks/` (un résolveur par bloc).
- `sitePages.ts`, `siteLayout.ts`, `assets/site.css`, `assets/site.js` : routage des pages, gabarit, script du site (visiteur, blocs à jour, actions, signalement, bandeau d'agent).
- `siteAdminService.ts`, `siteRights.ts` : écritures du dashboard et du MCP, droits par section.
- `siteCollabService.ts`, `siteCollabCodec.ts` : salle Yjs par page, conversion document ↔ Yjs.
- `siteAgentLock.ts` : verrou de l'agent MCP (voir plus bas).
- `siteAnalyticsService.ts`, `siteSearch.ts`, `sitePreview.ts`, `siteModeration.ts`, `siteRedirects.ts`, `siteTemplates.ts`, `siteUploads.ts`.

Routes Hono `GET /api/site/render/s/…` : `/s/<slug>/…` (pages, `sitemap.xml`, `rss.xml`, `_/theme.css`, `embed/<page>/<bloc>`, `preview/<jeton>`) et, communs à tous les sites, `/s/_/site.css`, `/s/_/site.js`, `/s/_/a/<image>`. `robots.txt` est servi à la racine.

**Sécurité**, le site étant servi sous le domaine du dashboard :

- CSP stricte propre aux pages du site : `script-src 'self' 'nonce-…'`, aucun script en ligne sans nonce, `connect-src` limité à l'API, `frame-ancestors 'none'` sauf `/embed/`.
- Le CSS libre est filtré : pas de `@import`, pas d'URL hors de nos images, pas d'`expression`, portée limitée au conteneur du site.
- Le cookie de session vit sur l'hôte de l'API et n'arrive donc pas au rendu serveur. Les pages publiques sont rendues entièrement. Les pages restreintes, « Mon espace » et toutes les actions passent par le script du site, qui appelle l'API avec les identifiants (`credentials: 'include'`), comme le dashboard.

### Édition

Tiptap (ProseMirror) dans le dashboard, avec `BubbleMenu`, menu `/`, nœuds personnalisés pour les blocs de modules (aperçu Svelte), extension Collaboration branchée sur un WebSocket Yjs de l'API (`/api/site/collab/<guildId>/<pageId>`, protocole y-websocket). L'état Yjs est persisté sur la page ; « Publier » fige le document dans `publishedContent` et crée une révision (100 au plus). Sans WebSocket au bout de 6 secondes, l'éditeur repasse en édition seule avec enregistrement par l'API.

Écrans du dashboard :

- `/site` : onglets Aperçu, Pages, Wiki, Blog, Apparence, Menu, Commentaires, Fréquentation, Réglages, selon les droits de chacun.
- `/site/edit/<pageId>` : l'éditeur, avec réglages de la page, historique, lien d'aperçu (7 jours) et programmation.
- Mon espace : section « Rédaction » pour les rôles rédacteurs du wiki et du blog, qui n'ont pas accès au dashboard.
- Analytics : section « Site web ».
- `/admin/sites` : signalements, recherche, suspension motivée.
- Les anciennes pages publiques (appel, formulaire, classements, clans, liste des giveaways, actualités) renvoient vers la page du site qui porte le bloc équivalent, quand il y en a une publique.

### Agents MCP

Deux permissions de clé : **Lire le site** (`READ_SITE`) et **Modifier le site** (`WRITE_SITE`). Les outils couvrent tout ce que fait le dashboard : création et suppression du site, réglages, thème, menu, mise en ligne, pages du wiki et du blog (contenu en Markdown ou en document), ajout de blocs de modules, publication, programmation, révisions, ordre des pages, modération des commentaires, import d'image, lien d'aperçu, fréquentation.

**Verrou de l'agent.** Toute écriture d'un agent pose un verrou sur le site :

- l'édition humaine passe en lecture seule (dashboard, collaboration en direct, API d'administration qui répond `423 agent_locked`) ;
- un bandeau l'annonce dans le dashboard et, pour les gestionnaires, sur le site public ;
- le verrou tombe après 90 secondes sans écriture, ou quand l'agent appelle `release_site_lock` ;
- un humain peut **interrompre** l'agent depuis le dashboard ou le site : l'agent est alors bloqué 15 minutes, sauf si un gestionnaire l'autorise à nouveau. L'interruption part au journal d'audit.

Le verrou vit en mémoire du process du bot (une seule instance), il ne survit pas à un redémarrage.

## Déploiement

- Migrations à appliquer : `20261109100000_community_site` et `20261109110000_mcp_site_permissions`.
- Images : `SITE_ASSETS_DIR=/app/data/site-assets` dans le conteneur du bot. Ce dossier doit être un **volume persistant** sur le VPS, sinon les images disparaissent à chaque redéploiement. Quota de 500 Mo par site.
- nginx du dashboard : `location ^~ /s/` relaie vers `/api/site/render/s/…` de l'API, `/robots.txt` aussi.
