<script lang="ts">
  /**
   * Version web d'un quiz, en plus du message Discord.
   * - `/:serverId/quiz/:eventId` : les membres connectés y répondent, comme avec les boutons Discord.
   * - `/:serverId/quiz/:eventId/presentation` : écran à projeter, sans réponse possible.
   * Les deux se rafraîchissent seuls tant que le quiz n'est pas terminé.
   */
  import Papicon from '../lib/components/Papicon.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import { Button, EmptyState } from '../lib/components/ui';
  import { API_BASE_URL } from '../lib/api';
  import { answerPublicQuiz, fetchPublicQuiz, quizPublicPath, type PublicQuiz } from '../lib/api/quiz';
  import { authStore } from '../lib/stores/auth.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { m } from '../lib/i18n';

  const { serverId, eventId, presentation = false }: { serverId: string; eventId: string; presentation?: boolean } = $props();

  const REFRESH_MS = 3_000;
  const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

  let quiz = $state<PublicQuiz | null>(null);
  let loading = $state(true);
  let missing = $state(false);
  let failed = $state(false);
  let sending = $state<number | null>(null);

  const finished = $derived(quiz?.event.status === 'COMPLETED');
  const live = $derived(quiz?.event.status === 'ONGOING');
  const joinUrl = $derived(`${window.location.origin}${quizPublicPath(serverId, eventId)}`);

  async function load() {
    try {
      const next = await fetchPublicQuiz(serverId, eventId);
      missing = !next;
      quiz = next;
      failed = false;
    } catch {
      // Un rafraîchissement raté garde l'affichage précédent ; seul le premier chargement montre l'erreur.
      failed = !quiz;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void serverId;
    void eventId;
    loading = true;
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && quiz?.event.status !== 'COMPLETED') void load();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  });

  async function answer(optionIndex: number) {
    const question = quiz?.current;
    if (!question || sending !== null) return;
    sending = optionIndex;
    try {
      await answerPublicQuiz(serverId, eventId, question.id, optionIndex);
      if (quiz?.current?.id === question.id) quiz.current.myAnswer = optionIndex;
    } catch (err) {
      toast.error((err as Error).message);
      await load();
    } finally {
      sending = null;
    }
  }

  function loginWithDiscord() {
    window.location.href = `${API_BASE_URL}/api/auth/discord/login?returnTo=${encodeURIComponent(window.location.pathname)}`;
  }
</script>

<svelte:head>
  <title>{quiz ? m.qz_page_title({ title: quiz.event.title, guild: quiz.guildName }) : m.qz_fallback_title()}</title>
</svelte:head>

