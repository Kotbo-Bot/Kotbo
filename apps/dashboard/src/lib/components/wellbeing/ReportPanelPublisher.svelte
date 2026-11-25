<!--
  Message permanent de la cellule : posté dans un salon, il porte les boutons
  « Écrire à la cellule », « Écrire anonymement » et « Ressources d'aide ».
  Plus discret qu'une commande tapée sous les yeux des autres.
-->
<script lang="ts">
  import { dashboardFetch } from '../../api';
  import { m } from '../../i18n';
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

  async function publish() {
    if (!channelId || posting) return;
    posting = true;
    try {
      const res = await dashboardFetch('/wellbeing/report-panel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId }),
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
