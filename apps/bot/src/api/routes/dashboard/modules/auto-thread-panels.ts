/** Routes dashboard des panneaux de discussion, rangés dans le module `auto-thread`. */
import { ChannelType, type Client } from 'discord.js';
import type { Prisma, ThreadPanel } from '@prisma/client';
import { THREAD_PANEL_LIMITS, normalizeThreadPanel, type ThreadPanelData, type ThreadPanelError } from '@kotbo/shared';
import prisma from '../../../../utils/db.js';
import { getGuildName, json, pushAudit, readJsonBody } from '../../../shared.js';
import { jsonFailure } from '../../../shared/failure.js';
import { publicErrorMessage } from '../../../../utils/publicError.js';
import { type ModuleRouteContext } from './_shared.js';
import { publishThreadPanel, unpublishThreadPanel } from '../../../../services/features/threadPanelService.js';

const PANEL_ERRORS: Record<ThreadPanelError, string> = {
  name_required: 'Donne un nom au panneau.',
  title_required: 'Donne un titre au message du panneau.',
  buttons_required: 'Ajoute au moins un bouton.',
  buttons_too_many: `${THREAD_PANEL_LIMITS.buttonsPerPanel} boutons au maximum par panneau.`,
  button_label_required: 'Un bouton n’a pas de texte.',
  fields_too_many: 'Trop de questions dans un formulaire : 4 au maximum, 3 si le membre choisit des tags.',
  field_label_required: 'Une question du formulaire n’a pas d’intitulé.',
  forum_channel_required: 'Un bouton « post de forum » doit viser un salon forum.',
  image_url_invalid: 'L’image doit être une adresse https.',
};

