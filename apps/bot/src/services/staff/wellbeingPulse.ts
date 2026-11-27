/**
 * Météo du staff : chaque lundi, les membres des rôles choisis reçoivent en
 * message privé une question notée de 1 à 5.
 *
 * Anonymat : une note n'incrémente qu'un compteur de la semaine, sans date ni
 * auteur. Une empreinte à clé secrète du votant empêche seulement de voter deux
 * fois ; elle est effacée une fois la semaine passée (wellbeingRetention). Le
 * bilan n'affiche une moyenne qu'à partir de PULSE_MIN_RESPONSES réponses.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type ButtonInteraction, type Client } from 'discord.js';
import { Prisma } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { resolveGuildLocale, type BotLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { isModuleEnabled } from '../core/moduleGate.js';
import { weeklyDue } from './wellbeingWorkloadPolicy.js';
import {
  PULSE_BUTTON_PREFIX,
  PULSE_MAX_RECIPIENTS,
  cleanPulseScore,
  pulseVoterHash,
  pulseWeekKey,
} from './wellbeingWatchPolicy.js';

/** Le sondage part le lundi à partir de 10 h (UTC), après le résumé de la cellule. */
const PULSE_HOUR = 10;

function pulseMessage(guildId: string, guildName: string, week: string, locale: BotLocale) {
  return {
    content: m.wbc_pulse_question({ guild: guildName }, { locale }),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...[1, 2, 3, 4, 5].map((score) => new ButtonBuilder()
          .setCustomId(`${PULSE_BUTTON_PREFIX}${guildId}:${week}:${score}`)
          .setStyle(ButtonStyle.Secondary)
          .setLabel(String(score))),
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

export async function sendWeeklyPulses(client: Client, now: Date): Promise<void> {
  const configs = await prisma.wellbeingConfig.findMany({ where: { enabled: true, pulseEnabled: true } });
  for (const config of configs) {
    if (config.pulseRoleIds.length === 0 || !weeklyDue(config.pulseSentAt, now, PULSE_HOUR)) continue;
    if (!(await isModuleEnabled(config.guildId, 'wellbeing'))) continue;
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) continue;
    // Marqué d'abord : une erreur d'envoi ne fait pas repartir le sondage chaque heure.
    await prisma.wellbeingConfig.update({ where: { guildId: config.guildId }, data: { pulseSentAt: now } });
    const week = pulseWeekKey(now);
    const locale = await resolveGuildLocale(guild.id, guild.preferredLocale);
    const recipients = guild.members.cache
      .filter((member) => !member.user.bot && member.roles.cache.some((role) => config.pulseRoleIds.includes(role.id)))
      .first(PULSE_MAX_RECIPIENTS);
    const message = pulseMessage(guild.id, guild.name, week, locale);
    const results = await Promise.allSettled(recipients.map((member) => member.send(message)));
    const failed = results.filter((result) => result.status === 'rejected').length;
    if (failed > 0) logger.warn('Wellbeing', `Météo du staff : ${failed} message(s) privé(s) non remis sur ${guild.id}.`);
  }
}

type ScoreField = 'score1' | 'score2' | 'score3' | 'score4' | 'score5';

/** Colonne d'une note : `{ score3: value }`. */
function scoreField<V>(score: 1 | 2 | 3 | 4 | 5, value: V): Partial<Record<ScoreField, V>> {
  return { [`score${score}`]: value } as Partial<Record<ScoreField, V>>;
}

/** Réponse d'un membre : un compteur de plus, une seule fois par semaine. */
export async function handlePulseButton(interaction: ButtonInteraction): Promise<void> {
  const [guildId, week, rawScore] = interaction.customId.slice(PULSE_BUTTON_PREFIX.length).split(':');
  const score = cleanPulseScore(rawScore ?? '');
  const locale = await resolveGuildLocale(guildId, interaction.locale);
  const reply = (content: string) => interaction.reply({ content, flags: [MessageFlags.Ephemeral] });
  if (!guildId || !week || !score) {
    await reply(m.wbc_pulse_closed({}, { locale }));
    return;
  }
  const config = await prisma.wellbeingConfig.findUnique({ where: { guildId }, select: { enabled: true, pulseEnabled: true, pulseRoleIds: true } });
  // Seule la semaine en cours compte : un vieux message ne vote plus.
  if (!config?.enabled || !config.pulseEnabled || week !== pulseWeekKey(new Date()) || !(await isModuleEnabled(guildId, 'wellbeing'))) {
    await reply(m.wbc_pulse_closed({}, { locale }));
    return;
  }
  // Toujours membre d'un rôle interrogé : le bouton ne se transmet pas à quelqu'un d'autre.
  const member = await interaction.client.guilds.cache.get(guildId)?.members.fetch(interaction.user.id).catch(() => null);
  if (!member || !member.roles.cache.some((role) => config.pulseRoleIds.includes(role.id))) {
    await reply(m.wbc_pulse_closed({}, { locale }));
    return;
  }

  try {
    await prisma.$transaction([
      prisma.wellbeingPulseVoter.create({ data: { guildId, week, voterHash: pulseVoterHash(guildId, week, interaction.user.id) } }),
      prisma.wellbeingPulseWeek.upsert({
        where: { guildId_week: { guildId, week } },
        create: { guildId, week, ...scoreField(score, 1) },
        update: scoreField(score, { increment: 1 }),
      }),
    ]);
  } catch (error) {
    // Empreinte déjà présente : la personne a déjà répondu cette semaine.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      await reply(m.wbc_pulse_already({}, { locale }));
      return;
    }
    throw error;
  }
  await interaction.update({ content: m.wbc_pulse_thanks({}, { locale }), components: [] });
}
