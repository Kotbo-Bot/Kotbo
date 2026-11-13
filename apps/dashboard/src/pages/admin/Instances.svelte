<script lang="ts">
  import { m } from '../../lib/i18n';
  import { onMount } from 'svelte';
  import { toast } from '../../lib/stores/toast.svelte';
  import { confirmDialog } from '../../lib/stores/confirmDialog.svelte';
  import {
    fetchBotInstances,
    banBotInstance,
    unbanBotInstance,
    type BotInstance,
    type InstanceBanMode,
    type OrphanInstanceBan,
  } from '../../lib/api/instances';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import AdminCard from '../../lib/components/admin/AdminCard.svelte';
  import AdminTable from '../../lib/components/admin/AdminTable.svelte';
  import AdminToolbar from '../../lib/components/admin/AdminToolbar.svelte';
  import AdminBadge from '../../lib/components/admin/AdminBadge.svelte';
  import type { AdminTableColumn } from '../../lib/components/admin/types';
  import MetricTabs from '../../lib/components/analytics/MetricTabs.svelte';
  import { SERIES, fmtNumber } from '../../lib/components/analytics/analyticsFormat';
  import Papicon from '../../lib/components/Papicon.svelte';
  import { Button, Callout, EmptyState, Field, Modal } from '../../lib/components/ui';
  import { errorMessage } from '@kotbo/shared';

  let instances = $state<BotInstance[]>([]);
  let orphanBans = $state<OrphanInstanceBan[]>([]);
  let loading = $state(true);
  let refreshing = $state(false);
  let loadError = $state<string | null>(null);

  let filter = $state('selfhost');
  let search = $state('');

  let banTarget = $state<BotInstance | null>(null);
  let banModalOpen = $state(false);
  let banMode = $state<InstanceBanMode>('DISABLE_FEATURES');
  let banReason = $state('');
  let banning = $state(false);
  let unbanningId = $state<string | null>(null);

  const MODE_LABEL: Record<InstanceBanMode, string> = {
    DISABLE_FEATURES: 'Fonctions désactivées',
    SHUTDOWN: 'Arrêt du bot',
  };

  const counts = $derived({
    all: instances.length,
    selfhost: instances.filter((i) => i.isSelfHosted).length,
    banned: instances.filter((i) => i.banned).length,
    online: instances.filter((i) => i.status === 'online').length,
  });

  const visible = $derived.by(() => {
    const q = search.trim().toLowerCase();
    return instances.filter((i) => {
      if (filter === 'selfhost' && !i.isSelfHosted) return false;
      if (filter === 'banned' && !i.banned) return false;
      if (!q) return true;
      return (
        i.botName.toLowerCase().includes(q)
        || i.botClientId.includes(q)
        || (i.dashboardUrl ?? '').toLowerCase().includes(q)
      );
    });
  });

  const columns: AdminTableColumn[] = [
    { key: 'bot', label: 'Bot' },
    { key: 'guilds', label: 'Serveurs', align: 'right', hideBelow: 'sm' },
    { key: 'users', label: 'Membres', align: 'right', hideBelow: 'md' },
    { key: 'version', label: 'Version', hideBelow: 'lg' },
    { key: 'ping', label: 'Dernier ping', hideBelow: 'sm' },
    { key: 'state', label: 'État' },
    { key: 'action', label: '', align: 'right', width: 'w-32' },
  ];

  async function load() {
    try {
      const data = await fetchBotInstances();
      instances = data?.instances ?? [];
      orphanBans = data?.orphanBans ?? [];
      loadError = null;
    } catch (err) {
      loadError = errorMessage(err);
    }
  }

  onMount(async () => {
    await load();
    loading = false;
  });

  async function refresh() {
    refreshing = true;
    await load();
    refreshing = false;
  }

  function openBan(instance: BotInstance) {
    banTarget = instance;
    banMode = 'DISABLE_FEATURES';
    banReason = '';
    banModalOpen = true;
  }

  async function confirmBan() {
    if (!banTarget) return;
    banning = true;
    try {
      await banBotInstance(banTarget.botClientId, { mode: banMode, reason: banReason.trim() || undefined });
      toast.success(m.ainst_banned({ name: banTarget.botName }));
      banModalOpen = false;
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      banning = false;
    }
  }

  async function unban(botClientId: string, name: string) {
    const confirmed = await confirmDialog.ask({
      title: `Réactiver ${name} ?`,
      description: 'Le bot retrouvera ses fonctions à son prochain ping. S’il a été arrêté, il faudra le relancer de son côté.',
      confirmLabel: 'Débannir',
    });
    if (!confirmed) return;
    unbanningId = botClientId;
    try {
      await unbanBotInstance(botClientId);
      toast.success(m.ainst_unbanned({ name }));
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      unbanningId = null;
    }
  }

  function relativeTime(iso: string): string {
    const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
    if (minutes < 1) return 'à l’instant';
    if (minutes < 60) return `il y a ${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `il y a ${hours} h`;
    return `il y a ${Math.round(hours / 24)} j`;
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString('fr-FR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  const nf = new Intl.NumberFormat('fr-FR');
</script>

<AdminShell
  title="Instances self-host"
  description="Les bots qui remontent leurs statistiques au serveur central. Tu peux en couper un à distance, par exemple s’il utilise Kotbo sans licence."
>
  {#snippet actions()}
    <Button icon="RefreshCw" loading={refreshing} onclick={refresh}>Actualiser</Button>
  {/snippet}

  <Callout variant="info" title="Comment la coupure s’applique">
    Un bot self-host n’accepte aucune connexion entrante : il reçoit la consigne dans la réponse à son ping, toutes
    les 15 minutes environ. Le ban vise son identifiant Discord et l’empreinte de son installation, il tient donc s’il
    recrée une application. C’est un garde-fou, pas une protection : quelqu’un qui modifie le code peut retirer le ping.
  </Callout>

  {#if !loading && !loadError}
    <MetricTabs
      interactive={false}
      active=""
      onchange={() => {}}
      label="Indicateurs des instances"
      metrics={[
        { id: 'all', label: 'Instances actives', value: fmtNumber(counts.all), color: SERIES[0] },
        { id: 'selfhost', label: 'Self-host', value: fmtNumber(counts.selfhost), color: SERIES[1] },
        { id: 'online', label: 'En ligne', value: fmtNumber(counts.online), color: SERIES[2] },
        { id: 'banned', label: 'Bannies', value: fmtNumber(counts.banned), color: SERIES[3] },
      ]}
    />
  {/if}

  {#if loadError}
    <Callout variant="danger" title="Impossible de charger les instances">
      {loadError}
      {#snippet actions()}
        <Button size="sm" icon="RefreshCw" onclick={refresh}>Réessayer</Button>
      {/snippet}
    </Callout>
  {:else}
    <AdminToolbar
      bind:search
      bind:activeFilter={filter}
      placeholder="Nom, ID du bot ou URL…"
      resultCount={visible.length}
      resultLabel="instance"
      filters={[
        { value: 'selfhost', label: 'Self-host', count: counts.selfhost },
        { value: 'banned', label: 'Bannies', count: counts.banned },
        { value: 'all', label: 'Toutes', count: counts.all },
      ]}
    />

    {#if !loading && visible.length === 0}
      <EmptyState
        icon="Server"
        title={instances.length === 0 ? 'Aucune instance n’a encore pingué' : 'Aucune instance ne correspond'}
        description={instances.length === 0
          ? 'Les bots envoient leurs statistiques au démarrage puis toutes les 15 minutes.'
          : 'Change de filtre ou de recherche.'}
        reason="accumulating"
      />
    {:else}
      <AdminTable
        {columns}
        rows={visible}
        {loading}
        emptyTitle="Aucune instance"
        emptyHint="Une instance sans ping depuis 48 h disparaît de cette liste."
      >
        {#snippet row(item, _index)}
          {@const inst = item as BotInstance}
          <tr class="border-b border-outline-variant/60 hover:bg-on-surface/3 transition-colors">
            <td class="px-4 py-3">
              <div class="flex items-center gap-3 min-w-0">
                {#if inst.botAvatarUrl}
                  <img src={inst.botAvatarUrl} alt="" class="w-8 h-8 rounded-full shrink-0 bg-surface-container" loading="lazy" />
                {:else}
                  <span class="w-8 h-8 rounded-full shrink-0 bg-surface-container flex items-center justify-center text-on-surface-variant">
                    <Papicon icon="Server" size={14} />
                  </span>
                {/if}
                <div class="min-w-0">
                  <div class="font-semibold text-on-surface truncate flex items-center gap-2">
                    <span class="truncate">{inst.botName}</span>
                    {#if !inst.isSelfHosted}
                      <AdminBadge size="sm" tone="info" label="Officielle" />
                    {/if}
                  </div>
                  <p class="text-2xs font-mono text-on-surface-variant truncate">{inst.botClientId}</p>
                  {#if inst.dashboardUrl}
                    <p class="text-2xs text-on-surface-variant truncate max-w-64" title={inst.dashboardUrl}>{inst.dashboardUrl}</p>
                  {/if}
                </div>
              </div>
            </td>
            <td class="px-4 py-3 text-right tabular-nums text-on-surface hidden sm:table-cell">{nf.format(inst.guildCount)}</td>
            <td class="px-4 py-3 text-right tabular-nums text-on-surface hidden md:table-cell">{nf.format(inst.userCount)}</td>
            <td class="px-4 py-3 font-mono text-xs text-on-surface-variant hidden lg:table-cell">{inst.version ?? '–'}</td>
            <td class="px-4 py-3 hidden sm:table-cell">
              <AdminBadge
                size="sm"
                tone={inst.status === 'online' ? 'success' : 'neutral'}
                label={inst.status === 'online' ? 'En ligne' : 'Silencieuse'}
                dot
              />
              <p class="text-2xs text-on-surface-variant mt-1" title={formatDate(inst.lastPingAt)}>{relativeTime(inst.lastPingAt)}</p>
            </td>
            <td class="px-4 py-3">
              {#if inst.ban}
                <AdminBadge size="sm" tone="danger" label={MODE_LABEL[inst.ban.mode]} />
                <p class="text-2xs text-on-surface-variant mt-1" title={inst.ban.reason ?? ''}>
                  depuis le {formatDate(inst.ban.createdAt)}
                </p>
                {#if inst.ban.reason}
                  <p class="text-2xs text-on-surface-variant truncate max-w-56" title={inst.ban.reason}>{inst.ban.reason}</p>
                {/if}
              {:else}
                <AdminBadge size="sm" tone="neutral" label="Actif" />
              {/if}
            </td>
            <td class="px-4 py-3 text-right whitespace-nowrap">
              {#if inst.banned}
                <Button
                  size="sm"
                  icon="Unlock"
                  loading={unbanningId === inst.botClientId}
                  onclick={() => unban(inst.botClientId, inst.botName)}
                >
                  Débannir
                </Button>
              {:else}
                <Button size="sm" variant="danger" icon="Ban" onclick={() => openBan(inst)}>Bannir</Button>
              {/if}
            </td>
          </tr>
        {/snippet}
      </AdminTable>
    {/if}

    {#if orphanBans.length > 0}
      <AdminCard
        title="Bans sans ping récent"
        description="Ces instances sont toujours bannies mais n’ont pas pingué depuis plus de 48 h, souvent parce qu’elles ont été arrêtées."
        padded={false}
      >
        <ul class="divide-y divide-outline-variant/40">
          {#each orphanBans as ban (ban.id)}
            <li class="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
              <div class="min-w-0">
                <p class="font-mono text-body-sm text-on-surface truncate">{ban.botClientId ?? ban.machineFingerprint ?? ban.id}</p>
                <p class="text-2xs text-on-surface-variant">
                  {MODE_LABEL[ban.mode]} · depuis le {formatDate(ban.createdAt)}{ban.reason ? ` · ${ban.reason}` : ''}
                </p>
              </div>
              {#if ban.botClientId}
                {@const clientId = ban.botClientId}
                <Button
                  size="sm"
                  icon="Unlock"
                  loading={unbanningId === clientId}
                  onclick={() => unban(clientId, clientId)}
                >
                  Débannir
                </Button>
              {/if}
            </li>
          {/each}
        </ul>
      </AdminCard>
    {/if}
  {/if}
</AdminShell>

<Modal
  bind:open={banModalOpen}
  title={banTarget ? `Bannir ${banTarget.botName}` : 'Bannir'}
  subtitle={banTarget?.botClientId}
>
  <div class="space-y-5">
    {#if banTarget && !banTarget.isSelfHosted}
      <Callout variant="warning" title="Cette instance se déclare officielle">
        Vérifie qu’il ne s’agit pas d’un bot Kotbo que tu héberges : le mode « Arrêt du bot » le couperait. Ce
        statut est déclaré par le bot lui-même, il peut être faux.
      </Callout>
    {/if}

    <fieldset class="space-y-2">
      <legend class="field-label mb-2">Que doit faire le bot ?</legend>
      {#each [
        { value: 'DISABLE_FEATURES', title: 'Désactiver les fonctions', text: 'Le bot reste en ligne mais répond à chaque commande que l’instance a été désactivée. Aucune exception, même pour son propriétaire.' },
        { value: 'SHUTDOWN', title: 'Arrêter le bot', text: 'Le processus s’arrête dès le ping suivant, et à chaque redémarrage tant que le ban reste actif.' },
      ] as option (option.value)}
        <label
          class="flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors
            {banMode === option.value ? 'border-primary bg-primary/5' : 'border-outline-variant hover:bg-surface-container/60'}"
        >
          <input
            type="radio"
            name="ban-mode"
            value={option.value}
            checked={banMode === option.value}
            onchange={() => (banMode = option.value as InstanceBanMode)}
            class="mt-1 accent-(--primary-color)"
          />
          <span>
            <span class="block text-body-sm font-semibold text-on-surface">{option.title}</span>
            <span class="block text-body-sm text-on-surface-variant mt-0.5">{option.text}</span>
          </span>
        </label>
      {/each}
    </fieldset>

    <Field label="Raison" hint="Visible dans les journaux du bot banni et dans le journal d’audit.">
      {#snippet children(id, describedBy)}
        <textarea
          {id}
          aria-describedby={describedBy}
          class="input min-h-20"
          maxlength="300"
          placeholder="Licence non réglée depuis le 1er septembre…"
          bind:value={banReason}
        ></textarea>
      {/snippet}
    </Field>
  </div>

  {#snippet footer()}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => (banModalOpen = false)}>Annuler</Button>
      <Button variant="danger" icon="Ban" loading={banning} onclick={confirmBan}>
        {banMode === 'SHUTDOWN' ? 'Arrêter le bot' : 'Désactiver les fonctions'}
      </Button>
    </div>
  {/snippet}
</Modal>
