/** Modules generalistes : niveaux, concours, accueil, automod. */
import { authStore } from '../stores/auth.svelte';
import { API_BASE_URL, dashboardMutation, dashboardRequest } from './client';

import { m } from '../i18n';
// ==========================================
// GENERALIST MODULES APIs
// ==========================================

export async function fetchLevelingData(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/leveling', { method: 'GET', guildId, errorContext: 'API Error (Fetch Leveling):' });
}

export async function updateLevelingConfig(config, guildId = authStore.selectedGuildId, options: { silent?: boolean } = {}) {
  return dashboardRequest('/leveling', { method: 'PATCH', successMessage: m.api_ok_update_leveling_config(), payload: config, guildId, silent: options.silent, errorContext: 'API Error (Update Leveling):' });
}

export async function createLevelUpChannel(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/leveling/level-up-channel', { method: 'POST', guildId, silent: true, errorContext: 'API Error (Create Level-Up Channel):' });
}

export async function fetchLevelingRoleResync(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/leveling/role-resync', { method: 'GET', guildId, silent: true, errorContext: 'API Error (Role Resync):' });
}

export async function runLevelingRoleResync(options: { stop?: boolean } = {}, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/leveling/role-resync', { method: 'POST', payload: options, guildId, silent: true, errorContext: 'API Error (Role Resync):' });
}

export async function fetchLevelingLeaderboard(
  { page = 1, search = '' }: { page?: number; search?: string } = {},
  guildId = authStore.selectedGuildId,
) {
  const query = new URLSearchParams({ page: String(page) });
  if (search) query.set('search', search);
  return dashboardRequest(`/leveling/leaderboard?${query}`, { method: 'GET', guildId, silent: true, errorContext: 'API Error (Leveling Leaderboard):' });
}

export async function fetchLevelingCurveImpact(
  curve: { baseXp: number; linearXp: number; exponent: number; maxLevel: number },
  guildId = authStore.selectedGuildId,
) {
  const query = new URLSearchParams({
    baseXp: String(curve.baseXp),
    linearXp: String(curve.linearXp),
    exponent: String(curve.exponent),
    maxLevel: String(curve.maxLevel),
  });
  // `silent` : appel de fond declenche par les curseurs, un bot indisponible ne
  // doit pas empiler les toasts d'erreur pendant qu'on regle la courbe.
  return dashboardRequest(`/leveling/curve-impact?${query}`, { method: 'GET', guildId, silent: true, errorContext: 'API Error (Curve Impact):' });
}

export async function addLevelingReward(level: number, roleId: string, guildId = authStore.selectedGuildId, options: { silent?: boolean } = {}) {
  return dashboardRequest('/leveling/rewards', { method: 'POST', successMessage: m.api_ok_add_leveling_reward(), payload: { level, roleId }, guildId, silent: options.silent, errorContext: 'API Error (Add Leveling Reward):' });
}

