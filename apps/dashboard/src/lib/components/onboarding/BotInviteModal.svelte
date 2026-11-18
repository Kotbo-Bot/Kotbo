<script lang="ts">
  /**
   * Modal de selection des autorisations lors de l'invitation du bot.
   *
   * Permet d'arbitrer entre la permission Administrateur directe et les permissions
   * au detail, avec un guidage fort vers l'option recommandee pour prevenir les
   * dysfonctionnements de salons et de securite.
   */
  import Modal from '../Modal.svelte';
  import Papicon from '../Papicon.svelte';
  import {
    ADMIN_INVITE_PERMISSIONS,
    DETAILED_INVITE_PERMISSIONS,
    buildBotInviteUrl,
    type ManageableServer,
  } from '../../api';

  let {
    open = $bindable(false),
    guild = null,
    clientId = '',
    onInviteStarted = () => {},
    onClose = () => {},
  }: {
    open?: boolean;
    guild?: ManageableServer | null;
    clientId: string;
    onInviteStarted?: (guildId?: string) => void;
    onClose?: () => void;
  } = $props();

  let showDetailedSection = $state(false);
  let acknowledgedRisks = $state(false);

  function resetState() {
    showDetailedSection = false;
    acknowledgedRisks = false;
  }

  function handleClose() {
    resetState();
    open = false;
    onClose();
  }

  function inviteWithAdmin() {
    const url = buildBotInviteUrl(clientId, ADMIN_INVITE_PERMISSIONS, guild?.id);
    onInviteStarted(guild?.id);
    window.open(url, '_blank', 'noopener,noreferrer');
    handleClose();
  }

  function inviteWithDetailed() {
    if (!acknowledgedRisks) return;
    const url = buildBotInviteUrl(clientId, DETAILED_INVITE_PERMISSIONS, guild?.id);
    onInviteStarted(guild?.id);
    window.open(url, '_blank', 'noopener,noreferrer');
    handleClose();
  }
</script>

<Modal
  bind:open
  onClose={handleClose}
  size="md"
  title={guild ? `Installer Kotbo sur ${guild.name}` : 'Installer Kotbo'}
  subtitle="Choisissez le niveau d'autorisation du bot sur votre serveur Discord."
>
  <div class="space-y-4">
    <!-- Option Recommandee (Administrateur) - Mise en avant forte -->
    <div class="relative rounded-2xl border-2 border-primary bg-primary/5 p-5 text-left transition-all">
      <div class="flex items-start justify-between gap-3">
        <div class="flex items-center gap-2.5">
          <div class="w-10 h-10 rounded-xl bg-primary/15 text-primary flex items-center justify-center shrink-0">
            <Papicon icon="ShieldCheck" size={20} />
          </div>
          <div>
            <div class="flex items-center gap-2">
              <h3 class="text-sm font-semibold text-on-surface">Permission Administrateur</h3>
              <span class="px-2 py-0.5 rounded-full text-2xs font-bold uppercase tracking-wider bg-primary text-on-primary">
                Recommandé
              </span>
            </div>
            <p class="text-xs text-on-surface-variant/75 mt-0.5">Installation optimale en 1 clic</p>
          </div>
        </div>
      </div>

      <p class="mt-3 text-xs text-on-surface-variant/90 leading-relaxed">
        Garantit le bon fonctionnement immédiat de tous les modules sans risque de conflit de permissions avec vos salons existants.
      </p>

      <ul class="mt-3.5 space-y-1.5 text-xs text-on-surface-variant">
        <li class="flex items-center gap-2">
          <Papicon icon="check" size={14} class="text-primary shrink-0" />
          <span>Création et isolation étanche des salons de tickets privés</span>
        </li>
        <li class="flex items-center gap-2">
          <Papicon icon="check" size={14} class="text-primary shrink-0" />
          <span>Protection anti-raid et verrous de sécurité actifs instantanément</span>
        </li>
        <li class="flex items-center gap-2">
          <Papicon icon="check" size={14} class="text-primary shrink-0" />
          <span>Zéro réglage manuel d'autorisations salon par salon sur Discord</span>
        </li>
      </ul>

      <button
        type="button"
        onclick={inviteWithAdmin}
        class="mt-4 w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-primary text-on-primary text-xs font-semibold hover:opacity-90 active:scale-[0.99] transition-all shadow-sm"
      >
        <span>Installer avec la permission Administrateur</span>
        <Papicon icon="ExternalLink" size={14} />
      </button>
    </div>

    <!-- Option Dissuasive (Permissions au detail) - Friction Maximale -->
    <div class="rounded-xl border border-outline-variant/30 bg-surface-container-low/30 p-3.5 text-left">
      {#if !showDetailedSection}
        <div class="flex items-center justify-between">
          <p class="text-2xs text-on-surface-variant/60">
            Besoin d'un contrôle granulaire strict ?
          </p>
          <button
            type="button"
            onclick={() => (showDetailedSection = true)}
            class="text-xs font-medium text-on-surface-variant/50 hover:text-on-surface-variant underline decoration-dotted transition-colors"
          >
            Permissions au détail (déconseillé)...
          </button>
        </div>
      {:else}
        <div class="space-y-3 animate-in fade-in duration-200">
          <div class="flex items-start gap-2.5 rounded-lg border border-error/30 bg-error/10 p-3 text-on-error-container">
            <Papicon icon="AlertTriangle" size={16} class="shrink-0 mt-0.5" />
            <div class="space-y-1 text-xs">
              <p class="font-semibold text-on-surface">Risque élevé de dysfonctionnement et de fuite</p>
              <p class="text-on-surface-variant/80 leading-relaxed text-2xs">
                Sans les droits Administrateur, Kotbo est restreint par les règles Discord par défaut. Les tickets privés risquent d'être lisibles par tous les membres, la modération vocale peut échouer et les journaux de sécurité ne seront pas isolés sans intervention manuelle sur chaque catégorie.
              </p>
            </div>
          </div>

          <label class="flex items-start gap-2.5 cursor-pointer select-none px-1">
            <input
              type="checkbox"
              bind:checked={acknowledgedRisks}
              class="mt-0.5 rounded border-error/40 text-error focus:ring-error"
            />
            <span class="text-2xs text-error font-medium leading-relaxed">
              J'ai conscience des risques de blocage et je m'engage à ajuster manuellement les autorisations de tous les salons dans Discord.
            </span>
          </label>

          <div class="flex flex-col gap-2 pt-1">
            <button
              type="button"
              disabled={!acknowledgedRisks}
              onclick={inviteWithDetailed}
              class="w-full py-2 px-3 rounded-lg border border-error/30 text-error text-xs font-medium hover:bg-error/10 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            >
              Continuer avec les permissions restreintes (non recommandé)
            </button>

            <button
              type="button"
              onclick={() => {
                showDetailedSection = false;
                acknowledgedRisks = false;
              }}
              class="text-2xs text-primary font-medium hover:underline text-center py-1"
            >
              Revenir au choix recommandé (Administrateur)
            </button>
          </div>
        </div>
      {/if}
    </div>
  </div>
</Modal>
