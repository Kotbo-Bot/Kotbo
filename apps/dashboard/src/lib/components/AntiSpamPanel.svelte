<script lang="ts">
  import { onMount } from 'svelte';
  import { authStore } from '../stores/auth.svelte';
  import { dashboardStore } from '../stores/dashboard.svelte';
  import {
    fetchSpamDetection,
    updateSpamDetection,
    fetchSpamSamples,
    decideSpamSample,
  } from '../api';
  import { toast } from '../stores/toast.svelte';
  import SectionCard from './SectionCard.svelte';
  import ToggleSwitch from './ToggleSwitch.svelte';
  import RefreshButton from './RefreshButton.svelte';
  import Papicon from './Papicon.svelte';
  import EmptyState from './EmptyState.svelte';
  import LoadingHint from './LoadingHint.svelte';

  type SpamConfig = {
    guildId: string;
    enabled: boolean;
    shadowMode: boolean;
    logThreshold: number;
    deleteThreshold: number;
    timeoutThreshold: number;
    banThreshold: number;
    timeoutMinutes: number;
    alertChannelId: string | null;
    bypassRoleIds: string[];
    bypassChannelIds: string[];
    typingSignalEnabled: boolean;
    crossChannelEnabled: boolean;
    duplicateEnabled: boolean;
    cadenceEnabled: boolean;
    contentEnabled: boolean;
    trustEnabled: boolean;
    windowSeconds: number;
    crossChannelThreshold: number;
    duplicateSimilarity: number;
  };

  type Stats = {
    total: number;
    shadow: number;
    pendingDecision: number;
    labeledTrue: number;
    labeledFalse: number;
    histogram: { from: number; to: number; count: number }[];
    signals: { type: string; count: number; weight: number }[];
    labelsNeeded: number;
  };

  type Sample = {
    id: string;
    userId: string;
    channelId: string;
    score: number;
    action: string;
    shadow: boolean;
    contentPreview: string | null;
    label: string | null;
    createdAt: string;
    features: { signals?: Record<string, number>; distinctFamilies?: number; trustMultiplier?: number };
  };

  const DEFAULTS: SpamConfig = {
    guildId: '',
    enabled: false,
    shadowMode: true,
    logThreshold: 30,
    deleteThreshold: 55,
    timeoutThreshold: 75,
    banThreshold: 95,
    timeoutMinutes: 60,
    alertChannelId: null,
    bypassRoleIds: [],
    bypassChannelIds: [],
    typingSignalEnabled: true,
    crossChannelEnabled: true,
    duplicateEnabled: true,
    cadenceEnabled: true,
    contentEnabled: true,
    trustEnabled: true,
    windowSeconds: 30,
    crossChannelThreshold: 3,
    duplicateSimilarity: 0.85,
  };

  const SIGNAL_LABELS: Record<string, string> = {
    no_typing: 'Posté sans indicateur de frappe',
    inhuman_rate: 'Débit inhumain',
    regular_intervals: 'Intervalles réguliers',
    cross_channel_burst: 'Diffusion multi-salons',
    attachment_flood: 'Rafale de pièces jointes',
    near_duplicate: 'Quasi-doublons',
    repeat_identical: 'Répétition identique',
    mention_burst: 'Mentions en masse',
    everyone_attempt: 'Tentative de @everyone',
    unicode_obfuscation: 'Obfuscation unicode',
    invite_link: 'Invitation Discord',
    first_message_link: 'Lien dans les premiers messages',
    link_from_newcomer: 'Lien d\'une arrivée récente',
  };

  const SIGNAL_TOGGLES: { field: keyof SpamConfig; label: string; help: string }[] = [
    {
      field: 'typingSignalEnabled',
      label: 'Absence d\'indicateur de frappe',
      help: 'Un client Discord réel émet un événement de frappe avant un message conséquent. Les scripts et les comptes pilotés par token volé ne le font pratiquement jamais. Le signal se neutralise automatiquement si le bot ne reçoit pas ces événements.',
    },
    {
      field: 'crossChannelEnabled',
      label: 'Diffusion multi-salons',
      help: 'Même message dans plusieurs salons en quelques secondes : la signature du compte compromis qui parcourt la liste des salons accessibles.',
    },
    {
      field: 'duplicateEnabled',
      label: 'Répétitions et quasi-doublons',
      help: 'Comparaison après normalisation unicode : les variantes destinées à casser la comparaison exacte (homoglyphes, caractères invisibles, ponctuation) sont ramenées au même texte.',
    },
    {
      field: 'cadenceEnabled',
      label: 'Cadence de publication',
      help: 'Débit incompatible avec une saisie humaine, et intervalles trop réguliers - un humain a une cadence irrégulière, une boucle programmée non.',
    },
    {
      field: 'contentEnabled',
      label: 'Analyse du contenu',
      help: 'Mentions en masse, tentative de @everyone sans permission, obfuscation unicode, invitations Discord.',
    },
    {
      field: 'trustEnabled',
      label: 'Atténuation par la confiance',
      help: 'Ancienneté, activité et rôles réduisent le score - mais uniquement sur le contenu, jamais sur les signaux d\'automatisation : un compte de confiance qui poste sans frappe et en rafale reste détecté.',
    },
  ];

  let config = $state<SpamConfig>({ ...DEFAULTS });
  let original = $state<SpamConfig>({ ...DEFAULTS });
  let stats = $state<Stats | null>(null);
  let samples = $state<Sample[]>([]);
  let loading = $state(true);
  let saving = $state(false);
  let decidingId = $state<string | null>(null);
  let pendingOnly = $state(true);
  let error = $state('');

  const dirty = $derived(JSON.stringify(config) !== JSON.stringify(original));

  const channels = $derived((dashboardStore.state.discordChannels ?? []) as { id: string; name: string }[]);
  const roles = $derived((dashboardStore.state.discordRoles ?? []) as { id: string; name: string }[]);

  /** Répartition des scores observés, pour choisir des seuils sur des données réelles. */
  const histogramMax = $derived(Math.max(1, ...(stats?.histogram ?? []).map((b) => b.count)));

  /** Ce que les seuils actuels auraient produit sur la période observée. */
  const projection = $derived.by(() => {
    if (!stats) return null;
    const count = (min: number, max: number) =>
      stats.histogram.filter((b) => b.from >= min && b.from < max).reduce((s, b) => s + b.count, 0);
    return {
      logged: count(config.logThreshold, config.deleteThreshold),
      deleted: count(config.deleteThreshold, config.timeoutThreshold),
      timedOut: count(config.timeoutThreshold, config.banThreshold),
      banned: count(config.banThreshold, 101),
    };
  });

  function bandColor(from: number): string {
    if (from >= config.banThreshold) return 'bg-error';
    if (from >= config.timeoutThreshold) return 'bg-orange-500';
    if (from >= config.deleteThreshold) return 'bg-amber-500';
    if (from >= config.logThreshold) return 'bg-sky-500';
    return 'bg-outline-variant';
  }

  function formatRelative(value: string): string {
    const diff = Date.now() - new Date(value).getTime();
    const minutes = Math.max(1, Math.floor(diff / 60000));
    if (minutes < 60) return `il y a ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `il y a ${hours} h`;
    return `il y a ${Math.floor(hours / 24)} j`;
  }

  async function load() {
    if (!authStore.selectedGuildId) return;
    loading = true;
    error = '';
    try {
      const [res, sampleRes] = await Promise.all([
        fetchSpamDetection(14, authStore.selectedGuildId),
        fetchSpamSamples({ pendingOnly }, authStore.selectedGuildId),
      ]);
      const loaded = { ...DEFAULTS, ...(res?.config ?? {}) } as SpamConfig;
      config = loaded;
      original = { ...loaded };
      stats = res?.stats ?? null;
      samples = sampleRes?.samples ?? [];
    } catch (err) {
      error = err instanceof Error ? err.message : 'Impossible de charger la configuration';
    } finally {
      loading = false;
    }
  }

  async function loadSamples() {
    if (!authStore.selectedGuildId) return;
    try {
      const res = await fetchSpamSamples({ pendingOnly }, authStore.selectedGuildId);
      samples = res?.samples ?? [];
    } catch {
      toast.error('Impossible de charger les détections');
    }
  }

  async function save() {
    if (!dirty || saving) return;
    saving = true;
    try {
      const res = await updateSpamDetection({ ...config }, authStore.selectedGuildId);
      const saved = { ...DEFAULTS, ...(res?.config ?? {}) } as SpamConfig;
      config = saved;
      original = { ...saved };
      toast.success('Configuration enregistrée');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Enregistrement impossible');
    } finally {
      saving = false;
    }
  }

  function reset() {
    config = { ...original };
  }

  async function decide(sample: Sample, truePositive: boolean) {
    if (decidingId) return;
    decidingId = sample.id;
    try {
      await decideSpamSample(sample.id, truePositive, authStore.selectedGuildId);
      samples = samples.filter((s) => s.id !== sample.id);
      toast.success(truePositive ? 'Marqué comme vrai positif' : 'Marqué comme faux positif');
      // Les poids sont recalibrés côté serveur : on rafraîchit les statistiques.
      const res = await fetchSpamDetection(14, authStore.selectedGuildId);
      stats = res?.stats ?? stats;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Décision impossible');
    } finally {
      decidingId = null;
    }
  }

  function toggleBypassRole(roleId: string) {
    config.bypassRoleIds = config.bypassRoleIds.includes(roleId)
      ? config.bypassRoleIds.filter((id) => id !== roleId)
      : [...config.bypassRoleIds, roleId];
  }

  function toggleBypassChannel(channelId: string) {
    config.bypassChannelIds = config.bypassChannelIds.includes(channelId)
      ? config.bypassChannelIds.filter((id) => id !== channelId)
      : [...config.bypassChannelIds, channelId];
  }

  onMount(load);

  $effect(() => {
    const guildId = authStore.selectedGuildId;
    if (guildId) void load();
  });
</script>

<div class="space-y-8 animate-in fade-in duration-300">
  <header class="flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0">
      <h2 class="text-[15px] font-semibold text-on-surface flex items-center gap-2">
        <Papicon icon="ShieldAlert" size={16} />
        Anti-spam comportemental
      </h2>
      <p class="text-xs text-on-surface-variant mt-0.5 leading-relaxed max-w-2xl">
        Moteur de score multi-signaux, distinct des filtres à seuil ci-dessus : il combine des indices
        d'automatisation, de diffusion et de répétition plutôt que de compter les messages.
      </p>
    </div>
    <RefreshButton onclick={load} loading={loading} />
  </header>

  {#if loading}
    <LoadingHint context="config" />
  {:else if error}
    <EmptyState icon="AlertTriangle" title="Configuration indisponible" description={error} />
  {:else}
    <!-- ── Activation ─────────────────────────────────────────────────── -->
    <SectionCard
      title="Activation"
      description="Le moteur démarre en observation : il calcule et journalise sans jamais sanctionner."
      icon="Power"
    >
      <div class="space-y-4">
        <div class="flex items-center justify-between gap-4">
          <div class="min-w-0">
            <p class="text-sm font-medium text-on-surface">Moteur anti-spam</p>
            <p class="text-xs text-on-surface-variant mt-0.5">
              Évalue chaque message et applique une action selon le score obtenu.
            </p>
          </div>
          <ToggleSwitch checked={config.enabled} onToggle={(v) => (config.enabled = v)} />
        </div>

        <div
          class="flex items-center justify-between gap-4 rounded-xl border px-4 py-3 transition-colors
          {config.shadowMode ? 'border-sky-500/40 bg-sky-500/5' : 'border-warning/40 bg-warning/5'}"
        >
          <div class="min-w-0">
            <p class="text-sm font-medium text-on-surface flex items-center gap-2">
              <Papicon icon={config.shadowMode ? 'Eye' : 'Zap'} size={15} />
              Mode observation
            </p>
            <p class="text-xs text-on-surface-variant mt-0.5 leading-relaxed">
              {#if config.shadowMode}
                Actif : rien n'est supprimé ni sanctionné. Laisse tourner deux à trois semaines,
                puis calez les seuils sur la répartition observée ci-dessous avant de désactiver.
              {:else}
                <span class="text-warning font-medium">Désactivé</span> : les sanctions sont
                réellement appliquées. Vérifie que tu as tranché assez de détections pour que
                les seuils soient justifiés.
              {/if}
            </p>
          </div>
          <ToggleSwitch checked={config.shadowMode} onToggle={(v) => (config.shadowMode = v)} />
        </div>

        <div class="grid sm:grid-cols-2 gap-3">
          <label class="block">
            <span class="text-xs font-medium text-on-surface-variant">Salon d'alerte</span>
            <select
              bind:value={config.alertChannelId}
              class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
            >
              <option value={null}>Salon de logs par défaut</option>
              {#each channels as channel (channel.id)}
                <option value={channel.id}>#{channel.name}</option>
              {/each}
            </select>
          </label>

          <label class="block">
            <span class="text-xs font-medium text-on-surface-variant">
              Durée d'exclusion temporaire (minutes)
            </span>
            <input
              type="number"
              min="1"
              max="40320"
              bind:value={config.timeoutMinutes}
              class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
            />
          </label>
        </div>
      </div>
    </SectionCard>

    <!-- ── Calibration ────────────────────────────────────────────────── -->
    <SectionCard
      title="Paliers d'action"
      description="Chaque palier déclenche une action plus sévère. Les barres montrent la répartition réelle des scores sur 14 jours."
      icon="Sliders"
    >
      {#if stats && stats.total > 0}
        <div class="mb-5">
          <div class="flex items-end gap-1 h-24">
            {#each stats.histogram as band (band.from)}
              <div class="flex-1 flex flex-col items-center justify-end gap-1 group relative">
                <span class="text-2xs text-on-surface-variant/60 tabular-nums opacity-0 group-hover:opacity-100 transition-opacity">
                  {band.count}
                </span>
                <div
                  class="w-full rounded-t transition-all duration-500 {bandColor(band.from)}"
                  style="height: {Math.max(2, (band.count / histogramMax) * 76)}px"
                  title="{band.count} message(s) entre {band.from} et {band.to}"
                ></div>
                <span class="text-2xs text-on-surface-variant/50 tabular-nums">{band.from}</span>
              </div>
            {/each}
          </div>

          {#if projection}
            <div class="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
              <div class="rounded-lg bg-sky-500/10 px-2 py-2">
                <div class="text-[15px] font-semibold text-sky-500 tabular-nums">{projection.logged}</div>
                <div class="text-2xs text-on-surface-variant">journalisés</div>
              </div>
              <div class="rounded-lg bg-warning/10 px-2 py-2">
                <div class="text-[15px] font-semibold text-warning tabular-nums">{projection.deleted}</div>
                <div class="text-2xs text-on-surface-variant">supprimés</div>
              </div>
              <div class="rounded-lg bg-orange-500/10 px-2 py-2">
                <div class="text-[15px] font-semibold text-orange-500 tabular-nums">{projection.timedOut}</div>
                <div class="text-2xs text-on-surface-variant">exclus</div>
              </div>
              <div class="rounded-lg bg-error/10 px-2 py-2">
                <div class="text-[15px] font-semibold text-error tabular-nums">{projection.banned}</div>
                <div class="text-2xs text-on-surface-variant">bannis</div>
              </div>
            </div>
            <p class="mt-2 text-xs text-on-surface-variant/70 text-center">
              Projection sur les {stats.total} évaluations des 14 derniers jours avec les seuils actuels.
            </p>
          {/if}
        </div>
      {:else}
        <p class="mb-5 text-body-sm text-on-surface-variant leading-relaxed rounded-lg bg-surface-container/60 px-3 py-2.5">
          Aucune évaluation enregistrée pour l'instant. Active le moteur en mode observation :
          l'histogramme se remplira et permettra de choisir des seuils sur tes données plutôt qu'au jugé.
        </p>
      {/if}

      <div class="space-y-4">
        {#each [
          { field: 'logThreshold' as const, label: 'Journalisation', help: 'Enregistré pour analyse, aucune action visible.', color: 'accent-sky-500' },
          { field: 'deleteThreshold' as const, label: 'Suppression', help: 'Message supprimé et avertissement enregistré.', color: 'accent-amber-500' },
          { field: 'timeoutThreshold' as const, label: 'Exclusion temporaire', help: 'Message supprimé et membre exclu temporairement.', color: 'accent-orange-500' },
          { field: 'banThreshold' as const, label: 'Bannissement', help: 'Réservé aux cas certains. Mettre 101 pour ne jamais bannir automatiquement.', color: 'accent-red-500' },
        ] as row (row.field)}
          <div>
            <div class="flex items-baseline justify-between gap-3">
              <span class="text-body-sm font-medium text-on-surface">{row.label}</span>
              <span class="text-body-sm font-semibold tabular-nums text-on-surface">{config[row.field]}</span>
            </div>
            <input
              type="range"
              min="0"
              max="101"
              bind:value={config[row.field]}
              class="w-full mt-1 {row.color}"
            />
            <p class="text-xs text-on-surface-variant/70">{row.help}</p>
          </div>
        {/each}
      </div>
    </SectionCard>

    <!-- ── Signaux ────────────────────────────────────────────────────── -->
    <SectionCard
      title="Signaux actifs"
      description="Chaque signal contribue au score. Aucun signal ne décide seul : c'est leur concordance qui fait la preuve."
      icon="Radar"
    >
      <div class="space-y-3">
        {#each SIGNAL_TOGGLES as toggle (toggle.field)}
          {@const usage = stats?.signals.find((s) =>
            toggle.field === 'typingSignalEnabled' ? s.type === 'no_typing'
            : toggle.field === 'crossChannelEnabled' ? s.type === 'cross_channel_burst'
            : toggle.field === 'duplicateEnabled' ? s.type === 'near_duplicate'
            : toggle.field === 'cadenceEnabled' ? s.type === 'inhuman_rate'
            : toggle.field === 'contentEnabled' ? s.type === 'mention_burst'
            : false
          )}
          <div class="flex items-start justify-between gap-4 rounded-xl border border-outline-variant/30 px-4 py-3">
            <div class="min-w-0">
              <p class="text-body-sm font-medium text-on-surface flex items-center gap-2">
                {toggle.label}
                {#if usage}
                  <span class="text-2xs px-1.5 py-0.5 rounded bg-surface-container text-on-surface-variant">
                    {usage.count} déclenchements · poids ×{usage.weight.toFixed(2)}
                  </span>
                {/if}
              </p>
              <p class="text-xs text-on-surface-variant mt-1 leading-relaxed">{toggle.help}</p>
            </div>
            <ToggleSwitch
              checked={config[toggle.field] as boolean}
              onToggle={(v) => ((config[toggle.field] as boolean) = v)}
            />
          </div>
        {/each}
      </div>

      <div class="mt-5 pt-4 border-t border-outline-variant/30 grid sm:grid-cols-3 gap-3">
        <label class="block">
          <span class="text-xs font-medium text-on-surface-variant">Fenêtre d'observation (s)</span>
          <input
            type="number" min="5" max="300"
            bind:value={config.windowSeconds}
            class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
          />
        </label>
        <label class="block">
          <span class="text-xs font-medium text-on-surface-variant">Salons pour la diffusion</span>
          <input
            type="number" min="2" max="20"
            bind:value={config.crossChannelThreshold}
            class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
          />
        </label>
        <label class="block">
          <span class="text-xs font-medium text-on-surface-variant">Similarité des doublons</span>
          <input
            type="number" min="0.5" max="1" step="0.01"
            bind:value={config.duplicateSimilarity}
            class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
          />
        </label>
      </div>
    </SectionCard>

    <!-- ── Exemptions ─────────────────────────────────────────────────── -->
    <SectionCard
      title="Exemptions"
      description="Les membres pouvant déjà gérer les messages sont exemptés d'office."
      icon="Lock"
    >
      <div class="space-y-4">
        <div>
          <p class="text-xs font-medium text-on-surface-variant mb-2">
            Rôles exemptés
            {#if config.bypassRoleIds.length > 0}
              <span class="text-on-surface-variant/60">({config.bypassRoleIds.length})</span>
            {/if}
          </p>
          <div class="flex flex-wrap gap-1.5">
            {#each roles as role (role.id)}
              <button
                type="button"
                class="px-2.5 py-1 rounded-full text-xs font-medium border transition-colors
                {config.bypassRoleIds.includes(role.id)
                  ? 'bg-primary/15 border-primary/40 text-primary'
                  : 'bg-surface-container-low border-outline-variant/40 text-on-surface-variant hover:text-on-surface'}"
                onclick={() => toggleBypassRole(role.id)}
              >
                {role.name}
              </button>
            {/each}
          </div>
        </div>

        <div>
          <p class="text-xs font-medium text-on-surface-variant mb-2">
            Salons exemptés
            {#if config.bypassChannelIds.length > 0}
              <span class="text-on-surface-variant/60">({config.bypassChannelIds.length})</span>
            {/if}
          </p>
          <p class="text-2xs text-on-surface-variant/70 mb-2">
            Utile pour les salons de spam assumé (mèmes, bots, tests) où la répétition est la norme.
          </p>
          <div class="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto">
            {#each channels as channel (channel.id)}
              <button
                type="button"
                class="px-2.5 py-1 rounded-full text-xs font-medium border transition-colors
                {config.bypassChannelIds.includes(channel.id)
                  ? 'bg-primary/15 border-primary/40 text-primary'
                  : 'bg-surface-container-low border-outline-variant/40 text-on-surface-variant hover:text-on-surface'}"
                onclick={() => toggleBypassChannel(channel.id)}
              >
                #{channel.name}
              </button>
            {/each}
          </div>
        </div>
      </div>
    </SectionCard>

    <!-- ── File de decision ───────────────────────────────────────────── -->
    <SectionCard
      title="Détections à trancher"
      description="Chaque décision alimente le recalibrage automatique des poids par signal."
      icon="Scale"
    >
      {#snippet actions()}
        <label class="flex items-center gap-2 text-xs text-on-surface-variant cursor-pointer select-none">
          <input
            type="checkbox"
            checked={pendingOnly}
            onchange={(e) => {
              pendingOnly = e.currentTarget.checked;
              void loadSamples();
            }}
            class="accent-primary"
          />
          En attente uniquement
        </label>
      {/snippet}

      {#if stats && stats.labelsNeeded > 0}
        <div class="mb-4 rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-2.5">
          <p class="text-xs text-on-surface-variant leading-relaxed">
            <span class="font-medium text-on-surface">{stats.labelsNeeded} décision(s)</span>
            manquante(s) avant que le recalibrage automatique des poids puisse tourner. Il faut à la
            fois des vrais et des faux positifs - sans les deux, il n'y a rien à discriminer.
          </p>
        </div>
      {/if}

      {#if samples.length === 0}
        <EmptyState
          icon="ShieldCheck"
          title="Aucune détection"
          description={pendingOnly
            ? 'Rien à trancher pour le moment.'
            : 'Le moteur n\'a encore rien évalué au-dessus du seuil de journalisation.'}
        />
      {:else}
        <div class="space-y-2.5">
          {#each samples as sample (sample.id)}
            <article class="rounded-xl border border-outline-variant/30 bg-surface-container-low/40 p-3.5">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span
                      class="text-xs font-semibold tabular-nums px-1.5 py-0.5 rounded
                      {sample.score >= config.timeoutThreshold
                        ? 'bg-error/15 text-error'
                        : sample.score >= config.deleteThreshold
                          ? 'bg-warning/15 text-warning'
                          : 'bg-sky-500/15 text-sky-500'}"
                    >
                      {sample.score}/100
                    </span>
                    <span class="text-xs text-on-surface-variant">
                      <code class="text-2xs">{sample.userId}</code> dans <span class="text-on-surface">#{channels.find((c) => c.id === sample.channelId)?.name ?? sample.channelId}</span>
                    </span>
                    {#if sample.shadow}
                      <span class="text-2xs px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-500">observation</span>
                    {/if}
                    {#if sample.label}
                      <span
                        class="text-2xs px-1.5 py-0.5 rounded {sample.label === 'TRUE_POSITIVE'
                          ? 'bg-error/10 text-error'
                          : 'bg-success/10 text-success'}"
                      >
                        {sample.label === 'TRUE_POSITIVE' ? 'vrai positif' : 'faux positif'}
                      </span>
                    {/if}
                    <span class="text-2xs text-on-surface-variant/60 ml-auto">{formatRelative(sample.createdAt)}</span>
                  </div>

                  {#if sample.contentPreview}
                    <p class="mt-2 text-xs text-on-surface-variant bg-surface-container/60 rounded px-2.5 py-1.5 font-mono leading-relaxed wrap-break-word">
                      {sample.contentPreview}
                    </p>
                  {/if}

                  <div class="mt-2 flex flex-wrap gap-1">
                    {#each Object.entries(sample.features?.signals ?? {}) as [type, score]}
                      <span class="text-2xs px-1.5 py-0.5 rounded bg-surface-container text-on-surface-variant">
                        {SIGNAL_LABELS[type] ?? type} <span class="tabular-nums opacity-60">{score}</span>
                      </span>
                    {/each}
                  </div>
                </div>

                {#if !sample.label}
                  <div class="flex flex-col gap-1.5 shrink-0">
                    <button
                      type="button"
                      class="px-2.5 py-1 rounded-lg text-xs font-medium bg-error/15 text-error border border-error/30 hover:bg-error/25 disabled:opacity-50 transition-colors"
                      disabled={decidingId !== null}
                      onclick={() => decide(sample, true)}
                    >
                      Vrai positif
                    </button>
                    <button
                      type="button"
                      class="px-2.5 py-1 rounded-lg text-xs font-medium bg-success/15 text-success border border-success/30 hover:bg-success/25 disabled:opacity-50 transition-colors"
                      disabled={decidingId !== null}
                      onclick={() => decide(sample, false)}
                    >
                      Faux positif
                    </button>
                  </div>
                {/if}
              </div>
            </article>
          {/each}
        </div>
      {/if}
    </SectionCard>

    {#if dirty}
      <div class="sticky bottom-4 z-10">
        <div class="flex items-center justify-between gap-4 rounded-xl border border-primary/40 bg-surface-container-high/95 backdrop-blur px-4 py-3 shadow-lg">
          <p class="text-body-sm text-on-surface">Modifications non enregistrées</p>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="px-3 py-1.5 rounded-lg text-xs font-medium text-on-surface-variant hover:text-on-surface transition-colors"
              onclick={reset}
              disabled={saving}
            >
              Annuler
            </button>
            <button
              type="button"
              class="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-primary text-on-primary hover:opacity-90 disabled:opacity-50 transition-opacity"
              onclick={save}
              disabled={saving}
            >
              {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </div>
      </div>
    {/if}
  {/if}
</div>
