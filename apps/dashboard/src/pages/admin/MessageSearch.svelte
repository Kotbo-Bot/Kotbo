<script lang="ts">
  /**
   * Recherche d'un message sur tous les serveurs, pour savoir d'ou il vient.
   * La recherche part a la validation, pas a la frappe : elle est lourde et
   * chaque envoi est inscrit au journal d'audit.
   */
  import { m } from '../../lib/i18n';
  import { searchAdminMessages, type FoundMessage, type MessageSearchResult } from '../../lib/api/adminInsights';
  import { toast } from '../../lib/stores/toast.svelte';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import AdminToolbar from '../../lib/components/admin/AdminToolbar.svelte';
  import AdminBadge from '../../lib/components/admin/AdminBadge.svelte';
  import { Button, EmptyState } from '../../lib/components/ui';

  let search = $state('');
  let submitted = $state('');
  let result = $state<MessageSearchResult | null>(null);
  let loading = $state(false);

  async function load(query: string, offset = 0) {
    if (!query || loading) return;
    loading = true;
    try {
      const page = await searchAdminMessages(query, offset);
      submitted = query;
      result = offset && result ? { ...page, messages: [...result.messages, ...page.messages] } : page;
    } catch (err) {
      if (!offset) result = null;
      toast.error(err instanceof Error ? err.message : m.d7_loading_error());
    } finally {
      loading = false;
    }
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    void load(search.trim());
  }

  const guildName = (message: FoundMessage) => message.guild.name ?? `Serveur ${message.guildId}`;
  const jumpUrl = (message: FoundMessage) =>
    `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.messageId}`;
  const formatDate = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
</script>

<AdminShell
  title="Recherche de messages"
  description="Retrouve de quel serveur vient un message : colle son texte, son lien, son identifiant ou celui de son auteur. Seuls les serveurs qui journalisent leurs messages sont couverts, et chaque recherche est inscrite au journal d’audit."
>
  <form onsubmit={submit}>
    <AdminToolbar bind:search placeholder="Texte (3 caractères minimum), lien, ID de message ou d’auteur…">
      {#snippet actions()}
        <Button type="submit" icon="Search" {loading}>Chercher</Button>
      {/snippet}
    </AdminToolbar>
  </form>

  {#if result?.linkGuild}
    <p class="text-body-sm text-on-surface">
      Ce lien pointe vers
      <a class="font-semibold text-primary underline" href={`/admin/servers/${result.linkGuild.id}`}>{result.linkGuild.name ?? `le serveur ${result.linkGuild.id}`}</a>.
    </p>
  {/if}

  {#if loading && !result}
    <div class="space-y-2" aria-busy="true">
      {#each Array(5) as _, index (index)}
        <div class="h-20 rounded-2xl bg-on-surface/6 animate-pulse"></div>
      {/each}
    </div>
  {:else if !result}
    <EmptyState icon="Search" title="Aucune recherche lancée" description="Saisis un texte, un lien ou un identifiant puis valide." reason="instruction" />
  {:else if result.messages.length === 0}
    <EmptyState
      icon="Search"
      title="Aucun message trouvé"
      description="Ce message n’a été journalisé sur aucun serveur, ou sa durée de conservation est dépassée."
      reason="nothing-matches"
    />
  {:else}
    <ul class="space-y-1.5">
      {#each result.messages as message (message.id)}
        <li class="rounded-xl border border-outline-variant/25 bg-surface-container-lowest/70 p-3 flex gap-3">
          {#if message.guild.icon}
            <img src={message.guild.icon} alt="" class="w-9 h-9 rounded-lg shrink-0" loading="lazy" />
          {:else}
            <div class="w-9 h-9 rounded-lg shrink-0 bg-on-surface/8" aria-hidden="true"></div>
          {/if}
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <a class="text-body-sm font-semibold text-on-surface hover:underline" href={`/admin/servers/${message.guildId}`}>{guildName(message)}</a>
              <span class="text-xs text-on-surface-variant">#{message.channelName}</span>
              {#if message.deletedAt}<AdminBadge size="sm" label="Supprimé" tone="danger" />{/if}
              {#if message.editedAt}<AdminBadge size="sm" label="Modifié" tone="neutral" />{/if}
              {#if message.isBot}<AdminBadge size="sm" label="Bot" tone="info" />{/if}
            </div>
            <p class="text-xs text-on-surface-variant mt-0.5">
              {message.authorName} <span class="font-mono">{message.authorId}</span> · {formatDate(message.createdAt)}
            </p>
            {#if message.content}
              <p class="text-body-sm text-on-surface mt-1.5 whitespace-pre-wrap break-words">{message.content}</p>
            {/if}
            {#each message.attachments ?? [] as file, index (index)}
              <p class="text-xs text-on-surface-variant mt-1 break-all">Pièce jointe : {file.name}</p>
            {/each}
            <div class="flex flex-wrap gap-x-3 gap-y-1 mt-1.5 text-2xs text-on-surface-variant">
              <span>Serveur <span class="font-mono">{message.guildId}</span></span>
              <span>Message <span class="font-mono">{message.messageId}</span></span>
              <a class="text-primary underline" href={jumpUrl(message)} target="_blank" rel="noopener noreferrer">Ouvrir dans Discord</a>
            </div>
          </div>
        </li>
      {/each}
    </ul>

    {#if result.hasMore}
      <Button {loading} onclick={() => load(submitted, result?.messages.length ?? 0)}>Charger plus de messages</Button>
    {/if}
  {/if}
</AdminShell>
