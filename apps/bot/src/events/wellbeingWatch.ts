/**
 * Écoutes de la cellule bien-être hors du dashboard, toutes à activer par le
 * propriétaire dans les réglages de la cellule :
 *
 * - Signal aux modérateurs (`sanctionSignal`) : quand une personne qui a un
 *   dossier ouvert est sanctionnée, le modérateur est invité en privé à passer
 *   par la cellule, et le référent est prévenu. Aucun détail du dossier ne part.
 * - Mots de détresse (`distressWatch`) : un message qui en contient devient un
 *   signal à examiner (un lien, jamais le texte) ; la cellule décide d'ouvrir un
 *   dossier ou non. L'auteur reçoit en privé les ressources d'aide.
 */
import { Events, type Client, type Message } from 'discord.js';
import prisma from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { resolveGuildLocale } from '../utils/i18n.js';
import * as m from '../lib/paraglide/messages.js';
import { subscribeForModule } from '../services/core/moduleScope.js';
import { sendWellbeingAlert, sendWellbeingDirect } from '../services/staff/wellbeingAlerts.js';
import { appendCaseEvents } from '../services/staff/wellbeingEvents.js';
import {
  DISTRESS_COOLDOWN_MS,
  cleanResources,
  detectDistress,
  resourcesForLocale,
  resourcesMessage,
  sanctionModeratorText,
  shouldSignalDistress,
} from '../services/staff/wellbeingPolicy.js';

/** Dernier signal par serveur et par membre : un par jour au plus. */
const lastDistress = new Map<string, number>();

async function onSanctionApplied(client: Client, payload: { guildId: string; targetId: string; moderatorId: string; moderatorTag: string; type: string }) {
  const config = await prisma.wellbeingConfig.findUnique({ where: { guildId: payload.guildId } });
  if (!config?.enabled || !config.sanctionSignal) return;
  const cases = await prisma.wellbeingCase.findMany({
    where: { guildId: payload.guildId, subjectUserId: payload.targetId, deletedAt: null, status: { not: 'CLOSED' } },
    select: { id: true, assigneeId: true },
  });
  if (cases.length === 0) return;

  for (const item of cases) {
    await appendCaseEvents(item.id, [{ type: 'SANCTION', actorId: payload.moderatorId, actorName: payload.moderatorTag || payload.moderatorId, toValue: payload.type }]);
  }
  // Une sanction automatique (le bot lui-même) n'a personne à prévenir côté modération.
  if (payload.moderatorId && payload.moderatorId !== client.user?.id && payload.moderatorId !== payload.targetId) {
    void sendWellbeingDirect(client, [payload.moderatorId], sanctionModeratorText());
  }
  const referents = [...new Set(cases.map((item) => item.assigneeId).filter((id): id is string => !!id))];
  void sendWellbeingAlert(client, payload.guildId, config, 'SANCTION_SIGNAL', { actorId: payload.moderatorId }, referents);
}

async function onMessage(client: Client, message: Message) {
  if (!message.inGuild() || message.author.bot || !message.content) return;
  // Le repérage, une simple expression, passe avant toute lecture en base.
  if (!detectDistress(message.content)) return;
  const config = await prisma.wellbeingConfig.findUnique({ where: { guildId: message.guildId } });
  if (!config?.enabled || !config.distressWatch) return;

  const key = `${message.guildId}:${message.author.id}`;
  const now = Date.now();
  if (!shouldSignalDistress(lastDistress.get(key), now)) return;
  lastDistress.set(key, now);
  if (lastDistress.size > 1_000) {
    for (const [k, at] of lastDistress) if (now - at >= DISTRESS_COOLDOWN_MS) lastDistress.delete(k);
  }

  await prisma.wellbeingDistressSignal.create({
    data: { guildId: message.guildId, userId: message.author.id, channelId: message.channelId, messageId: message.id },
  });
  void sendWellbeingAlert(client, message.guildId, config, 'DISTRESS', { actorId: '' });

  const resources = resourcesForLocale(cleanResources(config.resources), message.guild.preferredLocale);
  if (resources.length > 0) {
    const locale = await resolveGuildLocale(message.guildId, message.guild.preferredLocale);
    await message.author
      .send({ content: `${m.wbc_distress_dm({}, { locale })}\n\n${resourcesMessage(message.guild.name, resources)}`, allowedMentions: { parse: [] } })
      .catch(() => null);
  }
}

/** `client` est limité au module bien-être (`scopeClientToModule`). */
export function registerWellbeingWatch(client: Client): void {
  subscribeForModule('wellbeing', 'sanction:applied', async (payload) => {
    await onSanctionApplied(client, payload).catch((error) => logger.error('Wellbeing', 'Signal de sanction en échec :', error));
  }, 'wellbeing-sanction-signal');

  client.on(Events.MessageCreate, (message) => {
    void onMessage(client, message).catch((error) => logger.error('Wellbeing', 'Repérage des mots de détresse en échec :', error));
  });
}
