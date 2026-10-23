<script lang="ts">
  import HierarchyNode from './HierarchyNode.svelte';
  import Papicon from './Papicon.svelte';
  import { m } from '../i18n';

  export type HierarchyTreeNode = {
    id: string;
    name: string;
    description?: string | null;
    color?: string | null;
    icon?: string | null;
    parentHierarchyId?: string | null;
    responsable?: { userId: string; name?: string | null } | null;
    roles: Array<{ id: string; name: string; level: number; isResponsable: boolean; color?: string | null }>;
    memberCount: number;
    members: Array<{ userId: string; username: string; displayName?: string | null; avatarUrl?: string | null; grade: string }>;
    children: HierarchyTreeNode[];
  };

  const { node, isRoot = false }: { node: HierarchyTreeNode; isRoot?: boolean } = $props();

  function getMembersForRole(hierarchyMembers: HierarchyTreeNode['members'], roleName: string) {
    if (!hierarchyMembers) return [];
    return hierarchyMembers.filter((member) => member.grade.toLowerCase() === roleName.toLowerCase());
  }

  const groupedRolesByLevel = $derived(
    (() => {
      const groups: Record<number, typeof node.roles> = {};
      for (const r of node.roles) {
        const lvl = r.level ?? 0;
        if (!groups[lvl]) groups[lvl] = [];
        groups[lvl].push(r);
      }
      return Object.keys(groups)
        .map(Number)
        .sort((a, b) => b - a)
        .map(lvl => ({
          level: lvl,
          roles: groups[lvl].sort((a, b) => a.name.localeCompare(b.name))
        }));
    })()
  );
</script>

