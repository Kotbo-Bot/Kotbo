/**
 * Espace membre : quêtes en cours (avec leur avancement) et candidatures ou
 * formulaires envoyés, avec leur état. Rendus pour le visiteur connecté.
 */

import prisma from '../../../utils/db.js';
import * as m from '../../../lib/paraglide/messages.js';
import { attrs, cls, esc } from '../siteHtml.js';
import { emptyState, formatNumber, timeTag, type BlockContext, type BlockRegistry } from './blockContext.js';
import { viewerGate } from './memberBlocks.js';

async function renderMemberQuests(ctx: BlockContext): Promise<string> {
  const gate = viewerGate(ctx);
  if (gate !== null) return gate;
  const o = { locale: ctx.locale };
  const guildId = ctx.site.guildId;
  const userId = ctx.viewer!.userId;
  const since = new Date(Date.now() - 8 * 86_400_000);
  const [definitions, progress] = await Promise.all([
    prisma.questDefinition.findMany({ where: { guildId, enabled: true }, orderBy: [{ frequency: 'asc' }, { createdAt: 'asc' }], take: 30 }),
    prisma.questProgress.findMany({ where: { guildId, userId, updatedAt: { gte: since }, status: { not: 'EXPIRED' } }, orderBy: { updatedAt: 'desc' } }),
  ]);
  if (definitions.length === 0) return `<p class="mod-title">${esc(m.site_quests_title({}, o))}</p>${emptyState(m.site_quests_empty({}, o))}`;

  // Avancement le plus récent de chaque quête (période en cours).
  const latest = new Map<string, (typeof progress)[number]>();
  for (const row of progress) if (!latest.has(row.questId)) latest.set(row.questId, row);

  const FREQ: Record<string, () => string> = { DAILY: () => m.site_quests_daily({}, o), WEEKLY: () => m.site_quests_weekly({}, o) };
  const items = definitions
    .map((quest) => {
      const row = latest.get(quest.id);
      const target = row?.target ?? quest.target;
      const current = Math.min(row?.current ?? 0, target);
      const done = row?.status === 'COMPLETED' || row?.status === 'CLAIMED';
      const pct = target > 0 ? Math.round((current / target) * 100) : 0;
      const rewards = [quest.rewardCoins ? m.site_reward_coins({ count: quest.rewardCoins }, o) : '', quest.rewardXp ? m.site_reward_xp({ count: quest.rewardXp }, o) : ''].filter(Boolean).join(' · ');
      return `<li class="${cls('quest', done && 'is-done')}">
  <div class="quest-head"><strong>${esc(quest.name)}</strong><span class="tag">${esc((FREQ[quest.frequency] ?? FREQ.DAILY)())}</span></div>
  ${quest.description ? `<p class="card-meta">${esc(quest.description)}</p>` : ''}
  <div class="quest-bar"${attrs({ role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': target, 'aria-valuenow': current })}><span style="width:${pct}%"></span></div>
  <p class="card-meta">${esc(done ? m.site_quests_done({}, o) : m.site_quests_progress({ current: formatNumber(current, ctx.locale), target: formatNumber(target, ctx.locale) }, o))}${rewards ? ` · ${esc(rewards)}` : ''}</p>
</li>`;
    })
    .join('');
  return `<p class="mod-title">${esc(m.site_quests_title({}, o))}</p><ul class="quests">${items}</ul>`;
}

async function renderMemberApplications(ctx: BlockContext): Promise<string> {
  const gate = viewerGate(ctx);
  if (gate !== null) return gate;
  const o = { locale: ctx.locale };
  const guildId = ctx.site.guildId;
  const userId = ctx.viewer!.userId;
  const [candidatures, submissions] = await Promise.all([
    prisma.recruitmentCandidature.findMany({ where: { guildId, discordId: userId }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, status: true, createdAt: true } }),
    prisma.customFormSubmission.findMany({ where: { guildId, userId }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, createdAt: true, form: { select: { name: true } } } }),
  ]);
  const STATUS: Record<string, () => string> = {
    PENDING: () => m.site_applications_pending({}, o),
    ORAL: () => m.site_applications_oral({}, o),
    APPROVED: () => m.site_applications_approved({}, o),
    REJECTED: () => m.site_applications_rejected({}, o),
    AUTO_REJECTED: () => m.site_applications_rejected({}, o),
  };
  const rows = [
    ...candidatures.map((c) => ({ at: c.createdAt, title: m.site_applications_candidature({}, o), status: (STATUS[c.status] ?? STATUS.PENDING)(), tone: c.status.toLowerCase() })),
    ...submissions.map((s) => ({ at: s.createdAt, title: s.form.name, status: m.site_applications_sent({}, o), tone: 'sent' })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());
  if (rows.length === 0) return `<p class="mod-title">${esc(m.site_applications_title({}, o))}</p>${emptyState(m.site_applications_empty({}, o))}`;
  const items = rows
    .map((row) => `<li class="shop-line"><span class="shop-line-main"><strong>${esc(row.title)}</strong><br><span class="card-meta">${timeTag(row.at, ctx.locale, 'medium')}</span></span><span class="${cls('tag', `application-${row.tone}`)}">${esc(row.status)}</span></li>`)
    .join('');
  return `<p class="mod-title">${esc(m.site_applications_title({}, o))}</p><ul class="shop-lines">${items}</ul>`;
}

export const memberActivityBlocks: BlockRegistry = {
  memberQuests: renderMemberQuests,
  memberApplications: renderMemberApplications,
};
