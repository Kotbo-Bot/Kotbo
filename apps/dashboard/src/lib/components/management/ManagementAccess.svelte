<script module>
  import { MODULE_CATEGORIES, getModuleDefinition } from '@kotbo/contracts';
  import { m } from '../../i18n';
  import { moduleName } from '../../moduleLabels';

  /**
   * Categorie d'affichage d'une fonctionnalite. Le registre la porte deja ;
   * la table ecrite a la main qui vivait ici l'ignorait, et toute
   * fonctionnalite qu'on oubliait d'y inscrire - Starlight, les appels de ban -
   * tombait dans « Autre », en bas de page, ou personne ne la cherchait.
   *
   * `content` n'est pas un module du registre mais une clef historique encore
   * presente en base : elle garde sa categorie ici.
   */
  const LEGACY_CATEGORIES: Record<string, string> = {
    content: 'moderation',
  };

  export function featureCategory(featureKey: string): string {
    return getModuleDefinition(featureKey)?.category ?? LEGACY_CATEGORIES[featureKey] ?? 'other';
  }

  export function categoryLabel(id: string): string {
    return (m as any)[`mgmt_cat_${id}`]?.() ?? m.mgmt_cat_other();
  }

  export const categoryIcons: Record<string, string> = Object.fromEntries(
    MODULE_CATEGORIES.map((category) => [category.key, category.icon]),
  );

  export const categoryOrder = MODULE_CATEGORIES.map((category) => category.key);

  export function groupByCategory<T extends { featureKey: string }>(features: T[]) {
    const groups: Array<{ category: string; items: Array<{ feature: T; idx: number }> }> = [];
    const catMap = new Map<string, Array<{ feature: T; idx: number }>>();

    features.forEach((feature, idx) => {
      const cat = featureCategory(feature.featureKey);
      if (!catMap.has(cat)) catMap.set(cat, []);
      catMap.get(cat)!.push({ feature, idx });
    });

    for (const cat of categoryOrder) {
      if (catMap.has(cat)) {
        groups.push({ category: cat, items: catMap.get(cat)! });
        catMap.delete(cat);
      }
    }
    for (const [cat, items] of catMap) {
      groups.push({ category: cat, items });
    }

    return groups;
  }

  /**
   * Etat reel d'une fonctionnalite, cascade des dependances et offre comprises.
   * `DashboardFeatureConfig.enabled` ne les connait pas : s'y fier affichait un
   * module vert alors que la garde de lecture l'eteignait. `null` pour une
   * fonctionnalite qui n'est pas un module du registre - elle n'a pas d'etat.
   */
  export function featureModuleState(modules: Map<string, any>, featureKey: string): boolean | null {
    const mod = modules.get(featureKey);
    return mod ? mod.status === 'active' : null;
  }
</script>

<script lang="ts">
  import Papicon from '../Papicon.svelte';
  import SettingsGroup from './SettingsGroup.svelte';
  import { roleDotColor } from '../../discordVisuals';

  let {
    features = $bindable([]),
    availableRoles = [],
    modules = new Map<string, any>(),
    onApplyPreset = (_preset: string) => {},
  }: {
    features?: any[];
    availableRoles?: any[];
    modules?: Map<string, any>;
    onApplyPreset?: (preset: string) => void | Promise<void>;
  } = $props();

  const PRESETS = [
    { key: 'general', label: () => m.mgmt_preset_general() },
    { key: 'gaming', label: () => m.mgmt_preset_gaming() },
    { key: 'dev', label: () => m.mgmt_preset_dev() },
  ];

  const groupedFeatures = $derived(groupByCategory(features));

  const roleEntries = $derived(
    [...availableRoles].sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
  );

  const permissions = $derived([
    { key: 'canView', label: m.ma_perm_view(), icon: 'Eye', desc: m.ma_perm_view_desc() },
    { key: 'canModerate', label: m.ma_perm_moderate(), icon: 'Gavel', desc: m.ma_perm_moderate_desc() },
    { key: 'canConfigure', label: m.ma_perm_configure(), icon: 'Settings', desc: m.ma_perm_configure_desc() },
    { key: 'canDelete', label: m.ma_perm_delete(), icon: 'Trash', desc: m.ma_perm_delete_desc() },
  ]);

  const VIEWS = [
    { id: 'module', label: () => m.ma_view_by_module() },
    { id: 'role', label: () => m.ma_view_by_role() },
  ];

  let viewMode = $state('module');
  let expandedFeature = $state<string | null>(null);
  let expandedRole = $state<string | null>(null);
  let query = $state('');

  const matches = (feature: any) =>
    !query || moduleName(feature.featureKey, feature.featureName).toLowerCase().includes(query.toLowerCase())
      || feature.featureKey?.toLowerCase().includes(query.toLowerCase());

  const ruleOf = (feature: any, roleId: string) =>
    feature.roleAccessByRole?.find((rule: any) => rule.roleId === roleId) ?? {};

  const grantedCount = (feature: any, roleId: string) =>
    permissions.filter((perm) => ruleOf(feature, roleId)[perm.key]).length;

  /** Aucune regle sur la fonctionnalite : tout le staff la voit. */
  const isOpen = (feature: any) => (feature.roleAccessByRole?.length ?? 0) === 0;

  function togglePermission(featureIdx: number, roleId: string, permKey: string) {
    const feature = features[featureIdx];
    if (!feature.roleAccessByRole) feature.roleAccessByRole = [];

    let rule = feature.roleAccessByRole.find((entry: any) => entry.roleId === roleId);
    if (!rule) {
      rule = { roleId, canView: false, canModerate: false, canConfigure: false, canDelete: false };
      feature.roleAccessByRole.push(rule);
    }
    rule[permKey] = !rule[permKey];
    features = [...features];
  }

  /**
   * Le retrait est un geste a part, et non la consequence d'avoir tout
   * decoche : une regle videe de ses droits ferme la section au role sans
   * rouvrir la fonctionnalite, ce qui est le seul moyen de la reserver aux
   * administrateurs Discord. C'est en retirant la derniere regle qu'on la rend
   * a tout le staff.
   */
  function removeRule(featureIdx: number, roleId: string) {
    const feature = features[featureIdx];
    if (!feature.roleAccessByRole) return;
    feature.roleAccessByRole = feature.roleAccessByRole.filter((entry: any) => entry.roleId !== roleId);
    features = [...features];
  }

  const hasRule = (feature: any, roleId: string) =>
    !!feature.roleAccessByRole?.some((rule: any) => rule.roleId === roleId);

  const ruledFeatureCount = (roleId: string) =>
    features.filter((feature: any) => hasRule(feature, roleId)).length;
