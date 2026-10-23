<!--
  Fenetres de la gestion du staff, ouvertes depuis n'importe quel onglet ou
  depuis la fiche d'un membre : ajouter, avertir, mettre en liste noire,
  rattacher a des poles, regler les sanctions automatiques.
-->
<script lang="ts">
  import Modal from '../Modal.svelte';
  import DiscordMemberLookup from '../DiscordMemberLookup.svelte';
  import ToggleSwitch from '../ToggleSwitch.svelte';
  import Papicon from '../Papicon.svelte';
  import { Button, Field, Callout } from '../ui';
  import StaffAvatar from './StaffAvatar.svelte';
  import HierarchyIcon from './HierarchyIcon.svelte';
  import WarnMeter from './WarnMeter.svelte';
  import { staff, staffName } from './staffStore.svelte';
  import { m } from '../../i18n';

  // ── Ajouter un membre ──
  let addQuery = $state('');
  let addUserId = $state('');
  let addUsername = $state('');
  let addAvatar = $state('');
  let addRoleIds = $state<string[]>([]);
  let addGrade = $state('');
  let addTutoring = $state(true);
  let adding = $state(false);

  $effect(() => {
    if (staff.dialogs.addMember) {
      addQuery = '';
      addUserId = '';
      addUsername = '';
      addAvatar = '';
      addRoleIds = [];
      addTutoring = true;
      addGrade = staff.orderedRoles.at(-1)?.name ?? '';
    }
  });

  // Le grade suit les roles Discord du membre choisi quand l'un d'eux est lie a un grade.
  const detectedGrade = $derived(staff.resolveGradeFromDiscordRoles(addRoleIds));
  $effect(() => {
    if (detectedGrade) addGrade = detectedGrade;
  });

  async function submitAdd() {
    adding = true;
    const ok = await staff.addMember({ userId: addUserId, grade: addGrade, username: addUsername, avatarUrl: addAvatar, createTestingPeriod: addTutoring });
    adding = false;
    if (ok) staff.dialogs.addMember = false;
  }

  // ── Avertir ──
  let warnQuery = $state('');
  let warnUserId = $state('');
  let warnReason = $state('');
  let warnExpires = $state('');
  let warning = $state(false);
  let warnTouched = $state(false);
  const warnPreset = $derived(staff.dialogs.warn?.userId ? staff.memberByUserId(staff.dialogs.warn.userId) : undefined);
  const warnTarget = $derived(warnPreset ?? (warnUserId ? staff.memberByUserId(warnUserId) : undefined));

  $effect(() => {
    if (staff.dialogs.warn) {
      warnQuery = '';
      warnUserId = staff.dialogs.warn.userId;
      warnReason = '';
      warnExpires = '';
      warnTouched = false;
    }
  });

  async function submitWarn() {
    warnTouched = true;
    if (!warnUserId || !warnReason.trim()) return;
    warning = true;
    const ok = await staff.issueWarning({ staffUserId: warnUserId, reason: warnReason, expiresAt: warnExpires });
    warning = false;
    if (ok) staff.dialogs.warn = null;
  }

  // ── Liste noire ──
  let blQuery = $state('');
  let blUserId = $state('');
  let blReason = $state('');
  let blEnd = $state('');
  let blacklisting = $state(false);
  let blTouched = $state(false);
  const blPreset = $derived(staff.dialogs.blacklist?.userId ? staff.memberByUserId(staff.dialogs.blacklist.userId) : undefined);

  $effect(() => {
    if (staff.dialogs.blacklist) {
      blQuery = '';
      blUserId = staff.dialogs.blacklist.userId;
      blReason = '';
      blEnd = '';
      blTouched = false;
    }
  });

  async function submitBlacklist() {
    blTouched = true;
    if (!blUserId || !blReason.trim()) return;
    blacklisting = true;
    const ok = await staff.blacklist({ staffUserId: blUserId, reason: blReason, endDate: blEnd });
    blacklisting = false;
    if (ok) staff.dialogs.blacklist = null;
  }

  // ── Poles d'un membre ──
  const gradesMember = $derived(staff.dialogs.grades ? staff.memberByUserId(staff.dialogs.grades) : undefined);
  let gHierarchyId = $state('');
  let gGrade = $state('');
  let savingGrade = $state(false);
  let lastGradesUser = '';

  $effect(() => {
    const target = gradesMember;
    if (!target) {
      lastGradesUser = '';
      return;
    }
    if (target.userId === lastGradesUser) return;
    lastGradesUser = target.userId;
    const draft = staff.resolveMemberHierarchyDraft(target);
    gHierarchyId = draft?.hierarchyId ?? '';
    gGrade = draft?.grade ?? '';
  });

  function pickHierarchy(id: string) {
    gHierarchyId = id;
    if (!id || !gradesMember) {
      gGrade = '';
      return;
    }
    const existing = gradesMember.hierarchyGrades?.find((entry) => entry.hierarchyId === id)?.grade;
    gGrade = existing || staff.rolesInHierarchy(id)[0]?.name || '';
  }

  async function submitGrade() {
    if (!gradesMember || !gHierarchyId || !gGrade) return;
    savingGrade = true;
    await staff.addHierarchyGrade(gradesMember.userId, gHierarchyId, gGrade);
    savingGrade = false;
  }
