/**
 * « Le pouls » : ce qui se passe sur le serveur en ce moment, montré au
 * visiteur avant qu'il entre. En ligne, en vocal, salons qui s'agitent,
 * rythme comparé à l'habitude de la même heure, prochain événement.
 *
 * Seuls des agrégats sortent d'ici, et seulement pour des salons que
 * `@everyone` voit sur Discord : un salon réservé au staff ne doit pas fuiter
 * par son nom ni par son activité. Les visages du vocal sont ceux que le bloc
 * Vocaux montrait déjà (salons publics, hors AFK).
 *
 * Sources : la fenêtre glissante de 30 minutes des Analytics en direct (en
 * mémoire, alimentée seulement si le serveur collecte ses analytics), les
 * statistiques horaires (UTC) pour la courbe et l'habitude, l'état vocal et
 * les compteurs de Discord.
 */

import { siteIconSvg } from '@kotbo/shared';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import * as m from '../../lib/paraglide/messages.js';
import { peekLiveSummary } from '../analytics/analyticsLiveService.js';
import { attrs, esc } from './siteHtml.js';
import { avatar, formatDateTime, formatNumber, type BlockContext, type SiteLocale } from './blocks/blockContext.js';
import { getGuildCounts } from './blocks/vitrineBlocks.js';
import { isPubliclyVisible } from './blocks/discordBlocks.js';
import { loadEvents } from './blocks/engagementBlocks.js';

export type PulseMoodLevel = 'quiet' | 'active' | 'calm' | 'usual' | 'busy' | 'peak';

export interface PulseMood {
  level: PulseMoodLevel;
  /** Rythme actuel rapporté à l'habitude de la même heure ; nul sans habitude connue. */
  ratio: number | null;
}

export interface PulseData {
  at: string;
  online: number;
  members: number;
  voice: { total: number; rooms: Array<{ id: string; name: string; count: number; faces: Array<{ name: string; avatar: string | null }> }> };
  /** Fenêtre des 30 dernières minutes ; nulle quand le serveur ne collecte pas ses analytics. */
  live: { messages: number; authors: number; perMinute: number } | null;
  hot: Array<{ id: string; name: string; messages: number }>;
  /** Messages par heure sur les 24 dernières heures, la plus ancienne d'abord (heure en cours comprise). */
  day: number[];
  joins24h: number;
  mood: PulseMood;
  next: { title: string; startsAt: string | null; live: boolean } | null;
}

/** Jours d'historique pour l'habitude d'une heure donnée. */
const BASELINE_DAYS = 14;
/** En dessous, l'habitude est trop maigre pour qu'une comparaison veuille dire quelque chose. */
const MIN_BASELINE = 4;
const PULSE_TTL_SECONDS = 15;
const HISTORY_TTL_SECONDS = 300;

/**
 * Humeur du serveur : le rythme de l'heure (messages des 30 dernières minutes
 * ramenés à l'heure) comparé à la moyenne de la même heure sur deux semaines.
 */
export function computePulseMood(hourlyRate: number, baseline: number | null): PulseMood {
  if (hourlyRate <= 0) return { level: 'quiet', ratio: null };
  if (baseline === null || baseline < MIN_BASELINE) return { level: 'active', ratio: null };
  const ratio = Math.round((hourlyRate / baseline) * 10) / 10;
  if (ratio < 0.6) return { level: 'calm', ratio };
  if (ratio < 1.4) return { level: 'usual', ratio };
  if (ratio < 2.2) return { level: 'busy', ratio };
  return { level: 'peak', ratio };
}

interface HourStat {
  dateKey: string;
  hour: number;
  messages: number;
  joins: number;
}

/** Clé `AAAA-MM-JJ:h` d'une heure UTC, celle des statistiques horaires. */
function hourKey(date: Date): string {
  return `${date.toISOString().slice(0, 10)}:${date.getUTCHours()}`;
}

/**
 * Courbe des 24 dernières heures, arrivées sur 24 h et habitude de l'heure en
 * cours (moyenne des mêmes heures UTC des jours précédents, jours muets compris).
 */
export function summarizeHourly(rows: HourStat[], now: Date): { day: number[]; joins24h: number; baseline: number | null } {
  const byKey = new Map(rows.map((r) => [`${r.dateKey}:${r.hour}`, r]));
  const day: number[] = [];
  let joins24h = 0;
  for (let i = 23; i >= 0; i -= 1) {
    const row = byKey.get(hourKey(new Date(now.getTime() - i * 3_600_000)));
    day.push(row?.messages ?? 0);
    joins24h += row?.joins ?? 0;
  }
  // Seuls les jours déjà couverts par l'historique comptent : un serveur
  // arrivé il y a trois jours n'a pas onze jours de silence derrière lui.
  const oldest = rows.reduce<string | null>((min, r) => (min === null || r.dateKey < min ? r.dateKey : min), null);
  const samples: number[] = [];
  for (let d = 1; d <= BASELINE_DAYS; d += 1) {
    const at = new Date(now.getTime() - d * 86_400_000);
    if (oldest === null || at.toISOString().slice(0, 10) < oldest) break;
    samples.push(byKey.get(hourKey(at))?.messages ?? 0);
  }
  const baseline = samples.length >= 3 ? samples.reduce((a, b) => a + b, 0) / samples.length : null;
  return { day, joins24h, baseline };
}

