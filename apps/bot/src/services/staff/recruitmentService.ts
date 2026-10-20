import type { Prisma } from '@prisma/client';
import type { CandidatureStatus } from '@prisma/client';
import { type ButtonInteraction, type Client, EmbedBuilder, TextChannel } from 'discord.js';
import prisma from '../../utils/db.js';
import { upsertHierarchyGradeRow, upsertStaffMemberRow } from './staffRowUpsert.js';
import { notify } from '../notifications/notifyService.js';
import { logger } from '../../utils/logger.js';
import { COLORS } from '../../utils/embeds.js';
import { createTicketWorkspace, type TicketPanelTypeConfig } from '../features/ticketService.js';
import { resolveGuildLocale } from '../../utils/i18n.js';

// ============================================================================
// FIELD DETECTION HELPERS
// ============================================================================

/** Fields that are considered "paragraph" fields and must have ≥200 chars */
const PARAGRAPH_EXCEPTION_KEYWORDS = [
  'expérience de modération',
  'experience de moderation',
  'expérience de modération précédente',
  'rôle que vous occupiez',
  'role que vous occupiez',
  'responsabilités principales',
  'responsabilites principales',
];

/** Returns true if this field key is the exception field (moderation experience) */
function isExceptionField(key: string): boolean {
  const lower = key.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return PARAGRAPH_EXCEPTION_KEYWORDS.some(kw => {
    const normalizedKw = kw.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return lower.includes(normalizedKw);
  });
}

/** Returns true if the field key looks like a "paragraph" question (open-ended long questions) */
function isParagraphField(key: string): boolean {
  const lower = key.toLowerCase();
  // Paragraph fields = long open text fields (not age, not yes/no, not username, not email, not micro)
  const shortFieldIndicators = [
    'âge', 'age', 'ans',
    'micro', 'microphone',
    'discord', 'pseudo', 'username', 'identifiant', "nom d'utilisateur",
    'email', 'mail',
    'prénom', 'prenom', 'nom',
    'horodateur', 'timestamp',
    'disponibilité', 'disponibilite',
    'combien de temps', 'heures par',
    'fuseau', 'timezone',
  ];
  return !shortFieldIndicators.some(ind => lower.includes(ind));
}

/** Extracts the age from the form data */
function extractAge(data: Record<string, unknown>): number | null {
  for (const [key, value] of Object.entries(data)) {
    const k = key.toLowerCase();
    if (k.includes('âge') || k.includes('age') || k.includes('ans')) {
      const val = String(value).trim();
      const num = parseInt(val, 10);
      if (!isNaN(num) && num > 0 && num < 120) return num;
    }
  }
  return null;
}

/** Checks if the user has a microphone */
function hasMicrophone(data: Record<string, unknown>): boolean | null {
  for (const [key, value] of Object.entries(data)) {
    const k = key.toLowerCase();
    if (k.includes('micro') || k.includes('microphone')) {
      const val = String(value).toLowerCase().trim();
      if (val === 'oui' || val === 'yes' || val === 'true' || val === '1') return true;
      if (val === 'non' || val === 'no' || val === 'false' || val === '0') return false;
      // Array format from Google Forms (["Oui"])
      if (Array.isArray(value)) {
        const first = String(value[0] || '').toLowerCase().trim();
        if (first === 'oui' || first === 'yes') return true;
        if (first === 'non' || first === 'no') return false;
      }
    }
  }
  return null;
}

// ============================================================================
// AUTO-REJECTION LOGIC
// ============================================================================

interface AutoRejectResult {
  rejected: boolean;
  reason: string;
}

