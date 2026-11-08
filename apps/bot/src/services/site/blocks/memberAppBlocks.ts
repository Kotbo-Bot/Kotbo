/**
 * Espace membre en apps, façon logiciel de gestion :
 *
 *   /me                    grille d'apps (compteurs : tickets ouverts, candidatures en attente…)
 *   /me/<app>              barre des apps, puis la liste de l'app : recherche, filtres,
 *                          vue liste ou kanban (bascule sans rechargement, par le script)
 *   /me/<app>/<id>         fiche : barre d'étapes, champs, et le fil (messages et activité)
 *
 * Un seul bloc (`memberApp`, configuré par `{ app, id }`) rend toutes ces vues ;
 * les apps Progression, Événements et Réglages ajoutent sous sa barre les blocs
 * existants (quêtes, récompenses, giveaways…). Tout est rendu pour le visiteur
 * connecté, et chaque fiche vérifie qu'elle lui appartient.
 */

import { siteIconSvg, type SiteIconName, type SiteMemberApp } from '@kotbo/shared';
import prisma from '../../../utils/db.js';
import * as m from '../../../lib/paraglide/messages.js';
import { parseDiscordMarkdown } from '../../../api/shared/markdown.js';
import { attrs, cls, esc } from '../siteHtml.js';
import { isTicketActive, listSiteTicketTypes, readTicketThread, type SiteTicketMessage } from '../siteTicketService.js';
import { ticketNewForm } from './demarchesBlocks.js';
import { emptyState, formatDateTime, formatNumber, timeTag, type BlockContext, type BlockRef, type BlockRegistry, type SiteLocale } from './blockContext.js';
import { viewerGate } from './memberBlocks.js';

// ─── Apps ───────────────────────────────────────────────────────────────────

/** Segment d'URL de chaque app, sous /me. */
export const MEMBER_APP_SLUGS: Record<Exclude<SiteMemberApp, 'home'>, string> = {
  tickets: 'tickets',
  applications: 'candidatures',
  progress: 'progression',
  events: 'evenements',
  settings: 'reglages',
};

const APP_ICONS: Record<Exclude<SiteMemberApp, 'home'>, SiteIconName> = {
  tickets: 'ticket',
  applications: 'clipboard',
  progress: 'trophy',
  events: 'calendar',
  settings: 'user',
};

/** Teinte de chaque tuile : les apps se reconnaissent à la couleur, comme dans un lanceur. */
const APP_TINTS: Record<Exclude<SiteMemberApp, 'home'>, string> = {
  tickets: '#2563eb',
  applications: '#7c3aed',
  progress: '#d97706',
  events: '#db2777',
  settings: '#475569',
};

type App = Exclude<SiteMemberApp, 'home'>;

function appLabel(app: App, locale: SiteLocale): string {
  const o = { locale };
  return {
    tickets: () => m.site_app_tickets({}, o),
    applications: () => m.site_app_applications({}, o),
    progress: () => m.site_app_progress({}, o),
    events: () => m.site_app_events({}, o),
    settings: () => m.site_app_settings({}, o),
  }[app]();
}

function appDescription(app: App, locale: SiteLocale): string {
  const o = { locale };
  return {
    tickets: () => m.site_app_tickets_desc({}, o),
    applications: () => m.site_app_applications_desc({}, o),
    progress: () => m.site_app_progress_desc({}, o),
    events: () => m.site_app_events_desc({}, o),
    settings: () => m.site_app_settings_desc({}, o),
  }[app]();
}

/** Apps ouvertes sur ce serveur : une app dont les modules sont éteints disparaît. */
export function availableApps(states: Record<string, boolean>): App[] {
  const on = (key: string) => states[key] !== false;
  const apps: App[] = [];
  if (on('tickets')) apps.push('tickets');
  if (on('recruitment') || on('custom_forms')) apps.push('applications');
  apps.push('progress');
  if (on('events') || on('giveaways')) apps.push('events');
  apps.push('settings');
  return apps;
}

