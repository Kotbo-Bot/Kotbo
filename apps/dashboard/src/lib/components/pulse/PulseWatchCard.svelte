<!--
  Alerte de chute de la note : crée une règle d'alerte d'Analytics sur la
  mesure « note Pulse » (baisse en % face à la semaine d'avant). Les règles se
  gèrent ensuite dans Analytics > Alertes, comme toutes les autres.
-->
<script lang="ts">
  import { Button, FilterPills, SectionCard } from '../ui';
  import RecipientsField from '../analytics/RecipientsField.svelte';
  import { createAlertRule, fetchAlertRules, type AlertRule } from '../../api';
  import { authStore } from '../../stores/auth.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { m } from '../../i18n';

  const THRESHOLDS = ['10', '15', '25'] as const;

  let rules = $state<AlertRule[]>([]);
  let threshold = $state<(typeof THRESHOLDS)[number]>('15');
  let notifyChannelId = $state<string | null>(null);
  let notifyUserIds = $state<string[]>([]);
  let saving = $state(false);

  const hasRecipient = $derived(Boolean(notifyChannelId) || notifyUserIds.length > 0);

  $effect(() => {
    authStore.selectedGuildId;
    fetchAlertRules()
      .then((res) => (rules = res.rules.filter((r) => r.metric === 'pulseScore')))
      .catch(() => (rules = []));
  });

  async function create() {
    if (!hasRecipient || saving) return;
    saving = true;
    try {
      const rule = await createAlertRule({
        name: m.pulse_watch_rule_name(),
        metric: 'pulseScore',
        condition: 'drop_pct',
        threshold: Number(threshold),
        window: 'day',
        channelId: null,
        notifyChannelId,
        notifyUserIds,
        enabled: true,
        cooldownHours: 24,
      });
      rules = [...rules, rule];
      toast.success(m.pulse_watch_created());
    } catch {
      toast.error(m.pulse_watch_error());
    } finally {
      saving = false;
    }
  }
</script>

<SectionCard title={m.pulse_watch_title()} description={m.pulse_watch_desc()} icon="bell">
  {#snippet actions()}
    <Button variant="ghost" size="sm" href="/analytics/alerts" iconRight="arrow-right">{m.pulse_watch_manage()}</Button>
  {/snippet}
  <div class="flex flex-col gap-4">
    {#if rules.length > 0}
      <ul class="flex flex-col gap-1.5">
        {#each rules as rule (rule.id)}
          <li class="flex items-center gap-2 text-body-sm text-on-surface">
            <span class="w-1.5 h-1.5 rounded-full shrink-0 {rule.enabled ? 'bg-success' : 'bg-on-surface-variant'}" aria-hidden="true"></span>
            {m.pulse_watch_rule({ threshold: rule.threshold })}
            {#if !rule.enabled}<span class="text-on-surface-variant">· {m.pulse_watch_paused()}</span>{/if}
          </li>
        {/each}
      </ul>
    {/if}
    <div class="flex flex-col gap-1.5">
      <span class="text-body-sm font-medium text-on-surface">{m.pulse_watch_drop()}</span>
      <FilterPills
        label={m.pulse_watch_drop()}
        options={THRESHOLDS.map((t) => ({ value: t, label: `${t} %` }))}
        value={threshold}
        onchange={(v) => (threshold = v)}
      />
    </div>
    <RecipientsField idPrefix="pulse-watch" bind:channelId={notifyChannelId} bind:userIds={notifyUserIds} />
    <div>
      <Button variant="primary" icon="bell" loading={saving} disabled={!hasRecipient} disabledReason={m.pulse_watch_need_recipient()} onclick={create}>
        {m.pulse_watch_create()}
      </Button>
    </div>
  </div>
</SectionCard>