async function loadHourly(guildId: string, now: Date): Promise<HourStat[]> {
  return cache.wrap(`guild:${guildId}:site-pulse-hourly`, HISTORY_TTL_SECONDS, async () => {
    const since = new Date(now.getTime() - (BASELINE_DAYS + 1) * 86_400_000).toISOString().slice(0, 10);
    const rows = await prisma.guildHourlyStat.findMany({
      where: { guildId, dateKey: { gte: since } },
      select: { dateKey: true, hour: true, messagesCount: true, joinsCount: true },
    });
    return rows.map((r) => ({ dateKey: r.dateKey, hour: r.hour, messages: r.messagesCount, joins: r.joinsCount }));
  });
}

function voiceRooms(ctx: BlockContext): PulseData['voice'] {
  const guild = ctx.guild;
  if (!guild) return { total: 0, rooms: [] };
  const rooms = new Map<string, PulseData['voice']['rooms'][number]>();
  let total = 0;
  for (const state of guild.voiceStates.cache.values()) {
    const channel = state.channel;
    if (!channel || !state.member || state.member.user.bot) continue;
    if (channel.id === guild.afkChannelId || !isPubliclyVisible(guild, channel)) continue;
    total += 1;
    const room = rooms.get(channel.id) ?? { id: channel.id, name: channel.name, count: 0, faces: [] };
    room.count += 1;
    if (room.faces.length < 6) room.faces.push({ name: state.member.displayName, avatar: state.member.displayAvatarURL({ size: 64 }) });
    rooms.set(channel.id, room);
  }
  return { total, rooms: [...rooms.values()].sort((a, b) => b.count - a.count).slice(0, 3) };
}

/** Instantané du pouls d'un site, mis en cache quelques secondes. */
export async function getSitePulse(ctx: BlockContext): Promise<PulseData> {
  return cache.wrap(`guild:${ctx.site.guildId}:site-pulse`, PULSE_TTL_SECONDS, async () => {
    const now = new Date();
    const guild = ctx.guild;
    const [counts, hourly, events] = await Promise.all([
      guild ? getGuildCounts(ctx).catch(() => null) : Promise.resolve(null),
      loadHourly(ctx.site.guildId, now).catch(() => [] as HourStat[]),
      ctx.moduleStates.events === false ? Promise.resolve([]) : loadEvents(ctx, 6).catch(() => []),
    ]);
    const summary = peekLiveSummary(ctx.site.guildId, now.getTime());
    const { day, joins24h, baseline } = summarizeHourly(hourly, now);

    const hot = summary && guild
      ? summary.channels
          .map(([id, messages]) => ({ id, messages, channel: guild.channels.cache.get(id) }))
          .filter((c) => c.channel && isPubliclyVisible(guild, c.channel, true))
          .slice(0, 3)
          .map((c) => ({ id: c.id, name: c.channel!.name, messages: c.messages }))
      : [];

    // Sans fenêtre en direct, l'heure en cours des statistiques horaires prend le relais.
    const hourlyRate = summary ? summary.messages * 2 : (day[day.length - 1] ?? 0);
    const upcoming = events.find((e) => e.live || (e.startsAt && e.startsAt.getTime() > now.getTime()));

    return {
      at: now.toISOString(),
      online: counts?.online ?? 0,
      members: counts?.members ?? 0,
      voice: voiceRooms(ctx),
      live: summary ? { messages: summary.messages, authors: summary.authors, perMinute: summary.perMinute } : null,
      hot,
      day,
      joins24h,
      mood: computePulseMood(hourlyRate, baseline),
      next: upcoming ? { title: upcoming.title, startsAt: upcoming.startsAt?.toISOString() ?? null, live: upcoming.live } : null,
    };
  });
}

// ─── Rendu ──────────────────────────────────────────────────────────────────

function moodText(mood: PulseMood, locale: SiteLocale): string {
  const o = { locale };
  switch (mood.level) {
    case 'quiet':
      return m.site_pulse_mood_quiet({}, o);
    case 'active':
      return m.site_pulse_mood_active({}, o);
    case 'calm':
      return m.site_pulse_mood_calm({}, o);
    case 'usual':
      return m.site_pulse_mood_usual({}, o);
    case 'busy':
      return m.site_pulse_mood_busy({}, o);
    case 'peak':
      return m.site_pulse_mood_peak({ ratio: formatNumber(mood.ratio ?? 2, locale) }, o);
  }
}

