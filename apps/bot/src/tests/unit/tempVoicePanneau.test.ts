import { describe, expect, test } from 'bun:test';
import { PermissionFlagsBits } from 'discord.js';
import {
  normaliserHistoriqueRenommage,
  normaliserEtatDemandes,
  MAX_ROLES_RESERVABLES,
  planDebordement,
  membresSansLeRole,
  normaliserConfigReservation,
  type ConfigReservation,
  ACTIONS_PANNEAU,
  boutonDemanderAccesVisible,
  CANAUX_NOTIFICATION,
  CHANNEL_PATCHES,
  cleMembreSalon,
  CONFIG_DEMANDES_PAR_DEFAUT,
  decisionEntreeVocal,
  decisionRetraitAutorisation,
  decisionSortieVocal,
  enregistrerRenommage,
  estModeEcriture,
  EXPIRATION_DEMANDE_MS,
  FENETRE_RENOMMAGE_MS,
  historiqueRenommageElague,
  libelleActionMembre,
  libelleRenommer,
  LIBELLES_MODES_ECRITURE,
  MODES_ECRITURE,
  modeEcritureDepuisTextChat,
  nettoyagePresenceAuDemarrage,
  normaliserConfigDemandes,
  normaliserModeEcriture,
  normaliserReglagesAdmin,
  ordreNotification,
  peutAgir,
  peutAgirSurCible,
  peutRepondreDemande,
  quotaRenommage,
  raisonAdminsSeulement,
  reglagesAdminParDefaut,
  reglagesVerrouilles,
  RegistreDemandesAcces,
  RegistreOriginesSurcharge,
  RENOMMAGES_PAR_FENETRE,
  REPONDEURS_DEMANDE,
  ROLES_AGISSANTS,
  SILENCE_APRES_REFUS_MS,
  surchargesModeEcriture,
  textChatDepuisModeEcriture,
  transitionModeEcriture,
  type CibleMembre,
  type ModeEcriture,
  type OrigineSurcharge,
  type ReglagesAdmin,
  type SurchargeMembreLue,
} from '../../services/features/tempVoiceService.js';

/**
 * Refonte du panneau vocal — partie pure. Aucune de ces fonctions ne parle à
 * Discord ni ne lit l'horloge : l'instant est toujours un paramètre, sans quoi
 * vérifier « dix minutes de silence » demanderait dix minutes.
 *
 * Les cas retenus sont ceux où une erreur ne se voit pas : une autorisation
 * explicite effacée par une sortie de vocal, un quota qui libère le mauvais
 * créneau, un refus sans motif, un silence qui survit au salon.
 */

const GUILD = '100000000000000000';
const SALON = '200000000000000000';
const AUTRE_SALON = '200000000000000001';
const ALICE = '300000000000000000';
const BOB = '300000000000000001';

const MINUTE = 60_000;
const T0 = 1_700_000_000_000;

