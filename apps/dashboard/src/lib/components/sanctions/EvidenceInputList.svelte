<script lang="ts">
  import Papicon from '../Papicon.svelte';
  import DiscordEvidencePicker from './DiscordEvidencePicker.svelte';
  import TranscriptAttachPicker from './TranscriptAttachPicker.svelte';
  import { normalizeEvidenceLinks } from '../../sanctions/evidenceLinks';
  import { authStore } from '../../stores/auth.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { uploadEvidenceFile, deleteEvidenceFile } from '../../api';
  import { m } from '../../i18n';

  let {
    links = $bindable([]),
    disabled = false,
    placeholder = m.sei_link_placeholder(),
    labelId = '',
    inputIdPrefix = '',
    guildId = authStore.selectedGuildId,
    sanctionId = null
  } = $props<{
    links: string[];
    disabled?: boolean;
    placeholder?: string;
    labelId?: string;
    inputIdPrefix?: string;
    guildId?: string;
    sanctionId?: string | null;
  }>();

  let pickerOpen = $state(false);
  let transcriptPickerOpen = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);
  let uploadBusy = $state(false);

  const initialLinks = normalizeEvidenceLinks(links, true);
  if (initialLinks.length !== links.length || initialLinks.some((link, index) => link !== links[index])) {
    links = initialLinks;
  }

  function addLink() {
    links = [...normalizeEvidenceLinks(links, true), ''];
  }

  async function removeLink(index: number) {
    const normalized = normalizeEvidenceLinks(links, true);
    const linkToRemove = normalized[index];

    // Si c'est un fichier uploade en base, on le supprime de la base pour liberer de l'espace de stockage
    const prefix = `${window.location.origin}/sanction-evidence/`;
    if (linkToRemove && linkToRemove.startsWith(prefix)) {
      const fileId = linkToRemove.substring(prefix.length);
      try {
        await deleteEvidenceFile(fileId, guildId);
      } catch (err) {
        console.error('Failed to delete file from DB:', err);
      }
    }

    if (normalized.length <= 1) {
      links = [''];
      return;
    }
    links = normalized.filter((_, i) => i !== index);
  }

  function handleInput(index: number, value: string) {
    links = normalizeEvidenceLinks(links, true).map((link, i) => i === index ? value : link);
  }

  async function onFileSelected(e: Event) {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;

    if (file.size > 10 * 1024 * 1024) {
      toast.error(m.sei_file_too_large());
      return;
    }

    uploadBusy = true;
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const result = reader.result as string;
        const base64Data = result.split(',')[1];
        if (!base64Data) {
          toast.error(m.sei_read_error());
          uploadBusy = false;
          return;
        }

        const res = await uploadEvidenceFile(file.name, file.type, base64Data, sanctionId, guildId);
        if (res && res.id) {
          const fileUrl = `${window.location.origin}/sanction-evidence/${res.id}`;
          const currentLinks = normalizeEvidenceLinks(links, false).filter(l => l.trim().length > 0);
          links = [...currentLinks, fileUrl];
        }
        uploadBusy = false;
      };
      reader.onerror = () => {
        toast.error(m.sei_read_error());
        uploadBusy = false;
      };
      reader.readAsDataURL(file);
    } catch (err) {
      console.error(err);
      toast.error(m.sei_upload_error());
      uploadBusy = false;
    } finally {
      target.value = ''; // Reset input
    }
  }

  function attachTranscriptUrl(url: string) {
    const currentLinks = normalizeEvidenceLinks(links, false).filter(l => l.trim().length > 0);
    links = [...currentLinks, url];
  }
</script>

<div class="space-y-3" role={labelId ? 'group' : undefined} aria-labelledby={labelId || undefined}>
  <!-- Invisible File Input -->
  <input
    type="file"
    bind:this={fileInput}
    onchange={onFileSelected}
    accept="image/*,application/pdf,video/*"
    style="display: none;"
  />

  {#each links as link, index (index)}
    <div class="flex items-center gap-2 animate-in fade-in slide-in-from-left-2 duration-200">
      <div class="relative flex-1 group">
        <div class="absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant/30 group-focus-within:text-primary transition-colors">
          <Papicon icon="link" size={14} />
        </div>
        <input
          id={inputIdPrefix ? `${inputIdPrefix}-${index}` : undefined}
          type="url"
          value={link}
          oninput={(e) => handleInput(index, e.currentTarget.value)}
          {placeholder}
          {disabled}
          class="w-full rounded-lg bg-surface-container-high pl-10 pr-4 py-3 text-xs font-bold text-on-surface border border-outline-variant/10 focus:border-primary/50 outline-hidden transition-all"
        />
      </div>
      
      {#if !disabled}
        <button
          type="button"
          onclick={() => removeLink(index)}
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-on-surface/5 text-on-surface-variant/40 hover:bg-error/10 hover:text-error transition-all active:scale-95"
          title={m.sei_delete_link()}
        >
          <Papicon icon="trash-2" size={16} />
        </button>
      {/if}
    </div>
  {/each}

  {#if !disabled}
    <div class="flex flex-wrap gap-2">
      <button
        type="button"
        onclick={addLink}
        class="flex flex-1 min-w-[130px] items-center justify-center gap-2 rounded-lg border-2 border-dashed border-outline-variant/20 py-3 text-xs font-medium text-on-surface-variant hover:border-primary/40 hover:bg-primary/5 hover:text-primary transition-all active:scale-[0.99]"
      >
        <Papicon icon="plus" size={14} />
        {m.sei_add_link()}
      </button>

      <button
        type="button"
        onclick={() => fileInput?.click()}
        disabled={uploadBusy}
        class="flex flex-1 min-w-[130px] items-center justify-center gap-2 rounded-lg border-2 border-dashed border-outline-variant/20 py-3 text-xs font-medium text-on-surface-variant hover:border-primary/40 hover:bg-primary/5 hover:text-primary transition-all active:scale-[0.99] disabled:opacity-50"
      >
        {#if uploadBusy}
          <div class="animate-spin w-3.5 h-3.5 border-2 border-primary border-t-transparent rounded-full"></div>
          {m.sei_uploading()}
        {:else}
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          {m.sei_upload_file()}
        {/if}
      </button>

      <button
        type="button"
        onclick={() => (transcriptPickerOpen = true)}
        class="flex flex-1 min-w-[130px] items-center justify-center gap-2 rounded-lg border-2 border-dashed border-outline-variant/20 py-3 text-xs font-medium text-on-surface-variant hover:border-primary/40 hover:bg-primary/5 hover:text-primary transition-all active:scale-[0.99]"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
        {m.sei_attach_transcript()}
      </button>

      {#if sanctionId}
        <button
          type="button"
          onclick={() => (pickerOpen = true)}
          class="flex flex-1 min-w-[130px] items-center justify-center gap-2 rounded-lg border-2 border-dashed border-outline-variant/20 py-3 text-xs font-medium text-on-surface-variant hover:border-primary/40 hover:bg-primary/5 hover:text-primary transition-all active:scale-[0.99]"
        >
          <Papicon icon="message-square" size={14} />
          {m.sei_import_from_discord()}
        </button>
      {/if}
    </div>
  {/if}
</div>

{#if sanctionId}
  <DiscordEvidencePicker
    bind:open={pickerOpen}
    {guildId}
    {sanctionId}
    onImport={(urls) => {
      const existing = normalizeEvidenceLinks(links, false).filter((l) => l.trim().length > 0);
      links = [...existing, ...urls];
    }}
  />
{/if}

<TranscriptAttachPicker
  bind:open={transcriptPickerOpen}
  onAttach={attachTranscriptUrl}
/>
