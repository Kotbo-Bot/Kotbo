import { describe, expect, test } from 'bun:test';
import {
  PROFILE_DEPARTURE_MONTHS,
  PROFILE_RETENTION_DEFAULT_MONTHS,
  PROFILE_RETENTION_MAX_MONTHS,
  PROFILE_SENSITIVE_MONTHS,
  addMonths,
  cleanProfileRetention,
  departureCap,
  profileNoteExpiry,
  profilePurgeNoticeCutoff,
  profileExtendError,
  profileNoteDeleteError,
  profileNameChange,
  shortenedExpiry,
} from '../../services/staff/wellbeingProfilePolicy';
import { UNUSUAL_ACCESS_WINDOW_MS, alertText, describeConfigChange, openingsInWindow } from '../../services/staff/wellbeingPolicy';
import { isSynced } from '../../services/network/networkScope';
import { openProfileNote, openWellbeing, sealProfileNote } from '../../services/staff/wellbeingCrypto';

process.env.WELLBEING_ENCRYPTION_KEY = 'cle-de-test-bien-etre';

const NOW = new Date('2026-11-27T10:00:00Z');

describe('durée de conservation des notes de fiche', () => {
  test('12 mois par défaut, 36 au plus, 3 après le départ du serveur', () => {
    expect(PROFILE_RETENTION_DEFAULT_MONTHS).toBe(12);
    expect(PROFILE_RETENTION_MAX_MONTHS).toBe(36);
    expect(PROFILE_DEPARTURE_MONTHS).toBe(3);
  });

  test('le réglage du propriétaire est borné', () => {
    expect(cleanProfileRetention(24)).toBe(24);
    expect(cleanProfileRetention(99)).toBe(36);
    expect(cleanProfileRetention(0)).toBe(1);
    expect(cleanProfileRetention(1.5)).toBeUndefined();
    expect(cleanProfileRetention('12')).toBeUndefined();
  });

  test('les mois sont comptés au calendrier, fin de mois comprise', () => {
    expect(addMonths(NOW, 12).toISOString()).toBe('2027-11-27T10:00:00.000Z');
    expect(addMonths(new Date('2026-01-31T00:00:00Z'), 1).toISOString()).toBe('2026-02-28T00:00:00.000Z');
  });

  test("une note d'une personne partie ne vit que 3 mois", () => {
    const left = new Date('2026-11-01T00:00:00Z');
    expect(profileNoteExpiry(NOW, 12, { subjectLeftAt: null, sensitive: false })).toEqual(addMonths(NOW, 12));
    expect(profileNoteExpiry(NOW, 12, { subjectLeftAt: left, sensitive: false })).toEqual(addMonths(NOW, 3));
    // Une durée choisie plus courte que le délai de départ reste la plus courte.
    expect(profileNoteExpiry(NOW, 1, { subjectLeftAt: left, sensitive: false })).toEqual(addMonths(NOW, 1));
  });

  test('une note sensible (santé, vie privée) ne vit que 3 mois, quelle que soit la durée réglée', () => {
    expect(PROFILE_SENSITIVE_MONTHS).toBe(3);
    expect(profileNoteExpiry(NOW, 36, { subjectLeftAt: null, sensitive: true })).toEqual(addMonths(NOW, 3));
    expect(profileNoteExpiry(NOW, 1, { subjectLeftAt: null, sensitive: true })).toEqual(addMonths(NOW, 1));
  });

  test('au départ, aucune note ne dépasse 3 mois', () => {
    expect(departureCap(NOW)).toEqual(addMonths(NOW, 3));
  });

  test("une note est annoncée 7 jours avant son effacement", () => {
    expect(profilePurgeNoticeCutoff(NOW).toISOString()).toBe('2026-12-04T10:00:00.000Z');
  });

  test('prolonger exige un motif', () => {
    expect(profileExtendError('')).not.toBeNull();
    expect(profileExtendError('   ')).not.toBeNull();
    expect(profileExtendError('Suivi en cours avec la modération')).toBeNull();
  });
});

