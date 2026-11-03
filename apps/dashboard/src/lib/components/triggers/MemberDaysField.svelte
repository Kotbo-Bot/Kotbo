<script lang="ts">
  import { m } from '../../i18n';
  import { MAX_MEMBER_DAYS } from '@kotbo/shared';

  /**
   * Seuil d'un déclencheur d'ancienneté ou d'inactivité, lu comme une phrase :
   * « au bout de 30 jours sur le serveur ».
   */
  const {
    triggerType,
    value,
    onChange,
  }: {
    triggerType: 'OnMemberTenure' | 'OnMemberInactive';
    value: unknown;
    onChange: (days: number) => void;
  } = $props();
</script>

<div class="space-y-1">
  <label class="flex flex-wrap items-center gap-2 text-xs text-on-surface">
    <span>{m.wf_member_days_prefix()}</span>
    <input
      type="number"
      min="1"
      max={MAX_MEMBER_DAYS}
      step="1"
      value={Number(value) || ''}
      oninput={(event) => onChange(Math.trunc(Number(event.currentTarget.value)))}
      class="w-20 px-2.5 py-1 rounded-lg bg-surface-container-highest border border-outline-variant/25 text-on-surface focus:outline-none focus:border-primary/60"
    />
    <span>{triggerType === 'OnMemberTenure' ? m.wf_member_days_tenure() : m.wf_member_days_inactive()}</span>
  </label>
  <p class="text-2xs text-on-surface-variant">
    {triggerType === 'OnMemberTenure' ? m.wf_member_days_tenure_hint() : m.wf_member_days_inactive_hint()}
  </p>
</div>
