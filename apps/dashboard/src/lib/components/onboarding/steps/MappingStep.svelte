<script lang="ts">
  import { m } from '../../../i18n';
  /**
   * « Quel salon est quoi ? », sur un seul ecran.
   *
   * Huit ecrans se suivaient, un par section, pour confirmer presque partout ce
   * que Kotbo avait reconnu. Tout est maintenant pre-rempli et « Continuer »
   * accepte l'ensemble ; une section ne s'ouvre d'office que si elle porte une
   * ligne a creer, les seules qui meritent un regard.
   *
   * Le seul ecran du parcours ou c'est le serveur qui parle et Kotbo qui
   * ecoute. Avant lui, la reprise procedait par ressemblance de noms : ce
   * qu'elle reconnaissait etait laisse tranquille, tout le reste etait recree.
   * Un `#logs-mod` de trois ans ne ressemblait pas assez a `#staff-logs`, donc
   * un second salon de journalisation se posait a cote - et l'administrateur le
   * decouvrait sur Discord, apres coup, avec ses moderateurs repartis entre les
   * deux.
   *
   * Trois issues par ligne, et aucune n'est prise a sa place : utiliser un
   * salon qui existe, en creer un, ne rien faire. La detection reste, retrogradee
   * au rang de suggestion pre-remplie - ce qui est la seule place qu'elle merite
   * tant qu'elle repose sur des noms. Ce que Kotbo a pose lui-meme est verrouille
   * : on ne redesigne pas un salon dont on tient l'identifiant.
   *
   * La categorie ouvre l'ecran plutot que de figurer en fin de liste, parce que
   * « ou est-ce que ca vit ? » se repond avant « qu'est-ce qui vit la ? ». Elle
   * n'offre pas « ne rien faire » : le bot rattache d'office la categorie d'un
   * salon retenu, un ecran qui pretendrait le contraire mentirait. Elle
   * s'efface d'elle-meme quand tous ses salons ont ete ecartes.
   */
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import { onboardingData } from '../../../stores/onboardingData.svelte';
  import {
    dormantModules,
    isSkippable,
    linesOf,
    screensFor,
    type MappingDecision,
    type ThemeKey,
  } from '../../../onboarding';
  import type { ServerTemplatePlanItem } from '../../../api';
  import Papicon from '../../Papicon.svelte';
  import WizardShell from '../WizardShell.svelte';

  const { onEditTracks, skip }: { onEditTracks: () => void; skip?: () => void } = $props();

  const template = $derived(onboardingData.template);
  const theme = $derived<ThemeKey>(wizard.theme ?? 'communaute');
  const mapping = $derived(wizard.mapping);
  const matches = $derived(template?.matches ?? {});

  const sections = $derived(
    (template ? screensFor(template.plan, theme) : []).map((screen) => {
      const lines = linesOf(template!.plan, screen, theme);
      return {
        screen,
        category: lines.find((line) => line.kind === 'category') ?? null,
        contents: lines.filter((line) => line.kind !== 'category'),
      };
    }),
  );
  const contents = $derived(sections.flatMap((section) => section.contents));

  type Section = (typeof sections)[number];

  const decisionOf = (key: string): MappingDecision =>
    mapping[key] ?? { mode: 'create', id: null };

  /**
   * Ce que Kotbo a pose lui-meme, dont on tient l'identifiant.
   *
   * Ces lignes ne se rejouent pas : redesigner un salon dont la trace existe
   * reviendrait a en abandonner un qui porte deja des messages, sans rien
   * gagner. Elles s'affichent rattachees et fermees.
   */
  const isLocked = (key: string): boolean => matches[key]?.source === 'ref';

  /** Ce que la detection propose sans l'avoir applique : la ligne le dit. */
  const isSuggested = (key: string): boolean => {
    const match = matches[key];
    return !!match && match.source === 'name' && decisionOf(key).id === match.id;
  };

  /**
   * Les candidats d'une ligne, dans la nature qui lui convient.
   *
   * Un salon vocal nomme « général » ne remplace pas le salon textuel du meme
   * nom, et une categorie encore moins : le bot le refuserait, autant ne pas le
   * proposer.
   */
  function candidatesFor(item: ServerTemplatePlanItem) {
    const inventory = template?.inventory;
    if (!inventory) return [] as { id: string; name: string; disabled: boolean; note: string | null }[];

    // Un meme salon ne peut pas tenir deux roles du plan : il recevrait deux
    // cablages contradictoires, et le second effacerait le premier.
    const takenBy = new Map<string, string>();
    for (const [key, decision] of Object.entries(mapping)) {
      if (key === item.key || decision.mode !== 'adopt' || !decision.id) continue;
      const other = template?.plan.find((entry) => entry.key === key);
      if (other) takenBy.set(decision.id, other.name);
    }

    if (item.kind === 'role') {
      return inventory.roles.map((role) => ({
        id: role.id,
        name: role.name,
        disabled: !role.assignable || takenBy.has(role.id),
        note: takenBy.get(role.id)
          ? m.obx_mp_taken({ name: takenBy.get(role.id) ?? '' })
          : role.managed
            ? m.obx_mp_managed()
            : !role.assignable
              ? m.obx_mp_above()
              : null,
      }));
    }

    return inventory.channels
      .filter((channel) => channel.kind === item.kind)
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        disabled: takenBy.has(channel.id),
        note: takenBy.get(channel.id) ? m.obx_mp_taken({ name: takenBy.get(channel.id) ?? '' }) : null,
      }));
  }

  /** L'etat du menu, encode en une valeur : c'est ce que le `select` porte. */
  const valueOf = (key: string): string => {
    const decision = decisionOf(key);
    return decision.mode === 'adopt' && decision.id ? `adopt:${decision.id}` : decision.mode;
  };

  function choose(section: Section, item: ServerTemplatePlanItem, raw: string): void {
    if (raw.startsWith('adopt:')) {
      wizard.decide(item.key, { mode: 'adopt', id: raw.slice(6) });
    } else if (raw === 'skip') {
      wizard.decide(item.key, { mode: 'skip', id: null });
    } else {
      wizard.decide(item.key, { mode: 'create', id: null });
    }
    syncCategory(section);
  }

  /**
   * La categorie suit ses salons.
   *
   * Le bot rattache d'office la categorie de tout salon retenu : la laisser
   * cochee quand plus rien n'y va poserait une categorie vide, et la laisser
   * decochee quand un salon y va serait un ecran qui raconte autre chose que ce
   * qui se passe. On la deduit donc, on ne la demande pas.
   */
  function syncCategory({ category, contents }: Section): void {
    if (!category) return;
    const anyKept = contents.some((line) => decisionOf(line.key).mode !== 'skip');
    const current = decisionOf(category.key);

    if (!anyKept && current.mode !== 'skip') {
      wizard.decide(category.key, { mode: 'skip', id: null });
    } else if (anyKept && current.mode === 'skip') {
      const match = matches[category.key];
      wizard.decide(category.key, match ? { mode: 'adopt', id: match.id } : { mode: 'create', id: null });
    }
  }

  /** Ou atterrira ce qu'une section cree. */
  function destinationOf(category: ServerTemplatePlanItem | null): string {
    if (!category) return m.obx_mp_root();
    const decision = decisionOf(category.key);
    if (decision.mode === 'skip') return m.obx_mp_root();
    if (decision.mode === 'adopt') {
      const found = template?.inventory.channels.find((channel) => channel.id === decision.id);
      return found ? m.obx_mp_in({ name: found.name }) : m.obx_mp_in_chosen();
    }
    return m.obx_mp_in_new({ name: category.name });
  }

  const countOf = (lines: ServerTemplatePlanItem[], mode: MappingDecision['mode']) =>
    lines.filter((line) => decisionOf(line.key).mode === mode).length;

  /**
   * Les sections ouvertes d'office, figees a la premiere lecture : une section
   * qui se refermerait sous le doigt pendant qu'on la regle serait pire.
   */
  let initiallyOpen = $state<Set<string> | null>(null);
  $effect(() => {
    if (initiallyOpen || sections.length === 0) return;
    initiallyOpen = new Set(
      sections.filter((section) => countOf(section.contents, 'create') > 0).map((section) => section.screen.step),
    );
  });

  /** Les modules que les lignes ecartees de cet ecran laisseront eteints. */
  const dormant = $derived(
    template
      ? dormantModules(template.plan, mapping).filter((entry) =>
          contents.some((line) => line.name === entry.because),
        )
      : []
  );

  const summary = (lines: ServerTemplatePlanItem[]) =>
    m.onb_map_tally({
      adopted: countOf(lines, 'adopt'),
      created: countOf(lines, 'create'),
      skipped: countOf(lines, 'skip'),
    });
