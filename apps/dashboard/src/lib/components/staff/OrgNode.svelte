<!--
  Une carte de l'organigramme et ses descendants. Les memes elements servent
  aux trois affichages : c'est la classe posee sur la liste racine (OrgChart)
  qui les dispose et trace les liens.
-->
<script lang="ts" module>
  import type { MenuItem } from '../ui/Menu.svelte';
  import type { OrgCard, OrgMember, OrgSection } from './orgChartModel';

  export type DropPosition = 'before' | 'inside' | 'after';

  /** Ce que le graphe attend d'OrgChart, qui garde l'etat du glisser. */
  export interface OrgControls {
    editing: boolean;
    openCase?: (userId: string, userName: string) => void;
    canDragCard: (card: OrgCard) => boolean;
    canDragSection: (section: OrgSection) => boolean;
    canDragMember: boolean;
    dropCard: (card: OrgCard) => DropPosition | null;
    dropSection: (section: OrgSection) => boolean;
    isDragged: (id: string) => boolean;
    startCard: (event: DragEvent, card: OrgCard) => void;
    startSection: (event: DragEvent, section: OrgSection) => void;
    startMember: (event: DragEvent, member: OrgMember) => void;
    overCard: (event: DragEvent, card: OrgCard) => void;
    overSection: (event: DragEvent, section: OrgSection) => void;
    drop: (event: DragEvent) => void;
    end: () => void;
    cardMenu: (card: OrgCard) => MenuItem[];
    sectionMenu: (section: OrgSection) => MenuItem[];
    memberMenu: (member: OrgMember) => MenuItem[];
  }
</script>

<script lang="ts">
  import OrgNode from './OrgNode.svelte';
  import HierarchyIcon from './HierarchyIcon.svelte';
  import StaffAvatar from './StaffAvatar.svelte';
  import { Menu } from '../ui';
  import { m } from '../../i18n';

  const { card, ctrl }: { card: OrgCard; ctrl: OrgControls } = $props();

  const cardItems = $derived(ctrl.editing ? ctrl.cardMenu(card) : []);
  const dropping = $derived(ctrl.dropCard(card));
</script>

{#snippet memberName(member: OrgMember)}
  <StaffAvatar url={member.avatarUrl} name={member.name} userId={member.userId} size={22} />
  <span class="min-w-0 truncate">{member.name}</span>
{/snippet}

<li class="org-branch">
  <article
    class="org-card"
    class:is-dragged={ctrl.isDragged(card.id)}
    class:drop-before={dropping === 'before'}
    class:drop-inside={dropping === 'inside'}
    class:drop-after={dropping === 'after'}
    class:is-movable={ctrl.canDragCard(card)}
    style="--org-color: {card.color || 'var(--primary-color)'}"
    draggable={ctrl.canDragCard(card)}
    aria-label={card.title}
    ondragstart={(event) => ctrl.startCard(event, card)}
    ondragover={(event) => ctrl.overCard(event, card)}
    ondrop={ctrl.drop}
    ondragend={ctrl.end}
  >
    <header class="flex items-start gap-2.5">
      {#if card.kind !== 'grade'}
        <HierarchyIcon icon={card.icon} color={card.kind === 'chief' ? 'var(--warning-color, var(--primary-color))' : card.color} size={32} />
      {/if}
      <div class="min-w-0 flex-1">
        <h3 class="truncate text-sm font-semibold text-on-surface">{card.title}</h3>
        {#if card.description}
          <p class="mt-0.5 line-clamp-2 text-xs text-on-surface-variant">{card.description}</p>
        {/if}
      </div>
      {#if card.kind !== 'chief'}
        <span class="shrink-0 pt-0.5 text-xs tabular-nums text-on-surface-variant" title={m.sm_org_members({ count: card.memberCount })}>
          {card.memberCount}
        </span>
      {/if}
      {#if cardItems.length}
        <Menu items={cardItems} label={m.sm_org_menu({ name: card.title })} />
      {/if}
    </header>

    {#if card.responsable}
      <p class="mt-2 truncate text-xs text-on-surface-variant">
        {m.staff_orgchart_resp_badge()} : <span class="font-medium text-on-surface">{card.responsable}</span>
      </p>
    {/if}

    {#if card.sections.length}
      <div class="mt-2.5 space-y-1">
        {#each card.sections as section (section.id)}
          {@const sectionItems = ctrl.editing ? ctrl.sectionMenu(section) : []}
          <section
            class="org-section"
            class:is-dragged={ctrl.isDragged(section.id)}
            class:drop-inside={ctrl.dropSection(section)}
            class:is-movable={ctrl.canDragSection(section)}
            aria-label={section.title}
            draggable={ctrl.canDragSection(section)}
            ondragstart={(event) => ctrl.startSection(event, section)}
            ondragover={(event) => ctrl.overSection(event, section)}
            ondrop={ctrl.drop}
            ondragend={ctrl.end}
          >
            <div class="flex items-center gap-1.5 text-xs">
              <span class="h-2 w-2 shrink-0 rounded-full" style="background: {section.color || 'var(--outline-variant)'}" aria-hidden="true"></span>
              <h4 class="min-w-0 truncate font-medium text-on-surface">{section.title}</h4>
              {#if section.lead}
                <span class="shrink-0 rounded-sm bg-warning/10 px-1 text-2xs font-medium text-warning">{m.staff_orgchart_chef_badge()}</span>
              {/if}
              <span class="ml-auto shrink-0 tabular-nums text-on-surface-variant">{section.members.length}</span>
              {#if sectionItems.length}
                <Menu items={sectionItems} label={m.sm_org_menu({ name: section.title })} />
              {/if}
            </div>

            {#if section.members.length}
              <ul class="org-members mt-1">
                {#each section.members as member (member.userId)}
                  {@const memberItems = ctrl.editing ? ctrl.memberMenu(member) : []}
                  <li
                    class="flex items-center gap-1"
                    class:is-dragged={ctrl.isDragged(member.userId)}
                    class:is-movable={ctrl.canDragMember}
                    draggable={ctrl.canDragMember}
                    ondragstart={(event) => ctrl.startMember(event, member)}
                    ondragend={ctrl.end}
                  >
                    {#if ctrl.openCase && !ctrl.editing}
                      <button
                        type="button"
                        class="org-member hover:bg-surface-container-high"
                        aria-label={m.sm_org_open_member({ name: member.name })}
                        onclick={() => ctrl.openCase?.(member.userId, member.name)}
                      >
                        {@render memberName(member)}
                      </button>
                    {:else}
                      <span class="org-member">{@render memberName(member)}</span>
                    {/if}
                    {#if memberItems.length}
                      <Menu items={memberItems} label={m.sm_org_menu({ name: member.name })} />
                    {/if}
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="mt-0.5 pl-3.5 text-xs text-on-surface-variant">{m.staff_orgchart_no_member()}</p>
            {/if}
          </section>
        {/each}
      </div>
    {/if}
  </article>

  {#if card.children.length}
    <ul class="org-children">
      {#each card.children as child (child.id)}
        <OrgNode card={child} {ctrl} />
      {/each}
    </ul>
  {/if}
</li>
