/**
 * Outils MCP - Accueil personnalisé (thread de bienvenue scénarisé).
 *
 * Lecture sous READ_COMMUNITY, écriture sous WRITE_COMMUNITY. Couvre le CRUD
 * complet du pipeline d'accueil : configuration du thread, séquence de messages
 * webhook (steps) et pages du menu de présentation (pages).
 *
 * Les règles de validation reprennent celles de l'API dashboard
 * (`routes/dashboard/generalistModules.ts`, moduleKey `welcome-thread`) pour que
 * les deux surfaces ne puissent pas produire des configurations divergentes.
 */
import { ChannelType } from 'discord.js';
import { z } from 'zod';
import prisma from '../../../utils/db.js';
import {
  MAX_MENU_PAGES,
  MAX_THREAD_STEPS,
  clampStepDelay,
  getOrCreateWelcomeThreadConfig,
} from '../../../services/features/welcomeThreadService.js';
import { type McpToolContext, err, ok, resolveChannel, toolError } from '../toolkit.js';

const ACTION_TYPES = ['EMBED', 'ROLE', 'LINK'] as const;
const ROLE_ACTIONS = ['ADD', 'REMOVE', 'TOGGLE', 'EXCLUSIVE'] as const;
const AUTO_ARCHIVE_MINUTES = [60, 1440, 4320, 10080] as const;

type ActionType = (typeof ACTION_TYPES)[number];
type RoleAction = (typeof ROLE_ACTIONS)[number];

type OrderUpdater = { update: (args: { where: { id: string }; data: { order: number } }) => Promise<unknown> };
type OrderableTx = { welcomeThreadStep: OrderUpdater; welcomeMenuPage: OrderUpdater };

/** Brouillon de page tel qu'il sera écrit en base (après fusion avec l'existant sur un update). */
export type MenuPageDraft = {
  label: string;
  actionType: ActionType;
  roleId: string | null;
  roleAction: RoleAction;
  roleGroup: string | null;
  linkUrl: string | null;
  embedTitle: string | null;
  embedDescription: string | null;
};

/** Normalise un nom de groupe exclusif en clé comparable (même règle que le service). */
export function normalizeRoleGroupKey(value: string | null | undefined): string {
  return value?.trim().replace(/\s+/g, ' ').toLocaleLowerCase('fr-FR') || '';
}

/** Valide une page isolée. Miroir des contrôles du PUT dashboard `/welcome-thread/pages`. */
export function validateMenuPageDraft(draft: MenuPageDraft): { ok: true } | { ok: false; error: string } {
  if (!draft.label.trim()) return { ok: false, error: 'Chaque page doit avoir un label.' };

  if (draft.actionType === 'EMBED' && (!draft.embedTitle?.trim() || !draft.embedDescription?.trim())) {
    return { ok: false, error: 'Les pages de type EMBED doivent avoir un titre et une description.' };
  }
  if (draft.actionType === 'ROLE' && !draft.roleId) {
    return { ok: false, error: 'Les pages de type ROLE doivent cibler un rôle.' };
  }
  if (draft.actionType === 'ROLE' && draft.roleAction === 'EXCLUSIVE') {
    const group = draft.roleGroup?.trim().replace(/\s+/g, ' ') || '';
    if (!group) return { ok: false, error: 'Les rôles exclusifs doivent appartenir à un groupe (role_group).' };
    if (group.length > 64) return { ok: false, error: 'Le nom du groupe exclusif est limité à 64 caractères.' };
  }
  if (draft.actionType === 'LINK' && !draft.linkUrl?.trim()) {
    return { ok: false, error: 'Les pages de type LINK doivent avoir une URL ou un salon (link_url).' };
  }

  return { ok: true };
}

/**
 * Contrôle la cohérence des groupes exclusifs sur l'ensemble des pages.
 *
 * Un même rôle dans deux groupes est une erreur bloquante (comme au dashboard).
 * Un groupe à moins de deux rôles n'est en revanche qu'un avertissement ici :
 * le CRUD MCP est incrémental, la première page d'un groupe est forcément seule
 * pendant un instant. Le service refuse déjà l'action côté Discord tant que le
 * groupe est incomplet.
 */
