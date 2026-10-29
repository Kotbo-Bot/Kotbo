/** Protection anti-raid. */
import { authStore } from '../stores/auth.svelte';
import { dashboardMutation, dashboardRequest } from './client';

import { m } from '../i18n';
// ─────────────────────────────────────────────────────────────
// Raid Protection (captcha, anti-raid, locks, reports, invites, scam)
// ─────────────────────────────────────────────────────────────

export async function fetchRaidProtection(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/raid-protection', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Raid Protection):'
  });
}

// Ces routes renvoient la config mise a jour : on passe par dashboardRequest
// pour recuperer le corps JSON (dashboardMutation ne renvoie qu'un booleen).
export async function updateRaidProtection(
  payload: Record<string, unknown>,
  guildId = authStore.selectedGuildId,
  /** Voir `updateAutoModConfig` : muet quand l'ecriture vient du parcours. */
  options: { silent?: boolean } = {},
) {
  return dashboardRequest('/raid-protection', {
    method: 'PATCH',
    silent: options.silent,
    payload,
    guildId,
    errorContext: 'API Error (Update Raid Protection):'
  });
}

export async function setRaidMode(active: boolean, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/raid-protection/raidmode', {
    method: 'POST',
    successMessage: m.api_ok_set_raid_mode(),
    payload: { active },
    guildId,
    errorContext: 'API Error (Raid Mode):'
  });
}

export async function setJoinLock(active: boolean, hours?: number, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/raid-protection/joinlock', {
    method: 'POST',
    successMessage: m.api_ok_set_join_lock(),
    payload: { active, hours },
    guildId,
    errorContext: 'API Error (Join Lock):'
  });
}

export async function setDmLock(active: boolean, hours?: number, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/raid-protection/dmlock', {
    method: 'POST',
    successMessage: m.api_ok_set_dm_lock(),
    payload: { active, hours },
    guildId,
    errorContext: 'API Error (DM Lock):'
  });
}

export async function setInviteEmergency(active: boolean, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/raid-protection/invite-emergency', {
    method: 'POST',
    successMessage: m.api_ok_set_invite_emergency(),
    payload: { active },
    guildId,
    errorContext: 'API Error (Invite Emergency):'
  });
}

export async function fetchMemberReports(status?: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/raid-protection/reports${status ? `?status=${status}` : ''}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Member Reports):'
  });
}

export async function decideMemberReport(reportId: string, resolved: boolean, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/raid-protection/reports/${reportId}/decision`, {
    method: 'POST',
    payload: { resolved },
    guildId,
    errorContext: 'API Error (Report Decision):'
  });
}

export async function fetchInviteRequests(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/raid-protection/invite-requests', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Invite Requests):'
  });
}

export async function decideInviteRequest(requestId: string, approved: boolean, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/raid-protection/invite-requests/${requestId}/decision`, {
    method: 'POST',
    payload: { approved },
    guildId,
    errorContext: 'API Error (Invite Decision):'
  });
}

// ─────────────────────────────────────────────────────────────
// Kotbo Vision (filtre d'images d'arnaque) et Jail
// ─────────────────────────────────────────────────────────────

export type VisionSanction = 'DELETE' | 'WARN' | 'TIMEOUT' | 'KICK' | 'SOFTBAN' | 'BAN' | 'JAIL';

export type VisionList = {
  id: string;
  name: string;
  enabled: boolean;
  reviewChannelId: string | null;
  sanction: VisionSanction | null;
  durationMin: number | null;
  imageCount: number;
  createdAt: string;
};

export type VisionImage = {
  id: string;
  filename: string | null;
  thumb: string | null;
  source: string;
  status: 'BLOCKED' | 'ALLOWED';
  hits: number;
  lastSeenAt: string | null;
  parentId: string | null;
  createdAt: string;
};

export type VisionReview = {
  id: string;
  listId: string | null;
  score: number;
  authorId: string;
  channelId: string;
  thumb: string | null;
  createdAt: string;
};

export type VisionOverview = {
  lists: VisionList[];
  reviews: VisionReview[];
  guildCatalogCount: number;
  globalCatalogCount: number;
  blockedTotal: number;
  maxLists: number;
};

export type VisionAddResult = { added: number; variants: number; duplicates: number; refused: number };

export async function fetchVision(guildId = authStore.selectedGuildId) {
  return dashboardRequest<VisionOverview>('/raid-protection/vision', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Kotbo Vision):'
  });
}

export async function createVisionList(payload: Partial<VisionList>, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ list: VisionList }>('/raid-protection/vision/lists', {
    method: 'POST',
    payload,
    guildId,
    errorContext: 'API Error (Kotbo Vision List):'
  });
}

export async function updateVisionList(listId: string, payload: Partial<VisionList>, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ list: VisionList }>(`/raid-protection/vision/lists/${listId}`, {
    method: 'PATCH',
    payload,
    guildId,
    errorContext: 'API Error (Kotbo Vision List):'
  });
}

export async function deleteVisionList(listId: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/raid-protection/vision/lists/${listId}`, {
    method: 'DELETE',
    guildId,
    errorContext: 'API Error (Kotbo Vision List):'
  });
}

/** `listId` null = catalogue du serveur (honeypot, confirmations). */
export async function fetchVisionImages(listId: string | null, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ images: VisionImage[] }>(`/raid-protection/vision/images?list=${listId ?? 'server'}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Kotbo Vision Images):'
  });
}

export async function uploadVisionImage(listId: string | null, name: string, dataUrl: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest<VisionAddResult>('/raid-protection/vision/images', {
    method: 'POST',
    payload: { listId, name, data: dataUrl },
    guildId,
    errorContext: 'API Error (Kotbo Vision Upload):'
  });
}

