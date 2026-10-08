/**
 * Blocs « démarches » : appel de sanction, recrutement, formulaire, ticket,
 * suggestions.
 *
 * Les formulaires sont rendus côté serveur (lisibles sans script) ; l'envoi
 * passe par les routes publiques existantes (`/api/public/custom-forms/…`,
 * `/api/public/appeal/…`), que le script du site appelle avec les identifiants
 * du visiteur. Ces routes gardent leurs propres contrôles : le site n'en ajoute
 * aucun qu'elles n'aient pas.
 */

import prisma from '../../../utils/db.js';
import * as m from '../../../lib/paraglide/messages.js';
import { parseDiscordMarkdown } from '../../../api/shared/markdown.js';
import { attrs, cls, esc, truncate } from '../siteHtml.js';
import { emptyState, formatNumber, timeTag, type BlockContext, type BlockRef, type BlockRegistry, type SiteLocale } from './blockContext.js';

// ─── Formulaires ────────────────────────────────────────────────────────────

const FIELD_TYPES = new Set(['short_text', 'paragraph', 'multiple_choice', 'checkboxes', 'dropdown', 'email', 'number', 'date', 'discord_connect']);

interface FormField {
  id: string;
  type: string;
  label: string;
  description: string;
  required: boolean;
  options: string[];
}

/** Structure d'un formulaire relue prudemment : elle vient d'un JSON saisi au dashboard. */
export function readFormFields(structure: unknown): FormField[] {
  const raw = typeof structure === 'object' && structure !== null ? (structure as { fields?: unknown }).fields : null;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
    .map((f) => ({
      id: typeof f.id === 'string' ? f.id.slice(0, 100) : '',
      type: typeof f.type === 'string' && FIELD_TYPES.has(f.type) ? f.type : 'short_text',
      label: typeof f.label === 'string' ? f.label.slice(0, 300) : '',
      description: typeof f.description === 'string' ? f.description.slice(0, 1000) : '',
      required: f.required === true,
      options: Array.isArray(f.options) ? f.options.filter((o): o is string => typeof o === 'string').slice(0, 50).map((o) => o.slice(0, 200)) : [],
    }))
    .filter((f) => f.id && /^[\w-]{1,100}$/.test(f.id));
}

function renderField(field: FormField, formId: string, locale: SiteLocale): string {
  const id = `f-${formId}-${field.id}`;
  const required = field.required ? `<span class="req" aria-label="${esc(m.site_form_required({}, { locale }))}">*</span>` : '';
  const help = field.description ? `<p class="field-help">${esc(field.description)}</p>` : '';
  const common = { id, name: field.id, required: field.required };
  switch (field.type) {
    case 'paragraph':
      return `<div class="field"><label for="${esc(id)}">${esc(field.label)}${required}</label>${help}<textarea${attrs({ ...common, rows: 5, maxlength: 4000 })}></textarea></div>`;
    case 'email':
    case 'number':
    case 'date':
      return `<div class="field"><label for="${esc(id)}">${esc(field.label)}${required}</label>${help}<input${attrs({ ...common, type: field.type, maxlength: field.type === 'email' ? 320 : null })}></div>`;
    case 'dropdown':
      return `<div class="field"><label for="${esc(id)}">${esc(field.label)}${required}</label>${help}<select${attrs(common)}><option value=""></option>${field.options.map((o) => `<option${attrs({ value: o })}>${esc(o)}</option>`).join('')}</select></div>`;
    case 'multiple_choice':
    case 'checkboxes': {
      const type = field.type === 'checkboxes' ? 'checkbox' : 'radio';
      const options = field.options
        .map(
          (o, i) =>
            `<label class="choice"><input${attrs({ type, name: field.id, value: o, required: type === 'radio' && field.required && i === 0 })}> <span>${esc(o)}</span></label>`,
        )
        .join('');
      return `<fieldset class="field"${attrs({ 'data-required': field.type === 'checkboxes' && field.required ? '1' : null })}><legend>${esc(field.label)}${required}</legend>${help}<div class="choices">${options}</div></fieldset>`;
    }
    case 'discord_connect':
      // La route d'envoi lit l'identité dans la session : rien à saisir.
      return `<div class="field field-discord" data-discord-field>${esc(field.label)}</div>`;
    default:
      return `<div class="field"><label for="${esc(id)}">${esc(field.label)}${required}</label>${help}<input${attrs({ ...common, type: 'text', maxlength: 1000 })}></div>`;
  }
}

export interface SiteFormRecord {
  id: string;
  name: string;
  description: string | null;
  structure: unknown;
  isRecruitment: boolean;
  requiresDiscordAuth: boolean;
}

