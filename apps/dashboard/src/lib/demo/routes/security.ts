/**
 * Sécurité, suite : AegisAI, comptes suspects (détections) et contestations
 * de ban. L'anti-raid est dans `raid.ts`, l'automod des tags dans `tagAutomod.ts`.
 */
import { route } from '../backend';
import { demoDb, demoId } from '../db';
import { row } from '../model';
import { G } from '../crud';
import { scoreAegisSample } from '../aegisSamples';
import { DAY, MEMBERS, ago, avatarOf, channelByName, personByName, role } from '../fixtures';
import { DEMO_GUILD_ID } from '../mode';

const crowd = () => MEMBERS.filter((m) => !m.bot).slice(16);

// ── AegisAI ──────────────────────────────────────────────────────────────

const aegisSeed = () =>
  row('AegisConfig', {
    enabled: true,
    trainingConsent: false,
    reviewThreshold: 55,
    autoThreshold: 85,
    autoAction: 'DELETE_AND_WARN',
    reviewChannelId: channelByName('logs').id,
    exemptChannelIds: [channelByName('staff').id],
    exemptRoleIds: [role('Modérateur').id],
    conflictEnabled: true,
    harassmentEnabled: true,
    distressEnabled: true,
    distressChannelId: channelByName('staff').id,
  });

function detectionsSeed() {
  const [a, b, c, d] = crowd();
  const general = channelByName('général');
  const det = (id: string, p: (typeof MEMBERS)[number], kind: string, excerpt: string, toxicity: number | null, emotion: string, status: string, action: string, minutes: number, extra: Record<string, unknown> = {}) => ({
    id, guildId: DEMO_GUILD_ID, channelId: general.id, messageId: demoId(), authorId: p.id, targetUserId: null, kind, source: 'MESSAGE',
    toxicity, emotion, emotionScore: 0.85, excerpt, action, status, late: false, sanctionId: null, evidenceUrl: null, previousSlowmode: null,
    restoreAt: null, restoredAt: null, reviewedById: null, reviewedAt: null, createdAt: ago(minutes), authorName: p.displayName, authorAvatar: avatarOf(p),
    targetName: null, channelName: general.name, ...extra,
  });
  return [
    det('aeg-1', a, 'TOXIC', 'ferme-la espèce d’abruti', 0.93, 'anger', 'AUTO', 'DELETE_AND_WARN', 12),
    det('aeg-2', b, 'TOXIC', 'tu me saoules sérieux, dégage', 0.66, 'anger', 'PENDING', 'REVIEW', 47),
    det('aeg-3', c, 'HARASSMENT', '5 messages visant le même membre en 10 minutes', null, 'anger', 'PENDING', 'ALERT', 3 * 60, { targetUserId: d.id, targetName: d.displayName }),
    det('aeg-4', d, 'DISTRESS', 'j’en peux plus, tout le monde me déteste', 0.1, 'sad', 'PENDING', 'ALERT', 5 * 60),
    det('aeg-5', a, 'CONFLICT', 'Échange houleux : mode lent posé 15 min', null, 'anger', 'AUTO', 'SLOWMODE', DAY, { previousSlowmode: 0, restoredAt: ago(DAY - 15) }),
  ];
}

const aegis = () => demoDb.get('aegis/config', aegisSeed);
const detections = () => demoDb.get('aegis/detections', detectionsSeed);

// ── Comptes suspects ─────────────────────────────────────────────────────

function suspectsSeed() {
  const [a, b, c] = crowd().slice(8, 11);
  const main = personByName('Vantar');
  const suspect = (p: (typeof MEMBERS)[number], ageDays: number, reasons: Array<[string, string, number]>, alts: Array<(typeof MEMBERS)[number]>, onServer = true) => ({
    id: p.id,
    username: p.username,
    displayName: p.displayName,
    avatarUrl: avatarOf(p),
    isBot: false,
    accountCreatedAt: ago((ageDays + 1) * DAY),
    guildJoinedAt: ago(DAY),
    guildLeftAt: onServer ? null : ago(60),
    lastSeenAt: ago(90),
    messageCount: p.messages % 40,
    isOnServer: onServer,
    presenceStatus: onServer ? 'online' : 'left',
    accountAgeMs: ageDays * 86_400_000,
    accountAgeLabel: `${ageDays} jour${ageDays > 1 ? 's' : ''}`,
    suspectedAlts: alts.map((alt) => ({ userId: alt.id, username: alt.username, avatarUrl: avatarOf(alt) })),
    evidence: {
      reasons: reasons.map(([type, label, score]) => ({ type, label, score, matchedUserId: alts[0]?.id ?? null, detail: null })),
      totalScore: reasons.reduce((sum, [, , score]) => sum + score, 0),
    },
  });
  return [
    suspect(a, 1, [['NAME_SIMILARITY', 'Pseudo presque identique à vantar', 40], ['SAME_INVITE', 'Même invitation que vantar', 25], ['YOUNG_ACCOUNT', 'Compte créé la veille', 20]], [main]),
    suspect(b, 3, [['AVATAR_MATCH', 'Même photo de profil qu’un banni', 50], ['YOUNG_ACCOUNT', 'Compte de 3 jours', 15]], [c]),
    suspect(c, 12, [['JOIN_PATTERN', 'Arrivé 30 s après un compte banni', 30]], [b], false),
  ];
}

