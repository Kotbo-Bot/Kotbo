<script lang="ts">
  /**
   * Réglages d'un nœud de la page : bloc de module, bouton, vidéo, image,
   * sommaire, case de grille. Les valeurs sont relues à travers la même
   * normalisation que le serveur avant d'être rendues à l'éditeur.
   */
  import {
    normalizeModuleConfig,
    parseSiteVideo,
    SITE_LEADERBOARD_VARIANTS,
    type SiteModuleKey,
    type SitePartnerItem,
  } from '@kotbo/shared';
  import { Button, Field, Modal } from '../../ui';
  import { m } from '../../../i18n';
  import type { SiteCatalog, SitePageSummary } from '../../../api/site';
  import { leaderboardVariantLabel, moduleDescription, moduleLabel, MODULE_ICONS } from './siteBlocks';
  import type { ConfigureRequest } from './siteNodes';

  let {
    request = $bindable<ConfigureRequest | null>(null),
    catalog,
    pages,
    onSave,
  }: {
    request: ConfigureRequest | null;
    catalog: SiteCatalog | null;
    pages: SitePageSummary[];
    onSave: (pos: number, attrs: Record<string, unknown>) => void;
  } = $props();

  let open = $state(false);
  let attrs = $state<Record<string, unknown>>({});
  let config = $state<Record<string, unknown>>({});
  let videoUrl = $state('');
  let linkMode = $state<'page' | 'url'>('page');
  let error = $state('');

  const moduleKey = $derived((request?.type === 'module' ? String(attrs.module) : '') as SiteModuleKey | '');

  $effect(() => {
    if (!request) return;
    attrs = $state.snapshot(request.attrs) as Record<string, unknown>;
    config = $state.snapshot((request.attrs.config ?? {}) as Record<string, unknown>) as Record<string, unknown>;
    videoUrl = request.type === 'video' && request.attrs.videoId ? videoLink(String(request.attrs.provider), String(request.attrs.videoId)) : '';
    linkMode = typeof request.attrs.href === 'string' && /^https?:|^mailto:/.test(request.attrs.href) ? 'url' : 'page';
    error = '';
    open = true;
  });

  function videoLink(provider: string, id: string): string {
    if (provider === 'twitch') return id.startsWith('v') ? `https://www.twitch.tv/videos/${id.slice(1)}` : `https://www.twitch.tv/${id}`;
    if (provider === 'vimeo') return `https://vimeo.com/${id}`;
    return `https://www.youtube.com/watch?v=${id}`;
  }

  function close() {
    open = false;
    request = null;
  }

  function pageHref(page: SitePageSummary): string {
    if (page.kind === 'WIKI') return `/~/wiki/${page.slug}`;
    if (page.kind === 'BLOG') return `/~/blog/${page.slug}`;
    return `/~/${page.slug}`;
  }

  const linkablePages = $derived(pages.filter((p) => p.publishedAt || p.hasUnpublishedChanges));

  function save(event?: SubmitEvent) {
    event?.preventDefault();
    if (!request) return;
    let next: Record<string, unknown> = { ...attrs };
    if (request.type === 'module' && moduleKey) {
      next = { module: moduleKey, config: normalizeModuleConfig(moduleKey, config) };
    } else if (request.type === 'video') {
      const parsed = parseSiteVideo(videoUrl);
      if (!parsed) {
        error = m.ste_video_invalid();
        return;
      }
      next = { ...attrs, ...parsed };
    } else if (request.type === 'button') {
      if (!String(attrs.label ?? '').trim() || !String(attrs.href ?? '').trim()) {
        error = m.ste_button_required();
        return;
      }
    }
    onSave(request.pos, next);
    close();
  }

  function toggleIn(list: unknown, id: string): string[] {
    const current = Array.isArray(list) ? (list as string[]) : [];
    return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
  }

  function partners(): SitePartnerItem[] {
    return Array.isArray(config.items) ? (config.items as SitePartnerItem[]) : [];
  }

  function setPartner(index: number, patch: Partial<SitePartnerItem>) {
    config.items = partners().map((p, i) => (i === index ? { ...p, ...patch } : p));
  }

  const title = $derived.by(() => {
    if (!request) return '';
    if (request.type === 'module' && moduleKey) return moduleLabel(moduleKey);
    const titles: Record<string, () => string> = {
      button: () => m.ste_item_button(),
      video: () => m.ste_item_video(),
      image: () => m.ste_item_image(),
      toc: () => m.ste_item_toc(),
      gridCell: () => m.ste_cell_title(),
    };
    return titles[request.type]?.() ?? '';
  });
</script>

