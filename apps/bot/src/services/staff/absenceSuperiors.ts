/**
 * Qui peut recevoir la declaration d'absence d'un staff.
 *
 * Son tuteur en cours, le fondateur du serveur, puis les staffs de grade egal
 * ou superieur. Les grades sont ranges du plus haut (sortOrder 0) au plus bas :
 * l'ancienne regle comparait a l'envers et ne proposait que les grades egaux
 * ou inferieurs.
 *
 * Module pur : la liste du dashboard et la validation cote serveur passent
 * toutes deux par lui.
 */

export type SuperiorReason = 'tutor' | 'owner' | 'rank';

export interface SuperiorStaff {
  id: string;
  userId: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  grade: string | null;
  /** Periode de test en cours : un staff en tutorat ne valide pas d'absence. */
  inTesting: boolean;
}

export interface SuperiorCandidate {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  grade: string | null;
  reason: SuperiorReason;
}

const REASON_ORDER: Record<SuperiorReason, number> = { tutor: 0, owner: 1, rank: 2 };

export function pickAbsenceSuperiors(input: {
  requesterUserId: string;
  requesterGrade: string | null;
  /** id (StaffMember) des tuteurs de ses periodes de test en cours. */
  mentorIds: string[];
  staff: SuperiorStaff[];
  roles: Array<{ name: string; sortOrder: number }>;
  owner: { userId: string; displayName: string; avatarUrl: string | null } | null;
}): SuperiorCandidate[] {
  const rank = (grade: string | null) => input.roles.find((r) => r.name === grade)?.sortOrder;
  const myRank = rank(input.requesterGrade);
  const mentors = new Set(input.mentorIds);
  const ownerId = input.owner?.userId ?? null;

  const candidates: Array<SuperiorCandidate & { rank: number }> = [];
  for (const s of input.staff) {
    if (s.userId === input.requesterUserId) continue;
    const special: SuperiorReason | null = mentors.has(s.id) ? 'tutor' : s.userId === ownerId ? 'owner' : null;
    const theirRank = rank(s.grade);
    if (!special) {
      if (s.inTesting) continue;
      // Grade du demandeur inconnu : rien a comparer, tout le staff est propose.
      if (myRank !== undefined && (theirRank === undefined || theirRank > myRank)) continue;
    }
    candidates.push({
      userId: s.userId,
      displayName: s.displayName || s.username || s.userId,
      avatarUrl: s.avatarUrl,
      grade: s.grade,
      reason: special ?? 'rank',
      rank: theirRank ?? Number.MAX_SAFE_INTEGER,
    });
  }

  // Le fondateur n'est pas forcement inscrit au staff.
  if (input.owner && ownerId !== input.requesterUserId && !candidates.some((c) => c.userId === ownerId)) {
    candidates.push({ ...input.owner, grade: null, reason: 'owner', rank: -1 });
  }

  return candidates
    .sort((a, b) => REASON_ORDER[a.reason] - REASON_ORDER[b.reason] || a.rank - b.rank || a.displayName.localeCompare(b.displayName))
    .map(({ rank: _rank, ...candidate }) => candidate);
}
