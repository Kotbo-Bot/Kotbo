<script lang="ts">
  import { toast } from '../stores/toast.svelte';
  import Toast from './Toast.svelte';
</script>

<!-- Zone toujours presente : une zone live inseree a la volee n'est pas toujours annoncee. -->
<div class="toast-container fixed bottom-6 right-6 z-[9999] flex flex-col gap-3 w-full max-w-sm" aria-live="polite" aria-relevant="additions">
  {#each toast.toasts as item (item.id)}
    <Toast {item} />
  {/each}
</div>
