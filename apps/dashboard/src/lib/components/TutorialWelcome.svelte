<script lang="ts">
  import { onboardingStore } from '../stores/tutorial.svelte';
  import { fade, scale } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { router } from 'tinro';
  import { brandingStore } from '../stores/branding.svelte';
  import { m } from '../i18n';

  const show = $derived(onboardingStore.showWelcome);

  /**
   * Un seul ecran. L'accueil en comptait deux : trois cartes de
   * fonctionnalites, puis l'annonce de deux guides, dont l'un (les fiches de
   * page) n'existe plus et l'autre doublait « Bien demarrer ». Les deux
   * boutons du second ecran faisaient d'ailleurs la meme chose. Il reste
   * une phrase et un vrai choix : commencer la configuration, ou explorer.
   */
  function start() {
    onboardingStore.dismissWelcome();
    router.goto('/setup');
  }

  function later() {
    onboardingStore.dismissWelcome();
  }
</script>

{#if show}
  <div
    class="fixed inset-0 z-[10000] flex items-end sm:items-center justify-center p-4"
    transition:fade={{ duration: 150 }}
  >
    <div
      class="absolute inset-0 bg-black/50"
      onclick={later}
      role="presentation"
    ></div>

    <div
      class="tutorial-welcome-panel relative w-full max-w-md max-h-[92dvh] overflow-y-auto bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-xl p-6 sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tutorial-welcome-title"
      transition:scale={{ duration: 200, easing: cubicOut, start: 0.96 }}
    >
      <img src={brandingStore.logoUrl || '/favicon.svg'} alt="" class="w-10 h-10 rounded-xl mb-5" />

      <h1 id="tutorial-welcome-title" class="text-2xl font-semibold text-on-surface tracking-tight font-headline">
        {m.d1_tw_welcome_title()}
      </h1>
      <p class="mt-2 text-sm text-on-surface-variant leading-relaxed">
        {m.d1_tw_welcome_desc()}
      </p>

      <div class="mt-8 flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
        <button
          type="button"
          onclick={later}
          class="min-h-11 px-4 rounded-xl text-sm font-medium text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-colors"
        >
          {m.d1_tw_skip()}
        </button>
        <button
          type="button"
          onclick={start}
          class="min-h-11 px-5 rounded-xl bg-primary text-on-primary text-sm font-semibold hover:opacity-90 transition-opacity"
        >
          {m.d1_tw_continue()}
        </button>
      </div>
    </div>
  </div>
{/if}