export function renderSiteForm(form: SiteFormRecord, locale: SiteLocale, extra: { eventId?: string | null } = {}): string {
  const fields = readFormFields(form.structure);
  const needsAuth = form.isRecruitment || form.requiresDiscordAuth;
  const o = { locale };
  return `<form class="site-form"${attrs({
    'data-form': form.id,
    'data-requires-login': needsAuth ? '1' : null,
    'data-event': extra.eventId ?? null,
    novalidate: true,
  })}>
  ${needsAuth ? `<p class="form-auth" data-login-hint>${esc(m.site_form_login_required({}, o))}</p>` : ''}
  ${fields.map((f) => renderField(f, form.id, locale)).join('\n  ')}
  <p class="form-status" role="status" aria-live="polite"></p>
  <div class="form-actions"><button type="submit" class="btn btn-primary">${esc(m.site_form_submit({}, o))}</button></div>
</form>`;
}

export async function loadSiteForm(guildId: string, formId: string): Promise<SiteFormRecord | null> {
  return prisma.customForm.findFirst({
    where: { id: formId, guildId, isActive: true },
    select: { id: true, name: true, description: true, structure: true, isRecruitment: true, requiresDiscordAuth: true },
  });
}

async function renderForm(ctx: BlockContext, config: Record<string, unknown>): Promise<string> {
  const formId = typeof config.formId === 'string' ? config.formId : '';
  const form = formId ? await loadSiteForm(ctx.site.guildId, formId) : null;
  if (!form) return emptyState(m.site_form_unavailable({}, { locale: ctx.locale }));
  return `<p class="mod-title">${esc(form.name)}</p>${form.description ? `<p class="mod-lead">${esc(form.description)}</p>` : ''}${renderSiteForm(form, ctx.locale)}`;
}

// ─── Recrutement ────────────────────────────────────────────────────────────

async function renderRecruitment(ctx: BlockContext, config: Record<string, unknown>): Promise<string> {
  const wanted = Array.isArray(config.formIds) ? (config.formIds as string[]) : [];
  const forms = await prisma.customForm.findMany({
    where: { guildId: ctx.site.guildId, isActive: true, isRecruitment: true, ...(wanted.length > 0 ? { id: { in: wanted } } : {}) },
    select: { id: true, name: true, description: true, hierarchy: { select: { name: true, icon: true } } },
    orderBy: { createdAt: 'asc' },
    take: 30,
  });
  const o = { locale: ctx.locale };
  if (forms.length === 0) return emptyState(m.site_recruitment_empty({}, o));
  const cards = forms
    .map(
      (f) => `<article class="job-card">
  <div class="card-body">
    ${f.hierarchy ? `<p class="card-kicker">${f.hierarchy.icon ? `${esc(f.hierarchy.icon)} ` : ''}${esc(f.hierarchy.name)}</p>` : ''}
    <h3 class="card-title">${esc(f.name)}</h3>
    ${f.description ? `<p class="card-text">${esc(truncate(f.description, 300))}</p>` : ''}
    <div class="card-actions"><a class="btn btn-primary btn-sm"${attrs({ href: `${ctx.basePath}/form/${f.id}` })}>${esc(m.site_apply({}, o))}</a></div>
  </div>
</article>`,
    )
    .join('');
  return `<div class="card-grid">${cards}</div>`;
}

// ─── Appel de sanction ──────────────────────────────────────────────────────

async function renderAppeal(ctx: BlockContext): Promise<string> {
  const o = { locale: ctx.locale };
  const config = await prisma.banAppealConfig.findUnique({ where: { guildId: ctx.site.guildId }, select: { enabled: true } });
  if (!config?.enabled) return emptyState(m.site_appeal_disabled({}, o));
  // Le parcours (sanctions du visiteur, formulaire, réponses du staff) se joue
  // côté navigateur sur /api/public/appeal, qui exige la session Discord.
  return `<div class="appeal"${attrs({ 'data-appeal': ctx.site.guildId })}>
  <p class="mod-title">${esc(m.site_appeal_title({}, o))}</p>
  <p class="mod-lead">${esc(m.site_appeal_desc({}, o))}</p>
  <div class="appeal-body" data-appeal-body><p class="empty">${esc(m.site_loading({}, o))}</p></div>
</div>`;
}

// ─── Ticket ─────────────────────────────────────────────────────────────────

async function renderTicket(ctx: BlockContext, _config: Record<string, unknown>, ref: BlockRef): Promise<string> {
  const o = { locale: ctx.locale };
  return `<div class="ticket"${attrs({ 'data-ticket': ref.pageId })}>
  <p class="mod-title">${esc(m.site_ticket_title({}, o))}</p>
  <p class="mod-lead">${esc(m.site_ticket_desc({}, o))}</p>
  <div class="ticket-body" data-ticket-body><p class="empty">${esc(m.site_loading({}, o))}</p></div>
</div>`;
}

