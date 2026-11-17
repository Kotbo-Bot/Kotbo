<script lang="ts">
  let {
    id = '',
    ariaLabel,
    value = $bindable(''),
    rows = 3,
    placeholder = '',
    disabled = false,
    readonly = false,
    className = '',
    oninput,
    onchange,
  }: {
    id?: string;
    /** Nom accessible quand aucun <label for> ne vise le champ (RGAA 11.1). */
    ariaLabel?: string;
    value?: string;
    rows?: number;
    placeholder?: string;
    disabled?: boolean;
    readonly?: boolean;
    className?: string;
    oninput?: (event: Event) => void;
    onchange?: (event: Event) => void;
  } = $props();
</script>

<textarea
  {id}
  aria-label={ariaLabel}
  bind:value
  {rows}
  {placeholder}
  {disabled}
  {readonly}
  oninput={oninput}
  onchange={onchange}
  class="input {className}"
></textarea>
