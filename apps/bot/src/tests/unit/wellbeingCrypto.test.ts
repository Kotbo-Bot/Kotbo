import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { openCase, openNote, sealCaseFields, sealNote, sealWellbeing, openWellbeing } from '../../services/staff/wellbeingCrypto.js';

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

  test("une note déplacée vers un autre dossier reste illisible", () => {
    const sealed = sealNote('dossier-1', 'Note');
    expect(openNote({ caseId: 'dossier-2', content: sealed }).content).toBe('[contenu illisible]');
  });

  test("un champ illisible est signalé plutôt que de faire échouer la lecture", () => {
    const sealed = sealNote('dossier-1', 'x');
    process.env.WELLBEING_ENCRYPTION_KEY = 'autre-cle';
    expect(openNote({ caseId: 'dossier-1', content: sealed }).content).toBe('[contenu illisible]');
  });
});
