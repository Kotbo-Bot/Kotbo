/**
 * Identité affichable des membres (pseudo, @, photo, tag de serveur), chargée à
 * la demande et partagée par tous les écrans.
 *
 * Chaque route renvoyait sa propre poignée de champs sur le membre, si bien que
 * le tag n'apparaissait que là où quelqu'un avait pensé à le joindre. Ici, un
 * composant n'a besoin que de l'identifiant : les demandes d'une même image
 * sont regroupées en un appel à `members/identities`, et le résultat reste en
 * cache pour le serveur courant.
 */
import { SvelteMap } from 'svelte/reactivity';
import { dashboardRequest } from '../api/client';
import { authStore } from './auth.svelte';

export type MemberServerTag = { guildId: string; tag: string; badgeUrl: string | null };

export type MemberIdentity = {
  username: string;
  displayName: string;
  avatarUrl: string | null;
  serverTag: MemberServerTag | null;
  /** Début du boost en cours (ISO), null si le membre ne booste pas. */
  boostingSince?: string | null;
};

/** Plafond de la route côté bot. */
const BATCH_SIZE = 100;

class MemberIdentityStore {
  /** Clé `guildId:userId`. `null` : demandé, mais inconnu de Discord. */
  #cache = new SvelteMap<string, MemberIdentity | null>();
  // Hors état réactif : `get` est appelé pendant le rendu, où Svelte interdit
  // d'écrire dans un $state.
  #requested = new Set<string>();
  #queue = new Set<string>();
  #scheduled = false;

  /** Identité du membre si elle est connue ; sinon la demande est lancée. */
  get(userId: string | null | undefined): MemberIdentity | undefined {
    const guildId = authStore.selectedGuildId;
    if (!userId || !guildId || !/^\d{15,21}$/.test(userId)) return undefined;
    const key = `${guildId}:${userId}`;
    const known = this.#cache.get(key);
    if (known !== undefined) return known ?? undefined;
    if (!this.#requested.has(key)) {
      this.#requested.add(key);
      this.#queue.add(userId);
      this.#schedule();
    }
    return undefined;
  }

  #schedule() {
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      const guildId = authStore.selectedGuildId;
      const ids = [...this.#queue];
      this.#queue.clear();
      if (!guildId) return;
      for (let i = 0; i < ids.length; i += BATCH_SIZE) void this.#load(guildId, ids.slice(i, i + BATCH_SIZE));
    });
  }

  async #load(guildId: string, ids: string[]) {
    const response = await dashboardRequest<{ identities: Record<string, MemberIdentity> }>(
      `/members/identities?ids=${ids.join(',')}`,
      { guildId, silent: true, errorContext: 'API Error (Member identities):' },
    ).catch(() => null);
    if (!response) {
      // Échec réseau : on retentera au prochain rendu plutôt que de figer un vide.
      for (const id of ids) this.#requested.delete(`${guildId}:${id}`);
      return;
    }
    for (const id of ids) this.#cache.set(`${guildId}:${id}`, response.identities?.[id] ?? null);
  }
}

export const memberIdentities = new MemberIdentityStore();
