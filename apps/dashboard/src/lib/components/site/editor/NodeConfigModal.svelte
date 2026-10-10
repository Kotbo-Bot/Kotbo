<script lang="ts">
  /**
   * Réglages d'un nœud de la page : bloc de module, bouton, vidéo, image,
   * sommaire, case de grille. Les valeurs sont relues à travers la même
   * normalisation que le serveur avant d'être rendues à l'éditeur.
   */
  import {
    normalizeModuleConfig,
    parseSiteVideo,
    SITE_KEY_STAT_METRICS,
    SITE_LEADERBOARD_VARIANTS,
    SITE_SECTION_LIMITS,
    type SiteKeyStatItem,
    type SiteModuleKey,
    type SitePartnerItem,
  } from '@kotbo/shared';
  import SiteIcon from '../SiteIcon.svelte';
  import { Button, Field, Modal } from '../../ui';
  import { m } from '../../../i18n';
  import type { SiteCatalog, SitePageSummary } from '../../../api/site';
  import { keyStatLabel, leaderboardVariantLabel, moduleDescription, moduleLabel, MODULE_ICONS } from './siteBlocks';
  import type { ConfigureRequest } from './siteNodes';

  let {
    request = $bindable<ConfigureRequest | null>(null),
    catalog,
    pages,
    onSave,
    pickAsset,
  }: {
    request: ConfigureRequest | null;
    catalog: SiteCatalog | null;
    pages: SitePageSummary[];
    onSave: (pos: number, attrs: Record<string, unknown>) => void;
    /** Ouvre la bibliothèque d'images ; le rappel reçoit l'adresse choisie. */
    pickAsset: (onPick: (src: string) => void) => void;
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

  type GalleryImage = { src: string; alt: string; caption: string };

  function galleryImages(): GalleryImage[] {
    return Array.isArray(attrs.images) ? (attrs.images as GalleryImage[]) : [];
  }

  function setGalleryImage(index: number, patch: Partial<GalleryImage>) {
    attrs.images = galleryImages().map((img, i) => (i === index ? { ...img, ...patch } : img));
  }

  function moveGalleryImage(index: number, delta: number) {
    const list = [...galleryImages()];
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    attrs.images = list;
  }

  function addGalleryImage() {
    pickAsset((src) => {
      if (galleryImages().length >= SITE_SECTION_LIMITS.galleryImages) return;
      attrs.images = [...galleryImages(), { src, alt: '', caption: '' }];
    });
  }

  function keyStats(): SiteKeyStatItem[] {
    return Array.isArray(config.items) ? (config.items as SiteKeyStatItem[]) : [];
  }

  function setKeyStat(index: number, patch: Partial<SiteKeyStatItem>) {
    config.items = keyStats().map((item, i) => (i === index ? { ...item, ...patch } : item));
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
      banner: () => m.ste_item_banner(),
      gallery: () => m.ste_item_gallery(),
      testimonial: () => m.ste_item_testimonial(),
    };
    return titles[request.type]?.() ?? '';
  });
</script>

