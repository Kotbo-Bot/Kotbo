/**
 * Routes de démo pour le système de tickets.
 */
import { route } from '../backend';
import { demoDb } from '../db';
import { ago, HOUR, DAY, MEMBERS, ME, role } from '../fixtures';

function ticketsSeed() {
  const lina = MEMBERS.find((m) => m.username === 'lina') || MEMBERS[6];
  const yanis = MEMBERS.find((m) => m.username === 'yanis') || MEMBERS[9];
  const tom = MEMBERS.find((m) => m.username === 'tom') || MEMBERS[13];

  return [
    {
      id: 'ticket-148',
      guildId: '900000000000000001',
      channelId: '900000000000000317',
      channelName: 'ticket-0148-yanis',
      userId: yanis.id,
      userTag: yanis.username,
      userName: yanis.displayName,
      userAvatar: null,
      status: 'OPEN',
      claimedById: null,
      claimedBy: null,
      claimedByAvatar: null,
      subject: 'Signalement de spam en MP',
      createdAt: ago(45),
      closedAt: null,
      type: 'report',
      priority: 'HIGH',
      messages: [
        {
          id: 'msg-t-148-1',
          authorId: yanis.id,
          authorName: yanis.displayName,
          authorAvatar: null,
          isStaff: false,
          content: "Bonjour le staff, je viens de recevoir un MP suspect d'un compte se faisant passer pour un bot Discord et proposant du nitro gratuit.",
          htmlContent: "Bonjour le staff, je viens de recevoir un MP suspect d'un compte se faisant passer pour un bot Discord et proposant du nitro gratuit.",
          createdAt: ago(45),
        },
      ],
    },
    {
      id: 'ticket-147',
      guildId: '900000000000000001',
      channelId: '900000000000000317',
      channelName: 'ticket-0147-lina',
      userId: lina.id,
      userTag: lina.username,
      userName: lina.displayName,
      userAvatar: null,
      status: 'OPEN',
      claimedById: '900000000000000402',
      claimedBy: 'Lena',
      claimedByAvatar: null,
      subject: 'Question sur les rôles de niveau',
      createdAt: ago(6 * HOUR),
      closedAt: null,
      type: 'question',
      priority: 'NORMAL',
      messages: [
        {
          id: 'msg-t-147-1',
          authorId: lina.id,
          authorName: lina.displayName,
          authorAvatar: null,
          isStaff: false,
          content: 'Bonjour ! Je voulais savoir si le rôle Habitué donne accès à des salons privés ?',
          htmlContent: 'Bonjour ! Je voulais savoir si le rôle Habitué donne accès à des salons privés ?',
          createdAt: ago(6 * HOUR),
        },
        {
          id: 'msg-t-147-2',
          authorId: '900000000000000402',
          authorName: 'Lena',
          authorAvatar: null,
          isStaff: true,
          content: 'Hello Lina ! Oui, le rôle Habitué débloque le salon #salon-privé et permet de participer aux tirages au sort mensuels.',
          htmlContent: 'Hello Lina ! Oui, le rôle Habitué débloque le salon #salon-privé et permet de participer aux tirages au sort mensuels.',
          createdAt: ago(5 * HOUR),
        },
        {
          id: 'msg-t-147-3',
          authorId: lina.id,
          authorName: lina.displayName,
          authorAvatar: null,
          isStaff: false,
          content: 'Super, merci beaucoup pour la réponse rapide !',
          htmlContent: 'Super, merci beaucoup pour la réponse rapide !',
          createdAt: ago(4 * HOUR),
        },
      ],
    },
    {
      id: 'ticket-142',
      guildId: '900000000000000001',
      channelId: '900000000000000317',
      channelName: 'ticket-0142-tom',
      userId: tom.id,
      userTag: tom.username,
      userName: tom.displayName,
      userAvatar: null,
      status: 'CLOSED',
      claimedById: '900000000000000403',
      claimedBy: 'Zenox',
      claimedByAvatar: null,
      subject: 'Problème de rôle après validation du règlement',
      createdAt: ago(2 * DAY),
      closedAt: ago(2 * DAY - 20),
      type: 'support',
      priority: 'LOW',
      messages: [
        {
          id: 'msg-t-142-1',
          authorId: tom.id,
          authorName: tom.displayName,
          authorAvatar: null,
          isStaff: false,
          content: "Bonjour, j'ai cliqué sur la réaction du règlement mais je n'ai pas eu le rôle Membre.",
          htmlContent: "Bonjour, j'ai cliqué sur la réaction du règlement mais je n'ai pas eu le rôle Membre.",
          createdAt: ago(2 * DAY),
        },
        {
          id: 'msg-t-142-2',
          authorId: '900000000000000403',
          authorName: 'Zenox',
          authorAvatar: null,
          isStaff: true,
          content: "C'est corrigé ! Il y avait un petit délai de synchro. Bon séjour parmi nous !",
          htmlContent: "C'est corrigé ! Il y avait un petit délai de synchro. Bon séjour parmi nous !",
          createdAt: ago(2 * DAY - 20),
        },
      ],
    },
  ];
}