// ── Contestations de ban ─────────────────────────────────────────────────

function appealsSeed() {
  const [a, b, c] = crowd().slice(11, 14);
  const moderator = personByName('Zenox');
  const appeal = (id: string, p: (typeof MEMBERS)[number], status: string, banReason: string, statement: string, minutes: number, extra: Record<string, unknown> = {}) => ({
    id, userId: p.id, userTag: p.username, avatar: avatarOf(p),
    data: { 'Pourquoi devrions-nous lever ta sanction ?': statement, 'Qu’as-tu compris du règlement ?': 'Pas de pub ni d’insultes, je respecterai.' },
    status, banReason, infoRequest: null, infoResponse: null, decidedByTag: null, decisionReason: null, decidedAt: null, dmDelivered: true,
    createdAt: ago(minutes), messages: [],
    sanctions: [{ id: `${id}-s1`, sanctionId: `${id}-sanction`, sanctionType: 'BAN', sanctionReason: banReason, sanctionCreatedAt: ago(minutes + 3 * DAY), moderatorTag: moderator.username, memberStatement: statement, outcome: 'PENDING', outcomeNote: null, decidedByTag: null }],
    ...extra,
  });
  return [
    appeal('appeal-1', a, 'PENDING', 'Pub pour un autre serveur en MP', 'Je ne savais pas que c’était interdit, je ne recommencerai pas.', 3 * 60),
    appeal('appeal-2', b, 'PENDING', 'Insultes répétées en vocal', 'J’étais énervé ce soir-là, je m’excuse auprès de tout le monde.', DAY, { infoRequest: 'Peux-tu t’excuser publiquement auprès d’Inès ?', status: 'INFO_REQUESTED' }),
    appeal('appeal-3', c, 'ACCEPTED', 'Spam de liens', 'Mon compte avait été piraté, j’ai changé mon mot de passe.', 6 * DAY, { decidedByTag: 'lena', decisionReason: 'Compte piraté, preuve fournie.', decidedAt: ago(5 * DAY) }),
  ];
}

const appealConfigSeed = () =>
  row('BanAppealConfig', {
    enabled: true,
    formId: 'form-appeal',
    staffChannelId: channelByName('staff').id,
    cooldownDays: 30,
    welcomeText: 'Explique-nous calmement ce qui s’est passé. Le staff répond sous 72 heures.',
    acceptMessage: 'Ta contestation est acceptée, tu peux revenir sur Atelier Nova.',
    denyMessage: 'Ta contestation est refusée. Tu pourras en refaire une dans 30 jours.',
  });

