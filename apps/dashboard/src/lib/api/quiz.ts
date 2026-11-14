import { m } from '../i18n';
import { API_BASE_URL } from './client';

/** Miroir de `getPublicQuizState` (apps/bot/src/services/features/eventService.ts). */
export type PublicQuiz = {
  guildName: string;
  guildIcon: string | null;
  event: { id: string; title: string; description: string | null; status: string };
  totalQuestions: number;
  answeredCount: number;
  current: {
    id: string;
    number: number;
    text: string;
    options: string[];
    imageUrl: string | null;
    startedAt: string | null;
    myAnswer: number | null;
  } | null;
  previous: { text: string; answer: string | null } | null;
  leaderboard: { userId: string; name: string; score: number }[];
};

const quizUrl = (guildId: string, eventId: string) =>
  `${API_BASE_URL}/api/public/guilds/${guildId}/quizzes/${encodeURIComponent(eventId)}`;

/** null : quiz absent, encore en brouillon ou module éteint. */
export async function fetchPublicQuiz(guildId: string, eventId: string): Promise<PublicQuiz | null> {
  const response = await fetch(quizUrl(guildId, eventId), {
    headers: { Accept: 'application/json' },
    credentials: 'include',
  });
  if (response.status === 404 || response.status === 400) return null;
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || m.qz_load_failed());
  }
  return response.json();
}

export async function answerPublicQuiz(guildId: string, eventId: string, questionId: string, optionIndex: number) {
  const response = await fetch(`${quizUrl(guildId, eventId)}/answer`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ questionId, optionIndex }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || m.qz_answer_failed());
  }
}

export const quizPublicPath = (guildId: string, eventId: string) => `/${guildId}/quiz/${eventId}`;
export const quizPresentationPath = (guildId: string, eventId: string) => `${quizPublicPath(guildId, eventId)}/presentation`;
