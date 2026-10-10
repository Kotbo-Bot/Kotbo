/**
 * scamBackfillService.ts - Rattrapage du jeu de données d'arnaques sur l'historique.
 *
 * Le honeypot n'enregistrait que les empreintes d'image. Tout ce qu'il a piégé
 * avant l'ajout des domaines, des textes et de l'OCR reste exploitable :
 *
 *  - les transcripts du salon piège contiennent le texte des messages et l'URL
 *    de leurs images. On les retrouve par le lien cité dans chaque sanction
 *    honeypot (ce qui couvre aussi un ancien salon piège), et par le salon piège
 *    actuel de chaque serveur ;
 *  - les empreintes d'image déjà collectées sont soumises à la promotion en
 *    global, qui n'existait pas quand elles ont été enregistrées.
 *
 * Limite assumée : les URL d'images Discord sont signées et expirent, et le
 * message a été supprimé par le honeypot. Seules les images encore
 * téléchargeables sont relues par OCR ; les autres sont comptées comme perdues.
 *
 * Le rattrapage est idempotent : une observation déjà connue n'est pas
 * recomptée, on peut donc le relancer.
 */

import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { parseTranscriptHtml } from '../features/transcriptService.js';
import { GLOBAL_PROMOTION_GUILDS, promoteImageIfWidespread, recordScamSignals } from './scamDatasetService.js';
import { recordScamImageFromUrl } from './scamFilterService.js';
import { scoreScamText, suspiciousDomainsOf } from './scamHeuristics.js';

const TRANSCRIPT_LINK = /\/transcripts\/([a-z0-9]+)/gi;
const HONEYPOT_REASON_PREFIX = 'Kotbo Honeypot';

export type BackfillOptions = {
  /** Ne rien écrire : compter seulement ce qui serait enregistré. */
  dryRun?: boolean;
  /** Limiter à un serveur. */
  guildId?: string;
  /** Tenter de retélécharger les images (lent : une lecture OCR par image). */
  withImages?: boolean;
};

export type BackfillReport = {
  transcripts: number;
  messages: number;
  textsWithSignals: number;
  domains: string[];
  imagesTried: number;
  imagesRecorded: number;
  imageHashesPromoted: number;
};

/** Identifiants des transcripts produits par le honeypot, par serveur. */
export async function findHoneypotTranscriptIds(guildId?: string): Promise<Map<string, string>> {
  const ids = new Map<string, string>(); // transcriptId → guildId

  const sanctions = await prisma.sanction.findMany({
    where: { reason: { startsWith: HONEYPOT_REASON_PREFIX }, ...(guildId ? { guildId } : {}) },
    select: { guildId: true, reason: true },
  });
  for (const sanction of sanctions) {
    for (const match of sanction.reason.matchAll(TRANSCRIPT_LINK)) ids.set(match[1], sanction.guildId);
  }

  // Salon piège actuel : couvre les détections dont la sanction a échoué ou
  // a été supprimée depuis.
  const guilds = await prisma.guild.findMany({
    where: { honeypotChannelId: { not: null }, ...(guildId ? { id: guildId } : {}) },
    select: { id: true, honeypotChannelId: true },
  });
  for (const guild of guilds) {
    const transcripts = await prisma.transcript.findMany({
      where: { guildId: guild.id, channelId: guild.honeypotChannelId! },
      select: { id: true },
    });
    for (const t of transcripts) ids.set(t.id, guild.id);
  }

  return ids;
}

/** Les empreintes d'image collectées avant la promotion en global la reçoivent. */
async function promoteExistingImageHashes(dryRun: boolean): Promise<number> {
  const groups = await prisma.scamImageHash.groupBy({
    by: ['hash'],
    where: { guildId: { not: null } },
    _count: { guildId: true },
  });
  const widespread = groups.filter((g) => g._count.guildId >= GLOBAL_PROMOTION_GUILDS);
  if (dryRun) return widespread.length;

  for (const group of widespread) {
    const sample = await prisma.scamImageHash.findFirst({
      where: { hash: group.hash, guildId: { not: null } },
      select: { phash: true, filename: true },
    });
    await promoteImageIfWidespread(group.hash, sample?.phash ?? null, sample?.filename ?? null);
  }
  return widespread.length;
}

