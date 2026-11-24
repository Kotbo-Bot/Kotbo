/** Habillage des pages publiques : lecture anonyme et édition depuis le dashboard. */
import { authStore } from '../stores/auth.svelte';
import { API_BASE_URL, dashboardRequest } from './client';
import type { PublicTheme } from '../publicTheme';

export interface PublicThemePayload {
  theme: PublicTheme | null;
  guildName: string | null;
  guildIcon: string | null;
}

const cache = new Map<string, Promise<PublicThemePayload | null>>();

/** Lue une fois par serveur : passer d'une page publique à l'autre ne la relit pas. */
export function fetchPublicTheme(guildId: string): Promise<PublicThemePayload | null> {
  let pending = cache.get(guildId);
  if (!pending) {
    pending = fetch(`${API_BASE_URL}/api/public/guilds/${guildId}/theme`, { headers: { Accept: 'application/json' } })
      .then((res) => (res.ok ? (res.json() as Promise<PublicThemePayload>) : null))
      .catch(() => null);
    cache.set(guildId, pending);
  }
  return pending;
}

export async function fetchPublicThemeAdmin(guildId = authStore.selectedGuildId) {
  const res = await dashboardRequest<{ theme: PublicTheme | null }>('/public-theme', {
    guildId,
    errorContext: 'API Error (Public theme):',
  });
  return res?.theme ?? null;
}

export async function savePublicTheme(theme: PublicTheme | null, guildId = authStore.selectedGuildId) {
  const res = await dashboardRequest<{ theme: PublicTheme | null }>('/public-theme', {
    method: 'PUT',
    payload: { theme },
    guildId,
    errorContext: 'API Error (Save public theme):',
  });
  if (guildId) cache.delete(guildId);
  return res?.theme ?? null;
}
