<script lang="ts">
  /**
   * Site automatique : annonces Discord recopiées dans le blog, pages des
   * modules créées à leur activation, résumé de la semaine.
   */
  import { untrack } from 'svelte';
  import { normalizeSiteAuto, type SiteAutoSettings } from '@kotbo/shared';
  import { Button, Field, SectionCard, ToggleSwitch } from '../ui';
  import { toast } from '../../stores/toast.svelte';
  import { m } from '../../i18n';
  import { publishWeeklySummaryNow, syncModulePagesNow, updateSite, type SiteCatalog, type SiteState } from '../../api/site';
  import { siteErrorMessage } from './siteErrors';

  let { siteState, catalog, guildId, onChanged }: { siteState: SiteState; catalog: SiteCatalog | null; guildId: string; onChanged: () => void } = $props();

  let auto = $state<SiteAutoSettings>(normalizeSiteAuto(untrack(() => siteState.site?.settings?.auto)));
  let saving = $state(false);
  let running = $state<'weekly' | 'modules' | null>(null);

  const channels = $derived(catalog?.channels ?? []);
  const WEEKDAYS = $derived([m.ste_auto_day_0(), m.ste_auto_day_1(), m.ste_auto_day_2(), m.ste_auto_day_3(), m.ste_auto_day_4(), m.ste_auto_day_5(), m.ste_auto_day_6()]);

  function toggleChannel(id: string) {
    const list = auto.announcements.channelIds;
    auto.announcements.channelIds = list.includes(id) ? list.filter((c) => c !== id) : [...list, id];
  }

  async function save() {
    saving = true;
    try {
      await updateSite({ settings: { auto: normalizeSiteAuto($state.snapshot(auto)) } }, guildId);
      toast.success(m.ste_settings_saved());
      onChanged();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      saving = false;
    }
  }

  async function runWeekly() {
    running = 'weekly';
    try {
      await publishWeeklySummaryNow(guildId);
      toast.success(m.ste_auto_weekly_done());
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      running = null;
    }
  }

  async function runModules() {
    running = 'modules';
    try {
      const { created } = await syncModulePagesNow(guildId);
      toast.success(created > 0 ? m.ste_auto_modules_done({ count: created }) : m.ste_auto_modules_none());
      if (created > 0) onChanged();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      running = null;
    }
  }
</script>

<SectionCard title={m.ste_auto_title()} description={m.ste_auto_desc()} icon="refresh-cw">
  <div class="px-5 pb-5 space-y-5">
    <div class="space-y-3">
      <div class="flex items-center justify-between gap-3">
        <div>
          <p class="text-body-sm font-medium text-on-surface">{m.ste_auto_announce()}</p>
          <p class="text-body-sm text-on-surface-variant">{m.ste_auto_announce_desc()}</p>
        </div>
        <ToggleSwitch checked={auto.announcements.enabled} ariaLabel={m.ste_auto_announce()} onToggle={(v) => (auto.announcements.enabled = v)} />
      </div>
      {#if auto.announcements.enabled}
        <div class="channel-grid">
          {#each channels as channel (channel.id)}
            <label class="flex items-center gap-2 text-body-sm">
              <input type="checkbox" checked={auto.announcements.channelIds.includes(channel.id)} onchange={() => toggleChannel(channel.id)} />
              <span>#{channel.name}</span>
            </label>
          {/each}
        </div>
        <div class="grid gap-3 md:grid-cols-2">
          <Field label={m.ste_auto_tag()}>
            {#snippet children(id)}
              <input {id} class="input w-full" maxlength="30" bind:value={auto.announcements.tag} />
            {/snippet}
          </Field>
          <Field label={m.ste_auto_min_length()} hint={m.ste_auto_min_length_hint()}>
            {#snippet children(id, describedBy)}
              <input {id} aria-describedby={describedBy} class="input w-full" type="number" min="0" max="2000" bind:value={auto.announcements.minLength} />
            {/snippet}
          </Field>
        </div>
      {/if}
    </div>

    <div class="flex items-center justify-between gap-3">
      <div>
        <p class="text-body-sm font-medium text-on-surface">{m.ste_auto_modules()}</p>
        <p class="text-body-sm text-on-surface-variant">{m.ste_auto_modules_desc()}</p>
      </div>
      <div class="flex items-center gap-2">
        {#if auto.modulePages.enabled}
          <Button size="sm" variant="ghost" loading={running === 'modules'} onclick={runModules}>{m.ste_auto_modules_run()}</Button>
        {/if}
        <ToggleSwitch checked={auto.modulePages.enabled} ariaLabel={m.ste_auto_modules()} onToggle={(v) => (auto.modulePages.enabled = v)} />
      </div>
    </div>

    <div class="space-y-3">
      <div class="flex items-center justify-between gap-3">
        <div>
          <p class="text-body-sm font-medium text-on-surface">{m.ste_auto_weekly()}</p>
          <p class="text-body-sm text-on-surface-variant">{m.ste_auto_weekly_desc()}</p>
        </div>
        <ToggleSwitch checked={auto.weeklySummary.enabled} ariaLabel={m.ste_auto_weekly()} onToggle={(v) => (auto.weeklySummary.enabled = v)} />
      </div>
      {#if auto.weeklySummary.enabled}
        <div class="grid gap-3 md:grid-cols-3 items-end">
          <Field label={m.ste_auto_weekday()}>
            {#snippet children(id)}
              <select {id} class="input w-full" bind:value={auto.weeklySummary.weekday}>
                {#each WEEKDAYS as label, day (day)}<option value={day}>{label}</option>{/each}
              </select>
            {/snippet}
          </Field>
          <Field label={m.ste_auto_hour()}>
            {#snippet children(id)}
              <select {id} class="input w-full" bind:value={auto.weeklySummary.hour}>
                {#each Array.from({ length: 24 }, (_, h) => h) as hour (hour)}<option value={hour}>{String(hour).padStart(2, '0')} h</option>{/each}
              </select>
            {/snippet}
          </Field>
          <Button size="sm" variant="ghost" loading={running === 'weekly'} onclick={runWeekly}>{m.ste_auto_weekly_run()}</Button>
        </div>
      {/if}
    </div>

    <div class="flex justify-end">
      <Button variant="primary" loading={saving} onclick={save}>{m.common_save()}</Button>
    </div>
  </div>
</SectionCard>

<style>
  .channel-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 4px 12px; max-height: 180px; overflow: auto; }
</style>