const appUrl = (ctx: BlockContext, app: App, id?: string) => `${ctx.basePath}/me/${MEMBER_APP_SLUGS[app]}${id ? `/${id}` : ''}`;

// ─── Données ────────────────────────────────────────────────────────────────

type Tone = 'ok' | 'warn' | 'bad' | 'muted' | 'info';

interface Row {
  id: string;
  href: string | null;
  title: string;
  meta: string;
  status: string;
  tone: Tone;
  date: Date;
  /** Colonne du kanban. */
  group: string;
  /** Filtres auxquels la ligne répond. */
  filters: string[];
}

const TICKET_GROUP: Record<string, string> = { PENDING: 'waiting', QUEUED: 'waiting', OPEN: 'open', CLAIMED: 'open' };

async function ticketRows(ctx: BlockContext, userId: string): Promise<Row[]> {
  const o = { locale: ctx.locale };
  const tickets = await prisma.ticket.findMany({
    where: { guildId: ctx.site.guildId, userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, reason: true, status: true, createdAt: true, ticketTypeLabel: true, updatedAt: true },
  });
  return tickets.map((t) => {
    const active = isTicketActive(t.status);
    const group = TICKET_GROUP[t.status] ?? 'closed';
    return {
      id: t.id,
      href: appUrl(ctx, 'tickets', t.id),
      title: t.reason,
      meta: t.ticketTypeLabel ?? '',
      status: group === 'waiting' ? m.site_app_status_waiting({}, o) : active ? m.site_ticket_status_open({}, o) : m.site_ticket_status_closed({}, o),
      tone: group === 'waiting' ? 'warn' : active ? 'ok' : 'muted',
      date: t.updatedAt,
      group,
      filters: [active ? 'open' : 'closed'],
    };
  });
}

const CANDIDATURE_TONE: Record<string, Tone> = { PENDING: 'warn', ORAL: 'info', APPROVED: 'ok', REJECTED: 'bad', AUTO_REJECTED: 'bad' };

async function applicationRows(ctx: BlockContext, userId: string): Promise<Row[]> {
  const o = { locale: ctx.locale };
  const [candidatures, submissions] = await Promise.all([
    prisma.recruitmentCandidature.findMany({ where: { guildId: ctx.site.guildId, discordId: userId }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, status: true, createdAt: true, updatedAt: true } }),
    prisma.customFormSubmission.findMany({ where: { guildId: ctx.site.guildId, userId }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, createdAt: true, form: { select: { name: true } } } }),
  ]);
  const STATUS: Record<string, () => string> = {
    PENDING: () => m.site_applications_pending({}, o),
    ORAL: () => m.site_applications_oral({}, o),
    APPROVED: () => m.site_applications_approved({}, o),
    REJECTED: () => m.site_applications_rejected({}, o),
    AUTO_REJECTED: () => m.site_applications_rejected({}, o),
  };
  return [
    ...candidatures.map((c): Row => {
      const decided = ['APPROVED', 'REJECTED', 'AUTO_REJECTED'].includes(c.status);
      return {
        id: c.id,
        href: appUrl(ctx, 'applications', c.id),
        title: m.site_applications_candidature({}, o),
        meta: '',
        status: (STATUS[c.status] ?? STATUS.PENDING)(),
        tone: CANDIDATURE_TONE[c.status] ?? 'warn',
        date: c.updatedAt,
        group: c.status === 'AUTO_REJECTED' ? 'REJECTED' : c.status,
        filters: [decided ? 'decided' : 'pending'],
      };
    }),
    ...submissions.map((s): Row => ({
      id: s.id,
      href: appUrl(ctx, 'applications', s.id),
      title: s.form.name,
      meta: m.site_app_kind_form({}, o),
      status: m.site_applications_sent({}, o),
      tone: 'muted',
      date: s.createdAt,
      group: 'SENT',
      filters: ['decided'],
    })),
  ].sort((a, b) => b.date.getTime() - a.date.getTime());
}

