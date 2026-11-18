import { Hono } from 'hono';
import type { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { getGuildName, pushAudit, broadcastDashboardStateChange } from '../../shared.js';
import {
  DROP_ADVICE_WINDOW_DAYS,
  DROP_TYPES,
  dropClaimRoleMissing,
  hasDropClaimRules,
  normalizeDropClaimRules,
  normalizeDropGlobalSettings,
  normalizeDropTypeSettings,
  type DropClaimRules,
  type DropOutcomes,
  type DropType,
  type DropTypeSettings,
} from '@kotbo/shared';
import { PlanLockedError, setDashboardModuleStatus } from '../../../services/core/moduleActivationService.js';
import { isGuildInOnboarding } from '../../../services/core/onboardingGate.js';
import {
  dropAnnouncementLabels,
  dropSettingsFromRow,
  dropSettingsToRow,
  getOrCreateDropConfigs,
} from '../../../services/features/dropService.js';
import { resolveGuildLocale } from '../../../utils/i18n.js';

import { fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';
/** Drops passés par page de l'historique de l'onglet global. */
const HISTORY_PAGE_SIZE = 10;
/** Gagnants listés au dépli d'un drop : un mode fenêtre peut en compter des centaines. */
const WINNERS_LIMIT = 100;

const HISTORY_SELECT = {
  id: true,
  type: true,
  itemId: true,
  mode: true,
  channelId: true,
  amount: true,
  jackpot: true,
  maxClaims: true,
  claimCount: true,
  createdAt: true,
  expiresAt: true,
  closedAt: true,
} as const;

/**
 * Une page de l'historique, du plus récent au plus ancien. `before` reprend sous le
 * dernier drop affiché : un curseur plutôt qu'un décalage, pour qu'un drop publié entre
 * deux pages ne fasse pas apparaître deux fois le même. Une ligne de plus est lue pour
 * savoir s'il en reste.
 */
async function dropHistoryPage(guildId: string, filter: { type?: DropType; before?: Date }) {
  const rows = await prisma.drop.findMany({
    where: {
      guildId,
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.before ? { createdAt: { lt: filter.before } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_PAGE_SIZE + 1,
    select: HISTORY_SELECT,
  });
  const page = rows.slice(0, HISTORY_PAGE_SIZE);

  // Un drop d'objet se lit « 2 » sans le nom de la pièce : une seule lecture
  // pour toute la page. Un objet supprimé depuis reste à `null`.
  const itemIds = [...new Set(page.flatMap((drop) => (drop.itemId ? [drop.itemId] : [])))];
  const items = itemIds.length > 0
    ? await prisma.rpgItem.findMany({ where: { id: { in: itemIds } }, select: { id: true, name: true, emoji: true } })
    : [];
  const itemById = new Map(items.map((item) => [item.id, { name: item.name, emoji: item.emoji }]));

  return {
    hasMore: rows.length > HISTORY_PAGE_SIZE,
    drops: page.map(({ itemId, ...drop }) => ({
      ...drop,
      item: itemId ? itemById.get(itemId) ?? null : null,
      createdAt: drop.createdAt.toISOString(),
      expiresAt: drop.expiresAt.toISOString(),
      closedAt: drop.closedAt?.toISOString() ?? null,
    })),
  };
}

/** Date de reprise lue dans l'URL ; illisible, l'historique repart du début. */
function parseBefore(raw: string | null): Date | undefined {
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Gagnants d'un drop, avec l'état de leur versement. Les noms viennent du cache du
 * serveur, complété d'une seule requête pour les absents : un membre parti garde son
 * identifiant, la page affiche alors celui-ci.
 */
async function dropWinners(client: Client, guildId: string, dropId: string) {
  const claims = await prisma.dropClaim.findMany({
    where: { dropId, guildId },
    orderBy: { createdAt: 'asc' },
    take: WINNERS_LIMIT,
    select: { userId: true, amount: true, createdAt: true, paidAt: true, abandonedAt: true },
  });

  const guild = client.guilds.cache.get(guildId);
  const missing = claims.map((claim) => claim.userId).filter((userId) => !guild?.members.cache.has(userId));
  if (guild && missing.length > 0) {
    await guild.members.fetch({ user: missing }).catch(() => null);
  }

  return claims.map((claim) => {
    const member = guild?.members.cache.get(claim.userId);
    return {
      userId: claim.userId,
      name: member?.displayName ?? null,
      avatarUrl: member?.displayAvatarURL({ size: 32 }) ?? null,
      amount: claim.amount,
      claimedAt: claim.createdAt.toISOString(),
      status: claim.paidAt ? 'paid' : claim.abandonedAt ? 'abandoned' : 'pending',
    };
  });
}

/** Règles de ramassage en clair, pour le journal d'audit. */
function describeClaimRules(rules: DropClaimRules): string {
  if (!hasDropClaimRules(rules)) return 'aucune';
  return [
    rules.dailyLimit > 0 ? `${rules.dailyLimit} par 24 h` : null,
    rules.minMemberDays > 0 ? `${rules.minMemberDays} j d'ancienneté` : null,
    rules.requiredRoleId ? `rôle ${rules.requiredRoleId}` : null,
  ].filter(Boolean).join(', ');
}

/** Rôles du serveur en cache ; `null` sans cache, la vérification est alors laissée au clic. */
function cachedGuildRoleIds(client: Client, guildId: string): string[] | null {
  const roles = client.guilds.cache.get(guildId)?.roles?.cache;
  return roles && roles.size > 0 ? [...roles.keys()] : null;
}

function isDropType(value: string | undefined): value is DropType {
  return !!value && (DROP_TYPES as readonly string[]).includes(value);
}

/**
 * Bilan de chaque type sur la période du conseil : drops terminés, et ceux qui ont expiré
 * sans gagnant. Deux comptages groupés pour tout le serveur, appuyés sur l'index
 * `(guildId, createdAt)`, plutôt qu'une lecture des drops eux-mêmes.
 */
async function weeklyDropOutcomes(guildId: string): Promise<Record<DropType, DropOutcomes>> {
  const since = new Date(Date.now() - DROP_ADVICE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const where = { guildId, createdAt: { gte: since }, closedAt: { not: null } };
  const [closed, unclaimed] = await Promise.all([
    prisma.drop.groupBy({ by: ['type'], where, _count: { _all: true } }),
    prisma.drop.groupBy({ by: ['type'], where: { ...where, claimCount: 0 }, _count: { _all: true } }),
  ]);

  const countOf = (rows: Array<{ type: string; _count: { _all: number } }>, type: DropType) =>
    rows.find((row) => row.type === type)?._count._all ?? 0;
  return Object.fromEntries(DROP_TYPES.map((type) => [
    type,
    { closed: countOf(closed, type), unclaimed: countOf(unclaimed, type) },
  ])) as Record<DropType, DropOutcomes>;
}

/**
 * Réglages d'un type, prêts pour le formulaire : la normalisation est la même
 * qu'à l'écriture, donc la page ne peut pas afficher une valeur que l'API
 * refuserait ensuite.
 */
function serializeConfig(row: Awaited<ReturnType<typeof getOrCreateDropConfigs>>[number]) {
  return {
    type: row.type as DropType,
    nextDropAt: row.nextDropAt?.toISOString() ?? null,
    ...dropSettingsFromRow(row),
  };
}

export function createDropsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);


  router.get(`${base}/drops`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const guildData = await prisma.guild.findUnique({
        where: { id: guildId },
        select: {
          dropsEnabled: true,
          dropChannelId: true,
          dropMentionRoleId: true,
          dropMentionJackpotOnly: true,
          dropLifetimeMinutes: true,
          dropDeleteAfterMinutes: true,
          dropJackpotEnabled: true,
          dropJackpotChance: true,
          dropJackpotMultiplier: true,
          dropClaimRules: true,
        },
      });

      if (!guildData) {
        return send(c, { error: 'Serveur non trouvé en base de données.' }, 404);
      }

      const [configs, weeklyOutcomes, locale, abandonedClaims] = await Promise.all([
        getOrCreateDropConfigs(guildId),
        weeklyDropOutcomes(guildId),
        resolveGuildLocale(guildId),
        // Versements abandonnés par la reprise sur la période du conseil : une alerte
        // sans action possible ne doit pas rester affichée pour toujours.
        prisma.dropClaim.count({
          where: { guildId, abandonedAt: { gte: new Date(Date.now() - DROP_ADVICE_WINDOW_DAYS * 24 * 60 * 60 * 1000) } },
        }),
      ]);

      const history = await dropHistoryPage(guildId, {});

      return send(c, {
        ...normalizeDropGlobalSettings(guildData),
        configs: configs.map(serializeConfig),
        weeklyOutcomes,
        abandonedClaims,
        announcement: dropAnnouncementLabels(locale),
        recentDrops: history.drops,
        recentDropsHasMore: history.hasMore,
      });
    } catch (err) {
      logger.error('DropsAPI', 'Error fetching drops config:', err);
      return fail(c, err, 'Erreur lors de la récupération de la configuration des drops.', 'DropsAPI');
    }
  });

  // GET /api/dashboard/guilds/:guildId/drops/history[?type=&before=] : page suivante ou filtrée
  router.get(`${base}/drops/history`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const type = c.req.query('type') ?? undefined;
      return send(c, await dropHistoryPage(guildId, {
        type: isDropType(type) ? type : undefined,
        before: parseBefore((c.req.query('before') ?? null)),
      }));
    } catch (err) {
      logger.error('DropsAPI', 'Error fetching drop history:', err);
      return fail(c, err, 'Erreur lors de la récupération de l\'historique des drops.', 'DropsAPI');
    }
  });

  // GET /api/dashboard/guilds/:guildId/drops/history/:dropId : gagnants d'un drop
  router.get(`${base}/drops/history/:dropId`, ...gate, async (c) => {
    try {
      return send(c, { winners: await dropWinners(client, c.req.param('guildId'), c.req.param('dropId')) });
    } catch (err) {
      logger.error('DropsAPI', 'Error fetching drop history:', err);
      return fail(c, err, 'Erreur lors de la récupération de l\'historique des drops.', 'DropsAPI');
    }
  });

  router.put(`${base}/drops`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    try {
      const body = await readBody<{
        dropsEnabled?: boolean;
        dropChannelId?: string | null;
        dropMentionRoleId?: string | null;
        dropMentionJackpotOnly?: boolean;
        dropLifetimeMinutes?: number;
        dropDeleteAfterMinutes?: number;
        dropJackpotEnabled?: boolean;
        dropJackpotChance?: number;
        dropJackpotMultiplier?: number;
        dropClaimRules?: Partial<DropClaimRules>;
      }>(c);

      const current = await prisma.guild.findUnique({
        where: { id: guildId },
        select: {
          dropsEnabled: true,
          dropChannelId: true,
          dropMentionRoleId: true,
          dropMentionJackpotOnly: true,
          dropLifetimeMinutes: true,
          dropDeleteAfterMinutes: true,
          dropJackpotEnabled: true,
          dropJackpotChance: true,
          dropJackpotMultiplier: true,
          dropClaimRules: true,
        },
      });

      if (!current) {
        return send(c, { error: 'Serveur non trouvé en base de données.' }, 404);
      }

      // Les bornes viennent de `@kotbo/shared` : le formulaire et l'API refusent
      // exactement les mêmes valeurs.
      const settings = normalizeDropGlobalSettings({
        dropsEnabled: body?.dropsEnabled ?? current.dropsEnabled,
        dropChannelId: body?.dropChannelId === undefined ? current.dropChannelId : (body.dropChannelId || null),
        dropMentionRoleId: body?.dropMentionRoleId === undefined ? current.dropMentionRoleId : (body.dropMentionRoleId || null),
        dropMentionJackpotOnly: body?.dropMentionJackpotOnly ?? current.dropMentionJackpotOnly,
        dropLifetimeMinutes: body?.dropLifetimeMinutes ?? current.dropLifetimeMinutes,
        dropDeleteAfterMinutes: body?.dropDeleteAfterMinutes ?? current.dropDeleteAfterMinutes,
        dropJackpotEnabled: body?.dropJackpotEnabled ?? current.dropJackpotEnabled,
        dropJackpotChance: body?.dropJackpotChance ?? current.dropJackpotChance,
        dropJackpotMultiplier: body?.dropJackpotMultiplier ?? current.dropJackpotMultiplier,
        // Fusion règle par règle : le volet peut n'en envoyer qu'une.
        dropClaimRules: { ...normalizeDropClaimRules(current.dropClaimRules), ...body?.dropClaimRules },
      });

      // Un rôle requis nouvellement choisi doit exister : sinon plus personne ne
      // ramasse. Un rôle déjà enregistré puis supprimé ne bloque pas le reste des
      // réglages, la page le signale et le clic l'ignore.
      const previousRoleId = normalizeDropClaimRules(current.dropClaimRules).requiredRoleId;
      if (
        settings.dropClaimRules.requiredRoleId !== previousRoleId
        && dropClaimRoleMissing(settings.dropClaimRules, cachedGuildRoleIds(client, guildId))
      ) {
        return send(c, { error: 'Le rôle requis pour ramasser n\'existe pas sur ce serveur.' }, 400);
      }

      // L'interrupteur maître passe par la bascule de module plutôt que par la
      // colonne : elle seule tient la ligne du registre et la colonne au même
      // état, et invalide la garde d'exécution. Uniquement sur un vrai
      // changement, la page renvoyant l'interrupteur à chaque enregistrement.
      if (settings.dropsEnabled !== current.dropsEnabled) {
        const inOnboarding = await isGuildInOnboarding(guildId);
        await setDashboardModuleStatus(guildId, 'drops', settings.dropsEnabled, 'Dashboard', {
          recordIntentWhenLocked: inOnboarding,
        });
      }

      await prisma.guild.update({
        where: { id: guildId },
        data: {
          dropChannelId: settings.dropChannelId,
          dropMentionRoleId: settings.dropMentionRoleId,
          dropMentionJackpotOnly: settings.dropMentionJackpotOnly,
          dropLifetimeMinutes: settings.dropLifetimeMinutes,
          dropDeleteAfterMinutes: settings.dropDeleteAfterMinutes,
          dropJackpotEnabled: settings.dropJackpotEnabled,
          dropJackpotChance: settings.dropJackpotChance,
          dropJackpotMultiplier: settings.dropJackpotMultiplier,
          dropClaimRules: { ...settings.dropClaimRules },
        },
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Mise à jour configuration Drops',
        context: getGuildName(client, guildId),
        module: 'Drops',
        eventType: 'Manuel',
        details: `Drops activés: ${settings.dropsEnabled}, durée de vie: ${settings.dropLifetimeMinutes} min, suppression du message: ${settings.dropDeleteAfterMinutes > 0 ? `${settings.dropDeleteAfterMinutes} min` : 'jamais'}, jackpot: ${settings.dropJackpotEnabled ? `1/${settings.dropJackpotChance} x${settings.dropJackpotMultiplier}` : 'non'}, règles de ramassage: ${describeClaimRules(settings.dropClaimRules)}`,
        channelId: null,
      });

      broadcastDashboardStateChange(guildId, 'drops_updated');
      return send(c, settings);
    } catch (err) {
      if (err instanceof PlanLockedError) {
        return send(c, {
          error: err.message,
          code: 'plan_locked',
          moduleKey: err.moduleKey,
          currentPlan: err.currentPlan,
          requiredPlan: err.requiredPlan,
        }, 402);
      }
      logger.error('DropsAPI', 'Error updating drops config:', err);
      return fail(c, err, 'Erreur lors de la mise à jour de la configuration des drops.', 'DropsAPI');
    }
  });

  router.put(`${base}/drops/:subAction`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username} (${user.userId})`;
    const subAction = c.req.param('subAction');
    if (!isDropType(subAction)) return send(c, { error: 'Route introuvable' }, 404);
    try {
      const body = await readBody<Partial<DropTypeSettings>>(c);
      const [existing] = await getOrCreateDropConfigs(guildId).then(
        (rows) => rows.filter((row) => row.type === subAction),
      );

      if (!existing) {
        return send(c, { error: 'Type de drop inconnu.' }, 404);
      }

      const current = dropSettingsFromRow(existing);
      // Fusion champ par champ : la page enregistre une section à la fois, un
      // remplacement complet remettrait les autres modes à leur valeur par défaut.
      const settings = normalizeDropTypeSettings(subAction, {
        ...current,
        ...body,
        first: { ...current.first, ...body?.first },
        race: { ...current.race, ...body?.race },
        window: { ...current.window, ...body?.window },
        activity: { ...current.activity, ...body?.activity },
        channelId: body?.channelId === undefined ? current.channelId : (body.channelId || null),
      });

      // L'échéance déjà tirée est effacée quand la fréquence change, et quand le
      // type est rallumé : sans ça, un type éteint depuis des semaines ferait
      // tomber un drop dans la minute qui suit sa réactivation, alors que la
      // page annonce un premier drop au bout d'environ un intervalle.
      const rescheduleNeeded = settings.intervalMinutes !== current.intervalMinutes
        || (settings.enabled && !current.enabled);

      const updated = await prisma.dropConfig.update({
        where: { id: existing.id },
        data: {
          ...dropSettingsToRow(settings),
          ...(rescheduleNeeded ? { nextDropAt: null } : {}),
        },
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: `Mise à jour drop ${subAction}`,
        context: getGuildName(client, guildId),
        module: 'Drops',
        eventType: 'Manuel',
        details: `Activé: ${settings.enabled}, intervalle moyen: ${settings.intervalMinutes} min, activité requise: ${settings.activity.minMessages > 0 ? `${settings.activity.minMessages} msg / ${settings.activity.windowMinutes} min` : 'non'}`,
        channelId: null,
      });

      broadcastDashboardStateChange(guildId, 'drops_updated');
      return send(c, serializeConfig(updated));
    } catch (err) {
      logger.error('DropsAPI', `Error updating drop config ${subAction}:`, err);
      return fail(c, err, 'Erreur lors de la mise à jour de ce type de drop.', 'DropsAPI');
    }
  });

  return router;
}

