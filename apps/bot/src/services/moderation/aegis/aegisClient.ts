/**
 * Client de l'API AegisAI (marvideo) : `/scan` rend en un appel la toxicité
 * et l'émotion d'un texte. Chaque requête porte `save` : le texte n'entre dans
 * le jeu d'entraînement d'AegisAI que si le serveur l'a accepté.
 *
 * Mesuré le 2026-10-05 : ~110 ms par appel, débit borné côté serveur. La capacité doit augmenter : rien ici ne la suppose, la file
 * (aegisQueue.ts) ajuste sa concurrence sur la latence relevée par ce client.
 * Ici, un coupe-circuit : après une série d'échecs on cesse d'appeler pendant
 * un moment au lieu d'empiler des requêtes qui expireront toutes.
 */
import { logger } from '../../../utils/logger.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const AEGIS_EMOTIONS = ['joy', 'sad', 'anger', 'fear', 'surprise', 'neutral'] as const;
export type AegisEmotion = (typeof AEGIS_EMOTIONS)[number];

export type ToxicityResult = { toxicity: number };
export type EmotionResult = { label: AegisEmotion; score: number };
export type ScanResult = { toxicity: number; emotion: EmotionResult };

/** L'API n'a pas été appelée : clé absente ou coupe-circuit ouvert. */
export class AegisUnavailableError extends Error {
  constructor(public readonly reason: 'not_configured' | 'circuit_open') {
    super(reason === 'not_configured' ? 'AEGISAI_API_KEY absente' : 'AegisAI suspendu après une série d’échecs');
    this.name = 'AegisUnavailableError';
  }
}

/** L'API a répondu autre chose qu'un résultat exploitable. */
export class AegisRequestError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'AegisRequestError';
  }
}

const DEFAULT_BASE_URL = 'https://aegisai.marvideo.fr';
const FAILURES_BEFORE_OPEN = 5;
const OPEN_DURATION_MS = 30_000;
const LATENCY_SAMPLES = 200;

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** `{"is_toxic": bool, "toxicity": 0..1}`. `is_toxic` est ignoré : les seuils sont les nôtres. */
export function parseToxicityResponse(body: unknown): ToxicityResult | null {
  if (!body || typeof body !== 'object') return null;
  const { toxicity } = body as { toxicity?: unknown };
  return isScore(toxicity) ? { toxicity } : null;
}

/** `{"label": "anger", "score": 0..1}`. Un label inconnu est refusé plutôt que deviné. */
export function parseEmotionResponse(body: unknown): EmotionResult | null {
  if (!body || typeof body !== 'object') return null;
  const { label, score } = body as { label?: unknown; score?: unknown };
  if (typeof label !== 'string' || !(AEGIS_EMOTIONS as readonly string[]).includes(label)) return null;
  return isScore(score) ? { label: label as AegisEmotion, score } : null;
}

/** `{"toxic": {...}, "emotion": {...}}` : les deux parties doivent être lisibles. */
export function parseScanResponse(body: unknown): ScanResult | null {
  if (!body || typeof body !== 'object') return null;
  const { toxic, emotion } = body as { toxic?: unknown; emotion?: unknown };
  const toxicity = parseToxicityResponse(toxic);
  const parsedEmotion = parseEmotionResponse(emotion);
  return toxicity && parsedEmotion ? { toxicity: toxicity.toxicity, emotion: parsedEmotion } : null;
}

export type AegisClientStatus = {
  configured: boolean;
  circuit: 'closed' | 'open';
  openUntil: number | null;
  consecutiveFailures: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  requests: number;
  failures: number;
};

export type AegisClientOptions = {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  now?: () => number;
};

