<script lang="ts">
  import { FormColorPicker as KotboFormColorPicker } from '@kotbo/ui';

  let { value = $bindable('#5865F2') }: { value: string } = $props();
</script>

<KotboFormColorPicker bind:value />