async function eventRows(ctx: BlockContext, userId: string): Promise<Row[]> {
  const o = { locale: ctx.locale };
  const guildId = ctx.site.guildId;
  const [registrations, participations, giveaways] = await Promise.all([
    prisma.customEventRegistration.findMany({ where: { guildId, userId }, orderBy: { createdAt: 'desc' }, take: 30, select: { id: true, createdAt: true, event: { select: { title: true, status: true } } } }),
    prisma.eventParticipant.findMany({ where: { guildId, userId }, orderBy: { createdAt: 'desc' }, take: 30, select: { id: true, score: true, createdAt: true, event: { select: { title: true, status: true } } } }),
    prisma.giveaway.findMany({ where: { guildId, participants: { has: userId } }, orderBy: { endsAt: 'desc' }, take: 30, select: { id: true, prize: true, endsAt: true, ended: true, winners: true } }),
  ]);
  const eventDone = (status: string) => status === 'COMPLETED' || status === 'CANCELLED';
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const r of [...registrations.map((x) => ({ ...x, score: null as number | null })), ...participations]) {
    if (seen.has(r.event.title + r.createdAt.toISOString())) continue;
    seen.add(r.event.title + r.createdAt.toISOString());
    const done = eventDone(r.event.status);
    rows.push({
      id: r.id,
      href: null,
      title: r.event.title,
      meta: m.site_app_kind_event({}, o),
      status: r.score !== null && r.score > 0 ? m.site_app_event_score({ score: formatNumber(r.score, ctx.locale) }, o) : done ? m.site_app_event_done({}, o) : m.site_app_event_registered({}, o),
      tone: done ? 'muted' : 'ok',
      date: r.createdAt,
      group: done ? 'done' : 'upcoming',
      filters: [done ? 'done' : 'upcoming'],
    });
  }
  for (const g of giveaways) {
    const won = g.winners.includes(userId);
    rows.push({
      id: g.id,
      href: null,
      title: g.prize,
      meta: m.site_app_kind_giveaway({}, o),
      status: won ? m.site_app_giveaway_won({}, o) : g.ended ? m.site_app_giveaway_ended({}, o) : m.site_app_giveaway_joined({}, o),
      tone: won ? 'ok' : g.ended ? 'muted' : 'info',
      date: g.endsAt,
      group: won ? 'won' : g.ended ? 'done' : 'upcoming',
      filters: [won ? 'won' : g.ended ? 'done' : 'upcoming', ...(won ? ['done'] : [])],
    });
  }
  return rows.sort((a, b) => b.date.getTime() - a.date.getTime());
}

// ─── Vues ───────────────────────────────────────────────────────────────────

const pill = (label: string, tone: Tone) => `<span class="${cls('pill', `pill-${tone}`)}">${esc(label)}</span>`;

/** Barre des apps (en haut de chaque app) et fil d'Ariane. */
function appBar(ctx: BlockContext, current: App | null): string {
  const o = { locale: ctx.locale };
  const tabs = availableApps(ctx.moduleStates)
    .map(
      (app) =>
        `<a${attrs({ class: cls('app-tab', app === current && 'is-current'), href: appUrl(ctx, app), 'aria-current': app === current ? 'page' : null, style: `--app:${APP_TINTS[app]}` })}>${siteIconSvg(APP_ICONS[app], 16)}<span>${esc(appLabel(app, ctx.locale))}</span></a>`,
    )
    .join('');
  return `<nav class="app-bar"${attrs({ 'aria-label': m.site_my_space({}, o) })}><a class="app-tab app-home"${attrs({ href: `${ctx.basePath}/me`, title: m.site_my_space({}, o) })}>${siteIconSvg('app-grid', 16)}<span class="sr-only">${esc(m.site_my_space({}, o))}</span></a>${tabs}</nav>`;
}

