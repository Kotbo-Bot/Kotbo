<!--
  Panneaux Discord « liste du staff » : « ## grade » puis « - @membre », du
  grade le plus haut au plus bas. Le bot les tient a jour tout seul.
-->
<script lang="ts">
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { dashboardFetch } from '../../api';
  import { channelDisplayName } from '../../channelUtils';
  import { errorMessage } from '@kotbo/shared';
  import Papicon from '../Papicon.svelte';
  import Modal from '../Modal.svelte';
  import ActionButton from '../ActionButton.svelte';
  import FormInput from '../FormInput.svelte';
  import SearchableSelect from '../SearchableSelect.svelte';
  import { staff } from './staffStore.svelte';
  import { m } from '../../i18n';

  type Panel = { id: string; title: string; channelId: string; hierarchyId: string | null };

  let panels = $state<Panel[]>([]);
  let modalOpen = $state(false);
  let saving = $state(false);
  let editingId = $state<string | null>(null);
  let draft = $state({ title: '', channelId: null as string | null, hierarchyId: null as string | null });

  const channels = $derived((dashboardStore.state.discordChannels ?? []).map((c) => ({ id: c.id, name: channelDisplayName(c) })));
  const hierarchies = $derived(staff.hierarchies.map((h) => ({ id: h.id, name: h.name })));

  async function load() {
    const res = await dashboardFetch('/staff/list-panels').catch(() => null);
    if (res?.ok) panels = (await res.json()).panels ?? [];
  }

  function open(panel?: Panel) {
    editingId = panel?.id ?? null;
    draft = panel
      ? { title: panel.title, channelId: panel.channelId, hierarchyId: panel.hierarchyId }
      : { title: m.slp_default_title(), channelId: null, hierarchyId: null };
    modalOpen = true;
  }

  async function save() {
    if (saving) return;
    saving = true;
    try {
      const res = await dashboardFetch(editingId ? `/staff/list-panels/${editingId}` : '/staff/list-panels', {
        method: editingId ? 'PATCH' : 'POST',
        payload: draft,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || m.slp_err_save());
      toast.success(m.slp_published());
      modalOpen = false;
      await load();
    } catch (err) {
      toast.error(errorMessage(err) || m.slp_err_save());
    } finally {
      saving = false;
    }
  }

  async function remove(panel: Panel) {
    if (!(await confirmDialog.danger(m.slp_delete_title(), m.slp_delete_desc()))) return;
    const res = await dashboardFetch(`/staff/list-panels/${panel.id}`, { method: 'DELETE' }).catch(() => null);
    if (res?.ok) await load();
    else toast.error(m.slp_err_save());
  }

  $effect(() => {
    void load();
  });
</script>

<section class="section-card p-5 space-y-3 mt-5">
  <div class="flex items-start justify-between gap-4">
    <div>
      <h3 class="text-base font-semibold text-on-surface">{m.slp_title()}</h3>
      <p class="text-on-surface-variant text-xs mt-0.5">{m.slp_intro()}</p>
    </div>
    {#if staff.canManageSettings}
      <ActionButton variant="primary" icon="plus" label={m.slp_new()} onclick={() => open()} />
    {/if}
  </div>

  {#if panels.length === 0}
    <p class="text-xs text-on-surface-variant/70">{m.slp_empty()}</p>
  {:else}
    <div class="space-y-2">
      {#each panels as panel (panel.id)}
        <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 p-4 flex items-center justify-between gap-3">
          <div class="min-w-0">
            <p class="text-sm font-semibold text-on-surface truncate">{panel.title}</p>
            <p class="text-2xs text-on-surface-variant mt-0.5">
              #{channels.find((c) => c.id === panel.channelId)?.name ?? panel.channelId}
              · {hierarchies.find((h) => h.id === panel.hierarchyId)?.name ?? m.slp_all_grades()}
            </p>
          </div>
          {#if staff.canManageSettings}
            <div class="flex items-center gap-1 shrink-0">
              <button type="button" class="p-2 rounded-lg hover:bg-white/5 text-on-surface-variant hover:text-on-surface transition-colors" title={m.common_edit()} onclick={() => open(panel)}>
                <Papicon icon="pencil" size={15} />
              </button>
              <button type="button" class="p-2 rounded-lg hover:bg-error/10 text-on-surface-variant hover:text-error transition-colors" title={m.common_delete()} onclick={() => remove(panel)}>
                <Papicon icon="trash" size={15} />
              </button>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</section>

<Modal bind:open={modalOpen} title={editingId ? m.slp_edit() : m.slp_new()} size="md" closeOnBackdropClick={!saving}>
  <div class="space-y-4">
    <label class="block">
      <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.rpan_field_title()}</span>
      <FormInput type="text" bind:value={draft.title} className="w-full" />
    </label>
    <div>
      <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.rpan_field_channel()}</span>
      <SearchableSelect bind:value={draft.channelId} options={channels} placeholder={m.rpan_field_channel()} />
    </div>
    {#if hierarchies.length > 0}
      <div>
        <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.slp_field_hierarchy()}</span>
        <SearchableSelect bind:value={draft.hierarchyId} options={hierarchies} placeholder={m.slp_all_grades()} showId={false} />
      </div>
    {/if}
    <div class="flex justify-end gap-2 pt-1">
      <ActionButton variant="neutral" label={m.common_cancel()} disabled={saving} onclick={() => (modalOpen = false)} />
      <ActionButton variant="primary" label={saving ? m.tmac_saving() : m.rpan_publish()} disabled={saving} onclick={save} />
    </div>
  </div>
</Modal>
