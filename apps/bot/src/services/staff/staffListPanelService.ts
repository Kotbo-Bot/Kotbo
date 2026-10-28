/**
 * Panneaux Discord listant le staff par grade : « ## grade » puis une ligne
 * « - @membre » par personne. Les grades viennent du module Staff (StaffRole),
 * du plus haut niveau au plus bas ; les membres suspendus n'y figurent pas.
 *
 * Les changements de grade passent par trop de chemins pour etre tous suivis :
 * un balayage periodique re-rend les panneaux, et n'edite le message que si
 * son contenu a change.
 */
import { createHash } from 'node:crypto';
import { ContainerBuilder, SeparatorBuilder, TextDisplayBuilder } from 'discord.js';
import type { StaffListPanel } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getClient } from '../../utils/client.js';
import { COLORS_RAW, v2 } from '../../utils/embeds.js';
import { UserFacingError } from '../../utils/userFacingError.js';
import { deletePanelMessage, isGuildChannel, upsertPanelMessage } from '../../utils/panelMessage.js';

export type StaffListGrade = { name: string; discordRoleId: string | null; userIds: string[] };

/** Limite du texte d'un message en composants V2, avec une marge pour le titre. */
const MAX_LIST_LENGTH = 3800;

/** Texte du panneau, grade par grade. Les grades sans membre sont omis. */
export function formatStaffList(grades: StaffListGrade[], maxLength = MAX_LIST_LENGTH): string {
  const text = grades
    .filter((g) => g.userIds.length > 0)
    .map((g) => `## ${g.discordRoleId ? `<@&${g.discordRoleId}>` : g.name}\n${g.userIds.map((id) => `- <@${id}>`).join('\n')}`)
    .join('\n\n');
  if (!text) return "*Aucun membre du staff pour l'instant.*";
  // shortcut: au-dela de la limite d'un message, la liste est coupee ; la repartir sur plusieurs messages si un serveur la depasse.
  return text.length <= maxLength ? text : `${text.slice(0, text.lastIndexOf('\n', maxLength))}\n…`;
}

async function loadGrades(panel: StaffListPanel): Promise<StaffListGrade[]> {
  const [roles, members] = await Promise.all([
    prisma.staffRole.findMany({
      where: { guildId: panel.guildId, enabled: true, ...(panel.hierarchyId ? { hierarchyId: panel.hierarchyId } : {}) },
      orderBy: [{ level: 'desc' }, { sortOrder: 'asc' }],
      select: { name: true, discordRoleId: true },
    }),
    prisma.staffMember.findMany({
      where: { guildId: panel.guildId, suspendedAt: null },
      orderBy: { joinedStaffAt: 'asc' },
      select: {
        userId: true,
        grade: true,
        hierarchyGrades: { where: { hierarchyId: panel.hierarchyId ?? '' }, select: { grade: true } },
      },
    }),
  ]);

  // Dans une hierarchie, le grade qui compte est celui tenu dans cette hierarchie.
  const gradeOf = (m: (typeof members)[number]) => (panel.hierarchyId ? m.hierarchyGrades[0]?.grade : m.grade);
  return roles.map((role) => ({
    name: role.name,
    discordRoleId: role.discordRoleId,
    userIds: members.filter((m) => gradeOf(m) === role.name).map((m) => m.userId),
  }));
}

/** Re-rend le panneau ; sans `force`, n'edite rien si le contenu n'a pas change. */
export async function publishStaffListPanel(panelId: string, force = false): Promise<StaffListPanel> {
  const panel = await prisma.staffListPanel.findUnique({ where: { id: panelId } });
  if (!panel) throw new UserFacingError('Panneau introuvable.');

  const list = formatStaffList(await loadGrades(panel));
  const renderHash = createHash('sha1').update(`${panel.title}\n${list}`).digest('hex');
  if (!force && panel.messageId && renderHash === panel.renderHash) return panel;

  const container = new ContainerBuilder()
    .setAccentColor(COLORS_RAW.primary)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${panel.title}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(list));

  const messageId = await upsertPanelMessage(panel.channelId, panel.messageId, { ...v2(container), allowedMentions: { parse: [] } });
  return prisma.staffListPanel.update({ where: { id: panel.id }, data: { messageId, renderHash } });
}

export async function saveStaffListPanel(
  guildId: string,
  body: { channelId?: unknown; title?: unknown; hierarchyId?: unknown },
  panelId?: string,
): Promise<StaffListPanel> {
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 100) : '';
  if (!title) throw new UserFacingError('Le titre du panneau est obligatoire.');

  const channelId = typeof body.channelId === 'string' ? body.channelId.trim() : '';
  if (!(await isGuildChannel(guildId, channelId))) throw new UserFacingError('Salon introuvable sur ce serveur.');

  const hierarchyId = typeof body.hierarchyId === 'string' && body.hierarchyId ? body.hierarchyId : null;
  if (hierarchyId && !(await prisma.staffHierarchy.findFirst({ where: { id: hierarchyId, guildId }, select: { id: true } }))) {
    throw new UserFacingError('Hiérarchie introuvable sur ce serveur.');
  }

  let panel: StaffListPanel;
  if (panelId) {
    const existing = await prisma.staffListPanel.findFirst({ where: { id: panelId, guildId } });
    if (!existing) throw new UserFacingError('Panneau introuvable.');
    const moved = existing.channelId !== channelId;
    if (moved) await deletePanelMessage(existing.channelId, existing.messageId);
    panel = await prisma.staffListPanel.update({
      where: { id: panelId },
      data: { title, channelId, hierarchyId, ...(moved ? { messageId: null } : {}) },
    });
  } else {
    panel = await prisma.staffListPanel.create({ data: { guildId, channelId, title, hierarchyId } });
  }
  return publishStaffListPanel(panel.id, true);
}

export async function deleteStaffListPanel(guildId: string, panelId: string): Promise<boolean> {
  const panel = await prisma.staffListPanel.findFirst({ where: { id: panelId, guildId } });
  if (!panel) return false;
  await deletePanelMessage(panel.channelId, panel.messageId);
  await prisma.staffListPanel.delete({ where: { id: panel.id } });
  return true;
}

/** Balayage periodique : les panneaux des serveurs tenus par ce processus. */
export async function refreshStaffListPanels(): Promise<void> {
  const guildIds = [...getClient().guilds.cache.keys()];
  const panels = await prisma.staffListPanel.findMany({ where: { guildId: { in: guildIds } }, select: { id: true } });
  for (const panel of panels) {
    await publishStaffListPanel(panel.id).catch((err) =>
      logger.error('StaffListPanel', `Panneau ${panel.id} non rafraîchi`, err));
  }
}
