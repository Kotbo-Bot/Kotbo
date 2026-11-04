/**
 * Menus de rôles tout prêts (couleurs, pronoms, notifications). Choisir un
 * modèle ne fait que remplir le formulaire du dashboard : les rôles qui
 * manquent y sont proposés, et ne sont créés qu'à la publication du menu. Un
 * staff qui essaie les modèles sans publier ne laisse donc aucun rôle derrière
 * lui.
 */
import type { Guild } from 'discord.js';
import type { ReactionRoleMenuMode, ReactionRolePresetKey } from '@kotbo/contracts';
import type { BotLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import type { ReactionRoleOption } from './reactionRoleService.js';

/** Message sans paramètre : nom de rôle ou titre, traduit dans la langue du serveur. */
type Message = typeof m.rr_preset_colors_title;

type PresetSpec = {
  title: Message;
  buttonMode: ReactionRoleMenuMode;
  roles: Array<{ name: Message; color?: number }>;
};

const PRESETS: Record<ReactionRolePresetKey, PresetSpec> = {
  // Une seule couleur à la fois : Discord affiche celle du rôle le plus haut,
  // deux couleurs cumulées ne se verraient pas.
  colors: {
    title: m.rr_preset_colors_title,
    buttonMode: 'exclusive',
    roles: [
      { name: m.rr_preset_color_red, color: 0xe74c3c },
      { name: m.rr_preset_color_orange, color: 0xe67e22 },
      { name: m.rr_preset_color_yellow, color: 0xf1c40f },
      { name: m.rr_preset_color_green, color: 0x2ecc71 },
      { name: m.rr_preset_color_blue, color: 0x3498db },
      { name: m.rr_preset_color_purple, color: 0x9b59b6 },
    ],
  },
  // Plusieurs pronoms peuvent se cumuler : bascule.
  pronouns: {
    title: m.rr_preset_pronouns_title,
    buttonMode: 'toggle',
    roles: [
      { name: m.rr_preset_pronoun_he },
      { name: m.rr_preset_pronoun_she },
      { name: m.rr_preset_pronoun_they },
      { name: m.rr_preset_pronoun_other },
    ],
  },
  notifications: {
    title: m.rr_preset_notifications_title,
    buttonMode: 'toggle',
    roles: [
      { name: m.rr_preset_notif_announcements },
      { name: m.rr_preset_notif_events },
      { name: m.rr_preset_notif_giveaways },
      { name: m.rr_preset_notif_polls },
    ],
  },
};

export function presetDefinition(key: ReactionRolePresetKey, locale: BotLocale) {
  const spec = PRESETS[key];
  return {
    title: spec.title({}, { locale }),
    buttonMode: spec.buttonMode,
    roles: spec.roles.map((role) => ({ name: role.name({}, { locale }), color: role.color })),
  };
}

/** Rôle à créer à la publication du menu, proposé par un modèle. */
export type NewRoleSpec = { name: string; color?: number };

/** Bouton reçu du dashboard : sans `roleId`, il porte le rôle à créer. */
export type ReactionRoleOptionInput = ReactionRoleOption & { newRole?: NewRoleSpec | null };

/** Limite Discord de longueur d'un nom de rôle. */
const ROLE_NAME_MAX_LENGTH = 100;

/**
 * Rôle à créer tel que reçu du navigateur, ramené à ce que Discord accepte.
 * Sans nom, il n'y a rien à créer.
 */
function parseNewRole(value: NewRoleSpec | null | undefined): NewRoleSpec | null {
  const name = typeof value?.name === 'string' ? value.name.trim().slice(0, ROLE_NAME_MAX_LENGTH) : '';
  if (!name) return null;
  const color = value?.color;
  const validColor = typeof color === 'number' && Number.isInteger(color) && color >= 0 && color <= 0xffffff;
  return { name, color: validColor ? color : undefined };
}

/**
 * Rôle du même nom déjà présent et sans danger à distribuer. Un rôle
 * d'intégration est écarté (Discord interdit de l'attribuer), tout comme un
 * rôle qui porte des permissions : un rôle d'administration nommé « Annonces »
 * serait sinon donné à quiconque clique.
 */
function findRoleByName(guild: Guild, name: string) {
  return guild.roles.cache.find((role) => role.name === name && !role.managed && role.permissions.bitfield === 0n) ?? null;
}

/** Ce que le modèle proposerait sur ce serveur, sans rien y créer. */
export function previewReactionRolePreset(guild: Guild, key: ReactionRolePresetKey, locale: BotLocale) {
  const preset = presetDefinition(key, locale);
  const options: ReactionRoleOptionInput[] = preset.roles.map((spec) => {
    const existing = findRoleByName(guild, spec.name);
    return existing
      ? { label: spec.name, roleId: existing.id }
      : { label: spec.name, roleId: '', newRole: { name: spec.name, color: spec.color } };
  });
  return { title: preset.title, buttonMode: preset.buttonMode, options };
}

/**
 * Crée, au moment de publier, les rôles proposés qui manquent encore, sans
 * permission : un rôle de couleur ou de notification n'ouvre aucun droit. Un
 * rôle choisi à la main l'emporte sur la proposition, et un rôle du même nom
 * apparu entre-temps, sans permission, est repris plutôt que doublé.
 */
export async function materializeNewRoles(guild: Guild, options: ReactionRoleOptionInput[]) {
  const resolved: ReactionRoleOption[] = [];
  let createdRoles = 0;

  // Une création après l'autre : Discord limite le débit des créations de rôles.
  for (const { newRole: raw, ...option } of options) {
    const newRole = option.roleId ? null : parseNewRole(raw);
    if (!newRole) {
      resolved.push(option);
      continue;
    }
    const existing = findRoleByName(guild, newRole.name);
    const role = existing ?? await guild.roles.create({
      name: newRole.name,
      color: newRole.color,
      permissions: [],
      reason: 'Rôles à boutons : menu tout prêt',
    });
    if (!existing) createdRoles++;
    resolved.push({ ...option, roleId: role.id });
  }

  return { options: resolved, createdRoles };
}

/** Le menu demande-t-il de créer des rôles avant d'être publié ? */
export function hasNewRoles(options: ReactionRoleOptionInput[]): boolean {
  return options.some((option) => !option.roleId && !!parseNewRole(option.newRole));
}
