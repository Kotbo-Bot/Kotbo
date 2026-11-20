<!--
  Curseur à deux poignées pour une fourchette de montants (minimum, maximum).

  Il avance par paliers ronds (voir `amountScale`) et ne remplace pas la saisie :
  les champs placés à côté acceptent toute valeur, et le curseur se cale alors sur
  le palier le plus proche sans toucher à la valeur saisie. Seul un déplacement de
  poignée réécrit le montant.

  Deux `input type="range"` superposés : chacun garde le clavier et le nom
  accessible natifs. La piste ne capte pas les clics, seules les poignées le font.

  La barre entre les poignées se saisit aussi : glissée à la souris ou au doigt,
  ou poussée aux flèches une fois sélectionnée, elle déplace toute la fourchette
  sans changer son écart.
-->
<script lang="ts">
  import { amountSteps, nearestStepIndex, orderedAmounts, shiftedRange } from '../amountScale';
  import { dateLocale } from '../i18n';

  let {
    range,
    min = $bindable(),
    max = $bindable(),
    labelMin,
    labelMax,
    labelRange,
    disabled = false,
  }: {
    range: { min: number; max: number };
    min: number;
    max: number;
    labelMin: string;
    labelMax: string;
    /** Nom de la barre qui déplace toute la fourchette. */
    labelRange: string;
    disabled?: boolean;
  } = $props();

  const steps = $derived(amountSteps(range));
  const minIndex = $derived(nearestStepIndex(steps, min));
  const maxIndex = $derived(nearestStepIndex(steps, max));
  const last = $derived(steps.length - 1);
  const percent = (index: number) => (last > 0 ? (index / last) * 100 : 0);

  // Les champs voisins affichent déjà les valeurs : le texte ne sert qu'aux lecteurs
  // d'écran. Un champ vidé pendant la saisie donne NaN, lu comme une valeur absente.
  const format = (value: number) => (Number.isFinite(value) ? value.toLocaleString(dateLocale()) : '-');

  function move(handle: 'min' | 'max', index: number) {
    const value = steps[index];
    const next = orderedAmounts(handle === 'min' ? value : min, handle === 'max' ? value : max, handle);
    min = next.min;
    max = next.max;
  }

  /**
   * Déplace toute la fourchette de `delta` paliers depuis les positions données. Renvoie
   * `false` sans rien écrire quand la plage ne bouge pas (déjà en butée, ou revenue à son
   * départ) : un montant saisi hors palier, 137 par exemple, n'est pas arrondi pour rien.
   */
  function shift(fromMin: number, fromMax: number, delta: number): boolean {
    const next = shiftedRange(fromMin, fromMax, delta, last);
    if (next.min === fromMin && next.max === fromMax) return false;
    min = steps[next.min];
    max = steps[next.max];
    return true;
  }

  let container = $state<HTMLDivElement>();
  /** Glissement en cours : point de départ et positions des poignées à ce moment-là. */
  let drag: { x: number; min: number; max: number; width: number; minValue: number; maxValue: number } | null = null;

  function startDrag(event: PointerEvent) {
    if (disabled || !container) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    drag = { x: event.clientX, min: minIndex, max: maxIndex, width: container.clientWidth, minValue: min, maxValue: max };
  }

  function continueDrag(event: PointerEvent) {
    if (!drag || drag.width === 0) return;
    // Revenue à son point de départ (ou bloquée contre un bout), la barre rend les
    // montants d'origine : un clic ou un tremblement ne les arrondit pas.
    const delta = Math.round(((event.clientX - drag.x) / drag.width) * last);
    if (!shift(drag.min, drag.max, delta)) {
      min = drag.minValue;
      max = drag.maxValue;
    }
  }

  function endDrag() {
    drag = null;
  }

  const KEY_SHIFT: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -5, PageUp: 5 };

  function onBandKey(event: KeyboardEvent) {
    if (disabled) return;
    let delta = KEY_SHIFT[event.key];
    if (event.key === 'Home') delta = -minIndex;
    if (event.key === 'End') delta = last - maxIndex;
    if (delta === undefined) return;
    event.preventDefault();
    shift(minIndex, maxIndex, delta);
  }
