/**
 * Routes dashboard de l'automod des tags.
 *
 *   GET    /tag-automod                 réglages, règles, chiffres du serveur
 *   PATCH  /tag-automod                 réglages
 *   GET    /tag-automod/search?q=       serveurs et tags recensés par Kotbo
 *   POST   /tag-automod/rules           nouvelle règle
 *   PATCH  /tag-automod/rules/:id       modification
 *   DELETE /tag-automod/rules/:id       suppression
 *   GET    /tag-automod/events          journal (curseur `before`)
 *   POST   /tag-automod/scan            aperçu (règle brouillon ou configuration)
 *   POST   /tag-automod/rescan          application à tout le serveur
 */
import { Prisma } from '@prisma/client';
import type { Guild } from 'discord.js';
import prisma from '../../../../utils/db.js';
import { broadcastDashboardStateChange, getGuildName, json, pushAudit, readJsonBody } from '../../../shared.js';
import { jsonFailure } from '../../../shared/failure.js';
import { guildIconUrl, guildTagBadgeUrl } from '../../../../services/core/serverTagService.js';
import { isJailConfigured } from '../../../../services/moderation/jailService.js';
import {
  FLEET_MIN_REPORTERS,
  applyTagRescan,
  getFleetTagCounts,
  invalidateTagAutomod,
  scanTagMembers,
} from '../../../../services/moderation/tagAutomod/tagAutomodService.js';
import { normalizeTagAction, type RuleLike } from '../../../../services/moderation/tagAutomod/tagRules.js';
import { type ModuleRouteContext } from './_shared.js';

const MAX_RULES = 100;
const SNOWFLAKE = /^\d{17,20}$/;
const MAX_DURATION_MIN = 28 * 24 * 60;

type Body = Record<string, unknown>;

const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
function int(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : undefined;
}
function optInt(v: unknown, min: number, max: number): number | null | undefined {
  return v === null ? null : int(v, min, max);
}
function oneOf<T extends string>(v: unknown, values: readonly T[]): T | undefined {
  return values.includes(v as T) ? (v as T) : undefined;
}
function ids(v: unknown): string[] | undefined {
  return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && SNOWFLAKE.test(x)))].slice(0, 100) : undefined;
}
function action(v: unknown): string | undefined {
  return typeof v === 'string' ? normalizeTagAction(v) : undefined;
}

/** Réglages modifiables, validés un par un ; les clés inconnues sont ignorées. */
function parseConfig(body: Body): Prisma.TagAutomodConfigUncheckedUpdateInput {
  const out: Record<string, unknown> = {
    enabled: bool(body.enabled),
    testMode: bool(body.testMode),
    onJoin: bool(body.onJoin),
    onTagChange: bool(body.onTagChange),
    exemptRoleIds: ids(body.exemptRoleIds),
    exemptUserIds: ids(body.exemptUserIds),
    alertChannelId: body.alertChannelId === null ? null : typeof body.alertChannelId === 'string' && SNOWFLAKE.test(body.alertChannelId) ? body.alertChannelId : undefined,
    allowlistOnly: bool(body.allowlistOnly),
    allowlistAction: action(body.allowlistAction),
    allowlistDurationMin: optInt(body.allowlistDurationMin, 1, MAX_DURATION_MIN),
    sharedListEnabled: bool(body.sharedListEnabled),
    sharedListAction: action(body.sharedListAction),
    sharedListDurationMin: optInt(body.sharedListDurationMin, 1, MAX_DURATION_MIN),
    waveEnabled: bool(body.waveEnabled),
    waveMode: oneOf(body.waveMode, ['ADAPTIVE', 'FIXED'] as const),
    wavePreset: oneOf(body.wavePreset, ['SOFT', 'NORMAL', 'STRICT'] as const),
    waveThreshold: int(body.waveThreshold, 2, 100),
    waveWindowSec: int(body.waveWindowSec, 10, 3600),
    waveAction: action(body.waveAction),
    waveDurationMin: optInt(body.waveDurationMin, 1, MAX_DURATION_MIN),
    waveBlockHours: int(body.waveBlockHours, 0, 24 * 30),
    waveReportFleet: bool(body.waveReportFleet),
    newAccountEnabled: bool(body.newAccountEnabled),
    newAccountDays: int(body.newAccountDays, 1, 365),
    newAccountScope: oneOf(body.newAccountScope, ['ANY', 'UNKNOWN'] as const),
    newAccountAction: action(body.newAccountAction),
    newAccountDurationMin: optInt(body.newAccountDurationMin, 1, MAX_DURATION_MIN),
    massAdoptEnabled: bool(body.massAdoptEnabled),
    massAdoptThreshold: int(body.massAdoptThreshold, 2, 100),
    massAdoptWindowMin: int(body.massAdoptWindowMin, 1, 24 * 60),
    massAdoptAction: action(body.massAdoptAction),
    impersonationEnabled: bool(body.impersonationEnabled),
    impersonationAction: action(body.impersonationAction),
    impersonationDurationMin: optInt(body.impersonationDurationMin, 1, MAX_DURATION_MIN),
  };
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out as Prisma.TagAutomodConfigUncheckedUpdateInput;
}

