/**
 * Les données de départ de la démo, écrites à la main.
 *
 * Un seul serveur, « Atelier Nova », raconte une histoire cohérente d'une page
 * à l'autre : Vantar, averti pour spam, se retrouve dans les sanctions, dans
 * sa fiche membre et dans les logs ; Lina, qui a ouvert le ticket #0147, est
 * aussi en tête du classement. Tout est fictif, et le bandeau de la démo le
 * dit.
 *
 * Les formes suivent les types de `@kotbo/contracts` et les routes du bot :
 * c'est le vrai dashboard qui les lit, il n'a pas été adapté à la démo.
 */
import { MODULE_REGISTRY } from '@kotbo/contracts';
import { DEMO_GUILD_ID, DEMO_GUILD_NAME, DEMO_USER_ID, DEMO_USERNAME } from './mode';

/** Instant de référence de la démo : les dates se lisent « il y a 2 jours », pas une date figée. */
const NOW = Date.now();
export const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const HOUR = 60;
const DAY = 24 * HOUR;

// ── Rôles ──────────────────────────────────────────────────────────────

export const ROLES = [
  { id: '900000000000000201', name: 'Fondateur', color: '#f0b232', position: 10, permissions: ['Administrator'] },
  { id: '900000000000000202', name: 'Admin', color: '#da373c', position: 9, permissions: ['Administrator'] },
  { id: '900000000000000203', name: 'Modérateur', color: '#5865f2', position: 8, permissions: ['ModerateMembers', 'KickMembers', 'BanMembers', 'ManageMessages'] },
  { id: '900000000000000204', name: 'Helper', color: '#23a55a', position: 7, permissions: ['ManageMessages'] },
  { id: '900000000000000205', name: 'Habitué', color: '#eb459e', position: 5, permissions: [] },
  { id: '900000000000000206', name: 'Membre', color: '#949ba4', position: 2, permissions: [] },
  { id: '900000000000000207', name: 'Kotbo', color: '#22d3ee', position: 11, permissions: ['Administrator'], managed: true },
  { id: '900000000000000221', name: 'Valorant', color: '#ff4655', position: 3, permissions: [] },
  { id: '900000000000000222', name: 'Minecraft', color: '#62b47a', position: 3, permissions: [] },
  { id: '900000000000000223', name: 'League of Legends', color: '#c8aa6e', position: 3, permissions: [] },
  { id: '900000000000000224', name: 'Rocket League', color: '#0082ff', position: 3, permissions: [] },
  { id: '900000000000000225', name: 'Annonces', color: '#f0b232', position: 1, permissions: [] },
  { id: '900000000000000226', name: 'Événements', color: '#eb459e', position: 1, permissions: [] },
  { id: '900000000000000231', name: 'Phénix', color: '#f97316', position: 4, permissions: [] },
  { id: '900000000000000232', name: 'Kraken', color: '#0ea5e9', position: 4, permissions: [] },
  { id: '900000000000000233', name: 'Griffon', color: '#eab308', position: 4, permissions: [] },
  { id: '900000000000000234', name: 'Hydre', color: '#22c55e', position: 4, permissions: [] },
].map((role) => ({ ...role, mention: `<@&${role.id}>`, managed: role.managed ?? false }));

export const role = (name: string) => ROLES.find((r) => r.name === name)!;

// ── Salons ─────────────────────────────────────────────────────────────

const channel = (id: string, name: string, type: 'text' | 'voice' | 'announcement' | 'forum' = 'text') => ({
  id,
  name,
  mention: type === 'voice' ? name : `<#${id}>`,
  type,
});

export const CATEGORIES = [
  channel('900000000000000300', 'ACCUEIL'),
  channel('900000000000000301', 'DISCUSSIONS'),
  channel('900000000000000302', 'SUPPORT'),
  channel('900000000000000303', 'ÉQUIPE'),
];

export const CHANNELS = [
  channel('900000000000000310', 'bienvenue'),
  channel('900000000000000311', 'règlement'),
  channel('900000000000000312', 'annonces', 'announcement'),
  channel('900000000000000313', 'général'),
  channel('900000000000000314', 'recherche-de-groupe'),
  channel('900000000000000315', 'niveaux'),
  channel('900000000000000316', 'boutique'),
  channel('900000000000000317', 'ouvrir-un-ticket'),
  channel('900000000000000318', 'staff'),
  channel('900000000000000319', 'logs'),
  channel('900000000000000320', 'suggestions', 'forum'),
];

export const VOICE_CHANNELS = [channel('900000000000000330', 'Squad', 'voice'), channel('900000000000000331', 'Réunion staff', 'voice')];

export const channelByName = (name: string) => CHANNELS.find((c) => c.name === name)!;

// ── Personnes ──────────────────────────────────────────────────────────

