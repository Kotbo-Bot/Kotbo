/**
 * Garde commune des routes `/api/dashboard/guilds/:guildId/...`.
 *
 * Partagée par l'ancien routeur et par Hono pendant la migration : une route
 * déplacée doit passer exactement les mêmes contrôles qu'avant.
 */
import type { Client } from 'discord.js';
import {
  resolveAdminAccess,
  resolveDashboardAccess,
  checkRateLimit,
  dashboardWriteRateLimiter,
  dashboardSensitiveRateLimiter,
  type AuthClaims,
  type DashboardAccess,
} from '../../shared.js';
import { getModuleDefinition, getModuleForApiSegment } from '@kotbo/contracts';
import { WIZARD_CONFIG_SEGMENTS, isGuildInOnboarding } from '../../../services/core/onboardingGate.js';
import { isGuildActivated } from '../../../utils/activation.js';
import { isModuleEnabled } from '../../../services/core/moduleGate.js';
import { trackDashboardVisit } from '../../../services/analytics/ghostActivityTracker.js';
import { recordAdminAudit } from '../../../services/system/adminAuditService.js';
import { featureKeysForSegment, getCachedFeatureAccess, isModuleUngatedSubroute, sharedModulesForSegment, writeFeatureKeysForSegment } from './featureGate.js';

