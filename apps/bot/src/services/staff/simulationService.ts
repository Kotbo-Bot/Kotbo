import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Client,
  type Guild,
  type TextChannel,
  type Webhook,
} from 'discord.js';
import {
  buildSessionReport,
  evaluateStep,
  validateScenario,
  type ModerationAction,
  type ScenarioStep,
  type StepAnswer,
} from '@kotbo/shared';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { UserFacingError } from '../../utils/userFacingError.js';

/**
 * Staff Simulator - orchestration d'une session d'entraînement.
 *
 * Les incidents sont injectés par webhook pour apparaître sous l'identité de
 * faux utilisateurs, dans un salon bac à sable et lui seul. Le modérateur en
 * formation répond via les boutons posés sous chaque message : aucune sanction
 * réelle n'est jamais appliquée, ce qui rend l'exercice totalement inoffensif.
 */

const WEBHOOK_NAME = 'Kotbo Simulation';

/** Durées proposées quand la sanction choisie est une exclusion temporaire. */
export const MUTE_CHOICES = [10, 60, 1440] as const;

// ============================================================================
// CONFIGURATION ET SCÉNARIOS
// ============================================================================

export async function getSimulationConfig(guildId: string) {
  const config = await prisma.simulationConfig.findUnique({ where: { guildId } });
  return config ?? {
    guildId,
    enabled: false,
    testChannelId: null,
    stepTimeoutSeconds: 180,
    traineeRoleIds: [] as string[],
  };
}

export async function upsertSimulationConfig(guildId: string, patch: Record<string, unknown>) {
  return prisma.simulationConfig.upsert({
    where: { guildId },
    create: { guildId, ...patch },
    update: patch,
  });
}

export function sanitizeSimulationConfigPatch(body: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (typeof body.testChannelId === 'string' && /^\d{5,25}$/.test(body.testChannelId)) {
    patch.testChannelId = body.testChannelId;
  }
  if (body.testChannelId === null) patch.testChannelId = null;
  if (typeof body.stepTimeoutSeconds === 'number' && Number.isFinite(body.stepTimeoutSeconds)) {
    patch.stepTimeoutSeconds = Math.min(900, Math.max(30, Math.trunc(body.stepTimeoutSeconds)));
  }
  if (Array.isArray(body.traineeRoleIds)) {
    patch.traineeRoleIds = body.traineeRoleIds
      .filter((id): id is string => typeof id === 'string' && /^\d{5,25}$/.test(id))
      .slice(0, 30);
  }

  return patch;
}

export class ScenarioValidationError extends UserFacingError {
  constructor(public readonly issues: { code: string; message: string }[]) {
    super(issues.map((i) => i.message).join(' '));
    this.name = 'ScenarioValidationError';
  }
}

export interface SaveScenarioInput {
  title: string;
  description?: string;
  difficulty?: string;
  enabled?: boolean;
  steps: ScenarioStep[];
}

function assertScenarioValid(input: SaveScenarioInput): void {
  const issues = validateScenario({
    title: input.title,
    steps: input.steps,
  });
  if (issues.length > 0) throw new ScenarioValidationError(issues);
}

export async function createScenario(guildId: string, input: SaveScenarioInput, createdById: string) {
  assertScenarioValid(input);
  return prisma.simulationScenario.create({
    data: {
      guildId,
      title: input.title.trim().slice(0, 120),
      description: (input.description ?? '').slice(0, 1000),
      difficulty: input.difficulty ?? 'MEDIUM',
      enabled: input.enabled ?? true,
      steps: input.steps as never,
      createdById,
    },
  });
}

export async function updateScenario(guildId: string, id: string, input: SaveScenarioInput) {
  assertScenarioValid(input);
  const { count } = await prisma.simulationScenario.updateMany({
    where: { id, guildId },
    data: {
      title: input.title.trim().slice(0, 120),
      description: (input.description ?? '').slice(0, 1000),
      difficulty: input.difficulty ?? 'MEDIUM',
      enabled: input.enabled ?? true,
      steps: input.steps as never,
    },
  });
  return count === 0 ? null : prisma.simulationScenario.findUnique({ where: { id } });
}

export async function deleteScenario(guildId: string, id: string): Promise<boolean> {
  const { count } = await prisma.simulationScenario.deleteMany({ where: { id, guildId } });
  return count > 0;
}

export async function listScenarios(guildId: string) {
  return prisma.simulationScenario.findMany({
    where: { guildId },
    orderBy: { updatedAt: 'desc' },
  });
}

