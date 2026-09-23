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
import { getCachedGuild } from '../utils/cache.js';
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
  LIBELLES_MODES_ECRITURE,
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
    case 'everyone': return LIBELLES_MODES_ECRITURE.everyone.emoji ?? ICONES_ABSENTES.globe;
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

/** Un salon temporaire disparaît : ses demandes, ses marques d'origine et son
 *  historique de renommage aussi, sans laisser de ligne orpheline. */
function oublierSalon(guildId: string, salonId: string): void {
  registreDemandes.oublierSalon(guildId, salonId);
  originesSurcharge.oublierSalon(guildId, salonId);
  historiquesRenommage.delete(salonId);
  const fenetre = rafraichissements.get(salonId);
  if (fenetre) clearTimeout(fenetre.minuteur);
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
    };
  }
  if (!ligne) {
    return {
      reglages: normaliserReglagesAdmin(undefined),
      panneauCompact: false,
      reservation: normaliserConfigReservation(undefined),
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

const FENETRE_COALESCENCE_MS = 1_500;

interface FenetreRafraichissement {
  minuteur: ReturnType<typeof setTimeout>;
  /** Un changement est arrivé pendant la fenêtre : il lui faut son passage. */
  enAttente: boolean;
}

const rafraichissements = new Map<string, FenetreRafraichissement>();

/**
 * Le panneau dit l'état du salon : le laisser mentir une seconde de plus que
 * nécessaire est le seul vrai défaut qu'il puisse avoir.
 *
 * La première action réécrit donc **tout de suite**, et c'est la rafale qui est
 * amortie derrière — l'inverse de ce que faisait l'anti-rebond, qui faisait
 * attendre deux secondes à un simple clic sur « Verrouiller ». Les changements
 * survenus pendant la fenêtre déclenchent un unique passage de rattrapage à sa
 * fermeture : deux écritures par fenêtre au pire, loin du plafond de Discord
 * (cinq éditions par tranche de cinq secondes et par salon).
 */
function planifierRafraichissementPanneau(channel: VoiceChannel): void {
  const fenetre = rafraichissements.get(channel.id);
  if (fenetre) {
    fenetre.enAttente = true;
    return;
  }

  void lancerReecriture(channel);

  const minuteur = setTimeout(() => {
    const courante = rafraichissements.get(channel.id);
    rafraichissements.delete(channel.id);
    if (courante?.enAttente) void lancerReecriture(channel);
  }, FENETRE_COALESCENCE_MS);

  // Un minuteur en attente garderait le process en vie : le panneau n'est pas
  // une raison de ne pas s'arrêter.
  (minuteur as unknown as { unref?: () => void }).unref?.();
  rafraichissements.set(channel.id, { minuteur, enAttente: false });
}

function lancerReecriture(channel: VoiceChannel): Promise<void> {
  return reecrirePanneau(channel).catch((err: unknown) => {
    logger.warn('TempVoice', `Impossible de réécrire le panneau de ${channel.id} :`, err);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Durées en français
// ─────────────────────────────────────────────────────────────────────────────

function formaterDuree(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const heures = Math.round(minutes / 60);
  if (heures < 24) return `${heures} h`;
  const jours = Math.round(heures / 24);
  if (jours < 31) return `${jours} jour${jours > 1 ? 's' : ''}`;
  const mois = Math.round(jours / 30);
  if (mois < 12) return `${mois} mois`;
  const annees = Math.round(mois / 12);
  return `${annees} an${annees > 1 ? 's' : ''}`;
}

const PERMISSION_LABELS: Record<string, string> = {
  [String(PermissionFlagsBits.ManageChannels)]: 'Gérer les salons',
  [String(PermissionFlagsBits.MoveMembers)]: 'Déplacer les membres',
  [String(PermissionFlagsBits.MuteMembers)]: 'Rendre muet',
  [String(PermissionFlagsBits.DeafenMembers)]: 'Rendre sourd',
  [String(PermissionFlagsBits.ManageMessages)]: 'Gérer les messages',
  [String(PermissionFlagsBits.SendMessages)]: 'Envoyer des messages',
  [String(PermissionFlagsBits.ReadMessageHistory)]: 'Voir les anciens messages',
  [String(PermissionFlagsBits.ManageRoles)]: 'Gérer les rôles',
  [String(PermissionFlagsBits.ViewChannel)]: 'Voir le salon',
  [String(PermissionFlagsBits.Connect)]: 'Se connecter',
  [String(PermissionFlagsBits.Speak)]: 'Parler',
};

/** Droits manquants au bot : Discord refuse un salon dont une surcharge accorde
 *  un droit que le bot n'a pas lui-même, la liste suit donc les pouvoirs cochés. */
function missingBotPermissions(
  guild: DiscordGuild,
  policy: TempVoicePolicy,
  parent?: CategoryChannel,
): string[] {
  const me = guild.members.me;
  // Membre bot non résolu : aucun droit ne peut être confirmé, donc tous sont
  // déclarés manquants - une vérification censée fermer la porte ne l'ouvre pas.
  const effective = me ? (parent ? parent.permissionsFor(me) : me.permissions) : null;

  return requiredBotPermissions(policy)
    .filter((permission) => !effective?.has(permission))
    .map((permission) => PERMISSION_LABELS[String(permission)] ?? String(permission));
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
      return [] as Array<{ id: string; creatorId: string; guildId: string; writeMode: string | null }>;
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
      await closeTempChannel(channel, 'Salon vocal temporaire vide au démarrage');
      removed += 1;
      continue;
    }

    // « Ceux qui sont en vocal » ne se relit dans aucune surcharge : sans la
    // colonne, il redevenait « ouvert » au redémarrage et ses surcharges de
    // présence restaient derrière lui. `null` = salon d'avant la colonne, le
    // mode reste déduit.
    const entree: EntreeSalonTemporaire = {
      creatorId: entry.creatorId,
      ...(estModeEcriture(entry.writeMode) ? { modeEcriture: entry.writeMode } : {}),
    };
    tempChannels.set(entry.id, entree);
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
function resteEnClair(etat: EtatSalon): string {
  if (etat.placesLibres === null) return 'places illimitées';
  if (etat.placesLibres === 0) return 'complet';
  return `${etat.placesLibres} place${etat.placesLibres > 1 ? 's' : ''} libre${etat.placesLibres > 1 ? 's' : ''}`;
}

function carteEtat(etat: EtatSalon): EmbedBuilder {
  const mode = LIBELLES_MODES_ECRITURE[etat.modeEcriture];

  return new EmbedBuilder()
    .setTitle(`${etat.verrouille ? I.lock : I.unlock} ${etat.verrouille ? 'Verrouillé' : 'Ouvert'} · ${resteEnClair(etat)}`)
    // Le ping va ici, jamais dans le titre : Discord n'interprète les mentions
    // ni dans un titre ni dans une ligne d'auteur, elles s'y afficheraient en
    // brut. Seules la description et la valeur d'un champ les rendent cliquables.
    .setDescription(`${I.voice} Salon de <@${etat.proprietaireId}>`)
    .setColor(etat.verrouille ? COULEUR_FERME : COULEUR_OUVERT)
    .addFields(
      { name: 'État', value: `${etat.verrouille ? I.lock : I.unlock} ${etat.verrouille ? 'Verrouillé' : 'Ouvert'}`, inline: true },
      { name: 'Places', value: `${I.profile} ${etat.occupants} / ${etat.limite > 0 ? etat.limite : '∞'}`, inline: true },
      { name: 'Écriture', value: `${iconeModeCarte(etat.modeEcriture)} ${mode.libelle}`, inline: true },
      { name: 'Autorisés', value: `${I.check} ${etat.autorises}`, inline: true },
      { name: 'Bannis', value: `${I.ban} ${etat.bannis}`, inline: true },
      { name: 'Réservé', value: etat.reserveRoleId ? `${I.shield} <@&${etat.reserveRoleId}>` : `${I.shield} Non`, inline: true },
    )
    .setFooter({ text: 'Kotbo · Salon temporaire' })
    .setTimestamp();
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
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  const boutons: ButtonBuilder[] = [
    avecIcone(new ButtonBuilder().setCustomId('tempvoice:salon').setLabel('Salon').setStyle(ButtonStyle.Secondary), I.settings),
    avecIcone(new ButtonBuilder().setCustomId('tempvoice:membres').setLabel('Membres').setStyle(ButtonStyle.Secondary), I.profile),
    avecIcone(new ButtonBuilder().setCustomId('tempvoice:propriete').setLabel('Propriété').setStyle(ButtonStyle.Secondary), I.crown),
  ];

  // Sur un salon simplement *plein*, demander l'accès ne changerait rien :
  // c'est une place qui manque, pas une permission. Et le bouton n'existe pas
  // du tout tant qu'un administrateur ne l'a pas activé. La règle est dans le
  // service, pas recopiée ici.
  if (boutonDemanderAccesVisible({ verrouille: etat.verrouille, reserve: etat.reserveRoleId !== null }, demandes)) {
    boutons.push(
      avecIcone(
        new ButtonBuilder().setCustomId('tempvoice:demander').setLabel("Demander l'accès").setStyle(ButtonStyle.Primary),
        I.unlock,
      ),
    );
  }

  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...boutons);
}

interface PanneauRendu {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

async function construirePanneau(channel: VoiceChannel, entree: EntreeSalonTemporaire): Promise<PanneauRendu> {
  const etat = await lireEtatSalon(channel, entree);
  const demandes = await lireConfigDemandes(channel.guild?.id ?? '');
  return { embeds: [carteEtat(etat)], components: [rangeePrincipale(etat, demandes)] };
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

async function reecrirePanneau(channel: VoiceChannel): Promise<void> {
  const entree = tempChannels.get(channel.id);
  if (!entree) return;

  const message = await retrouverPanneau(channel, entree);
  if (!message) return;

  await relireSalon(channel);

  const panneau = await construirePanneau(channel, entree);

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
  await message.edit({ content: `<@${entree.creatorId}>`, ...panneau }).catch((err: unknown) => {
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
  /** Réglage admin : un seul éphémère réécrit sur place, avec un bouton
   *  « Retour », plutôt qu'un message de plus à chaque action. */
  panneauCompact: boolean;
  /** Rôles proposés à la réservation, et sort de ceux qui restent sans le rôle. */
  reservation: ConfigReservation;
  /** Ce que le dashboard a réglé pour les demandes d'accès : qui répond, où, et
   *  avec quels délais. Membre du contexte pour qu'aucun appelant ne l'oublie. */
  demandes: ConfigDemandesAcces;
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

  const lignes = [`Tu interviens sur le salon de <@${entree.creatorId}>. Tes actions sont journalisées.`];
  const raison = raisonAdminsSeulement(reglagesVerrouilles(ctxp.reglages));
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
  const maintenant = Date.now();
  const quota = quotaRenommage(historiqueRenommage(channel.id), maintenant);

  const verrou = peutAgir(ctxp.role, 'verrouiller', ctxp.reglages);
  const limite = peutAgir(ctxp.role, 'limite', ctxp.reglages);
  const renommer = peutAgir(ctxp.role, 'renommer', ctxp.reglages);
  const reserver = peutAgir(ctxp.role, 'reserver', ctxp.reglages);
  const modeEcriture = peutAgir(ctxp.role, 'modeEcriture', ctxp.reglages);

  const bascule = avecIcone(
    new ButtonBuilder()
      .setCustomId('tempvoice:bascule_verrou')
      .setLabel(etat.verrouille ? 'Verrouillé' : 'Ouvert')
      .setStyle(etat.verrouille ? ButtonStyle.Danger : ButtonStyle.Success),
    etat.verrouille ? I.lock : I.unlock,
  );

  const rangeeBoutons = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    selonVerdict(bascule, verrou),
    selonVerdict(
      avecIcone(
        new ButtonBuilder()
          .setCustomId('tempvoice:limit')
          .setLabel(`Limite : ${etat.limite > 0 ? etat.limite : 'illimitée'}`)
          .setStyle(ButtonStyle.Primary),
        I.profile,
      ),
      limite,
    ),
    // `libelleRenommer` porte déjà son ✏️ : l'icône « renommer » manque au jeu `ktb_`.
    selonVerdict(
      new ButtonBuilder()
        .setCustomId('tempvoice:rename')
        .setLabel(libelleRenommer(quota, maintenant))
        .setStyle(ButtonStyle.Primary)
        .setDisabled(quota.restants === 0),
      renommer,
    ),
    selonVerdict(
      avecIcone(
        new ButtonBuilder()
          .setCustomId('tempvoice:reserve')
          .setLabel(`Réservé : ${etat.reserveRoleId ? 'oui' : 'non'}`)
          .setStyle(ButtonStyle.Secondary),
        I.shield,
      ),
      reserver,
    ),
  );

  const menu = new StringSelectMenuBuilder()
    .setCustomId('tempvoice:mode_select')
    .setPlaceholder(`Chat du salon · qui peut écrire : ${LIBELLES_MODES_ECRITURE[etat.modeEcriture].libelle}`)
    .setDisabled(!modeEcriture.autorise)
    .addOptions(
      MODES_ECRITURE.map((mode) => {
        const libelle = LIBELLES_MODES_ECRITURE[mode];
        return avecIcone(
          new StringSelectMenuOptionBuilder()
            // Discord affiche le libellé de l'option active à la place du texte
            // d'invite : sans ce préfixe, le menu replié n'annonce que « Moi
            // seul » et ne dit nulle part de quoi il parle.
            .setLabel(`Chat : ${libelle.libelle}`)
            .setDescription(libelle.description)
            .setValue(mode)
            .setDefault(mode === etat.modeEcriture),
          iconeMode(mode),
        );
      }),
    );

  return {
    embeds: encartRole(entree, ctxp),
    components: [
      rangeeBoutons,
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu),
    ],
  };
}

/** 👥 Membres — une porte au lieu de quatre : on choisit d'abord la personne. */
/** Discord n'accepte pas plus de vingt-cinq options dans un menu. */
const MAX_OPTIONS_MENU = 25;

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

  const invite = new EmbedBuilder()
    .setColor(COULEUR_NEUTRE)
    .setTitle('Qui ?')
    .setDescription(presents.length === 0
      ? "Personne n'est dans le salon pour l'instant : cherche n'importe qui du serveur."
      : tronquee
        ? `Choisis quelqu'un du salon — les ${listes.length} premiers sont listés — ou cherche n'importe qui du serveur.`
        : "Choisis quelqu'un qui est dans le salon, ou cherche n'importe qui du serveur.");

  const rangees: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];

  // Un menu sans option fait rejeter le message entier par Discord : la rangée
  // n'existe que lorsqu'il y a quelqu'un à y mettre.
  if (listes.length > 0) {
    rangees.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('tempvoice:membre_ici')
          .setPlaceholder(`Dans le salon · ${presents.length} personne${presents.length > 1 ? 's' : ''}`)
          .addOptions(
            listes.map((membre) => new StringSelectMenuOptionBuilder()
              // Discord plafonne un libellé à cent caractères, et un pseudo
              // Discord peut aller au-delà une fois décoré.
              .setLabel(membre.displayName.slice(0, 100))
              .setValue(membre.id)),
          ),
      ),
    );
  }

  rangees.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId('tempvoice:membre_select')
        .setPlaceholder('Chercher n\'importe qui du serveur…')
        .setMinValues(1)
        .setMaxValues(1),
    ),
  );

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

  const expulser = peutAgirSurCible(ctxp.role, 'expulser', ctxp.reglages, cible);
  const bannir = peutAgirSurCible(ctxp.role, 'bannir', ctxp.reglages, cible);
  const autoriser = peutAgirSurCible(ctxp.role, 'autoriser', ctxp.reglages, cible);
  const transferer = peutAgirSurCible(ctxp.role, 'transferer', ctxp.reglages, cible);

  const acces = banni ? `${I.ban} Banni` : autorise ? `${I.check} Autorisé` : `${I.dot} Non autorisé`;
  const roleAffiche = cibleMembre.roles?.highest?.name && cibleMembre.roles.highest.name !== '@everyone'
    ? cibleMembre.roles.highest.name
    : 'Membre';

  const fiche = new EmbedBuilder()
    .setColor(COULEUR_NEUTRE)
    .setTitle(cibleMembre.displayName)
    .addFields(
      { name: 'Présence', value: dansLeSalon ? `${I.voice} Dans le salon` : `${I.dot} Hors du salon`, inline: true },
      { name: 'Accès', value: acces, inline: true },
      { name: 'Rôle', value: roleAffiche, inline: true },
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
          .setLabel(libelleActionMembre('expulser', cible))
          .setStyle(ButtonStyle.Danger),
        I.kick,
      ),
      expulser,
    ),
    selonVerdict(
      avecIcone(
        new ButtonBuilder()
          .setCustomId(`tempvoice:m_ban:${cibleMembre.id}`)
          .setLabel(libelleActionMembre('bannir', cible))
          .setStyle(ButtonStyle.Danger),
        I.ban,
      ),
      bannir,
    ),
    selonVerdict(
      avecIcone(
        new ButtonBuilder()
          .setCustomId(`tempvoice:${autorise ? 'm_untrust' : 'm_trust'}:${cibleMembre.id}`)
          .setLabel(libelleActionMembre('autoriser', cible))
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
          .setLabel(libelleActionMembre('transferer', cible))
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
                .setLabel('Transférer le salon')
                .setStyle(ButtonStyle.Primary),
              I.crown,
            ),
            peutAgir(ctxp.role, 'transferer', ctxp.reglages),
          ),
        ),
      ],
    };
  }

  const depuis = entree.departProprietaireA
    ? ` il y a ${formaterDuree(Date.now() - entree.departProprietaireA)}`
    : '';

  const abandon = new EmbedBuilder()
    .setColor(COULEUR_NEUTRE)
    .setTitle(`${I.crown} Le salon n'a plus de propriétaire`)
    .setDescription(`<@${entree.creatorId}> a quitté le salon${depuis}.`);

  return {
    embeds: [abandon],
    components: [
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        // L'icône « récupérer » manque au jeu `ktb_` : l'Unicode reste.
        new ButtonBuilder()
          .setCustomId('tempvoice:claim')
          .setLabel(`${ICONES_ABSENTES.recuperer} Récupérer le salon`)
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
): PanneauRendu {
  const anciennete = demandeur.joinedTimestamp
    ? `depuis ${formaterDuree(Date.now() - demandeur.joinedTimestamp)}`
    : 'date inconnue';
  const roleAffiche = demandeur.roles?.highest?.name && demandeur.roles.highest.name !== '@everyone'
    ? demandeur.roles.highest.name
    : 'Membre';

  const carte = new EmbedBuilder()
    .setColor(COULEUR_ACCENT)
    .setTitle(`${I.profile} ${demandeur.displayName} demande à entrer`)
    .addFields(
      { name: 'Dans le serveur', value: anciennete, inline: true },
      { name: 'Rôle', value: roleAffiche, inline: true },
      { name: 'Déjà refusée ici', value: dejaRefuse ? `${I.cross} Oui` : `${I.dot} Non`, inline: true },
    )
    .setFooter({ text: `Expire dans ${formaterDuree(Math.max(0, expireA - Date.now()))}` });

  return {
    embeds: [carte],
    components: [
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        avecIcone(
          new ButtonBuilder()
            .setCustomId(identifiantDecision('ok', demandeur.id, salonId))
            .setLabel('Autoriser')
            .setStyle(ButtonStyle.Success),
          I.check,
        ),
        avecIcone(
          new ButtonBuilder()
            .setCustomId(identifiantDecision('non', demandeur.id, salonId))
            .setLabel('Refuser')
            .setStyle(ButtonStyle.Danger),
          I.cross,
        ),
        avecIcone(
          new ButtonBuilder()
            .setCustomId(identifiantDecision('ban', demandeur.id, salonId))
            .setLabel('Refuser et bannir')
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

  const policy = generator.policy;

  // La catégorie configurée peut avoir été supprimée ou recréée autrement :
  // sans parent, il n'y a rien à hériter.
  const parent = generator.categoryId ? guild.channels.cache.get(generator.categoryId) : undefined;
  const parentCategory = parent?.type === ChannelType.GuildCategory ? parent : undefined;

  const missing = missingBotPermissions(guild, policy, parentCategory);
  if (missing.length > 0) {
    logger.warn('TempVoice', `Droits manquants sur ${guild.name} (${guild.id}) : ${missing.join(', ')}`);
    await member
      .send(
        `❌ Le salon temporaire n'a pas pu être créé sur **${guild.name}** : il manque au bot ${missing.length > 1 ? 'les droits' : 'le droit'} « ${missing.join(' » et « ')} ».`,
      )
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
      reason: `Création de salon temporaire pour ${member.user.tag}`,
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
    await tempChannel.delete('Déplacement vers le salon temporaire impossible').catch(() => null);
    logger.warn('TempVoice', `Déplacement impossible pour ${member.user.tag}, salon temporaire annulé.`);
    return;
  }

  tempChannels.set(tempChannel.id, { creatorId: member.id });

  await prisma.tempVoiceChannel
    .create({ data: { id: tempChannel.id, guildId: guild.id, creatorId: member.id } })
    .catch((err: unknown) => logger.error('TempVoice', "Erreur lors de l'enregistrement du salon temporaire :", err));

  // La ligne de mention au-dessus de l'embed reste : c'est elle qui déclenche la
  // notification, un embed n'en produisant aucune.
  const entree = tempChannels.get(tempChannel.id) ?? { creatorId: member.id };
  const panneau = await construirePanneau(tempChannel, entree);

  // Une categorie qui refuse `SendMessages` a @everyone prive aussi le bot, qui
  // n'a pas de surcharge a lui : le panneau ne serait jamais poste, et le salon
  // naitrait sans aucune commande.
  await assurerBotPeutEcrire(tempChannel);

  const poste = await tempChannel
    .send({ content: `<@${member.id}>`, ...panneau })
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
            await newState.disconnect('Accès au salon générateur restreint').catch(() => oublierRefus());
            await member
              .send(`❌ Vous n'avez pas le rôle requis pour utiliser le salon générateur de salons temporaires sur le serveur **${guild.name}**.`)
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
          const closed = await closeTempChannel(oldChannel, 'Salon vocal temporaire vide');
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

    const cache = tempChannels.get(channel.id);
    if (!cache) {
      await interaction
        .reply({ content: "❌ Ce salon n'est plus enregistré comme temporaire.", flags: [MessageFlags.Ephemeral] })
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
        .reply({ content: '❌ Seul le propriétaire du salon peut effectuer cette action.', flags: [MessageFlags.Ephemeral] })
        .catch(() => null);
      return;
    }

    // Le rôle et les réglages sont lus une fois, ici : `peutAgir` refuse toute
    // valeur par défaut, un appelant qui les oublierait obtiendrait un panneau
    // tout permis.
    const ctxp: ContextePanneau = {
      role: await roleAgissant(guildId, actingMember, cache.creatorId),
      ...(await lireReglagesAdmin(guildId)),
      demandes: await lireConfigDemandes(guildId),
    };

    // Les panneaux déjà postés avant la refonte restent en place dans les salons
    // vivants. Leurs identifiants de boutons continuent d'être acceptés (voir le
    // `switch`), et la première interaction redessine le message : personne ne
    // reste devant onze boutons qui ne disent pas l'état du salon.
    planifierRafraichissementPanneau(channel);

    try {
      await handleTempVoiceAction({ interaction, action, channel, cache, guild, guildId, actingMember, ctxp });
    } catch (err) {
      logger.error('TempVoice', `Erreur lors de l'action « ${action} » :`, err);
      const message = { content: "❌ L'action n'a pas pu être appliquée.", flags: [MessageFlags.Ephemeral] as const };
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

const LIBELLES_ONGLETS: Readonly<Record<OngletPanneau, string>> = {
  salon: 'Salon',
  membres: 'Membres',
  propriete: 'Propriété',
};

function rangeeRetour(onglet: OngletPanneau): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`tempvoice:${onglet}`)
      .setLabel(`Retour · ${LIBELLES_ONGLETS[onglet]}`)
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Secondary),
  );
}

async function respond(
  interaction: RepliableInteraction,
  content: string,
  retour?: OngletPanneau | null,
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    // En mode compact, le verdict prend la place du menu qui l'a provoqué :
    // laisser ce menu rendrait cliquable un sélecteur déjà consommé, et le
    // bouton « Retour » est ce qui évite de rester devant une phrase sans issue.
    const charge = retour
      ? { content, components: [rangeeRetour(retour)], embeds: [] }
      : { content };
    await interaction.editReply(charge).catch(() => null);
    return;
  }
  await interaction.reply({ content, flags: [MessageFlags.Ephemeral] }).catch(() => null);
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

function userPicker(customId: string, placeholder: string) {
  return new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
    new UserSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).setMinValues(1).setMaxValues(1),
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
  if (interaction.isMessageComponent()) {
    await interaction.deferUpdate().catch(() => null);
    return;
  }
  await deferIfNeeded(interaction);
}

/** Une réponse qui ne remplace pas le sous-panneau ouvert : elle s'ajoute à côté. */
async function reponseSupplementaire(interaction: RepliableInteraction, texte: string): Promise<void> {
  const message = { content: texte, flags: [MessageFlags.Ephemeral] as const };
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
    return `${I.unlock} Le salon est ouvert : il retrouve l'accès prévu par sa catégorie.`;
  }

  await channel.permissionOverwrites.edit(
    cache.creatorId,
    ownerChatPatch(true, categoryOverwriteFor(channel, cache.creatorId)),
  );
  await channel.permissionOverwrites.edit(guildId, CHANNEL_PATCHES.lock);
  return `${I.lock} Le salon est verrouillé : seuls toi, les rôles autorisés d'office et les membres que tu as ajoutés peuvent encore le rejoindre.`;
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
      const poste = await channel.send({ content: mention, ...carte }).catch((err: unknown) => {
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
    const poste = await dedie.send({ content: mention, ...carte }).catch((err: unknown) => {
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

  const verdict = peutAgir(ctxp.role, 'demanderAcces', ctxp.reglages);
  if (!verdict.autorise) {
    await respond(interaction, `${I.crown} ${verdict.raison}`);
    return;
  }

  // Un panneau posté avant qu'un administrateur ne désactive les demandes porte
  // encore le bouton : le refus se dit ici, le bouton grisé ne suffit pas.
  if (!ctxp.demandes.activees) {
    await respond(interaction, `${I.lock} Les demandes d'accès ne sont pas activées sur ce serveur.`);
    return;
  }

  const etat = await lireEtatSalon(channel, cache);
  if (!boutonDemanderAccesVisible({ verrouille: etat.verrouille, reserve: etat.reserveRoleId !== null }, ctxp.demandes)) {
    await respond(interaction, `${I.unlock} Le salon est ouvert : tu peux le rejoindre directement.`);
    return;
  }

  const resultat = registreDemandes.demander(guildId, channel.id, demandeurId, maintenant, {
    expirationMs: ctxp.demandes.expirationMs,
    silenceMs: ctxp.demandes.silenceMs,
  });

  if (resultat.statut === 'silence') {
    await respond(
      interaction,
      `${I.cross} Ta demande a été refusée récemment. Tu pourras redemander dans ${formaterDuree(resultat.resteMs)}.`,
    );
    return;
  }

  if (resultat.statut === 'dejaEnAttente') {
    await respond(
      interaction,
      `${I.warn} Ta demande est déjà en attente : elle expire dans ${formaterDuree(resultat.resteMs)}.`,
    );
    return;
  }

  const demandeur = await guild.members.fetch(demandeurId).catch(() => null);
  if (!demandeur) {
    annulerDemande(guildId, channel.id, demandeurId, maintenant);
    await respond(interaction, "❌ Ton profil sur ce serveur n'a pas pu être lu : réessaie dans un instant.");
    return;
  }

  const carte = carteDecision(
    demandeur,
    channel.id,
    registreDemandes.estEnSilence(guildId, channel.id, demandeurId, maintenant),
    resultat.demande.expireA,
  );
  const voie = await transmettreCarteDecision(channel, guild, cache.creatorId, ctxp.demandes, carte);

  if (!voie) {
    // Aucun canal n'a abouti : laisser la demande en attente ferait patienter
    // le demandeur devant une réponse que personne ne peut lui donner.
    annulerDemande(guildId, channel.id, demandeurId, maintenant);
    await respond(interaction, "❌ La demande n'a pas pu être transmise au propriétaire.");
    return;
  }

  await interaction
    .editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COULEUR_NEUTRE)
          .setTitle(`${I.check} Demande envoyée`)
          .setDescription(`<@${cache.creatorId}> a été prévenu. Tu seras autorisé dès qu'il accepte.`),
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
  const noms = plan.membres.map((id) => `<@${id}>`).join(', ');
  const embed = new EmbedBuilder()
    .setColor(COULEUR_ACCENT)
    .setTitle(`${I.warn} ${plan.membres.length} personne${plan.membres.length > 1 ? 's' : ''} sans le rôle`)
    .setDescription(`${noms} ${plan.membres.length > 1 ? 'sont' : 'est'} dans le salon sans avoir le rôle réservé. Que veux-tu en faire ?`);

  const rangee = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('tempvoice:resa_rien')
      .setLabel('Les laisser')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('tempvoice:resa_deplacer')
      .setLabel(ctx.ctxp.reservation.salonDeRepli ? 'Les déplacer' : 'Les déconnecter (aucun salon défini)')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('tempvoice:resa_deconnecter')
      .setLabel('Les déconnecter')
      .setStyle(ButtonStyle.Danger),
  );

  await ctx.interaction
    .followUp({ embeds: [embed], components: [rangee], allowedMentions: { parse: [] }, flags: [MessageFlags.Ephemeral] })
    .catch(() => null);
}

/** Déplacer ou déconnecter, en annonçant l'intention au journal de modération. */
async function appliquerDebordement(ctx: ActionContext, plan: PlanDebordement): Promise<void> {
  const { channel, guild, guildId, interaction } = ctx;

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
      ? await membre.voice.setChannel(accueil as never, 'Salon réservé à un rôle').then(() => true).catch(() => { oubli(); return false; })
      : await membre.voice.disconnect('Salon réservé à un rôle').then(() => true).catch(() => { oubli(); return false; });

    if (fait) traites += 1;
  }

  if (traites === 0) return;

  const ou = deplace && accueil ? ` vers <#${accueil.id}>` : '';
  const motif = plan.repliSurDeconnexion ? " — aucun salon d'accueil n'est défini" : '';
  await reponseSupplementaire(
    interaction,
    `${I.voice} ${traites} personne${traites > 1 ? 's' : ''} déplacée${traites > 1 ? 's' : ''}${ou}${motif}.`.replace(
      'déplacée', deplace ? 'déplacée' : 'déconnectée',
    ),
  );
}

/** Referme la proposition : ses boutons ne doivent pas rester cliquables. */
async function cloreProposition(interaction: RepliableInteraction, verdict: string): Promise<void> {
  if (!interaction.isMessageComponent()) return;
  await interaction.update({ content: verdict, embeds: [], components: [] }).catch(() => null);
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

  const verdict = peutAgir(ctxp.role, 'reserver', ctxp.reglages);
  if (!verdict.autorise) {
    await respond(interaction, `${I.lock} ${verdict.raison}`);
    return;
  }

  const roleId = await prisma.tempVoiceChannel
    .findUnique({ where: { id: channel.id } })
    .then((ligne) => ligne?.roleId ?? null)
    .catch(() => null);

  if (!roleId) {
    await cloreProposition(interaction, `${I.unlock} Le salon n'est plus réservé : il n'y a plus rien à faire.`);
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
    await cloreProposition(interaction, `${I.check} Plus personne n'est concerné.`);
    return;
  }

  const salon = choix === 'deplacer' ? ctxp.reservation.salonDeRepli : null;
  await cloreProposition(interaction, `${I.voice} C'est en cours…`);
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
    .edit({ components: [], content: verdictAffiche })
    .catch(() => null);
}

/** Le refus reste privé : l'écrire dans un salon que tout le monde lit
 *  transformerait un réglage de confort en humiliation. */
async function prevenirDemandeur(
  channel: VoiceChannel,
  demandeur: GuildMember,
  acceptee: boolean,
  silenceMs: number,
): Promise<void> {
  const embed = acceptee
    ? new EmbedBuilder()
      .setColor(COULEUR_OUVERT)
      .setTitle(`${I.check} Tu peux entrer`)
      .setDescription(`Ta demande a été acceptée. Le salon **${channel.name}** t'est ouvert.`)
    : new EmbedBuilder()
      .setColor(COULEUR_NEUTRE)
      .setTitle(`${I.cross} Demande refusée`)
      // Le délai du serveur, et non celui du registre : un seul registre sert
      // tous les serveurs, annoncer son défaut donnerait un chiffre faux dès
      // qu'un administrateur règle le sien.
      .setDescription(`Tu pourras redemander dans ${formaterDuree(silenceMs)}.`);

  const envoye = await demandeur.send({ embeds: [embed] }).then(() => true).catch(() => false);

  // Les MP fermés font échouer l'envoi en silence. L'acceptation peut se dire
  // dans le salon — la personne y entre de toute façon ; le refus, non.
  if (!envoye && acceptee) {
    await channel.send({ content: `${I.check} <@${demandeur.id}> a été autorisé à rejoindre le salon.` }).catch(() => null);
  }
}

/** Réponse du propriétaire à une demande d'accès. */
async function traiterDecisionDemande(ctx: ActionContext, decision: 'ok' | 'non' | 'ban'): Promise<void> {
  const { interaction, channel, cache, guild, guildId, ctxp } = ctx;
  const maintenant = Date.now();

  // `peutAgir` ne sait rien de cette action : aucune ligne des réglages
  // modérateur ne la gouverne, c'est la colonne `responders` qui tranche.
  const verdict = peutRepondreDemande(ctxp.role, ctxp.demandes.repondeurs);
  if (!verdict.autorise) {
    await respond(interaction, `${I.lock} ${verdict.raison}`);
    return;
  }

  const demandeurId = interaction.customId.split(':')[2] ?? '';
  const demandeur = demandeurId ? await guild.members.fetch(demandeurId).catch(() => null) : null;
  if (!demandeur) {
    await respond(interaction, '❌ Ce membre est introuvable sur le serveur.');
    return;
  }

  // Une carte reste cliquable après l'expiration de la demande : sans cette
  // vérification, « Autoriser » accordait encore l'accès des heures plus tard,
  // sur une demande que le registre avait déjà oubliée.
  if (!registreDemandes.demandeEnAttente(guildId, channel.id, demandeurId, maintenant)) {
    await cloreCarteDecision(interaction, `${I.warn} La demande de **${demandeur.displayName}** a expiré.`);
    await respond(interaction, `${I.warn} Cette demande a expiré : **${demandeur.displayName}** doit la renouveler.`);
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
    });
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

  if (decision === 'ok') {
    const patch = categoryTrustPatch(channel, demandeur);
    if (!patch) {
      await respond(interaction, `❌ La catégorie du salon refuse l'accès à **${demandeur.displayName}**.`);
      return;
    }
    await channel.permissionOverwrites.edit(demandeur.id, patch);
    // Marquée comme donnée à la main : un départ du vocal ne doit jamais
    // l'effacer, alors que « Autoriser » et la présence écrivent le même bit.
    originesSurcharge.marquer(guildId, channel.id, demandeur.id, 'autorisation');
    await cloreCarteDecision(interaction, `${I.check} **${demandeur.displayName}** a été autorisé.`);
    await prevenirDemandeur(channel, demandeur, true, ctxp.demandes.silenceMs);
    await respond(interaction, `${I.check} **${demandeur.displayName}** a été autorisé à rejoindre le salon.`);
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
      await demandeur.voice.disconnect('Demande d\'accès refusée et bannissement du salon.').catch(() => oubli());
    }
    await cloreCarteDecision(interaction, `${I.ban} **${demandeur.displayName}** a été refusé et banni.`);
    await prevenirDemandeur(channel, demandeur, false, ctxp.demandes.silenceMs);
    await respond(interaction, `${I.ban} **${demandeur.displayName}** a été refusé et banni du salon.`);
    planifierRafraichissementPanneau(channel);
    return;
  }

  await cloreCarteDecision(interaction, `${I.cross} **${demandeur.displayName}** a été refusé.`);
  await prevenirDemandeur(channel, demandeur, false, ctxp.demandes.silenceMs);
  await respond(interaction, `${I.cross} **${demandeur.displayName}** a été refusé.`);
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

  const cibleId = interaction.customId.split(':')[2] ?? '';
  const target = cibleId ? await guild.members.fetch(cibleId).catch(() => null) : null;
  if (!target) {
    await reponseSupplementaire(interaction, '❌ Membre introuvable sur le serveur.');
    return;
  }

  // Le bot doit garder l'accès au salon : banni, il ne pourrait plus le
  // supprimer quand il se vide.
  if (target.user.bot) {
    await reponseSupplementaire(interaction, '❌ Un bot ne peut pas être ciblé par cette action.');
    return;
  }

  const cible = await decrireCible(ctx, target);

  const verdict = peutAgirSurCible(
    ctxp.role,
    action === 'retirer' ? 'autoriser' : action,
    ctxp.reglages,
    cible,
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
      await target.voice.disconnect('Expulsé du salon vocal temporaire depuis le panneau.').catch((error: unknown) => {
        oubli();
        throw error;
      });
      await reponseSupplementaire(interaction, `${I.kick} **${target.displayName}** a été expulsé du salon vocal.`);
      break;
    }

    case 'bannir': {
      await channel.permissionOverwrites.edit(target.id, CHANNEL_PATCHES.ban);
      originesSurcharge.oublier(guildId, channel.id, target.id);
      if (target.voice.channelId === channel.id) {
        const oubli = annoncerIntentionVocale(guildId, target.id, 'disconnect', {
          libelle: `${interaction.user.tag} (panneau du salon vocal temporaire)`,
        });
        await target.voice.disconnect('Banni du salon vocal temporaire depuis le panneau.').catch(() => oubli());
      }
      await reponseSupplementaire(interaction, `${I.ban} **${target.displayName}** a été banni du salon, chat textuel compris.`);
      break;
    }

    case 'autoriser': {
      if (channel.parentId && !channel.parent) {
        await reponseSupplementaire(interaction, "❌ La catégorie du salon est introuvable : impossible de vérifier l'accès.");
        return;
      }
      const patch = categoryTrustPatch(channel, target);
      if (!patch) {
        await reponseSupplementaire(interaction, `❌ La catégorie du salon refuse l'accès à **${target.displayName}**.`);
        return;
      }
      await channel.permissionOverwrites.edit(target.id, patch);
      // Le marquage est la moitié utile de « Autoriser » : sans lui, quitter le
      // vocal en mode « ceux qui sont en vocal » effacerait ce droit.
      originesSurcharge.marquer(guildId, channel.id, target.id, 'autorisation');
      const complet = Object.keys(patch).length === TRUST_BIT_COUNT;
      await reponseSupplementaire(interaction, complet
        ? `${I.check} **${target.displayName}** a été autorisé à rejoindre le salon.`
        : `${I.warn} **${target.displayName}** n'a reçu qu'un accès partiel : la catégorie lui refuse le reste.`);
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
          .delete(target.id, 'Autorisation retirée depuis le panneau')
          .catch(() => poserSurcharge(channel, target.id, decision.patch));
        originesSurcharge.oublier(guildId, channel.id, target.id);
      }

      await reponseSupplementaire(interaction, `${I.cross} L'accès de **${target.displayName}** a été retiré.`);
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

