<!--
  Satisfaction du support : note moyenne, répartition, notes par membre du
  staff avec leurs commentaires, avis récents. Onglet autonome de la page
  Tickets.
-->
<script lang="ts">
  import { m, dateLocale } from '../../i18n';
  import { toast } from '../../stores/toast.svelte';
  import { fetchSatisfactionData, fetchStaffSatisfactionReviews } from '../../api';
  import Papicon from '../Papicon.svelte';

  const {
    refreshToken = 0,
    onopenmember,
  }: {
    /** Incrémenté par la page (bouton Actualiser) pour relire les données. */
    refreshToken?: number;
    /** Ouvre le dossier d'un membre, que la page affiche. */
    onopenmember: (userId: string, name: string) => void;
  } = $props();

  // Satisfaction State
  let satisfactionLoading = $state(false);
  let satisfactionData: any = $state(null);

  type SatisfactionPerson = {
    userId: string;
    username?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
  };

  const ratingEmojis = ['', '\u{1F621}', '\u{1F615}', '\u{1F610}', '\u{1F642}', '\u{1F929}'];
  const ratingLabels = ['', m.e1_tickets_sat_rating_1(), m.e1_tickets_sat_rating_2(), m.e1_tickets_sat_rating_3(), m.e1_tickets_sat_rating_4(), m.e1_tickets_sat_rating_5()];

  function getSatisfactionPersonName(person: SatisfactionPerson | null | undefined, userId: string): string {
    return person?.displayName || person?.username || m.e1_tickets_sat_user_fallback({ userId });
  }

  function getSatisfactionPersonHandle(person: SatisfactionPerson | null | undefined, userId: string): string {
    return person?.username ? `@${person.username}` : m.e1_tickets_sat_user_id({ userId });
  }

  function getSatisfactionInitials(person: SatisfactionPerson | null | undefined, userId: string): string {
    const name = getSatisfactionPersonName(person, userId).trim();
    const initials = name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('');
    return initials || userId.slice(0, 2);
  }

  function openSatisfactionMember(userId: string, person: SatisfactionPerson | null | undefined) {
    onopenmember(userId, getSatisfactionPersonName(person, userId));
  }

  function getRatingColor(rating: number): string {
    if (rating >= 4.5) return 'var(--color-success)';
    if (rating >= 3.5) return 'var(--color-primary, #5865F2)';
    if (rating >= 2.5) return 'var(--color-warning)';
    return 'var(--color-error)';
  }

  async function loadSatisfaction() {
    satisfactionLoading = true;
    try {
      satisfactionData = await fetchSatisfactionData();
    } catch {
      toast.error(m.e1_tickets_err_load_satisfaction());
    } finally {
      satisfactionLoading = false;
    }
  }

  // Ligne staff depliee : apercu des derniers commentaires deja charges avec la vue.
  let expandedStaffId = $state<string | null>(null);

  function toggleStaffComments(staffId: string) {
    expandedStaffId = expandedStaffId === staffId ? null : staffId;
  }

  // Modale « Voir tous les avis » : la liste complete est paginee cote serveur.
  const STAFF_REVIEWS_PAGE_SIZE = 20;
  let reviewsModalStaff = $state<{ staffId: string; staff: SatisfactionPerson | null } | null>(null);
  let reviewsModalItems = $state<any[]>([]);
  let reviewsModalTotal = $state(0);
  let reviewsModalOffset = $state(0);
  let reviewsModalHasMore = $state(false);
  let reviewsModalLoading = $state(false);
  let reviewsModalCommentsOnly = $state(false);

  async function fetchReviewsPage(offset: number, append: boolean) {
    if (!reviewsModalStaff) return;
    reviewsModalLoading = true;
    try {
      const page = await fetchStaffSatisfactionReviews(reviewsModalStaff.staffId, {
        limit: STAFF_REVIEWS_PAGE_SIZE,
        offset,
        commentsOnly: reviewsModalCommentsOnly
      });
      reviewsModalItems = append ? [...reviewsModalItems, ...(page.reviews ?? [])] : (page.reviews ?? []);
      reviewsModalTotal = page.total ?? 0;
      reviewsModalHasMore = page.hasMore === true;
      reviewsModalOffset = offset + (page.reviews?.length ?? 0);
    } catch {
      toast.error(m.e1_tickets_err_load_satisfaction());
    } finally {
      reviewsModalLoading = false;
    }
  }

  function openStaffReviews(staffId: string, staff: SatisfactionPerson | null) {
    reviewsModalStaff = { staffId, staff };
    reviewsModalItems = [];
    reviewsModalTotal = 0;
    reviewsModalOffset = 0;
    reviewsModalHasMore = false;
    reviewsModalCommentsOnly = false;
    void fetchReviewsPage(0, false);
  }

  function closeStaffReviews() {
    reviewsModalStaff = null;
    reviewsModalItems = [];
  }

  function toggleReviewsCommentsOnly() {
    reviewsModalCommentsOnly = !reviewsModalCommentsOnly;
    void fetchReviewsPage(0, false);
  }

  $effect(() => {
    void refreshToken;
    void loadSatisfaction();
  });
