<!--
  Tableau d'un tournoi : poules, arbres et finales dans un seul SVG.

  Les couleurs sont écrites en clair, sans variable CSS ni image externe :
  l'export PNG sérialise ce même SVG dans un canevas, qui ne lit ni les
  feuilles de style de la page ni les images d'un autre domaine. L'image
  exportée est donc exactement ce qui est affiché. Le décor sombre est voulu,
  comme sur les pages publiques des classements.
-->
<script lang="ts">
  import type { Tournament, TournamentMatch, TournamentStage } from '../../api/tournaments';
  import { m } from '../../i18n';

  let {
    tournament,
    onMatchClick,
    live = false,
  }: {
    tournament: Tournament;
    /** Absent : tableau en lecture seule (page publique). */
    onMatchClick?: (match: TournamentMatch) => void;
    live?: boolean;
  } = $props();

  const C = {
    bg: '#1c1d21',
    header: '#2a2b30',
    headerText: '#d4d4d8',
    row: '#3a3b41',
    seed: '#4b4c53',
    text: '#f4f4f5',
    muted: '#a1a1aa',
    accent: '#f0803c',
    line: '#8a8a93',
    live: '#ef4444',
    champion: '#facc15',
  };
  const ROW = 24;
  const MATCH_H = ROW * 2 + 1;
  const BOX_W = 210;
  const SEED_W = 24;
  const SCORE_W = 30;
  const COL_GAP = 56;
  const V_GAP = 18;
  const HEAD_H = 30;
  const PAD = 24;
  const SECTION_GAP = 36;
  const TITLE_H = 26;
  const GROUP_W = 330;

  type Placed = { match: TournamentMatch; x: number; y: number };
  type Section = {
    title: string;
    y: number;
    width: number;
    height: number;
    heads: { x: number; label: string }[];
    matches: Placed[];
    lines: string[];
    groups?: { x: number; y: number; stage: TournamentStage; label: string }[];
  };

  const groupLetter = (stageId: string) => String.fromCharCode(65 + Number(stageId.slice(1)));

  function roundLabel(stage: TournamentStage, index: number): string {
    const total = stage.rounds.length;
    if (stage.id === 'L') return m.tn_round_n({ n: index + 1 });
    const fromEnd = total - 1 - index;
    if (fromEnd === 0) return tournament.settings.format === 'DOUBLE' ? m.tn_round_winners_final() : m.tn_round_final();
    if (fromEnd === 1) return m.tn_round_semis();
    if (fromEnd === 2) return m.tn_round_quarters();
    return m.tn_round_n({ n: index + 1 });
  }

  function stageTitle(stage: TournamentStage): string {
    switch (stage.id) {
      case 'W': return tournament.settings.format === 'DOUBLE' ? m.tn_stage_winners() : m.tn_stage_bracket();
      case 'L': return m.tn_stage_losers();
      case 'GF': return m.tn_stage_grand_final();
      case 'P3': return m.tn_stage_third_place();
      case 'PO': return m.tn_stage_playoffs();
      default: return m.tn_stage_groups();
    }
  }

  /** Arbre : une colonne par tour, chaque match centré entre les deux qui l'alimentent. */
  function bracketSection(stage: TournamentStage, top: number): Section {
    const first = Math.max(1, stage.rounds[0]?.length ?? 1);
    const unit = MATCH_H + V_GAP;
    const bodyTop = top + TITLE_H + HEAD_H + 10;
    const bodyH = first * unit;
    const matches: Placed[] = [];
    const lines: string[] = [];
    const heads = stage.rounds.map((_, r) => ({ x: PAD + r * (BOX_W + COL_GAP), label: roundLabel(stage, r) }));
    const centerY = (r: number, i: number) => bodyTop + (i + 0.5) * (bodyH / stage.rounds[r].length);

    stage.rounds.forEach((round, r) => {
      const x = PAD + r * (BOX_W + COL_GAP);
      round.forEach((match, i) => {
        const cy = centerY(r, i);
        matches.push({ match, x, y: cy - MATCH_H / 2 });
        const next = stage.rounds[r + 1];
        if (!next) return;
        // Même nombre de matchs au tour suivant (arbre des perdants) : ligne droite.
        const j = next.length === round.length ? i : Math.floor(i / 2);
        const ny = centerY(r + 1, j);
        const x1 = x + BOX_W;
        const xm = x1 + COL_GAP / 2;
        lines.push(`M${x1} ${cy}H${xm}V${ny}H${x1 + COL_GAP}`);
      });
    });
    return {
      title: stageTitle(stage),
      y: top,
      width: PAD * 2 + stage.rounds.length * BOX_W + (stage.rounds.length - 1) * COL_GAP,
      height: TITLE_H + HEAD_H + 10 + bodyH,
      heads,
      matches,
      lines,
    };
  }

  function groupsSection(stages: TournamentStage[], top: number): Section {
    const perRow = Math.min(3, stages.length);
    const groups: Section['groups'] = [];
    let rowY = top + TITLE_H;
    let height = TITLE_H;
    for (let i = 0; i < stages.length; i += perRow) {
      const slice = stages.slice(i, i + perRow);
      const rowH = Math.max(...slice.map((s) => HEAD_H + (s.table?.length ?? 0) * ROW + 8));
      slice.forEach((stage, k) => groups.push({ x: PAD + k * (GROUP_W + COL_GAP / 2), y: rowY, stage, label: m.tn_group_name({ name: groupLetter(stage.id) }) }));
      rowY += rowH + V_GAP;
      height += rowH + V_GAP;
    }
    return {
      title: m.tn_stage_groups(),
      y: top,
      width: PAD * 2 + perRow * GROUP_W + (perRow - 1) * (COL_GAP / 2),
      height,
      heads: [],
      matches: [],
      lines: [],
      groups,
    };
  }

  const layout = $derived.by(() => {
    const sections: Section[] = [];
    let y = PAD + 34;
    const groupStages = tournament.stages.filter((s) => s.kind === 'group');
    if (groupStages.length) {
      const section = groupsSection(groupStages, y);
      sections.push(section);
      y += section.height + SECTION_GAP;
    }
    for (const stage of tournament.stages.filter((s) => s.kind === 'bracket' && s.rounds.length)) {
      const section = bracketSection(stage, y);
      sections.push(section);
      y += section.height + SECTION_GAP;
    }
    const width = Math.max(560, ...sections.map((s) => s.width));
    return { sections, width, height: y - SECTION_GAP + PAD };
  });

  const clickable = (match: TournamentMatch) =>
    !!onMatchClick && !!match.player1 && !!match.player2 && match.status !== 'waiting' && match.status !== 'bye';

  const fit = (text: string, max = 21) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

  let svgEl = $state<SVGSVGElement>();

  /** Télécharge l'état actuel du tableau en PNG (2× pour rester net une fois partagé). */
  export async function exportPng(filename: string) {
    if (!svgEl) return;
    const source = new XMLSerializer().serializeToString(svgEl);
    const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }));
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('svg'));
        image.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = layout.width * 2;
      canvas.height = layout.height * 2;
      const ctx = canvas.getContext('2d')!;
      ctx.scale(2, 2);
      ctx.drawImage(image, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('png');
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${filename.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'tournoi'}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
</script>

{#snippet slot(match: TournamentMatch, side: 1 | 2, x: number, y: number)}
  {@const entrant = side === 1 ? match.player1 : match.player2}
  {@const score = side === 1 ? match.score1 : match.score2}
  {@const won = match.winner === side}
  {@const showScore = match.status === 'done' || match.status === 'live'}
  <rect {x} {y} width={BOX_W} height={ROW} fill={C.row} />
  <rect {x} {y} width={SEED_W} height={ROW} fill={C.seed} />
  {#if entrant}
    <text x={x + SEED_W / 2} y={y + 16} fill={C.muted} font-size="11" text-anchor="middle">{entrant.seed}</text>
  {/if}
  <text x={x + SEED_W + 8} y={y + 16} fill={entrant ? C.text : C.muted} font-size="12.5" font-weight={won ? 600 : 400}>
    {entrant ? fit(entrant.name) : match.status === 'bye' ? '—' : ''}
  </text>
  <rect x={x + BOX_W - SCORE_W} {y} width={SCORE_W} height={ROW} fill={won ? C.accent : C.seed} />
  {#if showScore && entrant}
    <text x={x + BOX_W - SCORE_W / 2} y={y + 16} fill={won ? '#ffffff' : C.text} font-size="12.5" font-weight="600" text-anchor="middle">{score}</text>
  {/if}
{/snippet}

<svg
  bind:this={svgEl}
  xmlns="http://www.w3.org/2000/svg"
  width={layout.width}
  height={layout.height}
  viewBox="0 0 {layout.width} {layout.height}"
  font-family="Inter, 'Segoe UI', system-ui, sans-serif"
  role="img"
  aria-label={tournament.event.title}
  class="max-w-none"
>
  <rect width={layout.width} height={layout.height} fill={C.bg} />
  <text x={PAD} y={PAD + 14} fill={C.text} font-size="18" font-weight="700">{tournament.event.title}</text>
  {#if live}
    <circle cx={layout.width - PAD - 52} cy={PAD + 8} r="5" fill={C.live} />
    <text x={layout.width - PAD} y={PAD + 13} fill={C.text} font-size="13" font-weight="700" text-anchor="end">LIVE</text>
  {:else if tournament.champion}
    <text x={layout.width - PAD} y={PAD + 13} fill={C.champion} font-size="13" font-weight="700" text-anchor="end">🏆 {fit(tournament.champion.name, 28)}</text>
  {/if}

  {#each layout.sections as section}
    <text x={PAD} y={section.y + 16} fill={C.muted} font-size="13" font-weight="600">{section.title}</text>

    {#each section.groups ?? [] as group}
      <rect x={group.x} y={group.y} width={GROUP_W} height={HEAD_H - 4} fill={C.header} />
      <text x={group.x + 10} y={group.y + 17} fill={C.headerText} font-size="12.5" font-weight="600">{group.label}</text>
      <text x={group.x + GROUP_W - 110} y={group.y + 17} fill={C.muted} font-size="11" text-anchor="middle">{m.tn_col_wins_short()}</text>
      <text x={group.x + GROUP_W - 75} y={group.y + 17} fill={C.muted} font-size="11" text-anchor="middle">{m.tn_col_losses_short()}</text>
      <text x={group.x + GROUP_W - 30} y={group.y + 17} fill={C.muted} font-size="11" text-anchor="middle">{m.tn_col_sets_short()}</text>
      {#each group.stage.table ?? [] as row, i}
        {@const ry = group.y + HEAD_H + i * ROW}
        {@const qualified = tournament.settings.groupQualifiers > 0 && row.rank <= tournament.settings.groupQualifiers}
        <rect x={group.x} y={ry} width={GROUP_W} height={ROW - 1} fill={C.row} />
        <rect x={group.x} y={ry} width={SEED_W} height={ROW - 1} fill={qualified ? C.accent : C.seed} />
        <text x={group.x + SEED_W / 2} y={ry + 16} fill={qualified ? '#ffffff' : C.muted} font-size="11" text-anchor="middle">{row.rank}</text>
        <text x={group.x + SEED_W + 8} y={ry + 16} fill={C.text} font-size="12.5">{fit(row.entrant.name, 22)}</text>
        <text x={group.x + GROUP_W - 110} y={ry + 16} fill={C.text} font-size="12.5" text-anchor="middle">{row.wins}</text>
        <text x={group.x + GROUP_W - 75} y={ry + 16} fill={C.text} font-size="12.5" text-anchor="middle">{row.losses}</text>
        <text x={group.x + GROUP_W - 30} y={ry + 16} fill={C.muted} font-size="12" text-anchor="middle">{row.setsWon - row.setsLost > 0 ? '+' : ''}{row.setsWon - row.setsLost}</text>
      {/each}
    {/each}

    {#each section.heads as head}
      <rect x={head.x} y={section.y + TITLE_H} width={BOX_W} height={HEAD_H - 6} fill={C.header} />
      <text x={head.x + BOX_W / 2} y={section.y + TITLE_H + 16} fill={C.headerText} font-size="12" text-anchor="middle">{head.label}</text>
    {/each}

    {#each section.lines as d}
      <path {d} fill="none" stroke={C.line} stroke-width="1.5" />
    {/each}

    {#each section.matches as { match, x, y }}
      {#if match.player1 || match.player2 || match.status !== 'bye'}
        {#snippet matchNode()}
          <text x={x - 6} y={y + MATCH_H / 2 + 4} fill={C.muted} font-size="10.5" text-anchor="end">{match.number}</text>
          {@render slot(match, 1, x, y)}
          {@render slot(match, 2, x, y + ROW + 1)}
          {#if match.status === 'live'}
            <rect {x} {y} width={BOX_W} height={MATCH_H} fill="none" stroke={C.live} stroke-width="1.5" />
          {/if}
        {/snippet}
        {#if clickable(match)}
          <g
            role="button"
            tabindex="0"
            aria-label={m.tn_match_aria({ number: match.number, a: match.player1?.name ?? '', b: match.player2?.name ?? '' })}
            style:cursor="pointer"
            onclick={() => onMatchClick?.(match)}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onMatchClick?.(match); } }}
          >
            {@render matchNode()}
          </g>
        {:else}
          <g opacity={match.status === 'bye' ? 0.45 : 1}>
            {@render matchNode()}
          </g>
        {/if}
      {/if}
    {/each}
  {/each}
</svg>