<div class:root-node={isRoot} 
     class="hierarchy-node flex flex-col items-center relative w-full"
     style="--node-color: {node.color || 'var(--color-primary)'};">
  
  <!-- Hierarchy Card -->
  <div class="hierarchy-card group w-full max-w-[320px] p-6 rounded-2xl bg-surface-container-low border border-outline-variant/60 flex flex-col items-center text-center relative"
       style="border-top: 4px solid var(--node-color)">
    
    <div class="node-icon-wrapper flex items-center justify-center w-14 h-14 rounded-2xl mb-4 transition-all duration-300 group-hover:scale-110"
         style="background: color-mix(in srgb, var(--node-color) 12%, transparent); color: var(--node-color); border: 1px solid color-mix(in srgb, var(--node-color) 25%, transparent); box-shadow: 0 4px 12px color-mix(in srgb, var(--node-color) 6%, transparent);">
      {#if node.icon && /^[A-Za-z][\w-]*$/.test(node.icon)}
        <!-- Nom d'icone (« Shield ») plutot qu'emoji : il s'affichait en toutes lettres. -->
        <Papicon icon={node.icon} size={26} />
      {:else}
        <span class="text-2xl">{node.icon || '📁'}</span>
      {/if}
    </div>
    
    <h3 class="text-base font-bold text-on-surface tracking-tight">{node.name}</h3>
    
    {#if node.description}
      <p class="text-xs text-on-surface-variant mt-1.5 leading-relaxed max-w-[260px]">{node.description}</p>
    {/if}

    {#if node.responsable && node.responsable.name}
      <div class="mt-4 px-3.5 py-1 rounded-full bg-surface-container-high/40 border border-outline-variant/10 flex items-center gap-1.5 transition-all duration-200 hover:bg-surface-container-high/70 cursor-default">
        <span class="text-xs font-semibold text-on-surface-variant">{m.staff_orgchart_resp_badge()}</span>
        <span class="text-xs font-semibold text-on-surface">{node.responsable.name}</span>
      </div>
    {/if}
  </div>

  <!-- Vertical connector from Hierarchy Card to Roles (or Children) -->
  {#if node.roles && node.roles.length > 0}
    <div class="vertical-connector-line"></div>
  {/if}

  <!-- Roles Stack -->
  {#if node.roles && node.roles.length > 0}
    <div class="roles-stack w-full max-w-[560px] space-y-3">
      {#each groupedRolesByLevel as group}
        <div class="flex flex-wrap gap-4 justify-center w-full">
          {#each group.roles as role}
            {@const roleMembers = getMembersForRole(node.members, role.name)}
            <div class="role-card group/role flex-1 min-w-[210px] max-w-[260px] p-4 rounded-xl bg-surface-container-lowest border border-outline-variant/60 shadow-xs flex flex-col relative text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-sm"
                 style="--role-color: {role.color || node.color || 'var(--outline)'}; border-left: 3px solid var(--role-color);">
              
              <div class="flex items-center justify-between">
                <h4 class="text-xs font-bold text-on-surface flex items-center gap-1.5 tracking-tight">
                  {role.name}
                  {#if role.isResponsable}
                    <span class="px-1.5 py-0.5 rounded-sm bg-warning/10 text-warning border border-warning/20 text-xs font-semibold">{m.staff_orgchart_chef_badge()}</span>
                  {/if}
                </h4>
                <span class="text-2xs font-bold text-on-surface-variant bg-surface-container-high/60 px-1.5 py-0.5 rounded-sm">
                  {roleMembers.length}
                </span>
              </div>

              {#if roleMembers.length > 0}
                <div class="mt-3 space-y-1.5 border-t border-outline-variant/30 pt-3">
                  {#each roleMembers as member}
                    <div class="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-container-low transition-colors duration-150">
                      {#if member.avatarUrl}
                        <img src={member.avatarUrl} alt="" class="w-6 h-6 rounded-full object-cover shadow-xs border border-outline-variant/10" />
                      {:else}
                        {@const initials = member.displayName?.charAt(0).toUpperCase() || member.username.charAt(0).toUpperCase()}
                        <div class="w-6 h-6 rounded-full bg-primary/10 text-primary text-[10px] font-bold flex items-center justify-center border border-primary/20">
                          {initials}
                        </div>
                      {/if}
                      <div class="flex flex-col min-w-0">
                        <p class="text-xs font-semibold text-on-surface truncate leading-tight">{member.displayName || member.username}</p>
                      </div>
                    </div>
                  {/each}
                </div>
              {:else}
                <div class="mt-2 text-center py-2.5 text-2xs text-on-surface-variant/40 italic bg-surface-container-low/20 rounded-md border border-dashed border-outline-variant/10">
                  {m.staff_orgchart_no_member()}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/each}
    </div>
  {/if}

  <!-- Children Connector and Sub-Hierarchies -->
  {#if node.children && node.children.length > 0}
    <div class="children-connector"></div>
    <div class="children-row">
      {#each node.children as child (child.id)}
        <div class="child-wrap">
          <HierarchyNode node={child} />
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .hierarchy-node {
    position: relative;
  }

  .vertical-connector-line {
    width: 2px;
    height: 32px;
    background: var(--outline-variant);
    transition: background-color 0.2s, box-shadow 0.2s;
  }
  .hierarchy-node:hover > .vertical-connector-line {
    background: var(--node-color);
    box-shadow: 0 0 8px var(--node-color);
  }

  .children-connector {
    width: 2px;
    height: 32px;
    background: var(--outline-variant);
    margin-top: 6px;
    transition: background-color 0.2s, box-shadow 0.2s;
  }
  .hierarchy-node:hover > .children-connector {
    background: var(--node-color);
    box-shadow: 0 0 8px var(--node-color);
  }

  .children-row {
    display: flex;
    flex-wrap: nowrap;
    justify-content: center;
    gap: 3rem;
    margin-top: 2rem;
    position: relative;
  }

  .child-wrap {
    position: relative;
  }

  /* Tree connection lines */
  .child-wrap::before {
    content: '';
    position: absolute;
    top: -2rem;
    left: 50%;
    width: 2px;
    height: 2rem;
    background: var(--outline-variant);
    transform: translateX(-50%);
    transition: background-color 0.2s, box-shadow 0.2s;
    z-index: 1;
  }

  .child-wrap::after {
    content: '';
    position: absolute;
    top: -2rem;
    left: 0;
    width: 100%;
    height: 2px;
    background: var(--outline-variant);
    transition: background-color 0.2s, box-shadow 0.2s;
    z-index: 0;
  }

  .child-wrap:first-child::after {
    left: 50%;
    width: 50%;
  }

  .child-wrap:last-child::after {
    width: 50%;
  }

  .child-wrap:only-child::after {
    display: none;
  }

  /* hover animations for connector lines */
  .child-wrap:hover::before {
    background: var(--node-color);
    box-shadow: 0 0 8px var(--node-color);
  }

  .hierarchy-card {
    box-shadow: 0 4px 20px -2px rgba(0, 0, 0, 0.02);
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }
  
  .hierarchy-card:hover {
    transform: translateY(-4px);
    box-shadow: 0 12px 30px -10px color-mix(in srgb, var(--node-color) 20%, transparent), 0 4px 20px -2px rgba(0, 0, 0, 0.02);
    border-color: color-mix(in srgb, var(--node-color) 30%, var(--outline-variant));
  }
</style>
