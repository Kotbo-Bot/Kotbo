/**
 * Animation du serveur : giveaways, rôles par réaction, salons fun et
 * confessions. Formes de `generalistModules.ts` et des services du bot.
 */
import { route } from '../backend';
import { demoDb, demoId } from '../db';
import { row } from '../model';
import { G } from '../crud';
import { DAY, HOUR, MEMBERS, PEOPLE, ROLES, ago, avatarOf, channelByName, personById, role } from '../fixtures';
import { DEMO_GUILD_ID } from '../mode';

// ── Giveaways ────────────────────────────────────────────────────────────

const APPEARANCE = {
  embedColorActive: '#5865F2',
  embedColorPending: '#FAA81A',
  embedColorEnded: '#ED4245',
  embedColorValidated: '#57F287',
  titleTemplate: 'GIVEAWAY : {prize}',
  descriptionTemplate: '{description}Cliquez sur le bouton ci-dessous pour participer !\n{bonus}{bonusRoles}\n**Fin :** {endsRelative} ({endsAt})\n**Nombre de gagnants :** {winnerCount}\n**Participants :** {participants}',
  footerTemplate: 'ID : {id}',
  thumbnailUrl: null,
  imageUrl: null,
  joinButtonLabel: 'Rejoindre',
  joinButtonEmoji: '',
  joinButtonStyle: 'PRIMARY',
  announceWinnersTemplate: 'Félicitations à {winners} qui gagne(nt) **{prize}** !',
  announceNoWinnerTemplate: "Personne n'a participé au giveaway pour **{prize}**, il n'y a donc pas de gagnant.",
  joinReplyTemplate: 'Inscription validée ! Bonne chance !',
  leaveReplyTemplate: 'Vous vous êtes retiré du giveaway.',
  deniedBlockedTemplate: "L'un de tes rôles t'exclut des giveaways de ce serveur.",
  deniedRequiredTemplate: "Tu n'as pas le rôle requis pour participer aux giveaways de ce serveur.",
  deniedAccountAgeTemplate: 'Ton compte Discord doit avoir au moins {minAccountAgeDays} jour(s) pour participer.',
  deniedMemberAgeTemplate: 'Tu dois être sur le serveur depuis au moins {minMemberAgeDays} jour(s) pour participer.',
  deniedLevelTemplate: 'Tu dois être niveau {minLevel} au minimum pour participer.',
  deniedLinkedTemplate: 'Un autre de tes comptes participe déjà à ce concours.',
};
const LABELS = { rewardsTitle: 'En plus du lot :', coins: 'Pièces :', xp: 'XP RPG :', item: 'Objet :', validation: 'Validation du staff requise', bonusRolesTitle: 'Chances supplémentaires :' };

const giveawayConfigSeed = () => ({
  guildId: DEMO_GUILD_ID,
  locale: 'fr',
  managerRoleIds: [role('Modérateur').id],
  requiredRoleIds: [],
  blockedRoleIds: [],
  minAccountAgeDays: 7,
  minMemberAgeDays: 2,
  minLevel: 0,
  blockLinkedAccounts: true,
  bonusEntries: [{ roleId: role('Habitué').id, weight: 2 }],
  clanBonusEnabled: true,
  clanBonusWeight: 2,
  showBonusRoles: true,
  defaultChannelId: channelByName('annonces').id,
  ...APPEARANCE,
});

const entrants = (count: number) => MEMBERS.filter((m) => !m.bot).slice(0, count).map((m) => m.id);
const profile = (userId: string) => {
  const p = personById(userId);
  return { userId, username: p?.username ?? null, displayName: p?.displayName ?? `Utilisateur ${userId}`, avatarUrl: p ? avatarOf(p) : null };
};

