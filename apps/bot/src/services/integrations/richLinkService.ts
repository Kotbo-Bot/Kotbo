/**
 * Aperçus de liens enrichis.
 *
 * Quand un membre poste un lien pris en charge (GitHub, X, Bluesky, TikTok,
 * Instagram, chaîne YouTube, Steam, npm, PyPI, crates.io, Hugging Face,
 * Stack Overflow), Kotbo répond par une carte : description, chiffres, image,
 * bouton d'ouverture. L'aperçu natif de Discord est alors masqué pour ne pas
 * doubler la carte.
 *
 * Un fournisseur = une entrée de `PROVIDERS` : `match` extrait des identifiants
 * validés du lien, `load` interroge un hôte fixe avec ces identifiants. L'URL
 * du membre ne part jamais telle quelle vers l'extérieur.
 */
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  type Message,
} from 'discord.js';
import pLimit from 'p-limit';
import { cache } from '../../utils/cache.js';
import { fetchExternal } from '../../utils/http.js';
import { githubGet } from './githubService.js';
import { decodeXmlEntities, fetchChannelAvatar, resolveYoutubeChannel } from './youtubeService.js';

export interface RichLinkTarget {
  kind: string;
  args: string[];
}

export interface RichLinkCard {
  title: string;
  url: string;
  body?: string;
  meta?: string;
  stats?: string;
  thumbnail?: string;
  images?: string[];
  /** Images à adresse signée, qui expire : on les joint au message au lieu de les lier. */
  attachImages?: boolean;
  openLabel: string;
}

interface Provider {
  kind: string;
  hosts: string[];
  /** Segments du chemin → identifiants validés, ou `null` si le lien n'est pas pour lui. */
  match(parts: string[]): string[] | null;
  load(...args: string[]): Promise<RichLinkCard | null>;
}

const count = (n: number | string | null | undefined) => (Number(n) || 0).toLocaleString('fr-FR');
// Texte venu de l'extérieur : sans crochets, pas de lien masqué `[discord.com](piège)`.
const plain = (text: string | null | undefined, max = 600) =>
  decodeXmlEntities(text ?? '').replace(/[[\]]/g, '').trim().slice(0, max);
const https = (url: unknown): url is string => typeof url === 'string' && url.startsWith('https://');
const date = (iso: string | null | undefined) => (iso ? `<t:${Math.floor(Date.parse(iso) / 1000)}:D>` : null);
const join = (...items: (string | null | undefined | false)[]) => items.filter(Boolean).join(' · ');

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetchExternal(url, { headers: { 'User-Agent': 'Kotbo', Accept: 'application/json' } });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

// Premiers segments de github.com qui ne sont pas des comptes.
const GITHUB_RESERVED = new Set([
  'about', 'apps', 'collections', 'enterprise', 'explore', 'features', 'login', 'marketplace',
  'notifications', 'orgs', 'pricing', 'search', 'settings', 'sponsors', 'topics', 'trending',
]);
const HF_RESERVED = new Set([
  'api', 'blog', 'chat', 'collections', 'datasets', 'docs', 'join', 'learn', 'login', 'models',
  'organizations', 'papers', 'posts', 'pricing', 'settings', 'spaces', 'tasks',
]);
const GITHUB_LOGIN = /^[a-z\d][a-z\d-]{0,38}$/i;
const SLUG = /^[\w.-]{1,100}$/;
const DIGITS = /^\d{1,25}$/;
const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

const githubOwner = (owner?: string) => !!owner && GITHUB_LOGIN.test(owner) && !GITHUB_RESERVED.has(owner.toLowerCase());

const tiktokMatch = (p: string[]) => {
  if (p.length === 3 && /^@[\w.]{1,40}$/.test(p[0]) && (p[1] === 'video' || p[1] === 'photo') && DIGITS.test(p[2])) {
    return [`https://www.tiktok.com/${p[0]}/video/${p[2]}`];
  }
  return null;
};
const tiktokShort = (code?: string) => (code && /^[\w-]{4,20}$/.test(code) ? [`https://vm.tiktok.com/${code}/`] : null);

