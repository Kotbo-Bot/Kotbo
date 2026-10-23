<script lang="ts">
  /**
   * Champ de texte dont les variables s'insèrent d'un clic.
   *
   * Les gabarits d'un message acceptent des variables comme le lot ou le nom
   * des gagnants. Les énumérer dans une phrase d'aide obligeait à les recopier
   * à la main, au caractère près, sans jamais savoir ce que chacune produit :
   * les puces ci-dessous les posent à l'endroit du curseur et disent à quoi
   * elles servent.
   */
  import { m } from '../i18n';
  import Papicon from './Papicon.svelte';
  import type { MacroOption } from '../macros';

  let {
    id,
    label,
    hint = '',
    value = $bindable(''),
    macros = [],
    multiline = false,
    rows = 3,
    disabled = false,
    placeholder = '',
    /** Texte d'usine, proposé par un bouton de remise à zéro quand il est fourni. */
    defaultValue = null,
  }: {
    id: string;
    label: string;
    hint?: string;
    value: string;
    macros?: MacroOption[];
    multiline?: boolean;
    rows?: number;
    disabled?: boolean;
    placeholder?: string;
    defaultValue?: string | null;
  } = $props();

  let field = $state<HTMLInputElement | HTMLTextAreaElement | null>(null);

  function insert(token: string) {
    const element = field;
    if (!element) {
      value = `${value}${token}`;
      return;
    }

    // Insérer au curseur plutôt qu'à la fin : on ajoute presque toujours une
    // variable au milieu d'une phrase déjà écrite.
    const start = element.selectionStart ?? value.length;
    const end = element.selectionEnd ?? start;
    value = value.slice(0, start) + token + value.slice(end);

    const caret = start + token.length;
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(caret, caret);
    });
  }

  const isModified = $derived(defaultValue !== null && value !== defaultValue);

  /**
   * Variable survolée, dont l'explication s'affiche sous les puces. Un simple
   * attribut `title` obligeait à attendre l'infobulle du navigateur, et ne
   * disait rien à qui parcourt le formulaire au clavier.
   */
  let described = $state<MacroOption | null>(null);
</script>

<div>
  <div class="flex items-center justify-between gap-3">
    <label for={id} class="field-label">{label}</label>
    {#if isModified}
      <button
        type="button"
        onclick={() => { value = defaultValue ?? ''; }}
        class="flex items-center gap-1.5 text-2xs font-medium text-on-surface-variant hover:text-primary transition-colors cursor-pointer"
        {disabled}
      >
        <Papicon icon="refresh" size={12} />
        {m.macro_field_reset()}
      </button>
    {/if}
  </div>

  {#if multiline}
    <textarea
      {id}
      bind:this={field}
      bind:value
      {rows}
      {placeholder}
      {disabled}
      class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none resize-y"
    ></textarea>
  {:else}
    <input
      {id}
      bind:this={field}
      bind:value
      type="text"
      {placeholder}
      {disabled}
      class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
    />
  {/if}

  {#if hint}
    <p class="field-hint">{hint}</p>
  {/if}

  {#if macros.length > 0}
    <div class="mt-2 flex flex-wrap items-center gap-1.5">
      <span class="text-2xs text-on-surface-variant mr-1">{m.macro_field_insert()}</span>
      {#each macros as macro (macro.token)}
        <button
          type="button"
          onclick={() => insert(macro.token)}
          onmouseenter={() => { described = macro; }}
          onmouseleave={() => { described = null; }}
          onfocus={() => { described = macro; }}
          onblur={() => { described = null; }}
          title={macro.label}
          {disabled}
          class="px-2 py-1 rounded-md bg-surface-container-high/50 hover:bg-primary/15 hover:text-primary border border-outline-variant/10 text-2xs font-mono text-on-surface-variant transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
        >
          {macro.token}
        </button>
      {/each}
    </div>

    <p class="field-hint" aria-live="polite">
      {#if described}
        <span class="font-mono text-on-surface">{described.token}</span>
        {' '}{described.label}
      {:else}
        {m.macro_field_help()}
      {/if}
    </p>
  {/if}
</div>
