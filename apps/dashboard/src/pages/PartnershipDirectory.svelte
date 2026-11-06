<script lang="ts">
  import { m } from '../lib/i18n';
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
      toast.error(errorMessage(err) || m.pd_load_failed());
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
      toast.success(value ? m.common_enabled() : m.common_disabled());
    } catch (err) {
      toast.error(errorMessage(err) || m.tmac_err_save());
    }
  }

  async function fillFromServer() {
    if (filling) return;
    filling = true;
    try {
      const result = await suggestPartnershipListing();
      const suggestion = result?.suggestion;
      if (!suggestion) {
        toast.error(m.pd_server_info_unavailable());
        return;
      }

      form.displayName = form.displayName.trim() || suggestion.displayName || '';
      form.description = form.description.trim() || suggestion.description || '';
      form.locale = form.locale || suggestion.locale || 'fr';
      form.memberCount = Number(form.memberCount) || suggestion.memberCount || 0;
      if (!form.tags.trim() && suggestion.tags?.length) form.tags = suggestion.tags.join(', ');

      toast.success(m.pd_filled_from_server());
    } catch (err) {
      toast.error(errorMessage(err) || m.pd_fetch_failed());
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
        toast.error(m.pd_invite_create_failed());
        return;
      }
      form.inviteUrl = result.inviteUrl;
      toast.success(m.pd_invite_created());
    } catch (err) {
      toast.error(errorMessage(err) || m.common_create_failed());
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
        toast.error(m.pd_listing_disabled());
      } else {
        toast.success(m.pd_showcase_saved());
      }
    } catch (err) {
      toast.error(errorMessage(err) || m.tmac_err_save());
    }
  }

  async function search() {
    searching = true;
    try {
      const data = await searchPartnershipDirectory({ q: query.trim() || undefined });
      results = data?.results ?? [];
    } catch (err) {
      toast.error(errorMessage(err) || m.pd_search_failed());
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
      toast.success(m.pd_proposal_sent({ name: proposing.name }));
      proposing = null;
      await load();
    } catch (err) {
      toast.error(errorMessage(err) || m.pd_proposal_refused());
    } finally {
      sending = false;
    }
  }

  async function respond(proposalId: string, action: 'accept' | 'decline' | 'withdraw') {
    if (action === 'accept') {
      const confirmed = await confirmDialog.ask({
        title: m.pdir_accept_confirm_title(),
        description: m.pdir_accept_confirm_desc(),
        confirmLabel: m.pdir_accept(),
        variant: 'default',
      });
      if (!confirmed) return;
    }

    try {
      await respondToPartnershipProposal(proposalId, action);
      toast.success(m.pd_answer_saved());
      await load();
    } catch (err) {
      toast.error(errorMessage(err) || m.pd_answer_failed());
    }
  }

  async function refreshMatches() {
    try {
      const result = await computePartnershipMatches();
      toast.success(m.pd_suggestions_computed({ count: result?.computed ?? 0 }));
      await load();
    } catch (err) {
      toast.error(errorMessage(err) || m.pd_compute_failed());
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
  title={m.pdir_title()}
  description={m.pdir_desc()}
  icon="compass"
  featureKey="partnerships"
>
  {#snippet actions()}
    <RefreshButton onclick={load} loading={loading} />
  {/snippet}

  <div class="inline-flex rounded-lg bg-surface-container p-0.5 mb-4 flex-wrap">
    {#each [['listing', m.pdir_tab_listing()], ['discover', m.pdir_tab_discover()], ['proposals', receivedPending.length > 0 ? m.pdir_tab_proposals_count({ count: receivedPending.length }) : m.pdir_tab_proposals()], ['trust', m.pdir_tab_trust()]] as [key, label] (key)}
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
            {m.pdir_not_listed()}
          </p>
          <p class="text-xs text-on-surface-variant mt-1 max-w-2xl">
            {m.pdir_not_listed_desc()}
          </p>
        </div>
        <ActionButton
          variant="primary"
          size="sm"
          icon="check"
          label={m.pdir_allow_listing()}
          onclick={() => toggleSetting('directoryOptIn', true)}
        />
      </div>
    {/if}

    <div class="grid grid-cols-1 xl:grid-cols-2 gap-3 items-start">
      <SectionCard title={m.pdir_profile_title()} description={m.pdir_profile_desc()}>
        {#snippet actions()}
          <ActionButton
            variant="neutral"
            size="sm"
            icon="sparkles"
            label={filling ? m.pdir_reading() : m.pdir_fill_from_server()}
            onclick={fillFromServer}
          />
        {/snippet}

        <div class="space-y-3">
          <FormInput label={m.pdir_display_name()} bind:value={form.displayName} />
          <FormInput label={m.pdir_headline()} bind:value={form.headline} placeholder={m.pdir_headline_ph()} />
          <label class="block">
            <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">{m.pdir_description()}</span>
            <FormTextarea bind:value={form.description} rows={4} />
          </label>
          <FormInput label={m.pdir_tags()} bind:value={form.tags} placeholder={m.pdir_tags_ph()} />
          <FormInput label={m.pdir_seeking()} bind:value={form.seekingTypes} placeholder="CROSS_PROMO, EVENT" />
          <div class="space-y-1.5">
            <FormInput label={m.pdir_invite_url()} bind:value={form.inviteUrl} placeholder="https://discord.gg/…" />
            <ActionButton
              variant="neutral"
              size="sm"
              icon="link"
              label={creatingInvite ? m.pdir_creating() : m.pdir_create_invite()}
              onclick={createInvite}
            />
          </div>
          <FormInput label={m.pdir_member_count()} type="number" bind:value={form.memberCount} />

          <label class="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" bind:checked={form.openToProposals} />
            <span class="text-body-sm text-on-surface">{m.pdir_open_to_proposals()}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" bind:checked={form.published} />
            <span class="text-body-sm text-on-surface">{m.pdir_publish()}</span>
          </label>

          <p class="text-2xs text-on-surface-variant flex items-start gap-1.5">
            <Papicon icon="info" size={12} class="mt-0.5 shrink-0" />
            <span>
              {m.pdir_privacy_note()}
            </span>
          </p>

          <ActionButton variant="primary" size="sm" icon="save" label={m.common_save()} onclick={saveListing} />
        </div>
      </SectionCard>

      <SectionCard title={m.pdir_reputation_title()} description={m.pdir_reputation_desc()}>
        {#if listing}
          <div class="grid grid-cols-2 gap-2">
            <div class="rounded-lg bg-surface-container px-3 py-2 text-center">
              <div class="text-[18px] font-semibold text-on-surface tabular-nums">{listing.reliabilityScore}</div>
              <div class="text-2xs text-on-surface-variant">{m.pdir_reliability()}</div>
            </div>
            <div class="rounded-lg bg-surface-container px-3 py-2 text-center">
              <div class="text-[18px] font-semibold text-on-surface tabular-nums">{listing.partnershipsDone}</div>
              <div class="text-2xs text-on-surface-variant">{m.pdir_done()}</div>
            </div>
          </div>
          <p class="text-2xs text-on-surface-variant mt-3">
            {m.pdir_published_on({ date: date(listing.lastPublishedAt) })}
          </p>
        {:else}
          <p class="text-xs text-on-surface-variant">{m.pdir_no_profile()}</p>
        {/if}
      </SectionCard>
    </div>
  {:else if tab === 'discover'}
    <div class="space-y-4">
      <div class="flex flex-wrap gap-2 items-center">
        <input
          class="flex-1 min-w-[200px] max-w-md rounded-lg border border-outline-variant/30 bg-surface-container-low px-3 py-1.5 text-xs text-on-surface"
          placeholder={m.pdir_search_ph()}
          bind:value={query}
          onkeydown={(event) => event.key === 'Enter' && search()}
        />
        <ActionButton variant="neutral" size="sm" icon="search" label={searching ? m.pdir_searching() : m.pdir_search()} onclick={search} />
        <ActionButton variant="neutral" size="sm" icon="sparkles" label={m.pdir_recompute()} onclick={refreshMatches} />

        {#if settings && !settings.matchmakingEnabled}
          <label class="flex items-center gap-2 cursor-pointer text-2xs text-on-surface-variant">
            <input
              type="checkbox"
              checked={false}
              onchange={() => toggleSetting('matchmakingEnabled', true)}
            />
            {m.pdir_enable_matchmaking()}
          </label>
        {/if}
      </div>

      {#if proposing}
        <SectionCard title={m.pdir_propose_to({ name: proposing.name })} description={m.pdir_propose_desc()}>
          <div class="space-y-3">
            <label class="block">
              <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">{m.pdir_type()}</span>
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
                {m.pdir_message()}
              </span>
              <textarea
                class="w-full rounded-lg border border-outline-variant/30 bg-surface-container-low px-3 py-2 text-xs text-on-surface"
                rows="3"
                placeholder={m.pdir_message_ph()}
                bind:value={proposalMessage}
              ></textarea>
            </label>

            <div class="flex gap-2">
              <ActionButton variant="primary" size="sm" icon="send" label={sending ? m.pdir_sending() : m.pdir_send()} onclick={sendProposal} />
              <ActionButton variant="neutral" size="sm" label={m.common_cancel()} onclick={() => (proposing = null)} />
            </div>
          </div>
        </SectionCard>
      {/if}

      {#if matches.length > 0}
        <SectionCard title={m.pdir_suggestions()} description={m.pdir_suggestions_desc()}>
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
                  {#if reasons.sameLocale} · {m.pdir_same_language()}{/if}
                  {#if row.listing.sizeBucket} · {row.listing.sizeBucket}{/if}
                </p>

                <div class="flex gap-2 mt-2">
                  <ActionButton variant="primary" size="sm" icon="send" label={m.pdir_propose()} onclick={() => openProposal(row.listing.guildId, row.listing.displayName)} />
                  <button
                    class="text-2xs text-on-surface-variant hover:underline"
                    onclick={async () => {
                      await dismissPartnershipMatch(row.listing.guildId);
                      await load();
                    }}
                  >
                    {m.pdir_dismiss()}
                  </button>
                </div>
              </div>
            {/each}
          </div>
        </SectionCard>
      {/if}

      {#if results.length > 0}
        <SectionCard title={m.pdir_results()} description={m.pdir_results_count({ count: results.length })}>
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-2">
            {#each results as item (item.guildId)}
              <div class="rounded-xl border border-outline-variant/20 bg-surface-container-low/50 px-3 py-2.5">
                <p class="text-body-sm font-medium text-on-surface truncate">{item.displayName}</p>
                <p class="text-2xs text-on-surface-variant">{item.headline ?? ''}</p>
                <p class="text-2xs text-on-surface-variant mt-1">
                  {item.sizeBucket ?? '-'} · {m.pdir_reliability_score({ score: item.reliabilityScore })}
                  {#if item.tags?.length} · {item.tags.slice(0, 4).join(', ')}{/if}
                </p>
                <div class="mt-2">
                  <ActionButton variant="neutral" size="sm" icon="send" label={m.pdir_propose_partnership()} onclick={() => openProposal(item.guildId, item.displayName)} />
                </div>
              </div>
            {/each}
          </div>
        </SectionCard>
      {:else if !searching && matches.length === 0}
        <EmptyState
          icon="compass"
          title={m.pdir_empty_title()}
          description={m.pdir_empty_desc()} reason="instruction" />
      {/if}
    </div>
  {:else if tab === 'proposals'}
    <div class="grid grid-cols-1 xl:grid-cols-2 gap-3 items-start">
      <SectionCard title={m.pdir_received()} description={m.pdir_received_desc()}>
        {#if proposals.received.length === 0}
          <p class="text-xs text-on-surface-variant">{m.pdir_no_received()}</p>
        {:else}
          <div class="space-y-2">
            {#each proposals.received as proposal (proposal.id)}
              <div class="rounded-lg bg-surface-container-low/50 px-3 py-2">
                <p class="text-xs text-on-surface">{proposal.type} · {proposal.status}</p>
                {#if proposal.message}
                  <p class="text-2xs text-on-surface-variant mt-1 whitespace-pre-wrap">{proposal.message}</p>
                {/if}
                <p class="text-2xs text-on-surface-variant mt-1">{m.pdir_expires_on({ date: date(proposal.expiresAt) })}</p>
                {#if proposal.status === 'SENT' || proposal.status === 'SEEN'}
                  <div class="flex gap-2 mt-2">
                    <ActionButton variant="primary" size="sm" icon="check" label={m.pdir_accept()} onclick={() => respond(proposal.id, 'accept')} />
                    <ActionButton variant="neutral" size="sm" icon="x" label={m.pdir_decline()} onclick={() => respond(proposal.id, 'decline')} />
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </SectionCard>

      <SectionCard title={m.pdir_sent()} description={m.pdir_sent_desc()}>
        {#if proposals.sent.length === 0}
          <p class="text-xs text-on-surface-variant">{m.pdir_no_sent()}</p>
        {:else}
          <div class="space-y-2">
            {#each proposals.sent as proposal (proposal.id)}
              <div class="rounded-lg bg-surface-container-low/50 px-3 py-2 flex items-center justify-between gap-3">
                <span class="text-xs text-on-surface">{proposal.type} · {proposal.status}</span>
                {#if proposal.status === 'SENT' || proposal.status === 'SEEN'}
                  <button class="text-2xs text-on-surface-variant hover:underline" onclick={() => respond(proposal.id, 'withdraw')}>
                    {m.pdir_withdraw()}
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
      <SectionCard title={m.pdir_blocklist()} description={m.pdir_blocklist_desc()}>
        {#if blocklist.length === 0}
          <p class="text-xs text-on-surface-variant">{m.pdir_blocklist_empty()}</p>
        {:else}
          <div class="space-y-2">
            {#each blocklist as entry (entry.id)}
              <div class="rounded-lg bg-surface-container-low/50 px-3 py-2 flex items-center justify-between gap-3">
                <span class="text-xs text-on-surface min-w-0">
                  <span class="block truncate">{entry.subjectRef}</span>
                  <span class="text-2xs text-on-surface-variant">{entry.reason ?? m.pdir_no_reason()}</span>
                </span>
                <button
                  class="text-2xs text-on-surface-variant hover:underline shrink-0"
                  onclick={async () => {
                    await unblockPartnerSubject(entry.id);
                    await load();
                  }}
                >
                  {m.pdir_unblock()}
                </button>
              </div>
            {/each}
          </div>
        {/if}
      </SectionCard>

      <SectionCard title={m.pdir_reports()} description={m.pdir_reports_desc()}>
        {#if reports.length === 0}
          <p class="text-xs text-on-surface-variant">{m.pdir_no_reports()}</p>
        {:else}
          <div class="space-y-2">
            {#each reports as report (report.id)}
              <div class="rounded-lg bg-surface-container-low/50 px-3 py-2 flex items-center justify-between gap-3">
                <span class="text-xs text-on-surface min-w-0">
                  <span class="block truncate">{report.partner.displayName}</span>
                  <span class="text-2xs text-on-surface-variant">
                    {report.reason} · {m.pdir_severity({ severity: report.severity })} · {date(report.createdAt)}
                    {#if report.shared} · {m.pdir_shared()}{/if}
                  </span>
                </span>
                <button
                  class="text-2xs text-on-surface-variant hover:underline shrink-0"
                  onclick={async () => {
                    await withdrawPartnerReport(report.id);
                    await load();
                  }}
                >
                  {m.pdir_withdraw()}
                </button>
              </div>
            {/each}
          </div>
        {/if}

        <p class="text-2xs text-on-surface-variant mt-3">
          {m.pdir_reports_note()}
        </p>
      </SectionCard>
    </div>
  {/if}
</ModulePage>
