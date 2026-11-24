/**
 * Automod des tags de serveur. Mêmes serveurs que la vue « Tags de serveur »
 * des analytics (`analyticsInsights.ts`) : DevHub surveillé, Koda autorisé.
 */
import { route } from '../backend';
import { demoDb, demoId } from '../db';
import { G } from '../crud';
import { DAY, MEMBERS, ago, avatarOf, channelByName, role } from '../fixtures';

const configSeed = () => ({
  enabled: true,
  testMode: false,
  onJoin: true,
  onTagChange: true,
  exemptRoleIds: [role('Modérateur').id, role('Admin').id],
  exemptUserIds: [],
  alertChannelId: channelByName('logs').id,
  allowlistOnly: false,
  allowlistAction: 'ALERT',
  allowlistDurationMin: null,
  sharedListEnabled: true,
  sharedListAction: 'ALERT',
  sharedListDurationMin: null,
  waveEnabled: true,
  waveMode: 'ADAPTIVE',
  wavePreset: 'NORMAL',
  waveThreshold: 5,
  waveWindowSec: 600,
  waveAction: 'TIMEOUT',
  waveDurationMin: 60,
  waveBlockHours: 24,
  waveReportFleet: true,
  newAccountEnabled: true,
  newAccountDays: 7,
  newAccountScope: 'UNKNOWN',
  newAccountAction: 'ALERT',
  newAccountDurationMin: null,
  massAdoptEnabled: false,
  massAdoptThreshold: 10,
  massAdoptWindowMin: 60,
  massAdoptAction: 'ALERT',
  impersonationEnabled: true,
  impersonationAction: 'TIMEOUT',
  impersonationDurationMin: 1440,
});

const rule = (id: string, extra: Record<string, unknown>) => ({
  id,
  name: '',
  enabled: true,
  effect: 'BLOCK',
  targetType: 'SERVER',
  targetGuildId: null,
  targetName: null,
  targetIcon: null,
  pattern: null,
  matchMode: 'EXACT',
  action: 'ALERT',
  durationMin: null,
  roleId: null,
  message: null,
  escalateAfterMin: null,
  escalateAction: null,
  escalateDurationMin: null,
  expiresAt: null,
  source: 'MANUAL',
  createdAt: ago(10 * DAY),
  fleetBlocks: 0,
  ...extra,
});

const rulesSeed = () => [
  rule('tag-rule-1', { name: 'Surveiller DevHub', targetGuildId: '930000000000000011', targetName: 'DevHub Community', action: 'ALERT', escalateAfterMin: 1440, escalateAction: 'TIMEOUT', escalateDurationMin: 60, fleetBlocks: 1 }),
  rule('tag-rule-2', { name: 'Koda est partenaire', effect: 'ALLOW', targetGuildId: '930000000000000012', targetName: 'Koda', action: 'ALERT', createdAt: ago(30 * DAY) }),
  rule('tag-rule-3', { name: 'Faux tags « KTB »', targetType: 'TEXT', pattern: 'KTB', matchMode: 'CONTAINS', action: 'DM', message: 'Le tag KTB est réservé aux membres du serveur officiel.', source: 'TEMPLATE', createdAt: ago(4 * DAY) }),
];

const people = () => MEMBERS.filter((m) => !m.bot);

function eventsSeed() {
  const [a, b, c] = people().slice(14, 17);
  const ev = (id: string, p: (typeof MEMBERS)[number], tag: string, guild: string, trigger: string, action: string, status: string, minutes: number, ruleId: string | null, detail: string | null = null) => ({
    id, userId: p.id, userTag: p.username, tagGuildId: guild, tag, trigger, ruleId, waveId: null, action, status, detail, dueAt: null, escalateAction: null, createdAt: ago(minutes),
  });
  return [
    ev('tag-ev-1', a, 'DEVH', '930000000000000011', 'JOIN', 'ALERT', 'APPLIED', 2 * DAY, 'tag-rule-1'),
    ev('tag-ev-2', b, 'KTB ', '930000000000000099', 'TAG_CHANGE', 'DM', 'APPLIED', 3 * 60, 'tag-rule-3', 'Tag imitant celui du serveur'),
    ev('tag-ev-3', c, 'DEVH', '930000000000000011', 'NEW_ACCOUNT', 'ALERT', 'APPLIED', 50, null, 'Compte créé il y a 2 jours'),
  ];
}

