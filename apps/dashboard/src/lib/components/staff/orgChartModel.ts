/**
 * Donnees de l'organigramme, sans Svelte : le schema du bot devient des cartes,
 * les memes pour les trois affichages et pour l'export.
 */

export type OrgType = 'hierarchy' | 'teams' | 'grades';
export type OrgLayout = 'tree' | 'horizontal' | 'outline';

export type SchemaHierarchy = {
  id: string;
  name: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  sortOrder?: number | null;
  parentHierarchyId?: string | null;
  responsable?: { userId: string; name?: string | null } | null;
  roles: Array<{ id: string; name: string; level: number; isResponsable: boolean; color?: string | null }>;
  memberCount: number;
  members: Array<{ userId: string; username: string; displayName?: string | null; avatarUrl?: string | null; grade: string }>;
};

export type HierarchySchema = {
  chiefStaff: { userId?: string | null; roleId?: string | null; name?: string | null } | null;
  hierarchies: SchemaHierarchy[];
};

export interface OrgMember {
  userId: string;
  name: string;
  avatarUrl: string | null;
  hierarchyId: string;
  roleId: string | null;
}

/** Un grade dans un pole. `roleId` nul : membres dont le grade n'existe plus. */
export interface OrgSection {
  id: string;
  roleId: string | null;
  hierarchyId: string;
  title: string;
  color: string | null;
  lead: boolean;
  members: OrgMember[];
}

export interface OrgCard {
  id: string;
  kind: 'chief' | 'pole' | 'grade';
  hierarchyId: string | null;
  title: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  responsable: string | null;
  sections: OrgSection[];
  memberCount: number;
  children: OrgCard[];
}

export interface OrgLabels {
  chief: string;
  unknownName: string;
  noGrade: string;
}

const byOrder = (left: SchemaHierarchy, right: SchemaHierarchy) =>
  (left.sortOrder ?? 0) - (right.sortOrder ?? 0) || left.name.localeCompare(right.name);

/** Faux si `parentId` est le pole lui-meme ou l'un de ses descendants. */
export function canAttach(hierarchies: SchemaHierarchy[], id: string, parentId: string | null): boolean {
  const seen = new Set<string>();
  for (let cursor = parentId; cursor && !seen.has(cursor);) {
    if (cursor === id) return false;
    seen.add(cursor);
    cursor = hierarchies.find((h) => h.id === cursor)?.parentHierarchyId ?? null;
  }
  return true;
}

/** Poles d'un meme parent, dans l'ordre affiche. */
export function siblingsOf(hierarchies: SchemaHierarchy[], parentId: string | null): string[] {
  return hierarchies
    .filter((h) => (h.parentHierarchyId ?? null) === parentId)
    .sort(byOrder)
    .map((h) => h.id);
}

/** Freres du pole une fois deplace : avant `beforeId`, ou en dernier. */
export function siblingOrder(
  hierarchies: SchemaHierarchy[],
  id: string,
  parentId: string | null,
  beforeId?: string,
): string[] {
  const order = siblingsOf(hierarchies, parentId).filter((sibling) => sibling !== id);
  const at = beforeId ? order.indexOf(beforeId) : -1;
  order.splice(at < 0 ? order.length : at, 0, id);
  return order;
}

function memberOf(member: SchemaHierarchy['members'][number], hierarchyId: string, roleId: string | null): OrgMember {
  return {
    userId: member.userId,
    name: member.displayName || member.username,
    avatarUrl: member.avatarUrl ?? null,
    hierarchyId,
    roleId,
  };
}

/** Grades du pole, du plus haut au plus bas, puis les membres sans grade reconnu. */
function polesSections(hierarchy: SchemaHierarchy, labels: OrgLabels): OrgSection[] {
  const roles = [...hierarchy.roles].sort((a, b) => (b.level ?? 0) - (a.level ?? 0) || a.name.localeCompare(b.name));
  const names = new Set(roles.map((role) => role.name.toLowerCase()));
  const sections: OrgSection[] = roles.map((role) => ({
    id: role.id,
    roleId: role.id,
    hierarchyId: hierarchy.id,
    title: role.name,
    color: role.color ?? hierarchy.color ?? null,
    lead: role.isResponsable,
    members: hierarchy.members
      .filter((member) => member.grade.toLowerCase() === role.name.toLowerCase())
      .map((member) => memberOf(member, hierarchy.id, role.id)),
  }));
  const orphans = hierarchy.members.filter((member) => !names.has(member.grade.toLowerCase()));
  if (orphans.length) {
    sections.push({
      id: `${hierarchy.id}:orphans`,
      roleId: null,
      hierarchyId: hierarchy.id,
      title: labels.noGrade,
      color: null,
      lead: false,
      members: orphans.map((member) => memberOf(member, hierarchy.id, null)),
    });
  }
  return sections;
}

