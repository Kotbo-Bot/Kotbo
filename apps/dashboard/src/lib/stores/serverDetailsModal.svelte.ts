/**
 * Ouverture globale de la fiche d'un serveur (externe ou courant).
 *
 * Meme pattern que `channelDetailsModal` et `inviteDetailsModal` : la modale
 * est montee une seule fois dans App.svelte, n'importe quel composant peut
 * l'ouvrir sans gerer d'etat local.
 */
class ServerDetailsModalStore {
  open = $state(false);
  guildId = $state<string | null>(null);
  /** Nom connu par l'appelant, affiche en en-tete le temps du chargement. */
  serverName = $state<string | null>(null);

  show(guildId: string, serverName?: string | null) {
    if (!guildId) return;
    this.guildId = guildId;
    this.serverName = serverName ?? null;
    this.open = true;
  }

  close() {
    this.open = false;
    this.guildId = null;
    this.serverName = null;
  }
}

export const serverDetailsModal = new ServerDetailsModalStore();