type RuleInput = Omit<Prisma.TagAutomodRuleUncheckedCreateInput, 'guildId'>;

/** Règle complète et cohérente, ou message d'erreur. */
function parseRule(body: Body, partial = false): { rule: Partial<RuleInput> } | { error: string } {
  const rule: Partial<RuleInput> = {};
  if (body.name !== undefined || !partial) {
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
    if (!name) return { error: 'Donne un nom à la règle.' };
    rule.name = name;
  }
  if (body.enabled !== undefined) rule.enabled = Boolean(body.enabled);
  if (body.effect !== undefined || !partial) rule.effect = oneOf(body.effect, ['BLOCK', 'ALLOW'] as const) ?? 'BLOCK';

  if (body.targetType !== undefined || !partial) {
    const targetType = oneOf(body.targetType, ['SERVER', 'TEXT'] as const);
    if (!targetType) return { error: 'Choisis un serveur ou un texte de tag.' };
    rule.targetType = targetType;
    if (targetType === 'SERVER') {
      if (typeof body.targetGuildId !== 'string' || !SNOWFLAKE.test(body.targetGuildId)) return { error: 'Serveur invalide.' };
      rule.targetGuildId = body.targetGuildId;
      rule.targetName = typeof body.targetName === 'string' ? body.targetName.slice(0, 100) : null;
      rule.targetIcon = typeof body.targetIcon === 'string' && body.targetIcon.startsWith('https://cdn.discordapp.com/') ? body.targetIcon : null;
      rule.pattern = null;
    } else {
      const pattern = typeof body.pattern === 'string' ? body.pattern.trim().slice(0, 100) : '';
      if (!pattern) return { error: 'Saisis le texte du tag.' };
      const matchMode = oneOf(body.matchMode, ['EXACT', 'CONTAINS', 'REGEX'] as const) ?? 'EXACT';
      if (matchMode === 'REGEX') {
        try {
          new RegExp(pattern, 'iu');
        } catch {
          return { error: 'Expression régulière invalide.' };
        }
      }
      rule.pattern = pattern;
      rule.matchMode = matchMode;
      rule.targetGuildId = null;
    }
  }

  if (body.action !== undefined || !partial) rule.action = action(body.action) ?? 'ALERT';
  if (body.durationMin !== undefined) rule.durationMin = optInt(body.durationMin, 1, MAX_DURATION_MIN) ?? null;
  if (body.roleId !== undefined) rule.roleId = typeof body.roleId === 'string' && SNOWFLAKE.test(body.roleId) ? body.roleId : null;
  if (rule.action === 'ROLE' && !rule.roleId && !partial) return { error: 'Choisis le rôle à ajouter.' };
  if (body.message !== undefined) rule.message = typeof body.message === 'string' && body.message.trim() ? body.message.slice(0, 1500) : null;
  if (body.escalateAfterMin !== undefined) rule.escalateAfterMin = optInt(body.escalateAfterMin, 1, 7 * 24 * 60) ?? null;
  if (body.escalateAction !== undefined) rule.escalateAction = body.escalateAction === null ? null : action(body.escalateAction) ?? null;
  if (body.escalateDurationMin !== undefined) rule.escalateDurationMin = optInt(body.escalateDurationMin, 1, MAX_DURATION_MIN) ?? null;
  if (body.source !== undefined) rule.source = oneOf(body.source, ['MANUAL', 'TEMPLATE'] as const) ?? 'MANUAL';
  return { rule };
}

const DEFAULT_CONFIG = {
  enabled: false, testMode: false, onJoin: true, onTagChange: true, exemptRoleIds: [], exemptUserIds: [], alertChannelId: null,
  allowlistOnly: false, allowlistAction: 'ALERT', allowlistDurationMin: null,
  sharedListEnabled: false, sharedListAction: 'ALERT', sharedListDurationMin: null,
  waveEnabled: false, waveMode: 'ADAPTIVE', wavePreset: 'NORMAL', waveThreshold: 5, waveWindowSec: 120, waveAction: 'JAIL',
  waveDurationMin: null, waveBlockHours: 24, waveReportFleet: true,
  newAccountEnabled: false, newAccountDays: 7, newAccountScope: 'UNKNOWN', newAccountAction: 'ALERT', newAccountDurationMin: null,
  massAdoptEnabled: false, massAdoptThreshold: 5, massAdoptWindowMin: 60, massAdoptAction: 'ALERT',
  impersonationEnabled: false, impersonationAction: 'ALERT', impersonationDurationMin: null,
};

