<script lang="ts">
  /**
   * Onglet GitHub de la page Réseaux sociaux : ajout d'un dépôt et réglage des
   * dépôts suivis (types d'alertes, branche, salon, mention, messages).
   */
  import { m } from '../../i18n';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import Papicon from '../Papicon.svelte';
  import SearchableSelect from '../SearchableSelect.svelte';
  import ToggleSwitch from '../ToggleSwitch.svelte';
  import { saveGithubFollow, deleteGithubFollow, fetchSocialFollows, type GithubFollowPayload } from '../../api';
  import { keyToMention, withMentionKey, type SelectOption } from '../../socialMentions';

  type ActionState = {
    run: (action: () => Promise<unknown>, options?: { successMessage?: string }) => Promise<unknown>;
    setError: (error: string) => void;
  };

  let {
    follows = $bindable<any[]>([]),
    channelOptions,
    mentionOptions,
    canManage,
    actionState,
  }: {
    follows: any[];
    channelOptions: SelectOption[];
    mentionOptions: SelectOption[];
    canManage: boolean;
    actionState: ActionState;
  } = $props();

  const NOTIFY_TYPES = [
    { key: 'notifyCommits', message: 'commitMessage', label: () => m.social_gh_type_commits() },
    { key: 'notifyReleases', message: 'releaseMessage', label: () => m.social_gh_type_releases() },
    { key: 'notifyPullRequests', message: 'pullRequestMessage', label: () => m.social_gh_type_pulls() },
    { key: 'notifyIssues', message: 'issueMessage', label: () => m.social_gh_type_issues() },
  ] as const;

  function emptyForm() {
    return {
      repo: '',
      branch: '',
      discordChannelId: '',
      mention: '',
      notifyCommits: true,
      notifyReleases: true,
      notifyPullRequests: false,
      notifyIssues: false,
    };
  }

  let form = $state(emptyForm());

  function toPayload(source: any, repo: string): GithubFollowPayload {
    return {
      repo,
      branch: source.branch?.trim() || null,
      discordChannelId: source.discordChannelId || null,
      mention: keyToMention(source.mentionKey ?? source.mention),
      notifyCommits: !!source.notifyCommits,
      notifyReleases: !!source.notifyReleases,
      notifyPullRequests: !!source.notifyPullRequests,
      notifyIssues: !!source.notifyIssues,
      commitMessage: source.commitMessage || null,
      releaseMessage: source.releaseMessage || null,
      pullRequestMessage: source.pullRequestMessage || null,
      issueMessage: source.issueMessage || null,
    };
  }

  async function reload() {
    const updated = await fetchSocialFollows();
    if (updated) follows = withMentionKey(updated.github);
  }

  async function handleAdd() {
    if (!form.repo.trim()) {
      actionState.setError(m.social_gh_err_repo_req());
      return;
    }
    await actionState.run(async () => {
      const res = await saveGithubFollow(toPayload({ ...form, mentionKey: form.mention }, form.repo.trim()));
      if (!res) throw new Error("Ça n'a pas marché. Réessaie.");
      form = emptyForm();
      await reload();
      return true;
    }, { successMessage: m.social_gh_toast_added() });
  }

  async function handleUpdate(follow: any) {
    await actionState.run(async () => {
      const res = await saveGithubFollow(toPayload(follow, follow.repo));
      if (!res) throw new Error("Ça n'a pas marché. Réessaie.");
      return true;
    }, { successMessage: m.social_gh_toast_updated() });
  }

  async function handleDelete(id: string) {
    if (!(await confirmDialog.danger(m.social_gh_confirm_delete_title(), '', m.social_gh_confirm_delete_btn()))) return;
    await actionState.run(async () => {
      const ok = await deleteGithubFollow(id);
      if (!ok) throw new Error("Ça n'a pas marché. Réessaie.");
      follows = follows.filter((f) => f.id !== id);
      return true;
    }, { successMessage: m.social_gh_toast_deleted() });
  }

  const inputClass = 'w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-on-surface/20 transition-all text-on-surface';
  const smallInputClass = 'w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-on-surface/20 transition-all text-on-surface';
</script>

