/**
 * Routes dashboard des emojis et stickers interdits.
 *
 *   GET    /emoji-bans                         règles du serveur
 *   POST   /emoji-bans                         crée ou remplace une règle (une sanction par élément)
 *   DELETE /emoji-bans/:id                     suppression
 *   GET    /emoji-bans/search?q=               serveurs recensés par Kotbo (pour interdire tout un serveur)
 *   GET    /emoji-bans/sources/:sourceId       emojis et stickers d'un serveur où Kotbo est présent
 */
import { Hono, type Context } from 'hono';
import type { Client } from 'discord.js';
import prisma from '../../../../utils/db.js';
import { broadcastDashboardStateChange, getGuildName, pushAudit } from '../../../shared.js';
import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
import { guildIconUrl } from '../../../../services/core/serverTagService.js';
import { isJailConfigured } from '../../../../services/moderation/jailService.js';
import { AUTO_SANCTIONS } from '../../../../services/moderation/autoSanction.js';
import {
  EMOJI_BAN_KINDS,
  MAX_EMOJI_BAN_RULES,
  customEmojiUrl,
  deleteEmojiBan,
  isPublicGuildRecord,
  publicGuildRecordWhere,
  upsertEmojiBan,
  type EmojiBanKind,
} from '../../../../services/moderation/emojiBanService.js';

const SNOWFLAKE = /^\d{17,20}$/;
type Body = Record<string, unknown>;

export function createEmojiBansRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/emoji-bans';
  const gate = guildRoute(client);

  const audit = (c: Context, action: string, details: string) => {
    const guildId = c.req.param('guildId')!;
    return pushAudit(guildId, {
      user: auditUserOf(c),
      action,
      context: getGuildName(client, guildId),
      module: 'AutoMod',
      eventType: 'Manuel',
      details,
      channelId: null,
    });
  };

  router.onError((err, c) => fail(c, err, 'Erreur des emojis interdits', 'EmojiBansAPI'));

  router.get(base, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const guild = client.guilds.cache.get(guildId);
    const rules = await prisma.emojiBanRule.findMany({ where: { guildId }, orderBy: { createdAt: 'desc' } });
    return send(c, {
      rules,
      maxRules: MAX_EMOJI_BAN_RULES,
      sanctions: AUTO_SANCTIONS,
      jailConfigured: guild ? await isJailConfigured(guild) : false,
    });
  });

  router.post(base, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const body = await readBody<Body>(c);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(c, { error: 'Payload invalide' }, 400);
    if (!EMOJI_BAN_KINDS.includes(body.kind as EmojiBanKind)) return send(c, { error: 'Type invalide' }, 400);
    const rule = await upsertEmojiBan(guildId, {
      kind: body.kind as EmojiBanKind,
      key: String(body.key ?? ''),
      name: typeof body.name === 'string' ? body.name : null,
      iconUrl: typeof body.iconUrl === 'string' ? body.iconUrl : null,
      action: body.action,
      durationMin: typeof body.durationMin === 'number' ? body.durationMin : null,
      createdBy: c.var.dashboardUser.userId ?? null,
    });
    if ('error' in rule) return send(c, { error: rule.error }, 400);
    await audit(c, 'Emoji ou sticker interdit', `${rule.kind} ${rule.name ?? rule.key} → ${rule.action}`);
    broadcastDashboardStateChange(guildId, 'emoji_bans_updated');
    return send(c, { rule }, 201);
  });

  router.delete(`${base}/:id`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const rule = await deleteEmojiBan(guildId, c.req.param('id'));
    if (!rule) return send(c, { error: 'Règle introuvable' }, 404);
    await audit(c, 'Emoji ou sticker autorisé à nouveau', `${rule.kind} ${rule.name ?? rule.key}`);
    broadcastDashboardStateChange(guildId, 'emoji_bans_updated');
    return send(c, { ok: true });
  });

  router.get(`${base}/search`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const q = (c.req.query('q') ?? '').trim().slice(0, 100);
    if (!q) return send(c, { servers: [] });
    const rows = await prisma.discordExternalGuild.findMany({
      where: {
        guildId: { not: guildId },
        OR: [{ name: { contains: q, mode: 'insensitive' } }, ...(SNOWFLAKE.test(q) ? [{ guildId: q }] : [])],
        // Filtré en base, avant `take` : des fiches privées mieux classées videraient sinon la page.
        AND: publicGuildRecordWhere(client),
      },
      select: { guildId: true, name: true, icon: true, memberCount: true },
      orderBy: { memberCount: { sort: 'desc', nulls: 'last' } },
      take: 20,
    });
    return send(c, {
      servers: rows.map((r) => ({
        guildId: r.guildId,
        name: r.name,
        iconUrl: guildIconUrl(r.guildId, r.icon),
        memberCount: r.memberCount,
        kotboPresent: client.guilds.cache.has(r.guildId),
      })),
    });
  });

  router.get(`${base}/sources/:sourceId`, ...gate, async (c) => {
    const sourceId = c.req.param('sourceId');
    const row = SNOWFLAKE.test(sourceId)
      ? await prisma.discordExternalGuild.findUnique({ where: { guildId: sourceId }, select: { guildId: true, source: true } })
      : null;
    const source = row && isPublicGuildRecord(client, row) ? client.guilds.cache.get(sourceId) : undefined;
    if (!source) return send(c, { emojis: [], stickers: [], kotboPresent: false });
    const stickers = await source.stickers.fetch().catch(() => source.stickers.cache);
    return send(c, {
      kotboPresent: true,
      emojis: source.emojis.cache.map((e) => ({ id: e.id, name: e.name, animated: Boolean(e.animated), url: customEmojiUrl(e.id, Boolean(e.animated)) })),
      stickers: stickers.map((s) => ({ id: s.id, name: s.name, url: s.url })),
    });
  });

  return router;
}