export async function deleteLevelingReward(rewardId: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/leveling/rewards/${rewardId}`, { method: 'DELETE', guildId, errorContext: 'API Error (Delete Leveling Reward):' });
}

export async function importLevelingData(
  data: unknown[],
  options: { dryRun?: boolean } = {},
  guildId = authStore.selectedGuildId,
) {
  const path = options.dryRun ? '/leveling/import?dry_run=1' : '/leveling/import';
  return dashboardRequest(path, { method: 'POST', successMessage: m.api_ok_import_leveling_data(), payload: data, guildId, silent: options.dryRun, errorContext: 'API Error (Import Leveling):' });
}


/**
 * Apparence d'un concours : réglages du serveur, surcharges d'un modèle ou d'un
 * concours précis. Les mêmes clefs voyagent dans les trois cas.
 */
export interface GiveawayAppearance {
  embedColorActive: string;
  embedColorPending: string;
  embedColorEnded: string;
  embedColorValidated: string;
  titleTemplate: string;
  descriptionTemplate: string;
  footerTemplate: string;
  thumbnailUrl: string | null;
  imageUrl: string | null;
  joinButtonLabel: string;
  joinButtonEmoji: string;
  joinButtonStyle: 'PRIMARY' | 'SECONDARY' | 'SUCCESS' | 'DANGER';
  announceWinnersTemplate: string;
  announceNoWinnerTemplate: string;
  joinReplyTemplate: string;
  leaveReplyTemplate: string;
  deniedBlockedTemplate: string;
  deniedRequiredTemplate: string;
  deniedAccountAgeTemplate: string;
  deniedMemberAgeTemplate: string;
  deniedLevelTemplate: string;
  deniedLinkedTemplate: string;
}

/**
 * Libelles que le bot genere lui-meme, hors gabarits. Ils accompagnent la
 * configuration pour que l'apercu parle la langue du serveur.
 */
export interface GiveawayGeneratedLabels {
  rewardsTitle: string;
  coins: string;
  xp: string;
  item: string;
  validation: string;
  bonusRolesTitle: string;
}

export interface GiveawayBonusEntry {
  roleId: string;
  weight: number;
}

export type GiveawayConfigPayload = GiveawayAppearance & {
  managerRoleIds: string[];
  requiredRoleIds: string[];
  blockedRoleIds: string[];
  minAccountAgeDays: number;
  minMemberAgeDays: number;
  minLevel: number;
  blockLinkedAccounts: boolean;
  bonusEntries: GiveawayBonusEntry[];
  clanBonusEnabled: boolean;
  clanBonusWeight: number;
  showBonusRoles: boolean;
  defaultChannelId: string | null;
};

export interface GiveawayTemplatePayload {
  name: string;
  prize: string;
  description?: string | null;
  winnerCount: number;
  durationMinutes: number;
  channelId?: string | null;
  rpgXp?: number;
  rpgCoins?: number;
  rpgItemId?: string | null;
  needValidation?: boolean;
  ignoreBonuses?: boolean;
  styleOverrides?: Partial<GiveawayAppearance>;
  /**
   * Sauvegarde de configuration dont ce modèle est le jumeau. Clef absente :
   * l'API laisse le lien en place.
   */
  presetId?: string | null;
}

export type GiveawayTemplate = GiveawayTemplatePayload & {
  id: string;
  guildId: string;
  styleOverrides: Partial<GiveawayAppearance>;
  presetId: string | null;
};

export async function fetchGiveaways(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/giveaways', { method: 'GET', guildId, errorContext: 'API Error (Fetch Giveaways):' });
}

export async function createGiveaway(
  payload: {
    prize: string;
    winnerCount: number;
    durationMinutes: number;
    description?: string;
    channelId: string;
    styleOverrides?: Partial<GiveawayAppearance>;
    ignoreBonuses?: boolean;
    rpgXp?: number;
    rpgCoins?: number;
    rpgItemId?: string | null;
    needValidation?: boolean;
  },
  guildId = authStore.selectedGuildId,
) {
  return dashboardRequest('/giveaways', { method: 'POST', successMessage: m.api_ok_create_giveaway(), payload, guildId, errorContext: 'API Error (Create Giveaway):' });
}

export async function endGiveaway(giveawayId: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/giveaways/${giveawayId}/end`, { method: 'POST', guildId, errorContext: 'API Error (End Giveaway):' });
}

export async function rerollGiveaway(giveawayId: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/giveaways/${giveawayId}/reroll`, { method: 'POST', guildId, errorContext: 'API Error (Reroll Giveaway):' });
}

export async function deleteGiveaway(giveawayId: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/giveaways/${giveawayId}`, { method: 'DELETE', guildId, errorContext: 'API Error (Delete Giveaway):' });
}

/** Objet RPG remettable par un concours : ce que le sélecteur affiche. */
export interface GiveawayRpgItem {
  id: string;
  name: string;
  emoji: string;
}

export async function fetchGiveawayItems(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/giveaways/items', { method: 'GET', guildId, errorContext: 'API Error (Fetch Giveaway Items):' });
}

export async function fetchGiveawayConfig(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/giveaways/config', { method: 'GET', guildId, errorContext: 'API Error (Fetch Giveaway Config):' });
}

export async function updateGiveawayConfig(
  payload: Partial<GiveawayConfigPayload>,
  guildId = authStore.selectedGuildId,
) {
  return dashboardRequest('/giveaways/config', { method: 'PUT', successMessage: m.api_ok_update_giveaway_config(), payload, guildId, errorContext: 'API Error (Update Giveaway Config):' });
}

