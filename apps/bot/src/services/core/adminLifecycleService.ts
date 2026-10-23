/**
 * adminLifecycleService.ts
 *
 * Relances en message privé aux administrateurs, aux trois moments où elles
 * aident au lieu de déranger :
 *
 * - `onboarding_resume` : la configuration a été commencée puis laissée en plan
 *   (deux à quatorze jours après l'arrivée du bot). Le message dit que les
 *   réponses sont gardées et mène droit à la reprise.
 * - `next_step` : une semaine après la configuration, une étape utile reste à
 *   faire. Le message nomme l'étape et ce qu'elle apporte, avec le lien.
 * - `winback` : personne n'a ouvert le tableau de bord depuis trente jours.
 *   Pas de « tu nous manques » : le message montre ce que Kotbo a fait sur le
 *   serveur pendant ce temps. S'il n'a rien fait, rien ne part.
 *
 * Garde-fous : chaque relance part une seule fois par serveur, jamais deux à
 * moins d'une semaine d'écart, et le bouton « Ne plus recevoir ces rappels »
 * les coupe pour le serveur. Le destinataire est le payeur, à défaut le
 * propriétaire du serveur. Un message privé fermé n'est pas retenté.
 */
import { ButtonBuilder, ButtonStyle, type Client } from 'discord.js';
import { actionRow, v2Message } from '@arcscord/components';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { kotboContainer } from '../../utils/embeds.js';
import { resolveGuildLocale, type BotLocale } from '../../utils/i18n.js';
import { getCurrentInstance } from '../../utils/instanceContext.js';
import * as m from '../../lib/paraglide/messages.js';
import { computeSetupJourney } from './setupJourney.js';
import { getKotboWork } from '../analytics/analyticsReportService.js';
import { addDays, parseRange } from '../analytics/contentAnalyticsService.js';

export type LifecycleReminderKind = 'onboarding_resume' | 'next_step' | 'winback';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Écart minimal entre deux relances d'un même serveur. */
const MIN_GAP_MS = 7 * DAY_MS;
/** Serveurs examinés par passage : la tâche est quotidienne, le reste suivra. */
const BATCH = 200;

export const OPT_OUT_PREFIX = 'lifecycle:optout:';

type Candidate = {
  id: string;
  createdAt: Date;
  onboardingCompletedAt: Date | null;
  billingOwnerId: string | null;
  lifecycleRemindersSent: string[];
};

type Reminder = {
  kind: LifecycleReminderKind;
  title: string;
  body: string;
  cta: string;
  path: string;
};

function dashboardUrl(path: string, guildId: string): string | null {
  let origin = process.env.DASHBOARD_URL ?? '';
  try {
    origin = getCurrentInstance().dashboardOrigin;
  } catch {
    /* hors contexte d'instance : DASHBOARD_URL */
  }
  if (!origin) return null;
  return `${origin.replace(/\/$/, '')}${path}?guild=${guildId}`;
}

/** Dernier jour où quelqu'un a ouvert une page du tableau de bord de ce serveur. */
async function lastDashboardVisit(guildId: string): Promise<string | null> {
  const row = await prisma.dashboardTelemetryDailyStat.findFirst({
    where: { guildId, event: 'page_view' },
    orderBy: { dateKey: 'desc' },
    select: { dateKey: true },
  });
  return row?.dateKey ?? null;
}

