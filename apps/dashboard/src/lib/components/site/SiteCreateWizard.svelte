<script lang="ts">
  /**
   * Création du site : une adresse, un type de communauté. Les pages sont
   * composées d'après les modules actifs du serveur ; tout se modifie ensuite.
   */
  import { resolveSiteTheme, slugify, validateSiteSlug } from '@kotbo/shared';
  import { Button, Field, SectionCard } from '../ui';
  import { toast } from '../../stores/toast.svelte';
  import { m } from '../../i18n';
  import { createSite, type SiteState, type SiteTemplate } from '../../api/site';
  import { siteErrorMessage } from './siteErrors';

  let { state, guildId, onCreated }: { state: SiteState; guildId: string; onCreated: () => void } = $props();

  const THEMES: Record<SiteTemplate, string> = { general: 'verre', gaming: 'neon', rp: 'royaume', esport: 'arcade', etude: 'documentation' };
  const TEMPLATES: Array<{ key: SiteTemplate; label: () => string; desc: () => string; icon: string }> = [
    { key: 'general', label: () => m.ste_tpl_general(), desc: () => m.ste_tpl_general_desc(), icon: '💬' },
    { key: 'gaming', label: () => m.ste_tpl_gaming(), desc: () => m.ste_tpl_gaming_desc(), icon: '🎮' },
    { key: 'rp', label: () => m.ste_tpl_rp(), desc: () => m.ste_tpl_rp_desc(), icon: '🏰' },
    { key: 'esport', label: () => m.ste_tpl_esport(), desc: () => m.ste_tpl_esport_desc(), icon: '🏆' },
    { key: 'etude', label: () => m.ste_tpl_etude(), desc: () => m.ste_tpl_etude_desc(), icon: '📚' },
  ];

  let slug = $state(state.suggestedSlug ?? '');
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
    <Field label={m.ste_create_address()} hint={`${state.baseUrl}${slug || '…'}`} error={slugError}>
      {#snippet children(id, describedBy)}
        <input {id} aria-describedby={describedBy} class="input w-full font-mono" maxlength="40" bind:value={slug} oninput={() => (slug = slug.toLowerCase().replace(/ +/g, '-'))} onblur={() => (slug = slugify(slug, 40))} />
      {/snippet}
    </Field>

    <fieldset class="space-y-3">
      <legend class="text-body-sm font-medium text-on-surface mb-1">{m.ste_create_type()}</legend>
      <div class="tpl-grid">
        {#each TEMPLATES as tpl (tpl.key)}
          {@const theme = resolveSiteTheme(THEMES[tpl.key], {})}
          <label class="tpl-card" class:is-selected={template === tpl.key}>
            <input class="sr-only" type="radio" name="template" value={tpl.key} bind:group={template} />
            <span class="tpl-preview" style="--bg:{theme.bg};--accent:{theme.accent};--text:{theme.text};--surface:{theme.surface};--radius:{Math.min(theme.radius, 14)}px">
              <span class="tpl-bar"></span>
              <span class="tpl-block"></span>
              <span class="tpl-block tpl-block-small"></span>
              <span class="tpl-dot"></span>
            </span>
            <span class="tpl-name">{tpl.icon} {tpl.label()}</span>
            <span class="tpl-desc">{tpl.desc()}</span>
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
  .tpl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; }
  .tpl-card { display: flex; flex-direction: column; gap: 6px; padding: 10px; border-radius: 14px; border: 1px solid rgb(255 255 255 / 0.08); background: rgb(255 255 255 / 0.02); cursor: pointer; transition: border-color 0.15s, background 0.15s; }
  .tpl-card:hover { border-color: rgb(255 255 255 / 0.18); }
  .tpl-card.is-selected { border-color: rgb(124 108 255 / 0.8); background: rgb(124 108 255 / 0.08); }
  .tpl-card:has(input:focus-visible) { outline: 2px solid rgb(124 108 255); outline-offset: 2px; }
  .tpl-preview { position: relative; display: block; height: 96px; border-radius: 10px; background: var(--bg); overflow: hidden; border: 1px solid rgb(255 255 255 / 0.06); }
  .tpl-bar { position: absolute; left: 8px; right: 8px; top: 8px; height: 12px; border-radius: 6px; background: var(--surface); }
  .tpl-block { position: absolute; left: 8px; top: 28px; width: 58%; height: 58px; border-radius: var(--radius); background: var(--surface); }
  .tpl-block-small { left: auto; right: 8px; width: 30%; }
  .tpl-dot { position: absolute; left: 16px; top: 40px; width: 36px; height: 8px; border-radius: 4px; background: var(--accent); }
  .tpl-name { font-weight: 600; font-size: 0.9rem; }
  .tpl-desc { font-size: 0.78rem; color: rgb(255 255 255 / 0.55); }
</style>
