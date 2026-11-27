import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const played: string[] = [];
(globalThis as any).Audio = class {
  volume = 1;
  currentTime = 0;
  constructor(readonly src: string) {}
  play() {
    played.push(this.src);
    // Navigateur qui refuse l'audio avant tout clic.
    return Promise.reject(new Error('NotAllowedError'));
  }
};

const { play, sound, celebrateStep } = await import('./celebrate');

describe('sons du parcours', () => {
  test('chaque son a son fichier, en WAV', () => {
    for (const name of ['step', 'done', 'error']) {
      const file = join(import.meta.dir, '../../../public/sounds/onboarding', `${name}.wav`);
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file).subarray(0, 4).toString()).toBe('RIFF');
    }
  });

  test('un refus du navigateur reste silencieux, et couper le son coupe tout', () => {
    play('done');
    expect(played.at(-1)).toEndWith('sounds/onboarding/done.wav');

    sound.toggle();
    const before = played.length;
    celebrateStep();
    expect(played.length).toBe(before);
    sound.toggle();
  });
});
