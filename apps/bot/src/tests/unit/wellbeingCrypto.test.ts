import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { openCase, openCaseHeader, openNote, sealCaseFields, sealNote, sealWellbeing, openWellbeing } from '../../services/staff/wellbeingCrypto.js';

const saved = process.env.WELLBEING_ENCRYPTION_KEY;

describe('chiffrement des dossiers de la cellule', () => {
  beforeEach(() => {
    process.env.WELLBEING_ENCRYPTION_KEY = 'cle-de-test-bien-etre';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.WELLBEING_ENCRYPTION_KEY;
    else process.env.WELLBEING_ENCRYPTION_KEY = saved;
  });

  test('le texte est stocké chiffré et se relit sur son serveur', () => {
    const sealed = sealWellbeing('100000000000000001', 'Conflit avec un membre');
    expect(sealed).not.toContain('Conflit');
    expect(openWellbeing('100000000000000001', sealed)).toBe('Conflit avec un membre');
  });

  test("un dossier recopié sur un autre serveur reste illisible", () => {
    const sealed = sealWellbeing('100000000000000001', 'secret');
    expect(openWellbeing('100000000000000002', sealed)).toBeNull();
  });

  test('un dossier écrit en clair avant le chiffrement se relit tel quel', () => {
    expect(openWellbeing('100000000000000001', 'ancien texte')).toBe('ancien texte');
  });

  test('les champs sensibles du dossier et des notes sont chiffrés puis rendus', () => {
    const guildId = '100000000000000001';
    const fields = sealCaseFields(guildId, { title: 'Titre', subjectName: 'alice', summary: 'Résumé' });
    expect(Object.values(fields).some((v) => v.includes('alice') || v.includes('Résumé'))).toBe(false);

    const opened = openCase({ guildId, ...fields, notes: [{ caseId: 'dossier-1', content: sealNote('dossier-1', 'Note') }] });
    expect(opened).toMatchObject({ title: 'Titre', subjectName: 'alice', summary: 'Résumé', notes: [{ content: 'Note' }] });
  });

  test('l en-tête de la liste relit titre et personne concernée, sans résumé', () => {
    const guildId = '100000000000000001';
    const { title, subjectName } = sealCaseFields(guildId, { title: 'Titre', subjectName: 'alice', summary: 'R' });
    const header = openCaseHeader({ guildId, title, subjectName, status: 'OPEN' });
    expect(header).toEqual({ guildId, title: 'Titre', subjectName: 'alice', status: 'OPEN' });
    expect('summary' in header).toBe(false);
  });

  test("le libellé d'une tâche est chiffré et lié à son dossier", () => {
    const guildId = '100000000000000001';
    const fields = sealCaseFields(guildId, { title: 'T', subjectName: 'S', summary: 'R' });
    const label = sealNote('dossier-1', 'Appeler la personne');
    expect(label).not.toContain('Appeler');
    const opened = openCase({ guildId, ...fields, tasks: [{ caseId: 'dossier-1', label }] });
    expect(opened.tasks?.[0]?.label).toBe('Appeler la personne');
    expect(openCase({ guildId, ...fields, tasks: [{ caseId: 'dossier-2', label }] }).tasks?.[0]?.label).toBe('[contenu illisible]');
  });

  test("la version d'origine d'une note corrigée se relit comme la note", () => {
    const opened = openNote({ caseId: 'dossier-1', content: sealNote('dossier-1', 'Corrigée'), originalContent: sealNote('dossier-1', 'Première') });
    expect(opened).toMatchObject({ content: 'Corrigée', originalContent: 'Première' });
    expect(openNote({ caseId: 'dossier-1', content: sealNote('dossier-1', 'x'), originalContent: null }).originalContent).toBeNull();
  });

  test("l'empreinte du code de suivi ne sort pas, les échanges avec le signaleur se relisent", () => {
    const guildId = '100000000000000001';
    const fields = sealCaseFields(guildId, { title: 'T', subjectName: 'S', summary: 'R' });
    const opened = openCase({
      guildId,
      ...fields,
      trackingCodeHash: 'abc',
      reporterMessages: [{ fromReporter: false, content: sealWellbeing(guildId, 'Pris en compte') }],
    });
    expect('trackingCodeHash' in opened).toBe(false);
    expect(opened.hasTrackingCode).toBe(true);
    expect(opened.reporterMessages[0]?.content).toBe('Pris en compte');
  });

  test("une note déplacée vers un autre dossier reste illisible", () => {
    const sealed = sealNote('dossier-1', 'Note');
    expect(openNote({ caseId: 'dossier-2', content: sealed }).content).toBe('[contenu illisible]');
  });

  test("un champ illisible est signalé plutôt que de faire échouer la lecture", () => {
    const sealed = sealNote('dossier-1', 'x');
    process.env.WELLBEING_ENCRYPTION_KEY = 'autre-cle';
    expect(openNote({ caseId: 'dossier-1', content: sealed }).content).toBe('[contenu illisible]');
  });

  test('le nom et le lien d un document joint sont chiffrés et liés à leur dossier', () => {
    const guildId = '100000000000000001';
    const attachment = {
      caseId: 'dossier-1',
      label: sealNote('dossier-1', 'Compte rendu'),
      url: sealNote('dossier-1', 'https://drive.google.com/file/d/abc/view'),
    };
    expect(attachment.url).not.toContain('drive.google.com');
    const fields = sealCaseFields(guildId, { title: 'T', subjectName: 'S', summary: 'R' });
    const opened = openCase({ guildId, ...fields, attachments: [attachment] });
    expect(opened.attachments?.[0]).toMatchObject({ label: 'Compte rendu', url: 'https://drive.google.com/file/d/abc/view' });

    const moved = openCase({ guildId, ...fields, attachments: [{ ...attachment, caseId: 'dossier-2' }] });
    expect(moved.attachments?.[0]?.url).toBe('[contenu illisible]');
  });
});