export function checkAutoReject(data: Record<string, unknown>): AutoRejectResult {
  // 1) Check age
  const age = extractAge(data);
  if (age !== null && age < 16) {
    return {
      rejected: true,
      reason: `Votre candidature a été automatiquement refusée car vous avez indiqué avoir ${age} ans. L'âge minimum requis pour rejoindre l'équipe est de 16 ans.`,
    };
  }

  // 2) Check microphone
  const hasMic = hasMicrophone(data);
  if (hasMic === false) {
    return {
      rejected: true,
      reason: `Votre candidature a été automatiquement refusée car vous avez indiqué ne pas posséder de microphone. Un microphone fonctionnel est obligatoire pour l'entretien oral et la modération vocale.`,
    };
  }

  // 3) Check paragraph lengths
  for (const [key, value] of Object.entries(data)) {
    if (isExceptionField(key)) continue;
    if (!isParagraphField(key)) continue;

    const text = Array.isArray(value) ? value.join(', ') : String(value || '');
    if (text.length < 200) {
      return {
        rejected: true,
        reason: `Votre candidature a été automatiquement refusée car votre réponse au champ "${key}" est trop courte (${text.length} caractères). Un minimum de 200 caractères est requis pour les questions ouvertes afin de démontrer votre motivation.`,
      };
    }
  }

  return { rejected: false, reason: '' };
}

// ============================================================================
// CRUD
// ============================================================================

