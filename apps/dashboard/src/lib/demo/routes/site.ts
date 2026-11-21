/**
 * Site communautaire du serveur de démo : pages d'accueil, wiki et blog écrites
 * en Markdown puis converties par le même code que le bot, menu, forum, votes
 * et statistiques. Vit sous `/api/site-admin/:guildId`.
 */
import { SITE_MODULE_KEYS, SITE_MODULES, markdownToSiteDocument, normalizeSiteThemeSettings, type SiteDocument } from '@kotbo/shared';
import { route } from '../backend';
import { demoDb, demoId } from '../db';
import { CHANNELS, DAY, ME, ROLES, ago, channelByName, personByName } from '../fixtures';
import { DEMO_GUILD_ID, DEMO_GUILD_NAME } from '../mode';

const BASE = '/api/site-admin/:guildId';
const SLUG = 'atelier-nova';

type Page = {
  id: string;
  kind: 'PAGE' | 'WIKI' | 'BLOG';
  slug: string;
  title: string;
  parentId: string | null;
  sortOrder: number;
  tags: string[];
  visibility: 'PUBLIC' | 'MEMBERS' | 'ROLES' | 'STAFF';
  publishedAt: string | null;
  firstPublishedAt: string | null;
  scheduledAt: string | null;
  hasUnpublishedChanges: boolean;
  archivedAt: string | null;
  authorId: string;
  lastEditedById: string | null;
  updatedAt: string;
  excerpt: string | null;
  coverUrl: string | null;
  icon: string | null;
  visibleRoleIds: string[];
  draftContent: SiteDocument;
  publishedTitle: string | null;
  commentsEnabled: boolean;
  seoTitle: string | null;
  seoDescription: string | null;
};

const page = (id: string, kind: Page['kind'], slug: string, title: string, markdown: string, extra: Partial<Page> = {}): Page => ({
  id, kind, slug, title, parentId: null, sortOrder: 0, tags: [], visibility: 'PUBLIC', publishedAt: ago(10 * DAY), firstPublishedAt: ago(40 * DAY),
  scheduledAt: null, hasUnpublishedChanges: false, archivedAt: null, authorId: ME.id, lastEditedById: ME.id, updatedAt: ago(2 * DAY),
  excerpt: null, coverUrl: null, icon: null, visibleRoleIds: [], draftContent: markdownToSiteDocument(markdown), publishedTitle: title,
  commentsEnabled: kind === 'BLOG', seoTitle: null, seoDescription: null, ...extra,
});

