<script lang="ts">
  import { onMount } from 'svelte';
  import { m } from '../../i18n';
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import { dashboardRequest } from '../../api/client';
  import Papicon from '../Papicon.svelte';

  /**
   * Le déclencheur « victoire à un mini-jeu » ne part que si le module Salons
   * fun tourne et qu'au moins un jeu gagnable a son salon. Sans ce rappel, une
   * automatisation valide et activée resterait muette sans explication.
   */

  const moduleOff = $derived(dashboardStore.state.moduleStates?.fun === false);

  /** `null` tant que la config n'est pas lue, ou quand elle n'est pas lisible. */
  let channels = $state<{ guessNumber: boolean; emojiRiddle: boolean } | null>(null);

  onMount(async () => {
    try {
      // Silencieux : un membre sans accès à la page Salons fun peut éditer les
      // déclencheurs, et un refus ne doit pas afficher d'erreur ici.
      const res = await dashboardRequest('/fun', { method: 'GET', silent: true });
      if (res?.config) {
        channels = {
          guessNumber: !!res.config.funGuessNumberChannelId,
          emojiRiddle: !!res.config.funEmojiRiddleChannelId,
        };
      }
    } catch {
      channels = null;
    }
  });

  const noChannel = $derived(channels !== null && !channels.guessNumber && !channels.emojiRiddle);
  const partial = $derived(channels !== null && channels.guessNumber !== channels.emojiRiddle);
</script>

{#if moduleOff}
  <p class="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-warning/10 border border-warning/20 text-xs text-on-warning-container">
    <Papicon icon="AlertTriangle" size={14} class="shrink-0 mt-px" />
    <span>
      {m.wf_fun_notice_module_off()}
      <a href="/modules" class="font-semibold underline">{m.wf_fun_notice_modules_link()}</a>
    </span>
  </p>
{:else if noChannel}
  <p class="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-warning/10 border border-warning/20 text-xs text-on-warning-container">
    <Papicon icon="AlertTriangle" size={14} class="shrink-0 mt-px" />
    <span>
      {m.wf_fun_notice_no_channel()}
      <a href="/fun" class="font-semibold underline">{m.wf_fun_notice_fun_link()}</a>
    </span>
  </p>
{:else if partial && channels}
  <p class="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-surface-container-high/50 border border-outline-variant/15 text-xs text-on-surface-variant">
    <Papicon icon="info" size={14} class="shrink-0 mt-px" />
    <span>
      {channels.guessNumber ? m.wf_fun_notice_only_guess() : m.wf_fun_notice_only_riddle()}
      <a href="/fun" class="font-semibold underline">{m.wf_fun_notice_fun_link()}</a>
    </span>
  </p>
{/if}
