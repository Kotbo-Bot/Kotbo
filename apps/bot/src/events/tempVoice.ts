/**
 * Salons vocaux temporaires : création, panneau de gestion, nettoyage.
 *
 * Les règles de création viennent de `tempVoiceService` ; cet écouteur les
 * traduit en appels Discord. Deux invariants le portent :
 *
 * 1. Un salon n'est jamais plus ouvert que sa catégorie. Seule exception
 *    assumée, le mode de chat « ouvert », qui ne touche qu'à l'écriture et que
 *    `grantableBits` rattrape si la catégorie la refuse à @everyone.
 * 2. Ce que le bot annonce doit s'être produit : le résultat de chaque appel
 *    est vérifié avant la réponse.
 */
import {
  Client,
  Events,
  VoiceState,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Interaction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  MessageFlags,
  OverwriteType,
  RoleSelectMenuBuilder,
  UserSelectMenuBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  GuildMember,
  type CategoryChannel,
  type Guild as DiscordGuild,
  type Message,
  type MessageActionRowComponentBuilder,
  type RepliableInteraction,
  type VoiceChannel,
} from 'discord.js';
import prisma from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { E } from '../utils/emojis.js';
import { RENAME_TIMEOUT_MS, settleWithin } from '../utils/discord.js';
import { cache, getCachedGuild } from '../utils/cache.js';
import { annoncerIntentionVocale } from '../services/moderation/voiceIntentRegistry.js';
import {
  buildCreationOverwrites,
  CHANNEL_PATCHES,
  categoryOverwriteFor,
  requiredBotPermissions,
  restoreFromCategory,
  resolveReservationRoleId,
  categoryTrustPatch,
  MAX_USER_LIMIT,
  defaultTempVoicePolicy,
  TRUST_BIT_COUNT,
  ownerChatPatch,
  ownerPermissionPatch,
  ownerPowersFromBits,
  ownerRevokedPermissions,
  renderChannelName,
  resolveTempVoiceGenerators,
  toOverwriteDrafts,
  // ─── Refonte du panneau : tout le calcul vit dans le service ───
  MODES_ECRITURE,
  MODE_ECRITURE_PAR_DEFAUT,
  libelleModeEcriture,
  EMOJI_MODE_EVERYONE,
  normaliserModeEcriture,
  surchargesModeEcriture,
  quotaRenommage,
  enregistrerRenommage,
  libelleRenommer,
  RENOMMAGES_PAR_FENETRE,
  RegistreDemandesAcces,
  boutonDemanderAccesVisible,
  CONFIG_DEMANDES_PAR_DEFAUT,
  normaliserConfigDemandes,
  peutRepondreDemande,
  ordreNotification,
  RegistreOriginesSurcharge,
  membresAReduireAuSilence,
  REGLAGES_MODERATEUR,
  sujetReglage,
  type ReglageModerateur,
  normaliserEtatDemandes,
  normaliserHistoriqueRenommage,
  membresSansLeRole,
  planDebordement,
  normaliserConfigReservation,
  type ConfigReservation,
  type PlanDebordement,
  decisionEntreeVocal,
  decisionSortieVocal,
  decisionRetraitAutorisation,
  transitionModeEcriture,
  estModeEcriture,
  nettoyagePresenceAuDemarrage,
  PATCH_PRESENCE_RETIREE,
  peutAgir,
  peutAgirSurCible,
  libelleActionMembre,
  normaliserReglagesAdmin,
  reglagesVerrouilles,
  raisonAdminsSeulement,
  // ─── Les cinq réglages de présentation, par serveur ───
  PRESENTATION_PAR_DEFAUT,
  normaliserReglagesPresentation,
  // ─── ... et leur héritage par générateur, derrière son interrupteur ───
  presentationParGenerateurActive,
  presentationPourGenerateur,
  dispositionNative,
  nomFichierEtat,
  planReservation,
  type ReglagesPresentation,
  type PlanReservation,
  type ModeEcriture,
  type CanalNotification,
  type CibleMembre,
  type ConfigDemandesAcces,
  type SurchargeMembreLue,
  type ReglagesAdmin,
  type RoleAgissant,
  type ActionPanneau,
  type VerdictAction,
  type TempVoiceGenerator,
  type TempVoiceGuildConfig,
  type TempVoicePolicy,
} from '../services/features/tempVoiceService.js';
import { rendreEtatPng, type ValeurEtat } from '../services/features/tempVoicePanelImage.js';
import { messageEstV2, sansConversionV2 } from '../utils/patchV2.js';
import * as m from '../lib/paraglide/messages.js';
import { resolveGuildLocale, type BotLocale } from '../utils/i18n.js';

/**
 * Ce que le panneau doit savoir d'un salon et que Discord ne porte pas.
 *
 * `creatorId` reste seul obligatoire : le reste s'ajoute en cours de vie, et une
 * entrée écrite ailleurs (balayage, tests) doit continuer de tenir sans eux.
 */
export interface EntreeSalonTemporaire {
  creatorId: string;
  /** Message du panneau, retrouvé une fois puis mémorisé. */
  panneauId?: string;
  /** Mode d'écriture courant : seul « vocal » ne se déduit pas des surcharges. */
  modeEcriture?: ModeEcriture;
  /** Départ du propriétaire, pour dire « parti il y a 3 minutes » sans inventer. */
  departProprietaireA?: number;
  /**
   * Le générateur d'où vient ce salon, tel que `TempVoiceChannel.generatorChannelId`
   * le garde — posé à la création, repris de la base au démarrage.
   *
   * Il est ici et pas relu en base à chaque clic : le panneau public et ses
   * sous-panneaux éphémères doivent s'accorder sur la MÊME présentation, et une
   * lecture par interaction ne servirait qu'à répéter ce que la ligne dit déjà.
   *
   * `undefined` = salon créé avant la colonne : il hérite de la présentation du
   * serveur, ce qu'il affichait déjà.
   */
  generateurId?: string;
}

export const tempChannels = new Map<string, EntreeSalonTemporaire>();

/**
 * Sérialise les changements de propriétaire, salon par salon : deux transferts
 * simultanés liraient le même propriétaire sortant et n'en révoqueraient qu'un.
 */
const ownershipQueue = new Map<string, Promise<unknown>>();

function serializeByChannel<T>(channelId: string, task: () => Promise<T>): Promise<T> {
  const previous = ownershipQueue.get(channelId) ?? Promise.resolve();
  const next = previous.then(task, task);
  // La file ne retient que l'ordre : une erreur ne doit pas la bloquer.
  const settled = next.then(() => undefined, () => undefined);
  ownershipQueue.set(channelId, settled);
  void settled.then(() => {
    if (ownershipQueue.get(channelId) === settled) ownershipQueue.delete(channelId);
  });
  return next;
}

/** Membres pour qui une création est en cours : sans quoi entrer et sortir du
 *  générateur en rafale créerait autant de salons que d'aller-retours. */
const creationInFlight = new Set<string>();

// ─────────────────────────────────────────────────────────────────────────────
// Icônes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Noms d'icônes du panneau → clés réelles du magasin d'emojis.
 *
 * `E` n'expose pas `check`, `cross`, `msg`, `warn` ni `mod` : ces images
 * s'appellent `success`, `error`, `messages`, `warning` et `moderation` dans
 * `emojis.ts`, et `E.check` rendrait une chaîne vide - un bouton sans icône,
 * sans la moindre erreur. La table nomme la traduction une fois pour toutes.
 */
const CLES_ICONES = {
  lock: 'lock',
  unlock: 'unlock',
  voice: 'voice',
  crown: 'crown',
  settings: 'settings',
  profile: 'profile',
  shield: 'shield',
  ban: 'ban',
  kick: 'kick',
  check: 'success',
  cross: 'error',
  msg: 'messages',
  mute: 'mute',
  warn: 'warning',
  mod: 'moderation',
  dot: 'dot',
} as const;

type NomIcone = keyof typeof CLES_ICONES;

/**
 * Jeu `ktb_`, lu à chaque accès : les emojis d'application ne sont chargés qu'au
 * `ClientReady`, bien après l'évaluation de ce module. Une table figée à
 * l'import ne servirait que des replis Unicode pour toute la durée du process.
 */
const I = new Proxy({} as Record<NomIcone, string>, {
  get(_cible, nom) {
    const cle = CLES_ICONES[String(nom) as NomIcone];
    return cle ? (E[cle] ?? '') : '';
  },
});

/**
 * Quatre icônes manquent au jeu `ktb_` : renommer, ajouter, récupérer et un
 * globe pour « tout le monde ». L'Unicode reste, plutôt que de détourner une
 * icône voisine qui mentirait sur l'action.
 */
const ICONES_ABSENTES = {
  renommer: '✏️',
  ajouter: '➕',
  recuperer: '🙋',
  globe: '🌍',
} as const;

/** Pose une icône seulement si elle en est une : `setEmoji('')` fait rejeter le message entier. */
function avecIcone<T extends { setEmoji(emoji: string): T }>(composant: T, icone: string): T {
  return icone ? composant.setEmoji(icone) : composant;
}

// ─────────────────────────────────────────────────────────────────────────────
// Couleurs de la carte d'état
// ─────────────────────────────────────────────────────────────────────────────

const COULEUR_OUVERT = 0x57f287;
const COULEUR_FERME = 0xed4245;
const COULEUR_NEUTRE = 0x949ba4;
const COULEUR_ACCENT = 0x5865f2;

// ─────────────────────────────────────────────────────────────────────────────
// Mécanismes portés par `tempVoiceService`
//
// Rien de ce qui suit ne recalcule une règle : les modes d'écriture, le quota de
// renommage, le registre des demandes, la matrice de permissions et l'origine
// des surcharges sont des fonctions pures, vérifiables sans client Discord, et
// vivent là-bas. Ici ne restent que l'état en mémoire qu'elles n'ont pas à
// porter (par salon, perdu au redémarrage comme le salon lui-même) et le
// câblage vers Discord.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Icône du champ « Écriture » de la carte d'état.
 *
 * La maquette n'y met pas la même image que dans le menu : la carte parle
 * d'écriture (`ktb_msg`), le menu désigne la portée (un globe). Les deux sont
 * repris tels quels plutôt qu'unifiés.
 */
function iconeModeCarte(mode: ModeEcriture): string {
  return mode === 'everyone' ? I.msg : iconeMode(mode);
}

/** Icône du menu « Qui peut écrire » : le service porte les libellés, pas le jeu `ktb_`. */
function iconeMode(mode: ModeEcriture): string {
  switch (mode) {
    // Le globe manque au jeu `ktb_` : le service fournit son repli Unicode.
    case 'everyone': return EMOJI_MODE_EVERYONE || ICONES_ABSENTES.globe;
    case 'inVoice': return I.voice;
    case 'ownerOnly': return I.crown;
    case 'nobody': return I.mute;
  }
}

/**
 * Qui porte quelle origine de surcharge, par salon.
 *
 * L'invariant « `presence` n'écrase jamais `autorisation` » tient dans le
 * registre, pas à chaque site d'appel : quitter le vocal ne doit pas effacer un
 * droit donné à la main par « Autoriser », les deux écrivant la même surcharge.
 */
const originesSurcharge = new RegistreOriginesSurcharge();

/** Trois garde-fous (une demande en attente, dix minutes de silence après un
 *  refus, expiration) — tous dans le registre, aucun ici. */
const registreDemandes = new RegistreDemandesAcces();

/**
 * Historique des renommages par salon. Le calcul est pur (`quotaRenommage`,
 * `enregistrerRenommage`) ; seul le stockage est local.
 */
const historiquesRenommage = new Map<string, number[]>();

function historiqueRenommage(salonId: string): number[] {
  return historiquesRenommage.get(salonId) ?? [];
}

function noterRenommage(salonId: string, maintenant = Date.now()): void {
  historiquesRenommage.set(salonId, enregistrerRenommage(historiqueRenommage(salonId), maintenant));
}

/**
 * Écrit en base ce que le panneau gardait en mémoire.
 *
 * Le quota de renommage et les demandes d'accès mouraient avec le processus :
 * le bouton réannonçait « 2/2 » alors que Discord comptait toujours, et un
 * silence de dix minutes après un refus s'évaporait au redémarrage.
 *
 * Une base indisponible ne doit jamais faire échouer le geste de l'utilisateur :
 * l'écriture est tentée, journalisée si elle rate, et on continue.
 */
async function persisterEtatSalon(guildId: string, salonId: string): Promise<void> {
  const maintenant = Date.now();
  const etat = registreDemandes.exporterSalon(guildId, salonId, maintenant);
  try {
    await prisma.tempVoiceChannel.update({
      where: { id: salonId },
      data: {
        renameHistory: historiqueRenommage(salonId),
        // Recompose en litteral : Prisma exige une valeur JSON, et une interface
        // nommee ne lui est pas assignable en TypeScript - une limite de typage,
        // pas une donnee qui ne conviendrait pas.
        accessRequests: {
          demandes: etat.demandes.map((d) => ({ ...d })),
          silences: etat.silences.map((v) => ({ ...v })),
        },
      },
    });
  } catch (err) {
    logger.warn('TempVoice', `Etat du panneau non persiste pour ${salonId} :`, err);
  }
}

/** Un salon temporaire disparaît : ses demandes, ses marques d'origine et son
 *  historique de renommage aussi, sans laisser de ligne orpheline. */
function oublierSalon(guildId: string, salonId: string): void {
  registreDemandes.oublierSalon(guildId, salonId);
  originesSurcharge.oublierSalon(guildId, salonId);
  historiquesRenommage.delete(salonId);
  v1ImpossibleSignale.delete(salonId);
  const etat = rafraichissements.get(salonId);
  if (etat?.minuteur) clearTimeout(etat.minuteur);
  rafraichissements.delete(salonId);
}

/**
 * Réglages admin du serveur : ce que les modérateurs ont le droit de faire.
 *
 * `peutAgir` n'accepte pas de valeur par défaut à dessein - un appelant qui
 * l'oublie obtiendrait un panneau tout permis. Ils sont donc lus ici, une fois,
 * et passés explicitement.
 *
 * Aucune ligne en base vaut « tout autorisé » : c'est le comportement d'avant la
 * refonte, que rien ne doit changer tant qu'un administrateur n'a pas ouvert
 * l'onglet. Les defauts du schema, eux, ne s'appliquent qu'a la creation de la
 * ligne - les lire ici a la place d'une absence fermerait des portes que
 * personne n'a demande a fermer.
 */
interface ReglagesModule {
  reglages: ReglagesAdmin;
  /** Un seul éphémère réécrit sur place, plutôt qu'un de plus par action. */
  panneauCompact: boolean;
  /** Rôles proposés à la réservation, et sort de ceux qui restent. */
  reservation: ConfigReservation;
  /**
   * Les cinq réglages de présentation du serveur : mode du panneau, disposition
   * et teinte de la carte d'état, jeu de composants, repli de réservation.
   *
   * Aucune ligne, ou une lecture qui échoue, vaut `PRESENTATION_PAR_DEFAUT` —
   * lequel reproduit exactement le comportement livré : rien ne change pour un
   * serveur qui n'a jamais ouvert l'onglet.
   */
  presentation: ReglagesPresentation;
  /**
   * L'interrupteur de la personnalisation par générateur.
   *
   * Faux — et c'est le cas de tout serveur qui n'a rien réglé, comme d'une
   * lecture en panne — `presentation` ci-dessus vaut pour TOUS les salons et les
   * surcharges des générateurs ne sont pas même lues. Il voyage avec
   * `presentation` pour qu'aucun appelant ne puisse résoudre l'une sans l'autre ;
   * `presentationDuSalon` est le seul endroit qui les assemble.
   */
  presentationParGenerateur: boolean;
}

async function lireReglagesAdmin(guildId: string): Promise<ReglagesModule> {
  // try/catch et non `.catch()` : un modele absent du client fait lever
  // `.findUnique` de maniere SYNCHRONE, avant meme qu'une promesse existe - le
  // `.catch()` ne l'aurait jamais vu.
  let ligne: Awaited<ReturnType<typeof prisma.tempVoiceModPermissionsConfig.findUnique>> = null;
  try {
    ligne = await prisma.tempVoiceModPermissionsConfig.findUnique({ where: { guildId } });
  } catch (err) {
    // Une lecture qui echoue n'est pas une absence de reglage : on retombe sur
    // le comportement d'avant la refonte pour ne pas priver le staff de ses
    // boutons pendant une panne, mais on le DIT - sans cette ligne, un panneau
    // tout permis pendant une coupure de base serait indiscernable d'un serveur
    // qui n'a jamais ouvert l'onglet.
    logger.warn('TempVoice', `Reglages moderateur illisibles pour ${guildId}, repli sur « tout autorise » :`, err);
    return {
      reglages: normaliserReglagesAdmin(undefined),
      panneauCompact: false,
      reservation: normaliserConfigReservation(undefined),
      // Une panne de base ne doit pas changer la tete du panneau : on rend le
      // comportement livre, et l'echec est deja dit juste au-dessus.
      presentation: { ...PRESENTATION_PAR_DEFAUT },
      // Interrupteur coupe : une lecture en panne ne doit surtout pas ALLUMER la
      // personnalisation par generateur. Le sens du repli va vers le
      // comportement actuel, jamais vers le nouveau.
      presentationParGenerateur: false,
    };
  }
  if (!ligne) {
    return {
      reglages: normaliserReglagesAdmin(undefined),
      panneauCompact: false,
      reservation: normaliserConfigReservation(undefined),
      presentation: { ...PRESENTATION_PAR_DEFAUT },
      // Aucune ligne = serveur qui n'a jamais ouvert l'onglet : rien de
      // personnalise, comme avant cette colonne.
      presentationParGenerateur: false,
    };
  }

  return {
    reglages: normaliserReglagesAdmin({
      renommer: ligne.canRename,
      limite: ligne.canChangeLimit,
      verrouiller: ligne.canLock,
      modeEcriture: ligne.canChangeWriteMode,
      reserver: ligne.canReserve,
      expulserBannir: ligne.canKickOrBan,
      transferer: ligne.canTransfer,
    }),
    // Aucune ligne, ou une lecture qui échoue : le mode empilé, celui qui a été
    // livré. Personne n'a demandé qu'on lui change sa présentation.
    panneauCompact: ligne.panelCompactMode === true,
    reservation: normaliserConfigReservation(ligne),
    // La ligne Prisma porte les cinq colonnes sous leurs noms de base
    // (`panelMode`, `stateLayout`, ...) : le service sait lire les deux formes
    // et borne chaque champ a son enumeration, defaut compris.
    presentation: normaliserReglagesPresentation(ligne),
    // Lu sur la MEME ligne, par le meme service : `perGeneratorPresentation`.
    // Tout ce qui n'est pas exactement `true` vaut faux, colonne absente comprise
    // — le client Prisma peut precéder la migration sans que rien ne bascule.
    presentationParGenerateur: presentationParGenerateurActive(ligne),
  };
}

/**
 * Configuration des demandes d'accès du serveur, écrite par le dashboard.
 *
 * Aucune ligne vaut `activees: false` : c'est le comportement d'avant la
 * refonte, aucun bouton nulle part. Les défauts du schéma, eux, ne valent qu'à
 * la création de la ligne - les appliquer à une absence poserait un bouton sur
 * tous les salons verrouillés de tous les serveurs dès le premier déploiement.
 */
async function lireConfigDemandes(guildId: string): Promise<ConfigDemandesAcces> {
  // try/catch et non `.catch()`, pour la même raison que `lireReglagesAdmin` :
  // un modèle absent du client fait lever `.findUnique` de manière SYNCHRONE.
  let ligne: Awaited<ReturnType<typeof prisma.tempVoiceAccessRequestConfig.findUnique>> = null;
  try {
    ligne = await prisma.tempVoiceAccessRequestConfig.findUnique({ where: { guildId } });
  } catch (err) {
    // Le repli est le même qu'une absence de ligne, mais il se dit : sinon une
    // coupure de base est indiscernable d'un serveur qui n'a jamais activé les
    // demandes, et le bouton disparaît sans que personne ne sache pourquoi.
    logger.warn('TempVoice', `Config des demandes d'accès illisible pour ${guildId}, repli sur « désactivées » :`, err);
    return { ...CONFIG_DEMANDES_PAR_DEFAUT };
  }
  if (!ligne) return { ...CONFIG_DEMANDES_PAR_DEFAUT };

  return normaliserConfigDemandes(ligne);
}

/** Qui clique, du point de vue de la matrice de permissions. */
async function roleAgissant(
  guildId: string,
  membre: GuildMember | null,
  proprietaireId: string,
): Promise<RoleAgissant> {
  if (membre && membre.id === proprietaireId) return 'proprietaire';
  if (membre?.permissions.has(PermissionFlagsBits.Administrator)) return 'admin';
  if (membre && membre.id === membre.guild.ownerId) return 'admin';
  return 'moderateur';
}

// ─────────────────────────────────────────────────────────────────────────────
// Réécriture du panneau, anti-rebond de 2 s par salon
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Espacement minimal entre deux reecritures d'un meme panneau.
 *
 * Discord plafonne les editions a cinq par tranche de cinq secondes et par
 * salon. Une seconde laisse donc quatre fois la marge, tout en restant
 * imperceptible : le premier changement s'affiche sans delai, et le suivant au
 * plus tard une seconde apres.
 */
const ESPACEMENT_REECRITURE_MS = 1_000;

interface EtatReecriture {
  /** Une reecriture est en cours : la suivante attend qu'elle finisse. */
  enCours: boolean;
  /** Un changement est arrive depuis : il faudra repasser. */
  sale: boolean;
  /** Fin de la derniere reecriture, pour tenir l'espacement. */
  dernierePassee: number;
  minuteur?: ReturnType<typeof setTimeout>;
}

const rafraichissements = new Map<string, EtatReecriture>();

function etatReecriture(salonId: string): EtatReecriture {
  const existant = rafraichissements.get(salonId);
  if (existant) return existant;
  const neuf: EtatReecriture = { enCours: false, sale: false, dernierePassee: 0 };
  rafraichissements.set(salonId, neuf);
  return neuf;
}

/**
 * Le panneau dit l'etat du salon : le laisser mentir une seconde de plus que
 * necessaire est le seul vrai defaut qu'il puisse avoir.
 *
 * Pas de fenetre fixe. Le premier changement part **immediatement** ; ceux qui
 * arrivent pendant une reecriture marquent le panneau « sale » et declenchent un
 * second passage des que le premier finit, en respectant l'espacement minimal.
 * Une rafale se replie donc toute seule, sans jamais faire attendre un
 * changement plus longtemps que cet espacement.
 *
 * L'ancienne fenetre de coalescence faisait patienter le DEUXIEME clic jusqu'a
 * sa fermeture : verrouiller puis deverrouiller laissait « Verrouille » affiche
 * une seconde et demie apres coup.
 */
function planifierRafraichissementPanneau(channel: VoiceChannel): void {
  const etat = etatReecriture(channel.id);

  if (etat.enCours) {
    etat.sale = true;
    return;
  }
  if (etat.minuteur) return;

  const attente = Math.max(0, ESPACEMENT_REECRITURE_MS - (Date.now() - etat.dernierePassee));
  if (attente === 0) {
    void executerReecriture(channel, etat);
    return;
  }

  const minuteur = setTimeout(() => {
    etat.minuteur = undefined;
    void executerReecriture(channel, etat);
  }, attente);
  // Un minuteur en attente garderait le process en vie : le panneau n'est pas
  // une raison de ne pas s'arreter.
  (minuteur as unknown as { unref?: () => void }).unref?.();
  etat.minuteur = minuteur;
}

async function executerReecriture(channel: VoiceChannel, etat: EtatReecriture): Promise<void> {
  etat.enCours = true;
  etat.sale = false;
  try {
    await lancerReecriture(channel);
  } finally {
    etat.enCours = false;
    etat.dernierePassee = Date.now();
    // Un changement est arrive pendant la reecriture : il a droit a son passage,
    // au plus tot que l'espacement autorise.
    if (etat.sale) planifierRafraichissementPanneau(channel);
  }
}

