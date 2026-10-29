/** Outils MCP - write sanctions (permission WRITE_SANCTIONS). */
import { releaseJail } from '../../../services/moderation/jailService.js';
import { generateTranscriptFromMessages } from '../../../services/features/transcriptService.js';
import { decideAppeal, ensureDefaultAppealForm, getAppealConfig, requestAppealInfo, sendPreActionAppealDM, upsertAppealConfig } from '../../../services/moderation/banAppealService.js';
import { registerBanSanction, registerKickSanction, registerTimeoutSanction, registerWarnSanction, runGuildBan } from '../../../services/moderation/sanctionService.js';
import prisma from '../../../utils/db.js';
import { MAX_EVIDENCE_MESSAGES, parseEvidenceLinks } from '../../evidence.js';
import { type SanctionStatus, type SanctionType } from '@prisma/client';
import { type Message } from 'discord.js';
import { z } from 'zod';
import { type McpToolContext, err, ok, resolveChannel, resolveMember, toolError } from '../toolkit.js';

export function registerWriteSanctionsTools(ctx: McpToolContext) {
  const { server, guildId, client, shouldRegister, guard, audit, toolMeta } = ctx;

  if (shouldRegister('WRITE_SANCTIONS')) {
    server.registerTool(
      'apply_sanction',
      {
        description: 'Applique une sanction à un membre du serveur Discord. Requiert la permission WRITE_SANCTIONS.',
        inputSchema: {
          member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre à sanctionner'),
          type: z.enum(['WARN', 'KICK', 'TIMEOUT', 'TEMP_BAN', 'BAN', 'SOFTBAN']),
          reason: z.string().min(1).max(512).describe('Raison de la sanction'),
          duration_seconds: z
            .number()
            .int()
            .positive()
            .max(2332800)
            .optional()
            .describe('Durée en secondes (obligatoire pour TIMEOUT et TEMP_BAN, max 27 jours)'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_SANCTIONS', async ({ member, type, reason, duration_seconds, key_name }) => {
        if ((type === 'TIMEOUT' || type === 'TEMP_BAN') && !duration_seconds) {
          return err(`duration_seconds est obligatoire pour le type ${type}`);
        }

        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;
        const member_id = resolved.userId;

        const discordGuild = client.guilds.cache.get(guildId);
        if (!discordGuild) return err('Serveur Discord introuvable');

        const target = await discordGuild.members.fetch(member_id).catch(() => null);
        if (!target) return err('Membre introuvable sur le serveur Discord');

        const actorTag = `MCP[${key_name ?? 'agent'}]`;
        const actor = { id: 'mcp_agent', tag: actorTag };
        const targetData = { id: member_id, tag: target.user.tag ?? target.user.username };

        try {
          let sanction;

          if (type === 'WARN') {
            sanction = await registerWarnSanction({ guildId, target: targetData, moderator: actor, reason, client });
          } else if (type === 'KICK') {
            if (!target.kickable) return err('Le bot ne peut pas expulser ce membre (hiérarchie des rôles).');
            // Le lien de contestation part avant l'expulsion : ensuite le membre
            // ne partage plus forcément de serveur avec le bot.
            await sendPreActionAppealDM(client, guildId, member_id, 'KICK').catch(() => false);
            await target.kick(`${reason} | ${actorTag}`);
            sanction = await registerKickSanction({ guildId, target: targetData, moderator: actor, reason, client });
          } else if (type === 'TIMEOUT') {
            sanction = await registerTimeoutSanction({
              guildId,
              target: targetData,
              moderator: actor,
              reason,
              durationMs: duration_seconds! * 1000,
              member: target,
              client,
            });
          } else if (type === 'BAN' || type === 'TEMP_BAN') {
            if (!target.bannable) return err('Le bot ne peut pas bannir ce membre (hiérarchie des rôles).');
            await sendPreActionAppealDM(client, guildId, member_id, type).catch(() => false);
            await runGuildBan(discordGuild, member_id, `${reason} | ${actorTag}`);
            sanction = await registerBanSanction({
              guildId,
              target: targetData,
              moderator: actor,
              reason,
              client,
              ...(duration_seconds ? { temporaryDurationMs: duration_seconds * 1000 } : {}),
            });
          } else {
            return err(`Type de sanction non supporté via MCP : ${type}`);
          }

          await prisma.dashboardAuditLog.create({
            data: {
              guildId,
              user: actorTag,
              action: `Sanction MCP - ${type}`,
              context: `Cible: ${targetData.tag} (${member_id})`,
              module: 'MCP',
              eventType: 'Action',
              details: `Type: ${type} | Cible: ${targetData.tag} | Raison: ${reason}`,
              dateIso: new Date(),
            },
          });

          return ok({ ok: true, sanctionId: sanction?.id ?? null, type, targetId: member_id });
        } catch (e) {
          return toolError(e, "Erreur lors de l'application de la sanction");
        }
      })
    );

    server.registerTool(
      'revoke_sanction',
      {
        description:
          "Lève une sanction active d'un membre : déban, retrait du timeout et/ou levée de quarantaine (Jail). Requiert la permission WRITE_SANCTIONS.",
        inputSchema: {
          member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre'),
          type: z
            .enum(['BAN', 'TIMEOUT', 'JAIL'])
            .optional()
            .describe('Type de sanction à lever (si omis, lève tout ce qui est actif)'),
          reason: z.string().max(512).optional().describe('Raison de la levée (audit)'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_SANCTIONS', async ({ member, type, reason, key_name }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;
        const userId = resolved.userId;

        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        const motif = reason ?? 'Levée via MCP';
        const actions: string[] = [];

        if (!type || type === 'BAN') {
          const ban = await guild.bans.fetch(userId).catch(() => null);
          if (ban) {
            const done = await guild.members.unban(userId, motif).then(() => true).catch(() => false);
            if (done) actions.push('unban');
          }
        }

        if (!type || type === 'TIMEOUT') {
          const target = await guild.members.fetch(userId).catch(() => null);
          if (target?.isCommunicationDisabled()) {
            const done = await target.timeout(null, motif).then(() => true).catch(() => false);
            if (done) actions.push('untimeout');
          }
        }

        if (!type || type === 'JAIL') {
          const released = await releaseJail(client, guildId, userId, { note: `Quarantaine levée via MCP : ${motif}`, auditReason: motif })
            .catch(() => false);
          if (released) actions.push('unjail');
        }

        if (actions.length === 0) {
          return err('Aucune sanction active à lever pour ce membre (ni ban, ni timeout, ni quarantaine en cours).');
        }

        const revokedTypes: SanctionType[] = actions.includes('unban')
          ? (['BAN', 'TEMP_BAN'] as SanctionType[])
          : [];
        if (actions.includes('untimeout')) revokedTypes.push('TIMEOUT' as SanctionType);

        await prisma.sanction.updateMany({
          where: { guildId, targetUserId: userId, status: 'ACTIVE', type: { in: revokedTypes } },
          data: { status: 'RESOLVED' as SanctionStatus, resolvedAt: new Date() },
        });

        await audit(
          key_name,
          'Levée de sanction MCP',
          `Cible: ${resolved.label} (${userId})`,
          `Actions: ${actions.join(', ')} | Raison: ${motif}`
        );

        return ok({ ok: true, userId, actions });
      })
    );

    server.registerTool(
      'decide_ban_appeal',
      {
        description: 'Tranche une demande d\'appel de bannissement (Accepter, Refuser ou Refuser Définitivement). Requiert WRITE_SANCTIONS.',
        inputSchema: {
          appeal_id: z.string().describe('ID unique de la demande d\'appel'),
          decision: z.enum(['ACCEPTED', 'DENIED', 'DENIED_PERMANENT']).describe('La décision à appliquer'),
          reason: z.string().optional().describe('Raison de la décision (transmise au membre)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_SANCTIONS', async ({ appeal_id, decision, reason, key_name }) => {
        try {
          const staffUserId = 'mcp_agent';
          const staffTag = `MCP[${key_name ?? 'agent'}]`;

          const res = await decideAppeal(client, {
            appealId: appeal_id,
            guildId,
            decision,
            staffUserId,
            staffTag,
            reason,
          });

          if (!res.ok) return err(res.error || 'Erreur inconnue');

          await audit(key_name, 'Appel de ban tranché', `ID: ${appeal_id} | Décision: ${decision}`, reason || '(sans raison)');
          return ok({ ok: true, appealId: appeal_id, status: res.appeal.status });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'request_ban_appeal_info',
      {
        description: 'Demande des informations complémentaires à l\'auteur d\'un appel par MP. Met l\'appel en statut NEEDS_INFO. Requiert WRITE_SANCTIONS.',
        inputSchema: {
          appeal_id: z.string().describe('ID unique de la demande d\'appel'),
          question: z.string().min(1).max(1000).describe('La question à poser au membre'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_SANCTIONS', async ({ appeal_id, question, key_name }) => {
        try {
          const staffUserId = 'mcp_agent';
          const staffTag = `MCP[${key_name ?? 'agent'}]`;

          const res = await requestAppealInfo(client, {
            appealId: appeal_id,
            guildId,
            question,
            staffUserId,
            staffTag,
          });

          if (!res.ok) return err(res.error || 'Erreur inconnue');

          await audit(key_name, 'Infos d\'appel demandées', `ID: ${appeal_id}`, question);
          return ok({ ok: true, appealId: appeal_id, status: res.appeal.status });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'blacklist_ban_appeal',
      {
        description: 'Ajoute un membre banni à la liste noire des appels pour lui interdire définitivement d\'en soumettre un. Requiert WRITE_SANCTIONS.',
        inputSchema: {
          user_id: z.string().describe('ID Discord du membre à blacklister'),
          reason: z.string().optional().describe('Motif du blacklist'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_SANCTIONS', async ({ user_id, reason, key_name }) => {
        try {
          const staffUserId = 'mcp_agent';
          const staffTag = `MCP[${key_name ?? 'agent'}]`;

          const blacklist = await prisma.banAppealBlacklist.upsert({
            where: { guildId_userId: { guildId, userId: user_id } },
            create: {
              guildId,
              userId: user_id,
              reason: reason || 'Ajouté via MCP',
              addedByUserId: staffUserId,
              addedByTag: staffTag,
            },
            update: {
              reason: reason || 'Ajouté via MCP',
              addedByUserId: staffUserId,
              addedByTag: staffTag,
            },
          });

          await audit(key_name, 'Membre blacklisté des appels', `ID: ${user_id}`, reason || '(sans motif)');
          return ok({ ok: true, blacklist });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'unblacklist_ban_appeal',
      {
        description: 'Retire un membre de la liste noire des appels de bannissement. Requiert WRITE_SANCTIONS.',
        inputSchema: {
          user_id: z.string().describe('ID Discord du membre à retirer de la liste noire'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_SANCTIONS', async ({ user_id, key_name }) => {
        try {
          const deleted = await prisma.banAppealBlacklist.deleteMany({
            where: { guildId, userId: user_id },
          });

          await audit(key_name, 'Membre retiré de la blacklist des appels', `ID: ${user_id}`, '');
          return ok({ ok: true, count: deleted.count });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'get_ban_appeal_blacklist',
      {
        description: 'Liste les membres blacklistés des appels de bannissement. Requiert READ_MODERATION.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_MODERATION', async () => {
        try {
          const entries = await prisma.banAppealBlacklist.findMany({
            where: { guildId },
            orderBy: { createdAt: 'desc' },
          });
          return ok({ entries, count: entries.length });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'delete_sanction',
      {
        description: 'Supprime une entrée de sanction de la base de données (sans lever la sanction Discord). Requiert WRITE_SANCTIONS.',
        inputSchema: {
          sanction_id: z.string().describe('ID de la sanction à supprimer'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_SANCTIONS', async ({ sanction_id, key_name }) => {
        try {
          const sanction = await prisma.sanction.findFirst({
            where: { id: sanction_id, guildId },
            select: { id: true, type: true, targetTag: true, targetUserId: true },
          });
          if (!sanction) return err('Sanction introuvable');

          await prisma.sanction.delete({ where: { id: sanction.id } });
          await audit(
            key_name,
            'Suppression sanction MCP',
            sanction.targetTag ?? sanction.targetUserId,
            `ID: ${sanction.id} | Type: ${sanction.type}`
          );
          return ok({ ok: true, sanctionId: sanction.id });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'update_ban_appeal_config',
      {
        description: 'Met à jour la configuration des appels de bannissement sur le serveur. Requiert WRITE_SANCTIONS.',
        inputSchema: {
          enabled: z.boolean().optional().describe('Activer ou désactiver les appels'),
          form_id: z.string().nullable().optional().describe('ID du formulaire personnalisé à lier'),
          staff_channel_id: z.string().nullable().optional().describe('Salon staff qui reçoit les demandes'),
          invite_channel_id: z.string().nullable().optional().describe('Salon d\'invitation de retour pour les appels acceptés'),
          cooldown_days: z.number().int().min(0).optional().describe('Jours de cooldown avant de pouvoir soumettre un nouvel appel'),
          welcome_text: z.string().nullable().optional().describe('Texte d\'accueil sur la page publique'),
          accept_message: z.string().nullable().optional().describe('DM envoyé en cas d\'acceptation'),
          deny_message: z.string().nullable().optional().describe('DM envoyé en cas de refus'),
          notify_on_ban_dm: z.boolean().optional().describe("Envoyer automatiquement le lien public de l'appel par DM lors d'un bannissement définitif"),
          create_default_form: z.boolean().optional().describe('Crée automatiquement le formulaire d\'appel par défaut si absent'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_SANCTIONS', async ({ enabled, form_id, staff_channel_id, invite_channel_id, cooldown_days, welcome_text, accept_message, deny_message, notify_on_ban_dm, create_default_form, key_name }) => {
        try {
          const updateData: any = {};
          if (enabled !== undefined) updateData.enabled = enabled;
          if (form_id !== undefined) updateData.formId = form_id;
          if (staff_channel_id !== undefined) updateData.staffChannelId = staff_channel_id;
          if (invite_channel_id !== undefined) updateData.inviteChannelId = invite_channel_id;
          if (cooldown_days !== undefined) updateData.cooldownDays = cooldown_days;
          if (welcome_text !== undefined) updateData.welcomeText = welcome_text;
          if (accept_message !== undefined) updateData.acceptMessage = accept_message;
          if (deny_message !== undefined) updateData.denyMessage = deny_message;
          if (notify_on_ban_dm !== undefined) updateData.notifyOnBanDM = notify_on_ban_dm;

          if (form_id) {
            const form = await prisma.customForm.findFirst({ where: { id: form_id, guildId }, select: { id: true } });
            if (!form) return err('Formulaire introuvable sur ce serveur');
          }

          await upsertAppealConfig(guildId, updateData);

          if (create_default_form) {
            await ensureDefaultAppealForm(guildId);
          }

          const config = await getAppealConfig(guildId);

          await audit(key_name, 'Configuration appels mise à jour', '', JSON.stringify(updateData));
          return ok(config);
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'create_sanction_report',
      {
        description: 'Crée un rapport de sanction documenté avec preuves. Requiert WRITE_SANCTIONS.',
        inputSchema: {
          sanction_id: z.string().describe('ID de la sanction liée'),
          incident_at: z.string().describe('Date/heure de l\'incident (ISO 8601)'),
          broken_rules: z.string().describe('Règles enfreintes'),
          detailed_reason: z.string().describe('Motif détaillé'),
          evidence_links: z.array(z.string().url()).min(1).describe('Liens de preuves (URLs https)'),
          additional_notes: z.string().optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_SANCTIONS', async ({ sanction_id, incident_at, broken_rules, detailed_reason, evidence_links, additional_notes, key_name }) => {
        try {
          const sanction = await prisma.sanction.findFirst({ where: { id: sanction_id, guildId } });
          if (!sanction) return err('Sanction introuvable');

          const existingReport = await prisma.sanctionReport.findFirst({ where: { guildId, sanctionId: sanction_id } });
          if (existingReport) return err('Un rapport existe déjà pour cette sanction');

          const parsedDate = new Date(incident_at);
          if (Number.isNaN(parsedDate.getTime())) return err('Date d\'incident invalide');

          const report = await prisma.sanctionReport.create({
            data: {
              guildId,
              sanctionId: sanction_id,
              staffPseudo: sanction.moderatorTag ?? 'MCP Agent',
              incidentAt: parsedDate,
              memberPseudo: sanction.targetTag ?? sanction.targetUserId,
              memberReference: sanction.targetUserId,
              sanctionType: sanction.type,
              sanctionDurationLabel: sanction.durationSeconds ? `${sanction.durationSeconds}s` : null,
              brokenRules: broken_rules,
              detailedReason: detailed_reason,
              evidenceLinks: evidence_links,
              additionalNotes: additional_notes ?? null,
              createdByUserId: 'mcp_agent',
              createdByTag: `MCP[${key_name ?? 'agent'}]`,
            },
          });

          const { announceSanctionReportToStaff } = await import('../../../services/moderation/sanctionService.js');
          await announceSanctionReportToStaff(client, report).catch(() => null);

          await audit(key_name, 'Création rapport sanction MCP', sanction.targetTag ?? sanction.targetUserId, `Rapport ${report.id}`);
          return ok({ ok: true, reportId: report.id });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'update_sanction_report',
      {
        description: 'Met à jour un rapport de sanction existant. Requiert WRITE_SANCTIONS.',
        inputSchema: {
          report_id: z.string().describe('ID du rapport'),
          broken_rules: z.string().optional(),
          detailed_reason: z.string().optional(),
          evidence_links: z.array(z.string().url()).optional(),
          additional_notes: z.string().nullable().optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_SANCTIONS', async ({ report_id, broken_rules, detailed_reason, evidence_links, additional_notes, key_name }) => {
        try {
          const existing = await prisma.sanctionReport.findFirst({ where: { id: report_id, guildId } });
          if (!existing) return err('Rapport introuvable');

          const report = await prisma.sanctionReport.update({
            where: { id: report_id },
            data: {
              ...(broken_rules !== undefined ? { brokenRules: broken_rules } : {}),
              ...(detailed_reason !== undefined ? { detailedReason: detailed_reason } : {}),
              ...(evidence_links !== undefined ? { evidenceLinks: parseEvidenceLinks(evidence_links) } : {}),
              ...(additional_notes !== undefined ? { additionalNotes: additional_notes } : {}),
            },
          });

          await audit(key_name, 'Mise à jour rapport sanction MCP', report_id, '');
          return ok({ ok: true, report });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'import_sanction_discord_transcripts',
      {
        description:
          'Génère des transcriptions HTML à partir de messages Discord sélectionnés, pour les joindre comme preuves à une sanction. Requiert WRITE_SANCTIONS.',
        inputSchema: {
          sanction_id: z.string().describe('ID de la sanction concernée'),
          selections: z.array(z.object({
            channel: z.string().describe('Salon (nom, mention ou ID)'),
            message_ids: z.array(z.string()).min(1).describe('IDs des messages à transcrire'),
          })).min(1),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_SANCTIONS', async ({ sanction_id, selections, key_name }) => {
        try {
          const sanction = await prisma.sanction.findFirst({ where: { id: sanction_id, guildId } });
          if (!sanction) return err('Sanction introuvable');

          const totalMessages = selections.reduce((sum: number, s: { message_ids: string[] }) => sum + s.message_ids.length, 0);
          if (totalMessages > MAX_EVIDENCE_MESSAGES) {
            return err(`Maximum ${MAX_EVIDENCE_MESSAGES} messages par import`);
          }

          const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:5173';
          const results: Array<{ channelId: string; channelName: string; url: string; count: number }> = [];
          const errors: Array<{ channel: string; error: string }> = [];

          for (const selection of selections) {
            const resolved = resolveChannel(guildId, client, selection.channel);
            if (!resolved.ok) {
              errors.push({ channel: selection.channel, error: 'Salon introuvable' });
              continue;
            }

            try {
              const fetched = await Promise.all(
                selection.message_ids.map((id: string) => resolved.channel.messages.fetch(id).catch(() => null)),
              );
              const validMessages = fetched.filter(
                (msg): msg is Message<true> => msg !== null && msg.author.id === sanction.targetUserId,
              );

              if (validMessages.length === 0) {
                errors.push({ channel: selection.channel, error: 'Aucun message valide' });
                continue;
              }

              validMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
              const transcript = await generateTranscriptFromMessages(resolved.channel, validMessages);
              results.push({
                channelId: resolved.channel.id,
                channelName: resolved.channel.name,
                url: `${dashboardUrl}${transcript.url}`,
                count: transcript.count,
              });
            } catch {
              errors.push({ channel: selection.channel, error: 'Erreur de transcription' });
            }
          }

          await audit(key_name, 'Import preuves Discord MCP', sanction_id, `${results.length} transcription(s)`);
          return ok({ results, errors });
        } catch (e) {
          return toolError(e);
        }
      })
    );
  }
}