// tikwm n'accepte qu'une requête par seconde, tous serveurs confondus : une à la fois, espacées.
const tiktokQueue = pLimit(1);
let tiktokNextAt = 0;

async function loadTiktok(url: string): Promise<RichLinkCard | null> {
  type Payload = { data?: {
    title?: string; cover?: string; images?: string[];
    play_count?: number; digg_count?: number; comment_count?: number; share_count?: number;
    author?: { unique_id?: string; nickname?: string };
  } };
  // Au-delà de quelques liens en attente, la carte arriverait trop tard pour servir.
  if (tiktokQueue.pendingCount >= 5) return null;
  const d = (await tiktokQueue(async () => {
    const wait = tiktokNextAt - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    tiktokNextAt = Date.now() + 1_100;
    return getJson<Payload>(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`);
  }))?.data;
  if (!d?.author?.unique_id) return null;
  return {
    title: `${plain(d.author.nickname)} (@${plain(d.author.unique_id)})`,
    url,
    body: plain(d.title, 1000),
    stats: `❤️ **${count(d.digg_count)}** · 💬 **${count(d.comment_count)}** · 🔁 **${count(d.share_count)}** · 👁️ **${count(d.play_count)}**`,
    images: (d.images?.length ? d.images : [d.cover]).filter(https).slice(0, 4),
    attachImages: true,
    openLabel: 'Ouvrir TikTok',
  };
}

const PROVIDERS: Provider[] = [
  {
    kind: 'github_issue',
    hosts: ['github.com'],
    match: (p) => p.length === 4 && githubOwner(p[0]) && SLUG.test(p[1]) && (p[2] === 'issues' || p[2] === 'pull') && DIGITS.test(p[3])
      ? [p[0], p[1], p[3]] : null,
    async load(owner, repo, number) {
      type Payload = {
        title: string; html_url: string; state: string; body: string | null; comments: number;
        user: { login: string; avatar_url: string } | null; labels: { name: string }[];
        pull_request?: { merged_at: string | null }; created_at: string;
      };
      const res = await githubGet<Payload>(`/repos/${owner}/${repo}/issues/${number}`);
      if (!res.ok) return null;
      const i = res.data;
      const state = i.pull_request?.merged_at ? '🟣 Fusionnée' : i.state === 'open' ? '🟢 Ouverte' : '🔴 Fermée';
      return {
        title: `${plain(i.title, 200)} · ${owner}/${repo}#${number}`,
        url: i.html_url,
        meta: join(i.pull_request ? 'Pull request' : 'Issue', state, i.user && `par ${i.user.login}`, date(i.created_at)),
        body: plain(i.body, 400),
        stats: join(`💬 **${count(i.comments)}** commentaires`, ...i.labels.slice(0, 5).map((l) => `\`${plain(l.name, 40).replace(/`/g, '')}\``)),
        thumbnail: i.user?.avatar_url,
        openLabel: 'Ouvrir GitHub',
      };
    },
  },
  {
    kind: 'github_repo',
    hosts: ['github.com'],
    match: (p) => (p.length === 2 && githubOwner(p[0]) && SLUG.test(p[1]) ? [p[0], p[1].replace(/\.git$/, '')] : null),
    async load(owner, repo) {
      type Payload = {
        full_name: string; html_url: string; description: string | null; language: string | null;
        license: { spdx_id: string | null } | null; topics?: string[]; pushed_at: string | null;
        stargazers_count: number; forks_count: number; open_issues_count: number;
        owner: { avatar_url: string };
      };
      const res = await githubGet<Payload>(`/repos/${owner}/${repo}`);
      if (!res.ok) return null;
      const r = res.data;
      const license = r.license?.spdx_id && r.license.spdx_id !== 'NOASSERTION' ? r.license.spdx_id : null;
      return {
        title: plain(r.full_name),
        url: r.html_url,
        body: plain(r.description),
        meta: join(license, r.language, r.pushed_at && `Dernier push ${date(r.pushed_at)}`, ...(r.topics ?? []).slice(0, 5).map((t) => `#${plain(t)}`)),
        stats: `⭐ **${count(r.stargazers_count)}** étoiles · 🍴 **${count(r.forks_count)}** forks · **${count(r.open_issues_count)}** issues et PR ouvertes`,
        thumbnail: r.owner.avatar_url,
        openLabel: 'Ouvrir GitHub',
      };
    },
  },
  {
    kind: 'github_user',
    hosts: ['github.com'],
    match: (p) => (p.length === 1 && githubOwner(p[0]) ? [p[0]] : null),
    async load(login) {
      type Payload = {
        login: string; name: string | null; html_url: string; bio: string | null;
        avatar_url: string; followers: number; public_repos: number;
      };
      const res = await githubGet<Payload>(`/users/${login}`);
      if (!res.ok) return null;
      const u = res.data;
      return {
        title: u.name ? `${plain(u.name)} (${u.login})` : u.login,
        url: u.html_url,
        body: plain(u.bio),
        stats: `👥 **${count(u.followers)}** abonnés · 📚 **${count(u.public_repos)}** dépôts`,
        thumbnail: u.avatar_url,
        openLabel: 'Ouvrir GitHub',
      };
    },
  },
  {
    kind: 'tweet',
    hosts: ['x.com', 'twitter.com'],
    match: (p) => (p[1] === 'status' && DIGITS.test(p[2] ?? '') ? [p[2]] : null),
    async load(id) {
      type Payload = { tweet?: {
        text: string; likes: number; replies: number; retweets: number;
        author: { name: string; screen_name: string };
        media?: { photos?: { url: string }[]; videos?: { thumbnail_url: string }[] };
      } };
      const tweet = (await getJson<Payload>(`https://api.fxtwitter.com/status/${id}`))?.tweet;
      if (!tweet) return null;
      return {
        title: `${plain(tweet.author.name)} (@${plain(tweet.author.screen_name)})`,
        url: `https://x.com/${encodeURIComponent(tweet.author.screen_name)}/status/${id}`,
        body: plain(tweet.text, 1500),
        stats: `❤️ **${count(tweet.likes)}** · 💬 **${count(tweet.replies)}** · 🔁 **${count(tweet.retweets)}**`,
        images: [
          ...(tweet.media?.photos ?? []).map((m) => m.url),
          ...(tweet.media?.videos ?? []).map((m) => m.thumbnail_url),
        ].filter(https).slice(0, 4),
        openLabel: 'Ouvrir X',
      };
    },
  },
  {
    kind: 'bluesky',
    hosts: ['bsky.app'],
    match: (p) => p.length === 4 && p[0] === 'profile' && /^[\w.:-]{3,100}$/.test(p[1]) && p[2] === 'post' && /^[a-z0-9]{5,20}$/i.test(p[3])
      ? [p[1], p[3]] : null,
    async load(actor, rkey) {
      type Image = { fullsize?: string };
      type Payload = { thread?: { post?: {
        author: { handle: string; displayName?: string };
        record?: { text?: string };
        embed?: { images?: Image[]; thumbnail?: string; media?: { images?: Image[] } };
        likeCount?: number; replyCount?: number; repostCount?: number;
      } } };
      const uri = encodeURIComponent(`at://${actor}/app.bsky.feed.post/${rkey}`);
      const post = (await getJson<Payload>(
        `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?depth=0&parentHeight=0&uri=${uri}`,
      ))?.thread?.post;
      if (!post) return null;
      return {
        title: `${plain(post.author.displayName || post.author.handle)} (@${plain(post.author.handle)})`,
        url: `https://bsky.app/profile/${actor}/post/${rkey}`,
        body: plain(post.record?.text, 1500),
        stats: `❤️ **${count(post.likeCount)}** · 💬 **${count(post.replyCount)}** · 🔁 **${count(post.repostCount)}**`,
        images: [
          ...(post.embed?.images ?? post.embed?.media?.images ?? []).map((m) => m.fullsize),
          post.embed?.thumbnail,
        ].filter(https).slice(0, 4),
        openLabel: 'Ouvrir Bluesky',
      };
    },
  },
  { kind: 'tiktok', hosts: ['tiktok.com'], match: (p) => tiktokMatch(p) ?? (p.length === 2 && p[0] === 't' ? tiktokShort(p[1]) : null), load: loadTiktok },
  { kind: 'tiktok', hosts: ['vm.tiktok.com', 'vt.tiktok.com'], match: (p) => (p.length === 1 ? tiktokShort(p[0]) : null), load: loadTiktok },
  {
    kind: 'instagram',
    hosts: ['instagram.com'],
    match: (p) => {
      // Aussi sous la forme /<compte>/p/<code>.
      const [type, code] = p.length === 3 ? p.slice(1) : p;
      if (!['p', 'reel', 'reels', 'tv'].includes(type) || !/^[\w-]{5,40}$/.test(code ?? '')) return null;
      return [type === 'reels' ? 'reel' : type, code];
    },
    async load(type, code) {
      type Payload = { title?: string; author_name?: string; thumbnail_url?: string };
      const url = `https://www.instagram.com/${type}/${code}/`;
      const d = await getJson<Payload>(`https://i.instagram.com/api/v1/oembed/?url=${encodeURIComponent(url)}`);
      if (!d?.author_name) return null;
      return {
        title: `@${plain(d.author_name)}`,
        url,
        body: plain(d.title, 1000),
        images: [d.thumbnail_url].filter(https),
        attachImages: true,
        openLabel: 'Ouvrir Instagram',
      };
    },
  },
  {
    // Les vidéos gardent l'aperçu natif de Discord, lisible dans le salon.
    kind: 'youtube_channel',
    hosts: ['youtube.com'],
    match: (p) => {
      if (p.length === 1 && /^@[\w.-]{3,30}$/.test(p[0])) return [p[0]];
      if (p.length === 2 && p[0] === 'channel' && /^UC[\w-]{22}$/.test(p[1])) return [p[1]];
      return null;
    },
    async load(ref) {
      // Avec la clé, un seul appel rend le nom, la description, l'avatar et les chiffres.
      type Payload = { items?: {
        id: string;
        snippet?: { title?: string; description?: string; thumbnails?: Record<string, { url?: string } | undefined> };
        statistics?: { subscriberCount?: string; videoCount?: string; viewCount?: string };
      }[] };
      const key = process.env.YOUTUBE_API_KEY;
      const filter = ref.startsWith('@') ? `forHandle=${encodeURIComponent(ref)}` : `id=${ref}`;
      const item = key
        ? (await getJson<Payload>(`https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&${filter}&key=${key}`))?.items?.[0]
        : undefined;
      if (item) {
        const s = item.statistics;
        const t = item.snippet?.thumbnails;
        return {
          title: plain(item.snippet?.title || ref),
          url: `https://www.youtube.com/channel/${item.id}`,
          body: plain(item.snippet?.description, 400),
          stats: s && `👥 **${count(s.subscriberCount)}** abonnés · 🎬 **${count(s.videoCount)}** vidéos · 👁️ **${count(s.viewCount)}** vues`,
          thumbnail: [t?.high?.url, t?.medium?.url, t?.default?.url].find(https),
          openLabel: 'Ouvrir YouTube',
        };
      }
      // Sans clé (ou quota épuisé) : pages publiques, donc ni description ni chiffres.
      const channel = await resolveYoutubeChannel(ref);
      if (!channel) return null;
      return {
        title: plain(channel.channelName),
        url: `https://www.youtube.com/channel/${channel.channelId}`,
        thumbnail: (await fetchChannelAvatar(channel.channelId)) ?? undefined,
        openLabel: 'Ouvrir YouTube',
      };
    },
  },
  {
    kind: 'steam',
    hosts: ['store.steampowered.com'],
    match: (p) => (p[0] === 'app' && DIGITS.test(p[1] ?? '') ? [p[1]] : null),
    async load(id) {
      type Payload = Record<string, { success: boolean; data?: {
        name: string; short_description?: string; header_image?: string; is_free?: boolean;
        price_overview?: { final_formatted?: string; discount_percent?: number };
        release_date?: { date?: string }; recommendations?: { total?: number }; metacritic?: { score?: number };
        genres?: { description: string }[];
      } }>;
      const g = (await getJson<Payload>(`https://store.steampowered.com/api/appdetails?appids=${id}&l=french&cc=fr&filters=basic,price_overview,release_date,recommendations,metacritic,genres`))?.[id]?.data;
      if (!g) return null;
      const price = g.is_free ? 'Gratuit' : g.price_overview?.final_formatted;
      const discount = g.price_overview?.discount_percent ? ` (−${g.price_overview.discount_percent} %)` : '';
      return {
        title: plain(g.name),
        url: `https://store.steampowered.com/app/${id}/`,
        meta: join(g.release_date?.date, ...(g.genres ?? []).slice(0, 4).map((x) => plain(x.description))),
        body: plain(g.short_description),
        stats: join(
          price && `💶 **${plain(price)}**${discount}`,
          g.recommendations?.total ? `👍 **${count(g.recommendations.total)}** recommandations` : null,
          g.metacritic?.score ? `Metacritic **${g.metacritic.score}**` : null,
        ),
        images: [g.header_image].filter(https),
        openLabel: 'Ouvrir Steam',
      };
    },
  },
  {
    kind: 'npm',
    hosts: ['npmjs.com'],
    match: (p) => {
      const name = p.slice(1, p[1]?.startsWith('@') ? 3 : 2).join('/');
      return p[0] === 'package' && name.length <= 214 && NPM_NAME.test(name) ? [name] : null;
    },
    async load(name) {
      type Payload = { name: string; version: string; description?: string; license?: string };
      const [pkg, dl] = await Promise.all([
        getJson<Payload>(`https://registry.npmjs.org/${name.replace('/', '%2f')}/latest`),
        getJson<{ downloads?: number }>(`https://api.npmjs.org/downloads/point/last-week/${name}`),
      ]);
      if (!pkg) return null;
      return {
        title: plain(pkg.name),
        url: `https://www.npmjs.com/package/${name}`,
        meta: join(`v${plain(pkg.version, 40)}`, typeof pkg.license === 'string' && plain(pkg.license, 40)),
        body: plain(pkg.description),
        stats: `📦 **${count(dl?.downloads)}** téléchargements cette semaine`,
        openLabel: 'Ouvrir npm',
      };
    },
  },
  {
    kind: 'pypi',
    hosts: ['pypi.org'],
    match: (p) => (p[0] === 'project' && SLUG.test(p[1] ?? '') ? [p[1]] : null),
    async load(name) {
      type Payload = { info?: { name: string; version: string; summary?: string; license?: string; license_expression?: string; requires_python?: string } };
      const info = (await getJson<Payload>(`https://pypi.org/pypi/${name}/json`))?.info;
      if (!info) return null;
      return {
        title: plain(info.name),
        url: `https://pypi.org/project/${name}/`,
        meta: join(`v${plain(info.version, 40)}`, plain(info.license_expression || info.license, 40), info.requires_python && `Python ${plain(info.requires_python, 40)}`),
        body: plain(info.summary),
        openLabel: 'Ouvrir PyPI',
      };
    },
  },
  {
    kind: 'crate',
    hosts: ['crates.io'],
    match: (p) => (p[0] === 'crates' && SLUG.test(p[1] ?? '') ? [p[1]] : null),
    async load(name) {
      type Payload = { crate?: { name: string; description?: string; downloads?: number; max_stable_version?: string; default_version?: string; updated_at?: string } };
      const c = (await getJson<Payload>(`https://crates.io/api/v1/crates/${name}?include=`))?.crate;
      if (!c) return null;
      return {
        title: plain(c.name),
        url: `https://crates.io/crates/${name}`,
        meta: join((c.max_stable_version ?? c.default_version) && `v${plain(c.max_stable_version ?? c.default_version, 40)}`, c.updated_at && `Mise à jour ${date(c.updated_at)}`),
        body: plain(c.description),
        stats: `📦 **${count(c.downloads)}** téléchargements`,
        openLabel: 'Ouvrir crates.io',
      };
    },
  },
  {
    kind: 'huggingface',
    hosts: ['huggingface.co'],
    match: (p) => (p.length === 2 && SLUG.test(p[0]) && SLUG.test(p[1]) && !HF_RESERVED.has(p[0].toLowerCase()) ? [p[0], p[1]] : null),
    async load(org, model) {
      type Payload = { id: string; downloads?: number; likes?: number; pipeline_tag?: string; library_name?: string; lastModified?: string };
      const m = await getJson<Payload>(`https://huggingface.co/api/models/${org}/${model}?expand[]=downloads&expand[]=likes&expand[]=pipeline_tag&expand[]=library_name&expand[]=lastModified`);
      if (!m?.id) return null;
      return {
        title: plain(m.id),
        url: `https://huggingface.co/${org}/${model}`,
        meta: join(plain(m.pipeline_tag, 60), plain(m.library_name, 60), m.lastModified && `Mis à jour ${date(m.lastModified)}`),
        stats: `📥 **${count(m.downloads)}** téléchargements sur 30 jours · ❤️ **${count(m.likes)}**`,
        openLabel: 'Ouvrir Hugging Face',
      };
    },
  },
  {
    kind: 'stackoverflow',
    hosts: ['stackoverflow.com'],
    match: (p) => (p[0] === 'questions' && DIGITS.test(p[1] ?? '') ? [p[1]] : null),
    async load(id) {
      type Payload = { items?: { title: string; link: string; score: number; answer_count: number; view_count: number; is_answered: boolean; tags?: string[] }[] };
      // Sans clé : 300 appels par jour et par IP. Avec : 10 000.
      const key = process.env.STACKEXCHANGE_KEY;
      const q = (await getJson<Payload>(`https://api.stackexchange.com/2.3/questions/${id}?site=stackoverflow${key ? `&key=${encodeURIComponent(key)}` : ''}`))?.items?.[0];
      if (!q) return null;
      return {
        title: plain(q.title, 200),
        url: `https://stackoverflow.com/questions/${id}`,
        meta: join(q.is_answered ? '✅ Résolue' : 'Sans réponse acceptée', ...(q.tags ?? []).slice(0, 5).map((t) => `#${plain(t, 40)}`)),
        stats: `▲ **${count(q.score)}** · 💬 **${count(q.answer_count)}** réponses · 👁️ **${count(q.view_count)}** vues`,
        openLabel: 'Ouvrir Stack Overflow',
      };
    },
  },
];

