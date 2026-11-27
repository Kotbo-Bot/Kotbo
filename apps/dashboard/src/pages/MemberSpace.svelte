<script lang="ts">
  /**
   * Espace d'un membre sans role de staff : sa fiche et sa carte `/rank`.
   *
   * Pas de barre laterale : elle ne liste que des pages de pilotage, toutes
   * fermees a ce compte. L'en-tete n'apparait que si la personne est staff sur
   * un autre serveur Kotbo - il lui sert alors a y retourner.
   *
   * Les textes restent au vouvoiement : ils s'adressent aux membres, pas au staff.
   */
  import { authStore } from '../lib/stores/auth.svelte';
  import { API_BASE_URL, authorizedFetch } from '../lib/api/client';
  import { toast } from '../lib/stores/toast.svelte';
  import { m } from '../lib/i18n';
  import { Button, Callout, SectionCard, ToggleSwitch, ListGroup, ListRow } from '../lib/components/ui';
  import { resolveUserAvatarSrc } from '../lib/discordMedia';
  import Navbar from '../lib/components/Navbar.svelte';
  import ServerSwitcherModal from '../lib/components/ServerSwitcherModal.svelte';
  import RankCardCustomizer from '../lib/components/RankCardCustomizer.svelte';
  import SiteEditorSpace from '../lib/components/site/SiteEditorSpace.svelte';

  const BIO_MAX = 500;

  const userId = $derived(authStore.user?.id ?? '');
  const hasDashboard = $derived(authStore.guilds.length > 0);

  let loading = $state(true);
  let saving = $state(false);
  let missingProfile = $state(false);
  let bio = $state('');
  let isPublic = $state(false);
  let saved = $state({ bio: '', isPublic: false });

  // Tickets du membre (Discord + hors Discord)
  let myTickets = $state<any[]>([]);
  let ticketsLoading = $state(false);
  let selectedTicket = $state<any>(null);
  let ticketReply = $state('');
  let ticketReplying = $state(false);

  async function loadMyTickets() {
    ticketsLoading = true;
    try {
      const res = await authorizedFetch(`${API_BASE_URL}/api/user/me/tickets`);
      if (res.ok) {
        const data = await res.json();
        myTickets = data.tickets ?? [];
      }
    } catch { /* ignored */ }
    finally {
      ticketsLoading = false;
    }
  }

  const TICKET_STATUS: Record<string, () => string> = {
    PENDING: m.e1_tickets_status_pending,
    OPEN: m.e1_tickets_status_open,
    CLAIMED: m.e1_tickets_status_claimed,
    CLOSED: m.e1_tickets_status_closed,
    ARCHIVED: m.e1_tickets_status_archived,
    REJECTED: m.e1_tickets_status_rejected,
  };

  async function openMyTicket(ticketId: string) {
    // Un second clic sur le ticket ouvert le referme.
    if (selectedTicket?.id === ticketId) {
      selectedTicket = null;
      return;
    }
    ticketReply = '';
    try {
      const res = await authorizedFetch(`${API_BASE_URL}/api/user/me/tickets/${ticketId}`);
      if (res.ok) {
        const data = await res.json();
        selectedTicket = data.ticket;
      }
    } catch {
      toast.error(m.common_error());
    }
  }

  async function sendTicketReply(event: SubmitEvent) {
    event.preventDefault();
    if (!selectedTicket || !ticketReply.trim() || ticketReplying) return;
    ticketReplying = true;
    try {
      const res = await authorizedFetch(`${API_BASE_URL}/api/user/me/tickets/${selectedTicket.id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: ticketReply.trim() }),
      });
      if (!res.ok) throw new Error('reply failed');
      const data = await res.json();
      selectedTicket = {
        ...selectedTicket,
        messages: [...(selectedTicket.messages ?? []), data.message],
      };
      ticketReply = '';
      toast.success(m.toast_reply_sent());
    } catch {
      toast.error(m.common_error());
    } finally {
      ticketReplying = false;
    }
  }

  const dirty = $derived(bio.trim() !== saved.bio || isPublic !== saved.isPublic);

  $effect(() => {
    if (userId) {
      void load(userId);
      void loadMyTickets();
    }
  });

  async function load(id: string) {
    loading = true;
    try {
      const response = await authorizedFetch(`${API_BASE_URL}/api/public/profile/${id}`);
      if (!response.ok) throw new Error(String(response.status));
      const profile = await response.json();
      bio = profile.bio ?? '';
      isPublic = profile.isPrivate === false;
      saved = { bio: bio.trim(), isPublic };
    } catch {
      toast.error(m.me_load_error());
    } finally {
      loading = false;
    }
  }

  async function save() {
    if (!userId || saving) return;
    saving = true;
    try {
      const response = await authorizedFetch(`${API_BASE_URL}/api/public/profile/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bio: bio.trim() || null, isProfilePrivate: !isPublic }),
      });
      // Pas de ligne de profil tant que le bot n'a jamais vu la personne ecrire :
      // la lecture rend alors un profil reconstitue, l'ecriture un 404.
      if (response.status === 404) {
        missingProfile = true;
        return;
      }
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json();
      bio = data.profile?.bio ?? '';
      isPublic = data.profile?.isProfilePrivate === false;
      saved = { bio: bio.trim(), isPublic };
      toast.success(m.me_saved());
    } catch {
      toast.error(m.me_save_error());
    } finally {
      saving = false;
    }
  }