export class AegisClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  private consecutiveFailures = 0;
  private openUntil = 0;
  private latencies: number[] = [];
  private requests = 0;
  private failures = 0;
  // Fenêtre courante pour le réglage de la concurrence (voir takeWindow).
  private windowLatencies: number[] = [];
  private windowOverload = 0;

  constructor(options: AegisClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.AEGISAI_API_KEY ?? '';
    this.baseUrl = (options.baseUrl ?? process.env.AEGISAI_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? readPositiveInt(process.env.AEGISAI_TIMEOUT_MS, 5000);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  get configured(): boolean {
    return this.apiKey.length > 0;
  }

  /** Vrai si un appel partirait maintenant. */
  get available(): boolean {
    return this.configured && this.now() >= this.openUntil;
  }

  /** Temps restant avant la réouverture du circuit, 0 s'il est fermé. */
  get retryInMs(): number {
    return Math.max(0, this.openUntil - this.now());
  }

  /**
   * Toxicité (0 à 1) et émotion dominante en un appel. `save` verse le texte
   * dans le jeu d'entraînement d'AegisAI : il suit le choix du serveur.
   */
  async scan(text: string, save: boolean): Promise<ScanResult> {
    const body = await this.post('scan', { text, save });
    const parsed = parseScanResponse(body);
    if (!parsed) throw this.malformed('scan', body);
    return parsed;
  }

  status(): AegisClientStatus {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const pick = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]! : null);
    return {
      configured: this.configured,
      circuit: this.now() < this.openUntil ? 'open' : 'closed',
      openUntil: this.now() < this.openUntil ? this.openUntil : null,
      consecutiveFailures: this.consecutiveFailures,
      latencyP50Ms: pick(0.5),
      latencyP95Ms: pick(0.95),
      requests: this.requests,
      failures: this.failures,
    };
  }

  /**
   * Latence médiane et signes de surcharge (429, 5xx, délais dépassés) depuis
   * le dernier appel, puis remise à zéro. Lu par le régulateur de la file.
   */
  takeWindow(): { requests: number; p50Ms: number | null; overloaded: number } {
    const sorted = this.windowLatencies.sort((a, b) => a - b);
    const result = {
      requests: sorted.length,
      p50Ms: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null,
      overloaded: this.windowOverload,
    };
    this.windowLatencies = [];
    this.windowOverload = 0;
    return result;
  }

  private malformed(route: string, body: unknown): AegisRequestError {
    // Une réponse 200 illisible est une panne côté API : elle compte comme
    // un échec pour le coupe-circuit.
    this.recordFailure();
    return new AegisRequestError(200, `Réponse inattendue de /${route} : ${JSON.stringify(body)?.slice(0, 200)}`);
  }

  private recordFailure(): void {
    this.failures += 1;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= FAILURES_BEFORE_OPEN) {
      this.openUntil = this.now() + OPEN_DURATION_MS;
      this.consecutiveFailures = 0;
      logger.warn('AegisAI', `${FAILURES_BEFORE_OPEN} échecs d'affilée : appels suspendus ${OPEN_DURATION_MS / 1000} s.`);
    }
  }

  private recordLatency(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > LATENCY_SAMPLES) this.latencies.shift();
    if (this.windowLatencies.length < 10_000) this.windowLatencies.push(ms);
  }

  private async post(route: string, payload: Record<string, unknown>): Promise<unknown> {
    if (!this.configured) throw new AegisUnavailableError('not_configured');
    if (this.now() < this.openUntil) throw new AegisUnavailableError('circuit_open');

    this.requests += 1;
    const started = this.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/${route}`, {
        method: 'POST',
        headers: {
          Authorization: `Aegis ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'Kotbo',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      this.recordLatency(this.now() - started);

      if (!res.ok) {
        // Un 4xx dit que notre requête est fautive, pas que l'API est
        // tombée : il ne doit pas ouvrir le circuit. 401/403 font exception,
        // une clé refusée fera échouer tous les appels suivants.
        if (res.status >= 500 || res.status === 401 || res.status === 403 || res.status === 429) this.recordFailure();
        if (res.status >= 500 || res.status === 429) this.windowOverload += 1;
        const detail = (await res.text().catch(() => '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
        throw new AegisRequestError(res.status, `/${route} a répondu ${res.status}${detail ? ` : ${detail}` : ''}`);
      }

      const body: unknown = await res.json().catch(() => null);
      this.consecutiveFailures = 0;
      return body;
    } catch (error) {
      if (error instanceof AegisRequestError) throw error;
      this.recordFailure();
      const aborted = error instanceof Error && error.name === 'AbortError';
      if (aborted) this.windowOverload += 1;
      throw new AegisRequestError(0, aborted ? `/${route} : pas de réponse en ${this.timeoutMs} ms` : `/${route} injoignable : ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

let shared: AegisClient | null = null;

/** Client partagé du process (un seul bot : le coupe-circuit vaut pour tous les serveurs). */
export function getAegisClient(): AegisClient {
  shared ??= new AegisClient();
  return shared;
}
