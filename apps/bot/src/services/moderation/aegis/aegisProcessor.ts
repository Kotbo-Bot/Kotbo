/**
 * Traitement d'un job de la file AegisAI : note (`/scan`), statistiques,
 * décision de modération et modules dérivés.
 *
 * Une panne d'AegisAI ne laisse pas passer une insulte évidente : la liste de
 * mots bannis du serveur prend le relais et envoie le message en revue (jamais
 * d'action automatique sur ce seul repli).
 */
import type { Client } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import { containsBannedWord, loadBannedWords } from '../bannedWordsService.js';
import { AegisUnavailableError, getAegisClient, type EmotionResult, type ScanResult } from './aegisClient.js';
import { getAegisConfig, type AegisRuntimeConfig } from './aegisConfig.js';
import { isLate, type AegisJob } from './aegisQueue.js';
import { recordAegisObservation } from './aegisStats.js';
import { chunkText, textFingerprint } from './aegisText.js';
import { ConflictTracker, CooldownGate, HarassmentTracker, decideToxicity, isDistress, isHeated } from './aegisSignals.js';
import { handleToxic } from './aegisActions.js';
import { raiseConflict, raiseDistress, raiseHarassment, updateTicketMood } from './aegisModules.js';

let discordClient: Client | null = null;

export function setAegisDiscordClient(client: Client): void {
  discordClient = client;
}

// ── Cache des notes ─────────────────────────────────────────────────────────
// Un raid copie-colle le même texte des centaines de fois : une note suffit.
// La clé porte `save` : un texte noté sans partage n'est pas réputé partagé.

const RESULT_TTL_MS = 10 * 60_000;
const RESULT_MAX = 5000;
const scanCache = new Map<string, { value: ScanResult; at: number }>();

function cached(key: string): ScanResult | undefined {
  const hit = scanCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > RESULT_TTL_MS) {
    scanCache.delete(key);
    return undefined;
  }
  return hit.value;
}

function remember(key: string, value: ScanResult): void {
  scanCache.set(key, { value, at: Date.now() });
  if (scanCache.size > RESULT_MAX) scanCache.delete(scanCache.keys().next().value!);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Attend la réouverture du circuit plutôt que de perdre le job. */
async function waitForApi(): Promise<void> {
  const api = getAegisClient();
  if (!api.available && api.configured) await sleep(Math.min(api.retryInMs, 30_000));
}

/**
 * Note d'un texte : la pire toxicité de ses morceaux (le modèle dilue un long
 * texte), l'émotion du premier. On s'arrête dès qu'un morceau franchit le
 * seuil automatique.
 */
export async function scanText(text: string, save: boolean, autoThreshold: number): Promise<ScanResult> {
  const key = `${save ? 1 : 0}:${textFingerprint(text)}`;
  const hit = cached(key);
  if (hit) return hit;
  let result: ScanResult | null = null;
  for (const chunk of chunkText(text)) {
    const scan = await getAegisClient().scan(chunk, save);
    if (!result) result = scan;
    else if (scan.toxicity > result.toxicity) result = { toxicity: scan.toxicity, emotion: result.emotion };
    if (result.toxicity * 100 >= autoThreshold) break;
  }
  remember(key, result!);
  return result!;
}

// ── Modules ─────────────────────────────────────────────────────────────────

const conflicts = new ConflictTracker();
const harassment = new HarassmentTracker();
const distressGate = new CooldownGate();

async function runModules(job: AegisJob, config: AegisRuntimeConfig, toxicity: number | undefined, emotion: EmotionResult | undefined): Promise<void> {
  const client = discordClient;
  const guild = client?.guilds.cache.get(job.guildId);
  if (!client || !guild) return;
  const now = Date.now();
  const toxicEnough = toxicity !== undefined && toxicity * 100 >= config.reviewThreshold;

  if (config.harassmentEnabled && toxicEnough && job.targetUserId && job.targetUserId !== job.authorId) {
    const outcome = harassment.record(`${job.guildId}:${job.authorId}>${job.targetUserId}`, now, {
      windowMs: config.harassmentWindowMin * 60_000,
      threshold: config.harassmentThreshold,
    });
    if (outcome.triggered) await raiseHarassment(client, guild, job, config, outcome.count);
  }

  if (config.conflictEnabled && isHeated(toxicity, emotion, config.reviewThreshold)) {
    const outcome = conflicts.record(`${job.guildId}:${job.channelId}`, job.authorId, now, {
      windowMs: config.conflictWindowSec * 1000,
      threshold: config.conflictMessageThreshold,
      cooldownMs: config.conflictDurationMin * 60_000,
    });
    if (outcome.triggered) await raiseConflict(client, guild, job, config, outcome.authors, outcome.count);
  }

  const distress = isDistress(emotion, toxicity, config);
  if (config.distressEnabled && distress && emotion) {
    if (distressGate.tryPass(`${job.guildId}:${job.authorId}`, now, config.distressCooldownHours * 3_600_000)) {
      await raiseDistress(guild, job, config, emotion, toxicity);
    }
  }

  if (config.analyzeTickets) await updateTicketMood(job, config, emotion, toxicity, distress);
}

// ── Traitement ──────────────────────────────────────────────────────────────

const EXEMPT_NOTE = "Membre exempté (administrateur, rôle ou salon exempté) : pas d'action automatique, à toi de trancher.";

export async function processAegisJob(job: AegisJob): Promise<void> {
  const config = await getAegisConfig(job.guildId);
  if (!config) return;
  const api = getAegisClient();
  if (!api.configured) return;
  await waitForApi();

  let scan: ScanResult | undefined;
  let fallbackHit = false;
  try {
    scan = await scanText(job.text, config.trainingConsent === true, config.autoThreshold);
  } catch (error) {
    const words = await loadBannedWords(job.guildId).catch(() => [] as string[]);
    fallbackHit = containsBannedWord(job.text, words);
    if (!(error instanceof AegisUnavailableError)) logger.warn('AegisAI', `Message non noté (${job.guildId}) :`, error);
  }
  const toxicity = scan?.toxicity;
  // L'émotion d'une édition ou d'un pseudo ne dit rien du climat du salon.
  const emotion = job.source === 'MESSAGE' ? scan?.emotion : undefined;

  if (job.countStats && job.source === 'MESSAGE' && scan) {
    recordAegisObservation({
      guildId: job.guildId,
      channelId: job.statsChannelId,
      userId: job.authorId,
      at: new Date(job.enqueuedAt),
      toxicity,
      emotion: emotion?.label,
      reviewThreshold: config.reviewThreshold,
      autoThreshold: config.autoThreshold,
    });
  }

  const client = discordClient;
  const guild = client?.guilds.cache.get(job.guildId);
  if (!client || !guild) return;

  if (toxicity !== undefined || fallbackHit) {
    const late = isLate(job);
    const decision = toxicity !== undefined ? decideToxicity(toxicity, config, late, job.exempt) : 'review';
    if (decision !== 'none') {
      const wouldAct = toxicity !== undefined && decideToxicity(toxicity, config, false) === 'auto';
      await handleToxic({
        client,
        guild,
        job,
        config,
        toxicity: toxicity ?? null,
        emotion,
        late,
        decision,
        note: job.exempt && wouldAct ? EXEMPT_NOTE : undefined,
      });
    }
  }

  if (job.source === 'MESSAGE') await runModules(job, config, toxicity, emotion);
}
