<!--
  Macros du support : réponses pré-écrites que le staff insère depuis un
  ticket, avec leurs actions (type, rôles, satisfaction, fermeture). Onglet
  autonome de la page Tickets.
-->
<script lang="ts">
  import { authStore } from '../../stores/auth.svelte';
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { dashboardFetch } from '../../api';
  import { errorMessage } from '@kotbo/shared';
  import Papicon from '../Papicon.svelte';
  import EmojiText from '../EmojiText.svelte';
  import Modal from '../Modal.svelte';
  import Skeleton from '../Skeleton.svelte';
  import ActionButton from '../ActionButton.svelte';
  import FormInput from '../FormInput.svelte';
  import FormTextarea from '../FormTextarea.svelte';
  import FormSelect from '../FormSelect.svelte';
  import MultiSelect from '../MultiSelect.svelte';
  import { m } from '../../i18n';

  const {
    refreshToken = 0,
    ticketTypes = [],
  }: {
    /** Incrémenté par la page (bouton Actualiser) pour relire les macros. */
    refreshToken?: number;
    /** Types de tickets de la configuration, pour cibler une macro. */
    ticketTypes?: Array<{ id: string; label: string }>;
  } = $props();

  const discordRoles = $derived(dashboardStore.state.discordRoles || []);

  // ── Macros ────────────────────────────────────────────────────────────────
  type TicketMacro = {
    id: string;
    name: string;
    category: string | null;
    emoji: string | null;
    content: string;
    enabled: boolean;
    position: number;
    ticketTypeIds: string[];
    allowedRoleIds: string[];
    keywords: string[];
    autoSendOnOpen: boolean;
    setTicketTypeId: string | null;
    addRoleId: string | null;
    removeRoleId: string | null;
    requestSatisfaction: boolean;
    closeTicket: boolean;
    usageCount: number;
  };

  let macros = $state<TicketMacro[]>([]);
  let macrosLoading = $state(false);
  let macroModalOpen = $state(false);
  let macroSaving = $state(false);
  /** `null` = creation ; sinon l'identifiant de la macro modifiee. */
  let editingMacroId = $state<string | null>(null);
  let macroForm = $state(emptyMacroForm());
  /** Saisie libre des mots-cles, convertie en tableau a l'enregistrement. */
  let macroKeywordsText = $state('');

  function emptyMacroForm() {
    return {
      name: '',
      category: '',
      emoji: '',
      content: '',
      enabled: true,
      position: 0,
      ticketTypeIds: [] as string[],
      allowedRoleIds: [] as string[],
      autoSendOnOpen: false,
      setTicketTypeId: '',
      addRoleId: '',
      removeRoleId: '',
      requestSatisfaction: false,
      closeTicket: false,
    };
  }

  /** Resume des actions attachees, pour la ligne de la liste. */
  function macroActionSummary(macro: TicketMacro): string {
    const parts: string[] = [];
    if (macro.setTicketTypeId) parts.push(m.tmac_sum_retype());
    if (macro.addRoleId) parts.push(m.tmac_sum_add_role());
    if (macro.removeRoleId) parts.push(m.tmac_sum_remove_role());
    if (macro.requestSatisfaction) parts.push(m.tmac_sum_survey());
    if (macro.closeTicket) parts.push(m.tmac_sum_close());
    return parts.join(', ');
  }

  async function loadMacros() {
    if (!authStore.selectedGuildId) return;
    macrosLoading = true;
    try {
      const res = await dashboardFetch(`/tickets/macros`);
      if (!res.ok) throw new Error(m.tmac_err_load());
      macros = (await res.json()).macros || [];
    } catch (err) {
      toast.error(errorMessage(err) || m.tmac_err_load());
    } finally {
      macrosLoading = false;
    }
  }

  function openNewMacro() {
    editingMacroId = null;
    macroForm = emptyMacroForm();
    macroKeywordsText = '';
    macroModalOpen = true;
  }

  function openEditMacro(macro: TicketMacro) {
    editingMacroId = macro.id;
    macroForm = {
      name: macro.name,
      category: macro.category || '',
      emoji: macro.emoji || '',
      content: macro.content,
      enabled: macro.enabled,
      position: macro.position,
      ticketTypeIds: [...(macro.ticketTypeIds || [])],
      allowedRoleIds: [...(macro.allowedRoleIds || [])],
      autoSendOnOpen: macro.autoSendOnOpen,
      setTicketTypeId: macro.setTicketTypeId || '',
      addRoleId: macro.addRoleId || '',
      removeRoleId: macro.removeRoleId || '',
      requestSatisfaction: macro.requestSatisfaction,
      closeTicket: macro.closeTicket,
    };
    macroKeywordsText = (macro.keywords || []).join(', ');
    macroModalOpen = true;
  }

  async function saveMacro() {
    if (!authStore.selectedGuildId || macroSaving) return;
    if (!macroForm.name.trim() || !macroForm.content.trim()) {
      toast.error(m.tmac_err_required());
      return;
    }

    macroSaving = true;
    try {
      const res = await dashboardFetch(
        editingMacroId ? `/tickets/macros/${editingMacroId}` : '/tickets/macros',
        {
          method: editingMacroId ? 'PATCH' : 'POST',
          payload: {
            ...macroForm,
            keywords: macroKeywordsText.split(',').map((k) => k.trim()).filter(Boolean),
            // Chaines vides = « pas d'action », que l'API attend en `null`.
            setTicketTypeId: macroForm.setTicketTypeId || null,
            addRoleId: macroForm.addRoleId || null,
            removeRoleId: macroForm.removeRoleId || null,
            category: macroForm.category || null,
            emoji: macroForm.emoji || null,
          },
        },
      );
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || m.tmac_err_save());

      toast.success(editingMacroId ? m.tmac_updated() : m.tmac_created());
      macroModalOpen = false;
      await loadMacros();
    } catch (err) {
      toast.error(errorMessage(err) || m.tmac_err_save());
    } finally {
      macroSaving = false;
    }
  }

  async function deleteMacro(macro: TicketMacro) {
    const confirmed = await confirmDialog.ask({
      title: m.tmac_delete_title(),
      description: m.tmac_delete_desc({ name: macro.name }),
      confirmLabel: m.common_delete(),
      variant: 'danger',
    });
    if (!confirmed) return;

    try {
      const res = await dashboardFetch(`/tickets/macros/${macro.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(m.tmac_err_delete());
      toast.success(m.tmac_deleted());
      await loadMacros();
    } catch (err) {
      toast.error(errorMessage(err) || m.tmac_err_delete());
    }
  }

  $effect(() => {
    void refreshToken;
    void loadMacros();
  });
</script>

<div class="max-w-4xl mx-auto space-y-4">
  <div class="flex items-start justify-between gap-4 pb-2">
    <div>
      <h3 class="text-lg font-semibold text-on-surface">{m.tmac_title()}</h3>
      <p class="text-on-surface-variant text-xs mt-0.5">
        {m.tmac_intro()} <code class="px-1 rounded bg-surface-container">{'{user}'}</code>,
        <code class="px-1 rounded bg-surface-container">{'{staff}'}</code>,
        <code class="px-1 rounded bg-surface-container">{'{ticket_id}'}</code>,
        <code class="px-1 rounded bg-surface-container">{'{ticket_type}'}</code>,
        <code class="px-1 rounded bg-surface-container">{'{server}'}</code>.
      </p>
    </div>
    <ActionButton variant="primary" icon="plus" label={m.tmac_new()} onclick={openNewMacro} />
  </div>

  {#if macrosLoading}
    <Skeleton className="h-24 w-full" />
  {:else if macros.length === 0}
    <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 p-8 text-center">
      <Papicon icon="zap" size={28} class="text-on-surface-variant/40 mx-auto mb-2" />
      <p class="text-sm font-semibold text-on-surface">{m.tmac_empty_title()}</p>
      <p class="text-xs text-on-surface-variant mt-1">
        {m.tmac_empty_desc()}
      </p>
    </div>
  {:else}
    <div class="space-y-2">
      {#each macros as macro (macro.id)}
        <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 p-4">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                {#if macro.emoji}<EmojiText value={macro.emoji} class="text-sm" />{/if}
                <span class="text-sm font-semibold text-on-surface">{macro.name}</span>
                {#if macro.category}
                  <span class="text-2xs px-1.5 py-0.5 rounded bg-surface-container text-on-surface-variant">{macro.category}</span>
                {/if}
                {#if !macro.enabled}
                  <span class="text-2xs px-1.5 py-0.5 rounded bg-error/10 text-error">{m.tmac_disabled()}</span>
                {/if}
                {#if macro.autoSendOnOpen}
                  <span class="text-2xs px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400">{m.tmac_auto()}</span>
                {/if}
              </div>
              <p class="text-xs text-on-surface-variant/80 mt-1.5 line-clamp-2 whitespace-pre-wrap">{macro.content}</p>
              <div class="flex items-center gap-3 mt-2 text-2xs text-on-surface-variant">
                <span>{macro.usageCount > 1 ? m.tmac_uses_many({ count: macro.usageCount }) : m.tmac_uses_one()}</span>
                {#if macro.keywords?.length}
                  <span>· {m.tmac_keywords({ list: macro.keywords.join(', ') })}</span>
                {/if}
                {#if macroActionSummary(macro)}
                  <span>· {macroActionSummary(macro)}</span>
                {/if}
              </div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <button
                type="button"
                class="p-2 rounded-lg hover:bg-white/5 text-on-surface-variant hover:text-on-surface transition-colors"
                title={m.common_edit()}
                onclick={() => openEditMacro(macro)}
              >
                <Papicon icon="pencil" size={15} />
              </button>
              <button
                type="button"
                class="p-2 rounded-lg hover:bg-error/10 text-on-surface-variant hover:text-error transition-colors"
                title={m.common_delete()}
                onclick={() => deleteMacro(macro)}
              >
                <Papicon icon="trash" size={15} />
              </button>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<!-- Creation / edition d'une macro -->
<Modal
  bind:open={macroModalOpen}
  title={editingMacroId ? m.tmac_edit_title() : m.tmac_new()}
  subtitle={m.tmac_modal_subtitle()}
  size="lg"
  closeOnBackdropClick={!macroSaving}
>
  <div class="space-y-4">
    <div class="grid grid-cols-1 sm:grid-cols-[1fr_140px_80px] gap-3">
      <label class="block">
        <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.tmac_name()}</span>
        <FormInput type="text" bind:value={macroForm.name} placeholder={m.tmac_name_ph()} className="w-full" />
      </label>
      <label class="block">
        <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.tmac_category()}</span>
        <FormInput type="text" bind:value={macroForm.category} placeholder={m.tmac_category_ph()} className="w-full" />
      </label>
      <label class="block">
        <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.tmac_emoji()}</span>
        <FormInput type="text" bind:value={macroForm.emoji} placeholder="📎" className="w-full" />
      </label>
    </div>

    <label class="block">
      <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.tmac_content()}</span>
      <FormTextarea
        bind:value={macroForm.content}
        placeholder={m.tmac_content_ph({ user: '{user}' })}
        className="w-full h-28"
      />
      <span class="text-2xs text-on-surface-variant ml-1 mt-1 block">
        {m.tmac_content_hint()}
      </span>
    </label>

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div>
        <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.tmac_types()}</span>
        <MultiSelect
          bind:values={macroForm.ticketTypeIds}
          options={ticketTypes.map((t: any) => ({ id: t.id, name: t.label }))}
          placeholder={m.tmac_types_ph()}
        />
      </div>
      <div>
        <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.tmac_roles()}</span>
        <MultiSelect
          bind:values={macroForm.allowedRoleIds}
          options={discordRoles.map(r => ({ id: r.id, name: `@${r.name}` }))}
          placeholder={m.tmac_roles_ph()}
        />
      </div>
    </div>

    <label class="block">
      <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.tmac_keywords_label()}</span>
      <FormInput type="text" bind:value={macroKeywordsText} placeholder={m.tmac_keywords_ph()} className="w-full" />
      <span class="text-2xs text-on-surface-variant ml-1 mt-1 block">
        {m.tmac_keywords_hint()}
      </span>
    </label>

    <div class="border-t border-outline-variant/10 pt-4 space-y-3">
      <p class="text-xs font-bold text-on-surface">{m.tmac_actions()}</p>
      <p class="text-2xs text-on-surface-variant -mt-2">
        {m.tmac_actions_hint()}
      </p>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.tmac_retype()}</span>
          <FormSelect bind:value={macroForm.setTicketTypeId} className="w-full">
            <option value="">{m.tmac_no_change()}</option>
            {#each ticketTypes as t (t.id)}
              <option value={t.id}>{t.label}</option>
            {/each}
          </FormSelect>
        </div>
        <div>
          <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.tmac_add_role()}</span>
          <FormSelect bind:value={macroForm.addRoleId} className="w-full">
            <option value="">{m.common_none()}</option>
            {#each discordRoles as role (role.id)}
              <option value={role.id}>@{role.name}</option>
            {/each}
          </FormSelect>
        </div>
        <div>
          <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.tmac_remove_role()}</span>
          <FormSelect bind:value={macroForm.removeRoleId} className="w-full">
            <option value="">{m.common_none()}</option>
            {#each discordRoles as role (role.id)}
              <option value={role.id}>@{role.name}</option>
            {/each}
          </FormSelect>
        </div>
      </div>

      <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
        <input type="checkbox" bind:checked={macroForm.requestSatisfaction} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
        <span class="text-xs font-bold text-on-surface">{m.tmac_survey()}</span>
      </label>
      <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
        <input type="checkbox" bind:checked={macroForm.closeTicket} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
        <span class="text-xs font-bold text-on-surface">{m.tmac_close()}</span>
      </label>
    </div>

    <div class="border-t border-outline-variant/10 pt-4 space-y-3">
      <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
        <input type="checkbox" bind:checked={macroForm.autoSendOnOpen} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
        <div>
          <span class="text-xs font-bold text-on-surface">{m.tmac_auto_send()}</span>
          <p class="text-2xs text-on-surface-variant">
            {m.tmac_auto_send_hint()}
          </p>
        </div>
      </label>
      <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
        <input type="checkbox" bind:checked={macroForm.enabled} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
        <span class="text-xs font-bold text-on-surface">{m.tmac_enabled()}</span>
      </label>
    </div>

    <div class="flex justify-end gap-2 pt-1">
      <ActionButton variant="neutral" label={m.common_cancel()} disabled={macroSaving} onclick={() => (macroModalOpen = false)} />
      <ActionButton
        variant="primary"
        label={macroSaving ? m.tmac_saving() : m.common_save()}
        disabled={macroSaving}
        onclick={saveMacro}
      />
    </div>
  </div>
</Modal>
