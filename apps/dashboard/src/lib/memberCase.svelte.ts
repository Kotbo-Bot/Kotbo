import type { MemberCaseResponse } from '@kotbo/contracts';
import { fetchMemberCase } from './api';
import { canViewFeature } from './permissions.svelte';
import { authStore } from './stores/auth.svelte';

/**
 * État d'une fiche membre ouverte d'un clic : qui, son dossier, le chargement.
 *
 * C'est la fiche de la section Membres, sanctions comprises : un rôle à qui le centre de
 * gestion ferme « Membres » ne l'ouvre d'aucune page. Le contrôle vit ici plutôt que dans
 * chaque page, pour qu'aucune ne puisse l'oublier (l'API la refuserait de toute façon).
 *
 * Le store `memberCaseModal` en est l'instance partagée par tout le dashboard. Une page qui
 * règle la fiche à sa façon (raison préremplie, onglet propre, serveur du staff) crée la
 * sienne et monte sa propre `MemberCaseModal`.
 */
export class MemberCaseState {
  open = $state(false);
  userId = $state('');
  userName = $state('');
  caseData = $state<MemberCaseResponse | null>(null);
  loading = $state(false);
  error = $state('');
  /** Raison proposée d'avance pour une sanction depuis la fiche. */
  actionReason = $state('');

  /** Serveur sur lequel charger le dossier : le serveur sélectionné, sauf réglage contraire. */
  private readonly guildId: () => string | null;

  constructor(guildId: () => string | null = () => authStore.selectedGuildId) {
    this.guildId = guildId;
  }

  get canOpen(): boolean {
    return canViewFeature('members');
  }

  /**
   * Ouvre la fiche. Sans identifiant (une ligne de journal qui n'en porte pas), elle s'ouvre
   * sur le seul nom, sans dossier à charger.
   */
  async show(userId: string, userName = userId, actionReason = '') {
    if (!this.canOpen) return;
    const guildId = this.guildId();
    if (!guildId) return;
    this.userId = userId;
    this.userName = userName;
    this.actionReason = actionReason;
    this.open = true;
    this.error = '';
    this.caseData = null;
    this.loading = !!userId;
    if (!userId) return;
    try {
      const data = await fetchMemberCase(userId, guildId);
      // Un second clic pendant le chargement l'emporte : la réponse du premier arrive
      // parfois après et afficherait le dossier d'un autre membre sous son nom.
      if (this.userId === userId) this.caseData = data;
    } catch (err) {
      if (this.userId === userId) this.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (this.userId === userId) this.loading = false;
    }
  }

  /** Membre choisi dans le graphe d'interactions de la fiche ouverte. */
  showFromGraph(userId: string) {
    const node = this.caseData?.interactionGraph?.nodes?.find((n) => n.id === userId);
    void this.show(userId, node?.label || userId, this.actionReason);
  }

  close() {
    this.open = false;
  }
}
