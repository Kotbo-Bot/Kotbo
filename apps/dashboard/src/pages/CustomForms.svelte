<script lang="ts">
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import { authStore } from '../lib/stores/auth.svelte';
  import { fetchStaffHierarchies, dashboardFetch } from '../lib/api';
  import Papicon from '../lib/components/Papicon.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import FormInput from '../lib/components/FormInput.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { m } from '../lib/i18n';

  import { errorMessage } from '@kotbo/shared';
  let forms = $state<any[]>([]);
  let hierarchies = $state<any[]>([]);
  let loading = $state(true);
  let error = $state('');

  // Creation modal state
  let showCreateModal = $state(false);
  let newFormName = $state('');
  let newFormDescription = $state('');

  const createAction = createAsyncActionState();
  const deleteAction = createAsyncActionState();

  async function fetchForms() {
    if (!authStore.selectedGuildId) return;
    loading = true;
    try {
      const res = await dashboardFetch(`/custom-forms`);
      if (!res.ok) throw new Error('Impossible de charger les formulaires');
      const data = await res.json();
      forms = data.forms || [];
    } catch (err) {
      error = errorMessage(err);
    } finally {
      loading = false;
    }
  }

  async function createForm() {
    if (!newFormName.trim()) return;

    await createAction.run(async () => {
      const res = await dashboardFetch(`/custom-forms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: newFormName,
          description: newFormDescription || undefined,
          structure: {
            title: newFormName,
            description: newFormDescription,
            fields: [
              {
                id: 'field_name',
                type: 'short_text',
                label: 'Nom / Pseudo',
                required: true
              }
            ]
          }
        })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Erreur lors de la création du formulaire');
      }

      const createdData = await res.json();
      await fetchForms();
      showCreateModal = false;
      newFormName = '';
      newFormDescription = '';
      
      // Redirect to builder
      router.goto(`/forms/builder/${createdData.form.id}`);
      return true;
    }, { successMessage: m.cf_created_success() });
  }

  async function deleteForm(formId: string) {
    if (!(await confirmDialog.danger(m.cf_delete_confirm_title(), m.cf_delete_confirm_desc()))) return;

    await deleteAction.run(async () => {
      const res = await dashboardFetch(`/custom-forms/${formId}`, {
        method: 'DELETE'
        });
      if (!res.ok) throw new Error('Erreur lors de la suppression');
      await fetchForms();
      return true;
    }, { successMessage: m.cf_delete_success() });
  }

  async function fetchHierarchies() {
    try {
      const data = await fetchStaffHierarchies();
      hierarchies = data?.hierarchies || data || [];
    } catch {
      hierarchies = [];
    }
  }

  async function updateFormHierarchy(formId: string, hierarchyId: string) {
    try {
      const res = await dashboardFetch(`/custom-forms/${formId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ hierarchyId: hierarchyId || null })
      });
      if (res.ok) {
        toast.success(hierarchyId ? m.cf_hierarchy_linked() : m.cf_hierarchy_unlinked());
        await fetchForms();
      } else {
        toast.error(m.cf_config_error());
      }
    } catch {
      toast.error('Erreur réseau');
    }
  }

  async function toggleRecruitment(formId: string, value: boolean) {
    try {
      const res = await dashboardFetch(`/custom-forms/${formId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ isRecruitment: value })
      });
      if (res.ok) {
        toast.success(value ? m.cf_recruitment_linked() : m.cf_recruitment_unlinked());
        await fetchForms();
      } else {
        toast.error(m.cf_config_error());
      }
    } catch {
      toast.error('Erreur réseau');
    }
  }

  async function toggleRequiresAuth(formId: string, value: boolean) {
    try {
      const res = await dashboardFetch(`/custom-forms/${formId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ requiresDiscordAuth: value })
      });
      if (res.ok) {
        toast.success(value ? m.cf_auth_required() : m.cf_auth_not_required());
        await fetchForms();
      } else {
        toast.error(m.cf_config_error());
      }
    } catch {
      toast.error('Erreur réseau');
    }
  }

  async function toggleActive(formId: string, value: boolean) {
    try {
      const res = await dashboardFetch(`/custom-forms/${formId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ isActive: value })
      });
      if (res.ok) {
        toast.success(value ? m.cf_activated() : m.cf_deactivated());
        await fetchForms();
      } else {
        toast.error(m.cf_config_error());
      }
    } catch {
      toast.error('Erreur réseau');
    }
  }

  onMount(() => {
    fetchForms();
    fetchHierarchies();
  });
</script>

<ModulePage
  title={m.cf_page_title()}
  description={m.cf_page_desc()}
  icon="description"
  featureKey="custom_forms"
>
  {#snippet actions()}
    <div class="flex items-center gap-3">
      <RefreshButton onClick={fetchForms} loading={loading} label={m.common_refresh()} />
      <button 
        onclick={() => showCreateModal = true}
        class="px-4 py-2 bg-primary text-white rounded-xl font-medium text-body-sm transition-transform flex items-center gap-2"
      >
        <Papicon icon="add" size={16} />
        {m.cf_new_form()}
      </button>
    </div>
  {/snippet}

  <div class="space-y-8">
    {#if loading && forms.length === 0}
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {#each Array(3) as _}
          <div class="bg-surface-container-low/40 border border-outline-variant/10 rounded-xl p-6 animate-pulse">
            <div class="h-6 bg-surface-container rounded-lg w-3/4 mb-4"></div>
            <div class="h-4 bg-surface-container rounded-lg w-1/2 mb-2"></div>
            <div class="h-20 bg-surface-container rounded-xl mt-4"></div>
          </div>
        {/each}
      </div>
    {:else if error}
      <div class="rounded-xl border border-error/20 bg-error/10 px-8 py-10 text-center">
        <Papicon icon="error" size={48} class="text-error mb-4" />
        <p class="text-xl font-bold text-error">{error}</p>
      </div>
    {:else if forms.length === 0}
      <div class="flex flex-col items-center justify-center py-32 text-on-surface-variant/30 border-2 border-dashed border-outline-variant/10 rounded-[4rem] bg-surface-container-low/20">
        <div class="w-24 h-24 rounded-xl bg-surface-container flex items-center justify-center mb-6 shadow-inner text-purple-400">
          <Papicon icon="description" size={48} />
        </div>
        <h3 class="text-2xl font-semibold tracking-tight text-on-surface/50 font-sans">{m.cf_no_form_title()}</h3>
        <p class="mt-3 text-sm max-w-sm text-center opacity-60 font-sans">
          {m.cf_no_form_desc()}
        </p>
      </div>
    {:else}
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {#each forms as form (form.id)}
          <div class="bg-surface-container-low/40 border border-outline-variant/10 rounded-xl p-6 hover:bg-surface-container-low transition-all group relative overflow-hidden flex flex-col justify-between">
            <div>
              <div class="flex items-start justify-between mb-4">
                <div class="flex-1 min-w-0">
                  <h3 class="text-lg font-semibold text-on-surface truncate font-sans">{form.name}</h3>
                  {#if form.description}
                    <p class="text-sm text-on-surface-variant/75 mt-1 line-clamp-2 font-sans">{form.description}</p>
                  {/if}
                </div>
              </div>

              <div class="space-y-4 mb-6 pt-2 border-t border-outline-variant/5">
                <div class="flex items-center justify-between text-xs text-on-surface-variant/60 font-sans">
                  <span class="flex items-center gap-2">
                    <Papicon icon="link" size={14} />
                    {m.cf_public_link()}
                  </span>
                  <div class="flex items-center gap-1 min-w-0 max-w-[150px]">
                    <span class="truncate text-2xs font-mono">{window.location.origin}/form/{form.id}</span>
                    <button
                      onclick={() => {
                        navigator.clipboard.writeText(`${window.location.origin}/form/${form.id}`);
                        toast.success(m.cf_copy_link_toast());
                      }}
                      class="p-1 rounded-md hover:bg-surface-container-high transition-colors shrink-0"
                      title={m.cf_copy_link_title()}
                    >
                      <Papicon icon="content_copy" size={12} />
                    </button>
                  </div>
                </div>

                <div class="flex items-center justify-between text-xs text-on-surface-variant/60 font-sans">
                  <span class="flex items-center gap-2">
                    <Papicon icon="assignment_turned_in" size={14} />
                    {m.cf_submissions_label()}
                  </span>
                  <span class="font-bold text-on-surface">{form._count?.submissions || 0}</span>
                </div>

                <div class="flex items-center justify-between text-xs text-on-surface-variant/60 font-sans">
                  <span class="flex items-center gap-2">
                    <Papicon icon="work" size={14} />
                    {m.cf_recruitment_link()}
                  </span>
                  <ToggleSwitch
                    checked={form.isRecruitment}
                    onToggle={(v: boolean) => toggleRecruitment(form.id, v)}
                  />
                </div>

                <div class="flex items-center justify-between text-xs text-on-surface-variant/60 font-sans">
                  <span class="flex items-center gap-2">
                    <Papicon icon="lock" size={14} />
                    {m.cf_discord_auth_label()}
                  </span>
                  <ToggleSwitch
                    checked={form.isRecruitment || form.requiresDiscordAuth}
                    disabled={form.isRecruitment}
                    onToggle={(v: boolean) => toggleRequiresAuth(form.id, v)}
                  />
                </div>
                {#if form.isRecruitment}
                  <p class="text-2xs text-on-surface-variant/40 font-sans -mt-2">
                    {m.cf_discord_auth_always()}
                  </p>

                  <div class="flex items-center justify-between text-xs text-on-surface-variant/60 font-sans gap-3">
                    <span class="flex items-center gap-2 shrink-0">
                      <Papicon icon="account_tree" size={14} />
                      {m.cf_target_hierarchy()}
                    </span>
                    <select
                      value={form.hierarchyId || ''}
                      onchange={(e) => updateFormHierarchy(form.id, (e.currentTarget as HTMLSelectElement).value)}
                      class="min-w-0 max-w-40 bg-surface-container rounded-lg px-2 py-1.5 text-2xs font-semibold outline-none border border-outline-variant/20 focus:border-primary"
                    >
                      <option value="">{m.cf_hierarchy_lowest_role()}</option>
                      {#each hierarchies as h}
                        <option value={h.id}>{h.name}</option>
                      {/each}
                    </select>
                  </div>
                  {#if hierarchies.length > 0}
                    <p class="text-2xs text-on-surface-variant/40 font-sans -mt-2">
                      {m.cf_hierarchy_hint()}
                    </p>
                  {/if}
                {/if}

                <div class="flex items-center justify-between text-xs text-on-surface-variant/60 font-sans">
                  <span class="flex items-center gap-2">
                    <Papicon icon="visibility" size={14} />
                    {m.cf_active_label()}
                  </span>
                  <ToggleSwitch
                    checked={form.isActive}
                    onToggle={(v: boolean) => toggleActive(form.id, v)}
                  />
                </div>
              </div>
            </div>

            <div class="flex gap-2 w-full pt-4 border-t border-outline-variant/10">
              <button
                onclick={() => router.goto(`/forms/builder/${form.id}`)}
                class="flex-1 px-3 py-2.5 rounded-xl bg-primary/10 text-primary text-body-sm font-medium hover:bg-primary/20 transition-all flex items-center justify-center gap-1.5"
                title={m.cf_btn_edit()}
              >
                <Papicon icon="edit" size={13} />
                {m.cf_btn_edit()}
              </button>
              <button
                onclick={() => router.goto(`/forms/${form.id}/responses`)}
                class="flex-1 px-3 py-2.5 rounded-xl bg-surface-container text-on-surface-variant text-body-sm font-medium hover:bg-surface-container-high transition-all flex items-center justify-center gap-1.5"
                title={m.cf_btn_responses()}
              >
                <Papicon icon="assignment" size={13} />
                {m.cf_btn_responses()}
              </button>
              <button
                onclick={() => deleteForm(form.id)}
                class="px-3 py-2.5 rounded-xl bg-error/10 text-error text-body-sm font-medium hover:bg-error/20 transition-all"
                title={m.cf_btn_delete()}
              >
                <Papicon icon="delete" size={14} />
              </button>
            </div>

          </div>
        {/each}
      </div>
    {/if}
  </div>
</ModulePage>

<!-- Create Form Modal -->
{#if showCreateModal}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
    <div class="bg-surface border border-outline-variant/30 rounded-xl w-full max-w-xl shadow-sm overflow-hidden animate-in zoom-in-95 duration-200">
      <div class="p-8 border-b border-outline-variant/20 flex items-center justify-between">
        <div>
          <h3 class="text-xl font-semibold text-on-surface font-sans">{m.cf_create_modal_title()}</h3>
          <p class="text-on-surface-variant text-sm font-sans">{m.cf_create_modal_subtitle()}</p>
        </div>
        <button onclick={() => showCreateModal = false} class="w-10 h-10 rounded-full flex items-center justify-center hover:bg-surface-hover transition-colors">
          <Papicon icon="close" size={20} />
        </button>
      </div>
      
      <div class="p-8 space-y-6">
        <div>
          <label for="form-name" class="block text-body-sm font-medium text-on-surface-variant/60 mb-2 font-sans">{m.cf_field_name_label()}</label>
          <FormInput 
            id="form-name"
            type="text" 
            bind:value={newFormName} 
            placeholder={m.cf_field_name_ph()}
            className="w-full"
          />
        </div>
        <div>
          <label for="form-description" class="block text-body-sm font-medium text-on-surface-variant/60 mb-2 font-sans">{m.cf_field_desc_label()}</label>
          <textarea 
            id="form-description"
            bind:value={newFormDescription}
            placeholder={m.cf_field_desc_ph()}
            class="w-full bg-surface-container rounded-lg p-4 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:outline-hidden border border-outline-variant/10 focus:border-primary/50 transition-all resize-none h-24 font-sans"
          ></textarea>
        </div>
      </div>
      
      <div class="p-8 bg-surface-container-low border-t border-outline-variant/20 flex gap-4">
        <button onclick={() => showCreateModal = false} class="flex-1 py-3.5 rounded-xl font-bold bg-surface hover:bg-surface-hover transition-colors font-sans">{m.cf_btn_cancel()}</button>
        <button 
          onclick={createForm}
          disabled={createAction.state.loading || !newFormName.trim()}
          class="flex-1 py-3.5 rounded-xl font-semibold bg-primary text-on-primary active:scale-[0.98] transition-all disabled:opacity-50 disabled:scale-100 font-sans"
        >
          {createAction.state.loading ? m.cf_btn_creating() : m.cf_btn_create_submit()}
        </button>
      </div>
    </div>
  </div>
{/if}
