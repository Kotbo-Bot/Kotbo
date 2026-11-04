/**
 * Menus de rôles tout prêts (couleurs, pronoms, notifications). Le préréglage
 * crée les rôles qui manquent et rend de quoi remplir le formulaire du
 * dashboard : le staff choisit le salon et peut tout retoucher avant de publier.
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
      { name: m.rr_preset_pronoun_ask },
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

/**
 * Reprend les rôles du même nom déjà présents (sauf ceux d'une intégration,
 * que Discord interdit d'attribuer) et crée les autres, sans permission : un
 * rôle de couleur ou de notification n'ouvre aucun droit.
 */
export async function applyReactionRolePreset(guild: Guild, key: ReactionRolePresetKey, locale: BotLocale) {
  const preset = presetDefinition(key, locale);
  const options: ReactionRoleOption[] = [];
  let createdRoles = 0;

  // Une création après l'autre : Discord limite le débit des créations de rôles.
  for (const spec of preset.roles) {
    const existing = guild.roles.cache.find((role) => role.name === spec.name && !role.managed);
    const role = existing ?? await guild.roles.create({
      name: spec.name,
      color: spec.color,
      permissions: [],
      reason: 'Rôles à boutons : menu tout prêt',
    });
    if (!existing) createdRoles++;
    options.push({ label: spec.name, roleId: role.id });
  }

  return { title: preset.title, buttonMode: preset.buttonMode, options, createdRoles };
}