// ============================================================================
// INJECTION DES INCIDENTS
// ============================================================================

const KIND_STYLE: Record<string, { emoji: string; label: string }> = {
  SPAM: { emoji: '📢', label: 'Spam' },
  INSULT: { emoji: '🤬', label: 'Insulte' },
  SUSPICIOUS_LINK: { emoji: '🔗', label: 'Lien suspect' },
  TICKET: { emoji: '🎫', label: 'Ticket' },
  HARMLESS: { emoji: '💬', label: 'Message anodin' },
};

/**
 * Boutons de réponse posés sous chaque incident.
 *
 * `customId` : `sim:<sessionId>:<stepIndex>:<action>[:<minutes>]`. Le choix
 * d'une exclusion propose directement ses durées, ce qui évite un modal
 * supplémentaire et garde le temps de réaction représentatif.
 */
export function buildActionRows(sessionId: string, stepIndex: number): ActionRowBuilder<ButtonBuilder>[] {
  const prefix = `sim:${sessionId}:${stepIndex}`;

  const primary = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${prefix}:IGNORE`).setLabel('Ignorer').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${prefix}:DELETE`).setLabel('Supprimer').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${prefix}:WARN`).setLabel('Avertir').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${prefix}:REPLY`).setLabel('Répondre').setStyle(ButtonStyle.Primary),
  );

  const mutes = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...MUTE_CHOICES.map((minutes) =>
      new ButtonBuilder()
        .setCustomId(`${prefix}:MUTE:${minutes}`)
        .setLabel(minutes >= 1440 ? `Mute ${minutes / 1440} j` : `Mute ${minutes} min`)
        .setStyle(ButtonStyle.Secondary)),
  );

  const severe = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${prefix}:KICK`).setLabel('Expulser').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${prefix}:BAN`).setLabel('Bannir').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${prefix}:ESCALATE`).setLabel('Escalader').setStyle(ButtonStyle.Secondary),
  );

  return [primary, mutes, severe];
}

async function getSimulationWebhook(channel: TextChannel, client: Client): Promise<Webhook | null> {
  try {
    const existing = await channel.fetchWebhooks();
    const found = existing.find((w) => w.owner?.id === client.user?.id && w.name === WEBHOOK_NAME);
    if (found) return found;

    return await channel.createWebhook({
      name: WEBHOOK_NAME,
      reason: 'Injection des incidents du simulateur de modération',
    });
  } catch (error) {
    logger.error('Simulation', `Webhook impossible dans ${channel.id}:`, error);
    return null;
  }
}

// ============================================================================
// SESSIONS
// ============================================================================

export class SimulationError extends UserFacingError {}

/** Une seule session à la fois par personne, pour ne pas mélanger les réponses. */
async function assertNoRunningSession(guildId: string, traineeId: string): Promise<void> {
  const running = await prisma.simulationSession.findFirst({
    where: { guildId, traineeId, status: 'RUNNING' },
  });
  if (running) {
    throw new SimulationError('Une session est déjà en cours. Terminez-la avant d\'en lancer une autre.');
  }
}

export async function startSession(
  client: Client,
  guild: Guild,
  scenarioId: string,
  trainee: { id: string; name: string },
  channelId: string,
): Promise<string> {
  const config = await getSimulationConfig(guild.id);
  if (!config.enabled) throw new SimulationError('Le simulateur est désactivé sur ce serveur.');

  // Garde-fou central : hors du bac à sable, aucune injection n'est possible.
  if (!config.testChannelId || config.testChannelId !== channelId) {
    throw new SimulationError('Les simulations ne peuvent démarrer que dans le salon de test configuré.');
  }

  const scenario = await prisma.simulationScenario.findFirst({
    where: { id: scenarioId, guildId: guild.id, enabled: true },
  });
  if (!scenario) throw new SimulationError('Scénario introuvable ou désactivé.');

  const steps = scenario.steps as unknown as ScenarioStep[];
  if (steps.length === 0) throw new SimulationError('Ce scénario ne contient aucune étape.');

  await assertNoRunningSession(guild.id, trainee.id);

  const session = await prisma.simulationSession.create({
    data: {
      guildId: guild.id,
      scenarioId,
      traineeId: trainee.id,
      traineeName: trainee.name,
      channelId,
      maxScore: steps.reduce((sum, step) => sum + Math.max(0, step.points), 0),
    },
  });

  // L'injection se poursuit en arrière-plan : la commande répond immédiatement.
  void runScenario(client, guild, session.id, steps).catch((error) => {
    logger.error('Simulation', `Échec du déroulé de la session ${session.id}:`, error);
  });

  return session.id;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Déroule le scénario : chaque incident est injecté après son délai, avec ses
 * boutons de réponse. La session se clôt d'elle-même à la fin de la liste.
 */
async function runScenario(client: Client, guild: Guild, sessionId: string, steps: ScenarioStep[]): Promise<void> {
  const session = await prisma.simulationSession.findUnique({ where: { id: sessionId } });
  if (!session) return;

  const channel = guild.channels.cache.get(session.channelId) as TextChannel | undefined;
  if (!channel) return;

  const webhook = await getSimulationWebhook(channel, client);
  if (!webhook) {
    await prisma.simulationSession.update({
      where: { id: sessionId },
      data: { status: 'ABANDONED', completedAt: new Date() },
    });
    await channel.send('❌ Impossible de créer le webhook nécessaire à la simulation.').catch(() => null);
    return;
  }

  await prisma.simulationSession.update({ where: { id: sessionId }, data: { webhookId: webhook.id } });

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];

    // Une session abandonnée entre deux incidents doit stopper l'injection.
    const current = await prisma.simulationSession.findUnique({
      where: { id: sessionId },
      select: { status: true },
    });
    if (current?.status !== 'RUNNING') return;

    await sleep(Math.max(0, Math.min(600, step.delaySeconds)) * 1000);

    const style = KIND_STYLE[step.kind] ?? KIND_STYLE.HARMLESS;
    try {
      const posted = await webhook.send({
        username: step.authorName.slice(0, 80),
        avatarURL: step.authorAvatarUrl || undefined,
        content: step.content.slice(0, 1900),
        components: buildActionRows(sessionId, index),
      });

      await prisma.simulationAnswer.create({
        data: {
          sessionId,
          stepIndex: index,
          stepId: step.id,
          stepKind: step.kind,
          expectedAction: step.expected.action,
          expectedMinutes: step.expected.muteMinutes ?? null,
          maxPoints: Math.max(0, step.points),
          postedAt: new Date(),
        },
      });

      await prisma.simulationSession.update({
        where: { id: sessionId },
        data: {
          currentStep: index,
          postedMessageIds: { push: posted.id },
        },
      });

      logger.debug('Simulation', `Incident ${style.label} injecté (session ${sessionId}, étape ${index}).`);
    } catch (error) {
      logger.error('Simulation', `Injection impossible à l'étape ${index}:`, error);
    }
  }

  // Laisse au modérateur le temps de traiter le dernier incident.
  const config = await getSimulationConfig(guild.id);
  await sleep(config.stepTimeoutSeconds * 1000);
  await completeSession(client, sessionId).catch(() => null);
}

