<!--
  Réglage par type de journal : publié ou non, et dans quel salon.

  La page garde le brouillon (`configs`) et l'enregistrement, via la barre des
  modifications non enregistrées ; ce composant ne fait qu'afficher et éditer.
  Le salon affiché sous chaque type est calculé par `routeLogEvent`, la même
  fonction que le bot utilise pour envoyer : ce qui est écrit ici est ce qui
  se passera.
-->
<script lang="ts">
  import {
    LOG_EVENT_CATEGORIES,
    LOG_EVENTS,
    routeLogEvent,
    type LogEventCategory,
    type LogEventConfig,
    type LogEventDefinition,
    type LogEventType,
  } from "@kotbo/shared";
  import { m } from "../../i18n";
  import { LOG_CATEGORY_META, LOG_EVENT_LABELS } from "../../logEventLabels";
  import { testLogEvent } from "../../api";
  import { toast } from "../../stores/toast.svelte";
  import { Button, EmptyState, FilterPills, SectionCard, ToggleSwitch } from "../ui";
  import Papicon from "../Papicon.svelte";
  import SearchableSelect from "../SearchableSelect.svelte";

  type Filter = "all" | "on" | "off" | "dedicated";

  let {
    configs = $bindable(),
    savedConfigs,
    moduleChannels = {},
    defaultChannelId = null,
    channels = [],
    disabled = false,
  }: {
    configs: LogEventConfig[];
    savedConfigs: LogEventConfig[];
    /** Salon réglé dans le module lui-même : prioritaire, voir `routeLogEvent`. */
    moduleChannels?: Partial<Record<string, string | null>>;
    defaultChannelId?: string | null;
    channels?: Array<{ id: string; name: string }>;
    disabled?: boolean;
  } = $props();

  let query = $state("");
  let filter = $state<Filter>("all");
  let testing = $state<string | null>(null);

  const DEFINITIONS = LOG_EVENTS as readonly LogEventDefinition[];

  const byType = $derived(new Map(configs.map((c) => [c.eventType, c])));
  const savedByType = $derived(new Map(savedConfigs.map((c) => [c.eventType, c])));

  /** Un type sans ligne est publié dans le salon par défaut : même règle que le bot. */
  function configOf(type: string): LogEventConfig {
    return byType.get(type) ?? { eventType: type, enabled: true, channelId: null };
  }

  function update(types: string[], patch: Partial<LogEventConfig>) {
    const targets = new Set(types);
    const next = configs.map((c) => (targets.has(c.eventType) ? { ...c, ...patch } : c));
    for (const type of targets) {
      if (!byType.has(type)) next.push({ ...configOf(type), ...patch });
    }
    configs = next;
  }

  function isDirty(type: string): boolean {
    const a = configOf(type);
    const b = savedByType.get(type) ?? { enabled: true, channelId: null };
    return a.enabled !== b.enabled || (a.channelId ?? null) !== (b.channelId ?? null);
  }

  const channelNames = $derived(new Map(channels.map((c) => [c.id, c.name])));
  function channelLabel(id: string): string {
    const name = channelNames.get(id);
    return name ? `#${name}` : m.lg_unknown_channel();
  }

  function destination(def: LogEventDefinition) {
    const cfg = configOf(def.type);
    const moduleChannelId = moduleChannels[def.type] ?? null;
    const channelId = routeLogEvent({
      enabled: cfg.enabled,
      moduleChannelId,
      eventChannelId: cfg.channelId,
      guildLogChannelId: defaultChannelId,
    });
    return { channelId, viaModule: !!moduleChannelId && channelId === moduleChannelId };
  }

  /** Recherche insensible à la casse et aux accents (« securite » trouve « Sécurité »). */
  function fold(value: string): string {
    return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  }

  function matchesFilter(def: LogEventDefinition, f: Filter): boolean {
    const cfg = configOf(def.type);
    if (f === "on") return cfg.enabled;
    if (f === "off") return !cfg.enabled;
    if (f === "dedicated") return cfg.enabled && !!cfg.channelId;
    return true;
  }

  const needle = $derived(fold(query.trim()));
  function matchesQuery(def: LogEventDefinition): boolean {
    if (!needle) return true;
    const labels = LOG_EVENT_LABELS[def.type as LogEventType];
    const category = LOG_CATEGORY_META[def.category].label();
    return [labels.label(), labels.desc(), category, def.type].some((text) => fold(text).includes(needle));
  }

  const searched = $derived(DEFINITIONS.filter(matchesQuery));
  const groups = $derived(
    LOG_EVENT_CATEGORIES.map((category) => ({
      category,
      all: DEFINITIONS.filter((d) => d.category === category),
      shown: searched.filter((d) => d.category === category && matchesFilter(d, filter)),
    })).filter((g) => g.shown.length > 0),
  );

  const totals = $derived({
    total: DEFINITIONS.length,
    on: DEFINITIONS.filter((d) => configOf(d.type).enabled).length,
    dedicated: DEFINITIONS.filter((d) => matchesFilter(d, "dedicated")).length,
  });

  const filterOptions = $derived([
    { value: "all" as Filter, label: m.lg_filter_all(), count: searched.length },
    { value: "on" as Filter, label: m.lg_filter_on(), count: searched.filter((d) => matchesFilter(d, "on")).length },
    { value: "off" as Filter, label: m.lg_filter_off(), count: searched.filter((d) => matchesFilter(d, "off")).length },
    { value: "dedicated" as Filter, label: m.lg_filter_dedicated(), count: searched.filter((d) => matchesFilter(d, "dedicated")).length },
  ]);

  const channelOptions = $derived(channels.map((c) => ({ id: c.id, name: `#${c.name}` })));
  const defaultPlaceholder = $derived(
    defaultChannelId ? m.lg_default_channel_named({ channel: channelLabel(defaultChannelId) }) : m.lg_default_channel_unset(),
  );

  async function runTest(type: string) {
    testing = type;
    try {
      const result = await testLogEvent(type);
      if (result?.channelId) toast.success(m.lg_test_sent({ channel: channelLabel(result.channelId) }));
    } catch (err) {
      toast.error((err as { userMessage?: string })?.userMessage ?? m.sc_api_error());
    } finally {
      testing = null;
    }
  }
