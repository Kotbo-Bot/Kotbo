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
 * `inherit` ne pose rien, `locked` refuse l'écriture à @everyone, `open` la lui
 * autorise - seule autorisation explicite du module, assumée, et que
 * `grantableBits` empêche de dépasser un refus de la catégorie.
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
