/**
 * Widgets HTML/iframe intégrables sur un site externe :
 *   GET /api/public/widgets/:guildId/embed?type=stats|messages|leaderboard&theme=dark|light&accent=#818cf8&days=7
 */
import { Hono } from 'hono';
import type { Client } from 'discord.js';
import prisma from '../../../../utils/db.js';
import { escapeHtml } from '../../../shared/markdown.js';

type WidgetType = 'stats' | 'messages' | 'leaderboard';
type WidgetTheme = 'dark' | 'light';

const SNOWFLAKE_RE = /^\d{17,20}$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function parseWidgetType(raw: string | undefined): WidgetType {
  if (raw === 'messages' || raw === 'leaderboard') return raw;
  return 'stats';
}

function parseWidgetTheme(raw: string | undefined): WidgetTheme {
  return raw === 'light' ? 'light' : 'dark';
}

function parseAccent(raw: string | undefined): string {
  return raw && HEX_COLOR_RE.test(raw) ? raw : '#818cf8';
}

function parseDays(raw: string | undefined): number {
  const n = Number(raw);
  if (n === 14 || n === 30) return n;
  return 7;
}

export function createPublicEmbedWidgetsRouter(client: Client) {
  const router = new Hono();

  router.get('/api/public/widgets/:guildId/embed', async (c) => {
    const guildId = c.req.param('guildId');
    if (!SNOWFLAKE_RE.test(guildId)) {
      return c.text('Identifiant de serveur invalide', 400);
    }

    const type = parseWidgetType(c.req.query('type'));
    const theme = parseWidgetTheme(c.req.query('theme'));
    const accent = parseAccent(c.req.query('accent'));
    const days = parseDays(c.req.query('days'));

    const discordGuild = client.guilds.cache.get(guildId);
    const dbGuild = await prisma.guild.findUnique({
      where: { id: guildId },
      select: { id: true, name: true },
    });
    if (!discordGuild && !dbGuild) {
      return c.text('Serveur introuvable', 404);
    }

    const serverName = discordGuild?.name ?? dbGuild?.name ?? 'Serveur Discord';
    const iconUrl = discordGuild?.iconURL({ size: 64, extension: 'png' }) ?? null;

    const palette = theme === 'light'
      ? { bg: '#ffffff', card: '#f8fafc', border: '#e2e8f0', text: '#0f172a', muted: '#64748b' }
      : { bg: '#0f1117', card: '#161922', border: 'rgba(255,255,255,0.1)', text: '#f8fafc', muted: '#94a3b8' };

    let bodyHtml = '';

    if (type === 'stats') {
      const latest = await prisma.guildDailyStat.findFirst({
        where: { guildId },
        orderBy: { dateKey: 'desc' },
      });
      const totalMembers = discordGuild?.memberCount ?? latest?.totalMembers ?? 0;
      const onlineMembers = latest?.onlineMembers ?? 0;
      const messagesToday = latest?.messagesCount ?? 0;
      const activeMembers = latest?.activeMembers ?? 0;

      bodyHtml = `
        <div class="grid">
          <div class="stat"><span class="val">${totalMembers.toLocaleString('fr-FR')}</span><span class="lbl">Membres</span></div>
          <div class="stat"><span class="val">${onlineMembers.toLocaleString('fr-FR')}</span><span class="lbl">En ligne</span></div>
          <div class="stat"><span class="val">${messagesToday.toLocaleString('fr-FR')}</span><span class="lbl">Messages / jour</span></div>
          <div class="stat"><span class="val">${activeMembers.toLocaleString('fr-FR')}</span><span class="lbl">Actifs</span></div>
        </div>`;
    } else if (type === 'messages') {
      const stats = await prisma.guildDailyStat.findMany({
        where: { guildId },
        orderBy: { dateKey: 'desc' },
        take: days,
        select: { dateKey: true, messagesCount: true },
      });
      const ordered = stats.reverse();
      const total = ordered.reduce((sum, s) => sum + s.messagesCount, 0);
      const max = Math.max(1, ...ordered.map((s) => s.messagesCount));

      const bars = ordered.length > 0
        ? ordered.map((s) => {
            const pct = Math.max(6, Math.round((s.messagesCount / max) * 100));
            return `<div class="bar-wrap" title="${escapeHtml(s.dateKey)} : ${s.messagesCount}"><div class="bar" style="height:${pct}%"></div></div>`;
          }).join('')
        : '<p class="empty">Aucune donnée récente</p>';

      bodyHtml = `
        <div class="summary"><span>${total.toLocaleString('fr-FR')} messages</span><span class="muted">sur ${days} jours</span></div>
        <div class="chart">${bars}</div>`;
    } else {
      const top = await prisma.memberLevel.findMany({
        where: { guildId },
        orderBy: { xp: 'desc' },
        take: 5,
        select: { userId: true, level: true, xp: true },
      });
      const rows = top.length > 0
        ? top.map((entry, idx) => {
            const member = discordGuild?.members.cache.get(entry.userId);
            const name = escapeHtml(member?.displayName ?? member?.user.username ?? entry.userId);
            return `<div class="row"><span class="rank">#${idx + 1}</span><span class="name">${name}</span><span class="meta">Niv. ${entry.level} · ${entry.xp.toLocaleString('fr-FR')} XP</span></div>`;
          }).join('')
        : '<p class="empty">Aucun classement disponible</p>';

      bodyHtml = `<div class="list">${rows}</div>`;
    }

    const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(serverName)} — Widget Kotbo</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: ${palette.bg};
    color: ${palette.text};
    padding: 12px;
  }
  .widget {
    background: ${palette.card};
    border: 1px solid ${palette.border};
    border-radius: 14px;
    padding: 14px 16px;
  }
  .head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  .icon { width: 28px; height: 28px; border-radius: 8px; object-fit: cover; background: ${accent}22; }
  .title { font-size: 14px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .badge { margin-left: auto; font-size: 10px; font-weight: 600; color: ${accent}; background: ${accent}1a; padding: 2px 8px; border-radius: 999px; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .stat { padding: 8px 10px; border-radius: 10px; border: 1px solid ${palette.border}; }
  .val { display: block; font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .lbl { display: block; font-size: 11px; color: ${palette.muted}; margin-top: 2px; }
  .summary { display: flex; justify-content: space-between; font-size: 12px; font-weight: 600; margin-bottom: 10px; }
  .muted, .empty { color: ${palette.muted}; font-size: 12px; }
  .chart { display: flex; align-items: flex-end; gap: 4px; height: 78px; }
  .bar-wrap { flex: 1; height: 100%; display: flex; align-items: flex-end; }
  .bar { width: 100%; background: ${accent}; border-radius: 4px 4px 2px 2px; min-height: 4px; }
  .list { display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 4px 0; border-bottom: 1px solid ${palette.border}; }
  .row:last-child { border-bottom: 0; }
  .rank { font-weight: 700; color: ${accent}; width: 22px; }
  .name { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { color: ${palette.muted}; font-variant-numeric: tabular-nums; font-size: 11px; }
</style>
</head>
<body>
  <div class="widget">
    <div class="head">
      ${iconUrl ? `<img class="icon" src="${escapeHtml(iconUrl)}" alt="" />` : ''}
      <div class="title">${escapeHtml(serverName)}</div>
      <span class="badge">Kotbo</span>
    </div>
    ${bodyHtml}
  </div>
</body>
</html>`;

    c.header('Content-Security-Policy', 'frame-ancestors *');
    c.header('Cache-Control', 'public, max-age=60');
    return c.html(html);
  });

  return router;
}
