/**
 * Outils MCP - règlement du serveur (lecture READ_COMMUNITY, écriture WRITE_COMMUNITY).
 *
 * Mêmes règles que le dashboard : titre et description obligatoires, ordre
 * renuméroté après chaque création, suppression ou réordonnancement, et
 * publication par `publishOrUpdateRegulationMessage`. Le verrouillage du
 * serveur par le règlement reste au dashboard : il réécrit les permissions de
 * tous les salons.
 */
import { z } from 'zod';
import prisma from '../../../utils/db.js';
import {
  loadRegulationArticles,
  publishOrUpdateRegulationMessage,
  renumberRegulationArticles,
  type RegulationArticle,
} from '../../../services/staff/regulationService.js';
import { type McpToolContext, err, ok, toolError } from '../toolkit.js';

const TITLE = z.string().trim().min(1).max(200);
const DESCRIPTION = z.string().trim().min(1).max(6000).describe('Texte de l’article (markdown Discord accepté)');
const EMOJI = z.string().max(64).describe('Emoji affiché devant l’article (vide = 📌 par défaut)');
const KEY_NAME = z.string().optional().describe("Nom de la clé MCP (pour l'audit)");

function serializeArticle(a: RegulationArticle) {
  return { id: a.id, title: a.title, description: a.description, emoji: a.emoji, sortOrder: a.sortOrder, enabled: a.enabled };
}

