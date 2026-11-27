/**
 * Personnes suivies par la cellule : celles qui ont une fiche, et celles qui
 * n'ont que des dossiers. Chacune a sa page, où ses notes et ses dossiers se
 * lisent ensemble. Un signalement anonyme, sans personne, reste aux dossiers.
 *
 * Un seul nom par personne : celui de sa fiche, tenu à jour par le bot, sinon
 * celui de son dossier le plus récent.
 */

export interface WbProfileHeader {
  subjectUserId: string;
  subjectName: string;
  subjectLeftAt: string | null;
  noteCount: number;
  nextExpiry: string | null;
  /** Étiquettes de la cellule posées sur la fiche. */
  tagIds?: string[];
}

export interface WbPersonCase {
  id: string;
  subjectUserId?: string | null;
  subjectName?: string;
  status: string;
  updatedAt?: string;
}

export interface WbPerson {
  userId: string;
  name: string;
  noteCount: number;
  nextExpiry: string | null;
  leftAt: string | null;
  activeCases: number;
  caseCount: number;
  tagIds: string[];
}

export function wbPeople(profiles: readonly WbProfileHeader[], cases: readonly WbPersonCase[]): WbPerson[] {
  const people = new Map<string, WbPerson>();
  for (const profile of profiles) {
    people.set(profile.subjectUserId, {
      userId: profile.subjectUserId,
      name: profile.subjectName,
      noteCount: profile.noteCount,
      nextExpiry: profile.nextExpiry,
      leftAt: profile.subjectLeftAt,
      activeCases: 0,
      caseCount: 0,
      tagIds: profile.tagIds ?? [],
    });
  }
  const withProfile = new Set(profiles.map((profile) => profile.subjectUserId));
  /** Date du dossier qui a donné son nom à la personne, quand elle n'a pas de fiche. */
  const namedAt = new Map<string, string>();
  for (const item of cases) {
    if (!item.subjectUserId) continue;
    const person = people.get(item.subjectUserId) ?? {
      userId: item.subjectUserId,
      name: item.subjectName ?? item.subjectUserId,
      noteCount: 0,
      nextExpiry: null,
      leftAt: null,
      activeCases: 0,
      caseCount: 0,
      tagIds: [],
    };
    person.caseCount += 1;
    if (item.status !== 'CLOSED') person.activeCases += 1;
    const at = item.updatedAt ?? '';
    if (!withProfile.has(item.subjectUserId) && item.subjectName && at >= (namedAt.get(item.subjectUserId) ?? '')) {
      person.name = item.subjectName;
      namedAt.set(item.subjectUserId, at);
    }
    people.set(item.subjectUserId, person);
  }
  return [...people.values()].sort((a, b) =>
    Number(b.activeCases > 0) - Number(a.activeCases > 0) || a.name.localeCompare(b.name));
}
