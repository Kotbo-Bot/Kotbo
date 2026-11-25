/**
 * Primitives d'interface du dashboard.
 *
 * Une page qui a besoin d'un bouton, d'onglets, d'un champ, d'un encadre ou
 * d'une ligne de reglage les prend ici plutot que de les ecrire en classes
 * Tailwind : c'est ce qui garde les ecrans coherents entre eux.
 */
export { default as Button } from './Button.svelte';
export { default as Tabs, type TabItem } from './Tabs.svelte';
export { default as FilterPills, type FilterOption } from './FilterPills.svelte';
export { default as Callout } from './Callout.svelte';
export { default as Field } from './Field.svelte';
export { default as Menu, type MenuItem } from './Menu.svelte';
export { default as StatTile } from './StatTile.svelte';

export { default as SettingsRow } from '../management/SettingsRow.svelte';
export { default as SettingsGroup } from '../management/SettingsGroup.svelte';
export { default as SectionCard } from '../SectionCard.svelte';
export { default as ToggleSwitch } from '../ToggleSwitch.svelte';
export { default as Modal } from '../Modal.svelte';
export { default as EmptyState } from '../EmptyState.svelte';
