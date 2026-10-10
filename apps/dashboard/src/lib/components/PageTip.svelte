<script lang="ts">
  import { onboardingStore } from '../stores/tutorial.svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import {
    X, Lightbulb, CheckCircle2,
    LayoutGrid, Inbox, PieChart, Users, AlertTriangle, ShieldAlert,
    FileText, History, Link, Zap, Trophy, Coins, Sparkles, Megaphone,
    MousePointer, MessageSquare, ThumbsUp, FilePlus, Book, Rss,
    UserCheck, UserPlus, BookOpen, Calendar, Package, Settings,
    Hash, Terminal, Code, Filter, Shield, Clipboard, Smile, Share2, Archive,
  } from 'lucide-svelte';
  import { m } from '../i18n';

  const iconMap: Record<string, typeof LayoutGrid> = {
    'layout-grid': LayoutGrid,
    'inbox': Inbox,
    'pie-chart': PieChart,
    'users': Users,
    'alert-triangle': AlertTriangle,
    'shield-alert': ShieldAlert,
    'file-text': FileText,
    'history': History,
    'link': Link,
    'zap': Zap,
    'trophy': Trophy,
    'coins': Coins,
    'sparkles': Sparkles,
    'megaphone': Megaphone,
    'mouse-pointer': MousePointer,
    'message-square': MessageSquare,
    'thumbs-up': ThumbsUp,
    'file-plus': FilePlus,
    'book': Book,
    'rss': Rss,
    'user-check': UserCheck,
    'user-plus': UserPlus,
    'book-open': BookOpen,
    'calendar': Calendar,
    'package': Package,
    'settings': Settings,
    'hash': Hash,
    'terminal': Terminal,
    'code': Code,
    'filter': Filter,
    'shield': Shield,
    'clipboard': Clipboard,
    'smile': Smile,
    'share-2': Share2,
    'archive': Archive,
  };

  const tip = $derived(onboardingStore.activePageTip);
  const dismissed = $derived(onboardingStore.pageTipDismissed);
  const show = $derived(tip !== null && !dismissed && onboardingStore.welcomeSeen);

  function dismiss() {
    onboardingStore.dismissPageTip();
  }
</script>

{#if show && tip}
  {@const Icon = iconMap[tip.icon] || Lightbulb}
  <div
    class="page-tip mb-6"
    transition:fly={{ y: -12, duration: 300, easing: cubicOut }}
  >
    <div class="page-tip__card relative bg-surface-container-lowest border border-primary/20 rounded-xl overflow-hidden shadow-sm">
      <!-- Top gradient line -->
      <div class="h-0.5 bg-gradient-to-r from-primary via-secondary to-primary/30"></div>

      <div class="page-tip__inner p-5">
        <div class="page-tip__layout flex items-start gap-4">
          <!-- Icon -->
          <div class="page-tip__icon shrink-0">
            <div class="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <Icon class="w-5 h-5 text-primary" />
            </div>
          </div>

          <!-- Content -->
          <div class="flex-1 min-w-0">
            <div class="flex items-start justify-between gap-3 mb-2">
              <div class="page-tip__heading min-w-0">
                <div class="page-tip__badge flex items-center gap-2 mb-1">
                  <span class="text-xs font-semibold text-primary/80 bg-primary/8 px-2 py-0.5 rounded-full">
                    {m.tip_badge()}
                  </span>
                </div>
                <h3 class="page-tip__title text-base font-semibold text-on-surface">{tip.title}</h3>
              </div>
              <button
                onclick={dismiss}
                class="p-1.5 -mt-1 -mr-1 rounded-lg hover:bg-surface-container text-on-surface-variant/50 hover:text-on-surface transition-colors shrink-0"
                aria-label={m.tip_close()}
              >
                <X class="w-4 h-4" />
              </button>
            </div>

            <p class="page-tip__description text-sm text-on-surface-variant leading-relaxed mb-3">
              {tip.description}
            </p>

            <!-- Highlights -->
            {#if tip.highlights.length > 0}
              <div class="page-tip__highlights space-y-1.5">
                {#each tip.highlights as highlight}
                  <div class="flex items-start gap-2">
                    <CheckCircle2 class="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
                    <span class="text-xs text-on-surface-variant/80 leading-relaxed">{highlight}</span>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        </div>

        <!-- Footer -->
        <div class="page-tip__footer flex items-center justify-end mt-4 pt-3 border-t border-outline-variant/50">
          <button
            onclick={dismiss}
            class="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary/10 text-primary text-xs font-medium hover:bg-primary/15 transition-colors"
          >
            {m.tip_got_it()}
            <CheckCircle2 class="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  /* A tip whose body is hidden is just a headline taking up space, so the
     phone layout keeps the title and the explanation and drops the
     supporting checklist, the eyebrow and the duplicate dismiss button. */
  @media (max-width: 767px) {
    .page-tip {
      margin-bottom: 0.875rem;
    }

    .page-tip__card {
      border-radius: 0.875rem;
    }

    .page-tip__inner {
      padding: 0.875rem;
    }

    .page-tip__layout {
      gap: 0.75rem;
    }

    .page-tip__icon > div {
      width: 2rem;
      height: 2rem;
      border-radius: 0.625rem;
    }

    .page-tip__badge,
    .page-tip__highlights,
    .page-tip__footer {
      display: none;
    }

    .page-tip__title {
      font-size: 0.9375rem;
      line-height: 1.25;
    }

    .page-tip__description {
      margin-bottom: 0;
      font-size: 0.8125rem;
    }
  }
</style>
