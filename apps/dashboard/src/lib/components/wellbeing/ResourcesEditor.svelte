<!--
  Ressources d'aide tenues par la cellule : numéros, liens et descriptions,
  envoyés au membre en un clic depuis un dossier. Chaque ressource peut viser
  une langue ; sans langue, elle vaut pour tout le monde.
-->
<script lang="ts" module>
  export type WellbeingResource = { label: string; phone: string | null; url: string | null; description: string | null; locale: string | null };
</script>

<script lang="ts">
  import { dashboardFetch } from '../../api';
  import { dateLocale, m } from '../../i18n';
  import { toast } from '../../stores/toast.svelte';
  import Papicon from '../Papicon.svelte';
  import { Button, EmptyState } from '../ui';

  let { resources = $bindable([]) }: { resources?: WellbeingResource[] } = $props();

  /** Même plafond que le bot (MAX_RESOURCES). */
  const MAX_RESOURCES = 10;
  /** Langues proposées pour une ressource ; vide : pour tout le monde. */
  const RESOURCE_LOCALES = ['fr', 'en', 'de', 'es', 'it', 'pt'] as const;
  const languageName = (code: string) => {
    try { return new Intl.DisplayNames([dateLocale()], { type: 'language' }).of(code) ?? code; } catch { return code; }
  };
  const addResource = () => (resources = [...resources, { label: '', phone: null, url: null, description: null, locale: null }]);

  let saving = $state(false);
  async function save() {
    if (saving) return;
    saving = true;
    try {
      const res = await dashboardFetch('/wellbeing/resources', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resources }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      resources = data.resources ?? [];
      toast.success(m.toast_wb_resources_saved());
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_resources_save_failed());
    } finally {
      saving = false;
    }
  }
</script>

<section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-6 space-y-4">
  <div>
    <h3 class="text-base font-semibold flex items-center gap-2"><Papicon icon="heart" size={16} /> {m.wb_resources_title()}</h3>
    <p class="text-xs text-on-surface-variant mt-1">{m.wb_resources_desc()}</p>
  </div>
  {#if resources.length === 0}
    <EmptyState icon="heart" title={m.wb_resources_empty()} actionLabel={m.wb_resources_add()} onAction={addResource} />
  {:else}
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      {#each resources as resource, index (index)}
        <div class="rounded-xl bg-surface-container-high/20 border border-outline-variant/30 p-4 space-y-2">
          <div class="flex items-center gap-2">
            <input bind:value={resource.label} maxlength={80} class="input text-sm font-semibold flex-1" aria-label={m.wb_resources_label()} placeholder={m.wb_resources_label()} />
            <Button size="sm" variant="ghost" icon="trash" aria-label={m.wb_resources_remove({ name: resource.label })}
              onclick={() => (resources = resources.filter((_, i) => i !== index))} />
          </div>
          <input bind:value={resource.phone} maxlength={30} class="input text-sm w-full" aria-label={m.wb_resources_phone()} placeholder={m.wb_resources_phone()} />
          <input bind:value={resource.url} maxlength={300} type="url" class="input text-sm w-full" aria-label={m.wb_resources_url()} placeholder={m.wb_resources_url()} />
          <input bind:value={resource.description} maxlength={200} class="input text-sm w-full" aria-label={m.wb_resources_description()} placeholder={m.wb_resources_description()} />
          <select bind:value={() => resource.locale ?? '', (value) => (resource.locale = value || null)} class="input text-sm w-full" aria-label={m.wb_resources_locale()}>
            <option value="">{m.wb_resources_locale_all()}</option>
            {#each RESOURCE_LOCALES as code (code)}
              <option value={code}>{languageName(code)}</option>
            {/each}
          </select>
        </div>
      {/each}
    </div>
  {/if}
  <div class="flex flex-wrap justify-between gap-2 border-t border-outline-variant/30 pt-4">
    <Button variant="ghost" icon="plus" disabled={resources.length >= MAX_RESOURCES} onclick={addResource}>{m.wb_resources_add()}</Button>
    <Button variant="primary" loading={saving} onclick={() => void save()}>{m.wb_resources_save()}</Button>
  </div>
  <p class="text-2xs text-on-surface-variant">{m.wb_resources_locale_hint()}</p>
</section>
