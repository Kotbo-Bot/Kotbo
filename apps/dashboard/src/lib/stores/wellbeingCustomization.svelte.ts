import { WB_EMPTY_CUSTOMIZATION, type WbCustomization } from '../wellbeingCustom';

/**
 * Réglages de la cellule de suivi, lus par la page à son chargement et
 * partagés avec ses composants (catégories, étiquettes, plans types).
 */
export const wbCustom = $state<{ value: WbCustomization }>({ value: WB_EMPTY_CUSTOMIZATION });
