<script lang="ts">
  /**
   * Webhooks sortants : les événements du serveur envoyés, signés, vers une
   * URL externe.
   *
   * L'écran reprend ce que font Stripe et GitHub : une liste de points de
   * terminaison avec leur santé sur 24 h, puis pour chacun le secret de
   * signature, un envoi de test et le journal des envois, où chaque ligne
   * montre la requête exacte et la réponse reçue, et peut être renvoyée.
   */
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import { Button, Callout, EmptyState, Field, FilterPills, Modal, SectionCard, ToggleSwitch, type FilterOption } from '../lib/components/ui';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { m, dateLocale } from '../lib/i18n';
  import {
    createOutgoingWebhook,
    deleteOutgoingWebhook,
    fetchOutgoingWebhooks,
    fetchWebhookDeliveries,
    fetchWebhookDelivery,
    redeliverWebhookDelivery,
    revealOutgoingWebhookSecret,
    rotateOutgoingWebhookSecret,
    testOutgoingWebhook,
    updateOutgoingWebhook,
    type DeliveryAttemptResult,
    type DeliveryDetail,
    type DeliveryStatus,
    type DeliverySummary,
    type OutgoingEventInfo,
    type OutgoingWebhook,
    type OutgoingWebhookOverview,
  } from '../lib/api';

  const ROOT = '/webhooks';

  let overview = $state<OutgoingWebhookOverview | null>(null);
  let loading = $state(true);

  const selectedId = $derived($router.path.startsWith(`${ROOT}/`) ? $router.path.slice(ROOT.length + 1).split('/')[0] || null : null);
  const selected = $derived(overview?.webhooks.find((hook) => hook.id === selectedId) ?? null);
  const atLimit = $derived(!!overview && overview.webhooks.length >= overview.limits.maxWebhooks);

  async function load() {
    loading = true;
    try {
      overview = await fetchOutgoingWebhooks();
    } catch {
      toast.error(m.owh_load_error());
    } finally {
      loading = false;
    }
  }

  onMount(load);

  function replaceWebhook(webhook: OutgoingWebhook) {
    if (!overview) return;
    overview.webhooks = overview.webhooks.map((hook) => (hook.id === webhook.id ? { ...hook, ...webhook } : hook));
  }

  // ── Catalogue ──────────────────────────────────────────
  const CATEGORY_LABEL: Record<OutgoingEventInfo['category'], () => string> = {
    members: () => m.owh_cat_members(),
    moderation: () => m.owh_cat_moderation(),
    tickets: () => m.owh_cat_tickets(),
    community: () => m.owh_cat_community(),
    server: () => m.owh_cat_server(),
  };

  const catalogByCategory = $derived.by(() => {
    const groups = new Map<OutgoingEventInfo['category'], OutgoingEventInfo[]>();
    for (const event of overview?.catalog ?? []) groups.set(event.category, [...(groups.get(event.category) ?? []), event]);
    return [...groups.entries()];
  });

  function eventsSummary(events: string[]): string {
    if (events.includes('*')) return m.owh_events_all();
    return events.length === 1 ? events[0] : m.owh_events_count({ count: events.length });
  }

  function urlParts(raw: string): { host: string; path: string } {
    try {
      const url = new URL(raw);
      return { host: url.host, path: `${url.pathname}${url.search}` };
    } catch {
      return { host: raw, path: '' };
    }
  }

  function formatDate(value: string | null): string {
    if (!value) return '—';
    return new Date(value).toLocaleString(dateLocale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function relative(value: string | null): string {
    if (!value) return m.owh_never();
    const diff = Date.now() - new Date(value).getTime();
    const minutes = Math.round(diff / 60_000);
    if (minutes < 1) return m.owh_just_now();
    if (minutes < 60) return m.owh_minutes_ago({ count: minutes });
    const hours = Math.round(minutes / 60);
    if (hours < 48) return m.owh_hours_ago({ count: hours });
    return formatDate(value);
  }

  function healthOf(hook: OutgoingWebhook): { label: string; tone: 'success' | 'warning' | 'error' | 'muted' } {
    if (!hook.enabled) return hook.disabledReason ? { label: m.owh_state_cut(), tone: 'error' } : { label: m.owh_state_paused(), tone: 'muted' };
    if (hook.consecutiveFailures > 0) return { label: m.owh_state_failing(), tone: 'warning' };
    return { label: m.owh_state_active(), tone: 'success' };
  }

  const TONE_CLASS = {
    success: 'bg-success/10 text-success',
    warning: 'bg-warning/10 text-warning',
    error: 'bg-error/10 text-error',
    muted: 'bg-surface-container text-on-surface-variant',
  } as const;

  function statusTone(status: DeliveryStatus): keyof typeof TONE_CLASS {
    return status === 'SUCCESS' ? 'success' : status === 'FAILED' ? 'error' : 'warning';
  }

  function statusLabel(status: DeliveryStatus): string {
    return status === 'SUCCESS' ? m.owh_delivery_success() : status === 'FAILED' ? m.owh_delivery_failed() : m.owh_delivery_pending();
  }

  function successRate(hook: OutgoingWebhook): string {
    const done = hook.last24h.success + hook.last24h.failed;
    if (done === 0) return '—';
    return `${Math.round((hook.last24h.success / done) * 100)} %`;
  }

  // ── Formulaire création / modification ─────────────────
  let formOpen = $state(false);
  let formEditingId = $state<string | null>(null);
  let formName = $state('');
  let formUrl = $state('');
  let formAll = $state(false);
  let formEvents = $state<string[]>([]);
  let formSaving = $state(false);
  let formError = $state('');

  function openCreate() {
    formEditingId = null;
    formName = '';
    formUrl = '';
    formAll = false;
    formEvents = [];
    formError = '';
    formOpen = true;
  }

  function openEdit(hook: OutgoingWebhook) {
    formEditingId = hook.id;
    formName = hook.name;
    formUrl = hook.url;
    formAll = hook.events.includes('*');
    formEvents = formAll ? [] : [...hook.events];
    formError = '';
    formOpen = true;
  }

  function toggleEvent(type: string) {
    formEvents = formEvents.includes(type) ? formEvents.filter((value) => value !== type) : [...formEvents, type];
  }

  function toggleCategory(events: OutgoingEventInfo[]) {
    const types = events.map((event) => event.type);
    const allOn = types.every((type) => formEvents.includes(type));
    formEvents = allOn ? formEvents.filter((type) => !types.includes(type)) : [...new Set([...formEvents, ...types])];
  }

  async function submitForm(event: SubmitEvent) {
    event.preventDefault();
    formError = '';
    const events = formAll ? ['*'] : formEvents;
    if (!formName.trim()) return void (formError = m.owh_form_name_required());
    if (!formUrl.trim().startsWith('https://')) return void (formError = m.owh_form_https_required());
    if (events.length === 0) return void (formError = m.owh_form_events_required());

    formSaving = true;
    try {
      if (formEditingId) {
        const res = await updateOutgoingWebhook(formEditingId, { name: formName, url: formUrl, events });
        if (res) replaceWebhook(res.webhook);
        toast.success(m.owh_saved());
      } else {
        const res = await createOutgoingWebhook({ name: formName, url: formUrl, events });
        if (res && overview) {
          overview.webhooks = [...overview.webhooks, res.webhook];
          showSecret(res.secret, true);
          router.goto(`${ROOT}/${res.webhook.id}`);
        }
      }
      formOpen = false;
    } catch (err) {
      formError = err instanceof Error ? err.message : m.owh_save_error();
    } finally {
      formSaving = false;
    }
  }

  // ── Secret ─────────────────────────────────────────────
  let secretValue = $state<string | null>(null);
  let secretIsNew = $state(false);
  let secretModalOpen = $state(false);

  function showSecret(secret: string, isNew: boolean) {
    secretValue = secret;
    secretIsNew = isNew;
    secretModalOpen = true;
  }

  async function reveal(hook: OutgoingWebhook) {
    try {
      const res = await revealOutgoingWebhookSecret(hook.id);
      if (res) showSecret(res.secret, false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.owh_secret_error());
    }
  }

  async function rotate(hook: OutgoingWebhook) {
    const ok = await confirmDialog.ask({
      title: m.owh_rotate_title(),
      description: m.owh_rotate_desc(),
      confirmLabel: m.owh_rotate_confirm(),
      variant: 'warning',
    });
    if (!ok) return;
    try {
      const res = await rotateOutgoingWebhookSecret(hook.id);
      if (res) showSecret(res.secret, true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.owh_secret_error());
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(m.owh_copied());
    } catch {
      toast.error(m.owh_copy_error());
    }
  }

  // ── Actions sur un point de terminaison ────────────────
  let testing = $state(false);

  function announceAttempt(result: DeliveryAttemptResult | null) {
    if (!result) return toast.error(m.owh_test_error());
    if (result.ok) toast.success(m.owh_attempt_ok({ status: result.responseStatus ?? 0, ms: result.durationMs }));
    else toast.error(result.responseStatus
      ? m.owh_attempt_http_error({ status: result.responseStatus })
      : m.owh_attempt_network_error({ reason: result.responseBody ?? '' }));
  }

  async function sendTest(hook: OutgoingWebhook) {
    testing = true;
    try {
      const res = await testOutgoingWebhook(hook.id);
      announceAttempt(res?.result ?? null);
      await Promise.all([load(), loadDeliveries(true)]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.owh_test_error());
    } finally {
      testing = false;
    }
  }

  async function setEnabled(hook: OutgoingWebhook, enabled: boolean) {
    try {
      const res = await updateOutgoingWebhook(hook.id, { enabled });
      if (res) replaceWebhook(res.webhook);
      toast.success(enabled ? m.owh_resumed() : m.owh_paused());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.owh_save_error());
    }
  }

  async function remove(hook: OutgoingWebhook) {
    if (!(await confirmDialog.danger(m.owh_delete_title({ name: hook.name }), m.owh_delete_desc()))) return;
    try {
      await deleteOutgoingWebhook(hook.id);
      if (overview) overview.webhooks = overview.webhooks.filter((item) => item.id !== hook.id);
      router.goto(ROOT);
      toast.success(m.owh_deleted());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.owh_save_error());
    }
  }

  // ── Journal des envois ─────────────────────────────────
  type StatusFilter = 'all' | DeliveryStatus;
  let statusFilter = $state<StatusFilter>('all');
  let deliveries = $state<DeliverySummary[]>([]);
  let nextCursor = $state<string | null>(null);
  let deliveriesLoading = $state(false);

  const statusOptions: FilterOption<StatusFilter>[] = $derived([
    { value: 'all', label: m.owh_filter_all() },
    { value: 'SUCCESS', label: m.owh_delivery_success() },
    { value: 'FAILED', label: m.owh_delivery_failed() },
    { value: 'PENDING', label: m.owh_delivery_pending() },
  ]);

  async function loadDeliveries(reset: boolean) {
    if (!selectedId) return;
    deliveriesLoading = true;
    try {
      const res = await fetchWebhookDeliveries(selectedId, {
        status: statusFilter === 'all' ? null : statusFilter,
        cursor: reset ? null : nextCursor,
      });
      if (res) {
        deliveries = reset ? res.deliveries : [...deliveries, ...res.deliveries];
        nextCursor = res.nextCursor;
      }
    } catch {
      toast.error(m.owh_deliveries_error());
    } finally {
      deliveriesLoading = false;
    }
  }

  $effect(() => {
    // Relu à chaque changement de point de terminaison ou de filtre.
    void selectedId;
    void statusFilter;
    deliveries = [];
    nextCursor = null;
    if (selectedId) void loadDeliveries(true);
  });

  let detail = $state<DeliveryDetail | null>(null);
  let detailOpen = $state(false);
  let redelivering = $state(false);

  async function openDelivery(summary: DeliverySummary) {
    if (!selectedId) return;
    try {
      const res = await fetchWebhookDelivery(selectedId, summary.id);
      if (res) {
        detail = res.delivery;
        detailOpen = true;
      }
    } catch {
      toast.error(m.owh_deliveries_error());
    }
  }

  async function redeliverDetail() {
    if (!selectedId || !detail) return;
    redelivering = true;
    try {
      const res = await redeliverWebhookDelivery(selectedId, detail.id);
      announceAttempt(res?.result ?? null);
      detailOpen = false;
      await Promise.all([load(), loadDeliveries(true)]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.owh_test_error());
    } finally {
      redelivering = false;
    }
  }

  const pretty = (value: unknown) => JSON.stringify(value, null, 2);

  function prettyBody(raw: string | null): string {
    if (!raw) return '';
    try {
      return pretty(JSON.parse(raw));
    } catch {
      return raw;
    }
  }

  const VERIFY_SNIPPET = `import crypto from 'node:crypto';

// rawBody : le corps exact reçu, avant tout JSON.parse.
export function verifyKotbo(rawBody, header, secret, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest();
  const received = Buffer.from(parts.v1 ?? '', 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}`;
