<!--
  Canvas libre de l'organigramme. Les cartes sont les vrais poles ; leur position,
  les cadres et les traits decoratifs sont enregistres a part (/staff/org-canvas).
  Seul le « rattachement » touche aux donnees : il change le parent reel du pole
  (staff.moveHierarchy) et apparait comme un trait plein relie aux deux cartes.

  Deplacer une carte ou un cadre se fait a la souris, au doigt ou aux fleches du clavier.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '../ui';
  import { fetchOrgCanvas, saveOrgCanvas } from '../../api/hierarchies';
  import { canAttach, type HierarchySchema, type SchemaHierarchy } from './orgChartModel';
  import { staff } from './staffStore.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { m } from '../../i18n';

  type LinkStyle = 'dashed' | 'ochre';
  type Frame = { id: string; label: string; x: number; y: number; w: number; h: number; color: string | null; dashed: boolean };
  type Link = { id: string; from: string; to: string; style: LinkStyle; linked: boolean };
  type Canvas = { nodes: Record<string, { x: number; y: number }>; frames: Frame[]; links: Link[] };

  const { schema }: { schema: HierarchySchema | null } = $props();

  const CARD_W = 200;
  const CARD_H = 84;
  const STAGE_W = 3000;
  const STAGE_H = 1800;
  const OCHRE = '#c9a227';

  let canvas = $state<Canvas>({ nodes: {}, frames: [], links: [] });
  let loaded = $state(false);
  const canEdit = $derived(staff.canConfigureRoles);

  const hierarchies = $derived(schema?.hierarchies ?? []);
  const byId = $derived(new Map(hierarchies.map((h) => [h.id, h])));

  // ── Chargement et enregistrement ──────────────────────────
  onMount(() => {
    void fetchOrgCanvas()
      .then((res) => { if (res?.canvas) canvas = res.canvas; })
      .catch(() => null)
      .finally(() => { loaded = true; });
    return () => clearTimeout(saveTimer);
  });

  let saveTimer: ReturnType<typeof setTimeout>;
  function persist() {
    if (!canEdit) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void saveOrgCanvas($state.snapshot(canvas)).catch(() => toast.error(m.sm_canvas_save_error()));
    }, 600);
  }

  // ── Positions ─────────────────────────────────────────────
  /** Position par defaut d'une carte jamais deplacee : une rangee par niveau. */
  const autoPositions = $derived.by(() => {
    const depthOf = (h: SchemaHierarchy): number => {
      let depth = 0;
      let cursor: SchemaHierarchy | undefined = h;
      while (cursor?.parentHierarchyId && depth < 20) {
        cursor = byId.get(cursor.parentHierarchyId);
        depth++;
      }
      return depth;
    };
    const perRow = new Map<number, number>();
    const out = new Map<string, { x: number; y: number }>();
    for (const h of hierarchies) {
      const depth = depthOf(h);
      const index = perRow.get(depth) ?? 0;
      perRow.set(depth, index + 1);
      out.set(h.id, { x: 40 + index * (CARD_W + 40), y: 40 + depth * (CARD_H + 70) });
    }
    return out;
  });
  const posOf = (id: string) => canvas.nodes[id] ?? autoPositions.get(id) ?? { x: 40, y: 40 };

  // ── Traits ────────────────────────────────────────────────
  type Edge = { key: string; from: string; to: string; style: LinkStyle | 'parent'; linkId?: string };
  const edges = $derived.by<Edge[]>(() => {
    const real = hierarchies
      .filter((h) => h.parentHierarchyId && byId.has(h.parentHierarchyId))
      .map((h) => ({ key: `p:${h.id}`, from: h.parentHierarchyId!, to: h.id, style: 'parent' as const }));
    const deco = canvas.links
      .filter((l) => byId.has(l.from) && byId.has(l.to))
      .map((l) => ({ key: l.id, from: l.from, to: l.to, style: l.style, linkId: l.id }));
    return [...real, ...deco];
  });

  function path(edge: Edge): string {
    const a = posOf(edge.from);
    const b = posOf(edge.to);
    const ax = a.x + CARD_W / 2;
    const bx = b.x + CARD_W / 2;
    // Du bas de la carte parente vers le haut de l'enfant ; a l'horizontale si elles sont cote a cote.
    if (b.y > a.y + CARD_H) {
      const ay = a.y + CARD_H;
      const mid = (ay + b.y) / 2;
      return `M${ax},${ay} V${mid} H${bx} V${b.y}`;
    }
    if (a.y > b.y + CARD_H) {
      const by = b.y + CARD_H;
      const mid = (by + a.y) / 2;
      return `M${ax},${a.y} V${mid} H${bx} V${by}`;
    }
    const left = a.x < b.x;
    const y = a.y + CARD_H / 2;
    return `M${left ? a.x + CARD_W : a.x},${y} H${left ? b.x : b.x + CARD_W}`;
  }

  const strokeFor = (style: Edge['style']) =>
    style === 'dashed' ? { color: 'var(--color-on-surface-variant, #9ca3af)', dash: '6 6' }
      : style === 'ochre' ? { color: OCHRE, dash: '' }
      : { color: 'var(--color-primary, #8b9cff)', dash: '' };

  // ── Glisser ───────────────────────────────────────────────
  type Drag =
    | { kind: 'node'; id: string; dx: number; dy: number }
    | { kind: 'frame'; id: string; dx: number; dy: number }
    | { kind: 'resize'; id: string };
  let drag: Drag | null = null;
  let stage: HTMLDivElement | undefined = $state();

  function stagePoint(event: PointerEvent) {
    const rect = stage!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function startDrag(event: PointerEvent, next: Drag) {
    if (!canEdit || linking) return;
    drag = next;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }
  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, Math.round(value)));

  function onMove(event: PointerEvent) {
    if (!drag) return;
    const p = stagePoint(event);
    if (drag.kind === 'node') {
      canvas.nodes[drag.id] = { x: clamp(p.x - drag.dx, STAGE_W - CARD_W), y: clamp(p.y - drag.dy, STAGE_H - CARD_H) };
    } else {
      const frame = canvas.frames.find((f) => f.id === drag!.id);
      if (!frame) return;
      if (drag.kind === 'frame') {
        frame.x = clamp(p.x - drag.dx, STAGE_W - frame.w);
        frame.y = clamp(p.y - drag.dy, STAGE_H - frame.h);
      } else {
        frame.w = Math.max(80, clamp(p.x - frame.x, STAGE_W));
        frame.h = Math.max(60, clamp(p.y - frame.y, STAGE_H));
      }
    }
  }
  function endDrag() {
    if (!drag) return;
    drag = null;
    persist();
  }

  function startNode(event: PointerEvent, id: string) {
    if (linking) return;
    const p = stagePoint(event);
    const pos = posOf(id);
    // La position auto devient reelle des le premier deplacement.
    canvas.nodes[id] = pos;
    startDrag(event, { kind: 'node', id, dx: p.x - pos.x, dy: p.y - pos.y });
  }
  function startFrame(event: PointerEvent, frame: Frame) {
    const p = stagePoint(event);
    startDrag(event, { kind: 'frame', id: frame.id, dx: p.x - frame.x, dy: p.y - frame.y });
  }

  function nudge(event: KeyboardEvent, id: string) {
    const step = event.shiftKey ? 40 : 10;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta || !canEdit) return;
    event.preventDefault();
    const pos = posOf(id);
    canvas.nodes[id] = { x: clamp(pos.x + delta[0], STAGE_W - CARD_W), y: clamp(pos.y + delta[1], STAGE_H - CARD_H) };
    persist();
  }

  // ── Creation ──────────────────────────────────────────────
  let creating = $state<{ kind: 'pole' | 'frame'; parentId: string | null } | null>(null);
  let newName = $state('');

  function openCreate(kind: 'pole' | 'frame', parentId: string | null = null) {
    creating = { kind, parentId };
    newName = '';
  }

  async function submitCreate() {
    const name = newName.trim();
    if (!creating || !name) return;
    if (creating.kind === 'frame') {
      const n = canvas.frames.length;
      canvas.frames.push({ id: crypto.randomUUID(), label: name, x: 30 + n * 20, y: 30 + n * 20, w: 420, h: 220, color: null, dashed: false });
      persist();
    } else {
      const parent = creating.parentId;
      const ok = await staff.saveHierarchy(
        { name, description: null, color: '#6366f1', icon: null, discordRoleId: null, responsableUserId: null, parentHierarchyId: parent },
        null,
      );
      if (!ok) return;
    }
    creating = null;
  }

  // ── Relier deux poles ─────────────────────────────────────
  let linking = $state(false);
  let linkFrom = $state<string | null>(null);
  let linkPick = $state<{ from: string; to: string } | null>(null);

  function toggleLinking() {
    linking = !linking;
    linkFrom = null;
    linkPick = null;
  }

  function pickCard(id: string) {
    if (!linking) return;
    if (!linkFrom) { linkFrom = id; return; }
    if (linkFrom === id) { linkFrom = null; return; }
    linkPick = { from: linkFrom, to: id };
  }

  async function applyLink(style: LinkStyle | 'parent') {
    const pick = linkPick;
    linkPick = null;
    linkFrom = null;
    linking = false;
    if (!pick) return;
    if (style === 'parent') {
      if (!canAttach(hierarchies, pick.to, pick.from)) { toast.error(m.sm_err_reorder()); return; }
      await staff.moveHierarchy(pick.to, pick.from);
      return;
    }
    canvas.links.push({ id: crypto.randomUUID(), from: pick.from, to: pick.to, style, linked: false });
    persist();
  }

  function removeEdge(edge: Edge) {
    if (!canEdit) return;
    if (edge.style === 'parent') {
      void staff.moveHierarchy(edge.to, null);
      return;
    }
    canvas.links = canvas.links.filter((l) => l.id !== edge.linkId);
    persist();
  }

  function removeFrame(id: string) {
    canvas.frames = canvas.frames.filter((f) => f.id !== id);
    persist();
  }
  function toggleFrameDashed(frame: Frame) {
    frame.dashed = !frame.dashed;
    persist();
  }

  const styleChoices = $derived([
    { id: 'parent' as const, label: m.sm_canvas_style_parent() },
    { id: 'dashed' as const, label: m.sm_canvas_style_dashed() },
    { id: 'ochre' as const, label: m.sm_canvas_style_ochre() },
  ]);
