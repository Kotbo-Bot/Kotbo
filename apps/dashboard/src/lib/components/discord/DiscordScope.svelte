<script lang="ts">
  /**
   * Cadre commun des aperçus Discord rendus par @arcscord/discord-ui-svelte :
   * thème sombre quel que soit celui du dashboard (Discord n'a pas le sien),
   * langue du dashboard et fuseau du navigateur pour les dates. `entities`
   * donne les noms des mentions du Markdown (`<@id>`, `<@&id>`, `<#id>`).
   */
  import type { Snippet } from 'svelte';
  import { DiscordUI, type MessageEntities, type UILabels } from '@arcscord/discord-ui-svelte';
  import '@arcscord/discord-ui-svelte/styles.css';
  import { getLocale, m } from '../../i18n';

  const {
    class: className,
    entities = {},
    children,
  }: { class?: string; entities?: MessageEntities; children: Snippet } = $props();

  const locale = $derived(getLocale() === 'fr' ? 'fr-FR' : 'en-US');
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  /**
   * Libellés de la lib dans la langue du dashboard. `{name}` reste littéral :
   * c'est la lib qui le remplace.
   */
  const labels = $derived<Partial<UILabels>>({
    edited: m.dui_edited(),
    reply: m.dui_reply(),
    replyUnavailable: m.dui_reply_unavailable(),
    interactionReply: m.dui_interaction_reply(),
    interactionUsed: m.dui_interaction_used(),
    mentionedMessage: m.dui_mentioned_message(),
    ephemeralNotice: m.dui_ephemeral_notice(),
    dismissMessage: m.dui_dismiss_message(),
    downloadFile: m.dui_download_file({ name: '{name}' }),
    reactions: m.dui_reactions(),
    spoiler: m.dui_spoiler(),
    showSpoiler: m.dui_show_spoiler(),
    hideSpoiler: m.dui_hide_spoiler(),
    mediaUnavailable: m.dui_media_unavailable(),
    invalidTimestamp: m.dui_invalid_timestamp(),
    mediaPlay: m.dui_media_play(),
    mediaReplay: m.dui_media_replay(),
    mediaPause: m.dui_media_pause(),
    mediaSeek: m.dui_media_seek(),
    mediaVolume: m.dui_media_volume(),
    mediaMute: m.dui_media_mute(),
    mediaUnmute: m.dui_media_unmute(),
    mediaFullscreen: m.dui_media_fullscreen(),
    mediaExitFullscreen: m.dui_media_exit_fullscreen(),
    mediaPlaybackSpeed: m.dui_media_playback_speed(),
    mediaLoading: m.dui_media_loading(),
    mediaUnsupportedSticker: m.dui_media_unsupported_sticker(),
  });
</script>

<DiscordUI theme="dark" {locale} {timeZone} {entities} {labels} class={className}>
  {@render children()}
</DiscordUI>

<style>
  /* Le reset de Tailwind retire les puces ; la lib s'appuie sur celles du navigateur. */
  :global(.arcscord-discord-ui .dui-markdown ul) {
    list-style-type: disc;
  }

  :global(.arcscord-discord-ui .dui-markdown ol) {
    list-style-type: decimal;
  }
</style>
