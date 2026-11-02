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
    if (data.tier === 'CONTRACT' && !signed) list.push("Accord non signe par les deux parties");
    if ((data.tier === 'CONTRACT' || settings?.requireDualApproval) && !data.secondApprovedByUserId) {
      list.push(data.approvedByUserId ? 'Seconde validation attendue' : 'Deux validations attendues');
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
      toast.error(errorMessage(err) || 'Chargement impossible');
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
      toast.error(errorMessage(err) || 'Action impossible');
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
      toast.error(errorMessage(err) || 'Lecture impossible');
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
      toast.error(errorMessage(err) || 'Creation impossible');
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
      'Partenariat rompu',
    );
    breaking = false;
    breakReason = '';
  }

  async function makeGuestLink() {
    if (busy) return;
    busy = true;
    try {
      const result = await createGuestAccess(partnershipId as string, { capability: 'sign', days: 30 });
      if (!result?.token) throw new Error('Lien non cree');
      // Affiche dans le panneau, copiable : la base n'en garde que
      // l'empreinte, il ne sera plus jamais montre.
      guestLink = `${window.location.origin}/partner-portal/${result.token}`;
      await navigator.clipboard?.writeText(guestLink).catch(() => null);
      toast.success(m.ptp_link_created_copied());
    } catch (err) {
      toast.error(errorMessage(err) || 'Creation du lien impossible');
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
  aria-label="Fermer le panneau"
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
        <p class="text-sm font-semibold text-on-surface">Ajouter un partenaire</p>
        <p class="text-2xs text-on-surface-variant">Un lien suffit, le reste se regle apres</p>
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
          {typeMeta?.label ?? data.type} · suivi {tierMeta?.label ?? data.tier}
        </p>
      </div>
    {/if}

    <button class="text-on-surface-variant hover:text-on-surface shrink-0" onclick={onclose} aria-label="Fermer">
      <Papicon icon="x" size={16} />
    </button>
  </header>

  <div class="flex-1 overflow-y-auto px-4 py-3 space-y-3">
    {#if creating}
      <!-- ── Ajout ───────────────────────────────────────────────────── -->
      <label class="block">
        <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">Lien d'invitation</span>
        <div class="flex gap-2">
          <div class="flex-1">
            <FormInput bind:value={inviteInput} placeholder="discord.gg/…" />
          </div>
          <ActionButton
            variant="neutral"
            size="sm"
            icon="search"
            label={lookingUp ? '…' : 'Lire'}
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
              {#if lookup.memberCount}{lookup.memberCount.toLocaleString('fr-FR')} membres{/if}
              {#if !lookup.permanent} · lien temporaire{/if}
            </p>
          </div>
        </div>
      {:else}
        <label class="block">
          <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">
            ou simplement leur nom
          </span>
          <FormInput bind:value={manualName} placeholder="Nom du partenaire" />
        </label>
      {/if}

      <div class="pt-1">
        <p class="text-2xs font-bold text-on-surface-variant/80 mb-1.5">Quel partenariat</p>
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
          Pose {preset.commitments.length} engagement(s), {preset.benefits.length} avantage(s){preset.trackInvite
            ? ' et une invitation dediee'
            : ''}. Le dossier s'ouvre en piste, rien n'est applique avant activation.
        </p>
      {/if}
    {:else if loading && !data}
      <p class="text-xs text-on-surface-variant">Chargement…</p>
    {:else if data}
      <!-- ── Etat et action principale ──────────────────────────────── -->
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-2xs px-2 py-0.5 rounded-full font-semibold {toneOf[stageMeta?.tone] ?? toneOf.neutral}">
          {stageMeta?.label ?? data.stage}
        </span>
        <span class="text-2xs text-on-surface-variant">Sante {data.healthScore}/100</span>
        {#if bridged}
          <span class="text-2xs text-primary inline-flex items-center gap-1">
            <Papicon icon="link" size={11} />pont
          </span>
        {/if}
      </div>

      {#if blockers.length > 0}
        <div class="rounded-lg bg-warning/10 px-3 py-2">
          <p class="text-2xs text-warning">
            Avant d'activer : {blockers.join(' · ')}
          </p>
        </div>
      {/if}

      <div class="flex flex-wrap gap-2">
        {#if primaryStage}
          <ActionButton
            variant="primary"
            size="sm"
            label={labelOf(catalog?.stages ?? [], primaryStage)}
            onclick={() => run(() => setPartnershipStage(partnershipId as string, primaryStage), 'Etape mise a jour')}
          />
        {/if}
        {#if !data.secondApprovedByUserId}
          <ActionButton
            variant="neutral"
            size="sm"
            icon="check"
            label="Valider"
            onclick={() => run(() => approvePartnership(partnershipId as string), 'Validation posee')}
          />
        {/if}
        {#if otherStages.length > 0}
          <FormSelect
            value=""
            className="text-xs"
            onchange={(event) => {
              const target = event.target as HTMLSelectElement;
              if (target.value) {
                void run(() => setPartnershipStage(partnershipId as string, target.value), 'Etape mise a jour');
                target.value = '';
              }
            }}
          >
            <option value="">Autre etape…</option>
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
            <p class="text-xs text-error font-medium">Rompre ce partenariat</p>
            <p class="text-2xs text-on-surface-variant">
              Les avantages sont retires, la vitrine depubliee. Le motif est conserve dans l'historique du
              partenaire.
            </p>
            <FormTextarea bind:value={breakReason} rows={2} placeholder="Motif de la rupture" />
            <div class="flex gap-2">
              <ActionButton variant="danger" size="sm" label="Confirmer la rupture" onclick={confirmBreak} />
              <ActionButton variant="neutral" size="sm" label="Annuler" onclick={() => (breaking = false)} />
            </div>
          </div>
        {:else}
          <button class="text-2xs text-error hover:underline" onclick={() => (breaking = true)}>
            Rompre ce partenariat
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
          onclick={() => run(() => ensurePartnershipInvite(partnershipId as string), 'Invitation creee')}
        >
          Creer l'invitation qui compte leurs arrivees
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
          'Engagements',
          failing > 0
            ? `${data.commitments.length} engagement(s), ${failing} non tenu(s)`
            : `${data.commitments.length} engagement(s)`,
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
                    {commitment.party === 'US' ? 'a notre charge' : commitment.party === 'BOTH' ? 'des deux cotes' : 'a leur charge'}
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
                        'Pointe',
                      )}
                  >
                    {commitment.state === 'BREACHED' ? 'non tenu' : 'tenu'}
                  </button>
                  <button
                    class="text-on-surface-variant hover:text-error"
                    aria-label="Retirer"
                    onclick={() => run(() => removeCommitment(partnershipId as string, commitment.id), 'Retire')}
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
                  <option value="week">/semaine</option>
                  <option value="month">/mois</option>
                  <option value="total">au total</option>
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
                    'Engagement ajoute',
                  )}
              />
            </div>
          </div>
        {/if}

        {@render section(
          'benefits',
          'Avantages',
          `${(data.benefits ?? []).length} avantage(s) · ${(data.benefits ?? []).filter((b: any) => b.state === 'APPLIED').length} applique(s)`,
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
                  aria-label="Retirer"
                  onclick={() => run(() => removePartnershipBenefit(partnershipId as string, benefit.id), 'Retire')}
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
                  <option value="">Par defaut</option>
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
                    'Avantage ajoute',
                  )}
              />
            </div>

            <div class="flex gap-2">
              <ActionButton
                variant="neutral"
                size="sm"
                label="Appliquer"
                onclick={() => run(() => applyPartnershipBenefits(partnershipId as string), 'Avantages appliques')}
              />
              <ActionButton
                variant="neutral"
                size="sm"
                label="Tout retirer"
                onclick={() => run(() => revokePartnershipBenefits(partnershipId as string), 'Avantages retires')}
              />
            </div>
            <p class="text-2xs text-on-surface-variant">
              Ce qui existait avant le partenariat n'est jamais retire.
            </p>
          </div>
        {/if}

        {@render section(
          'promo',
          'Publicite',
          `${(data.promotions ?? []).reduce((total: number, p: any) => total + p.postCount, 0)} publication(s)`,
        )}

        {#if openSection === 'promo'}
          <div class="px-3 pb-2 space-y-2">
            <FormInput bind:value={promoTitle} placeholder="Titre de l'annonce" />
            <FormTextarea bind:value={promoContent} rows={3} placeholder="Texte fourni par le partenaire" />
            <FormSelect bind:value={promoChannel} className="w-full text-xs">
              <option value="">Salon des publicites</option>
              {#each channels as channel (channel.id)}
                <option value={channel.id}>#{channel.name}</option>
              {/each}
            </FormSelect>

            <div class="flex gap-2">
              <ActionButton
                variant="neutral"
                size="sm"
                icon="save"
                label="Enregistrer"
                onclick={() =>
                  run(
                    () =>
                      savePartnershipPromotion(partnershipId as string, {
                        id: data.promotions?.[0]?.id,
                        title: promoTitle,
                        content: promoContent,
                        channelId: promoChannel || null,
                      }),
                    'Publicite enregistree',
                  )}
              />
              {#if data.promotions?.[0]}
                <ActionButton
                  variant="neutral"
                  size="sm"
                  icon="send"
                  label="Publier"
                  onclick={() =>
                    run(
                      () => publishPartnershipPromotion(partnershipId as string, data.promotions[0].id),
                      'Publiee',
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
                <span class="text-2xs text-on-surface">Publier automatiquement, pour tous les partenaires</span>
              </label>
            {/if}

            <p class="text-2xs text-on-surface-variant">
              Les mentions sont neutralisees a la publication.
            </p>
          </div>
        {/if}

        {#if data.tier === 'CONTRACT' || (data.payments ?? []).length > 0}
          {@render section(
            'contract',
            'Accord et echeances',
            `${(data.agreements ?? []).length} version(s) · ${(data.payments ?? []).length} echeance(s)`,
          )}

          {#if openSection === 'contract'}
            <div class="px-3 pb-2 space-y-2">
              {#each data.agreements ?? [] as agreement (agreement.id)}
                <div class="flex items-center justify-between gap-2">
                  <span class="text-xs text-on-surface">
                    v{agreement.version} · {agreement.state.toLowerCase()}
                    {#if agreement.acceptedByUs}· nous{/if}{#if agreement.acceptedByPartner}· eux{/if}
                  </span>
                  {#if agreement.state === 'DRAFT'}
                    <button
                      class="text-2xs text-primary hover:underline"
                      onclick={() =>
                        run(() => agreementAction(partnershipId as string, agreement.id, 'propose'), 'Proposee')}
                    >
                      proposer
                    </button>
                  {:else if agreement.state === 'PROPOSED' && !agreement.acceptedByUs}
                    <button
                      class="text-2xs text-primary hover:underline"
                      onclick={() =>
                        run(() => agreementAction(partnershipId as string, agreement.id, 'accept'), 'Acceptee')}
                    >
                      accepter
                    </button>
                  {/if}
                </div>
              {/each}

              <FormTextarea bind:value={agreementDraft} rows={2} placeholder="Texte de l'accord" />
              <ActionButton
                variant="neutral"
                size="sm"
                label="Rediger une version"
                onclick={() =>
                  run(async () => {
                    if (!agreementDraft.trim()) throw new Error('Texte vide.');
                    await draftPartnershipAgreement(partnershipId as string, agreementDraft.trim());
                    agreementDraft = '';
                  }, 'Version redigee')}
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
                            'Versement enregistre',
                          )}
                      >
                        recu
                      </button>
                    {/if}
                  </div>
                {/each}

                <div class="flex gap-1.5 items-end">
                  <div class="flex-1">
                    <FormInput bind:value={paymentAmount} placeholder="Montant (€)" />
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
                        if (!Number.isFinite(euros) || euros <= 0) throw new Error('Montant invalide.');
                        if (!paymentDue) throw new Error('Choisis une date.');
                        // Saisi en euros, stocke en centimes : demander des
                        // centimes a l'ecran etait une source d'erreur de
                        // facteur cent.
                        await addPartnershipPayment(partnershipId as string, {
                          amountCents: Math.round(euros * 100),
                          dueAt: new Date(paymentDue).toISOString(),
                        });
                        paymentAmount = '';
                        paymentDue = '';
                      }, 'Echeance ajoutee')}
                  />
                </div>
              </div>
            </div>
          {/if}
        {/if}

        {@render section('journal', 'Journal et notes', `${(data.events ?? []).length} evenement(s)`)}

        {#if openSection === 'journal'}
          <div class="px-3 pb-2 space-y-2">
            <div class="flex gap-1.5 items-end">
              <div class="flex-1">
                <FormTextarea bind:value={noteDraft} rows={2} placeholder="Note interne" />
              </div>
              <ActionButton
                variant="neutral"
                size="sm"
                icon="plus"
                label=""
                onclick={() =>
                  run(async () => {
                    if (!noteDraft.trim()) throw new Error('Note vide.');
                    await addPartnershipNote(partnershipId as string, { body: noteDraft.trim() });
                    noteDraft = '';
                  }, 'Note ajoutee')}
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
            label="Verifier la reciprocite"
            onclick={() => run(() => checkPartnershipReciprocity(partnershipId as string), 'Controle effectue')}
          />
          <ActionButton
            variant="neutral"
            size="sm"
            label="Vitrine"
            onclick={() => run(() => refreshPartnershipShowcase(partnershipId as string), 'Vitrine a jour')}
          />
          <ActionButton
            variant="neutral"
            size="sm"
            label="Sante"
            onclick={() => run(() => refreshPartnershipHealth(partnershipId as string), 'Sante recalculee')}
          />
          <ActionButton variant="neutral" size="sm" label="Lien partenaire" onclick={makeGuestLink} />
        </div>

        {#if guestLink}
          <div class="rounded-lg bg-primary/5 border border-primary/20 px-3 py-2">
            <p class="text-2xs text-on-surface-variant mb-1">
              A transmettre au partenaire. Copie, et affiche une seule fois.
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
              Verifier automatiquement, toutes les {settings.reciprocityIntervalHours} h
            </span>
          </label>
        {/if}
      </div>
    {/if}
  </div>

  {#if creating}
    <footer class="px-4 py-3 border-t border-outline-variant/30 flex justify-end gap-2">
      <ActionButton variant="neutral" size="sm" label="Annuler" onclick={onclose} />
      <ActionButton variant="primary" size="sm" label={busy ? 'Ajout…' : 'Ajouter'} onclick={add} />
    </footer>
  {/if}
</aside>
