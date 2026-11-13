<script lang="ts">
  /**
   * Activite de toute la flotte : ce qui s'ecrit sur l'ensemble des serveurs,
   * quand, ou (serveurs, salons, categories) et sous quelle forme.
   */
  import { onMount } from 'svelte';
  import { fetchFleetActivity, type FleetActivity } from '../../lib/api/adminInsights';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import AdminCard from '../../lib/components/admin/AdminCard.svelte';
  import AdminBarList from '../../lib/components/admin/AdminBarList.svelte';
  import AdminHeatmap from '../../lib/components/admin/AdminHeatmap.svelte';
  import AdminContentMix from '../../lib/components/admin/AdminContentMix.svelte';
  import MetricTabs, { type MetricTab } from '../../lib/components/analytics/MetricTabs.svelte';
  import TimeSeriesChart from '../../lib/components/analytics/TimeSeriesChart.svelte';
  import { SERIES, shortDate } from '../../lib/components/analytics/analyticsFormat';
  import { delta, formatCompact, formatNumber, formatVoice } from '../../lib/components/admin/format';
  import { Button, Callout, FilterPills } from '../../lib/components/ui';
  import { errorMessage } from '@kotbo/shared';

  let data = $state<FleetActivity | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let days = $state('30');
  let metric = $state<'messages' | 'activeGuilds' | 'voice' | 'net'>('messages');
  let chartMode = $state<'line' | 'bar'>('line');

  async function load() {
    loading = true;
    try {
      data = await fetchFleetActivity(Number(days));
      error = null;
    } catch (err) {
      error = errorMessage(err);
    } finally {
      loading = false;
    }
  }

  onMount(load);

  function changeDays(value: string) {
    days = value;
    void load();
  }

  const series = $derived(data?.series ?? []);
  const totals = $derived(data?.totals);
  const previous = $derived(data?.previousTotals);
  const labels = $derived(series.map((day) => shortDate(day.dateKey)));

  const net = $derived(totals ? totals.membersJoined - totals.membersLeft : 0);
  const activeGuildsAvg = $derived(series.length > 0 ? Math.round(series.reduce((sum, day) => sum + day.activeGuilds, 0) / series.length) : 0);

  const metricTabs = $derived<MetricTab[]>([
    {
      id: 'messages',
      label: 'Messages',
      value: totals ? formatCompact(totals.messagesCount) : '–',
      delta: totals && previous ? delta(totals.messagesCount, previous.messagesCount) : null,
      spark: series.map((d) => d.messagesCount),
      color: SERIES[0],
      hint: totals ? `${formatCompact(totals.reactionsCount)} réactions` : undefined,
    },
    {
      id: 'activeGuilds',
      label: 'Serveurs actifs / jour',
      value: data ? formatNumber(activeGuildsAvg) : '–',
      spark: series.map((d) => d.activeGuilds),
      color: SERIES[1],
      hint: data ? `${data.silentGuilds ?? 0} serveur${(data.silentGuilds ?? 0) > 1 ? 's' : ''} sans message` : undefined,
    },
    {
      id: 'voice',
      label: 'Vocal',
      value: totals ? formatVoice(totals.voiceMinutes) : '–',
      delta: totals && previous ? delta(totals.voiceMinutes, previous.voiceMinutes) : null,
      spark: series.map((d) => Math.round(d.voiceMinutes / 60)),
      color: SERIES[2],
    },
    {
      id: 'net',
      label: 'Membres gagnés',
      value: totals ? `${net >= 0 ? '+' : ''}${formatNumber(net)}` : '–',
      spark: series.map((d) => d.membersJoined - d.membersLeft),
      color: SERIES[3],
      hint: totals ? `${formatNumber(totals.membersJoined)} arrivées · ${formatNumber(totals.membersLeft)} départs` : undefined,
    },
  ]);

  const chartTitle = $derived(
    metric === 'messages'
      ? 'Messages et réactions'
      : metric === 'activeGuilds'
        ? 'Serveurs actifs par jour'
        : metric === 'voice'
          ? 'Heures passées en vocal'
          : 'Arrivées et départs',
  );
</script>

