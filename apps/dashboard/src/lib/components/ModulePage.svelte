<script lang="ts">
  import { router } from 'tinro';
  import { dashboardStore } from '../stores/dashboard.svelte';
  import { updateModuleStatus } from '../api';
  import { createAsyncActionState } from '../asyncAction.svelte';
  import InlineFeedback from './InlineFeedback.svelte';
  import Button from './ui/Button.svelte';
  import Callout from './ui/Callout.svelte';
  import Menu, { type MenuItem } from './ui/Menu.svelte';
  import { toast } from '../stores/toast.svelte';
  import { confirmDialog } from '../stores/confirmDialog.svelte';
  import { feedbackModal } from '../stores/feedbackModal.svelte';
  import { getPageStatus } from '../config/pages';
  import { m } from '../i18n';

  // `icon` reste accepte : les 59 pages qui le passent n'ont pas a changer,
  // mais l'en-tete ne l'affiche plus. Le menu montre deja l'icone de la page.
  const {
    title = '',
    description = '',
    icon: _icon = 'Grid',
    featureKey = '',
    children,
    actions = undefined
  } = $props();

  const saveAction = createAsyncActionState();

  const module = $derived((dashboardStore.state.modules as any[]).find((m) => m.id === featureKey));
  const isModuleEnabled = $derived(!module || module.status === 'active');
  const isFixed = $derived(module?.id === 'activity' || module?.id === 'dashboard');

  /**
   * Verrouille par l'offre, et non eteint par choix. La distinction change le
   * bouton : un module eteint se rallume d'un clic, un module hors offre ne se
   * rallume pas du tout. L'interrupteur affiche jusqu'ici sur ces modules
   * ecrivait `enabled = true`, que la garde d'execution rebasculait aussitot a
   * `false` - le clic partait en boucle et la page restait grisee.
   */
  const lockedByPlan = $derived(!!module?.lockedByPlan);

  const PLAN_LABELS: Record<string, string> = {
    PLUS: 'Plus',
    PRO: 'Pro',
    ULTIMATE: 'Ultimate',
    CUSTOM: 'Sur mesure',
  };
  const requiredPlanLabel = $derived(
    module?.requiredPlan ? PLAN_LABELS[module.requiredPlan] ?? module.requiredPlan : 'payante',
  );

  const isBeta = $derived(getPageStatus($router.path, $router.url)?.beta ?? false);

  async function setModule(enabled: boolean) {
    if (!module || isFixed || lockedByPlan) return;
    const newStatus = enabled ? 'active' : 'inactive';

    await saveAction.run(async () => {
      const ok = await updateModuleStatus(featureKey, newStatus);
      if (!ok) throw new Error(m.d7_api_error());
      await dashboardStore.refresh();

      // Le remontage emporte cette bannière avec la page : la confirmation
      // passe donc par une notification, qui lui survit.
      if (newStatus === 'active') {
        toast.success(m.d7_module_enabled());
        dashboardStore.markModuleActivated();
      }
      return true;
    }, { successMessage: newStatus === 'active' ? '' : m.d7_module_disabled() });
  }

  /**
   * Eteindre un module coupe ses commandes et ses automatismes pour tout le
   * serveur. C'etait un interrupteur pose a cote du titre de chaque page, au
   * meme rang que l'action principale ; il vit maintenant dans le menu de la
   * page, et demande confirmation. Le rallumer reste a un clic (encadre).
   */
  async function askDisable() {
    const confirmed = await confirmDialog.ask({
      title: `Désactiver « ${title} » ?`,
      description: m.mp_disable_confirm_desc(),
      confirmLabel: m.mp_disable_confirm_action(),
      variant: 'warning',
    });
    if (confirmed) await setModule(false);
  }

  const pageMenu = $derived.by((): MenuItem[] => {
    const items: MenuItem[] = [];
    if (isBeta) {
      items.push({ label: m.banner_report_issue(), icon: 'message-square', onselect: () => feedbackModal.show() });
    }
    if (module && !isFixed && !lockedByPlan && isModuleEnabled) {
      items.push({
        label: m.mp_disable_action(),
        description: m.mp_disable_action_desc(),
        icon: 'power',
        onselect: () => void askDisable(),
      });
    }
    return items;
  });
</script>

<div class="module-page flex flex-col gap-6">
  <InlineFeedback state={saveAction} />

  <header class="module-page__header flex flex-col md:flex-row md:items-end justify-between gap-x-6 gap-y-3">
    <div class="module-page__identity min-w-0">
      <div class="flex items-center gap-2 min-w-0">
        <h1 class="text-2xl font-semibold tracking-tight text-on-surface font-headline leading-tight truncate">{title}</h1>
        {#if isBeta}
          <span class="shrink-0 px-1.5 py-0.5 rounded-md text-2xs font-medium bg-primary/10 text-primary">{m.common_beta()}</span>
        {/if}
      </div>
      {#if description}
        <p class="mt-1 max-w-prose text-sm text-on-surface-variant">{description}</p>
      {/if}
    </div>

    <div class="module-page__actions flex items-center flex-wrap md:justify-end gap-2 shrink-0">
      {#if actions}
        {@render actions()}
      {/if}

      {#if module && !isFixed && lockedByPlan}
        <Button href="/billing" variant="primary" icon="Lock">Offre {requiredPlanLabel}</Button>
      {/if}

      {#if pageMenu.length > 0}
        <Menu items={pageMenu} label={m.mp_page_menu({ page: title })} />
      {/if}
    </div>
  </header>

  <!-- Un module eteint ferme ses routes API : la page ne peut ni charger ni
       enregistrer quoi que ce soit. Le dire ici, une fois, evite que chaque
       appel refuse ne remonte en notification. -->
  <!-- `data-guide-blocker` : un guidage vers un reglage de la page montre
       d'abord cet encadre, le reglage restant inerte tant qu'il est la. -->
  {#if module && !isFixed && lockedByPlan}
    <div data-guide-blocker="plan">
      <Callout variant="info" icon="Lock" title="« {title} » fait partie de l'offre {requiredPlanLabel}">
        Tu peux en voir la page, mais pas l'activer tant que l'offre du serveur ne le comprend pas.
        {#snippet actions()}
          <Button href="/billing" variant="secondary" size="sm" iconRight="ArrowRight">Voir les offres</Button>
        {/snippet}
      </Callout>
    </div>
  {:else if module && !isFixed && !isModuleEnabled}
    <div data-guide-blocker="module-off">
      <Callout variant="warning" title={m.mp_module_off_title()}>
        {m.mp_module_off_desc()}
        {#snippet actions()}
          <Button variant="primary" size="sm" icon="power" loading={saveAction.state.loading} onclick={() => setModule(true)}>
            {m.mp_module_off_action()}
          </Button>
        {/snippet}
      </Callout>
    </div>
  {/if}

  <main class="module-page__body flex-1 space-y-8 {isModuleEnabled || isFixed || featureKey === 'sanctions' || featureKey === 'channel_links' || featureKey === 'staff_server' ? '' : 'opacity-40 pointer-events-none grayscale-[0.5] transition-all duration-500'}">
    {@render children()}
  </main>
</div>
