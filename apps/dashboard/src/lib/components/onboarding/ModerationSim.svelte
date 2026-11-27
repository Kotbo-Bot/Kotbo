<script lang="ts">
  /**
   * Kotbo a l'oeuvre, dans un faux salon.
   *
   * L'ecran de moderation demandait de choisir entre « Souple », « Equilibre »
   * et « Strict » sur la foi de trois paragraphes. Personne ne sait ce que ces
   * mots recouvrent avant d'avoir vu un serveur tourner - et le jour ou on le
   * sait, on ne repasse plus par cet ecran.
   *
   * Ici, les memes messages traversent le salon, et c'est le reglage retenu qui
   * decide de leur sort. Changer de niveau rejoue la scene : on ne lit plus une
   * description, on voit la difference. C'est le seul endroit du parcours ou
   * l'ecart entre deux reponses se constate au lieu de se croire.
   *
   * Rien de choquant n'y passe. Un lien d'invitation, un mur de majuscules, une
   * rafale de mentions, un compte cree il y a une heure : c'est ce que la
   * moderation retire vraiment le plus souvent, et c'est lisible sans avoir a
   * censurer des insultes sur le premier ecran que voit un nouveau client.
   *
   * Le salon est rendu par @arcscord/discord-ui, comme les autres apercus :
   * les messages ressemblent a Discord sans qu'on l'imite a la main.
   */
  import { m } from '../../i18n';
  import { bot } from '../../stores/botLocale.svelte';
  import type { ModerationLevel } from '../../onboarding';
  import Papicon from '../Papicon.svelte';
  import { Avatar, ChannelHeader, Markdown, MessageFrame, MessageHeader } from '@arcscord/discord-ui-svelte';
  import DiscordScope from '../discord/DiscordScope.svelte';

  const { level, autoplay = true }: { level: ModerationLevel; autoplay?: boolean } = $props();

  type Verdict = 'kept' | 'deleted' | 'held';

  type Line = {
    author: string;
    color: string;
    text: string;
    /** Mention de compte trop recent, affichee sous le pseudo. */
    fresh?: boolean;
    /** Le sort du message, par niveau de moderation. */
    verdict: Record<ModerationLevel, Verdict>;
    reason: () => string;
  };

  const KEPT: Record<ModerationLevel, Verdict> = { light: 'kept', standard: 'kept', strict: 'kept' };

  const LINES: Line[] = [
    {
      author: 'Maë',
      color: '#3ba55d',
      get text() { return m.bot_sim_patch({}, bot()); },
      verdict: KEPT,
      reason: () => m.onb_sim_passes(),
    },
    {
      author: 'promo_bot',
      color: '#faa61a',
      get text() { return m.bot_sim_promo({}, bot()); },
      // Un lien d'invitation saute a tous les niveaux : c'est precisement ce que
      // « le strict necessaire » veut dire.
      verdict: { light: 'deleted', standard: 'deleted', strict: 'deleted' },
      reason: () => m.onb_sim_reason_invite(),
    },
    {
      author: 'Tom',
      color: '#5865f2',
      get text() { return m.bot_sim_opinion({}, bot()); },
      verdict: KEPT,
      reason: () => m.onb_sim_passes(),
    },
    {
      author: 'kkkkk',
      color: '#eb459e',
      text: 'AAAAAAAA AAAAAAAA AAAAAAAA AAAAAAAA AAAAAAAA',
      verdict: { light: 'kept', standard: 'deleted', strict: 'deleted' },
      reason: () => m.onb_sim_reason_spam(),
    },
    {
      author: 'kkkkk',
      color: '#eb459e',
      get text() { return m.bot_sim_flood({}, bot()); },
      verdict: { light: 'kept', standard: 'deleted', strict: 'deleted' },
      reason: () => m.onb_sim_reason_flood(),
    },
    {
      author: 'user_84021',
      color: '#747f8d',
      get text() { return m.bot_sim_hello({}, bot()); },
      fresh: true,
      // Le seul cas ou « strict » se distingue : un compte de quelques heures
      // n'est pas fautif, il est simplement mis a l'ecart le temps d'un captcha.
      verdict: { light: 'kept', standard: 'kept', strict: 'held' },
      reason: () => m.onb_sim_reason_young(),
    },
  ];

  const CAPTIONS: Record<ModerationLevel, () => string> = {
    light: () => m.onb_sim_caption_light(),
    standard: () => m.onb_sim_caption_standard(),
    strict: () => m.onb_sim_caption_strict(),
  };

  /** Rythme du defile. Assez lent pour lire chaque message, assez court pour ne pas lasser. */
  const STEP_MS = 620;
  const timestamp = new Date().toISOString();
  /** Delai entre l'apparition d'un message et le verdict de Kotbo. */
  const VERDICT_MS = 480;

  let shown = $state(0);
  let judged = $state(0);
  let playing = $state(false);

  const reduced =
    typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

  function play() {
    // Le reglage systeme demande d'arreter les animations, pas d'en cacher le
    // resultat : tout s'affiche d'un coup, deja juge.
    if (reduced) {
      shown = LINES.length;
      judged = LINES.length;
      playing = false;
      return;
    }
    shown = 0;
    judged = 0;
    playing = true;
  }

  // Les messages arrivent a leur rythme.
  $effect(() => {
    if (!playing || shown >= LINES.length) return;
    const timer = setTimeout(() => { shown += 1; }, STEP_MS);
    return () => clearTimeout(timer);
  });

  // Le verdict les suit avec un temps de retard : sans ce decalage, le message
  // apparaitrait deja barre et l'on ne verrait jamais Kotbo agir.
  $effect(() => {
    if (!playing || judged >= shown) return;
    const timer = setTimeout(() => { judged += 1; }, VERDICT_MS);
    return () => clearTimeout(timer);
  });

  // La scene est finie quand tout est affiche et tout est juge. `playing`
  // retombe dans un minuteur et non dans le corps de l'effet : l'ecrire ici
  // relancerait l'effet, qui le lit.
  $effect(() => {
    if (!playing || shown < LINES.length || judged < LINES.length) return;
    const timer = setTimeout(() => { playing = false; }, 0);
    return () => clearTimeout(timer);
  });

  // Changer de niveau rejoue la scene : c'est la comparaison qui a de la valeur,
  // pas la scene elle-meme.
  $effect(() => {
    void level;
    if (autoplay) play();
  });
