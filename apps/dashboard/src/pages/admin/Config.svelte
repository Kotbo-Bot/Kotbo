<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from '../../lib/stores/toast.svelte';
  import { confirmDialog } from '../../lib/stores/confirmDialog.svelte';
  import { fetchMaintenanceConfig, updateMaintenanceConfig } from '../../lib/api';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import AdminCard from '../../lib/components/admin/AdminCard.svelte';
  import AdminBadge from '../../lib/components/admin/AdminBadge.svelte';
  import BotErrorLog from '../../lib/components/admin/BotErrorLog.svelte';
  import { Button, Callout } from '../../lib/components/ui';
  import { m } from '../../lib/i18n';

  import { errorMessage } from '@kotbo/shared';

  let maintenanceMode = $state(false);
  let loading = $state(true);
  let saving = $state(false);
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
    // Couper le bot pour tous les serveurs ne doit pas partir d'un clic égaré ;
    // le rallumer, si.
    if (!maintenanceMode && !(await confirmDialog.danger(m.d7_maintenance_activate(), m.d7_maintenance_off_desc(), 'Activer'))) return;
    saving = true;
    try {
      await updateMaintenanceConfig(!maintenanceMode);
      maintenanceMode = !maintenanceMode;
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      saving = false;
    }
  }
</script>

<AdminShell title="Configuration avancée" description="Réglages globaux de l’instance Kotbo.">
  <!-- Le journal d'erreurs se charge seul : une maintenance illisible ne doit
       pas masquer les erreurs, c'est justement là qu'on en a besoin. -->
  {#if error}
    <Callout variant="danger" title={m.d7_loading_error()}>{error}</Callout>
  {/if}

  <AdminCard
    title={m.d7_maintenance_mode()}
    description={maintenanceMode ? m.d7_maintenance_on_desc() : m.d7_maintenance_off_desc()}
    icon="Power"
    tone={maintenanceMode ? 'warning' : 'neutral'}
    padded={false}
  >
    {#snippet actions()}
      {#if !loading && !error}
        <AdminBadge label={maintenanceMode ? 'Active' : 'Inactive'} tone={maintenanceMode ? 'warning' : 'neutral'} dot pulse={maintenanceMode} />
        <Button variant={maintenanceMode ? 'primary' : 'danger'} loading={saving} onclick={handleToggleMaintenance}>
          {maintenanceMode ? m.d7_maintenance_deactivate() : m.d7_maintenance_activate()}
        </Button>
      {/if}
    {/snippet}
  </AdminCard>

  <BotErrorLog />
</AdminShell>
