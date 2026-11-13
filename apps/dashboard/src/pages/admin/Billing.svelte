<script lang="ts">
  import { m } from '../../lib/i18n';
  import { onMount } from 'svelte';
  import {
    detachAdminGuildBilling,
    fetchAdminBilling,
    resetAdminGuildBillingTrial,
    resyncAdminGuildBilling,
    setAdminGuildPlan,
    type AdminBillingGuild,
    type AdminBillingState,
    type AdminPlanKey,
  } from '../../lib/api';
  import { toast } from '../../lib/stores/toast.svelte';
  import { confirmDialog } from '../../lib/stores/confirmDialog.svelte';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import AdminCard from '../../lib/components/admin/AdminCard.svelte';
  import AdminTable from '../../lib/components/admin/AdminTable.svelte';
  import AdminToolbar from '../../lib/components/admin/AdminToolbar.svelte';
  import AdminBadge from '../../lib/components/admin/AdminBadge.svelte';
  import AdminDrawer from '../../lib/components/admin/AdminDrawer.svelte';
  import type { AdminTableColumn, AdminTone } from '../../lib/components/admin/types';
  import MetricTabs, { type MetricTab } from '../../lib/components/analytics/MetricTabs.svelte';
  import BarList, { type BarListItem } from '../../lib/components/analytics/BarList.svelte';
  import { SERIES, fmtNumber } from '../../lib/components/analytics/analyticsFormat';
  import { Button, Callout, EmptyState, Field } from '../../lib/components/ui';

  let billingState = $state<AdminBillingState | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let search = $state('');
  let filter = $state('ALL');
  let busyIds = $state<string[]>([]);
  let showAbsent = $state(false);

  // Panneau lateral de gestion d'un serveur
  let selectedGuildId = $state<string | null>(null);
  let drawerPlan = $state<AdminPlanKey>('FREE');
  let drawerReason = $state('');

  /** Serveur quitte par le bot et sans abonnement Stripe : masque par defaut. */
  function isIdleAbsent(guild: AdminBillingGuild): boolean {
    return !guild.present && !guild.stripeSubscriptionId;
  }

  const guilds = $derived(billingState?.guilds ?? []);
  const plans = $derived(billingState?.plans ?? []);
  const hiddenAbsentCount = $derived(guilds.filter(isIdleAbsent).length);
  const countable = $derived(showAbsent ? guilds : guilds.filter((guild) => !isIdleAbsent(guild)));

  const filtered = $derived.by(() => {
    const needle = search.trim().toLowerCase();
    return guilds
      .filter((guild) => showAbsent || needle || !isIdleAbsent(guild))
      .filter((guild) => !needle || (guild.name ?? '').toLowerCase().includes(needle) || guild.id.includes(needle))
      .filter((guild) => filter === 'ALL' || guild.plan === filter || (filter === 'STRIPE' && Boolean(guild.stripeSubscriptionId)))
      .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id, 'fr'));
  });

  const selectedGuild = $derived(guilds.find((g) => g.id === selectedGuildId) ?? null);

  const kpis = $derived<MetricTab[]>([
    { id: 'servers', label: 'Serveurs suivis', value: fmtNumber(guilds.length), color: SERIES[0] },
    { id: 'stripe', label: 'Abonnements Stripe', value: fmtNumber(billingState?.subscriptions ?? 0), color: SERIES[1] },
    { id: 'trials', label: 'Essais consommés', value: fmtNumber(billingState?.trials ?? 0), color: SERIES[2] },
    { id: 'custom', label: 'Offres Custom', value: fmtNumber(billingState?.counts?.CUSTOM ?? 0), color: SERIES[3] },
  ]);

  const planBars = $derived<BarListItem[]>(
    plans.map((p) => ({
      id: p.key,
      label: `${p.name} (${p.key})`,
      value: billingState?.counts?.[p.key] ?? 0,
      display: fmtNumber(billingState?.counts?.[p.key] ?? 0),
    })),
  );

  const columns: AdminTableColumn[] = [
    { key: 'guild', label: 'Serveur' },
    { key: 'plan', label: 'Offre', width: 'w-32' },
    { key: 'access', label: 'Accès', hideBelow: 'sm' },
    { key: 'stripe', label: 'Stripe', hideBelow: 'md' },
    { key: 'trial', label: 'Essai', hideBelow: 'lg' },
    { key: 'actions', label: '', align: 'right', width: 'w-28' },
  ];

  onMount(load);

  async function load() {
    try {
      billingState = await fetchAdminBilling();
      error = null;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Erreur de chargement';
    } finally {
      loading = false;
    }
  }

  function openGuild(guild: AdminBillingGuild) {
    selectedGuildId = guild.id;
    drawerPlan = guild.plan;
    drawerReason = '';
  }

  function setBusy(id: string, value: boolean) {
    busyIds = value ? [...busyIds, id] : busyIds.filter((item) => item !== id);
  }

  async function run(guild: AdminBillingGuild, action: () => Promise<{ message: string }>) {
    setBusy(guild.id, true);
    try {
      const result = await action();
      toast.success(result.message);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.an_error_generic());
    } finally {
      setBusy(guild.id, false);
    }
  }

  async function changePlan(guild: AdminBillingGuild) {
    const plan = drawerPlan;
    if (plan === guild.plan) return;
    const reason = drawerReason.trim() || 'modification depuis le big admin';
    const warning = guild.stripeSubscriptionId
      ? "Un abonnement Stripe est encore rattaché. Un prochain webhook peut remettre l'offre payée."
      : `Les droits du serveur passeront immédiatement à l'offre ${plan}.`;
    if (!(await confirmDialog.ask({
      title: `Passer ${guild.name ?? guild.id} à ${plan} ?`,
      description: warning,
      confirmLabel: 'Changer l’offre',
      variant: 'warning',
    }))) return;
    await run(guild, () => setAdminGuildPlan(guild.id, plan, reason));
  }

  async function detach(guild: AdminBillingGuild) {
    if (!(await confirmDialog.danger(
      `Détacher Stripe de ${guild.name ?? guild.id} ?`,
      "Cette action efface uniquement le lien dans Kotbo. Elle n'annule pas l'abonnement et n'arrête pas les prélèvements dans Stripe.",
      'Détacher seulement',
    ))) return;
    await run(guild, () => detachAdminGuildBilling(guild.id));
  }

  async function resetTrial(guild: AdminBillingGuild) {
    if (!(await confirmDialog.ask({
      title: `Rendre l'essai à ${guild.name ?? guild.id} ?`,
      description: "Le serveur et le compte Discord qui avait lancé l'essai pourront recommencer un essai complet.",
      confirmLabel: "Rendre l'essai",
      variant: 'warning',
    }))) return;
    await run(guild, () => resetAdminGuildBillingTrial(guild.id));
  }

  async function resync(guild: AdminBillingGuild) {
    await run(guild, () => resyncAdminGuildBilling(guild.id));
  }

  function planTone(plan: AdminPlanKey): AdminTone {
    if (plan === 'CUSTOM') return 'warning';
    if (plan === 'ULTIMATE' || plan === 'PRO') return 'primary';
    if (plan === 'PLUS') return 'info';
    return 'neutral';
  }

  function formatDateShort(value: string | null): string {
    return value ? new Date(value).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : '–';
  }