const TEXT_TYPES = new Set<ChannelType>([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const FORUM_TYPES = new Set<ChannelType>([ChannelType.GuildForum, ChannelType.GuildMedia]);

/** Les salons visés existent-ils et peuvent-ils accueillir ce type de fil ? */
function checkPanelChannels(client: Client, guildId: string, channelId: string, data: ThreadPanelData): string | null {
  const channels = client.guilds.cache.get(guildId)?.channels.cache;
  const type = (id: string) => channels?.get(id)?.type;
  const panelType = type(channelId);
  if (panelType === undefined || !TEXT_TYPES.has(panelType)) return 'Choisis un salon textuel ou d’annonces de ce serveur pour le panneau.';
  if (data.logChannelId && !TEXT_TYPES.has(type(data.logChannelId) as ChannelType)) return 'Le salon des journaux doit être un salon textuel de ce serveur.';

  for (const button of data.buttons) {
    const target = type(button.targetChannelId ?? channelId);
    if (button.target === 'forum' && !FORUM_TYPES.has(target as ChannelType)) return `« ${button.label} » doit viser un salon forum.`;
    if (button.target === 'public' && !TEXT_TYPES.has(target as ChannelType)) return `« ${button.label} » doit viser un salon textuel ou d’annonces.`;
    if (button.target === 'private' && target !== ChannelType.GuildText) return `« ${button.label} » : les fils privés n’existent que dans les salons textuels.`;
  }
  return null;
}

function toRow(data: ThreadPanelData) {
  return { ...data, buttons: data.buttons as unknown as Prisma.InputJsonValue };
}

async function withStats(rows: ThreadPanel[]) {
  const [total, open] = await Promise.all([
    prisma.panelThread.groupBy({ by: ['panelId'], where: { panelId: { in: rows.map((r) => r.id) } }, _count: true }),
    prisma.panelThread.groupBy({ by: ['panelId'], where: { panelId: { in: rows.map((r) => r.id) }, closedAt: null }, _count: true }),
  ]);
  const count = (list: typeof total, id: string) => list.find((entry) => entry.panelId === id)?._count ?? 0;
  return rows.map((row) => ({ ...row, stats: { total: count(total, row.id), open: count(open, row.id) } }));
}

export async function handleThreadPanelRoutes(ctx: ModuleRouteContext): Promise<boolean> {
  const { req, res, parts, client, guildId, method, auditUser } = ctx;
  if (parts[5] !== 'panels') return false;

  const audit = (action: string, details: string, channelId: string | null) => pushAudit(guildId, {
    user: auditUser,
    action,
    context: getGuildName(client, guildId),
    module: 'Auto-Thread',
    eventType: 'Manuel',
    details,
    channelId,
  });

  const readPanel = async () => {
    const body = await readJsonBody<Record<string, unknown>>(req);
    const channelId = typeof body?.channelId === 'string' ? body.channelId : '';
    const normalized = normalizeThreadPanel(body);
    if (!normalized.ok) return { error: PANEL_ERRORS[normalized.error] } as const;
    const problem = checkPanelChannels(client, guildId, channelId, normalized.value);
    if (problem) return { error: problem } as const;
    return { channelId, data: normalized.value } as const;
  };

  // GET /api/dashboard/guilds/:guildId/auto-thread/panels
  if (parts.length === 6 && method === 'GET') {
    try {
      const rows = await prisma.threadPanel.findMany({ where: { guildId }, orderBy: { createdAt: 'asc' } });
      // Les tags des forums : l'état du serveur ne les porte pas, et seuls les
      // boutons « post de forum » en ont besoin.
      const forums = [...(client.guilds.cache.get(guildId)?.channels.cache.values() ?? [])]
        .filter((channel) => channel.type === ChannelType.GuildForum || channel.type === ChannelType.GuildMedia)
        .map((channel) => ({
          id: channel.id,
          name: channel.name,
          tags: channel.availableTags.map((tag) => ({ id: tag.id, name: tag.name, emoji: tag.emoji?.name ?? null })),
        }));
      json(res, 200, { panels: await withStats(rows), forums });
    } catch (err) {
      jsonFailure(res, err, 'Erreur lors du chargement des panneaux', 'ThreadPanelAPI');
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/auto-thread/panels
  if (parts.length === 6 && method === 'POST') {
    try {
      const input = await readPanel();
      if ('error' in input) {
        json(res, 400, { error: input.error });
        return true;
      }
      if (await prisma.threadPanel.count({ where: { guildId } }) >= THREAD_PANEL_LIMITS.panelsPerGuild) {
        json(res, 400, { error: `Limite atteinte : ${THREAD_PANEL_LIMITS.panelsPerGuild} panneaux par serveur.` });
        return true;
      }
      const panel = await prisma.threadPanel.create({ data: { guildId, channelId: input.channelId, ...toRow(input.data) } });
      await audit('Création d’un panneau de discussion', `« ${panel.name} » dans le salon ${panel.channelId}.`, panel.channelId);
      json(res, 200, { ok: true, panel: (await withStats([panel]))[0] });
    } catch (err) {
      jsonFailure(res, err, 'Erreur lors de la création du panneau', 'ThreadPanelAPI');
    }
    return true;
  }

  const existing = parts[6] ? await prisma.threadPanel.findFirst({ where: { id: parts[6], guildId } }) : null;
  if (!existing) {
    json(res, 404, { error: 'Panneau introuvable' });
    return true;
  }

  // PUT /api/dashboard/guilds/:guildId/auto-thread/panels/:id
  if (parts.length === 7 && method === 'PUT') {
    try {
      const input = await readPanel();
      if ('error' in input) {
        json(res, 400, { error: input.error });
        return true;
      }
      // Changer de salon retire l'ancien message : il ouvrirait encore des fils.
      const moved = input.channelId !== existing.channelId;
      if (moved) await unpublishThreadPanel(client, existing);
      const panel = await prisma.threadPanel.update({
        where: { id: existing.id },
        data: { channelId: input.channelId, ...toRow(input.data), ...(moved ? { messageId: null } : {}) },
      });
      // Un panneau déjà publié reflète tout de suite la modification.
      let publishError: string | null = null;
      if (panel.messageId) {
        await publishThreadPanel(client, guildId, panel.id).catch((err: unknown) => {
          publishError = publicErrorMessage(err, 'Le message publié n’a pas pu être mis à jour.');
        });
      }
      await audit('Modification d’un panneau de discussion', `« ${panel.name} » (${panel.enabled ? 'actif' : 'désactivé'}).`, panel.channelId);
      json(res, 200, { ok: true, panel: (await withStats([panel]))[0], publishError });
    } catch (err) {
      jsonFailure(res, err, 'Erreur lors de l’enregistrement du panneau', 'ThreadPanelAPI');
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/auto-thread/panels/:id/publish
  if (parts.length === 8 && parts[7] === 'publish' && method === 'POST') {
    try {
      const messageId = await publishThreadPanel(client, guildId, existing.id);
      await audit('Publication d’un panneau de discussion', `« ${existing.name} » publié dans le salon ${existing.channelId}.`, existing.channelId);
      json(res, 200, { ok: true, messageId });
    } catch (err) {
      jsonFailure(res, err, 'Impossible de publier le panneau : vérifie que le bot peut écrire dans ce salon.', 'ThreadPanelAPI');
    }
    return true;
  }

  // DELETE /api/dashboard/guilds/:guildId/auto-thread/panels/:id
  if (parts.length === 7 && method === 'DELETE') {
    try {
      await unpublishThreadPanel(client, existing);
      await prisma.threadPanel.delete({ where: { id: existing.id } });
      await audit('Suppression d’un panneau de discussion', `« ${existing.name} » supprimé.`, existing.channelId);
      json(res, 200, { ok: true });
    } catch (err) {
      jsonFailure(res, err, 'Erreur lors de la suppression du panneau', 'ThreadPanelAPI');
    }
    return true;
  }

  return false;
}