</script>

<div class="space-y-4">
  <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
    <p class="text-body-sm text-on-surface-variant" aria-live="polite">
      <span class="font-semibold text-on-surface">{m.lg_routing_summary({ on: totals.on, total: totals.total })}</span>
      {#if totals.dedicated > 0}
        <span aria-hidden="true">&nbsp;·&nbsp;</span>{m.lg_routing_dedicated({ n: totals.dedicated })}
      {/if}
    </p>
    <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div class="relative w-full sm:w-72">
        <Papicon
          icon="search"
          size={16}
          class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant"
        />
        <input
          type="search"
          class="input pl-9"
          bind:value={query}
          placeholder={m.lg_routing_search_ph()}
          aria-label={m.lg_routing_search()}
        />
      </div>
      <FilterPills
        options={filterOptions}
        value={filter}
        onchange={(v) => (filter = v)}
        label={m.lg_routing_filter()}
      />
    </div>
  </div>

  {#if groups.length === 0}
    <SectionCard>
      <EmptyState icon="SearchX" title={m.lg_no_match()} description={m.lg_no_match_hint()} reason="nothing-matches" />
    </SectionCard>
  {:else}
    <div class="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
      {#each groups as group (group.category)}
        {@const meta = LOG_CATEGORY_META[group.category as LogEventCategory]}
        {@const onCount = group.all.filter((d) => configOf(d.type).enabled).length}
        <SectionCard title={meta.label()} description={m.lg_cat_count({ on: onCount, total: group.all.length })} icon={meta.icon} flush>
          {#snippet actions()}
            <div class="flex shrink-0 gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || onCount === group.all.length}
                onclick={() => update(group.all.map((d) => d.type), { enabled: true })}
              >{m.lg_cat_enable_all()}</Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || onCount === 0}
                onclick={() => update(group.all.map((d) => d.type), { enabled: false })}
              >{m.lg_cat_disable_all()}</Button>
            </div>
          {/snippet}

          <ul class="divide-y divide-outline-variant">
            {#each group.shown as def (def.type)}
              {@const cfg = configOf(def.type)}
              {@const labels = LOG_EVENT_LABELS[def.type as LogEventType]}
              {@const route = destination(def)}
              {@const toggleId = `log-event-${def.type}`}
              <li class="px-4 py-3.5 transition-colors {cfg.enabled ? '' : 'bg-surface-container/40'}">
                <div class="flex items-start gap-4">
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <label for={toggleId} class="text-body-sm font-semibold {cfg.enabled ? 'text-on-surface' : 'text-on-surface-variant'}">
                        {labels.label()}
                      </label>
                      {#if def.interactive}
                        <span class="badge badge-neutral" title={m.lg_badge_interactive_hint()}>{m.lg_badge_interactive()}</span>
                      {/if}
                      {#if def.native}
                        <span class="badge badge-info" title={m.lg_badge_native_hint()}>{m.lg_badge_native()}</span>
                      {/if}
                    </div>
                    <p class="mt-0.5 text-body-sm text-on-surface-variant">{labels.desc()}</p>
                  </div>
                  <ToggleSwitch
                    id={toggleId}
                    checked={cfg.enabled}
                    {disabled}
                    ariaLabel={labels.label()}
                    onToggle={(v: boolean) => update([def.type], { enabled: v })}
                  />
                </div>

                {#if cfg.enabled}
                  <div class="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                    <div class="min-w-0 flex-1">
                      <SearchableSelect
                        id={`${toggleId}-channel`}
                        value={cfg.channelId}
                        options={channelOptions}
                        placeholder={defaultPlaceholder}
                        showId={false}
                        {disabled}
                        on:change={(e: CustomEvent<{ value: string | null }>) =>
                          update([def.type], { channelId: e.detail?.value || null })}
                      />
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon="Send"
                      loading={testing === def.type}
                      disabled={disabled || !route.channelId || isDirty(def.type) || (testing !== null && testing !== def.type)}
                      disabledReason={isDirty(def.type) ? m.lg_test_save_first() : !route.channelId ? m.lg_route_none() : ""}
                      aria-label={m.lg_test_label({ event: labels.label() })}
                      onclick={() => runTest(def.type)}
                    >{m.lg_test()}</Button>
                  </div>

                  {#if !route.channelId}
                    <p class="mt-2 flex items-start gap-1.5 text-2xs text-warning">
                      <Papicon icon="AlertTriangle" size={14} class="mt-px shrink-0" />
                      <span>{m.lg_route_none()}</span>
                    </p>
                  {:else if route.viaModule}
                    <p class="mt-2 flex items-start gap-1.5 text-2xs text-on-surface-variant">
                      <Papicon icon="Info" size={14} class="mt-px shrink-0" />
                      <span>{m.lg_route_module({ channel: channelLabel(route.channelId) })}</span>
                    </p>
                  {/if}
                {:else if def.interactive}
                  <p class="mt-2 flex items-start gap-1.5 text-2xs text-warning">
                    <Papicon icon="AlertTriangle" size={14} class="mt-px shrink-0" />
                    <span>{m.lg_interactive_off_warn()}</span>
                  </p>
                {/if}
              </li>
            {/each}
          </ul>
        </SectionCard>
      {/each}
    </div>
  {/if}
</div>
