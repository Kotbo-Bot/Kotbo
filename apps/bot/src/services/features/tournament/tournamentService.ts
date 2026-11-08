import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  LabelBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type ButtonInteraction,
  type Client,
  type ModalSubmitInteraction,
  type TextChannel,
} from 'discord.js';
import { Prisma } from '@prisma/client';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { COLORS } from '../../../utils/embeds.js';
import { UserFacingError } from '../../../utils/userFacingError.js';
import { getDashboardUrl } from '../../../api/shared.js';
import { getMemberIdentities } from '../../moderation/memberIdentityService.js';
import type { CustomFormStructure } from '../customFormService.js';
import {
  buildTournament,
  findMatch,
  normalizeScore,
  readTournamentSettings,
  type Entrant,
  type TournamentSettings,
  type TournamentView,
} from './bracket.js';

export function tournamentPublicUrl(guildId: string, eventId: string) {
  return `${getDashboardUrl().replace(/\/$/, '')}/${guildId}/tournaments/${eventId}`;
}

const STAGE_IDS = /^(W|L|GF|P3|PO|G\d{1,2})$/;

async function loadEvent(eventId: string) {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    include: {
      registrations: { orderBy: { createdAt: 'asc' } },
      tournamentMatches: true,
    },
  });
  if (!event || event.type !== 'TOURNAMENT') throw new UserFacingError('Tournoi introuvable.');
  return event;
}

type LoadedEvent = Awaited<ReturnType<typeof loadEvent>>;

function computeView(event: LoadedEvent, names: Map<string, string>): TournamentView {
  const settings = readTournamentSettings(event.config);
  const nameOf = (id: string, fallback?: string | null) => names.get(id) || fallback || 'Joueur';
  const entrants: Entrant[] = event.registrations
    .filter((r) => r.seed !== null)
    .map((r) => ({
      id: r.userId,
      seed: r.seed!,
      name: (settings.teamSize > 1 && r.teamName) || nameOf(r.userId, r.username || r.userTag),
      members: settings.teamSize > 1 ? [r.userId, ...r.teamMemberIds].map((id) => nameOf(id, id === r.userId ? r.username : null)) : [],
    }));
  return buildTournament(settings, entrants, event.tournamentMatches);
}

/** Pourquoi on ne peut plus s'inscrire, ou null si c'est ouvert. */
export function registrationBlocker(
  event: { status: string; config: unknown },
  stats: { seeded: boolean; count: number },
): string | null {
  if (event.status === 'COMPLETED' || event.status === 'CANCELLED') return 'Les inscriptions sont fermées pour ce tournoi.';
  if (stats.seeded) return 'Le tournoi a commencé : les inscriptions sont closes.';
  const { maxEntries } = readTournamentSettings(event.config);
  if (maxEntries && stats.count >= maxEntries) return `Le tournoi est complet (${maxEntries} places).`;
  return null;
}

export async function tournamentRegistrationBlocker(event: { id: string; status: string; config: unknown }) {
  const [seeded, count] = await Promise.all([
    prisma.customEventRegistration.count({ where: { eventId: event.id, seed: { not: null } } }),
    prisma.customEventRegistration.count({ where: { eventId: event.id } }),
  ]);
  return registrationBlocker(event, { seeded: seeded > 0, count });
}

/**
 * Tout l'état d'un tournoi. Avec `client`, les pseudos viennent du serveur
 * (affichage à jour) ; sans, du pseudo figé à l'inscription.
 */
export async function getTournament(eventId: string, client?: Client) {
  const event = await loadEvent(eventId);
  const ids = event.registrations.flatMap((r) => [r.userId, ...r.teamMemberIds]);
  const names = new Map<string, string>();
  if (client && ids.length) {
    const identities = await getMemberIdentities(client, event.guildId, ids).catch(() => new Map());
    identities.forEach((identity, id) => names.set(id, identity.displayName));
  }
  const view = computeView(event, names);
  return {
    event: { id: event.id, guildId: event.guildId, title: event.title, description: event.description, status: event.status },
    registrations: event.registrations.length,
    seeded: view.entrants.length > 0,
    ...view,
  };
}

/** Pose les têtes de série et démarre le tournoi. Efface les scores d'un arbre précédent. */
export async function generateTournament(eventId: string, shuffle: boolean) {
  const event = await loadEvent(eventId);
  const registrations = event.registrations.map((r) => r.id);
  if (registrations.length < 2) throw new UserFacingError("Il faut au moins 2 inscrits pour générer l'arbre.");
  const order = shuffle ? [...registrations].sort(() => Math.random() - 0.5) : registrations;
  await prisma.$transaction([
    prisma.eventTournamentMatch.deleteMany({ where: { eventId } }),
    ...order.map((id, i) => prisma.customEventRegistration.update({ where: { id }, data: { seed: i + 1 } })),
    prisma.event.update({ where: { id: eventId }, data: { status: 'ONGOING' } }),
  ]);
}

