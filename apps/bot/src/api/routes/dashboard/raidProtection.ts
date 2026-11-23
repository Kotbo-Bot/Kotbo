import { Hono } from 'hono';
import type { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { safePushAudit, getGuildName } from '../../shared.js';
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

import { fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';
import { MAX_OTHER_SERVERS, resolveInvite } from '../../../services/moderation/otherServersFilter.js';
import { FILE_GROUPS, MAX_FILE_RULES, invalidateFileRules, normalizeExtensions } from '../../../services/moderation/fileExtensionFilter.js';
import { MAX_AUTO_SANCTION_DURATION_MIN, normalizeAutoSanction } from '../../../services/moderation/autoSanction.js';
import {
  createShieldPanelChannel,
  createShieldStatusChannel,
  isShieldLevel,
  postShieldPanel,
  setShieldLevel,
} from '../../../services/moderation/shieldService.js';
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
  'captchaTrigger', 'captchaUseServerIcon',
  'antiRaidEnabled', 'antiRaidJoinThreshold', 'antiRaidJoinWindowSec', 'antiRaidAction',
  'antiRaidAlertChannelId', 'antiRaidAutoDisableMinutes',
  'accountAgeGuardEnabled', 'accountAgeMinValue', 'accountAgeMinUnit', 'accountAgeAction',
  'accountAgeAlertChannelId', 'accountAgeMessage', 'accountAgeWhitelist',
  'joinLockKick', 'joinLockMessage',
  'reportsEnabled', 'reportsChannelId', 'reportsCooldownSec', 'reportsAnonymous',
  'tagRoleEnabled', 'tagRoleId',
  'rolePersistEnabled', 'rolePersistMode', 'rolePersistRoleIds', 'rolePersistMaxDays', 'rolePersistStaff',
  'scamFilterEnabled', 'scamFilterAction', 'scamFilterTimeoutMin', 'scamFilterCustomDomains',
  'scamFilterWhitelist', 'scamFilterAlertChannelId', 'scamImageFilterEnabled',
  'scamQrFilterEnabled', 'scamQrTrustedMessages', 'scamOcrEnabled',
  'visionEnabled', 'visionSanction', 'visionDurationMin', 'visionReviewChannelId', 'visionNotifyMember', 'visionUncertainDelete',
  'jailRoleId', 'jailChannelId', 'jailStripRoles', 'discordQuarantineSyncEnabled',
  'otherInvitesMode', 'otherFriendInvites', 'otherForwardsMode', 'otherTagsMode', 'otherServers', 'otherSanction', 'otherDurationMin',
  'fileFilterMode', 'fileGroups', 'fileExtensions', 'fileRejectCorrupted', 'fileSanction', 'fileDurationMin',
  'inviteGuardEnabled', 'inviteRequireUnitary', 'inviteValidationEnabled',
  'inviteSpamThreshold', 'inviteSpamWindowSec', 'inviteAlertChannelId', 'inviteBypassRoleIds',
] as const;

export function createRaidProtectionRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);


  router.post(`${base}/raid-protection/other-servers`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = (await readBody(c)) ?? {};
      const code = String(body.invite ?? '').trim().replace(/^.*\//, '');
      const invite = code ? await resolveInvite(client, code) : { kind: 'INVALID' as const };
      if (invite.kind !== 'GUILD') {
        return send(c, { error: 'Invitation invalide ou expirée : colle une invitation vers le serveur à ajouter.' }, 400);
      }
      const config = (await getRaidProtectionConfig(guildId)) ?? (await upsertRaidProtectionConfig(guildId, {}));
      const others = config.otherServers.filter((entry) => !entry.startsWith(`${invite.guildId}|`));
      if (others.length >= MAX_OTHER_SERVERS) {
        return send(c, { error: `${MAX_OTHER_SERVERS} serveurs au plus dans la liste.` }, 409);
      }
      const updated = await upsertRaidProtectionConfig(guildId, { otherServers: [...others, `${invite.guildId}|${invite.guildName.replace(/\|/g, ' ')}`] });
      return send(c, { config: updated });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur ajout serveur:', err);
      return fail(c, err, 'Erreur lors de l\'ajout du serveur', 'RaidProtectionAPI');
    }
  });

  router.on(['GET', 'POST', 'DELETE'], [`${base}/raid-protection/file-rules`, `${base}/raid-protection/file-rules/:ruleId`], ...gate, async (c) => {
    const guildId = c.req.param('guildId')!;
    const method = c.req.method;
    const ruleId = c.req.param('ruleId');
    try {
      if (method === 'GET') {
        return send(c, { rules: await prisma.fileFilterRule.findMany({ where: { guildId }, orderBy: { createdAt: 'asc' } }), groups: FILE_GROUPS, maxRules: MAX_FILE_RULES });
      }
      if (method === 'POST') {
        const body = (await readBody(c)) ?? {};
        const targetId = String(body.targetId ?? '');
        const target = client.guilds.cache.get(guildId)?.channels.cache.get(targetId);
        if (!target) {
          return send(c, { error: 'Salon ou catégorie introuvable.' }, 400);
        }
        const exists = await prisma.fileFilterRule.findUnique({ where: { guildId_targetId: { guildId, targetId } }, select: { id: true } });
        if (!exists && (await prisma.fileFilterRule.count({ where: { guildId } })) >= MAX_FILE_RULES) {
          return send(c, { error: `${MAX_FILE_RULES} règles au plus.` }, 409);
        }
        const data = {
          targetType: target.type === 4 ? 'CATEGORY' : 'CHANNEL',
          mode: body.mode === 'WHITELIST' ? 'WHITELIST' : 'BLACKLIST',
          groups: (Array.isArray(body.groups) ? body.groups : []).map(String).filter((g: string) => g in FILE_GROUPS),
          extensions: normalizeExtensions(body.extensions),
        };
        const rule = await prisma.fileFilterRule.upsert({
          where: { guildId_targetId: { guildId, targetId } },
          create: { guildId, targetId, ...data },
          update: data,
        });
        await invalidateFileRules(guildId);
        return send(c, { rule });
      }
      if (method === 'DELETE' && ruleId) {
        await prisma.fileFilterRule.deleteMany({ where: { id: ruleId, guildId } });
        await invalidateFileRules(guildId);
        return send(c, { success: true });
      }
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur règles de fichiers:', err);
      return fail(c, err, 'Erreur sur les règles de fichiers', 'RaidProtectionAPI');
    }
  });

  router.on(['POST'], [`${base}/raid-protection/shield`, `${base}/raid-protection/shield/:shieldAction{panel|status}`], ...gate, async (c) => {
    const shieldAction = c.req.param('shieldAction');
    const guildId = c.req.param('guildId')!;
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        return send(c, { error: 'Serveur introuvable' }, 404);
      }
      const body = (await readBody(c)) ?? {};
      if (!shieldAction) {
        const level = Number(body.level);
        if (!isShieldLevel(level)) {
          return send(c, { error: 'Niveau Shield invalide (1 à 5)' }, 400);
        }
        const result = await setShieldLevel(guild, level, user.userId);
        await safePushAudit(guildId, { user: auditUser, action: `Shield ${result.previous} → ${result.level}`, context: getGuildName(client, guildId), module: 'RaidProtection', eventType: 'Manuel', details: result.warnings.join(' | '), channelId: null }, 'RaidProtectionAPI');
        return send(c, { ...result, config: await getRaidProtectionConfig(guildId) });
      }
      if (shieldAction === 'panel') {
        const channelId = body.create === true ? await createShieldPanelChannel(guild) : String(body.channelId ?? '');
        const result = await postShieldPanel(guild, channelId);
        if (!result.ok) {
          return send(c, { error: result.reason }, 400);
        }
        return send(c, { channelId, config: await getRaidProtectionConfig(guildId) });
      }
      if (shieldAction === 'status') {
        const channelId = await createShieldStatusChannel(guild);
        return send(c, { channelId, config: await getRaidProtectionConfig(guildId) });
      }
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur Shield:', err);
      return fail(c, err, 'Erreur Shield', 'RaidProtectionAPI');
    }
  });

  //
  // La config est creee si elle manque, comme le fait /automod. Un serveur que
  // le bot vient de rejoindre n'a pas encore de ligne, et renvoyer `null`
  // obligeait chaque appelant a inventer son propre repli : la page Anti-raid
  // retombait sur un objet vide, la configuration rapide du hub echouait. La
  // creation est sans effet, tous les interrupteurs du modele etant a false par
  // defaut - seul joinLockKick vaut true, et il ne joue que si joinLockEnabled
  // est actif.
  router.get(`${base}/raid-protection`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const [config, reportStats, pendingInvites, scamImageCount] = await Promise.all([
        getRaidProtectionConfig(guildId).then((c) => c ?? upsertRaidProtectionConfig(guildId, {})),
        getReportStats(guildId),
        prisma.inviteApprovalRequest.count({ where: { guildId, status: 'PENDING' } }),
        prisma.scamImageHash.count({ where: { OR: [{ guildId }, { guildId: null }] } }),
      ]);
      return send(c, { config, reportStats, pendingInvites, scamImageCount });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur GET config:', err);
      return fail(c, err, 'Erreur lors de la récupération de la configuration', 'RaidProtectionAPI');
    }
  });

  router.patch(`${base}/raid-protection`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    try {
      const body = await readBody<Record<string, unknown>>(c);
      if (!body) {
        return send(c, { error: 'Corps de requête manquant' }, 400);
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
      if ('accountAgeAction' in data && !['ALERT', 'KICK', 'BAN', 'JAIL', 'TEMPBAN'].includes(String(data.accountAgeAction))) data.accountAgeAction = 'KICK';
      if ('accountAgeWhitelist' in data) {
        const list = Array.isArray(data.accountAgeWhitelist) ? data.accountAgeWhitelist : [];
        data.accountAgeWhitelist = [...new Set(list.map((id) => String(id).trim()).filter((id) => /^\d{17,20}$/.test(id)))];
      }
      if ('rolePersistMode' in data && data.rolePersistMode !== 'LIST') data.rolePersistMode = 'ALL';
      const LIST_MODES = ['OFF', 'BLACKLIST', 'WHITELIST'];
      for (const field of ['otherInvitesMode', 'otherForwardsMode', 'otherTagsMode', 'fileFilterMode']) {
        if (field in data && !LIST_MODES.includes(String(data[field]))) data[field] = 'OFF';
      }
      if ('otherFriendInvites' in data && !['FOLLOW', 'ALLOW', 'BLOCK'].includes(String(data.otherFriendInvites))) data.otherFriendInvites = 'FOLLOW';
      // La liste ne se modifie ici que pour retirer des serveurs : on n'en
      // ajoute qu'en collant une invitation valide (route other-servers).
      if ('otherServers' in data) {
        const current = new Set((await getRaidProtectionConfig(guildId))?.otherServers ?? []);
        data.otherServers = (Array.isArray(data.otherServers) ? data.otherServers : []).map(String).filter((entry) => current.has(entry));
      }
      if ('fileGroups' in data) data.fileGroups = (Array.isArray(data.fileGroups) ? data.fileGroups : []).map(String).filter((g) => g in FILE_GROUPS);
      if ('fileExtensions' in data) data.fileExtensions = normalizeExtensions(data.fileExtensions);
      for (const field of ['otherSanction', 'fileSanction']) {
        if (field in data) data[field] = normalizeAutoSanction(data[field], 'DELETE');
      }
      for (const field of ['otherDurationMin', 'fileDurationMin']) {
        if (field in data) {
          const minutes = data[field] === null || data[field] === '' ? null : Math.floor(Number(data[field]));
          data[field] = minutes && minutes > 0 ? Math.min(minutes, MAX_AUTO_SANCTION_DURATION_MIN) : null;
        }
      }
      if ('captchaTrigger' in data && !['ALWAYS', 'AUTO', 'SMART'].includes(String(data.captchaTrigger))) data.captchaTrigger = 'ALWAYS';
      if ('visionSanction' in data && !['DELETE', 'WARN', 'TIMEOUT', 'KICK', 'SOFTBAN', 'BAN', 'JAIL'].includes(String(data.visionSanction))) data.visionSanction = 'TIMEOUT';
      if ('visionDurationMin' in data) {
        const minutes = data.visionDurationMin === null || data.visionDurationMin === '' ? null : Math.floor(Number(data.visionDurationMin));
        data.visionDurationMin = minutes && minutes > 0 ? Math.min(minutes, MAX_AUTO_SANCTION_DURATION_MIN) : null;
      }
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
      return send(c, { config });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur PATCH config:', err);
      return fail(c, err, 'Erreur lors de la mise à jour de la configuration', 'RaidProtectionAPI');
    }
  });

  router.post(`${base}/raid-protection/raidmode`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    try {
      const body = await readBody<{ active?: boolean }>(c);
      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        return send(c, { error: 'Serveur introuvable' }, 404);
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
      return send(c, { config: await getRaidProtectionConfig(guildId) });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur raidmode:', err);
      return fail(c, err, 'Erreur lors du changement de mode raid', 'RaidProtectionAPI');
    }
  });

  router.post(`${base}/raid-protection/:sub{joinlock|dmlock}`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    const sub = c.req.param('sub');
    try {
      const body = await readBody<{ active?: boolean; hours?: number }>(c);
      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        return send(c, { error: 'Serveur introuvable' }, 404);
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
      return send(c, { config: await getRaidProtectionConfig(guildId) });
    } catch (err) {
      logger.error('RaidProtectionAPI', `Erreur ${sub}:`, err);
      return fail(c, err, 'Erreur lors du changement de verrou', 'RaidProtectionAPI');
    }
  });

  router.post(`${base}/raid-protection/invite-emergency`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    try {
      const body = await readBody<{ active?: boolean }>(c);
      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        return send(c, { error: 'Serveur introuvable' }, 404);
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
      return send(c, { config: await getRaidProtectionConfig(guildId), deleted });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur invite-emergency:', err);
      return fail(c, err, 'Erreur lors du changement du mode urgence', 'RaidProtectionAPI');
    }
  });

  router.get(`${base}/raid-protection/reports`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const status = c.req.query('status') ?? undefined;
      const reports = await prisma.memberReport.findMany({
        where: { guildId, ...(status ? { status } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      return send(c, { reports });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur GET reports:', err);
      return fail(c, err, 'Erreur lors de la récupération des signalements', 'RaidProtectionAPI');
    }
  });

  router.post(`${base}/raid-protection/reports/:id/decision`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const id = c.req.param('id');
    try {
      const body = await readBody<{ resolved?: boolean }>(c);
      const report = await handleReportDecision(guildId, id, user.userId, Boolean(body?.resolved));
      if (!report) {
        return send(c, { error: 'Signalement introuvable ou déjà traité' }, 404);
      }
      return send(c, { report });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur decision report:', err);
      return fail(c, err, 'Erreur lors du traitement du signalement', 'RaidProtectionAPI');
    }
  });

  router.get(`${base}/raid-protection/invite-requests`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const requests = await prisma.inviteApprovalRequest.findMany({
        where: { guildId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      return send(c, { requests });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur GET invite-requests:', err);
      return fail(c, err, 'Erreur lors de la récupération des demandes', 'RaidProtectionAPI');
    }
  });

  router.post(`${base}/raid-protection/invite-requests/:id/decision`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const id = c.req.param('id');
    try {
      const body = await readBody<{ approved?: boolean }>(c);
      const request = body?.approved
        ? await approveInviteRequest(client, guildId, id, user.userId)
        : await rejectInviteRequest(client, guildId, id, user.userId);
      if (!request) {
        return send(c, { error: 'Demande introuvable ou déjà traitée' }, 404);
      }
      return send(c, { request });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur decision invite:', err);
      return fail(c, err, 'Erreur lors du traitement de la demande', 'RaidProtectionAPI');
    }
  });

  router.get(`${base}/raid-protection/spam`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const days = Math.min(90, Math.max(1, Number((c.req.query('days') ?? null)) || 14));
      const [config, stats] = await Promise.all([
        getSpamConfig(guildId),
        getCalibrationStats(guildId, days).catch(() => null),
      ]);
      return send(c, { config, stats });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur GET spam:', err);
      return fail(c, err, 'Erreur lors de la récupération de la configuration anti-spam', 'RaidProtectionAPI');
    }
  });

  router.patch(`${base}/raid-protection/spam`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    try {
      const body = await readBody<Record<string, unknown>>(c);
      if (!body) {
        return send(c, { error: 'Corps de requête manquant' }, 400);
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
          return send(c, { error: 'Les paliers doivent être croissants : journalisation ≤ suppression ≤ exclusion ≤ bannissement.' }, 400);
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
      return send(c, { config });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur PATCH spam:', err);
      return fail(c, err, 'Erreur lors de la mise à jour de la configuration anti-spam', 'RaidProtectionAPI');
    }
  });

  router.get(`${base}/raid-protection/spam/samples`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const pendingOnly = (c.req.query('pending') ?? null) === '1';
      const minScore = Number((c.req.query('minScore') ?? null)) || 0;
      const samples = await prisma.spamDetectionSample.findMany({
        where: {
          guildId,
          ...(pendingOnly ? { label: null } : {}),
          ...(minScore > 0 ? { score: { gte: minScore } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      return send(c, { samples });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur GET spam/samples:', err);
      return fail(c, err, 'Erreur lors de la récupération des détections', 'RaidProtectionAPI');
    }
  });

  router.post(`${base}/raid-protection/spam/samples/:id/decision`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    const id = c.req.param('id');
    try {
      const body = await readBody<{ truePositive?: boolean }>(c);
      if (typeof body?.truePositive !== 'boolean') {
        return send(c, { error: 'Champ truePositive manquant' }, 400);
      }

      const label = body.truePositive ? 'TRUE_POSITIVE' : 'FALSE_POSITIVE';
      const ok = await recordSpamDecision(guildId, id, label, user.userId);
      if (!ok) {
        return send(c, { error: 'Détection introuvable' }, 404);
      }

      await safePushAudit(guildId, {
        user: auditUser,
        action: `Détection anti-spam labellisée ${label === 'TRUE_POSITIVE' ? 'vrai positif' : 'faux positif'}`,
        context: getGuildName(client, guildId),
        module: 'AntiSpam',
        eventType: 'Manuel',
        details: id,
        channelId: null,
      }, 'RaidProtectionAPI');
      return send(c, { success: true });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur POST spam/decision:', err);
      return fail(c, err, 'Erreur lors de l\'enregistrement de la décision', 'RaidProtectionAPI');
    }
  });

  router.get(`${base}/raid-protection/lineage/:userId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const userId = c.req.param('userId');
    try {
      const report = await getLineageReport(guildId, userId);
      return send(c, { report });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur GET lineage:', err);
      return fail(c, err, 'Erreur lors du calcul du lignage', 'RaidProtectionAPI');
    }
  });

  router.post(`${base}/raid-protection/lineage/:userId/quarantine`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    const userId = c.req.param('userId');
    try {
      const body = await readBody<{
        dryRun?: boolean;
        maxDepth?: number;
        sinceDays?: number;
        quarantineRoleId?: string | null;
      }>(c);

      const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
      if (!guild) {
        return send(c, { error: 'Serveur introuvable' }, 404);
      }

      const result = await quarantineLineage(guild, userId, {
        dryRun: body?.dryRun !== false,
        maxDepth: body?.maxDepth,
        since: body?.sinceDays ? new Date(Date.now() - body.sinceDays * 86_400_000) : undefined,
        quarantineRoleId: body?.quarantineRoleId ?? null,
        reason: `Quarantaine de lignage depuis ${userId}, demandée par ${auditUser}`,
      });

      if (!result.dryRun) {
        await safePushAudit(guildId, {
          user: auditUser,
          action: `Quarantaine de lignage appliquée depuis ${userId}`,
          context: getGuildName(client, guildId),
          module: 'InviteLineage',
          eventType: 'Manuel',
          details: `${result.applied} appliquée(s), ${result.skipped} ignorée(s), ${result.failed} échec(s)`,
          channelId: null,
        }, 'RaidProtectionAPI');
      }

      return send(c, { result });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur POST lineage/quarantine:', err);
      return fail(c, err, 'Erreur lors de la mise en quarantaine', 'RaidProtectionAPI');
    }
  });

  router.get(`${base}/raid-protection/audit`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
      if (!guild) {
        return send(c, { error: 'Serveur introuvable' }, 404);
      }
      const deep = (c.req.query('deep') ?? null) !== '0';
      const report = await runSecurityAudit(guild, { deep });
      return send(c, { report });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur GET audit:', err);
      return fail(c, err, 'Erreur lors de l\'audit de sécurité', 'RaidProtectionAPI');
    }
  });

  router.post(`${base}/raid-protection/audit/fix`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    try {
      const body = await readBody<{ findingId?: string }>(c);
      const findingId = body?.findingId;
      if (!findingId) {
        return send(c, { error: 'findingId manquant' }, 400);
      }
      const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
      if (!guild) {
        return send(c, { error: 'Serveur introuvable' }, 404);
      }

      const outcome = await applyAuditFix(guild, findingId, `Correctif d'audit appliqué par ${auditUser}`);
      if (!outcome.ok) {
        return send(c, { error: outcome.message }, 400);
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
      return send(c, { success: true, message: outcome.message, report });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur POST audit/fix:', err);
      return fail(c, err, 'Erreur lors de l\'application du correctif', 'RaidProtectionAPI');
    }
  });

  //
  // Les correctifs `risky` sont exclus cote service : ils modifient des
  // permissions existantes et gardent leur confirmation individuelle.
  router.post(`${base}/raid-protection/audit/fix-all`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    try {
      const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
      if (!guild) {
        return send(c, { error: 'Serveur introuvable' }, 404);
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
      return send(c, { success: true, applied, failed, report });
    } catch (err) {
      logger.error('RaidProtectionAPI', 'Erreur POST audit/fix-all:', err);
      return fail(c, err, "Erreur lors de l'application des correctifs", 'RaidProtectionAPI');
    }
  });

  return router;
}

