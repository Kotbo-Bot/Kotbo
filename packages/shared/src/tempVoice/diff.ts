/**
 * Différences entre deux états des réglages vocaux, lisibles par un humain.
 *
 * Fonction pure, sans accès à la base ni à Discord : la route du dashboard s'en
 * sert pour le journal d'audit, et le bot peut la réutiliser telle quelle pour
 * un embed Discord. Les noms de salons et de rôles viennent d'un résolveur
 * passé par l'appelant (le cache Discord), jamais d'ici.
 *
 * Forme attendue des deux états (`ReglagesVocaux`) : les clés vocales de
 * `Guild` à plat (`tempVoiceEnabled`, `tempVoiceChannelId`, ...), la politique
 * principale (`tempVoiceDefaults`), la liste des générateurs additionnels
 * (`tempVoiceGenerators`) et les deux lignes de config (`tempVoiceModPermissions`,
 * `tempVoiceAccessRequest`), chacune à plat.
 */

export interface ChangementReglage {
  /** Libellé français du champ, ex. « Panneau : mode ». */
  champ: string;
  avant: string;
  apres: string;
}

export type ReglagesVocaux = Record<string, unknown>;

/** Résolveurs optionnels : renvoient `undefined` quand l'id n'est pas en cache. */
export interface NomsLisibles {
  salon?: (id: string) => string | undefined;
  role?: (id: string) => string | undefined;
}

const AUCUN = '(aucun)';

/** Champs d'une politique, communs au principal et aux générateurs additionnels. */
const LIBELLES_POLITIQUE: Record<string, string> = {
  userLimit: 'Places',
  lockOnCreate: 'Créer verrouillé',
  autoAllowRoleIds: 'Rôles autorisés d\'office',
  textChat: 'Chat textuel',
  ownerPowers: 'Pouvoirs du propriétaire',
};

const LIBELLES_GENERATEUR: Record<string, string> = {
  ...LIBELLES_POLITIQUE,
  channelId: 'Salon',
  categoryId: 'Catégorie',
  nameTemplate: 'Modèle de nom',
  requiredRoleId: 'Rôle requis',
  panelMode: 'Panneau : mode',
  stateLayout: 'Panneau : disposition des états',
  stateColors: 'Panneau : palette',
  panelComponents: 'Panneau : composants',
  reservationFallbackMode: 'Réservation : repli sans rôle',
};

