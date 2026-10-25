/** Mise en place guidee du serveur. */
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';

export type * from './serverTemplateTypes';
import type { ServerTemplateState, StaffRolePower } from './serverTemplateTypes';

export type ServerTemplateApplyResult = {
  success: boolean;
  items: { key: string; id: string; name: string; created: boolean }[];
  modules: string[];
  /**
   * Modules configures mais encore inertes, faute d'abonnement. Ils s'allument
   * seuls le jour ou le serveur souscrit : rien a rejouer, la mise en place n'a
   * pas a etre refaite.
   */
  preparedModules: string[];
  /** Etapes facultatives qui n'ont pas abouti, sans arreter la mise en place. */
  warnings: string[];
  panelSent: boolean;
};

export async function fetchServerTemplate(guildId = authStore.selectedGuildId): Promise<ServerTemplateState> {
  return dashboardRequest('/server-template', { method: 'GET', guildId, errorContext: 'API Error (Server Template):' });
}

/**
 * Ce que le serveur avait deja fait quand la mise en place s'est interrompue.
 * `appliedAt` distingue le refus d'une mise en place menee ailleurs de celui
 * d'une mise en place encore en cours : la premiere est definitive, la seconde
 * se retente.
 */
export type ServerTemplateApplyFailure = Partial<ServerTemplateApplyResult> & {
  error?: string;
  appliedAt?: string;
};

/**
 * Pose la selection, en adoptant ce que l'administrateur a designe.
 *
 * `adopt` porte les clefs du plan qu'un salon ou un role existant remplit deja.
 * Le bot les fait entrer dans sa trace avant de poser quoi que ce soit : ces
 * elements sont alors repris tels quels - ni renommes, ni deplaces, ni
 * repermissionnes - et seul ce qui reste dans `selection` sans y figurer est
 * reellement cree.
 */
export async function applyServerTemplate(
  selection: string[],
  adopt: Record<string, string> = {},
  guildId = authStore.selectedGuildId,
): Promise<ServerTemplateApplyResult> {
  return dashboardRequest('/server-template/apply', {
    method: 'POST',
    payload: { selection, adopt },
    guildId,
    errorContext: 'API Error (Server Template Apply):',
    // La page rend elle-meme le detail de ce qui a ete cree, et son propre
    // message d'erreur : le toast generique du socle ferait doublon.
    silent: true,
  });
}

// ── Créations à la demande du parcours ───────────────────────────────────────

/**
 * L'usage d'un salon que le parcours sait poser lui-même.
 *
 * Ce ne sont pas des salons quelconques : chacun correspond à une liste
 * déroulante d'un écran, et c'est le seul endroit où le manque se constate.
 */
export type OnboardingChannelPurpose = 'logs' | 'staffAlerts' | 'drops';

export type OnboardingChannelResult = { id: string; name: string; created: boolean };

/**
 * Crée le salon dont un écran a besoin, quand le serveur n'en a aucun.
 *
 * Sans cela, il fallait quitter le parcours, aller créer un `#log` sur
 * Discord, revenir et rafraîchir : trois gestes hors du produit, au moment
 * même où on essaie de le montrer.
 */
export async function createOnboardingChannel(
  purpose: OnboardingChannelPurpose,
  guildId = authStore.selectedGuildId,
): Promise<OnboardingChannelResult> {
  return dashboardRequest('/server-template/channel', {
    method: 'POST',
    payload: { purpose },
    guildId,
    errorContext: 'API Error (Onboarding Channel):',
    silent: true,
  });
}


export type OnboardingRoleRequest = {
  key: string;
  name: string;
  color?: string;
  hoist?: boolean;
  power?: StaffRolePower;
};

export type OnboardingRolesResult = {
  roles: { key: string; id: string; name: string; created: boolean; color: string | null }[];
  warnings: string[];
};

/**
 * Crée une hiérarchie de rôles, du plus haut au plus bas.
 *
 * L'ordre du tableau est celui de la hiérarchie voulue : le bot s'en sert tel
 * quel, Discord empilant chaque nouveau rôle sous le précédent.
 */
export async function createOnboardingRoles(
  roles: OnboardingRoleRequest[],
  guildId = authStore.selectedGuildId,
): Promise<OnboardingRolesResult> {
  return dashboardRequest('/server-template/roles', {
    method: 'POST',
    payload: { roles },
    guildId,
    errorContext: 'API Error (Onboarding Roles):',
    silent: true,
  });
}
