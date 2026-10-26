/**
 * Listes de suivi reliées à un module, et ce qui y est déjà épinglé.
 *
 * La page Suggestions pose un bouton par carte : sans ce cache partagé, chaque
 * carte relirait les mêmes listes. Une lecture par module et par serveur, que
 * chaque épinglage met à jour sur place.
 */
import type { DoingListSource } from '@kotbo/contracts';
import { addDoingListItem, fetchDoingListLinks, removeDoingListItem, type DoingListLinks } from '../api/doingLists';
import { authStore } from './auth.svelte';

class DoingListLinksStore {
  byModule = $state<Record<string, DoingListLinks>>({});
  private pending = new Map<string, Promise<void>>();

  private key(module: DoingListSource) {
    return `${authStore.selectedGuildId}:${module}`;
  }

  get(module: DoingListSource): DoingListLinks | undefined {
    return this.byModule[this.key(module)];
  }

  load(module: DoingListSource, force = false): Promise<void> {
    const key = this.key(module);
    if (!force && (this.byModule[key] || this.pending.has(key))) return this.pending.get(key) ?? Promise.resolve();
    const run = fetchDoingListLinks(module)
      .then((links) => { this.byModule[key] = links; })
      // Section fermée au rôle ou module éteint : pas de bouton, pas d'erreur.
      .catch(() => { this.byModule[key] = { lists: [], items: [] }; })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, run);
    return run;
  }

  async toggle(module: DoingListSource, listId: string, sourceId: string): Promise<'added' | 'removed'> {
    const links = this.get(module);
    const existing = links?.items.find((item) => item.listId === listId && item.sourceId === sourceId);
    if (existing) {
      await removeDoingListItem(listId, existing.id);
      if (links) links.items = links.items.filter((item) => item.id !== existing.id);
      return 'removed';
    }
    const { item } = await addDoingListItem(listId, { sourceModule: module, sourceId });
    links?.items.push({ id: item.id, listId, sourceId });
    return 'added';
  }
}

export const doingListLinks = new DoingListLinksStore();
