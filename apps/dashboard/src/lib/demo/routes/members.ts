/**
 * Routes de démo pour la gestion des membres et la fiche membre.
 */
import type { MemberCaseLogEntry, MemberCaseResponse, SanctionItem, SanctionReportItem } from '@kotbo/contracts';
import { route } from '../backend';
import { demoDb } from '../db';
import { MEMBERS, ROLES, VOICE_CHANNELS, ago, avatarOf, role, ME, HOUR, DAY, channelByName, personById, personByName, type DemoPerson } from '../fixtures';
import { DEMO_GUILD_ID } from '../mode';
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

function historyOf(person: DemoPerson): NonNullable<MemberCaseResponse['history']> {
  const list: NonNullable<MemberCaseResponse['history']> = [];
  if (person.username === 'arka') {
    list.push(
      { id: 'h-arka-1', field: 'username', oldValue: 'arka_old', newValue: 'arka', recordedAt: ago(45 * DAY) },
      { id: 'h-arka-2', field: 'displayName', oldValue: 'Arka Dev', newValue: 'Arka', recordedAt: ago(30 * DAY) },
      { id: 'h-arka-3', field: 'avatar', oldValue: 'https://cdn.discordapp.com/embed/avatars/0.png', newValue: 'https://cdn.discordapp.com/embed/avatars/1.png', recordedAt: ago(25 * DAY) },
      { id: 'h-arka-4', field: 'bio', oldValue: 'Dev passionné', newValue: 'Dev TypeScript & bot Discord', recordedAt: ago(20 * DAY) },
      { id: 'h-arka-5', field: 'tag', oldValue: 'DEV', newValue: 'KODA', recordedAt: ago(15 * DAY) },
      { id: 'h-arka-6', field: 'pronouns', oldValue: 'il', newValue: 'il/lui', recordedAt: ago(10 * DAY) },
    );
  } else if (person.username === 'lena') {
    list.push(
      { id: 'h-lena-1', field: 'displayName', oldValue: 'Helena', newValue: 'Lena', recordedAt: ago(60 * DAY) },
      { id: 'h-lena-2', field: 'avatar', oldValue: 'https://cdn.discordapp.com/embed/avatars/2.png', newValue: 'https://cdn.discordapp.com/embed/avatars/3.png', recordedAt: ago(35 * DAY) },
      { id: 'h-lena-3', field: 'pronouns', oldValue: 'she/her', newValue: 'elle', recordedAt: ago(20 * DAY) },
      { id: 'h-lena-4', field: 'bio', oldValue: null, newValue: 'Animatrice & modératrice', recordedAt: ago(12 * DAY) },
    );
  } else if (person.username === 'vantar') {
    list.push(
      { id: 'h-van-1', field: 'username', oldValue: 'shadow_vantar', newValue: 'vantar', recordedAt: ago(90 * DAY) },
      { id: 'h-van-2', field: 'displayName', oldValue: 'Shadow', newValue: 'Vantar', recordedAt: ago(50 * DAY) },
      { id: 'h-van-3', field: 'tag', oldValue: 'NONE', newValue: 'DEVH', recordedAt: ago(25 * DAY) },
      { id: 'h-van-4', field: 'avatar', oldValue: 'https://cdn.discordapp.com/embed/avatars/4.png', newValue: 'https://cdn.discordapp.com/embed/avatars/5.png', recordedAt: ago(10 * DAY) },
    );
  } else {
    list.push(
      { id: `h-${person.id}-1`, field: 'displayName', oldValue: `${person.displayName} [Ancien]`, newValue: person.displayName, recordedAt: ago(40 * DAY) },
    );
  }
  return list;
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

  // GET /api/dashboard/guilds/:id/members/identities?ids=
  // Un membre sur trois porte le tag du serveur de démo, comme dans les stats.
  route('GET', '/api/dashboard/guilds/:id/members/identities', ({ params, query }) => {
    const ids = new Set((query.get('ids') ?? '').split(','));
    const identities = Object.fromEntries(
      MEMBERS.flatMap((p, index) => (ids.has(p.id) ? [[p.id, {
        username: p.username,
        displayName: p.displayName,
        avatarUrl: null,
        serverTag: index % 3 === 0 ? { guildId: params.id, tag: 'NOVA', badgeUrl: null } : null,
      }]] : [])),
    );
    return { identities };
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
        breakdown: { WARN: suspected ? 2 : 0, KICK: 0, TIMEOUT: suspected ? 1 : 0, TEMP_BAN: 0, BAN: 0, SOFTBAN: 0, JAIL: 0 },
        recent: suspected
          ? [
            { type: 'WARN', status: 'ACTIVE', durationSeconds: null, reason: 'Spam de liens', createdAt: ago(12 * DAY), guildId: '930000000000000011', guildName: 'Le Repaire' },
            { type: 'TIMEOUT', status: 'RESOLVED', durationSeconds: 3600, reason: 'Pub en MP', createdAt: ago(30 * DAY), guildId: '930000000000000012', guildName: 'Pixel Café' },
          ]
          : [],
      },
      crossServerLinks: { enabled: true, serverCount: 0, suggestions: [] },
      serverTag: {
        guildId: '930000000000000011',
        tag: person.username === 'vantar' ? 'DEVH' : 'KODA',
        badge: null,
        badgeUrl: null,
        serverName: person.username === 'vantar' ? 'DevHub Community' : 'Koda',
        serverIconUrl: null,
        isOwnGuild: false,
        updatedAt: ago(6 * HOUR),
      },
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
      history: historyOf(person),
    };

    return response;
  });

  // GET /api/dashboard/guilds/:id/members/:userId/summary
  route('GET', '/api/dashboard/guilds/:id/members/:userId/summary', ({ params }) => {
    const person = MEMBERS.find((p) => p.id === params.userId) || MEMBERS[0];
    const sanctionCount = demoDb.get<SanctionItem[]>('sanctions', sanctionsSeed).filter((s) => s.targetUserId === person.id).length;
    return {
      summary: {
        level: { level: Math.max(1, Math.round(person.messages / 120)), xp: person.messages * 18, rank: 1 + (Number(person.id.slice(-2)) % 20) },
        reputation: { received: Math.round(person.messages / 90), given: Math.round(person.messages / 140) },
        economy: { balance: person.messages * 4, rank: 1 + (Number(person.id.slice(-2)) % 25) },
        invites: { total: 0, stillHere: 0, leftWithinWeek: 0 },
        support: { tickets: 0, openTickets: 0, averageRating: null, ratings: 0 },
        community: { suggestions: 0, forms: 0, giveawayWins: 0 },
        joins: 1,
        signals: sanctionCount > 0 ? [{ key: 'sanctions', label: `${sanctionCount} sanction(s)`, tone: 'warning', count: sanctionCount }] : [],
      },
      insights: null,
      climate: null,
    };
  });

  // GET /api/dashboard/guilds/:id/members/:userId/timeline
  route('GET', '/api/dashboard/guilds/:id/members/:userId/timeline', ({ params }) => {
    const person = MEMBERS.find((p) => p.id === params.userId) || MEMBERS[0];
    const logs = memberLogs(person, demoDb.get<SanctionItem[]>('sanctions', sanctionsSeed).filter((s) => s.targetUserId === person.id));
    const items = logs.map((l) => ({
      id: l.id,
      type: l.action,
      category: 'membership' as const,
      at: l.dateIso,
      title: l.action,
      description: l.details,
      actor: { id: null, name: l.user },
      link: null,
      tone: 'neutral' as const,
    }));
    return { items, nextBefore: null };
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

  // ── Membres fantômes (Ghost Members) ───────────────────────────────────
  const ghostConfigSeed = () => ({
    guildId: DEMO_GUILD_ID,
    enabled: true,
    inactiveDays: 60,
    spectatorWindowDays: 30,
    gracePeriodDays: 30,
    protectStaff: true,
    protectBoosters: true,
    protectedRoleIds: [] as string[],
    maxPruneBatch: 50,
    pruneReason: 'Nettoyage des membres inactifs',
    lastComputedAt: ago(3 * HOUR),
  });

  const ghostMembersList = () => {
    const staffIds = new Set(staffMembers().map((s) => s.userId));
    const humans = MEMBERS.filter((m) => !m.bot);
    return humans.map((m, i) => {
      const status = m.messages >= 400 ? 'ACTIVE' : m.messages >= 80 ? 'SPECTATOR' : m.joinedMinutesAgo < 14 * DAY ? 'NEW' : 'INACTIVE';
      const protections: string[] = [];
      if (staffIds.has(m.id)) protections.push('STAFF');
      if (i % 7 === 0) protections.push('BOOSTER');
      if (status === 'NEW') protections.push('GRACE_PERIOD');
      return {
        userId: m.id,
        username: m.username,
        displayName: m.displayName,
        avatarUrl: avatarOf(m),
        status,
        ghostScore: status === 'INACTIVE' ? 75 + (i % 20) : status === 'SPECTATOR' ? 40 + (i % 20) : 10 + (i % 15),
        joinedAt: ago(m.joinedMinutesAgo),
        lastMessageAt: status === 'INACTIVE' ? ago(70 * DAY) : ago((i % 10) * DAY),
        lastSilentActivityAt: ago((i % 15) * DAY),
        lastAnyActivityAt: status === 'INACTIVE' ? ago(65 * DAY) : ago((i % 8) * DAY),
        messageCount: m.messages,
        voiceTimeSeconds: m.voiceMinutes * 60,
        interactionCount: Math.max(0, Math.round(m.messages * 0.15)),
        protections,
        stillInGuild: true,
      };
    });
  };

  const ghostCounts = (rows: ReturnType<typeof ghostMembersList>) => {
    const counts = { ACTIVE: 0, SPECTATOR: 0, INACTIVE: 0, NEW: 0 };
    for (const r of rows) counts[r.status as keyof typeof counts] += 1;
    return counts;
  };

  route('GET', '/api/dashboard/guilds/:id/ghost-members', () => {
    const rows = ghostMembersList();
    const config = demoDb.get('ghost-config', ghostConfigSeed);
    return {
      distribution: { counts: ghostCounts(rows), total: rows.length, lastComputedAt: config.lastComputedAt },
      config,
    };
  });

  route('GET', '/api/dashboard/guilds/:id/ghost-members/members', ({ query }) => {
    const status = query.get('status') ?? '';
    const search = (query.get('search') ?? '').trim().toLowerCase();
    const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(query.get('pageSize') ?? '25', 10) || 25));
    const filtered = ghostMembersList().filter((m) => {
      if (status && m.status !== status) return false;
      if (search && !m.username.toLowerCase().includes(search) && !(m.displayName ?? '').toLowerCase().includes(search)) return false;
      return true;
    });
    return { members: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize };
  });

  route('PATCH', '/api/dashboard/guilds/:id/ghost-members/config', ({ body }) => {
    const config = demoDb.update('ghost-config', ghostConfigSeed, (cur) => ({ ...cur, ...(body ?? {}) }));
    return { config };
  });

  route('POST', '/api/dashboard/guilds/:id/ghost-members/recompute', () => {
    const rows = ghostMembersList();
    demoDb.update('ghost-config', ghostConfigSeed, (cur) => ({ ...cur, lastComputedAt: new Date().toISOString() }));
    return { counts: ghostCounts(rows) };
  });

  route('POST', '/api/dashboard/guilds/:id/ghost-members/prune/preview', ({ body }) => {
    const statuses: string[] = Array.isArray(body?.statuses) ? body.statuses : ['INACTIVE'];
    const config = demoDb.get('ghost-config', ghostConfigSeed);
    const all = ghostMembersList().filter((m) => statuses.includes(m.status));
    const candidates = all.filter((m) => m.protections.length === 0).slice(0, config.maxPruneBatch);
    return {
      candidates,
      protectedCount: all.filter((m) => m.protections.length > 0).length,
      analyzedCount: all.length,
      truncated: false,
      maxPruneBatch: config.maxPruneBatch,
      config,
    };
  });

  route('POST', '/api/dashboard/guilds/:id/ghost-members/prune', ({ body }) => {
    const count = Array.isArray(body?.userIds) ? body.userIds.length : 0;
    return { runId: `ghost-run-${Date.now()}`, status: 'COMPLETED', totalTargeted: count, successCount: count, failureCount: 0, failures: [] };
  });

  route('GET', '/api/dashboard/guilds/:id/ghost-members/runs', () => ({
    runs: [
      {
        id: 'ghost-run-1',
        executedByName: ME.displayName,
        status: 'COMPLETED',
        targetStatuses: ['INACTIVE'],
        totalTargeted: 4,
        successCount: 4,
        failureCount: 0,
        reason: 'Nettoyage trimestriel',
        startedAt: ago(18 * DAY),
        completedAt: ago(18 * DAY),
      },
    ],
  }));
}
