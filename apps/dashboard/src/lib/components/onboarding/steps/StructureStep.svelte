<script lang="ts">
  /**
   * Le seul moment ou l'on voit Kotbo agir sur son propre serveur.
   *
   * Trois temps : ce qui va etre pose, la pose, ce qui a ete pose. Le deuxieme
   * n'existait pas - un bouton passait a « En cours… » et l'ecran suivant
   * annoncait des chiffres qu'on n'avait pas vus arriver. Il dure maintenant le
   * temps du travail reel, en plein ecran, et c'est cette minute-la qui donne
   * envie de garder ce qu'on vient de voir apparaitre.
   *
   * Sur un serveur habite, l'ecran ne posait rien : la maquette complete y
   * aurait double des salons dont des gens se servent. Puis il a pose ce qu'un
   * rapprochement de noms ne reconnaissait pas - ce qui revenait au meme des
   * que le nom differait, et c'est le reproche qui est remonte : un serveur
   * ressortait avec un second salon de logs a cote du sien.
   *
   * Les ecrans de mappage repondent maintenant a la question ligne par ligne,
   * et celui-ci n'en est plus que la confirmation : il recapitule ce qui va
   * etre relie, cree, laisse de cote, puis execute. Ce qui est relie ne bouge
   * pas d'un pixel sur Discord - le bot le reprend par identifiant, sans le
   * renommer ni le deplacer. Un serveur de trois ans qui n'a jamais eu de salon
   * de tickets voit ses tickets se poser, et son `#reglement` ecrit a la main
   * rester intact et rempli.
   */
  import { toast } from '../../../stores/toast.svelte';
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import { onboardingData } from '../../../stores/onboardingData.svelte';
  import {
    adoptionsFrom,
    alreadyPresent,
    buildSequence,
    celebrateFinale,
    defaultsMapping,
    mappingTally,
    selectionFor,
    selectionFrom,
    summarize,
    type ThemeKey,
  } from '../../../onboarding';
  import { applyServerTemplate } from '../../../api';
  import BuildSequence from '../BuildSequence.svelte';
  import CountUp from '../CountUp.svelte';
  import KotboMark from '../KotboMark.svelte';
  import Papicon from '../../Papicon.svelte';
  import WizardShell from '../WizardShell.svelte';

  import { errorMessage } from '@kotbo/shared';
  const { onEditTracks }: { onEditTracks: () => void } = $props();

  const template = $derived(onboardingData.template);
  const kind = $derived(wizard.kind ?? 'new');
  const theme = $derived<ThemeKey>(wizard.theme ?? 'communaute');

  /**
   * Le mappage a repondu pour nous, quand il a eu lieu.
   *
   * Sur un serveur habite, la selection ne se deduit plus d'un rapprochement de
   * noms mais de ce qui a ete decide ligne a ligne. Sur un serveur neuf, il n'y
   * avait rien a rapprocher : les ecrans de mappage ne se sont pas ouverts, et
   * c'est la vocation choisie qui decide, comme avant.
   */
  const mapped = $derived(wizard.structured && Object.keys(wizard.mapping).length > 0);

  /**
   * Le perimetre de la vocation, avant tout retrait.
   *
   * Sert a borner les salons poses par Discord : un serveur d'entraide, qui ne
   * retient pas les vocaux, n'a pas a se brancher sur la categorie vocale que
   * Discord lui a mise.
   */
  const scope = $derived(template ? selectionFor(template.plan, kind, theme, []) : []);

  /**
   * Ce que Discord a pose a la creation du serveur, repris sans le demander.
   *
   * Un serveur tout neuf porte deja « Salons textuels / général » et « Salons
   * vocaux / Général » - les noms memes de la maquette. Sans cette reprise, la
   * pose directe en creait les jumeaux et le serveur ressortait avec deux
   * salons generaux. La question n'est pas posee parce qu'il n'y a rien a
   * demander : personne n'a choisi ces salons, et s'y brancher ne prive
   * personne de rien.
   *
   * Sur un serveur habite, le mappage a deja repondu ligne par ligne : ces
   * salons y figurent comme les autres, et cette reprise-la n'a pas lieu.
   */
  const defaults = $derived(!template || mapped ? {} : defaultsMapping(template.defaults ?? {}, scope));

  const selection = $derived(
    !template
      ? []
      : mapped
        ? selectionFrom(template.plan, wizard.mapping)
        // Les lignes reprises restent dans la selection : c'est leur presence
        // qui declenche le cablage et qui fait de la categorie reprise le
        // parent des salons poses dedans. `selectionFor` les retire sur un
        // serveur existant, ou elles comptent pour deja faites.
        : [...new Set([
            ...selectionFor(template.plan, kind, theme, template.present ?? []),
            ...Object.keys(defaults),
          ])]
  );

  /** Ce qui a ete decide pour chaque ligne, mappage ou reprise d'office. */
  const decisions = $derived(mapped ? wizard.mapping : defaults);

  /** Les identifiants designes : ce que le bot reprendra sans y toucher. */
  const adopt = $derived(adoptionsFrom(decisions));

  /**
   * Compte sur ce qui sera cree, et rien d'autre : une ligne reprise est dans
   * la selection - c'est elle qui declenche le cablage - mais l'annoncer dans
   * « 12 salons » promettrait un salon general que le serveur a deja.
   */
  const planned = $derived(
    template
      ? summarize(template.plan, selection.filter((key) => decisions[key]?.mode !== 'adopt'))
      : null,
  );

  /**
   * Ce qui sera reellement cree, et rien d'autre.
   *
   * `summarize` enumere toute la selection, rattachements compris : les faire
   * defiler sous un « + » vert annoncerait la creation de salons qui existent
   * depuis trois ans. Apres mappage, on ne garde que les lignes decidees a
   * creer.
   */
  const toCreate = $derived(
    !template
      ? []
      : mapped
        ? template.plan
            .filter((item) => item.kind !== 'module' && wizard.mapping[item.key]?.mode === 'create')
            .map((item) => item.name)
        // Les salons repris de Discord sont dans la selection sans etre a
        // creer : les annoncer sous un « + » vert promettrait un salon general
        // qui existe deja.
        : template.plan
            .filter((item) => item.kind !== 'module'
              && selection.includes(item.key)
              && decisions[item.key]?.mode !== 'adopt')
            .map((item) => item.name)
  );
  const tally = $derived(template && mapped ? mappingTally(template.plan, wizard.mapping) : null);

  /**
   * Ce que Kotbo laisse en place.
   *
   * Apres mappage, ce sont les lignes reliees - designees ou reconnues. Sans
   * mappage, la detection par nom, comme avant.
   */
  const present = $derived(
    !template
      ? []
      : mapped
        ? template.plan
            .filter((item) => item.kind !== 'module' && wizard.mapping[item.key]?.mode === 'adopt')
            .map((item) => ({
              key: item.key,
              name: template.inventory.channels.find((c) => c.id === wizard.mapping[item.key]?.id)?.name
                ?? template.inventory.roles.find((r) => r.id === wizard.mapping[item.key]?.id)?.name
                ?? item.name,
              kind: item.kind,
            }))
        : alreadyPresent(template.plan, theme, template.present ?? [])
  );

  /**
   * Kotbo ne peut pas creer de salon, et on lui en demande.
   *
   * Mesure sur ce qui sera reellement cree, pas sur la selection : apres
   * mappage, celle-ci contient surtout des rattachements, qui ne demandent
   * aucune permission de creation. Un serveur ou tout existe deja et ou rien
   * n'est a poser se voyait sinon refuser une pose qui n'avait rien a poser.
   */
  const blocked = $derived(
    !!template
      && !template.canCreateChannels
      && (tally ? tally.created > 0 : planned !== null && planned.channels > 0)
  );

  let phase = $state<'plan' | 'building' | 'built'>('plan');
  let ready = $state(false);
  let sequence = $state<{ key: string; name: string; kind: string }[]>([]);

  const built = $derived(onboardingData.built);

  async function apply() {
    if (!template || onboardingData.busy) return;

    sequence = buildSequence(template.plan, selection, decisions);
    // Une selection qui ne contient que des modules n'a rien a regarder se
    // poser : une sequence vide se contenterait d'un ecran fige.
    const animated = sequence.length > 0;

    onboardingData.busy = true;
    if (animated) { phase = 'building'; ready = false; }

    try {
      const result = await applyServerTemplate(selection, adopt);
      const created = result.items.filter((entry) => entry.created);
      const roles = created.filter((e) => e.key.startsWith('role.') || e.key === 'captcha.role').length;
      const categories = created.filter((e) => e.key.endsWith('.category')).length;
      onboardingData.built = {
        roles,
        categories,
        channels: created.length - roles - categories,
        modules: result.modules.length + result.preparedModules.length,
      };
      for (const warning of result.warnings) toast.info(warning);

      if (animated) {
        // L'animation finit d'elle-meme, puis bascule sur le recapitulatif :
        // l'etape n'est validee qu'a ce moment-la.
        ready = true;
      } else {
        wizard.complete('structure');
      }
    } catch (err) {
      phase = 'plan';
      toast.error(errorMessage(err) || "La structure n'a pas pu être posée.");
    } finally {
      onboardingData.busy = false;
    }
  }