export async function getCandidatures(guildId: string) {
  return await prisma.recruitmentCandidature.findMany({
    where: { guildId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createCandidature(
  guildId: string,
  data: Record<string, unknown>,
  options?: { autoRejectEnabled?: boolean; client?: Client }
) {
  // Try to find identifiers in the data
  let discordId: string | null = null;
  let username: string | null = null;
  let email: string | null = null;

  // common field names for Discord ID/Username
  const keys = Object.keys(data);
  for (const key of keys) {
    const k = key.toLowerCase();
    const val = String(data[key]);
    
    // Exact match or contains for the user's specific form
    if (k.includes('discord') && (k.includes('nom') || k.includes('utilisateur') || k.includes('id') || k.includes('identifiant'))) {
      if (/^\d{17,19}$/.test(val)) {
        discordId = val;
      } else {
        username = val;
      }
    }
    
    if (k.includes('pseudo') || k.includes('username')) {
       if (!username) username = val;
    }
    if (k.includes('email') || k.includes('mail')) {
       if (!email) email = val;
    }
  }

  // If data is from Google Forms, it might be nested
  // Google Apps Script usually sends: { timestamp: "...", data: { "Field 1": ["Value"], ... } }
  const nested = data.data;
  const rawData: Record<string, unknown> =
    nested && typeof nested === 'object' && !Array.isArray(nested) ? (nested as Record<string, unknown>) : data;

  // Check auto-rejection (can be disabled from dashboard config)
  const autoRejectEnabled = options?.autoRejectEnabled !== false;
  const autoRejectCheck = autoRejectEnabled
    ? checkAutoReject(rawData)
    : { rejected: false, reason: '' };

  const candidature = await prisma.recruitmentCandidature.create({
    data: {
      guildId,
      discordId,
      username: username || (discordId ? `User_${discordId}` : 'Candidat Anonyme'),
      email,
      data: rawData as Prisma.InputJsonValue,
      status: autoRejectCheck.rejected ? 'AUTO_REJECTED' : 'PENDING',
      autoRejected: autoRejectCheck.rejected,
      autoRejectReason: autoRejectCheck.rejected ? autoRejectCheck.reason : null,
    },
  });

  // Notifier les managers recrutement (si non auto-refusée)
  if (!autoRejectCheck.rejected) {
    const managers = await prisma.staffMember.findMany({
      where: {
        guildId,
        grade: { in: ['Manager', 'Admin', 'Administrateur', 'Fondateur', 'Direction', 'Recrutement'] }
      }
    });

    await Promise.all(managers.map(m => {
      const isAdmin = ['Admin', 'Administrateur', 'Fondateur', 'Direction'].includes(m.grade);
      return notify({
        guildId,
        userId: m.userId,
        kind: 'recruitment.application_received',
        title: isAdmin ? 'ALERTE : Nouveau Formulaire Recrutement' : 'Nouvelle candidature',
        message: `Une nouvelle candidature a été reçue de ${candidature.username}.`,
        severity: isAdmin ? 'WARNING' : 'INFO',
        link: '/recruitment',
        groupKey: 'recruitment.application_received',
        data: { candidatureId: candidature.id },
      }).catch(() => null);
    }));

    // Notifier le salon configuré sur le serveur staff lié
    if (options?.client) {
      await notifyStaffServerNewCandidature(options.client, guildId, candidature).catch((err) =>
        logger.warn('Recruitment', `Impossible d'annoncer la candidature ${candidature.id} sur le serveur staff :`, err),
      );
    }
  }

  return { candidature, autoRejected: autoRejectCheck.rejected, autoRejectReason: autoRejectCheck.reason };
}

/**
 * Poste un embed de nouvelle candidature dans le salon configuré sur le serveur staff lié.
 * Silencieux si aucun lien/salon n'est configuré.
 */
async function notifyStaffServerNewCandidature(
  client: Client,
  guildId: string,
  candidature: { id: string; username: string | null; discordId: string | null; createdAt: Date },
): Promise<void> {
  const { getStaffServerNotifyChannel } = await import('./staffServerService.js');
  const channel = await getStaffServerNotifyChannel(client, guildId, 'recruitment');
  if (!channel) return;

  const mainGuildName = client.guilds.cache.get(guildId)?.name ?? guildId;
  const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:5173';

  const embed = new EmbedBuilder()
    .setTitle('📥 Nouvelle candidature')
    .setColor(COLORS.info)
    .addFields(
      { name: 'Candidat', value: candidature.username ?? 'Inconnu', inline: true },
      { name: 'Discord', value: candidature.discordId ? `<@${candidature.discordId}> (${candidature.discordId})` : 'Non fourni', inline: true },
      { name: 'Reçue le', value: `<t:${Math.floor(candidature.createdAt.getTime() / 1000)}:f>`, inline: true },
      { name: 'Dossier', value: `[Consulter sur le dashboard](${dashboardUrl.replace(/\/$/, '')}/recruitment)`, inline: false },
    )
    .setFooter({ text: `Depuis ${mainGuildName} · Candidature ${candidature.id}` })
    .setTimestamp();

  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
}

export async function updateCandidatureStatus(id: string, status: CandidatureStatus, notes?: string) {
  return await prisma.recruitmentCandidature.update({
    where: { id },
    data: {
      status,
      ...(notes !== undefined ? { notes } : {}),
    },
  });
}

export async function deleteCandidature(id: string) {
  return await prisma.recruitmentCandidature.delete({
    where: { id },
  });
}

// ============================================================================
// APPROVE → Create ticket for oral
// ============================================================================

export async function approveCandidature(
  client: Client,
  guildId: string,
  candidatureId: string,
  targetDiscordUserId: string,
  processedByUserId: string,
) {
  const candidature = await prisma.recruitmentCandidature.findUnique({ where: { id: candidatureId } });
  if (!candidature) throw new Error('Candidature introuvable');

  const guild = await prisma.guild.findUnique({ where: { id: guildId } });
  if (!guild) throw new Error('Configuration du serveur introuvable');
  const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) throw new Error('Serveur Discord introuvable');

  // Update Discord ID on candidature
  await prisma.recruitmentCandidature.update({
    where: { id: candidatureId },
    data: { discordId: targetDiscordUserId, processedByUserId },
  });

  // Get the target member
  const targetMember = await discordGuild.members.fetch(targetDiscordUserId).catch(() => null);
  const pseudo = targetMember?.displayName || candidature.username || 'candidat';

  // Entretien sur le serveur staff lié si configuré, sinon sur le serveur principal.
  // Ce lien décide aussi, plus bas, si `createTicketWorkspace` doit router le
  // salon vers ce serveur staff (`staffServerChannel`).
  const staffLink = await prisma.staffServerLink.findFirst({
    where: { mainGuildId: guildId, enabled: true, recruitmentOnStaffServer: true },
    select: { staffRecruitmentCategoryId: true },
  });

  // L'entretien oral passe par le système de tickets générique (au lieu d'un
  // salon fabriqué à la main) : ticket réel en base, transcription à la
  // suppression, claim/close standard - au lieu d'un vocal indépendant sur
  // lequel l'équipe n'a ni contrôle ni trace.
  const ticketType: TicketPanelTypeConfig = {
    id: 'recruitment-interview',
    label: 'Entretien de recrutement',
    mode: 'CHANNEL',
    staffServerChannel: !!staffLink,
    staffServerCategoryId: staffLink?.staffRecruitmentCategoryId ?? null,
    categoryId: guild.recruitmentCategoryId ?? null,
    staffRoleId: guild.moderatorRoleId ?? guild.baseStaffRoleId ?? null,
    lockUntilClaim: false,
    requireApproval: false,
  };

  const locale = await resolveGuildLocale(guildId, discordGuild.preferredLocale);

  const { ticketId } = await createTicketWorkspace(client, {
    guild: discordGuild,
    user: { id: targetDiscordUserId, username: pseudo },
    ticketType,
    guildConfig: guild,
    reason: 'Entretien de recrutement',
    description: `Entretien oral pour la candidature de ${pseudo} (ID: ${candidatureId}).`,
    locale,
    // La suite ecrit dans le salon : sans place, mieux vaut une erreur
    // franche qu'une candidature passee a l'oral sans salon d'entretien.
    queueWhenFull: false,
  });

  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId }, select: { channelId: true } });
  if (!ticket?.channelId) throw new Error('Le ticket a été créé mais son salon est introuvable');

  const ticketChannel = await client.channels.fetch(ticket.channelId).catch(() => null);

  if (ticketChannel instanceof TextChannel) {
    // Détail de la candidature, en plus de l'accueil générique du ticket
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`📋 Recrutement - ${pseudo}`)
      .setDescription(`Ce ticket a été créé pour l'entretien oral de **${pseudo}**.\n\nCandidat : <@${targetDiscordUserId}>\nDate de candidature : <t:${Math.floor(new Date(candidature.createdAt).getTime() / 1000)}:f>`)
      .setFooter({ text: `Kotbo · Recrutement · ID: ${candidatureId}` })
      .setTimestamp();

    await ticketChannel.send({ embeds: [embed], allowedMentions: { parse: [] } });

    // Send the mention + availability message
    await ticketChannel.send({
      content: `<@${targetDiscordUserId}> 🎉 **Bienvenue dans ton ticket de recrutement !**\n\nTa candidature a été validée pour un entretien oral. Merci de **définir tes disponibilités pour un vocal** avec l'équipe de recrutement.\n\nIndique les jours et horaires qui te conviennent le mieux. 📅`,
    });
  }

  // Update the candidature
  const updated = await prisma.recruitmentCandidature.update({
    where: { id: candidatureId },
    data: {
      status: 'ORAL',
      oralResult: 'PENDING',
      ticketChannelId: ticket.channelId,
      processedByUserId,
    },
  });

  logger.success('Recruitment', `Ticket créé (${ticketId}) pour ${pseudo} (${targetDiscordUserId})`);

  if (targetDiscordUserId) {
    await notify({
      guildId,
      userId: targetDiscordUserId,
      kind: 'recruitment.application_accepted',
      title: 'Candidature validée',
      message: 'Félicitations ! Votre candidature a été validée pour un entretien oral. Un ticket a été ouvert.',
      severity: 'SUCCESS',
      link: '/recruitment',
      actorId: processedByUserId,
    }).catch(() => null);
  }

  return updated;
}

