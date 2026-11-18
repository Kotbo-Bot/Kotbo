/** Routes dashboard des panneaux de discussion, rangés dans le module `auto-thread`. */
import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { ChannelType, type Client } from 'discord.js';
import type { Prisma, ThreadPanel } from '@prisma/client';
import { THREAD_PANEL_LIMITS, normalizeThreadPanel, type ThreadPanelData, type ThreadPanelError } from '@kotbo/shared';
import prisma from '../../../../utils/db.js';
import { getGuildName, pushAudit } from '../../../shared.js';
import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
import { publicErrorMessage } from '../../../../utils/publicError.js';
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

export function createThreadPanelsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);

  const helpers = (c: Context) => {
    const guildId = c.req.param('guildId')!;
    return {
      audit: (action: string, details: string, channelId: string | null) => pushAudit(guildId, {
        user: auditUserOf(c),
        action,
        context: getGuildName(client, guildId),
        module: 'Auto-Thread',
        eventType: 'Manuel',
        details,
        channelId,
      }),
      readPanel: async () => {
        const body = await readBody(c);
        const channelId = typeof body?.channelId === 'string' ? body.channelId : '';
        const normalized = normalizeThreadPanel(body);
        if (!normalized.ok) return { error: PANEL_ERRORS[normalized.error] } as const;
        const problem = checkPanelChannels(client, guildId, channelId, normalized.value);
        if (problem) return { error: problem } as const;
        return { channelId, data: normalized.value } as const;
      },
    };
  };

  /** Le panneau visé, limité au serveur ouvert. */
  const ownedPanel = createMiddleware<{ Variables: { existing: ThreadPanel } }>(async (c, next) => {
    const existing = await prisma.threadPanel.findFirst({ where: { id: c.req.param('id'), guildId: c.req.param('guildId') } });
    if (!existing) return send(c, { error: 'Panneau introuvable' }, 404);
    c.set('existing', existing);
    await next();
  });
  const ownedGate = [...gate, ownedPanel] as const;



  router.get(`${base}/auto-thread/panels`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
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
      return send(c, { panels: await withStats(rows), forums });
    } catch (err) {
      return fail(c, err, 'Erreur lors du chargement des panneaux', 'ThreadPanelAPI');
    }
  });

  router.post(`${base}/auto-thread/panels`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const { audit, readPanel } = helpers(c);
    try {
      const input = await readPanel();
      if ('error' in input) {
        return send(c, { error: input.error }, 400);
      }
      if (await prisma.threadPanel.count({ where: { guildId } }) >= THREAD_PANEL_LIMITS.panelsPerGuild) {
        return send(c, { error: `Limite atteinte : ${THREAD_PANEL_LIMITS.panelsPerGuild} panneaux par serveur.` }, 400);
      }
      const panel = await prisma.threadPanel.create({ data: { guildId, channelId: input.channelId, ...toRow(input.data) } });
      await audit('Création d’un panneau de discussion', `« ${panel.name} » dans le salon ${panel.channelId}.`, panel.channelId);
      return send(c, { ok: true, panel: (await withStats([panel]))[0] });
    } catch (err) {
      return fail(c, err, 'Erreur lors de la création du panneau', 'ThreadPanelAPI');
    }
  });

  router.put(`${base}/auto-thread/panels/:id`, ...ownedGate, async (c) => {
    const existing = c.var.existing;
    const guildId = c.req.param('guildId');
    const id = c.req.param('id');
    const { audit, readPanel } = helpers(c);
    try {
      const input = await readPanel();
      if ('error' in input) {
        return send(c, { error: input.error }, 400);
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
      return send(c, { ok: true, panel: (await withStats([panel]))[0], publishError });
    } catch (err) {
      return fail(c, err, 'Erreur lors de l’enregistrement du panneau', 'ThreadPanelAPI');
    }
  });

  router.post(`${base}/auto-thread/panels/:id/publish`, ...ownedGate, async (c) => {
    const existing = c.var.existing;
    const guildId = c.req.param('guildId');
    const id = c.req.param('id');
    const { audit } = helpers(c);
    try {
      const messageId = await publishThreadPanel(client, guildId, existing.id);
      await audit('Publication d’un panneau de discussion', `« ${existing.name} » publié dans le salon ${existing.channelId}.`, existing.channelId);
      return send(c, { ok: true, messageId });
    } catch (err) {
      return fail(c, err, 'Impossible de publier le panneau : vérifie que le bot peut écrire dans ce salon.', 'ThreadPanelAPI');
    }
  });

  router.delete(`${base}/auto-thread/panels/:id`, ...ownedGate, async (c) => {
    const existing = c.var.existing;
    const id = c.req.param('id');
    const { audit } = helpers(c);
    try {
      await unpublishThreadPanel(client, existing);
      await prisma.threadPanel.delete({ where: { id: existing.id } });
      await audit('Suppression d’un panneau de discussion', `« ${existing.name} » supprimé.`, existing.channelId);
      return send(c, { ok: true });
    } catch (err) {
      return fail(c, err, 'Erreur lors de la suppression du panneau', 'ThreadPanelAPI');
    }
  });

  return router;
}

