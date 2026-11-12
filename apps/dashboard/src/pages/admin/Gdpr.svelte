<script lang="ts">
  import { toast } from '../../lib/stores/toast.svelte';
  import { fetchGdprPreview, downloadGdprExport, type GdprPreview } from '../../lib/api';
  import Papicon from '../../lib/components/Papicon.svelte';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import AdminCard from '../../lib/components/admin/AdminCard.svelte';
  import AdminStat from '../../lib/components/admin/AdminStat.svelte';
  import AdminBadge from '../../lib/components/admin/AdminBadge.svelte';
  import { Button, Callout, EmptyState, Field } from '../../lib/components/ui';
  import { m } from '../../lib/i18n';

  import { errorMessage } from '@kotbo/shared';
  let userId = $state('');
  let loading = $state(false);
  let downloading = $state(false);
  let preview = $state<GdprPreview | null>(null);
  let error = $state<string | null>(null);
  const expanded = $state<Record<string, boolean>>({});

  const canSearch = $derived(/^\d{5,25}$/.test(userId.trim()));

  async function runPreview() {
    if (!canSearch) {
      error = m.d7_gdpr_invalid_id();
      return;
    }
    loading = true;
    error = null;
    preview = null;
    try {
      preview = await fetchGdprPreview(userId.trim());
      if (preview.meta.totalRecords === 0) {
        toast.info(m.d7_gdpr_no_data_found());
      }
    } catch (err) {
      error = errorMessage(err) ?? m.d7_gdpr_collect_error();
    } finally {
      loading = false;
    }
  }

  async function download() {
    if (!preview) return;
    downloading = true;
    try {
      await downloadGdprExport(preview.meta.userId);
      toast.success(m.d7_gdpr_download_success());
    } catch (err) {
      toast.error(errorMessage(err) ?? m.d7_gdpr_download_error());
    } finally {
      downloading = false;
    }
  }

  function toggle(key: string) {
    expanded[key] = !expanded[key];
  }
</script>

<AdminShell title={m.d7_gdpr_export_title()} description={m.d7_gdpr_export_subtitle()}>
  <AdminCard>
    <form class="flex flex-col sm:flex-row sm:items-end gap-3" onsubmit={(e) => { e.preventDefault(); void runPreview(); }}>
      <Field label={m.d7_gdpr_user_id_label()} hint={m.d7_gdpr_collect_hint()} class="flex-1">
        {#snippet children(id, describedBy)}
          <input
            {id}
            aria-describedby={describedBy}
            bind:value={userId}
            placeholder={m.d7_gdpr_id_placeholder()}
            inputmode="numeric"
            class="input font-mono"
          />
        {/snippet}
      </Field>
      <!-- Aligné sur le champ, pas sur son texte d'aide. -->
      <div class="sm:pb-6">
        <Button type="submit" variant="primary" icon="Search" {loading}>
          {loading ? m.d7_gdpr_collecting() : m.d7_search()}
        </Button>
      </div>
    </form>
  </AdminCard>

  {#if error}
    <Callout variant="danger">{error}</Callout>
  {/if}

  {#if preview}
    <AdminCard>
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div class="flex items-center gap-3 min-w-0">
          {#if preview.identity.discordUser?.avatarURL}
            <img src={String(preview.identity.discordUser.avatarURL)} alt="" class="w-11 h-11 rounded-full shrink-0" />
          {:else}
            <div class="w-11 h-11 rounded-full bg-on-surface/6 flex items-center justify-center shrink-0 text-on-surface-variant">
              <Papicon icon="User" size={18} />
            </div>
          {/if}
          <div class="min-w-0">
            <p class="text-sm font-semibold text-on-surface truncate">
              {preview.meta.username ?? m.d7_gdpr_unknown_user()}
              {#if preview.meta.globalName}<span class="text-on-surface-variant font-normal"> · {preview.meta.globalName}</span>{/if}
            </p>
            <p class="text-xs text-on-surface-variant font-mono">{preview.meta.userId}</p>
          </div>
        </div>
        <Button variant="primary" icon="Download" loading={downloading} onclick={download}>
          {downloading ? m.d7_gdpr_generating() : m.d7_gdpr_download_zip()}
        </Button>
      </div>

      {#if preview.identity.guilds.length}
        <div class="mt-4 flex flex-wrap gap-1.5">
          {#each preview.identity.guilds as g (g.name)}
            <AdminBadge label={g.name} icon="Server" />
          {/each}
        </div>
      {/if}
    </AdminCard>

    <div class="grid grid-cols-3 gap-3">
      <AdminStat label={m.d7_gdpr_records()} value={preview.meta.totalRecords} icon="Database" tone="primary" />
      <AdminStat label={m.d7_gdpr_categories()} value={preview.categories.length} icon="Layers" tone="info" />
      <AdminStat label={m.d7_gdpr_servers()} value={preview.meta.guildCount} icon="Server" tone="neutral" />
    </div>

    {#if preview.meta.errors.length}
      <Callout variant="warning" title={m.d7_gdpr_collect_warnings({ count: preview.meta.errors.length })}>
        <ul class="list-disc list-inside space-y-0.5">
          {#each preview.meta.errors as e (e)}<li>{e}</li>{/each}
        </ul>
      </Callout>
    {/if}

    {#if preview.categories.length}
      <AdminCard padded={false}>
        <ul class="divide-y divide-outline-variant/20">
          {#each preview.categories as cat (cat.key)}
            <li>
              <button
                type="button"
                onclick={() => toggle(cat.key)}
                aria-expanded={Boolean(expanded[cat.key])}
                class="w-full flex items-center justify-between gap-3 px-5 py-3.5 hover:bg-on-surface/3 transition-colors text-left focus-visible:outline-2 focus-visible:outline-primary"
              >
                <div class="min-w-0">
                  <p class="text-body-sm font-semibold text-on-surface flex items-center gap-2">
                    {cat.label}
                    <AdminBadge size="sm" label={String(cat.count)} tone="primary" />
                  </p>
                  <p class="text-xs text-on-surface-variant truncate">{cat.description}</p>
                </div>
                <Papicon icon={expanded[cat.key] ? 'ChevronDown' : 'ChevronRight'} size={15} class="text-on-surface-variant shrink-0" />
              </button>
              {#if expanded[cat.key]}
                <dl class="px-5 pb-4 pt-1 space-y-1.5">
                  {#each cat.tables as t (t.label)}
                    <div class="flex items-center justify-between text-body-sm">
                      <dt class="text-on-surface-variant">{t.label}</dt>
                      <dd class="font-mono tabular-nums text-on-surface">{t.count}</dd>
                    </div>
                  {/each}
                </dl>
              {/if}
            </li>
          {/each}
        </ul>
      </AdminCard>
    {:else}
      <EmptyState icon="Inbox" title={m.d7_gdpr_no_data_retained()} reason="all-clear" />
    {/if}
  {/if}
</AdminShell>
