<script lang="ts">
  /**
   * « Voila votre serveur. » : le bilan, en tete de la mise en service.
   *
   * Le dernier ecran avant le paiement etait une liste de reglages effectues,
   * posee au-dessus d'une offre. C'est l'ordre inverse de ce qu'il faudrait :
   * on demande de payer au moment ou l'on vient de lire un recapitulatif
   * administratif, pas au moment ou l'on mesure ce qu'on a construit.
   *
   * Cet ecran ne demande rien. Il se monte piece par piece - chiffres qui
   * montent, lignes qui apparaissent - et il ne dit qu'une chose : tout ce que
   * vous lisez tourne deja. C'est le seul moment du parcours ou l'on s'attarde
   * volontairement, et c'est pour ca qu'il est plein ecran, sans question ni
   * colonne d'apercu.
   *
   * Il porte aussi la seconde chance : les pistes decochees y reapparaissent en
   * grise, avec ce qu'elles auraient apporte et un bouton pour les ajouter.
   * Quelqu'un qui a decoche « L'economie » a l'ecran 3 ne savait pas encore ce
   * que Kotbo faisait ; ici, il le sait.
   */
  import { onMount } from 'svelte';
  import { m } from '../../i18n';
  import { wizard } from '../../stores/onboardingWizard.svelte';
  import { onboardingData } from '../../stores/onboardingData.svelte';
  import {
    TRACKS,
    celebrateFinale,
    dormantModules,
    type TrackKey,
  } from '../../onboarding';
  import CountUp from './CountUp.svelte';
  import Papicon from '../Papicon.svelte';

  const built = $derived(onboardingData.built);

  /**
   * Ce qui reste eteint parce qu'on a ecarte le salon qui le porte.
   *
   * Ecarter une ligne au mappage est un choix legitime, et il a ete dit sur
   * l'ecran ou on l'a fait. Le repeter ici est la seule facon qu'il ne se perde
   * pas : entre l'ecran « L'equipe » et la fin du parcours, on a repondu a
   * quinze autres questions. Ce sont les seules lignes du recapitulatif qui
   * disent ce qui n'a pas ete fait, et c'est ce qui les rend utiles.
   */
  const dormant = $derived(
    onboardingData.template
      ? dormantModules(onboardingData.template.plan, wizard.mapping)
      : []
  );

  /**
   * Ce qui a ete regle, relu une derniere fois.
   *
   * Seules les etapes reellement validees y figurent : annoncer un reglement a
   * quelqu'un qui a saute l'ecran ferait mentir la seule page du parcours dont
   * on attend qu'elle dise vrai.
   */
  const lines = $derived([
    ...(built
      ? [{ icon: 'layout-grid', label: m.obx_rc_structure(), value: m.obx_rc_structure_v() }]
      : []),
    ...(wizard.isDone('moderation')
      ? [{ icon: 'shield', label: m.obx_rc_moderation(), value: m.obx_rc_moderation_v() }]
      : []),
    ...(wizard.isDone('logs')
      ? [{ icon: 'scroll', label: m.onb_step_logs(), value: m.obx_rc_logs_v() }]
      : []),
    ...(wizard.isDone('greeting')
      ? [{ icon: 'door-open', label: m.obx_rc_welcome(), value: m.obx_rc_welcome_v() }]
      : []),
    ...(wizard.isDone('rules')
      ? [{ icon: 'book-open', label: m.obx_rc_rules(), value: m.obx_rc_rules_v() }]
      : []),
    ...(wizard.isDone('tickets')
      ? [{ icon: 'inbox', label: m.obx_rc_support(), value: m.obx_rc_support_v() }]
      : []),
    ...(wizard.isDone('levels')
      ? [{ icon: 'crown', label: m.obx_rc_progress(), value: m.obx_rc_progress_v() }]
      : []),
    ...(wizard.isDone('economy')
      ? [{ icon: 'coins', label: m.onb_step_economy(), value: wizard.currencyName ?? m.obx_rc_currency_v() }]
      : []),
    ...(wizard.isDone('animation')
      ? [{ icon: 'target', label: m.onb_step_animation(), value: m.obx_rc_quests_v({ count: wizard.questKeys?.length ?? 0 }) }]
      : []),
    ...(wizard.isDone('staff')
      ? [{ icon: 'users', label: m.onb_step_staff(), value: m.obx_rc_staff_v({ count: wizard.staffRoleIds?.length ?? 0 }) }]
      : []),
    ...(wizard.isDone('mcp')
      ? [{ icon: 'command', label: m.onb_step_mcp(), value: m.obx_rc_mcp_v() }]
      : []),
  ]);

  /** Les pistes laissees de cote, avec ce qu'elles auraient apporte. */
  const missing = $derived(
    TRACKS.filter((track) => !wizard.tracks.includes(track.key))
  );

  /**
   * Un compte de reglages, pas un compte d'ecrans.
   *
   * Chaque element pose - un role, un salon, un module, un article de reglement,
   * un motif de ticket - vaut un reglage. C'est approximatif et c'est honnete :
   * le chiffre mesure ce qui a change sur le serveur, pas le nombre de clics.
   */
  const settingsCount = $derived(
    (built ? built.roles + built.categories + built.channels + built.modules : 0)
    + lines.length
    + (wizard.shopKeys?.length ?? 0)
    + (wizard.questKeys?.length ?? 0)
  );

  // Les chiffres montent d'eux-memes (`CountUp`) et les lignes se posent l'une
  // apres l'autre par leur delai d'animation : il ne reste ici qu'a lancer la
  // celebration, une fois, a l'arrivee sur l'ecran.
  onMount(celebrateFinale);

  function addTrack(key: TrackKey) {
    wizard.setTracks([...wizard.tracks, key], { gotoFirstOf: key });
  }
