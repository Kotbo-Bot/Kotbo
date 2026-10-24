<script lang="ts">
  /**
   * Facturation du serveur.
   *
   * La page ne manipule ni carte bancaire ni montant : elle affiche l'offre en
   * cours, propose les offres supérieures, et redirige vers des pages hébergées
   * par Stripe pour tout le reste. C'est ce qui nous tient hors du périmètre PCI
   * et évite de réimplémenter un formulaire de paiement.
   *
   * Deux états méritent un traitement à part, parce qu'ils arrivent vraiment :
   *   - `enabled: false` - l'instance n'a pas de clé Stripe (auto-hébergé,
   *     white-label). Afficher des boutons qui renverraient 503 serait pire que
   *     de dire clairement que la facturation n'est pas branchée ici.
   *   - `past_due` - le prélèvement a échoué mais l'accès court encore. Le
   *     bandeau doit être visible sans être bloquant : le client a quelques
   *     jours pour corriger sa carte avant la coupure.
   */
  import { onMount } from 'svelte';
  import { fetchBillingStatus, openBillingPortal, startCheckout } from '../lib/api';
  import type { BillingInterval, BillingStatus, PlanCard, PlanKey } from '../lib/api/billing';
  import { toast } from '../lib/stores/toast.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import Callout from '../lib/components/ui/Callout.svelte';
  import Button from '../lib/components/ui/Button.svelte';
  import { confetti } from '../lib/onboarding/celebrate';
  import { m, dateLocale } from '../lib/i18n';

  let status = $state<BillingStatus | null>(null);
  let loading = $state(true);
  let interval = $state<BillingInterval>('month');
  /**
   * Retour de paiement reussi. C'est le moment ou l'on est le plus convaincu
   * du parcours : un simple toast le gaspillait. L'encadre confirme le choix,
   * dit ce qui change, et propose une seule suite.
   */
  let justPaid = $state(false);
  /**
   * Le serveur a grandi au-dela de la tranche de son offre. C'est un des trois
   * moments ou proposer l'offre superieure ne force rien : la limite est
   * franchie, on dit ce que l'offre adaptee lui apporte au lieu de bloquer.
   */
  const outgrown = $derived.by(() => {
    if (!status?.hasSubscription || !status.eligiblePlan) return null;
    if (rank(status.eligiblePlan) <= rank(currentPlan)) return null;
    const current = (status.plans ?? []).find((plan) => plan.key === currentPlan);
    const next = (status.plans ?? []).find((plan) => plan.key === status?.eligiblePlan);
    if (!current?.memberRange || !next) return null;
    return { current, next, members: status.memberCount ?? null };
  });

  const paidPlan = $derived((status?.plans ?? []).find((plan) => plan.key === status?.plan && plan.key !== 'FREE') ?? null);

  /** Offre dont le bouton est en cours de traitement, pour ne pas figer toute la page. */
  let pending = $state<PlanKey | 'portal' | null>(null);

  const PLAN_ORDER: PlanKey[] = ['FREE', 'PLUS', 'PRO', 'ULTIMATE', 'CUSTOM'];

  const currentPlan = $derived(status?.plan ?? 'FREE');
  const orderedPlans = $derived(
    (status?.plans ?? []).slice().sort((a, b) => PLAN_ORDER.indexOf(a.key) - PLAN_ORDER.indexOf(b.key)),
  );

  /**
   * Économie annuelle affichée sur le sélecteur. La remise n'est pas la même
   * d'un palier à l'autre : on annonce donc la **plus faible**, qui est vraie
   * pour tout le monde. Prendre celle d'une offre en particulier promettrait
   * à certains serveurs une remise qu'ils ne verraient pas sur leur carte.
   */
  const yearlySavingPercent = $derived.by(() => {
    const savings = (status?.plans ?? [])
      .map((p) => p.priceCents)
      .filter((price): price is { month: number; year: number } => !!price && price.month > 0)
      .map((price) => Math.round((1 - price.year / (price.month * 12)) * 100));
    return savings.length > 0 ? Math.min(...savings) : 0;
  });

  function rank(plan: PlanKey): number {
    return PLAN_ORDER.indexOf(plan);
  }

  function formatPrice(cents: number): string {
    return (cents / 100).toLocaleString(dateLocale(), { style: 'currency', currency: 'EUR' });
  }

  function formatDate(iso: string | null): string {
    if (!iso) return '-';
    return new Date(iso).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'long', year: 'numeric' });
  }

  /**
   * Libellé du statut Stripe. On traduit plutôt que d'afficher `past_due` brut :
   * l'administrateur d'un serveur Discord n'a pas à connaître le vocabulaire
   * interne d'un prestataire de paiement.
   */
  const STATUS_LABELS: Record<string, { label: () => string; tone: 'ok' | 'warn' | 'bad' }> = {
    active: { label: m.bill_status_active, tone: 'ok' },
    trialing: { label: m.bill_status_trialing, tone: 'ok' },
    past_due: { label: m.bill_status_past_due, tone: 'warn' },
    unpaid: { label: m.bill_status_unpaid, tone: 'bad' },
    canceled: { label: m.bill_status_canceled, tone: 'bad' },
    incomplete: { label: m.bill_status_incomplete, tone: 'warn' },
    incomplete_expired: { label: m.bill_status_incomplete_expired, tone: 'bad' },
    paused: { label: m.bill_status_paused, tone: 'warn' },
  };

  const statusInfo = $derived(status?.status ? STATUS_LABELS[status.status] ?? null : null);

  const trial = $derived(status?.trial ?? null);
  /** Vrai quand les boutons d'achat doivent annoncer l'essai plutôt que le prix. */
  const trialAvailable = $derived(Boolean(trial?.available));

  /**
   * Pourquoi l'essai n'est pas proposé. On l'explique au lieu de faire
   * disparaître la mention : un administrateur qui a lu « 15 jours offerts » sur
   * le site et ne voit rien ici doit comprendre d'où vient la différence.
   */
  const TRIAL_REASONS: Record<string, () => string> = {
    already_used_by_user: m.bill_trial_used_by_user,
    already_used_by_guild: m.bill_trial_used_by_guild,
    guild_has_subscription: m.bill_trial_has_subscription,
    plan_not_eligible: m.bill_trial_not_eligible,
  };

  const trialReasonText = $derived(trial && !trial.available && trial.reason ? TRIAL_REASONS[trial.reason]?.() ?? null : null);

  async function load() {
    loading = true;
    status = await fetchBillingStatus();
    loading = false;
  }

  async function subscribe(plan: PlanKey) {
    if (plan === 'FREE' || plan === 'CUSTOM') return;
    pending = plan;
    const url = await startCheckout(plan, interval);
    pending = null;

    if (!url) {
      toast.error(m.bill_err_checkout());
      return;
    }
    // Redirection dans l'onglet courant : Stripe nous renverra sur /billing.
    window.location.href = url;
  }

  async function manage() {
    pending = 'portal';
    const url = await openBillingPortal();
    pending = null;

    if (!url) {
      toast.error(m.bill_err_portal());
      return;
    }
    window.location.href = url;
  }

  onMount(() => {
    // Retour de Stripe. Le webhook a peut-être quelques secondes de retard sur
    // la redirection : on recharge une seconde fois pour éviter d'afficher
    // l'ancienne offre à quelqu'un qui vient tout juste de payer.
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get('checkout');

    if (checkout === 'success') {
      justPaid = true;
      confetti();
      setTimeout(load, 2500);
    } else if (checkout === 'cancelled') {
      toast.info(m.bill_cancelled());
    }

    if (checkout) window.history.replaceState({}, '', window.location.pathname);
    load();
  });