function lancerReecriture(channel: VoiceChannel): Promise<void> {
  return reecrirePanneau(channel).catch((err: unknown) => {
    logger.warn('TempVoice', `Impossible de réécrire le panneau de ${channel.id} :`, err);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Durées, rendues dans la langue du serveur comme tout le panneau
// ─────────────────────────────────────────────────────────────────────────────

function formaterDuree(ms: number, locale: BotLocale): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return m.panel_tempvoice_duration_min({ count: minutes }, { locale });
  const heures = Math.round(minutes / 60);
  if (heures < 24) return m.panel_tempvoice_duration_hour({ count: heures }, { locale });
  const jours = Math.round(heures / 24);
  if (jours < 31) {
    return jours > 1
      ? m.panel_tempvoice_duration_days({ count: jours }, { locale })
      : m.panel_tempvoice_duration_day({ count: jours }, { locale });
  }
  const mois = Math.round(jours / 30);
  if (mois < 12) {
    return mois > 1
      ? m.panel_tempvoice_duration_months({ count: mois }, { locale })
      : m.panel_tempvoice_duration_month({ count: mois }, { locale });
  }
  const annees = Math.round(mois / 12);
  return annees > 1
    ? m.panel_tempvoice_duration_years({ count: annees }, { locale })
    : m.panel_tempvoice_duration_year({ count: annees }, { locale });
}

/** Le nom lisible d'un droit Discord. La table ne porte que la CLÉ du message :
 *  le texte, lui, est rendu à l'appel, dans la langue du serveur. */
const CLES_PERMISSIONS: Readonly<Record<string, (inputs: Record<string, never>, options: { locale: BotLocale }) => string>> = {
  [String(PermissionFlagsBits.ManageChannels)]: m.panel_tempvoice_perm_managechannels,
  [String(PermissionFlagsBits.MoveMembers)]: m.panel_tempvoice_perm_movemembers,
  [String(PermissionFlagsBits.MuteMembers)]: m.panel_tempvoice_perm_mutemembers,
  [String(PermissionFlagsBits.DeafenMembers)]: m.panel_tempvoice_perm_deafenmembers,
  [String(PermissionFlagsBits.ManageMessages)]: m.panel_tempvoice_perm_managemessages,
  [String(PermissionFlagsBits.SendMessages)]: m.panel_tempvoice_perm_sendmessages,
  [String(PermissionFlagsBits.ReadMessageHistory)]: m.panel_tempvoice_perm_readmessagehistory,
  [String(PermissionFlagsBits.ManageRoles)]: m.panel_tempvoice_perm_manageroles,
  [String(PermissionFlagsBits.ViewChannel)]: m.panel_tempvoice_perm_viewchannel,
  [String(PermissionFlagsBits.Connect)]: m.panel_tempvoice_perm_connect,
  [String(PermissionFlagsBits.Speak)]: m.panel_tempvoice_perm_speak,
};

/** Droits manquants au bot : Discord refuse un salon dont une surcharge accorde
 *  un droit que le bot n'a pas lui-même, la liste suit donc les pouvoirs cochés. */
function missingBotPermissions(
  guild: DiscordGuild,
  policy: TempVoicePolicy,
  locale: BotLocale,
  parent?: CategoryChannel,
): string[] {
  const me = guild.members.me;
  // Membre bot non résolu : aucun droit ne peut être confirmé, donc tous sont
  // déclarés manquants - une vérification censée fermer la porte ne l'ouvre pas.
  const effective = me ? (parent ? parent.permissionsFor(me) : me.permissions) : null;

  return requiredBotPermissions(policy)
    .filter((permission) => !effective?.has(permission))
    .map((permission) => CLES_PERMISSIONS[String(permission)]?.({}, { locale }) ?? String(permission));
}

async function isStaff(guildId: string, member: GuildMember | null): Promise<boolean> {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (member.id === member.guild.ownerId) return true;

  const guildConfig = await getCachedGuild(guildId);
  if (!guildConfig) return false;

  return Boolean(
    (guildConfig.baseStaffRoleId && member.roles.cache.has(guildConfig.baseStaffRoleId)) ||
    (guildConfig.moderatorRoleId && member.roles.cache.has(guildConfig.moderatorRoleId)) ||
    (guildConfig.testStaffRoleId && member.roles.cache.has(guildConfig.testStaffRoleId)),
  );
}

async function isProtectedTarget(guildId: string, target: GuildMember): Promise<boolean> {
  if (target.id === process.env.DISCORD_CLIENT_OWNER_ID) return true;
  return isStaff(guildId, target);
}

async function closeTempChannel(channel: VoiceChannel, reason: string): Promise<boolean> {
  // Discord d'abord : l'état n'est purgé que si la suppression a abouti, sans
  // quoi un salon refusé survivrait sans que rien ne le référence - pas même le
  // balayage, qui lit la base.
  const deleted = await channel.delete(reason).then(() => true).catch((err: unknown) => {
    logger.warn('TempVoice', `Impossible de supprimer le salon ${channel.id} :`, err);
    return false;
  });

  if (!deleted) return false;

  tempChannels.delete(channel.id);
  // Un salon temporaire disparaît ; ses demandes en attente, ses marques
  // d'origine et son historique de renommage aussi, sans laisser de ligne
  // orpheline que plus rien ne référencerait.
  oublierSalon(channel.guild?.id ?? '', channel.id);
  await prisma.tempVoiceChannel.delete({ where: { id: channel.id } }).catch(() => null);
  return true;
}

/**
 * Les surcharges de présence d'un salon repris au démarrage.
 *
 * @everyone, le propriétaire et le bot portent des surcharges de mode, pas de
 * présence : en `ownerOnly` le propriétaire a `SendMessages` sans `Connect`,
 * exactement la forme d'une marque de présence. Les compter ici lui retirerait
 * la parole chez lui.
 */
function surchargesMembresLues(channel: VoiceChannel, proprietaireId: string): SurchargeMembreLue[] {
  const everyoneId = channel.guild?.id ?? '';
  const botId = channel.guild?.members?.me?.id ?? '';
  const lues: SurchargeMembreLue[] = [];

  for (const [cibleId, surcharge] of channel.permissionOverwrites?.cache ?? []) {
    if (cibleId === everyoneId || cibleId === proprietaireId || cibleId === botId) continue;
    const type = (surcharge as { type?: number }).type;
    if (type !== undefined && type !== OverwriteType.Member) continue;
    lues.push({
      userId: cibleId,
      accordeEcriture: Boolean(surcharge.allow?.has(PermissionFlagsBits.SendMessages)),
      accordeConnexion: Boolean(surcharge.allow?.has(PermissionFlagsBits.Connect)),
    });
  }

  return lues;
}

/**
 * Le registre d'origines est en mémoire : après un redémarrage, les surcharges
 * de présence posées avant n'ont plus personne pour les retirer quand les gens
 * quittent le vocal. Le salon affiche « Personne » pendant que plusieurs
 * membres écrivent encore.
 */
async function reparerPresencesAuDemarrage(
  channel: VoiceChannel,
  guildId: string,
  entree: EntreeSalonTemporaire,
): Promise<void> {
  const plan = nettoyagePresenceAuDemarrage(
    modeDuSalon(channel, entree),
    surchargesMembresLues(channel, entree.creatorId),
    [...(channel.members?.keys() ?? [])],
  );

  for (const membreId of plan.aRetirer) {
    await poserSurcharge(channel, membreId, { ...PATCH_PRESENCE_RETIREE });
  }
  for (const membreId of plan.aMarquerPresence) {
    originesSurcharge.marquer(guildId, channel.id, membreId, 'presence');
  }
}

async function sweepOrphanChannels(client: Client): Promise<void> {
  const guildIds = [...client.guilds.cache.keys()];
  if (guildIds.length === 0) return;

  const stored = await prisma.tempVoiceChannel
    .findMany({ where: { guildId: { in: guildIds } } })
    .catch((err: unknown) => {
      logger.error('TempVoice', 'Erreur lors de la lecture des salons temporaires :', err);
      return [] as Array<{
        id: string;
        creatorId: string;
        guildId: string;
        writeMode: string | null;
        renameHistory: unknown;
        accessRequests: unknown;
      }>;
    });

  let restored = 0;
  let removed = 0;

  let skipped = 0;

  for (const entry of stored) {
    const guild = client.guilds.cache.get(entry.guildId);

    // Un serveur indisponible (panne Discord) reste en cache, mais sans ses
    // salons : conclure « le salon n'existe plus » effacerait la ligne en base
    // alors que le salon, lui, existe toujours. Plus rien ne le référencerait,
    // et il ne serait jamais nettoyé.
    if (!guild || guild.available === false) {
      skipped += 1;
      continue;
    }

    const channel = guild.channels.cache.get(entry.id);

    if (!channel || channel.type !== ChannelType.GuildVoice) {
      tempChannels.delete(entry.id);
      oublierSalon(entry.guildId, entry.id);
      await prisma.tempVoiceChannel
        .delete({ where: { id: entry.id } })
        .catch((err: unknown) => logger.error('TempVoice', 'Impossible de supprimer la ligne du salon temporaire :', err));
      removed += 1;
      continue;
    }

    if (channel.members.size === 0) {
      const locale = await resolveGuildLocale(channel.guild?.id ?? '', channel.guild?.preferredLocale ?? null);
      await closeTempChannel(channel, m.panel_tempvoice_audit_empty_startup({}, { locale }));
      removed += 1;
      continue;
    }

    // « Ceux qui sont en vocal » ne se relit dans aucune surcharge : sans la
    // colonne, il redevenait « ouvert » au redémarrage et ses surcharges de
    // présence restaient derrière lui. `null` = salon d'avant la colonne, le
    // mode reste déduit.
    // Le generateur d'origine reprend avec le salon : sans lui, un redemarrage
    // ramenait tous les salons a la presentation du serveur alors que leur ligne
    // en base savait encore de quel generateur ils venaient. Le `as` tient au
    // client Prisma genere qui peut preceder la migration
    // `..._temp_voice_generator_channel` ; `undefined` vaut alors « salon
    // d'avant la colonne », c'est-a-dire l'heritage du serveur.
    const generateurStocke = (entry as { generatorChannelId?: string | null }).generatorChannelId;

    const entree: EntreeSalonTemporaire = {
      creatorId: entry.creatorId,
      ...(estModeEcriture(entry.writeMode) ? { modeEcriture: entry.writeMode } : {}),
      ...(typeof generateurStocke === 'string' ? { generateurId: generateurStocke } : {}),
    };
    tempChannels.set(entry.id, entree);

    // Le quota de renommage et les demandes d'acces reprennent ou ils en
    // etaient. Ce qui a expire pendant l'arret n'est pas recharge : le temps a
    // continue de passer sans le bot.
    const maintenant = Date.now();
    const historique = normaliserHistoriqueRenommage(entry.renameHistory, maintenant);
    if (historique.length > 0) historiquesRenommage.set(entry.id, historique);
    registreDemandes.importerSalon(entry.guildId, entry.id, entry.accessRequests, maintenant);

    await reparerPresencesAuDemarrage(channel, entry.guildId, entree);
    restored += 1;
  }

  logger.success(
    'TempVoice',
    `${restored} salon(s) temporaire(s) repris, ${removed} nettoyé(s) au démarrage`
      + (skipped > 0 ? `, ${skipped} laissé(s) de côté (serveur indisponible).` : '.'),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Carte d'état
// ─────────────────────────────────────────────────────────────────────────────

interface EtatSalon {
  proprietaireId: string;
  proprietairePresent: boolean;
  verrouille: boolean;
  reserveRoleId: string | null;
  occupants: number;
  /** 0 = illimité, comme Discord. */
  limite: number;
  /** `null` quand il n'y a pas de limite : « complet » n'a alors pas de sens. */
  placesLibres: number | null;
  complet: boolean;
  modeEcriture: ModeEcriture;
  autorises: number;
  bannis: number;
}

/** Un salon tout juste créé n'a encore ni membres ni surcharges en cache : tout
 *  se lit en tolérant l'absence, sinon la première carte lèverait avant d'être postée. */
async function lireEtatSalon(channel: VoiceChannel, entree: EntreeSalonTemporaire): Promise<EtatSalon> {
  const proprietaireId = entree.creatorId;
  const everyoneId = channel.guild?.id ?? '';
  const botId = channel.guild?.members?.me?.id ?? '';

  const surcharges = channel.permissionOverwrites?.cache;
  const surchargeEveryone = everyoneId ? surcharges?.get(everyoneId) : undefined;
  const surchargeProprietaire = surcharges?.get(proprietaireId);

  const verrouille = Boolean(surchargeEveryone?.deny?.has(PermissionFlagsBits.Connect));

  let autorises = 0;
  let bannis = 0;
  for (const [cible, surcharge] of surcharges ?? []) {
    if (cible === everyoneId || cible === proprietaireId || cible === botId) continue;
    // Les tests posent des surcharges sans type ; Discord, lui, en donne
    // toujours un. Un type connu qui n'est pas « membre » sort du compte.
    const type = (surcharge as { type?: number }).type;
    if (type !== undefined && type !== OverwriteType.Member) continue;
    if (surcharge.deny?.has(PermissionFlagsBits.ViewChannel)) bannis += 1;
    else if (surcharge.allow?.has(PermissionFlagsBits.Connect)) autorises += 1;
  }

  const stocke = await prisma.tempVoiceChannel.findUnique({ where: { id: channel.id } }).catch(() => null);

  const limite = channel.userLimit ?? 0;
  const occupants = channel.members?.size ?? 0;
  const placesLibres = limite > 0 ? Math.max(0, limite - occupants) : null;

  return {
    proprietaireId,
    proprietairePresent: channel.members?.has(proprietaireId) ?? false,
    verrouille,
    reserveRoleId: stocke?.roleId ?? null,
    occupants,
    limite,
    placesLibres,
    complet: placesLibres === 0,
    modeEcriture: entree.modeEcriture ?? deduireModeEcriture(surchargeEveryone, surchargeProprietaire),
    autorises,
    bannis,
  };
}

type SurchargeLue = { allow?: { has(bit: bigint): boolean }; deny?: { has(bit: bigint): boolean } } | undefined;

/**
 * Trois des quatre modes se lisent dans les surcharges. « Ceux qui sont en
 * vocal » n'en porte aucune trace : @everyone y est refusé et le propriétaire
 * n'a pas d'`allow` nommé, ce qui est exactement la forme de « Personne » — il
 * est donc rangé là. C'est `TempVoiceChannel.writeMode` qui le distingue, et
 * cette déduction ne sert plus qu'aux salons créés avant la colonne.
 */
function deduireModeEcriture(everyone: SurchargeLue, proprietaire: SurchargeLue): ModeEcriture {
  if (!everyone?.deny?.has(PermissionFlagsBits.SendMessages)) return MODE_ECRITURE_PAR_DEFAUT;
  return proprietaire?.allow?.has(PermissionFlagsBits.SendMessages) ? 'ownerOnly' : 'nobody';
}

/** « 4 places libres », « complet », « places illimitées ». */
function resteEnClair(etat: EtatSalon, locale: BotLocale): string {
  if (etat.placesLibres === null) return m.panel_tempvoice_slots_unlimited({}, { locale });
  if (etat.placesLibres === 0) return m.panel_tempvoice_slots_full({}, { locale });
  return etat.placesLibres > 1
    ? m.panel_tempvoice_slots_free({ count: etat.placesLibres }, { locale })
    : m.panel_tempvoice_slots_free_one({ count: etat.placesLibres }, { locale });
}

/**
 * La carte d'etat, telle que la maquette la dessine : six champs en grille.
 *
 * ⚠️ Discord range les champs « inline » en trois colonnes sur ordinateur et les
 * empile, un par ligne, sur telephone. Ce n'est pas un reglage : il decide seul
 * selon la largeur. La grille est donc assumee — elle vaut pour ce qu'elle rend
 * sur ordinateur, ou le panneau est lu la plupart du temps.
 *
 * Tout mettre dans la description rendrait pareil des deux cotes, mais perdrait
 * la grille. Essaye et compare avant de rechanger : ca a deja ete fait, et la
 * grille a gagne.
 */
function carteEtat(etat: EtatSalon, locale: BotLocale): EmbedBuilder {
  const mode = libelleModeEcriture(etat.modeEcriture, locale);
  const etatEnClair = etat.verrouille
    ? m.panel_tempvoice_state_locked({}, { locale })
    : m.panel_tempvoice_state_open({}, { locale });

  return carteSansValeurs(etat, locale)
    .addFields(
      { name: m.panel_tempvoice_field_status({}, { locale }), value: `${etat.verrouille ? I.lock : I.unlock} ${etatEnClair}`, inline: true },
      { name: m.panel_tempvoice_field_slots({}, { locale }), value: `${I.profile} ${etat.occupants} / ${etat.limite > 0 ? etat.limite : '∞'}`, inline: true },
      { name: m.panel_tempvoice_field_chat({}, { locale }), value: `${iconeModeCarte(etat.modeEcriture)} ${mode.libelle}`, inline: true },
      { name: m.panel_tempvoice_field_allowed({}, { locale }), value: `${I.check} ${etat.autorises}`, inline: true },
      { name: m.panel_tempvoice_field_banned({}, { locale }), value: `${I.ban} ${etat.bannis}`, inline: true },
      {
        name: m.panel_tempvoice_field_reserved({}, { locale }),
        value: etat.reserveRoleId
          ? `${I.shield} <@&${etat.reserveRoleId}>`
          : `${I.shield} ${m.panel_tempvoice_reserved_no({}, { locale })}`,
        inline: true,
      },
    );
}

/** Le contour de la carte — titre, mention, couleur, pied — sans les six valeurs :
 *  les champs inline et l'image se posent dessus, à l'identique. */
function carteSansValeurs(etat: EtatSalon, locale: BotLocale): EmbedBuilder {
  const etatEnClair = etat.verrouille
    ? m.panel_tempvoice_state_locked({}, { locale })
    : m.panel_tempvoice_state_open({}, { locale });

  return new EmbedBuilder()
    .setTitle(`${etat.verrouille ? I.lock : I.unlock} ${etatEnClair} · ${resteEnClair(etat, locale)}`)
    // Le ping va ici, jamais dans le titre : Discord n'interprète les mentions
    // ni dans un titre ni dans une ligne d'auteur, elles s'y afficheraient en
    // brut. Seules la description et la valeur d'un champ les rendent cliquables.
    .setDescription(`${I.voice} ${m.panel_tempvoice_card_owner({ owner: etat.proprietaireId }, { locale })}`)
    .setColor(etat.verrouille ? COULEUR_FERME : COULEUR_OUVERT)
    .setFooter({ text: m.panel_tempvoice_card_footer({}, { locale }) })
    .setTimestamp();
}

/**
 * Le nom de FICHIER de l'icône du champ « Écriture », pour le rendu image.
 *
 * `iconeModeCarte` rend le markup `<:ktb_msg:123>` d'un emoji d'application :
 * le canevas, lui, ouvre un PNG sur disque. Les deux jeux disent la même chose
 * et ne se remplacent pas l'un l'autre.
 */
const FICHIER_ICONE_MODE: Readonly<Record<ModeEcriture, string>> = {
  everyone: 'ktb_msg',
  inVoice: 'ktb_voice',
  ownerOnly: 'ktb_crown',
  nobody: 'ktb_mute',
};

/** Les six valeurs dans l'ordre exact qu'attend `rendreEtatPng` :
 *  État, Places, Écriture, Autorisés, Bannis, Réservé. */
function valeursEtat(etat: EtatSalon, nomRoleReserve: string | null, locale: BotLocale): ValeurEtat[] {
  return [
    {
      libelle: m.panel_tempvoice_field_status({}, { locale }),
      valeur: etat.verrouille
        ? m.panel_tempvoice_state_locked({}, { locale })
        : m.panel_tempvoice_state_open({}, { locale }),
      icone: etat.verrouille ? 'ktb_lock' : 'ktb_unlock',
    },
    { libelle: m.panel_tempvoice_field_slots({}, { locale }), valeur: `${etat.occupants} / ${etat.limite > 0 ? etat.limite : '∞'}`, icone: 'ktb_profile' },
    { libelle: m.panel_tempvoice_field_chat({}, { locale }), valeur: libelleModeEcriture(etat.modeEcriture, locale).libelle, icone: FICHIER_ICONE_MODE[etat.modeEcriture] },
    { libelle: m.panel_tempvoice_field_allowed({}, { locale }), valeur: String(etat.autorises), icone: 'ktb_check' },
    { libelle: m.panel_tempvoice_field_banned({}, { locale }), valeur: String(etat.bannis), icone: 'ktb_ban' },
    // Jamais `<@&id>` ici : une image ne résout aucune mention, elle
    // afficherait la syntaxe brute. Le nom du rôle, sinon « Non ».
    {
      libelle: m.panel_tempvoice_field_reserved({}, { locale }),
      valeur: nomRoleReserve ?? m.panel_tempvoice_reserved_no({}, { locale }),
      icone: 'ktb_shield',
    },
  ];
}

/**
 * La carte d'état part-elle en embed à six champs inline, comme aujourd'hui ?
 *
 * `dispositionNative` ne reconnaît que GRID3 en V1, au motif que Discord n'a
 * aucun composant de colonnes en Components V2. C'est exact — mais le panneau
 * LIVRÉ est déjà servi en V2 (`patchV2` convertit tout, sans bascule) avec ces
 * six champs inline et sans aucune image. Le défaut de la base est donc
 * GRID3 + V2, et s'en remettre à `dispositionNative` seul ferait basculer en
 * PNG tous les serveurs déjà en service au simple déploiement — la présentation
 * changerait sans que personne ne l'ait demandé, et chaque réécriture de
 * panneau enverrait ~30 Ko d'image qui n'existaient pas.
 *
 * Règle retenue : l'image n'apparaît que lorsqu'un administrateur a réellement
 * choisi une disposition ou une teinte AUTRE que celle livrée. Les deux
 * comparaisons se font contre `PRESENTATION_PAR_DEFAUT` plutôt que contre des
 * littéraux, pour qu'un changement de défaut n'ait pas à être répercuté ici.
 */
function etatRenduNativement(presentation: ReglagesPresentation): boolean {
  return dispositionNative(presentation)
    || (presentation.disposition === PRESENTATION_PAR_DEFAUT.disposition
      && presentation.teinte === PRESENTATION_PAR_DEFAUT.teinte);
}

/**
 * La carte d'état rendue en image, pour toute disposition que Discord ne sait
 * pas ranger nativement (voir `etatRenduNativement`).
 *
 * ⚠️ Le nom du fichier est NEUF à chaque rendu (`nomFichierEtat` compte) :
 * Discord met les pièces jointes en cache par nom, et réutiliser le même nom
 * ressert l'ancienne image — le réglage paraît alors inopérant.
 */
async function carteEtatImage(
  channel: VoiceChannel,
  etat: EtatSalon,
  presentation: ReglagesPresentation,
  locale: BotLocale,
): Promise<{ embed: EmbedBuilder; piece: AttachmentBuilder }> {
  const nomRole = etat.reserveRoleId
    ? channel.guild?.roles?.cache?.get?.(etat.reserveRoleId)?.name
      ?? m.panel_tempvoice_role_unknown({}, { locale })
    : null;

  const valeurs = valeursEtat(etat, nomRole, locale);
  const png = await rendreEtatPng(valeurs, presentation.disposition, presentation.teinte);
  const nom = nomFichierEtat({
    salonId: channel.id,
    disposition: presentation.disposition,
    teinte: presentation.teinte,
  });

  return {
    embed: carteSansValeurs(etat, locale).setImage(`attachment://${nom}`),
    piece: new AttachmentBuilder(png, { name: nom }),
  };
}

/**
 * Trois portes pour tout le monde, plus une quatrième quand le salon est fermé.
 *
 * Un message Discord ne porte qu'un seul jeu de composants : le propriétaire,
 * un modérateur et un inconnu voient rigoureusement la même rangée. Ce qui
 * varie n'est donc pas la personne mais l'état du salon ; le tri entre les
 * personnes se fait au clic.
 */
function rangeePrincipale(
  etat: EtatSalon,
  demandes: ConfigDemandesAcces,
  locale: BotLocale,
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  const boutons: ButtonBuilder[] = [
    avecIcone(new ButtonBuilder().setCustomId('tempvoice:salon').setLabel(m.panel_tempvoice_tab_channel({}, { locale })).setStyle(ButtonStyle.Secondary), I.settings),
    avecIcone(new ButtonBuilder().setCustomId('tempvoice:membres').setLabel(m.panel_tempvoice_tab_members({}, { locale })).setStyle(ButtonStyle.Secondary), I.profile),
    avecIcone(new ButtonBuilder().setCustomId('tempvoice:propriete').setLabel(m.panel_tempvoice_tab_ownership({}, { locale })).setStyle(ButtonStyle.Secondary), I.crown),
  ];

  // Sur un salon simplement *plein*, demander l'accès ne changerait rien :
  // c'est une place qui manque, pas une permission. Et le bouton n'existe pas
  // du tout tant qu'un administrateur ne l'a pas activé. La règle est dans le
  // service, pas recopiée ici.
  if (boutonDemanderAccesVisible({ verrouille: etat.verrouille, reserve: etat.reserveRoleId !== null }, demandes)) {
    boutons.push(
      avecIcone(
        new ButtonBuilder().setCustomId('tempvoice:demander').setLabel(m.panel_tempvoice_btn_request_access({}, { locale })).setStyle(ButtonStyle.Primary),
        I.unlock,
      ),
    );
  }

  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...boutons);
}

function rangee(
  ...composants: MessageActionRowComponentBuilder[]
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...composants);
}

/**
 * Mode FLAT : le message PUBLIC porte tout, et rien ne s'ouvre pour agir.
 *
 * Contraintes de Discord qui dessinent la composition : cinq rangées au plus,
 * cinq boutons par rangée, et un menu occupe sa rangée entière — on ne mélange
 * pas boutons et menu. D'où quatre rangées :
 *
 *   1. les actions du salon : verrou, limite, renommer, réserver, et
 *      « Demander l'accès » quand le salon est fermé (cinq au maximum) ;
 *   2. « Propriété » et « Réglages », qui ouvrent les éphémères existants ;
 *   3. le menu du mode d'écriture ;
 *   4. le menu des membres PRÉSENTS en vocal, omis quand il n'y a personne —
 *      un menu sans option fait rejeter le message entier.
 *
 * ⚠️ AUCUN `UserSelectMenu` ici : pas de recherche dans le serveur, les actions
 * ne visent que les présents. Et le menu des réglages modérateur n'y est pas
 * non plus — il est réservé aux admins, alors que ce message est lu par tout le
 * monde ; le bouton « Réglages » ouvre l'éphémère qui le porte déjà.
 *
 * Les boutons ne sont pas grisés selon la personne : un message public ne porte
 * qu'un seul jeu de composants pour tout le serveur, et c'est le clic qui trie.
 */
function rangeesPlates(
  channel: VoiceChannel,
  etat: EtatSalon,
  demandes: ConfigDemandesAcces,
  locale: BotLocale,
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const maintenant = Date.now();
  const quota = quotaRenommage(historiqueRenommage(channel.id), maintenant);

  const actions: ButtonBuilder[] = [
    avecIcone(
      new ButtonBuilder()
        .setCustomId('tempvoice:bascule_verrou')
        .setLabel(etat.verrouille
          ? m.panel_tempvoice_state_locked({}, { locale })
          : m.panel_tempvoice_state_open({}, { locale }))
        .setStyle(etat.verrouille ? ButtonStyle.Danger : ButtonStyle.Success),
      etat.verrouille ? I.lock : I.unlock,
    ),
    avecIcone(
      new ButtonBuilder()
        .setCustomId('tempvoice:limit')
        .setLabel(m.panel_tempvoice_btn_limit({
          value: etat.limite > 0 ? etat.limite : m.panel_tempvoice_limit_unlimited({}, { locale }),
        }, { locale }))
        .setStyle(ButtonStyle.Primary),
      I.profile,
    ),
    // `libelleRenommer` porte déjà son ✏️ : l'icône « renommer » manque au jeu `ktb_`.
    new ButtonBuilder()
      .setCustomId('tempvoice:rename')
      .setLabel(libelleRenommer(quota, maintenant, locale))
      .setStyle(ButtonStyle.Primary)
      .setDisabled(quota.restants === 0),
    avecIcone(
      new ButtonBuilder()
        .setCustomId('tempvoice:reserve')
        .setLabel(libelleReserveGenerique(etat, locale))
        .setStyle(ButtonStyle.Secondary),
      I.shield,
    ),
  ];

  if (boutonDemanderAccesVisible({ verrouille: etat.verrouille, reserve: etat.reserveRoleId !== null }, demandes)) {
    actions.push(
      avecIcone(
        new ButtonBuilder().setCustomId('tempvoice:demander').setLabel(m.panel_tempvoice_btn_request_access({}, { locale })).setStyle(ButtonStyle.Primary),
        I.unlock,
      ),
    );
  }

  const rangees = [
    rangee(...actions),
    rangee(
      avecIcone(
        new ButtonBuilder().setCustomId('tempvoice:propriete').setLabel(m.panel_tempvoice_tab_ownership({}, { locale })).setStyle(ButtonStyle.Secondary),
        I.crown,
      ),
      avecIcone(
        new ButtonBuilder().setCustomId('tempvoice:reglages').setLabel(m.panel_tempvoice_btn_settings({}, { locale })).setStyle(ButtonStyle.Secondary),
        I.settings,
      ),
    ),
    rangee(menuModeEcriture(etat, true, locale)),
  ];

  // Les bots occupent des places dans la liste sans qu'aucune action du panneau
  // ait de sens sur eux.
  const presents = [...(channel.members?.values() ?? [])].filter((membre) => !membre.user?.bot);
  if (presents.length > 0) {
    rangees.push(rangee(menuMembresPresents(presents.slice(0, MAX_OPTIONS_MENU), presents.length, locale)));
  }

  return rangees;
}

interface PanneauRendu {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
  /** La carte d'état en image, quand la disposition n'est pas rendue
   *  nativement par Discord. Absente dans le seul cas natif (GRID3 en V1). */
  files?: AttachmentBuilder[];
}

/**
 * Le panneau public, plus les réglages qui ont décidé de sa forme.
 *
 * La présentation ressort avec le rendu parce que les deux appelants en ont
 * besoin pour composer leur charge : le jeu de composants décide s'il faut
 * court-circuiter `patchV2`, et la présence d'une image décide s'il faut vider
 * les anciennes pièces jointes. La glisser dans le rendu lui-même la ferait
 * partir vers Discord comme un champ inconnu.
 */
interface PanneauPublic {
  charge: PanneauRendu;
  presentation: ReglagesPresentation;
}

/**
 * LE seul chemin vers la présentation d'un salon donné — le panneau public comme
 * ses sous-panneaux éphémères passent par ici.
 *
 * La règle elle-même n'est pas ici : elle est dans `presentationPourGenerateur`,
 * côté service. Cette fonction ne fait que lui apporter le générateur du salon,
 * et retomber sur le réglage du serveur quand il n'y en a pas à apporter —
 * générateur disparu, configuration illisible, salon d'avant la colonne.
 */
async function presentationDuSalon(
  guildId: string,
  entree: EntreeSalonTemporaire,
  module: Pick<ReglagesModule, 'presentation' | 'presentationParGenerateur'>,
): Promise<ReglagesPresentation> {
  // Économie de lecture, PAS une deuxième règle : interrupteur coupé ou salon
  // sans générateur connu, il n'y a rien à aller chercher.
  // `presentationPourGenerateur` rendrait de toute façon le réglage du serveur
  // dans ces deux cas — ce test ne peut donc jamais changer le résultat.
  if (!module.presentationParGenerateur || !entree.generateurId) return module.presentation;

  const guildConfig = await getCachedGuild(guildId).catch(() => null);
  const generateurs = guildConfig
    ? resolveTempVoiceGenerators(guildConfig as unknown as TempVoiceGuildConfig, guildId)
    : [];

  // `find` peut ne rien rendre : le générateur a pu être retiré de la
  // configuration alors que ses salons vivent encore. L'héritage le traite comme
  // une absence de surcharge, donc le réglage du serveur, sans erreur.
  return presentationPourGenerateur(
    module.presentation,
    generateurs.find((candidat) => candidat.channelId === entree.generateurId),
    module.presentationParGenerateur,
  );
}

/**
 * Le panneau PUBLIC, dans la langue du serveur.
 *
 * C'est ici que la langue est résolue pour tout le rendu public : le salon donne
 * son serveur, donc la cascade `Guild.language` → locale Discord y est lisible.
 * Elle est ensuite passée EN PARAMÈTRE à chaque fonction de rendu — jamais
 * posée dans un état de module : deux serveurs de langues différentes rendent
 * leur panneau dans le même processus, et un état partagé donnerait à l'un la
 * langue de l'autre selon l'ordre des événements.
 */
async function construirePanneau(channel: VoiceChannel, entree: EntreeSalonTemporaire): Promise<PanneauPublic> {
  const guildId = channel.guild?.id ?? '';
  const locale = await resolveGuildLocale(guildId, channel.guild?.preferredLocale ?? null);
  const etat = await lireEtatSalon(channel, entree);
  const demandes = await lireConfigDemandes(guildId);
  const presentation = await presentationDuSalon(guildId, entree, await lireReglagesAdmin(guildId));

  // CLASSIC : les trois portes, exactement comme avant. FLAT : tout sur le
  // message public. Le tri entre les personnes se fait au clic, ici comme là —
  // un message Discord ne porte qu'un seul jeu de composants.
  const components = presentation.mode === 'FLAT'
    ? rangeesPlates(channel, etat, demandes, locale)
    : [rangeePrincipale(etat, demandes, locale)];

  // Le rendu livré (six champs inline) reste celui de tout serveur qui n'a rien
  // réglé : voir `etatRenduNativement`, qui dit pourquoi `dispositionNative` ne
  // suffit pas à le décider seul.
  if (etatRenduNativement(presentation)) {
    return { charge: { embeds: [carteEtat(etat, locale)], components }, presentation };
  }

  try {
    const { embed, piece } = await carteEtatImage(channel, etat, presentation, locale);
    return { charge: { embeds: [embed], components, files: [piece] }, presentation };
  } catch (err) {
    // Un rendu d'image qui échoue ne doit JAMAIS laisser le salon sans panneau :
    // les six champs inline restent lisibles partout, et l'échec se dit.
    logger.warn('TempVoice', `Carte d'état non rendue en image pour ${channel.id}, repli sur les six champs :`, err);
    return { charge: { embeds: [carteEtat(etat, locale)], components }, presentation };
  }
}

/**
 * Retrouve le message du panneau : l'identifiant mémorisé d'abord, sinon le
 * dernier message du bot qui porte un bouton `tempvoice:`.
 *
 * C'est aussi ce qui rattrape les panneaux déjà postés avant la refonte : ils
 * sont retrouvés à la même enseigne, puis réécrits au premier changement.
 */
async function retrouverPanneau(channel: VoiceChannel, entree: EntreeSalonTemporaire): Promise<Message | null> {
  if (entree.panneauId) {
    const connu = await channel.messages?.fetch(entree.panneauId).catch(() => null);
    if (connu) return connu;
    entree.panneauId = undefined;
  }

  const recents = await channel.messages?.fetch({ limit: 25 }).catch(() => null);
  if (!recents) return null;

  const moiId = channel.client?.user?.id;
  for (const [, message] of recents) {
    if (moiId && message.author?.id !== moiId) continue;
    const porteLePanneau = message.components?.some((rangee) =>
      (rangee as { components?: Array<{ customId?: string | null }> }).components?.some(
        (composant) => composant.customId?.startsWith('tempvoice:'),
      ),
    );
    if (porteLePanneau) {
      entree.panneauId = message.id;
      return message;
    }
  }
  return null;
}

/**
 * Le bot garde le droit d'écrire dans le salon, quel que soit le mode.
 *
 * Il n'a aucune surcharge à lui : son droit d'écrire vient de `@everyone`, que
 * trois des quatre modes refusent, et que le verrou refuse aussi. Le bot se
 * muselait donc lui-même, et ne pouvait plus poster ni panneau, ni avis, ni
 * carte de décision — dans un salon dont il est pourtant le seul à tenir
 * l'affichage.
 */
async function assurerBotPeutEcrire(channel: VoiceChannel): Promise<void> {
  const moi = channel.guild?.members?.me;
  if (!moi?.id) return;

  // On n'agit que sur un constat, jamais sur une supposition : sans lecture des
  // permissions effectives, poser une surcharge reviendrait a ecrire au hasard.
  const effectives = channel.permissionsFor?.(moi);
  if (!effectives || effectives.has(PermissionFlagsBits.SendMessages)) return;

  await poserSurcharge(channel, moi.id, { SendMessages: true });
}

/** Salons dont le panneau est déjà en V2 alors que le réglage demande V1 :
 *  signalé une fois, pas à chaque réécriture (le panneau se réécrit en rafale). */
const v1ImpossibleSignale = new Set<string>();

async function reecrirePanneau(channel: VoiceChannel): Promise<void> {
  const entree = tempChannels.get(channel.id);
  if (!entree) return;

  const message = await retrouverPanneau(channel, entree);
  if (!message) return;

  await relireSalon(channel);

  const { charge, presentation } = await construirePanneau(channel, entree);

  // Le panneau est posté une fois, à la création du salon, et **seulement mis à
  // jour** ensuite. Il n'est jamais supprimé ni reposté : une suppression suivie
  // d'un envoi qui échoue laisse le salon sans aucun panneau, et l'envoi échoue
  // précisément quand le chat est fermé. Éditer son propre message, lui,
  // n'exige aucune permission d'écriture — c'est le chemin qui tient toujours.
  //
  // La mention est repassée à chaque fois : une édition remplace tous les
  // composants, et sans elle la ligne « @propriétaire » disparaissait au premier
  // changement. `patchV2` la replie en `TextDisplay` et neutralise la
  // notification, donc personne n'est repingé.
  // ⚠️ `attachments: []` est indispensable dès qu'il y a une image : sur une
  // ÉDITION, Discord CONSERVE les pièces jointes du message. Sans cette liste
  // vide, la nouvelle image s'ajoute et l'ANCIENNE reste affichée — le panneau
  // montre alors deux états, dont un faux.
  const charge2 = {
    content: `<@${entree.creatorId}>`,
    ...charge,
    ...(charge.files ? { attachments: [] } : {}),
  };

  if (presentation.composants === 'V1') {
    if (messageEstV2(message)) {
      // CONTRAINTE DURE de l'API Discord : le drapeau IsComponentsV2 ne se
      // RETIRE pas d'un message existant (voir `messageEstV2`). Le panneau se
      // réécrit en place et ne se repose jamais : tenter l'édition en V1 la
      // ferait refuser, et le panneau resterait figé sur un état périmé. On
      // garde donc V2 pour CE message — le réglage V1 prendra effet au
      // prochain panneau créé.
      if (!v1ImpossibleSignale.has(channel.id)) {
        v1ImpossibleSignale.add(channel.id);
        logger.warn('TempVoice', `Panneau de ${channel.id} déjà en Components V2 : le réglage V1 ne s'appliquera qu'au prochain salon (le drapeau IsComponentsV2 ne se retire pas).`);
      }
    } else {
      // La charge repart telle quelle : ni conversion, ni drapeau ajouté. La
      // marque ne vaut que pour CE message — aucune autre commande du bot ne
      // change de rendu.
      sansConversionV2(charge2);
    }
  }

  await message.edit(charge2).catch((err: unknown) => {
    logger.warn('TempVoice', `Le panneau de ${channel.id} n'a pas pu être mis à jour :`, err);
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// Mode d'écriture : application sur Discord
// ─────────────────────────────────────────────────────────────────────────────

/** Le mode mémorisé, sinon celui que portent les surcharges. Aucune lecture de base :
 *  ce chemin est sur la route d'un `VoiceStateUpdate`, qui arrive en rafale. */
function modeDuSalon(channel: VoiceChannel, entree: EntreeSalonTemporaire): ModeEcriture {
  if (entree.modeEcriture) return entree.modeEcriture;
  const surcharges = channel.permissionOverwrites?.cache;
  const everyoneId = channel.guild?.id ?? '';
  return deduireModeEcriture(
    everyoneId ? surcharges?.get(everyoneId) : undefined,
    surcharges?.get(entree.creatorId),
  );
}

/** Écrit une surcharge nominative, et ne marque l'origine que si Discord a accepté :
 *  marquer d'abord ferait croire à une surcharge qui n'existe pas. */
async function poserSurcharge(
  channel: VoiceChannel,
  membreId: string,
  patch: Record<string, boolean | null>,
): Promise<boolean> {
  return channel.permissionOverwrites
    .edit(membreId, patch, { type: OverwriteType.Member })
    .then(() => true)
    .catch((err: unknown) => {
      logger.warn('TempVoice', `Surcharge refusée sur ${channel.id} pour ${membreId} :`, err);
      return false;
    });
}

/**
 * Quelqu'un entre dans le salon.
 *
 * Toute la règle est dans `decisionEntreeVocal` : hors mode « ceux qui sont en
 * vocal », rien ne se passe ; et une autorisation explicite n'est jamais
 * rétrogradée en présence.
 */
async function appliquerEntreeVocale(channel: VoiceChannel, membreId: string): Promise<void> {
  const entree = tempChannels.get(channel.id);
  if (!entree) return;
  const guildId = channel.guild?.id ?? '';

  if (membreId === entree.creatorId) entree.departProprietaireA = undefined;

  const decision = decisionEntreeVocal(
    modeDuSalon(channel, entree),
    originesSurcharge.origine(guildId, channel.id, membreId),
  );

  if (decision.action === 'poser') {
    // Sérialisé par salon : deux mouvements simultanés liraient la même origine.
    await serializeByChannel(channel.id, async () => {
      const posee = await poserSurcharge(channel, membreId, decision.patch);
      if (posee) originesSurcharge.marquer(guildId, channel.id, membreId, decision.origine);
    });
  }

  planifierRafraichissementPanneau(channel);
}

/**
 * Quelqu'un quitte le salon. C'est ici que l'origine paie : « Autoriser » écrit
 * exactement la même surcharge que la présence, et l'effacer au départ
 * supprimerait un droit donné à la main.
 */
async function appliquerSortieVocale(channel: VoiceChannel, membreId: string): Promise<void> {
  const entree = tempChannels.get(channel.id);
  if (!entree) return;
  const guildId = channel.guild?.id ?? '';

  if (membreId === entree.creatorId) entree.departProprietaireA = Date.now();

  const decision = decisionSortieVocal(
    modeDuSalon(channel, entree),
    originesSurcharge.origine(guildId, channel.id, membreId),
  );

  if (decision.action === 'retirer') {
    await serializeByChannel(channel.id, async () => {
      const retiree = await poserSurcharge(channel, membreId, decision.patch);
      if (retiree) originesSurcharge.oublier(guildId, channel.id, membreId);
    });
  }

  planifierRafraichissementPanneau(channel);
}

/**
 * Change le mode d'écriture.
 *
 * Deux surcharges seulement (@everyone et le propriétaire) suffisent à trois des
 * quatre modes ; le quatrième demande en plus de poser les présents ou de
 * retirer ce qui ne sert plus, ce que `transitionModeEcriture` énumère.
 */
async function appliquerModeEcriture(
  channel: VoiceChannel,
  entree: EntreeSalonTemporaire,
  nouveau: ModeEcriture,
): Promise<void> {
  const guildId = channel.guild?.id ?? '';
  const ancien = modeDuSalon(channel, entree);

  // Les surcharges nominatives decident de qui doit se taire : les lire perimees
  // laisserait ecrire quelqu'un qu'on vient tout juste d'autoriser.
  await relireSalon(channel);

  const surcharges = surchargesModeEcriture(
    nouveau,
    categoryOverwriteFor(channel, guildId),
    categoryOverwriteFor(channel, entree.creatorId),
  );

  // Le propriétaire d'abord, @everyone ensuite : dans l'ordre inverse, un appel
  // refusé entre les deux le laisserait muet chez lui.
  await channel.permissionOverwrites.edit(entree.creatorId, surcharges.proprietaire);
  await channel.permissionOverwrites.edit(guildId, surcharges.everyone);

  // « Moi seul », « Personne » et « ceux qui sont en vocal » refusent
  // `SendMessages` a @everyone - le bot compris, faute de surcharge a lui.
  await assurerBotPeutEcrire(channel);

  const presents = [...(channel.members?.keys() ?? [])];
  const transition = transitionModeEcriture(
    ancien,
    nouveau,
    presents,
    originesSurcharge.originesDuSalon(guildId, channel.id),
  );

  for (const membreId of transition.aPoser) {
    const posee = await poserSurcharge(channel, membreId, { SendMessages: true });
    if (posee) originesSurcharge.marquer(guildId, channel.id, membreId, 'presence');
  }
  for (const membreId of transition.aRetirer) {
    const retiree = await poserSurcharge(channel, membreId, { SendMessages: null });
    if (retiree) originesSurcharge.oublier(guildId, channel.id, membreId);
  }

  // Une surcharge nominative prime sur @everyone : sans ce passage, « Personne »
  // laissait ecrire tous ceux qui avaient ete autorises. Seul le bit d'ecriture
  // part - la personne reste autorisee a entrer.
  for (const membreId of membresAReduireAuSilence(
    nouveau,
    surchargesMembresLues(channel, entree.creatorId),
    presents,
  )) {
    const retiree = await poserSurcharge(channel, membreId, { SendMessages: null });
    // La marque part avec le droit : sans cela, revenir en vocal ne reposerait
    // aucune surcharge - le registre croirait le droit deja accorde.
    if (retiree) originesSurcharge.oublier(guildId, channel.id, membreId);
  }

  entree.modeEcriture = nouveau;

  // La mémoire du salon meurt avec le process. Sans cette ligne, « ceux qui
  // sont en vocal » redevient au redémarrage un mode déduit - et les surcharges
  // de présence qu'il avait posées n'ont plus personne pour les retirer.
  // Une base indisponible ne doit pas faire échouer le clic : le mode est
  // appliqué sur Discord, c'est l'essentiel.
  try {
    await prisma.tempVoiceChannel.update({ where: { id: channel.id }, data: { writeMode: nouveau } });
  } catch (err) {
    logger.warn('TempVoice', `Mode d'écriture non persisté pour ${channel.id} :`, err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sous-panneaux éphémères
// ─────────────────────────────────────────────────────────────────────────────

/** Actions ouvertes à qui n'est ni propriétaire ni staff. */
const ACTIONS_OUVERTES = new Set(['claim', 'demander']);

interface ContextePanneau {
  role: RoleAgissant;
  reglages: ReglagesAdmin;
  /**
   * La langue du serveur, résolue une fois par interaction et descendue
   * explicitement jusqu'au rendu.
   *
   * Dans le contexte et non dans un état de module : deux serveurs de langues
   * différentes cliquent dans le même processus, et un état partagé rendrait
   * l'un dans la langue de l'autre selon l'ordre des événements.
   */
  locale: BotLocale;
  /** Réglage admin : un seul éphémère réécrit sur place, avec un bouton
   *  « Retour », plutôt qu'un message de plus à chaque action. */
  panneauCompact: boolean;
  /** Rôles proposés à la réservation, et sort de ceux qui restent sans le rôle. */
  reservation: ConfigReservation;
  /** Ce que le dashboard a réglé pour les demandes d'accès : qui répond, où, et
   *  avec quels délais. Membre du contexte pour qu'aucun appelant ne l'oublie. */
  demandes: ConfigDemandesAcces;
  /** Les cinq réglages de présentation du serveur, tels que la base les porte. */
  presentation: ReglagesPresentation;
  /**
   * Ce que « Réserver » doit faire pour la personne qui clique.
   *
   * Calculé une seule fois, par `planReservation` : aucune de ses règles n'est
   * recopiée ici. Il dépend de qui clique, donc il est dans le contexte de
   * l'interaction et jamais dans le panneau public, qui est le même pour tous.
   */
  plan: PlanReservation;
}

/**
 * Le libellé du bouton « Réserver » dans le sous-panneau, qui est ÉPHÉMÈRE :
 * lui seul sait qui clique, donc lui seul peut nommer le rôle.
 *
 * Quand `planReservation` rend `role_unique`, le bouton est une bascule qui
 * nomme ce rôle. Dans tous les autres cas il ouvre un choix, et reste générique.
 * Le message PUBLIC (mode FLAT) garde le libellé générique en toutes
 * circonstances : il ne porte qu'un seul jeu de composants pour tout le serveur.
 */
function libelleReserver(channel: VoiceChannel, etat: EtatSalon, ctxp: ContextePanneau): string {
  if (ctxp.plan.type !== 'role_unique') return libelleReserveGenerique(etat, ctxp.locale);

  const nom = channel.guild?.roles?.cache?.get?.(ctxp.plan.roleId)?.name
    ?? m.panel_tempvoice_this_role({}, { locale: ctxp.locale });
  // Discord plafonne un libellé de bouton à quatre-vingts caractères ; un nom de
  // rôle peut aller jusqu'à cent.
  const pose = etat.reserveRoleId === ctxp.plan.roleId;
  const libelle = pose
    ? m.panel_tempvoice_btn_release_role({ role: nom }, { locale: ctxp.locale })
    : m.panel_tempvoice_btn_reserve_role({ role: nom }, { locale: ctxp.locale });
  return libelle.slice(0, 80);
}

/** Le libellé générique de « Réserver » : celui du message PUBLIC, qui ne porte
 *  qu'un seul jeu de composants et ne peut donc nommer aucun rôle en propre. */
function libelleReserveGenerique(etat: EtatSalon, locale: BotLocale): string {
  return m.panel_tempvoice_btn_reserved({
    value: etat.reserveRoleId
      ? m.panel_tempvoice_yes({}, { locale })
      : m.panel_tempvoice_no({}, { locale }),
  }, { locale });
}

/** Grise un bouton et dit pourquoi : la maquette montre le motif *avant* le clic,
 *  au lieu de le faire découvrir après. */
function selonVerdict(bouton: ButtonBuilder, verdict: VerdictAction): ButtonBuilder {
  return verdict.autorise ? bouton : bouton.setDisabled(true);
}

/**
 * L'encart du modérateur : il sait qu'il n'est pas chez lui, et ce qu'un admin
 * lui a fermé. Un propriétaire et un admin n'en voient aucun.
 */
function encartRole(entree: EntreeSalonTemporaire, ctxp: ContextePanneau): EmbedBuilder[] {
  if (ctxp.role !== 'moderateur') return [];

  const lignes: string[] = [m.panel_tempvoice_mod_notice({ owner: entree.creatorId }, { locale: ctxp.locale })];
  const raison = raisonAdminsSeulement(reglagesVerrouilles(ctxp.reglages), ctxp.locale);
  if (raison) lignes.push(`${I.lock} ${raison}`);

  return [new EmbedBuilder().setColor(COULEUR_NEUTRE).setDescription(lignes.join('\n\n'))];
}

/**
 * ⚙️ Salon — chaque bouton porte son état dans son libellé *et* sa couleur ; un
 * clic bascule. Les paires verrouiller/déverrouiller et chat ouvert/fermé
 * disparaissent : l'un des deux était toujours sans effet.
 */
async function panneauSalon(
  channel: VoiceChannel,
  entree: EntreeSalonTemporaire,
  ctxp: ContextePanneau,
): Promise<PanneauRendu> {
  const etat = await lireEtatSalon(channel, entree);
  const locale = ctxp.locale;
  const maintenant = Date.now();
  const quota = quotaRenommage(historiqueRenommage(channel.id), maintenant);

  const verrou = peutAgir(ctxp.role, 'verrouiller', ctxp.reglages, ctxp.locale);
  const limite = peutAgir(ctxp.role, 'limite', ctxp.reglages, ctxp.locale);
  const renommer = peutAgir(ctxp.role, 'renommer', ctxp.reglages, ctxp.locale);
  const reserver = peutAgir(ctxp.role, 'reserver', ctxp.reglages, ctxp.locale);
  const modeEcriture = peutAgir(ctxp.role, 'modeEcriture', ctxp.reglages, ctxp.locale);

  const bascule = avecIcone(
    new ButtonBuilder()
      .setCustomId('tempvoice:bascule_verrou')
      .setLabel(etat.verrouille
        ? m.panel_tempvoice_state_locked({}, { locale })
        : m.panel_tempvoice_state_open({}, { locale }))
      .setStyle(etat.verrouille ? ButtonStyle.Danger : ButtonStyle.Success),
    etat.verrouille ? I.lock : I.unlock,
  );

  const rangeeBoutons = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    selonVerdict(bascule, verrou),
    selonVerdict(
      avecIcone(
        new ButtonBuilder()
          .setCustomId('tempvoice:limit')
          .setLabel(m.panel_tempvoice_btn_limit({
            value: etat.limite > 0 ? etat.limite : m.panel_tempvoice_limit_unlimited({}, { locale }),
          }, { locale }))
          .setStyle(ButtonStyle.Primary),
        I.profile,
      ),
      limite,
    ),
    // `libelleRenommer` porte déjà son ✏️ : l'icône « renommer » manque au jeu `ktb_`.
    selonVerdict(
      new ButtonBuilder()
        .setCustomId('tempvoice:rename')
        .setLabel(libelleRenommer(quota, maintenant, locale))
        .setStyle(ButtonStyle.Primary)
        .setDisabled(quota.restants === 0),
      renommer,
    ),
    selonVerdict(
      avecIcone(
        new ButtonBuilder()
          .setCustomId('tempvoice:reserve')
          .setLabel(libelleReserver(channel, etat, ctxp))
          .setStyle(ButtonStyle.Secondary),
        I.shield,
      ),
      reserver,
    ),
  );

  const rangees = [
    rangeeBoutons,
    rangee(menuModeEcriture(etat, modeEcriture.autorise, locale)),
  ];

  // Les reglages admin vivaient uniquement dans le dashboard : un administrateur
  // voyait donc exactement le meme panneau qu'un membre. Ils sont ici, dans
  // « Salon », et nulle part ailleurs — pas un sous-menu de plus.
  const reglages = menuReglagesModerateur(ctxp);
  if (reglages) rangees.push(reglages);

  const embeds = encartRole(entree, ctxp);
  // Le réglage V1 ne peut pas s'appliquer à un panneau déjà servi en Components
  // V2 : Discord ne retire jamais ce drapeau d'un message existant. Le constat
  // n'allait qu'aux logs — côté serveur, personne ne voyait pourquoi le réglage
  // restait sans effet. `v1ImpossibleSignale` porte le fait MESURÉ par
  // `reecrirePanneau` ; il est dit ici, dans l'écran qui porte les réglages.
  if (ctxp.presentation.composants === 'V1' && v1ImpossibleSignale.has(channel.id)) {
    embeds.push(avis(`${I.warn} ${m.panel_tempvoice_v2_already({}, { locale })}`));
  }

  return { embeds, components: rangees };
}

/**
 * Le menu « Qui peut écrire », identique dans le sous-panneau « Salon » et sur
 * le message public en mode FLAT — seul son état actif/grisé change.
 */
function menuModeEcriture(etat: EtatSalon, actif: boolean, locale: BotLocale): StringSelectMenuBuilder {
  return new StringSelectMenuBuilder()
    .setCustomId('tempvoice:mode_select')
    .setPlaceholder(m.panel_tempvoice_mode_placeholder({
      mode: libelleModeEcriture(etat.modeEcriture, locale).libelle,
    }, { locale }))
    .setDisabled(!actif)
    .addOptions(
      MODES_ECRITURE.map((mode) => {
        const libelle = libelleModeEcriture(mode, locale);
        return avecIcone(
          new StringSelectMenuOptionBuilder()
            // Discord affiche le libellé de l'option active à la place du texte
            // d'invite : sans ce préfixe, le menu replié n'annonce que « Moi
            // seul » et ne dit nulle part de quoi il parle.
            .setLabel(m.panel_tempvoice_mode_option({ mode: libelle.libelle }, { locale }))
            .setDescription(libelle.description)
            .setValue(mode)
            .setDefault(mode === etat.modeEcriture),
          iconeMode(mode),
        );
      }),
    );
}

/**
 * Ce qu'un moderateur a le droit de faire, reglable par un admin depuis le
 * panneau.
 *
 * Un seul menu a choix multiple plutot que sept interrupteurs : sept boutons
 * prendraient deux rangees sur les cinq que Discord accorde, et le panneau en
 * compte deja deux. Ce qui est coche est permis ; tout decocher ne laisse au
 * moderateur que ce qu'aucun reglage ne gouverne.
 */
function menuReglagesModerateur(
  ctxp: ContextePanneau,
): ActionRowBuilder<MessageActionRowComponentBuilder> | null {
  if (ctxp.role !== 'admin') return null;

  const ouverts = REGLAGES_MODERATEUR.filter((reglage) => ctxp.reglages[reglage] !== 'adminsSeulement');

  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('tempvoice:reglages_mod')
      .setPlaceholder((ouverts.length > 1 ? m.panel_tempvoice_mod_placeholder_many : m.panel_tempvoice_mod_placeholder_one)(
        { open: ouverts.length, total: REGLAGES_MODERATEUR.length },
        { locale: ctxp.locale },
      ))
      // Zero minimum : tout fermer est un reglage valide, pas une erreur.
      .setMinValues(0)
      .setMaxValues(REGLAGES_MODERATEUR.length)
      .addOptions(REGLAGES_MODERATEUR.map((reglage) => new StringSelectMenuOptionBuilder()
        .setLabel(majusculeInitiale(sujetReglage(reglage, ctxp.locale)))
        .setDescription(ouverts.includes(reglage)
          ? m.panel_tempvoice_mod_allowed({}, { locale: ctxp.locale })
          : m.panel_tempvoice_mod_admins_only({}, { locale: ctxp.locale }))
        .setValue(reglage)
        .setDefault(ouverts.includes(reglage)))),
  );
}

function majusculeInitiale(texte: string): string {
  return texte.charAt(0).toUpperCase() + texte.slice(1);
}

/**
 * Enregistre les sept lignes d'un coup.
 *
 * L'absence de ligne en base vaut « tout permis » : le premier enregistrement
 * doit donc ecrire les sept, sinon celles qu'on vient de fermer resteraient
 * ouvertes faute d'exister.
 */
async function enregistrerReglagesModerateur(guildId: string, permis: readonly string[]): Promise<boolean> {
  const coche = (reglage: ReglageModerateur) => permis.includes(reglage);
  const donnees = {
    canRename: coche('renommer'),
    canChangeLimit: coche('limite'),
    canLock: coche('verrouiller'),
    canChangeWriteMode: coche('modeEcriture'),
    canReserve: coche('reserver'),
    canKickOrBan: coche('expulserBannir'),
    canTransfer: coche('transferer'),
  };

  try {
    await prisma.tempVoiceModPermissionsConfig.upsert({
      where: { guildId },
      create: { guildId, ...donnees },
      update: donnees,
    });
  } catch (err) {
    logger.error('TempVoice', `Reglages moderateur non enregistres pour ${guildId} :`, err);
    return false;
  }

  // Le dashboard sert ces memes reglages depuis un cache : sans cette purge, il
  // afficherait l'etat d'avant pendant une minute.
  await cache.invalidateGuild(guildId).catch((err: unknown) => {
    logger.warn('TempVoice', `Cache non purge pour ${guildId} :`, err);
  });
  return true;
}

/** 👥 Membres — une porte au lieu de quatre : on choisit d'abord la personne. */
/** Discord n'accepte pas plus de vingt-cinq options dans un menu. */
const MAX_OPTIONS_MENU = 25;

/** Même plafond pour un `UserSelectMenu` : vingt-cinq personnes au plus. */
const MAX_UTILISATEURS_MENU = 25;

/**
 * Le menu des personnes présentes dans le salon, partagé par le sous-panneau
 * « Membres » et par le message public en mode FLAT. Il mène à la même fiche.
 */
function menuMembresPresents(
  listes: readonly GuildMember[],
  total: number,
  locale: BotLocale,
  customId = 'tempvoice:membre_ici',
): StringSelectMenuBuilder {
  return new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder((total > 1 ? m.panel_tempvoice_members_placeholder_many : m.panel_tempvoice_members_placeholder_one)(
      { count: total },
      { locale },
    ))
    .addOptions(
      listes.map((membre) => new StringSelectMenuOptionBuilder()
        // Discord plafonne un libellé à cent caractères, et un pseudo
        // Discord peut aller au-delà une fois décoré.
        .setLabel(membre.displayName.slice(0, 100))
        .setValue(membre.id)),
    );
}

/**
 * Le sous-panneau « Membres », avec deux portes plutôt qu'une.
 *
 * Chercher dans tout le serveur pour agir sur quelqu'un qui est déjà dans le
 * salon est le cas le plus fréquent, et c'était le plus laborieux : il fallait
 * taper un nom qu'on avait sous les yeux. La liste des présents règle celui-là ;
 * la recherche reste pour tous les autres.
 *
 * Au-delà de vingt-cinq personnes, la liste est tronquée plutôt qu'omise — et
 * elle le dit, sans quoi quelqu'un chercherait longtemps un nom absent.
 */
async function panneauMembres(
  channel: VoiceChannel,
  entree: EntreeSalonTemporaire,
  ctxp: ContextePanneau,
): Promise<PanneauRendu> {
  // La liste des presents est le coeur de ce sous-panneau : la batir sur un
  // cache incomplet afficherait moins de monde qu'il n'y en a.
  await relireSalon(channel);
  // Les bots occupent des places dans la liste sans qu'aucune action du panneau
  // ait de sens sur eux.
  const presents = [...(channel.members?.values() ?? [])].filter((membre) => !membre.user?.bot);
  const listes = presents.slice(0, MAX_OPTIONS_MENU);
  const tronquee = presents.length > listes.length;

  // ⚠️ La racine du « trou FLAT » est ICI, pas dans le dessin du panneau : un
  // panneau plat n'affiche plus le bouton « Membres », mais un ANCIEN panneau
  // resté dans le salon le porte encore, et son clic aboutit dans cette
  // fonction. La recherche serveur est donc refusée au niveau du gestionnaire,
  // là où tous les chemins passent — pas au niveau du bouton.
  const rechercheServeur = ctxp.presentation.mode !== 'FLAT';
  const locale = ctxp.locale;

  const invite = new EmbedBuilder()
    .setColor(COULEUR_NEUTRE)
    .setTitle(m.panel_tempvoice_who_title({}, { locale }))
    .setDescription(presents.length === 0
      ? rechercheServeur
        ? m.panel_tempvoice_who_empty_search({}, { locale })
        : m.panel_tempvoice_who_empty_flat({}, { locale })
      : tronquee
        ? m.panel_tempvoice_who_truncated({
          count: listes.length,
          suffix: rechercheServeur ? m.panel_tempvoice_who_or_search_dash({}, { locale }) : '',
        }, { locale })
        : m.panel_tempvoice_who_pick({
          suffix: rechercheServeur ? m.panel_tempvoice_who_or_search_comma({}, { locale }) : '',
        }, { locale }));

  const rangees: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];

  // Un menu sans option fait rejeter le message entier par Discord : la rangée
  // n'existe que lorsqu'il y a quelqu'un à y mettre.
  if (listes.length > 0) {
    rangees.push(rangee(menuMembresPresents(listes, presents.length, locale)));
  }

  if (rechercheServeur) {
    rangees.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId('tempvoice:membre_select')
          .setPlaceholder(m.panel_tempvoice_search_placeholder({}, { locale }))
          .setMinValues(1)
          .setMaxValues(1),
      ),
    );
  }

  return { embeds: [...encartRole(entree, ctxp), invite], components: rangees };
}

/** Une autorisation nominative se lit sur la surcharge, pas sur une intention. */
function estAutorise(channel: VoiceChannel, membreId: string): boolean {
  const surcharge = channel.permissionOverwrites?.cache?.get(membreId);
  if (!surcharge) return false;
  if (surcharge.deny?.has(PermissionFlagsBits.ViewChannel)) return false;
  return Boolean(surcharge.allow?.has(PermissionFlagsBits.Connect));
}

function estBanni(channel: VoiceChannel, membreId: string): boolean {
  return Boolean(channel.permissionOverwrites?.cache?.get(membreId)?.deny?.has(PermissionFlagsBits.ViewChannel));
}

/** La fiche d'une personne : ce qui est possible sur elle, et pourquoi le reste ne l'est pas. */
async function ficheMembre(
  channel: VoiceChannel,
  entree: EntreeSalonTemporaire,
  cibleMembre: GuildMember,
  acteurId: string,
  ctxp: ContextePanneau,
): Promise<PanneauRendu> {
  // « Accès » et « Présence » se lisent dans les surcharges : les relire avant
  // de les afficher est ce qui sépare une fiche d'un souvenir.
  await relireSalon(channel);
  const guildId = channel.guild?.id ?? '';
  const dansLeSalon = estDansLeSalon(channel, cibleMembre);
  const autorise = estAutorise(channel, cibleMembre.id);
  const banni = estBanni(channel, cibleMembre.id);

  const cible: CibleMembre = {
    nom: cibleMembre.displayName,
    estStaff: await isProtectedTarget(guildId, cibleMembre),
    estProprietaire: cibleMembre.id === entree.creatorId,
    estSoiMeme: cibleMembre.id === acteurId,
    dansLeSalon,
    autorise,
  };

  const expulser = peutAgirSurCible(ctxp.role, 'expulser', ctxp.reglages, cible, ctxp.locale);
  const bannir = peutAgirSurCible(ctxp.role, 'bannir', ctxp.reglages, cible, ctxp.locale);
  const autoriser = peutAgirSurCible(ctxp.role, 'autoriser', ctxp.reglages, cible, ctxp.locale);
  const transferer = peutAgirSurCible(ctxp.role, 'transferer', ctxp.reglages, cible, ctxp.locale);

  const locale = ctxp.locale;
  const acces = banni
    ? `${I.ban} ${m.panel_tempvoice_access_banned({}, { locale })}`
    : autorise
      ? `${I.check} ${m.panel_tempvoice_access_allowed({}, { locale })}`
      : `${I.dot} ${m.panel_tempvoice_access_not_allowed({}, { locale })}`;
  const roleAffiche = cibleMembre.roles?.highest?.name && cibleMembre.roles.highest.name !== '@everyone'
    ? cibleMembre.roles.highest.name
    : m.panel_tempvoice_role_member({}, { locale });

  const fiche = new EmbedBuilder()
    .setColor(COULEUR_NEUTRE)
    .setTitle(cibleMembre.displayName)
    .addFields(
      {
        name: m.panel_tempvoice_field_presence({}, { locale }),
        value: dansLeSalon
          ? `${I.voice} ${m.panel_tempvoice_presence_in({}, { locale })}`
          : `${I.dot} ${m.panel_tempvoice_presence_out({}, { locale })}`,
        inline: true,
      },
      { name: m.panel_tempvoice_field_access({}, { locale }), value: acces, inline: true },
      { name: m.panel_tempvoice_field_role({}, { locale }), value: roleAffiche, inline: true },
    );

  // Une seule ligne d'alerte, comme la maquette : le premier motif qui ferme une
  // porte l'explique, plutôt qu'un message par bouton grisé.
  const motif = [expulser, bannir, autoriser, transferer].find((verdict) => !verdict.autorise);
  if (motif && !motif.autorise) {
    fiche.addFields({ name: '​', value: `${I.warn} ${motif.raison}`, inline: false });
  }

  const rangeeActions = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    selonVerdict(
      avecIcone(
        new ButtonBuilder()
          .setCustomId(`tempvoice:m_kick:${cibleMembre.id}`)
          .setLabel(libelleActionMembre('expulser', cible, locale))
          .setStyle(ButtonStyle.Danger),
        I.kick,
      ),
      expulser,
    ),
    selonVerdict(
      avecIcone(
        new ButtonBuilder()
          .setCustomId(`tempvoice:m_ban:${cibleMembre.id}`)
          .setLabel(libelleActionMembre('bannir', cible, locale))
          .setStyle(ButtonStyle.Danger),
        I.ban,
      ),
      bannir,
    ),
    selonVerdict(
      avecIcone(
        new ButtonBuilder()
          .setCustomId(`tempvoice:${autorise ? 'm_untrust' : 'm_trust'}:${cibleMembre.id}`)
          .setLabel(libelleActionMembre('autoriser', cible, locale))
          .setStyle(ButtonStyle.Success),
        autorise ? I.cross : I.check,
      ),
      autoriser,
    ),
  );

  const rangeeTransfert = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    selonVerdict(
      avecIcone(
        new ButtonBuilder()
          .setCustomId(`tempvoice:m_transfer:${cibleMembre.id}`)
          .setLabel(libelleActionMembre('transferer', cible, locale))
          .setStyle(ButtonStyle.Primary),
        I.crown,
      ),
      transferer,
    ),
  );

  return { embeds: [fiche], components: [rangeeActions, rangeeTransfert] };
}

/** 👑 Propriété — jamais un bouton mort : transférer *ou* récupérer, jamais les deux. */
function panneauPropriete(
  channel: VoiceChannel,
  entree: EntreeSalonTemporaire,
  ctxp: ContextePanneau,
): PanneauRendu {
  const present = channel.members?.has(entree.creatorId) ?? false;

  if (present) {
    return {
      embeds: encartRole(entree, ctxp),
      components: [
        new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
          selonVerdict(
            avecIcone(
              new ButtonBuilder()
                .setCustomId('tempvoice:transfer')
                .setLabel(m.panel_tempvoice_btn_transfer({}, { locale: ctxp.locale }))
                .setStyle(ButtonStyle.Primary),
              I.crown,
            ),
            peutAgir(ctxp.role, 'transferer', ctxp.reglages, ctxp.locale),
          ),
        ),
      ],
    };
  }

  const locale = ctxp.locale;
  const depuis = entree.departProprietaireA
    ? m.panel_tempvoice_since_ago({
      duration: formaterDuree(Date.now() - entree.departProprietaireA, locale),
    }, { locale })
    : '';

  const abandon = new EmbedBuilder()
    .setColor(COULEUR_NEUTRE)
    .setTitle(`${I.crown} ${m.panel_tempvoice_no_owner_title({}, { locale })}`)
    .setDescription(m.panel_tempvoice_no_owner_desc({ owner: entree.creatorId, since: depuis }, { locale }));

  return {
    embeds: [abandon],
    components: [
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        // L'icône « récupérer » manque au jeu `ktb_` : l'Unicode reste.
        new ButtonBuilder()
          .setCustomId('tempvoice:claim')
          .setLabel(`${ICONES_ABSENTES.recuperer} ${m.panel_tempvoice_btn_claim({}, { locale })}`)
          .setStyle(ButtonStyle.Success),
      ),
    ],
  };
}

