import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

const MEMBRE = { id: 'cuid-staff', userId: '111111111111111111' };

// staffActivity, staffMeetingPresence et staffAbsence référencent StaffMember.id, pas l'ID Discord.
const lignesDuMembre = (lignes: object[]) => async ({ where }: { where: { staffUserId: string } }) =>
  (where.staffUserId === MEMBRE.id ? lignes : []);

const prismaMock = {
  staffMember: { findFirst: async () => MEMBRE },
  staffActivity: { findMany: lignesDuMembre([{ messageCount: 40, voiceMinutes: 90 }]) },
  staffMeetingPresence: { findMany: lignesDuMembre([{ status: 'PRESENT' }]) },
  staffAbsence: { findMany: lignesDuMembre([]) },
  staffMeeting: { count: async () => 1 },
  sanction: { count: async () => 0 },
  ticket: { count: async () => 0 },
  staffEvaluation: { findFirst: async () => null, create: async ({ data }: { data: object }) => data },
};
for (const ext of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db.${ext}`), () => ({ default: prismaMock, prisma: prismaMock, prismaRead: prismaMock }));
}

const { generateStaffEvaluation } = await import('../../services/staff/staffEvaluationService.js');

describe('generateStaffEvaluation', () => {
  test('évalué par son ID Discord, le membre retrouve son activité et ses présences', async () => {
    expect(await generateStaffEvaluation('g1', MEMBRE.userId)).toMatchObject({
      staffUserId: MEMBRE.userId,
      totalMessages: 40,
      totalVoiceMinutes: 90,
      meetingsAttended: 1,
    });
  });

  test('une période nulle ne donne pas de score NaN', async () => {
    expect((await generateStaffEvaluation('g1', MEMBRE.userId, 0)).overallScore).not.toBeNaN();
  });
});
