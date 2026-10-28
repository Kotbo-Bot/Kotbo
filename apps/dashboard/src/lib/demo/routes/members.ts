/**
 * Routes de démo pour la gestion des membres et la fiche membre.
 */
import type { MemberCaseLogEntry, MemberCaseResponse, SanctionItem, SanctionReportItem } from '@kotbo/contracts';
import { route } from '../backend';
import { demoDb } from '../db';
import { MEMBERS, ROLES, VOICE_CHANNELS, ago, role, ME, HOUR, DAY, channelByName, personById, personByName, type DemoPerson } from '../fixtures';
import { sanctionsSeed, auditSeed } from '../stories';
import { interactionEdges, messagesOf, type DemoMessage } from '../activity';
import { inviteOf } from './analytics';
import { staffMembers } from './home';

const ACCENTS = [0x5865f2, 0xeb459e, 0x23a55a, 0xf0b232, 0x22d3ee, null];

const PRONOUNS: Record<string, string> = { arka: 'il/lui', lena: 'elle', lina: 'elle', noe: 'il', maelle: 'elle', ines: 'elle', sacha: 'iel' };

const CONNECTIONS: Record<string, MemberCaseResponse['connections']> = {
  arka: [{ name: 'arka_live', type: 'twitch', visible: true }, { name: 'Arka', type: 'steam', visible: true }],
  lina: [{ name: 'lina.draws', type: 'instagram', visible: true }, { name: 'Lina', type: 'spotify', visible: true }],
  noe: [{ name: 'noe-dev', type: 'github', visible: true }],
  lena: [{ name: 'lena', type: 'youtube', visible: false }],
};

function groupByChannel(person: DemoPerson, own: DemoMessage[]) {
  const groups = new Map<string, DemoMessage[]>();
  for (const message of own) {
    const list = groups.get(message.channelId) ?? [];
    list.push(message);
    groups.set(message.channelId, list);
  }
  // Le corpus ne garde qu'un échantillon : les compteurs sont remis à l'échelle des totaux du membre.
  const scale = own.length > 0 ? person.messages / own.length : 0;
  return [...groups.values()]
    .map((list) => ({
      channelId: list[0].channelId,
      channelName: list[0].channelName,
      count: Math.max(list.length, Math.round(list.length * scale)),
      lastMessageAt: list[0].createdAt,
      recentMessages: list.slice(0, 12).map((m) => ({ id: m.id, channelId: m.channelId, channelName: m.channelName, content: m.content, dateIso: m.createdAt })),
    }))
    .sort((a, b) => b.count - a.count);
}