// ============================================================================
// REJECT  → Send DM with reason
// ============================================================================

export async function rejectCandidature(
  client: Client,
  guildId: string,
  candidatureId: string,
  reason?: string,
  processedByUserId?: string,
) {
  const candidature = await prisma.recruitmentCandidature.findUnique({ where: { id: candidatureId } });
  if (!candidature) throw new Error('Candidature introuvable');

  const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);

  const result = await prisma.recruitmentCandidature.update({
    where: { id: candidatureId },
    data: {
      status: 'REJECTED',
      rejectionReason: reason || null,
      processedByUserId: processedByUserId || null,
    },
  });

  if (candidature.discordId) {
    await notify({
      guildId,
      userId: candidature.discordId,
      kind: 'recruitment.application_rejected',
      title: 'Candidature refusée',
      message: reason
        ? `Votre candidature sur **${discordGuild?.name ?? guildId}** a été refusée.\n\n**Raison :** ${reason}`
        : `Votre candidature sur **${discordGuild?.name ?? guildId}** a été refusée. Aucune raison spécifique n'a été communiquée.`,
      severity: 'ERROR',
      link: '/recruitment',
      actorId: processedByUserId,
    }).catch(() => null);
  }

  return result;
}

// ============================================================================
// ORAL COMPLETE → pass or fail
// ============================================================================

