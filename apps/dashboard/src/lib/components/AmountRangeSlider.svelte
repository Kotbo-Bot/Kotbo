<!--
  Curseur à deux poignées pour une fourchette de montants (minimum, maximum).

  Il avance par paliers ronds (voir `amountScale`) et ne remplace pas la saisie :
  les champs placés à côté acceptent toute valeur, et le curseur se cale alors sur
  le palier le plus proche sans toucher à la valeur saisie. Seul un déplacement de
  poignée réécrit le montant.

  Deux `input type="range"` superposés : chacun garde le clavier et le nom
  accessible natifs. La piste ne capte pas les clics, seules les poignées le font.
-->
<script lang="ts">
  import { amountSteps, nearestStepIndex, orderedAmounts } from '../amountScale';
  import { dateLocale } from '../i18n';

  let {
    range,
    min = $bindable(),
    max = $bindable(),
    labelMin,
    labelMax,
    disabled = false,
  }: {
    range: { min: number; max: number };
    min: number;
    max: number;
    labelMin: string;
    labelMax: string;
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
</script>

<div class="amount-range">
  <div class="amount-range__track" aria-hidden="true">
    <div
      class="amount-range__fill"
      style:left="{percent(minIndex)}%"
      style:width="{Math.max(0, percent(maxIndex) - percent(minIndex))}%"
    ></div>
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
  .amount-range__fill {
    position: absolute;
    top: 0;
    bottom: 0;
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
