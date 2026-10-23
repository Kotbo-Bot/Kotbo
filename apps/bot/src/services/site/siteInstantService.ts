/**
 * Site instantané : le site existe dès que Kotbo arrive sur un serveur.
 *
 * Personne n'a à choisir un modèle ni une adresse. Le type de communauté est
 * deviné d'après le nom, la description et les salons ; l'adresse vient du
 * nom ; le salon d'annonces est repéré et ses derniers messages deviennent
 * les premiers articles. Le site reste hors ligne : le propriétaire le
 * découvre en aperçu privé et le met en ligne d'un clic.
 *
 * Rien n'est publié sans lui, et seuls des salons que `@everyone` voit
 * alimentent le site.
 */

import { ChannelType, type Client, type Guild, type GuildBasedChannel, type Message } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { isPubliclyVisible } from './blocks/discordBlocks.js';
import { createSite, suggestSiteSlug, updateSite, SiteAdminError } from './siteAdminService.js';
import { handleAnnouncementMessage, invalidateSiteAuto } from './siteAutoService.js';
import { autoMirrorPublicForums } from './siteForumService.js';
import type { SiteTemplateKey } from './siteTemplates.js';

/** Mots qui trahissent un type de communauté, comparés sans accents ni casse. */
const SIGNALS: Record<Exclude<SiteTemplateKey, 'general'>, string[]> = {
  rp: ['rp', 'hrp', 'roleplay', 'role-play', 'lore', 'fiche', 'fiches', 'personnage', 'personnages', 'background', 'univers', 'royaume', 'guilde', 'quete'],
  esport: ['esport', 'e-sport', 'esports', 'scrim', 'scrims', 'roster', 'competitif', 'competitive', 'ranked', 'tournoi', 'tournois', 'tournament', 'valorant', 'cs2', 'csgo', 'lol', 'overwatch', 'rocket', 'coaching', 'line-up', 'lineup'],
  gaming: ['gaming', 'gamer', 'gamers', 'jeu', 'jeux', 'game', 'games', 'minecraft', 'fortnite', 'gta', 'roblox', 'apex', 'warzone', 'lfg', 'partie', 'parties', 'steam', 'switch', 'playstation', 'xbox', 'mods', 'serveur-mc'],
  etude: ['etude', 'etudes', 'study', 'studies', 'cours', 'devoirs', 'revision', 'revisions', 'bac', 'prepa', 'fac', 'universite', 'lycee', 'college', 'maths', 'physique', 'homework', 'examens', 'partiels', 'entraide-scolaire'],
};

