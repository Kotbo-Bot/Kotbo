/**
 * Rappel de bump - détection automatique.
 *
 * Kotbo n'a rien à configurer pour savoir qu'un bump a eu lieu : il écoute les
 * réponses publiques des bots de bump connus déclenchées par la commande
 * `/bump`, et en tient l'état à jour tout seul (`BumpState`, une ligne par
 * serveur). Le reste (rappel envoyé au bon moment, badge Pulse, lecture par
 * l'IA) se branche sur cet état sans logique de détection dupliquée ailleurs.
 *
 * Reconnaissance à deux niveaux, volontairement redondants :
 *  - le nom d'utilisateur du bot (normalisé, insensible aux emoji/accents),
 *    pour savoir QUI a répondu ;
 *  - le nom de la commande d'interaction à l'origine du message
 *    (`message.interaction?.commandName === 'bump'`), pour savoir à QUOI il
 *    répond. Un bot de bump peut aussi poster d'autres messages (top serveurs,
 *    pub) qu'on ne veut surtout pas confondre avec un bump.
 *
 * Un bot de bump refuse en général un `/bump` prématuré par une réponse
 * éphémère (visible seulement par qui a tapé la commande) : ce message
 * n'atteint jamais la gateway comme un message de salon normal, donc ce
 * service ne le voit jamais. Une réponse publique qui coche les deux critères
 * ci-dessus est donc, en pratique, un bump réussi.
 *
 * Les cooldowns ci-dessous sont ceux documentés par chaque service au moment
 * de l'écriture ; seul celui de Disboard (2h) est stable de longue date. Si un
 * fournisseur change sa politique, corriger `cooldownMinutes` dans
 * `BUMP_PROVIDERS` suffit - aucune autre logique n'en dépend.
 */
import { MessageFlags, type Client, type Message, type TextChannel } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { richContainer } from '../../utils/embeds.js';

export interface BumpProvider {
  key: string;
  label: string;
  usernames: string[];
  cooldownMinutes: number;
}

export const BUMP_PROVIDERS: BumpProvider[] = [
  { key: 'disboard', label: 'Disboard', usernames: ['disboard', 'disboard org'], cooldownMinutes: 120 },
  { key: 'discadia', label: 'Discadia', usernames: ['discadia'], cooldownMinutes: 240 },
  { key: 'dsme', label: 'DiscordServers.com', usernames: ['discordservers', 'dsme', 'discordservers com'], cooldownMinutes: 360 },
  { key: 'disforge', label: 'Disforge', usernames: ['disforge'], cooldownMinutes: 240 },
  { key: 'discordl', label: 'DiscordL.org', usernames: ['dl', 'bot dl', 'discordl', 'discordl org'], cooldownMinutes: 120 },
];

