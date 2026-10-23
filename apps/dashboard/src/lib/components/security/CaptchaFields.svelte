<script lang="ts">
  /**
   * Champs du captcha d'entree, partages entre Securite > Anti-raid et la page
   * Reglement : les deux editent la meme config `raid-protection`, l'appelant
   * garde la main sur le chargement et l'enregistrement.
   */
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import ToggleSwitch from '../ToggleSwitch.svelte';

  let { config = $bindable() }: { config: Record<string, any> } = $props();

  const channels = $derived((dashboardStore.state.discordChannels ?? []) as { id: string; name: string }[]);
  const voiceChannels = $derived((dashboardStore.state.discordVoiceChannels ?? []) as { id: string; name: string }[]);
  const roles = $derived((dashboardStore.state.discordRoles ?? []) as { id: string; name: string }[]);
</script>

{#snippet channelSelect(field: string, label: string, help = '', list = channels)}
  <label class="block">
    <span class="text-xs font-medium text-on-surface-variant">{label}</span>
    <select
      bind:value={config[field]}
      class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
    >
      <option value={null}>Aucun</option>
      {#each list as item (item.id)}
        <option value={item.id}>{item.name}</option>
      {/each}
    </select>
    {#if help}<p class="text-2xs text-on-surface-variant mt-1">{help}</p>{/if}
  </label>
{/snippet}

{#snippet roleSelect(field: string, label: string, help = '')}
  <label class="block">
    <span class="text-xs font-medium text-on-surface-variant">{label}</span>
    <select
      bind:value={config[field]}
      class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
    >
      <option value={null}>Aucun</option>
      {#each roles as role (role.id)}
        <option value={role.id}>{role.name}</option>
      {/each}
    </select>
    {#if help}<p class="text-2xs text-on-surface-variant mt-1">{help}</p>{/if}
  </label>
{/snippet}

{#snippet numberField(field: string, label: string, min: number, max: number, help = '')}
  <label class="block">
    <span class="text-xs font-medium text-on-surface-variant">{label}</span>
    <input
      type="number" {min} {max}
      bind:value={config[field]}
      class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
    />
    {#if help}<p class="text-2xs text-on-surface-variant mt-1">{help}</p>{/if}
  </label>
{/snippet}

<div class="space-y-3">
  <div class="flex items-start justify-between gap-4 rounded-xl border border-outline-variant/30 px-4 py-3">
    <div class="min-w-0">
      <p class="text-body-sm font-medium text-on-surface">Captcha</p>
      <p class="text-xs text-on-surface-variant mt-1 leading-relaxed">Les arrivants doivent résoudre un code avant d'accéder au serveur.</p>
    </div>
    <ToggleSwitch checked={Boolean(config.captchaEnabled)} onToggle={(v) => (config.captchaEnabled = v)} />
  </div>

  <label class="block">
    <span class="text-xs font-medium text-on-surface-variant">Mode</span>
    <select
      bind:value={config.captchaMode}
      class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
    >
      <option value="IMAGE">Image - le code est affiché</option>
      <option value="VOICE">Vocal - le code est énoncé en salon vocal</option>
    </select>
    <p class="text-2xs text-on-surface-variant mt-1">
      Le vocal est bien plus difficile à automatiser, mais la diffusion est sérielle : au-delà de la file configurée, les arrivants suivants basculent sur l'image.
    </p>
  </label>

  <div class="grid sm:grid-cols-2 gap-3">
    {@render channelSelect('captchaChannelId', 'Salon de vérification')}
    {@render roleSelect('captchaUnverifiedRoleId', 'Rôle « non vérifié »', 'Appliqué à l\'arrivée, retiré après réussite.')}
    {@render roleSelect('captchaVerifiedRoleId', 'Rôle « vérifié »', 'Accordé après réussite.')}
    {@render channelSelect('captchaLogChannelId', 'Salon de logs du captcha')}
  </div>

  {#if config.captchaMode === 'VOICE'}
    <div class="grid sm:grid-cols-3 gap-3 rounded-xl border border-outline-variant/30 p-3">
      {@render channelSelect('captchaVoiceChannelId', 'Salon vocal', '', voiceChannels)}
      <label class="block">
        <span class="text-xs font-medium text-on-surface-variant">Langue d'énonciation</span>
        <select
          bind:value={config.captchaVoiceLocale}
          class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
        >
          <option value="FR">Français</option>
          <option value="EN">Anglais</option>
        </select>
      </label>
      {@render numberField('captchaVoiceQueueLimit', 'Limite de file', 1, 200, 'Au-delà, bascule sur l\'image.')}
    </div>
  {/if}

  <div class="grid sm:grid-cols-3 gap-3">
    {@render numberField('captchaTimeoutMinutes', 'Délai (minutes)', 1, 120)}
    {@render numberField('captchaMaxAttempts', 'Tentatives', 1, 10)}
    <label class="block">
      <span class="text-xs font-medium text-on-surface-variant">Échec</span>
      <select
        bind:value={config.captchaFailAction}
        class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
      >
        <option value="KICK">Expulser</option>
        <option value="BAN">Bannir</option>
      </select>
    </label>
  </div>
</div>