export async function completeOral(
  client: Client,
  guildId: string,
  candidatureId: string,
  result: 'PASSED' | 'FAILED',
  reason?: string,
  processedByUserId?: string,
  hierarchyId?: string,
  hierarchyGrade?: string,
) {
  const candidature = await prisma.recruitmentCandidature.findUnique({
    where: { id: candidatureId },
    include: { customForm: { select: { hierarchyId: true } } },
  });
  if (!candidature) throw new Error('Candidature introuvable');

  const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);

  if (result === 'FAILED') {
    // Calculate reapply date (1 month from now)
    const reapplyDate = new Date();
    reapplyDate.setMonth(reapplyDate.getMonth() + 1);
    const reapplyTimestamp = Math.floor(reapplyDate.getTime() / 1000);

    if (candidature.discordId) {
      await notify({
        guildId,
        userId: candidature.discordId,
        kind: 'recruitment.application_rejected',
        title: 'Entretien oral non concluant',
        message:
          `Votre entretien oral sur **${discordGuild?.name ?? guildId}** n'a malheureusement pas été concluant.\n\n` +
          (reason ? `**Raison :** ${reason}\n\n` : '') +
          `Vous pourrez re-candidater à partir du <t:${reapplyTimestamp}:f> (<t:${reapplyTimestamp}:R>).`,
        severity: 'ERROR',
        link: '/recruitment',
        actorId: processedByUserId,
      }).catch(() => null);
    }

    return await prisma.recruitmentCandidature.update({
      where: { id: candidatureId },
      data: {
        oralResult: 'FAILED',
        oralNotes: reason || null,
        status: 'REJECTED',
        rejectionReason: reason || 'Entretien oral non concluant',
        reapplyAfter: reapplyDate,
        processedByUserId: processedByUserId || null,
      },
    });
  }

  // PASSED - Create staff member
  if (!candidature.discordId) {
    throw new Error('Impossible de créer le membre staff : aucun Discord ID associé à la candidature.');
  }

  const guild = await prisma.guild.findUnique({ where: { id: guildId } });

  // Si la candidature vient d'un formulaire de recrutement lié à une hiérarchie
  // (ex: "Modération" vs "Animation"), on l'utilise pour choisir le bon rôle,
  // sauf override manuel explicite (paramètre hierarchyId).
  const effectiveHierarchyId = hierarchyId ?? candidature.customForm?.hierarchyId ?? undefined;

  // Find the "Helper Test" grade or lowest level staff role, scoped to the
  // relevant hierarchy when known (avoids assigning the same role to
  // recruitments coming from different hierarchies).
  const staffRoles = await prisma.staffRole.findMany({
    where: { guildId, enabled: true, ...(effectiveHierarchyId ? { hierarchyId: effectiveHierarchyId } : {}) },
    orderBy: { level: 'asc' },
  });
  const helperTestRole = staffRoles.find(r => r.name.toLowerCase().includes('helper') || r.name.toLowerCase().includes('test')) || staffRoles[0];
  const gradeName = helperTestRole?.name || 'Helper Test';
  const effectiveHierarchyGrade = hierarchyGrade ?? (effectiveHierarchyId ? gradeName : undefined);

  // Get Discord member info for the staff member
  let userTag: string | undefined;
  let username: string | undefined;
  let displayName: string | undefined;
  let avatarUrl: string | undefined;

  if (discordGuild && candidature.discordId) {
    try {
      const member = await discordGuild.members.fetch(candidature.discordId).catch(() => null);
      if (member) {
        userTag = member.user.tag;
        username = member.user.username;
        displayName = member.displayName;
        avatarUrl = member.user.displayAvatarURL() || undefined;
      }
    } catch { /* ignore */ }
  }

  // Create the staff member
  const staffMember = await upsertStaffMemberRow(guildId, candidature.discordId, {
    update: {
      grade: gradeName,
      userTag,
      username,
      displayName,
      avatarUrl,
    },
    create: {
      grade: gradeName,
      userTag,
      username,
      displayName,
      avatarUrl,
    },
  });

  // Associate with hierarchy if specified (explicit override or derived from the source form)
  if (effectiveHierarchyId && effectiveHierarchyGrade) {
    await upsertHierarchyGradeRow(staffMember.id, effectiveHierarchyId, effectiveHierarchyGrade).catch(() => null);
  }

  // Create a testing period
  await prisma.testingPeriod.create({
    data: {
      guildId,
      staffUserId: staffMember.id,
      plannedDurationDays: 14,
      targetGrade: gradeName,
      hierarchyId: effectiveHierarchyId ?? null,
    },
  });

  // Assign Discord roles
  if (discordGuild && candidature.discordId) {
    try {
      const discordMember = await discordGuild.members.fetch(candidature.discordId).catch(() => null);
      if (discordMember) {
        const rolesToAssign: string[] = [];

        if (helperTestRole?.discordRoleId) rolesToAssign.push(helperTestRole.discordRoleId);
        if (guild?.baseStaffRoleId) rolesToAssign.push(guild.baseStaffRoleId);
        if (guild?.testStaffRoleId) rolesToAssign.push(guild.testStaffRoleId);

        if (rolesToAssign.length > 0) {
          await discordMember.roles.add(rolesToAssign).catch(err =>
            logger.error('Recruitment', `Erreur attribution rôles staff: ${err.message}`)
          );
        }
      }
    } catch (err) {
      logger.error('Recruitment', `Erreur sync rôles Discord: ${err}`);
    }
  }

  // Update the candidature
  const updated = await prisma.recruitmentCandidature.update({
    where: { id: candidatureId },
    data: {
      oralResult: 'PASSED',
      oralNotes: reason || null,
      status: 'APPROVED',
      staffMemberId: staffMember.id,
      processedByUserId: processedByUserId || null,
    },
  });

  logger.success('Recruitment', `Candidature ${candidatureId} APPROVED → StaffMember ${staffMember.id} créé (${gradeName})`);

  if (candidature.discordId) {
    await notify({
      guildId,
      userId: candidature.discordId,
      kind: 'recruitment.promoted',
      title: 'Promotion Staff !',
      message: `Félicitations ! Vous avez réussi votre entretien oral et rejoignez l'équipe en tant que ${gradeName}.`,
      severity: 'SUCCESS',
      link: '/',
      actorId: processedByUserId,
    }).catch(() => null);
  }

  return updated;
}

