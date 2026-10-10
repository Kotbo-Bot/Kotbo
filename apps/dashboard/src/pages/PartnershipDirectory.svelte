<script lang="ts">
  /**
   * Annuaire inter-serveurs : se faire trouver, trouver les autres, et tenir
   * la liste de ceux avec qui on ne veut plus travailler.
   *
   * La vitrine n'est publiée que si le module y a été autorisé dans les
   * réglages : la case de cette page ne suffit pas, et c'est voulu - publier
   * une fiche est un geste qui sort du serveur.
   */
  import { onMount } from 'svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import {
    fetchPartnershipDirectory,
    savePartnershipListing,
    searchPartnershipDirectory,
    computePartnershipMatches,
    dismissPartnershipMatch,
    sendPartnershipProposal,
    respondToPartnershipProposal,
    unblockPartnerSubject,
    withdrawPartnerReport,
    suggestPartnershipListing,
    createShowcaseInvite,
    fetchPartnershipSettings,
    updatePartnershipSettings,
  } from '../lib/api';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import SectionCard from '../lib/components/SectionCard.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import ActionButton from '../lib/components/ActionButton.svelte';
  import LoadingHint from '../lib/components/LoadingHint.svelte';
  import FormInput from '../lib/components/FormInput.svelte';
  import FormTextarea from '../lib/components/FormTextarea.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import { dateLocale } from '../lib/i18n';

  import { errorMessage } from '@kotbo/shared';
  let loading = $state(true);
  let tab = $state<'listing' | 'discover' | 'proposals' | 'trust'>('listing');

  let listing = $state<any>(null);
  let matches = $state<any[]>([]);
  let proposals = $state<{ sent: any[]; received: any[] }>({ sent: [], received: [] });
  let blocklist = $state<any[]>([]);
  let reports = $state<any[]>([]);

  let results = $state<any[]>([]);
  let searching = $state(false);
  let query = $state('');
  let filling = $state(false);
  let creatingInvite = $state(false);
  let settings = $state<Record<string, any> | null>(null);
  let types = $state<{ key: string; label: string }[]>([]);

  let form = $state({
    displayName: '',
    headline: '',
    description: '',
    tags: '',
    locale: 'fr',
    memberCount: 0,
    inviteUrl: '',
    seekingTypes: '',
    openToProposals: true,
    published: false,
  });

  const receivedPending = $derived(proposals.received.filter((row) => row.status === 'SENT' || row.status === 'SEEN'));

  async function load() {
    loading = true;
    try {
      const [data, settingsResult] = await Promise.all([
        fetchPartnershipDirectory(),
        fetchPartnershipSettings(),
      ]);
      settings = settingsResult?.settings ?? null;
      types = data?.types ?? [];
      listing = data?.listing ?? null;
      matches = data?.matches ?? [];
      proposals = data?.proposals ?? { sent: [], received: [] };
      blocklist = data?.blocklist ?? [];
      reports = data?.reports ?? [];

      if (listing) {
        form = {
          displayName: listing.displayName ?? '',
          headline: listing.headline ?? '',
          description: listing.description ?? '',
          tags: (listing.tags ?? []).join(', '),
          locale: listing.locale ?? 'fr',
          memberCount: 0,
          inviteUrl: listing.inviteUrl ?? '',
          seekingTypes: (listing.seekingTypes ?? []).join(', '),
          openToProposals: listing.openToProposals !== false,
          published: listing.published === true,
        };
      }
    } catch (err) {
      toast.error(errorMessage(err) || "Chargement de l'annuaire impossible");
    } finally {
      loading = false;
    }
  }

  /**
   * Remplit la fiche a partir du serveur Discord.
   *
   * Les champs deja saisis sont conserves : on complete ce qui manque, on
   * n'ecrase pas ce que quelqu'un a pris la peine d'ecrire. Le bouton se
   * reclique donc sans risque.
   */
  /**
   * Bascule un reglage du module depuis cette page.
   *
   * Le referencement se decide ici, devant la fiche que l'on est en train
   * d'ecrire, et non dans un onglet de reglages ou personne ne pense a aller
   * avant de s'etonner que la fiche ne parte pas.
   */
  async function toggleSetting(key: string, value: boolean) {
    try {
      const result = await updatePartnershipSettings({ [key]: value });
      settings = result?.settings ?? settings;
      toast.success(value ? 'Activé' : 'Désactivé');
    } catch (err) {
      toast.error(errorMessage(err) || 'Enregistrement impossible');
    }
  }

  async function fillFromServer() {
    if (filling) return;
    filling = true;
    try {
      const result = await suggestPartnershipListing();
      const suggestion = result?.suggestion;
      if (!suggestion) {
        toast.error('Informations du serveur indisponibles');
        return;
      }

      form.displayName = form.displayName.trim() || suggestion.displayName || '';
      form.description = form.description.trim() || suggestion.description || '';
      form.locale = form.locale || suggestion.locale || 'fr';
      form.memberCount = Number(form.memberCount) || suggestion.memberCount || 0;
      if (!form.tags.trim() && suggestion.tags?.length) form.tags = suggestion.tags.join(', ');

      toast.success('Fiche complétée depuis ton serveur');
    } catch (err) {
      toast.error(errorMessage(err) || 'Recuperation impossible');
    } finally {
      filling = false;
    }
  }

  /**
   * Demande au bot de creer l'invitation de la vitrine.
   *
   * Permanente et sans limite d'usage : une invitation d'annuaire qui expire
   * transforme la fiche en impasse, et personne ne s'en apercoit avant des
   * semaines. Si une invitation valide existe deja, elle est reutilisee.
   */
  async function createInvite() {
    if (creatingInvite) return;
    creatingInvite = true;
    try {
      const result = await createShowcaseInvite();
      if (!result?.inviteUrl) {
        toast.error("Aucune invitation n'a pu etre creee");
        return;
      }
      form.inviteUrl = result.inviteUrl;
      toast.success('Invitation creee');
    } catch (err) {
      toast.error(errorMessage(err) || 'Creation impossible');
    } finally {
      creatingInvite = false;
    }
  }

  async function saveListing() {
    try {
      const result = await savePartnershipListing({
        displayName: form.displayName.trim(),
        headline: form.headline.trim() || null,
        description: form.description.trim() || null,
        tags: form.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
        locale: form.locale,
        memberCount: Number(form.memberCount) || null,
        inviteUrl: form.inviteUrl.trim() || null,
        seekingTypes: form.seekingTypes.split(',').map((type) => type.trim()).filter(Boolean),
        openToProposals: form.openToProposals,
        published: form.published,
      });

      listing = result?.listing ?? listing;
      // Le serveur refuse la publication tant que le référencement n'a pas été
      // autorisé dans les réglages : on le dit plutôt que de laisser croire.
      if (form.published && listing?.published === false) {
        toast.error("Active d'abord le référencement dans les réglages du module.");
      } else {
        toast.success('Vitrine enregistrée');
      }
    } catch (err) {
      toast.error(errorMessage(err) || 'Enregistrement impossible');
    }
  }

  async function search() {
    searching = true;
    try {
      const data = await searchPartnershipDirectory({ q: query.trim() || undefined });
      results = data?.results ?? [];
    } catch (err) {
      toast.error(errorMessage(err) || 'Recherche impossible');
    } finally {
      searching = false;
    }
  }

  /**
   * Proposition en cours de redaction.
   *
   * Deux boites du navigateur a la suite - le type, puis le mot
   * d'accompagnement - demandaient de choisir un type sans voir la liste des
   * types, et d'ecrire un message sans voir a qui. Tout se compose maintenant
   * sous la carte du serveur vise.
   */
  let proposing = $state<{ guildId: string; name: string } | null>(null);
  let proposalType = $state('CROSS_PROMO');
  let proposalMessage = $state('');
  let sending = $state(false);

  function openProposal(guildId: string, name: string) {
    proposing = { guildId, name };
    proposalType = 'CROSS_PROMO';
    proposalMessage = '';
  }

  async function sendProposal() {
    if (!proposing || sending) return;
    sending = true;
    try {
      await sendPartnershipProposal({
        toGuildId: proposing.guildId,
        type: proposalType,
        message: proposalMessage.trim() || undefined,
      });
      toast.success(`Proposition envoyée à ${proposing.name}`);
      proposing = null;
      await load();
    } catch (err) {
      toast.error(errorMessage(err) || 'Proposition refusée');
    } finally {
      sending = false;
    }
  }

  async function respond(proposalId: string, action: 'accept' | 'decline' | 'withdraw') {
    if (action === 'accept') {
      const confirmed = await confirmDialog.ask({
        title: 'Accepter cette proposition ?',
        description: 'Un dossier est ouvert de chaque côté et les deux sont reliés par un pont. Rien n\'est actif tant que tu ne l\'actives pas.',
        confirmLabel: 'Accepter',
        variant: 'default',
      });
      if (!confirmed) return;
    }

    try {
      await respondToPartnershipProposal(proposalId, action);
      toast.success('Réponse enregistrée');
      await load();
    } catch (err) {
      toast.error(errorMessage(err) || 'Réponse impossible');
    }
  }

  async function refreshMatches() {
    try {
      const result = await computePartnershipMatches();
      toast.success(`${result?.computed ?? 0} suggestion(s) calculée(s)`);
      await load();
    } catch (err) {
      toast.error(errorMessage(err) || 'Calcul impossible');
    }
  }

  function date(value: string | null | undefined): string {
    return value ? new Date(value).toLocaleDateString(dateLocale()) : '-';
  }

  onMount(() => {
    if (authStore.selectedGuildId) void load();
  });
