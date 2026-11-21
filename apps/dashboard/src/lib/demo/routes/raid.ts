/**
 * Anti-raid et vue d'ensemble Sécurité : configuration, audit du serveur,
 * signalements, demandes d'invitation, quarantaine, Kotbo Vision, anti-spam,
 * filtres de fichiers. Formes de `routes/dashboard/raidProtection.ts`.
 */
import { route } from '../backend';
import { demoDb, demoId } from '../db';
import { row } from '../model';
import { G } from '../crud';
import { CATEGORIES, CHANNELS, DAY, MEMBERS, PEOPLE, ROLES, ago, channelByName, personByName, role } from '../fixtures';

const KEY = 'raid/config';

const configSeed = () =>
  row('RaidProtectionConfig', {
    antiRaidEnabled: true,
    captchaEnabled: true,
    accountAgeGuardEnabled: true,
    reportsEnabled: true,
    scamFilterEnabled: true,
    scamImageFilterEnabled: true,
    scamQrFilterEnabled: true,
    inviteGuardEnabled: true,
    inviteValidationEnabled: true,
    rolePersistEnabled: true,
    visionEnabled: true,
    tagRoleEnabled: true,
  });

const config = () => demoDb.get(KEY, configSeed);
const patchConfig = (patch: Record<string, unknown>) => demoDb.update(KEY, configSeed, (c) => ({ ...c, ...patch, updatedAt: new Date().toISOString() }));

const crowd = () => MEMBERS.filter((m) => !m.bot).slice(16);

const reportsSeed = () => {
  const [a, b, c] = crowd();
  return [
    row('MemberReport', { id: 'rep-1', reporterId: personByName('Lina').id, targetId: a.id, reason: 'M’envoie des liens Nitro gratuits en MP', channelId: null, status: 'PENDING', createdAt: ago(40) }),
    row('MemberReport', { id: 'rep-2', reporterId: personByName('Noé').id, targetId: b.id, reason: 'Insultes en vocal', channelId: channelByName('général').id, messageContent: 't’es nul, quitte le serveur', status: 'PENDING', createdAt: ago(5 * 60) }),
    row('MemberReport', { id: 'rep-3', reporterId: personByName('Inès').id, targetId: c.id, reason: 'Spam de pub', status: 'RESOLVED', handledById: personByName('Zenox').id, handledAt: ago(2 * DAY), createdAt: ago(2 * DAY + 60) }),
  ];
};

const invitesSeed = () => [
  row('InviteApprovalRequest', { id: 'inv-req-1', creatorId: personByName('Yanis').id, channelId: channelByName('général').id, maxUses: 5, maxAgeSec: 86_400, status: 'PENDING', createdAt: ago(25) }),
  row('InviteApprovalRequest', { id: 'inv-req-2', creatorId: personByName('Maëlle').id, channelId: channelByName('bienvenue').id, maxUses: 1, maxAgeSec: 3_600, status: 'APPROVED', handledById: personByName('Lena').id, handledAt: ago(DAY), approvedInviteCode: 'nova-maelle', createdAt: ago(DAY + 30) }),
];

const visionSeed = () => ({
  lists: [
    { id: 'vl-1', name: 'Arnaques Nitro / Steam', enabled: true, reviewChannelId: channelByName('logs').id, sanction: 'TIMEOUT', durationMin: 1_440, imageCount: 48, createdAt: ago(60 * DAY) },
    { id: 'vl-2', name: 'Images interdites du serveur', enabled: true, reviewChannelId: channelByName('staff').id, sanction: 'DELETE', durationMin: null, imageCount: 7, createdAt: ago(20 * DAY) },
  ],
  reviews: [
    { id: 'vr-1', listId: 'vl-1', score: 0.91, authorId: crowd()[3].id, channelId: channelByName('général').id, thumb: null, createdAt: ago(18) },
    { id: 'vr-2', listId: 'vl-2', score: 0.78, authorId: crowd()[4].id, channelId: channelByName('recherche-de-groupe').id, thumb: null, createdAt: ago(3 * 60) },
  ],
  guildCatalogCount: 55,
  globalCatalogCount: 4_812,
  blockedTotal: 312,
  maxLists: 10,
});

const fileRulesSeed = () => [
  { id: 'fr-1', guildId: '', targetId: channelByName('général').id, targetType: 'CHANNEL', mode: 'BLACKLIST', groups: ['executables', 'archives'], extensions: ['.scr'], createdAt: ago(30 * DAY) },
  { id: 'fr-2', guildId: '', targetId: CATEGORIES[2].id, targetType: 'CATEGORY', mode: 'WHITELIST', groups: ['images'], extensions: [], createdAt: ago(10 * DAY) },
];