<Modal bind:open {title} subtitle={moduleKey ? moduleDescription(moduleKey) : ''} size="md" onClose={close}>
  <form id="site-node-config" class="space-y-4" onsubmit={save}>
    {#if request?.type === 'module' && moduleKey}
      <div class="flex items-center gap-3 text-body-sm text-on-surface-variant">
        <SiteIcon name={MODULE_ICONS[moduleKey]} size={22} />
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

      {#if ['leaderboard', 'clans', 'news', 'events', 'giveaways', 'seasons', 'marketplace', 'starboard', 'suggestions', 'blogList', 'channelFeed', 'voteLeaderboard', 'changelog'].includes(moduleKey)}
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

      {#if moduleKey === 'shop'}
        <Field label={m.ste_cfg_shop_category()} hint={m.ste_cfg_shop_category_hint()}>
          {#snippet children(id, describedBy)}
            <input {id} aria-describedby={describedBy} class="input w-full" maxlength="40" bind:value={config.category} />
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

      {#if moduleKey === 'keyStats'}
        <div class="space-y-2">
          {#each keyStats() as item, index (index)}
            <div class="cfg-row flex flex-wrap gap-2 items-center">
              <select class="input w-48" aria-label={m.ste_cfg_metric()} value={item.metric} onchange={(e) => setKeyStat(index, { metric: (e.currentTarget as HTMLSelectElement).value as SiteKeyStatItem['metric'] })}>
                {#each SITE_KEY_STAT_METRICS as metric (metric)}<option value={metric}>{keyStatLabel(metric)}</option>{/each}
              </select>
              <input class="input flex-1 min-w-32" maxlength="40" aria-label={m.ste_cfg_stat_label()} placeholder={item.metric === 'custom' ? m.ste_cfg_stat_label() : keyStatLabel(item.metric)} value={item.label} oninput={(e) => setKeyStat(index, { label: (e.currentTarget as HTMLInputElement).value })} />
              {#if item.metric === 'custom'}
                <input class="input w-28" maxlength="20" aria-label={m.ste_cfg_stat_value()} placeholder={m.ste_cfg_stat_value()} value={item.value} oninput={(e) => setKeyStat(index, { value: (e.currentTarget as HTMLInputElement).value })} />
              {/if}
              <Button size="sm" variant="ghost" icon="trash-2" aria-label={m.common_delete()} onclick={() => (config.items = keyStats().filter((_, i) => i !== index))} />
            </div>
          {/each}
          {#if keyStats().length < 6}
            <Button size="sm" icon="plus" onclick={() => (config.items = [...keyStats(), { metric: 'members', label: '', value: '' }])}>{m.ste_cfg_stat_add()}</Button>
          {/if}
        </div>
      {/if}

      {#if moduleKey === 'partners'}
        <div class="space-y-3">
          {#each partners() as partner, index (index)}
            <div class="cfg-row space-y-2">
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
    {:else if request?.type === 'banner'}
      <Field label={m.ste_cfg_image()} hint={m.ste_cfg_banner_image_hint()}>
        {#snippet children()}
          <div class="flex items-center gap-3">
            {#if attrs.image}<img class="cfg-thumb cfg-thumb-wide" src={String(attrs.image)} alt="" />{/if}
            <Button size="sm" icon="image" onclick={() => pickAsset((src) => (attrs.image = src))}>{m.ste_cfg_image_choose()}</Button>
            {#if attrs.image}<Button size="sm" variant="ghost" onclick={() => (attrs.image = '')}>{m.ste_cover_remove()}</Button>{/if}
          </div>
        {/snippet}
      </Field>
      <div class="grid grid-cols-2 gap-3">
        <Field label={m.ste_cfg_tone()}>
          {#snippet children(id)}
            <select {id} class="input w-full" bind:value={attrs.tone} disabled={Boolean(attrs.image)}>
              <option value="surface">{m.ste_tone_surface()}</option>
              <option value="accent">{m.ste_tone_accent()}</option>
              <option value="dark">{m.ste_tone_dark()}</option>
            </select>
          {/snippet}
        </Field>
        <Field label={m.ste_cfg_align()}>
          {#snippet children(id)}
            <select {id} class="input w-full" bind:value={attrs.align}>
              <option value="center">{m.ste_align_center()}</option>
              <option value="left">{m.ste_align_left()}</option>
            </select>
          {/snippet}
        </Field>
      </div>
      <label class="flex items-center gap-2 text-body-sm text-on-surface">
        <input type="checkbox" checked={attrs.tall === true} onchange={(e) => (attrs.tall = (e.currentTarget as HTMLInputElement).checked)} />
        {m.ste_cfg_tall()}
      </label>
    {:else if request?.type === 'gallery'}
      <div class="grid grid-cols-2 gap-3">
        <Field label={m.ste_cfg_layout()}>
          {#snippet children(id)}
            <select {id} class="input w-full" bind:value={attrs.layout}>
              <option value="grid">{m.ste_layout_grid()}</option>
              <option value="carousel">{m.ste_layout_carousel()}</option>
            </select>
          {/snippet}
        </Field>
        {#if attrs.layout !== 'carousel'}
          <Field label={m.ste_cfg_columns()}>
            {#snippet children(id)}
              <select {id} class="input w-full" bind:value={attrs.columns}>
                {#each [2, 3, 4] as n (n)}<option value={n}>{n}</option>{/each}
              </select>
            {/snippet}
          </Field>
        {/if}
      </div>
      <div class="space-y-2">
        {#each galleryImages() as image, index (index)}
          <div class="cfg-row flex gap-3 items-start">
            <img class="cfg-thumb" src={image.src} alt="" />
            <div class="flex-1 space-y-2 min-w-0">
              <input class="input w-full" maxlength="300" aria-label={m.ste_alt_text()} placeholder={m.ste_alt_text()} value={image.alt} oninput={(e) => setGalleryImage(index, { alt: (e.currentTarget as HTMLInputElement).value })} />
              <input class="input w-full" maxlength="300" aria-label={m.ste_caption()} placeholder={m.ste_caption()} value={image.caption} oninput={(e) => setGalleryImage(index, { caption: (e.currentTarget as HTMLInputElement).value })} />
            </div>
            <div class="flex flex-col gap-1">
              <Button size="sm" variant="ghost" icon="arrow-up" aria-label={m.ste_move_up()} onclick={() => moveGalleryImage(index, -1)} />
              <Button size="sm" variant="ghost" icon="arrow-down" aria-label={m.ste_move_down()} onclick={() => moveGalleryImage(index, 1)} />
              <Button size="sm" variant="ghost" icon="trash-2" aria-label={m.common_delete()} onclick={() => (attrs.images = galleryImages().filter((_, i) => i !== index))} />
            </div>
          </div>
        {:else}
          <p class="text-body-sm text-on-surface-variant">{m.ste_gallery_empty()}</p>
        {/each}
        {#if galleryImages().length < SITE_SECTION_LIMITS.galleryImages}
          <Button size="sm" icon="plus" onclick={addGalleryImage}>{m.ste_gallery_add()}</Button>
        {/if}
      </div>
    {:else if request?.type === 'testimonial'}
      <div class="grid grid-cols-2 gap-3">
        <Field label={m.ste_testimonial_name()}>
          {#snippet children(id)}
            <input {id} class="input w-full" maxlength="80" bind:value={attrs.name} />
          {/snippet}
        </Field>
        <Field label={m.ste_testimonial_role()}>
          {#snippet children(id)}
            <input {id} class="input w-full" maxlength="80" bind:value={attrs.role} />
          {/snippet}
        </Field>
      </div>
      <Field label={m.ste_testimonial_avatar()}>
        {#snippet children()}
          <div class="flex items-center gap-3">
            {#if attrs.avatar}<img class="cfg-thumb cfg-thumb-round" src={String(attrs.avatar)} alt="" />{/if}
            <Button size="sm" icon="image" onclick={() => pickAsset((src) => (attrs.avatar = src))}>{m.ste_cfg_image_choose()}</Button>
            {#if attrs.avatar}<Button size="sm" variant="ghost" onclick={() => (attrs.avatar = '')}>{m.ste_cover_remove()}</Button>{/if}
          </div>
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

<style>
  .cfg-row { border: 1px solid var(--color-outline-variant); border-radius: 8px; padding: 10px; }
  .cfg-thumb { flex: none; width: 64px; height: 48px; object-fit: cover; border-radius: 6px; background: var(--color-surface-container); }
  .cfg-thumb-wide { width: 120px; height: 52px; }
  .cfg-thumb-round { width: 44px; height: 44px; border-radius: 50%; }
</style>
