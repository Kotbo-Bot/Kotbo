<!--
  Grades et hierarchies du staff. L'echelle en tete dit dans quel ordre on
  monte ; chaque hierarchie montre ses grades et qui les porte. Un grade se
  glisse d'une hierarchie a l'autre par sa poignee.
-->
<script lang="ts">
  import Modal from '../Modal.svelte';
  import SearchableSelect from '../SearchableSelect.svelte';
  import ToggleSwitch from '../ToggleSwitch.svelte';
  import EmojiPicker from '../EmojiPicker.svelte';
  import EmptyState from '../EmptyState.svelte';
  import Papicon from '../Papicon.svelte';
  import { Button, Field, Menu } from '../ui';
  import StaffAvatar from './StaffAvatar.svelte';
  import HierarchyIcon from './HierarchyIcon.svelte';
  import { staff, staffName } from './staffStore.svelte';
  import type { StaffHierarchy, StaffRole } from '../../types';
  import { m } from '../../i18n';

  const canEdit = $derived(staff.canConfigureRoles);
  const ladder = $derived([...staff.orderedRoles].reverse());

  // ── Glisser-deposer ──
  let dragged = $state<string | null>(null);
  let overRole = $state<string | null>(null);
  let overZone = $state<string | null>(null);

  /** Fleches haut et bas sur la poignee : le meme deplacement qu'au glisser. */
  function moveWithKeys(event: KeyboardEvent, role: StaffRole) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const siblings = staff.rolesInHierarchy(role.hierarchyId ?? null);
    const index = siblings.findIndex((r) => r.id === role.id);
    if (event.key === 'ArrowUp' && index > 0) {
      void staff.moveRole(role.id, { beforeRoleId: siblings[index - 1].id, hierarchyId: role.hierarchyId ?? null });
    } else if (event.key === 'ArrowDown' && index >= 0 && index < siblings.length - 1) {
      const after = siblings[index + 2];
      void staff.moveRole(role.id, after
        ? { beforeRoleId: after.id, hierarchyId: role.hierarchyId ?? null }
        : { hierarchyId: role.hierarchyId ?? null });
    }
  }

  function endDrag() {
    dragged = null;
    overRole = null;
    overZone = null;
  }

  // ── Grade : creation / edition ──
  let roleModal = $state<'create' | 'edit' | null>(null);
  let editing = $state<StaffRole | null>(null);
  let rName = $state('');
  let rDiscord = $state<string | null>(null);
  let rHierarchy = $state('');
  let rLevel = $state(100);
  let rColor = $state('');
  let rChief = $state(false);
  let savingRole = $state(false);

  function openCreateRole(hierarchyId = '') {
    editing = null;
    rName = '';
    rDiscord = null;
    rHierarchy = hierarchyId;
    const siblings = staff.rolesInHierarchy(hierarchyId || null);
    rLevel = siblings.length ? Math.max(1, (siblings.at(-1)?.level ?? 20) - 10) : 100;
    rColor = '';
    rChief = false;
    roleModal = 'create';
  }

  function openEditRole(role: StaffRole) {
    editing = role;
    rName = role.name;
    rDiscord = role.discordRoleId || null;
    rHierarchy = role.hierarchyId || '';
    rLevel = role.level;
    rColor = role.color || '';
    rChief = !!role.isResponsable;
    roleModal = 'edit';
  }

  // Choisir un role Discord propose son nom comme nom de grade.
  let lastDiscord: string | null = null;
  $effect(() => {
    if (roleModal !== 'create' || rDiscord === lastDiscord) return;
    lastDiscord = rDiscord;
    const name = staff.discordRoleName(rDiscord);
    if (name && (!rName || staff.discordRoles.some((r) => r.name === rName))) rName = name;
  });

  async function submitRole() {
    if (!rName.trim()) return;
    savingRole = true;
    const ok = roleModal === 'edit' && editing
      ? await staff.updateRole(editing.id, {
          name: rName.trim(),
          level: Number(rLevel),
          color: rColor || null,
          discordRoleId: rDiscord || null,
          hierarchyId: rHierarchy || null,
          isResponsable: rChief,
        })
      : await staff.createRole({ query: rName, discordRoleId: rDiscord ?? '', hierarchyId: rHierarchy, isResponsable: rChief, level: rLevel });
    savingRole = false;
    if (ok) roleModal = null;
  }

  // ── Hierarchie : creation / edition ──
  let hModal = $state(false);
  let hEditing = $state<StaffHierarchy | null>(null);
  let hName = $state('');
  let hDesc = $state('');
  let hColor = $state('#3b82f6');
  let hIcon = $state('🔵');
  let hRole = $state('');
  let hResp = $state('');
  let hParent = $state('');
  let savingH = $state(false);

  function openHierarchy(h: StaffHierarchy | null) {
    hEditing = h;
    hName = h?.name ?? '';
    hDesc = h?.description ?? '';
    hColor = h?.color || '#3b82f6';
    hIcon = h?.icon || '🔵';
    hRole = h?.discordRoleId || '';
    hResp = h?.responsableUserId || '';
    hParent = h?.parentHierarchyId || '';
    hModal = true;
  }

  async function submitHierarchy() {
    savingH = true;
    const ok = await staff.saveHierarchy(
      {
        name: hName.trim(),
        description: hDesc.trim() || null,
        color: hColor,
        icon: hIcon.trim() || null,
        discordRoleId: hRole.trim() || null,
        responsableUserId: hResp.trim() || null,
        parentHierarchyId: hParent || null,
      },
      hEditing?.id ?? null,
    );
    savingH = false;
    if (ok) hModal = false;
  }

  // ── Import depuis un role Discord ──
  let importTarget = $state<StaffHierarchy | null>(null);
  let importRole = $state('');
  let importGrade = $state('');
  let importing = $state(false);
  let importResult = $state<{ imported: number; skipped: number; total: number } | null>(null);

  function openImport(h: StaffHierarchy) {
    importTarget = h;
    importRole = h.discordRoleId || '';
    importGrade = staff.rolesInHierarchy(h.id).at(-1)?.name ?? '';
    importResult = null;
  }

  async function runImport() {
    if (!importTarget || !importRole || !importGrade) return;
    importing = true;
    importResult = await staff.importFromRole(importTarget.id, importRole, importGrade);
    importing = false;
  }

  function hierarchyMenu(h: StaffHierarchy) {
    return [
      { label: m.sx_add_grade_here(), icon: 'plus', onselect: () => openCreateRole(h.id) },
      { label: m.sm_title_import_members(), description: m.sx_import_desc(), icon: 'download', onselect: () => openImport(h) },
      { label: m.sm_title_edit_hierarchy(), icon: 'edit', onselect: () => openHierarchy(h) },
      { label: m.sm_title_delete_hierarchy(), icon: 'trash-2', onselect: () => void staff.deleteHierarchy(h) },
    ];
  }

  function roleMenu(role: StaffRole) {
    return [
      { label: m.sm_title_edit_role(), icon: 'edit', onselect: () => openEditRole(role) },
      { label: m.sm_title_delete_role(), icon: 'trash-2', onselect: () => void staff.deleteRole(role) },
    ];
  }

  const discordRoleOptions = $derived(staff.discordRoles.map((r) => ({ id: r.id, name: r.name })));
