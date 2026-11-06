<script lang="ts">
  import { m } from '../../i18n';
  /**
   * Panneau des partenariats : ajouter et gerer au meme endroit.
   *
   * Ce qui precedait posait trois problemes, et ils tenaient tous a la meme
   * cause - deux ecrans differents pour un seul travail :
   *
   *   - un assistant en trois etapes pour un geste qu'on repete, avec sa
   *     ceremonie, ses allers-retours et son recapitulatif ;
   *   - une fiche en modal a cinq onglets, ou l'information qu'on cherche est
   *     toujours derriere celui qu'on n'a pas ouvert ;
   *   - une rupture complete entre les deux : on ajoutait dans un ecran, on
   *     gerait dans un autre, sans rien de commun.
   *
   * D'ou un panneau lateral unique. Il glisse depuis la droite, le pipeline
   * reste visible derriere - on voit d'ou vient le dossier qu'on lit - et il
   * passe de la creation a la gestion sans changer de cadre : ajouter, c'est
   * son etat vide.
   *
   * ── Ce qui a disparu, volontairement ────────────────────────────────────
   *
   * Les `window.prompt`. Demander un motif de rupture dans une boite du
   * navigateur, sans contexte, sans mise en forme et sans possibilite
   * d'annuler proprement, etait la pire partie de l'ancienne fiche. Tout se
   * saisit desormais dans le panneau lui-meme.
   *
   * Les onglets, remplaces par des sections qu'on deplie. Une section dit ce
   * qu'elle contient avant meme d'etre ouverte - « 3 engagements, 1 non tenu »
   * - ce qu'un onglet ne fait jamais.
   */
  import { onMount } from 'svelte';
  import {
    fetchPartnership,
    createPartnershipQuick,
    lookupPartnerInvite,
    setPartnershipStage,
    approvePartnership,
    ensurePartnershipInvite,
    refreshPartnershipHealth,
    checkPartnershipReciprocity,
    refreshPartnershipShowcase,
    addPartnershipBenefit,
    removePartnershipBenefit,
    applyPartnershipBenefits,
    revokePartnershipBenefits,
    addPartnershipCommitment,
    setCommitmentState,
    removeCommitment,
    savePartnershipPromotion,
    publishPartnershipPromotion,
    draftPartnershipAgreement,
    agreementAction,
    createGuestAccess,
    addPartnershipPayment,
    settlePartnershipPayment,
    addPartnershipNote,
  } from '../../api';
  import { toast } from '../../stores/toast.svelte';
  import ActionButton from '../ActionButton.svelte';
  import FormInput from '../FormInput.svelte';
  import FormTextarea from '../FormTextarea.svelte';
  import FormSelect from '../FormSelect.svelte';
  import Papicon from '../Papicon.svelte';
  import { dateLocale } from '../../i18n';

  import { errorMessage } from '@kotbo/shared';
  const {
    partnershipId = null,
    catalog,
    channels = [],
    roles = [],
    settings = null,
    onsetting,
    onclose,
    onchanged,
    onopen,
  }: {
    /** Dossier a gerer. Absent : le panneau s'ouvre en mode ajout. */
    partnershipId?: string | null;
    catalog: any;
    channels?: { id: string; name: string }[];
    roles?: { id: string; name: string }[];
    settings?: Record<string, any> | null;
    onsetting?: (patch: Record<string, unknown>) => void | Promise<void>;
    onclose: () => void;
    onchanged: () => void | Promise<void>;
    /** Bascule le panneau sur le dossier qui vient d'etre cree. */
    onopen: (id: string) => void;
  } = $props();

  const creating = $derived(!partnershipId);

  let loading = $state(false);
  let busy = $state(false);
  let data = $state<any>(null);
  let report = $state<any>(null);
  let bridged = $state<any>(null);
  let nextStages = $state<string[]>([]);

  // ── Mode ajout ─────────────────────────────────────────────────────────
  let inviteInput = $state('');
  let lookingUp = $state(false);
  let lookup = $state<any>(null);
  let manualName = $state('');
  let presetKey = $state('cross-promo');

  // ── Mode gestion ───────────────────────────────────────────────────────
  /** Section ouverte. Une seule a la fois : le panneau est etroit. */
  let openSection = $state<string | null>(null);
  /** Rupture en cours de saisie : le motif se donne ici, pas dans une boite. */
  let breaking = $state(false);
  let breakReason = $state('');
  /** Lien invite, affiche une seule fois apres creation. */
  let guestLink = $state<string | null>(null);

  let noteDraft = $state('');
  let agreementDraft = $state('');
  let benefitKind = $state('PARTNER_ROLE');
  let benefitTarget = $state('');
  let commitmentKind = $state('PROMO_POST');
  let commitmentCount = $state(1);
  let commitmentPeriod = $state('month');
  let promoTitle = $state('');
  let promoContent = $state('');
  let promoChannel = $state('');
  let paymentAmount = $state('');
  let paymentDue = $state('');

  const presets = $derived((catalog?.presets ?? []) as any[]);
  const preset = $derived(presets.find((item) => item.key === presetKey) ?? null);
  const stageMeta = $derived(catalog?.stages?.find((item: any) => item.key === data?.stage));
  const typeMeta = $derived(catalog?.types?.find((item: any) => item.key === data?.type));
  const tierMeta = $derived(catalog?.tiers?.find((item: any) => item.key === data?.tier));

  const labelOf = (list: any[], key: string) => list?.find((item: any) => item.key === key)?.label ?? key;

  /**
   * L'action qui vient naturellement ensuite, mise en avant.
   *
   * Aligner huit boutons d'etape de meme poids obligeait a relire le graphe a
   * chaque fois. Une action principale, le reste dans un menu : c'est ce que
   * fait le pipeline lui-meme.
   */
  const primaryStage = $derived.by(() => {
    if (!data) return null;
    const order = ['ACTIVE', 'PENDING_APPROVAL', 'NEGOTIATING', 'CONTACTED', 'RENEWAL'];
    return order.find((stage) => nextStages.includes(stage)) ?? null;
  });

  const otherStages = $derived(nextStages.filter((stage) => stage !== primaryStage && stage !== 'BREACHED'));

  /** Ce qui empeche l'activation, dit avant le clic et non apres. */
  const blockers = $derived.by(() => {
    if (!data || data.stage === 'ACTIVE') return [];
    const list: string[] = [];
    const signed = (data.agreements ?? []).some(
      (a: any) => a.state === 'ACCEPTED' && a.acceptedByUs && a.acceptedByPartner,
    );
    if (data.tier === 'CONTRACT' && !signed) list.push(m.ppan_blocker_unsigned());
    if ((data.tier === 'CONTRACT' || settings?.requireDualApproval) && !data.secondApprovedByUserId) {
      list.push(data.approvedByUserId ? m.ppan_blocker_second() : m.ppan_blocker_two());
    }
    return list;
  });

  const failing = $derived((data?.commitments ?? []).filter((c: any) => c.state === 'BREACHED').length);

  async function load() {
    if (!partnershipId) return;
    loading = true;
    try {
      const result = await fetchPartnership(partnershipId);
      data = result?.partnership ?? null;
      report = result?.report ?? null;
      bridged = result?.bridged ?? null;
      nextStages = result?.nextStages ?? [];

      promoChannel = data?.promotions?.[0]?.channelId ?? '';
      promoTitle = data?.promotions?.[0]?.title ?? '';
      promoContent = data?.promotions?.[0]?.content ?? '';

      // La section qui demande attention s'ouvre d'elle-meme ; sinon rien
      // n'est deplie, le resume suffit a la plupart des visites.
      if (openSection === null && failing > 0) openSection = 'commitments';
    } catch (err) {
      toast.error(errorMessage(err) || m.tn_public_error_title());
    } finally {
      loading = false;
    }
  }

  async function run(action: () => Promise<unknown>, success: string) {
    if (busy) return;
    busy = true;
    try {
      await action();
      toast.success(success);
      await load();
      await onchanged();
    } catch (err) {
      toast.error(errorMessage(err) || m.common_action_failed());
    } finally {
      busy = false;
    }
  }

  // ── Ajout ──────────────────────────────────────────────────────────────

  async function resolveInvite() {
    if (lookingUp || !inviteInput.trim()) return;
    lookingUp = true;
    try {
      const result = await lookupPartnerInvite(inviteInput.trim());
      if (!result?.lookup) {
        toast.error(m.ptp_invite_not_found());
        return;
      }
      lookup = result.lookup;
    } catch (err) {
      toast.error(errorMessage(err) || m.common_read_failed());
    } finally {
      lookingUp = false;
    }
  }

  /**
   * Cree le partenariat et bascule le panneau dessus.
   *
   * Pas de recapitulatif avant : ce qui est pose est ecrit sous les cartes,
   * en permanence, et tout reste modifiable dans la foulee. Une etape de
   * confirmation pour un geste reversible n'apporte rien.
   */
  async function add() {
    const name = (lookup?.displayName ?? manualName).trim();
    if (!name) {
      toast.error(m.ptp_link_or_name_required());
      return;
    }

    busy = true;
    try {
      const result = await createPartnershipQuick({
        preset: presetKey,
        partner: {
          displayName: name,
          kind: 'SERVER',
          inviteUrl: inviteInput.trim() || null,
          partnerGuildId: lookup?.guildId ?? null,
          description: lookup?.description ?? null,
          iconUrl: lookup?.iconUrl ?? null,
          bannerUrl: lookup?.bannerUrl ?? null,
          memberCount: lookup?.memberCount ?? null,
        },
      });

      for (const warning of result?.warnings ?? []) toast.error(warning);
      toast.success(m.ptp_partner_added({ name }));
      await onchanged();
      if (result?.partnershipId) onopen(result.partnershipId);
    } catch (err) {
      toast.error(errorMessage(err) || m.common_create_failed());
    } finally {
      busy = false;
    }
  }

  // ── Gestion ────────────────────────────────────────────────────────────

  async function confirmBreak() {
    if (!breakReason.trim()) {
      toast.error(m.ptp_break_reason_required());
      return;
    }
    await run(
      () => setPartnershipStage(partnershipId as string, 'BREACHED', breakReason.trim()),
      m.ppan_ok_broken(),
    );
    breaking = false;
    breakReason = '';
  }

  async function makeGuestLink() {
    if (busy) return;
    busy = true;
    try {
      const result = await createGuestAccess(partnershipId as string, { capability: 'sign', days: 30 });
      if (!result?.token) throw new Error(m.ppan_err_link());
      // Affiche dans le panneau, copiable : la base n'en garde que
      // l'empreinte, il ne sera plus jamais montre.
      guestLink = `${window.location.origin}/partner-portal/${result.token}`;
      await navigator.clipboard?.writeText(guestLink).catch(() => null);
      toast.success(m.ptp_link_created_copied());
    } catch (err) {
      toast.error(errorMessage(err) || m.ptp_link_create_failed());
    } finally {
      busy = false;
    }
  }

  function toggleSection(key: string) {
    openSection = openSection === key ? null : key;
  }

  function money(cents: number, currency = 'EUR'): string {
    return new Intl.NumberFormat(dateLocale(), { style: 'currency', currency }).format(cents / 100);
  }

  function date(value: string | null | undefined): string {
    return value ? new Date(value).toLocaleDateString(dateLocale(), { day: '2-digit', month: 'short' }) : '-';
  }

  const toneOf: Record<string, string> = {
    neutral: 'bg-surface-container text-on-surface-variant',
    info: 'bg-primary/10 text-primary',
    success: 'bg-success/10 text-success',
    warning: 'bg-warning/10 text-warning',
    danger: 'bg-error/10 text-error',
  };

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && !busy) onclose();
  }

  onMount(() => {
    void load();
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });

  // Changer de dossier sans fermer le panneau : le pipeline reste cliquable
  // derriere, et passer d'un partenaire a l'autre ne doit pas demander deux
  // gestes.
  $effect(() => {
    if (partnershipId) {
      openSection = null;
      breaking = false;
      guestLink = null;
      void load();
    }
  });
