import { Hono } from 'hono';
import type { Client } from 'discord.js';
/** Routes dashboard du module `social-follows`. */
import { type GithubRepoFailure, normalizeGithubBranch, normalizeGithubRepo, resolveGithubRepo } from '../../../../services/integrations/githubService.js';
import { HF_KINDS, huggingFaceTargetExists, normalizeHuggingFaceTarget } from '../../../../services/integrations/huggingFaceService.js';
import { getTwitchUserId, normalizeTwitchLogin } from '../../../../services/integrations/twitchService.js';
import { resolveYoutubeChannel } from '../../../../services/integrations/youtubeService.js';
import prisma from '../../../../utils/db.js';
import { errorMessage } from '../../../../utils/errors.js';
import { logger } from '../../../../utils/logger.js';
import { normalizeRoleMention } from '../../../../utils/mentions.js';
import { getGuildName, pushAudit } from '../../../shared.js';
import { auditUserOf, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';

/**
 * Le quota GitHub est partagé par tous les serveurs de l'instance : un serveur
 * qui suivrait cent dépôts l'épuiserait pour les autres.
 */
const MAX_GITHUB_FOLLOWS = 15;
const MAX_HUGGINGFACE_FOLLOWS = 25;
const MAX_MESSAGE_LENGTH = 500;

/** Seul `not_found` est imputable à la saisie : le reste vient de GitHub ou de notre jeton. */
const GITHUB_RESOLVE_ERRORS: Record<GithubRepoFailure, { status: number; error: string }> = {
  not_found: { status: 400, error: 'Dépôt GitHub introuvable ou privé' },
  rate_limited: { status: 503, error: "Quota de l'API GitHub atteint, réessaie dans quelques minutes" },
  unauthorized: { status: 503, error: "Le jeton GitHub du bot est refusé par GitHub, préviens l'équipe Kotbo" },
  forbidden: { status: 400, error: "GitHub refuse l'accès à ce dépôt (organisation à SSO ou jeton restreint)" },
  unavailable: { status: 502, error: 'GitHub ne répond pas, réessaie dans quelques minutes' },
};

/** Modèle de message : vide = message par défaut, borné pour tenir dans Discord. */
function followMessage(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, MAX_MESSAGE_LENGTH) : null;
}

