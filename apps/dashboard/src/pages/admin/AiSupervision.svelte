<script lang="ts">
  /**
   * Supervision des modules d'analyse : AegisAI (toxicite, emotions) et Kotbo
   * Vision (images, domaines et textes d'arnaque). On y lit si la file tient
   * la charge, ce qui est detecte, et ce qui attend une decision humaine.
   */
  import { onMount, onDestroy } from 'svelte';
  import { errorMessage } from '@kotbo/shared';
  import { fetchAiSupervision, fetchAdminVisionImages, type AiSupervision, type AdminVisionImage } from '../../lib/api/adminInsights';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import AdminCard from '../../lib/components/admin/AdminCard.svelte';
  import AdminBadge from '../../lib/components/admin/AdminBadge.svelte';
  import AdminBarList from '../../lib/components/admin/AdminBarList.svelte';
  import MetricTabs, { type MetricTab } from '../../lib/components/analytics/MetricTabs.svelte';
  import TimeSeriesChart from '../../lib/components/analytics/TimeSeriesChart.svelte';
  import { SERIES, shortDate } from '../../lib/components/analytics/analyticsFormat';
  import type { AdminTone } from '../../lib/components/admin/types';
  import { formatCompact, formatNumber, formatPercent, relativeTime } from '../../lib/components/admin/format';
  import { Button, Callout, FilterPills } from '../../lib/components/ui';

  let data = $state<AiSupervision | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let days = $state('30');
  let chartMode = $state<'line' | 'bar'>('line');
  let timer: ReturnType<typeof setInterval> | null = null;

  // ── Galerie d'images Kotbo Vision ──────────────────────────────────────────
  let visionImages = $state<AdminVisionImage[]>([]);
  let visionImagesLoading = $state(false);
  let visionThumbsOnly = $state(true);
  let visionSourceFilter = $state('ALL');
  let selectedModalImage = $state<AdminVisionImage | null>(null);

  async function loadVisionImages() {
    visionImagesLoading = true;
    try {
      const res = await fetchAdminVisionImages({
        thumbsOnly: visionThumbsOnly,
        source: visionSourceFilter,
        limit: 150,
      });
      visionImages = res.images;
    } catch {
      visionImages = [];
    } finally {
      visionImagesLoading = false;
    }
  }

  async function load() {
    try {
      data = await fetchAiSupervision(Number(days));
      error = null;
    } catch (err) {
      error = errorMessage(err);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
    void loadVisionImages();
    // La file bouge vite : on la relit sans que l'admin ait a recharger.
    timer = setInterval(load, 30_000);
  });
  onDestroy(() => timer && clearInterval(timer));

  function changeDays(value: string) {
    days = value;
    loading = true;
    void load();
  }

  const aegis = $derived(data?.aegis);
  const vision = $derived(data?.vision);
  const first = $derived(loading && !data);

  /** La file tient-elle la charge ? */
  const queueState = $derived.by<{ tone: AdminTone; label: string; detail: string }>(() => {
    if (!aegis) return { tone: 'neutral', label: 'Vérification…', detail: '' };
    const queue = aegis.queue;
    if (queue.backend === 'stopped') return { tone: aegis.enabledGuilds > 0 ? 'danger' : 'neutral', label: 'File arrêtée', detail: 'Aucun message n’est analysé tant que la file n’est pas relancée.' };
    if (queue.dropped > 0) return { tone: 'danger', label: 'Messages abandonnés', detail: `${formatNumber(queue.dropped)} message(s) écartés faute de place depuis le démarrage.` };
    if (queue.depth > queue.concurrency * 20) return { tone: 'warning', label: 'File en retard', detail: `${formatNumber(queue.depth)} messages attendent leur analyse.` };
    if (queue.failed > queue.processed * 0.05 && queue.failed > 5) return { tone: 'warning', label: 'Échecs fréquents', detail: `${formatPercent(queue.failed, queue.processed + queue.failed, 1)} des analyses échouent.` };
    return { tone: 'success', label: 'File à jour', detail: 'Les messages sont analysés au fil de l’eau.' };
  });

  const aegisSeries = $derived(aegis?.series ?? []);
  const aegisLabels = $derived(aegisSeries.map((day) => shortDate(day.dateKey)));

  /** Part des revues que le staff a confirmees : mesure la justesse des detections. */
  const precision = $derived.by(() => {
    const confirmed = aegis?.status?.CONFIRMED ?? 0;
    const dismissed = aegis?.status?.DISMISSED ?? 0;
    return confirmed + dismissed > 0 ? formatPercent(confirmed, confirmed + dismissed) : '–';
  });

  const aegisMetrics = $derived<MetricTab[]>([
    {
      id: 'analyzed',
      label: 'Messages analysés',
      value: aegis ? formatCompact(aegis.analyzed) : '–',
      spark: aegisSeries.map((day) => day.analyzed),
      color: SERIES[0],
      hint: aegis ? `sur ${aegis.enabledGuilds} serveur${aegis.enabledGuilds > 1 ? 's' : ''}` : undefined,
    },
    {
      id: 'toxic',
      label: 'Taux de toxicité',
      value: aegis ? formatPercent(aegis.toxic, aegis.analyzed, 2) : '–',
      spark: aegisSeries.map((day) => day.toxic),
      color: SERIES[3],
      invert: true,
      hint: aegis ? `${formatNumber(aegis.toxic)} messages · ${formatNumber(aegis.severe)} traités d’office` : undefined,
    },
    {
      id: 'pending',
      label: 'Revues en attente',
      value: aegis ? formatNumber(aegis.pendingReviews) : '–',
      color: SERIES[2],
      hint: 'tous serveurs, à trancher par leur staff',
    },
    {
      id: 'precision',
      label: 'Détections confirmées',
      value: precision,
      color: SERIES[1],
      hint: aegis ? `${formatNumber(aegis.late)} analysées trop tard pour agir` : undefined,
    },
  ]);

  const visionMetrics = $derived<MetricTab[]>([
    {
      id: 'images',
      label: 'Images connues',
      value: vision ? formatCompact(vision.images) : '–',
      color: SERIES[0],
      hint: vision ? `${formatCompact(vision.globalImages)} partagées · +${formatNumber(vision.newImages)} sur la période` : undefined,
    },
    {
      id: 'domains',
      label: 'Domaines d’arnaque',
      value: vision ? formatCompact(vision.domains) : '–',
      color: SERIES[3],
      hint: vision ? `${formatCompact(vision.globalDomains)} bloqués partout` : undefined,
    },
    {
      id: 'texts',
      label: 'Textes d’arnaque',
      value: vision ? formatCompact(vision.textSamples) : '–',
      color: SERIES[1],
      hint: 'empreintes de copier-coller',
    },
    {
      id: 'visionPending',
      label: 'Revues en attente',
      value: vision ? formatNumber(vision.reviews?.PENDING ?? 0) : '–',
      color: SERIES[2],
      hint: vision ? `${vision.enabledLists} liste${vision.enabledLists > 1 ? 's' : ''} sur ${vision.guildsWithLists} serveur${vision.guildsWithLists > 1 ? 's' : ''}` : undefined,
    },
  ]);

  const EMOTIONS = [
    { key: 'joy', label: 'Joie' },
    { key: 'neutral', label: 'Neutre' },
    { key: 'surprise', label: 'Surprise' },
    { key: 'sad', label: 'Tristesse' },
    { key: 'anger', label: 'Colère' },
    { key: 'fear', label: 'Peur' },
  ] as const;

  const KIND: Record<string, string> = { TOXIC: 'Toxicité', HARASSMENT: 'Harcèlement', CONFLICT: 'Conflit', DISTRESS: 'Détresse' };
  const ACTION: Record<string, string> = {
    NONE: 'Aucune action',
    REVIEW: 'Envoyé en revue',
    DELETE: 'Message supprimé',
    WARN: 'Avertissement',
    TIMEOUT: 'Exclusion temporaire',
    SLOWMODE: 'Mode lent',
    NICKNAME_RESET: 'Pseudo réinitialisé',
    ALERT: 'Alerte au staff',
  };
  const SOURCE: Record<string, string> = {
    HONEYPOT: 'Salon piège',
    MANUAL: 'Ajout manuel',
    OCR: 'Texte lu dans l’image',
    VARIANT: 'Variante détectée',
    REVIEW: 'Revue confirmée',
    DISMISSED: 'Revue écartée',
    SEED: 'Catalogue d’amorce',
    PROMOTED: 'Promu au global',
  };

  const toItems = (record: Record<string, number> | undefined, labels: Record<string, string>) =>
    Object.entries(record ?? {})
      .map(([key, value]) => ({ key, label: labels[key] ?? key, value }))
      .sort((a, b) => b.value - a.value);
