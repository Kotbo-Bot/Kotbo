<!--
  Message d'un menu de rôles tel que Discord l'affiche : embed (titre, texte,
  barre de couleur) puis boutons par rangées de cinq. Sert à l'aperçu de la
  fenêtre d'édition et, en version compacte, aux cartes des menus publiés.
-->
<script lang="ts">
  import { m } from '../i18n';
  import { parseDiscordEmojisAndMarkdown } from '../emojiParser';

  type PreviewStyle = 'secondary' | 'primary' | 'success' | 'danger';

  const {
    title,
    description,
    buttons,
    color = '#5865F2',
    compact = false,
  }: {
    title: string;
    description: string;
    /** `text` vide : bouton incomplet, montré en pointillés. */
    buttons: Array<{ emoji?: string; text: string; style: PreviewStyle }>;
    color?: string;
    /** Sans en-tête du bot, plus serré : pour les cartes. */
    compact?: boolean;
  } = $props();

  // Les couleurs Discord des quatre styles de bouton, reprises telles quelles
  // pour que l'aperçu montre ce que les membres verront.
  const STYLE_CLASSES: Record<PreviewStyle, string> = {
    secondary: 'bg-[#4e5058]',
    primary: 'bg-[#5865f2]',
    success: 'bg-[#248046]',
    danger: 'bg-[#da373c]',
  };

  const rows = $derived.by(() => {
    const result: (typeof buttons)[] = [];
    for (let i = 0; i < buttons.length; i += 5) result.push(buttons.slice(i, i + 5));
    return result;
  });
</script>

<div class="bg-[#313338] text-[#dbdee1] font-sans {compact ? 'rounded-lg p-3' : 'px-4 py-4'}">
  <div class="flex items-start {compact ? '' : 'gap-3'}">
    {#if !compact}
      <div class="w-10 h-10 rounded-full bg-[#5865f2] flex items-center justify-center text-white font-bold shrink-0">K</div>
    {/if}
    <div class="flex-1 min-w-0 {compact ? 'space-y-1.5' : 'space-y-2'}">
      {#if !compact}
        <div class="flex items-center gap-1.5 select-none">
          <span class="font-semibold text-white text-sm">Kotbo</span>
          <span class="bg-[#5865f2] text-white text-[10px] font-semibold px-1 rounded-[3px] leading-4">BOT</span>
          <span class="text-xs text-[#949ba4]">{m.announcements_today_at({ time: '12:00' })}</span>
        </div>
      {/if}
      <div class="bg-[#2b2d31] border-l-4 rounded-[4px] max-w-[520px] space-y-1 {compact ? 'px-2.5 py-2' : 'px-3 py-2.5'}" style="border-left-color: {color}">
        <div class="font-semibold text-white wrap-break-word {compact ? 'text-xs' : 'text-sm'}">{@html parseDiscordEmojisAndMarkdown(title)}</div>
        <div class="leading-snug text-[#dbdee1] whitespace-pre-line wrap-break-word {compact ? 'text-[11px] line-clamp-2' : 'text-[13px]'}">
          {@html parseDiscordEmojisAndMarkdown(description)}
        </div>
      </div>
      <div class="{compact ? 'space-y-1' : 'space-y-2 pt-0.5'}">
        {#each rows as row}
          <div class="flex flex-wrap {compact ? 'gap-1' : 'gap-2'}">
            {#each row as button}
              <!-- Pointillés : bouton sans texte ni rôle, il reste à compléter. -->
              <span class="flex items-center gap-1.5 font-medium rounded-[3px] {compact ? 'h-6 px-2.5 text-[11px]' : 'h-8 px-4 text-sm'} {button.text ? `text-white ${STYLE_CLASSES[button.style]}` : 'border border-dashed border-[#949ba4] text-[#949ba4] italic'}">
                {#if button.emoji}<span>{@html parseDiscordEmojisAndMarkdown(button.emoji)}</span>{/if}
                <span>{button.text || m.reaction_roles_preview_button_default()}</span>
              </span>
            {/each}
          </div>
        {/each}
      </div>
    </div>
  </div>
</div>