const config = () => demoDb.get('tag-automod/config', configSeed);
const rules = () => demoDb.get('tag-automod/rules', rulesSeed);

const SERVERS = [
  { guildId: '930000000000000011', name: 'DevHub Community', iconUrl: null, tag: 'DEVH', badgeUrl: null, memberCount: 2_400, holders: 3, fleetBlocks: 1, unlisted: false },
  { guildId: '930000000000000012', name: 'Koda', iconUrl: null, tag: 'KODA', badgeUrl: null, memberCount: 860, holders: 2, fleetBlocks: 0, unlisted: false },
  { guildId: '930000000000000013', name: 'Pixel Forge', iconUrl: null, tag: 'PXF', badgeUrl: null, memberCount: 15_300, holders: 1, fleetBlocks: 4, unlisted: false },
];

export function registerTagAutomodRoutes(): void {
  const base = `${G}/tag-automod`;
  route('GET', base, () => ({
    config: config(),
    configured: true,
    rules: rules(),
    maxRules: 50,
    ownTag: 'NOVA',
    ownBadgeUrl: null,
    jailConfigured: true,
    fleetMinReporters: 3,
    stats: { membersWithOtherTag: 9, events7d: eventsSeed().length, byStatus: { APPLIED: 3 } },
    waves: [],
  }));
  route('PATCH', base, ({ body }) => ({ config: demoDb.update('tag-automod/config', configSeed, (c) => ({ ...c, ...(body ?? {}) })) }));
  route('GET', `${base}/search`, ({ query }) => {
    const q = (query.get('q') ?? '').toLowerCase();
    return { servers: SERVERS.filter((s) => !q || s.name.toLowerCase().includes(q) || s.tag.toLowerCase().includes(q) || s.guildId === q) };
  });
  route('POST', `${base}/rules`, ({ body }) => {
    const created = rule(demoId(), { ...(body ?? {}), createdAt: new Date().toISOString() });
    demoDb.set('tag-automod/rules', [...rules(), created]);
    return { rule: created };
  });
  route('PATCH', `${base}/rules/:id`, ({ params, body }) => {
    let updated: unknown;
    demoDb.set('tag-automod/rules', rules().map((r) => (r.id === params.id ? (updated = { ...r, ...(body ?? {}), ...(body?.permanent ? { expiresAt: null } : {}) }) as typeof r : r)));
    return { rule: updated };
  });
  route('DELETE', `${base}/rules/:id`, ({ params }) => {
    demoDb.set('tag-automod/rules', rules().filter((r) => r.id !== params.id));
    return { success: true };
  });
  route('GET', `${base}/events`, ({ query }) => {
    const guild = query.get('tagGuildId');
    return { events: eventsSeed().filter((e) => !guild || e.tagGuildId === guild), hasMore: false };
  });
  route('POST', `${base}/scan`, () => {
    const holders = people().slice(14, 17);
    return {
      scanned: people().length,
      withTag: 9,
      total: people().length,
      matches: holders.map((p) => ({ userId: p.id, username: p.username, displayName: p.displayName, avatarUrl: avatarOf(p) ?? '', tag: 'DEVH', tagGuildId: '930000000000000011', action: 'ALERT', trigger: 'RESCAN', ruleName: 'Surveiller DevHub' })),
    };
  });
  route('POST', `${base}/rescan`, () => ({ started: true, count: people().length }));
}