export function checkExclusiveGroups(
  pages: Array<Pick<MenuPageDraft, 'actionType' | 'roleAction' | 'roleId' | 'roleGroup'>>
): { ok: true; warnings: string[] } | { ok: false; error: string } {
  const groups = new Map<string, { label: string; roleIds: Set<string> }>();
  const roleToGroup = new Map<string, string>();

  for (const page of pages) {
    if (page.actionType !== 'ROLE' || page.roleAction !== 'EXCLUSIVE' || !page.roleId) continue;

    const label = page.roleGroup?.trim().replace(/\s+/g, ' ') || '';
    const key = normalizeRoleGroupKey(label);
    if (!key) continue;

    const previous = roleToGroup.get(page.roleId);
    if (previous && previous !== key) {
      return { ok: false, error: 'Un même rôle ne peut pas appartenir à plusieurs groupes exclusifs.' };
    }
    roleToGroup.set(page.roleId, key);

    const group = groups.get(key) ?? { label, roleIds: new Set<string>() };
    group.roleIds.add(page.roleId);
    groups.set(key, group);
  }

  const warnings: string[] = [];
  for (const group of groups.values()) {
    if (group.roleIds.size < 2) {
      warnings.push(
        `Le groupe exclusif « ${group.label} » ne contient qu'un seul rôle : ajoute une autre page du même groupe pour qu'il devienne fonctionnel.`
      );
    }
  }

  return { ok: true, warnings };
}

