<!--
  Panneaux Discord « statut des recrutements » : une ligne OPEN/CLOSED par
  poste et un bouton Postuler pour les postes ouverts. Le bot les re-rend seul
  quand un poste ouvre ou ferme.
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
  import MultiSelect from '../MultiSelect.svelte';
  import SearchableSelect from '../SearchableSelect.svelte';
  import { m } from '../../i18n';

  const { forms = [] }: { forms?: Array<{ id: string; name: string }> } = $props();

  type Panel = { id: string; title: string; channelId: string; formIds: string[] };

  let panels = $state<Panel[]>([]);
  let modalOpen = $state(false);
  let saving = $state(false);
  let editingId = $state<string | null>(null);
  let draft = $state({ title: '', channelId: '' as string | null, formIds: [] as string[] });

  const channels = $derived((dashboardStore.state.discordChannels ?? []).map((c) => ({ id: c.id, name: channelDisplayName(c) })));

  async function load() {
    const res = await dashboardFetch('/recruitment/panels').catch(() => null);
    if (res?.ok) panels = (await res.json()).panels ?? [];
  }

  function open(panel?: Panel) {
    editingId = panel?.id ?? null;
    draft = panel
      ? { title: panel.title, channelId: panel.channelId, formIds: [...panel.formIds] }
      : { title: '', channelId: null, formIds: forms.map((f) => f.id) };
    modalOpen = true;
  }

  async function save() {
    if (saving) return;
    saving = true;
    try {
      const res = await dashboardFetch(editingId ? `/recruitment/panels/${editingId}` : '/recruitment/panels', {
        method: editingId ? 'PATCH' : 'POST',
        payload: draft,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || m.rpan_err_save());
      toast.success(m.rpan_published());
      modalOpen = false;
      await load();
    } catch (err) {
      toast.error(errorMessage(err) || m.rpan_err_save());
    } finally {
      saving = false;
    }
  }

  async function remove(panel: Panel) {
    if (!(await confirmDialog.danger(m.rpan_delete_title(), m.rpan_delete_desc()))) return;
    const res = await dashboardFetch(`/recruitment/panels/${panel.id}`, { method: 'DELETE' }).catch(() => null);
    if (res?.ok) await load();
    else toast.error(m.rpan_err_save());
  }

  $effect(() => {
    void load();
  });
</script>

<section class="space-y-3">
  <div class="flex items-start justify-between gap-4">
    <div>
      <h3 class="text-lg font-semibold text-on-surface">{m.rpan_title()}</h3>
      <p class="text-on-surface-variant text-xs mt-0.5">{m.rpan_intro()}</p>
    </div>
    <ActionButton variant="primary" icon="plus" label={m.rpan_new()} onclick={() => open()} disabled={forms.length === 0} />
  </div>

  {#if panels.length === 0}
    <p class="text-xs text-on-surface-variant/70">{forms.length === 0 ? m.rpan_no_forms() : m.rpan_empty()}</p>
  {:else}
    <div class="space-y-2">
      {#each panels as panel (panel.id)}
        <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 p-4 flex items-center justify-between gap-3">
          <div class="min-w-0">
            <p class="text-sm font-semibold text-on-surface truncate">{panel.title}</p>
            <p class="text-2xs text-on-surface-variant mt-0.5">
              #{channels.find((c) => c.id === panel.channelId)?.name ?? panel.channelId} · {m.rpan_count({ count: panel.formIds.length })}
            </p>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <button type="button" class="p-2 rounded-lg hover:bg-white/5 text-on-surface-variant hover:text-on-surface transition-colors" title={m.common_edit()} onclick={() => open(panel)}>
              <Papicon icon="pencil" size={15} />
            </button>
            <button type="button" class="p-2 rounded-lg hover:bg-error/10 text-on-surface-variant hover:text-error transition-colors" title={m.common_delete()} onclick={() => remove(panel)}>
              <Papicon icon="trash" size={15} />
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</section>

<Modal bind:open={modalOpen} title={editingId ? m.rpan_edit() : m.rpan_new()} size="md" closeOnBackdropClick={!saving}>
  <div class="space-y-4">
    <label class="block">
      <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.rpan_field_title()}</span>
      <FormInput type="text" bind:value={draft.title} placeholder={m.rpan_field_title_ph()} className="w-full" />
    </label>
    <div>
      <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.rpan_field_channel()}</span>
      <SearchableSelect bind:value={draft.channelId} options={channels} placeholder={m.rpan_field_channel()} />
    </div>
    <div>
      <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.rpan_field_forms()}</span>
      <MultiSelect bind:values={draft.formIds} options={forms} />
    </div>
    <div class="flex justify-end gap-2 pt-1">
      <ActionButton variant="neutral" label={m.common_cancel()} disabled={saving} onclick={() => (modalOpen = false)} />
      <ActionButton variant="primary" label={saving ? m.tmac_saving() : m.rpan_publish()} disabled={saving} onclick={save} />
    </div>
  </div>
</Modal>
