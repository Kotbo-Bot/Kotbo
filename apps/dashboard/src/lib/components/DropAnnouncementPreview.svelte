<script lang="ts">
  /**
   * Aperçu de l'annonce d'un drop, tel qu'il tombera dans le salon.
   *
   * Les textes sont ceux du bot, dans la langue du serveur (gabarits renvoyés par la route
   * des drops) : la page n'en garde aucune copie. Seules les valeurs viennent du
   * formulaire, ce qui fait suivre l'aperçu à la saisie, avant même l'enregistrement.
   */
  import { m } from '../i18n';
  import DiscordMarkdownText from './sanctions/DiscordMarkdownText.svelte';
  import FilterPills from './ui/FilterPills.svelte';
  import { fillDropTemplate } from '../dropPreview';
  import type { DropAnnouncementLabels } from '../api';
  import {
    dropJackpotAmount,
    dropMentionRoleId,
    enabledDropModes,
    dropModeSettings,
    type DropGlobalSettings,
    type DropMode,
    type DropType,
    type DropTypeSettings,
  } from '@kotbo/shared';

  const {
    labels,
    type,
    settings,
    jackpot,
    modeLabels,
    itemLabel = null,
    mentionRoleName = null,
  }: {
    labels: DropAnnouncementLabels;
    type: DropType;
    settings: DropTypeSettings;
    jackpot: Pick<DropGlobalSettings, 'dropJackpotEnabled' | 'dropJackpotMultiplier' | 'dropMentionJackpotOnly'>;
    modeLabels: Record<DropMode, () => string>;
    /** Pièce la plus probable, pour un drop d'objet : « 1 objet » n'est pas ce qui tombera. */
    itemLabel?: string | null;
    mentionRoleName?: string | null;
  } = $props();

  /** Couleurs de l'embed côté bot (`COLORS.primary` et `COLORS.warning`). */
  const EMBED_COLOR = '#5865f2';
  const JACKPOT_COLOR = '#fee75c';

  const modes = $derived(enabledDropModes(settings));
  let pickedMode = $state<DropMode | null>(null);
  // Un mode éteint depuis ne reste pas affiché : on retombe sur le premier allumé.
  const mode = $derived(pickedMode && modes.includes(pickedMode) ? pickedMode : modes[0] ?? null);

  const jackpotPossible = $derived(jackpot.dropJackpotEnabled && type !== 'RPG_ITEM');
  let showJackpot = $state(false);
  const asJackpot = $derived(jackpotPossible && showJackpot);

  // Même règle que la publication : le nom tient lieu d'identifiant, seul le choix compte.
  const shownMention = $derived(dropMentionRoleId(
    { dropMentionRoleId: mentionRoleName, dropMentionJackpotOnly: jackpot.dropMentionJackpotOnly },
    asJackpot,
  ));

  const numberFormat = $derived(new Intl.NumberFormat(labels.locale === 'fr' ? 'fr-FR' : 'en-US'));

  const description = $derived.by(() => {
    if (!mode) return '';
    const { minAmount, maxAmount } = dropModeSettings(settings, mode);
    // Exemple au milieu de la fourchette : le vrai montant est tiré à chaque apparition.
    const middle = Math.round((minAmount + maxAmount) / 2);
    const amount = asJackpot ? dropJackpotAmount(middle, jackpot.dropJackpotMultiplier) : middle;
    const values = {
      amount: numberFormat.format(amount),
      resource: (type === 'RPG_ITEM' && itemLabel) || labels.resources[type],
      winners: String(settings.race.winnerCount),
      // Discord écrit `<t:…:R>` en temps relatif, dans la langue du membre.
      closes: new Intl.RelativeTimeFormat(labels.locale, { numeric: 'auto' })
        .format(settings.window.durationMinutes, 'minute'),
    };
    const template = mode === 'RACE' ? labels.race : mode === 'WINDOW' ? labels.window : labels.first;
    return fillDropTemplate(template, values);
  });
</script>

{#if mode}
  <div class="space-y-3">
    <div class="flex flex-wrap items-center justify-between gap-3">
      {#if modes.length > 1}
        <FilterPills
          options={modes.map((value) => ({ value, label: modeLabels[value]() }))}
          value={mode}
          onchange={(value: DropMode) => pickedMode = value}
          label={m.drop_preview_mode_label()}
        />
      {/if}
      {#if jackpotPossible}
        <label class="ml-auto flex items-center gap-2 text-xs text-on-surface-variant cursor-pointer">
          <input type="checkbox" bind:checked={showJackpot} class="accent-primary" />
          {m.drop_preview_jackpot_toggle()}
        </label>
      {/if}
    </div>

    <div class="discord">
      {#if shownMention}
        <p class="mention-line"><span class="mention">@{shownMention}</span></p>
      {/if}
      <div class="embed" style="border-left-color: {asJackpot ? JACKPOT_COLOR : EMBED_COLOR}">
        <p class="embed-title">{asJackpot ? labels.jackpotTitle : labels.title}</p>
        {#each description.split('\n') as line, index (index)}
          <p class="embed-body"><DiscordMarkdownText text={line} /></p>
        {/each}
      </div>
      <span class="button">{labels.claimButton}</span>
    </div>

    <p class="text-2xs text-on-surface-variant">{m.drop_preview_amount_hint()}</p>
  </div>
{/if}

<style>
  /* Fond sombre quel que soit le thème : Discord n'a pas celui du dashboard. */
  .discord {
    background: #313338;
    border-radius: 0.75rem;
    padding: 1rem;
    color: #dbdee1;
    font-size: 0.8125rem;
    line-height: 1.4;
  }

  .discord .mention-line { margin: 0 0 0.5rem; }

  .mention {
    background: rgba(88, 101, 242, 0.3);
    color: #c9cdfb;
    border-radius: 0.1875rem;
    padding: 0 0.125rem;
  }

  .embed {
    background: #2b2d31;
    border-left: 4px solid;
    border-radius: 0.25rem;
    padding: 0.75rem 1rem;
    max-width: 32rem;
  }

  /* `.discord` en préfixe : les styles de paragraphe du dashboard passent devant sans lui. */
  .discord .embed-title {
    font-weight: 600;
    color: #f2f3f5;
    margin: 0 0 0.5rem;
  }

  .discord .embed-body { margin: 0; color: #dbdee1; }

  .discord :global(strong) { color: #f2f3f5; }

  .button {
    display: inline-flex;
    margin-top: 0.5rem;
    padding: 0.5rem 1rem;
    border-radius: 0.25rem;
    font-size: 0.8125rem;
    font-weight: 500;
    background: #248046;
    color: #fff;
  }
</style>