/** Barres des 24 dernières heures, en SVG, sans script. */
export function renderDayChart(day: number[], locale: SiteLocale): string {
  const peak = Math.max(...day, 0);
  if (peak === 0) return '';
  const w = 8;
  const gap = 3;
  const h = 44;
  const bars = day
    .map((value, i) => {
      const height = value === 0 ? 1 : Math.max(2, Math.round((value / peak) * h));
      const current = i === day.length - 1;
      return `<rect${attrs({ x: i * (w + gap), y: h - height, width: w, height, rx: 2, class: current ? 'pulse-bar pulse-bar-now' : 'pulse-bar' })}/>`;
    })
    .join('');
  const label = m.site_pulse_chart_label({ peak: formatNumber(peak, locale) }, { locale });
  const width = day.length * (w + gap) - gap;
  return `<figure class="pulse-chart"><svg${attrs({ viewBox: `0 0 ${width} ${h}`, width, height: h, role: 'img', 'aria-label': label, preserveAspectRatio: 'none' })}>${bars}</svg><figcaption>${esc(m.site_pulse_chart({}, { locale }))}</figcaption></figure>`;
}

function stat(value: number, label: string, locale: SiteLocale, prefix = ''): string {
  return `<div class="pulse-stat"><dt>${esc(label)}</dt><dd${attrs({ 'data-count': value, 'data-prefix': prefix || null })}>${esc(prefix)}${esc(formatNumber(value, locale))}</dd></div>`;
}

/** Corps du pouls ; le script du site le relit toutes les quinze secondes. */
export function renderPulseInner(pulse: PulseData, locale: SiteLocale): string {
  const o = { locale };
  const stats = [
    stat(pulse.online, m.site_pulse_online({}, o), locale),
    stat(pulse.voice.total, m.site_pulse_voice({}, o), locale),
    pulse.live ? stat(pulse.live.messages, m.site_pulse_messages({}, o), locale) : '',
    pulse.joins24h > 0 ? stat(pulse.joins24h, m.site_pulse_joins({}, o), locale, '+') : '',
  ].join('');

  const hot = pulse.hot.length
    ? `<div class="pulse-block"><p class="pulse-label">${esc(m.site_pulse_hot({}, o))}</p><ul class="pulse-hot">${pulse.hot
        .map((c) => `<li><span class="pulse-channel">#${esc(c.name)}</span><span class="pulse-muted">${esc(m.site_pulse_hot_count({ count: formatNumber(c.messages, locale) }, o))}</span></li>`)
        .join('')}</ul></div>`
    : '';

  const voice = pulse.voice.rooms.length
    ? `<div class="pulse-block"><p class="pulse-label">${esc(m.site_pulse_voice_rooms({}, o))}</p><ul class="pulse-rooms">${pulse.voice.rooms
        .map(
          (r) =>
            `<li><span class="pulse-faces">${r.faces.map((f) => avatar(f.avatar, f.name, 'sm')).join('')}</span><span class="pulse-room">${siteIconSvg('volume', 16)} ${esc(r.name)}</span><span class="pulse-muted">${esc(formatNumber(r.count, locale))}</span></li>`,
        )
        .join('')}</ul></div>`
    : '';

  let next = '';
  if (pulse.next) {
    const when = pulse.next.live
      ? `<span class="pill pill-live">${esc(m.site_pulse_next_live({}, o))}</span>`
      : pulse.next.startsAt
        ? `<time${attrs({ datetime: pulse.next.startsAt, 'data-countdown': pulse.next.startsAt })}>${esc(formatDateTime(pulse.next.startsAt, locale))}</time>`
        : '';
    next = `<p class="pulse-next">${siteIconSvg('calendar', 16)}<span class="pulse-label">${esc(m.site_pulse_next({}, o))}</span><strong>${esc(pulse.next.title)}</strong>${when}</p>`;
  }

  return `<p${attrs({ class: `pulse-mood pulse-mood-${pulse.mood.level}` })}><span class="pulse-dot" aria-hidden="true"></span><span class="pulse-live">${esc(m.site_pulse_live({}, o))}</span><span>${esc(moodText(pulse.mood, locale))}</span></p>
<dl class="pulse-stats">${stats}</dl>
${renderDayChart(pulse.day, locale)}
${hot || voice ? `<div class="pulse-blocks">${hot}${voice}</div>` : ''}
${next}`;
}

/** Le pouls complet, prêt à poser dans la bannière d'accueil ou dans un bloc. */
export async function renderPulse(ctx: BlockContext): Promise<string> {
  if (!ctx.guild) return '';
  const pulse = await getSitePulse(ctx);
  return `<div class="pulse" data-pulse aria-live="off">${renderPulseInner(pulse, ctx.locale)}</div>`;
}
