<script lang="ts">
  /**
   * Boutique du serveur : offres (rôles, objets, XP, abonnements, prestations),
   * commandes à valider, codes promo et réglages. Vendue sur le site et sur
   * Discord, payée en monnaie du bot.
   */
  import { onMount } from 'svelte';
  import { SHOP_OFFER_KINDS, normalizeShopOffer, type ShopOfferKind } from '@kotbo/shared';
  import { Button, EmptyState, Field, Modal, SectionCard, ToggleSwitch } from '../ui';
  import { toast } from '../../stores/toast.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { m } from '../../i18n';
  import {
    createShopCode,
    createShopOffer,
    decideShopOrder,
    deleteShopCode,
    deleteShopOffer,
    fetchShopAdmin,
    fetchSiteCatalog,
    reorderShopOffers,
    saveShopSettingsAdmin,
    updateShopCode,
    updateShopOffer,
    type ShopAdminState,
    type ShopOfferAdmin,
    type ShopOrderAdmin,
    type ShopPromoCodeAdmin,
    type SiteCatalog,
  } from '../../api/site';
  import { siteErrorMessage } from './siteErrors';

  let { guildId }: { guildId: string } = $props();

  let shop = $state<ShopAdminState | null>(null);
  let channels = $state<SiteCatalog['channels']>([]);
  let loading = $state(true);

  const KIND_LABELS: Record<ShopOfferKind, () => string> = {
    ROLE: () => m.ste_shop_kind_role(),
    ITEM: () => m.ste_shop_kind_item(),
    XP: () => m.ste_shop_kind_xp(),
    SUBSCRIPTION: () => m.ste_shop_kind_subscription(),
    CUSTOM: () => m.ste_shop_kind_custom(),
  };
  const KIND_HINTS: Record<ShopOfferKind, () => string> = {
    ROLE: () => m.ste_shop_kind_role_hint(),
    ITEM: () => m.ste_shop_kind_item_hint(),
    XP: () => m.ste_shop_kind_xp_hint(),
    SUBSCRIPTION: () => m.ste_shop_kind_subscription_hint(),
    CUSTOM: () => m.ste_shop_kind_custom_hint(),
  };

  async function load() {
    try {
      shop = await fetchShopAdmin(guildId);
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
    fetchSiteCatalog(guildId)
      .then((catalog) => (channels = catalog.channels))
      .catch(() => {});
  });

  const price = (amount: number) => `${amount.toLocaleString()} ${shop?.currency.emoji ?? ''} ${shop?.currency.name ?? ''}`.replace(/\s+/g, ' ').trim();
  const roleName = (id: string | null) => shop?.roles.find((r) => r.id === id)?.name ?? id ?? '';
  const itemLabel = (id: string | null) => {
    const item = shop?.items.find((i) => i.id === id);
    return item ? `${item.emoji} ${item.name}`.trim() : '?';
  };

  function summary(offer: ShopOfferAdmin): string {
    switch (offer.kind) {
      case 'ROLE':
        return offer.durationDays ? m.ste_shop_sum_role_timed({ role: roleName(offer.roleId), days: offer.durationDays }) : m.ste_shop_sum_role({ role: roleName(offer.roleId) });
      case 'SUBSCRIPTION':
        return m.ste_shop_sum_subscription({ role: roleName(offer.roleId), days: offer.durationDays ?? 30 });
      case 'ITEM':
        return m.ste_shop_sum_item({ item: itemLabel(offer.itemId), count: offer.quantity });
      case 'XP':
        return m.ste_shop_sum_xp({ count: offer.quantity });
      default:
        return m.ste_shop_kind_custom();
    }
  }

  // ─── Offre ────────────────────────────────────────────────────────────────

  interface OfferDraft {
    kind: ShopOfferKind;
    name: string;
    description: string;
    imageUrl: string;
    category: string;
    price: number;
    roleId: string;
    durationDays: string;
    itemId: string;
    quantity: number;
    stock: string;
    perMemberLimit: string;
    requiredRoleIds: string[];
    minLevel: number;
    requiresApproval: boolean;
    giftable: boolean;
    enabled: boolean;
  }

  const emptyDraft = (): OfferDraft => ({
    kind: 'ROLE',
    name: '',
    description: '',
    imageUrl: '',
    category: '',
    price: 100,
    roleId: '',
    durationDays: '',
    itemId: '',
    quantity: 1,
    stock: '',
    perMemberLimit: '',
    requiredRoleIds: [],
    minLevel: 0,
    requiresApproval: false,
    giftable: true,
    enabled: true,
  });

  let offerOpen = $state(false);
  let editingOffer = $state<ShopOfferAdmin | null>(null);
  let draft = $state<OfferDraft>(emptyDraft());
  let savingOffer = $state(false);
  const assignableRoles = $derived(shop?.roles.filter((r) => r.assignable) ?? []);

  function openOffer(offer: ShopOfferAdmin | null) {
    editingOffer = offer;
    draft = offer
      ? {
          kind: offer.kind,
          name: offer.name,
          description: offer.description,
          imageUrl: offer.imageUrl ?? '',
          category: offer.category ?? '',
          price: offer.price,
          roleId: offer.roleId ?? '',
          durationDays: offer.durationDays === null ? '' : String(offer.durationDays),
          itemId: offer.itemId ?? '',
          quantity: offer.quantity,
          stock: offer.stock === null ? '' : String(offer.stock),
          perMemberLimit: offer.perMemberLimit === null ? '' : String(offer.perMemberLimit),
          requiredRoleIds: [...offer.requiredRoleIds],
          minLevel: offer.minLevel,
          requiresApproval: offer.requiresApproval,
          giftable: offer.giftable,
          enabled: offer.enabled,
        }
      : emptyDraft();
    if (!offer && draft.kind === 'SUBSCRIPTION') draft.durationDays = '30';
    offerOpen = true;
  }

  function pickKind(kind: ShopOfferKind) {
    draft.kind = kind;
    if (kind === 'SUBSCRIPTION' && !draft.durationDays) draft.durationDays = '30';
    if (kind === 'XP' && draft.quantity < 10) draft.quantity = 500;
  }

  function toggleRequiredRole(id: string) {
    draft.requiredRoleIds = draft.requiredRoleIds.includes(id) ? draft.requiredRoleIds.filter((r) => r !== id) : [...draft.requiredRoleIds, id];
  }

  const OFFER_ERRORS: Record<string, () => string> = {
    name_required: () => m.ste_shop_err_name(),
    invalid_price: () => m.ste_shop_err_price(),
    role_required: () => m.ste_shop_err_role(),
    item_required: () => m.ste_shop_err_item(),
    invalid_duration: () => m.ste_shop_err_duration(),
    invalid_quantity: () => m.ste_shop_err_quantity(),
    invalid_kind: () => m.ste_err_invalid(),
  };

  async function saveOffer(event: SubmitEvent) {
    event.preventDefault();
    const payload: Record<string, unknown> = {
      ...draft,
      imageUrl: draft.imageUrl.trim() || null,
      category: draft.category.trim() || null,
      durationDays: draft.durationDays === '' ? null : Number(draft.durationDays),
      stock: draft.stock === '' ? null : Number(draft.stock),
      perMemberLimit: draft.perMemberLimit === '' ? null : Number(draft.perMemberLimit),
      roleId: draft.roleId || null,
      itemId: draft.itemId || null,
    };
    const checked = normalizeShopOffer(payload);
    if ('error' in checked) {
      toast.error(OFFER_ERRORS[checked.error]());
      return;
    }
    savingOffer = true;
    try {
      if (editingOffer) await updateShopOffer(editingOffer.id, payload, guildId);
      else await createShopOffer(payload, guildId);
      toast.success(m.ste_shop_offer_saved());
      offerOpen = false;
      await load();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      savingOffer = false;
    }
  }

  async function toggleOffer(offer: ShopOfferAdmin, enabled: boolean) {
    try {
      await updateShopOffer(offer.id, { enabled }, guildId);
      offer.enabled = enabled;
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  async function removeOffer(offer: ShopOfferAdmin) {
    const ok = await confirmDialog.ask({ title: m.ste_shop_offer_delete_title(), description: m.ste_shop_offer_delete_confirm({ name: offer.name }), confirmLabel: m.common_delete(), variant: 'danger' });
    if (!ok) return;
    try {
      const { result } = await deleteShopOffer(offer.id, guildId);
      if (result === 'disabled') toast.info(m.ste_shop_offer_disabled_instead());
      await load();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  async function moveOffer(index: number, delta: number) {
    if (!shop) return;
    const list = [...shop.offers];
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    shop.offers = list;
    try {
      await reorderShopOffers(list.map((o) => o.id), guildId);
    } catch (err) {
      toast.error(siteErrorMessage(err));
      await load();
    }
  }

  // ─── Commandes ────────────────────────────────────────────────────────────

  let refusing = $state<ShopOrderAdmin | null>(null);
  let refuseOpen = $state(false);
  let refuseReason = $state('');
  let deciding = $state<string | null>(null);

  async function decide(order: ShopOrderAdmin, approve: boolean, reason = '') {
    deciding = order.id;
    try {
      await decideShopOrder(order.id, approve, reason, guildId);
      toast.success(approve ? m.ste_shop_order_approved() : m.ste_shop_order_refused());
      refuseOpen = false;
      await load();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      deciding = null;
    }
  }

  function askRefusal(order: ShopOrderAdmin) {
    refusing = order;
    refuseReason = '';
    refuseOpen = true;
  }

  const STATUS_LABELS: Record<ShopOrderAdmin['status'], () => string> = {
    PENDING: () => m.ste_shop_status_pending(),
    COMPLETED: () => m.ste_shop_status_completed(),
    REFUSED: () => m.ste_shop_status_refused(),
  };

  // ─── Codes promo ──────────────────────────────────────────────────────────

  let codeOpen = $state(false);
  let editingCode = $state<ShopPromoCodeAdmin | null>(null);
  let codeDraft = $state({ code: '', mode: 'percent' as 'percent' | 'amount', value: 10, maxUses: '', expiresAt: '', offerIds: [] as string[] });
  let savingCode = $state(false);

  function openCode(code: ShopPromoCodeAdmin | null) {
    editingCode = code;
    codeDraft = code
      ? {
          code: code.code,
          mode: code.percentOff ? 'percent' : 'amount',
          value: code.percentOff ?? code.amountOff ?? 0,
          maxUses: code.maxUses === null ? '' : String(code.maxUses),
          expiresAt: code.expiresAt ? code.expiresAt.slice(0, 10) : '',
          offerIds: [...code.offerIds],
        }
      : { code: '', mode: 'percent', value: 10, maxUses: '', expiresAt: '', offerIds: [] };
    codeOpen = true;
  }

  async function saveCode(event: SubmitEvent) {
    event.preventDefault();
    savingCode = true;
    const payload = {
      code: codeDraft.code,
      percentOff: codeDraft.mode === 'percent' ? codeDraft.value : null,
      amountOff: codeDraft.mode === 'amount' ? codeDraft.value : null,
      maxUses: codeDraft.maxUses === '' ? null : Number(codeDraft.maxUses),
      // Valable jusqu'au soir du jour choisi.
      expiresAt: codeDraft.expiresAt ? new Date(`${codeDraft.expiresAt}T23:59:59`).toISOString() : null,
      offerIds: codeDraft.offerIds,
    };
    try {
      if (editingCode) await updateShopCode(editingCode.id, payload, guildId);
      else await createShopCode(payload, guildId);
      toast.success(m.ste_shop_code_saved());
      codeOpen = false;
      await load();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      savingCode = false;
    }
  }

  async function toggleCode(code: ShopPromoCodeAdmin, enabled: boolean) {
    try {
      await updateShopCode(code.id, { enabled }, guildId);
      code.enabled = enabled;
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  async function removeCode(code: ShopPromoCodeAdmin) {
    const ok = await confirmDialog.ask({ title: m.ste_shop_code_delete_title(), description: m.ste_shop_code_delete_confirm({ code: code.code }), confirmLabel: m.common_delete(), variant: 'danger' });
    if (!ok) return;
    try {
      await deleteShopCode(code.id, guildId);
      await load();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  function toggleCodeOffer(id: string) {
    codeDraft.offerIds = codeDraft.offerIds.includes(id) ? codeDraft.offerIds.filter((o) => o !== id) : [...codeDraft.offerIds, id];
  }

  // ─── Réglages ─────────────────────────────────────────────────────────────

  async function saveSetting(patch: Record<string, unknown>) {
    try {
      const { settings } = await saveShopSettingsAdmin(patch, guildId);
      if (shop) shop.settings = settings;
      toast.success(m.ste_shop_settings_saved());
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  const dateOf = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
</script>

<div class="space-y-4">
  {#if shop && shop.pending.length > 0}
    <SectionCard title={m.ste_shop_pending_title({ count: shop.pending.length })} description={m.ste_shop_pending_desc()} icon="inbox" flush>
      <ul class="shop-list">
        {#each shop.pending as order (order.id)}
          <li>
            <div class="shop-main">
              <p class="shop-name">{order.offerName} · {price(order.price)}</p>
              <p class="shop-meta">
                {order.buyerName}{#if order.recipientId !== order.buyerId} → {order.recipientName}{/if} · {dateOf(order.createdAt)}
              </p>
              {#if order.note}<blockquote class="shop-note">{order.note}</blockquote>{/if}
            </div>
            <div class="shop-actions">
              <Button size="sm" variant="primary" loading={deciding === order.id} onclick={() => decide(order, true)}>{m.ste_shop_approve()}</Button>
              <Button size="sm" variant="ghost" onclick={() => askRefusal(order)}>{m.ste_shop_refuse()}</Button>
            </div>
          </li>
        {/each}
      </ul>
    </SectionCard>
  {/if}

  <SectionCard title={m.ste_shop_offers_title()} description={m.ste_shop_offers_desc()} icon="shopping-bag" flush>
    {#snippet actions()}
      <Button size="sm" icon="plus" onclick={() => openOffer(null)}>{m.ste_shop_offer_add()}</Button>
    {/snippet}
    {#if !loading && (shop?.offers.length ?? 0) === 0}
      <div class="p-6"><EmptyState icon="shopping-bag" title={m.ste_shop_offers_empty()} description={m.ste_shop_offers_empty_desc()} /></div>
    {:else if shop}
      <ul class="shop-list">
        {#each shop.offers as offer, index (offer.id)}
          <li class:is-off={!offer.enabled}>
            <div class="shop-main">
              <p class="shop-name">
                {offer.name}
                {#if offer.category}<span class="shop-chip">{offer.category}</span>{/if}
              </p>
              <p class="shop-meta">{summary(offer)} · {price(offer.price)}{#if offer.kind === 'SUBSCRIPTION'} / {m.ste_shop_period({ days: offer.durationDays ?? 30 })}{/if}</p>
              <p class="shop-meta">
                {m.ste_shop_sales_30d({ count: offer.sales30d.count, revenue: price(offer.sales30d.revenue) })}
                {#if offer.stock !== null} · {m.ste_shop_stock_left({ count: offer.stock })}{/if}
                {#if offer.requiresApproval} · {m.ste_shop_needs_approval()}{/if}
              </p>
              {#if offer.roleId && !shop.roles.find((r) => r.id === offer.roleId)?.assignable}
                <p class="shop-warning">{m.ste_shop_role_unassignable()}</p>
              {/if}
            </div>
            <div class="shop-actions">
              <ToggleSwitch size="sm" checked={offer.enabled} ariaLabel={m.ste_shop_offer_enabled()} onToggle={(v) => toggleOffer(offer, v)} />
              <Button size="sm" variant="ghost" icon="arrow-up" aria-label={m.ste_move_up()} onclick={() => moveOffer(index, -1)} />
              <Button size="sm" variant="ghost" icon="arrow-down" aria-label={m.ste_move_down()} onclick={() => moveOffer(index, 1)} />
              <Button size="sm" variant="ghost" icon="edit-2" aria-label={m.ste_shop_offer_edit()} onclick={() => openOffer(offer)} />
              <Button size="sm" variant="ghost" icon="trash-2" aria-label={m.common_delete()} onclick={() => removeOffer(offer)} />
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </SectionCard>

  <SectionCard title={m.ste_shop_codes_title()} description={m.ste_shop_codes_desc()} icon="tag" flush>
    {#snippet actions()}
      <Button size="sm" variant="secondary" icon="plus" onclick={() => openCode(null)}>{m.ste_shop_code_add()}</Button>
    {/snippet}
    {#if shop && shop.codes.length > 0}
      <ul class="shop-list">
        {#each shop.codes as code (code.id)}
          <li class:is-off={!code.enabled}>
            <div class="shop-main">
              <p class="shop-name font-mono">{code.code}</p>
              <p class="shop-meta">
                {code.percentOff ? `−${code.percentOff} %` : `−${price(code.amountOff ?? 0)}`}
                · {code.maxUses === null ? m.ste_shop_code_uses_open({ count: code.uses }) : m.ste_shop_code_uses({ count: code.uses, max: code.maxUses })}
                {#if code.expiresAt} · {m.ste_shop_code_until({ date: new Date(code.expiresAt).toLocaleDateString() })}{/if}
                {#if code.offerIds.length > 0} · {m.ste_shop_code_offers({ count: code.offerIds.length })}{/if}
              </p>
            </div>
            <div class="shop-actions">
              <ToggleSwitch size="sm" checked={code.enabled} ariaLabel={m.ste_shop_offer_enabled()} onToggle={(v) => toggleCode(code, v)} />
              <Button size="sm" variant="ghost" icon="edit-2" aria-label={m.ste_shop_code_edit()} onclick={() => openCode(code)} />
              <Button size="sm" variant="ghost" icon="trash-2" aria-label={m.common_delete()} onclick={() => removeCode(code)} />
            </div>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="px-5 pb-5 text-body-sm text-on-surface-variant">{m.ste_shop_codes_empty()}</p>
    {/if}
  </SectionCard>

  {#if shop}
    <SectionCard title={m.ste_shop_settings_title()} icon="settings">
      <div class="px-5 pb-5 grid gap-4 md:grid-cols-2">
        <div class="flex items-center justify-between gap-3 md:col-span-2">
          <div>
            <p class="text-body-sm font-medium text-on-surface">{m.ste_shop_open()}</p>
            <p class="text-body-sm text-on-surface-variant">{m.ste_shop_open_desc()}</p>
          </div>
          <ToggleSwitch checked={shop.settings.enabled} ariaLabel={m.ste_shop_open()} onToggle={(v) => saveSetting({ enabled: v })} />
        </div>
        <Field label={m.ste_shop_approval_channel()} hint={m.ste_shop_approval_channel_hint()}>
          {#snippet children(id, describedBy)}
            <select {id} aria-describedby={describedBy} class="input w-full" value={shop!.settings.approvalChannelId ?? ''} onchange={(e) => saveSetting({ approvalChannelId: (e.currentTarget as HTMLSelectElement).value || null })}>
              <option value="">{m.ste_announce_none()}</option>
              {#each channels as channel (channel.id)}<option value={channel.id}>#{channel.name}</option>{/each}
            </select>
          {/snippet}
        </Field>
        <Field label={m.ste_shop_log_channel()} hint={m.ste_shop_log_channel_hint()}>
          {#snippet children(id, describedBy)}
            <select {id} aria-describedby={describedBy} class="input w-full" value={shop!.settings.logChannelId ?? ''} onchange={(e) => saveSetting({ logChannelId: (e.currentTarget as HTMLSelectElement).value || null })}>
              <option value="">{m.ste_announce_none()}</option>
              {#each channels as channel (channel.id)}<option value={channel.id}>#{channel.name}</option>{/each}
            </select>
          {/snippet}
        </Field>
        <Field label={m.ste_shop_grace_days()} hint={m.ste_shop_grace_days_hint()}>
          {#snippet children(id, describedBy)}
            <input {id} aria-describedby={describedBy} class="input w-full" type="number" min="0" max="14" value={shop!.settings.graceDays} onchange={(e) => saveSetting({ graceDays: Number((e.currentTarget as HTMLInputElement).value) })} />
          {/snippet}
        </Field>
      </div>
    </SectionCard>

    <SectionCard title={m.ste_shop_recent_title()} icon="clock" flush>
      {#if shop.recent.length === 0}
        <p class="px-5 pb-5 text-body-sm text-on-surface-variant">{m.ste_shop_recent_empty()}</p>
      {:else}
        <ul class="shop-list">
          {#each shop.recent as order (order.id)}
            <li>
              <div class="shop-main">
                <p class="shop-name">{order.offerName} · {price(order.price)}{#if order.price !== order.listPrice} <span class="shop-strike">{price(order.listPrice)}</span>{/if}</p>
                <p class="shop-meta">
                  {order.buyerName}{#if order.recipientId !== order.buyerId} → {order.recipientName}{/if} · {dateOf(order.createdAt)}
                  {#if order.source === 'renewal'} · {m.ste_shop_source_renewal()}{:else if order.source === 'discord'} · Discord{:else} · {m.ste_shop_source_site()}{/if}
                </p>
              </div>
              <span class="shop-status status-{order.status.toLowerCase()}">{STATUS_LABELS[order.status]()}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </SectionCard>
  {/if}
</div>

<Modal bind:open={offerOpen} title={editingOffer ? m.ste_shop_offer_edit() : m.ste_shop_offer_add()} size="lg">
  <form id="shop-offer-form" class="space-y-4" onsubmit={saveOffer}>
    <Field label={m.ste_shop_kind()} hint={KIND_HINTS[draft.kind]()}>
      {#snippet children(id, describedBy)}
        <select {id} aria-describedby={describedBy} class="input w-full" value={draft.kind} onchange={(e) => pickKind((e.currentTarget as HTMLSelectElement).value as ShopOfferKind)}>
          {#each SHOP_OFFER_KINDS as kind (kind)}<option value={kind}>{KIND_LABELS[kind]()}</option>{/each}
        </select>
      {/snippet}
    </Field>
    <div class="grid gap-3 md:grid-cols-[2fr_1fr]">
      <Field label={m.ste_shop_name()} required>
        {#snippet children(id)}
          <input {id} class="input w-full" maxlength="80" required bind:value={draft.name} />
        {/snippet}
      </Field>
      <Field label={m.ste_shop_price({ currency: shop?.currency.name ?? '' })} required>
        {#snippet children(id)}
          <input {id} class="input w-full" type="number" min="0" required bind:value={draft.price} />
        {/snippet}
      </Field>
    </div>
    <Field label={m.ste_shop_description()}>
      {#snippet children(id)}
        <textarea {id} class="input w-full" rows="2" maxlength="600" bind:value={draft.description}></textarea>
      {/snippet}
    </Field>

    {#if draft.kind === 'ROLE' || draft.kind === 'SUBSCRIPTION'}
      <div class="grid gap-3 md:grid-cols-2">
        <Field label={m.ste_shop_role()} hint={m.ste_shop_role_hint()} required>
          {#snippet children(id, describedBy)}
            <select {id} aria-describedby={describedBy} class="input w-full" required bind:value={draft.roleId}>
              <option value=""></option>
              {#each assignableRoles as role (role.id)}<option value={role.id}>@{role.name}</option>{/each}
            </select>
          {/snippet}
        </Field>
        <Field label={draft.kind === 'SUBSCRIPTION' ? m.ste_shop_period_days() : m.ste_shop_duration_days()} hint={draft.kind === 'SUBSCRIPTION' ? undefined : m.ste_shop_duration_hint()} required={draft.kind === 'SUBSCRIPTION'}>
          {#snippet children(id, describedBy)}
            <input {id} aria-describedby={describedBy} class="input w-full" type="number" min="1" max="365" required={draft.kind === 'SUBSCRIPTION'} bind:value={draft.durationDays} />
          {/snippet}
        </Field>
      </div>
    {:else if draft.kind === 'ITEM'}
      <div class="grid gap-3 md:grid-cols-[2fr_1fr]">
        <Field label={m.ste_shop_item()} required>
          {#snippet children(id)}
            <select {id} class="input w-full" required bind:value={draft.itemId}>
              <option value=""></option>
              {#each shop?.items ?? [] as item (item.id)}<option value={item.id}>{item.emoji} {item.name}</option>{/each}
            </select>
          {/snippet}
        </Field>
        <Field label={m.ste_shop_quantity()}>
          {#snippet children(id)}
            <input {id} class="input w-full" type="number" min="1" max="1000" bind:value={draft.quantity} />
          {/snippet}
        </Field>
      </div>
    {:else if draft.kind === 'XP'}
      <Field label={m.ste_shop_xp_amount()}>
        {#snippet children(id)}
          <input {id} class="input w-full" type="number" min="1" max="1000000" bind:value={draft.quantity} />
        {/snippet}
      </Field>
    {/if}

    <div class="grid gap-3 md:grid-cols-2">
      <Field label={m.ste_shop_category()} hint={m.ste_shop_category_hint()}>
        {#snippet children(id, describedBy)}
          <input {id} aria-describedby={describedBy} class="input w-full" maxlength="40" bind:value={draft.category} />
        {/snippet}
      </Field>
      <Field label={m.ste_shop_image()}>
        {#snippet children(id)}
          <input {id} class="input w-full" type="url" placeholder="https://" bind:value={draft.imageUrl} />
        {/snippet}
      </Field>
    </div>

    <fieldset class="shop-rules">
      <legend>{m.ste_shop_rules()}</legend>
      <div class="grid gap-3 md:grid-cols-3">
        <Field label={m.ste_shop_stock()} hint={m.ste_shop_unlimited_hint()}>
          {#snippet children(id, describedBy)}
            <input {id} aria-describedby={describedBy} class="input w-full" type="number" min="0" bind:value={draft.stock} />
          {/snippet}
        </Field>
        <Field label={m.ste_shop_per_member()} hint={m.ste_shop_unlimited_hint()}>
          {#snippet children(id, describedBy)}
            <input {id} aria-describedby={describedBy} class="input w-full" type="number" min="1" bind:value={draft.perMemberLimit} />
          {/snippet}
        </Field>
        <Field label={m.ste_shop_min_level()}>
          {#snippet children(id)}
            <input {id} class="input w-full" type="number" min="0" max="1000" bind:value={draft.minLevel} />
          {/snippet}
        </Field>
      </div>
      <div class="space-y-1">
        <p class="text-body-sm font-medium text-on-surface">{m.ste_shop_required_roles()}</p>
        <p class="text-body-sm text-on-surface-variant">{m.ste_shop_required_roles_hint()}</p>
        <div class="role-grid">
          {#each shop?.roles ?? [] as role (role.id)}
            <label class="flex items-center gap-2 text-body-sm">
              <input type="checkbox" checked={draft.requiredRoleIds.includes(role.id)} onchange={() => toggleRequiredRole(role.id)} />
              <span style="color:{role.color === '#000000' ? 'inherit' : role.color}">@{role.name}</span>
            </label>
          {/each}
        </div>
      </div>
      {#if draft.kind !== 'CUSTOM'}
        <label class="flex items-center justify-between gap-3 text-body-sm">
          <span>{m.ste_shop_requires_approval()}</span>
          <ToggleSwitch size="sm" checked={draft.requiresApproval} ariaLabel={m.ste_shop_requires_approval()} onToggle={(v) => (draft.requiresApproval = v)} />
        </label>
      {/if}
      {#if draft.kind !== 'SUBSCRIPTION'}
        <label class="flex items-center justify-between gap-3 text-body-sm">
          <span>{m.ste_shop_giftable()}</span>
          <ToggleSwitch size="sm" checked={draft.giftable} ariaLabel={m.ste_shop_giftable()} onToggle={(v) => (draft.giftable = v)} />
        </label>
      {/if}
    </fieldset>
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (offerOpen = false)}>{m.common_cancel()}</Button>
    <Button variant="primary" type="submit" form="shop-offer-form" loading={savingOffer}>{m.common_save()}</Button>
  {/snippet}
</Modal>

<Modal bind:open={codeOpen} title={editingCode ? m.ste_shop_code_edit() : m.ste_shop_code_add()} size="md">
  <form id="shop-code-form" class="space-y-4" onsubmit={saveCode}>
    <Field label={m.ste_shop_code()} hint={m.ste_shop_code_hint()} required>
      {#snippet children(id, describedBy)}
        <input {id} aria-describedby={describedBy} class="input w-full font-mono uppercase" maxlength="32" required bind:value={codeDraft.code} />
      {/snippet}
    </Field>
    <div class="grid gap-3 grid-cols-2">
      <Field label={m.ste_shop_code_kind()}>
        {#snippet children(id)}
          <select {id} class="input w-full" bind:value={codeDraft.mode}>
            <option value="percent">{m.ste_shop_code_percent()}</option>
            <option value="amount">{m.ste_shop_code_amount({ currency: shop?.currency.name ?? '' })}</option>
          </select>
        {/snippet}
      </Field>
      <Field label={m.ste_shop_code_value()} required>
        {#snippet children(id)}
          <input {id} class="input w-full" type="number" min="1" max={codeDraft.mode === 'percent' ? 100 : undefined} required bind:value={codeDraft.value} />
        {/snippet}
      </Field>
      <Field label={m.ste_shop_code_max_uses()} hint={m.ste_shop_unlimited_hint()}>
        {#snippet children(id, describedBy)}
          <input {id} aria-describedby={describedBy} class="input w-full" type="number" min="1" bind:value={codeDraft.maxUses} />
        {/snippet}
      </Field>
      <Field label={m.ste_shop_code_expires()}>
        {#snippet children(id)}
          <input {id} class="input w-full" type="date" bind:value={codeDraft.expiresAt} />
        {/snippet}
      </Field>
    </div>
    {#if shop && shop.offers.length > 0}
      <div class="space-y-1">
        <p class="text-body-sm font-medium text-on-surface">{m.ste_shop_code_scope()}</p>
        <p class="text-body-sm text-on-surface-variant">{m.ste_shop_code_scope_hint()}</p>
        <div class="role-grid">
          {#each shop.offers as offer (offer.id)}
            <label class="flex items-center gap-2 text-body-sm">
              <input type="checkbox" checked={codeDraft.offerIds.includes(offer.id)} onchange={() => toggleCodeOffer(offer.id)} />
              <span>{offer.name}</span>
            </label>
          {/each}
        </div>
      </div>
    {/if}
    <p class="text-body-sm text-on-surface-variant">{m.ste_shop_code_once()}</p>
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (codeOpen = false)}>{m.common_cancel()}</Button>
    <Button variant="primary" type="submit" form="shop-code-form" loading={savingCode}>{m.common_save()}</Button>
  {/snippet}
</Modal>

<Modal bind:open={refuseOpen} title={m.ste_shop_refuse_title()} size="sm">
  {#if refusing}
    <p class="text-body-sm text-on-surface-variant mb-3">{m.ste_shop_refuse_desc({ name: refusing.offerName, price: price(refusing.price) })}</p>
  {/if}
  <Field label={m.ste_shop_refuse_reason()}>
    {#snippet children(id)}
      <textarea {id} class="input w-full" rows="3" maxlength="300" bind:value={refuseReason}></textarea>
    {/snippet}
  </Field>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (refuseOpen = false)}>{m.common_cancel()}</Button>
    <Button variant="danger" loading={deciding === refusing?.id} onclick={() => refusing && decide(refusing, false, refuseReason.trim())}>{m.ste_shop_refuse()}</Button>
  {/snippet}
</Modal>

<style>
  .shop-list { list-style: none; margin: 0; padding: 0; }
  .shop-list li { display: flex; gap: 12px; align-items: flex-start; padding: 12px 16px; border-top: 1px solid var(--color-outline-variant); }
  .shop-list li.is-off { opacity: 0.6; }
  .shop-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .shop-name { margin: 0; font-weight: 600; color: var(--color-on-surface); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .shop-meta { margin: 0; font-size: 0.82rem; color: var(--color-on-surface-variant); }
  .shop-warning { margin: 0; font-size: 0.82rem; color: var(--color-warning); }
  .shop-chip { font-size: 0.72rem; font-weight: 500; padding: 1px 7px; border-radius: 4px; background: var(--color-surface-container); color: var(--color-on-surface-variant); }
  .shop-note { margin: 4px 0 0; padding: 6px 10px; border-left: 3px solid var(--color-outline-variant); font-size: 0.85rem; color: var(--color-on-surface); white-space: pre-wrap; }
  .shop-actions { display: flex; align-items: center; gap: 4px; flex: none; }
  .shop-strike { font-weight: 400; text-decoration: line-through; color: var(--color-on-surface-variant); font-size: 0.82rem; }
  .shop-status { flex: none; font-size: 0.78rem; padding: 2px 8px; border-radius: 4px; background: var(--color-surface-container); color: var(--color-on-surface-variant); }
  .shop-status.status-completed { color: var(--color-success); }
  .shop-status.status-refused { color: var(--color-error); }
  .shop-status.status-pending { color: var(--color-warning); }
  .shop-rules { border: 1px solid var(--color-outline-variant); border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; gap: 12px; }
  .shop-rules legend { padding: 0 6px; font-size: 0.85rem; font-weight: 600; color: var(--color-on-surface); }
  .role-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 4px 12px; max-height: 160px; overflow: auto; }
</style>
