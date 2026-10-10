/**
 * Les sons des notifications du dashboard.
 *
 * Un son par type, pour qu'on sache sans regarder l'ecran si c'est une simple
 * information ou un probleme a traiter :
 *
 * - INFO : deux notes montantes, courtes, en timbre de cloche ;
 * - SUCCESS : un arpege majeur, le plus lumineux des quatre ;
 * - WARNING : deux coups sur la meme note, plus graves et plus secs ;
 * - ERROR : deux notes qui descendent d'un triton, le seul son « inquiet ».
 *
 * Comme les recompenses de l'onboarding, tout est synthetise par WebAudio : pas
 * de fichier a servir ni a precharger. Le timbre vient de quelques partiels
 * ajoutes a la fondamentale, chacun avec sa propre decroissance - c'est ce qui
 * separe une cloche d'un bip d'oscillateur.
 */

export type NotificationTone = 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR';

/** [rapport de frequence, gain relatif] */
type Overtone = readonly [number, number];

type Note = {
  frequency: number;
  /** Depart, en secondes apres le debut du son. */
  at: number;
  /** Duree de la decroissance de la fondamentale. */
  decay: number;
  gain?: number;
};

type Voice = {
  partials: readonly Overtone[];
  notes: readonly Note[];
  volume: number;
};

/** Cloche claire : partiels presque harmoniques, longue resonance. */
const BELL: readonly Overtone[] = [[1, 1], [2, 0.3], [3.01, 0.12], [4.2, 0.05]];
/** Maillet : partiels inharmoniques qui s'eteignent vite, attaque plus seche. */
const MALLET: readonly Overtone[] = [[1, 1], [3.98, 0.16], [9.1, 0.03]];

const VOICES: Record<NotificationTone, Voice> = {
  INFO: {
    partials: BELL,
    volume: 0.16,
    notes: [
      { frequency: 880, at: 0, decay: 0.55 },
      { frequency: 1318.51, at: 0.11, decay: 0.9 },
    ],
  },
  SUCCESS: {
    partials: BELL,
    volume: 0.14,
    notes: [
      { frequency: 1046.5, at: 0, decay: 0.45 },
      { frequency: 1318.51, at: 0.075, decay: 0.45 },
      { frequency: 1567.98, at: 0.15, decay: 0.55 },
      { frequency: 2093, at: 0.225, decay: 0.9, gain: 0.6 },
    ],
  },
  WARNING: {
    partials: MALLET,
    volume: 0.22,
    notes: [
      { frequency: 698.46, at: 0, decay: 0.32 },
      { frequency: 698.46, at: 0.17, decay: 0.5 },
    ],
  },
  ERROR: {
    partials: MALLET,
    volume: 0.24,
    notes: [
      { frequency: 659.25, at: 0, decay: 0.35 },
      { frequency: 466.16, at: 0.16, decay: 0.75 },
    ],
  },
};

/** Une rafale de notifications ne doit pas devenir une sonnerie continue. */
const COOLDOWN_MS = 1200;

let audioContext: AudioContext | null = null;
let lastPlayedAt = 0;

function context(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioContext) {
    try {
      audioContext = new Ctor();
    } catch {
      return null;
    }
  }
  if (audioContext.state === 'suspended') void audioContext.resume().catch(() => {});
  return audioContext;
}

/**
 * Deverrouiller l'audio au premier geste.
 *
 * Un navigateur ne laisse jouer un son qu'apres une interaction avec la page.
 * Or une notification arrive justement quand on ne touche a rien, souvent dans
 * un onglet en arriere-plan : le contexte doit donc avoir ete repris avant,
 * au premier clic ou a la premiere touche, sans quoi le premier son serait muet.
 */
export function primeNotificationAudio(): void {
  if (typeof window === 'undefined') return;
  const unlock = () => {
    const ctx = context();
    if (ctx?.state === 'running') {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    }
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
}

/** Vrai si un son peut reellement sortir maintenant. */
export function notificationAudioReady(): boolean {
  return audioContext?.state === 'running';
}

/**
 * Jouer le son d'un type de notification.
 *
 * Rend `true` si le son est parti : l'appelant s'en sert pour savoir s'il doit
 * laisser le systeme jouer le sien sur la notification de bureau.
 * `force` ignore le delai entre deux sons (apercu dans les preferences).
 */
export function playNotificationSound(tone: NotificationTone, options: { force?: boolean } = {}): boolean {
  const now = Date.now();
  if (!options.force && now - lastPlayedAt < COOLDOWN_MS) return true;

  const ctx = context();
  if (!ctx || ctx.state !== 'running') return false;
  lastPlayedAt = now;

  const voice = VOICES[tone] ?? VOICES.INFO;
  const start = ctx.currentTime + 0.01;

  const master = ctx.createGain();
  master.gain.value = voice.volume;
  // Plusieurs partiels qui se superposent peuvent saturer : le compresseur
  // garde le son propre sans avoir a baisser tout le reste.
  const compressor = ctx.createDynamicsCompressor();
  master.connect(compressor).connect(ctx.destination);

  let end = start;
  for (const note of voice.notes) {
    const noteStart = start + note.at;
    voice.partials.forEach(([ratio, level], index) => {
      const frequency = note.frequency * ratio;
      if (frequency > 16000) return;

      // Les partiels aigus s'eteignent plus vite que la fondamentale.
      const decay = note.decay / (1 + index * 0.9);
      const peak = level * (note.gain ?? 1);

      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, noteStart);

      gain.gain.setValueAtTime(0, noteStart);
      gain.gain.linearRampToValueAtTime(peak, noteStart + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + decay);

      oscillator.connect(gain).connect(master);
      oscillator.start(noteStart);
      oscillator.stop(noteStart + decay + 0.05);
      end = Math.max(end, noteStart + decay + 0.05);
    });
  }

  // Detacher la chaine une fois le son fini, pour ne rien laisser vivre.
  setTimeout(() => {
    master.disconnect();
    compressor.disconnect();
  }, Math.ceil((end - ctx.currentTime) * 1000) + 100);

  return true;
}