function listView(ctx: BlockContext, rows: Row[], opts: { filters: Array<[string, string]>; columns: Array<[string, string]>; empty: string; action?: string }): string {
  const o = { locale: ctx.locale };
  const filterButtons = [['all', m.site_app_filter_all({}, o)] as [string, string], ...opts.filters]
    .map(([key, label], i) => `<button type="button" class="o-pill"${attrs({ 'data-app-filter': key, 'aria-pressed': i === 0 ? 'true' : 'false' })}>${esc(label)}</button>`)
    .join('');
  const line = (row: Row, tag: 'list' | 'card') => {
    const inner =
      tag === 'list'
        ? `<span class="o-row-main"><strong>${esc(row.title)}</strong>${row.meta ? `<span class="card-meta">${esc(row.meta)}</span>` : ''}</span>${pill(row.status, row.tone)}<span class="o-row-date">${timeTag(row.date, ctx.locale, 'medium')}</span>`
        : `<strong>${esc(row.title)}</strong>${row.meta ? `<span class="card-meta">${esc(row.meta)}</span>` : ''}<span class="o-card-foot">${pill(row.status, row.tone)}${timeTag(row.date, ctx.locale, 'short')}</span>`;
    const common = { 'data-row': '', 'data-filters': `all ${row.filters.join(' ')}`, 'data-text': `${row.title} ${row.meta} ${row.status}`.toLowerCase() };
    const className = tag === 'list' ? 'o-row' : 'o-card';
    return row.href ? `<a${attrs({ class: className, href: row.href, ...common })}>${inner}</a>` : `<div${attrs({ class: className, ...common })}>${inner}</div>`;
  };
  const body =
    rows.length === 0
      ? emptyState(opts.empty)
      : `<div class="o-list">${rows.map((r) => line(r, 'list')).join('')}</div>
<div class="o-kanban">${opts.columns
          .map(([key, label]) => {
            const cards = rows.filter((r) => r.group === key);
            return `<section class="o-col"><h3>${esc(label)} <span class="o-col-count">${cards.length}</span></h3>${cards.map((r) => line(r, 'card')).join('')}</section>`;
          })
          .join('')}</div>
<p class="empty" data-app-none hidden>${esc(m.site_app_no_match({}, o))}</p>`;
  return `<div class="oapp" data-app-list data-view="list">
  <div class="o-toolbar">
    <label class="o-search">${siteIconSvg('search', 16)}<input type="search" data-app-q${attrs({ placeholder: m.site_app_search({}, o), 'aria-label': m.site_app_search({}, o) })}></label>
    <div class="o-pills" role="group"${attrs({ 'aria-label': m.site_app_filters({}, o) })}>${filterButtons}</div>
    <div class="o-views" role="group"${attrs({ 'aria-label': m.site_app_view({}, o) })}>
      <button type="button" data-app-view="list" aria-pressed="true"${attrs({ title: m.site_app_view_list({}, o), 'aria-label': m.site_app_view_list({}, o) })}>${siteIconSvg('list', 16)}</button>
      <button type="button" data-app-view="kanban" aria-pressed="false"${attrs({ title: m.site_app_view_kanban({}, o), 'aria-label': m.site_app_view_kanban({}, o) })}>${siteIconSvg('columns3', 16)}</button>
    </div>
    ${opts.action ?? ''}
  </div>
  <p class="o-count card-meta" data-app-count aria-live="polite">${esc(m.site_app_count({ count: rows.length }, o))}</p>
  ${body}
</div>`;
}

/** Barre d'étapes d'une fiche : où en est la demande. */
function steps(labels: string[], current: number): string {
  return `<ol class="o-steps">${labels.map((label, i) => `<li${attrs({ class: cls(i < current && 'is-done', i === current && 'is-current'), 'aria-current': i === current ? 'step' : null })}>${esc(label)}</li>`).join('')}</ol>`;
}

interface ChatterItem {
  at: Date;
  html: string;
}

