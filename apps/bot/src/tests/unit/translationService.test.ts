import { afterEach, describe, expect, test } from 'bun:test';
import {
  clearTranslationCacheForTests,
  createTranslationService,
  translate,
} from '../../services/integrations/translationService';

describe('repli MyMemory', () => {
  // `globalThis.fetch` est partagé par tout le process de test : on le rend après chaque cas.
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    clearTranslationCacheForTests();
  });

  /** LibreTranslate injoignable, MyMemory répond `reply` ; renvoie les `langpair` envoyés. */
  function stubFetch(reply: Record<string, unknown>): string[] {
    const langpairs: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname !== 'api.mymemory.translated.net') throw new Error('fetch failed');
      langpairs.push(url.searchParams.get('langpair') ?? '');
      return new Response(JSON.stringify(reply), { status: 200 });
    }) as unknown as typeof fetch;
    return langpairs;
  }

  test('laisse MyMemory détecter la langue source au lieu de forcer en', async () => {
    const langpairs = stubFetch({ responseData: { translatedText: 'Bonjour' }, responseStatus: 200 });

    expect(await translate('Hola', 'fr')).toBe('Bonjour');
    expect(langpairs).toEqual(['autodetect|fr']);
  });

  test('rend le texte tel quel quand il est déjà dans la langue cible', async () => {
    stubFetch({
      responseData: { translatedText: 'PLEASE SELECT TWO DISTINCT LANGUAGES' },
      responseDetails: 'PLEASE SELECT TWO DISTINCT LANGUAGES',
      responseStatus: '403',
    });

    expect(await translate('Bonjour à tous', 'fr')).toBe('Bonjour à tous');
  });

  test('n’appelle pas MyMemory quand source et cible coïncident', async () => {
    const langpairs = stubFetch({ responseStatus: 200 });

    expect(await translate('Hello there', 'en', 'en')).toBe('Hello there');
    expect(langpairs).toEqual([]);
  });
});

describe('translationService', () => {
  test('met en cache une traduction pour eviter les appels repetes', async () => {
    let callCount = 0;
    type TranslationDeps = Parameters<typeof createTranslationService>[0];

    const translator: TranslationDeps['translator'] = async () => {
      callCount += 1;
      return 'bonjour';
    };

    const service = createTranslationService({
      translator,
      log: {
        info: () => {},
        success: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      providerName: 'TestProvider',
    });

    const first = await service.translate('hello', 'FR', 'EN');
    const second = await service.translate('hello', 'FR', 'EN');

    expect(first).toBe('bonjour');
    expect(second).toBe('bonjour');
    expect(callCount).toBe(1);
  });

  test('retourne null en cas d erreur traducteur', async () => {
    type TranslationDeps = Parameters<typeof createTranslationService>[0];

    const translator: TranslationDeps['translator'] = async () => {
      throw new Error('boom');
    };

    const service = createTranslationService({
      translator,
      log: {
        info: () => {},
        success: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      providerName: 'TestProvider',
    });

    const result = await service.translate('hello', 'FR');
    expect(result).toBeNull();
  });

  test('normalise la langue cible invalide vers fr', async () => {
    type TranslationDeps = Parameters<typeof createTranslationService>[0];

    const calls: Array<{ target: string; source?: string }> = [];
    const translator: TranslationDeps['translator'] = async (_text: string, target: string, source?: string) => {
      calls.push({ target, source });
      return 'ok';
    };

    const service = createTranslationService({
      translator,
      log: {
        info: () => {},
        success: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      providerName: 'TestProvider',
    });

    const result = await service.translate('hello', 'LANGUE_INVALIDE');
    expect(result).toBe('ok');
    expect(calls[0]?.target).toBe('fr');
  });

  test('clearCacheForTests vide bien le cache', async () => {
    type TranslationDeps = Parameters<typeof createTranslationService>[0];

    let callCount = 0;
    const translator: TranslationDeps['translator'] = async () => {
      callCount += 1;
      return `res-${callCount}`;
    };

    const service = createTranslationService({
      translator,
      log: {
        info: () => {},
        success: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      providerName: 'TestProvider',
    });

    const a = await service.translate('hello', 'FR');
    service.clearCacheForTests();
    const b = await service.translate('hello', 'FR');

    expect(a).toBe('res-1');
    expect(b).toBe('res-2');
  });

  test('isTranslationAvailable retourne true', () => {
    type TranslationDeps = Parameters<typeof createTranslationService>[0];

    const translator: TranslationDeps['translator'] = async () => 'ok';

    const service = createTranslationService({
      translator,
      log: {
        info: () => {},
        success: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      providerName: 'TestProvider',
    });

    expect(service.isTranslationAvailable()).toBe(true);
  });
});