const LIBELLES: Record<string, string> = {
  tempVoiceEnabled: 'Salons temporaires activés',
  tempVoiceChannelId: 'Générateur principal : salon',
  tempVoiceCategoryId: 'Générateur principal : catégorie',
  tempVoiceNameTemplate: 'Générateur principal : modèle de nom',
  tempVoiceRequiredRoleId: 'Générateur principal : rôle requis',
  ...Object.fromEntries(
    Object.entries(LIBELLES_POLITIQUE).map(([k, v]) => [`tempVoiceDefaults.${k}`, `Générateur principal : ${v.toLowerCase()}`]),
  ),
  'tempVoiceModPermissions.canRename': 'Modérateurs : renommer',
  'tempVoiceModPermissions.canChangeLimit': 'Modérateurs : changer la limite',
  'tempVoiceModPermissions.canLock': 'Modérateurs : verrouiller',
  'tempVoiceModPermissions.canChangeWriteMode': 'Modérateurs : mode d\'écriture',
  'tempVoiceModPermissions.canKickOrBan': 'Modérateurs : expulser ou bannir',
  'tempVoiceModPermissions.canReserve': 'Modérateurs : réserver',
  'tempVoiceModPermissions.canTransfer': 'Modérateurs : transférer',
  'tempVoiceModPermissions.panelCompactMode': 'Panneau compact',
  'tempVoiceModPermissions.reservableRoleIds': 'Réservation : rôles proposés',
  'tempVoiceModPermissions.reservationOverflow': 'Réservation : sort des présents',
  'tempVoiceModPermissions.reservationFallbackChannelId': 'Réservation : salon de repli',
  'tempVoiceModPermissions.reservationFallbackMode': 'Réservation : repli sans rôle',
  'tempVoiceModPermissions.panelMode': 'Panneau : mode',
  'tempVoiceModPermissions.stateLayout': 'Panneau : disposition des états',
  'tempVoiceModPermissions.stateColors': 'Panneau : palette',
  'tempVoiceModPermissions.panelComponents': 'Panneau : composants',
  'tempVoiceModPermissions.perGeneratorPresentation': 'Présentation par générateur',
  'tempVoiceModPermissions.ownerMentionPlacement': 'Mention du propriétaire',
  'tempVoiceModPermissions.handoverDmEnabled': 'Passation : MP au propriétaire',
  'tempVoiceModPermissions.handoverDelaySeconds': 'Passation : délai (secondes)',
  'tempVoiceModPermissions.claimEmbedEnabled': 'Passation : message « Récupérer le salon »',
  'tempVoiceModPermissions.claimWho': 'Passation : qui peut récupérer',
  'tempVoiceModPermissions.moderatorClaimOverride': 'Passation : le staff peut annuler',
  'tempVoiceModPermissions.deleteWhenEmpty': 'Supprimer un salon vide',
  'tempVoiceAccessRequest.enabled': 'Demandes d\'accès activées',
  'tempVoiceAccessRequest.responders': 'Demandes d\'accès : répondants',
  'tempVoiceAccessRequest.notifyVia': 'Demandes d\'accès : notification',
  'tempVoiceAccessRequest.notifyChannelId': 'Demandes d\'accès : salon dédié',
  'tempVoiceAccessRequest.requestExpiresMinutes': 'Demandes d\'accès : expiration (min)',
  'tempVoiceAccessRequest.denyCooldownMinutes': 'Demandes d\'accès : silence après un refus (min)',
};

/** Langues des libellés : le français est la langue de l'audit, l'anglais sert l'embed d'un serveur anglophone. */
export type LangueDiff = 'fr' | 'en';

const TEXTES = {
  fr: { oui: 'oui', non: 'non', aucun: AUCUN, present: 'présent', ajoute: 'ajouté', supprime: 'supprimé', generateur: 'Générateur' },
  en: { oui: 'yes', non: 'no', aucun: '(none)', present: 'present', ajoute: 'added', supprime: 'removed', generateur: 'Generator' },
} as const;

const LIBELLES_POLITIQUE_EN: Record<string, string> = {
  userLimit: 'User limit',
  lockOnCreate: 'Locked on creation',
  autoAllowRoleIds: 'Roles allowed by default',
  textChat: 'Text chat',
  ownerPowers: 'Owner powers',
};

const LIBELLES_GENERATEUR_EN: Record<string, string> = {
  ...LIBELLES_POLITIQUE_EN,
  channelId: 'Channel',
  categoryId: 'Category',
  nameTemplate: 'Name template',
  requiredRoleId: 'Required role',
  panelMode: 'Panel: mode',
  stateLayout: 'Panel: state layout',
  stateColors: 'Panel: palette',
  panelComponents: 'Panel: components',
  reservationFallbackMode: 'Reservation: fallback without role',
};