</script>

{#snippet roleRow(role: StaffRole)}
  {@const holders = staff.membersWithGrade(role.name)}
  <li
    class="role-row"
    class:role-row--over={overRole === role.id && dragged !== role.id}
    class:role-row--dragging={dragged === role.id}
    ondragover={(e) => { if (!dragged) return; e.preventDefault(); e.stopPropagation(); overRole = role.id; }}
    ondragleave={() => { if (overRole === role.id) overRole = null; }}
    ondrop={(e) => { e.preventDefault(); e.stopPropagation(); const id = dragged; endDrag(); if (id) void staff.moveRole(id, { beforeRoleId: role.id, hierarchyId: role.hierarchyId ?? null }); }}
  >
    {#if canEdit}
      <!-- Une poignee en <span> : Firefox refuse de faire glisser un <button>,
           le grade ne bougeait pas du tout. Au clavier, fleches haut et bas. -->
      <span
        class="role-handle"
        role="button"
        tabindex="0"
        draggable="true"
        ondragstart={(e) => {
          dragged = role.id;
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', role.id);
          }
        }}
        ondragend={endDrag}
        onkeydown={(e) => moveWithKeys(e, role)}
        aria-label={m.sx_move_role_hint({ name: role.name })}
        title={m.sx_move_role_hint({ name: role.name })}
      >
        <Papicon icon="grip-vertical" size={14} />
      </span>
    {/if}
    <span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background: {role.color || 'var(--outline)'}" aria-hidden="true"></span>
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2">
        <span class="truncate text-sm font-medium text-on-surface">{role.name}</span>
        {#if role.isResponsable}
          <span class="badge badge-warning"><Papicon icon="crown" size={11} />{m.sm_role_chief_badge()}</span>
        {/if}
      </div>
      <p class="truncate text-xs text-on-surface-variant">
        {role.discordRoleId ? `@${staff.discordRoleName(role.discordRoleId)}` : m.sm_role_custom()}{' · '}{m.sm_role_weight_label({ level: role.level })}
      </p>
    </div>
    {#if holders.length}
      <span class="flex -space-x-2" title={holders.map((h) => staffName(h)).join(', ')}>
        {#each holders.slice(0, 4) as holder (holder.id)}
          <span class="rounded-full ring-2 ring-surface-container-lowest"><StaffAvatar url={holder.avatarUrl} name={staffName(holder)} userId={holder.userId} size={22} /></span>
        {/each}
        {#if holders.length > 4}
          <span class="flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-surface-container-high px-1 text-2xs font-semibold text-on-surface-variant ring-2 ring-surface-container-lowest">+{holders.length - 4}</span>
        {/if}
      </span>
    {:else}
      <span class="text-xs text-on-surface-variant">{m.sx_nobody()}</span>
    {/if}
    {#if canEdit}
      <Menu label={m.sx_role_menu({ name: role.name })} items={roleMenu(role)} />
    {/if}
  </li>
{/snippet}

{#snippet dropZone(id: string, hierarchyId: string | null, roles: StaffRole[], emptyText: string)}
  <ul
    class="role-list"
    class:role-list--over={overZone === id && !!dragged}
    aria-label={emptyText}
    ondragover={(e) => { if (!dragged) return; e.preventDefault(); overZone = id; }}
    ondragleave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) overZone = null; }}
    ondrop={(e) => { e.preventDefault(); const roleId = dragged; endDrag(); if (roleId) void staff.moveRole(roleId, { hierarchyId }); }}
  >
    {#each roles as role (role.id)}
      {@render roleRow(role)}
    {:else}
      <li class="px-3 py-5 text-center text-xs text-on-surface-variant">{dragged ? m.sx_drop_here() : emptyText}</li>
    {/each}
  </ul>
{/snippet}

<div class="space-y-6">
  <!-- Barre d'outils -->
  <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
    <p class="text-sm text-on-surface-variant">
      {m.sx_roles_summary({ h: staff.hierarchies.length, r: staff.roles.length })}
      {#if staff.savingRoleOrder}
        <span class="ml-2 inline-flex items-center gap-1 text-primary"><span class="btn-spinner"></span>{m.sm_saving_order()}</span>
      {/if}
    </p>
    {#if canEdit}
      <div class="flex items-center gap-2">
        <Button icon="layers" onclick={() => openHierarchy(null)}>{m.sm_btn_new_hierarchy()}</Button>
        <Button variant="primary" icon="plus" onclick={() => openCreateRole('')}>{m.sm_btn_new_role()}</Button>
      </div>
    {/if}
  </div>

  <!-- Echelle de promotion -->
  {#if ladder.length > 1}
    <section class="section-card p-4" aria-labelledby="ladder-title">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="ladder-title" class="text-sm font-semibold text-on-surface">{m.sx_ladder_title()}</h3>
        <p class="text-xs text-on-surface-variant">{m.sx_ladder_hint()}</p>
      </div>
      <ol class="mt-3 flex flex-wrap items-center gap-y-2">
        {#each ladder as role, i (role.id)}
          {@const count = staff.membersWithGrade(role.name).length}
          <li class="flex items-center">
            <span class="ladder-step" style="--step: {staff.gradeColor(role.name) || 'var(--outline)'}">
              <span class="ladder-step__dot" aria-hidden="true"></span>
              {role.name}
              <span class="ladder-step__count tabular-nums">{count}</span>
            </span>
            {#if i < ladder.length - 1}
              <Papicon icon="chevron-right" size={14} class="mx-1 text-on-surface-variant" />
            {/if}
          </li>
        {/each}
      </ol>
    </section>
  {/if}

  {#if staff.loading.roles && staff.roles.length === 0}
    <div class="grid gap-4 lg:grid-cols-2">
      {#each Array(2) as _}
        <div class="section-card h-48 animate-pulse"></div>
      {/each}
    </div>
  {:else if staff.hierarchies.length === 0 && staff.roles.length === 0}
    <div class="section-card">
      <EmptyState
        icon="layers"
        title={m.sx_roles_empty_title()}
        description={m.sx_roles_empty_desc()}
        actionLabel={canEdit ? m.sx_roles_empty_action() : ''}
        onAction={() => openHierarchy(null)}
      />
    </div>
  {:else}
    <div class="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
      {#each staff.orderedHierarchies as h (h.id)}
        {@const roles = staff.rolesInHierarchy(h.id)}
        {@const parent = staff.hierarchyById(h.parentHierarchyId)}
        {@const responsable = h.responsableUserId ? staff.memberByUserId(h.responsableUserId) : undefined}
        <section class="section-card flex flex-col" aria-labelledby="h-{h.id}">
          <header class="flex items-start gap-3 px-4 pt-4">
            <HierarchyIcon icon={h.icon} color={h.color} size={36} />
            <div class="min-w-0 flex-1">
              <h3 id="h-{h.id}" class="truncate text-sm font-semibold text-on-surface">{h.name}</h3>
              {#if h.description}
                <p class="line-clamp-2 text-xs text-on-surface-variant">{h.description}</p>
              {/if}
            </div>
            {#if canEdit}
              <Menu label={m.sx_hierarchy_menu({ name: h.name })} items={hierarchyMenu(h)} />
            {/if}
          </header>
          {#if responsable || parent}
            <div class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pt-3 text-xs text-on-surface-variant">
              {#if responsable}
                <span class="inline-flex items-center gap-1.5">
                  <StaffAvatar url={responsable.avatarUrl} name={staffName(responsable)} userId={responsable.userId} size={18} />
                  {m.sx_led_by({ name: staffName(responsable) })}
                </span>
              {/if}
              {#if parent}
                <span class="inline-flex items-center gap-1"><Papicon icon="git-branch" size={12} />{m.sx_reports_to({ name: parent.name })}</span>
              {/if}
            </div>
          {/if}
          <div class="flex-1 p-3">
            {@render dropZone(h.id, h.id, roles, m.sm_no_roles_in_hierarchy())}
          </div>
          {#if canEdit}
            <div class="border-t border-outline-variant px-3 py-2">
              <Button variant="ghost" size="sm" icon="plus" onclick={() => openCreateRole(h.id)}>{m.sx_add_grade_here()}</Button>
            </div>
          {/if}
        </section>
      {/each}

      <!-- Hors hierarchie -->
      <section class="flex flex-col rounded-xl border border-dashed border-outline-variant" aria-labelledby="h-unlinked">
        <header class="px-4 pt-4">
          <h3 id="h-unlinked" class="text-sm font-semibold text-on-surface">{m.sm_roles_unlinked_title()}</h3>
          <p class="text-xs text-on-surface-variant">{m.sm_roles_unlinked_desc()}</p>
        </header>
        <div class="flex-1 p-3">
          {@render dropZone('unlinked', null, staff.rolesInHierarchy(null), m.sm_no_roles_unlinked())}
        </div>
      </section>
    </div>
  {/if}

  <!-- Configuration globale -->
  <section class="section-card" aria-labelledby="staff-global-config">
    <header class="flex items-start justify-between gap-3 px-5 pt-5">
      <div>
        <h3 id="staff-global-config" class="text-sm font-semibold text-on-surface">{m.sm_global_config_title()}</h3>
        <p class="text-xs text-on-surface-variant">{m.sx_global_config_desc()}</p>
      </div>
      <span class="text-xs text-on-surface-variant" aria-live="polite">{staff.savingConfig ? m.sm_saving() : ''}</span>
    </header>
    <div class="grid gap-4 p-5 md:grid-cols-2 xl:grid-cols-3">
      <Field label={m.sm_field_base_role()} hint={m.sx_base_role_hint()}>
        {#snippet children(id, describedBy)}
          <select {id} aria-describedby={describedBy} class="input" disabled={!canEdit} value={staff.config.baseStaffRoleId ?? ''} onchange={(e) => staff.saveConfig({ baseStaffRoleId: (e.currentTarget as HTMLSelectElement).value || null })}>
            <option value="">{m.sm_none_option()}</option>
            {#each staff.discordRoles as dr (dr.id)}<option value={dr.id}>{dr.name}</option>{/each}
          </select>
        {/snippet}
      </Field>
      <Field label={m.sm_field_test_role()} hint={m.sx_test_role_hint()}>
        {#snippet children(id, describedBy)}
          <select {id} aria-describedby={describedBy} class="input" disabled={!canEdit} value={staff.config.testStaffRoleId ?? ''} onchange={(e) => staff.saveConfig({ testStaffRoleId: (e.currentTarget as HTMLSelectElement).value || null })}>
            <option value="">{m.sm_none_option()}</option>
            {#each staff.discordRoles as dr (dr.id)}<option value={dr.id}>{dr.name}</option>{/each}
          </select>
        {/snippet}
      </Field>
      <div class="field">
        <span class="field-label">{m.sm_field_staff_announce_channel()}</span>
        <SearchableSelect value={staff.config.staffAnnouncementChannelId} options={staff.textChannels.map((c) => ({ id: c.id, name: `#${c.name}` }))} placeholder={m.sm_none_option()} className="w-full" on:change={(e: CustomEvent) => staff.saveConfig({ staffAnnouncementChannelId: e.detail?.value ?? null })} />
      </div>
      <div class="field">
        <span class="field-label">{m.sm_field_meeting_announce_channel()}</span>
        <SearchableSelect value={staff.config.meetingAnnouncementChannelId} options={staff.meetingTextOptions} placeholder={m.sm_none_option()} className="w-full" on:change={(e: CustomEvent) => staff.saveConfig({ meetingAnnouncementChannelId: e.detail?.value ?? null })} />
      </div>
      <div class="field">
        <span class="field-label">{m.sm_field_meeting_voice_channel()}</span>
        <SearchableSelect value={staff.config.meetingVoiceChannelId} options={staff.meetingVoiceOptions} placeholder={m.sm_none_option()} className="w-full" on:change={(e: CustomEvent) => staff.saveConfig({ meetingVoiceChannelId: e.detail?.value ?? null })} />
      </div>
    </div>
  </section>
</div>

<!-- Grade -->
<Modal
  open={roleModal !== null}
  onClose={() => (roleModal = null)}
  title={roleModal === 'edit' ? m.sm_title_edit_role() : m.sm_btn_new_role()}
  subtitle={m.sx_role_modal_sub()}
>
  <div class="space-y-4">
    <div class="field">
      <span class="field-label">{m.sm_field_linked_discord_role()}</span>
      <SearchableSelect bind:value={rDiscord} options={discordRoleOptions} placeholder={m.sm_none_option()} className="w-full" />
      <p class="field-hint">{m.sx_discord_role_hint()}</p>
    </div>
    <Field label={m.sm_modal_edit_role_field_name()} required>
      {#snippet children(id)}
        <input {id} class="input" type="text" placeholder={m.sm_placeholder_role_name()} bind:value={rName} />
      {/snippet}
    </Field>
    <div class="grid gap-4 sm:grid-cols-2">
      <Field label={m.sm_field_hierarchy_assoc()}>
        {#snippet children(id)}
          <select {id} class="input" bind:value={rHierarchy}>
            <option value="">{m.sm_none_out_of_hierarchy()}</option>
            {#each staff.orderedHierarchies as h (h.id)}<option value={h.id}>{h.name}</option>{/each}
          </select>
        {/snippet}
      </Field>
      <Field label={m.sm_field_role_weight()} hint={m.sx_weight_hint()}>
        {#snippet children(id, describedBy)}
          <input {id} aria-describedby={describedBy} class="input tabular-nums" type="number" min="1" max="10000" bind:value={rLevel} />
        {/snippet}
      </Field>
    </div>
    {#if roleModal === 'edit'}
      <Field label={m.sm_field_color_hex_optional()}>
        {#snippet children(id)}
          <div class="flex gap-2">
            <input type="color" class="h-9 w-11 cursor-pointer rounded-lg border border-outline-variant bg-surface-container p-1" value={rColor || '#949ba4'} oninput={(e) => (rColor = (e.currentTarget as HTMLInputElement).value)} aria-label={m.sm_field_color()} />
            <input {id} class="input" type="text" placeholder="#3b82f6" bind:value={rColor} />
          </div>
        {/snippet}
      </Field>
    {/if}
    <label class="flex items-start justify-between gap-4 rounded-lg border border-outline-variant px-4 py-3">
      <span>
        <span class="block text-sm font-medium text-on-surface">{m.sm_toggle_hierarchy_chief()}</span>
        <span class="block text-xs text-on-surface-variant">{m.sx_chief_hint()}</span>
      </span>
      <ToggleSwitch checked={rChief} onToggle={(v: boolean) => (rChief = v)} />
    </label>
  </div>
  {#snippet footer()}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => (roleModal = null)}>{m.common_cancel()}</Button>
      <Button variant="primary" loading={savingRole} disabled={!rName.trim()} disabledReason={m.sx_name_required()} onclick={submitRole}>
        {roleModal === 'edit' ? m.common_save() : m.sx_create_grade()}
      </Button>
    </div>
  {/snippet}
</Modal>

<!-- Hierarchie -->
<Modal open={hModal} onClose={() => (hModal = false)} title={hEditing ? m.sm_modal_edit_hierarchy_title() : m.sm_btn_new_hierarchy()} subtitle={m.sx_hierarchy_modal_sub()}>
  <div class="space-y-4">
    <div class="flex items-center gap-3 rounded-lg bg-surface-container px-3 py-3">
      <HierarchyIcon icon={hIcon} color={hColor} size={40} />
      <div class="min-w-0">
        <p class="truncate text-sm font-semibold text-on-surface">{hName || m.sm_placeholder_hierarchy_name()}</p>
        <p class="truncate text-xs text-on-surface-variant">{hDesc || m.sx_preview()}</p>
      </div>
    </div>
    <Field label={m.sm_field_hierarchy_name()} required>
      {#snippet children(id)}
        <input {id} class="input" type="text" placeholder={m.sm_placeholder_hierarchy_name()} bind:value={hName} />
      {/snippet}
    </Field>
    <Field label={m.sm_field_description()}>
      {#snippet children(id)}
        <textarea {id} class="input resize-none" rows="2" placeholder={m.sm_placeholder_hierarchy_desc()} bind:value={hDesc}></textarea>
      {/snippet}
    </Field>
    <div class="grid gap-4 sm:grid-cols-2">
      <Field label={m.sm_field_color()}>
        {#snippet children(id)}
          <div class="flex gap-2">
            <input type="color" class="h-9 w-11 cursor-pointer rounded-lg border border-outline-variant bg-surface-container p-1" bind:value={hColor} aria-label={m.sm_field_color()} />
            <input {id} class="input" type="text" bind:value={hColor} />
          </div>
        {/snippet}
      </Field>
      <Field label={m.sm_field_emoji()}>
        {#snippet children(id)}
          <div class="flex gap-2">
            <input {id} class="input" type="text" placeholder="🔵, 🛡️, 🎭..." bind:value={hIcon} />
            <EmojiPicker bind:value={hIcon} />
          </div>
        {/snippet}
      </Field>
    </div>
    <Field label={m.sm_field_hierarchy_role()}>
      {#snippet children(id)}
        <select {id} class="input" bind:value={hRole}>
          <option value="">{m.sm_none_option()}</option>
          {#each staff.discordRoles as dr (dr.id)}<option value={dr.id}>{dr.name}</option>{/each}
        </select>
      {/snippet}
    </Field>
    <div class="grid gap-4 sm:grid-cols-2">
      <Field label={m.sm_field_hierarchy_responsible_member()}>
        {#snippet children(id)}
          <select {id} class="input" bind:value={hResp}>
            <option value="">{m.sm_none_option()}</option>
            {#each staff.activeMembers as member (member.id)}<option value={member.userId}>{staffName(member)}</option>{/each}
          </select>
        {/snippet}
      </Field>
      <Field label={m.sm_field_hierarchy_parent()}>
        {#snippet children(id)}
          <select {id} class="input" bind:value={hParent}>
            <option value="">{m.sm_none_alt_option()}</option>
            {#each staff.orderedHierarchies.filter((x) => x.id !== hEditing?.id) as x (x.id)}<option value={x.id}>{x.name}</option>{/each}
          </select>
        {/snippet}
      </Field>
    </div>
  </div>
  {#snippet footer()}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => (hModal = false)}>{m.common_cancel()}</Button>
      <Button variant="primary" loading={savingH} disabled={!hName.trim()} disabledReason={m.sx_name_required()} onclick={submitHierarchy}>{m.common_save()}</Button>
    </div>
  {/snippet}
</Modal>

<!-- Import -->
<Modal open={!!importTarget} onClose={() => (importTarget = null)} title={importTarget ? m.sm_modal_import_title({ name: importTarget.name }) : ''} subtitle={m.sx_import_desc()}>
  <div class="space-y-4">
    {#if importResult}
      <div class="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-outline-variant bg-outline-variant text-center">
        <div class="bg-surface-container-lowest p-3"><p class="text-xl font-semibold tabular-nums text-success">{importResult.imported}</p><p class="text-xs text-on-surface-variant">{m.sx_import_added()}</p></div>
        <div class="bg-surface-container-lowest p-3"><p class="text-xl font-semibold tabular-nums text-on-surface">{importResult.skipped}</p><p class="text-xs text-on-surface-variant">{m.sx_import_skipped()}</p></div>
        <div class="bg-surface-container-lowest p-3"><p class="text-xl font-semibold tabular-nums text-on-surface">{importResult.total}</p><p class="text-xs text-on-surface-variant">{m.sx_import_total()}</p></div>
      </div>
    {:else}
      <Field label={m.sm_field_import_role()}>
        {#snippet children(id)}
          <select {id} class="input" bind:value={importRole}>
            <option value="">{m.sm_option_choose_role()}</option>
            {#each staff.discordRoles as dr (dr.id)}<option value={dr.id}>{dr.name}</option>{/each}
          </select>
        {/snippet}
      </Field>
      <Field label={m.sm_field_import_grade()}>
        {#snippet children(id)}
          <select {id} class="input" bind:value={importGrade}>
            <option value="">{m.sm_option_choose_grade()}</option>
            {#each staff.rolesInHierarchy(importTarget?.id ?? null) as r (r.id)}<option value={r.name}>{r.name}</option>{/each}
          </select>
        {/snippet}
      </Field>
    {/if}
  </div>
  {#snippet footer()}
    <div class="flex justify-end gap-2">
      <Button variant={importResult ? 'secondary' : 'ghost'} onclick={() => (importTarget = null)}>{importResult ? m.common_close() : m.common_cancel()}</Button>
      {#if !importResult}
        <Button variant="primary" icon="download" loading={importing} disabled={!importRole || !importGrade} disabledReason={m.sx_pick_role_grade()} onclick={runImport}>{m.sm_btn_launch_import()}</Button>
      {/if}
    </div>
  {/snippet}
</Modal>

<style>
  .role-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 3rem;
    padding: 2px;
    border-radius: 0.625rem;
    border: 1px dashed transparent;
    transition: background-color 0.15s ease, border-color 0.15s ease;
  }
  .role-list--over {
    border-color: color-mix(in srgb, var(--primary-color) 45%, transparent);
    background: color-mix(in srgb, var(--primary-color) 5%, transparent);
  }

  .role-row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.5rem 0.5rem 0.5rem 0.375rem;
    border-radius: 0.5rem;
    transition: background-color 0.12s ease, box-shadow 0.12s ease, opacity 0.12s ease;
  }
  .role-row:hover {
    background: var(--surface-hover);
  }
  .role-row--over {
    box-shadow: inset 0 2px 0 var(--primary-color);
  }
  .role-row--dragging {
    opacity: 0.4;
  }

  .role-handle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.75rem;
    border-radius: 0.375rem;
    color: var(--on-surface-variant);
    cursor: grab;
  }
  .role-handle:active {
    cursor: grabbing;
  }
  @media (hover: hover) {
    .role-handle {
      opacity: 0.35;
      transition: opacity 0.12s ease;
    }
    .role-row:hover .role-handle,
    .role-handle:focus-visible {
      opacity: 1;
    }
  }

  .ladder-step {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.25rem 0.375rem 0.25rem 0.625rem;
    border-radius: 9999px;
    border: 1px solid var(--outline-variant);
    font-size: 0.8125rem;
    color: var(--on-surface);
    background: var(--surface-container-lowest);
  }
  .ladder-step__dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 9999px;
    background: var(--step);
  }
  .ladder-step__count {
    min-width: 1.25rem;
    padding: 0 0.3rem;
    border-radius: 9999px;
    font-size: 0.6875rem;
    font-weight: 600;
    text-align: center;
    color: var(--on-surface-variant);
    background: var(--surface-container);
  }
</style>
