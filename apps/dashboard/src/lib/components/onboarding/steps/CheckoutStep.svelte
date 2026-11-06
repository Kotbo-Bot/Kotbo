<script lang="ts">
  import { explainDisabled } from '../../../actions/explainDisabled';
  import { m } from '../../../i18n';
  /**
   * La mise en service.
   *
   * Le recapitulatif vient de dire ce qui a ete construit ; cet ecran ne fait
   * plus que proposer d'ouvrir le pilotage. Il n'a donc plus a rejouer la liste
   * des reglages - c'etait le doublon qui rendait l'ancien dernier ecran long
   * et froid a la fois.
   *
   * Le paiement passe par Stripe, et par lui seul : la page ouvre une session
   * et redirige, aucune donnee bancaire ne transite ici. L'essai est decide
   * cote serveur - le reclamer depuis le navigateur permettrait de le rejouer.
   */
  import { router } from 'tinro';
  import { authStore } from '../../../stores/auth.svelte';
  import { dashboardStore } from '../../../stores/dashboard.svelte';
  import { toast } from '../../../stores/toast.svelte';
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import { onboardingData } from '../../../stores/onboardingData.svelte';
  import { activateGuildWithCode, completeOnboarding, startCheckout } from '../../../api';
  import type { BillingInterval } from '../../../api/billing';
  import KotboMark from '../KotboMark.svelte';
  import Papicon from '../../Papicon.svelte';
  import WizardShell from '../WizardShell.svelte';

  import { errorMessage } from '@kotbo/shared';
  import { REFERRAL_DISCOUNT_PERCENT } from '@kotbo/contracts';
  const { onEditTracks }: { onEditTracks: () => void } = $props();

  /**
   * Le code d'activation (`KB-…`) : partenariat, geste commercial. Tout autre
   * code est pris pour un code de parrainage, vérifié par le bot au paiement.
   *
   * Ferme par defaut - la plupart des serveurs n'en ont pas, et un champ
   * ouvert d'emblee a cote d'un prix suggererait que payer est evitable. Le
   * code pose `activationCode` cote serveur, ce qui suffit a faire basculer
   * l'ecran sur « acces deja ouvert » des que le tableau de bord est relu.
   */
  let codeOpen = $state(false);
  let codeValue = $state('');
  let codeBusy = $state(false);
  /** Code de parrainage retenu pour le paiement. */
  let referralCode = $state('');

  async function redeemCode() {
    const trimmed = codeValue.trim();
    if (!trimmed || codeBusy) return;
    if (!/^KB-/i.test(trimmed)) {
      referralCode = trimmed.toUpperCase();
      codeOpen = false;
      return;
    }
    codeBusy = true;
    try {
      await activateGuildWithCode(trimmed);
      toast.success(m.onb_checkout_code_activated());
      codeValue = '';
      codeOpen = false;
      await dashboardStore.refresh();
    } catch (err) {
      toast.error(errorMessage(err) || m.onb_checkout_code_failed());
    } finally {
      codeBusy = false;
    }
  }

  const billing = $derived(onboardingData.billing);
  const selectedGuild = $derived(
    authStore.guilds.find((guild) => guild.id === authStore.selectedGuildId)
  );
  const guildIconUrl = $derived(
    selectedGuild?.icon
      ? `https://cdn.discordapp.com/icons/${selectedGuild.id}/${selectedGuild.icon}.png?size=128`
      : null
  );

  /** L'offre proposee, deduite de ce que l'instance sait vendre. */
  const offer = $derived(
    billing?.plans.find((card) => card.purchasable && card.key !== 'FREE') ?? null
  );

  /**
   * Ce serveur a-t-il quelque chose a payer pour finir ?
   *
   * Le bot repond : instance sans facturation, ou acces deja accorde - offre
   * posee a la main, abonnement en cours, code de partenariat. Ces serveurs
   * traversent le parcours comme les autres, mais on ne leur reclame pas une
   * seconde fois ce qu'ils ont deja.
   */
  const canFinishWithoutPayment = $derived(
    dashboardStore.state.onboardingCanFinishWithoutPayment === true
  );

  // L'essai n'existe qu'avec un code de parrainage.
  const trialDays = $derived(billing?.trial.available && referralCode ? billing.trial.days : 0);

  /**
   * Periodicite de l'abonnement. Le mensuel reste le choix par defaut : c'est
   * le plus petit engagement a cote d'un essai. L'annuel n'est propose que si
   * l'offre a vraiment un prix annuel - sinon le bouton menerait a une session
   * Stripe sans tarif.
   */
  let interval = $state<BillingInterval>('month');
  const yearlyAvailable = $derived((offer?.priceCents?.year ?? 0) > 0);
  const yearlySavingPercent = $derived.by(() => {
    const price = offer?.priceCents;
    if (!price || price.month <= 0 || price.year <= 0) return 0;
    return Math.round((1 - price.year / (price.month * 12)) * 100);
  });
  /** Ce que l'annuel fait gagner sur douze mensualites. */
  const yearlySavedCents = $derived.by(() => {
    const price = offer?.priceCents;
    if (!price || price.month <= 0 || price.year <= 0) return 0;
    return Math.max(0, price.month * 12 - price.year);
  });
  const effectiveInterval =$derived<BillingInterval>(yearlyAvailable ? interval : 'month');

  function formatPrice(cents: number): string {
    return (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
  }

  async function goToCheckout() {
    if (onboardingData.busy || !offer) return;
    onboardingData.busy = true;
    let url: string | null = null;
    try {
      url = await startCheckout(offer.key as 'PLUS' | 'PRO' | 'ULTIMATE', effectiveInterval, referralCode || undefined);
    } catch (err) {
      // Code de parrainage refusé : le bot dit pourquoi.
      onboardingData.busy = false;
      toast.error(errorMessage(err) || m.obx_co_checkout_failed());
      return;
    }
    onboardingData.busy = false;
    if (!url) {
      toast.error(m.onb_checkout_open_failed());
      return;
    }
    window.location.href = url;
  }

  /**
   * Sortie du parcours sans paiement : acces deja ouvert, ou offre gratuite.
   *
   * La cloture s'ecrit sur le serveur, pas dans le navigateur : c'est elle qui
   * ouvre le tableau de bord, et c'est le bot qui verifie qu'elle est due. Sans
   * cet aller-retour, le parcours se rouvrirait au prochain chargement - et un
   * simple drapeau local aurait suffi a le sauter sur n'importe quel serveur.
   */
  async function finishWithoutBilling() {
    if (onboardingData.busy) return;
    onboardingData.busy = true;
    try {
      await completeOnboarding();
      wizard.complete('checkout');
      // Le drapeau `onboardingRequired` vient du bot : sans relecture, la page
      // resterait sur le parcours qu'on vient de clore.
      await dashboardStore.refresh();
      router.goto('/');
    } catch (err) {
      toast.error(errorMessage(err) || m.onb_checkout_save_failed());
    } finally {
      onboardingData.busy = false;
    }
  }
</script>

<WizardShell
  title={m.obx_co_title()}
  lead={m.obx_co_lead()}
  {onEditTracks}
>
  <div class="flex items-center gap-3.5 rounded-2xl border border-primary/35 bg-primary/[0.04] px-5 py-4 mb-5">
    {#if guildIconUrl}
      <img src={guildIconUrl} alt="" class="w-12 h-12 rounded-2xl object-cover shrink-0" />
    {:else}
      <div class="w-12 h-12 rounded-2xl bg-surface-container flex items-center justify-center text-base font-bold text-on-surface-variant shrink-0">
        {(selectedGuild?.name ?? '?').slice(0, 1).toUpperCase()}
      </div>
    {/if}
    <div class="min-w-0">
      <p class="text-[15px] font-semibold text-on-surface truncate">{selectedGuild?.name ?? m.obx_co_your_server()}</p>
      <p class="text-xs text-on-surface-variant">{m.obx_co_configured()}</p>
    </div>
    <KotboMark size={28} class="ml-auto shrink-0" />
  </div>

  {#if billing && !billing.enabled}
    <div class="rounded-2xl border border-outline-variant/30 bg-surface-container-low/40 p-5">
      <p class="text-sm font-semibold text-on-surface mb-1">{m.obx_co_no_billing()}</p>
      <p class="text-body-sm text-on-surface-variant leading-relaxed">
        {m.obx_co_no_billing_desc()}
      </p>
    </div>
  {:else if canFinishWithoutPayment}
    <div class="rounded-2xl border border-outline-variant/30 bg-surface-container-low/40 p-5">
      <p class="text-sm font-semibold text-on-surface mb-1">{m.obx_co_access()}</p>
      <p class="text-body-sm text-on-surface-variant leading-relaxed">
        {m.obx_co_access_desc()}
      </p>
    </div>
  {:else if offer}
    <div class="rounded-2xl border border-outline-variant/35 bg-surface-container-low/40 p-5">
      <div class="flex items-start justify-between gap-4 mb-2">
        <p class="text-sm font-semibold text-on-surface pt-1">{offer.name}</p>
        {#if offer.priceCents}
          <div class="text-right">
            <p class="text-lg font-bold tracking-tight text-on-surface">
              {formatPrice(effectiveInterval === 'year' ? offer.priceCents.year : offer.priceCents.month)}<span class="text-body-sm font-medium text-on-surface-variant">/{effectiveInterval === 'year' ? m.obx_co_year() : m.obx_co_month()}</span>
            </p>
            {#if effectiveInterval === 'year'}
              <p class="text-xs text-on-surface-variant">
                {m.obx_co_per_month({ price: formatPrice(Math.round(offer.priceCents.year / 12)) })}
                {#if yearlySavedCents > 0}
                  <span class="ml-1 line-through text-on-surface-variant/45">{formatPrice(offer.priceCents.month)}</span>
                {/if}
              </p>
              {#if yearlySavedCents > 0}
                <p class="text-xs font-medium text-success">{m.obx_co_saved({ amount: formatPrice(yearlySavedCents) })}</p>
              {/if}
            {/if}
          </div>
        {/if}
      </div>
      {#if yearlyAvailable}
        <div class="mb-3 inline-flex gap-1 p-1 rounded-lg bg-surface-container-low border border-outline-variant/40">
          <button
            type="button"
            onclick={() => (interval = 'month')}
            aria-pressed={interval === 'month'}
            class="px-3.5 h-7 rounded-md text-xs font-medium transition-colors {interval === 'month'
              ? 'bg-primary text-on-primary'
              : 'text-on-surface-variant hover:text-on-surface'}"
          >
            {m.obx_co_monthly()}
          </button>
          <button
            type="button"
            onclick={() => (interval = 'year')}
            aria-pressed={interval === 'year'}
            class="px-3.5 h-7 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 {interval === 'year'
              ? 'bg-primary text-on-primary'
              : 'text-on-surface-variant hover:text-on-surface'}"
          >
            {m.obx_co_yearly()}
            {#if yearlySavingPercent > 0}
              <span class="text-2xs px-1.5 py-0.5 rounded bg-success/20 text-success font-semibold">
                −{yearlySavingPercent}%
              </span>
            {/if}
          </button>
        </div>
      {/if}
      <p class="text-body-sm text-on-surface-variant leading-relaxed">
        {offer.description}
      </p>
      {#if trialDays > 0}
        <p class="mt-3 flex items-start gap-2 text-body-sm font-medium text-success">
          <Papicon icon="gift" size={14} class="mt-0.5 shrink-0" />
          <span>
            {m.obx_co_referral({ code: referralCode ?? '', days: trialDays, percent: REFERRAL_DISCOUNT_PERCENT })}
          </span>
        </p>
      {/if}
      <p class="mt-3 flex items-start gap-2 text-xs text-on-surface-variant/55 leading-relaxed">
        <Papicon icon="lock" size={12} class="mt-0.5 shrink-0" />
        <span>
          {m.obx_co_stripe()}
        </span>
      </p>
    </div>

    <div class="mt-4">
      {#if !codeOpen}
        <button
          type="button"
          onclick={() => (codeOpen = true)}
          class="inline-flex items-center gap-1.5 text-body-sm font-medium text-on-surface-variant hover:text-on-surface transition-colors"
        >
          <Papicon icon="ticket" size={13} />
          {m.obx_co_have_code()}
        </button>
      {:else}
        <div class="rounded-2xl border border-outline-variant/30 bg-surface-container-low/30 p-4">
          <p class="text-body-sm font-semibold text-on-surface mb-2">{m.obx_co_code()}</p>
          <div class="flex items-center gap-2">
            <input
              type="text"
              bind:value={codeValue}
              disabled={codeBusy}
              placeholder={m.obx_co_code_ph()}
              onkeydown={(event) => event.key === 'Enter' && redeemCode()}
              class="min-w-0 flex-1 rounded-lg border border-outline-variant/40 bg-surface-container px-3 py-2 text-body-sm text-on-surface placeholder:text-on-surface-variant/40 focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <button
              type="button"
              onclick={redeemCode}
              disabled={codeBusy}
              use:explainDisabled={(!codeValue.trim()) ? m.common_reason_fill_field() : ''}
              class="shrink-0 px-3.5 py-2 rounded-lg bg-primary text-on-primary text-body-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              {codeBusy ? m.obx_co_checking() : m.obx_apply()}
            </button>
          </div>
        </div>
      {/if}
    </div>
  {/if}

  {#snippet footer()}
    {#if offer && !canFinishWithoutPayment}
      <button
        type="button"
        onclick={finishWithoutBilling}
        disabled={onboardingData.busy}
        class="inline-flex items-center px-4 py-2.5 rounded-xl text-sm font-medium text-on-surface-variant hover:text-on-surface transition-colors disabled:opacity-40"
      >
        {m.obx_co_free()}
      </button>
      <button
        type="button"
        onclick={goToCheckout}
        disabled={onboardingData.busy}
        class="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-on-primary text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
      >
        {onboardingData.busy ? m.obx_co_opening() : trialDays > 0 ? m.obx_co_trial({ days: trialDays }) : m.obx_co_start()}
        <Papicon icon="ChevronRight" size={15} />
      </button>
    {:else}
      <button
        type="button"
        onclick={finishWithoutBilling}
        disabled={onboardingData.busy}
        class="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-on-primary text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
      >
        {m.obx_co_dashboard()}
        <Papicon icon="ChevronRight" size={15} />
      </button>
    {/if}
  {/snippet}
</WizardShell>
