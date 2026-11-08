<script lang="ts">
  import { m } from '../../i18n';
  /**
   * Shield : niveau d'alerte du serveur, de 5 (tout va bien) à 1 (catastrophe).
   *
   * Agit immédiatement, sans passer par l'enregistrement de la page : en
   * pleine alerte, on ne veut pas d'une étape de plus. `onSynced` reporte dans
   * la page les champs que le serveur a modifiés (captcha, verrous…).
   */
  import { authStore } from '../../stores/auth.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { setShieldLevel, publishShieldPanel, createShieldStatusChannel } from '../../api';
  import SectionCard from '../SectionCard.svelte';
  import Button from '../ui/Button.svelte';
  import Callout from '../ui/Callout.svelte';

  let {
    config,
    channels = [],
    onSynced,
  }: {
    config: Record<string, any>;
    channels?: { id: string; name: string }[];
    onSynced: (fresh: Record<string, any>) => void;
  } = $props();

  const LEVELS = [
    { level: 5, emoji: '🔵', name: m.shd_level5_name(), summary: m.shd_level5_summary(), tone: 'border-primary/40 bg-primary/5' },
    { level: 4, emoji: '🟢', name: m.shd_level4_name(), summary: m.shd_level4_summary(), tone: 'border-success/40 bg-success/5' },
    { level: 3, emoji: '🟡', name: m.shd_level3_name(), summary: m.shd_level3_summary(), tone: 'border-warning/40 bg-warning/5' },
    { level: 2, emoji: '🔴', name: m.shd_level2_name(), summary: m.shd_level2_summary(), tone: 'border-error/40 bg-error/5' },
    { level: 1, emoji: '⚪', name: m.shd_level1_name(), summary: m.shd_level1_summary(), tone: 'border-outline bg-surface-container-high' },
  ];

  let busy = $state(false);
  let warnings = $state<string[]>([]);
  let panelChannel = $state('');

  const current = $derived(Number(config.shieldLevel ?? 5));
  const hasCaptcha = $derived(Boolean(config.captchaChannelId && config.captchaUnverifiedRoleId));

  async function apply(level: number) {
    if (busy || level === current) return;
    if (level <= 2) {
      const ok = await confirmDialog.ask({
        title: m.shd_confirm_title({ level }),
        description: level === 1
          ? m.shd_confirm_level1()
          : hasCaptcha
            ? m.shd_confirm_hold()
            : m.shd_confirm_raid(),
        confirmLabel: `Shield ${level}`,
        variant: 'danger',
      });
      if (!ok) return;
    }
    busy = true;
    try {
      const res = await setShieldLevel(level, authStore.selectedGuildId);
      if (res) {
        warnings = res.warnings;
        onSynced(res.config);
        toast.success(res.warnings.length ? m.shc_level_applied_partial({ level }) : m.shc_level_applied({ level }));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.shc_change_failed());
    } finally {
      busy = false;
    }
  }

  async function publish(create: boolean) {
    if (busy) return;
    busy = true;
    try {
      const res = await publishShieldPanel(create ? { create: true } : { channelId: panelChannel }, authStore.selectedGuildId);
      if (res) {
        onSynced(res.config);
        toast.success(create ? m.shc_channel_created_published() : m.slp_published());
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.shc_publish_failed());
    } finally {
      busy = false;
    }
  }

  async function createStatus() {
    if (busy) return;
    busy = true;
    try {
      const res = await createShieldStatusChannel(authStore.selectedGuildId);
      if (res) {
        onSynced(res.config);
        toast.success(m.shc_status_channel_created());
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.common_create_failed());
    } finally {
      busy = false;
    }
  }
</script>

<SectionCard
  title="Shield"
  description={m.shd_desc()}
  icon="Siren"
>
  <div class="space-y-4">
    <div class="grid sm:grid-cols-5 gap-2">
      {#each LEVELS as item (item.level)}
        <button
          type="button"
          class="rounded-xl border px-3 py-3 text-left transition-colors disabled:cursor-default {item.level === current ? item.tone : 'border-outline-variant/30 hover:border-outline-variant'}"
          disabled={busy || item.level === current}
          aria-pressed={item.level === current}
          onclick={() => apply(item.level)}
        >
          <p class="text-body-sm font-semibold text-on-surface">{item.emoji} Shield {item.level}</p>
          <p class="text-xs font-medium text-on-surface">{item.name}</p>
          <p class="text-xs text-on-surface-variant mt-1 leading-relaxed">{item.summary}</p>
        </button>
      {/each}
    </div>

    {#if warnings.length > 0}
      <Callout variant="warning" title={m.shd_partial()}>
        <ul class="list-disc pl-4 space-y-0.5">
          {#each warnings as warning (warning)}<li>{warning}</li>{/each}
        </ul>
      </Callout>
    {/if}
    {#if !hasCaptcha}
      <Callout variant="info">{m.shd_no_captcha()}</Callout>
    {/if}

    <div class="grid sm:grid-cols-2 gap-3">
      <div class="rounded-xl border border-outline-variant/30 p-3 space-y-2">
        <p class="text-body-sm font-medium text-on-surface">{m.shd_panel()}</p>
        <p class="text-xs text-on-surface-variant">
          {config.shieldPanelChannelId ? m.shd_panel_published({ channel: channels.find((c) => c.id === config.shieldPanelChannelId)?.name ?? config.shieldPanelChannelId }) : m.shd_panel_desc()}
        </p>
        <div class="flex flex-wrap gap-2">
          <select
            bind:value={panelChannel}
            class="flex-1 min-w-0 rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-1.5 text-body-sm text-on-surface"
          >
            <option value="">{m.shd_pick_channel()}</option>
            {#each channels as channel (channel.id)}<option value={channel.id}>#{channel.name}</option>{/each}
          </select>
          <Button size="sm" variant="secondary" disabled={busy || !panelChannel} onclick={() => publish(false)}>{m.shd_publish()}</Button>
          <Button size="sm" variant="ghost" icon="Plus" disabled={busy} onclick={() => publish(true)}>{m.shd_create_channel()}</Button>
        </div>
      </div>
      <div class="rounded-xl border border-outline-variant/30 p-3 space-y-2">
        <p class="text-body-sm font-medium text-on-surface">{m.shd_status()}</p>
        <p class="text-xs text-on-surface-variant">
          {m.shd_status_desc()}
        </p>
        <Button size="sm" variant="secondary" icon="Volume2" disabled={busy || Boolean(config.shieldStatusChannelId)} onclick={createStatus}>
          {config.shieldStatusChannelId ? m.shd_status_active() : m.shd_status_create()}
        </Button>
      </div>
    </div>
  </div>
</SectionCard>
