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
 * - `locked` : seul le propriétaire écrit (les rôles autorisés d'office aussi).
 * - `nobody` : personne n'écrit, ni le propriétaire ni les modérateurs ; les
 *   administrateurs Discord passent outre.
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