/** Échange deux têtes de série (glisser un joueur à la place d'un autre avant de lancer). */
export async function swapTournamentSeeds(eventId: string, seedA: number, seedB: number) {
  const event = await loadEvent(eventId);
  const a = event.registrations.find((r) => r.seed === seedA);
  const b = event.registrations.find((r) => r.seed === seedB);
  if (!a || !b || a.id === b.id) throw new UserFacingError('Têtes de série introuvables.');
  await prisma.$transaction([
    prisma.customEventRegistration.update({ where: { id: a.id }, data: { seed: seedB } }),
    prisma.customEventRegistration.update({ where: { id: b.id }, data: { seed: seedA } }),
  ]);
}

/** Remet le tournoi en inscriptions : têtes de série et scores effacés. */
export async function resetTournament(eventId: string) {
  await loadEvent(eventId);
  await prisma.$transaction([
    prisma.eventTournamentMatch.deleteMany({ where: { eventId } }),
    prisma.customEventRegistration.updateMany({ where: { eventId }, data: { seed: null } }),
    prisma.event.update({ where: { id: eventId }, data: { status: 'PUBLISHED' } }),
  ]);
}

function matchKey(stage: string, round: number, position: number) {
  if (!STAGE_IDS.test(stage) || !Number.isInteger(round) || round < 1 || !Number.isInteger(position) || position < 0) {
    throw new UserFacingError('Match introuvable.');
  }
  return { stage, round, position };
}

export async function reportTournamentMatch(
  eventId: string,
  stage: string,
  round: number,
  position: number,
  input: { score1?: unknown; score2?: unknown; sets?: unknown },
) {
  const key = matchKey(stage, round, position);
  const event = await loadEvent(eventId);
  const view = computeView(event, new Map());
  const match = findMatch(view, stage, round, position);
  if (!match) throw new UserFacingError('Match introuvable.');
  const score = normalizeScore(match, input, view.settings.setDetail);
  if ('error' in score) throw new UserFacingError(score.error);

  const data = {
    player1Id: match.player1!.id,
    player2Id: match.player2!.id,
    score1: score.score1,
    score2: score.score2,
    sets: score.sets ? (score.sets as Prisma.InputJsonValue) : Prisma.JsonNull,
  };
  await prisma.eventTournamentMatch.upsert({
    where: { eventId_stage_round_position: { eventId, ...key } },
    create: { eventId, ...key, ...data },
    update: data,
  });
}

export async function resetTournamentMatch(eventId: string, stage: string, round: number, position: number) {
  const key = matchKey(stage, round, position);
  await prisma.eventTournamentMatch.deleteMany({ where: { eventId, ...key } });
}

// ============================================================================
// DISCORD
// ============================================================================

