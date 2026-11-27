# Kotbo-UI (`@kotbo/ui`) dans l'écosystème Kotbo

**Kotbo-UI** ([`@kotbo/ui`](https://www.npmjs.com/package/@kotbo/ui) sur npm, dépôt GitHub [`Kotbo-Bot/kotbo-ui`](https://github.com/Kotbo-Bot/kotbo-ui)) regroupe l'ensemble des briques d'interface Svelte 5 et **Analytics v3** partagées entre :
- **Kotbo Dashboard** (`apps/dashboard`) ;
- **AegisAI Frontend** (`../aegisai-api/frontend`), qui consomme exactement les mêmes briques tout en conservant sa touche visuelle plus moderne (rayon `1.25rem`, espacement `1.25rem`, palette bleu/slate) par de simples variables CSS.

---

## Architecture par module

| Point d'entrée | Contenu | Usage dans Kotbo Dashboard |
| --- | --- | --- |
| `@kotbo/ui` | Primitives UI (`Button`, `Tabs`, `FilterPills`, `Callout`, `Field`, `Menu`, `StatTile`, `SectionCard`, `SettingsRow`, `SettingsGroup`, `ToggleSwitch`), overlays (`Modal`, `ConfirmModal`, `DetailSheet`, `Toast`, `ToastContainer`), formulaires & sélecteurs (`FormInput`, `FormSelect`, `FormTextarea`, `FormColorPicker`, `AmountRangeSlider`, `SearchableSelect`, `MultiSelect`), `Calendar`, `Breadcrumbs`, `DashboardShell`, `UnsavedChangesBar`, `ActionButton`, `RefreshButton`, `InlineFeedback`, stores (`toast`, `unsavedChanges`), actions (`portal`, `dialogFocus`, `scrollLock`) et utilitaires | Délégué via wrappers fins conservant les chemins d'import historiques dans `src/lib/components/**` |
| `@kotbo/ui/analytics` | `AnalyticsChartCard`, `MetricTabs`, `Sparkline`, `KpiTile`, `Chart`, `TimeSeriesChart`, `TrendChart`, `BarList`, `ShareBar`, `CohortTable`, `TopList`, `AnalyticsSkeleton` + `timeSeries`, `analyticsFormat`, `chartTable` | Délégué via `src/lib/components/analytics/**` et `src/lib/components/charts/Chart.svelte` (conservation de `safeGradient`, `ServerTagPill` et adaptateurs API `ActivityChartCard`, `CohortTriangle`, `TopList`) |
| `@kotbo/ui/icons` | `Papicon`, `iconAliases`, `toPapiconsName`, `fallbackIconName`, registres statiques `@getpapillon/papicons` + `lucide-svelte` | Délégué via `src/lib/components/Papicon.svelte` |
| `@kotbo/ui/styles` | `tokens.css` (Sand / Night, `--series-1..8`, `--layer-*`) et `components.css` (CSS 100 % autonome sans Tailwind) | Importé dans `src/main.ts` **avant** `./app.css` pour que le thème Tailwind v4 de Kotbo reste prioritaire |

### Sous-exports JS purs (`bun test` sans compilateur Svelte)

Pour ne pas casser les tests unitaires exécutés directement avec `bun test` hors Vite, les utilitaires, actions et helpers Analytics sans dépendance `.svelte` sont importés depuis leurs sous-chemins dédiés :
- `@kotbo/ui/config` (`src/lib/kotboUiBridge.ts`)
- `@kotbo/ui/actions/{portal,dialogFocus,scrollLock}` (`src/lib/actions/`, `src/lib/scrollLock.ts`)
- `@kotbo/ui/utils/{pausableTimers,amountScale,calendarLayout,searchableSelectModel}`
- `@kotbo/ui/analytics/{timeSeries,analyticsFormat,chartTable}`

---

## Règles d'intégration dans `apps/dashboard`

1. **Pont i18n Paraglide (`src/lib/kotboUiBridge.ts`)** : relie toutes les clés de `KotboUiMessages` aux fonctions `m.*()` et `dateLocale()`, puis est rappelé à chaud par `src/lib/liveLocale.svelte.ts` à chaque changement de langue.
2. **Télémétrie `unsavedChanges`** : `src/lib/stores/unsavedChanges.svelte.ts` branche `trackEvent` sur le singleton partagé via `unsavedChanges.setTracker(trackEvent)`.
3. **Stabilité des points d'entrée** : les 189+ fichiers appelants gardent leurs imports existants (`../lib/components/ui`, `../lib/stores/toast.svelte`, `../lib/components/analytics/...`). Les composants exposant des liaisons `$bindable`, des exports de module (`Tabs`, `FilterPills`, `Menu`, `Calendar`, `MetricTabs`, `TimeSeriesChart`, `BarList`, `ShareBar`) ou des événements Svelte 4 historiques (`SearchableSelect`) les préservent dans leurs wrappers fins.
4. **Garde-fous RGAA & UX** :
   - `src/lib/a11yGuard.test.ts` inspecte `@kotbo/ui/dist/` pour `Chart.svelte`, `MetricTabs.svelte`, `MultiSelect.svelte` et `Papicon.svelte`.
   - `ui/index.ts`, `statTileGuard.test.ts`, `uxGuard.test.ts` (`KotboEmptyState`), `channelsManagementVocalGuard.test.ts` (`shrink-0`) et `navigationGuard.test.ts` (`Breadcrumbs`) restent tous au vert.

---

## Consommation dans AegisAI (`../aegisai-api/frontend`)

AegisAI importe `@kotbo/ui`, `@kotbo/ui/analytics`, `@kotbo/ui/icons` et `@kotbo/ui/styles` pour `DashboardShell` et `AnalyticsChartCard`, puis applique dans `frontend/src/app.css` sa direction visuelle plus moderne :
- palette bleu/slate (`--color-primary`, `--color-surface-*`, `--color-outline-*`) ;
- variables dédiées d'`AnalyticsChartCard` (`--kotbo-chart-card-radius: 1.25rem`, `--kotbo-chart-card-padding: 1.25rem`, `--kotbo-chart-card-gap: 1.25rem`, `--kotbo-fact-value-size: 1.05rem`, `--kotbo-fact-value-weight: 700`).
