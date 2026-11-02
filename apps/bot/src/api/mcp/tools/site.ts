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
  SITE_BACKGROUNDS,
  SITE_COLOR_MODES,
  SITE_THEME_KEYS,
  SITE_VOTE_PROVIDERS,
  siteModuleBotDependency,
  sectionizeSiteDocument,
  SITE_SECTION_ALIGNS,
  SITE_SECTION_ANIMATIONS,
  SITE_SECTION_BACKGROUNDS,
  SITE_SECTION_DEFAULTS,
  SITE_SECTION_GRADIENTS,
  SITE_SECTION_HEIGHTS,
  SITE_SECTION_LAYOUTS,
  SITE_SECTION_PADDINGS,
  SITE_SECTION_VISIBILITY,
  SITE_SECTION_WIDTHS,
  type SiteDocument,
  type SiteNode,
} from '@kotbo/shared';
import prisma from '../../../utils/db.js';
import { getApiUrl, getDashboardUrl } from '../../shared.js';
import { type McpToolContext, err, ok, toolError } from '../toolkit.js';
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
import { createPreviewToken, createSitePreviewToken } from '../../../services/site/sitePreview.js';
import { ensureInstantSite } from '../../../services/site/siteInstantService.js';
import { isSiteTemplate, SITE_TEMPLATES } from '../../../services/site/siteTemplates.js';
import { assertWebhookUrlReachable } from '../../../services/integrations/outgoingWebhookSecurity.js';
import { deleteVoteSite, listAdminVoteSites, saveVoteSite, SiteVoteError, topVoters } from '../../../services/site/siteVoteService.js';
import { acceptForumAnswer, deleteForumCategory, deleteForumPost, ForumError, listForumCategories, listRecentForumPosts, saveForumCategory, setForumTopicFlags } from '../../../services/site/siteForumService.js';

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
  if (error instanceof SiteVoteError) return err(error.code, { code: error.code });
  if (error instanceof ForumError) return err(error.code, { code: error.code });
  return toolError(error);
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
          // Brouillon vu en sections : les rangs donnés aux outils *_site_section sont ceux-là.
          const doc = version === 'draft' ? sectionizeSiteDocument(normalizeSiteDocument(raw)) : normalizeSiteDocument(raw);
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
            root: '{ "type": "doc", "content": [ ...sections ] } : une page est une pile de sections (bandes), chacune en colonnes de blocs. Des blocs posés hors section sont regroupés dans des sections neutres à l\'enregistrement.',
            section: `{ type: "section", attrs: { layout: ${SITE_SECTION_LAYOUTS.join('|')} (part de chaque colonne), background: ${SITE_SECTION_BACKGROUNDS.join('|')}, bgColor: "#rrggbb", bgImage: "https://… ou /s/_/a/<id>.webp", bgGradient: ${SITE_SECTION_GRADIENTS.join('|')}, overlay: 0-80 (assombrit l'image), padding: ${SITE_SECTION_PADDINGS.join('|')}, width: contained|full (fond bord à bord)|edge (tout bord à bord), height: ${SITE_SECTION_HEIGHTS.join('|')}, align: ${SITE_SECTION_ALIGNS.join('|')}, animation: ${SITE_SECTION_ANIMATIONS.join('|')}, visibleOn: ${SITE_SECTION_VISIBILITY.join('|')}, anchor: "rejoindre" (lien #rejoindre) }, content: [{ type: "column", content: [blocs] }, …] } (1 à 4 colonnes ; outils add/update/move/delete_site_section)`,
            textBlocks: ['paragraph', 'heading (attrs.level 1-4)', 'blockquote', 'codeBlock (attrs.language)', 'bulletList > listItem', 'orderedList > listItem', 'taskList > taskItem (attrs.checked)', 'horizontalRule', 'table > tableRow > tableHeader|tableCell'],
            inline: ['text (marks: bold, italic, underline, strike, code, link{href}, highlight{color: accent|yellow|green|blue|pink|red}, subscript, superscript)', 'hardBreak'],
            siteBlocks: {
              image: '{ type: "image", attrs: { src: "https://… ou /s/_/a/<id>.webp", alt, caption, width: small|medium|wide|full } }',
              callout: '{ type: "callout", attrs: { variant: info|success|warning|danger|note }, content: [blocs] } (pictogramme selon la variante)',
              grid: '{ type: "grid", attrs: { columns: 1-4 }, content: [{ type: "gridCell", attrs: { span: 1-4, rowSpan: 1-3, surface: true }, content: [blocs] }] } (grille bento)',
              button: '{ type: "button", attrs: { label, href, variant: primary|secondary|ghost, align: left|center|right } }',
              faq: '{ type: "faq", content: [{ type: "faqItem", attrs: { question }, content: [blocs] }] }',
              video: '{ type: "video", attrs: { provider: youtube|twitch|vimeo, videoId, caption } }',
              toc: '{ type: "toc", attrs: { maxLevel: 2-4 } }',
              module: '{ type: "module", attrs: { module: <clé>, config: {…} } }',
              banner: '{ type: "banner", attrs: { image: "https://… ou /s/_/a/<id>.webp" (facultatif, assombrie), tone: surface|accent|dark, align: left|center, tall: false }, content: [blocs : titre, texte, bouton…] } (bannière d\'appel)',
              gallery: '{ type: "gallery", attrs: { images: [{ src, alt, caption }] (24 au plus), layout: grid|carousel, columns: 2-4 } }',
              testimonials: '{ type: "testimonials", attrs: { columns: 1-3 }, content: [{ type: "testimonial", attrs: { name, role, avatar }, content: [blocs : la citation] }] }',
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
      'get_site_votes',
      {
        description:
          "Sites de vote du serveur (top.gg, annuaires) : lien, délai entre deux votes, votes des 30 derniers jours, adresse du webhook top.gg, et les meilleurs votants du mois. Le secret du webhook n'est visible que dans le dashboard.",
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_SITE', async () => {
        const [sites, top] = await Promise.all([listAdminVoteSites(guildId, getApiUrl()), topVoters(guildId, 10)]);
        return ok({
          voteSites: sites.map(({ webhookSecret, ...site }) => ({ ...site, hasWebhookSecret: Boolean(webhookSecret) })),
          topVoters: top,
          providers: Object.entries(SITE_VOTE_PROVIDERS).map(([key, spec]) => ({ key, ...spec })),
        });
      }),
    );

    server.registerTool(
      'get_site_forum',
      { description: 'Forum du site : catégories (propres au site ou miroir d’un salon forum Discord) et derniers messages, pour la modération.', inputSchema: {}, _meta: toolMeta },
      guard('READ_SITE', async () => {
        try {
          const site = await requireSite();
          const [categories, recent] = await Promise.all([listForumCategories(site.id), listRecentForumPosts(guildId, 30)]);
          return ok({ categories, recent });
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
    'create_instant_site',
    {
      description:
        "Crée le site sans question, comme à l'arrivée du bot : type de communauté deviné d'après le serveur, adresse tirée du nom, salons d'annonces repérés et leurs derniers messages repris en articles, forums Discord publics recopiés. Hors ligne jusqu'à publish_site ; rend le site existant s'il y en a déjà un.",
      inputSchema: { key_name: keyName },
      _meta: toolMeta,
    },
    guard('WRITE_SITE', async ({ key_name }) => {
      try {
        lock(key_name, 'Création du site');
        const result = await ensureInstantSite(client, guildId, actorId);
        if (!result) return err('Serveur introuvable sur cette instance du bot.');
        if (result.created) await audit(key_name, 'Site instantané créé (MCP)', `/s/${result.slug}`, `Modèle ${result.template}, ${result.articles} article(s) repris`);
        return ok({ ...result, url: siteUrl(result.slug) });
      } catch (error) {
        return failure(error);
      }
    }),
  );

  server.registerTool(
    'update_site_settings',
    {
      description: "Réglages du site : adresse (l'ancienne redirige), nom, accroche, logo, bannière, favicon, page d'accueil, champs de la page Équipe, rôles rédacteurs du wiki/blog, salons d'annonce, récompenses de l'activité (pièces et XP pour la visite du jour, la participation, la lecture et le vote, plafonds et bonus de série).",
      inputSchema: {
        slug: z.string().optional(),
        name: z.string().nullable().optional(),
        tagline: z.string().nullable().optional(),
        logo_url: z.string().nullable().optional(),
        banner_url: z.string().nullable().optional(),
        favicon_url: z.string().nullable().optional(),
        home_page_id: z.string().nullable().optional(),
        comments_by_default: z.boolean().optional(),
        hero_pulse: z.boolean().optional().describe("Pouls du serveur en direct dans la bannière d'accueil (vrai par défaut)"),
        legacy_redirect: z
          .boolean()
          .optional()
          .describe("Anciens liens (formulaire de débannissement, formulaires, classements, giveaways, clans, actualités) renvoyés vers la page du site équivalente (vrai par défaut). Faux : les liens mènent aux pages d'origine."),
        wiki_editor_role_ids: z.array(z.string()).optional(),
        blog_editor_role_ids: z.array(z.string()).optional(),
        wiki_announce_channel_id: z.string().nullable().optional(),
        blog_announce_channel_id: z.string().nullable().optional(),
        rewards_enabled: z
          .boolean()
          .optional()
          .describe("Récompenses de l'activité sur le site (visite du jour, participation, lecture, vote) en monnaie du bot et en XP, montants fixes (vrai par défaut)"),
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
          settings:
            args.comments_by_default === undefined && args.hero_pulse === undefined && args.legacy_redirect === undefined
              ? undefined
              : {
                  ...(args.comments_by_default === undefined ? {} : { commentsByDefault: args.comments_by_default }),
                  ...(args.hero_pulse === undefined ? {} : { heroPulse: args.hero_pulse }),
                  ...(args.legacy_redirect === undefined ? {} : { legacyRedirect: args.legacy_redirect }),
                },
          wikiEditorRoleIds: args.wiki_editor_role_ids,
          blogEditorRoleIds: args.blog_editor_role_ids,
          wikiAnnounceChannelId: args.wiki_announce_channel_id,
          blogAnnounceChannelId: args.blog_announce_channel_id,
          rewards: args.rewards_enabled === undefined ? undefined : { enabled: args.rewards_enabled },
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
      description: 'Thème du site et ses réglages (accent, polices, arrondis, fond, mode clair/sombre par défaut) ; CSS libre facultatif, filtré par le serveur. Le visiteur peut toujours changer de mode.',
      inputSchema: {
        theme: z.enum(SITE_THEME_KEYS as [string, ...string[]]).optional(),
        accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        font: z.enum(SITE_FONTS).optional(),
        heading_font: z.enum(SITE_FONTS).optional(),
        radius: z.number().int().min(0).max(24).optional(),
        background: z.enum(SITE_BACKGROUNDS).optional(),
        mode: z.enum(SITE_COLOR_MODES).optional(),
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
        if (args.mode) settings.mode = args.mode;
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

  // ─── Sections (bandes à colonnes) ──────────────────────────────────────

  const sectionStyle = {
    layout: z.enum(SITE_SECTION_LAYOUTS).optional().describe('Part de chaque colonne ; par défaut selon le nombre de colonnes'),
    background: z.enum(SITE_SECTION_BACKGROUNDS).optional(),
    bg_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('Avec background: color'),
    bg_image: z.string().max(2000).optional().describe('Avec background: image ; https://… ou /s/_/a/<id>.webp (import_site_image)'),
    bg_gradient: z.enum(SITE_SECTION_GRADIENTS).optional().describe('Avec background: gradient'),
    overlay: z.number().int().min(0).max(80).optional().describe("Assombrissement de l'image de fond, en %"),
    padding: z.enum(SITE_SECTION_PADDINGS).optional(),
    width: z.enum(SITE_SECTION_WIDTHS).optional().describe('contained : dans la colonne du site ; full : fond bord à bord ; edge : tout bord à bord'),
    height: z.enum(SITE_SECTION_HEIGHTS).optional(),
    align: z.enum(SITE_SECTION_ALIGNS).optional(),
    animation: z.enum(SITE_SECTION_ANIMATIONS).optional(),
    visible_on: z.enum(SITE_SECTION_VISIBILITY).optional(),
    anchor: z.string().max(60).optional().describe('Ancre pour les liens #ancre ; vide pour retirer'),
  };
  const columnsSchema = z
    .array(z.object({ markdown: z.string().max(50_000).optional(), blocks: z.array(z.record(z.any())).optional() }))
    .min(1)
    .max(4)
    .describe('Contenu de chaque colonne, en Markdown ou en blocs JSON (voir get_site_reference)');

  type SectionStyleInput = { [K in keyof typeof sectionStyle]?: z.infer<(typeof sectionStyle)[K]> };

  function styleAttrs(input: SectionStyleInput): Record<string, unknown> {
    const map: Record<string, unknown> = {
      layout: input.layout,
      background: input.background,
      bgColor: input.bg_color,
      bgImage: input.bg_image,
      bgGradient: input.bg_gradient,
      overlay: input.overlay,
      padding: input.padding,
      width: input.width,
      height: input.height,
      align: input.align,
      animation: input.animation,
      visibleOn: input.visible_on,
      anchor: input.anchor,
    };
    return Object.fromEntries(Object.entries(map).filter(([, value]) => value !== undefined));
  }

  function columnNodes(columns: z.infer<typeof columnsSchema>): SiteNode[] {
    return columns.map((column) => {
      const blocks = (column.markdown !== undefined ? markdownToSiteDocument(column.markdown).content : normalizeSiteDocument({ type: 'doc', content: column.blocks ?? [] }).content).filter(
        (node) => node.type !== 'section',
      );
      return { type: 'column', content: blocks.length > 0 ? blocks : [{ type: 'paragraph' }] };
    });
  }

  /** Brouillon lu en sections, transformé par `change`, réécrit ; l'édition à plusieurs repart de lui. */
  async function editSections(pageId: string, keyName: string | undefined, activity: string, change: (sections: SiteNode[]) => SiteNode[]) {
    const site = await requireSite();
    lock(keyName, activity, pageId);
    await flushCollabRoom(pageId);
    const page = await getAdminPage(site.id, pageId);
    if (!page) throw new SiteAdminError('page_missing', 404, 'Page introuvable.');
    const sections = change(sectionizeSiteDocument(normalizeSiteDocument(page.draftContent)).content);
    await updatePage(site, pageId, { draftContent: { type: 'doc', content: sections } }, actorId);
    await resetCollabRoom(pageId);
    return { site, page, sections };
  }

  function checkIndex(sections: SiteNode[], index: number) {
    if (index >= sections.length) throw new SiteAdminError('section_missing', 404, `La page a ${sections.length} section(s), numérotées à partir de 0.`);
  }

  server.registerTool(
    'add_site_section',
    {
      description:
        "Ajoute une section (bande pleine largeur à 1-4 colonnes) à une page : contenu de chaque colonne, fond (couleur, image, dégradé), espacements, largeur, hauteur, animation d'apparition, visibilité mobile/ordinateur.",
      inputSchema: {
        page_id: z.string(),
        columns: columnsSchema,
        position: z.union([z.literal('start'), z.literal('end'), z.number().int().min(0)]).default('end'),
        ...sectionStyle,
        key_name: keyName,
      },
      _meta: toolMeta,
    },
    guard('WRITE_SITE', async ({ page_id, columns, position, key_name, ...style }) => {
      try {
        let at = 0;
        const { site, page, sections } = await editSections(page_id, key_name, 'Ajout d\'une section', (current) => {
          // Une page neuve n'a qu'une section vide : la nouvelle la remplace.
          const blank = current.length === 1 && JSON.stringify(current[0].content) === JSON.stringify([{ type: 'column', content: [{ type: 'paragraph' }] }]);
          const base = blank ? [] : current;
          const section: SiteNode = { type: 'section', attrs: { ...SITE_SECTION_DEFAULTS, ...styleAttrs(style) }, content: columnNodes(columns) };
          at = position === 'start' ? 0 : position === 'end' ? base.length : Math.min(position, base.length);
          return [...base.slice(0, at), section, ...base.slice(at)];
        });
        await audit(key_name, 'Section ajoutée à une page (MCP)', `/s/${site.slug}`, `${page.slug} : section ${at}`);
        return ok({ index: at, totalSections: sections.length });
      } catch (error) {
        return failure(error);
      }
    }),
  );

  server.registerTool(
    'update_site_section',
    {
      description:
        "Modifie une section d'une page (rang à partir de 0, voir get_site_page) : son style, et/ou le contenu de ses colonnes. Une disposition à moins de colonnes fusionne les colonnes en trop dans la dernière ; à plus, ajoute des colonnes vides.",
      inputSchema: {
        page_id: z.string(),
        index: z.number().int().min(0),
        columns: columnsSchema.optional().describe('Remplace le contenu de toutes les colonnes'),
        ...sectionStyle,
        key_name: keyName,
      },
      _meta: toolMeta,
    },
    guard('WRITE_SITE', async ({ page_id, index, columns, key_name, ...style }) => {
      try {
        const { site, page } = await editSections(page_id, key_name, 'Modification d\'une section', (current) => {
          checkIndex(current, index);
          const section = current[index];
          let content = columns ? columnNodes(columns) : [...(section.content ?? [])];
          const wanted = style.layout?.split('-').length;
          if (wanted && wanted !== content.length) {
            if (wanted < content.length) {
              const merged = content.slice(wanted - 1).flatMap((column) => column.content ?? []);
              content = [...content.slice(0, wanted - 1), { type: 'column', content: merged }];
            } else {
              content = [...content, ...Array.from({ length: wanted - content.length }, () => ({ type: 'column', content: [{ type: 'paragraph' }] }))];
            }
          }
          const next = [...current];
          next[index] = { type: 'section', attrs: { ...section.attrs, ...styleAttrs(style) }, content };
          return next;
        });
        await audit(key_name, 'Section modifiée (MCP)', `/s/${site.slug}`, `${page.slug} : section ${index}`);
        return ok({ index });
      } catch (error) {
        return failure(error);
      }
    }),
  );

  server.registerTool(
    'move_site_section',
    { description: "Déplace une section d'une page à un autre rang (à partir de 0).", inputSchema: { page_id: z.string(), from: z.number().int().min(0), to: z.number().int().min(0), key_name: keyName }, _meta: toolMeta },
    guard('WRITE_SITE', async ({ page_id, from, to, key_name }) => {
      try {
        const { site, page } = await editSections(page_id, key_name, 'Déplacement d\'une section', (current) => {
          checkIndex(current, from);
          const next = [...current];
          const [moved] = next.splice(from, 1);
          next.splice(Math.min(to, next.length), 0, moved);
          return next;
        });
        await audit(key_name, 'Section déplacée (MCP)', `/s/${site.slug}`, `${page.slug} : ${from} → ${to}`);
        return ok({ from, to });
      } catch (error) {
        return failure(error);
      }
    }),
  );

  server.registerTool(
    'delete_site_section',
    { description: "Supprime une section d'une page et tout son contenu (le brouillon seulement ; la version publiée reste jusqu'à la prochaine publication).", inputSchema: { page_id: z.string(), index: z.number().int().min(0), key_name: keyName }, _meta: toolMeta },
    guard('WRITE_SITE', async ({ page_id, index, key_name }) => {
      try {
        const { site, page, sections } = await editSections(page_id, key_name, 'Suppression d\'une section', (current) => {
          checkIndex(current, index);
          return current.filter((_, i) => i !== index);
        });
        await audit(key_name, 'Section supprimée (MCP)', `/s/${site.slug}`, `${page.slug} : section ${index}`);
        return ok({ totalSections: sections.length });
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
    {
      description: "Lien d'aperçu valable 7 jours, sans compte : le brouillon d'une page (page_id), ou le site entier tant qu'il n'est pas en ligne (sans page_id).",
      inputSchema: { page_id: z.string().optional() },
      _meta: toolMeta,
    },
    guard('WRITE_SITE', async ({ page_id }) => {
      try {
        const site = await requireSite();
        if (!page_id) {
          if (site.published) return ok({ url: siteUrl(site.slug), published: true });
          const { token, expiresAt } = createSitePreviewToken(site.id);
          return ok({ url: `${siteUrl(site.slug)}?apercu=${encodeURIComponent(token)}`, expiresAt });
        }
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
    'save_site_vote_site',
    {
      description:
        "Ajoute ou modifie un site de vote. provider : voir get_site_votes ; vote_url doit pointer vers le site choisi. Les annuaires vérifiés par compte ou par IP demandent une clé (verification_key) si elle ne figure pas dans le lien ; top.gg n'en demande pas (webhook à configurer depuis le dashboard).",
      inputSchema: {
        id: z.string().optional().describe('Site de vote à modifier ; absent pour en ajouter un'),
        provider: z.enum(Object.keys(SITE_VOTE_PROVIDERS) as [string, ...string[]]).optional().describe('Obligatoire à la création, non modifiable ensuite'),
        vote_url: z.string().optional(),
        label: z.string().optional(),
        verification_key: z.string().nullable().optional().describe('Clé ou identifiant fourni par le site de vote'),
        cooldown_hours: z.number().int().min(1).max(48).optional(),
        enabled: z.boolean().optional(),
        key_name: keyName,
      },
      _meta: toolMeta,
    },
    guard('WRITE_SITE', async (args) => {
      try {
        const saved = await saveVoteSite(guildId, args.id ?? null, {
          provider: args.provider,
          voteUrl: args.vote_url,
          label: args.label,
          verificationKey: args.verification_key,
          cooldownHours: args.cooldown_hours,
          enabled: args.enabled,
        });
        await audit(args.key_name, args.id ? 'Site de vote modifié (MCP)' : 'Site de vote ajouté (MCP)', saved.voteUrl, saved.provider);
        return ok({ id: saved.id, provider: saved.provider, label: saved.label, voteUrl: saved.voteUrl, cooldownHours: saved.cooldownHours, enabled: saved.enabled });
      } catch (error) {
        return failure(error);
      }
    }),
  );

  server.registerTool(
    'delete_site_vote_site',
    { description: 'Retire un site de vote de la page Votes. Les votes déjà comptés restent.', inputSchema: { id: z.string(), key_name: keyName }, _meta: toolMeta },
    guard('WRITE_SITE', async ({ id, key_name }) => {
      await deleteVoteSite(guildId, id);
      await audit(key_name, 'Site de vote retiré (MCP)', id, '');
      return ok({ ok: true });
    }),
  );

  server.registerTool(
    'save_site_forum_category',
    {
      description:
        "Ajoute ou modifie une catégorie du forum. mode SITE : sur le site seulement ; MIRROR : recopie le salon forum Discord channel_id dans les deux sens (Kotbo doit pouvoir gérer les webhooks du salon). write_role_ids vide = tous les membres.",
      inputSchema: {
        id: z.string().optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        mode: z.enum(['SITE', 'MIRROR']).optional(),
        channel_id: z.string().optional(),
        write_role_ids: z.array(z.string()).optional(),
        staff_topics_only: z.boolean().optional(),
        key_name: keyName,
      },
      _meta: toolMeta,
    },
    guard('WRITE_SITE', async (args) => {
      try {
        const category = await saveForumCategory(client, guildId, args.id ?? null, {
          name: args.name,
          description: args.description,
          mode: args.mode,
          channelId: args.channel_id,
          writeRoleIds: args.write_role_ids,
          staffTopicsOnly: args.staff_topics_only,
        });
        await audit(args.key_name, args.id ? 'Catégorie du forum modifiée (MCP)' : 'Catégorie du forum créée (MCP)', category.name, category.mode);
        return ok({ id: category.id, slug: category.slug, mode: category.mode });
      } catch (error) {
        return failure(error);
      }
    }),
  );

  server.registerTool(
    'delete_site_forum_category',
    { description: 'Supprime une catégorie du forum et ses sujets du site (le salon Discord n’est pas touché).', inputSchema: { id: z.string(), key_name: keyName }, _meta: toolMeta },
    guard('WRITE_SITE', async ({ id, key_name }) => {
      await deleteForumCategory(client, guildId, id);
      await audit(key_name, 'Catégorie du forum supprimée (MCP)', id, '');
      return ok({ ok: true });
    }),
  );

  server.registerTool(
    'moderate_site_forum',
    {
      description:
        'Modère le forum : épingler ou verrouiller un sujet (topic_id), désigner sa solution (accepted_post_id ; null la retire, le sujet passe en résolu et s’indexe en questions-réponses), ou retirer un message (post_id ; le premier message d’un sujet retire le sujet).',
      inputSchema: {
        topic_id: z.string().optional(),
        pinned: z.boolean().optional(),
        locked: z.boolean().optional(),
        accepted_post_id: z.string().nullable().optional(),
        post_id: z.string().optional(),
        key_name: keyName,
      },
      _meta: toolMeta,
    },
    guard('WRITE_SITE', async ({ topic_id, pinned, locked, accepted_post_id, post_id, key_name }) => {
      try {
        if (topic_id && (pinned !== undefined || locked !== undefined)) await setForumTopicFlags(guildId, topic_id, { pinned, locked });
        if (topic_id && accepted_post_id !== undefined) await acceptForumAnswer(client, guildId, topic_id, accepted_post_id, { userId: ownerId ?? 'mcp_agent', isStaff: true });
        if (post_id) await deleteForumPost(client, guildId, post_id, { userId: ownerId ?? 'mcp_agent', isStaff: true });
        await audit(key_name, 'Modération du forum (MCP)', topic_id ?? post_id ?? '', [pinned !== undefined ? `épinglé=${pinned}` : '', locked !== undefined ? `verrouillé=${locked}` : '', accepted_post_id !== undefined ? `solution=${accepted_post_id ?? 'aucune'}` : '', post_id ? 'message retiré' : ''].filter(Boolean).join(', '));
        return ok({ ok: true });
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
