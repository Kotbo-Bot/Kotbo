/** Routes dashboard du module `sanctions`. */
import { Hono, type Context } from 'hono';
import type { Client } from 'discord.js';
import { generateTranscriptFromMessages } from '../../../../services/features/transcriptService.js';
import { formatSanctionDurationLabel, registerImportedSanction } from '../../../../services/moderation/sanctionService.js';
import {
  archiveSanctions,
  deleteSanctions,
  setSanctionAppealLock,
  unarchiveSanctions,
} from '../../../../services/moderation/sanctionArchiveService.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { EVIDENCE_CHANNEL_CONCURRENCY, type FetchedEvidenceChannel, fetchUserMessagesInChannel, MAX_EVIDENCE_MESSAGES, parseEvidenceLinks, resolveEvidenceChannel, serializeEvidenceMessage } from '../../../evidence.js';
import { getAuditActor, getGuildName, pushAudit, resolveMemberFeatureAccess } from '../../../shared.js';
import { SanctionType } from '@prisma/client';
import { ChannelType, type Message, PermissionFlagsBits, TextChannel } from 'discord.js';
import pLimit from 'p-limit';
import { type DashboardSanctionType, normalizeBrokenRulesPayload, toSanctionType, verifyMagicBytes } from './_shared.js';

