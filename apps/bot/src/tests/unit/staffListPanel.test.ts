import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

// Le service importe le client Prisma ; ces tests n'en ont pas besoin.
const mockDb = {};
mock.module(path.resolve(__dirname, '../../utils/db.ts'), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
mock.module(path.resolve(__dirname, '../../utils/db.js'), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));

import { formatStaffList } from '../../services/staff/staffListPanelService.js';

describe('formatStaffList', () => {
  test('un titre par grade, une ligne par membre, grades vides omis', () => {
    expect(formatStaffList([
      { name: 'Modérateur', discordRoleId: '111111111111111111', userIds: ['222222222222222222', '333333333333333333'] },
      { name: 'Helper', discordRoleId: null, userIds: [] },
      { name: 'Support', discordRoleId: null, userIds: ['444444444444444444'] },
    ])).toBe(
      '## <@&111111111111111111>\n- <@222222222222222222>\n- <@333333333333333333>\n\n## Support\n- <@444444444444444444>',
    );
  });

  test('sans membre, un message explicite', () => {
    expect(formatStaffList([{ name: 'Helper', discordRoleId: null, userIds: [] }])).toContain('Aucun membre');
  });

  test('coupe en fin de ligne au-delà de la limite', () => {
    const text = formatStaffList([{ name: 'Staff', discordRoleId: null, userIds: Array.from({ length: 50 }, (_, i) => String(100000000000000000 + i)) }], 200);
    expect(text.length).toBeLessThanOrEqual(202);
    expect(text.endsWith('\n…')).toBe(true);
  });
});
