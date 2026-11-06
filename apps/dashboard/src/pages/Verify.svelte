<script lang="ts">
  import { m } from '../lib/i18n';
  import PrivacyNotice from '../lib/components/PrivacyNotice.svelte';
  import { onMount } from 'svelte';
  import { API_BASE_URL } from '../lib/api';

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
</script>

<div class="min-h-screen bg-[#0a0a0f] flex items-center justify-center p-4">
  <div class="w-full max-w-md">
    {#if loading}
      <div class="bg-[#12121a] border border-white/5 rounded-2xl p-10 text-center">
        <div class="animate-spin w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full mx-auto mb-4"></div>
        <p class="text-white/60 text-sm">{m.vfy_loading()}</p>
      </div>
    {:else if error}
      <div class="bg-[#12121a] border border-red-500/20 rounded-2xl p-10 text-center">
        <div class="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
          <svg class="w-8 h-8 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
        </div>
        <h2 class="text-white text-xl font-bold mb-2">{m.vfy_error_title()}</h2>
        <p class="text-red-300/80 text-sm mb-6">{error}</p>
        <p class="text-white/30 text-xs">{m.vfy_error_hint()}</p>
      </div>
    {:else if result}
      <div class="bg-[#12121a] border border-{result.duplicateDetected ? 'amber' : 'emerald'}-500/20 rounded-2xl p-10 text-center">
        {#if result.duplicateDetected}
          <div class="w-16 h-16 bg-amber-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
            <svg class="w-8 h-8 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <h2 class="text-white text-xl font-bold mb-2">{m.vfy_duplicate()}</h2>
          <p class="text-amber-300/80 text-sm mb-4">{result.message}</p>
          {#if result.duplicateUserId}
            <div class="bg-amber-500/5 border border-amber-500/15 rounded-lg p-3 mb-4">
              <p class="text-amber-300/60 text-xs">{m.vfy_linked_account()} <span class="font-mono text-amber-300">{result.duplicateUserId}</span></p>
            </div>
          {/if}
        {:else}
          <div class="w-16 h-16 bg-emerald-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
            <svg class="w-8 h-8 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 class="text-white text-xl font-bold mb-2">{m.vfy_success()}</h2>
          <p class="text-emerald-300/80 text-sm mb-4">{result.message}</p>
          {#if result.inviteUrl}
            <div class="mt-6">
              <a href={result.inviteUrl} target="_blank" rel="noopener noreferrer"
                class="inline-flex items-center justify-center gap-2 px-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-xl transition-all w-full text-center">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                </svg>
                {m.vfy_join()}
              </a>
            </div>
          {/if}
        {/if}
      </div>
    {:else if sessionInfo}
      <div class="bg-[#12121a] border border-white/5 rounded-2xl overflow-hidden">
        <!-- Header -->
        <div class="p-8 border-b border-white/5 text-center">
          {#if sessionInfo.guildIcon}
            <img src={sessionInfo.guildIcon} alt={sessionInfo.guildName} class="w-16 h-16 rounded-full mx-auto mb-4 border-2 border-white/10" />
          {:else}
            <div class="w-16 h-16 bg-indigo-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <span class="text-2xl font-bold text-indigo-300">{sessionInfo.guildName.charAt(0)}</span>
            </div>
          {/if}
          <h1 class="text-white text-xl font-bold mb-1">{sessionInfo.title}</h1>
          <p class="text-white/40 text-sm">{sessionInfo.guildName}</p>
        </div>

        <!-- Content -->
        <div class="p-8">
          <div class="space-y-4 mb-8">
            <div class="flex items-start gap-3">
              <div class="w-8 h-8 bg-indigo-500/10 rounded-lg flex items-center justify-center shrink-0 mt-0.5">
                <svg class="w-4 h-4 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
              </div>
              <div>
                <p class="text-white/80 text-sm font-medium">{m.vfy_secure()}</p>
                <p class="text-white/40 text-xs mt-0.5">{m.vfy_secure_desc()}</p>
              </div>
            </div>

            <div class="flex items-start gap-3">
              <div class="w-8 h-8 bg-indigo-500/10 rounded-lg flex items-center justify-center shrink-0 mt-0.5">
                <svg class="w-4 h-4 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <div>
                <p class="text-white/80 text-sm font-medium">{m.vfy_anti_dc()}</p>
                <p class="text-white/40 text-xs mt-0.5">{m.vfy_anti_dc_desc()}</p>
              </div>
            </div>

            <div class="flex items-start gap-3">
              <div class="w-8 h-8 bg-indigo-500/10 rounded-lg flex items-center justify-center shrink-0 mt-0.5">
                <svg class="w-4 h-4 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div>
                <p class="text-white/80 text-sm font-medium">{m.vfy_expires_in({ time: getTimeRemaining() })}</p>
                <p class="text-white/40 text-xs mt-0.5">{m.vfy_expires_desc()}</p>
              </div>
            </div>
          </div>

          <button
            onclick={startOAuth}
            disabled={verifying}
            class="w-full py-3 px-6 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-600/50 text-white font-semibold rounded-xl transition-all flex items-center justify-center gap-2"
          >
            {#if verifying}
              <div class="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full"></div>
              {m.vfy_redirecting()}
            {:else}
              <svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03z"/>
              </svg>
              {m.vfy_verify()}
            {/if}
          </button>

          <p class="text-white/20 text-2xs text-center mt-4">
            {m.vfy_consent()}
          </p>

          <div class="mt-4 rounded-lg border border-white/5 bg-white/3 px-3 py-2.5">
            <p class="text-white/50 text-xs font-semibold mb-1.5">{m.vfy_data_title()}</p>
            <ul class="text-white/40 text-2xs leading-relaxed space-y-1 list-disc list-inside">
              <li>{m.vfy_data_identity()}</li>
              <li>{m.vfy_data_ip()}</li>
              <li>{m.vfy_data_device()}</li>
              <li>{m.vfy_data_oauth()}</li>
            </ul>
          </div>

          <div class="mt-3">
            <PrivacyNotice
              compact
              showDpa
              text={m.vfy_data_purpose()}
            />
          </div>
        </div>
      </div>
    {/if}

    <!-- Footer -->
    <div class="text-center mt-6">
      <p class="text-white/20 text-2xs">{m.vfy_footer()}</p>
    </div>
  </div>
</div>
