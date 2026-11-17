<script lang="ts">
  import { m } from '../../i18n';
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import Papicon from '../Papicon.svelte';

  /**
   * L'invitation utilisée est repérée par l'écouteur du module Logs : module
   * éteint, rien n'est publié, et l'automatisation resterait muette.
   */
  const moduleOff = $derived(dashboardStore.state.moduleStates?.logs === false);
</script>

{#if moduleOff}
  <p class="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-warning/10 border border-warning/20 text-xs text-on-warning-container">
    <Papicon icon="AlertTriangle" size={14} class="shrink-0 mt-px" />
    <span>
      {m.wf_invite_notice_module_off()}
      <a href="/modules" class="font-semibold underline">{m.wf_fun_notice_modules_link()}</a>
    </span>
  </p>
{:else}
  <p class="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-surface-container-high/50 border border-outline-variant/15 text-xs text-on-surface-variant">
    <Papicon icon="info" size={14} class="shrink-0 mt-px" />
    <span>{m.wf_invite_notice_permission()}</span>
  </p>
{/if}
