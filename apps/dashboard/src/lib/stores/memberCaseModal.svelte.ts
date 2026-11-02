import type { MemberCaseResponse } from '@kotbo/contracts';
import { fetchMemberCase } from '../api';
import { canViewFeature } from '../permissions.svelte';
import { authStore } from './auth.svelte';

/**
 * Fiche membre ouverte d'un clic sur un pseudo, depuis n'importe quelle page.
 *
 * C'est la fiche de la section Membres, sanctions comprises : un rôle à qui le centre de
 * gestion ferme « Membres » ne l'ouvre d'aucune page. Le contrôle vit ici plutôt que dans
 * chaque page, pour qu'aucune ne puisse l'oublier (l'API la refuserait de toute façon).
 */
class MemberCaseModalStore {
  open = $state(false);
  userId = $state('');
  userName = $state('');
  caseData = $state<MemberCaseResponse | null>(null);
  loading = $state(false);
  error = $state('');

  get canOpen(): boolean {
    return canViewFeature('members');
  }

  async show(userId: string, userName = userId) {
    if (!this.canOpen || !authStore.selectedGuildId || !userId) return;
    this.userId = userId;
    this.userName = userName;
    this.open = true;
    this.loading = true;
    this.error = '';
    this.caseData = null;
    try {
      const data = await fetchMemberCase(userId, authStore.selectedGuildId);
      // Un second clic pendant le chargement l'emporte : la réponse du premier arrive
      // parfois après et afficherait le dossier d'un autre membre sous son nom.
      if (this.userId === userId) this.caseData = data;
    } catch (err) {
      if (this.userId === userId) this.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (this.userId === userId) this.loading = false;
    }
  }

  close() {
    this.open = false;
  }
}

export const memberCaseModal = new MemberCaseModalStore();