</script>

<!-- Satisfaction Tab -->
{#if satisfactionLoading}
  <div class="flex items-center justify-center py-16">
    <div class="w-8 h-8 rounded-full border-4 border-primary border-t-transparent animate-spin"></div>
  </div>
{:else if satisfactionData}
  <div class="sat-grid">
    <!-- Overview Card -->
    <div class="sat-card sat-overview-card">
      <div class="sat-avg-rating" style="color: {getRatingColor(satisfactionData.global.averageRating)}">
        <span class="sat-avg-value">{satisfactionData.global.averageRating.toFixed(1)}</span>
        <span class="sat-avg-max">/5</span>
      </div>
      <p class="sat-avg-label">{m.e1_tickets_sat_responses({ count: satisfactionData.global.totalResponses })}</p>

      <div class="sat-distribution">
        {#each satisfactionData.global.distribution as d}
          <div class="sat-dist-row">
            <span class="sat-dist-label">{ratingEmojis[d.rating]} {d.rating}</span>
            <div class="sat-dist-bar">
              <div class="sat-dist-fill" style="width: {satisfactionData.global.totalResponses > 0 ? (d.count / satisfactionData.global.totalResponses * 100) : 0}%"></div>
            </div>
            <span class="sat-dist-count">{d.count}</span>
          </div>
        {/each}
      </div>
    </div>

    <!-- Staff Satisfaction Card -->
    <div class="sat-card sat-staff-card">
      <h3 class="sat-card-title">{m.e1_tickets_sat_by_staff()}</h3>
      {#if satisfactionData.byStaff.length === 0}
        <p class="sat-empty">{m.e1_tickets_sat_no_staff_data()}</p>
      {:else}
        <div class="sat-staff-list">
          {#each satisfactionData.byStaff as staff}
            {@const isExpanded = expandedStaffId === staff.staffId}
            {@const commentCount = staff.commentCount ?? 0}
            {@const previews = staff.recentComments ?? []}
            <div class="sat-staff-item">
              <div class="sat-staff-row">
                <button type="button" class="sat-person-main sat-clickable-person" onclick={() => openSatisfactionMember(staff.staffId, staff.staff)}>
                  {#if staff.staff?.avatarUrl}
                    <img src={staff.staff.avatarUrl} alt="" class="sat-person-avatar" />
                  {:else}
                    <span class="sat-person-avatar sat-avatar-fallback">{getSatisfactionInitials(staff.staff, staff.staffId)}</span>
                  {/if}
                  <span class="sat-person-text">
                    <span class="sat-person-name">{getSatisfactionPersonName(staff.staff, staff.staffId)}</span>
                    <span class="sat-person-handle">{getSatisfactionPersonHandle(staff.staff, staff.staffId)}</span>
                  </span>
                </button>
                <div class="sat-staff-rating" style="color: {getRatingColor(staff.averageRating)}">
                  {staff.averageRating.toFixed(1)}/5
                </div>
                <span class="sat-staff-count">{m.e1_tickets_sat_reviews_count({ count: staff.totalResponses })}</span>
                <div class="sat-staff-actions">
                  <button
                    type="button"
                    class="sat-staff-chip"
                    class:sat-staff-chip-muted={commentCount === 0}
                    disabled={commentCount === 0}
                    aria-expanded={isExpanded}
                    title={commentCount === 0 ? m.e1_tickets_sat_no_comment() : m.e1_tickets_sat_comments_count({ count: commentCount })}
                    onclick={() => toggleStaffComments(staff.staffId)}
                  >
                    <Papicon icon="message-square" size={13} />
                    <span>{commentCount}</span>
                    {#if commentCount > 0}
                      <Papicon icon={isExpanded ? 'chevron-up' : 'chevron-down'} size={13} />
                    {/if}
                  </button>
                  <button type="button" class="sat-staff-chip" onclick={() => openStaffReviews(staff.staffId, staff.staff)}>
                    {m.e1_tickets_sat_view_all()}
                  </button>
                </div>
              </div>

              {#if isExpanded}
                <div class="sat-comment-list">
                  {#each previews as review}
                    <div class="sat-comment">
                      <div class="sat-comment-head">
                        <span class="sat-comment-emoji">{ratingEmojis[review.rating]}</span>
                        <button type="button" class="sat-comment-author sat-clickable-person" onclick={() => openSatisfactionMember(review.userId, review.user)}>
                          {getSatisfactionPersonName(review.user, review.userId)}
                        </button>
                        <span class="sat-comment-date">{new Date(review.createdAt).toLocaleDateString(dateLocale())}</span>
                      </div>
                      <p class="sat-comment-body">{review.comment}</p>
                    </div>
                  {/each}
                  {#if commentCount > previews.length}
                    <button type="button" class="sat-comment-more" onclick={() => openStaffReviews(staff.staffId, staff.staff)}>
                      {m.e1_tickets_sat_more_comments({ count: commentCount - previews.length })}
                    </button>
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Recent Reviews Card -->
    <div class="sat-card sat-recent-card">
      <h3 class="sat-card-title">{m.e1_tickets_sat_recent()}</h3>
      {#if satisfactionData.global.recent.length === 0}
        <p class="sat-empty">{m.e1_tickets_sat_no_review()}</p>
      {:else}
        <div class="sat-recent-list">
          {#each satisfactionData.global.recent.slice(0, 15) as review}
            <div class="sat-review-item">
              <div class="sat-review-row">
                <span class="sat-review-emoji">{ratingEmojis[review.rating]}</span>
                <button type="button" class="sat-review-user sat-clickable-person" onclick={() => openSatisfactionMember(review.userId, review.user)}>
                  {#if review.user?.avatarUrl}
                    <img src={review.user.avatarUrl} alt="" class="sat-person-avatar" />
                  {:else}
                    <span class="sat-person-avatar sat-avatar-fallback">{getSatisfactionInitials(review.user, review.userId)}</span>
                  {/if}
                  <span class="sat-person-text">
                    <span class="sat-person-name">{getSatisfactionPersonName(review.user, review.userId)}</span>
                    <span class="sat-person-handle">{getSatisfactionPersonHandle(review.user, review.userId)}</span>
                  </span>
                </button>
                {#if review.staff}
                  <span class="sat-review-staff">{m.e1_tickets_sat_handled_by({ name: getSatisfactionPersonName(review.staff, review.staffId) })}</span>
                {/if}
                <span class="sat-review-date">{new Date(review.createdAt).toLocaleDateString(dateLocale())}</span>
              </div>
              {#if review.comment}
                <p class="sat-review-comment">{review.comment}</p>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{:else}
  <div class="flex flex-col items-center justify-center py-16 text-on-surface-variant/30">
    <Papicon icon="smile" size={36} class="opacity-50 mb-2" />
    <p class="text-xs font-bold">{m.e1_tickets_sat_empty()}</p>
  </div>
{/if}

<!-- Avis d'un membre du staff (pagines) -->
{#if reviewsModalStaff}
  <div class="fixed inset-0 z-100 flex items-center justify-center p-4 bg-black/60">
    <div class="bg-surface border border-outline-variant/30 rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-sm animate-in zoom-in-95 duration-300">
      <div class="flex items-center gap-3 p-6 border-b border-outline-variant/20">
        {#if reviewsModalStaff.staff?.avatarUrl}
          <img src={reviewsModalStaff.staff.avatarUrl} alt="" class="w-10 h-10 rounded-full object-cover" />
        {:else}
          <span class="w-10 h-10 rounded-full bg-surface-container-high flex items-center justify-center text-xs font-bold">
            {getSatisfactionInitials(reviewsModalStaff.staff, reviewsModalStaff.staffId)}
          </span>
        {/if}
        <div class="min-w-0 flex-1">
          <h3 class="text-base font-semibold truncate">{m.e1_tickets_sat_reviews_of({ name: getSatisfactionPersonName(reviewsModalStaff.staff, reviewsModalStaff.staffId) })}</h3>
          <p class="text-2xs text-on-surface-variant/60">{m.e1_tickets_sat_reviews_count({ count: reviewsModalTotal })}</p>
        </div>
        <button type="button" class="sat-staff-chip" class:sat-chip-active={reviewsModalCommentsOnly} onclick={toggleReviewsCommentsOnly}>
          <Papicon icon="message-square" size={13} />
          {m.e1_tickets_sat_comments_only()}
        </button>
        <button type="button" onclick={closeStaffReviews} aria-label={m.common_cancel()} class="p-2 rounded-lg hover:bg-surface-container transition-colors">
          <Papicon icon="close" size={18} />
        </button>
      </div>

      <div class="flex-1 overflow-y-auto p-6 space-y-3">
        {#if reviewsModalLoading && reviewsModalItems.length === 0}
          <div class="flex items-center justify-center py-10">
            <div class="w-6 h-6 rounded-full border-4 border-primary border-t-transparent animate-spin"></div>
          </div>
        {:else if reviewsModalItems.length === 0}
          <p class="sat-empty">{m.e1_tickets_sat_no_review()}</p>
        {:else}
          {#each reviewsModalItems as review}
            <div class="sat-comment">
              <div class="sat-comment-head">
                <span class="sat-comment-emoji">{ratingEmojis[review.rating]}</span>
                <button type="button" class="sat-comment-author sat-clickable-person" onclick={() => openSatisfactionMember(review.userId, review.user)}>
                  {getSatisfactionPersonName(review.user, review.userId)}
                </button>
                <span class="sat-comment-rating" style="color: {getRatingColor(review.rating)}">{ratingLabels[review.rating]}</span>
                <span class="sat-comment-date">{new Date(review.createdAt).toLocaleDateString(dateLocale())}</span>
              </div>
              {#if review.comment}
                <p class="sat-comment-body">{review.comment}</p>
              {:else}
                <p class="sat-comment-body sat-comment-empty">{m.e1_tickets_sat_no_comment()}</p>
              {/if}
            </div>
          {/each}

          {#if reviewsModalHasMore}
            <button
              type="button"
              class="w-full py-3 rounded-xl text-xs font-semibold bg-surface-container hover:bg-surface-container-high transition-colors disabled:opacity-50"
              disabled={reviewsModalLoading}
              onclick={() => fetchReviewsPage(reviewsModalOffset, true)}
            >
              {reviewsModalLoading ? m.common_loading() : m.e1_tickets_sat_load_more()}
            </button>
          {/if}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  /* Satisfaction Tab Styles */
  .sat-grid { display: grid; grid-template-columns: 300px 1fr; gap: 1rem; }
  .sat-card { background: var(--color-surface, rgba(255,255,255,0.05)); border: 1px solid var(--color-outline-variant); border-radius: 12px; padding: 1.25rem; }
  .sat-card-title { margin: 0 0 1rem; font-size: 0.95rem; color: var(--color-on-surface-variant); }

  .sat-overview-card { text-align: center; }
  .sat-avg-rating { display: flex; align-items: baseline; justify-content: center; gap: 0.25rem; }
  .sat-avg-value { font-size: 3rem; font-weight: 700; }
  .sat-avg-max { font-size: 1rem; color: color-mix(in srgb, var(--color-on-surface-variant) 75%, transparent); }
  .sat-avg-label { color: color-mix(in srgb, var(--color-on-surface-variant) 75%, transparent); font-size: 0.875rem; margin: 0.5rem 0 1.5rem; }

  .sat-distribution { display: flex; flex-direction: column; gap: 0.5rem; }
  .sat-dist-row { display: grid; grid-template-columns: 40px 1fr 30px; align-items: center; gap: 0.5rem; }
  .sat-dist-label { font-size: 0.85rem; }
  .sat-dist-bar { height: 8px; background: var(--color-outline-variant); border-radius: 4px; overflow: hidden; }
  .sat-dist-fill { height: 100%; background: var(--color-primary, #5865F2); border-radius: 4px; }
  .sat-dist-count { text-align: right; font-size: 0.8rem; color: color-mix(in srgb, var(--color-on-surface-variant) 75%, transparent); }

  .sat-staff-list { display: flex; flex-direction: column; gap: 0.5rem; }
  .sat-staff-item { border-radius: 10px; border: 1px solid transparent; transition: border-color 160ms ease, background-color 160ms ease; }
  .sat-staff-item:has(.sat-comment-list) { border-color: var(--color-outline-variant); background: var(--color-surface-container, rgba(255,255,255,0.03)); }
  .sat-staff-row { display: flex; align-items: center; gap: 0.75rem; width: 100%; padding: 0.55rem; border-radius: 8px; text-align: left; }
  .sat-staff-rating { font-weight: 600; }
  .sat-staff-count { font-size: 0.8rem; color: color-mix(in srgb, var(--color-on-surface-variant) 75%, transparent); }
  .sat-staff-actions { display: flex; align-items: center; gap: 0.35rem; margin-left: auto; flex: 0 0 auto; }
  .sat-staff-chip {
    display: inline-flex; align-items: center; gap: 0.3rem;
    padding: 0.28rem 0.55rem; border-radius: 999px; cursor: pointer;
    border: 1px solid var(--color-outline-variant);
    background: transparent; color: var(--color-on-surface-variant);
    font: inherit; font-size: 0.72rem; font-weight: 700; white-space: nowrap;
    transition: background-color 160ms ease, color 160ms ease, border-color 160ms ease;
  }
  .sat-staff-chip:hover:not(:disabled) { background: var(--color-surface-container-high, rgba(255,255,255,0.08)); color: var(--color-on-surface); }
  .sat-staff-chip:focus-visible { outline: 2px solid var(--color-primary, #5865F2); outline-offset: 2px; }
  .sat-staff-chip-muted { opacity: 0.45; cursor: default; }
  .sat-chip-active { border-color: var(--color-primary, #5865F2); color: var(--color-primary, #5865F2); }

  .sat-comment-list { display: flex; flex-direction: column; gap: 0.5rem; padding: 0 0.55rem 0.65rem 3.35rem; }
  .sat-comment {
    border-left: 2px solid var(--color-primary, #5865F2);
    padding: 0.35rem 0 0.35rem 0.65rem;
  }
  .sat-comment-head { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; font-size: 0.75rem; }
  .sat-comment-emoji { font-size: 0.95rem; }
  .sat-comment-author { font-weight: 700; border-radius: 4px; padding: 0 0.15rem; }
  .sat-comment-rating { font-weight: 600; }
  .sat-comment-date { color: color-mix(in srgb, var(--color-on-surface-variant) 75%, transparent); margin-left: auto; }
  /* Un avis est du texte libre : il doit passer a la ligne, jamais deborder. */
  .sat-comment-body { margin: 0.2rem 0 0; font-size: 0.82rem; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--color-on-surface); }
  .sat-comment-empty { font-style: italic; color: color-mix(in srgb, var(--color-on-surface-variant) 75%, transparent); }
  .sat-comment-more {
    align-self: flex-start; border: 0; background: transparent; cursor: pointer; padding: 0;
    font: inherit; font-size: 0.72rem; font-weight: 700; color: var(--color-primary, #5865F2);
  }
  .sat-comment-more:hover { text-decoration: underline; }

  .sat-recent-card { grid-column: 1 / -1; }
  .sat-recent-list { display: flex; flex-direction: column; gap: 0.25rem; }
  .sat-review-item { padding: 0.35rem 0; border-bottom: 1px solid var(--color-outline-variant); }
  .sat-review-item:last-child { border-bottom: 0; }
  .sat-review-row { display: grid; grid-template-columns: 2rem minmax(180px, 260px) minmax(0, 1fr) auto; align-items: center; gap: 0.75rem; padding: 0.1rem 0; font-size: 0.85rem; }
  .sat-review-emoji { font-size: 1.1rem; }
  .sat-review-user { min-width: 0; }
  .sat-review-staff { color: color-mix(in srgb, var(--color-on-surface-variant) 75%, transparent); font-size: 0.75rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sat-review-comment {
    margin: 0.15rem 0 0.35rem 2.75rem; font-size: 0.82rem; line-height: 1.45;
    white-space: pre-wrap; overflow-wrap: anywhere;
    color: var(--color-on-surface);
    border-left: 2px solid var(--color-outline-variant); padding-left: 0.6rem;
  }
  .sat-review-date { color: color-mix(in srgb, var(--color-on-surface-variant) 75%, transparent); font-size: 0.75rem; }

  .sat-clickable-person { border: 0; background: transparent; color: inherit; cursor: pointer; font: inherit; padding: 0; transition: background-color 160ms ease, color 160ms ease; }
  .sat-clickable-person:hover { background: var(--color-surface-container-high, rgba(255,255,255,0.08)); }
  .sat-clickable-person:focus-visible { outline: 2px solid var(--color-primary, #5865F2); outline-offset: 2px; }
  .sat-person-main,
  .sat-review-user { display: flex; align-items: center; gap: 0.65rem; }
  .sat-person-main { flex: 1; min-width: 0; }
  .sat-person-avatar { width: 2rem; height: 2rem; border-radius: 999px; object-fit: cover; flex: 0 0 auto; }
  .sat-avatar-fallback { display: inline-flex; align-items: center; justify-content: center; background: var(--color-primary, #5865F2); color: white; font-size: 0.68rem; font-weight: 800; }
  .sat-person-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.15; }
  .sat-person-name { color: var(--color-on-surface); font-size: 0.86rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sat-person-handle { color: color-mix(in srgb, var(--color-on-surface-variant) 75%, transparent); font-size: 0.7rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .sat-empty { color: color-mix(in srgb, var(--color-on-surface-variant) 75%, transparent); font-style: italic; }

  @media (max-width: 768px) {
    .sat-grid { grid-template-columns: 1fr; }
    .sat-review-row { grid-template-columns: 2rem minmax(0, 1fr) auto; }
    .sat-review-staff { display: none; }
    .sat-review-comment { margin-left: 0; }
    .sat-staff-row { flex-wrap: wrap; }
    .sat-staff-actions { margin-left: 0; width: 100%; }
    .sat-comment-list { padding-left: 0.55rem; }
  }
</style>
