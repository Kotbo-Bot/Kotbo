<!--
  Liste noire d'ouverture de tickets : qui ne peut plus en ouvrir, jusqu'à
  quand, et pourquoi. Onglet autonome de la page Tickets.
-->
<script lang="ts">
  import { m, dateLocale } from '../../i18n';
  import { authStore } from '../../stores/auth.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { createAsyncActionState } from '../../asyncAction.svelte';
  import { dashboardFetch } from '../../api';
  import { errorMessage } from '@kotbo/shared';
  import Papicon from '../Papicon.svelte';
  import FormInput from '../FormInput.svelte';

  /** Incrémenté par la page (bouton Actualiser) pour relire la liste. */
  const { refreshToken = 0 }: { refreshToken?: number } = $props();

  // ─── Blacklist d'ouverture de tickets ──────────────────────────────────────
  type TicketBlacklistEntry = {
    id: string;
    userId: string;
    username: string | null;
    avatarUrl: string | null;
    reason: string | null;
    addedByTag: string | null;
    expiresAt: string | null;
    allowReopen: boolean;
    createdAt: string;
  };

  let blacklistEntries = $state<TicketBlacklistEntry[]>([]);
  let blacklistLoading = $state(false);
  let blacklistUserId = $state('');
  let blacklistReason = $state('');
  let blacklistDurationDays = $state('');
  let blacklistAllowReopen = $state(false);
  const blacklistAddAction = createAsyncActionState();

  async function loadBlacklist() {
    if (!authStore.selectedGuildId) return;
    blacklistLoading = true;
    try {
      const res = await dashboardFetch(`/tickets/blacklist`);
      if (!res.ok) throw new Error(m.e1_tickets_bl_err_load());
      const data = await res.json();
      blacklistEntries = data.entries || [];
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      blacklistLoading = false;
    }
  }

  async function addToBlacklist() {
    const userId = blacklistUserId.trim();
    if (!/^\d{15,25}$/.test(userId)) {
      toast.error(m.e1_tickets_bl_err_invalid_id());
      return;
    }

    await blacklistAddAction.run(async () => {
      const res = await dashboardFetch(`/tickets/blacklist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          reason: blacklistReason.trim() || null,
          durationDays: blacklistDurationDays.trim() ? Number(blacklistDurationDays) : null,
          allowReopen: blacklistAllowReopen
        })
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || m.e1_tickets_bl_err_add());
      blacklistUserId = '';
      blacklistReason = '';
      blacklistDurationDays = '';
      blacklistAllowReopen = false;
      await loadBlacklist();
      return true;
    }, { successMessage: m.e1_tickets_bl_added() });
  }

  async function removeFromBlacklist(entry: TicketBlacklistEntry) {
    if (!(await confirmDialog.ask({
      title: m.e1_tickets_bl_remove_title(),
      description: m.e1_tickets_bl_remove_desc({ name: entry.username || entry.userId }),
      confirmLabel: m.e1_tickets_bl_remove_confirm(),
    }))) return;

    try {
      const res = await dashboardFetch(`/tickets/blacklist/${entry.userId}`, {
        method: 'DELETE'
        });
      if (!res.ok) throw new Error(m.e1_tickets_bl_err_remove());
      await loadBlacklist();
      toast.success(m.e1_tickets_bl_removed());
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  $effect(() => {
    void refreshToken;
    void loadBlacklist();
  });
</script>

<div class="max-w-4xl mx-auto space-y-4">
  <div class="pb-2">
    <h3 class="text-lg font-semibold text-on-surface">{m.e1_tickets_bl_title()}</h3>
    <p class="text-on-surface-variant text-xs mt-0.5">{m.e1_tickets_bl_desc()}</p>
  </div>

  <!-- Ajout d'une interdiction -->
  <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 p-4 lg:p-5 space-y-4">
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <label class="block">
        <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_bl_user_id()}</span>
        <FormInput type="text" bind:value={blacklistUserId} placeholder="123456789012345678" className="w-full" />
      </label>
      <label class="block">
        <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_bl_duration()}</span>
        <FormInput type="text" bind:value={blacklistDurationDays} placeholder={m.e1_tickets_bl_duration_ph()} className="w-full" />
      </label>
      <label class="block">
        <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_bl_reason()}</span>
        <FormInput type="text" bind:value={blacklistReason} placeholder={m.e1_tickets_bl_reason_ph()} className="w-full" />
      </label>
    </div>
    <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
      <input type="checkbox" bind:checked={blacklistAllowReopen} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
      <div>
        <span class="text-xs font-bold text-on-surface">{m.e1_tickets_bl_allow_reopen()}</span>
        <p class="text-2xs text-on-surface-variant/60">{m.e1_tickets_bl_allow_reopen_desc()}</p>
      </div>
    </label>
    <div class="flex justify-end">
      <button
        onclick={addToBlacklist}
        disabled={blacklistAddAction.state.loading || !blacklistUserId.trim()}
        class="px-4 py-2.5 bg-primary text-white rounded-xl text-xs font-semibold active:scale-[0.98] transition-transform disabled:opacity-50 flex items-center gap-2"
      >
        <Papicon icon="user-minus" size={13} />
        {blacklistAddAction.state.loading ? m.e1_tickets_bl_adding() : m.e1_tickets_bl_add()}
      </button>
    </div>
  </div>

  <!-- Liste des interdictions en vigueur -->
  <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 overflow-hidden">
    {#if blacklistLoading}
      <div class="p-8 text-center text-xs text-on-surface-variant/50">{m.e1_tickets_bl_loading()}</div>
    {:else if blacklistEntries.length === 0}
      <div class="flex flex-col items-center justify-center py-16 text-on-surface-variant/30">
        <Papicon icon="shield" size={36} class="opacity-50 mb-2" />
        <p class="text-xs font-bold">{m.e1_tickets_bl_empty()}</p>
      </div>
    {:else}
      <div class="divide-y divide-outline-variant/10">
        {#each blacklistEntries as entry (entry.id)}
          <div class="flex items-center gap-3 p-3.5">
            {#if entry.avatarUrl}
              <img src={entry.avatarUrl} alt={entry.username || entry.userId} class="w-9 h-9 rounded-xl object-cover shrink-0" />
            {:else}
              <div class="w-9 h-9 rounded-xl bg-surface-container flex items-center justify-center text-primary font-semibold text-sm shrink-0">
                {(entry.username || '?').charAt(0).toUpperCase()}
              </div>
            {/if}
            <div class="min-w-0 flex-1">
              <p class="text-sm font-semibold text-on-surface truncate">@{entry.username || entry.userId}</p>
              <p class="text-2xs text-on-surface-variant/60 truncate">
                {entry.reason || m.e1_tickets_bl_no_reason()}
              </p>
              <p class="text-2xs text-on-surface-variant/40 mt-0.5">
                {entry.expiresAt
                  ? m.e1_tickets_bl_until({ date: new Date(entry.expiresAt).toLocaleString(dateLocale()) })
                  : m.e1_tickets_bl_permanent()}
                {#if entry.addedByTag} · {m.e1_tickets_bl_added_by({ name: entry.addedByTag })}{/if}
              </p>
              {#if entry.allowReopen}
                <span class="inline-block mt-1 px-2 py-0.5 rounded-full text-2xs font-semibold uppercase bg-sky-500/10 text-sky-400 border border-sky-500/20">
                  {m.e1_tickets_bl_reopen_allowed()}
                </span>
              {/if}
            </div>
            <button
              onclick={() => removeFromBlacklist(entry)}
              class="p-2 rounded-lg bg-error/10 text-error hover:bg-rose-500 hover:text-white border border-error/15 transition-all shrink-0"
              title={m.e1_tickets_bl_remove_confirm()}
            >
              <Papicon icon="trash-2" size={14} />
            </button>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