function poleCard(hierarchy: SchemaHierarchy, labels: OrgLabels): OrgCard {
  return {
    id: hierarchy.id,
    kind: 'pole',
    hierarchyId: hierarchy.id,
    title: hierarchy.name,
    description: hierarchy.description ?? null,
    icon: hierarchy.icon ?? null,
    color: hierarchy.color ?? null,
    responsable: hierarchy.responsable?.name ?? null,
    sections: polesSections(hierarchy, labels),
    memberCount: hierarchy.members.length,
    children: [],
  };
}

function hierarchyCards(hierarchies: SchemaHierarchy[], labels: OrgLabels): OrgCard[] {
  const cards = new Map(hierarchies.map((h) => [h.id, poleCard(h, labels)]));
  const roots: OrgCard[] = [];
  for (const hierarchy of [...hierarchies].sort(byOrder)) {
    const card = cards.get(hierarchy.id)!;
    const parentId = hierarchy.parentHierarchyId ?? null;
    // Parent masque, ou boucle deja en base : le pole reste visible au premier niveau.
    const parent = parentId ? cards.get(parentId) : undefined;
    if (parent && canAttach(hierarchies, hierarchy.id, parentId)) parent.children.push(card);
    else roots.push(card);
  }
  return roots;
}

/** Une carte par grade, du plus haut au plus bas ; un meme nom regroupe ses poles. */
function gradeCards(hierarchies: SchemaHierarchy[], labels: OrgLabels): OrgCard[] {
  const groups = new Map<string, OrgCard & { level: number }>();
  for (const hierarchy of [...hierarchies].sort(byOrder)) {
    const levels = new Map(hierarchy.roles.map((role) => [role.id, role]));
    for (const section of polesSections(hierarchy, labels)) {
      const role = section.roleId ? levels.get(section.roleId) : undefined;
      const key = section.title.toLowerCase();
      const group = groups.get(key) ?? {
        id: `grade:${key}`,
        kind: 'grade' as const,
        hierarchyId: null,
        title: section.title,
        description: null,
        icon: null,
        color: section.color,
        responsable: null,
        sections: [],
        memberCount: 0,
        children: [],
        level: role?.level ?? -1,
      };
      group.level = Math.max(group.level, role?.level ?? -1);
      group.sections.push({ ...section, title: hierarchy.name, color: hierarchy.color ?? null });
      group.memberCount += section.members.length;
      groups.set(key, group);
    }
  }
  const ladder = [...groups.values()].sort((a, b) => b.level - a.level || a.title.localeCompare(b.title));
  ladder.forEach((card, index) => {
    if (ladder[index + 1]) card.children = [ladder[index + 1]];
  });
  return ladder.slice(0, 1);
}

export function buildOrgCards(schema: HierarchySchema | null, type: OrgType, labels: OrgLabels): OrgCard[] {
  const hierarchies = schema?.hierarchies ?? [];
  if (hierarchies.length === 0) return [];

  const cards = type === 'grades'
    ? gradeCards(hierarchies, labels)
    : type === 'teams'
      ? [...hierarchies].sort(byOrder).map((h) => poleCard(h, labels))
      : hierarchyCards(hierarchies, labels);

  const chief = schema?.chiefStaff;
  if (!chief || !(chief.name || chief.userId)) return cards;
  return [{
    id: 'chief',
    kind: 'chief',
    hierarchyId: null,
    title: chief.name || labels.unknownName,
    description: labels.chief,
    icon: 'crown',
    color: null,
    responsable: null,
    sections: [],
    memberCount: 0,
    children: cards,
  }];
}

/** Une ligne par personne et par pole ; les grades vides restent dans le fichier. */
export function orgRows(schema: HierarchySchema | null, labels: OrgLabels, columns: { pole: string; parent: string; grade: string; member: string; id: string }) {
  const hierarchies = [...(schema?.hierarchies ?? [])].sort(byOrder);
  return hierarchies.flatMap((hierarchy) => {
    const parent = hierarchies.find((h) => h.id === hierarchy.parentHierarchyId)?.name ?? '';
    return polesSections(hierarchy, labels).flatMap((section) => {
      const base = { [columns.pole]: hierarchy.name, [columns.parent]: parent, [columns.grade]: section.title };
      if (section.members.length === 0) return [{ ...base, [columns.member]: '', [columns.id]: '' }];
      return section.members.map((member) => ({ ...base, [columns.member]: member.name, [columns.id]: member.userId }));
    });
  });
}

// ── Export SVG ──────────────────────────────────────────

const CARD_WIDTH = 248;
const GAP_SIBLING = 28;
const GAP_DEPTH = 44;
const MARGIN = 32;
const HEADER = 50;
const SUBTITLE = 18;
const SECTION_TITLE = 24;
const MEMBER_LINE = 19;
const SECTION_END = 6;

const INK = { background: '#ffffff', card: '#f8f8fa', border: '#d9d9e0', text: '#18181b', muted: '#5f5f6b', link: '#a1a1aa', accent: '#6366f1' };

