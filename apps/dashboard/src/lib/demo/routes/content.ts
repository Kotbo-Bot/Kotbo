/**
 * Contenus : campagnes de messages, actualités (avec leur page publique et
 * leur flux) et réseaux sociaux suivis.
 */
import { route } from '../backend';
import { demoDb, demoId } from '../db';
import { row } from '../model';
import { G } from '../crud';
import { DAY, ME, MEMBERS, ago, channelByName, role } from '../fixtures';
import { DEMO_GUILD_ID } from '../mode';

// ── Campagnes ────────────────────────────────────────────────────────────

const step = (campaignId: string, position: number, offsetMinutes: number, content: string, extra: Record<string, unknown> = {}) =>
  row('CampaignStep', { id: `${campaignId}-s${position}`, campaignId, position, offsetMinutes, content, channelId: channelByName('annonces').id, ...extra });

function campaignsSeed() {
  return [
    {
      ...row('Campaign', { id: 'camp-1', guildId: DEMO_GUILD_ID, name: 'Tournoi d’automne', description: 'Annonce, rappel et résultats du tournoi.', status: 'RUNNING', startAt: ago(3 * DAY), audienceRoleIds: [role('Membre').id], createdByUserId: ME.id, createdAt: ago(5 * DAY) }),
      steps: [
        step('camp-1', 0, 0, '🏆 Le tournoi d’automne est ouvert ! Inscris ton équipe avant le 30.', { status: 'SENT', sentAt: ago(3 * DAY), recipientCount: 128, deliveredCount: 128, reactionCount: 41, messageId: demoId() }),
        step('camp-1', 1, 4 * 24 * 60, '⏰ Plus que 3 jours pour s’inscrire au tournoi !', { status: 'PENDING' }),
        step('camp-1', 2, 8 * 24 * 60, '🎉 Bravo aux gagnants du tournoi !', { status: 'PENDING' }),
      ],
    },
    {
      ...row('Campaign', { id: 'camp-2', guildId: DEMO_GUILD_ID, name: 'Relance des inactifs', description: 'MP aux membres silencieux depuis 30 jours.', status: 'DRAFT', audienceInactiveDays: 30, createdByUserId: ME.id, createdAt: ago(DAY) }),
      steps: [step('camp-2', 0, 0, 'Salut {user} ! On ne t’a pas vu depuis un moment : vendredi c’est soirée jeux, ça te dit ?', { delivery: 'DM', channelId: null })],
    },
  ];
}

// ── Actualités ───────────────────────────────────────────────────────────

function newsSeed() {
  const article = (id: string, title: string, content: string, category: string, days: number, extra: Record<string, unknown> = {}) =>
    row('NewsArticle', { id, guildId: DEMO_GUILD_ID, title, content, summary: content.split('\n')[0].slice(0, 140), authorId: ME.id, authorName: 'Toi', isGlobal: false, category, publishedAt: ago(days * DAY), updatedAt: ago(days * DAY), ...extra });
  return [
    article('news-1', 'Le tournoi d’automne est lancé', 'Inscriptions ouvertes jusqu’au 30 novembre.\n\nÉquipes de 3, élimination directe, finale en direct sur le vocal **Squad**. À gagner : 5 000 pièces et le rôle Champion.', 'Événement', 3),
    article('news-2', 'Nouveautés de novembre', 'La boutique ouvre ses portes !\n\n- Dépense tes pièces en rôles, objets et boosts d’XP\n- Des fils automatiques dans #recherche-de-groupe\n- Un forum #suggestions tout neuf', 'Mise à jour', 12, { subcategory: 'Serveur' }),
    article('news-3', 'Bienvenue aux 1 000 membres', 'Merci à toutes et à tous, on a passé le cap des 1 000 membres 🎉\n\nUn giveaway Nitro est en cours dans #annonces pour fêter ça.', 'Communauté', 20),
    article('news-4', 'Brouillon : refonte des rôles', 'Le staff prépare une nouvelle hiérarchie des rôles.', 'Mise à jour', 0, { published: false }),
  ];
}

