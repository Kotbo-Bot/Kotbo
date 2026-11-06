<script lang="ts">
  /**
   * Portail partenaire : ce qu'un partenaire sans Kotbo voit de son dossier.
   *
   * Page publique, sans compte ni connexion. Le jeton de l'URL est le seul
   * secret, et il n'ouvre que ce dossier : ni les notes internes, ni les autres
   * partenariats, ni quoi que ce soit du serveur. C'est la condition pour qu'un
   * lien transmis de bonne foi ne devienne pas une fuite.
   *
   * Un lien inconnu, révoqué ou expiré donne la même réponse - distinguer
   * renseignerait qui essaie des jetons au hasard.
   */
  import { onMount } from 'svelte';
  import { API_BASE_URL } from '../lib/api';
  import Papicon from '../lib/components/Papicon.svelte';
  import { m, dateLocale } from '../lib/i18n';

  const { token = '' }: { token?: string } = $props();

  let loading = $state(true);
  let error = $state<string | null>(null);
  let data = $state<any>(null);
  let signing = $state(false);
  let signed = $state(false);

  const partyLabel: Record<string, string> = {
    US: m.ppo_party_us(),
    PARTNER: m.ppo_party_partner(),
    BOTH: m.ppo_party_both(),
  };

  /** Le portail vit hors du dashboard : pas de store d'auth, pas d'en-tête. */
  function portalUrl(suffix = ''): string {
    const base = API_BASE_URL.replace(/\/api\/dashboard$/, '/api/public');
    return `${base}/partner-portal/${encodeURIComponent(token)}${suffix}`;
  }

  async function load() {
    loading = true;
    error = null;
    try {
      const response = await fetch(portalUrl());
      if (!response.ok) {
        error = response.status === 404 ? m.ppo_link_invalid() : m.ppo_load_failed();
        return;
      }
      data = await response.json();
    } catch {
      error = m.ppo_load_failed();
    } finally {
      loading = false;
    }
  }

  async function sign() {
    if (signing) return;
    signing = true;
    try {
      const response = await fetch(portalUrl('/accept'), { method: 'POST' });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        error = body?.error ?? m.ppo_sign_failed();
        return;
      }
      signed = true;
      await load();
    } catch {
      error = m.ppo_sign_failed();
    } finally {
      signing = false;
    }
  }

  function date(value: string | null | undefined): string {
    return value ? new Date(value).toLocaleDateString(dateLocale(), { day: '2-digit', month: 'long', year: 'numeric' }) : '-';
  }

  onMount(load);
</script>

