<script lang="ts">
  /**
   * Forum du site : catégories (propres au site ou miroir d'un salon forum
   * Discord, recopié dans les deux sens) et modération des derniers messages.
   */
  import { onMount } from 'svelte';
  import { Button, EmptyState, Field, Modal, SectionCard } from '../ui';
  import { toast } from '../../stores/toast.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { m } from '../../i18n';
  import {
    createForumCategory,
    deleteForumCategory,
    deleteForumPostAdmin,
    fetchForumAdmin,
    fetchSiteCatalog,
    importForumCategory,
    reorderForumCategories,
    setForumTopicFlags,
    updateForumCategory,
    type ForumAdminState,
    type ForumCategoryAdmin,
    type ForumRecentPost,
    type SiteCatalog,
  } from '../../api/site';
  import { siteErrorMessage } from './siteErrors';

  let { guildId, canManage, siteUrl }: { guildId: string; canManage: boolean; siteUrl: string } = $props();

  let forum = $state<ForumAdminState | null>(null);
  let roles = $state<SiteCatalog['roles']>([]);
  let loading = $state(true);

  async function load() {
    try {
      forum = await fetchForumAdmin(guildId);
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
    fetchSiteCatalog(guildId)
      .then((catalog) => (roles = catalog.roles))
      .catch(() => {});
  });

  // ─── Catégorie ────────────────────────────────────────────────────────────

  let editorOpen = $state(false);
  let editing = $state<ForumCategoryAdmin | null>(null);
  let draft = $state({ name: '', description: '', mode: 'SITE' as 'SITE' | 'MIRROR', channelId: '', writeRoleIds: [] as string[], staffTopicsOnly: false });
  let saving = $state(false);

  function openEditor(category: ForumCategoryAdmin | null) {
    editing = category;
    draft = category
      ? { name: category.name, description: category.description, mode: category.mode, channelId: category.channelId ?? '', writeRoleIds: [...category.writeRoleIds], staffTopicsOnly: category.staffTopicsOnly }
      : { name: '', description: '', mode: 'SITE', channelId: '', writeRoleIds: [], staffTopicsOnly: false };
    editorOpen = true;
  }

  function toggleRole(id: string) {
    draft.writeRoleIds = draft.writeRoleIds.includes(id) ? draft.writeRoleIds.filter((r) => r !== id) : [...draft.writeRoleIds, id];
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    saving = true;
    const payload = { ...draft, channelId: draft.mode === 'MIRROR' ? draft.channelId || null : null };
    try {
      if (editing) await updateForumCategory(editing.id, payload, guildId);
      else await createForumCategory(payload, guildId);
      toast.success(draft.mode === 'MIRROR' && !editing ? m.ste_forum_saved_mirror() : m.ste_forum_saved());
      editorOpen = false;
      await load();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      saving = false;
    }
  }

  async function remove(category: ForumCategoryAdmin) {
    const ok = await confirmDialog.ask({
      title: m.ste_forum_delete_title(),
      description: category.mode === 'MIRROR' ? m.ste_forum_delete_mirror({ name: category.name }) : m.ste_forum_delete_confirm({ name: category.name }),
      confirmLabel: m.common_delete(),
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await deleteForumCategory(category.id, guildId);
      await load();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  async function move(index: number, delta: number) {
    if (!forum) return;
    const list = [...forum.categories];
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    forum.categories = list;
    try {
      await reorderForumCategories(list.map((c) => c.id), guildId);
    } catch (err) {
      toast.error(siteErrorMessage(err));
      await load();
    }
  }

  let importing = $state<string | null>(null);
  async function reimport(category: ForumCategoryAdmin) {
    importing = category.id;
    try {
      const { imported } = await importForumCategory(category.id, guildId);
      toast.success(m.ste_forum_imported({ count: imported }));
      await load();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      importing = null;
    }
  }

  // ─── Modération ───────────────────────────────────────────────────────────

  async function flag(post: ForumRecentPost, flags: { pinned?: boolean; locked?: boolean }) {
    try {
      await setForumTopicFlags(post.topic.id, flags, guildId);
      await load();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  async function removePost(post: ForumRecentPost) {
    const ok = await confirmDialog.ask({ title: m.ste_forum_post_delete_title(), description: m.ste_forum_post_delete_confirm(), confirmLabel: m.common_delete(), variant: 'danger' });
    if (!ok) return;
    try {
      await deleteForumPostAdmin(post.id, guildId);
      await load();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  const channelName = (id: string | null) => forum?.forumChannels.find((c) => c.id === id)?.name ?? id ?? '';
  const dateOf = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
</script>

<div class="space-y-4">
  <SectionCard title={m.ste_forum_title()} description={m.ste_forum_desc()} icon="message-square" flush>
    {#snippet actions()}
      {#if canManage}<Button size="sm" icon="plus" onclick={() => openEditor(null)}>{m.ste_forum_add()}</Button>{/if}
    {/snippet}
    {#if !loading && (forum?.categories.length ?? 0) === 0}
      <div class="p-6"><EmptyState icon="message-square" title={m.ste_forum_empty()} description={m.ste_forum_empty_desc()} /></div>
    {:else if forum}
      <ul class="forum-list">
        {#each forum.categories as category, index (category.id)}
          <li>
            <div class="forum-main">
              <p class="forum-name">
                <a href={`${siteUrl}/forum/${category.slug}`} target="_blank" rel="noopener">{category.name}</a>
                {#if category.mode === 'MIRROR'}<span class="forum-chip">{m.ste_forum_mirror_of({ channel: channelName(category.channelId) })}</span>{/if}
                {#if category.staffTopicsOnly}<span class="forum-chip">{m.ste_forum_staff_topics()}</span>{/if}
              </p>
              <p class="forum-meta">
                {m.ste_forum_topic_count({ count: category.topicCount })}{#if category.lastPostAt} · {m.ste_forum_last({ date: dateOf(category.lastPostAt) })}{/if}
              </p>
            </div>
            {#if canManage}
              <div class="forum-actions">
                {#if category.mode === 'MIRROR'}
                  <Button size="sm" variant="ghost" loading={importing === category.id} onclick={() => reimport(category)}>{m.ste_forum_reimport()}</Button>
                {/if}
                <Button size="sm" variant="ghost" icon="arrow-up" aria-label={m.ste_move_up()} onclick={() => move(index, -1)} />
                <Button size="sm" variant="ghost" icon="arrow-down" aria-label={m.ste_move_down()} onclick={() => move(index, 1)} />
                <Button size="sm" variant="ghost" icon="edit-2" aria-label={m.ste_forum_edit()} onclick={() => openEditor(category)} />
                <Button size="sm" variant="ghost" icon="trash-2" aria-label={m.common_delete()} onclick={() => remove(category)} />
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </SectionCard>

  {#if forum && forum.recent.length > 0}
    <SectionCard title={m.ste_forum_recent()} description={m.ste_forum_recent_desc()} icon="inbox" flush>
      <ul class="forum-list">
        {#each forum.recent as post (post.id)}
          <li>
            <div class="forum-main">
              <p class="forum-name">
                <a href={`${siteUrl}/forum/${post.topic.category.slug}/${post.topic.id}#p-${post.id}`} target="_blank" rel="noopener">{post.topic.title}</a>
                {#if post.topic.pinned}<span class="forum-chip">{m.ste_forum_pinned()}</span>{/if}
                {#if post.topic.locked}<span class="forum-chip">{m.ste_forum_locked()}</span>{/if}
              </p>
              <p class="forum-meta">{post.authorName} · {post.topic.category.name} · {dateOf(post.createdAt)} · {post.source === 'discord' ? 'Discord' : m.ste_forum_from_site()}</p>
              <p class="forum-excerpt">{post.content.slice(0, 240)}</p>
            </div>
            <div class="forum-actions">
              <Button size="sm" variant="ghost" onclick={() => flag(post, { pinned: !post.topic.pinned })}>{post.topic.pinned ? m.ste_forum_unpin() : m.ste_forum_pin()}</Button>
              <Button size="sm" variant="ghost" onclick={() => flag(post, { locked: !post.topic.locked })}>{post.topic.locked ? m.ste_forum_unlock() : m.ste_forum_lock()}</Button>
              <Button size="sm" variant="ghost" icon="trash-2" aria-label={m.common_delete()} onclick={() => removePost(post)} />
            </div>
          </li>
        {/each}
      </ul>
    </SectionCard>
  {/if}
</div>

<Modal bind:open={editorOpen} title={editing ? m.ste_forum_edit() : m.ste_forum_add()} size="md">
  <form id="forum-category-form" class="space-y-4" onsubmit={save}>
    <Field label={m.ste_forum_name()} required>
      {#snippet children(id)}
        <input {id} class="input w-full" maxlength="60" required bind:value={draft.name} />
      {/snippet}
    </Field>
    <Field label={m.ste_forum_description()}>
      {#snippet children(id)}
        <textarea {id} class="input w-full" rows="2" maxlength="300" bind:value={draft.description}></textarea>
      {/snippet}
    </Field>
    <fieldset class="space-y-2">
      <legend class="text-body-sm font-medium text-on-surface">{m.ste_forum_mode()}</legend>
      <label class="mode-option">
        <input type="radio" name="forum-mode" value="SITE" bind:group={draft.mode} />
        <span><strong>{m.ste_forum_mode_site()}</strong><br /><span class="text-on-surface-variant">{m.ste_forum_mode_site_desc()}</span></span>
      </label>
      <label class="mode-option">
        <input type="radio" name="forum-mode" value="MIRROR" bind:group={draft.mode} />
        <span><strong>{m.ste_forum_mode_mirror()}</strong><br /><span class="text-on-surface-variant">{m.ste_forum_mode_mirror_desc()}</span></span>
      </label>
    </fieldset>
    {#if draft.mode === 'MIRROR'}
      <Field label={m.ste_forum_channel()} hint={m.ste_forum_channel_hint()} required>
        {#snippet children(id, describedBy)}
          <select {id} aria-describedby={describedBy} class="input w-full" required bind:value={draft.channelId}>
            <option value=""></option>
            {#each forum?.forumChannels ?? [] as channel (channel.id)}
              <option value={channel.id} disabled={!channel.botCanManage}>#{channel.name}{channel.botCanManage ? '' : ` (${m.ste_forum_channel_no_perm()})`}</option>
            {/each}
          </select>
        {/snippet}
      </Field>
    {/if}
    <div class="space-y-1">
      <p class="text-body-sm font-medium text-on-surface">{m.ste_forum_write_roles()}</p>
      <p class="text-body-sm text-on-surface-variant">{m.ste_forum_write_roles_hint()}</p>
      <div class="role-grid">
        {#each roles as role (role.id)}
          <label class="flex items-center gap-2 text-body-sm">
            <input type="checkbox" checked={draft.writeRoleIds.includes(role.id)} onchange={() => toggleRole(role.id)} />
            <span style="color:{role.color === '#000000' ? 'inherit' : role.color}">@{role.name}</span>
          </label>
        {/each}
      </div>
    </div>
    <label class="flex items-center gap-2 text-body-sm">
      <input type="checkbox" bind:checked={draft.staffTopicsOnly} />
      <span>{m.ste_forum_staff_topics_label()}</span>
    </label>
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (editorOpen = false)}>{m.common_cancel()}</Button>
    <Button variant="primary" type="submit" form="forum-category-form" loading={saving}>{m.common_save()}</Button>
  {/snippet}
</Modal>

<style>
  .forum-list { list-style: none; margin: 0; padding: 0; }
  .forum-list li { display: flex; gap: 12px; align-items: flex-start; padding: 12px 16px; border-top: 1px solid var(--color-outline-variant); }
  .forum-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .forum-name { margin: 0; font-weight: 600; color: var(--color-on-surface); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .forum-name a { color: inherit; text-decoration: none; }
  .forum-name a:hover { text-decoration: underline; }
  .forum-meta { margin: 0; font-size: 0.82rem; color: var(--color-on-surface-variant); }
  .forum-excerpt { margin: 2px 0 0; font-size: 0.85rem; color: var(--color-on-surface); white-space: pre-wrap; overflow-wrap: anywhere; }
  .forum-chip { font-size: 0.72rem; font-weight: 500; padding: 1px 7px; border-radius: 4px; background: var(--color-surface-container); color: var(--color-on-surface-variant); }
  .forum-actions { display: flex; align-items: center; gap: 4px; flex: none; flex-wrap: wrap; justify-content: flex-end; }
  .mode-option { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border: 1px solid var(--color-outline-variant); border-radius: 10px; font-size: 0.88rem; cursor: pointer; }
  .mode-option input { margin-top: 3px; }
  .role-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 4px 12px; max-height: 160px; overflow: auto; }
</style>
