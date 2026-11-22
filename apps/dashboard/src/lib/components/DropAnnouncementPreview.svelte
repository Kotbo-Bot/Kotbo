<script lang="ts">
  /**
   * Aperçu de l'annonce d'un drop, tel qu'il tombera dans le salon.
   *
   * Les textes sont ceux du bot, dans la langue du serveur (gabarits renvoyés par la route
   * des drops) : la page n'en garde aucune copie. Seules les valeurs viennent du
   * formulaire, ce qui fait suivre l'aperçu à la saisie, avant même l'enregistrement.
   */
  import { m } from '../i18n';
  import { ActionRow, Button } from '@arcscord/discord-ui-svelte';
  import DiscordEmbedPreview from './DiscordEmbedPreview.svelte';
  import { mentionId } from './discord/previewEntities.svelte';
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

  /** Rôle mentionné au-dessus de l'embed, en vraie mention nommée. */
  const mentionRole = $derived(shownMention ? { id: mentionId(shownMention), name: shownMention } : null);

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

    <DiscordEmbedPreview
      title={asJackpot ? labels.jackpotTitle : labels.title}
      body={description}
      color={asJackpot ? JACKPOT_COLOR : EMBED_COLOR}
      content={mentionRole ? `<@&${mentionRole.id}>` : undefined}
      entities={mentionRole ? { roles: { [mentionRole.id]: { name: mentionRole.name } } } : {}}
    >
      <!-- Bouton du bot : ButtonStyle.Success. -->
      <ActionRow>
        <Button label={labels.claimButton} variant="success" />
      </ActionRow>
    </DiscordEmbedPreview>

    <p class="text-2xs text-on-surface-variant">{m.drop_preview_amount_hint()}</p>
  </div>
{/if}
