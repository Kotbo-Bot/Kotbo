<script lang="ts">
  import { m } from '../lib/i18n';
  import { removeWithUndo } from '../lib/undoRemoval';
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { pageTabItems } from '../lib/config/pageTabs';
  import { Tabs, Button, Callout, Modal, EmptyState, ToggleSwitch, FilterPills } from '../lib/components/ui';
  import { toast } from '../lib/stores/toast.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import FormInput from '../lib/components/FormInput.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import { channelDisplayName } from '../lib/channelUtils';
  import { buildMentionOptions, keyToMention, withMentionKey } from '../lib/socialMentions';
  import {
    fetchSocialFollows,
    addYoutubeFollow,
    deleteYoutubeFollow,
    addTwitchFollow,
    deleteTwitchFollow,
    saveGithubFollow,
    deleteGithubFollow,
    saveHuggingFaceFollow,
    deleteHuggingFaceFollow,
    type HuggingFaceKind,
  } from '../lib/api';

  type Network = 'youtube' | 'twitch' | 'github' | 'huggingface';
  const socialTabs = ['youtube', 'twitch', 'github', 'huggingface'] as const;
  let activeTab = $state<Network>('youtube');

  $effect(() => {
    const _path = $router.path;
    activeTab = resolveTabFromUrl('/social-networks', socialTabs, 'youtube') as Network;
  });

  let loading = $state(true);
  let saving = $state(false);
  let follows = $state<Record<Network, any[]>>({ youtube: [], twitch: [], github: [], huggingface: [] });
  /** Suivi en cours d'edition dans la fenetre ; sans `id`, c'est un ajout. */
  let draft = $state<any>(null);

  const guildState = $derived(dashboardStore.state as any);
  const channelOptions = $derived(
    ((guildState.discordChannels || []) as any[]).map((ch) => ({ id: ch.id, name: channelDisplayName(ch) })),
  );
  const mentionOptions = $derived(buildMentionOptions(guildState.discordRoles || []));
  const canManage = $derived(
    !!guildState.featureAccess?.social_networks?.canConfigure || !!guildState.access?.canManageSettings,
  );

  const GH_TYPES = [
    { key: 'notifyCommits', message: 'commitMessage', label: () => m.social_gh_type_commits() },
    { key: 'notifyReleases', message: 'releaseMessage', label: () => m.social_gh_type_releases() },
    { key: 'notifyPullRequests', message: 'pullRequestMessage', label: () => m.social_gh_type_pulls() },
    { key: 'notifyIssues', message: 'issueMessage', label: () => m.social_gh_type_issues() },
  ] as const;

  const HF_KINDS: Array<{ value: HuggingFaceKind; label: string }> = $derived([
    { value: 'MODEL', label: m.social_hf_kind_model() },
    { value: 'DATASET', label: m.social_hf_kind_dataset() },
    { value: 'SPACE', label: m.social_hf_kind_space() },
    { value: 'AUTHOR', label: m.social_hf_kind_author() },
  ]);

  const base = (d: any) => ({ discordChannelId: d.discordChannelId || null, mention: keyToMention(d.mentionKey) });

  /**
   * Ce qui change d'un reseau a l'autre. `key` est le champ qui identifie le
   * suivi : saisi a l'ajout, fige ensuite (l'API s'en sert pour retrouver le suivi).
   */
  const NETWORKS = {
    youtube: {
      key: 'query',
      name: (f: any) => f.channelName,
      href: (f: any) => `https://www.youtube.com/channel/${f.channelId}`,
      blank: () => ({ query: '', liveMessage: '', videoMessage: '', shortMessage: '' }),
      save: (d: any) => addYoutubeFollow({
        query: d.query?.trim(), channelId: d.channelId, ...base(d),
        liveMessage: d.liveMessage || null, videoMessage: d.videoMessage || null, shortMessage: d.shortMessage || null,
      }),
      remove: deleteYoutubeFollow,
      text: () => ({
        title: m.social_yt_form_title(), list: m.social_yt_list_title({ n: follows.youtube.length }), empty: m.social_yt_empty_title(),
        keyLabel: m.social_yt_query_label(), keyPh: m.social_yt_query_ph(), keyRequired: m.social_yt_err_query_req(),
        add: m.social_yt_add_btn(), deleted: m.social_yt_toast_deleted(), hint: '',
      }),
    },
    twitch: {
      key: 'streamerName',
      name: (f: any) => f.streamerName,
      href: (f: any) => `https://www.twitch.tv/${f.streamerName}`,
      blank: () => ({ streamerName: '', liveMessage: '' }),
      save: (d: any) => addTwitchFollow({ streamerName: d.streamerName.trim(), ...base(d), liveMessage: d.liveMessage || null }),
      remove: deleteTwitchFollow,
      text: () => ({
        title: m.social_twitch_form_title(), list: m.social_twitch_list_title({ n: follows.twitch.length }), empty: m.social_twitch_empty_title(),
        keyLabel: m.social_twitch_query_label(), keyPh: m.social_twitch_query_ph(), keyRequired: m.social_twitch_err_query_req(),
        add: m.social_twitch_add_btn(), deleted: m.social_twitch_toast_deleted(), hint: '',
      }),
    },
    github: {
      key: 'repo',
      name: (f: any) => f.repo,
      href: (f: any) => `https://github.com/${f.repo}`,
      blank: () => ({
        repo: '', branch: '', notifyCommits: true, notifyReleases: true, notifyPullRequests: false, notifyIssues: false,
        commitMessage: '', releaseMessage: '', pullRequestMessage: '', issueMessage: '',
      }),
      save: (d: any) => saveGithubFollow({
        repo: d.repo.trim(), branch: d.branch?.trim() || null, ...base(d),
        ...Object.fromEntries(GH_TYPES.flatMap((t) => [[t.key, !!d[t.key]], [t.message, d[t.message] || null]])),
      }),
      remove: deleteGithubFollow,
      text: () => ({
        title: m.social_gh_form_title(), list: m.social_gh_list_title({ n: follows.github.length }), empty: m.social_gh_empty_title(),
        keyLabel: m.social_gh_repo_label(), keyPh: m.social_gh_repo_ph(), keyRequired: m.social_gh_err_repo_req(),
        add: m.social_gh_add_btn(), deleted: m.social_gh_toast_deleted(), hint: m.social_gh_baseline_hint(),
      }),
    },
    huggingface: {
      key: 'target',
      name: (f: any) => f.target,
      href: (f: any) => `https://huggingface.co/${f.kind === 'DATASET' ? 'datasets/' : f.kind === 'SPACE' ? 'spaces/' : ''}${f.target}`,
      blank: () => ({ kind: 'MODEL', target: '', message: '' }),
      save: (d: any) => saveHuggingFaceFollow({ kind: d.kind, target: d.target.trim(), ...base(d), message: d.message || null }),
      remove: deleteHuggingFaceFollow,
      text: () => ({
        title: m.social_hf_form_title(), list: m.social_hf_list_title({ n: follows.huggingface.length }), empty: m.social_hf_empty_title(),
        keyLabel: m.social_hf_target_label(),
        keyPh: draft?.kind === 'AUTHOR' ? m.social_hf_target_ph_author() : m.social_hf_target_ph_repo(),
        keyRequired: m.social_hf_err_target_req(),
        add: m.social_hf_add_btn(), deleted: m.social_hf_toast_deleted(), hint: m.social_gh_baseline_hint(),
      }),
    },
  } as const;

  const net = $derived(NETWORKS[activeTab]);
  const text = $derived(net.text());
  const list = $derived(follows[activeTab]);

  // YouTube et Twitch ont chacun leur module d'annonces, en plus de celui de la page.
  const announcerOff = $derived(
    activeTab === 'youtube' || activeTab === 'twitch'
      ? (guildState.modules as any[] | undefined)?.some((mod) => mod.id === activeTab && mod.status !== 'active')
      : false,
  );

  async function loadData() {
    loading = true;
    try {
      await dashboardStore.refresh();
      const res = await fetchSocialFollows();
      if (res) {
        follows = {
          youtube: withMentionKey(res.youtube),
          twitch: withMentionKey(res.twitch),
          github: withMentionKey(res.github),
          huggingface: withMentionKey(res.huggingface),
        };
      }
    } catch (e) {
      console.error('Failed to load social follows:', e);
    } finally {
      loading = false;
    }
  }

  onMount(loadData);

  function openCreate() {
    draft = { ...net.blank(), discordChannelId: '', mentionKey: '' };
  }

  function openEdit(follow: any) {
    draft = { ...follow };
  }

  async function saveDraft() {
    if (!draft.id && !String(draft[net.key] ?? '').trim()) {
      toast.error(text.keyRequired);
      return;
    }
    const network = activeTab;
    saving = true;
    try {
      if (!(await NETWORKS[network].save(draft))) throw new Error(m.common_error());
      draft = null;
      const res = await fetchSocialFollows();
      if (res) follows[network] = withMentionKey(res[network]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.common_error());
    } finally {
      saving = false;
    }
  }

  function remove(follow: any) {
    const network = activeTab;
    return removeWithUndo({
      get: () => follows[network],
      set: (next) => (follows[network] = next),
      match: (f) => f.id === follow.id,
      message: NETWORKS[network].text().deleted,
      commit: () => NETWORKS[network].remove(follow.id, undefined, { silent: true }),
    });
  }

  /** Ligne de details sous le nom : salon, mention, puis ce qui est propre au reseau. */
  function details(follow: any): string[] {
    const parts = [
      channelOptions.find((c) => c.id === follow.discordChannelId)?.name ?? m.social_default_channel_short_ph(),
      mentionOptions.find((o) => o.id === follow.mentionKey)?.name,
    ];
    if (activeTab === 'github') {
      parts.push(follow.branch || m.social_gh_default_branch());
      parts.push(GH_TYPES.filter((t) => follow[t.key]).map((t) => t.label()).join(', '));
    }
    if (activeTab === 'huggingface') parts.unshift(HF_KINDS.find((k) => k.value === follow.kind)?.label);
    return parts.filter((p): p is string => !!p);
  }
