import type { Client } from 'discord.js';
import { Hono } from 'hono';
/** Routes dashboard du module `verification`. */
import { cache } from '../../../../utils/cache.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { getGuildName, pushAudit } from '../../../shared.js';
import { readWordStatsEnabled, startWordStatsBackfillIfTurnedOn } from './_shared.js';

import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
import { normalizeWarnWeight } from '../../../../services/moderation/warnWeight.js';
/**
 * La verification de securite se reglait depuis `channels-management`, segment
 * du module « Auto-thread & salons », alors qu'elle ne s'affiche que dans
 * l'onglet Verification de la page Comptes multiples et que le bot l'applique a
 * l'arrivee d'un membre sans regarder ce module. Sur un serveur qui n'avait pas
 * allume les salons - c'est le defaut - l'onglet recevait un `module_disabled`
 * en lecture comme en ecriture, y compris pour un administrateur.
 *
 * Les champs vivent donc sous leur propre segment, celui que le registre
 * attribuait deja au module « Verification de securite ». Les reglages de warns
 * et d'hygiene des bannissements suivent : le meme onglet les affiche, et aucune
 * autre page ne les ecrit. Les statistiques de mots gardent leur seconde porte
 * dans `channels-management`, ou le panneau d'analytique avancee les allume.
 */
