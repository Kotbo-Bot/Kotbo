import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { argsFromQuery, isReadTool } from '../../api/mcp/restApi.js';

describe('API REST : lecture des paramètres', () => {
  const schema = z.object({
    member: z.string(),
    limit: z.number().int().optional(),
    active: z.boolean().optional(),
  });

  test('un ID Discord reste une chaîne, les nombres et booléens sont convertis', () => {
    const parsed = argsFromQuery(schema, new URLSearchParams('member=123456789012345678&limit=10&active=true'));
    expect(parsed.success && parsed.data).toEqual({ member: '123456789012345678', limit: 10, active: true });
  });

  test('un nom numérique reste une chaîne', () => {
    const parsed = argsFromQuery(schema, new URLSearchParams('member=2024'));
    expect(parsed.success && parsed.data).toEqual({ member: '2024' });
  });

  test('paramètre inconnu ou requis manquant : refusé', () => {
    expect(argsFromQuery(schema, new URLSearchParams('member=a&evil=1')).success).toBe(false);
    expect(argsFromQuery(schema, new URLSearchParams('limit=3')).success).toBe(false);
  });

  test('seuls les outils de lecture sont exposés', () => {
    expect(isReadTool('get_member_level')).toBe(true);
    expect(isReadTool('list_channels')).toBe(true);
    expect(isReadTool('delete_channel')).toBe(false);
    expect(isReadTool('apply_sanction')).toBe(false);
  });
});
