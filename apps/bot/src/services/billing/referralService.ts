/**
 * referralService.ts
 *
 * Parrainage : chaque utilisateur Discord a un code. Un serveur qui le saisit à
 * sa première souscription obtient l'essai gratuit (`TRIAL_DAYS`) et une remise
 * sur sa première facture (`REFERRAL_DISCOUNT_PERCENT`). Sans code, pas d'essai.
 *
 * L'usage du code est porté par `BillingTrial.referralCode` : un essai par
 * compte et par serveur, donc un parrainage par filleul, avec les mêmes verrous.
 */

import { Prisma } from '@prisma/client';
import prisma from '../../utils/db.js';
import { randomBlock } from './giftService.js';

const CODE_PREFIX = 'KOTBO-';

/** Code saisi à la main : casse et espaces ignorés, préfixe facultatif. */
export function normalizeReferralCode(raw: string): string {
  const compact = raw.trim().toUpperCase().replace(/\s+/g, '');
  return compact.startsWith(CODE_PREFIX) ? compact : `${CODE_PREFIX}${compact}`;
}

/** Code de l'utilisateur, créé à la première demande. */
export async function getOrCreateReferralCode(discordUserId: string): Promise<string> {
  const existing = await prisma.referralCode.findUnique({ where: { discordUserId }, select: { code: true } });
  if (existing) return existing.code;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const created = await prisma.referralCode.create({
        data: { code: `${CODE_PREFIX}${randomBlock(6)}`, discordUserId },
      });
      return created.code;
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
      // Deux onglets à la fois : l'autre a déjà créé le code de cet utilisateur.
      const raced = await prisma.referralCode.findUnique({ where: { discordUserId }, select: { code: true } });
      if (raced) return raced.code;
    }
  }
  throw new Error('Impossible de générer un code de parrainage unique.');
}

export type ReferralRefusal = 'unknown_code' | 'own_code';

/** Code saisi par un filleul : le code canonique, ou la raison du refus. */
export async function resolveReferralCode(
  raw: string,
  discordUserId: string,
): Promise<{ ok: true; code: string } | { ok: false; reason: ReferralRefusal }> {
  const code = normalizeReferralCode(raw);
  const row = await prisma.referralCode.findUnique({ where: { code }, select: { discordUserId: true } });
  if (!row) return { ok: false, reason: 'unknown_code' };
  if (row.discordUserId === discordUserId) return { ok: false, reason: 'own_code' };
  return { ok: true, code };
}

/** Serveurs dont l'essai a réellement démarré avec ce code. */
export async function countReferrals(code: string): Promise<number> {
  return prisma.billingTrial.count({ where: { referralCode: code, subscriptionId: { not: null } } });
}
