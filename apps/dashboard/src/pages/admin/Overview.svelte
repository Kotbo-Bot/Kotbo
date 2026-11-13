<script lang="ts">
  /**
   * Accueil de la console admin.
   *
   * Une seule question : « est-ce que quelque chose demande mon attention, et
   * comment va Kotbo ? ». Dans l'ordre : ce qu'il y a a traiter, les chiffres
   * qui comptent, de quoi retrouver un serveur, puis la sante dans le temps.
   *
   * Chaque source se charge de son cote : une API lente ou en panne ne retient
   * pas le reste de la page.
   */
  import { onMount, onDestroy } from 'svelte';
  import {
    fetchAdminHealthSeries,
    fetchAdminGuilds,
    fetchAdminBilling,
    fetchBotErrorGroups,
    fetchBroadcastHistory,
    fetchAdminAudit,
    type AdminBillingState,
    type AdminHealthSeries,
    type AdminAuditEntry,
    type BotErrorGroup,
    type BroadcastLogEntry,
  } from '../../lib/api';
  import { fetchAdminSiteReports } from '../../lib/api/site';
  import { subscribeRealtime } from '../../lib/stores/realtime.svelte';
  import Papicon from '../../lib/components/Papicon.svelte';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import AdminCard from '../../lib/components/admin/AdminCard.svelte';
  import AdminStat from '../../lib/components/admin/AdminStat.svelte';
  import AdminBadge from '../../lib/components/admin/AdminBadge.svelte';
  import AdminTimeSeries from '../../lib/components/admin/AdminTimeSeries.svelte';
  import { adminHealth, refreshAdminHealth } from '../../lib/components/admin/adminHealth.svelte';
  import type { AdminTone } from '../../lib/components/admin/types';
  import { Button, FilterPills } from '../../lib/components/ui';

  interface AdminGuild {
    id: string;
    name: string;
    icon: string | null;
    memberCount: number;
    activated: boolean;
    joinedAt: string | null;
  }

  const DAY_MS = 86_400_000;

  let guilds = $state<AdminGuild[] | null>(null);
  let billing = $state<AdminBillingState | null>(null);
  let errorGroups = $state<BotErrorGroup[]>([]);
  let openReports = $state(0);
  let series = $state<AdminHealthSeries | null>(null);
  let broadcasts = $state<BroadcastLogEntry[]>([]);
  let audit = $state<AdminAuditEntry[]>([]);

  let refreshing = $state(false);
  let chartWindow = $state('60');
  let metric = $state<'memory' | 'ping' | 'reach'>('memory');
  let query = $state('');
  let unsubscribe: (() => void) | null = null;

  const ignore = () => null;

  function loadGuilds() {
    return fetchAdminGuilds().then((data) => (guilds = data.guilds ?? [])).catch(() => (guilds ??= []));
  }

  async function loadAll() {
    refreshing = true;
    await Promise.all([
      refreshAdminHealth(),
      loadGuilds(),
      fetchAdminBilling().then((data) => (billing = data)).catch(ignore),
      fetchBotErrorGroups().then((data) => (errorGroups = data.groups)).catch(ignore),
      fetchAdminSiteReports('OPEN').then((data) => (openReports = data.reports.length)).catch(ignore),
      fetchAdminHealthSeries(Number(chartWindow)).then((data) => (series = data)).catch(ignore),
      fetchBroadcastHistory(4).then((data) => (broadcasts = data.logs)).catch(ignore),
      fetchAdminAudit({ limit: 6 }).then((data) => (audit = data.entries)).catch(ignore),
    ]);
    refreshing = false;
  }

  onMount(() => {
    void loadAll();
    unsubscribe = subscribeRealtime({
      types: ['bot_guilds_changed'],
      guildScoped: false,
      fallbackMs: 60_000,
      onUpdate: () => void loadGuilds(),
    });
  });

  onDestroy(() => unsubscribe?.());

  async function changeWindow(value: string) {
    chartWindow = value;
    series = await fetchAdminHealthSeries(Number(value)).catch(() => series);
  }

  // ── Derives ───────────────────────────────────────────────────────────────
  const health = $derived(adminHealth.data);
  const samples = $derived(series?.samples ?? []);
  const heapPercent = $derived(health ? Math.round((health.heapUsed / health.heapTotal) * 100) : 0);
  const shardsHealthy = $derived(health ? health.onlineShardCount === health.shardCount && health.shardCount > 0 : true);
  const activatedCount = $derived(guilds?.filter((guild) => guild.activated).length ?? 0);
  const newThisWeek = $derived(
    guilds?.filter((guild) => guild.joinedAt && Date.now() - new Date(guild.joinedAt).getTime() < 7 * DAY_MS).length ?? 0,
  );

  interface Todo {
    tone: AdminTone;
    icon: string;
    title: string;
    detail: string;
    href: string;
  }

  /** Tout ce qui attend une decision, du plus grave au moins grave. */
  const todos = $derived.by(() => {
    const list: Todo[] = [];

    if (adminHealth.error) {
      list.push({ tone: 'danger', icon: 'AlertTriangle', title: 'L’API du bot ne répond pas', detail: 'Les chiffres affichés peuvent être périmés.', href: '/admin/config' });
    }
    if (health && !shardsHealthy) {
      const offline = health.shardCount - health.onlineShardCount;
      list.push({ tone: 'danger', icon: 'Zap', title: `${offline} shard${offline > 1 ? 's' : ''} hors ligne`, detail: 'Des serveurs ne reçoivent plus rien tant qu’il n’est pas revenu.', href: '/admin/shards' });
    }
    if (heapPercent > 85) {
      list.push({ tone: 'danger', icon: 'Cpu', title: `Mémoire à ${heapPercent} %`, detail: 'Un redémarrage contrôlé vaut mieux qu’un arrêt brutal.', href: '/admin/shards' });
    } else if (series && series.heapTrendPerHour > 0 && samples.length > 1 && Number(chartWindow) >= 60) {
      const first = samples[0].heapUsed;
      const growth = first > 0 ? ((samples[samples.length - 1].heapUsed - first) / first) * 100 : 0;
      if (growth > 25) {
        list.push({ tone: 'warning', icon: 'TrendingUp', title: `Mémoire en hausse de ${growth.toFixed(0)} %`, detail: 'Croissance continue sur la période : à surveiller, ça ressemble à une fuite.', href: '/admin/shards' });
      }
    }
    if (health && health.averageShardPing > 250) {
      list.push({ tone: 'warning', icon: 'activity', title: `Latence Discord à ${health.averageShardPing} ms`, detail: 'Les commandes peuvent expirer avant la réponse.', href: '/admin/shards' });
    }

    const recentErrors = errorGroups.filter((group) => Date.now() - new Date(group.lastAt).getTime() < DAY_MS);
    if (recentErrors.length > 0) {
      const total = recentErrors.reduce((sum, group) => sum + group.count, 0);
      list.push({ tone: 'warning', icon: 'Terminal', title: `${recentErrors.length} erreur${recentErrors.length > 1 ? 's' : ''} du bot depuis 24 h`, detail: `${total} occurrence${total > 1 ? 's' : ''} · la plus fréquente : ${recentErrors[0].message.slice(0, 80)}`, href: '/admin/config' });
    }

    if (openReports > 0) {
      list.push({ tone: 'warning', icon: 'Globe', title: `${openReports} signalement${openReports > 1 ? 's' : ''} de site à examiner`, detail: 'Des visiteurs ont signalé un site communautaire.', href: '/admin/sites' });
    }

    if (billing) {
      const unpaid = billing.guilds.filter((guild) => guild.stripeSubscriptionStatus === 'past_due' || guild.stripeSubscriptionStatus === 'unpaid');
      if (unpaid.length > 0) {
        list.push({ tone: 'warning', icon: 'CreditCard', title: `${unpaid.length} paiement${unpaid.length > 1 ? 's' : ''} en échec`, detail: unpaid.slice(0, 3).map((guild) => guild.name ?? guild.id).join(', '), href: '/admin/billing' });
      }
      const expiring = billing.guilds.filter((guild) => {
        if (!guild.accessExpiresAt) return false;
        const left = new Date(guild.accessExpiresAt).getTime() - Date.now();
        return left > 0 && left < 3 * DAY_MS;
      });
      if (expiring.length > 0) {
        list.push({ tone: 'info', icon: 'Clock', title: `${expiring.length} accès expire${expiring.length > 1 ? 'nt' : ''} sous 3 jours`, detail: expiring.slice(0, 3).map((guild) => guild.name ?? guild.id).join(', '), href: '/admin/billing' });
      }
    }

    return list;
  });

  const toneChip: Record<AdminTone, string> = {
    danger: 'bg-error/12 text-error',
    warning: 'bg-warning/12 text-warning',
    info: 'bg-sky-500/12 text-sky-500',
    success: 'bg-success/12 text-success',
    primary: 'bg-primary/12 text-primary',
    neutral: 'bg-on-surface/8 text-on-surface-variant',
  };

  // Retrouver un serveur : la recherche se fait sur place, sans changer de page.
  const matches = $derived.by(() => {
    const all = guilds ?? [];
    const needle = query.trim().toLowerCase();
    const pool = needle ? all.filter((guild) => guild.name.toLowerCase().includes(needle) || guild.id.includes(needle)) : all;
    return [...pool].sort((a, b) => b.memberCount - a.memberCount).slice(0, 6);
  });

  // Repartition des offres : une barre, pas un camembert pour quatre valeurs.
  const planShades = ['bg-on-surface/15', 'bg-primary', 'bg-success', 'bg-warning', 'bg-sky-500'];
  const plans = $derived.by(() => {
    if (!billing) return [];
    const total = Object.values(billing.counts).reduce((sum, count) => sum + count, 0);
    return billing.plans
      .map((plan, index) => ({ ...plan, count: billing!.counts[plan.key] ?? 0, shade: planShades[index % planShades.length] }))
      .filter((plan) => plan.count > 0)
      .map((plan) => ({ ...plan, percent: total > 0 ? (plan.count / total) * 100 : 0 }));
  });
  const payingCount = $derived(billing ? Object.entries(billing.counts).reduce((sum, [key, count]) => (key === 'FREE' ? sum : sum + count), 0) : 0);

  const chartSeries = $derived.by(() => {
    if (samples.length < 2) return [];
    const points = (pick: (sample: (typeof samples)[number]) => number) => samples.map((sample) => ({ t: sample.t, v: pick(sample) }));
    if (metric === 'memory') {
      return [
        { key: 'heap', label: 'Heap utilisé', color: 'var(--primary-color)', points: points((s) => s.heapUsed / 1024 / 1024) },
        { key: 'rss', label: 'RSS', color: '#a855f7', points: points((s) => s.rss / 1024 / 1024) },
      ];
    }
    if (metric === 'ping') {
      return [
        { key: 'ping', label: 'Ping moyen (ms)', color: '#0ea5e9', points: points((s) => s.averagePing) },
        { key: 'cpu', label: 'CPU (%)', color: '#f59e0b', points: points((s) => s.cpu) },
      ];
    }
    return [
      { key: 'guilds', label: 'Serveurs', color: '#10b981', points: points((s) => s.guilds) },
      { key: 'shards', label: 'Shards en ligne', color: '#ef4444', points: points((s) => s.onlineShards) },
    ];
  });

  // ── Formatage ─────────────────────────────────────────────────────────────
  const nf = new Intl.NumberFormat('fr-FR');

  function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    if (days > 0) return `${days} j ${hours} h`;
    return hours > 0 ? `${hours} h ${Math.floor((seconds % 3600) / 60)} min` : `${Math.floor(seconds / 60)} min`;
  }

  function relativeTime(iso: string): string {
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
    if (minutes < 1) return 'à l’instant';
    if (minutes < 60) return `il y a ${minutes} min`;
    const hours = Math.round(minutes / 60);
    return hours < 24 ? `il y a ${hours} h` : `il y a ${Math.round(hours / 24)} j`;
  }