</script>

<div class="amount-range" bind:this={container}>
  <div class="amount-range__track" aria-hidden="true"></div>
  <div
    class="amount-range__band"
    class:amount-range__band--disabled={disabled}
    role="slider"
    tabindex={disabled ? -1 : 0}
    aria-label={labelRange}
    aria-valuemin={0}
    aria-valuemax={Math.max(0, last - (maxIndex - minIndex))}
    aria-valuenow={minIndex}
    aria-valuetext="{format(min)} - {format(max)}"
    aria-disabled={disabled}
    style:left="{percent(minIndex)}%"
    style:width="{Math.max(0, percent(maxIndex) - percent(minIndex))}%"
    onpointerdown={startDrag}
    onpointermove={continueDrag}
    onpointerup={endDrag}
    onpointercancel={endDrag}
    onkeydown={onBandKey}
  >
    <span class="amount-range__fill"></span>
  </div>
  <input
    type="range"
    min="0"
    max={last}
    step="1"
    value={minIndex}
    aria-label={labelMin}
    aria-valuetext={format(min)}
    oninput={(event) => move('min', Number(event.currentTarget.value))}
    {disabled}
  />
  <input
    type="range"
    min="0"
    max={last}
    step="1"
    value={maxIndex}
    aria-label={labelMax}
    aria-valuetext={format(max)}
    oninput={(event) => move('max', Number(event.currentTarget.value))}
    {disabled}
  />
</div>

<style>
  .amount-range {
    position: relative;
    height: 1.25rem;
  }
  .amount-range__track {
    position: absolute;
    inset: 50% 0 auto;
    height: 0.25rem;
    transform: translateY(-50%);
    border-radius: 9999px;
    background: var(--surface-container-high);
  }
  /* Zone de saisie de toute la hauteur du curseur : la barre visible, fine, se
     viserait mal. Les poignées, posées au-dessus, gardent leurs clics. */
  .amount-range__band {
    position: absolute;
    top: 0;
    bottom: 0;
    cursor: grab;
    touch-action: none;
    border-radius: 9999px;
  }
  .amount-range__band:active {
    cursor: grabbing;
  }
  .amount-range__band:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary-color) 30%, transparent);
  }
  .amount-range__band--disabled {
    cursor: not-allowed;
  }
  .amount-range__fill {
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    height: 0.25rem;
    transform: translateY(-50%);
    border-radius: 9999px;
    background: var(--primary-color);
  }
  .amount-range input {
    position: absolute;
    inset: 0;
    width: 100%;
    margin: 0;
    background: none;
    appearance: none;
    pointer-events: none;
    accent-color: var(--primary-color);
  }
  .amount-range input::-webkit-slider-runnable-track {
    background: none;
  }
  .amount-range input::-moz-range-track {
    background: none;
  }
  .amount-range input::-webkit-slider-thumb {
    appearance: none;
    pointer-events: auto;
    width: 1rem;
    height: 1rem;
    border-radius: 9999px;
    background: var(--primary-color);
    border: 2px solid var(--surface);
    cursor: pointer;
  }
  .amount-range input::-moz-range-thumb {
    pointer-events: auto;
    width: 1rem;
    height: 1rem;
    border-radius: 9999px;
    background: var(--primary-color);
    border: 2px solid var(--surface);
    cursor: pointer;
  }
  .amount-range input:focus-visible::-webkit-slider-thumb {
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary-color) 30%, transparent);
  }
  .amount-range input:focus-visible::-moz-range-thumb {
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary-color) 30%, transparent);
  }
  .amount-range input:disabled::-webkit-slider-thumb {
    cursor: not-allowed;
  }
</style>
