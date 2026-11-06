<script lang="ts">
  import { m, dateLocale } from '../i18n';
  import { onMount } from 'svelte';
  import { fetchWidgetData, activateWidget, deactivateWidget, refreshWidget, refreshAllWidgets, rotateWidgetToken, API_BASE_URL } from '../api';
  import { toast } from '../stores/toast.svelte';
  import Papicon from './Papicon.svelte';
  import LoadingHint from './LoadingHint.svelte';
  import Button from './ui/Button.svelte';

  let loading = $state(true);
  let acting = $state(false);
  let copyingScript = $state(false);
  let copiedField: string | null = $state(null);
  let rotatingToken = $state(false);
  let showToken = $state(false);
  let data: any = $state(null);

  const isActive = $derived(data?.mySubscription?.enabled === true);
  const subscriptionCount = $derived(data?.subscriptions?.length ?? 0);
  const widgetToken = $derived(data?.mySubscription?.token ?? null);
  const apiOrigin = $derived(API_BASE_URL || (typeof window !== 'undefined' ? window.location.origin : ''));
  const widgetDataUrl = $derived(widgetToken ? `${apiOrigin}/api/public/widget-data?token=${widgetToken}` : '');

  async function copy(text: string, field: string) {
    try {
      await navigator.clipboard.writeText(text);
      copiedField = field;
      setTimeout(() => { if (copiedField === field) copiedField = null; }, 1500);
    } catch {
      toast.error(m.pwp_copy_failed());
    }
  }

  function syncServiceWorkerConfig() {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker || !widgetToken) return;
    navigator.serviceWorker.ready
      .then((reg) => reg.active?.postMessage({ type: 'KOTBO_WIDGET_CONFIG', token: widgetToken, apiBase: apiOrigin }))
      .catch(() => {});
  }

  async function handleRotateToken() {
    rotatingToken = true;
    try {
      const result = await rotateWidgetToken();
      if (result?.token && data?.mySubscription) {
        data = { ...data, mySubscription: { ...data.mySubscription, token: result.token } };
        toast.success(m.pwp_token_rotated());
        syncServiceWorkerConfig();
      }
    } catch {
      toast.error(m.pwp_token_rotate_failed());
    } finally {
      rotatingToken = false;
    }
  }

  async function load() {
    loading = true;
    try {
      data = await fetchWidgetData();
      syncServiceWorkerConfig();
    } catch {
      toast.error(m.d7_loading_error());
    } finally {
      loading = false;
    }
  }

  async function handleActivate() {
    acting = true;
    try {
      const result = await activateWidget();
      if (result?.pushResult?.ok === false) {
        toast.warning(result.pushResult.error || m.pwp_sync_failed());
      } else {
        toast.success(m.pwp_synced());
      }
      await load();
    } catch {
      toast.error(m.pwp_activate_failed());
    } finally {
      acting = false;
    }
  }

  async function handleCopyVencordScript() {
    copyingScript = true;
    try {
      const response = await fetch('/kotbo-widget-discord-v2.js', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await navigator.clipboard.writeText(await response.text());
      toast.success(m.pwp_script_copied());
    } catch {
      toast.error(m.pwp_script_copy_failed());
    } finally {
      copyingScript = false;
    }
  }

  async function handleDeactivate() {
    acting = true;
    try {
      await deactivateWidget();
      toast.success(m.pwp_disabled());
      await load();
    } catch {
      toast.error(m.pwp_disable_failed());
    } finally {
      acting = false;
    }
  }

  async function handleRefresh() {
    acting = true;
    try {
      const result = await refreshWidget();
      if (result?.pushResult?.ok) {
        toast.success(m.pwp_refreshed());
      }
    } catch {
      toast.error(m.pulse_refresh_error());
    } finally {
      acting = false;
    }
  }

  async function handleRefreshAll() {
    acting = true;
    try {
      const result = await refreshAllWidgets();
      const failures = Array.isArray(result?.failures) ? result.failures : [];
      if (failures.length > 0) {
        toast.warning(m.pwp_refresh_all_partial({ success: result?.success ?? 0, failed: result?.failed ?? 0, details: failures.map((f: any) => `${f.userId}: ${f.error}`).join(' · ') }));
      } else {
        toast.success(m.pwp_refresh_all_done({ success: result?.success ?? 0 }));
      }
    } catch {
      toast.error(m.pwp_refresh_all_failed());
    } finally {
      acting = false;
    }
  }

  onMount(load);
</script>

<!-- ======================== CONTENT ======================== -->
{#if loading}
  <div class="flex flex-col items-center justify-center py-16 text-on-surface-variant">
    <p class="text-sm">{m.pwp_loading()}</p>
    <LoadingHint context="data" />
  </div>
{:else}
  <!-- ======================== STATS ROW ======================== -->
  <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
    <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-4 flex items-center gap-3">
      <div class="w-10 h-10 rounded-xl flex items-center justify-center {isActive ? 'bg-success/10 text-success' : 'bg-surface-container-high/30 text-on-surface-variant'}">
        <Papicon icon={isActive ? 'check-circle' : 'x-circle'} size={20} />
      </div>
      <div class="flex flex-col">
        <span class="text-2xl font-bold">{isActive ? m.pwp_active() : m.pwp_inactive()}</span>
        <span class="text-xs font-medium text-on-surface-variant mt-0.5">{m.pwp_your_widget()}</span>
      </div>
    </div>
    <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-4 flex items-center gap-3">
      <div class="w-10 h-10 rounded-xl flex items-center justify-center bg-primary/10 text-primary">
        <Papicon icon="users" size={20} />
      </div>
      <div class="flex flex-col">
        <span class="text-2xl font-bold">{subscriptionCount}</span>
        <span class="text-xs font-medium text-on-surface-variant mt-0.5">{m.pwp_active_widgets()}</span>
      </div>
    </div>
  </div>

  <!-- ======================== GRID ======================== -->
  <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">

    <!-- Actions card -->
    <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
      <h3 class="text-base font-semibold flex items-center gap-2.5">
        <Papicon icon="zap" size={18} />
        {m.pwp_actions()}
      </h3>
      <div class="flex flex-col gap-3">
        {#if isActive}
          <Button variant="primary" icon="refresh-cw" onclick={handleRefresh} disabled={acting}>
            {m.pwp_refresh_mine()}
          </Button>
          <Button variant="danger" icon="x" onclick={handleDeactivate} disabled={acting}>
            {m.pwp_disable()}
          </Button>
        {:else}
          <Button variant="primary" icon="check" onclick={handleActivate} disabled={acting}>
            {m.pwp_enable()}
          </Button>
        {/if}

        <Button variant="secondary" icon="refresh-cw" onclick={handleRefreshAll} disabled={acting}>
          {m.pwp_refresh_all()}
        </Button>
      </div>
    </div>

    <!-- How it works card -->
    <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
      <h3 class="text-base font-semibold flex items-center gap-2.5">
        <Papicon icon="info" size={18} />
        {m.pwp_how()}
      </h3>
      <div class="flex flex-col gap-4">
        <div class="flex items-start gap-3">
          <span class="shrink-0 w-7 h-7 bg-primary text-on-primary rounded-full flex items-center justify-center text-xs font-bold">1</span>
          <span class="text-sm text-on-surface-variant leading-relaxed">{m.pwp_step1()}</span>
        </div>
        <div class="flex items-start gap-3">
          <span class="shrink-0 w-7 h-7 bg-primary text-on-primary rounded-full flex items-center justify-center text-xs font-bold">2</span>
          <span class="text-sm text-on-surface-variant leading-relaxed">{m.pwp_step2_before()} <code class="bg-surface-container-high/50 px-1.5 py-0.5 rounded text-xs">/widget activer</code> {m.pwp_step2_after()}</span>
        </div>
        <div class="flex items-start gap-3">
          <span class="shrink-0 w-7 h-7 bg-primary text-on-primary rounded-full flex items-center justify-center text-xs font-bold">3</span>
          <span class="text-sm text-on-surface-variant leading-relaxed">{m.pwp_step3()} <kbd class="font-mono text-xs">Ctrl+R</kbd>.</span>
        </div>
      </div>
    </div>

    {#if isActive}
      <section class="lg:col-span-2 relative overflow-hidden rounded-xl border border-warning/20 bg-warning/[0.04] p-6">
        <div class="absolute -right-12 -top-16 h-44 w-44 rounded-full bg-warning/10 blur-3xl pointer-events-none"></div>
        <div class="relative grid gap-6 lg:grid-cols-[1fr_auto] lg:items-center">
          <div class="space-y-3">
            <div class="flex items-center gap-2 text-warning">
              <Papicon icon="terminal" size={18} />
              <span class="text-xs font-semibold">{m.pwp_local_install()}</span>
            </div>
            <h3 class="text-base font-semibold text-on-surface">{m.pwp_board_title()}</h3>
            <p class="max-w-2xl text-sm leading-relaxed text-on-surface-variant">
              {m.pwp_board_desc()}
            </p>
            <ol class="grid gap-2 text-xs text-on-surface-variant sm:grid-cols-2 lg:grid-cols-4">
              <li><span class="mr-1.5 font-mono text-warning">01</span> {m.pwp_board_s1()}</li>
              <li><span class="mr-1.5 font-mono text-warning">02</span> {m.pwp_board_s2()}</li>
              <li><span class="mr-1.5 font-mono text-warning">03</span> {m.pwp_board_s3()}</li>
              <li><span class="mr-1.5 font-mono text-warning">04</span> {m.pwp_board_s4()}</li>
            </ol>
          </div>
          <div class="flex min-w-56 flex-col gap-2">
            <Button variant="primary" icon="copy" onclick={handleCopyVencordScript} loading={copyingScript}>
              {copyingScript ? m.pwp_copying() : m.pwp_copy_script()}
            </Button>
            <a
              href="/kotbo-widget-discord-v2.js"
              target="_blank"
              rel="noreferrer"
              class="text-center text-2xs text-on-surface-variant underline decoration-outline-variant underline-offset-4 hover:text-on-surface"
            >{m.pwp_view_file()}</a>
          </div>
        </div>
      </section>
    {/if}

    <!-- ==================== WIDGETS TÉLÉPHONE & PC ==================== -->
    {#if isActive}
      <section class="lg:col-span-2 rounded-xl border border-outline-variant/10 bg-surface-container-low/30 p-6 space-y-5">
        <div>
          <h3 class="text-base font-semibold flex items-center gap-2.5">
            <Papicon icon="smartphone" size={18} />
            {m.pwp_devices_title()}
          </h3>
          <p class="mt-1 text-xs text-on-surface-variant">
            {m.pwp_devices_desc()}
          </p>
        </div>

        <!-- Token widget -->
        <div class="rounded-lg border border-outline-variant/10 bg-surface-container-high/20 p-4 space-y-2">
          <p class="text-xs font-semibold text-on-surface-variant">{m.pwp_token()}</p>
          <div class="flex items-center gap-2">
            <code class="flex-1 min-w-0 truncate rounded-lg border border-outline-variant/10 bg-surface-container-highest/40 px-3 py-2 font-mono text-xs text-on-surface">
              {showToken ? (widgetToken ?? '-') : '••••••••••••••••••••••••••••••••'}
            </code>
            <button
              class="shrink-0 rounded-lg border border-outline-variant/20 px-2.5 py-2 text-2xs text-on-surface-variant hover:text-on-surface transition-colors"
              onclick={() => showToken = !showToken}
            >
              {showToken ? m.pwp_hide() : m.pwp_show()}
            </button>
            <button
              class="shrink-0 rounded-lg border border-outline-variant/20 px-2.5 py-2 text-2xs text-on-surface-variant hover:text-on-surface transition-colors"
              onclick={() => widgetToken && copy(widgetToken, 'token')}
            >
              {copiedField === 'token' ? m.pwp_copied() : m.pwp_copy()}
            </button>
            <button
              class="shrink-0 rounded-lg border border-outline-variant/20 px-2.5 py-2 text-2xs text-on-surface-variant hover:text-on-surface transition-colors disabled:opacity-50"
              onclick={handleRotateToken}
              disabled={rotatingToken}
              aria-label={m.pwp_rotate_token()}
              title={m.pwp_rotate_token()}
            >
              <Papicon icon="refresh-cw" size={14} />
            </button>
          </div>
          <p class="text-2xs text-on-surface-variant">
            {m.pwp_token_hint()}
          </p>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <!-- iOS / Scriptable -->
          <div class="rounded-lg border border-outline-variant/10 bg-surface-container-high/10 p-4 space-y-3">
            <div class="flex items-center gap-2 text-on-surface">
              <Papicon icon="apple" size={16} />
              <span class="text-sm font-semibold">iOS · Scriptable</span>
            </div>
            <ol class="space-y-1.5 text-xs text-on-surface-variant leading-relaxed list-decimal list-inside">
              <li>{m.pwp_ios_s1_before()} <strong>Scriptable</strong> {m.pwp_ios_s1_after()}</li>
              <li>{m.pwp_ios_s2()}</li>
              <li>{m.pwp_ios_s3()}</li>
              <li>{m.pwp_ios_s4()} <code class="text-2xs">{widgetToken}|{apiOrigin}</code></li>
            </ol>
            <div class="flex flex-col gap-1.5">
              <a
                href="/mobile-widgets/kotbo-widget.scriptable.js"
                target="_blank"
                rel="noreferrer"
                class="inline-flex items-center justify-center gap-2 rounded-lg bg-surface-container-highest/50 px-3 py-2 text-xs font-semibold text-on-surface hover:bg-surface-container-highest/70 transition-colors"
              >
                <Papicon icon="download" size={13} />
                {m.pwp_download_script()}
              </a>
              <button
                class="text-2xs text-on-surface-variant underline decoration-outline-variant underline-offset-4 hover:text-on-surface"
                onclick={() => widgetToken && copy(`${widgetToken}|${apiOrigin}`, 'ios-param')}
              >{copiedField === 'ios-param' ? m.pwp_copied() : m.pwp_copy_param()}</button>
            </div>
          </div>

          <!-- Android / KWGT -->
          <div class="rounded-lg border border-outline-variant/10 bg-surface-container-high/10 p-4 space-y-3">
            <div class="flex items-center gap-2 text-on-surface">
              <Papicon icon="smartphone" size={16} />
              <span class="text-sm font-semibold">Android · KWGT</span>
            </div>
            <ol class="space-y-1.5 text-xs text-on-surface-variant leading-relaxed list-decimal list-inside">
              <li>{m.pwp_android_s1_before()} <strong>KWGT Kustom Widget Maker</strong> {m.pwp_android_s1_after()}</li>
              <li>{m.pwp_android_s2()}</li>
              <li>{m.pwp_android_s3()}</li>
            </ol>
            <div class="flex flex-col gap-1.5">
              <a
                href="/mobile-widgets/kwgt-guide.txt"
                target="_blank"
                rel="noreferrer"
                class="inline-flex items-center justify-center gap-2 rounded-lg bg-surface-container-highest/50 px-3 py-2 text-xs font-semibold text-on-surface hover:bg-surface-container-highest/70 transition-colors"
              >
                <Papicon icon="download" size={13} />
                {m.pwp_view_guide()}
              </a>
              <button
                class="text-2xs text-on-surface-variant underline decoration-outline-variant underline-offset-4 hover:text-on-surface"
                onclick={() => copy(widgetDataUrl, 'android-url')}
              >{copiedField === 'android-url' ? m.pwp_copied() : m.pwp_copy_data_url()}</button>
            </div>
          </div>

          <!-- Windows 11 / Edge -->
          <div class="rounded-lg border border-outline-variant/10 bg-surface-container-high/10 p-4 space-y-3">
            <div class="flex items-center gap-2 text-on-surface">
              <Papicon icon="monitor" size={16} />
              <span class="text-sm font-semibold">Windows 11 · Edge</span>
            </div>
            <ol class="space-y-1.5 text-xs text-on-surface-variant leading-relaxed list-decimal list-inside">
              <li>{m.pwp_win_s1()} <strong>Microsoft Edge</strong></li>
              <li>{m.pwp_win_s2()}</li>
              <li>{m.pwp_win_s3()}</li>
            </ol>
            <p class="text-2xs text-on-surface-variant">
              {m.pwp_win_note()}
            </p>
          </div>

          <!-- Linux / Waybar & Conky -->
          <div class="rounded-lg border border-outline-variant/10 bg-surface-container-high/10 p-4 space-y-3">
            <div class="flex items-center gap-2 text-on-surface">
              <Papicon icon="terminal" size={16} />
              <span class="text-sm font-semibold">Linux · Waybar / Conky</span>
            </div>
            <ol class="space-y-1.5 text-xs text-on-surface-variant leading-relaxed list-decimal list-inside">
              <li>{m.pwp_linux_s1()}</li>
              <li>{m.pwp_linux_s2_before()} <code class="text-2xs">chmod +x</code> {m.pwp_linux_s2_after()}</li>
              <li>{m.pwp_linux_s3()}</li>
            </ol>
            <div class="flex flex-col gap-1.5">
              <a
                href="/desktop-widgets/linux-widgets-guide.txt"
                target="_blank"
                rel="noreferrer"
                class="inline-flex items-center justify-center gap-2 rounded-lg bg-surface-container-highest/50 px-3 py-2 text-xs font-semibold text-on-surface hover:bg-surface-container-highest/70 transition-colors"
              >
                <Papicon icon="download" size={13} />
                {m.pwp_view_guide()}
              </a>
              <button
                class="text-2xs text-on-surface-variant underline decoration-outline-variant underline-offset-4 hover:text-on-surface"
                onclick={() => copy(widgetDataUrl, 'linux-url')}
              >{copiedField === 'linux-url' ? m.pwp_copied() : m.pwp_copy_data_url()}</button>
            </div>
          </div>
        </div>
      </section>
    {/if}

    <!-- Active staff list card -->
    {#if data?.subscriptions?.length > 0}
      <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
        <h3 class="text-base font-semibold flex items-center gap-2.5">
          <Papicon icon="users" size={18} />
          {m.pwp_staff_title()}
        </h3>
        <div class="flex flex-col divide-y divide-outline-variant/10">
          {#each data.subscriptions.filter((s: any) => s.enabled) as sub}
            <div class="flex items-center gap-4 py-3">
              <span class="flex-1 font-mono text-sm text-on-surface">{sub.userId}</span>
              <span class="text-xs text-on-surface-variant">{new Date(sub.createdAt).toLocaleDateString(dateLocale())}</span>
              <span class="px-2.5 py-0.5 rounded-full text-xs font-medium bg-success/10 text-success border border-success/15">{m.pwp_active()}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

  </div>
{/if}

