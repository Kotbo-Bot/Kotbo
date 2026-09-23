/**
 * Règles de création des salons vocaux temporaires : fonctions pures et
 * vérifiables sans client Discord. La politique par défaut laisse les
 * serveurs déjà configurés inchangés.
 */
import { OverwriteType, PermissionFlagsBits, type OverwriteResolvable } from 'discord.js';
import type { TempVoiceOwnerPower, TempVoiceTextChatMode, TempVoicePolicy } from '@kotbo/shared';

export type { TempVoiceOwnerPower, TempVoiceTextChatMode, TempVoicePolicy };

export const TEMP_VOICE_OWNER_POWERS: readonly TempVoiceOwnerPower[] = [
  'mute',
  'deafen',
  'move',
  'manageChannel',
  'manageMessages',
] as const;

export const TEMP_VOICE_TEXT_CHAT_MODES: readonly TempVoiceTextChatMode[] = [
  'inherit',
  'open',
  'locked',
] as const;

export const LEGACY_OWNER_POWERS: readonly TempVoiceOwnerPower[] = ['mute', 'deafen', 'move'] as const;

/** Un salon Discord n'accepte pas plus de 99 places. */
export const MAX_USER_LIMIT = 99;

/** Au-delà, la liste des rôles autorisés d'office n'est plus lisible en page. */
export const MAX_AUTO_ALLOW_ROLES = 10;

export interface TempVoiceGenerator {
  channelId: string;
  categoryId?: string;
  nameTemplate: string;
  requiredRoleId?: string;
  policy: TempVoicePolicy;
  /** `generators[0]` n'est pas forcément le principal : un serveur peut n'avoir que des additionnels. */
  primary: boolean;
}

export interface StoredTempVoiceGenerator {
  channelId: string;
  categoryId?: string;
  nameTemplate?: string;
  requiredRoleId?: string | null;
  userLimit?: number;
  lockOnCreate?: boolean;
  autoAllowRoleIds?: string[];
  textChat?: TempVoiceTextChatMode;
  ownerPowers?: TempVoiceOwnerPower[];
}

export const DEFAULT_NAME_TEMPLATE = '🔊 Salon de {user}';

export function defaultTempVoicePolicy(): TempVoicePolicy {
  return {
    userLimit: 0,
    lockOnCreate: false,
    autoAllowRoleIds: [],
    textChat: 'inherit',
    ownerPowers: [...LEGACY_OWNER_POWERS],
  };
}

function isSnowflake(value: unknown): value is string {
  return typeof value === 'string' && /^\d{17,20}$/.test(value);
}

/** `everyoneRoleId` est écarté : il passe la validation de format, et l'autoriser d'office
 *  viderait le verrouillage de son sens. */
function normalizeRoleIds(value: unknown, max: number, everyoneRoleId?: string): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter(isSnowflake).filter((id) => id !== everyoneRoleId);
  return [...new Set(ids)].slice(0, max);
}

function normalizeUserLimit(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(Math.max(Math.trunc(parsed), 0), MAX_USER_LIMIT);
}

function normalizeOwnerPowers(value: unknown): TempVoiceOwnerPower[] {
  // `undefined` n'est pas « aucun pouvoir », c'est « rien n'a été dit » : le
  // champ absent rend les pouvoirs historiques, la liste vide n'en rend aucun.
  if (!Array.isArray(value)) return [...LEGACY_OWNER_POWERS];
  return TEMP_VOICE_OWNER_POWERS.filter((power) => value.includes(power));
}

function normalizeTextChat(value: unknown): TempVoiceTextChatMode {
  return TEMP_VOICE_TEXT_CHAT_MODES.includes(value as TempVoiceTextChatMode)
    ? (value as TempVoiceTextChatMode)
    : 'inherit';
}

/** Ramène une valeur de la base ou du dashboard à une politique complète :
 *  personne d'autre ne valide ce JSON. */
export function normalizeTempVoicePolicy(raw: unknown, everyoneRoleId?: string): TempVoicePolicy {
  if (!raw || typeof raw !== 'object') return defaultTempVoicePolicy();
  const source = raw as Record<string, unknown>;

  return {
    userLimit: normalizeUserLimit(source.userLimit),
    lockOnCreate: source.lockOnCreate === true,
    autoAllowRoleIds: normalizeRoleIds(source.autoAllowRoleIds, MAX_AUTO_ALLOW_ROLES, everyoneRoleId),
    textChat: normalizeTextChat(source.textChat),
    ownerPowers: normalizeOwnerPowers(source.ownerPowers),
  };
}

/** Nombre maximum de générateurs additionnels acceptés pour un serveur. */
export const MAX_ADDITIONAL_GENERATORS = 25;

export function normalizeTempVoiceGeneratorsInput(
  raw: unknown,
  everyoneRoleId?: string,
  mainChannelId?: string | null,
): StoredTempVoiceGenerator[] {
  if (!Array.isArray(raw)) return [];

  const normalized: StoredTempVoiceGenerator[] = [];
  // Le générateur principal occupe déjà son salon : un additionnel dessus ne serait jamais atteint.
  const seen = new Set<string>(mainChannelId ? [mainChannelId] : []);

  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (!isSnowflake(entry.channelId)) continue;
    // Deux générateurs sur le même salon : le second ne serait jamais atteint.
    if (seen.has(entry.channelId)) continue;
    seen.add(entry.channelId);

    const policy = normalizeTempVoicePolicy(entry, everyoneRoleId);
    const nameTemplate = typeof entry.nameTemplate === 'string' && entry.nameTemplate.trim()
      ? entry.nameTemplate.trim().slice(0, 100)
      : DEFAULT_NAME_TEMPLATE;

    normalized.push({
      channelId: entry.channelId,
      ...(isSnowflake(entry.categoryId) ? { categoryId: entry.categoryId } : {}),
      nameTemplate,
      requiredRoleId: isSnowflake(entry.requiredRoleId) ? entry.requiredRoleId : null,
      userLimit: policy.userLimit,
      lockOnCreate: policy.lockOnCreate,
      autoAllowRoleIds: policy.autoAllowRoleIds,
      textChat: policy.textChat,
      ownerPowers: policy.ownerPowers,
    });

    if (normalized.length >= MAX_ADDITIONAL_GENERATORS) break;
  }

  return normalized;
}

/** Colonnes du serveur que la résolution des générateurs consulte. */
export interface TempVoiceGuildConfig {
  tempVoiceEnabled: boolean;
  tempVoiceChannelId: string | null;
  tempVoiceCategoryId: string | null;
  tempVoiceNameTemplate: string;
  tempVoiceRequiredRoleId?: string | null;
  tempVoiceDefaults?: unknown;
  tempVoiceGenerators?: unknown;
}

/** Le principal vit dans des colonnes à plat, les additionnels dans un JSON ;
 *  `everyoneRoleId` descend jusqu'à la normalisation pour filtrer une base écrite à la main. */
export function resolveTempVoiceGenerators(
  guildConfig: TempVoiceGuildConfig,
  everyoneRoleId?: string,
): TempVoiceGenerator[] {
  const generators: TempVoiceGenerator[] = [];

  if (guildConfig.tempVoiceChannelId) {
    generators.push({
      channelId: guildConfig.tempVoiceChannelId,
      categoryId: guildConfig.tempVoiceCategoryId || undefined,
      nameTemplate: guildConfig.tempVoiceNameTemplate || DEFAULT_NAME_TEMPLATE,
      requiredRoleId: guildConfig.tempVoiceRequiredRoleId || undefined,
      policy: normalizeTempVoicePolicy(guildConfig.tempVoiceDefaults, everyoneRoleId),
      primary: true,
    });
  }

  if (Array.isArray(guildConfig.tempVoiceGenerators)) {
    for (const value of guildConfig.tempVoiceGenerators) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.channelId !== 'string') continue;

      generators.push({
        channelId: entry.channelId,
        categoryId: typeof entry.categoryId === 'string' ? entry.categoryId : undefined,
        nameTemplate: typeof entry.nameTemplate === 'string' ? entry.nameTemplate : DEFAULT_NAME_TEMPLATE,
        requiredRoleId: typeof entry.requiredRoleId === 'string' ? entry.requiredRoleId : undefined,
        policy: normalizeTempVoicePolicy(entry, everyoneRoleId),
        primary: false,
      });
    }
  }

  return generators;
}

const OWNER_POWER_BITS: Record<TempVoiceOwnerPower, bigint> = {
  mute: PermissionFlagsBits.MuteMembers,
  deafen: PermissionFlagsBits.DeafenMembers,
  move: PermissionFlagsBits.MoveMembers,
  manageChannel: PermissionFlagsBits.ManageChannels,
  manageMessages: PermissionFlagsBits.ManageMessages,
};

/** Le propriétaire garde l'écriture quand quelque chose la lui retirerait — salon verrouillé
 *  ou chat « locked » — sinon « Verrouiller » le rendrait muet chez lui.
 *
 *  Hors de ces cas, on ne lui accorde PAS `SendMessages` : une surcharge de membre prime sur
 *  celle d'un rôle, donc un `allow` nommé le laissait écrire là où tous les autres héritaient
 *  du refus de la catégorie. Le propriétaire était alors le seul à pouvoir parler dans le chat
 *  de son propre salon. Sans cette surcharge, tout le monde suit la même règle que la catégorie,
 *  et le mode « open » reste le moyen explicite d'ouvrir le chat à tous. */
export function ownerAllowBits(policy: TempVoicePolicy): bigint[] {
  const chatReserve = policy.lockOnCreate || policy.textChat === 'locked';

  const bits = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.Speak,
    ...(chatReserve ? [PermissionFlagsBits.SendMessages] : []),
    PermissionFlagsBits.ReadMessageHistory,
  ];

  for (const power of policy.ownerPowers) bits.push(OWNER_POWER_BITS[power]);

  return bits;
}