function auditReport() {
  const finding = (id: string, category: string, severity: string, title: string, detail: string, weight: number, extra: Record<string, unknown> = {}) => ({ id, category, severity, title, detail, weight, ...extra });
  const findings = [
    finding('everyone-mention', 'PERMISSIONS', 'CRITICAL', '@everyone peut mentionner tout le monde', 'Le rôle @everyone a la permission « Mentionner @everyone » dans 2 salons.', 12, {
      recommendation: 'Retire cette permission à @everyone : un compte compromis pourrait pinger tout le serveur.',
      entities: [{ id: channelByName('général').id, name: 'général', type: 'channel' }, { id: channelByName('recherche-de-groupe').id, name: 'recherche-de-groupe', type: 'channel' }],
      fix: { action: 'strip_everyone_permissions', label: 'Retirer la permission', risky: false },
    }),
    finding('verification-level', 'DISCORD', 'WARNING', 'Niveau de vérification bas', 'Les nouveaux comptes peuvent écrire sans e-mail vérifié.', 6, {
      recommendation: 'Passe le niveau de vérification sur « Moyen ».',
      fix: { action: 'discord_setting', label: 'Passer sur Moyen', payload: { verificationLevel: 2 } },
    }),
    finding('dormant-admin', 'PERMISSIONS', 'WARNING', '1 administrateur inactif depuis 90 jours', 'Un compte administrateur dormant est une cible de choix pour un vol de compte.', 5, {
      entities: [{ id: crowd()[0].id, name: crowd()[0].username, type: 'member', detail: 'Dernière activité il y a 112 jours' }],
    }),
    finding('bot-admin', 'BOTS', 'WARNING', 'Un bot tiers a la permission Administrateur', 'Un bot administrateur peut tout faire si son jeton fuite.', 5, { entities: [{ id: '900000000000000801', name: 'MusicBot', type: 'bot' }] }),
    finding('widget', 'HYGIENE', 'INFO', 'Widget du serveur activé', 'Le widget public expose la liste des membres en ligne.', 1, { fix: { action: 'disable_widget', label: 'Désactiver le widget' } }),
    finding('raid-module', 'MODULES', 'OK', 'Anti-raid actif', 'Détection de raid, captcha et verrous d’urgence sont en place.', 0),
    finding('automod-module', 'MODULES', 'OK', 'Filtres actifs', 'Anti-spam, liens et majuscules surveillés.', 0),
    finding('bot-perms', 'BOT_PERMS', 'OK', 'Kotbo a les permissions nécessaires', 'Rien ne manque pour sanctionner et verrouiller.', 0),
    finding('webhooks', 'WEBHOOKS', 'OK', '3 webhooks, tous connus', 'Aucun webhook créé par un compte disparu.', 0),
    finding('invites', 'INVITES', 'INFO', '4 invitations permanentes', 'Une invitation sans expiration circule longtemps.', 1, { link: { href: '/invitations', label: 'Voir les invitations' } }),
  ];
  const labels: Record<string, [string, number]> = {
    DISCORD: ['Configuration Discord', 45], PERMISSIONS: ['Permissions & rôles', 60], BOTS: ['Bots & intégrations', 30], WEBHOOKS: ['Webhooks', 20],
    INVITES: ['Invitations', 15], MODULES: ['Modules Kotbo', 40], BOT_PERMS: ['Permissions du bot', 20], HYGIENE: ['Hygiène du serveur', 15],
  };
  const categories = Object.entries(labels).map(([category, [label, max]]) => {
    const own = findings.filter((f) => f.category === category);
    const lost = own.reduce((sum, f) => sum + f.weight, 0);
    const count = (s: string) => own.filter((f) => f.severity === s).length;
    return { category, label, score: Math.round(((max - lost) / max) * 100), lost, max, counts: { critical: count('CRITICAL'), warning: count('WARNING'), info: count('INFO'), ok: count('OK') } };
  });
  return {
    score: 78,
    grade: 'B',
    categories,
    findings,
    degraded: [],
    stats: { memberCount: MEMBERS.length, roleCount: ROLES.length, channelCount: CHANNELS.length + 2, botCount: 3, webhookCount: 3, inviteCount: 9, adminMemberCount: 3, nativeAutoModRules: 2 },
    generatedAt: new Date().toISOString(),
    durationMs: 842,
  };
}