/** Réglages figés d'une sauvegarde : les mêmes clefs que la configuration. */
export type GiveawayConfigPreset = {
  id: string;
  guildId: string;
  name: string;
  settings: Partial<GiveawayConfigPayload>;
  createdAt: string;
  updatedAt: string;
};

export async function fetchGiveawayConfigPresets(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/giveaways/config/presets', { method: 'GET', guildId, errorContext: 'API Error (Fetch Giveaway Config Presets):' });
}

export async function createGiveawayConfigPreset(
  payload: { name: string; settings: Partial<GiveawayConfigPayload> },
  guildId = authStore.selectedGuildId,
) {
  return dashboardRequest('/giveaways/config/presets', { method: 'POST', successMessage: m.api_ok_create_giveaway_config_preset(), payload, guildId, errorContext: 'API Error (Create Giveaway Config Preset):' });
}

export async function updateGiveawayConfigPreset(
  presetId: string,
  payload: { name: string; settings?: Partial<GiveawayConfigPayload> },
  guildId = authStore.selectedGuildId,
) {
  return dashboardRequest(`/giveaways/config/presets/${presetId}`, { method: 'PUT', successMessage: m.api_ok_update_giveaway_config_preset(), payload, guildId, errorContext: 'API Error (Update Giveaway Config Preset):' });
}

export async function deleteGiveawayConfigPreset(presetId: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/giveaways/config/presets/${presetId}`, { method: 'DELETE', guildId, errorContext: 'API Error (Delete Giveaway Config Preset):' });
}

export async function fetchGiveawayTemplates(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/giveaways/templates', { method: 'GET', guildId, errorContext: 'API Error (Fetch Giveaway Templates):' });
}

export async function createGiveawayTemplate(payload: GiveawayTemplatePayload, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/giveaways/templates', { method: 'POST', successMessage: m.api_ok_create_giveaway_template(), payload, guildId, errorContext: 'API Error (Create Giveaway Template):' });
}

export async function updateGiveawayTemplate(
  templateId: string,
  payload: GiveawayTemplatePayload,
  guildId = authStore.selectedGuildId,
) {
  return dashboardRequest(`/giveaways/templates/${templateId}`, { method: 'PUT', successMessage: m.api_ok_update_giveaway_template(), payload, guildId, errorContext: 'API Error (Update Giveaway Template):' });
}

export async function deleteGiveawayTemplate(templateId: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/giveaways/templates/${templateId}`, { method: 'DELETE', guildId, errorContext: 'API Error (Delete Giveaway Template):' });
}

/**
 * Les quatre etats de l'embed Discord, repris tels quels par la page publique.
 */
export type PublicGiveawayStatus = 'ACTIVE' | 'PENDING_VALIDATION' | 'VALIDATED' | 'ENDED';

