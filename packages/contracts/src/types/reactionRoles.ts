/**
 * Menus de rôles à boutons : modes et règle d'attribution, partagés entre le
 * bot (qui applique) et le dashboard (qui prévient avant publication).
 */

/**
 * Mode d'un menu. « exclusive » (un seul rôle) est un mode à part : un membre
 * ne garde qu'un rôle du menu, en prendre un retire les autres.
 */
export const REACTION_ROLE_MENU_MODES = ['toggle', 'add_only', 'exclusive'] as const;
export type ReactionRoleMenuMode = (typeof REACTION_ROLE_MENU_MODES)[number];

/** Mode propre à un bouton, qui surcharge celui d'un menu bascule ou définitif. */
export const REACTION_ROLE_BUTTON_MODES = ['toggle', 'add_only'] as const;
export type ReactionRoleButtonMode = (typeof REACTION_ROLE_BUTTON_MODES)[number];

/** Le mode écrit sur un bouton, ou `null` s'il hérite de celui du menu. */
export function parseButtonMode(value: unknown): ReactionRoleButtonMode | null {
  return REACTION_ROLE_BUTTON_MODES.includes(value as ReactionRoleButtonMode)
    ? (value as ReactionRoleButtonMode)
    : null;
}

export function normalizeMenuMode(value: unknown): ReactionRoleMenuMode {
  return REACTION_ROLE_MENU_MODES.includes(value as ReactionRoleMenuMode)
    ? (value as ReactionRoleMenuMode)
    : 'toggle';
}

/**
 * Ce que fait un second clic sur un bouton. Dans un menu « un seul rôle », il
 * retire le rôle quel que soit le mode écrit sur le bouton : un rôle définitif
 * qu'un autre clic du menu retirerait n'aurait plus rien de définitif.
 */
export function resolveButtonMode(optionMode: unknown, menuMode: unknown): ReactionRoleButtonMode {
  const menu = normalizeMenuMode(menuMode);
  if (menu === 'exclusive') return 'toggle';
  return parseButtonMode(optionMode) ?? menu;
}

/** Préréglages proposés à la création d'un menu. */
export const REACTION_ROLE_PRESET_KEYS = ['colors', 'pronouns', 'notifications'] as const;
export type ReactionRolePresetKey = (typeof REACTION_ROLE_PRESET_KEYS)[number];

/** Raison pour laquelle le bot ne peut pas donner (ou retirer) un rôle. */
export type RoleBlocker = 'missing' | 'managed' | 'no_permission' | 'too_high';

/** Ce que le bot peut attribuer sur un serveur. */
export type BotRoleAccess = {
  canManageRoles: boolean;
  /** Position du rôle le plus haut du bot. */
  topPosition: number;
};

export function roleBlocker(input: {
  exists: boolean;
  /** Rôle tenu par une intégration (bot, boost) : Discord refuse de l'attribuer. */
  managed: boolean;
  botCanManageRoles: boolean;
  rolePosition: number;
  /** Position du rôle le plus haut du bot. */
  botTopPosition: number;
}): RoleBlocker | null {
  if (!input.exists) return 'missing';
  if (input.managed) return 'managed';
  if (!input.botCanManageRoles) return 'no_permission';
  // Discord n'autorise que les rôles strictement sous le plus haut du bot.
  if (input.rolePosition >= input.botTopPosition) return 'too_high';
  return null;
}
