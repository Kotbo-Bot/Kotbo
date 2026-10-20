<script lang="ts">
  import { stripCustomEmoji } from '../../emojiParser';
  import { explainDisabled } from '../../actions/explainDisabled';
  /**
   * Inventaire d'un joueur : consulter, donner, retirer.
   *
   * Sans cet écran, rendre un objet perdu ou retirer un objet obtenu par un bug passait
   * par les commandes d'administration, sur Discord, en tapant l'identifiant de l'objet.
   */
  import { onMount } from 'svelte';
  import { m } from '../../i18n';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { createAsyncActionState } from '../../asyncAction.svelte';
  import { fetchRpgPlayerInventory, grantRpgPlayerItem, removeRpgPlayerItem } from '../../api';
  import Papicon from '../Papicon.svelte';
  import EmojiText from '../EmojiText.svelte';
  import InlineFeedback from '../InlineFeedback.svelte';
  import SearchableSelect from '../SearchableSelect.svelte';

  type CatalogItem = { id: string; name: string; emoji: string; type: string };
  type Entry = { itemId: string; quantity: number; equipped: boolean; upgrade: number; item: CatalogItem };

  const {
    player,
    catalog = [],
    canManage = false,
    onClose,
    onChanged = () => {},
  }: {
    player: { userId: string; displayName?: string; username?: string };
    catalog?: CatalogItem[];
    canManage?: boolean;
    onClose: () => void;
    onChanged?: () => void;
  } = $props();

  const actionState = createAsyncActionState();
  let inventory = $state<Entry[]>([]);
  let loading = $state(true);
  let grantItemId = $state<string | null>(null);
  let grantQuantity = $state(1);

  const catalogOptions = $derived(catalog.map((item) => ({ id: item.id, name: `${stripCustomEmoji(item.emoji)} ${item.name}` })));

  async function load() {
    loading = true;
    try {
      const res = await fetchRpgPlayerInventory(player.userId);
      if (res) inventory = res.inventory ?? [];
    } catch (err) {
      console.error(err);
    } finally {
      loading = false;
    }
  }

  onMount(load);

  async function grant() {
    if (!grantItemId) return;
    const itemId = grantItemId;
    const quantity = Math.max(1, Math.trunc(Number(grantQuantity) || 1));
    await actionState.run(async () => {
      await grantRpgPlayerItem(player.userId, itemId, quantity);
      grantItemId = null;
      grantQuantity = 1;
      await load();
      onChanged();
      return true;
    });
  }

  async function remove(entry: Entry, quantity: number) {
    const description = entry.equipped && quantity >= entry.quantity ? m.eco_inventory_remove_equipped_hint() : '';
    if (!(await confirmDialog.danger(m.eco_inventory_remove_confirm({ quantity, item: entry.item.name }), description, m.eco_inventory_remove_btn()))) return;

    await actionState.run(async () => {
      await removeRpgPlayerItem(player.userId, entry.itemId, quantity);
      await load();
      onChanged();
      return true;
    });
  }
</script>

<div class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
  <div class="bg-surface-container rounded-xl border border-outline-variant/30 p-8 w-full max-w-2xl space-y-6 max-h-[90vh] overflow-y-auto animate-in zoom-in-95 duration-200">
    <div class="flex items-center justify-between gap-4">
      <h3 class="text-xl font-semibold">{m.eco_inventory_title({ name: player.displayName || player.username || player.userId })}</h3>
      <button type="button" onclick={onClose} aria-label={m.eco_btn_cancel()} class="p-2 rounded-lg hover:bg-outline-variant/15 transition-all">
        <Papicon icon="x" size={16} />
      </button>
    </div>

    <InlineFeedback state={actionState} />

    {#if canManage}
      <div class="bg-surface-container-high/30 border border-outline-variant/10 rounded-lg p-4 space-y-3">
        <h4 class="text-xs font-semibold text-on-surface-variant">{m.eco_inventory_grant_title()}</h4>
        <div class="flex flex-col sm:flex-row gap-2">
          <div class="flex-1">
            <SearchableSelect
              id="grantItem"
              bind:value={grantItemId}
              options={catalogOptions}
              placeholder={m.eco_inventory_grant_placeholder()}
              showId={false}
              className="w-full"
            />
          </div>
          <input
            type="number"
            min="1"
            max="999"
            aria-label={m.eco_inventory_quantity()}
            bind:value={grantQuantity}
            class="w-full sm:w-24 bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:outline-none"
          />
          <button
            type="button"
            onclick={grant}
            disabled={actionState.state.loading}
            use:explainDisabled={(!grantItemId) ? m.common_reason_fill_field() : ''}
            class="px-4 py-2 bg-primary hover:bg-primary-hover text-on-primary text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Papicon icon="Plus" size={13} /> {m.eco_inventory_grant_btn()}
          </button>
        </div>
      </div>
    {/if}

    {#if loading}
      <div class="flex items-center justify-center py-10">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    {:else if inventory.length === 0}
      <p class="text-center py-8 text-on-surface-variant italic text-xs">{m.eco_inventory_empty()}</p>
    {:else}
      <ul class="space-y-2">
        {#each inventory as entry (entry.itemId)}
          <li class="flex items-center justify-between gap-3 bg-surface-container-high/30 border border-outline-variant/10 rounded-lg px-4 py-3">
            <div class="flex items-center gap-3 min-w-0">
              <EmojiText value={entry.item.emoji} size="1.125rem" class="text-lg" />
              <div class="min-w-0">
                <div class="font-semibold text-sm truncate">
                  {entry.item.name}
                  <span class="text-on-surface-variant font-normal">x{entry.quantity}</span>
                </div>
                <div class="flex flex-wrap items-center gap-2 mt-0.5 text-2xs">
                  <span class="text-primary bg-primary/10 px-2 py-0.5 rounded-full">{entry.item.type}</span>
                  {#if entry.equipped}<span class="text-success font-bold">{m.eco_inventory_equipped()}</span>{/if}
                  {#if entry.upgrade > 0}<span class="text-warning font-bold">+{entry.upgrade}</span>{/if}
                </div>
              </div>
            </div>
            {#if canManage}
              <div class="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onclick={() => remove(entry, 1)}
                  disabled={actionState.state.loading}
                  class="px-2.5 py-1.5 bg-outline-variant/10 hover:bg-outline-variant/25 text-xs font-bold rounded-lg transition-all disabled:opacity-50"
                >
                  -1
                </button>
                {#if entry.quantity > 1}
                  <button
                    type="button"
                    onclick={() => remove(entry, entry.quantity)}
                    disabled={actionState.state.loading}
                    class="px-2.5 py-1.5 bg-error/10 hover:bg-error/20 text-error text-xs font-bold rounded-lg transition-all disabled:opacity-50"
                  >
                    {m.eco_inventory_remove_all()}
                  </button>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>
