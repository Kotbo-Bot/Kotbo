/**
 * autoSanction.ts - Sanction choisie dans une configuration, appliquée par un
 * filtre automatique (Kotbo Vision, Autres serveurs, Extensions de fichiers…).
 *
 * Chaque filtre stocke une action (DELETE, WARN, TIMEOUT, KICK, SOFTBAN, BAN,
 * JAIL) et une durée ; ce module fait le reste : action Discord, inscription
 * au casier, repli quand l'action n'est pas possible, et limite d'une sanction
 * par minute et par membre, pour qu'une rafale de messages refusés ne
 * produise pas une rafale de sanctions.
 */

import type { Client, Guild, GuildMember, User } from 'discord.js';
import { logger } from '../../utils/logger.js';
import {
  registerBanSanction,
  registerJailSanction,
  registerKickSanction,
  registerSoftbanSanction,
  registerTimeoutSanction,
  registerWarnSanction,
} from './sanctionService.js';
import { isJailConfigured, type JailSource } from './jailService.js';

export const AUTO_SANCTIONS = ['DELETE', 'WARN', 'TIMEOUT', 'KICK', 'SOFTBAN', 'BAN', 'JAIL'] as const;
export type AutoSanction = (typeof AUTO_SANCTIONS)[number];

export function normalizeAutoSanction(value: unknown, fallback: AutoSanction = 'DELETE'): AutoSanction {
  return AUTO_SANCTIONS.includes(value as AutoSanction) ? (value as AutoSanction) : fallback;
}

/** Durée maximale d'un timeout Discord. */
const MAX_TIMEOUT_MIN = 28 * 24 * 60 - 1;
const DEFAULT_TIMEOUT_MIN = 60;
const RATE_LIMIT_MS = 60_000;

const lastSanctionAt = new Map<string, number>();

/** Libellé lisible, pour les logs et les messages au membre. */
export function autoSanctionLabel(action: AutoSanction, durationMin: number | null): string {
  const duration = durationMin ? ` ${formatMinutes(durationMin)}` : action === 'BAN' || action === 'JAIL' ? ' permanent' : '';
  return {
    DELETE: 'Message supprimé',
    WARN: 'Avertissement',
    TIMEOUT: `Timeout${duration}`,
    KICK: 'Expulsion',
    SOFTBAN: 'Softban',
    BAN: `Bannissement${duration}`,
    JAIL: `Quarantaine${duration}`,
  }[action];
}

export function formatMinutes(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} j`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

export type AutoSanctionResult = {
  /** Action réellement appliquée (après repli éventuel). */
  applied: AutoSanction;
  /** false si la limite d'une sanction par minute l'a empêchée. */
  done: boolean;
};

/**
 * Applique la sanction configurée. Ne lève jamais : un échec Discord
 * (hiérarchie, permission) est journalisé et la sanction ignorée, le message
 * fautif ayant déjà été supprimé par l'appelant.
 */
export async function applyAutoSanction(params: {
  client: Client;
  guild: Guild;
  user: User;
  member: GuildMember | null;
  action: AutoSanction;
  durationMin: number | null;
  reason: string;
  jailSource?: JailSource;
  evidenceLinks?: string[];
}): Promise<AutoSanctionResult> {
  let action = params.action;
  if (action === 'DELETE') return { applied: action, done: true };

  const key = `${params.guild.id}:${params.user.id}`;
  const last = lastSanctionAt.get(key);
  if (last && Date.now() - last < RATE_LIMIT_MS) return { applied: action, done: false };
  lastSanctionAt.set(key, Date.now());
  if (lastSanctionAt.size > 5000) {
    for (const [k, at] of lastSanctionAt) if (Date.now() - at > RATE_LIMIT_MS) lastSanctionAt.delete(k);
  }

  // Sans rôle Jail, la quarantaine devient un timeout : c'est la mesure la
  // plus proche qui ne fasse pas sortir le membre du serveur.
  if (action === 'JAIL' && !(await isJailConfigured(params.guild))) action = 'TIMEOUT';

  const target = { id: params.user.id, tag: params.user.tag };
  const moderator = { id: params.client.user!.id, tag: params.client.user!.tag };
  const base = { guildId: params.guild.id, target, moderator, reason: params.reason, client: params.client, evidenceLinks: params.evidenceLinks };
  const auditReason = params.reason.slice(0, 400);

  try {
    switch (action) {
      case 'WARN':
        await registerWarnSanction(base);
        break;
      case 'TIMEOUT': {
        if (!params.member?.moderatable) return { applied: action, done: false };
        const minutes = Math.min(params.durationMin ?? DEFAULT_TIMEOUT_MIN, MAX_TIMEOUT_MIN);
        await registerTimeoutSanction({ ...base, durationMs: minutes * 60_000, member: params.member });
        break;
      }
      case 'KICK':
        if (!params.member?.kickable) return { applied: action, done: false };
        await params.member.kick(auditReason);
        await registerKickSanction(base);
        break;
      case 'SOFTBAN':
        await params.guild.members.ban(params.user.id, { deleteMessageSeconds: 24 * 3600, reason: auditReason });
        await params.guild.members.unban(params.user.id, 'Softban : levée immédiate').catch(() => null);
        await registerSoftbanSanction(base);
        break;
      case 'BAN':
        await params.guild.members.ban(params.user.id, { deleteMessageSeconds: 3600, reason: auditReason });
        await registerBanSanction({ ...base, temporaryDurationMs: params.durationMin ? params.durationMin * 60_000 : undefined });
        break;
      case 'JAIL':
        if (!params.member?.manageable) return { applied: action, done: false };
        await registerJailSanction({
          ...base,
          member: params.member,
          durationMs: params.durationMin ? params.durationMin * 60_000 : null,
          source: params.jailSource,
        });
        break;
    }
    return { applied: action, done: true };
  } catch (err) {
    logger.warn('AutoSanction', `${action} impossible pour ${params.user.id} (${params.guild.id}): ${String(err)}`);
    return { applied: action, done: false };
  }
}