function chatter(ctx: BlockContext, items: ChatterItem[], composer: string): string {
  const o = { locale: ctx.locale };
  const sorted = [...items].sort((a, b) => b.at.getTime() - a.at.getTime());
  return `<aside class="o-chatter"${attrs({ 'aria-label': m.site_app_chatter({}, o) })}>
  <h3>${esc(m.site_app_chatter({}, o))}</h3>
  ${composer}
  <ol class="o-feed">${sorted.map((item) => `<li>${item.html}</li>`).join('') || `<li class="empty">${esc(m.site_ticket_empty_thread({}, o))}</li>`}</ol>
</aside>`;
}

const activity = (text: string, at: Date, locale: SiteLocale): ChatterItem => ({
  at,
  html: `<p class="o-activity">${siteIconSvg('activity', 14)}<span>${esc(text)}</span>${timeTag(at, locale, 'medium')}</p>`,
});

function messageItem(ctx: BlockContext, msg: SiteTicketMessage): ChatterItem {
  const o = { locale: ctx.locale };
  return {
    at: new Date(msg.createdAt),
    html: `<div class="${cls('o-msg', msg.mine && 'is-mine')}">
  <p class="o-msg-head"><strong>${esc(msg.mine ? m.site_comment_author_you({}, o) : msg.authorName)}</strong>${msg.mine ? '' : ` <span class="tag">${esc(m.site_ticket_staff({}, o))}</span>`} <span class="card-meta">${esc(formatDateTime(msg.createdAt, ctx.locale))}</span></p>
  <div class="rich">${parseDiscordMarkdown(msg.content, ctx.guild)}</div>
</div>`,
  };
}

function replyForm(attr: string, id: string, locale: SiteLocale): string {
  const o = { locale };
  return `<form class="site-form o-composer"${attrs({ [attr]: id })} novalidate>
  <label class="sr-only"${attrs({ for: `reply-${id}` })}>${esc(m.site_ticket_reply({}, o))}</label>
  <textarea${attrs({ id: `reply-${id}` })} name="content" rows="3" maxlength="3800" required${attrs({ placeholder: m.site_app_reply_placeholder({}, o) })}></textarea>
  <p class="form-status" role="status" aria-live="polite"></p>
  <div class="form-actions"><button type="submit" class="btn btn-primary btn-sm">${esc(m.site_ticket_reply({}, o))}</button></div>
</form>`;
}

function sheet(ctx: BlockContext, app: App, title: string, status: string, tone: Tone, stepBar: string, fields: Array<[string, string]>, side: string): string {
  const o = { locale: ctx.locale };
  return `<div class="oapp-form">
  <a class="o-back"${attrs({ href: appUrl(ctx, app) })}>${siteIconSvg('chevron-up', 14)}${esc(m.site_app_back({ app: appLabel(app, ctx.locale) }, o))}</a>
  <div class="oapp-form-body">
    <article class="o-sheet">
      <header class="o-sheet-head"><h2>${esc(title)}</h2>${pill(status, tone)}</header>
      ${stepBar}
      <dl class="o-fields">${fields.filter(([, v]) => v).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>
    </article>
    ${side}
  </div>
</div>`;
}

// ─── Fiches ─────────────────────────────────────────────────────────────────

