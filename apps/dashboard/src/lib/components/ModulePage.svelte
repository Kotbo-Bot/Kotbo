<script lang="ts">
  import Papicon from './Papicon.svelte';
  import { dashboardStore } from '../stores/dashboard.svelte';
  import ToggleSwitch from './ToggleSwitch.svelte';
  import { updateModuleStatus } from '../api';
  import { createAsyncActionState } from '../asyncAction.svelte';
  import InlineFeedback from './InlineFeedback.svelte';
  import Button from './ui/Button.svelte';
  import Callout from './ui/Callout.svelte';
  import { toast } from '../stores/toast.svelte';
  import { m } from '../i18n';

  const { 
    title = '', 
    description = '', 
    icon = 'Grid', 
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

  async function toggleModule() {
    if (!module || isFixed || lockedByPlan) return;
    const newStatus = isModuleEnabled ? 'inactive' : 'active';
    
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
</script>

<div class="module-page flex flex-col gap-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
  <InlineFeedback state={saveAction} />
  
  <!-- Header -->
  <header class="module-page__header flex flex-col md:flex-row md:items-center justify-between gap-4 bg-surface-container-lowest p-5 rounded-xl border border-outline-variant">
    <div class="module-page__identity flex min-w-0 items-center gap-4">
      <div class="module-page__icon w-11 h-11 shrink-0 bg-primary-container text-on-primary-container rounded-lg flex items-center justify-center">
        <Papicon {icon} size={22} />
      </div>
      <div class="min-w-0">
        <h1 class="text-lg font-semibold tracking-tight text-on-surface font-headline leading-tight">{title}</h1>
        <p class="text-sm text-on-surface-variant">{description}</p>
      </div>
    </div>

    <div class="module-page__actions flex items-center flex-wrap justify-end gap-3">
      {#if actions}
        {@render actions()}
      {/if}

      {#if module && !isFixed && lockedByPlan}
        <div class="h-8 w-px bg-outline-variant mx-1 hidden md:block"></div>
        <Button href="/billing" variant="primary" icon="Lock">Offre {requiredPlanLabel}</Button>
      {:else if module && !isFixed}
        <div class="h-8 w-px bg-outline-variant mx-1 hidden md:block"></div>
        <div class="flex items-center gap-2.5 px-3 py-1.5 bg-surface-container rounded-lg border border-outline-variant">
          <span class="text-xs font-medium {isModuleEnabled ? 'text-primary' : 'text-on-surface-variant'}">
            {isModuleEnabled ? m.d7_enabled() : m.d7_disabled()}
          </span>
          <ToggleSwitch
            checked={isModuleEnabled}
            onToggle={toggleModule}
            disabled={saveAction.state.loading}
          />
        </div>
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
          <Button variant="primary" size="sm" icon="power" loading={saveAction.state.loading} onclick={toggleModule}>
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