function giveawaysSeed() {
  const g = (id: string, prize: string, extra: Record<string, unknown>) =>
    row('Giveaway', { id, guildId: DEMO_GUILD_ID, channelId: channelByName('annonces').id, messageId: demoId(), prize, winnerCount: 1, createdById: PEOPLE[1].id, ...extra });
  return [
    g('gw-1', 'Nitro Classic (1 mois)', { description: 'Pour fêter les 1 000 membres !', winnerCount: 2, endsAt: ago(-2 * DAY), participants: entrants(64), rpgCoins: 500, createdAt: ago(DAY) }),
    g('gw-2', 'Skin Valorant au choix', { endsAt: ago(-5 * HOUR), participants: entrants(38), needValidation: true, createdAt: ago(3 * DAY) }),
    g('gw-3', 'Rôle VIP (30 jours)', { endsAt: ago(4 * DAY), ended: true, participants: entrants(51), winners: [PEOPLE[8].id], createdAt: ago(8 * DAY) }),
    g('gw-4', '1 000 pièces', { endsAt: ago(12 * DAY), ended: true, participants: entrants(27), winners: [PEOPLE[10].id], rpgCoins: 1_000, createdAt: ago(15 * DAY) }),
  ];
}

const templatesSeed = () => [
  { id: 'gwt-1', guildId: DEMO_GUILD_ID, name: 'Giveaway hebdo', prize: '500 pièces', description: 'Le giveaway du vendredi soir.', durationMinutes: 2 * 24 * 60, winnerCount: 1, channelId: channelByName('annonces').id, rpgCoins: 500, rpgXp: 0, rpgItemId: null, needValidation: false, createdAt: ago(30 * DAY) },
];

// ── Rôles par réaction ───────────────────────────────────────────────────

const menusSeed = () => [
  row('ReactionRoleMenu', {
    id: 'rr-1', guildId: DEMO_GUILD_ID, channelId: channelByName('bienvenue').id, messageId: demoId(), title: 'Choisis tes jeux', description: 'Un clic pour voir les salons du jeu.', buttonMode: 'toggle', showCounts: true, embedColor: '#22d3ee', createdAt: ago(60 * DAY),
    options: [
      { emoji: '🎯', label: 'Valorant', roleId: '900000000000000221' },
      { emoji: '⛏️', label: 'Minecraft', roleId: '900000000000000222' },
      { emoji: '🧙', label: 'League of Legends', roleId: '900000000000000223' },
      { emoji: '🚀', label: 'Rocket League', roleId: '900000000000000224' },
    ],
  }),
  row('ReactionRoleMenu', {
    id: 'rr-2', guildId: DEMO_GUILD_ID, channelId: channelByName('bienvenue').id, messageId: demoId(), title: 'Notifications', description: 'Reçois une mention pour ce qui t’intéresse.', buttonMode: 'toggle', createdAt: ago(40 * DAY),
    options: [
      { emoji: '📢', label: 'Annonces', roleId: '900000000000000225' },
      { emoji: '🎉', label: 'Événements', roleId: '900000000000000226' },
    ],
  }),
];

const GAME_ROLES = [
  { id: '900000000000000221', name: 'Valorant', count: 48 },
  { id: '900000000000000222', name: 'Minecraft', count: 39 },
  { id: '900000000000000223', name: 'League of Legends', count: 22 },
  { id: '900000000000000224', name: 'Rocket League', count: 17 },
  { id: '900000000000000225', name: 'Annonces', count: 71 },
  { id: '900000000000000226', name: 'Événements', count: 54 },
];

// ── Fun ──────────────────────────────────────────────────────────────────

