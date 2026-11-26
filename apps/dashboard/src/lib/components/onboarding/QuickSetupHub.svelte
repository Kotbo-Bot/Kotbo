<!--
  Les configurations rapides du dashboard, reunies.

  Chaque module qui propose des preselections (un niveau de protection, un
  rythme d'economie, une courbe d'XP) avait son entree a lui, dispersee dans
  son groupe de menu : on ne savait pas qu'elles existaient avant de tomber
  dessus. Elles sont listees ici, dans Prise en main, et seules celles que le
  compte peut ouvrir apparaissent.
-->
<script lang="ts">
  import Papicon from '../Papicon.svelte';
  import SectionCard from '../SectionCard.svelte';
  import { navigationStore } from '../../stores/navigation.svelte';
  import { m } from '../../i18n';

  const ASSISTANTS = [
    {
      href: '/security/quick-setup',
      icon: 'shield',
      title: m.qsh_security,
      description: m.qsh_security_desc,
    },
    {
      href: '/economy-setup',
      icon: 'coins',
      title: m.qsh_economy,
      description: m.qsh_economy_desc,
    },
    {
      href: '/leveling',
      icon: 'trophy',
      title: m.qsh_levels,
      description: m.qsh_levels_desc,
    },
    {
      href: '/prestige',
      icon: 'crown',
      title: m.qsh_prestige,
      description: m.qsh_prestige_desc,
    },
    {
      href: '/channel-health',
      icon: 'activity',
      title: m.qsh_channel_health,
      description: m.qsh_channel_health_desc,
    },
  ];

  // `allItems` porte deja les droits du compte et les modules eteints.
  const available = $derived(
    ASSISTANTS.filter((assistant) => navigationStore.allItems.some((item) => item.href === assistant.href)),
  );
</script>

{#if available.length > 0}
  <SectionCard
    title={m.qsh_title()}
    description={m.qsh_desc()}
    icon="layers"
    flush
  >
    <div class="divide-y divide-outline-variant">
      {#each available as assistant (assistant.href)}
        <a
          href={assistant.href}
          class="group flex items-center gap-3.5 px-5 py-3.5 transition-colors hover:bg-surface-hover"
        >
          <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-container text-on-surface-variant group-hover:bg-primary/15 group-hover:text-primary transition-colors">
            <Papicon icon={assistant.icon} size={17} />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-semibold text-on-surface">{assistant.title()}</span>
            <span class="mt-0.5 block text-body-sm text-on-surface-variant">{assistant.description()}</span>
          </span>
          <Papicon icon="arrow-right" size={14} class="shrink-0 text-on-surface-variant transition-transform group-hover:translate-x-0.5 group-hover:text-on-surface" />
        </a>
      {/each}
    </div>
  </SectionCard>
{/if}
