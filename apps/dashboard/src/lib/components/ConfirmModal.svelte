<script lang="ts">
  import Papicon from './Papicon.svelte';
  import Button from './ui/Button.svelte';
  import { m } from '../i18n';
  import { portal } from '../actions/portal';

  interface Props {
    open?: boolean;
    title?: string;
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: 'danger' | 'warning' | 'default';
    requireInput?: string; // if set, user must type this to confirm
    /** Consequences de l'action, une par ligne, affichees avant de valider. */
    impacts?: string[];
    loading?: boolean;
    onConfirm?: () => void | Promise<void>;
    onCancel?: () => void;
  }

  let {
    open = $bindable(false),
    title = m.d7_confirm_required(),
    description = '',
    confirmLabel = m.d7_confirm(),
    cancelLabel = m.d7_cancel(),
    variant = 'default',
    requireInput = '',
    impacts = [],
    loading = false,
    onConfirm,
    onCancel,
  }: Props = $props();

  let inputValue = $state('');
  let executing = $state(false);

  const VARIANTS = {
    danger: { icon: 'AlertTriangle', tone: 'bg-error/10 text-error', button: 'danger' },
    warning: { icon: 'AlertTriangle', tone: 'bg-warning/10 text-warning', button: 'primary' },
    default: { icon: 'Info', tone: 'bg-primary/10 text-primary', button: 'primary' },
  } as const;

  const config = $derived(VARIANTS[variant]);
  const canConfirm = $derived(requireInput ? inputValue === requireInput : true);

  function handleCancel() {
    inputValue = '';
    open = false;
    onCancel?.();
  }

  async function handleConfirm() {
    if (!canConfirm || executing) return;
    executing = true;
    try {
      await onConfirm?.();
      open = false;
      inputValue = '';
    } finally {
      executing = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === 'Escape') handleCancel();
    if (e.key === 'Enter' && canConfirm && !executing) handleConfirm();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <div
    use:portal
    class="confirm-modal fixed inset-0 flex items-center justify-center p-4"
    onclick={handleCancel}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleCancel(); }}
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-labelledby="confirm-modal-title"
    aria-describedby={description ? 'confirm-modal-description' : undefined}
  >
    <div class="absolute inset-0 bg-black/40 animate-in fade-in duration-150"></div>

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="confirm-modal__panel relative z-10 w-full max-w-md bg-surface-container-lowest border border-outline-variant rounded-xl shadow-lg p-5 space-y-5 animate-in fade-in slide-up duration-150"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <div class="flex items-start gap-3">
        <span class="w-9 h-9 rounded-full flex items-center justify-center shrink-0 {config.tone}" aria-hidden="true">
          <Papicon icon={config.icon} size={17} />
        </span>
        <div class="min-w-0 pt-1.5">
          <h3 id="confirm-modal-title" class="text-base font-semibold text-on-surface leading-snug">{title}</h3>
          {#if description}
            <p id="confirm-modal-description" class="text-sm text-on-surface-variant mt-1.5 leading-relaxed">{description}</p>
          {/if}
        </div>
      </div>

      {#if impacts.length > 0}
        <div class="rounded-lg border border-outline-variant bg-surface-container-low px-3.5 py-3">
          <p class="text-sm font-medium text-on-surface">{m.confirm_impacts_title()}</p>
          <ul class="mt-1.5 space-y-1">
            {#each impacts as impact}
              <li class="flex items-start gap-2 text-sm text-on-surface-variant">
                <Papicon icon="ArrowRight" size={13} class="mt-1 shrink-0" />
                <span>{impact}</span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if requireInput}
        <label class="field gap-1.5">
          <span class="text-sm text-on-surface-variant">
            {m.d7_type_to_confirm_pre()} <span class="font-mono font-medium text-on-surface">{requireInput}</span> {m.d7_type_to_confirm_post()}
          </span>
          <input
            type="text"
            bind:value={inputValue}
            placeholder={requireInput}
            autocomplete="off"
            spellcheck="false"
            class="input font-mono"
          />
        </label>
      {/if}

      <div class="confirm-modal__actions flex items-center justify-end gap-2">
        <Button variant="ghost" onclick={handleCancel}>{cancelLabel}</Button>
        <Button
          variant={config.button}
          onclick={handleConfirm}
          disabled={!canConfirm}
          loading={executing || loading}
        >
          {confirmLabel}
        </Button>
      </div>
    </div>
  </div>
{/if}
