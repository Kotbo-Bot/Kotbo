<script lang="ts">
  /**
   * Fiche d'un serveur : tout ce que Kotbo sait de lui, sur une seule page.
   *
   * Meme idee que la fiche d'un membre, a l'echelle d'un serveur : identite,
   * note de sante et ses raisons, activite, salons et categories, modules,
   * offre et acces, moderation, puis ce que l'equipe Kotbo y a fait.
   */
  import { getModuleDefinition } from '@kotbo/contracts';
  import { errorMessage } from '@kotbo/shared';
  import { fetchAdminGuildInvite } from '../../lib/api';
  import { fetchGuildSheet, type GuildSheet } from '../../lib/api/adminInsights';
  import { m } from '../../lib/i18n';
  import { moduleName } from '../../lib/moduleLabels';
  import { toast } from '../../lib/stores/toast.svelte';
  import Papicon from '../../lib/components/Papicon.svelte';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import AdminCard from '../../lib/components/admin/AdminCard.svelte';
  import AdminBadge from '../../lib/components/admin/AdminBadge.svelte';
  import AdminBarList from '../../lib/components/admin/AdminBarList.svelte';
  import AdminHeatmap from '../../lib/components/admin/AdminHeatmap.svelte';
  import AdminContentMix from '../../lib/components/admin/AdminContentMix.svelte';
  import MetricTabs, { type MetricTab } from '../../lib/components/analytics/MetricTabs.svelte';
  import TimeSeriesChart from '../../lib/components/analytics/TimeSeriesChart.svelte';
  import { SERIES, shortDate } from '../../lib/components/analytics/analyticsFormat';
  import type { AdminTone } from '../../lib/components/admin/types';
  import { formatCompact, formatDate, formatNumber, formatPercent, formatVoice, relativeTime } from '../../lib/components/admin/format';
  import { Button, Callout, FilterPills } from '../../lib/components/ui';

  const { guildId }: { guildId: string } = $props();

  type Section = 'overview' | 'activity' | 'setup' | 'moderation' | 'journal';

  let sheet = $state<GuildSheet | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let days = $state('30');
  let section = $state<Section>('overview');
  let overviewMetric = $state<'messages' | 'activeMembers' | 'voice' | 'net'>('messages');
  let chartMode = $state<'line' | 'bar'>('line');

  async function load() {
    loading = true;
    try {
      sheet = await fetchGuildSheet(guildId, Number(days));
      error = null;
    } catch (err) {
      error = errorMessage(err);
    } finally {
      loading = false;
    }
  }

  // Recharge aussi quand on passe d'une fiche a une autre sans quitter la page.
  $effect(() => {
    void guildId;
    void load();
  });

  function changeDays(value: string) {
    days = value;
    void load();
  }

  async function copyId() {
    try {
      await navigator.clipboard.writeText(guildId);
      toast.success(m.pf_copied());
    } catch {
      // Presse-papiers refusé : l'identifiant reste lisible sous le titre.
    }
  }

  async function openInvite() {
    try {
      const data = await fetchAdminGuildInvite(guildId);
      if (data.url) window.open(data.url, '_blank', 'noopener');
      else toast.error(m.asrv_no_invite());
    } catch (err) {
      toast.error(errorMessage(err) ?? m.asrv_invite_error());
    }
  }

  // ── Derives ───────────────────────────────────────────────────────────────
  const guild = $derived(sheet?.guild);
  const totals = $derived(sheet?.totals);
  const series = $derived(sheet?.series ?? []);
  const labels = $derived(series.map((day) => shortDate(day.dateKey)));
  const enabledModules = $derived((sheet?.modules ?? []).filter((module) => module.enabled));
  const disabledModules = $derived((sheet?.modules ?? []).filter((module) => !module.enabled));

  const scoreTone = $derived<AdminTone>(!sheet ? 'neutral' : (sheet.health?.score ?? 0) >= 75 ? 'success' : (sheet.health?.score ?? 0) >= 50 ? 'warning' : 'danger');
  const scoreLabel = $derived(!sheet ? '' : (sheet.health?.score ?? 0) >= 75 ? 'En forme' : (sheet.health?.score ?? 0) >= 50 ? 'À surveiller' : 'En difficulté');
  const toneText: Record<AdminTone, string> = {
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-error',
    info: 'text-sky-500',
    primary: 'text-primary',
    neutral: 'text-on-surface-variant',
  };
  const signalIcon = { danger: 'AlertTriangle', warning: 'AlertTriangle', info: 'Info', success: 'Check' } as const;

  const overviewMetrics = $derived<MetricTab[]>(
    !sheet
      ? []
      : [
          {
            id: 'messages',
            label: 'Messages',
            value: formatCompact(sheet.totals.messages),
            spark: series.map((day) => day.messages),
            color: SERIES[0],
            hint: sheet.fleet?.median > 0 ? `médiane de la flotte : ${formatCompact(sheet.fleet.median)}` : undefined,
          },
          {
            id: 'activeMembers',
            label: 'Membres actifs / jour',
            value: formatNumber(sheet.totals.activeMembersAvg),
            spark: series.map((day) => day.activeMembers),
            color: SERIES[1],
            hint: `${formatPercent(sheet.totals.activeMembersAvg, sheet.totals.memberCount, 1)} des membres`,
          },
          {
            id: 'voice',
            label: 'Vocal',
            value: formatVoice(sheet.totals.voiceMinutes),
            spark: series.map((day) => day.voiceMinutes),
            color: SERIES[2],
          },
          {
            id: 'net',
            label: 'Membres gagnés',
            value: `${sheet.totals.joined - sheet.totals.left >= 0 ? '+' : ''}${formatNumber(sheet.totals.joined - sheet.totals.left)}`,
            spark: series.map((day) => day.joined - day.left),
            color: SERIES[3],
            hint: `${formatNumber(sheet.totals.joined)} arrivées · ${formatNumber(sheet.totals.left)} départs`,
          },
        ],
  );

  const identity = $derived(
    !guild
      ? []
      : [
          { label: 'Identifiant', value: guild.id, mono: true },
          { label: 'Propriétaire', value: guild.ownerId ?? '–', mono: true },
          { label: 'Créé le', value: formatDate(guild.createdAt) },
          { label: 'Kotbo ajouté le', value: formatDate(guild.joinedAt) },
          { label: 'Langue', value: guild.locale ?? '–' },
          { label: 'Shard', value: guild.shardId !== undefined ? `#${guild.shardId}` : '–' },
          { label: 'Salons · rôles · emojis', value: `${guild.channelsCount ?? '–'} · ${guild.rolesCount ?? '–'} · ${guild.emojisCount ?? '–'}` },
          { label: 'Boosts', value: guild.boosts !== undefined ? `${guild.boosts} (niveau ${guild.premiumTier ?? 0})` : '–' },
        ],
  );

  const ACCESS_LABEL: Record<string, string> = { PERMANENT: 'Permanent', TRIAL: 'Essai', SUBSCRIPTION: 'Abonnement' };
  const AEGIS_KIND: Record<string, string> = { TOXIC: 'Toxicité', HARASSMENT: 'Harcèlement', CONFLICT: 'Conflit', DISTRESS: 'Détresse' };

  const sanctionRows = $derived(
    !totals
      ? []
      : [
          { label: 'Avertissements', value: totals.warns },
          { label: 'Exclusions temporaires', value: totals.timeouts },
          { label: 'Expulsions', value: totals.kicks },
          { label: 'Bannissements', value: totals.bans },
        ],
  );