/**
 * Les boutons de la carte de décision portent le salon visé.
 *
 * La carte ne part plus forcément dans le salon vocal : en MP ou dans un salon
 * dédié, `interaction.channel` ne désigne plus le salon temporaire, et le
 * gestionnaire n'aurait plus rien à piloter. Budget : `tempvoice:demande_ban:`
 * (22) + deux snowflakes de 20 chiffres au plus, séparateur compris (41) = 63,
 * sous la limite de 100 caractères d'un `custom_id`.
 */
function identifiantDecision(verdict: 'ok' | 'non' | 'ban', demandeurId: string, salonId: string): string {
  return `tempvoice:demande_${verdict}:${demandeurId}:${salonId}`;
}

/** Ce que reçoit le propriétaire : de quoi décider sans quitter le salon. */
function carteDecision(
  demandeur: GuildMember,
  salonId: string,
  dejaRefuse: boolean,
  expireA: number,
  locale: BotLocale,
): PanneauRendu {
  const anciennete = demandeur.joinedTimestamp
    ? m.panel_tempvoice_since_for({
      duration: formaterDuree(Date.now() - demandeur.joinedTimestamp, locale),
    }, { locale })
    : m.panel_tempvoice_date_unknown({}, { locale });
  const roleAffiche = demandeur.roles?.highest?.name && demandeur.roles.highest.name !== '@everyone'
    ? demandeur.roles.highest.name
    : m.panel_tempvoice_role_member({}, { locale });

  const carte = new EmbedBuilder()
    .setColor(COULEUR_ACCENT)
    .setTitle(`${I.profile} ${m.panel_tempvoice_request_title({ name: demandeur.displayName }, { locale })}`)
    .addFields(
      { name: m.panel_tempvoice_field_in_server({}, { locale }), value: anciennete, inline: true },
      { name: m.panel_tempvoice_field_role({}, { locale }), value: roleAffiche, inline: true },
      {
        name: m.panel_tempvoice_field_already_denied({}, { locale }),
        value: dejaRefuse
          ? `${I.cross} ${m.panel_tempvoice_yes_cap({}, { locale })}`
          : `${I.dot} ${m.panel_tempvoice_no_cap({}, { locale })}`,
        inline: true,
      },
    )
    .setFooter({
      text: m.panel_tempvoice_request_expires({
        duration: formaterDuree(Math.max(0, expireA - Date.now()), locale),
      }, { locale }),
    });

  return {
    embeds: [carte],
    components: [
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        avecIcone(
          new ButtonBuilder()
            .setCustomId(identifiantDecision('ok', demandeur.id, salonId))
            .setLabel(m.panel_tempvoice_action_trust({}, { locale }))
            .setStyle(ButtonStyle.Success),
          I.check,
        ),
        avecIcone(
          new ButtonBuilder()
            .setCustomId(identifiantDecision('non', demandeur.id, salonId))
            .setLabel(m.panel_tempvoice_btn_deny({}, { locale }))
            .setStyle(ButtonStyle.Danger),
          I.cross,
        ),
        avecIcone(
          new ButtonBuilder()
            .setCustomId(identifiantDecision('ban', demandeur.id, salonId))
            .setLabel(m.panel_tempvoice_btn_deny_ban({}, { locale }))
            .setStyle(ButtonStyle.Secondary),
          I.ban,
        ),
      ),
    ],
  };
}

