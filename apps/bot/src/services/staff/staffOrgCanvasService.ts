import prisma from '../../utils/db.js';

export type OrgCanvasLinkStyle = 'solid' | 'dashed' | 'ochre';

export interface OrgCanvas {
  /** Position de la carte d'un pôle, par id de hiérarchie. */
  nodes: Record<string, { x: number; y: number }>;
  frames: Array<{ id: string; label: string; x: number; y: number; w: number; h: number; color: string | null; dashed: boolean }>;
  /** `linked` : le trait plein reflète le parent réel du pôle (`to` est enfant de `from`). */
  links: Array<{ id: string; from: string; to: string; style: OrgCanvasLinkStyle; linked: boolean }>;
}

const MAX_NODES = 300;
const MAX_FRAMES = 60;
const MAX_LINKS = 400;
const COORD = 20000;

const num = (value: unknown, min = -COORD, max = COORD) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : 0;
};
const str = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const isObj = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Frontière de confiance : tout ce qui vient du dashboard est reconstruit champ par champ. */
export function sanitizeOrgCanvas(raw: unknown): OrgCanvas {
  const input = isObj(raw) ? raw : {};
  const nodes: OrgCanvas['nodes'] = {};
  if (isObj(input.nodes)) {
    for (const [id, pos] of Object.entries(input.nodes).slice(0, MAX_NODES)) {
      if (id.length > 64 || !isObj(pos)) continue;
      nodes[id] = { x: num(pos.x), y: num(pos.y) };
    }
  }

  const frames = (Array.isArray(input.frames) ? input.frames : []).slice(0, MAX_FRAMES).flatMap((f) => {
    if (!isObj(f)) return [];
    const id = str(f.id, 64);
    if (!id) return [];
    const color = str(f.color, 9);
    return [{
      id,
      label: str(f.label, 60),
      x: num(f.x),
      y: num(f.y),
      w: num(f.w, 40, COORD),
      h: num(f.h, 40, COORD),
      color: /^#[0-9a-f]{3,8}$/i.test(color) ? color : null,
      dashed: !!f.dashed,
    }];
  });

  const links = (Array.isArray(input.links) ? input.links : []).slice(0, MAX_LINKS).flatMap((l) => {
    if (!isObj(l)) return [];
    const id = str(l.id, 64);
    const from = str(l.from, 64);
    const to = str(l.to, 64);
    if (!id || !from || !to || from === to) return [];
    const style: OrgCanvasLinkStyle = l.style === 'dashed' || l.style === 'ochre' ? l.style : 'solid';
    return [{ id, from, to, style, linked: style === 'solid' && !!l.linked }];
  });

  return { nodes, frames, links };
}

export async function getOrgCanvas(guildId: string): Promise<OrgCanvas> {
  const row = await prisma.staffOrgCanvas.findUnique({ where: { guildId } });
  return sanitizeOrgCanvas(row?.data);
}

export async function saveOrgCanvas(guildId: string, raw: unknown): Promise<OrgCanvas> {
  const data = sanitizeOrgCanvas(raw);
  await prisma.staffOrgCanvas.upsert({
    where: { guildId },
    create: { guildId, data },
    update: { data },
  });
  return data;
}