/**
 * Enregistre la réponse du modérateur à un incident.
 *
 * Retourne `null` quand l'étape a déjà été traitée : Discord peut livrer deux
 * fois le même clic, et une double réponse fausserait le score.
 */
export async function recordAnswer(
  sessionId: string,
  stepIndex: number,
  traineeId: string,
  action: ModerationAction,
  muteMinutes?: number,
): Promise<{ reason: string; correct: boolean } | null> {
  const session = await prisma.simulationSession.findUnique({
    where: { id: sessionId },
    include: { scenario: true },
  });

  if (!session || session.status !== 'RUNNING') return null;
  if (session.traineeId !== traineeId) {
    throw new SimulationError('Cette session appartient à un autre modérateur.');
  }

  const answer = await prisma.simulationAnswer.findUnique({
    where: { sessionId_stepIndex: { sessionId, stepIndex } },
  });
  if (!answer || answer.answeredAt) return null;

  const steps = session.scenario.steps as unknown as ScenarioStep[];
  const step = steps[stepIndex];
  if (!step) return null;

  const responseMs = Date.now() - answer.postedAt.getTime();
  const submitted: StepAnswer = { action, muteMinutes, responseMs };
  const evaluation = evaluateStep(step, submitted);

  await prisma.simulationAnswer.update({
    where: { id: answer.id },
    data: {
      chosenAction: action,
      chosenMinutes: muteMinutes ?? null,
      correct: evaluation.correct,
      partiallyCorrect: evaluation.partiallyCorrect,
      points: evaluation.points,
      slow: evaluation.slow,
      reason: evaluation.reason,
      responseMs,
      answeredAt: new Date(),
    },
  });

  return { reason: evaluation.reason, correct: evaluation.correct };
}

