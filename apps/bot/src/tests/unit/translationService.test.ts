import { describe, expect, test } from 'bun:test';
import { createTranslationService } from '../../services/integrations/translationService';

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
