/** Outils MCP - site communautaire (permissions READ_SITE et WRITE_SITE). */
import { z } from 'zod';
import type { SitePageKind } from '@prisma/client';
import {
  markdownToSiteDocument,
  normalizeModuleConfig,
  normalizeSiteDocument,
  isSiteModuleKey,
  siteDocumentToMarkdown,
  SITE_FONTS,
  SITE_MODULES,
  SITE_THEME_KEYS,
  siteModuleBotDependency,
  type SiteDocument,
  type SiteNode,
} from '@kotbo/shared';
import prisma from '../../../utils/db.js';
import { getDashboardUrl } from '../../shared.js';
import { type McpToolContext, err, ok } from '../toolkit.js';
import { getModuleStates } from '../../../services/core/moduleGate.js';
import {
  createPage,
  createSite,
  deleteComment,
  deletePage,
  deleteSite,
  getAdminPage,
  getAdminSite,
  listAdminPages,
  listComments,
  listRevisions,
  publishPage,
  reorderPages,
  restoreRevision,
  schedulePage,
  setCommentStatus,
  SiteAdminError,
  suggestSiteSlug,
  unpublishPage,
  updatePage,
  updateSite,
} from '../../../services/site/siteAdminService.js';
import { AgentLockError, beginAgentWrite, getAgentLockStatus, releaseAgentLock } from '../../../services/site/siteAgentLock.js';
import { resetCollabRoom, flushCollabRoom } from '../../../services/site/siteCollabService.js';
import { searchSite } from '../../../services/site/siteSearch.js';
import { getSiteAnalytics } from '../../../services/site/siteAnalyticsService.js';
import { listSiteAssets, storeSiteAsset, SITE_UPLOAD_MAX_BYTES } from '../../../services/site/siteUploads.js';
import { createPreviewToken } from '../../../services/site/sitePreview.js';
import { isSiteTemplate, SITE_TEMPLATES } from '../../../services/site/siteTemplates.js';
import { assertWebhookUrlReachable } from '../../../services/integrations/outgoingWebhookSecurity.js';

/**
 * Tout ce que l'éditeur permet, un agent peut le faire ici. Deux règles en
 * plus :
 *  - chaque écriture prend la main sur le site (`beginAgentWrite`) : les
 *    humains passent en lecture seule et voient un bandeau, avec de quoi
 *    interrompre l'agent ; interrompu, l'agent ne peut plus écrire sur ce site
 *    tant qu'on ne l'y autorise pas de nouveau ;
 *  - le contenu s'écrit en Markdown (converti) ou en document JSON, toujours
 *    relu par la liste blanche du serveur.
 */

const KINDS = ['PAGE', 'WIKI', 'BLOG'] as const;

function siteUrl(slug: string): string {
  return `${getDashboardUrl().replace(/\/$/, '')}/s/${slug}`;
}

function pagePublicUrl(slug: string, page: { kind: SitePageKind; slug: string }): string {
  const base = siteUrl(slug);
  return page.kind === 'WIKI' ? `${base}/wiki/${page.slug}` : page.kind === 'BLOG' ? `${base}/blog/${page.slug}` : `${base}/${page.slug}`;
}

/** Erreur métier lisible par l'agent. */
function failure(error: unknown) {
  if (error instanceof AgentLockError) {
    return err(
      `Un membre de l'équipe (${error.byName}) a interrompu l'agent sur ce site. Plus aucune modification n'est possible jusqu'à ${new Date(error.until).toISOString()}, sauf s'il réautorise l'agent depuis le dashboard.`,
      { code: 'agent_interrupted' },
    );
  }
  if (error instanceof SiteAdminError) return err(error.detail ? `${error.code}: ${error.detail}` : error.code, { code: error.code });
  return err(error instanceof Error ? error.message : String(error));
}

/** Contenu d'entrée : Markdown converti, ou document JSON normalisé. */
function readContent(markdown: string | undefined, content: unknown): SiteDocument | null {
  if (typeof markdown === 'string') return markdownToSiteDocument(markdown);
  if (content !== undefined) return normalizeSiteDocument(content);
  return null;
}

const documentSchema = z.record(z.any()).describe('Document ProseMirror du site ({ type: "doc", content: [...] }) ; voir get_site_reference');