async function createTempChannel(
  state: VoiceState,
  member: GuildMember,
  generator: TempVoiceGenerator,
): Promise<void> {
  const guild = member.guild;
  // La langue du serveur est résolue ICI, où la guilde est connue, et passée
  // explicitement à tout ce qui produit du texte visible : messages privés et
  // raisons d'audit Discord comprises.
  const locale = await resolveGuildLocale(guild.id, guild.preferredLocale ?? null);

  const policy = generator.policy;

  // La catégorie configurée peut avoir été supprimée ou recréée autrement :
  // sans parent, il n'y a rien à hériter.
  const parent = generator.categoryId ? guild.channels.cache.get(generator.categoryId) : undefined;
  const parentCategory = parent?.type === ChannelType.GuildCategory ? parent : undefined;

  const missing = missingBotPermissions(guild, policy, locale, parentCategory);
  if (missing.length > 0) {
    logger.warn('TempVoice', `Droits manquants sur ${guild.name} (${guild.id}) : ${missing.join(', ')}`);
    const droits = missing.join(m.panel_tempvoice_perm_sep({}, { locale }));
    await member
      .send((missing.length > 1 ? m.panel_tempvoice_dm_missing_perms_many : m.panel_tempvoice_dm_missing_perms_one)(
        { guild: guild.name, perms: droits },
        { locale },
      ))
      .catch(() => null);
    return;
  }

  const inherited = parentCategory
    ? toOverwriteDrafts(parentCategory.permissionOverwrites.cache.values())
    : [];

  const tempChannel = await guild.channels
    .create({
      name: renderChannelName(generator.nameTemplate, member.displayName || member.user.username),
      type: ChannelType.GuildVoice,
      parent: generator.categoryId,
      userLimit: generator.policy.userLimit,
      permissionOverwrites: buildCreationOverwrites({
        everyoneRoleId: guild.id,
        ownerId: member.id,
        inherited,
        policy: generator.policy,
      }),
      reason: m.panel_tempvoice_audit_create({ user: member.user.tag }, { locale }),
    })
    .catch((err: unknown) => {
      logger.error('TempVoice', `Impossible de créer le salon temporaire sur ${guild.id} :`, err);
      return null;
    });

  if (!tempChannel) return;

  // Le déplacement échoue si le membre a déjà quitté le vocal. La suppression
  // n'étant déclenchée que par le départ d'un occupant, un salon que personne
  // n'a rejoint ne serait jamais nettoyé.
  // Annonce AVANT l'appel : l'ecouteur peut recevoir VOICE_STATE_UPDATE avant
  // que l'`await` ne rende la main. L'oubli est appele si l'appel echoue —
  // aucun etat vocal n'a alors change, et l'annonce serait attribuee au premier
  // deplacement sans rapport survenu avant peremption.
  const oublierDeplacement = annoncerIntentionVocale(guild.id, member.id, 'move', {
    libelle: 'Kotbo (salon vocal temporaire)',
  });
  const moved = await state.setChannel(tempChannel).then(() => true).catch(() => {
    oublierDeplacement();
    return false;
  });
  if (!moved) {
    await tempChannel.delete(m.panel_tempvoice_audit_move_failed({}, { locale })).catch(() => null);
    logger.warn('TempVoice', `Déplacement impossible pour ${member.user.tag}, salon temporaire annulé.`);
    return;
  }

  // Le générateur est à portée ICI et nulle part ailleurs : c'est le seul moment
  // où l'on sait par quel salon générateur on est passé. Ne pas le noter
  // maintenant, c'est ne plus jamais pouvoir le deviner.
  tempChannels.set(tempChannel.id, { creatorId: member.id, generateurId: generator.channelId });

  // Objet nommé plutôt qu'écrit dans l'appel : `generatorChannelId` n'est pas
  // dans le client Prisma généré de ce worktree, qui précède la migration
  // `..._temp_voice_generator_channel`. La colonne existe bien au schéma, et le
  // client est régénéré au déploiement (`bun run db:generate`).
  const ligneSalon = {
    id: tempChannel.id,
    guildId: guild.id,
    creatorId: member.id,
    generatorChannelId: generator.channelId,
  };

  await prisma.tempVoiceChannel
    .create({ data: ligneSalon })
    .catch((err: unknown) => logger.error('TempVoice', "Erreur lors de l'enregistrement du salon temporaire :", err));

  // La ligne de mention au-dessus de l'embed reste : c'est elle qui déclenche la
  // notification, un embed n'en produisant aucune.
  const entree = tempChannels.get(tempChannel.id) ?? { creatorId: member.id };
  const { charge, presentation } = await construirePanneau(tempChannel, entree);

  // Une categorie qui refuse `SendMessages` a @everyone prive aussi le bot, qui
  // n'a pas de surcharge a lui : le panneau ne serait jamais poste, et le salon
  // naitrait sans aucune commande.
  await assurerBotPeutEcrire(tempChannel);

  // Pas d'`attachments: []` ici : un message qui naît n'a aucune pièce jointe à
  // vider, et cette liste n'a de sens qu'en édition.
  const aPoster = { content: `<@${member.id}>`, ...charge, allowedMentions: { users: [member.id] } };
  // Un message neuf ne peut pas déjà porter IsComponentsV2 : le réglage V1
  // s'applique donc toujours ici, contrairement à l'édition.
  if (presentation.composants === 'V1') sansConversionV2(aPoster);

  const poste = await tempChannel
    .send(aPoster)
    .catch((err: unknown) => {
      logger.warn('TempVoice', `Le panneau de ${tempChannel.id} n'a pas pu etre poste :`, err);
      return null;
    });
  if (poste?.id) entree.panneauId = poste.id;

  logger.info('TempVoice', `Salon créé : ${tempChannel.name} (${tempChannel.id})`);
}

