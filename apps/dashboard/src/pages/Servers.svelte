<script lang="ts">
  import { m } from '../lib/i18n';
  /**
   * Mes serveurs : la liste des serveurs Discord que la personne administre,
   * qu'ils aient Kotbo ou non.
   *
   * Le selecteur de serveurs ne montre que les serveurs deja equipes - c'est ce
   * qu'il doit faire, mais on ne peut donc jamais y ajouter le bot ailleurs.
   * Cette page comble le trou : les serveurs sans Kotbo y ont un bouton
   * d'invitation qui preselectionne deja le bon serveur dans la fenetre Discord.
   */
  import { onMount, onDestroy } from 'svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { subscribeRealtime } from '../lib/stores/realtime.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import {
    fetchManageableServers,
    buildBotInviteUrl,
    buildBotInstallUrl,
    ADMIN_INVITE_PERMISSIONS,
    type ManageableServer,
  } from '../lib/api';
  import { resolveGuildIconSrc } from '../lib/discordMedia';
  import { Button, ListGroup, ListRow } from '../lib/components/ui';
  import { brandingStore } from '../lib/stores/branding.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import KotboMark from '../lib/components/onboarding/KotboMark.svelte';
  import BotInviteModal from '../lib/components/onboarding/BotInviteModal.svelte';

  import { DEMO_MODE } from '../lib/demo/mode';
  import { errorMessage } from '@kotbo/shared';
  let servers = $state<ManageableServer[]>([]);
  let clientId = $state('');
  let oauthUnavailable = $state(false);
  let loading = $state(true);
  let query = $state('');

  let inviteModalOpen = $state(false);
  let selectedServerForInvite = $state<ManageableServer | null>(null);

  async function installInDemo(server: ManageableServer) {
    await fetch(`/api/demo/guilds/${server.id}/install`, { method: 'POST' });
    toast.success(m.bim_added_demo_server({ server: server.name }));
    enterServer(server.id);
  }

  /** Serveur dont l'invitation part : le bouton tourne le temps de quitter la page. */
  let leavingFor = $state<string | null>(null);

  /**
   * Un clic, l'écran d'autorisation Discord, puis retour direct sur la prise en
   * main. Les permissions au détail restent un choix à part, sous la liste.
   */
  function install(server: ManageableServer) {
    if (DEMO_MODE) {
      void installInDemo(server);
      return;
    }
    // Domaine perso : autre application Discord, sans retour automatique.
    // L'onglet courant attend donc l'arrivée du bot.
    if (brandingStore.isWhiteLabel) {
      watchForArrival(server.id);
      window.open(buildBotInviteUrl(clientId, ADMIN_INVITE_PERMISSIONS, server.id), '_blank', 'noopener,noreferrer');
      return;
    }
    leavingFor = server.id;
    window.location.href = buildBotInstallUrl(server.id);
  }

  function openInviteModal(server: ManageableServer | null) {
    selectedServerForInvite = server;
    inviteModalOpen = true;
  }

  /** Retour arrière depuis Discord : la page restaurée ne doit pas rester bloquée. */
  function resetLeaving() {
    leavingFor = null;
  }

  const filtered = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return servers;
    return servers.filter((server) => server.name.toLowerCase().includes(needle));
  });

  const equipped = $derived(filtered.filter((server) => server.botPresent));
  const missing = $derived(filtered.filter((server) => !server.botPresent));

  /** Sans identifiant d'application, aucun lien d'invitation n'est constructible. */
  const canInvite = $derived(!!clientId);

  async function load(refresh = false) {
    loading = true;
    try {
      const result = await fetchManageableServers({ refresh });
      applyServers(result);
    } catch (err) {
      toast.error(errorMessage(err) || m.srv_list_unavailable());
      if (servers.length === 0) {
        servers = [];
      }
    } finally {
      loading = false;
    }
  }

  function applyServers(result: Awaited<ReturnType<typeof fetchManageableServers>>) {
    if (result.oauthUnavailable) {
      if (servers.length > 0) {
        toast.error(m.srv_refresh_failed());
        return;
      }
      oauthUnavailable = true;
      clientId = result.clientId;
      servers = [];
      return;
    }

    servers = result.guilds;
    clientId = result.clientId;
    oauthUnavailable = false;
  }

  /**
   * Redemander la liste sans passer par l'ecran de chargement.
   *
   * Un rafraichissement de fond ne doit jamais vider ce qui est affiche : la
   * liste a l'ecran reste valable tant que la nouvelle n'est pas arrivee, et un
   * appel rate n'est pas une raison de la faire disparaitre.
   */
  async function syncServers() {
    try {
      const result = await fetchManageableServers();
      applyServers(result);

      const awaited = pendingGuildId;
      if (awaited && result.guilds.find((guild) => guild.id === awaited)?.botPresent) {
        stopWatching();
        enterServer(awaited);
      }
    } catch {
      // Silencieux : c'est un rafraichissement d'arriere-plan.
    }
  }

  /**
   * Domaine perso seulement : l'autorisation s'ouvre dans un autre onglet et ne
   * renvoie nulle part. On attend donc ici l'arrivee du bot, annoncee par l'API
   * (`bot_guilds_changed`) ; le sondage n'est que le filet.
   */
  let pendingGuildId = $state<string | null>(null);
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const POLL_EVERY_MS = 6000;
  /** Deux minutes : au-dela, l'autorisation a ete abandonnee ou a echoue. */
  const POLL_MAX_TRIES = 20;

  function stopWatching() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    pendingGuildId = null;
  }

  function watchForArrival(guildId: string) {
    stopWatching();
    pendingGuildId = guildId;
    let tries = 0;

    pollTimer = setInterval(() => {
      tries += 1;
      if (tries > POLL_MAX_TRIES) {
        stopWatching();
        return;
      }

      // L'onglet est en arriere-plan pendant l'autorisation : inutile de
      // sonder tant que la personne n'est pas revenue.
      if (document.hidden) return;

      void syncServers();
    }, POLL_EVERY_MS);
  }

  /**
   * L'arrivee ou le depart du bot est annonce a tous les onglets ouverts, sans
   * savoir qui administre quoi : c'est ici qu'on trie. Redemander la liste a
   * chaque serveur qui equipe le bot quelque part dans le monde ferait autant
   * d'appels inutiles.
   *
   * Un serveur en cours d'installation ne figure pas encore comme equipe, mais
   * il est bien dans la liste - elle contient aussi ceux ou le bot manque.
   */
  let unsubscribeRealtime: (() => void) | null = null;

  function concernsMe(guildId: unknown): boolean {
    if (typeof guildId !== 'string') return false;
    return pendingGuildId === guildId || servers.some((server) => server.id === guildId);
  }

  onDestroy(() => {
    stopWatching();
    unsubscribeRealtime?.();
  });

  /**
   * Ouvrir un serveur, quel que soit son etat.
   *
   * Toujours par un rechargement complet, et jamais par `router.goto` :
   * `setGuild` change bien la guilde retenue, mais `dashboardStore` continue de
   * decrire la precedente - son offre, ses modules, et donc la reponse a
   * « ce serveur a-t-il un tableau de bord ou un parcours de configuration ».
   * Depuis un serveur deja paye, la garde aurait laisse passer vers le
   * dashboard complet celui qui venait tout juste d'installer le bot ailleurs.
   *
   * `/` suffit comme destination : un serveur qui n'a rien pris y sera
   * accueilli par son parcours, un serveur equipe par son tableau de bord.
   * C'est la garde qui tranche, pas cette page.
   */
  function enterServer(guildId: string) {
    authStore.setGuild(guildId);
    window.location.href = '/';
  }

  onMount(async () => {
    unsubscribeRealtime = subscribeRealtime({
      types: ['bot_guilds_changed'],
      // La page parle de tous les serveurs, pas de celui qui est selectionne.
      guildScoped: false,
      onUpdate: (event) => {
        // Un rattrapage (reconnexion, retour d'onglet) n'a pas d'evenement :
        // on ne sait pas ce qui a bouge, donc on redemande.
        if (event && !concernsMe(event.guildId)) return;
        void syncServers();
      },
    });

    await load();
  });
