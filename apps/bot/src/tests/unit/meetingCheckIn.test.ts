import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

type Absence = { guildId: string; staffUserId: string; type: string; startDate: Date };

const REUNION = { guildId: '100000000000000001', title: 'Point hebdo', scheduledAt: new Date('2026-11-20T18:00:00Z') };
const absences: Absence[] = [];

const staffAbsence = {
  findFirst: async ({ where }: { where: Absence }) =>
    absences.find((absence) => absence.guildId === where.guildId && absence.staffUserId === where.staffUserId
      && absence.type === where.type && absence.startDate.getTime() === where.startDate.getTime()) ?? null,
  create: async ({ data }: { data: Absence }) => absences.push(data),
};
const fauxPrisma = {
  staffMeetingPresence: { upsert: async () => ({ meeting: REUNION }) },
  staffMeeting: { findUnique: async () => null },
  staffAbsence,
  $transaction: async (ecriture: (tx: unknown) => Promise<unknown>) => ecriture({ $executeRaw: async () => 0, staffAbsence }),
};

for (const ext of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db.${ext}`), () =>
    completeModuleMock(path.resolve(import.meta.dir, '../../utils/db.ts'), { default: fauxPrisma, prisma: fauxPrisma, prismaRead: fauxPrisma }));
}

const { checkInMeeting } = await import('../../services/staff/staffLeadershipService.js');

describe('présence à une réunion', () => {
  test('recliquer sur « Absent » ne crée pas une seconde absence', async () => {
    await checkInMeeting({} as Client, 'reunion-1', 'staff-1', 'ABSENT');
    await checkInMeeting({} as Client, 'reunion-1', 'staff-1', 'ABSENT');

    expect(absences).toHaveLength(1);
  });
});