/**
 * Le salon temporaire que l'interaction pilote.
 *
 * Une carte de décision postée en MP ou dans un salon dédié n'a plus le salon
 * vocal sous la main : son identifiant de bouton le porte en quatrième partie,
 * et c'est lui qui fait foi. Les cartes postées avant ce changement n'en ont
 * pas - elles retombent sur le salon de l'interaction, comme avant.
 */
async function resoudreSalonVise(interaction: Interaction & { customId: string }): Promise<VoiceChannel | null> {
  const estSalonVocal = (candidat: unknown): candidat is VoiceChannel =>
    Boolean(candidat) && (candidat as { type?: number }).type === ChannelType.GuildVoice;

  const courant = interaction.channel;
  const vise = interaction.customId.split(':')[3];

  if (!vise) return estSalonVocal(courant) ? courant : null;
  if (estSalonVocal(courant) && courant.id === vise) return courant;

  const trouve = await interaction.client?.channels?.fetch(vise).catch(() => null);
  return estSalonVocal(trouve) ? trouve : null;
}

/** Sans ce balayage, un salon disparu sans passer par `oublierSalon` laisserait
 *  ses demandes et ses silences en mémoire jusqu'à l'arrêt du bot. */
const PURGE_DEMANDES_MS = 5 * 60 * 1000;

/** Un seul minuteur pour le process : `registerTempVoiceListener` est rappelé
 *  par chaque test, et autant d'intervalles s'accumuleraient. */
let purgeDemandes: ReturnType<typeof setInterval> | null = null;

export function registerTempVoiceListener(client: Client): void {
  const scheduleSweep = () => {
    void sweepOrphanChannels(client).catch((err: unknown) => {
      logger.error('TempVoice', 'Erreur lors du balayage des salons temporaires :', err);
    });

    if (purgeDemandes) clearInterval(purgeDemandes);
    purgeDemandes = setInterval(() => registreDemandes.purger(Date.now()), PURGE_DEMANDES_MS);
    // Un minuteur vivant empêche le process de se terminer : la suite de tests
    // ne rendrait jamais la main. `unref` n'existe pas sur le minuteur des
    // navigateurs, d'où l'appel optionnel.
    purgeDemandes.unref?.();
  };

  if (client.isReady()) scheduleSweep();
  else client.once(Events.ClientReady, scheduleSweep);

  client.on(Events.VoiceStateUpdate, async (oldState: VoiceState, newState: VoiceState) => {
    const { member, guild } = newState;
    if (!member || member.user.bot) return;

    try {
      const guildConfig = await getCachedGuild(guild.id);
      if (!guildConfig || !guildConfig.tempVoiceEnabled) return;

      if (newState.channelId) {
        const generators = resolveTempVoiceGenerators(guildConfig as unknown as TempVoiceGuildConfig, guild.id);
        const generator = generators.find((entry) => entry.channelId === newState.channelId);

        if (generator) {
          if (generator.requiredRoleId && !member.roles.cache.has(generator.requiredRoleId)) {
            const oublierRefus = annoncerIntentionVocale(guild.id, member.id, 'disconnect', {
              libelle: 'Kotbo (rôle requis manquant sur le salon générateur)',
            });
            const locale = await resolveGuildLocale(guild.id, guild.preferredLocale ?? null);
            await newState
              .disconnect(m.panel_tempvoice_audit_generator_restricted({}, { locale }))
              .catch(() => oublierRefus());
            await member
              .send(m.panel_tempvoice_dm_missing_role({ guild: guild.name }, { locale }))
              .catch(() => null);
            return;
          }

          const inFlightKey = `${guild.id}:${member.id}`;
          if (creationInFlight.has(inFlightKey)) return;
          creationInFlight.add(inFlightKey);
          try {
            await createTempChannel(newState, member, generator);
          } finally {
            creationInFlight.delete(inFlightKey);
          }
        }
      }

      // Une entrée dans un salon temporaire : en mode « ceux qui sont en
      // vocal », la parole suit la présence.
      if (newState.channelId && newState.channelId !== oldState.channelId) {
        const salon = newState.channel;
        if (salon && salon.type === ChannelType.GuildVoice && tempChannels.has(salon.id)) {
          await appliquerEntreeVocale(salon, member.id);
        }
      }

      if (oldState.channelId && oldState.channelId !== newState.channelId) {
        const oldChannel = oldState.channel;
        if (
          oldChannel &&
          oldChannel.type === ChannelType.GuildVoice &&
          tempChannels.has(oldChannel.id) &&
          oldChannel.members.size === 0
        ) {
          const locale = await resolveGuildLocale(guild.id, guild.preferredLocale ?? null);
          const closed = await closeTempChannel(oldChannel, m.panel_tempvoice_audit_empty({}, { locale }));
          if (closed) {
            logger.info('TempVoice', `Salon supprimé car vide : ${oldChannel.name} (${oldChannel.id})`);
          }
          return;
        }

        // Le salon vit encore : la sortie doit être traitée, et elle seule sait
        // distinguer une surcharge de présence d'une autorisation explicite.
        if (oldChannel && oldChannel.type === ChannelType.GuildVoice && tempChannels.has(oldChannel.id)) {
          await appliquerSortieVocale(oldChannel, member.id);
        }
      }
    } catch (err) {
      logger.error('TempVoice', 'Erreur lors de la gestion voiceStateUpdate :', err);
    }
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (
      !interaction.isButton() &&
      !interaction.isModalSubmit() &&
      !interaction.isRoleSelectMenu() &&
      !interaction.isUserSelectMenu() &&
      !interaction.isStringSelectMenu()
    ) return;
    if (!interaction.customId.startsWith('tempvoice:')) return;

    const user = interaction.user;
    const channel = await resoudreSalonVise(interaction);
    // Le MP porte la carte mais pas le serveur : c'est le salon retrouvé qui le
    // donne. Dans le salon vocal, les deux désignent le même.
    const guild = interaction.guild ?? channel?.guild ?? null;
    if (!channel || !guild) return;
    const guildId = guild.id;
    // Résolue avant le premier refus : les deux gardes ci-dessous répondent déjà
    // du texte, et elles passent avant que `ctxp` n'existe.
    const locale = await resolveGuildLocale(guildId, interaction.guildLocale ?? guild.preferredLocale ?? null);

    const cache = tempChannels.get(channel.id);
    if (!cache) {
      await interaction
        .reply({
          embeds: [avis(m.panel_tempvoice_err_not_temp({}, { locale }))],
          flags: [MessageFlags.Ephemeral],
        })
        .catch(() => null);
      return;
    }

    const action = interaction.customId.split(':')[1] ?? '';
    const actingMember = interaction.member instanceof GuildMember
      ? interaction.member
      : await guild.members.fetch(user.id).catch(() => null);

    // Un message Discord ne porte qu'un seul jeu de composants : tout le monde
    // voit la même rangée, le tri se fait ici, au clic. `claim` rend un salon
    // dont le propriétaire est parti ; `demander` s'adresse justement à qui est
    // dehors. Les deux sont donc ouvertes à autrui.
    if (!ACTIONS_OUVERTES.has(action) && cache.creatorId !== user.id && !(await isStaff(guildId, actingMember))) {
      await interaction
        .reply({
          embeds: [avis(m.panel_tempvoice_err_owner_only({}, { locale }))],
          flags: [MessageFlags.Ephemeral],
        })
        .catch(() => null);
      return;
    }

    // Le rôle et les réglages sont lus une fois, ici : `peutAgir` refuse toute
    // valeur par défaut, un appelant qui les oublierait obtiendrait un panneau
    // tout permis.
    const module = await lireReglagesAdmin(guildId);
    // La MÊME résolution que le panneau public : les sous-panneaux éphémères
    // proposeraient sinon les actions d'un mode (recherche serveur en CLASSIC)
    // que le message public ne montre pas, et le repli de réservation ne serait
    // pas celui que le générateur a réglé.
    const presentation = await presentationDuSalon(guildId, cache, module);
    const ctxp: ContextePanneau = {
      role: await roleAgissant(guildId, actingMember, cache.creatorId),
      locale,
      ...module,
      // Après l'étalement : `module.presentation` est le réglage du SERVEUR, et
      // c'est la présentation résolue pour ce salon qui doit faire foi.
      presentation,
      demandes: await lireConfigDemandes(guildId),
      // Les rôles de la personne qui clique, les rôles réservables du serveur et
      // le repli réglé : la décision appartient à `planReservation`.
      // `keys?.()` et non `keys()` : c'est la forme déjà retenue partout dans ce
      // fichier (voir `traiterDebordementReservation`) — le gestionnaire reçoit
      // aussi des membres dont `roles.cache` n'est pas une Collection complète,
      // et un `keys()` sec y lève au lieu de rendre « aucun rôle ».
      plan: planReservation(
        [...(actingMember?.roles?.cache?.keys?.() ?? [])],
        module.reservation.rolesReservables,
        presentation.repliReservation,
      ),
    };

    // ⚠️ Aucun redessin ici. Il y en avait un, hérité de l'époque où
    // l'anti-rebond n'avait pas de front montant : la réécriture arrivait deux
    // secondes plus tard, donc après l'action, et lire l'état avant ne coûtait
    // rien.
    //
    // Avec le front montant, ce même appel consomme la fenêtre sur l'état
    // d'AVANT le clic — le panneau se redessinait identique, puis attendait la
    // fermeture de la fenêtre pour dire la vérité. Verrouiller laissait donc
    // « Ouvert » affiché.
    //
    // Chaque action qui change quelque chose appelle `planifierRafraichissement`
    // une fois son travail fait : c'est là que le redessin a un sens.
    try {
      await handleTempVoiceAction({ interaction, action, channel, cache, guild, guildId, actingMember, ctxp });
    } catch (err) {
      logger.error('TempVoice', `Erreur lors de l'action « ${action} » :`, err);
      const message = {
        embeds: [avis(m.panel_tempvoice_err_action_failed({}, { locale }))],
        flags: [MessageFlags.Ephemeral] as const,
      };
      await (interaction.isRepliable() && (interaction.replied || interaction.deferred)
        ? interaction.followUp(message).catch(() => null)
        : interaction.reply(message).catch(() => null));
    }
  });

  logger.success('TempVoice', 'Écouteur Vocal Temporaire enregistré');
}

/**
 * Discord ferme une interaction non acquittée au bout de trois secondes : toute
 * action qui touche Discord ou la base passe par ici avant son premier appel.
 *
 * `showModal` et les réponses à composants font exception, l'API les exigeant
 * sur une interaction non acquittée.
 */
/**
 * Le composant cliqué vit-il sur un message éphémère, c'est-à-dire sur un
 * sous-panneau que personne d'autre ne voit ?
 *
 * C'est la seule question qui distingue les deux comportements attendus : un
 * bouton du panneau public doit ouvrir un éphémère à côté — l'éditer effacerait
 * le panneau pour tout le serveur — alors qu'un bouton d'un sous-panneau doit
 * remplacer ce sous-panneau, sinon les réponses s'empilent.
 */
function surMessageEphemere(interaction: RepliableInteraction): boolean {
  if (!interaction.isMessageComponent?.()) return false;
  const drapeaux = (interaction as { message?: { flags?: { has?: (f: number) => boolean } } }).message?.flags;
  return Boolean(drapeaux?.has?.(MessageFlags.Ephemeral));
}

async function deferIfNeeded(interaction: RepliableInteraction, compact = false): Promise<void> {
  if (interaction.deferred || interaction.replied) return;

  // `deferReply` crée un message de plus ; `deferUpdate` reprend celui qui porte
  // le composant. En mode compact, les trois éphémères d'une réservation — le
  // menu, le choix, le verdict — n'en font plus qu'un.
  if (compact && surMessageEphemere(interaction)) {
    await (interaction as unknown as { deferUpdate: () => Promise<unknown> }).deferUpdate().catch(() => null);
    return;
  }
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }).catch(() => null);
}

/** Les trois portes du panneau, vers lesquelles « Retour » sait ramener. */
const ONGLETS_PANNEAU = ['salon', 'membres', 'propriete'] as const;
type OngletPanneau = (typeof ONGLETS_PANNEAU)[number];

/**
 * De quel sous-panneau vient cette action.
 *
 * En mode compact, le verdict remplace le menu qui l'a provoqué : sans chemin
 * de retour, la personne se retrouve devant une phrase et plus aucun bouton.
 * La table est explicite plutôt que déduite d'un préfixe — un identifiant mal
 * rangé enverrait vers la mauvaise porte sans rien casser, c'est-à-dire sans
 * que personne le voie.
 */
const ONGLET_DORIGINE: Readonly<Record<string, OngletPanneau>> = {
  bascule_verrou: 'salon',
  mode_select: 'salon',
  reserve: 'salon',
  reserve_select: 'salon',
  reserve_membres: 'salon',
  reglages: 'salon',
  rename: 'salon',
  limit: 'salon',
  lock: 'salon',
  unlock: 'salon',
  chat: 'salon',
  membre_select: 'membres',
  membre_ici: 'membres',
  m_kick: 'membres',
  m_ban: 'membres',
  m_trust: 'membres',
  m_untrust: 'membres',
  kick: 'membres',
  ban: 'membres',
  trust: 'membres',
  m_transfer: 'propriete',
  transfer: 'propriete',
  claim: 'propriete',
};

const LIBELLES_ONGLETS: Readonly<Record<OngletPanneau, (inputs: Record<string, never>, options: { locale: BotLocale }) => string>> = {
  salon: m.panel_tempvoice_tab_channel,
  membres: m.panel_tempvoice_tab_members,
  propriete: m.panel_tempvoice_tab_ownership,
};

function rangeeRetour(onglet: OngletPanneau, locale: BotLocale): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`tempvoice:${onglet}`)
      .setLabel(m.panel_tempvoice_btn_back({ tab: LIBELLES_ONGLETS[onglet]({}, { locale }) }, { locale }))
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Secondary),
  );
}

/**
 * Un éphémère de ce module, toujours sous la même forme.
 *
 * **Règle : jamais de `content` brut.** `patchV2` ne convertit une charge en
 * composants V2 que si elle porte des embeds. Un message posté en `content` naît
 * donc *legacy*, et la première édition qui, elle, portera un embed tentera de
 * le convertir en V2 — ce que Discord refuse tant que le `content` est là
 * (`MESSAGE_CANNOT_USE_LEGACY_FIELDS_WITH_COMPONENTS_V2`, HTTP 400).
 *
 * Tout passer par un embed met chaque message du module dans le même monde dès
 * sa naissance, et rend toutes les éditions suivantes possibles.
 */
function avis(texte: string, couleur = COULEUR_NEUTRE): EmbedBuilder {
  return new EmbedBuilder().setColor(couleur).setDescription(texte);
}

async function respond(
  interaction: RepliableInteraction,
  content: string,
  retour?: { onglet: OngletPanneau; locale: BotLocale } | null,
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    // ⚠️ Le verdict part en EMBED, jamais en `content` brut.
    //
    // `editReply` n'est pas converti en composants V2 par `patchV2` : il ne
    // connait pas le message cible et ne convertit que si la charge porte des
    // embeds. Or ce message-la EST en V2 des qu'un sous-panneau l'a occupe, et
    // Discord refuse alors tout `content`
    // (`MESSAGE_CANNOT_USE_LEGACY_FIELDS_WITH_COMPONENTS_V2`, HTTP 400).
    //
    // Passer par un embed remet la charge sur le chemin qui la convertit : le
    // texte devient un `TextDisplay`, le `content` disparait, et l'edition est
    // acceptee.
    const charge = {
      embeds: [new EmbedBuilder().setColor(COULEUR_NEUTRE).setDescription(content)],
      // Le menu qui a provoque le verdict est retire : un selecteur deja
      // consomme ne doit pas rester cliquable.
      components: retour ? [rangeeRetour(retour.onglet, retour.locale)] : [],
    };
    await interaction.editReply(charge).catch(() => null);
    return;
  }
  // Un embed, pas un `content` : voir la règle sur `avis`.
  await interaction.reply({ embeds: [avis(content)], flags: [MessageFlags.Ephemeral] }).catch(() => null);
}

interface ActionContext {
  interaction: RepliableInteraction & { customId: string };
  action: string;
  channel: VoiceChannel;
  cache: EntreeSalonTemporaire;
  guild: DiscordGuild;
  guildId: string;
  actingMember: GuildMember | null;
  /** Qui clique et ce que les modérateurs ont le droit de faire sur ce serveur :
   *  lus une fois, passés explicitement — `peutAgir` n'a pas de défaut. */
  ctxp: ContextePanneau;
}

function textModal(customId: string, title: string, label: string, placeholder: string, maxLength: number) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('value')
          .setLabel(label)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(placeholder)
          .setMaxLength(maxLength)
          .setRequired(true),
      ),
    );
}

/**
 * Le sélecteur de personnes, dans la forme que le mode du panneau autorise.
 *
 * Le mode FLAT promet « les actions ne visent que les membres présents en
 * vocal, sans recherche » (`cm_tv_panel_mode_flat_hint`). Un `UserSelectMenu`
 * cherche dans TOUT le serveur : l'ouvrir depuis un panneau plat rendait la
 * promesse fausse en deux clics. En FLAT, le menu des PRÉSENTS prend sa place —
 * sous le MÊME `custom_id`, exactement comme `reserve_select` sert déjà tantôt
 * un menu de rôles imposés, tantôt le sélecteur libre de Discord.
 *
 * Rend `null` quand le mode FLAT ne laisse personne à proposer : un menu sans
 * option fait rejeter le message entier par Discord.
 */
