<script lang="ts">
  import { onMount } from 'svelte';
  import { m } from '../../../i18n';
  /**
   * La rencontre : le bot et le serveur, cote a cote.
   *
   * C'est la seule image du parcours, et elle dit ce qui vient de se passer
   * mieux qu'une phrase. Quelqu'un qui vient d'inviter Kotbo ne sait pas encore
   * a quoi ressemble ce qu'il installe.
   *
   * Les quatre promesses en dessous ne sont pas un argumentaire : elles disent
   * ce que les ecrans suivants vont reellement produire, pour qu'on sache ce
   * qu'on s'apprete a traverser.
   */
  import { authStore } from '../../../stores/auth.svelte';
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import { onboardingData } from '../../../stores/onboardingData.svelte';
  import { toast } from '../../../stores/toast.svelte';
  import {
    ADMIN_INVITE_PERMISSIONS,
    buildBotInviteUrl,
    fetchDiscordClientId,
  } from '../../../api';
  import KotboMark from '../KotboMark.svelte';
  import Papicon from '../../Papicon.svelte';
  import Modal from '../../Modal.svelte';
  import WizardShell from '../WizardShell.svelte';

  const selectedGuild = $derived(
    authStore.guilds.find((guild) => guild.id === authStore.selectedGuildId)
  );

  const guildIconUrl = $derived(
    selectedGuild?.icon
      ? `https://cdn.discordapp.com/icons/${selectedGuild.id}/${selectedGuild.icon}.png?size=128`
      : null
  );

  const template = $derived(onboardingData.template);
  const isAdministrator = $derived(template?.isAdministrator ?? true);

  let clientId = $state('');
  let refreshingPerms = $state(false);
  let acknowledgedDetailed = $state(false);
  let frictionModalOpen = $state(false);

  onMount(async () => {
    clientId = await fetchDiscordClientId();
  });

  async function refreshPermissions() {
    refreshingPerms = true;
    try {
      await onboardingData.loadCore();
      toast.success('Permissions actualisées.');
    } catch {
      toast.error('Impossible de vérifier les permissions.');
    } finally {
      refreshingPerms = false;
    }
  }

  function handleStart() {
    if (!isAdministrator && !acknowledgedDetailed) {
      frictionModalOpen = true;
      return;
    }
    wizard.next();
  }

  function confirmDetailedAndProceed() {
    if (!acknowledgedDetailed) return;
    frictionModalOpen = false;
    wizard.next();
  }

  const PROMISES = [
    { icon: 'layout-grid', get title() { return m.obx_wc_structure(); }, get text() { return m.obx_wc_structure_desc(); } },
    { icon: 'shield', get title() { return m.obx_wc_moderation(); }, get text() { return m.obx_wc_moderation_desc(); } },
    { icon: 'door-open', get title() { return m.obx_wc_welcome(); }, get text() { return m.obx_wc_welcome_desc(); } },
    { icon: 'sparkles', get title() { return m.obx_wc_rest(); }, get text() { return m.obx_wc_rest_desc(); } },
  ];
</script>

