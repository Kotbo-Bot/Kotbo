<script lang="ts">
  /**
   * Écran affiché à la place d'une page dont le module est éteint.
   *
   * Sans lui, l'URL restait atteignable : la page se montait, appelait son API,
   * recevait un 403 et affichait une erreur générique - l'administrateur n'avait
   * aucun moyen de comprendre qu'il s'agissait d'un module coupé, ni où le
   * rallumer.
   */
  import { getModuleDefinition } from '@kotbo/contracts';
  import { dashboardStore } from '../stores/dashboard.svelte';
  import { updateModuleStatus } from '../api';
  import { toast } from '../stores/toast.svelte';
  import Papicon from './Papicon.svelte';

  const { moduleKey = '' }: { moduleKey?: string } = $props();

  const definition = $derived(getModuleDefinition(moduleKey));

  const canEnable = $derived(
    !!dashboardStore.state.access?.canManageSettings
      || !!dashboardStore.state.featureAccess?.modules?.canConfigure,
  );

  let enabling = $state(false);

  async function enable() {
    if (!canEnable || enabling) return;
    enabling = true;
    const ok = await updateModuleStatus(moduleKey, 'active');
    enabling = false;
    if (!ok) {
      toast.error('Activation impossible.');
      return;
    }
    toast.success(`« ${definition?.name ?? moduleKey} » activé.`);
    await dashboardStore.refresh();
  }
</script>

<div class="max-w-lg mx-auto px-4 py-24 text-center space-y-5">
  <div class="w-14 h-14 mx-auto rounded-2xl bg-surface-container text-on-surface-variant/60 flex items-center justify-center">
    <Papicon icon={definition?.icon || 'Lock'} size={26} />
  </div>

  <div class="space-y-2">
    <h1 class="text-lg font-semibold text-on-surface">
      {definition?.name ?? 'Ce module'} est désactivé
    </h1>
    <p class="text-body-sm text-on-surface-variant leading-relaxed">
      {definition?.description ?? ''}
      Tant qu'il est éteint, ses commandes Discord, ses automatismes et cette page
      restent indisponibles sur ce serveur.
    </p>
  </div>

  <div class="flex items-center justify-center gap-2">
    <a
      href="/modules"
      class="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg border border-outline-variant/40 text-sm font-medium text-on-surface hover:bg-surface-container transition-colors"
    >
      Voir les modules
    </a>
    {#if canEnable}
      <button
        type="button"
        onclick={enable}
        disabled={enabling}
        class="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-primary text-on-primary text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
      >
        {enabling ? 'Activation…' : 'Activer ce module'}
      </button>
    {/if}
  </div>
</div>