export async function backfillScamDatasetFromHoneypots(options: BackfillOptions = {}): Promise<BackfillReport> {
  const dryRun = options.dryRun ?? false;
  const report: BackfillReport = {
    transcripts: 0,
    messages: 0,
    textsWithSignals: 0,
    domains: [],
    imagesTried: 0,
    imagesRecorded: 0,
    imageHashesPromoted: 0,
  };
  const domains = new Set<string>();

  const transcriptIds = await findHoneypotTranscriptIds(options.guildId);

  for (const [transcriptId, guildId] of transcriptIds) {
    const transcript = await prisma.transcript.findUnique({ where: { id: transcriptId }, select: { html: true } });
    if (!transcript) continue;
    report.transcripts++;

    // Un même salon piège apparaît dans plusieurs transcripts (message
    // d'avertissement du staff, par exemple) : on ne traite chaque texte et
    // chaque image qu'une fois.
    const seenTexts = new Set<string>();
    for (const message of parseTranscriptHtml(transcript.html)) {
      if (message.isBot) continue;
      report.messages++;

      const text = message.content.trim();
      if (text && !seenTexts.has(text)) {
        seenTexts.add(text);
        const found = suspiciousDomainsOf(text);
        found.forEach((d) => domains.add(d));
        if (scoreScamText(text).signals.length >= 2) report.textsWithSignals++;
        if (!dryRun) await recordScamSignals(guildId, text, 'HONEYPOT', { countRepeat: false });
      }

      if (options.withImages) {
        for (const url of message.imageUrls) {
          report.imagesTried++;
          if (dryRun) continue;
          const name = decodeURIComponent(url.split('?')[0].split('/').pop() ?? 'image');
          if (await recordScamImageFromUrl(guildId, url, name)) report.imagesRecorded++;
        }
      }
    }
  }

  report.imageHashesPromoted = await promoteExistingImageHashes(dryRun);
  report.domains = [...domains].sort();

  logger.info(
    'ScamBackfill',
    `${dryRun ? '[simulation] ' : ''}${report.transcripts} transcript(s), ${report.messages} message(s), ` +
      `${report.domains.length} domaine(s), ${report.imagesRecorded}/${report.imagesTried} image(s), ` +
      `${report.imageHashesPromoted} empreinte(s) d'image promue(s)`
  );
  return report;
}

// ── Lancement automatique, une fois ─────────────────────────────────────────

/** Changer la version relance le rattrapage au prochain démarrage. */
const BACKFILL_MARKER_KEY = 'SCAM_DATASET_BACKFILL_V1';
const START_DELAY_MS = 3 * 60_000;
let scheduled = false;

/**
 * Programme le rattrapage après le démarrage, une seule fois pour toute
 * l'instance : il ne lit que la base, le lancer sur chaque shard ne ferait que
 * répéter le même travail. Le marqueur n'est posé qu'en cas de succès.
 */
export function scheduleScamDatasetBackfill(shardIds: readonly number[] | undefined): void {
  if (scheduled) return;
  scheduled = true;
  if (shardIds && !shardIds.includes(0)) return;

  setTimeout(() => {
    void (async () => {
      const done = await prisma.botGlobalConfig.findUnique({ where: { key: BACKFILL_MARKER_KEY } });
      if (done) return;

      const report = await backfillScamDatasetFromHoneypots({ withImages: true });
      const value = JSON.stringify({ ...report, domains: report.domains.length, completedAt: new Date().toISOString() });
      await prisma.botGlobalConfig.upsert({
        where: { key: BACKFILL_MARKER_KEY },
        create: { key: BACKFILL_MARKER_KEY, value },
        update: { value },
      });
    })().catch((err) => logger.error('ScamBackfill', 'Rattrapage interrompu :', err));
  }, START_DELAY_MS).unref?.();
}