const pagesSeed = (): Page[] => [
  page('sp-home', 'PAGE', 'accueil', 'Bienvenue sur Atelier Nova', `# Bienvenue sur Atelier Nova

Une communauté francophone de joueurs et de créateurs : soirées jeux chaque vendredi, entraide pour progresser et salons créatifs.

## Ce qu'on fait ici

- **Soirées jeux** tous les vendredis à 21 h dans le vocal Squad
- **Tournois** mensuels avec des rôles et des pièces à gagner
- **Entraide** : coaching, revues de partie, astuces

> Rejoins-nous, présente-toi dans #bienvenue et choisis tes jeux dans le menu d'accueil.`, { icon: '🏠', sortOrder: 0 }),
  page('sp-rules', 'PAGE', 'reglement', 'Le règlement', `# Le règlement

1. **Respect** : pas d'insultes, de harcèlement ni de discrimination.
2. **Pas de pub** sans accord du staff, ni en salon ni en MP.
3. **Pas de spam** : messages répétés, majuscules, mentions de masse.
4. **Contenus adaptés** : rien de choquant ou NSFW.
5. **Pseudos lisibles** et sans usurpation.
6. Le staff a le dernier mot, mais tu peux contester une sanction.`, { icon: '📜', sortOrder: 1 }),
  page('sp-wiki-ranks', 'WIKI', 'rangs-et-niveaux', 'Rangs et niveaux', `# Rangs et niveaux

Chaque message et chaque minute en vocal te rapporte de l'XP.

| Niveau | Rôle |
| --- | --- |
| 5 | Membre actif |
| 10 | Habitué |
| 25 | Vétéran |

Tape \`/rank\` pour voir ta carte de niveau.`, { icon: '⭐', tags: ['niveaux'], sortOrder: 0 }),
  page('sp-wiki-tickets', 'WIKI', 'ouvrir-un-ticket', 'Ouvrir un ticket', `# Ouvrir un ticket

Un souci avec un membre, une question sur une sanction ? Clique sur **Ouvrir un ticket** dans #ouvrir-un-ticket : un salon privé s'ouvre avec le staff.`, { icon: '🎫', tags: ['support'], sortOrder: 1 }),
  page('sp-blog-tournoi', 'BLOG', 'tournoi-d-automne', 'Le tournoi d’automne est lancé', `# Le tournoi d’automne est lancé 🏆

Inscriptions ouvertes jusqu'au 30 novembre. Équipes de 3, élimination directe, finale en direct sur le vocal Squad.

**À gagner** : 5 000 pièces et le rôle Champion pour l'équipe gagnante.`, { icon: '🏆', tags: ['événement'], publishedAt: ago(3 * DAY), firstPublishedAt: ago(3 * DAY) }),
  page('sp-blog-maj', 'BLOG', 'nouveautes-novembre', 'Les nouveautés de novembre', `# Les nouveautés de novembre

- Une boutique pour dépenser tes pièces
- Des fils automatiques dans #recherche-de-groupe
- Un nouveau salon #suggestions pour proposer tes idées`, { icon: '✨', tags: ['annonce'], hasUnpublishedChanges: true, publishedAt: ago(12 * DAY) }),
  page('sp-draft', 'BLOG', 'portrait-du-staff', 'Portrait : rencontre avec le staff', `# Portrait : rencontre avec le staff

Brouillon en cours de rédaction…`, { icon: '👥', publishedAt: null, firstPublishedAt: null, publishedTitle: null, hasUnpublishedChanges: true }),
];

const siteSeed = () => ({
  id: 'site-1',
  guildId: DEMO_GUILD_ID,
  slug: SLUG,
  published: true,
  name: DEMO_GUILD_NAME,
  tagline: 'Jeux, création et entraide, en français',
  logoUrl: null,
  bannerUrl: null,
  faviconUrl: null,
  theme: 'azur',
  themeSettings: normalizeSiteThemeSettings({ accent: '#22d3ee' }),
  customCss: null,
  navigation: [
    { id: 'nav-1', label: 'Accueil', target: { type: 'page', pageId: 'sp-home' }, children: [] },
    { id: 'nav-2', label: 'Règlement', target: { type: 'page', pageId: 'sp-rules' }, children: [] },
    { id: 'nav-3', label: 'Wiki', target: { type: 'section', section: 'wiki' }, children: [] },
    { id: 'nav-4', label: 'Actus', target: { type: 'section', section: 'blog' }, children: [] },
    { id: 'nav-5', label: 'Forum', target: { type: 'section', section: 'forum' }, children: [] },
    { id: 'nav-6', label: 'Voter', target: { type: 'section', section: 'votes' }, children: [] },
  ],
  homePageId: 'sp-home',
  settings: { commentsByDefault: true, showMemberCount: true, heroPulse: true, templateId: 'gaming' },
  rewards: {},
  wikiEditorRoleIds: [ROLES[3].id],
  blogEditorRoleIds: [ROLES[1].id],
  wikiAnnounceChannelId: null,
  blogAnnounceChannelId: channelByName('annonces').id,
  suspendedAt: null,
  suspendedReason: null,
  updatedAt: ago(DAY),
});

const pages = () => demoDb.get('site/pages', pagesSeed);
const savePages = (list: Page[]) => demoDb.set('site/pages', list);
const site = () => demoDb.get('site/site', siteSeed);
const summary = ({ excerpt, coverUrl, icon, visibleRoleIds, draftContent, publishedTitle, commentsEnabled, seoTitle, seoDescription, ...rest }: Page) => rest;