export const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Ce qu'un serveur non activé peut atteindre : sa mise en place, et rien
 * d'autre.
 *
 * La promesse faite à l'installation est « montez votre serveur, payez
 * ensuite » : la garde d'activation ne peut donc pas fermer les pages qui
 * servent précisément à le monter. Elle reste fermée sur tout le reste - un
 * serveur non activé configure, il n'exploite pas. L'essai gratuit ne change
 * rien à cette frontière : il commence à l'activation, pas avant.
 *
 * Ces segments écrivent réellement sur le serveur Discord (salons, rôles,
 * reprise d'un ancien bot). Ce n'est pas un trou : `resolveDashboardAccess`
 * a déjà vérifié plus haut que la personne administre ce serveur. Ce qu'on
 * ouvre ici, c'est le droit de préparer - pas celui d'entrer.
 *
 * Toute addition à cette liste ouvre une porte à qui n'a pas payé : n'y
 * mettre qu'un segment dont la page sert à *arriver* sur Kotbo.
 */
const ONBOARDING_SEGMENTS = new Set([
  // Reprise depuis un autre bot : détection, plan, application.
  'migration',
  // Pose de la structure : salons, rôles, catégories.
  'server-template',
  // Parcours de prise en main : ce qui est fait, ce qu'il reste.
  'setup',
  // Le paiement lui-même. Sans lui, la garde se refermerait sur sa propre
  // sortie : un serveur non activé n'aurait aucun moyen d'ouvrir la page de
  // règlement qui l'activerait.
  'billing',
  // La clôture du parcours quand il n'y a rien à payer. Même raison : c'est
  // l'autre sortie, et elle ne donne accès à rien d'autre.
  'onboarding',
]);

async function isAnyModuleEnabled(guildId: string, moduleKeys: string[]): Promise<boolean> {
  for (const key of moduleKeys) {
    if (await isModuleEnabled(guildId, key)) return true;
  }
  return false;
}

export type GuildGateDenial = { status: number; body: Record<string, unknown> };
export type GuildGateResult =
  | { denied: GuildGateDenial }
  | { denied: null; access: DashboardAccess; effectiveAccess: DashboardAccess };

const deny = (status: number, body: Record<string, unknown>): GuildGateResult => ({ denied: { status, body } });

/**
 * Un admin global a un acces complet aux serveurs qu'il n'administre pas
 * lui-meme (DASHBOARD_ACCESS_GLOBAL_ADMIN) : chacune de ses ecritures y est
 * tracee, avant tout sous-routeur pour n'en manquer aucune.
 */
export async function auditGlobalAdminWrite(
  client: Client,
  user: AuthClaims,
  parts: string[],
  method: string,
  ip: string | null,
): Promise<void> {
  if (!(parts[2] === 'guilds' && parts.length >= 4 && !READ_METHODS.has(method)
    && await resolveAdminAccess(client, user.userId))) return;
  const guildId = parts[3];
  const access = await resolveDashboardAccess(client, guildId, user.userId);
  if (!access.viaGlobalAdmin) return;
  const route = `/${parts.join('/')}`;
  const guildName = client.guilds.cache.get(guildId)?.name ?? guildId;
  void recordAdminAudit({
    actorId: user.userId,
    actorName: user.username,
    action: 'dashboard.global_admin_write',
    targetType: 'guild',
    targetId: guildId,
    summary: `${method} ${route} sur ${guildName}`,
    metadata: { method, route },
    ip,
  });
}

/** Contrôles d'une route de serveur ; `parts` vaut `/api/dashboard/guilds/:guildId/...` découpé. */
export async function evaluateGuildGate(
  client: Client,
  user: AuthClaims,
  parts: string[],
  method: string,
): Promise<GuildGateResult> {
  const guildId = parts[3];
  const access = await resolveDashboardAccess(client, guildId, user.userId);
  if (!access.canViewDashboard) {
    return deny(403, { error: 'Accès refusé au dashboard pour ce serveur.' });
  }

  // Ghost Analyzer : consulter le dashboard d'un serveur est un signe de vie,
  // même pour un membre qui n'écrit jamais. Débounce à une visite par heure.
  trackDashboardVisit(guildId, user.userId);

  // Check guild activation (bypassed for owner and global admins, and during activation requests)
  const isGlobalAdmin = await resolveAdminAccess(client, user.userId);
  const isActivationRequest = parts.length === 5 && parts[4] === 'activate' && method === 'POST';
  const isGuildOnboarding = await isGuildInOnboarding(guildId);
  const isOnboardingRequest = ONBOARDING_SEGMENTS.has(parts[4] ?? '')
    || (isGuildOnboarding && WIZARD_CONFIG_SEGMENTS.has(parts[4] ?? ''));
  if (!isGuildActivated(guildId) && !isActivationRequest && !isOnboardingRequest && !isGlobalAdmin) {
    return deny(403, { error: 'Activation requise', needsActivation: true });
  }

  // Garde des modules : les routes d'un module éteint sont fermées, lecture
  // comprise. Sans elle, la page d'un module désactivé continuerait de se
  // charger et de s'enregistrer pour qui connaît son URL, alors même que le
  // bot n'exécute plus rien derrière.
  //
  // Deux nuances, décrites dans `featureGate.ts` : une sous-route que des
  // pages étrangères au module appellent à chaque ouverture répond vide
  // plutôt que de refuser, et un segment partagé par deux modules reste
  // ouvert tant que l'un des deux tourne.
  const routeModuleKey = isModuleUngatedSubroute(parts[4], parts[5])
    ? undefined
    : getModuleForApiSegment(parts[4]);
  if (routeModuleKey
    && !(await isModuleEnabled(guildId, routeModuleKey))
    && !(await isAnyModuleEnabled(guildId, sharedModulesForSegment(parts[4])))) {
    /**
     * Exception : le parcours de configuration.
     *
     * Il demande de régler la modération et l'accueil *avant* de payer -
     * c'est tout l'intérêt, on voit ce qu'on achète. Or ces modules ne
     * figurent pas dans l'offre FREE : cette garde refusait leurs écritures,
     * et le parcours butait à l'écran 5 sur un serveur qui n'avait, par
     * construction, encore rien pris.
     *
     * Ouvrir l'écriture n'ouvre pas le service : `moduleGate` continue
     * d'éteindre ces modules au runtime tant que l'offre ne les comprend
     * pas. La ligne est écrite, elle ne s'applique pas, et le paiement la
     * révèle sans qu'aucun traitement n'ait à repasser derrière.
     */
    const forWizard = WIZARD_CONFIG_SEGMENTS.has(parts[4] ?? '')
      && isGuildOnboarding;

    if (!forWizard) {
      return deny(403, {
        error: `Le module « ${getModuleDefinition(routeModuleKey)?.name ?? routeModuleKey} » est désactivé sur ce serveur.`,
        code: 'module_disabled',
        moduleKey: routeModuleKey,
      });
    }
  }

  /**
   * Garde des sections : une lecture dont la fonctionnalite est fermee au
   * role s'arrete ici.
   *
   * Masquer l'entree de la barre laterale ne suffisait pas. L'URL restait
   * tapable, un favori la ramenait, et surtout les pages voisines
   * appelaient ces routes au passage - c'est ainsi que le dossier membre
   * revenait par la liste des gagnants d'un giveaway. Les ecritures ne
   * passent pas par ici : elles demandent deja `canManageSettings`, sauf
   * les exceptions traitees juste apres, ou le droit exact depend du geste.
   */
  if (method === 'GET') {
    const routeFeatureKeys = featureKeysForSegment(parts[4], parts[5]);
    if (routeFeatureKeys && !access.canManageSettings) {
      const featureAccess = await getCachedFeatureAccess(client, guildId, access, user.userId);
      // Une donnee partagee par deux sections reste lisible tant qu'une des
      // deux est ouverte : la fermer des la premiere fermeture cassait la
      // page de l'autre.
      if (routeFeatureKeys.every((key) => featureAccess[key]?.canView === false)) {
        return deny(403, {
          error: 'Accès refusé. Votre rôle ne donne pas accès à cette section.',
          code: 'feature_denied',
          featureKey: routeFeatureKeys[0],
        });
      }
    }
  }

  // Gating check for write actions
  const isSanctionAction = parts[4] === 'sanctions'
    && (
      ((parts.length === 6 || parts.length === 7) && parts[5] === 'reports' && (method === 'POST' || method === 'PATCH'))
      // Pièces de preuve : téléversement et suppression, revérifiés dans sanctions.ts.
      || (parts[5] === 'evidence-files' && ((method === 'POST' && parts.length === 6) || (method === 'DELETE' && parts.length === 7)))
    );

  const isStaffAbsenceAction = parts.length === 5
    && parts[4] === 'absences'
    && method === 'POST';

  // Le panneau de demission du profil s'adresse au staff, pas aux
  // administrateurs : sans exception, tout envoi finissait sur un refus.
  const isStaffResignationAction = parts.length === 6
    && parts[4] === 'staff'
    && parts[5] === 'resignations'
    && method === 'POST';

  const isMeetingAction = parts[4] === 'meetings'
    && (method === 'POST' || method === 'PATCH' || method === 'DELETE');

  /**
   * Boite de reception : marquer lu, et rien d'autre.
   *
   * L'exception disait « n'importe quelle methode sur le segment
   * notifications », et ce segment porte aussi les reglages globaux du
   * serveur : un PUT y ecrit le coupe-circuit, le journal de debogage, la
   * sauvegarde cloud et l'adresse de notification. N'importe quel compte
   * capable d'ouvrir le dashboard pouvait donc couper le bot. Le PATCH des
   * notifications par fonctionnalite passait par le meme trou.
   *
   * Seuls les deux gestes de la boite de reception restent ouverts : ils ne
   * touchent que les lignes de la personne qui les demande.
   */
  const isNotificationAction = parts[4] === 'notifications'
    && ((method === 'PATCH' && parts.length === 7 && parts[6] === 'read')
      || (method === 'POST' && parts.length === 6 && parts[5] === 'mark-all-read'));

  const isNewsAction = parts[4] === 'news'
    && (method === 'POST' || method === 'PATCH' || method === 'DELETE');

  // La fiche membre est un outil de modération : la note interne et les
  // actions de modération doivent rester accessibles sans droit de
  // configuration, sinon l'onglet « Notes Modérateur » renvoie une erreur
  // d'enregistrement à tous les modérateurs (issue #215). Le niveau d'accès
  // exact est revérifié dans handleMembersRoutes.
  // Kotbo × AegisAI : trancher une détection ou essayer une phrase revient
  // au staff de modération, pas seulement aux administrateurs. Le droit
  // exact est revérifié dans handleAegisRoutes.
  const isAegisReviewAction = parts[4] === 'aegis' && method === 'POST'
    && (parts[5] === 'test' || (parts[5] === 'detections' && parts.length === 8));

  // Listes de suivi : déplacer ou épingler un élément est le travail du
  // staff, pas un réglage. Le droit exact est revérifié dans
  // handleDoingListRoutes.
  const isDoingListAction = parts[4] === 'doing-lists' && method !== 'GET';

  // Tutorat : le tuteur coche les objectifs et fait ses points d'étape, le
  // tutoré tient son carnet de bord, sans droit de configuration. Le rôle
  // exact sur chaque tutorat est revérifié dans handleTutoringRoutes.
  const isTutoringAction = parts[4] === 'tutoring' && method !== 'GET';

  // Cellule bien-être : ses membres ne sont pas forcément administrateurs du
  // dashboard. Dossiers, notes et accès d'urgence sont revérifiés dans
  // wellbeing.ts ; la composition de la cellule reste sous cette garde.
  const isWellbeingAction = parts[4] === 'wellbeing' && parts[5] !== 'config' && method !== 'GET';

  // Trancher une suggestion est un geste de modération : le droit « Modérer »
  // de la fonctionnalité, revérifié dans handleSuggestionRoutes, suffit.
  const isSuggestionDecisionAction = parts[4] === 'suggestions'
    && parts.length === 7
    && parts[6] === 'resolve'
    && method === 'POST';

  // Retirer un message de la une, ou annuler ce retrait, est aussi un geste
  // de modération, revérifié dans handleStarboardRoutes.
  const isStarboardModerationAction = parts[4] === 'starboard'
    && parts.length === 8
    && parts[5] === 'entries'
    && (parts[7] === 'block' || parts[7] === 'unblock')
    && method === 'POST';

  const isMemberModerationAction = parts.length === 7
    && parts[4] === 'members'
    && ((parts[6] === 'note' && method === 'PATCH') || (parts[6] === 'actions' && method === 'POST'));

  // Les giveaways ont leurs propres rôles gestionnaires (onglet Configuration
  // de la page Concours) : lancer ou clôturer un tirage ne demande pas les
  // droits d'administration du dashboard. Le réglage de ces rôles, lui, reste
  // sous ce garde-fou. L'autorisation exacte est refaite dans
  // handleGeneralistModulesRoutes.
  const isGiveawayManagerAction = parts[4] === 'giveaways'
    && parts[5] !== 'config'
    && method !== 'GET';

  // Les notes datées et les vues enregistrées d'Analytics se posent par tout
  // lecteur de la section, sans droit de configuration. handleAnalyticsRoutes
  // revérifie la lecture.
  const isAnalyticsAnnotationAction = parts[4] === 'analytics'
    && (parts[5] === 'annotations' || parts[5] === 'views')
    && (method === 'POST' || method === 'DELETE');

  // Trancher un appel de ban, demander des informations ou statuer sur une
  // sanction contestée revient aussi aux modérateurs : appealsAccess
  // (banAppeals.ts) revérifie le droit exact juste après cette garde.
  const isBanAppealModerationAction = parts[4] === 'appeals'
    && method === 'POST'
    && (
      (parts.length === 7 && (parts[6] === 'decide' || parts[6] === 'request-info'))
      || (parts.length === 8 && parts[6] === 'items')
    );

  // Décider d'une absence (PATCH) ou supprimer la sienne (DELETE) : gestes du
  // staff, dont absences.ts revérifie le droit exact.
  const isStaffAbsenceItemAction = parts.length === 6
    && parts[4] === 'absences'
    && (method === 'PATCH' || method === 'DELETE');

  // Planifier un appel est ouvert au staff que la configuration des appels
  // autorise. canUserCreateCall, revérifié dans calls.ts, tranche le droit exact.
  const isCallCreationAction = parts.length === 5
    && parts[4] === 'calls'
    && method === 'POST';

  // Préférences du lecteur (thème, disposition, préréglages) : chaque route
  // n'écrit que les lignes de la personne qui la demande.
  const isPersonalPreferenceAction = parts[4] === 'user-settings' || parts[4] === 'layout-presets';

  // Widget de profil : ces gestes ne touchent que la ligne de l'appelant.
  // `refresh-all`, qui pousse les widgets de tout le staff, reste aux administrateurs.
  const isOwnWidgetAction = parts.length === 6
    && parts[4] === 'widget'
    && ['activate', 'deactivate', 'refresh', 'rotate-token'].includes(parts[5] ?? '')
    && method === 'POST';

  /**
   * Droits « Configurer » et « Supprimer » du centre de gestion.
   *
   * Les deux cases ne servaient a rien : une ecriture demandait d'etre
   * administrateur du dashboard, et cinq fichiers de routes seulement les
   * lisaient. Cocher « Configurer » sur Giveaways pour un role laissait donc
   * ce role incapable d'enregistrer la configuration des concours.
   *
   * `=== true` et non `!== false`, contrairement a la garde de lecture : sans
   * regle de role sur la fonctionnalite, la valeur retombe sur
   * `canManageSettings`, deja teste juste avant. Exiger l'autorisation
   * explicite garantit que cette branche n'ouvre que ce qu'un administrateur
   * a coche a la main, et rien sur les serveurs qui n'ont jamais touche au
   * centre de gestion.
   *
   * Une suppression demande « Supprimer », pas « Configurer » : c'est ce que
   * les quatre cases promettent, et les separer permet d'ouvrir l'edition
   * sans ouvrir l'effacement.
   */
  const writeFeatureKeys = method !== 'GET' && !access.canManageSettings
    ? writeFeatureKeysForSegment(method, parts[4], parts[5])
    : undefined;

  let hasFeatureWriteRight = false;
  if (writeFeatureKeys) {
    const featureAccess = await getCachedFeatureAccess(client, guildId, access, user.userId);
    hasFeatureWriteRight = writeFeatureKeys.some((key) => {
      const rights = featureAccess[key];
      return method === 'DELETE' ? rights?.canDelete === true : rights?.canConfigure === true;
    });
  }

  /**
   * Accès transmis aux sous-routeurs.
   *
   * Ils retestent chacun `canManageSettings` pour leurs ecritures : sans
   * cette elevation, la porte ouverte plus haut se refermait deux lignes
   * plus loin et la case « Configurer » restait decorative. L'elevation ne
   * vaut que pour la requete en cours, donc pour le seul segment vise, et
   * `level` reste inchange - les gestes reserves a `level === 'admin'`
   * continuent de refuser.
   */
  const effectiveAccess = hasFeatureWriteRight
    ? { ...access, canManageSettings: true }
    : access;

  if (!access.canManageSettings && method !== 'GET' && !hasFeatureWriteRight && !isSanctionAction && !isStaffAbsenceAction && !isStaffResignationAction && !isNotificationAction && !isMeetingAction && !isNewsAction && !isMemberModerationAction && !isGiveawayManagerAction && !isAnalyticsAnnotationAction && !isAegisReviewAction && !isDoingListAction && !isTutoringAction && !isWellbeingAction && !isSuggestionDecisionAction && !isStarboardModerationAction && !isBanAppealModerationAction && !isStaffAbsenceItemAction && !isCallCreationAction && !isPersonalPreferenceAction && !isOwnWidgetAction) {
    return deny(403, { error: 'Action réservée aux administrateurs du dashboard.' });
  }

  if (isMemberModerationAction && access.level !== 'admin' && access.level !== 'moderator') {
    return deny(403, { error: 'Action de modération non autorisée.' });
  }

  if (isNewsAction && !access.canModerateContent) {
    return deny(403, { error: 'Action de gestion des actualités non autorisée.' });
  }

  // Rate limiting des écritures.
  //
  // Point de passage unique : toutes les routes de guilde transitent par ici,
  // donc un seul garde-fou couvre les réglages, les clans et le
  // reste, sans avoir à y penser route par route.
  //
  // La clé est « membre + serveur » et non l'IP : deux administrateurs derrière
  // la même sortie réseau ne doivent pas se pénaliser mutuellement.
  if (method !== 'GET') {
    const rateKey = `${user.userId}:${guildId}`;

    // Plafond large : aucun usage humain ne l'atteint. Il sert a arreter net une
    // page qui partirait en boucle de requetes.
    if (!checkRateLimit(dashboardWriteRateLimiter, rateKey, 60, 60 * 1000)) {
      return deny(429, { error: 'Trop de modifications en peu de temps. Réessayez dans une minute.' });
    }

    // Actions coûteuses ou irréversibles : enregistrement de réglages, mise en route d'un module (qui crée des salons
    // Discord), remises à zéro et distributions de clans.
    const isSensitiveWrite =
      (parts[4] === 'settings' && (method === 'PATCH' || method === 'PUT'))
      || (parts[4] === 'tickets' && parts[5] === 'config' && parts[6] === 'setup')
      || (parts[4] === 'leveling' && parts[5] === 'level-up-channel')
      // Créer un emoji ajoute un asset permanent au serveur Discord :
      // rien ne le retire ensuite depuis le dashboard.
      || parts[4] === 'emojis'
      // Test et renvoi d'un webhook sortant : chacun appelle un serveur
      // tiers et attend sa réponse.
      || (parts[4] === 'outgoing-webhooks' && (parts[6] === 'test' || parts[8] === 'redeliver'))
      // Simulation d'une règle : relit jusqu'à cent mille messages.
      || (parts[4] === 'automod' && parts[5] === 'simulate')
      // Essai d'une phrase : deux appels à l'API AegisAI.
      || (parts[4] === 'aegis' && parts[5] === 'test')
      // Le prestige crée un salon d'annonce, et jusqu'à trente rôles d'un
      // coup : même catégorie que les mises en route ci-dessus.
      || (parts[4] === 'ranked' && parts[5] === 'announce-channel')
      || (parts[4] === 'ranked' && parts[5] === 'tier-roles' && parts[6] === 'provision')
      || (parts[4] === 'clans'
        && ['distribute', 'clear', 'reset-season', 'reset-all', 'rollback-season'].includes(parts[5] ?? ''));

    if (isSensitiveWrite && !checkRateLimit(dashboardSensitiveRateLimiter, rateKey, 10, 60 * 1000)) {
      return deny(429, { error: 'Trop d\'enregistrements successifs. Réessayez dans une minute.' });
    }
  }

  return { denied: null, access, effectiveAccess };
}