</script>

<AdminShell title="AegisAI et Vision" description="Les deux modules qui analysent ce qui est publié : est-ce qu’ils tiennent la charge, que détectent-ils, qu’attend une décision.">
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

  <!-- ── AegisAI ─────────────────────────────────────────────────────────── -->
  <h2 class="font-headline text-2xl font-bold tracking-tight pt-2">AegisAI</h2>

  <AdminCard>
    <div class="flex flex-wrap items-center justify-between gap-4">
      <div class="min-w-0">
        <div class="flex items-center gap-2.5">
          <AdminBadge label={queueState.label} tone={queueState.tone} dot pulse={queueState.tone === 'warning' || queueState.tone === 'danger'} />
          {#if aegis}<span class="text-xs text-on-surface-variant">file {aegis.queue.backend === 'redis' ? 'Redis' : aegis.queue.backend === 'memory' ? 'en mémoire' : 'arrêtée'}</span>{/if}
        </div>
        <p class="text-sm text-on-surface mt-2">{queueState.detail}</p>
      </div>
      {#if aegis}
        <dl class="flex flex-wrap gap-x-8 gap-y-2">
          {#each [
            { label: 'En attente', value: aegis.queue.depth },
            { label: 'En cours', value: `${aegis.queue.active}/${aegis.queue.concurrency}` },
            { label: 'Traités', value: formatCompact(aegis.queue.processed) },
            { label: 'Échecs', value: formatNumber(aegis.queue.failed) },
            { label: 'Abandonnés', value: formatNumber(aegis.queue.dropped) },
          ] as entry (entry.label)}
            <div>
              <dt class="text-xs text-on-surface-variant">{entry.label}</dt>
              <dd class="font-headline text-xl font-bold tabular-nums">{entry.value}</dd>
            </div>
          {/each}
        </dl>
      {/if}
    </div>
  </AdminCard>

  {#if first}
    <div class="h-28 admin-surface animate-pulse"></div>
  {:else}
    <MetricTabs metrics={aegisMetrics} active="" onchange={() => {}} interactive={false} label="Indicateurs AegisAI" />
  {/if}

  <div class="grid grid-cols-1 xl:grid-cols-3 gap-5 items-start">
    <AdminCard title="Analyses par jour" class="xl:col-span-2">
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
      {#if aegisSeries.length < 2}
        <p class="py-10 text-center text-body-sm text-on-surface-variant">Aucune analyse sur la période.</p>
      {:else if chartMode === 'line'}
        <TimeSeriesChart
          labels={aegisLabels}
          mode="lines"
          stacks={[
            { label: 'Analysés', values: aegisSeries.map((day) => day.analyzed), color: SERIES[0] },
            { label: 'Toxiques', values: aegisSeries.map((day) => day.toxic), color: SERIES[3] },
          ]}
          format={(v) => formatNumber(v)}
        />
      {:else}
        <TimeSeriesChart
          labels={aegisLabels}
          mode="bar"
          main={{ label: 'Analysés', values: aegisSeries.map((day) => day.analyzed), color: SERIES[0] }}
          format={(v) => formatNumber(v)}
        />
      {/if}
    </AdminCard>

    <AdminCard title="Climat" description={aegis ? `${formatCompact(aegis.emotions.analyzed)} messages classés par émotion` : ''}>
      {#if aegis && aegis.emotions.analyzed > 0}
        <div class="space-y-2.5">
          {#each EMOTIONS as emotion (emotion.key)}
            <div class="flex items-center gap-3">
              <span class="w-20 shrink-0 text-body-sm text-on-surface">{emotion.label}</span>
              <span class="flex-1 h-2 rounded-full bg-surface-container overflow-hidden">
                <span class="block h-full rounded-full bg-primary" style="width: {(aegis.emotions[emotion.key] / aegis.emotions.analyzed) * 100}%"></span>
              </span>
              <span class="w-12 text-right text-xs font-semibold tabular-nums">{formatPercent(aegis.emotions[emotion.key], aegis.emotions.analyzed)}</span>
            </div>
          {/each}
        </div>
      {:else}
        <p class="text-body-sm text-on-surface-variant">Aucune émotion mesurée sur la période.</p>
      {/if}
    </AdminCard>
  </div>

  <div class="grid grid-cols-1 xl:grid-cols-3 gap-5 items-start">
    <AdminCard title="Ce qui est détecté">
      <AdminBarList items={toItems(aegis?.kinds, KIND)} emptyLabel="Aucune détection sur la période." />
    </AdminCard>
    <AdminCard title="Ce que le bot en fait">
      <AdminBarList items={toItems(aegis?.actions, ACTION)} emptyLabel="Aucune action sur la période." />
    </AdminCard>
    <AdminCard title="Serveurs les plus analysés">
      <AdminBarList
        items={(aegis?.guilds ?? []).map((guild) => ({
          key: guild.guildId,
          label: guild.name ?? guild.guildId,
          sublabel: `${formatPercent(guild.toxic, guild.analyzed, 1)} toxiques`,
          value: guild.analyzed,
          href: `/admin/servers/${guild.guildId}`,
        }))}
        formatValue={formatCompact}
        emptyLabel="Aucun serveur n’a AegisAI activé."
      />
    </AdminCard>
  </div>

  <!-- ── Kotbo Vision ────────────────────────────────────────────────────── -->
  <h2 class="font-headline text-2xl font-bold tracking-tight pt-4">Kotbo Vision</h2>

  {#if first}
    <div class="h-28 admin-surface animate-pulse"></div>
  {:else}
    <MetricTabs metrics={visionMetrics} active="" onchange={() => {}} interactive={false} label="Indicateurs Kotbo Vision" />
  {/if}

  <div class="grid grid-cols-1 xl:grid-cols-2 gap-5 items-start">
    <AdminCard title="D’où viennent les images" description="Origine de chaque image du catalogue">
      <AdminBarList items={toItems(vision?.imageSources, SOURCE)} formatValue={formatCompact} emptyLabel="Le catalogue est vide." />
    </AdminCard>

    <AdminCard title="Domaines les plus vus" padded={false}>
      {#if !vision || (vision.topDomains ?? []).length === 0}
        <p class="px-6 pb-6 pt-4 text-body-sm text-on-surface-variant">Aucun domaine relevé pour l’instant.</p>
      {:else}
        <ul class="divide-y divide-outline-variant">
          {#each vision.topDomains ?? [] as domain (domain.domain)}
            <li class="flex items-center gap-3 px-6 py-3">
              <div class="min-w-0 flex-1">
                <p class="text-sm font-semibold font-mono text-on-surface truncate">{domain.domain}</p>
                <p class="text-xs text-on-surface-variant">{SOURCE[domain.source] ?? domain.source} · vu {relativeTime(domain.lastSeenAt)}</p>
              </div>
              {#if domain.global}<AdminBadge size="sm" label="Global" tone="primary" />{/if}
              <span class="text-sm font-semibold tabular-nums">{formatCompact(domain.hits)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </AdminCard>
  </div>

  <!-- ── Galerie d'images Kotbo Vision ──────────────────────────────────────── -->
  <AdminCard
    title="Catalogue d'images et empreintes Kotbo Vision"
    description="Inspection visuelle des images interceptées (honeypot, clics droits, QR codes, revues) et empreintes globales"
  >
    {#snippet actions()}
      <div class="flex items-center gap-3 flex-wrap">
        <label class="inline-flex items-center gap-2 text-xs text-on-surface cursor-pointer select-none">
          <input
            type="checkbox"
            checked={visionThumbsOnly}
            onchange={(e) => {
              visionThumbsOnly = e.currentTarget.checked;
              void loadVisionImages();
            }}
            class="rounded border-outline-variant/40 bg-surface-container text-primary focus:ring-0"
          />
          <span>Avec aperçu uniquement</span>
        </label>
        <select
          value={visionSourceFilter}
          onchange={(e) => {
            visionSourceFilter = e.currentTarget.value;
            void loadVisionImages();
          }}
          class="h-8 px-2.5 rounded-lg bg-surface-container border border-outline-variant/30 text-xs text-on-surface focus:outline-none"
        >
          <option value="ALL">Toutes les sources</option>
          <option value="HONEYPOT">Salon piège (Honeypot)</option>
          <option value="QR">Codes QR</option>
          <option value="REVIEW">Revues confirmées</option>
          <option value="MANUAL">Ajout manuel</option>
          <option value="SEED">Amorce (Seed)</option>
        </select>
        <Button size="sm" variant="secondary" icon="RefreshCw" onclick={loadVisionImages} disabled={visionImagesLoading}>
          Actualiser
        </Button>
      </div>
    {/snippet}

    {#if visionImagesLoading && visionImages.length === 0}
      <div class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 py-4">
        {#each Array(6) as _}
          <div class="h-36 rounded-xl admin-surface animate-pulse"></div>
        {/each}
      </div>
    {:else if visionImages.length === 0}
      <div class="py-12 text-center text-on-surface-variant text-sm">
        Aucune image trouvée avec ces filtres.
      </div>
    {:else}
      <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 pt-2">
        {#each visionImages as img (img.id)}
          <button
            type="button"
            onclick={() => { selectedModalImage = img; }}
            class="group rounded-xl border border-outline-variant/30 bg-surface-container-low/40 hover:border-primary/40 text-left overflow-hidden transition flex flex-col focus:outline-none"
          >
            {#if img.thumb}
              <div class="w-full h-28 bg-surface-container flex items-center justify-center overflow-hidden">
                <img
                  src={img.thumb}
                  alt={img.filename ?? 'Arnaque'}
                  class="w-full h-full object-contain group-hover:scale-105 transition duration-200"
                  loading="lazy"
                />
              </div>
            {:else}
              <div class="w-full h-28 bg-surface-container flex flex-col items-center justify-center text-xs text-on-surface-variant gap-1">
                <span class="font-mono text-2xs opacity-70">Sans aperçu</span>
                <span class="text-3xs text-on-surface-variant/70">(Empreinte)</span>
              </div>
            {/if}

            <div class="p-2.5 space-y-1 min-w-0 flex-1 flex flex-col justify-between w-full">
              <div>
                <p class="text-xs font-semibold text-on-surface truncate" title={img.filename ?? 'image'}>
                  {img.filename ?? 'image sans nom'}
                </p>
                <p class="text-2xs text-on-surface-variant flex items-center justify-between gap-1 mt-0.5">
                  <span class="truncate">{SOURCE[img.source] ?? img.source}</span>
                  <span class="font-mono tabular-nums">{img.hits} bloc.</span>
                </p>
              </div>
              <div class="pt-1 border-t border-outline-variant/15 flex items-center justify-between gap-1 text-3xs text-on-surface-variant">
                <span class="truncate">{img.guildName ?? 'Global'}</span>
                {#if img.status === 'ALLOWED'}
                  <AdminBadge size="sm" label="Autorisée" tone="success" />
                {/if}
              </div>
            </div>
          </button>
        {/each}
      </div>
    {/if}
  </AdminCard>

  <!-- Modale d'agrandissement d'une image -->
  {#if selectedModalImage}
    <div
      class="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onclick={() => { selectedModalImage = null; }}
      onkeydown={(e) => { if (e.key === 'Escape') selectedModalImage = null; }}
      role="button"
      tabindex="0"
    >
      <div
        class="bg-surface-container-high rounded-2xl border border-outline-variant/40 p-5 max-w-xl w-full space-y-4 shadow-2xl"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.stopPropagation()}
        role="dialog"
        tabindex="-1"
      >
        <div class="flex items-center justify-between border-b border-outline-variant/20 pb-3">
          <div class="min-w-0 pr-3">
            <h3 class="text-sm font-semibold text-on-surface truncate">
              {selectedModalImage.filename ?? 'Image d’arnaque'}
            </h3>
            <p class="text-xs text-on-surface-variant">
              {SOURCE[selectedModalImage.source] ?? selectedModalImage.source} · {selectedModalImage.guildName ?? 'Global'}
            </p>
          </div>
          <button
            type="button"
            onclick={() => { selectedModalImage = null; }}
            class="w-8 h-8 rounded-lg bg-on-surface/8 hover:bg-on-surface/12 text-on-surface-variant flex items-center justify-center text-sm font-bold transition"
          >
            ✕
          </button>
        </div>

        {#if selectedModalImage.thumb}
          <div class="max-h-[60vh] flex items-center justify-center bg-black/40 rounded-xl overflow-hidden p-2">
            <img
              src={selectedModalImage.thumb}
              alt={selectedModalImage.filename ?? 'Vignette'}
              class="max-h-[55vh] w-auto object-contain rounded-lg shadow-md"
            />
          </div>
        {:else}
          <div class="h-40 flex items-center justify-center bg-surface-container rounded-xl text-xs text-on-surface-variant font-mono">
            Aucun aperçu disponible pour cette empreinte
          </div>
        {/if}

        <div class="grid grid-cols-2 gap-2 text-xs pt-1">
          <div class="p-2.5 rounded-lg bg-surface-container">
            <span class="text-on-surface-variant block text-2xs">Blocages enregistrés</span>
            <span class="font-bold text-on-surface text-sm tabular-nums">{selectedModalImage.hits}</span>
          </div>
          <div class="p-2.5 rounded-lg bg-surface-container">
            <span class="text-on-surface-variant block text-2xs">Statut</span>
            <span class="font-bold text-on-surface text-sm">
              {selectedModalImage.status === 'BLOCKED' ? 'Bloquée (BLOCKED)' : 'Autorisée (ALLOWED)'}
            </span>
          </div>
        </div>
      </div>
    </div>
  {/if}
</AdminShell>
