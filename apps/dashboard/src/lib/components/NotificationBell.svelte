<script lang="ts">
  import { onMount } from "svelte";
  import {
    notificationsStore,
    type Notification,
  } from "../stores/notifications.svelte";
  import { authStore } from "../stores/auth.svelte";
  import { subscribeRealtime } from "../stores/realtime.svelte";
  import { serverSwitcherStore } from "../stores/serverSwitcher.svelte";
  import { searchStore } from "../stores/search.svelte";
  import { slide } from "svelte/transition";
  import { severityMeta } from "../notificationUi";
  import Papicon from "./Papicon.svelte";
  import { m, dateLocale } from "../i18n";

  let open = $state(false);

  /** La boîte est personnelle et couvre tous les serveurs : on montre d'où vient chaque ligne dès qu'il y en a plusieurs. */
  const multiGuild = $derived(authStore.guilds.length > 1);

  function openNotification(notif: Notification) {
    open = false;
    notificationsStore.open(notif);
  }

  $effect(() => {
    if (authStore.token) void notificationsStore.fetchNotifications();
  });

  onMount(() => {
    // Les événements temps réel ne couvrent que le serveur ouvert : le repli
    // périodique ramène ce qui arrive sur les autres.
    const unsubscribe = subscribeRealtime({
      reasons: ["notifications_updated"],
      fallbackMs: 60_000,
      onUpdate: () => void notificationsStore.fetchNotifications(true),
    });

    const handleClick = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".notif-container")) open = false;
    };
    const handleCloseMenus = (e: Event) => {
      const detail = (e as CustomEvent<{ except?: string }>).detail;
      if (detail?.except !== "notif") open = false;
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "n")
      ) {
        open = false;
      }
    };
    window.addEventListener("click", handleClick);
    window.addEventListener("kotbo:close-navbar-menus", handleCloseMenus);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      unsubscribe();
      window.removeEventListener("click", handleClick);
      window.removeEventListener("kotbo:close-navbar-menus", handleCloseMenus);
      window.removeEventListener("keydown", handleKeyDown);
    };
  });

  $effect(() => {
    if (searchStore.open || serverSwitcherStore.open) {
      open = false;
    }
  });

  const toggle = (e: MouseEvent) => {
    e.stopPropagation();
    const next = !open;
    if (next) {
      searchStore.close();
      serverSwitcherStore.close();
      window.dispatchEvent(
        new CustomEvent("kotbo:close-navbar-menus", {
          detail: { except: "notif" },
        }),
      );
    }
    open = next;
  };

  function formatNotifTime(iso: string): string {
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.max(1, Math.floor(diffMs / 60_000));
    const rtf = new Intl.RelativeTimeFormat(dateLocale(), {
      numeric: "auto",
      style: "short",
    });
    if (mins < 60) return rtf.format(-mins, "minute");
    const hours = Math.floor(mins / 60);
    if (hours < 24) return rtf.format(-hours, "hour");
    const days = Math.floor(hours / 24);
    if (days < 7) return rtf.format(-days, "day");
    return new Date(iso).toLocaleDateString(dateLocale(), {
      day: "numeric",
      month: "short",
    });
  }
</script>

