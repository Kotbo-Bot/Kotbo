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
  import { Button, Callout } from '../../ui';
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
      toast.success(m.obx_wc_perms_refreshed());
    } catch {
      toast.error(m.obx_wc_perms_refresh_failed());
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

    {#if !isAdministrator}
      <div class="mt-6 w-full max-w-xl text-left">
        <Callout variant="warning" title={m.obx_wc_restricted_title()}>
          {m.obx_wc_restricted_desc()}
          {#snippet actions()}
            {#if clientId}
              <Button
                variant="primary"
                size="sm"
                iconRight="ExternalLink"
                href={buildBotInviteUrl(clientId, ADMIN_INVITE_PERMISSIONS, selectedGuild?.id)}
                target="_blank"
              >
                {m.obx_wc_grant_admin()}
              </Button>
            {/if}
            <Button
              variant="secondary"
              size="sm"
              icon="refresh-cw"
              loading={refreshingPerms}
              onclick={refreshPermissions}
            >
              {m.obx_wc_check_status()}
            </Button>
          {/snippet}
        </Callout>
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

<Modal
  bind:open={frictionModalOpen}
  onClose={() => (frictionModalOpen = false)}
  size="md"
  title={m.obx_wc_detailed_title()}
  subtitle={m.obx_wc_detailed_subtitle()}
>
  <div class="space-y-4 text-left">
    <Callout variant="warning" title={m.obx_wc_manual_title()}>
      {m.obx_wc_manual_desc()}
    </Callout>

    <label class="flex items-start gap-2.5 cursor-pointer select-none">
      <input
        type="checkbox"
        bind:checked={acknowledgedDetailed}
        class="mt-0.5 rounded border-field-border text-primary focus:ring-primary"
      />
      <span class="text-xs text-on-surface-variant leading-relaxed">
        {m.obx_wc_manual_ack()}
      </span>
    </label>
  </div>

  {#snippet footer()}
    <div class="flex items-center justify-end gap-2">
      {#if clientId}
        <Button
          variant="primary"
          size="sm"
          iconRight="ExternalLink"
          href={buildBotInviteUrl(clientId, ADMIN_INVITE_PERMISSIONS, selectedGuild?.id)}
          target="_blank"
        >
          {m.obx_wc_switch_admin()}
        </Button>
      {/if}
      <Button
        variant="secondary"
        size="sm"
        disabled={!acknowledgedDetailed}
        onclick={confirmDetailedAndProceed}
      >
        {m.obx_wc_continue_restricted()}
      </Button>
    </div>
  {/snippet}
</Modal>
