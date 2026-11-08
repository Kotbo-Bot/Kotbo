<script lang="ts">
  import { m } from '../../i18n';

  interface Props {
    time: string;
    text: string;
    /** Carte image sous le message, comme celle que le bot génère. */
    card?: { imageUrl: string | null; title: string; subtitle: string } | null;
  }

  let { time, text, card = null }: Props = $props();
</script>

<div class="space-y-1.5">
  <span class="text-xs font-semibold text-on-surface-variant ml-2">{m.announcements_discord_preview()}</span>
  <div class="p-5 rounded-lg bg-surface-container-high/35 border border-outline-variant/15 text-sm text-on-surface font-semibold font-sans whitespace-pre-wrap select-none relative overflow-hidden">
    <div class="flex items-start gap-4">
      <div class="w-10 h-10 rounded-full bg-outline-variant/30 flex items-center justify-center text-xs font-semibold text-on-surface-variant">BOT</div>
      <div>
        <div class="flex items-center gap-2">
          <span class="font-bold text-primary">Kotbo</span>
          <span class="bg-primary/20 text-primary text-2xs font-semibold px-1.5 py-0.5 rounded uppercase leading-none">BOT</span>
          <span class="text-2xs text-on-surface-variant/40">{m.announcements_today_at({ time })}</span>
        </div>
        <div class="mt-1 text-on-surface-variant/90 leading-relaxed text-sm font-medium font-sans">
          {text}
        </div>
        {#if card}
          <div class="mt-3 w-full max-w-sm aspect-5/2 rounded-xl bg-[#0b0e14] flex items-center justify-center border border-[#5865f2]/30 relative overflow-hidden">
            {#if card.imageUrl}
              <img src={card.imageUrl} alt="" class="absolute inset-0 w-full h-full object-cover opacity-50" />
            {/if}
            <div class="relative flex flex-col items-center gap-1.5 z-10 p-4 text-center">
              <div class="w-12 h-12 rounded-full border border-primary/20 bg-surface-container/85 flex items-center justify-center text-sm font-semibold text-primary">JD</div>
              <span class="text-xs font-semibold text-white leading-none drop-shadow-sm">{card.title}</span>
              <span class="text-2xs font-bold text-[#57f287] leading-none font-sans">JEANDUPONT</span>
              <span class="text-xs text-[#b8bcc8] font-medium">{card.subtitle}</span>
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>