<Modal bind:open {title} subtitle={moduleKey ? moduleDescription(moduleKey) : ''} size="md" onClose={close}>
  <form id="site-node-config" class="space-y-4" onsubmit={save}>
    {#if request?.type === 'module' && moduleKey}
      <div class="flex items-center gap-3 text-body-sm text-on-surface-variant">
        <span class="text-2xl" aria-hidden="true">{MODULE_ICONS[moduleKey]}</span>
        {#if catalog?.blocks.find((b) => b.key === moduleKey)?.available === false}
          <span class="text-warning">{m.ste_block_unavailable()}</span>
        {/if}
      </div>

      {#if moduleKey === 'leaderboard'}
        <Field label={m.ste_cfg_variant()}>
          {#snippet children(id)}
            <select {id} class="input w-full" bind:value={config.variant}>
              {#each SITE_LEADERBOARD_VARIANTS as variant (variant)}
                <option value={variant}>{leaderboardVariantLabel(variant)}</option>
              {/each}
            </select>
          {/snippet}
        </Field>
      {/if}

      {#if moduleKey === 'clans'}
        <Field label={m.ste_cfg_variant()}>
          {#snippet children(id)}
            <select {id} class="input w-full" bind:value={config.variant}>
              <option value="leveling">{m.ste_variant_clans_leveling()}</option>
              <option value="rpg">{m.ste_variant_clans_rpg()}</option>
            </select>
          {/snippet}
        </Field>
      {/if}

      {#if ['leaderboard', 'clans', 'news', 'events', 'giveaways', 'seasons', 'marketplace', 'starboard', 'suggestions', 'blogList', 'channelFeed'].includes(moduleKey)}
        <Field label={m.ste_cfg_limit()}>
          {#snippet children(id)}
            <input {id} class="input w-32" type="number" min="1" max="100" bind:value={config.limit} />
          {/snippet}
        </Field>
      {/if}

      {#if ['news', 'events', 'blogList'].includes(moduleKey)}
        <Field label={m.ste_cfg_layout()}>
          {#snippet children(id)}
            <select {id} class="input w-full" bind:value={config.layout}>
              <option value="cards">{m.ste_layout_cards()}</option>
              <option value="list">{m.ste_layout_list()}</option>
            </select>
          {/snippet}
        </Field>
      {/if}

      {#if moduleKey === 'giveaways'}
        <Field label={m.ste_cfg_filter()}>
          {#snippet children(id)}
            <select {id} class="input w-full" bind:value={config.filter}>
              <option value="active">{m.ste_filter_active()}</option>
              <option value="ended">{m.ste_filter_ended()}</option>
              <option value="all">{m.ste_filter_all()}</option>
            </select>
          {/snippet}
        </Field>
      {/if}

      {#if moduleKey === 'suggestions'}
        <Field label={m.ste_cfg_filter()}>
          {#snippet children(id)}
            <select {id} class="input w-full" bind:value={config.filter}>
              <option value="open">{m.ste_filter_open()}</option>
              <option value="accepted">{m.ste_filter_accepted()}</option>
              <option value="all">{m.ste_filter_all()}</option>
            </select>
          {/snippet}
        </Field>
        <label class="flex items-center gap-2 text-body-sm text-on-surface">
          <input type="checkbox" checked={config.allowSubmit !== false} onchange={(e) => (config.allowSubmit = (e.currentTarget as HTMLInputElement).checked)} />
          {m.ste_cfg_allow_submit()}
        </label>
      {/if}

      {#if moduleKey === 'blogList'}
        <Field label={m.ste_cfg_tag()} hint={m.ste_cfg_tag_hint()}>
          {#snippet children(id, describedBy)}
            <input {id} aria-describedby={describedBy} class="input w-full" maxlength="40" bind:value={config.tag} />
          {/snippet}
        </Field>
      {/if}

      {#if moduleKey === 'staff'}
        <Field label={m.ste_cfg_layout()}>
          {#snippet children(id)}
            <select {id} class="input w-full" bind:value={config.layout}>
              <option value="grid">{m.ste_layout_grid()}</option>
              <option value="org">{m.ste_layout_org()}</option>
            </select>
          {/snippet}
        </Field>
        <fieldset class="space-y-2">
          <legend class="text-body-sm font-medium text-on-surface">{m.ste_cfg_hierarchies()}</legend>
          <p class="text-2xs text-on-surface-variant">{m.ste_cfg_hierarchies_hint()}</p>
          {#each catalog?.hierarchies ?? [] as hierarchy (hierarchy.id)}
            <label class="flex items-center gap-2 text-body-sm text-on-surface">
              <input type="checkbox" checked={((config.hierarchyIds as string[]) ?? []).includes(hierarchy.id)} onchange={() => (config.hierarchyIds = toggleIn(config.hierarchyIds, hierarchy.id))} />
              {hierarchy.icon ?? ''} {hierarchy.name}
            </label>
          {/each}
        </fieldset>
      {/if}

      {#if moduleKey === 'form'}
        <Field label={m.ste_cfg_form()}>
          {#snippet children(id)}
            <select {id} class="input w-full" bind:value={config.formId}>
              <option value="">—</option>
              {#each catalog?.forms ?? [] as form (form.id)}
                <option value={form.id}>{form.name}</option>
              {/each}
            </select>
          {/snippet}
        </Field>
      {/if}

      {#if moduleKey === 'recruitment'}
        <fieldset class="space-y-2">
          <legend class="text-body-sm font-medium text-on-surface">{m.ste_cfg_recruitment_forms()}</legend>
          <p class="text-2xs text-on-surface-variant">{m.ste_cfg_recruitment_hint()}</p>
          {#each (catalog?.forms ?? []).filter((f) => f.isRecruitment) as form (form.id)}
            <label class="flex items-center gap-2 text-body-sm text-on-surface">
              <input type="checkbox" checked={((config.formIds as string[]) ?? []).includes(form.id)} onchange={() => (config.formIds = toggleIn(config.formIds, form.id))} />
              {form.name}
            </label>
          {/each}
        </fieldset>
      {/if}

      {#if moduleKey === 'channelFeed'}
        <Field label={m.ste_cfg_channel()} hint={m.ste_cfg_channel_hint()}>
          {#snippet children(id, describedBy)}
            <select {id} aria-describedby={describedBy} class="input w-full" bind:value={config.channelId}>
              <option value="">—</option>
              {#each (catalog?.channels ?? []).filter((c) => c.public) as channel (channel.id)}
                <option value={channel.id}>#{channel.name}</option>
              {/each}
            </select>
          {/snippet}
        </Field>
      {/if}

      {#if moduleKey === 'join'}
        <Field label={m.ste_cfg_button_label()} hint={m.ste_cfg_join_hint()}>
          {#snippet children(id, describedBy)}
            <input {id} aria-describedby={describedBy} class="input w-full" maxlength="60" bind:value={config.label} />
          {/snippet}
        </Field>
      {/if}

      {#if moduleKey === 'wikiIndex'}
        <Field label={m.ste_cfg_wiki_root()}>
          {#snippet children(id)}
            <select {id} class="input w-full" bind:value={config.parentId}>
              <option value="">{m.ste_cfg_wiki_root_all()}</option>
              {#each pages.filter((p) => p.kind === 'WIKI') as page (page.id)}
                <option value={page.id}>{page.title}</option>
              {/each}
            </select>
          {/snippet}
        </Field>
      {/if}

      {#if moduleKey === 'partners'}
        <div class="space-y-3">
          {#each partners() as partner, index (index)}
            <div class="rounded-lg border border-white/10 p-3 space-y-2">
              <div class="flex gap-2">
                <input class="input flex-1" maxlength="80" placeholder={m.ste_partner_name()} value={partner.name} oninput={(e) => setPartner(index, { name: (e.currentTarget as HTMLInputElement).value })} />
                <Button size="sm" variant="ghost" icon="trash-2" aria-label={m.common_delete()} onclick={() => (config.items = partners().filter((_, i) => i !== index))} />
              </div>
              <input class="input w-full" maxlength="400" placeholder={m.ste_partner_desc()} value={partner.description} oninput={(e) => setPartner(index, { description: (e.currentTarget as HTMLInputElement).value })} />
              <div class="flex gap-2">
                <input class="input flex-1" type="url" placeholder={m.ste_partner_url()} value={partner.url} oninput={(e) => setPartner(index, { url: (e.currentTarget as HTMLInputElement).value })} />
                <input class="input flex-1" type="url" placeholder={m.ste_partner_logo()} value={partner.logoUrl} oninput={(e) => setPartner(index, { logoUrl: (e.currentTarget as HTMLInputElement).value })} />
              </div>
            </div>
          {/each}
          <Button size="sm" icon="plus" onclick={() => (config.items = [...partners(), { name: '', description: '', url: '', logoUrl: '' }])}>{m.ste_partner_add()}</Button>
        </div>
      {/if}
    {:else if request?.type === 'button'}
      <Field label={m.ste_cfg_button_label()} required>
        {#snippet children(id)}
          <input {id} class="input w-full" maxlength="80" bind:value={attrs.label} />
        {/snippet}
      </Field>
      <div class="flex gap-2 text-body-sm">
        <Button size="sm" variant={linkMode === 'page' ? 'primary' : 'ghost'} onclick={() => (linkMode = 'page')}>{m.ste_link_page()}</Button>
        <Button size="sm" variant={linkMode === 'url' ? 'primary' : 'ghost'} onclick={() => (linkMode = 'url')}>{m.ste_link_url()}</Button>
      </div>
      {#if linkMode === 'page'}
        <Field label={m.ste_link_page()}>
          {#snippet children(id)}
            <select {id} class="input w-full" bind:value={attrs.href}>
              <option value="/~/">{m.ste_link_home()}</option>
              <option value="/~/wiki">{m.ste_link_wiki()}</option>
              <option value="/~/blog">{m.ste_link_blog()}</option>
              {#each linkablePages as page (page.id)}
                <option value={pageHref(page)}>{page.title}</option>
              {/each}
            </select>
          {/snippet}
        </Field>
      {:else}
        <Field label={m.ste_link_url()}>
          {#snippet children(id)}
            <input {id} class="input w-full" type="url" placeholder="https://" bind:value={attrs.href} />
          {/snippet}
        </Field>
      {/if}
      <div class="grid grid-cols-2 gap-3">
        <Field label={m.ste_cfg_style()}>
          {#snippet children(id)}
            <select {id} class="input w-full" bind:value={attrs.variant}>
              <option value="primary">{m.ste_btn_primary()}</option>
              <option value="secondary">{m.ste_btn_secondary()}</option>
              <option value="ghost">{m.ste_btn_ghost()}</option>
            </select>
          {/snippet}
        </Field>
        <Field label={m.ste_cfg_align()}>
          {#snippet children(id)}
            <select {id} class="input w-full" bind:value={attrs.align}>
              <option value="left">{m.ste_align_left()}</option>
              <option value="center">{m.ste_align_center()}</option>
              <option value="right">{m.ste_align_right()}</option>
            </select>
          {/snippet}
        </Field>
      </div>
    {:else if request?.type === 'video'}
      <Field label={m.ste_video_url()} hint={m.ste_video_url_hint()} required>
        {#snippet children(id, describedBy)}
          <input {id} aria-describedby={describedBy} class="input w-full" type="url" bind:value={videoUrl} placeholder="https://www.youtube.com/watch?v=…" />
        {/snippet}
      </Field>
      <Field label={m.ste_caption()}>
        {#snippet children(id)}
          <input {id} class="input w-full" maxlength="300" bind:value={attrs.caption} />
        {/snippet}
      </Field>
    {:else if request?.type === 'image'}
      <Field label={m.ste_alt_text()} hint={m.ste_alt_text_hint()}>
        {#snippet children(id, describedBy)}
          <input {id} aria-describedby={describedBy} class="input w-full" maxlength="300" bind:value={attrs.alt} />
        {/snippet}
      </Field>
    {:else if request?.type === 'toc'}
      <Field label={m.ste_toc_depth()}>
        {#snippet children(id)}
          <select {id} class="input w-full" bind:value={attrs.maxLevel}>
            <option value={2}>H2</option>
            <option value={3}>H2 – H3</option>
            <option value={4}>H2 – H4</option>
          </select>
        {/snippet}
      </Field>
    {:else if request?.type === 'gridCell'}
      <div class="grid grid-cols-2 gap-3">
        <Field label={m.ste_cell_span()}>
          {#snippet children(id)}
            <select {id} class="input w-full" bind:value={attrs.span}>
              {#each [1, 2, 3, 4] as n (n)}<option value={n}>{n}</option>{/each}
            </select>
          {/snippet}
        </Field>
        <Field label={m.ste_cell_rows()}>
          {#snippet children(id)}
            <select {id} class="input w-full" bind:value={attrs.rowSpan}>
              {#each [1, 2, 3] as n (n)}<option value={n}>{n}</option>{/each}
            </select>
          {/snippet}
        </Field>
      </div>
      <label class="flex items-center gap-2 text-body-sm text-on-surface">
        <input type="checkbox" checked={attrs.surface !== false} onchange={(e) => (attrs.surface = (e.currentTarget as HTMLInputElement).checked)} />
        {m.ste_cell_surface()}
      </label>
    {/if}

    {#if error}<p class="text-body-sm text-error" role="alert">{error}</p>{/if}
  </form>

  {#snippet footer()}
    <Button variant="ghost" onclick={close}>{m.common_cancel()}</Button>
    <Button variant="primary" type="submit" form="site-node-config">{m.common_save()}</Button>
  {/snippet}
</Modal>
