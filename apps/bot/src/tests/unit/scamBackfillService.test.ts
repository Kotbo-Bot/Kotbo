/**
 * Rattrapage du jeu de données d'arnaques à partir des transcripts du honeypot.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

const message = (username: string, text: string, opts: { bot?: boolean; image?: string } = {}) =>
  `<div class="message-group"><img class="avatar" src="a.png" />` +
  `<span class="username" style="color:#fff">${username}</span>${opts.bot ? '<span class="bot-tag">BOT</span>' : ''}` +
  `<span class="timestamp">1 oct.</span><div class="message-text">${text}</div>` +
  (opts.image ? `<img src="${opts.image}" class="discord-img" alt="Image jointe" loading="lazy" />` : '') +
  `</div>`;

const SCAM = 'MrBeast is giving away $3,500 to everyone who registers, promo code TAKE on sedowin.com, hurry';

let sanctions: { guildId: string; reason: string }[];
let guilds: { id: string; honeypotChannelId: string | null }[];
let transcripts: { id: string; guildId: string; channelId: string; html: string }[];
let imageGroups: { hash: string; _count: { guildId: number } }[];

const prismaMock = {
  sanction: { findMany: async () => sanctions },
  guild: { findMany: async () => guilds },
  transcript: {
    findMany: async ({ where }: { where: { guildId: string; channelId: string } }) =>
      transcripts.filter((t) => t.guildId === where.guildId && t.channelId === where.channelId),
    findUnique: async ({ where }: { where: { id: string } }) => transcripts.find((t) => t.id === where.id) ?? null,
  },
  scamImageHash: {
    groupBy: async () => imageGroups,
    findFirst: async () => ({ phash: '0f', filename: 'x.png' }),
  },
  botGlobalConfig: { findUnique: async () => null, upsert: async () => null },
};

const recorded: { guildId: string; text: string; countRepeat?: boolean }[] = [];
const promotedImages: string[] = [];
const imageUrls: string[] = [];
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, success: () => {}, debug: () => {} };

for (const extension of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db.${extension}`), () => ({ default: prismaMock }));
  mock.module(path.resolve(import.meta.dir, `../../utils/logger.${extension}`), () => ({
    logger: silentLogger,
    default: silentLogger,
  }));
  mock.module(path.resolve(import.meta.dir, `../../services/moderation/scamDatasetService.${extension}`), () => ({
    GLOBAL_PROMOTION_GUILDS: 3,
    recordScamSignals: async (guildId: string, text: string, _source: string, options: { countRepeat?: boolean }) => {
      recorded.push({ guildId, text, countRepeat: options?.countRepeat });
      return { domains: [], textRecorded: true };
    },
    promoteImageIfWidespread: async (hash: string) => {
      promotedImages.push(hash);
    },
  }));
  mock.module(path.resolve(import.meta.dir, `../../services/moderation/scamFilterService.${extension}`), () => ({
    recordScamImageFromUrl: async (_guildId: string, url: string) => {
      imageUrls.push(url);
      return url.includes('fresh');
    },
  }));
}

const { backfillScamDatasetFromHoneypots, findHoneypotTranscriptIds } = await import(
  '../../services/moderation/scamBackfillService.js'
);

beforeEach(() => {
  sanctions = [];
  guilds = [];
  transcripts = [];
  imageGroups = [];
  recorded.length = 0;
  promotedImages.length = 0;
  imageUrls.length = 0;
});

describe('findHoneypotTranscriptIds', () => {
  test('retrouve les transcripts cités par les sanctions honeypot et ceux du salon piège actuel', async () => {
    sanctions = [
      { guildId: 'g1', reason: 'Kotbo Honeypot: Sent a message...\nProof/Transcript: https://dash.kotbo.fr/transcripts/abc123' },
    ];
    guilds = [{ id: 'g2', honeypotChannelId: 'trap' }];
    transcripts = [{ id: 'def456', guildId: 'g2', channelId: 'trap', html: '' }];

    const ids = await findHoneypotTranscriptIds();
    expect([...ids.entries()]).toEqual([
      ['abc123', 'g1'],
      ['def456', 'g2'],
    ]);
  });
});

describe('backfillScamDatasetFromHoneypots', () => {
  beforeEach(() => {
    guilds = [{ id: 'g1', honeypotChannelId: 'trap' }];
    transcripts = [
      {
        id: 't1',
        guildId: 'g1',
        channelId: 'trap',
        html:
          message('Kotbo', 'Ne pas écrire ici', { bot: true }) +
          message('spammer', SCAM, { image: 'https://cdn.discordapp.com/attachments/1/2/fresh.png' }) +
          message('spammer', SCAM, { image: 'https://cdn.discordapp.com/attachments/1/3/expired.png' }),
      },
    ];
  });

  test('enregistre chaque texte une fois, sans recompter, et ignore les bots', async () => {
    const report = await backfillScamDatasetFromHoneypots();

    expect(recorded).toEqual([{ guildId: 'g1', text: SCAM, countRepeat: false }]);
    expect(report.messages).toBe(2);
    expect(report.domains).toEqual(['sedowin.com']);
    expect(report.textsWithSignals).toBe(1);
  });

  test('ne retélécharge les images que si demandé, et compte les liens expirés', async () => {
    expect((await backfillScamDatasetFromHoneypots()).imagesTried).toBe(0);

    const report = await backfillScamDatasetFromHoneypots({ withImages: true });
    expect(report.imagesTried).toBe(2);
    expect(report.imagesRecorded).toBe(1);
  });

  test('la simulation n’écrit rien', async () => {
    imageGroups = [{ hash: 'h1', _count: { guildId: 4 } }];
    const report = await backfillScamDatasetFromHoneypots({ dryRun: true, withImages: true });

    expect(recorded).toHaveLength(0);
    expect(imageUrls).toHaveLength(0);
    expect(promotedImages).toHaveLength(0);
    expect(report.imageHashesPromoted).toBe(1);
  });

  test('promeut les empreintes d’image déjà vues sur assez de serveurs', async () => {
    imageGroups = [
      { hash: 'h1', _count: { guildId: 3 } },
      { hash: 'h2', _count: { guildId: 1 } },
    ];
    await backfillScamDatasetFromHoneypots();
    expect(promotedImages).toEqual(['h1']);
  });
});
