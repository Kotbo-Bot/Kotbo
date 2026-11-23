import { ActionRowBuilder, StringSelectMenuBuilder, type MessageActionRowComponentBuilder } from 'discord.js';
import prisma from '../../../utils/db.js';

/** Limite Discord : 25 options par menu. */
export const MAX_MENU_ITEMS = 25;
export const INFO_MENU_PREFIX = 'wfinfo';

export type InfoMenuItem = { label: string; text: string };

/**
 * Une entrée par ligne, « Libellé | Texte ». Les lignes sans séparateur, sans
 * libellé ou sans texte sont ignorées : le menu ne doit jamais empêcher l'envoi.
 */
export function parseInfoMenu(raw: unknown): InfoMenuItem[] {
  if (typeof raw !== 'string') return [];
  const items: InfoMenuItem[] = [];
  for (const line of raw.split('\n')) {
    const cut = line.indexOf('|');
    if (cut < 0) continue;
    const label = line.slice(0, cut).trim().slice(0, 100);
    // « \n » écrit littéralement dans le champ devient un retour à la ligne.
    const text = line.slice(cut + 1).trim().replace(/\\n/g, '\n').slice(0, 2000);
    if (label && text) items.push({ label, text });
    if (items.length === MAX_MENU_ITEMS) break;
  }
  return items;
}

export function infoMenuRow(workflowId: string, nodeId: string, items: InfoMenuItem[]) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${INFO_MENU_PREFIX}:${workflowId}:${nodeId}`)
    .setPlaceholder('Plus d’informations')
    .addOptions(items.map((item, index) => ({ label: item.label, value: String(index) })));
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu);
}

/**
 * Texte de l'entrée choisie, relu dans le graphe à chaque clic : modifier
 * l'automatisation met à jour les messages déjà publiés. Null si le
 * workflow, le nœud ou l'entrée n'existent plus (ou autre serveur).
 */
export async function resolveInfoMenuAnswer(guildId: string, customId: string, value: string): Promise<string | null> {
  const [, workflowId, nodeId] = customId.split(':');
  if (!workflowId || !nodeId) return null;
  const workflow = await prisma.workflow.findUnique({ where: { id: workflowId }, select: { guildId: true, graph: true } });
  if (!workflow || workflow.guildId !== guildId) return null;
  const nodes = (workflow.graph as { nodes?: Array<{ id: string; type: string; config?: Record<string, unknown> }> } | null)?.nodes ?? [];
  const node = nodes.find((n) => n.id === nodeId && n.type === 'SendEmbed');
  const index = Number(value);
  if (!node || !Number.isInteger(index)) return null;
  return parseInfoMenu(node.config?.infoMenu)[index]?.text ?? null;
}
