<script lang="ts">
  /**
   * Onglet Hugging Face de la page Réseaux sociaux : suivi d'un modèle, d'un
   * dataset ou d'un space (nouveaux commits), ou d'un auteur (nouveaux dépôts).
   */
  import { m } from '../../i18n';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import Papicon from '../Papicon.svelte';
  import SearchableSelect from '../SearchableSelect.svelte';
  import { saveHuggingFaceFollow, deleteHuggingFaceFollow, fetchSocialFollows, type HuggingFaceKind } from '../../api';
  import { keyToMention, withMentionKey, type SelectOption } from '../../socialMentions';

  type ActionState = {
    run: (action: () => Promise<unknown>, options?: { successMessage?: string }) => Promise<unknown>;
    setError: (error: string) => void;
  };

  let {
    follows = $bindable<any[]>([]),
    channelOptions,
    mentionOptions,
    canManage,
    actionState,
  }: {
    follows: any[];
    channelOptions: SelectOption[];
    mentionOptions: SelectOption[];
    canManage: boolean;
    actionState: ActionState;
  } = $props();

  const KINDS: Array<{ id: HuggingFaceKind; label: () => string; placeholder: () => string }> = [
    { id: 'MODEL', label: () => m.social_hf_kind_model(), placeholder: () => m.social_hf_target_ph_repo() },
    { id: 'DATASET', label: () => m.social_hf_kind_dataset(), placeholder: () => m.social_hf_target_ph_repo() },
    { id: 'SPACE', label: () => m.social_hf_kind_space(), placeholder: () => m.social_hf_target_ph_repo() },
    { id: 'AUTHOR', label: () => m.social_hf_kind_author(), placeholder: () => m.social_hf_target_ph_author() },
  ];

  function kindLabel(kind: string): string {
    return KINDS.find((k) => k.id === kind)?.label() ?? kind;
  }

  function hubUrl(kind: string, target: string): string {
    if (kind === 'DATASET') return `https://huggingface.co/datasets/${target}`;
    if (kind === 'SPACE') return `https://huggingface.co/spaces/${target}`;
    return `https://huggingface.co/${target}`;
  }

  function emptyForm() {
    return { kind: 'MODEL' as HuggingFaceKind, target: '', discordChannelId: '', mention: '', message: '' };
  }

  let form = $state(emptyForm());
  const formPlaceholder = $derived(KINDS.find((k) => k.id === form.kind)?.placeholder() ?? '');

  async function handleAdd() {
    if (!form.target.trim()) {
      actionState.setError(m.social_hf_err_target_req());
      return;
    }
    await actionState.run(async () => {
      const res = await saveHuggingFaceFollow({
        kind: form.kind,
        target: form.target.trim(),
        discordChannelId: form.discordChannelId || null,
        mention: keyToMention(form.mention),
        message: form.message || null,
      });
      if (!res) throw new Error("Ça n'a pas marché. Réessaie.");
      form = emptyForm();
      const updated = await fetchSocialFollows();
      if (updated) follows = withMentionKey(updated.huggingface);
      return true;
    }, { successMessage: m.social_hf_toast_added() });
  }

  async function handleUpdate(follow: any) {
    await actionState.run(async () => {
      const res = await saveHuggingFaceFollow({
        kind: follow.kind,
        target: follow.target,
        discordChannelId: follow.discordChannelId || null,
        mention: keyToMention(follow.mentionKey),
        message: follow.message || null,
      });
      if (!res) throw new Error("Ça n'a pas marché. Réessaie.");
      return true;
    }, { successMessage: m.social_hf_toast_updated() });
  }

  async function handleDelete(id: string) {
    if (!(await confirmDialog.danger(m.social_hf_confirm_delete_title(), '', m.social_hf_confirm_delete_btn()))) return;
    await actionState.run(async () => {
      const ok = await deleteHuggingFaceFollow(id);
      if (!ok) throw new Error("Ça n'a pas marché. Réessaie.");
      follows = follows.filter((f) => f.id !== id);
      return true;
    }, { successMessage: m.social_hf_toast_deleted() });
  }

  const inputClass = 'w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#FFD21E]/40 transition-all text-on-surface';
  const smallInputClass = 'w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#FFD21E]/40 transition-all text-on-surface';
</script>

