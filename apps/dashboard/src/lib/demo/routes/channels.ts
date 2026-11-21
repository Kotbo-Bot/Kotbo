/**
 * Gestion des salons et ses sous-modules : fils automatiques, panneaux de
 * discussion, messages épinglés en bas (sticky), vocaux temporaires, salons de
 * statistiques, salon piège, vue « par salon ».
 *
 * Formes reprises de `modules/channels-management.ts`, `auto-thread.ts` et
 * `auto-thread-panels.ts` côté bot.
 */
import { route } from '../backend';
import { demoDb, demoId } from '../db';
import { row } from '../model';
import { G, collection } from '../crud';
import { CATEGORIES, CHANNELS, DAY, PEOPLE, VOICE_CHANNELS, ago, avatarOf, channelByName, role } from '../fixtures';

const id = (name: string) => channelByName(name).id;
const lobby = VOICE_CHANNELS[0];

const tempVoicePolicy = () => ({
  userLimit: 5,
  lockOnCreate: false,
  autoAllowRoleIds: [role('Modérateur').id],
  textChat: 'inVoice',
  ownerPowers: ['mute', 'move', 'manageChannel'],
  visibilite: 'tous',
  reglagesPerso: true,
});

function configSeed() {
  const access = row('TempVoiceAccessRequestConfig', { enabled: true });
  const mod = row('TempVoiceModPermissionsConfig', { reservableRoleIds: [role('Habitué').id] });
  delete (access as Record<string, unknown>).guildId;
  delete (mod as Record<string, unknown>).guildId;
  return {
    autoThreadEnabled: true,
    autoThreadChannels: [id('recherche-de-groupe'), id('suggestions')],
    autoThreadBotsEnabled: false,
    statsEnabled: true,
    statsConfig: {
      categoryId: CATEGORIES[0].id,
      memberEnabled: true,
      memberChannelId: '900000000000000340',
      memberTemplate: '👥 Membres : {count}',
      botEnabled: false,
      botChannelId: null,
      botTemplate: '🤖 Bots : {count}',
      roleEnabled: true,
      roleChannelId: '900000000000000341',
      roleTargetId: role('Habitué').id,
      roleTemplate: '⭐ Habitués : {count}',
      channelEnabled: false,
      channelChannelId: null,
      channelTemplate: '💬 Salons : {count}',
      categoryEnabled: false,
      categoryChannelId: null,
      categoryTemplate: '📁 Catégories : {count}',
      activityEnabled: true,
      activityChannelId: '900000000000000342',
      activityTemplate: '🟢 En ligne : {count}',
      customStats: [{ id: 'stat-boosts', label: 'Boosts', template: '🚀 Boosts : {boosts}', channelId: '900000000000000343' }],
    },
    tempVoiceEnabled: true,
    tempVoiceChannelId: lobby.id,
    tempVoiceCategoryId: CATEGORIES[1].id,
    tempVoiceNameTemplate: '🎮 Salon de {user}',
    tempVoiceRequiredRoleId: null,
    tempVoiceDefaults: tempVoicePolicy(),
    tempVoiceGenerators: [
      { ...tempVoicePolicy(), channelId: lobby.id, categoryId: CATEGORIES[1].id, nameTemplate: '🎮 Salon de {user}', requiredRoleId: null },
      {
        ...tempVoicePolicy(),
        userLimit: 0,
        lockOnCreate: true,
        visibilite: 'acces',
        channelId: VOICE_CHANNELS[1].id,
        categoryId: CATEGORIES[3].id,
        nameTemplate: '🛡️ Réunion de {user}',
        requiredRoleId: role('Helper').id,
      },
    ],
    honeypotEnabled: true,
    honeypotChannelId: '900000000000000344',
    honeypotSanction: 'SOFTBAN',
    honeypotReinvite: true,
    honeypotGraceSeconds: 5,
    honeypotDurationMin: 60,
    honeypotShowCount: true,
    honeypotCatchCount: 37,
    wordStatsEnabled: true,
    tempVoiceAccessRequest: access,
    tempVoiceModPermissions: mod,
  };
}

