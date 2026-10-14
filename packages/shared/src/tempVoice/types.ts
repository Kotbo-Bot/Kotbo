/**
 * Politique de création des salons vocaux temporaires.
 *
 * Le bot construit les surcharges de permissions à partir de cette forme, et
 * le dashboard édite la même forme dans son formulaire de configuration : un
 * seul contrat évite que les deux dérivent l'un de l'autre.
 */

/** Pouvoir accordé au propriétaire sur son salon, au-delà d'y parler. */
export type TempVoiceOwnerPower = 'mute' | 'deafen' | 'move' | 'manageChannel' | 'manageMessages';

/**
 * Sort du chat texte intégré au salon vocal.
 *
 * - `inherit` : la catégorie décide, le module ne pose rien.
 * - `open` : tout le monde peut écrire, même contre la catégorie.
 * - `inVoice` : seuls les membres connectés au salon écrivent.
 * - `locked` : seuls écrivent le propriétaire et les rôles autorisés d'office
 *   (pas les membres autorisés).
 * - `nobody` : personne n'écrit, ni le propriétaire, ni les modérateurs, ni les
 *   membres autorisés ; les administrateurs Discord passent outre.
 */
export type TempVoiceTextChatMode = 'inherit' | 'open' | 'inVoice' | 'locked' | 'nobody';

export interface TempVoicePolicy {
  /** Places du salon à la création ; 0 laisse le salon sans limite. */
  userLimit: number;
  /** Crée le salon verrouillé : seuls le propriétaire et les rôles autorisés entrent. */
  lockOnCreate: boolean;
  /** Rôles qui reçoivent l'accès sans que le propriétaire ait à les ajouter. */
  autoAllowRoleIds: string[];
  textChat: TempVoiceTextChatMode;
  ownerPowers: TempVoiceOwnerPower[];
}

/**
 * Passation d'un salon dont le propriétaire part.
 *
 * Mêmes noms que les colonnes de `TempVoiceModPermissionsConfig` : le bot, la
 * route du dashboard et la page lisent cette seule définition.
 */
export const TEMP_VOICE_CLAIM_WHO = ['present', 'moderators'] as const;
/** `present` : tout membre en vocal, modérateurs compris ; `moderators` : le staff seul. */
export type TempVoiceClaimWho = (typeof TEMP_VOICE_CLAIM_WHO)[number];

export interface TempVoiceOwnershipSettings {
  /** Le propriétaire qui part reçoit en MP le menu des présents pour choisir son successeur. */
  handoverDmEnabled: boolean;
  /** Durée de validité de ce MP, en secondes : seuls son choix et le staff changent la propriété pendant ce temps. */
  handoverDelaySeconds: number;
  /** Sans choix, un message « Récupérer le salon » est posté dans le chat du salon. */
  claimEmbedEnabled: boolean;
  claimWho: TempVoiceClaimWho;
  /** Le staff peut annuler la réclamation d'un membre (bouton « Annuler la réclamation »). */
  moderatorClaimOverride: boolean;
  /** Un salon vide est supprimé ; sinon il reste, et le premier qui entre peut le récupérer. */
  deleteWhenEmpty: boolean;
}

export const TEMP_VOICE_OWNERSHIP_DEFAULTS: TempVoiceOwnershipSettings = {
  handoverDmEnabled: true,
  handoverDelaySeconds: 30,
  claimEmbedEnabled: true,
  claimWho: 'present',
  moderatorClaimOverride: true,
  deleteWhenEmpty: true,
};

/** Bornes du délai de passation, en secondes, incluses. */
export const TEMP_VOICE_HANDOVER_DELAY_BOUNDS = { min: 10, max: 300 } as const;