// ============================================================================
// TUTOR MANAGEMENT
// ============================================================================

/** Get eligible tutors: staff members with a grade whose StaffRole level ≥ 2 */
export async function getEligibleTutors(guildId: string) {
  // First get all roles with level ≥ 2
  const eligibleRoles = await prisma.staffRole.findMany({
    where: { guildId, enabled: true, level: { gte: 2 } },
  });
  const eligibleGradeNames = eligibleRoles.map(r => r.name);

  if (eligibleGradeNames.length === 0) return [];

  // Then find staff members with those grades OR with isTutor flag
  return prisma.staffMember.findMany({
    where: {
      guildId,
      OR: [
        { grade: { in: eligibleGradeNames } },
        { isTutor: true }
      ]
    },
    orderBy: { grade: 'asc' },
  });
}

/** Assign a tutor to a candidature's testing period */
export async function assignTutor(candidatureId: string, tutorUserId: string) {
  const candidature = await prisma.recruitmentCandidature.findUnique({
    where: { id: candidatureId },
  });
  if (!candidature) throw new Error('Candidature introuvable');
  if (!candidature.staffMemberId) throw new Error('Aucun StaffMember lié à cette candidature');

  // Find the tutor's staff member record
  const tutor = await prisma.staffMember.findUnique({
    where: { guildId_userId: { guildId: candidature.guildId, userId: tutorUserId } },
  });
  if (!tutor) throw new Error('Tuteur introuvable dans le staff');

  // Find the ONGOING testing period for this staff member
  const testingPeriod = await prisma.testingPeriod.findFirst({
    where: {
      guildId: candidature.guildId,
      staffUserId: candidature.staffMemberId,
      status: 'ONGOING',
    },
  });

  if (testingPeriod) {
    await prisma.testingPeriod.update({
      where: { id: testingPeriod.id },
      data: { mentorId: tutor.id },
    });
  }

  // Update candidature
  const updated = await prisma.recruitmentCandidature.update({
    where: { id: candidatureId },
    data: { assignedTutorId: tutor.id },
  });

  // Notifier le tuteur
  await notify({
    guildId: candidature.guildId,
    userId: tutorUserId,
    kind: 'recruitment.tutor_assigned',
    title: 'Nouveau tutoré assigné',
    message: `Vous avez été assigné comme tuteur pour ${candidature.username}.`,
    link: '/recruitment',
  }).catch(() => null);

  return updated;
}

