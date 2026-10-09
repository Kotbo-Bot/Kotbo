<script lang="ts">
  /**
   * Bandeau « un agent modifie le site ».
   *
   * Surveille le verrou de l'agent MCP (toutes les 5 s, plus vite quand il est
   * actif) et le remonte à la page, qui passe alors en lecture seule. Propose
   * d'interrompre l'agent, puis, une fois interrompu, de l'autoriser de nouveau.
   */
  import { onDestroy, onMount } from 'svelte';
  import { Button } from '../ui';
  import { toast } from '../../stores/toast.svelte';
  import { m, dateLocale } from '../../i18n';
  import { allowSiteAgent, fetchSiteAgent, interruptSiteAgent, type SiteAgentStatus } from '../../api/site';
  import { siteErrorMessage } from './siteErrors';

  let {
    guildId,
    canManage = false,
    onChange,
  }: { guildId: string; canManage?: boolean; onChange?: (locked: boolean) => void } = $props();

  let agent = $state<SiteAgentStatus | null>(null);
  let busy = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  async function poll() {
    try {
      agent = (await fetchSiteAgent(guildId)).agent;
      onChange?.(agent.active);
    } catch {
      // Sans réponse, on garde le dernier état connu.
    }
    if (!stopped) timer = setTimeout(poll, agent?.active ? 3000 : 5000);
  }

  /** Relu tout de suite, par exemple après un refus 423 de l'API. */
  export function refresh() {
    if (timer) clearTimeout(timer);
    void poll();
  }

  onMount(poll);
  onDestroy(() => {
    stopped = true;
    if (timer) clearTimeout(timer);
  });

  async function interrupt() {
    busy = true;
    try {
      agent = (await interruptSiteAgent(guildId)).agent;
      onChange?.(false);
      toast.success(m.ste_agent_interrupted_toast());
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      busy = false;
    }
  }

  async function allow() {
    busy = true;
    try {
      agent = (await allowSiteAgent(guildId)).agent;
      toast.success(m.ste_agent_allowed_toast());
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      busy = false;
    }
  }

  const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString(dateLocale(), { timeStyle: 'short' }) : '');
</script>

{#if agent?.active}
  <div class="agent-banner agent-banner-active" role="status">
    <span class="agent-dot" aria-hidden="true"></span>
    <div class="min-w-0 flex-1">
      <p class="font-semibold">{m.ste_agent_active_title({ key: agent.keyName ?? 'MCP' })}</p>
      <p class="text-2xs opacity-80">{agent.activity ?? ''}{agent.activity ? ' · ' : ''}{m.ste_agent_active_since({ time: time(agent.startedAt) })}</p>
    </div>
    <Button variant="danger" size="sm" icon="x-circle" loading={busy} onclick={interrupt}>{m.ste_agent_interrupt()}</Button>
  </div>
{:else if agent?.interrupted}
  <div class="agent-banner" role="status">
    <span class="agent-dot agent-dot-off" aria-hidden="true"></span>
    <p class="min-w-0 flex-1 text-body-sm">{m.ste_agent_interrupted({ name: agent.interrupted.byName, time: time(agent.interrupted.until) })}</p>
    {#if canManage}<Button size="sm" loading={busy} onclick={allow}>{m.ste_agent_allow()}</Button>{/if}
  </div>
{/if}

<style>
  .agent-banner { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 12px; border: 1px solid rgb(255 255 255 / 0.1); background: rgb(255 255 255 / 0.04); margin-bottom: 12px; }
  .agent-banner-active { border-color: rgb(167 139 250 / 0.5); background: rgb(124 108 255 / 0.12); }
  .agent-dot { flex: none; width: 10px; height: 10px; border-radius: 50%; background: #a78bfa; box-shadow: 0 0 0 4px rgb(167 139 250 / 0.25); animation: agent-pulse 1.6s ease-in-out infinite; }
  .agent-dot-off { background: #9ca3af; box-shadow: none; animation: none; }
  @keyframes agent-pulse { 50% { box-shadow: 0 0 0 7px rgb(167 139 250 / 0.08); } }
  @media (prefers-reduced-motion: reduce) { .agent-dot { animation: none; } }
</style>