/** Inscription d'une équipe : nom, coéquipiers choisis dans le serveur, et les premiers champs du formulaire lié. */
export function buildTeamModal(eventId: string, settings: TournamentSettings, form: CustomFormStructure | null) {
  const mates = settings.teamSize - 1;
  const modal = new ModalBuilder()
    .setCustomId(`tournament-team-modal:${eventId}`)
    .setTitle("Inscrire ton équipe");
  modal.addLabelComponents(
    new LabelBuilder()
      .setLabel("Nom de l'équipe")
      .setTextInputComponent(new TextInputBuilder().setCustomId('team_name').setStyle(TextInputStyle.Short).setMinLength(2).setMaxLength(40).setRequired(true)),
    new LabelBuilder()
      .setLabel(mates === 1 ? 'Ton coéquipier' : `Tes ${mates} coéquipiers`)
      .setUserSelectMenuComponent(new UserSelectMenuBuilder().setCustomId('team_members').setMinValues(mates).setMaxValues(mates).setRequired(true)),
  );
  // Discord accepte 5 composants : il en reste 3 pour le formulaire.
  const fields = (form?.fields ?? []).filter((f) => ['short_text', 'paragraph', 'email', 'number', 'date'].includes(f.type)).slice(0, 3);
  for (const field of fields) {
    const input = new TextInputBuilder()
      .setCustomId(field.id)
      .setStyle(field.type === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(field.required);
    if (field.description) input.setPlaceholder(field.description.slice(0, 100));
    modal.addLabelComponents(new LabelBuilder().setLabel(field.label.slice(0, 45)).setTextInputComponent(input));
  }
  return modal;
}

export async function showTournamentRegistration(interaction: ButtonInteraction, eventId: string) {
  const event = await prisma.event.findUnique({ where: { id: eventId }, include: { customForm: true } });
  if (!event || event.type !== 'TOURNAMENT') return interaction.reply({ content: '❌ Tournoi introuvable.', ephemeral: true });
  const blocker = await tournamentRegistrationBlocker(event);
  if (blocker) return interaction.reply({ content: `❌ ${blocker}`, ephemeral: true });

  const settings = readTournamentSettings(event.config);
  if (settings.teamSize > 1) {
    return interaction.showModal(buildTeamModal(eventId, settings, (event.customForm?.structure ?? null) as CustomFormStructure | null));
  }
  const { buildFormModal, handleDirectRegistration } = await import('../customFormService.js');
  if (event.formId && event.customForm) {
    return interaction.showModal(buildFormModal(event.formId, eventId, event.customForm.structure as unknown as CustomFormStructure));
  }
  return handleDirectRegistration(interaction, eventId);
}

export async function handleTournamentTeamModal(interaction: ModalSubmitInteraction, eventId: string) {
  const guildId = interaction.guildId!;
  const captainId = interaction.user.id;
  const reply = (content: string) => interaction.reply({ content, ephemeral: true });

  const event = await prisma.event.findFirst({ where: { id: eventId, guildId, type: 'TOURNAMENT' } });
  if (!event) return reply('❌ Tournoi introuvable.');
  const blocker = await tournamentRegistrationBlocker(event);
  if (blocker) return reply(`❌ ${blocker}`);

  const settings = readTournamentSettings(event.config);
  const teamName = interaction.fields.getTextInputValue('team_name').trim();
  const mates = [...(interaction.fields.getSelectedUsers('team_members')?.values() ?? [])];
  if (teamName.length < 2) return reply("❌ Le nom de l'équipe est trop court.");
  if (mates.some((u) => u.bot)) return reply('❌ Un bot ne peut pas faire partie de ton équipe.');
  const mateIds = [...new Set(mates.map((u) => u.id))].filter((id) => id !== captainId);
  if (mateIds.length !== settings.teamSize - 1) {
    return reply(`❌ Il faut ${settings.teamSize - 1} coéquipier(s) différent(s) de toi.`);
  }

  const people = [captainId, ...mateIds];
  const existing = await prisma.customEventRegistration.findMany({
    where: { eventId, OR: [{ userId: { in: people } }, { teamMemberIds: { hasSome: people } }, { teamName: { equals: teamName, mode: 'insensitive' } }] },
    select: { teamName: true },
  });
  if (existing.some((r) => r.teamName?.toLowerCase() === teamName.toLowerCase())) return reply('❌ Une équipe porte déjà ce nom.');
  if (existing.length) return reply('❌ Toi ou un de tes coéquipiers êtes déjà inscrits dans une équipe.');

  const formData: Record<string, string> = {};
  for (const [id, component] of interaction.fields.fields) {
    if (id !== 'team_name' && 'value' in component && typeof component.value === 'string') formData[id] = component.value;
  }

  if (event.formId) {
    const { submitCustomForm } = await import('../customFormService.js');
    await submitCustomForm(event.formId, guildId, captainId, interaction.user.username, interaction.user.tag, { ...formData, team_name: teamName }, interaction.client, true);
  }
  try {
    await prisma.customEventRegistration.create({
      data: {
        eventId,
        guildId,
        userId: captainId,
        username: interaction.user.username,
        userTag: interaction.user.tag,
        teamName,
        teamMemberIds: mateIds,
        formData: Object.keys(formData).length ? formData : Prisma.JsonNull,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return reply('⚠️ Tu as déjà inscrit une équipe.');
    throw err;
  }
  return reply(`✅ L'équipe **${teamName}** est inscrite avec ${mateIds.map((id) => `<@${id}>`).join(', ')}.`);
}

/** Termine le tournoi et annonce le podium dans le salon d'annonce. */
export async function finishTournament(client: Client, eventId: string) {
  const tournament = await getTournament(eventId, client);
  await prisma.event.update({ where: { id: eventId }, data: { status: 'COMPLETED' } });

  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { announcementChannelId: true } });
  if (event?.announcementChannelId && tournament.seeded) {
    const medals = ['🥇', '🥈', '🥉'];
    const podium = tournament.standings
      .filter((row) => row.placement !== null && row.placement <= 3)
      .map((row) => `${medals[row.placement! - 1]} **${row.entrant.name}**`)
      .join('\n');
    const channel = await client.channels.fetch(event.announcementChannelId).catch(() => null);
    if (channel?.isTextBased() && 'send' in channel) {
      await (channel as TextChannel).send({
        embeds: [new EmbedBuilder()
          .setTitle(`🏆 ${tournament.event.title} est terminé`)
          .setDescription(podium || 'Merci à tous les participants !')
          .setColor(COLORS.success)
          .setTimestamp()],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setLabel("Voir l'arbre final").setStyle(ButtonStyle.Link).setURL(tournamentPublicUrl(tournament.event.guildId, eventId)),
        )],
        allowedMentions: { parse: [] },
      }).catch((err) => logger.warn('Tournament', `Podium non publié pour ${eventId}: ${err}`));
    }
  }
  return { status: 'completed' };
}
