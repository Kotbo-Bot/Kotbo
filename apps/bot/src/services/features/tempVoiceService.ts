/**
 * Regles de creation des salons vocaux temporaires.
 *
 * Les permissions posees sur un salon temporaire etaient ecrites en dur dans
 * l'ecouteur : le proprietaire recevait toujours « rendre muet », « rendre
 * sourd » et « deplacer », personne d'autre ne recevait quoi que ce soit, et le
 * chat texte du vocal n'etait jamais evoque. Un serveur qui voulait autre chose
 * n'avait aucun moyen de le demander.
 *
 * Ce service porte cette decision sous forme de donnee : une *politique* par
 * generateur, normalisee ici et nulle part ailleurs, que le dashboard ecrit et
 * que l'ecouteur applique. Les fonctions sont pures et exportees pour que le
 * calcul des surcharges - la partie ou une erreur ouvre un salon a tout le
 * serveur - soit verifiable sans client Discord.
 *
 * La politique par defaut reproduit exactement l'ancien comportement : un
 * serveur qui n'a jamais ouvert l'onglet ne voit aucun changement.
 */
import { OverwriteType, PermissionFlagsBits, type OverwriteResolvable } from 'discord.js';

/** Pouvoir accorde au proprietaire sur son salon, au-dela d'y parler. */
export type TempVoiceOwnerPower = 'mute' | 'deafen' | 'move' | 'manageChannel' | 'manageMessages';

/**
 * Sort du chat texte integre au salon vocal.
 *
 * `inherit` ne pose aucune surcharge : le salon suit sa categorie, ce que
 * faisait le module avant d'etre configurable. `open` et `locked` posent une
 * surcharge explicite, et seulement sur « Envoyer des messages » - la
 * visibilite du salon n'est jamais touchee, sans quoi un salon temporaire
 * deviendrait le seul endroit visible des membres non verifies.
 */
export type TempVoiceTextChatMode = 'inherit' | 'open' | 'locked';

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

/** Ce que le proprietaire recevait avant que ce soit configurable. */
export const LEGACY_OWNER_POWERS: readonly TempVoiceOwnerPower[] = ['mute', 'deafen', 'move'] as const;

/** Un salon Discord n'accepte pas plus de 99 places. */
export const MAX_USER_LIMIT = 99;

/** Au-dela, la liste des roles autorises d'office n'est plus lisible en page. */
export const MAX_AUTO_ALLOW_ROLES = 10;

export interface TempVoicePolicy {
  /** Places du salon a la creation ; 0 laisse le salon sans limite. */
  userLimit: number;
  /** Cree le salon deja verrouille : seuls le proprietaire et les roles autorises entrent. */
  lockOnCreate: boolean;
  /** Roles qui recoivent l'acces sans que le proprietaire ait a les ajouter. */
  autoAllowRoleIds: string[];
  textChat: TempVoiceTextChatMode;
  ownerPowers: TempVoiceOwnerPower[];
}

export interface TempVoiceGenerator {
  channelId: string;
  categoryId?: string;
  nameTemplate: string;
  requiredRoleId?: string;
  policy: TempVoicePolicy;
}

/** Forme stockee d'un generateur additionnel, telle qu'elle vit dans le JSON. */
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

/**
 * Politique d'un serveur qui n'a rien configure.
 *
 * Elle reproduit l'ancien code a l'identique : pas de limite, salon ouvert,
 * chat laisse a la categorie, et les trois pouvoirs historiques. Toute autre
 * valeur ici serait un changement de comportement impose aux serveurs
 * existants.
 */
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

function normalizeRoleIds(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isSnowflake))].slice(0, max);
}

function normalizeUserLimit(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(Math.max(Math.trunc(parsed), 0), MAX_USER_LIMIT);
}

function normalizeOwnerPowers(value: unknown): TempVoiceOwnerPower[] {
  // `undefined` n'est pas « aucun pouvoir » : c'est « rien n'a ete dit ». Les
  // serveurs configures avant l'arrivee de ce champ tombent ici, et leur
  // retirer silencieusement les trois pouvoirs historiques casserait leurs
  // salons en cours.
  if (!Array.isArray(value)) return [...LEGACY_OWNER_POWERS];
  return TEMP_VOICE_OWNER_POWERS.filter((power) => value.includes(power));
}

