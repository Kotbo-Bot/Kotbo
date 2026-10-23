<!--
  Retour sur un parcours laisse en plan : on accueille, et on pose une seule
  question, au moment ou la raison de l'arret est encore fraiche. Les analytics
  disent ou l'on decroche ; une reponse en un clic dit pourquoi.

  N'apparait qu'apres plus de six heures d'absence en cours de parcours (ni sur
  l'ecran d'accueil, ni sur la mise en service). La reponse part dans la
  telemetrie, sans rien qui identifie la personne.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { wizard } from '../../stores/onboardingWizard.svelte';
  import { authStore } from '../../stores/auth.svelte';
  import { trackEvent } from '../../telemetry/telemetry';
  import Button from '../ui/Button.svelte';
  import { m } from '../../i18n';

  const AWAY_MS = 6 * 60 * 60 * 1000;

  const REASONS = [
    { key: 'time', label: () => m.onb_resume_reason_time() },
    { key: 'question', label: () => m.onb_resume_reason_question() },
    { key: 'unsure', label: () => m.onb_resume_reason_unsure() },
  ];

  let visible = $state(false);

  const storageKey = () => `kotbo:onboarding:last-active:${authStore.selectedGuildId ?? ''}`;

  function lastActive(): number | null {
    try {
      const raw = localStorage.getItem(storageKey());
      return raw ? Number(raw) : null;
    } catch {
      return null;
    }
  }

  function touch() {
    try {
      localStorage.setItem(storageKey(), String(Date.now()));
    } catch {
      // Stockage indisponible : la question ne sera simplement jamais posee.
    }
  }

  onMount(() => {
    const last = lastActive();
    visible = last !== null
      && Date.now() - last > AWAY_MS
      && wizard.step !== 'welcome'
      && wizard.step !== 'checkout';
    touch();
  });

  // Chaque ecran franchi compte comme une activite.
  $effect(() => {
    void wizard.step;
    touch();
  });

  function answer(key: string) {
    trackEvent('micro_feedback', `onboarding_resume:${key}`);
    visible = false;
  }
</script>

{#if visible}
  <div
    role="dialog"
    aria-labelledby="onb-resume-title"
    class="fixed bottom-6 left-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 space-y-3 rounded-xl border border-outline-variant bg-surface-container-lowest p-4 shadow-lg animate-in fade-in slide-up duration-200"
  >
    <div>
      <p id="onb-resume-title" class="text-sm font-semibold text-on-surface">{m.onb_resume_title()}</p>
      <p class="mt-1 text-body-sm text-on-surface-variant">{m.onb_resume_question()}</p>
    </div>
    <div class="flex flex-wrap gap-2">
      {#each REASONS as reason (reason.key)}
        <Button size="sm" variant="secondary" onclick={() => answer(reason.key)}>{reason.label()}</Button>
      {/each}
    </div>
    <button type="button" class="text-xs text-on-surface-variant hover:text-on-surface hover:underline" onclick={() => answer('dismissed')}>
      {m.onb_resume_dismiss()}
    </button>
  </div>
{/if}