</script>

<WizardShell
  layout={phase === 'plan' ? 'split' : 'stage'}
  title={phase === 'plan'
    ? (mapped ? 'On récapitule avant de poser.' : kind === 'existing' ? 'Voilà ce que Kotbo va compléter.' : 'Voilà ce que Kotbo va poser.')
    : undefined}
  lead={phase === 'plan'
    ? (mapped
        ? "Ce que tu as relié n'est ni renommé, ni déplacé, ni repermissionné : Kotbo s'y branche et crée uniquement le reste."
        : kind === 'existing'
          ? "Ce que ton serveur porte déjà n'est ni recréé ni déplacé : Kotbo ne pose que ce qui manque."
          : "Tout est prêt. Un clic, et ces salons existent sur ton serveur.")
    : undefined}
  canGoBack={phase === 'plan'}
  {onEditTracks}
>
  {#if phase === 'building'}
    <div class="max-w-xl mx-auto">
      <h1 class="mb-2 text-center text-2xl font-semibold tracking-tight text-on-surface font-headline">
        Kotbo travaille sur ton serveur.
      </h1>
      <p class="mb-7 text-center text-sm text-on-surface-variant/65 leading-relaxed">
        Ouvre Discord dans un autre onglet : ce que tu vois défiler apparaît en direct.
      </p>

      <BuildSequence
        items={sequence}
        {ready}
        onfinished={() => { phase = 'built'; celebrateFinale(); }}
      />
    </div>

  {:else if phase === 'built' && built}
    <div class="max-w-xl mx-auto rounded-2xl border border-primary/35 bg-primary/[0.04] p-7 text-center">
      <div class="flex justify-center mb-4">
        <KotboMark size={48} halo />
      </div>
      <p class="text-[17px] font-semibold text-on-surface mb-6">
        Ton serveur vient de prendre forme.
      </p>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {#each [
          { n: built.roles, label: 'rôles' },
          { n: built.categories, label: 'catégories' },
          { n: built.channels, label: 'salons' },
          { n: built.modules, label: 'modules' },
        ] as stat (stat.label)}
          <div>
            <p class="text-2xl font-bold tracking-tight text-primary"><CountUp value={stat.n} /></p>
            <p class="text-xs font-medium text-on-surface-variant">{stat.label}</p>
          </div>
        {/each}
      </div>
    </div>

  {:else}
    {#if tally}
      <!-- Sur un serveur habite, ce qui compte n'est pas combien de salons
           existeront a la fin mais combien Kotbo va toucher : c'est la seule
           chose qu'on redoutait en arrivant ici. -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        {#each [
          { n: tally.adopted, label: 'reliés', icon: 'link' },
          { n: tally.created, label: 'à créer', icon: 'plus' },
          { n: tally.skipped, label: 'laissés de côté', icon: 'minus' },
          { n: planned?.modules ?? 0, label: 'modules', icon: 'toggle-right' },
        ] as stat (stat.label)}
          <div class="rounded-xl border border-outline-variant/30 bg-surface-container-low/40 px-4 py-3">
            <Papicon icon={stat.icon} size={14} class="text-primary/70 mb-1.5" />
            <p class="text-2xl font-bold tracking-tight text-primary">{stat.n}</p>
            <p class="text-xs font-medium text-on-surface-variant">{stat.label}</p>
          </div>
        {/each}
      </div>
    {:else if planned}
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        {#each [
          { n: planned.roles, label: 'rôles', icon: 'shield' },
          { n: planned.categories, label: 'catégories', icon: 'folder' },
          { n: planned.channels, label: 'salons', icon: 'message-circle' },
          { n: planned.modules, label: 'modules', icon: 'toggle-right' },
        ] as stat (stat.label)}
          <div class="rounded-xl border border-outline-variant/30 bg-surface-container-low/40 px-4 py-3">
            <Papicon icon={stat.icon} size={14} class="text-primary/70 mb-1.5" />
            <p class="text-2xl font-bold tracking-tight text-primary">{stat.n}</p>
            <p class="text-xs font-medium text-on-surface-variant">{stat.label}</p>
          </div>
        {/each}
      </div>
    {/if}

    {#if template?.applied}
      <!-- Le blocage pur et simple etait un cul-de-sac : une pose interrompue
           en chemin ne pouvait plus se finir. Ce qui existe etant reconnu ligne
           a ligne, rejouer ne cree que ce qui manque encore. -->
      <p class="mt-4 text-body-sm text-on-surface-variant leading-relaxed rounded-xl border border-outline-variant/30 bg-surface-container-low/30 px-4 py-3">
        Une mise en place a déjà eu lieu sur ce serveur. Rien de ce qui existe ne sera
        recréé : seules les lignes que tu viens de marquer « à créer » seront posées.
      </p>
    {:else if blocked}
      <p class="mt-4 text-body-sm leading-relaxed rounded-xl border border-error/30 bg-error/[0.04] px-4 py-3 text-on-surface">
        Kotbo n'a pas la permission « Gérer les salons » : il ne peut rien créer. Donne-la
        lui dans les paramètres du serveur, puis rechargez cette page.
      </p>
    {/if}
  {/if}

  {#snippet preview()}
    <div class="rounded-2xl border border-outline-variant/30 bg-surface-container-lowest/50 overflow-hidden">
      <div class="px-4 py-2.5 border-b border-outline-variant/20 flex items-center gap-2">
        <Papicon icon="list" size={12} class="text-on-surface-variant/40" />
        <span class="text-xs font-semibold text-on-surface">Le détail</span>
      </div>

      <div class="max-h-[420px] overflow-y-auto p-3 space-y-1">
        {#each toCreate as name, index (index)}
          <p class="flex items-center gap-2 text-body-sm text-on-surface-variant/80">
            <Papicon icon="plus" size={11} class="shrink-0 text-success" />
            <span class="truncate">{name}</span>
          </p>
        {/each}

        {#if present.length}
          <!-- Ce qui est deja la, grise. Une reprise qui ne cree que trois
               salons sur quinze donne l'impression de n'avoir rien fait ; avec
               cette liste, on lit que douze etaient deja bons. -->
          <p class="pt-3 pb-1 text-xs font-semibold text-on-surface-variant/35">
            {mapped ? 'Relié à ce qui existe' : 'Déjà en place'}
          </p>
          {#each present as item (item.key)}
            <p class="flex items-center gap-2 text-body-sm {mapped
              ? 'text-on-surface-variant'
              : 'text-on-surface-variant/40 line-through decoration-on-surface-variant/25'}">
              <Papicon icon={mapped ? 'link' : 'check'} size={11} class="shrink-0" />
              <span class="truncate">{item.name}</span>
            </p>
          {/each}
        {/if}
      </div>
    </div>
  {/snippet}

  {#snippet footer()}
    {#if phase === 'building'}
      <span class="text-body-sm font-medium text-on-surface-variant">Montage en cours…</span>
    {:else if phase === 'built'}
      <button
        type="button"
        onclick={() => wizard.complete('structure')}
        class="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-on-primary text-sm font-semibold hover:opacity-90 transition-opacity"
      >
        Continuer
        <Papicon icon="ChevronRight" size={15} />
      </button>
    {:else if template?.applied && (tally?.created ?? 0) === 0}
      <button
        type="button"
        onclick={() => wizard.next()}
        class="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-on-primary text-sm font-semibold hover:opacity-90 transition-opacity"
      >
        Continuer
        <Papicon icon="ChevronRight" size={15} />
      </button>
    {:else}
      <button
        type="button"
        onclick={apply}
        disabled={onboardingData.busy || blocked}
        class="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-on-primary text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {onboardingData.busy
          ? 'En cours…'
          : mapped ? 'Appliquer' : kind === 'existing' ? 'Compléter le serveur' : 'Poser la structure'}
        <Papicon icon="ChevronRight" size={15} />
      </button>
    {/if}
  {/snippet}
</WizardShell>