export function registerRegulationTools(ctx: McpToolContext) {
  const { server, guildId, client, shouldRegister, guard, audit, toolMeta } = ctx;

  if (shouldRegister('READ_COMMUNITY')) {
    server.registerTool(
      'get_regulation',
      {
        description:
          'Lit le règlement du serveur : articles dans leur ordre, salon de publication et messages publiés, rôle et verrouillage. Requiert READ_COMMUNITY.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_COMMUNITY', async () => {
        const [articles, guild] = await Promise.all([
          loadRegulationArticles(guildId),
          prisma.guild.findUnique({
            where: { id: guildId },
            select: {
              regulationChannelId: true,
              configChannelId: true,
              regulationMessageId: true,
              regulationMessageIds: true,
              regulationVerificationEnabled: true,
              regulationRoleId: true,
              regulationLockEnabled: true,
            },
          }),
        ]);
        return ok({
          publishChannelId: guild?.regulationChannelId ?? guild?.configChannelId ?? null,
          publishedMessageIds: guild?.regulationMessageIds.length ? guild.regulationMessageIds : guild?.regulationMessageId ? [guild.regulationMessageId] : [],
          verificationEnabled: guild?.regulationVerificationEnabled ?? false,
          verifiedRoleId: guild?.regulationRoleId ?? null,
          lockEnabled: guild?.regulationLockEnabled ?? false,
          total: articles.length,
          articles: articles.map(serializeArticle),
        });
      })
    );
  }

  if (!shouldRegister('WRITE_COMMUNITY')) return;

  server.registerTool(
    'create_regulation_article',
    {
      description:
        "Ajoute un article au règlement (en dernier, ou à la position donnée). Ne republie pas le message Discord : appeler publish_regulation ensuite. Requiert WRITE_COMMUNITY.",
      inputSchema: {
        title: TITLE.describe("Titre de l'article"),
        description: DESCRIPTION,
        emoji: EMOJI.optional(),
        position: z.number().int().min(0).optional().describe('Position (0 = premier). Défaut : à la fin'),
        enabled: z.boolean().optional().describe('Article affiché (défaut : true)'),
        key_name: KEY_NAME,
      },
      _meta: toolMeta,
    },
    guard('WRITE_COMMUNITY', async ({ title, description, emoji, position, enabled, key_name }) => {
      try {
        const ids = (await loadRegulationArticles(guildId)).map((a) => a.id);
        const article = await prisma.guildRegulationArticle.create({
          data: { guildId, title, description, emoji: emoji?.trim() || null, enabled: enabled ?? true, sortOrder: ids.length },
        });
        ids.splice(position ?? ids.length, 0, article.id);
        await renumberRegulationArticles(guildId, ids);
        await audit(key_name, 'Article règlement créé (MCP)', article.title, `ID: ${article.id}`);
        return ok({ ok: true, articleId: article.id });
      } catch (e) {
        return toolError(e, "Erreur lors de la création de l'article");
      }
    })
  );

  server.registerTool(
    'update_regulation_article',
    {
      description:
        'Modifie un article du règlement. Seuls les champs fournis changent. Ne republie pas le message Discord : appeler publish_regulation ensuite. Requiert WRITE_COMMUNITY.',
      inputSchema: {
        article_id: z.string().describe("ID de l'article (issu de get_regulation)"),
        title: TITLE.optional(),
        description: DESCRIPTION.optional(),
        emoji: EMOJI.optional(),
        enabled: z.boolean().optional().describe('Afficher ou masquer l’article'),
        key_name: KEY_NAME,
      },
      _meta: toolMeta,
    },
    guard('WRITE_COMMUNITY', async ({ article_id, title, description, emoji, enabled, key_name }) => {
      const existing = await prisma.guildRegulationArticle.findFirst({ where: { id: article_id, guildId } });
      if (!existing) return err('Article de règlement introuvable');

      try {
        const article = await prisma.guildRegulationArticle.update({
          where: { id: existing.id },
          data: {
            ...(title !== undefined ? { title } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(emoji !== undefined ? { emoji: emoji.trim() || null } : {}),
            ...(enabled !== undefined ? { enabled } : {}),
          },
        });
        await audit(key_name, 'Article règlement modifié (MCP)', article.title, `ID: ${article.id}`);
        return ok({ ok: true, article: serializeArticle(article) });
      } catch (e) {
        return toolError(e, "Erreur lors de la modification de l'article");
      }
    })
  );

  server.registerTool(
    'delete_regulation_article',
    {
      description: 'Supprime définitivement un article du règlement. Requiert WRITE_COMMUNITY.',
      inputSchema: {
        article_id: z.string().describe("ID de l'article (issu de get_regulation)"),
        key_name: KEY_NAME,
      },
      _meta: toolMeta,
    },
    guard('WRITE_COMMUNITY', async ({ article_id, key_name }) => {
      const existing = await prisma.guildRegulationArticle.findFirst({ where: { id: article_id, guildId } });
      if (!existing) return err('Article de règlement introuvable');

      await prisma.guildRegulationArticle.deleteMany({ where: { id: existing.id, guildId } });
      await renumberRegulationArticles(guildId);
      await audit(key_name, 'Article règlement supprimé (MCP)', existing.title, `ID: ${existing.id}`);
      return ok({ ok: true, articleId: existing.id });
    })
  );

  server.registerTool(
    'reorder_regulation_articles',
    {
      description:
        "Réordonne les articles du règlement. Les articles non cités gardent leur ordre relatif, après ceux cités. Requiert WRITE_COMMUNITY.",
      inputSchema: {
        article_ids: z.array(z.string()).min(1).max(200).describe('IDs des articles dans le nouvel ordre'),
        key_name: KEY_NAME,
      },
      _meta: toolMeta,
    },
    guard('WRITE_COMMUNITY', async ({ article_ids, key_name }) => {
      try {
        const order = await renumberRegulationArticles(guildId, article_ids);
        await audit(key_name, 'Articles règlement réordonnés (MCP)', 'Règlement', `${order.length} article(s)`);
        return ok({ ok: true, order });
      } catch (e) {
        return toolError(e, 'Erreur lors du réordonnancement des articles');
      }
    })
  );

  server.registerTool(
    'publish_regulation',
    {
      description:
        'Publie le règlement dans son salon, ou met à jour les messages déjà publiés. À appeler après des modifications d’articles. Requiert WRITE_COMMUNITY.',
      inputSchema: { key_name: KEY_NAME },
      _meta: toolMeta,
    },
    guard('WRITE_COMMUNITY', async ({ key_name }) => {
      try {
        const result = await publishOrUpdateRegulationMessage(client, guildId);
        await audit(
          key_name,
          result.mode === 'updated' ? 'Règlement actualisé (MCP)' : 'Règlement publié (MCP)',
          'Règlement',
          `${result.messageIds.length} message(s)`,
        );
        return ok({ ok: true, mode: result.mode, messageIds: result.messageIds });
      } catch (e) {
        return toolError(e, 'Impossible de publier le règlement');
      }
    })
  );
}