const LIBELLES_EN: Record<string, string> = {
  tempVoiceEnabled: 'Temporary channels enabled',
  tempVoiceChannelId: 'Main generator: channel',
  tempVoiceCategoryId: 'Main generator: category',
  tempVoiceNameTemplate: 'Main generator: name template',
  tempVoiceRequiredRoleId: 'Main generator: required role',
  ...Object.fromEntries(
    Object.entries(LIBELLES_POLITIQUE_EN).map(([k, v]) => [`tempVoiceDefaults.${k}`, `Main generator: ${v.toLowerCase()}`]),
  ),
  'tempVoiceModPermissions.canRename': 'Moderators: rename',
  'tempVoiceModPermissions.canChangeLimit': 'Moderators: change the limit',
  'tempVoiceModPermissions.canLock': 'Moderators: lock',
  'tempVoiceModPermissions.canChangeWriteMode': 'Moderators: write mode',
  'tempVoiceModPermissions.canKickOrBan': 'Moderators: kick or ban',
  'tempVoiceModPermissions.canReserve': 'Moderators: reserve',
  'tempVoiceModPermissions.canTransfer': 'Moderators: transfer',
  'tempVoiceModPermissions.panelCompactMode': 'Compact panel',
  'tempVoiceModPermissions.reservableRoleIds': 'Reservation: offered roles',
  'tempVoiceModPermissions.reservationOverflow': 'Reservation: members already inside',
  'tempVoiceModPermissions.reservationFallbackChannelId': 'Reservation: fallback channel',
  'tempVoiceModPermissions.reservationFallbackMode': 'Reservation: fallback without role',
  'tempVoiceModPermissions.panelMode': 'Panel: mode',
  'tempVoiceModPermissions.stateLayout': 'Panel: state layout',
  'tempVoiceModPermissions.stateColors': 'Panel: palette',
  'tempVoiceModPermissions.panelComponents': 'Panel: components',
  'tempVoiceModPermissions.perGeneratorPresentation': 'Per-generator presentation',
  'tempVoiceModPermissions.ownerMentionPlacement': 'Owner mention',
  'tempVoiceModPermissions.handoverDmEnabled': 'Handover: DM to the owner',
  'tempVoiceModPermissions.handoverDelaySeconds': 'Handover: delay (seconds)',
  'tempVoiceModPermissions.claimEmbedEnabled': 'Handover: "Claim the channel" message',
  'tempVoiceModPermissions.claimWho': 'Handover: who can claim',
  'tempVoiceModPermissions.moderatorClaimOverride': 'Handover: staff can cancel',
  'tempVoiceModPermissions.deleteWhenEmpty': 'Delete an empty channel',
  'tempVoiceAccessRequest.enabled': 'Access requests enabled',
  'tempVoiceAccessRequest.responders': 'Access requests: responders',
  'tempVoiceAccessRequest.notifyVia': 'Access requests: notification',
  'tempVoiceAccessRequest.notifyChannelId': 'Access requests: dedicated channel',
  'tempVoiceAccessRequest.requestExpiresMinutes': 'Access requests: expiry (min)',
  'tempVoiceAccessRequest.denyCooldownMinutes': 'Access requests: silence after a refusal (min)',
};

function aplatir(valeur: unknown, chemin: string, sortie: Map<string, unknown>): void {
  if (valeur && typeof valeur === 'object' && !Array.isArray(valeur)) {
    for (const [cle, sous] of Object.entries(valeur)) aplatir(sous, chemin ? `${chemin}.${cle}` : cle, sortie);
    return;
  }
  sortie.set(chemin, valeur);
}

function vide(valeur: unknown): boolean {
  return valeur === null || valeur === undefined || valeur === '' || (Array.isArray(valeur) && valeur.length === 0);
}

/**
 * Les listes se comparent comme des ensembles : l'ordre d'un tableau d'ids ne
 * change rien. `''`, `null`, `[]` et l'absence valent « aucun » : passer de l'un
 * à l'autre n'est pas un changement.
 */
function canon(valeur: unknown): string {
  if (vide(valeur)) return 'null';
  if (Array.isArray(valeur)) return JSON.stringify([...valeur].map(String).sort());
  return JSON.stringify(valeur);
}

function nomDe(id: string, resolveur: ((id: string) => string | undefined) | undefined, prefixe: string): string {
  const nom = resolveur?.(id);
  return nom ? `${prefixe}${nom}` : id;
}

function rendre(champ: string, valeur: unknown, noms: NomsLisibles, t: (typeof TEXTES)[LangueDiff]): string {
  if (vide(valeur)) return t.aucun;
  const nature = /RoleIds?$/.test(champ) ? 'role' : /(channel|category)id$/i.test(champ) ? 'salon' : null;
  const un = (v: unknown): string => {
    if (typeof v === 'boolean') return v ? t.oui : t.non;
    const texte = String(v);
    if (nature === 'role') return nomDe(texte, noms.role, '@');
    if (nature === 'salon') return nomDe(texte, noms.salon, '#');
    return texte.length > 200 ? `${texte.slice(0, 200)}…` : texte;
  };
  return Array.isArray(valeur) ? valeur.map(un).join(', ') : un(valeur);
}

