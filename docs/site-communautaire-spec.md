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

## v2 : design façon Azuriom et fonctions de communauté

Décisions arrêtées avec Elouan le 2026-10-09, livrées d'un seul tenant sur `feat/site-communautaire`.

### Design

- **Rien qui fasse « généré par IA »** : pas d'emoji en guise d'icône, pas de violet par défaut, pas de dégradés en halo ni d'effet verre, pas de cartes toutes identiques, textes courts et concrets. Vaut pour le site public et pour les écrans du site dans le dashboard (le reste du dashboard suit son propre chantier UI).
- **Thème de base façon Azuriom**, en **clair et sombre au choix du visiteur** (bouton dans la barre, préférence du système par défaut) : barre de navigation pleine sur toute la largeur, grande bannière d'accueil sur l'image du serveur, cartes sobres, pied de page en colonnes.
- Bannière d'accueil : membres en ligne et total, bouton Rejoindre le Discord, puis les dernières actualités en cartes avec vignette.
- Les anciens thèmes (Verre, Néon, Arcade…) sont refaits dans le même esprit ; chaque site existant bascule sur l'équivalent le plus proche.
- Sections de page prêtes à l'emploi : bannière d'appel, chiffres clés calculés en direct, bande-annonce et galerie, témoignages et FAQ.

### Fonctions