export function createSocialFollowsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);


  router.get(`${base}/social-follows`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const [youtube, twitch, github, huggingface] = await Promise.all([
        prisma.youtubeChannelFollow.findMany({ where: { guildId } }),
        prisma.twitchChannelFollow.findMany({ where: { guildId } }),
        prisma.githubRepoFollow.findMany({ where: { guildId }, orderBy: { createdAt: 'asc' } }),
        prisma.huggingFaceFollow.findMany({ where: { guildId }, orderBy: { createdAt: 'asc' } }),
      ]);
      return send(c, { youtube, twitch, github, huggingface });
    } catch (err: unknown) {
      logger.error('SocialFollowsAPI', `Error fetching social follows: ${errorMessage(err)}`);
      return send(c, { error: 'Erreur lors de la récupération des réseaux sociaux suivis' }, 500);
    }
  });

  router.post(`${base}/social-follows/youtube`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const auditUser = auditUserOf(c);
    try {
      const body = await readBody<{
        query: string;
        discordChannelId?: string | null;
        mention?: string | null;
        liveMessage?: string | null;
        videoMessage?: string | null;
        shortMessage?: string | null;
      }>(c);
      if (!body?.query) {
        return send(c, { error: 'Recherche ou URL YouTube requise' }, 400);
      }

      const resolved = await resolveYoutubeChannel(body.query);
      if (!resolved) {
        return send(c, { error: 'Impossible de résoudre la chaîne YouTube' }, 400);
      }

      const { channelId, channelName } = resolved;
      const follow = await prisma.youtubeChannelFollow.upsert({
        where: { guildId_channelId: { guildId, channelId } },
        create: {
          guildId,
          channelId,
          channelName,
          discordChannelId: body.discordChannelId || null,
          mention: normalizeRoleMention(body.mention),
          liveMessage: body.liveMessage || null,
          videoMessage: body.videoMessage || null,
          shortMessage: body.shortMessage || null,
        },
        update: {
          channelName,
          discordChannelId: body.discordChannelId || null,
          mention: normalizeRoleMention(body.mention),
          liveMessage: body.liveMessage || null,
          videoMessage: body.videoMessage || null,
          shortMessage: body.shortMessage || null,
        }
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'YouTube Follow',
        context: getGuildName(client, guildId),
        module: 'YouTube',
        eventType: 'Manuel',
        details: `Chaîne YouTube "${channelName}" (${channelId}) suivie/mise à jour.`,
        channelId: null
      });

      return send(c, follow);
    } catch (err: unknown) {
      logger.error('SocialFollowsAPI', `Error adding youtube follow: ${errorMessage(err)}`);
      return send(c, { error: "Erreur lors de l'ajout du suivi YouTube" }, 500);
    }
  });

  router.delete(`${base}/social-follows/youtube/:followId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const auditUser = auditUserOf(c);
    try {
      const followId = c.req.param('followId');
      // Le filtre sur guildId empêche la suppression d'un suivi d'une autre guilde.
      const follow = await prisma.youtubeChannelFollow.findFirst({ where: { id: followId, guildId } });
      if (follow) {
        await prisma.youtubeChannelFollow.delete({ where: { id: followId } });
        await pushAudit(guildId, {
          user: auditUser,
          action: 'YouTube Unfollow',
          context: getGuildName(client, guildId),
          module: 'YouTube',
          eventType: 'Manuel',
          details: `Chaîne YouTube "${follow.channelName}" unfollow.`,
          channelId: null
        });
      }
      return send(c, { success: true });
    } catch (err: unknown) {
      logger.error('SocialFollowsAPI', `Error deleting youtube follow: ${errorMessage(err)}`);
      return send(c, { error: 'Erreur lors de la suppression du suivi YouTube' }, 500);
    }
  });

  router.post(`${base}/social-follows/twitch`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const auditUser = auditUserOf(c);
    try {
      const body = await readBody<{
        streamerName: string;
        discordChannelId?: string | null;
        mention?: string | null;
        liveMessage?: string | null;
      }>(c);
      if (!body?.streamerName) {
        return send(c, { error: 'streamerName requis' }, 400);
      }
      // Une URL ou un @pseudo doit être ramené au login seul : c'est cette
      // valeur que le polling compare aux logins renvoyés par Helix.
      const streamerName = normalizeTwitchLogin(body.streamerName);
      if (!streamerName) {
        return send(c, { error: 'Nom de chaîne Twitch invalide' }, 400);
      }
      const streamerId = await getTwitchUserId(streamerName);

      const follow = await prisma.twitchChannelFollow.upsert({
        where: { guildId_streamerName: { guildId, streamerName } },
        create: {
          guildId,
          streamerName,
          streamerId,
          discordChannelId: body.discordChannelId || null,
          mention: normalizeRoleMention(body.mention),
          liveMessage: body.liveMessage || null,
        },
        update: {
          streamerId,
          discordChannelId: body.discordChannelId || null,
          mention: normalizeRoleMention(body.mention),
          liveMessage: body.liveMessage || null,
        }
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Twitch Follow',
        context: getGuildName(client, guildId),
        module: 'Twitch',
        eventType: 'Manuel',
        details: `Streamer Twitch "${streamerName}" suivi/mis à jour.`,
        channelId: null
      });

      return send(c, follow);
    } catch (err: unknown) {
      logger.error('SocialFollowsAPI', `Error adding twitch follow: ${errorMessage(err)}`);
      return send(c, { error: "Erreur lors de l'ajout du suivi Twitch" }, 500);
    }
  });

  router.delete(`${base}/social-follows/twitch/:followId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const auditUser = auditUserOf(c);
    try {
      const followId = c.req.param('followId');
      // Le filtre sur guildId empêche la suppression d'un suivi d'une autre guilde.
      const follow = await prisma.twitchChannelFollow.findFirst({ where: { id: followId, guildId } });
      if (follow) {
        await prisma.twitchChannelFollow.delete({ where: { id: followId } });
        await pushAudit(guildId, {
          user: auditUser,
          action: 'Twitch Unfollow',
          context: getGuildName(client, guildId),
          module: 'Twitch',
          eventType: 'Manuel',
          details: `Streamer Twitch "${follow.streamerName}" unfollow.`,
          channelId: null
        });
      }
      return send(c, { success: true });
    } catch (err: unknown) {
      logger.error('SocialFollowsAPI', `Error deleting twitch follow: ${errorMessage(err)}`);
      return send(c, { error: 'Erreur lors de la suppression du suivi Twitch' }, 500);
    }
  });

  router.post(`${base}/social-follows/github`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const auditUser = auditUserOf(c);
    try {
      const body = await readBody<{
        repo: string;
        branch?: string | null;
        discordChannelId?: string | null;
        mention?: string | null;
        notifyCommits?: boolean;
        notifyReleases?: boolean;
        notifyPullRequests?: boolean;
        notifyIssues?: boolean;
        commitMessage?: string | null;
        releaseMessage?: string | null;
        pullRequestMessage?: string | null;
        issueMessage?: string | null;
      }>(c);
      const repo = normalizeGithubRepo(body?.repo ?? '');
      if (!body || !repo) {
        return send(c, { error: 'Dépôt GitHub invalide : indique owner/depot ou son URL' }, 400);
      }
      const branch = normalizeGithubBranch(body.branch);
      if (body.branch?.trim() && !branch) {
        return send(c, { error: 'Nom de branche invalide' }, 400);
      }

      // Le nom canonique d'abord : un dépôt renommé ou saisi avec une autre
      // casse doit retomber sur son suivi existant.
      const resolved = await resolveGithubRepo(repo);
      if (!resolved.ok) {
        const failure = GITHUB_RESOLVE_ERRORS[resolved.reason];
        return send(c, { error: failure.error }, failure.status);
      }

      const existing = await prisma.githubRepoFollow.findUnique({ where: { guildId_repo: { guildId, repo: resolved.repo } } });
      if (!existing && (await prisma.githubRepoFollow.count({ where: { guildId } })) >= MAX_GITHUB_FOLLOWS) {
        return send(c, { error: `Un serveur peut suivre au plus ${MAX_GITHUB_FOLLOWS} dépôts GitHub` }, 400);
      }

      const settings = {
        branch,
        discordChannelId: body.discordChannelId || null,
        mention: normalizeRoleMention(body.mention),
        notifyCommits: body.notifyCommits ?? true,
        notifyReleases: body.notifyReleases ?? true,
        notifyPullRequests: body.notifyPullRequests ?? false,
        notifyIssues: body.notifyIssues ?? false,
        commitMessage: followMessage(body.commitMessage),
        releaseMessage: followMessage(body.releaseMessage),
        pullRequestMessage: followMessage(body.pullRequestMessage),
        issueMessage: followMessage(body.issueMessage),
      };
      const follow = await prisma.githubRepoFollow.upsert({
        where: { guildId_repo: { guildId, repo: resolved.repo } },
        create: { guildId, repo: resolved.repo, ...settings },
        update: {
          ...settings,
          // Autre branche : sa référence est à reposer, sans quoi tout son
          // historique récent serait annoncé comme nouveau.
          ...(existing && existing.branch !== branch ? { lastCommitSha: null } : {}),
        },
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'GitHub Follow',
        context: getGuildName(client, guildId),
        module: 'GitHub',
        eventType: 'Manuel',
        details: `Dépôt GitHub "${resolved.repo}" suivi/mis à jour.`,
        channelId: null
      });

      return send(c, follow);
    } catch (err: unknown) {
      logger.error('SocialFollowsAPI', `Error adding github follow: ${errorMessage(err)}`);
      return send(c, { error: "Erreur lors de l'ajout du suivi GitHub" }, 500);
    }
  });

  router.delete(`${base}/social-follows/github/:followId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const auditUser = auditUserOf(c);
    try {
      const followId = c.req.param('followId');
      // Le filtre sur guildId empêche la suppression d'un suivi d'une autre guilde.
      const follow = await prisma.githubRepoFollow.findFirst({ where: { id: followId, guildId } });
      if (follow) {
        await prisma.githubRepoFollow.delete({ where: { id: followId } });
        await pushAudit(guildId, {
          user: auditUser,
          action: 'GitHub Unfollow',
          context: getGuildName(client, guildId),
          module: 'GitHub',
          eventType: 'Manuel',
          details: `Dépôt GitHub "${follow.repo}" unfollow.`,
          channelId: null
        });
      }
      return send(c, { success: true });
    } catch (err: unknown) {
      logger.error('SocialFollowsAPI', `Error deleting github follow: ${errorMessage(err)}`);
      return send(c, { error: 'Erreur lors de la suppression du suivi GitHub' }, 500);
    }
  });

  router.post(`${base}/social-follows/huggingface`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const auditUser = auditUserOf(c);
    try {
      const body = await readBody<{
        kind: string;
        target: string;
        discordChannelId?: string | null;
        mention?: string | null;
        message?: string | null;
      }>(c);
      const kind = HF_KINDS.find((k) => k === body?.kind);
      const parsed = body && kind ? normalizeHuggingFaceTarget(body.target ?? '', kind) : null;
      if (!body || !parsed) {
        return send(c, { error: 'Cible Hugging Face invalide : indique owner/nom, un auteur ou une URL du Hub' }, 400);
      }

      const where = { guildId_kind_target: { guildId, kind: parsed.kind, target: parsed.target } };
      const existing = await prisma.huggingFaceFollow.findUnique({ where });
      if (!existing && (await prisma.huggingFaceFollow.count({ where: { guildId } })) >= MAX_HUGGINGFACE_FOLLOWS) {
        return send(c, { error: `Un serveur peut avoir au plus ${MAX_HUGGINGFACE_FOLLOWS} suivis Hugging Face` }, 400);
      }
      if (!existing && !(await huggingFaceTargetExists(parsed.kind, parsed.target))) {
        return send(c, { error: 'Introuvable sur Hugging Face, ou privé' }, 400);
      }

      const settings = {
        discordChannelId: body.discordChannelId || null,
        mention: normalizeRoleMention(body.mention),
        message: followMessage(body.message),
      };
      const follow = await prisma.huggingFaceFollow.upsert({
        where,
        create: { guildId, kind: parsed.kind, target: parsed.target, ...settings },
        update: settings,
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Hugging Face Follow',
        context: getGuildName(client, guildId),
        module: 'Hugging Face',
        eventType: 'Manuel',
        details: `Suivi Hugging Face ${parsed.kind} "${parsed.target}" ajouté/mis à jour.`,
        channelId: null
      });

      return send(c, follow);
    } catch (err: unknown) {
      logger.error('SocialFollowsAPI', `Error adding huggingface follow: ${errorMessage(err)}`);
      return send(c, { error: "Erreur lors de l'ajout du suivi Hugging Face" }, 500);
    }
  });

  router.delete(`${base}/social-follows/huggingface/:followId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const auditUser = auditUserOf(c);
    try {
      const followId = c.req.param('followId');
      // Le filtre sur guildId empêche la suppression d'un suivi d'une autre guilde.
      const follow = await prisma.huggingFaceFollow.findFirst({ where: { id: followId, guildId } });
      if (follow) {
        await prisma.huggingFaceFollow.delete({ where: { id: followId } });
        await pushAudit(guildId, {
          user: auditUser,
          action: 'Hugging Face Unfollow',
          context: getGuildName(client, guildId),
          module: 'Hugging Face',
          eventType: 'Manuel',
          details: `Suivi Hugging Face ${follow.kind} "${follow.target}" retiré.`,
          channelId: null
        });
      }
      return send(c, { success: true });
    } catch (err: unknown) {
      logger.error('SocialFollowsAPI', `Error deleting huggingface follow: ${errorMessage(err)}`);
      return send(c, { error: 'Erreur lors de la suppression du suivi Hugging Face' }, 500);
    }
  });

  return router;
}

