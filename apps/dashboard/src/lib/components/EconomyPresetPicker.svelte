<script lang="ts">
  import { explainDisabled } from '../actions/explainDisabled';
  import Papicon from './Papicon.svelte';
  import { m } from '../i18n';
  import {
    ECONOMY_PRESETS,
    economyDailyCoins,
    economyEnergyRefillHours,
    type EconomyPreset,
    type EconomyPresetValues,
  } from '../economyPresets';

  const {
    selectedId = null,
    activeId = null,
    customValues,
    currencyName = '',
    disabled = false,
    dirty = false,
    saving = false,
    moduleEnabled = true,
    onselect,
    onsave,
    ondetail,
  }: {
    selectedId?: string | null;
    activeId?: string | null;
    /** Valeurs hors prereglage a montrer sur la carte « Personnalise ». */
    customValues: EconomyPresetValues;
    currencyName?: string;
    disabled?: boolean;
    dirty?: boolean;
    saving?: boolean;
    moduleEnabled?: boolean;
    onselect: (preset: EconomyPreset) => void;
    onsave: () => void;
    /** Ouvre la configuration detaillee : seule action de la carte « Personnalise ». */
    ondetail: () => void;
  } = $props();

  // Un prereglage ajoute sans sa traduction doit afficher une carte muette,
  // pas faire tomber la page entiere sur un appel de fonction absente.
  const PRESET_LABELS: Record<string, { name: () => string; desc: () => string }> = {
    calm: { name: m.eco_preset_calm_name, desc: m.eco_preset_calm_desc },
    standard: { name: m.eco_preset_standard_name, desc: m.eco_preset_standard_desc },
    generous: { name: m.eco_preset_generous_name, desc: m.eco_preset_generous_desc },
  };

  type PresetCard = {
    key: string;
    icon: string;
    name: string;
    desc: string;
    values: EconomyPresetValues;
    recommended: boolean;
    /** `null` sur la carte « Personnalise » : il n'y a aucune valeur a appliquer. */
    preset: EconomyPreset | null;
  };

  const cards = $derived<PresetCard[]>([
    ...ECONOMY_PRESETS.map((preset) => ({
      key: preset.id,
      icon: preset.icon,
      name: PRESET_LABELS[preset.id]?.name() ?? preset.id,
      desc: PRESET_LABELS[preset.id]?.desc() ?? '',
      values: preset.values,
      recommended: !!preset.recommended,
      preset,
    })),
    {
      key: 'custom',
      icon: 'Settings',
      name: m.eco_preset_custom_name(),
      desc: m.eco_preset_custom_desc(),
      values: customValues,
      recommended: false,
      preset: null,
    },
  ]);

  // La carte enregistree garde un contour, la carte choisie un fond plein :
  // l'ecart entre « ce qui tourne » et « ce qui remplacera » reste lisible.
  function cardTone(card: PresetCard, selected: boolean, active: boolean): string {
    const outline = card.preset ? '' : ' border-dashed';
    if (selected) return 'bg-primary/8 border-primary/50 shadow-lg shadow-primary/10' + outline;
    if (active) return 'bg-surface-container-low/30 border-tertiary/40 hover:border-tertiary/60 hover:bg-surface-container-high/20' + outline;
    if (card.preset) return 'bg-surface-container-low/30 border-outline-variant/10 hover:border-outline-variant/30 hover:bg-surface-container-high/20';
    return 'bg-surface-container-low/20 border-outline-variant/25 hover:border-outline-variant/40 hover:bg-surface-container-high/20' + outline;
  }
</script>