export interface PublicGiveawayIdentity {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface PublicGiveaway {
  id: string;
  prize: string;
  description: string | null;
  status: PublicGiveawayStatus;
  ended: boolean;
  needValidation: boolean;
  winnerCount: number;
  participantCount: number;
  endsAt: string;
  createdAt: string;
  channelId: string;
  /** `null` quand le message d'origine n'a jamais ete publie. */
  messageUrl: string | null;
  creator: PublicGiveawayIdentity | null;
  winners: PublicGiveawayIdentity[];
  winnersPending: boolean;
  rewards: { xp: number; coins: number; itemId: string | null; itemName: string | null };
  /** Renseigne uniquement sur la fiche detaillee. */
  channelName?: string | null;
}

export interface PublicGiveawaysResponse {
  enabled: boolean;
  guildName: string;
  guildIcon: string | null;
  giveaways: PublicGiveaway[];
}

export interface PublicGiveawayResponse {
  enabled: boolean;
  guildName: string;
  guildIcon: string | null;
  giveaway: PublicGiveaway | null;
}

export async function fetchPublicGiveaways(guildId: string): Promise<PublicGiveawaysResponse> {
  const response = await fetch(`${API_BASE_URL}/api/public/guilds/${guildId}/giveaways`, {
    method: 'GET',
    headers: { Accept: 'application/json' }
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Erreur lors du chargement des giveaways');
  }

  return response.json();
}

/**
 * Un concours supprime, ou dont le lien a ete bricole, n'est pas une panne : le
 * 404 revient comme un `giveaway` absent, que la page annonce telle quelle.
 */
export async function fetchPublicGiveaway(guildId: string, giveawayId: string): Promise<PublicGiveawayResponse> {
  const response = await fetch(`${API_BASE_URL}/api/public/guilds/${guildId}/giveaways/${encodeURIComponent(giveawayId)}`, {
    method: 'GET',
    headers: { Accept: 'application/json' }
  });

  if (response.status === 404 || response.status === 400) {
    return { enabled: true, guildName: 'Kotbo Server', guildIcon: null, giveaway: null };
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Erreur lors du chargement du giveaway');
  }

  return response.json();
}

export async function fetchWelcomeConfig(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/announcement', { method: 'GET', guildId, errorContext: 'API Error (Fetch Announcement Config):' });
}

export async function updateWelcomeConfig(config, guildId = authStore.selectedGuildId, options: { silent?: boolean } = {}) {
  return dashboardRequest('/announcement', { method: 'PATCH', successMessage: m.api_ok_update_welcome_config(), payload: config, guildId, silent: options.silent, errorContext: 'API Error (Update Announcement Config):' });
}

export async function rescanIdentityAutoRoles(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/announcement/autorole-rescan', { method: 'POST', guildId, errorContext: 'API Error (Rescan Identity Auto Roles):', silent: true });
}

export async function fetchWelcomeThreadConfig(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/welcome-thread', { method: 'GET', guildId, errorContext: 'API Error (Fetch Welcome Thread Config):' });
}

export async function updateWelcomeThreadConfig(config, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/welcome-thread', { method: 'PATCH', successMessage: m.api_ok_update_welcome_thread_config(), payload: config, guildId, errorContext: 'API Error (Update Welcome Thread Config):' });
}

export async function updateWelcomeThreadSteps(steps: Array<{ content: string; name?: string | null; avatarUrl?: string | null; delayMs?: number }>, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/welcome-thread/steps', { method: 'PUT', successMessage: m.api_ok_update_welcome_thread_steps(), payload: { steps }, guildId, errorContext: 'API Error (Update Welcome Thread Steps):' });
}

export async function updateWelcomeThreadPages(pages: Array<{ label: string; emoji?: string | null; summary?: string | null; actionType?: string; roleId?: string | null; roleAction?: string; roleGroup?: string | null; linkUrl?: string | null; embedTitle?: string; embedDescription?: string; embedColor?: string; embedImageUrl?: string | null; embedThumbnailUrl?: string | null }>, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/welcome-thread/pages', { method: 'PUT', successMessage: m.api_ok_update_welcome_thread_pages(), payload: { pages }, guildId, errorContext: 'API Error (Update Welcome Thread Pages):' });
}

export async function fetchReactionRoleMenus(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/reaction-roles', { method: 'GET', guildId, errorContext: 'API Error (Fetch Reaction Roles):' });
}

export type ReactionRoleButtonMode = 'toggle' | 'add_only';

export type ReactionRoleButtonStyle = 'secondary' | 'primary' | 'success' | 'danger';

export interface ReactionRoleOption {
  emoji?: string;
  label: string;
  roleId: string;
  /** Absent : le bouton suit le mode du panneau. */
  mode?: ReactionRoleButtonMode | null;
  /** Absent : le bouton reste gris. */
  style?: ReactionRoleButtonStyle | null;
}

export async function createReactionRoleMenu(payload: { title: string; channelId: string; buttonMode: ReactionRoleButtonMode; options: ReactionRoleOption[] }, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/reaction-roles', { method: 'POST', successMessage: m.api_ok_create_reaction_role_menu(), payload, guildId, errorContext: 'API Error (Create Reaction Role Menu):' });
}

export async function updateReactionRoleMenu(menuId: string, payload: { title?: string; channelId?: string; buttonMode?: ReactionRoleButtonMode; options?: ReactionRoleOption[] }, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/reaction-roles/${menuId}`, { method: 'PATCH', successMessage: m.api_ok_update_reaction_role_menu(), payload, guildId, errorContext: 'API Error (Update Reaction Role Menu):' });
}

export async function deleteReactionRoleMenu(menuId: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/reaction-roles/${menuId}`, { method: 'DELETE', guildId, errorContext: 'API Error (Delete Reaction Role Menu):' });
}

export async function fetchAutoResponses(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/triggers', { method: 'GET', guildId, errorContext: 'API Error (Fetch Auto Responses):' });
}

export async function createAutoResponse(payload: { trigger: string; response: string | null; matchType: string; enabled?: boolean; roleIdToAdd?: string | null; roleIdToRemove?: string | null; deleteTrigger?: boolean }, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/triggers', { method: 'POST', successMessage: m.api_ok_create_auto_response(), payload, guildId, errorContext: 'API Error (Create Auto Response):' });
}

export async function updateAutoResponse(id: string, payload: { trigger?: string; response?: string | null; matchType?: string; enabled?: boolean; roleIdToAdd?: string | null; roleIdToRemove?: string | null; deleteTrigger?: boolean }, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/triggers/${id}`, { method: 'PATCH', successMessage: m.api_ok_update_auto_response(), payload, guildId, errorContext: 'API Error (Update Auto Response):' });
}

export async function deleteAutoResponse(id: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/triggers/${id}`, { method: 'DELETE', guildId, errorContext: 'API Error (Delete Auto Response):' });
}

