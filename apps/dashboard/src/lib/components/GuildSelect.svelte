<script lang="ts">
  import SearchableSelect from './SearchableSelect.svelte';

  /** Sélecteur de serveur : champ de recherche et liste intégrés (SearchableSelect, sans l'identifiant). */
  let {
    value = $bindable<string | null>(null),
    guilds,
    id = '',
    placeholder = '',
    className = '',
    disabled = false,
  }: {
    value?: string | null;
    guilds: Array<{ id: string; name: string }>;
    id?: string;
    placeholder?: string;
    className?: string;
    disabled?: boolean;
  } = $props();
</script>

<SearchableSelect
  {id}
  {placeholder}
  {className}
  {disabled}
  bind:value
  options={guilds.map((g) => ({ id: g.id, name: g.name }))}
  showId={false}
/>