</script>

{#if hasDashboard}
  <Navbar standalone />
  <ServerSwitcherModal />
{/if}

<main id="main-content" class="min-h-screen bg-background text-on-background">
  <div class="mx-auto w-full max-w-2xl px-4 sm:px-6 py-8 space-y-6">
    <!-- Qui je suis, avant tout réglage. -->
    <header class="flex flex-col items-center gap-3 text-center">
      <img
        src={resolveUserAvatarSrc(authStore.user?.id, authStore.user?.avatar)}
        alt=""
        width="88"
        height="88"
        class="h-22 w-22 rounded-full object-cover bg-surface-container ring-4 ring-surface-container-lowest shadow-md"
      />
      <div class="min-w-0 max-w-full">
        <h1 class="text-2xl font-bold tracking-tight text-on-surface font-headline leading-tight">{m.me_title()}</h1>
        {#if authStore.user?.username}
          <p class="mt-0.5 text-sm font-semibold text-on-surface truncate">@{authStore.user.username}</p>
        {/if}
        <p class="mx-auto mt-1 max-w-md text-sm text-on-surface-variant">{m.me_subtitle()}</p>
      </div>
      <div class="flex flex-wrap items-center justify-center gap-2">
        {#if userId}
          <Button href={`/profile/${userId}`} size="sm" variant="secondary" icon="user">{m.me_view_public()}</Button>
        {/if}
        {#if hasDashboard}
          <Button href="/" size="sm" variant="ghost" icon="arrow-left">{m.me_back_dashboard()}</Button>
        {:else}
          <Button size="sm" variant="ghost" icon="log-out" onclick={() => authStore.logout()}>{m.navbar_logout()}</Button>
        {/if}
      </div>
    </header>

    {#if !hasDashboard}
      <!-- Compte sans serveur Kotbo : c'est souvent quelqu'un qui vient l'installer. -->
      <section class="section-card flex flex-col items-center gap-3 p-6 text-center">
        <h2 class="text-lg font-bold text-on-surface font-headline">{m.me_manage_server()}</h2>
        <p class="max-w-md text-sm text-on-surface-variant">{m.me_manage_server_desc()}</p>
        <Button href="/servers" variant="primary" iconRight="arrow-right">{m.me_add_kotbo_cta()}</Button>
      </section>
    {/if}

    {#if loading}
      <div class="section-card p-5 space-y-4 animate-pulse" aria-busy="true">
        <div class="h-28 rounded-xl bg-surface-container"></div>
        <div class="h-10 rounded-xl bg-surface-container"></div>
      </div>
    {:else}
      <ListGroup title={m.me_profile_title()} footer={m.me_profile_desc()}>
        <div class="p-4">
          <div class="flex items-baseline justify-between gap-3">
            <label for="me-bio" class="list-row__label">{m.me_bio_label()}</label>
            <span class="text-xs tabular-nums text-on-surface-variant">{bio.length}/{BIO_MAX}</span>
          </div>
          <textarea
            id="me-bio"
            bind:value={bio}
            maxlength={BIO_MAX}
            rows={4}
            placeholder={m.me_bio_ph()}
            class="input mt-2 w-full resize-y text-sm"
          ></textarea>
        </div>

        <ListRow icon="Globe" label={m.me_public_label()} description={m.me_public_desc()}>
          <ToggleSwitch checked={isPublic} onToggle={(value) => (isPublic = value)} ariaLabel={m.me_public_label()} />
        </ListRow>

        {#if missingProfile}
          <div class="p-4"><Callout variant="info">{m.me_no_profile()}</Callout></div>
        {/if}

        <!-- Le bouton n'apparaît que lorsqu'il y a quelque chose à enregistrer. -->
        {#if dirty && !missingProfile}
          <div class="flex flex-wrap items-center justify-end gap-2 px-4 py-3">
            <Button variant="ghost" size="sm" onclick={() => { bio = saved.bio; isPublic = saved.isPublic; }}>{m.common_cancel()}</Button>
            <Button variant="primary" size="sm" onclick={save} loading={saving}>{m.me_save()}</Button>
          </div>
        {/if}
      </ListGroup>
    {/if}

    <SectionCard title="Mes tickets" description="Suivez vos demandes et répondez au staff depuis le web" icon="life-buoy" flush>
      <div class="p-4 space-y-4">
        {#if ticketsLoading}
          <p class="text-sm text-on-surface-variant">Chargement de vos tickets…</p>
        {:else if myTickets.length === 0}
          <p class="text-sm text-on-surface-variant">Vous n'avez aucun ticket pour le moment.</p>
        {:else}
          <div class="divide-y divide-outline-variant rounded-lg border border-outline-variant overflow-hidden">
            {#each myTickets as tk (tk.id)}
              <button
                type="button"
                onclick={() => void openMyTicket(tk.id)}
                class="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-surface-container-low transition-colors {selectedTicket?.id === tk.id ? 'bg-primary/5' : ''}"
              >
                <div class="min-w-0">
                  <p class="text-sm font-medium text-on-surface truncate">{tk.reason}</p>
                  <p class="text-xs text-on-surface-variant">{tk.guildName} · {new Date(tk.createdAt).toLocaleDateString('fr-FR')}</p>
                </div>
                <span class="shrink-0 px-2 py-0.5 rounded-full text-2xs font-semibold bg-surface-container-high text-on-surface-variant">
                  {TICKET_STATUS[tk.status]?.() ?? tk.status}
                </span>
              </button>
            {/each}
          </div>
        {/if}

        {#if selectedTicket}
          <div class="rounded-xl border border-outline-variant bg-surface-container-low p-4 space-y-3">
            <div class="flex items-center justify-between gap-2">
              <h3 class="text-sm font-semibold text-on-surface">{selectedTicket.reason}</h3>
              <button type="button" class="text-xs text-on-surface-variant hover:text-on-surface" onclick={() => (selectedTicket = null)}>Fermer</button>
            </div>
            <div class="space-y-2 max-h-64 overflow-y-auto">
              {#each selectedTicket.messages ?? [] as msg (msg.id)}
                <div class="rounded-lg border border-outline-variant p-2.5 text-xs {msg.isStaff ? 'bg-primary/5 border-primary/25' : 'bg-surface-container-lowest'}">
                  <div class="flex justify-between text-on-surface-variant mb-1">
                    <span class="font-semibold text-on-surface">{msg.authorName}</span>
                    <span>{new Date(msg.createdAt).toLocaleString('fr-FR')}</span>
                  </div>
                  <p class="whitespace-pre-wrap text-on-surface">{msg.content}</p>
                </div>
              {/each}
            </div>
            <form onsubmit={sendTicketReply} class="flex gap-2">
              <input bind:value={ticketReply} aria-label={m.a11y_ticket_reply()} placeholder="Répondre à ce ticket…" class="input flex-1 text-sm" required />
              <Button type="submit" size="sm" variant="primary" loading={ticketReplying}>Envoyer</Button>
            </form>
          </div>
        {/if}
      </div>
    </SectionCard>

    <section class="section-card p-5">
      <RankCardCustomizer />
    </section>

    <SiteEditorSpace />

    {#if hasDashboard}
      <ListGroup>
        <ListRow icon="Plus" label={m.me_add_kotbo_cta()} description={m.me_manage_server_desc()} href="/servers" />
      </ListGroup>
    {/if}
  </div>

</main>
