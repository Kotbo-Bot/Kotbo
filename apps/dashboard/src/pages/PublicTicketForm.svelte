<script lang="ts">
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import { API_BASE_URL } from '../lib/api/client';
  import { Button, Callout, SectionCard } from '../lib/components/ui';
  import Papicon from '../lib/components/Papicon.svelte';

  const parts = $derived($router.path.split('/').filter(Boolean));
  const isTrackMode = $derived(parts[1] === 'track' && !!parts[2]);
  const guildId = $derived(!isTrackMode ? (parts[1] ?? '') : '');
  const trackToken = $derived(isTrackMode ? (parts[2] ?? '') : '');

  let loading = $state(true);
  let error = $state('');
  let info = $state<{
    guildName: string;
    iconUrl: string | null;
    enabled: boolean;
    title: string;
    description: string;
    ticketTypes: Array<{ id: string; name: string; description: string; emoji: string }>;
  } | null>(null);

  let name = $state('');
  let email = $state('');
  let discordId = $state('');
  let ticketTypeId = $state('');
  let subject = $state('');
  let description = $state('');
  let submitting = $state(false);
  let createdToken = $state('');
  let createdTicketId = $state('');

  const STATUS_LABEL: Record<string, string> = {
    PENDING: 'En attente de validation',
    OPEN: 'Ouvert',
    CLAIMED: 'Pris en charge',
    CLOSED: 'Fermé',
    ARCHIVED: 'Archivé',
    REJECTED: 'Refusé',
  };
  let copied = $state(false);
  const trackUrl = $derived(createdToken ? `${window.location.origin}/support/track/${createdToken}` : '');
  async function copyTrackUrl() {
    try {
      await navigator.clipboard.writeText(trackUrl);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      /* presse-papiers indisponible : le lien reste affiché et sélectionnable */
    }
  }

  let trackedTicket = $state<any>(null);
  let replyContent = $state('');
  let replying = $state(false);

  async function loadPage() {
    loading = true;
    error = '';
    try {
      if (isTrackMode && trackToken) {
        const res = await fetch(`${API_BASE_URL}/api/public/tickets/track/${encodeURIComponent(trackToken)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Ticket introuvable');
        trackedTicket = data.ticket;
      } else if (guildId) {
        const res = await fetch(`${API_BASE_URL}/api/public/tickets/${encodeURIComponent(guildId)}/info`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Serveur introuvable');
        info = data;
        if (data.ticketTypes?.length && !ticketTypeId) {
          ticketTypeId = data.ticketTypes[0].id;
        }
      }
    } catch (err: any) {
      error = err?.message || 'Impossible de charger la page.';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void loadPage();
  });

  async function submitTicket(event: SubmitEvent) {
    event.preventDefault();
    if (submitting || !guildId) return;
    submitting = true;
    error = '';
    try {
      const res = await fetch(`${API_BASE_URL}/api/public/tickets/${encodeURIComponent(guildId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim() || undefined,
          discordId: discordId.trim() || undefined,
          ticketTypeId: ticketTypeId || undefined,
          subject: subject.trim(),
          description: description.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Impossible de créer le ticket.');
      createdToken = data.trackingToken;
      createdTicketId = data.ticketId;
    } catch (err: any) {
      error = err?.message || 'Erreur lors de la création du ticket.';
    } finally {
      submitting = false;
    }
  }

  async function sendReply(event: SubmitEvent) {
    event.preventDefault();
    if (replying || !trackToken || !replyContent.trim()) return;
    replying = true;
    error = '';
    try {
      const res = await fetch(`${API_BASE_URL}/api/public/tickets/track/${encodeURIComponent(trackToken)}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: replyContent.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Impossible d'envoyer la réponse.");
      trackedTicket = {
        ...trackedTicket,
        messages: [...(trackedTicket?.messages ?? []), data.message],
      };
      replyContent = '';
    } catch (err: any) {
      error = err?.message || "Erreur lors de l'envoi.";
    } finally {
      replying = false;
    }
  }
</script>

<main class="min-h-screen bg-surface text-on-surface px-4 py-10">
  <div class="max-w-2xl mx-auto space-y-6">
    {#if loading}
      <div class="flex items-center justify-center py-20 text-on-surface-variant text-sm">
        <Papicon icon="loader-2" size={18} class="animate-spin mr-2" />
        Chargement…
      </div>
    {:else if isTrackMode && trackedTicket}
      <header class="flex items-center justify-between gap-4">
        <div>
          <p class="text-xs font-medium text-on-surface-variant">{trackedTicket.guildName}</p>
          <h1 class="text-xl font-semibold text-on-surface">{trackedTicket.reason}</h1>
        </div>
        <span class="px-2.5 py-1 rounded-full text-xs font-semibold bg-primary/15 text-primary">
          {STATUS_LABEL[trackedTicket.status] ?? trackedTicket.status}
        </span>
      </header>

      {#if error}
        <Callout variant="danger">{error}</Callout>
      {/if}

      <SectionCard title="Échanges" icon="message-square">
        <div class="space-y-3 p-4">
          {#each trackedTicket.messages as msg (msg.id)}
            <div class="rounded-lg border border-outline-variant p-3 {msg.isStaff ? 'bg-primary/5 border-primary/25' : 'bg-surface-container-low'}">
              <div class="flex items-center justify-between gap-2 text-xs text-on-surface-variant mb-1">
                <span class="font-semibold text-on-surface">{msg.authorName} {msg.isStaff ? '· Staff' : ''}</span>
                <span>{new Date(msg.createdAt).toLocaleString('fr-FR')}</span>
              </div>
              <p class="text-sm whitespace-pre-wrap text-on-surface">{msg.content}</p>
            </div>
          {/each}

          <form onsubmit={sendReply} class="pt-3 border-t border-outline-variant space-y-3">
            <textarea
              bind:value={replyContent}
              rows={3}
              required
              placeholder="Ajouter une réponse…"
              class="w-full rounded-lg border border-field-border bg-surface-container-lowest px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:border-primary resize-y"
            ></textarea>
            <div class="flex justify-end">
              <Button type="submit" variant="primary" loading={replying}>Envoyer</Button>
            </div>
          </form>
        </div>
      </SectionCard>
    {:else if createdToken}
      <SectionCard title="Demande enregistrée" icon="check-circle">
        <div class="p-5 space-y-4">
          <Callout variant="success" title="Ticket créé (#{createdTicketId.slice(-6)})">
            Conservez le lien ci-dessous pour suivre l'avancement de votre demande et répondre au staff.
          </Callout>
          <div class="flex flex-wrap items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2 text-xs font-mono">
            <span class="truncate flex-1 min-w-0 select-all">{trackUrl}</span>
            <Button size="sm" variant="ghost" onclick={copyTrackUrl}>{copied ? 'Copié' : 'Copier'}</Button>
            <Button size="sm" variant="primary" onclick={() => router.goto(`/support/track/${createdToken}`)}>
              Suivre mon ticket
            </Button>
          </div>
          {#if !email.trim()}
            <p class="text-xs text-on-surface-variant">Sans e-mail, ce lien est le seul moyen de retrouver votre demande : enregistrez-le maintenant.</p>
          {/if}
        </div>
      </SectionCard>
    {:else if info}
      <header class="flex items-center gap-3">
        {#if info.iconUrl}
          <img src={info.iconUrl} alt="" class="w-11 h-11 rounded-xl object-cover border border-outline-variant" />
        {/if}
        <div>
          <p class="text-xs font-medium text-on-surface-variant">{info.guildName}</p>
          <h1 class="text-xl font-semibold text-on-surface">{info.title}</h1>
        </div>
      </header>

      {#if !info.enabled}
        <Callout variant="warning">Le formulaire web de support est actuellement fermé sur ce serveur.</Callout>
      {:else}
        {#if error}
          <Callout variant="danger">{error}</Callout>
        {/if}
        <SectionCard title="Nouveau ticket" description={info.description || 'Décrivez votre demande sans passer par Discord.'} icon="life-buoy">
          <form onsubmit={submitTicket} class="p-5 space-y-4">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label for="sup-name" class="field-label">Nom ou pseudo *</label>
                <input id="sup-name" bind:value={name} required maxlength={80} class="input w-full" placeholder="Votre nom" />
              </div>
              <div>
                <label for="sup-email" class="field-label">E-mail de suivi</label>
                <input id="sup-email" type="email" bind:value={email} maxlength={160} class="input w-full" placeholder="vous@exemple.fr" />
              </div>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label for="sup-discord" class="field-label">ID Discord (optionnel, indicatif)</label>
                <input id="sup-discord" bind:value={discordId} maxlength={20} class="input w-full font-mono" placeholder="Ex. 123456789012345678" />
              </div>
              {#if info.ticketTypes.length > 0}
                <div>
                  <label for="sup-type" class="field-label">Catégorie</label>
                  <select id="sup-type" bind:value={ticketTypeId} class="input w-full">
                    {#each info.ticketTypes as t (t.id)}
                      <option value={t.id}>{t.name}</option>
                    {/each}
                  </select>
                </div>
              {/if}
            </div>

            <div>
              <label for="sup-subject" class="field-label">Objet *</label>
              <input id="sup-subject" bind:value={subject} required maxlength={200} class="input w-full" placeholder="Résumé de votre demande" />
            </div>

            <div>
              <label for="sup-desc" class="field-label">Description *</label>
              <textarea
                id="sup-desc"
                bind:value={description}
                required
                rows={5}
                maxlength={4000}
                class="w-full rounded-lg border border-field-border bg-surface-container-lowest px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:border-primary resize-y"
                placeholder="Détaillez votre situation…"
              ></textarea>
            </div>

            <div class="flex justify-end">
              <Button type="submit" variant="primary" loading={submitting}>Envoyer la demande</Button>
            </div>
          </form>
        </SectionCard>
      {/if}
    {:else}
      <Callout variant="danger">{error || 'Page introuvable.'}</Callout>
    {/if}
  </div>
</main>
