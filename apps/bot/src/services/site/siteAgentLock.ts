/**
 * Verrou « un agent modifie le site ».
 *
 * Quand un agent MCP écrit sur le site d'un serveur, il prend la main sur tout
 * le site : l'éditeur des humains passe en lecture seule, l'API d'édition et
 * le serveur d'édition à plusieurs refusent leurs écritures. Le verrou se
 * relâche de lui-même après `AGENT_IDLE_MS` sans action de l'agent, ou quand
 * l'agent le rend.
 *
 * Un humain qui a le droit de gérer le site peut l'interrompre à tout moment,
 * depuis le dashboard ou depuis le site publié : le verrou tombe, et l'agent
 * ne peut plus écrire sur ce site pendant `INTERRUPT_BLOCK_MS`, ou jusqu'à ce
 * qu'un humain l'y autorise de nouveau.
 *
 * L'état vit en mémoire : la production tourne en un seul processus, et un
 * redémarrage qui le perd ne fait que relâcher le verrou.
 */

import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

export const AGENT_IDLE_MS = 90_000;
export const INTERRUPT_BLOCK_MS = 15 * 60_000;

interface AgentSession {
  keyName: string;
  startedAt: number;
  lastActivityAt: number;
  /** Ce que l'agent est en train de faire, pour le bandeau. */
  activity: string;
  pageIds: Set<string>;
}

interface Interruption {
  byUserId: string;
  byName: string;
  at: number;
  until: number;
}

const sessions = new Map<string, AgentSession>();
const interruptions = new Map<string, Interruption>();

export class AgentLockError extends Error {
  constructor(
    public readonly code: 'interrupted',
    public readonly byName: string,
    public readonly until: number,
  ) {
    super(code);
  }
}

function activeSession(guildId: string, now = Date.now()): AgentSession | null {
  const session = sessions.get(guildId);
  if (!session) return null;
  if (now - session.lastActivityAt > AGENT_IDLE_MS) {
    sessions.delete(guildId);
    return null;
  }
  return session;
}

function activeInterruption(guildId: string, now = Date.now()): Interruption | null {
  const interruption = interruptions.get(guildId);
  if (!interruption) return null;
  if (now > interruption.until) {
    interruptions.delete(guildId);
    return null;
  }
  return interruption;
}

/**
 * L'agent prend (ou garde) la main avant une écriture. Lève `AgentLockError`
 * si un humain l'a interrompu sur ce site.
 */
export function beginAgentWrite(guildId: string, keyName: string, activity: string, pageId?: string | null): void {
  const now = Date.now();
  const interruption = activeInterruption(guildId, now);
  if (interruption) throw new AgentLockError('interrupted', interruption.byName, interruption.until);
  const session = activeSession(guildId, now) ?? { keyName, startedAt: now, lastActivityAt: now, activity, pageIds: new Set<string>() };
  session.keyName = keyName;
  session.lastActivityAt = now;
  session.activity = activity.slice(0, 160);
  if (pageId) session.pageIds.add(pageId);
  sessions.set(guildId, session);
}

/** L'agent rend la main. */
export function releaseAgentLock(guildId: string): boolean {
  return sessions.delete(guildId);
}

export interface AgentLockStatus {
  active: boolean;
  keyName: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  activity: string | null;
  pageIds: string[];
  interrupted: { byName: string; at: string; until: string } | null;
}

export function getAgentLockStatus(guildId: string): AgentLockStatus {
  const session = activeSession(guildId);
  const interruption = activeInterruption(guildId);
  return {
    active: Boolean(session),
    keyName: session?.keyName ?? null,
    startedAt: session ? new Date(session.startedAt).toISOString() : null,
    lastActivityAt: session ? new Date(session.lastActivityAt).toISOString() : null,
    activity: session?.activity ?? null,
    pageIds: session ? [...session.pageIds] : [],
    interrupted: interruption
      ? { byName: interruption.byName, at: new Date(interruption.at).toISOString(), until: new Date(interruption.until).toISOString() }
      : null,
  };
}

/** Le site est-il verrouillé par un agent (les écritures humaines attendent) ? */
export function isSiteAgentLocked(guildId: string): boolean {
  return Boolean(activeSession(guildId));
}

/** Un humain reprend la main : le verrou tombe et l'agent est tenu à l'écart. */
export async function interruptAgent(guildId: string, user: { id: string; name: string }): Promise<AgentLockStatus> {
  const session = activeSession(guildId);
  sessions.delete(guildId);
  const now = Date.now();
  interruptions.set(guildId, { byUserId: user.id, byName: user.name, at: now, until: now + INTERRUPT_BLOCK_MS });
  await prisma.dashboardAuditLog
    .create({
      data: {
        guildId,
        user: user.name,
        action: "Agent interrompu sur le site",
        context: session ? `Clé MCP « ${session.keyName} »` : 'Aucun agent actif',
        module: 'Site',
        eventType: 'Modification',
        details: `L'agent ne peut plus modifier le site pendant ${Math.round(INTERRUPT_BLOCK_MS / 60_000)} minutes, sauf nouvelle autorisation.`,
        dateIso: new Date(),
      },
    })
    .catch((err) => logger.warn('SiteAgent', `Journal d'interruption impossible sur ${guildId} :`, err));
  return getAgentLockStatus(guildId);
}

/** Lever l'interdiction posée par une interruption. */
export function allowAgentAgain(guildId: string): AgentLockStatus {
  interruptions.delete(guildId);
  return getAgentLockStatus(guildId);
}
