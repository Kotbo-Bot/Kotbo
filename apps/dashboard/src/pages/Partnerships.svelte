<script lang="ts">
  /**
   * Partenariats : les dossiers, leur avancement et ce qu'ils rapportent.
   *
   * Trois vues pour trois moments du travail, et pas une page par objet :
   *   - le pipeline, pour voir où en est chaque dossier ;
   *   - les demandes, pour trancher ce qui arrive ;
   *   - les réglages, qu'on ouvre une fois puis plus jamais.
   *
   * La fiche d'un dossier s'ouvre en panneau plutôt qu'en page : on y revient
   * sans cesse depuis le pipeline, et perdre la colonne de départ à chaque
   * consultation rendait le suivi pénible.
   */
  import { onMount } from 'svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import {
    fetchPartnerships,
    fetchPartnerApplications,
    decidePartnerApplication,
    updatePartnershipSettings,
    fetchPartnershipFinance,
    fetchPartnershipReadiness,
    runPartnershipSetup,
  } from '../lib/api';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import SectionCard from '../lib/components/SectionCard.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import ActionButton from '../lib/components/ActionButton.svelte';
  import LoadingHint from '../lib/components/LoadingHint.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import PartnershipSettingsPanel from '../lib/components/partnerships/PartnershipSettingsPanel.svelte';
  import PartnershipSetupBanner from '../lib/components/partnerships/PartnershipSetupBanner.svelte';
  import PartnershipPanel from '../lib/components/partnerships/PartnershipPanel.svelte';
  import { dateLocale } from '../lib/i18n';

  import { errorMessage } from '@kotbo/shared';
  type Catalog = {
    types: { key: string; label: string; description: string; kinds: string[]; defaultTier: string }[];
    tiers: { key: string; label: string; description: string }[];
    stages: { key: string; label: string; description: string; tone: string; order: number; live: boolean; terminal: boolean }[];
    benefits: { key: string; label: string; description: string; needsTarget: boolean; requiresModule?: string }[];
    commitments: { key: string; label: string; description: string; quantified: boolean; measure: string }[];
    kinds: { key: string; label: string; description: string }[];
    reputationReasons: Record<string, string>;
  };

  type PartnershipRow = {
    id: string;
    type: string;
    tier: string;
    stage: string;
    title: string | null;
    priority: number;
    endAt: string | null;
    healthScore: number;
    referredJoins: number;
    referredActive: number;
    ownerUserId: string | null;
    partner: { id: string; displayName: string; kind: string; iconUrl: string | null; trustScore: number };
  };

  type ApplicationRow = {
    id: string;
    projectName: string;
    description: string | null;
    memberCount: number | null;
    applicantTag: string | null;
    inviteUrl: string | null;
    status: string;
    createdAt: string;
    screening: { flags?: string[] } | null;
  };

  let loading = $state(true);
  let view = $state<'pipeline' | 'requests' | 'settings'>('pipeline');
  let partnerships = $state<PartnershipRow[]>([]);
  let applications = $state<ApplicationRow[]>([]);
  let catalog = $state<Catalog | null>(null);
  let settings = $state<Record<string, unknown> | null>(null);
  let finance = $state<{ receivedCents: number; pendingInCents: number; lateCount: number; currency: string } | null>(null);
  let search = $state('');
  /** Panneau ouvert : « new » pour un ajout, un identifiant pour un dossier. */
  let panel = $state<string | null>(null);
  let readiness = $state<any>(null);
  let settingUp = $state(false);

  const discordRoles = $derived(dashboardStore.state.discordRoles || []);
  const discordChannels = $derived(dashboardStore.state.discordChannels || []);

  /** Ce que Discord a dit du lien colle, affiche sous le champ. */

  /** Dossiers visibles, filtrés par la recherche locale. */
  const visible = $derived(
    search.trim()
      ? partnerships.filter((row) =>
          `${row.partner.displayName} ${row.title ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()),
        )
      : partnerships,
  );

  /**
   * Colonnes du pipeline. Seules les étapes qui portent au moins un dossier
   * sont affichées : douze colonnes vides masquent les trois qui comptent.
   */
  const columns = $derived.by(() => {
    if (!catalog) return [];
    const used = new Set(visible.map((row) => row.stage));
    return catalog.stages
      .filter((stage) => used.has(stage.key))
      .sort((a, b) => a.order - b.order)
      .map((stage) => ({ stage, rows: visible.filter((row) => row.stage === stage.key) }));
  });

  const pendingCount = $derived(applications.filter((row) => row.status === 'PENDING' || row.status === 'REVIEWING').length);

  const toneClass: Record<string, string> = {
    neutral: 'bg-surface-container text-on-surface-variant',
    info: 'bg-primary/10 text-primary',
    success: 'bg-success/10 text-success',
    warning: 'bg-warning/10 text-warning',
    danger: 'bg-error/10 text-error',
  };

  function healthClass(score: number): string {
    if (score >= 60) return 'text-success';
    if (score >= 40) return 'text-warning';
    return 'text-error';
  }

  async function load() {
    loading = true;
    try {
      const [list, apps, financeSummary, setupState] = await Promise.all([
        fetchPartnerships(),
        fetchPartnerApplications(),
        fetchPartnershipFinance(),
        fetchPartnershipReadiness(),
      ]);

      partnerships = list?.partnerships ?? [];
      catalog = list?.catalog ?? null;
      settings = list?.settings ?? null;
      applications = apps?.applications ?? [];
      finance = financeSummary?.summary ?? null;
      readiness = setupState?.readiness ?? null;
    } catch (err) {
      toast.error(errorMessage(err) || 'Chargement des partenariats impossible');
    } finally {
      loading = false;
    }
  }

  /**
   * Pose ce qui manque : salons, role, categorie, et allume le module.
   *
   * Le compte-rendu distingue ce qui a ete cree de ce qui a ete repris - un
   * serveur deja monte doit voir que rien n'a ete double.
   */
  async function setup() {
    if (settingUp) return;
    settingUp = true;
    try {
      const result = await runPartnershipSetup({});
      readiness = result?.readiness ?? readiness;

      const created = (result?.entries ?? []).filter((entry: any) => entry.created).length;
      const reused = (result?.entries ?? []).length - created;
      toast.success(
        created > 0
          ? `Module en service : ${created} element(s) cree(s)${reused > 0 ? `, ${reused} repris` : ''}`
          : 'Module en service : tout etait deja en place',
      );

      for (const warning of result?.warnings ?? []) toast.error(warning);
      await load();
    } catch (err) {
      toast.error(errorMessage(err) || 'Mise en service impossible');
    } finally {
      settingUp = false;
    }
  }

  /**
   * Refus en cours de saisie, et son motif.
   *
   * Le motif part au demandeur : il se redige dans la carte, sous la demande
   * qu'on est en train de lire, et non dans une boite du navigateur qui n'en
   * montre rien.
   */
  let rejecting = $state<string | null>(null);
  let rejectReason = $state('');

  async function decide(application: ApplicationRow, status: 'ACCEPTED' | 'REJECTED') {
    const reason = status === 'REJECTED' ? rejectReason.trim() || undefined : undefined;

    try {
      await decidePartnerApplication(application.id, { status, reason });
      rejecting = null;
      rejectReason = '';
      toast.success(status === 'ACCEPTED' ? 'Demande acceptée' : 'Demande refusée');
      await load();
    } catch (err) {
      toast.error(errorMessage(err) || 'Décision impossible');
    }
  }

  async function saveSettings(patch: Record<string, unknown>) {
    try {
      const result = await updatePartnershipSettings(patch);
      settings = result?.settings ?? settings;
      toast.success('Réglages enregistrés');
    } catch (err) {
      toast.error(errorMessage(err) || 'Enregistrement impossible');
    }
  }

  function money(cents: number, currency: string): string {
    return new Intl.NumberFormat(dateLocale(), { style: 'currency', currency: currency || 'EUR' }).format(cents / 100);
  }

  onMount(() => {
    if (authStore.selectedGuildId) void load();
  });
</script>

<ModulePage
  title="Partenariats"
  description="Partenaires, accords, avantages accordés et retombées mesurées"
  icon="handshake"
  featureKey="partnerships"
>
  {#snippet actions()}
    <ActionButton variant="primary" size="sm" icon="plus" label="Ajouter un partenaire" onclick={() => (panel = 'new')} />
    <RefreshButton onclick={load} loading={loading} />
  {/snippet}

  <PartnershipSetupBanner readiness={readiness} running={settingUp} onsetup={setup} />

  <!-- Bandeau de synthèse : ce qu'on veut savoir avant de descendre dans le détail. -->
  <div class="grid grid-cols-2 lg:grid-cols-4 gap-2.5 mb-4">
    <div class="rounded-xl bg-surface-container px-3 py-2.5">
      <div class="text-[18px] font-semibold text-on-surface tabular-nums">
        {partnerships.filter((row) => row.stage === 'ACTIVE' || row.stage === 'RENEWAL').length}
      </div>
      <div class="text-2xs text-on-surface-variant">Partenariats actifs</div>
    </div>
    <div class="rounded-xl bg-surface-container px-3 py-2.5">
      <div class="text-[18px] font-semibold text-on-surface tabular-nums">
        {partnerships.reduce((total, row) => total + row.referredJoins, 0)}
      </div>
      <div class="text-2xs text-on-surface-variant">Arrivées apportées</div>
    </div>
    <div class="rounded-xl bg-surface-container px-3 py-2.5">
      <div class="text-[18px] font-semibold text-on-surface tabular-nums">{pendingCount}</div>
      <div class="text-2xs text-on-surface-variant">Demandes en attente</div>
    </div>
    <div class="rounded-xl bg-surface-container px-3 py-2.5">
      <div class="text-[18px] font-semibold text-on-surface tabular-nums">
        {finance ? money(finance.receivedCents, finance.currency) : '-'}
      </div>
      <div class="text-2xs text-on-surface-variant">
        Encaissé{finance && finance.lateCount > 0 ? ` · ${finance.lateCount} en retard` : ''}
      </div>
    </div>
  </div>

  <div class="flex flex-wrap items-center gap-2 mb-4">
    <div class="inline-flex rounded-lg bg-surface-container p-0.5">
      <button
        class="px-3 py-1.5 text-xs rounded-md {view === 'pipeline' ? 'bg-surface text-on-surface' : 'text-on-surface-variant'}"
        onclick={() => (view = 'pipeline')}
      >
        Pipeline
      </button>
      <button
        class="px-3 py-1.5 text-xs rounded-md {view === 'requests' ? 'bg-surface text-on-surface' : 'text-on-surface-variant'}"
        onclick={() => (view = 'requests')}
      >
        Demandes{pendingCount > 0 ? ` (${pendingCount})` : ''}
      </button>
      <button
        class="px-3 py-1.5 text-xs rounded-md {view === 'settings' ? 'bg-surface text-on-surface' : 'text-on-surface-variant'}"
        onclick={() => (view = 'settings')}
      >
        Réglages
      </button>
    </div>

    {#if view === 'pipeline'}
      <input
        class="flex-1 min-w-[180px] max-w-xs rounded-lg border border-outline-variant/30 bg-surface-container-low px-3 py-1.5 text-xs text-on-surface"
        placeholder="Rechercher un partenaire"
        bind:value={search}
      />
    {/if}
  </div>

  {#if loading && partnerships.length === 0}
    <LoadingHint context="config" />
  {:else if view === 'pipeline'}
    {#if visible.length === 0}
      <EmptyState
        icon="handshake"
        title="Aucun partenariat"
        description="Un dossier suit un échange de pubs, une alliance ou un sponsor : avantages appliqués à l'activation, engagements mesurés, retombées comptées."
      >
        {#snippet action()}
          <ActionButton variant="primary" size="sm" icon="plus" label="Ajouter un premier partenaire" onclick={() => (panel = 'new')} />
        {/snippet}
      </EmptyState>
    {:else}
      <div class="flex gap-3 overflow-x-auto pb-2 items-start">
        {#each columns as column (column.stage.key)}
          <div class="min-w-[260px] w-[260px] shrink-0">
            <div class="flex items-center justify-between mb-2 px-1">
              <span class="text-2xs font-semibold px-2 py-0.5 rounded-full {toneClass[column.stage.tone] ?? toneClass.neutral}">
                {column.stage.label}
              </span>
              <span class="text-2xs text-on-surface-variant tabular-nums">{column.rows.length}</span>
            </div>

            <div class="space-y-2">
              {#each column.rows as row (row.id)}
                {@const typeMeta = catalog?.types.find((t) => t.key === row.type)}
                <button
                  class="w-full text-left rounded-xl border border-outline-variant/20 bg-surface-container-low/60 hover:bg-surface-container px-3 py-2.5 transition-colors"
                  onclick={() => (panel = row.id)}
                >
                  <div class="flex items-start gap-2">
                    {#if row.partner.iconUrl}
                      <img src={row.partner.iconUrl} alt="" class="w-7 h-7 rounded-lg object-cover shrink-0" />
                    {:else}
                      <div class="w-7 h-7 rounded-lg bg-surface-container grid place-items-center shrink-0">
                        <Papicon icon="server" size={13} />
                      </div>
                    {/if}
                    <div class="min-w-0 flex-1">
                      <p class="text-body-sm font-medium text-on-surface truncate">{row.partner.displayName}</p>
                      <p class="text-2xs text-on-surface-variant truncate">{typeMeta?.label ?? row.type}</p>
                    </div>
                    <span class="text-2xs font-semibold tabular-nums {healthClass(row.healthScore)}">{row.healthScore}</span>
                  </div>

                  <div class="flex items-center gap-3 mt-2 text-2xs text-on-surface-variant">
                    <span class="inline-flex items-center gap-1">
                      <Papicon icon="user-plus" size={11} />
                      {row.referredJoins}
                    </span>
                    {#if row.endAt}
                      <span class="inline-flex items-center gap-1">
                        <Papicon icon="calendar" size={11} />
                        {new Date(row.endAt).toLocaleDateString(dateLocale(), { day: '2-digit', month: 'short' })}
                      </span>
                    {/if}
                  </div>
                </button>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {:else if view === 'requests'}
    {#if applications.length === 0}
      <EmptyState
        icon="inbox"
        title="Aucune demande"
        description={settings?.applicationsOpen
          ? "Les candidatures arrivent par /partenariat proposer, par un formulaire ou par l'annuaire."
          : "Les demandes sont fermées : personne ne peut candidater pour l'instant."}
      >
        {#snippet action()}
          {#if !settings?.applicationsOpen}
            <ActionButton
              variant="primary"
              size="sm"
              icon="check"
              label="Ouvrir les demandes"
              onclick={() => saveSettings({ applicationsOpen: true })}
            />
          {/if}
        {/snippet}
      </EmptyState>
    {:else}
      <div class="grid grid-cols-1 xl:grid-cols-2 gap-3 items-start">
        {#each applications as application (application.id)}
          {@const flags = application.screening?.flags ?? []}
          <SectionCard title={application.projectName} description={application.applicantTag ?? undefined}>
            {#snippet actions()}
              <span class="text-2xs px-2 py-0.5 rounded-full font-semibold {application.status === 'PENDING' ? toneClass.info : toneClass.neutral}">
                {application.status}
              </span>
            {/snippet}

            <div class="space-y-3">
              {#if application.description}
                <p class="text-xs text-on-surface-variant whitespace-pre-wrap">{application.description}</p>
              {/if}

              <div class="flex flex-wrap gap-3 text-2xs text-on-surface-variant">
                {#if application.memberCount}
                  <span class="inline-flex items-center gap-1"><Papicon icon="users" size={12} />{application.memberCount} membres</span>
                {/if}
                {#if application.inviteUrl}
                  <a class="inline-flex items-center gap-1 text-primary hover:underline" href={application.inviteUrl} target="_blank" rel="noopener noreferrer">
                    <Papicon icon="link" size={12} />Voir le serveur
                  </a>
                {/if}
                <span class="inline-flex items-center gap-1">
                  <Papicon icon="calendar" size={12} />
                  {new Date(application.createdAt).toLocaleDateString(dateLocale())}
                </span>
              </div>

              {#if flags.length > 0}
                <!-- Points de vigilance : affichés, jamais bloquants. Le réseau
                     informe, il ne décide pas. -->
                <div class="rounded-lg bg-warning/10 px-3 py-2 space-y-1">
                  {#each flags as flag (flag)}
                    <p class="text-2xs text-warning flex items-start gap-1.5">
                      <Papicon icon="alert-triangle" size={12} class="mt-0.5 shrink-0" />
                      <span>{flag}</span>
                    </p>
                  {/each}
                </div>
              {/if}

              {#if application.status === 'PENDING' || application.status === 'REVIEWING'}
                {#if rejecting === application.id}
                  <div class="pt-1 border-t border-outline-variant/10 space-y-2">
                    <label class="block">
                      <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">
                        Motif du refus, transmis au demandeur
                      </span>
                      <textarea
                        class="w-full rounded-lg border border-outline-variant/30 bg-surface-container-low px-3 py-2 text-xs text-on-surface"
                        rows="2"
                        placeholder="Facultatif, mais toujours mieux qu'un refus sans explication"
                        bind:value={rejectReason}
                      ></textarea>
                    </label>
                    <div class="flex gap-2">
                      <ActionButton variant="danger" size="sm" label="Confirmer le refus" onclick={() => decide(application, 'REJECTED')} />
                      <ActionButton variant="neutral" size="sm" label="Annuler" onclick={() => { rejecting = null; rejectReason = ''; }} />
                    </div>
                  </div>
                {:else}
                  <div class="flex gap-2 pt-1 border-t border-outline-variant/10">
                    <ActionButton variant="primary" size="sm" icon="check" label="Accepter" onclick={() => decide(application, 'ACCEPTED')} />
                    <ActionButton variant="danger" size="sm" icon="x" label="Refuser" onclick={() => { rejecting = application.id; rejectReason = ''; }} />
                  </div>
                {/if}
              {/if}
            </div>
          </SectionCard>
        {/each}
      </div>
    {/if}
  {:else}
    <PartnershipSettingsPanel
      settings={settings}
      channels={discordChannels}
      roles={discordRoles}
      tiers={catalog?.tiers ?? []}
      onsave={saveSettings}
    />
  {/if}
</ModulePage>

<!-- ── Panneau : ajouter et gerer au meme endroit ────────────────────────── -->
{#if panel && catalog}
  <PartnershipPanel
    partnershipId={panel === 'new' ? null : panel}
    catalog={catalog}
    channels={discordChannels}
    roles={discordRoles}
    settings={settings}
    onsetting={saveSettings}
    onclose={() => (panel = null)}
    onchanged={load}
    onopen={(id) => (panel = id)}
  />
{/if}