export interface GuildCustomEmoji {
  id: string;
  name: string;
  animated: boolean;
  url: string;
}

export async function fetchTriggerEmojis(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/triggers/emojis', { method: 'GET', guildId, errorContext: 'API Error (Fetch Guild Emojis):' }) as Promise<{ emojis: GuildCustomEmoji[] } | null>;
}

export async function fetchAutoModConfig(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/automod', { method: 'GET', guildId, errorContext: 'API Error (Fetch AutoMod):' });
}

/**
 * `silent` : ecriture faite depuis le parcours de configuration.
 *
 * Le socle annonce « Operation reussie » a chaque mutation. Dans le tableau de
 * bord c'est la seule confirmation qu'on ait ; dans le parcours, l'ecran change
 * et le suivant montre le resultat - le toast n'apprend rien, et les etapes qui
 * ecrivent plusieurs fois en empilent autant.
 */
export async function updateAutoModConfig(config, guildId = authStore.selectedGuildId, options: { silent?: boolean } = {}) {
  return dashboardRequest('/automod', { method: 'PATCH', successMessage: m.api_ok_update_auto_mod_config(), payload: config, guildId, silent: options.silent, errorContext: 'API Error (Update AutoMod):' });
}

export async function fetchAdminLockRequests(status?: string, guildId = authStore.selectedGuildId) {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  return dashboardRequest(`/admin-lock${query}`, { method: 'GET', guildId, errorContext: 'API Error (Fetch Admin Lock Requests):' });
}

export async function fetchAdminLockRequestDetail(requestId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/admin-lock/${requestId}`, { method: 'GET', guildId, errorContext: 'API Error (Fetch Admin Lock Request):' });
}

export async function decideAdminLockRequest(requestId: string, payload: { decision: 'APPROVED' | 'REJECTED'; reason?: string }, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/admin-lock/${requestId}/decide`, { method: 'POST', successMessage: m.api_ok_decide_admin_lock_request(), payload, guildId, errorContext: 'API Error (Decide Admin Lock Request):' });
}

export async function fetchSuggestions(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/suggestions', { method: 'GET', guildId, errorContext: 'API Error (Fetch Suggestions):' });
}

export async function fetchSuggestionsConfig(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/suggestions/config', { method: 'GET', guildId, errorContext: 'API Error (Fetch Suggestions Config):' });
}

export async function updateSuggestionsConfig(
  config: { enabled?: boolean; channelId?: string | null },
  guildId = authStore.selectedGuildId
) {
  return dashboardRequest('/suggestions/config', { method: 'PATCH', successMessage: m.api_ok_update_suggestions_config(), payload: config, guildId, errorContext: 'API Error (Update Suggestions Config):' });
}

export async function resolveSuggestion(suggestionId: string, payload: { status: 'APPROVED' | 'REJECTED' | 'IMPLEMENTED'; responseText: string }, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/suggestions/${suggestionId}/resolve`, { method: 'POST', successMessage: m.api_ok_resolve_suggestion(), payload, guildId, errorContext: 'API Error (Resolve Suggestion):' });
}

export async function sendOrUpdateEmbed(payload: { channelId: string; messageId?: string | null; embed: Record<string, unknown> }, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/embed-builder', { method: 'POST', successMessage: m.api_ok_send_or_update_embed(), payload, guildId, errorContext: 'API Error (Send Embed):' });
}
