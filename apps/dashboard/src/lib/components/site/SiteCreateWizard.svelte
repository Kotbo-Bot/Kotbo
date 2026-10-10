<script lang="ts">
  /**
   * Création du site : une adresse, un type de communauté. Les pages sont
   * composées d'après les modules actifs du serveur ; tout se modifie ensuite.
   */
  import { untrack } from 'svelte';
  import { resolveSiteTheme, slugify, validateSiteSlug, type SiteIconName } from '@kotbo/shared';
  import { Button, Field, SectionCard } from '../ui';
  import { toast } from '../../stores/toast.svelte';
  import { m } from '../../i18n';
  import { createSite, type SiteState, type SiteTemplate } from '../../api/site';
  import { siteErrorMessage } from './siteErrors';
  import SiteIcon from './SiteIcon.svelte';

  let { siteState, guildId, onCreated }: { siteState: SiteState; guildId: string; onCreated: () => void } = $props();

  // Même correspondance que les modèles du bot (siteTemplates.ts).
  const THEMES: Record<SiteTemplate, string> = { general: 'azur', gaming: 'carbone', rp: 'royaume', esport: 'braise', etude: 'documentation' };
  const TEMPLATES: Array<{ key: SiteTemplate; label: () => string; desc: () => string; icon: SiteIconName }> = [
    { key: 'general', label: () => m.ste_tpl_general(), desc: () => m.ste_tpl_general_desc(), icon: 'message-circle' },
    { key: 'gaming', label: () => m.ste_tpl_gaming(), desc: () => m.ste_tpl_gaming_desc(), icon: 'gamepad' },
    { key: 'rp', label: () => m.ste_tpl_rp(), desc: () => m.ste_tpl_rp_desc(), icon: 'castle' },
    { key: 'esport', label: () => m.ste_tpl_esport(), desc: () => m.ste_tpl_esport_desc(), icon: 'trophy' },
    { key: 'etude', label: () => m.ste_tpl_etude(), desc: () => m.ste_tpl_etude_desc(), icon: 'graduation' },
  ];

  let slug = $state(untrack(() => siteState.suggestedSlug) ?? '');
  let template = $state<SiteTemplate>('general');
  let creating = $state(false);

  const slugError = $derived.by(() => {
    if (!slug) return '';
    const error = validateSiteSlug(slug);
    if (error === 'too_short') return m.ste_err_slug_short();
    if (error === 'too_long') return m.ste_err_slug_long();
    if (error === 'invalid') return m.ste_err_slug_invalid();
    if (error === 'reserved') return m.ste_err_slug_reserved();
    return '';
  });

  async function create(event: SubmitEvent) {
    event.preventDefault();
    if (slugError || !slug) return;
    creating = true;
    try {
      await createSite({ slug, template }, guildId);
      toast.success(m.ste_created_toast());
      onCreated();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      creating = false;
    }
  }
</script>

<SectionCard title={m.ste_create_title()} description={m.ste_create_desc()} icon="globe">
  <form class="px-5 pb-5 space-y-6" onsubmit={create}>
    <Field label={m.ste_create_address()} hint={`${siteState.baseUrl}${slug || '…'}`} error={slugError}>
      {#snippet children(id, describedBy)}
        <input {id} aria-describedby={describedBy} class="input w-full font-mono" maxlength="40" bind:value={slug} oninput={() => (slug = slug.toLowerCase().replace(/ +/g, '-'))} onblur={() => (slug = slugify(slug, 40))} />
      {/snippet}
    </Field>

    <fieldset class="space-y-2">
      <legend class="text-body-sm font-medium text-on-surface mb-2">{m.ste_create_type()}</legend>
      <div class="tpl-list">
        {#each TEMPLATES as tpl (tpl.key)}
          {@const theme = resolveSiteTheme(THEMES[tpl.key], {})}
          <label class="tpl-row" class:is-selected={template === tpl.key}>
            <input class="sr-only" type="radio" name="template" value={tpl.key} bind:group={template} />
            <span class="tpl-icon" style="--accent:{theme.accent}"><SiteIcon name={tpl.icon} size={20} /></span>
            <span class="min-w-0">
              <span class="tpl-name">{tpl.label()}</span>
              <span class="tpl-desc">{tpl.desc()}</span>
            </span>
          </label>
        {/each}
      </div>
    </fieldset>

    <p class="text-body-sm text-on-surface-variant">{m.ste_create_note()}</p>

    <div class="flex justify-end">
      <Button variant="primary" type="submit" icon="plus" loading={creating} disabled={!slug || !!slugError}>{m.ste_create_button()}</Button>
    </div>
  </form>
</SectionCard>

<style>
  .tpl-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 8px; }
  .tpl-row { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--color-outline-variant); cursor: pointer; }
  .tpl-row:hover { background: var(--color-surface-hover); }
  .tpl-row.is-selected { border-color: var(--color-primary); box-shadow: inset 0 0 0 1px var(--color-primary); }
  .tpl-row:has(input:focus-visible) { outline: 2px solid var(--color-primary); outline-offset: 2px; }
  .tpl-icon { flex: none; display: grid; place-items: center; width: 38px; height: 38px; border-radius: 8px; color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
  .tpl-name { display: block; font-weight: 600; font-size: 0.92rem; }
  .tpl-desc { display: block; font-size: 0.8rem; color: var(--color-on-surface-variant); }
</style>
