<script lang="ts">
  /**
   * Réglages du site : adresse, nom, accroche, page Équipe, commentaires,
   * rédacteurs du wiki et du blog (sans accès au dashboard), salons
   * d'annonce, suppression.
   */
  import { router } from 'tinro';
  import { validateSiteSlug } from '@kotbo/shared';
  import { Button, Callout, Field, SectionCard, ToggleSwitch } from '../ui';
  import { toast } from '../../stores/toast.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { m } from '../../i18n';
  import { deleteSite, updateSite, type CommunitySite, type SiteCatalog, type SiteState } from '../../api/site';
  import { siteErrorMessage } from './siteErrors';

  let { state, catalog, guildId, onChanged }: { state: SiteState; catalog: SiteCatalog | null; guildId: string; onChanged: () => void } = $props();

  const site = $derived(state.site!);
  let slug = $state(state.site!.slug);
  let name = $state(state.site!.name ?? '');
  let tagline = $state(state.site!.tagline ?? '');
  let staffPage = $state({ bio: true, absence: true, seniority: true, stats: false, ...(state.site!.staffPage ?? {}) });
  let commentsByDefault = $state(state.site!.settings?.commentsByDefault !== false);
  let wikiEditors = $state<string[]>([...state.site!.wikiEditorRoleIds]);
  let blogEditors = $state<string[]>([...state.site!.blogEditorRoleIds]);
  let wikiChannel = $state(state.site!.wikiAnnounceChannelId ?? '');
  let blogChannel = $state(state.site!.blogAnnounceChannelId ?? '');
  let saving = $state(false);
  let deleteConfirm = $state('');

  const slugChanged = $derived(slug !== site.slug);
  const slugInvalid = $derived(slugChanged && validateSiteSlug(slug) !== null);
  const channels = $derived((catalog?.channels ?? []).filter((c) => c.botCanSend));

  function toggle(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  async function save() {
    if (slugInvalid) return;
    if (slugChanged) {
      const ok = await confirmDialog.ask({ title: m.ste_slug_change_title(), description: m.ste_slug_change_confirm({ old: site.slug, next: slug }), confirmLabel: m.common_save() });
      if (!ok) return;
    }
    saving = true;
    try {
      const patch: Partial<CommunitySite> = {
        name: name.trim() || null,
        tagline: tagline.trim() || null,
        staffPage,
        settings: { ...site.settings, commentsByDefault },
        wikiEditorRoleIds: wikiEditors,
        blogEditorRoleIds: blogEditors,
        wikiAnnounceChannelId: wikiChannel || null,
        blogAnnounceChannelId: blogChannel || null,
      };
      if (slugChanged) patch.slug = slug;
      await updateSite(patch, guildId);
      toast.success(m.ste_settings_saved());
      onChanged();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      saving = false;
    }
  }

  async function remove() {
    if (deleteConfirm !== site.slug) return;
    const ok = await confirmDialog.ask({ title: m.ste_delete_site_title(), description: m.ste_delete_site_confirm(), confirmLabel: m.common_delete(), variant: 'danger' });
    if (!ok) return;
    try {
      await deleteSite(guildId);
      toast.success(m.ste_site_deleted());
      router.goto('/site');
      onChanged();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  const STAFF_FIELDS: Array<[keyof typeof staffPage, () => string]> = [
    ['bio', () => m.ste_staff_field_bio()],
    ['absence', () => m.ste_staff_field_absence()],
    ['seniority', () => m.ste_staff_field_seniority()],
    ['stats', () => m.ste_staff_field_stats()],
  ];
</script>

<div class="space-y-4">
  <SectionCard title={m.ste_identity()} icon="globe">
    <div class="px-5 pb-5 grid gap-4 md:grid-cols-2">
      <Field label={m.ste_slug_site()} hint={`${state.baseUrl}${slug}`} error={slugInvalid ? m.ste_err_slug_invalid() : ''}>
        {#snippet children(id, describedBy)}
          <input {id} aria-describedby={describedBy} class="input w-full font-mono" maxlength="40" bind:value={slug} />
        {/snippet}
      </Field>
      <Field label={m.ste_site_name()} hint={m.ste_site_name_hint()}>
        {#snippet children(id, describedBy)}
          <input {id} aria-describedby={describedBy} class="input w-full" maxlength="60" placeholder={state.guild?.name ?? ''} bind:value={name} />
        {/snippet}
      </Field>
      <div class="md:col-span-2">
        <Field label={m.ste_tagline()} hint={m.ste_tagline_hint()}>
          {#snippet children(id, describedBy)}
            <input {id} aria-describedby={describedBy} class="input w-full" maxlength="200" bind:value={tagline} />
          {/snippet}
        </Field>
      </div>
      {#if slugChanged}<div class="md:col-span-2"><Callout variant="info">{m.ste_slug_redirect_note()}</Callout></div>{/if}
    </div>
  </SectionCard>

  <SectionCard title={m.ste_staff_page()} description={m.ste_staff_page_desc()} icon="users">
    <div class="px-5 pb-5 grid gap-3 sm:grid-cols-2">
      {#each STAFF_FIELDS as [key, label] (key)}
        <label class="flex items-center gap-3 text-body-sm text-on-surface">
          <ToggleSwitch size="sm" checked={staffPage[key]} ariaLabel={label()} onToggle={(v) => (staffPage = { ...staffPage, [key]: v })} />
          {label()}
        </label>
      {/each}
    </div>
  </SectionCard>

  {#if state.modules.site_wiki || state.modules.site_blog}
    <SectionCard title={m.ste_editors()} description={m.ste_editors_desc()} icon="edit-2">
      <div class="px-5 pb-5 grid gap-6 md:grid-cols-2">
        {#each [['wiki', state.modules.site_wiki, wikiEditors, m.ste_editors_wiki()], ['blog', state.modules.site_blog, blogEditors, m.ste_editors_blog()]] as [key, enabled, list, label] (key)}
          {#if enabled}
            <fieldset class="space-y-2">
              <legend class="text-body-sm font-medium text-on-surface">{label}</legend>
              <div class="role-list">
                {#each catalog?.roles ?? [] as role (role.id)}
                  <label class="flex items-center gap-2 text-body-sm">
                    <input
                      type="checkbox"
                      checked={(list as string[]).includes(role.id)}
                      onchange={() => {
                        if (key === 'wiki') wikiEditors = toggle(wikiEditors, role.id);
                        else blogEditors = toggle(blogEditors, role.id);
                      }}
                    />
                    <span style="color:{role.color === '#000000' ? 'inherit' : role.color}">@{role.name}</span>
                  </label>
                {/each}
              </div>
            </fieldset>
          {/if}
        {/each}
      </div>
    </SectionCard>

    <SectionCard title={m.ste_announces()} description={m.ste_announces_desc()} icon="bell">
      <div class="px-5 pb-5 grid gap-4 md:grid-cols-2">
        {#if state.modules.site_wiki}
          <Field label={m.ste_announce_wiki()}>
            {#snippet children(id)}
              <select {id} class="input w-full" bind:value={wikiChannel}>
                <option value="">{m.ste_announce_none()}</option>
                {#each channels as channel (channel.id)}<option value={channel.id}>#{channel.name}</option>{/each}
              </select>
            {/snippet}
          </Field>
        {/if}
        {#if state.modules.site_blog}
          <Field label={m.ste_announce_blog()}>
            {#snippet children(id)}
              <select {id} class="input w-full" bind:value={blogChannel}>
                <option value="">{m.ste_announce_none()}</option>
                {#each channels as channel (channel.id)}<option value={channel.id}>#{channel.name}</option>{/each}
              </select>
            {/snippet}
          </Field>
          <label class="flex items-center gap-3 text-body-sm text-on-surface md:col-span-2">
            <ToggleSwitch size="sm" checked={commentsByDefault} ariaLabel={m.ste_comments_default()} onToggle={(v) => (commentsByDefault = v)} />
            {m.ste_comments_default()}
          </label>
        {/if}
      </div>
    </SectionCard>
  {/if}

  <div class="flex justify-end">
    <Button variant="primary" icon="check" loading={saving} disabled={slugInvalid} onclick={save}>{m.common_save()}</Button>
  </div>

  <SectionCard title={m.ste_danger_zone()} icon="alert-triangle">
    <div class="px-5 pb-5 space-y-3">
      <p class="text-body-sm text-on-surface-variant">{m.ste_delete_site_desc()}</p>
      <div class="flex flex-wrap gap-2">
        <input class="input w-64 font-mono" placeholder={site.slug} aria-label={m.ste_delete_site_type({ slug: site.slug })} bind:value={deleteConfirm} />
        <Button variant="danger" icon="trash-2" disabled={deleteConfirm !== site.slug} onclick={remove}>{m.ste_delete_site()}</Button>
      </div>
      <p class="text-2xs text-on-surface-variant">{m.ste_delete_site_type({ slug: site.slug })}</p>
    </div>
  </SectionCard>
</div>

<style>
  .role-list { display: flex; flex-direction: column; gap: 6px; max-height: 240px; overflow-y: auto; padding-right: 6px; }
</style>