</script>

<WizardShell
  title={m.onb_map_title()}
  lead={m.onb_map_lead()}
  {onEditTracks}
>
  <div class="space-y-3">
    <p class="text-sm font-semibold text-on-surface" aria-live="polite">{summary(contents)}</p>

    {#each sections as section (section.screen.step)}
      {@const category = section.category}
      <details class="section-card-flush" open={initiallyOpen?.has(section.screen.step)}>
        <summary class="list-row list-row--pressable">
          <span class="list-row__text">
            <span class="icon-disc" aria-hidden="true"><Papicon icon={section.screen.icon} size={15} /></span>
            <span class="min-w-0">
              <span class="list-row__label">{section.screen.title}</span>
              <span class="list-row__desc">{summary(section.contents)}</span>
            </span>
          </span>
          <Papicon icon="chevron-down" size={15} class="shrink-0 text-on-surface-variant" />
        </summary>

        <div class="space-y-3 border-t border-outline-variant p-3">
    <!-- ── La catégorie : où tout ça vit ─────────────────────────────────── -->
    {#if category}
      {@const locked = isLocked(category.key)}
      {@const skipped = decisionOf(category.key).mode === 'skip'}
      <div class="rounded-xl border border-outline-variant/30 bg-surface-container-low/40 px-4 py-3.5">
        <div class="flex items-center gap-2 mb-2">
          <Papicon icon="folder" size={13} class="text-primary/70" />
          <span class="text-xs font-semibold text-on-surface">{m.obx_mp_category()}</span>
          {#if locked}
            <span class="text-2xs font-medium text-primary/70 rounded-full bg-primary/10 px-2 py-0.5">
              {m.obx_mp_locked()}
            </span>
          {/if}
        </div>

        {#if skipped}
          <p class="text-body-sm text-on-surface-variant leading-relaxed">
            {m.obx_mp_empty_category()}
          </p>
        {:else}
          <select aria-label={m.obx_mp_category()}
            value={valueOf(category.key)}
            disabled={locked}
            onchange={(event) => choose(section, category, event.currentTarget.value)}
            class="w-full rounded-lg border border-field-border bg-surface-container-lowest/60 px-3 py-2 text-body-sm text-on-surface disabled:opacity-50"
          >
            <optgroup label={m.obx_mp_server_categories()}>
              {#each candidatesFor(category) as option (option.id)}
                <option value="adopt:{option.id}" disabled={option.disabled}>
                  {option.name}{option.note ? ` (${option.note})` : ''}
                </option>
              {/each}
            </optgroup>
            <optgroup label={m.obx_mp_otherwise()}>
              <option value="create">{m.obx_mp_create({ name: category.name })}</option>
            </optgroup>
          </select>
        {/if}
      </div>
    {/if}

    <!-- ── Les lignes ────────────────────────────────────────────────────── -->
    <div class="space-y-2.5">
      {#each section.contents as line (line.key)}
        {@const locked = isLocked(line.key)}
        {@const decision = decisionOf(line.key)}
        <div
          class="rounded-xl border px-4 py-3 transition-colors {decision.mode === 'skip'
            ? 'border-outline-variant/20 bg-surface-container-low/20'
            : 'border-outline-variant/30 bg-surface-container-low/40'}"
        >
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0 pt-1.5">
              <p class="flex items-center gap-1.5 text-body-sm font-medium text-on-surface truncate">
                <Papicon
                  icon={line.kind === 'role' ? 'shield' : line.kind === 'voice' ? 'mic' : 'message-circle'}
                  size={12}
                  class="shrink-0 text-on-surface-variant/45"
                />
                <span class="truncate {decision.mode === 'skip' ? 'text-on-surface-variant/45 line-through' : ''}">
                  {line.name}
                </span>
              </p>
              {#if locked}
                <p class="mt-1 text-2xs text-primary/70">{m.obx_mp_locked_line()}</p>
              {:else if isSuggested(line.key)}
                <!-- La ressemblance des noms a trouve quelque chose. Le dire, et
                     ne pas s'en contenter : c'est exactement ce rapprochement
                     silencieux qui produisait les doublons quand il ratait. -->
                <p class="mt-1 text-2xs text-on-surface-variant/55">
                  {m.obx_mp_suggested()}
                </p>
              {:else if decision.mode === 'create'}
                <p class="mt-1 text-2xs text-on-surface-variant/45">
                  {m.obx_mp_will_create({ where: destinationOf(category) })}
                </p>
              {/if}
            </div>

            <select aria-label={line.name}
              value={valueOf(line.key)}
              disabled={locked}
              onchange={(event) => choose(section, line, event.currentTarget.value)}
              class="shrink-0 w-[15.5rem] max-w-[52%] rounded-lg border border-field-border bg-surface-container-lowest/60 px-3 py-2 text-body-sm text-on-surface disabled:opacity-50"
            >
              <optgroup label={line.kind === 'role' ? m.obx_mp_server_roles() : m.obx_mp_server_channels()}>
                {#each candidatesFor(line) as option (option.id)}
                  <option value="adopt:{option.id}" disabled={option.disabled}>
                    {option.name}{option.note ? ` (${option.note})` : ''}
                  </option>
                {/each}
              </optgroup>
              <optgroup label={m.obx_mp_otherwise()}>
                <option value="create">{m.obx_mp_create({ name: line.name })}</option>
                {#if isSkippable(line)}
                  <option value="skip">{m.obx_mp_skip()}</option>
                {/if}
              </optgroup>
            </select>
          </div>
        </div>
      {/each}
    </div>

        </div>
      </details>
    {/each}

    {#if dormant.length > 0}
      <!-- Ecarter une ligne est un choix legitime ; le faire sans savoir ce qui
           s'eteint avec elle ne l'est pas. -->
      <div class="rounded-xl border border-outline-variant/30 bg-surface-container-low/30 px-4 py-3">
        <p class="text-xs text-on-surface-variant leading-relaxed">
          <Papicon icon="info" size={12} class="inline text-on-surface-variant mr-1" />
          {#each dormant as entry, index (entry.key)}{index > 0 ? ', ' : ''}<span class="font-medium text-on-surface">{entry.name}</span>{/each}
          {dormant.length > 1 ? m.obx_mp_dormant_many() : m.obx_mp_dormant_one()}
        </p>
      </div>
    {/if}
  </div>

  {#snippet footer()}
    {#if skip}
      <button
        type="button"
        onclick={skip}
        class="btn btn-ghost"
      >
        {m.obx_skip()}
      </button>
    {/if}
    <button
      type="button"
      onclick={() => wizard.complete('map-access')}
      class="btn btn-primary"
    >
      {m.onb_map_accept()}
      <Papicon icon="ChevronRight" size={15} />
    </button>
  {/snippet}
</WizardShell>
