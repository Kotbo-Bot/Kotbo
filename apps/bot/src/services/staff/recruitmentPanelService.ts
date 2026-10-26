/**
 * Panneaux « statut des recrutements » et fermeture automatique des postes.
 *
 * Un poste (formulaire de recrutement) se ferme seul a X candidatures en
 * attente ou a X recrues, et se rouvre quand la cause disparait. Chaque
 * changement d'etat re-rend les panneaux Discord qui affichent ce poste.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, SeparatorBuilder, TextDisplayBuilder } from 'discord.js';
import type { RecruitmentPanel } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getClient } from '../../utils/client.js';
import { getDashboardUrl } from '../../api/shared.js';
import { COLORS_RAW, v2 } from '../../utils/embeds.js';
import { UserFacingError } from '../../utils/userFacingError.js';
import { decideFormAvailability } from './recruitmentFormAvailability.js';

/** Boutons « Postuler » par panneau : au-dela, le message depasse les limites Discord. */
const MAX_APPLY_BUTTONS = 20;

/**
 * Recalcule l'ouverture d'un poste apres une candidature recue, tranchee ou
 * supprimee, ou apres un changement de plafond. Ne leve jamais : l'appelant a
 * deja fait son travail, la fermeture automatique n'est qu'une consequence.
 */
export async function syncRecruitmentFormAvailability(formId: string | null | undefined): Promise<void> {
  if (!formId) return;
  try {
    const form = await prisma.customForm.findUnique({
      where: { id: formId },
      select: {
        guildId: true, isRecruitment: true, isActive: true, autoClosedReason: true,
        maxPendingCandidatures: true, maxAcceptedCandidatures: true, acceptedCapMode: true, acceptedCount: true,
      },
    });
    if (!form?.isRecruitment) return;
    if (form.maxPendingCandidatures === null && form.maxAcceptedCandidatures === null && !form.autoClosedReason) return;

    const [pending, accepted] = await Promise.all([
      prisma.recruitmentCandidature.count({ where: { customFormId: formId, status: 'PENDING' } }),
      form.acceptedCapMode === 'TOTAL'
        ? prisma.recruitmentCandidature.count({ where: { customFormId: formId, status: 'APPROVED' } })
        : Promise.resolve(form.acceptedCount),
    ]);

    const next = decideFormAvailability({
      isActive: form.isActive,
      autoClosedReason: form.autoClosedReason,
      pending,
      accepted,
      maxPending: form.maxPendingCandidatures,
      maxAccepted: form.maxAcceptedCandidatures,
    });
    if (next.isActive === form.isActive && next.autoClosedReason === form.autoClosedReason) return;

    await prisma.customForm.update({ where: { id: formId }, data: next });
    logger.info('RecruitmentPanel', `Poste ${formId} ${next.isActive ? 'rouvert' : `fermé (${next.autoClosedReason})`} automatiquement`);
    await refreshRecruitmentPanels(form.guildId, formId);
  } catch (err) {
    logger.error('RecruitmentPanel', `Fermeture automatique du poste ${formId} non appliquée`, err);
  }
}

/** Une recrue de plus sur ce poste, puis recalcul de son ouverture. */
export async function recordAcceptedCandidature(formId: string | null | undefined): Promise<void> {
  if (!formId) return;
  await prisma.customForm.update({ where: { id: formId }, data: { acceptedCount: { increment: 1 } } }).catch(() => null);
  await syncRecruitmentFormAvailability(formId);
}

async function renderPanel(panel: RecruitmentPanel) {
  const found = await prisma.customForm.findMany({
    where: { id: { in: panel.formIds }, guildId: panel.guildId, isRecruitment: true },
    select: { id: true, name: true, isActive: true },
  });
  // L'ordre choisi au dashboard, pas celui de la base ; un poste supprime disparait.
  const forms = panel.formIds.flatMap((id) => found.filter((f) => f.id === id));
  const open = forms.filter((f) => f.isActive);

  const container = new ContainerBuilder()
    .setAccentColor(open.length > 0 ? COLORS_RAW.success : COLORS_RAW.danger)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`### → ${panel.title}\n**STATUT DES RECRUTEMENTS**`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      forms.length > 0
        ? forms.map((f) => `→ **${f.name}**\nSTATUT : ${f.isActive ? 'OPEN ✅' : 'CLOSED ❌'}`).join('\n\n')
        : '*Aucun poste dans ce panneau.*',
    ));

  const base = getDashboardUrl().replace(/\/$/, '');
  const buttons = open.slice(0, MAX_APPLY_BUTTONS).map((f) =>
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(`Postuler · ${f.name}`.slice(0, 80)).setURL(`${base}/form/${f.id}`));
  for (let i = 0; i < buttons.length; i += 5) {
    container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
  }

  return { ...v2(container), allowedMentions: { parse: [] } };
}

