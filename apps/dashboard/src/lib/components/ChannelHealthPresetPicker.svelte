<script lang="ts">
  import { explainDisabled } from '../actions/explainDisabled';
  import Papicon from './Papicon.svelte';
  import { m } from '../i18n';
  import {
    CHANNEL_HEALTH_PRESETS,
    type ChannelHealthPreset,
    type ChannelHealthPresetValues,
  } from '../channelHealthPresets';

  const {
    selectedId = null,
    activeId = null,
    customValues = null,
    disabled = false,
    dirty = false,
    saving = false,
    moduleEnabled = true,
    onselect,
    onsave,
    ondetail,
  }: {
    /**
     * Identifiant du prereglage choisi, `'custom'` pour des seuils regles a la
     * main, `null` tant que le module n'a jamais ete configure : aucune carte
     * n'est alors marquee.
     */
    selectedId?: string | null;
    /** Meme convention, pour la configuration effectivement enregistree. */
    activeId?: string | null;
    /**
     * Valeurs hors prereglage a montrer sur la carte « Personnalise ».
     * `null` tant que le module n'a jamais ete configure : il n'y a alors aucun
     * seuil a afficher.
     */
    customValues?: ChannelHealthPresetValues | null;
    disabled?: boolean;
    dirty?: boolean;
    saving?: boolean;
    moduleEnabled?: boolean;
    onselect: (preset: ChannelHealthPreset) => void;
    onsave: () => void;
    /** Ouvre la configuration detaillee : seule action de la carte « Personnalise ». */
    ondetail: () => void;
  } = $props();

  // Un prereglage ajoute sans sa traduction doit afficher une carte muette,
  // pas faire tomber la page entiere sur un appel de fonction absente.
  const PRESET_LABELS: Record<string, { name: () => string; desc: () => string }> = {
    lenient: { name: m.ch_preset_lenient_name, desc: m.ch_preset_lenient_desc },
    balanced: { name: m.ch_preset_balanced_name, desc: m.ch_preset_balanced_desc },
    strict: { name: m.ch_preset_strict_name, desc: m.ch_preset_strict_desc },
  };

  type PresetCard = {
    key: string;
    icon: string;
    name: string;
    desc: string;
    values: ChannelHealthPresetValues | null;
    recommended: boolean;
    /** `null` sur la carte « Personnalise » : il n'y a aucune valeur a appliquer. */
    preset: ChannelHealthPreset | null;
  };

  const cards = $derived<PresetCard[]>([
    ...CHANNEL_HEALTH_PRESETS.map((preset) => ({
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
      name: m.ch_preset_custom_name(),
      desc: m.ch_preset_custom_desc(),
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
    <h2 class="text-2xl font-semibold text-on-surface font-headline">{m.ch_presets_title()}</h2>
    <p class="text-sm text-on-surface-variant">{m.ch_presets_desc()}</p>
  </div>

  {#if !moduleEnabled}
    <p class="text-xs text-on-surface-variant bg-surface-container-high/30 border border-outline-variant/10 rounded-lg px-4 py-3 text-center">
      {m.ch_presets_module_off()}
    </p>
  {/if}

  <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-5">
    {#each cards as card (card.key)}
      {@const values = card.values}
      {@const selected = selectedId === card.key}
      {@const active = activeId === card.key}
      <!-- La carte « Personnalise » ni choisie ni active n'a pas de valeurs a
           montrer : elle repeterait celles du prereglage en cours. -->
      {@const detailed = !!values && (!!card.preset || active || selected)}
      <!-- La carte « Personnalise » choisie montre les valeurs en attente, pas
           celles qui tournent : elle ne peut pas se dire « active » tant qu'un
           enregistrement reste a faire. -->
      {@const running = active && !(!card.preset && selected && dirty)}
      <!-- La carte « Personnalise » reste cliquable meme sans droit de
           modification : elle ne fait que naviguer vers l'onglet detaille. -->
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
              {m.ch_presets_active()}
            </span>
          {:else if selected}
            <span class="shrink-0 text-xs font-semibold px-2 py-1 rounded-lg bg-primary/15 text-primary">
              {m.ch_presets_selected()}
            </span>
          {:else if card.recommended}
            <span class="shrink-0 text-xs font-semibold px-2 py-1 rounded-lg border border-primary/30 text-primary/80">
              {m.ch_presets_recommended()}
            </span>
          {/if}
        </div>

        <p class="text-body-sm text-on-surface-variant mt-3 leading-relaxed">{card.desc}</p>

        {#if detailed && values}
          <div class="grid grid-cols-2 gap-2.5 mt-5">
            <div class="px-3 py-2 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
              <p class="text-xs font-semibold text-on-surface-variant">{m.ch_presets_tile_period()}</p>
              <p class="text-sm font-semibold text-on-surface">{m.ch_presets_days({ days: values.analysisPeriodDays })}</p>
            </div>
            <div class="px-3 py-2 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
              <p class="text-xs font-semibold text-on-surface-variant">{m.ch_presets_tile_overload()}</p>
              <p class="text-sm font-semibold text-on-surface">≥ {m.ch_presets_msg_per_day({ count: values.overloadMsgPerHour })}</p>
            </div>
            <div class="px-3 py-2 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
              <p class="text-xs font-semibold text-on-surface-variant">{m.ch_presets_tile_underused()}</p>
              <p class="text-sm font-semibold text-on-surface">≤ {m.ch_presets_msg_per_day({ count: values.underusedMsgPerDay })}</p>
            </div>
            <div class="px-3 py-2 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
              <p class="text-xs font-semibold text-on-surface-variant">{m.ch_presets_tile_dead()}</p>
              <p class="text-sm font-semibold text-on-surface">≤ {m.ch_presets_msg_per_week({ count: values.deadMsgPerWeek })}</p>
            </div>
          </div>

          <p class="text-2xs text-on-surface-variant mt-3">
            {m.ch_presets_users_note({
              overload: values.overloadUniqueUsers,
              underused: values.underusedUniqueUsers,
            })}
          </p>
        {:else}
          <p class="flex items-center gap-1.5 mt-5 text-body-sm font-semibold text-primary/80">
            {m.ch_presets_open_advanced()}
            <Papicon icon="arrow-right" size={14} />
          </p>
        {/if}
      </button>
    {/each}
  </div>

  <p class="text-2xs text-on-surface-variant text-center">{m.ch_presets_scope_note()}</p>

  <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-surface-container-low/30 border border-outline-variant/10 rounded-xl px-6 py-5">
    <p class="text-body-sm text-on-surface-variant">
      <!-- Le bouton est desactive tant que rien n'a bouge : sans ce cas, la
           phrase promettait un enregistrement impossible a declencher. -->
      {#if !dirty}
        {m.ch_presets_already_saved()}
      {:else}
        {m.ch_presets_save_hint()}
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
      {m.ch_presets_save()}
    </button>
  </div>
</div>