export function registerSecurityRoutes(): void {
  route('GET', `${G}/aegis`, () => ({
    config: aegis(),
    saved: true,
    pendingCount: detections().filter((d) => d.status === 'PENDING').length,
    status: {
      api: { configured: true, circuit: 'closed', openUntil: null, consecutiveFailures: 0, latencyP50Ms: 180, latencyP95Ms: 420, requests: 18_420, failures: 12 },
      queue: { backend: 'redis', depth: 0, active: 1, concurrency: 4, processed: 18_408, failed: 12, dropped: 0 },
    },
    canEdit: true,
    canReview: true,
  }));
  route('PATCH', `${G}/aegis`, ({ body }) => ({ config: demoDb.update('aegis/config', aegisSeed, (c) => ({ ...c, ...(body ?? {}) })), saved: true }));
  route('POST', `${G}/aegis/test`, ({ body }) => {
    const text = String(body?.text ?? '');
    const score = scoreAegisSample(text);
    const points = Math.round(score.toxicity * 100);
    const config = aegis();
    return {
      text,
      toxicity: score.toxicity,
      emotion: { label: score.emotion, score: score.emotionScore },
      decision: points >= config.autoThreshold ? 'auto' : points >= config.reviewThreshold ? 'review' : 'none',
      saved: false,
    };
  });
  route('GET', `${G}/aegis/detections`, ({ query }) => {
    const status = query.get('status');
    const kind = query.get('kind');
    return { detections: detections().filter((d) => (!status || d.status === status) && (!kind || d.kind === kind)), hasMore: false };
  });
  route('POST', `${G}/aegis/detections/:id/:decision`, ({ params }) => {
    let detection: unknown;
    const status = params.decision === 'dismiss' ? 'DISMISSED' : 'CONFIRMED';
    demoDb.set('aegis/detections', detections().map((d) => (d.id === params.id ? (detection = { ...d, status, reviewedAt: new Date().toISOString() } as any) : d)));
    return { detection };
  });

  const suspects = () => demoDb.get('detections', suspectsSeed);
  route('GET', `${G}/detections`, () => ({ total: suspects().length, detections: suspects() }));
  route('POST', `${G}/detections/scan`, () => ({ success: true, scanned: MEMBERS.length, flagged: suspects().length }));
  for (const action of ['link', 'dismiss', 'restore']) {
    route('POST', `${G}/detections/:userId/${action}`, ({ params }) => {
      if (action !== 'restore') demoDb.set('detections', suspects().filter((s) => s.id !== params.userId));
      return { success: true };
    });
  }

  const appeals = () => demoDb.get('appeals', appealsSeed);
  route('GET', `${G}/appeals`, () => ({ appeals: appeals() }));
  route('GET', `${G}/appeals/config`, () => ({ config: demoDb.get('appeals/config', appealConfigSeed) }));
  route('PUT', `${G}/appeals/config`, ({ body }) => ({ config: demoDb.update('appeals/config', appealConfigSeed, (c) => ({ ...c, ...(body ?? {}) })) }));
  route('PATCH', `${G}/appeals/config`, ({ body }) => ({ config: demoDb.update('appeals/config', appealConfigSeed, (c) => ({ ...c, ...(body ?? {}) })) }));
  route('GET', `${G}/appeals/blacklist`, () => ({
    entries: [{ id: 'abl-1', userId: crowd()[15].id, reason: 'Contestations insultantes à répétition', addedByTag: 'zenox', createdAt: ago(20 * DAY) }],
  }));
  route('DELETE', `${G}/appeals/blacklist/:userId`, () => ({ success: true }));
  route('GET', `${G}/appeals/moderator-stats`, () => ({
    stats: [
      { moderatorUserId: personByName('Zenox').id, moderatorTag: 'zenox', contested: 6, overturned: 1, upheld: 4, pending: 1, overturnRate: 0.17 },
      { moderatorUserId: personByName('Aiden').id, moderatorTag: 'aiden', contested: 3, overturned: 1, upheld: 1, pending: 1, overturnRate: 0.33 },
    ],
  }));
  route('GET', `${G}/appeals/:id`, ({ params }) => {
    const appeal = appeals().find((a) => a.id === params.id);
    if (!appeal) return new Response(JSON.stringify({ error: 'Introuvable' }), { status: 404 });
    return {
      appeal,
      sanctions: [
        { id: `${appeal.id}-sanction`, type: 'BAN', status: 'ACTIVE', reason: appeal.banReason, createdAt: ago(10 * DAY), moderatorTag: 'zenox', archivedAt: null, appealable: true },
        { id: `${appeal.id}-warn`, type: 'WARN', status: 'ACTIVE', reason: 'Langage', createdAt: ago(30 * DAY), moderatorTag: 'aiden', archivedAt: null, appealable: true },
      ],
      previousAppeals: [],
    };
  });
  const decide = (id: string, patch: Record<string, unknown>) => {
    demoDb.set('appeals', appeals().map((a) => (a.id === id ? { ...a, ...patch } : a)));
    return { success: true, appeal: appeals().find((a) => a.id === id) };
  };
  route('POST', `${G}/appeals/:id/decide`, ({ params, body }) =>
    decide(params.id, { status: body?.decision === 'ACCEPTED' ? 'ACCEPTED' : 'DENIED', decidedByTag: 'toi', decisionReason: body?.reason ?? null, decidedAt: new Date().toISOString() }),
  );
  route('POST', `${G}/appeals/:id/request-info`, ({ params, body }) => decide(params.id, { status: 'INFO_REQUESTED', infoRequest: body?.question ?? body?.message ?? '' }));
  route('POST', `${G}/appeals/:id/items/:itemId`, ({ params, body }) => {
    demoDb.set('appeals', appeals().map((a) => (a.id === params.id ? { ...a, sanctions: a.sanctions.map((s) => (s.id === params.itemId ? { ...s, outcome: body?.outcome ?? s.outcome, outcomeNote: body?.note ?? null } : s)) } : a)));
    return { success: true };
  });
}

