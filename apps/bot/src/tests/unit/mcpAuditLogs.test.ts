import { describe, expect, test } from 'bun:test';
import { WELLBEING_AUDIT_MODULE } from '../../services/staff/wellbeingAccessPolicy.js';
import { auditLogSearchWhere } from '../../api/mcp/tools/read-stats-2.js';

describe('journal d audit lu par le MCP', () => {
  test('les entrées de la cellule de suivi en sont toujours exclues', () => {
    for (const query of [undefined, 'suivi confidentiel']) {
      const where = auditLogSearchWhere('100000000000000001', query);
      expect(where.NOT).toEqual({ module: WELLBEING_AUDIT_MODULE });
      expect(where.guildId).toBe('100000000000000001');
    }
  });
});
