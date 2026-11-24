# Pages publiques et leur apparence

Chaque serveur expose des pages publiques, sans connexion, que l'on partage par lien :

| Page | Adresse | Contenu |
| --- | --- | --- |
| Classement des niveaux | `/<serveur>/leveling/classement` (et `/<membre>` pour pointer un membre) | XP, niveaux, podium, recherche |
| Classement prestige | `/<serveur>/prestige/classement` | Classement RP |
| Clans | `/<serveur>/clan` (alias `/<serveur>/leveling/clan`) | Saison, classement des clans, points |
| Clans & RPG | `/<serveur>/clan-rpg` | Clans, raid, quêtes d'équipe |
| RPG de clan | `/<serveur>/rpg` | Prochain boss, avancement des clans |
| Giveaways | `/<serveur>/giveaways` (et `/<giveaway>`) | Giveaways en cours, terminés, conditions |

Si le serveur a publié son site communautaire (`/s/<slug>`), ces anciennes
adresses y renvoient (voir `LegacySiteGate`).

## Une seule coque pour toutes les pages

Les pages ci-dessus passent par le composant
`apps/dashboard/src/lib/components/public/PublicShell.svelte` : fond, en-tête
(logo, titre, sous-titre), sélecteur de langue, thème clair/sombre, pied de
page. Même identité visuelle que le dashboard : jetons de couleur
(`bg-surface-container-low`, `text-on-surface`, `border-outline-variant`…),
cartes sobres, aucune couleur codée en dur.

Pour une nouvelle page publique :

```svelte
<PublicShell {serverId} subtitle={m.ma_page_sous_titre()} icon="Trophy" guildName={guildName} guildIcon={guildIcon} width="narrow" live>
  <section class="pub-card p-5">…</section>
</PublicShell>
```

- `width` : `narrow` (4xl), `default` (5xl) ou `wide` (6xl).
- `live` : pastille « En direct ».
- `meta` (snippet) : pastilles sous le sous-titre (saison, échéance…).
- Les blocs de contenu portent `.pub-card` (fond, bordure, rayon et verre dépoli
  suivent le thème) ; `.pub-card-hover` ajoute un survol discret.
- Plus rien à écrire pour la langue, le thème clair/sombre ni le pied de page.

## Personnaliser l'apparence (dashboard)

**Configuration → Pages publiques** (`/public-pages`, réservé aux
administrateurs du dashboard). Un seul habillage par serveur, appliqué à toutes
les pages ci-dessus, avec un aperçu en direct qui est la vraie coque.

| Réglage | Effet |
| --- | --- |
| Titre affiché | Remplace le nom du serveur dans l'en-tête |
| Logo / bannière | URL `https` d'une image ; sans logo, l'icône du serveur |
| Texte d'accueil | Paragraphe sous l'en-tête de chaque page |
| Accent, fond, cartes, texte | Couleurs ; laissées par défaut, elles suivent le thème clair/sombre du visiteur |
| Police | Inter, Outfit, Manrope ou JetBrains Mono (embarquées, aucun appel à un tiers) |
| Arrondi | 0 à 32 px sur les cartes |
| Fond de page | Uni, grille ou halo teinté par l'accent |
| Densité | Aérée ou compacte |
| Cartes en verre dépoli | Flou d'arrière-plan |
| CSS personnalisé | Pour aller plus loin (voir ci-dessous) |

Les couleurs fixées valent pour les deux thèmes du visiteur : si tu imposes un
fond sombre, impose aussi le texte, et vérifie le contraste.

### CSS personnalisé

Il cible la racine `.pub-root` et les cartes `.pub-card` :

```css
.pub-root .pub-card { border-color: gold; }
.pub-root h1 { letter-spacing: 0.04em; }
```

Il est assaini à l'enregistrement (même règle que les formulaires) : 20 000
caractères au plus, pas de commentaires ni de `<`/`>`, `@import`, `expression()`,
`javascript:`, `position: fixed|sticky` retirés, `url()` limité aux images
`data:`.

## Fonctionnement technique

- **Stockage** : colonne `Guild.publicTheme` (JSON, `null` = apparence par
  défaut). Migration `20270127100000_public_theme`.
- **Validation** : `sanitizePublicTheme` (`apps/bot/src/utils/publicTheme.ts`)
  réutilise `sanitizeFormTheme` (couleurs CSS valides, URL `https`, rayon borné)
  et ajoute le fond, la densité, le titre et le CSS. Toute clé inconnue est
  ignorée.
- **API publique** : `GET /api/public/guilds/:guildId/theme` — thème, nom et
  icône du serveur. Réservée aux navigateurs, 60 requêtes/minute. Lue une fois
  par serveur côté client puis mise en cache le temps de la session.
- **API dashboard** : `GET`/`PUT /api/dashboard/guilds/:guildId/public-theme`.
  Lecture pour le staff, écriture pour les administrateurs (`canManageSettings`),
  écrite dans le journal d'audit.
- **Rendu** : le thème est traduit en variables CSS posées sur `.pub-root`
  (`--color-primary`, `--color-surface`, `--color-on-surface`…). Tout le
  dashboard étant écrit avec ces variables, chaque composant du sous-arbre
  prend les couleurs du serveur sans règle par page (`lib/publicTheme.ts`).

## Pas encore concernés

Les pages de tournoi et de quiz (mises en page propres à l'événement), le profil
public, le formulaire de support, la boutique, les demandes de débannissement et
les formulaires personnalisés (qui ont leur propre thème, éditable dans le
constructeur de formulaire).