const jailSeed = () => [
  { userId: crowd()[5].id, source: 'TAG_AUTOMOD', reason: 'Tag imitant celui du serveur', releaseAt: ago(-2 * 60), createdAt: ago(60) },
  { userId: crowd()[6].id, source: 'MANUAL', reason: 'Raid de pub en MP, en attente de vérification', releaseAt: null, createdAt: ago(DAY) },
];

export function registerRaidRoutes(): void {
  const base = `${G}/raid-protection`;
  route('GET', base, () => {
    const reports = demoDb.get('raid/reports', reportsSeed);
    const invites = demoDb.get('raid/invites', invitesSeed);
    return {
      config: config(),
      reportStats: {
        pending: reports.filter((r) => r.status === 'PENDING').length,
        resolved: reports.filter((r) => r.status === 'RESOLVED').length,
        dismissed: reports.filter((r) => r.status === 'DISMISSED').length,
      },
      pendingInvites: invites.filter((r) => r.status === 'PENDING').length,
      scamImageCount: 4_867,
    };
  });
  route('PATCH', base, ({ body }) => ({ config: patchConfig(body ?? {}) }));
  route('POST', `${base}/raidmode`, ({ body }) => ({ config: patchConfig({ raidModeActive: body?.active ?? body?.enabled ?? !config().raidModeActive }) }));
  route('POST', `${base}/joinlock`, ({ body }) => ({ config: patchConfig({ joinLockEnabled: body?.enabled ?? !config().joinLockEnabled }) }));
  route('POST', `${base}/dmlock`, ({ body }) => ({ config: patchConfig({ dmLockEnabled: body?.enabled ?? !config().dmLockEnabled }) }));
  route('POST', `${base}/invite-emergency`, ({ body }) => ({ config: patchConfig({ inviteEmergencyEnabled: body?.enabled ?? !config().inviteEmergencyEnabled }), deleted: body?.enabled === false ? 0 : 4 }));
  route('POST', `${base}/other-servers`, () => ({ config: config() }));
  route('POST', `${base}/shield`, ({ body }) => ({ previous: 2, level: Number(body?.level ?? 3), warnings: [], config: config() }));

  route('GET', `${base}/reports`, ({ query }) => {
    const status = query.get('status');
    return { reports: demoDb.get('raid/reports', reportsSeed).filter((r) => !status || r.status === status) };
  });
  route('POST', `${base}/reports/:id/decision`, ({ params, body }) => {
    let report: unknown;
    demoDb.update('raid/reports', reportsSeed, (list) => list.map((r) => (r.id === params.id ? (report = { ...r, status: body?.decision === 'DISMISS' || body?.status === 'DISMISSED' ? 'DISMISSED' : 'RESOLVED', handledAt: new Date().toISOString() }) as typeof r : r)));
    return { report };
  });
  route('GET', `${base}/invite-requests`, () => ({ requests: demoDb.get('raid/invites', invitesSeed) }));
  route('POST', `${base}/invite-requests/:id/decision`, ({ params, body }) => {
    let request: unknown;
    const approve = body?.approve !== false && body?.decision !== 'DENY';
    demoDb.update('raid/invites', invitesSeed, (list) => list.map((r) => (r.id === params.id ? (request = { ...r, status: approve ? 'APPROVED' : 'DENIED', approvedInviteCode: approve ? 'nova-demo' : null, handledAt: new Date().toISOString() }) as typeof r : r)));
    return { request };
  });

  route('GET', `${base}/jail/members`, () => ({ jails: jailSeed() }));
  route('POST', `${base}/jail/provision`, () => ({ roleId: role('Membre').id, channelId: channelByName('staff').id, channelsUpdated: 14 }));

  route('GET', `${base}/audit`, () => ({ report: auditReport() }));
  route('POST', `${base}/audit/fix`, () => ({ success: true, message: 'Correctif appliqué.', report: auditReport() }));
  route('POST', `${base}/audit/fix-all`, () => ({ success: true, applied: 3, failed: 0, report: { ...auditReport(), score: 92, grade: 'A' } }));
  route('GET', `${base}/lineage/:userId`, ({ params }) => ({ report: { userId: params.userId, invitedBy: PEOPLE[1].id, invited: [], depth: 1 } }));
  route('POST', `${base}/lineage/:userId/quarantine`, () => ({ result: { quarantined: 1, skipped: 0 } }));

  // Kotbo Vision : listes d'images, catalogue et images à revoir.
  const vision = () => demoDb.get('raid/vision', visionSeed);
  route('GET', `${base}/vision`, () => vision());
  route('POST', `${base}/vision/lists`, ({ body }) => {
    const list = { id: demoId(), name: body?.name ?? 'Nouvelle liste', enabled: true, reviewChannelId: body?.reviewChannelId ?? null, sanction: body?.sanction ?? 'DELETE', durationMin: body?.durationMin ?? null, imageCount: 0, createdAt: new Date().toISOString() };
    demoDb.update('raid/vision', visionSeed, (v) => ({ ...v, lists: [...v.lists, list] }));
    return { list };
  });
  route('PATCH', `${base}/vision/lists/:id`, ({ params, body }) => {
    let list: unknown;
    demoDb.update('raid/vision', visionSeed, (v) => ({ ...v, lists: v.lists.map((l) => (l.id === params.id ? (list = { ...l, ...(body ?? {}) }) as typeof l : l)) }));
    return { list };
  });
  route('DELETE', `${base}/vision/lists/:id`, ({ params }) => {
    demoDb.update('raid/vision', visionSeed, (v) => ({ ...v, lists: v.lists.filter((l) => l.id !== params.id) }));
    return { success: true };
  });
  route('GET', `${base}/vision/images`, () => ({
    images: Array.from({ length: 6 }, (_, i) => ({ id: `vi-${i}`, filename: `arnaque-${i + 1}.png`, thumb: null, source: i < 4 ? 'MANUAL' : 'REVIEW', status: i === 5 ? 'ALLOWED' : 'BLOCKED', hits: 12 - i * 2, lastSeenAt: ago(i * 300), parentId: null, createdAt: ago((i + 3) * DAY) })),
  }));
  route('POST', `${base}/vision/images`, () => ({ added: 1, variants: 3, duplicates: 0, refused: 0 }));
  route('PATCH', `${base}/vision/images/:id`, () => ({ success: true }));
  route('DELETE', `${base}/vision/images/:id`, () => ({ success: true }));
  route('POST', `${base}/vision/reviews/:id`, ({ params, body }) => {
    demoDb.update('raid/vision', visionSeed, (v) => ({ ...v, reviews: v.reviews.filter((r) => r.id !== params.id) }));
    return { ok: true, status: body?.decision ?? 'BLOCKED', sanction: body?.decision === 'ALLOW' ? undefined : 'TIMEOUT' };
  });

  // Anti-spam appris : configuration et échantillons à valider.
  const spamSeed = () => ({ enabled: true, sensitivity: 'NORMAL', learnFromStaff: true, action: 'DELETE', notifyChannelId: channelByName('logs').id });
  route('GET', `${base}/spam`, () => ({
    config: demoDb.get('raid/spam', spamSeed),
    stats: { samples: 214, confirmed: 168, rejected: 21, precision: 0.89, days: 14 },
  }));
  route('PATCH', `${base}/spam`, ({ body }) => ({ config: demoDb.update('raid/spam', spamSeed, (c) => ({ ...c, ...(body ?? {}) })) }));
  route('GET', `${base}/spam/samples`, () => ({
    samples: crowd().slice(7, 11).map((p, i) => ({ id: `spam-${i}`, userId: p.id, channelId: channelByName('général').id, content: ['🎁 Free Nitro : discord-gift.ru/xyz', 'Rejoins mon serveur, 500 € à gagner !!!', 'cliquez ici bit.ly/abc pour des robux', 'Promo -90 % sur les skins, MP moi'][i], score: 0.95 - i * 0.08, status: 'PENDING', createdAt: ago(20 + i * 45) })),
  }));
  route('POST', `${base}/spam/samples/:id/decision`, () => ({ success: true }));

  // Filtres de fichiers par salon ou catégorie.
  const rules = () => demoDb.get('raid/file-rules', fileRulesSeed);
  route('GET', `${base}/file-rules`, () => ({
    rules: rules(),
    groups: { images: ['.png', '.jpg', '.gif', '.webp'], videos: ['.mp4', '.mov', '.webm'], archives: ['.zip', '.rar', '.7z'], executables: ['.exe', '.bat', '.msi', '.scr'], documents: ['.pdf', '.docx', '.txt'] },
    maxRules: 25,
  }));
  route('POST', `${base}/file-rules`, ({ body }) => {
    const rule = { id: demoId(), guildId: '', targetId: body?.targetId, targetType: body?.targetType ?? 'CHANNEL', mode: body?.mode ?? 'BLACKLIST', groups: body?.groups ?? [], extensions: body?.extensions ?? [], createdAt: new Date().toISOString() };
    demoDb.set('raid/file-rules', [...rules(), rule]);
    return { rule };
  });
  route('DELETE', `${base}/file-rules/:id`, ({ params }) => {
    demoDb.set('raid/file-rules', rules().filter((r) => r.id !== params.id));
    return { success: true };
  });
}
