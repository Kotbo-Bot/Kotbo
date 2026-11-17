<script lang="ts">
  import { m } from '../lib/i18n';
  import PrivacyNotice from '../lib/components/PrivacyNotice.svelte';
  import { onMount } from 'svelte';
  import { API_BASE_URL } from '../lib/api';
  import Papicon from '../lib/components/Papicon.svelte';
  import { brandingStore } from '../lib/stores/branding.svelte';
  import '../lib/components/admin/admin-theme.css';

  const { guildId = '', token = '' }: { guildId: string; token: string } = $props();

  let loading = $state(true);
  let verifying = $state(false);
  let error = $state<string | null>(null);
  let sessionInfo = $state<{
    guildName: string;
    guildIcon: string | null;
    title: string;
    color: string;
    userId: string;
    expiresAt: string;
  } | null>(null);
  let result = $state<{
    success: boolean;
    message: string;
    duplicateDetected: boolean;
    duplicateUserId?: string;
    inviteUrl?: string | null;
  } | null>(null);

  function getApiBase(): string {
    return API_BASE_URL || window.location.origin;
  }

  // Même habillage que la page de connexion : les jetons du thème admin ne
  // vivent que sous `html.admin-theme`.
  onMount(() => {
    document.documentElement.classList.add('admin-theme');
    return () => {
      requestAnimationFrame(() => {
        if (!document.querySelector('.admin-console')) {
          document.documentElement.classList.remove('admin-theme');
        }
      });
    };
  });

  onMount(async () => {
    const urlParams = new URLSearchParams(window.location.search);

    const errorParam = urlParams.get('error');
    if (errorParam) {
      error = getErrorMessage(errorParam);
      loading = false;
      return;
    }

    const resultParam = urlParams.get('result');
    if (resultParam) {
      try {
        const binaryString = atob(resultParam.replace(/-/g, '+').replace(/_/g, '/'));
        const bytes = Uint8Array.from(binaryString, c => c.charCodeAt(0));
        result = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        error = m.vfy_err_result();
      }
      loading = false;
      return;
    }

    if (!guildId || !token) {
      error = m.vfy_err_link();
      loading = false;
      return;
    }

    try {
      const res = await fetch(`${getApiBase()}/api/verify/${guildId}/${token}`);
      if (res.ok) {
        sessionInfo = await res.json();
      } else {
        const data = await res.json().catch(() => ({}));
        error = data.error || m.vfy_err_session();
      }
    } catch {
      error = m.vfy_err_network();
    }

    loading = false;
  });

  function getErrorMessage(code: string): string {
    switch (code) {
      case 'expired': return m.vfy_err_expired();
      case 'oauth_failed': return m.vfy_err_oauth();
      case 'oauth_config': return m.vfy_err_oauth_config();
      case 'user_fetch': return m.vfy_err_user();
      case 'invalid_state': return m.vfy_err_state();
      case 'missing_params': return m.vfy_err_params();
      default: return m.vfy_err_generic();
    }
  }

  function startOAuth() {
    verifying = true;

    let clientInfo: any = {};
    try {
      clientInfo = {
        userAgent: navigator.userAgent,
        platform: navigator.platform || (navigator as any).userAgentData?.platform || 'inconnu',
        language: navigator.language,
        screenResolution: `${window.screen.width}x${window.screen.height}`,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'inconnu',
        deviceMemory: (navigator as any).deviceMemory || null,
        hardwareConcurrency: navigator.hardwareConcurrency || null,
      };
    } catch (e) {
      console.error('Failed to collect hardware/software info:', e);
    }

    let clientInfoParam = '';
    try {
      const jsonStr = JSON.stringify(clientInfo);
      const base64 = btoa(encodeURIComponent(jsonStr).replace(/%([0-9A-F]{2})/g, (_, p1) => String.fromCharCode(parseInt(p1, 16))));
      clientInfoParam = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    } catch (e) {
      console.error('Failed to encode clientInfo:', e);
    }

    const url = new URL(`${getApiBase()}/api/verify/${guildId}/${token}/oauth`);
    if (clientInfoParam) {
      url.searchParams.set('clientInfo', clientInfoParam);
    }
    window.location.href = url.toString();
  }

  function getTimeRemaining(): string {
    if (!sessionInfo?.expiresAt) return '';
    const diff = new Date(sessionInfo.expiresAt).getTime() - Date.now();
    if (diff <= 0) return m.vfy_expired();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return m.vfy_time_left({ hours, minutes });
  }

  const infoItems = $derived([
    { icon: 'shield-check', title: m.vfy_secure(), desc: m.vfy_secure_desc() },
    { icon: 'lock', title: m.vfy_anti_dc(), desc: m.vfy_anti_dc_desc() },
    { icon: 'clock', title: m.vfy_expires_in({ time: getTimeRemaining() }), desc: m.vfy_expires_desc() },
  ]);
</script>