function normalizeTextChat(value: unknown): TempVoiceTextChatMode {
  return TEMP_VOICE_TEXT_CHAT_MODES.includes(value as TempVoiceTextChatMode)
    ? (value as TempVoiceTextChatMode)
    : 'inherit';
}

/**
 * Ramene n'importe quelle valeur venue de la base ou du dashboard a une
 * politique complete.
 *
 * Le JSON de configuration n'est valide par personne d'autre : la route
 * ecrivait jusqu'ici le corps de la requete tel quel dans la colonne. Un
 * generateur portant `userLimit: 5000` ou un identifiant de role invente
 * arrivait donc intact jusqu'a l'appel Discord, qui echouait sans rien dire.
 */
export function normalizeTempVoicePolicy(raw: unknown): TempVoicePolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultTempVoicePolicy();
  const source = raw as Record<string, unknown>;

  return {
    userLimit: normalizeUserLimit(source.userLimit),
    lockOnCreate: source.lockOnCreate === true,
    autoAllowRoleIds: normalizeRoleIds(source.autoAllowRoleIds, MAX_AUTO_ALLOW_ROLES),
    textChat: normalizeTextChat(source.textChat),
    ownerPowers: normalizeOwnerPowers(source.ownerPowers),
  };
}

/** Nombre maximum de generateurs additionnels acceptes pour un serveur. */
export const MAX_ADDITIONAL_GENERATORS = 25;

/**
 * Valide la liste des generateurs additionnels recue du dashboard.
 *
 * Une entree sans salon est ecartee plutot que corrigee : un generateur sans
 * salon ne declenche jamais rien, et le garder ferait croire a une ligne
 * active dans la page.
 */