async function selecteurPersonnes(
  channel: VoiceChannel,
  ctxp: ContextePanneau,
  customId: string,
  placeholder: string,
  options: { maxValues?: number; exclureId?: string } = {},
): Promise<ActionRowBuilder<MessageActionRowComponentBuilder> | null> {
  const maxValues = options.maxValues ?? 1;

  if (ctxp.presentation.mode !== 'FLAT') {
    return rangee(
      new UserSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(placeholder)
        .setMinValues(1)
        .setMaxValues(maxValues),
    );
  }

  // La liste des présents est tout le propos du mode : la bâtir sur un cache
  // incomplet proposerait moins de monde qu'il n'y en a.
  await relireSalon(channel);
  const presents = [...(channel.members?.values() ?? [])]
    .filter((membre) => !membre.user?.bot && membre.id !== options.exclureId);
  if (presents.length === 0) return null;

  const listes = presents.slice(0, MAX_OPTIONS_MENU);
  return rangee(
    menuMembresPresents(listes, presents.length, ctxp.locale, customId)
      .setPlaceholder(placeholder)
      .setMinValues(1)
      .setMaxValues(Math.min(maxValues, listes.length)),
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// Actions de la refonte
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Acquitte une interaction de composant sans consommer la réponse : `deferUpdate`
 * garde la main sur le message éphémère, qu'un `editReply` réécrira ensuite.
 */
async function acquitterMiseAJour(interaction: RepliableInteraction): Promise<void> {
  if (interaction.deferred || interaction.replied) return;
  // ⚠️ `deferUpdate` ne vaut que sur un message ÉPHÉMÈRE. En mode FLAT, les
  // mêmes composants vivent sur le message PUBLIC : le `editReply` qui suit
  // remplacerait alors le panneau du salon par la fiche d'un membre, pour tout
  // le serveur. Sur un message public, on ouvre donc un éphémère à côté —
  // exactement ce que fait `ouvrirPorte` pour les trois portes.
  if (interaction.isMessageComponent() && surMessageEphemere(interaction)) {
    await interaction.deferUpdate().catch(() => null);
    return;
  }
  await deferIfNeeded(interaction);
}

/** Une réponse qui ne remplace pas le sous-panneau ouvert : elle s'ajoute à côté. */
async function reponseSupplementaire(interaction: RepliableInteraction, texte: string): Promise<void> {
  // Un embed, pas un `content` : voir la regle sur `avis`.
  const message = { embeds: [avis(texte)], flags: [MessageFlags.Ephemeral] as const };
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(message).catch(() => null);
    return;
  }
  await interaction.reply(message).catch(() => null);
}

/** Réécrit le sous-panneau « Salon » en place, pour que la bascule montre son nouvel état. */
/** Relectures en vol, par salon. */
const relectures = new Map<string, Promise<unknown>>();

/**
 * Relit le salon depuis Discord avant d'en montrer quoi que ce soit.
 *
 * `PermissionOverwriteManager.upsert` fait l'appel REST et rend le salon tel
 * quel : ce qu'on vient d'écrire n'est lisible qu'après un `CHANNEL_UPDATE` ou
 * une relecture forcée. Sans elle, un panneau redessiné juste après une action
 * affiche l'état d'avant — le défaut même que cette refonte corrige.
 *
 * Les appels simultanés partagent la même relecture : une action déclenche à la
 * fois la réécriture du panneau public et celle du sous-panneau, et rien ne
 * justifie deux allers-retours pour la même vérité.
 */
function relireSalon(channel: VoiceChannel): Promise<unknown> {
  const enCours = relectures.get(channel.id);
  if (enCours) return enCours;

  const relecture = Promise.resolve(
    channel.guild?.channels?.fetch(channel.id, { force: true }),
  )
    .catch(() => null)
    .then(() => hydraterMembresPresents(channel))
    .finally(() => relectures.delete(channel.id));

  relectures.set(channel.id, relecture);
  return relecture;
}

/**
 * Met en cache les membres présents qui n'y sont pas encore.
 *
 * `channel.members` de discord.js n'est pas la liste des personnes connectées :
 * c'est la liste des états vocaux **dont le membre est déjà en cache**. Un
 * membre absent du cache disparaît purement et simplement — du décompte
 * d'occupants, de la liste du sous-panneau, des autorisations d'écriture en
 * mode « ceux qui sont en vocal » et du décalage de réservation. Sans erreur,
 * sans trace, et d'autant plus souvent que le serveur est grand.
 *
 * Les états vocaux, eux, sont tenus à jour par l'intention `GuildVoiceStates` :
 * ils font foi sur qui est là. On part donc d'eux, et on récupère en une seule
 * fois les membres qui manquent.
 */
async function hydraterMembresPresents(channel: VoiceChannel): Promise<void> {
  const etats = channel.guild?.voiceStates?.cache;
  const membres = channel.guild?.members;
  if (!etats || !membres?.cache) return;

  const manquants = [...etats.values()]
    .filter((etat) => etat.channelId === channel.id && !membres.cache.has(etat.id))
    .map((etat) => etat.id);

  if (manquants.length === 0) return;
  await membres.fetch({ user: manquants }).catch((err: unknown) => {
    logger.warn('TempVoice', `Membres presents non recuperes pour ${channel.id} :`, err);
    return null;
  });
}

async function rafraichirSousPanneauSalon(ctx: ActionContext): Promise<void> {
  await relireSalon(ctx.channel);
  const rendu = await panneauSalon(ctx.channel, ctx.cache, ctx.ctxp);
  await ctx.interaction.editReply(rendu).catch(() => null);
}

/**
 * La fiche d'un membre, redessinée sur les vraies données après une action.
 *
 * Elle ne l'était pas : « Autoriser » écrivait la surcharge, postait son
 * message, et laissait la fiche annoncer « Non autorisé » — la personne lisait
 * le contraire de ce qu'elle venait de faire.
 */
async function rafraichirFicheMembre(ctx: ActionContext, cible: GuildMember): Promise<void> {
  // Pas de relecture ici : `ficheMembre` la fait elle-même, et une seconde
  // n'apprendrait rien de plus.
  const rendu = await ficheMembre(ctx.channel, ctx.cache, cible, ctx.interaction.user.id, ctx.ctxp);
  await ctx.interaction.editReply(rendu).catch(() => null);
}

/** Verrouiller et déverrouiller ne sont plus deux boutons dont l'un est toujours
 *  sans effet : c'est une bascule, et l'état courant décide du sens. */
async function basculerVerrou(ctx: ActionContext): Promise<string> {
  const { channel, cache, guildId } = ctx;
  const locale = ctx.ctxp.locale;

  // L'état doit être relu : `upsert` ne met pas le cache à jour, seul
  // `CHANNEL_UPDATE` le fait. Sans cette relecture, la bascule se décide sur un
  // état que la passerelle n'a pas encore rattrapé.
  await ctx.guild.channels.fetch(channel.id, { force: true }).catch(() => null);

  const verrouille = Boolean(
    channel.permissionOverwrites?.cache?.get(guildId)?.deny?.has(PermissionFlagsBits.Connect),
  );

  if (verrouille) {
    await channel.permissionOverwrites.edit(
      guildId,
      restoreFromCategory(CHANNEL_PATCHES.unlock, categoryOverwriteFor(channel, guildId)),
    );
    await channel.permissionOverwrites.edit(
      cache.creatorId,
      ownerChatPatch(false, categoryOverwriteFor(channel, cache.creatorId)),
    );
    return `${I.unlock} ${m.panel_tempvoice_unlocked({}, { locale })}`;
  }

  await channel.permissionOverwrites.edit(
    cache.creatorId,
    ownerChatPatch(true, categoryOverwriteFor(channel, cache.creatorId)),
  );
  await channel.permissionOverwrites.edit(guildId, CHANNEL_PATCHES.lock);
  // Le verrou coupe `SendMessages` a @everyone - le bot compris, tant
  // qu'il n'a pas de surcharge a lui. Sans cela il ne peut plus mettre a
  // jour le panneau ni poster le moindre avis dans le salon.
  await assurerBotPeutEcrire(channel);
  return `${I.lock} ${m.panel_tempvoice_locked({}, { locale })}`;
}

/**
 * Retire une demande à laquelle personne n'aura l'occasion de répondre.
 *
 * Elle est résolue en « acceptée » parce que c'est la seule décision qui ne
 * pose pas de silence : personne n'a tranché, et le demandeur doit pouvoir
 * réessayer dès que la cause est levée.
 */
function annulerDemande(guildId: string, salonId: string, demandeurId: string, maintenant: number): void {
  registreDemandes.resoudre(guildId, salonId, demandeurId, 'acceptee', maintenant);
}

/**
 * Prévient le propriétaire, en essayant chaque canal jusqu'à ce qu'un aboutisse.
 *
 * Aucun canal n'est sûr : les MP se ferment sans que Discord offre de le
 * vérifier avant l'envoi, et un salon dédié peut avoir été supprimé ou fermé au
 * bot depuis que le dashboard l'a choisi. `ordreNotification` donne l'ordre et
 * garde toujours une issue derrière le premier choix.
 *
 * La mention accompagne la carte : c'est elle qui notifie, un embed n'en
 * produisant aucune.
 */
async function transmettreCarteDecision(
  channel: VoiceChannel,
  guild: DiscordGuild,
  proprietaireId: string,
  config: ConfigDemandesAcces,
  carte: PanneauRendu,
): Promise<CanalNotification | null> {
  const mention = `<@${proprietaireId}>`;
  let proprietaire: GuildMember | null | undefined;

  for (const canal of ordreNotification(config)) {
    if (canal === 'VOICE') {
      const poste = await channel.send({ content: mention, ...carte, allowedMentions: { users: [proprietaireId] } }).catch((err: unknown) => {
        logger.warn('TempVoice', `La demande d'accès n'a pas pu être postée dans ${channel.id} :`, err);
        return null;
      });
      if (poste) return 'VOICE';
      continue;
    }

    if (canal === 'DM') {
      if (proprietaire === undefined) proprietaire = await guild.members.fetch(proprietaireId).catch(() => null);
      const envoye = proprietaire
        ? await proprietaire.send(carte).then(() => true).catch(() => false)
        : false;
      if (envoye) return 'DM';
      continue;
    }

    if (!config.canalId) continue;
    const dedie = await guild.channels.fetch(config.canalId).catch(() => null);
    if (!dedie?.isTextBased()) continue;
    // Un salon où le bot ne peut pas écrire n'est pas un canal : l'essayer
    // quand même coûterait un aller-retour pour un refus certain.
    const moi = guild.members.me;
    if (moi && !dedie.permissionsFor(moi)?.has(PermissionFlagsBits.SendMessages)) continue;
    const poste = await dedie.send({ content: mention, ...carte, allowedMentions: { users: [proprietaireId] } }).catch((err: unknown) => {
      logger.warn('TempVoice', `La demande d'accès n'a pas pu être postée dans ${config.canalId} :`, err);
      return null;
    });
    if (poste) return 'CHANNEL';
  }

  return null;
}

/**
 * « Demander l'accès » : le bouton de celui qui est dehors.
 *
 * Rien n'est écrit dans le salon par le demandeur — sa demande ne doit pas
 * devenir du bruit. Les trois garde-fous sont dans le registre.
 */
async function traiterDemandeAcces(ctx: ActionContext): Promise<void> {
  const { interaction, channel, cache, guild, guildId, ctxp } = ctx;
  const demandeurId = interaction.user.id;
  const maintenant = Date.now();
  const locale = ctxp.locale;

  const verdict = peutAgir(ctxp.role, 'demanderAcces', ctxp.reglages, ctxp.locale);
  if (!verdict.autorise) {
    await respond(interaction, `${I.crown} ${verdict.raison}`);
    return;
  }

  // Un panneau posté avant qu'un administrateur ne désactive les demandes porte
  // encore le bouton : le refus se dit ici, le bouton grisé ne suffit pas.
  if (!ctxp.demandes.activees) {
    await respond(interaction, `${I.lock} ${m.panel_tempvoice_requests_disabled({}, { locale })}`);
    return;
  }

  const etat = await lireEtatSalon(channel, cache);
  if (!boutonDemanderAccesVisible({ verrouille: etat.verrouille, reserve: etat.reserveRoleId !== null }, ctxp.demandes)) {
    await respond(interaction, `${I.unlock} ${m.panel_tempvoice_channel_open_just_join({}, { locale })}`);
    return;
  }

  const resultat = registreDemandes.demander(guildId, channel.id, demandeurId, maintenant, {
    expirationMs: ctxp.demandes.expirationMs,
    silenceMs: ctxp.demandes.silenceMs,
  });
  if (resultat.statut === 'enregistree') await persisterEtatSalon(guildId, channel.id);

  if (resultat.statut === 'silence') {
    await respond(
      interaction,
      `${I.cross} ${m.panel_tempvoice_request_cooldown({ duration: formaterDuree(resultat.resteMs, locale) }, { locale })}`,
    );
    return;
  }

  if (resultat.statut === 'dejaEnAttente') {
    await respond(
      interaction,
      `${I.warn} ${m.panel_tempvoice_request_pending({ duration: formaterDuree(resultat.resteMs, locale) }, { locale })}`,
    );
    return;
  }

  const demandeur = await guild.members.fetch(demandeurId).catch(() => null);
  if (!demandeur) {
    annulerDemande(guildId, channel.id, demandeurId, maintenant);
    await respond(interaction, m.panel_tempvoice_err_profile_unreadable({}, { locale }));
    return;
  }

  const carte = carteDecision(
    demandeur,
    channel.id,
    registreDemandes.estEnSilence(guildId, channel.id, demandeurId, maintenant),
    resultat.demande.expireA,
    locale,
  );
  const voie = await transmettreCarteDecision(channel, guild, cache.creatorId, ctxp.demandes, carte);

  if (!voie) {
    // Aucun canal n'a abouti : laisser la demande en attente ferait patienter
    // le demandeur devant une réponse que personne ne peut lui donner.
    annulerDemande(guildId, channel.id, demandeurId, maintenant);
    await respond(interaction, m.panel_tempvoice_err_request_undelivered({}, { locale }));
    return;
  }

  await interaction
    .editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COULEUR_NEUTRE)
          .setTitle(`${I.check} ${m.panel_tempvoice_request_sent_title({}, { locale })}`)
          .setDescription(m.panel_tempvoice_request_sent_desc({ owner: cache.creatorId }, { locale })),
      ],
    })
    .catch(() => null);
}

/**
 * Ce qu'il advient de ceux qui sont déjà là sans avoir le rôle.
 *
 * Réserver ne déplaçait personne : les gens restaient dans un salon qu'ils
 * n'auraient plus eu le droit de rejoindre, et le propriétaire n'avait aucun
 * moyen de le régler depuis le panneau.
 */
async function traiterDebordementReservation(ctx: ActionContext, roleId: string): Promise<void> {
  const { channel, cache, ctxp } = ctx;

  // Deplacer ou deconnecter sur une liste incomplete laisserait sur place
  // exactement les gens que le cache a oublies.
  await relireSalon(channel);

  const presents = [...(channel.members?.values() ?? [])].map((membre) => ({
    id: membre.id,
    estBot: Boolean(membre.user?.bot),
    roles: new Set<string>(membre.roles?.cache?.keys?.() ?? []),
  }));

  const plan = planDebordement(
    ctxp.reservation,
    membresSansLeRole(presents, roleId, cache.creatorId),
  );

  if (plan.action === 'aucune') return;
  if (plan.action === 'demander') {
    await proposerDebordement(ctx, plan);
    return;
  }
  await appliquerDebordement(ctx, plan);
}

/** Les trois issues, posées au propriétaire plutôt que décidées pour lui. */
async function proposerDebordement(ctx: ActionContext, plan: PlanDebordement): Promise<void> {
  const locale = ctx.ctxp.locale;
  const noms = plan.membres.map((id) => `<@${id}>`).join(', ');
  const plusieurs = plan.membres.length > 1;
  const embed = new EmbedBuilder()
    .setColor(COULEUR_ACCENT)
    .setTitle(`${I.warn} ${(plusieurs ? m.panel_tempvoice_overflow_title_many : m.panel_tempvoice_overflow_title_one)({ count: plan.membres.length }, { locale })}`)
    .setDescription((plusieurs ? m.panel_tempvoice_overflow_desc_many : m.panel_tempvoice_overflow_desc_one)({ names: noms }, { locale }));

  const rangee = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('tempvoice:resa_rien')
      .setLabel(m.panel_tempvoice_btn_leave_them({}, { locale }))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('tempvoice:resa_deplacer')
      .setLabel(ctx.ctxp.reservation.salonDeRepli
        ? m.panel_tempvoice_btn_move_them({}, { locale })
        : m.panel_tempvoice_btn_move_them_none({}, { locale }))
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('tempvoice:resa_deconnecter')
      .setLabel(m.panel_tempvoice_btn_disconnect_them({}, { locale }))
      .setStyle(ButtonStyle.Danger),
  );

  await ctx.interaction
    .followUp({ embeds: [embed], components: [rangee], allowedMentions: { parse: [] }, flags: [MessageFlags.Ephemeral] })
    .catch(() => null);
}

/** Déplacer ou déconnecter, en annonçant l'intention au journal de modération. */
async function appliquerDebordement(ctx: ActionContext, plan: PlanDebordement): Promise<void> {
  const { channel, guild, guildId, interaction } = ctx;
  const locale = ctx.ctxp.locale;
  const raisonAudit = m.panel_tempvoice_audit_reserved_role({}, { locale });

  const accueil = plan.action === 'deplacer' && plan.salon
    ? await guild.channels.fetch(plan.salon).catch(() => null)
    : null;

  // Un salon d'accueil disparu depuis le réglage ne doit pas laisser les gens
  // en place sans le dire : on déconnecte, et le message l'annonce.
  const deplace = Boolean(accueil && accueil.type === ChannelType.GuildVoice);
  let traites = 0;

  for (const membreId of plan.membres) {
    const membre = channel.members?.get(membreId)
      ?? await guild.members.fetch(membreId).catch(() => null);
    if (!membre || membre.voice?.channelId !== channel.id) continue;

    const oubli = annoncerIntentionVocale(guildId, membreId, deplace ? 'move' : 'disconnect', {
      libelle: `${interaction.user.tag} (salon réservé à un rôle)`,
    });

    const fait = deplace
      ? await membre.voice.setChannel(accueil as never, raisonAudit).then(() => true).catch(() => { oubli(); return false; })
      : await membre.voice.disconnect(raisonAudit).then(() => true).catch(() => { oubli(); return false; });

    if (fait) traites += 1;
  }

  if (traites === 0) return;

  const ou = deplace && accueil
    ? m.panel_tempvoice_overflow_to({ channel: accueil.id }, { locale })
    : '';
  const motif = plan.repliSurDeconnexion ? m.panel_tempvoice_overflow_no_fallback({}, { locale }) : '';
  const phrase = deplace
    ? (traites > 1 ? m.panel_tempvoice_overflow_moved_many : m.panel_tempvoice_overflow_moved_one)
    : (traites > 1 ? m.panel_tempvoice_overflow_disconnected_many : m.panel_tempvoice_overflow_disconnected_one);
  await reponseSupplementaire(
    interaction,
    `${I.voice} ${phrase({ count: traites, where: ou, why: motif }, { locale })}`,
  );
}

/** Referme la proposition : ses boutons ne doivent pas rester cliquables. */
async function cloreProposition(interaction: RepliableInteraction, verdict: string): Promise<void> {
  if (!interaction.isMessageComponent()) return;
  await interaction.update({ embeds: [avis(verdict)], components: [] }).catch(() => null);
}

/**
 * La réponse du propriétaire à la proposition.
 *
 * Les personnes concernées sont **recalculées** au clic plutôt que mémorisées :
 * entre la proposition et la réponse, quelqu'un a pu partir, arriver, ou
 * recevoir le rôle. Agir sur une liste figée déplacerait des gens qui n'ont
 * plus rien à voir avec la question posée.
 */
async function repondreDebordement(ctx: ActionContext, choix: 'deplacer' | 'deconnecter'): Promise<void> {
  const { channel, cache, ctxp, interaction } = ctx;
  const locale = ctxp.locale;

  const verdict = peutAgir(ctxp.role, 'reserver', ctxp.reglages, ctxp.locale);
  if (!verdict.autorise) {
    await respond(interaction, `${I.lock} ${verdict.raison}`);
    return;
  }

  const roleId = await prisma.tempVoiceChannel
    .findUnique({ where: { id: channel.id } })
    .then((ligne) => ligne?.roleId ?? null)
    .catch(() => null);

  if (!roleId) {
    await cloreProposition(interaction, `${I.unlock} ${m.panel_tempvoice_overflow_nothing_left({}, { locale })}`);
    return;
  }

  await relireSalon(channel);
  const presents = [...(channel.members?.values() ?? [])].map((membre) => ({
    id: membre.id,
    estBot: Boolean(membre.user?.bot),
    roles: new Set<string>(membre.roles?.cache?.keys?.() ?? []),
  }));
  const concernes = membresSansLeRole(presents, roleId, cache.creatorId);

  if (concernes.length === 0) {
    await cloreProposition(interaction, `${I.check} ${m.panel_tempvoice_overflow_nobody_affected({}, { locale })}`);
    return;
  }

  const salon = choix === 'deplacer' ? ctxp.reservation.salonDeRepli : null;
  await cloreProposition(interaction, `${I.voice} ${m.panel_tempvoice_overflow_working({}, { locale })}`);
  await appliquerDebordement(ctx, {
    action: salon ? 'deplacer' : 'deconnecter',
    salon,
    membres: concernes,
    repliSurDeconnexion: choix === 'deplacer' && !salon,
  });
}

/** Referme la carte de décision : ses boutons ne doivent pas rester cliquables. */
async function cloreCarteDecision(interaction: RepliableInteraction, verdictAffiche: string): Promise<void> {
  if (!interaction.isMessageComponent()) return;
  await interaction.message
    .edit({ components: [], embeds: [avis(verdictAffiche)] })
    .catch(() => null);
}

/** Le refus reste privé : l'écrire dans un salon que tout le monde lit
 *  transformerait un réglage de confort en humiliation. */
async function prevenirDemandeur(
  channel: VoiceChannel,
  demandeur: GuildMember,
  acceptee: boolean,
  silenceMs: number,
  locale: BotLocale,
): Promise<void> {
  const embed = acceptee
    ? new EmbedBuilder()
      .setColor(COULEUR_OUVERT)
      .setTitle(`${I.check} ${m.panel_tempvoice_req_accepted_title({}, { locale })}`)
      .setDescription(m.panel_tempvoice_req_accepted_desc({ channel: channel.name }, { locale }))
    : new EmbedBuilder()
      .setColor(COULEUR_NEUTRE)
      .setTitle(`${I.cross} ${m.panel_tempvoice_req_denied_title({}, { locale })}`)
      // Le délai du serveur, et non celui du registre : un seul registre sert
      // tous les serveurs, annoncer son défaut donnerait un chiffre faux dès
      // qu'un administrateur règle le sien.
      .setDescription(m.panel_tempvoice_req_denied_desc({ duration: formaterDuree(silenceMs, locale) }, { locale }));

  const envoye = await demandeur.send({ embeds: [embed] }).then(() => true).catch(() => false);

  // Les MP fermés font échouer l'envoi en silence. L'acceptation peut se dire
  // dans le salon — la personne y entre de toute façon ; le refus, non.
  if (!envoye && acceptee) {
    await channel
      .send({ content: `${I.check} ${m.panel_tempvoice_req_allowed_public({ user: demandeur.id }, { locale })}` })
      .catch(() => null);
  }
}

/** Réponse du propriétaire à une demande d'accès. */
async function traiterDecisionDemande(ctx: ActionContext, decision: 'ok' | 'non' | 'ban'): Promise<void> {
  const { interaction, channel, cache, guild, guildId, ctxp } = ctx;
  const maintenant = Date.now();
  const locale = ctxp.locale;

  // `peutAgir` ne sait rien de cette action : aucune ligne des réglages
  // modérateur ne la gouverne, c'est la colonne `responders` qui tranche.
  const verdict = peutRepondreDemande(ctxp.role, ctxp.demandes.repondeurs, locale);
  if (!verdict.autorise) {
    await respond(interaction, `${I.lock} ${verdict.raison}`);
    return;
  }

  const demandeurId = interaction.customId.split(':')[2] ?? '';
  const demandeur = demandeurId ? await guild.members.fetch(demandeurId).catch(() => null) : null;
  if (!demandeur) {
    await respond(interaction, m.panel_tempvoice_err_member_not_found_server({}, { locale }));
    return;
  }

  // Une carte reste cliquable après l'expiration de la demande : sans cette
  // vérification, « Autoriser » accordait encore l'accès des heures plus tard,
  // sur une demande que le registre avait déjà oubliée.
  if (!registreDemandes.demandeEnAttente(guildId, channel.id, demandeurId, maintenant)) {
    await cloreCarteDecision(interaction, `${I.warn} ${m.panel_tempvoice_request_expired_card({ name: demandeur.displayName }, { locale })}`);
    await respond(interaction, `${I.warn} ${m.panel_tempvoice_request_expired_reply({ name: demandeur.displayName }, { locale })}`);
    return;
  }

  // Bannir depuis la carte est un bannissement comme un autre : il passait
  // jusqu'ici sans réglage ni protection de cible, alors que le même geste sur
  // la fiche du membre en exige deux.
  if (decision === 'ban') {
    const verdictBan = peutAgirSurCible(ctxp.role, 'bannir', ctxp.reglages, {
      nom: demandeur.displayName,
      estStaff: await isProtectedTarget(guildId, demandeur),
      estProprietaire: demandeur.id === cache.creatorId,
      estSoiMeme: demandeur.id === interaction.user.id,
      dansLeSalon: demandeur.voice.channelId === channel.id,
      autorise: false,
    }, ctxp.locale);
    if (!verdictBan.autorise) {
      // La demande reste en attente : le refus porte sur le bannissement, pas
      // sur la demande, qu'un autre bouton peut encore trancher.
      await respond(interaction, `${I.warn} ${verdictBan.raison}`);
      return;
    }
  }

  registreDemandes.resoudre(
    guildId,
    channel.id,
    demandeurId,
    decision === 'ok' ? 'acceptee' : 'refusee',
    maintenant,
    { silenceMs: ctxp.demandes.silenceMs },
  );
  // Le silence apres un refus est la moitie utile du garde-fou : le perdre au
  // redemarrage laissait redemander aussitot.
  await persisterEtatSalon(guildId, channel.id);

  if (decision === 'ok') {
    const patch = categoryTrustPatch(channel, demandeur);
    if (!patch) {
      await respond(interaction, m.panel_tempvoice_err_category_denies({ name: demandeur.displayName }, { locale }));
      return;
    }
    await channel.permissionOverwrites.edit(demandeur.id, patch);
    // Marquée comme donnée à la main : un départ du vocal ne doit jamais
    // l'effacer, alors que « Autoriser » et la présence écrivent le même bit.
    originesSurcharge.marquer(guildId, channel.id, demandeur.id, 'autorisation');
    await cloreCarteDecision(interaction, `${I.check} ${m.panel_tempvoice_allowed_in({ name: demandeur.displayName }, { locale })}`);
    await prevenirDemandeur(channel, demandeur, true, ctxp.demandes.silenceMs, locale);
    await respond(interaction, `${I.check} ${m.panel_tempvoice_allowed_to_join({ name: demandeur.displayName }, { locale })}`);
    planifierRafraichissementPanneau(channel);
    return;
  }

  if (decision === 'ban') {
    await channel.permissionOverwrites.edit(demandeur.id, CHANNEL_PATCHES.ban);
    originesSurcharge.oublier(guildId, channel.id, demandeur.id);
    if (demandeur.voice.channelId === channel.id) {
      const oubli = annoncerIntentionVocale(guildId, demandeur.id, 'disconnect', {
        libelle: `${interaction.user.tag} (demande d'accès refusée)`,
      });
      await demandeur.voice
        .disconnect(m.panel_tempvoice_audit_request_denied_ban({}, { locale }))
        .catch(() => oubli());
    }
    await cloreCarteDecision(interaction, `${I.ban} ${m.panel_tempvoice_denied_banned_card({ name: demandeur.displayName }, { locale })}`);
    await prevenirDemandeur(channel, demandeur, false, ctxp.demandes.silenceMs, locale);
    await respond(interaction, `${I.ban} ${m.panel_tempvoice_denied_banned_reply({ name: demandeur.displayName }, { locale })}`);
    planifierRafraichissementPanneau(channel);
    return;
  }

  await cloreCarteDecision(interaction, `${I.cross} ${m.panel_tempvoice_denied({ name: demandeur.displayName }, { locale })}`);
  await prevenirDemandeur(channel, demandeur, false, ctxp.demandes.silenceMs, locale);
  await respond(interaction, `${I.cross} ${m.panel_tempvoice_denied({ name: demandeur.displayName }, { locale })}`);
}

/**
 * Présence dans le salon : l'état vocal du membre fait foi, le cache des
 * occupants sert de second témoin. Les deux disent la même chose en
 * production ; n'en lire qu'un laisse passer le cas où il n'est pas à jour.
 */
function estDansLeSalon(channel: VoiceChannel, membre: GuildMember): boolean {
  if (membre.voice?.channelId === channel.id) return true;
  return channel.members?.has(membre.id) ?? false;
}

/**
 * Ce que la matrice a besoin de savoir d'une cible.
 *
 * `isProtectedTarget` reste la définition du staff : elle n'est pas réinventée
 * ici, elle est appelée.
 */
async function decrireCible(ctx: ActionContext, target: GuildMember): Promise<CibleMembre> {
  return {
    nom: target.displayName,
    estStaff: await isProtectedTarget(ctx.guildId, target),
    estProprietaire: target.id === ctx.cache.creatorId,
    estSoiMeme: target.id === ctx.interaction.user.id,
    dansLeSalon: estDansLeSalon(ctx.channel, target),
    autorise: estAutorise(ctx.channel, target.id),
  };
}

/**
 * Actions de la fiche d'un membre.
 *
 * Chaque site d'appel repasse par `peutAgirSurCible` : le bouton grisé dit la
 * règle, il ne l'applique pas — un identifiant de composant se rejoue.
 */