const CONFIG = 'channels-management';

const autoThreadSeed = () => [
  row('AutoThreadConfig', {
    id: 'at-1',
    channelId: id('recherche-de-groupe'),
    name: 'Une annonce = un fil',
    trigger: 'all',
    namingMode: 'author_first_line',
    archiveMinutes: 1440,
    createdAt: ago(30 * DAY),
    updatedAt: ago(3 * DAY),
  }),
  row('AutoThreadConfig', {
    id: 'at-2',
    channelId: id('général'),
    name: 'Fil sur les images',
    trigger: 'attachments',
    namingMode: 'template',
    namingRules: { template: '📸 Photo de {author}' },
    archiveMinutes: 60,
    position: 0,
    createdAt: ago(12 * DAY),
    updatedAt: ago(12 * DAY),
  }),
];

const panelSeed = () => [
  {
    ...row('ThreadPanel', {
      id: 'panel-1',
      channelId: id('recherche-de-groupe'),
      messageId: '900000000000009001',
      name: 'Trouver une équipe',
      title: 'Lance ta recherche de groupe',
      description: 'Clique sur un bouton : Kotbo t’ouvre un fil pour réunir ton équipe.',
      color: '#22d3ee',
      buttons: [
        { id: 'b1', label: 'Partie classée', emoji: '🏆', mode: 'public', nameTemplate: 'Classée · {user}' },
        { id: 'b2', label: 'Partie détente', emoji: '🎮', mode: 'public', nameTemplate: 'Détente · {user}' },
        { id: 'b3', label: 'Coaching privé', emoji: '🔒', mode: 'private', nameTemplate: 'Coaching · {user}' },
      ],
      createdAt: ago(20 * DAY),
      updatedAt: ago(2 * DAY),
    }),
    stats: { total: 46, open: 5 },
  },
];

const stickySeed = () => [
  row('StickyMessage', {
    id: 'sticky-1',
    channelId: id('recherche-de-groupe'),
    content: '📌 Pour trouver un groupe : indique le jeu, ton rang et tes horaires. Les annonces sans ces infos sont supprimées.',
    embedEnabled: true,
    embedTitle: 'Rappel',
    embedColor: '#22D3EE',
    messageId: '900000000000009101',
    createdAt: ago(18 * DAY),
    updatedAt: ago(1 * DAY),
  }),
  row('StickyMessage', {
    id: 'sticky-2',
    channelId: id('boutique'),
    content: 'Tape /boutique pour voir les articles du moment, /solde pour ton porte-monnaie.',
    messageId: '900000000000009102',
    createdAt: ago(9 * DAY),
    updatedAt: ago(9 * DAY),
  }),
];

const tempChannelsSeed = () => {
  const [a, b] = PEOPLE.filter((p) => !p.bot);
  return [
    { id: '900000000000000350', name: `🎮 Salon de ${a.displayName}`, creatorId: a.id, creatorName: a.displayName, creatorAvatar: avatarOf(a), membersCount: 4, roleId: null, createdAt: ago(75) },
    { id: '900000000000000351', name: `🎮 Salon de ${b.displayName}`, creatorId: b.id, creatorName: b.displayName, creatorAvatar: avatarOf(b), membersCount: 2, roleId: null, createdAt: ago(20) },
  ];
};

const FEATURE_LABELS: Record<string, string> = {
  autoThread: 'Fils automatiques',
  logIgnored: 'Exclu des logs',
  honeypot: 'Salon piège',
  funCounting: 'Comptage',
  sticky: 'Message épinglé en bas',
  tempVoiceGenerator: 'Générateur de vocal temporaire',
};