export async function setVisionImageStatus(imageId: string, status: 'BLOCKED' | 'ALLOWED', guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/raid-protection/vision/images/${imageId}`, {
    method: 'PATCH',
    payload: { status },
    guildId,
    errorContext: 'API Error (Kotbo Vision Image):'
  });
}

export async function deleteVisionImage(imageId: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/raid-protection/vision/images/${imageId}`, {
    method: 'DELETE',
    guildId,
    errorContext: 'API Error (Kotbo Vision Image):'
  });
}

export async function decideVisionReview(reviewId: string, decision: 'confirm' | 'dismiss', guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ ok: boolean; status: string; sanction?: string }>(`/raid-protection/vision/reviews/${reviewId}`, {
    method: 'POST',
    payload: { decision },
    guildId,
    errorContext: 'API Error (Kotbo Vision Review):'
  });
}

export type ShieldResult = { previous: number; level: number; warnings: string[]; config: Record<string, any> };

export async function setShieldLevel(level: number, guildId = authStore.selectedGuildId) {
  return dashboardRequest<ShieldResult>('/raid-protection/shield', {
    method: 'POST',
    payload: { level },
    guildId,
    errorContext: 'API Error (Shield):'
  });
}

/** `create` : Kotbo crée un salon #shield invisible pour @everyone. */
export async function publishShieldPanel(target: { channelId?: string; create?: boolean }, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ channelId: string; config: Record<string, any> }>('/raid-protection/shield/panel', {
    method: 'POST',
    payload: target,
    guildId,
    errorContext: 'API Error (Shield Panel):'
  });
}

export async function createShieldStatusChannel(guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ channelId: string; config: Record<string, any> }>('/raid-protection/shield/status', {
    method: 'POST',
    payload: {},
    guildId,
    errorContext: 'API Error (Shield Status):'
  });
}

export async function provisionJailRole(createChannel: boolean, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ roleId: string; channelId: string | null; channelsUpdated: number }>('/raid-protection/jail/provision', {
    method: 'POST',
    payload: { createChannel },
    guildId,
    errorContext: 'API Error (Jail):'
  });
}

export async function fetchJailedMembers(guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ jails: { userId: string; source: string; reason: string | null; releaseAt: string | null; createdAt: string }[] }>('/raid-protection/jail/members', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Jail):'
  });
}

// ─────────────────────────────────────────────────────────────
// Audit de securite
// ─────────────────────────────────────────────────────────────

/** `deep` active les controles necessitant la liste complete des membres. */
export async function fetchSecurityAudit(deep = true, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/raid-protection/audit${deep ? '' : '?deep=0'}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Security Audit):'
  });
}

// ─────────────────────────────────────────────────────────────
// Lignage des invitations
// ─────────────────────────────────────────────────────────────

export async function fetchInviteLineage(userId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/raid-protection/lineage/${userId}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Invite Lineage):'
  });
}

/** `dryRun` (defaut true) se contente de lister les membres qui seraient touches. */
export async function quarantineInviteLineage(
  userId: string,
  options: { dryRun?: boolean; maxDepth?: number; sinceDays?: number; quarantineRoleId?: string | null } = {},
  guildId = authStore.selectedGuildId
) {
  return dashboardRequest(`/raid-protection/lineage/${userId}/quarantine`, {
    method: 'POST',
    payload: { dryRun: true, ...options },
    guildId,
    errorContext: 'API Error (Lineage Quarantine):'
  });
}

// ─────────────────────────────────────────────────────────────
// Moteur anti-spam comportemental
// ─────────────────────────────────────────────────────────────

export async function fetchSpamDetection(days = 14, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/raid-protection/spam?days=${days}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Spam Detection):'
  });
}

export async function updateSpamDetection(payload: Record<string, unknown>, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/raid-protection/spam', {
    method: 'PATCH',
    payload,
    guildId,
    errorContext: 'API Error (Update Spam Detection):'
  });
}

export async function fetchSpamSamples(
  options: { pendingOnly?: boolean; minScore?: number } = {},
  guildId = authStore.selectedGuildId
) {
  const params = new URLSearchParams();
  if (options.pendingOnly) params.set('pending', '1');
  if (options.minScore) params.set('minScore', String(options.minScore));
  const query = params.toString();

  return dashboardRequest(`/raid-protection/spam/samples${query ? `?${query}` : ''}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Spam Samples):'
  });
}

export async function decideSpamSample(sampleId: string, truePositive: boolean, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/raid-protection/spam/samples/${sampleId}/decision`, {
    method: 'POST',
    payload: { truePositive },
    guildId,
    errorContext: 'API Error (Spam Decision):'
  });
}

// `silent` : le correctif rend un message qui nomme ce qui a change, et
// SecurityAudit l'affiche lui-meme (succes comme echec). Sans cela le toast
// generique de dashboardRequest s'empilait par-dessus, d'ou la double notif.
export async function applySecurityFix(findingId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/raid-protection/audit/fix', {
    method: 'POST',
    payload: { findingId },
    guildId,
    silent: true,
    errorContext: 'API Error (Security Fix):'
  });
}

// Applique en une passe tous les correctifs sans risque. Les correctifs
// `risky` sont exclus cote serveur : ils gardent leur bouton et leur
// confirmation individuelle. `silent` pour la meme raison que ci-dessus - la
// page rend son propre recapitulatif (N appliques, M en echec).
export async function applyAllSecurityFixes(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/raid-protection/audit/fix-all', {
    method: 'POST',
    guildId,
    silent: true,
    errorContext: 'API Error (Security Fix All):'
  });
}