<AdminShell title="Activité" description="Ce qui se passe sur l’ensemble des serveurs : volumes, moments forts, salons et catégories qui portent l’activité.">
  {#snippet actions()}
    <FilterPills
      label="Période"
      value={days}
      onchange={changeDays}
      options={[
        { value: '7', label: '7 jours' },
        { value: '30', label: '30 jours' },
        { value: '90', label: '90 jours' },
      ]}
    />
  {/snippet}

  {#if error}
    <Callout variant="danger">
      {error}
      {#snippet actions()}
        <Button size="sm" icon="RefreshCw" onclick={load}>Réessayer</Button>
      {/snippet}
    </Callout>
  {/if}

  {#if loading && !data}
    <div class="h-28 admin-surface animate-pulse"></div>
  {:else}
    <MetricTabs
      metrics={metricTabs}
      active={metric}
      onchange={(id) => {
        if (id === 'messages' || id === 'activeGuilds' || id === 'voice' || id === 'net') metric = id;
      }}
      label="Indicateurs d’activité de la flotte"
    />
  {/if}

  <AdminCard title={chartTitle} description="Clique sur un compteur au-dessus pour changer la vue">
    {#snippet actions()}
      <FilterPills
        label="Style du graphique"
        value={chartMode}
        onchange={(v) => (chartMode = v)}
        options={[
          { value: 'line', label: 'Courbe' },
          { value: 'bar', label: 'Barres' },
        ]}
      />
    {/snippet}

    {#if series.length < 2}
      <p class="py-12 text-center text-body-sm text-on-surface-variant">Pas encore assez de jours mesurés pour tracer une courbe.</p>
    {:else if metric === 'messages'}
      <TimeSeriesChart
        {labels}
        mode="lines"
        stacks={[
          { label: 'Messages', values: series.map((d) => d.messagesCount), color: SERIES[0] },
          { label: 'Réactions', values: series.map((d) => d.reactionsCount), color: SERIES[1] },
        ]}
        format={(v) => formatNumber(v)}
      />
    {:else if metric === 'net'}
      <TimeSeriesChart
        {labels}
        mode="lines"
        stacks={[
          { label: 'Arrivées', values: series.map((d) => d.membersJoined), color: SERIES[2] },
          { label: 'Départs', values: series.map((d) => d.membersLeft), color: SERIES[3] },
        ]}
        format={(v) => formatNumber(v)}
      />
    {:else if metric === 'activeGuilds'}
      <TimeSeriesChart
        {labels}
        mode={chartMode}
        main={{ label: 'Serveurs actifs', values: series.map((d) => d.activeGuilds), color: SERIES[1] }}
        format={(v) => formatNumber(v)}
      />
    {:else}
      <TimeSeriesChart
        {labels}
        mode={chartMode}
        main={{ label: 'Heures de vocal', values: series.map((d) => Math.round((d.voiceMinutes / 60) * 10) / 10), color: SERIES[2] }}
        format={(v) => `${formatNumber(v)} h`}
      />
    {/if}
  </AdminCard>

  <div class="grid grid-cols-1 xl:grid-cols-3 gap-5 items-start">
    <AdminCard title="Serveurs" description="Les plus actifs en messages">
      <AdminBarList
        items={(data?.guilds ?? []).filter((guild) => guild.messages > 0).map((guild) => ({
          key: guild.guildId,
          label: guild.name ?? guild.guildId,
          sublabel: `${formatCompact(guild.memberCount)} membres`,
          value: guild.messages,
          href: `/admin/servers/${guild.guildId}`,
          image: guild.icon,
        }))}
        formatValue={formatCompact}
      />
    </AdminCard>

    <AdminCard title="Salons" description="Tous serveurs confondus">
      <AdminBarList
        items={(data?.channels ?? []).map((channel) => ({
          key: channel.channelId,
          label: `#${channel.name ?? 'salon supprimé'}`,
          sublabel: channel.guildName ?? '',
          value: channel.messages,
          href: `/admin/servers/${channel.guildId}`,
        }))}
        formatValue={formatCompact}
      />
    </AdminCard>

    <AdminCard title="Catégories" description="Parmi les 300 salons les plus actifs">
      <AdminBarList
        items={(data?.categories ?? []).map((category) => ({
          key: `${category.guildId}:${category.categoryId}`,
          label: category.name ?? 'Sans catégorie',
          sublabel: `${category.guildName ?? ''} · ${category.channels} salon${category.channels > 1 ? 's' : ''}`,
          value: category.messages,
          href: `/admin/servers/${category.guildId}`,
        }))}
        formatValue={formatCompact}
      />
    </AdminCard>
  </div>

  <div class="grid grid-cols-1 xl:grid-cols-2 gap-5 items-start">
    <AdminCard title="Quand écrit-on ?" description="Messages par jour de la semaine et par heure">
      {#if data?.heat}
        <AdminHeatmap grid={data.heat} />
      {:else}
        <div class="h-40 rounded-2xl bg-on-surface/6 animate-pulse"></div>
      {/if}
    </AdminCard>

    <AdminCard title="De quoi sont faits les messages" description={data?.content ? `${formatCompact(data.content.messages)} messages analysés, sans jamais lire leur texte` : ''}>
      {#if data?.content}
        <AdminContentMix content={data.content} />
      {:else}
        <div class="h-40 rounded-2xl bg-on-surface/6 animate-pulse"></div>
      {/if}
    </AdminCard>
  </div>
</AdminShell>