export function parseRichLink(raw: string): RichLinkTarget | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
  const parts = url.pathname.split('/').filter(Boolean);
  for (const provider of PROVIDERS) {
    if (!provider.hosts.includes(host)) continue;
    const args = provider.match(parts);
    if (args) return { kind: provider.kind, args };
  }
  return null;
}

/** Premier lien pris en charge du message. Un lien entre chevrons a été masqué exprès : on le laisse. */
export function findRichLink(content: string): RichLinkTarget | null {
  for (const match of content.matchAll(/(?<!<)https?:\/\/[^\s<>]+/g)) {
    const target = parseRichLink(match[0].replace(/[)\].,!?]+$/, ''));
    if (target) return target;
  }
  return null;
}

// Une carte vaut 30 min. Un échec (lien introuvable, service en panne) vaut 2 min :
// assez pour ne pas redemander à chaque message, assez peu pour se rattraper vite.
// Au plus 4 recherches sortantes à la fois ; les suivantes attendent leur tour.
const loadQueue = pLimit(4);
const CARD_TTL_S = 30 * 60;
const MISS_TTL_S = 2 * 60;
const MISS = { miss: true } as const;

export async function loadRichLinkCard(target: RichLinkTarget): Promise<RichLinkCard | null> {
  const provider = PROVIDERS.find((p) => p.kind === target.kind)!;
  const key = `richlink:${target.kind}:${target.args.join(':')}`;
  const hit = await cache.wrap<RichLinkCard | typeof MISS | null>(key, CARD_TTL_S, async () => {
    const card = await loadQueue(() => provider.load(...target.args));
    if (!card) await cache.set(key, MISS, MISS_TTL_S);
    return card;
  });
  return hit && !('miss' in hit) ? hit : null;
}

