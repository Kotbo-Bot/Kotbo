/**
 * Phrases d'essai d'AegisAI pour la démo. La démo n'appelle pas l'IA : chaque
 * phrase porte la note que l'API aurait rendue, et le testeur n'accepte
 * qu'elles (bouton, ou n'importe quelle touche qui « tape » la suivante).
 */
import type { AegisEmotion } from '../api/aegis';

export type AegisSample = { label: string; text: string; toxicity: number; emotion: AegisEmotion; emotionScore: number };

const SAMPLES: Record<'fr' | 'en', AegisSample[]> = {
  fr: [
    { label: 'Message amical', text: 'Merci pour la soirée jeux, c’était vraiment génial !', toxicity: 0.02, emotion: 'joy', emotionScore: 0.94 },
    { label: 'Taquinerie', text: 'T’as encore perdu ? T’es nul mdr 😂', toxicity: 0.34, emotion: 'joy', emotionScore: 0.61 },
    { label: 'Dispute', text: 'Arrête de me couper la parole, tu me saoules sérieux.', toxicity: 0.58, emotion: 'anger', emotionScore: 0.83 },
    { label: 'Insulte', text: 'Ferme-la espèce d’abruti, personne ne veut de toi ici.', toxicity: 0.93, emotion: 'anger', emotionScore: 0.91 },
    { label: 'Détresse', text: 'J’en peux plus, j’ai l’impression que tout le monde me déteste…', toxicity: 0.12, emotion: 'sad', emotionScore: 0.89 },
  ],
  en: [
    { label: 'Friendly', text: 'Thanks for the game night, it was awesome!', toxicity: 0.02, emotion: 'joy', emotionScore: 0.94 },
    { label: 'Teasing', text: 'You lost again? You’re so bad lol 😂', toxicity: 0.34, emotion: 'joy', emotionScore: 0.61 },
    { label: 'Argument', text: 'Stop interrupting me, you’re seriously annoying.', toxicity: 0.58, emotion: 'anger', emotionScore: 0.83 },
    { label: 'Insult', text: 'Shut up you idiot, nobody wants you here.', toxicity: 0.93, emotion: 'anger', emotionScore: 0.91 },
    { label: 'Distress', text: 'I can’t take it anymore, it feels like everyone hates me…', toxicity: 0.12, emotion: 'sad', emotionScore: 0.89 },
  ],
};

export function aegisSamples(locale: string): AegisSample[] {
  return SAMPLES[locale.startsWith('fr') ? 'fr' : 'en'];
}

/** Note d'une phrase : celle de l'exemple s'il en est un, sinon une note neutre. */
export function scoreAegisSample(text: string): Pick<AegisSample, 'toxicity' | 'emotion' | 'emotionScore'> {
  const known = [...SAMPLES.fr, ...SAMPLES.en].find((s) => s.text === text.trim());
  return known ?? { toxicity: 0.05, emotion: 'neutral', emotionScore: 0.7 };
}
