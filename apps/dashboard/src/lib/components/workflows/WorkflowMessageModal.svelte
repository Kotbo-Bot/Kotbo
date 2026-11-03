<script lang="ts">
  import Papicon from '../Papicon.svelte';
  import DiscordPreview from '../onboarding/DiscordPreview.svelte';

  /**
   * Texte fixe d'un nœud, avec ce que Discord en affichera.
   *
   * Le texte part tel quel : le moteur ne remplace rien dans un champ fixe.
   * Une valeur du contexte passe par un « Texte composé » relié au champ, ce
   * que la modale rappelle plutôt que d'offrir des jetons qui partiraient bruts.
   */

  const {
    open = false,
    title = 'Éditer le message',
    initialText = '',
    onSave,
    onClose,
  }: {
    open?: boolean;
    title?: string;
    initialText?: string;
    onSave?: (text: string) => void;
    onClose?: () => void;
  } = $props();

  let text = $state('');

  // La modale reste montee entre deux ouvertures : sans resynchronisation a
  // l'ouverture, elle rouvrait sur la saisie abandonnee la fois d'avant des lors
  // que le champ edite n'avait pas change entre-temps.
  $effect(() => {
    if (open) text = initialText;
  });

  function handleSave() {
    onSave?.(text);
    onClose?.();
  }
</script>

{#if open}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200">
    <div class="w-full max-w-2xl rounded-2xl bg-surface-container-high border border-outline-variant/20 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
      <!-- Header -->
      <div class="px-5 py-4 border-b border-outline-variant/15 flex items-center justify-between bg-surface-container-highest/40">
        <div class="flex items-center gap-2">
          <div class="p-2 rounded-xl bg-primary/10 text-primary">
            <Papicon icon="TextBubble" size={18} />
          </div>
          <div>
            <h3 class="text-sm font-bold text-on-surface">{title}</h3>
            <p class="text-2xs text-on-surface-variant">Éditeur avec aperçu Discord en temps réel</p>
          </div>
        </div>
        <button
          onclick={onClose}
          aria-label="Fermer"
          class="p-1.5 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest transition-colors"
        >
          <Papicon icon="Cross" size={16} />
        </button>
      </div>

      <!-- Body -->
      <div class="p-5 space-y-4 overflow-y-auto">
        <p class="flex items-start gap-2 px-3 py-2 rounded-xl bg-primary/10 border border-primary/20 text-xs text-on-surface">
          <Papicon icon="Info" size={13} class="text-primary shrink-0 mt-0.5" />
          <span>Ce texte part tel quel. Pour y insérer le membre, le salon ou une autre valeur, relie un nœud « Texte composé » à ce champ, ou écris l'étape dans l'éditeur en phrases.</span>
        </p>

        <!-- Zone de texte -->
        <div class="space-y-1.5">
          <label for="msg-modal-input" class="text-xs font-semibold text-on-surface-variant">
            Contenu du message
          </label>
          <textarea
            id="msg-modal-input"
            bind:value={text}
            rows="5"
            placeholder="Saisis le texte de ton message ici..."
            class="w-full px-3.5 py-2.5 rounded-xl bg-surface-container-highest border border-outline-variant/30 text-sm text-on-surface focus:border-primary/50 focus:outline-none transition-all resize-y"
          ></textarea>
        </div>

        <div class="space-y-1.5">
          <p class="text-xs font-semibold text-on-surface-variant flex items-center gap-1.5">
            <Papicon icon="Camera" size={12} />
            <span>Aperçu Discord</span>
          </p>
          <DiscordPreview channel="salon" content={text.trim() ? text : 'Exemple de message...'} />
        </div>
      </div>

      <!-- Footer -->
      <div class="px-5 py-3 border-t border-outline-variant/15 bg-surface-container-highest/30 flex items-center justify-end gap-2">
        <button
          type="button"
          onclick={onClose}
          class="px-4 py-2 rounded-xl text-xs font-semibold bg-surface-container-highest text-on-surface-variant hover:text-on-surface transition-all"
        >
          Annuler
        </button>
        <button
          type="button"
          onclick={handleSave}
          class="px-5 py-2 rounded-xl text-xs font-semibold bg-primary text-on-primary hover:opacity-90 transition-all flex items-center gap-1.5"
        >
          <Papicon icon="Check" size={14} />
          <span>Valider et appliquer</span>
        </button>
      </div>
    </div>
  </div>
{/if}
