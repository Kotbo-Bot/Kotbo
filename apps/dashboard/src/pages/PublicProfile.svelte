<script lang="ts">
  import { onMount } from 'svelte';
  import { memberAvatarSrc } from '../lib/discordMedia';
  import { API_BASE_URL } from '../lib/api';
  import { authStore } from '../lib/stores/auth.svelte';
  import { router } from 'tinro';
  import Papicon from '../lib/components/Papicon.svelte';
  import { Button, ListGroup, ListRow } from '../lib/components/ui';
  import BoosterBadge from '../lib/components/BoosterBadge.svelte';
  import { boostMonths } from '@kotbo/contracts';
  import { formatRelative, formatTenure } from '../lib/components/staff/format';
  import { m, dateLocale } from '../lib/i18n';

  import { errorMessage } from '@kotbo/shared';
  interface Props {
    userId: string;
  }
  const { userId }: Props = $props();

  let profile: any = $state(null);
  let loading = $state(true);
  let error = $state('');

  onMount(async () => {
    try {
      // Fetch public profile snapshot
      const res = await fetch(`${API_BASE_URL}/api/public/profile/${userId}`);
      if (!res.ok) {
        if (res.status === 404) throw new Error(m.ppf_err_not_found());
        throw new Error(m.ppf_err_fetch());
      }
      profile = await res.json();
    } catch (err) {
      error = errorMessage(err) || m.ppf_err_load();
    } finally {
      loading = false;
    }
  });

  function formatDate(date: string | Date | null | undefined) {
    if (!date) return '-';
    return new Date(date).toLocaleDateString(dateLocale(), {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    });
  }

  const isOwn = $derived(authStore.isAuthenticated && authStore.user?.id === userId);
  const name = $derived(profile?.displayName || profile?.username || '');
  const voiceMinutes = $derived(Math.round((profile?.voiceTimeSeconds || 0) / 60));

  const stats = $derived(profile ? [
    { label: m.ppf_messages(), value: profile.messageCount?.toLocaleString(dateLocale()) || '0' },
    { label: m.ppf_voice(), value: m.ppf_minutes({ count: voiceMinutes }) },
    { label: m.ppf_events(), value: String(profile.eventParticipations?.length || 0) },
    { label: m.ppf_tenure(), value: profile.guildJoinedAt ? formatTenure(profile.guildJoinedAt) : m.ppf_unknown() },
  ] : []);
</script>

