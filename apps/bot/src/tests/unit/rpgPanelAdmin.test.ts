import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { PermissionFlagsBits, PermissionsBitField, type EmbedBuilder, type ModalSubmitInteraction } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

const mockDb = new Proxy({}, { get: () => new Proxy({}, { get: () => async () => null }) });
mock.module('../../utils/db.js', () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
const adminSetStats = mock(async () => {});
mock.module('../../services/features/economyService.js', () =>
  completeModuleMock(path.resolve(import.meta.dir, '../../services/features/economyService.ts'), { adminSetStats }));
// La validation du dashboard et de MCP, observée sans être remplacée.
const adminJoueur = await import('../../services/features/rpg/rpgPlayerAdminService.js');
const checkPlayerStats = mock(adminJoueur.checkPlayerStats);
mock.module('../../services/features/rpg/rpgPlayerAdminService.js', () => ({ ...adminJoueur, checkPlayerStats }));

const { handleRpgModalSubmit } = await import('../../services/features/rpgPanelService.js');

describe('panneau admin /rpg : fixer une statistique', () => {
  test('un solde négatif est refusé sans rien écrire', async () => {
    const reply = mock(async (_: { embeds: EmbedBuilder[] }) => {});
    const interaction = {
      guildId: 'g',
      user: { id: '1' },
      memberPermissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
      fields: { getTextInputValue: (champ: string) => (champ === 'membre' ? '200000000000000001' : '-500') },
      reply,
    } as unknown as ModalSubmitInteraction;

    await handleRpgModalSubmit({} as never, 'rpg:adminsetsubmit:1:balance', interaction);

    expect(checkPlayerStats).toHaveBeenCalledWith({ balance: -500 });
    expect(adminSetStats).not.toHaveBeenCalled();
    expect(reply.mock.calls[0][0].embeds[0].data.description).toContain('entre 0 et');
  });
});