</script>

<!-- Voile : ferme au clic, sans bloquer la lecture du pipeline derriere. -->
<div
  class="fixed inset-0 z-40 bg-black/20"
  role="button"
  tabindex="-1"
  aria-label={m.ppan_close_panel()}
  onclick={() => !busy && onclose()}
  onkeydown={(event) => event.key === 'Enter' && onclose()}
></div>

<aside
  class="fixed right-0 top-0 bottom-0 z-50 w-full sm:w-[420px] bg-surface-container-lowest border-l border-outline-variant flex flex-col animate-in slide-in-from-right duration-200"
>
  <!-- ── Entete ─────────────────────────────────────────────────────── -->
  <header class="px-4 py-3 border-b border-outline-variant/30 flex items-start gap-3">
    {#if creating}
      <div class="min-w-0 flex-1">
        <p class="text-sm font-semibold text-on-surface">{m.ppan_add_title()}</p>
        <p class="text-2xs text-on-surface-variant">{m.ppan_add_desc()}</p>
      </div>
    {:else if data}
      {#if data.partner.iconUrl}
        <img src={data.partner.iconUrl} alt="" class="w-9 h-9 rounded-lg object-cover shrink-0" />
      {:else}
        <div class="w-9 h-9 rounded-lg bg-surface-container grid place-items-center shrink-0">
          <Papicon icon="server" size={15} />
        </div>
      {/if}
      <div class="min-w-0 flex-1">
        <p class="text-sm font-semibold text-on-surface truncate">{data.partner.displayName}</p>
        <p class="text-2xs text-on-surface-variant truncate">
          {typeMeta?.label ?? data.type} · {m.ppan_tier({ tier: tierMeta?.label ?? data.tier })}
        </p>
      </div>
    {/if}

    <button class="text-on-surface-variant hover:text-on-surface shrink-0" onclick={onclose} aria-label={m.common_close()}>
      <Papicon icon="x" size={16} />
    </button>
  </header>

  <div class="flex-1 overflow-y-auto px-4 py-3 space-y-3">
    {#if creating}
      <!-- ── Ajout ───────────────────────────────────────────────────── -->
      <label class="block">
        <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">{m.ppan_invite_link()}</span>
        <div class="flex gap-2">
          <div class="flex-1">
            <FormInput bind:value={inviteInput} placeholder="discord.gg/…" />
          </div>
          <ActionButton
            variant="neutral"
            size="sm"
            icon="search"
            label={lookingUp ? '…' : m.ppan_read()}
            onclick={resolveInvite}
          />
        </div>
      </label>

      {#if lookup}
        <div class="rounded-xl border border-outline-variant/20 bg-surface-container-low/60 px-3 py-2.5 flex items-center gap-3">
          {#if lookup.iconUrl}
            <img src={lookup.iconUrl} alt="" class="w-9 h-9 rounded-lg object-cover" />
          {/if}
          <div class="min-w-0">
            <p class="text-body-sm font-medium text-on-surface truncate">{lookup.displayName}</p>
            <p class="text-2xs text-on-surface-variant">
              {#if lookup.memberCount}{m.ppan_members({ count: lookup.memberCount.toLocaleString(dateLocale()) })}{/if}
              {#if !lookup.permanent} · {m.ppan_temporary_link()}{/if}
            </p>
          </div>
        </div>
      {:else}
        <label class="block">
          <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">
            {m.ppan_or_name()}
          </span>
          <FormInput bind:value={manualName} placeholder={m.ppan_partner_name()} />
        </label>
      {/if}

      <div class="pt-1">
        <p class="text-2xs font-bold text-on-surface-variant/80 mb-1.5">{m.ppan_which()}</p>
        <div class="space-y-1.5">
          {#each presets as item (item.key)}
            <button
              class="w-full text-left rounded-xl border px-3 py-2 transition-colors {presetKey === item.key
                ? 'border-primary bg-primary/5'
                : 'border-outline-variant/20 hover:bg-surface-container'}"
              onclick={() => (presetKey = item.key)}
            >
              <p class="text-xs font-medium text-on-surface flex items-center gap-1.5">
                <Papicon icon={item.icon} size={13} />
                {item.label}
              </p>
              {#if presetKey === item.key}
                <!-- Ce que ca pose n'apparait que sur la carte choisie : six
                     descriptions depliees noieraient le choix lui-meme. -->
                <p class="text-2xs text-on-surface-variant mt-1">{item.description}</p>
              {/if}
            </button>
          {/each}
        </div>
      </div>

      {#if preset}
        <p class="text-2xs text-on-surface-variant">
          {preset.trackInvite
            ? m.ppan_preset_summary_invite({ commitments: preset.commitments.length, benefits: preset.benefits.length })
            : m.ppan_preset_summary({ commitments: preset.commitments.length, benefits: preset.benefits.length })}
        </p>
      {/if}
    {:else if loading && !data}
      <p class="text-xs text-on-surface-variant">{m.ppan_loading()}</p>
    {:else if data}
      <!-- ── Etat et action principale ──────────────────────────────── -->
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-2xs px-2 py-0.5 rounded-full font-semibold {toneOf[stageMeta?.tone] ?? toneOf.neutral}">
          {stageMeta?.label ?? data.stage}
        </span>
        <span class="text-2xs text-on-surface-variant">{m.ppan_health_score({ score: data.healthScore })}</span>
        {#if bridged}
          <span class="text-2xs text-primary inline-flex items-center gap-1">
            <Papicon icon="link" size={11} />{m.ppan_bridge()}
          </span>
        {/if}
      </div>

      {#if blockers.length > 0}
        <div class="rounded-lg bg-warning/10 px-3 py-2">
          <p class="text-2xs text-warning">
            {m.ppan_before_activating({ list: blockers.join(' · ') })}
          </p>
        </div>
      {/if}

      <div class="flex flex-wrap gap-2">
        {#if primaryStage}
          <ActionButton
            variant="primary"
            size="sm"
            label={labelOf(catalog?.stages ?? [], primaryStage)}
            onclick={() => run(() => setPartnershipStage(partnershipId as string, primaryStage), m.ppan_ok_stage())}
          />
        {/if}
        {#if !data.secondApprovedByUserId}
          <ActionButton
            variant="neutral"
            size="sm"
            icon="check"
            label={m.ppan_approve()}
            onclick={() => run(() => approvePartnership(partnershipId as string), m.ppan_ok_approved())}
          />
        {/if}
        {#if otherStages.length > 0}
          <FormSelect
            value=""
            className="text-xs"
            onchange={(event) => {
              const target = event.target as HTMLSelectElement;
              if (target.value) {
                void run(() => setPartnershipStage(partnershipId as string, target.value), m.ppan_ok_stage());
                target.value = '';
              }
            }}
          >
            <option value="">{m.ppan_other_stage()}</option>
            {#each otherStages as stage (stage)}
              <option value={stage}>{labelOf(catalog?.stages ?? [], stage)}</option>
            {/each}
          </FormSelect>
        {/if}
      </div>

      {#if nextStages.includes('BREACHED')}
        {#if breaking}
          <!-- Le motif se saisit ici. L'ancienne version passait par une boite
               du navigateur : sans contexte, sans annulation propre. -->
          <div class="rounded-lg border border-error/30 bg-error/5 px-3 py-2.5 space-y-2">
            <p class="text-xs text-error font-medium">{m.ppan_break()}</p>
            <p class="text-2xs text-on-surface-variant">
              {m.ppan_break_desc()}
            </p>
            <FormTextarea bind:value={breakReason} rows={2} placeholder={m.ppan_break_reason()} />
            <div class="flex gap-2">
              <ActionButton variant="danger" size="sm" label={m.ppan_break_confirm()} onclick={confirmBreak} />
              <ActionButton variant="neutral" size="sm" label={m.common_cancel()} onclick={() => (breaking = false)} />
            </div>
          </div>
        {:else}
          <button class="text-2xs text-error hover:underline" onclick={() => (breaking = true)}>
            {m.ppan_break()}
          </button>
        {/if}
      {/if}

      <!-- ── Chiffres ───────────────────────────────────────────────── -->
      <div class="grid grid-cols-3 gap-2">
        {#each [['Arrivees', report?.joins ?? 0], ['Restes', report?.stillHere ?? 0], ['Retention', report?.retentionRate == null ? '-' : `${report.retentionRate}%`]] as [label, value] (label)}
          <div class="rounded-lg bg-surface-container px-2 py-1.5 text-center">
            <div class="text-sm font-semibold text-on-surface tabular-nums">{value}</div>
            <div class="text-2xs text-on-surface-variant">{label}</div>
          </div>
        {/each}
      </div>

      {#if data.inviteCode}
        <p class="text-2xs text-on-surface-variant">Invitation dediee : discord.gg/{data.inviteCode}</p>
      {:else}
        <button
          class="text-2xs text-primary hover:underline"
          onclick={() => run(() => ensurePartnershipInvite(partnershipId as string), m.ppan_ok_invite())}
        >
          {m.ppan_create_invite()}
        </button>
      {/if}

      <!-- ── Sections ───────────────────────────────────────────────── -->
      {#snippet section(key: string, title: string, summary: string, alert = false)}
        <button
          class="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg {openSection === key
            ? 'bg-surface-container'
            : 'hover:bg-surface-container-low/60'}"
          onclick={() => toggleSection(key)}
        >
          <span class="min-w-0 text-left">
            <span class="text-xs text-on-surface block">{title}</span>
            <span class="text-2xs {alert ? 'text-warning' : 'text-on-surface-variant'} block truncate">
              {summary}
            </span>
          </span>
          <Papicon icon={openSection === key ? 'chevron-up' : 'chevron-down'} size={14} class="shrink-0" />
        </button>
      {/snippet}

      <div class="space-y-1 pt-1 border-t border-outline-variant/10">
        {@render section(
          'commitments',
          m.ppan_commitments(),
          failing > 0
            ? m.ppan_commitments_failing({ count: data.commitments.length, failing })
            : m.ppan_commitments_count({ count: data.commitments.length }),
          failing > 0,
        )}

        {#if openSection === 'commitments'}
          <div class="px-3 pb-2 space-y-2">
            {#each data.commitments ?? [] as commitment (commitment.id)}
              <div class="flex items-start justify-between gap-2">
                <span class="text-xs text-on-surface min-w-0">
                  <span class="block truncate">
                    {commitment.label ?? labelOf(catalog?.commitments ?? [], commitment.kind)}
                  </span>
                  <span class="text-2xs text-on-surface-variant">
                    {commitment.party === 'US' ? m.ppan_party_us() : commitment.party === 'BOTH' ? m.ppan_party_both() : m.ppan_party_them()}
                    {#if commitment.targetCount} · {commitment.targetCount}/{commitment.targetPeriod}{/if}
                  </span>
                </span>
                <span class="flex items-center gap-1.5 shrink-0">
                  <button
                    class="text-2xs {commitment.state === 'BREACHED' ? 'text-error' : 'text-success'} hover:underline"
                    onclick={() =>
                      run(
                        () =>
                          setCommitmentState(partnershipId as string, commitment.id, {
                            state: commitment.state === 'BREACHED' ? 'FULFILLED' : 'BREACHED',
                          }),
                        m.ppan_ok_marked(),
                      )}
                  >
                    {commitment.state === 'BREACHED' ? m.ppan_not_met() : m.ppan_met()}
                  </button>
                  <button
                    class="text-on-surface-variant hover:text-error"
                    aria-label={m.ppan_remove()}
                    onclick={() => run(() => removeCommitment(partnershipId as string, commitment.id), m.ppan_ok_removed())}
                  >
                    <Papicon icon="x" size={11} />
                  </button>
                </span>
              </div>
            {/each}

            <div class="flex gap-1.5 items-end pt-1">
              <div class="flex-1">
                <FormSelect bind:value={commitmentKind} className="w-full text-xs">
                  {#each catalog?.commitments ?? [] as item (item.key)}
                    <option value={item.key}>{item.label}</option>
                  {/each}
                </FormSelect>
              </div>
              <div class="w-14">
                <FormInput type="number" bind:value={commitmentCount} />
              </div>
              <div class="w-24">
                <FormSelect bind:value={commitmentPeriod} className="w-full text-xs">
                  <option value="week">{m.ppan_per_week()}</option>
                  <option value="month">{m.ppan_per_month()}</option>
                  <option value="total">{m.ppan_in_total()}</option>
                </FormSelect>
              </div>
              <ActionButton
                variant="neutral"
                size="sm"
                icon="plus"
                label=""
                onclick={() =>
                  run(
                    () =>
                      addPartnershipCommitment(partnershipId as string, {
                        kind: commitmentKind,
                        targetCount: Number(commitmentCount),
                        targetPeriod: commitmentPeriod,
                      }),
                    m.ppan_ok_commitment(),
                  )}
              />
            </div>
          </div>
        {/if}

        {@render section(
          'benefits',
          m.ppan_benefits(),
          m.ppan_benefits_count({ count: (data.benefits ?? []).length, applied: (data.benefits ?? []).filter((b: any) => b.state === 'APPLIED').length }),
        )}

        {#if openSection === 'benefits'}
          <div class="px-3 pb-2 space-y-2">
            {#each data.benefits ?? [] as benefit (benefit.id)}
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs text-on-surface min-w-0 truncate">
                  {labelOf(catalog?.benefits ?? [], benefit.kind)}
                  <span class="text-on-surface-variant">· {benefit.state.toLowerCase()}</span>
                </span>
                <button
                  class="text-on-surface-variant hover:text-error shrink-0"
                  aria-label={m.ppan_remove()}
                  onclick={() => run(() => removePartnershipBenefit(partnershipId as string, benefit.id), m.ppan_ok_removed())}
                >
                  <Papicon icon="x" size={11} />
                </button>
              </div>
            {/each}

            <div class="flex gap-1.5 items-end pt-1">
              <div class="flex-1">
                <FormSelect bind:value={benefitKind} className="w-full text-xs">
                  {#each catalog?.benefits ?? [] as item (item.key)}
                    <option value={item.key}>{item.label}</option>
                  {/each}
                </FormSelect>
              </div>
              <div class="flex-1">
                <FormSelect bind:value={benefitTarget} className="w-full text-xs">
                  <option value="">{m.ppan_default()}</option>
                  {#each roles as role (role.id)}
                    <option value={role.id}>@{role.name}</option>
                  {/each}
                  {#each channels as channel (channel.id)}
                    <option value={channel.id}>#{channel.name}</option>
                  {/each}
                </FormSelect>
              </div>
              <ActionButton
                variant="neutral"
                size="sm"
                icon="plus"
                label=""
                onclick={() =>
                  run(
                    () =>
                      addPartnershipBenefit(partnershipId as string, {
                        kind: benefitKind,
                        targetRef: benefitTarget || null,
                      }),
                    m.ppan_ok_benefit(),
                  )}
              />
            </div>

            <div class="flex gap-2">
              <ActionButton
                variant="neutral"
                size="sm"
                label={m.ppan_apply()}
                onclick={() => run(() => applyPartnershipBenefits(partnershipId as string), m.ppan_ok_applied())}
              />
              <ActionButton
                variant="neutral"
                size="sm"
                label={m.ppan_remove_all()}
                onclick={() => run(() => revokePartnershipBenefits(partnershipId as string), m.ppan_ok_revoked())}
              />
            </div>
            <p class="text-2xs text-on-surface-variant">
              {m.ppan_revoke_note()}
            </p>
          </div>
        {/if}

        {@render section(
          'promo',
          m.ppan_promo(),
          m.ppan_promo_count({ count: (data.promotions ?? []).reduce((total: number, p: any) => total + p.postCount, 0) }),
        )}

        {#if openSection === 'promo'}
          <div class="px-3 pb-2 space-y-2">
            <FormInput bind:value={promoTitle} placeholder={m.ppan_promo_title()} />
            <FormTextarea bind:value={promoContent} rows={3} placeholder={m.ppan_promo_text()} />
            <FormSelect bind:value={promoChannel} className="w-full text-xs">
              <option value="">{m.ppan_promo_channel()}</option>
              {#each channels as channel (channel.id)}
                <option value={channel.id}>#{channel.name}</option>
              {/each}
            </FormSelect>

            <div class="flex gap-2">
              <ActionButton
                variant="neutral"
                size="sm"
                icon="save"
                label={m.common_save()}
                onclick={() =>
                  run(
                    () =>
                      savePartnershipPromotion(partnershipId as string, {
                        id: data.promotions?.[0]?.id,
                        title: promoTitle,
                        content: promoContent,
                        channelId: promoChannel || null,
                      }),
                    m.ppan_ok_promo_saved(),
                  )}
              />
              {#if data.promotions?.[0]}
                <ActionButton
                  variant="neutral"
                  size="sm"
                  icon="send"
                  label={m.ppan_publish()}
                  onclick={() =>
                    run(
                      () => publishPartnershipPromotion(partnershipId as string, data.promotions[0].id),
                      m.ppan_ok_published(),
                    )}
                />
              {/if}
            </div>

            {#if onsetting && settings}
              <label class="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.autoPublishAds}
                  onchange={() => onsetting?.({ autoPublishAds: !settings.autoPublishAds })}
                />
                <span class="text-2xs text-on-surface">{m.ppan_auto_publish()}</span>
              </label>
            {/if}

            <p class="text-2xs text-on-surface-variant">
              {m.ppan_mentions_note()}
            </p>
          </div>
        {/if}

        {#if data.tier === 'CONTRACT' || (data.payments ?? []).length > 0}
          {@render section(
            'contract',
            m.ppan_contract(),
            m.ppan_contract_count({ versions: (data.agreements ?? []).length, payments: (data.payments ?? []).length }),
          )}

          {#if openSection === 'contract'}
            <div class="px-3 pb-2 space-y-2">
              {#each data.agreements ?? [] as agreement (agreement.id)}
                <div class="flex items-center justify-between gap-2">
                  <span class="text-xs text-on-surface">
                    v{agreement.version} · {agreement.state.toLowerCase()}
                    {#if agreement.acceptedByUs}· {m.ppan_us()}{/if}{#if agreement.acceptedByPartner}· {m.ppan_them()}{/if}
                  </span>
                  {#if agreement.state === 'DRAFT'}
                    <button
                      class="text-2xs text-primary hover:underline"
                      onclick={() =>
                        run(() => agreementAction(partnershipId as string, agreement.id, 'propose'), m.ppan_ok_proposed())}
                    >
                      {m.ppan_propose()}
                    </button>
                  {:else if agreement.state === 'PROPOSED' && !agreement.acceptedByUs}
                    <button
                      class="text-2xs text-primary hover:underline"
                      onclick={() =>
                        run(() => agreementAction(partnershipId as string, agreement.id, 'accept'), m.ppan_ok_accepted())}
                    >
                      {m.ppan_accept()}
                    </button>
                  {/if}
                </div>
              {/each}

              <FormTextarea bind:value={agreementDraft} rows={2} placeholder={m.ppan_agreement_text()} />
              <ActionButton
                variant="neutral"
                size="sm"
                label={m.ppan_draft()}
                onclick={() =>
                  run(async () => {
                    if (!agreementDraft.trim()) throw new Error(m.ppan_err_empty_text());
                    await draftPartnershipAgreement(partnershipId as string, agreementDraft.trim());
                    agreementDraft = '';
                  }, m.ppan_ok_drafted())}
              />

              <div class="pt-2 border-t border-outline-variant/10 space-y-2">
                {#each data.payments ?? [] as payment (payment.id)}
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-xs text-on-surface">
                      {money(payment.amountCents, payment.currency)} · {date(payment.dueAt)} ·
                      {payment.status.toLowerCase()}
                    </span>
                    {#if payment.status !== 'RECEIVED'}
                      <button
                        class="text-2xs text-success hover:underline"
                        onclick={() =>
                          run(
                            () => settlePartnershipPayment(partnershipId as string, payment.id, {}),
                            m.ppan_ok_payment(),
                          )}
                      >
                        {m.ppan_received()}
                      </button>
                    {/if}
                  </div>
                {/each}

                <div class="flex gap-1.5 items-end">
                  <div class="flex-1">
                    <FormInput bind:value={paymentAmount} placeholder={m.ppan_amount()} />
                  </div>
                  <div class="flex-1">
                    <FormInput type="date" bind:value={paymentDue} />
                  </div>
                  <ActionButton
                    variant="neutral"
                    size="sm"
                    icon="plus"
                    label=""
                    onclick={() =>
                      run(async () => {
                        const euros = Number(String(paymentAmount).replace(',', '.'));
                        if (!Number.isFinite(euros) || euros <= 0) throw new Error(m.ppan_err_amount());
                        if (!paymentDue) throw new Error(m.ppan_err_date());
                        // Saisi en euros, stocke en centimes : demander des
                        // centimes a l'ecran etait une source d'erreur de
                        // facteur cent.
                        await addPartnershipPayment(partnershipId as string, {
                          amountCents: Math.round(euros * 100),
                          dueAt: new Date(paymentDue).toISOString(),
                        });
                        paymentAmount = '';
                        paymentDue = '';
                      }, m.ppan_ok_due())}
                  />
                </div>
              </div>
            </div>
          {/if}
        {/if}

        {@render section('journal', m.ppan_journal(), m.ppan_journal_count({ count: (data.events ?? []).length }))}

        {#if openSection === 'journal'}
          <div class="px-3 pb-2 space-y-2">
            <div class="flex gap-1.5 items-end">
              <div class="flex-1">
                <FormTextarea bind:value={noteDraft} rows={2} placeholder={m.ppan_note()} />
              </div>
              <ActionButton
                variant="neutral"
                size="sm"
                icon="plus"
                label=""
                onclick={() =>
                  run(async () => {
                    if (!noteDraft.trim()) throw new Error(m.ppan_err_empty_note());
                    await addPartnershipNote(partnershipId as string, { body: noteDraft.trim() });
                    noteDraft = '';
                  }, m.ppan_ok_note())}
              />
            </div>

            {#each data.notes ?? [] as note (note.id)}
              <div class="rounded-lg bg-warning/5 px-2.5 py-1.5">
                <p class="text-2xs text-on-surface whitespace-pre-wrap">{note.body}</p>
              </div>
            {/each}

            {#each (data.events ?? []).slice(0, 20) as event (event.id)}
              <p class="text-2xs text-on-surface-variant">
                <span class="tabular-nums">{date(event.createdAt)}</span> · {event.summary}
              </p>
            {/each}
          </div>
        {/if}
      </div>

      <!-- ── Outils ─────────────────────────────────────────────────── -->
      <div class="pt-2 border-t border-outline-variant/10 space-y-2">
        <div class="flex flex-wrap gap-1.5">
          <ActionButton
            variant="neutral"
            size="sm"
            label={m.ppan_check()}
            onclick={() => run(() => checkPartnershipReciprocity(partnershipId as string), m.ppan_ok_checked())}
          />
          <ActionButton
            variant="neutral"
            size="sm"
            label={m.ppan_showcase()}
            onclick={() => run(() => refreshPartnershipShowcase(partnershipId as string), m.ppan_ok_showcase())}
          />
          <ActionButton
            variant="neutral"
            size="sm"
            label={m.ppan_health()}
            onclick={() => run(() => refreshPartnershipHealth(partnershipId as string), m.ppan_ok_health())}
          />
          <ActionButton variant="neutral" size="sm" label={m.ppan_guest_link()} onclick={makeGuestLink} />
        </div>

        {#if guestLink}
          <div class="rounded-lg bg-primary/5 border border-primary/20 px-3 py-2">
            <p class="text-2xs text-on-surface-variant mb-1">
              {m.ppan_guest_link_note()}
            </p>
            <p class="text-2xs text-on-surface break-all">{guestLink}</p>
          </div>
        {/if}

        {#if onsetting && settings}
          <label class="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.reciprocityChecks}
              onchange={() => onsetting?.({ reciprocityChecks: !settings.reciprocityChecks })}
            />
            <span class="text-2xs text-on-surface">
              {m.ppan_auto_check({ hours: settings.reciprocityIntervalHours })}
            </span>
          </label>
        {/if}
      </div>
    {/if}
  </div>

  {#if creating}
    <footer class="px-4 py-3 border-t border-outline-variant/30 flex justify-end gap-2">
      <ActionButton variant="neutral" size="sm" label={m.common_cancel()} onclick={onclose} />
      <ActionButton variant="primary" size="sm" label={busy ? m.ppan_adding() : m.ppan_add()} onclick={add} />
    </footer>
  {/if}
</aside>
