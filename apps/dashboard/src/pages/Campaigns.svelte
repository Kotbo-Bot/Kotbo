<script lang="ts">
  import { m } from '../lib/i18n';
  /**
   * Campagnes marketing : une suite de messages programmes, adressee a une
   * audience choisie, dont on mesure la portee.
   *
   * L'editeur suit l'ordre des decisions : ce qu'on dit (les etapes), a qui
   * (l'audience), et comment on saura si ca a marche (le code d'invitation).
   */
  import { onMount } from 'svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import {
    fetchCampaigns,
    createCampaign,
    updateCampaign,
    deleteCampaign,
    setCampaignStatus,
    fetchCampaignReport,
    previewCampaignAudience,
  } from '../lib/api';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import SectionCard from '../lib/components/SectionCard.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import ActionButton from '../lib/components/ActionButton.svelte';
  import LoadingHint from '../lib/components/LoadingHint.svelte';
  import Modal from '../lib/components/Modal.svelte';
  import FormInput from '../lib/components/FormInput.svelte';
  import FormTextarea from '../lib/components/FormTextarea.svelte';
  import FormSelect from '../lib/components/FormSelect.svelte';
  import MultiSelect from '../lib/components/MultiSelect.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import { dateLocale } from '../lib/i18n';

  import { errorMessage } from '@kotbo/shared';
  type Step = {
    id?: string;
    offsetMinutes: number;
    delivery: 'CHANNEL' | 'DM';
    channelId: string | null;
    content: string;
    embed: { title?: string; description?: string; color?: string; imageUrl?: string } | null;
    status?: string;
    sentAt?: string | null;
    recipientCount?: number;
    deliveredCount?: number;
    failedCount?: number;
    reactionCount?: number;
    lastError?: string | null;
  };

  type Campaign = {
    id: string;
    name: string;
    description: string | null;
    status: 'DRAFT' | 'SCHEDULED' | 'RUNNING' | 'COMPLETED' | 'CANCELLED';
    startAt: string | null;
    audienceRoleIds: string[];
    audienceExcludeRoleIds: string[];
    audienceMinLevel: number | null;
    audienceMinTenureDays: number | null;
    audienceInactiveDays: number | null;
    targetGuildIds: string[];
    inviteCode: string | null;
    steps: Step[];
  };

  const STATUS_META: Record<string, { label: string; text: string; bg: string }> = {
    DRAFT: { label: m.camp_status_draft(), text: 'text-on-surface-variant', bg: 'bg-surface-container' },
    SCHEDULED: { label: m.camp_status_scheduled(), text: 'text-sky-500', bg: 'bg-sky-500/10' },
    RUNNING: { label: m.camp_status_running(), text: 'text-success', bg: 'bg-success/10' },
    COMPLETED: { label: m.camp_status_completed(), text: 'text-on-surface-variant', bg: 'bg-surface-container' },
    CANCELLED: { label: m.camp_status_cancelled(), text: 'text-error', bg: 'bg-error/10' },
  };

  let campaigns = $state<Campaign[]>([]);
  let loading = $state(true);
  let reports = $state<Record<string, { recipients: number; delivered: number; failed: number; reactions: number; joins: number }>>({});

  let modalOpen = $state(false);
  let saving = $state(false);
  let editingId = $state<string | null>(null);
  let form = $state(emptyForm());
  let audiencePreview = $state<{ count: number; sample: { id: string; name: string }[] } | null>(null);
  let previewing = $state(false);

  const discordRoles = $derived(dashboardStore.state.discordRoles || []);
  const discordChannels = $derived(dashboardStore.state.discordChannels || []);

  function emptyForm() {
    return {
      name: '',
      description: '',
      startAt: '',
      audienceRoleIds: [] as string[],
      audienceExcludeRoleIds: [] as string[],
      audienceMinLevel: '',
      audienceMinTenureDays: '',
      audienceInactiveDays: '',
      targetGuildIds: [] as string[],
      inviteCode: '',
      steps: [emptyStep()] as Step[],
    };
  }

  function emptyStep(): Step {
    return { offsetMinutes: 0, delivery: 'CHANNEL', channelId: null, content: '', embed: null };
  }

  /** Rend lisible un décalage exprimé en minutes. */
  function offsetLabel(minutes: number): string {
    if (minutes === 0) return m.camp_day_zero();
    const abs = Math.abs(minutes);
    const unit = abs >= 1440 ? m.camp_unit_days({ count: Math.round(abs / 1440) }) : abs >= 60 ? m.camp_unit_hours({ count: Math.round(abs / 60) }) : m.camp_unit_minutes({ count: abs });
    return minutes < 0 ? m.camp_offset_before({ unit }) : m.camp_offset_after({ unit });
  }

  const stepsSent = (c: Campaign) => c.steps.filter((s) => s.status === 'SENT').length;

  async function load() {
    if (!authStore.selectedGuildId) return;
    loading = true;
    try {
      const data = await fetchCampaigns();
      campaigns = data?.campaigns ?? [];
      // Les indicateurs ne concernent que ce qui est parti : les charger pour
      // un brouillon reviendrait a afficher des zéros sans signification.
      await Promise.all(
        campaigns
          .filter((c) => c.status === 'RUNNING' || c.status === 'COMPLETED')
          .map(async (c) => {
            const res = await fetchCampaignReport(c.id).catch(() => null);
            if (res?.report) reports = { ...reports, [c.id]: res.report };
          }),
      );
    } catch (err) {
      toast.error(errorMessage(err) || m.camp_load_failed());
    } finally {
      loading = false;
    }
  }

  function openNew() {
    editingId = null;
    form = emptyForm();
    audiencePreview = null;
    modalOpen = true;
  }

  function openEdit(campaign: Campaign) {
    editingId = campaign.id;
    form = {
      name: campaign.name,
      description: campaign.description ?? '',
      // `datetime-local` n'accepte ni le fuseau ni les secondes.
      startAt: campaign.startAt ? campaign.startAt.slice(0, 16) : '',
      audienceRoleIds: [...campaign.audienceRoleIds],
      audienceExcludeRoleIds: [...campaign.audienceExcludeRoleIds],
      audienceMinLevel: campaign.audienceMinLevel?.toString() ?? '',
      audienceMinTenureDays: campaign.audienceMinTenureDays?.toString() ?? '',
      audienceInactiveDays: campaign.audienceInactiveDays?.toString() ?? '',
      targetGuildIds: [...campaign.targetGuildIds],
      inviteCode: campaign.inviteCode ?? '',
      steps: campaign.steps.map((s) => ({ ...s })),
    };
    audiencePreview = null;
    modalOpen = true;
  }

  function payload() {
    return {
      name: form.name,
      description: form.description,
      startAt: form.startAt ? new Date(form.startAt).toISOString() : null,
      audienceRoleIds: form.audienceRoleIds,
      audienceExcludeRoleIds: form.audienceExcludeRoleIds,
      audienceMinLevel: form.audienceMinLevel,
      audienceMinTenureDays: form.audienceMinTenureDays,
      audienceInactiveDays: form.audienceInactiveDays,
      targetGuildIds: form.targetGuildIds,
      inviteCode: form.inviteCode,
      steps: form.steps,
    };
  }

  async function save() {
    if (saving) return;
    if (!form.name.trim()) {
      toast.error(m.camp_name_required());
      return;
    }

    saving = true;
    try {
      if (editingId) await updateCampaign(editingId, payload());
      else await createCampaign(payload());
      toast.success(editingId ? m.camp_updated() : m.camp_created());
      modalOpen = false;
      await load();
    } catch (err) {
      toast.error(errorMessage(err) || m.tmac_err_save());
    } finally {
      saving = false;
    }
  }

  async function preview() {
    if (previewing) return;
    previewing = true;
    try {
      audiencePreview = await previewCampaignAudience({
        audienceRoleIds: form.audienceRoleIds,
        audienceExcludeRoleIds: form.audienceExcludeRoleIds,
        audienceMinLevel: form.audienceMinLevel,
        audienceMinTenureDays: form.audienceMinTenureDays,
        audienceInactiveDays: form.audienceInactiveDays,
      });
    } catch (err) {
      toast.error(errorMessage(err) || m.camp_audience_failed());
    } finally {
      previewing = false;
    }
  }

  async function changeStatus(campaign: Campaign, status: string) {
    if (status === 'SCHEDULED') {
      const dmSteps = campaign.steps.filter((s) => s.delivery === 'DM').length;
      const confirmed = await confirmDialog.ask({
        title: m.camp_launch_confirm_title({ name: campaign.name }),
        description: dmSteps > 0
          ? m.camp_launch_confirm_dm({ count: campaign.steps.length, dm: dmSteps })
          : m.camp_launch_confirm({ count: campaign.steps.length }),
        confirmLabel: m.camp_launch(),
        variant: 'warning',
      });
      if (!confirmed) return;
    }

    try {
      await setCampaignStatus(campaign.id, status);
      await load();
      toast.success(m.camp_status_updated());
    } catch (err) {
      toast.error(errorMessage(err) || m.camp_status_failed());
    }
  }

  async function remove(campaign: Campaign) {
    const confirmed = await confirmDialog.ask({
      title: m.camp_delete_confirm_title({ name: campaign.name }),
      description: m.camp_delete_confirm_desc(),
      confirmLabel: m.common_delete(),
      variant: 'danger',
    });
    if (!confirmed) return;

    try {
      await deleteCampaign(campaign.id);
      toast.success(m.camp_deleted());
      await load();
    } catch (err) {
      toast.error(errorMessage(err) || m.tmac_err_delete());
    }
  }

  onMount(load);

  $effect(() => {
    const guildId = authStore.selectedGuildId;
    if (guildId) void load();
  });