const newsConfigsSeed = () => [
  row('NewsCategoryConfig', { id: 'ncc-1', guildId: DEMO_GUILD_ID, category: 'Mise à jour', subcategory: '', channelId: channelByName('annonces').id }),
  row('NewsCategoryConfig', { id: 'ncc-2', guildId: DEMO_GUILD_ID, category: 'Événement', subcategory: '', channelId: channelByName('général').id }),
];

// ── Réseaux sociaux ──────────────────────────────────────────────────────

const socialSeed = () => ({
  youtube: [
    row('YoutubeChannelFollow', { id: 'yt-1', guildId: DEMO_GUILD_ID, channelId: 'UCnovaGaming', channelName: 'Atelier Nova Gaming', discordChannelId: channelByName('annonces').id, mention: `<@&${role('Habitué').id}>`, videoMessage: '🎬 Nouvelle vidéo de {channel} : {title}\n{url}', liveMessage: '🔴 {channel} est en live ! {url}', lastVideoId: 'dQw4w9WgXcQ', createdAt: ago(60 * DAY) }),
  ],
  twitch: [
    row('TwitchChannelFollow', { id: 'tw-1', guildId: DEMO_GUILD_ID, streamerName: 'arka_live', discordChannelId: channelByName('annonces').id, liveMessage: '🔴 {streamer} lance un live : {title}', isLive: true, createdAt: ago(45 * DAY) }),
    row('TwitchChannelFollow', { id: 'tw-2', guildId: DEMO_GUILD_ID, streamerName: 'lena_plays', discordChannelId: channelByName('général').id, isLive: false, createdAt: ago(20 * DAY) }),
  ],
  github: [
    row('GithubRepoFollow', { id: 'gh-1', guildId: DEMO_GUILD_ID, repo: 'atelier-nova/bot-config', branch: 'main', discordChannelId: channelByName('staff').id, notifyCommits: true, notifyReleases: true, createdAt: ago(30 * DAY) }),
  ],
  huggingface: [],
});

