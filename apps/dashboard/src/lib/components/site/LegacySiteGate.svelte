<script lang="ts">
  /**
   * Pages publiques historiques (appel, formulaire, classements, clans,
   * giveaways, actualités) : quand le serveur a un site en ligne qui porte le
   * bloc équivalent, on part vers le site. Sinon, l'ancienne page s'affiche
   * comme avant, une fois la vérification faite.
   */
  import type { Snippet } from 'svelte';
  import Skeleton from '../Skeleton.svelte';
  import { fetchSiteRedirect } from '../../api/site';

  let { path, children }: { path: string; children: Snippet } = $props();

  type Lookup = { guildId?: string; kind?: string; formId?: string };

  const SNOWFLAKE = /^\d{17,20}$/;
  const BY_SUFFIX: Record<string, string> = {
    news: 'news',
    'leveling/classement': 'leaderboard-xp',
    'prestige/classement': 'leaderboard-prestige',
    'leveling/clan': 'clans',
    clan: 'clans',
    rpg: 'clans-rpg',
    'clan-rpg': 'clans-rpg',
    giveaways: 'giveaways',
  };

  function lookupFor(current: string): Lookup | null {
    const parts = current.split('?')[0].split('/').filter(Boolean);
    if (parts[0] === 'form' && parts.length === 2) return { formId: parts[1] };
    if (parts[0] === 'appeal' && parts.length === 2 && SNOWFLAKE.test(parts[1])) return { guildId: parts[1], kind: 'appeal' };
    if (parts.length >= 2 && SNOWFLAKE.test(parts[0])) {
      const kind = BY_SUFFIX[parts.slice(1).join('/')];
      if (kind) return { guildId: parts[0], kind };
    }
    return null;
  }

  const lookup = $derived(lookupFor(path));
  let checkedPath = $state<string | null>(null);

  $effect(() => {
    const current = path;
    const target = lookup;
    if (!target) {
      checkedPath = current;
      return;
    }
    let cancelled = false;
    void fetchSiteRedirect(target).then((destination) => {
      if (cancelled) return;
      if (destination) window.location.replace(destination);
      else checkedPath = current;
    });
    return () => {
      cancelled = true;
    };
  });
</script>

{#if !lookup || checkedPath === path}
  {@render children()}
{:else}
  <div class="space-y-4 p-6" aria-busy="true">
    <Skeleton height="h-8" width="max-w-xs" />
    <Skeleton height="h-4" width="max-w-md" />
  </div>
{/if}
