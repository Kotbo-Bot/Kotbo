/**
 * Refus individuel du suivi de présence.
 *
 * Un membre - ou un staff - peut couper à tout moment l'exploitation de sa
 * présence Discord via `/opt-out presence`, ou depuis les réglages de
 * confidentialité du serveur sur le dashboard. Le choix est stocké sur son
 * `MemberProfile`, donc propre au serveur : se retirer d'un serveur ne parle
 * pas pour les autres.
 *
 * Ce que le refus coupe :
 *  - le scan du statut personnalisé / de l'activité qui attribue un auto-rôle
 *    d'identité (`serverTagRoleService`) ;
 *  - la remontée du statut en ligne individuel vers le dashboard et les cartes
 *    de rang (fiche membre, liste de doubles comptes, graphe social, /rank).
 *
 * Ce que le refus ne touche pas : les compteurs agrégés « X membres en ligne »,
 * qui ne désignent personne, et les autres statistiques (messages, vocal), qui
 * relèvent de l'interrupteur analytique du serveur.
 */

import type { Prisma } from '@prisma/client';
import prisma from '../../utils/db.js';
import { upsertRetryingRace } from '../../utils/upsertRetry.js';
import { cache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';

const OPT_OUT_TTL_SECONDS = 300;

/** Préfixe `guild:<id>:` pour que `cache.invalidateGuild` emporte ces clés. */
function cacheKey(guildId: string, userId: string): string {
  return `guild:${guildId}:presence-optout:${userId}`;
}

export type PresencePrivacyState = {
  optedOut: boolean;
  /** Date du refus, ou `null` si le membre suit le réglage par défaut. */
  since: Date | null;
};

/**
 * `true` quand le membre a refusé le suivi de sa présence.
 *
 * Une lecture en échec renvoie `true` : sur une base indisponible, mieux vaut
 * suspendre l'exploitation de la présence que trahir un refus déjà exprimé.
 */
export async function hasOptedOutOfPresenceTracking(
  guildId: string | null | undefined,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!guildId || !userId) return false;

  const key = cacheKey(guildId, userId);
  const cached = await cache.get<{ optedOut: boolean }>(key);
  if (cached) return cached.optedOut;

  try {
    const profile = await prisma.memberProfile.findUnique({
      where: { guildId_userId: { guildId, userId } },
      select: { presenceTrackingOptOut: true },
    });
    const optedOut = profile?.presenceTrackingOptOut === true;
    await cache.set(key, { optedOut }, OPT_OUT_TTL_SECONDS);
    return optedOut;
  } catch (err) {
    logger.error('PresencePrivacy', `Lecture du refus de suivi de ${userId} sur ${guildId} impossible`, err);
    return true;
  }
}

/** État complet du réglage, pour l'afficher au membre. */
export async function getPresencePrivacyState(
  guildId: string,
  userId: string,
): Promise<PresencePrivacyState> {
  const profile = await prisma.memberProfile.findUnique({
    where: { guildId_userId: { guildId, userId } },
    select: { presenceTrackingOptOut: true, presenceOptOutAt: true },
  });

  return {
    optedOut: profile?.presenceTrackingOptOut === true,
    since: profile?.presenceTrackingOptOut ? profile.presenceOptOutAt : null,
  };
}

/**
 * Enregistre (ou annule) le refus et renvoie l'état obtenu.
 *
 * `identity` complète le profil si la ligne n'existe pas encore : un membre qui
 * se retire avant tout message ne doit pas se retrouver en « Utilisateur
 * inconnu » dans la liste des membres.
 */
export async function setPresenceTrackingOptOut(
  guildId: string,
  userId: string,
  optedOut: boolean,
  identity?: Partial<Prisma.MemberProfileUncheckedCreateInput>,
): Promise<PresencePrivacyState> {
  const since = optedOut ? new Date() : null;

  // La ligne `guilds` peut manquer sur un serveur jamais configuré : la clé
  // étrangère du profil ferait alors échouer l'écriture du choix du membre.
  await upsertRetryingRace(() => prisma.guild.upsert({ where: { id: guildId }, update: {}, create: { id: guildId } }));

  await prisma.memberProfile.upsert({
    where: { guildId_userId: { guildId, userId } },
    update: { presenceTrackingOptOut: optedOut, presenceOptOutAt: since },
    create: {
      guildId,
      userId,
      ...(identity ?? {}),
      presenceTrackingOptOut: optedOut,
      presenceOptOutAt: since,
    },
  });

  await cache.delete(cacheKey(guildId, userId));
  return { optedOut, since };
}

/**
 * Identifiants ayant refusé le suivi, parmi ceux passés.
 *
 * Version groupée pour les vues qui affichent des dizaines de membres : une
 * seule requête au lieu d'un aller-retour par ligne.
 */
export async function findPresenceOptOuts(
  guildId: string,
  userIds: readonly string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();

  try {
    const rows = await prisma.memberProfile.findMany({
      where: { guildId, userId: { in: [...userIds] }, presenceTrackingOptOut: true },
      select: { userId: true },
    });
    return new Set(rows.map((row) => row.userId));
  } catch (err) {
    logger.error('PresencePrivacy', `Lecture groupée des refus de suivi sur ${guildId} impossible`, err);
    return new Set(userIds);
  }
}

/**
 * Statut en ligne à exposer : `null` dès que le membre a refusé le suivi.
 *
 * Les vues du dashboard traitent déjà `null` comme « statut inconnu » et
 * affichent une pastille neutre, donc aucun cas particulier côté client.
 */
export async function visiblePresenceStatus(
  guildId: string | null | undefined,
  userId: string | null | undefined,
  status: string | null,
): Promise<string | null> {
  if (status === null) return null;
  if (await hasOptedOutOfPresenceTracking(guildId, userId)) return null;
  return status;
}
