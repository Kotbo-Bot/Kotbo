<script lang="ts">
  import { stripCustomEmoji } from '../lib/emojiParser';
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { pageTabItems } from '../lib/config/pageTabs';
  import { Tabs } from '../lib/components/ui';
  import { fetchMarketplaceData, fetchMemberCase } from '../lib/api';
  import { authStore } from '../lib/stores/auth.svelte';
  import { canViewFeature } from '../lib/permissions.svelte';
  import MemberCaseModal from '../lib/components/MemberCaseModal.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import UserDisplay from '../lib/components/UserDisplay.svelte';
  import { m } from '../lib/i18n';

  let loading = $state(true);
  let data: any = $state(null);
  const marketTabs = ['listings', 'history'] as const;
  let tab = $state<'listings' | 'history'>('listings');

  // Fiche membre ouverte d'un clic sur un vendeur ou un acheteur. C'est la même fiche que
  // la section Membres, avec ses sanctions : un rôle à qui le centre de gestion ferme
  // « Membres » ne l'ouvre pas d'ici non plus (l'API la refuserait de toute façon).
  const canOpenMemberCase = $derived(canViewFeature('members'));
  let caseOpen = $state(false);
  let caseUserId = $state('');
  let caseUserName = $state('');
  let caseData = $state<any>(null);
  let caseLoading = $state(false);
  let caseError = $state('');

  function memberName(userId: string): string {
    return data?.members?.[userId]?.displayName ?? userId;
  }

  async function openMemberCase(userId: string, name = memberName(userId)) {
    if (!authStore.selectedGuildId || !canOpenMemberCase) return;
    caseUserId = userId;
    caseUserName = name;
    caseOpen = true;
    caseLoading = true;
    caseError = '';
    caseData = null;
    try {
      caseData = await fetchMemberCase(userId, authStore.selectedGuildId);
    } catch (err) {
      caseError = err instanceof Error ? err.message : String(err);
    } finally {
      caseLoading = false;
    }
  }

  /** Clic sur un membre : ouvre sa fiche, seulement pour qui a accès à « Membres ». */
  const onMemberClick = $derived(canOpenMemberCase ? (userId: string) => openMemberCase(userId) : null);

  $effect(() => {
    const _path = $router.path;
    tab = resolveTabFromUrl('/marketplace', marketTabs, 'listings') as typeof tab;
  });

  async function load() {
    loading = true;
    try {
      data = await fetchMarketplaceData();
    } catch {
      toast.error(m.mar_load_error());
    } finally {
      loading = false;
    }
  }

  function getStatusClass(status: string): string {
    const map: Record<string, string> = {
      ACTIVE: 'bg-success/10 text-success border border-success/15',
      SOLD: 'bg-primary/10 text-primary border border-primary/15',
      CANCELLED: 'bg-surface-container-high/40 text-on-surface-variant border border-outline-variant/10',
      EXPIRED: 'bg-warning/10 text-warning border border-warning/15',
    };
    return map[status] ?? '';
  }

  function getStatusLabel(status: string): string {
    const map: Record<string, string> = {
      ACTIVE: m.mar_status_active(),
      SOLD: m.mar_status_sold(),
      CANCELLED: m.mar_status_cancelled(),
      EXPIRED: m.mar_status_expired()
    };
    return map[status] ?? status;
  }

  /** Nom lisible d'un objet vendu, avec son niveau de forge pour un exemplaire forgé. */
  function itemLabel(entry: { itemId: string; upgrade?: number; item?: { name: string; emoji: string } | null }): string {
    const name = entry.item ? `${stripCustomEmoji(entry.item.emoji)} ${entry.item.name}` : entry.itemId;
    return entry.upgrade && entry.upgrade > 0 ? `${name} +${entry.upgrade}` : name;
  }

  function getTypeLabel(type: string): string {
    return type === 'AUCTION' ? m.mar_type_auction() : m.mar_type_buy_now();
  }

  function formatTimeLeft(expiresAt: string): string {
    const diff = new Date(expiresAt).getTime() - Date.now();
    if (diff <= 0) return m.mar_expired();
    const hours = Math.floor(diff / 3600000);
    if (hours > 24) return m.mar_days_left({ days: Math.floor(hours / 24) });
    return m.mar_hours_left({ hours });
  }

  onMount(load);
