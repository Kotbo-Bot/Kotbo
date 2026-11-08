/**
 * captchaTrigger.ts - Quand le captcha s'applique-t-il à un arrivant ?
 *
 *  - ALWAYS : à chaque arrivée.
 *  - AUTO   : seulement pendant un raid ou une alerte Shield 3 et plus.
 *  - SMART  : AUTO, plus les comptes au profil suspect, même hors raid.
 *
 * Shield passe avant le réglage : à partir du niveau 3, tout arrivant passe le
 * captcha ; aux niveaux 2 et 1, il est gelé (retenu sans défi jusqu'à la fin
 * de l'alerte).
 */

import { GuildMemberFlags, UserFlags, type GuildMember } from 'discord.js';
import type { RaidProtectionConfig } from '@prisma/client';

const DAY_MS = 24 * 60 * 60 * 1000;

export type ArrivalAssessment = { suspicious: boolean; score: number; reasons: string[] };

/** Seuil au-delà duquel un arrivant est jugé suspect. */
export const SUSPICION_THRESHOLD = 3;

/**
 * Note le profil d'un arrivant. Chaque indice est faible seul ; c'est leur
 * cumul qui trahit un compte jetable : récent, sans avatar, au pseudo généré.
 */
export function assessArrival(member: GuildMember, now = Date.now()): ArrivalAssessment {
  const reasons: string[] = [];
  let score = 0;
  const add = (points: number, reason: string) => {
    score += points;
    reasons.push(reason);
  };

  const ageMs = now - member.user.createdTimestamp;
  if (ageMs < DAY_MS) add(3, 'compte créé il y a moins d\'un jour');
  else if (ageMs < 7 * DAY_MS) add(2, 'compte créé il y a moins d\'une semaine');
  else if (ageMs < 30 * DAY_MS) add(1, 'compte créé il y a moins d\'un mois');

  if (!member.user.avatar) add(ageMs < 30 * DAY_MS ? 2 : 1, 'avatar par défaut');

  // Signalé comme spammeur par Discord lui-même.
  if (member.user.flags?.has(UserFlags.Spammer)) add(5, 'signalé comme spammeur par Discord');

  // Profil mis en quarantaine par l'AutoMod de Discord (pseudo, bio, tag).
  const quarantined = [
    GuildMemberFlags.AutomodQuarantinedUsernameOrGuildNickname,
    GuildMemberFlags.AutomodQuarantinedBio,
    GuildMemberFlags.AutoModQuarantinedGuildTag,
  ].some((flag) => member.flags.has(flag));
  if (quarantined) add(3, 'profil en quarantaine AutoMod Discord');

  const name = member.user.username.toLowerCase();
  // Pseudo généré : mot suivi d'une longue suite de chiffres, ou suite de
  // consonnes qu'aucune langue ne produit.
  if (/^[a-z._]+\d{4,}$/.test(name) || /\d{6,}/.test(name)) add(1, 'pseudo à suite de chiffres');
  if (/[bcdfghjklmnpqrstvwxz]{6,}/.test(name)) add(1, 'pseudo sans voyelles, généré');
  if (!member.user.globalName && ageMs < 30 * DAY_MS) add(1, 'aucun nom d\'affichage');

  return { suspicious: score >= SUSPICION_THRESHOLD, score, reasons };
}

export type CaptchaDecision = { challenge: boolean; frozen: boolean; reason: string };

export function decideCaptcha(member: GuildMember, config: RaidProtectionConfig): CaptchaDecision {
  const configured = Boolean(config.captchaChannelId && config.captchaUnverifiedRoleId);
  const raidCaptcha = config.raidModeActive && config.antiRaidAction === 'CAPTCHA';

  if (configured && config.shieldLevel <= 2) return { challenge: true, frozen: true, reason: `Shield ${config.shieldLevel} : captcha gelé` };
  if (configured && config.shieldLevel <= 3) return { challenge: true, frozen: false, reason: `Shield ${config.shieldLevel}` };
  if (!config.captchaEnabled && !raidCaptcha) return { challenge: false, frozen: false, reason: 'captcha désactivé' };
  if (raidCaptcha) return { challenge: true, frozen: false, reason: 'raid en cours' };

  switch (config.captchaTrigger) {
    case 'AUTO':
      return { challenge: config.raidModeActive, frozen: false, reason: config.raidModeActive ? 'raid en cours' : 'hors raid' };
    case 'SMART': {
      if (config.raidModeActive) return { challenge: true, frozen: false, reason: 'raid en cours' };
      // Un membre approuvé à la main par l'équipe n'est jamais suspect.
      if (config.accountAgeWhitelist.includes(member.id)) return { challenge: false, frozen: false, reason: 'approuvé par l\'équipe' };
      const assessment = assessArrival(member);
      return { challenge: assessment.suspicious, frozen: false, reason: assessment.suspicious ? `profil suspect : ${assessment.reasons.join(', ')}` : 'profil ordinaire' };
    }
    default:
      return { challenge: true, frozen: false, reason: 'captcha permanent' };
  }
}