export function buildRichLinkContainer(card: RichLinkCard): ContainerBuilder {
  const text = [`### [${card.title}](${card.url})`, card.meta, card.body].filter(Boolean).join('\n');
  const container = new ContainerBuilder();

  if (card.thumbnail) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(text))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(card.thumbnail)),
    );
  } else {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  }
  if (card.images?.length) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(...card.images.map((url) => new MediaGalleryItemBuilder().setURL(url))),
    );
  }
  if (card.stats) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(card.stats));
  }
  return container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(card.openLabel).setURL(card.url),
    ),
  );
}

// L'adresse d'image vient d'un service tiers : on ne télécharge que depuis les CDN attendus.
const ATTACHABLE_HOST = /(^|\.)(tiktokcdn(-\w+)?\.com|cdninstagram\.com|fbcdn\.net)$/;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

async function downloadImage(url: string, name: string): Promise<AttachmentBuilder | null> {
  try {
    if (!ATTACHABLE_HOST.test(new URL(url).hostname)) return null;
    const res = await fetchExternal(url, { redirect: 'error' });
    if (!res.ok || !res.headers.get('content-type')?.startsWith('image/')) return null;
    const data = Buffer.from(await res.arrayBuffer());
    return data.length <= MAX_IMAGE_BYTES ? new AttachmentBuilder(data, { name }) : null;
  } catch {
    return null;
  }
}

