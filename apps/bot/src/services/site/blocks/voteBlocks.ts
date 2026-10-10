/**
 * Blocs des votes : sites où voter (avec le statut du membre connecté) et
 * classement des votants du mois.
 */

import { memberVoteUrl, siteIconSvg, SITE_VOTE_PROVIDERS } from '@kotbo/shared';
import * as m from '../../../lib/paraglide/messages.js';
import { getMemberIdentities } from '../../moderation/memberIdentityService.js';
import { attrs, cls, esc } from '../siteHtml.js';
import { listPublicVoteSites, topVoters, voterStatus } from '../siteVoteService.js';
import { avatar, emptyState, formatNumber, timeTag, type BlockContext, type BlockRegistry } from './blockContext.js';

async function renderVote(ctx: BlockContext): Promise<string> {
  const o = { locale: ctx.locale };
  const sites = await listPublicVoteSites(ctx.site.guildId);
  if (sites.length === 0) return emptyState(m.site_votes_empty({}, o));
  const viewer = ctx.viewer;
  const status = viewer ? await voterStatus(ctx.site.guildId, viewer.userId, sites) : null;

  const cards = sites
    .map((site) => {
      const spec = SITE_VOTE_PROVIDERS[site.provider];
      const mine = status?.sites.find((s) => s.voteSiteId === site.id);
      const href = memberVoteUrl(site.provider, site.voteUrl, viewer?.userId ?? null);
      const state = mine?.nextAt
        ? `<p class="card-meta">${siteIconSvg('clock', 16)} ${m.site_vote_next({ date: timeTag(mine.nextAt, ctx.locale, 'short') }, o)}</p>`
        : viewer
          ? `<p class="card-meta vote-ready">${siteIconSvg('check', 16)} ${esc(m.site_vote_ready({}, o))}</p>`
          : '';
      const check =
        site.verification === 'webhook'
          ? `<p class="card-meta">${esc(m.site_vote_automatic({}, o))}</p>`
          : `<button type="button" class="btn btn-secondary btn-sm"${attrs({ 'data-action': 'vote-check', 'data-id': site.id, 'data-requires-login': '1' })}>${esc(m.site_vote_check({}, o))}</button>`;
      return `<article class="${cls('vote-card', mine?.nextAt && 'is-waiting')}">
  <div class="card-body">
    <h3 class="card-title">${esc(site.label)}</h3>
    <p class="card-meta">${esc(spec.host)} · ${esc(m.site_vote_cooldown({ hours: site.cooldownHours }, o))}</p>
    ${state}
    <div class="card-actions">
      <a class="btn btn-primary btn-sm"${attrs({ href, target: '_blank', rel: 'noopener', 'data-vote-open': site.id })}>${esc(m.site_vote_open({}, o))}</a>
      ${check}
    </div>
  </div>
</article>`;
    })
    .join('');

  const intro = viewer
    ? `<p class="mod-meta">${esc(m.site_vote_streak({ count: status?.streak ?? 0 }, o))}</p>`
    : `<p class="mod-meta">${esc(m.site_vote_login_hint({}, o))} <a href="#" data-login>${esc(m.site_login({}, o))}</a></p>`;
  return `<p class="mod-title">${esc(m.site_vote_title({}, o))}</p>${intro}<div class="card-grid">${cards}</div>`;
}

async function renderVoteLeaderboard(ctx: BlockContext, config: Record<string, unknown>): Promise<string> {
  const o = { locale: ctx.locale };
  const rows = await topVoters(ctx.site.guildId, Number(config.limit) || 10);
  if (rows.length === 0) return `<p class="mod-title">${esc(m.site_vote_top_title({}, o))}</p>${emptyState(m.site_vote_top_empty({}, o))}`;
  const identities = await getMemberIdentities(ctx.client, ctx.site.guildId, rows.map((r) => r.userId));
  const items = rows
    .map((row, index) => {
      const who = identities.get(row.userId);
      const name = who?.displayName ?? row.userId;
      return `<li class="${cls('lb-row', index < 3 && `lb-top-${index + 1}`)}">
  <span class="lb-rank">${index + 1}</span>
  ${avatar(who?.avatarUrl, name, 'sm')}
  <span class="lb-name"><a${attrs({ href: `${ctx.basePath}/u/${row.userId}` })}>${esc(name)}</a></span>
  <span class="lb-value">${esc(m.site_vote_count({ count: formatNumber(row.votes, ctx.locale) }, o))}</span>
</li>`;
    })
    .join('');
  return `<p class="mod-title">${esc(m.site_vote_top_title({}, o))}</p><ol class="leaderboard">${items}</ol>`;
}

export const voteBlocks: BlockRegistry = {
  vote: renderVote,
  voteLeaderboard: renderVoteLeaderboard,
};
