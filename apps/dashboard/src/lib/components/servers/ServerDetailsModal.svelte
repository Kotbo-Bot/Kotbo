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
  import BarList from "../analytics/BarList.svelte";
  import TimeSeriesChart from "../analytics/TimeSeriesChart.svelte";
  import { SERIES, fmtNumber, shortDate } from "../analytics/analyticsFormat";
  import { memberAvatarSrc } from "../../discordMedia";
  import { serverDetailsModal } from "../../stores/serverDetailsModal.svelte";
  import { memberCaseModal } from "../../stores/memberCaseModal.svelte";
  import { inviteDetailsModal } from "../../stores/inviteDetailsModal.svelte";
  import { toast } from "../../stores/toast.svelte";
  import { canViewFeature } from "../../permissions.svelte";
  import { fetchServerDetails, fetchServerMemberInsights, type ServerDetails, type ServerMemberInsights, type ServerInsightsGroup, type TagAction, type TagTrigger } from "../../api";
  import TagRuleWizard from "../tagAutomod/TagRuleWizard.svelte";
  import { tagActionMeta, tagStatusMeta, tagTriggerLabel } from "../tagAutomod/tagAutomodLabels";
  import { router } from "tinro";
  import { m, dateLocale } from "../../i18n";
  import { errorMessage } from "@kotbo/shared";

  type ServerTab = "overview" | "members" | "moderation" | "assets";
  type Holder = ServerDetails["tagHolders"]["members"][number];

  let details = $state<ServerDetails | null>(null);
  let loading = $state(false);
  let error = $state("");
  let activeTab = $state<ServerTab>("overview");
  let requestId = 0;
  let insights = $state<ServerMemberInsights | null>(null);
  let insightsFor = $state<string | null>(null);
  let wizardOpen = $state(false);
  let wizardBlock = $state(true);

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
    insights = null;
    insightsFor = null;
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

  // Membres et Modération : chargés à la première ouverture d'un de ces onglets.
  $effect(() => {
    if (!isOpen || !guildId || insightsFor === guildId) return;
    if (activeTab !== "members" && activeTab !== "moderation") return;
    insightsFor = guildId;
    const target = guildId;
    void fetchServerMemberInsights(target)
      .then((res) => { if (serverDetailsModal.guildId === target) insights = res; })
      .catch(() => { if (serverDetailsModal.guildId === target) insights = null; });
  });

  const canModerateTags = $derived(canViewFeature("raid_protection"));

  function perMember(g: ServerInsightsGroup, value: number): number {
    return g.members > 0 ? value / g.members : 0;
  }

  type Comparison = { label: string; holders: number; others: number; format: (v: number) => string; higherIsWorse: boolean };
  const comparisons = $derived<Comparison[]>(insights ? [
    { label: m.svdx_cmp_messages(), holders: perMember(insights.holders, insights.holders.messages), others: perMember(insights.others, insights.others.messages), format: (v) => v.toLocaleString(dateLocale(), { maximumFractionDigits: 1 }), higherIsWorse: false },
    { label: m.svdx_cmp_active(), holders: perMember(insights.holders, insights.holders.active) * 100, others: perMember(insights.others, insights.others.active) * 100, format: (v) => `${Math.round(v)} %`, higherIsWorse: false },
    { label: m.svdx_cmp_voice(), holders: perMember(insights.holders, insights.holders.voiceMinutes), others: perMember(insights.others, insights.others.voiceMinutes), format: (v) => `${Math.round(v)} min`, higherIsWorse: false },
    { label: m.svdx_cmp_toxic(), holders: insights.holders.analyzed ? (insights.holders.toxic / insights.holders.analyzed) * 100 : 0, others: insights.others.analyzed ? (insights.others.toxic / insights.others.analyzed) * 100 : 0, format: (v) => `${v.toLocaleString(dateLocale(), { maximumFractionDigits: 1 })} %`, higherIsWorse: true },
    { label: m.svdx_cmp_sanctions(), holders: perMember(insights.holders, insights.holders.sanctions) * 100, others: perMember(insights.others, insights.others.sanctions) * 100, format: (v) => v.toLocaleString(dateLocale(), { maximumFractionDigits: 1 }), higherIsWorse: true },
  ] : []);

  function verdict(c: Comparison): { text: string; tone: string } | null {
    if (c.holders === 0 && c.others === 0) return null;
    if (c.others === 0) return { text: m.svdx_only_them(), tone: c.higherIsWorse ? "text-error" : "text-success" };
    const ratio = c.holders / c.others;
    if (ratio > 0.85 && ratio < 1.15) return { text: m.svdx_similar(), tone: "text-on-surface-variant" };
    const worse = (ratio > 1) === c.higherIsWorse;
    const text = ratio > 1 ? m.svdx_times_more({ ratio: ratio.toLocaleString(dateLocale(), { maximumFractionDigits: 1 }) }) : m.svdx_times_less({ ratio: (1 / Math.max(ratio, 0.01)).toLocaleString(dateLocale(), { maximumFractionDigits: 1 }) });
    return { text, tone: worse ? "text-error" : "text-success" };
  }

  const SANCTION_LABELS: Record<string, () => string> = {
    WARN: m.anx_mod_warn, TIMEOUT: m.anx_mod_timeout, KICK: m.anx_mod_kick, SOFTBAN: m.anx_mod_softban,
    TEMP_BAN: m.anx_mod_tempban, BAN: m.anx_mod_ban, JAIL: m.tam_action_jail,
  };
  const sanctionLabel = (type: string) => SANCTION_LABELS[type]?.() ?? type;

  function openTagWizard(block: boolean) {
    wizardBlock = block;
    wizardOpen = true;
  }

  function goToTagAutomod() {
    closeModal();
    router.goto("/security/filters/tags");
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
    ...(details?.server.isOwnGuild
      ? []
      : [{
          id: "moderation",
          label: m.svdx_tab_moderation(),
          icon: "ShieldAlert",
          badge: insights?.moderation.fleet.blocks || undefined,
        }]),
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

  const topAssets = $derived(
    details
      ? [...details.assets.emojis, ...details.assets.stickers]
          .filter((a) => a.uses > 0)
          .sort((a, b) => b.uses - a.uses)
          .slice(0, 5)
          .map((a) => ({
            id: a.id,
            label: a.kind === "emoji" ? `:${a.name ?? "emoji"}:` : (a.name ?? "Sticker"),
            value: a.uses,
            imageUrl: a.imageUrl,
          }))
      : [],
  );

  const profile = $derived(details?.profile);
  const inviteKindLabel = $derived(
    profile?.defaultInvite?.kind === "vanity"
      ? m.svd_default_invite_vanity()
      : profile?.defaultInvite?.kind === "widget"
        ? m.svd_default_invite_widget()
        : m.svd_default_invite_tracked(),
  );

  /** COMMUNITY → « Community » : les tags sont les noms Discord, sans traduction. */
  function prettyFeature(feature: string): string {
    const text = feature.toLowerCase().replace(/_/g, " ");
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function copyLink(url: string) {
    navigator.clipboard
      .writeText(url)
      .then(() => toast.success(m.svd_link_copied()))
      .catch(() => toast.warning(m.d7_inv_link_copy_fail()));
  }

  // Le détail du lien se lit dans la fiche d'invitation : la fiche serveur se ferme d'abord.
  function openInviteStats(code: string) {
    closeModal();
    inviteDetailsModal.show(code);
  }

  function initials(label: string): string {
    const words = label.trim().split(/\s+/).filter(Boolean);
    if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
    return label.slice(0, 2).toUpperCase() || "SV";
  }
</script>

  {#snippet holderBody(holder: Holder, showDate: boolean)}
    <img
      src={memberAvatarSrc(holder.avatarUrl, holder.name, holder.userId)}
      alt=""
      class="h-8 w-8 rounded-full object-cover"
    />
    <div class="min-w-0 flex-1 text-left">
      <p class="truncate text-sm font-medium text-on-surface">{holder.name}</p>
      {#if holder.username}
        <p class="truncate text-xs text-on-surface-variant">@{holder.username}</p>
      {/if}
    </div>
    {#if showDate && holder.updatedAt}
      <span class="hidden text-xs text-on-surface-variant sm:inline">
        {new Date(holder.updatedAt).toLocaleDateString(dateLocale(), {
          day: "2-digit",
          month: "short",
        })}
      </span>
    {/if}
    <span class="svd-tag-pill">
      {#if holder.badgeUrl}
        <img src={holder.badgeUrl} alt="" class="h-3.5 w-3.5 object-contain" />
      {/if}
      <span>{holder.tag}</span>
    </span>
  {/snippet}

  {#snippet holderList(list: Holder[], showDate: boolean)}
    <ul class="divide-y divide-outline-variant">
      {#each list as holder (holder.userId)}
        <li>
          {#if canOpenMembers}
            <button
              type="button"
              class="svd-member-row"
              onclick={() => openMember(holder.userId, holder.name)}
            >
              {@render holderBody(holder, showDate)}
            </button>
          {:else}
            <div class="svd-member-row">{@render holderBody(holder, showDate)}</div>
          {/if}
        </li>
      {/each}
    </ul>
  {/snippet}

<DetailSheet
  open={isOpen}
  onClose={closeModal}
  title={displayName}
  tabs={tabs}
  active={activeTab}
  onchange={(id) => (activeTab = id as ServerTab)}
  bannerUrl={details?.server.bannerUrl}
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

  {#snippet badges()}
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
      <span class="font-mono text-xs text-on-surface-variant">ID {guildId}</span>
    {/if}
    {#if details?.server.memberCount}
      <span aria-hidden="true">·</span>
      <span class="text-xs text-on-surface-variant">
        {m.svd_members_count({ count: fmtNumber(details.server.memberCount) })}
      </span>
    {/if}
    {#if details?.server.onlineCount}
      <span aria-hidden="true">·</span>
      <span class="inline-flex items-center gap-1 text-xs text-on-surface-variant">
        <span class="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true"></span>
        {m.svd_online_count({ count: fmtNumber(details.server.onlineCount) })}
      </span>
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
  {:else if loading && !details}
    <div class="svd-kpis" aria-busy="true">
      {#each [0, 1, 2, 3] as i (i)}
        <div class="h-24 animate-pulse rounded-xl bg-surface-container-low"></div>
      {/each}
    </div>
  {:else if details}
    {#if activeTab === "overview"}
      {@const activity = details.activity}
      {@const usage = details.assets.usageByDay ?? []}
      <div class="space-y-4">
        <div class="svd-kpis">
          <KpiTile
            label={m.svd_kpi_holders()}
            value={fmtNumber(details.tagHolders.count)}
            hint={activity?.shareOfGuild != null
              ? m.svd_kpi_holders_hint({ share: String(activity.shareOfGuild) })
              : ""}
          />
          <KpiTile
            label={m.svd_kpi_active7d()}
            value={activity ? fmtNumber(activity.active7d) : "-"}
          />
          <KpiTile
            label={m.svd_kpi_messages()}
            value={activity ? fmtNumber(activity.messages) : "-"}
            hint={activity
              ? m.svd_kpi_messages_hint({ hours: String(activity.voiceHours) })
              : ""}
          />
          <KpiTile
            label={m.svd_kpi_uses()}
            value={fmtNumber(details.assets.totalUses)}
            hint={m.svd_kpi_uses_hint({
              emojis: String(details.assets.emojis.length),
              stickers: String(details.assets.stickers.length),
            })}
          />
        </div>

        <div class="svd-split">
          <SectionCard title={m.svd_usage_title()}>
            {#if details.assets.totalUses > 0 && usage.length > 1}
              <TimeSeriesChart
                labels={usage.map((d) => shortDate(d.date))}
                mode="bar"
                main={{
                  label: m.svd_usage_series(),
                  values: usage.map((d) => d.count),
                  color: SERIES[0],
                }}
                format={(v) => fmtNumber(v)}
                height={200}
              />
            {:else}
              <EmptyState icon="smile" title={m.svd_usage_empty()} reason="accumulating" />
            {/if}
          </SectionCard>

          <SectionCard title={m.svd_top_assets()}>
            {#snippet actions()}
              {#if topAssets.length > 0}
                <Button size="sm" variant="ghost" onclick={() => (activeTab = "assets")}>
                  {m.svd_see_all()}
                </Button>
              {/if}
            {/snippet}
            <BarList items={topAssets} empty={m.svd_usage_empty()}>
              {#snippet leading(item)}
                <img src={item.imageUrl} alt="" class="h-5 w-5 shrink-0 object-contain" loading="lazy" />
              {/snippet}
            </BarList>
          </SectionCard>
        </div>

        <div class="svd-split">
          <SectionCard title={m.svd_kpi_holders()} flush>
            {#snippet actions()}
              {#if details && details.tagHolders.members.length > 5}
                <Button size="sm" variant="ghost" onclick={() => (activeTab = "members")}>
                  {m.svd_see_all()}
                </Button>
              {/if}
            {/snippet}
            {#if details.tagHolders.members.length > 0}
              {@render holderList(details.tagHolders.members.slice(0, 5), false)}
            {:else}
              <div class="p-5">
                <EmptyState icon="users" title={m.svd_holders_empty()} reason="all-clear" />
              </div>
            {/if}
          </SectionCard>

          <SectionCard title={m.svd_about_title()}>
            {#if details.server.description}
              <p class="text-sm leading-relaxed text-on-surface">
                {details.server.description}
              </p>
            {:else}
              <p class="text-sm text-on-surface-variant">{m.svd_about_empty()}</p>
            {/if}
          </SectionCard>
        </div>

        {#if profile}
          <div class="svd-split">
            <SectionCard title={m.svd_links_title()}>
              <div class="space-y-4">
                <div>
                  <p class="text-xs font-medium text-on-surface-variant">{m.svd_default_invite()}</p>
                  {#if profile.defaultInvite}
                    <p class="mt-0.5 truncate font-mono text-sm text-on-surface">{profile.defaultInvite.url}</p>
                    <p class="text-xs text-on-surface-variant">{inviteKindLabel}</p>
                    <div class="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" icon="copy" onclick={() => copyLink(profile.defaultInvite!.url)}>
                        {m.svd_copy_link()}
                      </Button>
                      <Button size="sm" variant="ghost" icon="external-link" href={profile.defaultInvite.url} target="_blank">
                        {m.svd_open_link()}
                      </Button>
                      {#if details.server.isOwnGuild}
                        <Button size="sm" variant="ghost" icon="bar-chart" onclick={() => openInviteStats(profile.defaultInvite!.code)}>
                          {m.svd_invite_stats()}
                        </Button>
                      {/if}
                    </div>
                  {:else}
                    <p class="mt-0.5 text-sm text-on-surface-variant">{m.svd_default_invite_none()}</p>
                  {/if}
                </div>

                <div>
                  <p class="text-xs font-medium text-on-surface-variant">{m.svd_discovery_page()}</p>
                  {#if profile.discoveryUrl}
                    <div class="mt-1 flex flex-wrap gap-2">
                      <Button size="sm" variant="ghost" icon="external-link" href={profile.discoveryUrl} target="_blank">
                        {m.svd_open_link()}
                      </Button>
                      <Button size="sm" variant="ghost" icon="copy" onclick={() => copyLink(profile.discoveryUrl!)}>
                        {m.svd_copy_link()}
                      </Button>
                    </div>
                  {:else}
                    <p class="mt-0.5 text-sm text-on-surface-variant">{m.svd_discovery_none()}</p>
                  {/if}
                </div>

                {#if profile.siteUrl}
                  <div>
                    <p class="text-xs font-medium text-on-surface-variant">{m.svd_site_page()}</p>
                    <div class="mt-1">
                      <Button size="sm" variant="ghost" icon="external-link" href={profile.siteUrl} target="_blank">
                        {m.svd_open_link()}
                      </Button>
                    </div>
                  </div>
                {/if}
              </div>
            </SectionCard>

            <SectionCard title={m.svd_info_title()}>
              <dl class="sheet-facts">
                <div>
                  <dt>{m.svd_info_created()}</dt>
                  <dd>{new Date(profile.createdAt).toLocaleDateString(dateLocale(), { day: "2-digit", month: "short", year: "numeric" })}</dd>
                </div>
                {#if profile.premiumTier !== null}
                  <div>
                    <dt>{m.svd_info_boosts()}</dt>
                    <dd>{m.svd_info_boosts_value({ tier: String(profile.premiumTier), count: fmtNumber(profile.boostCount ?? 0) })}</dd>
                  </div>
                {/if}
                {#if profile.locale}
                  <div><dt>{m.svd_info_locale()}</dt><dd>{profile.locale}</dd></div>
                {/if}
                {#if profile.verificationLevel !== null}
                  <div>
                    <dt>{m.svd_info_verification()}</dt>
                    <dd>{m.svd_info_verification_value({ level: String(profile.verificationLevel) })}</dd>
                  </div>
                {/if}
              </dl>
              <p class="mb-2 mt-4 text-xs font-medium text-on-surface-variant">{m.svd_tags_title()}</p>
              {#if profile.features.length > 0}
                <div class="flex flex-wrap gap-1.5">
                  {#each profile.features as feature (feature)}
                    <span class="svd-tag-pill">{prettyFeature(feature)}</span>
                  {/each}
                </div>
              {:else}
                <p class="text-sm text-on-surface-variant">{m.svd_tags_empty()}</p>
              {/if}
            </SectionCard>
          </div>
        {/if}
      </div>
    {:else if activeTab === "members"}
      <div class="space-y-4">
        {#if insights}
          <div class="svd-kpis">
            <KpiTile label={m.svdx_kpi_holders()} value={fmtNumber(insights.holders.members)} hint={m.svdx_kpi_holders_hint({ active: fmtNumber(insights.holders.active) })} />
            <KpiTile label={m.svdx_kpi_joined()} value={fmtNumber(insights.movement.joined30d)} hint={m.svdx_kpi_joined_hint()} />
            <KpiTile label={m.svdx_kpi_left()} value={fmtNumber(insights.movement.left30d)} hint={m.svdx_kpi_left_hint({ total: fmtNumber(insights.movement.leftTotal) })} />
            <KpiTile
              label={m.svdx_kpi_overlap()}
              value={insights.overlap.shared != null ? fmtNumber(insights.overlap.shared) : "-"}
              hint={insights.overlap.shared != null
                ? m.svdx_kpi_overlap_hint({ share: String(Math.round((insights.overlap.share ?? 0) * 1000) / 10) })
                : m.svdx_kpi_overlap_unknown()}
            />
          </div>

          {#if insights.holders.members > 0}
            <SectionCard title={m.svdx_cmp_title()} description={m.svdx_cmp_desc()}>
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <caption class="sr-only">{m.svdx_cmp_title()}</caption>
                  <thead>
                    <tr class="text-left text-xs text-on-surface-variant">
                      <th scope="col" class="py-2 pr-3 font-medium">{m.svdx_cmp_metric()}</th>
                      <th scope="col" class="py-2 px-3 font-medium text-right">{m.svdx_cmp_holders()}</th>
                      <th scope="col" class="py-2 px-3 font-medium text-right">{m.svdx_cmp_others()}</th>
                      <th scope="col" class="py-2 pl-3 font-medium text-right">{m.svdx_cmp_verdict()}</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-outline-variant">
                    {#each comparisons as c (c.label)}
                      {@const v = verdict(c)}
                      <tr>
                        <th scope="row" class="py-2 pr-3 text-left font-normal text-on-surface">{c.label}</th>
                        <td class="py-2 px-3 text-right font-medium text-on-surface tabular-nums">{c.format(c.holders)}</td>
                        <td class="py-2 px-3 text-right text-on-surface-variant tabular-nums">{c.format(c.others)}</td>
                        <td class="py-2 pl-3 text-right text-xs {v?.tone ?? ''}">{v?.text ?? "-"}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            </SectionCard>

            <SectionCard title={m.svdx_activity_title()}>
              <TimeSeriesChart
                labels={insights.activityByDay.map((d) => shortDate(d.date))}
                mode="bar"
                main={{ label: m.svdx_activity_series(), values: insights.activityByDay.map((d) => d.holders), color: SERIES[0] }}
                format={(v) => fmtNumber(v)}
                height={180}
              />
            </SectionCard>
          {/if}
        {/if}

        {#if details.tagHolders.members.length === 0}
          <SectionCard>
            <EmptyState icon="users" title={m.svd_holders_empty()} reason="all-clear" />
          </SectionCard>
        {:else}
          <SectionCard flush title={m.svdx_holders_list()}>
            {@render holderList(details.tagHolders.members, true)}
          </SectionCard>
        {/if}
      </div>
    {:else if activeTab === "moderation"}
      {#if !insights}
        <SectionCard><p class="py-6 text-center text-sm text-on-surface-variant">{m.svdx_loading()}</p></SectionCard>
      {:else}
        {@const mod = insights.moderation}
        <div class="space-y-4">
          {#if mod.fleet.blocks > 0 || mod.fleet.waveReports > 0}
            <Callout variant={mod.fleet.blocks >= 3 ? "danger" : "warning"}>
              {m.svdx_fleet_signal({ blocks: String(mod.fleet.blocks), waves: String(mod.fleet.waveReports) })}
            </Callout>
          {/if}

          <SectionCard title={m.svdx_rule_title()} description={m.svdx_rule_desc()}>
            <div class="flex flex-wrap items-center justify-between gap-3">
              {#if mod.rule}
                <p class="text-sm text-on-surface">
                  {mod.rule.effect === "ALLOW"
                    ? m.svdx_rule_allowed()
                    : m.svdx_rule_blocked({ action: tagActionMeta(mod.rule.action as TagAction).label })}
                  {#if !mod.rule.enabled}<span class="text-on-surface-variant"> · {m.svdx_rule_disabled()}</span>{/if}
                  {#if mod.rule.expiresAt}<span class="text-on-surface-variant"> · {m.tam_until({ date: new Date(mod.rule.expiresAt).toLocaleString(dateLocale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) })}</span>{/if}
                </p>
                {#if canModerateTags}<Button size="sm" variant="secondary" icon="Settings" onclick={goToTagAutomod}>{m.svdx_rule_manage()}</Button>{/if}
              {:else}
                <p class="text-sm text-on-surface-variant">{m.svdx_rule_none()}</p>
                {#if canModerateTags}
                  <span class="flex gap-2">
                    <Button size="sm" variant="secondary" icon="ShieldCheck" onclick={() => openTagWizard(false)}>{m.svdx_allow()}</Button>
                    <Button size="sm" variant="danger" icon="ShieldAlert" onclick={() => openTagWizard(true)}>{m.svdx_block()}</Button>
                  </span>
                {/if}
              {/if}
            </div>
          </SectionCard>

          <div class="svd-split">
            <SectionCard title={m.svdx_sanctions_title()} description={m.svdx_sanctions_desc()}>
              {#if mod.sanctionsByType.length === 0}
                <EmptyState icon="shieldcheck" title={m.svdx_sanctions_empty()} reason="all-clear" />
              {:else}
                <BarList items={mod.sanctionsByType.map((s) => ({ id: s.type, label: sanctionLabel(s.type), value: s.count }))} />
              {/if}
            </SectionCard>
            <SectionCard title={m.svdx_recent_title()} flush>
              {#if mod.recentSanctions.length === 0}
                <div class="p-4"><EmptyState icon="shieldcheck" title={m.svdx_sanctions_empty()} reason="all-clear" /></div>
              {:else}
                <ul class="divide-y divide-outline-variant">
                  {#each mod.recentSanctions as s (s.id)}
                    <li>
                      <button type="button" class="svd-member-row" disabled={!canOpenMembers} onclick={() => openMember(s.targetUserId, s.targetTag ?? s.targetUserId)}>
                        <div class="min-w-0 flex-1 text-left">
                          <p class="truncate text-sm font-medium text-on-surface">{s.targetTag ?? s.targetUserId}</p>
                          <p class="truncate text-xs text-on-surface-variant">{s.reason}</p>
                        </div>
                        <span class="text-xs text-on-surface">{sanctionLabel(s.type)}</span>
                        <span class="hidden text-xs text-on-surface-variant sm:inline">{new Date(s.createdAt).toLocaleDateString(dateLocale(), { day: "2-digit", month: "short" })}</span>
                      </button>
                    </li>
                  {/each}
                </ul>
              {/if}
            </SectionCard>
          </div>

          <SectionCard title={m.svdx_journal_title()} description={m.svdx_journal_desc({ waves: String(mod.waves) })} flush>
            {#if mod.events.length === 0}
              <div class="p-4"><EmptyState icon="shieldcheck" title={m.tam_journal_empty()} reason="all-clear" /></div>
            {:else}
              <ul class="divide-y divide-outline-variant">
                {#each mod.events as ev (ev.id)}
                  {@const st = tagStatusMeta(ev.status as "APPLIED")}
                  <li class="flex flex-wrap items-center gap-2 px-4 py-2.5 text-xs">
                    <span class="font-medium text-on-surface">{ev.userTag ?? ev.userId}</span>
                    <span class="text-on-surface-variant">{tagTriggerLabel(ev.trigger as TagTrigger)}</span>
                    <span class="text-on-surface">→ {tagActionMeta(ev.action as TagAction).label}</span>
                    <span class="rounded-full border px-2 py-0.5 text-2xs font-medium {st.className}">{st.label}</span>
                    <span class="ml-auto text-on-surface-variant">{new Date(ev.createdAt).toLocaleDateString(dateLocale(), { day: "2-digit", month: "short" })}</span>
                  </li>
                {/each}
              </ul>
            {/if}
          </SectionCard>
        </div>
      {/if}
    {:else if activeTab === "assets"}
      {#if details.assets.emojis.length === 0 && details.assets.stickers.length === 0}
        <SectionCard>
          <EmptyState icon="smile" title={m.svd_assets_empty()} reason="all-clear" />
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
                      <p class="text-2xs text-on-surface-variant">
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
                      <p class="text-2xs text-on-surface-variant">
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

{#if guildId}
  <TagRuleWizard
    bind:open={wizardOpen}
    aboveCase
    initial={{
      effect: wizardBlock ? "BLOCK" : "ALLOW",
      targetType: "SERVER",
      targetGuildId: guildId,
      targetName: details?.server.name ?? displayName,
      targetIcon: details?.server.iconUrl ?? null,
      action: "TICKET",
      escalateAfterMin: wizardBlock ? 1440 : null,
      escalateAction: wizardBlock ? "KICK" : null,
    }}
    onSaved={() => { insightsFor = null; }}
  />
{/if}

<style>
  /* Grille locale : la .kpi-grid d'Analytics n'est stylée que dans sa page. */
  .svd-kpis {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .svd-split {
    display: grid;
    gap: 1rem;
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
    align-items: start;
  }

  @media (max-width: 1023px) {
    .svd-split {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  @media (max-width: 639px) {
    .svd-kpis {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  .svd-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 3.5rem;
    height: 3.5rem;
    border-radius: 0.75rem;
    background: var(--surface-container);
    border: 1px solid var(--outline-variant);
    overflow: hidden;
  }

  .svd-tag-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.125rem 0.5rem;
    border-radius: 0.375rem;
    border: 1px solid var(--outline-variant);
    background: var(--surface-container);
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--on-surface);
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
    background: var(--surface-container-low);
  }
</style>
