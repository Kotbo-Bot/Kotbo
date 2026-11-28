/**
 * Les trois sons du parcours de configuration, composés pour Kotbo : des tons
 * purs et brefs, sans aucun échantillon tiers.
 *
 *   bun apps/dashboard/scripts/generate-onboarding-sounds.ts
 */
import { join } from 'node:path';

const RATE = 44100;
const PEAK = 0.56; // environ -5 dB

type Tone = {
  at: number; // départ, en secondes
  length: number;
  from: number; // Hz
  to?: number; // glissé jusqu'à cette hauteur
  gain?: number;
  decay: number; // constante de temps de l'extinction, en secondes
  harmonic?: number; // part de l'octave supérieure, pour la brillance
};

const SOUNDS: Record<'step' | 'done' | 'error', Tone[]> = {
  // Un toc mat qui descend vite.
  step: [{ at: 0, length: 0.09, from: 330, to: 220, decay: 0.018, harmonic: 0.15 }],
  // Un accord de sol majeur égrené vers le haut.
  done: [
    { at: 0, length: 0.5, from: 392, decay: 0.13, harmonic: 0.2 },
    { at: 0.085, length: 0.5, from: 587.33, decay: 0.13, harmonic: 0.2 },
    { at: 0.17, length: 0.55, from: 783.99, decay: 0.15, harmonic: 0.2 },
    { at: 0.255, length: 0.65, from: 987.77, decay: 0.18, gain: 0.8, harmonic: 0.15 },
  ],
  // Deux notes graves descendantes.
  error: [
    { at: 0, length: 0.09, from: 277.18, decay: 0.045, harmonic: 0.35 },
    { at: 0.095, length: 0.17, from: 207.65, decay: 0.065, harmonic: 0.35 },
  ],
};

export type SoundName = keyof typeof SOUNDS;
export const SOUND_NAMES = Object.keys(SOUNDS) as SoundName[];

/** Un fichier WAV mono 16 bits. */
export function renderSound(name: SoundName): Uint8Array {
  const tones = SOUNDS[name];
  const mix = new Float64Array(Math.ceil(Math.max(...tones.map((t) => t.at + t.length)) * RATE));

  for (const { at, length, from, to = from, gain = 1, decay, harmonic = 0 } of tones) {
    const count = Math.floor(length * RATE);
    const start = Math.floor(at * RATE);
    let phase = 0;
    for (let i = 0; i < count; i++) {
      const t = i / RATE;
      phase += (2 * Math.PI * (from + (to - from) * (i / count))) / RATE;
      // Attaque de 3 ms et relâche de 10 ms : sans elles, le haut-parleur claque.
      const envelope = Math.min(1, t / 0.003, (length - t) / 0.01) * Math.exp(-t / decay);
      mix[start + i] += gain * envelope * (Math.sin(phase) + harmonic * Math.sin(2 * phase));
    }
  }

  const scale = (PEAK * 32767) / mix.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
  const wav = Buffer.alloc(44 + mix.length * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + mix.length * 2, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(RATE, 24);
  wav.writeUInt32LE(RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(mix.length * 2, 40);
  mix.forEach((v, i) => wav.writeInt16LE(Math.round(v * scale), 44 + i * 2));
  return wav;
}

if (import.meta.main) {
  for (const name of SOUND_NAMES) {
    await Bun.write(join(import.meta.dir, '../public/sounds/onboarding', `${name}.wav`), renderSound(name));
  }
}
