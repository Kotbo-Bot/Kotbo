<script lang="ts">
  import { m } from '../../lib/i18n';
  /**
   * Pages fonctionnalités du site vitrine (kotbo.fr), sur le modèle des pages
   * par plugin de MEE6 : une page par fonctionnalité, en français
   * (`/fonctionnalites/<adresse>`) et en anglais (`/en/features/<adresse>`).
   *
   * Le site les lit à son build : publier ou modifier une page publiée relance
   * sa construction quand `LANDING_DEPLOY_TOKEN` est configuré côté bot. Une
   * page ne se publie qu'avec ses deux langues complètes ; le serveur le
   * vérifie, la page l'affiche avant qu'on essaie.
   */
  import { onMount } from 'svelte';
  import { errorMessage } from '@kotbo/shared';
  import { toast } from '../../lib/stores/toast.svelte';
  import { confirmDialog } from '../../lib/stores/confirmDialog.svelte';
  import {
    createFeaturePage,
    deleteFeaturePage,
    fetchFeaturePages,
    importFeaturePages,
    updateFeaturePage,
    type FeaturePage,
    type FeaturePageInput,
    type FeaturePageLocale,
    type FeaturePageText,
  } from '../../lib/api';
  import Papicon from '../../lib/components/Papicon.svelte';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import AdminDrawer from '../../lib/components/admin/AdminDrawer.svelte';
  import AdminTable from '../../lib/components/admin/AdminTable.svelte';
  import AdminToolbar from '../../lib/components/admin/AdminToolbar.svelte';
  import AdminBadge from '../../lib/components/admin/AdminBadge.svelte';
  import type { AdminTableColumn } from '../../lib/components/admin/types';
  import { Button, Callout } from '../../lib/components/ui';

  const SITE = 'https://kotbo.fr';
  const LOCALES: { key: FeaturePageLocale; label: string }[] = [
    { key: 'fr', label: 'Français' },
    { key: 'en', label: 'Anglais' },
  ];

  type Draft = FeaturePageInput & { id: string | null; key: string };

  let pages = $state<FeaturePage[]>([]);
  let rebuildConfigured = $state(true);
  let modulesWithoutSeed = $state<string[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let filter = $state('all');
  let search = $state('');
  let importing = $state(false);

  let drawerOpen = $state(false);
  let draft = $state<Draft | null>(null);
  let locale = $state<FeaturePageLocale>('fr');
  let saving = $state(false);
  let deleting = $state(false);

  const pageColumns: AdminTableColumn[] = [
    { key: 'page', label: 'Page' },
    { key: 'status', label: 'État', width: 'w-48' },
    { key: 'updated', label: 'Modifiée le', align: 'right', width: 'w-32', hideBelow: 'md' },
  ];

  const counts = $derived({
    all: pages.length,
    published: pages.filter((page) => page.published).length,
    draft: pages.filter((page) => !page.published).length,
  });

  const visible = $derived(
    pages.filter((page) => {
      if (filter === 'published' && !page.published) return false;
      if (filter === 'draft' && page.published) return false;
      const query = search.trim().toLowerCase();
      if (!query) return true;
      return [page.key, page.slug.fr, page.slug.en, page.content.fr.name, page.content.en.name]
        .some((value) => value.toLowerCase().includes(query));
    }),
  );

  /** Les mêmes règles que le serveur, pour les montrer avant l'envoi. */
  function missingFor(content: Record<FeaturePageLocale, FeaturePageText>): string[] {
    const missing: string[] = [];
    for (const { key, label } of LOCALES) {
      const t = content[key];
      const lang = label.toLowerCase();
      if (!t.name.trim()) missing.push(`le nom (${lang})`);
      if (!t.title.trim()) missing.push(`le titre de la page (${lang})`);
      if (!t.description.trim()) missing.push(`la meta description (${lang})`);
      if (!t.h1.trim()) missing.push(`le titre principal (${lang})`);
      if (!t.lead.trim()) missing.push(`l'introduction (${lang})`);
      if (!t.sections.some((section) => section.h2.trim() && section.body.trim())) {
        missing.push(`au moins une section avec titre et texte (${lang})`);
      }
      if (t.sections.some((section) => !section.h2.trim() || !section.body.trim())) {
        missing.push(`une section sans titre ou sans texte (${lang})`);
      }
      if (t.faq.some((entry) => !entry.q.trim() || !entry.a.trim())) {
        missing.push(`une question de FAQ incomplète (${lang})`);
      }
    }
    return missing;
  }

  const draftMissing = $derived(draft ? missingFor(draft.content) : []);

  function emptyText(): FeaturePageText {
    return { name: '', title: '', description: '', h1: '', lead: '', sections: [{ h2: '', body: '' }], faq: [] };
  }

  function pageUrl(slug: string, lang: FeaturePageLocale): string {
    return lang === 'en' ? `${SITE}/en/features/${slug}` : `${SITE}/fonctionnalites/${slug}`;
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  async function load() {
    loading = true;
    loadError = null;
    try {
      const result = await fetchFeaturePages();
      pages = result.pages;
      rebuildConfigured = result.rebuildConfigured;
      modulesWithoutSeed = result.modulesWithoutSeed;
    } catch (err) {
      loadError = errorMessage(err) ?? 'Erreur lors du chargement des pages';
    } finally {
      loading = false;
    }
  }

  async function runImport() {
    if (importing) return;
    importing = true;
    try {
      const result = await importFeaturePages();
      toast.success(
        result.created === 0
          ? m.afp_all_have_page()
          : m.afp_imported({ created: result.created, published: result.published }),
      );
      await load();
    } catch (err) {
      toast.error(errorMessage(err) ?? m.afp_import_error());
    } finally {
      importing = false;
    }
  }

  function openNew() {
    draft = {
      id: null,
      key: '',
      slug: { fr: '', en: '' },
      modules: [],
      content: { fr: emptyText(), en: emptyText() },
      published: false,
      position: pages.reduce((max, page) => Math.max(max, page.position), 0) + 1,
    };
    locale = 'fr';
    drawerOpen = true;
  }

  function openEdit(page: FeaturePage) {
    draft = {
      id: page.id,
      key: page.key,
      slug: { ...page.slug },
      modules: [...page.modules],
      content: structuredClone($state.snapshot(page.content)),
      published: page.published,
      position: page.position,
    };
    locale = 'fr';
    drawerOpen = true;
  }

  async function save(publish?: boolean) {
    if (!draft || saving) return;
    const input: FeaturePageInput = {
      key: draft.key,
      slug: draft.slug,
      modules: draft.modules,
      content: draft.content,
      published: publish ?? draft.published,
      position: draft.position,
    };
    saving = true;
    try {
      const saved = draft.id ? await updateFeaturePage(draft.id, input) : await createFeaturePage(input);
      pages = draft.id
        ? pages.map((page) => (page.id === saved.id ? saved : page))
        : [...pages, saved].sort((a, b) => a.position - b.position);
      draft = { ...draft, id: saved.id, published: saved.published };
      toast.success(
        saved.published
          ? rebuildConfigured
            ? m.afp_saved_rebuilding()
            : m.afp_saved_next_deploy()
          : m.afp_draft_saved(),
      );
    } catch (err) {
      toast.error(errorMessage(err) ?? m.afp_save_error());
    } finally {
      saving = false;
    }
  }

  async function remove() {
    if (!draft?.id || deleting) return;
    const name = draft.content.fr.name || draft.key;
    if (!(await confirmDialog.danger(`Supprimer la page « ${name} » ?`, draft.published ? 'Elle disparaîtra du site à sa prochaine reconstruction.' : '', 'Supprimer'))) return;
    deleting = true;
    try {
      await deleteFeaturePage(draft.id);
      pages = pages.filter((page) => page.id !== draft?.id);
      drawerOpen = false;
      draft = null;
      toast.success(m.afp_page_deleted());
    } catch (err) {
      toast.error(errorMessage(err) ?? m.afp_delete_error());
    } finally {
      deleting = false;
    }
  }

  function setModules(value: string) {
    if (!draft) return;
    draft.modules = value.split(',').map((item) => item.trim()).filter(Boolean);
  }

  function setPoints(sectionIndex: number, value: string) {
    if (!draft) return;
    const points = value.split('\n').map((item) => item.trim()).filter(Boolean);
    const section = draft.content[locale].sections[sectionIndex];
    if (points.length > 0) section.points = points;
    else delete section.points;
  }

  function move<T>(items: T[], index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    [items[index], items[target]] = [items[target], items[index]];
  }

  onMount(load);

  const inputClass = 'input';
  const labelClass = 'block text-xs font-medium text-on-surface-variant';
</script>

{#snippet counter(value: string, max: number)}
  <span class="text-[11px] tabular-nums {value.length > max ? 'text-error font-bold' : 'text-on-surface-variant'}">
    {value.length}/{max}
  </span>
{/snippet}

<AdminShell
  title="Pages du site"
  description="Une page par fonctionnalité sur kotbo.fr, en français et en anglais. Seules les pages publiées sont en ligne."
>
  {#snippet actions()}
    <Button icon="Download" loading={importing} title="Crée une page en brouillon pour chaque module qui n'en a pas" onclick={runImport}>
      Importer les modules
    </Button>
    <Button variant="primary" icon="Plus" onclick={openNew}>Nouvelle page</Button>
  {/snippet}

  {#if !loading && !rebuildConfigured}
    <Callout variant="warning">
      La reconstruction automatique du site n'est pas configurée (<code class="font-mono text-xs">LANDING_DEPLOY_TOKEN</code>).
      Les pages publiées seront en ligne au prochain déploiement de kotbo.fr.
    </Callout>
  {/if}

  {#if modulesWithoutSeed.length > 0}
    <p class="text-xs text-on-surface-variant">
      Modules sans page à importer (adresse et nom anglais à définir dans <code class="font-mono">featurePageSeeds.ts</code>) :
      {modulesWithoutSeed.join(', ')}.
    </p>
  {/if}

  {#if loadError}
    <Callout variant="danger">
      {loadError}
      {#snippet actions()}
        <Button size="sm" icon="RefreshCw" onclick={load}>Réessayer</Button>
      {/snippet}
    </Callout>
  {/if}

  <AdminToolbar
    bind:search
    bind:activeFilter={filter}
    placeholder="Rechercher une page…"
    filters={[
      { value: 'all', label: 'Toutes', count: counts.all },
      { value: 'published', label: 'Publiées', count: counts.published },
      { value: 'draft', label: 'Brouillons', count: counts.draft },
    ]}
    resultCount={visible.length}
    resultLabel="page"
  />

  <AdminTable
    columns={pageColumns}
    rows={visible}
    {loading}
    emptyIcon="Globe"
    emptyTitle={pages.length === 0 ? "Aucune page pour l'instant" : 'Aucune page ne correspond'}
    emptyHint={pages.length === 0
      ? '« Importer les modules » crée une page par fonctionnalité de Kotbo : les pages déjà rédigées pour le site sont publiées, les autres arrivent en brouillon.'
      : 'Élargis la recherche ou change de filtre.'}
  >
    {#snippet row(item, _index)}
      {@const page = item as FeaturePage}
      <tr class="border-b border-outline-variant/12 hover:bg-on-surface/3 transition-colors cursor-pointer" onclick={() => openEdit(page)}>
        <td class="px-4 py-3">
          <!-- Le bouton porte l'accès clavier ; le clic sur la ligne n'est qu'un confort à la souris. -->
          <button type="button" class="text-left min-w-0 focus-visible:outline-2 focus-visible:outline-primary rounded" onclick={(e) => { e.stopPropagation(); openEdit(page); }}>
            <span class="block text-body-sm font-semibold text-on-surface truncate">{page.content.fr.name || page.key}</span>
            <span class="block text-2xs text-on-surface-variant truncate font-mono">/fonctionnalites/{page.slug.fr} · /en/features/{page.slug.en}</span>
          </button>
        </td>
        <td class="px-4 py-3">
          <AdminBadge label={page.published ? 'Publiée' : 'Brouillon'} tone={page.published ? 'success' : 'neutral'} dot />
          {#if !page.published && page.missing.length > 0}
            <p class="text-2xs text-on-surface-variant mt-1">{page.missing.length} élément(s) à compléter</p>
          {/if}
        </td>
        <td class="px-4 py-3 text-right text-xs text-on-surface-variant hidden md:table-cell">{formatDate(page.updatedAt)}</td>
      </tr>
    {/snippet}
  </AdminTable>
</AdminShell>

<AdminDrawer
  bind:open={drawerOpen}
  width="lg"
  title={draft?.id ? draft.content.fr.name || draft.key : 'Nouvelle page'}
  subtitle={draft?.published ? 'Publiée sur kotbo.fr' : 'Brouillon'}
  onClose={() => (draft = null)}
>
  {#if draft}
    <div class="space-y-6">
      <section class="space-y-3">
        <h3 class="text-sm font-semibold text-on-surface">Adresse et rattachement</h3>
        {#if !draft.id}
          <label class="block space-y-1.5">
            <span class={labelClass}>Clé (celle du module si la page en décrit un, ex. <code class="font-mono">tickets</code>)</span>
            <input bind:value={draft.key} placeholder="tickets" class={inputClass} />
          </label>
        {/if}
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="block space-y-1.5">
            <span class={labelClass}>Adresse française</span>
            <div class="flex items-center gap-1 text-xs text-on-surface-variant">
              <span class="font-mono">/fonctionnalites/</span>
              <input bind:value={draft.slug.fr} placeholder="tickets-discord" class={inputClass} />
            </div>
          </label>
          <label class="block space-y-1.5">
            <span class={labelClass}>Adresse anglaise</span>
            <div class="flex items-center gap-1 text-xs text-on-surface-variant">
              <span class="font-mono">/en/features/</span>
              <input bind:value={draft.slug.en} placeholder="discord-tickets" class={inputClass} />
            </div>
          </label>
        </div>
        <div class="grid gap-3 sm:grid-cols-[1fr_8rem]">
          <label class="block space-y-1.5">
            <span class={labelClass}>Modules du catalogue qui mènent à la page (noms FR et EN, séparés par des virgules)</span>
            <input value={draft.modules.join(', ')} onchange={(e) => setModules(e.currentTarget.value)} placeholder="Tickets support, Support tickets" class={inputClass} />
          </label>
          <label class="block space-y-1.5">
            <span class={labelClass}>Ordre</span>
            <input type="number" bind:value={draft.position} class={inputClass} />
          </label>
        </div>
        {#if draft.id && draft.published}
          <div class="flex flex-wrap gap-3 text-sm">
            {#each LOCALES as lang (lang.key)}
              <a href={pageUrl(draft.slug[lang.key], lang.key)} target="_blank" rel="noopener" class="inline-flex items-center gap-1.5 text-primary hover:underline">
                <Papicon icon="ExternalLink" size={13} /> Voir en {lang.label.toLowerCase()}
              </a>
            {/each}
          </div>
        {/if}
      </section>

      <div class="flex gap-1 p-1 rounded-xl bg-surface-container-low/60 border border-outline-variant/10 w-fit" role="tablist" aria-label="Langue">
        {#each LOCALES as lang (lang.key)}
          <button
            role="tab"
            aria-selected={locale === lang.key}
            onclick={() => (locale = lang.key)}
            class="px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors {locale === lang.key ? 'bg-primary/15 text-primary' : 'text-on-surface-variant hover:text-on-surface'}"
          >
            {lang.label}
          </button>
        {/each}
      </div>

      {#key locale}
        {@const t = draft.content[locale]}
        <section class="space-y-3">
          <h3 class="text-sm font-semibold text-on-surface">Référencement</h3>
          <label class="block space-y-1.5">
            <span class="flex justify-between {labelClass}">Nom court (liens, pied de page) {@render counter(t.name, 40)}</span>
            <input bind:value={t.name} class={inputClass} />
          </label>
          <label class="block space-y-1.5">
            <span class="flex justify-between {labelClass}">Titre de la page, la requête visée en tête {@render counter(t.title, 60)}</span>
            <input bind:value={t.title} class={inputClass} />
          </label>
          <label class="block space-y-1.5">
            <span class="flex justify-between {labelClass}">Meta description {@render counter(t.description, 160)}</span>
            <textarea bind:value={t.description} rows="2" class={inputClass}></textarea>
          </label>
        </section>

        <section class="space-y-3">
          <h3 class="text-sm font-semibold text-on-surface">En-tête de la page</h3>
          <label class="block space-y-1.5">
            <span class={labelClass}>Titre principal (H1)</span>
            <input bind:value={t.h1} class={inputClass} />
          </label>
          <label class="block space-y-1.5">
            <span class={labelClass}>Introduction</span>
            <textarea bind:value={t.lead} rows="3" class={inputClass}></textarea>
          </label>
        </section>

        <section class="space-y-3">
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-semibold text-on-surface">Sections</h3>
            <button onclick={() => t.sections.push({ h2: '', body: '' })} class="text-sm font-semibold text-primary flex items-center gap-1 hover:underline">
              <Papicon icon="Plus" size={14} /> Ajouter une section
            </button>
          </div>
          {#each t.sections as section, index (index)}
            <div class="rounded-xl border border-outline-variant/15 p-4 space-y-3">
              <div class="flex items-center gap-2">
                <input bind:value={section.h2} placeholder="Titre de la section (H2)" class={inputClass} />
                <button onclick={() => move(t.sections, index, -1)} disabled={index === 0} aria-label="Monter" class="p-2 rounded-lg text-on-surface-variant hover:bg-on-surface/5 disabled:opacity-30">
                  <Papicon icon="ChevronUp" size={15} />
                </button>
                <button onclick={() => move(t.sections, index, 1)} disabled={index === t.sections.length - 1} aria-label="Descendre" class="p-2 rounded-lg text-on-surface-variant hover:bg-on-surface/5 disabled:opacity-30">
                  <Papicon icon="ChevronDown" size={15} />
                </button>
                <button onclick={() => t.sections.splice(index, 1)} aria-label="Supprimer la section" class="p-2 rounded-lg text-on-surface-variant hover:text-error hover:bg-error/10">
                  <Papicon icon="Trash2" size={15} />
                </button>
              </div>
              <textarea bind:value={section.body} rows="3" placeholder="Texte de la section" class={inputClass}></textarea>
              <label class="block space-y-1.5">
                <span class={labelClass}>Liste à puces (facultative, une ligne par point)</span>
                <textarea value={(section.points ?? []).join('\n')} onchange={(e) => setPoints(index, e.currentTarget.value)} rows="3" class={inputClass}></textarea>
              </label>
            </div>
          {/each}
        </section>

        <section class="space-y-3">
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-semibold text-on-surface">FAQ</h3>
            <button onclick={() => t.faq.push({ q: '', a: '' })} class="text-sm font-semibold text-primary flex items-center gap-1 hover:underline">
              <Papicon icon="Plus" size={14} /> Ajouter une question
            </button>
          </div>
          <p class="text-xs text-on-surface-variant">
            Les questions telles qu'on les tape dans Google. « Est-ce gratuit ? » est ajoutée d'office par le site.
          </p>
          {#each t.faq as entry, index (index)}
            <div class="rounded-xl border border-outline-variant/15 p-4 space-y-3">
              <div class="flex items-center gap-2">
                <input bind:value={entry.q} placeholder="Question" class={inputClass} />
                <button onclick={() => t.faq.splice(index, 1)} aria-label="Supprimer la question" class="p-2 rounded-lg text-on-surface-variant hover:text-error hover:bg-error/10">
                  <Papicon icon="Trash2" size={15} />
                </button>
              </div>
              <textarea bind:value={entry.a} rows="3" placeholder="Réponse" class={inputClass}></textarea>
            </div>
          {/each}
        </section>
      {/key}

      {#if draftMissing.length > 0}
        <div class="rounded-xl bg-warning/10 border border-warning/20 px-4 py-3 text-sm text-on-surface">
          <p class="font-semibold">Pour publier, il manque :</p>
          <ul class="mt-1 list-disc pl-5 text-on-surface-variant">
            {#each draftMissing as item (item)}<li>{item}</li>{/each}
          </ul>
        </div>
      {/if}
    </div>
  {/if}

  {#snippet footer()}
    {#if draft}
      <div class="flex flex-wrap items-center gap-2">
        {#if draft.id}
          <Button variant="danger" icon="Trash2" loading={deleting} onclick={remove}>Supprimer</Button>
        {/if}
        <div class="ml-auto flex flex-wrap gap-2">
          <Button loading={saving} onclick={() => save(false)}>
            {draft.published ? 'Repasser en brouillon' : 'Enregistrer le brouillon'}
          </Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={draftMissing.length > 0}
            disabledReason="Complète d'abord les éléments listés au-dessus."
            onclick={() => save(true)}
          >
            {draft.published ? 'Enregistrer' : 'Publier'}
          </Button>
        </div>
      </div>
    {/if}
  {/snippet}
</AdminDrawer>
