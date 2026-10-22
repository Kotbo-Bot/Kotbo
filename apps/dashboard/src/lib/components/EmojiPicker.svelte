<script lang="ts">
  /**
   * Bouton qui montre l'emoji choisi et ouvre le sélecteur (EmojiPanel) :
   * emojis du serveur, catalogue Unicode cherchable par nom, dépôt d'une image
   * qui devient un emoji du serveur sans quitter le dashboard.
   */
  import { m } from '../i18n';
  import { floatingPanel } from '../actions/floatingPanel';
  import { previewEmojiValue } from '../emojiCatalog';
  import EmojiPanel from './EmojiPanel.svelte';

  let {
    value = $bindable(''),
    disabled = false,
    /**
     * `mention` rend `<:nom:id>`, la seule forme que Discord affiche dans un
     * message. `id` rend l'identifiant nu, attendu là où l'emoji sert de clé
     * de réaction (starboard, rôles-réaction).
     */
    format = 'mention',
  }: {
    value: string;
    disabled?: boolean;
    format?: 'mention' | 'id';
  } = $props();

  let isOpen = $state(false);
  let buttonEl = $state<HTMLButtonElement | null>(null);
  let panelEl = $state<HTMLDivElement | null>(null);

  // Le bouton affiche la valeur retenue : avec un visage fixe, un choix ne
  // changeait rien à l'écran et le sélecteur passait pour cassé.
  const preview = $derived(previewEmojiValue(value));

  function close(refocus = true) {
    isOpen = false;
    if (refocus) buttonEl?.focus();
  }

  function pick(next: string) {
    value = next;
    close();
  }

  function handleOutsideClick(event: MouseEvent) {
    const target = event.target as Node;
    // Le panneau vit dans <body> : il faut le tester à part du bouton.
    if (!buttonEl?.contains(target) && !panelEl?.contains(target)) close(false);
  }

  $effect(() => {
    if (!isOpen) return;
    document.addEventListener('click', handleOutsideClick, true);
    return () => document.removeEventListener('click', handleOutsideClick, true);
  });
</script>

<button
  bind:this={buttonEl}
  type="button"
  {disabled}
  onclick={() => (isOpen = !isOpen)}
  aria-haspopup="dialog"
  aria-expanded={isOpen}
  aria-label={m.d1_emoji_open_picker()}
  title={m.d1_emoji_open_picker()}
  class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border bg-surface-container text-xl transition-colors select-none disabled:cursor-not-allowed disabled:opacity-50 {isOpen ? 'border-primary' : 'border-outline-variant hover:border-on-surface-variant'}"
>
  {#if preview?.kind === 'image'}
    <img src={preview.url} alt={preview.name} class="h-6 w-6 object-contain" />
  {:else if preview?.kind === 'text'}
    {preview.value}
  {:else}
    <span class="opacity-40 grayscale">😀</span>
  {/if}
</button>

{#if isOpen}
  <div
    bind:this={panelEl}
    use:floatingPanel={{ anchor: buttonEl, placement: 'bottom', align: 'end' }}
    class="flex w-[22rem] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest shadow-lg animate-in fade-in duration-150"
  >
    <EmojiPanel {value} {format} onpick={pick} onclear={value ? () => pick('') : undefined} onclose={close} />
  </div>
{/if}
