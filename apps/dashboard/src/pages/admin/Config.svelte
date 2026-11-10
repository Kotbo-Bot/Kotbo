<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from '../../lib/stores/toast.svelte';
  import { fetchMaintenanceConfig, updateMaintenanceConfig } from '../../lib/api';
  import Papicon from '../../lib/components/Papicon.svelte';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import BotErrorLog from '../../lib/components/admin/BotErrorLog.svelte';
  import { m } from '../../lib/i18n';

  import { errorMessage } from '@kotbo/shared';

  let maintenanceMode = $state(false);
  let loading = $state(true);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      maintenanceMode = (await fetchMaintenanceConfig()).maintenance;
    } catch (err) {
      error = errorMessage(err);
    } finally {
      loading = false;
    }
  });

  async function handleToggleMaintenance() {
    try {
      await updateMaintenanceConfig(!maintenanceMode);
      maintenanceMode = !maintenanceMode;
    } catch (err) { toast.error(errorMessage(err)); }
  }
</script>

<AdminShell title="Configuration avancée" description="Réglages globaux de l’instance Kotbo.">
  <!-- Le journal d'erreurs se charge seul : une maintenance illisible ne doit
       pas masquer les erreurs, c'est justement là qu'on en a besoin. -->
  <div class="grid grid-cols-1 lg:grid-cols-3 gap-8 pb-12 animate-in fade-in slide-in-from-bottom-3 duration-600">
    <div>
      {#if loading}
        <div class="premium-card rounded-[2.25rem] p-8 space-y-6 h-full">
          <div class="animate-pulse space-y-4">
            <div class="h-20 bg-surface/40 rounded-lg"></div>
            <div class="h-20 bg-surface/40 rounded-lg"></div>
            <div class="h-12 bg-surface/40 rounded-xl"></div>
          </div>
        </div>
      {:else if error}
        <div class="bg-error/10 border border-error/20 p-8 rounded-[2.25rem] text-center">
          <Papicon icon="AlertTriangle" size={48} class="text-error mx-auto mb-4" />
          <h2 class="text-xl font-bold text-on-error-container">{m.d7_loading_error()}</h2>
          <p class="text-on-error-container/70 mt-2">{error}</p>
        </div>
      {:else}
        <!-- Kill Switch -->
        <div class="space-y-6">
          <h2 class="text-xl font-semibold font-headline flex items-center gap-3 px-2">
            <Papicon icon="Power" size={24} class="text-amber-500" />
            {m.d7_kill_switch()}
          </h2>

          <div class="premium-card rounded-[2.25rem] p-8 flex flex-col justify-center items-center text-center space-y-6 h-full {maintenanceMode ? 'border-amber-500/50 bg-amber-500/5' : ''}">
            <div class="w-24 h-24 rounded-full flex items-center justify-center {maintenanceMode ? 'bg-amber-500/20 text-amber-500' : 'bg-surface-variant text-on-surface-variant'} shadow-inner">
              <Papicon icon="AlertOctagon" size={48} />
            </div>
            <div>
              <h3 class="text-xl font-bold text-on-surface mb-2">{m.d7_maintenance_mode()}</h3>
              <p class="text-sm text-on-surface-variant">
                {maintenanceMode
                  ? m.d7_maintenance_on_desc()
                  : m.d7_maintenance_off_desc()}
              </p>
            </div>
            <button 
              onclick={handleToggleMaintenance}
              class="px-8 py-4 rounded-xl font-semibold text-lg transition-all {maintenanceMode ? 'bg-success text-on-success shadow-success/20' : 'bg-amber-500 text-white shadow-amber-500/20'} shadow-lg"
            >
              {maintenanceMode ? m.d7_maintenance_deactivate() : m.d7_maintenance_activate()}
            </button>
          </div>
        </div>
      {/if}
    </div>

    <div class="lg:col-span-2">
      <BotErrorLog />
    </div>
  </div>
</AdminShell>