type SearchRow = { guildId: string; name: string; icon: string | null; tag: string | null; badge: string | null; memberCount: number | null; holders: number };

/** Serveurs recensés : sans recherche, ceux dont des membres portent le tag ici. */
async function searchServers(guildId: string, q: string) {
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const rows = await prisma.$queryRaw<SearchRow[]>`
    SELECT g."guildId", g."name", g."icon", g."tag", g."badge", g."memberCount", COALESCE(h.n, 0)::int AS holders
      FROM "discord_external_guilds" g
      LEFT JOIN (
        SELECT "primaryGuildId", COUNT(*) AS n FROM "member_profiles"
         WHERE "guildId" = ${guildId} AND "guildLeftAt" IS NULL AND "primaryGuildId" IS NOT NULL
         GROUP BY "primaryGuildId"
      ) h ON h."primaryGuildId" = g."guildId"
     WHERE g."guildId" <> ${guildId}
       AND ${q
         ? Prisma.sql`(g."name" ILIKE ${like} OR g."tag" ILIKE ${like} OR g."guildId" = ${q})`
         : Prisma.sql`COALESCE(h.n, 0) > 0`}
     ORDER BY holders DESC, g."memberCount" DESC NULLS LAST
     LIMIT 20
  `;
  const fleet = await getFleetTagCounts();
  return rows.map((r) => ({
    guildId: r.guildId,
    name: r.name,
    iconUrl: guildIconUrl(r.guildId, r.icon),
    tag: r.tag,
    badgeUrl: guildTagBadgeUrl(r.guildId, r.badge),
    memberCount: r.memberCount,
    holders: Number(r.holders),
    fleetBlocks: fleet.get(r.guildId) ?? 0,
  }));
}

function draftRule(body: Body): RuleLike | null {
  const parsed = parseRule(body);
  if ('error' in parsed) return null;
  const r = parsed.rule;
  return {
    id: 'draft', name: r.name ?? '', enabled: true, effect: r.effect ?? 'BLOCK', targetType: r.targetType ?? 'SERVER',
    targetGuildId: r.targetGuildId ?? null, pattern: r.pattern ?? null, matchMode: r.matchMode ?? 'EXACT', action: r.action ?? 'ALERT',
    durationMin: null, roleId: null, message: null, escalateAfterMin: null, escalateAction: null, escalateDurationMin: null, expiresAt: null,
  };
}

function guildOf(ctx: ModuleRouteContext): Guild | null {
  return ctx.client.guilds.cache.get(ctx.guildId) ?? null;
}

