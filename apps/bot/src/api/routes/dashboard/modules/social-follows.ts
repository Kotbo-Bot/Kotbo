/** Routes dashboard du module `social-follows`. */
import { type GithubRepoFailure, normalizeGithubBranch, normalizeGithubRepo, resolveGithubRepo } from '../../../../services/integrations/githubService.js';
import { HF_KINDS, huggingFaceTargetExists, normalizeHuggingFaceTarget } from '../../../../services/integrations/huggingFaceService.js';
import { getTwitchUserId, normalizeTwitchLogin } from '../../../../services/integrations/twitchService.js';
import { resolveYoutubeChannel } from '../../../../services/integrations/youtubeService.js';
import prisma from '../../../../utils/db.js';
import { errorMessage } from '../../../../utils/errors.js';
import { logger } from '../../../../utils/logger.js';
import { normalizeRoleMention } from '../../../../utils/mentions.js';
import { getGuildName, json, pushAudit, readJsonBody } from '../../../shared.js';
import { type ModuleRouteContext } from './_shared.js';

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

export async function handleSocialFollowsRoutes(ctx: ModuleRouteContext): Promise<boolean> {
  const { req, res, parts, client, guildId, method, auditUser, moduleKey } = ctx;

  // GET/POST/DELETE /api/dashboard/guilds/:guildId/social-follows
  if (moduleKey === 'social-follows') {
    if (parts.length === 5 && method === 'GET') {
      try {
        const [youtube, twitch, github, huggingface] = await Promise.all([
          prisma.youtubeChannelFollow.findMany({ where: { guildId } }),
          prisma.twitchChannelFollow.findMany({ where: { guildId } }),
          prisma.githubRepoFollow.findMany({ where: { guildId }, orderBy: { createdAt: 'asc' } }),
          prisma.huggingFaceFollow.findMany({ where: { guildId }, orderBy: { createdAt: 'asc' } }),
        ]);
        json(res, 200, { youtube, twitch, github, huggingface });
      } catch (err: unknown) {
        logger.error('SocialFollowsAPI', `Error fetching social follows: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors de la récupération des réseaux sociaux suivis' });
      }
      return true;
    }

    if (parts.length === 6 && parts[5] === 'youtube' && method === 'POST') {
      try {
        const body = await readJsonBody<{
          query: string;
          discordChannelId?: string | null;
          mention?: string | null;
          liveMessage?: string | null;
          videoMessage?: string | null;
          shortMessage?: string | null;
        }>(req);
        if (!body?.query) {
          json(res, 400, { error: 'Recherche ou URL YouTube requise' });
          return true;
        }

        const resolved = await resolveYoutubeChannel(body.query);
        if (!resolved) {
          json(res, 400, { error: 'Impossible de résoudre la chaîne YouTube' });
          return true;
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

        json(res, 200, follow);
      } catch (err: unknown) {
        logger.error('SocialFollowsAPI', `Error adding youtube follow: ${errorMessage(err)}`);
        json(res, 500, { error: "Erreur lors de l'ajout du suivi YouTube" });
      }
      return true;
    }

    if (parts.length === 7 && parts[5] === 'youtube' && method === 'DELETE') {
      try {
        const followId = parts[6];
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
        json(res, 200, { success: true });
      } catch (err: unknown) {
        logger.error('SocialFollowsAPI', `Error deleting youtube follow: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors de la suppression du suivi YouTube' });
      }
      return true;
    }

    if (parts.length === 6 && parts[5] === 'twitch' && method === 'POST') {
      try {
        const body = await readJsonBody<{
          streamerName: string;
          discordChannelId?: string | null;
          mention?: string | null;
          liveMessage?: string | null;
        }>(req);
        if (!body?.streamerName) {
          json(res, 400, { error: 'streamerName requis' });
          return true;
        }
        // Une URL ou un @pseudo doit être ramené au login seul : c'est cette
        // valeur que le polling compare aux logins renvoyés par Helix.
        const streamerName = normalizeTwitchLogin(body.streamerName);
        if (!streamerName) {
          json(res, 400, { error: 'Nom de chaîne Twitch invalide' });
          return true;
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

        json(res, 200, follow);
      } catch (err: unknown) {
        logger.error('SocialFollowsAPI', `Error adding twitch follow: ${errorMessage(err)}`);
        json(res, 500, { error: "Erreur lors de l'ajout du suivi Twitch" });
      }
      return true;
    }

    if (parts.length === 7 && parts[5] === 'twitch' && method === 'DELETE') {
      try {
        const followId = parts[6];
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
        json(res, 200, { success: true });
      } catch (err: unknown) {
        logger.error('SocialFollowsAPI', `Error deleting twitch follow: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors de la suppression du suivi Twitch' });
      }
      return true;
    }

    if (parts.length === 6 && parts[5] === 'github' && method === 'POST') {
      try {
        const body = await readJsonBody<{
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
        }>(req);
        const repo = normalizeGithubRepo(body?.repo ?? '');
        if (!body || !repo) {
          json(res, 400, { error: 'Dépôt GitHub invalide : indique owner/depot ou son URL' });
          return true;
        }
        const branch = normalizeGithubBranch(body.branch);
        if (body.branch?.trim() && !branch) {
          json(res, 400, { error: 'Nom de branche invalide' });
          return true;
        }

        // Le nom canonique d'abord : un dépôt renommé ou saisi avec une autre
        // casse doit retomber sur son suivi existant.
        const resolved = await resolveGithubRepo(repo);
        if (!resolved.ok) {
          const failure = GITHUB_RESOLVE_ERRORS[resolved.reason];
          json(res, failure.status, { error: failure.error });
          return true;
        }

        const existing = await prisma.githubRepoFollow.findUnique({ where: { guildId_repo: { guildId, repo: resolved.repo } } });
        if (!existing && (await prisma.githubRepoFollow.count({ where: { guildId } })) >= MAX_GITHUB_FOLLOWS) {
          json(res, 400, { error: `Un serveur peut suivre au plus ${MAX_GITHUB_FOLLOWS} dépôts GitHub` });
          return true;
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

        json(res, 200, follow);
      } catch (err: unknown) {
        logger.error('SocialFollowsAPI', `Error adding github follow: ${errorMessage(err)}`);
        json(res, 500, { error: "Erreur lors de l'ajout du suivi GitHub" });
      }
      return true;
    }

    if (parts.length === 7 && parts[5] === 'github' && method === 'DELETE') {
      try {
        const followId = parts[6];
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
        json(res, 200, { success: true });
      } catch (err: unknown) {
        logger.error('SocialFollowsAPI', `Error deleting github follow: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors de la suppression du suivi GitHub' });
      }
      return true;
    }

    if (parts.length === 6 && parts[5] === 'huggingface' && method === 'POST') {
      try {
        const body = await readJsonBody<{
          kind: string;
          target: string;
          discordChannelId?: string | null;
          mention?: string | null;
          message?: string | null;
        }>(req);
        const kind = HF_KINDS.find((k) => k === body?.kind);
        const parsed = body && kind ? normalizeHuggingFaceTarget(body.target ?? '', kind) : null;
        if (!body || !parsed) {
          json(res, 400, { error: 'Cible Hugging Face invalide : indique owner/nom, un auteur ou une URL du Hub' });
          return true;
        }

        const where = { guildId_kind_target: { guildId, kind: parsed.kind, target: parsed.target } };
        const existing = await prisma.huggingFaceFollow.findUnique({ where });
        if (!existing && (await prisma.huggingFaceFollow.count({ where: { guildId } })) >= MAX_HUGGINGFACE_FOLLOWS) {
          json(res, 400, { error: `Un serveur peut avoir au plus ${MAX_HUGGINGFACE_FOLLOWS} suivis Hugging Face` });
          return true;
        }
        if (!existing && !(await huggingFaceTargetExists(parsed.kind, parsed.target))) {
          json(res, 400, { error: 'Introuvable sur Hugging Face, ou privé' });
          return true;
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

        json(res, 200, follow);
      } catch (err: unknown) {
        logger.error('SocialFollowsAPI', `Error adding huggingface follow: ${errorMessage(err)}`);
        json(res, 500, { error: "Erreur lors de l'ajout du suivi Hugging Face" });
      }
      return true;
    }

    if (parts.length === 7 && parts[5] === 'huggingface' && method === 'DELETE') {
      try {
        const followId = parts[6];
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
        json(res, 200, { success: true });
      } catch (err: unknown) {
        logger.error('SocialFollowsAPI', `Error deleting huggingface follow: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors de la suppression du suivi Hugging Face' });
      }
      return true;
    }
  }

  return false;
}