async function traiterActionMembre(
  ctx: ActionContext,
  action: 'expulser' | 'bannir' | 'autoriser' | 'retirer',
): Promise<void> {
  const { interaction, channel, cache, guild, guildId, ctxp } = ctx;
  const locale = ctxp.locale;

  const cibleId = interaction.customId.split(':')[2] ?? '';
  const target = cibleId ? await guild.members.fetch(cibleId).catch(() => null) : null;
  if (!target) {
    await reponseSupplementaire(interaction, m.panel_tempvoice_err_member_not_found({}, { locale }));
    return;
  }

  // Le bot doit garder l'accès au salon : banni, il ne pourrait plus le
  // supprimer quand il se vide.
  if (target.user.bot) {
    await reponseSupplementaire(interaction, m.panel_tempvoice_err_bot_target({}, { locale }));
    return;
  }

  const cible = await decrireCible(ctx, target);

  const verdict = peutAgirSurCible(
    ctxp.role,
    action === 'retirer' ? 'autoriser' : action,
    ctxp.reglages,
    cible,
    ctxp.locale,
  );
  if (!verdict.autorise) {
    await reponseSupplementaire(interaction, `${I.warn} ${verdict.raison}`);
    return;
  }

  switch (action) {
    case 'expulser': {
      const oubli = annoncerIntentionVocale(guildId, target.id, 'disconnect', {
        libelle: `${interaction.user.tag} (panneau du salon vocal temporaire)`,
      });
      await target.voice
        .disconnect(m.panel_tempvoice_audit_kick_panel({}, { locale }))
        .catch((error: unknown) => {
          oubli();
          throw error;
        });
      await reponseSupplementaire(interaction, `${I.kick} ${m.panel_tempvoice_kicked({ name: target.displayName }, { locale })}`);
      break;
    }

    case 'bannir': {
      await channel.permissionOverwrites.edit(target.id, CHANNEL_PATCHES.ban);
      originesSurcharge.oublier(guildId, channel.id, target.id);
      if (target.voice.channelId === channel.id) {
        const oubli = annoncerIntentionVocale(guildId, target.id, 'disconnect', {
          libelle: `${interaction.user.tag} (panneau du salon vocal temporaire)`,
        });
        await target.voice
          .disconnect(m.panel_tempvoice_audit_ban_panel({}, { locale }))
          .catch(() => oubli());
      }
      await reponseSupplementaire(interaction, `${I.ban} ${m.panel_tempvoice_banned({ name: target.displayName }, { locale })}`);
      break;
    }

    case 'autoriser': {
      if (channel.parentId && !channel.parent) {
        await reponseSupplementaire(interaction, m.panel_tempvoice_err_category_missing({}, { locale }));
        return;
      }
      const patch = categoryTrustPatch(channel, target);
      if (!patch) {
        await reponseSupplementaire(interaction, m.panel_tempvoice_err_category_denies({ name: target.displayName }, { locale }));
        return;
      }
      await channel.permissionOverwrites.edit(target.id, patch);
      // Le marquage est la moitié utile de « Autoriser » : sans lui, quitter le
      // vocal en mode « ceux qui sont en vocal » effacerait ce droit.
      originesSurcharge.marquer(guildId, channel.id, target.id, 'autorisation');
      const complet = Object.keys(patch).length === TRUST_BIT_COUNT;
      await reponseSupplementaire(interaction, complet
        ? `${I.check} ${m.panel_tempvoice_allowed_to_join({ name: target.displayName }, { locale })}`
        : `${I.warn} ${m.panel_tempvoice_partial_access({ name: target.displayName }, { locale })}`);
      break;
    }

    case 'retirer': {
      // Encore présent en mode « ceux qui sont en vocal » : la surcharge reste,
      // mais redevient de la présence et partira avec lui. La retirer ici le
      // rendrait muet alors qu'il est là, ce que le mode promet le contraire.
      const decision = decisionRetraitAutorisation(modeDuSalon(channel, cache), cible.dansLeSalon);

      if (decision.action === 'poser') {
        const posee = await poserSurcharge(channel, target.id, decision.patch);
        if (posee) {
          // Le registre refuse de dégrader `autorisation` en `presence` : c'est
          // son invariant. Ici la dégradation est précisément ce qu'on demande,
          // la marque est donc effacée avant d'être reposée.
          originesSurcharge.oublier(guildId, channel.id, target.id);
          originesSurcharge.marquer(guildId, channel.id, target.id, decision.origine);
        }
      } else if (decision.action === 'retirer') {
        await channel.permissionOverwrites
          .delete(target.id, m.panel_tempvoice_audit_untrust({}, { locale }))
          .catch(() => poserSurcharge(channel, target.id, decision.patch));
        originesSurcharge.oublier(guildId, channel.id, target.id);
      }

      await reponseSupplementaire(interaction, `${I.cross} ${m.panel_tempvoice_access_revoked({ name: target.displayName }, { locale })}`);
      break;
    }
  }

  // La fiche reste sous les yeux de qui vient d'agir : la redessiner sur les
  // vraies données est la moitié visible de l'action. Un seul point plutôt que
  // quatre — expulser, bannir, autoriser et retirer changent tous ce qu'elle
  // affiche.
  await rafraichirFicheMembre(ctx, target);
  planifierRafraichissementPanneau(channel);
}

/**
 * Pose ou lève la réservation du salon, quelle que soit la porte empruntée.
 *
 * Le menu de rôles, la bascule d'un rôle unique et toute autre entrée passent
 * TOUTES par ici : les règles d'accès (la catégorie fait foi, la surcharge
 * précédente se lève, le verrou vient après les autorisations) ne sont écrites
 * qu'une fois. `selectedRoleId` à `null` lève la réservation.
 */
async function appliquerReservation(
  ctx: ActionContext,
  selectedRoleId: string | null,
  reply: (texte: string) => Promise<void>,
): Promise<void> {
  const { channel, cache, guild, guildId } = ctx;
  const locale = ctx.ctxp.locale;
  const stored = await prisma.tempVoiceChannel.findUnique({ where: { id: channel.id } }).catch(() => null);

  const grantForRole = (id: string): Record<string, true> | null =>
    categoryTrustPatch(channel, guild.roles.cache.get(id) ?? null);

  // Réserver accorde, donc la catégorie fait foi ici aussi : sans cette
  // confrontation, une réservation ouvrirait à un rôle que la catégorie
  // refuse - le même travers que « Ajouter ». Le refus est constaté avant
  // toute écriture, sans quoi le verrou resterait pose sur un salon que plus
  // personne ne peut rejoindre.
  const rolePatch = selectedRoleId ? grantForRole(selectedRoleId) : null;
  if (selectedRoleId && !rolePatch) {
    await reply(m.panel_tempvoice_err_role_denied({}, { locale }));
    return;
  }

  // Sans ce retrait, le salon porte au bout de quelques changements la liste
  // de tous les rôles réservés depuis sa création. Le retrait peut échouer, et
  // le membre doit l'apprendre plutôt que de lire une exclusivité fausse.
  let previousCleared = true;
  if (stored?.roleId && stored.roleId !== selectedRoleId) {
    previousCleared = await channel.permissionOverwrites
      .delete(stored.roleId, m.panel_tempvoice_audit_prev_reservation({}, { locale }))
      .then(() => true)
      .catch((err: unknown) => {
        logger.warn('TempVoice', `Impossible de lever la réservation précédente sur ${channel.id} :`, err);
        return false;
      });
  }

  if (selectedRoleId && rolePatch) {
    const owner = guild.members.cache.get(cache.creatorId)
      ?? await guild.members.fetch(cache.creatorId).catch(() => null);
    const ownerPatch = categoryTrustPatch(channel, owner);

    // Les autorisations d'abord, le verrou ensuite : dans l'ordre inverse, un
    // appel refusé entre les deux laisse un salon fermé à tout le monde et
    // sans réservation, que rien ne vient rouvrir.
    if (ownerPatch && owner) await channel.permissionOverwrites.edit(owner, ownerPatch);
    await channel.permissionOverwrites.edit(selectedRoleId, rolePatch);
    await channel.permissionOverwrites.edit(guildId, CHANNEL_PATCHES.lock);
    // Le verrou coupe `SendMessages` a @everyone - le bot compris, tant
    // qu'il n'a pas de surcharge a lui. Sans cela il ne peut plus mettre a
    // jour le panneau ni poster le moindre avis dans le salon.
    await assurerBotPeutEcrire(channel);

    const saved = await prisma.tempVoiceChannel
      .update({ where: { id: channel.id }, data: { roleId: selectedRoleId } })
      .then(() => true)
      .catch((err: unknown) => {
        logger.error('TempVoice', "Erreur lors de l'enregistrement de la réservation :", err);
        return false;
      });

    // Sans la ligne en base, le prochain changement ne saura pas quelle
    // surcharge lever : elles s'accumuleraient sans que personne ne le voie.
    await reply(previousCleared && saved
      ? `${I.shield} ${m.panel_tempvoice_reserved_ok({ role: selectedRoleId }, { locale })}`
      : `${I.shield} ${m.panel_tempvoice_reserved_partial({ role: selectedRoleId }, { locale })}`);
    // Réserver ne déplaçait personne : ceux qui étaient déjà là restaient dans
    // un salon qu'ils n'auraient plus eu le droit de rejoindre.
    await traiterDebordementReservation(ctx, selectedRoleId);
    planifierRafraichissementPanneau(channel);
    return;
  }

  await channel.permissionOverwrites.edit(
    guildId,
    restoreFromCategory(CHANNEL_PATCHES.clearReservation, categoryOverwriteFor(channel, guildId)),
  );
  await prisma.tempVoiceChannel
    .update({ where: { id: channel.id }, data: { roleId: null } })
    .catch((err: unknown) => logger.error('TempVoice', "Erreur lors de l'enregistrement de la réservation :", err));
  await reply(previousCleared
    ? `${I.unlock} ${m.panel_tempvoice_reservation_cleared({}, { locale })}`
    : `${I.unlock} ${m.panel_tempvoice_reservation_cleared_partial({}, { locale })}`);
  planifierRafraichissementPanneau(channel);
  return;
}

/** Le rôle auquel le salon est réservé, ou `null` — lu en base, qui fait foi. */
async function roleReserve(salonId: string): Promise<string | null> {
  return prisma.tempVoiceChannel
    .findUnique({ where: { id: salonId } })
    .then((ligne) => ligne?.roleId ?? null)
    .catch(() => null);
}

/**
 * Repli « MEMBERS » du plan de réservation : verrouiller le salon et y autoriser
 * nommément les personnes choisies.
 *
 * Aucune règle de réservation n'est décidée ici — `planReservation` a déjà
 * tranché que c'est ce chemin-là. La catégorie fait foi pour chaque personne,
 * comme pour « Autoriser », et le verrou ne tombe qu'une fois qu'au moins une
 * autorisation a été accordée : sinon le salon se fermerait sur personne.
 */
async function reserverPourDesMembres(
  ctx: ActionContext,
  idsChoisis: readonly string[],
  reply: (texte: string) => Promise<void>,
): Promise<void> {
  const { channel, guild, guildId, cache } = ctx;
  const locale = ctx.ctxp.locale;

  if (idsChoisis.length === 0) {
    await reply(m.panel_tempvoice_err_nobody_selected_reserve({}, { locale }));
    return;
  }

  const autorises: string[] = [];
  const refuses: string[] = [];

  for (const membreId of idsChoisis) {
    const membre = guild.members.cache.get(membreId) ?? await guild.members.fetch(membreId).catch(() => null);
    // Un bot banni du salon ne pourrait plus le supprimer quand il se vide.
    if (!membre || membre.user?.bot) {
      refuses.push(membreId);
      continue;
    }
    const patch = categoryTrustPatch(channel, membre);
    if (!patch) {
      refuses.push(membre.displayName);
      continue;
    }
    const posee = await poserSurcharge(channel, membre.id, patch);
    if (!posee) {
      refuses.push(membre.displayName);
      continue;
    }
    // Sans ce marquage, quitter le vocal en mode « ceux qui sont en vocal »
    // effacerait ce droit : les deux écrivent la même surcharge.
    originesSurcharge.marquer(guildId, channel.id, membre.id, 'autorisation');
    autorises.push(membre.displayName);
  }

  if (autorises.length === 0) {
    await reply(m.panel_tempvoice_err_nobody_allowed({}, { locale }));
    return;
  }

  // Le propriétaire garde son accès, comme pour une réservation à un rôle.
  const owner = guild.members.cache.get(cache.creatorId)
    ?? await guild.members.fetch(cache.creatorId).catch(() => null);
  const ownerPatch = categoryTrustPatch(channel, owner);
  if (owner && ownerPatch) await channel.permissionOverwrites.edit(owner, ownerPatch);

  await channel.permissionOverwrites.edit(guildId, CHANNEL_PATCHES.lock);
  // Le verrou coupe `SendMessages` a @everyone - le bot compris, tant qu'il n'a
  // pas de surcharge a lui : sans cela, plus de panneau ni d'avis.
  await assurerBotPeutEcrire(channel);

  const reste = refuses.length > 0
    ? (refuses.length > 1 ? m.panel_tempvoice_reserve_refused_many : m.panel_tempvoice_reserve_refused_one)(
      { count: refuses.length },
      { locale },
    )
    : '';
  const phrase = autorises.length > 1
    ? m.panel_tempvoice_reserved_members_many
    : m.panel_tempvoice_reserved_members_one;
  await reply(`${I.lock} ${phrase({ count: autorises.length, names: autorises.join(', '), rest: reste }, { locale })}`);
  planifierRafraichissementPanneau(channel);
}