</script>

<ModulePage
  title="Annuaire partenaires"
  description="Se faire trouver par les serveurs Kotbo, et trouver ceux qui te correspondent"
  icon="compass"
  featureKey="partnerships"
>
  {#snippet actions()}
    <RefreshButton onclick={load} loading={loading} />
  {/snippet}

  <div class="inline-flex rounded-lg bg-surface-container p-0.5 mb-4 flex-wrap">
    {#each [['listing', 'Ma vitrine'], ['discover', 'Découvrir'], ['proposals', `Propositions${receivedPending.length > 0 ? ` (${receivedPending.length})` : ''}`], ['trust', 'Confiance']] as [key, label] (key)}
      <button
        class="px-3 py-1.5 text-xs rounded-md {tab === key ? 'bg-surface text-on-surface' : 'text-on-surface-variant'}"
        onclick={() => (tab = key as typeof tab)}
      >
        {label}
      </button>
    {/each}
  </div>

  {#if loading}
    <LoadingHint context="config" />
  {:else if tab === 'listing'}
    {#if settings && !settings.directoryOptIn}
      <div class="rounded-2xl border border-primary/30 bg-primary/5 px-5 py-4 mb-3 flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0">
          <p class="text-sm font-semibold text-on-surface flex items-center gap-2">
            <Papicon icon="compass" size={15} />
            Ton serveur n'est pas référencé
          </p>
          <p class="text-xs text-on-surface-variant mt-1 max-w-2xl">
            Tant que le référencement n'est pas autorisé, la fiche ci-dessous reste privée : la case « Publier »
            sera refusée. Seul ce que tu écris ici est publié, et l'effectif l'est par tranche.
          </p>
        </div>
        <ActionButton
          variant="primary"
          size="sm"
          icon="check"
          label="Autoriser le référencement"
          onclick={() => toggleSetting('directoryOptIn', true)}
        />
      </div>
    {/if}

    <div class="grid grid-cols-1 xl:grid-cols-2 gap-3 items-start">
      <SectionCard title="Ta fiche" description="Ce que les autres serveurs verront de toi">
        {#snippet actions()}
          <ActionButton
            variant="neutral"
            size="sm"
            icon="sparkles"
            label={filling ? 'Lecture…' : 'Remplir depuis mon serveur'}
            onclick={fillFromServer}
          />
        {/snippet}

        <div class="space-y-3">
          <FormInput label="Nom affiché" bind:value={form.displayName} />
          <FormInput label="Accroche" bind:value={form.headline} placeholder="Une ligne pour donner envie" />
          <label class="block">
            <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">Présentation</span>
            <FormTextarea bind:value={form.description} rows={4} />
          </label>
          <FormInput label="Thèmes (séparés par des virgules)" bind:value={form.tags} placeholder="gaming, entraide, francophone" />
          <FormInput label="Types recherchés" bind:value={form.seekingTypes} placeholder="CROSS_PROMO, EVENT" />
          <div class="space-y-1.5">
            <FormInput label="Lien d'invitation" bind:value={form.inviteUrl} placeholder="https://discord.gg/…" />
            <ActionButton
              variant="neutral"
              size="sm"
              icon="link"
              label={creatingInvite ? 'Creation…' : 'Creer le lien pour moi'}
              onclick={createInvite}
            />
          </div>
          <FormInput label="Effectif (publié par tranche)" type="number" bind:value={form.memberCount} />

          <label class="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" bind:checked={form.openToProposals} />
            <span class="text-body-sm text-on-surface">Accepter les propositions spontanées</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" bind:checked={form.published} />
            <span class="text-body-sm text-on-surface">Publier la fiche</span>
          </label>

          <p class="text-2xs text-on-surface-variant flex items-start gap-1.5">
            <Papicon icon="info" size={12} class="mt-0.5 shrink-0" />
            <span>
              L'effectif n'est jamais publié en valeur exacte, seulement par tranche. Aucune donnée de membre ne
              figure dans l'annuaire.
            </span>
          </p>

          <ActionButton variant="primary" size="sm" icon="save" label="Enregistrer" onclick={saveListing} />
        </div>
      </SectionCard>

      <SectionCard title="Réputation publique" description="Déduite des dossiers menés à leur terme, jamais saisie">
        {#if listing}
          <div class="grid grid-cols-2 gap-2">
            <div class="rounded-lg bg-surface-container px-3 py-2 text-center">
              <div class="text-[18px] font-semibold text-on-surface tabular-nums">{listing.reliabilityScore}</div>
              <div class="text-2xs text-on-surface-variant">Fiabilité /100</div>
            </div>
            <div class="rounded-lg bg-surface-container px-3 py-2 text-center">
              <div class="text-[18px] font-semibold text-on-surface tabular-nums">{listing.partnershipsDone}</div>
              <div class="text-2xs text-on-surface-variant">Partenariats terminés</div>
            </div>
          </div>
          <p class="text-2xs text-on-surface-variant mt-3">
            Publiée le {date(listing.lastPublishedAt)}. La fiabilité est le rapport entre les partenariats menés à
            terme et ceux qui ont été rompus.
          </p>
        {:else}
          <p class="text-xs text-on-surface-variant">Aucune fiche pour l'instant.</p>
        {/if}
      </SectionCard>
    </div>
  {:else if tab === 'discover'}
    <div class="space-y-4">
      <div class="flex flex-wrap gap-2 items-center">
        <input
          class="flex-1 min-w-[200px] max-w-md rounded-lg border border-outline-variant/30 bg-surface-container-low px-3 py-1.5 text-xs text-on-surface"
          placeholder="Chercher un serveur par nom ou accroche"
          bind:value={query}
          onkeydown={(event) => event.key === 'Enter' && search()}
        />
        <ActionButton variant="neutral" size="sm" icon="search" label={searching ? 'Recherche…' : 'Chercher'} onclick={search} />
        <ActionButton variant="neutral" size="sm" icon="sparkles" label="Recalculer les suggestions" onclick={refreshMatches} />

        {#if settings && !settings.matchmakingEnabled}
          <label class="flex items-center gap-2 cursor-pointer text-2xs text-on-surface-variant">
            <input
              type="checkbox"
              checked={false}
              onchange={() => toggleSetting('matchmakingEnabled', true)}
            />
            Suggérer automatiquement des partenaires compatibles
          </label>
        {/if}
      </div>

      {#if proposing}
        <SectionCard title={`Proposer à ${proposing.name}`} description="Ils recevront la proposition dans leur dashboard">
          <div class="space-y-3">
            <label class="block">
              <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">Type de partenariat</span>
              <select
                class="w-full rounded-lg border border-outline-variant/30 bg-surface-container-low px-3 py-2 text-xs text-on-surface"
                bind:value={proposalType}
              >
                {#each types as type (type.key)}
                  <option value={type.key}>{type.label}</option>
                {/each}
              </select>
            </label>

            <label class="block">
              <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">
                Mot d'accompagnement
              </span>
              <textarea
                class="w-full rounded-lg border border-outline-variant/30 bg-surface-container-low px-3 py-2 text-xs text-on-surface"
                rows="3"
                placeholder="Ce que tu proposes, en deux lignes"
                bind:value={proposalMessage}
              ></textarea>
            </label>

            <div class="flex gap-2">
              <ActionButton variant="primary" size="sm" icon="send" label={sending ? 'Envoi…' : 'Envoyer'} onclick={sendProposal} />
              <ActionButton variant="neutral" size="sm" label="Annuler" onclick={() => (proposing = null)} />
            </div>
          </div>
        </SectionCard>
      {/if}

      {#if matches.length > 0}
        <SectionCard title="Suggestions" description="Rapprochements calculés sur les thèmes, la taille, la langue et les types recherchés">
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-2">
            {#each matches as row (row.suggestion.id)}
              {@const reasons = row.suggestion.reasons ?? {}}
              <div class="rounded-xl border border-outline-variant/20 bg-surface-container-low/50 px-3 py-2.5">
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0">
                    <p class="text-body-sm font-medium text-on-surface truncate">{row.listing.displayName}</p>
                    <p class="text-2xs text-on-surface-variant truncate">{row.listing.headline ?? ''}</p>
                  </div>
                  <span class="text-2xs font-semibold text-primary tabular-nums shrink-0">{row.suggestion.score}</span>
                </div>

                <p class="text-2xs text-on-surface-variant mt-1.5">
                  {#if reasons.sharedTags?.length}{reasons.sharedTags.join(', ')}{/if}
                  {#if reasons.sameLocale} · même langue{/if}
                  {#if row.listing.sizeBucket} · {row.listing.sizeBucket}{/if}
                </p>

                <div class="flex gap-2 mt-2">
                  <ActionButton variant="primary" size="sm" icon="send" label="Proposer" onclick={() => openProposal(row.listing.guildId, row.listing.displayName)} />
                  <button
                    class="text-2xs text-on-surface-variant hover:underline"
                    onclick={async () => {
                      await dismissPartnershipMatch(row.listing.guildId);
                      await load();
                    }}
                  >
                    Écarter
                  </button>
                </div>
              </div>
            {/each}
          </div>
        </SectionCard>
      {/if}

      {#if results.length > 0}
        <SectionCard title="Résultats" description={`${results.length} serveur(s)`}>
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-2">
            {#each results as item (item.guildId)}
              <div class="rounded-xl border border-outline-variant/20 bg-surface-container-low/50 px-3 py-2.5">
                <p class="text-body-sm font-medium text-on-surface truncate">{item.displayName}</p>
                <p class="text-2xs text-on-surface-variant">{item.headline ?? ''}</p>
                <p class="text-2xs text-on-surface-variant mt-1">
                  {item.sizeBucket ?? '-'} · fiabilité {item.reliabilityScore}/100
                  {#if item.tags?.length} · {item.tags.slice(0, 4).join(', ')}{/if}
                </p>
                <div class="mt-2">
                  <ActionButton variant="neutral" size="sm" icon="send" label="Proposer un partenariat" onclick={() => openProposal(item.guildId, item.displayName)} />
                </div>
              </div>
            {/each}
          </div>
        </SectionCard>
      {:else if !searching && matches.length === 0}
        <EmptyState
          icon="compass"
          title="Rien à afficher"
          description="Publie ta vitrine et active les suggestions dans les réglages pour que l'annuaire te propose des partenaires compatibles."
        />
      {/if}
    </div>
  {:else if tab === 'proposals'}
    <div class="grid grid-cols-1 xl:grid-cols-2 gap-3 items-start">
      <SectionCard title="Reçues" description="Ce que d'autres serveurs te proposent">
        {#if proposals.received.length === 0}
          <p class="text-xs text-on-surface-variant">Aucune proposition reçue.</p>
        {:else}
          <div class="space-y-2">
            {#each proposals.received as proposal (proposal.id)}
              <div class="rounded-lg bg-surface-container-low/50 px-3 py-2">
                <p class="text-xs text-on-surface">{proposal.type} · {proposal.status}</p>
                {#if proposal.message}
                  <p class="text-2xs text-on-surface-variant mt-1 whitespace-pre-wrap">{proposal.message}</p>
                {/if}
                <p class="text-2xs text-on-surface-variant mt-1">Expire le {date(proposal.expiresAt)}</p>
                {#if proposal.status === 'SENT' || proposal.status === 'SEEN'}
                  <div class="flex gap-2 mt-2">
                    <ActionButton variant="primary" size="sm" icon="check" label="Accepter" onclick={() => respond(proposal.id, 'accept')} />
                    <ActionButton variant="neutral" size="sm" icon="x" label="Décliner" onclick={() => respond(proposal.id, 'decline')} />
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </SectionCard>

      <SectionCard title="Envoyées" description="Ce que tu as proposé">
        {#if proposals.sent.length === 0}
          <p class="text-xs text-on-surface-variant">Aucune proposition envoyée.</p>
        {:else}
          <div class="space-y-2">
            {#each proposals.sent as proposal (proposal.id)}
              <div class="rounded-lg bg-surface-container-low/50 px-3 py-2 flex items-center justify-between gap-3">
                <span class="text-xs text-on-surface">{proposal.type} · {proposal.status}</span>
                {#if proposal.status === 'SENT' || proposal.status === 'SEEN'}
                  <button class="text-2xs text-on-surface-variant hover:underline" onclick={() => respond(proposal.id, 'withdraw')}>
                    Retirer
                  </button>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </SectionCard>
    </div>
  {:else}
    <div class="grid grid-cols-1 xl:grid-cols-2 gap-3 items-start">
      <SectionCard title="Liste de blocage" description="Serveurs et personnes avec qui tu ne veux plus travailler">
        {#if blocklist.length === 0}
          <p class="text-xs text-on-surface-variant">Personne n'est bloqué.</p>
        {:else}
          <div class="space-y-2">
            {#each blocklist as entry (entry.id)}
              <div class="rounded-lg bg-surface-container-low/50 px-3 py-2 flex items-center justify-between gap-3">
                <span class="text-xs text-on-surface min-w-0">
                  <span class="block truncate">{entry.subjectRef}</span>
                  <span class="text-2xs text-on-surface-variant">{entry.reason ?? 'Sans motif'}</span>
                </span>
                <button
                  class="text-2xs text-on-surface-variant hover:underline shrink-0"
                  onclick={async () => {
                    await unblockPartnerSubject(entry.id);
                    await load();
                  }}
                >
                  Débloquer
                </button>
              </div>
            {/each}
          </div>
        {/if}
      </SectionCard>

      <SectionCard title="Signalements émis" description="Retire-les si le litige est réglé">
        {#if reports.length === 0}
          <p class="text-xs text-on-surface-variant">Aucun signalement.</p>
        {:else}
          <div class="space-y-2">
            {#each reports as report (report.id)}
              <div class="rounded-lg bg-surface-container-low/50 px-3 py-2 flex items-center justify-between gap-3">
                <span class="text-xs text-on-surface min-w-0">
                  <span class="block truncate">{report.partner.displayName}</span>
                  <span class="text-2xs text-on-surface-variant">
                    {report.reason} · gravité {report.severity} · {date(report.createdAt)}
                    {#if report.shared} · partagé au réseau{/if}
                  </span>
                </span>
                <button
                  class="text-2xs text-on-surface-variant hover:underline shrink-0"
                  onclick={async () => {
                    await withdrawPartnerReport(report.id);
                    await load();
                  }}
                >
                  Retirer
                </button>
              </div>
            {/each}
          </div>
        {/if}

        <p class="text-2xs text-on-surface-variant mt-3">
          Les signalements partagés sont anonymisés : les autres serveurs voient leur nombre et leur nature, jamais
          leur auteur. Un signal n'a jamais refusé un partenariat tout seul.
        </p>
      </SectionCard>
    </div>
  {/if}
</ModulePage>
