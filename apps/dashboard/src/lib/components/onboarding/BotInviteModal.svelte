<script lang="ts">
  import Modal from '../Modal.svelte';
  import Papicon from '../Papicon.svelte';
  import { Button, Callout } from '../ui';
  import { DEMO_MODE } from '../../demo/mode';
  import { toast } from '../../stores/toast.svelte';
  import {
    ADMIN_INVITE_PERMISSIONS,
    DETAILED_INVITE_PERMISSIONS,
    buildBotInviteUrl,
    buildBotInstallUrl,
    type ManageableServer,
  } from '../../api';
  import { brandingStore } from '../../stores/branding.svelte';
  import { m } from '../../i18n';

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

  function invite(permissions: 'admin' | 'detailed') {
    if (DEMO_MODE) {
      onInviteStarted(guild?.id);
      toast.success(guild ? m.bim_added_demo_server({ server: guild.name }) : m.bim_added_demo());
      handleClose();
      return;
    }
    onInviteStarted(guild?.id);
    // Domaine perso : autre application Discord, sans retour automatique.
    if (brandingStore.isWhiteLabel) {
      const raw = permissions === 'admin' ? ADMIN_INVITE_PERMISSIONS : DETAILED_INVITE_PERMISSIONS;
      window.open(buildBotInviteUrl(clientId, raw, guild?.id), '_blank', 'noopener,noreferrer');
      handleClose();
      return;
    }
    window.location.href = buildBotInstallUrl(guild?.id, permissions);
  }

  function inviteWithDetailed() {
    if (acknowledgedRisks) invite('detailed');
  }
</script>

<Modal
  bind:open
  onClose={handleClose}
  size="md"
  title={guild ? `Installer Kotbo sur ${guild.name}` : 'Installer Kotbo'}
  subtitle="Choisissez les autorisations accordées au bot sur Discord."
>
  <div class="space-y-4">
    <div class="section-card p-4 space-y-3 text-left">
      <div class="flex items-start gap-3">
        <div class="w-9 h-9 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0 mt-0.5">
          <Papicon icon="shield" size={17} />
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 flex-wrap">
            <h3 class="text-sm font-semibold text-on-surface">Permission Administrateur</h3>
            <span class="rounded-full bg-primary/10 px-2.5 py-0.5 text-2xs font-medium text-primary">
              Recommandé
            </span>
          </div>
          <p class="mt-1 text-body-sm text-on-surface-variant leading-relaxed">
            Évite les conflits d'accès avec vos salons existants et permet d'isoler automatiquement les tickets privés et les salons de journalisation.
          </p>
        </div>
      </div>

      <Button
        variant="primary"
        iconRight="ExternalLink"
        fullWidth
        onclick={() => invite('admin')}
      >
        Continuer sur Discord
      </Button>
    </div>

    <div class="border-t border-outline-variant pt-3 text-left">
      {#if !showDetailedSection}
        <button
          type="button"
          onclick={() => (showDetailedSection = true)}
          class="text-xs font-medium text-on-surface-variant hover:text-on-surface transition-colors"
        >
          Utiliser les permissions au détail…
        </button>
      {:else}
        <div class="space-y-3">
          <Callout variant="warning" title="Permissions au détail">
            Sans le droit Administrateur, Discord applique les restrictions de chaque catégorie. Les salons de tickets ou de logs peuvent nécessiter un réglage manuel dans Discord.
          </Callout>

          <label class="flex items-start gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              bind:checked={acknowledgedRisks}
              class="mt-0.5 rounded border-field-border text-primary focus:ring-primary"
            />
            <span class="text-xs text-on-surface-variant leading-relaxed">
              Je préfère configurer manuellement les permissions des salons si nécessaire.
            </span>
          </label>

          <div class="flex items-center justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              onclick={() => {
                showDetailedSection = false;
                acknowledgedRisks = false;
              }}
            >
              Annuler
            </Button>
            <Button
              variant="secondary"
              size="sm"
              iconRight="ExternalLink"
              disabled={!acknowledgedRisks}
              onclick={inviteWithDetailed}
            >
              Installer en mode restreint
            </Button>
          </div>
        </div>
      {/if}
    </div>
  </div>
</Modal>