<WizardShell bare>
  <div class="flex flex-col items-center text-center">
    <div class="flex items-center gap-4 sm:gap-5">
      <KotboMark size={72} halo />
      <Papicon icon="plus" size={18} class="text-on-surface-variant/35" />
      {#if guildIconUrl}
        <img src={guildIconUrl} alt="" class="w-[72px] h-[72px] rounded-[22%] object-cover" />
      {:else}
        <div class="w-[72px] h-[72px] rounded-[22%] bg-surface-container flex items-center justify-center text-xl font-bold text-on-surface-variant">
          {(selectedGuild?.name ?? '?').slice(0, 1).toUpperCase()}
        </div>
      {/if}
    </div>

    <h1 class="mt-7 text-2xl sm:text-[30px] leading-tight font-semibold tracking-tight text-on-surface font-headline">
      {m.obx_wc_title({ server: selectedGuild?.name ?? m.obx_rc_your_server() })}
    </h1>
    <p class="mt-3 max-w-lg text-[15px] text-on-surface-variant/75 leading-relaxed">
      {m.obx_wc_lead()}
    </p>

    <div class="mt-4 inline-flex items-center gap-2 rounded-full border border-outline-variant/35 bg-surface-container-low/40 px-3 py-1.5">
      <Papicon icon="clock" size={13} class="text-primary" />
      <span class="text-xs font-medium text-on-surface-variant">{m.obx_wc_duration()}</span>
    </div>

    <!-- Etat des autorisations Discord : mise en avant forte de l'Admin ou avertissement de friction -->
    {#if !isAdministrator}
      <div class="mt-7 w-full max-w-xl rounded-2xl border-2 border-warning/40 bg-warning/5 p-4 sm:p-5 text-left space-y-4">
        <div class="flex items-start gap-3">
          <div class="w-9 h-9 rounded-xl bg-warning/15 text-on-warning-container flex items-center justify-center shrink-0 mt-0.5">
            <Papicon icon="AlertTriangle" size={18} />
          </div>
          <div class="min-w-0 flex-1 space-y-1">
            <div class="flex items-center gap-2 flex-wrap">
              <p class="text-sm font-semibold text-on-surface">Permissions restreintes détectées</p>
              <span class="text-2xs font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-warning/15 text-on-warning-container">
                Mode au détail
              </span>
            </div>
            <p class="text-xs text-on-surface-variant/80 leading-relaxed">
              Kotbo ne dispose pas de la permission Administrateur sur ce serveur. Sans elle, la création des salons de tickets privés, l'anti-raid et l'isolation des logs peuvent échouer ou créer des conflits d'accès.
            </p>
          </div>
        </div>

        <div class="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-2 border-t border-warning/20">
          <a
            href={clientId ? buildBotInviteUrl(clientId, ADMIN_INVITE_PERMISSIONS, selectedGuild?.id) : '#'}
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-primary text-on-primary text-xs font-semibold hover:opacity-90 transition-opacity shadow-sm"
          >
            <Papicon icon="ShieldCheck" size={14} />
            Passer en Administrateur (Recommandé)
          </a>

          <button
            type="button"
            onclick={refreshPermissions}
            disabled={refreshingPerms}
            class="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-outline-variant/30 text-xs font-medium text-on-surface-variant hover:text-on-surface transition-colors"
          >
            <Papicon icon="refresh-cw" size={12} class={refreshingPerms ? 'animate-spin' : ''} />
            Vérifier l'état
          </button>
        </div>
      </div>
    {:else}
      <div class="mt-6 inline-flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 px-4 py-2 text-xs font-medium text-primary">
        <Papicon icon="ShieldCheck" size={15} />
        <span>Permissions serveur : Administrateur (Recommandé) · Tous les modules sont déverrouillés</span>
      </div>
    {/if}
  </div>

  <ul class="mt-9 grid gap-3 sm:grid-cols-2">
    {#each PROMISES as row (row.title)}
      <li class="rounded-2xl border border-outline-variant/30 bg-surface-container-low/30 p-4">
        <div class="w-9 h-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center mb-2.5">
          <Papicon icon={row.icon} size={16} />
        </div>
        <p class="text-sm font-semibold text-on-surface">{row.title}</p>
        <p class="mt-1 text-body-sm text-on-surface-variant/65 leading-relaxed">{row.text}</p>
      </li>
    {/each}
  </ul>

  {#snippet footer()}
    <button
      type="button"
      onclick={handleStart}
      class="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-on-primary text-sm font-semibold hover:opacity-90 transition-opacity"
    >
      {m.obx_wc_start()}
      <Papicon icon="ChevronRight" size={15} />
    </button>
  {/snippet}
</WizardShell>

<!-- Modal de friction si tentative de continuer sans la permission Administrateur -->
<Modal
  bind:open={frictionModalOpen}
  onClose={() => (frictionModalOpen = false)}
  size="md"
  title="Avertissement : Mode permissions au détail"
  subtitle="Vous configurez le serveur sans les droits recommandés."
>
  <div class="space-y-4 text-left">
    <div class="flex items-start gap-2.5 rounded-lg border border-error/30 bg-error/10 p-3.5 text-on-error-container">
      <Papicon icon="AlertTriangle" size={18} class="shrink-0 mt-0.5" />
      <div class="space-y-1 text-xs">
        <p class="font-semibold text-on-surface">Risque de dysfonctionnement majeur lors de la pose</p>
        <p class="text-on-surface-variant/80 leading-relaxed text-2xs">
          En continuant avec des permissions restreintes, Discord appliquera les limitations de chaque salon. Vos tickets peuvent devenir visibles par tous les membres et les salons de journalisation risquent de ne pas être créés. Vous devrez configurer manuellement toutes les permissions salon par salon sur Discord.
        </p>
      </div>
    </div>

    <label class="flex items-start gap-2.5 cursor-pointer select-none px-1">
      <input
        type="checkbox"
        bind:checked={acknowledgedDetailed}
        class="mt-0.5 rounded border-error/40 text-error focus:ring-error"
      />
      <span class="text-2xs text-error font-medium leading-relaxed">
        J'ai conscience des risques de dysfonctionnement, de fuite de salons privés et je confirme vouloir poursuivre en mode restreint.
      </span>
    </label>

    <div class="flex flex-col sm:flex-row gap-2 pt-2">
      <a
        href={clientId ? buildBotInviteUrl(clientId, ADMIN_INVITE_PERMISSIONS, selectedGuild?.id) : '#'}
        target="_blank"
        rel="noopener noreferrer"
        class="flex-1 inline-flex items-center justify-center gap-1.5 py-2.5 px-4 rounded-xl bg-primary text-on-primary text-xs font-semibold hover:opacity-90 transition-opacity shadow-sm"
      >
        <Papicon icon="ShieldCheck" size={14} />
        Passer en Administrateur
      </a>

      <button
        type="button"
        disabled={!acknowledgedDetailed}
        onclick={confirmDetailedAndProceed}
        class="flex-1 py-2.5 px-4 rounded-xl border border-error/30 text-error text-xs font-semibold hover:bg-error/10 disabled:opacity-30 disabled:cursor-not-allowed transition-all text-center"
      >
        Continuer en mode restreint
      </button>
    </div>
  </div>
</Modal>
