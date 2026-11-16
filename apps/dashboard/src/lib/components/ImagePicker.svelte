<!--
  Choix d'une image : importee depuis l'ordinateur (glisser-deposer ou
  bouton) ou collee en lien https. La valeur est une data URI ou un lien.

    <ImagePicker label="Avatar" shape="avatar" bind:value={avatar} />
-->
<script lang="ts">
  import { m } from '../i18n';
  import { toast } from '../stores/toast.svelte';
  import { importImageFile } from '../imageImport';
  import Button from './ui/Button.svelte';
  import Papicon from './Papicon.svelte';

  let {
    label,
    value = $bindable(''),
    shape = 'avatar',
    hint = '',
  }: {
    label: string;
    value: string;
    shape?: 'avatar' | 'banner';
    hint?: string;
  } = $props();

  const id = $props.id();
  let input = $state<HTMLInputElement | null>(null);
  let dragging = $state(false);
  let importing = $state(false);
  let showUrl = $state(false);
  const isLink = $derived(value.startsWith('http'));
  // Une bannière Discord s'affiche large : on garde plus de pixels qu'un avatar.
  const maxDimension = $derived(shape === 'banner' ? 1920 : 1024);

  async function take(file: File | undefined) {
    if (!file) return;
    importing = true;
    const result = await importImageFile(file, maxDimension);
    importing = false;
    if ('error' in result) {
      toast.error(result.error === 'too_large' ? m.imgp_too_large() : result.error === 'unsupported' ? m.imgp_unsupported() : m.imgp_unreadable());
      return;
    }
    value = result.dataUrl;
    showUrl = false;
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    void take(event.dataTransfer?.files?.[0]);
  }
</script>

<div class="space-y-2">
  <span id="{id}-label" class="text-xs font-medium text-on-surface-variant block">{label}</span>
  <div
    role="group"
    aria-labelledby="{id}-label"
    class="flex items-center gap-3 rounded-lg border border-dashed p-2 transition-colors {dragging ? 'border-primary bg-primary/5' : 'border-outline-variant'}"
    ondragover={(e) => { e.preventDefault(); dragging = true; }}
    ondragleave={() => (dragging = false)}
    ondrop={onDrop}
  >
    <div class="shrink-0 overflow-hidden bg-surface-container-high flex items-center justify-center {shape === 'banner' ? 'w-28 h-14 rounded-md' : 'w-14 h-14 rounded-full'}">
      {#if value}
        <img src={value} alt="" class="w-full h-full object-cover" />
      {:else}
        <Papicon icon="image" size={18} class="text-on-surface-variant" />
      {/if}
    </div>
    <div class="flex flex-wrap items-center gap-1.5 min-w-0">
      <Button size="sm" icon="upload" loading={importing} onclick={() => input?.click()}>{m.imgp_import()}</Button>
      <Button size="sm" variant="ghost" icon="link" onclick={() => (showUrl = !showUrl)} aria-expanded={showUrl}>{m.imgp_link()}</Button>
      {#if value}
        <Button size="sm" variant="ghost" icon="x" onclick={() => { value = ''; showUrl = false; }}>{m.imgp_remove()}</Button>
      {/if}
    </div>
    <input
      bind:this={input}
      type="file"
      accept="image/png,image/jpeg,image/gif,image/webp"
      class="sr-only"
      tabindex="-1"
      aria-hidden="true"
      onchange={(e) => { void take(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }}
    />
  </div>
  {#if showUrl || isLink}
    <input
      type="url"
      aria-label={m.imgp_link_label({ label })}
      placeholder="https://"
      value={isLink ? value : ''}
      oninput={(e) => (value = e.currentTarget.value.trim())}
      class="input"
    />
  {/if}
  <p class="text-2xs text-on-surface-variant">{hint || m.imgp_hint()}</p>
</div>