async function ticketSheet(ctx: BlockContext, userId: string, id: string): Promise<string> {
  const o = { locale: ctx.locale };
  const ticket = await prisma.ticket.findFirst({
    where: { id, guildId: ctx.site.guildId, userId },
    select: { id: true, reason: true, description: true, status: true, createdAt: true, channelId: true, threadId: true, ticketTypeLabel: true, claimedByName: true, closedByName: true, closedAt: true, firstResponseAt: true, updatedAt: true },
  });
  if (!ticket) return emptyState(m.site_app_missing({}, o));
  const active = isTicketActive(ticket.status);
  const stepIndex = { PENDING: 0, QUEUED: 0, OPEN: 1, CLAIMED: 2 }[ticket.status as string] ?? 3;
  const items: ChatterItem[] = [activity(m.site_app_activity_ticket_opened({}, o), ticket.createdAt, ctx.locale)];
  if (ticket.firstResponseAt) items.push(activity(m.site_app_activity_first_response({}, o), ticket.firstResponseAt, ctx.locale));
  if (ticket.closedAt) items.push(activity(ticket.closedByName ? m.site_app_activity_closed_by({ name: ticket.closedByName }, o) : m.site_app_activity_closed({}, o), ticket.closedAt, ctx.locale));
  let composer = '';
  if (ticket.status === 'PENDING' || ticket.status === 'QUEUED') {
    composer = `<p class="empty">${esc(ticket.status === 'PENDING' ? m.site_ticket_pending_review({}, o) : m.site_ticket_queued({}, o))}</p>`;
  } else {
    const messages = await readTicketThread(ctx.client, ctx.site.guildId, { ...ticket, userId });
    if (messages === null) composer = `<p class="empty">${esc(m.site_ticket_offsite({}, o))}</p>`;
    else {
      for (const msg of messages) items.push(messageItem(ctx, msg));
      if (active) composer = replyForm('data-ticket-reply', ticket.id, ctx.locale);
    }
  }
  return sheet(
    ctx,
    'tickets',
    ticket.reason,
    active ? m.site_ticket_status_open({}, o) : m.site_ticket_status_closed({}, o),
    active ? 'ok' : 'muted',
    steps([m.site_app_step_requested({}, o), m.site_app_step_open({}, o), m.site_app_step_handled({}, o), m.site_app_step_closed({}, o)], stepIndex),
    [
      [m.site_app_field_type({}, o), esc(ticket.ticketTypeLabel ?? '')],
      [m.site_app_field_opened({}, o), timeTag(ticket.createdAt, ctx.locale, 'long')],
      [m.site_app_field_handled_by({}, o), esc(ticket.claimedByName ?? '')],
      [m.site_app_field_closed({}, o), ticket.closedAt ? timeTag(ticket.closedAt, ctx.locale, 'long') : ''],
      [m.site_app_field_description({}, o), ticket.description ? `<div class="rich">${parseDiscordMarkdown(ticket.description, ctx.guild)}</div>` : ''],
    ],
    chatter(ctx, items, composer),
  );
}

/** Réponses d'un formulaire, lues sans rien supposer de leur forme. */
function answers(data: unknown): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const push = (label: unknown, value: unknown) => {
    const text = Array.isArray(value) ? value.map(String).join(', ') : value === null || value === undefined ? '' : typeof value === 'object' ? '' : String(value);
    if (typeof label === 'string' && label && text) out.push([label.slice(0, 120), text.slice(0, 2000)]);
  };
  if (Array.isArray(data)) {
    for (const item of data) if (item && typeof item === 'object') push((item as Record<string, unknown>).label ?? (item as Record<string, unknown>).question, (item as Record<string, unknown>).value ?? (item as Record<string, unknown>).answer);
  } else if (data && typeof data === 'object') {
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) push(key, value);
  }
  return out.slice(0, 40);
}