function cible(partiel: Partial<CibleMembre> = {}): CibleMembre {
  return {
    estStaff: false,
    estProprietaire: false,
    estSoiMeme: false,
    dansLeSalon: true,
    autorise: false,
    ...partiel,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Les quatre modes d'écriture
// ─────────────────────────────────────────────────────────────────────────────

describe('modes d’écriture — CHANNEL_PATCHES', () => {
  test('nommer les deux modes existants ne change pas un bit', () => {
    // `everyone` et `ownerOnly` sont l'ancien `openChat` et l'ancien `closeChat` :
    // si la refonte les avait redéfinis, des salons en place changeraient d'état
    // sans que personne n'ait cliqué.
    expect(CHANNEL_PATCHES.everyone).toEqual(CHANNEL_PATCHES.openChat);
    expect(CHANNEL_PATCHES.ownerOnly).toEqual(CHANNEL_PATCHES.closeChat);
  });

  test('les quatre modes existent et aucun n’autorise explicitement @everyone', () => {
    for (const mode of MODES_ECRITURE) {
      const patch = CHANNEL_PATCHES[mode] as Record<string, boolean | null>;
      expect(patch).toBeDefined();
      // Rien de ce qui rouvre un salon n'accorde : on rend le droit à la catégorie.
      expect(patch.SendMessages).not.toBe(true);
    }
  });

  test('chaque mode porte le libellé de la maquette', () => {
    expect(LIBELLES_MODES_ECRITURE.everyone.libelle).toBe('Tout le monde');
    expect(LIBELLES_MODES_ECRITURE.inVoice.libelle).toBe('Ceux qui sont en vocal');
    expect(LIBELLES_MODES_ECRITURE.ownerOnly.libelle).toBe('Moi seul');
    expect(LIBELLES_MODES_ECRITURE.nobody.libelle).toBe('Personne');
    // L'ordre du menu est celui de la maquette, pas l'ordre alphabétique.
    expect([...MODES_ECRITURE]).toEqual(['everyone', 'inVoice', 'ownerOnly', 'nobody']);
  });
});

describe('surchargesModeEcriture', () => {
  test('« Tout le monde » rend le droit à la catégorie des deux côtés', () => {
    const surcharges = surchargesModeEcriture('everyone');
    expect(surcharges.everyone).toEqual({ SendMessages: null });
    expect(surcharges.proprietaire).toEqual({ SendMessages: null });
    expect(surcharges.suitLaPresence).toBe(false);
  });

  test('« Tout le monde » n’écrase pas un refus nommé de la catégorie', () => {
    // Sinon le bouton d'un propriétaire rouvrirait un salon que la catégorie ferme.
    const surcharges = surchargesModeEcriture('everyone', {
      allow: 0n,
      deny: PermissionFlagsBits.SendMessages,
    });
    expect(surcharges.everyone).toEqual({ SendMessages: false });
  });

  test('« Moi seul » coupe @everyone et rend l’écriture au propriétaire', () => {
    const surcharges = surchargesModeEcriture('ownerOnly');
    expect(surcharges.everyone).toEqual({ SendMessages: false });
    // Sans cette autorisation nommée, fermer le chat rendrait le propriétaire
    // muet chez lui — la règle que `ownerChatPatch` porte déjà.
    expect(surcharges.proprietaire).toEqual({ SendMessages: true });
  });

  test('« Moi seul » cède devant un refus nommé de la catégorie sur le propriétaire', () => {
    const surcharges = surchargesModeEcriture('ownerOnly', null, {
      allow: 0n,
      deny: PermissionFlagsBits.SendMessages,
    });
    expect(surcharges.proprietaire).toEqual({ SendMessages: false });
  });

  test('« Personne » coupe aussi le propriétaire — c’est tout ce qui le sépare de « Moi seul »', () => {
    const nobody = surchargesModeEcriture('nobody');
    const ownerOnly = surchargesModeEcriture('ownerOnly');

    expect(nobody.everyone).toEqual(ownerOnly.everyone);
    expect(nobody.proprietaire).toEqual({ SendMessages: false });
    expect(nobody.proprietaire).not.toEqual(ownerOnly.proprietaire);
  });

  test('« Ceux qui sont en vocal » ne donne aucun allow nommé au propriétaire', () => {
    const surcharges = surchargesModeEcriture('inVoice');
    expect(surcharges.everyone).toEqual({ SendMessages: false });
    // Un `allow` nommé sur le propriétaire ferait de `inVoice` un `ownerOnly`
    // déguisé : il écrirait même hors du vocal.
    expect(surcharges.proprietaire).toEqual({ SendMessages: null });
    expect(surcharges.suitLaPresence).toBe(true);
  });

  test('un seul mode suit la présence', () => {
    const suiveurs = MODES_ECRITURE.filter((mode) => surchargesModeEcriture(mode).suitLaPresence);
    expect(suiveurs).toEqual(['inVoice']);
  });
});

describe('normalisation et pont vers l’ancien réglage', () => {
  test('une valeur inconnue retombe sur le comportement historique', () => {
    expect(normaliserModeEcriture('nawak')).toBe('everyone');
    expect(normaliserModeEcriture(undefined)).toBe('everyone');
    expect(normaliserModeEcriture('nobody')).toBe('nobody');
    expect(estModeEcriture('inVoice')).toBe(true);
    expect(estModeEcriture('locked')).toBe(false);
  });

  test('le repli vers trois valeurs ne rouvre jamais un salon fermé', () => {
    // `inVoice` et `nobody` refusent @everyone : ils se rangent sous `locked`.
    // Les ranger sous `open` ouvrirait le chat d'une base pas encore migrée.
    expect(textChatDepuisModeEcriture('everyone')).toBe('open');
    expect(textChatDepuisModeEcriture('inVoice')).toBe('locked');
    expect(textChatDepuisModeEcriture('ownerOnly')).toBe('locked');
    expect(textChatDepuisModeEcriture('nobody')).toBe('locked');

    expect(modeEcritureDepuisTextChat('open')).toBe('everyone');
    expect(modeEcritureDepuisTextChat('locked')).toBe('ownerOnly');
    expect(modeEcritureDepuisTextChat('inherit')).toBe('everyone');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Le quota de renommage
// ─────────────────────────────────────────────────────────────────────────────

describe('quotaRenommage', () => {
  test('un salon jamais renommé a ses deux jetons', () => {
    expect(quotaRenommage([], T0)).toEqual({ restants: 2, libereA: null });
    expect(RENOMMAGES_PAR_FENETRE).toBe(2);
  });

  test('le deuxième renommage épuise le quota et annonce la libération', () => {
    const historique = [T0 - 4 * MINUTE, T0 - MINUTE];
    expect(quotaRenommage(historique, T0)).toEqual({
      restants: 0,
      libereA: T0 - 4 * MINUTE + FENETRE_RENOMMAGE_MS,
    });
  });

  test('un renommage vieux de dix minutes pile est sorti de la fenêtre', () => {
    // La borne compte : à une milliseconde près, le bouton reste grisé pour rien.
    expect(quotaRenommage([T0 - FENETRE_RENOMMAGE_MS, T0 - MINUTE], T0).restants).toBe(1);
    expect(quotaRenommage([T0 - FENETRE_RENOMMAGE_MS + 1, T0 - MINUTE], T0).restants).toBe(0);
  });

  test('avec plus d’entrées que le quota, c’est l’avant-dernière qui libère', () => {
    // Prendre la plus ancienne annoncerait une libération trop tôt : à cet
    // instant-là il resterait encore deux renommages dans la fenêtre.
    const historique = [T0 - 9 * MINUTE, T0 - 6 * MINUTE, T0 - MINUTE];
    const quota = quotaRenommage(historique, T0);
    expect(quota.restants).toBe(0);
    expect(quota.libereA).toBe(T0 - 6 * MINUTE + FENETRE_RENOMMAGE_MS);
    // Contrôle : à cet instant, un jeton est bien revenu.
    expect(quotaRenommage(historique, quota.libereA as number).restants).toBe(1);
  });

  test('un historique non trié ou pollué ne fausse pas le calcul', () => {
    const quota = quotaRenommage([T0 - MINUTE, Number.NaN, T0 - 4 * MINUTE], T0);
    expect(quota).toEqual({ restants: 0, libereA: T0 - 4 * MINUTE + FENETRE_RENOMMAGE_MS });
  });

  test('l’historique s’élague au lieu de grossir sans fin', () => {
    const vieux = [T0 - 30 * MINUTE, T0 - 20 * MINUTE, T0 - MINUTE];
    expect(historiqueRenommageElague(vieux, T0)).toEqual([T0 - MINUTE]);
    expect(enregistrerRenommage(vieux, T0)).toEqual([T0 - MINUTE, T0]);
  });
});

describe('libelleRenommer', () => {
  test('affiche le quota restant, puis le décompte, comme la maquette', () => {
    expect(libelleRenommer(quotaRenommage([], T0), T0)).toBe('✏️ Renommer (2/2)');

    const epuise = quotaRenommage([T0 - 4 * MINUTE, T0 - MINUTE], T0);
    expect(libelleRenommer(epuise, T0)).toBe('✏️ Renommer (0/2 · 6 min)');
  });

  test('un reste de quelques secondes n’annonce jamais « 0 min »', () => {
    // Un bouton grisé qui affiche zéro minute passe pour un blocage.
    expect(libelleRenommer({ restants: 0, libereA: T0 + 1 }, T0)).toBe('✏️ Renommer (0/2 · 1 min)');
    expect(libelleRenommer({ restants: 0, libereA: T0 + 5 * MINUTE + 30_000 }, T0)).toBe(
      '✏️ Renommer (0/2 · 6 min)',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Le registre des demandes d'accès
// ─────────────────────────────────────────────────────────────────────────────

describe('RegistreDemandesAcces', () => {
  test('la clé identifie la personne dans ce salon de ce serveur', () => {
    expect(cleMembreSalon(GUILD, SALON, ALICE)).toBe(`${GUILD}:${SALON}:${ALICE}`);
  });

  test('une première demande s’enregistre et porte son échéance', () => {
    const registre = new RegistreDemandesAcces();
    const resultat = registre.demander(GUILD, SALON, ALICE, T0);

    expect(resultat.statut).toBe('enregistree');
    if (resultat.statut !== 'enregistree') throw new Error('statut inattendu');
    expect(resultat.demande.expireA).toBe(T0 + EXPIRATION_DEMANDE_MS);
  });

  test('un second clic ne renvoie rien : la demande est déjà en attente', () => {
    const registre = new RegistreDemandesAcces();
    registre.demander(GUILD, SALON, ALICE, T0);
    const second = registre.demander(GUILD, SALON, ALICE, T0 + MINUTE);

    expect(second.statut).toBe('dejaEnAttente');
    if (second.statut !== 'dejaEnAttente') throw new Error('statut inattendu');
    expect(second.resteMs).toBe(EXPIRATION_DEMANDE_MS - MINUTE);
    // Une seule demande, pas deux pings pour le propriétaire.
    expect(registre.taille.demandes).toBe(1);
  });

  test('une demande expirée laisse repartir de zéro', () => {
    const registre = new RegistreDemandesAcces();
    registre.demander(GUILD, SALON, ALICE, T0);

    expect(registre.demandeEnAttente(GUILD, SALON, ALICE, T0 + EXPIRATION_DEMANDE_MS)).toBeNull();
    const reprise = registre.demander(GUILD, SALON, ALICE, T0 + EXPIRATION_DEMANDE_MS);
    expect(reprise.statut).toBe('enregistree');
  });

  test('un refus vaut dix minutes de silence, avec le temps restant', () => {
    const registre = new RegistreDemandesAcces();
    registre.demander(GUILD, SALON, ALICE, T0);
    const decision = registre.resoudre(GUILD, SALON, ALICE, 'refusee', T0 + MINUTE);

    expect(decision.demande?.userId).toBe(ALICE);
    expect(decision.silenceJusquA).toBe(T0 + MINUTE + SILENCE_APRES_REFUS_MS);

    const redemande = registre.demander(GUILD, SALON, ALICE, T0 + 5 * MINUTE);
    expect(redemande.statut).toBe('silence');
    if (redemande.statut !== 'silence') throw new Error('statut inattendu');
    expect(redemande.resteMs).toBe(SILENCE_APRES_REFUS_MS - 4 * MINUTE);
  });

  test('le silence s’éteint à l’échéance, pas après', () => {
    const registre = new RegistreDemandesAcces();
    registre.resoudre(GUILD, SALON, ALICE, 'refusee', T0);

    expect(registre.estEnSilence(GUILD, SALON, ALICE, T0 + SILENCE_APRES_REFUS_MS - 1)).toBe(true);
    expect(registre.estEnSilence(GUILD, SALON, ALICE, T0 + SILENCE_APRES_REFUS_MS)).toBe(false);
    expect(registre.demander(GUILD, SALON, ALICE, T0 + SILENCE_APRES_REFUS_MS).statut).toBe(
      'enregistree',
    );
  });

  test('une acceptation efface un silence antérieur', () => {
    const registre = new RegistreDemandesAcces();
    registre.resoudre(GUILD, SALON, ALICE, 'refusee', T0);
    registre.resoudre(GUILD, SALON, ALICE, 'acceptee', T0 + MINUTE);

    expect(registre.estEnSilence(GUILD, SALON, ALICE, T0 + 2 * MINUTE)).toBe(false);
  });

  test('deux salons ne se partagent ni demande ni silence', () => {
    const registre = new RegistreDemandesAcces();
    registre.demander(GUILD, SALON, ALICE, T0);
    registre.resoudre(GUILD, SALON, ALICE, 'refusee', T0);

    // Refusée ici ne veut pas dire refusée partout.
    expect(registre.demander(GUILD, AUTRE_SALON, ALICE, T0).statut).toBe('enregistree');
  });

  test('tout disparaît à la mort du salon — demandes et silences', () => {
    const registre = new RegistreDemandesAcces();
    registre.demander(GUILD, SALON, ALICE, T0);
    registre.resoudre(GUILD, SALON, BOB, 'refusee', T0);
    registre.demander(GUILD, AUTRE_SALON, ALICE, T0);

    expect(registre.oublierSalon(GUILD, SALON)).toBe(2);
    expect(registre.taille).toEqual({ demandes: 1, silences: 0 });
    // Un silence orphelin ferait taire quelqu'un dans un salon qui n'existe plus.
    expect(registre.estEnSilence(GUILD, SALON, BOB, T0 + MINUTE)).toBe(false);
    expect(registre.demandeEnAttente(GUILD, AUTRE_SALON, ALICE, T0 + MINUTE)).not.toBeNull();
  });

  test('la purge périodique nettoie sans toucher au vivant', () => {
    const registre = new RegistreDemandesAcces();
    registre.demander(GUILD, SALON, ALICE, T0);
    registre.resoudre(GUILD, SALON, BOB, 'refusee', T0);
    registre.demander(GUILD, AUTRE_SALON, ALICE, T0 + 9 * MINUTE);

    expect(registre.purger(T0 + EXPIRATION_DEMANDE_MS)).toBe(2);
    expect(registre.taille).toEqual({ demandes: 1, silences: 0 });
  });

  test('les demandes d’un salon sortent dans l’ordre d’arrivée', () => {
    const registre = new RegistreDemandesAcces();
    registre.demander(GUILD, SALON, BOB, T0 + MINUTE);
    registre.demander(GUILD, SALON, ALICE, T0);
    registre.demander(GUILD, AUTRE_SALON, ALICE, T0);

    const demandes = registre.demandesDuSalon(GUILD, SALON, T0 + 2 * MINUTE);
    expect(demandes.map((d) => d.userId)).toEqual([ALICE, BOB]);
  });

  test('les durées sont réglables, comme dans l’onglet du dashboard', () => {
    const registre = new RegistreDemandesAcces({ expirationMs: 2 * MINUTE, silenceMs: 30_000 });
    const resultat = registre.demander(GUILD, SALON, ALICE, T0);
    if (resultat.statut !== 'enregistree') throw new Error('statut inattendu');

    expect(resultat.demande.expireA).toBe(T0 + 2 * MINUTE);
    registre.resoudre(GUILD, SALON, ALICE, 'refusee', T0);
    expect(registre.estEnSilence(GUILD, SALON, ALICE, T0 + 29_000)).toBe(true);
    expect(registre.estEnSilence(GUILD, SALON, ALICE, T0 + 30_000)).toBe(false);
  });

  test('le bouton n’apparaît que lorsqu’il sert, et seulement si un admin l’a activé', () => {
    const active = { activees: true };
    expect(boutonDemanderAccesVisible({ verrouille: true, reserve: false }, active)).toBe(true);
    expect(boutonDemanderAccesVisible({ verrouille: false, reserve: true }, active)).toBe(true);
    // Un salon plein, c'est une place qui manque, pas une permission.
    expect(boutonDemanderAccesVisible({ verrouille: false, reserve: false }, active)).toBe(false);
  });

  test('sans activation, même un salon verrouillé ou réservé ne montre rien', () => {
    const inactive = { activees: false };
    expect(boutonDemanderAccesVisible({ verrouille: true, reserve: false }, inactive)).toBe(false);
    expect(boutonDemanderAccesVisible({ verrouille: false, reserve: true }, inactive)).toBe(false);
    expect(boutonDemanderAccesVisible({ verrouille: true, reserve: true }, inactive)).toBe(false);
  });

  test('un délai par appel prime sur celui du registre, sans contaminer un autre serveur', () => {
    const registre = new RegistreDemandesAcces({ expirationMs: 10 * MINUTE, silenceMs: 10 * MINUTE });

    const court = registre.demander(GUILD, SALON, ALICE, T0, { expirationMs: 60_000 });
    if (court.statut !== 'enregistree') throw new Error('statut inattendu');
    expect(court.demande.expireA).toBe(T0 + 60_000);

    // Un autre serveur, sans délai particulier, garde celui du registre.
    const long = registre.demander(GUILD, AUTRE_SALON, BOB, T0);
    if (long.statut !== 'enregistree') throw new Error('statut inattendu');
    expect(long.demande.expireA).toBe(T0 + 10 * MINUTE);

    // À 61 s, la première a expiré ; la seconde, réglée sur dix minutes, tient encore.
    expect(registre.demandeEnAttente(GUILD, SALON, ALICE, T0 + 61_000)).toBeNull();
    expect(registre.demandeEnAttente(GUILD, AUTRE_SALON, BOB, T0 + 61_000)).not.toBeNull();
  });

  test('un silence posé par appel dure ce qu’on lui demande, pas la durée du registre', () => {
    const registre = new RegistreDemandesAcces({ silenceMs: 10 * MINUTE });
    registre.demander(GUILD, SALON, ALICE, T0);

    const decision = registre.resoudre(GUILD, SALON, ALICE, 'refusee', T0, { silenceMs: 30 * MINUTE });
    expect(decision.silenceJusquA).toBe(T0 + 30 * MINUTE);
    expect(registre.estEnSilence(GUILD, SALON, ALICE, T0 + 30 * MINUTE - 1)).toBe(true);
    expect(registre.estEnSilence(GUILD, SALON, ALICE, T0 + 30 * MINUTE)).toBe(false);
  });

  test('sans argument de délai, le comportement d’avant est inchangé', () => {
    const registre = new RegistreDemandesAcces();
    const resultat = registre.demander(GUILD, SALON, ALICE, T0);
    if (resultat.statut !== 'enregistree') throw new Error('statut inattendu');
    expect(resultat.demande.expireA).toBe(T0 + EXPIRATION_DEMANDE_MS);

    const decision = registre.resoudre(GUILD, SALON, ALICE, 'refusee', T0);
    expect(decision.silenceJusquA).toBe(T0 + SILENCE_APRES_REFUS_MS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. La matrice de permissions
// ─────────────────────────────────────────────────────────────────────────────

const TOUT_AUTORISE: ReglagesAdmin = reglagesAdminParDefaut();

describe('normaliserReglagesAdmin', () => {
  test('sans réglage, un modérateur garde ce qu’il a aujourd’hui', () => {
    // La refonte pose des limites là où il n'y en a aucune : elle n'en retire
    // aucune tant qu'un admin ne l'a pas demandé.
    const reglages = normaliserReglagesAdmin(null);
    expect(Object.values(reglages).every((valeur) => valeur === 'autorise')).toBe(true);
    expect(normaliserReglagesAdmin('nawak')).toEqual(reglages);
    expect(normaliserReglagesAdmin([])).toEqual(reglages);
  });

  test('les booléens et les libellés sont acceptés, l’inconnu est ignoré', () => {
    const reglages = normaliserReglagesAdmin({
      modeEcriture: 'adminsSeulement',
      transferer: false,
      renommer: true,
      limite: 'nawak',
      inexistant: false,
    });

    expect(reglages.modeEcriture).toBe('adminsSeulement');
    expect(reglages.transferer).toBe('adminsSeulement');
    expect(reglages.renommer).toBe('autorise');
    expect(reglages.limite).toBe('autorise');
    expect('inexistant' in reglages).toBe(false);
  });

  test('reglagesVerrouilles liste ce qui est fermé, dans l’ordre canonique', () => {
    expect(reglagesVerrouilles({ reserver: false, modeEcriture: false })).toEqual([
      'modeEcriture',
      'reserver',
    ]);
    expect(reglagesVerrouilles(TOUT_AUTORISE)).toEqual([]);
  });
});

describe('raisonAdminsSeulement', () => {
  test('reprend la phrase de la maquette, au singulier comme au pluriel', () => {
    expect(raisonAdminsSeulement(['modeEcriture', 'reserver'])).toBe(
      "Le mode d'écriture et la réservation sont réservés aux admins sur ce serveur.",
    );
    expect(raisonAdminsSeulement(['modeEcriture'])).toBe(
      "Le mode d'écriture est réservé aux admins sur ce serveur.",
    );
    // Accord au féminin : « est réservée », pas « est réservé ».
    expect(raisonAdminsSeulement(['reserver'])).toBe(
      'La réservation est réservée aux admins sur ce serveur.',
    );
    // Une ligne qui couvre deux actions reste au pluriel, même seule.
    expect(raisonAdminsSeulement(['expulserBannir'])).toBe(
      "L'expulsion et le bannissement sont réservés aux admins sur ce serveur.",
    );
  });

  test('l’ordre des arguments ne change pas la phrase', () => {
    expect(raisonAdminsSeulement(['reserver', 'modeEcriture'])).toBe(
      raisonAdminsSeulement(['modeEcriture', 'reserver']),
    );
  });

  test('rien à dire ne produit pas une phrase vide à moitié écrite', () => {
    expect(raisonAdminsSeulement([])).toBe('');
  });
});

describe('peutAgir', () => {
  test('le propriétaire fait tout chez lui, sauf ce qui n’a pas de sens', () => {
    expect(peutAgir('proprietaire', 'modeEcriture', { modeEcriture: false }).autorise).toBe(true);
    expect(peutAgir('proprietaire', 'reserver', { reserver: false }).autorise).toBe(true);

    // Jamais un bouton mort : ces deux-là sont refusés avec leur motif.
    const recuperer = peutAgir('proprietaire', 'recuperer', TOUT_AUTORISE);
    expect(recuperer).toEqual({
      autorise: false,
      motif: 'dejaProprietaire',
      raison: 'Tu es déjà propriétaire de ce salon.',
    });
    expect(peutAgir('proprietaire', 'demanderAcces', TOUT_AUTORISE).autorise).toBe(false);
  });

  test('un admin n’est jamais arrêté par les réglages des modérateurs', () => {
    for (const action of ACTIONS_PANNEAU) {
      const verdict = peutAgir('admin', action, {
        modeEcriture: false,
        reserver: false,
        transferer: false,
        expulserBannir: false,
        renommer: false,
        limite: false,
        verrouiller: false,
      });
      expect(verdict.autorise).toBe(true);
    }
  });

  test('un modérateur garde tout tant qu’un admin n’a rien fermé', () => {
    for (const action of ACTIONS_PANNEAU) {
      expect(peutAgir('moderateur', action, TOUT_AUTORISE).autorise).toBe(true);
    }
  });

  test('un réglage fermé refuse le modérateur en disant pourquoi', () => {
    const verdict = peutAgir('moderateur', 'modeEcriture', { modeEcriture: 'adminsSeulement' });
    expect(verdict).toEqual({
      autorise: false,
      motif: 'adminsSeulement',
      raison: "Le mode d'écriture est réservé aux admins sur ce serveur.",
    });
    // Un refus sans motif redonnerait le panneau d'aujourd'hui : on découvre
    // l'interdiction après le clic.
    if (verdict.autorise) throw new Error('verdict inattendu');
    expect(verdict.raison.length).toBeGreaterThan(0);
  });

  test('la ligne « Expulser / bannir » gouverne bien les deux actions', () => {
    const reglages = { expulserBannir: 'adminsSeulement' };
    expect(peutAgir('moderateur', 'expulser', reglages).autorise).toBe(false);
    expect(peutAgir('moderateur', 'bannir', reglages).autorise).toBe(false);
    // ... et rien d'autre.
    expect(peutAgir('moderateur', 'renommer', reglages).autorise).toBe(true);
  });

  test('fermer une ligne n’en ferme aucune autre', () => {
    const verrouille = peutAgir('moderateur', 'transferer', { transferer: false });
    expect(verrouille.autorise).toBe(false);
    expect(peutAgir('moderateur', 'recuperer', { transferer: false }).autorise).toBe(true);
  });
});

describe('peutAgirSurCible', () => {
  test('le staff ne peut être ni expulsé ni banni, et la raison le nomme', () => {
    const bob = cible({ nom: 'Bob', estStaff: true });
    const verdict = peutAgirSurCible('proprietaire', 'expulser', TOUT_AUTORISE, bob);

    expect(verdict).toEqual({
      autorise: false,
      motif: 'cibleStaff',
      raison: 'Bob fait partie du staff : il ne peut être ni expulsé ni banni.',
    });
    expect(peutAgirSurCible('proprietaire', 'bannir', TOUT_AUTORISE, bob).autorise).toBe(false);
    // Le staff reste transférable : on peut lui donner le salon.
    expect(peutAgirSurCible('proprietaire', 'transferer', TOUT_AUTORISE, bob).autorise).toBe(true);
  });

  test('sans nom, la raison reste lisible', () => {
    const verdict = peutAgirSurCible('proprietaire', 'expulser', TOUT_AUTORISE, cible({ estStaff: true }));
    if (verdict.autorise) throw new Error('verdict inattendu');
    expect(verdict.raison).toBe(
      'Cette personne fait partie du staff : elle ne peut être ni expulsée ni bannie.',
    );
  });

  test('on bannit quelqu’un d’absent, on ne l’expulse pas', () => {
    const absent = cible({ nom: 'Alice', dansLeSalon: false });
    const expulser = peutAgirSurCible('proprietaire', 'expulser', TOUT_AUTORISE, absent);

    expect(expulser).toEqual({
      autorise: false,
      motif: 'cibleHorsSalon',
      raison: "Alice n'est pas dans le salon.",
    });
    // Bannir un absent a du sens : il ne verra plus le salon.
    expect(peutAgirSurCible('proprietaire', 'bannir', TOUT_AUTORISE, absent).autorise).toBe(true);
  });

  test('on ne se transfère pas le salon à soi-même, ni à son propriétaire', () => {
    expect(
      peutAgirSurCible('proprietaire', 'transferer', TOUT_AUTORISE, cible({ estSoiMeme: true })),
    ).toMatchObject({ autorise: false, motif: 'cibleSoiMeme' });

    expect(
      peutAgirSurCible('moderateur', 'transferer', TOUT_AUTORISE, cible({ nom: 'Toji', estProprietaire: true })),
    ).toEqual({
      autorise: false,
      motif: 'cibleDejaProprietaire',
      raison: 'Toji est déjà propriétaire du salon.',
    });
  });

  test('on ne s’expulse pas soi-même', () => {
    expect(
      peutAgirSurCible('proprietaire', 'expulser', TOUT_AUTORISE, cible({ estSoiMeme: true })),
    ).toMatchObject({ autorise: false, motif: 'cibleSoiMeme' });
  });

  test('le refus de rôle passe avant celui de la cible', () => {
    // Autrement un modérateur privé d'expulsion recevrait « cette personne est
    // du staff » et croirait le réglage ouvert.
    const verdict = peutAgirSurCible(
      'moderateur',
      'expulser',
      { expulserBannir: false },
      cible({ estStaff: true }),
    );
    expect(verdict).toMatchObject({ autorise: false, motif: 'adminsSeulement' });
  });

  test('le même bouton dit l’état de la personne', () => {
    expect(libelleActionMembre('autoriser', cible())).toBe('Autoriser');
    expect(libelleActionMembre('autoriser', cible({ autorise: true }))).toBe("Retirer l'accès");
    expect(libelleActionMembre('transferer', cible())).toBe('Lui donner le salon');
    expect(libelleActionMembre('expulser', cible())).toBe('Expulser');
    expect(libelleActionMembre('bannir', cible())).toBe('Bannir');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. L'origine des surcharges
// ─────────────────────────────────────────────────────────────────────────────

describe('origine des surcharges — entrées et sorties', () => {
  test('entrer en vocal pose une surcharge marquée « présence »', () => {
    expect(decisionEntreeVocal('inVoice', null)).toEqual({
      action: 'poser',
      origine: 'presence',
      patch: { SendMessages: true },
    });
  });

  test('entrer ne rétrograde pas une autorisation explicite', () => {
    expect(decisionEntreeVocal('inVoice', 'autorisation')).toEqual({
      action: 'conserver',
      motif: 'autorisationExplicite',
    });
    expect(decisionEntreeVocal('inVoice', 'presence')).toEqual({
      action: 'conserver',
      motif: 'dejaPosee',
    });
  });

  test('hors du mode « en vocal », entrer ne pose rien', () => {
    for (const mode of MODES_ECRITURE.filter((m) => m !== 'inVoice')) {
      expect(decisionEntreeVocal(mode, null)).toEqual({ action: 'aucune' });
    }
  });

  test('sortir retire une présence', () => {
    expect(decisionSortieVocal('inVoice', 'presence')).toEqual({
      action: 'retirer',
      patch: { SendMessages: null },
    });
  });

  test('SORTIR NE TOUCHE JAMAIS À UNE AUTORISATION EXPLICITE', () => {
    // Le point dur de toute la refonte. Sans la distinction d'origine, ce
    // départ effacerait un droit donné à la main par le propriétaire, et
    // personne ne comprendrait pourquoi l'accès a disparu.
    for (const mode of MODES_ECRITURE) {
      expect(decisionSortieVocal(mode, 'autorisation')).toEqual({
        action: 'conserver',
        motif: 'autorisationExplicite',
      });
    }
  });

  test('une présence laissée par un ancien mode se nettoie à la sortie', () => {
    expect(decisionSortieVocal('everyone', 'presence')).toEqual({
      action: 'retirer',
      patch: { SendMessages: null },
    });
    expect(decisionSortieVocal('everyone', null)).toEqual({ action: 'aucune' });
  });

  test('retirer l’accès à quelqu’un encore présent le rétrograde sans le rendre muet', () => {
    // Le retirer ici couperait l'écriture d'une personne pourtant connectée,
    // ce que le mode promet le contraire. Sa surcharge partira avec elle.
    expect(decisionRetraitAutorisation('inVoice', true)).toEqual({
      action: 'poser',
      origine: 'presence',
      patch: { SendMessages: true },
    });
    expect(decisionRetraitAutorisation('inVoice', false)).toEqual({
      action: 'retirer',
      patch: { SendMessages: null },
    });
    expect(decisionRetraitAutorisation('everyone', true)).toEqual({
      action: 'retirer',
      patch: { SendMessages: null },
    });
  });

  test('scénario complet : entrée, autorisation, sortie', () => {
    const registre = new RegistreOriginesSurcharge();

    // 1. Alice entre en vocal.
    const entree = decisionEntreeVocal('inVoice', registre.origine(GUILD, SALON, ALICE));
    expect(entree.action).toBe('poser');
    registre.marquer(GUILD, SALON, ALICE, 'presence');

    // 2. Le propriétaire clique « Autoriser » sur elle.
    registre.marquer(GUILD, SALON, ALICE, 'autorisation');
    expect(registre.origine(GUILD, SALON, ALICE)).toBe('autorisation');

    // 3. Alice quitte le vocal : son autorisation survit.
    const sortie = decisionSortieVocal('inVoice', registre.origine(GUILD, SALON, ALICE));
    expect(sortie).toEqual({ action: 'conserver', motif: 'autorisationExplicite' });
    expect(registre.origine(GUILD, SALON, ALICE)).toBe('autorisation');
  });
});

describe('transitionModeEcriture', () => {
  const sansMarque = new Map<string, OrigineSurcharge>();

  test('entrer dans « en vocal » pose les présents non marqués', () => {
    expect(transitionModeEcriture('everyone', 'inVoice', [ALICE, BOB, ALICE], sansMarque)).toEqual({
      aPoser: [ALICE, BOB],
      aRetirer: [],
    });
  });

  test('entrer dans « en vocal » ne rétrograde pas un autorisé déjà présent', () => {
    const origines = new Map<string, OrigineSurcharge>([[ALICE, 'autorisation']]);
    expect(transitionModeEcriture('ownerOnly', 'inVoice', [ALICE, BOB], origines)).toEqual({
      aPoser: [BOB],
      aRetirer: [],
    });
  });

  test('sortir de « en vocal » ne retire que les présences', () => {
    const origines = new Map<string, OrigineSurcharge>([
      [ALICE, 'presence'],
      [BOB, 'autorisation'],
    ]);
    expect(transitionModeEcriture('inVoice', 'everyone', [ALICE, BOB], origines)).toEqual({
      aPoser: [],
      aRetirer: [ALICE],
    });
  });

  test('un changement qui ne touche pas « en vocal » ne bouge aucune surcharge', () => {
    const origines = new Map<string, OrigineSurcharge>([[ALICE, 'presence']]);
    expect(transitionModeEcriture('everyone', 'nobody', [ALICE], origines)).toEqual({
      aPoser: [],
      aRetirer: [],
    });
    const memeMode: ModeEcriture = 'inVoice';
    expect(transitionModeEcriture(memeMode, memeMode, [ALICE], origines)).toEqual({
      aPoser: [],
      aRetirer: [],
    });
  });
});

describe('RegistreOriginesSurcharge', () => {
  test('« présence » n’écrase jamais « autorisation »', () => {
    const registre = new RegistreOriginesSurcharge();
    registre.marquer(GUILD, SALON, ALICE, 'autorisation');

    expect(registre.marquer(GUILD, SALON, ALICE, 'presence')).toBe('autorisation');
    expect(registre.origine(GUILD, SALON, ALICE)).toBe('autorisation');
  });

  test('« autorisation » promeut une présence', () => {
    const registre = new RegistreOriginesSurcharge();
    registre.marquer(GUILD, SALON, ALICE, 'presence');

    expect(registre.marquer(GUILD, SALON, ALICE, 'autorisation')).toBe('autorisation');
  });

  test('les marques d’un salon ne débordent pas sur un autre', () => {
    const registre = new RegistreOriginesSurcharge();
    registre.marquer(GUILD, SALON, ALICE, 'presence');
    registre.marquer(GUILD, SALON, BOB, 'autorisation');
    registre.marquer(GUILD, AUTRE_SALON, ALICE, 'autorisation');

    expect([...registre.originesDuSalon(GUILD, SALON).entries()].sort()).toEqual([
      [ALICE, 'presence'],
      [BOB, 'autorisation'],
    ]);
    expect(registre.origine(GUILD, AUTRE_SALON, BOB)).toBeNull();
  });

  test('tout disparaît à la mort du salon', () => {
    const registre = new RegistreOriginesSurcharge();
    registre.marquer(GUILD, SALON, ALICE, 'presence');
    registre.marquer(GUILD, SALON, BOB, 'autorisation');
    registre.marquer(GUILD, AUTRE_SALON, ALICE, 'presence');

    expect(registre.oublierSalon(GUILD, SALON)).toBe(2);
    expect(registre.taille).toBe(1);
    expect(registre.origine(GUILD, AUTRE_SALON, ALICE)).toBe('presence');
  });

  test('oublier une personne la démarque', () => {
    const registre = new RegistreOriginesSurcharge();
    registre.marquer(GUILD, SALON, ALICE, 'presence');

    expect(registre.oublier(GUILD, SALON, ALICE)).toBe(true);
    expect(registre.oublier(GUILD, SALON, ALICE)).toBe(false);
    expect(registre.origine(GUILD, SALON, ALICE)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Le contrat des demandes d'accès (bloquant n°5 de la revue PR #509)
// ─────────────────────────────────────────────────────────────────────────────

describe('normaliserConfigDemandes', () => {
  test('une ligne complète et valide est traduite fidèlement, minutes en millisecondes', () => {
    expect(
      normaliserConfigDemandes({
        enabled: true,
        responders: 'OWNER',
        notifyVia: 'CHANNEL',
        notifyChannelId: SALON,
        requestExpiresMinutes: 5,
        denyCooldownMinutes: 15,
      }),
    ).toEqual({
      activees: true,
      repondeurs: 'OWNER',
      canal: 'CHANNEL',
      canalId: SALON,
      expirationMs: 5 * MINUTE,
      silenceMs: 15 * MINUTE,
    });
  });

  test('null, undefined, un nombre ou une chaîne retombent sur les défauts du schéma', () => {
    for (const valeur of [null, undefined, 42, 'nawak']) {
      expect(normaliserConfigDemandes(valeur)).toEqual(CONFIG_DEMANDES_PAR_DEFAUT);
    }
  });

  test('un responders inconnu retombe sur OWNER_AND_STAFF, jamais un défaut plus permissif inventé', () => {
    expect(normaliserConfigDemandes({ responders: 'EVERYONE' }).repondeurs).toBe('OWNER_AND_STAFF');
    expect(normaliserConfigDemandes({ responders: null }).repondeurs).toBe('OWNER_AND_STAFF');
    expect(normaliserConfigDemandes({ responders: 'owner' }).repondeurs).toBe('OWNER_AND_STAFF');
  });

  test('un notifyVia inconnu retombe sur VOICE', () => {
    expect(normaliserConfigDemandes({ notifyVia: 'PIGEON' }).canal).toBe('VOICE');
    expect(normaliserConfigDemandes({ notifyVia: null }).canal).toBe('VOICE');
  });

  test('CHANNEL sans identifiant n’est pas un salon dédié : repli sur VOICE', () => {
    expect(normaliserConfigDemandes({ notifyVia: 'CHANNEL' }).canal).toBe('VOICE');
    // Une chaîne vide compte comme absente, pas comme un identifiant.
    expect(normaliserConfigDemandes({ notifyVia: 'CHANNEL', notifyChannelId: '' }).canal).toBe('VOICE');
    expect(normaliserConfigDemandes({ notifyVia: 'CHANNEL', notifyChannelId: SALON }).canal).toBe('CHANNEL');
  });

  test('notifyChannelId vide compte comme absent', () => {
    expect(normaliserConfigDemandes({ notifyChannelId: '' }).canalId).toBeNull();
    expect(normaliserConfigDemandes({ notifyChannelId: SALON }).canalId).toBe(SALON);
  });

  test('seul le booléen true active — chaîne, nombre ou null restent éteints', () => {
    for (const valeur of ['true', 1, null]) {
      expect(normaliserConfigDemandes({ enabled: valeur }).activees).toBe(false);
    }
    expect(normaliserConfigDemandes({ enabled: true }).activees).toBe(true);
  });

  test('les minutes hors bornes retombent sur un comportement défendable, lu dans le code', () => {
    const ms = (valeur: unknown) => normaliserConfigDemandes({ requestExpiresMinutes: valeur }).expirationMs;

    // Sous le minimum : clampé à une minute, pas au défaut de dix.
    expect(ms(0)).toBe(1 * MINUTE);
    expect(ms(-5)).toBe(1 * MINUTE);
    // Au-dessus du maximum : clampé à 24 h, pas rejeté.
    expect(ms(99999)).toBe(24 * 60 * MINUTE);
    // Non fini : ni `typeof` ni `Number.isFinite` ne passent, repli sur le défaut.
    expect(ms(Number.NaN)).toBe(EXPIRATION_DEMANDE_MS);
    expect(ms(Number.POSITIVE_INFINITY)).toBe(EXPIRATION_DEMANDE_MS);
    // Un nombre à virgule est arrondi, pas tronqué : 3.7 devient 4.
    expect(ms(3.7)).toBe(4 * MINUTE);
    // Une chaîne, même numérique, n'est pas convertie ici — contrairement à
    // `normalizeUserLimit` qui fait `Number(value)` : incohérence à noter,
    // pas à corriger dans ce fichier.
    expect(ms('10')).toBe(EXPIRATION_DEMANDE_MS);
  });
});

describe('peutRepondreDemande', () => {
  test('le propriétaire et l’admin tranchent quel que soit le réglage', () => {
    for (const repondeurs of REPONDEURS_DEMANDE) {
      expect(peutRepondreDemande('proprietaire', repondeurs).autorise).toBe(true);
      expect(peutRepondreDemande('admin', repondeurs).autorise).toBe(true);
    }
  });

  test('un modérateur ne répond que si le serveur ouvre au staff, avec une raison sinon', () => {
    expect(peutRepondreDemande('moderateur', 'OWNER_AND_STAFF').autorise).toBe(true);

    const verdict = peutRepondreDemande('moderateur', 'OWNER');
    expect(verdict.autorise).toBe(false);
    // La maquette affiche cette raison : un refus muet serait un bouton mort.
    if (verdict.autorise) throw new Error('verdict inattendu');
    expect(verdict.raison.length).toBeGreaterThan(0);
  });

  test('sur les six couples rôle × réglage, un seul est refusé', () => {
    const combinaisons = ROLES_AGISSANTS.flatMap((role) =>
      REPONDEURS_DEMANDE.map((repondeurs) => ({ role, repondeurs, verdict: peutRepondreDemande(role, repondeurs) })),
    );
    const refus = combinaisons.filter(({ verdict }) => !verdict.autorise);

    expect(combinaisons).toHaveLength(6);
    expect(refus).toHaveLength(1);
    expect(refus[0]).toMatchObject({ role: 'moderateur', repondeurs: 'OWNER' });
  });
});

describe('ordreNotification', () => {
  test('chaque canal donne le bon ordre de replis', () => {
    expect(ordreNotification({ canal: 'DM', canalId: null })).toEqual(['DM', 'VOICE']);
    expect(ordreNotification({ canal: 'VOICE', canalId: null })).toEqual(['VOICE', 'DM']);
    expect(ordreNotification({ canal: 'CHANNEL', canalId: SALON })).toEqual(['CHANNEL', 'VOICE', 'DM']);
  });

  test('CHANNEL sans identifiant ne commence jamais par CHANNEL', () => {
    const ordre = ordreNotification({ canal: 'CHANNEL', canalId: null });
    expect(ordre[0]).not.toBe('CHANNEL');
    expect(ordre).toEqual(['VOICE', 'DM']);
  });

  test('aucun ordre ne se termine sans issue : jamais vide, jamais de doublon', () => {
    for (const canal of CANAUX_NOTIFICATION) {
      for (const canalId of [null, SALON]) {
        const ordre = ordreNotification({ canal, canalId });
        expect(ordre.length).toBeGreaterThan(0);
        expect(new Set(ordre).size).toBe(ordre.length);
      }
    }
  });
});

describe('nettoyagePresenceAuDemarrage', () => {
  const presenceAlice: SurchargeMembreLue = { userId: ALICE, accordeEcriture: true, accordeConnexion: false };
  const presenceBob: SurchargeMembreLue = { userId: BOB, accordeEcriture: true, accordeConnexion: false };
  const autorisationAlice: SurchargeMembreLue = { userId: ALICE, accordeEcriture: true, accordeConnexion: true };

  test('en mode « en vocal », un absent porteur d’une présence part, un présent se réinscrit', () => {
    const plan = nettoyagePresenceAuDemarrage('inVoice', [presenceAlice, presenceBob], [BOB]);
    expect(plan.aRetirer).toEqual([ALICE]);
    expect(plan.aMarquerPresence).toEqual([BOB]);
  });

  test('une autorisation explicite (Connect ET SendMessages accordés) n’apparaît dans aucune des deux listes', () => {
    // L'invariant qui compte le plus : un droit donné à la main ne s'efface
    // jamais tout seul — que la personne soit présente ou absente.
    const absente = nettoyagePresenceAuDemarrage('inVoice', [autorisationAlice], []);
    expect(absente).toEqual({ aRetirer: [], aMarquerPresence: [] });

    const presente = nettoyagePresenceAuDemarrage('inVoice', [autorisationAlice], [ALICE]);
    expect(presente).toEqual({ aRetirer: [], aMarquerPresence: [] });
  });

  test('hors « en vocal », toute surcharge de présence part, jamais de réinscription', () => {
    // C'est le salon dont le mode a changé juste avant l'arrêt.
    for (const mode of MODES_ECRITURE.filter((m) => m !== 'inVoice')) {
      const plan = nettoyagePresenceAuDemarrage(mode, [presenceAlice, presenceBob], [ALICE, BOB]);
      expect([...plan.aRetirer].sort()).toEqual([ALICE, BOB].sort());
      expect(plan.aMarquerPresence).toEqual([]);
    }
  });

  test('rien ne casse sur une liste vide, personne de présent, ou une présence sans surcharge', () => {
    expect(nettoyagePresenceAuDemarrage('inVoice', [], [])).toEqual({ aRetirer: [], aMarquerPresence: [] });
    expect(nettoyagePresenceAuDemarrage('inVoice', [], [ALICE])).toEqual({ aRetirer: [], aMarquerPresence: [] });

    const sansSurcharge: SurchargeMembreLue = { userId: ALICE, accordeEcriture: false, accordeConnexion: false };
    expect(nettoyagePresenceAuDemarrage('inVoice', [sansSurcharge], [ALICE])).toEqual({
      aRetirer: [],
      aMarquerPresence: [],
    });
  });

  test('les deux listes sont toujours disjointes', () => {
    for (const mode of MODES_ECRITURE) {
      const plan = nettoyagePresenceAuDemarrage(mode, [presenceAlice, presenceBob], [ALICE]);
      const intersection = plan.aRetirer.filter((id) => plan.aMarquerPresence.includes(id));
      expect(intersection).toEqual([]);
    }
  });
});

describe("Retirer l'acces au proprietaire", () => {
  const cibleProprietaire = {
    nom: 'Toji',
    estStaff: false,
    estProprietaire: true,
    estSoiMeme: false,
    dansLeSalon: true,
    autorise: true,
  };

  test("« Retirer l'acces » est refuse sur le proprietaire du salon", () => {
    // Signale en conditions reelles : le bouton repondait sans rien changer.
    // L'acces du proprietaire vient de SA surcharge, pas d'une autorisation -
    // et « retirer » supprimait cette surcharge, donc ses propres droits.
    const verdict = peutAgirSurCible('proprietaire', 'autoriser', undefined, cibleProprietaire);
    expect(verdict.autorise).toBe(false);
    if (!verdict.autorise) {
      expect(verdict.motif).toBe('cibleDejaProprietaire');
      expect(verdict.raison).toContain('propriétaire');
    }
  });

  test('un moderateur et un admin se heurtent a la meme garde', () => {
    // Elle tient a la cible, pas au role de qui clique.
    for (const role of ['moderateur', 'admin'] as const) {
      expect(peutAgirSurCible(role, 'autoriser', undefined, cibleProprietaire).autorise).toBe(false);
    }
  });

  test("autoriser quelqu'un qui n'est pas proprietaire reste possible", () => {
    // La garde ne doit pas fermer la porte qu'elle n'a pas a fermer.
    const verdict = peutAgirSurCible('proprietaire', 'autoriser', undefined, {
      ...cibleProprietaire,
      estProprietaire: false,
    });
    expect(verdict.autorise).toBe(true);
  });
});

describe('Reservation : roles prevus et sort de ceux qui restent', () => {
  function present(id: string, roles: string[], estBot = false) {
    return { id, estBot, roles: new Set(roles) };
  }

  describe('normaliserConfigReservation', () => {
    test('une ligne absente ou illisible rend les defauts du schema', () => {
      for (const brut of [null, undefined, 42, 'texte', []]) {
        const config = normaliserConfigReservation(brut);
        expect(config.rolesReservables).toEqual([]);
        expect(config.debordement).toBe('ASK');
        expect(config.salonDeRepli).toBeNull();
      }
    });

    test('une decision inconnue retombe sur ASK, jamais sur une valeur qui agit', () => {
      // Un reglage corrompu ne doit deconnecter personne.
      for (const valeur of ['MOVE_ALL', '', 'move', 42, null]) {
        expect(normaliserConfigReservation({ reservationOverflow: valeur }).debordement).toBe('ASK');
      }
    });

    test('les quatre decisions valides sont conservees', () => {
      for (const valeur of ['ASK', 'NOTHING', 'MOVE', 'DISCONNECT'] as const) {
        expect(normaliserConfigReservation({ reservationOverflow: valeur }).debordement).toBe(valeur);
      }
    });

    test('les roles sont dedoublonnes, nettoyes et bornes au plafond de Discord', () => {
      const config = normaliserConfigReservation({
        reservableRoleIds: ['a', 'a', '', 'b', 7, null, ...Array.from({ length: 40 }, (_, i) => `r${i}`)],
      });
      expect(config.rolesReservables).not.toContain('');
      expect(new Set(config.rolesReservables).size).toBe(config.rolesReservables.length);
      expect(config.rolesReservables.length).toBeLessThanOrEqual(MAX_ROLES_RESERVABLES);
    });

    test('un salon de repli vide vaut absence', () => {
      expect(normaliserConfigReservation({ reservationFallbackChannelId: '' }).salonDeRepli).toBeNull();
      expect(normaliserConfigReservation({ reservationFallbackChannelId: 'x' }).salonDeRepli).toBe('x');
    });
  });

  describe('membresSansLeRole', () => {
    const ROLE = 'role-mod';

    test('ne retient que ceux qui n\'ont pas le role', () => {
      const concernes = membresSansLeRole(
        [present('a', [ROLE]), present('b', []), present('c', ['autre'])],
        ROLE,
        'proprio',
      );
      expect(concernes).toEqual(['b', 'c']);
    });

    test('le proprietaire n\'en fait jamais partie, meme sans le role', () => {
      // Reserver son salon ne peut pas l'en ejecter.
      expect(membresSansLeRole([present('proprio', [])], ROLE, 'proprio')).toEqual([]);
    });

    test('les bots sont laisses tranquilles', () => {
      // Les deplacer ne regle rien et casse ce qu'ils font.
      expect(membresSansLeRole([present('bot', [], true)], ROLE, 'proprio')).toEqual([]);
    });
  });

  describe('planDebordement', () => {
    // Pas d'`as const` : il figerait `rolesReservables` en tableau en lecture
    // seule, que `ConfigReservation` refuse.
    const base: ConfigReservation = { rolesReservables: [], debordement: 'ASK', salonDeRepli: null };

    test('personne de concerne : aucune action, et aucune question posee', () => {
      // Demander quoi faire de personne serait du bruit.
      expect(planDebordement({ ...base }, []).action).toBe('aucune');
    });

    test('ASK pose la question, NOTHING ne fait rien', () => {
      expect(planDebordement({ ...base, debordement: 'ASK' }, ['a']).action).toBe('demander');
      expect(planDebordement({ ...base, debordement: 'NOTHING' }, ['a']).action).toBe('aucune');
    });

    test('MOVE avec un salon deplace, sans salon deconnecte en le disant', () => {
      const avec = planDebordement({ ...base, debordement: 'MOVE', salonDeRepli: 'salon' }, ['a']);
      expect(avec.action).toBe('deplacer');
      expect(avec.salon).toBe('salon');
      expect(avec.repliSurDeconnexion).toBe(false);

      const sans = planDebordement({ ...base, debordement: 'MOVE' }, ['a']);
      expect(sans.action).toBe('deconnecter');
      // Le repli doit etre annonce : sinon la personne part sans qu'on sache pourquoi.
      expect(sans.repliSurDeconnexion).toBe(true);
    });

    test('DISCONNECT deconnecte, sans se reclamer d\'un repli', () => {
      const plan = planDebordement({ ...base, debordement: 'DISCONNECT' }, ['a', 'b']);
      expect(plan.action).toBe('deconnecter');
      expect(plan.membres).toEqual(['a', 'b']);
      expect(plan.repliSurDeconnexion).toBe(false);
    });
  });
});

describe('Persistance du panneau : ce qui mourait avec le processus', () => {
  const G = 'g1';
  const C = 'c1';
  const T0 = 1_700_000_000_000;

  describe('RegistreDemandesAcces : export et import', () => {
    test('une demande et un silence vivants font l aller-retour', () => {
      const registre = new RegistreDemandesAcces();
      registre.demander(G, C, 'a', T0);
      registre.resoudre(G, C, 'b', 'refusee', T0);

      const etat = registre.exporterSalon(G, C, T0);
      expect(etat.demandes.map((d) => d.userId)).toEqual(['a']);
      expect(etat.silences.map((v) => v.userId)).toEqual(['b']);

      const neuf = new RegistreDemandesAcces();
      neuf.importerSalon(G, C, etat, T0);
      expect(neuf.demandeEnAttente(G, C, 'a', T0)?.userId).toBe('a');
      expect(neuf.estEnSilence(G, C, 'b', T0)).toBe(true);
    });

    test('ce qui a expire pendant l arret n est ni exporte ni recharge', () => {
      // Le temps a continue de passer sans le bot : un silence de dix minutes ne
      // se remet pas a courir parce que le processus a redemarre.
      const registre = new RegistreDemandesAcces();
      registre.demander(G, C, 'a', T0);
      registre.resoudre(G, C, 'b', 'refusee', T0);

      const plusTard = T0 + 60 * 60_000;
      expect(registre.exporterSalon(G, C, plusTard)).toEqual({ demandes: [], silences: [] });

      // Meme en rechargeant un etat ancien, rien de perime ne revit.
      const neuf = new RegistreDemandesAcces();
      neuf.importerSalon(G, C, registre.exporterSalon(G, C, T0), plusTard);
      expect(neuf.taille).toEqual({ demandes: 0, silences: 0 });
    });

    test('un salon n exporte que le sien', () => {
      const registre = new RegistreDemandesAcces();
      registre.demander(G, C, 'a', T0);
      registre.demander(G, 'autre-salon', 'z', T0);

      expect(registre.exporterSalon(G, C, T0).demandes.map((d) => d.userId)).toEqual(['a']);
    });
  });

  describe('normaliserEtatDemandes : la colonne JSON n est validee par personne', () => {
    test('tout ce qui n est pas exploitable est ignore, jamais devine', () => {
      for (const brut of [null, undefined, 42, 'texte', [], { demandes: 'non' }]) {
        expect(normaliserEtatDemandes(brut)).toEqual({ demandes: [], silences: [] });
      }
    });

    test('les entrees incompletes sont ecartees une par une', () => {
      const etat = normaliserEtatDemandes({
        demandes: [
          { userId: 'ok', demandeeA: T0, expireA: T0 + 1000 },
          { userId: '', demandeeA: T0, expireA: T0 + 1000 },
          { userId: 'sansInstant' },
          { demandeeA: T0, expireA: T0 + 1000 },
          { userId: 'nan', demandeeA: Number.NaN, expireA: T0 },
        ],
        silences: [
          { userId: 'ok2', libereA: T0 + 1000 },
          { userId: 'ko', libereA: 'bientot' },
        ],
      });

      expect(etat.demandes.map((d) => d.userId)).toEqual(['ok']);
      expect(etat.silences.map((v) => v.userId)).toEqual(['ok2']);
    });
  });

  describe('normaliserHistoriqueRenommage', () => {
    test('un horodatage dans le futur est ecarte, pas corrige', () => {
      // Il bloquerait le bouton pour toujours, alors que le quota se
      // reconstitue de lui-meme en dix minutes.
      const historique = normaliserHistoriqueRenommage([T0 - 1000, T0 + 99_999_999], T0);
      expect(historique).toEqual([T0 - 1000]);
    });

    test('ce qui n est pas une liste d instants rend une liste vide', () => {
      for (const brut of [null, 'x', 42, {}, ['a', null, Number.POSITIVE_INFINITY]]) {
        expect(normaliserHistoriqueRenommage(brut, T0)).toEqual([]);
      }
    });

    test('la liste est triee et bornee', () => {
      const brut = Array.from({ length: 50 }, (_, i) => T0 - i * 1000);
      const historique = normaliserHistoriqueRenommage(brut, T0);
      expect(historique.length).toBeLessThanOrEqual(RENOMMAGES_PAR_FENETRE * 2);
      expect([...historique].sort((a, b) => a - b)).toEqual(historique);
    });
  });
});
