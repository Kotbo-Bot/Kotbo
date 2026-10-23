<script lang="ts">
  import { explainDisabled } from '../actions/explainDisabled';
  import Papicon from './Papicon.svelte';
  import { m } from '../i18n';
  import {
    AUTOMOD_PRESETS,
    AUTOMOD_FILTER_TOTAL,
    automodActiveFilterCount,
    type AutomodPreset,
    type AutomodFilterValues,
    type AutomodRaidValues,
  } from '@kotbo/shared';

  const {
    selectedId = null,
    activeId = null,
    customFilters,
    customRaid,
    disabled = false,
    dirty = false,
    saving = false,
    onselect,
    onsave,
    ondetail,
  }: {
    selectedId?: string | null;
    activeId?: string | null;
    /** Reglages hors prereglage a montrer sur la carte « Personnalise ». */
    customFilters: Partial<AutomodFilterValues>;
    customRaid: Partial<AutomodRaidValues>;
    disabled?: boolean;
    dirty?: boolean;
    saving?: boolean;
    onselect: (preset: AutomodPreset) => void;
    onsave: () => void;
    /** Ouvre la configuration detaillee : seule action de la carte « Personnalise ». */
    ondetail: () => void;
  } = $props();

  // Un prereglage ajoute sans sa traduction doit afficher une carte muette,
  // pas faire tomber la page entiere sur un appel de fonction absente.
  const PRESET_LABELS: Record<string, { name: () => string; desc: () => string }> = {
    light: { name: m.am_preset_light_name, desc: m.am_preset_light_desc },
    standard: { name: m.am_preset_standard_name, desc: m.am_preset_standard_desc },
    strict: { name: m.am_preset_strict_name, desc: m.am_preset_strict_desc },
  };

  type PresetCard = {
    key: string;
    icon: string;
    name: string;
    desc: string;
    filters: Partial<AutomodFilterValues>;
    raid: Partial<AutomodRaidValues>;
    recommended: boolean;
    /** `null` sur la carte « Personnalise » : il n'y a aucune valeur a appliquer. */
    preset: AutomodPreset | null;
  };

  const cards = $derived<PresetCard[]>([
    ...AUTOMOD_PRESETS.map((preset) => ({
      key: preset.id,
      icon: preset.icon,
      name: PRESET_LABELS[preset.id]?.name() ?? preset.id,
      desc: PRESET_LABELS[preset.id]?.desc() ?? '',
      filters: preset.filters as Partial<AutomodFilterValues>,
      raid: preset.raid as Partial<AutomodRaidValues>,
      recommended: !!preset.recommended,
      preset,
    })),
    {
      key: 'custom',
      icon: 'Settings',
      name: m.am_preset_custom_name(),
      desc: m.am_preset_custom_desc(),
      filters: customFilters,
      raid: customRaid,
      recommended: false,
      preset: null,
    },
  ]);

  // Libelles courts : les intitules des onglets (« Exclusion temporaire (Mute
  // 10 min) ») debordent d'une tuile de carte.
  const SPAM_ACTIONS: Record<string, () => string> = {
    WARN: m.am_presets_sanction_warn,
    TIMEOUT: m.am_presets_sanction_timeout,
  };

  function spamSummary(filters: Partial<AutomodFilterValues>): string {
    if (!filters.spamEnabled) return m.am_presets_tile_off();
    return `${filters.spamLimit} / ${filters.spamIntervalSeconds} s`;
  }

  function raidSummary(raid: Partial<AutomodRaidValues>): string {
    if (!raid.antiRaidEnabled) return m.am_presets_tile_off();
    return m.am_presets_tile_joins({ count: raid.antiRaidJoinThreshold ?? 0, seconds: raid.antiRaidJoinWindowSec ?? 0 });
  }

  function sanctionSummary(filters: Partial<AutomodFilterValues>): string {
    if (!filters.spamEnabled) return m.am_presets_tile_off();
    return SPAM_ACTIONS[filters.spamAction ?? '']?.() ?? (filters.spamAction ?? '');
  }

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
    <h2 class="text-2xl font-semibold text-on-surface font-headline">{m.am_presets_title()}</h2>
    <p class="text-sm text-on-surface-variant">{m.am_presets_desc()}</p>
  </div>

  <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-5">
    {#each cards as card (card.key)}
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
              {m.am_presets_active()}
            </span>
          {:else if selected}
            <span class="shrink-0 text-xs font-semibold px-2 py-1 rounded-lg bg-primary/15 text-primary">
              {m.am_presets_selected()}
            </span>
          {:else if card.recommended}
            <span class="shrink-0 text-xs font-semibold px-2 py-1 rounded-lg border border-primary/30 text-primary/80">
              {m.am_presets_recommended()}
            </span>
          {/if}
        </div>

        <p class="text-body-sm text-on-surface-variant mt-3 leading-relaxed">{card.desc}</p>

        {#if detailed}
          <div class="grid grid-cols-2 gap-2.5 mt-5 mb-1">
            <div class="px-3 py-2 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
              <p class="text-xs font-semibold text-on-surface-variant">{m.am_presets_tile_filters()}</p>
              <p class="text-sm font-semibold text-on-surface">{automodActiveFilterCount(card.filters, card.raid)} / {AUTOMOD_FILTER_TOTAL}</p>
            </div>
            <div class="px-3 py-2 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
              <p class="text-xs font-semibold text-on-surface-variant">{m.am_presets_tile_spam()}</p>
              <p class="text-sm font-semibold text-on-surface">{spamSummary(card.filters)}</p>
            </div>
            <div class="px-3 py-2 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
              <p class="text-xs font-semibold text-on-surface-variant">{m.am_presets_tile_sanction()}</p>
              <p class="text-sm font-semibold text-on-surface">{sanctionSummary(card.filters)}</p>
            </div>
            <div class="px-3 py-2 bg-surface-container-high/20 border border-outline-variant/5 rounded-lg">
              <p class="text-xs font-semibold text-on-surface-variant">{m.am_presets_tile_raid()}</p>
              <p class="text-sm font-semibold text-on-surface">{raidSummary(card.raid)}</p>
            </div>
          </div>
        {/if}

        <!-- La seule action de la carte « Personnalise », donc toujours
             affichee : elle disparaissait des que les reglages en place ne
             collaient a aucun prereglage - le cas ou l'on va justement les
             regler en detail - et la carte devenait un pave qui navigue sans
             prevenir. -->
        {#if !card.preset}
          <p class="flex items-center gap-1.5 mt-4 text-body-sm font-semibold text-primary/80">
            {m.am_presets_open_advanced()}
            <Papicon icon="ArrowRight" size={14} />
          </p>
        {/if}
      </button>
    {/each}
  </div>

  <p class="text-2xs text-on-surface-variant text-center max-w-2xl mx-auto">{m.am_presets_untouched()}</p>

  <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-surface-container-low/30 border border-outline-variant/10 rounded-xl px-6 py-5">
    <p class="text-body-sm text-on-surface-variant">
      <!-- Le bouton est desactive tant que rien n'a bouge : sans ce cas, la
           phrase promettait un enregistrement impossible a declencher. -->
      {#if !dirty}
        {m.am_presets_already_saved()}
      {:else}
        {m.am_presets_save_hint()}
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
      {m.am_presets_save()}
    </button>
  </div>
</div>
