import { describe, expect, test } from 'bun:test';
import { buildMoveSql } from '../../services/network/networkMergeService.js';

describe('buildMoveSql', () => {
  test('sans index unique : déplace tout', () => {
    expect(buildMoveSql('notes', [])).toBe('UPDATE "notes" AS s SET "guildId" = $1 WHERE s."guildId" = $2');
  });

  test('un doublon de clé (guildId, userId) reste en place', () => {
    const sql = buildMoveSql('member_levels', [['guildId', 'userId']]);
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM "member_levels" o WHERE o."guildId" = $1 AND o."userId" = s."userId")');
  });

  test('réglage à clé unique sur guildId seul : reste si le principal a déjà le sien', () => {
    const sql = buildMoveSql('economy_configs', [['guildId']]);
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM "economy_configs" o WHERE o."guildId" = $1)');
  });

  test('plusieurs index : toutes les gardes s\'appliquent', () => {
    const sql = buildMoveSql('t', [['guildId', 'a'], ['guildId', 'b']]);
    expect(sql.match(/NOT EXISTS/g)?.length).toBe(2);
  });

  test('un nom de table avec un guillemet est échappé', () => {
    expect(buildMoveSql('a"b', [])).toContain('"a""b"');
  });
});