// ============================================================================
// CANDIDATURE HISTORY
// ============================================================================

/** Get full candidature history for a Discord user across all statuses */
export async function getCandidatureHistory(guildId: string, discordId: string) {
  return prisma.recruitmentCandidature.findMany({
    where: { guildId, discordId },
    orderBy: { createdAt: 'desc' },
  });
}

// ============================================================================
// FIELD LABEL RESOLUTION
// ============================================================================

/** Maps form field IDs to their human-readable question label, from the linked form's structure. */
async function getFormFieldLabelMap(candidature: { formId: string | null; customFormId: string | null }): Promise<Record<string, string>> {
  let structure: unknown = null;

  if (candidature.customFormId) {
    const form = await prisma.customForm.findUnique({ where: { id: candidature.customFormId }, select: { structure: true } });
    structure = form?.structure;
  } else if (candidature.formId) {
    const form = await prisma.recruitmentForm.findUnique({ where: { id: candidature.formId }, select: { structure: true } });
    structure = form?.structure;
  }

  const fields = (structure as { fields?: Array<{ id: string; label: string }> } | null)?.fields;
  if (!fields?.length) return {};
  return Object.fromEntries(fields.map((f) => [f.id, f.label]));
}

// ============================================================================
// TICKET BUTTON HANDLERS
// ============================================================================

/**
 * Gère les boutons `recruit:*` des tickets de recrutement créés avant la
 * migration vers le système de tickets générique. Les nouveaux entretiens
 * utilisent les boutons `ticket:*` (voir `approveCandidature`), gérés par
 * `handleTicketButton`.
 */
export async function handleRecruitmentButton(
  client: Client,
  customId: string,
  interaction: ButtonInteraction,
) {
  const parts = customId.split(':');
  const action = parts[1]; // claim, info, close, delete
  const candidatureId = parts[2];

  if (!candidatureId) return;

  const candidature = await prisma.recruitmentCandidature.findUnique({ where: { id: candidatureId } });
  if (!candidature) {
    await interaction.reply({ content: '❌ Candidature introuvable.', ephemeral: true });
    return;
  }

  if (action === 'claim') {
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setDescription(`🙋 Ce ticket a été pris en charge par <@${interaction.user.id}>.`)
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
  }

  else if (action === 'info') {
    const data = candidature.data as Record<string, unknown>;
    const labelMap = await getFormFieldLabelMap(candidature);
    const fields = Object.entries(data)
      .filter(([, v]) => v !== null && v !== undefined && String(v).length > 0)
      .slice(0, 25)
      .map(([k, v]) => ({
        name: (labelMap[k] || k).slice(0, 256),
        value: String(Array.isArray(v) ? v.join(', ') : v).slice(0, 1024),
        inline: String(v).length < 60,
      }));

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`📋 Informations - ${candidature.username || 'Candidat'}`)
      .addFields(fields)
      .setFooter({ text: `Candidature ID: ${candidatureId}` })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  else if (action === 'close') {
    const channel = interaction.channel;
    // Les salons de MP et les fils n'ont pas de surcharges de permissions.
    if (channel && 'permissionOverwrites' in channel && candidature.discordId) {
      // Remove candidate's view access
      await channel.permissionOverwrites.edit(candidature.discordId, {
        ViewChannel: false,
      }).catch(() => null);
    }

    const embed = new EmbedBuilder()
      .setColor(0xfee75c)
      .setDescription(`🔒 Ticket fermé par <@${interaction.user.id}>.`)
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  }

  else if (action === 'delete') {
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setDescription(`🗑️ Ce ticket sera supprimé dans 5 secondes...`);

    await interaction.reply({ embeds: [embed] });

    setTimeout(async () => {
      try {
        await interaction.channel?.delete().catch(() => null);
      } catch (err) {
        logger.warn('Recruitment', `Erreur suppression ticket: ${err}`);
      }
    }, 5000);
  }
}