/** Poste le panneau, ou edite son message s'il existe encore. */
export async function publishRecruitmentPanel(panelId: string): Promise<RecruitmentPanel> {
  const panel = await prisma.recruitmentPanel.findUnique({ where: { id: panelId } });
  if (!panel) throw new UserFacingError('Panneau introuvable.');

  const channel = await getClient().channels.fetch(panel.channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !channel.isSendable()) {
    throw new UserFacingError('Salon introuvable, ou le bot ne peut pas y écrire.');
  }

  const payload = await renderPanel(panel);
  if (panel.messageId) {
    const message = await channel.messages.fetch(panel.messageId).catch(() => null);
    if (message) {
      await message.edit(payload);
      return panel;
    }
  }

  const sent = await channel.send(payload);
  return prisma.recruitmentPanel.update({ where: { id: panel.id }, data: { messageId: sent.id } });
}

/**
 * Cree ou modifie un panneau puis le publie. Le salon doit appartenir au
 * serveur, et seuls ses formulaires de recrutement sont retenus.
 */
export async function saveRecruitmentPanel(
  guildId: string,
  body: { channelId?: unknown; title?: unknown; formIds?: unknown },
  panelId?: string,
): Promise<RecruitmentPanel> {
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 100) : '';
  if (!title) throw new UserFacingError('Le titre du panneau est obligatoire.');

  const channelId = typeof body.channelId === 'string' ? body.channelId.trim() : '';
  const channel = /^\d{15,25}$/.test(channelId) ? await getClient().channels.fetch(channelId).catch(() => null) : null;
  if (!channel || !('guildId' in channel) || channel.guildId !== guildId) throw new UserFacingError('Salon introuvable sur ce serveur.');

  const wanted = Array.isArray(body.formIds) ? body.formIds.filter((id): id is string => typeof id === 'string').slice(0, 25) : [];
  const valid = new Set((await prisma.customForm.findMany({
    where: { id: { in: wanted }, guildId, isRecruitment: true },
    select: { id: true },
  })).map((f) => f.id));
  const formIds = wanted.filter((id) => valid.has(id));

  let panel: RecruitmentPanel;
  if (panelId) {
    const existing = await prisma.recruitmentPanel.findFirst({ where: { id: panelId, guildId } });
    if (!existing) throw new UserFacingError('Panneau introuvable.');
    // Changer de salon : l'ancien message est retire, un nouveau est poste.
    if (existing.channelId !== channelId) await deletePanelMessage(existing);
    panel = await prisma.recruitmentPanel.update({
      where: { id: panelId },
      data: { title, channelId, formIds, ...(existing.channelId !== channelId ? { messageId: null } : {}) },
    });
  } else {
    panel = await prisma.recruitmentPanel.create({ data: { guildId, channelId, title, formIds } });
  }
  return publishRecruitmentPanel(panel.id);
}

export async function deleteRecruitmentPanel(guildId: string, panelId: string): Promise<boolean> {
  const panel = await prisma.recruitmentPanel.findFirst({ where: { id: panelId, guildId } });
  if (!panel) return false;
  await deletePanelMessage(panel);
  await prisma.recruitmentPanel.delete({ where: { id: panel.id } });
  return true;
}

async function deletePanelMessage(panel: RecruitmentPanel): Promise<void> {
  if (!panel.messageId) return;
  const channel = await getClient().channels.fetch(panel.channelId).catch(() => null);
  if (channel?.isTextBased()) await channel.messages.delete(panel.messageId).catch(() => null);
}

/** Re-rend les panneaux du serveur, ou seulement ceux qui affichent ce poste. */
export async function refreshRecruitmentPanels(guildId: string, formId?: string): Promise<void> {
  const panels = await prisma.recruitmentPanel.findMany({
    where: { guildId, ...(formId ? { formIds: { has: formId } } : {}) },
    select: { id: true },
  });
  for (const panel of panels) {
    await publishRecruitmentPanel(panel.id).catch((err) =>
      logger.error('RecruitmentPanel', `Panneau ${panel.id} non rafraîchi`, err));
  }
}