<div class="admin-wash min-h-screen w-full bg-background text-on-surface font-body flex flex-col px-4 sm:px-8 py-6">
  <div class="flex items-center gap-2.5">
    <img src={brandingStore.logoUrl || '/favicon.svg'} alt="" class="w-7 h-7 rounded-xl" />
    <span class="font-headline text-xl font-bold tracking-tight leading-none">{brandingStore.brandName}</span>
  </div>

  <main class="grow flex items-center justify-center py-8">
    <div class="w-full max-w-md">
      {#if loading}
        <div class="admin-surface p-10 text-center" role="status">
          <span class="spinner mx-auto mb-4 block" aria-hidden="true"></span>
          <p class="text-sm text-on-surface-variant">{m.vfy_loading()}</p>
        </div>
      {:else if error}
        <div class="admin-surface p-8 sm:p-10 text-center" role="alert">
          <div class="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-error/10 text-error">
            <Papicon icon="warning" size={26} />
          </div>
          <h1 class="font-headline text-2xl font-bold tracking-tight mb-1.5">{m.vfy_error_title()}</h1>
          <p class="text-sm text-error mb-5 wrap-break-word">{error}</p>
          <p class="text-xs text-on-surface-variant">{m.vfy_error_hint()}</p>
        </div>
      {:else if result}
        <div class="admin-surface p-8 sm:p-10 text-center">
          {#if result.duplicateDetected}
            <div class="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-warning/15 text-warning">
              <Papicon icon="warning" size={26} />
            </div>
            <h1 class="font-headline text-2xl font-bold tracking-tight mb-1.5">{m.vfy_duplicate()}</h1>
            <p class="text-sm text-on-surface-variant mb-5">{result.message}</p>
            {#if result.duplicateUserId}
              <div class="rounded-2xl bg-surface-container px-4 py-3">
                <p class="text-xs text-on-surface-variant">{m.vfy_linked_account()} <span class="font-mono text-on-surface">{result.duplicateUserId}</span></p>
              </div>
            {/if}
          {:else}
            <div class="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-success/15 text-success">
              <Papicon icon="check" size={26} />
            </div>
            <h1 class="font-headline text-2xl font-bold tracking-tight mb-1.5">{m.vfy_success()}</h1>
            <p class="text-sm text-on-surface-variant">{result.message}</p>
            {#if result.inviteUrl}
              <a
                href={result.inviteUrl}
                target="_blank"
                rel="noopener noreferrer"
                class="admin-press mt-7 w-full h-12 flex items-center justify-center gap-2.5 px-5 rounded-full bg-primary text-on-primary font-semibold text-sm shadow-sm hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                <Papicon icon="log-in" size={18} />
                {m.vfy_join()}
              </a>
            {/if}
          {/if}
        </div>
      {:else if sessionInfo}
        <div class="admin-surface p-7 sm:p-8">
          <div class="flex items-center gap-4 mb-6">
            {#if sessionInfo.guildIcon}
              <img src={sessionInfo.guildIcon} alt="" class="h-14 w-14 shrink-0 rounded-2xl" />
            {:else}
              <div class="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-primary/10 font-headline text-2xl font-bold text-primary">
                {sessionInfo.guildName.charAt(0)}
              </div>
            {/if}
            <div class="min-w-0">
              <h1 class="font-headline text-2xl font-bold tracking-tight leading-tight wrap-break-word">{sessionInfo.title}</h1>
              <p class="text-sm text-on-surface-variant truncate">{sessionInfo.guildName}</p>
            </div>
          </div>

          <ul class="space-y-4 mb-7">
            {#each infoItems as item (item.icon)}
              <li class="flex items-start gap-3">
                <span class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Papicon icon={item.icon} size={17} />
                </span>
                <div class="min-w-0">
                  <p class="text-sm font-semibold">{item.title}</p>
                  <p class="mt-0.5 text-xs text-on-surface-variant leading-relaxed">{item.desc}</p>
                </div>
              </li>
            {/each}
          </ul>

          <button
            type="button"
            onclick={startOAuth}
            disabled={verifying}
            aria-busy={verifying}
            class="admin-press w-full h-12 flex items-center justify-center gap-2.5 px-5 rounded-full bg-primary text-on-primary font-semibold text-sm shadow-sm hover:brightness-110 disabled:cursor-wait disabled:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {#if verifying}
              <span class="spinner" aria-hidden="true"></span>
              {m.vfy_redirecting()}
            {:else}
              <Papicon icon="discord" size={18} />
              {m.vfy_verify()}
            {/if}
          </button>

          <p class="mt-4 text-center text-2xs text-on-surface-variant">{m.vfy_consent()}</p>

          <div class="mt-4 rounded-2xl bg-surface-container px-4 py-3.5">
            <p class="mb-1.5 text-xs font-semibold">{m.vfy_data_title()}</p>
            <ul class="list-disc list-inside space-y-1 text-2xs leading-relaxed text-on-surface-variant">
              <li>{m.vfy_data_identity()}</li>
              <li>{m.vfy_data_ip()}</li>
              <li>{m.vfy_data_device()}</li>
              <li>{m.vfy_data_oauth()}</li>
            </ul>
          </div>

          <div class="mt-3">
            <PrivacyNotice compact showDpa text={m.vfy_data_purpose()} />
          </div>
        </div>
      {/if}
    </div>
  </main>

  <p class="text-center text-xs text-on-surface-variant">{m.vfy_footer()}</p>
</div>

<style>
  .spinner {
    width: 15px;
    height: 15px;
    border-radius: 9999px;
    border: 2px solid color-mix(in srgb, currentColor 30%, transparent);
    border-top-color: currentColor;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation-duration: 2s;
    }
  }
</style>
