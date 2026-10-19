import { ChannelType, type Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { publishOrUpdateRegulationMessage } from '../staff/regulationService.js';
import { sendTicketSetupEmbed } from '../features/ticketService.js';
import { sendOrUpdateMenuMessage } from '../features/reactionRoleService.js';
import { planifierRafraichissementPanneau, tempChannels } from '../../events/tempVoice.js';

/**
 * Re-publication des panneaux persistants apres un changement de langue.
 *
 * Un panneau n'est « rerenderable » que s'il est publie durablement dans un
 * salon *et* qu'un service expose une fonction de re-publication idempotente.
 * Les panneaux de configuration (`/config`, `/setup`) sont des reponses
 * ephemeres a une interaction : ils se re-affichent deja dans la bonne langue
 * a la prochaine ouverture, il n'y a rien a re-poster.
 */

/** Identifiants stables, utilises dans les rapports rendus a l'utilisateur. */
export type RerenderablePanel = 'regulation' | 'tickets' | 'reactionRoles' | 'tempVoice';

export interface PanelRerenderOutcome {
  panel: RerenderablePanel;
  /** `skipped` = panneau jamais publie sur ce serveur, donc rien a refaire. */
  status: 'updated' | 'skipped' | 'failed';
  /** Nombre de messages re-postes (pertinent pour les menus d'auto-roles). */
  count: number;
  error?: string;
}

export interface PanelRerenderReport {
  outcomes: PanelRerenderOutcome[];
  updated: number;
  skipped: number;
  failed: number;
}

async function rerenderRegulation(client: Client, guildId: string): Promise<PanelRerenderOutcome> {
  const guild = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { regulationMessageId: true },
  });
  if (!guild?.regulationMessageId) {
    return { panel: 'regulation', status: 'skipped', count: 0 };
  }

  try {
    const result = await publishOrUpdateRegulationMessage(client, guildId);
    return { panel: 'regulation', status: 'updated', count: Math.max(result.messageIds.length, 1) };
  } catch (error) {
    logger.warn(`[panelRerender] Reglement non re-publie pour ${guildId}`, error);
    return {
      panel: 'regulation',
      status: 'failed',
      count: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function rerenderTickets(client: Client, guildId: string): Promise<PanelRerenderOutcome> {
  const guild = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { ticketChannelId: true },
  });
  if (!guild?.ticketChannelId) {
    return { panel: 'tickets', status: 'skipped', count: 0 };
  }

  try {
    await sendTicketSetupEmbed(client, guildId);
    return { panel: 'tickets', status: 'updated', count: 1 };
  } catch (error) {
    logger.warn(`[panelRerender] Panneau tickets non re-publie pour ${guildId}`, error);
    return {
      panel: 'tickets',
      status: 'failed',
      count: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function rerenderReactionRoles(client: Client, guildId: string): Promise<PanelRerenderOutcome> {
  const menus = await prisma.reactionRoleMenu.findMany({
    where: { guildId },
    select: { id: true },
  });
  if (menus.length === 0) {
    return { panel: 'reactionRoles', status: 'skipped', count: 0 };
  }

  let count = 0;
  let lastError: string | undefined;
  for (const menu of menus) {
    try {
      await sendOrUpdateMenuMessage(client, menu.id);
      count++;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      logger.warn(`[panelRerender] Menu d'auto-roles ${menu.id} non re-publie`, error);
    }
  }

  if (count === 0) {
    return { panel: 'reactionRoles', status: 'failed', count: 0, error: lastError };
  }
  return { panel: 'reactionRoles', status: 'updated', count };
}

/**
 * Réécrit sur place le panneau de chaque salon vocal temporaire du serveur : il
 * relit la langue à chaque rendu, il suffit donc de le redessiner. Passe par
 * l'anti-rebond du panneau (une réécriture par seconde et par salon). Rend le
 * nombre de panneaux planifiés.
 */
export function rafraichirPanneauxVocaux(client: Client, guildId: string): number {
  const salons = client.guilds.cache.get(guildId)?.channels.cache;
  let planifies = 0;
  for (const id of tempChannels.keys()) {
    const salon = salons?.get(id);
    if (salon?.type !== ChannelType.GuildVoice) continue;
    planifierRafraichissementPanneau(salon);
    planifies += 1;
  }
  return planifies;
}

/**
 * Re-publie tous les panneaux persistants du serveur dans la langue courante.
 *
 * Chaque panneau est traite independamment : un echec n'interrompt pas les
 * autres, il est simplement remonte dans le rapport.
 */
export async function rerenderPersistentPanels(client: Client, guildId: string): Promise<PanelRerenderReport> {
  const outcomes = [
    await rerenderRegulation(client, guildId),
    await rerenderTickets(client, guildId),
    await rerenderReactionRoles(client, guildId),
    (() => {
      const count = rafraichirPanneauxVocaux(client, guildId);
      return { panel: 'tempVoice', status: count ? 'updated' : 'skipped', count } as PanelRerenderOutcome;
    })(),
  ];

  return {
    outcomes,
    updated: outcomes.filter((o) => o.status === 'updated').length,
    skipped: outcomes.filter((o) => o.status === 'skipped').length,
    failed: outcomes.filter((o) => o.status === 'failed').length,
  };
}
