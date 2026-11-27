<script lang="ts">
  import { dialogFocus } from '../actions/dialogFocus';
  import { onboardingStore } from '../stores/tutorial.svelte';
  import { fade, scale } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { router } from 'tinro';
  import { brandingStore } from '../stores/branding.svelte';
  import { m } from '../i18n';
  import Papicon from './Papicon.svelte';
  import Button from './ui/Button.svelte';

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

  /** Annoncer le contenu de la configuration : on s'engage plus volontiers quand on voit la fin. */
  const steps = [
    { icon: 'file-text', label: m.d1_tw_item_rules, desc: m.d1_tw_item_rules_desc },
    { icon: 'hash', label: m.d1_tw_item_channels, desc: m.d1_tw_item_channels_desc },
    { icon: 'users', label: m.d1_tw_item_staff, desc: m.d1_tw_item_staff_desc },
  ];
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
      class="tutorial-welcome-panel tafac-panel relative w-full max-w-md max-h-[92dvh] overflow-y-auto p-6"
      use:dialogFocus={{ onEscape: later }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="tutorial-welcome-title"
      tabindex="-1"
      transition:scale={{ duration: 200, easing: cubicOut, start: 0.96 }}
    >
      <div class="flex flex-col items-center text-center">
        <img src={brandingStore.logoUrl || '/favicon.svg'} alt="" class="w-14 h-14 rounded-2xl mb-4 shadow-md" />
        <h1 id="tutorial-welcome-title" class="text-2xl font-bold text-on-surface tracking-tight font-headline">
          {m.d1_tw_welcome_title()}
        </h1>
        <p class="mt-2 text-sm text-on-surface-variant leading-relaxed">{m.d1_tw_welcome_desc()}</p>
      </div>

      <ul class="mt-5 list-rows rounded-2xl bg-surface-container-low border border-outline-variant">
        {#each steps as step (step.icon)}
          <li class="list-row">
            <span class="list-row__text">
              <span class="icon-disc" aria-hidden="true"><Papicon icon={step.icon} size={16} /></span>
              <span class="min-w-0">
                <span class="list-row__label">{step.label()}</span>
                <span class="list-row__desc">{step.desc()}</span>
              </span>
            </span>
          </li>
        {/each}
      </ul>

      <div class="mt-5 flex flex-col gap-1.5">
        <Button variant="primary" fullWidth iconRight="arrow-right" onclick={start}>{m.d1_tw_continue()}</Button>
        <Button variant="ghost" fullWidth onclick={later}>{m.d1_tw_skip()}</Button>
      </div>
    </div>
  </div>
{/if}
