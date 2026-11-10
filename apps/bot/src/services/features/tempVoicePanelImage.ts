/**
 * Carte d'état d'un salon vocal temporaire, rendue en PNG.
 *
 * POURQUOI UNE IMAGE. Components V2 n'a aucun composant de colonnes. Les sept
 * valeurs ne se rangent nativement qu'en un seul cas : trois champs « inline »
 * d'un embed classique, ce qui impose une grille à 3 colonnes (et une colonne
 * unique sur téléphone, Discord décidant seul selon la largeur). Toute autre
 * mise en page — 2 colonnes, tableau, cartes — se dessine ici.
 *
 * FOND TRANSPARENT, JAMAIS DE RECTANGLE PEINT. Un fond opaque se verrait comme
 * une plaque posée sur l'embed dès que le lecteur change de thème. L'image ne
 * peint donc que du texte, des filets et des cadres, et se rogne aux pixels
 * réellement peints : la taille suit le contenu au lieu d'être devinée.
 */

import { createCanvas, loadImage, type Canvas, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { canvasFont, ensureCanvasFonts } from '../../utils/canvasFonts.js';
import { logger } from '../../utils/logger.js';

export interface ValeurEtat {
  libelle: string;
  valeur: string;
  /** Nom de fichier sans extension, ex. `ktb_lock`. Une icône absente est ignorée. */
  icone?: string;
}

export type DispositionImage = 'GRID3' | 'GRID2' | 'TABLE' | 'CARDS';
export type TeinteImage = 'NEUTRAL' | 'DARK' | 'LIGHT';

// ─────────────────────────────────────────────────────────────────────────────
// Icônes
//
// ⚠️ Les 97 PNG `ktb_*` vivent dans `apps/dashboard/public/emojis-png`, que le
// Dockerfile du bot NE COPIE PAS (il ne prend que `packages/*` et `apps/bot`).
// Les lire là-bas marche sur un poste de dev et rend une carte muette en
// production. Les seules icônes utilisées ici sont donc recopiées sous
// `apps/bot/assets/temp-voice-panel/`, chargées par le même motif que
// `rankCardDecor.ts` et `levelingService.ts`.
// ─────────────────────────────────────────────────────────────────────────────

const DOSSIER_ICONES = fileURLToPath(new URL('../../../assets/temp-voice-panel/', import.meta.url));

// `null` mémorise un fichier manquant : sans lui, une icône absente relancerait
// un accès disque à chaque rafraîchissement, et le panneau se rafraîchit en
// rafale (verrouiller, autoriser, bannir s'enchaînent).
const icones = new Map<string, Image | null>();

async function chargerIcone(nom: string): Promise<Image | null> {
  const enCache = icones.get(nom);
  if (enCache !== undefined) return enCache;

  try {
    const image = await loadImage(`${DOSSIER_ICONES}${nom}.png`);
    icones.set(nom, image);
    return image;
  } catch (error) {
    logger.warn('TempVoicePanel', `Icône ${nom}.png illisible, la carte se rend sans elle:`, error);
    icones.set(nom, null);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Jetons
//
// Deux couches : une échelle (une seule pour l'espacement, une seule pour la
// typo) et une couche sémantique par teinte. Rien ne lit une valeur brute plus
// bas.
//
// LES TROIS TEINTES NE CHANGENT QUE LE TEXTE, LES FILETS ET LES CADRES — jamais
// un fond. Le raisonnement, mesuré sur les fonds d'embed réels de Discord
// (thème clair `#f2f3f5`, thème sombre `#2b2d31`, ratios WCAG) :
//
//   • Une seule couleur ne peut pas atteindre 4,5:1 sur deux fonds opposés :
//     l'optimum mathématique (contrastes égaux des deux côtés) plafonne à
//     ~3,5:1. NEUTRAL prend ce plafond — `#7f858d` mesure 3,35:1 sur le thème
//     clair et 3,71:1 sur le sombre : lisible partout, AA pour un grand texte,
//     sous AA pour un texte courant. C'est un compromis assumé, et c'est
//     précisément la raison d'être des deux autres teintes.
//   • DARK sert un client en THÈME CLAIR : texte sombre `#1f2124` (14,5:1) et
//     libellé `#5c6169` (5,6:1) — AA franc.
//   • LIGHT sert un client en THÈME SOMBRE : texte très clair `#f2f3f5`
//     (12,4:1) et libellé `#b5bac1` (7,1:1) — AA franc.
//
// Conséquence sur la hiérarchie : en NEUTRAL la couleur est dépensée pour être
// indifférente au thème, elle ne peut donc pas porter le contraste
// libellé/valeur. Il est porté par les trois autres leviers — taille, graisse,
// espace — plus la casse : les libellés sont en capitales, les valeurs non.
// ─────────────────────────────────────────────────────────────────────────────

/** Rendu à 2x : net une fois l'image réduite par le client, largeur logique gardée sous 900 px. */
const ECHELLE = 2;

/** Marge logique laissée autour du contenu peint. */
const MARGE = 6;

/** Échelle typographique — deux niveaux, pas trois. */
const T_LIBELLE = 12;
const T_VALEUR = 17;

/** Échelle d'espacement unique : multiples de 4. */
const P4 = 4;
const P8 = 8;
const P12 = 12;
const P16 = 16;
const P24 = 24;

const ICONE = 18;
const H_LIBELLE = 14;
const H_VALEUR = 22;

/** Plafond de largeur logique : sous 900 px, l'embed ne réduit pas assez pour flouter. */
const LARGEUR_MAX = 860;

interface Jetons {
  valeur: string;
  libelle: string;
  trait: string;
  cadre: string;
}

const JETONS: Record<TeinteImage, Jetons> = {
  NEUTRAL: {
    valeur: '#7f858d',
    libelle: '#7f858d',
    trait: 'rgba(127, 133, 141, 0.55)',
    cadre: 'rgba(127, 133, 141, 0.55)',
  },
  DARK: {
    valeur: '#1f2124',
    libelle: '#5c6169',
    trait: 'rgba(31, 33, 36, 0.24)',
    cadre: 'rgba(31, 33, 36, 0.30)',
  },
  LIGHT: {
    valeur: '#f2f3f5',
    libelle: '#b5bac1',
    trait: 'rgba(242, 243, 245, 0.24)',
    cadre: 'rgba(242, 243, 245, 0.30)',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Dispositions
// ─────────────────────────────────────────────────────────────────────────────

interface Plan {
  colonnes: number;
  /** `bloc` = libellé au-dessus de la valeur ; `ligne` = libellé à gauche, valeur à droite. */
  cellule: 'bloc' | 'ligne';
  /** Filet vertical entre colonnes. */
  traitsVerticaux: boolean;
  /** Filet horizontal sous chaque ligne sauf la dernière. */
  traitsHorizontaux: boolean;
  /**
   * Cadre arrondi par cellule. L'élévation se déclare une seule fois : cadre OU
   * ombre, jamais les deux — il n'y a donc aucune ombre ici.
   */
  cadres: boolean;
  padX: number;
  padY: number;
  ecartX: number;
  ecartY: number;
}

const PLANS: Record<DispositionImage, Plan> = {
  GRID3: { colonnes: 3, cellule: 'bloc', traitsVerticaux: true, traitsHorizontaux: false, cadres: false, padX: P16, padY: P8, ecartX: 0, ecartY: P24 },
  GRID2: { colonnes: 2, cellule: 'bloc', traitsVerticaux: true, traitsHorizontaux: false, cadres: false, padX: P16, padY: P8, ecartX: 0, ecartY: P16 },
  TABLE: { colonnes: 1, cellule: 'ligne', traitsVerticaux: false, traitsHorizontaux: true, cadres: false, padX: P8, padY: P8, ecartX: 0, ecartY: 0 },
  CARDS: { colonnes: 3, cellule: 'bloc', traitsVerticaux: false, traitsHorizontaux: false, cadres: true, padX: P16, padY: P12, ecartX: P12, ecartY: P12 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Mesure puis tracé
// ─────────────────────────────────────────────────────────────────────────────

interface Cellule {
  libelle: string;
  valeur: string;
  image: Image | null;
  wLibelle: number;
  wValeur: number;
}

/** Coupe au caractère près, avec une ellipse, pour ne jamais déborder d'une colonne. */
function tronquer(ctx: SKRSContext2D, texte: string, largeurMax: number): string {
  if (ctx.measureText(texte).width <= largeurMax) return texte;

  let coupe = texte;
  while (coupe.length > 1 && ctx.measureText(`${coupe}…`).width > largeurMax) {
    coupe = coupe.slice(0, -1);
  }
  return `${coupe}…`;
}

function ecrire(ctx: SKRSContext2D, texte: string, x: number, y: number, couleur: string): void {
  ctx.fillStyle = couleur;
  ctx.fillText(texte, x, y);
}

/** Filet de 1 px logique : un rectangle plein reste net à 2x, `lineWidth` non. */
function filet(ctx: SKRSContext2D, x: number, y: number, largeur: number, hauteur: number, couleur: string): void {
  ctx.fillStyle = couleur;
  ctx.fillRect(x, y, largeur, hauteur);
}

/**
 * Rogne un canvas aux pixels réellement peints (alpha > 0) et laisse `marge` px
 * autour. Exportée pour être testable.
 *
 * ponytail: balayage O(pixels) du canvas alloué (quelques centaines de milliers
 * de pixels ici, ~2 ms). Si ce coût devenait visible, tenir la boîte englobante
 * au moment du tracé plutôt que de relire l'image.
 */
export function rognerAuxPixelsPeints(canvas: Canvas, marge: number): Canvas {
  const { width, height } = canvas;
  const { data } = canvas.getContext('2d').getImageData(0, 0, width, height);

  let xMin = width;
  let yMin = height;
  let xMax = -1;
  let yMax = -1;

  for (let y = 0; y < height; y += 1) {
    const debut = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      if (data[debut + x * 4 + 3] === 0) continue;
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      yMax = y;
    }
  }

  // Rien de peint : un canvas vide plutôt qu'une exception, l'appelant a déjà
  // un panneau à afficher.
  if (xMax < 0) return createCanvas(1, 1);

  const sortie = createCanvas(xMax - xMin + 1 + marge * 2, yMax - yMin + 1 + marge * 2);
  sortie.getContext('2d').drawImage(canvas, marge - xMin, marge - yMin);
  return sortie;
}

/**
 * Les valeurs dans l'ordre État, Places, Visibilité, Écriture, Autorisés, Bannis, Réservé.
 */
export async function rendreEtatPng(
  valeurs: readonly ValeurEtat[],
  disposition: DispositionImage,
  teinte: TeinteImage,
): Promise<Buffer> {
  ensureCanvasFonts();

  const plan = PLANS[disposition];
  const jetons = JETONS[teinte];

  // Les icônes se chargent avant le tracé : le contexte 2D est synchrone, un
  // `await` au milieu d'un dessin n'a pas de sens.
  const images = await Promise.all(valeurs.map((v) => (v.icone ? chargerIcone(v.icone) : Promise.resolve(null))));

  // Mesure sur un contexte jetable : les largeurs de colonne se décident avant
  // de connaître la taille du canvas définitif.
  const regle = createCanvas(1, 1).getContext('2d');

  const cellules: Cellule[] = valeurs.map((v, i) => {
    regle.font = canvasFont(T_LIBELLE, 'bold');
    const wLibelle = regle.measureText(v.libelle.toUpperCase()).width;
    regle.font = canvasFont(T_VALEUR, 'bold');
    const wValeur = regle.measureText(v.valeur).width;
    return { libelle: v.libelle.toUpperCase(), valeur: v.valeur, image: images[i] ?? null, wLibelle, wValeur };
  });

  if (cellules.length === 0) return createCanvas(1, 1).encode('png');

  const lignes = Math.ceil(cellules.length / plan.colonnes);
  const largeurIcone = (c: Cellule): number => (c.image ? ICONE + P8 : 0);

  // Chaque colonne prend la largeur de SON contenu, pas celle de la plus longue
  // valeur de la carte : une largeur unique faisait porter à « Places » la
  // longueur d'un nom de rôle, et l'image doublait de largeur pour du vide.
  // Les colonnes restent alignées d'une ligne à l'autre, c'est ce qui compte.
  const largeurs: number[] = [];
  let colLibelle = 0;

  if (plan.cellule === 'ligne') {
    colLibelle = Math.max(...cellules.map((c) => c.wLibelle));
    const colValeur = Math.max(...cellules.map((c) => largeurIcone(c) + c.wValeur));
    largeurs.push(Math.ceil(plan.padX * 2 + colLibelle + P24 + colValeur));
  } else {
    for (let colonne = 0; colonne < plan.colonnes; colonne += 1) {
      const dansLaColonne = cellules.filter((_, i) => i % plan.colonnes === colonne);
      const contenu = Math.max(0, ...dansLaColonne.map((c) => Math.max(c.wLibelle, largeurIcone(c) + c.wValeur)));
      largeurs.push(Math.ceil(plan.padX * 2 + contenu));
    }
  }

  // Plafond logique : la colonne la plus large rend ce qu'il faut, et sa valeur
  // se coupe. Réduire la plus large d'abord évite de rogner une colonne courte
  // qui, elle, tient déjà.
  const LARGEUR_MIN_COLONNE = plan.padX * 2 + 48;
  const ecarts = plan.ecartX * (plan.colonnes - 1);
  for (let garde = 0; garde < plan.colonnes; garde += 1) {
    const total = largeurs.reduce((a, b) => a + b, 0) + ecarts;
    if (total <= LARGEUR_MAX) break;
    const plusLarge = largeurs.indexOf(Math.max(...largeurs));
    const retrait = Math.min(largeurs[plusLarge]! - LARGEUR_MIN_COLONNE, total - LARGEUR_MAX);
    if (retrait <= 0) break;
    largeurs[plusLarge] = largeurs[plusLarge]! - retrait;
  }

  const hauteurCellule = plan.cellule === 'ligne'
    ? plan.padY * 2 + Math.max(H_VALEUR, ICONE)
    : plan.padY * 2 + H_LIBELLE + P8 + Math.max(H_VALEUR, ICONE);

  /** Abscisse du bord gauche d'une colonne. */
  const xColonne = (colonne: number): number =>
    largeurs.slice(0, colonne).reduce((a, b) => a + b, 0) + plan.ecartX * colonne;

  const largeurContenu = largeurs.reduce((a, b) => a + b, 0) + ecarts;
  const hauteurContenu = hauteurCellule * lignes + plan.ecartY * (lignes - 1);

  // Le canvas est alloué un peu large : le rognage final décide de la taille
  // exacte, il n'y a donc rien à deviner au pixel près ici.
  const canvas = createCanvas((largeurContenu + MARGE * 2 + P8) * ECHELLE, (hauteurContenu + MARGE * 2 + P8) * ECHELLE);
  const ctx = canvas.getContext('2d');
  ctx.scale(ECHELLE, ECHELLE);
  ctx.translate(MARGE, MARGE);

  for (let i = 0; i < cellules.length; i += 1) {
    const cellule = cellules[i]!;
    const colonne = i % plan.colonnes;
    const ligne = Math.floor(i / plan.colonnes);
    const largeurCellule = largeurs[colonne]!;
    const x = xColonne(colonne);
    const y = ligne * (hauteurCellule + plan.ecartY);

    if (plan.cadres) {
      ctx.strokeStyle = jetons.cadre;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(x + 0.5, y + 0.5, largeurCellule - 1, hauteurCellule - 1, P8);
      ctx.stroke();
    }

    const disponible = largeurCellule - plan.padX * 2;

    if (plan.cellule === 'ligne') {
      const centreY = y + hauteurCellule / 2;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';

      ctx.font = canvasFont(T_LIBELLE, 'bold');
      ecrire(ctx, tronquer(ctx, cellule.libelle, colLibelle), x + plan.padX, centreY, jetons.libelle);

      let curseur = x + plan.padX + colLibelle + P24;
      if (cellule.image) {
        ctx.drawImage(cellule.image, curseur, centreY - ICONE / 2, ICONE, ICONE);
        curseur += ICONE + P8;
      }
      ctx.font = canvasFont(T_VALEUR, 'bold');
      ecrire(ctx, tronquer(ctx, cellule.valeur, x + largeurCellule - plan.padX - curseur), curseur, centreY, jetons.valeur);
    } else {
      ctx.textAlign = 'left';

      ctx.textBaseline = 'top';
      ctx.font = canvasFont(T_LIBELLE, 'bold');
      ecrire(ctx, tronquer(ctx, cellule.libelle, disponible), x + plan.padX, y + plan.padY, jetons.libelle);

      const centreY = y + plan.padY + H_LIBELLE + P8 + Math.max(H_VALEUR, ICONE) / 2;
      let curseur = x + plan.padX;
      if (cellule.image) {
        ctx.drawImage(cellule.image, curseur, centreY - ICONE / 2, ICONE, ICONE);
        curseur += ICONE + P8;
      }
      ctx.textBaseline = 'middle';
      ctx.font = canvasFont(T_VALEUR, 'bold');
      ecrire(ctx, tronquer(ctx, cellule.valeur, x + largeurCellule - plan.padX - curseur), curseur, centreY, jetons.valeur);
    }

    if (plan.traitsVerticaux && colonne > 0) {
      filet(ctx, x - plan.ecartX / 2, y + P4, 1, hauteurCellule - P8, jetons.trait);
    }

    if (plan.traitsHorizontaux && colonne === plan.colonnes - 1 && ligne < lignes - 1) {
      filet(ctx, 0, y + hauteurCellule, largeurContenu, 1, jetons.trait);
    }
  }

  // `encode` compresse hors du fil principal ; `toBuffer` est synchrone et
  // bloquerait la boucle d'événements à chaque rafraîchissement du panneau.
  return rognerAuxPixelsPeints(canvas, MARGE * ECHELLE).encode('png');
}