function memberLogs(person: DemoPerson, sanctions: SanctionItem[]): MemberCaseLogEntry[] {
  const log = (n: number, user: string, action: string, module: string, details: string, minutesAgo: number, channel?: string, source: 'discord' | 'dashboard' = 'discord'): MemberCaseLogEntry => ({
    id: `log-${person.id}-${n}`,
    user,
    action,
    context: 'Atelier Nova',
    module,
    eventType: source === 'dashboard' ? 'Manuel' : 'Automatique',
    source,
    details,
    dateIso: ago(minutesAgo),
    channelId: channel ? channelByName(channel).id : null,
  });
  const joined = person.joinedMinutesAgo;
  const list: MemberCaseLogEntry[] = [
    log(1, 'Kotbo', 'Arrivée', 'Accueil', `${person.displayName} a rejoint le serveur`, joined, 'bienvenue'),
    log(2, 'Kotbo', 'Rôle ajouté', 'Rôles automatiques', `Rôle Membre attribué à ${person.displayName}`, joined - 1),
  ];
  if (person.level >= 25) list.push(log(3, 'Kotbo', 'Rôle ajouté', 'Niveaux', `Rôle Habitué attribué : niveau 25 atteint`, Math.round(joined / 3), 'niveaux'));
  if (person.level >= 10) list.push(log(4, 'Kotbo', 'Niveau atteint', 'Niveaux', `${person.displayName} passe niveau ${person.level}`, 3 * DAY + (Number(person.id.slice(-2)) % 7) * HOUR, 'niveaux'));
  if (person.voiceMinutes > 0) list.push(log(5, 'Kotbo', 'Connexion vocale', 'Vocal', `${person.displayName} a rejoint Squad`, 26 * HOUR));
  if (person.messages > 1_000) list.push(log(6, 'Kotbo', 'Message modifié', 'Messages', 'Message modifié dans #général', 9 * HOUR, 'général'));
  if (person.username === 'vantar') {
    list.push(log(7, 'Kotbo', 'Message supprimé', 'Auto-Modération', 'Lien suspect supprimé : discord-nitro-gift.ru', 2 * HOUR + 2, 'général'));
    list.push(log(8, 'Kotbo', 'Pseudo modifié', 'Membres', 'Pseudo changé : Vantar → ᐯantar', 15 * DAY));
  }
  for (const s of sanctions) {
    list.push({
      id: `log-${person.id}-s${s.id}`,
      user: personById(s.moderatorUserId)?.displayName ?? s.moderatorTag,
      action: s.type === 'WARN' ? 'Avertissement' : s.type === 'TIMEOUT' ? 'Exclusion temporaire' : s.type === 'KICK' ? 'Expulsion' : 'Bannissement',
      context: 'Atelier Nova',
      module: 'Sanctions',
      eventType: 'Manuel',
      source: 'discord',
      details: s.reason,
      dateIso: s.createdAt,
      channelId: null,
    });
  }
  return list.sort((a, b) => b.dateIso.localeCompare(a.dateIso));
}

function candidaturesOf(person: DemoPerson): MemberCaseResponse['candidatures'] {
  const answers = (motivation: string) => ({
    answers: [
      { question: 'Pourquoi veux-tu rejoindre le staff ?', answer: motivation },
      { question: 'Combien d’heures par semaine peux-tu donner ?', answer: 'Une dizaine, surtout le soir et le week-end' },
      { question: 'As-tu déjà modéré un serveur ?', answer: 'Oui, un serveur Minecraft de 300 membres pendant un an' },
    ],
  });
  if (person.username === 'kylian') {
    return [{ id: 'cand-kylian', status: 'ACCEPTED', notes: 'Bon oral, à accompagner sur les tickets', createdAt: ago(50 * DAY), data: answers('J’aide déjà beaucoup en #général, je veux le faire officiellement'), autoRejected: false, autoRejectReason: null, rejectionReason: null, oralResult: 'PASSED', reapplyAfter: null }];
  }
  if (person.username === 'yanis' || person.username === 'ines') {
    return [{ id: `cand-${person.username}`, status: 'PENDING', notes: '', createdAt: ago(2 * DAY), data: answers('Le serveur m’a beaucoup apporté, j’aimerais rendre la pareille'), autoRejected: false, autoRejectReason: null, rejectionReason: null, oralResult: null, reapplyAfter: null }];
  }
  if (person.username === 'kyzo') {
    return [{ id: 'cand-kyzo', status: 'REJECTED', notes: '', createdAt: ago(25 * DAY), data: answers('Pour avoir les permissions'), autoRejected: true, autoRejectReason: 'Avertissement actif au moment de la candidature', rejectionReason: 'Sanction trop récente', oralResult: null, reapplyAfter: ago(-35 * DAY) }];
  }
  return [];
}