// Le texte vient de Discord : un caractere de controle rendrait le SVG illisible.
const escapeXml = (text: string) => text
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function fit(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

interface Box {
  card: OrgCard;
  height: number;
  span: number;
  children: Box[];
}

const subtitleOf = (card: OrgCard) => card.description || (card.responsable ?? '');

function cardHeight(card: OrgCard): number {
  return HEADER
    + (subtitleOf(card) ? SUBTITLE : 0)
    + card.sections.reduce((sum, section) => sum + SECTION_TITLE + Math.max(1, section.members.length) * MEMBER_LINE + SECTION_END, 0);
}

function measure(card: OrgCard, horizontal: boolean): Box {
  const children = card.children.map((child) => measure(child, horizontal));
  const height = cardHeight(card);
  const childrenSpan = children.reduce((sum, child) => sum + child.span, 0) + GAP_SIBLING * Math.max(0, children.length - 1);
  return { card, height, children, span: Math.max(horizontal ? height : CARD_WIDTH, childrenSpan) };
}

function cardSvg(card: OrgCard, height: number, x: number, y: number, noMember: string): string {
  const color = escapeXml(card.color || INK.accent);
  const subtitle = subtitleOf(card);
  const parts = [
    `<rect x="${x}" y="${y}" width="${CARD_WIDTH}" height="${height}" rx="10" fill="${INK.card}" stroke="${INK.border}"/>`,
    `<rect x="${x}" y="${y + 12}" width="3" height="24" rx="1.5" fill="${color}"/>`,
    `<text x="${x + 16}" y="${y + 30}" font-size="15" font-weight="600" fill="${INK.text}">${escapeXml(fit(card.title, 26))}</text>`,
  ];
  let line = y + HEADER;
  if (subtitle) {
    parts.push(`<text x="${x + 16}" y="${line - 4}" font-size="12" fill="${INK.muted}">${escapeXml(fit(subtitle, 36))}</text>`);
    line += SUBTITLE;
  }
  for (const section of card.sections) {
    parts.push(`<text x="${x + 16}" y="${line + 14}" font-size="12" font-weight="600" fill="${INK.muted}">${escapeXml(fit(section.title, 30))} (${section.members.length})</text>`);
    line += SECTION_TITLE;
    for (const member of section.members) {
      parts.push(`<text x="${x + 16}" y="${line + 12}" font-size="13" fill="${INK.text}">${escapeXml(fit(member.name, 32))}</text>`);
      line += MEMBER_LINE;
    }
    if (section.members.length === 0) {
      parts.push(`<text x="${x + 16}" y="${line + 12}" font-size="12" fill="${INK.muted}">${escapeXml(noMember)}</text>`);
      line += MEMBER_LINE;
    }
    line += SECTION_END;
  }
  return parts.join('');
}

/** SVG autonome de l'organigramme ; le plan s'exporte comme l'arbre. */
export function orgChartSvg(cards: OrgCard[], layout: OrgLayout, noMember: string): { source: string; width: number; height: number } {
  const horizontal = layout === 'horizontal';
  const out: string[] = [];
  let right = 0;
  let bottom = 0;

  // `cross` avance entre freres, `depth` d'un niveau a l'autre. Rend le point d'attache de la carte.
  const place = (box: Box, cross: number, depth: number): { x: number; y: number } => {
    const size = horizontal ? box.height : CARD_WIDTH;
    const center = cross + box.span / 2;
    const x = horizontal ? depth : center - size / 2;
    const y = horizontal ? center - size / 2 : depth;
    out.push(cardSvg(box.card, box.height, x, y, noMember));
    right = Math.max(right, x + CARD_WIDTH);
    bottom = Math.max(bottom, y + box.height);

    const fromX = horizontal ? x + CARD_WIDTH : center;
    const fromY = horizontal ? center : y + box.height;
    const nextDepth = (horizontal ? x + CARD_WIDTH : y + box.height) + GAP_DEPTH;
    const childrenSpan = box.children.reduce((sum, child) => sum + child.span, 0) + GAP_SIBLING * Math.max(0, box.children.length - 1);
    let cursor = cross + (box.span - childrenSpan) / 2;
    for (const child of box.children) {
      const to = place(child, cursor, nextDepth);
      const middle = nextDepth - GAP_DEPTH / 2;
      const path = horizontal
        ? `M${fromX} ${fromY}H${middle}V${to.y}H${to.x}`
        : `M${fromX} ${fromY}V${middle}H${to.x}V${to.y}`;
      out.push(`<path d="${path}" fill="none" stroke="${INK.link}"/>`);
      cursor += child.span + GAP_SIBLING;
    }
    return horizontal ? { x, y: center } : { x: center, y };
  };

  let cursor = MARGIN;
  for (const card of cards) {
    const box = measure(card, horizontal);
    place(box, cursor, MARGIN);
    cursor += box.span + GAP_SIBLING;
  }

  const width = Math.ceil(right + MARGIN);
  const height = Math.ceil(bottom + MARGIN);
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif"><rect width="${width}" height="${height}" fill="${INK.background}"/>${out.join('')}</svg>`;
  return { source, width, height };
}