export type DemoPerson = {
  id: string;
  username: string;
  displayName: string;
  roles: string[];
  joinedMinutesAgo: number;
  messages: number;
  voiceMinutes: number;
  level: number;
  xp: number;
  coins: number;
  status: 'online' | 'idle' | 'dnd' | 'offline';
  bot?: boolean;
};

const person = (n: number, username: string, displayName: string, roles: string[], extra: Partial<DemoPerson>): DemoPerson => ({
  id: `9000000000000004${String(n).padStart(2, '0')}`,
  username,
  displayName,
  roles: roles.map((name) => role(name).id),
  joinedMinutesAgo: 30 * DAY,
  messages: 120,
  voiceMinutes: 90,
  level: 4,
  xp: 2_400,
  coins: 300,
  status: 'offline',
  ...extra,
});

/** La personne connectée : administratrice du serveur de démo. */
export const ME: DemoPerson = {
  id: DEMO_USER_ID,
  username: DEMO_USERNAME,
  displayName: 'Toi',
  roles: [role('Admin').id],
  joinedMinutesAgo: 400 * DAY,
  messages: 2_140,
  voiceMinutes: 3_100,
  level: 18,
  xp: 39_600,
  coins: 1_250,
  status: 'online',
};

export const PEOPLE: DemoPerson[] = [
  ME,
  person(1, 'arka', 'Arka', ['Fondateur'], { joinedMinutesAgo: 620 * DAY, messages: 9_870, voiceMinutes: 12_400, level: 31, xp: 108_000, coins: 4_200, status: 'online' }),
  person(2, 'lena', 'Lena', ['Admin'], { joinedMinutesAgo: 540 * DAY, messages: 7_420, voiceMinutes: 8_900, level: 27, xp: 83_000, coins: 2_900, status: 'online' }),
  person(3, 'zenox', 'Zenox', ['Modérateur'], { joinedMinutesAgo: 380 * DAY, messages: 4_210, voiceMinutes: 5_200, level: 22, xp: 57_000, coins: 1_800, status: 'idle' }),
  person(4, 'aiden', 'Aiden', ['Modérateur'], { joinedMinutesAgo: 210 * DAY, messages: 2_980, voiceMinutes: 2_700, level: 19, xp: 43_000, coins: 1_100, status: 'online' }),
  person(5, 'kylian', 'Kylian', ['Helper'], { joinedMinutesAgo: 45 * DAY, messages: 640, voiceMinutes: 420, level: 9, xp: 9_900, coins: 600, status: 'dnd' }),
  person(6, 'lina', 'Lina', ['Habitué', 'Membre'], { joinedMinutesAgo: 300 * DAY, messages: 11_200, voiceMinutes: 6_300, level: 34, xp: 129_000, coins: 5_600, status: 'online' }),
  person(7, 'noe', 'Noé', ['Habitué', 'Membre'], { joinedMinutesAgo: 260 * DAY, messages: 8_150, voiceMinutes: 4_100, level: 29, xp: 95_000, coins: 3_100, status: 'online' }),
  person(8, 'maelle', 'Maëlle', ['Habitué', 'Membre'], { joinedMinutesAgo: 190 * DAY, messages: 6_020, voiceMinutes: 3_400, level: 26, xp: 77_000, coins: 2_300, status: 'idle' }),
  person(9, 'yanis', 'Yanis', ['Membre'], { joinedMinutesAgo: 90 * DAY, messages: 2_310, voiceMinutes: 1_900, level: 16, xp: 31_000, coins: 900, status: 'offline' }),
  person(10, 'ines', 'Inès', ['Membre'], { joinedMinutesAgo: 60 * DAY, messages: 1_420, voiceMinutes: 300, level: 12, xp: 17_000, coins: 700, status: 'online' }),
  person(11, 'sacha', 'Sacha', ['Membre'], { joinedMinutesAgo: 12 * DAY, messages: 230, voiceMinutes: 40, level: 5, xp: 3_100, coins: 250, status: 'offline' }),
  person(12, 'jade', 'Jade', ['Membre'], { joinedMinutesAgo: 2 * DAY, messages: 41, voiceMinutes: 0, level: 2, xp: 700, coins: 150, status: 'online' }),
  person(13, 'tom', 'Tom', ['Membre'], { joinedMinutesAgo: 3 * HOUR, messages: 4, voiceMinutes: 0, level: 1, xp: 60, coins: 150, status: 'online' }),
  person(14, 'vantar', 'Vantar', ['Membre'], { joinedMinutesAgo: 20 * DAY, messages: 880, voiceMinutes: 120, level: 8, xp: 8_200, coins: 400, status: 'offline' }),
  person(15, 'kyzo', 'Kyzo', ['Membre'], { joinedMinutesAgo: 35 * DAY, messages: 1_050, voiceMinutes: 500, level: 10, xp: 12_000, coins: 520, status: 'offline' }),
];