// ── Filtres : emojis bannis, pseudos, mots bannis ─────────────────────────

const emojiBansSeed = () => [
  { id: 'eb-1', kind: 'UNICODE', key: '🍆', name: null, iconUrl: null, action: 'DELETE', durationMin: null, createdBy: 'zenox', createdAt: ago(20 * DAY) },
  { id: 'eb-2', kind: 'SOURCE_GUILD', key: '930000000000000013', name: 'Pixel Forge', iconUrl: null, action: 'WARN', durationMin: null, createdBy: 'lena', createdAt: ago(6 * DAY) },
];

const nicknameSeed = () => ({
  enabled: true,
  whitelist: ['Kotbo', 'Nova'],
  bypass: [role('Modérateur').id],
  onJoin: true,
  onUpdate: true,
  checkInvisible: true,
  checkGlobal: true,
  checkCustom: true,
  discordAutoModSync: false,
});

const wordsSeed = () => ({
  global: ['connard', 'pute', 'nazi', 'fdp'].map((word, i) => ({ id: `bwg-${i}`, word, category: 'insult', enabled: true, guildId: null })),
  custom: ['discord.gg/', 'free nitro', 'robux gratuit'].map((word, i) => ({ id: `bwc-${i}`, word, category: 'custom', enabled: true, guildId: DEMO_GUILD_ID })),
});

export function registerFilterRoutes(): void {
  const bans = () => demoDb.get('emoji-bans', emojiBansSeed);
  route('GET', `${G}/emoji-bans`, () => ({ rules: bans(), maxRules: 50, jailConfigured: true }));
  route('POST', `${G}/emoji-bans`, ({ body }) => {
    const rule = { ...emojiBansSeed()[0], ...(body ?? {}), id: demoId(), createdBy: 'toi', createdAt: new Date().toISOString() };
    demoDb.set('emoji-bans', [...bans(), rule]);
    return { rule };
  });
  route('DELETE', `${G}/emoji-bans/:id`, ({ params }) => {
    demoDb.set('emoji-bans', bans().filter((b) => b.id !== params.id));
    return { success: true };
  });
  route('GET', `${G}/emoji-bans/search`, () => ({ servers: [{ guildId: '930000000000000013', name: 'Pixel Forge', iconUrl: null, memberCount: 15_300, kotboPresent: false }] }));
  route('GET', `${G}/emoji-bans/sources/:id`, () => ({ kotboPresent: false, emojis: [], stickers: [] }));

  route('GET', `${G}/nickname-moderation`, () => demoDb.get('nickname-moderation', nicknameSeed));
  route('PATCH', `${G}/nickname-moderation`, ({ body }) => {
    demoDb.update('nickname-moderation', nicknameSeed, (c) => ({ ...c, ...(body ?? {}) }));
    return { ok: true };
  });

  const words = () => demoDb.get('banned-words', wordsSeed);
  route('GET', `${G}/banned-words`, () => words());
  route('POST', `${G}/banned-words`, ({ body }) => {
    const id = demoId();
    demoDb.update('banned-words', wordsSeed, (w) => ({ ...w, custom: [...w.custom, { id, word: String(body?.word ?? ''), category: body?.category ?? 'custom', enabled: true, guildId: DEMO_GUILD_ID }] }));
    return { ok: true, id };
  });
  route('PATCH', `${G}/banned-words/:id`, ({ params, body }) => {
    demoDb.update('banned-words', wordsSeed, (w) => ({ ...w, custom: w.custom.map((x) => (x.id === params.id ? { ...x, ...(body ?? {}) } : x)) }));
    return { ok: true };
  });
  route('DELETE', `${G}/banned-words/:id`, ({ params }) => {
    demoDb.update('banned-words', wordsSeed, (w) => ({ ...w, custom: w.custom.filter((x) => x.id !== params.id) }));
    return { ok: true };
  });
}
