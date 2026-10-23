/**
 * Suites d'une action de membre sur le site : récompense de participation et
 * notifications. Appelées sans attendre (l'action du membre ne dépend pas de
 * leur succès) ; une erreur est notée, jamais remontée.
 */

import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getClient } from '../../utils/client.js';
import { resolveGuildLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { grantSiteReward } from './siteRewardService.js';
import { notifySiteMember } from './siteNotifyService.js';
import { pageUrl } from './blocks/contentBlocks.js';
import { publishGuildSignal } from './siteLive.js';

function background(label: string, task: () => Promise<unknown>): void {
  task().catch((err: unknown) => logger.warn('Site', `${label} :`, err));
}

async function localeFor(guildId: string): Promise<'fr' | 'en'> {
  const guild = getClient().guilds.cache.get(guildId);
  return (await resolveGuildLocale(guildId, guild?.preferredLocale)) === 'en' ? 'en' : 'fr';
}

/** Récompense de participation (commentaire, suggestion, événement, forum). */
export function rewardParticipation(guildId: string, userId: string, refKey: string): void {
  background('Récompense de participation', () => grantSiteReward(getClient(), guildId, userId, 'PARTICIPATION', refKey));
}

/** Commentaire visible : récompense de l'auteur, MP à l'auteur de l'article. */
export function afterCommentVisible(comment: { id: string; pageId: string; guildId: string; authorId: string; authorName: string }): void {
  rewardParticipation(comment.guildId, comment.authorId, `comment:${comment.id}`);
  publishGuildSignal(comment.guildId, `comments:${comment.pageId}`);
  background('Notification de commentaire', async () => {
    const page = await prisma.sitePage.findUnique({ where: { id: comment.pageId }, select: { kind: true, slug: true, authorId: true, publishedTitle: true, title: true } });
    if (!page || page.authorId === comment.authorId) return;
    const locale = await localeFor(comment.guildId);
    await notifySiteMember(getClient(), comment.guildId, page.authorId, 'comments', {
      title: m.site_notify_comment_title({ title: page.publishedTitle ?? page.title }, { locale }),
      body: m.site_notify_comment_body({ name: comment.authorName }, { locale }),
      path: pageUrl('', page),
    });
  });
}

/** Commentaire retenu par la modération puis affiché : on prévient aussi son auteur. */
export function afterCommentApproved(commentId: string): void {
  background('Commentaire approuvé', async () => {
    const comment = await prisma.siteComment.findUnique({
      where: { id: commentId },
      select: { id: true, pageId: true, guildId: true, authorId: true, authorName: true, page: { select: { kind: true, slug: true, publishedTitle: true, title: true } } },
    });
    if (!comment) return;
    afterCommentVisible(comment);
    const locale = await localeFor(comment.guildId);
    await notifySiteMember(getClient(), comment.guildId, comment.authorId, 'comments', {
      title: m.site_notify_comment_approved_title({}, { locale }),
      body: m.site_notify_comment_approved_body({ title: comment.page.publishedTitle ?? comment.page.title }, { locale }),
      path: pageUrl('', comment.page),
    });
  });
}
