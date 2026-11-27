# DESIGN.md — Kotbo Dashboard

Document de référence visuelle et ergonomique pour `apps/dashboard`.  
Construit à partir de la direction `tafac` (`Sand` / `Night`, squircles, `.glass-quiet`, courbes Fritsch–Carlson) et `papillon.bzh` (`SN Pro`, pilules, clarté en un coup d'œil), puis affiné selon les retours produit.

---

## 1. Palette & surfaces

| Mode | Fond (`--surface-background`) | Carte (`--surface-card`) | Texte principal (`--on-surface`) | Accent par défaut (`--color-primary`) |
| --- | --- | --- | --- | --- |
| **Clair (`Sand`)** | `#fcfbf8` | `#ffffff` | `#491d11` | `#1f8f4e` |
| **Sombre (`Night`)** | `#0f0f0f` | `#1c1c1c` | `#e4e4e4` | `#34c773` |

### Règles de contraste
- **Ne jamais** utiliser `dark:` ni `text-on-surface-variant/(50|60|70)` (vérifié par `styleGuard.test.ts`).
- Les puces / badges informatifs sur fond de carte utilisent `bg-surface-container-high border border-outline-variant text-on-surface` pour rester lisibles en `Night` comme en `Sand`.
- Les métadonnées secondaires utilisent `text-on-surface-variant` (sans opacité réduite).

---

## 2. Typographie

- **Police principale** : `@fontsource/sn-pro` (`400` à `800`) appliquée à `--font-headline`, `--font-body` et `--font-label`.
- **Chiffres** : `tabular-nums` systématique sur les compteurs, KPI, dates relatives et pourcentages.
- **Tableaux** : en-têtes `.data-table th` en casse normale (`normal-case`), jamais en tout-majuscules forcé.

---

## 3. Formes, relief et composants

- **Squircles** : `.section-card`, `.section-card-flush`, `.stat-kpi` et `.modal-panel` utilisent `corner-shape: superellipse(1.3)` avec `--glass-quiet-rim` et `--glass-quiet-shadow`.
- **Pilules** : `.btn`, `.tab-group`, `.tab-button`, filtres `<select>` compacts et badges d'état sont en `rounded-full`.
- **Boutons primaires et tonals** (`.btn-primary`, `.btn-tonal`) : ménisque convexe (`background-color` et `background-image` séparés pour éviter tout flash au survol).
- **Zéro « carte dans une carte »** : une liste d'éléments vit dans une seule `SectionCard flush` avec `divide-y divide-outline-variant`, pas en grille de sous-cartes avec trous.
- **Pastilles d'icônes** : `rounded-full` pour les icônes de listes et d'étapes. Éviter l'icône `sparkles` générique au profit d'icônes métier (`layers`, `shield`, `activity`, etc.).

---

## 4. Courbes & visualisations

- **Courbes d'ambiance** (`Home.svelte` `pulse` et `climate`) : interpolation cubique monotone de Fritsch–Carlson (`smoothPulsePath`).
- **Analytics v3** : conservé intégralement (`MetricTabs`, `KpiTile`, `Sparkline`, `TimeSeriesChart`, `ActivityChartCard`). La barre de filtres (`AnalyticsFilterBar`) et le rail de navigation latéral d'`Analytics.svelte` adoptent les surfaces squircle `.section-card` et les liens pilules.

---

## 5. Ergonomie & parcours

- **Navigation globale (`Navbar` / `Sidebar`)** :
  - Structure de la barre latérale et de l'en-tête inchangée.
  - Le sélecteur de serveur reste toujours cliquable (même avec 1 seul serveur) pour inviter Kotbo ailleurs en 2 clics.
  - Exclusion mutuelle des menus (`NotificationBell`, menu profil, `Ctrl+K`, `Ctrl+G`, `Ctrl+Shift+N`).
- **Accueil (`Home.svelte` & `HomeTodo.svelte`)** :
  - Rangée haute `1/3 + 2/3` : carte d'accueil (photo quotidienne automatisée — paysages/abstrait uniquement, jamais d'animaux — avec crédit auteur) + bloc « À traiter ».
  - « À traiter » : tous les sujets visibles et cliquables en **1 clic** (jamais masqués derrière des onglets), ancre icône + compteur à gauche et puces d'aperçu contrastées.
  - Mode **Personnaliser** : 3 modèles prêts à l'emploi (*Essentiel*, *Modération & Staff*, *Communauté & Vie*), et barre d'édition de tuile en `z-30` opaque (`bg-surface-container-highest`) pour éviter tout chevauchement.
- **Notifications (`/notifications`), Mise en place (`/setup`) & Onboarding (`/onboarding`)** :
  - Lignes denses en surface unique (pas de vide horizontal), dates relatives.
  - Parcours `/onboarding` entièrement testable en mode démo lors de l'ajout d'un serveur depuis `/servers`.

---

## 6. Bibliothèque partagée Kotbo-UI (`@kotbo/ui`)

Les primitives d'interface, `Papicon` et **Analytics v3** de `apps/dashboard` s'appuient sur le paquet partagé `@kotbo/ui` (`../analytics-v3`, futur `../Kotbo-ui`), exposé en quatre modules principaux :

- **`@kotbo/ui`** : primitives UI (`Button`, `Tabs`, `FilterPills`, `Callout`, `Field`, `Menu`, `StatTile`, `SectionCard`, `SettingsRow`, `SettingsGroup`, `ToggleSwitch`), modales/tiroirs (`Modal`, `ConfirmModal`, `DetailSheet`, `Toast`, `ToastContainer`), formulaires & sélecteurs (`FormInput`, `FormSelect`, `FormTextarea`, `FormColorPicker`, `AmountRangeSlider`, `SearchableSelect`, `MultiSelect`), `Calendar`, `DashboardShell`, `UnsavedChangesBar`, actions et stores (`toast`, `unsavedChanges`).
- **`@kotbo/ui/analytics`** : `AnalyticsChartCard`, `MetricTabs`, `Sparkline`, `KpiTile`, `Chart`, `TimeSeriesChart`, `TrendChart`, `BarList`, `ShareBar`, `CohortTable`, `TopList`, `AnalyticsSkeleton`, et helpers purs (`timeSeries`, `analyticsFormat`, `chartTable`).
- **`@kotbo/ui/icons`** : `Papicon` et registres statiques Papicons + Lucide.
- **`@kotbo/ui/styles`** : jetons Sand / Night (`tokens.css`) et CSS autonome sans Tailwind (`components.css`), importés avant `app.css` pour que le thème Kotbo reste prioritaire, tout en permettant à **AegisAI** d'appliquer ses surcharges visuelles modernes (`--kotbo-chart-card-radius: 1.25rem`, palette bleu/slate).

Les fichiers locaux de `apps/dashboard/src/lib/` conservent leurs points d'entrée en wrappers fins + pont Paraglide (`src/lib/kotboUiBridge.ts`), détaillés dans [`docs/kotbo-ui.md`](./docs/kotbo-ui.md).
