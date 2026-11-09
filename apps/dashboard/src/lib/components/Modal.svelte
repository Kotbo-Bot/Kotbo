<script lang="ts">
  import { m } from '../i18n';
  import { portal } from '../actions/portal';
  import { dialogFocus } from '../actions/dialogFocus';
  import { scrollLock } from '../scrollLock';
  import Papicon from './Papicon.svelte';

  let {
    open = $bindable(false),
    onClose = () => {},
    title = '',
    ariaLabel = '',
    subtitle = '',
    size = 'md',
    showCloseButton = true,
    closeOnBackdropClick = true,
    closeOnEscape = true,
    aboveCase = false,
    flush = false,
    children,
    footer
  } = $props<{
    open?: boolean;
    onClose?: (e?: any) => void;
    title?: string;
    /** Nom de la fenetre quand elle n'affiche pas de `title` (RGAA 7.1). */
    ariaLabel?: string;
    subtitle?: string;
    size?: 'sm' | 'md' | 'lg' | 'xl' | 'full' | 'screen';
    showCloseButton?: boolean;
    closeOnBackdropClick?: boolean;
    closeOnEscape?: boolean;
    /** Ouverte depuis le dossier membre : passe au-dessus de lui au lieu de dessous. */
    aboveCase?: boolean;
    /** Le contenu gère lui-même ses marges (fiche plein écran, dossier membre). */
    flush?: boolean;
    children?: any;
    /** Barre d'actions fixe sous le contenu défilant (ex : Annuler / Enregistrer). */
    footer?: any;
  }>();

  const sizeClasses: Record<string, string> = {
    sm: 'max-w-sm',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
    full: 'max-w-6xl',
    screen: 'max-w-none'
  };

  const isScreen = $derived(size === 'screen');
  const titleId = $props.id();

  function handleBackdropClick(e: MouseEvent) {
    if (closeOnBackdropClick && e.currentTarget === e.target) {
      open = false;
      onClose(e);
    }
  }

  function close() {
    open = false;
    onClose();
  }
</script>

{#if open}
  <div
    use:portal
    use:scrollLock
    class="app-modal {aboveCase ? 'app-modal--above-case' : ''} fixed inset-0 flex items-center justify-center {isScreen ? 'p-0 sm:p-4' : 'p-4'}"
    role="presentation"
  >
    <!-- Au clavier, on ferme avec Echap ou le bouton de fermeture. -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="absolute inset-0 bg-black/40" onclick={handleBackdropClick} aria-hidden="true"></div>

    <div
      use:dialogFocus={{ onEscape: closeOnEscape ? close : undefined }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : ariaLabel || undefined}
      tabindex="-1"
      class="app-modal__panel relative w-full {sizeClasses[size]} bg-surface-container-lowest shadow-lg overflow-hidden border border-outline-variant flex flex-col animate-in fade-in slide-up duration-150 {isScreen
        ? 'h-full rounded-none sm:h-[calc(100vh-2rem)] sm:rounded-xl'
        : 'rounded-xl max-h-[90vh]'} focus:outline-none"
    >
      <!-- Header -->
      {#if title || showCloseButton}
        <header class="app-modal__header px-5 py-4 border-b border-outline-variant flex items-center justify-between">
          <div class="min-w-0 flex-1">
            {#if title}
              <h3 id={titleId} class="text-base font-semibold text-on-surface">{title}</h3>
            {/if}
            {#if subtitle}
              <p class="text-sm text-on-surface-variant mt-0.5">{subtitle}</p>
            {/if}
          </div>
          {#if showCloseButton}
            <button
              type="button"
              onclick={close}
              class="ml-3 h-8 w-8 flex items-center justify-center rounded-md bg-surface-container hover:bg-surface-container-high transition-colors text-on-surface-variant hover:text-on-surface"
              aria-label={m.common_close()}
            >
              <Papicon icon="x" size={14} />
            </button>
          {/if}
        </header>
      {/if}

      <!-- Content - the modal's single scroll container. Children must not nest
           another overflow-y:auto full-height wrapper here, or two scrollbars appear. -->
      <div class="app-modal__body flex-1 min-h-0 overflow-y-auto {flush ? '' : 'p-5'}">
        {@render children?.()}
      </div>

      <!-- Footer - stays put while the body scrolls, so actions on long forms are always reachable. -->
      {#if footer}
        <footer class="app-modal__footer px-5 py-3.5 border-t border-outline-variant bg-surface-container-lowest shrink-0">
          {@render footer()}
        </footer>
      {/if}
    </div>
  </div>
{/if}
