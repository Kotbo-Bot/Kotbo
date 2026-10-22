<script lang="ts">
  let {
    id = '',
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
  bind:value
  {rows}
  {placeholder}
  {disabled}
  {readonly}
  oninput={oninput}
  onchange={onchange}
  class="input {className}"
></textarea>
