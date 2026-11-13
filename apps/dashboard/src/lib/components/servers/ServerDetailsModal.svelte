<script lang="ts">
  /**
   * Fiche detaillee d'un serveur (externe ou courant), ouverte via
   * `serverDetailsModal.show(guildId, name)` depuis les analytics (tags, emojis,
   * stickers) ou la fiche d'un membre.
   */
  import Papicon from "../Papicon.svelte";
  import DetailSheet from "../DetailSheet.svelte";
  import { Button, Callout, EmptyState, SectionCard } from "../ui";
  import KpiTile from "../analytics/KpiTile.svelte";
  import { fmtNumber } from "../analytics/analyticsFormat";
  import { memberAvatarSrc } from "../../discordMedia";
  import { serverDetailsModal } from "../../stores/serverDetailsModal.svelte";
  import { memberCaseModal } from "../../stores/memberCaseModal.svelte";
  import { canViewFeature } from "../../permissions.svelte";
  import { fetchServerDetails, type ServerDetails } from "../../api";
  import { m, dateLocale } from "../../i18n";
  import { errorMessage } from "@kotbo/shared";

  type ServerTab = "overview" | "members" | "assets";

  let details = $state<ServerDetails | null>(null);
  let loading = $state(false);
  let error = $state("");
  let activeTab = $state<ServerTab>("overview");
  let requestId = 0;

  const isOpen = $derived(serverDetailsModal.open);
  const guildId = $derived(serverDetailsModal.guildId);
  const displayName = $derived(
    details?.server?.name ??
      serverDetailsModal.serverName ??
      (guildId ? m.anx_tags_private_server({ id: guildId }) : ""),
  );
  const canOpenMembers = $derived(canViewFeature("members"));

  $effect(() => {
    if (!isOpen || !guildId) return;
    void loadDetails(guildId);
  });

  $effect(() => {
    if (isOpen) return;
    details = null;
    error = "";
    loading = false;
    activeTab = "overview";
  });

  async function loadDetails(targetId: string) {
    const id = ++requestId;
    loading = true;
    error = "";
    try {
      const res = await fetchServerDetails(targetId);
      if (id !== requestId) return;
      details = res;
    } catch (err) {
      if (id !== requestId) return;
      error = errorMessage(err) || m.svd_load_error();
      details = null;
    } finally {
      if (id === requestId) loading = false;
    }
  }

  function closeModal() {
    serverDetailsModal.close();
  }

  function openMember(userId: string, userName: string) {
    if (!canOpenMembers) return;
    closeModal();
    void memberCaseModal.show(userId, userName);
  }

  const tabs = $derived([
    { id: "overview", label: m.svd_tab_overview(), icon: "Grid" },
    {
      id: "members",
      label: m.svd_tab_members(),
      icon: "Users",
      badge: details?.tagHolders.count || undefined,
    },
    {
      id: "assets",
      label: m.svd_tab_assets(),
      icon: "Smile",
      badge: details
        ? details.assets.emojis.length + details.assets.stickers.length ||
          undefined
        : undefined,
    },
  ]);

  function initials(label: string): string {
    const words = label.trim().split(/\s+/).filter(Boolean);
    if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
    return label.slice(0, 2).toUpperCase() || "SV";
  }
</script>

<DetailSheet
  open={isOpen}
  onClose={closeModal}
  title={displayName}
  ariaLabel={displayName}
  closeLabel={m.svd_close()}
  {tabs}
  {activeTab}
  onTabChange={(id) => (activeTab = id as ServerTab)}
  loading={loading && !details}
