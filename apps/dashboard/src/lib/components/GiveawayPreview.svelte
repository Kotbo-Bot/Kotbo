<script lang="ts">
  /**
   * Aperçu d'une annonce de concours, à côté des champs qui la façonnent.
   *
   * Les gabarits se réglaient sans rien voir : il fallait lancer un vrai
   * concours pour juger d'une couleur ou d'un titre. L'aperçu montre les
   * variables remplacées, le balisage rendu et le bouton tel qu'il sortira.
   */
  import { m } from '../i18n';
  import { authStore } from '../stores/auth.svelte';
  import { dashboardStore } from '../stores/dashboard.svelte';
  import { MessageComponents, type ButtonView, type MessageComponent } from '@arcscord/discord-ui-svelte';
  import { botEmbedToV2 } from './discord/botEmbedV2';
  import DiscordScope from './discord/DiscordScope.svelte';
  import { mergeEntities } from './discord/previewEntities.svelte';
  import { renderMarkdown, type PreviewLabels, type PreviewSample } from '../giveawayPreview';
  import type { GiveawayAppearance, GiveawayGeneratedLabels } from '../api';

  let {
    appearance,
    bonusRoles = [],
    showBonusRoles = true,
    generated = null,
    overrides = null,
    compact = false,
  }: {
    appearance: GiveawayAppearance;
    bonusRoles?: { name: string; weight: number }[];
    showBonusRoles?: boolean;
    /** Libellés du bot, dans la langue du serveur. */
    generated?: GiveawayGeneratedLabels | null;
    /**
     * Valeurs réelles à la place de l'exemple.
     *
     * L'aperçu des réglages n'a rien de vrai à montrer et invente un concours.
     * Une carte de modèle, elle, en a un sous la main : elle passe ses propres
     * lot, durée et récompenses, et cesse d'être un exemple.
     */
    overrides?: Partial<PreviewSample> | null;
    /** Sans en-tête ni légende : l'aperçu tient alors dans une carte. */
    compact?: boolean;
  } = $props();

  /**
   * Les blocs des récompenses et des rôles avantagés sont écrits par le bot,
   * dans la langue du serveur. Les traductions du dashboard ne servent que
   * tant que l'API n'a pas répondu, sinon l'aperçu parlerait la langue de la
   * personne connectée plutôt que celle du serveur.
   */
  const labels: PreviewLabels = $derived({
    rewardsTitle: generated?.rewardsTitle ?? m.giv_preview_rewards(),
    coins: generated?.coins ?? m.giv_preview_coins(),
    xp: generated?.xp ?? m.giv_preview_xp(),
    item: generated?.item ?? m.giv_preview_item(),
    validation: generated?.validation ?? m.giv_preview_validation(),
    bonusRolesTitle: generated?.bonusRolesTitle ?? m.giv_preview_bonus_roles(),
    endsIn: m.giv_preview_ends_in(),
  });

  // Date figée au montage : recalculée à chaque rendu, elle ferait clignoter
  // l'aperçu à chaque frappe dans un champ.
  const endsAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

  /**
   * Récompenses du module RPG dans l'exemple, éteintes par défaut.
   *
   * L'aperçu les montrait toujours, pièces et XP en dur. Un concours met
   * pourtant presque toujours en jeu un lot remis à la main, sans rien toucher
   * à l'économie du serveur : le bloc annonçait donc une possibilité que la
   * plupart des serveurs n'utilisent pas, à un endroit qui prétend montrer
   * l'annonce telle qu'elle sortira.
   */
  let withRewards = $state(false);

  const example: PreviewSample = $derived({
    prize: m.giv_preview_sample_prize(),
    description: m.giv_preview_sample_description(),
    winnerCount: 2,
    participants: 37,
    winners: [m.giv_preview_sample_winner_a(), m.giv_preview_sample_winner_b()],
    // Le serveur et l'organisateur sont réels : ce sont les seules valeurs que
    // la page connaît vraiment, et les voir justes aide à juger le gabarit.
    host: (authStore.user as { username?: string } | null)?.username ?? m.giv_preview_sample_host(),
    serverName: dashboardStore.state.guildName ?? m.giv_preview_sample_server(),
    bonusRoles: showBonusRoles ? bonusRoles : [],
    coins: withRewards ? 250 : 0,
    xp: withRewards ? 100 : 0,
    item: '',
    needValidation: false,
    endsAt,
  });

  // Les valeurs fournies l'emportent : ce qu'on connaît du concours passe devant
  // ce qu'on aurait inventé pour l'illustrer.
  const sample: PreviewSample = $derived({ ...example, ...(overrides ?? {}) });

  // Le bot publie l'annonce en Components V2 : titre et pied y sont des blocs
  // de texte comme les autres, où Discord affiche les mentions.
  const title = $derived(renderMarkdown(appearance.titleTemplate, sample, labels));
  const body = $derived.by(() => {
    const template = appearance.descriptionTemplate;
    // Comme le bot : un corps d'annonce qui ne réserve pas de place aux rôles
    // avantagés les reçoit à la suite, plutôt que de les perdre.
    const withRoles = sample.bonusRoles.length > 0 && !template.includes('{bonusRoles}') ? `${template}\n{bonusRoles}` : template;
    return renderMarkdown(withRoles, sample, labels);
  });
  const footer = $derived(renderMarkdown(appearance.footerTemplate, sample, labels));

  const buttonVariant: Record<GiveawayAppearance['joinButtonStyle'], 'primary' | 'secondary' | 'success' | 'danger'> = {
    PRIMARY: 'primary',
    SECONDARY: 'secondary',
    SUCCESS: 'success',
    DANGER: 'danger',
  };

  /** Emoji du bouton : texte, ou `<:nom:id>` d'un emoji de serveur (son image). */
  const buttonEmoji = $derived.by((): ButtonView['emoji'] => {
    const raw = appearance.joinButtonEmoji?.trim() ?? '';
    if (!raw) return undefined;
    const custom = raw.match(/^<(a?):(\w+):(\d+)>$/);
    return custom
      ? { name: custom[2], image: `https://cdn.discordapp.com/emojis/${custom[3]}.${custom[1] ? 'gif' : 'webp'}?size=48` }
      : { name: raw };
  });

  /** Message tel que le bot le publie : embed converti en conteneur V2, bouton en dessous. */
  const components = $derived<MessageComponent[]>([
    botEmbedToV2({
      color: appearance.embedColorActive,
      ...(title.markdown ? { title: title.markdown } : {}),
      ...(body.markdown ? { description: body.markdown } : {}),
      ...(appearance.thumbnailUrl ? { thumbnailUrl: appearance.thumbnailUrl } : {}),
      ...(appearance.imageUrl ? { imageUrl: appearance.imageUrl } : {}),
      ...(footer.markdown ? { footer: footer.markdown } : {}),
    }, 'giveaway'),
    {
      id: 'giveaway-actions',
      kind: 'action-row',
      buttons: [{
        id: 'giveaway-join',
        kind: 'button',
        label: appearance.joinButtonLabel,
        style: buttonVariant[appearance.joinButtonStyle] ?? 'primary',
        ...(buttonEmoji ? { emoji: buttonEmoji } : {}),
      }],
    },
  ]);

  const entities = $derived(mergeEntities([title.entities, body.entities, footer.entities]));