const notFound = () => new Response(JSON.stringify({ error: 'Page introuvable dans la démo.' }), { status: 404 });

function analytics(days: number) {
  const daily = Array.from({ length: days }, (_, i) => {
    const views = 120 + ((i * 37) % 90) + (i % 7 === 5 ? 80 : 0);
    return { date: new Date(Date.now() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10), views, visitors: Math.round(views * 0.42) };
  });
  const views = daily.reduce((s, d) => s + d.views, 0);
  const visitors = daily.reduce((s, d) => s + d.visitors, 0);
  return {
    from: daily[0].date,
    to: daily[daily.length - 1].date,
    funnel: { visitors, clickers: Math.round(visitors * 0.18), clicks: Math.round(visitors * 0.22), arrivals: Math.round(visitors * 0.07), eligible: Math.round(visitors * 0.06), retained: Math.round(visitors * 0.04), attributable: true, sources: [{ source: 'google', clicks: 140 }, { source: 'top.gg', clicks: 88 }, { source: 'direct', clicks: 61 }] },
    totals: { views, visitors },
    previous: { views: Math.round(views * 0.83), visitors: Math.round(visitors * 0.86) },
    daily,
    pages: [
      { path: `/s/${SLUG}`, views: Math.round(views * 0.41), visitors: Math.round(visitors * 0.5) },
      { path: `/s/${SLUG}/reglement`, views: Math.round(views * 0.17), visitors: Math.round(visitors * 0.2) },
      { path: `/s/${SLUG}/wiki/rangs-et-niveaux`, views: Math.round(views * 0.12), visitors: Math.round(visitors * 0.14) },
      { path: `/s/${SLUG}/blog/tournoi-d-automne`, views: Math.round(views * 0.1), visitors: Math.round(visitors * 0.12) },
    ],
    referrers: [{ host: 'google.com', views: Math.round(views * 0.34) }, { host: 'top.gg', views: Math.round(views * 0.21) }, { host: 'discord.com', views: Math.round(views * 0.18) }],
    devices: [{ device: 'mobile', views: Math.round(views * 0.61) }, { device: 'desktop', views: Math.round(views * 0.36) }, { device: 'tablet', views: Math.round(views * 0.03) }],
  };
}

const forumSeed = () => ({
  categories: [
    { id: 'fc-1', name: 'Présentations', slug: 'presentations', description: 'Dis-nous qui tu es !', mode: 'SITE', channelId: null, webhookId: null, writeRoleIds: [], staffTopicsOnly: false, sortOrder: 0, topicCount: 34, lastPostAt: ago(90) },
    { id: 'fc-2', name: 'Suggestions', slug: 'suggestions', description: 'Miroir du forum Discord #suggestions', mode: 'MIRROR', channelId: channelByName('suggestions').id, webhookId: 'wh-forum', writeRoleIds: [], staffTopicsOnly: false, sortOrder: 1, topicCount: 21, lastPostAt: ago(5 * 60) },
    { id: 'fc-3', name: 'Annonces du staff', slug: 'annonces', description: '', mode: 'SITE', channelId: null, webhookId: null, writeRoleIds: [], staffTopicsOnly: true, sortOrder: 2, topicCount: 6, lastPostAt: ago(3 * DAY) },
  ],
  recent: [
    { id: 'fp-1', authorId: personByName('Jade').id, authorName: 'Jade', content: 'Salut ! Moi c’est Jade, je joue surtout à Valorant.', source: 'SITE', createdAt: ago(90), topic: { id: 'ft-1', title: 'Hello tout le monde', pinned: false, locked: false, category: { name: 'Présentations', slug: 'presentations' } } },
    { id: 'fp-2', authorId: personByName('Noé').id, authorName: 'Noé', content: 'Un salon pour partager nos clips, ce serait top.', source: 'DISCORD', createdAt: ago(5 * 60), topic: { id: 'ft-2', title: 'Salon clips', pinned: false, locked: false, category: { name: 'Suggestions', slug: 'suggestions' } } },
  ],
  forumChannels: CHANNELS.filter((c) => c.type === 'forum').map((c) => ({ id: c.id, name: c.name, botCanManage: true })),
});

