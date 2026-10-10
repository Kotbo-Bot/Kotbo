<script lang="ts">
  /**
   * Menu du site : entrées vers une page, une section (accueil, wiki, blog,
   * recherche, espace membre, votes) ou une adresse externe, sous-menus d'un niveau.
   * Sans menu, le site en compose un par défaut.
   */
  import { untrack } from 'svelte';
  import { SITE_NAV_LIMITS, SITE_NAV_SECTIONS, type SiteNavItem, type SiteNavSection, type SiteNavTarget } from '@kotbo/shared';
  import { Button, EmptyState, SectionCard } from '../ui';
  import { toast } from '../../stores/toast.svelte';
  import { m } from '../../i18n';
  import { updateSite, type SiteState } from '../../api/site';
  import { siteErrorMessage } from './siteErrors';

  let { siteState, guildId, onChanged }: { siteState: SiteState; guildId: string; onChanged: () => void } = $props();

  const initial = untrack(() => siteState.site!);
  let items = $state<SiteNavItem[]>($state.snapshot(initial.navigation ?? []) as SiteNavItem[]);
  let saving = $state(false);
  const dirty = $derived(JSON.stringify(items) !== JSON.stringify(siteState.site!.navigation ?? []));

  const pages = $derived(siteState.pages.filter((p) => p.kind === 'PAGE'));
  const SECTION_LABELS: Record<SiteNavSection, () => string> = {
    home: () => m.ste_link_home(),
    wiki: () => m.ste_link_wiki(),
    blog: () => m.ste_link_blog(),
    search: () => m.ste_section_search(),
    me: () => m.ste_section_me(),
    votes: () => m.ste_section_votes(),
    shop: () => m.ste_section_shop(),
    forum: () => m.ste_section_forum(),
  };

  const newId = () => `nav-${Math.random().toString(36).slice(2, 10)}`;

  function blank(): SiteNavItem {
    return { id: newId(), label: '', target: { type: 'section', section: 'home' }, children: [] };
  }

  function targetType(item: SiteNavItem): string {
    return item.target?.type ?? 'none';
  }

  function setTargetType(item: SiteNavItem, type: string) {
    if (type === 'page') item.target = { type: 'page', pageId: pages[0]?.id ?? '' };
    else if (type === 'section') item.target = { type: 'section', section: 'home' };
    else if (type === 'url') item.target = { type: 'url', href: 'https://' };
    else item.target = null;
  }

  function move(list: SiteNavItem[], index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
  }

  async function save() {
    saving = true;
    try {
      const cleaned = items.filter((item) => item.label.trim());
      await updateSite({ navigation: cleaned }, guildId);
      toast.success(m.ste_nav_saved());
      onChanged();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      saving = false;
    }
  }
</script>

{#snippet editor(item: SiteNavItem, list: SiteNavItem[], index: number, nested: boolean)}
  <div class="nav-row" class:is-nested={nested}>
    <input class="input w-44" maxlength={SITE_NAV_LIMITS.label} placeholder={m.ste_nav_label()} aria-label={m.ste_nav_label()} bind:value={item.label} />
    <select class="input w-36" aria-label={m.ste_nav_target()} value={targetType(item)} onchange={(e) => setTargetType(item, (e.currentTarget as HTMLSelectElement).value)}>
      <option value="page">{m.ste_nav_target_page()}</option>
      <option value="section">{m.ste_nav_target_section()}</option>
      <option value="url">{m.ste_nav_target_url()}</option>
      {#if !nested}<option value="none">{m.ste_nav_target_none()}</option>{/if}
    </select>
    {#if item.target?.type === 'page'}
      {@const target = item.target as Extract<SiteNavTarget, { type: 'page' }>}
      <select class="input flex-1 min-w-40" aria-label={m.ste_nav_target_page()} bind:value={target.pageId}>
        {#each pages as page (page.id)}<option value={page.id}>{page.title}</option>{/each}
      </select>
    {:else if item.target?.type === 'section'}
      {@const target = item.target as Extract<SiteNavTarget, { type: 'section' }>}
      <select class="input flex-1 min-w-40" aria-label={m.ste_nav_target_section()} bind:value={target.section}>
        {#each SITE_NAV_SECTIONS as section (section)}<option value={section}>{SECTION_LABELS[section]()}</option>{/each}
      </select>
    {:else if item.target?.type === 'url'}
      {@const target = item.target as Extract<SiteNavTarget, { type: 'url' }>}
      <input class="input flex-1 min-w-40" type="url" aria-label={m.ste_nav_target_url()} bind:value={target.href} />
    {:else}
      <span class="flex-1 text-2xs text-on-surface-variant">{m.ste_nav_dropdown_hint()}</span>
    {/if}
    <div class="flex gap-1">
      <Button size="sm" variant="ghost" icon="arrow-up" aria-label={m.ste_move_up()} onclick={() => move(list, index, -1)} />
      <Button size="sm" variant="ghost" icon="arrow-down" aria-label={m.ste_move_down()} onclick={() => move(list, index, 1)} />
      {#if !nested && item.children.length < SITE_NAV_LIMITS.children}
        <Button size="sm" variant="ghost" icon="plus" aria-label={m.ste_nav_add_child()} title={m.ste_nav_add_child()} onclick={() => (item.children = [...item.children, blank()])} />
      {/if}
      <Button size="sm" variant="ghost" icon="trash-2" aria-label={m.common_delete()} onclick={() => list.splice(index, 1)} />
    </div>
  </div>
{/snippet}

<SectionCard title={m.ste_nav_title()} description={m.ste_nav_desc()} icon="menu">
  <div class="px-5 pb-5 space-y-2">
    {#if items.length === 0}
      <EmptyState icon="menu" title={m.ste_nav_empty()} description={m.ste_nav_empty_desc()} />
    {/if}
    {#each items as item, index (item.id)}
      {@render editor(item, items, index, false)}
      {#each item.children as child, childIndex (child.id)}
        {@render editor(child, item.children, childIndex, true)}
      {/each}
    {/each}
    <div class="flex justify-between gap-2 pt-2">
      <Button size="sm" icon="plus" disabled={items.length >= SITE_NAV_LIMITS.topLevel} onclick={() => (items = [...items, blank()])}>{m.ste_nav_add()}</Button>
      <Button variant="primary" icon="check" loading={saving} disabled={!dirty} onclick={save}>{m.common_save()}</Button>
    </div>
  </div>
</SectionCard>

<style>
  .nav-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px; border-radius: 10px; background: var(--color-surface-container); }
  .nav-row.is-nested { margin-left: 32px; background: var(--color-surface-container); }
</style>