{#snippet value(text: string)}
  <span class="text-sm font-semibold text-on-surface text-right">{text}</span>
{/snippet}

<div class="min-h-screen bg-background text-on-surface">
  <div class="mx-auto w-full max-w-2xl px-4 sm:px-6 py-8 space-y-6">
    <div>
      <Button variant="ghost" size="sm" icon="arrow-left" onclick={() => router.goto('/')}>{m.ppf_back()}</Button>
    </div>

    {#if loading}
      <div class="space-y-6 animate-pulse" aria-busy="true">
        <div class="h-56 rounded-3xl bg-surface-container"></div>
        <div class="h-24 rounded-2xl bg-surface-container"></div>
        <div class="h-64 rounded-2xl bg-surface-container"></div>
      </div>
    {:else if error}
      <div class="section-card p-8 flex flex-col items-center gap-3 text-center">
        <span class="icon-disc" aria-hidden="true"><Papicon icon="AlertTriangle" size={16} /></span>
        <h1 class="text-lg font-semibold text-on-surface font-headline">{m.ppf_not_found()}</h1>
        <p class="max-w-md text-sm text-on-surface-variant">{m.ppf_error_desc({ error })}</p>
        <Button variant="primary" icon="Home" onclick={() => router.goto('/')}>{m.ppf_home()}</Button>
      </div>
    {:else if profile}
      <header class="section-card-flush">
        <div class="h-32 sm:h-40 bg-surface-container">
          {#if profile.banner}
            <img src={profile.banner} alt={m.ppf_banner_alt()} class="h-full w-full object-cover" />
          {:else}
            <div class="h-full w-full bg-linear-to-br from-primary/25 to-primary/5"></div>
          {/if}
        </div>
        <div class="relative -mt-12 flex flex-col items-center gap-2 px-5 pb-5 text-center">
          <img
            src={memberAvatarSrc(profile.avatar, name, profile.userId)}
            alt=""
            width="96"
            height="96"
            class="h-24 w-24 rounded-full object-cover bg-surface-container ring-4 ring-surface-container-lowest shadow-md"
          />
          <div class="min-w-0 max-w-full">
            <h1 class="text-2xl font-bold tracking-tight text-on-surface font-headline leading-tight break-words">{name}</h1>
            <div class="mt-1 flex flex-wrap items-center justify-center gap-2">
              <span class="text-sm text-on-surface-variant">@{profile.username}</span>
              {#if profile.boostingSince}
                <BoosterBadge since={profile.boostingSince} size={16} />
              {/if}
              {#if profile.isPrivate}
                <span class="inline-flex items-center gap-1.5 rounded-full bg-warning/10 px-2.5 py-0.5 text-xs font-semibold text-on-warning-container">
                  <Papicon icon="Lock" size={10} /> {m.ppf_private()}
                </span>
              {/if}
            </div>
          </div>
          {#if isOwn}
            <div class="mt-1 flex flex-wrap justify-center gap-2">
              <Button href="/me" size="sm" variant="primary" icon="edit">{m.me_edit_profile()}</Button>
              <Button size="sm" variant="secondary" icon="ShieldUser" onclick={() => router.goto('/profile')}>{m.ppf_staff_space()}</Button>
            </div>
          {/if}
        </div>
      </header>

      {#if profile.isPrivate}
        <div class="section-card p-8 flex flex-col items-center gap-2 text-center">
          <span class="icon-disc" aria-hidden="true"><Papicon icon="Lock" size={16} /></span>
          <h2 class="text-base font-semibold text-on-surface">{m.ppf_private_title()}</h2>
          <p class="max-w-md text-sm text-on-surface-variant">{m.ppf_private_desc()}</p>
        </div>
      {:else}
        <dl class="section-card grid grid-cols-2 sm:grid-cols-4 gap-y-4 p-4 text-center">
          {#each stats as stat (stat.label)}
            <div class="flex flex-col-reverse px-1">
              <dt class="text-xs text-on-surface-variant">{stat.label}</dt>
              <dd class="text-lg font-bold tabular-nums text-on-surface font-headline">{stat.value}</dd>
            </div>
          {/each}
        </dl>

        <ListGroup title={m.ppf_bio()}>
          <p class="p-4 text-sm leading-relaxed text-on-surface whitespace-pre-line break-words">
            {profile.bio?.trim() || m.ppf_no_bio()}
          </p>
        </ListGroup>

        <ListGroup title={m.ppf_file()}>
          {#if profile.boost?.boostingSince}
            <ListRow icon="Zap" label={m.ppf_boost_title()}>
              {@render value(`${formatDate(profile.boost.boostingSince)} · ${m.ppf_boost_value({ months: String(boostMonths(new Date(profile.boost.boostingSince))) })}`)}
            </ListRow>
          {/if}
          {#if profile.boost?.totalDays}
            <ListRow icon="Zap" label={m.mcm_boost_total()}>
              {@render value(m.boost_days({ count: String(profile.boost.totalDays) }))}
            </ListRow>
          {/if}
          <ListRow icon="User" label={m.ppf_account_created()}>{@render value(formatDate(profile.accountCreatedAt))}</ListRow>
          <ListRow icon="Calendar" label={m.ppf_joined()}>{@render value(formatDate(profile.guildJoinedAt))}</ListRow>
          <ListRow icon="clock" label={m.ppf_last_message()}>
            {@render value(profile.lastSeenAt ? formatRelative(profile.lastSeenAt) : m.ppf_never())}
          </ListRow>
        </ListGroup>

        <ListGroup title={m.ppf_badges()}>
          <div class="p-4">
            {#if profile.roles && profile.roles.length > 0}
              <div class="flex flex-wrap gap-1.5">
                {#each profile.roles as role}
                  <span class="rounded-full bg-surface-container px-3 py-1 text-xs font-semibold text-on-surface">{role.name}</span>
                {/each}
              </div>
            {:else}
              <p class="text-sm text-on-surface-variant">{m.ppf_no_badges()}</p>
            {/if}
          </div>
        </ListGroup>

        <ListGroup title={m.ppf_events_history()}>
          {#each profile.eventParticipations ?? [] as event}
            <ListRow icon="Zap" label={event.title} description={`${event.type} · ${formatDate(event.date)}`}>
              {@render value(m.ppf_points({ count: event.score }))}
            </ListRow>
          {:else}
            <p class="p-4 text-sm text-on-surface-variant">{m.ppf_no_events()}</p>
          {/each}
        </ListGroup>

        {#if !authStore.isAuthenticated}
          <ListGroup title={m.ppf_staff_cta()}>
            <ListRow
              icon="log-in"
              label={m.ppf_login()}
              description={m.ppf_staff_cta_desc()}
              onclick={() => (window.location.href = `${API_BASE_URL}/api/auth/discord/login?returnTo=${encodeURIComponent(window.location.pathname)}`)}
            />
          </ListGroup>
        {/if}
      {/if}

      <p class="text-center text-xs text-on-surface-variant">{m.ppf_footer()}</p>
    {/if}
  </div>
</div>