<div class="relative notif-container">
  <button
    onclick={toggle}
    class="notification-trigger relative w-9 h-9 rounded-full border border-outline-variant bg-surface-container-low flex items-center justify-center transition-colors hover:bg-surface-container cursor-pointer"
    aria-label={m.notif_header_title()}
    aria-expanded={open}
  >
    <Papicon icon="bell" size={16} class="text-on-surface-variant" />

    {#if notificationsStore.unreadCount > 0}
      <div
        class="absolute -top-1 -right-1 min-w-[17px] h-[17px] px-1 bg-primary rounded-full flex items-center justify-center ring-2 ring-surface-container-lowest"
      >
        <span class="text-2xs font-semibold text-on-primary leading-none">
          {notificationsStore.unreadCount > 99
            ? "99+"
            : notificationsStore.unreadCount}
        </span>
      </div>
    {/if}
  </button>

  {#if open}
    <div
      transition:slide={{ duration: 150, axis: "y" }}
      class="notification-panel tafac-panel section-card absolute right-0 top-11 w-[22rem] max-h-[440px] flex flex-col overflow-hidden z-50 shadow-xl"
    >
      <div
        class="px-4 py-3 border-b border-outline-variant flex items-center justify-between shrink-0"
      >
        <div class="flex items-center gap-2">
          <span class="text-sm font-bold text-on-surface"
            >{m.notif_header_title()}</span
          >
          {#if notificationsStore.unreadCount > 0}
            <span
              class="px-2 py-0.5 rounded-full bg-primary/12 text-2xs font-semibold tabular-nums text-primary"
            >
              {notificationsStore.unreadCount}
            </span>
          {/if}
        </div>
        {#if notificationsStore.unreadCount > 0}
          <button
            onclick={() => notificationsStore.markAllAsRead()}
            class="text-2xs font-medium text-on-surface-variant hover:text-primary transition-colors cursor-pointer"
          >
            {m.notif_mark_all_read()}
          </button>
        {/if}
      </div>

      <div class="flex-1 overflow-y-auto overscroll-contain p-1.5">
        {#if notificationsStore.loading && notificationsStore.items.length === 0}
          <div class="p-6 flex flex-col items-center text-on-surface-variant">
            <Papicon icon="refresh-cw" size={20} class="animate-spin mb-2" />
            <span class="text-xs">{m.notif_loading()}</span>
          </div>
        {:else if notificationsStore.items.length === 0}
          <div class="p-6 flex flex-col items-center text-on-surface-variant">
            <Papicon icon="bell-off" size={24} class="mb-2 opacity-60" />
            <span class="text-xs">{m.notif_empty()}</span>
          </div>
        {:else}
          <div class="flex flex-col gap-0.5">
            {#each notificationsStore.items as notif (notif.id)}
              {@const meta = severityMeta(notif.type)}
              <button
                type="button"
                class="flex items-start gap-2.5 px-2.5 py-2.5 rounded-xl text-left hover:bg-surface-container transition-colors cursor-pointer {notif.isRead
                  ? 'opacity-60'
                  : 'bg-surface-container-low'}"
                onclick={() => openNotification(notif)}
              >
                <div
                  class="shrink-0 w-7 h-7 rounded-full flex items-center justify-center mt-0.5 {meta.bg} {meta.text}"
                >
                  <Papicon icon={meta.icon} size={13} />
                </div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-baseline justify-between gap-2 mb-0.5">
                    <p
                      class="text-xs text-on-surface truncate flex items-center gap-1.5 {notif.isRead
                        ? ''
                        : 'font-semibold'}"
                    >
                      {#if !notif.isRead}
                        <span
                          class="w-1.5 h-1.5 rounded-full bg-primary shrink-0"
                          aria-hidden="true"
                        ></span>
                      {/if}
                      <span class="truncate">{notif.title}</span>
                      {#if notif.count > 1}<span
                          class="text-2xs font-semibold text-primary shrink-0"
                          >×{notif.count}</span
                        >{/if}
                    </p>
                    <span
                      class="text-2xs text-on-surface-variant whitespace-nowrap shrink-0 tabular-nums"
                    >
                      {formatNotifTime(notif.updatedAt)}
                    </span>
                  </div>
                  <p
                    class="text-2xs text-on-surface-variant leading-snug line-clamp-2"
                  >
                    {notif.message}
                  </p>
                  {#if multiGuild}
                    <span
                      class="mt-1 inline-block text-2xs text-on-surface-variant truncate max-w-full"
                    >
                      {notificationsStore.guildName(notif)}
                    </span>
                  {/if}
                </div>
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <div class="p-2 border-t border-outline-variant shrink-0">
        <a
          href="/notifications"
          onclick={() => (open = false)}
          class="btn btn-tonal btn-sm w-full"
        >
          {m.ntf_view_all()}
        </a>
      </div>
    </div>
  {/if}
</div>
