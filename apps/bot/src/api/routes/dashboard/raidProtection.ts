import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { json, readJsonBody, safePushAudit, getGuildName, type AuthClaims, type DashboardAccess } from '../../shared.js';
import {
  getRaidProtectionConfig,
  upsertRaidProtectionConfig,
  activateRaidMode,
  deactivateRaidMode,
  enableJoinLock,
  disableJoinLock,
  enableDmLock,
  disableDmLock,
} from '../../../services/moderation/raidProtectionService.js';
import { enableInviteEmergency, disableInviteEmergency, approveInviteRequest, rejectInviteRequest } from '../../../services/moderation/inviteGuardService.js';
import { handleReportDecision, getReportStats } from '../../../services/moderation/reportService.js';
import { runSecurityAudit, applyAuditFix, applySafeAuditFixes } from '../../../services/moderation/securityAuditService.js';
import {
  getSpamConfig,
  upsertSpamConfig,
  getCalibrationStats,
  recordSpamDecision,
} from '../../../services/moderation/spam/index.js';
import { getLineageReport, quarantineLineage } from '../../../services/moderation/inviteLineageService.js';

import { jsonFailure } from '../../shared/failure.js';
// Champs anti-spam modifiables depuis le dashboard
const SPAM_PATCHABLE_FIELDS = [
  'enabled', 'shadowMode',
  'logThreshold', 'deleteThreshold', 'timeoutThreshold', 'banThreshold',
  'timeoutMinutes', 'alertChannelId',
  'bypassRoleIds', 'bypassChannelIds',
  'typingSignalEnabled', 'pasteSignalEnabled', 'crossChannelEnabled', 'duplicateEnabled',
  'cadenceEnabled', 'contentEnabled', 'trustEnabled',
  'windowSeconds', 'crossChannelThreshold', 'duplicateSimilarity',
] as const;

// Champs de configuration modifiables depuis le dashboard
const PATCHABLE_FIELDS = [
  'captchaEnabled', 'captchaChannelId', 'captchaUnverifiedRoleId', 'captchaVerifiedRoleId', 'captchaTimeoutMinutes',
  'captchaMaxAttempts', 'captchaFailAction', 'captchaLogChannelId',
  'captchaMode', 'captchaVoiceChannelId', 'captchaVoiceQueueLimit', 'captchaVoiceLocale',
  'antiRaidEnabled', 'antiRaidJoinThreshold', 'antiRaidJoinWindowSec', 'antiRaidAction',
  'antiRaidAlertChannelId', 'antiRaidAutoDisableMinutes',
  'accountAgeGuardEnabled', 'accountAgeMinValue', 'accountAgeMinUnit', 'accountAgeAction',
  'accountAgeAlertChannelId', 'accountAgeMessage', 'accountAgeWhitelist',
  'joinLockKick', 'joinLockMessage',
  'reportsEnabled', 'reportsChannelId', 'reportsCooldownSec', 'reportsAnonymous',
  'tagRoleEnabled', 'tagRoleId',
  'rolePersistEnabled', 'rolePersistMode', 'rolePersistRoleIds', 'rolePersistMaxDays',
  'scamFilterEnabled', 'scamFilterAction', 'scamFilterTimeoutMin', 'scamFilterCustomDomains',
  'scamFilterWhitelist', 'scamFilterAlertChannelId', 'scamImageFilterEnabled',
  'scamQrFilterEnabled', 'scamQrTrustedMessages', 'scamOcrEnabled',
  'inviteGuardEnabled', 'inviteRequireUnitary', 'inviteValidationEnabled',
  'inviteSpamThreshold', 'inviteSpamWindowSec', 'inviteAlertChannelId', 'inviteBypassRoleIds',
] as const;

