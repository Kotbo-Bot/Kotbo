import type { MenuItem } from '../ui/Menu.svelte';
import type { StaffMember } from '../../types';
import { staff } from './staffStore.svelte';
import { m } from '../../i18n';

/**
 * Actions secondaires sur un membre, rangees du plus courant au plus lourd.
 * Promouvoir et retrograder restent des boutons sur la ligne ; le reste passe
 * par ce menu, au lieu de sept boutons colores cote a cote.
 */
export function memberMenuItems(member: StaffMember): MenuItem[] {
  const items: MenuItem[] = [];

  if (staff.canModerate) {
    items.push({
      label: m.sx_action_warn(),
      description: m.sx_action_warn_desc(),
      icon: 'alert-triangle',
      onselect: () => (staff.dialogs.warn = { userId: member.userId }),
    });
    items.push({
      label: member.isTutor ? m.sm_title_toggle_tutor_remove() : m.sm_title_toggle_tutor_add(),
      icon: member.isTutor ? 'user-check' : 'user-plus',
      onselect: () => void staff.toggleTutor(member),
    });
  }

  if (staff.canManageSettings) {
    items.push({
      label: m.sm_title_manage_hierarchies(),
      icon: 'git-branch',
      onselect: () => (staff.dialogs.grades = member.userId),
    });
  }

  if (staff.canManageSettings) {
    items.push({
      label: member.suspendedAt ? m.sm_title_unsuspend() : m.sm_title_suspend(),
      description: member.suspendedAt ? undefined : m.sx_action_suspend_desc(),
      icon: member.suspendedAt ? 'play' : 'pause',
      onselect: () => void staff.toggleSuspension(member),
    });
  }

  if (staff.canModerate) {
    items.push({
      label: m.sx_action_blacklist(),
      description: m.sx_action_blacklist_desc(),
      icon: 'slash',
      onselect: () => (staff.dialogs.blacklist = { userId: member.userId }),
    });
  }

  if (staff.canManageSettings) {
    items.push({
      label: m.sm_title_remove_staff(),
      icon: 'user-minus',
      onselect: () => void staff.removeMember(member),
    });
  }

  return items;
}