import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
export function createSanctionsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);

  const helpers = (c: Context) => ({
    /**
     * Ecrire un rapport de sanction demande le droit de moderer « Sanctions ».
     *
     * La regle d avant ne regardait que l auteur du rapport : un compte a qui le
     * centre de gestion n accorde que la lecture pouvait encore creer un rapport
     * et modifier les siens, depuis la page Sanctions comme depuis le dossier
     * membre. `!== false` laisse la moderation Discord trancher quand le serveur
     * n a pose aucune regle de role sur la fonctionnalite.
     */
    canModerateSanctions: async (): Promise<boolean> => {
      const access = c.var.effectiveAccess;
      if (access.canManageSettings) return true;
      const featureAccess = await resolveMemberFeatureAccess(client, c.req.param('guildId')!, access, c.var.dashboardUser.userId);
      if (featureAccess.sanctions?.canModerate === true) return true;
      return access.canModerateContent && featureAccess.sanctions?.canModerate !== false;
    },
  });

  router.put(`${base}/sanctions/tables`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const access = c.var.effectiveAccess;
    const auditUser = auditUserOf(c);
    try {
      const tables = await readBody<Record<string, unknown>[]>(c);
      if (!Array.isArray(tables)) {
        return send(c, { error: 'Payload invalide. Doit être un tableau.' }, 400);
      }

      if (!access.canManageSettings) {
        return send(c, { error: 'Permissions insuffisantes pour modifier la configuration.' }, 403);
      }

      // La validation ci-dessous produit une structure typee reutilisee plus bas :
      // sans cela, les controles (`typeof table.name === 'string'`...) sont
      // perdus des qu'on change de boucle, et chaque lecture redevient `unknown`.
      type SanctionTierInput = {
        level: number;
        action: SanctionType;
        durationSeconds: number | null;
        customReason: string | null;
      };
      type SanctionTableInput = { id?: string; name: string; tiers: SanctionTierInput[] };

      const validatedTables: SanctionTableInput[] = [];

      for (const table of tables) {
        if (typeof table.name !== 'string' || !table.name.trim()) {
          return send(c, { error: 'Chaque tableau doit avoir un nom valide.' }, 400);
        }
        const tableName = table.name;
        if (!Array.isArray(table.tiers)) {
          return send(c, { error: `Le tableau "${tableName}" doit avoir une liste de paliers.` }, 400);
        }
        const rawTiers = table.tiers as Record<string, unknown>[];
        const levels = rawTiers.map((t) => Number(t.level));
        levels.sort((a, b) => a - b);
        for (let i = 0; i < levels.length; i++) {
          if (levels[i] !== i + 1) {
            return send(c, { error: `Les paliers du tableau "${tableName}" doivent être séquentiels et commencer par le niveau 1.` }, 400);
          }
        }

        const tiers: SanctionTierInput[] = [];
        for (const tier of rawTiers) {
          const action = String(tier.action) as SanctionType;
          if (!['WARN', 'KICK', 'TIMEOUT', 'TEMP_BAN', 'BAN', 'SOFTBAN'].includes(action)) {
            return send(c, { error: `Action invalide "${action}" dans le tableau "${tableName}".` }, 400);
          }
          let durationSeconds: number | null = null;
          if (['TIMEOUT', 'TEMP_BAN'].includes(action)) {
            const secs = Number(tier.durationSeconds);
            if (Number.isNaN(secs) || secs <= 0) {
              return send(c, { error: `Le palier de niveau ${tier.level} (${action}) du tableau "${tableName}" requiert une durée positive valide.` }, 400);
            }
            durationSeconds = secs;
          }
          tiers.push({
            level: Number(tier.level),
            action,
            durationSeconds,
            customReason: typeof tier.customReason === 'string' ? tier.customReason : null,
          });
        }

        validatedTables.push({
          id: typeof table.id === 'string' ? table.id : undefined,
          name: tableName,
          tiers,
        });
      }

      await prisma.$transaction(async (tx) => {
        const existingTables = await tx.sanctionTable.findMany({
          where: { guildId },
          include: { tiers: true },
        });

        const inputIds = new Set(validatedTables.map((t) => t.id).filter(Boolean));
        const tablesToDelete = existingTables.filter((t) => !inputIds.has(t.id));
        if (tablesToDelete.length > 0) {
          await tx.sanctionTable.deleteMany({
            where: { id: { in: tablesToDelete.map((t) => t.id) } },
          });
        }

        for (const table of validatedTables) {
          const matched = table.id ? existingTables.find((t) => t.id === table.id) : undefined;
          // Toujours defini a la sortie du if/else : soit le tableau existait,
          // soit il vient d'etre cree.
          let tableId: string;

          if (matched) {
            tableId = matched.id;
            if (matched.name !== table.name) {
              await tx.sanctionTable.update({
                where: { id: tableId },
                data: { name: table.name.trim() },
              });
            }
            await tx.sanctionTier.deleteMany({
              where: { tableId },
            });
          } else {
            const newTable = await tx.sanctionTable.create({
              data: {
                guildId,
                name: table.name.trim(),
              },
            });
            tableId = newTable.id;
          }

          if (table.tiers.length > 0) {
            await tx.sanctionTier.createMany({
              data: table.tiers.map((tier) => ({
                tableId,
                level: tier.level,
                action: tier.action,
                durationSeconds: tier.durationSeconds,
                customReason: tier.customReason?.trim() || null,
              })),
            });
          }
        }
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Mise à jour tableaux de sanction',
        context: getGuildName(client, guildId),
        module: 'Sanctions',
        eventType: 'Manuel',
        details: `Les tableaux de sanction ont été reconfigurés.`,
        channelId: null,
      });

      return send(c, { ok: true });
    } catch (err) {
      logger.error('SanctionsAPI', 'Error updating sanction tables:', err);
      return fail(c, err, 'Erreur lors de la mise à jour des tableaux de sanction', 'SanctionsAPI');
    }
  });

  //
  // Actions groupées sur une sélection de sanctions :
  //   archive / unarchive : désactiver (ou réactiver) en gardant la trace
  //   lock / unlock       : retirer (ou rendre) le droit de contester
  //   delete              : purger définitivement (administrateurs seulement)
  router.post(`${base}/sanctions/bulk`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const auditUser = auditUserOf(c);
    if (!access.canModerateContent) {
      return send(c, { error: 'Permissions insuffisantes pour gérer les infractions.' }, 403);
    }

    try {
      const body = await readBody<{ action?: string; sanctionIds?: unknown; reason?: string }>(c);
      const action = body?.action;
      const ids = Array.isArray(body?.sanctionIds)
        ? (body.sanctionIds as unknown[]).filter((id): id is string => typeof id === 'string' && id.length > 0)
        : [];

      if (!action || !['archive', 'unarchive', 'lock', 'unlock', 'delete'].includes(action)) {
        return send(c, { error: 'Action invalide.' }, 400);
      }
      if (ids.length === 0) {
        return send(c, { error: 'Aucune infraction sélectionnée.' }, 400);
      }
      if (ids.length > 200) {
        return send(c, { error: 'Sélection trop large (200 infractions maximum).' }, 400);
      }
      // La suppression est irréversible : elle reste réservée aux admins, comme
      // la suppression unitaire existante.
      if (action === 'delete' && access.level !== 'admin') {
        return send(c, { error: 'Seuls les administrateurs peuvent supprimer une infraction.' }, 403);
      }

      const actor = { userId: user.userId, tag: auditUser };
      const reason = typeof body?.reason === 'string' ? body.reason : null;

      const result =
        action === 'archive' ? await archiveSanctions(guildId, ids, actor, reason)
        : action === 'unarchive' ? await unarchiveSanctions(guildId, ids, actor)
        : action === 'lock' ? await setSanctionAppealLock(guildId, ids, true, actor, reason)
        : action === 'unlock' ? await setSanctionAppealLock(guildId, ids, false, actor)
        : await deleteSanctions(guildId, ids, actor);

      const labels: Record<string, string> = {
        archive: 'Archivage infractions',
        unarchive: 'Désarchivage infractions',
        lock: 'Verrouillage contestation',
        unlock: 'Déverrouillage contestation',
        delete: 'Suppression infractions',
      };

      await pushAudit(guildId, {
        user: auditUser,
        action: labels[action],
        context: getGuildName(client, guildId),
        module: 'Sanctions',
        eventType: 'Manuel',
        details: `${result.count} infraction(s) sur ${ids.length} sélectionnée(s).${reason ? ` Motif: ${reason}` : ''}`,
        channelId: null,
      });

      return send(c, { ok: true, count: result.count });
    } catch (err) {
      logger.error('SanctionsAPI', 'Error running bulk sanction action:', err);
      return fail(c, err, "Erreur lors de l'action groupée", 'SanctionsAPI');
    }
  });

  router.delete(`${base}/sanctions/:sanctionId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const access = c.var.effectiveAccess;
    const auditUser = auditUserOf(c);
    if (access.level !== 'admin') {
      return send(c, { error: 'Seuls les administrateurs peuvent supprimer une infraction.' }, 403);
    }

    const sanctionId = c.req.param('sanctionId');
    try {
      const sanction = await prisma.sanction.findFirst({
        where: { id: sanctionId, guildId },
        select: {
          id: true,
          type: true,
          targetTag: true,
          targetUserId: true,
        }
      });

      if (!sanction) {
        return send(c, { error: 'Infraction introuvable sur ce serveur.' }, 404);
      }

      await prisma.sanction.delete({ where: { id: sanction.id } });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Suppression infraction',
        context: getGuildName(client, guildId),
        module: 'Sanctions',
        eventType: 'Manuel',
        details: `Infraction ${sanction.id} supprimée (${sanction.type}) pour ${sanction.targetTag ?? sanction.targetUserId}.`,
        channelId: null
      });

      return send(c, { ok: true });
    } catch (err) {
      logger.error('SanctionsAPI', 'Error deleting sanction:', err);
      return fail(c, err, "Erreur lors de la suppression de l'infraction", 'SanctionsAPI');
    }
  });

  router.post(`${base}/sanctions/import`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const auditUser = auditUserOf(c);
    if (!access.canModerateContent) {
      return send(c, { error: 'Permissions insuffisantes pour importer des sanctions.' }, 403);
    }

    try {
      const body = await readBody<{
        source?: string;
        rows?: Array<{
          type?: string;
          targetUserId?: string;
          targetTag?: string | null;
          moderatorUserId?: string | null;
          moderatorTag?: string | null;
          reason?: string;
          createdAt?: string;
          durationSeconds?: number | null;
        }>;
      }>(c);

      const rows = Array.isArray(body?.rows) ? body!.rows! : null;
      if (!rows || rows.length === 0) {
        return send(c, { error: 'Aucune ligne à importer.' }, 400);
      }
      if (rows.length > 1000) {
        return send(c, { error: 'Maximum 1000 sanctions par import. Divisez votre fichier en plusieurs lots.' }, 400);
      }

      const sourceLabel = body?.source?.trim() || undefined;
      const validTypes: DashboardSanctionType[] = ['WARN', 'KICK', 'TIMEOUT', 'TEMP_BAN', 'BAN', 'SOFTBAN'];
      const snowflakeRe = /^\d{17,20}$/;

      let imported = 0;
      let skippedDuplicates = 0;
      const errors: Array<{ index: number; error: string }> = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        try {
          const type = String(row.type ?? '').toUpperCase();
          if (!validTypes.includes(type as DashboardSanctionType)) {
            errors.push({ index: i, error: `Type de sanction invalide : "${row.type}".` });
            continue;
          }

          const targetUserId = row.targetUserId?.trim() ?? '';
          if (!snowflakeRe.test(targetUserId)) {
            errors.push({ index: i, error: `ID Discord de la cible invalide : "${row.targetUserId}".` });
            continue;
          }

          const reason = row.reason?.trim() || 'Sanction importée (raison non renseignée).';

          const createdAt = row.createdAt ? new Date(row.createdAt) : null;
          if (!createdAt || Number.isNaN(createdAt.getTime())) {
            errors.push({ index: i, error: `Date invalide : "${row.createdAt}".` });
            continue;
          }

          const moderatorUserId = row.moderatorUserId?.trim() && snowflakeRe.test(row.moderatorUserId.trim())
            ? row.moderatorUserId.trim()
            : user.userId;
          const moderatorTag = row.moderatorTag?.trim() || (moderatorUserId === user.userId ? auditUser : 'Import');

          const existing = await prisma.sanction.findFirst({
            where: {
              guildId,
              type: toSanctionType(type as DashboardSanctionType),
              targetUserId,
              reason,
              createdAt: {
                gte: new Date(createdAt.getTime() - 60_000),
                lte: new Date(createdAt.getTime() + 60_000),
              },
            },
            select: { id: true },
          });
          if (existing) {
            skippedDuplicates++;
            continue;
          }

          await registerImportedSanction({
            guildId,
            type: toSanctionType(type as DashboardSanctionType),
            target: { id: targetUserId, tag: row.targetTag?.trim() || targetUserId },
            moderator: { id: moderatorUserId, tag: moderatorTag },
            reason,
            createdAt,
            durationSeconds: typeof row.durationSeconds === 'number' ? row.durationSeconds : null,
            sourceLabel,
          });
          imported++;
        } catch (rowErr) {
          errors.push({ index: i, error: rowErr instanceof Error ? rowErr.message : 'Erreur inconnue.' });
        }
      }

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Import de sanctions',
        context: getGuildName(client, guildId),
        module: 'Sanctions',
        eventType: 'Manuel',
        details: `${imported} sanction(s) importée(s)${sourceLabel ? ` depuis ${sourceLabel}` : ''}, ${skippedDuplicates} doublon(s) ignoré(s), ${errors.length} erreur(s).`,
        channelId: null
      });

      return send(c, { ok: true, imported, skippedDuplicates, errors });
    } catch (err) {
      logger.error('SanctionsAPI', 'Error importing sanctions:', err);
      return fail(c, err, "Erreur lors de l'import des sanctions.", 'SanctionsAPI');
    }
  });

  router.post(`${base}/sanctions/evidence-files`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const { canModerateSanctions } = helpers(c);
    if (!(await canModerateSanctions())) {
      return send(c, { error: 'Action non autorisée. Modération des sanctions requise.' }, 403);
    }
    try {
      const body = await readBody<{
        sanctionId?: string | null;
        fileName?: string;
        mimeType?: string;
        data?: string; // base64 encoded
      }>(c);

      const sanctionId = body?.sanctionId?.trim() || null;
      const fileName = body?.fileName?.trim() || 'unnamed_file';
      const mimeType = body?.mimeType?.trim() || '';
      const dataStr = body?.data || '';

      if (!mimeType || !dataStr) {
        return send(c, { error: 'mimeType et data sont requis.' }, 400);
      }

      // Valider le type MIME
      const allowedMimes = [
        'image/png', 'image/jpeg', 'image/gif', 'image/webp',
        'application/pdf',
        'video/mp4', 'video/webm', 'video/quicktime'
      ];
      if (!allowedMimes.includes(mimeType)) {
        return send(c, { error: `Type de fichier non autorisé : ${mimeType}. Veuillez utiliser une image (PNG, JPEG, GIF, WEBP), un PDF ou une vidéo (MP4, WEBM, MOV).` }, 400);
      }

      // Convertir base64 en buffer et valider la taille
      let buffer: Buffer;
      try {
        buffer = Buffer.from(dataStr, 'base64');
      } catch {
        return send(c, { error: 'Données de fichier encodées en base64 invalides.' }, 400);
      }

      const fileSize = buffer.length;
      if (fileSize > 10 * 1024 * 1024) {
        return send(c, { error: 'La taille maximale par fichier est de 10 Mo.' }, 400);
      }

      // Vérifier les magic bytes
      if (!verifyMagicBytes(buffer, mimeType)) {
        return send(c, { error: `La signature du fichier ne correspond pas au type MIME déclaré (${mimeType}).` }, 400);
      }

      // Si sanctionId est fourni, vérifier qu'elle existe
      if (sanctionId) {
        const sanction = await prisma.sanction.findFirst({
          where: { id: sanctionId, guildId }
        });
        if (!sanction) {
          return send(c, { error: 'Sanction liée introuvable.' }, 404);
        }

        // Limite de 6 fichiers max par sanction
        const existingCount = await prisma.sanctionEvidenceFile.count({
          where: { sanctionId }
        });
        if (existingCount >= 6) {
          return send(c, { error: 'Limite de 6 fichiers de preuve par sanction atteinte.' }, 400);
        }
      }

      // Vérification du quota du serveur (50 Mo cumulés)
      const totalExistingSizeResult = await prisma.sanctionEvidenceFile.aggregate({
        where: { guildId },
        _sum: { size: true }
      });
      const totalExistingSize = totalExistingSizeResult._sum.size ?? 0;
      const limitBytes = 50 * 1024 * 1024; // 50 Mo
      if (totalExistingSize + fileSize > limitBytes) {
        return send(c, {
          error: "Quota de stockage de preuves dépassé (50 Mo maximum par serveur). Veuillez passer à une offre payante/premium pour augmenter cette limite.",
          quotaExceeded: true
        }, 400);
      }

      // Création de l'enregistrement en base
      const file = await prisma.sanctionEvidenceFile.create({
        data: {
          guildId,
          sanctionId,
          fileName,
          mimeType,
          size: fileSize,
          data: new Uint8Array(buffer),
          uploadedByUserId: user.userId
        }
      });

      return send(c, { ok: true, id: file.id }, 201);
    } catch (err: unknown) {
      logger.error('SanctionsAPI', 'Error uploading evidence file:', err);
      return send(c, { error: "Erreur lors de l'upload du fichier de preuve." }, 500);
    }
  });

  router.get(`${base}/sanctions/evidence-files/:reportId/signed-url`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const reportId = c.req.param('reportId');
    const fileId = reportId;
    if (!/^[a-zA-Z0-9_-]+$/.test(fileId)) {
      return send(c, { error: 'ID de fichier invalide' }, 400);
    }
    try {
      const file = await prisma.sanctionEvidenceFile.findFirst({
        where: { id: fileId, guildId },
        select: { id: true }
      });
      if (!file) {
        return send(c, { error: 'Fichier introuvable.' }, 404);
      }
      const { generateEvidenceFileSignature } = await import('@kotbo/core');
      const { expires, signature } = generateEvidenceFileSignature(fileId, 3600);
      const signedUrl = `/api/public/sanction-evidence/${fileId}?expires=${expires}&sig=${signature}`;
      return send(c, { signedUrl });
    } catch (err: unknown) {
      logger.error('SanctionsAPI', `Error generating signed evidence URL: ${(err as Error).message}`);
      return send(c, { error: 'Erreur lors de la génération du lien signé.' }, 500);
    }
  });

  router.delete(`${base}/sanctions/evidence-files/:reportId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const reportId = c.req.param('reportId');
    const { canModerateSanctions } = helpers(c);
    const fileId = reportId;
    if (!(await canModerateSanctions())) {
      return send(c, { error: 'Action non autorisée. Modération des sanctions requise.' }, 403);
    }
    try {
      const file = await prisma.sanctionEvidenceFile.findFirst({
        where: { id: fileId, guildId }
      });
      if (!file) {
        return send(c, { error: 'Fichier introuvable.' }, 404);
      }
      await prisma.sanctionEvidenceFile.delete({ where: { id: fileId } });
      return send(c, { ok: true });
    } catch (err: unknown) {
      logger.error('SanctionsAPI', 'Error deleting evidence file:', err);
      return send(c, { error: 'Erreur lors de la suppression du fichier.' }, 500);
    }
  });

  router.post(`${base}/sanctions/reports`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = auditUserOf(c);
    const { canModerateSanctions } = helpers(c);
    if (!(await canModerateSanctions())) {
      return send(c, { error: 'Action non autorisée. Modération des sanctions requise.' }, 403);
    }
    try {
      const body = await readBody<{
        sanctionId?: string | null;
        staffPseudo?: string;
        incidentAt?: string;
        memberPseudo?: string;
        memberReference?: string;
        sanctionType?: string;
        sanctionDurationLabel?: string | null;
        brokenRules?: string;
        detailedReason?: string;
        evidenceLinks?: unknown;
        additionalNotes?: string | null;
      }>(c);

      const sanctionId = body?.sanctionId?.trim() ?? '';
      const brokenRules = normalizeBrokenRulesPayload(body?.brokenRules?.trim() ?? '');
      const detailedReason = body?.detailedReason?.trim() ?? '';
      const evidenceLinks = parseEvidenceLinks(body?.evidenceLinks);
      const incidentAt = body?.incidentAt ? new Date(body.incidentAt) : null;

      if (!sanctionId) {
        return send(c, { error: 'La sanction liée est obligatoire pour créer un rapport.' }, 400);
      }

      if (!incidentAt || Number.isNaN(incidentAt.getTime())) {
        return send(c, { error: "Date/heure de l'incident invalide." }, 400);
      }

      if (evidenceLinks.length === 0) {
        return send(c, { error: 'Au moins un lien de preuve valide est obligatoire.' }, 400);
      }

      const sanction = await prisma.sanction.findFirst({ where: { id: sanctionId, guildId } });
      if (!sanction) {
        return send(c, { error: 'Sanction liée introuvable sur ce serveur.' }, 404);
      }

      if (sanction.moderatorUserId !== user.userId) {
        return send(c, { error: 'Seule la personne qui a appliqué la sanction peut créer ce rapport.' }, 403);
      }

      const existingReport = await prisma.sanctionReport.findFirst({ where: { guildId, sanctionId } });
      if (existingReport) {
        return send(c, { error: 'Un rapport existe déjà pour cette sanction.' }, 409);
      }

      const staffPseudo = sanction.moderatorTag?.trim() || body?.staffPseudo?.trim() || getAuditActor(user);
      const memberPseudo = sanction.targetTag?.trim() || body?.memberPseudo?.trim() || `Utilisateur ${sanction.targetUserId}`;
      const memberReference = sanction.targetUserId?.trim() || body?.memberReference?.trim() || sanction.targetUserId;
      const sanctionTypeRaw = sanction.type as DashboardSanctionType;
      const sanctionDurationLabel = body?.sanctionDurationLabel?.trim() || formatSanctionDurationLabel(sanction.durationSeconds);
      const finalIncidentAt = Number.isNaN(incidentAt.getTime()) ? sanction.createdAt : incidentAt;
      const finalBrokenRules = brokenRules || sanction.reason;
      const finalDetailedReason = detailedReason || sanction.reason;

      if (!finalBrokenRules || !finalDetailedReason) {
        return send(c, { error: 'Les champs de contenu du rapport sont obligatoires.' }, 400);
      }

      const report = await prisma.sanctionReport.create({
        data: {
          guildId,
          sanctionId,
          staffPseudo,
          incidentAt: finalIncidentAt,
          memberPseudo,
          memberReference,
          sanctionType: toSanctionType(sanctionTypeRaw),
          sanctionDurationLabel,
          brokenRules: finalBrokenRules,
          detailedReason: finalDetailedReason,
          evidenceLinks,
          additionalNotes: body?.additionalNotes?.trim() || null,
          createdByUserId: user.userId,
          createdByTag: user.username ?? null,
        }
      });

      // Synchronize reports for linked alt accounts
      const altAccountService = await import('../../../../services/moderation/altAccountService.js');
      await altAccountService.syncAltAccountSanctionReports(guildId, sanctionId, evidenceLinks, report).catch((err) => {
        logger.error('SanctionsAPI', 'Error synchronizing report to alt accounts (POST):', err);
      });

      const { announceSanctionReportToStaff } = await import('../../../../services/moderation/sanctionService.js');
      await announceSanctionReportToStaff(client, report).catch((err) => {
        logger.warn('SanctionsAPI', `Impossible d'annoncer le rapport ${report.id} sur le serveur staff :`, err);
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Création rapport sanction',
        context: getGuildName(client, guildId),
        module: 'Sanctions',
        eventType: 'Manuel',
        details: `Rapport ${report.id} créé pour ${memberPseudo} (${sanctionTypeRaw}).`,
        channelId: null
      });

      return send(c, { ok: true, reportId: report.id }, 201);
    } catch (err) {
      logger.error('SanctionsAPI', 'Error creating report:', err);
      return fail(c, err, 'Erreur lors de la création du rapport', 'SanctionsAPI');
    }
  });

  router.patch(`${base}/sanctions/reports/:reportId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const auditUser = auditUserOf(c);
    const { canModerateSanctions } = helpers(c);
    const reportId = c.req.param('reportId');
    if (!(await canModerateSanctions())) {
      return send(c, { error: 'Action non autorisée. Modération des sanctions requise.' }, 403);
    }
    try {
      const existingReport = await prisma.sanctionReport.findFirst({
        where: { id: reportId, guildId }
      });

      if (!existingReport) {
        return send(c, { error: 'Rapport introuvable.' }, 404);
      }

      if (existingReport.createdByUserId !== user.userId && access.level !== 'admin') {
        return send(c, { error: "Seul l'auteur du rapport ou un administrateur peut le modifier." }, 403);
      }

      const body = await readBody<{
        brokenRules?: string;
        detailedReason?: string;
        evidenceLinks?: unknown;
        additionalNotes?: string | null;
      }>(c);

      const updatedBrokenRules = body?.brokenRules !== undefined 
        ? normalizeBrokenRulesPayload(body.brokenRules.trim()) 
        : existingReport.brokenRules;
      
      const updatedDetailedReason = body?.detailedReason !== undefined
        ? body.detailedReason.trim()
        : existingReport.detailedReason;

      const updatedEvidenceLinks = body?.evidenceLinks !== undefined
        ? parseEvidenceLinks(body.evidenceLinks)
        : parseEvidenceLinks(existingReport.evidenceLinks);

      const updatedAdditionalNotes = body?.additionalNotes !== undefined
        ? body.additionalNotes?.trim() || null
        : existingReport.additionalNotes;

      if (!updatedBrokenRules || !updatedDetailedReason) {
        return send(c, { error: 'Les champs de contenu du rapport sont obligatoires.' }, 400);
      }

      if (Array.isArray(updatedEvidenceLinks) && updatedEvidenceLinks.length === 0) {
        return send(c, { error: 'Au moins un lien de preuve valide est obligatoire.' }, 400);
      }

      const updatedReport = await prisma.sanctionReport.update({
        where: { id: reportId },
        data: {
          brokenRules: updatedBrokenRules,
          detailedReason: updatedDetailedReason,
          evidenceLinks: updatedEvidenceLinks,
          additionalNotes: updatedAdditionalNotes,
        }
      });

      // Synchronize reports for linked alt accounts
      if (updatedReport.sanctionId) {
        const altAccountService = await import('../../../../services/moderation/altAccountService.js');
        await altAccountService.syncAltAccountSanctionReports(guildId, updatedReport.sanctionId, updatedEvidenceLinks, updatedReport).catch((err) => {
          logger.error('SanctionsAPI', 'Error synchronizing report to alt accounts (PATCH):', err);
        });
      }

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Modification rapport sanction',
        context: getGuildName(client, guildId),
        module: 'Sanctions',
        eventType: 'Manuel',
        details: `Rapport ${reportId} modifié par ${user.username ?? user.userId}.`,
        channelId: null
      });

      return send(c, { ok: true });
    } catch (err) {
      logger.error('SanctionsAPI', 'Error patching report:', err);
      return fail(c, err, 'Erreur lors de la modification du rapport', 'SanctionsAPI');
    }
  });

  router.get(`${base}/sanctions/reports/discord-messages`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    try {
      const sanctionId = (c.req.query('sanctionId') ?? null)?.trim() ?? '';
      const requestedLimit = Number.parseInt(c.req.query('limit') ?? '', 10);
      const messageLimit = Number.isFinite(requestedLimit)
        ? Math.min(Math.max(requestedLimit, 1), MAX_EVIDENCE_MESSAGES)
        : 50;

      if (!sanctionId) {
        return send(c, { error: 'sanctionId est obligatoire.' }, 400);
      }

      const sanction = await prisma.sanction.findFirst({ where: { id: sanctionId, guildId } });
      if (!sanction) {
        return send(c, { error: 'Sanction introuvable sur ce serveur.' }, 404);
      }

      if (sanction.moderatorUserId !== user.userId && access.level !== 'admin') {
        return send(c, { error: 'Seule la personne qui a appliqué la sanction peut importer des preuves.' }, 403);
      }

      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        return send(c, { error: 'Serveur Discord introuvable.' }, 404);
      }

      const me = guild.members.me;
      const searchableChannels = [...guild.channels.cache.values()].filter((channel): channel is TextChannel => {
        if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
          return false;
        }
        return Boolean(me && channel.permissionsFor(me).has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory,
        ]));
      });

      const concurrencyLimit = pLimit(EVIDENCE_CHANNEL_CONCURRENCY);
      let failedChannelCount = 0;
      const fetchedChannels: Array<FetchedEvidenceChannel | null> = await Promise.all(
        searchableChannels.map((channel) => concurrencyLimit(async (): Promise<FetchedEvidenceChannel | null> => {
          try {
            const { messages, truncated } = await fetchUserMessagesInChannel(channel, sanction.targetUserId, messageLimit);
            return {
              channelId: channel.id,
              channelName: channel.name,
              rawMessages: messages,
              truncated,
            };
          } catch (err) {
            failedChannelCount++;
            logger.error('SanctionsAPI', `Error fetching evidence messages for channel ${channel.id}:`, err);
            return null;
          }
        })),
      );

      const successfulChannels = fetchedChannels.filter(
        (channel): channel is FetchedEvidenceChannel => channel !== null,
      );

      const newestMessages = successfulChannels
        .flatMap((channel) => channel.rawMessages.map((message) => ({ channel, message })))
        .sort((a, b) => b.message.createdTimestamp - a.message.createdTimestamp)
        .slice(0, messageLimit);

      const includedMessageIds = new Set(newestMessages.map(({ message }) => message.id));
      const channels = successfulChannels
        .map((channel) => ({
          channelId: channel.channelId,
          channelName: channel.channelName,
          messages: channel.rawMessages
            .filter((message) => includedMessageIds.has(message.id))
            .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
            .map((message) => serializeEvidenceMessage(message, guild)),
          truncated: channel.truncated,
        }))
        .filter((channel) => channel.messages.length > 0)
        .sort((a, b) => a.channelName.localeCompare(b.channelName, 'fr'));

      return send(c, {
        targetTag: sanction.targetTag,
        channels,
        messageCount: newestMessages.length,
        searchedChannelCount: searchableChannels.length,
        failedChannelCount,
        truncatedChannelCount: successfulChannels.filter((channel) => channel.truncated).length,
      });
    } catch (err) {
      logger.error('SanctionsAPI', 'Error listing discord evidence messages:', err);
      return fail(c, err, 'Erreur lors de la récupération des messages Discord', 'SanctionsAPI');
    }
  });

  router.post(`${base}/sanctions/reports/discord-transcripts`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const auditUser = auditUserOf(c);
    const { canModerateSanctions } = helpers(c);
    if (!(await canModerateSanctions())) {
      return send(c, { error: 'Action non autorisée. Modération des sanctions requise.' }, 403);
    }
    try {
      const body = await readBody<{
        sanctionId?: string;
        selections?: Array<{ channelId?: string; messageIds?: string[] }>;
      }>(c);

      const sanctionId = body?.sanctionId?.trim() ?? '';
      if (!sanctionId) {
        return send(c, { error: 'sanctionId est obligatoire.' }, 400);
      }

      const selections = Array.isArray(body?.selections) ? body.selections : [];
      if (selections.length === 0) {
        return send(c, { error: 'Aucun message sélectionné.' }, 400);
      }

      const totalSelectedMessages = selections.reduce((total, selection) => (
        total + (Array.isArray(selection?.messageIds) ? selection.messageIds.length : 0)
      ), 0);
      if (totalSelectedMessages > MAX_EVIDENCE_MESSAGES) {
        return send(c, { error: `Maximum ${MAX_EVIDENCE_MESSAGES} messages par transcription.` }, 400);
      }

      const sanction = await prisma.sanction.findFirst({ where: { id: sanctionId, guildId } });
      if (!sanction) {
        return send(c, { error: 'Sanction introuvable sur ce serveur.' }, 404);
      }

      if (sanction.moderatorUserId !== user.userId && access.level !== 'admin') {
        return send(c, { error: 'Seule la personne qui a appliqué la sanction peut importer des preuves.' }, 403);
      }

      const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:5173';
      const results: Array<{ channelId: string; channelName: string; url: string; count: number }> = [];
      const errors: Array<{ channelId: string; error: string }> = [];

      await Promise.all(selections.map(async (selection) => {
        const channelId = selection?.channelId?.trim() ?? '';
        const messageIds = Array.isArray(selection?.messageIds)
          ? [...new Set(selection.messageIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))]
          : [];

        if (!channelId || messageIds.length === 0) {
          errors.push({ channelId: channelId || 'inconnu', error: 'Sélection invalide.' });
          return;
        }
        const resolved = await resolveEvidenceChannel(client, guildId, channelId);
        if ('error' in resolved) {
          errors.push({ channelId, error: resolved.error });
          return;
        }

        try {
          const fetched = await Promise.all(messageIds.map((id) => resolved.channel.messages.fetch(id).catch(() => null)));
          const validMessages = fetched.filter((msg): msg is Message<true> => msg !== null && msg.author.id === sanction.targetUserId);

          if (validMessages.length === 0) {
            errors.push({ channelId, error: 'Aucun message valide à transcrire.' });
            return;
          }

          validMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
          const transcript = await generateTranscriptFromMessages(resolved.channel, validMessages);

          await pushAudit(guildId, {
            user: auditUser,
            action: 'Génération transcription (preuve sanction)',
            context: getGuildName(client, guildId),
            module: 'Sanctions',
            eventType: 'Manuel',
            details: `Transcription ${transcript.id} générée pour #${resolved.channel.name} (${transcript.count} messages, sanction ${sanctionId}).`,
            channelId: resolved.channel.id
          });

          results.push({
            channelId,
            channelName: resolved.channel.name,
            url: `${dashboardUrl}${transcript.url}`,
            count: transcript.count,
          });
        } catch (err) {
          logger.error('SanctionsAPI', `Error generating evidence transcript for channel ${channelId}:`, err);
          errors.push({ channelId, error: 'Erreur lors de la génération de la transcription.' });
        }
      }));

      return send(c, { results, errors });
    } catch (err) {
      logger.error('SanctionsAPI', 'Error generating discord evidence transcripts:', err);
      return fail(c, err, 'Erreur lors de la génération des transcriptions', 'SanctionsAPI');
    }
  });

  return router;
}

