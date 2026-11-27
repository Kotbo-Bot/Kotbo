<script lang="ts">
  import { InlineFeedback as KotboInlineFeedback } from '@kotbo/ui';

  interface Props {
    message?: string;
    error?: string;
    idleText?: string;
    state?: {
      state: {
        message: string;
        error: string;
      };
    };
  }

  const {
    message = '',
    error = '',
    idleText = '',
    state = undefined,
  }: Props = $props();
</script>

<KotboInlineFeedback {message} {error} {idleText} {state} />