export function registerTicketsRoutes(): void {
  // GET /api/dashboard/guilds/:id/tickets
  route('GET', '/api/dashboard/guilds/:id/tickets', () => {
    const list = demoDb.get('tickets-list', ticketsSeed);
    const config = demoDb.get('tickets-config', () => ({
      ticketCategoryId: '900000000000000302',
      ticketStaffRoleId: role('Modérateur').id,
      ticketEmbedTitle: "Centre d'Assistance",
      ticketEmbedDesc: 'Clique sur un bouton ci-dessous pour ouvrir un ticket privé avec le staff.',
      ticketTypes: [
        { id: 'support', label: 'Support & Questions', emoji: '❓' },
        { id: 'report', label: 'Signalement', emoji: '🛡️' },
      ],
    }));

    return {
      tickets: list,
      config,
      pagination: {
        limit: 50,
        offset: 0,
        hasMore: false,
        nextOffset: null,
      },
    };
  });

  // GET /api/dashboard/guilds/:id/tickets/config
  route('GET', '/api/dashboard/guilds/:id/tickets/config', () => {
    return demoDb.get('tickets-config', () => ({
      ticketCategoryId: '900000000000000302',
      ticketStaffRoleId: role('Modérateur').id,
      ticketEmbedTitle: "Centre d'Assistance",
      ticketEmbedDesc: 'Clique sur un bouton ci-dessous pour ouvrir un ticket privé avec le staff.',
      ticketTypes: [
        { id: 'support', label: 'Support & Questions', emoji: '❓' },
        { id: 'report', label: 'Signalement', emoji: '🛡️' },
      ],
    }));
  });

  // PATCH /api/dashboard/guilds/:id/tickets/config
  route('PATCH', '/api/dashboard/guilds/:id/tickets/config', ({ body }) => {
    return demoDb.update('tickets-config', () => ({}), (current) => ({ ...current, ...body }));
  });

  // GET /api/dashboard/guilds/:id/tickets/:ticketId
  route('GET', '/api/dashboard/guilds/:id/tickets/:ticketId', ({ params }) => {
    const list = demoDb.get<any[]>('tickets-list', ticketsSeed);
    const ticket = list.find((t) => t.id === params.ticketId);
    if (!ticket) return new Response(JSON.stringify({ error: 'Ticket introuvable' }), { status: 404 });
    return {
      ticket,
      channelName: ticket.channelName,
      messages: ticket.messages || [],
    };
  });

  // POST /api/dashboard/guilds/:id/tickets/:ticketId/message
  route('POST', '/api/dashboard/guilds/:id/tickets/:ticketId/message', ({ params, body }) => {
    const content = body?.message || body?.content || '';
    const newMsg = {
      id: `msg-${Date.now()}`,
      authorId: ME.id,
      authorName: ME.displayName,
      authorAvatar: null,
      isStaff: true,
      content,
      htmlContent: content,
      createdAt: new Date().toISOString(),
    };

    demoDb.update<any[]>('tickets-list', ticketsSeed, (list) => {
      const t = list.find((x) => x.id === params.ticketId);
      if (t) {
        t.messages = [...(t.messages || []), newMsg];
      }
      return list;
    });

    return { success: true, message: newMsg };
  });

  // POST /api/dashboard/guilds/:id/tickets/:ticketId/claim
  route('POST', '/api/dashboard/guilds/:id/tickets/:ticketId/claim', ({ params }) => {
    demoDb.update<any[]>('tickets-list', ticketsSeed, (list) => {
      const t = list.find((x) => x.id === params.ticketId);
      if (t) {
        t.claimedById = ME.id;
        t.claimedBy = ME.displayName;
      }
      return list;
    });
    return { success: true };
  });

  // POST /api/dashboard/guilds/:id/tickets/:ticketId/close
  route('POST', '/api/dashboard/guilds/:id/tickets/:ticketId/close', ({ params }) => {
    demoDb.update<any[]>('tickets-list', ticketsSeed, (list) => {
      const t = list.find((x) => x.id === params.ticketId);
      if (t) {
        t.status = 'CLOSED';
        t.closedAt = new Date().toISOString();
      }
      return list;
    });
    return { success: true };
  });

  // POST /api/dashboard/guilds/:id/tickets/:ticketId/reopen
  route('POST', '/api/dashboard/guilds/:id/tickets/:ticketId/reopen', ({ params }) => {
    demoDb.update<any[]>('tickets-list', ticketsSeed, (list) => {
      const t = list.find((x) => x.id === params.ticketId);
      if (t) {
        t.status = 'OPEN';
        t.closedAt = null;
      }
      return list;
    });
    return { success: true };
  });

  // POST /api/dashboard/guilds/:id/tickets/:ticketId/rename
  route('POST', '/api/dashboard/guilds/:id/tickets/:ticketId/rename', ({ params, body }) => {
    const name = body?.name ?? '';
    demoDb.update<any[]>('tickets-list', ticketsSeed, (list) => {
      const t = list.find((x) => x.id === params.ticketId);
      if (t && name) {
        t.channelName = name;
      }
      return list;
    });
    return { success: true };
  });

  // GET /api/dashboard/guilds/:id/tickets/macros
  route('GET', '/api/dashboard/guilds/:id/tickets/macros', () => []);

  // GET|PUT /api/dashboard/guilds/:id/tickets/signature
  route('GET', '/api/dashboard/guilds/:id/tickets/signature', () => ({ content: '', sendAsMe: false }));
  route('PUT', '/api/dashboard/guilds/:id/tickets/signature', () => ({ content: '', sendAsMe: false }));

  // GET /api/dashboard/guilds/:id/tickets/transcripts
  route('GET', '/api/dashboard/guilds/:id/tickets/transcripts', () => []);

  // GET /api/dashboard/guilds/:id/satisfaction
  route('GET', '/api/dashboard/guilds/:id/satisfaction', () => {
    const staff = [MEMBERS[1], MEMBERS[2], ME].filter(Boolean);
    const counts: Array<[number, number]> = [[5, 18], [4, 11], [3, 4], [2, 1], [1, 1]];
    const averages = [4.6, 4.3, 4.1];
    return {
      global: {
        averageRating: 4.3,
        totalResponses: 35,
        distribution: counts.map(([rating, count]) => ({ rating, count })),
        recent: staff.map((user, i) => ({
          rating: 5 - i,
          comment: i === 0 ? 'Réponse rapide, merci !' : null,
          userId: user.id,
          user,
          staffId: staff[(i + 1) % staff.length].id,
          staff: staff[(i + 1) % staff.length],
          createdAt: ago((i + 1) * DAY),
        })),
      },
      byStaff: staff.map((user, i) => ({
        staffId: user.id,
        staff: user,
        averageRating: averages[i],
        totalResponses: 12 - i * 3,
        commentCount: 0,
        recentComments: [],
      })),
    };
  });

  // GET /api/dashboard/guilds/:id/satisfaction/staff/:staffId/reviews
  route('GET', '/api/dashboard/guilds/:id/satisfaction/staff/:staffId/reviews', () => ({
    reviews: [],
    total: 0,
    hasMore: false,
  }));

  // GET /api/dashboard/guilds/:id/staff-server/channels
  route('GET', '/api/dashboard/guilds/:id/staff-server/channels', () => ({
    staffGuildId: null,
    staffGuildName: null,
    channels: [],
    voiceChannels: [],
    categories: [],
  }));
}
