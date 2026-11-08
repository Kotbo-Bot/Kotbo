import { MemberCaseState } from '../memberCase.svelte';

/**
 * Fiche membre ouverte d'un clic sur un pseudo, depuis n'importe quelle page.
 *
 * Instance partagée de `MemberCaseState`, montée une fois dans App.svelte par
 * `MemberCaseModalHost` : le contrôle d'accès à « Membres » est porté par la classe.
 */
export const memberCaseModal = new MemberCaseState();
