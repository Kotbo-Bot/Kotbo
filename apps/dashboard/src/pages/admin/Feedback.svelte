<script lang="ts">
  /**
   * Retours envoyés depuis le dashboard (bugs, suggestions, avis).
   *
   * L'admin change le statut (pris en compte, prévu, fait, refusé) et discute
   * avec l'auteur : chaque statut ou réponse lui arrive en MP et dans « Mes
   * retours ». Les retours antérieurs à cette page n'étaient pas conservés.
   */
  import { onMount } from 'svelte';
  import { toast } from '../../lib/stores/toast.svelte';
  import {
    FEEDBACK_STATUS_ORDER,
    fetchAdminFeedbacks,
    fetchFeedback,
    replyToFeedback,
    setFeedbackStatus,
    type AdminFeedbackSummary,
    type FeedbackDetail,
    type FeedbackStatus,
  } from '../../lib/api';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import AdminBadge from '../../lib/components/admin/AdminBadge.svelte';
  import AdminDrawer from '../../lib/components/admin/AdminDrawer.svelte';
  import FormTextarea from '../../lib/components/FormTextarea.svelte';
  import { Button, EmptyState, FilterPills } from '../../lib/components/ui';
  import type { AdminTone } from '../../lib/components/admin/types';

  const STATUS: Record<FeedbackStatus, { label: string; tone: AdminTone }> = {
    NEW: { label: 'Nouveau', tone: 'info' },
    ACKNOWLEDGED: { label: 'Pris en compte', tone: 'primary' },
    PLANNED: { label: 'Prévu', tone: 'warning' },
    DONE: { label: 'Fait', tone: 'success' },
    DECLINED: { label: 'Refusé', tone: 'neutral' },
  };
  const TYPES: Record<string, string> = {
    retour: 'Retour',
    bloquage: 'Bug',
    suggestion: 'Suggestion',
    autre: 'Autre',
  };

  let feedbacks = $state<AdminFeedbackSummary[]>([]);
  let loading = $state(true);
  let statusFilter = $state('');
  let typeFilter = $state('');

  let open = $state(false);
  let detail = $state<FeedbackDetail | null>(null);
  let reply = $state('');
  let busy = $state(false);

  async function load() {
    loading = true;
    try {
      feedbacks = (await fetchAdminFeedbacks({ status: statusFilter || undefined, type: typeFilter || undefined })).feedbacks;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Chargement impossible');
    } finally {
      loading = false;
    }
  }

  onMount(load);

  async function openDetail(id: string) {
    reply = '';
    try {
      detail = (await fetchFeedback(id)).feedback;
      open = true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Chargement impossible');
    }
  }

  /** Recharge la fiche ouverte et la ligne de la liste après une action. */
  async function refreshDetail() {
    if (!detail) return;
    detail = (await fetchFeedback(detail.id)).feedback;
    await load();
  }

  async function sendReply() {
    if (!detail || !reply.trim() || busy) return;
    busy = true;
    try {
      await replyToFeedback(detail.id, reply.trim());
      reply = '';
      await refreshDetail();
      toast.success('Réponse envoyée');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Envoi impossible');
    } finally {
      busy = false;
    }
  }

  /** Change le statut ; le texte saisi, s'il y en a un, part avec comme réponse. */
  async function changeStatus(status: FeedbackStatus) {
    if (!detail || busy || detail.status === status) return;
    busy = true;
    try {
      await setFeedbackStatus(detail.id, status, reply.trim() || undefined);
      reply = '';
      await refreshDetail();
      toast.success(`Statut : ${STATUS[status].label}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Changement impossible');
    } finally {
      busy = false;
    }
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
</script>

<AdminShell
  title="Retours"
  description="Bugs, suggestions et avis envoyés depuis le dashboard. Change le statut et discute avec l’auteur : il est prévenu en MP à chaque réponse."
>
  {#snippet actions()}
    <Button icon="RefreshCw" {loading} onclick={load}>Actualiser</Button>
  {/snippet}

  <div class="flex flex-wrap gap-3">
    <FilterPills
      label="Statut"
      value={statusFilter}
      onchange={(v) => { statusFilter = v; void load(); }}
      options={[{ value: '', label: 'Tous' }, ...FEEDBACK_STATUS_ORDER.map((s) => ({ value: s, label: STATUS[s].label }))]}
    />
    <FilterPills
      label="Type"
      value={typeFilter}
      onchange={(v) => { typeFilter = v; void load(); }}
      options={[{ value: '', label: 'Tous' }, ...Object.entries(TYPES).map(([value, label]) => ({ value, label }))]}
    />
  </div>

  {#if loading}
    <div class="space-y-2">
      {#each Array(6) as _, index (index)}
        <div class="h-16 rounded-2xl bg-on-surface/6 animate-pulse"></div>
      {/each}
    </div>
  {:else if feedbacks.length === 0}
    <EmptyState
      icon="MessageSquare"
      title="Aucun retour"
      description="Les retours envoyés depuis le dashboard apparaissent ici. Ceux d’avant cette page n’ont pas été conservés."
      reason="nothing-matches"
    />
  {:else}
    <ul class="space-y-1.5">
      {#each feedbacks as item (item.id)}
        <li>
          <button
            type="button"
            onclick={() => openDetail(item.id)}
            class="w-full text-left rounded-xl border border-outline-variant/25 bg-surface-container-lowest/70 p-3 flex flex-col gap-1.5
              hover:border-primary/35 hover:bg-surface-container-low/60 transition focus-visible:outline-2 focus-visible:outline-primary"
          >
            <div class="flex flex-wrap items-center gap-2">
              <AdminBadge label={STATUS[item.status].label} tone={STATUS[item.status].tone} size="sm" />
              <AdminBadge label={TYPES[item.type] ?? item.type} size="sm" />
              <span class="text-xs font-medium text-on-surface">{item.username}</span>
              <span class="ml-auto text-2xs text-on-surface-variant tabular-nums">{formatDate(item.createdAt)}</span>
            </div>
            <p class="text-body-sm text-on-surface line-clamp-2">{item.message}</p>
            {#if item._count.messages > 0}
              <p class="text-2xs text-on-surface-variant">{item._count.messages} message{item._count.messages > 1 ? 's' : ''} dans la conversation</p>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</AdminShell>

<AdminDrawer bind:open width="md" title={detail ? `Retour de ${detail.username}` : 'Retour'} subtitle={detail ? (TYPES[detail.type] ?? detail.type) : ''}>
  {#if detail}
    <div class="space-y-4">
      <div class="rounded-xl border border-outline-variant/25 bg-surface-container-low/40 p-3.5 space-y-2">
        <p class="text-body-sm text-on-surface leading-relaxed whitespace-pre-wrap break-words">{detail.message}</p>
        <p class="text-2xs text-on-surface-variant break-all">{detail.url}{detail.guildId ? ` · serveur ${detail.guildId}` : ''} · {formatDate(detail.createdAt)}</p>
      </div>

      <div class="flex flex-wrap gap-1.5" role="group" aria-label="Statut du retour">
        {#each FEEDBACK_STATUS_ORDER as status (status)}
          <button
            type="button"
            disabled={busy}
            aria-pressed={detail.status === status}
            onclick={() => changeStatus(status)}
            class="rounded-full border px-3 h-7 text-xs font-semibold transition disabled:opacity-60
              {detail.status === status ? 'border-primary bg-primary/12 text-primary' : 'border-outline-variant/30 text-on-surface-variant hover:border-primary/40'}"
          >
            {STATUS[status].label}
          </button>
        {/each}
      </div>

      <ul class="space-y-2">
        {#each detail.messages as message (message.id)}
          <li class="rounded-xl border p-3 text-body-sm {message.fromStaff ? 'border-primary/25 bg-primary/6 ml-6' : 'border-outline-variant/25 bg-surface-container-lowest/70 mr-6'}">
            <p class="text-2xs font-semibold text-on-surface-variant mb-1">
              {message.fromStaff ? `Équipe · ${message.authorName}` : message.authorName} · {formatDate(message.createdAt)}
            </p>
            <p class="text-on-surface whitespace-pre-wrap break-words">{message.content}</p>
          </li>
        {/each}
      </ul>

      <div class="space-y-2">
        <FormTextarea
          bind:value={reply}
          rows={3}
          placeholder="Réponse à l’auteur (envoyée aussi par MP)…"
          disabled={busy}
          className="w-full rounded-lg border border-field-border bg-surface-container-low px-3 py-2 text-sm text-on-surface"
        />
        <div class="flex items-center justify-between gap-2">
          <span class="text-2xs text-on-surface-variant">Un statut choisi ci-dessus envoie aussi ce texte.</span>
          <Button icon="Send" loading={busy} disabled={!reply.trim()} disabledReason="Écris un message" onclick={sendReply}>Répondre</Button>
        </div>
      </div>
    </div>
  {/if}
</AdminDrawer>
