<script lang="ts">
  import { m, dateLocale } from '../i18n';
  import { onMount } from 'svelte';
  import { fetchWidgetData, activateWidget, deactivateWidget, refreshWidget, refreshAllWidgets, rotateWidgetToken, API_BASE_URL } from '../api';
  import { toast } from '../stores/toast.svelte';
  import Papicon from './Papicon.svelte';
  import LoadingHint from './LoadingHint.svelte';
  import { Button, SectionCard, StatTile } from './ui';

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

{#if loading}
  <div class="flex flex-col items-center justify-center py-16 text-on-surface-variant">
    <p class="text-sm">{m.pwp_loading()}</p>
    <LoadingHint context="data" />
  </div>
{:else}
  <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
    <StatTile
      icon={isActive ? 'check-circle' : 'x-circle'}
      tone={isActive ? 'bg-success/10 text-success' : 'bg-surface-container text-on-surface-variant'}
      value={isActive ? m.pwp_active() : m.pwp_inactive()}
      label={m.pwp_your_widget()}
    />
    <StatTile
      icon="users"
      tone="bg-primary/10 text-primary"
      value={subscriptionCount}
      label={m.pwp_active_widgets()}
    />
  </div>

  <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">

    <SectionCard title={m.pwp_actions()} icon="zap">
      <div class="flex flex-col gap-2.5">
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
    </SectionCard>

    <SectionCard title={m.pwp_how()} icon="info">
      <div class="flex flex-col gap-4">
        <div class="flex items-start gap-3">
          <span class="shrink-0 w-7 h-7 bg-primary text-on-primary rounded-full flex items-center justify-center text-xs font-bold">1</span>
          <span class="text-sm text-on-surface-variant leading-relaxed">{m.pwp_step1()}</span>
        </div>
        <div class="flex items-start gap-3">
          <span class="shrink-0 w-7 h-7 bg-primary text-on-primary rounded-full flex items-center justify-center text-xs font-bold">2</span>
          <span class="text-sm text-on-surface-variant leading-relaxed">{m.pwp_step2_before()} <code class="bg-surface-container px-1.5 py-0.5 rounded text-xs">/widget activer</code> {m.pwp_step2_after()}</span>
        </div>
        <div class="flex items-start gap-3">
          <span class="shrink-0 w-7 h-7 bg-primary text-on-primary rounded-full flex items-center justify-center text-xs font-bold">3</span>
          <span class="text-sm text-on-surface-variant leading-relaxed">{m.pwp_step3()} <kbd class="font-mono text-xs">Ctrl+R</kbd>.</span>
        </div>
      </div>
    </SectionCard>

    {#if isActive}
      <section class="lg:col-span-2 rounded-2xl border border-warning/25 bg-warning/[0.05] p-5">
        <div class="grid gap-6 lg:grid-cols-[1fr_auto] lg:items-center">
          <div class="space-y-3">
            <div class="flex items-center gap-2 text-warning">
              <Papicon icon="terminal" size={16} />
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

      <div class="lg:col-span-2">
        <SectionCard title={m.pwp_devices_title()} description={m.pwp_devices_desc()} icon="smartphone">
          <div class="space-y-5">
            <!-- Token widget -->
            <div class="rounded-xl border border-outline-variant bg-surface-container-low p-4 space-y-2">
              <p class="text-xs font-semibold text-on-surface-variant">{m.pwp_token()}</p>
              <div class="flex flex-wrap items-center gap-2">
                <code class="flex-1 min-w-0 truncate rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 font-mono text-xs text-on-surface">
                  {showToken ? (widgetToken ?? '-') : '••••••••••••••••••••••••••••••••'}
                </code>
                <Button variant="secondary" size="sm" onclick={() => showToken = !showToken}>
                  {showToken ? m.pwp_hide() : m.pwp_show()}
                </Button>
                <Button variant="secondary" size="sm" onclick={() => widgetToken && copy(widgetToken, 'token')}>
                  {copiedField === 'token' ? m.pwp_copied() : m.pwp_copy()}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  icon="refresh-cw"
                  onclick={handleRotateToken}
                  disabled={rotatingToken}
                  aria-label={m.pwp_rotate_token()}
                  title={m.pwp_rotate_token()}
                />
              </div>
              <p class="text-2xs text-on-surface-variant">
                {m.pwp_token_hint()}
              </p>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <!-- iOS / Scriptable -->
              <div class="rounded-xl border border-outline-variant bg-surface-container-low p-4 space-y-3 flex flex-col justify-between">
                <div class="space-y-3">
                  <div class="flex items-center gap-2 text-on-surface">
                    <Papicon icon="apple" size={16} />
                    <span class="text-sm font-semibold">iOS · Scriptable</span>
                  </div>
                  <ol class="space-y-1.5 text-xs text-on-surface-variant leading-relaxed list-decimal list-inside">
                    <li>{m.pwp_ios_s1_before()} <strong>Scriptable</strong> {m.pwp_ios_s1_after()}</li>
                    <li>{m.pwp_ios_s2()}</li>
                    <li>{m.pwp_ios_s3()}</li>
                    <li>{m.pwp_ios_s4()} <code class="text-2xs break-all">{widgetToken}|{apiOrigin}</code></li>
                  </ol>
                </div>
                <div class="flex flex-col gap-1.5 pt-2">
                  <Button href="/mobile-widgets/kotbo-widget.scriptable.js" target="_blank" variant="secondary" size="sm" icon="download" fullWidth>
                    {m.pwp_download_script()}
                  </Button>
                  <Button variant="ghost" size="sm" fullWidth onclick={() => widgetToken && copy(`${widgetToken}|${apiOrigin}`, 'ios-param')}>
                    {copiedField === 'ios-param' ? m.pwp_copied() : m.pwp_copy_param()}
                  </Button>
                </div>
              </div>

              <!-- Android / KWGT -->
              <div class="rounded-xl border border-outline-variant bg-surface-container-low p-4 space-y-3 flex flex-col justify-between">
                <div class="space-y-3">
                  <div class="flex items-center gap-2 text-on-surface">
                    <Papicon icon="smartphone" size={16} />
                    <span class="text-sm font-semibold">Android · KWGT</span>
                  </div>
                  <ol class="space-y-1.5 text-xs text-on-surface-variant leading-relaxed list-decimal list-inside">
                    <li>{m.pwp_android_s1_before()} <strong>KWGT Kustom Widget Maker</strong> {m.pwp_android_s1_after()}</li>
                    <li>{m.pwp_android_s2()}</li>
                    <li>{m.pwp_android_s3()}</li>
                  </ol>
                </div>
                <div class="flex flex-col gap-1.5 pt-2">
                  <Button href="/mobile-widgets/kwgt-guide.txt" target="_blank" variant="secondary" size="sm" icon="download" fullWidth>
                    {m.pwp_view_guide()}
                  </Button>
                  <Button variant="ghost" size="sm" fullWidth onclick={() => copy(widgetDataUrl, 'android-url')}>
                    {copiedField === 'android-url' ? m.pwp_copied() : m.pwp_copy_data_url()}
                  </Button>
                </div>
              </div>

              <!-- Windows 11 / Edge -->
              <div class="rounded-xl border border-outline-variant bg-surface-container-low p-4 space-y-3">
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
              <div class="rounded-xl border border-outline-variant bg-surface-container-low p-4 space-y-3 flex flex-col justify-between">
                <div class="space-y-3">
                  <div class="flex items-center gap-2 text-on-surface">
                    <Papicon icon="terminal" size={16} />
                    <span class="text-sm font-semibold">Linux · Waybar / Conky</span>
                  </div>
                  <ol class="space-y-1.5 text-xs text-on-surface-variant leading-relaxed list-decimal list-inside">
                    <li>{m.pwp_linux_s1()}</li>
                    <li>{m.pwp_linux_s2_before()} <code class="text-2xs">chmod +x</code> {m.pwp_linux_s2_after()}</li>
                    <li>{m.pwp_linux_s3()}</li>
                  </ol>
                </div>
                <div class="flex flex-col gap-1.5 pt-2">
                  <Button href="/desktop-widgets/linux-widgets-guide.txt" target="_blank" variant="secondary" size="sm" icon="download" fullWidth>
                    {m.pwp_view_guide()}
                  </Button>
                  <Button variant="ghost" size="sm" fullWidth onclick={() => copy(widgetDataUrl, 'linux-url')}>
                    {copiedField === 'linux-url' ? m.pwp_copied() : m.pwp_copy_data_url()}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </SectionCard>
      </div>
    {/if}

    {#if data?.subscriptions?.length > 0}
      <SectionCard title={m.pwp_staff_title()} icon="users" flush>
        <div class="divide-y divide-outline-variant">
          {#each data.subscriptions.filter((s: any) => s.enabled) as sub (sub.userId)}
            <div class="flex items-center gap-4 px-5 py-3">
              <span class="flex-1 font-mono text-sm text-on-surface truncate">{sub.userId}</span>
              <span class="text-xs text-on-surface-variant">{new Date(sub.createdAt).toLocaleDateString(dateLocale())}</span>
              <span class="px-2.5 py-0.5 rounded-full text-xs font-medium bg-success/10 text-on-success-container">{m.pwp_active()}</span>
            </div>
          {/each}
        </div>
      </SectionCard>
    {/if}

  </div>
{/if}