</script>

<ModulePage
  title={m.mar_page_title()}
  description={m.mar_page_desc()}
  icon="shopping-bag"
  featureKey="marketplace"
>

<!-- ======================== CONTENT ======================== -->
{#if loading}
  <div class="flex flex-col items-center justify-center py-16 text-on-surface-variant gap-4">
    <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
    <p class="text-sm">{m.mar_loading()}</p>
  </div>
{:else if data}
  <!-- ======================== STATS ROW ======================== -->
  <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
    <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-4 flex items-center gap-3">
      <div class="w-10 h-10 rounded-xl flex items-center justify-center bg-success/10 text-success">
        <Papicon icon="shopping-bag" size={20} />
      </div>
      <div class="flex flex-col">
        <span class="text-2xl font-bold">{data.activeListings.length}</span>
        <span class="text-xs font-medium text-on-surface-variant mt-0.5">{m.mar_active_listings_stat()}</span>
      </div>
    </div>
    <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-4 flex items-center gap-3">
      <div class="w-10 h-10 rounded-xl flex items-center justify-center bg-primary/10 text-primary">
        <Papicon icon="trending-up" size={20} />
      </div>
      <div class="flex flex-col">
        <span class="text-2xl font-bold">{data.totalTransactions}</span>
        <span class="text-xs font-medium text-on-surface-variant mt-0.5">{m.mar_total_tx_stat()}</span>
      </div>
    </div>
    <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-4 flex items-center gap-3">
      <div class="w-10 h-10 rounded-xl flex items-center justify-center bg-warning/10 text-warning">
        <Papicon icon="dollar-sign" size={20} />
      </div>
      <div class="flex flex-col">
        <span class="text-2xl font-bold">{data.totalVolume.toLocaleString()}</span>
        <span class="text-xs font-medium text-on-surface-variant mt-0.5">{m.mar_total_volume_stat()}</span>
      </div>
    </div>
  </div>

  <!-- ======================== TABS ======================== -->
  <Tabs
    label={m.mar_page_title()}
    tabs={pageTabItems('/marketplace').map((item) => ({
      ...item,
      badge: item.id === 'listings' ? data.activeListings.length : data.recentTransactions.length,
    }))}
    active={tab}
    onchange={(id) => gotoTab('/marketplace', id, 'listings')}
  />

  <!-- ======================== TAB: LISTINGS ======================== -->
  {#if tab === 'listings'}
    {#if data.activeListings.length === 0}
      <div class="flex flex-col items-center justify-center py-16 text-on-surface-variant gap-4">
        <Papicon icon="shopping-bag" size={48} />
        <p class="text-sm">{m.mar_empty_listings_title()}</p>
        <p class="text-xs text-on-surface-variant/40">{m.mar_empty_listings_desc()}</p>
      </div>
    {:else}
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {#each data.activeListings as listing}
          <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-5 space-y-3 hover:border-primary/30 transition-colors">
            <!-- Top: name + status badge -->
            <div class="flex justify-between items-center">
              <h4 class="text-sm font-semibold text-on-surface">{itemLabel(listing)}</h4>
              <span class="px-2.5 py-0.5 rounded-full text-xs font-medium {getStatusClass(listing.status)}">{getStatusLabel(listing.status)}</span>
            </div>

            <!-- Price row -->
            <div class="flex justify-between items-center">
              <span class="flex items-center gap-1.5 text-base font-bold text-warning">
                <Papicon icon="dollar-sign" size={14} />
                {m.mar_price_coins({ price: listing.price.toLocaleString() })}
              </span>
              <span class="text-xs text-on-surface-variant font-medium">x{listing.quantity}</span>
            </div>

            <!-- Auction bid -->
            {#if listing.type === 'AUCTION' && listing.currentBid}
              <div class="flex items-center gap-1.5 text-xs text-primary font-medium">
                <Papicon icon="trending-up" size={13} />
                {m.mar_current_bid({ amount: listing.currentBid.toLocaleString() })}
              </div>
            {/if}

            <!-- Meta: type + time left -->
            <div class="flex items-center gap-3">
              <span class="px-2 py-0.5 rounded-lg text-xs font-medium bg-surface-container-high/40 text-on-surface-variant">{getTypeLabel(listing.type)}</span>
              <span class="flex items-center gap-1 text-xs text-on-surface-variant">
                <Papicon icon="clock" size={12} />
                {formatTimeLeft(listing.expiresAt)}
              </span>
            </div>

            <!-- Footer: seller -->
            <div class="pt-3 border-t border-outline-variant/10">
              <UserDisplay
                userId={listing.sellerId}
                name={data.members?.[listing.sellerId]?.displayName ?? null}
                avatarUrl={data.members?.[listing.sellerId]?.avatarUrl ?? null}
                size="xs"
                onClick={onMemberClick}
              />
            </div>
          </div>
        {/each}
      </div>
    {/if}

  <!-- ======================== TAB: HISTORY ======================== -->
  {:else}
    {#if data.recentTransactions.length === 0}
      <div class="flex flex-col items-center justify-center py-16 text-on-surface-variant gap-4">
        <Papicon icon="clock" size={48} />
        <p class="text-sm">{m.mar_empty_history_title()}</p>
        <p class="text-xs text-on-surface-variant/40">{m.mar_empty_history_desc()}</p>
      </div>
    {:else}
      <div class="flex flex-col gap-2">
        {#each data.recentTransactions as tx}
          <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl px-5 py-3.5 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
            <!-- Item info -->
            <div class="flex items-baseline gap-2 min-w-30">
              <span class="text-sm font-semibold text-on-surface">{itemLabel(tx)}</span>
              <span class="text-xs text-on-surface-variant">x{tx.quantity}</span>
            </div>

            <!-- Flow: seller -> buyer -->
            <div class="flex items-center gap-2 flex-1">
              <UserDisplay
                userId={tx.sellerId}
                name={data.members?.[tx.sellerId]?.displayName ?? null}
                avatarUrl={data.members?.[tx.sellerId]?.avatarUrl ?? null}
                size="xs"
                onClick={onMemberClick}
              />
              <div class="text-primary flex items-center">
                <Papicon icon="arrow-right" size={16} />
              </div>
              <UserDisplay
                userId={tx.buyerId}
                name={data.members?.[tx.buyerId]?.displayName ?? null}
                avatarUrl={data.members?.[tx.buyerId]?.avatarUrl ?? null}
                size="xs"
                onClick={onMemberClick}
              />
            </div>

            <!-- Price + date -->
            <div class="flex flex-col items-end gap-0.5 shrink-0">
              <span class="flex items-center gap-1 text-sm font-semibold text-warning">
                <Papicon icon="dollar-sign" size={13} />
                {m.mar_price_coins({ price: tx.price.toLocaleString() })}
              </span>
              <span class="text-2xs text-on-surface-variant">{new Date(tx.createdAt).toLocaleDateString('fr-FR')}</span>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
{/if}
</ModulePage>

<MemberCaseModal
  open={caseOpen}
  userId={caseUserId}
  userName={caseUserName}
  {caseData}
  loading={caseLoading}
  error={caseError}
  onClose={() => { caseOpen = false; }}
  onSelectUser={(newUserId) => {
    const node = caseData?.interactionGraph?.nodes?.find((n: any) => n.id === newUserId);
    openMemberCase(newUserId, node?.label || memberName(newUserId));
  }}
/>