</script>

<div class="space-y-6">
  <SettingsGroup title={m.ma_title()} description={m.ma_desc()}>
    {#snippet actions()}
      <div class="flex items-center gap-2">
        <span class="text-xs font-semibold text-on-surface-variant/40 hidden md:inline">
          {m.ma_reset_preset_label()}
        </span>
        {#each PRESETS as preset}
          <button
            type="button"
            onclick={() => onApplyPreset(preset.key)}
            class="px-3 py-1.5 rounded-lg border border-outline-variant/20 hover:bg-surface-container-high transition-colors text-xs font-semibold"
          >
            {preset.label()}
          </button>
        {/each}
      </div>
    {/snippet}

    {#if roleEntries.length === 0}
      <p class="text-body-sm text-warning/90 leading-relaxed">{m.ma_roles_empty()}</p>
    {:else}
      <div class="space-y-4">
        <div class="flex items-center justify-between gap-4 flex-wrap">
          <p class="text-xs text-on-surface-variant">{m.ma_roles_loaded({ count: roleEntries.length })}</p>

          <div class="flex items-center gap-2">
            <div class="flex gap-1 p-1 rounded-lg bg-surface-container-high/40 border border-outline-variant/10">
              {#each VIEWS as view}
                <button
                  type="button"
                  onclick={() => (viewMode = view.id)}
                  aria-pressed={viewMode === view.id}
                  class="px-3 h-7 rounded-md text-2xs font-semibold transition-colors {viewMode === view.id
                    ? 'bg-primary text-on-primary'
                    : 'text-on-surface-variant hover:text-on-surface'}"
                >
                  {view.label()}
                </button>
              {/each}
            </div>

            <label class="relative">
              <span class="sr-only">{m.ma_search_placeholder()}</span>
              <Papicon icon="MagnifyingGlass" size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant/40" />
              <input
                type="text"
                bind:value={query}
                placeholder={m.ma_search_placeholder()}
                class="bg-surface-container-high/40 border border-outline-variant/10 rounded-lg pl-9 pr-4 py-2 text-xs w-56 focus:ring-2 focus:ring-primary/30 transition-all outline-none"
              />
            </label>
          </div>
        </div>

        <dl class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 p-4 rounded-xl border border-outline-variant/10 bg-surface-container-high/10">
          {#each permissions as perm}
            <div class="flex items-start gap-2.5">
              <span class="mt-0.5 text-on-surface-variant shrink-0"><Papicon icon={perm.icon} size={13} /></span>
              <div class="min-w-0">
                <dt class="text-body-sm font-medium text-on-surface">{perm.label}</dt>
                <dd class="text-xs leading-relaxed text-on-surface-variant/75">{perm.desc}</dd>
              </div>
            </div>
          {/each}
        </dl>

        {#if viewMode === 'module'}
          {#each groupedFeatures as group}
            {@const items = group.items.filter(({ feature }) => matches(feature))}
            {#if items.length > 0}
              <section class="space-y-1">
                <p class="flex items-center gap-2 px-1 pt-2 text-xs font-semibold text-on-surface-variant">
                  <Papicon icon={categoryIcons[group.category] || 'Grid'} size={12} />
                  {categoryLabel(group.category)}
                </p>

                <div class="rounded-xl border border-outline-variant/10 divide-y divide-outline-variant/10 overflow-hidden">
                  {#each items as { feature, idx } (feature.featureKey)}
                    {@const expanded = expandedFeature === feature.featureKey}
                    {@const moduleActive = featureModuleState(modules, feature.featureKey)}
                    <div class="bg-surface-container-high/10">
                      <button
                        type="button"
                        class="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-surface-container-high/30 transition-colors text-left"
                        onclick={() => (expandedFeature = expanded ? null : feature.featureKey)}
                      >
                        <span class="flex items-center gap-3 min-w-0">
                          <span class="w-1.5 h-1.5 rounded-full shrink-0 {moduleActive === false ? 'bg-on-surface-variant/30' : 'bg-emerald-500'}"></span>
                          <span class="text-sm font-medium truncate">{moduleName(feature.featureKey, feature.featureName)}</span>
                        </span>
                        <span class="flex items-center gap-3 shrink-0">
                          <span class="text-2xs font-medium {isOpen(feature) ? 'text-on-surface-variant/40' : 'text-primary'}">
                            {isOpen(feature) ? m.ma_state_open() : m.ma_state_restricted()}
                          </span>
                          <span class="transition-transform {expanded ? 'rotate-180' : ''}">
                            <Papicon icon="CaretDown" size={14} />
                          </span>
                        </span>
                      </button>

                      {#if expanded}
                        <div class="px-4 pb-4 space-y-3">
                          <p class="text-xs text-on-surface-variant leading-relaxed">
                            {isOpen(feature) ? m.ma_hint_open() : m.ma_hint_restricted()}
                          </p>
                          <div class="overflow-x-auto">
                            <table class="w-full text-left border-collapse min-w-[26rem]">
                              <thead>
                                <tr class="text-2xs font-medium text-on-surface-variant">
                                  <th class="py-2 pr-4 font-medium">{m.ma_col_role()}</th>
                                  {#each permissions as perm}
                                    <th class="py-2 px-2 text-center font-medium" title={perm.desc}>
                                      <span class="inline-flex items-center gap-1"><Papicon icon={perm.icon} size={11} /> {perm.label}</span>
                                    </th>
                                  {/each}
                                  <th class="py-2 pl-2 font-medium"><span class="sr-only">{m.ma_remove_rule()}</span></th>
                                </tr>
                              </thead>
                              <tbody class="divide-y divide-outline-variant/5">
                                {#each roleEntries as role}
                                  {@const rule = ruleOf(feature, role.id)}
                                  <tr>
                                    <td class="py-2 pr-4">
                                      <span class="inline-flex items-center gap-2">
                                        <span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background-color:{roleDotColor(role.color)}"></span>
                                        <span class="text-body-sm font-medium">{role.name}</span>
                                      </span>
                                      <span class="ml-2 text-2xs text-on-surface-variant/40">{grantedCount(feature, role.id)}/{permissions.length}</span>
                                    </td>
                                    {#each permissions as perm}
                                      <td class="py-2 px-2 text-center">
                                        <button
                                          type="button"
                                          aria-label="{role.name} - {perm.label}"
                                          aria-pressed={!!rule[perm.key]}
                                          onclick={() => togglePermission(idx, role.id, perm.key)}
                                          class="w-7 h-7 rounded-lg inline-flex items-center justify-center transition-all {rule[perm.key] ? 'bg-success/20 text-success hover:bg-success/30' : 'bg-surface-container-high/40 text-on-surface-variant/30 hover:bg-surface-container-high/70'}"
                                        >
                                          <Papicon icon={rule[perm.key] ? 'Check' : 'X'} size={12} />
                                        </button>
                                      </td>
                                    {/each}
                                    <td class="py-2 pl-2 text-right">
                                      {#if hasRule(feature, role.id)}
                                        <button
                                          type="button"
                                          onclick={() => removeRule(idx, role.id)}
                                          class="text-2xs font-medium text-on-surface-variant hover:text-error transition-colors"
                                        >
                                          {m.ma_remove_rule()}
                                        </button>
                                      {/if}
                                    </td>
                                  </tr>
                                {/each}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      {/if}
                    </div>
                  {/each}
                </div>
              </section>
            {/if}
          {/each}
        {:else}
          <div class="rounded-xl border border-outline-variant/10 divide-y divide-outline-variant/10 overflow-hidden">
            {#each roleEntries as role (role.id)}
              {@const expanded = expandedRole === role.id}
              {@const ruled = ruledFeatureCount(role.id)}
              <div class="bg-surface-container-high/10">
                <button
                  type="button"
                  class="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-surface-container-high/30 transition-colors text-left"
                  onclick={() => (expandedRole = expanded ? null : role.id)}
                >
                  <span class="flex items-center gap-3 min-w-0">
                    <span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background-color:{roleDotColor(role.color)}"></span>
                    <span class="text-sm font-medium truncate">{role.name}</span>
                  </span>
                  <span class="flex items-center gap-3 shrink-0">
                    <span class="text-2xs font-medium {ruled > 0 ? 'text-primary' : 'text-on-surface-variant/40'}">
                      {ruled > 0 ? m.ma_role_ruled_count({ count: ruled }) : m.ma_role_no_rule()}
                    </span>
                    <span class="transition-transform {expanded ? 'rotate-180' : ''}">
                      <Papicon icon="CaretDown" size={14} />
                    </span>
                  </span>
                </button>

                {#if expanded}
                  <div class="px-4 pb-4 space-y-3">
                    <p class="text-xs text-on-surface-variant leading-relaxed">{m.ma_role_hint()}</p>
                    <div class="overflow-x-auto">
                      <table class="w-full text-left border-collapse min-w-[26rem]">
                        <thead>
                          <tr class="text-2xs font-medium text-on-surface-variant">
                            <th class="py-2 pr-4 font-medium">{m.ma_col_module()}</th>
                            {#each permissions as perm}
                              <th class="py-2 px-2 text-center font-medium" title={perm.desc}>
                                <span class="inline-flex items-center gap-1"><Papicon icon={perm.icon} size={11} /> {perm.label}</span>
                              </th>
                            {/each}
                            <th class="py-2 pl-2 font-medium"><span class="sr-only">{m.ma_remove_rule()}</span></th>
                          </tr>
                        </thead>

                        {#each groupedFeatures as group}
                          {@const items = group.items.filter(({ feature }) => matches(feature))}
                          {#if items.length > 0}
                            <tbody class="divide-y divide-outline-variant/5">
                              <tr>
                                <th colspan={permissions.length + 2} class="pt-4 pb-1 text-left">
                                  <span class="flex items-center gap-2 text-xs font-semibold text-on-surface-variant">
                                    <Papicon icon={categoryIcons[group.category] || 'Grid'} size={12} />
                                    {categoryLabel(group.category)}
                                  </span>
                                </th>
                              </tr>

                              {#each items as { feature, idx } (feature.featureKey)}
                                {@const rule = ruleOf(feature, role.id)}
                                {@const moduleActive = featureModuleState(modules, feature.featureKey)}
                                <tr>
                                  <td class="py-2 pr-4">
                                    <span class="inline-flex items-center gap-2">
                                      <span class="w-1.5 h-1.5 rounded-full shrink-0 {moduleActive === false ? 'bg-on-surface-variant/30' : 'bg-emerald-500'}"></span>
                                      <span class="text-body-sm font-medium">{moduleName(feature.featureKey, feature.featureName)}</span>
                                    </span>
                                    {#if isOpen(feature)}
                                      <span class="ml-2 text-2xs text-on-surface-variant/40">{m.ma_state_open()}</span>
                                    {/if}
                                  </td>
                                  {#each permissions as perm}
                                    <td class="py-2 px-2 text-center">
                                      <button
                                        type="button"
                                        aria-label="{moduleName(feature.featureKey, feature.featureName)} - {perm.label}"
                                        aria-pressed={!!rule[perm.key]}
                                        onclick={() => togglePermission(idx, role.id, perm.key)}
                                        class="w-7 h-7 rounded-lg inline-flex items-center justify-center transition-all {rule[perm.key] ? 'bg-success/20 text-success hover:bg-success/30' : 'bg-surface-container-high/40 text-on-surface-variant/30 hover:bg-surface-container-high/70'}"
                                      >
                                        <Papicon icon={rule[perm.key] ? 'Check' : 'X'} size={12} />
                                      </button>
                                    </td>
                                  {/each}
                                  <td class="py-2 pl-2 text-right">
                                    {#if hasRule(feature, role.id)}
                                      <button
                                        type="button"
                                        onclick={() => removeRule(idx, role.id)}
                                        class="text-2xs font-medium text-on-surface-variant hover:text-error transition-colors"
                                      >
                                        {m.ma_remove_rule()}
                                      </button>
                                    {/if}
                                  </td>
                                </tr>
                              {/each}
                            </tbody>
                          {/if}
                        {/each}
                      </table>
                    </div>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </SettingsGroup>
</div>