</script>

<div class="preview">
  {#if !compact}
    <div class="preview-head">
      <p class="preview-label">{m.giv_preview_title()}</p>
      <span class="preview-badge">{m.giv_preview_sample_badge()}</span>
      <label class="preview-toggle">
        <input type="checkbox" bind:checked={withRewards} />
        {m.giv_preview_show_rewards()}
      </label>
    </div>
  {/if}

  <DiscordScope class="giveaway-discord" {entities}>
    <MessageComponents {components} />
  </DiscordScope>

  {#if !compact}
    <p class="field-hint">{m.giv_preview_hint()}</p>
  {/if}
</div>

<style>
  .preview-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .preview-label {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--on-surface);
  }

  .preview-badge {
    font-size: 0.6875rem;
    padding: 0.125rem 0.5rem;
    border-radius: 9999px;
    background: var(--surface-container-high);
    color: var(--on-surface-variant);
  }

  /* Poussé à droite : c'est une option de l'aperçu, pas un réglage du serveur. */
  .preview-toggle {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    color: var(--on-surface-variant);
    cursor: pointer;
  }

  .preview-toggle input {
    width: 0.875rem;
    height: 0.875rem;
    accent-color: var(--primary-color);
    cursor: pointer;
  }

  /* Fond sombre quel que soit le thème : Discord n'a pas celui du dashboard. */
  :global(.arcscord-discord-ui.giveaway-discord) {
    border-radius: 0.75rem;
    padding: 1rem;
  }
</style>
