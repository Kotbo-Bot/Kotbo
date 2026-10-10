/**
 * Bloc « Nouveautés » : ce qui a changé sur le serveur ces derniers jours
 * (modules, salons, emojis, articles, forum, boutique, votes), regroupé par jour.
 */

import { siteIconSvg, type SiteIconName } from '@kotbo/shared';
import * as m from '../../../lib/paraglide/messages.js';
import { cache } from '../../../utils/cache.js';
import { attrs, esc } from '../siteHtml.js';
import { collectChangelog, type ChangelogEntry, type ChangelogKind } from '../siteAutoService.js';
import { emptyState, formatDate, type BlockContext, type BlockRegistry } from './blockContext.js';

const ICONS: Record<ChangelogKind, SiteIconName> = {
  module: 'puzzle',
  channel: 'message',
  emoji: 'sparkle',
  article: 'newspaper',
  wiki: 'book',
  forum: 'forum',
  shop: 'bag',
  vote: 'vote',
};

async function renderChangelog(ctx: BlockContext, config: Record<string, unknown>): Promise<string> {
  const o = { locale: ctx.locale };
  const days = Number(config.days) || 30;
  const limit = Number(config.limit) || 15;
  const entries = await cache.wrap<Array<Omit<ChangelogEntry, 'at'> & { at: string }>>(`guild:${ctx.site.guildId}:site-changelog:${days}:${ctx.locale}`, 300, async () =>
    (await collectChangelog(ctx.client, ctx.site, new Date(Date.now() - days * 86_400_000), ctx.locale)).map((e) => ({ ...e, at: e.at.toISOString() })),
  );
  const shown = entries.slice(0, limit);
  if (shown.length === 0) return `<p class="mod-title">${esc(m.site_changelog_title({}, o))}</p>${emptyState(m.site_changelog_empty({ days }, o))}`;

  const byDay = new Map<string, typeof shown>();
  for (const entry of shown) {
    const day = entry.at.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), entry]);
  }
  const groups = [...byDay.entries()]
    .map(
      ([day, list]) => `<li class="changelog-day">
  <p class="changelog-date">${esc(formatDate(day, ctx.locale, 'long'))}</p>
  <ul>${list
    .map((entry) => {
      const label = entry.href ? `<a${attrs({ href: entry.href })}>${esc(entry.text)}</a>` : esc(entry.text);
      return `<li><span class="changelog-icon">${siteIconSvg(ICONS[entry.kind], 16)}</span>${label}</li>`;
    })
    .join('')}</ul>
</li>`,
    )
    .join('');
  return `<p class="mod-title">${esc(m.site_changelog_title({}, o))}</p><ol class="changelog">${groups}</ol>`;
}

export const autoBlocks: BlockRegistry = {
  changelog: renderChangelog,
};
