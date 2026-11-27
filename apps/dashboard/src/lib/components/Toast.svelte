<script lang="ts">
  import { Toast as KotboToast } from '@kotbo/ui';
  import type { Toast as ToastType } from '../stores/toast.svelte';

  const { item }: { item: ToastType } = $props();
</script>

<KotboToast {item} />
