<script lang="ts">
  /**
   * Activite de toute la flotte : ce qui s'ecrit sur l'ensemble des serveurs,
   * quand, ou (serveurs, salons, categories) et sous quelle forme.
   */
  import { onMount } from 'svelte';
  import { fetchFleetActivity, type FleetActivity } from '../../lib/api/adminInsights';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import AdminCard from '../../lib/components/admin/AdminCard.svelte';
  import AdminStat from '../../lib/components/admin/AdminStat.svelte';
  import AdminTimeSeries from '../../lib/components/admin/AdminTimeSeries.svelte';
  import AdminBarList from '../../lib/components/admin/AdminBarList.svelte';
  import AdminHeatmap from '../../lib/components/admin/AdminHeatmap.svelte';
  import AdminContentMix from '../../lib/components/admin/AdminContentMix.svelte';
  import { dayStart, delta, formatCompact, formatDay, formatNumber, formatVoice } from '../../lib/components/admin/format';
  import { Button, Callout, FilterPills } from '../../lib/components/ui';
  import { errorMessage } from '@kotbo/shared';

  let data = $state<FleetActivity | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let days = $state('30');
  let metric = $state<'messages' | 'members' | 'voice'>('messages');

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
  const pick = (key: 'messagesCount' | 'voiceMinutes' | 'activeGuilds' | 'reactionsCount') => series.map((day) => day[key]);

  const chart = $derived.by(() => {
    if (series.length < 2) return [];
    const points = (value: (day: (typeof series)[number]) => number) => series.map((day) => ({ t: dayStart(day.dateKey), v: value(day) }));
    if (metric === 'messages') {
      return [
        { key: 'messages', label: 'Messages', color: 'var(--primary-color)', points: points((day) => day.messagesCount) },
        { key: 'reactions', label: 'Réactions', color: '#f0932b', points: points((day) => day.reactionsCount) },
      ];
    }
    if (metric === 'members') {
      return [
        { key: 'joined', label: 'Arrivées', color: '#10b981', points: points((day) => day.membersJoined) },
        { key: 'left', label: 'Départs', color: '#ef4444', points: points((day) => day.membersLeft) },
      ];
    }
    return [{ key: 'voice', label: 'Heures de vocal', color: '#0ea5e9', points: points((day) => day.voiceMinutes / 60) }];
  });

  const net = $derived(totals ? totals.membersJoined - totals.membersLeft : 0);
  const activeGuildsAvg = $derived(series.length > 0 ? Math.round(series.reduce((sum, day) => sum + day.activeGuilds, 0) / series.length) : 0);
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

  <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
    <AdminStat
      label="Messages"
      value={totals ? formatCompact(totals.messagesCount) : '–'}
      delta={totals && previous ? delta(totals.messagesCount, previous.messagesCount) : null}
      hint="vs période d’avant"
      icon="MessageCircle"
      tone="primary"
      series={pick('messagesCount')}
      loading={loading && !data}
    />
    <AdminStat
      label="Serveurs actifs par jour"
      value={data ? formatNumber(activeGuildsAvg) : '–'}
      hint={data ? `${data.silentGuilds} serveur${data.silentGuilds > 1 ? 's' : ''} sans message` : ''}
      icon="Server"
      tone="info"
      series={pick('activeGuilds')}
      loading={loading && !data}
      href="/admin/servers"
    />
    <AdminStat
      label="Vocal"
      value={totals ? formatVoice(totals.voiceMinutes) : '–'}
      delta={totals && previous ? delta(totals.voiceMinutes, previous.voiceMinutes) : null}
      icon="Mic"
      tone="info"
      series={pick('voiceMinutes')}
      loading={loading && !data}
    />
    <AdminStat
      label="Membres gagnés"
      value={totals ? `${net >= 0 ? '+' : ''}${formatNumber(net)}` : '–'}
      hint={totals ? `${formatNumber(totals.membersJoined)} arrivées · ${formatNumber(totals.membersLeft)} départs` : ''}
      icon="Users"
      tone={net >= 0 ? 'success' : 'danger'}
      loading={loading && !data}
    />
  </div>

  <AdminCard title="Dans le temps">
    {#snippet actions()}
      <FilterPills
        label="Mesure"
        value={metric}
        onchange={(value) => (metric = value)}
        options={[
          { value: 'messages', label: 'Messages' },
          { value: 'members', label: 'Membres' },
          { value: 'voice', label: 'Vocal' },
        ]}
      />
    {/snippet}
    <AdminTimeSeries
      series={chart}
      height={240}
      formatTime={formatDay}
      formatValue={(value) => formatNumber(value)}
      emptyLabel="Pas encore assez de jours mesurés pour tracer une courbe."
    />
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
      {#if data}
        <AdminHeatmap grid={data.heat} />
      {:else}
        <div class="h-40 rounded-2xl bg-on-surface/6 animate-pulse"></div>
      {/if}
    </AdminCard>

    <AdminCard title="De quoi sont faits les messages" description={data ? `${formatCompact(data.content.messages)} messages analysés, sans jamais lire leur texte` : ''}>
      {#if data}
        <AdminContentMix content={data.content} />
      {:else}
        <div class="h-40 rounded-2xl bg-on-surface/6 animate-pulse"></div>
      {/if}
    </AdminCard>
  </div>
</AdminShell>