const funSeed = () => ({
  config: {
    funEnabled: true,
    funCountingChannelId: '900000000000000360',
    funOneWordStoryChannelId: '900000000000000361',
    funGuessNumberChannelId: '900000000000000362',
    funWordChainChannelId: '900000000000000363',
    funEmojiRiddleChannelId: '900000000000000364',
    funNeverSayChannelId: '900000000000000365',
    funEmojiOnlyChannelId: '900000000000000366',
    funImageOfDayChannelId: '900000000000000367',
    funConfessionChannelId: '900000000000000368',
    funConfessionLogChannelId: channelByName('logs').id,
    funConfessionCooldownSeconds: 600,
    funPunitiveMode: true,
    funEmojiRiddleUseDefaults: true,
  },
  gameState: {
    countingCurrent: 1_284,
    countingLastUserId: PEOPLE[6].id,
    oneWordStoryLastUserId: PEOPLE[7].id,
    guessNumberTarget: 417,
    wordChainLastWord: 'éléphant',
    wordChainLastUserId: PEOPLE[8].id,
    emojiRiddleEmojis: '🦁👑',
  },
});

const confessions = () => [
  { number: 42, content: 'Je fais semblant d’être nul à Valorant pour ne pas devoir carry mes potes.', createdAt: ago(3 * HOUR), revealedAt: null, deletedAt: null },
  { number: 41, content: 'J’ai rejoint le serveur pour une seule personne et elle ne le sait pas 🙈', createdAt: ago(DAY), revealedAt: null, deletedAt: null },
  { number: 40, content: 'Ce serveur m’a vraiment aidé cette année, merci à tous.', createdAt: ago(2 * DAY), revealedAt: null, deletedAt: null },
  { number: 39, content: 'Message supprimé par le staff.', createdAt: ago(3 * DAY), revealedAt: null, deletedAt: ago(3 * DAY) },
];

