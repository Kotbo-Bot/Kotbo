<script lang="ts">
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
  import Papicon from '../../lib/components/Papicon.svelte';
  import { Button, Callout, EmptyState, Field, FilterPills, Modal, SectionCard } from '../../lib/components/ui';
  import { errorMessage } from '@kotbo/shared';

  type Filter = 'all' | 'selfhost' | 'banned';

  let instances = $state<BotInstance[]>([]);
  let orphanBans = $state<OrphanInstanceBan[]>([]);
  let loading = $state(true);
  let refreshing = $state(false);
  let loadError = $state<string | null>(null);

  let filter = $state<Filter>('selfhost');
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
  });

  const visible = $derived.by(() => {
    const q = search.trim().toLowerCase();
    return instances.filter((i) => {
      if (filter === 'selfhost' && !i.isSelfHosted) return false;
      if (filter === 'banned' && !i.banned) return false;
      if (!q) return true;
      return (
        i.botName.toLowerCase().includes(q) ||
        i.botClientId.includes(q) ||
        (i.dashboardUrl ?? '').toLowerCase().includes(q)
      );
    });
  });

  async function load() {
    try {
      const data = await fetchBotInstances();
      instances = data.instances;
      orphanBans = data.orphanBans ?? [];
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
      toast.success(`${banTarget.botName} sera coupé à son prochain ping.`);
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
      toast.success(`${name} est débanni.`);
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

  {#if loading}
    <SectionCard title="Instances" flush>
      <div class="animate-pulse space-y-3 p-5">
        <div class="h-12 bg-surface-container rounded-lg"></div>
        <div class="h-12 bg-surface-container rounded-lg"></div>
        <div class="h-12 bg-surface-container rounded-lg"></div>
      </div>
    </SectionCard>
  {:else if loadError}
    <Callout variant="danger" title="Impossible de charger les instances">
      {loadError}
      {#snippet actions()}
        <Button size="sm" icon="RefreshCw" onclick={refresh}>Réessayer</Button>
      {/snippet}
    </Callout>
  {:else}
    <div class="flex flex-wrap items-center justify-between gap-3">
      <FilterPills
        label="Filtrer les instances"
        value={filter}
        onchange={(v) => (filter = v)}
        options={[
          { value: 'selfhost', label: 'Self-host', count: counts.selfhost },
          { value: 'banned', label: 'Bannies', count: counts.banned },
          { value: 'all', label: 'Toutes', count: counts.all },
        ]}
      />
      <input
        type="search"
        class="input w-full sm:w-72"
        placeholder="Nom, ID du bot ou URL…"
        aria-label="Rechercher une instance"
        bind:value={search}
      />
    </div>

    <SectionCard title="Instances" description="Une instance sans ping depuis 48 h disparaît de cette liste." flush>
      {#if visible.length === 0}
        <EmptyState
          icon="Server"
          title={instances.length === 0 ? 'Aucune instance n’a encore pingué' : 'Aucune instance ne correspond'}
          description={instances.length === 0
            ? 'Les bots envoient leurs statistiques au démarrage puis toutes les 15 minutes.'
            : 'Change de filtre ou de recherche.'}
        />
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-left text-body-sm">
            <thead class="text-xs font-medium text-on-surface-variant border-b border-outline-variant">
              <tr>
                <th class="px-5 py-3 font-medium">Bot</th>
                <th class="px-5 py-3 font-medium">Serveurs</th>
                <th class="px-5 py-3 font-medium">Membres</th>
                <th class="px-5 py-3 font-medium">Version</th>
                <th class="px-5 py-3 font-medium">Dernier ping</th>
                <th class="px-5 py-3 font-medium">État</th>
                <th class="px-5 py-3 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-outline-variant/40">
              {#each visible as inst (inst.id)}
                <tr class="hover:bg-surface-container/60 transition-colors">
                  <td class="px-5 py-3">
                    <div class="flex items-center gap-3 min-w-0">
                      {#if inst.botAvatarUrl}
                        <img src={inst.botAvatarUrl} alt="" class="w-8 h-8 rounded-full shrink-0 bg-surface-container" loading="lazy" />
                      {:else}
                        <span class="w-8 h-8 rounded-full shrink-0 bg-surface-container flex items-center justify-center text-on-surface-variant">
                          <Papicon icon="Server" size={14} />
                        </span>
                      {/if}
                      <div class="min-w-0">
                        <p class="font-semibold text-on-surface truncate flex items-center gap-2">
                          {inst.botName}
                          {#if !inst.isSelfHosted}
                            <span class="badge badge-info">Officielle</span>
                          {/if}
                        </p>
                        <p class="text-2xs font-mono text-on-surface-variant truncate">{inst.botClientId}</p>
                        {#if inst.dashboardUrl}
                          <p class="text-2xs text-on-surface-variant truncate max-w-64" title={inst.dashboardUrl}>{inst.dashboardUrl}</p>
                        {/if}
                      </div>
                    </div>
                  </td>
                  <td class="px-5 py-3 tabular-nums text-on-surface">{nf.format(inst.guildCount)}</td>
                  <td class="px-5 py-3 tabular-nums text-on-surface">{nf.format(inst.userCount)}</td>
                  <td class="px-5 py-3 font-mono text-xs text-on-surface-variant">{inst.version ?? '–'}</td>
                  <td class="px-5 py-3">
                    <span class="badge {inst.status === 'online' ? 'badge-success' : 'badge-neutral'}" title={formatDate(inst.lastPingAt)}>
                      {inst.status === 'online' ? 'En ligne' : 'Silencieuse'}
                    </span>
                    <p class="text-2xs text-on-surface-variant mt-1">{relativeTime(inst.lastPingAt)}</p>
                  </td>
                  <td class="px-5 py-3">
                    {#if inst.ban}
                      <span class="badge badge-danger">{MODE_LABEL[inst.ban.mode]}</span>
                      <p class="text-2xs text-on-surface-variant mt-1" title={inst.ban.reason ?? ''}>
                        depuis le {formatDate(inst.ban.createdAt)}
                      </p>
                      {#if inst.ban.reason}
                        <p class="text-2xs text-on-surface-variant truncate max-w-56" title={inst.ban.reason}>{inst.ban.reason}</p>
                      {/if}
                    {:else}
                      <span class="badge badge-neutral">Actif</span>
                    {/if}
                  </td>
                  <td class="px-5 py-3 text-right whitespace-nowrap">
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
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </SectionCard>

    {#if orphanBans.length > 0}
      <SectionCard
        title="Bans sans ping récent"
        description="Ces instances sont toujours bannies mais n’ont pas pingué depuis plus de 48 h, souvent parce qu’elles ont été arrêtées."
        flush
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
      </SectionCard>
    {/if}
  {/if}
</AdminShell>

<Modal
  bind:open={banModalOpen}
  title={banTarget ? `Bannir ${banTarget.botName}` : 'Bannir'}
  subtitle={banTarget?.botClientId}
>
  <div class="p-5 space-y-5">
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
          class="flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors
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
