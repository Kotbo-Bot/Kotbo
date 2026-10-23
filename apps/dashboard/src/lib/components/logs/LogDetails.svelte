<script lang="ts">
  /**
   * Details d'un evenement journalise, lus d'un coup d'oeil : le texte du
   * membre d'abord, l'avant/apres d'une modification cote a cote, puis le
   * contexte (salon, reponse, pieces jointes, lien vers le message) en pastilles.
   * Partage par la page Journaux et l'onglet Logs du dossier membre.
   */
  import Papicon from '../Papicon.svelte';
  import { m } from '../../i18n';
  import { authStore } from '../../stores/auth.svelte';
  import { parseDetailsMetadata, parseDetailsStructure, renderLogHtml } from '../../logDetails';

  interface Props {
    details: string;
    channelId?: string | null;
    /** La page Journaux affiche deja le salon dans sa propre colonne. */
    showChannel?: boolean;
    userNames?: Record<string, string>;
    compact?: boolean;
  }

  let { details, channelId = null, showChannel = false, userNames, compact = false }: Props = $props();

  const labels = $derived({
    details: m.lg_details(),
    unknownChannel: m.lg_unknown_channel_name(),
    unknownRole: 'role-inconnu',
    userNames,
  });

  const parsed = $derived(parseDetailsStructure(details, labels));
  const resolvedChannelId = $derived(parseDetailsMetadata(details, '', labels).extractedChannelId ?? channelId);
  const messageBlocks = $derived(parsed.blocks.filter((block) => block.tone === 'message'));
  const diffBlocks = $derived(parsed.blocks.filter((block) => block.tone === 'before' || block.tone === 'after'));
  const otherBlocks = $derived(parsed.blocks.filter((block) => !block.tone));

  const messageUrl = $derived.by(() => {
    const guildId = authStore.selectedGuildId;
    if (!parsed.messageId || !resolvedChannelId || !guildId) return null;
    return `https://discord.com/channels/${encodeURIComponent(guildId)}/${resolvedChannelId}/${parsed.messageId}`;
  });

  const hasMeta = $derived(
    (showChannel && !!resolvedChannelId) || parsed.badges.length > 0 || parsed.attachments.length > 0 || !!messageUrl,
  );
</script>

<div class="log-details {compact ? 'text-xs' : 'text-sm'} space-y-2">
  {#each messageBlocks as block, i (i)}
    <p class="log-details__text whitespace-pre-wrap border-l-2 border-primary/40 pl-3 leading-relaxed text-on-surface">{@html block.value}</p>
  {/each}

  {#if diffBlocks.length > 0}
    <div class="grid gap-2 {diffBlocks.length > 1 ? 'sm:grid-cols-2' : ''}">
      {#each diffBlocks as block, i (i)}
        <div class="rounded-lg border border-outline-variant/40 bg-surface-container-low px-3 py-2">
          <p class="text-2xs font-semibold {block.tone === 'after' ? 'text-primary' : 'text-on-surface-variant'}">{block.key}</p>
          <p class="log-details__text mt-0.5 whitespace-pre-wrap leading-relaxed {block.tone === 'after' ? 'text-on-surface' : 'text-on-surface-variant'}">{@html block.value}</p>
        </div>
      {/each}
    </div>
  {/if}

  {#each otherBlocks as block, i (i)}
    <div class="rounded-lg bg-surface-container-low px-3 py-2">
      <p class="text-2xs font-semibold text-on-surface-variant">{block.key}</p>
      <p class="log-details__text mt-0.5 whitespace-pre-wrap leading-relaxed text-on-surface">{@html block.value}</p>
    </div>
  {/each}

  {#if hasMeta}
    <div class="flex flex-wrap items-center gap-1.5 text-2xs">
      {#if showChannel && resolvedChannelId}
        <span class="log-details__chip">
          <span class="text-on-surface-variant">{m.lg_channel_label()}</span>
          <span class="text-on-surface">{@html renderLogHtml(`<#${resolvedChannelId}>`, labels)}</span>
        </span>
      {/if}
      {#each parsed.badges as badge, i (i)}
        <span class="log-details__chip">
          {#if badge.key}<span class="text-on-surface-variant">{badge.key}</span>{/if}
          <span class="log-details__text text-on-surface">{@html badge.value}</span>
        </span>
      {/each}
      {#each parsed.attachments as url, i (url)}
        <a href={url} target="_blank" rel="noopener noreferrer" class="log-details__chip log-details__link">
          <Papicon icon="paperclip" size={12} />{m.lg_attachment_n({ n: i + 1 })}
        </a>
      {/each}
      {#if messageUrl}
        <a href={messageUrl} target="_blank" rel="noopener noreferrer" class="log-details__chip log-details__link">
          <Papicon icon="external-link" size={12} />{m.lg_open_message()}
        </a>
      {/if}
    </div>
  {/if}
</div>

<style>
  .log-details__text {
    overflow-wrap: anywhere;
  }

  .log-details__chip {
    display: inline-flex;
    max-width: 100%;
    align-items: center;
    gap: 0.25rem;
    border-radius: 0.5rem;
    border: 1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent);
    background: var(--color-surface-container-high);
    padding: 0.125rem 0.5rem;
    font-weight: 500;
  }

  .log-details__link {
    color: var(--color-primary);
    transition: border-color 150ms ease;
  }

  .log-details__link:hover {
    border-color: var(--color-primary);
  }
</style>
