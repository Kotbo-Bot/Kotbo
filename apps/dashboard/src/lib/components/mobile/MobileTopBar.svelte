<script lang="ts">
  import { router } from 'tinro';
  import { buildCrumbs } from '../../breadcrumbs';
  import { m } from '../../i18n';
  import { resolveGuildIconSrc, resolveUserAvatarSrc } from '../../discordMedia';
  import { authStore } from '../../stores/auth.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { mobileNav } from '../../stores/mobileNav.svelte';
  import { serverSwitcherStore } from '../../stores/serverSwitcher.svelte';
  import { unsavedChanges } from '../../stores/unsavedChanges.svelte';
  import NotificationBell from '../NotificationBell.svelte';
  import Papicon from '../Papicon.svelte';

  const crumbs = $derived(buildCrumbs($router.path));

  /** Anything deeper than "Home > Page" gets a back target instead of the logo. */
  const parent = $derived(crumbs.length > 2 ? crumbs[crumbs.length - 2] : null);
  const title = $derived(crumbs.at(-1)?.name ?? m.nav_home());

  const guild = $derived(authStore.guilds.find((g) => g.id === authStore.selectedGuildId));
  const guildIcon = $derived(guild ? resolveGuildIconSrc(guild.id, guild.icon) : null);
  const canSwitchServer = $derived(authStore.guilds.length > 1);
  const userAvatar = $derived(resolveUserAvatarSrc(authStore.user?.id, authStore.user?.avatar));

  /**
   * On the home page the tab bar already says where we are, so the whole left
   * half becomes the server switcher: name on top, what tapping does below.
   * A bare logo was the one control nobody found.
   */
  const showServerBanner = $derived($router.path === '/');
  const accountOpen = $derived(mobileNav.sheet === 'account');

  /**
   * The bar hides on the way down and returns on the way up, so a long members
   * table gets the full screen without stranding the user without navigation.
   */
  let hidden = $state(false);

  $effect(() => {
    let lastY = window.scrollY;
    let ticking = false;

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const y = window.scrollY;
        const delta = y - lastY;
        // Ignore rubber-banding and jitter below the fold threshold.
        if (Math.abs(delta) > 6 && y > 72) hidden = delta > 0;
        if (y <= 72) hidden = false;
        lastY = y;
        ticking = false;
      });
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  });

  // Never leave the bar hidden across a route change.
  $effect(() => {
    void $router.path;
    hidden = false;
  });

  async function goBack(event: MouseEvent) {
    if (!parent) return;
    event.preventDefault();

    if (unsavedChanges.isDirty) {
      const confirmed = await confirmDialog.ask({
        title: m.banner_unsaved_title(),
        description: m.banner_unsaved_desc({ page: unsavedChanges.pageLabel }),
        confirmLabel: m.banner_unsaved_leave(),
        variant: 'warning',
      });
      if (!confirmed) return;
      unsavedChanges.clear();
    }

    router.goto(parent.href);
  }
</script>

