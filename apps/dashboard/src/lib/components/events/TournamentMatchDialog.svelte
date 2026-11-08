<!--
  Saisie du score d'un match : manches gagnées, ou détail de chaque manche
  quand le tournoi le demande (le vainqueur s'en déduit côté serveur).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { Button, Field, Modal } from '../ui';
  import Papicon from '../Papicon.svelte';
  import type { TournamentMatch } from '../../api/tournaments';
  import { m } from '../../i18n';

  let {
    match,
    setDetail,
    saving = false,
    onSave,
    onClear,
    onClose,
  }: {
    match: TournamentMatch;
    setDetail: boolean;
    saving?: boolean;
    onSave: (score: { score1: number; score2: number } | { sets: [number, number][] }) => void;
    onClear: () => void;
    onClose: () => void;
  } = $props();

  const need = $derived(Math.floor(match.bestOf / 2) + 1);
  // Valeurs de départ prises une fois : la saisie ne doit pas sauter si le tableau se rafraîchit.
  let score1 = $state(untrack(() => match.score1));
  let score2 = $state(untrack(() => match.score2));
  let sets = $state<[number, number][]>(untrack(() => match.sets?.map(([a, b]) => [a, b]) ?? [[0, 0]]));

  const setWins = $derived(sets.reduce(([a, b], [x, y]) => [a + (x > y ? 1 : 0), b + (y > x ? 1 : 0)], [0, 0]));
  const hasScore = $derived(match.status === 'live' || match.status === 'done');

  function submit(event: SubmitEvent) {
    event.preventDefault();
    onSave(setDetail ? { sets } : { score1: Number(score1), score2: Number(score2) });
  }
</script>

<Modal open title={m.tn_match_title({ number: match.number })} subtitle={m.tn_match_subtitle({ bestOf: match.bestOf, need })} size="md" {onClose}>
  <form id="tournament-match-form" class="space-y-5" onsubmit={submit}>
    {#if setDetail}
      <div class="grid grid-cols-[1fr_5rem_5rem_2rem] items-center gap-2 text-sm">
        <span></span>
        <span class="truncate text-center font-medium text-on-surface">{match.player1?.name}</span>
        <span class="truncate text-center font-medium text-on-surface">{match.player2?.name}</span>
        <span></span>
        {#each sets as set, i}
          <span class="text-on-surface-variant">{m.tn_set_n({ n: i + 1 })}</span>
          <input class="input text-center" type="number" min="0" aria-label={m.tn_set_score_aria({ n: i + 1, name: match.player1?.name ?? '' })} bind:value={set[0]} />
          <input class="input text-center" type="number" min="0" aria-label={m.tn_set_score_aria({ n: i + 1, name: match.player2?.name ?? '' })} bind:value={set[1]} />
          <button type="button" class="text-on-surface-variant hover:text-error" aria-label={m.tn_remove_set()} onclick={() => (sets = sets.filter((_, k) => k !== i))}>
            <Papicon icon="X" size={14} />
          </button>
        {/each}
      </div>
      <div class="flex items-center justify-between gap-3">
        <Button variant="ghost" size="sm" icon="Plus" disabled={sets.length >= match.bestOf} disabledReason={m.tn_max_sets({ bestOf: match.bestOf })} onclick={() => (sets = [...sets, [0, 0]])}>
          {m.tn_add_set()}
        </Button>
        <span class="text-sm text-on-surface-variant">{m.tn_sets_won({ a: setWins[0], b: setWins[1] })}</span>
      </div>
    {:else}
      <div class="grid grid-cols-2 gap-4">
        <Field label={match.player1?.name ?? ''}>
          {#snippet children(id, describedBy)}
            <input {id} aria-describedby={describedBy} class="input text-center text-lg" type="number" min="0" max={need} bind:value={score1} />
          {/snippet}
        </Field>
        <Field label={match.player2?.name ?? ''}>
          {#snippet children(id, describedBy)}
            <input {id} aria-describedby={describedBy} class="input text-center text-lg" type="number" min="0" max={need} bind:value={score2} />
          {/snippet}
        </Field>
      </div>
      <p class="text-sm text-on-surface-variant">{m.tn_score_hint({ need })}</p>
    {/if}
  </form>

  {#snippet footer()}
    <div class="flex w-full items-center justify-between gap-3">
      {#if hasScore}
        <Button variant="ghost" icon="RotateCcw" onclick={onClear} disabled={saving}>{m.tn_clear_score()}</Button>
      {:else}
        <span></span>
      {/if}
      <div class="flex gap-2">
        <Button variant="secondary" onclick={onClose}>{m.common_cancel()}</Button>
        <Button variant="primary" type="submit" form="tournament-match-form" loading={saving}>{m.common_save()}</Button>
      </div>
    </div>
  {/snippet}
</Modal>
