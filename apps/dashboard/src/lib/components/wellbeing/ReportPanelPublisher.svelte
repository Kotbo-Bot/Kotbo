<!--
  Message permanent de la cellule : posté dans un salon, il porte les boutons
  « Écrire à la cellule », « Écrire anonymement » et « Ressources d'aide ».
  Plus discret qu'une commande tapée sous les yeux des autres. Le texte se
  choisit parmi des modèles, montrés tels que le bot les publiera.
-->
<script lang="ts">
  import { dashboardFetch } from '../../api';
  import { m } from '../../i18n';
  import { onMount } from 'svelte';
  import { toast } from '../../stores/toast.svelte';
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import { channelDisplayName } from '../../channelUtils';
  import Papicon from '../Papicon.svelte';
  import { Button, Callout } from '../ui';

  const { reportEnabled }: { reportEnabled: boolean } = $props();

  const channels = $derived(((dashboardStore.state.discordChannels ?? []) as Array<{ id: string; name: string; type?: string }>)
    .filter((channel) => channel.type === undefined || channel.type === 'text' || channel.type === 'announcement'));
  let channelId = $state('');
  let posting = $state(false);

  /** Modèles proposés par le bot, avec leur texte dans la langue du serveur ; le premier est celui par défaut. */
  let templates = $state<Array<{ id: string; text: string }>>([]);
  let template = $state('');
  const TEMPLATE_LABELS: Record<string, () => string> = {
    listening: () => m.wb_panel_template_listening(),
    short: () => m.wb_panel_template_short(),
    staff: () => m.wb_panel_template_staff(),
    anonymous: () => m.wb_panel_template_anonymous(),
  };
  const preview = $derived((templates.find((item) => item.id === template)?.text ?? '').replace(/\*\*/g, ''));

  onMount(async () => {
    if (!reportEnabled) return;
    const res = await dashboardFetch('/wellbeing/report-panel/templates').catch(() => null);
    if (!res?.ok) return;
    templates = (await res.json()).templates ?? [];
    template = templates[0]?.id ?? '';
  });

  async function publish() {
    if (!channelId || posting) return;
    posting = true;
    try {
      const res = await dashboardFetch('/wellbeing/report-panel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, template: template || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      toast.success(m.toast_wb_panel_posted());
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_update_failed());
    } finally {
      posting = false;
    }
  }
</script>

<section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-6 space-y-4">
  <div>
    <h3 class="text-base font-semibold flex items-center gap-2"><Papicon icon="MessageSquare" size={16} /> {m.wb_panel_title()}</h3>
    <p class="text-xs text-on-surface-variant mt-1">{m.wb_panel_desc()}</p>
  </div>
  {#if !reportEnabled}
    <Callout variant="info">{m.wb_panel_reports_off()}</Callout>
  {:else}
    {#if templates.length > 0}
      <div class="space-y-2">
        <p class="text-xs font-medium text-on-surface-variant">{m.wb_panel_template()}</p>
        <div role="group" aria-label={m.wb_panel_template()} class="flex flex-wrap gap-1.5">
          {#each templates as item (item.id)}
            <button type="button" aria-pressed={template === item.id} onclick={() => (template = item.id)}
              class="text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors {template === item.id ? 'bg-primary/10 text-primary border border-primary/30' : 'border border-outline-variant/40 text-on-surface-variant hover:bg-surface-container-high/40'}">
              {TEMPLATE_LABELS[item.id]?.() ?? item.id}
            </button>
          {/each}
        </div>
        <p class="text-sm text-on-surface whitespace-pre-line rounded-lg bg-surface-container-high/30 border border-outline-variant/30 px-3 py-2.5">{preview}</p>
        <p class="text-2xs text-on-surface-variant">{m.wb_panel_preview()}</p>
      </div>
    {/if}
    <div class="flex flex-wrap items-end gap-2">
      <label class="flex-1 min-w-48 space-y-1">
        <span class="text-xs font-medium text-on-surface-variant">{m.wb_panel_channel()}</span>
        <select bind:value={channelId} class="input w-full">
          <option value="">{m.wb_panel_channel_ph()}</option>
          {#each channels as channel (channel.id)}
            <option value={channel.id}>{channelDisplayName(channel)}</option>
          {/each}
        </select>
      </label>
      <Button variant="primary" icon="Send" loading={posting} disabled={!channelId} onclick={() => void publish()}>{m.wb_panel_publish()}</Button>
    </div>
  {/if}
</section>