export function registerSiteTools(ctx: McpToolContext) {
  const { server, guildId, client, shouldRegister, guard, audit, toolMeta, ownerId } = ctx;
  const actorId = ownerId ?? 'mcp_agent';

  async function requireSite() {
    const site = await getAdminSite(guildId);
    if (!site) throw new SiteAdminError('site_missing', 404, 'Aucun site : crée-le avec create_site.');
    return site;
  }

  /** Prend la main avant d'écrire ; lève si un humain a interrompu l'agent. */
  function lock(keyName: string | undefined, activity: string, pageId?: string) {
    beginAgentWrite(guildId, keyName ?? 'MCP', activity, pageId ?? null);
  }

  // ═══════════════════════════════════════════════════════════════ LECTURE
  if (shouldRegister('READ_SITE')) {
    server.registerTool(
      'get_site',
      { description: "Réglages du site communautaire du serveur : adresse, état, thème, menu, page d'accueil, rédacteurs, et l'état du verrou de l'agent.", inputSchema: {}, _meta: toolMeta },
      guard('READ_SITE', async () => {
        const site = await getAdminSite(guildId);
        const states = await getModuleStates(guildId);
        if (!site) {
          const guild = client.guilds.cache.get(guildId);
          return ok({ site: null, suggestedSlug: await suggestSiteSlug(guild?.name ?? guildId), templates: SITE_TEMPLATES, hint: 'Crée le site avec create_site.' });
        }
        const pages = await listAdminPages(site.id);
        return ok({
          site: { ...site, url: siteUrl(site.slug) },
          modules: { site: states.site !== false, site_wiki: states.site_wiki !== false, site_blog: states.site_blog !== false },
          pageCounts: Object.fromEntries(KINDS.map((k) => [k, pages.filter((p) => p.kind === k).length])),
          agent: getAgentLockStatus(guildId),
        });
      }),
    );

    server.registerTool(
      'list_site_pages',
      {
        description: 'Pages du site (pages libres, wiki, blog) avec leur état : brouillon, publiée, modifications non publiées, programmée.',
        inputSchema: { kind: z.enum(KINDS).optional().describe('Filtrer par type') },
        _meta: toolMeta,
      },
      guard('READ_SITE', async ({ kind }) => {
        try {
          const site = await requireSite();
          const pages = await listAdminPages(site.id, kind ? [kind] : undefined);
          return ok({ pages: pages.map((p) => ({ ...p, url: pagePublicUrl(site.slug, p) })) });
        } catch (error) {
          return failure(error);
        }
      }),
    );

    server.registerTool(
      'get_site_page',
      {
        description: "Une page du site : réglages et contenu (brouillon par défaut) en Markdown lisible et en document JSON. Le Markdown n'est qu'une lecture : les blocs propres au site y apparaissent entre crochets.",
        inputSchema: {
          page_id: z.string().optional(),
          kind: z.enum(KINDS).optional().describe('Avec slug, à la place de page_id'),
          slug: z.string().optional(),
          version: z.enum(['draft', 'published']).default('draft'),
        },
        _meta: toolMeta,
      },
      guard('READ_SITE', async ({ page_id, kind, slug, version }) => {
        try {
          const site = await requireSite();
          let id = page_id;
          if (!id && kind && slug) id = (await prisma.sitePage.findFirst({ where: { siteId: site.id, kind, slug }, select: { id: true } }))?.id;
          if (!id) return err('Précise page_id, ou kind et slug.');
          await flushCollabRoom(id);
          const page = await getAdminPage(site.id, id);
          if (!page) return err('Page introuvable.');
          const raw = version === 'published' ? (await prisma.sitePage.findUnique({ where: { id }, select: { publishedContent: true } }))?.publishedContent : page.draftContent;
          const doc = normalizeSiteDocument(raw);
          const { draftContent: _draft, ...meta } = page;
          return ok({ page: { ...meta, url: pagePublicUrl(site.slug, page) }, version, markdown: siteDocumentToMarkdown(doc), document: doc });
        } catch (error) {
          return failure(error);
        }
      }),
    );

    server.registerTool(
      'get_site_page_revisions',
      { description: "Historique des publications d'une page (une version par publication).", inputSchema: { page_id: z.string() }, _meta: toolMeta },
      guard('READ_SITE', async ({ page_id }) => ok({ revisions: await listRevisions(guildId, page_id) })),
    );

    server.registerTool(
      'get_site_reference',
      {
        description:
          "Référence pour écrire une page : format du document, blocs propres au site, blocs de modules (configuration par défaut, disponibilité sur ce serveur), thèmes et polices. À lire avant d'écrire du JSON.",
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_SITE', async () => {
        const states = await getModuleStates(guildId);
        return ok({
          document: {
            root: '{ "type": "doc", "content": [ ...blocs ] }',
            textBlocks: ['paragraph', 'heading (attrs.level 1-4)', 'blockquote', 'codeBlock (attrs.language)', 'bulletList > listItem', 'orderedList > listItem', 'taskList > taskItem (attrs.checked)', 'horizontalRule', 'table > tableRow > tableHeader|tableCell'],
            inline: ['text (marks: bold, italic, underline, strike, code, link{href}, highlight{color: accent|yellow|green|blue|pink|red}, subscript, superscript)', 'hardBreak'],
            siteBlocks: {
              image: '{ type: "image", attrs: { src: "https://… ou /s/_/a/<id>.webp", alt, caption, width: small|medium|wide|full } }',
              callout: '{ type: "callout", attrs: { variant: info|success|warning|danger|note, icon: "ℹ️" }, content: [blocs] }',
              grid: '{ type: "grid", attrs: { columns: 1-4 }, content: [{ type: "gridCell", attrs: { span: 1-4, rowSpan: 1-3, surface: true }, content: [blocs] }] } (grille bento)',
              button: '{ type: "button", attrs: { label, href, variant: primary|secondary|ghost, align: left|center|right } }',
              faq: '{ type: "faq", content: [{ type: "faqItem", attrs: { question }, content: [blocs] }] }',
              video: '{ type: "video", attrs: { provider: youtube|twitch|vimeo, videoId, caption } }',
              toc: '{ type: "toc", attrs: { maxLevel: 2-4 } }',
              module: '{ type: "module", attrs: { module: <clé>, config: {…} } }',
            },
            links: 'Lien interne au site : "/~/<page>", "/~/wiki/<page>", "/~/blog/<article>" (suit le site si son adresse change). Sinon https://… ou mailto:.',
          },
          modules: Object.entries(SITE_MODULES).map(([key, spec]) => {
            const dependency = siteModuleBotDependency(key as keyof typeof SITE_MODULES, spec.defaults);
            return { key, category: spec.category, defaults: spec.defaults, needsViewer: spec.needsViewer, interactive: spec.interactive, availableOnThisServer: !dependency || states[dependency] !== false, dependsOn: dependency };
          }),
          themes: SITE_THEME_KEYS,
          fonts: SITE_FONTS,
          templates: SITE_TEMPLATES,
          navigation: '[{ id, label, target: { type: "page", pageId } | { type: "section", section: home|wiki|blog|search|me } | { type: "url", href }, children: [...] }] (deux niveaux au plus)',
        });
      }),
    );

    server.registerTool(
      'search_site_pages',
      { description: 'Recherche plein texte dans les pages publiées du site (toutes visibilités).', inputSchema: { query: z.string().min(2).max(100) }, _meta: toolMeta },
      guard('READ_SITE', async ({ query }) => {
        try {
          const site = await requireSite();
          const hits = await searchSite(site.id, query, 20);
          return ok({ results: hits.map((h) => ({ id: h.id, kind: h.kind, slug: h.slug, title: h.title, visibility: h.visibility, snippet: h.snippetHtml.replace(/<[^>]+>/g, '') })) });
        } catch (error) {
          return failure(error);
        }
      }),
    );

    server.registerTool(
      'get_site_comments',
      { description: 'Commentaires du blog, filtrables par statut (PENDING = retenus par la modération).', inputSchema: { status: z.enum(['VISIBLE', 'PENDING', 'HIDDEN']).optional() }, _meta: toolMeta },
      guard('READ_SITE', async ({ status }) => ok({ comments: await listComments(guildId, status) })),
    );

    server.registerTool(
      'get_site_analytics',
      { description: 'Fréquentation du site (sans cookie) : vues et visiteurs par jour, pages, sources, appareils, comparés à la période précédente.', inputSchema: { days: z.number().int().min(1).max(180).default(30) }, _meta: toolMeta },
      guard('READ_SITE', async ({ days }) => {
        try {
          const site = await requireSite();
          return ok({ report: await getSiteAnalytics(site.id, days) });
        } catch (error) {
          return failure(error);
        }
      }),
    );

    server.registerTool(
      'list_site_assets',
      { description: 'Images téléversées sur le site, avec leur adresse à utiliser dans les pages.', inputSchema: {}, _meta: toolMeta },
      guard('READ_SITE', async () => {
        try {
          const site = await requireSite();
          return ok({ assets: await listSiteAssets(site.id) });
        } catch (error) {
          return failure(error);
        }
      }),
    );

    server.registerTool(
      'get_site_agent_status',
      { description: "État du verrou de l'agent : qui tient la main, depuis quand, et si un humain l'a interrompu.", inputSchema: {}, _meta: toolMeta },
      guard('READ_SITE', async () => ok({ agent: getAgentLockStatus(guildId) })),
    );
  }

  // ═══════════════════════════════════════════════════════════ ÉCRITURE
  if (!shouldRegister('WRITE_SITE')) return;

  const keyName = z.string().optional().describe('Nom de la clé, pour le journal');

  server.registerTool(
    'create_site',
    {
      description: "Crée le site du serveur à partir d'un modèle (thème et ton) ; les pages sont composées d'après les modules actifs. Le site reste hors ligne jusqu'à publish_site.",
      inputSchema: { slug: z.string().optional().describe('Adresse /s/<slug> ; proposée si absente'), template: z.enum(SITE_TEMPLATES).default('general'), key_name: keyName },
      _meta: toolMeta,
    },
    guard('WRITE_SITE', async ({ slug, template, key_name }) => {
      try {
        if (!isSiteTemplate(template)) return err('Modèle inconnu.');
        lock(key_name, 'Création du site');
        const guild = client.guilds.cache.get(guildId);
        const site = await createSite(client, guildId, actorId, { slug: slug ?? (await suggestSiteSlug(guild?.name ?? guildId)), template });
        await audit(key_name, 'Site créé (MCP)', `/s/${site.slug}`, `Modèle ${template}`);
        return ok({ site: { ...site, url: siteUrl(site.slug) } });
      } catch (error) {
        return failure(error);
      }
    }),
  );

  server.registerTool(
    'update_site_settings',
    {
      description: "Réglages du site : adresse (l'ancienne redirige), nom, accroche, logo, bannière, favicon, page d'accueil, champs de la page Équipe, rôles rédacteurs du wiki/blog, salons d'annonce.",
      inputSchema: {
        slug: z.string().optional(),
        name: z.string().nullable().optional(),
        tagline: z.string().nullable().optional(),
        logo_url: z.string().nullable().optional(),
        banner_url: z.string().nullable().optional(),
        favicon_url: z.string().nullable().optional(),
        home_page_id: z.string().nullable().optional(),
        staff_page: z.object({ bio: z.boolean().optional(), absence: z.boolean().optional(), seniority: z.boolean().optional(), stats: z.boolean().optional() }).optional(),
        comments_by_default: z.boolean().optional(),
        wiki_editor_role_ids: z.array(z.string()).optional(),
        blog_editor_role_ids: z.array(z.string()).optional(),
        wiki_announce_channel_id: z.string().nullable().optional(),
        blog_announce_channel_id: z.string().nullable().optional(),
        key_name: keyName,
      },
      _meta: toolMeta,
    },
    guard('WRITE_SITE', async (args) => {
      try {
        lock(args.key_name, 'Réglages du site');
        const site = await updateSite(guildId, {
          slug: args.slug,
          name: args.name,
          tagline: args.tagline,
          logoUrl: args.logo_url,
          bannerUrl: args.banner_url,
          faviconUrl: args.favicon_url,
          homePageId: args.home_page_id,
          staffPage: args.staff_page,
          settings: args.comments_by_default === undefined ? undefined : { commentsByDefault: args.comments_by_default },
          wikiEditorRoleIds: args.wiki_editor_role_ids,
          blogEditorRoleIds: args.blog_editor_role_ids,
          wikiAnnounceChannelId: args.wiki_announce_channel_id,
          blogAnnounceChannelId: args.blog_announce_channel_id,
        });
        await audit(args.key_name, 'Réglages du site (MCP)', `/s/${site.slug}`, Object.keys(args).filter((k) => k !== 'key_name').join(', '));
        return ok({ site: { ...site, url: siteUrl(site.slug) } });
      } catch (error) {
        return failure(error);
      }
    }),
  );

  server.registerTool(
    'set_site_theme',
    {
      description: 'Thème du site et ses réglages (accent, polices, arrondis, fond) ; CSS libre facultatif, filtré par le serveur.',
      inputSchema: {
        theme: z.enum(SITE_THEME_KEYS as [string, ...string[]]).optional(),
        accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        font: z.enum(SITE_FONTS).optional(),
        heading_font: z.enum(SITE_FONTS).optional(),
        radius: z.number().int().min(0).max(28).optional(),
        background: z.enum(['plain', 'gradient', 'banner']).optional(),
        custom_css: z.string().max(30_000).nullable().optional(),
        key_name: keyName,
      },
      _meta: toolMeta,
    },
    guard('WRITE_SITE', async (args) => {
      try {
        lock(args.key_name, 'Thème du site');
        const current = await requireSite();
        const settings = { ...((current.themeSettings ?? {}) as Record<string, unknown>) };
        if (args.accent) settings.accent = args.accent;
        if (args.font) settings.font = args.font;
        if (args.heading_font) settings.headingFont = args.heading_font;
        if (args.radius !== undefined) settings.radius = args.radius;
        if (args.background) settings.background = args.background;
        const site = await updateSite(guildId, { theme: args.theme, themeSettings: settings, customCss: args.custom_css });
        await audit(args.key_name, 'Thème du site (MCP)', `/s/${site.slug}`, site.theme);
        return ok({ theme: site.theme, themeSettings: site.themeSettings, customCss: site.customCss });
      } catch (error) {
        return failure(error);
      }
    }),
  );

  server.registerTool(
    'set_site_navigation',
    {
      description: 'Remplace le menu du site (deux niveaux au plus). Format dans get_site_reference.',
      inputSchema: { items: z.array(z.record(z.any())), key_name: keyName },
      _meta: toolMeta,
    },
    guard('WRITE_SITE', async ({ items, key_name }) => {
      try {
        lock(key_name, 'Menu du site');
        const site = await updateSite(guildId, { navigation: items });
        await audit(key_name, 'Menu du site (MCP)', `/s/${site.slug}`, `${(site.navigation as unknown[]).length} entrées`);
        return ok({ navigation: site.navigation });
      } catch (error) {
        return failure(error);
      }
    }),
  );

  server.registerTool(
    'publish_site',
    { description: 'Met le site en ligne, ou hors ligne.', inputSchema: { published: z.boolean(), key_name: keyName }, _meta: toolMeta },
    guard('WRITE_SITE', async ({ published, key_name }) => {
      try {
        lock(key_name, published ? 'Mise en ligne du site' : 'Mise hors ligne du site');
        const site = await updateSite(guildId, { published });
        await audit(key_name, published ? 'Site mis en ligne (MCP)' : 'Site mis hors ligne (MCP)', `/s/${site.slug}`, '');
        return ok({ published: site.published, url: siteUrl(site.slug) });
      } catch (error) {
        return failure(error);
      }
    }),
  );

  server.registerTool(
    'create_site_page',
    {
      description: 'Crée une page libre, une page du wiki ou un article. Contenu en Markdown (markdown) ou en document JSON (content). publish: true la publie aussitôt.',
      inputSchema: {
        kind: z.enum(KINDS),
        title: z.string().min(1).max(140),
        slug: z.string().optional(),
        parent_id: z.string().optional().describe('Wiki : page parente'),
        markdown: z.string().max(200_000).optional(),
        content: documentSchema.optional(),
        publish: z.boolean().default(false),
        key_name: keyName,
      },
      _meta: toolMeta,
    },
    guard('WRITE_SITE', async ({ kind, title, slug, parent_id, markdown, content, publish, key_name }) => {
      try {
        lock(key_name, `Création de « ${title} »`);
        const site = await requireSite();
        const doc = readContent(markdown, content) ?? undefined;
        const page = await createPage(site, actorId, { kind, title, slug, parentId: parent_id, content: doc });
        lock(key_name, `Création de « ${title} »`, page.id);
        if (publish) await publishPage(client, guildId, page.id, actorId, 'Publiée par un agent');
        await audit(key_name, 'Page du site créée (MCP)', `/s/${site.slug}`, `${kind} ${page.slug}${publish ? ' (publiée)' : ''}`);
        return ok({ page: { ...page, url: pagePublicUrl(site.slug, page), published: publish } });
      } catch (error) {
        return failure(error);
      }
    }),
  );

  server.registerTool(
    'update_site_page',
    {
      description:
        "Modifie une page : réglages (titre, adresse, résumé, étiquettes, visibilité, parent, couverture, icône, commentaires, référencement) et/ou contenu complet (markdown ou content remplace tout le brouillon). Les modifications restent en brouillon jusqu'à publish_site_page.",
      inputSchema: {
        page_id: z.string(),
        title: z.string().max(140).optional(),
        slug: z.string().optional(),
        excerpt: z.string().max(400).nullable().optional(),
        tags: z.array(z.string()).optional(),
        visibility: z.enum(['PUBLIC', 'MEMBERS', 'ROLES', 'STAFF']).optional(),
        visible_role_ids: z.array(z.string()).optional(),
        parent_id: z.string().nullable().optional(),
        cover_url: z.string().nullable().optional(),
        icon: z.string().nullable().optional(),
        comments_enabled: z.boolean().optional(),
        seo_title: z.string().nullable().optional(),
        seo_description: z.string().nullable().optional(),
        markdown: z.string().max(200_000).optional(),
        content: documentSchema.optional(),
        key_name: keyName,
      },
      _meta: toolMeta,
    },
    guard('WRITE_SITE', async (args) => {
      try {
        const site = await requireSite();
        lock(args.key_name, `Modification d'une page`, args.page_id);
        const doc = readContent(args.markdown, args.content);
        const page = await updatePage(
          site,
          args.page_id,
          {
            title: args.title,
            slug: args.slug,
            excerpt: args.excerpt,
            tags: args.tags,
            visibility: args.visibility,
            visibleRoleIds: args.visible_role_ids,
            parentId: args.parent_id,
            coverUrl: args.cover_url,
            icon: args.icon,
            commentsEnabled: args.comments_enabled,
            seoTitle: args.seo_title,
            seoDescription: args.seo_description,
            ...(doc ? { draftContent: doc } : {}),
          },
          actorId,
        );
        // Les éditeurs connectés repartent du brouillon que l'agent vient d'écrire.
        if (doc) await resetCollabRoom(args.page_id);
        await audit(args.key_name, 'Page du site modifiée (MCP)', `/s/${site.slug}`, `${page.slug}${doc ? ' (contenu)' : ''}`);
        return ok({ page });
      } catch (error) {
        return failure(error);
      }
    }),
  );

  server.registerTool(
    'append_site_blocks',
    {
      description: 'Ajoute du contenu à une page sans réécrire le reste : en Markdown ou en blocs JSON, au début, à la fin ou à un rang donné.',
      inputSchema: {
        page_id: z.string(),
        markdown: z.string().max(100_000).optional(),
        blocks: z.array(z.record(z.any())).optional().describe('Blocs du document (voir get_site_reference)'),
        position: z.union([z.literal('start'), z.literal('end'), z.number().int().min(0)]).default('end'),
        key_name: keyName,
      },
      _meta: toolMeta,
    },
    guard('WRITE_SITE', async ({ page_id, markdown, blocks, position, key_name }) => {
      try {
        const site = await requireSite();
        lock(key_name, 'Ajout de contenu', page_id);
        await flushCollabRoom(page_id);
        const page = await getAdminPage(site.id, page_id);
        if (!page) return err('Page introuvable.');
        const current = normalizeSiteDocument(page.draftContent);
        const added = markdown !== undefined ? markdownToSiteDocument(markdown).content : normalizeSiteDocument({ type: 'doc', content: blocks ?? [] }).content;
        if (added.length === 0) return err('Rien à ajouter (contenu vide ou refusé par la liste blanche).');
        const at = position === 'start' ? 0 : position === 'end' ? current.content.length : Math.min(position, current.content.length);
        const next: SiteNode[] = [...current.content.slice(0, at), ...added, ...current.content.slice(at)];
        await updatePage(site, page_id, { draftContent: { type: 'doc', content: next } }, actorId);
        await resetCollabRoom(page_id);
        await audit(key_name, 'Contenu ajouté à une page (MCP)', `/s/${site.slug}`, `${page.slug} : ${added.length} bloc(s)`);
        return ok({ added: added.length, totalBlocks: next.length });
      } catch (error) {
        return failure(error);
      }
    }),
  );

  server.registerTool(
    'add_site_module_block',
    {
      description: "Insère un bloc de module (équipe, règlement, classement, giveaways, ticket…) dans une page. Clés et configurations dans get_site_reference.",
      inputSchema: {
        page_id: z.string(),
        module: z.string(),
        config: z.record(z.any()).default({}),
        position: z.union([z.literal('start'), z.literal('end'), z.number().int().min(0)]).default('end'),
        key_name: keyName,
      },
      _meta: toolMeta,
    },
    guard('WRITE_SITE', async ({ page_id, module, config, position, key_name }) => {
      try {
        if (!isSiteModuleKey(module)) return err(`Module inconnu : ${module}. Liste dans get_site_reference.`);
        const site = await requireSite();
        lock(key_name, `Ajout du bloc ${module}`, page_id);
        await flushCollabRoom(page_id);
        const page = await getAdminPage(site.id, page_id);
        if (!page) return err('Page introuvable.');
        const current = normalizeSiteDocument(page.draftContent);
        const block: SiteNode = { type: 'module', attrs: { module, config: normalizeModuleConfig(module, config) } };
        const at = position === 'start' ? 0 : position === 'end' ? current.content.length : Math.min(position, current.content.length);
        await updatePage(site, page_id, { draftContent: { type: 'doc', content: [...current.content.slice(0, at), block, ...current.content.slice(at)] } }, actorId);
        await resetCollabRoom(page_id);
        await audit(key_name, 'Bloc de module ajouté (MCP)', `/s/${site.slug}`, `${page.slug} : ${module}`);
        return ok({ block });
      } catch (error) {
        return failure(error);
      }
    }),
  );

  server.registerTool(
    'publish_site_page',
    { description: 'Publie le brouillon d\'une page (crée une version dans l\'historique). Refusé si la page renvoie vers une arnaque connue.', inputSchema: { page_id: z.string(), note: z.string().max(200).optional(), key_name: keyName }, _meta: toolMeta },
    guard('WRITE_SITE', async ({ page_id, note, key_name }) => {
      try {
        const site = await requireSite();
        lock(key_name, 'Publication d\'une page', page_id);
        await flushCollabRoom(page_id);
        const page = await publishPage(client, guildId, page_id, actorId, note ?? 'Publiée par un agent');
        await audit(key_name, 'Page du site publiée (MCP)', `/s/${site.slug}`, page.slug);
        return ok({ page });
      } catch (error) {
        return failure(error);
      }
    }),
  );

  server.registerTool(
    'unpublish_site_page',
    { description: 'Retire une page du site publié (le brouillon reste).', inputSchema: { page_id: z.string(), key_name: keyName }, _meta: toolMeta },
    guard('WRITE_SITE', async ({ page_id, key_name }) => {
      try {
        lock(key_name, 'Dépublication d\'une page', page_id);
        await unpublishPage(guildId, page_id);
        await audit(key_name, 'Page du site dépubliée (MCP)', page_id, '');
        return ok({ ok: true });
      } catch (error) {
        return failure(error);
      }
    }),
  );

  server.registerTool(
    'schedule_site_page',
    { description: 'Programme la publication du brouillon (ISO 8601), ou l\'annule avec at: null.', inputSchema: { page_id: z.string(), at: z.string().nullable(), key_name: keyName }, _meta: toolMeta },
    guard('WRITE_SITE', async ({ page_id, at, key_name }) => {
      try {
        lock(key_name, 'Programmation d\'une page', page_id);
        const when = await schedulePage(guildId, page_id, at);
        await audit(key_name, 'Publication programmée (MCP)', page_id, when ? when.toISOString() : 'annulée');
        return ok({ scheduledAt: when });
      } catch (error) {
        return failure(error);
      }
    }),
  );

  server.registerTool(
    'restore_site_page_revision',
    { description: "Remet une version de l'historique en brouillon (à republier ensuite).", inputSchema: { page_id: z.string(), revision_id: z.string(), key_name: keyName }, _meta: toolMeta },
    guard('WRITE_SITE', async ({ page_id, revision_id, key_name }) => {
      try {
        lock(key_name, 'Restauration d\'une version', page_id);
        await restoreRevision(guildId, page_id, revision_id, actorId);
        await resetCollabRoom(page_id);
        await audit(key_name, 'Version restaurée (MCP)', page_id, revision_id);
        return ok({ ok: true });
      } catch (error) {
        return failure(error);
      }
    }),
  );

  server.registerTool(
    'delete_site_page',
    { description: 'Supprime définitivement une page (ses sous-pages remontent d\'un niveau). Exige confirm: true.', inputSchema: { page_id: z.string(), confirm: z.literal(true), key_name: keyName }, _meta: toolMeta },
    guard('WRITE_SITE', async ({ page_id, key_name }) => {
      try {
        const site = await requireSite();
        lock(key_name, 'Suppression d\'une page', page_id);
        await resetCollabRoom(page_id);
        await deletePage(site, page_id);
        await audit(key_name, 'Page du site supprimée (MCP)', `/s/${site.slug}`, page_id);
        return ok({ ok: true });
      } catch (error) {
        return failure(error);
      }
    }),
  );

  server.registerTool(
    'reorder_site_pages',
    { description: "Ordre des pages d'un type (et, pour le wiki, au sein de leur parent) : liste complète des identifiants dans l'ordre voulu.", inputSchema: { kind: z.enum(KINDS), page_ids: z.array(z.string()).min(1), key_name: keyName }, _meta: toolMeta },
    guard('WRITE_SITE', async ({ kind, page_ids, key_name }) => {
      try {
        const site = await requireSite();
        lock(key_name, 'Réorganisation des pages');
        const owned = await prisma.sitePage.count({ where: { siteId: site.id, kind, id: { in: page_ids } } });
        if (owned !== page_ids.length) return err('Des identifiants ne sont pas des pages de ce type sur ce site.');
        await reorderPages(site.id, guildId, page_ids);
        await audit(key_name, 'Pages réordonnées (MCP)', `/s/${site.slug}`, kind);
        return ok({ ok: true });
      } catch (error) {
        return failure(error);
      }
    }),
  );

  server.registerTool(
    'moderate_site_comment',
    { description: 'Affiche, masque ou supprime un commentaire du blog.', inputSchema: { comment_id: z.string(), action: z.enum(['show', 'hide', 'delete']), key_name: keyName }, _meta: toolMeta },
    guard('WRITE_SITE', async ({ comment_id, action, key_name }) => {
      try {
        lock(key_name, 'Modération des commentaires');
        if (action === 'delete') await deleteComment(guildId, comment_id);
        else await setCommentStatus(guildId, comment_id, action === 'show' ? 'VISIBLE' : 'HIDDEN');
        await audit(key_name, 'Commentaire modéré (MCP)', comment_id, action);
        return ok({ ok: true });
      } catch (error) {
        return failure(error);
      }
    }),
  );

  server.registerTool(
    'import_site_image',
    {
      description: "Importe une image depuis une URL https publique dans la bibliothèque du site (réencodée, métadonnées retirées). Renvoie l'adresse à utiliser dans les pages.",
      inputSchema: { url: z.string().url(), file_name: z.string().max(120).optional(), key_name: keyName },
      _meta: toolMeta,
    },
    guard('WRITE_SITE', async ({ url, file_name, key_name }) => {
      try {
        const site = await requireSite();
        lock(key_name, 'Import d\'une image');
        const safe = await assertWebhookUrlReachable(url);
        // Pas de redirection suivie : elle pourrait mener vers une adresse interne.
        const res = await fetch(safe, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
        if (!res.ok) return err(`Téléchargement impossible (HTTP ${res.status}).`);
        const length = Number(res.headers.get('content-length') ?? 0);
        if (length > SITE_UPLOAD_MAX_BYTES) return err('Image trop lourde.');
        const bytes = new Uint8Array(await res.arrayBuffer());
        const result = await storeSiteAsset(site, { bytes, fileName: file_name ?? new URL(safe).pathname.split('/').pop() ?? 'image', uploadedById: actorId });
        if (!result.ok) return err(`Image refusée : ${result.error}`);
        await audit(key_name, 'Image importée sur le site (MCP)', `/s/${site.slug}`, result.asset.url);
        return ok({ asset: result.asset });
      } catch (error) {
        return failure(error);
      }
    }),
  );

  server.registerTool(
    'create_site_preview_link',
    { description: "Lien d'aperçu du brouillon d'une page, valable 7 jours, sans compte.", inputSchema: { page_id: z.string() }, _meta: toolMeta },
    guard('WRITE_SITE', async ({ page_id }) => {
      try {
        const site = await requireSite();
        const page = await getAdminPage(site.id, page_id);
        if (!page) return err('Page introuvable.');
        await flushCollabRoom(page_id);
        const { token, expiresAt } = createPreviewToken(page.id);
        return ok({ url: `${siteUrl(site.slug)}/preview/${token}`, expiresAt });
      } catch (error) {
        return failure(error);
      }
    }),
  );

  server.registerTool(
    'release_site_lock',
    { description: "Rend la main aux humains une fois les modifications terminées (sinon le verrou tombe seul après 90 s d'inactivité).", inputSchema: { key_name: keyName }, _meta: toolMeta },
    guard('WRITE_SITE', async ({ key_name }) => {
      const released = releaseAgentLock(guildId);
      if (released) await audit(key_name, 'Main rendue sur le site (MCP)', guildId, '');
      return ok({ released });
    }),
  );

  server.registerTool(
    'delete_site',
    { description: 'Supprime définitivement le site, ses pages, ses images et ses statistiques. Exige confirm_slug égal à l\'adresse actuelle.', inputSchema: { confirm_slug: z.string(), key_name: keyName }, _meta: toolMeta },
    guard('WRITE_SITE', async ({ confirm_slug, key_name }) => {
      try {
        const site = await requireSite();
        if (confirm_slug !== site.slug) return err('confirm_slug ne correspond pas à l\'adresse du site.');
        lock(key_name, 'Suppression du site');
        await deleteSite(guildId);
        releaseAgentLock(guildId);
        await audit(key_name, 'Site supprimé (MCP)', `/s/${site.slug}`, '');
        return ok({ ok: true });
      } catch (error) {
        return failure(error);
      }
    }),
  );

}
