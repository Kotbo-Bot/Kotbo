<script lang="ts">
  /**
   * Commentaires du blog : ceux que la modération a retenus (lien d'arnaque,
   * toxicité AegisAI) attendent ici qu'un rédacteur les affiche ou les masque.
   */
  import { onMount } from 'svelte';
  import { Button, EmptyState, FilterPills, SectionCard, type FilterOption } from '../ui';
  import { toast } from '../../stores/toast.svelte';
  import { m, dateLocale } from '../../i18n';
  import { deleteSiteComment, fetchSiteComments, setSiteCommentStatus, type SiteComment } from '../../api/site';
  import { siteErrorMessage } from './siteErrors';

  let { guildId }: { guildId: string } = $props();

  let status = $state<'PENDING' | 'VISIBLE' | 'HIDDEN'>('PENDING');
  let comments = $state<SiteComment[]>([]);
  let loading = $state(true);

  const filters: FilterOption[] = [
    { value: 'PENDING', label: m.ste_comments_pending() },
    { value: 'VISIBLE', label: m.ste_comments_visible() },
    { value: 'HIDDEN', label: m.ste_comments_hidden() },
  ];

  async function load() {
    loading = true;
    try {
      comments = (await fetchSiteComments(status, guildId)).comments;
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      loading = false;
    }
  }

  onMount(load);

  async function setStatus(comment: SiteComment, next: 'VISIBLE' | 'HIDDEN') {
    try {
      await setSiteCommentStatus(comment.id, next, guildId);
      comments = comments.filter((c) => c.id !== comment.id);
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  async function remove(comment: SiteComment) {
    try {
      await deleteSiteComment(comment.id, guildId);
      comments = comments.filter((c) => c.id !== comment.id);
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  function reason(code: string | null): string {
    if (!code) return '';
    if (code.startsWith('scam_link:')) return m.ste_reason_scam_link({ domain: code.slice(10) });
    if (code === 'scam_text') return m.ste_reason_scam_text();
    if (code.startsWith('toxicity:')) return m.ste_reason_toxicity({ score: code.slice(9) });
    return code;
  }
</script>

<SectionCard title={m.ste_comments_title()} description={m.ste_comments_desc()} flush>
  {#snippet actions()}
    <FilterPills label={m.ste_comments_filter()} options={filters} value={status} onchange={(value) => { status = value as typeof status; void load(); }} />
  {/snippet}
  {#if !loading && comments.length === 0}
    <div class="p-6"><EmptyState icon="message-square" title={m.ste_comments_empty()} description="" /></div>
  {:else}
    <ul class="comment-list">
      {#each comments as comment (comment.id)}
        <li>
          {#if comment.authorAvatar}<img class="avatar" src={comment.authorAvatar} alt="" />{:else}<span class="avatar"></span>{/if}
          <div class="min-w-0 flex-1">
            <p class="text-2xs text-on-surface-variant">
              <strong class="text-on-surface">{comment.authorName}</strong> · {comment.page.title} · {new Date(comment.createdAt).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' })}
            </p>
            <p class="text-body-sm text-on-surface whitespace-pre-line break-words">{comment.content}</p>
            {#if comment.moderationReason}<p class="text-2xs text-warning mt-1">{reason(comment.moderationReason)}</p>{/if}
          </div>
          <div class="flex gap-1 flex-none">
            {#if comment.status !== 'VISIBLE'}<Button size="sm" icon="eye" onclick={() => setStatus(comment, 'VISIBLE')}>{m.ste_comment_show()}</Button>{/if}
            {#if comment.status !== 'HIDDEN'}<Button size="sm" variant="ghost" icon="eye-off" onclick={() => setStatus(comment, 'HIDDEN')}>{m.ste_comment_hide()}</Button>{/if}
            <Button size="sm" variant="ghost" icon="trash-2" aria-label={m.common_delete()} onclick={() => remove(comment)} />
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</SectionCard>

<style>
  .comment-list { list-style: none; margin: 0; padding: 0; }
  .comment-list li { display: flex; gap: 12px; align-items: flex-start; padding: 12px 16px; border-top: 1px solid rgb(255 255 255 / 0.06); }
  .avatar { flex: none; width: 32px; height: 32px; border-radius: 50%; background: rgb(255 255 255 / 0.08); object-fit: cover; }
</style>