>
  {#snippet leading()}
    <div class="svd-icon">
      {#if details?.server.iconUrl}
        <img
          src={details.server.iconUrl}
          alt=""
          class="h-full w-full rounded-xl object-cover"
        />
      {:else}
        <span class="text-sm font-semibold text-on-surface-variant"
          >{initials(displayName)}</span
        >
      {/if}
    </div>
  {/snippet}

  {#snippet titleMeta()}
    {#if details?.server.tag}
      <span class="svd-tag-pill">
        {#if details.server.badgeUrl}
          <img
            src={details.server.badgeUrl}
            alt=""
            class="h-4 w-4 object-contain"
          />
        {/if}
        <span>{details.server.tag}</span>
      </span>
    {/if}
    {#if details?.server.isOwnGuild}
      <span class="badge badge-info">{m.svd_badge_own()}</span>
    {:else if details?.server.botPresent}
      <span class="badge badge-success">{m.svd_badge_bot_present()}</span>
    {:else if details}
      <span class="badge badge-neutral">{m.svd_badge_external()}</span>
    {/if}
  {/snippet}

  {#snippet subtitle()}
    {#if guildId}
      <span class="font-mono text-xs text-on-surface-variant">ID {guildId}</span
      >
    {/if}
    {#if details?.server.memberCount}
      <span aria-hidden="true">·</span>
      <span class="text-xs text-on-surface-variant"
        >{fmtNumber(details.server.memberCount)} membres</span
      >
    {/if}
  {/snippet}

  {#snippet actions()}
    <Button
      size="sm"
      variant="ghost"
      icon="x"
      aria-label={m.svd_close()}
      onclick={closeModal}
    />
  {/snippet}

  {#if error}
    <Callout variant="danger" title={m.an_error_generic()}>{error}</Callout>
  {:else if details}
    {#if activeTab === "overview"}
      <div class="space-y-4">
        {#if details.server.bannerUrl}
          <div class="overflow-hidden rounded-xl border border-outline-variant">
            <img
              src={details.server.bannerUrl}
              alt=""
              class="h-32 w-full object-cover"
            />
          </div>
        {/if}

        <div class="kpi-grid kpi-grid--4">
          <KpiTile
            label={m.svd_kpi_holders()}
            value={fmtNumber(details.tagHolders.count)}
          />
          <KpiTile
            label={m.svd_kpi_emojis()}
            value={fmtNumber(details.assets.emojis.length)}
          />
          <KpiTile
            label={m.svd_kpi_stickers()}
            value={fmtNumber(details.assets.stickers.length)}
          />
          <KpiTile
            label={m.svd_kpi_members()}
            value={details.server.memberCount !== null
              ? fmtNumber(details.server.memberCount)
              : "-"}
          />
        </div>

        <SectionCard title={m.svd_about_title()}>
          {#if details.server.description}
            <p class="text-sm leading-relaxed text-on-surface">
              {details.server.description}
            </p>
          {:else}
            <p class="text-sm text-on-surface-variant">{m.svd_about_empty()}</p>
          {/if}
        </SectionCard>

        {#if details.tagHolders.members.length > 0}
          <SectionCard title={m.svd_kpi_holders()} flush>
            <ul class="divide-y divide-outline-variant">
              {#each details.tagHolders.members.slice(0, 6) as holder (holder.userId)}
                <li>
                  {#if canOpenMembers}
                    <button
                      type="button"
                      class="svd-member-row"
                      onclick={() => openMember(holder.userId, holder.name)}
                    >
                      <img
                        src={memberAvatarSrc(
                          holder.avatarUrl,
                          holder.name,
                          holder.userId,
                        )}
                        alt=""
                        class="h-8 w-8 rounded-full object-cover"
                      />
                      <div class="min-w-0 flex-1 text-left">
                        <p class="truncate text-sm font-medium text-on-surface">
                          {holder.name}
                        </p>
                        {#if holder.username}
                          <p class="truncate text-xs text-on-surface-variant">
                            @{holder.username}
                          </p>
                        {/if}
                      </div>
                      <span class="svd-tag-pill">
                        {#if holder.badgeUrl}
                          <img
                            src={holder.badgeUrl}
                            alt=""
                            class="h-3.5 w-3.5 object-contain"
                          />
                        {/if}
                        <span>{holder.tag}</span>
                      </span>
                    </button>
                  {:else}
                    <div class="svd-member-row">
                      <img
                        src={memberAvatarSrc(
                          holder.avatarUrl,
                          holder.name,
                          holder.userId,
                        )}
                        alt=""
                        class="h-8 w-8 rounded-full object-cover"
                      />
                      <div class="min-w-0 flex-1 text-left">
                        <p class="truncate text-sm font-medium text-on-surface">
                          {holder.name}
                        </p>
                        {#if holder.username}
                          <p class="truncate text-xs text-on-surface-variant">
                            @{holder.username}
                          </p>
                        {/if}
                      </div>
                      <span class="svd-tag-pill">
                        {#if holder.badgeUrl}
                          <img
                            src={holder.badgeUrl}
                            alt=""
                            class="h-3.5 w-3.5 object-contain"
                          />
                        {/if}
                        <span>{holder.tag}</span>
                      </span>
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
          </SectionCard>
        {/if}
      </div>
    {:else if activeTab === "members"}
      {#if details.tagHolders.members.length === 0}
        <SectionCard>
          <EmptyState icon="users" title={m.svd_holders_empty()} />
        </SectionCard>
      {:else}
        <SectionCard flush>
          <ul class="divide-y divide-outline-variant">
            {#each details.tagHolders.members as holder (holder.userId)}
              <li>
                {#if canOpenMembers}
                  <button
                    type="button"
                    class="svd-member-row"
                    onclick={() => openMember(holder.userId, holder.name)}
                  >
                    <img
                      src={memberAvatarSrc(
                        holder.avatarUrl,
                        holder.name,
                        holder.userId,
                      )}
                      alt=""
                      class="h-8 w-8 rounded-full object-cover"
                    />
                    <div class="min-w-0 flex-1 text-left">
                      <p class="truncate text-sm font-medium text-on-surface">
                        {holder.name}
                      </p>
                      {#if holder.username}
                        <p class="truncate text-xs text-on-surface-variant">
                          @{holder.username}
                        </p>
                      {/if}
                    </div>
                    {#if holder.updatedAt}
                      <span
                        class="hidden text-xs text-on-surface-variant sm:inline"
                      >
                        {new Date(holder.updatedAt).toLocaleDateString(
                          dateLocale(),
                          { day: "2-digit", month: "short" },
                        )}
                      </span>
                    {/if}
                    <span class="svd-tag-pill">
                      {#if holder.badgeUrl}
                        <img
                          src={holder.badgeUrl}
                          alt=""
                          class="h-3.5 w-3.5 object-contain"
                        />
                      {/if}
                      <span>{holder.tag}</span>
                    </span>
                  </button>
                {:else}
                  <div class="svd-member-row">
                    <img
                      src={memberAvatarSrc(
                        holder.avatarUrl,
                        holder.name,
                        holder.userId,
                      )}
                      alt=""
                      class="h-8 w-8 rounded-full object-cover"
                    />
                    <div class="min-w-0 flex-1 text-left">
                      <p class="truncate text-sm font-medium text-on-surface">
                        {holder.name}
                      </p>
                      {#if holder.username}
                        <p class="truncate text-xs text-on-surface-variant">
                          @{holder.username}
                        </p>
                      {/if}
                    </div>
                    <span class="svd-tag-pill">
                      {#if holder.badgeUrl}
                        <img
                          src={holder.badgeUrl}
                          alt=""
                          class="h-3.5 w-3.5 object-contain"
                        />
                      {/if}
                      <span>{holder.tag}</span>
                    </span>
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        </SectionCard>
      {/if}
    {:else if activeTab === "assets"}
      {#if details.assets.emojis.length === 0 && details.assets.stickers.length === 0}
        <SectionCard>
          <EmptyState icon="smile" title={m.svd_assets_empty()} />
        </SectionCard>
      {:else}
        <div class="space-y-4">
          {#if details.assets.emojis.length > 0}
            <SectionCard
              title={m.svd_assets_emojis({
                count: details.assets.emojis.length,
              })}
            >
              <div
                class="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4"
              >
                {#each details.assets.emojis as emoji (emoji.id)}
                  <div
                    class="flex items-center gap-2.5 rounded-lg border border-outline-variant bg-surface-container px-3 py-2"
                  >
                    <img
                      src={emoji.imageUrl}
                      alt=""
                      class="h-7 w-7 shrink-0 object-contain"
                      loading="lazy"
                    />
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-xs font-medium text-on-surface">
                        :{emoji.name ?? "emoji"}:
                      </p>
                      <p class="text-[11px] text-on-surface-variant">
                        {m.svd_assets_uses({ count: fmtNumber(emoji.uses) })}
                      </p>
                    </div>
                  </div>
                {/each}
              </div>
            </SectionCard>
          {/if}

          {#if details.assets.stickers.length > 0}
            <SectionCard
              title={m.svd_assets_stickers({
                count: details.assets.stickers.length,
              })}
            >
              <div class="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                {#each details.assets.stickers as sticker (sticker.id)}
                  <div
                    class="flex items-center gap-2.5 rounded-lg border border-outline-variant bg-surface-container px-3 py-2"
                  >
                    <img
                      src={sticker.imageUrl}
                      alt=""
                      class="h-10 w-10 shrink-0 rounded object-contain"
                      loading="lazy"
                    />
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-xs font-medium text-on-surface">
                        {sticker.name ?? "Sticker"}
                      </p>
                      <p class="text-[11px] text-on-surface-variant">
                        {m.svd_assets_uses({ count: fmtNumber(sticker.uses) })}
                      </p>
                    </div>
                  </div>
                {/each}
              </div>
            </SectionCard>
          {/if}
        </div>
      {/if}
    {/if}
  {/if}
</DetailSheet>

<style>
  .svd-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 3rem;
    height: 3rem;
    border-radius: 0.75rem;
    background: var(--color-surface-container);
    border: 1px solid var(--color-outline-variant);
    overflow: hidden;
  }

  .svd-tag-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.125rem 0.5rem;
    border-radius: 0.375rem;
    border: 1px solid var(--color-outline-variant);
    background: var(--color-surface-container);
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-on-surface);
    white-space: nowrap;
  }

  .svd-member-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.75rem 1.25rem;
    transition: background-color 140ms ease;
  }

  button.svd-member-row:hover {
    background: var(--color-surface-container-low);
  }
</style>