/**
 * Le reste du serveur : des membres sans histoire, générés une fois pour
 * toutes (même graine, même liste à chaque visite). Seize personnes feraient
 * un serveur vide ; ceux-ci peuplent les listes et les totaux, les
 * personnages ci-dessus portent l'histoire.
 */
const FIRST = ['Alex', 'Babette', 'Cyril', 'Dina', 'Eliott', 'Fanny', 'Gaël', 'Hugo', 'Iris', 'Jules', 'Kenza', 'Léo', 'Mila', 'Nael', 'Océane', 'Paul', 'Rose', 'Samy', 'Tess', 'Ugo', 'Victor', 'Wendy', 'Yasmine', 'Zoé'];
const SUFFIX = ['', '_off', '42', 'tv', 'xyz', '_fr', '07', 'dev', 'art', 'gg'];

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const CROWD: DemoPerson[] = (() => {
  const random = seeded(2026);
  return Array.from({ length: 132 }, (_, i) => {
    const first = FIRST[i % FIRST.length];
    const suffix = SUFFIX[Math.floor(random() * SUFFIX.length)];
    const level = Math.max(1, Math.round(random() ** 2 * 22));
    const status = (['online', 'idle', 'offline', 'offline', 'offline', 'dnd'] as const)[Math.floor(random() * 6)];
    return {
      id: `9000000000000${String(1000 + i).padStart(5, '0')}`,
      username: `${first.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')}${suffix}${i >= FIRST.length ? i : ''}`,
      displayName: `${first}${suffix}`,
      roles: [role(level >= 25 ? 'Habitué' : 'Membre').id],
      joinedMinutesAgo: Math.round(random() * 500 * DAY),
      messages: Math.round(level * level * 18 * (0.6 + random())),
      voiceMinutes: Math.round(level * 40 * random()),
      level,
      xp: Math.round(100 * level * level + 200 * level + random() * 400),
      coins: Math.round(150 + level * 60 * random()),
      status,
    };
  });
})();

/** Tout le serveur : les personnages d'abord, la foule ensuite. */
export const MEMBERS: DemoPerson[] = [...PEOPLE, ...CROWD];

export const personById = (id: string) => MEMBERS.find((p) => p.id === id);
export const personByName = (name: string) => PEOPLE.find((p) => p.displayName === name)!;

/** Avatar par défaut de Discord, local au navigateur : aucune image distante n'est chargée. */
export function avatarOf(p: DemoPerson): string | null {
  void p;
  return null;
}

// ── Session ────────────────────────────────────────────────────────────

export function sessionUser() {
  return { id: ME.id, username: ME.username, avatar: null, isBotAdmin: false };
}

export function sessionGuilds() {
  return [
    {
      id: DEMO_GUILD_ID,
      name: DEMO_GUILD_NAME,
      icon: null,
      owner: false,
      botPresent: true,
      accessLevel: 'admin' as const,
      isStaffServer: false,
      pairedGuildId: null,
      billingAccess: false,
    },
  ];
}

export function sessionMember() {
  return {
    id: ME.id,
    nickname: null,
    roles: ME.roles.map((id) => {
      const r = ROLES.find((x) => x.id === id)!;
      return { id: r.id, name: r.name, position: r.position, managed: r.managed };
    }),
    isTutor: false,
  };
}

// ── Modules ────────────────────────────────────────────────────────────

/** Modules éteints au départ : ceux qui demandent un compte externe ou une config qu'une démo n'a pas. */
// Tout est allumé : la démo montre chaque module en marche, aucun bandeau « désactivé ».
const OFF_BY_DEFAULT = new Set<string>();

export function moduleStatesSeed(): Record<string, boolean> {
  return Object.fromEntries(MODULE_REGISTRY.map((m) => [m.key, m.core ? true : !OFF_BY_DEFAULT.has(m.key)]));
}

export function moduleItems(states: Record<string, boolean>) {
  return MODULE_REGISTRY.map((m, index) => ({
    id: m.key,
    name: m.name,
    description: m.description,
    status: states[m.key] === false ? ('inactive' as const) : ('active' as const),
    uptime: 99.9,
    interactions: states[m.key] === false ? 0 : 40 + ((index * 37) % 900),
    lastSync: ago(3),
    isFixed: !!m.core,
    category: m.category,
    icon: m.icon,
    requires: m.requires ?? [],
    dependents: MODULE_REGISTRY.filter((other) => other.requires?.includes(m.key)).map((other) => other.key),
    settingsPath: m.paths?.[0],
  }));
}

/** Tout est ouvert : la personne de démo administre le serveur. */
export function featureAccessFor(keys: string[]) {
  return Object.fromEntries(keys.map((key) => [key, { canView: true, canModerate: true, canConfigure: true, canDelete: true }]));
}

export { DAY, HOUR, NOW };