async function applicationSheet(ctx: BlockContext, userId: string, id: string): Promise<string> {
  const o = { locale: ctx.locale };
  const guildId = ctx.site.guildId;
  const candidature = await prisma.recruitmentCandidature.findFirst({
    where: { id, guildId, discordId: userId },
    select: { id: true, status: true, data: true, createdAt: true, updatedAt: true, rejectionReason: true, autoRejected: true, autoRejectReason: true, oralResult: true, ticketChannelId: true, reapplyAfter: true },
  });
  if (candidature) {
    const decided = ['APPROVED', 'REJECTED', 'AUTO_REJECTED'].includes(candidature.status);
    const items: ChatterItem[] = [activity(m.site_app_activity_submitted({}, o), candidature.createdAt, ctx.locale)];
    if (candidature.status === 'ORAL' || candidature.oralResult) items.push(activity(m.site_app_activity_oral({}, o), candidature.updatedAt, ctx.locale));
    if (candidature.status === 'APPROVED') items.push(activity(m.site_app_activity_approved({}, o), candidature.updatedAt, ctx.locale));
    if (candidature.status === 'REJECTED' || candidature.status === 'AUTO_REJECTED') {
      const reason = candidature.rejectionReason ?? candidature.autoRejectReason;
      items.push(activity(reason ? m.site_app_activity_rejected_reason({ reason }, o) : m.site_app_activity_rejected({}, o), candidature.updatedAt, ctx.locale));
    }
    let composer = '';
    if (candidature.ticketChannelId) {
      const messages = await readTicketThread(ctx.client, guildId, { id: candidature.id, reason: '', status: candidature.status, createdAt: candidature.createdAt, channelId: candidature.ticketChannelId, threadId: null, userId });
      for (const msg of messages ?? []) items.push(messageItem(ctx, msg));
      if (messages !== null && !decided) composer = replyForm('data-application-reply', candidature.id, ctx.locale);
    }
    const stepIndex = candidature.status === 'PENDING' ? 0 : candidature.status === 'ORAL' ? 1 : 2;
    const tone = CANDIDATURE_TONE[candidature.status] ?? 'warn';
    const label = { PENDING: m.site_applications_pending({}, o), ORAL: m.site_applications_oral({}, o), APPROVED: m.site_applications_approved({}, o) }[candidature.status as string] ?? m.site_applications_rejected({}, o);
    return sheet(
      ctx,
      'applications',
      m.site_applications_candidature({}, o),
      label,
      tone,
      steps([m.site_app_step_sent({}, o), m.site_app_step_oral({}, o), m.site_app_step_decision({}, o)], decided ? 3 : stepIndex),
      [
        [m.site_app_field_sent({}, o), timeTag(candidature.createdAt, ctx.locale, 'long')],
        [m.site_app_field_reapply({}, o), candidature.reapplyAfter && candidature.reapplyAfter > new Date() ? timeTag(candidature.reapplyAfter, ctx.locale, 'long') : ''],
        ...answers(candidature.data).map(([k, v]): [string, string] => [k, esc(v)]),
      ],
      chatter(ctx, items, composer),
    );
  }

  const submission = await prisma.customFormSubmission.findFirst({ where: { id, guildId, userId }, select: { id: true, data: true, createdAt: true, form: { select: { name: true } } } });
  if (!submission) return emptyState(m.site_app_missing({}, o));
  return sheet(
    ctx,
    'applications',
    submission.form.name,
    m.site_applications_sent({}, o),
    'muted',
    '',
    [[m.site_app_field_sent({}, o), timeTag(submission.createdAt, ctx.locale, 'long')], ...answers(submission.data).map(([k, v]): [string, string] => [k, esc(v)])],
    chatter(ctx, [activity(m.site_app_activity_submitted({}, o), submission.createdAt, ctx.locale)], ''),
  );
}

// ─── Accueil ────────────────────────────────────────────────────────────────

async function launcher(ctx: BlockContext, userId: string): Promise<string> {
  const o = { locale: ctx.locale };
  const guildId = ctx.site.guildId;
  const apps = availableApps(ctx.moduleStates);
  const [openTickets, pendingApplications, joinedGiveaways] = await Promise.all([
    apps.includes('tickets') ? prisma.ticket.count({ where: { guildId, userId, status: { in: ['PENDING', 'QUEUED', 'OPEN', 'CLAIMED'] } } }) : 0,
    apps.includes('applications') ? prisma.recruitmentCandidature.count({ where: { guildId, discordId: userId, status: { in: ['PENDING', 'ORAL'] } } }) : 0,
    apps.includes('events') ? prisma.giveaway.count({ where: { guildId, ended: false, participants: { has: userId } } }) : 0,
  ]);
  const badges: Partial<Record<App, number>> = { tickets: openTickets, applications: pendingApplications, events: joinedGiveaways };
  const tiles = apps
    .map((app) => {
      const badge = badges[app] ?? 0;
      return `<a class="app-tile"${attrs({ href: appUrl(ctx, app), style: `--app:${APP_TINTS[app]}` })}>
  <span class="app-icon" aria-hidden="true">${siteIconSvg(APP_ICONS[app], 28)}</span>
  <span class="app-name">${esc(appLabel(app, ctx.locale))}</span>
  <span class="app-desc">${esc(appDescription(app, ctx.locale))}</span>
  ${badge > 0 ? `<span class="app-badge"${attrs({ 'aria-label': m.site_app_badge({ count: badge }, o) })}>${badge}</span>` : ''}
</a>`;
    })
    .join('');
  return `<div class="app-home">
  <p class="app-hello">${esc(m.site_app_hello({ name: ctx.viewer?.displayName ?? '' }, o))}</p>
  <nav class="app-grid"${attrs({ 'aria-label': m.site_my_space({}, o) })}>${tiles}</nav>
</div>`;
}

