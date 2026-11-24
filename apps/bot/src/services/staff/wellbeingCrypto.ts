/**
 * Chiffrement au repos des dossiers de la cellule bien-être.
 *
 * Titre, personne concernée, résumé et notes peuvent révéler des données de
 * santé ou des conflits : ils sont chiffrés en base, chaque chiffré étant lié
 * à son serveur (dossier) ou à son dossier (note). Une copie de la base, un export brut ou une ligne recopiée sur
 * un autre serveur ne donnent rien de lisible.
 *
 * La clé vient de `WELLBEING_ENCRYPTION_KEY`, à défaut de `JWT_SECRET`. La
 * changer rend les dossiers existants illisibles.
 *
 * Les dossiers écrits avant le chiffrement restent en clair et se relisent
 * tels quels ; ils sont chiffrés à leur prochaine modification.
 */
import { createSecretBox } from '../../utils/secretBox.js';

const box = createSecretBox('kotbo-wellbeing', ['WELLBEING_ENCRYPTION_KEY', 'JWT_SECRET']);
const UNREADABLE = '[contenu illisible]';

export function sealWellbeing(guildId: string, plain: string): string {
  return box.seal(plain, guildId);
}

export function openWellbeing(guildId: string, stored: string): string | null {
  return box.open(stored, guildId);
}

function readable(guildId: string, stored: string): string {
  return openWellbeing(guildId, stored) ?? UNREADABLE;
}

export interface CaseTextFields {
  title: string;
  subjectName: string;
  summary: string;
}

export function sealCaseFields(guildId: string, fields: CaseTextFields): CaseTextFields {
  return {
    title: sealWellbeing(guildId, fields.title),
    subjectName: sealWellbeing(guildId, fields.subjectName),
    summary: sealWellbeing(guildId, fields.summary),
  };
}

/** Une note est liée à son dossier : l'export RGPD la relit sans connaître le serveur. */
export function sealNote(caseId: string, content: string): string {
  return box.seal(content, `case:${caseId}`);
}

export function openNote<T extends { caseId: string; content: string }>(note: T): T {
  return { ...note, content: box.open(note.content, `case:${note.caseId}`) ?? UNREADABLE };
}

export function openCase<T extends CaseTextFields & { guildId: string; notes?: Array<{ caseId: string; content: string }> }>(item: T): T {
  return {
    ...item,
    title: readable(item.guildId, item.title),
    subjectName: readable(item.guildId, item.subjectName),
    summary: readable(item.guildId, item.summary),
    ...(item.notes ? { notes: item.notes.map((note) => openNote(note)) } : {}),
  } as T;
}