</script>

<AdminShell title="Facturation" description="Offres, abonnements Stripe et essais gratuits de tous les serveurs.">
  {#snippet actions()}
    <Button icon="RefreshCw" {loading} onclick={load}>Actualiser</Button>
  {/snippet}

  {#if billingState && !billingState.enabled}
    <Callout variant="warning">
      Stripe n'est pas configuré sur cette instance. Les offres manuelles restent utilisables, mais la resynchronisation et les achats sont indisponibles.
    </Callout>
  {/if}

  {#if error}
    <Callout variant="danger">
      {error}
      {#snippet actions()}
        <Button size="sm" icon="RefreshCw" onclick={load}>Réessayer</Button>
      {/snippet}
    </Callout>
  {/if}

  {#if loading && !billingState}
    <div class="h-28 admin-surface animate-pulse"></div>
  {:else}
    <MetricTabs metrics={kpis} active="" onchange={() => {}} interactive={false} label="Indicateurs de facturation" />
  {/if}

  {#if plans.length > 0}
    <AdminCard title="Répartition des offres" description="Sur l’ensemble des serveurs connus">
      <BarList items={planBars} />
    </AdminCard>
  {/if}

  <AdminToolbar
    bind:search
    bind:activeFilter={filter}
    placeholder="Nom ou identifiant du serveur…"
    resultCount={filtered.length}
    resultLabel="serveur"
    filters={[
      { value: 'ALL', label: 'Tous', count: countable.length },
      ...plans.map((plan) => ({
        value: plan.key,
        label: plan.name,
        count: countable.filter((guild) => guild.plan === plan.key).length,
      })),
      { value: 'STRIPE', label: 'Avec Stripe', count: countable.filter((guild) => Boolean(guild.stripeSubscriptionId)).length },
    ]}
  >
    {#snippet actions()}
      <Button
        size="sm"
        variant={showAbsent ? 'primary' : 'secondary'}
        aria-pressed={showAbsent}
        title="Serveurs que le bot a quittés et qui n'ont pas d'abonnement Stripe"
        onclick={() => (showAbsent = !showAbsent)}
      >
        {showAbsent ? 'Masquer hors bot' : `Hors bot (${hiddenAbsentCount})`}
      </Button>
    {/snippet}
  </AdminToolbar>

  {#if !loading && filtered.length === 0}
    <EmptyState
      icon="CreditCard"
      title="Aucun serveur trouvé"
      description="Ajuste la recherche ou les filtres."
      reason="nothing-matches"
    />
  {:else}
    <AdminTable
      {columns}
      rows={filtered}
      {loading}
      emptyTitle="Aucun serveur trouvé"
      emptyHint="Ajuste la recherche ou les filtres."
    >
      {#snippet row(item, _index)}
        {@const guild = item as AdminBillingGuild}
        <tr
          class="border-b border-outline-variant/60 hover:bg-on-surface/3 transition-colors cursor-pointer"
          onclick={() => openGuild(guild)}
        >
          <td class="px-4 py-3 min-w-0">
            <div class="flex items-center gap-2">
              <span class="font-semibold text-on-surface truncate">{guild.name ?? 'Serveur absent'}</span>
              {#if !guild.present}
                <AdminBadge size="sm" tone="neutral" label="Hors bot" />
              {/if}
            </div>
            <p class="text-xs font-mono text-on-surface-variant mt-0.5">{guild.id}</p>
          </td>
          <td class="px-4 py-3">
            <AdminBadge size="sm" tone={planTone(guild.plan)} label={guild.plan} />
          </td>
          <td class="px-4 py-3 text-body-sm text-on-surface-variant hidden sm:table-cell">
            <span class="font-medium text-on-surface">{guild.activated ? 'Actif' : 'Inactif'}</span>
            {#if guild.accessExpiresAt}
              <span class="block text-xs">jusqu’au {formatDateShort(guild.accessExpiresAt)}</span>
            {/if}
          </td>
          <td class="px-4 py-3 text-body-sm hidden md:table-cell">
            {#if guild.stripeSubscriptionId}
              <AdminBadge
                size="sm"
                tone={guild.stripeCancelAtPeriodEnd ? 'warning' : 'success'}
                label={guild.stripeSubscriptionStatus ?? 'actif'}
                dot
              />
            {:else}
              <span class="text-on-surface-variant">–</span>
            {/if}
          </td>
          <td class="px-4 py-3 text-xs text-on-surface-variant hidden lg:table-cell">
            {guild.trial
              ? guild.trial.consumed
                ? `Consommé (${guild.trial.discordUserId})`
                : `Réservé (${guild.trial.discordUserId})`
              : `Disponible (${billingState?.trialDays ?? 15} j)`}
          </td>
          <td class="px-4 py-3 text-right">
            <Button
              size="sm"
              variant="secondary"
              onclick={(e: MouseEvent) => {
                e.stopPropagation();
                openGuild(guild);
              }}
            >
              Gérer
            </Button>
          </td>
        </tr>
      {/snippet}
    </AdminTable>
  {/if}
</AdminShell>

<AdminDrawer
  open={Boolean(selectedGuild)}
  onClose={() => (selectedGuildId = null)}
  title={selectedGuild?.name ?? 'Serveur'}
  subtitle={selectedGuild ? `ID ${selectedGuild.id}` : ''}
>
  {#if selectedGuild}
    {@const isBusy = busyIds.includes(selectedGuild.id)}
    <div class="space-y-6">
      <div class="flex flex-wrap gap-2">
        <AdminBadge label={selectedGuild.plan} tone={planTone(selectedGuild.plan)} />
        <AdminBadge label={selectedGuild.activated ? 'Accès actif' : 'Accès inactif'} tone={selectedGuild.activated ? 'success' : 'neutral'} dot />
        {#if !selectedGuild.present}
          <AdminBadge label="Hors bot" tone="warning" />
        {/if}
      </div>

      <div class="space-y-4">
        <h3 class="text-sm font-semibold text-on-surface">Changer l’offre manuellement</h3>
        <Field label="Nouvelle offre" id="billing-plan">
          <select
            id="billing-plan"
            bind:value={drawerPlan}
            disabled={isBusy}
            class="input w-full px-3 py-2 text-sm text-on-surface"
          >
            {#each plans as plan (plan.key)}
              <option value={plan.key}>{plan.name} ({plan.key})</option>
            {/each}
          </select>
        </Field>
        <Field label="Motif (journal d’audit)" id="billing-reason">
          <input
            id="billing-reason"
            bind:value={drawerReason}
            placeholder="Ex. geste commercial, partenariat…"
            class="input w-full px-3 py-2 text-sm text-on-surface"
          />
        </Field>
        <Button
          variant="primary"
          loading={isBusy}
          disabled={drawerPlan === selectedGuild.plan}
          disabledReason="Choisis une offre différente de l’actuelle."
          onclick={() => changePlan(selectedGuild)}
        >
          Appliquer l’offre {drawerPlan}
        </Button>
      </div>

      <div class="h-px bg-outline-variant/40"></div>

      <div class="space-y-3">
        <h3 class="text-sm font-semibold text-on-surface">Stripe & essai gratuit</h3>
        <dl class="space-y-2 text-body-sm">
          <div class="flex justify-between gap-3">
            <dt class="text-on-surface-variant">Statut Stripe</dt>
            <dd class="font-medium text-on-surface">
              {selectedGuild.stripeSubscriptionStatus ?? 'Aucun abonnement'}
              {selectedGuild.stripeCancelAtPeriodEnd ? ' · résiliation programmée' : ''}
            </dd>
          </div>
          {#if selectedGuild.stripeSubscriptionId}
            <div class="flex justify-between gap-3">
              <dt class="text-on-surface-variant">Abonnement</dt>
              <dd class="font-mono text-xs text-on-surface select-all">{selectedGuild.stripeSubscriptionId}</dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-on-surface-variant">Fin de période</dt>
              <dd class="text-on-surface">{formatDateShort(selectedGuild.stripeCurrentPeriodEnd)}</dd>
            </div>
          {/if}
          <div class="flex justify-between gap-3">
            <dt class="text-on-surface-variant">Essai</dt>
            <dd class="text-on-surface">
              {selectedGuild.trial
                ? selectedGuild.trial.consumed
                  ? `Consommé (${selectedGuild.trial.discordUserId})`
                  : `Réservé (${selectedGuild.trial.discordUserId})`
                : `Disponible (${billingState?.trialDays ?? 15} jours)`}
            </dd>
          </div>
        </dl>

        <div class="flex flex-wrap gap-2 pt-2">
          <Button
            size="sm"
            variant="secondary"
            icon="RefreshCw"
            loading={isBusy}
            disabled={!billingState?.enabled || !selectedGuild.stripeSubscriptionId}
            disabledReason={!billingState?.enabled ? 'Stripe non configuré.' : 'Aucun abonnement Stripe rattaché.'}
            onclick={() => resync(selectedGuild)}
          >
            Resynchroniser Stripe
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon="RotateCcw"
            loading={isBusy}
            disabled={!selectedGuild.trial}
            disabledReason="Aucun essai enregistré."
            onclick={() => resetTrial(selectedGuild)}
          >
            Rendre l’essai
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon="Unlink"
            loading={isBusy}
            disabled={!selectedGuild.stripeCustomerId && !selectedGuild.stripeSubscriptionId}
            disabledReason="Aucun lien Stripe à détacher."
            onclick={() => detach(selectedGuild)}
          >
            Détacher Stripe
          </Button>
        </div>
      </div>

      <div class="pt-2">
        <a href="/admin/servers/{selectedGuild.id}" class="text-body-sm font-semibold text-primary hover:underline">
          Ouvrir la fiche du serveur →
        </a>
      </div>
    </div>
  {/if}
</AdminDrawer>
