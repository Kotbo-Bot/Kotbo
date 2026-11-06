<!--
  Organigramme du staff. Trois organisations (hierarchie, pole, grade) et trois
  affichages (arbre, horizontal, plan) sur les memes cartes ; ces deux choix
  restent en memoire pour la personne, sur ce navigateur.

  « Reorganiser » ouvre le glisser-deposer. Chaque deplacement existe aussi
  dans le menu de la carte, pour le clavier et le tactile.
-->
<script lang="ts">
  import EmptyState from '../EmptyState.svelte';
  import Modal from '../Modal.svelte';
  import SearchableSelect from '../SearchableSelect.svelte';
  import { Button, FilterPills, Menu } from '../ui';
  import type { MenuItem } from '../ui/Menu.svelte';
  import OrgNode, { type DropPosition, type OrgControls } from './OrgNode.svelte';
  import {
    buildOrgCards, canAttach, orgChartSvg, orgRows, siblingsOf,
    type HierarchySchema, type OrgCard, type OrgLayout, type OrgMember, type OrgSection, type OrgType,
  } from './orgChartModel';
  import { staff } from './staffStore.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { downloadSvg, downloadSvgAsPng } from '../../svgExport';
  import { downloadSingleSheetXlsx } from '../../xlsxExport';
  import { m } from '../../i18n';

  const {
    schema,
    openCase,
  }: { schema: HierarchySchema | null; openCase?: (userId: string, userName: string) => void } = $props();

  const TYPE_KEY = 'kotbo:orgchart:type';
  const LAYOUT_KEY = 'kotbo:orgchart:layout';

  function remembered<T extends string>(key: string, allowed: T[], fallback: T): T {
    try {
      const value = localStorage.getItem(key) as T | null;
      return value && allowed.includes(value) ? value : fallback;
    } catch {
      return fallback;
    }
  }

  function remember(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Stockage bloque : le choix vaut pour cette visite.
    }
  }

  // Sur telephone, un arbre large se lit mal : le plan est le choix par defaut.
  const narrow = typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches;
  let type = $state<OrgType>(remembered(TYPE_KEY, ['hierarchy', 'teams', 'grades'], 'hierarchy'));
  let layout = $state<OrgLayout>(remembered(LAYOUT_KEY, ['tree', 'horizontal', 'outline'], narrow ? 'outline' : 'tree'));
  let editing = $state(false);

  const labels = $derived({
    chief: m.staff_orgchart_global_chief(),
    unknownName: m.staff_orgchart_unknown_name(),
    noGrade: m.sm_org_no_grade(),
  });
  const cards = $derived(buildOrgCards(schema, type, labels));
  const hierarchies = $derived(schema?.hierarchies ?? []);

  const typeOptions = $derived([
    { value: 'hierarchy' as const, label: m.sm_org_type_hierarchy() },
    { value: 'teams' as const, label: m.sm_org_type_teams() },
    { value: 'grades' as const, label: m.sm_org_type_grades() },
  ]);
  const layoutOptions = $derived([
    { value: 'tree' as const, label: m.sm_org_layout_tree() },
    { value: 'horizontal' as const, label: m.sm_org_layout_horizontal() },
    { value: 'outline' as const, label: m.sm_org_layout_outline() },
  ]);

  // Le bot verifie les memes droits : un pole ou un grade releve des grades, un membre de l'annuaire.
  const canMovePoles = $derived(staff.canConfigureRoles && type === 'hierarchy');
  const canMoveGrades = $derived(staff.canConfigureRoles && type !== 'grades');
  const canMoveMembers = $derived(staff.canConfigureDirectory);
  const canEditView = $derived(canMovePoles || canMoveGrades || canMoveMembers);
  const editHelp = $derived(
    type === 'hierarchy' ? m.sm_org_edit_help_hierarchy()
      : type === 'teams' ? m.sm_org_edit_help_teams()
      : m.sm_org_edit_help_grades(),
  );

  $effect(() => {
    if (!canEditView) editing = false;
  });

  // ── Glisser-deposer ──
  type Drag =
    | { kind: 'pole'; id: string }
    | { kind: 'grade'; id: string; roleId: string; hierarchyId: string }
    | { kind: 'member'; id: string; member: OrgMember };

  let drag = $state<Drag | null>(null);
  let overCardTarget = $state<{ card: OrgCard; position: DropPosition } | null>(null);
  let overSectionTarget = $state<OrgSection | null>(null);

  const parentOf = (id: string | null) => hierarchies.find((h) => h.id === id)?.parentHierarchyId ?? null;

  function begin(event: DragEvent, next: Drag) {
    event.stopPropagation();
    // Firefox n'ouvre pas le glisser sans donnee.
    event.dataTransfer?.setData('text/plain', next.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    drag = next;
  }

  function endDrag() {
    drag = null;
    overCardTarget = null;
    overSectionTarget = null;
  }

  /** Bords de la carte : a cote. Centre : dedans. L'axe suit la disposition des freres. */
  function polePosition(event: DragEvent, element: HTMLElement): DropPosition {
    const rect = element.getBoundingClientRect();
    const ratio = layout === 'tree'
      ? (event.clientX - rect.left) / rect.width
      : (event.clientY - rect.top) / rect.height;
    return ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'inside';
  }

  function cardTarget(event: DragEvent, card: OrgCard): DropPosition | null {
    if (drag?.kind === 'grade') {
      return card.kind === 'pole' && card.hierarchyId !== drag.hierarchyId ? 'inside' : null;
    }
    if (drag?.kind !== 'pole' || card.id === drag.id) return null;
    if (card.kind === 'chief') return 'inside';
    if (card.kind !== 'pole') return null;
    const position = polePosition(event, event.currentTarget as HTMLElement);
    const parentId = position === 'inside' ? card.id : parentOf(card.id);
    return canAttach(hierarchies, drag.id, parentId) ? position : null;
  }

  function sectionAccepts(section: OrgSection): boolean {
    if (!section.roleId) return false;
    if (drag?.kind === 'member') return section.roleId !== drag.member.roleId || section.hierarchyId !== drag.member.hierarchyId;
    return drag?.kind === 'grade' && section.roleId !== drag.roleId;
  }

  async function movePole(id: string, target: OrgCard, position: DropPosition) {
    if (target.kind === 'chief') return staff.moveHierarchy(id, null);
    if (position === 'inside') return staff.moveHierarchy(id, target.id);
    const parentId = parentOf(target.id);
    const order = siblingsOf(hierarchies, parentId).filter((sibling) => sibling !== id);
    const beforeId = position === 'before' ? target.id : order[order.indexOf(target.id) + 1];
    return staff.moveHierarchy(id, parentId, beforeId);
  }

  function gradeName(section: OrgSection): string {
    const hierarchy = hierarchies.find((h) => h.id === section.hierarchyId);
    return hierarchy?.roles.find((role) => role.id === section.roleId)?.name ?? section.title;
  }

  function dropHere(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    const current = drag;
    const onCard = overCardTarget;
    const onSection = overSectionTarget;
    endDrag();
    if (!current) return;
    if (current.kind === 'member' && onSection?.roleId) {
      void staff.moveMemberToGrade(current.member, onSection, gradeName(onSection));
    } else if (current.kind === 'grade' && onSection?.roleId) {
      void staff.moveRoleToHierarchy(current.roleId, { beforeRoleId: onSection.roleId, hierarchyId: onSection.hierarchyId });
    } else if (current.kind === 'grade' && onCard?.card.hierarchyId) {
      void staff.moveRoleToHierarchy(current.roleId, { hierarchyId: onCard.card.hierarchyId });
    } else if (current.kind === 'pole' && onCard) {
      void movePole(current.id, onCard.card, onCard.position);
    }
  }

  // ── Deplacement sans glisser ──
  type Picker =
    | { kind: 'pole'; id: string; name: string }
    | { kind: 'grade'; roleId: string; hierarchyId: string; name: string }
    | { kind: 'member'; member: OrgMember };

  const TOP_LEVEL = 'top';
  let picker = $state<Picker | null>(null);
  let pickedId = $state<string | null>(null);

  const pickerOptions = $derived.by(() => {
    if (picker?.kind === 'pole') {
      const id = picker.id;
      return [
        { id: TOP_LEVEL, name: m.sm_org_dialog_top() },
        ...hierarchies.filter((h) => canAttach(hierarchies, id, h.id)).map((h) => ({ id: h.id, name: h.name, color: h.color })),
      ];
    }
    if (picker?.kind === 'grade') {
      const from = picker.hierarchyId;
      return hierarchies.filter((h) => h.id !== from).map((h) => ({ id: h.id, name: h.name, color: h.color }));
    }
    if (picker?.kind === 'member') {
      const { hierarchyId, roleId } = picker.member;
      return hierarchies.flatMap((h) => h.roles
        .filter((role) => !(h.id === hierarchyId && role.id === roleId))
        .map((role) => ({ id: `${h.id}:${role.id}`, name: `${h.name} / ${role.name}`, color: role.color ?? h.color })));
    }
    return [];
  });

  const pickerName = $derived(picker?.kind === 'member' ? picker.member.name : (picker?.name ?? ''));
  const pickerField = $derived(
    picker?.kind === 'pole' ? m.sm_org_dialog_field_pole()
      : picker?.kind === 'grade' ? m.sm_org_dialog_field_target_pole()
      : m.sm_org_dialog_field_grade(),
  );

  function openPicker(next: Picker) {
    pickedId = null;
    picker = next;
  }

  function confirmPicker() {
    const current = picker;
    const picked = pickedId;
    picker = null;
    if (!current || !picked) return;
    if (current.kind === 'pole') {
      void staff.moveHierarchy(current.id, picked === TOP_LEVEL ? null : picked);
    } else if (current.kind === 'grade') {
      void staff.moveRoleToHierarchy(current.roleId, { hierarchyId: picked });
    } else {
      const [hierarchyId, roleId] = picked.split(':');
      const hierarchy = hierarchies.find((h) => h.id === hierarchyId);
      const role = hierarchy?.roles.find((entry) => entry.id === roleId);
      if (!role) return;
      const section: OrgSection = { id: role.id, roleId: role.id, hierarchyId, title: role.name, color: null, lead: false, members: [] };
      void staff.moveMemberToGrade(current.member, section, role.name);
    }
  }

  function nudge(card: OrgCard, direction: -1 | 1) {
    const parentId = parentOf(card.id);
    const order = siblingsOf(hierarchies, parentId);
    const index = order.indexOf(card.id);
    if (direction < 0 ? index === 0 : index === order.length - 1) return;
    void staff.moveHierarchy(card.id, parentId, order[direction < 0 ? index - 1 : index + 2]);
  }

  const ctrl: OrgControls = {
    get editing() { return editing; },
    get openCase() { return openCase; },
    get canDragMember() { return editing && canMoveMembers; },
    canDragCard: (card) => editing && canMovePoles && card.kind === 'pole',
    canDragSection: (section) => editing && canMoveGrades && !!section.roleId,
    dropCard: (card) => (overCardTarget?.card.id === card.id ? overCardTarget.position : null),
    dropSection: (section) => overSectionTarget?.id === section.id,
    isDragged: (id) => drag?.id === id,
    startCard: (event, card) => begin(event, { kind: 'pole', id: card.id }),
    startSection: (event, section) => begin(event, { kind: 'grade', id: section.id, roleId: section.roleId!, hierarchyId: section.hierarchyId }),
    startMember: (event, member) => begin(event, { kind: 'member', id: member.userId, member }),
    overCard: (event, card) => {
      const position = cardTarget(event, card);
      overSectionTarget = null;
      overCardTarget = position ? { card, position } : null;
      if (position) event.preventDefault();
    },
    overSection: (event, section) => {
      if (!sectionAccepts(section)) return;
      event.preventDefault();
      event.stopPropagation();
      overCardTarget = null;
      overSectionTarget = section;
    },
    drop: dropHere,
    end: endDrag,
    cardMenu: (card) => {
      if (card.kind !== 'pole' || !canMovePoles) return [];
      return [
        { label: m.sm_org_move_before(), icon: layout === 'tree' ? 'arrow-left' : 'arrow-up', onselect: () => nudge(card, -1) },
        { label: m.sm_org_move_after(), icon: layout === 'tree' ? 'arrow-right' : 'arrow-down', onselect: () => nudge(card, 1) },
        { label: m.sm_org_move_attach(), icon: 'corner-down-right', onselect: () => openPicker({ kind: 'pole', id: card.id, name: card.title }) },
      ];
    },
    sectionMenu: (section) => {
      if (!canMoveGrades || !section.roleId) return [];
      const roleId = section.roleId;
      return [{
        label: m.sm_org_move_to_pole(),
        icon: 'corner-down-right',
        onselect: () => openPicker({ kind: 'grade', roleId, hierarchyId: section.hierarchyId, name: section.title }),
      }];
    },
    memberMenu: (member) => (canMoveMembers
      ? [{ label: m.sm_org_move_to_grade(), icon: 'corner-down-right', onselect: () => openPicker({ kind: 'member', member }) }]
      : []),
  };

  // ── Export ──
  const fileName = $derived(m.sm_org_export_file());

  async function exportImage(format: 'png' | 'svg') {
    const { source, width, height } = orgChartSvg(cards, layout, m.staff_orgchart_no_member());
    try {
      if (format === 'svg') downloadSvg(source, fileName, 'organigramme');
      else await downloadSvgAsPng(source, width, height, fileName, 'organigramme');
    } catch {
      toast.error(m.sm_org_export_error());
    }
  }

  async function exportSheet() {
    const rows = orgRows(schema, labels, {
      pole: m.sm_org_col_pole(),
      parent: m.sm_org_col_parent(),
      grade: m.sm_org_col_grade(),
      member: m.sm_org_col_member(),
      id: m.sm_org_col_id(),
    });
    if (!(await downloadSingleSheetXlsx(fileName, m.sm_tab_org(), rows).catch(() => false))) toast.error(m.sm_org_export_error());
  }

  const exportItems: MenuItem[] = $derived([
    { label: m.sm_org_export_png(), description: m.sm_org_export_png_desc(), icon: 'image', onselect: () => void exportImage('png') },
    { label: m.sm_org_export_svg(), description: m.sm_org_export_svg_desc(), icon: 'file', onselect: () => void exportImage('svg') },
    { label: m.sm_org_export_xlsx(), description: m.sm_org_export_xlsx_desc(), icon: 'table', onselect: () => void exportSheet() },
  ]);
</script>

{#if cards.length === 0}
  <EmptyState
    icon="git-branch"
    title={m.staff_orgchart_empty_title()}
    description={m.staff_orgchart_empty_desc()}
    reason="instruction"
  />
{:else}
  <div class="space-y-3">
    <div class="flex flex-wrap items-center gap-x-5 gap-y-2">
      <div class="flex items-center gap-2">
        <span class="text-xs text-on-surface-variant">{m.sm_org_type_label()}</span>
        <FilterPills
          label={m.sm_org_type_label()}
          options={typeOptions}
          value={type}
          onchange={(value) => { type = value; remember(TYPE_KEY, value); }}
        />
      </div>
      <div class="flex items-center gap-2">
        <span class="text-xs text-on-surface-variant">{m.sm_org_layout_label()}</span>
        <FilterPills
          label={m.sm_org_layout_label()}
          options={layoutOptions}
          value={layout}
          onchange={(value) => { layout = value; remember(LAYOUT_KEY, value); }}
        />
      </div>
      <div class="ml-auto flex items-center gap-2">
        {#if staff.canConfigureRoles || staff.canConfigureDirectory}
          <Button
            size="sm"
            variant={editing ? 'primary' : 'secondary'}
            icon={editing ? 'check' : 'git-branch'}
            disabled={!canEditView}
            disabledReason={m.sm_org_edit_unavailable()}
            onclick={() => (editing = !editing)}
          >
            {editing ? m.sm_org_edit_done() : m.sm_org_edit()}
          </Button>
        {/if}
        <Menu items={exportItems} label={m.sm_org_export()} icon="download" text={m.sm_org_export_short()} />
      </div>
    </div>

    {#if editing}
      <p class="text-sm text-on-surface-variant">{editHelp}</p>
    {/if}

    <div class="org-canvas section-card-flush" class:is-editing={editing}>
      <ul class="org-tree org-{layout}">
        {#each cards as card (card.id)}
          <OrgNode {card} {ctrl} />
        {/each}
      </ul>
    </div>
  </div>
{/if}

<Modal open={!!picker} onClose={() => (picker = null)} title={m.sm_org_dialog_title({ name: pickerName })}>
  <div class="space-y-4">
    <div class="field">
      <span class="field-label">{pickerField}</span>
      <SearchableSelect
        value={pickedId}
        options={pickerOptions}
        className="w-full"
        on:change={(event: CustomEvent) => (pickedId = event.detail?.value ?? null)}
      />
    </div>
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => (picker = null)}>{m.common_cancel()}</Button>
      <Button variant="primary" disabled={!pickedId} onclick={confirmPicker}>{m.sm_org_dialog_confirm()}</Button>
    </div>
  </div>
</Modal>

<style>
  .org-canvas {
    padding: 1.5rem;
    overflow: auto;
    max-height: 75vh;
  }

  .org-tree,
  .org-tree :global(ul) {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .org-tree :global(.org-card) {
    position: relative;
    width: 15.5rem;
    padding: 0.75rem;
    border: 1px solid var(--outline-variant);
    border-radius: var(--radius-lg, 0.75rem);
    background: var(--surface-container-low);
    transition: border-color 0.15s, box-shadow 0.15s, opacity 0.15s;
  }

  .org-tree :global(.org-section) {
    padding: 0.25rem 0.375rem;
    border-radius: var(--radius-md, 0.5rem);
  }

  .org-tree :global(.org-member) {
    display: flex;
    flex: 1;
    min-width: 0;
    align-items: center;
    gap: 0.5rem;
    padding: 0.125rem 0.25rem;
    border-radius: var(--radius-sm, 0.25rem);
    font-size: 0.75rem;
    text-align: left;
    color: var(--on-surface);
  }

  /* Reorganisation */
  .org-tree :global(.is-movable) {
    cursor: grab;
  }
  .org-tree :global(.is-dragged) {
    opacity: 0.4;
  }
  .org-tree :global(.drop-inside) {
    border-color: var(--primary-color);
    box-shadow: 0 0 0 1px var(--primary-color);
  }
  .org-tree :global(.org-section.drop-inside) {
    background: color-mix(in srgb, var(--primary-color) 10%, transparent);
    box-shadow: inset 0 0 0 1px var(--primary-color);
  }

  /* Arbre */
  .org-tree.org-tree {
    width: max-content;
    min-width: 100%;
  }
  .org-tree:not(.org-outline),
  .org-tree :global(.org-children) {
    display: flex;
    justify-content: center;
  }
  .org-tree:not(.org-outline) {
    gap: 1.5rem;
  }
  .org-tree :global(.org-branch) {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .org-tree.org-tree :global(.org-members > li) {
    display: flex;
  }
  .org-tree :global(.org-children) {
    position: relative;
    padding-top: 1.5rem;
  }
  .org-tree :global(.org-children::before) {
    content: '';
    position: absolute;
    top: 0;
    left: 50%;
    height: 1.5rem;
    border-left: 1px solid var(--outline-variant);
  }
  .org-tree :global(.org-children > .org-branch) {
    position: relative;
    padding: 1.5rem 0.625rem 0;
  }
  .org-tree :global(.org-children > .org-branch::before),
  .org-tree :global(.org-children > .org-branch::after) {
    content: '';
    position: absolute;
    top: 0;
    width: 50%;
    height: 1.5rem;
    border-top: 1px solid var(--outline-variant);
  }
  .org-tree :global(.org-children > .org-branch::before) {
    right: 50%;
  }
  .org-tree :global(.org-children > .org-branch::after) {
    left: 50%;
    border-left: 1px solid var(--outline-variant);
  }
  .org-tree :global(.org-children > .org-branch:first-child::before),
  .org-tree :global(.org-children > .org-branch:last-child::after) {
    border-top: 0;
  }
  .org-tree :global(.org-children > .org-branch:last-child:not(:first-child)::before) {
    border-right: 1px solid var(--outline-variant);
  }
  .org-tree :global(.org-children > .org-branch:last-child:not(:first-child)::after) {
    border-left: 0;
  }
  .org-tree.org-tree :global(.org-children > .org-branch:only-child::after) {
    border-top: 0;
  }
  .org-tree.org-tree :global(.org-children > .org-branch:only-child::before) {
    display: none;
  }
  .org-tree :global(.drop-before) {
    box-shadow: -3px 0 0 var(--primary-color);
  }
  .org-tree :global(.drop-after) {
    box-shadow: 3px 0 0 var(--primary-color);
  }

  /* Horizontal */
  .org-horizontal.org-horizontal {
    flex-direction: column;
    align-items: flex-start;
  }
  .org-horizontal :global(.org-branch) {
    flex-direction: row;
  }
  .org-horizontal.org-horizontal :global(.org-children) {
    flex-direction: column;
    padding: 0 0 0 1.5rem;
  }
  .org-horizontal.org-horizontal :global(.org-children::before) {
    top: 50%;
    left: 0;
    width: 1.5rem;
    height: 0;
    border-left: 0;
    border-top: 1px solid var(--outline-variant);
  }
  .org-horizontal.org-horizontal :global(.org-children > .org-branch) {
    padding: 0.625rem 0 0.625rem 1.5rem;
  }
  .org-horizontal.org-horizontal :global(.org-children > .org-branch::before),
  .org-horizontal.org-horizontal :global(.org-children > .org-branch::after) {
    display: block;
    left: 0;
    right: auto;
    width: 1.5rem;
    height: 50%;
    border-top: 0;
    border-right: 0;
    border-left: 1px solid var(--outline-variant);
  }
  .org-horizontal.org-horizontal :global(.org-children > .org-branch::before) {
    top: 0;
    border-bottom: 1px solid var(--outline-variant);
  }
  .org-horizontal.org-horizontal :global(.org-children > .org-branch::after) {
    top: 50%;
  }
  .org-horizontal.org-horizontal :global(.org-children > .org-branch:first-child::before),
  .org-horizontal.org-horizontal :global(.org-children > .org-branch:last-child::after) {
    border-left: 0;
  }
  .org-horizontal.org-horizontal :global(.org-children > .org-branch:last-child:not(:first-child)::before) {
    border-right: 0;
  }
  .org-horizontal.org-horizontal :global(.org-children > .org-branch:only-child) {
    padding-left: 0;
  }
  .org-horizontal.org-horizontal :global(.org-children > .org-branch:only-child::before),
  .org-horizontal.org-horizontal :global(.org-children > .org-branch:only-child::after) {
    display: none;
  }
  .org-horizontal :global(.drop-before),
  .org-outline :global(.drop-before) {
    box-shadow: 0 -3px 0 var(--primary-color);
  }
  .org-horizontal :global(.drop-after),
  .org-outline :global(.drop-after) {
    box-shadow: 0 3px 0 var(--primary-color);
  }

  /* Plan */
  .org-tree.org-outline {
    width: auto;
  }
  .org-outline :global(.org-branch) {
    align-items: stretch;
  }
  .org-outline :global(.org-card) {
    width: 100%;
    max-width: 40rem;
  }
  .org-outline.org-outline :global(.org-children) {
    display: block;
    margin-left: 1rem;
    padding: 0.5rem 0 0 1rem;
    border-left: 1px solid var(--outline-variant);
  }
  .org-outline.org-outline :global(.org-children::before),
  .org-outline.org-outline :global(.org-children > .org-branch::before),
  .org-outline.org-outline :global(.org-children > .org-branch::after) {
    display: none;
  }
  .org-outline.org-outline :global(.org-children > .org-branch) {
    padding: 0 0 0.5rem;
  }
  .org-outline > :global(.org-branch + .org-branch) {
    margin-top: 0.5rem;
  }

  @media (prefers-reduced-motion: reduce) {
    .org-tree :global(.org-card) {
      transition: none;
    }
  }
</style>