</script>

<DiscordScope class="moderation-sim">
  <ChannelHeader name={m.bot_ch_general({}, bot())}>
    {#snippet actions()}
      <button type="button" onclick={play} class="replay">
        <Papicon icon="refresh-cw" size={11} />
        {m.onb_sim_replay()}
      </button>
    {/snippet}
  </ChannelHeader>

  <div class="scene" aria-live="polite">
    {#each LINES.slice(0, shown) as line, index (index)}
      {@const verdict = index < judged ? line.verdict[level] : 'kept'}
      {@const author = { id: line.author, displayName: line.author, avatarFallback: { background: line.color } }}
      <div class="line" class:struck={verdict !== 'kept'}>
        <MessageFrame>
          {#snippet avatar()}<Avatar {author} />{/snippet}
          {#snippet header()}
            <MessageHeader {author} {timestamp} />
            {#if line.fresh}<span class="fresh">{m.onb_sim_new_member()}</span>{/if}
          {/snippet}
          <div class="text"><Markdown content={line.text} /></div>
          {#if verdict !== 'kept'}
            <p class="verdict" class:held={verdict === 'held'}>
              <Papicon icon={verdict === 'deleted' ? 'trash' : 'clock'} size={10} />
              {verdict === 'deleted' ? m.onb_sim_deleted_by() : m.onb_sim_held()}
              <span class="reason">· {line.reason()}</span>
            </p>
          {/if}
        </MessageFrame>
      </div>
    {/each}

    {#if shown === 0}
      <p class="waiting">{m.onb_sim_title()}…</p>
    {/if}
  </div>
</DiscordScope>

<p class="mt-2.5 text-xs leading-relaxed text-on-surface-variant">
  {CAPTIONS[level]()}
</p>

<style>
  /* Les couleurs sont celles de Discord en sombre : le cadre ne suit pas le theme de Kotbo. */
  :global(.arcscord-discord-ui.moderation-sim) {
    border-radius: 0.75rem;
    overflow: hidden;
    border: 1px solid rgb(0 0 0 / 0.25);
  }

  .scene { min-height: 260px; padding: 0.5rem 0; }

  .line { animation: appear 240ms ease-out both; }
  .text { transition: opacity 300ms ease; overflow-wrap: anywhere; }
  .struck .text { opacity: 0.55; text-decoration: line-through; text-decoration-color: rgb(242 63 67 / 0.6); }

  .fresh {
    margin-left: 0.375rem;
    padding: 0 0.25rem;
    border-radius: 0.25rem;
    background: #4e5058;
    color: #dbdee1;
    font-size: 0.6875rem;
    font-weight: 600;
  }

  .verdict {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
    margin-top: 0.25rem;
    padding: 0.125rem 0.375rem;
    border-radius: 0.25rem;
    background: rgb(242 63 67 / 0.15);
    color: #f77f81;
    font-size: 0.6875rem;
    font-weight: 500;
    animation: appear 200ms ease-out both;
  }
  .verdict.held { background: rgb(250 166 26 / 0.15); color: #f0b232; }
  .reason { color: #949ba4; }

  .replay {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.25rem;
    min-height: 1.75rem;
    color: #949ba4;
    font-size: 0.6875rem;
    font-weight: 500;
    cursor: pointer;
  }
  .replay:hover { color: #dbdee1; }

  .waiting { padding: 1.5rem 0; text-align: center; color: #949ba4; font-size: 0.75rem; }

  @keyframes appear {
    from { opacity: 0; transform: translateY(5px); }
    to { opacity: 1; transform: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .line, .verdict { animation: none; }
  }
</style>
