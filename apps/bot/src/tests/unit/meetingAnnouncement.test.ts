import { describe, expect, mock, test } from 'bun:test';
import type { Client, EmbedBuilder } from 'discord.js';

const presences = Array.from({ length: 12 }, (_, i) => ({ status: 'EXCUSED', note: 'Indisponible. '.repeat(30), staffMember: { userId: `${100 + i}` } }));

mock.module('../../utils/db.js', () => {
  const db = {
    staffMeeting: {
      findUnique: async () => ({ id: 'r', guildId: 'g', title: 'Point', description: null, scheduledAt: new Date(), createdByUserId: '1', voiceChannelId: null, discordMessageId: 'msg', presences }),
    },
    guild: { findUnique: async () => ({ meetingAnnouncementChannelId: 'salon' }) },
  };
  return { default: db, prisma: db, prismaRead: db };
});

const { updateMeetingAnnouncement } = await import('../../services/staff/staffLeadershipService.js');

describe('annonce de réunion', () => {
  test('de nombreuses justifications longues tiennent dans la limite d\'un champ Discord', async () => {
    const edit = mock(async (_: { embeds: EmbedBuilder[] }) => {});
    const channel = { isTextBased: () => true, messages: { fetch: async () => ({ edit }) } };
    const client = { guilds: { cache: { get: () => ({ channels: { fetch: async () => channel } }) } } } as unknown as Client;

    await updateMeetingAnnouncement(client, 'r');

    const champ = edit.mock.calls[0][0].embeds[0].data.fields?.find((f) => f.name.includes('Justifications'));
    expect(champ?.value.length).toBeLessThanOrEqual(1024);
    // Des justifications entières, mention comprise, puis le nombre de celles qui n'ont pas tenu.
    const lignes = champ!.value.split('\n');
    for (const ligne of lignes.slice(0, -1)) expect(ligne).toMatch(/^- <@\d+> : \*.+\*$/);
    expect(lignes.at(-1)).toMatch(/^… et \d+ autres$/);
  });
});