describe('baisse de la durée réglée', () => {
  const written = new Date('2026-01-10T00:00:00Z');

  test('une note existante ne vit pas plus que la nouvelle durée, comptée depuis son écriture', () => {
    const note = { createdAt: written, extendedAt: null, expiresAt: addMonths(written, 24) };
    expect(shortenedExpiry(note, 12, NOW)).toEqual(addMonths(written, 12));
  });

  test('une note prolongée compte depuis sa prolongation', () => {
    const extendedAt = new Date('2026-10-01T00:00:00Z');
    const note = { createdAt: written, extendedAt, expiresAt: addMonths(extendedAt, 24) };
    expect(shortenedExpiry(note, 12, NOW)).toEqual(addMonths(extendedAt, 12));
  });

  test("le préavis d'une semaine est toujours tenu", () => {
    const note = { createdAt: written, extendedAt: null, expiresAt: addMonths(written, 24) };
    expect(shortenedExpiry(note, 3, NOW)).toEqual(profilePurgeNoticeCutoff(NOW));
  });

  test('une note sensible reste à 3 mois même quand la durée réglée baisse moins', () => {
    const note = { createdAt: NOW, extendedAt: null, expiresAt: addMonths(NOW, 3), sensitive: true };
    expect(shortenedExpiry(note, 12, NOW)).toBeNull();
    const old = { createdAt: written, extendedAt: null, expiresAt: addMonths(written, 24), sensitive: true };
    expect(shortenedExpiry(old, 12, NOW)).toEqual(profilePurgeNoticeCutoff(NOW));
  });

  test("une note déjà plus courte n'est jamais rallongée", () => {
    const note = { createdAt: written, extendedAt: null, expiresAt: new Date('2026-12-20T00:00:00Z') };
    expect(shortenedExpiry(note, 12, NOW)).toBeNull();
  });
});

describe('nom de la personne', () => {
  test('un pseudo changé sur Discord remplace celui de la fiche', () => {
    expect(profileNameChange('ancien', 'nouveau')).toBe('nouveau');
  });

  test('un nom identique, vide ou illisible ne réécrit rien', () => {
    expect(profileNameChange('même', 'même')).toBeNull();
    expect(profileNameChange('ancien', '  ')).toBeNull();
    // Un nom illisible (clé changée) est remplacé : le pseudo actuel vaut mieux.
    expect(profileNameChange(null, 'actuel')).toBe('actuel');
  });
});

describe('effacement à la main', () => {
  test("seul l'auteur d'une note l'efface", () => {
    expect(profileNoteDeleteError('author', 'author')).toBeNull();
    expect(profileNoteDeleteError('author', 'other')).not.toBeNull();
  });
});

describe('réglage et alertes', () => {
  test("le changement de durée entre au journal d'audit", () => {
    const base = { enabled: true, requireReason: true, teamRoleIds: [], teamUserIds: [], directorRoleIds: [], directorUserIds: [] };
    expect(describeConfigChange({ ...base, profileRetentionMonths: 12 }, { ...base, profileRetentionMonths: 24 }, (id) => id))
      .toBe('Conservation des fiches : 24 mois');
  });

  test("l'annonce d'effacement des notes ne dit rien de leur contenu", () => {
    const text = alertText('PURGE_SOON', { actorId: '', noteCount: 2 });
    expect(text).toContain('2 note(s) de fiche');
    expect(text).not.toContain('dossier');
  });
});

describe('consultation inhabituelle', () => {
  test('seules les ouvertures de la fenêtre comptent', () => {
    const now = NOW.getTime();
    expect(openingsInWindow([now - UNUSUAL_ACCESS_WINDOW_MS - 1, now - 1000, now], now)).toEqual([now - 1000, now]);
  });

  test("l'alerte parle de dossiers et de fiches, sans les nommer", () => {
    const text = alertText('UNUSUAL_ACCESS', { actorId: '200000000000000001', caseCount: 12 });
    expect(text).toContain('12 dossiers ou fiches');
  });
});

describe('chiffrement et cloisonnement', () => {
  test("une note de fiche est chiffrée et liée à sa fiche", () => {
    const sealed = sealProfileNote('profile-1', 'Se sent isolé depuis septembre');
    expect(sealed).not.toContain('isolé');
    expect(openProfileNote({ profileId: 'profile-1', content: sealed }).content).toBe('Se sent isolé depuis septembre');
    expect(openProfileNote({ profileId: 'profile-2', content: sealed }).content).not.toBe('Se sent isolé depuis septembre');
    expect(openWellbeing('profile-1', sealed)).toBeNull();
  });

  test('les fiches restent sur leur serveur dans un réseau', () => {
    expect(isSynced('WellbeingProfile')).toBe(false);
  });
});