export function registerChannelsRoutes(): void {
  route('GET', `${G}/channels-management`, () => demoDb.get(CONFIG, configSeed));
  route('PATCH', `${G}/channels-management`, ({ body }) => {
    const next = demoDb.update(CONFIG, configSeed, (current) => ({ ...current, ...(body ?? {}) }));
    return {
      ok: true,
      resolved: {
        tempVoiceChannelId: next.tempVoiceChannelId,
        tempVoiceCategoryId: next.tempVoiceCategoryId,
        tempVoiceGenerators: next.tempVoiceGenerators,
        honeypotChannelId: next.honeypotChannelId,
        honeypotSanction: next.honeypotSanction,
        honeypotReinvite: next.honeypotReinvite,
        statsConfig: next.statsConfig,
        tempVoiceDefaults: next.tempVoiceDefaults,
        tempVoiceModPermissions: next.tempVoiceModPermissions,
        tempVoiceAccessRequest: next.tempVoiceAccessRequest,
      },
    };
  });
  route('POST', `${G}/channels-management/rescan-stats`, () => ({ ok: true, message: 'Scraping historique lancé avec succès.' }));

  route('GET', `${G}/channels-management/by-channel`, () => {
    const config = demoDb.get(CONFIG, configSeed);
    const stickies = demoDb.get('stickies', stickySeed);
    const category = (index: number) => CATEGORIES[index];
    const placement: Record<string, number> = {
      bienvenue: 0, règlement: 0, annonces: 0, général: 1, 'recherche-de-groupe': 1, niveaux: 1, boutique: 1,
      'ouvrir-un-ticket': 2, suggestions: 2, staff: 3, logs: 3,
    };
    const all = [
      ...CHANNELS.map((c, i) => ({ ...c, position: i, categoryIndex: placement[c.name] ?? 1 })),
      ...VOICE_CHANNELS.map((c, i) => ({ ...c, position: 20 + i, categoryIndex: i === 0 ? 1 : 3 })),
    ];
    const generators = new Set((config.tempVoiceGenerators ?? []).map((g: { channelId?: string }) => g.channelId));
    return {
      channels: all.map((c) => {
        const features: string[] = [];
        if (config.autoThreadChannels.includes(c.id)) features.push('autoThread');
        if (c.name === 'logs') features.push('logIgnored');
        if (stickies.some((s) => s.channelId === c.id)) features.push('sticky');
        if (generators.has(c.id)) features.push('tempVoiceGenerator');
        return {
          id: c.id,
          name: c.name,
          type: c.type === 'voice' ? 'voice' : c.type === 'forum' ? 'forum' : 'text',
          categoryId: category(c.categoryIndex).id,
          categoryName: category(c.categoryIndex).name,
          position: c.position,
          manageable: true,
          features,
        };
      }),
      features: FEATURE_LABELS,
    };
  });
  route('PATCH', `${G}/channels-management/by-channel/:channelId`, ({ params, body }) => {
    if (body?.feature === 'autoThread') {
      demoDb.update(CONFIG, configSeed, (current) => ({
        ...current,
        autoThreadChannels: body.enabled
          ? [...new Set([...current.autoThreadChannels, params.channelId])]
          : current.autoThreadChannels.filter((c: string) => c !== params.channelId),
      }));
    }
    return { success: true };
  });
  route('PATCH', `${G}/channels-management/channel/:channelId`, ({ body }) => ({ success: true, name: body?.name ?? '' }));
  route('DELETE', `${G}/channels-management/channel/:channelId`, () => ({ success: true }));

  // Sticky : une seule ligne par salon, la clé est le salon et non l'identifiant.
  const stickies = () => demoDb.get('stickies', stickySeed);
  route('GET', `${G}/channels-management/sticky`, () => ({ stickies: stickies() }));
  route('POST', `${G}/channels-management/sticky`, ({ body }) => {
    const current = stickies();
    const existing = current.find((s) => s.channelId === body?.channelId);
    const sticky = row('StickyMessage', {
      ...(existing ?? {}),
      ...(body ?? {}),
      id: existing?.id ?? demoId(),
      messageId: demoId(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    demoDb.set('stickies', existing ? current.map((s) => (s.channelId === sticky.channelId ? sticky : s)) : [...current, sticky]);
    return { ok: true, sticky };
  });
  route('DELETE', `${G}/channels-management/sticky/:channelId`, ({ params }) => {
    demoDb.set('stickies', stickies().filter((s) => s.channelId !== params.channelId));
    return { ok: true };
  });
  route('POST', `${G}/channels-management/sticky/:channelId/repost`, () => ({ ok: true, messageId: demoId() }));

  const temp = () => demoDb.get('temp-voice-channels', tempChannelsSeed);
  route('GET', `${G}/channels-management/temp-voice/channels`, () => temp());
  route('PATCH', `${G}/channels-management/temp-voice/channels/:channelId`, ({ params, body }) => {
    if (body?.action === 'DELETE') {
      demoDb.set('temp-voice-channels', temp().filter((c) => c.id !== params.channelId));
      return { ok: true, message: 'Salon fermé avec succès.' };
    }
    demoDb.set('temp-voice-channels', temp().map((c) => (c.id === params.channelId ? { ...c, ...(body?.name ? { name: body.name } : {}), ...('roleId' in (body ?? {}) ? { roleId: body.roleId } : {}) } : c)));
    return { ok: true, message: 'Salon mis à jour avec succès.' };
  });

  // Fils automatiques : plusieurs configurations par salon.
  const autoThreads = collection({ path: '/auto-thread/configs', key: 'auto-thread-configs', seed: autoThreadSeed, listKey: 'configs', itemKey: 'config', update: ['PUT'], noGetOne: true });
  route('POST', `${G}/auto-thread/configs/reorder`, () => ({ ok: true, configs: autoThreads.all() }));
  route('POST', `${G}/auto-thread/configs/:itemId/duplicate`, ({ params }) => {
    const source = autoThreads.find(params.itemId);
    if (!source) return { ok: false };
    const config = { ...source, id: demoId(), name: `${source.name} (copie)`, createdAt: new Date().toISOString() };
    autoThreads.save([...autoThreads.all(), config]);
    return { ok: true, config };
  });
  route('GET', `${G}/auto-thread`, () => {
    const config = demoDb.get(CONFIG, configSeed);
    return { enabled: config.autoThreadEnabled, channels: config.autoThreadChannels, botsEnabled: config.autoThreadBotsEnabled };
  });
  route('PATCH', `${G}/auto-thread`, ({ body }) => {
    demoDb.update(CONFIG, configSeed, (current) => ({
      ...current,
      autoThreadEnabled: body?.enabled ?? current.autoThreadEnabled,
      autoThreadChannels: body?.channels ?? current.autoThreadChannels,
      autoThreadBotsEnabled: body?.botsEnabled ?? current.autoThreadBotsEnabled,
    }));
    return { ok: true };
  });

  // Panneaux de discussion : la liste vient avec les forums du serveur.
  const panels = () => demoDb.get('thread-panels', panelSeed);
  route('GET', `${G}/auto-thread/panels`, () => ({
    panels: panels(),
    forums: CHANNELS.filter((c) => c.type === 'forum').map((c) => ({ id: c.id, name: c.name, tags: [] })),
  }));
  route('POST', `${G}/auto-thread/panels`, ({ body }) => {
    const panel = { ...row('ThreadPanel', { ...(body ?? {}), id: demoId() }), stats: { total: 0, open: 0 } };
    demoDb.set('thread-panels', [...panels(), panel]);
    return { ok: true, panel };
  });
  route('PUT', `${G}/auto-thread/panels/:panelId`, ({ params, body }) => {
    let panel: unknown;
    demoDb.set('thread-panels', panels().map((p) => (p.id === params.panelId ? (panel = { ...p, ...(body ?? {}), updatedAt: new Date().toISOString() }) as typeof p : p)));
    return { ok: true, panel, publishError: null };
  });
  route('POST', `${G}/auto-thread/panels/:panelId/publish`, () => ({ ok: true, messageId: demoId() }));
  route('DELETE', `${G}/auto-thread/panels/:panelId`, ({ params }) => {
    demoDb.set('thread-panels', panels().filter((p) => p.id !== params.panelId));
    return { ok: true };
  });

  // Accès aux commandes : le bot n'expose que l'écriture, la lecture passe par les réglages du serveur.
  route('PUT', `${G}/command-access`, ({ body }) => {
    demoDb.set('command-access', Array.isArray(body?.commandRestrictions) ? body.commandRestrictions : []);
    return { ok: true };
  });
}