/** Clé stable d'un générateur additionnel : son salon, à défaut sa position. */
function cleGenerateur(entree: unknown, index: number): string {
  const id = entree && typeof entree === 'object' ? (entree as Record<string, unknown>).channelId : null;
  return typeof id === 'string' && id ? id : `#${index + 1}`;
}

function aplatirGenerateurs(liste: unknown): Map<string, Map<string, unknown>> {
  const sortie = new Map<string, Map<string, unknown>>();
  if (!Array.isArray(liste)) return sortie;
  liste.forEach((entree, index) => {
    const champs = new Map<string, unknown>();
    aplatir(entree, '', champs);
    sortie.set(cleGenerateur(entree, index), champs);
  });
  return sortie;
}

/**
 * Compare champ par champ tout ce qui est réglable côté vocaux. Rend un tableau
 * vide quand rien n'a changé ; l'ordre est celui des réglages (serveur,
 * politique principale, modérateurs, demandes d'accès, générateurs).
 *
 * `avant` absent (serveur jamais configuré) se lit comme un état entièrement vide :
 * l'appelant doit plutôt lui passer les défauts s'il veut des différences utiles.
 */
export function diffReglagesVocaux(
  avant: ReglagesVocaux | null | undefined,
  apres: ReglagesVocaux,
  noms: NomsLisibles = {},
  langue: LangueDiff = 'fr',
): ChangementReglage[] {
  const t = TEXTES[langue];
  const libelles = langue === 'en' ? LIBELLES_EN : LIBELLES;
  const libellesGen = langue === 'en' ? LIBELLES_GENERATEUR_EN : LIBELLES_GENERATEUR;
  const a = new Map<string, unknown>();
  const b = new Map<string, unknown>();
  const { tempVoiceGenerators: genAvant, ...resteAvant } = avant ?? {};
  const { tempVoiceGenerators: genApres, ...resteApres } = apres;
  aplatir(resteAvant, '', a);
  aplatir(resteApres, '', b);

  const changements: ChangementReglage[] = [];
  const chemins = [...new Set([...a.keys(), ...b.keys()])];
  for (const chemin of chemins) {
    if (canon(a.get(chemin)) === canon(b.get(chemin))) continue;
    changements.push({
      champ: libelles[chemin] ?? chemin,
      avant: rendre(chemin, a.get(chemin), noms, t),
      apres: rendre(chemin, b.get(chemin), noms, t),
    });
  }

  const ga = aplatirGenerateurs(genAvant);
  const gb = aplatirGenerateurs(genApres);
  const nomGen = (cle: string) => `${t.generateur} ${cle.startsWith('#') ? cle : nomDe(cle, noms.salon, '#')}`;
  for (const cle of new Set([...ga.keys(), ...gb.keys()])) {
    const ancien = ga.get(cle);
    const nouveau = gb.get(cle);
    if (!ancien || !nouveau) {
      changements.push({ champ: nomGen(cle), avant: ancien ? t.present : t.aucun, apres: nouveau ? t.ajoute : t.supprime });
      continue;
    }
    for (const champ of new Set([...ancien.keys(), ...nouveau.keys()])) {
      if (canon(ancien.get(champ)) === canon(nouveau.get(champ))) continue;
      changements.push({
        champ: `${nomGen(cle)} : ${(libellesGen[champ] ?? champ).replace(/^./, (c) => c.toLowerCase())}`,
        avant: rendre(champ, ancien.get(champ), noms, t),
        apres: rendre(champ, nouveau.get(champ), noms, t),
      });
    }
  }
  return changements;
}

/** Une ligne par changement : « champ : avant → après ». */
export function lignesDiffReglages(changements: readonly ChangementReglage[]): string[] {
  return changements.map((c) => `${c.champ} : ${c.avant} → ${c.apres}`);
}