/** Discord refuse une surcharge qui accorde un droit que le bot n'a pas lui-même. */
export function requiredBotPermissions(policy: TempVoicePolicy): bigint[] {
  return [
    ...new Set([
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.MoveMembers,
      // Créer un salon avec des surcharges de permissions exige `ManageRoles`.
      PermissionFlagsBits.ManageRoles,
      ...ownerAllowBits(policy),
    ]),
  ];
}

export interface OverwriteDraft {
  id: string;
  type: OverwriteType;
  allow: bigint;
  deny: bigint;
}

function toBigInt(value: bigint | number | string | { bitfield: bigint }): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'object' && value && 'bitfield' in value) return value.bitfield;
  return BigInt(value);
}

/** Autoriser un bit le retire du refus : les deux champs sont exclusifs côté Discord. */
function applyBits(draft: OverwriteDraft, allow: bigint[] = [], deny: bigint[] = []): OverwriteDraft {
  let nextAllow = draft.allow;
  let nextDeny = draft.deny;

  for (const bit of allow) {
    nextAllow |= bit;
    nextDeny &= ~bit;
  }
  for (const bit of deny) {
    nextDeny |= bit;
    nextAllow &= ~bit;
  }

  return { ...draft, allow: nextAllow, deny: nextDeny };
}

/** Un refus porté par @everyone reste dépassable (le propriétaire entre dans son
 *  salon sur un serveur fermé) ; un refus posé sur la *même* cible gagne toujours. */
function grantableBits(allow: bigint[], inheritedDeny: bigint): bigint[] {
  return allow.filter((bit) => (inheritedDeny & bit) !== bit);
}

export interface BuildCreationOverwritesInput {
  /** Identifiant du rôle @everyone, qui vaut celui du serveur. */
  everyoneRoleId: string;
  ownerId: string;
  /** Surcharges recopiées de la catégorie parente, vides si elle n'existe pas. */
  inherited: OverwriteDraft[];
  policy: TempVoicePolicy;
}

/** La politique s'empile bit à bit sur ce que porte la catégorie, sans jamais remplacer
 *  une surcharge entière : un salon rouvert à @everyone serait le seul sans vérification. */
export function buildCreationOverwrites(input: BuildCreationOverwritesInput): OverwriteResolvable[] {
  const { everyoneRoleId, ownerId, inherited, policy } = input;

  const drafts = new Map<string, OverwriteDraft>();
  for (const overwrite of inherited) {
    drafts.set(overwrite.id, { ...overwrite });
  }

  const ensure = (id: string, type: OverwriteType): OverwriteDraft => {
    const existing = drafts.get(id);
    if (existing) return existing;
    const created: OverwriteDraft = { id, type, allow: 0n, deny: 0n };
    drafts.set(id, created);
    return created;
  };

  const inheritedDenyFor = (id: string): bigint =>
    inherited.find((overwrite) => overwrite.id === id)?.deny ?? 0n;

  // 1. Propriétaire : la surcharge héritée est complétée, jamais retournée.
  drafts.set(ownerId, applyBits(
    ensure(ownerId, OverwriteType.Member),
    grantableBits(ownerAllowBits(policy), inheritedDenyFor(ownerId)),
  ));

  // 2. Rôles autorisés d'office : ils entrent même si le salon naît verrouillé.
  const autoAllow = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.Speak,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
  ];

  for (const roleId of policy.autoAllowRoleIds) {
    // Garde-fou : une base écrite avant la normalisation peut encore contenir @everyone ici.
    if (roleId === everyoneRoleId) continue;
    drafts.set(roleId, applyBits(
      ensure(roleId, OverwriteType.Role),
      grantableBits(autoAllow, inheritedDenyFor(roleId)),
    ));
  }

  const everyoneAllow: bigint[] = [];
  const everyoneDeny: bigint[] = [];

  if (policy.lockOnCreate) {
    everyoneDeny.push(PermissionFlagsBits.Connect);
    // Verrouiller ferme aussi l'écriture, sauf si le chat est explicitement ouvert.
    if (policy.textChat !== 'open') everyoneDeny.push(PermissionFlagsBits.SendMessages);
  }
  if (policy.textChat === 'open') everyoneAllow.push(PermissionFlagsBits.SendMessages);
  if (policy.textChat === 'locked') everyoneDeny.push(PermissionFlagsBits.SendMessages);

  // 3. @everyone : verrouillage et chat, rien d'autre.
  if (everyoneAllow.length > 0 || everyoneDeny.length > 0) {
    // Même règle : le mode « ouvert » n'écrase pas un refus nommé de la catégorie.
    drafts.set(
      everyoneRoleId,
      applyBits(
        ensure(everyoneRoleId, OverwriteType.Role),
        grantableBits(everyoneAllow, inheritedDenyFor(everyoneRoleId)),
        everyoneDeny,
      ),
    );
  }

  // Discord conserve et affiche une surcharge qui n'autorise ni ne refuse rien.
  return [...drafts.values()]
    .filter((draft) => draft.allow !== 0n || draft.deny !== 0n)
    .map((draft) => ({
      id: draft.id,
      type: draft.type,
      allow: draft.allow,
      deny: draft.deny,
    }));
}

/** Surcharges d'une catégorie Discord ramenées à la forme utilisée ici. */
export function toOverwriteDrafts(
  overwrites: Iterable<{ id: string; type: OverwriteType; allow: bigint | { bitfield: bigint }; deny: bigint | { bitfield: bigint } }>,
): OverwriteDraft[] {
  return [...overwrites].map((overwrite) => ({
    id: overwrite.id,
    type: overwrite.type,
    allow: toBigInt(overwrite.allow),
    deny: toBigInt(overwrite.deny),
  }));
}

/**
 * Surcharges posées par les boutons du panneau de gestion.
 *
 * Regroupées ici pour que l'invariant tienne en un seul endroit vérifiable :
 * rien de ce qui rouvre un salon n'autorise explicitement. Un `null` ici veut
 * dire « rendre le droit à la catégorie » et doit passer par
 * `restoreFromCategory` avant d'être écrit.
 */
export const CHANNEL_PATCHES = {
  lock: { Connect: false, SendMessages: false },
  unlock: { Connect: null, SendMessages: null },
  /** Levée de réservation : même règle que le déverrouillage. */
  clearReservation: { Connect: null, SendMessages: null },
  /** @deprecated Ancien nom de `ownerOnly`, gardé le temps que les panneaux en place migrent. */
  closeChat: { SendMessages: false },
  /** @deprecated Ancien nom de `everyone`, gardé le temps que les panneaux en place migrent. */
  openChat: { SendMessages: null },
  /** Bannissement : couper la seule connexion laisse lire et écrire dans le chat. */
  ban: { Connect: false, ViewChannel: false, SendMessages: false },

  // ─── Les quatre modes d'écriture, posés sur @everyone ───
  // Le propriétaire ne se déduit pas de ces patchs : il a sa propre surcharge,
  // rendue par `surchargesModeEcriture()`. Deux modes portaient déjà ces bits
  // sans porter de nom ; les deux autres sont neufs.

  /** « Tout le monde » — l'ancien `openChat`. Rendre le droit à la catégorie, jamais l'accorder. */
  everyone: { SendMessages: null },
  /** « Ceux qui sont en vocal » — @everyone est refusé, la présence pose une surcharge nominative. */
  inVoice: { SendMessages: false },
  /** « Moi seul » — l'ancien `closeChat`, complété par `ownerChatPatch(true, …)`. */
  ownerOnly: { SendMessages: false },
  /** « Personne » — identique sur @everyone, mais le propriétaire est coupé lui aussi. */
  nobody: { SendMessages: false },
} as const satisfies Record<string, Record<string, boolean | null>>;

export type OverwriteBits = { allow: bigint | { bitfield: bigint }; deny: bigint | { bitfield: bigint } };

/** Un salon n'hérite pas de sa catégorie en direct : ses surcharges y ont été recopiées
 *  à la création. Écrire `null` renverrait le droit à ceux du serveur, pas à la catégorie. */
function categoryValue(categoryOverwrite: OverwriteBits | null | undefined, bit: bigint): boolean | null {
  if (!categoryOverwrite) return null;
  if ((toBigInt(categoryOverwrite.deny) & bit) === bit) return false;
  if ((toBigInt(categoryOverwrite.allow) & bit) === bit) return true;
  return null;
}

/** Remplace chaque `null` du patch par ce que la catégorie porte pour la même cible. */
export function restoreFromCategory(
  patch: Readonly<Record<string, boolean | null>>,
  categoryOverwrite: OverwriteBits | null | undefined,
): Record<string, boolean | null> {
  const restored: Record<string, boolean | null> = {};
  for (const [name, value] of Object.entries(patch)) {
    const bit = PermissionFlagsBits[name as keyof typeof PermissionFlagsBits];
    restored[name] = value === null ? categoryValue(categoryOverwrite, bit) : value;
  }
  return restored;
}

export function categoryOverwriteFor(
  channel: { parent: { permissionOverwrites: { cache: { get(id: string): OverwriteBits | undefined } } } | null },
  targetId: string,
): OverwriteBits | null {
  return channel.parent?.permissionOverwrites.cache.get(targetId) ?? null;
}

/** @everyone porte l'identifiant du serveur : il passe la validation de format, et le réserver
 *  ouvrirait le salon à tout le monde. Le rôle doit exister, sans quoi la surcharge viserait
 *  autre chose. */
export function resolveReservationRoleId(
  value: unknown,
  everyoneRoleId: string,
  guildRoleIds: ReadonlySet<string>,
): string | null {
  if (!isSnowflake(value)) return null;
  if (value === everyoneRoleId) return null;
  return guildRoleIds.has(value) ? value : null;
}

/** Ce que « Ajouter » accorde, avant confrontation avec la catégorie. */
const TRUST_BITS: ReadonlyArray<[bigint, string]> = [
  [PermissionFlagsBits.ViewChannel, 'ViewChannel'],
  [PermissionFlagsBits.Connect, 'Connect'],
  [PermissionFlagsBits.Speak, 'Speak'],
  [PermissionFlagsBits.SendMessages, 'SendMessages'],
  [PermissionFlagsBits.ReadMessageHistory, 'ReadMessageHistory'],
];