export function registerEngagementRoutes(): void {
  const gb = `${G}/giveaways`;
  const giveaways = () => demoDb.get('giveaways', giveawaysSeed);
  route('GET', gb, () => ({
    canManage: true,
    giveaways: giveaways().map((g) => ({
      ...g,
      creatorProfile: g.createdById ? profile(g.createdById) : null,
      winnerProfiles: g.winners.map(profile),
      pendingWinnerProfiles: g.pendingWinners.map(profile),
    })),
  }));
  route('POST', gb, ({ body }) => {
    const minutes = Number(body?.durationMinutes ?? body?.duration ?? 60 * 24);
    const giveaway = row('Giveaway', {
      ...(body ?? {}), id: demoId(), guildId: DEMO_GUILD_ID, messageId: demoId(), participants: [], winners: [], pendingWinners: [], ended: false,
      endsAt: body?.endsAt ?? new Date(Date.now() + minutes * 60_000).toISOString(), createdById: PEOPLE[0].id,
    });
    demoDb.set('giveaways', [giveaway, ...giveaways()]);
    return { success: true, giveaway };
  });
  route('POST', `${gb}/:id/end`, ({ params }) => {
    let giveaway: unknown;
    demoDb.set('giveaways', giveaways().map((g) => (g.id === params.id ? (giveaway = { ...g, ended: true, endsAt: new Date().toISOString(), winners: g.participants.slice(3, 3 + g.winnerCount) }) : g)));
    return { success: true, giveaway };
  });
  route('POST', `${gb}/:id/reroll`, ({ params }) => {
    let giveaway: any;
    demoDb.set('giveaways', giveaways().map((g) => (g.id === params.id ? (giveaway = { ...g, winners: g.participants.slice(7, 7 + g.winnerCount) }) : g)));
    return { success: true, winners: giveaway?.winners ?? [] };
  });
  route('DELETE', `${gb}/:id`, ({ params }) => {
    demoDb.set('giveaways', giveaways().filter((g) => g.id !== params.id));
    return { success: true };
  });
  route('GET', `${gb}/config`, () => ({ config: demoDb.get('giveaways/config', giveawayConfigSeed), defaults: APPEARANCE, labels: LABELS }));
  route('PUT', `${gb}/config`, ({ body }) => ({ config: demoDb.update('giveaways/config', giveawayConfigSeed, (c) => ({ ...c, ...(body ?? {}) })), defaults: APPEARANCE, labels: LABELS }));
  route('GET', `${gb}/config/presets`, () => ({ presets: [] }));
  route('GET', `${gb}/items`, () => ({ items: [{ id: 'health_potion', name: 'Potion de soin', emoji: '🧪' }, { id: 'iron_sword', name: 'Épée en fer', emoji: '🗡️' }] }));
  const templates = () => demoDb.get('giveaways/templates', templatesSeed);
  route('GET', `${gb}/templates`, () => ({ templates: templates() }));
  route('POST', `${gb}/templates`, ({ body }) => {
    const template = { ...templatesSeed()[0], ...(body ?? {}), id: demoId(), createdAt: new Date().toISOString() };
    demoDb.set('giveaways/templates', [...templates(), template]);
    return { template };
  });
  route('PUT', `${gb}/templates/:id`, ({ params, body }) => {
    let template: unknown;
    demoDb.set('giveaways/templates', templates().map((t) => (t.id === params.id ? (template = { ...t, ...(body ?? {}) }) : t)));
    return { template };
  });
  route('DELETE', `${gb}/templates/:id`, ({ params }) => {
    demoDb.set('giveaways/templates', templates().filter((t) => t.id !== params.id));
    return { success: true };
  });

  const menus = () => demoDb.get('reaction-roles', menusSeed);
  route('GET', `${G}/reaction-roles`, () => ({
    menus: menus(),
    botRoleAccess: { canManageRoles: true, topPosition: 11 },
    memberCounts: Object.fromEntries(GAME_ROLES.map((r) => [r.id, r.count])),
    messageStatuses: Object.fromEntries(menus().map((m) => [m.id, 'ok'])),
  }));
  route('POST', `${G}/reaction-roles`, ({ body }) => {
    const menu = row('ReactionRoleMenu', { ...(body ?? {}), id: demoId(), guildId: DEMO_GUILD_ID, messageId: demoId(), options: body?.options ?? [] });
    demoDb.set('reaction-roles', [menu, ...menus()]);
    return { success: true, menu };
  });
  route('PATCH', `${G}/reaction-roles/:menuId`, ({ params, body }) => {
    let menu: unknown;
    demoDb.set('reaction-roles', menus().map((m) => (m.id === params.menuId ? (menu = { ...m, ...(body ?? {}) }) : m)));
    return { success: true, menu };
  });
  route('DELETE', `${G}/reaction-roles/:menuId`, ({ params }) => {
    demoDb.set('reaction-roles', menus().filter((m) => m.id !== params.menuId));
    return { success: true };
  });
  route('POST', `${G}/reaction-roles/:menuId/republish`, () => ({ success: true, messageId: demoId() }));
  route('GET', `${G}/reaction-roles/presets/:key`, ({ params }) => ({
    key: params.key,
    title: 'Choisis tes rôles',
    options: ROLES.filter((r) => !r.managed && r.position < 6).map((r) => ({ label: r.name, roleId: r.id, emoji: '✨' })),
  }));

  const fun = () => demoDb.get('fun', funSeed);
  route('GET', `${G}/fun`, () => fun());
  route('PATCH', `${G}/fun`, ({ body }) => {
    const next = demoDb.update('fun', funSeed, (f) => ({ ...f, config: { ...f.config, ...(body ?? {}) } }));
    return { success: true, ...next };
  });
  route('GET', `${G}/fun/confessions`, () => ({ confessions: confessions() }));
  for (const game of ['counting', 'guess-number', 'word-chain', 'emoji-riddle']) {
    route('POST', `${G}/fun/${game}/reset`, () => {
      demoDb.update('fun', funSeed, (f) => ({
        ...f,
        gameState: { ...f.gameState, ...(game === 'counting' ? { countingCurrent: 0, countingLastUserId: null } : game === 'guess-number' ? { guessNumberTarget: 1 + Math.floor(Math.random() * 1000) } : game === 'word-chain' ? { wordChainLastWord: null, wordChainLastUserId: null } : { emojiRiddleEmojis: '🍕🗼' }) },
      }));
      return { success: true };
    });
  }
}