export async function handleTagAutomodRoutes(ctx: ModuleRouteContext): Promise<boolean> {
  const { req, res, parts, url, client, guildId, method, auditUser, moduleKey } = ctx;
  if (moduleKey !== 'tag-automod') return false;
  const sub = parts[5];
  const id = parts[6];

  const audit = (action: string, details: string) => pushAudit(guildId, {
    user: auditUser,
    action,
    context: getGuildName(client, guildId),
    module: 'Automod des tags',
    eventType: 'Manuel',
    details,
    channelId: null,
  });
  const changed = () => {
    invalidateTagAutomod(guildId);
    broadcastDashboardStateChange(guildId, 'tag_automod_updated');
  };

  try {
    if (!sub && method === 'GET') {
      const guild = guildOf(ctx);
      const since = new Date(Date.now() - 7 * 86_400_000);
      const [config, rules, own, holders, events7d, waves, byAction] = await Promise.all([
        prisma.tagAutomodConfig.findUnique({ where: { guildId } }),
        prisma.tagAutomodRule.findMany({ where: { guildId }, orderBy: { createdAt: 'asc' } }),
        prisma.discordExternalGuild.findUnique({ where: { guildId }, select: { tag: true, badge: true } }),
        prisma.memberProfile.count({ where: { guildId, guildLeftAt: null, primaryGuildId: { not: null, notIn: [guildId] } } }),
        prisma.tagAutomodEvent.count({ where: { guildId, createdAt: { gte: since } } }),
        prisma.tagWave.findMany({ where: { guildId }, orderBy: { createdAt: 'desc' }, take: 5 }),
        prisma.tagAutomodEvent.groupBy({ by: ['status'], where: { guildId, createdAt: { gte: since } }, _count: { _all: true } }),
      ]);
      const fleet = await getFleetTagCounts();
      json(res, 200, {
        config: { ...DEFAULT_CONFIG, ...(config ?? {}) },
        configured: Boolean(config),
        rules: rules.map((r) => ({ ...r, fleetBlocks: r.targetGuildId ? fleet.get(r.targetGuildId) ?? 0 : 0 })),
        maxRules: MAX_RULES,
        ownTag: own?.tag ?? null,
        ownBadgeUrl: guildTagBadgeUrl(guildId, own?.badge),
        jailConfigured: guild ? await isJailConfigured(guild) : false,
        fleetMinReporters: FLEET_MIN_REPORTERS,
        stats: {
          membersWithOtherTag: holders,
          events7d,
          byStatus: Object.fromEntries(byAction.map((b) => [b.status, b._count._all])),
        },
        waves,
      });
      return true;
    }

    if (!sub && method === 'PATCH') {
      const body = await readJsonBody<Body>(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        json(res, 400, { error: 'Payload invalide' });
        return true;
      }
      const data = parseConfig(body);
      const config = await prisma.tagAutomodConfig.upsert({
        where: { guildId },
        create: { ...(data as Prisma.TagAutomodConfigUncheckedCreateInput), guildId },
        update: data,
      });
      await audit('Réglages de l\'automod des tags', `Champs : ${Object.keys(data).join(', ')}`);
      changed();
      json(res, 200, { config: { ...DEFAULT_CONFIG, ...config } });
      return true;
    }

    if (sub === 'search' && method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
      json(res, 200, { servers: await searchServers(guildId, q) });
      return true;
    }

    if (sub === 'rules' && !id && method === 'POST') {
      const body = await readJsonBody<Body>(req);
      const parsed = parseRule(body ?? {});
      if ('error' in parsed) {
        json(res, 400, { error: parsed.error });
        return true;
      }
      const count = await prisma.tagAutomodRule.count({ where: { guildId } });
      if (count >= MAX_RULES) {
        json(res, 400, { error: `${MAX_RULES} règles au plus par serveur.` });
        return true;
      }
      const rule = await prisma.tagAutomodRule.create({
        data: { ...(parsed.rule as RuleInput), guildId, createdBy: ctx.user.userId ?? null },
      });
      await audit('Nouvelle règle de l\'automod des tags', `${rule.name} (${rule.effect} ${rule.targetType} → ${rule.action})`);
      changed();
      json(res, 201, { rule });
      return true;
    }

    if (sub === 'rules' && id && (method === 'PATCH' || method === 'DELETE')) {
      const existing = await prisma.tagAutomodRule.findFirst({ where: { id, guildId } });
      if (!existing) {
        json(res, 404, { error: 'Règle introuvable' });
        return true;
      }
      if (method === 'DELETE') {
        await prisma.tagAutomodRule.delete({ where: { id } });
        await audit('Règle de l\'automod des tags supprimée', existing.name);
        changed();
        json(res, 200, { ok: true });
        return true;
      }
      const body = await readJsonBody<Body>(req);
      const parsed = parseRule(body ?? {}, true);
      if ('error' in parsed) {
        json(res, 400, { error: parsed.error });
        return true;
      }
      // Une règle de vague modifiée à la main devient permanente.
      const rule = await prisma.tagAutomodRule.update({
        where: { id },
        data: { ...parsed.rule, ...(existing.source === 'WAVE' && body?.permanent === true ? { source: 'MANUAL', expiresAt: null } : {}) },
      });
      await audit('Règle de l\'automod des tags modifiée', rule.name);
      changed();
      json(res, 200, { rule });
      return true;
    }

    if (sub === 'events' && method === 'GET') {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const before = url.searchParams.get('before');
      const tagGuildId = url.searchParams.get('tagGuildId');
      const events = await prisma.tagAutomodEvent.findMany({
        where: {
          guildId,
          ...(before ? { createdAt: { lt: new Date(before) } } : {}),
          ...(tagGuildId && SNOWFLAKE.test(tagGuildId) ? { tagGuildId } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
      json(res, 200, { events, hasMore: events.length === limit });
      return true;
    }

    if ((sub === 'scan' || sub === 'rescan') && method === 'POST') {
      const guild = guildOf(ctx);
      if (!guild) {
        json(res, 404, { error: 'Kotbo n\'est pas sur ce serveur.' });
        return true;
      }
      if (sub === 'rescan') {
        const count = await applyTagRescan(guild);
        await audit('Analyse des tags du serveur', `${count} membre(s) concerné(s)`);
        json(res, 200, { started: true, count });
        return true;
      }
      const body = await readJsonBody<Body>(req);
      const draft = body?.draft && typeof body.draft === 'object' ? draftRule(body.draft as Body) : undefined;
      if (body?.draft && !draft) {
        json(res, 400, { error: 'Règle incomplète' });
        return true;
      }
      const result = await scanTagMembers(guild, draft ?? undefined);
      json(res, 200, { ...result, matches: result.matches.slice(0, 200), total: result.matches.length });
      return true;
    }
  } catch (err) {
    jsonFailure(res, err, 'Erreur de l\'automod des tags', 'TagAutomodAPI');
    return true;
  }
  return false;
}