</script>

<div class="mb-8">
  {#if built}
    <!-- Les chiffres, en grand : c'est ce qu'on vient de voir se poser. -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {#each [
        { value: built.roles, label: m.onb_recap_roles(), icon: 'shield' },
        { value: built.categories, label: m.onb_recap_categories(), icon: 'folder' },
        { value: built.channels, label: m.onb_recap_channels(), icon: 'message-circle' },
        { value: built.modules, label: m.onb_recap_modules(), icon: 'toggle-right' },
      ] as tile (tile.label)}
        <div class="section-card p-4 text-center">
          <span class="inline-flex w-8 h-8 rounded-full bg-primary/10 text-primary items-center justify-center mb-2">
            <Papicon icon={tile.icon} size={15} />
          </span>
          <p class="text-[26px] font-semibold leading-none text-on-surface">
            <CountUp value={tile.value} />
          </p>
          <p class="mt-1.5 text-xs text-on-surface-variant">{tile.label}</p>
        </div>
      {/each}
    </div>
  {/if}

  {#if lines.length}
    <div class="section-card-flush mt-4 divide-y divide-outline-variant">
      {#each lines as line, index (line.label)}
        <div
          class="row flex items-center gap-3 px-4 py-2.5"
          style="animation-delay: {700 + index * 70}ms"
        >
          <span class="w-6 h-6 shrink-0 rounded-full bg-primary/10 text-primary flex items-center justify-center">
            <Papicon icon={line.icon} size={12} />
          </span>
          <span class="text-body-sm font-medium text-on-surface flex-1 min-w-0 truncate">{line.label}</span>
          <span class="text-xs text-on-surface-variant shrink-0">{line.value}</span>
          <Papicon icon="check" size={13} class="shrink-0 text-success" />
        </div>
      {/each}
    </div>
  {/if}

  <p class="mt-5 text-center text-body-sm text-on-surface-variant/55">
    {m.onb_recap_settings({ count: settingsCount, minutes: wizard.elapsedMinutes })}
  </p>

  {#if dormant.length}
    <section class="mt-10">
      <h2 class="text-body-sm font-semibold text-on-surface">{m.obx_rc_dormant()}</h2>
      <p class="mt-1 text-xs text-on-surface-variant">
        {m.obx_rc_dormant_desc()}
      </p>

      <div class="mt-3 grid gap-2.5 sm:grid-cols-2">
        {#each dormant as entry (entry.key)}
          <div class="flex items-start gap-3 rounded-2xl border border-outline-variant/25 bg-surface-container-lowest/25 p-3.5">
            <span class="w-8 h-8 shrink-0 rounded-lg bg-surface-container text-on-surface-variant/40 flex items-center justify-center">
              <Papicon icon="power" size={15} />
            </span>
            <div class="min-w-0 flex-1">
              <p class="text-body-sm font-semibold text-on-surface-variant/75">{entry.name}</p>
              <p class="mt-0.5 text-xs text-on-surface-variant leading-relaxed">
                {m.obx_rc_because({ name: entry.because })}
              </p>
            </div>
          </div>
        {/each}
      </div>
    </section>
  {/if}

  {#if missing.length}
    <!-- La seconde chance, repliee : depliee, elle repoussait la mise en
         service huit cartes plus bas. -->
    <details class="section-card-flush mt-6">
      <summary class="list-row list-row--pressable">
        <span class="list-row__text">
          <span class="icon-disc" aria-hidden="true"><Papicon icon="plus" size={15} /></span>
          <span class="min-w-0">
            <span class="list-row__label">{m.onb_recap_missing_title()} ({missing.length})</span>
            <span class="list-row__desc">{m.onb_recap_missing_hint()}</span>
          </span>
        </span>
        <Papicon icon="chevron-down" size={15} class="shrink-0 text-on-surface-variant" />
      </summary>

      <div class="list-rows border-t border-outline-variant">
        {#each missing as track (track.key)}
          <div class="list-row">
            <span class="list-row__text">
              <span class="icon-disc" aria-hidden="true"><Papicon icon={track.icon} size={15} /></span>
              <span class="min-w-0">
                <span class="list-row__label">{track.label()}</span>
                <span class="list-row__desc">{track.outcome()}</span>
              </span>
            </span>
            <button
              type="button"
              onclick={() => addTrack(track.key)}
              class="btn btn-tonal btn-sm"
              aria-label="{m.onb_recap_add()} : {track.label()}"
            >
              {m.onb_recap_add()}
            </button>
          </div>
        {/each}
      </div>
    </details>
  {/if}
</div>

<style>
  .row {
    animation: appear 320ms ease-out both;
  }

  @keyframes appear {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .row { animation: none; }
  }
</style>