/** La relance à envoyer pour ce serveur, ou null si aucune n'est de saison. */
export async function pickReminder(
  client: Client,
  guild: Candidate,
  guildName: string,
  locale: BotLocale,
  now = new Date(),
): Promise<Reminder | null> {
  const o = { locale };
  const sent = new Set(guild.lifecycleRemindersSent);
  const age = now.getTime() - guild.createdAt.getTime();

  if (!guild.onboardingCompletedAt) {
    if (!sent.has('onboarding_resume') && age >= 2 * DAY_MS && age <= 14 * DAY_MS) {
      return {
        kind: 'onboarding_resume',
        title: m.lcr_resume_title({ guild: guildName }, o),
        body: m.lcr_resume_body({ guild: guildName }, o),
        cta: m.lcr_resume_cta({}, o),
        path: '/onboarding',
      };
    }
    return null;
  }

  const sinceSetup = now.getTime() - guild.onboardingCompletedAt.getTime();
  if (!sent.has('next_step') && sinceSetup >= 7 * DAY_MS && sinceSetup <= 45 * DAY_MS) {
    const journey = await computeSetupJourney(guild.id);
    const step = journey?.steps.find((s) => !s.done && s.key !== 'timezone' && s.key !== 'installed');
    if (step) {
      return {
        kind: 'next_step',
        title: m.lcr_next_title({ guild: guildName }, o),
        body: m.lcr_next_body({ label: step.label, why: step.why }, o),
        cta: m.lcr_next_cta({}, o),
        path: step.href,
      };
    }
  }

  if (!sent.has('winback') && age >= 30 * DAY_MS) {
    const today = now.toISOString().slice(0, 10);
    const lastVisit = await lastDashboardVisit(guild.id);
    if (!lastVisit || lastVisit < addDays(today, -30)) {
      const range = parseRange(new URLSearchParams({ startDate: addDays(today, -30), endDate: addDays(today, -1) }));
      const work = await getKotboWork(client, guild.id, range);
      const n = new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-US');
      const lines = [
        work.spam > 0 ? m.anr_work_spam({ n: n.format(work.spam) }, o) : null,
        work.aegis > 0 ? m.anr_work_aegis({ n: n.format(work.aegis) }, o) : null,
        work.sanctions > 0 ? m.anr_work_sanctions({ n: n.format(work.sanctions) }, o) : null,
        work.tickets > 0 ? m.anr_work_tickets({ n: n.format(work.tickets) }, o) : null,
      ].filter((line) => line !== null);
      // Rien à montrer : pas de relance creuse.
      if (lines.length > 0) {
        return {
          kind: 'winback',
          title: m.lcr_winback_title({ guild: guildName }, o),
          body: `${m.lcr_winback_body({}, o)}\n${lines.map((line) => `• ${line}`).join('\n')}`,
          cta: m.lcr_winback_cta({}, o),
          path: '/',
        };
      }
    }
  }

  return null;
}

async function deliver(client: Client, userId: string, guildId: string, reminder: Reminder, locale: BotLocale): Promise<boolean> {
  const o = { locale };
  const url = dashboardUrl(reminder.path, guildId);
  const optOut = new ButtonBuilder()
    .setStyle(ButtonStyle.Secondary)
    .setLabel(m.lcr_optout({}, o))
    .setCustomId(`${OPT_OUT_PREFIX}${guildId}`);
  const row = url
    ? actionRow(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(reminder.cta).setURL(url), optOut)
    : actionRow(optOut);
  const message = v2Message(
    kotboContainer({
      color: 'primary',
      title: reminder.title,
      fields: [reminder.body, row],
      footerTitle: m.lcr_footer({}, o),
    }),
  );
  try {
    const user = await client.users.fetch(userId);
    await user.send(message);
    return true;
  } catch {
    return false;
  }
}

/**
 * Passage quotidien. Idempotent : `lifecycleRemindersSent` retient chaque
 * relance partie, et l'échec d'un message privé fermé compte comme un envoi -
 * le réessayer chaque jour reviendrait à frapper à une porte fermée.
 */
export async function runAdminLifecycleReminders(client: Client, now = new Date()): Promise<void> {
  const candidates = await prisma.guild.findMany({
    where: {
      lifecycleRemindersEnabled: true,
      id: { in: [...client.guilds.cache.keys()] },
      OR: [{ lastLifecycleReminderAt: null }, { lastLifecycleReminderAt: { lt: new Date(now.getTime() - MIN_GAP_MS) } }],
    },
    select: { id: true, createdAt: true, onboardingCompletedAt: true, billingOwnerId: true, lifecycleRemindersSent: true },
    take: BATCH,
  });

  let delivered = 0;
  for (const guild of candidates) {
    try {
      const discordGuild = client.guilds.cache.get(guild.id);
      if (!discordGuild) continue;
      const locale = await resolveGuildLocale(guild.id, discordGuild.preferredLocale);
      const reminder = await pickReminder(client, guild, discordGuild.name, locale, now);
      if (!reminder) continue;

      const recipient = guild.billingOwnerId ?? discordGuild.ownerId;
      const ok = await deliver(client, recipient, guild.id, reminder, locale);
      if (ok) delivered += 1;

      await prisma.guild.update({
        where: { id: guild.id },
        data: {
          lifecycleRemindersSent: { push: reminder.kind },
          lastLifecycleReminderAt: now,
        },
      });
    } catch (error) {
      logger.warn('LifecycleReminders', `Relance impossible pour ${guild.id}: ${String(error)}`);
    }
  }
  if (delivered > 0) logger.info('LifecycleReminders', `${delivered} relance(s) envoyée(s)`);
}

/** Le bouton du message : coupe les relances pour le serveur. */
export async function disableLifecycleReminders(guildId: string): Promise<void> {
  await prisma.guild.update({
    where: { id: guildId },
    data: { lifecycleRemindersEnabled: false },
  });
}
