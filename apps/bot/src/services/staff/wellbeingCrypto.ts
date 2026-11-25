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
 * Les textes écrits avant le chiffrement restent en clair et se relisent tels
 * quels : seuls les nouveaux dossiers et les nouvelles notes sont chiffrés.
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

/**
 * Une note (ou un document joint) est liée à son dossier : l'export RGPD la
 * relit sans connaître le serveur.
 */
export function sealNote(caseId: string, content: string): string {
  return box.seal(content, `case:${caseId}`);
}

export function openNote<T extends { caseId: string; content: string; originalContent?: string | null }>(note: T): T {
  const context = `case:${note.caseId}`;
  return {
    ...note,
    content: box.open(note.content, context) ?? UNREADABLE,
    // Note corrigée : sa première version, chiffrée de la même façon.
    ...(note.originalContent ? { originalContent: box.open(note.originalContent, context) ?? UNREADABLE } : {}),
  };
}

/** Document joint : nom et lien chiffrés, liés à leur dossier comme une note. */
export function openAttachment<T extends { caseId: string; label: string; url: string }>(attachment: T): T {
  const context = `case:${attachment.caseId}`;
  return {
    ...attachment,
    label: box.open(attachment.label, context) ?? UNREADABLE,
    url: box.open(attachment.url, context) ?? UNREADABLE,
  };
}

/** En-tête d'un dossier pour la liste : titre et personne concernée, sans le contenu. */
export function openCaseHeader<T extends { guildId: string; title: string; subjectName: string }>(item: T): T {
  return { ...item, title: readable(item.guildId, item.title), subjectName: readable(item.guildId, item.subjectName) };
}

/** Tâche du plan d'action : libellé chiffré et lié à son dossier, comme une note. */
export function openTask<T extends { caseId: string; label: string }>(task: T): T {
  return { ...task, label: box.open(task.label, `case:${task.caseId}`) ?? UNREADABLE };
}

export function openCase<T extends CaseTextFields & {
  guildId: string;
  notes?: Array<{ caseId: string; content: string }>;
  attachments?: Array<{ caseId: string; label: string; url: string }>;
  tasks?: Array<{ caseId: string; label: string }>;
}>(item: T): T {
  return {
    ...item,
    title: readable(item.guildId, item.title),
    subjectName: readable(item.guildId, item.subjectName),
    summary: readable(item.guildId, item.summary),
    ...(item.notes ? { notes: item.notes.map((note) => openNote(note)) } : {}),
    ...(item.attachments ? { attachments: item.attachments.map((attachment) => openAttachment(attachment)) } : {}),
    ...(item.tasks ? { tasks: item.tasks.map((task) => openTask(task)) } : {}),
  } as T;
}