<div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
  <!-- ADD FORM COLUMN -->
  <div class="lg:col-span-1">
    <div class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6 sticky top-8 shadow-sm">
      <h3 class="text-lg font-semibold flex items-center gap-2.5">
        <span aria-hidden="true">🤗</span>
        {m.social_hf_form_title()}
      </h3>

      <div class="space-y-4">
        <div class="space-y-1.5">
          <span class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.social_hf_kind_label()}</span>
          <div class="grid grid-cols-2 gap-2" role="radiogroup" aria-label={m.social_hf_kind_label()}>
            {#each KINDS as kind (kind.id)}
              <button
                type="button"
                role="radio"
                aria-checked={form.kind === kind.id}
                onclick={() => (form.kind = kind.id)}
                class="px-3 py-2 rounded-lg text-xs font-semibold border transition-all {form.kind === kind.id ? 'bg-[#FFD21E]/15 border-[#FFD21E]/50 text-on-surface' : 'border-outline-variant/10 text-on-surface-variant/70 hover:bg-surface-container-high/40'}"
              >
                {kind.label()}
              </button>
            {/each}
          </div>
        </div>

        <div class="space-y-1.5">
          <label for="hf-target" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.social_hf_target_label()}</label>
          <input id="hf-target" type="text" placeholder={formPlaceholder} bind:value={form.target} class={inputClass} />
          <p class="text-2xs text-on-surface-variant/40 ml-2">{m.social_hf_target_hint()}</p>
        </div>

        <div class="space-y-1.5">
          <label for="hf-chan" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.social_channel_alerts_label()}</label>
          <SearchableSelect id="hf-chan" bind:value={form.discordChannelId} options={channelOptions} placeholder={m.social_default_channel_ph()} className={inputClass} />
        </div>

        <div class="space-y-1.5">
          <label for="hf-mention" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.social_mention_label()}</label>
          <SearchableSelect id="hf-mention" bind:value={form.mention} options={mentionOptions} placeholder={m.social_mention_ph()} className={smallInputClass} />
        </div>

        <div class="space-y-1.5">
          <label for="hf-msg" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.social_hf_message_label()}</label>
          <input id="hf-msg" type="text" placeholder={m.social_default_msg_ph()} bind:value={form.message} class={smallInputClass} />
          <p class="text-2xs text-on-surface-variant/40 ml-2">{m.social_gh_vars_hint()}</p>
        </div>

        <button
          onclick={handleAdd}
          disabled={!canManage}
          class="w-full mt-4 py-3.5 bg-[#FFD21E] hover:bg-[#f5c400] text-zinc-900 font-medium text-body-sm rounded-lg shadow-sm active:scale-[0.98] transition-all disabled:opacity-50"
        >
          {m.social_hf_add_btn()}
        </button>
        <p class="text-2xs text-on-surface-variant/50 ml-2">{m.social_gh_baseline_hint()}</p>
      </div>
    </div>
  </div>

  <!-- LIST COLUMN -->
  <div class="lg:col-span-2 space-y-6">
    <div class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6 min-h-100">
      <div class="flex items-center justify-between border-b border-outline-variant/20 pb-4">
        <h3 class="text-xl font-semibold flex items-center gap-2">
          <span aria-hidden="true">🤗</span>
          {m.social_hf_list_title({ n: follows.length })}
        </h3>
      </div>

      {#if follows.length === 0}
        <div class="flex flex-col items-center justify-center py-20 text-center text-on-surface-variant/50">
          <Papicon icon="Info" size={48} class="mb-4 text-on-surface-variant/30" />
          <p class="font-bold">{m.social_hf_empty_title()}</p>
          <p class="text-xs">{m.social_empty_hint()}</p>
        </div>
      {:else}
        <div class="space-y-6">
          {#each follows as follow (follow.id)}
            <div class="p-6 rounded-xl bg-surface-container-high/15 border border-outline-variant/5 hover:border-outline-variant/10 transition-all space-y-4">
              <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div class="space-y-1 min-w-0">
                  <h4 class="font-bold text-base flex items-center gap-2 min-w-0">
                    <span class="w-2.5 h-2.5 bg-[#FFD21E] rounded-full shrink-0"></span>
                    <a href={hubUrl(follow.kind, follow.target)} target="_blank" rel="noopener noreferrer" class="hover:underline truncate">{follow.target}</a>
                  </h4>
                  <p class="text-2xs uppercase font-bold text-on-surface-variant/40">{kindLabel(follow.kind)}</p>
                </div>

                <div class="flex items-center gap-2 self-end md:self-center">
                  <button onclick={() => handleUpdate(follow)} disabled={!canManage} title={m.social_save_config_tooltip()} class="p-3 bg-primary/10 hover:bg-primary/20 text-primary rounded-xl transition-all">
                    <Papicon icon="Paper" size={16} />
                  </button>
                  <button onclick={() => handleDelete(follow.id)} disabled={!canManage} title={m.social_unfollow_tooltip()} class="p-3 bg-error/10 hover:bg-error/20 text-error rounded-xl transition-all">
                    <Papicon icon="Trash" size={16} />
                  </button>
                </div>
              </div>

              <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div class="space-y-1">
                  <span class="text-2xs font-bold text-on-surface-variant/50 uppercase">{m.social_channel_alerts_label()}</span>
                  <SearchableSelect bind:value={follow.discordChannelId} options={channelOptions} placeholder={m.social_default_channel_short_ph()} className={smallInputClass} />
                </div>
                <div class="space-y-1">
                  <label for="hf-mention-{follow.id}" class="text-2xs font-bold text-on-surface-variant/50 uppercase">{m.social_mention_label()}</label>
                  <SearchableSelect id="hf-mention-{follow.id}" bind:value={follow.mentionKey} options={mentionOptions} placeholder={m.social_mention_ph()} className={smallInputClass} />
                </div>
                <div class="space-y-1">
                  <label for="hf-msg-{follow.id}" class="text-2xs font-bold text-on-surface-variant/50 uppercase">{m.social_hf_message_label()}</label>
                  <input id="hf-msg-{follow.id}" type="text" bind:value={follow.message} placeholder={m.social_default_msg_ph()} class={smallInputClass} />
                </div>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>
