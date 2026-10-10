<script lang="ts">
  import { dashboardStore } from '../stores/dashboard.svelte';
  import { updateRoleAccess } from '../api';
  import { createAsyncActionState } from '../asyncAction.svelte';
  import Papicon from './Papicon.svelte';
  import SearchableSelect from './SearchableSelect.svelte';
  import ActionButton from './ActionButton.svelte';
  import { m } from '../i18n';

  const { featureKey = '', roleAccess = [], title = m.rp_title(), description = m.rp_desc() } = $props();

  const saveAction = createAsyncActionState();
  const availableRoles = $derived(dashboardStore.state.discordRoles || []);

  let localRoleAccess = $state<any[]>([]);
  let initialized = $state(false);
  let open = $state(false);
  const configuredCount = $derived(localRoleAccess.filter(r => r.roleId).length);

  $effect(() => {
    if (roleAccess && roleAccess.length > 0 && !initialized) {
      localRoleAccess = JSON.parse(JSON.stringify(roleAccess));
      initialized = true;
    } else if (featureKey && !initialized) {
      // Try to find it in the store if not passed as prop
      const feature = dashboardStore.state.modules?.find((m: any) => m.id === featureKey);
      if (feature?.roleAccessByRole) {
         localRoleAccess = JSON.parse(JSON.stringify(feature.roleAccessByRole));
         initialized = true;
      }
    }
  });

  function addRole() {
    localRoleAccess = [...localRoleAccess, { roleId: '', canView: true, canModerate: false, canConfigure: false, canDelete: false }];
  }

  function removeRole(index: number) {
    localRoleAccess = localRoleAccess.filter((_, i) => i !== index);
  }

  async function handleSave() {
    // Filter out invalid roles
    const payload = localRoleAccess.filter(r => r.roleId);
    
    await saveAction.run(async () => {
      const ok = await updateRoleAccess(featureKey, payload);
      if (!ok) throw new Error('Erreur API');
      await dashboardStore.refresh();
      return true;
    }, { successMessage: m.rp_updated_toast() });
  }

  const permissions = $derived(
    featureKey === 'double_accounts'
      ? [
          { key: 'canView', label: m.rp_perm_view(), icon: 'eye' },
          { key: 'canModerate', label: m.rp_perm_validate(), icon: 'check-circle' },
          { key: 'canConfigure', label: m.rp_perm_ds(), icon: 'shield' },
          { key: 'canDelete', label: m.rp_perm_sanction(), icon: 'alert-triangle' }
        ]
      : [
          { key: 'canView', label: m.rp_perm_view(), icon: 'eye' },
          { key: 'canModerate', label: m.rp_perm_moderate(), icon: 'shield' },
          { key: 'canConfigure', label: m.rp_perm_configure(), icon: 'settings' },
          { key: 'canDelete', label: m.rp_perm_delete(), icon: 'trash-2' }
        ]
  );
</script>

<div class="space-y-6">
  <button
    type="button"
    onclick={() => open = !open}
    aria-expanded={open}
    class="w-full flex items-center justify-between gap-4 text-left {open ? 'border-b border-outline-variant/10 pb-4' : ''}"
  >
    <div>
      <h3 class="text-sm font-semibold text-on-surface">{title}</h3>
      <p class="text-xs text-on-surface-variant/70 mt-1">{description}</p>
    </div>
    <div class="flex items-center gap-3 shrink-0">
      {#if configuredCount > 0}
        <span class="px-2 py-0.5 rounded-md bg-primary/10 text-primary text-xs font-semibold">
          {m.rp_configured_count({ count: configuredCount })}
        </span>
      {/if}
      <Papicon icon="chevron-down" size={16} class="text-on-surface-variant/60 transition-transform {open ? 'rotate-180' : ''}" />
    </div>
  </button>

  {#if open}
  {#if localRoleAccess.length === 0}
    <div class="py-10 text-center bg-surface-container-low/20 rounded-xl border border-dashed border-outline-variant/20">
      <Papicon icon="lock" size={40} class="text-on-surface-variant/20 mb-3 mx-auto" />
      <p class="text-xs font-bold text-on-surface-variant/60">{m.rp_empty_state()}</p>
    </div>
  {:else}
    <div class="space-y-3">
      {#each localRoleAccess as entry, i}
        <div class="flex flex-col md:flex-row items-start md:items-center gap-4 p-5 bg-surface-container-low/40 rounded-xl border border-outline-variant/10 group animate-in fade-in slide-in-from-right-4 duration-300">
          <div class="w-full md:w-64">
            <SearchableSelect bind:value={entry.roleId} options={availableRoles.map(role => ({ id: role.id, name: `@${role.name}` }))} placeholder={m.rp_select_role_placeholder()} className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-4 py-2.5 text-sm" />
          </div>

          <div class="flex flex-wrap items-center gap-3 flex-1">
            {#each permissions as perm}
              <button
                onclick={() => entry[perm.key] = !entry[perm.key]}
                class="flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-all {entry[perm.key] ? 'bg-primary/10 border-primary/20 text-primary shadow-sm' : 'bg-transparent border-outline-variant/10 text-on-surface-variant/40 hover:border-outline-variant/30'}"
              >
                <Papicon icon={perm.icon} size={14} />
                <span class="text-xs font-semibold">{perm.label}</span>
              </button>
            {/each}
          </div>

          <button 
            onclick={() => removeRole(i)}
            class="p-2.5 text-on-surface-variant/40 hover:text-error hover:bg-error/10 rounded-xl transition-all"
            title={m.rp_delete_rule_title()}
          >
            <Papicon icon="x" size={18} />
          </button>
        </div>
      {/each}
    </div>
  {/if}

  <div class="flex items-center justify-between gap-3 pt-4">
    <button
      onclick={addRole}
      class="flex items-center gap-2 px-4 py-2 bg-primary/10 text-primary rounded-xl text-body-sm font-medium hover:bg-primary/20 transition-all"
    >
      <Papicon icon="plus" size={14} />
      {m.rp_add_role()}
    </button>
    <ActionButton
      onClick={handleSave} 
      variant="primary" 
      label={saveAction.state.loading ? m.rp_saving_permissions() : m.rp_save_permissions()}
      disabled={localRoleAccess.length > 0 && localRoleAccess.some(r => !r.roleId)}
    />
  </div>

  {#if saveAction.state.message}
    <p class="text-xs font-bold text-success text-right">{saveAction.state.message}</p>
  {/if}
  {/if}
</div>