<div class="space-y-8 animate-in fade-in duration-300">
  <div class="text-center max-w-2xl mx-auto space-y-2">
    <h2 class="text-2xl font-semibold text-on-surface font-headline">{m.eco_presets_title()}</h2>
    <p class="text-sm text-on-surface-variant">{m.eco_presets_desc()}</p>
  </div>

  {#if !moduleEnabled}
    <p class="text-xs text-on-surface-variant bg-surface-container-high/30 border border-outline-variant/10 rounded-lg px-4 py-3 text-center">
      {m.eco_presets_module_off()}
    </p>
  {/if}

  <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-5">
    {#each cards as card (card.key)}
      {@const values = card.values}
      {@const selected = card.preset ? selectedId === card.preset.id : selectedId === null}
      {@const active = card.preset ? activeId === card.preset.id : activeId === null}
      <!-- La carte « Personnalise » inactive n'a pas de valeurs a montrer :
           elle repeterait celles du prereglage en cours. -->
      {@const detailed = !!card.preset || active}
      <!-- La carte « Personnalise » choisie montre les valeurs en attente, pas
           celles qui tournent : elle ne peut pas se dire « active » tant qu'un
           enregistrement reste a faire. -->
      {@const running = active && !(!card.preset && selected && dirty)}
      <!-- Le liseré et la teinte ne marquent que le préréglage choisi. Le
           recommandé se signale par son seul badge. La carte « Personnalise »
           reste cliquable sans droit de modification : elle ne fait que
           naviguer. -->
      <button
        type="button"
        onclick={() => (card.preset ? onselect(card.preset) : ondetail())}
        disabled={!!card.preset && disabled}
        aria-pressed={card.preset ? selected : undefined}
        class="relative overflow-hidden text-left p-6 rounded-xl border transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed {cardTone(card, selected, active)}"
      >
        {#if selected}
          <span class="absolute inset-x-0 top-0 h-[3px] bg-primary" aria-hidden="true"></span>
        {/if}

        <div class="flex items-start justify-between gap-3">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-9 h-9 shrink-0 rounded-lg flex items-center justify-center {selected ? 'bg-primary/15' : 'bg-surface-container-high/40'}">
              <Papicon icon={card.icon} size={18} class={selected ? 'text-primary' : 'text-on-surface-variant'} />
            </div>
            <h3 class="text-base font-semibold text-on-surface truncate">{card.name}</h3>
          </div>
          {#if running}
            <span class="shrink-0 text-xs font-semibold px-2 py-1 rounded-lg bg-tertiary/15 text-tertiary">
              {m.eco_presets_active()}
            </span>
          {:else if selected}
            <span class="shrink-0 text-xs font-semibold px-2 py-1 rounded-lg bg-primary/15 text-primary">
              {m.eco_presets_selected()}
            </span>
          {:else if card.recommended}
            <span class="shrink-0 text-xs font-semibold px-2 py-1 rounded-lg border border-primary/30 text-primary/80">
              {m.eco_presets_recommended()}
            </span>
          {/if}
        </div>

        <p class="text-body-sm text-on-surface-variant mt-3 leading-relaxed">{card.desc}</p>

        {#if detailed}
          <div class="grid grid-cols-2 gap-2.5 mt-5">
            <div class="px-3 py-2 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
              <p class="text-xs font-semibold text-on-surface-variant">{m.eco_presets_tile_daily()}</p>
              <p class="text-sm font-semibold text-on-surface">{values.dailyRewardMin} – {values.dailyRewardMax}</p>
            </div>
            <div class="px-3 py-2 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
              <p class="text-xs font-semibold text-on-surface-variant">{m.eco_presets_tile_cooldown()}</p>
              <p class="text-sm font-semibold text-on-surface">{values.dailyCooldownHour} h</p>
            </div>
            <div class="px-3 py-2 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
              <p class="text-xs font-semibold text-on-surface-variant">{m.eco_presets_tile_per_day()}</p>
              <p class="text-sm font-semibold text-on-surface">≈ {economyDailyCoins(values).toLocaleString()}</p>
            </div>
            <div class="px-3 py-2 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
              <p class="text-xs font-semibold text-on-surface-variant">{m.eco_presets_tile_energy()}</p>
              <p class="text-sm font-semibold text-on-surface">{values.maxEnergy} · {m.eco_presets_energy_refill({ hours: economyEnergyRefillHours(values) })}</p>
            </div>
          </div>

          <p class="text-2xs text-on-surface-variant mt-3">
            {m.eco_presets_adventure({ minutes: values.adventureCooldownMin })}
          </p>
        {:else}
          <p class="flex items-center gap-1.5 mt-5 text-body-sm font-semibold text-primary/80">
            {m.eco_presets_open_advanced()}
            <Papicon icon="ArrowRight" size={14} />
          </p>
        {/if}
      </button>
    {/each}
  </div>

  {#if currencyName}
    <p class="text-2xs text-on-surface-variant text-center">{m.eco_presets_currency_note({ currency: currencyName })}</p>
  {/if}

  <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-surface-container-low/30 border border-outline-variant/10 rounded-xl px-6 py-5">
    <p class="text-body-sm text-on-surface-variant">
      <!-- Le bouton est desactive tant que rien n'a bouge : sans ce cas, la
           phrase promettait un enregistrement impossible a declencher. -->
      {#if !dirty}
        {m.eco_presets_already_saved()}
      {:else}
        {m.eco_presets_save_hint()}
      {/if}
    </p>
    <button
      type="button"
      onclick={onsave}
      disabled={disabled || saving}
      use:explainDisabled={(!dirty) ? m.common_reason_no_changes() : ''}
      class="shrink-0 px-6 py-3 bg-primary hover:bg-primary/90 text-on-primary text-body-sm font-medium rounded-lg shadow-md shadow-primary/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none flex items-center justify-center gap-2"
    >
      <Papicon icon="Check" size={16} />
      {m.eco_presets_save()}
    </button>
  </div>
</div>