export function normalizeTempVoiceGeneratorsInput(raw: unknown): StoredTempVoiceGenerator[] {
  if (!Array.isArray(raw)) return [];

  const normalized: StoredTempVoiceGenerator[] = [];
  const seen = new Set<string>();

  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (!isSnowflake(entry.channelId)) continue;
    // Deux generateurs sur le meme salon : le second ne serait jamais atteint,
    // la recherche s'arretant au premier.
    if (seen.has(entry.channelId)) continue;
    seen.add(entry.channelId);

    const policy = normalizeTempVoicePolicy(entry);
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

/** Colonnes du serveur que la resolution des generateurs consulte. */
export interface TempVoiceGuildConfig {
  tempVoiceEnabled: boolean;
  tempVoiceChannelId: string | null;
  tempVoiceCategoryId: string | null;
  tempVoiceNameTemplate: string;
  tempVoiceRequiredRoleId?: string | null;
  tempVoiceDefaults?: unknown;
  tempVoiceGenerators?: unknown;
}

/**
 * Liste des generateurs actifs d'un serveur, politique resolue.
 *
 * Le generateur principal vit dans des colonnes a plat et les suivants dans un
 * JSON : cette difference est historique, et s'arrete ici. Au-dela, tout le
 * module ne voit qu'une seule forme.
 */
export function resolveTempVoiceGenerators(guildConfig: TempVoiceGuildConfig): TempVoiceGenerator[] {
  const generators: TempVoiceGenerator[] = [];

  if (guildConfig.tempVoiceChannelId) {
    generators.push({
      channelId: guildConfig.tempVoiceChannelId,
      categoryId: guildConfig.tempVoiceCategoryId || undefined,
      nameTemplate: guildConfig.tempVoiceNameTemplate || DEFAULT_NAME_TEMPLATE,
      requiredRoleId: guildConfig.tempVoiceRequiredRoleId || undefined,
      policy: normalizeTempVoicePolicy(guildConfig.tempVoiceDefaults),
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
        policy: normalizeTempVoicePolicy(entry),
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

/**
 * Droits poses sur le proprietaire d'un salon.
 *
 * « Envoyer des messages » n'est ajoute que lorsque la politique ferme le chat :
 * en mode herite, poser un droit explicite sur le proprietaire le couperait de
 * la categorie, ce que le module evite partout ailleurs.
 */
export function ownerAllowBits(policy: TempVoicePolicy): bigint[] {
  const bits = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.Speak,
  ];

  for (const power of policy.ownerPowers) bits.push(OWNER_POWER_BITS[power]);
  if (policy.textChat === 'locked') bits.push(PermissionFlagsBits.SendMessages);

  return bits;
}

/** Une surcharge de permission reduite a ce dont le calcul a besoin. */
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

/**
 * Ajoute des droits a une surcharge sans effacer ce qu'elle portait deja.
 *
 * Autoriser un bit le retire du refus, et refuser le retire de l'autorisation :
 * les deux champs Discord sont exclusifs, et les laisser diverger produit une
 * surcharge que l'interface affiche mais que la passerelle ignore.
 */
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

export interface BuildCreationOverwritesInput {
  /** Identifiant du role @everyone, qui vaut celui du serveur. */
  everyoneRoleId: string;
  ownerId: string;
  /** Surcharges recopiees de la categorie parente, vides si elle n'existe pas. */
  inherited: OverwriteDraft[];
  policy: TempVoicePolicy;
}

/**
 * Surcharges posees a la creation d'un salon temporaire.
 *
 * Le principe repris de l'ancien code : on part de ce que porte la categorie et
 * on ajoute par-dessus, plutot que de repartir d'une feuille blanche. Un salon
 * qui se rouvrirait a @everyone sur un serveur ferme serait le seul visible des
 * non-membres, et le seul ou entrer sans avoir passe la verification.
 *
 * Ce que la politique ajoute s'empile donc sur l'heritage, bit a bit, sans
 * jamais remplacer une surcharge entiere.
 */
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

  // 1. Le proprietaire. Sa surcharge heritee, s'il en avait une au niveau de la
  //    categorie, est completee et non remplacee.
  drafts.set(ownerId, applyBits(ensure(ownerId, OverwriteType.Member), ownerAllowBits(policy)));

  // 2. Les roles autorises d'office. Ils entrent et parlent, meme si le salon
  //    est cree verrouille - c'est tout l'interet de les declarer.
  const autoAllow = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak];
  if (policy.textChat === 'locked') autoAllow.push(PermissionFlagsBits.SendMessages);

  for (const roleId of policy.autoAllowRoleIds) {
    // Le proprietaire l'emporte sur un role : ecraser sa surcharge avec celle
    // d'un role le priverait des pouvoirs qu'on vient de lui donner.
    if (roleId === ownerId) continue;
    drafts.set(roleId, applyBits(ensure(roleId, OverwriteType.Role), autoAllow));
  }

  // 3. @everyone : verrouillage et chat. Rien d'autre n'est touche.
  const everyoneAllow: bigint[] = [];
  const everyoneDeny: bigint[] = [];

  if (policy.lockOnCreate) everyoneDeny.push(PermissionFlagsBits.Connect);
  if (policy.textChat === 'open') everyoneAllow.push(PermissionFlagsBits.SendMessages);
  if (policy.textChat === 'locked') everyoneDeny.push(PermissionFlagsBits.SendMessages);

  if (everyoneAllow.length > 0 || everyoneDeny.length > 0) {
    drafts.set(
      everyoneRoleId,
      applyBits(ensure(everyoneRoleId, OverwriteType.Role), everyoneAllow, everyoneDeny),
    );
  }

  // Une surcharge qui n'autorise ni ne refuse rien est du bruit : Discord la
  // conserve et l'affiche, ce qui laisse croire a un reglage.
  return [...drafts.values()]
    .filter((draft) => draft.allow !== 0n || draft.deny !== 0n)
    .map((draft) => ({
      id: draft.id,
      type: draft.type,
      allow: draft.allow,
      deny: draft.deny,
    }));
}

/**
 * Traduit les surcharges d'une categorie Discord vers la forme utilisee ici.
 *
 * Accepte aussi bien des `bigint` que les `PermissionsBitField` renvoyes par
 * discord.js, pour que les tests n'aient pas a fabriquer ces derniers.
 */
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
 * Surcharges posees par les boutons du panneau de gestion.
 *
 * Regroupees ici pour que l'invariant du module tienne en un seul endroit
 * verifiable : **rien de ce qui « rouvre » un salon n'autorise explicitement**.
 * Rendre un droit se dit `null` - il retourne alors a ce que prevoit la
 * categorie. Ecrire `true` ecraserait un refus pose plus haut, et le salon
 * temporaire deviendrait, sur un serveur ferme, le seul ou entrer sans avoir
 * passe la verification.
 *
 * C'etait le cas de « Deverrouiller » et de la levee de reservation.
 */
export const CHANNEL_PATCHES = {
  /** Ferme l'acces au salon a @everyone. */
  lock: { Connect: false },
  /** Rend l'acces a ce que prevoit la categorie. Jamais `true`. */
  unlock: { Connect: null },
  /** Levee de reservation : meme regle que le deverrouillage. */
  clearReservation: { Connect: null },
  /** Ferme le chat ecrit a @everyone. */
  closeChat: { SendMessages: false },
  /** Rend le chat ecrit a ce que prevoit la categorie. Jamais `true`. */
  openChat: { SendMessages: null },
  /**
   * Bannissement d'un membre.
   *
   * Couper la seule connexion le laissait lire et ecrire dans le chat du salon :
   * il restait present la ou on venait de le sortir.
   */
  ban: { Connect: false, ViewChannel: false, SendMessages: false },
} as const satisfies Record<string, Record<string, boolean | null>>;

/** Droits rendus au proprietaire sortant : tout ce qu'un transfert doit reprendre. */
export function ownerRevokedPermissions(): Record<string, null> {
  return {
    MuteMembers: null,
    DeafenMembers: null,
    MoveMembers: null,
    ManageChannels: null,
    ManageMessages: null,
    SendMessages: null,
  };
}

/**
 * Pouvoirs lisibles dans une surcharge deja posee.
 *
 * Un salon ne retient pas quel generateur l'a cree, et le relire n'aurait pas
 * de sens : sa politique a pu changer, ou le generateur disparaitre. Ce que le
 * salon porte reellement est la seule source fiable - c'est elle qu'un
 * transfert doit reconduire, pour que le nouveau proprietaire herite des memes
 * pouvoirs que l'ancien, ni plus ni moins.
 */
export function ownerPowersFromBits(allow: bigint): TempVoiceOwnerPower[] {
  return TEMP_VOICE_OWNER_POWERS.filter((power) => (allow & OWNER_POWER_BITS[power]) === OWNER_POWER_BITS[power]);
}

/**
 * Surcharge a poser sur un nouveau proprietaire.
 *
 * Un pouvoir absent vaut `null` et non `false` : refuser explicitement le
 * couperait de ce que son role lui donne ailleurs sur le serveur, alors qu'on
 * veut seulement ne rien lui ajouter.
 */
export function ownerPermissionPatch(powers: TempVoiceOwnerPower[]): Record<string, boolean | null> {
  const patch: Record<string, boolean | null> = {
    ViewChannel: true,
    Connect: true,
    Speak: true,
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
    patch[keys[power]] = granted.has(power) ? true : null;
  }

  return patch;
}

/** Nom du salon cree, gabarit applique et longueur ramenee a ce que Discord accepte. */
export function renderChannelName(template: string, displayName: string): string {
  const rendered = (template || DEFAULT_NAME_TEMPLATE).replace(/\{user\}/g, displayName);
  const trimmed = rendered.trim();
  // Un gabarit reduit a « {user} » avec un pseudo vide donnerait un nom vide,
  // que Discord refuse - le salon ne serait jamais cree.
  return (trimmed || DEFAULT_NAME_TEMPLATE.replace('{user}', displayName).trim() || 'Salon temporaire').slice(0, 100);
}