async function handleTempVoiceAction(ctx: ActionContext): Promise<void> {
  const { interaction, action, channel, cache, guild, guildId } = ctx;
  const user = interaction.user;

  const ephemeral = { flags: [MessageFlags.Ephemeral] as const };
  // En mode compact, la réponse remplace le sous-panneau : elle doit donc
  // porter de quoi y revenir. En mode empilé elle ouvre un message de plus, et
  // le sous-panneau est toujours là derrière — aucun bouton à ajouter.
  const retourVers = ctx.ctxp.panneauCompact ? ONGLET_DORIGINE[action] ?? null : null;
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

    const verdict = peutAgir(ctx.ctxp.role, 'modeEcriture', ctx.ctxp.reglages);
    if (!verdict.autorise) {
      await reponseSupplementaire(interaction, `${I.lock} ${verdict.raison}`);
      return;
    }

    const mode = normaliserModeEcriture(interaction.values[0]);
    await appliquerModeEcriture(channel, cache, mode);
    await rafraichirSousPanneauSalon(ctx);
    await reponseSupplementaire(
      interaction,
      `${iconeMode(mode)} Qui peut écrire : **${LIBELLES_MODES_ECRITURE[mode].libelle}**.`,
    );
    planifierRafraichissementPanneau(channel);
    return;
  }

  // ─── Fiche d'un membre : choisir la personne, puis voir ce qui est possible ───
  // Deux portes, une seule fiche : la liste des présents et la recherche dans le
  // serveur mènent au même endroit.
  if (action === 'membre_ici' && interaction.isStringSelectMenu()) {
    await acquitterMiseAJour(interaction);

    const cibleId = interaction.values[0];
    const target = cibleId ? await guild.members.fetch(cibleId).catch(() => null) : null;
    if (!target) {
      await reponseSupplementaire(interaction, '❌ Ce membre a quitté le serveur.');
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
      await reponseSupplementaire(interaction, '❌ Membre introuvable sur le serveur.');
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

      case 'demander': {
        await traiterDemandeAcces(ctx);
        return;
      }

      // ─── Sous-panneau « Salon » ───
      case 'bascule_verrou': {
        const verdict = peutAgir(ctx.ctxp.role, 'verrouiller', ctx.ctxp.reglages);
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
        const verdict = peutAgir(ctx.ctxp.role, 'transferer', ctx.ctxp.reglages);
        if (!verdict.autorise) {
          await reponseSupplementaire(interaction, `${I.crown} ${verdict.raison}`);
          return;
        }
        await deferIfNeeded(interaction);
        const cibleId = interaction.customId.split(':')[2] ?? '';
        const target = cibleId ? await guild.members.fetch(cibleId).catch(() => null) : null;
        if (!target) {
          await reply('❌ Membre introuvable sur le serveur.');
          return;
        }
        await transferOwnership(ctx, target, 'transfer');
        planifierRafraichissementPanneau(channel);
        return;
      }

      // ─── Suite d'une réservation : que faire de ceux qui restent ───
      case 'resa_rien': {
        await cloreProposition(interaction, `${I.check} Personne n'a été déplacé.`);
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
        const verrouAutorise = peutAgir(ctx.ctxp.role, 'verrouiller', ctx.ctxp.reglages);
        if (!verrouAutorise.autorise) {
          await reply(`${I.lock} ${verrouAutorise.raison}`);
          return;
        }
        await channel.permissionOverwrites.edit(
          cache.creatorId,
          ownerChatPatch(true, categoryOverwriteFor(channel, cache.creatorId)),
        );
        await channel.permissionOverwrites.edit(guildId, CHANNEL_PATCHES.lock);
        await reply(`${I.lock} Le salon a été verrouillé : seuls vous, les rôles autorisés d'office et les membres que vous avez ajoutés peuvent encore le rejoindre.`);
        planifierRafraichissementPanneau(channel);
        return;
      }

      case 'unlock': {
        const ouvertureAutorisee = peutAgir(ctx.ctxp.role, 'verrouiller', ctx.ctxp.reglages);
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
        await reply(`${I.unlock} Le salon a été déverrouillé : il retrouve l'accès prévu par sa catégorie.`);
        planifierRafraichissementPanneau(channel);
        return;
      }

      case 'chat': {
        const ecritureAutorisee = peutAgir(ctx.ctxp.role, 'modeEcriture', ctx.ctxp.reglages);
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
          await reply("💬 Le chat textuel du salon est fermé : seuls vous et les membres autorisés peuvent y écrire.");
        } else {
          await channel.permissionOverwrites.edit(
            guildId,
            restoreFromCategory(CHANNEL_PATCHES.openChat, categoryOverwriteFor(channel, guildId)),
          );
          await channel.permissionOverwrites.edit(
            cache.creatorId,
            ownerChatPatch(false, categoryOverwriteFor(channel, cache.creatorId)),
          );
          await reply(`${I.msg} Le chat textuel du salon retrouve l'accès prévu par sa catégorie.`);
        }
        planifierRafraichissementPanneau(channel);
        return;
      }

      case 'claim': {
        const recuperationAutorisee = peutAgir(ctx.ctxp.role, 'recuperer', ctx.ctxp.reglages);
        if (!recuperationAutorisee.autorise) {
          await reply(`${I.crown} ${recuperationAutorisee.raison}`);
          return;
        }
        if (channel.members.has(cache.creatorId)) {
          await reply('❌ Le propriétaire actuel du salon vocal est toujours présent.');
          return;
        }
        // On ne reprend que le salon où l'on se trouve : le panneau reste
        // lisible depuis l'extérieur.
        if (!channel.members.has(user.id)) {
          await reply("❌ Rejoignez le salon vocal avant d'en récupérer la propriété.");
          return;
        }
        if (!ctx.actingMember) {
          await reply("❌ Votre profil sur ce serveur n'a pas pu être lu : réessayez dans un instant.");
          return;
        }
        await transferOwnership(ctx, ctx.actingMember, 'claim');
        return;
      }

      case 'limit': {
        const limiteAutorisee = peutAgir(ctx.ctxp.role, 'limite', ctx.ctxp.reglages);
        if (!limiteAutorisee.autorise) {
          await reply(`${I.lock} ${limiteAutorisee.raison}`);
          return;
        }
        await interaction.showModal(
          textModal(
            'tempvoice:limit_modal',
            "👥 Limite d'utilisateurs",
            `Nombre max (0 pour illimité, max ${MAX_USER_LIMIT})`,
            'Ex: 5',
            2,
          ),
        );
        return;
      }

      case 'rename': {
        const renommageAutorise = peutAgir(ctx.ctxp.role, 'renommer', ctx.ctxp.reglages);
        if (!renommageAutorise.autorise) {
          await reply(`${I.lock} ${renommageAutorise.raison}`);
          return;
        }
        // Le bouton se grise avec son décompte, mais un identifiant de composant
        // se rejoue : la fenêtre de saisie ne s'ouvre pas si le quota est épuisé.
        const quotaCourant = quotaRenommage(historiqueRenommage(channel.id), Date.now());
        if (quotaCourant.restants === 0) {
          await reply(
            `${I.warn} Discord n'accepte que ${RENOMMAGES_PAR_FENETRE} renommages par tranche de dix minutes : réessaie dans ${formaterDuree((quotaCourant.libereA ?? Date.now()) - Date.now())}.`,
          );
          return;
        }
        await interaction.showModal(
          textModal('tempvoice:rename_modal', '✏️ Renommer le salon', 'Nouveau nom du salon', 'Ex: Blabla Gaming', 50),
        );
        return;
      }

      case 'kick':
      case 'ban':
      case 'trust':
      case 'transfer': {
        const labels: Record<string, string> = {
          kick: '👢 Sélectionnez le membre à expulser du salon.',
          ban: '🚫 Sélectionnez le membre à bannir du salon.',
          trust: '➕ Sélectionnez le membre à autoriser.',
          transfer: '👑 Sélectionnez le nouveau propriétaire du salon.',
        };
        const ACTION_LEGACY: Readonly<Record<string, ActionPanneau>> = {
          kick: 'expulser', ban: 'bannir', trust: 'autoriser', transfer: 'transferer',
        };
        const cibleeAutorisee = peutAgir(ctx.ctxp.role, ACTION_LEGACY[action] ?? 'autoriser', ctx.ctxp.reglages);
        if (!cibleeAutorisee.autorise) {
          await reply(`${I.lock} ${cibleeAutorisee.raison}`);
          return;
        }
        await interaction.reply({
          content: labels[action] ?? 'Sélectionnez un membre.',
          components: [userPicker(`tempvoice:${action}_select`, 'Choisissez un membre')],
          ...ephemeral,
        });
        return;
      }

      case 'reserve': {
        const reservationAutorisee = peutAgir(ctx.ctxp.role, 'reserver', ctx.ctxp.reglages);
        if (!reservationAutorisee.autorise) {
          await reply(`${I.lock} ${reservationAutorisee.raison}`);
          return;
        }
        // La reservation en cours est preselectionnee : on voit ce qui est pose,
        // et la retirer devient un clic dans le menu plutot qu'un acte de foi.
        // `setMinValues(0)` est ce qui autorise a tout decocher.
        const reservationPosee = await prisma.tempVoiceChannel
          .findUnique({ where: { id: channel.id } })
          .then((ligne) => ligne?.roleId ?? null)
          .catch(() => null);

        // Les roles que l'administration a prevus, et qui existent encore. Un
        // role supprime depuis le reglage ne doit pas occuper une option morte.
        const rolesPrevus = ctx.ctxp.reservation.rolesReservables
          .map((id) => guild.roles.cache.get(id))
          .filter((role): role is NonNullable<typeof role> => Boolean(role))
          .slice(0, MAX_OPTIONS_MENU);

        const invite = reservationPosee
          ? 'Décochez pour lever la réservation, ou choisissez un autre rôle'
          : 'Sélectionnez un rôle pour réserver le salon';

        // Liste imposee des que l'administration en a defini une qui tient
        // debout. Si tous les roles prevus ont disparu, mieux vaut le menu libre
        // qu'un menu vide, que Discord refuserait en bloc.
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
          content: reservationPosee
            ? `🛡️ **Réserver le salon pour un rôle** :\nLe salon est réservé à <@&${reservationPosee}>. Décochez-le pour lever la réservation, ou choisissez un autre rôle.`
            : '🛡️ **Réserver le salon pour un rôle** :\nSélectionnez le rôle qui sera autorisé à rejoindre votre salon vocal. Ne sélectionnez rien pour réinitialiser.',
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

    const reservationAutorisee = peutAgir(ctx.ctxp.role, 'reserver', ctx.ctxp.reglages);
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
      await reply('❌ Ce rôle ne peut pas être utilisé pour réserver le salon.');
      return;
    }
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
      await reply("❌ La catégorie du salon refuse l'accès à ce rôle : réservation impossible.");
      return;
    }

    // Sans ce retrait, le salon porte au bout de quelques changements la liste
    // de tous les rôles réservés depuis sa création. Le retrait peut échouer, et
    // le membre doit l'apprendre plutôt que de lire une exclusivité fausse.
    let previousCleared = true;
    if (stored?.roleId && stored.roleId !== selectedRoleId) {
      previousCleared = await channel.permissionOverwrites
        .delete(stored.roleId, 'Réservation précédente levée')
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
        ? `${I.shield} Le salon est réservé au rôle <@&${selectedRoleId}>. Seuls ses membres, les membres que vous avez ajoutés et vous pouvez le rejoindre.`
        : `${I.shield} Le salon est réservé au rôle <@&${selectedRoleId}>, mais la réservation précédente n'a pas pu être entièrement levée : signalez-le au staff.`);
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
      ? `${I.unlock} Réservation annulée : le salon retrouve l'accès prévu par sa catégorie.`
      : `${I.unlock} Réservation annulée, mais la surcharge du rôle précédent n'a pas pu être retirée : il garde l'accès.`);
    planifierRafraichissementPanneau(channel);
    return;
  }

  if (interaction.isUserSelectMenu()) {
    await deferIfNeeded(interaction);

    const targetId = interaction.values[0];
    if (!targetId) {
      await reply('❌ Aucun membre sélectionné.');
      return;
    }

    const target = await guild.members.fetch(targetId).catch(() => null);
    if (!target) {
      await reply('❌ Membre introuvable sur le serveur.');
      return;
    }

    // Le bot doit garder l'accès au salon : banni, il ne pourrait plus le
    // supprimer quand il se vide, et le salon resterait ouvert indéfiniment.
    if (target.user.bot) {
      await reply('❌ Un bot ne peut pas être ciblé par cette action.');
      return;
    }

    // Le propriétaire est protégé de ses propres invités, pas du staff : le
    // salon renommé en insulte est précisément le cas où la modération doit
    // pouvoir agir sur lui.
    const actingAsStaff = await isStaff(guildId, ctx.actingMember);
    if (target.id === cache.creatorId && !actingAsStaff) {
      await reply('❌ Le propriétaire du salon ne peut pas être ciblé.');
      return;
    }

    switch (action) {
      case 'transfer_select': {
        const transfertAutorise = peutAgir(ctx.ctxp.role, 'transferer', ctx.ctxp.reglages);
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
          await reply("❌ La catégorie du salon est introuvable : impossible de vérifier l'accès.");
          return;
        }

        const patch = categoryTrustPatch(channel, target);
        if (!patch) {
          await reply(`❌ La catégorie du salon refuse l'accès à **${target.displayName}**.`);
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
          ? `${ICONES_ABSENTES.ajouter} **${target.displayName}** a été autorisé à rejoindre le salon.`
          : `${I.warn} **${target.displayName}** n'a reçu qu'un accès partiel : la catégorie lui refuse le reste.`);
        planifierRafraichissementPanneau(channel);
        return;
      }

      case 'kick_select': {
        const verdictExpulsion = peutAgirSurCible(
          ctx.ctxp.role,
          'expulser',
          ctx.ctxp.reglages,
          await decrireCible(ctx, target),
        );
        if (!verdictExpulsion.autorise) {
          await reply(`${I.warn} ${verdictExpulsion.raison}`);
          return;
        }
        const oublierExpulsion = annoncerIntentionVocale(guildId, target.id, 'disconnect', {
          libelle: `${user.tag} (panneau du salon vocal temporaire)`,
        });
        await target.voice.disconnect('Expulsé du salon vocal temporaire par le propriétaire.').catch((error: unknown) => {
          oublierExpulsion();
          throw error;
        });
        await reply(`${I.kick} **${target.displayName}** a été expulsé du salon vocal.`);
        planifierRafraichissementPanneau(channel);
        return;
      }

      case 'ban_select': {
        const verdictBannissement = peutAgirSurCible(
          ctx.ctxp.role,
          'bannir',
          ctx.ctxp.reglages,
          await decrireCible(ctx, target),
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
          await target.voice.disconnect('Banni du salon vocal temporaire par le propriétaire.').catch(() => oublierBannissement());
        }
        originesSurcharge.oublier(guildId, channel.id, target.id);
        await reply(`${I.ban} **${target.displayName}** a été banni du salon, chat textuel compris.`);
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
        await reply(`❌ Nombre invalide (doit être entre 0 et ${MAX_USER_LIMIT}).`);
        return;
      }
      await channel.setUserLimit(limit);
      await reply(limit === 0 ? `${I.profile} Limite de places retirée.` : `${I.profile} Limite fixée à ${limit} membres.`);
      planifierRafraichissementPanneau(channel);
      return;
    }

    if (action === 'rename_modal') {
      if (!value) {
        await reply('❌ Le nom ne peut pas être vide.');
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
        await reply('❌ Discord a refusé ce nom.');
        return;
      }

      planifierRafraichissementPanneau(channel);
      await reply(
        renamed.status === 'done'
          ? `${ICONES_ABSENTES.renommer} Salon renommé en : **${newName}**`
          : "⏳ Discord n'a pas confirmé le renommage : un salon ne peut changer de nom que deux fois par tranche de dix minutes. Le nouveau nom s'appliquera peut-être d'ici quelques minutes.",
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
  if (!target) return;

  // La garde de « Récupérer » a été évaluée avant la mise en file : deux
  // réclamations simultanées la passent toutes les deux. Elle est revue ici.
  if (kind === 'claim' && channel.members.has(cache.creatorId)) {
    await respond(interaction, '❌ Le propriétaire actuel du salon vocal est toujours présent.');
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
    ? `👑 **${target.displayName}** a récupéré la propriété du salon vocal !`
    : `👑 La propriété du salon a été transférée à **${target.displayName}**.`;

  await respond(interaction, message);

  // « Récupérer » est ouvert à tous : la réponse reste privée pour qu'un refus
  // ne s'affiche pas devant le salon, la reprise est annoncée dans le salon.
  if (kind === 'claim') {
    await channel.send({ content: message }).catch(() => null);
  }
}