</script>

<ModulePage
  title={m.camp_title()}
  description={m.camp_desc()}
  icon="megaphone"
  featureKey="campaigns"
>
  {#snippet actions()}
    <ActionButton variant="primary" size="sm" icon="plus" label={m.camp_new()} onclick={openNew} />
    <RefreshButton onclick={load} loading={loading} />
  {/snippet}

  {#if loading && campaigns.length === 0}
    <LoadingHint context="config" />
  {:else if campaigns.length === 0}
    <EmptyState
      icon="megaphone"
      title={m.camp_empty_title()}
      description={m.camp_empty_desc()}
      actionLabel={m.camp_empty_action()}
      onAction={openNew}
    />
  {:else}
    <div class="grid grid-cols-1 xl:grid-cols-2 gap-3 items-start">
      {#each campaigns as campaign (campaign.id)}
        {@const meta = STATUS_META[campaign.status]}
        {@const report = reports[campaign.id]}
        <SectionCard title={campaign.name} description={campaign.description || undefined}>
          {#snippet actions()}
            <span class="text-2xs px-2 py-0.5 rounded-full font-semibold {meta.bg} {meta.text}">{meta.label}</span>
          {/snippet}

          <div class="space-y-3">
            <div class="flex flex-wrap items-center gap-3 text-xs text-on-surface-variant">
              <span class="inline-flex items-center gap-1.5">
                <Papicon icon="layers" size={13} />
                {m.camp_steps_sent({ sent: stepsSent(campaign), total: campaign.steps.length })}
              </span>
              {#if campaign.startAt}
                <span class="inline-flex items-center gap-1.5">
                  <Papicon icon="calendar" size={13} />
                  {new Date(campaign.startAt).toLocaleString(dateLocale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </span>
              {/if}
              {#if campaign.targetGuildIds.length > 0}
                <span class="inline-flex items-center gap-1.5">
                  <Papicon icon="share" size={13} />
                  {m.camp_extra_servers({ count: campaign.targetGuildIds.length })}
                </span>
              {/if}
            </div>

            <!-- Frise des étapes : l'ordre d'envoi se lit d'un coup d'œil. -->
            <div class="space-y-1.5">
              {#each campaign.steps as step, i (step.id ?? i)}
                <div class="flex items-center gap-2.5 rounded-lg border border-outline-variant/20 bg-surface-container-low/40 px-3 py-2">
                  <span class="text-2xs font-semibold tabular-nums text-on-surface-variant w-14 shrink-0">
                    {offsetLabel(step.offsetMinutes)}
                  </span>
                  <Papicon icon={step.delivery === 'DM' ? 'mail' : 'hash'} size={13} class="text-on-surface-variant shrink-0" />
                  <p class="text-xs text-on-surface truncate flex-1 min-w-0">{step.content}</p>
                  {#if step.status === 'SENT'}
                    <span class="flex items-center gap-1 text-2xs text-success shrink-0">
                      {step.deliveredCount}
                      <Papicon icon="check" size={11} />
                      {#if step.failedCount}
                        <span class="flex items-center gap-1 text-error">
                          {step.failedCount}
                          <Papicon icon="x" size={11} />
                        </span>
                      {/if}
                    </span>
                  {:else if step.status === 'FAILED'}
                    <span class="text-2xs text-error shrink-0" title={step.lastError ?? ''}>{m.camp_step_failed()}</span>
                  {/if}
                </div>
              {/each}
            </div>

            {#if report}
              <div class="grid grid-cols-4 gap-2 pt-1">
                <div class="rounded-lg bg-surface-container px-2 py-1.5 text-center">
                  <div class="text-body-sm font-semibold text-on-surface tabular-nums">{report.delivered}</div>
                  <div class="text-2xs text-on-surface-variant">{m.camp_stat_sent()}</div>
                </div>
                <div class="rounded-lg bg-surface-container px-2 py-1.5 text-center">
                  <div class="text-body-sm font-semibold text-on-surface tabular-nums">{report.failed}</div>
                  <div class="text-2xs text-on-surface-variant">{m.camp_stat_failed()}</div>
                </div>
                <div class="rounded-lg bg-surface-container px-2 py-1.5 text-center">
                  <div class="text-body-sm font-semibold text-on-surface tabular-nums">{report.reactions}</div>
                  <div class="text-2xs text-on-surface-variant">{m.camp_stat_reactions()}</div>
                </div>
                <div class="rounded-lg bg-surface-container px-2 py-1.5 text-center" title={campaign.inviteCode ? '' : m.camp_joins_no_code()}>
                  <div class="text-body-sm font-semibold text-on-surface tabular-nums">
                    {campaign.inviteCode ? report.joins : '-'}
                  </div>
                  <div class="text-2xs text-on-surface-variant">{m.camp_stat_joins()}</div>
                </div>
              </div>
            {/if}

            <div class="flex flex-wrap gap-2 pt-1 border-t border-outline-variant/10">
              {#if campaign.status === 'DRAFT'}
                <ActionButton variant="primary" size="sm" icon="play" label={m.camp_launch()} onclick={() => changeStatus(campaign, 'SCHEDULED')} />
                <ActionButton variant="neutral" size="sm" icon="pencil" label={m.camp_edit()} onclick={() => openEdit(campaign)} />
              {:else if campaign.status === 'SCHEDULED' || campaign.status === 'RUNNING'}
                <ActionButton variant="warning" size="sm" icon="pause" label={m.camp_cancel_campaign()} onclick={() => changeStatus(campaign, 'CANCELLED')} />
              {:else if campaign.status === 'CANCELLED'}
                <ActionButton variant="neutral" size="sm" icon="rotate-ccw" label={m.camp_back_to_draft()} onclick={() => changeStatus(campaign, 'DRAFT')} />
              {/if}
              <ActionButton variant="danger" size="sm" icon="trash" label={m.common_delete()} onclick={() => remove(campaign)} />
            </div>
          </div>
        </SectionCard>
      {/each}
    </div>
  {/if}
</ModulePage>

<!-- ── Éditeur ──────────────────────────────────────────────────────────── -->
<Modal
  bind:open={modalOpen}
  title={editingId ? m.camp_edit_title() : m.camp_new()}
  subtitle={m.camp_modal_subtitle()}
  size="xl"
  closeOnBackdropClick={!saving}
>
  <div class="space-y-4">
    <!-- ── Général ────────────────────────────────────────────────────── -->
    <div class="campaign-section">
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label class="block">
          <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.camp_name()}</span>
          <FormInput type="text" bind:value={form.name} placeholder={m.camp_name_ph()} className="w-full" />
        </label>
        <label class="block">
          <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.camp_pivot()}</span>
          <input
            type="datetime-local"
            bind:value={form.startAt}
            class="w-full bg-surface-container-high text-sm px-4 py-2.5 rounded-xl border border-outline-variant/10 focus:ring-1 ring-primary/30 transition-all outline-none"
          />
        </label>
      </div>

      <label class="block mt-3">
        <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.camp_internal_desc()}</span>
        <FormInput type="text" bind:value={form.description} placeholder={m.camp_internal_desc_ph()} className="w-full" />
      </label>
    </div>

    <!-- ── Étapes ─────────────────────────────────────────────────────── -->
    <div class="campaign-section">
      <div class="campaign-section__header">
        <div class="campaign-section__icon">
          <Papicon icon="layers" size={16} />
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold text-on-surface">{m.camp_steps()}</p>
          <p class="text-xs text-on-surface-variant mt-0.5 leading-relaxed">
            {m.camp_steps_hint()}
          </p>
        </div>
        <ActionButton variant="neutral" size="sm" icon="plus" label={m.camp_add_step()} onclick={() => (form.steps = [...form.steps, emptyStep()])} />
      </div>

      <div class="space-y-2.5 mt-3">
        {#each form.steps as step, index (index)}
          <div class="rounded-xl border border-outline-variant/20 bg-surface-container-low/60 p-3.5 space-y-3">
            <div class="flex items-center justify-between gap-2">
              <span class="inline-flex items-center gap-2">
                <span class="w-5 h-5 rounded-full bg-primary/15 text-primary text-[10.5px] font-bold flex items-center justify-center shrink-0">
                  {index + 1}
                </span>
                <span class="text-2xs font-semibold text-on-surface-variant">
                  {offsetLabel(step.offsetMinutes)}
                </span>
              </span>
              {#if form.steps.length > 1}
                <button
                  type="button"
                  class="p-1.5 rounded-lg hover:bg-error/10 text-on-surface-variant hover:text-error transition-colors"
                  onclick={() => (form.steps = form.steps.filter((_, i) => i !== index))}
                  title={m.camp_remove_step()}
                >
                  <Papicon icon="trash" size={14} />
                </button>
              {/if}
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label class="block">
                <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">{m.camp_offset()}</span>
                <input
                  type="number"
                  bind:value={step.offsetMinutes}
                  class="w-full bg-surface-container-high text-sm px-3 py-2 rounded-xl border border-outline-variant/10 focus:ring-1 ring-primary/30 outline-none"
                />
              </label>
              <label class="block">
                <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">{m.camp_delivery()}</span>
                <FormSelect bind:value={step.delivery} className="w-full">
                  <option value="CHANNEL">{m.camp_delivery_channel()}</option>
                  <option value="DM">{m.camp_delivery_dm()}</option>
                </FormSelect>
              </label>
              {#if step.delivery === 'CHANNEL'}
                <label class="block">
                  <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">{m.camp_channel()}</span>
                  <FormSelect bind:value={step.channelId} className="w-full">
                    <option value={null}>{m.camp_choose()}</option>
                    {#each discordChannels as channel (channel.id)}
                      <option value={channel.id}>#{channel.name}</option>
                    {/each}
                  </FormSelect>
                </label>
              {/if}
            </div>

            <FormTextarea
              bind:value={step.content}
              placeholder={m.camp_content_ph({ server: '{server}', user: '{user}' })}
              className="w-full h-20"
            />
          </div>
        {/each}
      </div>
    </div>

    <!-- ── Audience ───────────────────────────────────────────────────── -->
    <div class="campaign-section">
      <div class="campaign-section__header">
        <div class="campaign-section__icon">
          <Papicon icon="users" size={16} />
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold text-on-surface">{m.camp_audience()}</p>
          <p class="text-xs text-on-surface-variant mt-0.5 leading-relaxed">
            {m.camp_audience_hint()}
          </p>
        </div>
        <ActionButton
          variant="neutral"
          size="sm"
          icon="users"
          label={previewing ? m.camp_counting() : m.camp_count()}
          disabled={previewing}
          onclick={preview}
        />
      </div>

      {#if audiencePreview}
        <p class="text-xs text-on-surface-variant rounded-lg bg-surface-container px-3 py-2 mt-3">
          <span class="font-semibold text-on-surface">{m.camp_members({ count: audiencePreview.count })}</span>
          {#if audiencePreview.sample.length > 0}
            · {audiencePreview.sample.map((s) => s.name).join(', ')}{audiencePreview.count > audiencePreview.sample.length ? '…' : ''}
          {/if}
        </p>
      {/if}

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
        <div>
          <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">{m.camp_roles_in()}</span>
          <MultiSelect
            bind:values={form.audienceRoleIds}
            options={discordRoles.map(r => ({ id: r.id, name: `@${r.name}` }))}
            placeholder={m.camp_all_members()}
          />
        </div>
        <div>
          <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">{m.camp_roles_out()}</span>
          <MultiSelect
            bind:values={form.audienceExcludeRoleIds}
            options={discordRoles.map(r => ({ id: r.id, name: `@${r.name}` }))}
            placeholder={m.camp_nobody()}
          />
        </div>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
        <label class="block">
          <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">{m.camp_min_level()}</span>
          <FormInput type="number" bind:value={form.audienceMinLevel} placeholder="-" className="w-full" />
        </label>
        <label class="block">
          <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">{m.camp_min_tenure()}</span>
          <FormInput type="number" bind:value={form.audienceMinTenureDays} placeholder="-" className="w-full" />
        </label>
        <label class="block">
          <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">{m.camp_inactive()}</span>
          <FormInput type="number" bind:value={form.audienceInactiveDays} placeholder="-" className="w-full" />
        </label>
      </div>
    </div>

    <!-- ── Mesure & partenaires ───────────────────────────────────────── -->
    <div class="campaign-section">
      <div class="campaign-section__header">
        <div class="campaign-section__icon">
          <Papicon icon="bar-chart-2" size={16} />
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold text-on-surface">{m.camp_measure()}</p>
          <p class="text-xs text-on-surface-variant mt-0.5 leading-relaxed">
            {m.camp_measure_hint()}
          </p>
        </div>
      </div>

      <div class="space-y-3 mt-3">
        <label class="block">
          <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.camp_invite_code()}</span>
          <FormInput type="text" bind:value={form.inviteCode} placeholder={m.camp_invite_code_ph()} className="w-full" />
          <span class="text-2xs text-on-surface-variant ml-1 mt-1 block">
            {m.camp_invite_code_hint()}
          </span>
        </label>

        <label class="block">
          <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.camp_targets()}</span>
          <FormInput
            type="text"
            value={form.targetGuildIds.join(', ')}
            oninput={(e: Event) => {
              form.targetGuildIds = (e.target as HTMLInputElement).value
                .split(',').map((v) => v.trim()).filter(Boolean);
            }}
            placeholder="1234…, 5678…"
            className="w-full"
          />
          <span class="text-2xs text-on-surface-variant ml-1 mt-1 block">
            {m.camp_targets_hint()}
          </span>
        </label>
      </div>
    </div>
  </div>

  {#snippet footer()}
    <div class="flex justify-end gap-2">
      <ActionButton variant="neutral" label={m.common_cancel()} disabled={saving} onclick={() => (modalOpen = false)} />
      <ActionButton
        variant="primary"
        label={saving ? m.camp_saving() : m.common_save()}
        disabled={saving}
        onclick={save}
      />
    </div>
  {/snippet}
</Modal>

<style>
  .campaign-section {
    background: var(--surface-container-low);
    border: 1px solid var(--outline-variant);
    border-radius: 0.875rem;
    padding: 1rem;
  }

  .campaign-section__header {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
  }

  .campaign-section__icon {
    width: 2rem;
    height: 2rem;
    border-radius: 0.625rem;
    background: var(--surface-container-high);
    color: var(--on-surface-variant);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
</style>
