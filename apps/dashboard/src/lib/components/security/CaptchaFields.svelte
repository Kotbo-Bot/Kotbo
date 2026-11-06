<script lang="ts">
  import { m } from '../../i18n';
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
      <option value={null}>{m.common_none()}</option>
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
      <option value={null}>{m.common_none()}</option>
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
      <p class="text-body-sm font-medium text-on-surface">{m.cap_title()}</p>
      <p class="text-xs text-on-surface-variant mt-1 leading-relaxed">{m.cap_desc()}</p>
    </div>
    <ToggleSwitch checked={Boolean(config.captchaEnabled)} onToggle={(v) => (config.captchaEnabled = v)} />
  </div>

  <label class="block">
    <span class="text-xs font-medium text-on-surface-variant">{m.sff_mode()}</span>
    <select
      bind:value={config.captchaMode}
      class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
    >
      <option value="IMAGE">{m.cap_mode_image()}</option>
      <option value="VOICE">{m.cap_mode_voice()}</option>
    </select>
    <p class="text-2xs text-on-surface-variant mt-1">
      {m.cap_voice_hint()}
    </p>
  </label>

  <div class="grid sm:grid-cols-2 gap-3">
    {@render channelSelect('captchaChannelId', m.arx_vision_review_channel())}
    {@render roleSelect('captchaUnverifiedRoleId', m.cap_unverified_role(), m.cap_unverified_help())}
    {@render roleSelect('captchaVerifiedRoleId', m.cap_verified_role(), m.cap_verified_help())}
    {@render channelSelect('captchaLogChannelId', m.cap_log_channel())}
  </div>

  {#if config.captchaMode === 'VOICE'}
    <div class="grid sm:grid-cols-3 gap-3 rounded-xl border border-outline-variant/30 p-3">
      {@render channelSelect('captchaVoiceChannelId', m.cap_voice_channel(), '', voiceChannels)}
      <label class="block">
        <span class="text-xs font-medium text-on-surface-variant">{m.cap_voice_lang()}</span>
        <select
          bind:value={config.captchaVoiceLocale}
          class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
        >
          <option value="FR">{m.cap_lang_fr()}</option>
          <option value="EN">{m.cap_lang_en()}</option>
        </select>
      </label>
      {@render numberField('captchaVoiceQueueLimit', m.cap_queue(), 1, 200, m.cap_queue_help())}
    </div>
  {/if}

  <div class="grid sm:grid-cols-3 gap-3">
    {@render numberField('captchaTimeoutMinutes', m.cap_timeout(), 1, 120)}
    {@render numberField('captchaMaxAttempts', m.cap_attempts(), 1, 10)}
    <label class="block">
      <span class="text-xs font-medium text-on-surface-variant">{m.cap_fail()}</span>
      <select
        bind:value={config.captchaFailAction}
        class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
      >
        <option value="KICK">{m.arx_age_action_kick()}</option>
        <option value="BAN">{m.cap_ban()}</option>
      </select>
    </label>
  </div>
</div>