// shortcut: une carte toutes les 5 s par serveur, en mémoire du processus ; à passer
// dans le cache partagé si le quota GitHub (commun au suivi de dépôts) vient à manquer.
const GUILD_COOLDOWN_MS = 5_000;
const lastCardAt = new Map<string, number>();

export async function handleRichLink(message: Message): Promise<void> {
  if (!message.inGuild() || message.author.bot || !message.content) return;
  const target = findRichLink(message.content);
  if (!target) return;

  const now = Date.now();
  if (now - (lastCardAt.get(message.guildId) ?? 0) < GUILD_COOLDOWN_MS) return;
  lastCardAt.set(message.guildId, now);

  let card = await loadRichLinkCard(target);
  if (!card) return;

  const files: AttachmentBuilder[] = [];
  if (card.attachImages && card.images?.length) {
    const downloaded = await Promise.all(card.images.map((url, i) => downloadImage(url, `apercu-${i}.jpg`)));
    files.push(...downloaded.filter((f): f is AttachmentBuilder => f !== null));
    card = { ...card, images: files.map((f) => `attachment://${f.name}`) };
  }

  await message.reply({
    components: [buildRichLinkContainer(card)],
    files,
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [], repliedUser: false },
  });
  // Sans « Gérer les messages », l'aperçu natif reste à côté de la carte : rien de grave.
  await message.suppressEmbeds(true).catch(() => null);
}