// ─── Suggestions ────────────────────────────────────────────────────────────

const SUGGESTION_STATUS = ['PENDING', 'APPROVED', 'REJECTED', 'IMPLEMENTED'] as const;

function suggestionStatusLabel(status: string, locale: SiteLocale): string {
  const o = { locale };
  switch (status) {
    case 'APPROVED':
      return m.site_suggestion_status_APPROVED({}, o);
    case 'REJECTED':
      return m.site_suggestion_status_REJECTED({}, o);
    case 'IMPLEMENTED':
      return m.site_suggestion_status_IMPLEMENTED({}, o);
    default:
      return m.site_suggestion_status_PENDING({}, o);
  }
}

async function renderSuggestions(ctx: BlockContext, config: Record<string, unknown>): Promise<string> {
  const filter = config.filter === 'accepted' || config.filter === 'all' ? config.filter : 'open';
  const status = filter === 'open' ? ['PENDING'] : filter === 'accepted' ? ['APPROVED', 'IMPLEMENTED'] : [...SUGGESTION_STATUS];
  const suggestions = await prisma.suggestion.findMany({
    where: { guildId: ctx.site.guildId, status: { in: status } },
    orderBy: { createdAt: 'desc' },
    take: Number(config.limit) || 10,
    select: { id: true, username: true, content: true, status: true, responseText: true, upvoters: true, downvoters: true, createdAt: true },
  });
  const o = { locale: ctx.locale };
  const viewerId = ctx.viewer?.userId;
  const form =
    config.allowSubmit !== false
      ? `<form class="suggest-form" data-suggest data-requires-login="1">
  <label class="sr-only" for="suggest-${esc(ctx.site.id)}">${esc(m.site_suggestion_placeholder({}, o))}</label>
  <textarea id="suggest-${esc(ctx.site.id)}" name="content" rows="3" maxlength="2000" required placeholder="${esc(m.site_suggestion_placeholder({}, o))}"></textarea>
  <p class="form-status" role="status" aria-live="polite"></p>
  <div class="form-actions"><button type="submit" class="btn btn-primary btn-sm">${esc(m.site_suggestion_submit({}, o))}</button></div>
</form>`
      : '';
  if (suggestions.length === 0) return `${form}${emptyState(m.site_suggestions_empty({}, o))}`;

  const items = suggestions
    .map((s) => {
      const up = s.upvoters.length;
      const down = s.downvoters.length;
      const mine = viewerId ? (s.upvoters.includes(viewerId) ? 'up' : s.downvoters.includes(viewerId) ? 'down' : '') : '';
      const votable = s.status === 'PENDING';
      const vote = (dir: 'up' | 'down', count: number, label: string) =>
        votable
          ? `<button type="button" class="${cls('vote', `vote-${dir}`, mine === dir && 'is-active')}"${attrs({ 'data-action': 'suggestion-vote', 'data-id': s.id, 'data-dir': dir, 'data-requires-login': '1', 'aria-pressed': mine === dir ? 'true' : 'false', 'aria-label': label })}>${dir === 'up' ? '▲' : '▼'} <span>${formatNumber(count, ctx.locale)}</span></button>`
          : `<span class="${cls('vote', `vote-${dir}`)}" aria-label="${esc(label)}">${dir === 'up' ? '▲' : '▼'} <span>${formatNumber(count, ctx.locale)}</span></span>`;
      const response = s.responseText
        ? `<div class="suggest-response"><p class="suggest-response-title">${esc(m.site_suggestion_response({}, o))}</p><div class="rich">${parseDiscordMarkdown(s.responseText, ctx.guild)}</div></div>`
        : '';
      return `<li class="suggest">
  <div class="suggest-votes">${vote('up', up, m.site_vote_up({}, o))}${vote('down', down, m.site_vote_down({}, o))}</div>
  <div class="suggest-body">
    <p class="card-meta"><span class="${cls('pill', `pill-status-${s.status.toLowerCase()}`)}">${esc(suggestionStatusLabel(s.status, ctx.locale))}</span> ${esc(s.username)} · ${timeTag(s.createdAt, ctx.locale, 'medium')}</p>
    <div class="rich">${parseDiscordMarkdown(s.content, ctx.guild)}</div>
    ${response}
  </div>
</li>`;
    })
    .join('');
  return `${form}<ul class="suggestions">${items}</ul>`;
}

export const demarchesBlocks: BlockRegistry = {
  form: renderForm,
  recruitment: renderRecruitment,
  appeal: renderAppeal,
  ticket: renderTicket,
  suggestions: renderSuggestions,
};