{#snippet githubIcon(cls: string)}
  <svg class={cls} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.2.5-2.3 1.3-3.1-.2-.4-.6-1.6 0-3.2 0 0 1-.3 3.4 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.8.1 3.2.8.8 1.3 1.9 1.3 3.2 0 4.6-2.8 5.6-5.5 5.9.5.4.9 1.1.9 2.2v3.3c0 .3.1.7.8.6A12 12 0 0 0 12 .3"/>
  </svg>
{/snippet}

<div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
  <!-- ADD FORM COLUMN -->
  <div class="lg:col-span-1">
    <div class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6 sticky top-8 shadow-sm">
      <h3 class="text-lg font-semibold flex items-center gap-2.5">
        {@render githubIcon('w-5 h-5 fill-current')}
        {m.social_gh_form_title()}
      </h3>

      <div class="space-y-4">
        <div class="space-y-1.5">
          <label for="gh-repo" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.social_gh_repo_label()}</label>
          <input id="gh-repo" type="text" placeholder={m.social_gh_repo_ph()} bind:value={form.repo} class={inputClass} />
        </div>

        <div class="space-y-1.5">
          <label for="gh-branch" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.social_gh_branch_label()}</label>
          <input id="gh-branch" type="text" placeholder={m.social_gh_branch_ph()} bind:value={form.branch} class={inputClass} />
        </div>

        <div class="space-y-1.5">
          <label for="gh-chan" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.social_channel_alerts_label()}</label>
          <SearchableSelect id="gh-chan" bind:value={form.discordChannelId} options={channelOptions} placeholder={m.social_default_channel_ph()} className={inputClass} />
        </div>

        <div class="space-y-1.5">
          <label for="gh-mention" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.social_mention_label()}</label>
          <SearchableSelect id="gh-mention" bind:value={form.mention} options={mentionOptions} placeholder={m.social_mention_ph()} className={smallInputClass} />
        </div>

        <div class="pt-4 border-t border-outline-variant/10 space-y-3">
          <p class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.social_gh_types_label()}</p>
          {#each NOTIFY_TYPES as type (type.key)}
            <div class="flex items-center justify-between gap-3 px-2">
              <span class="text-sm">{type.label()}</span>
              <ToggleSwitch checked={form[type.key]} onToggle={(v: boolean) => (form[type.key] = v)} disabled={!canManage} />
            </div>
          {/each}
        </div>

        <button
          onclick={handleAdd}
          disabled={!canManage}
          class="w-full mt-4 py-3.5 bg-on-surface text-surface hover:opacity-90 font-medium text-body-sm rounded-lg shadow-sm active:scale-[0.98] transition-all disabled:opacity-50"
        >
          {m.social_gh_add_btn()}
        </button>
        <p class="text-2xs text-on-surface-variant/50 ml-2">{m.social_gh_baseline_hint()}</p>
      </div>
    </div>
  </div>

  <!-- LIST COLUMN -->
  <div class="lg:col-span-2 space-y-6">
    <div class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6 min-h-100">
      <div class="flex items-center justify-between border-b border-outline-variant/20 pb-4">
        <h3 class="text-xl font-semibold flex items-center gap-2">
          {@render githubIcon('w-5 h-5 fill-current')}
          {m.social_gh_list_title({ n: follows.length })}
        </h3>
      </div>

      {#if follows.length === 0}
        <div class="flex flex-col items-center justify-center py-20 text-center text-on-surface-variant/50">
          <Papicon icon="Info" size={48} class="mb-4 text-on-surface-variant/30" />
          <p class="font-bold">{m.social_gh_empty_title()}</p>
          <p class="text-xs">{m.social_empty_hint()}</p>
        </div>
      {:else}
        <div class="space-y-6">
          {#each follows as follow (follow.id)}
            <div class="p-6 rounded-xl bg-surface-container-high/15 border border-outline-variant/5 hover:border-outline-variant/10 transition-all space-y-6">
              <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div class="space-y-1 min-w-0">
                  <h4 class="font-bold text-base flex items-center gap-2 min-w-0">
                    {@render githubIcon('w-4 h-4 fill-current shrink-0')}
                    <a href={`https://github.com/${follow.repo}`} target="_blank" rel="noopener noreferrer" class="hover:underline truncate">{follow.repo}</a>
                  </h4>
                  <p class="text-xs text-on-surface-variant/40 font-mono">{follow.branch || m.social_gh_default_branch()}</p>
                </div>

                <div class="flex items-center gap-2 self-end md:self-center">
                  <button onclick={() => handleUpdate(follow)} disabled={!canManage} title={m.social_save_config_tooltip()} class="p-3 bg-primary/10 hover:bg-primary/20 text-primary rounded-xl transition-all">
                    <Papicon icon="Paper" size={16} />
                  </button>
                  <button onclick={() => handleDelete(follow.id)} disabled={!canManage} title={m.social_unfollow_tooltip()} class="p-3 bg-error/10 hover:bg-error/20 text-error rounded-xl transition-all">
                    <Papicon icon="Trash" size={16} />
                  </button>
                </div>
              </div>

              <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div class="space-y-1">
                  <label for="gh-branch-{follow.id}" class="text-2xs font-bold text-on-surface-variant/50 uppercase">{m.social_gh_branch_label()}</label>
                  <input id="gh-branch-{follow.id}" type="text" bind:value={follow.branch} placeholder={m.social_gh_default_branch()} class={smallInputClass} />
                </div>
                <div class="space-y-1">
                  <span class="text-2xs font-bold text-on-surface-variant/50 uppercase">{m.social_channel_alerts_label()}</span>
                  <SearchableSelect bind:value={follow.discordChannelId} options={channelOptions} placeholder={m.social_default_channel_short_ph()} className={smallInputClass} />
                </div>
                <div class="space-y-1">
                  <label for="gh-mention-{follow.id}" class="text-2xs font-bold text-on-surface-variant/50 uppercase">{m.social_mention_label()}</label>
                  <SearchableSelect id="gh-mention-{follow.id}" bind:value={follow.mentionKey} options={mentionOptions} placeholder={m.social_mention_ph()} className={smallInputClass} />
                </div>
              </div>

              <div class="p-4 rounded-lg bg-surface-container/30 border border-outline-variant/5 space-y-3">
                <p class="text-xs font-semibold text-on-surface-variant/60">{m.social_messages_by_type()}</p>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {#each NOTIFY_TYPES as type (type.key)}
                    <div class="space-y-1.5">
                      <div class="flex items-center justify-between gap-2">
                        <label for="gh-{type.message}-{follow.id}" class="text-2xs font-bold text-on-surface-variant/50">{type.label()}</label>
                        <ToggleSwitch checked={follow[type.key]} onToggle={(v: boolean) => (follow[type.key] = v)} disabled={!canManage} />
                      </div>
                      <input
                        id="gh-{type.message}-{follow.id}"
                        type="text"
                        bind:value={follow[type.message]}
                        disabled={!follow[type.key]}
                        placeholder={m.social_default_msg_ph()}
                        class="{smallInputClass} disabled:opacity-40"
                      />
                    </div>
                  {/each}
                </div>
                <p class="text-2xs text-on-surface-variant/40">{m.social_gh_vars_hint()}</p>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>
