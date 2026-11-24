import { describe, expect, test } from 'bun:test';
import { MAX_BULK_TAGS, mergeScans, parseBulkTags } from './bulkTags';

describe('parseBulkTags', () => {
  test('un tag par ligne, virgules et espaces acceptés, en capitales et sans doublon', () => {
    expect(parseBulkTags('raid\nkkk, Raid  hh').tags).toEqual(['RAID', 'KKK', 'HH']);
  });

  test('accepte un tag d\'un seul caractère', () => {
    expect(parseBulkTags('x').tags).toEqual(['X']);
  });

  test('signale les entrées de plus de 4 caractères au lieu de les ignorer', () => {
    expect(parseBulkTags('RAID TOOLONG').tooLong).toEqual(['TOOLONG']);
  });

  test('le plafond tient dans une saisie raisonnable', () => {
    expect(MAX_BULK_TAGS).toBe(20);
  });
});

describe('mergeScans', () => {
  const match = (userId: string) => ({
    userId, username: userId, displayName: userId, avatarUrl: '', tag: 'T', tagGuildId: 'g',
    action: 'ALERT' as const, trigger: 'RESCAN' as const, ruleName: null,
  });

  test('additionne les membres visés et ne compte chaque membre qu\'une fois', () => {
    const merged = mergeScans([
      { scanned: 50, withTag: 10, total: 2, matches: [match('a'), match('b')] },
      { scanned: 50, withTag: 10, total: 1, matches: [match('b')] },
    ]);
    expect(merged.scanned).toBe(50);
    expect(merged.total).toBe(2);
    expect(merged.matches.map((m) => m.userId)).toEqual(['a', 'b']);
  });

  test('sans aperçu, tout est à zéro', () => {
    expect(mergeScans([])).toEqual({ scanned: 0, withTag: 0, total: 0, matches: [] });
  });
});
