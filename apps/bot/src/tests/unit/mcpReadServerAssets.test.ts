import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';
import type { McpToolContext, McpToolHandler } from '../../api/mcp/toolkit.js';

for (const file of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(import.meta.dir, file), () => ({ default: {}, prisma: {}, prismaRead: {} }));
}

const { registerReadServerAssetsTools } = await import('../../api/mcp/tools/read-server-assets.js');

const GUILD_ID = '111111111111111111';
const CHANNEL_ID = '222222222222222222';
const TOKEN = 'jeton-secret-du-webhook';

/** Webhook tel que discord.js le rend : son `url` porte le jeton. */
const webhook = {
  id: '333333333333333333',
  name: 'Annonces',
  channelId: CHANNEL_ID,
  owner: { id: '444444444444444444', username: 'admin', tag: 'admin#0' },
  token: TOKEN,
  url: `https://discord.com/api/webhooks/333333333333333333/${TOKEN}`,
  avatarURL: () => 'https://cdn.discordapp.com/avatars/333333333333333333/a.png',
};
const guild = {
  fetchWebhooks: async () => [webhook],
  channels: { cache: new Map([[CHANNEL_ID, { isTextBased: () => true, fetchWebhooks: async () => [webhook] }]]) },
};

const handlers = new Map<string, McpToolHandler>();
registerReadServerAssetsTools({
  server: { registerTool: (name: string, _config: unknown, handler: McpToolHandler) => handlers.set(name, handler) },
  guildId: GUILD_ID,
  client: { guilds: { cache: new Map([[GUILD_ID, guild]]) } } as unknown as Client,
  shouldRegister: () => true,
  guard: (_permission: unknown, handler: McpToolHandler) => handler,
} as unknown as McpToolContext);

describe('get_webhooks', () => {
  test('ne livre ni l\'URL ni le jeton des webhooks, sur le serveur comme sur un salon', async () => {
    for (const args of [{}, { channel: CHANNEL_ID }]) {
      const [content] = (await handlers.get('get_webhooks')!(args)).content;
      const text = content.type === 'text' ? content.text : '';
      expect(text).not.toContain(TOKEN);
      // Le reste de la fiche reste disponible.
      expect(JSON.parse(text)).toEqual([
        {
          id: '333333333333333333',
          name: 'Annonces',
          channelId: CHANNEL_ID,
          creatorId: '444444444444444444',
          creatorTag: 'admin#0',
          avatar: 'https://cdn.discordapp.com/avatars/333333333333333333/a.png',
        },
      ]);
    }
  });
});
