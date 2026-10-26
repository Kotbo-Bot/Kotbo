<!--
  Épingle un élément d'un module (une suggestion, un ticket) dans les listes de
  suivi reliées à ce module. Absent quand le module Listes de suivi est éteint
  ou que la section est fermée au rôle.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import type { DoingListModule } from '@kotbo/contracts';
  import { Menu, type MenuItem } from '../ui';
  import { m } from '../../i18n';
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import { doingListLinks } from '../../stores/doingListLinks.svelte';
  import { toast } from '../../stores/toast.svelte';

  const { module, sourceId }: { module: DoingListModule; sourceId: string } = $props();

  const available = $derived.by(() => {
    const state = dashboardStore.state;
    const mod = (state.modules as Array<{ id: string; status: string }>).find((entry) => entry.id === 'doing_lists');
    if (mod && mod.status !== 'active') return false;
    return !!state.access?.canManageSettings || state.featureAccess?.doing_lists?.canView !== false;
  });

  onMount(() => {
    if (available) void doingListLinks.load(module);
  });

  const links = $derived(doingListLinks.get(module));
  const pinnedIn = $derived(new Set(links?.items.filter((item) => item.sourceId === sourceId).map((item) => item.listId)));

  async function toggle(listId: string, name: string) {
    try {
      const done = await doingListLinks.toggle(module, listId, sourceId);
      toast.success(done === 'added' ? m.dl_pin_added({ name }) : m.dl_pin_removed({ name }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.dl_pin_error());
    }
  }

  const items = $derived<MenuItem[]>([
    ...(links?.lists ?? []).map((list) => ({
      label: list.name,
      description: pinnedIn.has(list.id) ? m.dl_pin_in_list() : m.dl_pin_add(),
      icon: pinnedIn.has(list.id) ? 'check' : 'plus',
      onselect: () => void toggle(list.id, list.name),
    })),
    {
      label: m.dl_pin_manage(),
      description: links?.lists.length ? undefined : m.dl_pin_none_linked(),
      icon: 'list-checks',
      onselect: () => router.goto('/doing-lists'),
    },
  ]);
</script>

{#if available && links}
  <div class="inline-flex items-center gap-1">
    {#if pinnedIn.size > 0}
      <span class="text-2xs font-semibold text-primary">{m.dl_pin_count({ count: pinnedIn.size })}</span>
    {/if}
    <Menu {items} label={m.dl_pin_label()} icon="list-checks" />
  </div>
{/if}