export function createVerificationModuleRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);


  router.get(`${base}/verification`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const guild = await prisma.guild.findUnique({
        where: { id: guildId },
        select: {
          verificationEnabled: true,
          verificationMode: true,
          verificationAction: true,
          verificationChannelId: true,
          verificationFallbackChannelId: true,
          verificationRoleId: true,
          verificationLogChannelId: true,
          verificationEmbedTitle: true,
          verificationEmbedDesc: true,
          verificationEmbedColor: true,
          verificationOnJoin: true,
          verificationSaveIp: true,
          verificationSaveDevice: true,
          verificationLevelCommand: true,
          verificationLevelJoin: true,
          verificationWarnThreshold: true,
          verificationWarnAutoMode: true,
          verificationWarnReason: true,
          warnWeightingEnabled: true,
          warnDecayDays: true,
          automodWarnWeight: true,
          countArchivedInWarnScore: true,
          warnAutoArchiveDays: true,
          wordStatsEnabled: true,
          banHygieneEnabled: true,
        },
      });
      if (!guild) {
        return send(c, { error: 'Serveur introuvable' }, 404);
      }
      return send(c, guild);
    } catch (err) {
      logger.error('VerificationAPI', 'GET config error:', err);
      return fail(c, err, 'Erreur lors de la récupération de la configuration', 'VerificationAPI');
    }
  });

  router.patch(`${base}/verification`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const auditUser = auditUserOf(c);
    try {
      const body = await readBody<{
        verificationEnabled?: boolean;
        verificationMode?: string;
        verificationAction?: string;
        verificationChannelId?: string | null;
        verificationFallbackChannelId?: string | null;
        verificationRoleId?: string | null;
        verificationLogChannelId?: string | null;
        verificationEmbedTitle?: string;
        verificationEmbedDesc?: string;
        verificationEmbedColor?: string;
        verificationOnJoin?: boolean;
        verificationSaveIp?: boolean;
        verificationSaveDevice?: boolean;
        verificationLevelCommand?: string;
        verificationLevelJoin?: string;
        verificationWarnThreshold?: number | null;
        verificationWarnAutoMode?: string;
        verificationWarnReason?: string;
        warnWeightingEnabled?: boolean;
        warnDecayDays?: number | null;
        automodWarnWeight?: number;
        countArchivedInWarnScore?: boolean;
        warnAutoArchiveDays?: number | null;
        wordStatsEnabled?: boolean;
        banHygieneEnabled?: boolean;
      }>(c);

      if (!body) {
        return send(c, { error: 'Payload invalide' }, 400);
      }

      const has = (field: string) => Object.prototype.hasOwnProperty.call(body, field);
      const data: Record<string, unknown> = {};

      if (has('verificationEnabled')) data.verificationEnabled = !!body.verificationEnabled;
      if (has('verificationMode') && ['DM', 'EMBED'].includes(body.verificationMode as string)) {
        data.verificationMode = body.verificationMode;
      }
      if (has('verificationAction') && ['AUTO_LINK', 'NOTIFY_STAFF'].includes(body.verificationAction as string)) {
        data.verificationAction = body.verificationAction;
      }
      if (has('verificationChannelId')) data.verificationChannelId = body.verificationChannelId;
      if (has('verificationFallbackChannelId')) data.verificationFallbackChannelId = body.verificationFallbackChannelId;
      if (has('verificationRoleId')) data.verificationRoleId = body.verificationRoleId;
      if (has('verificationLogChannelId')) data.verificationLogChannelId = body.verificationLogChannelId;
      if (has('verificationEmbedTitle')) data.verificationEmbedTitle = (body.verificationEmbedTitle || '').slice(0, 256);
      if (has('verificationEmbedDesc')) data.verificationEmbedDesc = (body.verificationEmbedDesc || '').slice(0, 2048);
      if (has('verificationEmbedColor')) data.verificationEmbedColor = body.verificationEmbedColor;
      if (has('verificationOnJoin')) data.verificationOnJoin = !!body.verificationOnJoin;
      if (has('verificationSaveIp')) data.verificationSaveIp = !!body.verificationSaveIp;
      if (has('verificationSaveDevice')) data.verificationSaveDevice = !!body.verificationSaveDevice;
      if (has('verificationLevelCommand') && ['LINK', 'LOW', 'MEDIUM', 'HIGH'].includes(body.verificationLevelCommand as string)) {
        data.verificationLevelCommand = body.verificationLevelCommand;
      }
      if (has('verificationLevelJoin') && ['LINK', 'LOW', 'MEDIUM', 'HIGH'].includes(body.verificationLevelJoin as string)) {
        data.verificationLevelJoin = body.verificationLevelJoin;
      }
      if (has('verificationWarnThreshold')) {
        // null ou 0 = seuil desactive, entier positif = seuil
        if (body.verificationWarnThreshold === null || body.verificationWarnThreshold === 0) {
          data.verificationWarnThreshold = null;
        } else if (typeof body.verificationWarnThreshold === 'number' && body.verificationWarnThreshold > 0) {
          data.verificationWarnThreshold = Math.floor(body.verificationWarnThreshold);
        }
      }
      if (has('verificationWarnAutoMode') && ['FULL_AUTO', 'NOTIFY_STAFF'].includes(body.verificationWarnAutoMode as string)) {
        data.verificationWarnAutoMode = body.verificationWarnAutoMode;
      }
      if (has('verificationWarnReason')) data.verificationWarnReason = (body.verificationWarnReason || '').slice(0, 512);
      if (has('warnWeightingEnabled')) data.warnWeightingEnabled = !!body.warnWeightingEnabled;
      if (has('warnDecayDays')) {
        // null ou 0 = pas de décroissance, entier positif = fenêtre en jours
        if (body.warnDecayDays === null || body.warnDecayDays === 0) {
          data.warnDecayDays = null;
        } else if (typeof body.warnDecayDays === 'number' && body.warnDecayDays > 0) {
          data.warnDecayDays = Math.floor(body.warnDecayDays);
        }
      }
      if (has('automodWarnWeight') && typeof body.automodWarnWeight === 'number') {
        data.automodWarnWeight = normalizeWarnWeight(Math.floor(body.automodWarnWeight));
      }
      if (has('countArchivedInWarnScore')) data.countArchivedInWarnScore = !!body.countArchivedInWarnScore;
      if (has('warnAutoArchiveDays')) {
        // null ou 0 = pas d'expiration automatique des warns
        if (body.warnAutoArchiveDays === null || body.warnAutoArchiveDays === 0) {
          data.warnAutoArchiveDays = null;
        } else if (typeof body.warnAutoArchiveDays === 'number' && body.warnAutoArchiveDays > 0) {
          data.warnAutoArchiveDays = Math.floor(body.warnAutoArchiveDays);
        }
      }
      if (has('wordStatsEnabled')) data.wordStatsEnabled = !!body.wordStatsEnabled;
      if (has('banHygieneEnabled')) data.banHygieneEnabled = !!body.banHygieneEnabled;

      // Capturé avant l'update : sert à détecter la bascule off → on plus bas.
      const wordStatsWasEnabled = has('wordStatsEnabled') ? await readWordStatsEnabled(guildId) : null;

      await prisma.guild.update({ where: { id: guildId }, data });

      // Purge les caches préfixés guild:<id>: - config du bot (getCachedGuild)
      // et payloads d'analytics avancées, qui embarquent les toggles (ex.
      // wordStatsEnabled). Sans ça, le dashboard continue d'afficher l'ancien
      // état pendant toute la durée du TTL.
      await cache.invalidateGuild(guildId);

      startWordStatsBackfillIfTurnedOn(guildId, wordStatsWasEnabled, data.wordStatsEnabled, 'VerificationAPI');

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Sauvegarde configuration Vérification',
        context: getGuildName(client, guildId),
        module: 'Vérification de sécurité',
        eventType: 'Manuel',
        details: 'Configuration de la vérification de sécurité mise à jour.',
        channelId: null,
      });

      return send(c, { ok: true });
    } catch (err) {
      logger.error('VerificationAPI', 'PATCH config error:', err);
      return fail(c, err, 'Erreur lors de la mise à jour', 'VerificationAPI');
    }
  });

  return router;
}