export function registerWriteWelcomeThreadTools(ctx: McpToolContext) {
  const { server, guildId, client, shouldRegister, guard, audit, toolMeta } = ctx;

  const guild = () => client.guilds.cache.get(guildId);

  // Résout un rôle par ID ou par nom exact, comme les autres outils d'écriture.
  const findRole = (raw: string) => {
    const g = guild();
    if (!g) return null;
    const input = raw.trim().replace(/^<@&(\d+)>$/, '$1');
    return g.roles.cache.get(input) ?? g.roles.cache.find((r) => r.name.toLowerCase() === input.toLowerCase()) ?? null;
  };

  const serializeStep = (step: {
    id: string;
    order: number;
    content: string;
    name: string | null;
    avatarUrl: string | null;
    delayMs: number;
  }) => ({
    id: step.id,
    order: step.order,
    content: step.content,
    webhookName: step.name,
    webhookAvatarUrl: step.avatarUrl,
    delayMs: step.delayMs,
  });

  const serializePage = (page: {
    id: string;
    order: number;
    label: string;
    emoji: string | null;
    summary: string | null;
    actionType: string;
    roleId: string | null;
    roleAction: string;
    roleGroup: string | null;
    linkUrl: string | null;
    embedTitle: string | null;
    embedDescription: string | null;
    embedColor: string;
    embedImageUrl: string | null;
    embedThumbnailUrl: string | null;
  }) => ({
    id: page.id,
    order: page.order,
    label: page.label,
    emoji: page.emoji,
    summary: page.summary,
    actionType: page.actionType,
    roleId: page.roleId,
    roleName: page.roleId ? (guild()?.roles.cache.get(page.roleId)?.name ?? null) : null,
    roleAction: page.roleAction,
    roleGroup: page.roleGroup,
    linkUrl: page.linkUrl,
    embedTitle: page.embedTitle,
    embedDescription: page.embedDescription,
    embedColor: page.embedColor,
    embedImageUrl: page.embedImageUrl,
    embedThumbnailUrl: page.embedThumbnailUrl,
  });

  // Renvoie l'état complet du pipeline : c'est la réponse de tous les outils
  // d'écriture, pour que l'agent voie immédiatement le résultat de son action.
  const snapshot = async (extra?: Record<string, unknown>) => {
    const config = await getOrCreateWelcomeThreadConfig(guildId);
    return ok({
      ...(extra ?? {}),
      config: {
        enabled: config.enabled,
        channelId: config.channelId,
        channelName: config.channelId ? (guild()?.channels.cache.get(config.channelId)?.name ?? null) : null,
        threadNameTemplate: config.threadNameTemplate,
        threadMode: config.threadMode,
        autoArchiveMinutes: config.autoArchiveMinutes,
        typingEnabled: config.typingEnabled,
        webhookName: config.webhookName,
        webhookAvatarUrl: config.webhookAvatarUrl,
        menuEnabled: config.menuEnabled,
        menuStyle: config.menuStyle,
        menuPlaceholder: config.menuPlaceholder,
        embedTitle: config.embedTitle,
        embedDescription: config.embedDescription,
        embedColor: config.embedColor,
        embedImageUrl: config.embedImageUrl,
        embedThumbnailUrl: config.embedThumbnailUrl,
      },
      steps: config.steps.map(serializeStep),
      pages: config.pages.map(serializePage),
      limits: { maxSteps: MAX_THREAD_STEPS, maxPages: MAX_MENU_PAGES },
    });
  };

  // Réécrit les `order` d'une liste d'IDs pour qu'ils soient contigus à partir de 0.
  // `tx` est typé à la main sur la seule opération utilisée : passer par
  // `Prisma.TransactionClient` réexpanserait tout le graphe de relations.
  const reindex = async (tx: OrderableTx, kind: 'step' | 'page', ids: string[]) => {
    const model = kind === 'step' ? tx.welcomeThreadStep : tx.welcomeMenuPage;
    for (const [index, id] of ids.entries()) {
      await model.update({ where: { id }, data: { order: index } });
    }
  };

  const clampPosition = (position: number | undefined, length: number) => {
    if (position === undefined || !Number.isFinite(position)) return length;
    return Math.min(Math.max(Math.trunc(position), 0), length);
  };

  const PLACEHOLDER_HINT =
    'Placeholders disponibles : {user}, {username}, {displayName}, {server}, {memberCount}.';

  // ── Lecture ────────────────────────────────────────────────────────────────
  if (shouldRegister('READ_COMMUNITY')) {
    server.registerTool(
      'get_welcome_thread_config',
      {
        description:
          "Lit le pipeline d'accueil personnalisé : configuration du thread de bienvenue, séquence de messages scénarisés et pages du menu de présentation.",
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_COMMUNITY', async () => {
        try {
          return await snapshot();
        } catch (e) {
          return toolError(e);
        }
      })
    );
  }

  if (!shouldRegister('WRITE_COMMUNITY')) return;

  // ── Configuration ──────────────────────────────────────────────────────────
  server.registerTool(
    'update_welcome_thread_config',
    {
      description:
        "Met à jour la configuration de l'accueil personnalisé (activation, salon des threads, mode public/privé, persona webhook, embed du menu). Seuls les champs fournis sont modifiés.",
      inputSchema: {
        enabled: z.boolean().optional().describe("Active ou désactive l'accueil personnalisé"),
        channel: z
          .string()
          .optional()
          .describe('Salon où les threads de bienvenue sont créés (ID, #mention ou nom)'),
        thread_name_template: z
          .string()
          .max(100)
          .optional()
          .describe(`Modèle du nom de thread. ${PLACEHOLDER_HINT}`),
        thread_mode: z.enum(['public', 'private']).optional().describe('Thread public ou privé'),
        auto_archive_minutes: z
          .union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)])
          .optional()
          .describe('Archivage automatique : 60, 1440, 4320 ou 10080 minutes'),
        typing_enabled: z
          .boolean()
          .optional()
          .describe('Affiche « est en train d\'écrire » pendant les délais entre messages'),
        webhook_name: z.string().max(80).optional().describe('Persona webhook par défaut'),
        webhook_avatar_url: z.string().url().nullable().optional(),
        menu_enabled: z.boolean().optional().describe('Envoyer l\'embed de menu à la fin de la séquence'),
        menu_style: z.enum(['buttons', 'select']).optional(),
        menu_placeholder: z.string().max(150).optional().describe('Texte du menu déroulant (style select)'),
        embed_title: z.string().max(256).optional().describe(`Titre de l'embed du menu. ${PLACEHOLDER_HINT}`),
        embed_description: z.string().max(4096).optional(),
        embed_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('Couleur hex, ex: #5865F2'),
        embed_image_url: z.string().url().nullable().optional(),
        embed_thumbnail_url: z.string().url().nullable().optional(),
        key_name: z.string().optional(),
      },
      _meta: toolMeta,
    },
    guard('WRITE_COMMUNITY', async (args) => {
      try {
        let channelId: string | undefined;
        if (args.channel !== undefined) {
          const resolved = resolveChannel(guildId, client, args.channel);
          if (!resolved.ok) return resolved.response;
          channelId = resolved.channel.id;

          const targetMode = args.thread_mode ?? (await getOrCreateWelcomeThreadConfig(guildId)).threadMode;
          if (targetMode === 'private' && resolved.channel.type !== ChannelType.GuildText) {
            return err(
              "Les threads privés ne sont possibles que dans un salon textuel classique. Choisis un autre salon ou passe thread_mode sur 'public'."
            );
          }
        }

        if (args.auto_archive_minutes !== undefined && !AUTO_ARCHIVE_MINUTES.includes(args.auto_archive_minutes)) {
          return err('auto_archive_minutes doit valoir 60, 1440, 4320 ou 10080.');
        }

        await getOrCreateWelcomeThreadConfig(guildId);
        await prisma.welcomeThreadConfig.update({
          where: { guildId },
          data: {
            enabled: args.enabled,
            ...(channelId !== undefined ? { channelId } : {}),
            threadNameTemplate: args.thread_name_template,
            threadMode: args.thread_mode,
            autoArchiveMinutes: args.auto_archive_minutes,
            typingEnabled: args.typing_enabled,
            webhookName: args.webhook_name,
            webhookAvatarUrl: args.webhook_avatar_url,
            menuEnabled: args.menu_enabled,
            menuStyle: args.menu_style,
            menuPlaceholder: args.menu_placeholder,
            embedTitle: args.embed_title,
            embedDescription: args.embed_description,
            embedColor: args.embed_color,
            embedImageUrl: args.embed_image_url,
            embedThumbnailUrl: args.embed_thumbnail_url,
          },
        });

        await audit(
          args.key_name,
          "Mise à jour accueil personnalisé MCP",
          'WelcomeThread',
          Object.keys(args)
            .filter((k) => k !== 'key_name')
            .join(', ') || 'aucun champ'
        );

        return await snapshot({ ok: true });
      } catch (e) {
        return toolError(e);
      }
    })
  );

  // ── Séquence de messages ───────────────────────────────────────────────────
  server.registerTool(
    'create_welcome_thread_step',
    {
      description:
        "Ajoute un message scénarisé à la séquence d'accueil (envoyé via webhook dans le thread de bienvenue).",
      inputSchema: {
        content: z.string().min(1).max(2000).describe(`Contenu du message. ${PLACEHOLDER_HINT}`),
        webhook_name: z.string().max(80).optional().describe('Persona pour ce message (défaut : celle de la config)'),
        webhook_avatar_url: z.string().url().optional(),
        delay_ms: z
          .number()
          .int()
          .optional()
          .describe('Délai avant envoi, en ms (250 à 120000, défaut 3000). Le typing est visible pendant ce délai.'),
        position: z.number().int().min(0).optional().describe('Position dans la séquence (défaut : à la fin)'),
        key_name: z.string().optional(),
      },
      _meta: toolMeta,
    },
    guard('WRITE_COMMUNITY', async ({ content, webhook_name, webhook_avatar_url, delay_ms, position, key_name }) => {
      try {
        await getOrCreateWelcomeThreadConfig(guildId);
        const existing = await prisma.welcomeThreadStep.findMany({
          where: { guildId },
          orderBy: { order: 'asc' },
          select: { id: true },
        });

        if (existing.length >= MAX_THREAD_STEPS) {
          return err(`La séquence est limitée à ${MAX_THREAD_STEPS} messages. Supprime-en un avant d'en ajouter.`);
        }

        const index = clampPosition(position, existing.length);
        const created = await prisma.$transaction(async (tx) => {
          const step = await tx.welcomeThreadStep.create({
            data: {
              guildId,
              order: index,
              content: content.trim().slice(0, 2000),
              name: webhook_name?.trim() || null,
              avatarUrl: webhook_avatar_url?.trim() || null,
              delayMs: clampStepDelay(delay_ms ?? 3000),
            },
          });

          const ids = existing.map((s) => s.id);
          ids.splice(index, 0, step.id);
          await reindex(tx, 'step', ids);
          return step;
        });

        await audit(key_name, "Ajout message accueil MCP", 'WelcomeThread', `Position ${index} - ${content.slice(0, 80)}`);
        return await snapshot({ ok: true, stepId: created.id, position: index });
      } catch (e) {
        return toolError(e);
      }
    })
  );

  server.registerTool(
    'update_welcome_thread_step',
    {
      description: "Modifie un message de la séquence d'accueil. Seuls les champs fournis sont modifiés.",
      inputSchema: {
        step_id: z.string().describe("ID du message (voir get_welcome_thread_config)"),
        content: z.string().min(1).max(2000).optional(),
        webhook_name: z.string().max(80).nullable().optional().describe('null = persona par défaut de la config'),
        webhook_avatar_url: z.string().url().nullable().optional(),
        delay_ms: z.number().int().optional().describe('Délai avant envoi, en ms (250 à 120000)'),
        position: z.number().int().min(0).optional().describe('Nouvelle position dans la séquence'),
        key_name: z.string().optional(),
      },
      _meta: toolMeta,
    },
    guard('WRITE_COMMUNITY', async ({ step_id, content, webhook_name, webhook_avatar_url, delay_ms, position, key_name }) => {
      try {
        const step = await prisma.welcomeThreadStep.findFirst({ where: { id: step_id, guildId } });
        if (!step) return err(`Message d'accueil introuvable : ${step_id}.`);

        await prisma.$transaction(async (tx) => {
          await tx.welcomeThreadStep.update({
            where: { id: step_id },
            data: {
              ...(content !== undefined ? { content: content.trim().slice(0, 2000) } : {}),
              ...(webhook_name !== undefined ? { name: webhook_name?.trim() || null } : {}),
              ...(webhook_avatar_url !== undefined ? { avatarUrl: webhook_avatar_url?.trim() || null } : {}),
              ...(delay_ms !== undefined ? { delayMs: clampStepDelay(delay_ms) } : {}),
            },
          });

          if (position !== undefined) {
            const others = await tx.welcomeThreadStep.findMany({
              where: { guildId, id: { not: step_id } },
              orderBy: { order: 'asc' },
              select: { id: true },
            });
            const ids = others.map((s) => s.id);
            ids.splice(clampPosition(position, ids.length), 0, step_id);
            await reindex(tx, 'step', ids);
          }
        });

        await audit(key_name, "Modification message accueil MCP", 'WelcomeThread', `Step ${step_id}`);
        return await snapshot({ ok: true, stepId: step_id });
      } catch (e) {
        return toolError(e);
      }
    })
  );

  server.registerTool(
    'delete_welcome_thread_step',
    {
      description: "Supprime un message de la séquence d'accueil et renumérote les suivants.",
      inputSchema: {
        step_id: z.string(),
        key_name: z.string().optional(),
      },
      _meta: toolMeta,
    },
    guard('WRITE_COMMUNITY', async ({ step_id, key_name }) => {
      try {
        const step = await prisma.welcomeThreadStep.findFirst({ where: { id: step_id, guildId } });
        if (!step) return err(`Message d'accueil introuvable : ${step_id}.`);

        await prisma.$transaction(async (tx) => {
          await tx.welcomeThreadStep.delete({ where: { id: step_id } });
          const remaining = await tx.welcomeThreadStep.findMany({
            where: { guildId },
            orderBy: { order: 'asc' },
            select: { id: true },
          });
          await reindex(tx, 'step', remaining.map((s) => s.id));
        });

        await audit(key_name, "Suppression message accueil MCP", 'WelcomeThread', `Step ${step_id}`);
        return await snapshot({ ok: true, deletedStepId: step_id });
      } catch (e) {
        return toolError(e);
      }
    })
  );

  server.registerTool(
    'reorder_welcome_thread_steps',
    {
      description: "Réordonne toute la séquence d'accueil. La liste doit contenir tous les IDs de messages existants.",
      inputSchema: {
        step_ids: z.array(z.string()).min(1).describe('IDs dans le nouvel ordre d\'envoi'),
        key_name: z.string().optional(),
      },
      _meta: toolMeta,
    },
    guard('WRITE_COMMUNITY', async ({ step_ids, key_name }) => {
      try {
        const existing = await prisma.welcomeThreadStep.findMany({ where: { guildId }, select: { id: true } });
        const existingIds = new Set(existing.map((s) => s.id));
        const provided = new Set(step_ids);

        if (provided.size !== step_ids.length) return err('La liste step_ids contient des doublons.');
        if (provided.size !== existingIds.size || step_ids.some((id: string) => !existingIds.has(id))) {
          return err(
            `La liste doit contenir exactement les ${existingIds.size} message(s) existant(s) : ${[...existingIds].join(', ') || 'aucun'}.`
          );
        }

        await prisma.$transaction(async (tx) => reindex(tx, 'step', step_ids));

        await audit(key_name, "Réordonnancement séquence accueil MCP", 'WelcomeThread', `${step_ids.length} message(s)`);
        return await snapshot({ ok: true });
      } catch (e) {
        return toolError(e);
      }
    })
  );

  // ── Pages du menu ──────────────────────────────────────────────────────────
  const pageInputSchema = {
    label: z.string().max(80).describe('Texte du bouton / de l\'option'),
    emoji: z.string().nullable().optional().describe('Emoji unicode ou custom (<:nom:id>)'),
    summary: z.string().max(100).nullable().optional().describe('Sous-texte affiché en style select'),
    action_type: z
      .enum(ACTION_TYPES)
      .optional()
      .describe("EMBED : affiche une page. ROLE : donne/retire un rôle. LINK : bouton de lien."),
    role: z.string().nullable().optional().describe('Rôle ciblé pour action_type=ROLE (ID, mention ou nom)'),
    role_action: z.enum(ROLE_ACTIONS).optional().describe('ADD, REMOVE, TOGGLE ou EXCLUSIVE'),
    role_group: z
      .string()
      .max(64)
      .nullable()
      .optional()
      .describe('Groupe mutuellement exclusif, requis pour role_action=EXCLUSIVE'),
    link_url: z.string().nullable().optional().describe('URL ou lien de salon pour action_type=LINK'),
    embed_title: z.string().max(256).nullable().optional(),
    embed_description: z.string().max(4096).nullable().optional(),
    embed_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    embed_image_url: z.string().url().nullable().optional(),
    embed_thumbnail_url: z.string().url().nullable().optional(),
  };

  server.registerTool(
    'create_welcome_menu_page',
    {
      description:
        "Ajoute une entrée au menu de présentation affiché à la fin de l'accueil (page embed, attribution de rôle ou lien).",
      inputSchema: {
        ...pageInputSchema,
        position: z.number().int().min(0).optional().describe('Position dans le menu (défaut : à la fin)'),
        key_name: z.string().optional(),
      },
      _meta: toolMeta,
    },
    guard('WRITE_COMMUNITY', async (args) => {
      try {
        await getOrCreateWelcomeThreadConfig(guildId);
        const existing = await prisma.welcomeMenuPage.findMany({
          where: { guildId },
          orderBy: { order: 'asc' },
        });

        if (existing.length >= MAX_MENU_PAGES) {
          return err(`Le menu est limité à ${MAX_MENU_PAGES} entrées. Supprimes-en une avant d'en ajouter.`);
        }

        const actionType: ActionType = args.action_type ?? 'EMBED';
        const roleAction: RoleAction = args.role_action ?? 'ADD';

        let roleId: string | null = null;
        if (actionType === 'ROLE' && args.role) {
          const role = findRole(args.role);
          if (!role) return err(`Rôle introuvable : « ${args.role} ».`);
          roleId = role.id;
        }

        const draft: MenuPageDraft = {
          label: args.label,
          actionType,
          roleId,
          roleAction,
          roleGroup: args.role_group ?? null,
          linkUrl: args.link_url ?? null,
          embedTitle: args.embed_title ?? null,
          embedDescription: args.embed_description ?? null,
        };

        const validation = validateMenuPageDraft(draft);
        if (!validation.ok) return err(validation.error);

        const groupCheck = checkExclusiveGroups([
          ...existing.map((p) => ({
            actionType: p.actionType as ActionType,
            roleAction: p.roleAction as RoleAction,
            roleId: p.roleId,
            roleGroup: p.roleGroup,
          })),
          draft,
        ]);
        if (!groupCheck.ok) return err(groupCheck.error);

        const index = clampPosition(args.position, existing.length);
        const created = await prisma.$transaction(async (tx) => {
          const page = await tx.welcomeMenuPage.create({
            data: {
              guildId,
              order: index,
              label: args.label.trim().slice(0, 80),
              emoji: args.emoji?.trim() || null,
              summary: args.summary?.trim().slice(0, 100) || null,
              actionType,
              roleId: actionType === 'ROLE' ? roleId : null,
              roleAction,
              roleGroup:
                actionType === 'ROLE' && roleAction === 'EXCLUSIVE'
                  ? args.role_group?.trim().replace(/\s+/g, ' ') || null
                  : null,
              linkUrl: actionType === 'LINK' ? args.link_url?.trim() || null : null,
              embedTitle: args.embed_title?.trim().slice(0, 256) || null,
              embedDescription: args.embed_description?.trim().slice(0, 4096) || null,
              embedColor: args.embed_color?.trim() || '#5865F2',
              embedImageUrl: args.embed_image_url?.trim() || null,
              embedThumbnailUrl: args.embed_thumbnail_url?.trim() || null,
            },
          });

          const ids = existing.map((p) => p.id);
          ids.splice(index, 0, page.id);
          await reindex(tx, 'page', ids);
          return page;
        });

        await audit(args.key_name, "Ajout page menu accueil MCP", 'WelcomeThread', `${actionType} - ${args.label}`);
        return await snapshot({
          ok: true,
          pageId: created.id,
          position: index,
          ...(groupCheck.warnings.length > 0 ? { warnings: groupCheck.warnings } : {}),
        });
      } catch (e) {
        return toolError(e);
      }
    })
  );

  server.registerTool(
    'update_welcome_menu_page',
    {
      description: "Modifie une entrée du menu d'accueil. Seuls les champs fournis sont modifiés.",
      inputSchema: {
        page_id: z.string().describe('ID de la page (voir get_welcome_thread_config)'),
        ...pageInputSchema,
        label: pageInputSchema.label.optional(),
        position: z.number().int().min(0).optional().describe('Nouvelle position dans le menu'),
        key_name: z.string().optional(),
      },
      _meta: toolMeta,
    },
    guard('WRITE_COMMUNITY', async (args) => {
      try {
        const pages = await prisma.welcomeMenuPage.findMany({ where: { guildId }, orderBy: { order: 'asc' } });
        const page = pages.find((p) => p.id === args.page_id);
        if (!page) return err(`Page de menu introuvable : ${args.page_id}.`);

        const actionType: ActionType = args.action_type ?? (page.actionType as ActionType);
        const roleAction: RoleAction = args.role_action ?? (page.roleAction as RoleAction);

        let roleId: string | null = page.roleId;
        if (args.role !== undefined) {
          if (args.role === null) {
            roleId = null;
          } else {
            const role = findRole(args.role);
            if (!role) return err(`Rôle introuvable : « ${args.role} ».`);
            roleId = role.id;
          }
        }

        const draft: MenuPageDraft = {
          label: args.label ?? page.label,
          actionType,
          roleId,
          roleAction,
          roleGroup: args.role_group !== undefined ? args.role_group : page.roleGroup,
          linkUrl: args.link_url !== undefined ? args.link_url : page.linkUrl,
          embedTitle: args.embed_title !== undefined ? args.embed_title : page.embedTitle,
          embedDescription: args.embed_description !== undefined ? args.embed_description : page.embedDescription,
        };

        const validation = validateMenuPageDraft(draft);
        if (!validation.ok) return err(validation.error);

        const groupCheck = checkExclusiveGroups([
          ...pages
            .filter((p) => p.id !== page.id)
            .map((p) => ({
              actionType: p.actionType as ActionType,
              roleAction: p.roleAction as RoleAction,
              roleId: p.roleId,
              roleGroup: p.roleGroup,
            })),
          draft,
        ]);
        if (!groupCheck.ok) return err(groupCheck.error);

        await prisma.$transaction(async (tx) => {
          await tx.welcomeMenuPage.update({
            where: { id: page.id },
            data: {
              label: draft.label.trim().slice(0, 80),
              ...(args.emoji !== undefined ? { emoji: args.emoji?.trim() || null } : {}),
              ...(args.summary !== undefined ? { summary: args.summary?.trim().slice(0, 100) || null } : {}),
              actionType,
              roleId: actionType === 'ROLE' ? roleId : null,
              roleAction,
              roleGroup:
                actionType === 'ROLE' && roleAction === 'EXCLUSIVE'
                  ? draft.roleGroup?.trim().replace(/\s+/g, ' ') || null
                  : null,
              linkUrl: actionType === 'LINK' ? draft.linkUrl?.trim() || null : null,
              ...(args.embed_title !== undefined
                ? { embedTitle: args.embed_title?.trim().slice(0, 256) || null }
                : {}),
              ...(args.embed_description !== undefined
                ? { embedDescription: args.embed_description?.trim().slice(0, 4096) || null }
                : {}),
              ...(args.embed_color !== undefined ? { embedColor: args.embed_color.trim() } : {}),
              ...(args.embed_image_url !== undefined
                ? { embedImageUrl: args.embed_image_url?.trim() || null }
                : {}),
              ...(args.embed_thumbnail_url !== undefined
                ? { embedThumbnailUrl: args.embed_thumbnail_url?.trim() || null }
                : {}),
            },
          });

          if (args.position !== undefined) {
            const ids = pages.filter((p) => p.id !== page.id).map((p) => p.id);
            ids.splice(clampPosition(args.position, ids.length), 0, page.id);
            await reindex(tx, 'page', ids);
          }
        });

        await audit(args.key_name, "Modification page menu accueil MCP", 'WelcomeThread', `Page ${page.id}`);
        return await snapshot({
          ok: true,
          pageId: page.id,
          ...(groupCheck.warnings.length > 0 ? { warnings: groupCheck.warnings } : {}),
        });
      } catch (e) {
        return toolError(e);
      }
    })
  );

  server.registerTool(
    'delete_welcome_menu_page',
    {
      description: "Supprime une entrée du menu d'accueil et renumérote les suivantes.",
      inputSchema: {
        page_id: z.string(),
        key_name: z.string().optional(),
      },
      _meta: toolMeta,
    },
    guard('WRITE_COMMUNITY', async ({ page_id, key_name }) => {
      try {
        const page = await prisma.welcomeMenuPage.findFirst({ where: { id: page_id, guildId } });
        if (!page) return err(`Page de menu introuvable : ${page_id}.`);

        await prisma.$transaction(async (tx) => {
          await tx.welcomeMenuPage.delete({ where: { id: page_id } });
          const remaining = await tx.welcomeMenuPage.findMany({
            where: { guildId },
            orderBy: { order: 'asc' },
            select: { id: true },
          });
          await reindex(tx, 'page', remaining.map((p) => p.id));
        });

        const groupCheck = checkExclusiveGroups(
          (await prisma.welcomeMenuPage.findMany({ where: { guildId } })).map((p) => ({
            actionType: p.actionType as ActionType,
            roleAction: p.roleAction as RoleAction,
            roleId: p.roleId,
            roleGroup: p.roleGroup,
          }))
        );

        await audit(key_name, "Suppression page menu accueil MCP", 'WelcomeThread', `Page ${page_id} - ${page.label}`);
        return await snapshot({
          ok: true,
          deletedPageId: page_id,
          ...(groupCheck.ok && groupCheck.warnings.length > 0 ? { warnings: groupCheck.warnings } : {}),
        });
      } catch (e) {
        return toolError(e);
      }
    })
  );

  server.registerTool(
    'reorder_welcome_menu_pages',
    {
      description: "Réordonne le menu d'accueil. La liste doit contenir tous les IDs de pages existants.",
      inputSchema: {
        page_ids: z.array(z.string()).min(1).describe('IDs dans le nouvel ordre d\'affichage'),
        key_name: z.string().optional(),
      },
      _meta: toolMeta,
    },
    guard('WRITE_COMMUNITY', async ({ page_ids, key_name }) => {
      try {
        const existing = await prisma.welcomeMenuPage.findMany({ where: { guildId }, select: { id: true } });
        const existingIds = new Set(existing.map((p) => p.id));
        const provided = new Set(page_ids);

        if (provided.size !== page_ids.length) return err('La liste page_ids contient des doublons.');
        if (provided.size !== existingIds.size || page_ids.some((id: string) => !existingIds.has(id))) {
          return err(
            `La liste doit contenir exactement les ${existingIds.size} page(s) existante(s) : ${[...existingIds].join(', ') || 'aucune'}.`
          );
        }

        await prisma.$transaction(async (tx) => reindex(tx, 'page', page_ids));

        await audit(key_name, "Réordonnancement menu accueil MCP", 'WelcomeThread', `${page_ids.length} page(s)`);
        return await snapshot({ ok: true });
      } catch (e) {
        return toolError(e);
      }
    })
  );
}