</script>

<!--
  Cette page se rend sans MainLayout (voir App.svelte) : elle porte donc
  elle-meme son cadre. Le lien de deconnexion est la pour la meme raison : sans
  barre laterale ni en-tete, c'est la seule sortie de la page.
-->
<svelte:window onpageshow={resetLeaving} />

{#snippet serverIcon(server: ManageableServer)}
  {@const icon = resolveGuildIconSrc(server.id, server.icon)}
  {#if icon}
    <img src={icon} alt="" referrerpolicy="no-referrer" class="w-10 h-10 rounded-full object-cover shrink-0" />
  {:else}
    <span class="icon-disc !w-10 !h-10 text-sm font-bold" aria-hidden="true">{server.name.charAt(0).toUpperCase()}</span>
  {/if}
{/snippet}

<div class="min-h-screen bg-background text-on-background">
  <div class="mx-auto w-full max-w-2xl px-4 sm:px-6 py-8 space-y-6">
    <div class="flex items-center justify-between gap-4">
      <div class="flex items-center gap-2.5">
        <img src="/favicon.svg" alt="" class="w-7 h-7 rounded-lg" />
        <span class="font-semibold tracking-tight text-on-surface">Kotbo</span>
      </div>
      <Button variant="ghost" size="sm" icon="log-out" onclick={() => authStore.logout()}>{m.cp_logout()}</Button>
    </div>

    <header class="text-center">
      <h1 class="text-2xl font-bold tracking-tight text-on-surface font-headline leading-tight">{m.srv_pick_title()}</h1>
      <p class="mx-auto mt-1.5 max-w-md text-sm text-on-surface-variant">{m.srv_pick_desc()}</p>
    </header>

    {#if loading && servers.length === 0}
      <!-- La liste vient de Discord : l'attente se dit, la page vide ferait croire qu'on n'administre rien. -->
      <div class="flex flex-col items-center gap-3 py-8 text-center" role="status">
        <KotboMark size={44} halo />
        <p class="text-sm font-semibold text-on-surface">{m.srv_loading()}</p>
        <p class="text-body-sm text-on-surface-variant">{m.srv_loading_desc()}</p>
      </div>
    {:else if oauthUnavailable}
      <EmptyState
        icon="alert-triangle"
        title={m.srv_oauth_title()}
        description={m.srv_oauth_desc()}
        actionLabel={m.common_retry()}
        onAction={() => void load(true)}
      />
    {:else}
      {#if servers.length > 5}
        <input
          aria-label={m.srv_search_ph()}
          type="search"
          bind:value={query}
          placeholder={m.srv_search_ph()}
          class="input w-full !rounded-full !px-4 h-11 text-sm"
        />
      {/if}

      <!-- Ce pour quoi on vient sur cette page. -->
      <ListGroup title={m.srv_ready_title()}>
        {#each missing as server (server.id)}
          <ListRow label={server.name} description={server.owner ? m.srv_owner() : m.srv_admin()}>
            {#snippet media()}{@render serverIcon(server)}{/snippet}
            {#if canInvite}
              <Button
                variant="primary"
                size="sm"
                icon="Plus"
                loading={leavingFor === server.id || pendingGuildId === server.id}
                aria-label={m.srv_add_named({ server: server.name })}
                onclick={() => install(server)}
              >
                {pendingGuildId === server.id ? m.srv_pending() : m.srv_add()}
              </Button>
            {/if}
          </ListRow>
        {:else}
          <p class="p-4 text-sm text-on-surface-variant">
            {servers.length === 0 ? m.srv_ready_none() : query ? m.d7_no_server_found() : m.srv_ready_all()}
          </p>
        {/each}
      </ListGroup>

      {#if equipped.length > 0}
        <ListGroup title={m.srv_equipped_title()}>
          {#each equipped as server (server.id)}
            <ListRow
              label={server.name}
              description={server.activated ? (server.owner ? m.srv_owner() : m.srv_admin()) : m.srv_awaiting_activation()}
              onclick={() => enterServer(server.id)}
            >
              {#snippet media()}{@render serverIcon(server)}{/snippet}
            </ListRow>
          {/each}
        </ListGroup>
      {/if}

      <ListGroup footer={m.srv_help_footer()}>
        <ListRow icon="refresh-cw" label={m.srv_refresh()} description={m.srv_refresh_desc()} onclick={() => void load(true)} />
        {#if canInvite}
          <ListRow icon="shield" label={m.srv_detailed()} description={m.srv_detailed_desc()} onclick={() => openInviteModal(null)} />
        {/if}
      </ListGroup>
    {/if}
  </div>

  <BotInviteModal
    bind:open={inviteModalOpen}
    guild={selectedServerForInvite}
    {clientId}
    onInviteStarted={(guildId) => {
      if (guildId && brandingStore.isWhiteLabel) watchForArrival(guildId);
    }}
  />
</div>
