/** Hierarchies staff. */
import { authStore } from '../stores/auth.svelte';
import { dashboardMutation, dashboardRequest } from './client';

import { m } from '../i18n';
// Hierarchies API
export async function fetchStaffHierarchies(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/staff/hierarchies', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Staff Hierarchies):'
  });
}

export async function createStaffHierarchy(data, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/staff/hierarchies', {
    method: 'POST',
    successMessage: m.api_ok_create_staff_hierarchy(),
    payload: data,
    guildId,
    errorContext: 'API Error (Create Staff Hierarchy):'
  });
}

export async function updateStaffHierarchy(hierarchyId, data, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/staff/hierarchies/${hierarchyId}`, {
    method: 'PATCH',
    successMessage: m.api_ok_update_staff_hierarchy(),
    payload: data,
    guildId,
    errorContext: 'API Error (Update Staff Hierarchy):'
  });
}

export async function deleteStaffHierarchy(hierarchyId, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/staff/hierarchies/${hierarchyId}`, {
    method: 'DELETE',
    guildId,
    errorContext: 'API Error (Delete Staff Hierarchy):'
  });
}

export async function applyStaffSeparators(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/staff/hierarchies/separators/apply', {
    method: 'POST',
    successMessage: m.sx_sep_applied(),
    guildId,
    errorContext: 'API Error (Apply Staff Separators):'
  });
}

export async function fetchHierarchySchema(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/staff/hierarchies/schema', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Hierarchy Schema):'
  });
}

export async function importHierarchyRoleMembers(hierarchyId, discordRoleId, grade, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/staff/hierarchies/${hierarchyId}/import-roles`, {
    method: 'POST',
    successMessage: m.api_ok_import_hierarchy_role_members(),
    payload: { discordRoleId, grade },
    guildId,
    errorContext: 'API Error (Import Hierarchy Role Members):'
  });
}

export async function addMemberHierarchyGrade(userId, hierarchyId, grade, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/staff/members/${userId}/hierarchy-grade`, {
    method: 'POST',
    successMessage: m.api_ok_add_member_hierarchy_grade(),
    payload: { hierarchyId, grade },
    guildId,
    errorContext: 'API Error (Add Member Hierarchy Grade):'
  });
}

export async function removeMemberHierarchyGrade(userId, hierarchyId, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/staff/members/${userId}/hierarchy-grade/${hierarchyId}`, {
    method: 'DELETE',
    guildId,
    errorContext: 'API Error (Remove Member Hierarchy Grade):'
  });
}

// Canvas libre de l'organigramme (positions, cadres, traits)
export async function fetchOrgCanvas(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/staff/org-canvas', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Org Canvas):'
  });
}

export async function saveOrgCanvas(canvas, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/staff/org-canvas', {
    method: 'PUT',
    payload: { canvas },
    guildId,
    errorContext: 'API Error (Save Org Canvas):'
  });
}
