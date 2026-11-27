<script lang="ts">
  import { AmountRangeSlider as KotboAmountRangeSlider } from '@kotbo/ui';

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
    labelRange: string;
    disabled?: boolean;
  } = $props();
</script>

<KotboAmountRangeSlider {range} bind:min bind:max {labelMin} {labelMax} {labelRange} {disabled} />