<div class="min-h-screen bg-surface px-4 py-10">
  <div class="mx-auto max-w-2xl space-y-4">
    {#if loading}
      <p class="text-body-sm text-on-surface-variant text-center">{m.ppo_loading()}</p>
    {:else if error && !data}
      <div class="rounded-2xl border border-outline-variant/20 bg-surface-container px-5 py-8 text-center">
        <Papicon icon="alert-triangle" size={28} class="mx-auto mb-3 text-warning" />
        <p class="text-sm text-on-surface">{error}</p>
        <p class="text-xs text-on-surface-variant mt-2">
          {m.ppo_ask_new_link()}
        </p>
      </div>
    {:else if data}
      <!-- Entête : qui propose, à qui. -->
      <div class="rounded-2xl border border-outline-variant/20 bg-surface-container px-5 py-4 flex items-center gap-3">
        {#if data.host.icon}
          <img src={data.host.icon} alt="" class="w-11 h-11 rounded-xl object-cover" />
        {/if}
        <div class="min-w-0">
          <p class="text-[15px] font-semibold text-on-surface truncate">{data.host.name}</p>
          <p class="text-xs text-on-surface-variant truncate">
            {m.ppo_partnership_with({ name: data.partner.displayName })}
          </p>
        </div>
      </div>

      <div class="rounded-2xl border border-outline-variant/20 bg-surface-container px-5 py-4 space-y-3">
        <div class="flex flex-wrap gap-3 text-xs text-on-surface-variant">
          <span>{m.ppo_type()} <span class="text-on-surface">{data.partnership.type}</span></span>
          <span>{m.ppo_stage()} <span class="text-on-surface">{data.partnership.stage}</span></span>
          <span>{m.ppo_period()} <span class="text-on-surface">{date(data.partnership.startAt)} → {date(data.partnership.endAt)}</span></span>
        </div>

        {#if data.partnership.summary}
          <p class="text-body-sm text-on-surface whitespace-pre-wrap">{data.partnership.summary}</p>
        {/if}
        {#if data.partnership.terms}
          <p class="text-xs text-on-surface-variant whitespace-pre-wrap">{data.partnership.terms}</p>
        {/if}
      </div>

      {#if data.commitments.length > 0}
        <div class="rounded-2xl border border-outline-variant/20 bg-surface-container px-5 py-4">
          <p class="text-2xs font-bold text-on-surface-variant/80 mb-2">{m.ppo_commitments()}</p>
          <div class="space-y-1.5">
            {#each data.commitments as commitment (commitment.kind + commitment.label)}
              <div class="flex items-start justify-between gap-3 text-xs">
                <span class="text-on-surface">
                  {commitment.label ?? commitment.kind}
                  {#if commitment.targetCount}
                    <span class="text-on-surface-variant"> · {m.ppo_target({ count: commitment.targetCount, period: commitment.targetPeriod })}</span>
                  {/if}
                </span>
                <span class="text-2xs text-on-surface-variant shrink-0">{partyLabel[commitment.party] ?? ''}</span>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      {#if data.agreement}
        <div class="rounded-2xl border border-outline-variant/20 bg-surface-container px-5 py-4 space-y-3">
          <div class="flex items-center justify-between gap-3">
            <p class="text-2xs font-bold text-on-surface-variant/80">{m.ppo_agreement_version({ version: data.agreement.version })}</p>
            <span class="text-2xs text-on-surface-variant">
              {data.agreement.acceptedByUs ? m.ppo_signed_by_server() : m.ppo_waiting_server()}
              {#if data.agreement.acceptedByPartner} · {m.ppo_signed_by_you()}{/if}
            </span>
          </div>

          <p class="text-xs text-on-surface whitespace-pre-wrap">{data.agreement.body}</p>

          {#if data.capability === 'sign' && !data.agreement.acceptedByPartner}
            <button
              class="rounded-lg bg-primary text-on-primary px-4 py-2 text-body-sm font-medium disabled:opacity-60"
              onclick={sign}
              disabled={signing}
            >
              {signing ? m.ppo_saving() : m.ppo_accept()}
            </button>
            <p class="text-2xs text-on-surface-variant">
              {m.ppo_accept_note()}
            </p>
          {:else if data.agreement.acceptedByPartner || signed}
            <p class="text-xs text-success flex items-center gap-1.5">
              <Papicon icon="check" size={13} />
              {m.ppo_accepted()}
            </p>
          {:else if data.capability !== 'sign'}
            <p class="text-2xs text-on-surface-variant">{m.ppo_view_only()}</p>
          {/if}
        </div>
      {/if}

      {#if data.documents.length > 0}
        <div class="rounded-2xl border border-outline-variant/20 bg-surface-container px-5 py-4">
          <p class="text-2xs font-bold text-on-surface-variant/80 mb-2">{m.ppo_documents()}</p>
          <div class="space-y-1">
            {#each data.documents as document (document.url)}
              <a class="text-xs text-primary hover:underline block truncate" href={document.url} target="_blank" rel="noopener noreferrer">
                {document.label}
              </a>
            {/each}
          </div>
        </div>
      {/if}

      {#if error}
        <p class="text-xs text-error text-center">{error}</p>
      {/if}

      <p class="text-2xs text-on-surface-variant text-center">
        {m.ppo_valid_until({ date: date(data.expiresAt) })}
      </p>
    {/if}
  </div>
</div>