function reportsFor(sanctions: SanctionItem[]): SanctionReportItem[] {
  return sanctions
    .filter((s) => s.type !== 'WARN' || s.id.endsWith('501'))
    .map((s) => ({
      id: `report-${s.id}`,
      sanctionId: s.id,
      staffPseudo: s.moderatorTag,
      incidentAt: s.createdAt,
      memberPseudo: s.targetTag,
      memberReference: s.targetUserId,
      sanctionType: s.type,
      sanctionDurationLabel: s.durationSeconds ? `${Math.round(s.durationSeconds / 60)} min` : null,
      brokenRules: 'Article 2 : pas de spam ni de publicité',
      detailedReason: s.reason,
      evidenceLinks: ['https://discord.com/channels/900000000000000001/900000000000000313/910000000000999001'],
      additionalNotes: null,
      createdByUserId: s.moderatorUserId,
      createdByTag: s.moderatorTag,
      createdAt: s.createdAt,
    }));
}

function graphAround(userId: string): MemberCaseResponse['interactionGraph'] {
  const edges = interactionEdges().filter((e) => e.from === userId || e.to === userId);
  const ids = new Set<string>([userId]);
  for (const e of edges) {
    ids.add(e.from);
    ids.add(e.to);
  }
  return {
    nodes: [...ids].slice(0, 16).map((id) => ({ id, label: personById(id)?.displayName ?? id, type: id === userId ? 'target' : 'user', avatar: null })),
    edges: edges.filter((e) => ids.has(e.from) && ids.has(e.to)).slice(0, 30),
  };
}

