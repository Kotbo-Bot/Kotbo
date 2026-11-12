/**
 * Les pages que « Importer les modules » crée dans la console admin
 * (`/admin/feature-pages`) : une par module du registre, hors modules `core`.
 *
 * Les noms sont ceux du catalogue de kotbo.fr (`Modules.svelte` du site
 * vitrine), en français et en anglais : c'est par eux que le catalogue relie un
 * module à sa page. La description française est celle de `MODULE_REGISTRY` ;
 * l'anglaise en est la traduction.
 *
 * Ces pages naissent en brouillon : une phrase de description ne fait pas une
 * page qu'on publie. Un administrateur les rédige, puis les publie. Seules
 * celles de `featurePageRichSeeds.ts`, déjà rédigées pour le site, naissent
 * publiées.
 */
import { MODULE_REGISTRY } from '@kotbo/contracts';

export interface FeaturePageSeedModule {
  key: string;
  slug: { fr: string; en: string };
  name: { fr: string; en: string };
  description: { fr: string; en: string };
}

/** Ce que le registre ne dit pas : le nom anglais, la traduction, les adresses. */
const MODULE_SEO: Record<string, { slug: { fr: string; en: string }; nameFr?: string; nameEn: string; descriptionEn: string }> = {
  sanctions: {
    slug: { fr: 'sanctions-discord', en: 'discord-sanctions' },
    nameEn: 'Sanctions',
    descriptionEn: 'Warnings, mutes, bans, member records and sanction reports.',
  },
  automod: {
    slug: { fr: 'automod-discord', en: 'discord-automod' },
    nameEn: 'AutoMod',
    descriptionEn: 'Automatic filtering: spam, links, caps, mentions, banned words.',
  },
  logs: {
    slug: { fr: 'logs-discord', en: 'discord-logs' },
    nameEn: 'Discord logs',
    descriptionEn: 'Discord event logs: messages, channels, roles, members.',
  },
  nickname_moderation: {
    slug: { fr: 'moderation-pseudos-discord', en: 'discord-nickname-moderation' },
    nameEn: 'Nickname moderation',
    descriptionEn: 'Detection and automatic renaming of non-compliant nicknames.',
  },
  double_accounts: {
    slug: { fr: 'detection-doubles-comptes', en: 'alt-account-detection' },
    nameEn: 'Alt accounts',
    descriptionEn: 'Detection of multiple accounts and matching of identities.',
  },
  raid_protection: {
    slug: { fr: 'protection-anti-raid-discord', en: 'discord-anti-raid' },
    nameEn: 'Anti-raid protection',
    descriptionEn: 'Detection of join waves and automatic server lockdown.',
  },
  ban_appeals: {
    slug: { fr: 'appels-de-bannissement', en: 'discord-ban-appeals' },
    nameEn: 'Ban appeals',
    descriptionEn: 'Public appeal form and handling of requests.',
  },
  codepolice: {
    slug: { fr: 'code-police', en: 'code-police' },
    nameEn: 'Police Code',
    descriptionEn: 'Syntax and best-practice checks on code snippets.',
  },
  security_verification: {
    slug: { fr: 'verification-captcha-discord', en: 'discord-captcha-verification' },
    nameEn: 'Security verification',
    descriptionEn: 'Captcha and verification flow when members join.',
  },
  recruitment: {
    slug: { fr: 'recrutement-staff-discord', en: 'discord-staff-recruitment' },
    nameEn: 'Recruitment',
    descriptionEn: 'Staff applications, forms and interview tracking.',
  },
  staff_directory: {
    slug: { fr: 'annuaire-staff', en: 'staff-directory' },
    nameEn: 'Staff directory',
    descriptionEn: 'List, profiles and statistics of the team members.',
  },
  staff_roles: {
    slug: { fr: 'hierarchie-roles-staff', en: 'staff-hierarchy-roles' },
    nameEn: 'Staff hierarchy & roles',
    descriptionEn: 'Ranks, promotions and staff role synchronization.',
  },
  tutoring: {
    slug: { fr: 'tutorat-formation-staff', en: 'staff-mentoring-training' },
    nameEn: 'Mentoring & training',
    descriptionEn: 'Trial periods, mentoring and follow-up of new staff.',
  },
  meetings: {
    slug: { fr: 'reunions-staff', en: 'staff-meetings' },
    nameEn: 'Meetings',
    descriptionEn: 'Scheduling, invitations and minutes of team meetings.',
  },
  absences: {
    slug: { fr: 'absences-staff', en: 'staff-leave' },
    nameEn: 'Leave',
    descriptionEn: 'Reporting and tracking of staff leave and unavailability.',
  },
  polls: {
    slug: { fr: 'sondages-staff', en: 'staff-polls' },
    nameEn: 'Staff polls',
    descriptionEn: 'Internal team consultations with voting and closing.',
  },
  discipline: {
    slug: { fr: 'discipline-staff', en: 'staff-discipline' },
    nameEn: 'Staff discipline',
    descriptionEn: 'Internal warnings, blacklist and sanctions for the team.',
  },
  evaluations: {
    slug: { fr: 'evaluations-staff', en: 'staff-reviews' },
    nameEn: 'Reviews',
    descriptionEn: 'Periodic reviews and ratings of team members.',
  },
  leveling: {
    slug: { fr: 'niveaux-xp', en: 'leveling-xp' },
    nameEn: 'Leveling & XP',
    descriptionEn: 'Text and voice experience, levels and reward roles.',
  },
  seasons: {
    slug: { fr: 'saisons-classement', en: 'leaderboard-seasons' },
    nameEn: 'Seasons',
    descriptionEn: 'Time-limited competitive leaderboards and end-of-season rewards.',
  },
  prestige: {
    slug: { fr: 'prestige', en: 'prestige' },
    nameEn: 'Prestige',
    descriptionEn: 'Prestige points, tiers, activity streaks and decay on inactivity.',
  },
  clans: {
    slug: { fr: 'clans-discord', en: 'discord-clans' },
    nameEn: 'Clans',
    descriptionEn: 'Member teams, collective points and an inter-clan leaderboard.',
  },
  drops: {
    slug: { fr: 'drops', en: 'drops' },
    nameEn: 'Drops',
    descriptionEn: 'Random gifts dropped in channels: XP, clan points or coins to grab.',
  },
  economy: {
    slug: { fr: 'economie-rpg-discord', en: 'discord-economy-rpg' },
    nameEn: 'Economy & RPG',
    descriptionEn: 'Currency, shop, items, games of chance and text adventures.',
  },
  marketplace: {
    slug: { fr: 'marche-entre-membres', en: 'member-marketplace' },
    nameEn: 'Member marketplace',
    descriptionEn: 'A marketplace where members trade items and currency.',
  },
  quests: {
    slug: { fr: 'quetes', en: 'quests' },
    nameEn: 'Quests',
    descriptionEn: 'Rewarded daily and weekly objectives.',
  },
  reputation: {
    slug: { fr: 'reputation', en: 'reputation' },
    nameEn: 'Reputation',
    descriptionEn: 'Recognition points given between members.',
  },
  fun: {
    slug: { fr: 'salons-fun', en: 'fun-channels' },
    nameEn: 'Fun channels',
    descriptionEn: 'Counting, one-word story, mystery number and channel mini-games.',
  },
  daily_algo: {
    slug: { fr: 'daily-algo', en: 'daily-algo' },
    nameEn: 'Daily Algo',
    descriptionEn: 'Daily algorithm challenge, submissions and a weekly leaderboard.',
  },
  tickets: {
    slug: { fr: 'tickets-discord', en: 'discord-tickets' },
    nameEn: 'Support tickets',
    descriptionEn: 'Support system with categories, claiming and transcripts.',
  },
  giveaways: {
    slug: { fr: 'giveaways-discord', en: 'discord-giveaways' },
    nameEn: 'Giveaways',
    descriptionEn: 'Contests and draws with button entry.',
  },
  events: {
    slug: { fr: 'evenements-quiz', en: 'events-quizzes' },
    nameEn: 'Events & quizzes',
    descriptionEn: 'Organizing quizzes and community events.',
  },
  suggestions: {
    slug: { fr: 'suggestions', en: 'suggestions' },
    nameEn: 'Suggestions',
    descriptionEn: 'Idea box with votes and staff replies.',
  },
  starboard: {
    slug: { fr: 'starlight', en: 'starlight' },
    nameEn: 'Starlight',
    descriptionEn: 'Highlighting popular messages in a dedicated channel.',
  },
  regulation: {
    slug: { fr: 'reglement-discord', en: 'discord-rules' },
    nameEn: 'Rules',
    descriptionEn: 'Writing, publishing and accepting the server rules.',
  },
  welcome_goodbye: {
    slug: { fr: 'message-de-bienvenue-discord', en: 'discord-welcome-messages' },
    nameEn: 'Welcome & leave',
    descriptionEn: 'Welcome and goodbye messages, menu and welcome thread.',
  },
  reaction_roles: {
    slug: { fr: 'roles-par-reaction', en: 'reaction-roles' },
    nameEn: 'Reaction roles',
    descriptionEn: 'Role assignment through clickable buttons.',
  },
  auto_responses: {
    slug: { fr: 'reponses-automatiques', en: 'auto-responses' },
    nameEn: 'Auto-responses',
    descriptionEn: 'Automatic replies triggered by keywords.',
  },
  auto_thread: {
    nameFr: 'Auto-thread & salons',
    slug: { fr: 'auto-thread-salons', en: 'auto-threads-channels' },
    nameEn: 'Auto-threads & channels',
    descriptionEn: 'Automatic threads, sticky messages, stat channels and temporary voice channels.',
  },
  news: {
    slug: { fr: 'actualites-rss', en: 'news-rss' },
    nameEn: 'News & RSS',
    descriptionEn: 'Articles published by staff and RSS feed generation.',
  },
  campaigns: {
    slug: { fr: 'campagnes', en: 'campaigns' },
    nameEn: 'Campaigns',
    descriptionEn: 'Sequences of scheduled messages sent to a targeted audience, with reach measurement.',
  },
  embed_builder: {
    slug: { fr: 'createur-embeds', en: 'embed-builder' },
    nameEn: 'Embed builder',
    descriptionEn: 'Composing and sending custom embeds.',
  },
  translation: {
    slug: { fr: 'traduction-automatique', en: 'automatic-translation' },
    nameEn: 'Automatic translation',
    descriptionEn: 'On-demand translation of messages into the configured language.',
  },
  digest: {
    slug: { fr: 'digest', en: 'digest' },
    nameEn: 'Digest',
    descriptionEn: 'Automatic summaries of server activity.',
  },
  custom_forms: {
    slug: { fr: 'formulaires-personnalises', en: 'custom-forms' },
    nameEn: 'Custom forms',
    descriptionEn: 'Tailor-made forms and response collection.',
  },
  analytics: {
    slug: { fr: 'statistiques-serveur-discord', en: 'discord-server-analytics' },
    nameEn: 'Analytics',
    descriptionEn: 'Collection and reporting of server activity statistics.',
  },
  youtube: {
    slug: { fr: 'notifications-youtube', en: 'youtube-notifications' },
    nameEn: 'YouTube',
    descriptionEn: 'Automatic notifications for new videos.',
  },
  twitch: {
    slug: { fr: 'notifications-twitch', en: 'twitch-notifications' },
    nameEn: 'Twitch',
    descriptionEn: 'Automatic notifications when going live.',
  },
  social_networks: {
    slug: { fr: 'reseaux-sociaux', en: 'social-media' },
    nameEn: 'Social media',
    descriptionEn: 'YouTube and Twitch accounts, GitHub and Hugging Face repositories followed by the server.',
  },
  workflows: {
    // Le catalogue de kotbo.fr l'appelle « Automatisations ».
    nameFr: 'Automatisations',
    slug: { fr: 'automatisations', en: 'automations' },
    nameEn: 'Automations',
    descriptionEn: 'Trigger → action sequences set up without code.',
  },
  channel_health: {
    slug: { fr: 'sante-des-salons', en: 'channel-health' },
    nameEn: 'Channel health',
    descriptionEn: 'Detection of inactive or overloaded channels and archiving suggestions.',
  },
  bump_reminder: {
    slug: { fr: 'rappel-de-bump', en: 'bump-reminder' },
    nameEn: 'Bump reminder',
    descriptionEn: 'Automatically detects bumps (Disboard, Discadia, DS.me, Disforge...) and reminds you as soon as the server can bump again.',
  },
  rich_links: {
    slug: { fr: 'apercus-de-liens', en: 'link-previews' },
    nameEn: 'Link previews',
    descriptionEn: 'Replies to GitHub, X, Bluesky, TikTok, Instagram, YouTube, Steam, npm and other links with a card: description, figures, image and a button to open it.',
  },
  channel_links: {
    slug: { fr: 'liens-de-salons', en: 'channel-links' },
    nameEn: 'Channel links',
    descriptionEn: 'Message synchronization between channels on several servers.',
  },
  partnerships: {
    slug: { fr: 'partenariats', en: 'partnerships' },
    nameEn: 'Partnerships',
    descriptionEn: 'Partners, agreements, granted perks, cross-promotion and measured results.',
  },
  staff_server: {
    slug: { fr: 'serveur-staff', en: 'staff-server' },
    nameEn: 'Staff server',
    descriptionEn: 'A server dedicated to the team, with synchronized hierarchy and roles.',
  },
};

/**
 * Les modules à importer, dans l'ordre du registre. Un module ajouté au
 * registre sans entrée dans `MODULE_SEO` est ignoré : il n'a pas encore
 * d'adresse ni de nom anglais.
 */
export function featurePageSeedModules(): FeaturePageSeedModule[] {
  return MODULE_REGISTRY.filter((module) => !module.core && !module.paused && MODULE_SEO[module.key]).map((module) => {
    const seo = MODULE_SEO[module.key];
    return {
      key: module.key,
      slug: seo.slug,
      name: { fr: seo.nameFr ?? module.name, en: seo.nameEn },
      description: { fr: module.description, en: seo.descriptionEn },
    };
  });
}

/** Les modules du registre (hors cœur) qui n'ont pas encore d'entrée ici. */
export function modulesWithoutSeed(): string[] {
  return MODULE_REGISTRY.filter((module) => !module.core && !MODULE_SEO[module.key]).map((module) => module.key);
}