</script>

<ModulePage title={m.nav_outgoing_webhooks()} description={m.owh_page_desc()} icon="send" featureKey="settings">
  {#snippet actions()}
    <Button variant="primary" size="sm" icon="plus" disabled={atLimit || loading} onclick={openCreate}>
      {m.owh_add()}
    </Button>
  {/snippet}

  {#if loading && !overview}
    <div class="space-y-3">
      <Skeleton height="h-20" />
      <Skeleton height="h-20" />
    </div>
  {:else if overview && selectedId && !selected}
    <EmptyState icon="alert-circle" title={m.owh_not_found()} description={m.owh_not_found_desc()} />
    <div class="flex justify-center"><Button variant="ghost" icon="arrow-left" href={ROOT}>{m.owh_back()}</Button></div>
  {:else if overview && selected}
    {@const hook = selected}
    {@const health = healthOf(hook)}
    {@const parts = urlParts(hook.url)}

    <div class="mb-4">
      <Button variant="ghost" size="sm" icon="arrow-left" href={ROOT}>{m.owh_back()}</Button>
    </div>

    <SectionCard>
      <div class="px-5 pb-5 pt-5 flex flex-wrap items-start justify-between gap-4">
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <h2 class="text-base font-semibold text-on-surface">{hook.name}</h2>
            <span class="text-2xs font-medium px-2 py-0.5 rounded-full {TONE_CLASS[health.tone]}">{health.label}</span>
          </div>
          <p class="mt-1 font-mono text-body-sm text-on-surface-variant break-all">
            <span class="text-on-surface">{parts.host}</span>{parts.path}
          </p>
          <p class="mt-1 text-2xs text-on-surface-variant">
            {m.owh_meta_line({ events: eventsSummary(hook.events), date: formatDate(hook.createdAt) })}
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <label class="flex items-center gap-2 text-body-sm text-on-surface-variant mr-2">
            <ToggleSwitch size="sm" checked={hook.enabled} ariaLabel={m.owh_toggle_label()} onToggle={(value) => setEnabled(hook, value)} />
            {hook.enabled ? m.owh_enabled() : m.owh_disabled()}
          </label>
          <Button size="sm" icon="send" loading={testing} disabled={!hook.enabled} onclick={() => sendTest(hook)}>{m.owh_test()}</Button>
          <Button size="sm" icon="edit-2" onclick={() => openEdit(hook)}>{m.owh_edit()}</Button>
          <Button size="sm" variant="danger" icon="trash-2" aria-label={m.common_delete()} onclick={() => remove(hook)} />
        </div>
      </div>
    </SectionCard>

    {#if !hook.enabled && hook.disabledReason}
      <Callout variant="danger" title={m.owh_cut_title()} class="mt-4">
        {hook.disabledReason} {m.owh_cut_hint()}
        {#snippet actions()}
          <Button size="sm" onclick={() => setEnabled(hook, true)}>{m.owh_reactivate()}</Button>
        {/snippet}
      </Callout>
    {:else if hook.consecutiveFailures > 0}
      <Callout variant="warning" title={m.owh_failing_title({ count: hook.consecutiveFailures })} class="mt-4">
        {m.owh_failing_hint({ limit: 40 })}
      </Callout>
    {/if}

    <div class="grid gap-4 mt-4 lg:grid-cols-3">
      <div class="owh-kpi">
        <span class="owh-kpi__label">{m.owh_kpi_success_rate()}</span>
        <span class="owh-kpi__value">{successRate(hook)}</span>
        <span class="owh-kpi__hint">{m.owh_kpi_last24h({ success: hook.last24h.success, failed: hook.last24h.failed })}</span>
      </div>
      <div class="owh-kpi">
        <span class="owh-kpi__label">{m.owh_kpi_last_delivery()}</span>
        <span class="owh-kpi__value">{relative(hook.lastDeliveryAt)}</span>
        <span class="owh-kpi__hint">{hook.lastStatusCode ? m.owh_kpi_last_code({ code: hook.lastStatusCode }) : m.owh_kpi_no_code()}</span>
      </div>
      <div class="owh-kpi">
        <span class="owh-kpi__label">{m.owh_kpi_pending()}</span>
        <span class="owh-kpi__value">{hook.last24h.pending}</span>
        <span class="owh-kpi__hint">{m.owh_kpi_pending_hint({ attempts: overview.limits.maxAttempts })}</span>
      </div>
    </div>

    <div class="grid gap-4 mt-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <div class="space-y-4">
        <SectionCard title={m.owh_secret_title()} description={m.owh_secret_desc()} icon="key">
          <div class="px-5 pb-5 pt-3 space-y-3">
            <p class="font-mono text-body-sm text-on-surface-variant">whsec_••••••••••••••••</p>
            <div class="flex flex-wrap gap-2">
              <Button size="sm" icon="eye" onclick={() => reveal(hook)}>{m.owh_reveal()}</Button>
              <Button size="sm" variant="ghost" icon="refresh-cw" onclick={() => rotate(hook)}>{m.owh_rotate()}</Button>
            </div>
          </div>
        </SectionCard>

        <SectionCard title={m.owh_subscribed_title()} icon="zap">
          <ul class="px-5 pb-5 pt-3 space-y-1.5">
            {#if hook.events.includes('*')}
              <li class="text-body-sm text-on-surface">{m.owh_events_all_future()}</li>
            {:else}
              {#each hook.events as type (type)}
                <li class="font-mono text-body-sm text-on-surface">{type}</li>
              {/each}
            {/if}
          </ul>
        </SectionCard>
      </div>

      <SectionCard title={m.owh_log_title()} description={m.owh_log_desc({ days: overview.limits.retentionDays })} flush>
        {#snippet actions()}
          <Button size="sm" variant="ghost" icon="refresh-cw" aria-label={m.owh_refresh()} loading={deliveriesLoading} onclick={() => loadDeliveries(true)} />
        {/snippet}
        <div class="px-5 py-3 border-b border-outline-variant">
          <FilterPills label={m.owh_filter_label()} options={statusOptions} value={statusFilter} onchange={(value) => (statusFilter = value)} />
        </div>
        {#if deliveriesLoading && deliveries.length === 0}
          <div class="p-5 space-y-2">
            {#each Array(4) as _}<Skeleton height="h-10" />{/each}
          </div>
        {:else if deliveries.length === 0}
          <EmptyState icon="inbox" title={m.owh_log_empty()} description={m.owh_log_empty_desc()} />
        {:else}
          <ul class="divide-y divide-outline-variant/40">
            {#each deliveries as delivery (delivery.id)}
              <li>
                <button type="button" class="owh-row" onclick={() => openDelivery(delivery)}>
                  <span class="text-2xs font-medium px-2 py-0.5 rounded-full shrink-0 {TONE_CLASS[statusTone(delivery.status)]}">
                    {delivery.responseStatus ?? statusLabel(delivery.status)}
                  </span>
                  <span class="font-mono text-body-sm text-on-surface truncate">{delivery.event}</span>
                  <span class="ml-auto flex items-center gap-3 shrink-0 text-2xs text-on-surface-variant tabular-nums">
                    {#if delivery.status === 'PENDING' && delivery.nextAttemptAt}
                      <span>{m.owh_retry_at({ date: formatDate(delivery.nextAttemptAt) })}</span>
                    {/if}
                    {#if delivery.attempts > 1}<span>{m.owh_attempts({ count: delivery.attempts })}</span>{/if}
                    {#if delivery.durationMs !== null}<span>{delivery.durationMs} ms</span>{/if}
                    <span>{formatDate(delivery.createdAt)}</span>
                    <Papicon icon="chevron-right" size={14} />
                  </span>
                </button>
              </li>
            {/each}
          </ul>
          {#if nextCursor}
            <div class="p-3 flex justify-center border-t border-outline-variant">
              <Button size="sm" variant="ghost" loading={deliveriesLoading} onclick={() => loadDeliveries(false)}>{m.owh_load_more()}</Button>
            </div>
          {/if}
        {/if}
      </SectionCard>
    </div>
  {:else if overview}
    {#if overview.webhooks.length === 0}
      <SectionCard>
        <EmptyState icon="send" title={m.owh_empty_title()} description={m.owh_empty_desc()} />
        <div class="flex justify-center pb-6">
          <Button variant="primary" icon="plus" onclick={openCreate}>{m.owh_add()}</Button>
        </div>
      </SectionCard>
    {:else}
      <SectionCard title={m.owh_list_title()} description={m.owh_list_desc({ count: overview.webhooks.length, max: overview.limits.maxWebhooks })} flush>
        <ul class="divide-y divide-outline-variant/40">
          {#each overview.webhooks as hook (hook.id)}
            {@const health = healthOf(hook)}
            {@const parts = urlParts(hook.url)}
            <li>
              <a class="owh-row" href={`${ROOT}/${hook.id}`}>
                <span class="w-2 h-2 rounded-full shrink-0 {health.tone === 'success' ? 'bg-success' : health.tone === 'warning' ? 'bg-warning' : health.tone === 'error' ? 'bg-error' : 'bg-outline-variant'}" aria-hidden="true"></span>
                <span class="min-w-0 flex flex-col">
                  <span class="text-body-sm font-medium text-on-surface truncate">{hook.name}</span>
                  <span class="font-mono text-2xs text-on-surface-variant truncate">{parts.host}{parts.path}</span>
                </span>
                <span class="ml-auto hidden sm:flex items-center gap-4 shrink-0 text-2xs text-on-surface-variant tabular-nums">
                  <span>{eventsSummary(hook.events)}</span>
                  <span title={m.owh_kpi_success_rate()}>{successRate(hook)}</span>
                  <span>{health.label}</span>
                </span>
                <Papicon icon="chevron-right" size={14} />
              </a>
            </li>
          {/each}
        </ul>
      </SectionCard>
    {/if}

    <div class="grid gap-4 mt-4 lg:grid-cols-2">
      <SectionCard title={m.owh_howto_title()} description={m.owh_howto_desc()} icon="shield">
        <div class="px-5 pb-5 pt-3 space-y-3">
          <dl class="owh-headers">
            <dt>Kotbo-Signature</dt><dd>{m.owh_header_signature()}</dd>
            <dt>Kotbo-Event</dt><dd>{m.owh_header_event()}</dd>
            <dt>Kotbo-Event-Id</dt><dd>{m.owh_header_event_id()}</dd>
            <dt>Kotbo-Delivery</dt><dd>{m.owh_header_delivery()}</dd>
          </dl>
          <pre class="owh-code">{VERIFY_SNIPPET}</pre>
          <Button size="sm" variant="ghost" icon="copy" onclick={() => copy(VERIFY_SNIPPET)}>{m.owh_copy_snippet()}</Button>
        </div>
      </SectionCard>
      <SectionCard title={m.owh_retry_title()} icon="repeat">
        <ul class="px-5 pb-5 pt-3 space-y-2 text-body-sm text-on-surface-variant list-disc pl-9">
          <li>{m.owh_retry_rule_2xx()}</li>
          <li>{m.owh_retry_rule_schedule({ attempts: overview.limits.maxAttempts })}</li>
          <li>{m.owh_retry_rule_cut()}</li>
          <li>{m.owh_retry_rule_dedupe()}</li>
          <li>{m.owh_retry_rule_privacy()}</li>
        </ul>
      </SectionCard>
    </div>
  {/if}
</ModulePage>

<!-- Création / modification -->
<Modal bind:open={formOpen} title={formEditingId ? m.owh_form_edit_title() : m.owh_form_create_title()} size="lg">
  <form id="owh-form" class="space-y-4" onsubmit={submitForm}>
    <Field label={m.owh_form_name()} hint={m.owh_form_name_hint()} required>
      {#snippet children(id, describedBy)}
        <input {id} aria-describedby={describedBy} class="input w-full" maxlength="60" bind:value={formName} placeholder="CRM, n8n, tableur…" />
      {/snippet}
    </Field>
    <Field label={m.owh_form_url()} hint={m.owh_form_url_hint()} required>
      {#snippet children(id, describedBy)}
        <input {id} aria-describedby={describedBy} class="input w-full font-mono" type="url" bind:value={formUrl} placeholder="https://exemple.fr/webhooks/kotbo" />
      {/snippet}
    </Field>

    <fieldset class="space-y-3">
      <legend class="text-body-sm font-medium text-on-surface mb-1">{m.owh_form_events()}</legend>
      <label class="owh-check">
        <input type="checkbox" bind:checked={formAll} />
        <span>
          <span class="text-body-sm text-on-surface">{m.owh_events_all()}</span>
          <span class="block text-2xs text-on-surface-variant">{m.owh_form_all_hint()}</span>
        </span>
      </label>
      {#if !formAll}
        {#each catalogByCategory as [category, events] (category)}
          {@const allOn = events.every((event) => formEvents.includes(event.type))}
          <div class="owh-group">
            <div class="flex items-center justify-between gap-2 mb-1.5">
              <span class="text-body-sm font-medium text-on-surface">{CATEGORY_LABEL[category]()}</span>
              <button type="button" class="text-2xs text-primary hover:underline" onclick={() => toggleCategory(events)}>
                {allOn ? m.owh_form_none() : m.owh_form_all_in_group()}
              </button>
            </div>
            {#each events as event (event.type)}
              <label class="owh-check">
                <input type="checkbox" checked={formEvents.includes(event.type)} onchange={() => toggleEvent(event.type)} />
                <span>
                  <span class="font-mono text-body-sm text-on-surface">{event.type}</span>
                  <span class="block text-2xs text-on-surface-variant">{event.description}</span>
                </span>
              </label>
            {/each}
          </div>
        {/each}
      {/if}
    </fieldset>

    {#if formError}
      <Callout variant="danger">{formError}</Callout>
    {/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (formOpen = false)}>{m.common_cancel()}</Button>
    <Button variant="primary" type="submit" form="owh-form" loading={formSaving}>
      {formEditingId ? m.common_save() : m.owh_form_create()}
    </Button>
  {/snippet}
</Modal>

<!-- Secret -->
<Modal bind:open={secretModalOpen} title={m.owh_secret_title()} size="md">
  <div class="space-y-3">
    {#if secretIsNew}
      <Callout variant="warning">{m.owh_secret_new_hint()}</Callout>
    {/if}
    <div class="flex items-center gap-2">
      <code class="owh-code flex-1 break-all">{secretValue}</code>
      <Button size="sm" icon="copy" aria-label={m.owh_copy()} onclick={() => secretValue && copy(secretValue)} />
    </div>
  </div>
  {#snippet footer()}
    <Button variant="primary" onclick={() => { secretModalOpen = false; secretValue = null; }}>{m.owh_done()}</Button>
  {/snippet}
</Modal>

<!-- Détail d'un envoi -->
<Modal bind:open={detailOpen} title={detail ? detail.event : ''} subtitle={detail ? formatDate(detail.createdAt) : ''} size="lg">
  {#if detail}
    <div class="space-y-4">
      <dl class="owh-meta">
        <div><dt>{m.owh_detail_status()}</dt><dd><span class="text-2xs font-medium px-2 py-0.5 rounded-full {TONE_CLASS[statusTone(detail.status)]}">{statusLabel(detail.status)}</span></dd></div>
        <div><dt>{m.owh_detail_code()}</dt><dd class="tabular-nums">{detail.responseStatus ?? '—'}</dd></div>
        <div><dt>{m.owh_detail_attempts()}</dt><dd class="tabular-nums">{detail.attempts}</dd></div>
        <div><dt>{m.owh_detail_duration()}</dt><dd class="tabular-nums">{detail.durationMs !== null ? `${detail.durationMs} ms` : '—'}</dd></div>
        {#if detail.status === 'PENDING' && detail.nextAttemptAt}
          <div><dt>{m.owh_detail_next()}</dt><dd>{formatDate(detail.nextAttemptAt)}</dd></div>
        {/if}
        <div><dt>{m.owh_detail_id()}</dt><dd class="font-mono break-all">{detail.id}</dd></div>
      </dl>
      <div>
        <div class="flex items-center justify-between mb-1.5">
          <h4 class="text-body-sm font-medium text-on-surface">{m.owh_detail_request()}</h4>
          <Button size="sm" variant="ghost" icon="copy" onclick={() => detail && copy(pretty(detail.payload))}>{m.owh_copy()}</Button>
        </div>
        <pre class="owh-code max-h-72">{pretty(detail.payload)}</pre>
      </div>
      <div>
        <h4 class="text-body-sm font-medium text-on-surface mb-1.5">{m.owh_detail_response()}</h4>
        {#if detail.responseBody}
          <pre class="owh-code max-h-56">{prettyBody(detail.responseBody)}</pre>
        {:else}
          <p class="text-body-sm text-on-surface-variant">{m.owh_detail_no_body()}</p>
        {/if}
      </div>
    </div>
  {/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (detailOpen = false)}>{m.common_close()}</Button>
    <Button variant="primary" icon="repeat" loading={redelivering} disabled={!selected?.enabled} onclick={redeliverDetail}>{m.owh_redeliver()}</Button>
  {/snippet}
</Modal>

<style>
  .owh-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.75rem 1.25rem;
    text-align: left;
    color: var(--on-surface-variant);
    transition: background-color 120ms ease;
  }
  .owh-row:hover,
  .owh-row:focus-visible {
    background: var(--surface-container-low);
  }

  .owh-kpi {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 1rem 1.25rem;
    border: 1px solid var(--outline-variant);
    border-radius: 0.875rem;
    background: var(--surface-container-lowest);
  }
  .owh-kpi__label {
    font-size: 0.75rem;
    color: var(--on-surface-variant);
  }
  .owh-kpi__value {
    font-size: 1.375rem;
    font-weight: 600;
    color: var(--on-surface);
    font-variant-numeric: tabular-nums;
  }
  .owh-kpi__hint {
    font-size: 0.6875rem;
    color: var(--on-surface-variant);
  }

  .owh-code {
    display: block;
    padding: 0.75rem 0.875rem;
    overflow: auto;
    border: 1px solid var(--outline-variant);
    border-radius: 0.625rem;
    background: var(--surface-container-low);
    color: var(--on-surface);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.75rem;
    line-height: 1.55;
    white-space: pre;
  }
  code.owh-code {
    white-space: normal;
  }

  .owh-headers {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.35rem 0.875rem;
    font-size: 0.8125rem;
  }
  .owh-headers dt {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--on-surface);
  }
  .owh-headers dd {
    color: var(--on-surface-variant);
  }

  .owh-meta {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
    gap: 0.75rem;
    font-size: 0.8125rem;
  }
  .owh-meta dt {
    color: var(--on-surface-variant);
    font-size: 0.75rem;
  }
  .owh-meta dd {
    color: var(--on-surface);
    margin-top: 0.15rem;
  }

  .owh-group {
    padding: 0.75rem 0.875rem;
    border: 1px solid var(--outline-variant);
    border-radius: 0.75rem;
  }

  .owh-check {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
    padding: 0.3rem 0;
    cursor: pointer;
  }
  .owh-check input {
    margin-top: 0.2rem;
    accent-color: var(--primary);
  }

  @media (max-width: 640px) {
    .owh-headers {
      grid-template-columns: 1fr;
    }
  }
</style>
