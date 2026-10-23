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
  const { onEditTracks }: { onEditTracks: () => void } = $props();

  /**
   * Le code d'activation : partenariat, essai offert, geste commercial.
   *
   * Ferme par defaut - la plupart des serveurs n'en ont pas, et un champ
   * ouvert d'emblee a cote d'un prix suggererait que payer est evitable. Le
   * code pose `activationCode` cote serveur, ce qui suffit a faire basculer
   * l'ecran sur « acces deja ouvert » des que le tableau de bord est relu.
   */
  let codeOpen = $state(false);
  let codeValue = $state('');
  let codeBusy = $state(false);

  async function redeemCode() {
    const trimmed = codeValue.trim();
    if (!trimmed || codeBusy) return;
    codeBusy = true;
    try {
      await activateGuildWithCode(trimmed);
      toast.success('Code activé : ton accès est ouvert.');
      codeValue = '';
      codeOpen = false;
      await dashboardStore.refresh();
    } catch (err) {
      toast.error(errorMessage(err) || "Le code n'a pas pu être activé.");
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

  const trialDays = $derived(billing?.trial.available ? billing.trial.days : 0);

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
    const url = await startCheckout(offer.key as 'PLUS' | 'PRO' | 'ULTIMATE', effectiveInterval);
    onboardingData.busy = false;
    if (!url) {
      toast.error("La page de paiement n'a pas pu être ouverte. Réessaie dans un instant.");
      return;
    }
    window.location.href = url;
  }

  /**
   * Sortie du parcours quand il n'y a rien a payer.
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
      toast.error(errorMessage(err) || "La mise en service n'a pas pu être enregistrée.");
    } finally {
      onboardingData.busy = false;
    }
  }
</script>

<WizardShell
  title="Il ne reste qu'à ouvrir le pilotage."
  lead="Ton serveur tourne déjà. La mise en service te donne le tableau de bord : statistiques, historiques, réglages fins."
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
      <p class="text-[15px] font-semibold text-on-surface truncate">{selectedGuild?.name ?? 'Ton serveur'}</p>
      <p class="text-xs text-on-surface-variant">Configuré avec Kotbo</p>
    </div>
    <KotboMark size={28} class="ml-auto shrink-0" />
  </div>

  {#if billing && !billing.enabled}
    <div class="rounded-2xl border border-outline-variant/30 bg-surface-container-low/40 p-5">
      <p class="text-sm font-semibold text-on-surface mb-1">Pas de facturation sur cette instance</p>
      <p class="text-body-sm text-on-surface-variant leading-relaxed">
        Cette installation de Kotbo n'a pas de clé Stripe : tous les modules suivent la
        configuration du serveur, sans offre commerciale.
      </p>
    </div>
  {:else if canFinishWithoutPayment}
    <div class="rounded-2xl border border-outline-variant/30 bg-surface-container-low/40 p-5">
      <p class="text-sm font-semibold text-on-surface mb-1">Ton accès est déjà ouvert</p>
      <p class="text-body-sm text-on-surface-variant leading-relaxed">
        Ce serveur dispose déjà de son accès à Kotbo : il n'y a rien à régler ici. La
        configuration que tu viens de poser s'applique dès maintenant.
      </p>
    </div>
  {:else if offer}
    <div class="rounded-2xl border border-outline-variant/35 bg-surface-container-low/40 p-5">
      <div class="flex items-start justify-between gap-4 mb-2">
        <p class="text-sm font-semibold text-on-surface pt-1">{offer.name}</p>
        {#if offer.priceCents}
          <div class="text-right">
            <p class="text-lg font-bold tracking-tight text-on-surface">
              {formatPrice(effectiveInterval === 'year' ? offer.priceCents.year : offer.priceCents.month)}<span class="text-body-sm font-medium text-on-surface-variant">/{effectiveInterval === 'year' ? 'an' : 'mois'}</span>
            </p>
            {#if effectiveInterval === 'year'}
              <p class="text-xs text-on-surface-variant">
                soit {formatPrice(Math.round(offer.priceCents.year / 12))}/mois
                {#if yearlySavedCents > 0}
                  <span class="ml-1 line-through text-on-surface-variant/45">{formatPrice(offer.priceCents.month)}</span>
                {/if}
              </p>
              {#if yearlySavedCents > 0}
                <p class="text-xs font-medium text-success">{formatPrice(yearlySavedCents)} d'économie par an</p>
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
            Mensuel
          </button>
          <button
            type="button"
            onclick={() => (interval = 'year')}
            aria-pressed={interval === 'year'}
            class="px-3.5 h-7 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 {interval === 'year'
              ? 'bg-primary text-on-primary'
              : 'text-on-surface-variant hover:text-on-surface'}"
          >
            Annuel
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
            {trialDays} jours d'essai gratuit - tu ne seras débité qu'après, et tu peux
            arrêter avant.
          </span>
        </p>
      {/if}
      <p class="mt-3 flex items-start gap-2 text-xs text-on-surface-variant/55 leading-relaxed">
        <Papicon icon="lock" size={12} class="mt-0.5 shrink-0" />
        <span>
          Le paiement se déroule entièrement sur Stripe : aucune donnée bancaire ne passe
          par Kotbo.
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
          Tu as un code&nbsp;? Partenaire, essai offert…
        </button>
      {:else}
        <div class="rounded-2xl border border-outline-variant/30 bg-surface-container-low/30 p-4">
          <p class="text-body-sm font-semibold text-on-surface mb-2">Code partenaire ou d'activation</p>
          <div class="flex items-center gap-2">
            <input
              type="text"
              bind:value={codeValue}
              disabled={codeBusy}
              placeholder="KOTBO-XXXXXX"
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
              {codeBusy ? 'Vérification…' : 'Activer'}
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
        onclick={goToCheckout}
        disabled={onboardingData.busy}
        class="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-on-primary text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
      >
        {onboardingData.busy ? 'Ouverture…' : trialDays > 0 ? `Démarrer l'essai de ${trialDays} jours` : 'Mettre en service'}
        <Papicon icon="ChevronRight" size={15} />
      </button>
    {:else}
      <button
        type="button"
        onclick={finishWithoutBilling}
        disabled={onboardingData.busy}
        class="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-on-primary text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
      >
        Accéder au tableau de bord
        <Papicon icon="ChevronRight" size={15} />
      </button>
    {/if}
  {/snippet}
</WizardShell>
