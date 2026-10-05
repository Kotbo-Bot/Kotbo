import { describe, expect, test } from 'bun:test';
import {
  AegisClient,
  AegisRequestError,
  AegisUnavailableError,
  parseEmotionResponse,
  parseScanResponse,
  parseToxicityResponse,
  type FetchLike,
} from '../../services/moderation/aegis/aegisClient';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const SCAN_OK = { emotion: { label: 'anger', score: 0.9269 }, toxic: { is_toxic: true, toxicity: 0.974 } };

describe('parseToxicityResponse', () => {
  test('lit le score et ignore is_toxic', () => {
    expect(parseToxicityResponse({ is_toxic: false, toxicity: 0.8325 })).toEqual({ toxicity: 0.8325 });
  });

  test('refuse un score absent ou hors bornes', () => {
    expect(parseToxicityResponse({ is_toxic: true })).toBeNull();
    expect(parseToxicityResponse({ toxicity: 1.2 })).toBeNull();
    expect(parseToxicityResponse({ toxicity: '0.5' })).toBeNull();
    expect(parseToxicityResponse(null)).toBeNull();
  });
});

describe('parseEmotionResponse', () => {
  test('lit un label connu', () => {
    expect(parseEmotionResponse({ label: 'anger', score: 0.9269 })).toEqual({ label: 'anger', score: 0.9269 });
  });

  test('refuse un label inconnu plutôt que de le deviner', () => {
    expect(parseEmotionResponse({ label: 'disgust', score: 0.9 })).toBeNull();
    expect(parseEmotionResponse({ label: 'joy' })).toBeNull();
  });
});

describe('parseScanResponse', () => {
  test('réunit toxicité et émotion', () => {
    expect(parseScanResponse(SCAN_OK)).toEqual({ toxicity: 0.974, emotion: { label: 'anger', score: 0.9269 } });
  });

  test('refuse une réponse à moitié lisible', () => {
    expect(parseScanResponse({ toxic: { toxicity: 0.5 } })).toBeNull();
    expect(parseScanResponse({ emotion: { label: 'joy', score: 0.9 } })).toBeNull();
    expect(parseScanResponse({ error: 'No text provided' })).toBeNull();
  });
});

describe('AegisClient', () => {
  test('envoie le texte et save sur /scan, avec la clé au format Aegis', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(SCAN_OK);
    };
    const client = new AegisClient({ apiKey: 'ag_test', baseUrl: 'https://api.test/', fetchImpl });

    expect(await client.scan('bonjour', true)).toEqual({ toxicity: 0.974, emotion: { label: 'anger', score: 0.9269 } });
    expect(calls[0]!.url).toBe('https://api.test/scan');
    expect(new Headers(calls[0]!.init?.headers).get('Authorization')).toBe('Aegis ag_test');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ text: 'bonjour', save: true });
  });

  test('save part à false quand le serveur ne partage pas', async () => {
    let body: unknown;
    const client = new AegisClient({
      apiKey: 'k',
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return jsonResponse(SCAN_OK);
      },
    });
    await client.scan('trop content', false);
    expect(body).toEqual({ text: 'trop content', save: false });
  });

  test("sans clé, aucun appel ne part", async () => {
    let called = false;
    const client = new AegisClient({ apiKey: '', fetchImpl: async () => { called = true; return jsonResponse({}); } });
    await expect(client.scan('x', false)).rejects.toBeInstanceOf(AegisUnavailableError);
    expect(called).toBe(false);
  });

  test('le circuit s’ouvre après cinq pannes et se referme 30 s plus tard', async () => {
    let now = 1_000;
    let calls = 0;
    const client = new AegisClient({
      apiKey: 'k',
      now: () => now,
      fetchImpl: async () => { calls += 1; return new Response('boom', { status: 502 }); },
    });

    for (let i = 0; i < 5; i += 1) await expect(client.scan('x', false)).rejects.toBeInstanceOf(AegisRequestError);
    expect(client.available).toBe(false);
    await expect(client.scan('x', false)).rejects.toBeInstanceOf(AegisUnavailableError);
    expect(calls).toBe(5);

    now += 30_000;
    expect(client.available).toBe(true);
  });

  test('un 400 ne compte pas comme une panne', async () => {
    const client = new AegisClient({
      apiKey: 'k',
      fetchImpl: async () => jsonResponse({ error: 'No text provided' }, 400),
    });
    for (let i = 0; i < 6; i += 1) await expect(client.scan('', false)).rejects.toBeInstanceOf(AegisRequestError);
    expect(client.available).toBe(true);
  });

  test('une réponse 200 illisible est une erreur', async () => {
    const client = new AegisClient({ apiKey: 'k', fetchImpl: async () => jsonResponse({ ok: true }) });
    await expect(client.scan('x', false)).rejects.toBeInstanceOf(AegisRequestError);
  });

  test('takeWindow rend la latence et la surcharge puis repart de zéro', async () => {
    let status = 200;
    const client = new AegisClient({
      apiKey: 'k',
      fetchImpl: async () => (status === 200 ? jsonResponse(SCAN_OK) : new Response('', { status })),
    });
    await client.scan('a', false);
    status = 429;
    await expect(client.scan('b', false)).rejects.toBeInstanceOf(AegisRequestError);
    const window = client.takeWindow();
    expect(window.requests).toBe(2);
    expect(window.overloaded).toBe(1);
    expect(client.takeWindow()).toEqual({ requests: 0, p50Ms: null, overloaded: 0 });
  });
});
