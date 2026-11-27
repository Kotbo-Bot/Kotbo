import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

const done: string[] = [];
const retries: Array<() => unknown> = [];
const modules: Record<string, Record<string, unknown>> = {
  'stores/toast.svelte.ts': { toast: { error: (_m: string, _d: number, action: { onClick: () => unknown }) => retries.push(action.onClick) } },
  'stores/onboardingWizard.svelte.ts': { wizard: { markDone: (step: string) => done.push(step) } },
  'i18n.ts': { m: { common_retry: () => 'Réessayer' } },
  'onboarding/celebrate.ts': { play() {} },
};
for (const [file, exports] of Object.entries(modules)) mock.module(path.resolve(import.meta.dir, '..', file), () => exports);

const { saveInBackground, settleSaves } = await import('./backgroundSave');

describe('enregistrement en arrière-plan', () => {
  test('l’étape n’est validée qu’à la réussite', async () => {
    let release!: () => void;
    const run = saveInBackground('moderation', () => new Promise<void>((resolve) => (release = resolve)), 'échec');
    expect(done).toEqual([]);
    release();
    await run;
    expect(done).toEqual(['moderation']);
  });

  test('un échec propose de réessayer, et la sortie du parcours rejoue l’écriture', async () => {
    let attempts = 0;
    const flaky = async () => { if (++attempts < 3) throw new Error('réseau'); };
    await saveInBackground('greeting', flaky, 'échec');
    expect(retries).toHaveLength(1);
    expect(await settleSaves()).toBe(false);
    expect(await settleSaves()).toBe(true);
    expect(done).toContain('greeting');
  });
});