function normalizeUsername(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const PROVIDER_BY_USERNAME = new Map<string, BumpProvider>();
for (const provider of BUMP_PROVIDERS) {
  for (const username of provider.usernames) {
    PROVIDER_BY_USERNAME.set(normalizeUsername(username), provider);
  }
}

function matchBumpProvider(username: string): BumpProvider | null {
  return PROVIDER_BY_USERNAME.get(normalizeUsername(username)) ?? null;
}

/**
 * Traite un message potentiel de bot de bump. Ne fait rien si le message ne
 * correspond pas aux deux critères de reconnaissance ; sinon, met à jour
 * `BumpState` pour ce serveur.
 */
export async function handlePotentialBumpMessage(message: Message): Promise<void> {
  if (!message.guildId || !message.author.bot) return;

  const provider = matchBumpProvider(message.author.username);
  if (!provider) return;

  // `interactionMetadata` (remplaçant plus récent de `Message#interaction`)
  // ne porte pas le nom de la commande : seul `interaction.commandName`
  // permet de confirmer qu'il s'agit bien d'un `/bump`. Absent, on préfère
  // ne rien détecter plutôt que de risquer un faux positif silencieux.
  if (message.interaction?.commandName !== 'bump') return;

  const bumperUserId = message.interaction.user.id;

  await recordBump({
    guildId: message.guildId,
    channelId: message.channelId,
    provider,
    bumperUserId,
  });
}

async function recordBump(params: {
  guildId: string;
  channelId: string;
  provider: BumpProvider;
  bumperUserId: string;
}): Promise<void> {
  const now = new Date();
  const candidateNextBumpAt = new Date(now.getTime() + params.provider.cooldownMinutes * 60_000);

  const existing = await prisma.bumpState.findUnique({ where: { guildId: params.guildId } });

  // Une réponse ambiguë d'un bot tiers ne fait jamais reculer l'échéance déjà
  // connue : au pire elle la retarde, jamais elle ne fait sonner le rappel
  // trop tôt.
  if (existing && existing.nextBumpAt.getTime() >= candidateNextBumpAt.getTime()) return;

  await prisma.bumpState.upsert({
    where: { guildId: params.guildId },
    create: {
      guildId: params.guildId,
      provider: params.provider.key,
      providerLabel: params.provider.label,
      lastBumpAt: now,
      lastBumpUserId: params.bumperUserId,
      lastChannelId: params.channelId,
      nextBumpAt: candidateNextBumpAt,
      reminded: false,
    },
    update: {
      provider: params.provider.key,
      providerLabel: params.provider.label,
      lastBumpAt: now,
      lastBumpUserId: params.bumperUserId,
      lastChannelId: params.channelId,
      nextBumpAt: candidateNextBumpAt,
      reminded: false,
    },
  });

  logger.info('BumpReminder', `Bump ${params.provider.label} détecté sur ${params.guildId}, prochain rappel ${candidateNextBumpAt.toISOString()}`);
}

/**
 * Envoie le rappel pour chaque serveur dont la fenêtre de bump est ouverte.
 * Appelé chaque minute par le cron `bump-reminder-tick`, sur le même modèle
 * que `processDueReminders` (rappels staff) : une ligne = un rappel, marquée
 * `reminded` même en cas d'échec d'envoi pour ne pas boucler dessus.
 */
export async function processDueBumpReminders(client: Client): Promise<void> {
  const due = await prisma.bumpState.findMany({
    where: { reminded: false, nextBumpAt: { lte: new Date() } },
  });
  if (due.length === 0) return;

  for (const state of due) {
    try {
      const channel = await client.channels.fetch(state.lastChannelId).catch(() => null);
      if (channel?.isTextBased()) {
        const container = richContainer({
          title: '📈 Rappel de bump',
          description:
            `Le serveur peut à nouveau être bump sur **${state.providerLabel}** !`
            + (state.lastBumpUserId ? `\nDernier bump par <@${state.lastBumpUserId}>.` : ''),
          footer: `Disponible depuis <t:${Math.floor(state.nextBumpAt.getTime() / 1000)}:R>`,
        });

        await (channel as TextChannel).send({
          components: [container],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { users: state.lastBumpUserId ? [state.lastBumpUserId] : [] },
        });
      }
    } catch (err) {
      logger.error('BumpReminder', `Échec d'envoi du rappel pour ${state.guildId} :`, err);
    } finally {
      await prisma.bumpState.update({ where: { guildId: state.guildId }, data: { reminded: true } });
    }
  }
}

export interface BumpStatus {
  provider: string;
  providerLabel: string;
  lastBumpAt: Date;
  lastBumpUserId: string | null;
  nextBumpAt: Date;
  /** Vrai si la fenêtre de bump est déjà ouverte. */
  overdue: boolean;
  overdueMinutes: number;
  reminderChannelId: string;
}

/** Lecture seule, utilisée par le badge Pulse et les outils MCP lus par l'IA. */
export async function getBumpStatus(guildId: string): Promise<BumpStatus | null> {
  const state = await prisma.bumpState.findUnique({ where: { guildId } });
  if (!state) return null;

  const now = Date.now();
  const overdueMs = now - state.nextBumpAt.getTime();

  return {
    provider: state.provider,
    providerLabel: state.providerLabel,
    lastBumpAt: state.lastBumpAt,
    lastBumpUserId: state.lastBumpUserId,
    nextBumpAt: state.nextBumpAt,
    overdue: overdueMs >= 0,
    overdueMinutes: overdueMs > 0 ? Math.floor(overdueMs / 60_000) : 0,
    reminderChannelId: state.lastChannelId,
  };
}