const votesSeed = () => [
  { id: 'vote-1', provider: 'topgg', label: 'Top.gg', voteUrl: 'https://top.gg/discord/servers/atelier-nova/vote', cooldownHours: 12, enabled: true, sortOrder: 0, hasKey: true, webhookUrl: 'https://api.kotbo.fr/api/votes/topgg/demo', webhookSecret: 'demo-secret', votes30d: 214 },
  { id: 'vote-2', provider: 'disboard', label: 'Disboard', voteUrl: 'https://disboard.org/fr/server/atelier-nova', cooldownHours: 2, enabled: true, sortOrder: 1, hasKey: false, webhookUrl: null, webhookSecret: null, votes30d: 96 },
];

export function registerSiteRoutes(): void {
  route('GET', BASE, () => ({
    site: site(),
    pages: pages().map(summary),
    rights: { manage: true, wiki: true, blog: true, moderateComments: true, viewStats: true },
    modules: { site: true, site_wiki: true, site_blog: true },
    baseUrl: 'https://kotbo.fr/s/',
    previewUrl: null,
    suggestedSlug: null,
    templates: ['general', 'gaming', 'rp', 'esport', 'etude', 'dev'],
    guild: { name: DEMO_GUILD_NAME, iconUrl: null, bannerUrl: null },
  }));
  route('PATCH', BASE, ({ body }) => ({ site: demoDb.update('site/site', siteSeed, (s) => ({ ...s, ...(body ?? {}), updatedAt: new Date().toISOString() })) }));
  route('POST', BASE, () => ({ site: site() }));
  route('POST', `${BASE}/instant`, () => ({ siteId: 'site-1', slug: SLUG, created: false, template: 'gaming', articles: pages().length }));

  route('GET', `${BASE}/catalog`, () => ({
    blocks: SITE_MODULE_KEYS.map((key) => ({ key, category: SITE_MODULES[key].category, available: true, dependency: SITE_MODULES[key].botModule })),
    forms: [{ id: 'form-recrutement', name: 'Candidature modérateur', isRecruitment: true }, { id: 'form-tournoi', name: 'Inscription au tournoi', isRecruitment: false }],
    hierarchies: [{ id: 'hier-direction', name: 'Direction', icon: '👑' }, { id: 'hier-moderation', name: 'Modération', icon: '🛡️' }, { id: 'hier-support', name: 'Support', icon: '💬' }],
    channels: CHANNELS.filter((c) => c.type !== 'voice').map((c) => ({ id: c.id, name: c.name, public: !['staff', 'logs'].includes(c.name), botCanSend: true })),
    roles: ROLES.filter((r) => !r.managed).map((r) => ({ id: r.id, name: r.name, color: r.color })),
  }));

  route('POST', `${BASE}/pages`, ({ body }) => {
    const created = page(demoId(), body?.kind ?? 'PAGE', body?.slug || String(body?.title ?? 'page').toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), body?.title ?? 'Nouvelle page', '', {
      draftContent: body?.content ?? { type: 'doc', content: [] }, parentId: body?.parentId ?? null, publishedAt: null, firstPublishedAt: null, publishedTitle: null, hasUnpublishedChanges: true, updatedAt: new Date().toISOString(),
    });
    savePages([...pages(), created]);
    return { page: { id: created.id, kind: created.kind, slug: created.slug, title: created.title } };
  });
  route('POST', `${BASE}/pages/reorder`, () => ({ ok: true }));
  route('GET', `${BASE}/pages/:pageId`, ({ params }) => {
    const found = pages().find((p) => p.id === params.pageId);
    return found ? { page: found } : notFound();
  });
  route('PATCH', `${BASE}/pages/:pageId`, ({ params, body }) => {
    let updated: Page | undefined;
    savePages(pages().map((p) => (p.id === params.pageId ? (updated = { ...p, ...(body ?? {}), hasUnpublishedChanges: true, updatedAt: new Date().toISOString() }) : p)));
    return updated ? { page: { id: updated.id, slug: updated.slug, title: updated.title, updatedAt: updated.updatedAt, hasUnpublishedChanges: true } } : notFound();
  });
  route('DELETE', `${BASE}/pages/:pageId`, ({ params }) => {
    savePages(pages().filter((p) => p.id !== params.pageId));
    return { ok: true };
  });
  route('POST', `${BASE}/pages/:pageId/publish`, ({ params }) => {
    const now = new Date().toISOString();
    let slug = '';
    savePages(pages().map((p) => (p.id === params.pageId ? ((slug = p.slug), { ...p, publishedAt: now, firstPublishedAt: p.firstPublishedAt ?? now, publishedTitle: p.title, hasUnpublishedChanges: false }) : p)));
    return { page: { id: params.pageId, publishedAt: now, slug } };
  });
  route('POST', `${BASE}/pages/:pageId/unpublish`, ({ params }) => {
    savePages(pages().map((p) => (p.id === params.pageId ? { ...p, publishedAt: null } : p)));
    return { ok: true };
  });
  route('POST', `${BASE}/pages/:pageId/schedule`, ({ params, body }) => {
    savePages(pages().map((p) => (p.id === params.pageId ? { ...p, scheduledAt: body?.scheduledAt ?? null } : p)));
    return { scheduledAt: body?.scheduledAt ?? null };
  });
  route('POST', `${BASE}/pages/:pageId/preview`, ({ params }) => {
    const found = pages().find((p) => p.id === params.pageId);
    return { url: `https://kotbo.fr/s/${SLUG}/${found?.slug ?? ''}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  });
  route('GET', `${BASE}/pages/:pageId/revisions`, ({ params }) => {
    const found = pages().find((p) => p.id === params.pageId);
    return { revisions: found ? [{ id: `${found.id}-r1`, title: found.title, authorId: ME.id, note: null, createdAt: found.updatedAt }] : [] };
  });
  route('GET', `${BASE}/pages/:pageId/revisions/:revisionId`, ({ params }) => {
    const found = pages().find((p) => p.id === params.pageId);
    return found ? { revision: { id: params.revisionId, title: found.title, authorId: ME.id, authorName: 'Toi', createdAt: found.updatedAt, published: true, content: found.draftContent } } : notFound();
  });
  route('POST', `${BASE}/pages/:pageId/revisions/:revisionId/restore`, ({ params }) => {
    const found = pages().find((p) => p.id === params.pageId);
    return found ? { page: { id: found.id, title: found.title, draftContent: found.draftContent } } : notFound();
  });

  route('GET', `${BASE}/assets`, () => ({ assets: [] }));
  route('DELETE', `${BASE}/assets/:assetId`, () => ({ ok: true }));
  route('GET', `${BASE}/stock`, () => ({ images: [] }));
  route('GET', `${BASE}/templates`, () => ({ templates: [] }));
  route('POST', `${BASE}/templates/undo`, () => ({ ok: true }));
  route('POST', `${BASE}/templates/keep`, () => ({ ok: true }));

  route('GET', `${BASE}/comments`, () => ({
    comments: [
      { id: 'sc-1', pageId: 'sp-blog-tournoi', authorId: personByName('Lina').id, authorName: 'Lina', authorAvatar: null, content: 'Trop hâte ! On a déjà notre équipe 🔥', status: 'VISIBLE', moderationReason: null, createdAt: ago(5 * 60), page: { title: 'Le tournoi d’automne est lancé', slug: 'tournoi-d-automne' } },
      { id: 'sc-2', pageId: 'sp-blog-tournoi', authorId: personByName('Sacha').id, authorName: 'Sacha', authorAvatar: null, content: 'Est-ce qu’on peut s’inscrire en solo ?', status: 'VISIBLE', moderationReason: null, createdAt: ago(3 * 60), page: { title: 'Le tournoi d’automne est lancé', slug: 'tournoi-d-automne' } },
    ],
  }));
  route('PATCH', `${BASE}/comments/:id`, () => ({ ok: true }));
  route('DELETE', `${BASE}/comments/:id`, () => ({ ok: true }));

  const votes = () => demoDb.get('site/votes', votesSeed);
  route('GET', `${BASE}/votes`, () => ({
    voteSites: votes(),
    topVoters: ['Lina', 'Noé', 'Maëlle'].map((name, i) => ({ userId: personByName(name).id, votes: 28 - i * 6, name, avatarUrl: null })),
  }));
  route('POST', `${BASE}/votes`, ({ body }) => {
    const vote = { ...votesSeed()[1], ...(body ?? {}), id: demoId(), votes30d: 0, hasSecret: false, sortOrder: votes().length };
    demoDb.set('site/votes', [...votes(), vote]);
    return { id: vote.id };
  });
  route('PATCH', `${BASE}/votes/:id`, ({ params, body }) => {
    demoDb.set('site/votes', votes().map((v) => (v.id === params.id ? { ...v, ...(body ?? {}) } : v)));
    return { ok: true };
  });
  route('DELETE', `${BASE}/votes/:id`, ({ params }) => {
    demoDb.set('site/votes', votes().filter((v) => v.id !== params.id));
    return { ok: true };
  });
  route('POST', `${BASE}/votes/:id/secret`, () => ({ ok: true }));
  route('POST', `${BASE}/votes/reorder`, () => ({ ok: true }));

  route('POST', `${BASE}/auto/weekly`, () => ({ pageId: 'sp-blog-maj' }));
  route('POST', `${BASE}/auto/module-pages`, () => ({ created: 0 }));

  route('GET', `${BASE}/forum`, () => demoDb.get('site/forum', forumSeed));
  route('POST', `${BASE}/forum/categories`, ({ body }) => {
    const id = demoId();
    demoDb.update('site/forum', forumSeed, (f) => ({ ...f, categories: [...f.categories, { ...forumSeed().categories[0], ...(body ?? {}), id, topicCount: 0, lastPostAt: null, sortOrder: f.categories.length }] }));
    return { id };
  });
  route('PATCH', `${BASE}/forum/categories/:id`, ({ params, body }) => {
    demoDb.update('site/forum', forumSeed, (f) => ({ ...f, categories: f.categories.map((c) => (c.id === params.id ? { ...c, ...(body ?? {}) } : c)) }));
    return { ok: true };
  });
  route('DELETE', `${BASE}/forum/categories/:id`, ({ params }) => {
    demoDb.update('site/forum', forumSeed, (f) => ({ ...f, categories: f.categories.filter((c) => c.id !== params.id) }));
    return { ok: true };
  });
  route('POST', `${BASE}/forum/categories/reorder`, () => ({ ok: true }));
  route('POST', `${BASE}/forum/categories/:id/import`, () => ({ imported: 12 }));
  route('POST', `${BASE}/forum/topics/:id/flags`, () => ({ ok: true }));
  route('DELETE', `${BASE}/forum/posts/:id`, () => ({ ok: true }));

  route('GET', `${BASE}/analytics`, ({ query }) => ({ report: analytics(Math.min(90, Math.max(7, Number(query.get('days')) || 30))) }));
  route('GET', `${BASE}/staff-profile`, () => ({ profile: { isStaff: true, bio: 'Fondateur d’Atelier Nova, joueur de Valorant et de Minecraft.', hidden: false } }));
  route('PUT', `${BASE}/staff-profile`, ({ body }) => ({ profile: { bio: body?.bio ?? '', hidden: !!body?.hidden } }));
  route('GET', `${BASE}/agent`, () => ({ agent: { active: false, keyName: null, startedAt: null, lastActivityAt: null, activity: null, pageIds: [], interrupted: null } }));
  route('POST', `${BASE}/agent/interrupt`, () => ({ agent: { active: false, keyName: null, startedAt: null, lastActivityAt: null, activity: null, pageIds: [], interrupted: null } }));
  route('POST', `${BASE}/agent/allow`, () => ({ agent: { active: false, keyName: null, startedAt: null, lastActivityAt: null, activity: null, pageIds: [], interrupted: null } }));
}