</script>

<AdminShell title="Accueil">
  {#snippet actions()}
    <Button href="/admin/broadcast" icon="Megaphone">Nouvelle annonce</Button>
    <Button href="/admin/activation" icon="Key">Générer un code</Button>
    <Button icon="RefreshCw" loading={refreshing} aria-label="Actualiser" title="Actualiser" onclick={loadAll} />
  {/snippet}

  <!-- 1. Ce qui attend une decision -->
  {#if todos.length > 0}
    <AdminCard title="À traiter" padded={false}>
      {#snippet actions()}
        <AdminBadge label={String(todos.length)} tone={todos.some((todo) => todo.tone === 'danger') ? 'danger' : 'warning'} />
      {/snippet}
      <ul class="divide-y divide-outline-variant/40">
        {#each todos as todo (todo.title)}
          <li>
            <a href={todo.href} class="flex items-center gap-3 px-5 py-3.5 hover:bg-on-surface/3 transition-colors focus-visible:outline-2 focus-visible:outline-primary">
              <span class="w-9 h-9 shrink-0 rounded-[11px] flex items-center justify-center {toneChip[todo.tone]}">
                <Papicon icon={todo.icon} size={16} />
              </span>
              <span class="min-w-0 flex-1">
                <span class="block text-sm font-semibold text-on-surface">{todo.title}</span>
                <span class="block text-xs text-on-surface-variant truncate">{todo.detail}</span>
              </span>
              <Papicon icon="ChevronRight" size={15} class="text-on-surface-variant shrink-0" />
            </a>
          </li>
        {/each}
      </ul>
    </AdminCard>
  {:else if health && guilds}
    <div class="flex items-center gap-3 rounded-[20px] bg-success/10 px-5 py-4">
      <span class="w-9 h-9 shrink-0 rounded-[11px] bg-success/15 text-success flex items-center justify-center">
        <Papicon icon="Check" size={17} />
      </span>
      <div>
        <p class="text-sm font-semibold text-on-surface">Rien à traiter</p>
        <p class="text-xs text-on-surface-variant">Shards complets, pas d’erreur récente, aucun signalement ni paiement en attente.</p>
      </div>
    </div>
  {/if}

  <!-- 2. Les chiffres qui comptent -->
  <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
    <AdminStat
      label="Serveurs"
      value={health ? nf.format(health.guildCount) : '–'}
      hint={newThisWeek > 0 ? `+${newThisWeek} cette semaine` : `${activatedCount} activés`}
      icon="Server"
      tone="info"
      series={samples.map((sample) => sample.guilds)}
      loading={!health}
      href="/admin/servers"
    />
    <AdminStat
      label="Membres couverts"
      value={health ? nf.format(health.userCount) : '–'}
      hint={health && health.guildCount > 0 ? `${nf.format(Math.round(health.userCount / health.guildCount))} par serveur` : ''}
      icon="Users"
      tone="primary"
      loading={!health}
    />
    <AdminStat
      label="Serveurs payants"
      value={billing ? nf.format(payingCount) : '–'}
      hint={billing ? `${billing.subscriptions} abonnement${billing.subscriptions > 1 ? 's' : ''} · ${billing.trials} essai${billing.trials > 1 ? 's' : ''}` : ''}
      icon="CreditCard"
      tone="success"
      loading={!billing}
      href="/admin/billing"
    />
    <AdminStat
      label="Santé du bot"
      value={health ? `${health.averageShardPing} ms` : '–'}
      hint={health ? `${health.onlineShardCount}/${health.shardCount} shards · mém. ${heapPercent} %` : ''}
      icon="activity"
      tone={!shardsHealthy || heapPercent > 85 ? 'danger' : health && health.averageShardPing > 250 ? 'warning' : 'success'}
      series={samples.map((sample) => sample.averagePing)}
      loading={!health}
      href="/admin/shards"
    />
  </div>

  <div class="grid grid-cols-1 lg:grid-cols-5 gap-5 items-start">
    <!-- 3. Retrouver un serveur -->
    <AdminCard title="Trouver un serveur" class="lg:col-span-3" padded={false}>
      {#snippet actions()}
        <a href="/admin/servers" class="text-body-sm font-semibold text-primary hover:underline">Tout voir</a>
      {/snippet}
      <div class="p-4 pb-2">
        <div class="relative">
          <Papicon icon="Search" size={15} class="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none" />
          <input type="search" bind:value={query} placeholder="Nom ou identifiant du serveur…" aria-label="Rechercher un serveur" class="input pl-9 h-11 rounded-2xl" />
        </div>
      </div>
      {#if guilds === null}
        <div class="p-4 space-y-2">
          {#each Array(4) as _, index (index)}
            <div class="h-10 rounded-xl bg-on-surface/6 animate-pulse"></div>
          {/each}
        </div>
      {:else if matches.length === 0}
        <p class="px-5 py-6 text-body-sm text-on-surface-variant text-center">Aucun serveur ne correspond à « {query} ».</p>
      {:else}
        <ul class="pb-2">
          {#each matches as guild (guild.id)}
            <li>
              <a
                href="/admin/servers/{guild.id}"
                class="flex items-center gap-3 px-5 py-2.5 hover:bg-on-surface/3 transition-colors focus-visible:outline-2 focus-visible:outline-primary"
              >
                <span class="w-9 h-9 shrink-0 rounded-[11px] bg-on-surface/6 overflow-hidden flex items-center justify-center text-on-surface-variant">
                  {#if guild.icon}
                    <img src={guild.icon} alt="" class="w-full h-full object-cover" loading="lazy" />
                  {:else}
                    <span class="text-sm font-bold">{guild.name.charAt(0).toUpperCase()}</span>
                  {/if}
                </span>
                <span class="min-w-0 flex-1 text-sm font-medium text-on-surface truncate">{guild.name}</span>
                {#if !guild.activated}
                  <AdminBadge size="sm" label="Non activé" tone="neutral" />
                {/if}
                <span class="text-body-sm text-on-surface-variant tabular-nums">{nf.format(guild.memberCount)}</span>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </AdminCard>

    <!-- 4. Offres et activite recente, empilees a cote de la recherche -->
    <div class="lg:col-span-2 space-y-5">
      <AdminCard title="Offres">
        {#snippet actions()}
          <a href="/admin/billing" class="text-body-sm font-semibold text-primary hover:underline">Abonnements</a>
        {/snippet}
        {#if !billing}
          <div class="h-24 rounded-xl bg-on-surface/6 animate-pulse"></div>
        {:else if plans.length === 0}
          <p class="text-body-sm text-on-surface-variant">Aucun serveur n’a encore d’offre.</p>
        {:else}
          <div class="flex h-3 rounded-full overflow-hidden gap-0.5" role="img" aria-label="Répartition des serveurs par offre">
            {#each plans as plan (plan.key)}
              <div class="{plan.shade} h-full" style="width: {plan.percent}%"></div>
            {/each}
          </div>
          <dl class="mt-4 space-y-2.5">
            {#each plans as plan (plan.key)}
              <div class="flex items-center gap-2.5">
                <span class="w-2.5 h-2.5 rounded-full {plan.shade}"></span>
                <dt class="flex-1 text-body-sm text-on-surface">{plan.name}</dt>
                <dd class="text-body-sm font-semibold text-on-surface tabular-nums">{nf.format(plan.count)}</dd>
                <dd class="w-12 text-right text-xs text-on-surface-variant tabular-nums">{plan.percent.toFixed(0)} %</dd>
              </div>
            {/each}
          </dl>
        {/if}
      </AdminCard>
      <AdminCard title="Dernières annonces">
        {#snippet actions()}
          <a href="/admin/broadcast" class="text-body-sm font-semibold text-primary hover:underline">Annonces</a>
        {/snippet}
        {#if broadcasts.length === 0}
          <p class="text-body-sm text-on-surface-variant">Aucune annonce globale envoyée pour l’instant.</p>
        {:else}
          <ul class="space-y-3">
            {#each broadcasts as log (log.id)}
              <li class="flex items-center gap-3">
                <span class="w-1 h-9 rounded-full shrink-0" style="background: {log.color}"></span>
                <div class="min-w-0 flex-1">
                  <p class="text-body-sm font-semibold text-on-surface truncate">{log.title}</p>
                  <p class="text-xs text-on-surface-variant">{relativeTime(log.createdAt)} · {log.username ?? log.sentBy}</p>
                </div>
                <p class="text-body-sm font-semibold tabular-nums shrink-0">
                  <span class="text-success">{log.successCount}</span>{#if log.failCount > 0}<span class="text-on-surface-variant"> / </span><span class="text-error">{log.failCount}</span>{/if}
                  <span class="text-xs font-normal text-on-surface-variant"> sur {log.totalTargeted}</span>
                </p>
              </li>
            {/each}
          </ul>
        {/if}
      </AdminCard>
      <AdminCard title="Dernières actions admin">
        {#snippet actions()}
          <a href="/admin/audit" class="text-body-sm font-semibold text-primary hover:underline">Journal</a>
        {/snippet}
        {#if audit.length === 0}
          <p class="text-body-sm text-on-surface-variant">Aucune action enregistrée. Le journal se remplit à la prochaine action sensible.</p>
        {:else}
          <ul class="space-y-3">
            {#each audit as entry (entry.id)}
              <li class="flex items-start gap-2.5">
                <span class="w-2 h-2 rounded-full mt-1.5 shrink-0 {entry.outcome === 'OK' ? 'bg-success' : 'bg-error'}"></span>
                <div class="min-w-0">
                  <p class="text-body-sm text-on-surface leading-snug">{entry.summary}</p>
                  <p class="text-xs text-on-surface-variant mt-0.5">{relativeTime(entry.createdAt)}</p>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </AdminCard>

    </div>
  </div>

  <!-- 5. Sante dans le temps -->
  <AdminCard title="Santé dans le temps" description={health ? `En ligne depuis ${formatUptime(health.uptime)}` : ''}>
    {#snippet actions()}
      <FilterPills
        label="Mesure"
        value={metric}
        onchange={(value) => (metric = value)}
        options={[
          { value: 'memory', label: 'Mémoire' },
          { value: 'ping', label: 'Latence' },
          { value: 'reach', label: 'Couverture' },
        ]}
      />
      <FilterPills
        label="Période"
        value={chartWindow}
        onchange={changeWindow}
        options={[
          { value: '60', label: '1 h' },
          { value: '360', label: '6 h' },
          { value: '1440', label: '24 h' },
        ]}
      />
    {/snippet}
    <AdminTimeSeries
      series={chartSeries}
      formatValue={(value) => `${Math.round(value)}${metric === 'memory' ? ' Mo' : ''}`}
      emptyLabel="L’historique se remplit à partir de la première visite de la console. Reviens dans quelques minutes."
    />
  </AdminCard>

</AdminShell>