export function registerMembersRoutes(): void {
  // GET /api/dashboard/guilds/:id/members/search
  route('GET', '/api/dashboard/guilds/:id/members/search', ({ query }) => {
    const q = (query.get('q') ?? '').trim().toLowerCase();
    const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.get('limit') ?? '24', 10) || 24));
    const roleId = query.get('roleId');
    const sort = query.get('sort') ?? 'lastSeenAt';

    let list = [...MEMBERS];
    if (q) {
      list = list.filter((m) => m.username.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q));
    }
    if (roleId) {
      list = list.filter((m) => m.roles.includes(roleId));
    }

    if (sort === 'messageCount') {
      list.sort((a, b) => b.messages - a.messages);
    } else if (sort === 'guildJoinedAt') {
      list.sort((a, b) => a.joinedMinutesAgo - b.joinedMinutesAgo);
    } else {
      list.sort((a, b) => (a.status === 'online' ? -1 : 1));
    }

    const totalFound = list.length;
    const totalPages = Math.max(1, Math.ceil(totalFound / limit));
    const offset = (page - 1) * limit;
    const paged = list.slice(offset, offset + limit);

    const members = paged.map((m) => ({
      id: m.id,
      username: m.username,
      displayName: m.displayName,
      avatarUrl: null,
      isBot: m.bot ?? false,
      lastSeenAt: ago(m.status === 'online' ? 2 : m.status === 'idle' ? 25 : 180),
      messageCount: m.messages,
      guildJoinedAt: ago(m.joinedMinutesAgo),
      guildLeftAt: null,
      isOnServer: true,
      presenceStatus: m.status,
    }));

    return {
      members,
      totalFound,
      totalPages,
      onServerCount: MEMBERS.length,
      leftCount: 0,
      botCount: 1,
    };
  });

  // GET /api/dashboard/guilds/:id/members/:userId
  route('GET', '/api/dashboard/guilds/:id/members/:userId', ({ params }) => {
    const userId = params.userId;
    const person = MEMBERS.find((p) => p.id === userId) || MEMBERS[0];
    const notes = demoDb.get<Record<string, string>>('member-notes', () => ({}));
    const note = notes[userId] ?? null;

    const allSanctions = demoDb.get<SanctionItem[]>('sanctions', sanctionsSeed);
    const memberSanctions = allSanctions.filter((s) => s.targetUserId === userId);

    const memberRoles = person.roles.map((rId) => {
      const r = ROLES.find((x) => x.id === rId);
      return r ? { id: r.id, name: r.name, mention: r.mention, permissions: r.permissions, position: r.position, color: r.color } : { id: rId, name: 'Membre', mention: `<@&${rId}>`, permissions: [] };
    });

    const staff = staffMembers().find((s) => s.userId === person.id);
    const own = messagesOf(person.id);
    const messagesByChannel = groupByChannel(person, own);
    const logs = memberLogs(person, memberSanctions);
    const suspected = person.username === 'vantar' || person.username === 'kyzo';
    const invite = inviteOf(person.id);
    const inviter = personByName(invite.inviter);
    const latest = own[0];

    const response: MemberCaseResponse = {
      profile: {
        id: `profile-${person.id}`,
        userId: person.id,
        userTag: person.username,
        username: person.username,
        globalName: person.displayName,
        displayName: person.displayName,
        avatarUrl: null,
        bannerUrl: null,
        accentColor: ACCENTS[Number(person.id.slice(-2)) % ACCENTS.length],
        locale: 'fr',
        isBot: person.bot ?? false,
        accountCreatedAt: ago(person.joinedMinutesAgo + (person.username === 'tom' ? 2 * DAY : 410 * DAY)),
        guildJoinedAt: ago(person.joinedMinutesAgo),
        guildLeftAt: null,
        firstSeenAt: ago(person.joinedMinutesAgo),
        lastSeenAt: ago(person.status === 'online' ? 2 : person.status === 'idle' ? 25 : 6 * HOUR),
        lastMessageAt: latest?.createdAt ?? null,
        lastMessageChannelId: latest?.channelId ?? null,
        messageCount: person.messages,
        voiceSessionCount: Math.round(person.voiceMinutes / 45),
        voiceTimeSeconds: person.voiceMinutes * 60,
        voiceLastChannelId: person.voiceMinutes > 0 ? VOICE_CHANNELS[0].id : null,
        voiceLastJoinedAt: person.voiceMinutes > 0 ? ago(26 * HOUR) : null,
        voiceLastLeftAt: person.voiceMinutes > 0 ? ago(24 * HOUR) : null,
        rolesSnapshot: person.roles,
        presenceStatus: person.status,
        pronouns: PRONOUNS[person.username] ?? null,
        isTutor: staff?.isTutor ?? false,
        staffGrade: staff?.grade ?? null,
        isSuspectedDC: suspected,
        moderatorNote: note,
        isOnServer: true,
      },
      invite: {
        code: invite.code,
        inviterId: inviter.id,
        inviterTag: inviter.username,
        inviterAvatarUrl: null,
        joinedAt: ago(person.joinedMinutesAgo),
      },
      createdInvites: [],
      roles: memberRoles,
      effectivePermissions: [...new Set(memberRoles.flatMap((r) => r.permissions ?? []).concat(['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'Connect', 'Speak']))],
      sanctions: memberSanctions,
      logs,
      messagesByChannel,
      recentMessageCount: messagesByChannel.reduce((sum, c) => sum + c.count, 0),
      recentLogCount: logs.length,
      connections: CONNECTIONS[person.username] ?? [],
      connectionsNote: '',
      candidatures: candidaturesOf(person),
      linkedAccounts: suspected
        ? [{ userId: personByName(person.username === 'vantar' ? 'Kyzo' : 'Vantar').id, userTag: person.username === 'vantar' ? 'kyzo' : 'vantar', avatarUrl: null, type: 'AUTOMATIC', status: 'PENDING' }]
        : [],
      isSuspectedDC: suspected,
      sanctionReports: reportsFor(memberSanctions),
      interactionGraph: graphAround(person.id),
      crossServerSanctions: {
        enabled: true,
        serverCount: suspected ? 2 : 0,
        total: suspected ? 3 : 0,
        breakdown: { WARN: suspected ? 2 : 0, KICK: 0, TIMEOUT: suspected ? 1 : 0, TEMP_BAN: 0, BAN: 0, SOFTBAN: 0 },
        recent: suspected
          ? [
              { type: 'WARN', status: 'ACTIVE', durationSeconds: null, reason: 'Spam de liens', createdAt: ago(12 * DAY), guildId: '930000000000000011', guildName: 'Le Repaire' },
              { type: 'TIMEOUT', status: 'RESOLVED', durationSeconds: 3600, reason: 'Pub en MP', createdAt: ago(30 * DAY), guildId: '930000000000000012', guildName: 'Pixel Café' },
            ]
          : [],
      },
      crossServerLinks: { enabled: true, serverCount: 0, suggestions: [] },
      verifications: person.username === 'tom'
        ? {
            entries: [{ id: 'verif-tom', status: 'PENDING', level: 'MEDIUM', requestedAt: ago(2 * HOUR), verifiedAt: null, expiresAt: ago(-22 * HOUR) }],
            total: 1,
            lastRequestedAt: ago(2 * HOUR),
            lastVerifiedAt: null,
            hasPending: true,
            cooldownUntil: null,
          }
        : { entries: [], total: 0, lastRequestedAt: null, lastVerifiedAt: null, hasPending: false, cooldownUntil: null },
    };

    return response;
  });

  // POST /api/dashboard/guilds/:id/members/:userId/actions
  route('POST', '/api/dashboard/guilds/:id/members/:userId/actions', ({ params, body }) => {
    const userId = params.userId;
    const person = MEMBERS.find((p) => p.id === userId) || MEMBERS[0];
    const actionType = body?.type as SanctionItem['type'] ?? 'WARN';
    const reason = body?.reason || 'Sanction appliquée via la fiche membre';

    const newSanction: SanctionItem = {
      id: `sanction-${Date.now()}`,
      type: actionType,
      status: 'ACTIVE',
      targetUserId: person.id,
      targetTag: person.username,
      moderatorUserId: ME.id,
      moderatorTag: ME.username,
      reason,
      durationSeconds: body?.durationMs ? Math.round(body.durationMs / 1000) : null,
      expiresAt: body?.durationMs ? new Date(Date.now() + body.durationMs).toISOString() : null,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      resolutionNote: null,
      archivedAt: null,
      archiveReason: null,
      appealable: true,
      appealLockReason: null,
    };

    demoDb.update('sanctions', sanctionsSeed, (current) => [newSanction, ...current]);
    demoDb.update('audit-trail', auditSeed, (current) => [
      {
        id: `audit-${Date.now()}`,
        user: ME.displayName,
        action: actionType === 'WARN' ? 'Avertissement' : actionType === 'TIMEOUT' ? 'Exclusion temporaire' : actionType === 'KICK' ? 'Expulsion' : 'Bannissement',
        context: 'Atelier Nova',
        module: 'Sanctions',
        eventType: 'Manuel',
        source: 'dashboard' as const,
        details: `${person.displayName} : ${reason}`,
        dateIso: new Date().toISOString(),
        channelId: null,
      },
      ...current,
    ]);

    return { success: true, sanction: newSanction };
  });

  // PATCH /api/dashboard/guilds/:id/members/:userId/note
  route('PATCH', '/api/dashboard/guilds/:id/members/:userId/note', ({ params, body }) => {
    const userId = params.userId;
    const note = body?.note ?? '';
    demoDb.update<Record<string, string>>('member-notes', () => ({}), (notes) => ({ ...notes, [userId]: note }));
    return { success: true, note };
  });

  // GET /api/dashboard/guilds/:id/linked-accounts
  route('GET', '/api/dashboard/guilds/:id/linked-accounts', () => {
    const vantar = personByName('Vantar');
    const kyzo = personByName('Kyzo');
    return {
      links: [
        { id: 'link-1', userId: vantar.id, userTag: vantar.username, linkedUserId: kyzo.id, linkedUserTag: kyzo.username, type: 'AUTOMATIC', status: 'PENDING', score: 78, reason: 'Même appareil, connexions à 4 minutes d’écart', createdAt: ago(3 * DAY) },
      ],
      suggestions: [],
    };
  });
}