export async function handleRaidProtectionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  _url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string,
  _access: DashboardAccess
): Promise<boolean> {
  if (parts[4] !== 'raid-protection') return false;
  const method = req.method;
  const sub = parts[5];
  const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;

  // GET /raid-protection - config + compteurs
  //
  // La config est creee si elle manque, comme le fait /automod. Un serveur que
  // le bot vient de rejoindre n'a pas encore de ligne, et renvoyer `null`
  // obligeait chaque appelant a inventer son propre repli : la page Anti-raid
  // retombait sur un objet vide, la configuration rapide du hub echouait. La
  // creation est sans effet, tous les interrupteurs du modele etant a false par
  // defaut - seul joinLockKick vaut true, et il ne joue que si joinLockEnabled
  // est actif.
  if (!sub && method === 'GET') {
    try {
      const [config, reportStats, pendingInvites, scamImageCount] = await Promise.all([
        getRaidProtectionConfig(guildId).then((c) => c ?? upsertRaidProtectionConfig(guildId, {})),
        getReportStats(guildId),
        prisma.inviteApprovalRequest.count({ where: { guildId, status: 'PENDING' } }),
        prisma.scamImageHash.count({ where: { OR: [{ guildId }, { guildId: null }] } }),
      ]);
      json(res, 200, { config, reportStats, pendingInvites, scamImageCount });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur GET config:', err);
      jsonFailure(res, err, 'Erreur lors de la récupération de la configuration', 'RaidProtectionAPI');
    }
    return true;
  }

  // PATCH /raid-protection - mise à jour de la config
  if (!sub && method === 'PATCH') {
    try {
      const body = await readJsonBody<Record<string, unknown>>(req);
      if (!body) {
        json(res, 400, { error: 'Corps de requête manquant' });
        return true;
      }
      const data: Record<string, unknown> = {};
      for (const field of PATCHABLE_FIELDS) {
        if (field in body) data[field] = body[field];
      }
      if ('accountAgeMinUnit' in data && data.accountAgeMinUnit !== 'MONTHS') data.accountAgeMinUnit = 'DAYS';
      if ('accountAgeMinValue' in data) {
        const raw = data.accountAgeMinValue;
        const value = raw === null || raw === '' ? NaN : Math.floor(Number(raw));
        if (!Number.isFinite(value)) {
          delete data.accountAgeMinValue;
        } else {
          // Plafond à dix ans dans les deux unités : au-delà, le seuil précède la
          // création de Discord et chaque arrivée serait refoulée.
          const unit = data.accountAgeMinUnit ?? (await getRaidProtectionConfig(guildId))?.accountAgeMinUnit;
          data.accountAgeMinValue = Math.min(Math.max(value, 1), unit === 'MONTHS' ? 120 : 3650);
        }
      }
      if ('accountAgeAction' in data && !['ALERT', 'KICK', 'BAN'].includes(String(data.accountAgeAction))) data.accountAgeAction = 'KICK';
      if ('accountAgeWhitelist' in data) {
        const list = Array.isArray(data.accountAgeWhitelist) ? data.accountAgeWhitelist : [];
        data.accountAgeWhitelist = [...new Set(list.map((id) => String(id).trim()).filter((id) => /^\d{17,20}$/.test(id)))];
      }
      if ('rolePersistMode' in data && data.rolePersistMode !== 'LIST') data.rolePersistMode = 'ALL';
      if ('rolePersistRoleIds' in data) {
        const list = Array.isArray(data.rolePersistRoleIds) ? data.rolePersistRoleIds : [];
        data.rolePersistRoleIds = [...new Set(list.map((id) => String(id).trim()).filter((id) => /^\d{17,20}$/.test(id)))];
      }
      if ('rolePersistMaxDays' in data) {
        const days = Math.floor(Number(data.rolePersistMaxDays));
        if (Number.isFinite(days)) data.rolePersistMaxDays = Math.min(Math.max(days, 1), 365);
        else delete data.rolePersistMaxDays;
      }
      const config = await upsertRaidProtectionConfig(guildId, data);
      await safePushAudit(guildId, {
        user: auditUser,
        action: 'Mise à jour de la configuration de protection anti-raid',
        context: getGuildName(client, guildId),
        module: 'RaidProtection',
        eventType: 'Manuel',
        details: '',
        channelId: null,
      }, 'RaidProtectionAPI');
      json(res, 200, { config });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur PATCH config:', err);
      jsonFailure(res, err, 'Erreur lors de la mise à jour de la configuration', 'RaidProtectionAPI');
    }
    return true;
  }

  // POST /raid-protection/raidmode { active }
  if (sub === 'raidmode' && method === 'POST') {
    try {
      const body = await readJsonBody<{ active?: boolean }>(req);
      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        json(res, 404, { error: 'Serveur introuvable' });
        return true;
      }
      const config = (await getRaidProtectionConfig(guildId)) ?? (await upsertRaidProtectionConfig(guildId, {}));
      if (body?.active) {
        await activateRaidMode(guild, config, true, user.userId);
        await safePushAudit(guildId, {
        user: auditUser,
        action: 'Mode raid activé manuellement',
        context: getGuildName(client, guildId),
        module: 'RaidProtection',
        eventType: 'Manuel',
        details: '',
        channelId: null,
      }, 'RaidProtectionAPI');
      } else {
        await deactivateRaidMode(guild, config);
        await safePushAudit(guildId, {
        user: auditUser,
        action: 'Mode raid désactivé',
        context: getGuildName(client, guildId),
        module: 'RaidProtection',
        eventType: 'Manuel',
        details: '',
        channelId: null,
      }, 'RaidProtectionAPI');
      }
      json(res, 200, { config: await getRaidProtectionConfig(guildId) });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur raidmode:', err);
      jsonFailure(res, err, 'Erreur lors du changement de mode raid', 'RaidProtectionAPI');
    }
    return true;
  }

  // POST /raid-protection/joinlock | dmlock { active, hours? }
  if ((sub === 'joinlock' || sub === 'dmlock') && method === 'POST') {
    try {
      const body = await readJsonBody<{ active?: boolean; hours?: number }>(req);
      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        json(res, 404, { error: 'Serveur introuvable' });
        return true;
      }
      const until = body?.hours ? new Date(Date.now() + body.hours * 60 * 60 * 1000) : null;
      if (sub === 'joinlock') {
        if (body?.active) await enableJoinLock(guild, until);
        else await disableJoinLock(guild);
      } else {
        if (body?.active) await enableDmLock(guild, until);
        else await disableDmLock(guild);
      }
      await safePushAudit(guildId, {
        user: auditUser,
        action: `${sub === 'joinlock' ? 'Join lock' : 'DM lock'} ${body?.active ? 'activé' : 'désactivé'}`,
        context: getGuildName(client, guildId),
        module: 'RaidProtection',
        eventType: 'Manuel',
        details: '',
        channelId: null,
      }, 'RaidProtectionAPI');
      json(res, 200, { config: await getRaidProtectionConfig(guildId) });
    } catch (err) {
      logger.error('RaidProtectionAPI', `Erreur ${sub}:`, err);
      jsonFailure(res, err, 'Erreur lors du changement de verrou', 'RaidProtectionAPI');
    }
    return true;
  }

  // POST /raid-protection/invite-emergency { active }
  if (sub === 'invite-emergency' && method === 'POST') {
    try {
      const body = await readJsonBody<{ active?: boolean }>(req);
      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        json(res, 404, { error: 'Serveur introuvable' });
        return true;
      }
      let deleted = 0;
      if (body?.active) deleted = await enableInviteEmergency(guild);
      else await disableInviteEmergency(guild);
      await safePushAudit(guildId, {
        user: auditUser,
        action: `Mode urgence invitations ${body?.active ? `activé (${deleted} supprimées)` : 'désactivé'}`,
        context: getGuildName(client, guildId),
        module: 'RaidProtection',
        eventType: 'Manuel',
        details: '',
        channelId: null,
      }, 'RaidProtectionAPI');
      json(res, 200, { config: await getRaidProtectionConfig(guildId), deleted });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur invite-emergency:', err);
      jsonFailure(res, err, 'Erreur lors du changement du mode urgence', 'RaidProtectionAPI');
    }
    return true;
  }

  // GET /raid-protection/reports?status=PENDING
  if (sub === 'reports' && !parts[6] && method === 'GET') {
    try {
      const status = _url.searchParams.get('status') ?? undefined;
      const reports = await prisma.memberReport.findMany({
        where: { guildId, ...(status ? { status } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      json(res, 200, { reports });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur GET reports:', err);
      jsonFailure(res, err, 'Erreur lors de la récupération des signalements', 'RaidProtectionAPI');
    }
    return true;
  }

  // POST /raid-protection/reports/:id/decision { resolved }
  if (sub === 'reports' && parts[6] && parts[7] === 'decision' && method === 'POST') {
    try {
      const body = await readJsonBody<{ resolved?: boolean }>(req);
      const report = await handleReportDecision(parts[6], user.userId, Boolean(body?.resolved));
      if (!report) {
        json(res, 404, { error: 'Signalement introuvable ou déjà traité' });
        return true;
      }
      json(res, 200, { report });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur decision report:', err);
      jsonFailure(res, err, 'Erreur lors du traitement du signalement', 'RaidProtectionAPI');
    }
    return true;
  }

  // GET /raid-protection/invite-requests
  if (sub === 'invite-requests' && !parts[6] && method === 'GET') {
    try {
      const requests = await prisma.inviteApprovalRequest.findMany({
        where: { guildId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      json(res, 200, { requests });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur GET invite-requests:', err);
      jsonFailure(res, err, 'Erreur lors de la récupération des demandes', 'RaidProtectionAPI');
    }
    return true;
  }

  // POST /raid-protection/invite-requests/:id/decision { approved }
  if (sub === 'invite-requests' && parts[6] && parts[7] === 'decision' && method === 'POST') {
    try {
      const body = await readJsonBody<{ approved?: boolean }>(req);
      const request = body?.approved
        ? await approveInviteRequest(client, parts[6], user.userId)
        : await rejectInviteRequest(client, parts[6], user.userId);
      if (!request) {
        json(res, 404, { error: 'Demande introuvable ou déjà traitée' });
        return true;
      }
      json(res, 200, { request });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur decision invite:', err);
      jsonFailure(res, err, 'Erreur lors du traitement de la demande', 'RaidProtectionAPI');
    }
    return true;
  }

  // GET /raid-protection/scam-images
  if (sub === 'scam-images' && !parts[6] && method === 'GET') {
    try {
      const images = await prisma.scamImageHash.findMany({
        where: { OR: [{ guildId }, { guildId: null }] },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      json(res, 200, { images });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur GET scam-images:', err);
      jsonFailure(res, err, 'Erreur lors de la récupération des images', 'RaidProtectionAPI');
    }
    return true;
  }

  // DELETE /raid-protection/scam-images/:id
  if (sub === 'scam-images' && parts[6] && method === 'DELETE') {
    try {
      // On ne peut supprimer que les hash de SA guilde (pas les globaux)
      const deleted = await prisma.scamImageHash.deleteMany({ where: { id: parts[6], guildId } });
      if (deleted.count === 0) {
        json(res, 404, { error: 'Hash introuvable (ou global, non supprimable)' });
        return true;
      }
      await safePushAudit(guildId, {
        user: auditUser,
        action: 'Hash d\'image scam supprimé',
        context: getGuildName(client, guildId),
        module: 'RaidProtection',
        eventType: 'Manuel',
        details: '',
        channelId: null,
      }, 'RaidProtectionAPI');
      json(res, 200, { success: true });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur DELETE scam-image:', err);
      jsonFailure(res, err, 'Erreur lors de la suppression', 'RaidProtectionAPI');
    }
    return true;
  }

  // ── Moteur anti-spam comportemental ────────────────────────────────────────

  // GET /raid-protection/spam - config + statistiques de calibration
  if (sub === 'spam' && !parts[6] && method === 'GET') {
    try {
      const days = Math.min(90, Math.max(1, Number(_url.searchParams.get('days')) || 14));
      const [config, stats] = await Promise.all([
        getSpamConfig(guildId),
        getCalibrationStats(guildId, days).catch(() => null),
      ]);
      json(res, 200, { config, stats });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur GET spam:', err);
      jsonFailure(res, err, 'Erreur lors de la récupération de la configuration anti-spam', 'RaidProtectionAPI');
    }
    return true;
  }

  // PATCH /raid-protection/spam - mise à jour de la config
  if (sub === 'spam' && !parts[6] && method === 'PATCH') {
    try {
      const body = await readJsonBody<Record<string, unknown>>(req);
      if (!body) {
        json(res, 400, { error: 'Corps de requête manquant' });
        return true;
      }

      const data: Record<string, unknown> = {};
      for (const field of SPAM_PATCHABLE_FIELDS) {
        if (field in body) data[field] = body[field];
      }

      // Des paliers désordonnés rendraient le moteur incohérent (une action
      // plus dure déclenchée avant une action plus douce).
      const thresholdOrder = ['logThreshold', 'deleteThreshold', 'timeoutThreshold', 'banThreshold'] as const;
      const current = await getSpamConfig(guildId);
      const resolved = thresholdOrder.map((field) =>
        typeof data[field] === 'number' ? (data[field] as number) : (current?.[field] ?? 0)
      );
      for (let i = 1; i < resolved.length; i++) {
        if (resolved[i] < resolved[i - 1]) {
          json(res, 400, { error: 'Les paliers doivent être croissants : journalisation ≤ suppression ≤ exclusion ≤ bannissement.' });
          return true;
        }
      }

      const config = await upsertSpamConfig(guildId, data);
      await safePushAudit(guildId, {
        user: auditUser,
        action: 'Mise à jour de la configuration anti-spam',
        context: getGuildName(client, guildId),
        module: 'AntiSpam',
        eventType: 'Manuel',
        details: Object.keys(data).join(', '),
        channelId: null,
      }, 'RaidProtectionAPI');
      json(res, 200, { config });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur PATCH spam:', err);
      jsonFailure(res, err, 'Erreur lors de la mise à jour de la configuration anti-spam', 'RaidProtectionAPI');
    }
    return true;
  }

  // GET /raid-protection/spam/samples?pending=1 - file de décision
  if (sub === 'spam' && parts[6] === 'samples' && method === 'GET') {
    try {
      const pendingOnly = _url.searchParams.get('pending') === '1';
      const minScore = Number(_url.searchParams.get('minScore')) || 0;
      const samples = await prisma.spamDetectionSample.findMany({
        where: {
          guildId,
          ...(pendingOnly ? { label: null } : {}),
          ...(minScore > 0 ? { score: { gte: minScore } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      json(res, 200, { samples });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur GET spam/samples:', err);
      jsonFailure(res, err, 'Erreur lors de la récupération des détections', 'RaidProtectionAPI');
    }
    return true;
  }

  // POST /raid-protection/spam/samples/:id/decision { truePositive }
  if (sub === 'spam' && parts[6] === 'samples' && parts[7] && parts[8] === 'decision' && method === 'POST') {
    try {
      const body = await readJsonBody<{ truePositive?: boolean }>(req);
      if (typeof body?.truePositive !== 'boolean') {
        json(res, 400, { error: 'Champ truePositive manquant' });
        return true;
      }

      const label = body.truePositive ? 'TRUE_POSITIVE' : 'FALSE_POSITIVE';
      const ok = await recordSpamDecision(guildId, parts[7], label, user.userId);
      if (!ok) {
        json(res, 404, { error: 'Détection introuvable' });
        return true;
      }

      await safePushAudit(guildId, {
        user: auditUser,
        action: `Détection anti-spam labellisée ${label === 'TRUE_POSITIVE' ? 'vrai positif' : 'faux positif'}`,
        context: getGuildName(client, guildId),
        module: 'AntiSpam',
        eventType: 'Manuel',
        details: parts[7],
        channelId: null,
      }, 'RaidProtectionAPI');
      json(res, 200, { success: true });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur POST spam/decision:', err);
      jsonFailure(res, err, 'Erreur lors de l\'enregistrement de la décision', 'RaidProtectionAPI');
    }
    return true;
  }

  // ── Lignage des invitations ────────────────────────────────────────────────

  // GET /raid-protection/lineage/:userId - d'où vient ce membre, et qui a-t-il amené
  if (sub === 'lineage' && parts[6] && !parts[7] && method === 'GET') {
    try {
      const report = await getLineageReport(guildId, parts[6]);
      json(res, 200, { report });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur GET lineage:', err);
      jsonFailure(res, err, 'Erreur lors du calcul du lignage', 'RaidProtectionAPI');
    }
    return true;
  }

  // POST /raid-protection/lineage/:userId/quarantine { dryRun, maxDepth, sinceDays, quarantineRoleId }
  if (sub === 'lineage' && parts[6] && parts[7] === 'quarantine' && method === 'POST') {
    try {
      const body = await readJsonBody<{
        dryRun?: boolean;
        maxDepth?: number;
        sinceDays?: number;
        quarantineRoleId?: string | null;
      }>(req);

      const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
      if (!guild) {
        json(res, 404, { error: 'Serveur introuvable' });
        return true;
      }

      const result = await quarantineLineage(guild, parts[6], {
        dryRun: body?.dryRun !== false,
        maxDepth: body?.maxDepth,
        since: body?.sinceDays ? new Date(Date.now() - body.sinceDays * 86_400_000) : undefined,
        quarantineRoleId: body?.quarantineRoleId ?? null,
        reason: `Quarantaine de lignage depuis ${parts[6]}, demandée par ${auditUser}`,
      });

      if (!result.dryRun) {
        await safePushAudit(guildId, {
          user: auditUser,
          action: `Quarantaine de lignage appliquée depuis ${parts[6]}`,
          context: getGuildName(client, guildId),
          module: 'InviteLineage',
          eventType: 'Manuel',
          details: `${result.applied} appliquée(s), ${result.skipped} ignorée(s), ${result.failed} échec(s)`,
          channelId: null,
        }, 'RaidProtectionAPI');
      }

      json(res, 200, { result });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur POST lineage/quarantine:', err);
      jsonFailure(res, err, 'Erreur lors de la mise en quarantaine', 'RaidProtectionAPI');
    }
    return true;
  }

  // GET /raid-protection/audit[?deep=0] - rapport d'audit de sécurité complet
  if (sub === 'audit' && !parts[6] && method === 'GET') {
    try {
      const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
      if (!guild) {
        json(res, 404, { error: 'Serveur introuvable' });
        return true;
      }
      const deep = _url.searchParams.get('deep') !== '0';
      const report = await runSecurityAudit(guild, { deep });
      json(res, 200, { report });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur GET audit:', err);
      jsonFailure(res, err, 'Erreur lors de l\'audit de sécurité', 'RaidProtectionAPI');
    }
    return true;
  }

  // POST /raid-protection/audit/fix { findingId } - correctif en un clic
  if (sub === 'audit' && parts[6] === 'fix' && method === 'POST') {
    try {
      const body = await readJsonBody<{ findingId?: string }>(req);
      const findingId = body?.findingId;
      if (!findingId) {
        json(res, 400, { error: 'findingId manquant' });
        return true;
      }
      const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
      if (!guild) {
        json(res, 404, { error: 'Serveur introuvable' });
        return true;
      }

      const outcome = await applyAuditFix(guild, findingId, `Correctif d'audit appliqué par ${auditUser}`);
      if (!outcome.ok) {
        json(res, 400, { error: outcome.message });
        return true;
      }

      await safePushAudit(guildId, {
        user: auditUser,
        action: `Correctif de sécurité appliqué : ${findingId}`,
        context: getGuildName(client, guildId),
        module: 'SecurityAudit',
        eventType: 'Manuel',
        details: outcome.message,
        channelId: null,
      }, 'RaidProtectionAPI');

      // Le rapport est recalculé pour que l'UI reflète immédiatement l'effet.
      const report = await runSecurityAudit(guild, { deep: false });
      json(res, 200, { success: true, message: outcome.message, report });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur POST audit/fix:', err);
      jsonFailure(res, err, 'Erreur lors de l\'application du correctif', 'RaidProtectionAPI');
    }
    return true;
  }

  // POST /raid-protection/audit/fix-all - applique tout ce qui est sans risque
  //
  // Les correctifs `risky` sont exclus cote service : ils modifient des
  // permissions existantes et gardent leur confirmation individuelle.
  if (sub === 'audit' && parts[6] === 'fix-all' && method === 'POST') {
    try {
      const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
      if (!guild) {
        json(res, 404, { error: 'Serveur introuvable' });
        return true;
      }

      const { applied, failed } = await applySafeAuditFixes(
        guild,
        `Correctifs d'audit appliques en lot par ${auditUser}`,
      );

      if (applied.length > 0) {
        await safePushAudit(guildId, {
          user: auditUser,
          action: `Correctifs de securite appliques en lot : ${applied.length}`,
          context: getGuildName(client, guildId),
          module: 'SecurityAudit',
          eventType: 'Manuel',
          details: applied.map((a) => a.title).join(', '),
          channelId: null,
        }, 'RaidProtectionAPI');
      }

      // Rapport recalcule pour que le score et la liste refletent le lot.
      const report = await runSecurityAudit(guild, { deep: false });
      json(res, 200, { success: true, applied, failed, report });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur POST audit/fix-all:', err);
      jsonFailure(res, err, "Erreur lors de l'application des correctifs", 'RaidProtectionAPI');
    }
    return true;
  }

  return false;
}
