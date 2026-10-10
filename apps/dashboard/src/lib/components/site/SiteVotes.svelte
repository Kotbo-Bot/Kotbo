<script lang="ts">
  /**
   * Votes pour le serveur : sites de classement où voter, réglages de
   * vérification (jeton, identifiant, webhook top.gg) et meilleurs votants.
   */
  import { onMount } from 'svelte';
  import { SITE_VOTE_PROVIDER_KEYS, SITE_VOTE_PROVIDERS, type SiteVoteProvider } from '@kotbo/shared';
  import { Button, EmptyState, Field, Modal, SectionCard, ToggleSwitch } from '../ui';
  import { toast } from '../../stores/toast.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { m } from '../../i18n';
  import {
    createSiteVoteSite,
    deleteSiteVoteSite,
    fetchSiteVotes,
    regenerateSiteVoteSecret,
    reorderSiteVoteSites,
    updateSiteVoteSite,
    type SiteVoteSiteAdmin,
  } from '../../api/site';
  import { siteErrorMessage } from './siteErrors';

  let { guildId }: { guildId: string } = $props();

  let voteSites = $state<SiteVoteSiteAdmin[]>([]);
  let topVoters = $state<Array<{ userId: string; votes: number; name: string; avatarUrl: string | null }>>([]);
  let loading = $state(true);

  let editorOpen = $state(false);
  let editing = $state<SiteVoteSiteAdmin | null>(null);
  let provider = $state<SiteVoteProvider>('topgg');
  let label = $state('');
  let voteUrl = $state('');
  let verificationKey = $state('');
  let cooldownHours = $state(12);
  let saving = $state(false);

  const spec = $derived(SITE_VOTE_PROVIDERS[provider]);
  const VERIFY_HINTS: Record<string, () => string> = {
    webhook: () => m.ste_votes_verify_webhook(),
    user: () => m.ste_votes_verify_user(),
    ip: () => m.ste_votes_verify_ip(),
  };

  async function load() {
    try {
      const data = await fetchSiteVotes(guildId);
      voteSites = data.voteSites;
      topVoters = data.topVoters;
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      loading = false;
    }
  }

  onMount(load);

  function openCreate() {
    editing = null;
    provider = 'topgg';
    label = '';
    voteUrl = '';
    verificationKey = '';
    cooldownHours = SITE_VOTE_PROVIDERS.topgg.cooldownHours;
    editorOpen = true;
  }

  function openEdit(site: SiteVoteSiteAdmin) {
    editing = site;
    provider = site.provider as SiteVoteProvider;
    label = site.label;
    voteUrl = site.voteUrl;
    verificationKey = '';
    cooldownHours = site.cooldownHours;
    editorOpen = true;
  }

  function pickProvider(next: SiteVoteProvider) {
    provider = next;
    cooldownHours = SITE_VOTE_PROVIDERS[next].cooldownHours;
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    saving = true;
    try {
      const input = {
        label: label.trim() || undefined,
        voteUrl: voteUrl.trim(),
        cooldownHours,
        ...(verificationKey.trim() ? { verificationKey: verificationKey.trim() } : {}),
      };
      if (editing) await updateSiteVoteSite(editing.id, input, guildId);
      else await createSiteVoteSite({ ...input, provider }, guildId);
      toast.success(m.ste_votes_saved());
      editorOpen = false;
      await load();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      saving = false;
    }
  }

  async function toggle(site: SiteVoteSiteAdmin, enabled: boolean) {
    try {
      await updateSiteVoteSite(site.id, { enabled }, guildId);
      site.enabled = enabled;
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  async function remove(site: SiteVoteSiteAdmin) {
    const ok = await confirmDialog.ask({ title: m.ste_votes_delete_title(), description: m.ste_votes_delete_confirm({ label: site.label }), confirmLabel: m.common_delete(), variant: 'danger' });
    if (!ok) return;
    try {
      await deleteSiteVoteSite(site.id, guildId);
      await load();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  async function move(index: number, delta: number) {
    const list = [...voteSites];
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    voteSites = list;
    try {
      await reorderSiteVoteSites(list.map((s) => s.id), guildId);
    } catch (err) {
      toast.error(siteErrorMessage(err));
      await load();
    }
  }

  async function regenerate(site: SiteVoteSiteAdmin) {
    const ok = await confirmDialog.ask({ title: m.ste_votes_regenerate_title(), description: m.ste_votes_regenerate_confirm(), confirmLabel: m.ste_votes_regenerate() });
    if (!ok) return;
    try {
      await regenerateSiteVoteSecret(site.id, guildId);
      await load();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  async function copy(value: string) {
    await navigator.clipboard?.writeText(value);
    toast.success(m.ste_link_copied());
  }
</script>

<div class="space-y-4">
  <SectionCard title={m.ste_votes_title()} description={m.ste_votes_desc()} icon="trending-up" flush>
    {#snippet actions()}
      <Button size="sm" icon="plus" onclick={openCreate}>{m.ste_votes_add()}</Button>
    {/snippet}
    {#if !loading && voteSites.length === 0}
      <div class="p-6"><EmptyState icon="trending-up" title={m.ste_votes_empty()} description={m.ste_votes_empty_desc()} /></div>
    {:else}
      <ul class="vote-list">
        {#each voteSites as site, index (site.id)}
          <li>
            <div class="vote-main">
              <p class="vote-name">{site.label}</p>
              <p class="vote-meta">
                {SITE_VOTE_PROVIDERS[site.provider as SiteVoteProvider]?.host ?? site.provider} · {m.ste_votes_cooldown({ hours: site.cooldownHours })} · {m.ste_votes_count_30d({ count: site.votes30d })}
              </p>
              {#if site.webhookUrl && site.webhookSecret}
                <div class="vote-webhook">
                  <p class="vote-meta">{m.ste_votes_webhook_hint()}</p>
                  <div class="webhook-row">
                    <code>{site.webhookUrl}</code>
                    <Button size="sm" variant="ghost" icon="copy" aria-label={m.ste_copy_link()} onclick={() => copy(site.webhookUrl!)} />
                  </div>
                  <div class="webhook-row">
                    <code class="secret">{site.webhookSecret}</code>
                    <Button size="sm" variant="ghost" icon="copy" aria-label={m.ste_votes_copy_secret()} onclick={() => copy(site.webhookSecret!)} />
                    <Button size="sm" variant="ghost" onclick={() => regenerate(site)}>{m.ste_votes_regenerate()}</Button>
                  </div>
                </div>
              {:else if !site.hasKey}
                <p class="vote-warning">{m.ste_votes_key_missing()}</p>
              {/if}
            </div>
            <div class="vote-actions">
              <ToggleSwitch size="sm" checked={site.enabled} ariaLabel={m.ste_votes_enabled()} onToggle={(v) => toggle(site, v)} />
              <Button size="sm" variant="ghost" icon="arrow-up" aria-label={m.ste_move_up()} onclick={() => move(index, -1)} />
              <Button size="sm" variant="ghost" icon="arrow-down" aria-label={m.ste_move_down()} onclick={() => move(index, 1)} />
              <Button size="sm" variant="ghost" icon="edit-2" aria-label={m.ste_votes_edit()} onclick={() => openEdit(site)} />
              <Button size="sm" variant="ghost" icon="trash-2" aria-label={m.common_delete()} onclick={() => remove(site)} />
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </SectionCard>

  <SectionCard title={m.ste_votes_top()} icon="award">
    <div class="px-5 pb-5">
      {#if topVoters.length === 0}
        <p class="text-body-sm text-on-surface-variant">{m.ste_votes_top_empty()}</p>
      {:else}
        <ol class="voter-list">
          {#each topVoters as voter, index (voter.userId)}
            <li>
              <span class="voter-rank">{index + 1}</span>
              {#if voter.avatarUrl}<img src={voter.avatarUrl} alt="" />{:else}<span class="voter-fallback">{voter.name.slice(0, 1).toUpperCase()}</span>{/if}
              <span class="voter-name">{voter.name}</span>
              <span class="voter-count">{m.ste_votes_count({ count: voter.votes })}</span>
            </li>
          {/each}
        </ol>
      {/if}
    </div>
  </SectionCard>
</div>

<Modal bind:open={editorOpen} title={editing ? m.ste_votes_edit() : m.ste_votes_add()} size="md">
  <form id="site-vote-form" class="space-y-4" onsubmit={save}>
    {#if !editing}
      <Field label={m.ste_votes_provider()} hint={VERIFY_HINTS[spec.verification]()}>
        {#snippet children(id, describedBy)}
          <select {id} aria-describedby={describedBy} class="input w-full" value={provider} onchange={(e) => pickProvider((e.currentTarget as HTMLSelectElement).value as SiteVoteProvider)}>
            {#each SITE_VOTE_PROVIDER_KEYS as key (key)}<option value={key}>{SITE_VOTE_PROVIDERS[key].label} ({SITE_VOTE_PROVIDERS[key].host})</option>{/each}
          </select>
        {/snippet}
      </Field>
    {/if}
    <Field label={m.ste_votes_url()} hint={m.ste_votes_url_hint({ host: spec.host })} required>
      {#snippet children(id, describedBy)}
        <input {id} aria-describedby={describedBy} class="input w-full" type="url" required placeholder={`https://${spec.host}/…`} bind:value={voteUrl} />
      {/snippet}
    </Field>
    {#if spec.keyLabel}
      <Field label={m.ste_votes_key({ name: spec.keyLabel })} hint={editing?.hasKey ? m.ste_votes_key_keep() : m.ste_votes_key_hint()}>
        {#snippet children(id, describedBy)}
          <input {id} aria-describedby={describedBy} class="input w-full font-mono" autocomplete="off" bind:value={verificationKey} />
        {/snippet}
      </Field>
    {/if}
    <div class="grid grid-cols-2 gap-3">
      <Field label={m.ste_votes_label()}>
        {#snippet children(id)}
          <input {id} class="input w-full" maxlength="60" placeholder={spec.label} bind:value={label} />
        {/snippet}
      </Field>
      <Field label={m.ste_votes_cooldown_label()}>
        {#snippet children(id)}
          <input {id} class="input w-full" type="number" min="1" max="168" bind:value={cooldownHours} />
        {/snippet}
      </Field>
    </div>
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (editorOpen = false)}>{m.common_cancel()}</Button>
    <Button variant="primary" type="submit" form="site-vote-form" loading={saving}>{m.common_save()}</Button>
  {/snippet}
</Modal>

<style>
  .vote-list { list-style: none; margin: 0; padding: 0; }
  .vote-list li { display: flex; gap: 12px; align-items: flex-start; padding: 12px 16px; border-top: 1px solid var(--color-outline-variant); }
  .vote-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .vote-name { margin: 0; font-weight: 600; color: var(--color-on-surface); }
  .vote-meta { margin: 0; font-size: 0.82rem; color: var(--color-on-surface-variant); }
  .vote-warning { margin: 0; font-size: 0.82rem; color: var(--color-warning); }
  .vote-webhook { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
  .webhook-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .webhook-row code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.8rem; padding: 4px 8px; border-radius: 6px; background: var(--color-surface-container); }
  .webhook-row code.secret { filter: blur(4px); transition: filter 0.15s; }
  .webhook-row code.secret:hover, .webhook-row code.secret:focus { filter: none; }
  .vote-actions { display: flex; align-items: center; gap: 2px; flex: none; }
  .voter-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .voter-list li { display: flex; align-items: center; gap: 10px; font-size: 0.9rem; color: var(--color-on-surface); }
  .voter-list img, .voter-fallback { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; flex: none; }
  .voter-fallback { display: grid; place-items: center; background: var(--color-surface-container); font-weight: 700; font-size: 0.75rem; }
  .voter-rank { width: 20px; text-align: right; color: var(--color-on-surface-variant); font-variant-numeric: tabular-nums; }
  .voter-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .voter-count { color: var(--color-on-surface-variant); font-variant-numeric: tabular-nums; }
</style>