/**
 * Clôt une session, calcule le rapport et le publie dans le salon de test.
 * Les étapes restées sans réponse sont comptées manquées.
 */
export async function completeSession(client: Client, sessionId: string, abandoned = false): Promise<void> {
  const session = await prisma.simulationSession.findUnique({
    where: { id: sessionId },
    include: { scenario: true, answers: { orderBy: { stepIndex: 'asc' } } },
  });
  if (!session || session.status !== 'RUNNING') return;

  const steps = session.scenario.steps as unknown as ScenarioStep[];
  const answers = steps.map((_, index) => {
    const stored = session.answers.find((a) => a.stepIndex === index);
    if (!stored?.answeredAt || !stored.chosenAction) return null;
    return {
      action: stored.chosenAction as ModerationAction,
      muteMinutes: stored.chosenMinutes ?? undefined,
      responseMs: stored.responseMs,
    };
  });

  const report = buildSessionReport(steps, answers);

  await prisma.simulationSession.update({
    where: { id: sessionId },
    data: {
      status: abandoned ? 'ABANDONED' : 'COMPLETED',
      currentStep: -1,
      completedAt: new Date(),
      score: report.totalPoints,
      maxScore: report.maxPoints,
      scorePercent: report.scorePercent,
      correctCount: report.correctCount,
      partialCount: report.partialCount,
      missedCount: report.missedCount,
      averageResponseMs: report.averageResponseMs,
      advice: report.advice,
    },
  });

  await postReport(client, session.guildId, session.channelId, session.traineeName, report);
  await cleanupSandbox(client, session.guildId, session.channelId, session.postedMessageIds);
}

function scoreColor(percent: number): number {
  if (percent >= 80) return 0x10b981;
  if (percent >= 50) return 0xf59e0b;
  return 0xef4444;
}

async function postReport(
  client: Client,
  guildId: string,
  channelId: string,
  traineeName: string,
  report: ReturnType<typeof buildSessionReport>,
): Promise<void> {
  const guild = client.guilds.cache.get(guildId);
  const channel = guild?.channels.cache.get(channelId) as TextChannel | undefined;
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setColor(scoreColor(report.scorePercent))
    .setTitle('🎓 Rapport de simulation')
    .setDescription(`Formation de **${traineeName}**`)
    .addFields(
      { name: 'Score', value: `**${report.scorePercent} %** (${report.totalPoints}/${report.maxPoints})`, inline: true },
      { name: 'Temps de réaction moyen', value: `${Math.round(report.averageResponseMs / 1000)} s`, inline: true },
      {
        name: 'Détail',
        value: `✅ ${report.correctCount} · 🟠 ${report.partialCount} · ❌ ${report.missedCount}`,
        inline: true,
      },
    );

  if (report.advice.length > 0) {
    embed.addFields({
      name: 'Conseils',
      value: report.advice.slice(0, 5).map((a) => `• ${a}`).join('\n').slice(0, 1024),
    });
  }

  await channel.send({ embeds: [embed] }).catch(() => null);
}

/** Efface les faux messages pour laisser le bac à sable propre. */
async function cleanupSandbox(
  client: Client,
  guildId: string,
  channelId: string,
  messageIds: string[],
): Promise<void> {
  if (messageIds.length === 0) return;

  const guild = client.guilds.cache.get(guildId);
  const channel = guild?.channels.cache.get(channelId) as TextChannel | undefined;
  if (!channel) return;

  for (const messageId of messageIds) {
    await channel.messages.delete(messageId).catch(() => null);
  }
}

export async function abandonSession(client: Client, guildId: string, traineeId: string): Promise<boolean> {
  const session = await prisma.simulationSession.findFirst({
    where: { guildId, traineeId, status: 'RUNNING' },
  });
  if (!session) return false;

  await completeSession(client, session.id, true);
  return true;
}

export async function listSessions(guildId: string, traineeId?: string, take = 25) {
  return prisma.simulationSession.findMany({
    where: { guildId, ...(traineeId ? { traineeId } : {}) },
    orderBy: { startedAt: 'desc' },
    take: Math.min(100, Math.max(1, take)),
    include: { scenario: { select: { title: true, difficulty: true } } },
  });
}

export async function getSessionDetail(guildId: string, sessionId: string) {
  return prisma.simulationSession.findFirst({
    where: { id: sessionId, guildId },
    include: {
      scenario: { select: { title: true, difficulty: true } },
      answers: { orderBy: { stepIndex: 'asc' } },
    },
  });
}