// ── Commandes ──────────────────────────────────────────────────────────

const sub = (name: string, description: string, options: unknown[] = []) => ({ type: 1, name, description, options });
const opt = (type: number, name: string, description: string, required = false) => ({ type, name, description, required });

/** Extrait du catalogue du bot (`utils/commandAccess.ts`), avec les sous-commandes que la page affiche. */
export const COMMAND_CATALOG = [
  { name: 'help', label: 'Aide', description: 'Aide générale et documentation des commandes.', defaultAccess: 'tout_le_monde', category: 'Général' },
  { name: 'ping', label: 'Ping', description: 'Vérification de la latence du bot.', defaultAccess: 'tout_le_monde', category: 'Général' },
  { name: 'info', label: 'Infos serveur', description: "Résumé de l'état et des métriques du serveur.", defaultAccess: 'tout_le_monde', category: 'Général' },
  { name: 'profile', label: 'Profil', description: 'Affiche le profil utilisateur et sa progression.', defaultAccess: 'tout_le_monde', category: 'Communauté', options: [opt(6, 'membre', 'Le membre à afficher')] },
  { name: 'rank', label: 'Rang', description: 'Carte de niveau et position au classement.', defaultAccess: 'tout_le_monde', category: 'Niveaux', options: [opt(6, 'membre', 'Le membre à afficher')] },
  { name: 'leaderboard', label: 'Classement', description: 'Classement XP du serveur.', defaultAccess: 'tout_le_monde', category: 'Niveaux' },
  { name: 'daily', label: 'Récompense du jour', description: 'Récupère tes pièces quotidiennes.', defaultAccess: 'tout_le_monde', category: 'Économie' },
  { name: 'boutique', label: 'Boutique', description: 'Articles en vente sur le serveur.', defaultAccess: 'tout_le_monde', category: 'Économie' },
  { name: 'rpg', label: 'RPG', description: 'Aventure, combats et inventaire.', defaultAccess: 'tout_le_monde', category: 'Jeux', options: [sub('aventure', 'Part à l’aventure'), sub('combat', 'Affronte un monstre'), sub('inventaire', 'Ouvre ton sac')] },
  { name: 'giveaway', label: 'Giveaways', description: 'Créer et gérer les concours.', defaultAccess: 'modération', category: 'Événements', options: [sub('start', 'Lance un giveaway', [opt(3, 'lot', 'Ce qu’on gagne', true), opt(3, 'durée', 'Durée, ex. 2j', true)]), sub('reroll', 'Retire un gagnant')] },
  { name: 'ticket', label: 'Tickets', description: 'Ouvrir, fermer et gérer les tickets.', defaultAccess: 'tout_le_monde', category: 'Support', options: [sub('open', 'Ouvre un ticket'), sub('close', 'Ferme le ticket')] },
  { name: 'sanction', label: 'Sanctions', description: 'Gestion des sanctions et des rapports.', defaultAccess: 'modération', category: 'Modération', options: [sub('warn', 'Avertit un membre', [opt(6, 'membre', 'Le membre', true), opt(3, 'raison', 'La raison')]), sub('timeout', 'Exclut temporairement'), sub('ban', 'Bannit un membre')] },
  { name: 'clear', label: 'Nettoyage', description: 'Supprime des messages en masse.', defaultAccess: 'modération', category: 'Modération', options: [opt(4, 'nombre', 'Nombre de messages', true)] },
  { name: 'lock', label: 'Verrouillage', description: 'Verrouille ou rouvre un salon.', defaultAccess: 'modération', category: 'Modération' },
  { name: 'setup', label: 'Installation', description: 'Assistant de mise en route du serveur.', defaultAccess: 'administration', category: 'Administration' },
  { name: 'config', label: 'Configuration', description: 'Panneau de configuration principal du bot.', defaultAccess: 'administration', category: 'Administration' },
  { name: 'admin', label: 'Admin', description: 'Commandes administrateur du serveur.', defaultAccess: 'administration', category: 'Administration' },
];

/** Règles déjà posées : de quoi voir à quoi ressemble une commande restreinte. */
export const COMMAND_RESTRICTIONS = [
  { commandName: 'rpg', enabled: true, allowedChannelIds: ['900000000000000316'], blockedChannelIds: [], allowedRoleIds: [], blockedRoleIds: [], allowedUserIds: [], blockedUserIds: [] },
  { commandName: 'clear', enabled: true, allowedChannelIds: [], blockedChannelIds: [], allowedRoleIds: ['900000000000000203'], blockedRoleIds: [], allowedUserIds: [], blockedUserIds: [] },
  { commandName: 'excuse', enabled: false, allowedChannelIds: [], blockedChannelIds: [], allowedRoleIds: [], blockedRoleIds: [], allowedUserIds: [], blockedUserIds: [] },
];
