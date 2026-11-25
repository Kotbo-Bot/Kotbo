<!--
  Transfert d'un ticket sensible à la cellule bien-être : il devient un dossier
  confidentiel (motif et description chiffrés), et le ticket peut être fermé.
  Le bouton n'apparaît qu'aux membres de la cellule.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import { dashboardFetch } from '../../api';
  import { m } from '../../i18n';
  import { toast } from '../../stores/toast.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import Papicon from '../Papicon.svelte';

  const { ticketId, ticketOpen, ontransferred }: { ticketId: string; ticketOpen: boolean; ontransferred: () => void } = $props();

  let isTeamMember = $state(false);
  let busy = $state(false);

  onMount(async () => {
    const res = await dashboardFetch('/wellbeing/status').catch(() => null);
    if (res?.ok) {
      const status = await res.json();
      isTeamMember = status.enabled === true && status.isTeamMember === true;
    }
  });

  async function transfer() {
    if (busy) return;
    if (!(await confirmDialog.ask({ title: m.tk_wb_transfer_q(), description: m.tk_wb_transfer_desc(), confirmLabel: m.tk_wb_transfer_confirm() }))) return;
    busy = true;
    try {
      const res = await dashboardFetch('/wellbeing/cases/from-ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketId, closeTicket: ticketOpen }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      toast.success(m.toast_tk_wb_transferred());
      ontransferred();
      router.goto(`/wellbeing?case=${encodeURIComponent(data.caseId)}`);
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_create_failed());
    } finally {
      busy = false;
    }
  }
</script>

{#if isTeamMember}
  <button type="button" onclick={() => void transfer()} disabled={busy}
    class="px-3 py-1.5 bg-primary/10 text-primary border border-primary/20 rounded-lg text-xs font-semibold hover:bg-primary hover:text-on-primary transition-all flex items-center gap-1.5 shrink-0 disabled:opacity-60">
    <Papicon icon="heart" size={12} /> {m.tk_wb_transfer()}
  </button>
{/if}