<div class="min-h-screen bg-surface px-4 py-8 sm:px-6">
  <div class="mx-auto space-y-6 {presentation ? 'max-w-7xl' : 'max-w-3xl'}">
    {#if loading && !quiz}
      <Skeleton height="h-16" />
      <Skeleton height="h-72" />
    {:else if missing || failed || !quiz}
      <EmptyState
        icon="HelpCircle"
        title={failed ? m.qz_error_title() : m.qz_missing_title()}
        description={failed ? m.qz_error_desc() : m.qz_missing_desc()}
        reason={failed ? 'instruction' : 'nothing-matches'}
        actionLabel={failed ? m.common_retry() : undefined}
        onAction={failed ? () => void load() : undefined}
      />
    {:else}
      <header class="section-card flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex min-w-0 items-center gap-4">
          {#if quiz.guildIcon}
            <img src={quiz.guildIcon} alt="" class="h-12 w-12 shrink-0 rounded-xl" />
          {:else}
            <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Papicon icon="HelpCircle" size={22} /></div>
          {/if}
          <div class="min-w-0">
            <p class="truncate text-sm text-on-surface-variant">{quiz.guildName}</p>
            <h1 class="truncate font-semibold text-on-surface {presentation ? 'text-3xl' : 'text-xl'}">{quiz.event.title}</h1>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          {#if live}
            <span class="inline-flex items-center gap-2 rounded-lg bg-error/10 px-3 py-1.5 text-sm font-semibold text-error">
              <span class="h-2 w-2 animate-pulse rounded-full bg-error"></span>{m.tn_live()}
            </span>
          {:else if finished}
            <span class="rounded-lg bg-surface-container-high px-3 py-1.5 text-sm font-medium text-on-surface">{m.ev_status_completed()}</span>
          {/if}
          {#if quiz.current}
            <span class="rounded-lg bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary">
              {m.qz_question_counter({ number: quiz.current.number, total: quiz.totalQuestions })}
            </span>
          {/if}
        </div>
      </header>

      {#if !presentation && !finished}
        {#if !authStore.isAuthenticated}
          <div class="section-card flex flex-col items-start justify-between gap-4 p-5 sm:flex-row sm:items-center">
            <div>
              <p class="font-semibold text-on-surface">{m.qz_login_title()}</p>
              <p class="mt-0.5 text-sm text-on-surface-variant">{m.qz_login_desc()}</p>
            </div>
            <Button variant="primary" icon="LogIn" onclick={loginWithDiscord}>{m.qz_login_cta()}</Button>
          </div>
        {:else}
          <p class="text-sm text-on-surface-variant">{m.qz_playing_as({ name: authStore.user?.username ?? '' })}</p>
        {/if}
      {/if}

      <div class="grid gap-6 {presentation ? 'lg:grid-cols-[1fr_20rem]' : ''}">
        <div class="space-y-6">
          {#if quiz.current}
            {@const current = quiz.current}
            <section class="section-card space-y-5 p-5 sm:p-6">
              <h2 class="font-semibold text-on-surface {presentation ? 'text-4xl leading-tight' : 'text-xl'}">{current.text}</h2>
              {#if current.imageUrl}
                <img src={current.imageUrl} alt="" class="max-h-96 w-full rounded-xl object-contain" />
              {/if}
              <div class="grid gap-3 sm:grid-cols-2">
                {#each current.options as option, idx (idx)}
                  {@const picked = current.myAnswer === idx}
                  {#if presentation}
                    <div class="flex items-center gap-4 rounded-xl border border-outline-variant p-5 text-2xl text-on-surface">
                      <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 font-semibold text-primary">{LETTERS[idx] ?? idx + 1}</span>
                      <span class="min-w-0 break-words">{option}</span>
                    </div>
                  {:else}
                    <button
                      type="button"
                      class="flex min-h-14 items-center gap-3 rounded-xl border p-4 text-left text-on-surface transition-colors disabled:cursor-not-allowed disabled:opacity-60
                        {picked ? 'border-primary bg-primary/10' : 'border-outline-variant hover:bg-surface-container-high'}"
                      disabled={!authStore.isAuthenticated || sending !== null}
                      aria-pressed={picked}
                      onclick={() => answer(idx)}
                    >
                      <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg font-semibold {picked ? 'bg-primary text-on-primary' : 'bg-primary/10 text-primary'}">
                        {#if sending === idx}<Papicon icon="Loader" size={16} class="animate-spin" />{:else}{LETTERS[idx] ?? idx + 1}{/if}
                      </span>
                      <span class="min-w-0 break-words">{option}</span>
                    </button>
                  {/if}
                {/each}
              </div>
              {#if !presentation && current.myAnswer !== null}
                <p class="text-sm text-on-surface-variant">{m.qz_answer_saved()}</p>
              {/if}
            </section>
          {:else if !finished}
            <EmptyState icon="Clock" title={m.qz_waiting_title()} description={m.qz_waiting_desc()} reason="accumulating" />
          {/if}

          {#if quiz.previous?.answer}
            <section class="section-card p-5">
              <p class="text-sm text-on-surface-variant">{m.qz_previous_answer({ question: quiz.previous.text })}</p>
              <p class="mt-1 font-semibold text-success {presentation ? 'text-2xl' : 'text-lg'}">{quiz.previous.answer}</p>
            </section>
          {/if}
        </div>

        {#if presentation || finished || quiz.leaderboard.length > 0}
          <aside class="space-y-6">
            <section class="section-card p-5">
              <h2 class="mb-3 font-semibold text-on-surface">{finished ? m.qz_final_ranking() : m.qz_ranking()}</h2>
              {#if quiz.leaderboard.length === 0}
                <p class="text-sm text-on-surface-variant">{m.qz_ranking_empty()}</p>
              {:else}
                <ol class="space-y-2">
                  {#each quiz.leaderboard as row, rank (row.userId)}
                    <li class="flex items-center gap-3 {presentation ? 'text-lg' : 'text-sm'}">
                      <span class="w-6 shrink-0 text-right font-semibold text-on-surface-variant">{rank + 1}</span>
                      <span class="min-w-0 flex-1 truncate text-on-surface">{row.name}</span>
                      <span class="shrink-0 font-semibold text-primary">{m.qz_points({ count: row.score })}</span>
                    </li>
                  {/each}
                </ol>
              {/if}
            </section>
            {#if presentation && !finished}
              <section class="section-card p-5">
                <p class="text-sm text-on-surface-variant">{m.qz_join_hint()}</p>
                <p class="mt-1 break-all font-mono text-on-surface">{joinUrl}</p>
              </section>
            {/if}
          </aside>
        {/if}
      </div>

      <footer class="flex items-center justify-center gap-2 pt-4 text-xs text-on-surface-variant">
        <Papicon icon="Zap" size={12} /> {m.tn_powered_by()}
      </footer>
    {/if}
  </div>
</div>