</script>

{#snippet presetMember(member: NonNullable<typeof warnPreset>, onChange: () => void)}
  <div class="flex items-center gap-3 rounded-lg border border-outline-variant bg-surface-container px-3 py-2.5">
    <StaffAvatar url={member.avatarUrl} name={staffName(member)} userId={member.userId} size={32} />
    <span class="min-w-0 flex-1">
      <span class="block truncate text-sm font-medium text-on-surface">{staffName(member)}</span>
      <span class="block truncate text-xs text-on-surface-variant">{member.grade}</span>
    </span>
    <Button variant="ghost" size="sm" onclick={onChange}>{m.sx_change()}</Button>
  </div>
{/snippet}

<!-- Ajouter un membre -->
<Modal aboveCase open={staff.dialogs.addMember} onClose={() => (staff.dialogs.addMember = false)} title={m.sm_btn_add_member()} subtitle={m.sx_add_member_sub()}>
  <div class="space-y-4">
    <Field label={m.sm_field_discord_user()} required>
      {#snippet children()}
        <DiscordMemberLookup
          guildId={staff.guildId}
          bind:query={addQuery}
          bind:selectedId={addUserId}
          bind:selectedUsername={addUsername}
          bind:selectedAvatarUrl={addAvatar}
          bind:selectedRoleIds={addRoleIds}
          placeholder={m.sm_placeholder_mention_or_id()}
        />
      {/snippet}
    </Field>
    <Field label={m.sm_field_global_grade()} hint={detectedGrade ? m.sx_grade_detected() : m.sx_grade_hint()}>
      {#snippet children(id, describedBy)}
        <select {id} aria-describedby={describedBy} class="input" bind:value={addGrade}>
          {#each staff.orderedRoles as role (role.id)}
            <option value={role.name}>{role.name}</option>
          {/each}
        </select>
      {/snippet}
    </Field>
    <label class="flex items-start justify-between gap-4 rounded-lg border border-outline-variant px-4 py-3">
      <span>
        <span class="block text-sm font-medium text-on-surface">{m.sm_toggle_create_tutoring()}</span>
        <span class="block text-xs text-on-surface-variant">{m.sx_tutoring_hint()}</span>
      </span>
      <ToggleSwitch checked={addTutoring} onToggle={(v: boolean) => (addTutoring = v)} />
    </label>
  </div>
  {#snippet footer()}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => (staff.dialogs.addMember = false)}>{m.common_cancel()}</Button>
      <Button
        variant="primary"
        icon="plus"
        loading={adding}
        disabled={!addUserId || !addGrade}
        disabledReason={!addGrade ? m.sx_need_role_first() : m.sm_toast_select_member()}
        onclick={submitAdd}
      >{m.sx_add_to_staff()}</Button>
    </div>
  {/snippet}
</Modal>

<!-- Avertir -->
<Modal aboveCase open={!!staff.dialogs.warn} onClose={() => (staff.dialogs.warn = null)} title={m.sm_btn_new_warning()} subtitle={m.sm_warn_desc()}>
  <div class="space-y-4">
    {#if warnPreset}
      {@render presetMember(warnPreset, () => (staff.dialogs.warn = { userId: '' }))}
    {:else}
      <Field label={m.sm_field_target_member()} required error={warnTouched && !warnUserId ? m.sm_toast_select_member() : ''}>
        {#snippet children()}
          <DiscordMemberLookup guildId={staff.guildId} bind:query={warnQuery} bind:selectedId={warnUserId} staffOnly={true} placeholder={m.sm_placeholder_search_staff()} />
        {/snippet}
      </Field>
    {/if}

    {#if warnTarget}
      {@const next = (warnTarget.warnings?.length ?? 0) + 1}
      <div class="flex items-center justify-between gap-3 rounded-lg bg-surface-container px-3 py-2.5">
        <span class="text-xs text-on-surface-variant">{m.sx_after_this_warning()}</span>
        <WarnMeter count={next} threshold={staff.config.warnsToDemote || 3} />
      </div>
      {#if next >= staff.config.warnsToDemote && staff.config.warnsToDemote > 0}
        <Callout variant="warning" title={m.sx_reaches_threshold_title()}>
          {staff.config.actionMode === 'auto' ? m.sx_reaches_threshold_auto() : m.sx_reaches_threshold_validation()}
        </Callout>
      {/if}
    {/if}

    <Field label={m.sm_field_warn_reason()} required error={warnTouched && !warnReason.trim() ? m.sx_reason_required() : ''}>
      {#snippet children(id, describedBy)}
        <textarea {id} aria-describedby={describedBy} class="input resize-none" rows="3" placeholder={m.sm_placeholder_warn_reason()} bind:value={warnReason}></textarea>
      {/snippet}
    </Field>
    <Field label={m.sm_field_expires_at()} hint={m.sx_expires_hint()}>
      {#snippet children(id, describedBy)}
        <input {id} aria-describedby={describedBy} class="input" type="datetime-local" bind:value={warnExpires} />
      {/snippet}
    </Field>
  </div>
  {#snippet footer()}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => (staff.dialogs.warn = null)}>{m.common_cancel()}</Button>
      <Button variant="primary" icon="alert-triangle" loading={warning} onclick={submitWarn}>{m.sx_issue_warning()}</Button>
    </div>
  {/snippet}
</Modal>

<!-- Liste noire -->
<Modal aboveCase open={!!staff.dialogs.blacklist} onClose={() => (staff.dialogs.blacklist = null)} title={m.sm_btn_blacklist()} subtitle={m.sm_blacklist_desc()}>
  <div class="space-y-4">
    {#if blPreset}
      {@render presetMember(blPreset, () => (staff.dialogs.blacklist = { userId: '' }))}
    {:else}
      <Field label={m.sm_field_blacklist_target()} required error={blTouched && !blUserId ? m.sm_toast_select_member() : ''}>
        {#snippet children()}
          <DiscordMemberLookup guildId={staff.guildId} bind:query={blQuery} bind:selectedId={blUserId} placeholder={m.sm_placeholder_mention_or_id()} />
        {/snippet}
      </Field>
    {/if}
    <Field label={m.sm_field_blacklist_reason()} required error={blTouched && !blReason.trim() ? m.sx_reason_required() : ''}>
      {#snippet children(id, describedBy)}
        <textarea {id} aria-describedby={describedBy} class="input resize-none" rows="3" placeholder={m.sm_placeholder_blacklist_reason()} bind:value={blReason}></textarea>
      {/snippet}
    </Field>
    <Field label={m.sm_field_blacklist_end()} hint={staff.config.blacklistPermanentByDefault ? m.sx_blacklist_end_hint_perma() : m.sx_blacklist_end_hint()}>
      {#snippet children(id, describedBy)}
        <input {id} aria-describedby={describedBy} class="input" type="date" bind:value={blEnd} />
      {/snippet}
    </Field>
    {#if blPreset}
      <Callout variant="danger" title={m.sx_blacklist_effect_title()}>{m.sx_blacklist_effect()}</Callout>
    {/if}
  </div>
  {#snippet footer()}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => (staff.dialogs.blacklist = null)}>{m.common_cancel()}</Button>
      <Button variant="danger" icon="slash" loading={blacklisting} onclick={submitBlacklist}>{m.sm_btn_apply_blacklist()}</Button>
    </div>
  {/snippet}
</Modal>

<!-- Poles d'un membre -->
<Modal
  aboveCase
  open={!!gradesMember}
  onClose={() => (staff.dialogs.grades = null)}
  title={gradesMember ? m.sm_modal_member_hierarchies_title({ name: staffName(gradesMember) }) : ''}
  subtitle={m.sx_grades_sub()}
>
  {#if gradesMember}
    <div class="space-y-5">
      <div>
        <p class="field-label">{m.sm_current_grades()}</p>
        {#if gradesMember.hierarchyGrades?.length}
          <ul class="divide-y divide-outline-variant rounded-lg border border-outline-variant">
            {#each gradesMember.hierarchyGrades as grade (grade.id)}
              {@const hierarchy = grade.hierarchy ?? staff.hierarchyById(grade.hierarchyId)}
              <li class="flex items-center gap-3 px-3 py-2.5">
                <HierarchyIcon icon={hierarchy?.icon} color={hierarchy?.color} size={28} />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm font-medium text-on-surface">{hierarchy?.name ?? ''}</span>
                  <span class="block truncate text-xs text-on-surface-variant">{grade.grade}</span>
                </span>
                <Button variant="ghost" size="sm" icon="x" aria-label="{m.sm_confirm_remove_btn()} {hierarchy?.name ?? ''}" onclick={() => staff.removeHierarchyGrade(gradesMember.userId, grade.hierarchyId)} />
              </li>
            {/each}
          </ul>
        {:else}
          <p class="rounded-lg border border-dashed border-outline-variant px-3 py-3 text-sm text-on-surface-variant">{m.sm_no_secondary_hierarchy()}</p>
        {/if}
      </div>

      <div class="space-y-3 border-t border-outline-variant pt-5">
        <p class="text-sm font-medium text-on-surface">{m.sm_associate_new_hierarchy()}</p>
        <div class="grid gap-3 sm:grid-cols-2">
          <Field label={m.sm_field_hierarchy()}>
            {#snippet children(id)}
              <select {id} class="input" value={gHierarchyId} onchange={(e) => pickHierarchy((e.currentTarget as HTMLSelectElement).value)}>
                <option value="">{m.sm_option_choose_hierarchy()}</option>
                {#each staff.orderedHierarchies as h (h.id)}
                  <option value={h.id}>{h.name}{gradesMember.hierarchyGrades?.some((hg) => hg.hierarchyId === h.id) ? m.sm_already_linked_suffix() : ''}</option>
                {/each}
              </select>
            {/snippet}
          </Field>
          <Field label={m.sm_field_grade()}>
            {#snippet children(id)}
              <select {id} class="input" bind:value={gGrade} disabled={!gHierarchyId}>
                <option value="">{m.sm_option_choose_grade()}</option>
                {#each staff.rolesInHierarchy(gHierarchyId || null) as r (r.id)}
                  <option value={r.name}>{r.name}</option>
                {/each}
              </select>
            {/snippet}
          </Field>
        </div>
      </div>
    </div>
  {/if}
  {#snippet footer()}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => (staff.dialogs.grades = null)}>{m.common_close()}</Button>
      <Button variant="primary" icon="plus" loading={savingGrade} disabled={!gHierarchyId || !gGrade} disabledReason={m.sx_pick_hierarchy_grade()} onclick={submitGrade}>{m.common_add()}</Button>
    </div>
  {/snippet}
</Modal>

<!-- Reglages : sanctions automatiques -->
<Modal aboveCase open={staff.dialogs.settings} onClose={() => (staff.dialogs.settings = false)} title={m.sm_config_modal_title()} subtitle={m.sm_config_modal_desc()} size="lg">
  <div class="space-y-6">
    <section class="space-y-3">
      <div>
        <h4 class="text-sm font-semibold text-on-surface">{m.sm_execution_mode()}</h4>
        <p class="text-xs text-on-surface-variant">{m.sm_sanctions_thresholds_desc()}</p>
      </div>
      <div class="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={m.sm_execution_mode()}>
        {#each [
          { value: 'validation' as const, icon: 'user-check', label: m.sm_mode_approval(), desc: m.sx_mode_validation_desc() },
          { value: 'auto' as const, icon: 'zap', label: m.sm_mode_auto(), desc: m.sx_mode_auto_desc() },
        ] as option (option.value)}
          {@const selected = staff.config.actionMode === option.value}
          <button
            type="button"
            role="radio"
            aria-checked={selected}
            class="mode-option"
            class:mode-option--on={selected}
            onclick={() => staff.saveConfig({ actionMode: option.value })}
          >
            <span class="mode-option__icon"><Papicon icon={option.icon} size={16} /></span>
            <span class="min-w-0 text-left">
              <span class="block text-sm font-medium text-on-surface">{option.label}</span>
              <span class="block text-xs text-on-surface-variant">{option.desc}</span>
            </span>
          </button>
        {/each}
      </div>
    </section>

    <section class="space-y-3">
      <h4 class="text-sm font-semibold text-on-surface">{m.sm_warn_thresholds()}</h4>
      <div class="grid gap-3 sm:grid-cols-2">
        <Field label={m.sm_threshold_demotion()} hint={m.sx_threshold_demote_hint()}>
          {#snippet children(id, describedBy)}
            <div class="flex items-center gap-2">
              <input {id} aria-describedby={describedBy} class="input w-24 tabular-nums" type="number" min="0" value={staff.config.warnsToDemote} onchange={(e) => staff.saveConfig({ warnsToDemote: Number((e.currentTarget as HTMLInputElement).value) })} />
              <span class="text-sm text-on-surface-variant">{m.sm_warn_unit()}</span>
            </div>
          {/snippet}
        </Field>
        <Field label={m.sm_threshold_blacklist()} hint={m.sx_threshold_blacklist_hint()}>
          {#snippet children(id, describedBy)}
            <div class="flex items-center gap-2">
              <input {id} aria-describedby={describedBy} class="input w-24 tabular-nums" type="number" min="0" value={staff.config.warnsToBlacklist} onchange={(e) => staff.saveConfig({ warnsToBlacklist: Number((e.currentTarget as HTMLInputElement).value) })} />
              <span class="text-sm text-on-surface-variant">{m.sm_warn_unit()}</span>
            </div>
          {/snippet}
        </Field>
      </div>
    </section>

    <section class="divide-y divide-outline-variant rounded-lg border border-outline-variant">
      <label class="flex items-center justify-between gap-4 px-4 py-3">
        <span>
          <span class="block text-sm font-medium text-on-surface">{m.sm_toggle_remove_roles_label()}</span>
          <span class="block text-xs text-on-surface-variant">{m.sm_toggle_remove_roles_desc()}</span>
        </span>
        <ToggleSwitch checked={staff.config.demoteRemoveAllRoles} onToggle={(v: boolean) => staff.saveConfig({ demoteRemoveAllRoles: v })} />
      </label>
      <label class="flex items-center justify-between gap-4 px-4 py-3">
        <span>
          <span class="block text-sm font-medium text-on-surface">{m.sm_toggle_perma_blacklist_label()}</span>
          <span class="block text-xs text-on-surface-variant">{m.sm_toggle_perma_blacklist_desc()}</span>
        </span>
        <ToggleSwitch checked={staff.config.blacklistPermanentByDefault} onToggle={(v: boolean) => staff.saveConfig({ blacklistPermanentByDefault: v })} />
      </label>
    </section>
  </div>
  {#snippet footer()}
    <div class="flex items-center justify-between gap-2">
      <span class="text-xs text-on-surface-variant" aria-live="polite">{staff.savingConfig ? m.sm_saving() : m.sx_autosaved()}</span>
      <Button variant="secondary" onclick={() => (staff.dialogs.settings = false)}>{m.common_close()}</Button>
    </div>
  {/snippet}
</Modal>

<style>
  .mode-option {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.75rem 0.875rem;
    border-radius: 0.625rem;
    border: 1px solid var(--outline-variant);
    background: var(--surface-container-lowest);
    transition: border-color 0.15s ease, background-color 0.15s ease;
  }
  .mode-option:hover {
    background: var(--surface-hover);
  }
  .mode-option--on {
    border-color: var(--primary-color);
    background: color-mix(in srgb, var(--primary-color) 6%, transparent);
  }
  .mode-option__icon {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border-radius: 0.5rem;
    color: var(--on-surface-variant);
    background: var(--surface-container);
  }
  .mode-option--on .mode-option__icon {
    color: var(--primary-color);
    background: color-mix(in srgb, var(--primary-color) 12%, transparent);
  }
</style>