- **Boutique** : la boutique du module Économie, enrichie et achetable sur Discord comme sur le site. Monnaie du bot uniquement pour l'instant ; le modèle garde la place d'un prix en argent réel pour plus tard. Articles : rôles Discord (durée possible, retrait à l'expiration), objets et monnaie du bot, et tout ce que l'économie sait livrer. Abonnements prélevés en monnaie du bot à chaque période (rappel en MP si le solde manque, retrait du rôle après un délai de grâce). Règles : stock, limite par membre, promotions datées, accès par rôle ou niveau, validation par le staff (remboursement si refus), codes promo, cadeau à un autre membre. Pas de serveur de jeu (ni RCON, ni plugin).
- **Votes serveur** : top.gg, annuaires Discord FR et sites de classement de serveurs de jeu, avec vérification du vote quand le site l'offre. Récompenses dans l'économie, séries, classement des voteurs, rappel en MP quand le vote est de nouveau possible.
- **Forum** : par catégorie, soit miroir d'un salon forum Discord (sujets et réponses dans les deux sens), soit propre au site.
- **Site qui se tient à jour seul** : messages d'un salon d'annonces repris en actualités, changelog généré, pages de modules créées et tenues à jour automatiquement, résumé de la semaine en article.
- **Galerie de thèmes partagés** : tout serveur publie directement (signalable). Un thème partagé contient couleurs, polices, arrondis, CSS personnalisé (refiltré à l'installation), modèles de pages (sans contenu privé du serveur d'origine) et menu.
- **Membres** : profils publics (visibles par défaut, le membre peut se masquer), espace membre complet (inventaire, quêtes, tickets, candidatures, votes, achats), récompenses pour l'activité web (vote, participation plafonnée par jour, visite quotidienne avec série, lecture du wiki une fois par page), notifications en MP Discord au choix du membre.

### Livraison (2026-10-10)

Tout ce qui précède est codé, fusionné dans `recette`. Choix de détail faits pendant la livraison :

- **Boutique** : tables `shop_*`, indépendantes du site (la boutique marche sans site). Types d'offre : rôle (permanent ou pour N jours, un rachat prolonge), objets RPG, XP, abonnement (rôle prélevé chaque période, jours de grâce réglables, résiliation en fin de période) et prestation livrée à la main (toujours validée). Les règles (rôles requis, niveau, limite) portent sur le bénéficiaire ; un code promo sert une fois par membre ; un abonnement ne s'offre pas. Commande `/boutique` sur Discord (panneau éphémère), page `/shop` sur le site, onglet Boutique au dashboard, outils MCP. Prélèvements et rôles échus traités toutes les 15 minutes.
- **Votes** : top.gg par webhook à secret chiffré, les autres sites vérifiés à la demande (compte Discord ou adresse IP). Un vote compte une fois par fenêtre de délai.
- **Forum** : un miroir écrit dans le salon par un webhook créé par Kotbo (jeton chiffré) au nom et avec l'avatar du membre ; les messages de ce webhook sont ignorés au retour. À la création d'un miroir, les 50 derniers fils (100 messages chacun) sont importés. Les pièces jointes Discord ne sont pas recopiées (liens qui expirent) : un lien « Voir sur Discord » les remplace.
- **Site automatique** : réglages dans `settings.auto`. Annonces : titre tiré de la première ligne, première image copiée dans les images du site, article suivi en cas de modification ou de suppression. Pages des modules : créées une seule fois par module (une page retirée n'est pas recréée). Les articles générés ne sont pas réannoncés sur Discord.
- **Galerie** : 5 thèmes publiés au plus par serveur, 8 pages modèles par thème ; les réglages de bloc propres au serveur d'origine (salon, formulaire, hiérarchie) sont vidés ; pages appliquées en brouillon ; masquage d'office après 5 signalements de serveurs différents.

Migrations à appliquer en plus des deux premières : `20261110100000_site_themes_v2`, `20261110110000_site_members`, `20261110120000_site_votes`, `20261111100000_shop`, `20261111110000_site_forum`, `20261111120000_site_auto_posts`, `20261111130000_site_theme_gallery`.

## v3 : le site fait grandir le serveur

Décidé avec Elouan le 2026-10-11. Constat : la v2 était complète mais restait une copie d'Azuriom, sans rien qui exige Kotbo. La v3 garde les fondations (rendu serveur, CSP, éditeur, droits, boutique) et refait la couche produit autour d'une seule promesse : le site amène des membres au serveur et le prouve. Toute nouvelle fonction se juge à cette aune.

### Le pouls

- Bannière d'accueil en deux colonnes : identité du serveur à gauche, serveur en direct à droite (`sitePulse.ts`).
- Contenu : en ligne, en vocal (visages des salons publics), messages des 30 dernières minutes (fenêtre des Analytics en direct), arrivées sur 24 h, courbe des 24 dernières heures, salons qui s'agitent, prochain événement avec compte à rebours.
- Humeur : le rythme de l'heure comparé à la moyenne de la même heure (UTC) sur 14 jours, en ne comptant que les jours couverts par l'historique. Il faut au moins trois jours d'historique et une moyenne d'au moins 4 messages, sinon on affiche seulement « ça discute ».
- Seuls des agrégats sortent, et seulement pour des salons que `@everyone` lit.
- Route publique `GET /api/site/:id/pulse`, en cache 15 s côté serveur, relue toutes les 15 s par le script tant que l'onglet est visible ; les chiffres défilent jusqu'à leur nouvelle valeur.
- Aussi disponible en bloc `pulse`. Se retire avec `settings.heroPulse = false`.

### Site instantané

- Créé sans question à l'arrivée du bot, à l'ouverture de la section Site, ou par l'outil MCP `create_instant_site` (`siteInstantService.ts`).
- Type de communauté deviné : nom et description pèsent double, il faut deux indices, et à égalité le plus spécifique l'emporte.
- Salons d'annonces repérés (salons Annonces de Discord, puis noms), leurs six derniers messages repris en articles. Pages de modules et résumé hebdo activés.
- Forums Discord publics recopiés (cinq au plus) et ajoutés au menu.
- Reste hors ligne. Aperçu privé du site entier par `?apercu=<jeton>` : jeton signé valable 7 jours, posé en cookie `HttpOnly` sur `/s/<slug>`. Il montre le site même quand l'offre ne comprend pas encore le module (argument de vente), sans indexation, cache ni mesure.
- Le dashboard affiche « Ton site est prêt » avec l'aperçu et la mise en ligne d'un clic. L'assistant de création ne sert plus que de repli.

### Forum trouvable

- Adresse `/forum/<catégorie>/<id>-<titre>` ; l'identifiant seul ou un ancien titre redirigent en 301.
- Résolu : étiquette du fil Discord, ✅ de l'auteur du fil sur une réponse, ou bouton sur le site (auteur ou staff). Kotbo reporte la solution d'un ✅ sur Discord. Colonnes `solved` et `acceptedPostId` (migration `20261113100000_site_forum_answers`).
- Balisage : `QAPage` quand le sujet est résolu et a des réponses, `DiscussionForumPosting` sinon. La description vient du premier message.
- Catégories et sujets (5 000 au plus) dans le plan du site.
- Un forum recopié d'un salon que `@everyone` ne lit pas n'est jamais indexé. Un membre au profil masqué apparaît « Membre », sans avatar ni lien.
- Encart « Discussion du Discord X, N membres » avec le bouton Rejoindre, et sujets proches en bas de page.

### Cartes partageables

- `/s/<slug>/og.png` : carte du serveur 1200 × 630, image de partage par défaut de toutes les pages.
- `/s/<slug>/u/<membre>/card.png` : carte d'un membre, seulement si son profil public existe.
- Images lues uniquement depuis le CDN de Discord ou les images du site, jamais depuis une adresse saisie. Cartes gardées 10 minutes en mémoire.
- Le profil propose de copier le lien et de télécharger la carte.

### Tunnel

- Visiteurs → visiteurs qui cliquent sur « Rejoindre » → arrivées par les invitations étiquetées « Site web » → arrivées encore là au bout de 7 jours.
- Les clics partent par `sendBeacon` et se comptent sans cookie, par emplacement (bannière, forum, bloc, pied de page).
- Le bouton Rejoindre passe désormais par l'invitation suivie avant l'URL personnalisée, qui ne permet pas de savoir d'où vient un arrivant.
- Affiché dans « Ce que le site rapporte » (Fréquentation) et dans l'aperçu du site.

### Limites connues

- Le pouls lit le cache Discord et la fenêtre en direct du process qui porte l'API, comme le reste du rendu : avec plusieurs shards, un serveur porté par un autre shard n'a pas de messages en direct.
- Rien de la v3 n'a encore été vu dans un navigateur ni contre une vraie base.

## Allègement du 2026-10-12

Décidé avec Elouan : le site avait trop d'options. On garde ce qui amène ou retient des membres, le reste est retiré du code.

### Retiré

- **Galerie de thèmes partagés** : service, routes, onglet et modèle supprimés ; la migration `20261115100000_drop_site_theme_gallery` supprime les tables `site_theme_*`.
- **Boutique web** : page `/shop` (les adresses `/shop` et `/boutique` renvoient vers l'accueil), blocs Boutique et « Mes achats », achats et codes promo depuis le site. La boutique reste vendue par `/boutique` sur Discord, qui gagne « Mes abonnements » (résilier, reprendre). Ses réglages passent dans un onglet Boutique de la page Économie, servi par `/api/shop-admin/:guildId` avec les droits de la section Économie. Les MP de la boutique ne passent plus par le site.
- **Réglages fins** : champs de la page Équipe (présence, bio et ancienneté toujours affichées, plus de statistiques) et montants des récompenses (un interrupteur, montants par défaut ; des montants encore stockés sont ignorés). La colonne `staffPage` reste en base mais n'est plus lue.

### Section Site en cinq onglets

Aperçu (statut, contenu, pages à reprendre, fréquentation dessous) · Contenu (pages, wiki, blog, commentaires en filtres) · Apparence (thème et menu) · Croissance (votes et forum) · Réglages. Les anciennes adresses d'onglet restent valables (`/site/wiki`, `/site/blog`, `/site/commentaires`, `/site/menu`, `/site/votes`, `/site/forum`, `/site/frequentation`).

### Anciens liens publics

Les pages publiques historiques (formulaire de débannissement, formulaires, classements, giveaways, clans, actualités) ne renvoient vers le site que s'il est joignable : publié, non suspendu **et module Site actif** (`isSiteReachable`). Avant, un module coupé menait à une 404. Le serveur peut aussi couper la redirection (`settings.legacyRedirect`, actif par défaut) : les liens mènent alors aux pages d'origine, et le site garde ses propres pages.
