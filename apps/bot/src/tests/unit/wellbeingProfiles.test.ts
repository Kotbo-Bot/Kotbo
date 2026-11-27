import { describe, expect, test } from 'bun:test';
import {
  PROFILE_DEPARTURE_MONTHS,
  PROFILE_RETENTION_DEFAULT_MONTHS,
  PROFILE_RETENTION_MAX_MONTHS,
  addMonths,
  cleanProfileRetention,
  departureCap,
  profileNoteExpiry,
  profilePurgeNoticeCutoff,
  profileExtendError,
  profileNoteDeleteError,
  shortenedExpiry,
} from '../../services/staff/wellbeingProfilePolicy';
import { alertText, describeConfigChange } from '../../services/staff/wellbeingPolicy';
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
    expect(profileNoteExpiry(NOW, 12, null)).toEqual(addMonths(NOW, 12));
    expect(profileNoteExpiry(NOW, 12, new Date('2026-11-01T00:00:00Z'))).toEqual(addMonths(NOW, 3));
    // Une durée choisie plus courte que le délai de départ reste la plus courte.
    expect(profileNoteExpiry(NOW, 1, new Date('2026-11-01T00:00:00Z'))).toEqual(addMonths(NOW, 1));
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

  test("une note déjà plus courte n'est jamais rallongée", () => {
    const note = { createdAt: written, extendedAt: null, expiresAt: new Date('2026-12-20T00:00:00Z') };
    expect(shortenedExpiry(note, 12, NOW)).toBeNull();
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