</script>

{#snippet brandIcon(network: Network)}
  {#if network === 'youtube'}
    <svg class="w-4 h-4 fill-current" viewBox="0 0 24 24" aria-hidden="true"><path d="M23.498 6.163a3.003 3.003 0 0 0-2.11-2.11C19.518 3.545 12 3.545 12 3.545s-7.518 0-9.388.508a3.003 3.003 0 0 0-2.11 2.11C0 8.033 0 12 0 12s0 3.967.502 5.837a3.003 3.003 0 0 0 2.11 2.11c1.87.508 9.388.508 9.388.508s7.518 0 9.388-.508a3.002 3.002 0 0 0 2.11-2.11C24 15.967 24 12 24 12s0-3.967-.502-5.837zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
  {:else if network === 'twitch'}
    <svg class="w-4 h-4 fill-current" viewBox="0 0 24 24" aria-hidden="true"><path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/></svg>
  {:else if network === 'github'}
    <svg class="w-4 h-4 fill-current" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.2.5-2.3 1.3-3.1-.2-.4-.6-1.6 0-3.2 0 0 1-.3 3.4 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.8.1 3.2.8.8 1.3 1.9 1.3 3.2 0 4.6-2.8 5.6-5.5 5.9.5.4.9 1.1.9 2.2v3.3c0 .3.1.7.8.6A12 12 0 0 0 12 .3"/></svg>
  {:else}
    <span class="text-sm leading-none" aria-hidden="true">🤗</span>
  {/if}
{/snippet}

<ModulePage
  title={m.social_page_title()}
  description={m.social_page_desc()}
  icon="share-2"
  featureKey="social_networks"
>
  <Tabs
    label={m.social_page_title()}
    tabs={pageTabItems('/social-networks')}
    active={activeTab}
    onchange={(id) => gotoTab('/social-networks', id, 'youtube')}
  />

  {#if announcerOff}
    <Callout variant="warning" title={m.social_announcer_off_title({ network: activeTab === 'youtube' ? 'YouTube' : 'Twitch' })}>
      {m.social_announcer_off_desc()}
      {#snippet actions()}
        <Button variant="primary" size="sm" iconRight="ArrowRight" href="/modules">{m.social_banner_link_text()}</Button>
      {/snippet}
    </Callout>
  {/if}

  <div>
    <div class="flex items-center justify-between gap-4 mb-3">
      <div class="min-w-0">
        <h3 class="text-base font-semibold text-on-surface">{text.list}</h3>
        {#if text.hint}<p class="text-xs text-on-surface-variant">{text.hint}</p>{/if}
      </div>
      {#if canManage && list.length > 0}
        <Button variant="primary" icon="Plus" onclick={openCreate}>{text.title}</Button>
      {/if}
    </div>

    {#if loading}
      <div class="space-y-2">
        {#each Array(3) as _}
          <div class="h-16 rounded-xl bg-surface-container-low/30 border border-outline-variant/10 animate-pulse"></div>
        {/each}
      </div>
    {:else if list.length === 0}
      <EmptyState
        icon="share-2"
        title={text.empty}
        description={m.social_empty_hint()}
        actionLabel={canManage ? text.title : undefined}
        onAction={canManage ? openCreate : undefined}
        reason={canManage ? undefined : 'read-only'}
      />
    {:else}
      <ul class="space-y-2">
        {#each list as follow (follow.id)}
          <li class="group flex items-center gap-3 rounded-xl border border-outline-variant/20 hover:border-outline-variant/40 bg-surface-container-low/40 px-3 py-3 transition-colors">
            <span class="w-9 h-9 shrink-0 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface">
              {@render brandIcon(activeTab)}
            </span>

            <button
              type="button"
              class="flex-1 min-w-0 text-left rounded-lg disabled:cursor-default"
              disabled={!canManage}
              aria-label="{m.common_edit()} {net.name(follow)}"
              onclick={() => openEdit(follow)}
            >
              <span class="flex items-center gap-2 min-w-0">
                <span class="text-body-sm font-semibold text-on-surface truncate">{net.name(follow)}</span>
                {#if activeTab === 'twitch'}
                  <span class="shrink-0 px-2 py-0.5 rounded-md text-2xs font-medium {follow.isLive ? 'bg-error/15 text-error' : 'bg-surface-container-high text-on-surface-variant'}">
                    {follow.isLive ? m.social_status_live() : m.social_status_offline()}
                  </span>
                {/if}
              </span>
              <span class="block mt-0.5 text-xs text-on-surface-variant truncate">{details(follow).join(' · ')}</span>
            </button>

            <div class="flex items-center gap-1 shrink-0">
              <Button variant="ghost" size="sm" icon="ExternalLink" href={net.href(follow)} target="_blank" aria-label={net.name(follow)} />
              {#if canManage}
                <Button variant="ghost" size="sm" icon="Trash" aria-label={m.social_unfollow_tooltip()} onclick={() => remove(follow)} />
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <Modal
    open={!!draft}
    onClose={() => (draft = null)}
    title={draft?.id ? net.name(draft) : text.title}
    size="lg"
  >
    {#if draft}
      <div class="space-y-5">
        {#if !draft.id}
          {#if activeTab === 'huggingface'}
            <div class="space-y-1.5">
              <span class="field-label">{m.social_hf_kind_label()}</span>
              <FilterPills label={m.social_hf_kind_label()} options={HF_KINDS} value={draft.kind} onchange={(v) => (draft.kind = v)} />
            </div>
          {/if}
          <div class="space-y-1.5">
            <FormInput id="social-key" label={text.keyLabel} bind:value={draft[net.key]} placeholder={text.keyPh} className="w-full" />
            {#if activeTab === 'huggingface'}<p class="text-xs text-on-surface-variant">{m.social_hf_target_hint()}</p>{/if}
          </div>
        {/if}

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="space-y-1.5">
            <label for="social-channel" class="field-label">{m.social_channel_alerts_label()}</label>
            <SearchableSelect id="social-channel" bind:value={draft.discordChannelId} options={channelOptions} placeholder={m.social_default_channel_ph()} className="w-full" />
          </div>
          <div class="space-y-1.5">
            <label for="social-mention" class="field-label">{m.social_mention_label()}</label>
            <SearchableSelect id="social-mention" bind:value={draft.mentionKey} options={mentionOptions} placeholder={m.social_mention_ph()} className="w-full" />
          </div>
          {#if activeTab === 'github'}
            <FormInput id="social-branch" label={m.social_gh_branch_label()} bind:value={draft.branch} placeholder={m.social_gh_branch_ph()} className="w-full" />
          {/if}
        </div>

        <div class="space-y-3">
          <p class="field-label">{activeTab === 'github' ? m.social_gh_types_label() : m.social_messages_by_type()}</p>
          {#if activeTab === 'youtube'}
            <FormInput id="social-yt-live" label={m.social_msg_type_live()} bind:value={draft.liveMessage} placeholder={m.social_yt_live_msg_ph()} className="w-full" />
            <FormInput id="social-yt-video" label={m.social_msg_type_video()} bind:value={draft.videoMessage} placeholder={m.social_yt_video_msg_ph()} className="w-full" />
            <FormInput id="social-yt-short" label={m.social_msg_type_short()} bind:value={draft.shortMessage} placeholder={m.social_yt_short_msg_ph()} className="w-full" />
          {:else if activeTab === 'twitch'}
            <FormInput id="social-twitch-live" label={m.social_twitch_live_msg_label()} bind:value={draft.liveMessage} placeholder={m.social_twitch_live_msg_ph()} className="w-full" />
          {:else if activeTab === 'github'}
            <div class="rounded-xl border border-outline-variant/20 divide-y divide-outline-variant/20">
              {#each GH_TYPES as type (type.key)}
                <div class="px-4 py-3 space-y-2">
                  <div class="flex items-center justify-between gap-4">
                    <span class="text-body-sm font-medium text-on-surface">{type.label()}</span>
                    <ToggleSwitch size="sm" checked={draft[type.key]} ariaLabel={type.label()} onToggle={(v) => (draft[type.key] = v)} />
                  </div>
                  {#if draft[type.key]}
                    <FormInput id="social-gh-{type.message}" bind:value={draft[type.message]} placeholder={m.social_default_msg_ph()} className="w-full" />
                  {/if}
                </div>
              {/each}
            </div>
          {:else}
            <FormInput id="social-hf-msg" label={m.social_hf_message_label()} bind:value={draft.message} placeholder={m.social_default_msg_ph()} className="w-full" />
          {/if}
          <p class="text-xs text-on-surface-variant">{activeTab === 'youtube' || activeTab === 'twitch' ? m.social_msg_vars_hint() : m.social_gh_vars_hint()}</p>
        </div>
      </div>
    {/if}

    {#snippet footer()}
      <div class="flex items-center justify-end gap-2">
        <Button variant="ghost" onclick={() => (draft = null)}>{m.common_cancel()}</Button>
        <Button variant="primary" loading={saving} onclick={saveDraft}>{draft?.id ? m.common_save() : text.add}</Button>
      </div>
    {/snippet}
  </Modal>
</ModulePage>