function fold(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function tokens(value: string): string[] {
  // « fiches-personnages » compte pour lui-même et pour chacune de ses parties.
  return fold(value).split(/[^a-z0-9-]+/).flatMap((t) => (t.includes('-') ? [t, ...t.split('-')] : [t])).filter(Boolean);
}

/**
 * Type de communauté le plus probable. Le nom et la description pèsent
 * double ; il faut au moins deux indices pour quitter le modèle général.
 */
export function guessSiteTemplate(input: { name: string; description?: string | null; channels: string[] }): SiteTemplateKey {
  const scores: Record<string, number> = { rp: 0, esport: 0, gaming: 0, etude: 0 };
  const count = (words: string[], weight: number) => {
    for (const word of words) {
      for (const [key, signals] of Object.entries(SIGNALS)) if (signals.includes(word)) scores[key] += weight;
    }
  };
  count(tokens(`${input.name} ${input.description ?? ''}`), 2);
  count(input.channels.flatMap(tokens), 1);
  // À égalité, le plus spécifique l'emporte : un serveur RP ou esport est aussi un serveur de jeu.
  const order: Array<Exclude<SiteTemplateKey, 'general'>> = ['rp', 'esport', 'etude', 'gaming'];
  const best = order.reduce((a, b) => (scores[b] > scores[a] ? b : a));
  return scores[best] >= 2 ? best : 'general';
}

const ANNOUNCE_NAME = /(annonce|announce|news|nouveaut|actu|infos?$|changelog|mises?-a-jour|updates?)/;

/** Salons d'annonces publics : salons « Annonces » de Discord, puis salons qui en portent le nom. */
export function detectAnnouncementChannels(guild: Guild): string[] {
  const candidates = guild.channels.cache.filter(
    (c): c is Extract<GuildBasedChannel, { type: ChannelType.GuildText | ChannelType.GuildAnnouncement }> =>
      (c.type === ChannelType.GuildAnnouncement || (c.type === ChannelType.GuildText && ANNOUNCE_NAME.test(fold(c.name)))) && isPubliclyVisible(guild, c, true),
  );
  return [...candidates.values()]
    .sort((a, b) => Number(b.type === ChannelType.GuildAnnouncement) - Number(a.type === ChannelType.GuildAnnouncement) || a.rawPosition - b.rawPosition)
    .slice(0, 3)
    .map((c) => c.id);
}

/** Dernières annonces reprises comme premiers articles, de la plus ancienne à la plus récente. */
async function backfillAnnouncements(client: Client, guild: Guild, channelIds: string[]): Promise<number> {
  const messages: Message[] = [];
  for (const id of channelIds) {
    const channel = guild.channels.cache.get(id);
    if (!channel?.isTextBased()) continue;
    const fetched = await channel.messages.fetch({ limit: 15 }).catch(() => null);
    if (fetched) messages.push(...fetched.values());
  }
  const recent = messages
    .filter((msg) => !msg.system && msg.author.id !== client.user?.id)
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
    .slice(0, 6)
    .reverse();
  let imported = 0;
  for (const message of recent) {
    const before = await prisma.siteAutoPost.count({ where: { key: `msg:${message.id}` } });
    await handleAnnouncementMessage(client, message).catch((err: unknown) => logger.debug('Site', `Annonce ${message.id} non reprise :`, err));
    if (before === 0 && (await prisma.siteAutoPost.count({ where: { key: `msg:${message.id}` } })) > 0) imported += 1;
  }
  return imported;
}

export interface InstantSiteResult {
  siteId: string;
  slug: string;
  created: boolean;
  template: SiteTemplateKey;
  articles: number;
}

const inFlight = new Map<string, Promise<InstantSiteResult | null>>();

/**
 * Le site du serveur, créé à la volée s'il n'existe pas encore. Hors ligne à
 * la création. Deux appels simultanés (arrivée du bot et ouverture du
 * dashboard) partagent la même création.
 */
export function ensureInstantSite(client: Client, guildId: string, userId?: string): Promise<InstantSiteResult | null> {
  const pending = inFlight.get(guildId);
  if (pending) return pending;
  const run = createInstantSite(client, guildId, userId).finally(() => inFlight.delete(guildId));
  inFlight.set(guildId, run);
  return run;
}

async function createInstantSite(client: Client, guildId: string, userId?: string): Promise<InstantSiteResult | null> {
  const existing = await prisma.communitySite.findUnique({ where: { guildId }, select: { id: true, slug: true, theme: true } });
  if (existing) return { siteId: existing.id, slug: existing.slug, created: false, template: 'general', articles: 0 };
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;

  const channelNames = guild.channels.cache.filter((c) => isPubliclyVisible(guild, c)).map((c) => c.name);
  const template = guessSiteTemplate({ name: guild.name, description: guild.description, channels: channelNames });
  const announceIds = detectAnnouncementChannels(guild);

  let site;
  try {
    site = await createSite(client, guildId, userId ?? guild.ownerId, { slug: await suggestSiteSlug(guild.name), template });
  } catch (err) {
    // Création concurrente depuis une autre instance : le site existe, c'est ce qu'on voulait.
    if (err instanceof SiteAdminError && err.code === 'site_exists') {
      const again = await prisma.communitySite.findUnique({ where: { guildId }, select: { id: true, slug: true } });
      return again ? { siteId: again.id, slug: again.slug, created: false, template, articles: 0 } : null;
    }
    throw err;
  }

  await updateSite(guildId, {
    ...(guild.description ? { tagline: guild.description.slice(0, 200) } : {}),
    settings: {
      auto: {
        announcements: { enabled: announceIds.length > 0, channelIds: announceIds },
        modulePages: { enabled: true },
        weeklySummary: { enabled: true },
      },
    },
  });
  await invalidateSiteAuto(guildId);
  // Forums Discord publics recopiés : leurs fils deviennent des sujets trouvables sur le web.
  const forums = await autoMirrorPublicForums(client, guildId).catch(() => 0);
  if (forums > 0) {
    const current = await prisma.communitySite.findUnique({ where: { id: site.id }, select: { navigation: true } });
    const navigation = Array.isArray(current?.navigation) ? [...(current.navigation as object[])] : [];
    if (navigation.length > 0 && navigation.length < 12) {
      navigation.push({ id: 'nav-auto-forum', label: 'Forum', target: { type: 'section', section: 'forum' }, children: [] });
      await prisma.communitySite.update({ where: { id: site.id }, data: { navigation } });
    }
  }
  const articles = announceIds.length ? await backfillAnnouncements(client, guild, announceIds).catch(() => 0) : 0;
  logger.info('Site', `Site instantané prêt pour ${guildId} : /s/${site.slug} (${template}, ${articles} article(s) repris, ${forums} forum(s) recopié(s))`);
  return { siteId: site.id, slug: site.slug, created: true, template, articles };
}