</script>

<AdminShell
  title={guild?.name ?? 'Fiche serveur'}
  heading={guild?.name ?? (loading ? 'Chargement…' : 'Serveur inconnu')}
  description={guild
    ? `${formatNumber(totals?.memberCount ?? 0)} membres${sheet?.present ? '' : ' · Kotbo n’est plus sur ce serveur'}${sheet?.fleet.rank ? ` · n° ${sheet.fleet.rank} sur ${sheet.fleet.of} en messages` : ''}`
    : ''}
  backHref="/admin/servers"
  backLabel="Tous les serveurs"
>
  {#snippet lead()}
    <span class="w-16 h-16 sm:w-20 sm:h-20 shrink-0 rounded-[22px] bg-surface-container overflow-hidden flex items-center justify-center text-on-surface-variant">
      {#if guild?.icon}
        <img src={guild.icon} alt="" class="w-full h-full object-cover" />
      {:else if guild?.name}
        <span class="font-headline text-3xl font-bold">{guild.name.charAt(0).toUpperCase()}</span>
      {:else}
        <Papicon icon="Server" size={28} />
      {/if}
    </span>
  {/snippet}

  {#snippet actions()}
    <Button icon="Copy" onclick={copyId}>Copier l’ID</Button>
    {#if sheet?.present}
      <Button icon="Link" onclick={openInvite}>Invitation</Button>
      <Button variant="primary" icon="ExternalLink" href="/?guild={guildId}" target="_blank">Ouvrir son dashboard</Button>
    {/if}
  {/snippet}

  {#if error}
    <Callout variant="danger">
      {error}
      {#snippet actions()}
        <Button size="sm" icon="RefreshCw" onclick={load}>Réessayer</Button>
      {/snippet}
    </Callout>
  {/if}

  <div class="flex flex-wrap items-center justify-between gap-3">
    <FilterPills
      label="Partie de la fiche"
      value={section}
      onchange={(value) => (section = value)}
      options={[
        { value: 'overview', label: 'Vue d’ensemble' },
        { value: 'activity', label: 'Activité' },
        { value: 'setup', label: 'Modules et accès', count: enabledModules.length },
        { value: 'moderation', label: 'Modération' },
        { value: 'journal', label: 'Journal', count: sheet?.audit?.length ?? 0 },
      ]}
    />
    <FilterPills
      label="Période"
      value={days}
      onchange={changeDays}
      options={[
        { value: '7', label: '7 j' },
        { value: '30', label: '30 j' },
        { value: '90', label: '90 j' },
      ]}
    />
  </div>

  {#if !sheet}
    {#if loading}
      <div class="h-72 admin-surface animate-pulse"></div>
    {/if}
  {:else if section === 'overview'}
    <div class="grid grid-cols-1 lg:grid-cols-5 gap-5">
      <AdminCard title="Santé du serveur" class="lg:col-span-3">
        <div class="flex flex-col sm:flex-row gap-6">
          <div class="shrink-0">
            <p class="font-headline text-[64px] leading-none font-bold tracking-[-0.03em] tabular-nums {toneText[scoreTone]}">{sheet.health.score}</p>
            <p class="text-body-sm font-semibold text-on-surface mt-1">{scoreLabel}</p>
            <p class="text-xs text-on-surface-variant">note sur 100</p>
          </div>
          <ul class="flex-1 space-y-2.5">
            {#each sheet.health?.signals ?? [] as signal (signal.label)}
              <li class="flex items-start gap-2.5">
                <span class="mt-0.5 shrink-0 {toneText[signal.tone]}"><Papicon icon={signalIcon[signal.tone]} size={15} /></span>
                <span class="text-sm text-on-surface leading-snug">{signal.label}</span>
              </li>
            {/each}
          </ul>
        </div>
      </AdminCard>

      <AdminCard title="Identité" class="lg:col-span-2">
        <dl class="space-y-2.5">
          {#each identity as entry (entry.label)}
            <div class="flex items-baseline justify-between gap-3">
              <dt class="text-body-sm text-on-surface-variant shrink-0">{entry.label}</dt>
              <dd class="text-body-sm font-semibold text-on-surface text-right truncate {entry.mono ? 'font-mono' : ''}">{entry.value}</dd>
            </div>
          {/each}
        </dl>
        {#if guild?.botIsAdmin === false}
          <p class="mt-4 text-xs text-warning">Kotbo n’a pas la permission Administrateur ici : certaines fonctions peuvent échouer.</p>
        {/if}
      </AdminCard>
    </div>

    <MetricTabs
      metrics={overviewMetrics}
      active={overviewMetric}
      onchange={(id) => {
        if (id === 'messages' || id === 'activeMembers' || id === 'voice' || id === 'net') overviewMetric = id;
      }}
      label="Indicateurs du serveur"
    />

    <AdminCard
      title={overviewMetric === 'messages'
        ? 'Messages et membres actifs'
        : overviewMetric === 'activeMembers'
          ? 'Membres actifs par jour'
          : overviewMetric === 'voice'
            ? 'Minutes en vocal par jour'
            : 'Arrivées et départs'}
      description="Clique sur un compteur au-dessus pour changer de courbe"
    >
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
        <p class="py-10 text-center text-body-sm text-on-surface-variant">Aucune mesure sur la période.</p>
      {:else if overviewMetric === 'messages'}
        <TimeSeriesChart
          {labels}
          mode="lines"
          stacks={[
            { label: 'Messages', values: series.map((day) => day.messages), color: SERIES[0] },
            { label: 'Membres actifs', values: series.map((day) => day.activeMembers), color: SERIES[1] },
          ]}
          format={(v) => formatNumber(v)}
        />
      {:else if overviewMetric === 'net'}
        <TimeSeriesChart
          {labels}
          mode="lines"
          stacks={[
            { label: 'Arrivées', values: series.map((day) => day.joined), color: SERIES[1] },
            { label: 'Départs', values: series.map((day) => day.left), color: SERIES[3] },
          ]}
          format={(v) => formatNumber(v)}
        />
      {:else if overviewMetric === 'activeMembers'}
        <TimeSeriesChart
          {labels}
          mode={chartMode}
          main={{ label: 'Membres actifs', values: series.map((day) => day.activeMembers), color: SERIES[1] }}
          format={(v) => formatNumber(v)}
        />
      {:else}
        <TimeSeriesChart
          {labels}
          mode={chartMode}
          main={{ label: 'Minutes de vocal', values: series.map((day) => day.voiceMinutes), color: SERIES[2] }}
          format={(v) => formatVoice(v)}
        />
      {/if}
    </AdminCard>
  {:else if section === 'activity'}
    <div class="grid grid-cols-1 xl:grid-cols-2 gap-5 items-start">
      <AdminCard title="Salons" description="Les plus actifs en messages">
        <AdminBarList
          items={(sheet.channels ?? []).map((channel) => ({
            key: channel.channelId,
            label: `#${channel.name ?? 'salon supprimé'}`,
            sublabel: channel.categoryName ?? '',
            value: channel.messages,
          }))}
          formatValue={formatCompact}
        />
      </AdminCard>
      <AdminCard title="Catégories" description="Tous les salons du serveur">
        <AdminBarList
          items={(sheet.categories ?? []).map((category) => ({
            key: category.categoryId ?? '-',
            label: category.name ?? 'Sans catégorie',
            sublabel: `${category.channels} salon${category.channels > 1 ? 's' : ''}${category.voiceMinutes > 0 ? ` · ${formatVoice(category.voiceMinutes)} de vocal` : ''}`,
            value: category.messages,
          }))}
          formatValue={formatCompact}
        />
      </AdminCard>
    </div>

    <AdminCard title="Arrivées et départs">
      {#if series.length < 2}
        <p class="py-10 text-center text-body-sm text-on-surface-variant">Aucune mesure sur la période.</p>
      {:else}
        <TimeSeriesChart
          {labels}
          mode="lines"
          stacks={[
            { label: 'Arrivées', values: series.map((day) => day.joined), color: SERIES[1] },
            { label: 'Départs', values: series.map((day) => day.left), color: SERIES[3] },
          ]}
          format={(v) => formatNumber(v)}
        />
      {/if}
    </AdminCard>

    <div class="grid grid-cols-1 xl:grid-cols-2 gap-5 items-start">
      <AdminCard title="Quand écrit-on ?" description="Messages par jour de la semaine et par heure">
        {#if sheet.heat}
          <AdminHeatmap grid={sheet.heat} />
        {:else}
          <p class="text-body-sm text-on-surface-variant">Aucune mesure sur la période.</p>
        {/if}
      </AdminCard>
      <AdminCard title="De quoi sont faits les messages">
        {#if sheet.content}
          <AdminContentMix content={sheet.content} />
        {:else}
          <p class="text-body-sm text-on-surface-variant">Aucune mesure sur la période.</p>
        {/if}
      </AdminCard>
    </div>
  {:else if section === 'setup'}
    <div class="grid grid-cols-1 lg:grid-cols-5 gap-5 items-start">
      <AdminCard title="Modules activés" description="{enabledModules.length} sur {sheet.modules.length} connus pour ce serveur" class="lg:col-span-3">
        {#if enabledModules.length === 0}
          <p class="text-body-sm text-on-surface-variant">Aucun module activé : Kotbo ne fait rien sur ce serveur.</p>
        {:else}
          <ul class="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {#each enabledModules as module (module.name)}
              {@const definition = getModuleDefinition(module.name)}
              <li class="flex items-center gap-3 min-w-0">
                <span class="w-9 h-9 shrink-0 rounded-xl bg-surface-container flex items-center justify-center text-on-surface">
                  <Papicon icon={definition?.icon ?? 'Box'} size={16} />
                </span>
                <span class="min-w-0">
                  <span class="block text-sm font-semibold text-on-surface truncate">{moduleName(module.name, definition?.name ?? module.name)}</span>
                  <span class="block text-xs text-on-surface-variant truncate">
                    {module.lastUsedAt ? `utilisé ${relativeTime(module.lastUsedAt)}` : `activé ${relativeTime(module.activatedAt)}`}
                  </span>
                </span>
              </li>
            {/each}
          </ul>
        {/if}
        {#if disabledModules.length > 0}
          <p class="mt-5 pt-4 border-t border-outline-variant text-xs text-on-surface-variant leading-relaxed">
            Désactivés : {disabledModules.map((module) => moduleName(module.name, getModuleDefinition(module.name)?.name ?? module.name)).join(', ')}.
          </p>
        {/if}
      </AdminCard>

      <AdminCard title="Offre et accès" class="lg:col-span-2">
        {#snippet actions()}
          <a href="/admin/billing" class="text-body-sm font-semibold text-primary hover:underline">Abonnements</a>
        {/snippet}
        {#if !sheet.access}
          <p class="text-body-sm text-on-surface-variant">Ce serveur n’a jamais été enregistré en base.</p>
        {:else}
          <div class="flex flex-wrap gap-2 mb-4">
            <AdminBadge label={sheet.access.activated ? 'Activé' : 'Non activé'} tone={sheet.access.activated ? 'success' : 'neutral'} dot />
            <AdminBadge label="Offre {sheet.access.plan}" tone={sheet.access.plan === 'FREE' ? 'neutral' : 'primary'} />
            {#if sheet.access.stripeCancelAtPeriodEnd}<AdminBadge label="Résiliation programmée" tone="warning" />{/if}
          </div>
          <dl class="space-y-2.5">
            {#each [
              { label: 'Type d’accès', value: ACCESS_LABEL[sheet.access.accessType] ?? sheet.access.accessType },
              { label: 'Expire le', value: sheet.access.accessExpiresAt ? formatDate(sheet.access.accessExpiresAt) : 'jamais' },
              { label: 'Activé le', value: formatDate(sheet.access.activatedAt) },
              { label: 'Code utilisé', value: sheet.access.activationCode ?? 'aucun' },
              { label: 'Abonnement Stripe', value: sheet.access.stripeSubscriptionStatus ?? 'aucun' },
              { label: 'Prochaine échéance', value: formatDate(sheet.access.stripeCurrentPeriodEnd) },
              { label: 'Configuration terminée', value: sheet.access.onboardingCompletedAt ? formatDate(sheet.access.onboardingCompletedAt) : 'non' },
            ] as entry (entry.label)}
              <div class="flex items-baseline justify-between gap-3">
                <dt class="text-body-sm text-on-surface-variant">{entry.label}</dt>
                <dd class="text-body-sm font-semibold text-on-surface text-right truncate">{entry.value}</dd>
              </div>
            {/each}
          </dl>
        {/if}
      </AdminCard>
    </div>
  {:else if section === 'moderation'}
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start">
      <AdminCard title="Sanctions" description="{formatNumber(sheet.totals.sanctions)} sur la période">
        <dl class="space-y-2.5">
          {#each sanctionRows as row (row.label)}
            <div class="flex items-baseline justify-between gap-3">
              <dt class="text-body-sm text-on-surface-variant">{row.label}</dt>
              <dd class="text-body-sm font-semibold text-on-surface tabular-nums">{formatNumber(row.value)}</dd>
            </div>
          {/each}
        </dl>
      </AdminCard>

      <AdminCard title="AegisAI">
        {#snippet actions()}
          <AdminBadge label={sheet?.aegis.enabled ? 'Activé' : 'Désactivé'} tone={sheet?.aegis.enabled ? 'success' : 'neutral'} dot />
        {/snippet}
        <dl class="space-y-2.5">
          <div class="flex items-baseline justify-between gap-3">
            <dt class="text-body-sm text-on-surface-variant">Messages analysés</dt>
            <dd class="text-body-sm font-semibold text-on-surface tabular-nums">{formatCompact(sheet.aegis.analyzed)}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-3">
            <dt class="text-body-sm text-on-surface-variant">Jugés toxiques</dt>
            <dd class="text-body-sm font-semibold text-on-surface tabular-nums">{formatNumber(sheet.aegis.toxic)} · {formatPercent(sheet.aegis.toxic, sheet.aegis.analyzed, 1)}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-3">
            <dt class="text-body-sm text-on-surface-variant">Traités d’office</dt>
            <dd class="text-body-sm font-semibold text-on-surface tabular-nums">{formatNumber(sheet.aegis.severe)}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-3">
            <dt class="text-body-sm text-on-surface-variant">Seuils revue · action</dt>
            <dd class="text-body-sm font-semibold text-on-surface tabular-nums">{sheet.aegis.reviewThreshold ?? '–'} · {sheet.aegis.autoThreshold ?? '–'}</dd>
          </div>
          {#each Object.entries(sheet.aegis?.detections ?? {}) as [kind, count] (kind)}
            <div class="flex items-baseline justify-between gap-3">
              <dt class="text-body-sm text-on-surface-variant">{AEGIS_KIND[kind] ?? kind}</dt>
              <dd class="text-body-sm font-semibold text-on-surface tabular-nums">{formatNumber(count)}</dd>
            </div>
          {/each}
        </dl>
      </AdminCard>

      <AdminCard title="Kotbo Vision">
        <dl class="space-y-2.5">
          {#each [
            { label: 'Listes d’images', value: sheet.vision?.lists ?? 0 },
            { label: 'Images interdites propres au serveur', value: sheet.vision?.images ?? 0 },
            { label: 'Revues en attente', value: sheet.vision?.reviews?.PENDING ?? 0 },
            { label: 'Revues confirmées', value: sheet.vision?.reviews?.CONFIRMED ?? 0 },
            { label: 'Revues écartées', value: sheet.vision?.reviews?.DISMISSED ?? 0 },
          ] as row (row.label)}
            <div class="flex items-baseline justify-between gap-3">
              <dt class="text-body-sm text-on-surface-variant">{row.label}</dt>
              <dd class="text-body-sm font-semibold text-on-surface tabular-nums">{formatNumber(row.value)}</dd>
            </div>
          {/each}
        </dl>
      </AdminCard>
    </div>
  {:else}
    <AdminCard title="Ce que l’équipe Kotbo a fait sur ce serveur" description="Les quinze dernières actions admin qui le visent">
      {#snippet actions()}
        <a href="/admin/audit" class="text-body-sm font-semibold text-primary hover:underline">Journal complet</a>
      {/snippet}
      {#if (sheet.audit ?? []).length === 0}
        <p class="text-body-sm text-on-surface-variant">Aucune action admin n’a visé ce serveur.</p>
      {:else}
        <ul class="space-y-3.5">
          {#each sheet.audit ?? [] as entry (entry.id)}
            <li class="flex items-start gap-3">
              <span class="w-2 h-2 rounded-full mt-1.5 shrink-0 {entry.outcome === 'OK' ? 'bg-success' : 'bg-error'}"></span>
              <div class="min-w-0">
                <p class="text-sm text-on-surface leading-snug">{entry.summary}</p>
                <p class="text-xs text-on-surface-variant mt-0.5">
                  {entry.actorName ?? entry.actorId} · <span class="font-mono">{entry.action}</span> · {relativeTime(entry.createdAt)}
                </p>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </AdminCard>
  {/if}
</AdminShell>