// ─── Bloc ───────────────────────────────────────────────────────────────────

async function renderMemberApp(ctx: BlockContext, config: Record<string, unknown>, _ref: BlockRef): Promise<string> {
  const gate = viewerGate(ctx);
  if (gate !== null) return gate;
  const o = { locale: ctx.locale };
  const userId = ctx.viewer!.userId;
  const app = (typeof config.app === 'string' ? config.app : 'home') as SiteMemberApp;
  const id = typeof config.id === 'string' ? config.id : '';
  if (app === 'home') return launcher(ctx, userId);
  if (!availableApps(ctx.moduleStates).includes(app)) return `${appBar(ctx, null)}${emptyState(m.site_app_unavailable({}, o))}`;

  const bar = appBar(ctx, app);
  if (app === 'tickets') {
    if (id) return `${bar}${await ticketSheet(ctx, userId, id)}`;
    const [rows, types] = await Promise.all([ticketRows(ctx, userId), listSiteTicketTypes(ctx.site.guildId)]);
    // Ouverture dans un volet de la barre : la liste reste la vue principale.
    const newTicket = `<details class="o-new"><summary class="btn btn-primary btn-sm">${esc(m.site_ticket_new({}, o))}</summary><div class="o-new-panel">${ticketNewForm(types, ctx.locale)}</div></details>`;
    return `${bar}${listView(ctx, rows, {
      filters: [['open', m.site_app_filter_open({}, o)], ['closed', m.site_app_filter_closed({}, o)]],
      columns: [['waiting', m.site_app_status_waiting({}, o)], ['open', m.site_ticket_status_open({}, o)], ['closed', m.site_ticket_status_closed({}, o)]],
      empty: m.site_app_tickets_empty({}, o),
      action: newTicket,
    })}`;
  }
  if (app === 'applications') {
    if (id) return `${bar}${await applicationSheet(ctx, userId, id)}`;
    return `${bar}${listView(ctx, await applicationRows(ctx, userId), {
      filters: [['pending', m.site_app_filter_pending({}, o)], ['decided', m.site_app_filter_decided({}, o)]],
      columns: [['PENDING', m.site_applications_pending({}, o)], ['ORAL', m.site_applications_oral({}, o)], ['APPROVED', m.site_applications_approved({}, o)], ['REJECTED', m.site_applications_rejected({}, o)], ['SENT', m.site_applications_sent({}, o)]],
      empty: m.site_app_applications_empty({}, o),
    })}`;
  }
  if (app === 'events') {
    return `${bar}${listView(ctx, await eventRows(ctx, userId), {
      filters: [['upcoming', m.site_app_filter_upcoming({}, o)], ['done', m.site_app_filter_done({}, o)], ['won', m.site_app_filter_won({}, o)]],
      columns: [['upcoming', m.site_app_filter_upcoming({}, o)], ['done', m.site_app_filter_done({}, o)], ['won', m.site_app_filter_won({}, o)]],
      empty: m.site_app_events_empty({}, o),
    })}`;
  }
  // Progression et réglages : la barre seule, les blocs de l'app suivent dans la page.
  return bar;
}

export const memberAppBlocks: BlockRegistry = {
  memberApp: renderMemberApp,
};
