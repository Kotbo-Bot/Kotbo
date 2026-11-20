import { describe, expect, mock, test } from 'bun:test';
import type { Client } from 'discord.js';

const ticket = {
  id: 't1', guildId: 'g', userId: '2', username: 'bob', reason: 'Aide', description: null,
  status: 'CLOSED', transcriptId: 'tr', restoreCount: 3, lastRestoredAt: new Date('2026-01-01'), categoryId: null, staffRoleId: null,
};

mock.module('../../utils/db.js', () => {
  const db = {
    ticket: { findUnique: async () => ticket, update: async ({ data }: { data: object }) => ({ ...ticket, ...data }) },
    guild: { findUnique: async () => ({ ticketQuotaReopenEnabled: true, ticketQuotaReopenMax: 5 }) },
    transcript: { findUnique: async () => ({ html: '' }) },
  };
  return { default: db, prisma: db, prismaRead: db };
});

const { restoreTicketFromTranscript } = await import('../../services/features/ticketLifecycleService.js');

describe('restauration d\'un ticket depuis sa transcription', () => {
  test('le quota de réouvertures du serveur s\'applique, au-delà du défaut de 3', async () => {
    const salon = { id: 'nouveau', send: async () => {} };
    const client = { guilds: { cache: { get: () => ({ roles: { everyone: { id: 'g' } }, channels: { create: async () => salon } }) } } } as unknown as Client;

    const restauration = await restoreTicketFromTranscript(client, 't1', { id: '1', username: 'Modo' });

    expect(restauration.ticket.restoreCount).toBe(4);
  });
});
