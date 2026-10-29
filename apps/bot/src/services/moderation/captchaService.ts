import { type Client, type Guild, type GuildMember, type Message, type TextChannel, ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { createCanvas } from '@napi-rs/canvas';
import crypto from 'node:crypto';
import prisma from '../../utils/db.js';
import { notifyJoinBlocked } from '../notifications/notifyService.js';
import { logger } from '../../utils/logger.js';
import { COLORS } from '../../utils/embeds.js';
import type { CaptchaSession, RaidProtectionConfig } from '@prisma/client';
import { getRaidProtectionConfig } from './raidProtectionService.js';
import { restorePersistedRoles } from './rolePersistenceService.js';
import {
  checkVoiceReadiness,
  estimateTurnMs,
  generateVoiceCode,
  getQueueLength,
  normalizeVoiceLocale,
} from './voiceCaptchaService.js';

// Lettres sans ambiguïté (pas de I/O/0/1…)
const CAPTCHA_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CAPTCHA_LENGTH = 6;

function generateCode(): string {
  let code = '';
  for (let i = 0; i < CAPTCHA_LENGTH; i++) {
    code += CAPTCHA_ALPHABET[crypto.randomInt(CAPTCHA_ALPHABET.length)];
  }
  return code;
}

/** Génère l'image du captcha : lettres déformées + bruit (lignes, points). */
export function renderCaptchaImage(code: string): Buffer {
  const width = 360;
  const height = 140;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Fond
  ctx.fillStyle = '#2b2d31';
  ctx.fillRect(0, 0, width, height);

  // Lignes de bruit
  for (let i = 0; i < 8; i++) {
    ctx.strokeStyle = `rgba(${crypto.randomInt(100, 255)}, ${crypto.randomInt(100, 255)}, ${crypto.randomInt(100, 255)}, 0.35)`;
    ctx.lineWidth = 1 + crypto.randomInt(2);
    ctx.beginPath();
    ctx.moveTo(crypto.randomInt(width), crypto.randomInt(height));
    ctx.bezierCurveTo(
      crypto.randomInt(width), crypto.randomInt(height),
      crypto.randomInt(width), crypto.randomInt(height),
      crypto.randomInt(width), crypto.randomInt(height)
    );
    ctx.stroke();
  }

  // Lettres déformées
  const step = width / (code.length + 1);
  for (let i = 0; i < code.length; i++) {
    const fontSize = 52 + crypto.randomInt(16);
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.fillStyle = `rgb(${crypto.randomInt(180, 255)}, ${crypto.randomInt(180, 255)}, ${crypto.randomInt(180, 255)})`;
    ctx.save();
    const x = step * (i + 0.7) + crypto.randomInt(-8, 9);
    const y = height / 2 + crypto.randomInt(-12, 13);
    ctx.translate(x, y);
    ctx.rotate(((crypto.randomInt(-25, 26)) * Math.PI) / 180);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(code[i], 0, 0);
    ctx.restore();
  }

  // Points de bruit
  for (let i = 0; i < 120; i++) {
    ctx.fillStyle = `rgba(${crypto.randomInt(255)}, ${crypto.randomInt(255)}, ${crypto.randomInt(255)}, 0.4)`;
    ctx.fillRect(crypto.randomInt(width), crypto.randomInt(height), 2, 2);
  }

  return canvas.toBuffer('image/png');
}

// ── Cycle de vie d'une session ────────────────────────────────────────────────

/**
 * Détermine si ce membre peut réellement passer par le vocal. Tout empêchement
 * (mode désactivé, salon mal configuré, pack audio absent, file saturée) doit
 * dégrader vers l'image plutôt que bloquer une arrivée légitime.
 */
async function shouldUseVoice(member: GuildMember, config: RaidProtectionConfig): Promise<boolean> {
  if (config.captchaMode !== 'VOICE') return false;

  const readiness = await checkVoiceReadiness(member.guild, config);
  if (!readiness.ok) {
    await reportVoiceMisconfiguration(member.guild.id, member.client, config, readiness.reason);
    return false;
  }

  // La diffusion audio est sérielle : au-delà du seuil, l'attente dépasserait
  // le délai d'expiration et la file se mettrait à expulser des légitimes.
  if (getQueueLength(member.guild.id) >= config.captchaVoiceQueueLimit) {
    logger.info('Captcha', `File vocale saturée sur ${member.guild.id}, repli sur l'image`);
    return false;
  }

  return true;
}

// Dernier motif signalé par serveur : une mauvaise configuration est invisible
// côté membre, l'administrateur doit donc l'apprendre. Mais une vague d'arrivées
// ne doit pas inonder les logs du même message.
const reportedIssues = new Map<string, string>();

async function reportMisconfiguration(
  guildId: string,
  client: Client,
  config: RaidProtectionConfig,
  message: string
): Promise<void> {
  if (reportedIssues.get(guildId) === message) return;
  reportedIssues.set(guildId, message);

  logger.warn('Captcha', `${guildId} : ${message}`);
  await logCaptcha(client, guildId, config, `⚠️ ${message}`);
}

async function reportVoiceMisconfiguration(
  guildId: string,
  client: Client,
  config: RaidProtectionConfig,
  reason: string
): Promise<void> {
  await reportMisconfiguration(
    guildId,
    client,
    config,
    `Captcha vocal inutilisable, ${reason}. Les arrivants basculent sur le captcha image en attendant.`
  );
}

export async function hasPendingCaptchaSession(guildId: string, userId: string): Promise<boolean> {
  const session = await prisma.captchaSession.findFirst({
    // Un captcha gelé (Shield 2 et 1) compte comme en cours : le membre est
    // retenu, ses rôles ne doivent pas lui être rendus pour autant.
    where: { guildId, userId, status: { in: ['PENDING', 'FROZEN'] }, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  return session !== null;
}

/** Durée de rétention d'un captcha gelé : l'alerte peut durer. */
const FROZEN_SESSION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Fin du gel (Shield redescendu à 3 ou plus) : chaque membre retenu reçoit
 * son défi, dans l'ordre d'arrivée. Ceux qui sont partis entre-temps sont
 * oubliés.
 */
export async function releaseFrozenCaptchas(guild: Guild): Promise<number> {
  const config = await prisma.raidProtectionConfig.findUnique({ where: { guildId: guild.id } });
  if (!config) return 0;
  const frozen = await prisma.captchaSession.findMany({
    where: { guildId: guild.id, status: 'FROZEN' },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });
  let released = 0;
  for (const session of frozen) {
    const member = await guild.members.fetch(session.userId).catch(() => null);
    if (!member) {
      await prisma.captchaSession.update({ where: { id: session.id }, data: { status: 'EXPIRED' } });
      continue;
    }
    await startCaptchaChallenge(member, config);
    released++;
  }
  return released;
}

/**
 * À l'arrivée d'un membre : applique le rôle non-vérifié, crée la session et
 * envoie le défi (image ou vocal) dans le salon de vérification.
 */
export async function startCaptchaChallenge(member: GuildMember, config: RaidProtectionConfig, opts: { frozen?: boolean } = {}): Promise<void> {
  if (member.user.bot) return;

  // Sans salon ni rôle, le captcha ne peut rien faire. Rester muet ici laisse
  // l'administrateur avec une case cochée qui ne produit jamais rien.
  const unverifiedRoleId = config.captchaUnverifiedRoleId;
  const missing = [
    !config.captchaChannelId && 'salon de vérification',
    !unverifiedRoleId && 'rôle non-vérifié',
  ].filter(Boolean) as string[];
  if (missing.length || !unverifiedRoleId) {
    await reportMisconfiguration(
      member.guild.id,
      member.client,
      config,
      `Captcha activé mais inutilisable, ${missing.join(' et ')} non configuré(s). Les arrivants entrent sans vérification.`
    );
    return;
  }

  const me = member.guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await reportMisconfiguration(
      member.guild.id,
      member.client,
      config,
      'Captcha inutilisable, permission « Gérer les rôles » manquante. Les arrivants entrent sans vérification.'
    );
    return;
  }

  await member.roles.add(unverifiedRoleId, 'Captcha : vérification requise').catch((err) => {
    logger.error('Captcha', `Impossible d'ajouter le rôle non-vérifié à ${member.id}`, err);
  });

  // Expire les sessions précédentes du membre
  await prisma.captchaSession.updateMany({
    where: { guildId: member.guild.id, userId: member.id, status: { in: ['PENDING', 'FROZEN'] } },
    data: { status: 'EXPIRED' },
  });

  // Captcha gelé (Shield 2 et 1) : le membre attend derrière la porte, sans
  // défi ni chrono. releaseFrozenCaptchas le lui enverra à la fin de l'alerte.
  if (opts.frozen) {
    await prisma.captchaSession.create({
      data: {
        guildId: member.guild.id,
        userId: member.id,
        code: generateCode(),
        status: 'FROZEN',
        mode: 'IMAGE',
        expiresAt: new Date(Date.now() + FROZEN_SESSION_MS),
      },
    });
    return;
  }

  const useVoice = await shouldUseVoice(member, config);
  const session = await prisma.captchaSession.create({
    data: {
      guildId: member.guild.id,
      userId: member.id,
      // L'alphabet vocal dépend de la langue : chaque pack n'énonce que les
      // symboles pour lesquels il a un clip.
      code: useVoice ? generateVoiceCode(normalizeVoiceLocale(config.captchaVoiceLocale)) : generateCode(),
      mode: useVoice ? 'VOICE' : 'IMAGE',
      // En vocal le chrono ne démarre qu'au tour du membre (voir announceTurn).
      awaitingTurn: useVoice,
      expiresAt: new Date(Date.now() + config.captchaTimeoutMinutes * 60 * 1000),
    },
  });

  if (useVoice) await sendVoiceChallenge(member, config, session);
  else await sendImageChallenge(member, config, session);
}

async function sendImageChallenge(member: GuildMember, config: RaidProtectionConfig, session: CaptchaSession): Promise<void> {
  if (!config.captchaChannelId) return;
  const channel = await member.guild.channels.fetch(config.captchaChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  const attachment = new AttachmentBuilder(renderCaptchaImage(session.code), { name: 'captcha.png' });
  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('🔐 Vérification requise')
    .setDescription(
      `Bienvenue ${member} !\n\nPour accéder au serveur, tape les **${session.code.length} caractères** affichés sur l'image ci-dessous dans ce salon.\n\n` +
      `⏱️ Tu as **${config.captchaTimeoutMinutes} minutes** et **${config.captchaMaxAttempts} tentatives**.`
    )
    .setImage('attachment://captcha.png')
    .setFooter({ text: 'Ce défi permet de vérifier que tu n\'es pas un robot.' });

  const sent = await (channel as TextChannel).send({ content: `${member}`, embeds: [embed], files: [attachment] }).catch(() => null);
  if (sent) {
    await prisma.captchaSession.update({ where: { id: session.id }, data: { messageId: sent.id } });
  }
}

async function sendVoiceChallenge(member: GuildMember, config: RaidProtectionConfig, session: CaptchaSession): Promise<void> {
  if (!config.captchaChannelId || !config.captchaVoiceChannelId) return;
  const channel = await member.guild.channels.fetch(config.captchaChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  const waiting = getQueueLength(member.guild.id);
  const waitLine = waiting > 0
    ? `\n\n👥 **${waiting}** personne(s) devant toi, soit environ **${Math.ceil((waiting * estimateTurnMs(normalizeVoiceLocale(config.captchaVoiceLocale))) / 1000)} secondes** d'attente.`
    : '';

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('🔊 Vérification vocale requise')
    .setDescription(
      `Bienvenue ${member} !\n\nClique sur **Je suis prêt** quand tu peux écouter du son. ` +
      `À ton tour, le salon vocal <#${config.captchaVoiceChannelId}> s'ouvrira **pour toi seul** : ` +
      `le bot y énoncera un code de **${session.code.length} caractères**, que tu recopieras ici.\n\n` +
      `⏱️ Ton chrono de **${config.captchaTimeoutMinutes} minutes** ne démarre qu'une fois le code énoncé.` +
      waitLine
    )
    .setFooter({ text: 'Pas de son ? Utilise le bouton pour basculer sur un captcha image.' });

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('vcaptcha:start').setLabel('Je suis prêt').setEmoji('🎧').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('vcaptcha:repeat').setLabel('Répéter le code').setEmoji('🔁').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('vcaptcha:fallback').setLabel('Je ne peux pas utiliser le vocal').setStyle(ButtonStyle.Secondary)
  );

  const sent = await (channel as TextChannel).send({ content: `${member}`, embeds: [embed], components: [buttons] }).catch(() => null);
  if (sent) {
    await prisma.captchaSession.update({ where: { id: session.id }, data: { messageId: sent.id } });
  }
}

/**
 * Bascule une session vocale en cours vers le captcha image, sans repartir de
 * zéro : le membre garde son code, ses tentatives et sa session.
 */
export async function deliverImageCaptcha(member: GuildMember, config: RaidProtectionConfig, sessionId: string | null): Promise<void> {
  const session = sessionId
    ? await prisma.captchaSession.findUnique({ where: { id: sessionId } })
    : await prisma.captchaSession.findFirst({
        where: { guildId: member.guild.id, userId: member.id, status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
      });

  if (!session || session.status !== 'PENDING') return;

  await cleanupCaptchaMessage(member.guild.id, session, member.client, config);

  const updated = await prisma.captchaSession.update({
    where: { id: session.id },
    data: {
      mode: 'IMAGE',
      awaitingTurn: false,
      expiresAt: new Date(Date.now() + config.captchaTimeoutMinutes * 60 * 1000),
    },
  });

  await sendImageChallenge(member, config, updated);
}

/**
 * Traite un message posté dans le salon captcha : compare au code attendu.
 * Retourne true si le message a été consommé par le captcha.
 */
export async function handleCaptchaMessage(message: Message): Promise<boolean> {
  if (!message.guild || !message.member || message.author.bot) return false;

  const config = await getRaidProtectionConfig(message.guild.id);
  if (!config?.captchaEnabled || config.captchaChannelId !== message.channelId) return false;

  const session = await prisma.captchaSession.findFirst({
    where: { guildId: message.guild.id, userId: message.author.id, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
  });

  // Le membre n'a pas de session : on nettoie son message pour garder le salon propre
  await message.delete().catch(() => null);
  if (!session) return true;

  const answer = message.content.trim().toUpperCase();

  if (answer === session.code) {
    await prisma.captchaSession.update({ where: { id: session.id }, data: { status: 'VERIFIED' } });
    await cleanupCaptchaMessage(message.guild.id, session, message.client, config);

    // Le rôle vérifié est accordé avant le retrait du non-vérifié, et le retrait
    // n'a lieu que si l'ajout a réussi.
    //
    // Sans cette condition, un rôle vérifié inattribuable - passé au-dessus du
    // bot dans la hiérarchie, par exemple - laissait le membre sans aucun des
    // deux : plus de salon de vérification, aucun accès au reste du serveur, et
    // une session déjà marquée réussie qui lui interdisait de retenter. Le
    // garder non-vérifié le laisse au moins là où on peut le voir.
    let granted = true;
    if (config.captchaVerifiedRoleId) {
      granted = await message.member.roles.add(config.captchaVerifiedRoleId, 'Captcha réussi')
        .then(() => true)
        .catch(async (err) => {
          await reportMisconfiguration(
            message.guild!.id,
            message.client,
            config,
            "Rôle vérifié non attribuable, vérifie qu'il est sous le rôle du bot dans la hiérarchie."
          );
          logger.error('Captcha', `Ajout du rôle vérifié impossible pour ${message.author.id}`, err);
          return false;
        });
    }

    if (granted && config.captchaUnverifiedRoleId) {
      await message.member.roles.remove(config.captchaUnverifiedRoleId, 'Captcha réussi').catch(() => null);
    }

    if (granted) {
      await restorePersistedRoles(message.member, config).catch((err) => {
        logger.error('Captcha', `Restauration des rôles impossible pour ${message.author.id}`, err);
      });
    }

    // Le membre a bien répondu : lui annoncer une réussite alors qu'il n'a rien
    // obtenu le laisserait chercher pourquoi le serveur reste vide.
    const notice = granted
      ? `✅ ${message.author}, vérification réussie ! Bienvenue sur le serveur.`
      : `⚠️ ${message.author}, ton code est bon, mais Kotbo n'a pas pu te donner ton rôle d'accès. Le staff a été prévenu, ton accès arrivera sous peu.`;
    const confirmation = message.channel.isSendable() ? await message.channel.send(notice).catch(() => null) : null;
    if (confirmation) setTimeout(() => confirmation.delete().catch(() => null), granted ? 10_000 : 60_000);
    await logCaptcha(
      message.client,
      message.guild.id,
      config,
      granted
        ? `✅ <@${message.author.id}> a réussi le captcha.`
        : `⚠️ <@${message.author.id}> a réussi le captcha mais n'a pas pu recevoir son rôle d'accès.`,
    );
    return true;
  }

  // Mauvaise réponse
  const attempts = session.attempts + 1;
  if (attempts >= config.captchaMaxAttempts) {
    await prisma.captchaSession.update({ where: { id: session.id }, data: { status: 'FAILED', attempts } });
    await cleanupCaptchaMessage(message.guild.id, session, message.client, config);
    await applyFailAction(message.member, config, 'Échec du captcha (tentatives épuisées)');
    await logCaptcha(message.client, message.guild.id, config, `❌ <@${message.author.id}> a échoué le captcha (${attempts} tentatives), ${config.captchaFailAction === 'BAN' ? 'banni' : 'expulsé'}.`);
  } else {
    await prisma.captchaSession.update({ where: { id: session.id }, data: { attempts } });
    const warning = message.channel.isSendable()
      ? await message.channel.send(`⚠️ ${message.author}, code incorrect. Il te reste **${config.captchaMaxAttempts - attempts}** tentative(s).`).catch(() => null)
      : null;
    if (warning) setTimeout(() => warning.delete().catch(() => null), 8_000);
  }
  return true;
}

async function applyFailAction(member: GuildMember, config: RaidProtectionConfig, reason: string): Promise<void> {
  await notifyJoinBlocked(member.guild.id, member.id, `${reason}. Tu peux retenter en rejoignant à nouveau le serveur.`);
  if (config.captchaFailAction === 'BAN') {
    await member.ban({ reason }).catch(() => null);
  } else {
    await member.kick(reason).catch(() => null);
  }
}

async function cleanupCaptchaMessage(guildId: string, session: CaptchaSession, client: Client, config: RaidProtectionConfig): Promise<void> {
  if (!session.messageId || !config.captchaChannelId) return;
  const guild = client.guilds.cache.get(guildId);
  const channel = guild ? await guild.channels.fetch(config.captchaChannelId).catch(() => null) : null;
  if (channel?.isTextBased()) {
    await (channel as TextChannel).messages.delete(session.messageId).catch(() => null);
  }
}

/**
 * Repli sur le salon de logs du serveur quand le captcha n'a pas le sien.
 *
 * Les avertissements de mauvaise configuration passent par ici, et ce sont
 * justement ceux d'un captcha mal branché : sans repli, un captcha sans salon de
 * journal signalait dans le vide qu'il ne fonctionnait pas.
 */
async function logCaptcha(client: Client, guildId: string, config: RaidProtectionConfig, content: string): Promise<void> {
  let channelId = config.captchaLogChannelId;
  if (!channelId) {
    const guildConfig = await prisma.guild.findUnique({ where: { id: guildId }, select: { logChannelId: true } });
    channelId = guildConfig?.logChannelId ?? null;
  }
  if (!channelId) return;

  const guild = client.guilds.cache.get(guildId);
  const channel = guild ? await guild.channels.fetch(channelId).catch(() => null) : null;
  if (channel?.isTextBased()) {
    await (channel as TextChannel).send(content).catch(() => null);
  }
}

/**
 * Cron : rattrape les sessions vocales orphelines. Un redémarrage du bot perd
 * la file en mémoire ; sans ce filet, le membre garderait indéfiniment le rôle
 * non-vérifié sans jamais entendre son code ni être sanctionné. On le bascule
 * sur l'image plutôt que de le punir d'une panne qui n'est pas la sienne.
 */
export async function recoverStrandedVoiceSessions(client: Client): Promise<void> {
  const { isQueued } = await import('./voiceCaptchaService.js');

  const stranded = await prisma.captchaSession.findMany({
    where: { status: 'PENDING', awaitingTurn: true },
    take: 100,
  });

  for (const session of stranded) {
    const guild = client.guilds.cache.get(session.guildId);
    if (!guild) continue;

    const config = await getRaidProtectionConfig(session.guildId);
    if (!config?.captchaEnabled) continue;

    // Toujours en file ou en plein tour : on ne touche à rien.
    if (isQueued(session.guildId, session.userId)) continue;

    const strandedForMs = Date.now() - session.createdAt.getTime();
    if (strandedForMs < config.captchaTimeoutMinutes * 60 * 1000) continue;

    const member = await guild.members.fetch(session.userId).catch(() => null);
    if (!member) {
      await prisma.captchaSession.update({ where: { id: session.id }, data: { status: 'EXPIRED' } });
      continue;
    }

    await deliverImageCaptcha(member, config, session.id);
    await logCaptcha(client, session.guildId, config, `🔁 <@${session.userId}> était bloqué en file vocale, bascule sur le captcha image.`);
  }
}

/** Cron : expire les sessions dépassées et applique la sanction d'échec. */
export async function expireOverdueCaptchaSessions(client: Client): Promise<void> {
  // awaitingTurn : le membre patiente dans la file vocale et n'a pas encore
  // entendu son code. L'expulser pour un délai qu'il ne maîtrise pas ferait de
  // la file d'attente une machine à sanctionner les membres légitimes.
  const overdue = await prisma.captchaSession.findMany({
    where: { status: 'PENDING', awaitingTurn: false, expiresAt: { lte: new Date() } },
    take: 100,
  });

  for (const session of overdue) {
    await prisma.captchaSession.update({ where: { id: session.id }, data: { status: 'EXPIRED' } });

    const guild = client.guilds.cache.get(session.guildId);
    if (!guild) continue;
    const config = await getRaidProtectionConfig(session.guildId);
    if (!config?.captchaEnabled) continue;

    await cleanupCaptchaMessage(session.guildId, session, client, config);

    const member = await guild.members.fetch(session.userId).catch(() => null);
    // On ne sanctionne que si le membre porte toujours le rôle non-vérifié
    if (member && config.captchaUnverifiedRoleId && member.roles.cache.has(config.captchaUnverifiedRoleId)) {
      await applyFailAction(member, config, 'Captcha expiré (délai dépassé)');
      await logCaptcha(client, session.guildId, config, `⏱️ <@${session.userId}> n'a pas complété le captcha à temps, ${config.captchaFailAction === 'BAN' ? 'banni' : 'expulsé'}.`);
    }
  }
}