export function registerContentRoutes(): void {
  const campaigns = () => demoDb.get('campaigns', campaignsSeed);
  route('GET', `${G}/campaigns`, () => ({ campaigns: campaigns() }));
  route('POST', `${G}/campaigns/audience-preview`, ({ body }) => {
    const people = MEMBERS.filter((m) => !m.bot);
    const filtered = body?.audienceInactiveDays ? people.filter((p) => p.messages < 200) : body?.audienceMinLevel ? people.filter((p) => p.level >= body.audienceMinLevel) : people;
    return { count: filtered.length, sample: filtered.slice(0, 8).map((p) => ({ id: p.id, name: p.username })) };
  });
  route('POST', `${G}/campaigns`, ({ body }) => {
    const id = demoId();
    const campaign = {
      ...row('Campaign', { ...(body ?? {}), id, guildId: DEMO_GUILD_ID, status: 'DRAFT', createdByUserId: ME.id }),
      steps: (body?.steps ?? []).map((s: Record<string, unknown>, i: number) => step(id, i, Number(s.offsetMinutes ?? 0), String(s.content ?? ''), s)),
    };
    demoDb.set('campaigns', [campaign, ...campaigns()]);
    return { campaign };
  });
  route('PATCH', `${G}/campaigns/:campaignId`, ({ params, body }) => {
    let campaign: any;
    demoDb.set('campaigns', campaigns().map((c) => {
      if (c.id !== params.campaignId) return c;
      campaign = { ...c, ...(body ?? {}) };
      if (Array.isArray(body?.steps)) campaign.steps = body.steps.map((s: Record<string, unknown>, i: number) => step(c.id, i, Number(s.offsetMinutes ?? 0), String(s.content ?? ''), s));
      if (body?.status === 'RUNNING' && !c.startAt) campaign.startAt = new Date().toISOString();
      return campaign;
    }));
    return { campaign };
  });
  route('GET', `${G}/campaigns/:campaignId/report`, ({ params }) => {
    const sent = campaigns().find((c) => c.id === params.campaignId)?.steps.filter((x: any) => x.status === 'SENT') ?? [];
    const recipients = sent.reduce((n: number, x: any) => n + x.recipientCount, 0);
    return { report: { recipients, delivered: recipients, failed: 0, reactions: sent.reduce((n: number, x: any) => n + x.reactionCount, 0), joins: sent.length ? 9 : 0 } };
  });
  route('DELETE', `${G}/campaigns/:campaignId`, ({ params }) => {
    demoDb.set('campaigns', campaigns().filter((c) => c.id !== params.campaignId));
    return { success: true };
  });

  const news = () => demoDb.get('news', newsSeed);
  route('GET', `${G}/news`, () => news());
  route('POST', `${G}/news`, ({ body }) => {
    const article = row('NewsArticle', { ...(body ?? {}), id: demoId(), guildId: DEMO_GUILD_ID, authorId: ME.id, authorName: 'Toi', isGlobal: false });
    demoDb.set('news', [article, ...news()]);
    return article;
  });
  route('PATCH', `${G}/news/:articleId`, ({ params, body }) => {
    let updated: unknown;
    demoDb.set('news', news().map((a) => (a.id === params.articleId ? (updated = { ...a, ...(body ?? {}), updatedAt: new Date().toISOString() }) : a)));
    return updated;
  });
  route('DELETE', `${G}/news/:articleId`, ({ params }) => {
    demoDb.set('news', news().filter((a) => a.id !== params.articleId));
    return { success: true };
  });
  const configs = () => demoDb.get('news/configs', newsConfigsSeed);
  route('GET', `${G}/news/category-configs`, () => configs());
  route('POST', `${G}/news/category-configs`, ({ body }) => {
    const config = row('NewsCategoryConfig', { ...(body ?? {}), id: demoId(), guildId: DEMO_GUILD_ID });
    demoDb.set('news/configs', [...configs(), config]);
    return config;
  });
  route('DELETE', `${G}/news/category-configs/:id`, ({ params }) => {
    demoDb.set('news/configs', configs().filter((c) => c.id !== params.id));
    return { success: true };
  });
  // Page publique `/<serveur>/news` : seuls les articles publiés.
  route('GET', '/api/public/guilds/:guildId/news', () => news().filter((a) => a.published));
  // La démo ne redirige jamais vers un vrai site : la page publique reste dans la démo.
  route('GET', '/api/site/redirect', () => ({ path: null }));

  const social = () => demoDb.get('social-follows', socialSeed);
  route('GET', `${G}/social-follows`, () => social());
  for (const kind of ['youtube', 'twitch', 'github', 'huggingface'] as const) {
    const model = { youtube: 'YoutubeChannelFollow', twitch: 'TwitchChannelFollow', github: 'GithubRepoFollow', huggingface: 'HuggingFaceFollow' }[kind];
    route('POST', `${G}/social-follows/${kind}`, ({ body }) => {
      const follow = row(model, { ...(body ?? {}), id: demoId(), guildId: DEMO_GUILD_ID, channelName: body?.channelName ?? body?.channel ?? body?.channelId ?? '' });
      demoDb.update('social-follows', socialSeed, (s) => ({ ...s, [kind]: [...s[kind], follow] }));
      return follow;
    });
    route('PATCH', `${G}/social-follows/${kind}/:followId`, ({ params, body }) => {
      let follow: unknown;
      demoDb.update('social-follows', socialSeed, (s) => ({ ...s, [kind]: s[kind].map((f: any) => (f.id === params.followId ? (follow = { ...f, ...(body ?? {}) }) : f)) }));
      return follow;
    });
    route('DELETE', `${G}/social-follows/${kind}/:followId`, ({ params }) => {
      demoDb.update('social-follows', socialSeed, (s) => ({ ...s, [kind]: s[kind].filter((f: any) => f.id !== params.followId) }));
      return { success: true };
    });
  }
}
