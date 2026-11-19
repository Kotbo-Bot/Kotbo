import { describe, expect, test, mock } from 'bun:test';
import { ButtonStyle, ComponentType, type Client } from 'discord.js';
import type { PrismaClient } from '@prisma/client';
import { VerificationService } from '@kotbo/core';
import { DiscordAdapter } from '../../adapters/discord.adapter.js';

/**
 * L'embed de vérification déployé depuis le dashboard doit ouvrir une vraie
 * session : son bouton est celui que traite le handler d'interaction
 * (`secverif_start_<serveur>`), qui crée la session et rend un lien jetonné.
 */

const GUILD = '600000000000000001';

type SentMessage = { components: Array<{ toJSON(): { components: unknown[] } }> };

describe('embed de vérification déployé depuis le dashboard', () => {
  test('le bouton lance le parcours de vérification du bot, pas un lien sans jeton', async () => {
    const send = mock(async (_message: SentMessage) => ({ id: 'message-1' }));
    const client = {
      guilds: {
        cache: new Map([[GUILD, { channels: { fetch: async () => ({ isTextBased: () => true, send }) } }]]),
      },
    } as unknown as Client;
    const db = {
      guild: {
        findUnique: async () => ({
          verificationEnabled: true,
          verificationEmbedTitle: 'Vérification',
          verificationEmbedDesc: 'Cliquez pour vous vérifier.',
          verificationEmbedColor: '#5865F2',
        }),
      },
    } as unknown as PrismaClient;

    const service = new VerificationService(db, new DiscordAdapter(client));
    const result = await service.deployVerificationEmbed({
      guildId: GUILD,
      channelId: '600000000000000002',
      dashboardUrl: 'https://kotbo.fr',
    });

    expect(result).toEqual({ success: true });
    expect(send.mock.calls[0][0].components[0].toJSON().components).toEqual([
      {
        type: ComponentType.Button,
        label: 'Vérifier mon identité',
        style: ButtonStyle.Primary,
        custom_id: `secverif_start_${GUILD}`,
      },
    ]);
  });
});