/** Dérivé de `TRUST_BITS.length` plutôt qu'écrit en dur, qui figerait le nombre
 *  au jour où la liste a été écrite. */
export const TRUST_BIT_COUNT = TRUST_BITS.length;

export function trustPermissionPatch(categoryPermissions: bigint | null): Record<string, true> | null {
  const patch: Record<string, true> = {};
  for (const [bit, name] of TRUST_BITS) {
    if (categoryPermissions === null || (categoryPermissions & bit) === bit) patch[name] = true;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Droits *effectifs* dans la catégorie, pas la surcharge nominative : une catégorie
 *  restreinte se configure souvent par un refus à @everyone et une autorisation à un rôle. */
export function categoryTrustPatch<T>(
  channel: {
    parentId: string | null;
    parent: { permissionsFor(target: T): { bitfield: bigint } | null } | null;
  },
  target: T | null | undefined,
): Record<string, true> | null {
  // Cible introuvable : refuser en premier, sinon une cible nulle serait tout accordée.
  if (!target) return null;
  if (channel.parentId && !channel.parent) return null;
  if (!channel.parent) return trustPermissionPatch(null);

  const effective = channel.parent.permissionsFor(target);
  return effective ? trustPermissionPatch(effective.bitfield) : null;
}

/** Depuis que la création n'accorde plus `SendMessages` au propriétaire hors verrouillage,
 *  un bouton qui ferme le chat à @everyone doit le lui poser, sinon il devient muet chez
 *  lui. À la réouverture, il rend le droit à la catégorie : garder l'autorisation nommée
 *  referait du propriétaire le seul à écrire. Un refus nommé de la catégorie l'emporte. */
export function ownerChatPatch(
  closing: boolean,
  categoryOverwrite?: OverwriteBits | null,
): Record<string, boolean | null> {
  const restored = restoreFromCategory({ SendMessages: null }, categoryOverwrite);
  if (!closing || restored.SendMessages === false) return restored;
  return { SendMessages: true };
}

/** Le sortant redevient un membre ordinaire : il retrouve ce que la catégorie lui
 *  réserve. Garder une surcharge nominative laisserait un ancien propriétaire dans un
 *  salon verrouillé, sans bouton pour l'en retirer. */
export function ownerRevokedPermissions(categoryOverwrite?: OverwriteBits | null): Record<string, boolean | null> {
  return restoreFromCategory({
    ViewChannel: null,
    Connect: null,
    Speak: null,
    SendMessages: null,
    ReadMessageHistory: null,
    MuteMembers: null,
    DeafenMembers: null,
    MoveMembers: null,
    ManageChannels: null,
    ManageMessages: null,
  }, categoryOverwrite);
}

/** Pouvoirs lisibles dans une surcharge déjà posée : ce qu'un transfert reconduit. */
export function ownerPowersFromBits(allow: bigint): TempVoiceOwnerPower[] {
  return TEMP_VOICE_OWNER_POWERS.filter((power) => (allow & OWNER_POWER_BITS[power]) === OWNER_POWER_BITS[power]);
}

/** Reprend ce que la création accorde, sinon un salon au chat fermé laisse son
 *  nouveau propriétaire muet. Même règle qu'à la création : seul un refus que la
 *  catégorie pose nommément sur la cible l'emporte. Les droits effectifs ne
 *  conviennent pas, un membre ordinaire n'y a jamais « Rendre muet ». */
export function ownerPermissionPatch(
  powers: TempVoiceOwnerPower[],
  categoryOverwrite?: OverwriteBits | null,
): Record<string, boolean | null> {
  const denied = categoryOverwrite ? toBigInt(categoryOverwrite.deny) : 0n;
  const grantable = (bit: bigint): boolean => (denied & bit) !== bit;

  const patch: Record<string, boolean | null> = {
    ViewChannel: grantable(PermissionFlagsBits.ViewChannel),
    Connect: grantable(PermissionFlagsBits.Connect),
    Speak: grantable(PermissionFlagsBits.Speak),
    SendMessages: grantable(PermissionFlagsBits.SendMessages),
    ReadMessageHistory: grantable(PermissionFlagsBits.ReadMessageHistory),
  };

  const granted = new Set(powers);
  const keys: Record<TempVoiceOwnerPower, string> = {
    mute: 'MuteMembers',
    deafen: 'DeafenMembers',
    move: 'MoveMembers',
    manageChannel: 'ManageChannels',
    manageMessages: 'ManageMessages',
  };

  for (const power of TEMP_VOICE_OWNER_POWERS) {
    const bit = OWNER_POWER_BITS[power];
    patch[keys[power]] = granted.has(power) ? grantable(bit) : categoryValue(categoryOverwrite, bit);
  }

  return patch;
}

/** Longueur ramenée à 100 caractères : ce que Discord accepte pour un nom de salon. */
export function renderChannelName(template: string, displayName: string): string {
  // Fonction de remplacement et non chaîne : `String.replace` interprète `$&` et
  // `$1`, qu'un pseudo contenant ces séquences corromprait.
  const rendered = (template || DEFAULT_NAME_TEMPLATE).replace(/\{user\}/g, () => displayName);
  const trimmed = rendered.trim();
  // Un gabarit réduit à « {user} » avec un pseudo vide donnerait un nom vide, que Discord refuse.
  const fallback = DEFAULT_NAME_TEMPLATE.replace('{user}', () => displayName).trim();
  return (trimmed || fallback || 'Salon temporaire').slice(0, 100);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Refonte du panneau de gestion (maquette « panneau-vocal-kotbo »).
 *
 * Tout ce qui suit est pur : aucun client Discord, aucune lecture d'horloge,
 * aucun accès base. Le temps est toujours un paramètre — un test qui doit
 * attendre dix minutes n'est pas un test.
 * ═══════════════════════════════════════════════════════════════════════════ */

// ─────────────────────────────────────────────────────────────────────────────
// 1. Les quatre modes d'écriture
// ─────────────────────────────────────────────────────────────────────────────

/** Ordre du menu déroulant de la maquette, pas l'ordre alphabétique. */
export const MODES_ECRITURE = ['everyone', 'inVoice', 'ownerOnly', 'nobody'] as const;
export type ModeEcriture = (typeof MODES_ECRITURE)[number];

/** Un salon sans réglage explicite suit sa catégorie, ce que le panneau nomme « Tout le monde ». */
export const MODE_ECRITURE_PAR_DEFAUT: ModeEcriture = 'everyone';

export interface LibelleModeEcriture {
  /** Ce que porte l'option du menu. */
  libelle: string;
  /** La ligne d'explication sous l'option. */
  description: string;
  emoji?: string;
}

/** Libellés repris un pour un de la maquette : c'est elle qui fait foi. */
export const LIBELLES_MODES_ECRITURE: Readonly<Record<ModeEcriture, LibelleModeEcriture>> = {
  everyone: {
    emoji: '🌍',
    libelle: 'Tout le monde',
    description: "N'importe qui voyant le salon peut écrire.",
  },
  inVoice: {
    libelle: 'Ceux qui sont en vocal',
    description: "Le chat suit la pièce : on écrit tant qu'on est connecté.",
  },
  ownerOnly: {
    libelle: 'Moi seul',
    description: "Personne d'autre ne peut écrire.",
  },
  nobody: {
    libelle: 'Personne',
    description: "Y compris moi. Le salon devient un mur d'affichage.",
  },
};

export function estModeEcriture(value: unknown): value is ModeEcriture {
  return MODES_ECRITURE.includes(value as ModeEcriture);
}

/** Personne d'autre ne valide ce que le dashboard écrit. Une valeur inconnue
 *  retombe sur « Tout le monde », qui est le comportement historique d'un salon
 *  sans réglage — et non un mode plus fermé qu'on n'a pas demandé. */
export function normaliserModeEcriture(value: unknown): ModeEcriture {
  return estModeEcriture(value) ? value : MODE_ECRITURE_PAR_DEFAUT;
}

/** Pont vers l'ancien réglage à trois valeurs, tant que la base ne porte pas les
 *  quatre modes (colonne à ajouter côté `packages/database`). `inherit` n'est pas
 *  un mode : le salon suit sa catégorie, ce que le panneau affiche « Tout le monde ». */
export function modeEcritureDepuisTextChat(textChat: TempVoiceTextChatMode): ModeEcriture {
  return textChat === 'locked' ? 'ownerOnly' : 'everyone';
}

/** Repli dans l'autre sens : `inVoice` et `nobody` refusent tous deux @everyone,
 *  donc ils se rangent sous `locked`. Une base restée à trois valeurs garde ainsi
 *  un salon fermé fermé — jamais l'inverse. */
export function textChatDepuisModeEcriture(mode: ModeEcriture): TempVoiceTextChatMode {
  return mode === 'everyone' ? 'open' : 'locked';
}

export interface SurchargesModeEcriture {
  /** À poser sur le rôle @everyone du serveur. */
  everyone: Record<string, boolean | null>;
  /** À poser sur le propriétaire du salon. */
  proprietaire: Record<string, boolean | null>;
  /** Le mode se tient à jour aux entrées et sorties du vocal (voir § 5). */
  suitLaPresence: boolean;
}

/**
 * Les deux surcharges qu'un mode d'écriture demande. Le propriétaire n'est pas
 * déductible du patch @everyone : « Moi seul » doit lui rendre l'écriture que
 * @everyone perd, et « Personne » doit la lui retirer aussi.
 *
 * `ownerChatPatch` existe déjà et porte la règle du propriétaire jamais muet
 * chez lui : il est appelé, pas réécrit.
 */
export function surchargesModeEcriture(
  mode: ModeEcriture,
  categorieEveryone?: OverwriteBits | null,
  categorieProprietaire?: OverwriteBits | null,
): SurchargesModeEcriture {
  switch (mode) {
    case 'everyone':
      return {
        everyone: restoreFromCategory(CHANNEL_PATCHES.everyone, categorieEveryone),
        proprietaire: ownerChatPatch(false, categorieProprietaire),
        suitLaPresence: false,
      };
    case 'ownerOnly':
      return {
        everyone: { ...CHANNEL_PATCHES.ownerOnly },
        proprietaire: ownerChatPatch(true, categorieProprietaire),
        suitLaPresence: false,
      };
    case 'nobody':
      // Le seul cas où le propriétaire est coupé nommément : un refus posé sur
      // le membre prime sur tout, c'est ce qui fait la différence avec « Moi seul ».
      return {
        everyone: { ...CHANNEL_PATCHES.nobody },
        proprietaire: { SendMessages: false },
        suitLaPresence: false,
      };
    case 'inVoice':
      // Le propriétaire redevient un membre ordinaire pour ce bit : sa présence
      // lui rend l'écriture comme aux autres, son départ la lui retire. Lui
      // laisser un `allow` nommé ferait de `inVoice` un `ownerOnly` déguisé.
      return {
        everyone: { ...CHANNEL_PATCHES.inVoice },
        proprietaire: ownerChatPatch(false, categorieProprietaire),
        suitLaPresence: true,
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Le quota de renommage
// ─────────────────────────────────────────────────────────────────────────────

/** Discord plafonne le renommage d'un salon à deux par tranche de dix minutes. */
export const RENOMMAGES_PAR_FENETRE = 2;
export const FENETRE_RENOMMAGE_MS = 10 * 60 * 1000;

export interface QuotaRenommage {
  restants: number;
  /** Instant où un renommage redevient possible ; `null` s'il l'est déjà. */
  libereA: number | null;
}

/**
 * Au-delà du quota, Discord ne renvoie pas d'erreur : il met la requête en
 * attente jusqu'à la fin de la fenêtre, parfois plusieurs minutes, sans rien
 * dire. Le bouton doit donc se griser avec le décompte plutôt que de laisser
 * croire à un blocage.
 */
export function quotaRenommage(historique: readonly number[], maintenant: number): QuotaRenommage {
  const debut = maintenant - FENETRE_RENOMMAGE_MS;
  // Un renommage vieux d'exactement dix minutes est sorti de la fenêtre.
  const fenetre = historique
    .filter((instant) => Number.isFinite(instant) && instant > debut)
    .sort((a, b) => a - b);

  const restants = Math.max(0, RENOMMAGES_PAR_FENETRE - fenetre.length);
  if (restants > 0) return { restants, libereA: null };

  // Il faut que tout sauf `RENOMMAGES_PAR_FENETRE - 1` renommages soit sorti de
  // la fenêtre. L'historique étant trié, c'est celui-là qui bloque — et non le
  // plus ancien, qui serait faux dès qu'il y a plus d'entrées que le quota.
  const bloquant = fenetre[fenetre.length - RENOMMAGES_PAR_FENETRE] as number;
  return { restants: 0, libereA: bloquant + FENETRE_RENOMMAGE_MS };
}

/** L'historique d'un salon ne doit pas grossir sans fin : hors fenêtre, une date
 *  ne pèse plus sur aucun calcul. */
export function historiqueRenommageElague(
  historique: readonly number[],
  maintenant: number,
): number[] {
  const debut = maintenant - FENETRE_RENOMMAGE_MS;
  return historique
    .filter((instant) => Number.isFinite(instant) && instant > debut)
    .sort((a, b) => a - b);
}

/** Rend un nouvel historique : l'appelant décide de le persister. */
export function enregistrerRenommage(historique: readonly number[], maintenant: number): number[] {
  return historiqueRenommageElague([...historique, maintenant], maintenant);
}

/** « ✏️ Renommer (2/2) » au repos, « ✏️ Renommer (0/2 · 6 min) » une fois épuisé. */
export function libelleRenommer(quota: QuotaRenommage, maintenant: number): string {
  if (quota.restants > 0) return `✏️ Renommer (${quota.restants}/${RENOMMAGES_PAR_FENETRE})`;
  const reste = Math.max(0, (quota.libereA ?? maintenant) - maintenant);
  // Arrondi au-dessus : annoncer « 0 min » sur un bouton grisé serait un mensonge.
  const minutes = Math.max(1, Math.ceil(reste / 60_000));
  return `✏️ Renommer (0/${RENOMMAGES_PAR_FENETRE} · ${minutes} min)`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Le registre des demandes d'accès
// ─────────────────────────────────────────────────────────────────────────────

export const EXPIRATION_DEMANDE_MS = 10 * 60 * 1000;
export const SILENCE_APRES_REFUS_MS = 10 * 60 * 1000;

/** `guildId:channelId:userId` — les trois sont des snowflakes, aucun ne peut
 *  contenir le séparateur : la clé est sans ambiguïté et son préfixe identifie
 *  le salon, ce dont dépendent les purges. */
export function cleMembreSalon(guildId: string, channelId: string, userId: string): string {
  return `${guildId}:${channelId}:${userId}`;
}

/** Même clé, nommée pour le registre des demandes. */
export const cleDemandeAcces = cleMembreSalon;

export interface DemandeAcces {
  guildId: string;
  channelId: string;
  userId: string;
  demandeeA: number;
  expireA: number;
}

export type ResultatDemandeAcces =
  | { statut: 'enregistree'; demande: DemandeAcces }
  /** Un second clic ne renvoie rien : il répond que la demande est déjà en attente. */
  | { statut: 'dejaEnAttente'; demande: DemandeAcces; resteMs: number }
  /** Refusé récemment : le bouton annonce le temps restant. */
  | { statut: 'silence'; libereA: number; resteMs: number };

export type DecisionDemande = 'acceptee' | 'refusee';

export interface ResultatDecisionDemande {
  /** La demande qui était en attente, `null` si elle avait déjà expiré. */
  demande: DemandeAcces | null;
  /** Fin du silence posé par un refus, `null` sur une acceptation. */
  silenceJusquA: number | null;
}

/** Qui a le droit de trancher une demande d'accès, colonne `responders`. */
export const REPONDEURS_DEMANDE = ['OWNER', 'OWNER_AND_STAFF'] as const;
export type RepondeurDemande = (typeof REPONDEURS_DEMANDE)[number];

/** Où le propriétaire est prévenu en priorité, colonne `notifyVia`. */
export const CANAUX_NOTIFICATION = ['VOICE', 'DM', 'CHANNEL'] as const;
export type CanalNotification = (typeof CANAUX_NOTIFICATION)[number];

/** La ligne `TempVoiceAccessRequestConfig`, traduite en ce dont le bot se sert. */
export interface ConfigDemandesAcces {
  /** Bouton « Demander l'accès » posé sur les salons verrouillés ou réservés. */
  activees: boolean;
  repondeurs: RepondeurDemande;
  canal: CanalNotification;
  /** Salon dédié, seulement utile quand `canal` vaut `CHANNEL`. */
  canalId: string | null;
  expirationMs: number;
  silenceMs: number;
}

/**
 * Les défauts du schéma, et non des défauts inventés ici.
 *
 * `activees: false` est celui qui compte : sans ligne en base, aucun bouton
 * n'apparaît — c'est le comportement d'avant la refonte. Un défaut permissif
 * poserait un bouton sur tous les salons verrouillés de tous les serveurs au
 * premier déploiement, sans que personne l'ait demandé.
 */
export const CONFIG_DEMANDES_PAR_DEFAUT: ConfigDemandesAcces = {
  activees: false,
  repondeurs: 'OWNER_AND_STAFF',
  canal: 'VOICE',
  canalId: null,
  expirationMs: EXPIRATION_DEMANDE_MS,
  silenceMs: SILENCE_APRES_REFUS_MS,
};

/** Minutes hors de ces bornes = ligne corrompue ou formulaire contourné. */
const MINUTES_MIN = 1;
const MINUTES_MAX = 24 * 60;

function minutesEnMs(valeur: unknown, repli: number): number {
  if (typeof valeur !== 'number' || !Number.isFinite(valeur)) return repli;
  const bornees = Math.min(MINUTES_MAX, Math.max(MINUTES_MIN, Math.round(valeur)));
  return bornees * 60_000;
}

/**
 * Personne d'autre ne valide ce que le dashboard écrit. Chaque champ illisible
 * retombe sur le défaut du schéma, jamais sur un réglage plus ouvert qu'écrit :
 * un `responders` inconnu ne doit pas élargir qui peut trancher.
 */
export function normaliserConfigDemandes(raw: unknown): ConfigDemandesAcces {
  if (!raw || typeof raw !== 'object') return { ...CONFIG_DEMANDES_PAR_DEFAUT };
  const ligne = raw as Record<string, unknown>;

  const repondeurs = REPONDEURS_DEMANDE.includes(ligne.responders as RepondeurDemande)
    ? (ligne.responders as RepondeurDemande)
    : CONFIG_DEMANDES_PAR_DEFAUT.repondeurs;

  const canal = CANAUX_NOTIFICATION.includes(ligne.notifyVia as CanalNotification)
    ? (ligne.notifyVia as CanalNotification)
    : CONFIG_DEMANDES_PAR_DEFAUT.canal;

  const canalId = typeof ligne.notifyChannelId === 'string' && ligne.notifyChannelId.length > 0
    ? ligne.notifyChannelId
    : null;

  return {
    activees: ligne.enabled === true,
    repondeurs,
    // Un salon dédié promis sans identifiant n'est pas un salon dédié : le repli
    // vaut mieux qu'une cascade qui commence par une impasse.
    canal: canal === 'CHANNEL' && !canalId ? 'VOICE' : canal,
    canalId,
    expirationMs: minutesEnMs(ligne.requestExpiresMinutes, CONFIG_DEMANDES_PAR_DEFAUT.expirationMs),
    silenceMs: minutesEnMs(ligne.denyCooldownMinutes, CONFIG_DEMANDES_PAR_DEFAUT.silenceMs),
  };
}

/**
 * Qui peut accepter ou refuser. `peutAgir` ne le dit pas : l'action
 * `repondreDemande` n'est gouvernée par aucune ligne des réglages modérateur,
 * et c'est cette colonne-ci qui tranche.
 */
export function peutRepondreDemande(role: RoleAgissant, repondeurs: RepondeurDemande): VerdictAction {
  if (role === 'proprietaire') return { autorise: true };
  // Un admin garde la main : il peut déjà tout sur le salon, lui refuser la
  // carte de décision ferait un bouton mort plutôt qu'une limite.
  if (role === 'admin') return { autorise: true };
  if (repondeurs === 'OWNER_AND_STAFF') return { autorise: true };
  return {
    autorise: false,
    motif: 'adminsSeulement',
    raison: "Sur ce serveur, seul le propriétaire du salon répond aux demandes d'accès.",
  };
}

/**
 * L'ordre dans lequel tenter de prévenir le propriétaire, replis compris.
 *
 * Le MP n'est jamais seul : un membre peut fermer ses messages privés, l'envoi
 * échoue en silence et personne ne reçoit la demande. Chaque choix garde donc
 * au moins une issue derrière lui.
 */
export function ordreNotification(config: Pick<ConfigDemandesAcces, 'canal' | 'canalId'>): CanalNotification[] {
  switch (config.canal) {
    case 'DM':
      return ['DM', 'VOICE'];
    case 'CHANNEL':
      return config.canalId ? ['CHANNEL', 'VOICE', 'DM'] : ['VOICE', 'DM'];
    case 'VOICE':
      return ['VOICE', 'DM'];
  }
}

export interface OptionsRegistreDemandes {
  expirationMs?: number;
  silenceMs?: number;
}

/**
 * Sans garde-fou, un seul membre contrarié envoie trente pings au propriétaire
 * en dix secondes. Trois règles y suffisent, et elles vivent ici plutôt que
 * dans le gestionnaire de bouton : une demande en attente par personne et par
 * salon, dix minutes de silence après un refus, et une expiration.
 *
 * Aucune horloge n'est lue : chaque méthode reçoit l'instant. Rien n'est
 * persisté — un salon temporaire meurt, ses demandes avec lui (`oublierSalon`).
 */
export class RegistreDemandesAcces {
  readonly expirationMs: number;
  readonly silenceMs: number;

  private readonly enAttente = new Map<string, DemandeAcces>();
  /** clé → instant de fin du silence. */
  private readonly silences = new Map<string, number>();

  constructor(options: OptionsRegistreDemandes = {}) {
    this.expirationMs = options.expirationMs ?? EXPIRATION_DEMANDE_MS;
    this.silenceMs = options.silenceMs ?? SILENCE_APRES_REFUS_MS;
  }

  demander(
    guildId: string,
    channelId: string,
    userId: string,
    maintenant: number,
    delais?: OptionsRegistreDemandes,
  ): ResultatDemandeAcces {
    const cle = cleMembreSalon(guildId, channelId, userId);
    // Les délais sont ceux du serveur, pas ceux du registre : un seul registre
    // sert tous les serveurs, et chacun règle sa propre expiration.
    const expirationMs = delais?.expirationMs ?? this.expirationMs;

    const libereA = this.silences.get(cle);
    if (libereA !== undefined) {
      if (libereA > maintenant) return { statut: 'silence', libereA, resteMs: libereA - maintenant };
      this.silences.delete(cle);
    }

    const existante = this.enAttente.get(cle);
    if (existante) {
      if (existante.expireA > maintenant) {
        return { statut: 'dejaEnAttente', demande: existante, resteMs: existante.expireA - maintenant };
      }
      // Expirée : elle ne bloque plus, et le demandeur repart de zéro.
      this.enAttente.delete(cle);
    }

    const demande: DemandeAcces = {
      guildId,
      channelId,
      userId,
      demandeeA: maintenant,
      expireA: maintenant + expirationMs,
    };
    this.enAttente.set(cle, demande);
    return { statut: 'enregistree', demande };
  }

  /** La demande en attente, ou `null` si elle n'existe pas ou a expiré. */
  demandeEnAttente(
    guildId: string,
    channelId: string,
    userId: string,
    maintenant: number,
  ): DemandeAcces | null {
    const cle = cleMembreSalon(guildId, channelId, userId);
    const demande = this.enAttente.get(cle);
    if (!demande) return null;
    if (demande.expireA <= maintenant) {
      this.enAttente.delete(cle);
      return null;
    }
    return demande;
  }

  /** Vrai tant que le refus précédent vaut silence. */
  estEnSilence(guildId: string, channelId: string, userId: string, maintenant: number): boolean {
    const libereA = this.silences.get(cleMembreSalon(guildId, channelId, userId));
    return libereA !== undefined && libereA > maintenant;
  }

  /** Un refus vaut dix minutes de silence, qu'une demande ait été trouvée ou non :
   *  le propriétaire a tranché, et le lui faire trancher deux fois serait du bruit. */
  resoudre(
    guildId: string,
    channelId: string,
    userId: string,
    decision: DecisionDemande,
    maintenant: number,
    delais?: OptionsRegistreDemandes,
  ): ResultatDecisionDemande {
    const cle = cleMembreSalon(guildId, channelId, userId);
    const demande = this.demandeEnAttente(guildId, channelId, userId, maintenant);
    this.enAttente.delete(cle);

    if (decision === 'refusee') {
      const silenceJusquA = maintenant + (delais?.silenceMs ?? this.silenceMs);
      this.silences.set(cle, silenceJusquA);
      return { demande, silenceJusquA };
    }

    // Une acceptation efface le silence d'un refus antérieur : la personne entre.
    this.silences.delete(cle);
    return { demande, silenceJusquA: null };
  }

  /** Les demandes encore vivantes d'un salon, les expirées étant purgées au passage. */
  demandesDuSalon(guildId: string, channelId: string, maintenant: number): DemandeAcces[] {
    const vivantes: DemandeAcces[] = [];
    for (const [cle, demande] of [...this.enAttente]) {
      if (demande.guildId !== guildId || demande.channelId !== channelId) continue;
      if (demande.expireA <= maintenant) {
        this.enAttente.delete(cle);
        continue;
      }
      vivantes.push(demande);
    }
    return vivantes.sort((a, b) => a.demandeeA - b.demandeeA);
  }

  /** Mort du salon : demandes ET silences disparaissent, sans laisser de ligne orpheline. */
  oublierSalon(guildId: string, channelId: string): number {
    const prefixe = `${guildId}:${channelId}:`;
    let retires = 0;
    for (const cle of [...this.enAttente.keys()]) {
      if (cle.startsWith(prefixe)) {
        this.enAttente.delete(cle);
        retires += 1;
      }
    }
    for (const cle of [...this.silences.keys()]) {
      if (cle.startsWith(prefixe)) {
        this.silences.delete(cle);
        retires += 1;
      }
    }
    return retires;
  }

  /** Balayage périodique : sans lui, un salon disparu sans `oublierSalon` fuirait. */
  purger(maintenant: number): number {
    let retires = 0;
    for (const [cle, demande] of [...this.enAttente]) {
      if (demande.expireA <= maintenant) {
        this.enAttente.delete(cle);
        retires += 1;
      }
    }
    for (const [cle, libereA] of [...this.silences]) {
      if (libereA <= maintenant) {
        this.silences.delete(cle);
        retires += 1;
      }
    }
    return retires;
  }

  /**
   * Ce qu'il faut réécrire en base pour ce salon : les demandes encore vivantes
   * et les silences non expirés, rien de plus.
   *
   * Exporter ce qui a expiré ferait grossir la ligne sans fin et ressusciterait
   * au démarrage des silences que le temps avait levés.
   */
  exporterSalon(guildId: string, channelId: string, maintenant: number): EtatDemandesSalon {
    const prefixe = `${guildId}:${channelId}:`;

    const demandes = [...this.enAttente.entries()]
      .filter(([cle, demande]) => cle.startsWith(prefixe) && demande.expireA > maintenant)
      .map(([, demande]) => ({
        userId: demande.userId,
        demandeeA: demande.demandeeA,
        expireA: demande.expireA,
      }));

    const silences = [...this.silences.entries()]
      .filter(([cle, libereA]) => cle.startsWith(prefixe) && libereA > maintenant)
      .map(([cle, libereA]) => ({ userId: cle.slice(prefixe.length), libereA }));

    return { demandes, silences };
  }

  /**
   * Recharge l'état d'un salon après un redémarrage.
   *
   * Ce qui a expiré pendant l'arrêt n'est pas rechargé : le temps a continué de
   * passer sans le bot, et un silence de dix minutes ne se remet pas à courir
   * parce que le processus a redémarré.
   */
  importerSalon(guildId: string, channelId: string, brut: unknown, maintenant: number): void {
    const etat = normaliserEtatDemandes(brut);

    for (const demande of etat.demandes) {
      if (demande.expireA <= maintenant) continue;
      this.enAttente.set(cleMembreSalon(guildId, channelId, demande.userId), {
        guildId,
        channelId,
        userId: demande.userId,
        demandeeA: demande.demandeeA,
        expireA: demande.expireA,
      });
    }

    for (const silence of etat.silences) {
      if (silence.libereA <= maintenant) continue;
      this.silences.set(cleMembreSalon(guildId, channelId, silence.userId), silence.libereA);
    }
  }

  /** Pour les tests et la supervision : ce que le registre garde en mémoire. */
  get taille(): { demandes: number; silences: number } {
    return { demandes: this.enAttente.size, silences: this.silences.size };
  }
}

export interface EtatDemandesSalon {
  demandes: Array<{ userId: string; demandeeA: number; expireA: number }>;
  silences: Array<{ userId: string; libereA: number }>;
}

/** Un instant plausible : ni absent, ni hors de l'échelle des millisecondes. */
function estInstant(valeur: unknown): valeur is number {
  return typeof valeur === 'number' && Number.isFinite(valeur) && valeur > 0;
}

/**
 * Ce qui revient de la base est une colonne JSON : personne ne l'a validé, et
 * une ligne ecrite par une version anterieure peut avoir n'importe quelle forme.
 * Tout ce qui n'est pas exploitable est ignoré, jamais devine.
 */
export function normaliserEtatDemandes(brut: unknown): EtatDemandesSalon {
  const vide: EtatDemandesSalon = { demandes: [], silences: [] };
  if (!brut || typeof brut !== 'object') return vide;

  const ligne = brut as { demandes?: unknown; silences?: unknown };

  const demandes = Array.isArray(ligne.demandes)
    ? ligne.demandes
      .map((entree) => entree as Record<string, unknown>)
      .filter((entree) => typeof entree?.userId === 'string' && entree.userId.length > 0)
      .filter((entree) => estInstant(entree.demandeeA) && estInstant(entree.expireA))
      .map((entree) => ({
        userId: entree.userId as string,
        demandeeA: entree.demandeeA as number,
        expireA: entree.expireA as number,
      }))
    : [];

  const silences = Array.isArray(ligne.silences)
    ? ligne.silences
      .map((entree) => entree as Record<string, unknown>)
      .filter((entree) => typeof entree?.userId === 'string' && entree.userId.length > 0)
      .filter((entree) => estInstant(entree.libereA))
      .map((entree) => ({ userId: entree.userId as string, libereA: entree.libereA as number }))
    : [];

  return { demandes, silences };
}

/**
 * L'historique de renommage relu depuis la base.
 *
 * Les instants aberrants sont ecartes plutot que corriges : un horodatage dans
 * le futur bloquerait le bouton pour toujours, et le quota se reconstitue de
 * lui-meme en dix minutes.
 */
export function normaliserHistoriqueRenommage(brut: unknown, maintenant: number): number[] {
  if (!Array.isArray(brut)) return [];
  return brut
    .filter((valeur): valeur is number => estInstant(valeur))
    .filter((instant) => instant <= maintenant)
    .sort((a, b) => a - b)
    .slice(-RENOMMAGES_PAR_FENETRE * 2);
}

/**
 * « Demander l'accès » n'existe que lorsqu'il sert : un salon simplement plein,
 * c'est une place qui manque, pas une permission.
 *
 * Et il n'existe pas du tout tant qu'un administrateur ne l'a pas activé. Le
 * paramètre n'a pas de valeur par défaut à dessein : un appelant qui l'oublie
 * poserait le bouton sur des serveurs qui n'en ont jamais voulu.
 */
export function boutonDemanderAccesVisible(
  etat: { verrouille: boolean; reserve: boolean },
  config: Pick<ConfigDemandesAcces, 'activees'>,
): boolean {
  if (!config.activees) return false;
  return etat.verrouille || etat.reserve;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. La matrice de permissions
// ─────────────────────────────────────────────────────────────────────────────

export const ROLES_AGISSANTS = ['proprietaire', 'moderateur', 'admin'] as const;
export type RoleAgissant = (typeof ROLES_AGISSANTS)[number];

/** Les lignes de l'onglet « Ce que les modérateurs peuvent faire ». */
export const REGLAGES_MODERATEUR = [
  'renommer',
  'limite',
  'verrouiller',
  'modeEcriture',
  'reserver',
  'expulserBannir',
  'transferer',
] as const;
export type ReglageModerateur = (typeof REGLAGES_MODERATEUR)[number];

export type PermissionModerateur = 'autorise' | 'adminsSeulement';
export type ReglagesAdmin = Record<ReglageModerateur, PermissionModerateur>;

/** Aujourd'hui un membre du staff a accès à tous les boutons de tous les panneaux :
 *  le défaut reproduit ce comportement. La refonte pose des limites là où il n'y en
 *  a aucune — elle n'en retire aucune sans qu'un admin l'ait demandé. */
export function reglagesAdminParDefaut(): ReglagesAdmin {
  return Object.fromEntries(REGLAGES_MODERATEUR.map((reglage) => [reglage, 'autorise'])) as ReglagesAdmin;
}

/** Le dashboard écrit ce JSON, personne d'autre ne le valide. `false` vaut
 *  « admins seulement » pour tolérer un encodage booléen. */
export function normaliserReglagesAdmin(raw: unknown): ReglagesAdmin {
  const reglages = reglagesAdminParDefaut();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return reglages;
  const source = raw as Record<string, unknown>;

  for (const reglage of REGLAGES_MODERATEUR) {
    const value = source[reglage];
    if (value === 'adminsSeulement' || value === false) reglages[reglage] = 'adminsSeulement';
    else if (value === 'autorise' || value === true) reglages[reglage] = 'autorise';
  }
  return reglages;
}

export const ACTIONS_PANNEAU = [
  'renommer',
  'limite',
  'verrouiller',
  'modeEcriture',
  'reserver',
  'expulser',
  'bannir',
  'autoriser',
  'transferer',
  'recuperer',
  'demanderAcces',
  'repondreDemande',
] as const;
export type ActionPanneau = (typeof ACTIONS_PANNEAU)[number];

/** Quelle ligne des réglages admin gouverne quelle action. `null` = aucune ligne
 *  ne la gouverne, un modérateur la garde donc toujours. */
const REGLAGE_PAR_ACTION: Readonly<Record<ActionPanneau, ReglageModerateur | null>> = {
  renommer: 'renommer',
  limite: 'limite',
  verrouiller: 'verrouiller',
  modeEcriture: 'modeEcriture',
  reserver: 'reserver',
  // Une seule ligne « Expulser / bannir » gouverne les deux actions.
  expulser: 'expulserBannir',
  bannir: 'expulserBannir',
  autoriser: null,
  transferer: 'transferer',
  recuperer: null,
  demanderAcces: null,
  repondreDemande: null,
};

interface SujetReglage {
  sujet: string;
  genre: 'm' | 'f' | 'pluriel';
}

/** De quoi écrire la phrase de la maquette : « Le mode d'écriture et la
 *  réservation sont réservés aux admins sur ce serveur. » */
const SUJETS_REGLAGES: Readonly<Record<ReglageModerateur, SujetReglage>> = {
  renommer: { sujet: 'le renommage', genre: 'm' },
  limite: { sujet: 'la limite de places', genre: 'f' },
  verrouiller: { sujet: 'le verrouillage', genre: 'm' },
  modeEcriture: { sujet: "le mode d'écriture", genre: 'm' },
  reserver: { sujet: 'la réservation', genre: 'f' },
  expulserBannir: { sujet: "l'expulsion et le bannissement", genre: 'pluriel' },
  transferer: { sujet: 'le transfert de propriété', genre: 'm' },
};

function majuscule(texte: string): string {
  return texte.charAt(0).toUpperCase() + texte.slice(1);
}

/** Une seule phrase pour tout ce qu'un modérateur n'a pas le droit de toucher :
 *  la maquette en affiche une, pas une par bouton. */
export function raisonAdminsSeulement(reglages: readonly ReglageModerateur[]): string {
  // On repart de l'ordre canonique : deux appels avec les mêmes réglages dans un
  // ordre différent ne doivent pas produire deux phrases différentes.
  const uniques = REGLAGES_MODERATEUR.filter((reglage) => reglages.includes(reglage));
  if (uniques.length === 0) return '';

  const sujets = uniques.map((reglage) => SUJETS_REGLAGES[reglage].sujet);
  const liste =
    sujets.length === 1
      ? (sujets[0] as string)
      : `${sujets.slice(0, -1).join(', ')} et ${sujets[sujets.length - 1] as string}`;

  const premier = SUJETS_REGLAGES[uniques[0] as ReglageModerateur];
  const pluriel = uniques.length > 1 || premier.genre === 'pluriel';
  const verbe = pluriel ? 'sont réservés' : premier.genre === 'f' ? 'est réservée' : 'est réservé';

  return `${majuscule(liste)} ${verbe} aux admins sur ce serveur.`;
}

/** Ce qu'un modérateur ne peut pas toucher sur ce serveur, pour l'encart unique. */
export function reglagesVerrouilles(reglagesAdmin: unknown): ReglageModerateur[] {
  const reglages = normaliserReglagesAdmin(reglagesAdmin);
  return REGLAGES_MODERATEUR.filter((reglage) => reglages[reglage] === 'adminsSeulement');
}

export type MotifRefus =
  | 'adminsSeulement'
  | 'dejaProprietaire'
  | 'cibleStaff'
  | 'cibleHorsSalon'
  | 'cibleSoiMeme'
  | 'cibleDejaProprietaire';

export type VerdictAction =
  | { autorise: true }
  | { autorise: false; motif: MotifRefus; raison: string };

const AUTORISE: VerdictAction = { autorise: true };

function refus(motif: MotifRefus, raison: string): VerdictAction {
  return { autorise: false, motif, raison };
}

/**
 * Qui a le droit de faire quoi. Le refus porte toujours sa raison : la maquette
 * grise le bouton avec son motif, au lieu de laisser découvrir l'interdiction
 * après le clic.
 *
 * `reglagesAdmin` n'a pas de valeur par défaut à dessein : un appelant qui
 * l'oublierait obtiendrait silencieusement un panneau tout permis.
 */
export function peutAgir(
  role: RoleAgissant,
  action: ActionPanneau,
  reglagesAdmin: unknown,
): VerdictAction {
  if (role === 'proprietaire') {
    // Jamais un bouton mort : chez lui, ces deux-là n'ont pas de sens.
    if (action === 'recuperer') return refus('dejaProprietaire', 'Tu es déjà propriétaire de ce salon.');
    if (action === 'demanderAcces') return refus('dejaProprietaire', 'Tu es déjà chez toi dans ce salon.');
    return AUTORISE;
  }

  if (role === 'admin') return AUTORISE;

  // Les réglages disent ce que les *modérateurs* peuvent faire : ils ne
  // s'appliquent ni au propriétaire chez lui, ni à un admin.
  const reglage = REGLAGE_PAR_ACTION[action];
  if (!reglage) return AUTORISE;

  const reglages = normaliserReglagesAdmin(reglagesAdmin);
  if (reglages[reglage] === 'adminsSeulement') {
    return refus('adminsSeulement', raisonAdminsSeulement([reglage]));
  }
  return AUTORISE;
}

export interface CibleMembre {
  /** Nom affiché : la maquette nomme la personne dans la raison. */
  nom?: string;
  estStaff: boolean;
  estProprietaire: boolean;
  /** La cible est celle qui clique. */
  estSoiMeme: boolean;
  dansLeSalon: boolean;
  /** Une autorisation nominative lui a déjà été donnée. */
  autorise: boolean;
}

function designation(cible: CibleMembre): string {
  return cible.nom ?? 'Cette personne';
}

/**
 * La matrice ci-dessus dit ce que le rôle permet ; celle-ci dit ce que la cible
 * permet. Les deux sont nécessaires : « Bob fait partie du staff » n'a rien à
 * voir avec qui clique.
 */
export function peutAgirSurCible(
  role: RoleAgissant,
  action: ActionPanneau,
  reglagesAdmin: unknown,
  cible: CibleMembre,
): VerdictAction {
  const verdict = peutAgir(role, action, reglagesAdmin);
  if (!verdict.autorise) return verdict;

  if (action === 'expulser' || action === 'bannir') {
    if (cible.estSoiMeme) {
      return refus(
        'cibleSoiMeme',
        action === 'expulser' ? "Tu ne peux pas t'expulser toi-même." : 'Tu ne peux pas te bannir toi-même.',
      );
    }
    if (cible.estStaff) {
      return refus(
        'cibleStaff',
        cible.nom
          ? `${cible.nom} fait partie du staff : il ne peut être ni expulsé ni banni.`
          : 'Cette personne fait partie du staff : elle ne peut être ni expulsée ni bannie.',
      );
    }
  }

  // Bannir quelqu'un qui n'est pas là a du sens — il ne verra plus le salon.
  // L'expulser, non.
  if (action === 'expulser' && !cible.dansLeSalon) {
    return refus('cibleHorsSalon', `${designation(cible)} n'est pas dans le salon.`);
  }

  // « Autoriser » et « Retirer l'acces » ecrivent une surcharge de confiance.
  // Le proprietaire, lui, tient son acces de SA surcharge de proprietaire :
  // « Retirer l'acces » ne lui retirait donc rien de visible, mais supprimait
  // au passage la surcharge qui porte ses droits. Un bouton qui n'a pas d'effet
  // utile et un effet de bord nuisible n'a pas a etre cliquable.
  if (action === 'autoriser' && cible.estProprietaire) {
    return refus(
      'cibleDejaProprietaire',
      cible.nom
        ? `${cible.nom} est propriétaire du salon : son accès ne vient pas d'une autorisation.`
        : "Cette personne est propriétaire du salon : son accès ne vient pas d'une autorisation.",
    );
  }

  if (action === 'transferer') {
    if (cible.estSoiMeme) {
      return refus('cibleSoiMeme', 'Tu ne peux pas te transférer le salon à toi-même.');
    }
    if (cible.estProprietaire) {
      return refus('cibleDejaProprietaire', `${designation(cible)} est déjà propriétaire du salon.`);
    }
  }

  return AUTORISE;
}

/** « Autoriser » et « Retirer l'accès » sont le même bouton : son libellé dit
 *  l'état, comme les bascules du panneau. */
export function libelleActionMembre(
  action: 'expulser' | 'bannir' | 'autoriser' | 'transferer',
  cible: CibleMembre,
): string {
  switch (action) {
    case 'expulser':
      return 'Expulser';
    case 'bannir':
      return 'Bannir';
    case 'autoriser':
      return cible.autorise ? "Retirer l'accès" : 'Autoriser';
    case 'transferer':
      return 'Lui donner le salon';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. L'origine des surcharges
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Discord n'a pas de permission « connecté au vocal » : le mode `inVoice` pose
 * une surcharge nominative à chaque entrée et la retire à chaque sortie. Le
 * point dur n'est pas la pose, c'est le retrait — « Autoriser » écrit le même
 * type de surcharge. Sans marquer l'origine, quitter le vocal efface une
 * autorisation explicite.
 *
 * Une personne ne porte qu'une origine par salon, et `autorisation` gagne
 * toujours : un droit donné à la main ne se dégrade jamais en présence.
 */
export const ORIGINES_SURCHARGE = ['presence', 'autorisation'] as const;
export type OrigineSurcharge = (typeof ORIGINES_SURCHARGE)[number];

/**
 * Ce qu'une surcharge de présence accorde : le droit d'écrire, rien d'autre.
 * « Autoriser » en accorde bien plus (`categoryTrustPatch`, qui donne toujours
 * `Connect`).
 *
 * En fonctionnement c'est le registre d'origines qui tranche, jamais la forme.
 * Au démarrage le registre est vide, et il ne reste que la forme — elle ne sert
 * que dans un sens, le seul qui soit sûr : accorder `SendMessages` **sans**
 * accorder `Connect`, aucune autorisation explicite ne le fait. Une surcharge de
 * cette forme ne peut donc venir que de la présence. L'inverse serait faux.
 */
export const PATCH_PRESENCE: Readonly<Record<string, boolean>> = { SendMessages: true };

/** Retirer une présence rend le bit à ce qui précède ; @everyone étant refusé en
 *  mode `inVoice`, la personne cesse d'écrire sans qu'on lui pose de refus nommé
 *  — un refus nommé, lui, survivrait à un changement de mode. */
export const PATCH_PRESENCE_RETIREE: Readonly<Record<string, null>> = { SendMessages: null };

export type DecisionSurcharge =
  | { action: 'poser'; origine: OrigineSurcharge; patch: Record<string, boolean | null> }
  | { action: 'retirer'; patch: Record<string, boolean | null> }
  | { action: 'conserver'; motif: 'autorisationExplicite' | 'dejaPosee' }
  | { action: 'aucune' };

/** Quelqu'un entre en vocal. */
export function decisionEntreeVocal(
  mode: ModeEcriture,
  origineActuelle: OrigineSurcharge | null,
): DecisionSurcharge {
  if (mode !== 'inVoice') return { action: 'aucune' };
  if (origineActuelle === 'autorisation') return { action: 'conserver', motif: 'autorisationExplicite' };
  if (origineActuelle === 'presence') return { action: 'conserver', motif: 'dejaPosee' };
  return { action: 'poser', origine: 'presence', patch: { ...PATCH_PRESENCE } };
}

/** Quelqu'un quitte le vocal. C'est ici que l'origine paie. */
export function decisionSortieVocal(
  mode: ModeEcriture,
  origineActuelle: OrigineSurcharge | null,
): DecisionSurcharge {
  // Le cas qui justifie tout le mécanisme : ne jamais effacer un droit donné à
  // la main, quel que soit le mode.
  if (origineActuelle === 'autorisation') return { action: 'conserver', motif: 'autorisationExplicite' };
  // Une marque de présence n'a de sens qu'en mode `inVoice`. Hors de ce mode
  // c'est un reste d'un mode précédent : à nettoyer plutôt qu'à garder.
  if (origineActuelle === 'presence') return { action: 'retirer', patch: { ...PATCH_PRESENCE_RETIREE } };
  return { action: 'aucune' };
}

/** « Retirer l'accès » sur quelqu'un qui est encore dans le vocal en mode
 *  `inVoice` : la surcharge reste, mais elle redevient de la présence — elle
 *  partira avec lui. La retirer ici le rendrait muet alors qu'il est présent,
 *  ce que le mode promet le contraire. */
export function decisionRetraitAutorisation(mode: ModeEcriture, estPresent: boolean): DecisionSurcharge {
  if (mode === 'inVoice' && estPresent) {
    return { action: 'poser', origine: 'presence', patch: { ...PATCH_PRESENCE } };
  }
  return { action: 'retirer', patch: { ...PATCH_PRESENCE_RETIREE } };
}

export interface TransitionModeEcriture {
  /** Personnes à qui poser une surcharge de présence, à marquer `presence`. */
  aPoser: string[];
  /** Personnes dont la surcharge de présence doit être retirée et démarquée. */
  aRetirer: string[];
}

/**
 * Changer de mode ne se contente pas de réécrire @everyone : entrer dans
 * `inVoice` demande de poser les présents, en sortir demande de retirer ce qui
 * ne sert plus. Les autorisations explicites ne bougent dans aucun sens.
 */
export function transitionModeEcriture(
  ancien: ModeEcriture,
  nouveau: ModeEcriture,
  presents: readonly string[],
  origines: ReadonlyMap<string, OrigineSurcharge>,
): TransitionModeEcriture {
  if (ancien === nouveau) return { aPoser: [], aRetirer: [] };

  if (nouveau === 'inVoice') {
    // Ceux qui portent déjà une marque ont déjà leur surcharge — y compris une
    // autorisation, qu'il ne faut surtout pas rétrograder en présence.
    const aPoser = [...new Set(presents)].filter((userId) => !origines.has(userId));
    return { aPoser, aRetirer: [] };
  }

  if (ancien === 'inVoice') {
    const aRetirer = [...origines.entries()]
      .filter(([, origine]) => origine === 'presence')
      .map(([userId]) => userId);
    return { aPoser: [], aRetirer };
  }

  return { aPoser: [], aRetirer: [] };
}

/** Une surcharge de membre telle qu'on la relit au démarrage. */
export interface SurchargeMembreLue {
  userId: string;
  /** `SendMessages` explicitement accordé. */
  accordeEcriture: boolean;
  /** `Connect` explicitement accordé — la signature d'une autorisation. */
  accordeConnexion: boolean;
}

export interface PlanNettoyagePresence {
  /** Surcharges de présence à retirer : ces personnes ne sont plus là. */
  aRetirer: string[];
  /** Surcharges de présence à réinscrire au registre : ces personnes sont là. */
  aMarquerPresence: string[];
}

/**
 * Ce qu'il faut réparer au démarrage sur un salon temporaire encore vivant.
 *
 * Le registre d'origines est en mémoire : après un redémarrage, les surcharges
 * de présence posées avant n'ont plus d'origine, et plus rien ne les retire
 * quand les gens quittent le vocal. Le salon affiche « Personne » pendant que
 * plusieurs membres écrivent encore.
 *
 * Hors du mode `inVoice`, une marque de présence est un reste d'un mode
 * précédent : elle part, exactement comme `decisionSortieVocal` la ferait
 * partir. C'est le cas du salon dont le mode a changé juste avant l'arrêt.
 */
export function nettoyagePresenceAuDemarrage(
  mode: ModeEcriture,
  surcharges: readonly SurchargeMembreLue[],
  presents: readonly string[],
): PlanNettoyagePresence {
  const presence = surcharges.filter((s) => s.accordeEcriture && !s.accordeConnexion);
  if (mode !== 'inVoice') {
    return { aRetirer: presence.map((s) => s.userId), aMarquerPresence: [] };
  }

  const ici = new Set(presents);
  return {
    aRetirer: presence.filter((s) => !ici.has(s.userId)).map((s) => s.userId),
    aMarquerPresence: presence.filter((s) => ici.has(s.userId)).map((s) => s.userId),
  };
}

/**
 * Qui doit perdre son droit d'écrire nominatif quand le mode change.
 *
 * Couper `@everyone` ne suffit pas : une surcharge nominative prime toujours
 * sur elle. Or « Autoriser » passe par `categoryTrustPatch`, qui accorde cinq
 * bits d'un coup — `SendMessages` compris. Sans ce ménage, « Personne » laissait
 * écrire tous ceux qui avaient été autorisés, et « Moi seul » voulait dire
 * « moi et mes invités ». Le libellé mentait.
 *
 * Les trois modes restrictifs possèdent donc ce bit sur les surcharges de
 * membres. Seul `inVoice` en épargne un, et seulement tant qu'il est connecté.
 *
 * On ne retire que le bit d'écriture : `Connect` et `ViewChannel` restent, donc
 * la personne reste autorisée à entrer. Et rendre le bit plutôt que le refuser
 * (`null`, pas `false`) fait qu'un retour à « Tout le monde » le lui redonne
 * sans qu'on ait rien mémorisé — ce qu'un refus nommé, lui, survivrait.
 */
export function membresAReduireAuSilence(
  mode: ModeEcriture,
  surcharges: readonly SurchargeMembreLue[],
  presents: readonly string[],
): string[] {
  if (mode === 'everyone') return [];
  const ici = new Set(presents);
  return surcharges
    .filter((surcharge) => surcharge.accordeEcriture)
    .filter((surcharge) => !(mode === 'inVoice' && ici.has(surcharge.userId)))
    .map((surcharge) => surcharge.userId);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. La réservation : à quels rôles, et que faire de ceux qui sont déjà là
// ─────────────────────────────────────────────────────────────────────────────

/** Ce que l'administration décide du sort des personnes déjà présentes. */
export const DECISIONS_DEBORDEMENT = ['ASK', 'NOTHING', 'MOVE', 'DISCONNECT'] as const;
export type DecisionDebordement = (typeof DECISIONS_DEBORDEMENT)[number];

export interface ConfigReservation {
  /** Vide = n'importe quel rôle du serveur, le comportement livré. */
  rolesReservables: string[];
  debordement: DecisionDebordement;
  salonDeRepli: string | null;
}

export const CONFIG_RESERVATION_PAR_DEFAUT: ConfigReservation = {
  rolesReservables: [],
  debordement: 'ASK',
  salonDeRepli: null,
};

/** Le plafond d'un menu Discord : au-delà, le bot ne pourrait pas les afficher. */
export const MAX_ROLES_RESERVABLES = 25;

/**
 * Ce que le dashboard écrit n'est validé par personne d'autre. Une valeur de
 * débordement inconnue retombe sur `ASK` — poser la question — et jamais sur
 * une valeur qui agit : un réglage corrompu ne doit déconnecter personne.
 */
export function normaliserConfigReservation(raw: unknown): ConfigReservation {
  if (!raw || typeof raw !== 'object') return { ...CONFIG_RESERVATION_PAR_DEFAUT, rolesReservables: [] };
  const ligne = raw as Record<string, unknown>;

  const roles = Array.isArray(ligne.reservableRoleIds)
    ? [...new Set(ligne.reservableRoleIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
      .slice(0, MAX_ROLES_RESERVABLES)
    : [];

  const debordement = DECISIONS_DEBORDEMENT.includes(ligne.reservationOverflow as DecisionDebordement)
    ? (ligne.reservationOverflow as DecisionDebordement)
    : CONFIG_RESERVATION_PAR_DEFAUT.debordement;

  const salon = typeof ligne.reservationFallbackChannelId === 'string'
    && ligne.reservationFallbackChannelId.length > 0
    ? ligne.reservationFallbackChannelId
    : null;

  return { rolesReservables: roles, debordement, salonDeRepli: salon };
}

/** Une personne présente, telle que le plan a besoin de la connaître. */
export interface PresentPourReservation {
  id: string;
  estBot: boolean;
  /** Les rôles qu'elle porte sur le serveur. */
  roles: ReadonlySet<string>;
}

/**
 * Qui, parmi les présents, n'a pas le rôle auquel le salon vient d'être réservé.
 *
 * Le propriétaire n'en fait jamais partie, quel que soit son rôle : réserver son
 * salon ne peut pas l'en éjecter. Les bots non plus — les déplacer ne règle
 * rien et casse ce qu'ils font.
 */
export function membresSansLeRole(
  presents: readonly PresentPourReservation[],
  roleId: string,
  proprietaireId: string,
): string[] {
  return presents
    .filter((membre) => !membre.estBot)
    .filter((membre) => membre.id !== proprietaireId)
    .filter((membre) => !membre.roles.has(roleId))
    .map((membre) => membre.id);
}

export type ActionDebordement = 'aucune' | 'demander' | 'deplacer' | 'deconnecter';

export interface PlanDebordement {
  action: ActionDebordement;
  /** Salon d'accueil, seulement pour « deplacer ». */
  salon: string | null;
  membres: string[];
  /** « Déplacer » demandé sans salon d'accueil : on déconnecte, et on le dit. */
  repliSurDeconnexion: boolean;
}

/**
 * Ce qu'il advient de ceux qui restent.
 *
 * Réserver ne déplaçait personne : les gens restaient dans un salon qu'ils
 * n'auraient plus eu le droit de rejoindre. Le plan est rendu ici, sans rien
 * exécuter, pour qu'on puisse l'éprouver sans toucher à Discord.
 *
 * Aucun concerné, aucune action — et surtout aucune question posée : demander
 * quoi faire de personne serait du bruit.
 */
export function planDebordement(
  config: ConfigReservation,
  concernes: readonly string[],
): PlanDebordement {
  const membres = [...concernes];
  if (membres.length === 0) return { action: 'aucune', salon: null, membres: [], repliSurDeconnexion: false };

  switch (config.debordement) {
    case 'NOTHING':
      return { action: 'aucune', salon: null, membres, repliSurDeconnexion: false };
    case 'ASK':
      return { action: 'demander', salon: config.salonDeRepli, membres, repliSurDeconnexion: false };
    case 'DISCONNECT':
      return { action: 'deconnecter', salon: null, membres, repliSurDeconnexion: false };
    case 'MOVE':
      // Un salon d'accueil absent ou supprimé ne doit pas annuler la décision en
      // silence : la personne part quand même, et le message le dit.
      return config.salonDeRepli
        ? { action: 'deplacer', salon: config.salonDeRepli, membres, repliSurDeconnexion: false }
        : { action: 'deconnecter', salon: null, membres, repliSurDeconnexion: true };
  }
}

/**
 * Qui porte quelle origine, par salon. Rien n'est persisté ici : un salon
 * temporaire meurt avec ses marques. Si la refonte doit survivre à un
 * redémarrage du bot, c'est une table côté `packages/database` — et non un
 * champ de plus sur la surcharge Discord, qui n'en accepte aucun.
 */
export class RegistreOriginesSurcharge {
  private readonly origines = new Map<string, OrigineSurcharge>();

  /** `presence` n'écrase jamais `autorisation` : c'est l'invariant du mécanisme,
   *  et il tient ici plutôt qu'à chaque site d'appel. */
  marquer(
    guildId: string,
    channelId: string,
    userId: string,
    origine: OrigineSurcharge,
  ): OrigineSurcharge {
    const cle = cleMembreSalon(guildId, channelId, userId);
    const actuelle = this.origines.get(cle);
    if (actuelle === 'autorisation' && origine === 'presence') return 'autorisation';
    this.origines.set(cle, origine);
    return origine;
  }

  origine(guildId: string, channelId: string, userId: string): OrigineSurcharge | null {
    return this.origines.get(cleMembreSalon(guildId, channelId, userId)) ?? null;
  }

  oublier(guildId: string, channelId: string, userId: string): boolean {
    return this.origines.delete(cleMembreSalon(guildId, channelId, userId));
  }

  /** userId → origine, ce qu'attend `transitionModeEcriture`. */
  originesDuSalon(guildId: string, channelId: string): Map<string, OrigineSurcharge> {
    const prefixe = `${guildId}:${channelId}:`;
    const resultat = new Map<string, OrigineSurcharge>();
    for (const [cle, origine] of this.origines) {
      if (cle.startsWith(prefixe)) resultat.set(cle.slice(prefixe.length), origine);
    }
    return resultat;
  }

  /** Mort du salon : les marques s'en vont avec lui. */
  oublierSalon(guildId: string, channelId: string): number {
    const prefixe = `${guildId}:${channelId}:`;
    let retires = 0;
    for (const cle of [...this.origines.keys()]) {
      if (cle.startsWith(prefixe)) {
        this.origines.delete(cle);
        retires += 1;
      }
    }
    return retires;
  }

  get taille(): number {
    return this.origines.size;
  }
}