async function handleTempVoiceAction(ctx: ActionContext): Promise<void> {
  const { interaction, action, channel, cache, guild, guildId } = ctx;
  const user = interaction.user;
  const locale = ctx.ctxp.locale;

  const ephemeral = { flags: [MessageFlags.Ephemeral] as const };
  // En mode compact, la réponse remplace le sous-panneau : elle doit donc
  // porter de quoi y revenir. En mode empilé elle ouvre un message de plus, et
  // le sous-panneau est toujours là derrière — aucun bouton à ajouter.
  const ongletRetour = ctx.ctxp.panneauCompact ? ONGLET_DORIGINE[action] ?? null : null;
  const retourVers = ongletRetour ? { onglet: ongletRetour, locale } : null;
  const reply = (content: string) => respond(interaction, content, retourVers);

  /**
   * Ouvre une des trois portes du panneau.
   *
   * Depuis le panneau public, un ephemere s'ouvre a cote. Depuis un
   * sous-panneau - c'est le cas du bouton « Retour » - il faut reprendre le
   * message existant : sinon le mode compact, dont toute la promesse est de
   * n'avoir qu'un seul ephemere, en empilait un de plus a chaque retour.
   */
  const ouvrirPorte = async (rendu: PanneauRendu): Promise<void> => {
    if (surMessageEphemere(interaction)) {
      await (interaction as unknown as { update: (o: unknown) => Promise<unknown> })
        .update(rendu)
        .catch(() => null);
      return;
    }
    await interaction.reply({ ...rendu, ...ephemeral });
  };

  // ─── Menu « Qui peut écrire » ───
  // L'action est comparée avant le type : un `switch` sur le type d'interaction
  // coûterait un appel de plus à chaque clic, pour un identifiant qui dit déjà
  // lequel est attendu.
  if (action === 'mode_select' && interaction.isStringSelectMenu()) {
    await acquitterMiseAJour(interaction);

    const verdict = peutAgir(ctx.ctxp.role, 'modeEcriture', ctx.ctxp.reglages, ctx.ctxp.locale);
    if (!verdict.autorise) {
      await reponseSupplementaire(interaction, `${I.lock} ${verdict.raison}`);
      return;
    }

    const mode = normaliserModeEcriture(interaction.values[0]);
    await appliquerModeEcriture(channel, cache, mode);
    await rafraichirSousPanneauSalon(ctx);
    await reponseSupplementaire(
      interaction,
      `${iconeMode(mode)} ${m.panel_tempvoice_mode_applied({ mode: libelleModeEcriture(mode, locale).libelle }, { locale })}`,
    );
    planifierRafraichissementPanneau(channel);
    return;
  }

  // ─── Fiche d'un membre : choisir la personne, puis voir ce qui est possible ───
  // Deux portes, une seule fiche : la liste des présents et la recherche dans le
  // serveur mènent au même endroit.
  // ─── Reglages admin, depuis « Salon » ───
  if (action === 'reglages_mod' && interaction.isStringSelectMenu()) {
    if (ctx.ctxp.role !== 'admin') {
      await reponseSupplementaire(interaction, `${I.lock} ${m.panel_tempvoice_err_admin_only_settings({}, { locale })}`);
      return;
    }
    await acquitterMiseAJour(interaction);

    const enregistre = await enregistrerReglagesModerateur(guildId, interaction.values);
    if (!enregistre) {
      await reponseSupplementaire(interaction, m.panel_tempvoice_err_settings_not_saved({}, { locale }));
      return;
    }

    // Relire plutot que deduire : le panneau doit montrer ce que la base porte.
    ctx.ctxp.reglages = (await lireReglagesAdmin(guildId)).reglages;
    await rafraichirSousPanneauSalon(ctx);
    return;
  }

  if (action === 'membre_ici' && interaction.isStringSelectMenu()) {
    await acquitterMiseAJour(interaction);

    const cibleId = interaction.values[0];
    const target = cibleId ? await guild.members.fetch(cibleId).catch(() => null) : null;
    if (!target) {
      await reponseSupplementaire(interaction, m.panel_tempvoice_err_member_left({}, { locale }));
      return;
    }

    const fiche = await ficheMembre(channel, cache, target, user.id, ctx.ctxp);
    await interaction.editReply(fiche).catch(() => null);
    return;
  }

  if (action === 'membre_select' && interaction.isUserSelectMenu()) {
    await acquitterMiseAJour(interaction);

    const cibleId = interaction.values[0];
    const target = cibleId ? await guild.members.fetch(cibleId).catch(() => null) : null;
    if (!target) {
      await reponseSupplementaire(interaction, m.panel_tempvoice_err_member_not_found({}, { locale }));
      return;
    }

    const fiche = await ficheMembre(channel, cache, target, user.id, ctx.ctxp);
    await interaction.editReply(fiche).catch(() => null);
    return;
  }

  if (interaction.isButton()) {
    // `showModal` et les réponses à composants exigent une interaction non
    // acquittée ; les autres touchent Discord avant de répondre.
    const ACKNOWLEDGE_FIRST = new Set([
      'lock', 'unlock', 'chat', 'claim', 'demander',
      // La carte de décision est un message public : la réponse au propriétaire
      // reste éphémère, et c'est `cloreCarteDecision` qui referme la carte.
      'demande_ok', 'demande_non', 'demande_ban',
    ]);
    const ACQUITTER_EN_PLACE = new Set([
      'bascule_verrou',
      'm_kick',
      'm_ban',
      'm_trust',
      'm_untrust',
    ]);
    if (ACKNOWLEDGE_FIRST.has(action)) await deferIfNeeded(interaction, ctx.ctxp.panneauCompact);
    else if (ACQUITTER_EN_PLACE.has(action)) await acquitterMiseAJour(interaction);

    switch (action) {
      // ─── Les trois portes du panneau, plus la quatrième ───
      case 'salon': {
        await ouvrirPorte(await panneauSalon(channel, cache, ctx.ctxp));
        return;
      }

      case 'membres': {
        await ouvrirPorte(await panneauMembres(channel, cache, ctx.ctxp));
        return;
      }

      case 'propriete': {
        await ouvrirPorte(panneauPropriete(channel, cache, ctx.ctxp));
        return;
      }

      // ─── Mode FLAT : la porte des réglages modérateur ───
      // Le menu des réglages ne peut pas vivre sur le message public, qui est lu
      // par tout le monde. Ce bouton ouvre l'éphémère « Salon », qui le porte
      // déjà pour les seuls admins — donc aucun écran de plus à maintenir.
      case 'reglages': {
        if (ctx.ctxp.role !== 'admin') {
          await reply(`${I.lock} ${m.panel_tempvoice_admins_only_settings({}, { locale })}`);
          return;
        }
        await ouvrirPorte(await panneauSalon(channel, cache, ctx.ctxp));
        return;
      }

      case 'demander': {
        await traiterDemandeAcces(ctx);
        return;
      }

      // ─── Sous-panneau « Salon » ───
      case 'bascule_verrou': {
        const verdict = peutAgir(ctx.ctxp.role, 'verrouiller', ctx.ctxp.reglages, ctx.ctxp.locale);
        if (!verdict.autorise) {
          await reponseSupplementaire(interaction, `${I.lock} ${verdict.raison}`);
          return;
        }
        const message = await basculerVerrou(ctx);
        await rafraichirSousPanneauSalon(ctx);
        await reponseSupplementaire(interaction, message);
        planifierRafraichissementPanneau(channel);
        return;
      }

      // ─── Sous-panneau « Membres » ───
      case 'm_kick': {
        await traiterActionMembre(ctx, 'expulser');
        return;
      }
      case 'm_ban': {
        await traiterActionMembre(ctx, 'bannir');
        return;
      }
      case 'm_trust': {
        await traiterActionMembre(ctx, 'autoriser');
        return;
      }
      case 'm_untrust': {
        await traiterActionMembre(ctx, 'retirer');
        return;
      }
      case 'm_transfer': {
        const verdict = peutAgir(ctx.ctxp.role, 'transferer', ctx.ctxp.reglages, ctx.ctxp.locale);
        if (!verdict.autorise) {
          await reponseSupplementaire(interaction, `${I.crown} ${verdict.raison}`);
          return;
        }
        await deferIfNeeded(interaction);
        const cibleId = interaction.customId.split(':')[2] ?? '';
        const target = cibleId ? await guild.members.fetch(cibleId).catch(() => null) : null;
        if (!target) {
          await reply(m.panel_tempvoice_err_member_not_found({}, { locale }));
          return;
        }
        await transferOwnership(ctx, target, 'transfer');
        planifierRafraichissementPanneau(channel);
        return;
      }

      // ─── Suite d'une réservation : que faire de ceux qui restent ───
      case 'resa_rien': {
        await cloreProposition(interaction, `${I.check} ${m.panel_tempvoice_overflow_nobody_moved({}, { locale })}`);
        return;
      }
      case 'resa_deplacer': {
        await repondreDebordement(ctx, 'deplacer');
        return;
      }
      case 'resa_deconnecter': {
        await repondreDebordement(ctx, 'deconnecter');
        return;
      }

      // ─── Carte de décision d'une demande d'accès ───
      case 'demande_ok': {
        await traiterDecisionDemande(ctx, 'ok');
        return;
      }
      case 'demande_non': {
        await traiterDecisionDemande(ctx, 'non');
        return;
      }
      case 'demande_ban': {
        await traiterDecisionDemande(ctx, 'ban');
        return;
      }
      // ─── Identifiants des panneaux posés avant la refonte ───
      // Ils restent acceptés : un salon vivant porte peut-être encore un panneau
      // d'avant, et son propriétaire ne doit pas se retrouver sans boutons. Ce
      // panneau-là se redessine à la première interaction (voir l'écouteur), mais
      // les règles qui s'y appliquent sont exactement celles de la refonte.
      case 'lock': {
        const verrouAutorise = peutAgir(ctx.ctxp.role, 'verrouiller', ctx.ctxp.reglages, ctx.ctxp.locale);
        if (!verrouAutorise.autorise) {
          await reply(`${I.lock} ${verrouAutorise.raison}`);
          return;
        }
        await channel.permissionOverwrites.edit(
          cache.creatorId,
          ownerChatPatch(true, categoryOverwriteFor(channel, cache.creatorId)),
        );
        await channel.permissionOverwrites.edit(guildId, CHANNEL_PATCHES.lock);
        // Le verrou coupe `SendMessages` a @everyone - le bot compris, tant
        // qu'il n'a pas de surcharge a lui. Sans cela il ne peut plus mettre a
        // jour le panneau ni poster le moindre avis dans le salon.
        await assurerBotPeutEcrire(channel);
        await reply(`${I.lock} ${m.panel_tempvoice_locked_legacy({}, { locale })}`);
        planifierRafraichissementPanneau(channel);
        return;
      }

      case 'unlock': {
        const ouvertureAutorisee = peutAgir(ctx.ctxp.role, 'verrouiller', ctx.ctxp.reglages, ctx.ctxp.locale);
        if (!ouvertureAutorisee.autorise) {
          await reply(`${I.lock} ${ouvertureAutorisee.raison}`);
          return;
        }
        await channel.permissionOverwrites.edit(
          guildId,
          restoreFromCategory(CHANNEL_PATCHES.unlock, categoryOverwriteFor(channel, guildId)),
        );
        await channel.permissionOverwrites.edit(
          cache.creatorId,
          ownerChatPatch(false, categoryOverwriteFor(channel, cache.creatorId)),
        );
        await reply(`${I.unlock} ${m.panel_tempvoice_unlocked_legacy({}, { locale })}`);
        planifierRafraichissementPanneau(channel);
        return;
      }

      case 'chat': {
        const ecritureAutorisee = peutAgir(ctx.ctxp.role, 'modeEcriture', ctx.ctxp.reglages, ctx.ctxp.locale);
        if (!ecritureAutorisee.autorise) {
          await reply(`${I.lock} ${ecritureAutorisee.raison}`);
          return;
        }
        // L'état courant décide du sens de la bascule. Il faut le relire :
        // `PermissionOverwriteManager.upsert` ne met pas `permissionOverwrites`
        // à jour, seul `CHANNEL_UPDATE` le fait.
        await guild.channels.fetch(channel.id, { force: true }).catch(() => null);

        const everyoneOverwrite = channel.permissionOverwrites.cache.get(guildId);
        const chatIsOpen = !everyoneOverwrite?.deny.has(PermissionFlagsBits.SendMessages);

        if (chatIsOpen) {
          await channel.permissionOverwrites.edit(
            cache.creatorId,
            ownerChatPatch(true, categoryOverwriteFor(channel, cache.creatorId)),
          );
          await channel.permissionOverwrites.edit(guildId, CHANNEL_PATCHES.closeChat);
          await reply(`💬 ${m.panel_tempvoice_chat_closed({}, { locale })}`);
        } else {
          // Ouvrir le chat ACCORDE le droit d'écrire. Le repasser par la catégorie
          // l'annulait dès qu'elle le refusait : le bouton disait « ouvert » et
          // personne ne pouvait écrire, propriétaire compris. (repris de la PR #533)
          await channel.permissionOverwrites.edit(guildId, CHANNEL_PATCHES.openChat);
          await channel.permissionOverwrites.edit(
            cache.creatorId,
            ownerChatPatch(true, categoryOverwriteFor(channel, cache.creatorId)),
          );
          await reply(`${I.msg} ${m.panel_tempvoice_chat_open({}, { locale })}`);
        }
        planifierRafraichissementPanneau(channel);
        return;
      }

      case 'claim': {
        const recuperationAutorisee = peutAgir(ctx.ctxp.role, 'recuperer', ctx.ctxp.reglages, ctx.ctxp.locale);
        if (!recuperationAutorisee.autorise) {
          await reply(`${I.crown} ${recuperationAutorisee.raison}`);
          return;
        }
        if (channel.members.has(cache.creatorId)) {
          await reply(m.panel_tempvoice_err_owner_still_here({}, { locale }));
          return;
        }
        // On ne reprend que le salon où l'on se trouve : le panneau reste
        // lisible depuis l'extérieur.
        if (!channel.members.has(user.id)) {
          await reply(m.panel_tempvoice_err_join_before_claim({}, { locale }));
          return;
        }
        if (!ctx.actingMember) {
          await reply(m.panel_tempvoice_err_profile_unreadable_formal({}, { locale }));
          return;
        }
        await transferOwnership(ctx, ctx.actingMember, 'claim');
        return;
      }

      case 'limit': {
        const limiteAutorisee = peutAgir(ctx.ctxp.role, 'limite', ctx.ctxp.reglages, ctx.ctxp.locale);
        if (!limiteAutorisee.autorise) {
          await reply(`${I.lock} ${limiteAutorisee.raison}`);
          return;
        }
        await interaction.showModal(
          textModal(
            'tempvoice:limit_modal',
            m.panel_tempvoice_modal_limit_title({}, { locale }),
            m.panel_tempvoice_modal_limit_label({ max: MAX_USER_LIMIT }, { locale }),
            m.panel_tempvoice_modal_limit_placeholder({}, { locale }),
            2,
          ),
        );
        return;
      }

      case 'rename': {
        const renommageAutorise = peutAgir(ctx.ctxp.role, 'renommer', ctx.ctxp.reglages, ctx.ctxp.locale);
        if (!renommageAutorise.autorise) {
          await reply(`${I.lock} ${renommageAutorise.raison}`);
          return;
        }
        // Le bouton se grise avec son décompte, mais un identifiant de composant
        // se rejoue : la fenêtre de saisie ne s'ouvre pas si le quota est épuisé.
        const quotaCourant = quotaRenommage(historiqueRenommage(channel.id), Date.now());
        if (quotaCourant.restants === 0) {
          await reply(
            `${I.warn} ${m.panel_tempvoice_rename_quota({
              max: RENOMMAGES_PAR_FENETRE,
              duration: formaterDuree((quotaCourant.libereA ?? Date.now()) - Date.now(), locale),
            }, { locale })}`,
          );
          return;
        }
        await interaction.showModal(
          textModal(
            'tempvoice:rename_modal',
            m.panel_tempvoice_modal_rename_title({}, { locale }),
            m.panel_tempvoice_modal_rename_label({}, { locale }),
            m.panel_tempvoice_modal_rename_placeholder({}, { locale }),
            50,
          ),
        );
        return;
      }

      case 'kick':
      case 'ban':
      case 'trust':
      case 'transfer': {
        const labels: Record<string, string> = {
          kick: m.panel_tempvoice_pick_kick({}, { locale }),
          ban: m.panel_tempvoice_pick_ban({}, { locale }),
          trust: m.panel_tempvoice_pick_trust({}, { locale }),
          transfer: m.panel_tempvoice_pick_transfer({}, { locale }),
        };
        const ACTION_LEGACY: Readonly<Record<string, ActionPanneau>> = {
          kick: 'expulser', ban: 'bannir', trust: 'autoriser', transfer: 'transferer',
        };
        const cibleeAutorisee = peutAgir(ctx.ctxp.role, ACTION_LEGACY[action] ?? 'autoriser', ctx.ctxp.reglages, ctx.ctxp.locale);
        if (!cibleeAutorisee.autorise) {
          await reply(`${I.lock} ${cibleeAutorisee.raison}`);
          return;
        }
        // Le sélecteur suit le mode du panneau : serveur entier en CLASSIC, les
        // seuls présents en FLAT. Transférer au propriétaire actuel ne ferait
        // rien, l'option n'est donc pas proposée.
        const selecteur = await selecteurPersonnes(channel, ctx.ctxp, `tempvoice:${action}_select`, m.panel_tempvoice_pick_member_placeholder({}, { locale }), {
          exclureId: action === 'transfer' ? cache.creatorId : undefined,
        });
        if (!selecteur) {
          await reply(`${I.warn} ${m.panel_tempvoice_err_nobody_to_act_on({}, { locale })}`);
          return;
        }
        await interaction.reply({
          embeds: [avis(labels[action] ?? m.panel_tempvoice_pick_member({}, { locale }))],
          components: [selecteur],
          ...ephemeral,
        });
        return;
      }

      case 'reserve': {
        const reservationAutorisee = peutAgir(ctx.ctxp.role, 'reserver', ctx.ctxp.reglages, ctx.ctxp.locale);
        if (!reservationAutorisee.autorise) {
          await reply(`${I.lock} ${reservationAutorisee.raison}`);
          return;
        }
        // ─── Ce que « Réserver » fait ici est décidé par `planReservation` ───
        // Aucune de ses règles n'est recopiée : le plan a été calculé une fois,
        // avec les rôles de la personne qui clique, les rôles réservables du
        // serveur et le repli réglé par l'administration.
        const plan = ctx.ctxp.plan;

        if (plan.type === 'interdit') {
          await reply(`${I.lock} ${m.panel_tempvoice_err_reserve_no_role({}, { locale })}`);
          return;
        }

        if (plan.type === 'membres') {
          // Repli « MEMBERS » : pas de rôle à choisir, des personnes. Plusieurs
          // à la fois, parce que réserver à une seule n'a pas de sens.
          // Même règle que le transfert : en FLAT, on ne cherche personne dans
          // le serveur, on choisit parmi les présents.
          const qui = await selecteurPersonnes(channel, ctx.ctxp, 'tempvoice:reserve_membres', m.panel_tempvoice_reserve_members_placeholder({}, { locale }), {
            maxValues: MAX_UTILISATEURS_MENU,
          });
          if (!qui) {
            await reply(`${I.warn} ${m.panel_tempvoice_err_nobody_to_reserve_for({}, { locale })}`);
            return;
          }
          await interaction.reply({
            embeds: [avis(`${I.profile} ${m.panel_tempvoice_reserve_members_hint({}, { locale })}`)],
            components: [qui],
            ...ephemeral,
          });
          return;
        }

        // La reservation en cours est preselectionnee : on voit ce qui est pose,
        // et la retirer devient un clic dans le menu plutot qu'un acte de foi.
        // `setMinValues(0)` est ce qui autorise a tout decocher.
        const reservationPosee = await roleReserve(channel.id);

        if (plan.type === 'role_unique') {
          // Un seul rôle réservable possédé : le bouton est une bascule, pas un
          // menu à une option. Un clic pose la réservation, le suivant la lève.
          await deferIfNeeded(interaction, ctx.ctxp.panneauCompact);
          await appliquerReservation(ctx, reservationPosee === plan.roleId ? null : plan.roleId, reply);
          return;
        }

        // `menu_roles` : seulement CES rôles-là — ceux que la personne porte et
        // que l'administration a prévus. `tous_roles` : le menu libre de Discord.
        // Un rôle supprimé depuis le réglage ne doit pas occuper une option morte.
        const rolesPrevus = (plan.type === 'menu_roles' ? plan.roleIds : [])
          .map((id) => guild.roles.cache.get(id))
          .filter((role): role is NonNullable<typeof role> => Boolean(role))
          .slice(0, MAX_OPTIONS_MENU);

        const invite = reservationPosee
          ? m.panel_tempvoice_reserve_role_untick({}, { locale })
          : m.panel_tempvoice_reserve_role_pick({}, { locale });

        // Liste imposee des que le plan en donne une qui tient debout. Si tous
        // les roles prevus ont disparu, mieux vaut le menu libre qu'un menu
        // vide, que Discord refuserait en bloc.
        const menuRole = rolesPrevus.length > 0
          ? new StringSelectMenuBuilder()
            .setCustomId('tempvoice:reserve_select')
            .setPlaceholder(invite)
            .setMinValues(0)
            .setMaxValues(1)
            .addOptions(rolesPrevus.map((role) => new StringSelectMenuOptionBuilder()
              .setLabel(role.name.slice(0, 100))
              .setValue(role.id)
              .setDefault(role.id === reservationPosee)))
          : new RoleSelectMenuBuilder()
            .setCustomId('tempvoice:reserve_select')
            .setPlaceholder(invite)
            .setMinValues(0)
            .setMaxValues(1);

        // Un role supprime depuis la reservation ferait rejeter le message
        // entier : la preselection ne vaut que si le role existe encore.
        if (
          menuRole instanceof RoleSelectMenuBuilder
          && reservationPosee
          && guild.roles.cache.has(reservationPosee)
        ) {
          menuRole.setDefaultRoles(reservationPosee);
        }

        await interaction.reply({
          embeds: [avis(reservationPosee
            ? m.panel_tempvoice_reserve_role_hint_set({ role: reservationPosee }, { locale })
            : m.panel_tempvoice_reserve_role_hint({}, { locale }))],
          components: [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menuRole)],
          allowedMentions: { parse: [] },
          ...ephemeral,
        });
        return;
      }

      default:
        return;
    }
  }

  // Deux formes de menu pour la meme decision : liste imposee par
  // l'administration, ou choix libre parmi les roles du serveur.
  if ((interaction.isRoleSelectMenu() || interaction.isStringSelectMenu()) && action === 'reserve_select') {
    await deferIfNeeded(interaction);

    const reservationAutorisee = peutAgir(ctx.ctxp.role, 'reserver', ctx.ctxp.reglages, ctx.ctxp.locale);
    if (!reservationAutorisee.autorise) {
      await reply(`${I.lock} ${reservationAutorisee.raison}`);
      return;
    }

    // Le menu de Discord ne propose pas @everyone, mais la valeur reçue reste
    // une donnée du client : elle est vérifiée comme celle de la route.
    const chosen = interaction.values[0] ?? null;
    const selectedRoleId = chosen
      ? resolveReservationRoleId(chosen, guildId, new Set(guild.roles.cache.keys()))
      : null;

    if (chosen && !selectedRoleId) {
      await reply(m.panel_tempvoice_err_role_not_usable({}, { locale }));
      return;
    }
    await appliquerReservation(ctx, selectedRoleId, reply);
    return;
  }

  // ─── Repli « MEMBERS » : réserver à des personnes, pas à un rôle ───
  // Le plan vient de `planReservation` ; ici on ne fait qu'appliquer ce qu'il a
  // décidé : verrouiller le salon, puis autoriser nommément les gens choisis.
  // En FLAT, le même `custom_id` arrive en menu de PRÉSENTS (`StringSelect`) au
  // lieu du sélecteur serveur — voir `selecteurPersonnes`. Les deux formes ne
  // portent que des identifiants de membres.
  if ((interaction.isUserSelectMenu() || interaction.isStringSelectMenu()) && action === 'reserve_membres') {
    await deferIfNeeded(interaction);

    const verdictMembres = peutAgir(ctx.ctxp.role, 'reserver', ctx.ctxp.reglages, ctx.ctxp.locale);
    if (!verdictMembres.autorise) {
      await reply(`${I.lock} ${verdictMembres.raison}`);
      return;
    }
    await reserverPourDesMembres(ctx, interaction.values, reply);
    return;
  }

  // Les `*_select` (kick, ban, trust, transfer) arrivent en sélecteur serveur en
  // CLASSIC et en menu de PRÉSENTS en FLAT : dans les deux cas une liste
  // d'identifiants de membres, et les gardes qui suivent valent pour les deux.
  // Tous les autres menus déroulants du module sont traités plus haut et ne
  // parviennent jamais ici.
  if (interaction.isUserSelectMenu() || interaction.isStringSelectMenu()) {
    await deferIfNeeded(interaction);

    const targetId = interaction.values[0];
    if (!targetId) {
      await reply(m.panel_tempvoice_err_no_member_selected({}, { locale }));
      return;
    }

    const target = await guild.members.fetch(targetId).catch(() => null);
    if (!target) {
      await reply(m.panel_tempvoice_err_member_not_found({}, { locale }));
      return;
    }

    // Le bot doit garder l'accès au salon : banni, il ne pourrait plus le
    // supprimer quand il se vide, et le salon resterait ouvert indéfiniment.
    if (target.user.bot) {
      await reply(m.panel_tempvoice_err_bot_target({}, { locale }));
      return;
    }

    // Le propriétaire est protégé de ses propres invités, pas du staff : le
    // salon renommé en insulte est précisément le cas où la modération doit
    // pouvoir agir sur lui.
    const actingAsStaff = await isStaff(guildId, ctx.actingMember);
    if (target.id === cache.creatorId && !actingAsStaff) {
      await reply(m.panel_tempvoice_err_owner_target({}, { locale }));
      return;
    }

    switch (action) {
      case 'transfer_select': {
        const transfertAutorise = peutAgir(ctx.ctxp.role, 'transferer', ctx.ctxp.reglages, ctx.ctxp.locale);
        if (!transfertAutorise.autorise) {
          await reply(`${I.crown} ${transfertAutorise.raison}`);
          return;
        }
        await transferOwnership(ctx, target, 'transfer');
        planifierRafraichissementPanneau(channel);
        return;
      }

      case 'trust_select': {
        const verdictAutorisation = peutAgirSurCible(
          ctx.ctxp.role,
          'autoriser',
          ctx.ctxp.reglages,
          await decrireCible(ctx, target),
          ctx.ctxp.locale,
        );
        if (!verdictAutorisation.autorise) {
          await reply(`${I.warn} ${verdictAutorisation.raison}`);
          return;
        }
        // On lit les droits *effectifs* de la cible : une catégorie restreinte
        // se configure par un refus à @everyone et une autorisation à un rôle,
        // que personne ne porte nommément.
        // Catégorie configurée mais introuvable : le dire, plutôt que de laisser
        // le refus générique ci-dessous parler d'un accès refusé.
        if (channel.parentId && !channel.parent) {
          await reply(m.panel_tempvoice_err_category_missing({}, { locale }));
          return;
        }

        const patch = categoryTrustPatch(channel, target);
        if (!patch) {
          await reply(m.panel_tempvoice_err_category_denies({ name: target.displayName }, { locale }));
          return;
        }

        await channel.permissionOverwrites.edit(target.id, patch);

        // La moitié utile de « Autoriser » : sans ce marquage, quitter le vocal en
        // mode « ceux qui sont en vocal » effacerait ce droit, les deux écrivant
        // exactement la même surcharge.
        originesSurcharge.marquer(guildId, channel.id, target.id, 'autorisation');

        // Un patch partiel n'est pas un accès : le dire plutôt que d'annoncer
        // une réussite que la catégorie contredit.
        const fullAccess = Object.keys(patch).length === TRUST_BIT_COUNT;
        await reply(fullAccess
          ? `${ICONES_ABSENTES.ajouter} ${m.panel_tempvoice_allowed_to_join({ name: target.displayName }, { locale })}`
          : `${I.warn} ${m.panel_tempvoice_partial_access({ name: target.displayName }, { locale })}`);
        planifierRafraichissementPanneau(channel);
        return;
      }

      case 'kick_select': {
        const verdictExpulsion = peutAgirSurCible(
          ctx.ctxp.role,
          'expulser',
          ctx.ctxp.reglages,
          await decrireCible(ctx, target),
          ctx.ctxp.locale,
        );
        if (!verdictExpulsion.autorise) {
          await reply(`${I.warn} ${verdictExpulsion.raison}`);
          return;
        }
        const oublierExpulsion = annoncerIntentionVocale(guildId, target.id, 'disconnect', {
          libelle: `${user.tag} (panneau du salon vocal temporaire)`,
        });
        await target.voice
          .disconnect(m.panel_tempvoice_audit_kick_owner({}, { locale }))
          .catch((error: unknown) => {
            oublierExpulsion();
            throw error;
          });
        await reply(`${I.kick} ${m.panel_tempvoice_kicked({ name: target.displayName }, { locale })}`);
        planifierRafraichissementPanneau(channel);
        return;
      }

      case 'ban_select': {
        const verdictBannissement = peutAgirSurCible(
          ctx.ctxp.role,
          'bannir',
          ctx.ctxp.reglages,
          await decrireCible(ctx, target),
          ctx.ctxp.locale,
        );
        if (!verdictBannissement.autorise) {
          await reply(`${I.warn} ${verdictBannissement.raison}`);
          return;
        }
        await channel.permissionOverwrites.edit(target.id, CHANNEL_PATCHES.ban);
        if (target.voice.channelId === channel.id) {
          const oublierBannissement = annoncerIntentionVocale(guildId, target.id, 'disconnect', {
            libelle: `${user.tag} (panneau du salon vocal temporaire)`,
          });
          await target.voice
            .disconnect(m.panel_tempvoice_audit_ban_owner({}, { locale }))
            .catch(() => oublierBannissement());
        }
        originesSurcharge.oublier(guildId, channel.id, target.id);
        await reply(`${I.ban} ${m.panel_tempvoice_banned({ name: target.displayName }, { locale })}`);
        planifierRafraichissementPanneau(channel);
        return;
      }

      default:
        return;
    }
  }

  if (interaction.isModalSubmit()) {
    await deferIfNeeded(interaction);

    const value = interaction.fields.getTextInputValue('value').trim();

    if (action === 'limit_modal') {
      // La borne est celle de la politique : l'écrire ici la figerait au jour
      // où elle a été écrite, comme le nombre de droits d'un accès complet.
      const limit = Number.parseInt(value, 10);
      if (!Number.isFinite(limit) || limit < 0 || limit > MAX_USER_LIMIT) {
        await reply(m.panel_tempvoice_err_invalid_number({ max: MAX_USER_LIMIT }, { locale }));
        return;
      }
      await channel.setUserLimit(limit);
      await reply(limit === 0
        ? `${I.profile} ${m.panel_tempvoice_limit_removed({}, { locale })}`
        : `${I.profile} ${m.panel_tempvoice_limit_set({ limit }, { locale })}`);
      planifierRafraichissementPanneau(channel);
      return;
    }

    if (action === 'rename_modal') {
      if (!value) {
        await reply(m.panel_tempvoice_err_name_empty({}, { locale }));
        return;
      }

      // Discord n'accepte que deux renommages par tranche de dix minutes, et
      // `@discordjs/rest` ne rejette pas au-delà : il attend la fin de la
      // fenêtre puis rejoue la requête. Un `.catch` ne voit donc jamais ce cas.
      // On borne l'attente pour pouvoir répondre - la requête, elle, suit son
      // cours, d'où la formulation : « pas confirmé », et non « échoue ».
      const newName = value.slice(0, 100);
      // Le quota se consomme à l'envoi, pas à la confirmation : Discord compte la
      // requête même quand il la met en attente, et c'est justement ce cas que le
      // bouton doit annoncer.
      noterRenommage(channel.id);
      const renamed = await settleWithin(channel.setName(newName), RENAME_TIMEOUT_MS);

      if (renamed.status === 'failed') {
        // Un vrai refus : nom invalide, salon disparu, droits perdus. Annoncer
        // une attente serait faux - il ne s'appliquera jamais.
        logger.warn('TempVoice', `Impossible de renommer le salon ${channel.id} :`, renamed.error);
        await reply(m.panel_tempvoice_err_name_rejected({}, { locale }));
        return;
      }

      planifierRafraichissementPanneau(channel);
      await reply(
        renamed.status === 'done'
          ? `${ICONES_ABSENTES.renommer} ${m.panel_tempvoice_renamed({ name: newName }, { locale })}`
          : m.panel_tempvoice_rename_unconfirmed({}, { locale }),
      );
      return;
    }
  }
}

/** Passe la propriété d'un salon : le nouveau est écrit en base, sans quoi un
 *  redémarrage rendrait le salon à son créateur d'origine. */
function transferOwnership(
  ctx: ActionContext,
  target: GuildMember | null,
  kind: 'claim' | 'transfer',
): Promise<void> {
  return serializeByChannel(ctx.channel.id, () => applyOwnershipTransfer(ctx, target, kind));
}

async function applyOwnershipTransfer(
  ctx: ActionContext,
  target: GuildMember | null,
  kind: 'claim' | 'transfer',
): Promise<void> {
  const { interaction, channel, cache, guild, guildId } = ctx;
  const locale = ctx.ctxp.locale;
  if (!target) return;

  // La garde de « Récupérer » a été évaluée avant la mise en file : deux
  // réclamations simultanées la passent toutes les deux. Elle est revue ici.
  if (kind === 'claim' && channel.members.has(cache.creatorId)) {
    await respond(interaction, m.panel_tempvoice_err_owner_still_here({}, { locale }));
    return;
  }

  // Relu ici, et non avant la mise en file : un transfert précédent a pu changer
  // le propriétaire pendant l'attente.
  const previousOwnerId = cache.creatorId;

  // Les pouvoirs suivent le salon, pas la configuration courante : la politique
  // du générateur a pu changer depuis, ou le générateur disparaître.
  //
  // Le salon est relu avant : une surcharge que nous venons d'écrire n'est pas
  // dans le cache, `PermissionOverwriteManager.upsert` n'y touchant pas. Deux
  // transferts qui se suivent liraient sinon une absence, et le nouveau
  // propriétaire recevrait la politique du générateur au lieu des pouvoirs que
  // le salon portait réellement.
  await guild.channels.fetch(channel.id, { force: true }).catch(() => null);

  const previousOverwrite = channel.permissionOverwrites.cache.get(previousOwnerId);
  let powers = previousOverwrite ? ownerPowersFromBits(previousOverwrite.allow.bitfield) : [];

  if (!previousOverwrite) {
    // Repli quand la surcharge a été effacée à la main : seul le générateur
    // principal fait autorité, sinon la politique par défaut. Un additionnel ne
    // régit que ses propres salons.
    const guildConfig = await getCachedGuild(guildId);
    const generators = guildConfig
      ? resolveTempVoiceGenerators(guildConfig as unknown as TempVoiceGuildConfig, guildId)
      : [];
    const mainGenerator = generators.find((entry) => entry.primary);
    powers = mainGenerator?.policy.ownerPowers ?? defaultTempVoicePolicy().ownerPowers;
  }

  await channel.permissionOverwrites.edit(
    target.id,
    ownerPermissionPatch(powers, categoryOverwriteFor(channel, target.id)),
  );

  if (previousOwnerId !== target.id) {
    // Type explicite : sans lui, `upsert` cherche la cible dans `roles.cache`
    // puis `users.cache` et lève avant tout appel réseau si aucun ne la connaît.
    // Un ancien propriétaire hors cache garderait ses pouvoirs.
    await channel.permissionOverwrites
      .edit(
        previousOwnerId,
        ownerRevokedPermissions(categoryOverwriteFor(channel, previousOwnerId)),
        { type: OverwriteType.Member },
      )
      .catch((err: unknown) => logger.warn('TempVoice', `Impossible de retirer les pouvoirs de l'ancien propriétaire sur ${channel.id} :`, err));
  }

  cache.creatorId = target.id;
  await prisma.tempVoiceChannel
    .update({ where: { id: channel.id }, data: { creatorId: target.id } })
    .catch((err: unknown) => logger.error('TempVoice', "Erreur lors de l'enregistrement du propriétaire :", err));

  const message = kind === 'claim'
    ? m.panel_tempvoice_claimed({ name: target.displayName }, { locale })
    : m.panel_tempvoice_transferred({ name: target.displayName }, { locale });

  await respond(interaction, message);

  // « Récupérer » est ouvert à tous : la réponse reste privée pour qu'un refus
  // ne s'affiche pas devant le salon, la reprise est annoncée dans le salon.
  if (kind === 'claim') {
    await channel.send({ content: message }).catch(() => null);
  }
}