</script>

<div class="space-y-3">
  <p class="max-w-prose text-sm text-on-surface-variant">{canEdit ? m.sm_canvas_help() : m.sm_canvas_readonly()}</p>

  {#if canEdit}
    <div class="flex flex-wrap items-center gap-2">
      <Button size="sm" icon="plus" onclick={() => openCreate('pole')}>{m.sm_canvas_add_pole()}</Button>
      <Button size="sm" icon="square" onclick={() => openCreate('frame')}>{m.sm_canvas_add_frame()}</Button>
      <Button size="sm" variant={linking ? 'primary' : 'secondary'} icon="git-branch" onclick={toggleLinking}>
        {linking ? m.sm_canvas_link_cancel() : m.sm_canvas_link()}
      </Button>
      {#if linking && !linkPick}
        <span class="text-xs text-on-surface-variant" role="status">{linkFrom ? m.sm_canvas_link_pick_to() : m.sm_canvas_link_pick_from()}</span>
      {/if}
    </div>

    {#if creating}
      <form class="flex flex-wrap items-center gap-2" onsubmit={(e) => { e.preventDefault(); void submitCreate(); }}>
        <input
          class="input-field w-64"
          bind:value={newName}
          maxlength="60"
          placeholder={creating.kind === 'frame' ? m.sm_canvas_frame_placeholder() : m.sm_canvas_name_placeholder()}
          aria-label={creating.kind === 'frame' ? m.sm_canvas_frame_placeholder() : m.sm_canvas_name_placeholder()}
        />
        <Button size="sm" variant="primary" type="submit" disabled={!newName.trim()}>{m.sm_canvas_create()}</Button>
        <Button size="sm" onclick={() => (creating = null)}>{m.sm_canvas_link_cancel()}</Button>
      </form>
    {/if}

    {#if linkPick}
      <div class="section-card flex flex-wrap gap-2 p-3" role="group" aria-label={m.sm_canvas_link()}>
        {#each styleChoices as choice (choice.id)}
          <Button size="sm" onclick={() => applyLink(choice.id)}>{choice.label}</Button>
        {/each}
        <Button size="sm" onclick={toggleLinking}>{m.sm_canvas_link_cancel()}</Button>
      </div>
    {/if}
  {/if}

  <div class="section-card max-h-[75vh] overflow-auto p-0" aria-busy={!loaded}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={stage}
      class="relative touch-none"
      style="width:{STAGE_W}px;height:{STAGE_H}px"
      onpointermove={onMove}
      onpointerup={endDrag}
      onpointercancel={endDrag}
    >
      {#each canvas.frames as frame (frame.id)}
        {@const tint = frame.color ?? 'var(--color-primary, #8b9cff)'}
        <div
          class="absolute rounded-xl"
          style="left:{frame.x}px;top:{frame.y}px;width:{frame.w}px;height:{frame.h}px;border:1.5px {frame.dashed ? 'dashed' : 'solid'} {tint};background:color-mix(in srgb, {tint} 6%, transparent)"
        >
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="flex items-center justify-between gap-2 px-3 py-1 text-xs font-semibold uppercase tracking-wide {canEdit ? 'cursor-grab' : ''}"
            style="color:{tint}"
            onpointerdown={(e) => startFrame(e, frame)}
          >
            <span class="truncate">{frame.label}</span>
            {#if canEdit}
              <span class="flex gap-1 normal-case">
                <button type="button" class="rounded px-1 hover:bg-surface-container-high" title={m.sm_canvas_frame_dashed()} aria-label={m.sm_canvas_frame_dashed()} onpointerdown={(e) => e.stopPropagation()} onclick={() => toggleFrameDashed(frame)}>┄</button>
                <button type="button" class="rounded px-1 hover:bg-surface-container-high" title={m.sm_canvas_remove_frame()} aria-label={m.sm_canvas_remove_frame()} onpointerdown={(e) => e.stopPropagation()} onclick={() => removeFrame(frame.id)}>✕</button>
              </span>
            {/if}
          </div>
          {#if canEdit}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize rounded-tl"
              style="background:{tint};opacity:.5"
              title={m.sm_canvas_resize()}
              onpointerdown={(e) => startDrag(e, { kind: 'resize', id: frame.id })}
            ></div>
          {/if}
        </div>
      {/each}

      <svg class="pointer-events-none absolute inset-0" width={STAGE_W} height={STAGE_H} aria-hidden="true">
        {#each edges as edge (edge.key)}
          {@const s = strokeFor(edge.style)}
          <path d={path(edge)} fill="none" stroke={s.color} stroke-width="2" stroke-dasharray={s.dash} stroke-linejoin="round" />
          {#if canEdit}
            <!-- Zone de clic large : un clic sur le trait le supprime ou le detache.
                 Au clavier, la vue Organigramme garde le menu de deplacement de chaque carte. -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <path class="pointer-events-auto cursor-pointer" d={path(edge)} fill="none" stroke="transparent" stroke-width="14" onclick={() => removeEdge(edge)}>
              <title>{edge.style === 'parent' ? m.sm_canvas_detach() : m.sm_canvas_remove_link()}</title>
            </path>
          {/if}
        {/each}
      </svg>

      {#each hierarchies as h (h.id)}
        {@const pos = posOf(h.id)}
        {@const accent = h.color || '#6366f1'}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div
          class="absolute flex flex-col justify-center rounded-xl border bg-surface-container px-3 py-2 shadow-sm {linkFrom === h.id ? 'ring-2 ring-primary' : ''} {canEdit && !linking ? 'cursor-grab' : ''} {linking ? 'cursor-pointer' : ''}"
          style="left:{pos.x}px;top:{pos.y}px;width:{CARD_W}px;height:{CARD_H}px;border-color:{accent};box-shadow:0 0 0 1px color-mix(in srgb, {accent} 35%, transparent)"
          role={linking ? 'button' : 'group'}
          tabindex={canEdit ? 0 : undefined}
          aria-label={h.name}
          onpointerdown={(e) => (linking ? pickCard(h.id) : startNode(e, h.id))}
          onkeydown={(e) => (linking && (e.key === 'Enter' || e.key === ' ') ? (e.preventDefault(), pickCard(h.id)) : nudge(e, h.id))}
        >
          <div class="flex items-center gap-2">
            {#if h.icon}<span aria-hidden="true">{h.icon}</span>{/if}
            <span class="truncate text-sm font-semibold">{h.name}</span>
          </div>
          {#if h.description}
            <span class="truncate text-xs text-on-surface-variant">{h.description}</span>
          {/if}
          <span class="text-xs text-on-surface-variant">{m.sm_canvas_members({ count: h.memberCount })}</span>
          {#if canEdit && !linking}
            <button
              type="button"
              class="absolute -bottom-3 right-2 rounded-full border bg-surface-container-high px-2 text-xs hover:bg-surface-container-highest"
              title={m.sm_canvas_add_subpole()}
              aria-label="{m.sm_canvas_add_subpole()} — {h.name}"
              onpointerdown={(e) => e.stopPropagation()}
              onclick={() => openCreate('pole', h.id)}
            >+</button>
          {/if}
        </div>
      {/each}
    </div>
  </div>

  <div class="section-card flex flex-wrap items-center gap-x-6 gap-y-2 p-3 text-xs text-on-surface-variant">
    <span class="font-semibold text-on-surface">{m.sm_canvas_legend()}</span>
    <span class="flex items-center gap-2"><svg width="32" height="6" aria-hidden="true"><line x1="0" y1="3" x2="32" y2="3" stroke="var(--color-primary, #8b9cff)" stroke-width="2" /></svg>{m.sm_canvas_legend_parent()}</span>
    <span class="flex items-center gap-2"><svg width="32" height="6" aria-hidden="true"><line x1="0" y1="3" x2="32" y2="3" stroke="var(--color-on-surface-variant, #9ca3af)" stroke-width="2" stroke-dasharray="6 6" /></svg>{m.sm_canvas_legend_dashed()}</span>
    <span class="flex items-center gap-2"><svg width="32" height="6" aria-hidden="true"><line x1="0" y1="3" x2="32" y2="3" stroke={OCHRE} stroke-width="2" /></svg>{m.sm_canvas_legend_ochre()}</span>
  </div>
</div>
