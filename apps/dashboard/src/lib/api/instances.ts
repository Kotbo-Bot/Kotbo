/** Instances self-host : télémétrie et bannissement à distance. */
import { API_BASE_URL, authorizedFetch } from './client';

export type InstanceBanMode = 'SHUTDOWN' | 'DISABLE_FEATURES';

export interface BotInstance {
  id: string;
  botClientId: string;
  botName: string;
  botAvatarUrl: string | null;
  dashboardUrl: string | null;
  guildCount: number;
  userCount: number;
  version: string | null;
  isSelfHosted: boolean;
  machineFingerprint: string | null;
  firstSeenAt: string;
  lastPingAt: string;
  status: 'online' | 'stale';
  banned: boolean;
  ban: {
    reason: string | null;
    mode: InstanceBanMode;
    bannedBy: string;
    createdAt: string;
  } | null;
}

/** Ban toujours actif dont l'instance ne pingue plus depuis plus de 48 h. */
export interface OrphanInstanceBan {
  id: string;
  botClientId: string | null;
  machineFingerprint: string | null;
  reason: string | null;
  mode: InstanceBanMode;
  bannedBy: string;
  createdAt: string;
}

export async function fetchBotInstances(): Promise<{ instances: BotInstance[]; orphanBans: OrphanInstanceBan[] }> {
  const res = await authorizedFetch(`${API_BASE_URL}/api/admin/instances`);
  if (!res.ok) throw new Error('Erreur lors de la récupération des instances');
  return res.json();
}

export async function banBotInstance(botClientId: string, data: { reason?: string; mode: InstanceBanMode }) {
  const res = await authorizedFetch(`${API_BASE_URL}/api/admin/instances/${botClientId}/ban`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Erreur lors du bannissement de l'instance");
  }
  return res.json();
}

export async function unbanBotInstance(botClientId: string) {
  const res = await authorizedFetch(`${API_BASE_URL}/api/admin/instances/${botClientId}/unban`, {
    method: 'POST',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Erreur lors du débannissement de l'instance");
  }
  return res.json();
}