</script>

<div class="pb-24 space-y-6">
  <header class="flex flex-col md:flex-row md:items-end justify-between gap-x-6 gap-y-3">
    <div class="min-w-0">
      <h1 class="text-2xl font-semibold tracking-tight text-on-surface font-headline leading-tight">{m.bill_title()}</h1>
      <p class="mt-1 max-w-prose text-sm text-on-surface-variant">
        {m.bill_desc()}
      </p>
    </div>
  </header>

  {#if outgrown && !justPaid}
    <Callout variant="info" icon="trending-up" title={m.bill_grown_title()}>
      {outgrown.members !== null
        ? m.bill_grown_members({ members: outgrown.members.toLocaleString(dateLocale()), plan: outgrown.current.name })
        : m.bill_grown_no_count({ plan: outgrown.current.name })}
      {m.bill_grown_next({ plan: outgrown.next.name, description: outgrown.next.description })}
      {#snippet actions()}
        <Button variant="primary" size="sm" iconRight="ArrowRight" loading={pending === 'portal'} onclick={manage}>{m.bill_switch_to_plan({ plan: outgrown.next.name })}</Button>
      {/snippet}
    </Callout>
  {/if}

  {#if justPaid}
    <Callout
      variant="success"
      icon="sparkles"
      title={paidPlan ? m.bill_thanks_plan({ plan: paidPlan.name }) : m.bill_thanks()}
    >
      {#if paidPlan}{paidPlan.description} {/if}{m.bill_thanks_modules()}
      {#snippet actions()}
        <Button href="/modules" variant="primary" size="sm" iconRight="ArrowRight">{m.bill_see_modules()}</Button>
      {/snippet}
    </Callout>
  {/if}

  {#if loading}
    <div class="space-y-3">
      {#each Array(3) as _}
        <div class="h-32 rounded-xl bg-surface-container-low/40 animate-pulse"></div>
      {/each}
    </div>
  {:else if !status}
    <div class="rounded-xl border border-outline-variant/40 bg-surface-container-low p-6 text-sm text-on-surface-variant">
      {m.bill_err_load()}
    </div>
  {:else if !status.enabled}
    <div class="rounded-xl border border-outline-variant/40 bg-surface-container-low p-6 space-y-2">
      <h2 class="text-sm font-semibold text-on-surface">{m.bill_disabled_title()}</h2>
      <p class="text-body-sm text-on-surface-variant leading-relaxed max-w-2xl">
        {m.bill_disabled_desc()}
      </p>
    </div>
  {:else}
    <!-- ── Offre en cours ────────────────────────────────────────────────── -->
    <section class="rounded-xl border border-outline-variant/40 bg-surface-container-low p-5 space-y-4">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div class="space-y-1">
          <span class="text-xs text-on-surface-variant font-medium">{m.bill_current_plan()}</span>
          <div class="flex items-center gap-2.5">
            <h2 class="text-lg font-semibold text-on-surface">{status.planName}</h2>
            {#if statusInfo}
              <span
                class="px-2 py-0.5 rounded-md text-2xs font-medium border {statusInfo.tone === 'ok'
                  ? 'bg-success/10 text-success border-success/20'
                  : statusInfo.tone === 'warn'
                    ? 'bg-warning/10 text-warning border-warning/20'
                    : 'bg-error/10 text-error border-error/20'}"
              >
                {statusInfo.label()}
              </span>
            {/if}
          </div>

          {#if status.currentPeriodEnd}
            <p class="text-body-sm text-on-surface-variant">
              {#if status.cancelAtPeriodEnd}
                {m.bill_cancel_requested({ date: formatDate(status.currentPeriodEnd) })}
              {:else}
                {m.bill_next_renewal({ date: formatDate(status.currentPeriodEnd) })}
              {/if}
            </p>
          {/if}
        </div>

        {#if status.hasSubscription}
          <button
            onclick={manage}
            disabled={pending !== null}
            class="flex items-center gap-2 h-9 px-3 rounded-lg bg-primary/10 text-primary border border-primary/20 hover:bg-primary/15 transition-colors disabled:opacity-50 text-sm font-medium"
          >
            <Papicon name="Settings" size={16} />
            {pending === 'portal' ? m.bill_opening() : m.bill_manage()}
          </button>
        {/if}
      </div>

      {#if status.status === 'past_due'}
        <div class="rounded-lg bg-warning/10 border border-warning/20 p-3 text-body-sm text-warning leading-relaxed">
          {m.bill_past_due()}
        </div>
      {/if}
    </section>

    <!-- ── Essai gratuit ─────────────────────────────────────────────────── -->
    {#if trial && trialAvailable}
      <div class="rounded-xl border border-primary/30 bg-primary/5 p-4 flex items-start gap-3">
        <div class="w-8 h-8 rounded-lg bg-primary/15 text-primary flex items-center justify-center shrink-0">
          <Papicon name="Gift" size={16} />
        </div>
        <div class="space-y-1 min-w-0">
          <h2 class="text-sm font-semibold text-on-surface">{m.bill_trial_title({ days: trial.days })}</h2>
          <p class="text-body-sm text-on-surface-variant leading-relaxed">
            {m.bill_trial_desc({ days: trial.days })}
          </p>
        </div>
      </div>
    {:else if trialReasonText}
      <p class="text-xs text-on-surface-variant/80 text-center">{trialReasonText}</p>
    {/if}

    <!-- ── Sélecteur de périodicité ──────────────────────────────────────── -->
    <div class="flex justify-center">
      <div class="flex gap-1 p-1 rounded-lg bg-surface-container-low border border-outline-variant/40">
        <button
          onclick={() => (interval = 'month')}
          class="px-4 h-8 rounded-md text-xs font-medium transition-colors {interval === 'month'
            ? 'bg-primary text-on-primary'
            : 'text-on-surface-variant hover:text-on-surface'}"
        >
          {m.bill_monthly()}
        </button>
        <button
          onclick={() => (interval = 'year')}
          class="px-4 h-8 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 {interval === 'year'
            ? 'bg-primary text-on-primary'
            : 'text-on-surface-variant hover:text-on-surface'}"
        >
          {m.bill_yearly()}

          {#if yearlySavingPercent > 0}
            <span class="text-2xs px-1.5 py-0.5 rounded bg-success/20 text-success font-semibold">
              −{yearlySavingPercent}%
            </span>
          {/if}
        </button>
      </div>
    </div>

    <!-- ── Grille des offres ─────────────────────────────────────────────── -->
    <section class="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      {#each orderedPlans as plan (plan.key)}
        {@const isCurrent = plan.key === currentPlan}
        {@const isUpgrade = rank(plan.key) > rank(currentPlan)}
        <article
          class="rounded-xl border p-5 flex flex-col gap-4 transition-colors {isCurrent
            ? 'border-primary/50 bg-primary/5'
            : 'border-outline-variant/40 bg-surface-container-low'}"
        >
          <div class="space-y-1.5">
            <div class="flex items-center justify-between gap-2">
              <h3 class="text-base font-semibold text-on-surface">{plan.name}</h3>
              {#if isCurrent}
                <span class="text-xs font-semibold px-2 py-0.5 rounded bg-primary/15 text-primary">
                  {m.bill_current()}
                </span>
              {/if}
            </div>
            <p class="text-body-sm text-on-surface-variant leading-snug">{plan.tagline}</p>
          </div>

          <div class="min-h-[3rem]">
            {#if plan.priceCents}
              <div class="flex items-baseline gap-1">
                <span class="text-2xl font-semibold text-on-surface tracking-tight">
                  {formatPrice(interval === 'month' ? plan.priceCents.month : plan.priceCents.year)}
                </span>
                <span class="text-xs text-on-surface-variant">/{interval === 'month' ? m.bill_per_month() : m.bill_per_year()}</span>
              </div>
              <p class="text-2xs text-on-surface-variant mt-0.5">
                {m.bill_price_note()}{#if trialAvailable && plan.purchasable}&nbsp;- {m.bill_after_trial()}{/if}
              </p>
            {:else if plan.key === 'FREE'}
              <div class="text-2xl font-semibold text-on-surface tracking-tight">{m.bill_free()}</div>
            {:else}
              <div class="text-base font-semibold text-on-surface">{m.bill_on_quote()}</div>
            {/if}
          </div>

          <p class="text-xs text-on-surface-variant leading-relaxed flex-1">{plan.description}</p>

          <div class="text-xs text-on-surface-variant flex items-center gap-1.5 pt-1 border-t border-outline-variant/30">
            <Papicon name="LayoutGrid" size={14} />
            {#if plan.memberRange}
              <span>
                {plan.memberRange.max === null
                  ? m.bill_members_above({ min: plan.memberRange.min.toLocaleString(dateLocale()) })
                  : plan.memberRange.min === 0
                    ? m.bill_members_up_to({ max: plan.memberRange.max.toLocaleString(dateLocale()) })
                    : m.bill_members_range({ min: plan.memberRange.min.toLocaleString(dateLocale()), max: plan.memberRange.max.toLocaleString(dateLocale()) })}
              </span>
            {:else}
              <span>{m.bill_no_module()}</span>
            {/if}
          </div>

          {#if isCurrent}
            <button disabled class="h-9 rounded-lg text-sm font-medium bg-surface-container text-on-surface-variant cursor-default">
              {m.bill_your_plan()}
            </button>
          {:else if plan.key === 'CUSTOM'}
            <a
              href="https://kotbo.fr/contact"
              target="_blank"
              rel="noopener noreferrer"
              class="h-9 rounded-lg text-sm font-medium border border-outline-variant/40 text-on-surface hover:bg-surface-container transition-colors flex items-center justify-center"
            >
              {m.bill_contact()}
            </a>
          {:else if plan.purchasable && isUpgrade}
            <button
              onclick={() => subscribe(plan.key)}
              disabled={pending !== null}
              class="h-9 rounded-lg text-sm font-medium bg-primary text-on-primary hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {pending === plan.key
                ? m.bill_opening()
                : trialAvailable
                  ? m.bill_try_plan({ plan: plan.name, days: trial?.days ?? 0 })
                  : m.bill_switch_to({ plan: plan.name })}
            </button>
          {:else if status.hasSubscription}
            <!-- Rétrograder ou changer d'offre en cours d'abonnement se fait
                 dans le portail Stripe, qui gère seul le prorata. -->
            <button
              onclick={manage}
              disabled={pending !== null}
              class="h-9 rounded-lg text-sm font-medium border border-outline-variant/40 text-on-surface-variant hover:bg-surface-container transition-colors disabled:opacity-50"
            >
              {m.bill_change_plan()}
            </button>
          {:else}
            <!-- Aucun geste possible sur cette carte. Trois raisons très
                 différentes aboutissent ici, et « Indisponible » les confondait
                 toutes : un serveur sous accord sur mesure a déjà tout, une
                 offre inférieure n'est pas un achat, et un prix Stripe manquant
                 est une erreur de configuration de l'instance. -->
            <button disabled class="h-9 rounded-lg text-sm font-medium bg-surface-container text-on-surface-variant cursor-default">
              {currentPlan === 'CUSTOM'
                ? m.bill_in_agreement()
                : !isUpgrade
                  ? m.bill_lower_plan()
                  : m.bill_coming_soon()}
            </button>
          {/if}
        </article>
      {/each}
    </section>

    <p class="text-xs text-on-surface-variant text-center leading-relaxed max-w-2xl mx-auto">
      {m.bill_footer()}{#if trialAvailable}{' '}{m.bill_footer_trial()}{/if}
    </p>
  {/if}
</div>
