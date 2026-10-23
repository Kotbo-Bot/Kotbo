<script lang="ts">
  import { explainDisabled } from '../actions/explainDisabled';
  /**
   * Grille de prereglages du classement de prestige.
   *
   * Meme forme que `LevelingPresetPicker` : une carte par preregle, une carte
   * « Personnalise » qui ouvre la configuration detaillee, et un bandeau
   * d'enregistrement. Les deux pages se lisent donc de la meme facon, ce qui est
   * le but - le prestige se regle comme les niveaux.
   */
  import Papicon from './Papicon.svelte';
  import { m } from '../i18n';
  import {
    RANKED_PRESETS,
    rankedPresetValues,
    rankedValuesApexRp,
    type RankedPreset,
    type RankedPresetValues,
  } from '@kotbo/shared';

  const {
    selectedId = null,
    activeId = null,
    customValues,
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
    /** Valeurs hors preregle a montrer sur la carte « Personnalise ». */
    customValues: RankedPresetValues;
    disabled?: boolean;
    dirty?: boolean;
    saving?: boolean;
    moduleEnabled?: boolean;
    onselect: (preset: RankedPreset) => void;
    onsave: () => void;
    /** Ouvre la configuration detaillee : seule action de la carte « Personnalise ». */
    ondetail: () => void;
  } = $props();

  // Un preregle ajoute sans sa traduction doit afficher une carte muette, pas
  // faire tomber la page entiere sur un appel de fonction absente.
  const PRESET_LABELS: Record<string, { name: () => string; desc: () => string }> = {
    classic: { name: m.prg_preset_classic_name, desc: m.prg_preset_classic_desc },
    sprint: { name: m.prg_preset_sprint_name, desc: m.prg_preset_sprint_desc },
    esport: { name: m.prg_preset_esport_name, desc: m.prg_preset_esport_desc },
    compact: { name: m.prg_preset_compact_name, desc: m.prg_preset_compact_desc },
    marathon: { name: m.prg_preset_marathon_name, desc: m.prg_preset_marathon_desc },
  };

  type PresetCard = {
    key: string;
    icon: string;
    name: string;
    desc: string;
    values: RankedPresetValues;
    recommended: boolean;
    /** `null` sur la carte « Personnalise » : il n'y a aucune valeur a appliquer. */
    preset: RankedPreset | null;
  };

  const cards = $derived<PresetCard[]>([
    ...RANKED_PRESETS.map((preset) => ({
      key: preset.id,
      icon: preset.icon,
      name: PRESET_LABELS[preset.id]?.name() ?? preset.id,
      desc: PRESET_LABELS[preset.id]?.desc() ?? '',
      values: rankedPresetValues(preset),
      recommended: !!preset.recommended,
      preset,
    })),
    {
      key: 'custom',
      icon: 'Settings',
      name: m.prg_preset_custom_name(),
      desc: m.prg_preset_custom_desc(),
      values: customValues,
      recommended: false,
      preset: null,
    },
  ]);

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
    <h2 class="text-2xl font-semibold text-on-surface font-headline">{m.prg_presets_title()}</h2>
    <p class="text-sm text-on-surface-variant">{m.prg_presets_desc()}</p>
  </div>

  {#if !moduleEnabled}
    <p class="text-xs text-on-surface-variant bg-surface-container-high/30 border border-outline-variant/10 rounded-lg px-4 py-3 text-center">
      {m.prg_presets_module_off()}
    </p>
  {/if}

  <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
    {#each cards as card (card.key)}
      {@const values = card.values}
      {@const selected = card.preset ? selectedId === card.preset.id : selectedId === null}
      {@const active = card.preset ? activeId === card.preset.id : activeId === null}
      {@const detailed = !!card.preset || active}
      {@const running = active && !(!card.preset && selected && dirty)}
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
              {m.prg_presets_active()}
            </span>
          {:else if selected}
            <span class="shrink-0 text-xs font-semibold px-2 py-1 rounded-lg bg-primary/15 text-primary">
              {m.prg_presets_selected()}
            </span>
          {:else if card.recommended}
            <span class="shrink-0 text-xs font-semibold px-2 py-1 rounded-lg border border-primary/30 text-primary/80">
              {m.prg_presets_recommended()}
            </span>
          {/if}
        </div>

        <p class="text-body-sm text-on-surface-variant mt-3 leading-relaxed">{card.desc}</p>

        {#if detailed}
          <div class="grid grid-cols-2 gap-2.5 mt-5">
            <div class="px-3 py-2 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
              <p class="text-xs font-semibold text-on-surface-variant">{m.prg_tile_rp_per_xp()}</p>
              <p class="text-sm font-semibold text-on-surface">×{values.rpPerXp}</p>
            </div>
            <div class="px-3 py-2 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
              <p class="text-xs font-semibold text-on-surface-variant">{m.prg_tile_tiers()}</p>
              <p class="text-sm font-semibold text-on-surface">{values.ladderTierCount}</p>
            </div>
            <div class="px-3 py-2 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
              <p class="text-xs font-semibold text-on-surface-variant">{m.prg_tile_apex()}</p>
              <p class="text-sm font-semibold text-on-surface">{rankedValuesApexRp(values).toLocaleString()} RP</p>
            </div>
            <div class="px-3 py-2 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
              <p class="text-xs font-semibold text-on-surface-variant">{m.prg_tile_decay()}</p>
              <p class="text-sm font-semibold text-on-surface">{values.decayEnabled ? m.prg_tile_decay_on() : m.prg_tile_decay_off()}</p>
            </div>
          </div>

          <p class="text-2xs text-on-surface-variant mt-3">
            {values.ladderDivisions > 1
              ? m.prg_presets_divisions({ count: values.ladderDivisions })
              : m.prg_presets_no_divisions()}
          </p>
        {:else}
          <p class="flex items-center gap-1.5 mt-5 text-body-sm font-semibold text-primary/80">
            {m.prg_presets_open_advanced()}
            <Papicon icon="ArrowRight" size={14} />
          </p>
        {/if}
      </button>
    {/each}
  </div>

  <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-surface-container-low/30 border border-outline-variant/10 rounded-xl px-6 py-5">
    <p class="text-body-sm text-on-surface-variant">
      {#if !dirty}
        {m.prg_presets_already_saved()}
      {:else}
        {m.prg_presets_save_hint()}
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
      {m.prg_presets_save()}
    </button>
  </div>
</div>