<header class="topbar" class:topbar--hidden={hidden}>
  {#if showServerBanner}
    <!-- Home: the server is the subject of the screen, so it gets the space.
         Naming the action outright is the point: a bare logo was the one
         control nobody found. -->
    <button
      type="button"
      class="topbar__server"
      onclick={() => serverSwitcherStore.show()}
      disabled={!canSwitchServer}
    >
      {#if guildIcon}
        <img class="topbar__server-avatar" src={guildIcon} alt="" referrerpolicy="no-referrer" />
      {:else}
        <span class="topbar__server-avatar topbar__server-fallback">
          {guild?.name?.charAt(0) ?? '?'}
        </span>
      {/if}
      <span class="topbar__server-text">
        <span class="topbar__server-name">{guild?.name ?? m.nav_home()}</span>
        {#if canSwitchServer}
          <span class="topbar__server-hint">{m.nav_switch_server()}</span>
        {/if}
      </span>
      {#if canSwitchServer}
        <Papicon icon="chevron-down" size={16} class="topbar__server-caret" />
      {/if}
    </button>
  {:else}
    {#if parent}
      <a
        class="topbar__lead"
        href={parent.href}
        onclick={goBack}
        aria-label={m.nav_back_to({ page: parent.name })}
      >
        <Papicon icon="arrow-left" size={20} />
      </a>
    {:else}
      <button
        type="button"
        class="topbar__chip"
        onclick={() => serverSwitcherStore.show()}
        disabled={!canSwitchServer}
        aria-label={canSwitchServer ? m.nav_switch_server() : (guild?.name ?? '')}
      >
        {#if guildIcon}
          <img class="topbar__chip-avatar" src={guildIcon} alt="" referrerpolicy="no-referrer" />
        {:else}
          <span class="topbar__chip-avatar topbar__server-fallback">
            {guild?.name?.charAt(0) ?? '?'}
          </span>
        {/if}
        {#if canSwitchServer}
          <Papicon icon="chevron-down" size={13} class="topbar__chip-caret" />
        {/if}
      </button>
    {/if}

    <div class="topbar__heading">
      <h1 class="topbar__title">{title}</h1>
      {#if guild?.name}
        <p class="topbar__context">{guild.name}</p>
      {/if}
    </div>
  {/if}

  <div class="topbar__trailing">
    <NotificationBell />

    <button
      type="button"
      class="topbar__avatar"
      class:topbar__avatar--active={accountOpen}
      aria-haspopup="dialog"
      aria-expanded={accountOpen}
      aria-label={m.nav_account_open()}
      onclick={() => mobileNav.toggle('account')}
    >
      <img src={userAvatar} alt="" referrerpolicy="no-referrer" width="30" height="30" />
    </button>
  </div>
</header>

<div class="topbar-spacer" aria-hidden="true"></div>

<style>
  .topbar {
    position: fixed;
    z-index: 40;
    top: 0;
    right: 0;
    left: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: env(safe-area-inset-top) max(0.5rem, env(safe-area-inset-right)) 0
      max(0.5rem, env(safe-area-inset-left));
    border-bottom: 1px solid var(--outline-variant);
    background: color-mix(in srgb, var(--surface-container-lowest) 86%, transparent);
    transition: transform 220ms ease;
    -webkit-backdrop-filter: blur(20px) saturate(1.6);
    backdrop-filter: blur(20px) saturate(1.6);
  }

  .topbar--hidden {
    transform: translateY(-100%);
  }

  /* ── Home: the server switcher takes the whole left half ── */

  .topbar__server {
    display: flex;
    min-width: 0;
    height: 2.75rem;
    flex: 1 1 auto;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.5rem 0 0.25rem;
    border-radius: 999px;
    text-align: left;
    -webkit-tap-highlight-color: transparent;
  }

  .topbar__server:active:not(:disabled) {
    background: var(--surface-container);
  }

  .topbar__server:disabled {
    cursor: default;
  }

  .topbar__server-text {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }

  .topbar__server-name {
    overflow: hidden;
    color: var(--on-surface);
    font-family: var(--font-headline);
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .topbar__server-hint {
    color: var(--primary-color);
    font-size: 0.6875rem;
    font-weight: 600;
    line-height: 1.3;
  }

  .topbar__server :global(.topbar__server-caret) {
    flex: none;
    color: var(--primary-color);
  }

  /* ── Every other page: back arrow or a compact server chip ── */

  .topbar__lead {
    display: grid;
    width: 2.75rem;
    height: 2.75rem;
    flex: none;
    place-items: center;
    border-radius: 999px;
    color: var(--on-surface);
    -webkit-tap-highlight-color: transparent;
  }

  .topbar__lead:active {
    background: var(--surface-container);
  }

  .topbar__chip {
    display: flex;
    height: 2.75rem;
    flex: none;
    align-items: center;
    gap: 0.125rem;
    padding: 0 0.25rem 0 0.125rem;
    border-radius: 999px;
    -webkit-tap-highlight-color: transparent;
  }

  .topbar__chip:active {
    background: var(--surface-container);
  }

  .topbar__chip:disabled {
    cursor: default;
  }

  .topbar__chip :global(.topbar__chip-caret) {
    flex: none;
    color: var(--on-surface-variant);
  }

  .topbar__server-avatar,
  .topbar__chip-avatar {
    display: grid;
    flex: none;
    place-items: center;
    object-fit: cover;
  }

  .topbar__server-avatar {
    width: 2rem;
    height: 2rem;
    border-radius: 0.625rem;
  }

  .topbar__chip-avatar {
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 0.5rem;
  }

  .topbar__server-fallback {
    background: color-mix(in srgb, var(--primary-color) 14%, transparent);
    color: var(--primary-color);
    font-size: 0.8125rem;
    font-weight: 800;
  }

  .topbar__heading {
    min-width: 0;
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }

  .topbar__title {
    overflow: hidden;
    color: var(--on-surface);
    font-family: var(--font-headline);
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .topbar__context {
    overflow: hidden;
    color: var(--on-surface-variant);
    font-size: 0.6875rem;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ── Trailing: notifications and account ── */

  .topbar__trailing {
    display: flex;
    height: 3.25rem;
    flex: none;
    align-items: center;
    gap: 0.125rem;
  }

  /* The desktop bell is a small bordered square; on a phone it needs to be a
     plain 44px target so it matches the avatar beside it. */
  .topbar__trailing :global(.notification-trigger) {
    width: 2.75rem;
    height: 2.75rem;
    border: 0;
    border-radius: 999px;
    background: transparent;
  }

  .topbar__avatar {
    display: grid;
    width: 2.75rem;
    height: 2.75rem;
    flex: none;
    place-items: center;
    border-radius: 999px;
    -webkit-tap-highlight-color: transparent;
  }

  .topbar__avatar img {
    width: 1.875rem;
    height: 1.875rem;
    border-radius: 999px;
    object-fit: cover;
    transition: box-shadow 150ms ease;
  }

  .topbar__avatar--active img,
  .topbar__avatar:active img {
    box-shadow: 0 0 0 2px var(--primary-color);
  }

  .topbar-spacer {
    height: calc(3.25rem + env(safe-area-inset-top));
  }

  @media (prefers-reduced-motion: reduce) {
    .topbar,
    .topbar__avatar img {
      transition: none;
    }
  }
</style>
